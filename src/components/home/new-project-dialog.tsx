"use client";

import * as React from "react";

import {
  canSubmit,
  EMPTY_DRAFT,
  newProjectReducer,
  PRESET_IDS,
  type PresetId,
} from "@/lib/new-project/state";

export interface NewProjectApi {
  create(input: { name: string; presetId: PresetId }): Promise<{ slug: string }>;
}

const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  "vertical-shorts": "Vertical — Shorts, Reels, TikTok",
  "horizontal-youtube": "Horizontal — YouTube",
  custom: "Custom size",
};

/**
 * Creates an empty project: a name and a preset, and nothing else.
 *
 * No file upload, no folder management, no agent generation. Each of those is
 * an entire surface with its own failure modes, and offering a half of one here
 * would promise something the dialog cannot finish.
 */
export function NewProjectDialog({
  api,
  onCreated,
}: {
  api: NewProjectApi;
  onCreated(slug: string): void;
}): React.JSX.Element {
  const [state, dispatch] = React.useReducer(newProjectReducer, EMPTY_DRAFT);

  const submit = () => {
    // Guarded here as well as on the button: a keyboard submit does not go
    // through the disabled attribute.
    if (!canSubmit(state)) return;
    dispatch({ kind: "submitting" });
    void api.create({ name: state.draft.name.trim(), presetId: state.draft.presetId })
      .then((created) => {
        dispatch({ kind: "created", slug: created.slug });
        onCreated(created.slug);
      })
      .catch((cause: unknown) => {
        const detail = (cause as { code?: string; message?: string } | null) ?? {};
        dispatch({
          kind: "failed",
          code: detail.code ?? "unknown",
          message: detail.message ?? "The project could not be created.",
        });
      });
  };

  return (
    <form
      aria-label="New video"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      className="flex flex-col gap-3 p-4"
    >
      <label className="flex flex-col gap-1">
        <span className="text-sm">Name</span>
        <input
          value={state.draft.name}
          onChange={(event) => { dispatch({ kind: "edited", draft: { name: event.target.value } }); }}
          className="border px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm">Format</span>
        <select
          value={state.draft.presetId}
          onChange={(event) => {
            dispatch({ kind: "edited", draft: { presetId: event.target.value as PresetId } });
          }}
          className="border px-2 py-1"
        >
          {PRESET_IDS.map((preset) => (
            <option key={preset} value={preset}>{PRESET_LABELS[preset]}</option>
          ))}
        </select>
      </label>

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">{state.error.message}</p>
      ) : null}

      <button type="submit" disabled={!canSubmit(state)} className="self-start disabled:opacity-60">
        {state.submitting ? "Creating…" : "Create video"}
      </button>
    </form>
  );
}
