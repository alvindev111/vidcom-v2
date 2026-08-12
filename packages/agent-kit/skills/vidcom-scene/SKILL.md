---
name: vidcom-scene
description: Create scenes and change scene timing or text through VidCom MCP. Use for video beats, ordering, tracks, duration, and script edits. Do not use for tone, subtitles, BGM, narration generation, or rendering.
x-vidcom-agent-kit: 2
---

# VidCom scene

Start with `get_project_context`; never guess `sceneId`, track, timing, or hashes. Use `create_scene`, `set_scene_timing`, or `set_text` with the latest `expectedContentHash`. A script edit may stale its matching narration cue. On conflict, re-read and merge.

Do not create inline scene hosts or edit composition files with host tools. Use `save_file` only when the user explicitly requests raw source editing.

Time the last scene to outlive its narration by 1-3s. Cutting the video on the final consonant reads as a dropped call rather than an ending, so hold the closing frame — its title, mark, or credit line — while the music decays. Every other scene needs only its own breath (about 0.3s past its cue). When background music was sized to the old duration, re-install the bed after the change so its fade still lands on the last frame.

Example: `get_project_context` → `create_scene` at the intended index/track → `set_text` → `validate_project` → `start_snapshot`.
