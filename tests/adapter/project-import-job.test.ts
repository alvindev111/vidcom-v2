import { createProjectImportJobType, type ProjectImportJobDependencies } from "@vidcom/worker";
import { describe, expect, it } from "vitest";

function context() {
  const progress: number[] = [];
  return {
    progress,
    job: {
      throwIfCancelled: () => Promise.resolve(),
      updateProgress: (fraction: number) => {
        progress.push(fraction);
        return Promise.resolve();
      },
    },
  };
}

function dependencies(overrides: Partial<ProjectImportJobDependencies> = {}) {
  const calls: string[] = [];
  const base: ProjectImportJobDependencies = {
    plan: () => {
      calls.push("plan");
      return Promise.resolve({ slug: "imported", target: "/w/imported", staging: "/w/.tmp" });
    },
    copy: () => {
      calls.push("copy");
      return Promise.resolve({ files: 3 });
    },
    commit: () => {
      calls.push("commit");
      return Promise.resolve();
    },
    discard: () => {
      calls.push("discard");
      return Promise.resolve();
    },
    backfill: () => {
      calls.push("backfill");
      return Promise.resolve();
    },
    ...overrides,
  };
  return { calls, base };
}

const input = { source: "/outside/fixture", workspaceRoot: "/w" };

describe("project import job", () => {
  it("stages, commits, then registers", async () => {
    // The order is the whole design. A copy written straight into the workspace
    // is visible to the watcher while it is still half a project, and a
    // backfill before the rename would register a path about to stop existing.
    const { calls, base } = dependencies();
    const job = createProjectImportJobType(base);
    const io = context();
    const output = await job.run(input, io.job as never);
    expect(calls).toEqual(["plan", "copy", "commit", "backfill"]);
    expect(output).toMatchObject({ slug: "imported", files: 3 });
    expect(io.progress.at(-1)).toBe(1);
  });

  it("cleans up its own staging when the copy fails", async () => {
    // Its own mess and nothing else: the source and everything already in the
    // workspace are off limits even on the failure path.
    const recorded: string[] = [];
    const { calls, base } = dependencies({
      copy: () => {
        recorded.push("copy");
        return Promise.reject(new Error("disk full"));
      },
    });
    await expect(createProjectImportJobType(base).run(input, context().job as never))
      .rejects.toThrow(/disk full/u);
    expect(calls).toEqual(["plan", "discard"]);
    expect(recorded).toEqual(["copy"]);
  });

  it("cleans up when the rename fails, and never registers", async () => {
    const { calls, base } = dependencies({
      commit: () => Promise.reject(new Error("target exists")),
    });

    await expect(createProjectImportJobType(base).run(input, context().job as never))
      .rejects.toThrow(/target exists/u);
    expect(calls).toEqual(["plan", "copy", "discard"]);
    expect(calls).not.toContain("backfill");
  });

  it("runs one at a time", () => {
    // Two imports racing can choose the same free slug, and the loser would
    // rename onto the directory the winner just created.
    expect(createProjectImportJobType(dependencies().base).concurrency).toBe(1);
  });

  it("is not idempotent, because a second run would import twice", () => {
    expect(createProjectImportJobType(dependencies().base).idempotent).toBe(false);
  });

  it("refuses input that names neither a source nor a workspace", async () => {
    await expect(createProjectImportJobType(dependencies().base).run({}, context().job as never))
      .rejects.toBeInstanceOf(TypeError);
  });
});
