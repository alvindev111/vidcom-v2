/**
 * One place that knows whether anything is unsaved (R8.1–8.2).
 *
 * Three different exits can lose a draft — closing the browser, closing the
 * editor tab, leaving the project — and each of them lives in a different
 * component. A shared registry is what keeps all three asking the same question
 * instead of two of them forgetting to.
 */

const owners = new Map<string, number>();

function publishUnsavedCount(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.studioUnsavedCount = String(unsavedCount());
}

/** Reports how many unsaved drafts one owner is holding. */
export function reportUnsaved(ownerId: string, count: number): void {
  if (count > 0) owners.set(ownerId, count);
  else owners.delete(ownerId);
  // Navigation tests and assistive diagnostics need to observe the same
  // registry that confirmDiscard reads, rather than infer readiness from a
  // warning painted by a different component.
  publishUnsavedCount();
}

export function unsavedCount(): number {
  let total = 0;
  for (const count of owners.values()) total += count;
  return total;
}

export function unsavedMessage(count = unsavedCount()): string {
  return count === 1
    ? "One file has unsaved changes. Leave and lose it?"
    : `${count} files have unsaved changes. Leave and lose them?`;
}

/**
 * Asks before an exit that would drop unsaved work; `true` means go ahead.
 *
 * Silent when nothing is unsaved, so ordinary navigation is never interrupted.
 */
export function confirmDiscard(
  ask: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  const count = unsavedCount();
  return count === 0 || ask(unsavedMessage(count));
}

/** Installs the browser-level warning; returns the teardown. */
export function installUnloadGuard(target: Window = window): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (unsavedCount() === 0) return;
    // The text is the browser's to choose; what matters is that it asks.
    event.preventDefault();
    event.returnValue = unsavedMessage();
  };
  target.addEventListener("beforeunload", onBeforeUnload);
  return () => target.removeEventListener("beforeunload", onBeforeUnload);
}
