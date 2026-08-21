import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  CATALOG_INSTALL_TOOL,
  executeCatalogInstall,
  prepareCatalogInstall,
  type AbsolutePath,
  type CatalogInstallDependencies,
  type CatalogInstallExecuteDependencies,
  type CatalogInstallIntent,
  type CatalogMaterializedFile,
  type CatalogProvenance,
  type CompositeRequest,
  type GrantBinding,
  type PathPurpose,
  type ProjectRef,
  type VerifiedCatalogItem,
} from "@vidcom/core";

const ENTRY = "blocks/lower-third/index.html" as RelPath;
const POSTER = "blocks/lower-third/poster.png" as RelPath;
const FONT = "blocks/lower-third/font.woff2" as RelPath;
const MANIFEST = "c".repeat(64);
const DIGEST = "a".repeat(64);
const hash = (digest: string) => `sha256:${digest}` as ContentHash;
const ROOT_HASH = hash("e".repeat(64));

const ref = {
  id: "project_x" as ProjectId,
  slug: "x",
  root: "/w/x" as AbsolutePath,
  entry: "index.html" as RelPath,
} as ProjectRef;

const item: VerifiedCatalogItem = {
  name: "lower-third",
  kind: "block",
  title: "Lower third",
  description: null,
  tags: ["social"],
  category: "Social",
  version: "1.2.0",
  integrity: { algo: "sha256", files: { [ENTRY]: DIGEST }, manifest: MANIFEST },
  materialization: "verified",
  source: { registry: "bundled", url: null, revision: null, committedAt: null },
  dependencies: [],
  compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
  durationSeconds: 4,
  entry: ENTRY,
  preview: null,
} as VerifiedCatalogItem;

const files = (): CatalogMaterializedFile[] => [{
  path: ENTRY,
  contentHash: hash(DIGEST),
  source: { sourcePath: "/app/cache/entry" as AbsolutePath, contentHash: hash(DIGEST) },
  encoding: "utf8",
}];

const model = {
  project: { id: "project_x", width: 1920, height: 1080, duration: 4, sceneCount: 1 },
  scenes: [{ id: "scene-1", src: "compositions/scene-1.html", start: 0, duration: 4, trackIndex: 0 }],
} as never;

const intent: CatalogInstallIntent = {
  projectId: "project_x" as ProjectId,
  name: "lower-third",
  version: "1.2.0",
  mount: { kind: "new-scene", toIndex: 1 },
  expectedRevision: 5,
};

const origin = {
  kind: "ui" as const,
  sessionId: "s",
  label: "Install lower-third",
  historyAction: "record" as const,
  historyOperation: null,
};

interface HarnessState {
  materializeCalls: number;
  releases: number;
  pins: number;
  resolutions: Array<{ path: RelPath; purpose: PathPurpose }>;
  reserved: GrantBinding[];
  mutations: CompositeRequest[];
}

interface Harness {
  dependencies: CatalogInstallExecuteDependencies;
  /** Live counters: the tests read this object, never a copy of it. */
  state: HarnessState;
}

function harness(options: {
  targets?: Record<RelPath, ContentHash | null>;
  installed?: CatalogProvenance | null;
  latestRevision?: number;
  reserve?: "ok" | "invalid";
  mutate?: "ok" | "conflict";
  manifestDigest?: string;
  parseThrows?: boolean;
  readHashThrows?: boolean;
  installedThrows?: boolean;
  catalogItem?: VerifiedCatalogItem;
  catalogFiles?: CatalogMaterializedFile[];
} = {}): Harness {
  const state: HarnessState = {
    materializeCalls: 0,
    releases: 0,
    pins: 0,
    resolutions: [],
    reserved: [],
    mutations: [],
  };
  const targets = options.targets ?? { [ENTRY]: null };
  const dependencies: CatalogInstallExecuteDependencies = {
    workspace: {
      readProjectRef: async () => ref,
      resolve: async (_ref: ProjectRef, path: RelPath, purpose: PathPurpose) => {
        state.resolutions.push({ path, purpose });
        if (/\.(?:png|woff2)$/u.test(path) && (purpose as string) !== "read-package-target") {
          return { ok: false as const, error: { reason: "not_allowed_for_purpose" as const } };
        }
        return { ok: true as const, value: path as never };
      },
      readHash: async (resolved: never) => {
        if (options.readHashThrows) throw new Error("hash adapter failed");
        const path = resolved as unknown as RelPath;
        if (path === ref.entry) return ROOT_HASH;
        if (path === "compositions/scene-1.html") return hash("b".repeat(64));
        return targets[path] ?? null;
      },
    } as CatalogInstallDependencies["workspace"],
    composition: {
      parseProject: async () => {
        if (options.parseThrows) throw new Error("parse failed");
        return model;
      },
      applyOps: async () => ({ ok: true as const, value: "<main/>" }),
    } as CatalogInstallDependencies["composition"],
    journal: { latestRevision: async () => options.latestRevision ?? 5 } as CatalogInstallDependencies["journal"],
    catalog: {
      materialize: async () => {
        state.materializeCalls += 1;
        state.pins += 1;
        let released = false;
        return {
          ok: true as const,
          value: {
            item: options.catalogItem ?? item,
            files: options.catalogFiles ?? files(),
            release: async () => {
              if (released) throw new Error("catalog pin released twice");
              released = true;
              state.pins -= 1;
              state.releases += 1;
            },
          },
        };
      },
    },
    installedProvenance: async () => {
      if (options.installedThrows) throw new Error("installed provenance failed");
      return options.installed ?? null;
    },
    hashContent: (content) => hash(
      `${String(content).length.toString(16).padStart(64, "0")}`.slice(-64),
    ),
    manifestDigest: () => options.manifestDigest ?? MANIFEST,
    clock: { now: () => new Date("2026-08-19T00:00:00.000Z") },
    approval: {
      planReserve: async (_grantId: string, binding: GrantBinding) => {
        state.reserved.push(binding);
        return options.reserve === "invalid"
          ? { ok: false as const, error: { code: ErrorCode.ApprovalInvalid, message: "binding mismatch" } }
          : { ok: true as const, value: undefined };
      },
    },
    authority: {
      mutateSource: async (request: CompositeRequest) => {
        state.mutations.push(request);
        return options.mutate === "conflict"
          ? { ok: false as const, error: { code: ErrorCode.WriteConflict, message: "changed" } }
          : {
              ok: true as const,
              value: {
                projectRevision: 6,
                entityRevision: null,
                fileHashes: {},
                diagnostics: [],
                changeSeq: 12,
              } as never,
            };
      },
    },
  };
  return { dependencies, state };
}

describe("exact-intent catalog install", () => {
  it("prepares a bound plan and holds nothing while the author decides", async () => {
    const harnessed = harness();
    const prepared = await prepareCatalogInstall(harnessed.dependencies, intent);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value.status !== "ready") throw new Error("expected a ready preparation");
    expect(prepared.value.binding.tool).toBe(CATALOG_INSTALL_TOOL);
    expect(prepared.value.binding.expectedRevision).toBe(5);
    // The root entry is an existing mutation target, so its real hash is bound;
    // the absent package file is not invented into targetHashes.
    expect(prepared.value.binding.targetHashes).toEqual({ [ref.entry]: ROOT_HASH });
    expect(prepared.value.plan.files).toEqual([
      { path: ENTRY, action: "create", fromHash: null, toDigest: DIGEST },
    ]);
    // Materialized once, and the pin is released before this call returns.
    expect(harnessed.state.materializeCalls).toBe(1);
    expect(harnessed.state.releases).toBe(1);
  });

  it("refuses a stale revision before materializing anything", async () => {
    const harnessed = harness({ latestRevision: 9 });
    const prepared = await prepareCatalogInstall(harnessed.dependencies, intent);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe(ErrorCode.WriteConflict);
  });

  it("asks for a choice instead of planning when the package is already installed", async () => {
    const harnessed = harness({
      targets: { [ENTRY]: hash(DIGEST) },
      installed: {
        name: "lower-third",
        title: "Lower third",
        description: null,
        category: "Social",
        tags: ["social"],
        registry: "bundled",
        version: "1.2.0",
        integrity: MANIFEST,
      },
    });
    const prepared = await prepareCatalogInstall(harnessed.dependencies, intent);
    if (!prepared.ok || prepared.value.status !== "choice_required") throw new Error("expected a question");
    expect(prepared.value.decision.comparison).toBe("identical");
    expect(prepared.value.decision.choices).toEqual(["reuse", "skip"]);
  });

  it("reserves the identical binding and mutates exactly once", async () => {
    const harnessed = harness();
    const prepared = await prepareCatalogInstall(harnessed.dependencies, intent);
    if (!prepared.ok || prepared.value.status !== "ready") throw new Error("expected a plan");
    const executed = await executeCatalogInstall(
      harnessed.dependencies,
      { intent, grantId: "grant_1" },
      "user",
      { origin, toolAudit: null },
    );
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.packageStatus).toBe("installed");
    expect(executed.value.sceneId).toBe("scene-2");
    expect(executed.value.provenance).toMatchObject({ name: "lower-third", integrity: MANIFEST });
    const state = harnessed.state;
    // The grant is reserved with the binding prepare computed, byte for byte.
    expect(state.reserved).toHaveLength(1);
    expect(state.reserved[0]).toEqual(prepared.value.binding);
    expect(state.mutations).toHaveLength(1);
    expect(state.mutations[0]!.grant).toEqual({ id: "grant_1", binding: prepared.value.binding });
    expect(state.mutations[0]!.steps.map((step) => step.kind))
      .toEqual(["mkdir", "mkdir", "write-staged", "write", "write", "write"]);
  });

  it("never mutates when the grant does not match and still releases the pin", async () => {
    const harnessed = harness({ reserve: "invalid" });
    const executed = await executeCatalogInstall(
      harnessed.dependencies,
      { intent, grantId: "grant_1" },
      "user",
      { origin, toolAudit: null },
    );
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.error.code).toBe(ErrorCode.ApprovalInvalid);
    const state = harnessed.state;
    expect(state.mutations).toEqual([]);
    expect(state.releases).toBeGreaterThan(0);
  });

  it("releases the pin when the authority rejects the mutation", async () => {
    const harnessed = harness({ mutate: "conflict" });
    const executed = await executeCatalogInstall(
      harnessed.dependencies,
      { intent, grantId: "grant_1" },
      "user",
      { origin, toolAudit: null },
    );
    expect(executed.ok).toBe(false);
    const state = harnessed.state;
    expect(state.releases).toBeGreaterThan(0);
  });

  it("refuses a package whose recomputed manifest digest does not match", async () => {
    const harnessed = harness({ manifestDigest: "9".repeat(64) });
    const prepared = await prepareCatalogInstall(harnessed.dependencies, intent);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.code).toBe(ErrorCode.IntegrityMismatch);
    const executed = await executeCatalogInstall(
      harnessed.dependencies,
      { intent, grantId: "grant_1" },
      "user",
      { origin, toolAudit: null },
    );
    expect(executed.ok).toBe(false);
    const state = harnessed.state;
    expect(state.mutations).toEqual([]);
    expect(state.pins).toBe(0);
  });

  it("releases the materialized pin on every direct planner rejection", async () => {
    const installed: CatalogProvenance = {
      name: "lower-third",
      title: "Lower third",
      description: null,
      category: "Social",
      tags: ["social"],
      registry: "bundled",
      version: "1.2.0",
      integrity: MANIFEST,
    };
    const cases: Array<{ harnessed: Harness; candidate: CatalogInstallIntent }> = [
      { harnessed: harness({ manifestDigest: "9".repeat(64) }), candidate: intent },
      { harnessed: harness({ parseThrows: true }), candidate: intent },
      {
        harnessed: harness({ targets: { [ENTRY]: hash(DIGEST) }, installed }),
        candidate: { ...intent, existingPolicy: "replace" },
      },
      {
        harnessed: harness({ catalogItem: { ...item, kind: "template" } }),
        candidate: { ...intent, mount: { kind: "into-scene", sceneId: "scene-1" } },
      },
    ];
    for (const { harnessed, candidate } of cases) {
      const prepared = await prepareCatalogInstall(harnessed.dependencies, candidate);
      expect(prepared.ok).toBe(false);
      expect(harnessed.state.pins).toBe(0);
      expect(harnessed.state.releases).toBe(1);
    }
  });

  it("releases the pin on abort and thrown adapter errors", async () => {
    const aborted = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(prepareCatalogInstall(aborted.dependencies, intent, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(aborted.state.pins).toBe(0);

    for (const harnessed of [harness({ readHashThrows: true }), harness({ installedThrows: true })]) {
      await expect(prepareCatalogInstall(harnessed.dependencies, intent)).rejects.toBeDefined();
      expect(harnessed.state.pins).toBe(0);
    }
  });

  it("binds a different digest for a moved mount, so a grant cannot be reused", async () => {
    const harnessed = harness();
    const first = await prepareCatalogInstall(harnessed.dependencies, intent);
    const moved = await prepareCatalogInstall(harnessed.dependencies, {
      ...intent,
      mount: { kind: "new-scene", toIndex: 0 },
    });
    if (!first.ok || first.value.status !== "ready") throw new Error("expected a plan");
    if (!moved.ok || moved.value.status !== "ready") throw new Error("expected a plan");
    expect(moved.value.binding.target).not.toBe(first.value.binding.target);
  });

  it("distinguishes binary package targets from absent files across create/reuse/replace/skip", async () => {
    const digests = {
      [ENTRY]: DIGEST,
      [POSTER]: "b".repeat(64),
      [FONT]: "d".repeat(64),
    } as Record<RelPath, string>;
    const binaryItem = {
      ...item,
      integrity: { ...item.integrity, files: digests },
    } as VerifiedCatalogItem;
    const binaryFiles = (Object.entries(digests) as Array<[RelPath, string]>).map(([path, digest]) => ({
      path,
      contentHash: hash(digest),
      source: { sourcePath: `/app/cache/${path.split("/").at(-1)}` as AbsolutePath, contentHash: hash(digest) },
      encoding: path.endsWith(".html") ? "utf8" as const : "binary" as const,
    }));
    const provenance = {
      name: item.name,
      title: item.title,
      description: item.description,
      category: item.category,
      tags: item.tags,
      registry: "bundled" as const,
      version: item.version,
      integrity: item.integrity.manifest,
    };

    const created = harness({
      catalogItem: binaryItem,
      catalogFiles: binaryFiles,
      targets: { [ENTRY]: null, [POSTER]: null, [FONT]: null },
    });
    const createPlan = await prepareCatalogInstall(created.dependencies, intent);
    if (!createPlan.ok || createPlan.value.status !== "ready") throw new Error("expected create plan");
    expect(createPlan.value.plan.files.map(({ action }) => action)).toEqual(["create", "create", "create"]);

    const reused = harness({
      catalogItem: binaryItem,
      catalogFiles: binaryFiles,
      targets: Object.fromEntries(Object.entries(digests).map(([path, digest]) => [path, hash(digest)])) as Record<RelPath, ContentHash>,
      installed: provenance,
    });
    const reusePlan = await prepareCatalogInstall(reused.dependencies, { ...intent, existingPolicy: "reuse" });
    if (!reusePlan.ok || reusePlan.value.status !== "ready") throw new Error("expected reuse plan");
    expect(reusePlan.value.plan.files.map(({ action }) => action)).toEqual(["reuse", "reuse", "reuse"]);
    expect(reused.state.resolutions.filter(({ path }) => path === POSTER || path === FONT))
      .toEqual(expect.arrayContaining([
        { path: POSTER, purpose: "read-package-target" },
        { path: FONT, purpose: "read-package-target" },
      ]));

    const changedTargets = Object.fromEntries(Object.keys(digests).map((path) => [path, hash("f".repeat(64))])) as Record<RelPath, ContentHash>;
    const older = { ...provenance, version: "1.1.0" };
    const replaced = harness({ catalogItem: binaryItem, catalogFiles: binaryFiles, targets: changedTargets, installed: older });
    const replacePlan = await prepareCatalogInstall(replaced.dependencies, { ...intent, existingPolicy: "replace" });
    if (!replacePlan.ok || replacePlan.value.status !== "ready") throw new Error("expected replace plan");
    expect(replacePlan.value.plan.files.map(({ action }) => action)).toEqual(["replace", "replace", "replace"]);

    const skipped = harness({ catalogItem: binaryItem, catalogFiles: binaryFiles, targets: changedTargets, installed: older });
    await expect(prepareCatalogInstall(skipped.dependencies, { ...intent, existingPolicy: "skip" }))
      .resolves.toEqual({ ok: true, value: { status: "skipped" } });
    expect(skipped.state.pins).toBe(0);
  });
});
