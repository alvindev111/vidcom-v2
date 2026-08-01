import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import { err, ok, type Result } from "@vidcom/core";

describe("Core Result helpers", () => {
  it("creates an explicit success branch", () => {
    expect(ok({ revision: 4 })).toEqual({ ok: true, value: { revision: 4 } });
  });

  it("creates an explicit typed domain failure branch", () => {
    const result: Result<never, { code: ErrorCode; message: string }> = err({
      code: ErrorCode.SceneNotFound,
      message: "scene not found",
    });

    expect(result).toEqual({
      ok: false,
      error: { code: ErrorCode.SceneNotFound, message: "scene not found" },
    });
  });
});
