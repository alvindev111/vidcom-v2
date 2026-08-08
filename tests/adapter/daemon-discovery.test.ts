import { realpathSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DAEMON_RECORD_SCHEMA_VERSION,
  DaemonDiscoveryStore,
  workspaceHash,
  type DaemonRecord,
} from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appData(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-daemon-")));
  roots.push(root);
  return root;
}

function record(workspaceRoot: string, overrides: Partial<DaemonRecord> = {}): DaemonRecord {
  return {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    workspaceRoot,
    workspaceHash: workspaceHash(workspaceRoot),
    instanceId: "daemon_first",
    pid: 4321,
    host: "127.0.0.1",
    port: 43_127,
    startedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("daemon discovery store", () => {
  it("publishes a record a client can read back", async () => {
    const store = new DaemonDiscoveryStore(await appData());
    const published = record("/canonical/workspace");
    await store.publish(published);
    expect(await store.read("/canonical/workspace")).toEqual(published);
  });

  it("answers null when no daemon has published", async () => {
    // Absent is an ordinary answer here — it is what a client sees on a clean
    // machine, and it has to be distinguishable from a read failure.
    expect(await new DaemonDiscoveryStore(await appData()).read("/nothing/here")).toBeNull();
  });

  it("keeps the record out of reach of other users", async () => {
    const root = await appData();
    const store = new DaemonDiscoveryStore(root);
    await store.publish(record("/canonical/workspace"));
    const directory = path.join(root, "daemon");
    const [entry] = await readdir(directory);
    if (process.platform === "win32") return;
    expect(statSync(path.join(directory, entry as string)).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("carries no secret, no attachment count and no lease id", async () => {
    // The file only says "something is listening over there". Authority lives
    // in the credential file and in the database; publishing any of it here
    // would put it in the one file that exists to be read by anybody looking
    // for the daemon.
    const root = await appData();
    await new DaemonDiscoveryStore(root).publish(record("/canonical/workspace"));
    const directory = path.join(root, "daemon");
    const [entry] = await readdir(directory);
    const written = JSON.parse(await readFile(path.join(directory, entry as string), "utf8")) as
      Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([
      "host",
      "instanceId",
      "pid",
      "port",
      "schemaVersion",
      "startedAt",
      "workspaceHash",
      "workspaceRoot",
    ]);
  });

  it("leaves no temporary file behind", async () => {
    // A reader that globs the directory would otherwise find a half-written
    // record and treat it as a second daemon.
    const root = await appData();
    await new DaemonDiscoveryStore(root).publish(record("/canonical/workspace"));
    const entries = await readdir(path.join(root, "daemon"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("does not let an old daemon delete the record of the one that replaced it", async () => {
    // The slow shutdown of a previous daemon would otherwise make a perfectly
    // healthy replacement invisible, which is the hardest shape of this bug to
    // see: nothing is broken, nothing is logged, and nothing is found.
    const store = new DaemonDiscoveryStore(await appData());
    await store.publish(record("/canonical/workspace", { instanceId: "daemon_second" }));
    await store.remove("/canonical/workspace", "daemon_first");
    expect(await store.read("/canonical/workspace")).not.toBeNull();

    await store.remove("/canonical/workspace", "daemon_second");
    expect(await store.read("/canonical/workspace")).toBeNull();
  });

  it("removes nothing when there is nothing to remove", async () => {
    const store = new DaemonDiscoveryStore(await appData());
    await expect(store.remove("/canonical/workspace", "daemon_first")).resolves.toBeUndefined();
  });

  it("gives each workspace its own file", async () => {
    const root = await appData();
    const store = new DaemonDiscoveryStore(root);
    await store.publish(record("/one", { instanceId: "daemon_one", port: 1111 }));
    await store.publish(record("/two", { instanceId: "daemon_two", port: 2222 }));
    expect((await store.read("/one"))?.port).toBe(1111);
    expect((await store.read("/two"))?.port).toBe(2222);
    expect(await readdir(path.join(root, "daemon"))).toHaveLength(2);
  });

  it.each([
    ["a truncated write", "{\"schemaVersion\": 1, \"workspaceRoo"],
    ["a record for another workspace", JSON.stringify(record("/somewhere/else"))],
    ["a future schema", JSON.stringify(record("/canonical/workspace", { schemaVersion: 2 }))],
    ["a non-loopback host", JSON.stringify({ ...record("/canonical/workspace"), host: "0.0.0.0" })],
    ["a port outside the range", JSON.stringify({ ...record("/canonical/workspace"), port: 70_000 })],
  ])("treats %s as no daemon at all", async (_label, contents) => {
    // Every one of these would otherwise send a client at something that is not
    // the daemon it asked for, and every check after that would pass because it
    // would be talking to a real, healthy process.
    const root = await appData();
    const directory = path.join(root, "daemon");
    await mkdir(directory, { recursive: true });
    const hash = workspaceHash("/canonical/workspace").slice("sha256:".length);
    await writeFile(path.join(directory, `${hash}.json`), contents, "utf8");
    expect(await new DaemonDiscoveryStore(root).read("/canonical/workspace")).toBeNull();
  });
});
