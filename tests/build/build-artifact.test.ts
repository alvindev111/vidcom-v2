import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertBuildableTarget, planSteps } from "../../scripts/build-artifact.mjs";
import { describe, expect, it } from "vitest";

const HOST_TAG = { darwin: "darwin-arm64", win32: "win32-x64", linux: "linux-x64" }[
  process.platform as "darwin" | "win32" | "linux"
];

describe("build:artifact", () => {
  it("is wired as a script the way the other node scripts are", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["build:artifact"]).toBe("node scripts/build-artifact.mjs");
  });

  it("runs the steps in dependency order", () => {
    // Order is not cosmetic: the pack needs the export, the bundle needs the
    // pack, and the SEA needs the bundle.
    expect(planSteps().map((entry) => entry.name)).toEqual([
      "runtime archives (B.3)",
      "static export (G.6)",
      "frontend pack (H.2)",
      "cjs bundle (H.1)",
      "sea native (H.4)",
      "verify artifact (L.1)",
    ]);
  });

  it("runs the pack step under the runtime that can read the resolver", () => {
    // The manifest records the cache policy the host applies at runtime, and
    // the only way to guarantee they agree is to call the same function. That
    // function lives in TypeScript, which Bun runs directly.
    const pack = planSteps().find((entry) => entry.name.startsWith("frontend pack"));
    expect(pack?.command).toBe("bun");
  });

  it("starts every step with a binary all three platforms can spawn", () => {
    // On Windows `npm` is a `.cmd`, and Node refuses to spawn one without a
    // shell — a step written that way fails there for a reason that has nothing
    // to do with what the step does.
    for (const entry of planSteps()) {
      expect(entry.command, entry.name).not.toBe("npm");
    }
  });

  it("names the checklist task that owns each step", () => {
    // A step that has no owner is a step nobody notices is missing.
    for (const entry of planSteps()) {
      expect(entry.name, entry.name).toMatch(/\([A-Z]\.\d+\)$/u);
    }
  });

  it("accepts the host platform", () => {
    expect(assertBuildableTarget(undefined)).toBe(HOST_TAG);
    expect(assertBuildableTarget(HOST_TAG)).toBe(HOST_TAG);
  });

  it("refuses to cross-build", () => {
    // The artifact embeds a Node binary and a native runtime for the machine it
    // was made on; a "Linux build" made on macOS runs nowhere.
    const foreign = HOST_TAG === "linux-x64" ? "win32-x64" : "linux-x64";
    expect(() => assertBuildableTarget(foreign)).toThrow(/cross-building/u);
  });
});
