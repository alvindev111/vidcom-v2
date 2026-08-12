import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  migrateDatabase,
  readPublishedRuntimeInstallation,
  type RuntimeAssetSource,
} from "@vidcom/adapter";
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
  HOST_TAG,
  productRuntimeFixtureEntries,
  runtimeManifest,
} from "../support/runtime-fixture";

const ARCHIVE_KEY = "node";
const BODY = Buffer.from("vidcom runtime fixture\n", "utf8");
const PACKAGED_BOOT = {
  path: "cli/boot.cjs",
  content: Buffer.from("module.exports = {};\n"),
};
const PACKAGED_BGM = [
  "alex-morgan-corporate-business-background.mp3",
  "corporate-marimba-business-background.mp3",
  "meta.mp3",
  "promo-promo-business-background.mp3",
].map((entry) => ({ path: entry, content: Buffer.from(`fixture ${entry}\n`) }));
const MIGRATIONS_SOURCE = new URL("../../packages/adapter/drizzle/", import.meta.url);
const SHIPPED_MIGRATIONS = readdirSync(MIGRATIONS_SOURCE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()
    && existsSync(new URL(`${entry.name}/migration.sql`, MIGRATIONS_SOURCE)))
  .sort((left, right) => left.name.localeCompare(right.name, "en"))
  .map((entry) => ({
    path: path.posix.join("drizzle", entry.name, "migration.sql"),
    content: readFileSync(new URL(`${entry.name}/migration.sql`, MIGRATIONS_SOURCE)),
  }));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-bootstrap-")));
  roots.push(root);
  return root;
}

function hyperframesArchive() {
  const product = productRuntimeFixtureEntries();
  return archiveFor(
    "hyperframes",
    [...product.hyperframes, ...product.native],
    HOST_TAG,
    "hyperframes-runtime",
  );
}

function source(): RuntimeAssetSource {
  const product = productRuntimeFixtureEntries(SHIPPED_MIGRATIONS);
  const node = archiveFor(ARCHIVE_KEY, [
    PACKAGED_BOOT,
    { path: "runtime.txt", content: BODY },
    ...product.node,
    ...product.native,
  ], HOST_TAG, "node-runtime");
  const hyperframes = hyperframesArchive();
  const bgm = archiveFor("bgm", PACKAGED_BGM, HOST_TAG, "bgm-runtime");
  return assetSource(runtimeManifest("1.0.0", [bgm.archive, node.archive, hyperframes.archive]), {
    bgm: bgm.bytes,
    [ARCHIVE_KEY]: node.bytes,
    hyperframes: hyperframes.bytes,
  });
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

  it.skipIf(process.platform === "win32")(
    "secures a permissive warm app-data root before reading runtime metadata or taking a lock",
    async () => {
      const appDataRoot = await temporaryRoot();
      const first = await new BootstrapCoordinator().prepare({
        appDataRoot,
        assetSource: source(),
      });
      await first.release();
      await chmod(appDataRoot, 0o777);

      const delegate = source();
      const observedModes: number[] = [];
      const guardedSource: RuntimeAssetSource = {
        readManifest() {
          observedModes.push(statSync(appDataRoot).mode & 0o777);
          return delegate.readManifest();
        },
        readArchive(key) {
          return delegate.readArchive(key);
        },
      };
      const prepared = await new BootstrapCoordinator().prepare({
        appDataRoot,
        assetSource: guardedSource,
      });
      try {
        expect(observedModes.length).toBeGreaterThan(0);
        expect(observedModes.every((value) => value === 0o700)).toBe(true);
        expect(statSync(appDataRoot).mode & 0o777).toBe(0o700);
      } finally {
        await prepared.release();
      }
    },
  );

  it("runs the real migration exactly once across bootstrap, selection and foundation", async () => {
    const root = await temporaryRoot();
    const appDataRoot = path.join(root, "app-data");
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot);
    let migrationCalls = 0;
    const countedMigration: typeof migrateDatabase = async (database, migrationsFolder) => {
      migrationCalls += 1;
      await migrateDatabase(database, migrationsFolder);
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

  it("migrates from the extracted node archive after the build source is unavailable", async () => {
    const root = await temporaryRoot();
    const appDataRoot = path.join(root, "app-data");
    const buildSource = path.join(root, "build-source-drizzle");
    for (const migration of SHIPPED_MIGRATIONS) {
      const buildMigration = path.join(buildSource, ...migration.path.split("/").slice(1));
      await mkdir(path.dirname(buildMigration), { recursive: true });
      await writeFile(buildMigration, migration.content);
    }
    const buildMigrations = await Promise.all(SHIPPED_MIGRATIONS.map(async (migration) => ({
      path: migration.path,
      content: await readFile(path.join(buildSource, ...migration.path.split("/").slice(1))),
    })));
    const product = productRuntimeFixtureEntries(buildMigrations);

    const { bytes, archive } = archiveFor(
      ARCHIVE_KEY,
      [
        PACKAGED_BOOT,
        { path: "runtime.txt", content: BODY },
        ...product.node,
        ...product.native,
      ],
      HOST_TAG,
      "node-runtime",
    );
    await rm(buildSource, { recursive: true });
    expect(await isDirectory(buildSource)).toBe(false);

    let migrationCalls = 0;
    let observedMigrationsFolder: string | undefined;
    const artifactMigration: typeof migrateDatabase = async (database, migrationsFolder) => {
      migrationCalls += 1;
      if (!migrationsFolder) throw new Error("artifact migration folder was not provided");
      observedMigrationsFolder = migrationsFolder;
      await migrateDatabase(database, migrationsFolder);
    };
    const hyperframes = hyperframesArchive();
    const bgm = archiveFor("bgm", PACKAGED_BGM, HOST_TAG, "bgm-runtime");
    const prepared = await new BootstrapCoordinator({ migrate: artifactMigration }).prepare({
      appDataRoot,
      assetSource: assetSource(runtimeManifest("1.0.1", [bgm.archive, archive, hyperframes.archive]), {
        bgm: bgm.bytes,
        [ARCHIVE_KEY]: bytes,
        hyperframes: hyperframes.bytes,
      }),
    });
    try {
      const extractedMigrations = path.join(
        appDataRoot,
        "native",
        "1.0.1",
        "node-runtime",
        "drizzle",
      );
      expect(observedMigrationsFolder).toBe(extractedMigrations);
      expect(await isDirectory(extractedMigrations)).toBe(true);
      expect(prepared.database.$client.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
      ).get()).toBeDefined();
      expect(prepared.database.$client.prepare(
        "SELECT count(*) AS count FROM __drizzle_migrations",
      ).get()).toEqual({ count: SHIPPED_MIGRATIONS.length });
      expect(migrationCalls).toBe(1);
    } finally {
      await prepared.release();
    }
  });

  it("rejects an incomplete product toolchain before publication or migration", async () => {
    const appDataRoot = await temporaryRoot();
    const good = await new BootstrapCoordinator().prepare({
      appDataRoot,
      assetSource: source(),
    });
    await good.release();

    const completeNode = productRuntimeFixtureEntries(SHIPPED_MIGRATIONS);
    const nodeOnly = archiveFor(ARCHIVE_KEY, [
      PACKAGED_BOOT,
      { path: "runtime.txt", content: BODY },
      ...completeNode.node,
      ...completeNode.native,
    ], HOST_TAG, "node-runtime");
    let invalidMigrationCalls = 0;
    const invalidMigration: typeof migrateDatabase = async (database, migrationsFolder) => {
      invalidMigrationCalls += 1;
      await migrateDatabase(database, migrationsFolder);
    };

    await expect(new BootstrapCoordinator({ migrate: invalidMigration }).prepare({
      appDataRoot,
      assetSource: assetSource(runtimeManifest("2.0.0", [nodeOnly.archive]), {
        [ARCHIVE_KEY]: nodeOnly.bytes,
      }),
    })).rejects.toMatchObject({ code: ErrorCode.RuntimeManifestInvalid });

    const incompleteNode = productRuntimeFixtureEntries();
    const nodeWithoutMigrations = archiveFor(ARCHIVE_KEY, [
      PACKAGED_BOOT,
      { path: "runtime.txt", content: BODY },
      ...incompleteNode.node,
      ...incompleteNode.native,
    ], HOST_TAG, "node-runtime");
    const hyperframes = hyperframesArchive();
    await expect(new BootstrapCoordinator({ migrate: invalidMigration }).prepare({
      appDataRoot,
      assetSource: assetSource(runtimeManifest(
        "3.0.0",
        [nodeWithoutMigrations.archive, hyperframes.archive],
      ), {
        [ARCHIVE_KEY]: nodeWithoutMigrations.bytes,
        hyperframes: hyperframes.bytes,
      }),
    })).rejects.toMatchObject({ code: ErrorCode.RuntimeManifestInvalid });

    expect(invalidMigrationCalls).toBe(0);
    expect(await isDirectory(path.join(appDataRoot, "native", "2.0.0"))).toBe(false);
    expect(await isDirectory(path.join(appDataRoot, "native", "3.0.0"))).toBe(false);
    const published = await readPublishedRuntimeInstallation(appDataRoot);
    expect(published?.manifest.artifactVersion).toBe("1.0.0");
    expect(published?.versionRoot).toBe(path.join(appDataRoot, "native", "1.0.0"));
    expect(published?.archiveRoots).toMatchObject({
      node: path.join(appDataRoot, "native", "1.0.0", "node-runtime"),
      hyperframes: path.join(appDataRoot, "native", "1.0.0", "hyperframes-runtime"),
    });
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
