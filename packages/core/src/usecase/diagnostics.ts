import {
  ErrorCode,
  countStrandedTweens,
  measureElementWindow,
  type Diagnostic,
  type DomainError,
  type ProjectId,
  type RelPath,
  type SceneDto,
} from "@vidcom/contracts";

import type { CompositionSource, ProjectRef } from "../domain/models";
import { findMotionLibrary, scanRemoteMotionLibraries } from "../domain/motion-libraries";
import { storyMotionDiagnostics } from "../domain/story-motion";
import { err, ok, type Result } from "../error/result";
import type { CompositionPort, DiagnosticsLintPort, MutationJournalPort, WorkspacePort } from "../port/ports";
import { canonicalizeJson } from "../service/canonical-json";
import type { EntryId } from "../service/entry-registry";
import type { DerivedMutationPath, WriteAuthority } from "../service/write-authority";
import type { ProjectIdentityService } from "./project-identity";
import type { WorkspaceEntry } from "./scan-workspace";

export { countStrandedTweens, measureElementWindow } from "@vidcom/contracts";

export interface DiagnosticsReport {
  diagnostics: Diagnostic[];
  computedAtSourceRevision: number | null;
  lintSourceAvailable: boolean;
}

export interface DiagnosticsServiceDependencies {
  scan(): Promise<WorkspaceEntry[]>;
  workspace: WorkspacePort;
  composition: CompositionPort;
  identity: ProjectIdentityService;
  journal: Pick<MutationJournalPort, "latestSourceRevision">;
  authority: Pick<WriteAuthority, "mutateDerived">;
  lint: DiagnosticsLintPort;
}

function invalidDiagnostic(entry: Extract<WorkspaceEntry, { state: "invalid" }>): Diagnostic {
  const location = entry.invalidReason.column ? ` at column ${entry.invalidReason.column}` : "";
  return {
    severity: "error",
    code: entry.invalidReason.code,
    ...(entry.invalidReason.line ? { line: entry.invalidReason.line } : {}),
    message: `${entry.invalidKind === "identity" ? "Project identity" : "Composition"} could not be parsed${location}.`,
  };
}

function sceneDiagnostics(scene: SceneDto): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const stranded = countStrandedTweens(scene.elements, scene.duration);
  if (stranded > 0) diagnostics.push({
    severity: "warning",
    code: "stranded-tween",
    sceneId: scene.id,
    message: `${stranded} tween${stranded === 1 ? "" : "s"} start after the scene clip ends.`,
  });
  for (const element of scene.elements) {
    const window = measureElementWindow(element, scene.duration);
    if (window.overrun > 0) diagnostics.push({
      severity: "warning",
      code: "element-overrun",
      sceneId: scene.id,
      elementId: element.id,
      message: `Element extends ${window.overrun.toFixed(2)}s past the scene clip.`,
    });
  }
  if (scene.unresolvedEffects > 0) diagnostics.push({
    severity: "warning",
    code: "unresolved-selector",
    sceneId: scene.id,
    message: `${scene.unresolvedEffects} tween selector${scene.unresolvedEffects === 1 ? "" : "s"} could not be resolved statically.`,
  });
  if (scene.elements.length === 0 && scene.unresolvedEffects === 0) diagnostics.push({
    severity: "info",
    code: "empty-scene",
    sceneId: scene.id,
    message: "Scene has no timed element or statically resolvable tween.",
  });
  const narrationDuration = scene.narration?.durationSeconds;
  if (narrationDuration !== undefined && narrationDuration > scene.duration) diagnostics.push({
    severity: "warning",
    code: "narration-overflow",
    sceneId: scene.id,
    message: `Narration is ${narrationDuration}s but the scene is ${scene.duration}s.`,
    fix: {
      kind: "set-attribute",
      target: `[data-composition-id="${scene.id}"]`,
      attribute: "data-duration",
      value: String(narrationDuration),
    },
  });
  return diagnostics;
}

/** Computes and projects project diagnostics; recovery diagnostics remain response-only. */
export class DiagnosticsService {
  constructor(private readonly dependencies: DiagnosticsServiceDependencies) {}

  /**
   * Flags motion libraries still loaded from a CDN. The render survives one, but
   * it loses `reproducible` and stops resolving once the app runs offline, so the
   * vendored copy is the fix rather than a preference.
   */
  private async remoteMotionLibraryDiagnostics(
    ref: ProjectRef,
    sources: readonly CompositionSource[],
  ): Promise<Diagnostic[]> {
    const documents: Array<{ path: RelPath; html: string }> = [];
    for (const source of sources) {
      if (!source.path.toLowerCase().endsWith(".html")) continue;
      const resolved = await this.dependencies.workspace.resolve(ref, source.path, "read-source");
      if (!resolved.ok) continue;
      const file = await this.dependencies.workspace.readFile(resolved.value);
      if (file) documents.push({ path: source.path, html: file.content });
    }
    return scanRemoteMotionLibraries(documents).map((use) => {
      const library = findMotionLibrary(use.id)!;
      return {
        severity: "warning" as const,
        code: "remote-motion-library",
        file: use.file,
        message: `${use.id} loads from ${use.url}; vendor it with install_motion_library and reference ${library.entry} so the render stays reproducible and works offline.`,
      };
    });
  }

  async forEntry(entryId: EntryId): Promise<Result<DiagnosticsReport, DomainError>> {
    const entry = (await this.dependencies.scan()).find((item): item is Extract<WorkspaceEntry, {
      state: "invalid"; invalidKind: "identity";
    }> => item.kind === "project" && item.state === "invalid" && item.invalidKind === "identity"
      && item.entryId === entryId);
    return entry
      ? ok({ diagnostics: [invalidDiagnostic(entry)], computedAtSourceRevision: null, lintSourceAvailable: false })
      : err({ code: ErrorCode.ProjectNotFound, message: "recovery entry is no longer valid" });
  }

  async forProject(projectId: ProjectId): Promise<Result<DiagnosticsReport, DomainError>> {
    const entry = (await this.dependencies.scan()).find((item): item is Extract<WorkspaceEntry, {
      kind: "project"; projectId: ProjectId;
    }> => item.kind === "project" && item.projectId === projectId);
    if (!entry) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
    const ref = await this.dependencies.workspace.readProjectRef(projectId);
    if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
    const computedAtSourceRevision = await this.dependencies.journal.latestSourceRevision(projectId) ?? 0;
    const diagnostics: Diagnostic[] = [];
    let lintSourceAvailable = false;

    if (entry.state === "invalid") {
      diagnostics.push(invalidDiagnostic(entry));
    } else if (entry.state === "empty") {
      diagnostics.push({ severity: "info", code: "no-composition", message: "Project has no composition yet." });
    } else {
      let model;
      try {
        model = await this.dependencies.composition.parseProject(ref);
      } catch {
        diagnostics.push({ severity: "error", code: "composition_parse_error", message: "Composition could not be parsed." });
      }
      if (model) {
        diagnostics.push(
          ...model.diagnostics,
          ...model.scenes.flatMap(sceneDiagnostics),
          // VidCom-authored story beats are mounted sub-compositions. Inline
          // legacy/utility scenes stay readable; the agent-kit creates every new
          // story scene as its own source and therefore cannot bypass this gate.
          ...storyMotionDiagnostics(model.scenes.filter((scene) => scene.src !== null)),
        );
        if (model.scenes.length === 0) diagnostics.push({
          severity: "info", code: "no-scenes", message: "Composition has no scenes yet.",
        });
        const root = model.rootTrack as { unresolvedEffects?: unknown } | null;
        if (typeof root?.unresolvedEffects === "number" && root.unresolvedEffects > 0) diagnostics.push({
          severity: "warning",
          code: "unresolved-selector",
          message: `${root.unresolvedEffects} root tween selector${root.unresolvedEffects === 1 ? "" : "s"} could not be resolved statically.`,
        });
        const identity = await this.dependencies.identity.read(ref.root);
        const platform = identity.ok ? identity.identity.platform : null;
        if (platform && (platform.width !== model.project.width || platform.height !== model.project.height
          || platform.fps !== (model.frameRate ?? 30))) diagnostics.push({
          severity: "warning",
          code: "platform-mismatch",
          message: `Declared ${platform.width}x${platform.height}@${platform.fps}fps differs from composition ${model.project.width}x${model.project.height}@${model.frameRate ?? 30}fps.`,
        });
        diagnostics.push(...await this.remoteMotionLibraryDiagnostics(ref, model.sources));
        const sources = new Set(model.sources.map(({ path }) => path));
        for (const reference of model.references) {
          if (sources.has(reference.path)) continue;
          const resolved = await this.dependencies.workspace.resolve(ref, reference.path, "read-asset");
          if (!resolved.ok || !(await this.dependencies.workspace.exists(resolved.value))) diagnostics.push({
            severity: "error",
            code: "missing-asset",
            file: reference.owner,
            message: `Referenced asset ${reference.path} does not exist.`,
          });
        }
      }
    }

    if (entry.state !== "empty") {
      const lint = await this.dependencies.lint.check(ref).catch(() => ({ available: false, diagnostics: [] }));
      lintSourceAvailable = lint.available;
      diagnostics.push(...lint.diagnostics);
    }
    if (!lintSourceAvailable) diagnostics.push({
      severity: "info",
      code: "lint-source-unavailable",
      message: "HyperFrames check was unavailable; internal diagnostics are still shown.",
    });
    const report = { diagnostics, computedAtSourceRevision, lintSourceAvailable };
    const published = await this.dependencies.authority.mutateDerived({
      ref,
      writes: [{
        path: ".vidcom/context/diagnostics.json" as DerivedMutationPath,
        content: `${canonicalizeJson(report)}\n`,
      }],
      producedByJobId: null,
      computedAtSourceRevision,
    }, "system");
    return published.ok ? ok(report) : published;
  }
}
