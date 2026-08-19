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
  type ProjectRef,
  type VerifiedCatalogItem,
} from "@vidcom/core";

const ENTRY = "blocks/lower-third/index.html" as RelPath;
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
} = {}): Harness {
  const state: HarnessState = { materializeCalls: 0, releases: 0, reserved: [], mutations: [] };
  const targets = options.targets ?? { [ENTRY]: null };
  const dependencies: CatalogInstallExecuteDependencies = {
    workspace: {
      readProjectRef: async () => ref,
      resolve: async (_ref: ProjectRef, path: RelPath) => ({ ok: true as const, value: path as never }),
      readHash: async (resolved: never) => {
        const path = resolved as unknown as RelPath;
        if (path === ref.entry) return ROOT_HASH;
        if (path === "compositions/scene-1.html") return hash("b".repeat(64));
        return targets[path] ?? null;
      },
    } as CatalogInstallDependencies["workspace"],
    composition: {
      parseProject: async () => model,
      applyOps: async () => ({ ok: true as const, value: "<main/>" }),
    } as CatalogInstallDependencies["composition"],
    journal: { latestRevision: async () => options.latestRevision ?? 5 } as CatalogInstallDependencies["journal"],
    catalog: {
      materialize: async () => {
        state.materializeCalls += 1;
        return {
          ok: true as const,
          value: {
            item,
            files: files(),
            release: async () => { state.releases += 1; },
          },
        };
      },
    },
    installedProvenance: async () => options.installed ?? null,
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
});
