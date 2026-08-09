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

    expect(() => validatePackagedRuntimeManifest(
      "/tmp/vidcom-win32-fixture",
      runtimeManifest("1.0.0", [node.archive, hyperframes.archive]),
      "win32",
      "x64",
    )).not.toThrow();
  });
});
