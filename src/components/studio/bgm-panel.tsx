"use client";

import * as React from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  DownloadIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ScaleIcon,
} from "lucide-react";

import {
  BGM_ARP_PERIOD_SECONDS,
  BGM_BEDS,
  BGM_CHORD_PERIOD_SECONDS,
  type BgmBed,
  type BgmLibraryEntry,
  type BgmLicense,
  type BgmSelectionMetadata,
} from "@vidcom/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl, fetchApi } from "@/lib/api/services";
import type { FileNode } from "@/lib/studio/types";

interface ShippedTrack {
  id: string;
  label: string;
  role: string;
  selection: BgmSelectionMetadata;
  durationSeconds: number;
  license: BgmLicense;
  available: boolean;
}

interface BgmSources {
  beds: Array<{ id: string; label: string; role: string; selection: BgmSelectionMetadata }>;
  tracks: ShippedTrack[];
  library: BgmLibraryEntry[];
  defaultVolume: number;
}

type Choice =
  | { kind: "bed"; id: string }
  | { kind: "track"; id: string }
  | { kind: "library"; id: string };

const AUDITION_SECONDS = 24;
/** Licence kinds a person can pick; `unknown` stays available because it is often the truth. */
const LICENSE_KINDS = [
  "unknown",
  "own-work",
  "public-domain",
  "cc0",
  "cc-by",
  "royalty-free",
  "licensed",
] as const;
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a"];
const EMPTY_LICENSE: BgmLicense = { kind: "unknown", holder: null, url: null, note: null };

function keyOf(choice: Choice): string {
  return `${choice.kind}:${choice.id}`;
}

function errorMessage(payload: unknown, status: number): string {
  const error = (payload as { error?: { message?: string } | string } | null)?.error;
  if (typeof error === "string") return error;
  return error?.message ?? `request failed (${status})`;
}

/** Audio files already in the project, which are the only importable sources. */
function audioAssets(nodes: readonly FileNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === "file") {
      const extension = node.path.slice(node.path.lastIndexOf(".") + 1).toLowerCase();
      if (AUDIO_EXTENSIONS.includes(extension)) into.push(node.path);
    }
    if (node.children) audioAssets(node.children, into);
  }
  return into;
}

/**
 * Plays a bed in the browser from its recipe.
 *
 * The bytes only exist once a bed is installed, and auditioning must not write to
 * the project — so the panel runs the same recipe through WebAudio that the
 * renderer runs offline. Same chords, same periods; a short excerpt, because the
 * decision is "is this the right feel", not "listen to the whole track".
 */
function playBed(context: AudioContext, bed: BgmBed, gain: GainNode): void {
  const { chords, arps } = bed.recipe;
  const start = context.currentTime;
  for (let index = 0; index * BGM_CHORD_PERIOD_SECONDS < AUDITION_SECONDS; index += 1) {
    const chord = chords[index % chords.length]!;
    const at = start + index * BGM_CHORD_PERIOD_SECONDS;
    chord.forEach((frequency, voice) => {
      const sine = context.createOscillator();
      const triangle = context.createOscillator();
      const voiceGain = context.createGain();
      const filter = context.createBiquadFilter();
      sine.type = "sine";
      sine.frequency.value = frequency;
      triangle.type = "triangle";
      triangle.frequency.value = frequency * 1.003;
      filter.type = "lowpass";
      filter.frequency.value = 350 + voice * 50;
      filter.Q.value = 0.5;
      const t = at + voice * 0.15;
      voiceGain.gain.setValueAtTime(0, t);
      voiceGain.gain.linearRampToValueAtTime(0.18, t + 2);
      voiceGain.gain.setValueAtTime(0.18, t + 5);
      voiceGain.gain.linearRampToValueAtTime(0.001, t + 8);
      sine.connect(voiceGain);
      triangle.connect(voiceGain);
      voiceGain.connect(filter);
      filter.connect(gain);
      sine.start(t);
      triangle.start(t);
      sine.stop(t + 8.5);
      triangle.stop(t + 8.5);
    });
  }
  let cursor = 0;
  for (let step = 0; step * BGM_ARP_PERIOD_SECONDS < AUDITION_SECONDS; step += 1) {
    const at = start + step * BGM_ARP_PERIOD_SECONDS;
    const notes =
      arps[Math.floor((step * BGM_ARP_PERIOD_SECONDS) / BGM_CHORD_PERIOD_SECONDS) % arps.length]!;
    const frequency = notes[cursor % notes.length]!;
    cursor += 1;
    const oscillator = context.createOscillator();
    const noteGain = context.createGain();
    const filter = context.createBiquadFilter();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    filter.type = "lowpass";
    filter.frequency.value = 2_000;
    filter.Q.value = 0.3;
    noteGain.gain.setValueAtTime(0, at);
    noteGain.gain.linearRampToValueAtTime(0.12, at + 0.05);
    noteGain.gain.exponentialRampToValueAtTime(0.03, at + 0.8);
    noteGain.gain.linearRampToValueAtTime(0.001, at + 2.5);
    oscillator.connect(filter);
    filter.connect(noteGain);
    noteGain.connect(gain);
    oscillator.start(at);
    oscillator.stop(at + 3);
  }
}

function SelectionChips({ selection }: { selection: BgmSelectionMetadata }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <span className="text-muted-foreground rounded border px-1 text-[10px]">
        {selection.tempo}
      </span>
      {selection.mood.slice(0, 3).map((mood) => (
        <span key={mood} className="text-muted-foreground rounded border px-1 text-[10px]">
          {mood}
        </span>
      ))}
    </div>
  );
}

/**
 * The licence a caller states, for a shipped track or an import.
 *
 * A form rather than a free-text field: `kind` is what a publish check reads, and
 * `holder` plus `url` are what an attribution licence obliges you to keep. Declared
 * at module scope so typing in it does not lose focus on the parent's next render.
 */
function LicenseForm({
  value,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  value: BgmLicense;
  onChange: (next: BgmLicense) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
      <div className="flex flex-wrap gap-1">
        {LICENSE_KINDS.map((kind) => (
          <Button
            key={kind}
            variant={value.kind === kind ? "default" : "outline"}
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onChange({ ...value, kind })}
          >
            {kind}
          </Button>
        ))}
      </div>
      <Input
        className="h-7 text-[11px]"
        placeholder="Who to credit (required by cc-by)"
        value={value.holder ?? ""}
        onChange={(event) => onChange({ ...value, holder: event.target.value || null })}
      />
      <Input
        className="h-7 text-[11px]"
        placeholder="Licence or download URL"
        value={value.url ?? ""}
        onChange={(event) => onChange({ ...value, url: event.target.value || null })}
      />
      <Input
        className="h-7 text-[11px]"
        placeholder="Anything the next person needs to know"
        value={value.note ?? ""}
        onChange={(event) => onChange({ ...value, note: event.target.value || null })}
      />
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={onSave}>
          {saving ? <Loader2Icon className="size-3 animate-spin" /> : null}
          Save
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One choosable track: what it is, how it is chosen, audition, and install. */
function TrackRow({
  label,
  role,
  selection,
  trailing,
  disabled,
  installed,
  playing,
  installing,
  onAudition,
  onInstall,
}: {
  label: string;
  role: string;
  selection?: BgmSelectionMetadata;
  trailing?: React.ReactNode;
  disabled?: boolean;
  installed?: boolean;
  playing: boolean;
  installing: boolean;
  onAudition: () => void;
  onInstall: () => void;
}) {
  return (
    <div className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium">{label}</span>
            {trailing}
          </div>
          <p className="text-muted-foreground truncate text-[11px]">{role}</p>
          {selection ? <SelectionChips selection={selection} /> : null}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={playing ? `Stop ${label}` : `Play ${label}`}
          disabled={disabled}
          onClick={onAudition}
        >
          {playing ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
        </Button>

        {installed ? (
          <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
            <CheckIcon className="size-3" />
            In use
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={disabled || installing}
            onClick={onInstall}
          >
            {installing ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <DownloadIcon className="size-3" />
            )}
            Use
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Picks the project's background music.
 *
 * Three sources in one list because they answer the same question with different
 * trade-offs: a synthesized bed is always available and gets rendered exactly as
 * long as the video, a shipped track is real music at a fixed length, and the
 * library is whatever this machine has imported. What a caller cannot do is listen
 * to a filename, so every row carries tempo, mood and an audition button — and a
 * shipped track whose licence nobody recorded says so, with a form to fix it.
 */
export function BgmPanel({
  projectId,
  currentTrackPath,
  revision,
  tree,
  onProjectChanged,
}: {
  projectId: string;
  currentTrackPath: string | null;
  revision: number;
  /** The project file tree, so an importable audio file is picked rather than typed. */
  tree: FileNode[];
  onProjectChanged: () => void;
}) {
  const [sources, setSources] = React.useState<BgmSources | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [licensing, setLicensing] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [importPath, setImportPath] = React.useState("");
  const [draft, setDraft] = React.useState<BgmLicense>(EMPTY_LICENSE);
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const context = React.useRef<AudioContext | null>(null);
  const bedGain = React.useRef<GainNode | null>(null);
  const assets = React.useMemo(() => audioAssets(tree), [tree]);

  const load = React.useCallback(async () => {
    try {
      const response = await fetchApi("/api/v1/bgm");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(errorMessage(payload, response.status));
        return;
      }
      setSources(payload as BgmSources);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not load the music list");
    }
  }, []);

  // Inlined rather than a call to `load`: every state write here sits behind an
  // await, which is what keeps the first paint free of a cascading render.
  React.useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const response = await fetchApi("/api/v1/bgm");
        const payload = await response.json().catch(() => null);
        if (!mounted) return;
        if (!response.ok) setError(errorMessage(payload, response.status));
        else setSources(payload as BgmSources);
      } catch (cause) {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : "could not load the music list");
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const stop = React.useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    if (bedGain.current && context.current) {
      // Ramped, not cut: stopping a pad on a hard zero is a click.
      bedGain.current.gain.linearRampToValueAtTime(0, context.current.currentTime + 0.08);
      bedGain.current = null;
      void context.current.close();
      context.current = null;
    }
    setPlaying(null);
  }, []);

  React.useEffect(() => stop, [stop]);

  const audition = async (choice: Choice, bed?: BgmBed) => {
    const key = keyOf(choice);
    if (playing === key) {
      stop();
      return;
    }
    stop();
    setError(null);
    if (choice.kind === "bed" && bed) {
      const created = new AudioContext();
      const gain = created.createGain();
      gain.gain.value = 0.9;
      gain.connect(created.destination);
      context.current = created;
      bedGain.current = gain;
      playBed(created, bed, gain);
      setPlaying(key);
      window.setTimeout(
        () => setPlaying((current) => (current === key ? null : current)),
        AUDITION_SECONDS * 1_000,
      );
      return;
    }
    const url =
      choice.kind === "track"
        ? `/api/v1/bgm/tracks/${choice.id}/audio`
        : `/api/v1/bgm/library/${choice.id}/audio`;
    const element = new Audio(apiUrl(url as `/api/${string}`));
    element.volume = 0.9;
    element.addEventListener("ended", () =>
      setPlaying((current) => (current === key ? null : current)),
    );
    audio.current = element;
    try {
      await element.play();
      setPlaying(key);
    } catch {
      setError("the browser refused to play the track");
      audio.current = null;
    }
  };

  const install = async (choice: Choice) => {
    const key = keyOf(choice);
    setPending(key);
    setError(null);
    try {
      const body: Record<string, unknown> = { expectedRevision: revision };
      if (choice.kind === "bed") body.bedId = choice.id;
      if (choice.kind === "track") body.trackId = choice.id;
      if (choice.kind === "library") body.libraryEntryId = choice.id;
      const response = await fetchApi(`/api/v1/projects/${projectId}/bgm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(errorMessage(await response.json().catch(() => null), response.status));
        return;
      }
      onProjectChanged();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "install failed");
    } finally {
      setPending(null);
    }
  };

  const saveLicense = async (trackId: string) => {
    setPending(`license:${trackId}`);
    setError(null);
    try {
      const response = await fetchApi(`/api/v1/bgm/tracks/${trackId}/license`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        setError(errorMessage(await response.json().catch(() => null), response.status));
        return;
      }
      setLicensing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not record the licence");
    } finally {
      setPending(null);
    }
  };

  const importTrack = async () => {
    if (!importPath) return;
    setPending("import");
    setError(null);
    try {
      const response = await fetchApi(`/api/v1/projects/${projectId}/bgm/library`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: importPath, license: draft }),
      });
      if (!response.ok) {
        setError(errorMessage(await response.json().catch(() => null), response.status));
        return;
      }
      setImporting(false);
      setImportPath("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "import failed");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-[11px]">
        Installing writes the track into <code className="font-mono">preview-assets/bgm/</code> and
        points preview settings at it in one revision. Volume and looping stay on the Preview tab.
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium tracking-wide uppercase">Synthesized beds</h3>
        <p className="text-muted-foreground text-[11px]">
          Generated on install at exactly the project&apos;s length. No download, no licence.
        </p>
        {BGM_BEDS.map((bed) => (
          <TrackRow
            key={bed.id}
            label={bed.label}
            role={bed.role}
            selection={bed.selection}
            playing={playing === keyOf({ kind: "bed", id: bed.id })}
            installing={pending === keyOf({ kind: "bed", id: bed.id })}
            installed={currentTrackPath === `preview-assets/bgm/${bed.id}.wav`}
            onAudition={() => void audition({ kind: "bed", id: bed.id }, bed)}
            onInstall={() => void install({ kind: "bed", id: bed.id })}
          />
        ))}
      </section>

      {sources?.tracks.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium tracking-wide uppercase">Shipped tracks</h3>
          {sources.tracks.map((track) => (
            <div key={track.id} className="flex flex-col">
              <TrackRow
                label={track.label}
                role={track.role}
                selection={track.selection}
                disabled={!track.available}
                playing={playing === keyOf({ kind: "track", id: track.id })}
                installing={pending === keyOf({ kind: "track", id: track.id })}
                onAudition={() => void audition({ kind: "track", id: track.id })}
                onInstall={() => void install({ kind: "track", id: track.id })}
                trailing={
                  <>
                    <span className="text-muted-foreground font-mono text-[10px]">
                      {Math.round(track.durationSeconds)}s
                    </span>
                    {track.license.kind === "unknown" ? (
                      <span
                        className="text-muted-foreground flex items-center gap-0.5 rounded border px-1 text-[10px]"
                        title={track.license.note ?? "No licence recorded"}
                      >
                        <AlertTriangleIcon className="size-2.5" />
                        licence unknown
                      </span>
                    ) : (
                      <span className="text-muted-foreground rounded border px-1 text-[10px]">
                        {track.license.kind}
                        {track.license.holder ? ` · ${track.license.holder}` : ""}
                      </span>
                    )}
                    {track.available ? null : (
                      <span className="text-muted-foreground rounded border px-1 text-[10px]">
                        audio not in this build
                      </span>
                    )}
                  </>
                }
              />
              <div className="px-2">
                {licensing === track.id ? (
                  <LicenseForm
                    value={draft}
                    onChange={setDraft}
                    saving={pending === `license:${track.id}`}
                    onSave={() => void saveLicense(track.id)}
                    onCancel={() => setLicensing(null)}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1 text-[10px]"
                    onClick={() => {
                      setDraft(track.license);
                      setLicensing(track.id);
                      setImporting(false);
                    }}
                  >
                    <ScaleIcon className="size-2.5" />
                    {track.license.kind === "unknown" ? "Record licence" : "Edit licence"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium tracking-wide uppercase">
            This machine&apos;s library
          </h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1 text-[10px]"
            onClick={() => {
              setImporting((current) => !current);
              setLicensing(null);
              setDraft(EMPTY_LICENSE);
            }}
          >
            <PlusIcon className="size-2.5" />
            Import from project
          </Button>
        </div>

        {importing ? (
          <div className="rounded-md border p-2">
            {assets.length ? (
              <>
                <p className="text-muted-foreground text-[11px]">
                  Pick an audio file already in this project. It is copied into the machine library
                  with the licence you state, and every project can use it after that.
                </p>
                <div className="mt-1.5 flex flex-col gap-1">
                  {assets.map((asset) => (
                    <Button
                      key={asset}
                      variant={importPath === asset ? "default" : "outline"}
                      size="sm"
                      className="h-6 justify-start px-1.5 font-mono text-[10px]"
                      onClick={() => setImportPath(asset)}
                    >
                      {asset}
                    </Button>
                  ))}
                </div>
                <LicenseForm
                  value={draft}
                  onChange={setDraft}
                  saving={pending === "import"}
                  onSave={() => void importTrack()}
                  onCancel={() => setImporting(false)}
                />
              </>
            ) : (
              <p className="text-muted-foreground text-[11px]">
                No mp3, wav, ogg or m4a in this project yet. Drop one into{" "}
                <code className="font-mono">preview-assets/bgm/</code> or upload it on the Preview
                tab first.
              </p>
            )}
          </div>
        ) : null}

        {sources?.library.length ? (
          sources.library.map((entry) => (
            <TrackRow
              key={entry.id}
              label={entry.name}
              role={`${Math.round(entry.durationSeconds)}s · ${
                entry.source === "synth" ? "synthesized" : "imported"
              }`}
              playing={playing === keyOf({ kind: "library", id: entry.id })}
              installing={pending === keyOf({ kind: "library", id: entry.id })}
              onAudition={() => void audition({ kind: "library", id: entry.id })}
              onInstall={() => void install({ kind: "library", id: entry.id })}
              trailing={
                <span
                  className="text-muted-foreground rounded border px-1 text-[10px]"
                  title={entry.license.note ?? undefined}
                >
                  {entry.license.kind}
                </span>
              }
            />
          ))
        ) : (
          <p className="text-muted-foreground text-[11px]">
            Nothing imported yet. Import brings a track that is already in this project into the
            machine library, with the licence it is allowed under recorded alongside it.
          </p>
        )}
      </section>

      {error ? (
        <p className="text-destructive text-[11px]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
