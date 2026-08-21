import {
  ErrorCode,
  TOOL_SCHEMA_CATALOGUE,
  type DomainError,
  type Era,
  type ProjectId,
  type ToolLevel,
  type ToolSchemaEntry,
} from "@vidcom/contracts";
import { ignoredMutationOriginForActor, type ToolAuditEntry } from "@vidcom/core";

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

const publicToolSchemas: Readonly<Record<string, ToolSchemaEntry>> = TOOL_SCHEMA_CATALOGUE;

function failure(code: ErrorCode, message: string, field?: string): { ok: false; error: DomainError } {
  return { ok: false, error: { code, message, ...(field ? { field } : {}) } };
}

function grantIdOf(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const grantId = (input as Record<string, unknown>).grantId;
  return typeof grantId === "string" && grantId.length > 0 ? grantId : null;
}

function committedResponseDetails(raw: unknown, invocationId: string): Record<string, unknown> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const envelope = value.envelope && typeof value.envelope === "object" && !Array.isArray(value.envelope)
    ? value.envelope as Record<string, unknown>
    : {};
  return {
    committed: true,
    invocationId,
    ...(Number.isSafeInteger(envelope.projectRevision)
      ? { projectRevision: envelope.projectRevision }
      : {}),
    ...(Number.isSafeInteger(envelope.entityRevision)
      ? { entityRevision: envelope.entityRevision }
      : {}),
  };
}

function elapsedMilliseconds(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

/** Derives safety hints from authorization level; tools only choose whether they access the open world. */
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
      annotations: {
        ...annotationsForLevel(definition.level),
        openWorldHint: definition.annotations.openWorldHint,
      },
    };
    this.definitions.set(definition.name, canonical as ToolDefinition<unknown, unknown>);
  }

  /** Seals full public registration against the contracts catalogue in both directions. */
  assertPublicCatalogue(): void {
    const expectedNames = Object.keys(publicToolSchemas).sort();
    const registeredNames = [...this.definitions.keys()].sort();
    if (
      expectedNames.length !== registeredNames.length
      || expectedNames.some((name, index) => name !== registeredNames[index])
    ) {
      throw new TypeError("public tool registry does not match the contracts catalogue");
    }
    for (const name of expectedNames) {
      const expected = publicToolSchemas[name];
      const registered = this.definitions.get(name);
      if (!expected || !registered || (
        expected.input !== registered.input
        || expected.output !== registered.output
        || expected.level !== registered.level
      )) {
        throw new TypeError(`tool does not match its contracts catalogue entry: ${name}`);
      }
    }
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
    const startedAt = this.runtime.now();
    const invokedAt = startedAt.toISOString();
    let input: unknown;
    try {
      input = definition.input.parse(raw);
    } catch {
      const result = failure(ErrorCode.SchemaInvalid, "tool input does not match its strict schema", "input");
      await this.recordPreHandlerFailure(definition, request, invocationId, startedAt, null, raw, result.error);
      return result;
    }
    if (request.era === "legacy" && !definition.availableInLegacy) {
      const result = failure(ErrorCode.ToolNotAvailableInEra, "tool is not available for the negotiated protocol era");
      await this.recordPreHandlerFailure(definition, request, invocationId, startedAt, null, input, result.error);
      return result;
    }

    let projectId: ProjectId | null;
    try {
      projectId = definition.projectIdOf(input);
    } catch {
      const result = failure(ErrorCode.SchemaInvalid, "tool project scope could not be derived", "projectId");
      await this.recordPreHandlerFailure(definition, request, invocationId, startedAt, null, input, result.error);
      return result;
    }
    const revisionBefore = await this.dependencies.audit.currentRevision(projectId);
    const detail = { input, invocationId };
    const journalOwned = definition.journalOwned
      ?? (definition.level === "write" || definition.level === "destructive");
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
          revisionBefore,
        })
      : null;
    // Set when write authority proves the project already matched the request, so
    // no journal was opened. Nothing else may set it: the ownership check below is
    // what catches a handler mutating outside the journal.
    let unchanged = false;
    const context = {
      actor: "agent" as const,
      era: request.era,
      protocolVersion: request.protocolVersion,
      grantId: definition.level === "destructive" ? grantIdOf(input) : null,
      credentialId: request.credentialId,
      invocationId,
      writeInvocation: {
        origin: ignoredMutationOriginForActor("agent"),
        toolAudit: pending,
        noteUnchanged: () => { unchanged = true; },
      },
      requestInput: request.requestInput,
    };

    let result: ToolInvocation;
    try {
      result = await definition.handler(context, input);
    } catch (error) {
      if (error instanceof InputRequiredSignal) {
        const inputRequired = failure(
          ErrorCode.ApprovalRequired,
          "tool invocation requires approved input before it can continue",
        );
        const terminal = await this.terminalEntry(definition, request, projectId, {
          ...detail,
          requestState: error.request.requestState,
        }, inputRequired, startedAt, revisionBefore);
        if (!journalOwned) await this.dependencies.audit.recordRead(terminal);
        else await this.dependencies.audit.recordFailureIfCallerOwned(invocationId, terminal);
        throw error;
      }
      result = failure(ErrorCode.Internal, "tool handler failed unexpectedly");
    }
    if (result.ok) {
      const rawOutput = result.value;
      try {
        result = { ok: true, value: definition.output.parse(rawOutput) };
      } catch {
        if (journalOwned) {
          const ownership = await this.dependencies.audit.ownershipOf(invocationId, definition.name);
          if (ownership === "journal_owned") {
            const committed = failure(
              ErrorCode.CommittedResponseError,
              "mutation committed but response finalization failed; do not retry the mutation",
            );
            return {
              ...committed,
              error: {
                ...committed.error,
                details: committedResponseDetails(rawOutput, invocationId),
              },
            };
          }
          if (ownership === "unknown") {
            return failure(ErrorCode.Internal, "tool audit ownership could not be determined");
          }
        }
        result = failure(ErrorCode.Internal, "tool handler returned an invalid output");
      }
    }

    const terminal = await this.terminalEntry(
      definition,
      request,
      projectId,
      detail,
      result,
      startedAt,
      revisionBefore,
    );
    if (!journalOwned) {
      await this.dependencies.audit.recordRead(terminal);
    } else if (!result.ok) {
      await this.dependencies.audit.recordFailureIfCallerOwned(invocationId, terminal);
    } else {
      const ownership = await this.dependencies.audit.ownershipOf(invocationId, definition.name);
      if (ownership === "caller_owned" && unchanged) {
        // An idempotent write: the request was already satisfied, so there is no
        // journal to own the audit and the invocation is recorded the way a read
        // is. Rejecting it would make re-sending the same content a hard failure.
        await this.dependencies.audit.recordRead(terminal);
      } else if (ownership !== "journal_owned") {
        return failure(ErrorCode.Internal, ownership === "unknown"
          ? "tool audit ownership could not be determined"
          : "write tool completed without durable journal audit ownership");
      }
    }
    return result;
  }

  private async terminalEntry(
    definition: ToolDefinition<unknown, unknown>,
    request: ToolRequestContext,
    projectId: ProjectId | null,
    detail: Record<string, unknown>,
    result: ToolInvocation,
    startedAt: Date,
    revisionBefore: number | null,
  ): Promise<ToolAuditEntry> {
    const endedAt = this.runtime.now();
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
      invokedAt: startedAt.toISOString(),
      durationMs: elapsedMilliseconds(startedAt, endedAt),
      revisionBefore,
      revisionAfter: await this.dependencies.audit.currentRevision(projectId),
    };
  }

  private async recordPreHandlerFailure(
    definition: ToolDefinition<unknown, unknown>,
    request: ToolRequestContext,
    invocationId: string,
    startedAt: Date,
    projectId: ProjectId | null,
    input: unknown,
    error: DomainError,
  ): Promise<void> {
    const endedAt = this.runtime.now();
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
      invokedAt: startedAt.toISOString(),
      durationMs: elapsedMilliseconds(startedAt, endedAt),
      revisionBefore: null,
      revisionAfter: null,
    };
    if (definition.level === "read" || definition.level === "job") await this.dependencies.audit.recordRead(entry);
    else await this.dependencies.audit.recordFailure(entry);
  }
}
