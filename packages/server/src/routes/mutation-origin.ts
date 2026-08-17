import type { MutationOrigin, WriteInvocation } from "@vidcom/core";

/** Temporary P0 bridge; P3.3 replaces this with a validated studio-session origin. */
export const UNTRACKED_UI_ORIGIN = {
  kind: "ui",
  sessionId: null,
  label: null,
  historyAction: "ignore",
  historyOperation: null,
} as const satisfies MutationOrigin;

export const UNTRACKED_UI_INVOCATION = {
  origin: UNTRACKED_UI_ORIGIN,
  toolAudit: null,
} as const satisfies WriteInvocation;
