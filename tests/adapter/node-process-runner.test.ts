import { describe, expect, it } from "vitest";

import { allowlistedEnvironment } from "@vidcom/adapter";

describe("allowlistedEnvironment", () => {
  it("withholds every secret the daemon happens to be holding", () => {
    const environment = allowlistedEnvironment({
      PATH: "/usr/bin",
      NODE_ENV: "test",
      ELEVENLABS_API_KEY: "sk-live-secret",
      VIDCOM_MCP_TOKEN: "bearer-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "gh-secret",
    });

    // A Python sidecar's dependency tree is outside our control; anything it can
    // read it can also send somewhere.
    expect(environment).not.toHaveProperty("ELEVENLABS_API_KEY");
    expect(environment).not.toHaveProperty("VIDCOM_MCP_TOKEN");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(Object.values(environment).join(" ")).not.toContain("secret");
  });

  it("keeps what a process genuinely cannot start without", () => {
    const environment = allowlistedEnvironment({
      PATH: "/usr/bin",
      NODE_ENV: "test",
      HOME: "/home/dev",
      TEMP: "/tmp",
      SystemRoot: "C:\\Windows",
      LANG: "en_US.UTF-8",
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TEMP: "/tmp",
      SystemRoot: "C:\\Windows",
      LANG: "en_US.UTF-8",
    });
  });

  it("forces UTF-8 so a Vietnamese speaker name survives CPython on Windows", () => {
    const environment = allowlistedEnvironment({ PATH: "/usr/bin", NODE_ENV: "test" });

    expect(environment).toMatchObject({ PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });
  });

  it("lets the caller's own variables through and win", () => {
    const environment = allowlistedEnvironment(
      { PATH: "/usr/bin", NODE_ENV: "test", HF_HOME: "/wrong" },
      { HF_HOME: "/app-data/models", HF_HUB_DISABLE_TELEMETRY: "1" },
    );

    expect(environment).toMatchObject({
      HF_HOME: "/app-data/models",
      HF_HUB_DISABLE_TELEMETRY: "1",
    });
  });
});
