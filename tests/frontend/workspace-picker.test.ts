import {
  canLoadMore,
  currentToken,
  EMPTY_PICKER,
  pickerReducer,
  type PickerState,
} from "../../src/lib/workspace-picker/state";
import { describe, expect, it } from "vitest";

function reduce(state: PickerState, ...actions: Parameters<typeof pickerReducer>[1][]): PickerState {
  return actions.reduce(pickerReducer, state);
}

const ROOTS = [{ label: "/", token: "browse_root" }, { label: "/home/user", token: "browse_home" }];

describe("workspace picker state", () => {
  it("starts at the roots with no trail", () => {
    const state = pickerReducer(EMPTY_PICKER, { kind: "roots", roots: ROOTS });

    expect(state.crumbs).toEqual([]);
    expect(state.entries.map((entry) => entry.name)).toEqual(["/", "/home/user"]);
    expect(currentToken(state)).toBeNull();
  });

  it("lists directories before files", () => {
    const state = reduce(EMPTY_PICKER, {
      kind: "entered",
      crumb: { label: "user", token: "browse_home" },
      entries: [
        { name: "notes.txt", isDirectory: false },
        { name: "projects", isDirectory: true, token: "browse_projects" },
        { name: "archive", isDirectory: true, token: "browse_archive" },
      ],
    });

    // A folder buried among files is a folder the user has to hunt for.
    expect(state.entries.map((entry) => entry.name)).toEqual(["archive", "projects", "notes.txt"]);
  });

  it("tracks the trail as the user descends", () => {
    const state = reduce(EMPTY_PICKER,
      { kind: "roots", roots: ROOTS },
      { kind: "entered", crumb: { label: "user", token: "browse_home" }, entries: [] },
      { kind: "entered", crumb: { label: "projects", token: "browse_projects" }, entries: [] });

    expect(state.crumbs.map((crumb) => crumb.label)).toEqual(["user", "projects"]);
    expect(currentToken(state)).toBe("browse_projects");
  });

  it("truncates the trail at the crumb that was clicked", () => {
    const deep = reduce(EMPTY_PICKER,
      { kind: "entered", crumb: { label: "a", token: "browse_a" }, entries: [] },
      { kind: "entered", crumb: { label: "b", token: "browse_b" }, entries: [] },
      { kind: "entered", crumb: { label: "c", token: "browse_c" }, entries: [] });

    // Clicking three levels up must arrive there, not one level up.
    const state = pickerReducer(deep, { kind: "ascended", token: "browse_a", entries: [] });
    expect(state.crumbs.map((crumb) => crumb.label)).toEqual(["a"]);
  });

  it("appends a page rather than replacing the list", () => {
    const first = pickerReducer(EMPTY_PICKER, {
      kind: "entered",
      crumb: { label: "big", token: "browse_big" },
      entries: [{ name: "a", isDirectory: false }],
      cursor: "500",
    });
    const second = pickerReducer(first, {
      kind: "appended",
      entries: [{ name: "b", isDirectory: false }],
    });

    expect(second.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(second.cursor).toBe("500");
  });

  it("offers more only while a cursor exists and nothing is in flight", () => {
    const paged = pickerReducer(EMPTY_PICKER, {
      kind: "entered", crumb: { label: "big", token: "browse_big" }, entries: [], cursor: "500",
    });
    expect(canLoadMore(paged)).toBe(true);
    expect(canLoadMore(pickerReducer(paged, { kind: "loading" }))).toBe(false);
    expect(canLoadMore(EMPTY_PICKER)).toBe(false);
  });

  it("adds a created directory into the listing in order", () => {
    const state = reduce(EMPTY_PICKER,
      { kind: "entered", crumb: { label: "home", token: "browse_home" },
        entries: [{ name: "zebra", isDirectory: true, token: "browse_z" }] },
      { kind: "created", entry: { name: "alpha", isDirectory: true, token: "browse_a" } });

    expect(state.entries.map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
  });

  it("keeps what was already loaded when a step fails", () => {
    const loaded = pickerReducer(EMPTY_PICKER, {
      kind: "entered",
      crumb: { label: "home", token: "browse_home" },
      entries: [{ name: "projects", isDirectory: true, token: "browse_p" }],
    });
    const failed = pickerReducer(loaded, {
      kind: "failed", code: "path_permission_denied", message: "not allowed",
    });

    // Emptying the pane the user was reading turns one refused directory into
    // an apparently broken app.
    expect(failed.entries).toHaveLength(1);
    expect(failed.error?.code).toBe("path_permission_denied");
    expect(failed.loading).toBe(false);
  });

  it("clears a previous error when the next attempt starts", () => {
    const failed = pickerReducer(EMPTY_PICKER, {
      kind: "failed", code: "path_timeout", message: "took too long",
    });
    // Leaving it up during a retry shows a failure that is no longer happening.
    expect(pickerReducer(failed, { kind: "loading" }).error).toBeUndefined();
  });

  it("resets the trail when roots are reloaded", () => {
    const deep = reduce(EMPTY_PICKER,
      { kind: "entered", crumb: { label: "a", token: "browse_a" }, entries: [] },
      { kind: "roots", roots: ROOTS });

    expect(deep.crumbs).toEqual([]);
    expect(currentToken(deep)).toBeNull();
  });
});
