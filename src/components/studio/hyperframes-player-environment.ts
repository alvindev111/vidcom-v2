import {
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
  acceptPreviewBridgeEvent,
  createPreviewBridgeNonce,
  type PreviewBridgeSnapshot,
  type PreviewArrangeTarget,
  type PreviewAudioState,
  type PreviewParentCommand,
} from "../../lib/studio/preview-bridge";
import {
  waitForPreflightHealth,
  type PreflightHealthSnapshot,
  type PreviewBufferEngine,
  type PreviewBufferEnvironment,
} from "./preview-buffer";

export interface HyperframesPreviewEngine extends PreviewBufferEngine {
  frame: HTMLIFrameElement;
  ready: boolean;
  scenes: Array<{ id: string; start: number; duration: number }>;
  health: PreviewBridgeSnapshot["health"];
  audioState: PreviewAudioState;
  audioError: string | null;
  setArrangeMode(enabled: boolean): void;
  hitTest(xRatio: number, yRatio: number): Promise<PreviewArrangeTarget | null>;
  previewOffset(sceneId: string, hfId: string, offsetX: number, offsetY: number): void;
  resetOffset(sceneId: string, hfId: string): void;
}

interface BridgeFrame {
  frame: HTMLIFrameElement;
  send(command: PreviewParentCommandPayload): string;
  onSnapshot(listener: (snapshot: PreviewBridgeSnapshot, requestId: string | null) => void): void;
  onError(listener: (error: string) => void): void;
  onAudioState(listener: (state: PreviewAudioState, error: string | null) => void): void;
  hitTest(xRatio: number, yRatio: number): Promise<PreviewArrangeTarget | null>;
  dispose(): void;
}

type PreviewParentCommandPayload = PreviewParentCommand extends infer Command
  ? Command extends PreviewParentCommand
    ? Omit<Command, "channel" | "version" | "nonce" | "requestId">
    : never
  : never;

const EMPTY_HEALTH: PreviewBridgeSnapshot["health"] = {
  timeline: false,
  scenesLoaded: false,
  collectorSeen: false,
  scriptErrors: 0,
  rejections: 0,
  resourceErrors: 0,
  revision: 0,
  changeSeq: 0,
};

/** Reads only the bounded bridge snapshot; the UI never enters preview DOM. */
export function readHyperframesPreflightHealth(engine: HyperframesPreviewEngine): PreflightHealthSnapshot {
  return {
    ready: engine.ready && engine.duration > 0,
    timeline: engine.health.timeline,
    scenesLoaded: engine.health.scenesLoaded,
    collectorSeen: engine.health.collectorSeen,
    scriptErrors: engine.health.scriptErrors,
    rejections: engine.health.rejections,
    resourceErrors: engine.health.resourceErrors,
    revision: engine.health.revision,
    changeSeq: engine.health.changeSeq,
  };
}

export function previewHostUrl(previewOrigin: string, nonce: string, parentOrigin: string): string {
  const url = new URL("/preview-host.html", previewOrigin);
  url.hash = new URLSearchParams({ nonce, parentOrigin }).toString();
  return url.href;
}

function createBridgeFrame(input: {
  container: HTMLDivElement;
  previewOrigin: string;
  parentOrigin: string;
}): BridgeFrame {
  const nonce = createPreviewBridgeNonce();
  const frame = document.createElement("iframe");
  frame.title = "HyperFrames preview";
  frame.style.position = "absolute";
  frame.style.inset = "0";
  frame.style.width = "100%";
  frame.style.height = "100%";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.zIndex = "0";
  frame.style.pointerEvents = "none";
  frame.referrerPolicy = "no-referrer";
  frame.allow = "autoplay";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");

  let ready = false;
  let disposed = false;
  let sequence = 0;
  let snapshotListener: (snapshot: PreviewBridgeSnapshot, requestId: string | null) => void = () => {};
  let errorListener: (error: string) => void = () => {};
  let audioListener: (state: PreviewAudioState, error: string | null) => void = () => {};
  const queue: PreviewParentCommand[] = [];
  const hitTests = new Map<string, (target: PreviewArrangeTarget | null) => void>();
  const pendingCommands = new Map<string, PreviewParentCommand["type"]>();
  const post = (command: PreviewParentCommand) => {
    if (disposed) return;
    const target = frame.contentWindow;
    if (!target || !ready) {
      queue.push(command);
      return;
    }
    target.postMessage(command, input.previewOrigin);
  };
  const onMessage = (event: MessageEvent) => {
    const message = acceptPreviewBridgeEvent(event, {
      source: frame.contentWindow,
      origin: input.previewOrigin,
      nonce,
    });
    if (!message) return;
    if (message.type === "ready") {
      ready = true;
      for (const command of queue.splice(0)) post(command);
    } else if (message.type === "snapshot") {
      snapshotListener(message.state, message.requestId);
    } else if (message.type === "arrange-target") {
      hitTests.get(message.requestId)?.(message.target);
      hitTests.delete(message.requestId);
    } else if (message.type === "audio-state") {
      audioListener(message.state, message.error);
    } else if (!message.ok) {
      const type = pendingCommands.get(message.requestId);
      if (type !== "play") errorListener(message.error ?? "preview command failed");
    }
    if ("requestId" in message && typeof message.requestId === "string" && message.type !== "snapshot") {
      pendingCommands.delete(message.requestId);
    }
  };
  window.addEventListener("message", onMessage);
  input.container.appendChild(frame);
  frame.src = previewHostUrl(input.previewOrigin, nonce, input.parentOrigin);

  return {
    frame,
    send(command) {
      const requestId = `preview-${++sequence}`;
      post({
        channel: PREVIEW_BRIDGE_CHANNEL,
        version: PREVIEW_BRIDGE_VERSION,
        nonce,
        requestId,
        ...command,
      } as PreviewParentCommand);
      pendingCommands.set(requestId, command.type);
      return requestId;
    },
    onSnapshot(listener) { snapshotListener = listener; },
    onError(listener) { errorListener = listener; },
    onAudioState(listener) { audioListener = listener; },
    hitTest(xRatio, yRatio) {
      const requestId = this.send({ type: "hit-test", xRatio, yRatio });
      return new Promise((resolve) => hitTests.set(requestId, resolve));
    },
    dispose() {
      if (disposed) return;
      if (ready && frame.contentWindow) {
        frame.contentWindow.postMessage({
          channel: PREVIEW_BRIDGE_CHANNEL,
          version: PREVIEW_BRIDGE_VERSION,
          nonce,
          requestId: `preview-${++sequence}`,
          type: "dispose",
        } satisfies PreviewParentCommand, input.previewOrigin);
      }
      disposed = true;
      queue.length = 0;
      for (const resolve of hitTests.values()) resolve(null);
      hitTests.clear();
      pendingCommands.clear();
      window.removeEventListener("message", onMessage);
      try { frame.remove(); } catch { /* frame already detached */ }
    },
  };
}

export function createHyperframesPlayerEnvironment(input: {
  container: HTMLDivElement;
  previewOrigin: string;
  onVisibleState: (engine: HyperframesPreviewEngine, error: string | null) => void;
}): PreviewBufferEnvironment<HyperframesPreviewEngine> {
  const bridges = new WeakMap<HyperframesPreviewEngine, BridgeFrame>();
  let visible: HyperframesPreviewEngine | null = null;
  let spare: BridgeFrame | null = null;
  const parentOrigin = window.location.origin;

  const notify = (engine: HyperframesPreviewEngine, error: string | null = null) => {
    if (visible === engine) input.onVisibleState(engine, error);
  };
  const freshBridge = () => createBridgeFrame({
    container: input.container,
    previewOrigin: input.previewOrigin,
    parentOrigin,
  });

  return {
    createCandidate({ url }) {
      const bridge = spare ?? freshBridge();
      spare = null;
      const state: PreviewBridgeSnapshot = {
        ready: false,
        scenes: [],
        duration: 0,
        currentTime: 0,
        paused: true,
        muted: false,
        playbackRate: 1,
        health: { ...EMPTY_HEALTH },
      };
      let pendingTransportRequest: string | null = null;
      const engine: HyperframesPreviewEngine = {
        frame: bridge.frame,
        ready: false,
        scenes: [],
        health: { ...EMPTY_HEALTH },
        audioState: "ready",
        audioError: null,
        get currentTime() { return state.currentTime; },
        get duration() { return state.duration; },
        get paused() { return state.paused; },
        get playbackRate() { return state.playbackRate; },
        set playbackRate(value: number) {
          state.playbackRate = value;
          pendingTransportRequest = bridge.send({ type: "set-rate", rate: value });
        },
        get muted() { return state.muted; },
        set muted(value: boolean) {
          state.muted = value;
          pendingTransportRequest = bridge.send({ type: "set-muted", muted: value });
        },
        seek(seconds: number) {
          state.currentTime = seconds;
          pendingTransportRequest = bridge.send({ type: "seek", seconds });
        },
        play() {
          state.paused = false;
          pendingTransportRequest = bridge.send({ type: "play" });
        },
        pause() {
          state.paused = true;
          pendingTransportRequest = bridge.send({ type: "pause" });
        },
        setArrangeMode(enabled) {
          if (enabled) state.paused = true;
          bridge.send({ type: "set-arrange-mode", enabled });
        },
        hitTest(xRatio, yRatio) {
          return bridge.hitTest(xRatio, yRatio);
        },
        previewOffset(sceneId, hfId, offsetX, offsetY) {
          bridge.send({ type: "preview-offset", sceneId, hfId, offsetX, offsetY });
        },
        resetOffset(sceneId, hfId) {
          bridge.send({ type: "reset-offset", sceneId, hfId });
        },
      };
      bridge.onSnapshot((snapshot, requestId) => {
        const transportAcknowledged = pendingTransportRequest === null || requestId === pendingTransportRequest;
        state.ready = snapshot.ready;
        state.scenes = snapshot.scenes;
        state.duration = snapshot.duration;
        state.health = snapshot.health;
        if (transportAcknowledged) {
          state.currentTime = snapshot.currentTime;
          state.paused = snapshot.paused;
          state.muted = snapshot.muted;
          state.playbackRate = snapshot.playbackRate;
          if (requestId === pendingTransportRequest) pendingTransportRequest = null;
        }
        engine.ready = snapshot.ready;
        engine.scenes = snapshot.scenes;
        engine.health = snapshot.health;
        notify(engine);
      });
      bridge.onError((error) => notify(engine, error));
      bridge.onAudioState((audioState, audioError) => {
        engine.audioState = audioState;
        engine.audioError = audioError;
        if (audioState === "activation-required" || audioState === "error") state.paused = true;
        notify(engine);
      });
      bridges.set(engine, bridge);
      bridge.send({ type: "load", url: new URL(url, window.location.href).href });

      if (!spare) spare = freshBridge();
      return engine;
    },
    waitForHealth(engine, signal) {
      return waitForPreflightHealth(() => readHyperframesPreflightHealth(engine), { signal });
    },
    show(engine) {
      visible = engine;
      engine.frame.style.opacity = "1";
      engine.frame.style.zIndex = "1";
      engine.frame.style.pointerEvents = "auto";
      notify(engine);
    },
    dispose(engine) {
      const bridge = bridges.get(engine);
      if (bridge === spare) spare = null;
      bridge?.dispose();
      bridges.delete(engine);
      if (visible === engine) visible = null;
    },
  };
}
