import type { ProjectId, RelPath } from "@vidcom/contracts";

import type { AbsolutePath, ProjectRef } from "../domain/models";
import type { PlatformConfig } from "../domain/platform-preset";
import type { CompositionPort, WorkspacePort } from "../port/ports";
import { EntryRegistry, type EntryId } from "../service/entry-registry";
import { ProjectIdentityService, type IdentityReadResult, type InvalidReason } from "./project-identity";

export type ProjectState = "empty" | "authored" | "invalid";

export type WorkspaceEntry =
  | { kind: "project"; projectId: ProjectId; slug: string; state: "empty" | "authored";
      platform: PlatformConfig | null; sceneCount: number }
  | { kind: "project"; projectId: ProjectId; slug: string; state: "invalid";
      invalidKind: "composition"; invalidReason: InvalidReason }
  | { kind: "project"; projectId: null; entryId: EntryId; slug: string; state: "invalid";
      invalidKind: "identity"; invalidReason: InvalidReason }
  | { kind: "candidate"; slug: string };

export interface ScanWorkspaceDependencies {
  workspace: WorkspacePort;
  identity: ProjectIdentityService;
  entries: EntryRegistry;
  composition: CompositionPort;
}

interface MarkerStat { size: number; modifiedAtMs: number }
const ignored = new Set(["node_modules", ".git", ".hyperframes"]);

function cacheKey(root: AbsolutePath, stat: MarkerStat): string {
  return `${root}\0${stat.modifiedAtMs}\0${stat.size}`;
}

class WorkspaceScanner {
  private readonly identityCache = new Map<string, IdentityReadResult>();
  private readonly compositionCache = new Map<string, { sceneCount: number } | InvalidReason>();
  private readonly invalidEntries = new Map<string, EntryId>();

  constructor(private readonly dependencies: ScanWorkspaceDependencies) {}

  async scan(root: AbsolutePath): Promise<WorkspaceEntry[]> {
    const list = this.dependencies.workspace.listWorkspaceDirectories;
    const stat = this.dependencies.workspace.statWorkspaceFile;
    if (!list || !stat) throw new TypeError("workspace scanner capabilities are unavailable");
    const directories = await list.call(this.dependencies.workspace, root);
    const scanned = await Promise.all(directories.map(async (directory): Promise<WorkspaceEntry | null> => {
      const lower = directory.slug.toLowerCase();
      if (directory.slug.startsWith(".") || ignored.has(lower)) return null;
      const [identityStat, markerStat, indexStat] = await Promise.all([
        stat.call(this.dependencies.workspace, directory.root, "vidcom.json"),
        stat.call(this.dependencies.workspace, directory.root, "hyperframes.json"),
        stat.call(this.dependencies.workspace, directory.root, "index.html"),
      ]);
      if (!identityStat) {
        return markerStat ? { kind: "candidate", slug: directory.slug } : null;
      }
      const identityKey = cacheKey(directory.root, identityStat);
      let identity = this.identityCache.get(identityKey);
      if (!identity) {
        identity = await this.dependencies.identity.read(directory.root);
        this.identityCache.set(identityKey, identity);
      }
      const locationKey = `${root}\0${directory.slug}`;
      if (!identity.ok) {
        const entryId = this.dependencies.entries.mint(root, directory.slug, directory.root);
        this.invalidEntries.set(locationKey, entryId);
        return {
          kind: "project",
          projectId: null,
          entryId,
          slug: directory.slug,
          state: "invalid",
          invalidKind: "identity",
          invalidReason: identity.reason,
        };
      }
      const previousEntry = this.invalidEntries.get(locationKey);
      if (previousEntry) {
        this.dependencies.entries.revoke(previousEntry);
        this.invalidEntries.delete(locationKey);
      }
      if (!indexStat) {
        return {
          kind: "project",
          projectId: identity.identity.id,
          slug: directory.slug,
          state: "empty",
          platform: identity.identity.platform,
          sceneCount: 0,
        };
      }
      const compositionKey = cacheKey(directory.root, indexStat);
      let parsed = this.compositionCache.get(compositionKey);
      if (!parsed) {
        const ref: ProjectRef = {
          id: identity.identity.id,
          slug: directory.slug,
          root: directory.root,
          entry: "index.html" as RelPath,
        };
        try {
          const source = await this.dependencies.workspace.readWorkspaceFile?.(directory.root, "index.html") ?? null;
          if (!source) throw new Error("composition disappeared during scan");
          if (this.dependencies.composition.validateSource) {
            const valid = await this.dependencies.composition.validateSource(ref.entry, source.content);
            if (!valid.ok) throw new Error("composition validation failed");
          }
          const model = await this.dependencies.composition.parseProject(ref);
          parsed = { sceneCount: model.scenes.length };
        } catch {
          parsed = { code: "composition_parse_error" };
        }
        this.compositionCache.set(compositionKey, parsed);
      }
      if ("code" in parsed) {
        return {
          kind: "project",
          projectId: identity.identity.id,
          slug: directory.slug,
          state: "invalid",
          invalidKind: "composition",
          invalidReason: parsed,
        };
      }
      return {
        kind: "project",
        projectId: identity.identity.id,
        slug: directory.slug,
        state: "authored",
        platform: identity.identity.platform,
        sceneCount: parsed.sceneCount,
      };
    }));
    return scanned.filter((entry): entry is WorkspaceEntry => entry !== null);
  }
}

const scanners = new WeakMap<WorkspacePort, WorkspaceScanner>();

/** Scans exactly one workspace level while retaining parse caches across warm scans. */
export function scanWorkspace(
  dependencies: ScanWorkspaceDependencies,
  root: AbsolutePath,
): Promise<WorkspaceEntry[]> {
  let scanner = scanners.get(dependencies.workspace);
  if (!scanner) {
    scanner = new WorkspaceScanner(dependencies);
    scanners.set(dependencies.workspace, scanner);
  }
  return scanner.scan(root);
}
