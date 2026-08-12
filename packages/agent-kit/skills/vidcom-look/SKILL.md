---
name: vidcom-look
description: Adjust VidCom tone, palette, subtitle presentation, transitions, and BGM through preview settings. Use for visual or audio-bed direction. Do not use for scene structure, narration speech, diagnostics repair, or final rendering.
x-vidcom-agent-kit: 5
---

# VidCom look

Read `get_project_context` and current preview settings first. Apply look changes through the available preview-settings tool with the latest revision. Keep scene source unchanged for tone, subtitle, and BGM changes.

For every video, add BGM by default once composition duration is known. Call `search_bgm` with the intended mood first. Compare instrumental tags, duration, source, licence, and attribution; verify the chosen source rather than treating discovery as publication clearance. Pass that exact `{providerId, trackId}` to `install_bgm`, which revalidates and freezes the bytes locally. If every provider is unavailable or no result fits, call `list_bgm_beds` and install an offline bed. Skip music only when the user explicitly requests no music or silence is editorially required.

Do not use `save_file` to restyle a composition when preview settings cover the request.

Example: `get_project_context` → update preview settings → `search_bgm` → verify/select, or `list_bgm_beds` as fallback → `install_bgm` → `validate_project` → `start_snapshot` → inspect the affected frames.
