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

/**
 * One preview frame, hosted in a page of its own.
 *
 * Measured, not assumed: a composition runtime opens its bridge only to a parent
 * browsing context that does not already have a preview in it. The studio always
 * has one — the frame on screen — so a candidate created beside it never reports
 * a timeline, and a double-buffered swap could never complete. Each engine
 * therefore lives inside `/preview-host.html`, a page whose only job is to be
 * that parent. It is same-origin, so health and transport still read straight
 * through it.
 */
export interface HyperframesPreviewEngine extends PreviewBufferEngine {
  /** The host page this engine lives in: what is shown, hidden and removed. */
  frame: HTMLIFrameElement;
  /** The player inside the host page, once that page has created it. */
  player: HyperframesPlayerElement | null;
  ready: boolean;
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

/** Reads the daemon-owned collector and structural state from the composition document. */
export function readHyperframesPreflightHealth(
  engine: HyperframesPreviewEngine,
  timeline: boolean,
): PreflightHealthSnapshot {
  const player = engine.player;
  let composition: Document | null = null;
  let collector: CollectorValue | undefined;
  try {
    composition = player?.iframeElement.contentDocument ?? null;
    collector = (player?.iframeElement.contentWindow as PreviewWindow | null)?.__vidcomHealth;
  } catch {
    composition = null;
  }
  const script = composition?.querySelector<HTMLScriptElement>('script[data-vidcom-health="collector"]') ?? null;
  const nested = composition ? [...composition.querySelectorAll<HTMLElement>("[data-composition-src]")] : [];
  return {
    ready: engine.ready && engine.duration > 0,
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

/**
 * Host page for one candidate, carrying the composition it should load.
 *
 * `null` asks for an empty host: the page comes up with its player ready and no
 * composition, so the candidate that takes it only pays for the composition.
 */
export function previewHostUrl(source: string | null): string {
  return source === null ? "/preview-host.html" : `/preview-host.html?src=${encodeURIComponent(source)}`;
}

/** Same-origin bridge from the replaceable host pages to the pure buffer coordinator. */
export function createHyperframesPlayerEnvironment(input: {
  container: HTMLDivElement;
  onVisibleState: (engine: HyperframesPreviewEngine, error: string | null) => void;
}): PreviewBufferEnvironment<HyperframesPreviewEngine> {
  const metadata = new WeakMap<HyperframesPreviewEngine, EngineMetadata>();
  let visible: HyperframesPreviewEngine | null = null;
  /**
   * One host page kept loaded and empty for the next reload.
   *
   * A host page and its player cost a page load to bring up, and on a slow
   * machine that lands inside the budget a person waits after saving. The spare
   * pays it in advance. It holds no composition, so it is not a second preview:
   * the two-engine bound is about compositions being rendered, not about idle
   * documents.
   */
  let spare: HTMLIFrameElement | null = null;

  const hostFrame = (): HTMLIFrameElement => {
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
    return frame;
  };

  const notify = (engine: HyperframesPreviewEngine, error: string | null = null) => {
    if (visible === engine) input.onVisibleState(engine, error);
  };

  return {
    createCandidate({ url }) {
      const taken = (() => {
        try { return spare?.contentDocument?.querySelector("hyperframes-player") as HyperframesPlayerElement | null; }
        catch { return null; }
      })();
      const frame = taken ? spare! : hostFrame();
      if (taken) spare = null;

      const state = { timeline: false, cleanup: () => {} };
      const engine: HyperframesPreviewEngine = {
        frame,
        player: null,
        ready: false,
        scenes: [],
        get currentTime() { return engine.player?.currentTime ?? 0; },
        get duration() { return engine.player?.duration ?? 0; },
        get paused() { return engine.player?.paused ?? true; },
        get playbackRate() { return engine.player?.playbackRate ?? 1; },
        set playbackRate(value: number) { if (engine.player) engine.player.playbackRate = value; },
        get muted() { return engine.player?.muted ?? false; },
        set muted(value: boolean) { if (engine.player) engine.player.muted = value; },
        seek(seconds: number) { engine.player?.seek(seconds); },
        play() { engine.player?.play(); },
        pause() { engine.player?.pause(); },
      };

      const attach = (hosted: HyperframesPlayerElement) => {
        engine.player = hosted;
        const sync = () => {
          engine.ready = hosted.ready;
          engine.scenes = hosted.scenes;
          notify(engine);
        };
        const onScenes = () => { state.timeline = true; sync(); };
        const onError = (event: Event) => notify(
          engine,
          (event as CustomEvent<{ message?: string }>).detail?.message ?? event.type,
        );
        const listeners: Array<[string, EventListener]> = [
          ["timeupdate", sync],
          ["ready", sync],
          ["scenes", onScenes],
          ["play", sync],
          ["pause", sync],
          ["ratechange", sync],
          ["volumechange", sync],
          ["error", onError],
          ["playbackerror", onError],
          ["runtimeprotocolerror", onError],
        ];
        for (const [name, listener] of listeners) hosted.addEventListener(name, listener);
        state.cleanup = () => {
          for (const [name, listener] of listeners) hosted.removeEventListener(name, listener);
        };
        sync();
      };

      // The host page creates its player after a dynamic import settles, so this
      // watches for it rather than racing it, and keeps reading the scene list
      // from the element itself — an event dispatched before the listener
      // attached would otherwise be lost.
      // Watches only until the host page has produced a player that has reported
      // its scenes: after that the element's own events keep the engine current,
      // and a timer left running per engine is a leak that ends in a dead tab.
      const poll = window.setInterval(() => {
        if (!engine.player) {
          const hosted = (() => {
            try { return frame.contentDocument?.querySelector("hyperframes-player") as HyperframesPlayerElement | null; }
            catch { return null; }
          })();
          if (hosted) attach(hosted);
          return;
        }
        engine.ready = engine.player.ready;
        engine.scenes = engine.player.scenes;
        if (engine.scenes.length > 0) {
          state.timeline = true;
          window.clearInterval(poll);
        }
      }, 50);

      metadata.set(engine, {
        get timeline() { return state.timeline; },
        cleanup: () => { window.clearInterval(poll); state.cleanup(); },
      } as EngineMetadata);

      if (taken) {
        attach(taken);
        taken.setAttribute("src", url);
      } else {
        input.container.appendChild(frame);
        frame.src = previewHostUrl(url);
      }
      // Bring up the next spare while this candidate is being watched.
      if (!spare) {
        const next = hostFrame();
        input.container.appendChild(next);
        next.src = previewHostUrl(null);
        spare = next;
      }
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
      engine.frame.style.opacity = "1";
      engine.frame.style.zIndex = "1";
      engine.frame.style.pointerEvents = "auto";
      notify(engine);
    },
    dispose(engine) {
      if (engine.frame === spare) spare = null;
      metadata.get(engine)?.cleanup();
      metadata.delete(engine);
      // Everything here touches a document that may already be tearing itself
      // down, and a throw from a teardown path takes the whole page with it.
      try { engine.player?.pause(); } catch { /* the frame is already gone */ }
      engine.player = null;
      try { engine.frame.remove(); } catch { /* already detached */ }
      if (visible === engine) visible = null;
    },
  };
}
