import { describe, expect, it } from "vitest";

describe("golden test harness", () => {
  it("executes TypeScript tests under the Node environment", () => {
    expect(process.release.name).toBe("node");
  });
});
