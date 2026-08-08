import path from "node:path";

import {
  AtomicDirectoryLock,
  migrateDatabase,
  openVidcomDatabase,
  RuntimeAssetManager,
  type DirectoryLockLease,
  type EmbeddedRuntimeManifest,
  type RuntimeAssetSource,
  type VidcomDatabase,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";

export const RUNTIME_BOOTSTRAP_LOCK_FILENAME = "runtime-bootstrap.lock";
export const CREDENTIAL_LOCK_FILENAME = "credential.lock";

/**
 * One prepared runtime, owned by the caller until `release()`.
 *
 * `paths` is absent on purpose. Design §5.1 lists it, but `RuntimePaths` and its
 * two-mode resolver are D.3a; inventing a shape here would be the second place
 * runtime paths are decided, which is exactly what D.3a exists to prevent. D.3b
 * adds the field once the resolver is the single source.
 */
export interface PreparedRuntime {
  manifest: EmbeddedRuntimeManifest;
  versionRoot: string;
  archiveRoots: Readonly<Record<string, string>>;
  database: VidcomDatabase;
  release(): Promise<void>;
}

export interface BootstrapPrepareInput {
  appDataRoot: string;
  assetSource: RuntimeAssetSource;
  repair?: boolean;
}

/** Reconciles the bridge bearer while the credential lock is held. */
export type CredentialReconciler = (input: {
  appDataRoot: string;
  database: VidcomDatabase;
  lease: DirectoryLockLease;
}) => Promise<void>;

export interface BootstrapCoordinatorOptions {
  lockTimeoutMs?: number;
  reconcileCredential?: CredentialReconciler;
}

export class BootstrapError extends Error {
  readonly name = "BootstrapError";
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * Serializes runtime extraction, migration and credential reconciliation.
 *
 * Callers MUST NOT run migration or extraction themselves: doing so is how the
 * same database ended up migrated three times in one boot. The two locks are
 * separate so one bearer rotation cannot block an unrelated cold start, and
 * they are always taken `bootstrap → credential`. That order is a rule, not an
 * artefact of the current call sequence — reversing it anywhere introduces a
 * cycle between two locks that are otherwise independent.
 */
export class BootstrapCoordinator {
  private readonly lockTimeoutMs: number | undefined;
  private readonly reconcileCredential: CredentialReconciler | undefined;

  constructor(options: BootstrapCoordinatorOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.reconcileCredential = options.reconcileCredential;
  }

  /** Extracts, migrates once, reconciles the bearer, then hands over ownership. */
  async prepare(input: BootstrapPrepareInput): Promise<PreparedRuntime> {
    const appDataRoot = path.resolve(input.appDataRoot);
    if (appDataRoot !== input.appDataRoot || path.dirname(appDataRoot) === appDataRoot) {
      throw new BootstrapError(
        ErrorCode.BootstrapLockTimeout,
        "bootstrap app-data root must be a normalized absolute path",
        { appDataRoot: input.appDataRoot },
      );
    }

    const bootstrapLock = this.lock(appDataRoot, RUNTIME_BOOTSTRAP_LOCK_FILENAME);
    const lease = await bootstrapLock.acquire();
    let database: VidcomDatabase | undefined;
    try {
      const manager = new RuntimeAssetManager({
        appDataRoot,
        source: input.assetSource,
        lock: bootstrapLock,
      });
      const installation = input.repair === true
        ? await manager.repair({ lease })
        : await manager.ensureAll({ lease });

      database = openVidcomDatabase(appDataRoot);
      await migrateDatabase(database);

      await this.reconcile(appDataRoot, database, lease);

      const prepared = database;
      return {
        manifest: input.assetSource.readManifest(),
        versionRoot: installation.versionRoot,
        archiveRoots: installation.archiveRoots,
        database: prepared,
        release: async () => {
          try {
            await prepared.destroy();
          } finally {
            await lease.release();
          }
        },
      };
    } catch (error) {
      if (database) await database.destroy().catch(() => {});
      await lease.release().catch(() => {});
      throw error;
    }
  }

  private async reconcile(
    appDataRoot: string,
    database: VidcomDatabase,
    bootstrapLease: DirectoryLockLease,
  ): Promise<void> {
    if (!this.reconcileCredential) return;
    // Proves the bootstrap lock is still ours before taking the second one, so
    // the ordering rule is enforced rather than assumed.
    await bootstrapLease.assertHeld();
    await this.lock(appDataRoot, CREDENTIAL_LOCK_FILENAME).runExclusive(async (lease) => {
      await this.reconcileCredential?.({ appDataRoot, database, lease });
    });
  }

  private lock(appDataRoot: string, filename: string): AtomicDirectoryLock {
    return new AtomicDirectoryLock(path.join(appDataRoot, filename), {
      ...this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs },
      timeoutCode: filename === CREDENTIAL_LOCK_FILENAME
        ? ErrorCode.BridgeRotationInProgress
        : ErrorCode.BootstrapLockTimeout,
    });
  }
}
