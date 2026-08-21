import { constants } from "node:fs";
import { open, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { parseHTML } from "linkedom";

import { ErrorCode, type DomainError } from "@vidcom/contracts";
import {
  canonicalizeJson,
  err,
  evaluateRemoteAssetGuard,
  ok,
  type BinaryProbePort,
  type IdPort,
  type JobId,
  type ProcessSupervisorPort,
  type ProjectRef,
  type RenderProjectPort,
  type RenderRootPort,
  type RuntimeAssetGuardPort,
  type ThumbnailKey,
  type ThumbnailPort,
  type ThumbnailRenderResult,
} from "@vidcom/core";

import { authoredCompositionRoot, rootHost } from "./dom";

const timestamp = (value: number): string => Number(value.toFixed(3)).toString();

function abortError(): DOMException {
  return new DOMException("thumbnail rendering was aborted", "AbortError");
}

function failed(keys: readonly ThumbnailKey[], error: DomainError): ThumbnailRenderResult[] {
  return keys.map((key) => ({ key, result: err(error) }));
}

function isolateSceneDocument(source: string, sceneId: string): string {
  const { document } = parseHTML(source);
  const scope = authoredCompositionRoot(document);
  const hosts = [...scope.querySelectorAll("[data-composition-id]")];
  const root = rootHost(hosts);
  if (!root) throw new TypeError("thumbnail render document has no composition root");
  const selected = hosts
    .find((element) => element.getAttribute("data-composition-id") === sceneId);
  if (!selected) throw new TypeError("thumbnail scene was not found in the render document");
  for (const host of hosts) {
    if (host === selected || host.contains(selected) || selected.contains(host)) continue;
    host.remove();
  }
  selected.setAttribute("data-start", "0");
  root.setAttribute("data-start", "0");
  const duration = selected.getAttribute("data-duration");
  if (duration) root.setAttribute("data-duration", duration);
  return document.toString();
}

function snapshotFilesByTimestamp(entries: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of entries) {
    const match = /-at-(-?\d+(?:\.\d+)?)s\.png$/iu.exec(entry);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && !files.has(timestamp(value))) files.set(timestamp(value), entry);
  }
  return files;
}

export interface HyperframesThumbnailRendererDependencies {
  process: ProcessSupervisorPort;
  roots: RenderRootPort;
  renderProjects: RenderProjectPort;
  binaries: BinaryProbePort;
  guard: RuntimeAssetGuardPort;
  ids: IdPort;
  runtimeSource(): string;
  injectGuard(document: string, guard: { csp: string; bootstrapScript: string }): string;
  buildDocument(ref: ProjectRef): Promise<string>;
}

/** Disposable app-data renderer: one snapshot child and one FFmpeg child for the complete batch. */
export class HyperframesThumbnailRenderer implements ThumbnailPort {
  constructor(private readonly dependencies: HyperframesThumbnailRendererDependencies) {}

  async renderBatch(
    ref: ProjectRef,
    keys: readonly ThumbnailKey[],
    signal: AbortSignal,
  ): Promise<readonly ThumbnailRenderResult[]> {
    const invalid = this.validate(keys);
    if (invalid) return failed(keys, invalid);
    if (signal.aborted) throw abortError();

    const jobId = this.dependencies.ids.newId("thumbnail") as JobId;
    let acquired = false;
    let guardSession: { token: string } | null = null;
    let result: ThumbnailRenderResult[] | null = null;
    let pendingError: unknown = null;
    let cleanupError: string | null = null;
    try {
      const binaries = await this.dependencies.binaries.probe(ref.root);
      if (!binaries.ok) {
        result = failed(keys, binaries.error);
      } else {
        const root = await this.dependencies.roots.acquire(jobId);
        acquired = true;
        const opened = await this.dependencies.guard.open(jobId);
        guardSession = opened;
        const document = this.dependencies.injectGuard(
          isolateSceneDocument(await this.dependencies.buildDocument(ref), keys[0]!.sceneId),
          opened,
        );
        const staged = await this.dependencies.renderProjects.stage(
          ref,
          root.root,
          document,
          this.dependencies.runtimeSource(),
        );
        const snapshot = await this.dependencies.process.run({
          command: [
            ...binaries.value.hyperframesCommand,
            "snapshot",
            staged.projectRoot,
            "--at",
            keys.map((key) => timestamp(key.atSeconds)).join(","),
            "--no-end",
            "--describe", "false",
            "--output", staged.snapshotOutputRoot,
          ],
          cwd: staged.projectRoot,
          environment: {
            ...root.environment,
            HYPERFRAMES_BROWSER_PATH: binaries.value.browserPath,
            HYPERFRAMES_FFMPEG_PATH: binaries.value.ffmpegPath,
            HYPERFRAMES_FFPROBE_PATH: binaries.value.ffprobePath,
          },
          signal,
        });
        const snapshotFailure = this.processFailure(snapshot, signal, "HyperFrames snapshot failed");
        if (snapshotFailure) {
          result = failed(keys, snapshotFailure);
        } else {
          const guardSnapshot = await this.dependencies.guard.close(jobId, opened.token);
          guardSession = null;
          const guarded = evaluateRemoteAssetGuard(guardSnapshot);
          if (!guarded.ok) {
            result = failed(keys, guarded.error);
          } else {
            result = await this.convertBatch(staged.snapshotOutputRoot, keys, binaries.value.ffmpegPath, root.environment, signal);
          }
        }
      }
    } catch (error) {
      pendingError = error;
    } finally {
      if (guardSession) await this.dependencies.guard.close(jobId, guardSession.token).catch(() => {});
      if (acquired) {
        const released = await this.dependencies.roots.release(jobId);
        if (!released.ok) cleanupError = released.error ?? "thumbnail staging cleanup failed";
      }
    }
    if (signal.aborted) throw abortError();
    if (pendingError) {
      const message = pendingError instanceof Error ? pendingError.message : "thumbnail rendering failed";
      return failed(keys, { code: ErrorCode.Internal, message });
    }
    if (cleanupError) return failed(keys, { code: ErrorCode.StorageUnavailable, message: cleanupError });
    return result ?? failed(keys, { code: ErrorCode.Internal, message: "thumbnail rendering produced no result" });
  }

  private validate(keys: readonly ThumbnailKey[]): DomainError | null {
    if (keys.length < 1 || keys.length > 256) {
      return { code: ErrorCode.SchemaInvalid, message: "thumbnail batch must contain from 1 to 256 keys" };
    }
    const first = keys[0]!;
    const identity = canonicalizeJson({ sceneId: first.sceneId, fingerprint: first.fingerprint, profile: first.profile });
    if (keys.some((key) => !Number.isFinite(key.atSeconds) || key.atSeconds < 0
      || canonicalizeJson({ sceneId: key.sceneId, fingerprint: key.fingerprint, profile: key.profile }) !== identity)
      || new Set(keys.map((key) => key.atSeconds)).size !== keys.length) {
      return { code: ErrorCode.SchemaInvalid, message: "thumbnail batch keys must share identity and unique finite marks" };
    }
    return null;
  }

  private processFailure(
    process: Awaited<ReturnType<ProcessSupervisorPort["run"]>>,
    signal: AbortSignal,
    message: string,
  ): DomainError | null {
    if (process.status === "terminated") {
      if (signal.aborted) throw abortError();
      return process.proof.exhaustive
        ? { code: ErrorCode.Internal, message }
        : { code: ErrorCode.ProcessTerminationUnverified, message: "thumbnail process termination was not exhaustive" };
    }
    return process.output.exitCode === 0 ? null : { code: ErrorCode.Internal, message };
  }

  private async convertBatch(
    outputRoot: string,
    keys: readonly ThumbnailKey[],
    ffmpegPath: string,
    environment: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ThumbnailRenderResult[]> {
    const byTimestamp = snapshotFilesByTimestamp(await readdir(outputRoot));
    const present: Array<{ key: ThumbnailKey; outputIndex: number }> = [];
    for (const key of keys) {
      const filename = byTimestamp.get(timestamp(key.atSeconds));
      if (!filename) continue;
      const outputIndex = present.length;
      await rename(
        path.join(outputRoot, filename),
        path.join(outputRoot, `thumb-input-${String(outputIndex).padStart(3, "0")}.png`),
      );
      present.push({ key, outputIndex });
    }
    if (present.length === 0) {
      return failed(keys, { code: ErrorCode.Internal, message: "snapshot batch produced no matching frames" });
    }
    const profile = keys[0]!.profile;
    const outputPattern = path.join(outputRoot, "thumb-output-%03d.webp");
    const converted = await this.dependencies.process.run({
      command: [
        ffmpegPath,
        "-v", "error",
        "-nostdin",
        "-y",
        "-framerate", "1",
        "-start_number", "0",
        "-i", path.join(outputRoot, "thumb-input-%03d.png"),
        "-vf", `scale=${profile.width}:${profile.height}`,
        "-frames:v", String(present.length),
        "-c:v", "libwebp",
        "-quality", "80",
        "-start_number", "0",
        outputPattern,
      ],
      cwd: outputRoot,
      environment,
      signal,
    });
    const conversionFailure = this.processFailure(converted, signal, "thumbnail WebP conversion failed");
    if (conversionFailure) return failed(keys, conversionFailure);

    const convertedByKey = new Map<ThumbnailKey, Uint8Array>();
    for (const item of present) {
      const filename = outputPattern.replace("%03d", String(item.outputIndex).padStart(3, "0"));
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) continue;
        convertedByKey.set(item.key, new Uint8Array(await handle.readFile()));
      } finally {
        await handle.close();
      }
    }
    return keys.map((key) => {
      const bytes = convertedByKey.get(key);
      return bytes
        ? { key, result: ok(bytes) }
        : { key, result: err({ code: ErrorCode.Internal, message: "thumbnail frame was not produced" }) };
    });
  }
}
