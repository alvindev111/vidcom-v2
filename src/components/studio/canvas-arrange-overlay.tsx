"use client";

import * as React from "react";
import { CheckIcon, HandIcon, Loader2Icon, RotateCcwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api/services";
import { planCanvasDrag, type CanvasDragPlan } from "@/lib/studio/canvas-drag";
import type { PreviewArrangeTarget } from "@/lib/studio/preview-bridge";
import { mutationChangeSeq, type ProjectChanged } from "@/lib/studio/preview-reload";
import type { Scene, SceneElement, SourceFile } from "@/lib/studio/types";
import type { PlayerControls } from "./use-hyperframes-player";
import { useStudioSession } from "./studio-session-context";

interface Selection {
  target: PreviewArrangeTarget;
  scene: Scene;
  element: SceneElement;
}

interface DragState {
  pointerId: number;
  start: { x: number; y: number };
  latest: { x: number; y: number };
  plan: CanvasDragPlan | null;
}

function serverSelection(target: PreviewArrangeTarget, scenes: readonly Scene[]): Selection | null {
  const scene = scenes.find((candidate) => candidate.id === target.sceneId);
  const element = scene?.elements.find((candidate) => candidate.authoredId === target.hfId);
  return scene && element ? { target, scene, element } : null;
}

function message(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  }
  return `position save failed (${status})`;
}

export function CanvasArrangeOverlay({
  projectId,
  scenes,
  files,
  controls,
  selectedId,
  onSelectScene,
  onProjectChanged,
}: {
  projectId: string;
  scenes: Scene[];
  files: SourceFile[];
  controls: PlayerControls;
  selectedId: string;
  onSelectScene: (scene: Scene) => void;
  onProjectChanged: ProjectChanged;
}) {
  const studio = useStudioSession();
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const statusRef = React.useRef<HTMLParagraphElement>(null);
  const selectionRef = React.useRef<Selection | null>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const hashesRef = React.useRef(new Map(files.map((file) => [file.path, file.version])));
  const [enabled, setEnabled] = React.useState(false);
  const [selection, setSelection] = React.useState<Selection | null>(null);
  const [pending, setPending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    hashesRef.current = new Map(files.map((file) => [file.path, file.version]));
  }, [files]);
  React.useEffect(() => { selectionRef.current = selection; }, [selection]);
  React.useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    controls.setArrangeMode(false);
  }, [controls]);

  const paint = React.useCallback((plan: CanvasDragPlan | null) => {
    const current = selectionRef.current;
    const box = boxRef.current;
    if (!current || !box) return;
    const { rect, canvas } = current.target;
    const dx = plan ? plan.absoluteX - rect.x : 0;
    const dy = plan ? plan.absoluteY - rect.y : 0;
    box.style.left = `${rect.x / canvas.width * 100}%`;
    box.style.top = `${rect.y / canvas.height * 100}%`;
    box.style.width = `${rect.width / canvas.width * 100}%`;
    box.style.height = `${rect.height / canvas.height * 100}%`;
    box.style.transform = `translate(${dx / canvas.width * 100}cqw, ${dy / canvas.height * 100}cqh)`;
    if (statusRef.current && plan) {
      statusRef.current.textContent = `x ${Math.round(plan.offsetX)} · y ${Math.round(plan.offsetY)}${plan.guides.length ? ` · snap ${plan.guides.join(", ")}` : ""}`;
    }
  }, []);

  const reset = React.useCallback(() => {
    const current = selectionRef.current;
    if (current) controls.resetOffset(current.scene.id, current.element.authoredId!);
    dragRef.current = null;
    selectionRef.current = null;
    setSelection(null);
    paint(null);
  }, [controls, paint]);

  const setMode = React.useCallback((next: boolean) => {
    if (!next) reset();
    setProblem(null);
    setEnabled(next);
    controls.setArrangeMode(next);
  }, [controls, reset]);

  const save = React.useCallback(async (current: Selection, plan: CanvasDragPlan) => {
    if (!plan.changed || pending) return;
    let expectedContentHash = hashesRef.current.get(current.scene.sourceFile);
    if (!expectedContentHash) {
      const currentFile = await fetchApi(`/api/v1/projects/${projectId}/files?path=${encodeURIComponent(current.scene.sourceFile)}`);
      const currentBody = await currentFile.json().catch(() => null) as { file?: { contentHash?: string } } | null;
      expectedContentHash = currentBody?.file?.contentHash;
      if (expectedContentHash) hashesRef.current.set(current.scene.sourceFile, expectedContentHash);
      if (!expectedContentHash) {
        setProblem(`Cannot resolve the current version of ${current.scene.sourceFile}. Reload the project.`);
        controls.resetOffset(current.scene.id, current.element.authoredId!);
        return;
      }
    }
    setPending(true);
    setProblem(null);
    try {
      const response = await fetchApi(`/api/v1/projects/${projectId}/scenes/${encodeURIComponent(current.scene.id)}/elements/${encodeURIComponent(current.element.authoredId!)}/position`, studio.request({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          offsetX: plan.offsetX,
          offsetY: plan.offsetY,
          expectedContentHash,
        }),
      }));
      const payload = await response.json().catch(() => null) as {
        changed?: boolean;
        file?: { path: string; contentHash: string };
        changeSeq?: number | null;
      } | null;
      if (!response.ok) {
        setProblem(message(payload, response.status));
        return;
      }
      if (payload?.file) hashesRef.current.set(payload.file.path, payload.file.contentHash);
      const next: Selection = {
        ...current,
        target: {
          ...current.target,
          rect: {
            ...current.target.rect,
            x: plan.absoluteX,
            y: plan.absoluteY,
          },
        },
        element: { ...current.element, layoutOffset: { x: plan.offsetX, y: plan.offsetY } },
      };
      selectionRef.current = next;
      setSelection(next);
      paint(null);
      if (statusRef.current) statusRef.current.textContent = `Saved x ${Math.round(plan.offsetX)} · y ${Math.round(plan.offsetY)}`;
      const changeSeq = mutationChangeSeq(payload);
      // The current engine already painted this exact offset during the drag.
      // Once the authoritative write confirms it, promote that visible frame
      // immediately while the normal source-backed engine reload continues.
      onProjectChanged(changeSeq);
      if (changeSeq !== null) controls.confirmVisibleChange(changeSeq);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "position save failed");
    } finally {
      setPending(false);
    }
  }, [controls, onProjectChanged, paint, pending, projectId, studio]);

  const planAt = React.useCallback((current: Selection, start: { x: number; y: number }, now: { x: number; y: number }, snap: boolean) => {
    const viewport = overlayRef.current?.getBoundingClientRect();
    if (!viewport) return null;
    return planCanvasDrag({
      pointerStart: start,
      pointerNow: now,
      viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
      canvas: current.target.canvas,
      targetRect: current.target.rect,
      existingOffset: current.element.layoutOffset ?? { x: 0, y: 0 },
      snap,
    });
  }, []);

  const moveFrame = React.useCallback((snap: boolean) => {
    frameRef.current = null;
    const drag = dragRef.current;
    const current = selectionRef.current;
    if (!drag || !current) return;
    const plan = planAt(current, drag.start, drag.latest, snap);
    if (!plan) return;
    drag.plan = plan;
    controls.previewOffset(current.scene.id, current.element.authoredId!, plan.offsetX, plan.offsetY);
    paint(plan);
  }, [controls, paint, planAt]);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={enabled ? "default" : "secondary"}
        className="absolute top-3 right-3 z-30 h-8 gap-1.5 text-xs shadow-lg"
        aria-pressed={enabled}
        onClick={() => setMode(!enabled)}
      >
        <HandIcon className="size-3.5" />
        {enabled ? "Done arranging" : "Arrange elements"}
      </Button>

      {enabled ? (
        <div
          ref={overlayRef}
          data-arrange-overlay
          data-arrange-selected-scene-id={selectedId}
          className="absolute inset-0 z-20 touch-none select-none"
          style={{ containerType: "size" }}
          role="application"
          aria-label="Arrange video elements. Click an element, drag it, or use arrow keys. Shift plus arrow moves ten pixels. Escape cancels."
          tabIndex={0}
          onPointerDown={async (event) => {
            if (pending || event.button !== 0) return;
            const viewport = event.currentTarget.getBoundingClientRect();
            const point = { x: event.clientX, y: event.clientY };
            const target = await controls.hitTest(
              (event.clientX - viewport.x) / viewport.width,
              (event.clientY - viewport.y) / viewport.height,
            );
            const resolved = target ? serverSelection(target, scenes) : null;
            if (!target) {
              setProblem("This area has no element with a stable editor ID. Choose another object.");
              reset();
              return;
            }
            if (!resolved) {
              setProblem("The preview target does not match the current server model. Reload before editing.");
              reset();
              return;
            }
            if (!target.editable || !resolved.element.positionEditable) {
              setProblem(target.reason === "authored_translate"
                ? "This element owns a translate animation, so its base position is locked."
                : "This element cannot be moved safely. Choose an element with an editor ID and axis-aligned motion.");
              selectionRef.current = resolved;
              setSelection(resolved);
              paint(null);
              return;
            }
            setProblem(null);
            selectionRef.current = resolved;
            setSelection(resolved);
            if (resolved.scene.id !== selectedId) onSelectScene(resolved.scene);
            dragRef.current = { pointerId: event.pointerId, start: point, latest: point, plan: null };
            event.currentTarget.setPointerCapture(event.pointerId);
            requestAnimationFrame(() => paint(null));
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            drag.latest = { x: event.clientX, y: event.clientY };
            if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => moveFrame(!event.altKey));
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            const current = selectionRef.current;
            if (!drag || drag.pointerId !== event.pointerId || !current) return;
            if (frameRef.current !== null) {
              cancelAnimationFrame(frameRef.current);
              frameRef.current = null;
            }
            drag.latest = { x: event.clientX, y: event.clientY };
            const plan = planAt(current, drag.start, drag.latest, !event.altKey);
            dragRef.current = null;
            if (!plan?.changed) {
              controls.resetOffset(current.scene.id, current.element.authoredId!);
              paint(null);
              return;
            }
            void save(current, plan);
          }}
          onPointerCancel={() => reset()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              reset();
              if (statusRef.current) statusRef.current.textContent = "Move cancelled";
              return;
            }
            if (!selection || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1;
            const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
            const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
            const plan = planAt(selection, { x: 0, y: 0 }, { x: dx, y: dy }, false);
            if (plan?.changed) {
              controls.previewOffset(selection.scene.id, selection.element.authoredId!, plan.offsetX, plan.offsetY);
              paint(plan);
              void save(selection, plan);
            }
          }}
        >
          {selection ? (
            <div
              ref={boxRef}
              className={`pointer-events-none absolute border-2 ${selection.target.editable && selection.element.positionEditable ? "border-cyan-300" : "border-amber-400"}`}
              data-arrange-target={selection.element.authoredId}
            >
              <span className="absolute -top-6 left-0 rounded bg-black/85 px-1.5 py-0.5 font-mono text-[10px] text-white">
                {selection.target.kind === "caption" ? "Subtitles" : selection.element.label}
              </span>
            </div>
          ) : null}
          <div className="pointer-events-none absolute bottom-3 left-1/2 w-[min(92%,34rem)] -translate-x-1/2 rounded-md border border-white/20 bg-black/85 px-3 py-2 text-center text-[11px] text-white shadow-lg">
            <p ref={statusRef} role="status" aria-live="polite">
              Click an outlined element, then drag. Arrow = 1 px · Shift+Arrow = 10 px · Alt disables snap.
            </p>
          </div>
        </div>
      ) : null}

      {problem ? (
        <div className="absolute top-14 right-3 z-40 flex max-w-sm items-center gap-2 rounded-md border border-amber-500/40 bg-black/90 p-2 text-[11px] text-amber-100" role="alert">
          <span>{problem}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-[10px]" onClick={() => window.location.reload()}>
            <RotateCcwIcon className="size-3" /> Reload latest
          </Button>
          <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Keep preview draft" onClick={() => setProblem(null)}>
            <XIcon className="size-3" />
          </Button>
        </div>
      ) : null}
      {pending ? (
        <span className="absolute top-14 right-3 z-40 inline-flex items-center gap-1 rounded bg-black/85 px-2 py-1 text-[11px] text-white">
          <Loader2Icon className="size-3 animate-spin" /> Saving position…
        </span>
      ) : selection && !problem ? (
        <span className="sr-only"><CheckIcon /> Position editor ready</span>
      ) : null}
    </>
  );
}
