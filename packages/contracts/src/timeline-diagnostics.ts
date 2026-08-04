export interface TimedEffectForDiagnostics {
  id: string;
  start: number;
  duration: number;
}

export interface TimedElementForDiagnostics {
  id: string;
  start: number | null;
  duration: number | null;
  effects: readonly TimedEffectForDiagnostics[];
}

export interface ElementWindow {
  effectStart: number;
  effectEnd: number;
  start: number;
  span: number;
  inWindow: number;
  overrun: number;
}

/** Shared timeline/diagnostics arithmetic; contains no I/O or business orchestration. */
export function countStrandedTweens(
  elements: readonly TimedElementForDiagnostics[],
  sceneDuration: number,
): number {
  return elements.reduce(
    (total, element) => total + element.effects.filter((effect) => effect.start >= sceneDuration).length,
    0,
  );
}

/** Computes the visible and unreachable portions of one timed element. */
export function measureElementWindow(
  element: TimedElementForDiagnostics,
  sceneDuration: number,
): ElementWindow {
  const effectStart = element.effects[0]?.start ?? 0;
  const effectEnd = element.effects.reduce(
    (end, effect) => Math.max(end, effect.start + effect.duration), effectStart,
  );
  const start = element.start ?? effectStart;
  const span = element.duration ?? Math.max(effectEnd - effectStart, 0);
  return {
    effectStart,
    effectEnd,
    start,
    span,
    inWindow: Math.max(Math.min(start + span, sceneDuration) - start, 0),
    overrun: Math.max(start + span - Math.max(start, sceneDuration), 0),
  };
}
