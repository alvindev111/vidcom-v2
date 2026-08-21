/**
 * The stand-in player both the probe page and each engine's host page register.
 *
 * Shared rather than duplicated: the two pages must agree on what a player does,
 * or the probe would be measuring two different things.
 */

export class ProbePlayer extends HTMLElement {
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
    this.appendChild(this.iframeElement);
  }

  disconnectedCallback() {
    if (!this.connected) return;
    this.connected = false;
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
if (!customElements.get("hyperframes-player")) customElements.define("hyperframes-player", ProbePlayer);
