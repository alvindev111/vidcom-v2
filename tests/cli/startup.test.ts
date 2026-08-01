import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runStartupSequence, startVidcomFoundation, StartupError, type StartupStepName } from "@vidcom/cli";
import type { AbsolutePath } from "@vidcom/core";
import { createFixedClock, createSequentialIdPort } from "../support/deterministic";

const ordered = [
  "migration",
  "lease",
  "reconciliation",
  "job-recovery",
  "identity-backfill",
  "scheduler",
  "watcher",
  "listener",
] as const;

function steps(log: string[], fail?: StartupStepName) {
  const run = (name: StartupStepName) => async () => {
    log.push(name);
    if (name === fail) throw new Error(`${name} failed`);
  };
  return {
    migration: run("migration"),
    lease: run("lease"),
    reconciliation: run("reconciliation"),
    jobRecovery: run("job-recovery"),
    identityBackfill: run("identity-backfill"),
    scheduler: run("scheduler"),
    watcher: run("watcher"),
    listener: async () => { await run("listener")(); return "listener"; },
  };
}

describe("startup order", () => {
  it("runs every prerequisite before opening the listener", async () => {
    const log: string[] = [];
    await expect(runStartupSequence(steps(log))).resolves.toBe("listener");
    expect(log).toEqual(ordered);
  });

  it.each(ordered.slice(0, -1))("does not open listener when %s fails", async (failed) => {
    const log: string[] = [];
    await expect(runStartupSequence(steps(log, failed))).rejects.toMatchObject({
      name: "StartupError",
      step: failed,
    });
    expect(log).not.toContain("listener");
    expect(log).toEqual(ordered.slice(0, ordered.indexOf(failed) + 1));
  });

  it("maps listener bind failure to a named startup error", async () => {
    const log: string[] = [];
    await expect(runStartupSequence(steps(log, "listener"))).rejects.toEqual(
      expect.objectContaining<Partial<StartupError>>({ step: "listener" }),
    );
  });

  it("integrates migration, lease, reconciliation and identity backfill before listener", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-startup-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "project");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>');
    const hooks: string[] = [];
    try {
      const runtime = await startVidcomFoundation({
        appDataRoot: path.join(root, "app-data"),
        workspaceRoot: workspace as AbsolutePath,
        holderId: "test:1:boot",
        clock: createFixedClock("2026-08-01T00:00:00.000Z"),
        ids: createSequentialIdPort(),
      }, {
        async recoverJobs() { hooks.push("jobs"); },
        async startScheduler() { hooks.push("scheduler"); },
        async startWatcher() { hooks.push("watcher"); },
        async openListener() { hooks.push("listener"); return { port: 4321 }; },
      });
      expect(hooks).toEqual(["jobs", "scheduler", "watcher", "listener"]);
      expect(JSON.parse(await readFile(path.join(project, "vidcom.json"), "utf8"))).toEqual({ id: "project_0002" });
      expect(runtime.listener).toEqual({ port: 4321 });
      await runtime.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
