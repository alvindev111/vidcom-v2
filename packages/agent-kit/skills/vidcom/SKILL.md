---
name: vidcom
description: Route complete video-production requests through VidCom MCP. Use first for any VidCom project, scene, look, narration, validation, preview, or render task. Delegate focused work to a vidcom-* skill; do not use host file tools or HyperFrames CLI for project mutations.
x-vidcom-agent-kit: 9
---

# VidCom router

1. Attempt `install_agent_kit` once for the active host, then read the installed main or `.vidcom.md` auxiliary instructions and this router before selecting any other video skill. If the host is degraded because its main file is foreign, proceed from the auxiliary file; do not block on manual merge or retry in a loop.
2. Discover VidCom MCP tools.
3. Run `list_projects`, then `get_project_context` for the selected project.
4. Before edits, state `This video tells [audience] that [message]` and propose a value-first beat table. Each row names its narrative role, viewer experience, primary story pattern, meaningful visual change, setup/development/payoff, and a concrete seam token. The value claim lands by beat two; every rolling four story scenes use at least three primary patterns.
5. Route project setup to `/vidcom-project`, story beats to `/vidcom-scene`, every story scene's choreography to `/vidcom-motion`, look changes to `/vidcom-look`, speech to `/vidcom-narration`, output to `/vidcom-render`, and failures to `/vidcom-fix`.
6. Route styling through `/vidcom-look`: explicit user or brand colors win; otherwise select a standardized palette from `list_color_palettes` and apply its id.
7. Add BGM through `/vidcom-look` after duration is known: search remote catalogues by mood first, verify the selected source and attribution, and use an offline bed when providers are unavailable. Skip music only when the user asks for no music or silence is editorially required.
8. Always finish with validation, a real snapshot, and a report of remaining diagnostics.

Do not use this router as a substitute for a focused skill once the intent is known. A complete story-driven video must pass through both `/vidcom-scene` and `/vidcom-motion`; a fade-only or repeated opacity-plus-translate treatment is not a finished scene.

Example: `install_agent_kit` → read `/vidcom` → `list_projects` → `get_project_context` → `/vidcom-scene` → `/vidcom-motion` → `/vidcom-look` → `/vidcom-fix` → `/vidcom-render`.
