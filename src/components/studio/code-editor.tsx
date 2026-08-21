"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { oneDarkTheme } from "@codemirror/theme-one-dark";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";

/** Language support per extension; anything else opens as plain text. */
function languageFor(path: string): Extension[] {
  switch (path.split(".").pop()?.toLowerCase()) {
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "js":
    case "mjs":
    case "ts":
      return [javascript({ typescript: path.endsWith(".ts") })];
    case "json":
      return [json()];
    default:
      return [];
  }
}

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px" },
  ".cm-scroller": {
    fontFamily: "var(--font-geist-mono, ui-monospace, monospace)",
    lineHeight: "18px",
  },
  ".cm-gutters": { color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
});

const lightHighlight = HighlightStyle.define([
  { tag: [tags.meta, tags.comment], color: "#52525b" },
  { tag: [tags.keyword, tags.operator, tags.tagName], color: "#b91c1c" },
  { tag: [tags.attributeName, tags.propertyName, tags.typeName, tags.className], color: "#6d28d9" },
  { tag: [tags.string, tags.regexp, tags.escape], color: "#166534" },
  { tag: [tags.atom, tags.bool, tags.number], color: "#1d4ed8" },
  { tag: [tags.variableName, tags.name], color: "#18181b" },
  { tag: [tags.heading, tags.link], color: "#0f766e", textDecoration: "underline" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: [tags.meta, tags.comment], color: "#a1a1aa" },
  { tag: [tags.keyword, tags.operator, tags.tagName], color: "#fca5a5" },
  { tag: [tags.attributeName, tags.propertyName, tags.typeName, tags.className], color: "#c4b5fd" },
  { tag: [tags.string, tags.regexp, tags.escape], color: "#86efac" },
  { tag: [tags.atom, tags.bool, tags.number], color: "#93c5fd" },
  { tag: [tags.variableName, tags.name], color: "#f4f4f5" },
  { tag: [tags.heading, tags.link], color: "#5eead4", textDecoration: "underline" },
]);

/**
 * CodeMirror 6 mounted imperatively.
 *
 * The view owns its own DOM and document state, so it is created once per open
 * file and fed changes through compartments rather than being re-rendered — a
 * React-controlled value would fight the editor for the cursor on every
 * keystroke.
 */
export function CodeEditor({
  path,
  /** Content as loaded from disk; changing it reloads the document. */
  initialCode,
  onChange,
  onSave,
}: {
  path: string;
  initialCode: string;
  onChange: (code: string) => void;
  /** Cmd/Ctrl+S — the same action as the Save button. */
  onSave: () => void;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const view = React.useRef<EditorView | null>(null);
  const themeSlot = React.useRef(new Compartment());
  const { resolvedTheme } = useTheme();

  // Latest callbacks, so the editor never has to be rebuilt to pick them up.
  const handlers = React.useRef({ onChange, onSave });
  React.useEffect(() => {
    handlers.current = { onChange, onSave };
  });

  React.useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialCode,
        extensions: [
          basicSetup,
          ...languageFor(path),
          editorTheme,
          EditorView.contentAttributes.of({ "aria-label": `Code editor for ${path}` }),
          themeSlot.current.of([]),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                handlers.current.onSave();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              handlers.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });

    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // Rebuilt per file: a new path means new language support and a new document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // The file was rewritten on disk (agent edit, or a save came back) — replace
  // the document rather than the whole editor so scroll position survives.
  React.useEffect(() => {
    const instance = view.current;
    if (!instance || instance.state.doc.toString() === initialCode) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: initialCode },
    });
  }, [initialCode]);

  React.useEffect(() => {
    view.current?.dispatch({
      effects: themeSlot.current.reconfigure(
        resolvedTheme === "dark"
          ? [oneDarkTheme, syntaxHighlighting(darkHighlight)]
          : [syntaxHighlighting(lightHighlight)],
      ),
    });
  }, [resolvedTheme]);

  return <div ref={host} className="h-full overflow-hidden" />;
}
