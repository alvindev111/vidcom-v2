import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type RelPath,
} from "@vidcom/contracts";

import type { AbsolutePath } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import { ignoredMutationOriginForActor } from "../port/mutation-observer";
import type { WorkspacePort } from "../port/ports";
import type { WriteInvocation } from "../port/types";
import type { WriteAuthority } from "../service/write-authority";

export type AgentKitHost = "codex" | "claude-code";
export type AgentKitFileStateKind = "missing" | "current_pristine" | "current_modified" | "outdated" | "newer" | "foreign";
export type AgentKitNextAction = "none" | "install" | "replace" | "link" | "manual_merge";

export interface AgentKitSourceFile { content: string; contentHash: ContentHash }
export interface AgentKitBundle {
  version: number;
  files: Readonly<Record<string, AgentKitSourceFile>>;
}
export interface AgentKitFileState {
  host: AgentKitHost;
  relativePath: RelPath;
  state: AgentKitFileStateKind;
  contentHash: ContentHash | null;
  nextAction: AgentKitNextAction;
}
export type InstallAgentKitInput =
  | { operation?: "install"; hosts: [AgentKitHost, ...AgentKitHost[]] }
  | { operation: "link"; host: "claude-code"; expectedContentHash: ContentHash }
  | { operation: "replace"; host: AgentKitHost; relativePath: string; expectedContentHash: ContentHash };
export interface InstallAgentKitOutput {
  operationResult: {
    status: "applied" | "no_change";
    changedFiles: Array<{ relativePath: RelPath; contentHash: ContentHash }>;
  };
  installationState: {
    outcome: "installed" | "already_installed" | "partial" | "blocked";
    files: AgentKitFileState[];
    usableBy: Partial<Record<AgentKitHost, "ready" | "degraded" | "blocked">>;
    recovery: Array<{ host: AgentKitHost; action: AgentKitNextAction; detail: string }>;
  };
}

interface ManifestFile { path: RelPath; source: string; role: "main" | "auxiliary" | "router" | "skill" }
const SKILLS = [
  "vidcom", "vidcom-project", "vidcom-scene", "vidcom-motion",
  "vidcom-look", "vidcom-narration", "vidcom-render", "vidcom-fix",
];
const EXACT_CLAUDE_LINK = "@CLAUDE.vidcom.md";

export class AgentKitInstaller {
  constructor(private readonly dependencies: {
    workspace: WorkspacePort;
    authority: Pick<WriteAuthority, "mutateWorkspace">;
    actor: Actor;
    bundle: AgentKitBundle;
  }) {}

  async apply(
    workspaceRoot: AbsolutePath,
    input: InstallAgentKitInput,
    invocation: WriteInvocation & { actor?: Actor } = {
      origin: ignoredMutationOriginForActor(this.dependencies.actor),
      toolAudit: null,
    },
  ): Promise<Result<InstallAgentKitOutput, DomainError>> {
    const hosts = input.operation === "link" || input.operation === "replace" ? [input.host] : input.hosts;
    if (hosts.length === 0 || new Set(hosts).size !== hosts.length) {
      return err({ code: ErrorCode.SchemaInvalid, message: "hosts must be non-empty and unique", field: "hosts" });
    }
    const before = await this.inspect(workspaceRoot, hosts);
    if (!before.ok) return before;
    const writes: Array<{ path: RelPath; content: string; fromHash: ContentHash | null }> = [];
    if (input.operation === "replace") {
      const replacementPath = input.relativePath as RelPath;
      const target = this.manifest(input.host, true).find((file) => file.path === replacementPath);
      const observed = before.value.files.find((file) => file.relativePath === replacementPath);
      if (!target || !observed) return err({ code: ErrorCode.SchemaInvalid, message: "replacement path is outside the selected host manifest", field: "relativePath" });
      if (["missing", "foreign", "newer"].includes(observed.state)) {
        return err({ code: ErrorCode.PreconditionRequired, message: "only marker-owned non-newer files can be replaced", field: "relativePath" });
      }
      if (observed.contentHash !== input.expectedContentHash) return err({ code: ErrorCode.WriteConflict, message: "agent-kit file changed before replacement", field: "expectedContentHash" });
      if (observed.state !== "current_pristine") {
        const source = this.source(target.source);
        writes.push({ path: target.path, content: source.content, fromHash: input.expectedContentHash });
      }
    } else if (input.operation === "link") {
      const mainPath = "CLAUDE.md" as RelPath;
      const current = await this.read(workspaceRoot, mainPath);
      if (!current.ok) return current;
      if (!current.value || current.value.contentHash !== input.expectedContentHash) {
        return err({ code: ErrorCode.WriteConflict, message: "CLAUDE.md changed before link", field: "expectedContentHash" });
      }
      const auxiliary = before.value.files.find((file) => file.relativePath === "CLAUDE.vidcom.md");
      if (auxiliary?.state !== "current_pristine") {
        return err({ code: ErrorCode.PreconditionRequired, message: "the pristine Claude VidCom instruction file must be installed before linking" });
      }
      if (!hasExactLine(current.value.content, EXACT_CLAUDE_LINK)) {
        const separator = current.value.content.endsWith("\n") ? "" : "\n";
        writes.push({ path: mainPath, content: `${current.value.content}${separator}${EXACT_CLAUDE_LINK}\n`, fromHash: current.value.contentHash });
      }
    } else {
      for (const host of hosts) {
        const states = before.value.files.filter((file) => file.host === host);
        for (const target of this.manifest(host, false)) {
          const state = states.find((file) => file.relativePath === target.path);
          if (state?.state === "missing") {
            const source = this.source(target.source);
            writes.push({ path: target.path, content: source.content, fromHash: null });
          }
        }
        const main = states.find((file) => file.relativePath === this.mainPath(host));
        const auxiliary = states.find((file) => file.relativePath === this.auxiliaryPath(host));
        if (main?.state === "foreign" && auxiliary?.state === "missing") {
          const source = this.source("AGENTS.md");
          writes.push({ path: this.auxiliaryPath(host), content: source.content, fromHash: null });
        }
      }
    }
    let changedFiles: Array<{ relativePath: RelPath; contentHash: ContentHash }> = [];
    if (writes.length > 0) {
      const mutation = await this.dependencies.authority.mutateWorkspace({
        workspaceRoot,
        writes,
        actor: invocation.actor ?? this.dependencies.actor,
        action: "agent-kit.install",
        ...invocation,
      });
      if (!mutation.ok) return mutation;
      changedFiles = writes.map((write) => ({ relativePath: write.path, contentHash: mutation.value.fileHashes[write.path]! }));
    } else if (invocation.toolAudit) {
      const auditedNoChange = await this.dependencies.authority.mutateWorkspace({
        workspaceRoot,
        writes: [],
        actor: invocation.actor ?? this.dependencies.actor,
        action: "agent-kit.install",
        ...invocation,
      });
      if (!auditedNoChange.ok) return auditedNoChange;
    }
    let after: Result<InstallAgentKitOutput["installationState"], DomainError>;
    try {
      after = await this.inspect(workspaceRoot, hosts);
    } catch (error) {
      if (writes.length > 0) return err({
        code: ErrorCode.CommittedResponseError,
        message: "agent-kit mutation committed but installation state could not be inspected; do not retry the mutation",
        details: { committed: true, changedFiles },
      });
      throw error;
    }
    if (!after.ok) return writes.length > 0 ? err({
      code: ErrorCode.CommittedResponseError,
      message: "agent-kit mutation committed but installation state could not be inspected; do not retry the mutation",
      details: { committed: true, changedFiles },
    }) : after;
    return ok({
      operationResult: { status: writes.length > 0 ? "applied" : "no_change", changedFiles },
      installationState: {
        ...after.value,
        outcome: after.value.outcome === "installed" && writes.length === 0 ? "already_installed" : after.value.outcome,
      },
    });
  }

  private async inspect(workspaceRoot: AbsolutePath, hosts: readonly AgentKitHost[]): Promise<Result<InstallAgentKitOutput["installationState"], DomainError>> {
    const files: AgentKitFileState[] = [];
    const contents = new Map<RelPath, string>();
    for (const host of hosts) {
      for (const target of this.manifest(host, true)) {
        const current = await this.read(workspaceRoot, target.path);
        if (!current.ok) return current;
        if (current.value) contents.set(target.path, current.value.content);
        const source = this.source(target.source);
        const state = classify(current.value?.content ?? null, current.value?.contentHash ?? null, source.contentHash, this.dependencies.bundle.version);
        files.push({
          host,
          relativePath: target.path,
          state,
          contentHash: current.value?.contentHash ?? null,
          nextAction: nextAction(state, target.role, host),
        });
      }
    }
    const usableBy: InstallAgentKitOutput["installationState"]["usableBy"] = {};
    const recovery: InstallAgentKitOutput["installationState"]["recovery"] = [];
    for (const host of hosts) {
      const hostFiles = files.filter((file) => file.host === host);
      const router = hostFiles.find((file) => file.relativePath === this.routerPath(host));
      const routerContent = contents.get(this.routerPath(host));
      const discoverable = routerContent !== undefined && markerVersion(routerContent) !== null && hasRouterFrontmatter(routerContent);
      const main = hostFiles.find((file) => file.relativePath === this.mainPath(host));
      const auxiliary = hostFiles.find((file) => file.relativePath === this.auxiliaryPath(host));
      const mainContent = contents.get(this.mainPath(host)) ?? "";
      const instructionEffective = main?.state === "current_pristine"
        || (host === "claude-code" && auxiliary?.state === "current_pristine" && hasExactLine(mainContent, EXACT_CLAUDE_LINK));
      const requiredPristine = hostFiles.filter((file) =>
        file.relativePath !== this.auxiliaryPath(host) && file.relativePath !== this.mainPath(host))
        .every((file) => file.state === "current_pristine");
      const usability = !discoverable ? "blocked" : requiredPristine && instructionEffective ? "ready" : "degraded";
      usableBy[host] = usability;
      const action: AgentKitNextAction = usability === "ready" ? "none"
        : !discoverable ? router?.nextAction ?? "install"
          : host === "claude-code" && main?.state === "foreign" ? "link"
            : main?.state === "foreign" ? "manual_merge"
              : hostFiles.find((file) => file.nextAction !== "none")?.nextAction ?? "none";
      const detail = usability === "ready"
        ? "VidCom instructions and native router are current."
        : action === "link"
          ? `Append ${EXACT_CLAUDE_LINK} to ${this.mainPath(host)}`
          : action === "manual_merge"
            ? `Merge ${this.auxiliaryPath(host)} into ${this.mainPath(host)}`
            : `Host is ${usability}; follow ${action}.`;
      recovery.push({ host, action, detail });
    }
    const values = Object.values(usableBy);
    const allRequiredPristine = hosts.every((host) => files
      .filter((file) => file.host === host && file.relativePath !== this.auxiliaryPath(host))
      .every((file) => file.state === "current_pristine"));
    const outcome = values.every((value) => value === "blocked") ? "blocked"
      : allRequiredPristine ? "installed" : "partial";
    return ok({ outcome, files, usableBy, recovery });
  }

  private manifest(host: AgentKitHost, includeAuxiliary: boolean): ManifestFile[] {
    const skillRoot = host === "codex" ? ".agents/skills" : ".claude/skills";
    const files: ManifestFile[] = [
      { path: this.mainPath(host), source: "AGENTS.md", role: "main" },
      ...SKILLS.map((name): ManifestFile => ({
        path: `${skillRoot}/${name}/SKILL.md` as RelPath,
        source: `skills/${name}/SKILL.md`,
        role: name === "vidcom" ? "router" : "skill",
      })),
      ...SKILLS.map((name): ManifestFile => ({
        path: `${skillRoot}/${name}/agents/openai.yaml` as RelPath,
        source: `skills/${name}/agents/openai.yaml`,
        role: "skill",
      })),
    ];
    if (includeAuxiliary) files.push({ path: this.auxiliaryPath(host), source: "AGENTS.md", role: "auxiliary" });
    return files;
  }

  private source(path: string): AgentKitSourceFile {
    const source = this.dependencies.bundle.files[path];
    if (!source) throw new Error(`agent-kit bundle is missing ${path}`);
    return source;
  }
  private mainPath(host: AgentKitHost): RelPath { return (host === "codex" ? "AGENTS.md" : "CLAUDE.md") as RelPath; }
  private auxiliaryPath(host: AgentKitHost): RelPath { return (host === "codex" ? "AGENTS.vidcom.md" : "CLAUDE.vidcom.md") as RelPath; }
  private routerPath(host: AgentKitHost): RelPath { return `${host === "codex" ? ".agents" : ".claude"}/skills/vidcom/SKILL.md` as RelPath; }
  private async read(workspaceRoot: AbsolutePath, path: RelPath): Promise<Result<{ content: string; contentHash: ContentHash } | null, DomainError>> {
    const resolved = await this.dependencies.workspace.resolveWorkspace(workspaceRoot, path, "workspace-agent-kit");
    if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "agent-kit path was rejected", details: { path } });
    return ok(await this.dependencies.workspace.readFile(resolved.value));
  }
}

export function classifyAgentKitFile(content: string | null, contentHash: ContentHash | null, bundledHash: ContentHash, currentVersion: number): AgentKitFileStateKind {
  return classify(content, contentHash, bundledHash, currentVersion);
}
function classify(content: string | null, contentHash: ContentHash | null, bundledHash: ContentHash, currentVersion: number): AgentKitFileStateKind {
  if (content === null || contentHash === null) return "missing";
  const marker = markerVersion(content);
  if (marker === null) return "foreign";
  if (marker > currentVersion) return "newer";
  if (marker < currentVersion) return "outdated";
  return contentHash === bundledHash ? "current_pristine" : "current_modified";
}
function markerVersion(content: string): number | null {
  const value = /(?:^|\n)(?:(?:<!--|#)\s*)?x-vidcom-agent-kit:\s*(\d+)/u.exec(content)?.[1];
  return value === undefined ? null : Number(value);
}
function hasRouterFrontmatter(content: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "";
  return /^name:\s*vidcom\s*$/mu.test(frontmatter);
}
function hasExactLine(content: string, line: string): boolean { return content.split(/\r?\n/u).includes(line); }
function nextAction(state: AgentKitFileStateKind, role: ManifestFile["role"], host: AgentKitHost): AgentKitNextAction {
  if (state === "current_pristine") return "none";
  if (state === "missing") return "install";
  if (state === "foreign") return role === "main" ? host === "claude-code" ? "link" : "manual_merge" : "manual_merge";
  if (state === "newer") return "none";
  return "replace";
}
