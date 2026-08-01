import "server-only";

import { parseHTML } from "linkedom";

/**
 * The element subtree a composition file actually authors.
 *
 * Sub-compositions are written either as a full document or wrapped in a
 * `<template>`, and linkedom keeps template children in `.content` — a plain
 * `document.body` walk finds nothing at all in the wrapped form, which is the
 * form the scaffolded projects use.
 */
export function compositionRoot(raw: string): ParentNode {
  const { document } = parseHTML(raw);
  const template = document.querySelector("template");
  return (template?.content as ParentNode | undefined) ?? document.body;
}

/**
 * Inline scripts of a composition — where its GSAP timeline lives. The element
 * rides along so callers can tell whose timeline it is: a script nested inside a
 * sub-composition host belongs to that scene, not to the document around it.
 */
export function inlineScripts(
  root: ParentNode,
): { element: Element; source: string }[] {
  return [...root.querySelectorAll("script")]
    .filter((script) => !script.getAttribute("src"))
    .map((element) => ({ element, source: element.textContent ?? "" }))
    .filter(({ source }) => source.trim().length > 0);
}
