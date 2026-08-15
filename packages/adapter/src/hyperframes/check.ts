import { createRequire } from "node:module";
import path from "node:path";

import type { Diagnostic } from "@vidcom/contracts";
import type { AbsolutePath, DiagnosticsLintPort, ProcessPort, ProjectRef } from "@vidcom/core";

import { VIDCOM_NODE_SENTINEL } from "./binary-probe";
import { MAX_PROCESS_CAPTURE_MAX_BYTES } from "../runtime/process-supervisor";

const requireFromAdapter = createRequire(import.meta.url);
const resolveFromAdapter = Reflect.get(requireFromAdapter, "resolve") as (specifier: string) => string;
const GROUPS = ["lint", "runtime", "layout", "motion", "contrast"] as const;

/** Runtime-specific inputs for the HyperFrames diagnostics child. */
export interface NodeHyperframesDiagnosticsLintOptions {
  /** Verified extracted CLI path; omitted only in a source checkout. */
  cliPath?: AbsolutePath;
  timeoutMs?: number;
  /** Test seam for Node's process-wide SEA state. */
  isSea?: () => boolean;
}

interface CheckFinding {
  code?: unknown;
  severity?: unknown;
  message?: unknown;
  sourceFile?: unknown;
  line?: unknown;
}

function sourcePath(root: string, value: unknown): Diagnostic["file"] {
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  const relative = path.relative(root, value);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/") as Diagnostic["file"];
}

function diagnostic(root: string, finding: CheckFinding): Diagnostic | null {
  if (typeof finding.code !== "string" || typeof finding.message !== "string"
    || !["error", "warning", "info"].includes(String(finding.severity))) return null;
  const file = sourcePath(root, finding.sourceFile);
  return {
    severity: finding.severity as Diagnostic["severity"],
    code: `lint:${finding.code}`,
    ...(file ? { file } : {}),
    ...(typeof finding.line === "number" && Number.isInteger(finding.line) && finding.line > 0
      ? { line: finding.line } : {}),
    message: finding.message,
  };
}

function runningAsSea(): boolean {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea(): boolean } | undefined;
  return sea?.isSea() === true;
}

/** Runs the pinned HyperFrames checker without interpreting a finding exit as tool absence. */
export class NodeHyperframesDiagnosticsLint implements DiagnosticsLintPort {
  private readonly cliPath: string;
  private readonly timeoutMs: number;
  private readonly isSea: () => boolean;

  constructor(
    private readonly processes: ProcessPort,
    options: NodeHyperframesDiagnosticsLintOptions = {},
  ) {
    this.cliPath = options.cliPath ?? Reflect.apply(
      resolveFromAdapter,
      requireFromAdapter,
      ["hyperframes/bin/hyperframes.mjs"],
    );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.isSea = options.isSea ?? runningAsSea;
  }

  async check(ref: ProjectRef): Promise<{ available: boolean; diagnostics: Diagnostic[] }> {
    try {
      const output = await this.processes.run({
        command: [
          process.execPath,
          ...(this.isSea() ? [VIDCOM_NODE_SENTINEL] : []),
          this.cliPath,
          "check",
          "--json",
          ref.root,
        ],
        cwd: ref.root,
        timeoutMs: this.timeoutMs,
        captureMaxBytes: MAX_PROCESS_CAPTURE_MAX_BYTES,
      });
      if (output.timedOut || !output.stdout.trim()) return { available: false, diagnostics: [] };
      const parsed = JSON.parse(output.stdout) as Record<string, { findings?: unknown }>;
      const diagnostics = GROUPS.flatMap((group) => {
        const findings = parsed[group]?.findings;
        return Array.isArray(findings)
          ? findings.map((finding) => diagnostic(ref.root, finding as CheckFinding))
              .filter((item): item is Diagnostic => item !== null)
          : [];
      });
      return { available: true, diagnostics };
    } catch {
      return { available: false, diagnostics: [] };
    }
  }
}
