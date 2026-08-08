import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  allowlistedEnvironment,
  defaultVieNeuCommand,
  vieneuInterpreterPath,
} from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const WINDOWS = process.platform === "win32";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Lays out an extraction root the way the runtime archives do. */
async function extractionRoot(options: { interpreter: boolean; worker: boolean }) {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-vieneu-")));
  roots.push(root);
  if (options.worker) {
    await mkdir(path.join(root, "vieneu"), { recursive: true });
    await writeFile(path.join(root, "vieneu", "worker.py"), "# worker\n", "utf8");
  }
  if (options.interpreter) {
    const directory = WINDOWS ? path.join(root, "python") : path.join(root, "python", "bin");
    await mkdir(directory, { recursive: true });
    const binary = path.join(directory, WINDOWS ? "python.exe" : "python3");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
    if (!WINDOWS) await chmod(binary, 0o755);
  }
  return root;
}

describe("VieNeu frozen interpreter", () => {
  it("runs the interpreter it shipped, by absolute path", async () => {
    const root = await extractionRoot({ interpreter: true, worker: true });
    const command = defaultVieNeuCommand(root);

    // Resolving `python3` through PATH inside an artifact would run whatever the
    // machine happens to have, which is exactly what freezing it prevents.
    expect(command[0]).toBe(vieneuInterpreterPath(root));
    expect(path.isAbsolute(command[0] ?? "")).toBe(true);
    expect(command[0]).not.toBe("python3");
    expect(command[0]).not.toBe("python");
    expect(command[1]).toBe(path.join(root, "vieneu", "worker.py"));
  });

  it("keeps the ambient interpreter when nothing has been extracted", async () => {
    const root = await extractionRoot({ interpreter: false, worker: true });
    expect(vieneuInterpreterPath(root)).toBeNull();
    // A source checkout has no frozen interpreter, and must still run.
    expect(defaultVieNeuCommand(root)[0]).toBe(WINDOWS ? "python" : "python3");
  });

  it("reports no interpreter when no extraction root is supplied at all", () => {
    expect(vieneuInterpreterPath()).toBeNull();
    expect(defaultVieNeuCommand()[0]).toBe(WINDOWS ? "python" : "python3");
  });
});

describe("sidecar environment", () => {
  it("forces UTF-8 over an inherited ANSI codepage", () => {
    // Measured on Windows: a frozen interpreter takes its encoding from the ANSI
    // codepage, and printing Vietnamese then raises UnicodeEncodeError. The
    // parent is where that codepage arrives from, so it must not win.
    const environment = allowlistedEnvironment({
      NODE_ENV: "test",
      PYTHONIOENCODING: "cp932",
      PYTHONUTF8: "0",
    } as unknown as NodeJS.ProcessEnv);
    expect(environment.PYTHONIOENCODING).toBe("utf-8");
    expect(environment.PYTHONUTF8).toBe("1");
  });

  it("still lets an explicit caller set the broken value, so the failure stays testable", () => {
    const environment = allowlistedEnvironment({ NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv, { PYTHONUTF8: "" });
    expect(environment.PYTHONUTF8).toBe("");
  });

  it("keeps forcing UTF-8 when the parent has no encoding at all", () => {
    const environment = allowlistedEnvironment({ NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv);
    expect(environment.PYTHONIOENCODING).toBe("utf-8");
    expect(environment.PYTHONUTF8).toBe("1");
  });
});
