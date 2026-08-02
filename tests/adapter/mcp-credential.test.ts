import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContentHash } from "@vidcom/contracts";
import {
  DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS,
  McpCredentialService,
  type ClockPort,
} from "@vidcom/core";
import {
  initializeDatabase,
  NodeMcpCredentialCrypto,
  SqliteMcpCredentialStore,
} from "@vidcom/adapter";

import { dbOne } from "../support/database";

let root: string;
let database: Awaited<ReturnType<typeof initializeDatabase>>;
const now = "2026-08-02T00:00:00.000Z";
const clock: ClockPort = { now: () => new Date(now) };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-mcp-credential-"));
  database = await initializeDatabase(root);
});

afterEach(async () => {
  await database.destroy();
  await rm(root, { recursive: true, force: true });
});

describe("McpCredentialService issue", () => {
  it("uses the runtime CSPRNG for distinct 32-byte secrets", () => {
    const crypto = new NodeMcpCredentialCrypto();
    const first = crypto.issue();
    const second = crypto.issue();
    expect(first.secret).not.toBe(second.secret);
    expect(Buffer.from(first.secret.slice("vcmcp_".length), "base64url")).toHaveLength(32);
    expect(first.secretHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns one 32-byte base64url bearer while SQLite stores only its canonical hash", async () => {
    const credentials = new SqliteMcpCredentialStore(database);
    const service = new McpCredentialService({
      credentials,
      crypto: new NodeMcpCredentialCrypto(() => Buffer.alloc(32, 0xa5)),
      clock,
      ids: { newId: () => "credential_primary" },
    });

    const issued = await service.issue("  Main AI host  ");

    expect(issued).toEqual({
      id: "credential_primary",
      secret: `vcmcp_${Buffer.alloc(32, 0xa5).toString("base64url")}`,
    });
    expect(issued.secret).toMatch(/^vcmcp_[A-Za-z0-9_-]{43}$/);
    const expectedHash = `sha256:${createHash("sha256").update(issued.secret).digest("hex")}`;
    expect(await credentials.read(issued.id)).toEqual({
      id: "credential_primary",
      label: "Main AI host",
      secretHash: expectedHash,
      status: "active",
      createdAt: now,
      rotatedFrom: null,
      expiresAt: null,
    });
    expect(JSON.stringify(dbOne(database, "SELECT * FROM mcp_credential WHERE id = ?", issued.id)))
      .not.toContain(issued.secret);
  });

  it("enforces the unique canonical digest and rejects an empty label", async () => {
    const credentials = new SqliteMcpCredentialStore(database);
    const crypto = new NodeMcpCredentialCrypto(() => Buffer.alloc(32, 7));
    let id = 0;
    const service = new McpCredentialService({
      credentials,
      crypto,
      clock,
      ids: { newId: (prefix) => `${prefix}_${++id}` },
    });
    await service.issue("first");
    await expect(service.issue("second")).rejects.toThrow("Failed query");
    expect(dbOne(database, "SELECT count(*) AS count FROM mcp_credential"))
      .toEqual({ count: 1 });
    await expect(service.issue("   ")).rejects.toThrow("credential label must not be empty");
  });

  it("exposes fixed-shape hashing and timing-safe canonical digest comparison", () => {
    const crypto = new NodeMcpCredentialCrypto(() => Buffer.alloc(32, 1));
    const issued = crypto.issue();
    expect(crypto.hash(issued.secret)).toBe(issued.secretHash);
    expect(crypto.hash("vcmcp_short")).toBeNull();
    expect(crypto.hash(issued.secret.replace("vcmcp_", "wrong_"))).toBeNull();
    expect(crypto.equals(issued.secretHash, issued.secretHash)).toBe(true);
    expect(crypto.equals(
      issued.secretHash,
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as ContentHash,
    )).toBe(false);
  });
});

describe("McpCredentialService verify", () => {
  it("accepts active and unexpired rotating credentials at the strict overlap boundary", async () => {
    const credentials = new SqliteMcpCredentialStore(database);
    const crypto = new NodeMcpCredentialCrypto(() => Buffer.alloc(32, 2));
    const service = new McpCredentialService({
      credentials,
      crypto,
      clock,
      ids: { newId: () => "credential_verify" },
    });
    const issued = await service.issue("verify");
    await expect(service.verify(issued.secret)).resolves.toEqual({ id: issued.id });

    database.$client.prepare(
      "UPDATE mcp_credential SET status = 'rotating', expires_at = ? WHERE id = ?",
    ).run("2026-08-02T00:00:00.001Z", issued.id);
    await expect(service.verify(issued.secret)).resolves.toEqual({ id: issued.id });

    database.$client.prepare(
      "UPDATE mcp_credential SET expires_at = ? WHERE id = ?",
    ).run(now, issued.id);
    await expect(service.verify(issued.secret)).resolves.toBeNull();
    await expect(credentials.read(issued.id)).resolves.toMatchObject({ status: "revoked", expiresAt: now });
  });

  it("uniformly rejects malformed, unknown and revoked bearers", async () => {
    const credentials = new SqliteMcpCredentialStore(database);
    const crypto = new NodeMcpCredentialCrypto(() => Buffer.alloc(32, 3));
    const service = new McpCredentialService({
      credentials,
      crypto,
      clock,
      ids: { newId: () => "credential_rejected" },
    });
    const issued = await service.issue("rejected");
    await credentials.revoke(issued.id);

    await expect(service.verify("bad")).resolves.toBeNull();
    await expect(service.verify(`vcmcp_${Buffer.alloc(32, 4).toString("base64url")}`)).resolves.toBeNull();
    await expect(service.verify(issued.secret)).resolves.toBeNull();
  });
});

describe("McpCredentialService administration", () => {
  it("rotates to a new ID with the default overlap and lists metadata without secrets", async () => {
    const credentials = new SqliteMcpCredentialStore(database);
    let entropy = 4;
    let id = 0;
    const service = new McpCredentialService({
      credentials,
      crypto: new NodeMcpCredentialCrypto(() => Buffer.alloc(32, entropy++)),
      clock,
      ids: { newId: () => `credential_${++id}` },
    });
    const original = await service.issue("host");
    const replacement = await service.rotate(original.id);

    expect(replacement.id).toBe("credential_2");
    expect(replacement.secret).not.toBe(original.secret);
    await expect(credentials.read(original.id)).resolves.toMatchObject({
      status: "rotating",
      expiresAt: new Date(new Date(now).getTime() + DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS).toISOString(),
    });
    await expect(credentials.read(replacement.id)).resolves.toMatchObject({
      status: "active",
      rotatedFrom: original.id,
    });
    const summaries = await service.list();
    expect(summaries.map(({ id: credentialId }) => credentialId))
      .toEqual([original.id, replacement.id]);
    expect(JSON.stringify(summaries)).not.toContain(original.secret);
    expect(JSON.stringify(summaries)).not.toContain(replacement.secret);
  });

  it("supports explicit overlap and immediate revocation", async () => {
    const credentials = new SqliteMcpCredentialStore(database);
    let id = 0;
    const service = new McpCredentialService({
      credentials,
      crypto: new NodeMcpCredentialCrypto(() => Buffer.alloc(32, ++id)),
      clock,
      ids: { newId: () => `credential_${id}` },
    });
    const original = await service.issue("host");
    const replacement = await service.rotate(original.id, 1_000);
    await expect(credentials.read(original.id)).resolves.toMatchObject({
      expiresAt: "2026-08-02T00:00:01.000Z",
    });
    await service.revoke(replacement.id);
    await expect(service.verify(replacement.secret)).resolves.toBeNull();
    await expect(service.revoke(replacement.id)).rejects.toThrow("credential_invalid");
  });

  it("rolls back the old status when replacement insertion violates digest uniqueness", async () => {
    const credentials = new SqliteMcpCredentialStore(database);
    const existingHash = `sha256:${"e".repeat(64)}` as ContentHash;
    await credentials.create({
      id: "credential_old",
      label: "old",
      secretHash: `sha256:${"d".repeat(64)}` as ContentHash,
      status: "active",
      createdAt: now,
      rotatedFrom: null,
      expiresAt: null,
    });
    await credentials.create({
      id: "credential_existing",
      label: "existing",
      secretHash: existingHash,
      status: "active",
      createdAt: now,
      rotatedFrom: null,
      expiresAt: null,
    });

    await expect(credentials.rotate("credential_old", {
      id: "credential_replacement",
      label: "old",
      secretHash: existingHash,
      status: "active",
      createdAt: now,
      rotatedFrom: "credential_old",
      expiresAt: null,
    }, "2026-08-02T00:05:00.000Z")).rejects.toThrow("Failed query");
    await expect(credentials.read("credential_old")).resolves.toMatchObject({
      status: "active",
      expiresAt: null,
    });
    await expect(credentials.read("credential_replacement")).resolves.toBeNull();
  });
});
