import {
  waitForPreflightHealth,
  type PreflightHealthSnapshot,
  type PreviewBufferEngine,
  type PreviewBufferEnvironment,
} from "./preview-buffer";

interface CollectorValue {
  scriptErrors?: number;
  rejections?: number;
  resourceErrors?: number;
}

interface PreviewWindow extends Window {
  __vidcomHealth?: CollectorValue;
}

export interface HyperframesPlayerElement extends HTMLElement, PreviewBufferEngine {
  ready: boolean;
  iframeElement: HTMLIFrameElement;
  scenes: Array<{ id: string; start: number; duration: number }>;
}

interface EngineMetadata {
  timeline: boolean;
  cleanup: () => void;
}

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function identity(script: HTMLScriptElement | null, name: "projectRevision" | "changeSeq"): number {
  const value = Number(script?.dataset[name] ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Reads the daemon-owned collector and structural state from the same-origin iframe. */
export function readHyperframesPreflightHealth(
  engine: HyperframesPlayerElement,
  timeline: boolean,
): PreflightHealthSnapshot {
  let document: Document | null = null;
  let collector: CollectorValue | undefined;
  try {
    document = engine.iframeElement.contentDocument;
    collector = (engine.iframeElement.contentWindow as PreviewWindow | null)?.__vidcomHealth;
  } catch {
    document = null;
  }
  const script = document?.querySelector<HTMLScriptElement>('script[data-vidcom-health="collector"]') ?? null;
  const nested = document ? [...document.querySelectorAll<HTMLElement>("[data-composition-src]")] : [];
  return {
    ready: engine.ready && engine.duration > 0,
    timeline,
    scenesLoaded: document !== null && nested.every((layer) => layer.children.length > 0),
    collectorSeen: collector !== undefined && script !== null,
    scriptErrors: finiteCounter(collector?.scriptErrors),
    rejections: finiteCounter(collector?.rejections),
    resourceErrors: finiteCounter(collector?.resourceErrors),
    revision: identity(script, "projectRevision"),
    changeSeq: identity(script, "changeSeq"),
  };
}

/** Same-origin bridge from the replaceable custom elements to the pure buffer coordinator. */
export function createHyperframesPlayerEnvironment(input: {
  container: HTMLDivElement;
  onVisibleState: (engine: HyperframesPlayerElement, error: string | null) => void;
}): PreviewBufferEnvironment<HyperframesPlayerElement> {
  const metadata = new WeakMap<HyperframesPlayerElement, EngineMetadata>();
  let visible: HyperframesPlayerElement | null = null;

  const notify = (engine: HyperframesPlayerElement, error: string | null = null) => {
    if (visible === engine) input.onVisibleState(engine, error);
  };

  return {
    createCandidate({ url }) {
      const engine = document.createElement("hyperframes-player") as HyperframesPlayerElement;
      const state = { timeline: false, cleanup: () => {} };
      const sync = () => notify(engine);
      const onReady = () => sync();
      const onScenes = () => {
        state.timeline = true;
        sync();
      };
      const onError = (event: Event) => notify(
        engine,
        (event as CustomEvent<{ message?: string }>).detail?.message ?? event.type,
      );
      const listeners: Array<[string, EventListener]> = [
        ["timeupdate", sync],
        ["ready", onReady],
        ["scenes", onScenes],
        ["play", sync],
        ["pause", sync],
        ["ratechange", sync],
        ["volumechange", sync],
        ["error", onError],
        ["playbackerror", onError],
        ["runtimeprotocolerror", onError],
      ];
      for (const [name, listener] of listeners) engine.addEventListener(name, listener);
      state.cleanup = () => {
        for (const [name, listener] of listeners) engine.removeEventListener(name, listener);
      };
      metadata.set(engine, state);
      engine.setAttribute("src", url);
      engine.style.position = "absolute";
      engine.style.inset = "0";
      engine.style.opacity = "0";
      engine.style.zIndex = "0";
      engine.style.pointerEvents = "none";
      input.container.appendChild(engine);
      return engine;
    },
    waitForHealth(engine, signal) {
      return waitForPreflightHealth(
        () => readHyperframesPreflightHealth(engine, metadata.get(engine)?.timeline ?? false),
        { signal },
      );
    },
    show(engine) {
      visible = engine;
      engine.style.opacity = "1";
      engine.style.zIndex = "1";
      engine.style.pointerEvents = "auto";
      notify(engine);
    },
    dispose(engine) {
      metadata.get(engine)?.cleanup();
      metadata.delete(engine);
      engine.pause();
      engine.remove();
      if (visible === engine) visible = null;
    },
  };
}
