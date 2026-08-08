import {
  ProcessTerminationUnverifiedError,
  processIdentityMatches,
  terminationResult,
} from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import type { ProcessTerminationProof } from "@vidcom/core";
import { describe, expect, it } from "vitest";

function proof(overrides: Partial<ProcessTerminationProof> = {}): ProcessTerminationProof {
  return {
    reason: "abort",
    attempted: [4242],
    survivors: [],
    exhaustive: true,
    ...overrides,
  } as ProcessTerminationProof;
}

describe("termination proof contract", () => {
  it("carries the exhaustive flag rather than claiming no children remain", () => {
    // steering/08 §6.1 withdrew the "no child processes remain" guarantee. What
    // survives is a proof that says how far the sweep actually got, and a
    // caller that treats a non-exhaustive proof as a clean kill is reading it
    // wrong.
    const result = terminationResult(proof({ exhaustive: false }));
    expect(result.status).toBe("terminated");
    expect(result.proof.exhaustive).toBe(false);
    expect(result.warnings).toEqual(["termination_proof_not_exhaustive"]);
  });

  it("says nothing extra when the sweep was exhaustive", () => {
    const result = terminationResult(proof({ exhaustive: true }));
    expect(result.warnings).toEqual([]);
  });

  it("refuses to report cancelled while a survivor is still running", () => {
    // Recording a cancel here would claim the job stopped while its child keeps
    // writing to the workdir.
    let error: ProcessTerminationUnverifiedError | undefined;
    try {
      terminationResult(proof({ survivors: [4243], exhaustive: true }));
    } catch (caught) {
      error = caught as ProcessTerminationUnverifiedError;
    }
    expect(error).toBeInstanceOf(ProcessTerminationUnverifiedError);
    expect(error?.code).toBe(ErrorCode.ProcessTerminationUnverified);
    expect(error?.proof.survivors).toEqual([4243]);
  });

  it("still refuses when the sweep was not exhaustive and found survivors", () => {
    expect(() => terminationResult(proof({ survivors: [1], exhaustive: false })))
      .toThrow(ProcessTerminationUnverifiedError);
  });

  it("names the survivors in the message, since a pid is what an operator can act on", () => {
    try {
      terminationResult(proof({ survivors: [4243, 4244] }));
      expect.unreachable("expected the proof to be rejected");
    } catch (caught) {
      expect((caught as Error).message).toContain("4243");
      expect((caught as Error).message).toContain("4244");
    }
  });

  it("does not accept a reused pid as the process that was captured", () => {
    // The pid is the same; the process is not. Treating this as a match is how
    // a sweep concludes a live stranger is the child it killed.
    expect(processIdentityMatches(
      { pid: 4242, startedAt: "posix-ps-utc:2026-08-08 00:00:00" },
      { pid: 4242, startedAt: "posix-ps-utc:2026-08-08 00:05:00" },
    )).toBe(false);
    expect(processIdentityMatches(
      { pid: 4242, startedAt: "posix-ps-utc:2026-08-08 00:00:00" },
      undefined,
    )).toBe(false);
    expect(processIdentityMatches(
      { pid: 4242, startedAt: "posix-ps-utc:2026-08-08 00:00:00" },
      { pid: 4242, startedAt: "posix-ps-utc:2026-08-08 00:00:00" },
    )).toBe(true);
  });
});
