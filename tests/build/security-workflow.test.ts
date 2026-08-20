import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_ROOT = ".github/workflows";
const SECURITY_WORKFLOW = `${WORKFLOW_ROOT}/security.yml`;

describe("security and dependency policy", () => {
  it("pins every external GitHub Action and reusable workflow to an immutable commit", async () => {
    const names = (await readdir(WORKFLOW_ROOT)).filter((name) => name.endsWith(".yml"));
    for (const name of names) {
      const source = await readFile(`${WORKFLOW_ROOT}/${name}`, "utf8");
      for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
        const reference = match[1]!;
        if (reference.startsWith("./")) continue;
        expect(reference, `${name} has a mutable action reference`).toMatch(/@[0-9a-f]{40}$/u);
      }
    }
  });

  it("keeps CodeQL, lockfile CVE, secret, dependency, license and provenance gates dispatchable", async () => {
    const [workflow, manifest] = await Promise.all([
      readFile(SECURITY_WORKFLOW, "utf8"),
      readFile("package.json", "utf8").then((source) => JSON.parse(source) as { scripts: Record<string, string> }),
    ]);

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github/codeql-action/init@");
    expect(workflow).toContain("github/codeql-action/analyze@");
    expect(workflow).toContain("google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@");
    expect(workflow).toContain("trufflesecurity/trufflehog@");
    expect(workflow).toContain("extra_args: --results=verified,unknown --no-update");
    expect(workflow).not.toContain("--results=verified,unknown --fail");
    expect(workflow).toContain("actions/dependency-review-action@");
    expect(workflow).toContain("bun run test:licenses");
    expect(workflow).toContain("bun run test:provenance");
    expect(manifest.scripts["test:licenses"]).toContain("license-checker-rseidelsohn");
    expect(manifest.scripts["test:provenance"]).toContain("verify-dependency-provenance.mjs");
  });

  it("schedules both npm and GitHub Actions dependency updates", async () => {
    const policy = await readFile(".github/dependabot.yml", "utf8");
    expect(policy).toContain('package-ecosystem: "bun"');
    expect(policy).toContain('package-ecosystem: "github-actions"');
    expect(policy.match(/interval: "weekly"/gu)).toHaveLength(2);
  });
});
