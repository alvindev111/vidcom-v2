// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  MAX_PREVIEW_BRIDGE_SCENES,
  acceptPreviewBridgeEvent,
  createPreviewBridgeNonce,
  parsePreviewHostMessage,
} from "../../src/lib/studio/preview-bridge";

const nonce = "n".repeat(43);

describe("preview postMessage protocol", () => {
  it("uses a 256-bit nonce and accepts only the exact source and origin", () => {
    const source = {};
    const other = {};
    expect(Buffer.from(createPreviewBridgeNonce((bytes) => bytes.fill(7)), "base64url")).toHaveLength(32);
    const data = { channel: "vidcom-preview", version: 1, nonce, type: "ready" };

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
      version: 1,
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
});
