import { readFile } from "node:fs/promises";

import {
  CliInputError,
  VIDCOM_COMMAND_NAMES,
  VIDCOM_VERSION,
  formatVersionReport,
  parseVidcomCommand,
  runVersionCommand,
  versionReport,
} from "@vidcom/cli";
import { describe, expect, it } from "vitest";

function capture(): { io: { stdout: { write(chunk: string): boolean } }; text(): string } {
  const chunks: string[] = [];
  return {
    io: { stdout: { write: (chunk: string) => { chunks.push(chunk); return true; } } },
    text: () => chunks.join(""),
  };
}

describe("mode dispatcher", () => {
  it("publishes exactly the modes the executable answers to", () => {
    expect([...VIDCOM_COMMAND_NAMES]).toEqual([
      "app", "serve", "mcp", "render", "doctor", "version",
      "approve", "credential", "backup", "recovery",
    ]);
  });

  it("has no worker mode", () => {
    // OQ-9: packages/worker stays as it is and runs in-process. Publishing a
    // mode for it would promise a supported entry point nothing else uses.
    expect(VIDCOM_COMMAND_NAMES).not.toContain("worker");
  });

  it("still treats a bare invocation and leading options as the app", () => {
    expect(parseVidcomCommand([])).toEqual({ name: "app", args: [] });
    expect(parseVidcomCommand(["--port", "3000"]))
      .toEqual({ name: "app", args: ["--port", "3000"] });
  });

  it.each(VIDCOM_COMMAND_NAMES)("routes %s to its own mode", (name) => {
    expect(parseVidcomCommand([name, "--flag"])).toEqual({ name, args: ["--flag"] });
  });

  it("lists the valid modes when given one that does not exist", () => {
    // A bare "unknown command" is the least useful thing to say when the answer
    // is a short, fixed set.
    let thrown: unknown;
    try {
      parseVidcomCommand(["wroker"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliInputError);
    expect((thrown as Error).message).toContain("wroker");
    for (const name of VIDCOM_COMMAND_NAMES) {
      expect((thrown as Error).message).toContain(name);
    }
  });
});

describe("version", () => {
  it("reports the version the package declares", async () => {
    // Two places name it, so the drift shows up here rather than in a bug
    // report where the number sends the reader at the wrong release.
    const manifest = JSON.parse(await readFile("packages/cli/package.json", "utf8")) as {
      version: string;
    };
    expect(VIDCOM_VERSION).toBe(manifest.version);
  });

  it("admits what a source checkout cannot know", () => {
    // A guessed version is worse than an admitted blank: it points a bug report
    // at a release that was never built.
    expect(versionReport({ vidcom: "0.1.0" })).toEqual({
      vidcom: "0.1.0",
      hyperframes: null,
      buildCommit: null,
      platform: `${process.platform}-${process.arch}`,
      runtimeManifest: null,
    });
  });

  it("reports what a packaged build does know", () => {
    expect(versionReport({
      vidcom: "0.1.0",
      runtime: { manifestVersion: "2026.08.09", hyperframes: "0.7.86" },
      buildCommit: "abc1234",
      platform: "win32-x64",
    })).toMatchObject({
      hyperframes: "0.7.86",
      buildCommit: "abc1234",
      platform: "win32-x64",
      runtimeManifest: "2026.08.09",
    });
  });

  it("says 'not packaged' rather than leaving a blank column", () => {
    // A blank reads as a bug in this command; the real answer is that a source
    // checkout has no runtime.
    expect(formatVersionReport(versionReport({ vidcom: "0.1.0" })))
      .toContain("hyperframes: not packaged");
  });

  it("prints machine-readable output on request", async () => {
    const output = capture();
    await runVersionCommand(["--json"], { vidcom: "0.1.0" }, output.io);
    expect(JSON.parse(output.text())).toMatchObject({ vidcom: "0.1.0" });
  });

  it("refuses an argument it does not have", async () => {
    const output = capture();
    await expect(runVersionCommand(["--verbose"], { vidcom: "0.1.0" }, output.io))
      .rejects.toBeInstanceOf(CliInputError);
    await expect(runVersionCommand(["--json", "--json"], { vidcom: "0.1.0" }, output.io))
      .rejects.toBeInstanceOf(CliInputError);
  });
});
