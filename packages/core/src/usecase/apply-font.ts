import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { checkPathPurpose, checkPathSyntax } from "../domain/path-policy";
import { err, ok, type Result } from "../error/result";
import type { CompositionPort, FontStylePort, MediaProbePort, WorkspacePort } from "../port/ports";
import type { CompositeRequest, WriteEnvelope, WriteInvocation } from "../port/types";

export interface ApplyFontDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef" | "resolve" | "readFile" | "readHash">;
  composition: Pick<CompositionPort, "parseProject">;
  probe: Pick<MediaProbePort, "probeFont">;
  styles: FontStylePort;
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
}

export type FontScope = { kind: "project" } | { kind: "scene"; sceneId: string };

function normalizedName(value: string): string | null {
  const normalized = value.normalize("NFC");
  const points = [...normalized];
  if (points.length === 0 || points.length > 256) return null;
  return points.some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || code < 0x20 || (code >= 0x7f && code <= 0x9f);
  }) ? null : normalized;
}

export async function applyFont(
  dependencies: ApplyFontDependencies,
  input: {
    projectId: ProjectId;
    fontPath: RelPath;
    fontContentHash: ContentHash;
    scope: FontScope;
    expectedContentHash: ContentHash;
  },
  actor: Actor,
  invocation: WriteInvocation,
): Promise<Result<{
  path: RelPath;
  family: string;
  style: string;
  envelope: WriteEnvelope;
}, DomainError>> {
  if (checkPathSyntax(input.fontPath) || checkPathPurpose(input.fontPath, "read-asset")) {
    return err({ code: ErrorCode.PathInvalid, message: "font path is not an allowed project asset" });
  }
  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const font = await dependencies.workspace.resolve(ref, input.fontPath, "read-asset");
  if (!font.ok) return err({ code: ErrorCode.PathOutsideProject, message: "font path escaped the project" });
  let actualFontHash: ContentHash | null;
  try { actualFontHash = await dependencies.workspace.readHash(font.value); }
  catch { return err({ code: ErrorCode.StorageUnavailable, message: "font content could not be read" }); }
  if (actualFontHash === null) return err({ code: ErrorCode.NotFound, message: "font file was not found" });
  if (actualFontHash !== input.fontContentHash) {
    return err({
      code: ErrorCode.WriteConflict,
      message: "font changed before it could be applied",
      details: { currentContentHash: actualFontHash },
    });
  }

  const probed = await dependencies.probe.probeFont(ref, input.fontPath);
  if (!probed.ok) return probed;
  if (probed.value.status !== "ok") {
    return err({
      code: ErrorCode.AssetNotAllowed,
      message: "font metadata could not be read",
      details: { reason: probed.value.reason },
    });
  }
  const family = normalizedName(probed.value.family);
  const style = normalizedName(probed.value.style);
  if (!family || !style) {
    return err({ code: ErrorCode.AssetNotAllowed, message: "font family or style metadata is unsafe" });
  }

  let model;
  try { model = await dependencies.composition.parseProject(ref); }
  catch {
    return err({ code: ErrorCode.ProjectInvalid, message: "project composition is invalid" });
  }
  let path = ref.entry;
  let target: Parameters<FontStylePort["apply"]>[1]["target"] = { kind: "document" };
  if (input.scope.kind === "scene") {
    const sceneId = input.scope.sceneId;
    const scene = model.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) return err({ code: ErrorCode.SceneNotFound, message: "scene was not found", field: "sceneId" });
    if (scene.src) {
      const source = model.sources.find((candidate) => candidate.path === scene.src);
      if (!source) return err({ code: ErrorCode.NotFound, message: "scene source file was not found" });
      path = source.path;
    } else {
      target = { kind: "composition", id: scene.id };
    }
  }
  const resolved = await dependencies.workspace.resolve(ref, path, "read-source");
  if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "composition path escaped the project" });
  const source = await dependencies.workspace.readFile(resolved.value);
  if (!source) return err({ code: ErrorCode.NotFound, message: "composition source file was not found" });
  if (source.contentHash !== input.expectedContentHash) {
    return err({
      code: ErrorCode.WriteConflict,
      message: "composition changed before the font could be applied",
      details: { currentContentHash: source.contentHash },
    });
  }
  const styled = await dependencies.styles.apply(source.content, {
    family,
    style,
    fontPath: input.fontPath,
    target,
  });
  if (!styled.ok) return styled;
  const written = await dependencies.authority.mutateSource({
    ref,
    steps: [{
      kind: "write",
      path,
      content: styled.value,
      expectedContentHash: source.contentHash,
    }],
    ...invocation,
    historyReadGuards: [{
      path: input.fontPath,
      state: { kind: "file", contentHash: input.fontContentHash },
    }],
    backup: false,
  }, actor);
  return written.ok ? ok({ path, family, style, envelope: written.value }) : written;
}
