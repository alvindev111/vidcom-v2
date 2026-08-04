import path from "node:path";

import { describe, expect, it } from "vitest";

import { injectRuntimeAssetGuardDocument } from "@vidcom/adapter";

describe("runtime asset guard document golden", () => {
  it("keeps CSP and bootstrap as the first two head elements", async () => {
    const result = injectRuntimeAssetGuardDocument(
      "<!doctype html>\n<html><head><meta charset=\"utf-8\"><script>author()</script></head><body></body></html>\n",
      {
        csp: "default-src *; img-src 'self' data: blob:; media-src 'self' data: blob:",
        bootstrapScript: "globalThis.__VIDCOM_GUARD__ = true;",
      },
    );
    await expect(result).toMatchFileSnapshot(
      path.resolve(import.meta.dirname, "fixtures/runtime-asset-guard.html"),
    );
  });
});
