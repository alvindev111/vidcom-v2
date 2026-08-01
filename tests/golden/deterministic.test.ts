import { describe, expect, it } from "vitest";

import { createFixedClock, createSequentialIdPort } from "../support/deterministic";

describe("deterministic test helpers", () => {
  it("returns an isolated copy of the same instant on every clock read", () => {
    const clock = createFixedClock("2026-08-01T00:00:00.000Z");
    const first = clock.now();

    first.setUTCFullYear(2030);

    expect(clock.now().toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("generates stable prefixed IDs from an explicit starting sequence", () => {
    const ids = createSequentialIdPort(7);

    expect([ids.newId("project"), ids.newId("job"), ids.newId("job")]).toEqual([
      "project_0007",
      "job_0008",
      "job_0009",
    ]);
  });
});
