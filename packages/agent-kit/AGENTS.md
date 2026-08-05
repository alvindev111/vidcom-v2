<!-- x-vidcom-agent-kit: 2 -->
# VidCom workspace instructions

## Skills — use these first

Start with `/vidcom`. It routes the request to one focused skill:

| Intent | Skill |
| --- | --- |
| Create, adopt, or orient a project | `/vidcom-project` |
| Add or change scenes, timing, or text | `/vidcom-scene` |
| Animate a scene, add 3D, particles, or Lottie | `/vidcom-motion` |
| Change tone, palette, subtitles, or BGM | `/vidcom-look` |
| Author narration or generate TTS | `/vidcom-narration` |
| Snapshot, render, or inspect a job | `/vidcom-render` |
| Diagnose and repair a project | `/vidcom-fix` |

## Standard workflow

1. DISCOVER the server protocol, capabilities, and tools.
2. ORIENT with `list_projects` and `get_project_context`. Never guess IDs or timing.
3. PLAN aloud. Ask when intent is ambiguous.
4. EDIT with VidCom tools and the latest hash or revision precondition.
5. VALIDATE with `validate_project`; resolve every error before completion.
6. PREVIEW with `start_snapshot` and inspect real frames.
7. NARRATE with `start_tts` only for spoken scenes.
8. RENDER with `start_render`; poll `get_job_status` with backoff.
9. REPORT changes, final revision, and every remaining diagnostic.

On `write_conflict`, re-read and merge. Never remove a precondition. Destructive work requires explicit user confirmation.

## Tool reference

| Level | Tools |
| --- | --- |
| Read | `list_projects`, `get_project_context`, `list_scenes`, `read_composition`, `list_tts_voices`, `validate_project`, `get_job_status` |
| Write | `create_scene`, `set_scene_timing`, `set_text`, `save_file`, `install_motion_library` |
| Job | `start_snapshot`, `start_tts`, `start_render` |
| Destructive | `delete_file`, `delete_scene` |
| Workspace | `install_agent_kit` |

## Project structure

- `index.html`: root composition and timeline mounts.
- `compositions/`: one file per scene.
- `assets/`: project-owned media; `assets/vendor/` holds pinned motion libraries.
- `narration/`: narration cue sidecars and generated audio.
- `preview-settings.json`: tone, subtitles, BGM, and preview settings.
- `renders/`: VidCom-produced video artifacts.

## Key rules

- Give timed elements `class="clip"`, `data-start`, `data-duration`, and `data-track-index`.
- Keep GSAP timelines paused and register them at `window.__timelines[compositionId]`.
- Add a motion library with `install_motion_library` and reference the vendored path it returns. Never load one from a CDN: the render stops being reproducible and resolves nothing offline.
- Put every new scene in a separate sub-composition file mounted with `data-composition-src`.
- A tween after its scene clip ends never runs; move it or extend the clip.
- Change tone, subtitle styling, and BGM through preview settings, not composition source.
- Keep rendering deterministic: no `Date.now()`, `Math.random()`, or network fetch.
- Do not edit project files with host file tools or run HyperFrames CLI beside VidCom. If raw source editing is explicitly requested, use `save_file` with `expectedContentHash`.

## Validate — always

Run `validate_project` after every edit. Fix all `error` diagnostics before reporting completion. Then snapshot and inspect the affected frames.

## Troubleshooting

- `write_conflict`: refresh project context and retry from the new hash/revision.
- `platform-mismatch`: align root width, height, and FPS with project platform settings.
- `narration-overflow`: shorten/re-time the cue or extend the scene within duration limits.
- `missing-asset`: restore or replace the referenced project-relative asset.
- `remote-motion-library`: run `install_motion_library` and swap the CDN tag for the returned vendored tag.
- `lint:*`: apply the named HyperFrames rule, then validate again.
