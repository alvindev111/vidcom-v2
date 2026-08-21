import "./preview-buffer-browser-player";
import {
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
  parsePreviewParentCommand,
} from "../../../src/lib/studio/preview-bridge";
import type { ProbePlayer } from "./preview-buffer-browser-player";

const values = new URLSearchParams(location.hash.slice(1));
const nonce = values.get("nonce")!;
const parentOrigin = values.get("parentOrigin")!;
const host = document.querySelector("[data-preview-host]")!;
const player = document.createElement("hyperframes-player") as ProbePlayer;
host.appendChild(player);
let timeline = false;

const post = (message: Record<string, unknown>) => parent.postMessage({
  channel: PREVIEW_BRIDGE_CHANNEL,
  version: PREVIEW_BRIDGE_VERSION,
  nonce,
  ...message,
}, parentOrigin);
const snapshot = (requestId: string | null = null) => {
  const composition = player.iframeElement.contentDocument;
  const collector = (player.iframeElement.contentWindow as (Window & {
    __vidcomHealth?: { scriptErrors?: number; rejections?: number; resourceErrors?: number };
  }) | null)?.__vidcomHealth;
  const script = composition?.querySelector<HTMLScriptElement>('[data-vidcom-health="collector"]');
  const nested = composition ? [...composition.querySelectorAll<HTMLElement>("[data-composition-src]")] : [];
  post({
    type: "snapshot",
    requestId,
    state: {
      ready: player.ready,
      scenes: player.scenes,
      duration: player.duration,
      currentTime: player.currentTime,
      paused: player.paused,
      muted: player.muted,
      playbackRate: player.playbackRate,
      health: {
        timeline,
        scenesLoaded: Boolean(composition) && nested.every((layer) => layer.children.length > 0),
        collectorSeen: Boolean(collector && script),
        scriptErrors: collector?.scriptErrors ?? 0,
        rejections: collector?.rejections ?? 0,
        resourceErrors: collector?.resourceErrors ?? 0,
        revision: Number(script?.dataset.projectRevision ?? 0),
        changeSeq: Number(script?.dataset.changeSeq ?? 0),
      },
    },
  });
};
const sync = () => snapshot();
for (const event of ["ready", "timeupdate", "play", "pause", "ratechange", "volumechange"]) {
  player.addEventListener(event, sync);
}
player.addEventListener("scenes", () => { timeline = true; snapshot(); });
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== parentOrigin) return;
  const command = parsePreviewParentCommand(event.data, nonce);
  if (!command) return;
  switch (command.type) {
    case "load": player.setAttribute("src", command.url); break;
    case "seek": player.seek(command.seconds); break;
    case "play": player.play(); break;
    case "pause": player.pause(); break;
    case "set-rate": player.playbackRate = command.rate; break;
    case "set-muted": player.muted = command.muted; break;
    case "dispose": player.remove(); break;
  }
  post({ type: "ack", requestId: command.requestId, ok: true });
  if (command.type !== "dispose") snapshot(command.requestId);
});
post({ type: "ready" });
