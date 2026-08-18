"use client";

import * as React from "react";
import type { ApiRequestInit } from "@/lib/api/services";

interface StudioSessionValue {
  eventRevision: number;
  request(init?: ApiRequestInit): ApiRequestInit;
  resetHistory(reloadSource: boolean): Promise<void>;
}

const StudioSessionContext = React.createContext<StudioSessionValue | null>(null);

export function StudioSessionProvider({
  eventRevision,
  request,
  resetHistory,
  children,
}: StudioSessionValue & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ eventRevision, request, resetHistory }), [eventRevision, request, resetHistory]);
  return <StudioSessionContext.Provider value={value}>{children}</StudioSessionContext.Provider>;
}

export function useStudioSession(): StudioSessionValue {
  const value = React.useContext(StudioSessionContext);
  if (!value) throw new Error("studio mutation rendered before its session attached");
  return value;
}
