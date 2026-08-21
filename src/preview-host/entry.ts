/** Trusted bridge shell for an untrusted authored preview document. */

import {
  MAX_PREVIEW_BRIDGE_SCENES,
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
  parsePreviewParentCommand,
  type PreviewArrangeTarget,
  type PreviewAudioState,
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

interface DraftOffset {
  element: HTMLElement;
  sceneId: string;
  hfId: string;
  marker: string | null;
  x: string;
  y: string;
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
  let arrangeMode = false;
  let draft: DraftOffset | null = null;
  let audioState: PreviewAudioState = "ready";
  let pendingPlay: { requestId: string | null; timer: number } | null = null;
  const enableAudio = document.createElement("button");
  enableAudio.type = "button";
  enableAudio.textContent = "Enable audio";
  enableAudio.setAttribute("aria-label", "Enable preview audio and resume playback");
  Object.assign(enableAudio.style, {
    position: "absolute", inset: "50% auto auto 50%", transform: "translate(-50%, -50%)",
    zIndex: "20", display: "none", padding: "10px 16px", borderRadius: "8px",
    border: "1px solid rgba(255,255,255,.35)", background: "rgba(0,0,0,.88)", color: "white",
    font: "600 13px system-ui", cursor: "pointer",
  });
  host.appendChild(enableAudio);

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
  const postAudio = (state: PreviewAudioState, requestId: string | null = null, error: string | null = null) => {
    audioState = state;
    enableAudio.style.display = state === "activation-required" ? "block" : "none";
    post(envelope({ type: "audio-state", requestId, state, error: error?.slice(0, 512) ?? null }));
  };
  const clearPendingPlay = () => {
    if (pendingPlay) window.clearTimeout(pendingPlay.timer);
    pendingPlay = null;
  };
  const settlePlaying = () => {
    const requestId = pendingPlay?.requestId ?? null;
    clearPendingPlay();
    postAudio("playing", requestId);
    if (requestId) ack(requestId, true);
    snapshot(requestId);
  };
  const resetDraft = () => {
    if (!draft) return;
    if (draft.marker === null) draft.element.removeAttribute("data-vidcom-layout-offset");
    else draft.element.setAttribute("data-vidcom-layout-offset", draft.marker);
    if (draft.x) draft.element.style.setProperty("--vidcom-layout-x", draft.x);
    else draft.element.style.removeProperty("--vidcom-layout-x");
    if (draft.y) draft.element.style.setProperty("--vidcom-layout-y", draft.y);
    else draft.element.style.removeProperty("--vidcom-layout-y");
    draft = null;
  };
  const compositionDocument = () => {
    try { return player.iframeElement.contentDocument; } catch { return null; }
  };
  const hitTest = (xRatio: number, yRatio: number): PreviewArrangeTarget | null => {
    const composition = compositionDocument();
    const view = composition?.defaultView;
    if (!composition || !view) return null;
    const root = composition.querySelector<HTMLElement>("[data-composition-id][data-width][data-height]");
    if (!root) return null;
    const at = composition.elementFromPoint(xRatio * view.innerWidth, yRatio * view.innerHeight) as HTMLElement | null;
    const element = at?.closest<HTMLElement>("[data-hf-id]") ?? null;
    if (!element || !root.contains(element)) return null;
    const scene = element.closest<HTMLElement>("[data-composition-id]");
    const sceneId = scene?.dataset.compositionId ?? "";
    const hfId = element.dataset.hfId ?? "";
    if (!sceneId || !hfId) return null;
    const width = Number(root.dataset.width);
    const height = Number(root.dataset.height);
    const rootRect = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || rootRect.width <= 0 || rootRect.height <= 0) return null;
    const style = view.getComputedStyle(element);
    const transform = style.transform;
    const matrix = transform.match(/^matrix\(([^)]+)\)$/u)?.[1]?.split(",").map(Number) ?? null;
    const nonAxisAligned = matrix !== null && (Math.abs(matrix[1] ?? 0) > 0.0001 || Math.abs(matrix[2] ?? 0) > 0.0001);
    const ownsOffset = element.hasAttribute("data-vidcom-layout-offset");
    const authoredTranslate = !ownsOffset && style.translate !== "none";
    const editable = !nonAxisAligned && !authoredTranslate;
    return {
      sceneId,
      hfId,
      kind: hfId === `captions-${sceneId}` || element.classList.contains("captions") ? "caption" : "element",
      rect: {
        x: (rect.x - rootRect.x) * width / rootRect.width,
        y: (rect.y - rootRect.y) * height / rootRect.height,
        width: rect.width * width / rootRect.width,
        height: rect.height * height / rootRect.height,
      },
      canvas: { width, height },
      editable,
      reason: nonAxisAligned ? "non_axis_aligned" : authoredTranslate ? "authored_translate" : null,
    };
  };
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
  const syncEvents = ["timeupdate", "ready", "ratechange", "volumechange"];
  const sync = () => snapshot();
  const scenes = () => { timeline = true; snapshot(); };
  for (const name of syncEvents) player.addEventListener(name, sync);
  player.addEventListener("scenes", scenes);
  player.addEventListener("play", settlePlaying);
  player.addEventListener("pause", () => {
    if (audioState === "activation-required" || audioState === "error") return;
    const requestId = pendingPlay?.requestId ?? null;
    clearPendingPlay();
    postAudio("paused", requestId);
    snapshot(requestId);
  });
  player.addEventListener("playbackerror", (event) => {
    const error = (event as CustomEvent<{ error?: unknown }>).detail?.error;
    const name = error instanceof Error ? error.name : "";
    const description = error instanceof Error ? error.message : "Preview media could not start";
    const requestId = pendingPlay?.requestId ?? null;
    clearPendingPlay();
    player.pause();
    const next = name === "NotAllowedError" ? "activation-required" : "error";
    postAudio(next, requestId, next === "activation-required"
      ? "Audio needs a gesture inside the preview. Click Enable audio."
      : description);
    if (requestId) ack(requestId, false, description);
    snapshot(requestId);
  });
  enableAudio.addEventListener("click", () => {
    player.muted = false;
    clearPendingPlay();
    pendingPlay = { requestId: null, timer: 0 };
    player.play();
    if (pendingPlay) {
      pendingPlay.timer = window.setTimeout(() => {
        if (!player.paused) settlePlaying();
      }, 80);
    }
  });

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
        case "play":
          clearPendingPlay();
          pendingPlay = { requestId: command.requestId, timer: 0 };
          player.play();
          if (pendingPlay) {
            pendingPlay.timer = window.setTimeout(() => {
              if (!player.paused) settlePlaying();
              else {
                clearPendingPlay();
                postAudio("paused", command.requestId, "Playback did not start");
                ack(command.requestId, false, "Playback did not start");
                snapshot(command.requestId);
              }
            }, 80);
          }
          return;
        case "pause": player.pause(); break;
        case "set-rate": player.playbackRate = command.rate; break;
        case "set-muted": player.muted = command.muted; break;
        case "set-arrange-mode":
          arrangeMode = command.enabled;
          player.pause();
          if (!arrangeMode) resetDraft();
          break;
        case "hit-test": {
          const target = arrangeMode ? hitTest(command.xRatio, command.yRatio) : null;
          post(envelope({ type: "arrange-target", requestId: command.requestId, target }));
          break;
        }
        case "preview-offset": {
          if (!arrangeMode) throw new Error("arrange mode is not active");
          const composition = compositionDocument();
          const element = composition
            ? [...composition.querySelectorAll<HTMLElement>("[data-hf-id]")]
                .find((candidate) => candidate.dataset.hfId === command.hfId
                  && candidate.closest<HTMLElement>("[data-composition-id]")?.dataset.compositionId === command.sceneId)
            : null;
          if (!element) throw new Error("arrange target is no longer available");
          if (!draft || draft.element !== element) {
            resetDraft();
            draft = {
              element,
              sceneId: command.sceneId,
              hfId: command.hfId,
              marker: element.getAttribute("data-vidcom-layout-offset"),
              x: element.style.getPropertyValue("--vidcom-layout-x"),
              y: element.style.getPropertyValue("--vidcom-layout-y"),
            };
          }
          if (draft.sceneId !== command.sceneId || draft.hfId !== command.hfId) throw new Error("arrange target mismatch");
          element.setAttribute("data-vidcom-layout-offset", "draft");
          element.style.setProperty("--vidcom-layout-x", `${command.offsetX}px`);
          element.style.setProperty("--vidcom-layout-y", `${command.offsetY}px`);
          break;
        }
        case "reset-offset":
          if (draft?.sceneId === command.sceneId && draft.hfId === command.hfId) resetDraft();
          break;
        case "dispose":
          stopHealthPoll();
          clearPendingPlay();
          resetDraft();
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
