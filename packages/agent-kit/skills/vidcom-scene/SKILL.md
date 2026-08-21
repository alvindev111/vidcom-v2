---
name: vidcom-scene
description: Create story beats and change scene timing or text through VidCom MCP. Use for a video's value-first narrative spine, beat ordering, tracks, duration, and script edits. Do not use for motion choreography, tone, subtitles, BGM, narration generation, or rendering.
x-vidcom-agent-kit: 9
---

# VidCom scene

Start with `get_project_context`; never guess `sceneId`, track, timing, element identity, or hashes. Use `create_scene`, `set_scene_timing`, `set_element_position`, or `set_text` with the latest `expectedContentHash`. `set_element_position` accepts only the exact authored `data-hf-id` returned by the current scene projection; it never accepts a selector or source path. A script edit may stale its matching narration cue. On conflict, re-read and merge.

Before creating scenes, state `This video tells [audience] that [message]`. Build a value-first spine: hook in outcome language, land the value claim by beat two, develop it through tension/evidence, then resolve it with a payoff. For each beat specify its narrative role, what the viewer experiences, a content-specific primary pattern, the meaningful visual change, setup/development/payoff, and its concrete handoff to the next beat. Cut any beat whose role cannot be traced to the message.

Mark agent-authored projects with `vidcomAgentKitVersion: 9` in `hyperframes.json`. Time each generated story scene to 6–10 seconds. Author `data-scene-role="story"` and `data-story-pattern` on every story root; after the first scene add `data-seam-kind="carry|transform|contrast"` plus a concrete `data-seam-token` naming the object, shape, color, direction, or question passed across the cut. Plan at least three primary patterns in every rolling four scenes. `fade`, `slide`, and `cards` are not primary pattern names.

After scene structure and text are in place, route every story scene through `/vidcom-motion`. A scene is not complete merely because its text fades or slides into view.

Do not create inline scene hosts or edit composition files with host tools. Use `save_file` only when the user explicitly requests raw source editing.

Time the last scene to outlive its narration by 1-3s. Cutting the video on the final consonant reads as a dropped call rather than an ending, so hold the closing frame — its title, mark, or credit line — while the music decays. Every other scene needs only its own breath (about 0.3s past its cue). When background music was sized to the old duration, re-install the bed after the change so its fade still lands on the last frame.

Example: `get_project_context` → propose the value-first beat table → `create_scene` at the intended index/track → `set_text` → `/vidcom-motion` → `validate_project` → `start_snapshot`.
