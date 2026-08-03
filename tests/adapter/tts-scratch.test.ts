import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scavengeTtsScratch, withTtsScratch } from "@vidcom/adapter";

const roots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vidcom-scavenge-"));
  roots.push(root);
  return root;
}

/** Stands in for a directory a killed daemon left behind. */
async function orphan(root: string, name: string, ageMs: number): Promise<string> {
  const pathname = join(root, name);
  await mkdir(pathname, { recursive: true });
  await writeFile(join(pathname, "vieneu-request.json"), '{"cues":[{"text":"narration the user wrote"}]}');
  const when = new Date(Date.now() - ageMs);
  await utimes(pathname, when, when);
  return pathname;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("withTtsScratch", () => {
  it("removes its directory whether the work succeeded or threw", async () => {
    const root = await scratchRoot();

    await withTtsScratch(root, async () => undefined);
    await withTtsScratch(root, async () => { throw new Error("boom"); }).catch(() => {});

    expect(await readdir(root)).toEqual([]);
  });
});

describe("scavengeTtsScratch", () => {
  it("removes leftovers from a run that never got to clean up", async () => {
    const root = await scratchRoot();
    await orphan(root, "tts-crashed", 2 * 60 * 60 * 1_000);

    // A kill or a power cut skips the `finally` in withTtsScratch, and what
    // survives is the narration text plus the raw audio of it.
    const removed = await scavengeTtsScratch(root, new Date(Date.now() - 60 * 60 * 1_000));

    expect(removed).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves a recent directory alone, in case another daemon owns it", async () => {
    const root = await scratchRoot();
    await orphan(root, "tts-running", 5 * 60 * 1_000);

    const removed = await scavengeTtsScratch(root, new Date(Date.now() - 60 * 60 * 1_000));

    expect(removed).toBe(0);
    expect(await readdir(root)).toEqual(["tts-running"]);
  });

  it("ignores directories that are not its own", async () => {
    const root = await scratchRoot();
    await orphan(root, "renders", 2 * 60 * 60 * 1_000);

    const removed = await scavengeTtsScratch(root, new Date(Date.now() - 60 * 60 * 1_000));

    expect(removed).toBe(0);
    expect(await readdir(root)).toEqual(["renders"]);
  });

  it("treats a missing scratch root as nothing to do", async () => {
    const root = await scratchRoot();

    await expect(scavengeTtsScratch(join(root, "never-created"), new Date())).resolves.toBe(0);
  });
});
