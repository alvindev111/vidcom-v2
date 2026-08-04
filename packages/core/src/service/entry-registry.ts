import type { AbsolutePath } from "../domain/models";
import type { IdPort } from "../port/ports";

export type EntryId = string & { readonly __brand: "EntryId" };

export interface EntryRegistration {
  workspaceRoot: AbsolutePath;
  slug: string;
  root: AbsolutePath;
}

/** Session-scoped recovery identity for folders whose durable identity cannot be read. */
export class EntryRegistry {
  private readonly byId = new Map<EntryId, EntryRegistration>();
  private readonly byLocation = new Map<string, EntryId>();

  constructor(private readonly ids: IdPort) {}

  mint(workspaceRoot: AbsolutePath, slug: string, root: AbsolutePath): EntryId {
    const key = `${workspaceRoot}\0${slug}`;
    const existing = this.byLocation.get(key);
    if (existing) return existing;
    const id = this.ids.newId("entry") as EntryId;
    this.byLocation.set(key, id);
    this.byId.set(id, { workspaceRoot, slug, root });
    return id;
  }

  resolve(id: EntryId): EntryRegistration | null {
    return this.byId.get(id) ?? null;
  }

  revoke(id: EntryId): void {
    const registration = this.byId.get(id);
    if (!registration) return;
    this.byId.delete(id);
    this.byLocation.delete(`${registration.workspaceRoot}\0${registration.slug}`);
  }

  relocate(id: EntryId, slug: string, root: AbsolutePath): boolean {
    const registration = this.byId.get(id);
    if (!registration) return false;
    this.byLocation.delete(`${registration.workspaceRoot}\0${registration.slug}`);
    const next = { ...registration, slug, root };
    this.byId.set(id, next);
    this.byLocation.set(`${next.workspaceRoot}\0${next.slug}`, id);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.byLocation.clear();
  }
}
