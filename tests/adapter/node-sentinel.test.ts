import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RuntimeAssetManager, VIDCOM_NODE_SENTINEL } from "@vidcom/adapter";
import {
  isNodeSentinel,
  NODE_SENTINEL,
  NodeSentinelError,
  parseVidcomCommand,
  resolveVerifiedHyperframesRoot,
  runNodeSentinel,
  runVidcomCli,
} from "@vidcom/cli";
import { ErrorCode } from "@vidcom/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { archiveFor, assetSource, runtimeManifest } from "../support/runtime-fixture";

const roots: string[] = [];
const originalEnvironment = {
  VIDCOM_APP_DATA: process.env.VIDCOM_APP_DATA,
  VIDCOM_SETTINGS: process.env.VIDCOM_SETTINGS,
};

function restoreEnvironment(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  restoreEnvironment("VIDCOM_APP_DATA");
  restoreEnvironment("VIDCOM_SETTINGS");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The async `realpath`, matching what the sentinel itself calls. On Windows the
// two disagree: the sync one leaves an 8.3 short name like `RUNNER~1` in place
// while the async one returns the long form, so a test built on `realpathSync`
// compares two spellings of the same directory and fails only there.
async function temporaryRoot(prefix = "vidcom-sentinel-"): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function runtimeRoot(): Promise<string> {
  const container = await temporaryRoot();
  const root = path.join(container, "runtime");
  await mkdir(path.join(root, "hyperframes"), { recursive: true });
  return root;
}

async function installHyperframes(
  appDataRoot: string,
  artifactVersion: string,
  scriptBody = "export default 1;\n",
  target = "hyperframes",
): Promise<{ root: string; script: string; marker: string }> {
  const scriptPath = "bin/hyperframes.mjs";
  const { archive, bytes } = archiveFor(
    "hyperframes",
    [{ path: scriptPath, content: Buffer.from(scriptBody, "utf8") }],
    undefined,
    target,
  );
  const manifest = runtimeManifest(artifactVersion, [archive]);
  const installation = await new RuntimeAssetManager({
    appDataRoot,
    source: assetSource(manifest, { hyperframes: bytes }),
  }).ensureAll();
  const root = installation.archiveRoots.hyperframes;
  if (!root) throw new Error("fixture did not install the hyperframes archive");
  return {
    root,
    script: path.join(root, scriptPath),
    marker: path.join(root, `.ready-${archive.sha256.slice("sha256:".length)}`),
  };
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
    await writeFile(outside, "export default 1;\n", "utf8");

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
    await mkdir(path.dirname(sibling), { recursive: true });
    await writeFile(sibling, "export default 1;\n", "utf8");

    await expect(runNodeSentinel([NODE_SENTINEL, sibling], root, () => Promise.resolve()))
      .rejects.toBeInstanceOf(NodeSentinelError);
  });

  it("refuses a traversal that climbs back out of the root", async () => {
    const root = await runtimeRoot();
    const escape = path.join(root, "hyperframes", "..", "..", "escape.mjs");
    await writeFile(escape, "export default 1;\n", "utf8");

    await expect(runNodeSentinel([NODE_SENTINEL, escape], root, () => Promise.resolve()))
      .rejects.toBeInstanceOf(NodeSentinelError);
  });

  it("resolves real paths before containment so a symlink cannot escape", async () => {
    const root = await runtimeRoot();
    const outside = path.join(path.dirname(root), "outside");
    const script = path.join(outside, "escape.mjs");
    await mkdir(outside);
    await writeFile(script, "export default 1;\n", "utf8");
    const linked = path.join(root, "hyperframes", "linked");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");

    const failure = await runNodeSentinel(
      [NODE_SENTINEL, path.join(linked, "escape.mjs")],
      root,
      () => Promise.resolve(),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeSentinelError);
    expect((failure as NodeSentinelError).code).toBe(ErrorCode.RuntimeManifestInvalid);
  });

  it("reports a nonexistent script as a coded manifest error", async () => {
    const root = await runtimeRoot();
    const failure = await runNodeSentinel(
      [NODE_SENTINEL, path.join(root, "hyperframes", "missing.mjs")],
      root,
      () => Promise.resolve(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NodeSentinelError);
    expect((failure as NodeSentinelError).code).toBe(ErrorCode.RuntimeManifestInvalid);
  });

  it("requires a script path", async () => {
    const root = await runtimeRoot();
    await expect(runNodeSentinel([NODE_SENTINEL], root, () => Promise.resolve()))
      .rejects.toBeInstanceOf(NodeSentinelError);
  });

  it("uses configured app-data and dispatches before the parser without bootstrapping", async () => {
    const container = await temporaryRoot("vidcom-sentinel-wiring-");
    const appDataRoot = path.join(container, "configured-app-data");
    const output = path.join(container, "sentinel-output.json");
    const installed = await installHyperframes(
      appDataRoot,
      "1.2.3",
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(1)), "utf8");',
        "",
      ].join("\n"),
    );
    const settings = path.join(container, "setting.json");
    await writeFile(settings, `${JSON.stringify({ appDataRoot })}\n`, "utf8");
    process.env.VIDCOM_SETTINGS = settings;
    delete process.env.VIDCOM_APP_DATA;

    await runVidcomCli([NODE_SENTINEL, installed.script, output]);

    expect(JSON.parse(await readFile(output, "utf8"))).toEqual([
      await realpath(installed.script),
      output,
    ]);
    await expect(access(path.join(appDataRoot, "vidcom.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(appDataRoot, "daemon"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("trusts only the hyperframes root selected by current.json", async () => {
    const appDataRoot = await temporaryRoot("vidcom-sentinel-current-");
    const old = await installHyperframes(appDataRoot, "1.0.0");
    const current = await installHyperframes(appDataRoot, "2.0.0");

    const trustedRoot = await resolveVerifiedHyperframesRoot(appDataRoot);
    expect(trustedRoot.path).toBe(await realpath(current.root));
    await expect(runNodeSentinel([NODE_SENTINEL, old.script], trustedRoot, () => Promise.resolve()))
      .rejects.toBeInstanceOf(NodeSentinelError);
  });

  it("rejects a verified root path retargeted to an external directory before import", async () => {
    const appDataRoot = await temporaryRoot("vidcom-sentinel-retarget-");
    const installed = await installHyperframes(appDataRoot, "1.0.0");
    const authority = await resolveVerifiedHyperframesRoot(appDataRoot);
    const displacedRoot = `${installed.root}.displaced`;
    const externalRoot = path.join(appDataRoot, "external-hyperframes");
    const externalScript = path.join(externalRoot, "bin", "hyperframes.mjs");
    await rename(installed.root, displacedRoot);
    await mkdir(path.dirname(externalScript), { recursive: true });
    await writeFile(externalScript, "export default 'external';\n", "utf8");
    await symlink(externalRoot, installed.root, process.platform === "win32" ? "junction" : "dir");
    const before = [...process.argv];
    let imported = false;

    const failure = await runNodeSentinel(
      [NODE_SENTINEL, path.join(installed.root, "bin", "hyperframes.mjs")],
      authority,
      () => {
        imported = true;
        return Promise.resolve();
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NodeSentinelError);
    expect((failure as NodeSentinelError).code).toBe(ErrorCode.RuntimeManifestInvalid);
    expect(imported).toBe(false);
    expect(process.argv).toEqual(before);
  });

  it("resolves the hyperframes target declared by the current installed manifest", async () => {
    const appDataRoot = await temporaryRoot("vidcom-sentinel-target-");
    const installed = await installHyperframes(
      appDataRoot,
      "1.0.0",
      "export default 1;\n",
      "toolchain/hyperframes",
    );

    expect((await resolveVerifiedHyperframesRoot(appDataRoot)).path)
      .toBe(await realpath(installed.root));
    expect(installed.root).toContain(path.join("toolchain", "hyperframes"));
  });

  it("requires the current hyperframes archive's matching ready marker", async () => {
    const appDataRoot = await temporaryRoot("vidcom-sentinel-marker-");
    const installed = await installHyperframes(appDataRoot, "1.0.0");
    await rm(installed.marker);

    const failure = await resolveVerifiedHyperframesRoot(appDataRoot)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeSentinelError);
    expect((failure as NodeSentinelError).code).toBe(ErrorCode.RuntimeManifestInvalid);
  });
});
