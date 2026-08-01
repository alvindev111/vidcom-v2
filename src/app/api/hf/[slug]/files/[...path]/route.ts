import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { statProjectFile } from "@/lib/hyperframes/projects.server";

export const dynamic = "force-dynamic";

/** `bytes=a-b`, clamped to the file. Anything else is served whole. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  // `bytes=-500` is the last 500 bytes; `bytes=500-` runs to the end.
  const start = rawStart === "" ? size - Number(rawEnd) : Number(rawStart);
  const end = rawStart === "" || rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const from = Math.max(start, 0);
  const to = Math.min(end, size - 1);
  return from > to ? null : { start: from, end: to };
}

function streamOf(path: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(
    createReadStream(path, { start, end }),
  ) as ReadableStream;
}

/**
 * Static assets of a project (sub-compositions, audio, images, fonts). The
 * preview HTML carries `<base href="/api/hf/<slug>/files/">`, so every relative
 * URL inside a composition resolves here.
 *
 * No preview-settings injection: the runtime inlines a sub-composition's body
 * into the root preview document, so the stylesheet injected there already
 * reaches it. Injecting per file would duplicate it once per scene.
 *
 * The agent rewrites these files, so nothing may be served without asking first
 * — but `no-store` meant every preview reload re-read every asset off disk and
 * buffered it whole, megabyte videos included. An ETag keeps the revalidation
 * and answers 304 when nothing moved, and Range support lets a video seek
 * without re-sending from byte zero.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; path: string[] }> },
) {
  const { slug, path } = await params;
  const file = statProjectFile(slug, path);
  if (!file) return new Response("not found", { status: 404 });

  const etag = `"${file.size.toString(36)}-${Math.trunc(file.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    "content-type": file.contentType,
    "cache-control": "no-cache",
    "accept-ranges": "bytes",
    etag,
  };

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(request.headers.get("range"), file.size);
  if (range) {
    return new Response(streamOf(file.path, range.start, range.end), {
      status: 206,
      headers: {
        ...headers,
        "content-length": String(range.end - range.start + 1),
        "content-range": `bytes ${range.start}-${range.end}/${file.size}`,
      },
    });
  }

  return new Response(streamOf(file.path, 0, Math.max(file.size - 1, 0)), {
    headers: { ...headers, "content-length": String(file.size) },
  });
}
