/** Trusted bridge shell for an untrusted authored preview document. */

import {
  MAX_PREVIEW_BRIDGE_SCENES,
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
  parsePreviewParentCommand,
  type PreviewBridgeHealth,
  type PreviewHostMessage,
} from "../lib/studio/preview-bridge";

interface CollectorValue {
  scriptErrors?: number;
  rejections?: number;
  resourceErrors?: number;
}

interface PreviewWindow extends Window {
  __vidcomHealth?: CollectorValue;
}

interface HyperframesPlayerElement extends HTMLElement {
  ready: boolean;
  iframeElement: HTMLIFrameElement;
  scenes: Array<{ id: string; start: number; duration: number }>;
  currentTime: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  playbackRate: number;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
}

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function identity(script: HTMLScriptElement | null, name: "projectRevision" | "changeSeq"): number {
  const value = Number(script?.dataset[name] ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function bridgeConfig(): { nonce: string; parentOrigin: string } | null {
  const values = new URLSearchParams(window.location.hash.slice(1));
  const nonce = values.get("nonce") ?? "";
  const rawParent = values.get("parentOrigin") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) return null;
  try {
    const parent = new URL(rawParent);
    const own = new URL(window.location.href);
    if (
      parent.origin !== rawParent
      || !["127.0.0.1", "localhost"].includes(parent.hostname)
      || parent.port !== own.port
      || parent.protocol !== own.protocol
    ) return null;
    return { nonce, parentOrigin: parent.origin };
  } catch {
    return null;
  }
}

function readHealth(player: HyperframesPlayerElement, timeline: boolean): PreviewBridgeHealth {
  let composition: Document | null = null;
  let collector: CollectorValue | undefined;
  try {
    composition = player.iframeElement.contentDocument;
    collector = (player.iframeElement.contentWindow as PreviewWindow | null)?.__vidcomHealth;
  } catch {
    composition = null;
  }
  const script = composition?.querySelector<HTMLScriptElement>('script[data-vidcom-health="collector"]') ?? null;
  const nested = composition ? [...composition.querySelectorAll<HTMLElement>("[data-composition-src]")] : [];
  return {
    timeline,
    scenesLoaded: composition !== null && nested.every((layer) => layer.children.length > 0),
    collectorSeen: collector !== undefined && script !== null,
    scriptErrors: finiteCounter(collector?.scriptErrors),
    rejections: finiteCounter(collector?.rejections),
    resourceErrors: finiteCounter(collector?.resourceErrors),
    revision: identity(script, "projectRevision"),
    changeSeq: identity(script, "changeSeq"),
  };
}

async function boot(): Promise<void> {
  const config = bridgeConfig();
  const host = document.querySelector<HTMLElement>("[data-preview-host]");
  if (!config || !host || window.parent === window) return;
  await import("@hyperframes/player");
  const player = document.createElement("hyperframes-player") as HyperframesPlayerElement;
  player.style.position = "absolute";
  player.style.inset = "0";
  host.appendChild(player);
  let timeline = false;
  let healthPoll: number | null = null;

  const post = (message: PreviewHostMessage) => window.parent.postMessage(message, config.parentOrigin);
  const envelope = (message: Record<string, unknown>) => ({
    channel: PREVIEW_BRIDGE_CHANNEL,
    version: PREVIEW_BRIDGE_VERSION,
    nonce: config.nonce,
    ...message,
  }) as PreviewHostMessage;
  const snapshot = (requestId: string | null = null) => post(envelope({
    type: "snapshot",
    requestId,
    state: {
      ready: Boolean(player.ready),
      scenes: (player.scenes ?? []).slice(0, MAX_PREVIEW_BRIDGE_SCENES).map(({ id, start, duration }) => ({ id, start, duration })),
      duration: finiteCounter(player.duration),
      currentTime: finiteCounter(player.currentTime),
      paused: Boolean(player.paused),
      muted: Boolean(player.muted),
      playbackRate: typeof player.playbackRate === "number" && Number.isFinite(player.playbackRate) && player.playbackRate > 0
        ? player.playbackRate
        : 1,
      health: readHealth(player, timeline),
    },
  }));
  const ack = (requestId: string, ok: boolean, error?: string) => post(envelope({
    type: "ack",
    requestId,
    ok,
    ...(error === undefined ? {} : { error: error.slice(0, 512) }),
  }));
  const stopHealthPoll = () => {
    if (healthPoll !== null) window.clearInterval(healthPoll);
    healthPoll = null;
  };
  const startHealthPoll = () => {
    stopHealthPoll();
    healthPoll = window.setInterval(() => {
      if ((player.scenes?.length ?? 0) > 0) timeline = true;
      snapshot();
      const health = readHealth(player, timeline);
      if (player.ready && timeline && health.collectorSeen && health.scenesLoaded) stopHealthPoll();
    }, 50);
  };
  const syncEvents = ["timeupdate", "ready", "play", "pause", "ratechange", "volumechange"];
  const sync = () => snapshot();
  const scenes = () => { timeline = true; snapshot(); };
  for (const name of syncEvents) player.addEventListener(name, sync);
  player.addEventListener("scenes", scenes);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== config.parentOrigin) return;
    const command = parsePreviewParentCommand(event.data, config.nonce);
    if (!command) return;
    try {
      switch (command.type) {
        case "load": {
          const url = new URL(command.url);
          if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/preview/")) {
            throw new Error("preview source is not allowed");
          }
          timeline = false;
          player.setAttribute("src", url.href);
          startHealthPoll();
          break;
        }
        case "seek": player.seek(command.seconds); break;
        case "play": player.play(); break;
        case "pause": player.pause(); break;
        case "set-rate": player.playbackRate = command.rate; break;
        case "set-muted": player.muted = command.muted; break;
        case "dispose":
          stopHealthPoll();
          player.pause();
          player.remove();
          break;
      }
      ack(command.requestId, true);
      if (command.type !== "dispose") snapshot(command.requestId);
    } catch (error) {
      ack(command.requestId, false, error instanceof Error ? error.message : "preview command failed");
    }
  });

  post(envelope({ type: "ready" }));
}

void boot();
