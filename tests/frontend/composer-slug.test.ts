import { generateStaticParams } from "../../src/app/projects/[slug]/page";
import { projectSlugFromPath } from "../../src/app/projects/[slug]/composer-client";
import { SHELL_SENTINEL } from "../../src/app/projects/[slug]/shell-sentinel";
import { describe, expect, it } from "vitest";

describe("composer route in a static export", () => {
  it("emits exactly one shell rather than a page per project", () => {
    // Project slugs are created by users long after the build, so there is
    // nothing else the export could enumerate.
    expect(generateStaticParams()).toEqual([{ slug: SHELL_SENTINEL }]);
  });

  it("reads the slug from the address bar", () => {
    expect(projectSlugFromPath("/projects/my-video")).toBe("my-video");
    expect(projectSlugFromPath("/projects/my-video/")).toBe("my-video");
  });

  it("decodes a slug that was percent-encoded in the URL", () => {
    expect(projectSlugFromPath("/projects/my%20video")).toBe("my video");
  });

  it("treats the sentinel as no project at all", () => {
    // Landing on the shell itself means nothing was chosen; fetching a project
    // called `__shell` would 404 in a way that looks like a missing project.
    expect(projectSlugFromPath(`/projects/${SHELL_SENTINEL}`)).toBeNull();
  });

  it.each([
    ["/", "the root"],
    ["/projects", "the list"],
    ["/projects/", "the list with a slash"],
    ["/projects/a/b", "a deeper path"],
    ["/other/my-video", "a different route"],
  ])("returns null for %s (%s)", (pathname) => {
    expect(projectSlugFromPath(pathname)).toBeNull();
  });
});
