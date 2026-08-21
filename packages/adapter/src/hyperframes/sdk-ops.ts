import { existsSync, readFileSync, statSync } from "node:fs";

import { resolveWithinProject } from "@hyperframes/core";
import { openComposition, type Composition, type EditOp, type HyperFramesElement } from "@hyperframes/sdk";
import { parseHTML } from "linkedom";
import postcss, { type Rule } from "postcss";

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

type SdkCompositionOp = Exclude<CompositionOp, { kind: "replaceCaptions" | "setLayoutOffset" }>;

function editOp(composition: Composition, operation: SdkCompositionOp): EditOp {
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
    case "removeElement":
      return { type: "removeElement", target: target(composition, operation.target) };
  }
}

function captionModelIsValid(operation: Extract<CompositionOp, { kind: "replaceCaptions" }>): boolean {
  let previousCueEnd = 0;
  for (const cue of operation.value.cues) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < previousCueEnd || cue.end <= cue.start || cue.words.length === 0
      || cue.text !== cue.words.map((word) => word.text).join(" ")) return false;
    let previousWordEnd = cue.start;
    for (const word of cue.words) {
      if (!word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < previousWordEnd || word.end <= word.start
        || word.start < cue.start || word.end > cue.end) return false;
      previousWordEnd = word.end;
    }
    previousCueEnd = cue.end;
  }
  return true;
}

function replaceCaptions(
  raw: string,
  operation: Extract<CompositionOp, { kind: "replaceCaptions" }>,
): Result<string, DomainError> {
  if (!captionModelIsValid(operation)) {
    return err({ code: ErrorCode.SdkRejected, message: "caption timings are invalid" });
  }
  const { document } = parseHTML(raw);
  const hosts = [...document.querySelectorAll("[data-composition-id]")];
  const host = operation.target === "@root"
    ? hosts[0]
    : hosts.find((element) => element.getAttribute("data-composition-id") === operation.target);
  if (!host) return err({ code: ErrorCode.SdkRejected, message: "caption target was not found" });
  for (const existing of [...host.querySelectorAll(".captions")]) existing.remove();

  const container = document.createElement("div");
  container.setAttribute("class", "captions clip");
  container.setAttribute("data-hf-id", `captions-${operation.target}`);
  container.setAttribute("data-start", "0");
  container.setAttribute("data-duration", String(operation.value.cues.at(-1)?.end ?? 0));
  container.setAttribute("data-caption-timing", operation.value.timingSource);
  for (const cue of operation.value.cues) {
    const paragraph = document.createElement("p");
    paragraph.setAttribute("class", "caption clip");
    paragraph.setAttribute("data-start", String(cue.start));
    paragraph.setAttribute("data-duration", String(cue.end - cue.start));
    cue.words.forEach((word, index) => {
      if (index > 0) paragraph.append(document.createTextNode(" "));
      const span = document.createElement("span");
      span.setAttribute("class", "w");
      span.setAttribute("data-start", String(word.start));
      span.setAttribute("data-end", String(word.end));
      span.textContent = word.text;
      paragraph.append(span);
    });
    container.append(paragraph);
  }
  host.append(container);
  return ok(document.toString());
}

function setLayoutOffset(
  raw: string,
  operation: Extract<CompositionOp, { kind: "setLayoutOffset" }>,
): Result<string, DomainError> {
  const { document } = parseHTML(raw);
  let ownerTemplate: HTMLTemplateElement | null = null;
  let element = [...document.querySelectorAll("[data-hf-id]")]
    .find((candidate) => candidate.getAttribute("data-hf-id") === operation.target);
  if (!element) {
    for (const template of [...document.querySelectorAll<HTMLTemplateElement>("template")]) {
      element = [...template.content.querySelectorAll("[data-hf-id]")]
        .find((candidate) => candidate.getAttribute("data-hf-id") === operation.target);
      if (element) {
        ownerTemplate = template;
        break;
      }
    }
  }
  if (!element) return err({ code: ErrorCode.SdkRejected, message: "layout target was not found" });
  const ownsOffset = element.hasAttribute("data-vidcom-layout-offset");
  const style = element.getAttribute("style") ?? "";
  let rule: Rule;
  try {
    const root = postcss.parse(`x{${style}}`, { from: undefined });
    const first = root.first;
    if (!first || first.type !== "rule") {
      return err({ code: ErrorCode.SdkRejected, message: "layout target style is invalid" });
    }
    rule = first;
  } catch {
    return err({ code: ErrorCode.SdkRejected, message: "layout target style is invalid" });
  }
  if (!ownsOffset && rule.nodes?.some((node) => node.type === "decl" && node.prop.toLowerCase() === "translate")) {
    return err({ code: ErrorCode.SdkRejected, message: "authored translate locks this layout target" });
  }
  rule.walkDecls(/^--vidcom-layout-(?:x|y)$/u, (declaration) => { declaration.remove(); });
  const zero = operation.value.x === 0 && operation.value.y === 0;
  if (zero) {
    element.removeAttribute("data-vidcom-layout-offset");
  } else {
    rule.append({ prop: "--vidcom-layout-x", value: `${operation.value.x}px` });
    rule.append({ prop: "--vidcom-layout-y", value: `${operation.value.y}px` });
    element.setAttribute("data-vidcom-layout-offset", "");
  }
  const serialized = rule.nodes?.length ? rule.nodes.map((node) => node.type === "decl"
    ? `${node.prop}: ${node.value}${node.important ? " !important" : ""};`
    : node.toString()).join(" ") : "";
  if (serialized) element.setAttribute("style", serialized);
  else element.removeAttribute("style");
  if (ownerTemplate) {
    ownerTemplate.innerHTML = [...ownerTemplate.content.childNodes].map((node) => node.toString()).join("");
  }
  return ok(document.toString());
}

async function applySdkOps(raw: string, operations: SdkCompositionOp[]): Promise<Result<string, DomainError>> {
  const composition = await openComposition(raw);
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
  let raw = readFileSync(filename, "utf8");
  let sdkOperations: SdkCompositionOp[] = [];
  const flushSdkOperations = async (): Promise<Result<void, DomainError>> => {
    if (sdkOperations.length === 0) return ok(undefined);
    const applied = await applySdkOps(raw, sdkOperations);
    sdkOperations = [];
    if (!applied.ok) return applied;
    raw = applied.value;
    return ok(undefined);
  };
  if (operations.length === 0) return applySdkOps(raw, []);
  for (const operation of operations) {
    if (operation.kind !== "replaceCaptions" && operation.kind !== "setLayoutOffset") {
      sdkOperations.push(operation);
      continue;
    }
    const flushed = await flushSdkOperations();
    if (!flushed.ok) return flushed;
    const applied = operation.kind === "replaceCaptions"
      ? replaceCaptions(raw, operation)
      : setLayoutOffset(raw, operation);
    if (!applied.ok) return applied;
    raw = applied.value;
  }
  const flushed = await flushSdkOperations();
  return flushed.ok ? ok(raw) : flushed;
}
