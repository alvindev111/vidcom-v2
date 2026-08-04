import type { ProcessPort, ProcessRunInput, ProcessRunOutput } from "@vidcom/core";

import { allowlistedEnvironment } from "./process-environment";
import { NodeProcessSupervisor } from "./process-supervisor";

/** 5 minutes — a VieNeu model download, not a routine ffmpeg call. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

export { allowlistedEnvironment } from "./process-environment";

/**
 * Backward-compatible TTS process adapter backed by the same three-phase
 * supervisor as render jobs. Abort still throws; timeout remains a normal
 * `ProcessRunOutput`, as required by the older `ProcessPort` contract.
 */
export class NodeProcessRunner implements ProcessPort {
  private readonly supervisor: NodeProcessSupervisor;

  constructor(private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.supervisor = new NodeProcessSupervisor(defaultTimeoutMs);
  }

  async run(input: ProcessRunInput): Promise<ProcessRunOutput> {
    const result = await this.supervisor.run({
      ...input,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      environment: allowlistedEnvironment(process.env, input.environment) as Record<string, string>,
    });
    if (result.status === "exited") return result.output;
    if (result.proof.reason === "abort") {
      input.signal?.throwIfAborted();
      throw new DOMException("process aborted", "AbortError");
    }
    return { exitCode: null, stdout: "", stderr: "", timedOut: true };
  }
}
