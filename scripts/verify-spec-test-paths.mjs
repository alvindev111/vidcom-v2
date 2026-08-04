import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const matrices = [
  {
    label: "MCP server",
    path: "llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-implementation-checklist.md",
    phases: "ABCDEFGHIJKLMNOP",
  },
  {
    label: "project delivery loop",
    path: "llm-documents/specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-implementation-checklist.md",
    phases: "ABCDEFGHIJKLMNOPQRS",
  },
];

let verifiedPathCount = 0;
for (const item of matrices) {
  const checklist = readFileSync(path.join(repositoryRoot, item.path), "utf8");
  const matrix = checklist.split("## Phase Verification Matrix\n", 2)[1]?.split("## Task Status Legend\n", 1)[0];
  if (!matrix) throw new Error(`${item.label} Phase Verification Matrix section was not found`);

  const phases = [...matrix.matchAll(/^\| ([A-Z]) \|/gm)].map((match) => match[1]);
  if (phases.join("") !== item.phases) {
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
