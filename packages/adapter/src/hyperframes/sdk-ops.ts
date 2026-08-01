import { existsSync, readFileSync, statSync } from "node:fs";

import { resolveWithinProject } from "@hyperframes/core";
import { openComposition, type Composition, type EditOp, type HyperFramesElement } from "@hyperframes/sdk";

import { ErrorCode, type DomainError, type RelPath } from "@vidcom/contracts";
import { err, ok, type CompositionOp, type ProjectRef, type Result } from "@vidcom/core";

function sourcePath(ref: ProjectRef, file: RelPath): string | null {
  const target = resolveWithinProject(ref.root, file);
  return target && existsSync(target) && statSync(target).isFile() ? target : null;
}

function findCompositionTarget(elements: readonly HyperFramesElement[], id: string): string | null {
  for (const element of elements) {
    if (element.attributes["data-composition-id"] === id) return element.scopedId;
    const nested = findCompositionTarget(element.children, id);
    if (nested) return nested;
  }
  return null;
}

function target(composition: Composition, requested: string): string {
  if (requested === "@root") return rootTarget(composition) ?? requested;
  if (composition.getElement(requested)) return requested;
  return findCompositionTarget(composition.getRootElements(), requested) ?? requested;
}

function rootTarget(composition: Composition): string | null {
  const visit = (elements: readonly HyperFramesElement[]): string | null => {
    for (const element of elements) {
      if (element.attributes["data-composition-id"]) return element.scopedId;
      const nested = visit(element.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(composition.getRootElements());
}

function editOp(composition: Composition, operation: CompositionOp): EditOp {
  switch (operation.kind) {
    case "setText":
      return { type: "setText", target: target(composition, operation.target), value: operation.value };
    case "setTiming":
      return { type: "setTiming", target: target(composition, operation.target), ...operation.value };
    case "addElement":
      {
        const parent = operation.target === "@root" ? rootTarget(composition) : operation.target;
        const parentElement = parent ? composition.getElement(parent) : null;
      return {
        type: "addElement",
        parent,
        ...operation.value,
        index: operation.value.index < 0 ? (parentElement?.children.length ?? 0) : operation.value.index,
      };
      }
  }
}

/** Applies SDK mutations in memory and returns serialization; filesystem ownership stays in WriteAuthority. */
export async function applyCompositionOps(
  ref: ProjectRef,
  file: RelPath,
  operations: CompositionOp[],
): Promise<Result<string, DomainError>> {
  const filename = sourcePath(ref, file);
  if (!filename) {
    return err({ code: ErrorCode.NotFound, message: "composition source file was not found" });
  }
  const composition = await openComposition(readFileSync(filename, "utf8"));
  try {
    for (const operation of operations) {
      const sdkOperation = editOp(composition, operation);
      const allowed = composition.can(sdkOperation);
      if (!allowed.ok) {
        return err({
          code: ErrorCode.SdkRejected,
          message: allowed.message || "HyperFrames rejected the composition operation",
          details: { sdkCode: allowed.code, ...(allowed.hint ? { hint: allowed.hint } : {}) },
        });
      }
      composition.dispatch(sdkOperation);
    }
    return ok(composition.serialize());
  } finally {
    composition.dispose();
  }
}
