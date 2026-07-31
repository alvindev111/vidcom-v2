import { readRuntimeSource } from "@/lib/hyperframes/projects.server";

export const dynamic = "force-dynamic";

/** Serves the hyperframe runtime that `buildPreviewHtml` injects into compositions. */
export function GET() {
  return new Response(readRuntimeSource(), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
