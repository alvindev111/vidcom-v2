"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type FileCrudIntent =
  | { action: "create"; kind: "file" | "folder" }
  | { action: "rename"; path: string }
  | { action: "delete"; path: string };

export function FileCrudDialog({
  intent,
  value,
  onValueChange,
  onOpenChange,
  onRestoreFocus,
  onSubmit,
}: {
  intent: FileCrudIntent | null;
  value: string;
  onValueChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onRestoreFocus: () => void;
  onSubmit: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const submitRef = React.useRef<HTMLButtonElement>(null);
  const copy = dialogCopy(intent);
  const trimmed = value.trim();
  const disabled = intent?.action !== "delete"
    && (trimmed.length === 0 || (intent?.action === "rename" && trimmed === intent.path));

  return (
    <Dialog open={intent !== null} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (intent?.action === "delete") submitRef.current?.focus();
          else inputRef.current?.select();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled) onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          {intent?.action !== "delete" ? (
            <div className="grid gap-2">
              <Label htmlFor="file-crud-path">Project-relative path</Label>
              <Input
                ref={inputRef}
                id="file-crud-path"
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
                autoComplete="off"
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              ref={submitRef}
              type="submit"
              variant={intent?.action === "delete" ? "destructive" : "default"}
              disabled={disabled}
            >
              {copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function dialogCopy(intent: FileCrudIntent | null): { title: string; description: string; submit: string } {
  if (intent?.action === "create") {
    return {
      title: `Create ${intent.kind}`,
      description: `Enter a project-relative path for the new ${intent.kind}.`,
      submit: intent.kind === "file" ? "Create file" : "Create folder",
    };
  }
  if (intent?.action === "rename") {
    return {
      title: "Rename selected entry",
      description: `Enter a new project-relative path for ${intent.path}.`,
      submit: "Rename",
    };
  }
  if (intent?.action === "delete") {
    return {
      title: `Delete ${intent.path.split("/").at(-1) ?? intent.path}?`,
      description: `Delete ${intent.path}? This operation creates a backup.`,
      submit: "Delete",
    };
  }
  return { title: "Project file", description: "Manage a project file.", submit: "Continue" };
}
