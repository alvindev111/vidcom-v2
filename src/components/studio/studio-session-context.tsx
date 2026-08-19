"use client";

import * as React from "react";
import type { ApiRequestInit } from "@/lib/api/services";
import type { StudioSourceEvent } from "@/lib/studio/studio-session";

interface StudioSessionValue {
  eventRevision: number;
  /** Newest durable event and the paths it named; drafts resolve against it. */
  sourceEvent: StudioSourceEvent | null;
  /** Sequence of the last stream gap; a gap invalidates every open draft. */
  resyncSeq: number;
  request(init?: ApiRequestInit): ApiRequestInit;
  resetHistory(reloadSource: boolean): Promise<void>;
}

const StudioSessionContext = React.createContext<StudioSessionValue | null>(null);

export function StudioSessionProvider({
  eventRevision,
  sourceEvent,
  resyncSeq,
  request,
  resetHistory,
  children,
}: StudioSessionValue & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ eventRevision, sourceEvent, resyncSeq, request, resetHistory }),
    [eventRevision, request, resetHistory, resyncSeq, sourceEvent],
  );
  return <StudioSessionContext.Provider value={value}>{children}</StudioSessionContext.Provider>;
}

export function useStudioSession(): StudioSessionValue {
  const value = React.useContext(StudioSessionContext);
  if (!value) throw new Error("studio mutation rendered before its session attached");
  return value;
}
