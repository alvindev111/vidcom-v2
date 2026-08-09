import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateDatabase, type RuntimeAssetSource } from "@vidcom/adapter";
import {
  BootstrapCoordinator,
  CREDENTIAL_LOCK_FILENAME,
  RUNTIME_BOOTSTRAP_LOCK_FILENAME,
  selectWorkspace,
  startVidcomFoundation,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import type { AbsolutePath } from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  archiveFor,
  assetSource,
  HOST_SUPPORTED,
  runtimeManifest,
} from "../support/runtime-fixture";

const ARCHIVE_KEY = "node";
const BODY = Buffer.from("vidcom runtime fixture\n", "utf8");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-bootstrap-")));
  roots.push(root);
  return root;
}

function source(): RuntimeAssetSource {
  const { bytes, archive } = archiveFor(ARCHIVE_KEY, [{ path: "runtime.txt", content: BODY }]);
  return assetSource(runtimeManifest("1.0.0", [archive]), { [ARCHIVE_KEY]: bytes });
}

async function isDirectory(pathname: string): Promise<boolean> {
  return lstat(pathname).then((value) => value.isDirectory(), () => false);
}

describe.skipIf(!HOST_SUPPORTED)("bootstrap coordinator", () => {
  it("prepares a source checkout without inventing an embedded runtime", async () => {
    const appDataRoot = await temporaryRoot();
    const prepared = await new BootstrapCoordinator().prepare({ appDataRoot });
    try {
      expect(prepared.manifest).toBeNull();
      expect(prepared.versionRoot).toBeNull();
      expect(prepared.archiveRoots).toEqual({});
      expect(prepared.database.$client.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
      ).get()).toBeDefined();
    } finally {
      await prepared.release();
    }
  });

  it("extracts, migrates and hands over a usable database", async () => {
    const appDataRoot = await temporaryRoot();
    const prepared = await new BootstrapCoordinator().prepare({
      appDataRoot,
      assetSource: source(),
    });
    try {
      expect(prepared.manifest?.artifactVersion).toBe("1.0.0");
      expect(prepared.versionRoot).toBe(path.join(appDataRoot, "native", "1.0.0"));
      expect(await isDirectory(prepared.archiveRoots[ARCHIVE_KEY] ?? "")).toBe(true);
      // A migrated database answers for a table the migrations create.
      expect(prepared.database.$client.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
      ).get()).toBeDefined();
    } finally {
      await prepared.release();
    }
  });

  it("runs the real migration exactly once across bootstrap, selection and foundation", async () => {
    const root = await temporaryRoot();
    const appDataRoot = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot);
    let migrationCalls = 0;
    const countedMigration: typeof migrateDatabase = async (database) => {
      migrationCalls += 1;
      await migrateDatabase(database);
    };

    const prepared = await new BootstrapCoordinator({ migrate: countedMigration }).prepare({
      appDataRoot,
      assetSource: source(),
    });
    let selected: AbsolutePath;
    try {
      selected = await selectWorkspace({
        explicit: workspaceRoot,
        appDataRoot,
        database: prepared.database,
      });
    } finally {
      await prepared.release();
    }

    const foundation = await startVidcomFoundation({
      appDataRoot,
      workspaceRoot: selected,
      holderId: "test:migration-counter",
    }, {
      async recoverJobs() {},
      async startScheduler() {},
      async startWatcher() {},
      async openListener() { return null; },
    }, {
      migrationPrepared: true,
      migrate: countedMigration,
    });
    try {
      expect(migrationCalls).toBe(1);
    } finally {
      await foundation.stop();
    }
  });

  it("holds the bootstrap lock for the whole preparation and releases it after", async () => {
    const appDataRoot = await temporaryRoot();
    const bootstrapLock = path.join(appDataRoot, RUNTIME_BOOTSTRAP_LOCK_FILENAME);
    let heldDuringReconcile = false;

    const prepared = await new BootstrapCoordinator({
      reconcileCredential: async () => {
        heldDuringReconcile = await isDirectory(bootstrapLock);
      },
    }).prepare({ appDataRoot, assetSource: source() });

    expect(heldDuringReconcile).toBe(true);
    expect(await isDirectory(bootstrapLock)).toBe(true);
    await prepared.release();
    expect(await isDirectory(bootstrapLock)).toBe(false);
  });

  it("takes the credential lock only while the bootstrap lock is held", async () => {
    const appDataRoot = await temporaryRoot();
    const observed: Array<{ bootstrap: boolean; credential: boolean }> = [];

    const prepared = await new BootstrapCoordinator({
      reconcileCredential: async ({ lease }) => {
        // The lease proves this reconciler owns the credential lock, and the
        // bootstrap directory proves the outer one is still held. Order is a
        // rule here, so it is asserted rather than assumed.
        await lease.assertHeld();
        observed.push({
          bootstrap: await isDirectory(path.join(appDataRoot, RUNTIME_BOOTSTRAP_LOCK_FILENAME)),
          credential: await isDirectory(path.join(appDataRoot, CREDENTIAL_LOCK_FILENAME)),
        });
      },
    }).prepare({ appDataRoot, assetSource: source() });

    expect(observed).toEqual([{ bootstrap: true, credential: true }]);
    // The credential lock is released as soon as reconciliation ends, so it must
    // not outlive the step that needed it.
    expect(await isDirectory(path.join(appDataRoot, CREDENTIAL_LOCK_FILENAME))).toBe(false);
    await prepared.release();
  });

  it("does not touch the credential lock when no reconciler is configured", async () => {
    const appDataRoot = await temporaryRoot();
    const prepared = await new BootstrapCoordinator().prepare({
      appDataRoot,
      assetSource: source(),
    });
    expect(await isDirectory(path.join(appDataRoot, CREDENTIAL_LOCK_FILENAME))).toBe(false);
    await prepared.release();
  });

  it("serializes two preparations rather than running them together", async () => {
    const appDataRoot = await temporaryRoot();
    let active = 0;
    let overlapped = false;
    const coordinator = new BootstrapCoordinator({
      lockTimeoutMs: 30_000,
      reconcileCredential: async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        active -= 1;
      },
    });

    const first = await coordinator.prepare({ appDataRoot, assetSource: source() });
    const secondPromise = coordinator.prepare({ appDataRoot, assetSource: source() });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    await first.release();
    const second = await secondPromise;
    await second.release();

    expect(overlapped).toBe(false);
  });

  it("releases the bootstrap lock when reconciliation fails", async () => {
    const appDataRoot = await temporaryRoot();
    const failure = await new BootstrapCoordinator({
      reconcileCredential: () => Promise.reject(new Error("reconciliation exploded")),
    }).prepare({ appDataRoot, assetSource: source() }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    // A failed boot that keeps the lock would wedge every later start.
    expect(await isDirectory(path.join(appDataRoot, RUNTIME_BOOTSTRAP_LOCK_FILENAME))).toBe(false);
  });

  it("rejects an app-data root that is not normalized and absolute", async () => {
    const appDataRoot = await temporaryRoot();
    // Built by concatenation: path.join would normalize it away before the
    // coordinator ever saw it.
    const failure = await new BootstrapCoordinator().prepare({
      appDataRoot: `${appDataRoot}${path.sep}nested${path.sep}..`,
      assetSource: source(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: ErrorCode }).code).toBe(ErrorCode.BootstrapLockTimeout);
  });
});
