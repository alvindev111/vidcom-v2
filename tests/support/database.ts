import type { VidcomDatabase } from "@vidcom/adapter";
import type { SQLInputValue } from "node:sqlite";

export function dbRun(database: VidcomDatabase, statement: string, ...values: SQLInputValue[]) {
  return database.$client.prepare(statement).run(...values);
}

export function dbOne<Row extends object>(
  database: VidcomDatabase,
  statement: string,
  ...values: SQLInputValue[]
): Row | undefined {
  return database.$client.prepare(statement).get(...values) as Row | undefined;
}

export function dbAll<Row extends object>(
  database: VidcomDatabase,
  statement: string,
  ...values: SQLInputValue[]
): Row[] {
  return database.$client.prepare(statement).all(...values) as Row[];
}
