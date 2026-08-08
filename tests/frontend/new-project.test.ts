import {
  canSubmit,
  draftProblem,
  EMPTY_DRAFT,
  newProjectReducer,
  PRESET_IDS,
} from "../../src/lib/new-project/state";
import { describe, expect, it } from "vitest";

describe("new project dialog state", () => {
  it("offers only the closed set of presets", () => {
    // Closed on purpose: an open preset list is a place for a value the render
    // pipeline has never seen.
    expect(PRESET_IDS).toEqual(["vertical-shorts", "horizontal-youtube", "custom"]);
  });

  it("cannot submit an empty or whitespace-only name", () => {
    expect(draftProblem({ name: "", presetId: "custom" })).toBe("empty-name");
    expect(draftProblem({ name: "   ", presetId: "custom" })).toBe("empty-name");
    expect(canSubmit(EMPTY_DRAFT)).toBe(false);
  });

  it("cannot submit a name past the server's limit", () => {
    expect(draftProblem({ name: "a".repeat(256), presetId: "custom" })).toBe("name-too-long");
    expect(draftProblem({ name: "a".repeat(255), presetId: "custom" })).toBeNull();
  });

  it("blocks a second submit while the first is in flight", () => {
    const ready = newProjectReducer(EMPTY_DRAFT, { kind: "edited", draft: { name: "My video" } });
    expect(canSubmit(ready)).toBe(true);

    const inFlight = newProjectReducer(ready, { kind: "submitting" });
    // A second click during the request is indistinguishable from the first,
    // and two clicks must not create two projects.
    expect(canSubmit(inFlight)).toBe(false);
  });

  it("lets the user retry after a rejected name", () => {
    const failed = newProjectReducer(
      newProjectReducer(
        newProjectReducer(EMPTY_DRAFT, { kind: "edited", draft: { name: "Taken" } }),
        { kind: "submitting" },
      ),
      { kind: "failed", code: "project_invalid", message: "that slug already exists" },
    );

    // A dialog stuck disabled after a rejection is a dialog the user has to
    // close and reopen.
    expect(failed.submitting).toBe(false);
    expect(canSubmit(failed)).toBe(true);
    expect(failed.error?.code).toBe("project_invalid");
  });

  it("clears the error as soon as the name changes", () => {
    const failed = newProjectReducer(EMPTY_DRAFT, {
      kind: "failed", code: "project_invalid", message: "that slug already exists",
    });
    // A message about the previous name is wrong the moment the name changes.
    expect(newProjectReducer(failed, { kind: "edited", draft: { name: "Another" } }).error)
      .toBeUndefined();
  });

  it("reports the created slug so the caller can navigate", () => {
    const created = newProjectReducer(EMPTY_DRAFT, { kind: "created", slug: "my-video" });
    expect(created.createdSlug).toBe("my-video");
    expect(created.submitting).toBe(false);
  });

  it("keeps the chosen preset while the name is edited", () => {
    const state = newProjectReducer(
      newProjectReducer(EMPTY_DRAFT, { kind: "edited", draft: { presetId: "vertical-shorts" } }),
      { kind: "edited", draft: { name: "Shorts clip" } },
    );
    expect(state.draft).toEqual({ name: "Shorts clip", presetId: "vertical-shorts" });
  });
});
