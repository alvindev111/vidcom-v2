import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { VIDCOM_NODE_SENTINEL } from "@vidcom/adapter";
import {
  isNodeSentinel,
  NODE_SENTINEL,
  NodeSentinelError,
  parseVidcomCommand,
  runNodeSentinel,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeRoot(): Promise<string> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-sentinel-")));
  roots.push(root);
  await mkdir(path.join(root, "hyperframes"), { recursive: true });
  return root;
}

describe("node sentinel", () => {
  it("uses the same spelling as the spawn sites that depend on it", () => {
    // Two packages have to agree on this string and neither imports the other.
    expect(VIDCOM_NODE_SENTINEL).toBe(NODE_SENTINEL);
  });

  it("is claimed by the public parser as `vidcom app` when not dispatched first", () => {
    // The reason the sentinel must be handled before the parser: this is the
    // silent failure it exists to avoid, so it is asserted rather than assumed.
    expect(parseVidcomCommand([NODE_SENTINEL, "/somewhere/script.mjs"]))
      .toEqual({ name: "app", args: [NODE_SENTINEL, "/somewhere/script.mjs"] });
    expect(isNodeSentinel([NODE_SENTINEL, "/somewhere/script.mjs"])).toBe(true);
    expect(isNodeSentinel(["app", "--workspace", "/w"])).toBe(false);
  });

  it("runs a script inside the runtime root with node's argv shape", async () => {
    const root = await runtimeRoot();
    const script = path.join(root, "hyperframes", "cli.mjs");
    await writeFile(script, "export default 1;\n", "utf8");
    const seen: string[][] = [];

    await runNodeSentinel(
      [NODE_SENTINEL, script, "browser", "path"],
      root,
      () => { seen.push([...process.argv]); return Promise.resolve(); },
    );

    // Node's shape: execPath, script, then the script's own arguments. Leaving
    // the sentinel in would shift every downstream index by one.
    expect(seen[0]?.slice(1)).toEqual([script, "browser", "path"]);
    expect(seen[0]).not.toContain(NODE_SENTINEL);
  });

  it("restores process.argv even when the script throws", async () => {
    const root = await runtimeRoot();
    const script = path.join(root, "hyperframes", "cli.mjs");
    await writeFile(script, "export default 1;\n", "utf8");
    const before = [...process.argv];

    await expect(runNodeSentinel(
      [NODE_SENTINEL, script],
      root,
      () => Promise.reject(new Error("script exploded")),
    )).rejects.toThrow("script exploded");
    expect(process.argv).toEqual(before);
  });

  it("refuses a script outside the verified runtime root", async () => {
    const root = await runtimeRoot();
    const outside = path.join(path.dirname(root), "elsewhere.mjs");

    const failure = await runNodeSentinel([NODE_SENTINEL, outside], root, () => Promise.resolve())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeSentinelError);
    expect((failure as NodeSentinelError).code).toBe(ErrorCode.RuntimeManifestInvalid);
  });

  it("refuses a sibling directory whose name merely starts with the root", async () => {
    const root = await runtimeRoot();
    // `${root}-evil` starts with `${root}` as a string but is not inside it, so
    // a prefix comparison without the separator would let it through.
    const sibling = `${root}-evil${path.sep}script.mjs`;

    await expect(runNodeSentinel([NODE_SENTINEL, sibling], root, () => Promise.resolve()))
      .rejects.toBeInstanceOf(NodeSentinelError);
  });

  it("refuses a traversal that climbs back out of the root", async () => {
    const root = await runtimeRoot();
    const escape = path.join(root, "hyperframes", "..", "..", "escape.mjs");

    await expect(runNodeSentinel([NODE_SENTINEL, escape], root, () => Promise.resolve()))
      .rejects.toBeInstanceOf(NodeSentinelError);
  });

  it("requires a script path", async () => {
    const root = await runtimeRoot();
    await expect(runNodeSentinel([NODE_SENTINEL], root, () => Promise.resolve()))
      .rejects.toBeInstanceOf(NodeSentinelError);
  });
});
