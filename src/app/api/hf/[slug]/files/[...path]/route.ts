import { readProjectFile } from "@/lib/hyperframes/projects.server";

export const dynamic = "force-dynamic";

/**
 * Static assets of a project (sub-compositions, audio, images, fonts). The
 * preview HTML carries `<base href="/api/hf/<slug>/files/">`, so every relative
 * URL inside a composition resolves here.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; path: string[] }> },
) {
  const { slug, path } = await params;
  const file = readProjectFile(slug, path);
  if (!file) return new Response("not found", { status: 404 });

  const body =
    typeof file.body === "string" ? file.body : new Uint8Array(file.body);

  return new Response(body, {
    headers: {
      "content-type": file.contentType,
      "cache-control": "no-store",
    },
  });
}
