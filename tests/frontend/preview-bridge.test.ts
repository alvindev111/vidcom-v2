// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  MAX_PREVIEW_BRIDGE_SCENES,
  acceptPreviewBridgeEvent,
  createPreviewBridgeNonce,
  parsePreviewHostMessage,
  parsePreviewParentCommand,
} from "../../src/lib/studio/preview-bridge";

const nonce = "n".repeat(43);

describe("preview postMessage protocol", () => {
  it("uses a 256-bit nonce and accepts only the exact source and origin", () => {
    const source = {};
    const other = {};
    expect(Buffer.from(createPreviewBridgeNonce((bytes) => bytes.fill(7)), "base64url")).toHaveLength(32);
    const data = { channel: "vidcom-preview", version: 2, nonce, type: "ready" };

    expect(acceptPreviewBridgeEvent(
      { source, origin: "http://preview.localhost:43123", data },
      { source, origin: "http://preview.localhost:43123", nonce },
    )).toEqual(data);
    expect(acceptPreviewBridgeEvent(
      { source: other, origin: "http://preview.localhost:43123", data },
      { source, origin: "http://preview.localhost:43123", nonce },
    )).toBeNull();
    expect(acceptPreviewBridgeEvent(
      { source, origin: "http://localhost:43123", data },
      { source, origin: "http://preview.localhost:43123", nonce },
    )).toBeNull();
    expect(acceptPreviewBridgeEvent(
      { source, origin: "http://preview.localhost:43123", data: { ...data, nonce: "x".repeat(43) } },
      { source, origin: "http://preview.localhost:43123", nonce },
    )).toBeNull();
  });

  it("rejects undeclared fields, oversized scene lists and non-finite transport state", () => {
    const base = {
      channel: "vidcom-preview",
      version: 2,
      nonce,
      type: "snapshot",
      requestId: null,
      state: {
        ready: true,
        scenes: [],
        duration: 4,
        currentTime: 1,
        paused: true,
        muted: false,
        playbackRate: 1,
        health: {
          timeline: true,
          scenesLoaded: true,
          collectorSeen: true,
          scriptErrors: 0,
          rejections: 0,
          resourceErrors: 0,
          revision: 3,
          changeSeq: 8,
        },
      },
    };
    expect(parsePreviewHostMessage(base, nonce)).not.toBeNull();
    expect(parsePreviewHostMessage({ ...base, extra: true }, nonce)).toBeNull();
    expect(parsePreviewHostMessage({
      ...base,
      state: { ...base.state, scenes: Array.from({ length: MAX_PREVIEW_BRIDGE_SCENES + 1 }, () => ({ id: "x", start: 0, duration: 1 })) },
    }, nonce)).toBeNull();
    expect(parsePreviewHostMessage({
      ...base,
      state: { ...base.state, duration: Number.POSITIVE_INFINITY },
    }, nonce)).toBeNull();
  });

  it("accepts only the closed arrange command vocabulary", () => {
    const base = { channel: "vidcom-preview", version: 2, nonce, requestId: "request-1" };
    const commands = [
      { ...base, type: "set-arrange-mode", enabled: true },
      { ...base, type: "hit-test", xRatio: 0.25, yRatio: 0.75 },
      { ...base, type: "preview-offset", sceneId: "scene-1", hfId: "hero", offsetX: 24, offsetY: -8 },
      { ...base, type: "reset-offset", sceneId: "scene-1", hfId: "hero" },
    ];
    for (const command of commands) {
      expect(parsePreviewParentCommand(command, nonce)).toEqual(command);
    }
    expect(parsePreviewParentCommand({ ...commands[1], selector: "body" }, nonce)).toBeNull();
    expect(parsePreviewParentCommand({ ...commands[2], sourceFile: "index.html" }, nonce)).toBeNull();
    expect(parsePreviewParentCommand({ ...commands[1], xRatio: Number.NaN }, nonce)).toBeNull();
    expect(parsePreviewParentCommand({ ...commands[2], offsetX: 1_000_000_000 }, nonce)).toBeNull();
  });

  it("accepts bounded arrange targets and rejects leaked or malformed descriptors", () => {
    const base = { channel: "vidcom-preview", version: 2, nonce, type: "arrange-target", requestId: "request-1" };
    const target = {
      sceneId: "scene-1",
      hfId: "hero",
      kind: "element",
      rect: { x: 10, y: 20, width: 300, height: 120 },
      canvas: { width: 1920, height: 1080 },
      editable: true,
      reason: null,
    };
    expect(parsePreviewHostMessage({ ...base, target }, nonce)).toEqual({ ...base, target });
    expect(parsePreviewHostMessage({ ...base, target: null }, nonce)).toEqual({ ...base, target: null });
    expect(parsePreviewHostMessage({ ...base, target: { ...target, selector: "#hero" } }, nonce)).toBeNull();
    expect(parsePreviewHostMessage({ ...base, target: { ...target, rect: { ...target.rect, width: Infinity } } }, nonce)).toBeNull();
    expect(parsePreviewHostMessage({ ...base, target: { ...target, canvas: { width: 1_000_000_000, height: 1080 } } }, nonce)).toBeNull();
  });

  it("accepts only closed, actionable audio states", () => {
    const base = { channel: "vidcom-preview", version: 2, nonce, type: "audio-state", requestId: "play-1" };
    expect(parsePreviewHostMessage({ ...base, state: "playing", error: null }, nonce)).toEqual({
      ...base, state: "playing", error: null,
    });
    expect(parsePreviewHostMessage({ ...base, state: "activation-required", error: "Click Enable audio" }, nonce)).not.toBeNull();
    expect(parsePreviewHostMessage({ ...base, state: "pretending", error: null }, nonce)).toBeNull();
    expect(parsePreviewHostMessage({ ...base, state: "error", error: "x".repeat(513) }, nonce)).toBeNull();
    expect(parsePreviewHostMessage({ ...base, state: "error", error: null, src: "secret.wav" }, nonce)).toBeNull();
  });
});
