import {
  DAEMON_RECORD_SCHEMA_VERSION,
  DaemonClientError,
  workspaceHash,
  type DaemonClient,
  type DaemonRecord,
} from "@vidcom/adapter";
import { ensureDaemon, type EnsureDaemonDependencies } from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { describe, expect, it } from "vitest";

const WORKSPACE = "/canonical/workspace";

function record(instanceId: string, port = 43_127): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    workspaceRoot: WORKSPACE,
    workspaceHash: workspaceHash(WORKSPACE),
    instanceId,
    pid: 4321,
    host: "127.0.0.1",
    port,
    startedAt: "2026-08-09T00:00:00.000Z",
  };
}

function client(options: { handshakeFails?: boolean } = {}): DaemonClient {
  return {
    handshake: () => options.handshakeFails
      ? Promise.reject(new DaemonClientError(ErrorCode.DaemonIdentityMismatch, "gone"))
      : Promise.resolve({
        workspaceRoot: WORKSPACE,
        instanceId: "unused",
        protocolVersions: ["2026-07-28"],
        daemonVersion: "1.0.0",
      }),
    attach: () => Promise.resolve({
      attachmentId: "attachment-1",
      heartbeatEveryMs: 5_000,
      expiresAt: "2026-08-09T00:00:20.000Z",
    }),
    renew: () => Promise.reject(new Error("unused")),
    detach: () => Promise.resolve(),
    invokeTool: () => Promise.reject(new Error("unused")),
  };
}

function dependencies(overrides: Partial<EnsureDaemonDependencies> = {}): EnsureDaemonDependencies {
  return {
    workspaceRoot: WORKSPACE,
    kind: "bridge",
    clientVersion: "1.0.0",
    readRecord: () => Promise.resolve(null),
    connect: () => client(),
    spawnDaemon: () => Promise.resolve(),
    waitForRecord: () => Promise.resolve(record("daemon_started")),
    ...overrides,
  };
}

describe("ensure daemon", () => {
  it("uses the daemon that is already serving the workspace", async () => {
    let spawned = 0;
    const ensured = await ensureDaemon(dependencies({
      readRecord: () => Promise.resolve(record("daemon_first")),
      spawnDaemon: () => { spawned += 1; return Promise.resolve(); },
    }));
    expect(ensured.started).toBe(false);
    expect(ensured.record.instanceId).toBe("daemon_first");
    expect(spawned).toBe(0);
  });

  it("starts one when nothing is serving the workspace", async () => {
    const ensured = await ensureDaemon(dependencies());
    expect(ensured.started).toBe(true);
    expect(ensured.attachmentId).toBe("attachment-1");
  });

  it("starts one when the record outlived the process it described", async () => {
    // A daemon that was killed leaves its record behind, and the record looks
    // perfectly valid. Only the handshake finds out.
    let spawned = 0;
    const ensured = await ensureDaemon(dependencies({
      readRecord: () => Promise.resolve(record("daemon_dead")),
      connect: (target) => client({ handshakeFails: target.instanceId === "daemon_dead" }),
      spawnDaemon: () => { spawned += 1; return Promise.resolve(); },
    }));
    expect(spawned).toBe(1);
    expect(ensured.record.instanceId).toBe("daemon_started");
  });

  it("turns the loser of the start race into a client", async () => {
    // Two clients can find no record at the same moment and both start a
    // daemon. Exactly one wins the workspace lease and the other exits — and
    // the client that started the loser still wanted a daemon, and there is
    // one, so it must not fail.
    const ensured = await ensureDaemon(dependencies({
      spawnDaemon: () => Promise.reject(new Error("workspace lease is held elsewhere")),
      waitForRecord: () => Promise.resolve(record("daemon_winner")),
    }));
    expect(ensured.record.instanceId).toBe("daemon_winner");
    expect(ensured.started).toBe(false);
    expect(ensured.attachmentId).toBe("attachment-1");
  });

  it("names the real failure when nothing came up at all", async () => {
    // Reporting "no daemon appeared" would hide the reason the start failed,
    // which is the only thing worth telling the user here.
    await expect(ensureDaemon(dependencies({
      spawnDaemon: () => Promise.reject(new Error("the runtime is not extracted")),
      waitForRecord: () => Promise.resolve(null),
    }))).rejects.toMatchObject({
      code: ErrorCode.DaemonUnavailable,
      details: { cause: "the runtime is not extracted" },
    });
  });

  it("reports a daemon that came up and then refused the handshake", async () => {
    await expect(ensureDaemon(dependencies({
      connect: () => client({ handshakeFails: true }),
    }))).rejects.toMatchObject({ code: ErrorCode.DaemonUnavailable });
  });

  it("attaches as the kind the caller asked for", async () => {
    // The kind decides whether the daemon may ever shut itself down, so it is
    // not a label: a UI attachment takes that right away permanently.
    let attachedAs: string | undefined;
    await ensureDaemon(dependencies({
      kind: "ui",
      readRecord: () => Promise.resolve(record("daemon_first")),
      connect: () => ({
        ...client(),
        attach: (kind) => {
          attachedAs = kind;
          return Promise.resolve({
            attachmentId: "attachment-1",
            heartbeatEveryMs: 5_000,
            expiresAt: "2026-08-09T00:00:20.000Z",
          });
        },
      }),
    }));
    expect(attachedAs).toBe("ui");
  });
});
