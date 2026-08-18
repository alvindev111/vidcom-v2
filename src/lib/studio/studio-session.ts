import type { ApiPath, ApiRequestInit } from "../api/services";

export const STUDIO_SESSION_HEADER = "x-vidcom-studio-session";

export function studioRequestInit(
  studioSessionId: string,
  init: ApiRequestInit = {},
): ApiRequestInit {
  const headers = new Headers(init.headers);
  headers.set(STUDIO_SESSION_HEADER, studioSessionId);
  return { ...init, headers };
}

export function historyPath(
  projectId: string,
  endpoint: "history" | "session" | "undo" | "redo",
): ApiPath {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
  if (endpoint === "history") return `${base}/history` as ApiPath;
  if (endpoint === "session") return `${base}/history/session` as ApiPath;
  return `${base}/${endpoint}` as ApiPath;
}

export function studioEventPath(projectId: string): ApiPath {
  return `/api/v1/events?projectId=${encodeURIComponent(projectId)}`;
}

export interface StudioEvent {
  id: string | null;
  type: string;
  data: string;
}

/** Returns a durable token only for an event explicitly scoped to this project. */
export function studioEventChangeSeq(event: StudioEvent, projectId: string): number | null {
  if (event.id === null || !/^[1-9]\d*$/u.test(event.id)) return null;
  try {
    const payload = JSON.parse(event.data) as { projectId?: unknown };
    if (payload.projectId !== projectId) return null;
  } catch {
    return null;
  }
  const value = Number(event.id);
  return Number.isSafeInteger(value) ? value : null;
}

export function latestStudioChangeSeq(
  current: number | null,
  event: StudioEvent,
  projectId: string,
): number | null {
  const next = studioEventChangeSeq(event, projectId);
  if (next === null) return current;
  return current === null ? next : Math.max(current, next);
}

/** Incrementally decodes SSE frames from a fetch response without DOM globals. */
export async function consumeStudioEvents(
  response: Response,
  onEvent: (event: StudioEvent) => void,
): Promise<string | null> {
  if (!response.body) throw new Error("studio event response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEventId: string | null = null;
  for (;;) {
    const chunk = await reader.read();
    buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let type = "message";
      let id: string | null = null;
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
        if (field === "event") type = value;
        if (field === "id") id = value;
        if (field === "data") data.push(value);
      }
      if (id !== null) lastEventId = id;
      if (data.length > 0) onEvent({ id, type, data: data.join("\n") });
      boundary = buffer.indexOf("\n\n");
    }
    if (chunk.done) return lastEventId;
  }
}
