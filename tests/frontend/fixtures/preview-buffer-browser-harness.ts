import { ProbePlayer } from "./preview-buffer-browser-player";
import { createHyperframesPlayerEnvironment } from "../../../src/components/studio/hyperframes-player-environment";
import { PlayerHost } from "../../../src/components/studio/player-host";



const container = document.querySelector<HTMLDivElement>("#host");
if (!container) throw new Error("preview probe host is missing");
// One host frame is one live preview, and a frame torn down with its document
// cannot report its own removal — so the count is observed from out here.
let maxLiveFrames = 0;
const liveFrames = () => container.querySelectorAll("iframe").length;
const trackFrames = new MutationObserver(() => {
  maxLiveFrames = Math.max(maxLiveFrames, liveFrames());
});
trackFrames.observe(container, { childList: true });

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
      // Each engine is a host page now, so the visible composition is two frames
      // down: the host iframe that is showing, then the player inside it.
      const shown = [...container.querySelectorAll<HTMLIFrameElement>("iframe")]
        .find((frame) => frame.style.opacity === "1");
      const visible = shown?.contentDocument?.querySelector("hyperframes-player") as ProbePlayer | null;
      const collector = visible?.iframeElement.contentDocument
        ?.querySelector<HTMLScriptElement>('script[data-vidcom-health="collector"]');
      return {
        hostId: host.id,
        activePlayers: liveFrames(),
        maxActivePlayers: Math.max(maxLiveFrames, liveFrames()),
        visibleSeq: Number(collector?.dataset.changeSeq ?? 0),
        transport: host.transport(),
      };
    },
    dispose: () => host.dispose(),
  },
});
