import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const matrices = [
  {
    label: "MCP server",
    path: "llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-implementation-checklist.md",
    phases: [..."ABCDEFGHIJKLMNOP"],
  },
  {
    label: "project delivery loop",
    path: "llm-documents/specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-implementation-checklist.md",
    phases: [..."ABCDEFGHIJKLMNOPQRS"],
  },
  {
    label: "packaging & distribution",
    path: "llm-documents/specs-and-process/specs/spec-packaging-and-distribution/spec-packaging-and-distribution-implementation-checklist.md",
    phases: [..."ABCDEFGHIJKLM"],
  },
  {
    label: "editing experience",
    path: "llm-documents/specs-and-process/specs/spec-editing-experience/spec-editing-experience-implementation-checklist.md",
    // Multi-character ids, which is why phases is a list rather than a string of
    // single letters: "P1" and "P11" are different rows and must stay so.
    phases: ["S0", "P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"],
  },
  {
    label: "editing experience R16-R20 addendum",
    path: "llm-documents/specs-and-process/specs/spec-editing-experience/spec-editing-experience-implementation-checklist.md",
    startHeading: "## R16–R20 Addendum Verification Commands\n",
    endHeading: "\n---\n\n## Phase S0:",
    phases: ["P19", "P20", "P21", "P22", "P23", "P24", "P25"],
  },
];

let verifiedPathCount = 0;
for (const item of matrices) {
  const checklist = readFileSync(path.join(repositoryRoot, item.path), "utf8");
  const startHeading = item.startHeading ?? "## Phase Verification Matrix\n";
  const endHeading = item.endHeading ?? "## Task Status Legend\n";
  const matrix = checklist.split(startHeading, 2)[1]?.split(endHeading, 1)[0];
  if (!matrix) throw new Error(`${item.label} Phase Verification Matrix section was not found`);

  const phases = [...matrix.matchAll(/^\| ([A-Z][A-Z0-9]*) \|/gm)].map((match) => match[1]);
  if (phases.join(",") !== item.phases.join(",")) {
    throw new Error(`${item.label} Phase Verification Matrix rows drifted: ${phases.join(",")}`);
  }

  const referencedPaths = [...new Set(matrix.match(/tests\/[A-Za-z0-9._/-]+/g) ?? [])];
  const missing = referencedPaths.filter((relative) => !existsSync(path.join(repositoryRoot, relative)));
  if (missing.length > 0) {
    throw new Error(`Missing ${item.label} Verification Matrix paths:\n${missing.join("\n")}`);
  }
  verifiedPathCount += referencedPaths.length;
}

process.stdout.write(`Verified ${verifiedPathCount} Verification Matrix test paths across ${matrices.length} specs.\n`);
