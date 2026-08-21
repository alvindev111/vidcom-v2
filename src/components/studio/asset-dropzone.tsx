"use client";

import * as React from "react";
import { UploadIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function AssetDropzone({ progress, error, onUpload, onCancel }: {
  progress: number | null;
  error: string | null;
  onUpload(file: File): void;
  onCancel(): void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const accept = (files: FileList | null) => { const file = files?.[0]; if (file) onUpload(file); };
  return (
    <div className="border-t p-2">
      <button
        type="button"
        className="text-muted-foreground hover:border-studio-accent hover:text-foreground flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-2 py-3 text-xs"
        onClick={() => input.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); accept(event.dataTransfer.files); }}
      >
        <UploadIcon className="size-3.5" /> Drop media or font
      </button>
      <input ref={input} type="file" className="hidden" onChange={(event) => accept(event.target.files)} />
      {progress !== null && progress < 100 ? (
        <div className="mt-2 flex items-center gap-2" aria-live="polite">
          <div className="bg-muted h-1.5 grow overflow-hidden rounded-full">
            <div className="bg-studio-accent h-full" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-muted-foreground text-[10px]">{Math.round(progress)}%</span>
          <Button type="button" variant="ghost" size="icon" className="size-6" aria-label="Cancel upload" onClick={onCancel}>
            <XIcon className="size-3" />
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-destructive mt-2 text-xs">{error}</p> : null}
    </div>
  );
}
