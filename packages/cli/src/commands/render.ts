import { randomUUID } from "node:crypto";

import type { DaemonClient, DaemonJob } from "@vidcom/adapter";

import { CliInputError } from "../cli-error";

export interface RenderCommandOptions {
  target: string;
  workspace?: string;
  detach?: boolean;
  preset?: string;
}

/**
 * How `--workspace` is described to the user.
 *
 * Said out loud because the opposite used to be true: resolving a workspace
 * wrote it back as the active one, so a single `render --workspace X` silently
 * changed which workspace the UI opened next.
 */
export const RENDER_WORKSPACE_HELP =
  "--workspace <path>  Render from this workspace. Does not change the workspace the app opens.";

const PROJECT_ID = /^project_[0-9a-f-]{36}$/u;

/**
 * Decides whether the argument is an id or a slug, once.
 *
 * Never "try it as an id, then fall back to a slug": a project whose slug
 * happens to look like an id would be looked up twice and the second answer
 * would win, and a typo in an id would silently render a different project.
 */
export function isProjectId(target: string): boolean {
  return PROJECT_ID.test(target);
}

export function parseRenderCommandArgs(argv: readonly string[]): RenderCommandOptions {
  let target: string | undefined;
  const options: Partial<RenderCommandOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (!flag.startsWith("--")) {
      if (target !== undefined) throw new CliInputError("render takes one project");
      target = flag;
      continue;
    }
    if (flag === "--detach") {
      if (options.detach) throw new CliInputError("--detach may be provided only once");
      options.detach = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag !== "--workspace" && flag !== "--preset") {
      throw new CliInputError(`unknown render argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) throw new CliInputError(`${flag} requires a value`);
    if (flag === "--workspace") {
      if (options.workspace !== undefined) throw new CliInputError("--workspace may be provided only once");
      options.workspace = value;
    } else {
      if (options.preset !== undefined) throw new CliInputError("--preset may be provided only once");
      options.preset = value;
    }
    index += 1;
  }
  if (target === undefined) throw new CliInputError("render requires a project id or slug");
  return { target, ...options };
}

export const RENDER_EXIT = {
  succeeded: 0,
  failed: 1,
  input: 2,
  interrupted: 130,
} as const;

/**
 * Refuses to guess which workspace to render from.
 *
 * The resolver's last branch is "the working directory, with nothing in it that
 * says it is a workspace". For the UI that is a reasonable place to start
 * looking; for a render it would write output into whatever directory the user
 * happened to be standing in.
 */
export function assertRenderableWorkspace(source: string): void {
  if (source === "cwd") {
    throw new CliInputError(
      "refusing to render from the current directory: it is not a workspace."
      + " Pass --workspace, or run from inside one.",
    );
  }
}

/** A fresh key per invocation: two identical renders are two renders. */
export function renderIdempotencyKey(): string {
  return `render_${randomUUID()}`;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export interface RenderIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface RenderRunOptions {
  client: DaemonClient;
  projectId: string;
  options: RenderCommandOptions;
  io?: RenderIo;
  /** Resolves when the user asks to stop; resolving twice means "stop waiting". */
  interrupts?: AsyncIterable<void>;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function exitCodeForJob(job: DaemonJob): number {
  if (job.status === "succeeded") return RENDER_EXIT.succeeded;
  if (job.status === "cancelled") return RENDER_EXIT.interrupted;
  return RENDER_EXIT.failed;
}

/**
 * Enqueues a render and, unless detached, waits for it.
 *
 * The first interrupt asks the daemon to cancel and keeps waiting, because a
 * render that is cancelling still has files to clean up and a job row to
 * finish. The second stops waiting: a user who presses Ctrl+C twice is telling
 * this process to go away, not the daemon.
 */
export async function runRender(input: RenderRunOptions): Promise<number> {
  const io = input.io ?? { stdout: process.stdout, stderr: process.stderr };
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = input.pollMs ?? 500;

  const { jobId } = await input.client.enqueueRender(input.projectId, {
    projectId: input.projectId,
    idempotencyKey: renderIdempotencyKey(),
    ...(input.options.preset === undefined ? {} : { renderPresetId: input.options.preset }),
  });

  if (input.options.detach) {
    // The id is the whole output of a detached render, so it goes to stdout
    // clean enough to be captured by a shell.
    io.stdout.write(`${jobId}\n`);
    return RENDER_EXIT.succeeded;
  }

  let interrupts = 0;
  let stopWaiting = false;
  // The iterator is held rather than consumed by `for await`, so it can be
  // closed when the render ends. The real one is an endless generator over
  // SIGINT: abandoning it leaves the signal handler installed for the rest of
  // the process, which is a leak in a long-lived host and a surprise in tests.
  const signals = input.interrupts?.[Symbol.asyncIterator]();
  const watch = (async () => {
    if (!signals) return;
    for (;;) {
      const next = await signals.next();
      if (next.done === true) return;
      interrupts += 1;
      if (interrupts === 1) {
        io.stderr.write("cancelling the render; press Ctrl+C again to stop waiting\n");
        await input.client.cancelJob(jobId).catch(() => undefined);
        continue;
      }
      stopWaiting = true;
      return;
    }
  })();

  try {
    for (;;) {
      const job = await input.client.getJob(jobId);
      if (TERMINAL.has(job.status)) return exitCodeForJob(job);
      if (stopWaiting) return RENDER_EXIT.interrupted;
      await sleep(pollMs);
    }
  } finally {
    // Asked to close, never awaited. An async generator suspended on a promise
    // that never settles — which is exactly what waiting for the next Ctrl+C
    // is — cannot be resumed by `return()`, so awaiting it would hang the very
    // exit this is cleaning up for. Whoever owns the signal handler removes it;
    // this only says it is done listening.
    void signals?.return?.(undefined);
    void watch.catch(() => undefined);
  }
}


/**
 * The whole command: find the daemon, name the project, run the render.
 *
 * Every network call goes through `DaemonClient`. There is no second HTTP
 * client here, and that is the reason J depends on I: the closed surface is
 * what keeps `render` from growing its own idea of the daemon's API.
 */
export interface RenderCommandDependencies {
  connect(): Promise<{ client: DaemonClient; attachmentId: string }>;
  workspaceSource(): Promise<string>;
  io?: RenderIo;
  interrupts?: AsyncIterable<void>;
}

export async function runRenderCommand(
  argv: readonly string[],
  dependencies: RenderCommandDependencies,
): Promise<number> {
  const options = parseRenderCommandArgs(argv);
  assertRenderableWorkspace(await dependencies.workspaceSource());

  const { client, attachmentId } = await dependencies.connect();
  try {
    const projectId = isProjectId(options.target)
      ? options.target
      : await resolveSlug(client, options.target);
    return await runRender({
      client,
      projectId,
      options,
      ...(dependencies.io === undefined ? {} : { io: dependencies.io }),
      ...(dependencies.interrupts === undefined ? {} : { interrupts: dependencies.interrupts }),
    });
  } finally {
    // Detached before returning even on failure: an attachment left behind
    // keeps an auto-started daemon alive for its full TTL after the client that
    // needed it has gone.
    await client.detach(attachmentId).catch(() => undefined);
  }
}

async function resolveSlug(client: DaemonClient, slug: string): Promise<string> {
  const listed = await client.invokeTool("list_projects", {}, { protocolVersion: "2026-07-28" }) as {
    projects?: Array<{ projectId?: string; id?: string; slug?: string }>;
  };
  const match = listed.projects?.find((project) => project.slug === slug);
  const projectId = match?.projectId ?? match?.id;
  if (projectId === undefined) throw new CliInputError(`no project in this workspace is named ${slug}`);
  return projectId;
}
