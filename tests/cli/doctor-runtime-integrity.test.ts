import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  migrateDatabase,
  openVidcomDatabase,
  RUNTIME_CURRENT_FILENAME,
  RuntimeAssetManager,
} from "@vidcom/adapter";
import { DOCTOR_CHECK_ORDER, runDoctorChecks } from "@vidcom/core";
import { createDoctorChecks, createDoctorContext } from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

import { archiveFor, assetSource, HOST_SUPPORTED, runtimeManifest } from "../support/runtime-fixture";

const roots: string[] = [];
const contexts: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  delete process.env.VIDCOM_APP_DATA;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installRuntimeFixture(): Promise<{
  appDataRoot: string;
  root: string;
  runtimeFile: string;
  runtimeFileContent: Buffer;
}> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-doctor-integrity-")));
  roots.push(root);
  const appDataRoot = path.join(root, "app-data");
  process.env.VIDCOM_APP_DATA = appDataRoot;
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const runtimeFileContent = Buffer.from("#!/bin/sh\necho fixture\n", "utf8");
  const node = archiveFor("node", [{
    path: `bin/ffmpeg${executableSuffix}`,
    content: runtimeFileContent,
    mode: 0o755,
  }], undefined, "toolchain/native");
  const hyperframes = archiveFor("hyperframes", [
    { path: "package.json", content: Buffer.from('{"name":"hyperframes"}\n') },
    { path: "bin/hyperframes.mjs", content: Buffer.from("export {};\n") },
    { path: "motion-libraries/gsap/package.json", content: Buffer.from('{"name":"gsap"}\n') },
  ], undefined, "toolchain/hyperframes");
  const manifest = runtimeManifest("1.2.3", [node.archive, hyperframes.archive]);
  const installation = await new RuntimeAssetManager({
    appDataRoot,
    source: assetSource(manifest, { node: node.bytes, hyperframes: hyperframes.bytes }),
  }).ensureAll();
  const database = openVidcomDatabase(appDataRoot);
  await migrateDatabase(database);
  await database.destroy();
  expect((await stat(path.join(appDataRoot, "vidcom.sqlite"))).isFile()).toBe(true);
  const nodeRoot = installation.archiveRoots.node;
  if (nodeRoot === undefined) throw new Error("runtime fixture did not publish its node archive");
  return {
    appDataRoot,
    root,
    runtimeFile: path.join(
      nodeRoot,
      "bin",
      `ffmpeg${executableSuffix}`,
    ),
    runtimeFileContent,
  };
}

describe("doctor runtime payload integrity", () => {
  it.skipIf(!HOST_SUPPORTED)(
    "hashes the real installed tree and rejects corruption, links, missing entries, and extras",
    async () => {
      const fixture = await installRuntimeFixture();
      const context = await createDoctorContext({ deep: true, appDataRoot: fixture.appDataRoot });
      contexts.push(context);

      await expect(context.probes.runtimeIntegrity(true)).resolves.toMatchObject({
        ok: true,
        detail: expect.stringContaining("4 files"),
      });

      await writeFile(fixture.runtimeFile, "tampered", "utf8");
      const shallowContext = await createDoctorContext({ deep: false, appDataRoot: fixture.appDataRoot });
      contexts.push(shallowContext);
      const integrityCheck = createDoctorChecks().find((check) => check.id === "runtime.integrity");
      expect(integrityCheck).toBeDefined();
      if (integrityCheck === undefined) throw new Error("runtime.integrity doctor check is missing");
      await expect(integrityCheck.run(shallowContext)).resolves.toMatchObject({ status: "skipped" });
      await expect(context.probes.runtimeIntegrity(true)).resolves.toMatchObject({
        ok: false,
        detail: expect.stringContaining("checksum_mismatch"),
      });

      await writeFile(fixture.runtimeFile, fixture.runtimeFileContent);
      if (process.platform !== "win32") {
        await chmod(fixture.runtimeFile, 0o644);
        await expect(context.probes.runtimeIntegrity(true)).resolves.toMatchObject({
          ok: false,
          detail: expect.stringContaining("mode_mismatch"),
        });
        await chmod(fixture.runtimeFile, 0o755);
      }

      await rm(fixture.runtimeFile);
      await expect(context.probes.runtimeIntegrity(true)).resolves.toMatchObject({
        ok: false,
        detail: expect.stringContaining("missing"),
      });
      await writeFile(fixture.runtimeFile, fixture.runtimeFileContent);
      if (process.platform !== "win32") await chmod(fixture.runtimeFile, 0o755);

      const outsideHardLink = path.join(fixture.root, "runtime-hard-link");
      await link(fixture.runtimeFile, outsideHardLink);
      await expect(context.probes.runtimeIntegrity(true)).resolves.toMatchObject({
        ok: false,
        detail: expect.stringContaining("hard_link"),
      });
      await rm(outsideHardLink);

      const archiveRoot = path.dirname(path.dirname(fixture.runtimeFile));
      const extra = path.join(archiveRoot, "unexpected.bin");
      await writeFile(extra, "unexpected", "utf8");
      await expect(context.probes.runtimeIntegrity(true)).resolves.toMatchObject({
        ok: false,
        detail: expect.stringContaining("unexpected_file"),
      });
      await rm(extra);

      const binRoot = path.dirname(fixture.runtimeFile);
      const outsideBin = path.join(fixture.root, "outside-bin");
      await rename(binRoot, outsideBin);
      await symlink(outsideBin, binRoot, process.platform === "win32" ? "junction" : "dir");
      await expect(context.probes.runtimeIntegrity(true)).resolves.toMatchObject({
        ok: false,
        detail: expect.stringContaining("symlink"),
      });
    },
    60_000,
  );

  it.skipIf(!HOST_SUPPORTED || process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a chmod-000 current pointer inside the report instead of aborting doctor",
    async () => {
      const fixture = await installRuntimeFixture();
      const current = path.join(fixture.appDataRoot, "native", RUNTIME_CURRENT_FILENAME);
      await chmod(current, 0o000);
      try {
        const context = await createDoctorContext({ deep: true, appDataRoot: fixture.appDataRoot });
        contexts.push(context);
        const report = await runDoctorChecks(createDoctorChecks(), context, {
          platform: context.platform,
        });
        expect(report.items).toHaveLength(DOCTOR_CHECK_ORDER.length);
        for (const id of ["runtime.manifest", "runtime.integrity"]) {
          expect(report.items.find((item) => item.id === id)).toMatchObject({
            status: "broken",
            detail: expect.stringContaining("restore app-data read permissions"),
            remedy: expect.stringContaining("restore access to app-data"),
          });
        }
        expect(report.items.find((item) => item.id === "runtime.ffmpeg")?.status).toBe("missing");
      } finally {
        await chmod(current, 0o600);
      }
    },
    60_000,
  );
});
