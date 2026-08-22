"use client";

import * as React from "react";

import {
  createHyperframesPlayerEnvironment,
  type HyperframesPreviewEngine,
} from "./hyperframes-player-environment";
import type { PreviewArrangeTarget } from "../../lib/studio/preview-bridge";
import type { PreviewAudioState } from "../../lib/studio/preview-bridge";
import { PlayerHost, type PlayerHostMountResult } from "./player-host";
import { createTimeStore, type TimeStore } from "./player-time";
import type { PreviewReloadResult } from "./preview-buffer";

export interface PlayerControls {
  toggle: () => void;
  seek: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  toggleMuted: () => void;
  setArrangeMode: (enabled: boolean) => void;
  hitTest: (xRatio: number, yRatio: number) => Promise<PreviewArrangeTarget | null>;
  previewOffset: (sceneId: string, hfId: string, offsetX: number, offsetY: number) => void;
  resetOffset: (sceneId: string, hfId: string) => void;
  confirmVisibleChange: (changeSeq: number) => void;
}

export interface PlayerState {
  duration: number;
  paused: boolean;
  ready: boolean;
  muted: boolean;
  playbackRate: number;
  error: string | null;
  audioState: PreviewAudioState;
  audioError: string | null;
}

const INITIAL: PlayerState = {
  duration: 0,
  paused: true,
  ready: false,
  muted: false,
  playbackRate: 1,
  error: null,
  audioState: "ready",
  audioError: null,
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
  const arrangeModeRef = React.useRef(false);
  const arrangedEnginesRef = React.useRef(new WeakSet<HyperframesPreviewEngine>());
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
        delete containerRef.current.dataset.previewHealth;
      }
      desiredChangeSeqRef.current = Math.max(desiredChangeSeqRef.current, result.visibleChangeSeq);
      setState((current) => ({ ...current, error: null }));
    } else if (result.kind === "rejected") {
      setState((current) => ({ ...current, error: result.reason }));
      if (containerRef.current) {
        containerRef.current.dataset.previewError = result.reason;
        containerRef.current.dataset.previewHealth = JSON.stringify(result.health);
      }
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
        previewOrigin: new URL(previewUrlRef.current, window.location.href).origin,
        onVisibleState: (player, error) => {
          if (arrangeModeRef.current && !arrangedEnginesRef.current.has(player)) {
            arrangedEnginesRef.current.add(player);
            player.setArrangeMode(true);
          }
          timeStore.set(player.currentTime);
          const duration = player.duration || 0;
          const { paused, muted, playbackRate, ready, audioState, audioError } = player;
          setState((current) =>
            (duration === 0 || duration === current.duration) &&
            paused === current.paused &&
            muted === current.muted &&
            playbackRate === current.playbackRate &&
            ready === current.ready &&
            audioState === current.audioState &&
            audioError === current.audioError &&
            error === current.error
              ? current
              : {
                  duration: duration || current.duration,
                  paused,
                  ready,
                  muted,
                  playbackRate,
                  audioState,
                  audioError,
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
        container.dataset.previewError = result.reason;
        container.dataset.previewHealth = JSON.stringify(result.health);
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
      },
      seek: (seconds: number) => {
        hostRef.current?.seek(seconds);
        timeStore.set(seconds);
      },
      setPlaybackRate: (rate: number) => {
        hostRef.current?.setPlaybackRate(rate);
      },
      toggleMuted: () => {
        const host = hostRef.current;
        if (!host) return;
        const muted = !host.transport().muted;
        host.setMuted(muted);
      },
      setArrangeMode: (enabled: boolean) => {
        arrangeModeRef.current = enabled;
        const engine = hostRef.current?.currentEngine();
        engine?.setArrangeMode(enabled);
        if (enabled) setState((current) => ({ ...current, paused: true }));
      },
      hitTest: (xRatio: number, yRatio: number) =>
        hostRef.current?.currentEngine()?.hitTest(xRatio, yRatio) ?? Promise.resolve(null),
      previewOffset: (sceneId: string, hfId: string, offsetX: number, offsetY: number) =>
        hostRef.current?.currentEngine()?.previewOffset(sceneId, hfId, offsetX, offsetY),
      resetOffset: (sceneId: string, hfId: string) =>
        hostRef.current?.currentEngine()?.resetOffset(sceneId, hfId),
      confirmVisibleChange: (changeSeq: number) => {
        if (!Number.isSafeInteger(changeSeq) || changeSeq < 0 || !hostRef.current) return;
        visibleChangeSeqRef.current = Math.max(visibleChangeSeqRef.current, changeSeq);
        desiredChangeSeqRef.current = Math.max(desiredChangeSeqRef.current, changeSeq);
        if (containerRef.current) {
          containerRef.current.dataset.previewChangeSeq = String(visibleChangeSeqRef.current);
          delete containerRef.current.dataset.previewError;
          delete containerRef.current.dataset.previewHealth;
        }
      },
    }),
    [timeStore],
  );

  return { containerRef, state, controls, timeStore, requestReload };
}
