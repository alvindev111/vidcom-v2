import { fileURLToPath } from "node:url";

import { Client as ModernClient, StreamableHTTPClientTransport as ModernHttp } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdio } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "@vidcom/core";
import { createMcpHttpHandlers } from "@vidcom/mcp";

import {
  CONTRACT_MATRIX_CASES,
  createContractMatrixRegistry,
  matrixHash,
  matrixNewHash,
} from "./support";

const fixture = fileURLToPath(new URL("./fixtures/contract-matrix-server.ts", import.meta.url));
const modernRevision = "2026-07-28";
const legacyRevision = "2025-11-25";
const expectedTools = Object.keys(CONTRACT_MATRIX_CASES).sort();
const projectId = "project-contract-matrix";
const expectedSuccess: Record<string, object> = {
  list_projects: {
    projects: [{ projectId, projectRevision: 2 }],
    diagnostics: [],
    nextCursor: null,
  },
  get_project_context: {
    project: { id: projectId, revision: 2 },
    scenes: [{ id: "scene-1" }],
    projectRevision: 2,
  },
  list_scenes: { scenes: [{ id: "scene-1" }], projectRevision: 2 },
  read_composition: { path: "index.html", contentHash: matrixHash },
  create_scene: {
    scene: { id: "scene-2", fileContentHash: matrixNewHash },
    envelope: { projectRevision: 3 },
  },
  set_scene_timing: {
    scene: { id: "scene-1", duration: 4, fileContentHash: matrixNewHash },
    envelope: { projectRevision: 3 },
  },
  set_text: {
    scene: { id: "scene-1", fileContentHash: matrixNewHash },
    // The matrix scene now carries narration, so editing its text marks that
    // narration stale — which is the point of the flag.
    narrationStale: true,
    envelope: { projectRevision: 3 },
  },
  save_file: {
    file: { path: "compositions/scene-1.html", contentHash: matrixNewHash },
    envelope: { projectRevision: 3 },
  },
  delete_file: {
    deleted: "compositions/unused.html",
    backupId: "backup-contract-matrix",
    envelope: { projectRevision: 3 },
  },
  delete_scene: {
    deletedFile: "compositions/scene-1.html",
    backupId: "backup-contract-matrix",
    envelope: { projectRevision: 3 },
  },
  list_tts_voices: { providers: [{ id: "matrix-tts", available: true }] },
  start_tts: { jobId: "job_matrix", status: "queued", pollWith: "get_job_status" },
  get_job_status: {
    id: "job_matrix",
    type: "tts",
    status: "succeeded",
    outcome: "succeeded",
    pollAfterMs: null,
  },
  validate_project: { diagnostics: [], computedAtSourceRevision: 2, lintSourceAvailable: true },
  start_snapshot: { jobId: "job_snapshot" },
  start_render: { jobId: "job_render" },
  install_agent_kit: {
    operationResult: { status: "no_change", changedFiles: [] },
    installationState: { outcome: "already_installed", usableBy: { codex: "ready" } },
  },
};

async function exercise(client: LegacyClient | ModernClient): Promise<void> {
  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual(expectedTools);
  for (const [name, arguments_] of Object.entries(CONTRACT_MATRIX_CASES)) {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect((result as { isError?: boolean }).isError, name).not.toBe(true);
    const structuredContent = (result as { structuredContent?: unknown }).structuredContent;
    expect(structuredContent, name).toMatchObject(expectedSuccess[name]!);
    const text = (result as { content?: Array<{ type: string; text?: string }> })
      .content?.find((item) => item.type === "text")?.text;
    expect(text, name).toBe(canonicalizeJson(structuredContent));
  }
}

function modernClient(name: string): ModernClient {
  return new ModernClient(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: modernRevision } } },
  );
}

describe("2 era x 2 transport production-tool contract matrix", () => {
  it("runs all tools with sdk@1.30.0 over stdio", async () => {
    const transport = new LegacyStdio({
      command: "bun",
      args: ["run", fixture, legacyRevision],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new LegacyClient({ name: "matrix-legacy-stdio", version: "1.0.0" });
    try {
      await client.connect(transport);
      await exercise(client);
    } finally {
      await client.close();
    }
    expect(transport.pid).toBeNull();
  });

  it("runs all tools with client@2.0.0 over stdio", async () => {
    const transport = new ModernStdio({
      command: "bun",
      args: ["run", fixture, modernRevision],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = modernClient("matrix-modern-stdio");
    try {
      await client.connect(transport);
      await exercise(client);
    } finally {
      await client.close();
    }
    expect(transport.pid).toBeNull();
  });

  it("runs all tools with sdk@1.30.0 over HTTP", async () => {
    const http = createMcpHttpHandlers(createContractMatrixRegistry());
    const handler = http.handlers.get(legacyRevision);
    if (!handler) throw new Error("missing legacy handler");
    const client = new LegacyClient({ name: "matrix-legacy-http", version: "1.0.0" });
    try {
      await client.connect(new LegacyHttp(new URL("http://vidcom.test/api/mcp"), {
        fetch: (input, init) => handler(new Request(input, init)),
      }));
      await exercise(client);
    } finally {
      await client.close();
      await http.close();
    }
  });

  it("runs all tools with client@2.0.0 over HTTP", async () => {
    const http = createMcpHttpHandlers(createContractMatrixRegistry());
    const handler = http.handlers.get(modernRevision);
    if (!handler) throw new Error("missing modern handler");
    const client = modernClient("matrix-modern-http");
    try {
      await client.connect(new ModernHttp(new URL("http://vidcom.test/api/mcp"), {
        fetch: (input, init) => handler(new Request(input, init)),
      }));
      await exercise(client);
    } finally {
      await client.close();
      await http.close();
    }
  });
});
