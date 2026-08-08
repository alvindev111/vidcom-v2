import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AppSettingsStore,
  BridgeCredentialStore,
  initializeDatabase,
  NodeMcpCredentialCrypto,
  SqliteMcpCredentialStore,
  type VidcomDatabase,
} from "@vidcom/adapter";
import {
  BRIDGE_CREDENTIAL_LABEL,
  BRIDGE_CREDENTIAL_SETTING,
  BRIDGE_ROTATION_OVERLAP_MS,
  reconcileBridgeCredential,
  rotateBridgeCredential,
  assertRevocable,
  withBridgeCredentialLock,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { McpCredentialService } from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

/** A credential service over one database, for planting half-applied states. */
function service(database: VidcomDatabase): McpCredentialService {
  return new McpCredentialService({
    credentials: new SqliteMcpCredentialStore(database),
    crypto: new NodeMcpCredentialCrypto(),
    clock: { now: () => new Date() },
    ids: { newId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}` },
  });
}

const roots: string[] = [];
const databases: VidcomDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(now = new Date("2026-08-08T00:00:00.000Z")) {
  const appDataRoot = await mkdtemp(path.join(tmpdir(), "vidcom-bridge-"));
  roots.push(appDataRoot);
  const database = await initializeDatabase(appDataRoot);
  databases.push(database);
  let current = now;
  return {
    appDataRoot,
    database,
    clock: () => current,
    advance: (ms: number) => { current = new Date(current.getTime() + ms); },
    dependencies: { appDataRoot, database, clock: () => current },
    settings: new AppSettingsStore(database, () => current),
    credentials: new SqliteMcpCredentialStore(database),
    store: new BridgeCredentialStore(appDataRoot),
  };
}

describe("bridge credential reconciliation", () => {
  it("mints a bearer on the first boot and records only its id", async () => {
    const value = await fixture();
    const result = await reconcileBridgeCredential(value.dependencies);

    expect(result.outcome).toBe("minted");
    expect(value.settings.get(BRIDGE_CREDENTIAL_SETTING)).toBe(result.credentialId);
    const record = await value.credentials.read(result.credentialId);
    expect(record?.label).toBe(BRIDGE_CREDENTIAL_LABEL);
    expect(record?.status).toBe("active");

    // The database stores a hash; the secret itself lives only in the file.
    const secret = await value.store.read();
    expect(secret.length).toBeGreaterThan(0);
    expect(record?.secretHash).not.toContain(secret);
    expect(await readFile(path.join(value.appDataRoot, "credentials"), "utf8")).toBe(secret);
  });

  it("is a no-op on a boot that follows a clean one", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    const secret = await value.store.read();

    const second = await reconcileBridgeCredential(value.dependencies);
    expect(second.outcome).toBe("consistent");
    expect(second.credentialId).toBe(first.credentialId);
    expect(await value.store.read()).toBe(secret);
  });

  it("rolls forward when the crash landed between the file write and the settings update", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    // Rotate fully, then rewind the setting: that is exactly the state a crash
    // after step 2 leaves behind.
    const rotated = await rotateBridgeCredential(value.dependencies);
    value.settings.set(BRIDGE_CREDENTIAL_SETTING, first.credentialId);

    const result = await reconcileBridgeCredential(value.dependencies);
    expect(result.outcome).toBe("rolled_forward");
    expect(result.credentialId).toBe(rotated.id);
    expect(value.settings.get(BRIDGE_CREDENTIAL_SETTING)).toBe(rotated.id);
  });

  it("revokes the orphan and reissues when the crash landed before the file was written", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    const secret = await value.store.read();

    // Commit the rotation in the database only: the replacement's secret was
    // never written anywhere, so it is unrecoverable.
    const orphan = await new SqliteMcpCredentialStore(value.database);
    const crypto = new NodeMcpCredentialCrypto();
    const issued = crypto.issue();
    await orphan.rotate(first.credentialId, {
      id: "credential_orphan",
      label: BRIDGE_CREDENTIAL_LABEL,
      secretHash: issued.secretHash,
      status: "active",
      createdAt: value.clock().toISOString(),
      rotatedFrom: first.credentialId,
      expiresAt: null,
    }, new Date(value.clock().getTime() + BRIDGE_ROTATION_OVERLAP_MS).toISOString());

    const result = await reconcileBridgeCredential(value.dependencies);
    expect(result.outcome).toBe("reissued_after_orphan");
    expect(result.revokedIds).toContain("credential_orphan");
    expect((await value.credentials.read("credential_orphan"))?.status).toBe("revoked");
    // A usable bearer is the point: the file must hold a new, different secret.
    const reissued = await value.store.read();
    expect(reissued).not.toBe(secret);
    expect(value.settings.get(BRIDGE_CREDENTIAL_SETTING)).toBe(result.credentialId);
  });

  it("mints again when the restart happens after the overlap expires", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    const crypto = new NodeMcpCredentialCrypto();
    const issued = crypto.issue();
    await value.credentials.rotate(first.credentialId, {
      id: "credential_late",
      label: BRIDGE_CREDENTIAL_LABEL,
      secretHash: issued.secretHash,
      status: "active",
      createdAt: value.clock().toISOString(),
      rotatedFrom: first.credentialId,
      expiresAt: null,
    }, new Date(value.clock().getTime() + BRIDGE_ROTATION_OVERLAP_MS).toISOString());
    value.advance(BRIDGE_ROTATION_OVERLAP_MS + 1_000);

    const result = await reconcileBridgeCredential(value.dependencies);
    expect(result.outcome).toBe("minted");
    expect(result.credentialId).not.toBe(first.credentialId);
  });

  it("mints when the credential file has been deleted", async () => {
    const value = await fixture();
    await reconcileBridgeCredential(value.dependencies);
    await rm(path.join(value.appDataRoot, "credentials"));

    const result = await reconcileBridgeCredential(value.dependencies);
    expect(result.outcome).toBe("minted");
    expect((await value.store.read()).length).toBeGreaterThan(0);
  });

  it("mints when the file holds a secret no usable row matches", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    await value.credentials.revoke(first.credentialId);
    await writeFile(path.join(value.appDataRoot, "credentials"), "not-a-known-secret", "utf8");

    const result = await reconcileBridgeCredential(value.dependencies);
    expect(result.outcome).toBe("minted");
    expect(result.credentialId).not.toBe(first.credentialId);
  });

  it("leaves at most one active bridge credential behind", async () => {
    const value = await fixture();
    const crypto = new NodeMcpCredentialCrypto();
    for (const id of ["credential_stale_a", "credential_stale_b"]) {
      await value.credentials.create({
        id,
        label: BRIDGE_CREDENTIAL_LABEL,
        secretHash: crypto.issue().secretHash,
        status: "active",
        createdAt: value.clock().toISOString(),
        rotatedFrom: null,
        expiresAt: null,
      });
    }

    const result = await reconcileBridgeCredential(value.dependencies);
    const active = (await value.credentials.list())
      .filter((record) => record.label === BRIDGE_CREDENTIAL_LABEL && record.status === "active");
    expect(active.map((record) => record.id)).toEqual([result.credentialId]);
  });
});

describe("bridge credential rotation", () => {
  it("writes database, file and settings in order and revokes attachments last", async () => {
    const value = await fixture();
    await reconcileBridgeCredential(value.dependencies);
    const before = await value.store.read();
    const order: string[] = [];

    const rotated = await rotateBridgeCredential(value.dependencies, async (credentialId) => {
      order.push(`revoke:${credentialId}`);
      // By the time attachments are revoked the new bearer is already the one
      // on disk and in settings, so a client that reconnects here succeeds.
      expect(await value.store.read()).not.toBe(before);
      expect(value.settings.get(BRIDGE_CREDENTIAL_SETTING)).toBe(credentialId);
    });

    expect(order).toEqual([`revoke:${rotated.id}`]);
    expect(await value.store.read()).not.toBe(before);
  });

  it("keeps the previous bearer usable for the overlap rather than cutting it off", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    await rotateBridgeCredential(value.dependencies);

    const previous = await value.credentials.read(first.credentialId);
    expect(previous?.status).toBe("rotating");
    expect(Date.parse(previous?.expiresAt ?? ""))
      .toBe(value.clock().getTime() + BRIDGE_ROTATION_OVERLAP_MS);
  });

  it("refuses to rotate before a bearer exists", async () => {
    const value = await fixture();
    await expect(rotateBridgeCredential(value.dependencies)).rejects.toThrow(/no bridge credential/u);
  });

  it("serializes two concurrent rotations instead of interleaving them", async () => {
    const value = await fixture();
    await reconcileBridgeCredential(value.dependencies);
    let active = 0;
    let overlapped = false;

    const rotate = () => withBridgeCredentialLock(value.appDataRoot, async () => {
      active += 1;
      if (active > 1) overlapped = true;
      const result = await rotateBridgeCredential(value.dependencies);
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      active -= 1;
      return result;
    }, { timeoutMs: 30_000 });

    const [first, second] = await Promise.all([rotate(), rotate()]);

    expect(overlapped).toBe(false);
    expect(first.id).not.toBe(second.id);
    // The file and the pointer describe the same credential, and it is the one
    // that finished last. A half-applied interleave would break exactly this.
    const settled = value.settings.get(BRIDGE_CREDENTIAL_SETTING);
    const secret = await value.store.read();
    const record = await value.credentials.read(settled ?? "");
    expect(record?.status).toBe("active");
    expect(new NodeMcpCredentialCrypto().hash(secret)).toBe(record?.secretHash);
  });

  it("reports bridge_rotation_in_progress to a waiter that gives up", async () => {
    const value = await fixture();
    await reconcileBridgeCredential(value.dependencies);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });

    const holder = withBridgeCredentialLock(value.appDataRoot, async () => { await held; });
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    const failure = await withBridgeCredentialLock<unknown>(
      value.appDataRoot,
      () => Promise.resolve("unreachable"),
      { timeoutMs: 300 },
    ).catch((error: unknown) => error);
    expect((failure as { code?: ErrorCode }).code).toBe(ErrorCode.BridgeRotationInProgress);

    release();
    await holder;
  });

  it("blocks boot reconciliation from repairing a rotation that is still running", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });

    // A rotation deliberately stopped between its database commit and its file
    // write. Reconciliation would read that as an orphaned replacement and
    // "repair" a state that is mid-change on purpose.
    const rotation = withBridgeCredentialLock(value.appDataRoot, async () => {
      await service(value.database).rotate(first.credentialId, BRIDGE_ROTATION_OVERLAP_MS);
      await held;
    });
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    const blocked = await withBridgeCredentialLock<unknown>(
      value.appDataRoot,
      () => reconcileBridgeCredential(value.dependencies),
      { timeoutMs: 300 },
    ).catch((error: unknown) => error);
    expect((blocked as { code?: ErrorCode }).code).toBe(ErrorCode.BridgeRotationInProgress);

    release();
    await rotation;
  });

  it("refuses to revoke the bridge bearer and allows revoking any other", async () => {
    const value = await fixture();
    const first = await reconcileBridgeCredential(value.dependencies);
    await expect(assertRevocable(value.dependencies, first.credentialId))
      .rejects.toThrow(/cannot be revoked/u);
    await expect(assertRevocable(value.dependencies, "credential_other")).resolves.toBeUndefined();
  });
});
