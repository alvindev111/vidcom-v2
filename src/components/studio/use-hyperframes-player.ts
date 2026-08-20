"use client";

import * as React from "react";

import {
  createHyperframesPlayerEnvironment,
  type HyperframesPreviewEngine,
} from "./hyperframes-player-environment";
import { PlayerHost, type PlayerHostMountResult } from "./player-host";
import { createTimeStore, type TimeStore } from "./player-time";
import type { PreviewReloadResult } from "./preview-buffer";

export interface PlayerControls {
  toggle: () => void;
  seek: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  toggleMuted: () => void;
}

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
 * Keeps one stable project-scoped PlayerHost while its replaceable player
 * engines reload through the preview buffer.
 */
export function useHyperframesPlayer(projectId: string, previewUrl: string) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const hostRef = React.useRef<PlayerHost<HyperframesPreviewEngine> | null>(null);
  const mountPromiseRef = React.useRef<Promise<PlayerHostMountResult> | null>(null);
  const mountedUrlRef = React.useRef<string | null>(null);
  const visibleChangeSeqRef = React.useRef(0);
  const desiredChangeSeqRef = React.useRef(0);
  const previewUrlRef = React.useRef(previewUrl);
  const [state, setState] = React.useState<PlayerState>(INITIAL);
  const [timeStore] = React.useState<TimeStore>(createTimeStore);

  React.useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  const requestReload = React.useCallback(async (input: {
    url: string;
    targetChangeSeq: number;
  }): Promise<PreviewReloadResult> => {
    const host = hostRef.current;
    if (!host) return { kind: "disposed" };
    desiredChangeSeqRef.current = Math.max(desiredChangeSeqRef.current, input.targetChangeSeq);
    const mounting = mountPromiseRef.current;
    if (mounting) {
      const mounted = await mounting;
      if (hostRef.current !== host || mounted.kind !== "mounted") return { kind: "disposed" };
    }
    const result = await host.requestReload(input);
    if (hostRef.current !== host) return { kind: "disposed" };
    if (result.kind === "swapped") {
      mountedUrlRef.current = input.url;
      visibleChangeSeqRef.current = result.visibleChangeSeq;
      // What the visible frame is showing, stated on the element itself: the
      // preview is double-buffered, so "has it caught up yet" is otherwise only
      // knowable from inside this hook.
      if (containerRef.current) {
        containerRef.current.dataset.previewChangeSeq = String(result.visibleChangeSeq);
        delete containerRef.current.dataset.previewError;
      }
      desiredChangeSeqRef.current = Math.max(desiredChangeSeqRef.current, result.visibleChangeSeq);
      setState((current) => ({ ...current, error: null }));
    } else if (result.kind === "rejected") {
      setState((current) => ({ ...current, error: result.reason }));
      if (containerRef.current) containerRef.current.dataset.previewError = result.reason;
    }
    return result;
  }, []);

  React.useEffect(() => {
    let disposed = false;
    let host: PlayerHost<HyperframesPreviewEngine> | null = null;
    let hostContainer: HTMLDivElement | null = null;

    const mount = async () => {
      await import("@hyperframes/player");
      const container = containerRef.current;
      if (disposed || !container) return;
      hostContainer = container;
      setState(INITIAL);
      timeStore.set(0);

      const environment = createHyperframesPlayerEnvironment({
        container,
        onVisibleState: (player, error) => {
          timeStore.set(player.currentTime);
          const duration = player.duration || 0;
          const { paused, muted, playbackRate, ready } = player;
          setState((current) =>
            (duration === 0 || duration === current.duration) &&
            paused === current.paused &&
            muted === current.muted &&
            playbackRate === current.playbackRate &&
            ready === current.ready &&
            error === current.error
              ? current
              : {
                  duration: duration || current.duration,
                  paused,
                  ready,
                  muted,
                  playbackRate,
                  error,
                },
          );
        },
      });
      host = new PlayerHost({ projectToken: projectId, environment });
      hostRef.current = host;
      container.dataset.playerHostId = host.id;
      const mountedUrl = previewUrlRef.current;
      const mountPromise = host.mount(mountedUrl);
      mountPromiseRef.current = mountPromise;
      const result = await mountPromise;
      if (disposed || hostRef.current !== host) return;
      if (result.kind === "rejected") {
        setState((current) => ({ ...current, ready: false, error: result.reason }));
        return;
      }
      if (result.kind !== "mounted") return;
      mountedUrlRef.current = mountedUrl;
      visibleChangeSeqRef.current = result.visibleChangeSeq;
      desiredChangeSeqRef.current = result.visibleChangeSeq;
    };

    void mount();
    return () => {
      disposed = true;
      host?.dispose();
      if (hostRef.current === host) hostRef.current = null;
      if (hostRef.current === null) mountPromiseRef.current = null;
      if (hostContainer && host && hostContainer.dataset.playerHostId === host.id) {
        delete hostContainer.dataset.playerHostId;
      }
      mountedUrlRef.current = null;
    };
  }, [projectId, requestReload, timeStore]);

  const controls = React.useMemo<PlayerControls>(
    () => ({
      toggle: () => {
        const host = hostRef.current;
        if (!host) return;
        if (host.transport().paused) host.play();
        else host.pause();
        setState((current) => ({ ...current, paused: !current.paused }));
      },
      seek: (seconds: number) => {
        hostRef.current?.seek(seconds);
        timeStore.set(seconds);
      },
      setPlaybackRate: (rate: number) => {
        hostRef.current?.setPlaybackRate(rate);
        setState((current) => ({ ...current, playbackRate: rate }));
      },
      toggleMuted: () => {
        const host = hostRef.current;
        if (!host) return;
        const muted = !host.transport().muted;
        host.setMuted(muted);
        setState((current) => ({ ...current, muted }));
      },
    }),
    [timeStore],
  );

  return { containerRef, state, controls, timeStore, requestReload };
}
