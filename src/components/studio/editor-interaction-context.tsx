"use client";

import * as React from "react";

import {
  createEditorInteractionState,
  type EditorInteractionState,
} from "@/lib/studio/editor-interaction";

interface EditorInteractionValue {
  interaction: EditorInteractionState;
  interactionRef: React.MutableRefObject<EditorInteractionState>;
  applyInteraction: (next: EditorInteractionState) => void;
}

const EditorInteractionContext = React.createContext<EditorInteractionValue | null>(null);

export function EditorInteractionProvider({ children }: { children: React.ReactNode }) {
  const [interaction, setInteraction] = React.useState(() =>
    createEditorInteractionState({ pixelsPerSecond: 1, snapEnabled: true }));
  const interactionRef = React.useRef(interaction);
  const applyInteraction = React.useCallback((next: EditorInteractionState) => {
    interactionRef.current = next;
    setInteraction(next);
  }, []);
  return (
    <EditorInteractionContext.Provider value={{ interaction, interactionRef, applyInteraction }}>
      {children}
    </EditorInteractionContext.Provider>
  );
}

export function useEditorInteraction(): EditorInteractionValue {
  const value = React.useContext(EditorInteractionContext);
  if (!value) throw new Error("useEditorInteraction must be used inside EditorInteractionProvider");
  return value;
}
