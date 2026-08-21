export const PREVIEW_BRIDGE_CHANNEL = "vidcom-preview" as const;
export const PREVIEW_BRIDGE_VERSION = 2 as const;
export const MAX_PREVIEW_BRIDGE_SCENES = 10_000;
export const MAX_PREVIEW_BRIDGE_GEOMETRY = 100_000;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;

export interface PreviewBridgeHealth {
  timeline: boolean;
  scenesLoaded: boolean;
  collectorSeen: boolean;
  scriptErrors: number;
  rejections: number;
  resourceErrors: number;
  revision: number;
  changeSeq: number;
}

export interface PreviewBridgeSnapshot {
  ready: boolean;
  scenes: Array<{ id: string; start: number; duration: number }>;
  duration: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  playbackRate: number;
  health: PreviewBridgeHealth;
}

export interface PreviewArrangeTarget {
  sceneId: string;
  hfId: string;
  kind: "element" | "caption";
  rect: { x: number; y: number; width: number; height: number };
  canvas: { width: number; height: number };
  editable: boolean;
  reason: "missing_id" | "locked" | "non_axis_aligned" | "authored_translate" | null;
}

export type PreviewAudioState = "ready" | "playing" | "paused" | "activation-required" | "error";

export type PreviewHostMessage =
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "ready" }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "snapshot"; requestId: string | null; state: PreviewBridgeSnapshot }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "arrange-target"; requestId: string; target: PreviewArrangeTarget | null }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "audio-state"; requestId: string | null; state: PreviewAudioState; error: string | null }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "ack"; requestId: string; ok: boolean; error?: string };

export type PreviewParentCommand =
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "load"; requestId: string; url: string }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "seek"; requestId: string; seconds: number }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "play" | "pause" | "dispose"; requestId: string }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "set-rate"; requestId: string; rate: number }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "set-muted"; requestId: string; muted: boolean }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "set-arrange-mode"; requestId: string; enabled: boolean }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "hit-test"; requestId: string; xRatio: number; yRatio: number }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "preview-offset"; requestId: string; sceneId: string; hfId: string; offsetX: number; offsetY: number }
  | { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: 2; nonce: string; type: "reset-offset"; requestId: string; sceneId: string; hfId: string };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function exact(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function boundedNumber(value: unknown, minimum = -MAX_PREVIEW_BRIDGE_GEOMETRY): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= minimum && value <= MAX_PREVIEW_BRIDGE_GEOMETRY;
}

function parseArrangeTarget(value: unknown): PreviewArrangeTarget | null {
  const item = record(value);
  if (!item || !exact(item, ["sceneId", "hfId", "kind", "rect", "canvas", "editable", "reason"])) return null;
  const rect = record(item.rect);
  const canvas = record(item.canvas);
  if (
    !boundedString(item.sceneId) || !boundedString(item.hfId)
    || (item.kind !== "element" && item.kind !== "caption")
    || typeof item.editable !== "boolean"
    || ![null, "missing_id", "locked", "non_axis_aligned", "authored_translate"].includes(item.reason as never)
    || !rect || !exact(rect, ["x", "y", "width", "height"])
    || !boundedNumber(rect.x) || !boundedNumber(rect.y)
    || !boundedNumber(rect.width, 0) || !boundedNumber(rect.height, 0)
    || !canvas || !exact(canvas, ["width", "height"])
    || !boundedNumber(canvas.width, Number.EPSILON) || !boundedNumber(canvas.height, Number.EPSILON)
  ) return null;
  return item as unknown as PreviewArrangeTarget;
}

function base(value: RecordValue, expectedNonce: string): boolean {
  return value.channel === PREVIEW_BRIDGE_CHANNEL
    && value.version === PREVIEW_BRIDGE_VERSION
    && value.nonce === expectedNonce
    && NONCE.test(expectedNonce);
}

function parseHealth(value: unknown): PreviewBridgeHealth | null {
  const item = record(value);
  const keys = [
    "timeline", "scenesLoaded", "collectorSeen", "scriptErrors", "rejections",
    "resourceErrors", "revision", "changeSeq",
  ];
  if (!item || !exact(item, keys)) return null;
  if (
    typeof item.timeline !== "boolean"
    || typeof item.scenesLoaded !== "boolean"
    || typeof item.collectorSeen !== "boolean"
    || !finiteNonnegative(item.scriptErrors)
    || !finiteNonnegative(item.rejections)
    || !finiteNonnegative(item.resourceErrors)
    || !finiteNonnegative(item.revision)
    || !finiteNonnegative(item.changeSeq)
  ) return null;
  return item as unknown as PreviewBridgeHealth;
}

function parseSnapshot(value: unknown): PreviewBridgeSnapshot | null {
  const item = record(value);
  const keys = ["ready", "scenes", "duration", "currentTime", "paused", "muted", "playbackRate", "health"];
  if (!item || !exact(item, keys) || !Array.isArray(item.scenes) || item.scenes.length > MAX_PREVIEW_BRIDGE_SCENES) return null;
  const scenes: PreviewBridgeSnapshot["scenes"] = [];
  for (const candidate of item.scenes) {
    const scene = record(candidate);
    if (
      !scene
      || !exact(scene, ["id", "start", "duration"])
      || typeof scene.id !== "string"
      || scene.id.length === 0
      || scene.id.length > 255
      || !finiteNonnegative(scene.start)
      || !finiteNonnegative(scene.duration)
    ) return null;
    scenes.push({ id: scene.id, start: scene.start, duration: scene.duration });
  }
  const health = parseHealth(item.health);
  if (
    !health
    || typeof item.ready !== "boolean"
    || !finiteNonnegative(item.duration)
    || !finiteNonnegative(item.currentTime)
    || typeof item.paused !== "boolean"
    || typeof item.muted !== "boolean"
    || typeof item.playbackRate !== "number"
    || !Number.isFinite(item.playbackRate)
    || item.playbackRate <= 0
  ) return null;
  return {
    ready: item.ready,
    scenes,
    duration: item.duration,
    currentTime: item.currentTime,
    paused: item.paused,
    muted: item.muted,
    playbackRate: item.playbackRate,
    health,
  };
}

export function parsePreviewHostMessage(value: unknown, expectedNonce: string): PreviewHostMessage | null {
  const message = record(value);
  if (!message || !base(message, expectedNonce) || typeof message.type !== "string") return null;
  if (message.type === "ready" && exact(message, ["channel", "version", "nonce", "type"])) {
    return message as unknown as PreviewHostMessage;
  }
  if (message.type === "snapshot" && exact(message, ["channel", "version", "nonce", "type", "requestId", "state"])) {
    const state = parseSnapshot(message.state);
    if ((message.requestId !== null && typeof message.requestId !== "string") || !state) return null;
    return { ...message, state } as PreviewHostMessage;
  }
  if (message.type === "arrange-target" && exact(message, ["channel", "version", "nonce", "type", "requestId", "target"])) {
    const target = message.target === null ? null : parseArrangeTarget(message.target);
    if (typeof message.requestId !== "string" || (message.target !== null && target === null)) return null;
    return { ...message, target } as PreviewHostMessage;
  }
  if (message.type === "audio-state" && exact(message, ["channel", "version", "nonce", "type", "requestId", "state", "error"])) {
    const states: PreviewAudioState[] = ["ready", "playing", "paused", "activation-required", "error"];
    if (
      (message.requestId !== null && typeof message.requestId !== "string")
      || !states.includes(message.state as PreviewAudioState)
      || (message.error !== null && (typeof message.error !== "string" || message.error.length > 512))
    ) return null;
    return message as unknown as PreviewHostMessage;
  }
  const ackKeys = message.error === undefined
    ? ["channel", "version", "nonce", "type", "requestId", "ok"]
    : ["channel", "version", "nonce", "type", "requestId", "ok", "error"];
  if (
    message.type === "ack"
    && exact(message, ackKeys)
    && typeof message.requestId === "string"
    && typeof message.ok === "boolean"
    && (message.error === undefined || typeof message.error === "string")
  ) return message as unknown as PreviewHostMessage;
  return null;
}

export function parsePreviewParentCommand(value: unknown, expectedNonce: string): PreviewParentCommand | null {
  const message = record(value);
  if (!message || !base(message, expectedNonce) || typeof message.type !== "string" || typeof message.requestId !== "string") return null;
  const common = ["channel", "version", "nonce", "type", "requestId"];
  if (message.type === "load" && exact(message, [...common, "url"]) && typeof message.url === "string") {
    return message as unknown as PreviewParentCommand;
  }
  if (message.type === "seek" && exact(message, [...common, "seconds"]) && finiteNonnegative(message.seconds)) {
    return message as unknown as PreviewParentCommand;
  }
  if ((message.type === "play" || message.type === "pause" || message.type === "dispose") && exact(message, common)) {
    return message as unknown as PreviewParentCommand;
  }
  if (message.type === "set-rate" && exact(message, [...common, "rate"]) && typeof message.rate === "number" && Number.isFinite(message.rate) && message.rate > 0) {
    return message as unknown as PreviewParentCommand;
  }
  if (message.type === "set-muted" && exact(message, [...common, "muted"]) && typeof message.muted === "boolean") {
    return message as unknown as PreviewParentCommand;
  }
  if (message.type === "set-arrange-mode" && exact(message, [...common, "enabled"]) && typeof message.enabled === "boolean") {
    return message as unknown as PreviewParentCommand;
  }
  if (
    message.type === "hit-test" && exact(message, [...common, "xRatio", "yRatio"])
    && boundedNumber(message.xRatio, 0) && message.xRatio <= 1
    && boundedNumber(message.yRatio, 0) && message.yRatio <= 1
  ) return message as unknown as PreviewParentCommand;
  if (
    message.type === "preview-offset"
    && exact(message, [...common, "sceneId", "hfId", "offsetX", "offsetY"])
    && boundedString(message.sceneId) && boundedString(message.hfId)
    && boundedNumber(message.offsetX) && boundedNumber(message.offsetY)
  ) return message as unknown as PreviewParentCommand;
  if (
    message.type === "reset-offset"
    && exact(message, [...common, "sceneId", "hfId"])
    && boundedString(message.sceneId) && boundedString(message.hfId)
  ) return message as unknown as PreviewParentCommand;
  return null;
}

export function acceptPreviewBridgeEvent(
  event: { source: unknown; origin: string; data: unknown },
  expected: { source: unknown; origin: string; nonce: string },
): PreviewHostMessage | null {
  if (event.source !== expected.source || event.origin !== expected.origin) return null;
  return parsePreviewHostMessage(event.data, expected.nonce);
}

export function createPreviewBridgeNonce(
  fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = fill(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
