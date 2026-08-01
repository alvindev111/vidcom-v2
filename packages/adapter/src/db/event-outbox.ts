import { asc, gt, lt, max, sql } from "drizzle-orm";

import type { DomainEvent, ProjectId } from "@vidcom/contracts";
import type { ClockPort, EventOutboxPort, StoredEvent } from "@vidcom/core";

import type { VidcomDatabase } from "./client";
import { eventOutbox } from "./schema";

export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const EVENT_RETENTION_ROWS = 5_000;

/** Durable event stream with independent sequence and bounded retention. */
export class SqliteEventOutbox implements EventOutboxPort {
  constructor(private readonly database: VidcomDatabase, private readonly clock: ClockPort) {}

  async append(event: DomainEvent): Promise<number> {
    const now = this.clock.now();
    return this.database.transaction((transaction) => {
      const row = transaction.insert(eventOutbox).values({
        type: event.type,
        projectId: event.projectId,
        payload: JSON.stringify(event.payload),
        createdAt: now.toISOString(),
      }).returning({ seq: eventOutbox.seq }).get();
      const cutoff = new Date(now.getTime() - EVENT_RETENTION_MS).toISOString();
      transaction.delete(eventOutbox).where(lt(eventOutbox.createdAt, cutoff)).run();
      transaction.run(sql`
        DELETE FROM event_outbox
        WHERE seq <= (SELECT COALESCE(MAX(seq), 0) - ${EVENT_RETENTION_ROWS} FROM event_outbox)
      `);
      return row.seq;
    });
  }

  async readFrom(seq: number, limit: number): Promise<{ events: StoredEvent[]; gap: boolean }> {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const earliest = this.database.select({ seq: eventOutbox.seq }).from(eventOutbox)
      .orderBy(asc(eventOutbox.seq)).limit(1).get();
    const gap = seq > 0 && earliest !== undefined && seq < earliest.seq - 1;
    const rows = this.database.select().from(eventOutbox).where(gt(eventOutbox.seq, seq))
      .orderBy(asc(eventOutbox.seq)).limit(boundedLimit).all();
    return {
      gap,
      events: rows.map((row) => ({
        seq: row.seq,
        type: row.type,
        projectId: row.projectId as ProjectId,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      })),
    };
  }

  async latestSeq(): Promise<number> {
    return this.database.select({ latest: max(eventOutbox.seq) }).from(eventOutbox).get()?.latest ?? 0;
  }
}
