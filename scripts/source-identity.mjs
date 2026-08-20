import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * One digest for "which source produced this evidence".
 *
 * A gate is only evidence for the tree it ran against, and a commit id alone
 * cannot say that: the interesting runs happen with the change still in the
 * working tree. So this hashes HEAD together with every path that differs from
 * it — staged or not, tracked or not, deleted or symlinked — and deliberately
 * does not consult the index, because staging is a bookkeeping act, not a change
 * to the source.
 *
 * Three files are excluded, and only three: this spec's checklist, its
 * implementation notes, and its in-process marker. They record what the gates
 * said, so including them would mean writing down a result changes the identity
 * that result was recorded against. Steering, design, goals, tests, scripts and
 * every other source stay inside the digest.
 */

const run = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const EVIDENCE_ONLY = new Set([
  "llm-documents/specs-and-process/specs/spec-editing-experience/spec-editing-experience-implementation-checklist.md",
  "llm-documents/specs-and-process/specs/spec-editing-experience/implementation-notes.html",
  "llm-documents/specs-and-process/specs/spec-editing-experience/spec-editing-experience-complete.md",
]);

/** Git's own file modes, which is what a digest of "the source" has to include. */
const REGULAR = "100644";
const EXECUTABLE = "100755";
const SYMLINK = "120000";

async function git(args, options = {}) {
  const { stdout } = await run("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
    ...options,
  });
  return stdout;
}

function splitNul(buffer) {
  return buffer.toString("utf8").split("\0").filter((entry) => entry.length > 0);
}

/** Rejects anything that could name a file outside the repository. */
function assertContained(relative) {
  if (relative.includes("\0")) throw new Error(`path contains NUL: ${JSON.stringify(relative)}`);
  if (path.isAbsolute(relative)) throw new Error(`path is absolute: ${relative}`);
  const resolved = path.resolve(repositoryRoot, relative);
  const contained = resolved === repositoryRoot || resolved.startsWith(repositoryRoot + path.sep);
  if (!contained) throw new Error(`path escapes the repository: ${relative}`);
  return resolved;
}

function modeOf(stats) {
  if (stats.isSymbolicLink()) return SYMLINK;
  // Git records exactly two file modes; anything with an owner-execute bit is
  // executable and everything else is a plain file.
  return (stats.mode & 0o100) === 0o100 ? EXECUTABLE : REGULAR;
}

async function headEntry(relative) {
  try {
    const output = (await git(["ls-tree", "-z", "HEAD", "--", relative])).toString("utf8");
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t/u.exec(output);
    return match ? { mode: match[1], blob: match[3] } : null;
  } catch {
    return null;
  }
}

/**
 * One record per changed path, length-prefixed so two paths can never be read
 * as one, and hashed in UTF-8 byte order rather than any locale's collation.
 */
function encodeRecord(relative, mode, digest) {
  const parts = [relative, mode, digest];
  return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

async function fileRecord(relative) {
  const resolved = assertContained(relative);
  let stats;
  try { stats = await lstat(resolved); }
  catch {
    // Deleted: carry the mode and blob it had at HEAD, so removing a file is a
    // different identity from never having had it.
    const head = await headEntry(relative);
    return encodeRecord(relative, head?.mode ?? "000000", `deleted:${head?.blob ?? "none"}`);
  }
  const mode = modeOf(stats);
  if (mode === SYMLINK) {
    // The link target, read with readlink: following it would hash whatever it
    // points at, which is not this repository's content.
    const target = await readlink(resolved);
    return encodeRecord(relative, mode, createHash("sha256").update(Buffer.from(target, "utf8")).digest("hex"));
  }
  const bytes = await readFile(resolved);
  return encodeRecord(relative, mode, createHash("sha256").update(bytes).digest("hex"));
}

/** HEAD plus every path that differs from it, as one stable digest. */
export async function sourceIdentity() {
  const head = (await git(["rev-parse", "HEAD"])).toString("utf8").trim();
  const changed = splitNul(await git(["diff", "--name-only", "-z", "HEAD"]));
  const untracked = splitNul(await git(["ls-files", "--others", "--exclude-standard", "-z"]));
  const paths = [...new Set([...changed, ...untracked])]
    .filter((relative) => !EVIDENCE_ONLY.has(relative))
    .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));

  const hash = createHash("sha256").update(`head:${head}\n`);
  for (const relative of paths) hash.update(await fileRecord(relative));
  return { head, digest: hash.digest("hex"), paths };
}

/** Real paths on both sides: /var and /private/var are the same file on macOS. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (invokedDirectly()) {
  const identity = await sourceIdentity();
  process.stdout.write(process.argv.includes("--json")
    ? `${JSON.stringify(identity, null, 2)}\n`
    : `${identity.head} ${identity.digest} (${identity.paths.length} changed path${identity.paths.length === 1 ? "" : "s"})\n`);
}
