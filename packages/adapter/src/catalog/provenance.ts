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
 */
export function createInstalledProvenanceReader(source: InstalledProvenanceSource) {
  return async (ref: ProjectRef, name: string): Promise<CatalogProvenance | null> => {
    for (const path of await source.documents(ref)) {
      const content = await source.read(ref, path);
      if (content === null || !content.includes(CATALOG_PROVENANCE_ATTRIBUTE)) continue;
      const { document } = parseHTML(content);
      for (const element of document.querySelectorAll(`[${CATALOG_PROVENANCE_ATTRIBUTE}]`)) {
        const parsed = parseCatalogProvenance(element.getAttribute(CATALOG_PROVENANCE_ATTRIBUTE) ?? "");
        if (parsed?.name === name) return parsed;
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
