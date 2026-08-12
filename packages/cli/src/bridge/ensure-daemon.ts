import type { AttachmentKind, DaemonClient, DaemonRecord } from "@vidcom/adapter";
import { DaemonClientError } from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";

export interface EnsuredDaemon {
  record: DaemonRecord;
  attachmentId: string;
  heartbeatEveryMs: number;
  /** True when this call is the one that started the daemon. */
  started: boolean;
}

export interface EnsureDaemonDependencies {
  workspaceRoot: string;
  kind: AttachmentKind;
  clientVersion: string;
  readRecord(workspaceRoot: string): Promise<DaemonRecord | null>;
  connect(record: DaemonRecord): DaemonClient;
  /** Starts `serve --ensure` and resolves once it has published its record. */
  spawnDaemon(workspaceRoot: string): Promise<void>;
  /** Waits for a record to appear, or gives up. */
  waitForRecord(workspaceRoot: string, rejectedInstanceId?: string): Promise<DaemonRecord | null>;
}

async function attachTo(
  record: DaemonRecord,
  dependencies: EnsureDaemonDependencies,
): Promise<{ attachmentId: string; heartbeatEveryMs: number } | null> {
  const client = dependencies.connect(record);
  try {
    await client.handshake({
      workspaceRoot: dependencies.workspaceRoot,
      expectedInstanceId: record.instanceId,
      clientKind: dependencies.kind,
      clientVersion: dependencies.clientVersion,
    });
    const attachment = await client.attach(dependencies.kind);
    return {
      attachmentId: attachment.attachmentId,
      heartbeatEveryMs: attachment.heartbeatEveryMs,
    };
  } catch (error) {
    // A record can outlive the process it describes, and a daemon can restart
    // between the read and the call. Either way the answer is the same: this
    // record is not usable, so fall through to starting one.
    if (error instanceof DaemonClientError) return null;
    throw error;
  }
}

/**
 * Returns a daemon for this workspace, starting one only if there is none.
 *
 * The race is the interesting part. Two clients can find no record at the same
 * moment and both start a daemon; exactly one wins the workspace lease, and the
 * loser exits. The client that started the loser MUST NOT fail — it wanted a
 * daemon, and there is one. So a failure to start is followed by looking again
 * rather than by throwing, and only a second empty look is an error.
 */
export async function ensureDaemon(
  dependencies: EnsureDaemonDependencies,
): Promise<EnsuredDaemon> {
  const existing = await dependencies.readRecord(dependencies.workspaceRoot);
  if (existing) {
    const attachment = await attachTo(existing, dependencies);
    if (attachment !== null) return { record: existing, ...attachment, started: false };
  }

  let startFailure: unknown;
  try {
    await dependencies.spawnDaemon(dependencies.workspaceRoot);
  } catch (error) {
    // Losing the lease race looks exactly like this. Keep the reason in case
    // the second look also comes back empty, so the report names the real
    // failure instead of "no daemon appeared".
    startFailure = error;
  }

  const published = await dependencies.waitForRecord(
    dependencies.workspaceRoot,
    existing?.instanceId,
  );
  if (published === null) {
    throw new DaemonClientError(
      ErrorCode.DaemonUnavailable,
      "no daemon is serving this workspace and one could not be started",
      startFailure instanceof Error ? { cause: startFailure.message } : undefined,
    );
  }

  const attachment = await attachTo(published, dependencies);
  if (attachment === null) {
    throw new DaemonClientError(
      ErrorCode.DaemonUnavailable,
      "the daemon serving this workspace refused the handshake",
      { instanceId: published.instanceId },
    );
  }
  // `started` is false when the winner was someone else's daemon, which is what
  // makes the loser a client rather than a failure.
  return { record: published, ...attachment, started: startFailure === undefined };
}
