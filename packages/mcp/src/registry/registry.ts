import { ErrorCode, type DomainError, type Era, type ProjectId, type ToolLevel } from "@vidcom/contracts";
import type { ToolAuditEntry } from "@vidcom/core";

import type {
  ToolAnnotations,
  ToolDefinition,
  ToolDescriptor,
  ToolInvocation,
  ToolRequestContext,
  ToolRegistryDependencies,
} from "./types";
import { InputRequiredSignal } from "./types";

interface RegistryRuntime {
  newInvocationId(): string;
  now(): Date;
}

const defaultRuntime: RegistryRuntime = {
  newInvocationId: () => crypto.randomUUID(),
  now: () => new Date(),
};

function failure(code: ErrorCode, message: string, field?: string): { ok: false; error: DomainError } {
  return { ok: false, error: { code, message, ...(field ? { field } : {}) } };
}

function grantIdOf(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const grantId = (input as Record<string, unknown>).grantId;
  return typeof grantId === "string" && grantId.length > 0 ? grantId : null;
}

/** Derives host hints from authorization level; callers cannot override safety metadata. */
export function annotationsForLevel(level: ToolLevel): ToolAnnotations {
  if (level === "read") {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (level === "destructive") {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  }
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

/** Protocol-neutral registry that owns deterministic tool identity and schema validation. */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<unknown, unknown>>();

  constructor(
    readonly dependencies: ToolRegistryDependencies,
    private readonly runtime: RegistryRuntime = defaultRuntime,
  ) {}

  register<I, O>(definition: ToolDefinition<I, O>): void {
    if (this.definitions.has(definition.name)) throw new TypeError(`tool is already registered: ${definition.name}`);
    const canonical: ToolDefinition<I, O> = {
      ...definition,
      annotations: annotationsForLevel(definition.level),
    };
    this.definitions.set(definition.name, canonical as ToolDefinition<unknown, unknown>);
  }

  list(era: Era): ToolDescriptor[] {
    return [...this.definitions.values()]
      .filter((definition) => era === "modern" || definition.availableInLegacy)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((definition) => ({
        name: definition.name,
        title: definition.title,
        level: definition.level,
        description: definition.description,
        inputSchema: definition.input,
        outputSchema: definition.output,
        annotations: definition.annotations,
      }));
  }

  /** Validates a handler result against the registered public output contract. */
  validateOutput<O = unknown>(name: string, raw: unknown): O {
    const definition = this.definitions.get(name);
    if (!definition) throw new TypeError(`tool is not registered: ${name}`);
    return definition.output.parse(raw) as O;
  }

  /** Runs the sole validation, scope, audit and handler pipeline shared by every transport. */
  async invoke(name: string, raw: unknown, request: ToolRequestContext): Promise<ToolInvocation> {
    const definition = this.definitions.get(name);
    if (!definition) return failure(ErrorCode.NotFound, `tool is not registered: ${name}`);
    const invocationId = this.runtime.newInvocationId();
    const invokedAt = this.runtime.now().toISOString();
    let input: unknown;
    try {
      input = definition.input.parse(raw);
    } catch {
      const result = failure(ErrorCode.SchemaInvalid, "tool input does not match its strict schema", "input");
      await this.recordPreHandlerFailure(definition, request, invocationId, invokedAt, null, raw, result.error);
      return result;
    }
    if (request.era === "legacy" && !definition.availableInLegacy) {
      const result = failure(ErrorCode.ToolNotAvailableInEra, "tool is not available for the negotiated protocol era");
      await this.recordPreHandlerFailure(definition, request, invocationId, invokedAt, null, input, result.error);
      return result;
    }

    let projectId: ProjectId | null;
    try {
      projectId = definition.projectIdOf(input);
    } catch {
      const result = failure(ErrorCode.SchemaInvalid, "tool project scope could not be derived", "projectId");
      await this.recordPreHandlerFailure(definition, request, invocationId, invokedAt, null, input, result.error);
      return result;
    }
    const detail = { input, invocationId };
    const journalOwned = definition.level === "write" || definition.level === "destructive";
    const pending = journalOwned
      ? this.dependencies.audit.prepareWrite({
          invocationId,
          invokedAt,
          tool: definition.name,
          level: definition.level,
          projectId,
          era: request.era,
          protocolVersion: request.protocolVersion,
          detail,
          credentialId: request.credentialId,
        })
      : null;
    const context = {
      actor: "agent" as const,
      era: request.era,
      protocolVersion: request.protocolVersion,
      grantId: definition.level === "destructive" ? grantIdOf(input) : null,
      credentialId: request.credentialId,
      invocationId,
      writeInvocation: { toolAudit: pending },
      requestInput: request.requestInput,
    };

    let result: ToolInvocation;
    try {
      result = await definition.handler(context, input);
    } catch (error) {
      if (error instanceof InputRequiredSignal) throw error;
      result = failure(ErrorCode.Internal, "tool handler failed unexpectedly");
    }
    if (result.ok) {
      try {
        result = { ok: true, value: definition.output.parse(result.value) };
      } catch {
        result = failure(ErrorCode.Internal, "tool handler returned an invalid output");
      }
    }

    const terminal = this.terminalEntry(definition, request, projectId, detail, result);
    if (!journalOwned) {
      await this.dependencies.audit.recordRead(terminal);
    } else if (!result.ok) {
      await this.dependencies.audit.recordFailureIfCallerOwned(invocationId, terminal);
    } else {
      const ownership = await this.dependencies.audit.ownershipOf(invocationId, definition.name);
      if (ownership !== "journal_owned") {
        return failure(ErrorCode.Internal, ownership === "unknown"
          ? "tool audit ownership could not be determined"
          : "write tool completed without durable journal audit ownership");
      }
    }
    return result;
  }

  private terminalEntry(
    definition: ToolDefinition<unknown, unknown>,
    request: ToolRequestContext,
    projectId: ProjectId | null,
    detail: Record<string, unknown>,
    result: ToolInvocation,
  ): ToolAuditEntry {
    return {
      tool: definition.name,
      level: definition.level,
      projectId,
      era: request.era,
      protocolVersion: request.protocolVersion,
      outcome: result.ok ? "ok" : "error",
      errorCode: result.ok ? null : result.error.code,
      detail,
      credentialId: request.credentialId,
    };
  }

  private async recordPreHandlerFailure(
    definition: ToolDefinition<unknown, unknown>,
    request: ToolRequestContext,
    invocationId: string,
    _invokedAt: string,
    projectId: ProjectId | null,
    input: unknown,
    error: DomainError,
  ): Promise<void> {
    const entry: ToolAuditEntry = {
      tool: definition.name,
      level: definition.level,
      projectId,
      era: request.era,
      protocolVersion: request.protocolVersion,
      outcome: "error",
      errorCode: error.code,
      detail: { input, invocationId },
      credentialId: request.credentialId,
    };
    if (definition.level === "read" || definition.level === "job") await this.dependencies.audit.recordRead(entry);
    else await this.dependencies.audit.recordFailure(entry);
  }
}
