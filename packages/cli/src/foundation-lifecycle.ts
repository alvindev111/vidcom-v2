/** One teardown step, named so a failure says which part refused to stop. */
export interface TeardownStep {
  name: string;
  run: () => Promise<void> | void;
}

export interface LifecycleHandle {
  /** Runs every step once, in order. Safe to call any number of times. */
  stop(): Promise<void>;
  /** True once `stop()` has been called, whether or not it finished cleanly. */
  readonly stopping: boolean;
  /** Steps that have already run, in the order they ran. */
  completedSteps(): readonly string[];
}

/**
 * Turns an ordered list of teardown steps into an idempotent handle.
 *
 * Two properties matter more than the mechanics.
 *
 * **Once.** Every step runs at most once across every call to `stop()`, because
 * the shutdown paths overlap: a signal, a lost lease and an explicit stop can
 * arrive together, and releasing the same lease twice or closing the same
 * listener twice turns an orderly shutdown into an error.
 *
 * **In order, and all of them.** A step that throws does not cancel the rest.
 * The listener has to close even when the scheduler refuses to stop, and the
 * lease has to be released even when the watcher fails — a half-torn-down
 * foundation that still holds the lease is the state this whole phase exists to
 * prevent. Failures are collected and thrown together at the end.
 */
export function createLifecycleHandle(steps: readonly TeardownStep[]): LifecycleHandle {
  const completed: string[] = [];
  const started = new Set<string>();
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  const runAll = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const step of steps) {
      if (started.has(step.name)) continue;
      started.add(step.name);
      try {
        await step.run();
        completed.push(step.name);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "foundation shutdown failed");
    }
  };

  return {
    get stopping() {
      return stopping;
    },
    completedSteps: () => [...completed],
    stop(): Promise<void> {
      stopping = true;
      // The same promise is handed to every caller, so a second `stop()` waits
      // for the first rather than starting a second teardown beside it.
      return stopPromise ??= runAll();
    },
  };
}
