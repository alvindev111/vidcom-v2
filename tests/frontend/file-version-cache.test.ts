import { describe, expect, it } from "vitest";

import { fileVersionMap } from "@/lib/studio/file-version-cache";

describe("fileVersionMap", () => {
  it("uses only the latest snapshot versions for numeric timing saves", () => {
    const first = fileVersionMap([
      { path: "index.html", version: "sha256:old" },
      { path: "compositions/one.html", version: "sha256:one" },
    ]);
    const refreshed = fileVersionMap([
      { path: "index.html", version: "sha256:new" },
      { path: "compositions/two.html", version: "sha256:two" },
    ]);

    expect(first.get("index.html")).toBe("sha256:old");
    expect(refreshed.get("index.html")).toBe("sha256:new");
    expect(refreshed.has("compositions/one.html")).toBe(false);
  });
});
