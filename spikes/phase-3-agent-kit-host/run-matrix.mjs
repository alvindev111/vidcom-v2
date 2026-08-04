#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const spikeDir = dirname(fileURLToPath(import.meta.url));
const runRoot = mkdtempSync(join(tmpdir(), "vidcom-host-matrix-"));
const mockServer = join(spikeDir, "mock-mcp.mjs");
const results = [];
const requestedHosts = process.argv.slice(2);
const hosts = requestedHosts.length > 0 ? requestedHosts : ["codex", "claude-code"];

if (hosts.some((host) => host !== "codex" && host !== "claude-code")) {
  throw new Error("Hosts must be codex or claude-code");
}

mkdirSync(runRoot, { recursive: true });

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function skill(caseId, { extraFrontmatter = false, requireLinkToken = false } = {}) {
  return `---
name: vidcom
description: Use only when the user explicitly invokes VidCom for the host-discovery spike.
${extraFrontmatter ? "x-vidcom-agent-kit: 3.0.0\n" : ""}---

Call the \`vidcom_probe\` MCP tool exactly once with \`caseId: "${caseId}"\`.
${requireLinkToken ? "Read `VIDCOM_LINK_TOKEN` from the effective workspace instructions and pass it as `linkToken`. If it is absent, do not call any tool and reply `LINK_NOT_FOLLOWED`.\n" : ""}After the tool returns, reply exactly \`VIDCOM_PROBE_OK ${caseId}\`.
Do not search the filesystem and do not use a shell command.
`;
}

function mcpConfig(logPath) {
  return JSON.stringify({
    mcpServers: {
      vidcom_mock: {
        type: "stdio",
        command: process.execPath,
        args: [mockServer],
        env: { VIDCOM_PROBE_LOG: logPath },
      },
    },
  });
}

function runHost(host, caseId, root, logPath) {
  const prompt = host === "codex"
    ? `$vidcom Run case ${caseId}. Use only the registered skill; do not search for skill files.`
    : `/vidcom Run case ${caseId}. Use only the registered skill; do not search for skill files.`;
  const command = host === "codex" ? "codex" : "claude";
  const args = host === "codex"
    ? [
        "--ask-for-approval", "never", "exec", "--ephemeral", "--ignore-user-config",
        "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-C", root,
        "-c", `mcp_servers.vidcom_mock.command=${JSON.stringify(process.execPath)}`,
        "-c", `mcp_servers.vidcom_mock.args=[${JSON.stringify(mockServer)}]`,
        "-c", `mcp_servers.vidcom_mock.env.VIDCOM_PROBE_LOG=${JSON.stringify(logPath)}`,
        "-c", 'mcp_servers.vidcom_mock.enabled_tools=["vidcom_probe"]',
        "-c", 'mcp_servers.vidcom_mock.default_tools_approval_mode="approve"',
        prompt,
      ]
    : [
        "-p", prompt, "--no-session-persistence", "--output-format", "stream-json", "--verbose",
        "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", mcpConfig(logPath),
        "--allowedTools", "mcp__vidcom_mock__vidcom_probe", "--setting-sources", "project",
      ];
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 180_000,
  });
}

function called(logPath, caseId, linkToken) {
  try {
    return readFileSync(logPath, "utf8").trim().split(/\r?\n/).some((line) => {
      const value = JSON.parse(line);
      return value.caseId === caseId && (linkToken === undefined || value.linkToken === linkToken);
    });
  } catch {
    return false;
  }
}

function runCase(host, name, directory, options = {}) {
  const caseId = `${host}-${name}`;
  const root = join(runRoot, caseId);
  const logPath = join(root, "probe.jsonl");
  write(join(root, directory, "vidcom", "SKILL.md"), skill(caseId, options));
  if (options.linkToken) {
    if (host === "codex") {
      write(join(root, "AGENTS.md"), "Read and follow ./AGENTS.vidcom.md.\n");
      write(join(root, "AGENTS.vidcom.md"), `VIDCOM_LINK_TOKEN=${options.linkToken}\n`);
    } else {
      write(join(root, "CLAUDE.md"), "@CLAUDE.vidcom.md\n");
      write(join(root, "CLAUDE.vidcom.md"), `VIDCOM_LINK_TOKEN=${options.linkToken}\n`);
    }
  }
  const execution = runHost(host, caseId, root, logPath);
  const passed = called(logPath, caseId, options.linkToken);
  results.push({
    host,
    case: name,
    directory,
    passed,
    exitCode: execution.status,
    signal: execution.signal,
    stdout: execution.stdout?.slice(-4000) ?? "",
    stderr: execution.stderr?.slice(-4000) ?? "",
  });
  process.stdout.write(`${host.padEnd(11)} ${name.padEnd(22)} ${passed ? "PASS" : "NO CALL"}\n`);
  return passed;
}

for (const host of hosts) {
  const agents = runCase(host, "agents-directory", ".agents/skills");
  const claude = runCase(host, "claude-directory", ".claude/skills");
  const supported = agents ? ".agents/skills" : claude ? ".claude/skills" : null;
  if (supported) {
    runCase(host, "extra-frontmatter", supported, { extraFrontmatter: true });
    runCase(host, "instruction-link", supported, {
      requireLinkToken: true,
      linkToken: `${host}-link-ok`,
    });
  }
}

const resultPath = join(runRoot, "results.json");
writeFileSync(resultPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  node: process.version,
  codex: spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim(),
  claudeCode: spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim(),
  results,
}, null, 2)}\n`, "utf8");

process.stdout.write(`Evidence: ${resultPath}\n`);
