---
name: vidcom-render
description: Create VidCom snapshots and renders and monitor their jobs. Use after edits are validated or when the user asks for preview frames or an exported video. Do not use to change scenes, styling, or narration content.
x-vidcom-agent-kit: 2
---

# VidCom render

Run `validate_project` first and stop on errors. Call `start_snapshot`, poll `get_job_status` with backoff, and inspect real frames before rendering. Then call `start_render` and poll again. Report `partial`, warnings, cleanup status, and artifacts honestly.

Do not run HyperFrames CLI beside VidCom or tight-loop job polling.

Example: `validate_project` → `start_snapshot` → poll/inspect → `start_render` → poll → report artifact and remaining diagnostics.
