import type { Actor, DomainError, Era, ProjectId, ToolLevel } from "@vidcom/contracts";
import type { ApprovalService, Result, ToolAuditService, WriteInvocation } from "@vidcom/core";
import type { z } from "zod";

/** Approval capability visible to tools; admin issue/revoke methods are intentionally absent. */
export interface RegistryApprovalDependencies {
  approvals: Pick<ApprovalService, "request">;
}

/** Protocol-neutral request for structured user input; transports decide how it is rendered. */
export interface InputRequest {
  message: string;
  schema: Record<string, unknown>;
  requestState: string;
}

/** Control-flow signal translated by modern transports into an MCP input-required result. */
export class InputRequiredSignal extends Error {
  constructor(readonly request: InputRequest) {
    super(request.message);
    this.name = "InputRequiredSignal";
  }
}

/** Per-invocation identity and audit context supplied only by ToolRegistry. */
export interface ToolContext {
  actor: Actor;
  era: Era;
  protocolVersion: string;
  grantId: string | null;
  credentialId: string | null;
  invocationId: string;
  writeInvocation: WriteInvocation;
  requestInput(request: InputRequest): Promise<never>;
}

/** Transport-supplied context; Registry owns actor, invocation, grant extraction and write audit. */
export type ToolRequestContext = Pick<
  ToolContext,
  "era" | "protocolVersion" | "credentialId" | "requestInput"
>;

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
}

/** Single source of truth for schema, metadata, scope and execution of one tool. */
export interface ToolDefinition<I, O> {
  name: string;
  title: string;
  level: ToolLevel;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  annotations: ToolAnnotations;
  availableInLegacy: boolean;
  projectIdOf(input: I): ProjectId | null;
  handler(context: ToolContext, input: I): Promise<Result<O, DomainError>>;
}

/** Transport-facing immutable metadata produced from a registered definition. */
export interface ToolDescriptor {
  name: string;
  title: string;
  level: ToolLevel;
  description: string;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
  annotations: ToolAnnotations;
}

export interface ToolRegistryDependencies extends RegistryApprovalDependencies {
  audit: ToolAuditService;
}

export type ToolInvocation = Result<unknown, DomainError>;

/**
 * Whoever actually runs a tool.
 *
 * The registry owns the schema, the list and the era rules; this is the one
 * thing it does not own. `ToolRegistry` satisfies it directly for the local
 * case, and the bridge supplies an implementation that forwards to a daemon —
 * so `mcp` never learns that a daemon exists. It cannot: `mcp` is forbidden
 * from importing `adapter`, enforced by both ESLint and the boundary script,
 * and receiving the invoker as a parameter is what keeps that true.
 */
export interface ToolInvoker {
  invoke(name: string, raw: unknown, request: ToolRequestContext): Promise<ToolInvocation>;
}

export type { ToolLevel } from "@vidcom/contracts";
