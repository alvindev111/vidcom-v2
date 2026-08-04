import { describe, expect, it } from "vitest";

import { ErrorCode } from "@vidcom/contracts";
import type { AbsolutePath, WorkspaceCandidate } from "@vidcom/core";
import { checkPathPurpose, checkPathSyntax, resolveWorkspace } from "@vidcom/core";

const root = (value: string) => value as AbsolutePath;
const candidate = (
  value: string,
  readable: boolean,
  hasIdentityFile = false,
  parentReadable = true,
): WorkspaceCandidate => ({ root: root(value), readable, hasIdentityFile, parentReadable });

describe("workspace resolution", () => {
  it("implements the approved eight-row decision table", () => {
    expect(resolveWorkspace({
      explicit: candidate("/explicit", true),
      cwd: candidate("/work/project", true, true),
      active: candidate("/active", true),
    })).toMatchObject({ status: "resolved", root: "/explicit", source: "explicit", openProject: null });

    expect(resolveWorkspace({ explicit: candidate("/missing", false) })).toEqual({
      status: "error", code: ErrorCode.PathInvalid, path: "/missing", reason: "explicit workspace is not readable",
    });

    expect(resolveWorkspace({
      cwd: candidate("/work/project", true, true, true),
      active: candidate("/active", true),
    })).toMatchObject({ status: "resolved", root: "/work", source: "cwd-project", openProject: "/work/project" });

    expect(resolveWorkspace({
      cwd: candidate("/locked/project", true, true, false),
      active: candidate("/active", true),
    })).toMatchObject({ status: "resolved", root: "/locked/project", source: "cwd-solo", openProject: "/locked/project" });

    expect(resolveWorkspace({
      cwd: candidate("/cwd", true),
      active: candidate("/active", true),
    })).toMatchObject({ status: "resolved", root: "/active", source: "active", warnings: [] });

    expect(resolveWorkspace({
      cwd: candidate("/cwd", true),
      active: candidate("/removed", false),
    })).toEqual({
      status: "resolved", root: "/cwd", source: "cwd", openProject: null,
      warnings: [{
        code: "active_workspace_unreadable", path: "/removed", reason: "saved active workspace is not readable",
      }],
    });

    expect(resolveWorkspace({ cwd: candidate("/cwd", true) }))
      .toMatchObject({ status: "resolved", root: "/cwd", source: "cwd" });

    expect(resolveWorkspace({ cwd: candidate("/cwd", false) })).toEqual({
      status: "error", code: ErrorCode.PathInvalid, path: "/cwd", reason: "working directory is not readable",
    });
  });

  it("treats an invalid identity file as a present marker and never falls through to active", () => {
    expect(resolveWorkspace({
      cwd: candidate("C:\\videos\\broken-project", true, true, true),
      active: candidate("C:\\other", true),
    })).toMatchObject({
      status: "resolved",
      root: "C:\\videos",
      openProject: "C:\\videos\\broken-project",
      source: "cwd-project",
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
    ["state-write", ".vidcom/state.json"],
    ["state-write", ".vidcom/context/project.md"],
    ["workspace-agent-kit", "AGENTS.md"],
    ["workspace-agent-kit", ".agents/skills/vidcom/SKILL.md"],
  ] as const)("allows the %s purpose", (purpose, path) => {
    expect(checkPathPurpose(path, purpose)).toBeNull();
  });

  it.each([
    ["read-asset", "assets/payload.exe"],
    ["write-source", "preview-settings.json"],
    ["write-source", ".vidcom/state.json"],
    ["system-write", "index.html"],
    ["read-source", ".env"],
    ["state-write", ".env.production"],
    ["workspace-agent-kit", ".env"],
    ["state-write", ".vidcom/unknown.json"],
    ["workspace-agent-kit", "projects/demo/AGENTS.md"],
    ["workspace-agent-kit", ".agents/skills/.secret/SKILL.md"],
    ["write-asset", "package.json"],
  ] as const)("denies a non-allowlisted %s path", (purpose, path) => {
    expect(checkPathPurpose(path, purpose)).toEqual({ reason: "not_allowed_for_purpose" });
  });
});
