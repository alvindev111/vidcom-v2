---
name: vidcom-look
description: Adjust VidCom tone, palette, subtitle presentation, transitions, and BGM through preview settings. Use for visual or audio-bed direction. Do not use for scene structure, narration speech, diagnostics repair, or final rendering.
x-vidcom-agent-kit: 8
---

# VidCom look

Read `get_project_context` and current preview settings first. Apply look changes through the available preview-settings tool with the latest revision. Keep scene source unchanged for tone, subtitle, and BGM changes.

Honor explicit colors from the user or brand kit before any preset. When neither provides color direction, call `list_color_palettes` with a controlled `mood` when the brief supports one. Compare `guidance.chooseWhen`, `avoidWhen`, `energy`, `temperature`, `harmony`, and `recommendedFor`; use `source.url` and `source.swatches` as provenance, not as a popularity guarantee. Then call `set_preview_settings` with `patch.theme.paletteId`. Use the returned `defaultPaletteId` only when no catalog entry has a better rationale. Do not copy the swatches by hand: selecting the id atomically maps the sourced colors to primary, accent, background, surface, text, tone lights, and subtitle colors. A later individual color override turns the look into a custom palette and clears the preset id.

For every video, add BGM by default once composition duration is known. Call `search_bgm` with the intended mood first. Compare instrumental tags, duration, source, licence, and attribution; verify the chosen source rather than treating discovery as publication clearance. Pass that exact `{providerId, trackId}` to `install_bgm`, which revalidates and freezes the bytes locally. If every provider is unavailable or no result fits, call `list_bgm_beds` and install an offline bed. Skip music only when the user explicitly requests no music or silence is editorially required.

Do not use `save_file` to restyle a composition when preview settings cover the request.

Example: `get_project_context` → honor explicit colors or `list_color_palettes` → `set_preview_settings` → `search_bgm` → verify/select, or `list_bgm_beds` as fallback → `install_bgm` → `validate_project` → `start_snapshot` → inspect the affected frames.
