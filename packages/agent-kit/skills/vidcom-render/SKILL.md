---
name: vidcom-render
description: Create VidCom snapshots and renders and monitor their jobs. Use after edits are validated or when the user asks for preview frames or an exported video. Do not use to change scenes, styling, or narration content.
x-vidcom-agent-kit: 5
---

# VidCom render

Before validation, confirm the storyboard has a value-first story spine and each story scene source implements its motion map with setup, development, payoff, and hold. Reject scenes whose primary choreography is only a fade, gentle rise/drop, or repeated `opacity + y`; route them through `/vidcom-motion` before rendering. Also confirm `get_project_context` reports an attached BGM track, unless the user requested no music or silence is editorially required.

Run `validate_project` and stop on errors. `story-motion-shallow` means the scene lacks a meaningful change across two statically visible phases; `story-motion-unverified` means dynamic or unsupported motion could not be proven. Route either through `/vidcom-motion`; `start_render` enforces the same gate and `bestEffort` does not bypass it. Call `start_snapshot`, poll `get_job_status` with backoff, and inspect every scene's payoff frame for a visible narrative state change—not merely visible text. Then call `start_render` and poll again. Report `partial`, warnings, cleanup status, and artifacts honestly.

Do not run HyperFrames CLI beside VidCom or tight-loop job polling.

Example: review story spine and motion map → read scene sources → `/vidcom-motion` for any shallow beat → `validate_project` → `start_snapshot` → poll/inspect payoffs → `start_render` → poll → report artifact and remaining diagnostics.
