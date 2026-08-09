import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  artifactBackupDirectory,
  artifactDirectory,
  commitArtifactBuild,
  prepareArtifactBuild,
  prepareArtifactBuildAuthority,
  recoverArtifactPublish,
  revalidateArtifactBuildAuthority,
  restoreArtifactBuildAuthority,
  serializeArtifactBuildAuthority,
} from "../../scripts/artifact-publish.mjs";
import { DirectoryPublishInterruption } from "../../scripts/directory-generation-publish.mjs";
import { afterEach, describe, expect, it } from "vitest";

const TAG = "darwin-arm64";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function writeGeneration(directory: string, value: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "vidcom"), value),
    writeFile(path.join(directory, "artifact-manifest.json"), JSON.stringify({ value })),
    writeFile(path.join(directory, "SHA256SUMS"), `${value}  vidcom\n`),
  ]);
}

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`child did not create ${filename}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function killedPublisher(
  root: string,
  generation: string,
  boundary: string,
): Promise<void> {
  const ready = path.join(root, `ready-${boundary}`);
  const moduleUrl = pathToFileURL(path.resolve("scripts/artifact-publish.mjs")).href;
  const source = `
    import { writeFile } from "node:fs/promises";
    import { commitArtifactBuild } from ${JSON.stringify(moduleUrl)};
    await commitArtifactBuild(${JSON.stringify(TAG)}, ${JSON.stringify(root)}, {
      generation: ${JSON.stringify(generation)},
      async onBoundary(boundary) {
        if (boundary === ${JSON.stringify(boundary)}) {
          await writeFile(${JSON.stringify(ready)}, "ready");
          await new Promise(() => { setInterval(() => {}, 1_000); });
        }
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForFile(ready);
  child.kill("SIGKILL");
  const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  expect(exitCode).not.toBe(0);
  expect(signal === "SIGKILL" || exitCode !== null).toBe(true);
}

describe("artifact generation publish", () => {
  it("keeps the prior complete generation until the new one commits", async () => {
    const root = await temporaryRoot("vidcom-artifact-publish-");
    await writeGeneration(artifactDirectory(TAG, root), "old");
    const build = await prepareArtifactBuild(TAG, root);
    expect(await readFile(path.join(artifactDirectory(TAG, root), "vidcom"), "utf8")).toBe("old");
    await writeGeneration(build, "new");
    await commitArtifactBuild(TAG, root, { generation: build });
    expect(await readFile(path.join(artifactDirectory(TAG, root), "vidcom"), "utf8")).toBe("new");
    await expect(readFile(path.join(artifactBackupDirectory(TAG, root), "vidcom"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers both interruption boundaries without mixing generations", async () => {
    const root = await temporaryRoot("vidcom-artifact-recover-");
    const published = artifactDirectory(TAG, root);
    const build = await prepareArtifactBuild(TAG, root);
    const backup = artifactBackupDirectory(TAG, root);
    await writeGeneration(published, "old");
    await writeGeneration(build, "new");

    await expect(commitArtifactBuild(TAG, root, {
      generation: build,
      onBoundary(boundary: string) {
        if (boundary === "afterPreviousRename") throw new DirectoryPublishInterruption("SIGKILL");
      },
    })).rejects.toThrow(/SIGKILL/u);
    // SIGKILL after moving the previous generation aside.
    await recoverArtifactPublish(TAG, root);
    expect(await readFile(path.join(published, "vidcom"), "utf8")).toBe("old");

    // SIGKILL after publishing the complete new generation but before cleanup.
    await expect(commitArtifactBuild(TAG, root, {
      generation: build,
      onBoundary(boundary: string) {
        if (boundary === "afterGenerationRename") throw new DirectoryPublishInterruption("SIGKILL");
      },
    })).rejects.toThrow(/SIGKILL/u);
    await recoverArtifactPublish(TAG, root);
    expect(await readFile(path.join(published, "vidcom"), "utf8")).toBe("new");
    await expect(readFile(path.join(backup, "vidcom"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves and rejects a foreign backup without a bound transaction", async () => {
    const root = await temporaryRoot("vidcom-artifact-foreign-");
    const backup = artifactBackupDirectory(TAG, root);
    await writeGeneration(backup, "foreign");
    await expect(recoverArtifactPublish(TAG, root)).rejects.toThrow(/foreign publish backup/u);
    expect(await readFile(path.join(backup, "vidcom"), "utf8")).toBe("foreign");
  });

  it("binds every payload byte and rolls back mutation after the journal", async () => {
    const root = await temporaryRoot("vidcom-artifact-digest-");
    const published = artifactDirectory(TAG, root);
    await writeGeneration(published, "old");
    const build = await prepareArtifactBuild(TAG, root);
    await writeGeneration(build, "new");

    await expect(commitArtifactBuild(TAG, root, {
      generation: build,
      async onBoundary(boundary: string) {
        if (boundary === "afterJournal") await writeFile(path.join(build, "vidcom"), "tampered");
      },
    })).rejects.toThrow(/payload digest/u);
    expect(await readFile(path.join(published, "vidcom"), "utf8")).toBe("old");
    expect(await readFile(path.join(build, "vidcom"), "utf8")).toBe("tampered");
  });

  it("preserves a tampered published candidate and restores the prior generation", async () => {
    const root = await temporaryRoot("vidcom-artifact-tamper-");
    const published = artifactDirectory(TAG, root);
    await writeGeneration(published, "old");
    const build = await prepareArtifactBuild(TAG, root);
    await writeGeneration(build, "new");

    await expect(commitArtifactBuild(TAG, root, {
      generation: build,
      async onBoundary(boundary: string) {
        if (boundary === "afterGenerationRename") {
          await writeFile(path.join(published, "vidcom"), "tampered");
        }
      },
    })).rejects.toThrow(/payload digest/u);
    expect(await readFile(path.join(published, "vidcom"), "utf8")).toBe("old");
    expect(await readFile(path.join(build, "vidcom"), "utf8")).toBe("tampered");
  });

  it("uses unique generations and refuses a second process while the owner is alive", async () => {
    const root = await temporaryRoot("vidcom-artifact-owner-");
    const published = artifactDirectory(TAG, root);
    await writeGeneration(published, "old");
    const first = await prepareArtifactBuild(TAG, root);
    const second = await prepareArtifactBuild(TAG, root);
    expect(first).not.toBe(second);
    await Promise.all([writeGeneration(first, "first"), writeGeneration(second, "second")]);

    const ready = path.join(root, "live-ready");
    const moduleUrl = pathToFileURL(path.resolve("scripts/artifact-publish.mjs")).href;
    const source = `
      import { writeFile } from "node:fs/promises";
      import { commitArtifactBuild } from ${JSON.stringify(moduleUrl)};
      await commitArtifactBuild(${JSON.stringify(TAG)}, ${JSON.stringify(root)}, {
        generation: ${JSON.stringify(first)},
        async onBoundary(boundary) {
          if (boundary === "afterJournal") {
            await writeFile(${JSON.stringify(ready)}, "ready");
            await new Promise(() => { setInterval(() => {}, 1_000); });
          }
        },
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForFile(ready);
    await expect(commitArtifactBuild(TAG, root, { generation: second }))
      .rejects.toThrow(/live publisher/u);
    expect(await readFile(path.join(first, "vidcom"), "utf8")).toBe("first");
    expect(await readFile(path.join(second, "vidcom"), "utf8")).toBe("second");

    child.kill("SIGKILL");
    await once(child, "exit");
    await recoverArtifactPublish(TAG, root);
    expect(await readFile(path.join(published, "vidcom"), "utf8")).toBe("old");
    await commitArtifactBuild(TAG, root, { generation: second });
    expect(await readFile(path.join(published, "vidcom"), "utf8")).toBe("second");
  });

  it.each(["afterPreviousRename", "afterGenerationRename", "afterBackupRetired"])(
    "recovers a real child killed at %s",
    async (boundary) => {
      const root = await temporaryRoot(`vidcom-artifact-kill-${boundary}-`);
      const published = artifactDirectory(TAG, root);
      await writeGeneration(published, "old");
      const build = await prepareArtifactBuild(TAG, root);
      await writeGeneration(build, "new");
      await killedPublisher(root, build, boundary);
      await recoverArtifactPublish(TAG, root);
      const expected = boundary === "afterPreviousRename" ? "old" : "new";
      expect(await readFile(path.join(published, "vidcom"), "utf8")).toBe(expected);
    },
  );

  it("reclaims a live reused PID only when its OS start identity differs", async () => {
    const root = await temporaryRoot("vidcom-artifact-reused-pid-");
    const published = artifactDirectory(TAG, root);
    const lock = `${published}.publish.lock`;
    await writeFile(lock, `${JSON.stringify({
      schemaVersion: 1,
      kind: "artifact",
      published,
      ownerPid: process.pid,
      ownerStart: "fixture:not-the-current-process-start",
      ownerToken: randomUUID(),
    })}\n`, { mode: 0o600 });

    await expect(recoverArtifactPublish(TAG, root)).resolves.toBe("clean");
    expect(existsSync(lock)).toBe(false);
  });

  it("rejects a symlinked artifact root without writing through it", async () => {
    const base = await temporaryRoot("vidcom-artifact-symlink-root-");
    const realRoot = path.join(base, "real-root");
    const linkedRoot = path.join(base, "linked-root");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(prepareArtifactBuild(TAG, linkedRoot)).rejects.toThrow(/symlink|junction/u);
    expect(await readdir(realRoot)).toEqual([]);
  });

  it("detects a replaced build generation before publisher mutation", async () => {
    const root = await temporaryRoot("vidcom-artifact-generation-authority-");
    const { generation: build, authority } = await prepareArtifactBuildAuthority(TAG, root);
    const record = serializeArtifactBuildAuthority(authority);
    await rename(build, `${build}.replaced`);
    await mkdir(build);
    await writeFile(path.join(build, "artifact-authority.json"), record);
    const restored = restoreArtifactBuildAuthority(record);

    await expect(revalidateArtifactBuildAuthority(restored))
      .rejects.toThrow(/generation identity changed/u);
    await expect(commitArtifactBuild(TAG, root, { generation: build, authority: restored }))
      .rejects.toThrow(/generation identity changed/u);
    expect(existsSync(`${artifactDirectory(TAG, root)}.publish.lock`)).toBe(false);
    expect(existsSync(`${artifactDirectory(TAG, root)}.transaction.json`)).toBe(false);
  });

  it("retains the original root authority across the prepare boundary", async () => {
    const base = await temporaryRoot("vidcom-artifact-prepare-root-race-");
    const root = path.join(base, "artifact-root");
    const original = `${root}.original`;
    await mkdir(root);

    await expect(prepareArtifactBuildAuthority(TAG, root, {
      async onBoundary(boundary: string) {
        if (boundary !== "afterRootValidation") return;
        await rename(root, original);
        await mkdir(root);
        await writeFile(path.join(root, "external-sentinel.txt"), "preserve me\n");
      },
    })).rejects.toThrow(/output authority changed/u);

    expect(await readFile(path.join(root, "external-sentinel.txt"), "utf8")).toBe("preserve me\n");
    expect(await readdir(root)).toEqual(["external-sentinel.txt"]);
    expect(await readdir(original)).toEqual([]);
  });

  it("restores the exact authority in another process and rejects a replacement root", async () => {
    const base = await temporaryRoot("vidcom-artifact-authority-record-");
    const root = path.join(base, "artifact-root");
    await mkdir(root);
    const { generation, authority } = await prepareArtifactBuildAuthority(TAG, root);
    const record = serializeArtifactBuildAuthority(authority);
    const recordFile = path.join(base, "artifact-authority.json");
    await writeFile(recordFile, record);
    const moduleUrl = pathToFileURL(path.resolve("scripts/artifact-publish.mjs")).href;
    const verifySource = `
      import { readFile } from "node:fs/promises";
      import {
        restoreArtifactBuildAuthority,
        revalidateArtifactBuildAuthority,
      } from ${JSON.stringify(moduleUrl)};
      const authority = restoreArtifactBuildAuthority(await readFile(${JSON.stringify(recordFile)}, "utf8"));
      await revalidateArtifactBuildAuthority(authority);
    `;
    const valid = spawnSync(process.execPath, ["--input-type=module", "--eval", verifySource], {
      encoding: "utf8",
      shell: false,
    });
    expect(valid.status, valid.stderr).toBe(0);

    const original = `${root}.original`;
    await rename(root, original);
    await mkdir(generation, { recursive: true });
    await writeFile(path.join(generation, "artifact-authority.json"), record);
    const replaced = spawnSync(process.execPath, ["--input-type=module", "--eval", verifySource], {
      encoding: "utf8",
      shell: false,
    });
    expect(replaced.status).not.toBe(0);
    expect(replaced.stderr).toMatch(/output authority changed/u);
    const restored = restoreArtifactBuildAuthority(
      await readFile(path.join(generation, "artifact-authority.json"), "utf8"),
    );
    await expect(revalidateArtifactBuildAuthority(restored))
      .rejects.toThrow(/output authority changed/u);

    const extraField = { ...JSON.parse(record), env: { GH_KEY: "must never be accepted" } };
    expect(() => restoreArtifactBuildAuthority(JSON.stringify(extraField)))
      .toThrow(/fields are invalid/u);
  });
});
