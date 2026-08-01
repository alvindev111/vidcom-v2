import {
  readPreviewSettings,
  savePreviewBgm,
  writePreviewSettings,
} from "@/lib/hyperframes/preview-settings.server";
import type { PreviewSettingsPatch } from "@/lib/studio/preview-settings";

export const dynamic = "force-dynamic";

/** 20 MB — a BGM bed, not a master. */
const MAX_BGM_BYTES = 20 * 1024 * 1024;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  return Response.json({ settings: readPreviewSettings(slug) });
}

/** Section-level patch: `{ tone: {...} }` leaves every other card untouched. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  let patch: PreviewSettingsPatch;
  try {
    patch = (await request.json()) as PreviewSettingsPatch;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const settings = writePreviewSettings(slug, patch);
  return settings
    ? Response.json({ ok: true, settings })
    : Response.json({ error: "project not found" }, { status: 404 });
}

/** BGM upload — multipart, one `file` field. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "no file uploaded" }, { status: 400 });
  }
  if (file.size > MAX_BGM_BYTES) {
    return Response.json({ error: "file is larger than 20 MB" }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const settings = savePreviewBgm(slug, file.name, bytes);
  return settings
    ? Response.json({ ok: true, settings })
    : Response.json({ error: "project not found" }, { status: 404 });
}
