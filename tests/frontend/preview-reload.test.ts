// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  mutationChangeSeq,
  previewReloadRequest,
} from "../../src/lib/studio/preview-reload";

describe("preview reload contract", () => {
  it("uses only an exact durable mutation sequence", () => {
    expect(mutationChangeSeq({ changeSeq: 42 })).toBe(42);
    expect(mutationChangeSeq({ changeSeq: null })).toBeNull();
    expect(mutationChangeSeq({ changeSeq: -1 })).toBeNull();
    expect(mutationChangeSeq({ changeSeq: 1.5 })).toBeNull();
    expect(mutationChangeSeq({ revision: 42 })).toBeNull();
  });

  it("keeps the preview URL byte-for-byte unchanged", () => {
    const url = "/api/v1/projects/project-a/preview";
    expect(previewReloadRequest(url, 42)).toEqual({
      url,
      targetChangeSeq: 42,
    });
    expect(previewReloadRequest(url, null)).toBeNull();
  });

  it("routes every current Studio mutation surface through exact changeSeq without cache-busting URLs", () => {
    const source = (name: string) => readFileSync(
      new URL(`../../src/components/studio/${name}`, import.meta.url),
      "utf8",
    );
    const shell = source("studio-shell.tsx");
    expect(shell).not.toContain("?r=");
    expect(shell).not.toContain("setRevision");
    expect(shell).toContain("previewReloadRequest(previewUrl, changeSeq)");

    for (const name of [
      "use-source-files.ts",
      "use-preview-settings.ts",
      "scene-pane.tsx",
      "motion-library-panel.tsx",
      "bgm-panel.tsx",
      "ai-composer-panel.tsx",
      "use-mutation-history.ts",
    ]) {
      expect(source(name), name).toContain("mutationChangeSeq");
    }
  });
});
