export type ProjectChanged = (changeSeq: number | null) => void;

/** Reads only the exact durable outbox token returned by a successful write. */
export function mutationChangeSeq(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null || !("changeSeq" in payload)) return null;
  const value = (payload as { changeSeq?: unknown }).changeSeq;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

/** Null means unchanged/no durable event, so no candidate should be created. */
export function previewReloadRequest(
  previewUrl: string,
  changeSeq: number | null,
): { url: string; targetChangeSeq: number } | null {
  return changeSeq === null ? null : { url: previewUrl, targetChangeSeq: changeSeq };
}
