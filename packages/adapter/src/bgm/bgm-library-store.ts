import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BGM_AUDIO_EXTENSIONS,
  ErrorCode,
  type BgmLibraryEntry,
  type BgmLicense,
  type BgmLibrarySource,
  type BgmBedId,
  type ContentHash,
  type DomainError,
} from "@vidcom/contracts";
import { err, ok, type BgmLibraryPort, type Result } from "@vidcom/core";

/**
 * The machine's BGM library: `<app-data>/bgm/`.
 *
 * App-data rather than the workspace, for the same reason motion libraries live
 * there: a bed is worth having in every project on this install, and a per-project
 * copy would make "the track I always use" a thing the user re-imports. Tracks are
 * content-addressed, so importing the same file twice is one entry.
 *
 * The ledger is the point of the directory. VidCom cannot read a licence off an
 * audio file, so an import states one and this keeps what was stated — including
 * `unknown`, which is what an honest "nobody said" looks like and what a publish
 * check can warn about.
 */
const LEDGER_FILE = "library.json";
const TRACKS_DIR = "tracks";
const LEDGER_SCHEMA_VERSION = 1;

interface Ledger {
  schemaVersion: number;
  entries: BgmLibraryEntry[];
  /**
   * Licences recorded for the shipped tracks, keyed by track id.
   *
   * The catalogue ships them as `unknown` because nothing in the audio, the
   * filenames or the commit that added them records a licence. That gap is real
   * and cannot be closed by guessing — but it can be closed once, by whoever does
   * know, and then stay closed for every project on this install. That is what
   * this map is: an override the ledger owns, not a code change.
   */
  shippedLicenses?: Record<string, BgmLicense>;
}

function hashOf(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

/** WAV duration from the header; the only format this store parses without a prober. */
function wavSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  if (riff !== "RIFF") return null;
  const byteRate = view.getUint32(28, true);
  const dataSize = view.getUint32(40, true);
  return byteRate > 0 ? dataSize / byteRate : null;
}

export interface BgmLibraryStoreOptions {
  appDataRoot: string;
  /**
   * Where the shipped tracks live.
   *
   * A packaged build extracts them into app-data and passes that path; a source
   * checkout has them beside the adapter package. Explicit either way: a silent
   * fallback would let a build that shipped no audio still claim four tracks.
   */
  shippedTrackRoot?: string;
  /**
   * Reads a media file's duration — FFprobe, injected rather than spawned here so
   * the store stays a filesystem concern and a test can run without a binary.
   * Only consulted for formats whose header this store cannot read.
   */
  probeDurationSeconds?(file: string): Promise<number | null>;
  now?(): Date;
  newId?(): string;
}

export class BgmLibraryStore implements BgmLibraryPort {
  private readonly root: string;

  constructor(private readonly options: BgmLibraryStoreOptions) {
    this.root = path.join(options.appDataRoot, "bgm");
  }

  private ledgerPath(): string {
    return path.join(this.root, LEDGER_FILE);
  }

  private trackPath(id: string, extension: string): string {
    return path.join(this.root, TRACKS_DIR, `${id}.${extension}`);
  }

  private async readLedger(): Promise<Ledger> {
    try {
      const raw = await readFile(this.ledgerPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<Ledger>;
      if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
        return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [] };
      }
      return {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        entries: parsed.entries,
        ...(parsed.shippedLicenses ? { shippedLicenses: parsed.shippedLicenses } : {}),
      };
    } catch {
      // A missing ledger is an empty library, not a fault: the directory only
      // exists once something has been imported.
      return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [] };
    }
  }

  private async writeLedger(ledger: Ledger): Promise<void> {
    await mkdir(this.root, { recursive: true });
    // Written through a temp file: a half-written ledger would read as an empty
    // library and lose every recorded licence.
    const staging = `${this.ledgerPath()}.${process.pid}.tmp`;
    await writeFile(staging, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(staging, this.ledgerPath());
  }

  private shippedRoot(): string {
    return this.options.shippedTrackRoot
      ?? path.join(fileURLToPath(new URL("../../assets/bgm", import.meta.url)));
  }

  /** Whether a shipped track's bytes are actually on this install. */
  async hasShipped(filename: string): Promise<boolean> {
    try {
      await readFile(path.join(this.shippedRoot(), filename));
      return true;
    } catch {
      return false;
    }
  }

  /** Reads one shipped track; `null` when this build did not include the audio. */
  async readShipped(filename: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(path.join(this.shippedRoot(), filename)));
    } catch {
      return null;
    }
  }

  /** Licences this install has recorded for shipped tracks, keyed by track id. */
  async shippedLicenses(): Promise<Record<string, BgmLicense>> {
    return (await this.readLedger()).shippedLicenses ?? {};
  }

  /** Records what a shipped track may be used for; replaces any earlier answer. */
  async recordShippedLicense(trackId: string, license: BgmLicense): Promise<void> {
    const ledger = await this.readLedger();
    await this.writeLedger({
      ...ledger,
      shippedLicenses: { ...(ledger.shippedLicenses ?? {}), [trackId]: license },
    });
  }

  async list(): Promise<BgmLibraryEntry[]> {
    const ledger = await this.readLedger();
    return [...ledger.entries].sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  async read(id: string): Promise<Uint8Array | null> {
    let files: string[];
    try {
      files = await readdir(path.join(this.root, TRACKS_DIR));
    } catch {
      return null;
    }
    const match = files.find((file) => file.slice(0, file.lastIndexOf(".")) === id);
    if (!match) return null;
    try {
      return new Uint8Array(await readFile(path.join(this.root, TRACKS_DIR, match)));
    } catch {
      return null;
    }
  }

  async add(input: {
    name: string;
    extension: string;
    bytes: Uint8Array;
    source: BgmLibrarySource;
    bedId: BgmBedId | null;
    license: BgmLicense;
  }): Promise<Result<{ entry: BgmLibraryEntry; alreadyPresent: boolean }, DomainError>> {
    const extension = input.extension.toLowerCase().replace(/^\./, "");
    if (!BGM_AUDIO_EXTENSIONS.includes(extension)) {
      return err({
        code: ErrorCode.UnsupportedMedia,
        message: `a BGM track must be one of ${BGM_AUDIO_EXTENSIONS.join(", ")}`,
        field: "path",
      });
    }
    const contentHash = hashOf(input.bytes);
    const ledger = await this.readLedger();
    const existing = ledger.entries.find((entry) => entry.contentHash === contentHash);
    // Content-addressed on purpose: the same file imported from two projects is
    // one bed, and re-importing must not multiply the library.
    if (existing) return ok({ entry: existing, alreadyPresent: true });

    const id = this.options.newId?.() ?? `bgm_${contentHash.slice(7, 23)}`;
    const target = this.trackPath(id, extension);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.bytes);

    let durationSeconds = wavSeconds(input.bytes);
    if (durationSeconds === null && this.options.probeDurationSeconds) {
      durationSeconds = await this.options.probeDurationSeconds(target);
    }
    if (durationSeconds === null || !(durationSeconds > 0)) {
      await rm(target, { force: true });
      return err({
        code: ErrorCode.UnsupportedMedia,
        message: "the track's duration could not be read; re-encode it or import a WAV",
        field: "path",
      });
    }

    const entry: BgmLibraryEntry = {
      id,
      name: input.name,
      source: input.source,
      bedId: input.bedId,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      byteSize: input.bytes.byteLength,
      contentHash,
      license: input.license,
      addedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    await this.writeLedger({ ...ledger, entries: [...ledger.entries, entry] });
    return ok({ entry, alreadyPresent: false });
  }
}
