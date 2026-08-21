// @vitest-environment node

import { spawn } from "node:child_process";
import { expect, it } from "vitest";

interface Evidence {
  profile: "presubmit" | "release"; exactBytes: number;
  warmupStatus: number; exactStatus: number; rssDeltaBytes: number;
  baselineRss: number; baselineMemory: NodeJS.MemoryUsage; peakRss: number; peakMemory: NodeJS.MemoryUsage;
  oneOverStatus: number; oversizedStatus: number; tempAfterAbort: string[];
  firstStatus: number; replayStatus: number; replayed: boolean;
  replayRevisionStable: boolean; replayWriteStable: boolean; replayJournalStable: boolean;
  changedStatuses: number[]; expiredStatus: number;
  brokenFontStatus: number; brokenFontMetadata: string; brokenFontApplyStatus: number; brokenFontApplyBody: string;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code !== 0) reject(new Error(output.stderr || output.stdout || `${command} exited ${code}`));
      else resolve(output);
    });
  });
}

it("streams assets through a real HTTP/1.1 listener with bounded memory and exact replay", { timeout: 420_000 }, async () => {
  const support = new URL("./support/", import.meta.url);
  const loader = new URL("workspace-typescript-loader.mjs", support);
  const worker = new URL("asset-streaming-listener-worker.ts", support);
  const { stdout } = await run(process.execPath, [
    "--expose-gc",
    "--experimental-transform-types",
    "--input-type=module",
    "--eval", [
      'import { register } from "node:module";',
      `register(${JSON.stringify(loader.href)});`,
      `await import(${JSON.stringify(worker.href)});`,
    ].join("\n"),
  ]);
  const marker = "VIDCOM_ASSET_STREAM_RESULT=";
  const line = stdout.split("\n").find((value) => value.startsWith(marker));
  expect(line, stdout).toBeDefined();
  const evidence = JSON.parse(line!.slice(marker.length)) as Evidence;
  process.stdout.write(`ASSET_STREAM_LISTENER_SAMPLE ${JSON.stringify({
    profile: evidence.profile,
    exactBytes: evidence.exactBytes,
    rssDeltaBytes: evidence.rssDeltaBytes,
    baselineRss: evidence.baselineRss,
    peakRss: evidence.peakRss,
    peakExternal: evidence.peakMemory.external,
    peakArrayBuffers: evidence.peakMemory.arrayBuffers,
  })}\n`);
  expect(evidence).toMatchObject({
    warmupStatus: 201,
    exactStatus: 201,
    oneOverStatus: 413,
    oversizedStatus: 413,
    tempAfterAbort: [],
    firstStatus: 201,
    replayStatus: 201,
    replayed: true,
    replayRevisionStable: true,
    replayWriteStable: true,
    replayJournalStable: true,
    changedStatuses: [409, 409, 409, 409, 409],
    expiredStatus: 404,
    brokenFontStatus: 201,
    brokenFontMetadata: "unknown",
    brokenFontApplyStatus: 422,
  });
  expect(evidence.rssDeltaBytes, JSON.stringify({
    baselineRss: evidence.baselineRss, baselineMemory: evidence.baselineMemory,
    peakRss: evidence.peakRss, peakMemory: evidence.peakMemory,
  })).toBeLessThan(64 * 1024 * 1024);
});
