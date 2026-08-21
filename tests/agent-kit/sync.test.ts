import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_KIT_FILES, AGENT_KIT_VERSION } from "@vidcom/agent-kit";
import type { Era } from "@vidcom/contracts";
import { MCP_SERVER_INSTRUCTIONS } from "@vidcom/mcp";
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

  it("bootstraps VidCom instructions before routing and scores videos by default", async () => {
    const [agents, router, look] = await Promise.all([
      readFile(path.join(packageRoot, "AGENTS.md"), "utf8"),
      readFile(path.join(packageRoot, "skills/vidcom/SKILL.md"), "utf8"),
      readFile(path.join(packageRoot, "skills/vidcom-look/SKILL.md"), "utf8"),
    ]);

    expect(agents.indexOf("install_agent_kit")).toBeLessThan(agents.indexOf("list_projects"));
    expect(router.indexOf("install_agent_kit")).toBeLessThan(router.indexOf("list_projects"));
    expect(agents).toContain("Background music is the default for every video");
    expect(agents).toContain("call `search_bgm` with the intended mood");
    expect(look).toContain("Call `search_bgm` with the intended mood first");
    expect(look).toContain("`list_bgm_beds` and install an offline bed");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("call search_bgm with the intended mood");
  });

  it("makes value-first storytelling and meaningful multi-phase motion the render contract", async () => {
    const [agents, router, motion, render, prompt] = await Promise.all([
      readFile(path.join(packageRoot, "AGENTS.md"), "utf8"),
      readFile(path.join(packageRoot, "skills/vidcom/SKILL.md"), "utf8"),
      readFile(path.join(packageRoot, "skills/vidcom-motion/SKILL.md"), "utf8"),
      readFile(path.join(packageRoot, "skills/vidcom-render/SKILL.md"), "utf8"),
      readFile(path.join(packageRoot, "prompts/create-video.md"), "utf8"),
    ]);
    const descriptions = new Map(
      createContractMatrixRegistry().list("modern" as Era).map((tool) => [tool.name, tool.description]),
    );

    expect(MCP_SERVER_INSTRUCTIONS).toContain("Story-driven video is the default");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Do not treat a lone fade");
    expect(agents).toContain("setup → development → payoff → hold");
    expect(router).toContain("value-first beat table");
    expect(motion).toContain("## Story-motion contract");
    expect(motion).toContain("Compose 2-4 complementary motion patterns");
    expect(motion).toContain("Dynamic selectors fail closed");
    expect(render).toContain("Reject scenes whose primary choreography is only a fade");
    expect(render).toContain("`story-motion-shallow`");
    expect(render).toContain("`story-motion-unverified`");
    expect(prompt).toContain("fade-only");
    expect(descriptions.get("create_scene")).toContain("meaningful visual change");
    expect(descriptions.get("save_file")).toContain("fade, gentle rise/drop");
    expect(descriptions.get("install_motion_library")).toContain("multi-phase choreography");
    expect(descriptions.get("start_render")).toContain("setup/development/payoff/hold");
    expect(AGENT_KIT_VERSION).toBe(9);
    expect(agents).toContain("vidcomAgentKitVersion");
    expect(agents).toContain("6–10 seconds");
    expect(agents).toContain("at least three primary patterns");
    expect(agents).toContain("75% of story time");
    expect(motion).toContain("data-story-pattern");
    expect(motion).toContain("data-seam-kind");
    expect(motion).toContain("first, middle, and final thirds");
    expect(render).toContain("story-pattern-diversity");
    expect(render).toContain("story-narration-sparse");
    expect(render).toContain("contact sheet");
  });
});
