import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeProcessRunner } from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

import { heavyE2eTimeout } from "../support/platform";

const roots: string[] = [];
const probeTimeoutMs = process.platform === "win32" ? 60_000 : 10_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-probe-"));
  roots.push(root);
  const modules = path.join(root, "modules");
  const cacheRoot = path.join(root, "models");
  await Promise.all([
    mkdir(path.join(modules, "huggingface_hub"), { recursive: true }),
    mkdir(path.join(modules, "vieneu"), { recursive: true }),
  ]);
  await writeFile(path.join(modules, "huggingface_hub", "__init__.py"), `
import os
import json
from pathlib import Path

def snapshot_download(repo_id, revision=None):
    root = Path(os.environ["HF_HOME"])
    proof = root / "snapshot-called.json"
    snapshot = root / "hub" / "snapshots" / "abc123"
    if os.environ.get("HF_HUB_OFFLINE") == "1" and not proof.is_file():
        raise RuntimeError("offline cache is empty")
    snapshot.mkdir(parents=True, exist_ok=True)
    proof.write_text(json.dumps({"repo": repo_id, "revision": revision}), encoding="utf-8")
    return str(snapshot)
`, "utf8");
  await writeFile(path.join(modules, "vieneu", "__init__.py"), `
import os
from pathlib import Path

class Vieneu:
    def __init__(self, backend=None):
        if not (Path(os.environ["HF_HOME"]) / "snapshot-called.json").is_file():
            raise RuntimeError("engine constructed before snapshot download")
    def list_preset_voices(self):
        return [("Tin tức", "Phạm Tuyên")]
`, "utf8");
  await writeFile(path.join(modules, "torch.py"), `
class cuda:
    @staticmethod
    def is_available():
        return False
`, "utf8");
  return { root, modules, cacheRoot };
}

async function probe(modules: string, cacheRoot: string, offline: boolean) {
  return await new NodeProcessRunner(probeTimeoutMs).run({
    command: [
      process.platform === "win32" ? "python" : "python3",
      path.resolve("packages/adapter/sidecars/vieneu/worker.py"),
      "--probe",
    ],
    environment: {
      HF_HOME: cacheRoot,
      HF_HUB_CACHE: path.join(cacheRoot, "hub"),
      TORCH_HOME: path.join(cacheRoot, "torch"),
      PYTHONPATH: modules,
      ...(offline ? { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } : {}),
    },
    timeoutMs: probeTimeoutMs,
  });
}

describe("VieNeu model probe child", () => {
  it("makes ready mean the requested snapshot is complete, then reuses it offline", async () => {
    const { modules, cacheRoot } = await fixture();

    const cold = await probe(modules, cacheRoot, false);
    expect(cold).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(cold.stdout)).toMatchObject({ ready: true, voices: ["Phạm Tuyên"] });
    expect(JSON.parse(await readFile(path.join(cacheRoot, "snapshot-called.json"), "utf8")))
      .toMatchObject({ repo: "pnnbao-ump/VieNeu-TTS-v3-Turbo", revision: null });

    const warm = await probe(modules, cacheRoot, true);
    expect(warm).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(warm.stdout)).toMatchObject({ ready: true, voices: ["Phạm Tuyên"] });
  }, heavyE2eTimeout);

  it("does not claim ready for an empty offline cache", async () => {
    const { modules, root } = await fixture();
    const empty = path.join(root, "empty-models");

    const result = await probe(modules, empty, true);

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: false, voices: [] });
    expect(result.stderr).toContain("offline cache is empty");
  }, heavyE2eTimeout);
});
