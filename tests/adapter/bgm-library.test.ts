import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BgmLibraryStore, synthesizeBgmBed } from "@vidcom/adapter";
import { BGM_BEDS, findBgmBed } from "@vidcom/contracts";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-bgm-"));
  roots.push(root);
  return root;
}

function wavHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    riff: String.fromCharCode(...bytes.subarray(0, 4)),
    wave: String.fromCharCode(...bytes.subarray(8, 12)),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bed synthesis", () => {
  it("renders every shipped bed as 44.1 kHz mono of the requested length", () => {
    for (const bed of BGM_BEDS) {
      const bytes = synthesizeBgmBed(bed, 12);
      const header = wavHeader(bytes);
      expect(header, bed.id).toMatchObject({
        riff: "RIFF",
        wave: "WAVE",
        channels: 1,
        sampleRate: 44_100,
        bitsPerSample: 16,
      });
      // 12s of 16-bit mono at 44.1 kHz, within one sample of rounding.
      expect(Math.abs(header.dataBytes - 12 * 44_100 * 2), bed.id).toBeLessThanOrEqual(2);
    }
  });

  it("is deterministic, so a re-render is not a new roll", () => {
    const bed = findBgmBed("cinematic")!;
    expect(Buffer.from(synthesizeBgmBed(bed, 9))).toEqual(Buffer.from(synthesizeBgmBed(bed, 9)));
  });

  it("produces audible signal rather than silence, and stays inside headroom", () => {
    const bytes = synthesizeBgmBed(findBgmBed("ambient")!, 16);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let peak = 0;
    let sumSquares = 0;
    const samples = (bytes.byteLength - 44) / 2;
    for (let index = 0; index < samples; index += 1) {
      const sample = view.getInt16(44 + index * 2, true) / 32_768;
      peak = Math.max(peak, Math.abs(sample));
      sumSquares += sample * sample;
    }
    // A silent bed is the failure this catches: the recipe is right but a filter
    // or envelope bug zeroes it, and every later check still passes.
    expect(Math.sqrt(sumSquares / samples)).toBeGreaterThan(0.01);
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThanOrEqual(0.71);
  });

  it("fades in from silence and out to it", () => {
    const bytes = synthesizeBgmBed(findBgmBed("dark")!, 20);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = (second: number) => Math.abs(view.getInt16(44 + Math.round(second * 44_100) * 2, true) / 32_768);
    expect(at(0.01)).toBeLessThan(0.02);
    expect(at(19.99)).toBeLessThan(0.02);
  });
});

describe("BgmLibraryStore", () => {
  it("starts empty, records the declared licence, and is content-addressed", async () => {
    const appDataRoot = await fixture();
    const store = new BgmLibraryStore({
      appDataRoot,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      newId: () => "bgm_fixed",
    });
    expect(await store.list()).toEqual([]);

    const bytes = synthesizeBgmBed(findBgmBed("lofi")!, 6);
    const added = await store.add({
      name: "lofi-take.wav",
      extension: "wav",
      bytes,
      source: "import",
      bedId: null,
      license: { kind: "cc-by", holder: "Somebody", url: "https://example.test/track", note: null },
    });
    if (!added.ok) throw new Error(`add failed: ${JSON.stringify(added.error)}`);
    expect(added.value.alreadyPresent).toBe(false);
    expect(added.value.entry).toMatchObject({
      id: "bgm_fixed",
      name: "lofi-take.wav",
      source: "import",
      license: { kind: "cc-by", holder: "Somebody" },
      addedAt: "2026-08-11T00:00:00.000Z",
    });
    // Read off the WAV header, not guessed from the byte count.
    expect(added.value.entry.durationSeconds).toBeCloseTo(6, 2);

    const again = await store.add({
      name: "another-name.wav",
      extension: "wav",
      bytes,
      source: "import",
      bedId: null,
      license: { kind: "unknown", holder: null, url: null, note: null },
    });
    if (!again.ok) throw new Error("second add failed");
    expect(again.value.alreadyPresent).toBe(true);
    expect(again.value.entry.id).toBe("bgm_fixed");
    expect(await store.list()).toHaveLength(1);

    expect(Buffer.from((await store.read("bgm_fixed"))!)).toEqual(Buffer.from(bytes));
    const ledger = JSON.parse(await readFile(path.join(appDataRoot, "bgm", "library.json"), "utf8"));
    expect(ledger).toMatchObject({ schemaVersion: 1, entries: [{ id: "bgm_fixed" }] });
  });

  it("refuses a format the player cannot decode", async () => {
    const store = new BgmLibraryStore({ appDataRoot: await fixture() });
    const rejected = await store.add({
      name: "cover.png",
      extension: "png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      source: "import",
      bedId: null,
      license: { kind: "own-work", holder: null, url: null, note: null },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "unsupported_media" } });
  });

  it("keeps nothing when the duration cannot be read", async () => {
    const appDataRoot = await fixture();
    const store = new BgmLibraryStore({
      appDataRoot,
      // Stands in for FFprobe failing on a corrupt file.
      probeDurationSeconds: async () => null,
    });
    const rejected = await store.add({
      name: "broken.mp3",
      extension: "mp3",
      bytes: new Uint8Array([73, 68, 51, 4]),
      source: "import",
      bedId: null,
      license: { kind: "unknown", holder: null, url: null, note: null },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "unsupported_media" } });
    expect(await store.list()).toEqual([]);
  });

  it("reads a ledger written by an earlier run", async () => {
    const appDataRoot = await fixture();
    const directory = path.join(appDataRoot, "bgm");
    await rm(directory, { recursive: true, force: true });
    const store = new BgmLibraryStore({ appDataRoot });
    const bytes = synthesizeBgmBed(findBgmBed("piano")!, 5);
    const added = await store.add({
      name: "piano.wav",
      extension: "wav",
      bytes,
      source: "synth",
      bedId: "piano",
      license: { kind: "public-domain", holder: null, url: null, note: "synthesized" },
    });
    if (!added.ok) throw new Error("add failed");
    const reopened = new BgmLibraryStore({ appDataRoot });
    expect(await reopened.list()).toEqual([added.value.entry]);
  });

  it("treats an unreadable ledger as an empty library instead of failing", async () => {
    const appDataRoot = await fixture();
    const directory = path.join(appDataRoot, "bgm");
    await writeFile(path.join(await mkdtemp(path.join(tmpdir(), "unused-")), "ignored"), "");
    await rm(directory, { recursive: true, force: true });
    const store = new BgmLibraryStore({ appDataRoot });
    await store.add({
      name: "ok.wav",
      extension: "wav",
      bytes: synthesizeBgmBed(findBgmBed("ambient")!, 5),
      source: "synth",
      bedId: "ambient",
      license: { kind: "public-domain", holder: null, url: null, note: null },
    });
    await writeFile(path.join(directory, "library.json"), "{ not json");
    expect(await new BgmLibraryStore({ appDataRoot }).list()).toEqual([]);
  });
});
