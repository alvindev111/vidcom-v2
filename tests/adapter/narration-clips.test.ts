import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildBgmHtml, buildNarrationHtml, readNarrationClips } from "@vidcom/adapter";
import { DEFAULT_PREVIEW_SETTINGS, type ProjectRef } from "@vidcom/core";

const roots: string[] = [];

/**
 * A root document with two scenes at different start times, which is where the
 * narration schedule has to come from (P1: `data-*` is the truth).
 */
const ROOT_HTML = `<!doctype html><html><body>
<div data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="12">
  <div class="clip" data-composition-id="intro" data-composition-src="compositions/intro.html" data-start="0" data-duration="5"></div>
  <div class="clip" data-composition-id="outro" data-composition-src="compositions/outro.html" data-start="5" data-duration="7"></div>
</div>
</body></html>`;

async function project(): Promise<ProjectRef> {
  const root = await mkdtemp(join(tmpdir(), "vidcom-narration-"));
  roots.push(root);
  await mkdir(join(root, "narration"), { recursive: true });
  return { id: "demo", slug: "demo", root, entry: "index.html" } as ProjectRef;
}

async function sidecar(
  ref: ProjectRef,
  sceneId: string,
  overrides: Record<string, unknown> = {},
  options: { withAudio?: boolean } = {},
): Promise<void> {
  await writeFile(join(ref.root, "narration", `${sceneId}.json`), JSON.stringify({
    sceneId,
    text: "Xin chào",
    voice: "vieneu-v3-pham-tuyen",
    status: "generated",
    audioPath: `narration/${sceneId}.wav`,
    command: "",
    revision: 1,
    updatedAt: "2026-08-03T00:00:00.000Z",
    staleSince: null,
    provider: "vieneu",
    durationSeconds: 4.5,
    ...overrides,
  }));
  if (options.withAudio !== false) {
    await writeFile(join(ref.root, "narration", `${sceneId}.wav`), Buffer.alloc(2_048, 3));
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readNarrationClips", () => {
  it("mounts every generated cue at scene start plus its own offset", async () => {
    const ref = await project();
    await mkdir(join(ref.root, "narration", "intro"), { recursive: true });
    await Promise.all([
      writeFile(join(ref.root, "narration", "intro", "line-1.wav"), Buffer.alloc(2_048, 1)),
      writeFile(join(ref.root, "narration", "intro", "line-2.wav"), Buffer.alloc(2_048, 2)),
      writeFile(join(ref.root, "narration", "intro.json"), JSON.stringify({
        schemaVersion: 2,
        sceneId: "intro",
        revision: 2,
        updatedAt: "2026-08-04T00:00:00.000Z",
        cues: [
          { cueId: "line-1", text: "Một", voice: "a", offsetSeconds: 0, durationSeconds: 1,
            staleSince: null, status: "generated", audioPath: "narration/intro/line-1.wav" },
          { cueId: "line-2", text: "Hai", voice: "b", offsetSeconds: 1.5, durationSeconds: 2,
            staleSince: null, status: "generated", audioPath: "narration/intro/line-2.wav" },
        ],
      })),
    ]);
    const clips = readNarrationClips(ref, ROOT_HTML);
    expect(clips).toEqual([
      { sceneId: "intro", cueId: "line-1", path: "narration/intro/line-1.wav", startSeconds: 0, durationSeconds: 1 },
      { sceneId: "intro", cueId: "line-2", path: "narration/intro/line-2.wav", startSeconds: 1.5, durationSeconds: 2 },
    ]);
    const html = buildNarrationHtml(clips, "/files/");
    expect(html.match(/<audio /g)).toHaveLength(2);
    expect(html).toContain('data-start="0"');
    expect(html).toContain('data-start="1.5"');
  });

  it("reads multiple v2 cues as separate audio clips at document-relative offsets", async () => {
    const ref = await project();
    await mkdir(join(ref.root, "narration", "intro"), { recursive: true });
    await writeFile(join(ref.root, "narration", "intro.json"), JSON.stringify({
      schemaVersion: 2,
      sceneId: "intro",
      revision: 2,
      updatedAt: "2026-08-04T00:00:00.000Z",
      cues: [
        { cueId: "line-1", text: "Một", voice: "a", status: "generated", audioPath: "narration/intro/line-1.wav", offsetSeconds: 0, durationSeconds: 1, staleSince: null },
        { cueId: "line-2", text: "Hai", voice: "b", status: "generated", audioPath: "narration/intro/line-2.wav", offsetSeconds: 1.5, durationSeconds: 2, staleSince: null },
      ],
    }));
    await Promise.all([
      writeFile(join(ref.root, "narration", "intro", "line-1.wav"), Buffer.alloc(16, 1)),
      writeFile(join(ref.root, "narration", "intro", "line-2.wav"), Buffer.alloc(16, 2)),
    ]);

    const clips = readNarrationClips(ref, ROOT_HTML);
    expect(clips).toEqual([
      { sceneId: "intro", cueId: "line-1", path: "narration/intro/line-1.wav", startSeconds: 0, durationSeconds: 1 },
      { sceneId: "intro", cueId: "line-2", path: "narration/intro/line-2.wav", startSeconds: 1.5, durationSeconds: 2 },
    ]);
    const html = buildNarrationHtml(clips, "/files/");
    expect(html.match(/class="clip hf-narration"/g)).toHaveLength(2);
    expect(html).toContain('data-start="1.5"');
  });

  it("places each scene's audio at the start time the document declares", async () => {
    const ref = await project();
    await sidecar(ref, "intro");
    await sidecar(ref, "outro");

    const clips = readNarrationClips(ref, ROOT_HTML);

    // Start comes from the document, not the sidecar: only one of the two moves
    // when an author drags a scene on the timeline.
    expect(clips).toEqual([
      { sceneId: "intro", path: "narration/intro.wav", startSeconds: 0, durationSeconds: 4.5 },
      { sceneId: "outro", path: "narration/outro.wav", startSeconds: 5, durationSeconds: 4.5 },
    ]);
  });

  it("skips a scene whose audio was never generated", async () => {
    const ref = await project();
    await sidecar(ref, "intro");
    await sidecar(ref, "outro", {}, { withAudio: false });

    // A silent scene is the right outcome for narration that does not exist yet.
    expect(readNarrationClips(ref, ROOT_HTML).map((clip) => clip.sceneId)).toEqual(["intro"]);
  });

  it("skips a scene with no sidecar at all", async () => {
    const ref = await project();
    await sidecar(ref, "outro");

    expect(readNarrationClips(ref, ROOT_HTML).map((clip) => clip.sceneId)).toEqual(["outro"]);
  });

  it("ignores a sidecar that will not parse rather than failing the whole document", async () => {
    const ref = await project();
    await writeFile(join(ref.root, "narration", "intro.json"), "{ broken");
    await sidecar(ref, "outro");

    expect(readNarrationClips(ref, ROOT_HTML).map((clip) => clip.sceneId)).toEqual(["outro"]);
  });

  it("refuses a sidecar pointing somewhere other than its own scene's audio", async () => {
    const ref = await project();
    await sidecar(ref, "intro", { audioPath: "../outside.wav" });

    expect(readNarrationClips(ref, ROOT_HTML)).toEqual([]);
  });

  it("omits a duration the sidecar does not report", async () => {
    const ref = await project();
    await sidecar(ref, "intro", { durationSeconds: undefined });

    expect(readNarrationClips(ref, ROOT_HTML)[0]?.durationSeconds).toBe(null);
  });
});

describe("buildNarrationHtml", () => {
  it("emits runtime-schedulable clips through the same mechanism as the BGM bed", () => {
    const html = buildNarrationHtml([
      { sceneId: "intro", path: "narration/intro.wav", startSeconds: 0, durationSeconds: 4.5 },
    ], "/api/hf/demo/files/");

    // `clip` plus data-start is what the runtime schedules, so preview and
    // render pick narration up through one code path (P3).
    expect(html).toContain('class="clip hf-narration"');
    expect(html).toContain('src="/api/hf/demo/files/narration/intro.wav"');
    expect(html).toContain('data-start="0"');
    expect(html).toContain('data-duration="4.5"');
    expect(html).toContain('preload="none"');
  });

  it("leaves the duration off when it is unknown", () => {
    const html = buildNarrationHtml([
      { sceneId: "intro", path: "narration/intro.wav", startSeconds: 2, durationSeconds: null },
    ], "/files/");

    expect(html).not.toContain("data-duration");
  });

  it("escapes a scene id so it cannot break out of the attribute", () => {
    const html = buildNarrationHtml([
      { sceneId: 'a"><script>x</script>', path: "narration/a.wav", startSeconds: 0, durationSeconds: null },
    ], "/files/");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
  });

  it("produces nothing when no scene has narration", () => {
    expect(buildNarrationHtml([], "/files/")).toBe("");
  });

  it("does not preload the whole music bed while preview health is still settling", () => {
    const html = buildBgmHtml({
      ...DEFAULT_PREVIEW_SETTINGS,
      bgm: {
        enabled: true,
        volume: 0.25,
        loop: true,
        track: { name: "cinematic.wav", path: "preview-assets/bgm/cinematic.wav" },
      },
    }, "/files/");

    expect(html).toContain('preload="none"');
    expect(html).toContain('src="/files/preview-assets/bgm/cinematic.wav"');
  });
});
