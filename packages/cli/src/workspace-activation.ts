import { ErrorCode } from "@vidcom/contracts";

export class WorkspaceActivationError extends Error {
  readonly name = "WorkspaceActivationError";
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/** One built foundation, opaque to the coordinator that swaps it. */
export interface ActivatedFoundation {
  workspaceRoot: string;
  stop(): Promise<void>;
}

export interface ActivationDependencies {
  /** Resolves a workspace to its canonical form, or rejects an unusable one. */
  canonicalize(workspaceRoot: string): Promise<string>;
  /** Non-terminal jobs block a switch; returns how many are still running. */
  countRunningJobs(): Promise<number>;
  /** Builds a foundation for a canonical root. Must not touch the previous one. */
  build(workspaceRoot: string): Promise<ActivatedFoundation>;
  /** Records the active workspace. Called only after a swap has succeeded. */
  recordActive(workspaceRoot: string): Promise<void>;
}

export interface ActivationResult {
  workspaceRoot: string;
  swapped: boolean;
  rolledBack: boolean;
}

/**
 * Serializes workspace activation and switching.
 *
 * The ordering here is the whole task. Canonicalizing and building happen
 * **before** the previous foundation is touched, so a bad path or a failed
 * build costs nothing: the old workspace keeps serving. Only once a new
 * foundation exists is the swap performed, once, and only after that is
 * `active_workspace` recorded.
 *
 * Recording last is deliberate. Writing it during resolution — which is what
 * `selectWorkspace` used to do — meant a one-off `render --workspace X` moved
 * the workspace the UI opens by default, and a failed activation could leave
 * the pointer aimed at a workspace that never came up.
 */
export class WorkspaceActivationCoordinator {
  private current: ActivatedFoundation | null = null;
  private inFlight: Promise<ActivationResult> | null = null;

  constructor(private readonly dependencies: ActivationDependencies) {}

  get activeWorkspace(): string | null {
    return this.current?.workspaceRoot ?? null;
  }

  get switching(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Activates a workspace, replacing any current one.
   *
   * Concurrent calls are refused rather than queued: a second switch arriving
   * mid-swap would be deciding against a state that is about to change.
   */
  async activate(workspaceRoot: string): Promise<ActivationResult> {
    if (this.inFlight) {
      throw new WorkspaceActivationError(
        ErrorCode.WorkspaceSwitching,
        "a workspace switch is already in progress",
      );
    }
    this.inFlight = this.run(workspaceRoot);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async run(workspaceRoot: string): Promise<ActivationResult> {
    // Canonicalize first: an unusable path must fail before anything is torn
    // down, and two spellings of one directory must not read as a switch.
    const canonical = await this.dependencies.canonicalize(workspaceRoot);
    if (this.current?.workspaceRoot === canonical) {
      return { workspaceRoot: canonical, swapped: false, rolledBack: false };
    }

    const running = await this.dependencies.countRunningJobs();
    if (running > 0) {
      // Refused, not queued. Tearing down under a running job abandons work
      // that has already written to the workspace.
      throw new WorkspaceActivationError(
        ErrorCode.WorkspaceBusy,
        `refusing to switch while ${running} job(s) are still running`,
        { running },
      );
    }

    const previous = this.current;
    let next: ActivatedFoundation;
    try {
      next = await this.dependencies.build(canonical);
    } catch (error) {
      // Nothing was touched, so the previous workspace is still serving.
      throw error instanceof WorkspaceActivationError ? error : new WorkspaceActivationError(
        ErrorCode.WorkspaceUnavailable,
        error instanceof Error ? error.message : String(error),
      );
    }

    this.current = next;
    try {
      await previous?.stop();
    } catch (error) {
      // The old foundation refused to stop while the new one is already live,
      // which would leave two writers. Roll back to the previous one and take
      // the new one down.
      this.current = previous;
      await next.stop().catch(() => {});
      throw new WorkspaceActivationError(
        ErrorCode.WorkspaceBusy,
        `the previous workspace could not be released: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Recorded only now: a pointer written earlier can outlive an activation
    // that never completed.
    await this.dependencies.recordActive(canonical);
    return { workspaceRoot: canonical, swapped: true, rolledBack: false };
  }

  /** Stops the current foundation without activating another. */
  async stop(): Promise<void> {
    const current = this.current;
    this.current = null;
    await current?.stop();
  }
}
