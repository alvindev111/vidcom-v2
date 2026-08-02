import { describe, expect, it } from "vitest";

import type { GrantBinding } from "@vidcom/core";
import type { RegistryApprovalDependencies } from "@vidcom/mcp";

describe("registry approval boundary", () => {
  it("exposes request without an admin issue or revoke capability", async () => {
    const calls: GrantBinding[] = [];
    const dependencies: RegistryApprovalDependencies = {
      approvals: {
        async request(binding) {
          calls.push(binding);
          return "grant_request";
        },
      },
    };
    expect(Object.keys(dependencies.approvals)).toEqual(["request"]);
    expect("issue" in dependencies.approvals).toBe(false);
    expect("revoke" in dependencies.approvals).toBe(false);
    expect(calls).toEqual([]);
  });
});
