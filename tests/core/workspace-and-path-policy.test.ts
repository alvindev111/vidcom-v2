import { describe, expect, it } from "vitest";

import type { AbsolutePath } from "@vidcom/core";
import { checkPathPurpose, checkPathSyntax, resolveWorkspace } from "@vidcom/core";

const root = (value: string) => value as AbsolutePath;

describe("workspace resolution", () => {
  it("uses explicit, active and marker-backed cwd in that order", () => {
    expect(
      resolveWorkspace({
        explicit: { root: root("/explicit"), valid: true },
        active: { root: root("/active"), valid: true },
        cwd: { root: root("/cwd"), valid: true },
      }),
    ).toEqual({ status: "resolved", root: "/explicit", source: "explicit" });
    expect(
      resolveWorkspace({
        explicit: { root: root("/explicit"), valid: false },
        active: { root: root("/active"), valid: true },
        cwd: { root: root("/cwd"), valid: true },
      }),
    ).toEqual({ status: "resolved", root: "/active", source: "active" });
    expect(
      resolveWorkspace({ cwd: { root: root("/cwd"), valid: true } }),
    ).toEqual({ status: "resolved", root: "/cwd", source: "cwd" });
  });

  it("requires selection instead of creating or guessing a directory", () => {
    expect(resolveWorkspace({ cwd: { root: root("/cwd"), valid: false } })).toEqual({
      status: "selection_required",
    });
  });
});

describe("pure path policy", () => {
  it.each(["../secret", "/tmp/file", "C:\\secret", "scene//index.html"])(
    "rejects invalid project-relative syntax: %s",
    (path) => expect(checkPathSyntax(path)).toEqual({ reason: "invalid_syntax" }),
  );

  it.each([
    ["read-source", "compositions/scene.ts"],
    ["read-asset", "assets/poster.png"],
    ["write-source", "compositions/scene.html"],
    ["write-asset", "preview-assets/bgm/music.mp3"],
    ["system-write", "preview-settings.json"],
  ] as const)("allows the %s purpose", (purpose, path) => {
    expect(checkPathPurpose(path, purpose)).toBeNull();
  });

  it.each([
    ["read-asset", "assets/payload.exe"],
    ["write-source", "preview-settings.json"],
    ["system-write", "index.html"],
    ["read-source", ".env"],
    ["write-asset", "package.json"],
  ] as const)("denies a non-allowlisted %s path", (purpose, path) => {
    expect(checkPathPurpose(path, purpose)).toEqual({ reason: "not_allowed_for_purpose" });
  });
});
