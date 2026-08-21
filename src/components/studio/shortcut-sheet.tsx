"use client";

import * as React from "react";
import { KeyboardIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TRANSPORT_BINDINGS, keyComboLabel } from "@/lib/studio/transport-keys";

/**
 * The shortcut sheet (R8.6).
 *
 * Rendered from `TRANSPORT_BINDINGS`, the same list the key handler reads: a
 * separately maintained table is a table that eventually documents keys that no
 * longer do anything.
 */
export function ShortcutSheet() {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <KeyboardIcon className="size-3" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="bg-popover text-popover-foreground absolute right-0 bottom-8 z-50 w-64 rounded-md border p-2 shadow-md"
        >
          <ul className="flex flex-col gap-1">
            {TRANSPORT_BINDINGS.map((binding) => (
              <li key={binding.action} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate">{binding.label}</span>
                <span className="text-muted-foreground shrink-0 font-mono">
                  {binding.keys.map((combo) => keyComboLabel(combo)).join(" / ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
