---
name: vidcom-motion
description: Add animation to a VidCom scene with a vendored motion library — GSAP, Anime.js, Motion One, Lottie, or Three.js. Use when a scene needs movement, 3D, particles, kinetic typography, or an After Effects asset played back. Do not use for scene timing and text, tone and BGM, narration, or rendering.
x-vidcom-agent-kit: 2
---

# VidCom motion

Read `get_project_context` first. Pick one library, vendor it with `install_motion_library`, then write the timeline with `save_file` using the current `expectedContentHash`.

## Pick the library

| Need | Library | `libraryId` |
| --- | --- | --- |
| DOM and SVG motion, kinetic typography — the default | GSAP | `gsap` |
| A lighter timeline when GSAP is more than the scene needs | Anime.js | `anime` |
| Small browser-native motion over the Web Animations API | Motion One | `motion-one` |
| Playing an After Effects animation delivered as Lottie JSON | Lottie | `lottie` |
| 3D, shaders, particles | Three.js | `three` |

Plain CSS animation and the Web Animations API need no library; use them for simple, one-shot effects and skip the install.

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
