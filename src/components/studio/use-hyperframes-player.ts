"use client";

import * as React from "react";

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

export interface PlayerState {
  currentTime: number;
  duration: number;
  paused: boolean;
  ready: boolean;
  muted: boolean;
  playbackRate: number;
  error: string | null;
}

const INITIAL: PlayerState = {
  currentTime: 0,
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

      player = document.createElement(
        "hyperframes-player",
      ) as HyperframesPlayerElement;
      player.setAttribute("src", previewUrl);
      player.style.position = "absolute";
      player.style.inset = "0";

      const sync = () =>
        setState((current) => ({
          ...current,
          currentTime: player?.currentTime ?? current.currentTime,
          duration: player?.duration || current.duration,
          paused: player?.paused ?? current.paused,
          muted: player?.muted ?? current.muted,
          playbackRate: player?.playbackRate ?? current.playbackRate,
        }));

      const onReady = () =>
        setState((current) => ({ ...current, ready: true, error: null }));
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
  }, [previewUrl]);

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
        setState((current) => ({ ...current, currentTime: seconds }));
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
    [],
  );

  return { containerRef, state, controls };
}
