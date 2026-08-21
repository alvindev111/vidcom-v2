export interface CanvasDragInput {
  pointerStart: { x: number; y: number };
  pointerNow: { x: number; y: number };
  viewport: { x: number; y: number; width: number; height: number };
  canvas: { width: number; height: number };
  targetRect: { x: number; y: number; width: number; height: number };
  existingOffset: { x: number; y: number };
  snap: boolean;
}

export interface CanvasDragPlan {
  offsetX: number;
  offsetY: number;
  absoluteX: number;
  absoluteY: number;
  guides: Array<"left" | "center-x" | "right" | "top" | "center-y" | "bottom" | "safe">;
  changed: boolean;
}

const SNAP_SCREEN_PX = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function snappedDelta(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / SNAP_SCREEN_PX) * SNAP_SCREEN_PX : value;
}

/** Pure CSS-viewport to authored-composition position planner. */
export function planCanvasDrag(input: CanvasDragInput): CanvasDragPlan {
  const scaleX = input.canvas.width / input.viewport.width;
  const scaleY = input.canvas.height / input.viewport.height;
  const screenX = snappedDelta(input.pointerNow.x - input.pointerStart.x, input.snap);
  const screenY = snappedDelta(input.pointerNow.y - input.pointerStart.y, input.snap);
  const desiredX = input.existingOffset.x + screenX * scaleX;
  const desiredY = input.existingOffset.y + screenY * scaleY;
  const baseX = input.targetRect.x - input.existingOffset.x;
  const baseY = input.targetRect.y - input.existingOffset.y;
  const offsetX = clamp(desiredX, -baseX, input.canvas.width - input.targetRect.width - baseX);
  const offsetY = clamp(desiredY, -baseY, input.canvas.height - input.targetRect.height - baseY);
  const absoluteX = baseX + offsetX;
  const absoluteY = baseY + offsetY;
  const guides: CanvasDragPlan["guides"] = [];
  const epsilonX = scaleX * 0.5;
  const epsilonY = scaleY * 0.5;
  if (Math.abs(absoluteX) <= epsilonX) guides.push("left");
  if (Math.abs(absoluteX + input.targetRect.width / 2 - input.canvas.width / 2) <= epsilonX) guides.push("center-x");
  if (Math.abs(absoluteX + input.targetRect.width - input.canvas.width) <= epsilonX) guides.push("right");
  if (Math.abs(absoluteY) <= epsilonY) guides.push("top");
  if (Math.abs(absoluteY + input.targetRect.height / 2 - input.canvas.height / 2) <= epsilonY) guides.push("center-y");
  if (Math.abs(absoluteY + input.targetRect.height - input.canvas.height) <= epsilonY) guides.push("bottom");
  const safeX = input.canvas.width * 0.05;
  const safeY = input.canvas.height * 0.05;
  if (Math.abs(absoluteX - safeX) <= epsilonX || Math.abs(absoluteY - safeY) <= epsilonY) guides.push("safe");
  return {
    offsetX,
    offsetY,
    absoluteX,
    absoluteY,
    guides,
    changed: offsetX !== input.existingOffset.x || offsetY !== input.existingOffset.y,
  };
}
