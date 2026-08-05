import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_KIT_FILES, AGENT_KIT_VERSION } from "@vidcom/agent-kit";
import type { Era } from "@vidcom/contracts";
import { createContractMatrixRegistry } from "../mcp/support";

const packageRoot = path.resolve("packages/agent-kit");
const skillNames = [
  "vidcom", "vidcom-project", "vidcom-scene", "vidcom-motion",
  "vidcom-look", "vidcom-narration", "vidcom-render", "vidcom-fix",
];

describe("agent-kit source and contract synchronization", () => {
  it("builds CLAUDE.md byte-for-byte from AGENTS.md and embeds current hashes", async () => {
    const [agents, claude] = await Promise.all([
      readFile(path.join(packageRoot, "AGENTS.md"), "utf8"),
      readFile(path.join(packageRoot, "CLAUDE.md"), "utf8"),
    ]);
    expect(claude).toBe(agents);
    expect(AGENT_KIT_FILES["AGENTS.md"].content).toBe(agents);
    expect(AGENT_KIT_FILES["CLAUDE.md"].content).toBe(agents);
    expect(AGENT_KIT_FILES["AGENTS.md"].contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("keeps router targets present and every skill concise, marked, and parseable", async () => {
    const router = await readFile(path.join(packageRoot, "skills/vidcom/SKILL.md"), "utf8");
    const routed = [...router.matchAll(/`\/(vidcom(?:-[a-z]+)?)`/gu)].map((match) => match[1]);
    for (const name of routed) expect(skillNames).toContain(name);
    for (const name of skillNames) {
      const content = await readFile(path.join(packageRoot, `skills/${name}/SKILL.md`), "utf8");
      // The marker is asserted against the shipped version rather than a literal:
      // a hardcoded number silently stops checking anything the moment it drifts.
      expect(content).toMatch(new RegExp(
        `^---\\n[\\s\\S]*?^name:\\s*[a-z0-9-]+\\s*$[\\s\\S]*?^description:\\s*.+$[\\s\\S]*?^x-vidcom-agent-kit:\\s*${AGENT_KIT_VERSION}\\s*$[\\s\\S]*?^---$`,
        "m",
      ));
      expect(content.split("\n").length).toBeLessThan(500);
    }
  });

  it("keeps current Registry names documented and all referenced tool names in the final catalog", async () => {
    const agents = await readFile(path.join(packageRoot, "AGENTS.md"), "utf8");
    const table = agents.slice(agents.indexOf("## Tool reference"), agents.indexOf("## Project structure"));
    const documented = new Set([...table.matchAll(/`([a-z][a-z0-9_]+)`/gu)].map((match) => match[1]));
    const registry = createContractMatrixRegistry();
    const current = registry.list("modern" as Era).map((tool) => tool.name);
    const currentToolCatalog = new Set(current);
    for (const name of current) expect(documented, `${name} missing from AGENTS.md`).toContain(name);
    for (const name of documented) expect(currentToolCatalog, `${name} is not a VidCom tool`).toContain(name);

    const skillText = await Promise.all(skillNames.map((name) => readFile(path.join(packageRoot, `skills/${name}/SKILL.md`), "utf8")));
    const referenced = new Set(skillText.flatMap((content) =>
      [...content.matchAll(/`([a-z][a-z0-9_]+)`/gu)].map((match) => match[1]).filter((name) => name.includes("_"))));
    for (const name of referenced) expect(currentToolCatalog, `${name} referenced by a skill but absent from catalog`).toContain(name);
  });
});
