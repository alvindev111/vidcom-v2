import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DaemonDiscoveryStore,
  migrateDatabase,
  openVidcomDatabase,
  RuntimeAssetManager,
} from "@vidcom/adapter";
import { DOCTOR_CHECK_ORDER, doctorExitCode, runDoctorChecks } from "@vidcom/core";
import {
  createDoctorChecks,
  createDoctorContext,
  doctorCheckIsRequired,
  repairRuntime,
  startServing,
  type ServingDaemon,
} from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

import { archiveFor, assetSource, HOST_SUPPORTED, runtimeManifest } from "../support/runtime-fixture";

const contexts: Array<{ close(): Promise<void> }> = [];

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  // Windows holds the database file until every handle is gone, and the temp
  // cleanup below is what finds out.
  for (const context of contexts.splice(0)) await context.close();
  delete process.env.VIDCOM_APP_DATA;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<{ appData: string; workspace: string }> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-doctor-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const appData = path.join(root, "app-data");
  process.env.VIDCOM_APP_DATA = appData;
  return { appData, workspace };
}

describe("doctor against a real install", () => {
  it.skipIf(!HOST_SUPPORTED)("reads the current version's manifest targets through RuntimePaths", async () => {
    const { appData } = await scratch();
    const executableSuffix = process.platform === "win32" ? ".exe" : "";
    const node = archiveFor("node", [{
      path: `bin/ffmpeg${executableSuffix}`,
      content: Buffer.from("#!/bin/sh\necho 'ffmpeg fixture 1.0'\n", "utf8"),
      mode: 0o755,
    }], undefined, "toolchain/native");
    const hyperframes = archiveFor("hyperframes", [
      { path: "package.json", content: Buffer.from('{"name":"hyperframes","version":"1.0.0"}\n') },
      { path: "bin/hyperframes.mjs", content: Buffer.from("export {};\n") },
      { path: "motion-libraries/gsap/package.json", content: Buffer.from('{"name":"gsap"}\n') },
    ], undefined, "toolchain/hyperframes");
    const manifest = runtimeManifest("1.2.3", [node.archive, hyperframes.archive]);
    await new RuntimeAssetManager({
      appDataRoot: appData,
      source: assetSource(manifest, { node: node.bytes, hyperframes: hyperframes.bytes }),
    }).ensureAll();
    const database = openVidcomDatabase(appData);
    await migrateDatabase(database);
    await database.destroy();

    const context = await createDoctorContext({ deep: true, appDataRoot: appData });
    contexts.push(context);
    const report = await runDoctorChecks(createDoctorChecks(), context, {
      platform: context.platform,
    });
    const byId = new Map(report.items.map((item) => [item.id, item]));

    expect(byId.get("db.migration")?.status).toBe("ok");
    expect(byId.get("runtime.manifest")?.status).toBe("ok");
    expect(byId.get("runtime.hyperframes")?.status).toBe("ok");
    expect(byId.get("runtime.motion")?.status).toBe("ok");
    expect(byId.get("runtime.esbuild-binary")?.detail)
      .toContain(path.join("native", "1.2.3", "toolchain", "native", "bin", "esbuild"));
    if (process.platform !== "win32") {
      expect(byId.get("runtime.ffmpeg")?.status).toBe("ok");
      expect(byId.get("runtime.ffmpeg")?.detail).toContain("ffmpeg fixture 1.0");
    }
  }, 60_000);

  it.skipIf(!HOST_SUPPORTED || process.platform === "win32")(
    "never executes through an escaped post-publication runtime target",
    async () => {
      const { appData } = await scratch();
      const root = path.dirname(appData);
      const executed = path.join(root, "outside-runtime-executed");
      const node = archiveFor("node", [{
        path: "bin/ffmpeg",
        content: Buffer.from(
          `#!/bin/sh\n: > ${JSON.stringify(executed)}\nprintf 'escaped ffmpeg\\n'\n`,
          "utf8",
        ),
        mode: 0o755,
      }], undefined, "layers/toolchain/native");
      const hyperframes = archiveFor("hyperframes", [
        { path: "package.json", content: Buffer.from('{"name":"hyperframes"}\n') },
        { path: "bin/hyperframes.mjs", content: Buffer.from("export {};\n") },
        { path: "motion-libraries/gsap/package.json", content: Buffer.from('{"name":"gsap"}\n') },
      ], undefined, "layers/hyperframes");
      const manifest = runtimeManifest("1.2.3", [node.archive, hyperframes.archive]);
      const installed = await new RuntimeAssetManager({
        appDataRoot: appData,
        source: assetSource(manifest, { node: node.bytes, hyperframes: hyperframes.bytes }),
      }).ensureAll();
      const layers = path.join(installed.versionRoot, "layers");
      const outside = path.join(root, "escaped-layers");
      await rename(layers, outside);
      await symlink(outside, layers);

      const context = await createDoctorContext({ deep: true, appDataRoot: appData });
      contexts.push(context);
      expect((await context.probes.runtimeManifest()).ok).toBe(false);
      expect((await context.probes.ffmpeg()).ok).toBe(false);
      await expect(access(executed)).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000,
  );

  it("reports every check against real app-data and real SQLite", async () => {
    const { appData } = await scratch();
    const context = await createDoctorContext({ deep: false, appDataRoot: appData });
    contexts.push(context);
    const report = await runDoctorChecks(createDoctorChecks(), context, {
      platform: context.platform,
    });
    expect(report.items.map((item) => item.id)).toEqual([...DOCTOR_CHECK_ORDER]);

    const byId = new Map(report.items.map((item) => [item.id, item]));
    expect(byId.get("app-data.writable")?.status).toBe("ok");
    expect(byId.get("port.available")?.status).toBe("ok");
    // Opening the database does not migrate it, and `foreign_key_check` is
    // perfectly happy with an empty one — so the schema is checked first, or
    // doctor calls an unmigrated install healthy and every later probe reads
    // from a table that is not there.
    expect(byId.get("db.migration")?.status).toBe("missing");
    // Nothing has run here yet, and every skip is read from data rather than
    // assumed — including from a database that has no tables at all.
    expect(byId.get("chrome.cache")?.status).toBe("skipped");
    expect(byId.get("workspace.active")?.status).toBe("skipped");
  }, 60_000);

  it("fails the command because the runtime archive was never extracted", async () => {
    // The honest answer for a source checkout: the archive is what a packaged
    // build unpacks, and reporting green here would call an install healthy
    // that cannot render a frame.
    const { appData } = await scratch();
    const context = await createDoctorContext({ deep: false, appDataRoot: appData });
    contexts.push(context);
    const report = await runDoctorChecks(createDoctorChecks(), context, {
      platform: context.platform,
    });
    expect(report.items.find((item) => item.id === "runtime.ffmpeg")?.status).toBe("missing");
    expect(doctorExitCode(report, doctorCheckIsRequired)).toBe(1);
  }, 60_000);

  it("refuses to repair while a real daemon is holding the files", async () => {
    // Not caution: on Windows the daemon holds exactly the files a repair
    // replaces, so a swap that starts anyway leaves a tree that is neither the
    // old install nor the new one.
    const { appData, workspace } = await scratch();
    const daemon = await startServing({ workspace });
    daemons.push(daemon);

    let reextracted = false;
    const outcome = await repairRuntime(
      [{ id: "runtime.ffmpeg", status: "missing", detail: "not there", remedy: "re-extract" }],
      {
        appDataRoot: appData,
        activeWorkspace: () => Promise.resolve(daemon.workspaceRoot),
        discovery: new DaemonDiscoveryStore(appData),
        reextract: () => { reextracted = true; return Promise.resolve(); },
      },
    );
    expect(reextracted).toBe(false);
    expect(outcome.items[0]?.remedy).toContain("stop the app");
    expect(outcome.items[0]?.remedy).toContain(daemon.instanceId);
  }, 90_000);

  it("allows the repair once the daemon has gone", async () => {
    const { appData, workspace } = await scratch();
    const daemon = await startServing({ workspace });
    await daemon.stop();

    let reextracted = false;
    await repairRuntime(
      [{ id: "runtime.ffmpeg", status: "missing", detail: "not there", remedy: "re-extract" }],
      {
        appDataRoot: appData,
        activeWorkspace: () => Promise.resolve(daemon.workspaceRoot),
        discovery: new DaemonDiscoveryStore(appData),
        reextract: () => { reextracted = true; return Promise.resolve(); },
      },
    );
    // The daemon removes its record before releasing the lease, so "gone" is
    // observable rather than a guess about timing.
    expect(reextracted).toBe(true);
  }, 90_000);
});
