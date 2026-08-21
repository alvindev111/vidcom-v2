// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import {
  confirmDiscard,
  installUnloadGuard,
  reportUnsaved,
  unsavedCount,
  unsavedMessage,
} from "@/lib/studio/unsaved-guard";

afterEach(() => {
  reportUnsaved("a", 0);
  reportUnsaved("b", 0);
});

describe("unsaved guard", () => {
  it("adds up what every owner is holding and forgets a cleared one", () => {
    reportUnsaved("a", 2);
    reportUnsaved("b", 1);
    expect(unsavedCount()).toBe(3);
    reportUnsaved("a", 0);
    expect(unsavedCount()).toBe(1);
  });

  it("asks before an exit that would lose work, and stays silent otherwise", () => {
    const asked: string[] = [];
    const ask = (message: string) => { asked.push(message); return false; };
    expect(confirmDiscard(ask)).toBe(true);
    expect(asked).toEqual([]);

    reportUnsaved("a", 1);
    expect(confirmDiscard(ask)).toBe(false);
    expect(asked).toEqual([unsavedMessage(1)]);
    expect(confirmDiscard(() => true)).toBe(true);
  });

  it("blocks the browser's own unload only while something is unsaved", () => {
    const listeners: Array<(event: { preventDefault(): void; returnValue: unknown }) => void> = [];
    const target = {
      addEventListener: (_type: string, listener: unknown) => listeners.push(listener as never),
      removeEventListener: () => listeners.splice(0),
    } as unknown as Window;
    const remove = installUnloadGuard(target);
    const fire = () => {
      const event = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true; } };
      listeners[0]!(event);
      return event;
    };
    expect(fire().prevented).toBe(false);
    reportUnsaved("a", 1);
    const blocked = fire();
    expect(blocked.prevented).toBe(true);
    expect(blocked.returnValue).toBe(unsavedMessage(1));
    remove();
    expect(listeners).toHaveLength(0);
  });
});
