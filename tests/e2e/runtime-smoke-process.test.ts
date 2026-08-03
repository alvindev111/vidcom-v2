import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { stopRuntimeChild } from "../../scripts/runtime-smoke-process.mjs";
import { hasPosixSignals } from "../support/platform";

// Windows maps kill("SIGTERM") to TerminateProcess, so a child cannot trap the
// graceful stop and the SIGKILL escalation branch is unreachable there.
const itWithSignals = hasPosixSignals ? it : it.skip;

describe("runtime smoke child cleanup", () => {
  itWithSignals("fails the smoke and kills hard when the child ignores SIGTERM", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child.stdout!, "data");

    await expect(stopRuntimeChild(child, 100)).rejects.toThrow("required SIGKILL");
    expect(child.signalCode).toBe("SIGKILL");
  });
});
