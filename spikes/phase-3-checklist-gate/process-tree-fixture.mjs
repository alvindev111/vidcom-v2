// A process tree that escapes its own group, the way a real render does.
//
// S1b/S1c found the leak with `chrome-headless-shell`, but pinning a
// cross-platform contract test to Chromium would make it slow, network-dependent
// and specific to one engine's habits. What actually has to be reproduced is the
// SHAPE: a descendant that leaves the root's process group, plus a descendant
// below it, so a group-scoped kill provably misses them.
//
// `detached: true` is exactly that on both families — a new process group on
// POSIX, a new process group on Windows. Same flag, same escape, no Chromium.
//
// Usage: node process-tree-fixture.mjs <role> <ledgerPath>
//   root      spawns one in-group child and one escaping child, then idles
//   inGroup   idles
//   escaping  spawns one child of its own, then idles
//   leaf      idles
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [role, ledger] = process.argv.slice(2);
const self = new URL(import.meta.url).pathname;

// Append rather than rewrite: four processes record themselves concurrently and
// a read-modify-write would lose entries under exactly the race we want covered.
appendFileSync(ledger, `${JSON.stringify({ role, pid: process.pid, ppid: process.ppid })}\n`);

function child(childRole, detached) {
  const handle = spawn(process.execPath, [self, childRole, ledger], {
    detached,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Unref only the escaping branch: the point is that it outlives us.
  if (detached) handle.unref();
  return handle;
}

if (role === "root") {
  child("inGroup", false);
  child("escaping", true);
} else if (role === "escaping") {
  child("leaf", false);
}

// Idle long enough for the harness to capture, kill and verify, but bounded so a
// crashed harness cannot leave these behind for the session.
setTimeout(() => process.exit(0), 120_000);
