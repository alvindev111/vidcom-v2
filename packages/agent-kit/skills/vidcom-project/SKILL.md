---
name: vidcom-project
description: Create, adopt, list, or orient VidCom projects through MCP. Use when selecting a workspace project or establishing project structure. Do not use for scene content, visual styling, narration, or rendering.
x-vidcom-agent-kit: 8
---

# VidCom project

Read `list_projects` before choosing a `projectId`, then call `get_project_context`. Preserve the returned identity, platform, revision, and paths. Ask before adopting, renaming, or deleting anything.

Do not edit `vidcom.json`, `index.html`, or workspace instructions with host file tools.

Example: `list_projects` → choose with the user → `get_project_context` → report platform, scenes, revision, and diagnostics.
