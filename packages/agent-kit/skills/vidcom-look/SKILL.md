---
name: vidcom-look
description: Adjust VidCom tone, palette, subtitle presentation, transitions, and BGM through preview settings. Use for visual or audio-bed direction. Do not use for scene structure, narration speech, diagnostics repair, or final rendering.
x-vidcom-agent-kit: 4
---

# VidCom look

Read `get_project_context` and current preview settings first. Apply look changes through the available preview-settings tool with the latest revision. Keep scene source unchanged for tone, subtitle, and BGM changes.

For every video, add a BGM bed by default once composition duration is known: call `list_bgm_beds`, choose a bed that matches the intended mood, then call `install_bgm` with the latest revision. Skip music only when the user explicitly requests no music or silence is editorially required.

Do not use `save_file` to restyle a composition when preview settings cover the request.

Example: `get_project_context` → update preview settings → `list_bgm_beds` → `install_bgm` → `validate_project` → `start_snapshot` → inspect the affected frames.
