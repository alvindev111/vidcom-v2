import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const checklistPath = path.join(
  repositoryRoot,
  "llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-implementation-checklist.md",
);
const checklist = readFileSync(checklistPath, "utf8");
const matrix = checklist.split("## Phase Verification Matrix\n", 2)[1]?.split("## Task Status Legend\n", 1)[0];
if (!matrix) throw new Error("Phase Verification Matrix section was not found");

const phases = [...matrix.matchAll(/^\| ([A-P]) \|/gm)].map((match) => match[1]);
const expectedPhases = "ABCDEFGHIJKLMNOP".split("");
if (phases.join("") !== expectedPhases.join("")) {
  throw new Error(`Phase Verification Matrix rows drifted: ${phases.join(",")}`);
}

const referencedPaths = [...new Set(matrix.match(/tests\/[A-Za-z0-9._/-]+/g) ?? [])];
const missing = referencedPaths.filter((relative) => !existsSync(path.join(repositoryRoot, relative)));
if (missing.length > 0) throw new Error(`Missing Verification Matrix paths:\n${missing.join("\n")}`);

process.stdout.write(`Verified ${referencedPaths.length} Verification Matrix test paths across 16 phases.\n`);
