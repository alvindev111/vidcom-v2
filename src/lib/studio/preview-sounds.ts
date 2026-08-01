"use client";

import type { RevealSound, TransitionSound } from "./preview-settings";

/**
 * Slide sounds are synthesised in the browser rather than shipped as files, so
 * auditioning a transition costs nothing and the project stays asset-free. One
 * lazily created AudioContext: browsers only allow it after a user gesture, and
 * every caller here is a click.
 */
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  context ??= new AudioContext();
  void context.resume();
  return context;
}

function tone(
  type: OscillatorType,
  from: number,
  to: number,
  delay: number,
  attack: number,
  gainValue: number,
  duration: number,
  detuneVoices = 1,
) {
  const ctx = audio();
  if (!ctx) return;

  for (let voice = 0; voice < detuneVoices; voice += 1) {
    const at = ctx.currentTime + delay;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = type;
    oscillator.detune.value = voice * 7;
    oscillator.frequency.setValueAtTime(from, at);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(to, 1),
      at + duration,
    );

    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(gainValue / detuneVoices, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.05);
  }
}

function whoosh(from: number, to: number, duration: number, delay = 0) {
  const ctx = audio();
  if (!ctx) return;

  const at = ctx.currentTime + delay;
  const length = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(Math.max(to, 1), at + duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.12, at + duration * 0.3);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  source.start(at);
  source.stop(at + duration);
}

const TRANSITIONS: Record<TransitionSound, () => void> = {
  gong: () => {
    tone("sine", 110, 82, 0, 0.01, 0.14, 1.6);
    tone("sine", 220, 165, 0, 0.02, 0.07, 1.2);
  },
  rise: () => tone("sawtooth", 160, 720, 0, 0.2, 0.07, 0.7, 2),
  bass: () => tone("sine", 90, 45, 0, 0.02, 0.16, 0.9),
  chime: () => {
    tone("sine", 880, 1320, 0, 0.02, 0.07, 0.6);
    tone("sine", 1320, 1760, 0.1, 0.02, 0.05, 0.5);
  },
  sweep: () => whoosh(300, 3000, 0.6),
  boom: () => {
    tone("sine", 140, 40, 0, 0.01, 0.18, 1.1);
    whoosh(600, 120, 0.5);
  },
  alarm: () => {
    tone("square", 660, 660, 0, 0.01, 0.06, 0.18);
    tone("square", 880, 880, 0.22, 0.01, 0.06, 0.18);
  },
  chord: () => {
    tone("sine", 261, 261, 0, 0.05, 0.05, 0.9);
    tone("sine", 329, 329, 0, 0.05, 0.05, 0.9);
    tone("sine", 392, 392, 0, 0.05, 0.05, 0.9);
  },
  ascending: () => {
    tone("sine", 330, 440, 0, 0.06, 0.05, 0.4);
    tone("sine", 440, 554, 0.15, 0.05, 0.04, 0.4);
    tone("sine", 554, 660, 0.3, 0.04, 0.04, 0.4);
  },
  retro: () => {
    tone("square", 262, 131, 0, 0.03, 0.05, 0.15, 2);
    tone("square", 393, 262, 0.08, 0.03, 0.04, 0.15, 2);
    whoosh(2000, 500, 0.1);
  },
  minimal: () => tone("sine", 523, 784, 0, 0.04, 0.06, 0.3),
  dramatic: () => {
    tone("sine", 110, 55, 0, 0.1, 0.1, 1);
    whoosh(100, 400, 0.6);
    tone("sine", 220, 440, 0.3, 0.07, 0.07, 0.6);
  },
};

const REVEALS: Record<RevealSound, () => void> = {
  ping: () => tone("sine", 1000, 1400, 0, 0.006, 0.06, 0.18),
  pop: () => {
    tone("sine", 800, 1200, 0, 0.004, 0.06, 0.15);
    tone("sine", 1200, 600, 0, 0.004, 0.03, 0.12);
  },
  chime: () => {
    tone("sine", 1200, 1800, 0, 0.004, 0.05, 0.3);
    tone("sine", 1500, 2000, 0.06, 0.004, 0.03, 0.25);
  },
  click: () => tone("triangle", 2000, 800, 0, 0.002, 0.07, 0.06),
  bubble: () => {
    const base = 400 + Math.random() * 400;
    tone("sine", base, base * 2, 0, 0.004, 0.05, 0.2);
    tone("sine", base * 1.3, base * 2.5, 0.05, 0.004, 0.03, 0.15);
  },
  woosh: () => whoosh(800 + Math.random() * 400, 2400, 0.15),
  sparkle: () => {
    tone("sine", 1500, 2200, 0, 0.004, 0.04, 0.2);
    tone("sine", 2000, 2800, 0.04, 0.004, 0.03, 0.18);
    tone("sine", 2500, 1800, 0.08, 0.004, 0.02, 0.15);
  },
  drop: () => tone("sine", 1400, 400, 0, 0.004, 0.06, 0.2),
  tick: () => tone("triangle", 3000, 1500, 0, 0.002, 0.05, 0.05),
  bell: () => {
    tone("sine", 880, 1100, 0, 0.004, 0.05, 0.35);
    tone("sine", 1100, 880, 0.08, 0.004, 0.03, 0.3);
  },
  blip: () => tone("square", 600, 900, 0, 0.004, 0.03, 0.08, 3),
  snap: () => {
    tone("triangle", 4000, 500, 0, 0.002, 0.06, 0.04);
    whoosh(3000, 1000, 0.05);
  },
};

export function playTransitionSound(name: TransitionSound) {
  TRANSITIONS[name]?.();
}

export function playRevealSound(name: RevealSound) {
  REVEALS[name]?.();
}
