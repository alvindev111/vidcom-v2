import {
  BGM_ARP_PERIOD_SECONDS,
  BGM_CHORD_PERIOD_SECONDS,
  type BgmBed,
} from "@vidcom/contracts";

/**
 * Renders a bed from its recipe, offline and deterministically.
 *
 * The studio's preview player already plays these recipes through WebAudio; this
 * is the same signal path written for a file, so a bed sounds the same previewed
 * and rendered. No model, no download, no licence: the whole track is four chords
 * and a sparse top line, and the same recipe plus the same length always produces
 * the same bytes — a re-render is not a new roll of the dice.
 */

/** What the composition schedule mixes at, matching narration. */
const SAMPLE_RATE = 44_100;
/** Two oscillators per voice, the second detuned, is what keeps a pad from sounding like a test tone. */
const DETUNE_RATIO = 1.003;
/** Voices of one chord enter 0.15s apart so the chord arrives rather than switches on. */
const VOICE_STAGGER_SECONDS = 0.15;
const CHORD_TAIL_SECONDS = 8.5;
const ARP_TAIL_SECONDS = 3;
/** One echo at 375 ms reads as space; a delay line would read as an effect. */
const ARP_ECHO_SECONDS = 0.375;
const ARP_ECHO_GAIN = 0.25;
const FADE_IN_SECONDS = 4;
const FADE_OUT_SECONDS = 3;
/** Headroom only. The bed's real level against speech is the composition's volume. */
const PEAK_TARGET = 0.7;
const WAV_HEADER_BYTES = 44;

type EnvelopePoint = readonly [seconds: number, value: number, curve?: "exp"];

const CHORD_ENVELOPE: readonly EnvelopePoint[] = [[0, 0], [2, 0.18], [5, 0.18], [8, 0.001]];
const ARP_ENVELOPE: readonly EnvelopePoint[] = [[0, 0], [0.05, 0.12], [0.8, 0.03, "exp"], [2.5, 0.001]];

/** Triangle wave in closed form; the shape an OscillatorNode's `triangle` produces. */
function triangle(phase: number): number {
  const wrapped = phase - Math.floor(phase);
  return 4 * Math.abs(wrapped - 0.5) - 1;
}

/** Reads a WebAudio-style ramp envelope at one instant. */
function envelopeAt(points: readonly EnvelopePoint[], seconds: number): number {
  const first = points[0]!;
  if (seconds <= first[0]) return first[1];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    if (seconds > point[0]) continue;
    const previous = points[index - 1]!;
    const span = point[0] - previous[0];
    const ratio = span <= 0 ? 1 : (seconds - previous[0]) / span;
    if (point[2] === "exp" && previous[1] > 0 && point[1] > 0) {
      return previous[1] * Math.pow(point[1] / previous[1], ratio);
    }
    return previous[1] + (point[1] - previous[1]) * ratio;
  }
  return points[points.length - 1]![1];
}

/**
 * One-pole lowpass.
 *
 * The player uses a biquad at Q 0.5; the audible job here — keep the pad under a
 * voice and take the edge off the triangle — is the same at the same corner, and
 * a one-pole stays stable at the 55 Hz the `dark` bed reaches.
 */
function lowpass(samples: Float32Array, cutoffHz: number): void {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = 1 / SAMPLE_RATE / (rc + 1 / SAMPLE_RATE);
  let last = 0;
  for (let index = 0; index < samples.length; index += 1) {
    last += alpha * (samples[index]! - last);
    samples[index] = last;
  }
}

function addVoice(
  buffer: Float32Array,
  startSeconds: number,
  lengthSeconds: number,
  render: (seconds: number) => number,
  cutoffHz: number,
): void {
  const offset = Math.round(startSeconds * SAMPLE_RATE);
  if (offset >= buffer.length) return;
  const count = Math.min(Math.ceil(lengthSeconds * SAMPLE_RATE), buffer.length - offset);
  const voice = new Float32Array(count);
  for (let index = 0; index < count; index += 1) voice[index] = render(index / SAMPLE_RATE);
  lowpass(voice, cutoffHz);
  for (let index = 0; index < count; index += 1) buffer[offset + index]! += voice[index]!;
}

function encodeWav(samples: Float32Array, scale: number): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]! * scale));
    view.setInt16(WAV_HEADER_BYTES + index * 2, Math.round(clamped * 32_767), true);
  }
  return bytes;
}

/** Renders one bed as a 44.1 kHz mono WAV of exactly `seconds`. */
export function synthesizeBgmBed(bed: BgmBed, seconds: number): Uint8Array {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError("bed length must be positive");
  const total = Math.ceil(seconds * SAMPLE_RATE);
  const buffer = new Float32Array(total);
  const { chords, arps } = bed.recipe;

  for (let chordIndex = 0; chordIndex * BGM_CHORD_PERIOD_SECONDS < seconds; chordIndex += 1) {
    const chord = chords[chordIndex % chords.length]!;
    const chordStart = chordIndex * BGM_CHORD_PERIOD_SECONDS;
    chord.forEach((frequency, voiceIndex) => {
      addVoice(
        buffer,
        chordStart + voiceIndex * VOICE_STAGGER_SECONDS,
        CHORD_TAIL_SECONDS,
        (t) => {
          const gain = envelopeAt(CHORD_ENVELOPE, t);
          const sine = Math.sin(2 * Math.PI * frequency * t);
          const detuned = triangle(frequency * DETUNE_RATIO * t);
          return (sine + detuned) * gain;
        },
        350 + voiceIndex * 50,
      );
    });
  }

  let arpCursor = 0;
  for (let step = 0; step * BGM_ARP_PERIOD_SECONDS < seconds; step += 1) {
    const at = step * BGM_ARP_PERIOD_SECONDS;
    const notes = arps[Math.floor(at / BGM_CHORD_PERIOD_SECONDS) % arps.length]!;
    const frequency = notes[arpCursor % notes.length]!;
    arpCursor += 1;
    const voice = (t: number) => Math.sin(2 * Math.PI * frequency * t) * envelopeAt(ARP_ENVELOPE, t);
    addVoice(buffer, at, ARP_TAIL_SECONDS, voice, 2_000);
    addVoice(buffer, at + ARP_ECHO_SECONDS, ARP_TAIL_SECONDS, (t) => voice(t) * ARP_ECHO_GAIN, 2_000);
  }

  // The player fades its master gain in over 4s and never ends; a file has an
  // end, so it also fades out — a bed that stops mid-chord reads as a glitch.
  for (let index = 0; index < total; index += 1) {
    const t = index / SAMPLE_RATE;
    let gain = 1;
    if (t < FADE_IN_SECONDS) gain *= t / FADE_IN_SECONDS;
    const remaining = seconds - t;
    if (remaining < FADE_OUT_SECONDS) gain *= Math.max(0, remaining / FADE_OUT_SECONDS);
    buffer[index]! *= gain;
  }

  let peak = 0;
  for (let index = 0; index < total; index += 1) peak = Math.max(peak, Math.abs(buffer[index]!));
  return encodeWav(buffer, peak > 0 ? PEAK_TARGET / peak : 1);
}
