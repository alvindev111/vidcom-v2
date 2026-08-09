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

