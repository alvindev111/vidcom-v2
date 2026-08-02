/** @param {import("node:child_process").ChildProcess} child @param {number} timeoutMs */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/**
 * Stops a runtime child. A graceful timeout is always a failed smoke even when
 * SIGKILL succeeds, so CI cannot hide a shutdown regression.
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 */
export async function stopRuntimeChild(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, timeoutMs)) return;
  child.kill("SIGKILL");
  const killed = await waitForExit(child, timeoutMs);
  throw new Error(killed
    ? "Next runtime ignored SIGTERM and required SIGKILL"
    : "Next runtime ignored SIGTERM and SIGKILL");
}
