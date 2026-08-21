// @vitest-environment node

import { describe, expect, it } from "vitest";

import { formatTimecode } from "@/lib/studio/format";
import {
  TRANSPORT_BINDINGS,
  keyComboLabel,
  transportActionFor,
} from "@/lib/studio/transport-keys";

/** The shape the handler reads; a real KeyboardEvent carries more, and none of it matters. */
function keyEvent(key: string, modifiers: Partial<Record<"altKey" | "shiftKey" | "metaKey" | "ctrlKey", boolean>> = {}) {
  return {
    key,
    altKey: false, shiftKey: false, metaKey: false, ctrlKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

const outside = { tagName: "DIV", isContentEditable: false } as unknown as EventTarget;
const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
const textarea = { tagName: "TEXTAREA", isContentEditable: false } as unknown as EventTarget;
const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;

describe("formatTimecode", () => {
  it("counts frames within the second, not hundredths", () => {
    // 13/30 of a second is frame 13, which as a fraction is 0.433…
    expect(formatTimecode(7 + 13 / 30, 30)).toBe("0:07.13");
    expect(formatTimecode(0, 30)).toBe("0:00.00");
    expect(formatTimecode(65.5, 30)).toBe("1:05.15");
  });

  it("distinguishes two neighbouring frames", () => {
    expect(formatTimecode(2 + 5 / 24, 24)).toBe("0:02.05");
    expect(formatTimecode(2 + 6 / 24, 24)).toBe("0:02.06");
    expect(formatTimecode(2 + 5 / 24, 24)).not.toBe(formatTimecode(2 + 6 / 24, 24));
  });

  it("pads the frame by how many digits the rate needs, and never goes negative", () => {
    expect(formatTimecode(1.5, 120)).toBe("0:01.060");
    expect(formatTimecode(-4, 30)).toBe("0:00.00");
    // Without a frame rate it is the plain clock the ruler has always shown.
    expect(formatTimecode(65.5)).toBe("1:05");
  });
});

describe("transport bindings", () => {
  it("is the one list behind both the handler and the shortcut table", () => {
    const actions = TRANSPORT_BINDINGS.map((binding) => binding.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(new Set(actions)).toEqual(new Set([
      "toggle-play", "frame-back", "frame-forward", "second-back", "second-forward",
      "go-start", "go-end", "nudge-scene-back", "nudge-scene-forward", "clear-selection",
      "undo", "redo",
    ]));
    for (const binding of TRANSPORT_BINDINGS) {
      expect(binding.label.length).toBeGreaterThan(0);
      expect(binding.keys.length).toBeGreaterThan(0);
    }
  });

  it("maps each combination to exactly the action the design fixes", () => {
    expect(transportActionFor(keyEvent(" "), outside)).toBe("toggle-play");
    expect(transportActionFor(keyEvent("ArrowLeft"), outside)).toBe("frame-back");
    expect(transportActionFor(keyEvent("ArrowRight"), outside)).toBe("frame-forward");
    expect(transportActionFor(keyEvent("ArrowLeft", { shiftKey: true }), outside)).toBe("second-back");
    expect(transportActionFor(keyEvent("ArrowRight", { shiftKey: true }), outside)).toBe("second-forward");
    expect(transportActionFor(keyEvent("Home"), outside)).toBe("go-start");
    expect(transportActionFor(keyEvent("End"), outside)).toBe("go-end");
    expect(transportActionFor(keyEvent("ArrowLeft", { altKey: true }), outside)).toBe("nudge-scene-back");
    expect(transportActionFor(keyEvent("ArrowRight", { altKey: true }), outside)).toBe("nudge-scene-forward");
    expect(transportActionFor(keyEvent("Escape"), outside)).toBe("clear-selection");
  });

  it("accepts the platform's own undo modifier and neither the other one nor a bare key", () => {
    expect(transportActionFor(keyEvent("z", { metaKey: true }), outside, "mac")).toBe("undo");
    expect(transportActionFor(keyEvent("z", { metaKey: true, shiftKey: true }), outside, "mac")).toBe("redo");
    expect(transportActionFor(keyEvent("z", { ctrlKey: true }), outside, "other")).toBe("undo");
    expect(transportActionFor(keyEvent("z", { ctrlKey: true, shiftKey: true }), outside, "other")).toBe("redo");
    // Ctrl+Z on macOS is not the platform's undo, and a bare z is typing.
    expect(transportActionFor(keyEvent("z", { ctrlKey: true }), outside, "mac")).toBeNull();
    expect(transportActionFor(keyEvent("z", { metaKey: true }), outside, "other")).toBeNull();
    expect(transportActionFor(keyEvent("z"), outside)).toBeNull();
  });

  it("never takes a key away from something the user is typing into", () => {
    for (const target of [input, textarea, editable]) {
      expect(transportActionFor(keyEvent(" "), target)).toBeNull();
      expect(transportActionFor(keyEvent("ArrowLeft"), target)).toBeNull();
      expect(transportActionFor(keyEvent("z", { metaKey: true }), target, "mac")).toBeNull();
    }
    // Escape is the way out of a field, so it is the one key that still counts.
    expect(transportActionFor(keyEvent("Escape"), input)).toBe("clear-selection");
  });

  it("labels the modifier the way the platform writes it", () => {
    expect(keyComboLabel({ key: "z", mod: true }, "mac")).toBe("⌘Z");
    expect(keyComboLabel({ key: "z", mod: true }, "other")).toBe("Ctrl+Z");
    expect(keyComboLabel({ key: "z", mod: true, shift: true }, "other")).toBe("Ctrl+Shift+Z");
    expect(keyComboLabel({ key: "ArrowLeft", alt: true }, "mac")).toBe("⌥←");
  });
});
