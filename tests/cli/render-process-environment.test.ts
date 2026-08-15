import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createInfrastructure } from "@vidcom/cli";
import type { AbsolutePath } from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("production render/snapshot process environment", () => {
  it("passes configured app-data and CA paths to a real child without leaking ambient secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-render-process-env-"));
    roots.push(root);
    const appDataRoot = path.join(root, "configured-app-data");
    const workspaceRoot = path.join(root, "workspace");
    const caBundlePath = path.join(root, "organisation-ca.pem");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(caBundlePath, "", "utf8");

    const infrastructure = createInfrastructure({
      appDataRoot,
      workspaceRoot: workspaceRoot as AbsolutePath,
      caBundlePath: caBundlePath as AbsolutePath,
    });

    const previous = {
      GH_KEY: process.env.GH_KEY,
      VIDCOM_APP_DATA: process.env.VIDCOM_APP_DATA,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    };
    process.env.GH_KEY = "must-not-reach-render-child";
    process.env.VIDCOM_APP_DATA = path.join(root, "ambient-app-data");
    process.env.NODE_EXTRA_CA_CERTS = path.join(root, "ambient-ca.pem");
    try {
      const result = await infrastructure.renderProcess.run({
        command: [
          process.execPath,
          "-e",
          `process.stdout.write(JSON.stringify({
            VIDCOM_APP_DATA: process.env.VIDCOM_APP_DATA,
            NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
            GH_KEY: process.env.GH_KEY,
          }))`,
        ],
        environment: {
          VIDCOM_APP_DATA: path.join(root, "hostile-per-call-app-data"),
          NODE_EXTRA_CA_CERTS: path.join(root, "hostile-per-call-ca.pem"),
        },
      });

      expect(result.status).toBe("exited");
      if (result.status !== "exited") return;
      expect(result.output.exitCode).toBe(0);
      expect(JSON.parse(result.output.stdout)).toEqual({
        VIDCOM_APP_DATA: appDataRoot,
        NODE_EXTRA_CA_CERTS: caBundlePath,
      });
    } finally {
      await infrastructure.database.destroy();
      restoreEnvironment("GH_KEY", previous.GH_KEY);
      restoreEnvironment("VIDCOM_APP_DATA", previous.VIDCOM_APP_DATA);
      restoreEnvironment("NODE_EXTRA_CA_CERTS", previous.NODE_EXTRA_CA_CERTS);
    }
  });
});
