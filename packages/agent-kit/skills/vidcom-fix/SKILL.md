---
name: vidcom-fix
description: Diagnose and repair VidCom project errors and warnings through MCP. Use after validation fails, a job reports a project problem, or assets/timing/narration are inconsistent. Do not use for unrelated creative direction or unvalidated destructive cleanup.
x-vidcom-agent-kit: 4
---

# VidCom fix

Call `validate_project` and work from diagnostic codes, not message parsing. Read current project context and the referenced source before changing anything. Apply the smallest tool mutation with current preconditions, then validate again. Ask before destructive repair.

Do not suppress diagnostics, remove preconditions, or edit files behind VidCom.

Example: `validate_project` → `get_project_context` → `read_composition` → targeted edit → `validate_project` → `start_snapshot`.
