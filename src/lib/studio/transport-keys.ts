/**
 * Every key the studio listens for, in one list (R8.4–8.6).
 *
 * The handler and the shortcut sheet read the same array on purpose: two lists
 * are two lists that drift, and a shortcut sheet that lies is worse than none.
 */

export type TransportAction =
  | "toggle-play"
  | "frame-back"
  | "frame-forward"
  | "second-back"
  | "second-forward"
  | "go-start"
  | "go-end"
  | "nudge-scene-back"
  | "nudge-scene-forward"
  | "clear-selection"
  | "undo"
  | "redo";

export interface KeyCombo {
  key: string;
  /** Cmd on macOS, Ctrl everywhere else. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface TransportBinding {
  action: TransportAction;
  keys: KeyCombo[];
  label: string;
}

export type Platform = "mac" | "other";

export const TRANSPORT_BINDINGS: readonly TransportBinding[] = [
  { action: "toggle-play", keys: [{ key: " " }], label: "Play or pause" },
  { action: "frame-back", keys: [{ key: "ArrowLeft" }], label: "Back one frame" },
  { action: "frame-forward", keys: [{ key: "ArrowRight" }], label: "Forward one frame" },
  { action: "second-back", keys: [{ key: "ArrowLeft", shift: true }], label: "Back one second" },
  { action: "second-forward", keys: [{ key: "ArrowRight", shift: true }], label: "Forward one second" },
  { action: "go-start", keys: [{ key: "Home" }], label: "Go to the start" },
  { action: "go-end", keys: [{ key: "End" }], label: "Go to the end" },
  { action: "nudge-scene-back", keys: [{ key: "ArrowLeft", alt: true }], label: "Move the selected scene earlier" },
  { action: "nudge-scene-forward", keys: [{ key: "ArrowRight", alt: true }], label: "Move the selected scene later" },
  { action: "clear-selection", keys: [{ key: "Escape" }], label: "Clear the selection" },
  { action: "undo", keys: [{ key: "z", mod: true }], label: "Undo" },
  { action: "redo", keys: [{ key: "z", mod: true, shift: true }], label: "Redo" },
];

const KEY_SYMBOLS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  " ": "Space",
  Escape: "Esc",
};

function detectPlatform(): Platform {
  const agent = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad/iu.test(agent) ? "mac" : "other";
}

/** True while the keystroke belongs to whatever the user is typing into. */
function typing(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element) return false;
  const tag = element.tagName?.toUpperCase();
  return element.isContentEditable === true || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function matches(combo: KeyCombo, event: KeyboardEvent, platform: Platform): boolean {
  if (combo.key.length === 1
    ? event.key.toLowerCase() !== combo.key.toLowerCase()
    : event.key !== combo.key) return false;
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  const otherMod = platform === "mac" ? event.ctrlKey : event.metaKey;
  return mod === (combo.mod === true)
    && !otherMod
    && event.shiftKey === (combo.shift === true)
    && event.altKey === (combo.alt === true);
}

/**
 * The action a keystroke means, or `null` for one the studio must not take.
 *
 * Anything typed into a field belongs to the field — except Escape, which is how
 * a person gets back out of one.
 */
export function transportActionFor(
  event: KeyboardEvent,
  target: EventTarget | null,
  platform: Platform = detectPlatform(),
): TransportAction | null {
  const found = TRANSPORT_BINDINGS.find((binding) =>
    binding.keys.some((combo) => matches(combo, event, platform)));
  if (!found) return null;
  if (typing(target) && found.action !== "clear-selection") return null;
  return found.action;
}

/** How one combination is written on this platform, for the shortcut sheet. */
export function keyComboLabel(combo: KeyCombo, platform: Platform = detectPlatform()): string {
  const key = KEY_SYMBOLS[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  const parts: string[] = [];
  if (combo.mod) parts.push(platform === "mac" ? "⌘" : "Ctrl");
  if (combo.alt) parts.push(platform === "mac" ? "⌥" : "Alt");
  if (combo.shift) parts.push(platform === "mac" ? "⇧" : "Shift");
  parts.push(key);
  return platform === "mac" ? parts.join("") : parts.join("+");
}
