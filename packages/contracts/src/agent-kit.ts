import { z } from "zod";

import { ContentHashSchema, RelativePathSchema } from "./dto";

export const AgentKitHostSchema = z.enum(["codex", "claude-code"]);
export type AgentKitHost = z.infer<typeof AgentKitHostSchema>;

export const AgentKitFileStateSchema = z.enum([
  "missing",
  "current_pristine",
  "current_modified",
  "outdated",
  "newer",
  "foreign",
]);
export type AgentKitFileStateName = z.infer<typeof AgentKitFileStateSchema>;

export const AgentKitNextActionSchema = z.enum(["none", "install", "replace", "link", "manual_merge"]);
export type AgentKitNextAction = z.infer<typeof AgentKitNextActionSchema>;

const uniqueHosts = z.array(AgentKitHostSchema).min(1).superRefine((hosts, context) => {
  if (new Set(hosts).size !== hosts.length) {
    context.addIssue({ code: "custom", message: "hosts must be unique" });
  }
});

const strictInstall = z.strictObject({
  operation: z.literal("install"),
  hosts: uniqueHosts,
});
const strictLink = z.strictObject({
  operation: z.literal("link"),
  host: z.literal("claude-code"),
  expectedContentHash: ContentHashSchema,
});
const strictReplace = z.strictObject({
  operation: z.literal("replace"),
  host: AgentKitHostSchema,
  relativePath: RelativePathSchema,
  expectedContentHash: ContentHashSchema,
});

/** Strict boundary union; omitted operation is normalized to install before discrimination. */
export const InstallAgentKitInputSchema = z.preprocess(
  (value) => value && typeof value === "object" && !Array.isArray(value) && !("operation" in value)
    ? { ...value, operation: "install" }
    : value,
  z.discriminatedUnion("operation", [strictInstall, strictLink, strictReplace]),
);
export type InstallAgentKitInput = z.infer<typeof InstallAgentKitInputSchema>;

export const AgentKitFileStateOutputSchema = z.strictObject({
  host: AgentKitHostSchema,
  relativePath: RelativePathSchema,
  state: AgentKitFileStateSchema,
  contentHash: ContentHashSchema.nullable(),
  nextAction: AgentKitNextActionSchema,
});
export type AgentKitFileStateOutput = z.infer<typeof AgentKitFileStateOutputSchema>;

export const InstallAgentKitOutputSchema = z.strictObject({
  operationResult: z.strictObject({
    status: z.enum(["applied", "no_change"]),
    changedFiles: z.array(z.strictObject({
      relativePath: RelativePathSchema,
      contentHash: ContentHashSchema,
    })),
  }),
  installationState: z.strictObject({
    outcome: z.enum(["installed", "already_installed", "partial", "blocked"]),
    files: z.array(AgentKitFileStateOutputSchema),
    usableBy: z.partialRecord(AgentKitHostSchema, z.enum(["ready", "degraded", "blocked"])),
    recovery: z.array(z.strictObject({
      host: AgentKitHostSchema,
      action: AgentKitNextActionSchema,
      detail: z.string(),
    })),
  }),
});
export type InstallAgentKitOutput = z.infer<typeof InstallAgentKitOutputSchema>;
