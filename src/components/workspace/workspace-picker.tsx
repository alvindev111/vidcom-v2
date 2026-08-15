"use client";

import * as React from "react";

import {
  canLoadMore,
  currentToken,
  EMPTY_PICKER,
  pickerReducer,
  type PickerCrumb,
  type PickerEntry,
} from "@/lib/workspace-picker/state";

export interface WorkspacePickerApi {
  roots(): Promise<readonly PickerCrumb[]>;
  list(token: string, cursor?: string): Promise<{ entries: readonly PickerEntry[]; cursor?: string }>;
  createDirectory(parentToken: string, name: string): Promise<PickerEntry>;
  activate(selectionToken: string): Promise<void>;
}

function messageFor(cause: unknown): { code: string; message: string } {
  const detail = (cause as { code?: string; message?: string } | null) ?? {};
  return {
    code: detail.code ?? "unknown",
    message: detail.message ?? "The folder could not be opened.",
  };
}

/**
 * Chooses the workspace directory, using tokens rather than typed paths.
 *
 * Every step goes through a token minted by the server. There is no text field
 * for a path on purpose: a path a user can type is a path any page can send,
 * and the whole point of the browse is that the server only ever acts on
 * directories it handed out itself.
 */
export function WorkspacePicker({ api }: { api: WorkspacePickerApi }): React.JSX.Element {
  const [state, dispatch] = React.useReducer(pickerReducer, EMPTY_PICKER);
  const [newFolder, setNewFolder] = React.useState("");

  const run = React.useCallback(async (work: () => Promise<void>) => {
    dispatch({ kind: "loading" });
    try {
      await work();
    } catch (cause) {
      const detail = messageFor(cause);
      dispatch({ kind: "failed", ...detail });
    }
  }, []);

  const loadRoots = React.useCallback(() => run(async () => {
    dispatch({ kind: "roots", roots: await api.roots() });
  }), [api, run]);

  React.useEffect(() => { void loadRoots(); }, [loadRoots]);

  const enter = (entry: PickerEntry) => {
    if (!entry.token) return;
    void run(async () => {
      const page = await api.list(entry.token!);
      dispatch({
        kind: "entered",
        crumb: { label: entry.name, token: entry.token! },
        entries: page.entries,
        ...page.cursor === undefined ? {} : { cursor: page.cursor },
      });
    });
  };

  const ascend = (crumb: PickerCrumb) => void run(async () => {
    const page = await api.list(crumb.token);
    dispatch({
      kind: "ascended",
      token: crumb.token,
      entries: page.entries,
      ...page.cursor === undefined ? {} : { cursor: page.cursor },
    });
  });

  const loadMore = () => {
    const token = currentToken(state);
    if (!token || !state.cursor) return;
    void run(async () => {
      const page = await api.list(token, state.cursor);
      dispatch({
        kind: "appended",
        entries: page.entries,
        ...page.cursor === undefined ? {} : { cursor: page.cursor },
      });
    });
  };

  const create = () => {
    const token = currentToken(state);
    if (!token || newFolder.trim().length === 0) return;
    void run(async () => {
      dispatch({ kind: "created", entry: await api.createDirectory(token, newFolder.trim()) });
      setNewFolder("");
    });
  };

  const selected = currentToken(state);

  return (
    <section aria-label="Choose a workspace folder" className="flex flex-col gap-3 p-4">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" onClick={() => void loadRoots()} className="underline">
          All locations
        </button>
        {state.crumbs.map((crumb) => (
          <button key={crumb.token} type="button" onClick={() => ascend(crumb)} className="underline">
            {`/ ${crumb.label}`}
          </button>
        ))}
      </nav>

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">{state.error.message}</p>
      ) : null}

      <ul className="flex flex-col">
        {state.entries.map((entry) => (
          <li key={`${entry.name}:${entry.token ?? "file"}`}>
            <button
              type="button"
              disabled={!entry.isDirectory || state.loading}
              onClick={() => { enter(entry); }}
              className="w-full px-2 py-1 text-left disabled:opacity-60"
            >
              {entry.isDirectory ? `📁 ${entry.name}` : entry.name}
            </button>
          </li>
        ))}
      </ul>

      {canLoadMore(state) ? (
        <button type="button" onClick={loadMore} className="self-start underline">
          Show more
        </button>
      ) : null}

      {selected ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="New folder name"
            value={newFolder}
            onChange={(event) => { setNewFolder(event.target.value); }}
            className="border px-2 py-1"
          />
          <button type="button" onClick={create} disabled={state.loading}>
            Create folder
          </button>
          <button
            type="button"
            disabled={state.loading}
            onClick={() => void run(async () => { await api.activate(selected); })}
          >
            Use this folder
          </button>
        </div>
      ) : null}
    </section>
  );
}
