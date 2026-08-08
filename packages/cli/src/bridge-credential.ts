import { randomUUID } from "node:crypto";

import {
  AppSettingsStore,
  BridgeCredentialStore,
  NodeMcpCredentialCrypto,
  SqliteMcpCredentialStore,
  type VidcomDatabase,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import { McpCredentialService, type McpCredentialRecord } from "@vidcom/core";

export const BRIDGE_CREDENTIAL_LABEL = "system:bridge";
export const BRIDGE_CREDENTIAL_SETTING = "bridge_credential_id";
/**
 * Overlap for a bridge rotation.
 *
 * Zero would leave a window between the database commit and the file rename in
 * which a client has already spent its one re-read and has nothing valid to
 * present. Sixty seconds is long enough for a client to notice and reconnect.
 */
export const BRIDGE_ROTATION_OVERLAP_MS = 60_000;

/** Why reconciliation acted, so a boot that changed the bearer can say so. */
export type BridgeReconcileOutcome =
  | "consistent"
  | "rolled_forward"
  | "reissued_after_orphan"
  | "minted";

export interface BridgeReconcileResult {
  outcome: BridgeReconcileOutcome;
  credentialId: string;
  revokedIds: readonly string[];
}

export interface BridgeCredentialDependencies {
  appDataRoot: string;
  database: VidcomDatabase;
  clock?: () => Date;
  newId?: (prefix: string) => string;
}

export class BridgeCredentialError extends Error {
  readonly name = "BridgeCredentialError";
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

function service(dependencies: BridgeCredentialDependencies): McpCredentialService {
  const clock = dependencies.clock ?? (() => new Date());
  return new McpCredentialService({
    credentials: new SqliteMcpCredentialStore(dependencies.database),
    crypto: new NodeMcpCredentialCrypto(),
    clock: { now: clock },
    ids: {
      // Not derived from the clock: an injected clock can stand still, and two
      // rotations in the same instant would then collide on the primary key.
      newId: dependencies.newId ?? ((prefix: string) => `${prefix}_${randomUUID()}`),
    },
    config: { rotationOverlapMs: BRIDGE_ROTATION_OVERLAP_MS },
  });
}

/**
 * Reconciles the bridge bearer against the four states of §4.4.
 *
 * The invariant is that the credential **file** is the only secret and the
 * database and settings are projections of it. Every branch below is a crash
 * that landed between two of the four rotation steps, and each one has to end
 * with a bridge a client can still connect to.
 *
 * The caller MUST already hold `credential.lock`; this reads and writes the one
 * secret without taking a lock of its own.
 */
export async function reconcileBridgeCredential(
  dependencies: BridgeCredentialDependencies,
): Promise<BridgeReconcileResult> {
  const store = new BridgeCredentialStore(dependencies.appDataRoot);
  const settings = new AppSettingsStore(dependencies.database, dependencies.clock);
  const credentials = new SqliteMcpCredentialStore(dependencies.database);
  const crypto = new NodeMcpCredentialCrypto();
  const lifecycle = service(dependencies);

  const secret = await store.read().catch(() => null);
  const secretHash = secret === null ? null : crypto.hash(secret);
  const recorded = settings.get(BRIDGE_CREDENTIAL_SETTING);
  const all = await credentials.list();
  const matching = secretHash === null
    ? undefined
    : all.find((record) => crypto.equals(secretHash, record.secretHash));

  const result = await resolve({
    matching,
    recorded,
    all,
    lifecycle,
    store,
    now: (dependencies.clock ?? (() => new Date()))(),
  });
  settings.set(BRIDGE_CREDENTIAL_SETTING, result.credentialId);

  // A crash leaves behind an active credential nobody can present. Left alone,
  // every crash adds one and `credential list` slowly fills with them.
  const stale = (await credentials.list()).filter((record) =>
    record.label === BRIDGE_CREDENTIAL_LABEL
    && record.status === "active"
    && record.id !== result.credentialId);
  for (const record of stale) await credentials.revoke(record.id);

  return { ...result, revokedIds: [...result.revokedIds, ...stale.map((record) => record.id)] };
}

async function resolve(input: {
  matching: McpCredentialRecord | undefined;
  recorded: string | null;
  all: readonly McpCredentialRecord[];
  lifecycle: McpCredentialService;
  store: BridgeCredentialStore;
  now: Date;
}): Promise<Omit<BridgeReconcileResult, "revokedIds"> & { revokedIds: readonly string[] }> {
  const { matching, recorded, all, lifecycle, store, now } = input;

  if (matching?.status === "active") {
    // Died after writing the file but before updating settings: the file is
    // authoritative, so the setting follows it rather than the other way round.
    return {
      outcome: matching.id === recorded ? "consistent" : "rolled_forward",
      credentialId: matching.id,
      revokedIds: [],
    };
  }

  if (matching?.status === "rotating" && Date.parse(matching.expiresAt ?? "") > now.getTime()) {
    const orphan = all.find((record) =>
      record.rotatedFrom === matching.id && record.status === "active");
    if (orphan) {
      // Died after the database commit but before the file was written, so the
      // replacement's secret was never persisted anywhere and is unrecoverable.
      await lifecycle.revoke(orphan.id);
      // Design §4.4 calls this "rotate again from the credential in the file",
      // but the file's credential is `rotating`, and `rotate` only accepts an
      // active one. Issuing instead reaches the same end state: the file holds a
      // usable secret, and the old one stays valid for the rest of its overlap
      // rather than being cut off, which is what the overlap is for.
      const reissued = await lifecycle.issue(BRIDGE_CREDENTIAL_LABEL);
      await store.write(reissued.secret);
      return { outcome: "reissued_after_orphan", credentialId: reissued.id, revokedIds: [orphan.id] };
    }
  }

  // Restarted past the overlap, the file was deleted, or its hash matches
  // nothing usable. Nothing on disk can be recovered, so issue a new bearer.
  const minted = await lifecycle.issue(BRIDGE_CREDENTIAL_LABEL);
  await store.write(minted.secret);
  return { outcome: "minted", credentialId: minted.id, revokedIds: [] };
}

/**
 * Rotates the bridge bearer in the four-step order the recovery table assumes.
 *
 * Database first, then the file, then settings, then attachment revocation.
 * Any other order produces a state reconciliation cannot classify.
 */
export async function rotateBridgeCredential(
  dependencies: BridgeCredentialDependencies,
  revokeAttachments?: (credentialId: string) => Promise<void>,
): Promise<{ id: string }> {
  const settings = new AppSettingsStore(dependencies.database, dependencies.clock);
  const recorded = settings.get(BRIDGE_CREDENTIAL_SETTING);
  if (!recorded) {
    throw new BridgeCredentialError(
      ErrorCode.CredentialInvalid,
      "no bridge credential has been minted yet",
    );
  }
  const rotated = await service(dependencies).rotate(recorded, BRIDGE_ROTATION_OVERLAP_MS);
  await new BridgeCredentialStore(dependencies.appDataRoot).write(rotated.secret);
  settings.set(BRIDGE_CREDENTIAL_SETTING, rotated.id);
  await revokeAttachments?.(rotated.id);
  return { id: rotated.id };
}

/** Refuses to revoke the bridge bearer, which would leave the daemon unreachable. */
export async function assertRevocable(
  dependencies: BridgeCredentialDependencies,
  credentialId: string,
): Promise<void> {
  const recorded = new AppSettingsStore(dependencies.database, dependencies.clock)
    .get(BRIDGE_CREDENTIAL_SETTING);
  if (recorded === credentialId) {
    throw new BridgeCredentialError(
      ErrorCode.CredentialInvalid,
      "the bridge credential cannot be revoked; rotate it instead",
    );
  }
}
