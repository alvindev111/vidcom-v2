import { eq, sql } from "drizzle-orm";

import type { AbsolutePath, ClockPort, IdPort, LeaseInfo, LeasePort } from "@vidcom/core";

import type { VidcomDatabase } from "./client";
import { auditEntry, workspaceLease } from "./schema";

export const WORKSPACE_LEASE_TTL_MS = 30_000;
export const WORKSPACE_LEASE_RENEW_MS = 10_000;

/** SQLite-backed cross-process lease for one canonical workspace root. */
export class WorkspaceLease implements LeasePort {
  constructor(
    private readonly database: VidcomDatabase,
    private readonly clock: ClockPort,
    private readonly ids: IdPort,
    private readonly ttlMs = WORKSPACE_LEASE_TTL_MS,
  ) {}

  async acquire(
    workspaceRoot: AbsolutePath,
    holderId: string,
    ttlMs = this.ttlMs,
  ): Promise<{ ok: true; leaseId: string } | { ok: false; heldBy: LeaseInfo }> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const previous = (await this.database.select().from(workspaceLease)
      .where(eq(workspaceLease.workspaceRoot, workspaceRoot)).limit(1))[0];
    const leaseId = this.ids.newId("lease");
    const acquired = await this.database.all<{ leaseId: string }>(sql`
      INSERT INTO workspace_lease (workspace_root, lease_id, holder_id, acquired_at, expires_at)
      VALUES (${workspaceRoot}, ${leaseId}, ${holderId}, ${nowIso}, ${expiresAt})
      ON CONFLICT(workspace_root) DO UPDATE SET
        lease_id = excluded.lease_id,
        holder_id = excluded.holder_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE workspace_lease.expires_at < ${nowIso}
      RETURNING lease_id AS leaseId
    `);
    if (acquired.length === 0) {
      const held = previous ?? (await this.database.select().from(workspaceLease)
        .where(eq(workspaceLease.workspaceRoot, workspaceRoot)).limit(1))[0];
      if (!held) throw new Error("lease disappeared during acquisition");
      return { ok: false, heldBy: { holderId: held.holderId, expiresAt: new Date(held.expiresAt) } };
    }
    if (previous && previous.expiresAt < nowIso && previous.leaseId !== leaseId) {
      await this.database.insert(auditEntry).values({
        projectId: null,
        action: "lease.stolen",
        actor: "system",
        revisionId: null,
        jobId: null,
        protocolVersion: null,
        outcome: "ok",
        errorCode: null,
        detail: JSON.stringify({ previousHolderId: previous.holderId }),
        createdAt: nowIso,
      });
    }
    return { ok: true, leaseId };
  }

  async renew(leaseId: string): Promise<boolean> {
    const expiresAt = new Date(this.clock.now().getTime() + this.ttlMs).toISOString();
    const result = await this.database.update(workspaceLease).set({ expiresAt })
      .where(eq(workspaceLease.leaseId, leaseId)).run();
    return result.changes === 1;
  }

  async release(leaseId: string): Promise<void> {
    await this.database.delete(workspaceLease).where(eq(workspaceLease.leaseId, leaseId));
  }

  async assertHeld(leaseId: string): Promise<boolean> {
    const lease = (await this.database.select({ expiresAt: workspaceLease.expiresAt }).from(workspaceLease)
      .where(eq(workspaceLease.leaseId, leaseId)).limit(1))[0];
    return lease !== undefined && lease.expiresAt >= this.clock.now().toISOString();
  }
}
