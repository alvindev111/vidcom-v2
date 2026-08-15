import { pathToFileURL } from "node:url";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function encodePortablePath(pathname) {
  return pathname.split("/").map((segment) => (
    /^[A-Za-z]:$/u.test(segment) ? segment : encodeURIComponent(segment)
  )).join("/");
}

function javascriptStringContents(value) {
  return JSON.stringify(value).slice(1, -1);
}

/** Exact spellings Bun may emit, paired with a representation-safe marker. */
export function buildRootReplacementPairs(buildRoot) {
  if (typeof buildRoot !== "string" || buildRoot.length === 0) return [];
  const slash = buildRoot.replaceAll("\\", "/");
  const encodedSlash = encodePortablePath(slash);
  const windows = WINDOWS_ABSOLUTE_PATH.test(buildRoot);
  const fileUrl = windows ? `file:///${encodedSlash}` : pathToFileURL(buildRoot).href;
  const unescapedFileUrl = windows ? `file:///${slash}` : `file://${slash}`;
  const drive = windows ? slash.slice(0, 2) : "";
  const pathMarker = windows ? `${drive}/vidcom` : "/vidcom";
  const nativeMarker = windows ? `${drive}\\vidcom` : "/vidcom";
  const fileUrlMarker = windows ? `file:///${drive}/vidcom` : "file:///vidcom";
  const replacements = new Map();
  const add = (encoding, replacement) => {
    if (encoding) replacements.set(encoding, replacement);
  };
  add(buildRoot, nativeMarker);
  add(slash, pathMarker);
  add(encodedSlash, pathMarker);
  add(fileUrl, fileUrlMarker);
  add(unescapedFileUrl, fileUrlMarker);
  add(javascriptStringContents(buildRoot), javascriptStringContents(nativeMarker));
  add(javascriptStringContents(slash), javascriptStringContents(pathMarker));
  if (windows) {
    add(`/${slash}`, `/${drive}/vidcom`);
    add(`/${encodedSlash}`, `/${drive}/vidcom`);
  }
  return [...replacements.entries()]
    .map(([encoding, replacement]) => ({ encoding, replacement }))
    .sort((left, right) => (
      right.encoding.length - left.encoding.length || compareUtf8(left.encoding, right.encoding)
    ));
}

/** Exact spellings Bun may emit for one absolute source root. */
export function buildRootEncodings(buildRoot) {
  return buildRootReplacementPairs(buildRoot).map((entry) => entry.encoding);
}

function escapedExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function containsBuildRootEncoding(source, buildRoot) {
  const flags = WINDOWS_ABSOLUTE_PATH.test(buildRoot) ? "iu" : "u";
  return buildRootEncodings(buildRoot).some((encoding) => (
    new RegExp(escapedExpression(encoding), flags).test(source)
  ));
}

export function replaceBuildRootEncodings(source, buildRoot) {
  const flags = WINDOWS_ABSOLUTE_PATH.test(buildRoot) ? "giu" : "gu";
  let output = source;
  let replacements = 0;
  for (const entry of buildRootReplacementPairs(buildRoot)) {
    output = output.replace(new RegExp(escapedExpression(entry.encoding), flags), () => {
      replacements += 1;
      return entry.replacement;
    });
  }
  return { output, replacements };
}
