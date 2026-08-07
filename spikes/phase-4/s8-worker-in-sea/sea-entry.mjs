/**
 * S8 — `node:worker_threads` có chạy được trong Node SEA không?
 *
 * Design §5.2 cho `FilesystemBrowserService` chạy file operation trong một
 * bounded worker (`node:worker_threads`, eval bundle) để thoả R1.14/R1.15.
 *
 * Đây đúng là cơ chế đã làm esbuild **treo vĩnh viễn** ở S1b: API sync của
 * esbuild khởi động worker bằng `__filename`, mà trong SEA đó không phải file
 * thật, nên `Atomics.wait` chờ mãi. Design né bằng cách nói "eval bundle" —
 * tức `new Worker(code, { eval: true })`, không đi qua `__filename`.
 *
 * Spike hỏi: né như thế có đủ không? Và `Atomics.wait` (đường sync mà một
 * bounded worker hay dùng) có sống trong SEA không?
 */
import { Worker, isMainThread } from "node:worker_threads";

const out = { execPath: process.execPath, steps: {} };

function step(name, promise, timeoutMs = 8000) {
  return Promise.race([
    promise.then((value) => ({ ok: true, value })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "TIMEOUT/HANG" }), timeoutMs)),
  ]).then((r) => { out.steps[name] = r; }).catch((e) => {
    out.steps[name] = { ok: false, error: String(e?.message ?? e) };
  });
}

// (a) worker eval — đường Design đề xuất
const evalWorker = () => new Promise((resolve, reject) => {
  const w = new Worker(
    `const { parentPort } = require("node:worker_threads");
     const { readdirSync } = require("node:fs");
     parentPort.on("message", (dir) => {
       parentPort.postMessage({ entries: readdirSync(dir).length });
     });`,
    { eval: true },
  );
  w.on("message", (m) => { w.terminate(); resolve(m); });
  w.on("error", (e) => reject(e));
  w.postMessage(process.cwd());
});

// (b) terminate giữa chừng — R1.15 cần huỷ được phép đọc đang treo
const terminateWorker = () => new Promise((resolve, reject) => {
  const w = new Worker(`while (true) {}`, { eval: true });
  w.on("error", reject);
  setTimeout(() => {
    w.terminate().then((code) => resolve({ terminated: true, code }), reject);
  }, 300);
});

// (c) Atomics.wait trong worker — đường sync mà esbuild dùng và đã treo
const atomicsWorker = () => new Promise((resolve, reject) => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(
    `const { workerData } = require("node:worker_threads");
     Atomics.store(workerData, 0, 42);
     Atomics.notify(workerData, 0);`,
    { eval: true, workerData: shared },
  );
  w.on("error", reject);
  w.on("exit", () => resolve({ value: Atomics.load(shared, 0) }));
});

async function main() {
  await step("workerEval", evalWorker());
  await step("workerTerminate", terminateWorker());
  await step("atomicsInWorker", atomicsWorker());
  out.pass = Object.values(out.steps).every((s) => s.ok);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.pass ? 0 : 1);
}

main();
