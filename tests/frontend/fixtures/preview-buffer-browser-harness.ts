import { createHyperframesPlayerEnvironment } from "../../../src/components/studio/hyperframes-player-environment";
import { PlayerHost } from "../../../src/components/studio/player-host";

class ProbePlayer extends HTMLElement {
  static observedAttributes = ["src"];

  currentTime = 0;
  duration = 0;
  paused = true;
  playbackRate = 1;
  muted = false;
  ready = false;
  scenes: Array<{ id: string; start: number; duration: number }> = [];
  readonly iframeElement = document.createElement("iframe");
  private connected = false;

  constructor() {
    super();
    this.iframeElement.addEventListener("load", () => {
      const document = this.iframeElement.contentDocument;
      this.duration = Number(document?.body.dataset.duration ?? 0);
      this.ready = true;
      this.scenes = [{ id: "root", start: 0, duration: this.duration }];
      this.dispatchEvent(new Event("ready"));
      this.dispatchEvent(new Event("scenes"));
    });
  }

  connectedCallback() {
    if (this.connected) return;
    this.connected = true;
    window.__previewProbeActivePlayers += 1;
    window.__previewProbeMaxActivePlayers = Math.max(
      window.__previewProbeMaxActivePlayers,
      window.__previewProbeActivePlayers,
    );
    this.appendChild(this.iframeElement);
  }

  disconnectedCallback() {
    if (!this.connected) return;
    this.connected = false;
    window.__previewProbeActivePlayers -= 1;
  }

  attributeChangedCallback(_name: string, _oldValue: string | null, value: string | null) {
    if (value) this.iframeElement.src = value;
  }

  seek(seconds: number) {
    this.currentTime = seconds;
    this.dispatchEvent(new Event("timeupdate"));
  }

  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

declare global {
  interface Window {
    __previewProbeActivePlayers: number;
    __previewProbeMaxActivePlayers: number;
  }
}

window.__previewProbeActivePlayers = 0;
window.__previewProbeMaxActivePlayers = 0;
customElements.define("hyperframes-player", ProbePlayer);

const container = document.querySelector<HTMLDivElement>("#host");
if (!container) throw new Error("preview probe host is missing");
const environment = createHyperframesPlayerEnvironment({ container, onVisibleState() {} });
const host = new PlayerHost({ projectToken: "project-browser", environment });
const previewUrl = (input: {
  served: number;
  duration?: number;
  variant?: string;
  delay?: number;
}) => {
  const query = new URLSearchParams({
    served: String(input.served),
    duration: String(input.duration ?? 10),
    variant: input.variant ?? "healthy",
    delay: String(input.delay ?? 0),
  });
  return `/preview?${query}`;
};

Object.assign(window, {
  previewProbe: {
    mount: () => host.mount(previewUrl({ served: 1 })),
    setTransport(input: { time: number; paused: boolean; rate: number; muted: boolean }) {
      host.seek(input.time);
      host.setPlaybackRate(input.rate);
      host.setMuted(input.muted);
      if (input.paused) host.pause();
      else host.play();
    },
    reload(input: { target: number; served: number; duration?: number; variant?: string; delay?: number }) {
      return host.requestReload({ url: previewUrl(input), targetChangeSeq: input.target });
    },
    snapshot() {
      const visible = [...container.querySelectorAll<ProbePlayer>("hyperframes-player")]
        .find((player) => player.style.opacity === "1");
      const collector = visible?.iframeElement.contentDocument
        ?.querySelector<HTMLScriptElement>('script[data-vidcom-health="collector"]');
      return {
        hostId: host.id,
        activePlayers: window.__previewProbeActivePlayers,
        maxActivePlayers: window.__previewProbeMaxActivePlayers,
        visibleSeq: Number(collector?.dataset.changeSeq ?? 0),
        transport: host.transport(),
      };
    },
    dispose: () => host.dispose(),
  },
});
