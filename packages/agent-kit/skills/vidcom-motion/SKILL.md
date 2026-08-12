---
name: vidcom-motion
description: Choreograph meaningful multi-phase motion for every VidCom story scene with GSAP or another vendored runtime. Use when motion must reveal meaning, transform visual state, demonstrate cause/effect, direct the camera, or hand off between beats. Do not use for scene timing and text, tone and BGM, narration, or rendering; fade-only entrances never satisfy this skill.
x-vidcom-agent-kit: 4
---

# VidCom motion

Read `get_project_context` first. Pick one library, vendor it with `install_motion_library`, then write the timeline with `save_file` using the current `expectedContentHash`.

## Story-motion contract

Motion is the storytelling mechanism, not decoration. Before writing source, make a motion map for every beat:

| Field | Required answer |
| --- | --- |
| Narrative role | Why this beat exists in the value-first story |
| Viewer experience | The visual world and feeling, not a layout description |
| Meaningful change | What information, state, relationship, cause/effect, or viewpoint changes |
| Choreography | Setup → development → payoff → hold |
| Motion verbs | A specific verb for every moving element |
| Handoff | How motion carries attention into the next beat |

For every non-trivial story scene:

- Compose 2-4 complementary motion patterns on one paused timeline. At least one primary action must be spatial, structural, illustrative, data-driven, camera-driven, or a visible state transformation tied to the beat's meaning.
- Use distinct phases: establish the visual world, develop or reveal the idea, land one clear payoff, then hold long enough to read. Overlap actions so the scene feels directed rather than sequentially faded.
- Vary verbs, directions, depth, and eases across scenes. Every element gets a concrete verb such as draws, assembles, counts, tracks, pushes, morphs, or locks; “animates in” is not direction.
- Treat fades, gentle rises/drops, and `opacity + y` as secondary transition polish only. A lone fade or repeated entrance recipe is shallow motion and must be redesigned before render.

## Pick the library

| Need | Library | `libraryId` |
| --- | --- | --- |
| DOM and SVG motion, kinetic typography — the default | GSAP | `gsap` |
| A lighter timeline when GSAP is more than the scene needs | Anime.js | `anime` |
| Small browser-native motion over the Web Animations API | Motion One | `motion-one` |
| Playing an After Effects animation delivered as Lottie JSON | Lottie | `lottie` |
| 3D, shaders, particles | Three.js | `three` |

Plain CSS animation and the Web Animations API need no library; use them only for secondary one-shot or ambient effects, not as the primary choreography of a story scene.

Default to GSAP and to one library per project. Two libraries animating the same element fight over its transform.

## Never load a library from a CDN

A remote `<script>` makes the render non-reproducible and resolves nothing once VidCom runs offline, which renders the scene motionless with no error. `install_motion_library` copies the pinned build into `assets/vendor/` and returns the exact `scriptTag` and `entry` path to reference — use them verbatim. A `remote-motion-library` diagnostic means a CDN tag is still in the source; replace it with the vendored tag.

Paths in the tag stay project-relative on purpose. VidCom emits a `<base href>` for both preview and render, so a rewritten or absolute path is what breaks.

## Global libraries versus a module library

Four of the five install a browser global — load the returned `scriptTag` and call the global by name. Three.js has no global: its tag runs the module but binds nothing, so import the returned `importSpecifier` inside your own module script.

```html
<script type="module">
  import * as THREE from "./assets/vendor/three-0.185.1/three.module.min.js";
  const scene = new THREE.Scene();
</script>
```

Its two vendored files must stay side by side; the module resolves its sibling by name at load time.

The tool is idempotent: an "already_installed" status means the pinned copy is present and no revision was spent.

## Write a seekable timeline

VidCom renders by seeking to each frame's timestamp, so nothing may play on its own clock:

- Create the timeline **paused** and register it as `window.__timelines[compositionId]`, where `compositionId` is the scene's `data-composition-id`.
- Drive every value from timeline position only. No `Date.now()`, no `Math.random()`, no `requestAnimationFrame` loop, no autoplay, no network fetch.
- For Three.js call `renderer.render(...)` from a timeline callback or after seeking, never from an animation loop.
- A tween starting after the scene clip ends never runs. Extend `data-duration` or move the tween.

## Example

`get_project_context` → `install_motion_library` with `libraryId: "gsap"` → `save_file` on the scene source, adding the returned `scriptTag` and a paused timeline registered on `window.__timelines` → `validate_project` → `start_snapshot`, then inspect the frames to confirm the motion actually moved.
