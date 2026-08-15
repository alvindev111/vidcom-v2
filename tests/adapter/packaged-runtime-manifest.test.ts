import {
  PACKAGED_RUNTIME_MIGRATION_ENTRIES,
  validatePackagedRuntimeManifest,
} from "@vidcom/adapter/runtime-bootstrap";
import { describe, expect, it } from "vitest";

import {
  archiveFor,
  productRuntimeFixtureEntries,
  runtimeManifest,
} from "../support/runtime-fixture";

describe("packaged runtime product manifest", () => {
  it("accepts the Linux forkpty closure without the macOS-only spawn helper", () => {
    const platform = "linux-x64";
    const product = productRuntimeFixtureEntries(
      PACKAGED_RUNTIME_MIGRATION_ENTRIES.map((path) => ({
        path,
        content: Buffer.from("-- migration\n"),
      })),
      platform,
    );
    expect(product.native.some((entry) => entry.path.endsWith("/spawn-helper"))).toBe(false);
    const node = archiveFor("node", [
      { path: "cli/boot.cjs", content: Buffer.from("module.exports = {};\n") },
      ...product.node,
      ...product.native,
    ], platform, "node-runtime");
    const hyperframes = archiveFor(
      "hyperframes",
      [...product.hyperframes, ...product.native],
      platform,
      "hyperframes-runtime",
    );
    const bgm = archiveFor("bgm", [
      "alex-morgan-corporate-business-background.mp3",
      "corporate-marimba-business-background.mp3",
      "meta.mp3",
      "promo-promo-business-background.mp3",
    ].map((path) => ({ path, content: Buffer.from(`fixture ${path}\n`) })), platform, "bgm-runtime");

    expect(() => validatePackagedRuntimeManifest(
      "/tmp/vidcom-linux-fixture",
      runtimeManifest("1.0.0", [bgm.archive, node.archive, hyperframes.archive]),
      "linux",
      "x64",
    )).not.toThrow();
  });

  it("accepts Windows executables without POSIX execute bits", () => {
    const platform = "win32-x64";
    const product = productRuntimeFixtureEntries(
      PACKAGED_RUNTIME_MIGRATION_ENTRIES.map((path) => ({
        path,
        content: Buffer.from("-- migration\n"),
      })),
      platform,
    );
    const node = archiveFor(
      "node",
      [
        { path: "cli/boot.cjs", content: Buffer.from("module.exports = {};\n") },
        ...product.node,
        ...product.native,
      ],
      platform,
      "node-runtime",
    );
    const hyperframes = archiveFor(
      "hyperframes",
      [...product.hyperframes, ...product.native],
      platform,
      "hyperframes-runtime",
    );
    const bgm = archiveFor(
      "bgm",
      [
        "alex-morgan-corporate-business-background.mp3",
        "corporate-marimba-business-background.mp3",
        "meta.mp3",
        "promo-promo-business-background.mp3",
      ].map((path) => ({ path, content: Buffer.from(`fixture ${path}\n`) })),
      platform,
      "bgm-runtime",
    );

    expect(() => validatePackagedRuntimeManifest(
      "/tmp/vidcom-win32-fixture",
      runtimeManifest("1.0.0", [bgm.archive, node.archive, hyperframes.archive]),
      "win32",
      "x64",
    )).not.toThrow();

    const unexpectedBgm = {
      ...bgm.archive,
      entries: [...bgm.archive.entries, { ...bgm.archive.entries[0]!, path: "unreviewed.mp3" }],
    };
    expect(() => validatePackagedRuntimeManifest(
      "/tmp/vidcom-win32-fixture",
      runtimeManifest("1.0.0", [unexpectedBgm, node.archive, hyperframes.archive]),
      "win32",
      "x64",
    )).toThrow(/missing required product entries/u);

    const driftedNodePty = {
      ...node.archive,
      entries: node.archive.entries.map((entry) => entry.path === "node_modules/node-pty/package.json"
        ? { ...entry, sha256: `sha256:${"0".repeat(64)}` as typeof entry.sha256 }
        : entry),
    };
    expect(() => validatePackagedRuntimeManifest(
      "/tmp/vidcom-win32-fixture",
      runtimeManifest("1.0.0", [bgm.archive, driftedNodePty, hyperframes.archive]),
      "win32",
      "x64",
    )).toThrow(/missing required product entries/u);

    const withoutBrowserAudit = {
      ...hyperframes.archive,
      entries: hyperframes.archive.entries.filter((entry) =>
        entry.path !== "bin/commands/layout-audit.browser.js"),
    };
    try {
      validatePackagedRuntimeManifest(
        "/tmp/vidcom-win32-fixture",
        runtimeManifest("1.0.0", [bgm.archive, node.archive, withoutBrowserAudit]),
        "win32",
        "x64",
      );
      throw new Error("fixture without the HyperFrames browser audit unexpectedly passed validation");
    } catch (error) {
      expect(error).toMatchObject({
        details: {
          missing: expect.arrayContaining(["hyperframes:bin/commands/layout-audit.browser.js"]),
        },
      });
    }
  });

  it("rejects a host archive whose required node-pty payload is absent", () => {
    const platform = "win32-x64";
    const product = productRuntimeFixtureEntries(
      PACKAGED_RUNTIME_MIGRATION_ENTRIES.map((path) => ({
        path,
        content: Buffer.from("-- migration\n"),
      })),
      platform,
    );
    const withoutNodePty = product.native.filter((entry) => !entry.path.includes("/node-pty/"));
    const node = archiveFor("node", [
      { path: "cli/boot.cjs", content: Buffer.from("module.exports = {};\n") },
      ...product.node,
      ...withoutNodePty,
    ], platform, "node-runtime");
    const hyperframes = archiveFor(
      "hyperframes",
      [...product.hyperframes, ...product.native],
      platform,
      "hyperframes-runtime",
    );
    const bgm = archiveFor("bgm", [
      "alex-morgan-corporate-business-background.mp3",
      "corporate-marimba-business-background.mp3",
      "meta.mp3",
      "promo-promo-business-background.mp3",
    ].map((path) => ({ path, content: Buffer.from(`fixture ${path}\n`) })), platform, "bgm-runtime");

    try {
      validatePackagedRuntimeManifest(
        "/tmp/vidcom-win32-fixture",
        runtimeManifest("1.0.0", [bgm.archive, node.archive, hyperframes.archive]),
        "win32",
        "x64",
      );
      throw new Error("fixture without node-pty unexpectedly passed validation");
    } catch (error) {
      expect(error).toMatchObject({
        details: {
          missing: expect.arrayContaining(["node:node_modules/node-pty/package.json"]),
        },
      });
    }
  });
});
