"use client";

import * as React from "react";

import { createTimeStore, type TimeStore } from "./player-time";

/** The slice of `<hyperframes-player>` this app drives. */
interface HyperframesPlayerElement extends HTMLElement {
  play(): void;
  pause(): void;
  seek(timeInSeconds: number): void;
  currentTime: number;
  duration: number;
  paused: boolean;
  ready: boolean;
  playbackRate: number;
  muted: boolean;
}

export interface PlayerControls {
  toggle: () => void;
  seek: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  toggleMuted: () => void;
}

/**
 * Everything about the player *except* the clock, which lives in a `TimeStore`
 * — see `player-time.tsx`. Every field here changes a handful of times per
 * session, so a change to this object can safely re-render the studio.
 */
export interface PlayerState {
  duration: number;
  paused: boolean;
  ready: boolean;
  muted: boolean;
  playbackRate: number;
  error: string | null;
}

const INITIAL: PlayerState = {
  duration: 0,
  paused: true,
  ready: false,
  muted: false,
  playbackRate: 1,
  error: null,
};

/**
 * Mounts the real HyperFrames player into `containerRef` and mirrors its state
 * into React. The element is created imperatively (rather than as JSX) so the
 * custom element only has to exist after its module registers it, and so the
 * instance is available for play/pause/seek without a JSX type shim.
 */
export function useHyperframesPlayer(previewUrl: string) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const playerRef = React.useRef<HyperframesPlayerElement | null>(null);
  const [state, setState] = React.useState<PlayerState>(INITIAL);
  const [timeStore] = React.useState<TimeStore>(createTimeStore);

  React.useEffect(() => {
    let disposed = false;
    let player: HyperframesPlayerElement | null = null;

    const mount = async () => {
      // Registers <hyperframes-player>; import is client-only by design.
      await import("@hyperframes/player");
      const container = containerRef.current;
      if (disposed || !container) return;
      // Reset after the await so switching projects starts from a clean state
      // without a synchronous setState inside the effect body.
      setState(INITIAL);
      timeStore.set(0);

      player = document.createElement(
        "hyperframes-player",
      ) as HyperframesPlayerElement;
      player.setAttribute("src", previewUrl);
      player.style.position = "absolute";
      player.style.inset = "0";

      // Fires on every `timeupdate`. The clock goes to the store, and the rest
      // only reaches React when it actually moved — otherwise a paused-state
      // check ten times a second would re-render the studio anyway.
      const sync = () => {
        if (!player) return;
        timeStore.set(player.currentTime);

        const duration = player.duration || 0;
        const { paused, muted, playbackRate } = player;
        setState((current) =>
          (duration === 0 || duration === current.duration) &&
          paused === current.paused &&
          muted === current.muted &&
          playbackRate === current.playbackRate
            ? current
            : {
                ...current,
                duration: duration || current.duration,
                paused,
                muted,
                playbackRate,
              },
        );
      };

      const onReady = () => {
        setState((current) => ({ ...current, ready: true, error: null }));
        // The runtime only applies per-clip visibility on a tick, so the very
        // first painted frame has every scene visible at once — a 10s-in scene
        // stacked on top of the opening one. One seek at the current time forces
        // that tick and leaves the transport where it was.
        player?.seek(player.currentTime);
      };
      const onError = (event: Event) =>
        setState((current) => ({
          ...current,
          error:
            (event as CustomEvent<{ message?: string }>).detail?.message ??
            event.type,
        }));

      player.addEventListener("timeupdate", sync);
      player.addEventListener("ready", onReady);
      player.addEventListener("error", onError);
      player.addEventListener("playbackerror", onError);
      player.addEventListener("runtimeprotocolerror", onError);

      container.appendChild(player);
      playerRef.current = player;
      // The runtime may already be ready before the listener attaches.
      if (player.ready) onReady();
      sync();
    };

    void mount();

    return () => {
      disposed = true;
      player?.pause();
      player?.remove();
      playerRef.current = null;
    };
  }, [previewUrl, timeStore]);

  const controls = React.useMemo<PlayerControls>(
    () => ({
      toggle: () => {
        const player = playerRef.current;
        if (!player) return;
        if (player.paused) player.play();
        else player.pause();
        setState((current) => ({ ...current, paused: !current.paused }));
      },
      seek: (seconds: number) => {
        playerRef.current?.seek(seconds);
        timeStore.set(seconds);
      },
      setPlaybackRate: (rate: number) => {
        const player = playerRef.current;
        if (player) player.playbackRate = rate;
        setState((current) => ({ ...current, playbackRate: rate }));
      },
      toggleMuted: () => {
        const player = playerRef.current;
        if (!player) return;
        player.muted = !player.muted;
        setState((current) => ({ ...current, muted: player.muted }));
      },
    }),
    [timeStore],
  );

  return { containerRef, state, controls, timeStore };
}
