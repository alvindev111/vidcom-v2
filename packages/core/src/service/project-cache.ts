import type { DomainEvent, ProjectId } from "@vidcom/contracts";

import type { CompositionModel } from "../domain/models";

/** Shared promise cache for parsed composition models with event invalidation and bounded LRU. */
export class ProjectCache {
  private readonly entries = new Map<ProjectId, Promise<CompositionModel>>();

  constructor(private readonly limit = 20) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("cache limit must be positive");
  }

  get(projectId: ProjectId, load: () => Promise<CompositionModel>): Promise<CompositionModel> {
    const hit = this.entries.get(projectId);
    if (hit) {
      this.entries.delete(projectId);
      this.entries.set(projectId, hit);
      return hit;
    }
    const pending = load();
    this.entries.set(projectId, pending);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    pending.catch(() => {
      if (this.entries.get(projectId) === pending) this.entries.delete(projectId);
    });
    return pending;
  }

  invalidate(projectId: ProjectId): void {
    this.entries.delete(projectId);
  }

  handleEvent(event: DomainEvent): void {
    if (event.type === "file.changed" || event.type === "project.changed") this.invalidate(event.projectId);
  }

  get size(): number {
    return this.entries.size;
  }
}
