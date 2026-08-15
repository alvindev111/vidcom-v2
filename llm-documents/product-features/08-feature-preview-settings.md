# 08 — Preview editor (tone, palette, BGM, subtitles)

File liên quan: [preview-settings.ts](../../src/lib/studio/preview-settings.ts), [preview-settings.server.ts](../../src/lib/hyperframes/preview-settings.server.ts), [preview-editor.tsx](../../src/components/studio/preview-editor.tsx), [preview-controls.tsx](../../src/components/studio/preview-controls.tsx), [preview-sounds.ts](../../src/lib/studio/preview-sounds.ts), [use-preview-settings.ts](../../src/components/studio/use-preview-settings.ts)

**Nguyên tắc cốt lõi:** tất cả những gì ở đây **không bao giờ rewrite composition source**. Giá trị nằm ở `preview-settings.json`, và được **inject dưới dạng CSS + markup** khi build tài liệu preview. Đổi màu / đổi âm lượng không làm bẩn file HTML của tác giả.

Vị trí UI: tab `Preview editor` bên cạnh tab `Scene` (nửa dưới của pane Video Scene). Lưới 1 cột, 2 cột từ breakpoint `2xl`.

---

## F-8.1 — Card "Tone & lighting"

**Controls:**

| Control | Kiểu | Ghi vào |
|---|---|---|
| `Apply lighting overlay` | checkbox | `tone.enabled` |
| `Dark` / `Cream` | toggle group | `tone.colorMode` |
| `Background animation` | select (5) | `tone.backgroundFx` |
| `Background` | color picker | `tone.backgroundColor` |
| `Key light` / `Fill light` | 2 color picker | `tone.mainLight` / `tone.softLight` |
| Key light **position** | grid dot 3×3 (9 ô) | `tone.mainLightPosition` |
| Key light **intensity** | dãy 4 dot lớn dần | `tone.mainLightIntensity` |
| Fill light position / intensity | như trên | `tone.softLightPosition` / `softLightIntensity` |

**Logic render CSS** (`buildPreviewCss` — [preview-settings.ts:415](../../src/lib/studio/preview-settings.ts#L415)):
- Publish biến trên `:root`: `--bg-dark`, `--tone-bg`, `--tone-main-light`, `--tone-main-rgba`, `--tone-main-x/y`, `--tone-soft-*`, `--subtitle-*`.
- `colorMode === "cream"` → background bị **ghi đè cứng** thành `#fff3df` (bỏ qua `backgroundColor` người dùng chọn).
- `hexToRgba(color, alpha)` với alpha lấy từ `LIGHT_INTENSITIES` (`.14/.22/.30/.40`).
- Overlay markup (`buildToneOverlayHtml`) chỉ sinh khi `hasOverlay(settings)` = `tone.enabled || backgroundFx !== "none"`:
  ```html
  <div id="hf-preview-tone" aria-hidden="true">
    <div class="hf-tone-light"></div>   <!-- chỉ khi tone.enabled -->
    <div class="hf-tone-fx"></div>      <!-- chỉ khi backgroundFx !== none -->
  </div>
  ```
- `#hf-preview-tone` = `position:fixed; inset:0; z-index:2147483000; pointer-events:none`.
- `.hf-tone-light` = 2 radial-gradient (key + fill) tại vị trí đã chọn, `mix-blend-mode: screen` cho dark / `multiply` cho cream. Comment ghi rõ: chọn sai mode sẽ **cháy sáng** khung hình, nên mode là lựa chọn tường minh của tác giả chứ không đoán.
- Nếu không có layer nào bật → **không sinh markup nào cả**, để body preview giống byte-for-byte bản gốc, đảm bảo preview khớp render.

**5 hiệu ứng nền** (`fxLayer` — CSS thuần, không JS, không canvas):
| Key | Cách làm |
|---|---|
| `scan` | `repeating-linear-gradient` + `@keyframes hf-fx-scan` dịch background-position 220px/3s |
| `particles` | 4 `radial-gradient` dot với background-size khác nhau + `hf-fx-drift` translate3d 14s |
| `rings` | `repeating-radial-gradient` + `hf-fx-rings` scale 1→1.9 + fade, 6s |
| `lorenz` | 2 `conic-gradient` + `blur(28px)` + `hf-fx-spin` rotate 360° 24s |
| `none` | `display:none` |

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- Preset tone (lưu/áp dụng bộ tone đã đặt tên, dùng lại cho project khác).
- Xác nhận rằng pipeline **render** cũng inject tone overlay giống preview — hiện chưa có render nào để kiểm chứng, nguy cơ preview ≠ output.
- Cho phép nhiều đèn hơn 2, hoặc vị trí tự do (x/y %) thay vì 9 preset.
- Cho phép fx dựa trên canvas/shader (5 fx hiện tại là CSS, giới hạn).

---

## F-8.2 — Card "Palette"

**Là gì:** 6 color picker cho 6 CSS variable, publish trên `:root` của preview.

**Logic hiện tại:**
- Danh sách **cố định**: `--primary --primary-light --accent --accent-light --success --info` (`THEME_VARIABLES`).
- `normalizePreviewSettings` **loại bỏ key lạ** — chỉ 6 biến này tồn tại được.
- Composition nào có đọc các biến đó thì tự đổi màu; composition hard-code màu thì không bị ảnh hưởng.
- Patch dạng `{ theme: { variables: { "--primary": "#xxxxxx" } } }`; merge giữ các biến còn lại.

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- Cho phép biến tuỳ ý (project khác nhau dùng tên biến khác nhau) — hiện phải sửa hằng số trong code.
- Tự phát hiện biến mà composition **đang thực sự dùng** (scan `var(--...)` trong CSS) rồi chỉ hiện những biến đó.
- Import palette từ brand kit / design token.
- Contrast checker.

---

## F-8.3 — Card "Background music"

**Controls:** checkbox bật/tắt, slider volume (0–100%, step 0.01), checkbox `Loop until the video ends`, nút `Upload track`, dòng mono hiện path hiện tại.

**Logic upload** (`savePreviewBgm` — [preview-settings.server.ts:54](../../src/lib/hyperframes/preview-settings.server.ts#L54)):
1. `POST /api/hf/<slug>/preview-settings` multipart, field `file`.
2. Route check: phải là `File`, `size <= 20MB` (không thì `413`).
3. Sanitize tên: `name.replace(/[^\w.-]+/g,"-").replace(/^-+/,"")`; rỗng sau sanitize → `null` → `404`.
4. `mkdirSync(preview-assets/bgm/)`, ghi bytes.
5. Ghi settings `{ bgm: { enabled: true, track: { name, path: "preview-assets/bgm/<safeName>" } } }` — upload **tự bật** BGM.
6. Trả settings mới.

**Backend v1 và MCP hiện tại:** UI compatibility ở trên vẫn chỉ có nút upload, nhưng backend không còn upload-only:

- `search_bgm` và `GET /api/v1/bgm/search?mood=...&limit=...` tìm nhạc instrumental theo mood qua hai nguồn keyless độc lập: Openverse trước, ccMixter làm fallback. Lỗi/rate-limit của một nguồn được trả thành trạng thái `unavailable`, không làm mất nguồn còn lại; `offlineFallbackAvailable` luôn chỉ rõ còn đường offline.
- Kết quả remote chỉ cho phép Public Domain, CC0 hoặc CC BY. CC BY phải có holder và URL HTTP(S); agent/người dùng vẫn phải kiểm tra landing page vì catalog tổng hợp không chứng minh quyền thay tác giả.
- Cài bằng `{ providerTrack: { providerId, trackId } }` bắt buộc tải lại đúng track đã chọn. Bytes được đóng băng trong thư viện máy cùng licence, attribution và provenance trước khi copy vào `preview-assets/bgm/`; render không phụ thuộc mạng.
- `list_bgm_beds`/`GET /api/v1/bgm` giữ năm bed synth và thư viện máy làm fallback khi mạng/catalog không phù hợp. Agent workflow coi BGM là mặc định sau khi biết duration; chỉ bỏ khi người dùng yêu cầu hoặc im lặng có chủ đích biên tập.

**Logic phát** (`buildBgmHtml` — [preview-settings.ts:557](../../src/lib/studio/preview-settings.ts#L557)):
```html
<audio id="hf-preview-bgm" class="clip"
       src="/api/hf/<slug>/preview-assets/bgm/<file>"
       data-start="0" data-volume="0.3" loop></audio>
```
Chèn vào body của **root** preview. `class="clip"` khiến runtime HyperFrames quản lý nó theo transport → **scrub theo timeline** thay vì phát theo đồng hồ riêng. Không sinh gì nếu `!enabled || !track`.

**Trạng thái:** THẬT.

**Vấn đề:**
- Không validate loại file thật (chỉ `accept="audio/*"` phía input HTML — bypass được).
- Upload file cùng tên **ghi đè im lặng**.
- Không xoá được track cũ → `preview-assets/bgm/` tích tụ file rác.
- Không có waveform, không trim, không fade in/out, không ducking khi có narration.
- Chỉ **một** track cho cả project.
- UI card chưa expose tìm kiếm remote, attribution và trạng thái từng provider; các khả năng này hiện có qua REST/MCP.

**Kỳ vọng backend:**
- Validate magic bytes + probe (ffprobe) → trả duration, sample rate, channels.
- Nhiều track BGM với `start`/`duration`/`fadeIn`/`fadeOut`/`gain`.
- Picker UI cho thư viện máy + tìm theo mood, xem licence/attribution trước khi cài.
- Auto-ducking dưới narration.
- Normalize loudness (LUFS).
- Xoá/quản lý asset.

---

## F-8.4 — Card "Subtitles"

**Controls:** `Show subtitles` (checkbox), `Take over caption styling` (checkbox), 2 color picker (`Base`, `Active word`), slider `Font size` (8–200px), slider `Distance from the bottom` (0–900px).

**Logic hiện tại:**

Nhận diện caption (`CAPTION_SELECTOR` — [preview-settings.ts:357](../../src/lib/studio/preview-settings.ts#L357)):
```css
.caption, .subtitle, [data-hf-caption], [data-subtitle],
[class*="caption" i], [class*="subtitle" i],
[id*="caption" i], [id*="subtitle" i]
```
Comment: hook tường minh trước, rồi substring match để bắt convention thật — composition đặt tên `#caption-container`, `.caption-box`, `.caption-text` và **không bao giờ opt-in** vào attribute nào.

3 chế độ:
| Trạng thái | CSS sinh ra |
|---|---|
| `enabled=true, override=false` | Chỉ set property trên 4 selector tường minh (`.caption .subtitle [data-hf-caption] [data-subtitle]`), **không** `!important` → composition tự style vẫn giữ thiết kế |
| `enabled=true, override=true` | Áp `color/font-size/bottom` **`!important`** lên toàn bộ `CAPTION_SELECTOR`, và `<selector> .active` lấy `--subtitle-active-color` |
| `enabled=false` | `CAPTION_SELECTOR { display: none !important }` |

Default: `fontSize: 72px`, `bottom: 120px` — comment: sized cho canvas 1920×1080, không phải cho web page; caption 18px là vô hình trong khung 1080p.

**Trạng thái:** THẬT.

**Vấn đề:**
- Substring match `[class*="caption" i]` có thể bắt **sai** element (ví dụ class `caption-icon-wrapper`).
- `.active` là convention cho từ đang được đọc (karaoke) nhưng **không có nguồn timing nào sinh ra `.active`** — narration chưa có word timestamps. Nghĩa là setting `Active word` hiện gần như vô dụng.
- Chỉ có 4 thuộc tính (color/active color/size/bottom). Không có font family, weight, stroke/outline, background box, letter-spacing, line-height, max-width, alignment.

**Kỳ vọng backend:**
- Sinh caption **từ narration** với word-level timestamp (xem [07](07-feature-narration-tts.md)) → mới làm `.active` có nghĩa.
- Import/export SRT/VTT.
- Nhiều preset style caption (giống các skill `embedded-captions` của HyperFrames).
- Tách caption style thành một scene/composition riêng thay vì override CSS bằng `!important`.

---

## F-8.5 — Inject vào preview

**Logic hiện tại** (`injectPreviewSettings` — [preview-settings.server.ts:81](../../src/lib/hyperframes/preview-settings.server.ts#L81)):
```js
style = `<style id="hf-preview-settings">${buildPreviewCss(settings)}</style>`
output = html.includes("</head>") ? html.replace("</head>", style+"</head>") : style + html
if (root) {
  body = buildToneOverlayHtml(settings) + buildBgmHtml(settings, `/api/hf/${slug}/files/`)
  output = output.includes("</body>") ? output.replace("</body>", body+"</body>") : output + body
}
```
Chỉ được gọi từ `GET /preview` với `{root: true}`. Route `/files` **không** inject (xem [04](04-feature-preview-player.md) F-4.3 về comment không khớp).

Cũng ở đây: CSS `hidden` cho scene bị ẩn:
```css
[data-composition-id="<id>"], [data-composition-id="<id2>"] { display: none !important; }
```

**Trạng thái:** THẬT.

**Kỳ vọng backend:** dùng **cùng một hàm inject** cho pipeline render, nếu không preview và output sẽ khác nhau. Nên đóng gói thành module dùng chung `applyPreviewSettings(html, settings, {root})`.

---

## F-8.6 — State management phía client

**Logic hiện tại** ([use-preview-settings.ts](../../src/components/studio/use-preview-settings.ts)) — hook sống ở `StudioShell` vì **cả hai pane đều ghi vào nó** (preview editor đặt look; nút mắt từng lane trên timeline toggle cùng cờ `hidden` mà scene detail dùng).

- **Optimistic:** `apply(mergePreviewSettings(latest.current, patch))` chạy **trước** khi fetch → kéo slider/màu không chờ round-trip. Server trả `settings` đã normalize → ghi đè state (server thắng).
- `latest = useRef(settings)` — đọc đồng bộ được. Comment ghi rõ lý do: 2 edit có thể vào cùng một React batch (kéo slider + tick checkbox), edit thứ 2 phải merge lên edit thứ 1; dùng `setSettings(cur => …)` thì thấy được nhưng request phải fire **ngoài** updater — React gọi updater **hai lần** dưới StrictMode nên mọi write bị gửi server 2 lần.
- Re-seed khi `initial` (props từ RSC) đổi.
- Sau mỗi save thành công → `onSaved()` = **`rebuildPreview()`** (không phải `handleProjectChanged`) → chỉ bump revision để remount player, **không** `router.refresh()`. Remount là bắt buộc vì giá trị được bake vào tài liệu preview lúc build; nhưng re-parse project thì không cần — xem [00-overview.md](00-overview.md) §6.
- Slider dùng draft local (`onValueChange` → state, `onValueCommit` → persist) → không spam API mỗi frame kéo.
- `patchScene(sceneId, value)` merge với `sceneSettings(latest, sceneId)` rồi gửi `{scenes:{[id]: {...}}}`.
- `uploadBgm(file)` → FormData POST.

**Trạng thái:** THẬT.

**Vấn đề:** mỗi lần đổi màu vẫn = 1 lần ghi file JSON + 1 lần remount preview (video về 0s). Việc bỏ `router.refresh()` đã cắt được phần re-parse project, nhưng chưa cắt được remount player.

**Kỳ vọng backend:**
- Hỗ trợ **hot update** preview settings không cần rebuild document: expose một endpoint hoặc postMessage channel để player cập nhật `<style id="hf-preview-settings">` in-place.
- Debounce/coalesce ghi file phía server.
- Optimistic concurrency cho `preview-settings.json` (hiện đọc-merge-ghi, có race nếu 2 tab cùng sửa).

---

## F-8.7 — Web Audio synth (preview sounds)

**Là gì:** 24 âm thanh (12 transition + 12 reveal) được **tổng hợp trong browser**, không có file audio nào.

**Logic hiện tại** ([preview-sounds.ts](../../src/lib/studio/preview-sounds.ts)):
- Một `AudioContext` lazy, tạo lần đầu khi cần (`context ??= new AudioContext()` + `resume()`). Comment: browser chỉ cho tạo sau user gesture, và mọi caller ở đây đều là click.
- Primitive `tone(type, from, to, delay, attack, gain, duration, detuneVoices)`: oscillator + gain envelope (linear ramp lên attack, exponential ramp về 0.0001), `detune.value = voice * 7` cent cho voice thứ n.
- Primitive `whoosh(from, to, duration, delay)`: white noise buffer (`Math.random()*2-1`) qua bandpass filter Q=1.2 với frequency sweep.
- Mỗi sound là một hàm compose từ 1–3 primitive. Ví dụ:
  - `gong` = 2 sine 110→82Hz và 220→165Hz
  - `boom` = sine 140→40Hz + whoosh 600→120Hz
  - `retro` = 2 square detune 2 voice + whoosh 2000→500Hz
  - `bubble`/`woosh` dùng `Math.random()` → **không deterministic**
- `playTransitionSound(name)` / `playRevealSound(name)` — lookup map, no-op nếu tên lạ.

**Trạng thái:** MOCK về mục đích sử dụng — chỉ để **audition**; không phát khi play video, không có trong render. Bản thân code synth là thật và hoạt động.

**Kỳ vọng backend:** xem [06](06-feature-storyboard-scene.md) F-6.9.
