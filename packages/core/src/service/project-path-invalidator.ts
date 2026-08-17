import type { ProjectId, RelPath } from "@vidcom/contracts";

import type { ProjectPathInvalidator } from "../port/ports";

/** Ordered, non-throwing fan-out for post-commit and external path invalidation. */
export class ProjectPathInvalidatorFanout implements ProjectPathInvalidator {
  constructor(
    private readonly consumers: readonly ProjectPathInvalidator[],
    private readonly onError?: (error: unknown) => void,
  ) {}

  invalidate(projectId: ProjectId, paths: readonly RelPath[]): void {
    for (const consumer of this.consumers) {
      try {
        consumer.invalidate(projectId, paths);
      } catch (error) {
        try {
          this.onError?.(error);
        } catch {
          // Observability is also best-effort at this post-commit boundary.
        }
      }
    }
  }
}
