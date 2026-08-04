import { ErrorCode, type DomainError } from "@vidcom/contracts";

import { err, ok, type Result } from "../error/result";
import type { JobId } from "../port/types";
import type { RemoteAssetViolation } from "./remote-asset-scan";

export const REMOTE_ASSET_EXTERNAL_REPORT_LIMIT = 100;

export type RuntimeAssetReport =
  | {
      kind: "media";
      jobId: JobId;
      blockedUri: string;
      directive: string;
    }
  | {
      kind: "external";
      jobId: JobId;
      url: string;
      initiatorType: "script" | "link" | "css" | "font";
    };

export interface RemoteAssetGuardSnapshot {
  mediaViolations: RemoteAssetViolation[];
  externalDependencies: string[];
}

export interface RuntimeAssetGuardPort {
  open(jobId: JobId): Promise<{ csp: string; bootstrapScript: string; token: string }>;
  close(jobId: JobId, token: string): Promise<RemoteAssetGuardSnapshot>;
}

export interface GuardedArtifactPublication {
  publish(guardResult: { externalDependencies: string[] }): Promise<void>;
  discard(): Promise<void>;
}

/** Per-job collector. Authentication stays in the callback adapter; this owns deterministic dedupe and caps. */
export class RemoteAssetReportCollector {
  private readonly media = new Map<string, RemoteAssetViolation>();
  private readonly external = new Map<string, string>();

  constructor(readonly jobId: JobId) {}

  record(report: RuntimeAssetReport): boolean {
    if (report.jobId !== this.jobId) return false;
    if (report.kind === "media") {
      const key = `${report.directive}\0${report.blockedUri}`;
      if (!this.media.has(key)) {
        this.media.set(key, {
          url: report.blockedUri,
          source: "observed-request",
          reference: report.directive,
        });
      }
      return true;
    }
    const key = `${report.initiatorType}\0${report.url}`;
    if (!this.external.has(key) && this.external.size < REMOTE_ASSET_EXTERNAL_REPORT_LIMIT) {
      this.external.set(key, report.url);
    }
    return true;
  }

  snapshot(): RemoteAssetGuardSnapshot {
    return {
      mediaViolations: [...this.media.values()],
      externalDependencies: [...new Set(this.external.values())],
    };
  }
}

/** The caller must run this after closing the callback and before publishing a staged artifact. */
export function evaluateRemoteAssetGuard(
  snapshot: RemoteAssetGuardSnapshot,
): Result<{ externalDependencies: string[] }, DomainError> {
  if (snapshot.mediaViolations.length > 0) {
    return err({
      code: ErrorCode.RemoteAssetNotLocal,
      message: "rendered document declared remote media at runtime",
      details: { violations: snapshot.mediaViolations },
    });
  }
  return ok({ externalDependencies: snapshot.externalDependencies });
}

/** Closes enforcement first; a media violation can therefore only discard, never publish, the staging artifact. */
export async function finalizeGuardedArtifact(
  guard: RuntimeAssetGuardPort,
  jobId: JobId,
  token: string,
  artifact: GuardedArtifactPublication,
): Promise<Result<{ externalDependencies: string[] }, DomainError>> {
  let snapshot: RemoteAssetGuardSnapshot;
  try {
    snapshot = await guard.close(jobId, token);
  } catch {
    await artifact.discard().catch(() => {});
    return err({ code: ErrorCode.StorageUnavailable, message: "runtime asset guard could not be closed" });
  }
  const evaluated = evaluateRemoteAssetGuard(snapshot);
  if (!evaluated.ok) {
    await artifact.discard().catch(() => {});
    return evaluated;
  }
  try {
    await artifact.publish(evaluated.value);
    return evaluated;
  } catch (error) {
    await artifact.discard().catch(() => {});
    throw error;
  }
}
