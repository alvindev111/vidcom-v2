import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyEvidenceBundle } from "../../scripts/packaged-smoke/verify-evidence-bundle.mjs";

const roots: string[] = [];
const tag = `${process.platform}-${process.arch}`;
const commit = "a".repeat(40);
const runnerOs = "fixture-os";
const runnerArchitecture = "fixture-arch";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-m6-evidence-"));
  roots.push(root);
  const evidence = path.join(root, "packaged-smoke-evidence", tag);
  const artifact = path.join(root, "dist", "artifact", tag);
  await Promise.all([
    mkdir(evidence, { recursive: true }),
    mkdir(artifact, { recursive: true }),
  ]);
  const ffprobe = {
    streams: [{ codec_type: "video" }, { codec_type: "audio" }],
    format: { duration: "8.0" },
  };
  await Promise.all([
    writeFile(path.join(root, `packaged-smoke-${tag}.json`), JSON.stringify({
      version: 1,
      platform: tag,
      steps: [{ id: "render-media", status: "passed", durationMs: 1 }],
    })),
    writeFile(path.join(evidence, "doctor-report.json"), JSON.stringify({
      version: 1,
      platform: tag,
      items: [{ id: "runtime.integrity", status: "ok" }],
    })),
    writeFile(path.join(evidence, "ffprobe.json"), JSON.stringify({
      online: ffprobe,
      offline: ffprobe,
    })),
    writeFile(path.join(evidence, "platform.json"), JSON.stringify({
      tag,
      runnerOs,
      runnerArchitecture,
      artifact: {
        identity: { platform: tag, runtimeManifest: "runtime-v1" },
        manifest: { commit, runtimeManifest: "runtime-v1" },
      },
    })),
    writeFile(path.join(artifact, "artifact-manifest.json"), JSON.stringify({
      version: 1,
      platform: tag,
      commit,
      runtime: { artifactVersion: "runtime-v1" },
      files: { vidcom: "b".repeat(64) },
    })),
    writeFile(path.join(artifact, "SHA256SUMS"), `${"b".repeat(64)}  vidcom\n`),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged-smoke M.6 evidence bundle", () => {
  it("accepts raw reports, platform provenance, checksums and a passing step report", async () => {
    const root = await fixture();

    await expect(verifyEvidenceBundle({
      root,
      tag,
      expectedCommit: commit,
      runnerOs,
      runnerArchitecture,
    })).resolves.toMatchObject({ tag, commit });
  });

  it("fails when any individually uploaded evidence file is absent", async () => {
    const root = await fixture();
    await unlink(path.join(root, "packaged-smoke-evidence", tag, "doctor-report.json"));

    await expect(verifyEvidenceBundle({
      root,
      tag,
      expectedCommit: commit,
      runnerOs,
      runnerArchitecture,
    })).rejects.toThrow(/raw DoctorReport is missing/u);
  });

  it("fails when provenance is not the exact workflow commit", async () => {
    const root = await fixture();

    await expect(verifyEvidenceBundle({
      root,
      tag,
      expectedCommit: "c".repeat(40),
      runnerOs,
      runnerArchitecture,
    })).rejects.toThrow(/exact commit/u);
  });

  it("fails when the nominal step report contains an incomplete run", async () => {
    const root = await fixture();
    await writeFile(path.join(root, `packaged-smoke-${tag}.json`), JSON.stringify({
      version: 1,
      platform: tag,
      steps: [{ id: "render-media", status: "failed" }],
    }));

    await expect(verifyEvidenceBundle({
      root,
      tag,
      expectedCommit: commit,
      runnerOs,
      runnerArchitecture,
    })).rejects.toThrow(/non-passing step/u);
  });
});
