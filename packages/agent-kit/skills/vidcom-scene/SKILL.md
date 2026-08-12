---
name: vidcom-scene
description: Create story beats and change scene timing or text through VidCom MCP. Use for a video's value-first narrative spine, beat ordering, tracks, duration, and script edits. Do not use for motion choreography, tone, subtitles, BGM, narration generation, or rendering.
x-vidcom-agent-kit: 8
---

# VidCom scene

Start with `get_project_context`; never guess `sceneId`, track, timing, or hashes. Use `create_scene`, `set_scene_timing`, or `set_text` with the latest `expectedContentHash`. A script edit may stale its matching narration cue. On conflict, re-read and merge.

Before creating scenes, state `This video tells [audience] that [message]`. Build a value-first spine: hook in outcome language, land the value claim by beat two, develop it through tension/evidence, then resolve it with a payoff. For each beat specify its narrative role, what the viewer experiences, the meaningful visual change, its motion phases, and its handoff to the next beat. Cut any beat whose role cannot be traced to the message.

After scene structure and text are in place, route every story scene through `/vidcom-motion`. A scene is not complete merely because its text fades or slides into view.

Do not create inline scene hosts or edit composition files with host tools. Use `save_file` only when the user explicitly requests raw source editing.

Time the last scene to outlive its narration by 1-3s. Cutting the video on the final consonant reads as a dropped call rather than an ending, so hold the closing frame — its title, mark, or credit line — while the music decays. Every other scene needs only its own breath (about 0.3s past its cue). When background music was sized to the old duration, re-install the bed after the change so its fade still lands on the last frame.

Example: `get_project_context` → propose the value-first beat table → `create_scene` at the intended index/track → `set_text` → `/vidcom-motion` → `validate_project` → `start_snapshot`.
