import { describe, expect, it } from "vitest";

import { createUlid } from "../../src/lib/studio/ids";
import {
  consumeStudioEvents,
  historyPath,
  latestStudioChangeSeq,
  studioEventChangeSeq,
  studioRequestInit,
} from "../../src/lib/studio/studio-session";

describe("studio session identity", () => {
  it("creates canonical Crockford ULIDs from injected clock and randomness", () => {
    expect(createUlid({ now: () => 0, randomBytes: () => new Uint8Array(10) }))
      .toBe("00000000000000000000000000");
    expect(createUlid({ now: () => 1, randomBytes: () => new Uint8Array(10) }))
      .toBe("00000000010000000000000000");
  });

  it("rejects invalid clock/random seams instead of emitting a malformed id", () => {
    expect(() => createUlid({ now: () => -1, randomBytes: () => new Uint8Array(10) })).toThrow();
    expect(() => createUlid({ now: () => 0, randomBytes: () => new Uint8Array(9) })).toThrow();
  });

  it("adds the studio header without losing existing request headers", () => {
    const init = studioRequestInit("01K1ABCDEFGHJKMNPQRSTVWXYZ", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
    });
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-vidcom-studio-session")).toBe("01K1ABCDEFGHJKMNPQRSTVWXYZ");
  });

  it("builds only encoded project-scoped history paths", () => {
    expect(historyPath("project / one", "history"))
      .toBe("/api/v1/projects/project%20%2F%20one/history");
    expect(historyPath("project / one", "session"))
      .toBe("/api/v1/projects/project%20%2F%20one/history/session");
  });

  it("decodes fragmented CRLF event frames and preserves the resume id", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 42\r"));
        controller.enqueue(encoder.encode("\nevent: file.changed\r\ndata: {\"projectId\":\"project-1\"}\r\n\r\n"));
        controller.close();
      },
    }));
    const events: Array<{ id: string | null; type: string; data: string }> = [];
    expect(await consumeStudioEvents(response, (event) => events.push(event))).toBe("42");
    expect(events).toEqual([{
      id: "42",
      type: "file.changed",
      data: '{"projectId":"project-1"}',
    }]);
  });

  it("accepts only a canonical durable SSE sequence", () => {
    const data = JSON.stringify({ projectId: "project-1" });
    expect(studioEventChangeSeq({ id: "42", type: "file.changed", data }, "project-1")).toBe(42);
    expect(studioEventChangeSeq({ id: "42", type: "file.changed", data }, "project-2")).toBeNull();
    expect(studioEventChangeSeq({ id: "-1", type: "file.changed", data }, "project-1")).toBeNull();
    expect(studioEventChangeSeq({ id: "1.5", type: "file.changed", data }, "project-1")).toBeNull();
    expect(studioEventChangeSeq({ id: "99", type: "resync", data: "{}" }, "project-1")).toBeNull();
    expect(latestStudioChangeSeq(42, { id: "41", type: "file.changed", data }, "project-1")).toBe(42);
    expect(latestStudioChangeSeq(42, { id: "43", type: "file.changed", data }, "project-1")).toBe(43);
    expect(studioEventChangeSeq({
      id: "44",
      type: "file.changed",
      data: JSON.stringify({ projectId: "project-1", payload: { path: "preview-settings.json" } }),
    }, "project-1")).toBe(44);
  });
});
