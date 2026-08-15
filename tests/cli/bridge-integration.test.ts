import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DaemonDiscoveryStore,
  createDaemonClient,
  workspaceHash,
  type DaemonRecord,
} from "@vidcom/adapter";
import { ensureDaemon } from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import {
  AttachmentRegistry,
  InMemoryNonceStore,
  InMemorySessionStore,
  bindLoopback,
  createServerApp,
  type LoopbackListener,
} from "@vidcom/server";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const listeners: LoopbackListener[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appData(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-bridge-")));
  roots.push(root);
  return root;
}

const clock = { now: () => new Date("2026-08-09T00:00:00.000Z") };

/** A real daemon on a real loopback port, serving the real bridge routes. */
async function startDaemon(options: {
  workspaceRoot: string;
  instanceId: string;
  autoStarted?: boolean;
}): Promise<{ listener: LoopbackListener; record: DaemonRecord; attachments: AttachmentRegistry }> {
  const attachments = new AttachmentRegistry({
    clock,
    instanceId: options.instanceId,
    autoStarted: options.autoStarted ?? true,
    hasActiveWork: () => false,
  });
  const listener = await bindLoopback((port) => createServerApp({
    port,
    uiOrigins: [],
    nonces: new InMemoryNonceStore(clock),
    sessions: new InMemorySessionStore(clock),
    mcpCredentials: {
      verify: (token) => Promise.resolve(token === "system-token" ? { id: "system-bridge" } : null),
    },
    bridge: {
      instanceId: options.instanceId,
      workspaceRoot: options.workspaceRoot,
      daemonVersion: "1.0.0",
      protocolVersions: ["2026-07-28"],
      attachments,
      bridgeCredentialId: () => Promise.resolve("system-bridge"),
      leaseHeld: () => true,
      invokeTool: () => Promise.resolve({ ok: true as const, value: { projects: [] } }),
    },
  }));
  listeners.push(listener);
  return {
    listener,
    attachments,
    record: {
      schemaVersion: 1,
      workspaceRoot: options.workspaceRoot,
      workspaceHash: workspaceHash(options.workspaceRoot),
      instanceId: options.instanceId,
      pid: process.pid,
      host: "127.0.0.1",
      port: listener.port,
      startedAt: "2026-08-09T00:00:00.000Z",
    },
  };
}

function connect(record: DaemonRecord) {
  return createDaemonClient({
    baseUrl: `http://127.0.0.1:${record.port}`,
    bearer: "system-token",
    deadlineMs: 2_000,
  });
}

describe("bridge against a real daemon", () => {
  it("attaches, calls a tool and detaches over a real socket", async () => {
    const daemon = await startDaemon({ workspaceRoot: "/w", instanceId: "daemon_first" });
    const client = connect(daemon.record);
    await client.handshake({
      workspaceRoot: "/w",
      expectedInstanceId: "daemon_first",
      clientKind: "bridge",
      clientVersion: "1.0.0",
    });
    const attachment = await client.attach("bridge");
    expect(daemon.attachments.live()).toHaveLength(1);
    expect(await client.invokeTool("list_projects", {}, { protocolVersion: "2026-07-28", era: "modern" }))
      .toEqual({ projects: [] });
    await client.detach(attachment.attachmentId);
    expect(daemon.attachments.live()).toEqual([]);
  });

  it("refuses a handshake when the port now belongs to something else", async () => {
    // A stale record points at a port the OS has since handed to another
    // program. That program answers — and without the identity check the client
    // would treat whatever came back as its daemon.
    const other = await startDaemon({ workspaceRoot: "/other", instanceId: "daemon_other" });
    const stale: DaemonRecord = { ...other.record, workspaceRoot: "/w", instanceId: "daemon_gone" };
    await expect(connect(stale).handshake({
      workspaceRoot: "/w",
      expectedInstanceId: "daemon_gone",
      clientKind: "bridge",
      clientVersion: "1.0.0",
    })).rejects.toMatchObject({ code: ErrorCode.DaemonIdentityMismatch });
  });

  it("fails with a code instead of hanging when the daemon disappears mid-session", async () => {
    // The one outcome worse than an error here is a fabricated result, and the
    // one nearly as bad is a client that waits forever.
    const daemon = await startDaemon({ workspaceRoot: "/w", instanceId: "daemon_first" });
    const client = connect(daemon.record);
    await client.attach("bridge");
    await daemon.listener.close();
    listeners.splice(listeners.indexOf(daemon.listener), 1);

    await expect(client.invokeTool("list_projects", {}, { protocolVersion: "2026-07-28", era: "modern" }))
      .rejects.toMatchObject({ code: ErrorCode.DaemonUnavailable });
  }, 20_000);

  it("connects the loser of a simultaneous auto-start to the winner", async () => {
    // Both clients wanted a daemon and there is exactly one. The loser is a
    // client, not a failure.
    const root = await appData();
    const store = new DaemonDiscoveryStore(root);
    const winner = await startDaemon({ workspaceRoot: "/w", instanceId: "daemon_winner" });

    // The workspace lease is what arbitrates, and it is atomic. Modelling it
    // with a read-then-write would let both callers believe they won, which is
    // the one outcome the real lease cannot produce.
    let leaseTaken = false;
    const start = (label: string) => ensureDaemon({
      workspaceRoot: "/w",
      kind: "bridge",
      clientVersion: "1.0.0",
      readRecord: (workspaceRoot) => store.read(workspaceRoot),
      connect,
      spawnDaemon: async () => {
        if (leaseTaken) throw new Error(`${label} lost the lease race`);
        leaseTaken = true;
        await store.publish(winner.record);
      },
      // Polling, because that is what the real wait does: the loser reaches
      // this point before the winner has finished writing its record, and a
      // single read would call a daemon that is milliseconds away "absent".
      waitForRecord: async (workspaceRoot) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const found = await store.read(workspaceRoot);
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return null;
      },
    });

    const [first, second] = await Promise.all([start("first"), start("second")]);
    expect(first?.record.instanceId).toBe("daemon_winner");
    expect(second?.record.instanceId).toBe("daemon_winner");
    expect([first?.started, second?.started].filter(Boolean)).toHaveLength(1);
    expect(winner.attachments.live()).toHaveLength(2);
  });

  it("lets the last detach retire an auto-started daemon but not a manual one", async () => {
    for (const autoStarted of [true, false]) {
      const daemon = await startDaemon({
        workspaceRoot: "/w",
        instanceId: `daemon_${String(autoStarted)}`,
        autoStarted,
      });
      const client = connect(daemon.record);
      const attachment = await client.attach("bridge");
      await client.detach(attachment.attachmentId);
      // The grace period has not elapsed on this frozen clock, so neither may
      // retire yet — but only one of them is ever allowed to.
      expect(await daemon.attachments.canSelfShutdown()).toBe(false);
    }
  });

  it("discovers the daemon it just published, on a real filesystem", async () => {
    const store = new DaemonDiscoveryStore(await appData());
    const daemon = await startDaemon({ workspaceRoot: "/w", instanceId: "daemon_first" });
    await store.publish(daemon.record);

    const ensured = await ensureDaemon({
      workspaceRoot: "/w",
      kind: "ui",
      clientVersion: "1.0.0",
      readRecord: (workspaceRoot) => store.read(workspaceRoot),
      connect,
      spawnDaemon: () => Promise.reject(new Error("should not have started anything")),
      waitForRecord: (workspaceRoot) => store.read(workspaceRoot),
    });
    expect(ensured.started).toBe(false);
    expect(daemon.attachments.live()[0]?.kind).toBe("ui");
    // A UI attachment takes away the right to self-shutdown for good.
    expect(await daemon.attachments.canSelfShutdown()).toBe(false);
  });
});
