/**
 * The daemon HTTP surface, on one loopback port, for the runtime smoke.
 *
 * This used to be `next start`. The frontend is a static export now, so Next
 * has no server to run and no API to carry — the daemon owns both, and this is
 * the process that owns them. Every assertion the smoke makes is about the API,
 * the MCP transports and the event stream, all of which live here.
 *
 * Run under Bun so the TypeScript modules load directly, which is how the rest
 * of this repository already runs.
 */
import { handleNextHostedRequest } from "../packages/cli/src/next-host.ts";
import { bindLoopback } from "../packages/server/src/listener.ts";

const port = Number(process.argv[2] ?? 0);
if (!Number.isInteger(port) || port < 1) {
  process.stderr.write("runtime-smoke-host: expected a port\n");
  process.exit(2);
}

const listener = await bindLoopback({ fetch: handleNextHostedRequest }, port);
// The smoke waits for this line rather than polling a route, so readiness is
// the listener being bound and not a guess about which path answers first.
process.stdout.write(`runtime-smoke-host: listening ${listener.port}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void listener.close().then(() => process.exit(0));
  });
}
