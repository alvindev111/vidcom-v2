---
name: vidcom-narration
description: Author narration cues, choose voices, and generate VidCom TTS jobs. Use when scenes contain spoken copy or captions tied to speech. Do not use for BGM, scene layout, silent previews, or final rendering.
x-vidcom-agent-kit: 1
---

# VidCom narration

Read project context and scene scripts first. Use `list_tts_voices`, update the intended cue, then call `start_tts`. Treat its result as a job ID, not completed audio. Poll `get_job_status` with backoff until terminal.

Script edits can stale one narration cue; regenerate only the stale cue when possible. Do not run a TTS CLI or write WAV files directly.

Example: `get_project_context` → `list_tts_voices` → update cue → `start_tts` → backoff/poll `get_job_status` → `validate_project`.
