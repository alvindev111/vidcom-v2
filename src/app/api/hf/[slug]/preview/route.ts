import { buildPreviewHtml } from "@/lib/hyperframes/projects.server";

export const dynamic = "force-dynamic";

/** The document `<hyperframes-player src>` loads into its iframe. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const html = buildPreviewHtml(slug);
  if (!html) return new Response("composition not found", { status: 404 });

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
