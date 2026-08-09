/**
 * Deduplicates an import request at the application layer, not in the index.
 *
 * `uq_job_idempotency` is scoped to `(project_id, type, key)`, and an import has
 * no `project_id` until it finishes — so every pending import carries NULL
 * there, and SQLite treats every NULL as distinct. The index would happily
 * accept a hundred identical imports. Looking the key up before enqueueing is
 * what actually makes a repeated request return the same job.
 *
 * The hash arrives as a port, the way every other digest in Core does: the
 * algorithm is an infrastructure detail and Core may not reach for one.
 */
export function importIdempotencyKey(
  input: {
    workspaceRoot: string;
    sourceCanonicalIdentity: string;
    targetName?: string;
  },
  hashContent: (content: string) => string,
): string {
  // A NUL separator, because it cannot appear in a path: joining on anything a
  // path can contain lets two different requests build the same material.
  const material = [
    input.workspaceRoot,
    input.sourceCanonicalIdentity,
    input.targetName ?? "",
  ].join("\u0000");
  return `import_${hashContent(material).replace(/^sha256:/u, "").slice(0, 32)}`;
}
