import { allowlistedEnvironment } from "@vidcom/adapter";
import { describe, expect, it } from "vitest";



describe("node child CA bundle", () => {
  it("hands a configured bundle to every Node child", () => {
    // A frozen runtime carries no trust store of its own, so the bundle has to
    // be passed down. Nothing here disables verification or reads the OS store:
    // both turn a download failure into a silent one.
    expect(allowlistedEnvironment({ NODE_ENV: "test" }, {}, { caBundlePath: "/etc/ca.pem" }).NODE_EXTRA_CA_CERTS)
      .toBe("/etc/ca.pem");
  });

  it("sets nothing when none is configured", () => {
    expect(allowlistedEnvironment({ NODE_ENV: "test" }, {}).NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("treats an empty path as no bundle at all", () => {
    // To Node an empty value is not "no bundle", it is a bundle at path "" —
    // which fails every TLS handshake the child attempts.
    expect(allowlistedEnvironment({ NODE_ENV: "test" }, {}, { caBundlePath: "" }).NODE_EXTRA_CA_CERTS)
      .toBeUndefined();
  });

  it("never disables certificate verification", () => {
    const environment = allowlistedEnvironment({
      NODE_ENV: "test",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    }, {}, {
      caBundlePath: "/etc/ca.pem",
    });
    expect(environment.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});

describe("third-party telemetry", () => {
  it("turns off the HyperFrames invitation in every child", () => {
    // Measured at S9: with a clean HOME the first run prints a telemetry
    // invitation. A packaged app must not ask a question on behalf of a tool
    // the user never chose to install.
    const environment = allowlistedEnvironment({ NODE_ENV: "test" });
    expect(environment.HYPERFRAMES_NO_TELEMETRY).toBe("1");
    expect(environment.DO_NOT_TRACK).toBe("1");
  });

  it("uses the names the pinned CLI actually reads", async () => {
    // Read out of the shipped CLI rather than guessed: an environment variable
    // that nothing looks at is a setting that does nothing while looking like
    // it does.
    const { readFile } = await import("node:fs/promises");
    const cli = await readFile("node_modules/hyperframes/dist/cli.js", "utf8");
    expect(cli).toContain("HYPERFRAMES_NO_TELEMETRY");
    expect(cli).toContain("DO_NOT_TRACK");
  }, 60_000);
});

