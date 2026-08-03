import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultVieNeuCommand, vieneuSidecarRoot } from "@vidcom/adapter";

const roots: string[] = [];

/** Stands in for the directory a packaged build unpacked its sidecars into. */
async function extractionRoot(options: { withWorker: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-native-"));
  roots.push(root);
  if (options.withWorker) {
    await mkdir(path.join(root, "vieneu"), { recursive: true });
    await writeFile(path.join(root, "vieneu", "worker.py"), "# extracted\n");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("vieneuSidecarRoot", () => {
  it("resolves the worker that ships in the checkout", async () => {
    const { readFile } = await import("node:fs/promises");

    const worker = path.join(vieneuSidecarRoot(), "worker.py");

    // The path is derived from this module's location, so a refactor that moves
    // either the source or the sidecars directory breaks here rather than at the
    // first synthesis on a user's machine.
    expect(await readFile(worker, "utf8")).toContain("VieNeu-TTS v3 Turbo sidecar");
  });

  it("prefers a packaged build's extracted copy", async () => {
    const root = await extractionRoot({ withWorker: true });

    expect(vieneuSidecarRoot(root)).toBe(path.join(root, "vieneu"));
  });

  it("falls back to the checkout when the extraction root holds no worker", async () => {
    const root = await extractionRoot({ withWorker: false });

    // Production entry points always pass a root, but in a source checkout that
    // directory does not exist yet; resolving to it unconditionally reported the
    // sidecar as missing during development.
    expect(vieneuSidecarRoot(root)).toBe(vieneuSidecarRoot());
  });
});

describe("defaultVieNeuCommand", () => {
  it("names the platform's interpreter and the shipped worker", () => {
    const [interpreter, script] = defaultVieNeuCommand();

    expect(interpreter).toBe(process.platform === "win32" ? "python" : "python3");
    expect(script).toBe(path.join(vieneuSidecarRoot(), "worker.py"));
  });

  it("points at the extracted worker when one is present", async () => {
    const root = await extractionRoot({ withWorker: true });

    expect(defaultVieNeuCommand(root)[1]).toBe(path.join(root, "vieneu", "worker.py"));
  });
});
