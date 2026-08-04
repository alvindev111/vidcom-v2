---
name: vidcom
description: Route complete video-production requests through VidCom MCP. Use first for any VidCom project, scene, look, narration, validation, preview, or render task. Delegate focused work to a vidcom-* skill; do not use host file tools or HyperFrames CLI for project mutations.
x-vidcom-agent-kit: 1
---

# VidCom router

1. Discover VidCom MCP tools.
2. Run `list_projects`, then `get_project_context` for the selected project.
3. State the plan and ask about ambiguity.
4. Route project setup to `/vidcom-project`, scene edits to `/vidcom-scene`, look changes to `/vidcom-look`, speech to `/vidcom-narration`, output to `/vidcom-render`, and failures to `/vidcom-fix`.
5. Always finish with validation, a real snapshot, and a report of remaining diagnostics.

Do not use this router as a substitute for a focused skill once the intent is known.

Example: `list_projects` → `get_project_context` → `/vidcom-scene` → `/vidcom-fix` → `/vidcom-render`.
