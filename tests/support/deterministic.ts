/**
 * Creates a clock whose value never changes and whose returned dates cannot mutate later reads.
 */
export function createFixedClock(isoTimestamp: string): { now(): Date } {
  const timestamp = new Date(isoTimestamp).getTime();

  return {
    now: () => new Date(timestamp),
  };
}

/**
 * Creates a deterministic ID source compatible with the Core `IdPort` shape.
 */
export function createSequentialIdPort(start = 1): { newId(prefix: string): string } {
  let sequence = start;

  return {
    newId(prefix: string): string {
      const id = `${prefix}_${String(sequence).padStart(4, "0")}`;
      sequence += 1;
      return id;
    },
  };
}
