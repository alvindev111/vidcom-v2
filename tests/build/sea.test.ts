import path from "node:path";

import {
  MACHO_SEGMENT,
  POSTJECT,
  SEA_FUSE,
  SEA_RESOURCE,
  artifactPath,
  assertInputsPresent,
  postjectArguments,
  requiredInputs,
  seaConfig,
} from "../../scripts/build-sea.mjs";
import { describe, expect, it } from "vitest";

const HOST_TAG = { darwin: "darwin-arm64", win32: "win32-x64", linux: "linux-x64" }[
  process.platform as "darwin" | "win32" | "linux"
];

describe("sea build", () => {
  it("turns off both forms of baked-in V8 state", () => {
    // Each bakes in bytes tied to one V8 build. A cache written by one Node and
    // read by another fails at start-up instead of falling back, and the Node
    // that writes the blob is the build machine's, matching the embedded one
    // only by convention.
    const config = seaConfig();
    expect(config.useCodeCache).toBe(false);
    expect(config.useSnapshot).toBe(false);
  });

  it("embeds the frontend as assets rather than as files beside the binary", () => {
    // One file with nothing to unpack is the entire point of the artifact.
    expect(Object.keys(seaConfig().assets).sort()).toEqual([
      "frontend-manifest.json",
      "frontend.pack",
    ]);
  });

  it("states every path relative to where the blob step runs", () => {
    // Node resolves these against the working directory, not against the
    // configuration file holding them. Getting it backwards fails with
    // "Cannot read main script", which reads like a missing bundle.
    const config = seaConfig();
    for (const value of [config.main, config.output, ...Object.values(config.assets)]) {
      expect(path.isAbsolute(value), value).toBe(false);
      expect(value.startsWith("."), value).toBe(false);
    }
  });

  it("pins the injector, because it edits the shipped bytes", () => {
    expect(POSTJECT).toMatch(/@\d/u);
  });

  it("names the Mach-O segment the runtime actually looks in", () => {
    // Without it the blob lands somewhere Node does not read: the executable
    // builds, starts, and then reports that it has no embedded main.
    const darwin = postjectArguments("vidcom", "sea-prep.blob", "darwin");
    expect(darwin).toContain("--macho-segment-name");
    expect(darwin).toContain(MACHO_SEGMENT);
    expect(postjectArguments("vidcom", "sea-prep.blob", "linux")).not.toContain(MACHO_SEGMENT);
  });

  it("uses Node's own resource name and fuse", () => {
    const args = postjectArguments("vidcom", "sea-prep.blob", "linux");
    expect(args[1]).toBe(SEA_RESOURCE);
    expect(args).toContain(`NODE_SEA_FUSE_${SEA_FUSE}`);
  });

  it("names one executable per host, and gives Windows its extension", () => {
    // The artifact embeds this machine's Node binary and its native runtime, so
    // a "Linux build" made on macOS is a file that runs nowhere. Refusing a
    // foreign target is covered where that decision lives, in build:artifact.
    expect(artifactPath(HOST_TAG)).toContain(path.join("dist", "artifact", HOST_TAG));
    expect(path.basename(artifactPath(HOST_TAG)))
      .toBe(process.platform === "win32" ? "vidcom.exe" : "vidcom");
  });

  it("names the missing step rather than injecting whatever is lying around", () => {
    // A pack from a previous run injected next to a fresh bundle produces an
    // artifact that only misbehaves once someone runs it — the most expensive
    // place to find out.
    expect(() => assertInputsPresent([path.join("dist", "sea", "never-built.pack")]))
      .toThrow(/has not run/u);
    expect(requiredInputs()).toHaveLength(3);
  });
});
