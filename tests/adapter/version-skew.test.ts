import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectHyperframesVersionSkew } from "@vidcom/adapter";
import { WarningCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(config?: string) {
  const projectRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-skew-")));
  roots.push(projectRoot);
  if (config !== undefined) {
    await writeFile(path.join(projectRoot, "hyperframes.json"), config, "utf8");
  }
  return projectRoot;
}

describe("HyperFrames version skew", () => {
  it("warns with a code when the project asks for a version the runtime does not ship", async () => {
    const projectRoot = await project(`${JSON.stringify({ hyperframes: "1.2.0" })}\n`);
    const warning = await detectHyperframesVersionSkew({ projectRoot, installedVersion: "1.4.0" });

    expect(warning?.code).toBe(WarningCode.EngineVersionDrift);
    expect(warning?.message).toContain("1.2.0");
    expect(warning?.message).toContain("1.4.0");
  });

  it("never rewrites the project file to silence itself", async () => {
    const declared = `${JSON.stringify({ hyperframes: "1.2.0", registry: "./registry" })}\n`;
    const projectRoot = await project(declared);

    await detectHyperframesVersionSkew({ projectRoot, installedVersion: "1.4.0" });

    // Editing a file the user owns to quiet a warning about their own intent
    // would hide the very thing being reported.
    expect(await readFile(path.join(projectRoot, "hyperframes.json"), "utf8")).toBe(declared);
  });

  it("stays quiet when the declared version is the shipped one", async () => {
    const projectRoot = await project(`${JSON.stringify({ hyperframes: "1.4.0" })}\n`);
    expect(await detectHyperframesVersionSkew({ projectRoot, installedVersion: "1.4.0" })).toBeNull();
  });

  it("accepts the `version` spelling too", async () => {
    const projectRoot = await project(`${JSON.stringify({ version: "1.2.0" })}\n`);
    expect((await detectHyperframesVersionSkew({ projectRoot, installedVersion: "1.4.0" }))?.code)
      .toBe(WarningCode.EngineVersionDrift);
  });

  it.each([
    ["no hyperframes.json at all", undefined],
    ["a config declaring nothing", `${JSON.stringify({ registry: "./registry" })}\n`],
    ["a blank declaration", `${JSON.stringify({ hyperframes: "   " })}\n`],
    ["malformed JSON", "{not json"],
  ])("treats %s as acceptance, not drift", async (_label, config) => {
    // A project that declares nothing is taking whatever ships, and a broken
    // declaration is not evidence of a mismatch.
    const projectRoot = await project(config);
    expect(await detectHyperframesVersionSkew({ projectRoot, installedVersion: "1.4.0" })).toBeNull();
  });

  it("cannot report drift when the installed version is unknown", async () => {
    const projectRoot = await project(`${JSON.stringify({ hyperframes: "1.2.0" })}\n`);
    expect(await detectHyperframesVersionSkew({ projectRoot, installedVersion: null })).toBeNull();
  });
});
