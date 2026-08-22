import { createHyperframesPlayerEnvironment } from "../../../src/components/studio/hyperframes-player-environment";
import { PlayerHost } from "../../../src/components/studio/player-host";



const container = document.querySelector<HTMLDivElement>("#host");
if (!container) throw new Error("preview probe host is missing");
// One host frame is one live preview, and a frame torn down with its document
// cannot report its own removal — so the count is observed from out here.
let maxLiveFrames = 0;
// The production bridge is cross-origin, so its parent must never inspect the
// nested authored document. The bridge marks only frames that were assigned a
// composition; the warm spare remains outside this count.
const liveFrames = () => container.querySelectorAll("iframe[data-preview-loaded='true']").length;
const trackFrames = new MutationObserver(() => {
  maxLiveFrames = Math.max(maxLiveFrames, liveFrames());
});
trackFrames.observe(container, { childList: true });

const environment = createHyperframesPlayerEnvironment({
  container,
  previewOrigin: `http://preview.localhost:${window.location.port}`,
  onVisibleState(player) { visibleSeq = player.health.changeSeq; },
});
const host = new PlayerHost({ projectToken: "project-browser", environment });
let visibleSeq = 0;
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
      // Each engine is a host page now, so the visible composition is two frames
      // down: the host iframe that is showing, then the player inside it.
      return {
        hostId: host.id,
        activePlayers: liveFrames(),
        maxActivePlayers: Math.max(maxLiveFrames, liveFrames()),
        visibleSeq,
        transport: host.transport(),
      };
    },
    dispose: () => host.dispose(),
  },
});
