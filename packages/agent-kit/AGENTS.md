<!-- x-vidcom-agent-kit: 9 -->
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

1. BOOTSTRAP by attempting `install_agent_kit` once for the active host, then read the installed main or `.vidcom.md` auxiliary instructions and `/vidcom` before choosing a workflow. Do not block on `manual_merge` or loop until ready.
2. DISCOVER the server protocol, capabilities, and tools.
3. ORIENT with `list_projects` and `get_project_context`. Never guess IDs or timing.
4. STORYBOARD before editing. State `This video tells [audience] that [message]`, then give every beat a narrative role, viewer experience, primary story pattern, meaningful visual change, setup/development/payoff, and a concrete seam token. The value claim lands by beat two. In every rolling four story scenes use at least three primary patterns.
5. EDIT + CHOREOGRAPH with VidCom tools and the latest hash or revision precondition. Mark agent-authored projects with `vidcomAgentKitVersion: 9` in `hyperframes.json`. Every story scene is 6–10 seconds, needs setup, development, payoff, and hold across its first, middle, and final thirds, and routes through `/vidcom-motion` before rendering.
6. STYLE from explicit user or brand colors when present. Otherwise call `list_color_palettes` with a controlled mood when possible; compare `chooseWhen`, `avoidWhen`, energy, temperature, harmony, and recommended uses, then apply the best id through `set_preview_settings`. Use `clean-slate` when no stronger match is justified.
7. SCORE after duration is known: call `search_bgm` with the intended mood, verify the chosen source and attribution, then pass that exact result to `install_bgm`. If remote catalogues are unavailable or unsuitable, use `list_bgm_beds` as the offline fallback. Background music is the default; omit it only when the user asks for no music or silence is editorially required.
8. VALIDATE with `validate_project`; resolve every error before completion.
9. PREVIEW with `start_snapshot` and inspect real frames.
10. NARRATE with `start_tts` for story scenes; generated, current narration must cover at least 75% of story time.
11. RENDER with `start_render`; poll `get_job_status` with backoff.
12. REPORT changes, final revision, and every remaining diagnostic.

On `write_conflict`, re-read and merge. Never remove a precondition. Destructive work requires explicit user confirmation.

## Tool reference

| Level | Tools |
| --- | --- |
| Read | `list_projects`, `list_catalog_items`, `get_project_context`, `list_scenes`, `read_composition`, `list_project_assets`, `get_narration_cues`, `list_tts_voices`, `list_color_palettes`, `search_bgm`, `list_bgm_beds`, `validate_project`, `get_job_status`, `get_render_output` |
| Write | `create_project`, `adopt_project`, `rename_project`, `create_scene`, `set_scene_timing`, `set_element_position`, `set_text`, `save_file`, `set_preview_settings`, `replace_narration_cues`, `patch_narration_cue`, `install_motion_library`, `reorder_scenes`, `move_scenes`, `generate_captions`, `mount_asset`, `install_catalog_item`, `install_bgm`, `import_bgm`, `record_bgm_license` |
| Job | `start_snapshot`, `start_tts`, `start_render`, `cancel_job` |
| Destructive | `delete_file`, `delete_scene`, `delete_scenes`, `delete_project` |
| Workspace | `install_agent_kit` |

No UI is required: `create_project` or `adopt_project` starts the work, `set_preview_settings` handles look and BGM, and `get_render_output` names the finished MP4 on disk. Only choosing the workspace directory and browsing the filesystem stay outside the tool surface.

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
- For Vietnamese, Japanese, Korean, Chinese, or any other non-ASCII text, use a project-local `@font-face`. `validate_project` reads the actual font bytes and checks every authored Unicode code point; do not trust `system-ui`, a named machine font, or a remote font to render consistently.
- Put every new scene in a separate sub-composition file mounted with `data-composition-src`.
- On every story-scene root author `data-scene-role="story"`, a content-specific `data-story-pattern`, and—after the first scene—`data-seam-kind="carry|transform|contrast"` plus a concrete `data-seam-token`. Never use `fade`, `slide`, or `cards` as a primary pattern.
- Story-driven video is the default. Build a value-first spine: hook in the viewer's language, tension or evidence that develops the claim, and a payoff that resolves it.
- A scene is a story beat, not a slide. Its motion must reveal information, transform visual state, demonstrate cause/effect, move the camera to a new idea, or physically hand off to the next beat.
- Give every non-trivial story scene multi-phase choreography: setup → development → payoff → hold. Compose 2-4 motion patterns and vary motion verbs, directions, and eases across scenes.
- Distribute verified actions across the first, middle, and final thirds. Over every rolling four story scenes, keep at least three primary patterns; repeated adjacent patterns need a matching carry/transform token and a visible state handoff.
- A lone fade, gentle rise/drop, or repeated `opacity + y` entrance is transition polish, not scene motion. Never use it as the primary choreography or repeat one entrance recipe across the video.
- A tween after its scene clip ends never runs; move it or extend the clip.
- Move a selected authored element or caption group with `set_element_position`; use the exact `data-hf-id` and current source hash, never a selector or client-supplied source path.
- End on a held frame: the last scene runs 1-3s past its narration, every other scene about 0.3s. A video that stops on the final consonant feels cut off, not finished.
- Change colors, tone, subtitle styling, and BGM through `set_preview_settings`, not composition source. Explicit user or brand colors always win; otherwise choose from the source-backed `list_color_palettes` guidance and apply `theme.paletteId`. An individual color override intentionally clears the preset id.
- Background music is the default for every video unless the user requests no music or silence is editorially required. Add it after composition duration is known.
- A file a person copied into the project never announces itself: run `list_project_assets` to find it, then attach a track with `set_preview_settings`.
- Prefer `search_bgm` for real mood-matched instrumental music. Inspect `sourceUrl`, `license`, and `attribution`; pass only the chosen `{providerId, trackId}` to `install_bgm`, which revalidates that exact track and freezes its bytes, licence, and provenance locally. Never invent clearance from a search result.
- Remote music is fail-soft: if providers are empty, rate-limited, or unsuitable, `list_bgm_beds` shows five built-in beds and `install_bgm` renders one at the project's own length. `import_bgm` records a supplied track's licence — state `unknown` rather than guessing, and use `record_bgm_license` only after somebody establishes the answer.
- Keep rendering deterministic: no `Date.now()`, `Math.random()`, or network fetch.
- Do not edit project files with host file tools or run HyperFrames CLI beside VidCom. If raw source editing is explicitly requested, use `save_file` with `expectedContentHash`.

## Validate — always

Run `validate_project` after every edit. Fix all `error` diagnostics before reporting completion. Then snapshot and inspect the affected frames.

## Troubleshooting

- `write_conflict`: refresh project context and retry from the new hash/revision.
- `platform-mismatch`: align root width, height, and FPS with project platform settings.
- `narration-overflow`: shorten/re-time the cue or extend the scene within duration limits.
- `missing-asset`: restore or replace the referenced project-relative asset.
- `story-motion-shallow`: redesign the beat with a meaningful state change across at least two statically visible phases; fade/position polish does not count.
- `story-motion-unverified`: replace dynamic selectors with resolvable targets or add meaningful, statically verifiable GSAP choreography before render.
- `story-metadata-missing`, `story-seam-missing`: add the v9 scene role, pattern, and concrete seam metadata.
- `story-pattern-repeated`, `story-pattern-diversity`: redesign the sequence so a rolling four uses at least three primary patterns and any continuation has a visible matching handoff.
- `story-scene-duration`: retime generated story scenes to 6–10 seconds.
- `story-scene-static-too-long`: add current narration and continuing middle/final state change, or split the beat into shorter scenes.
- `story-narration-sparse`: generate current narration until its clamped windows cover at least 75% of story time.
- `remote-motion-library`: run `install_motion_library` and swap the CDN tag for the returned vendored tag.
- `text-encoding-invalid`: re-save the referenced source as UTF-8 without replacement bytes.
- `font-file-invalid`: restore or replace the referenced local OpenType font file.
- `font-glyph-missing`: choose a local font whose `cmap` covers every code point listed in `details.missingCodePoints`.
- `font-coverage-unverified`: vendor the selected font into the project and bind it with `@font-face`; machine or remote fallback is not portable evidence.
- `lint:*`: apply the named HyperFrames rule, then validate again.
