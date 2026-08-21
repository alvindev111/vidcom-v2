import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import type { ContentHash, DomainEvent, ProjectId, RelPath } from "@vidcom/contracts";
import type { ClockPort, EventOutboxPort, JournalId, MutationObserverPort, ProjectPathInvalidator, ProjectPathState, ProjectRef, TrackedProjectPathState, WorkspacePort, WrittenStateTrackerPort } from "@vidcom/core";

import type { VidcomDatabase } from "../db/client";

export const WATCH_DEBOUNCE_MS = 150;

export type WatchFactory = (
  root: string,
  options: { recursive: true },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher;

function key(projectId: ProjectId, relativePath: RelPath): string {
  return `${projectId}\u0000${relativePath}`;
}

interface TrackedState extends TrackedProjectPathState {
  journalId: JournalId;
  outcome: "committed" | "rolled_back" | "unknown" | null;
  settled: Promise<void>;
  resolve: () => void;
}

function sameState(left: ProjectPathState, right: ProjectPathState): boolean {
  return left.kind === right.kind
    && (left.kind !== "file" || (right.kind === "file" && left.contentHash === right.contentHash));
}

/** Shared journal-correlated state registry consumed once after terminal settlement. */
export class WrittenHashTracker implements WrittenStateTrackerPort {
  private readonly states = new Map<string, TrackedState[]>();
  private readonly byJournal = new Map<JournalId, TrackedState[]>();
  private readonly terminal = new Map<string, ProjectPathState>();

  record(projectId: ProjectId, relativePath: RelPath, state: ContentHash | ProjectPathState): void {
    this.terminal.set(key(projectId, relativePath), typeof state === "string"
      ? { kind: "file", contentHash: state }
      : state);
  }

  arm(projectId: ProjectId, journalId: JournalId, states: readonly TrackedProjectPathState[]): void {
    const journalStates: TrackedState[] = [];
    for (const state of states) {
      let resolve = () => {};
      const settled = new Promise<void>((done) => { resolve = done; });
      const tracked: TrackedState = { ...state, journalId, outcome: null, settled, resolve };
      const itemKey = key(projectId, state.path);
      this.states.set(itemKey, [...(this.states.get(itemKey) ?? []), tracked]);
      journalStates.push(tracked);
    }
    this.byJournal.set(journalId, journalStates);
  }

  settle(journalId: JournalId, outcome: "committed" | "rolled_back" | "unknown"): void {
    for (const state of this.byJournal.get(journalId) ?? []) {
      state.outcome = outcome;
      state.resolve();
    }
    this.byJournal.delete(journalId);
  }

  async sample(
    projectId: ProjectId,
    relativePath: RelPath,
    read: () => Promise<ProjectPathState>,
  ): Promise<{ ownWrite: boolean; state: ProjectPathState }> {
    const itemKey = key(projectId, relativePath);
    while (true) {
      const tracked = this.states.get(itemKey) ?? [];
      if (tracked.some(({ outcome }) => outcome === null)) {
        await Promise.all(tracked.map(({ settled }) => settled));
      }
      const state = await read();
      const current = this.states.get(itemKey) ?? [];
      if (current.length !== tracked.length
        || current.some((item, index) => item !== tracked[index] || item.outcome === null)) {
        continue;
      }
      if (tracked.length > 0) {
        this.states.delete(itemKey);
        const latest = tracked.at(-1)!;
        const expected = latest.outcome === "committed"
          ? latest.after
          : latest.outcome === "rolled_back" ? latest.before : null;
        return { ownWrite: expected !== null && sameState(expected, state), state };
      }
      const expected = this.terminal.get(itemKey);
      this.terminal.delete(itemKey);
      return { ownWrite: expected !== undefined && sameState(expected, state), state };
    }
  }
}

function isMutationArtifact(basename: string): boolean {
  return basename.includes(".vidcom-")
    && [".rollback", ".publish", ".landed"].some((suffix) => basename.endsWith(suffix));
}

/** Debounced workspace watcher that emits only external logical file changes. */
export class WorkspaceWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly restarts = new Set<ReturnType<typeof setTimeout>>();
  private readonly observedStates = new Map<string, ProjectPathState>();
  private closed = false;

  constructor(
    private readonly workspace: WorkspacePort,
    private readonly database: VidcomDatabase,
    private readonly outbox: EventOutboxPort,
    private readonly invalidator: ProjectPathInvalidator,
    private readonly tracker: WrittenHashTracker,
    private readonly clock: ClockPort,
    private readonly debounceMs = WATCH_DEBOUNCE_MS,
    private readonly watchFactory: WatchFactory = watch,
    private readonly observer?: MutationObserverPort,
  ) {}

  async start(): Promise<void> {
    this.closed = false;
    for (const ref of await this.workspace.listProjects()) this.open(ref);
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    for (const timeout of this.restarts) clearTimeout(timeout);
    this.restarts.clear();
  }

  /** Public deterministic seam used by integration tests after a real filesystem edit. */
  async observe(ref: ProjectRef, relativePath: RelPath): Promise<void> {
    await this.observeCandidate(ref, relativePath);
  }

  private async observeCandidate(ref: ProjectRef, candidate: string): Promise<void> {
    const purpose = candidate === "preview-settings.json" || candidate === "vidcom.json"
      || (candidate.startsWith("narration/") && candidate.endsWith(".json"))
      ? "system-write" as const
      : "authored-write" as const;
    const resolved = await this.workspace.resolve(ref, candidate, purpose);
    if (!resolved.ok) return;
    // The resolver has already canonicalized the target and rejected invalid syntax,
    // traversal, and symlink escape. Preserve the validated project-relative spelling:
    // ref.root may itself use a non-canonical alias such as macOS /var -> /private/var.
    const relativePath = candidate as RelPath;
    const readState = async (): Promise<ProjectPathState> => {
      const metadata = await this.workspace.stat(resolved.value);
      if (metadata === null) return { kind: "absent" };
      if (metadata.kind === "directory") return { kind: "directory" };
      if (metadata.kind !== "file") throw new Error("unsupported filesystem entry state");
      const contentHash = await this.workspace.readHash(resolved.value);
      return contentHash === null ? { kind: "absent" } : { kind: "file", contentHash };
    };
    const sampled = await this.tracker.sample(ref.id, relativePath, readState);
    const itemKey = key(ref.id, relativePath);
    if (sampled.ownWrite) {
      this.observedStates.set(itemKey, sampled.state);
      return;
    }
    const previous = this.observedStates.get(itemKey);
    if (previous && sameState(previous, sampled.state)) return;

    if (relativePath === "preview-settings.json") {
      const persistedHash = sampled.state.kind === "file"
        ? sampled.state.contentHash
        : "sha256:deleted";
      const state = this.database.get<{ contentHash: string }>(sql`
        SELECT content_hash AS contentHash FROM entity_state
        WHERE project_id = ${ref.id} AND entity = 'preview-settings'
      `);
      if (state?.contentHash !== persistedHash) {
        this.database.run(sql`
          UPDATE entity_state SET revision = revision + 1, content_hash = ${persistedHash},
            last_actor = 'cli-external', updated_at = ${this.clock.now().toISOString()}
          WHERE project_id = ${ref.id} AND entity = 'preview-settings'
        `);
      }
    }
    const event: DomainEvent = {
      type: "file.changed",
      projectId: ref.id,
      payload: { path: relativePath, source: "external" },
    };
    await this.outbox.append(event);
    this.observedStates.set(itemKey, sampled.state);
    try { this.invalidator.invalidate(ref.id, [relativePath]); } catch {}
    try { this.observer?.observeExternalChange(ref.id, [relativePath]); } catch {}
  }

  private debounce(ref: ProjectRef, candidate: string): void {
    const itemKey = `${ref.id}\u0000${candidate}`;
    const prior = this.pending.get(itemKey);
    if (prior) clearTimeout(prior);
    this.pending.set(itemKey, setTimeout(() => {
      this.pending.delete(itemKey);
      void this.observeCandidate(ref, candidate).catch(() => this.debounce(ref, candidate));
    }, this.debounceMs));
  }

  private open(ref: ProjectRef): void {
    if (this.closed) return;
    let watcher: FSWatcher;
    try {
      watcher = this.watchFactory(ref.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const relative = String(filename).split(path.sep).join("/");
        if (relative === path.basename(ref.root)) return;
        if (relative.split("/").some((part) => [".git", ".hyperframes", "node_modules"].includes(part))) return;
        const basename = path.posix.basename(relative);
        if (basename.startsWith(".") && basename.endsWith(".tmp")) return;
        if (isMutationArtifact(basename)) return;
        this.debounce(ref, relative);
      });
    } catch {
      this.scheduleRestart(ref);
      return;
    }
    this.watchers.push(watcher);
    watcher.once("error", () => {
      watcher.close();
      const index = this.watchers.indexOf(watcher);
      if (index >= 0) this.watchers.splice(index, 1);
      this.scheduleRestart(ref);
    });
  }

  private scheduleRestart(ref: ProjectRef): void {
    if (this.closed) return;
    const timeout = setTimeout(() => {
      this.restarts.delete(timeout);
      this.open(ref);
    }, this.debounceMs);
    this.restarts.add(timeout);
  }
}
