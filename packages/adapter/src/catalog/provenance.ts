import {
  catalogProvenanceValue,
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

export {
  catalogProvenanceAttribute,
  catalogProvenanceValue,
  parseCatalogProvenance,
  type CatalogProvenance,
} from "@vidcom/core";
