import { describe, expect, it } from "vitest";

import { collectSoakSamples } from "../../scripts/run-resource-soak.mjs";

describe("resource soak evidence collector", () => {
  it("collects repeated JSON samples and fails malformed evidence closed", () => {
    const samples = collectSoakSamples([
      'P17_TREE_SOAK_SAMPLE {"files":10000}',
      'P14_ASSET_RANGE_SAMPLE {"case":"sparse"}',
      'P14_ASSET_RANGE_SAMPLE {"case":"concurrent"}',
      "P15_SSE_SUSPENDED_SAMPLE not-json",
    ].join("\n"));

    expect(samples.P17_TREE_SOAK_SAMPLE).toEqual([{ files: 10_000 }]);
    expect(samples.P14_ASSET_RANGE_SAMPLE).toHaveLength(2);
    expect(samples.P15_SSE_SUSPENDED_SAMPLE).toEqual([]);
  });
});
