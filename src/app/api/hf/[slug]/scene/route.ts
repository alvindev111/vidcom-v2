import {
  createScene,
  updateSceneScriptLine,
  updateSceneTiming,
} from "@/lib/hyperframes/sdk.server";
import { regenerateNarration } from "@/lib/hyperframes/tts.server";

export const dynamic = "force-dynamic";

type Body =
  | {
      action: "timing";
      sceneId: string;
      start?: number;
      duration?: number;
      trackIndex?: number;
    }
  | {
      action: "script";
      sceneId: string;
      file: string;
      elementId: string;
      text: string;
    }
  | { action: "tts"; sceneId: string; text: string }
  | { action: "generate"; prompt: string };

/**
 * Every scene write goes through here: timing and text edits via the SDK, TTS
 * regeneration, and the scene creation that the mocked Codex/MCP flow triggers.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  switch (body.action) {
    case "timing": {
      const result = await updateSceneTiming(slug, body.sceneId, {
        start: body.start,
        duration: body.duration,
        trackIndex: body.trackIndex,
      });
      return result.ok
        ? Response.json({ ok: true })
        : Response.json({ error: result.error }, { status: 400 });
    }

    case "script": {
      const result = await updateSceneScriptLine(
        slug,
        body.sceneId,
        body.file,
        body.elementId,
        body.text,
      );
      return result.ok
        ? Response.json({ ok: true, narration: result.narration })
        : Response.json({ error: result.error }, { status: 400 });
    }

    case "tts": {
      const narration = regenerateNarration(slug, body.sceneId, body.text);
      return narration
        ? Response.json({ ok: true, narration })
        : Response.json({ error: "project not found" }, { status: 404 });
    }

    case "generate": {
      const prompt = body.prompt.trim();
      if (!prompt) {
        return Response.json({ error: "prompt is empty" }, { status: 400 });
      }

      const result = await createScene(slug, prompt);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      return Response.json({
        ok: true,
        sceneId: result.sceneId,
        transcript: mcpTranscript(slug, prompt, result),
      });
    }

    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}

/**
 * The tool-call trace the UI prints. The scene and its narration record are real
 * writes; the MCP session around them is scripted — no Codex process is running.
 */
function mcpTranscript(
  slug: string,
  prompt: string,
  result: {
    sceneId: string;
    start: number;
    duration: number;
  },
) {
  const { sceneId, start, duration } = result;
  return [
    { kind: "command", text: "codex" },
    {
      kind: "accent",
      text: `● Codex CLI · MCP server "hyperframes" (stdio) · workspace ${slug}`,
    },
    { kind: "output", text: "" },
    { kind: "output", text: `> ${prompt}` },
    { kind: "output", text: "" },
    { kind: "muted", text: "· mcp hyperframes.list_compositions" },
    {
      kind: "muted",
      text: `· mcp hyperframes.add_scene { id: "${sceneId}", start: ${start}, duration: ${duration} }`,
    },
    {
      kind: "muted",
      text: `· mcp hyperframes.tts { scene: "${sceneId}", voice: "af_heart" } → narration/${sceneId}.wav`,
    },
    { kind: "muted", text: "· mcp hyperframes.lint" },
    {
      kind: "accent",
      text: `✓ ${sceneId} written to index.html — open the Video Scene tab to edit it`,
    },
  ];
}
