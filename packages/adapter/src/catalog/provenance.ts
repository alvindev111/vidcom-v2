import { parseHTML } from "linkedom";

import {
  catalogProvenanceValue,
  parseCatalogProvenance,
  type CatalogProvenance,
  type ProjectRef,
  type VerifiedCatalogItem,
} from "@vidcom/core";

/**
 * Mounts catalog provenance as one attribute (Design §5.17).
 *
 * The value comes from Core and is written through `setAttribute`, so the
 * serializer escapes it and no string is interpolated into markup on this path.
 */
export const CATALOG_PROVENANCE_ATTRIBUTE = "data-catalog-provenance";

/** Element surface used for mounting; kept minimal so Core stays DOM-free. */
interface ProvenanceTarget {
  setAttribute(name: string, value: string): void;
}

export function writeCatalogProvenance(target: ProvenanceTarget, item: VerifiedCatalogItem): void {
  target.setAttribute(CATALOG_PROVENANCE_ATTRIBUTE, catalogProvenanceValue(item));
}

/** Documents searched for a mounted package, in the order they are read. */
export interface InstalledProvenanceSource {
  read(ref: ProjectRef, path: string): Promise<string | null>;
  documents(ref: ProjectRef): Promise<readonly string[]>;
}

/**
 * Finds the provenance of an already-installed package.
 *
 * Reads authored documents rather than the package files themselves: the mount
 * instance is what records which version is in the project, so a file left behind
 * without a mount correctly reads as unmanaged.
 *
 * Scene documents author their content inside a `<template>`, and template
 * content is a separate fragment that `querySelectorAll` does not descend into,
 * so those fragments are searched explicitly. Missing this made every installed
 * package look unmanaged.
 */
export function createInstalledProvenanceReader(source: InstalledProvenanceSource) {
  return async (ref: ProjectRef, name: string): Promise<CatalogProvenance | null> => {
    for (const path of await source.documents(ref)) {
      const content = await source.read(ref, path);
      if (content === null || !content.includes(CATALOG_PROVENANCE_ATTRIBUTE)) continue;
      const { document } = parseHTML(content);
      const roots: ParentNode[] = [document as unknown as ParentNode];
      for (const template of document.querySelectorAll("template")) {
        const fragment = (template as unknown as { content?: ParentNode }).content;
        if (fragment) roots.push(fragment);
      }
      for (const root of roots) {
        for (const element of root.querySelectorAll(`[${CATALOG_PROVENANCE_ATTRIBUTE}]`)) {
          const parsed = parseCatalogProvenance(
            (element as unknown as Element).getAttribute(CATALOG_PROVENANCE_ATTRIBUTE) ?? "",
          );
          if (parsed?.name === name) return parsed;
        }
      }
    }
    return null;
  };
}

export {
  catalogProvenanceAttribute,
  catalogProvenanceValue,
  parseCatalogProvenance,
  type CatalogProvenance,
} from "@vidcom/core";
