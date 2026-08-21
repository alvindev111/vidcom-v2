import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SceneNarration } from "@/components/studio/scene-narration";
import type { Narration } from "@/lib/studio/types";

const narration: Narration = {
  sceneId: "scene-1",
  text: "Lời dẫn cũ",
  voice: "vi_female",
  status: "generated",
  audioPath: "narration/scene-1.wav",
  command: "vidcom tts",
  revision: 4,
  updatedAt: "2026-08-19T00:00:00.000Z",
  staleSince: null,
};

function markup(value: Narration): string {
  return renderToStaticMarkup(createElement(SceneNarration, {
    narration: value,
    scriptText: "Lời dẫn mới",
    pending: false,
    onRegenerate: () => undefined,
  }));
}

describe("SceneNarration stale warning", () => {
  it("warns from persisted staleSince that generated caption rhythm may be wrong", () => {
    const html = markup({ ...narration, staleSince: "2026-08-19T01:00:00.000Z" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Caption timing may no longer match the script");
    expect(html).toContain("Regenerate TTS");
  });

  it("does not warn when the persisted narration timing is current", () => {
    expect(markup(narration)).not.toContain("Caption timing may no longer match the script");
  });
});
