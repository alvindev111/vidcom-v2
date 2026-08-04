import { z } from "zod";

import { ErrorCode, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";

import { inferPreset, type PlatformConfig } from "../domain/platform-preset";
import type { AbsolutePath, ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { ClockPort, CompositionPort, WorkspacePort } from "../port/ports";
import type { WriteAuthority } from "../service/write-authority";

const platformSchema = z.strictObject({
  presetId: z.enum(["vertical-shorts", "horizontal-youtube", "custom"]),
  orientation: z.enum(["vertical", "horizontal"]),
  aspectRatio: z.string().min(1),
  width: z.number().int().min(128).max(7680),
  height: z.number().int().min(128).max(7680),
  fps: z.number().int().min(1).max(120),
  targets: z.array(z.string()),
  recommendedMaxDurationSeconds: z.number().nonnegative().nullable(),
});

const identitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  platform: platformSchema.nullable(),
  render: z.strictObject({ defaultPresetId: z.string().min(1), outputDirectory: z.string().min(1) }),
  narration: z.strictObject({
    defaultProviderId: z.string().min(1).nullable(),
    defaultVoiceId: z.string().min(1).nullable(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export interface ProjectIdentity {
  schemaVersion: 1;
  id: ProjectId;
  platform: PlatformConfig | null;
  render: { defaultPresetId: string; outputDirectory: string };
  narration: { defaultProviderId: string | null; defaultVoiceId: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface InvalidReason {
  code: "identity_parse_error" | "composition_parse_error";
  field?: string;
  line?: number;
  column?: number;
}

export type IdentityReadResult =
  | { ok: true; identity: ProjectIdentity }
  | { ok: false; reason: InvalidReason };

export interface ProjectIdentityDependencies {
  workspace: WorkspacePort;
  authority: WriteAuthority;
  composition: CompositionPort;
  clock: ClockPort;
}

function parseLocation(message: string): Pick<InvalidReason, "line" | "column"> {
  const match = /position\s+(\d+)/iu.exec(message);
  return match ? { column: Number(match[1]) + 1 } : {};
}

function invalidField(error: z.ZodError): string | undefined {
  const issue = error.issues[0];
  if (!issue) return undefined;
  if (issue.code === "unrecognized_keys") return issue.keys[0];
  return issue.path.length > 0 ? issue.path.join(".") : undefined;
}

function castIdentity(value: z.infer<typeof identitySchema>): ProjectIdentity {
  return { ...value, id: value.id as ProjectId };
}

/** Strict identity reader plus the only lazy upgrade path for legacy `{ id }` markers. */
export class ProjectIdentityService {
  constructor(private readonly dependencies: ProjectIdentityDependencies) {}

  async read(root: AbsolutePath): Promise<IdentityReadResult> {
    const file = await this.dependencies.workspace.readWorkspaceFile?.(root, "vidcom.json") ?? null;
    if (!file) return { ok: false, reason: { code: "identity_parse_error", field: "vidcom.json" } };
    let raw: unknown;
    try {
      raw = JSON.parse(file.content);
    } catch (error) {
      return {
        ok: false,
        reason: { code: "identity_parse_error", ...parseLocation(error instanceof Error ? error.message : "") },
      };
    }
    if (raw && typeof raw === "object" && typeof (raw as { schemaVersion?: unknown }).schemaVersion === "number"
      && (raw as { schemaVersion: number }).schemaVersion > 1) {
      return { ok: false, reason: { code: "identity_parse_error", field: "schemaVersion" } };
    }
    const parsed = identitySchema.safeParse(raw);
    return parsed.success
      ? { ok: true, identity: castIdentity(parsed.data) }
      : { ok: false, reason: { code: "identity_parse_error", field: invalidField(parsed.error) } };
  }

  serialize(identity: ProjectIdentity): string {
    const validated = identitySchema.parse(identity);
    return `${JSON.stringify(validated, null, 2)}\n`;
  }

  async backfillPlatform(ref: ProjectRef): Promise<Result<ProjectIdentity, DomainError>> {
    const resolved = await this.dependencies.workspace.resolve(ref, "vidcom.json", "system-write");
    if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "project identity path is unavailable" });
    const file = await this.dependencies.workspace.readFile(resolved.value);
    if (!file) return err({ code: ErrorCode.IdentityParseError, message: "project identity is missing" });
    let raw: unknown;
    try { raw = JSON.parse(file.content); }
    catch { return err({ code: ErrorCode.IdentityParseError, message: "project identity could not be parsed" }); }
    const strict = identitySchema.safeParse(raw);
    if (strict.success) return ok(castIdentity(strict.data));
    const legacyId = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id as ProjectId
      : null;
    if (!legacyId || legacyId !== ref.id) {
      return err({ code: ErrorCode.IdentityParseError, message: "project identity cannot be backfilled" });
    }
    let platform: PlatformConfig | null = null;
    const entry = await this.dependencies.workspace.resolve(ref, ref.entry, "read-source");
    if (entry.ok && await this.dependencies.workspace.exists(entry.value)) {
      try {
        const model = await this.dependencies.composition.parseProject(ref);
        platform = inferPreset(model.project.width, model.project.height, 30);
      } catch {
        return err({ code: ErrorCode.CompositionParseError, message: "composition could not be parsed for platform backfill" });
      }
    }
    const now = this.dependencies.clock.now().toISOString();
    const identity: ProjectIdentity = {
      schemaVersion: 1,
      id: legacyId,
      platform,
      render: { defaultPresetId: platform?.presetId ?? "horizontal-youtube", outputDirectory: "renders" },
      narration: { defaultProviderId: null, defaultVoiceId: null },
      createdAt: now,
      updatedAt: now,
    };
    const written = await this.dependencies.authority.mutateSource({
      kind: "file",
      ref,
      path: "vidcom.json" as RelPath,
      content: this.serialize(identity),
      expectedContentHash: file.contentHash,
    }, "system");
    return written.ok ? ok(identity) : written;
  }
}
