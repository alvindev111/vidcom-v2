# 05 — Timeline

File liên quan: [timeline.tsx](../../src/components/studio/timeline.tsx), [timeline-track.tsx](../../src/components/studio/timeline-track.tsx), [timeline-elements.tsx](../../src/components/studio/timeline-elements.tsx), [timeline-ruler.tsx](../../src/components/studio/timeline-ruler.tsx), [timeline-toolbar.tsx](../../src/components/studio/timeline-toolbar.tsx), [timeline-constants.ts](../../src/components/studio/timeline-constants.ts), [scene-order.ts](../../src/lib/studio/scene-order.ts), [root-track.server.ts](../../src/lib/hyperframes/root-track.server.ts)

Timeline nằm ở nửa dưới của PreviewPanel (38% chiều cao). Dữ liệu vào: cùng `Scene[]` mà Storyboard dùng + `RootTrack`.

---

## F-5.1 — Toolbar

**Là gì:** `Timeline · <N>` · label scene đang chọn (`3. graphics`) · timecode hiện tại · `Fit` · zoom out · `<zoom>x` · zoom in.

**Logic hiện tại:**
- `sceneCount` = số scene sau khi `orderedScenes()`.
- Timecode là `<TimeReadout>` (không nhận `currentTime` qua prop) — tick chỉ re-render span đó, không re-render cả toolbar.
- `ZOOM_LEVELS = [1, 2, 4, 8]`. `Fit` = set zoom về 1 và được highlight (`variant="secondary"`) khi zoom===1.
- Nút zoom disable ở hai đầu dải.

**Trạng thái:** THẬT.

---

## F-5.2 — Hệ toạ độ & zoom

**Logic hiện tại:**
- `TIMELINE_GUTTER_PX = 176` — bề rộng cột gutter bên trái (số + tên + mắt). Là **number** chứ không phải class Tailwind, vì layout cần nó để tính vị trí playhead bằng số học; comment ghi rõ trước đây dùng class arbitrary-value đã sinh ra offset `NaN`.
- `laneWidth` = `viewport.clientWidth - TIMELINE_GUTTER_PX`, đo bằng `ResizeObserver`.
- `fitScale = laneWidth / duration` (0 nếu duration hoặc laneWidth = 0).
- `pixelsPerSecond = fitScale * zoom`.
- Tổng bề rộng nội dung = `TIMELINE_GUTTER_PX + duration * pixelsPerSecond`; viewport `overflow-auto` để scroll ngang khi zoom.
- Gutter `sticky left-0 z-20`, ruler `sticky top-0 z-30`.

**Trạng thái:** THẬT.

**Kỳ vọng backend:** không cần.

---

## F-5.3 — Ruler + scrub

**Là gì:** Dải thước thời gian, kéo để seek, có mũi nhọn (diamond) đánh dấu playhead.

**Logic hiện tại:**
- `tickInterval(pps)` chọn bước thô nhất trong `[0.5,1,2,5,10,15,30,60]` sao cho `step*pps >= 70px`; nếu không có → lấy 60.
- Tick label dùng `formatTimecode` (`M:SS`).
- Scrub dùng **pointer capture** (không phải click): `setPointerCapture` ở `pointerdown`, `pointermove` chỉ xử lý khi `buttons === 1`. Lý do: kéo dọc ra khỏi dải vẫn phải tiếp tục scrub.
- `seconds = (clientX - rectLeft) / pixelsPerSecond`, clamp `[0, duration]`.

**Trạng thái:** THẬT.

**Vấn đề:** với `tickInterval = 0.5` mà format là `M:SS` thì hai tick liền nhau in **cùng một label** (`0:00`, `0:00`). Cần format có thập phân.

---

## F-5.4 — Playhead

**Logic hiện tại:** **một** `<Playhead>` duy nhất (component dùng chung ở [player-time.tsx](../../src/components/studio/player-time.tsx)) phủ hết mọi lane, `absolute inset-y-0 w-px`, `offset = TIMELINE_GUTTER_PX`. Comment: vẽ playhead từng lane sẽ bị "stair-step" khi các row scroll. Ẩn khi không có scene nào.

Vị trí được **ghi thẳng vào DOM**, không qua React:
```js
element.style.transform = `translate3d(${offset + store.get()*pps}px, 0, 0) ${transform}`
```
`transform` chứ không phải `left` — `left` bắt layout lại mọi lane và ruler tick phía sau, 10 lần/giây. Ruler dùng cùng component với `transform="translateX(-50%) rotate(45deg)"` để vẽ mũi nhọn diamond.

**Trạng thái:** THẬT.

---

## F-5.5 — Thứ tự và số hiệu scene (chia sẻ với Storyboard)

**Là gì:** Card ở storyboard số 3 và lane số 3 **luôn là cùng một scene**.

**Logic hiện tại** ([scene-order.ts](../../src/lib/studio/scene-order.ts)):
```
byStart = sort(scenes, by start ASC, then trackIndex ASC)
content  = byStart.filter(groupOf(s) === "scene")
layers   = byStart.filter(groupOf(s) !== "scene")
numbered = [...content, ...layers].map((s,i) => ({scene: s, index: i+1}))
```
Tức: **content beat trước (theo thứ tự phát), rồi overlay/transition**, và số hiệu chạy liên tục qua cả hai nhóm.

`groupOf(scene)` ([snapshots.ts:76](../../src/lib/studio/snapshots.ts#L76)):
1. `scene.isTransition` → `"transition"`
2. `scene.block?.tags.includes("overlay")` → `"overlay"`
3. `/overlay/i.test(scene.id)` → `"overlay"` ← **heuristic theo tên, không phải hợp đồng**
4. còn lại → `"scene"`

Comment ghi rõ: registry provenance là tín hiệu đáng tin; overlay hand-authored của các example không có bản ghi registry nên phải fallback theo tên id.

Sort dùng `trackIndex ASC` (làm tie-break khi cùng start), **khác** với `nestedHosts()` sort `trackIndex DESC` khi đọc từ HTML. Không xung đột (mỗi bên dùng cho mục đích riêng) nhưng dễ gây nhầm.

**Trạng thái:** THẬT.

**Kỳ vọng backend:** trả về `group` đã tính sẵn thay vì để client suy luận theo regex tên. Lý tưởng: có metadata tường minh trong composition (`data-hf-role="overlay|transition|scene"`).

---

## F-5.6 — Lane của scene

**Là gì:** Mỗi scene một hàng cao 40px: [chevron mở/đóng] [số] [tên] [mắt ẩn/hiện] | thanh bar theo thời gian.

**Logic hiện tại:**
- Màu bar theo `groupOf`: `scene` = accent, `transition` = amber, `overlay` = violet.
- `left = start * pps`, `width = max(duration * pps, 6)` — **không bao giờ co về 0**, để một flash 0.2s vẫn click được.
- Trạng thái hiển thị: `selected` (ring 2 + accent), `live` (đang trong khoảng phát → border accent), `hidden` (opacity 35% + tên gạch ngang).
- `live` đến từ `useLiveScenes(scenes)` — một `Set<sceneId>`, chỉ đổi khi playhead **qua ranh giới scene**, không đổi mỗi tick (xem [04](04-feature-preview-player.md) F-4.4).
- Click tên **hoặc** click bar → `onSelect(scene)` → `StudioShell.selectScene()` → set selectedId **và seek player tới `scene.start`**.
- Nút mắt → `onToggleHidden` → patch `preview-settings.scenes[id].hidden`.
- Chevron disable khi `inside === 0` (`elements.length + unresolvedEffects`), tooltip "Nothing timed inside this scene".
- `title` của bar: `formatTimecode(start) → formatTimecode(end)`.

**Trạng thái:** THẬT.

---

## F-5.7 — Lane của root track

**Là gì:** Lane riêng cho `index.html` — không có số, không chọn được, không ẩn được, icon film, nhãn `index.html`, viền nét đứt màu neutral.

**Logic hiện tại** ([root-track.server.ts](../../src/lib/hyperframes/root-track.server.ts)):
- `readRootTrack(slug)` parse `index.html`, tìm root host.
- Quét `document.body` (không phải root host) với ownership filter:
  ```js
  owns = node => { const owner = nearestHost(node); return owner === null || owner === root; }
  ```
  `nearestHost` leo `parentElement` tìm `[data-composition-id]` gần nhất. Nghĩa là: element nằm trong `#grain-overlay-comp` thuộc scene đó; element nằm trực tiếp trong root host **hoặc ngoài hẳn root host** (chỗ mà A-roll `<video>` được đặt để tránh lint `video_nested_in_timed_element`) thuộc root track.
- Trả `null` nếu `elements.length === 0 && unresolvedEffects === 0`.
- Mặc định **mở rộng** (comment: footage thường là thứ người ta canh thời gian theo).

Thực tế trong `swiss-grid/index.html`: A-roll đặt ở `<div id="short_mag_cut_frame">` **sibling của root host**, và GSAP timeline trong root điều khiển nó qua biến `v = document.getElementById(...)`.

**Trạng thái:** THẬT.

**Vấn đề:** trong 2 project mẫu, thẻ `<video>` A-roll đã bị **xoá khỏi HTML** (chỉ còn div rỗng), nên root track hiện chỉ có tween không có element media. Tween nhắm `v` (biến JS) — parser GSAP không resolve được selector kiểu này → rơi vào `unresolvedEffects`.

---

## F-5.8 — Mở rộng lane: element rows + effect rows

**Là gì:** Mở chevron của một lane → hiện các hàng con: mỗi element một hàng (depth 1), dưới mỗi element là các tween (depth 2).

**Logic hiện tại** ([timeline-elements.tsx](../../src/components/studio/timeline-elements.tsx)):

State mở/đóng:
```js
isExpanded(id) = override[id] ?? (id === ROOT_LANE || id === selectedId)
```
Tức: derived, không sync bằng effect — chỉ lưu những scene người dùng **chủ động** toggle. Chọn một scene sẽ mở nó ngay, không có render pass hiện trạng đóng trước. `ROOT_LANE = "\u0000root-track"` (key không thể trùng scene id thật).

Row element:
- Icon theo `kind`: image/video/audio/element.
- Nếu `element.start !== null` (tác giả khai timing) → bar **nét liền** accent.
- Nếu `start === null` → dùng span của các tween (`effects[0].start` → max(`start+duration`)), vẽ **nét đứt** mờ, tooltip "no authored timing — span of its tweens".
- Offset: `left = (sceneStart + start) * pps` — timing bên trong scene là tương đối, phải cộng `scene.start`.

Row effect:
- Bar hình viên thuốc, màu theo `propertyGroup`: position=sky, scale=violet, size=emerald, rotation=amber, visual=pink; không rõ → accent.
- `width = max(duration * pps, 3)` — `set` có duration 0 vẫn phải thấy được.
- Label: `<method>` + `· <ease>` nếu có.

**Trạng thái:** THẬT.

---

## F-5.9 — Cảnh báo tự động trên timeline

Đây là phần **giá trị nghiệp vụ cao nhất** của timeline — nó phát hiện bug authoring.

### (a) Tween "stranded" — chạy sau khi scene kết thúc
```js
stranded = Σ scene.elements.effects.filter(e => e.start >= scene.duration).length
```
Runtime ẩn scene khi clip window đóng, nên tween viết sau mốc đó **không bao giờ chạy**. Hiển thị: hàng cảnh báo `<N> past <duration>s` + icon amber + text `starts after this scene's clip ends — never plays. Extend data-duration or move the tween.` Từng effect stranded cũng đổi sang bar amber nét đứt.

### (b) Overrun — element kéo dài quá clip của scene
```js
inWindow = max(min(start+span, sceneDuration) - start, 0)
overrun  = max(start + span - max(start, sceneDuration), 0)
```
Vẽ **hai** bar: phần chạy được (accent) + phần bị cắt (amber nét đứt), tooltip `extends X.XXs past this scene's Ns clip — that part never plays`.

### (c) Unresolved effects — tween không parse được tĩnh
`scene.unresolvedEffects` / `track.unresolvedEffects` → hàng `<N> dynamic` + `built in a loop at runtime — no static start time to place`.

Triết lý ghi trong comment [scene-elements.server.ts:28](../../src/lib/hyperframes/scene-elements.server.ts#L28): "a made-up start time on a timeline is worse than a gap" — thà đếm và nói ra hơn là đoán.

### (d) Scene rỗng
`elements.length === 0 && unresolvedEffects === 0` → hàng `no timed elements` + `nothing in this scene carries its own timing or a GSAP tween`.

**Trạng thái:** THẬT.

**Kỳ vọng backend:** đây là **lint nghiệp vụ**. Backend mới nên đưa ra endpoint validate trả về danh sách diagnostic có cấu trúc:
```ts
{ severity: "error"|"warning", code: "stranded-tween"|"element-overrun"|"unresolved-selector"|"empty-scene",
  sceneId, elementId?, effectId?, message, fix?: { attribute, suggestedValue } }
```
và tích hợp `hyperframes check` / `hyperframes lint` (CLI đã có, app chưa gọi).

---

## Chức năng CHƯA CÓ ở timeline

| Chức năng | Ghi chú |
|---|---|
| **Kéo-thả bar để đổi start** | Không có. Chỉ sửa được bằng form số ở Scene detail |
| **Kéo mép bar để trim duration** | Không có |
| Kéo lane để đổi track index | Không có |
| Cắt (split) scene tại playhead | Không có |
| Xoá scene | Không có |
| Thêm scene tại vị trí playhead | Chỉ append cuối, qua AI Composer |
| Multi-select / group | Không có |
| Snap vào playhead / vào scene khác / vào grid | Không có |
| Undo/redo | Không có |
| Marker / chapter / comment trên timeline | Không có |
| Waveform của audio/BGM | Không có |
| Sửa keyframe/tween trực tiếp | Không có — chỉ đọc |
| Ripple edit (đẩy các scene sau khi đổi duration) | Không có — sửa duration một scene sẽ để lại khoảng trống/chồng lấn |
| Zoom bằng scroll/pinch | Không có, chỉ nút |
| Scroll theo playhead khi phát | Không có — playhead chạy ra khỏi viewport |
