import type { ErrorCode } from "./errors";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

/** Stable project identity stored in `vidcom.json`. */
export type ProjectId = Brand<string, "ProjectId">;

/** A project-relative path that has not yet been resolved into a filesystem capability. */
export type RelPath = Brand<string, "RelPath">;

/** A sha256 content digest in the canonical `sha256:<hex>` representation. */
export type ContentHash = Brand<string, "ContentHash">;

/** Identity class responsible for a mutation or audit event. */
export type Actor = "user" | "agent" | "cli-external" | "system";

/** Event payload persisted to the outbox before delivery to connected clients. */
export interface DomainEvent {
  type: "file.changed" | "project.changed" | "job.progress" | "job.done";
  projectId: ProjectId;
  payload: Record<string, unknown>;
}

/** Predictable business failure returned by Core without transport-specific status. */
export interface DomainError {
  code: ErrorCode;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}
