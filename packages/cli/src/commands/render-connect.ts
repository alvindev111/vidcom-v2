import { statSync } from "node:fs";
import path from "node:path";

import {
  BridgeCredentialStore,
  DaemonDiscoveryStore,
  createDaemonClient,
  type DaemonClient,
} from "@vidcom/adapter";
import { resolveWorkspace, type AbsolutePath, type WorkspaceCandidate } from "@vidcom/core";

import { ensureDaemon } from "../bridge/ensure-daemon";
import { spawnEnsuredDaemon, waitForDaemonRecord } from "../bridge/spawn-daemon";
import { defaultAppDataRoot } from "../next-host";
import { CliInputError } from "../cli-error";
import { parseRenderCommandArgs } from "./render";
import { VIDCOM_VERSION } from "./version";

const IDENTITY_FILE = "vidcom.json";

function candidate(root: string): WorkspaceCandidate {
  const readable = (target: string) => {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  };
  const hasIdentityFile = (() => {
    try {
      return statSync(path.join(root, IDENTITY_FILE)).isFile();
    } catch {
      return false;
    }
  })();
  return {
    root: root as AbsolutePath,
    readable: readable(root),
    hasIdentityFile,
    parentReadable: readable(path.dirname(root)),
  };
}

/**
 * Which rule chose the workspace, so `render` can refuse the weakest one.
 *
 * The resolution itself is Core's decision table; this only supplies the
 * filesystem facts, and only for the two candidates a render can have. The
 * saved active workspace is deliberately not read here — `render` never writes
 * it back either (C.4), so consulting it would make the command depend on UI
 * state it refuses to change.
 */
export async function renderWorkspaceSource(argv: readonly string[]): Promise<string> {
  const options = parseRenderCommandArgs(argv);
  const explicit = options.workspace ?? process.env.VIDCOM_WORKSPACE;
  const resolution = resolveWorkspace({
    explicit: explicit === undefined ? null : candidate(path.resolve(explicit)),
    cwd: candidate(process.cwd()),
  });
  if (resolution.status === "error") throw new CliInputError(resolution.reason);
  return Promise.resolve(resolution.source);
}

export async function renderWorkspaceRoot(argv: readonly string[]): Promise<string> {
  const options = parseRenderCommandArgs(argv);
  const explicit = options.workspace ?? process.env.VIDCOM_WORKSPACE;
  const resolution = resolveWorkspace({
    explicit: explicit === undefined ? null : candidate(path.resolve(explicit)),
    cwd: candidate(process.cwd()),
  });
  if (resolution.status === "error") throw new CliInputError(resolution.reason);
  return Promise.resolve(resolution.root);
}

/**
 * Finds or starts the daemon for this workspace and attaches to it.
 *
 * Attached as `render`, not as `ui`: a render must not take away an auto-started
 * daemon's right to retire itself once the render is done.
 */
export async function connectRenderClient(argv: readonly string[]): Promise<{
  client: DaemonClient;
  attachmentId: string;
}> {
  const appDataRoot = defaultAppDataRoot();
  const workspaceRoot = await renderWorkspaceRoot(argv);
  const discovery = new DaemonDiscoveryStore(appDataRoot);
  const bearer = await new BridgeCredentialStore(appDataRoot).read().catch(() => null);
  if (bearer === null) {
    throw new CliInputError(
      "this machine has no system bridge credential yet; start the app once, or run `vidcom serve`",
    );
  }

  const connect = (record: { port: number }): DaemonClient => createDaemonClient({
    baseUrl: `http://127.0.0.1:${record.port}`,
    bearer,
  });

  const ensured = await ensureDaemon({
    workspaceRoot,
    kind: "render",
    clientVersion: VIDCOM_VERSION,
    readRecord: (root) => discovery.read(root),
    connect,
    spawnDaemon: (root) => {
      spawnEnsuredDaemon({ workspaceRoot: root });
      return Promise.resolve();
    },
    waitForRecord: (root) => waitForDaemonRecord(() => discovery.read(root)),
  });

  return { client: connect(ensured.record), attachmentId: ensured.attachmentId };
}
