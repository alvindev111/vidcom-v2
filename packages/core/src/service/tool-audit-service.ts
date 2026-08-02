import type { Era, ProjectId, ToolLevel } from "@vidcom/contracts";

import type { ClockPort, CompositeMutationJournalPort, LogPort, MetricPort, ToolAuditPort } from "../port/ports";
import type { PendingToolAudit, ToolAuditEntry } from "../port/types";
import { canonicalizeJson } from "./canonical-json";

export const AUDIT_REDACTED = "[REDACTED]";
export const AUDIT_ABSOLUTE_PATH_REDACTED = "[REDACTED_ABSOLUTE_PATH]";

const PRIVATE_DETAIL_KEYS = new Set([
  "authorization",
  "body",
  "content",
  "cookie",
  "filecontent",
  "password",
  "prompt",
  "raw",
  "rawcontent",
  "script",
  "secret",
  "text",
  "token",
]);

function normalizedKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function isPrivateDetailKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (normalized === "credentialid") return false;
  return PRIVATE_DETAIL_KEYS.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("apikey");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("\\\\")
    || /^[A-Za-z]:[\\/]/u.test(value);
}

function redactValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return isAbsolutePath(value) ? AUDIT_ABSOLUTE_PATH_REDACTED : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("audit detail numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (typeof value !== "object") throw new TypeError("audit detail must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("audit detail must not be circular");

  seen.add(value);
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    redacted[key] = isPrivateDetailKey(key) ? AUDIT_REDACTED : redactValue(item, seen);
  }
  seen.delete(value);
  return redacted;
}

/** Removes secrets, raw authored content and absolute filesystem paths from audit detail. */
export function redactAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return redactValue(detail, new Set()) as Record<string, unknown>;
}

function isEra(value: unknown): value is Era {
  return value === "legacy" || value === "modern";
}

function isToolLevel(value: unknown): value is ToolLevel {
  return value === "read" || value === "write" || value === "job" || value === "destructive";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

/** Validates a versioned pending audit and reapplies redaction at its persistence boundary. */
export function normalizePendingToolAudit(value: unknown): PendingToolAudit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pending tool audit must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new TypeError("unsupported pending tool audit schema version");
  if (!isToolLevel(input.level)) throw new TypeError("pending tool audit level is invalid");
  if (!isEra(input.era)) throw new TypeError("pending tool audit era is invalid");
  if (input.projectId !== null && (typeof input.projectId !== "string" || input.projectId.length === 0)) {
    throw new TypeError("pending tool audit projectId is invalid");
  }
  if (input.credentialId !== null && (typeof input.credentialId !== "string" || input.credentialId.length === 0)) {
    throw new TypeError("pending tool audit credentialId is invalid");
  }
  if (input.detail === null || typeof input.detail !== "object" || Array.isArray(input.detail)) {
    throw new TypeError("pending tool audit detail must be an object");
  }

  return {
    schemaVersion: 1,
    invocationId: requiredString(input.invocationId, "invocationId"),
    tool: requiredString(input.tool, "tool"),
    level: input.level,
    projectId: input.projectId as ProjectId | null,
    era: input.era,
    protocolVersion: requiredString(input.protocolVersion, "protocolVersion"),
    detail: redactAuditDetail(input.detail as Record<string, unknown>),
    credentialId: input.credentialId as string | null,
    invokedAt: requiredString(input.invokedAt, "invokedAt"),
  };
}

/** Produces the only durable JSON representation of pending MCP audit context. */
export function serializePendingToolAudit(value: PendingToolAudit): string {
  return canonicalizeJson(normalizePendingToolAudit(value));
}

/** Parses and validates durable pending audit JSON before terminal ownership uses it. */
export function parsePendingToolAudit(serialized: string): PendingToolAudit {
  return normalizePendingToolAudit(JSON.parse(serialized) as unknown);
}

type PendingAuditInput = Omit<ToolAuditEntry, "outcome" | "errorCode"> & {
  invocationId: string;
  invokedAt: string;
};

export type AuditFailureOwnership = "journal_owned" | "caller_recorded" | "unknown";
export type AuditOwnership = "journal_owned" | "caller_owned" | "unknown";

/** Applies MCP audit retry and escalation policy without coupling Core to SQLite or a logger SDK. */
export class ToolAuditService {
  constructor(
    private readonly repository: ToolAuditPort,
    private readonly clock: ClockPort,
    private readonly logger: LogPort,
    private readonly metrics: MetricPort,
    private readonly ownership: Pick<CompositeMutationJournalPort, "isJournalOwned">,
  ) {}

  /** Creates the exact redacted, schema-versioned context to persist at T1. */
  prepareWrite(entry: PendingAuditInput): PendingToolAudit {
    return normalizePendingToolAudit({
      schemaVersion: 1,
      ...entry,
      detail: redactAuditDetail(entry.detail),
    });
  }

  /** Records a terminal read invocation fail-open, warning after exactly one retry. */
  async recordRead(entry: ToolAuditEntry): Promise<void> {
    await this.recordBestEffort(entry, "read");
  }

  /** Records a proven non-mutating write failure best-effort, escalating after exactly one retry. */
  async recordFailure(entry: ToolAuditEntry): Promise<void> {
    await this.recordBestEffort({ ...entry, outcome: "error" }, "write_failure");
  }

  /** Records only caller-owned failures; an ownership lookup fault never guesses by inserting a row. */
  async recordFailureIfCallerOwned(
    invocationId: string,
    entry: ToolAuditEntry,
  ): Promise<AuditFailureOwnership> {
    const ownership = await this.ownershipOf(invocationId, entry.tool);
    if (ownership === "unknown") return "unknown";
    if (ownership === "journal_owned") return "journal_owned";
    await this.recordFailure(entry);
    return "caller_recorded";
  }

  /** Resolves durable ownership without ever treating lookup failure as caller-owned. */
  async ownershipOf(invocationId: string, tool: string): Promise<AuditOwnership> {
    try {
      return await this.ownership.isJournalOwned(invocationId) ? "journal_owned" : "caller_owned";
    } catch (error) {
      this.metrics.increment("audit_ownership_unknown", { tool });
      this.logger.error("tool audit ownership lookup failed", {
        invocationId,
        tool,
        error: error instanceof Error ? error.message : "unknown",
      });
      return "unknown";
    }
  }

  private async recordBestEffort(entry: ToolAuditEntry, operation: "read" | "write_failure"): Promise<void> {
    const redacted = { ...entry, detail: redactAuditDetail(entry.detail) };
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.repository.record(redacted, this.clock.now().toISOString());
        if (attempt === 2) this.metrics.increment("audit_record_retry_success", { operation });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this.metrics.increment("audit_record_failure", { operation });
    const detail = { operation, tool: entry.tool, error: lastError instanceof Error ? lastError.message : "unknown" };
    if (operation === "read") this.logger.warn("tool audit record failed after retry", detail);
    else this.logger.error("tool audit record failed after retry", detail);
  }
}
