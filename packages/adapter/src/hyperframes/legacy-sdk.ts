import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveWithinProject } from "@hyperframes/core";
import { openComposition, type Composition, type HyperFramesElement } from "@hyperframes/sdk";

import type { ProjectRef } from "@vidcom/core";

import type { Narration, SceneScriptLine } from "./types";

function filename(ref: ProjectRef, file: string): string | null {
  const target = resolveWithinProject(ref.root, file);
  return target && existsSync(target) ? target : null;
}

export async function openLegacyComposition(ref: ProjectRef, file: string): Promise<Composition | null> {
  const target = filename(ref, file);
  return target ? openComposition(readFileSync(target, "utf8")) : null;
}

function findByCompositionId(elements: readonly HyperFramesElement[], id: string): HyperFramesElement | null {
  for (const element of elements) {
    if (element.attributes["data-composition-id"] === id) return element;
    const nested = findByCompositionId(element.children, id);
    if (nested) return nested;
  }
  return null;
}

function findRoot(elements: readonly HyperFramesElement[]): HyperFramesElement | null {
  for (const element of elements) {
    if (element.attributes["data-composition-id"] && !element.scopedId.includes("/")) return element;
    const nested = findRoot(element.children);
    if (nested) return nested;
  }
  return null;
}

function lines(
  elements: readonly HyperFramesElement[],
  file: string,
  result: SceneScriptLine[] = [],
): SceneScriptLine[] {
  for (const element of elements) {
    if (["script", "style", "template"].includes(element.tag.toLowerCase())) continue;
    const value = (element.text ?? "").replace(/\s+/g, " ").trim();
    if (element.children.length === 0) {
      if (value.length > 1 && value.length < 400) result.push({ id: element.scopedId, text: value, file });
    } else lines(element.children, file, result);
  }
  return result;
}

export function legacySceneScriptLines(
  composition: Composition,
  file: string,
  scene: { id: string; src: string | null },
): SceneScriptLine[] {
  const roots = composition.getRootElements();
  if (scene.src) return lines(roots, file);
  const host = findByCompositionId(roots, scene.id);
  return host ? lines(host.children, file) : [];
}

export async function legacyUpdateSceneTiming(
  ref: ProjectRef,
  sceneId: string,
  timing: { start?: number; duration?: number; trackIndex?: number },
) {
  const target = filename(ref, ref.entry);
  if (!target) return { ok: false as const, error: "composition not found" };
  const composition = await openComposition(readFileSync(target, "utf8"));
  try {
    const host = findByCompositionId(composition.getRootElements(), sceneId);
    if (!host) return { ok: false as const, error: `scene ${sceneId} not found` };
    const operation = { type: "setTiming" as const, target: host.scopedId, ...timing };
    const allowed = composition.can(operation);
    if (!allowed.ok) return { ok: false as const, error: allowed.message || "edit rejected by the SDK" };
    composition.dispatch(operation);
    writeFileSync(target, composition.serialize(), "utf8");
    return { ok: true as const };
  } finally { composition.dispose(); }
}

export async function legacyUpdateSceneScript(
  ref: ProjectRef,
  sceneId: string,
  file: string,
  elementId: string,
  text: string,
  regenerate: (sceneId: string, text: string) => Narration | null,
) {
  const target = filename(ref, file);
  if (!target) return { ok: false as const, error: "file not found" };
  const composition = await openComposition(readFileSync(target, "utf8"));
  try {
    const operation = { type: "setText" as const, target: elementId, value: text };
    const allowed = composition.can(operation);
    if (!allowed.ok) return { ok: false as const, error: allowed.message || "edit rejected by the SDK" };
    composition.dispatch(operation);
    writeFileSync(target, composition.serialize(), "utf8");
    return { ok: true as const, narration: regenerate(sceneId, text) };
  } finally { composition.dispose(); }
}

function sceneHtml(sceneId: string, title: string, duration: number): string {
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><style>
html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden;background:transparent;font-family:"Outfit",sans-serif}
#${sceneId}{position:absolute;inset:0;display:grid;place-items:center;padding:0 12%}
#${sceneId} h2{margin:0;font-size:96px;line-height:1.05;text-align:center;letter-spacing:-0.02em}
</style></head><body><div id="${sceneId}" data-composition-id="${sceneId}" data-width="1920" data-height="1080" data-start="0" data-duration="${duration}"><h2>${escaped}</h2></div></body></html>\n`;
}

export async function legacyCreateScene(
  ref: ProjectRef,
  title: string,
  options: { duration?: number },
  regenerate: (sceneId: string, text: string) => Narration | null,
) {
  const target = filename(ref, ref.entry);
  if (!target) return { ok: false as const, error: "composition not found" };
  const composition = await openComposition(readFileSync(target, "utf8"));
  try {
    const root = findRoot(composition.getRootElements());
    if (!root) return { ok: false as const, error: "root composition not found" };
    const hosts = root.children.filter((child) => child.attributes["data-composition-id"]);
    const start = Math.max(0, ...hosts.map((child) =>
      Number(child.attributes["data-start"] ?? 0) + Number(child.attributes["data-duration"] ?? 0)));
    const duration = options.duration ?? 4;
    const numbers = hosts.flatMap((child) => {
      const match = /^scene-(\d+)$/.exec(child.attributes["data-composition-id"] ?? "");
      return match ? [Number(match[1])] : [];
    });
    const sceneId = `scene-${numbers.length ? Math.max(...numbers) + 1 : 1}`;
    const trackIndex = Math.max(0, ...hosts.map((child) => Number(child.attributes["data-track-index"] ?? 0))) + 1;
    const sceneFile = `compositions/${sceneId}.html`;
    const sceneTarget = resolveWithinProject(ref.root, sceneFile);
    if (!sceneTarget) return { ok: false as const, error: "scene path is invalid" };
    mkdirSync(dirname(sceneTarget), { recursive: true });
    writeFileSync(sceneTarget, sceneHtml(sceneId, title, duration), "utf8");
    const html = `<div id="${sceneId}-layer" class="comp-layer clip" data-composition-id="${sceneId}" data-composition-src="${sceneFile}" data-start="${start}" data-duration="${duration}" data-track-index="${trackIndex}"></div>`;
    const add = { type: "addElement" as const, parent: root.scopedId, index: root.children.length, html };
    const allowed = composition.can(add);
    if (!allowed.ok) return { ok: false as const, error: allowed.message || "insert rejected by the SDK" };
    composition.dispatch(add);
    const currentDuration = Number(root.attributes["data-duration"] ?? 0);
    if (start + duration > currentDuration) {
      composition.dispatch({ type: "setTiming", target: root.scopedId, duration: start + duration });
    }
    writeFileSync(target, composition.serialize(), "utf8");
    return { ok: true as const, sceneId, start, duration, narration: regenerate(sceneId, title) };
  } finally { composition.dispose(); }
}
