import {
  readSourceFile,
  writeSourceFile,
} from "@/lib/hyperframes/projects.server";

export const dynamic = "force-dynamic";

/** 2 MB — a composition, not an asset. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** One editable text file of the project, opened by the code editor. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const path = new URL(request.url).searchParams.get("path");
  if (!path) return Response.json({ error: "path is required" }, { status: 400 });

  const file = readSourceFile(slug, path);
  return file
    ? Response.json({ file })
    : Response.json({ error: "file is not editable" }, { status: 404 });
}

/**
 * Save an edited file.
 *
 * `baseVersion` is the version the editor loaded. The agent and the SDK write
 * these same files, so a mismatch means someone else got there first and the
 * write is refused rather than silently overwriting their work.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  let body: { path?: string; code?: string; baseVersion?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.path || typeof body.code !== "string") {
    return Response.json({ error: "path and code are required" }, { status: 400 });
  }
  if (body.code.length > MAX_SOURCE_BYTES) {
    return Response.json({ error: "file is larger than 2 MB" }, { status: 413 });
  }

  const result = writeSourceFile(slug, body.path, body.code, body.baseVersion);
  return result.ok
    ? Response.json({ ok: true, file: result.file })
    : Response.json({ error: result.error }, { status: result.status });
}
