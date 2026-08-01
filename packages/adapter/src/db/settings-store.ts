import { eq } from "drizzle-orm";

import type { VidcomDatabase } from "./client";
import { appSettings } from "./schema";

/** Small typed owner for daemon settings persisted in the shared Drizzle database. */
export class AppSettingsStore {
  constructor(private readonly database: VidcomDatabase, private readonly now: () => Date = () => new Date()) {}

  get(key: string): string | null {
    return this.database.select({ value: appSettings.value }).from(appSettings)
      .where(eq(appSettings.key, key)).limit(1).get()?.value ?? null;
  }

  set(key: string, value: string): void {
    const updatedAt = this.now().toISOString();
    this.database.insert(appSettings).values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } }).run();
  }
}
