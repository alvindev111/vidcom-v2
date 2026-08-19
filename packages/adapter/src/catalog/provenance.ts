import {
  canonicalizeJson,
  catalogProvenanceOf,
  type VerifiedCatalogItem,
} from "@vidcom/core";

/**
 * Mounts catalog provenance as one attribute (Design §5.17).
 *
 * The value is canonical JSON written through `setAttribute`, so the serializer
 * escapes it: hostile metadata such as `"><script>` stays a string inside the
 * attribute and cannot open a tag or a second attribute. No string is
 * interpolated into markup anywhere on this path.
 */
export const CATALOG_PROVENANCE_ATTRIBUTE = "data-catalog-provenance";

/** Element surface used for mounting; kept minimal so Core stays DOM-free. */
interface ProvenanceTarget {
  setAttribute(name: string, value: string): void;
}

/**
 * Canonical JSON with every markup-significant character escaped at the JSON
 * level (`\u003c`, `\u003e`, `\u0026`).
 *
 * A quoted attribute containing `<script>` is inert to a real HTML parser, and
 * `setAttribute` already escapes quotes. Escaping in the JSON goes one step
 * further so the serialized attribute contains no markup-looking bytes at all,
 * which also keeps the value inert for the repository's non-DOM scanners. The
 * value still parses back to the identical object.
 */
export function catalogProvenanceValue(item: VerifiedCatalogItem): string {
  return canonicalizeJson(catalogProvenanceOf(item))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function writeCatalogProvenance(target: ProvenanceTarget, item: VerifiedCatalogItem): void {
  target.setAttribute(CATALOG_PROVENANCE_ATTRIBUTE, catalogProvenanceValue(item));
}

export { parseCatalogProvenance, type CatalogProvenance } from "@vidcom/core";
