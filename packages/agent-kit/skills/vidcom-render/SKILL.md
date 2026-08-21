---
name: vidcom-render
description: Create VidCom snapshots and renders and monitor their jobs. Use after edits are validated or when the user asks for preview frames or an exported video. Do not use to change scenes, styling, or narration content.
x-vidcom-agent-kit: 9
---

# VidCom render

Before validation, confirm the storyboard has a value-first story spine and each 6–10 second story scene source implements its motion map with setup, development, payoff, and hold across the first, middle, and final thirds. Verify at least three primary patterns in every rolling four, concrete seam tokens, and generated current narration over at least 75% of story time. Reject scenes whose primary choreography is only a fade, gentle rise/drop, or repeated `opacity + y`; route them through `/vidcom-motion` before rendering. Also confirm `get_project_context` reports an attached BGM track, unless the user requested no music or silence is editorially required.

Run `validate_project` and stop on errors. For non-ASCII copy, require a project-local `@font-face`: `font-glyph-missing` lists unsupported code points, and `font-coverage-unverified` means a machine or remote fallback has no portable byte-level proof. `story-motion-shallow` and `story-motion-unverified` require `/vidcom-motion`; `story-pattern-diversity`, `story-pattern-repeated`, `story-seam-missing`, `story-scene-duration`, `story-scene-static-too-long`, and `story-narration-sparse` require sequence, timing, seam, or narration repair. `start_snapshot` and `start_render` enforce these gates, and `bestEffort` bypasses none. Poll snapshots with backoff, inspect every scene's payoff frame, then compare the contact sheet for pattern diversity and visible cross-scene handoffs—not merely visible text. Render only after that review. Report `partial`, warnings, cleanup status, and artifacts honestly.

Do not run HyperFrames CLI beside VidCom or tight-loop job polling.

Example: review story spine and motion map → read scene sources → `/vidcom-motion` for any shallow beat → `validate_project` → `start_snapshot` → poll/inspect payoffs → `start_render` → poll → report artifact and remaining diagnostics.
