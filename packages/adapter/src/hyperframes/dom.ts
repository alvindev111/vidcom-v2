import { readClipTiming } from "@hyperframes/core";
import { DOMParser, parseHTML } from "linkedom";

import type { CompositionHost } from "./types";

if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
}

/** Returns the authored subtree, including children held by a template fragment. */
export function authoredCompositionRoot(document: Document): ParentNode {
  const bodyTemplate = [...document.body.children]
    .find((element) => element.tagName.toUpperCase() === "TEMPLATE") as HTMLTemplateElement | undefined;
  const fragmentTemplate = document.documentElement?.tagName.toUpperCase() === "TEMPLATE"
    ? document.documentElement as HTMLTemplateElement
    : undefined;
  const wrapper = bodyTemplate ?? fragmentTemplate;
  return wrapper?.content
    ?? (document.body.querySelector("[data-composition-id]") ? document.body : document);
}

export function compositionRoot(raw: string): ParentNode {
  const { document } = parseHTML(raw);
  return authoredCompositionRoot(document);
}

export function inlineScripts(root: ParentNode): Array<{ element: Element; source: string }> {
  return [...root.querySelectorAll("script")]
    .filter((script) => !script.getAttribute("src"))
    .map((element) => ({ element, source: element.textContent ?? "" }))
    .filter(({ source }) => source.trim().length > 0);
}

/** Finds ownership by DOM ancestry rather than document order or dimensions. */
export function nearestHost(node: Element): Element | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.hasAttribute("data-composition-id")) return parent;
  }
  return null;
}

export function rootHost(hosts: Element[]): Element | undefined {
  return hosts.find((host) => nearestHost(host) === null) ?? hosts[0];
}

function nestedHosts(hosts: Element[], root: Element): CompositionHost[] {
  return hosts
    .filter((host) => host !== root)
    .map((element) => {
      const timing = readClipTiming(element);
      return {
        id: element.getAttribute("data-composition-id") ?? "",
        src: element.getAttribute("data-composition-src"),
        start: timing.start ?? 0,
        duration: timing.duration ?? timing.end ?? 0,
        trackIndex: timing.trackIndex,
        element,
      };
    })
    .sort((left, right) => right.trackIndex - left.trackIndex);
}

export function readCompositionHosts(html: string): CompositionHost[] {
  const { document } = parseHTML(html);
  const hosts = [...document.querySelectorAll("[data-composition-id]")];
  const root = rootHost(hosts);
  return root ? nestedHosts(hosts, root) : [];
}

/** Stable structural identity for elements without an authored id. */
export function elementDomPath(node: Element, root: ParentNode): string {
  const parts: string[] = [];
  let current: Element | null = node;
  while (current && current !== root) {
    const parent: Element | null = current.parentElement;
    const siblings = parent ? [...parent.children] : [...root.children];
    parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${siblings.indexOf(current) + 1})`);
    current = parent;
  }
  return parts.join(">");
}
