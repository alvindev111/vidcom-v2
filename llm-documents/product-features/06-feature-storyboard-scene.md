# 06 — Storyboard & Scene detail (tab "Video Scene")

File liên quan: [scene-pane.tsx](../../src/components/studio/scene-pane.tsx), [scene-storyboard.tsx](../../src/components/studio/scene-storyboard.tsx), [scene-card.tsx](../../src/components/studio/scene-card.tsx), [scene-detail.tsx](../../src/components/studio/scene-detail.tsx), [scene-timing-form.tsx](../../src/components/studio/scene-timing-form.tsx), [scene-media-list.tsx](../../src/components/studio/scene-media-list.tsx), [scene-script-editor.tsx](../../src/components/studio/scene-script-editor.tsx), [scene-audio.tsx](../../src/components/studio/scene-audio.tsx), [snapshots.ts](../../src/lib/studio/snapshots.ts), [sdk.server.ts](../../src/lib/hyperframes/sdk.server.ts)

Layout: split dọc — Storyboard 52% / (tabs `Scene` | `Preview editor`) 48%.

---

## F-6.1 — Storyboard shelf

**Là gì:** Lưới card 2 cột (3 cột từ breakpoint `xl`) hiển thị các **content beat** theo thứ tự phát. Overlay/transition bị gấp vào một section thu gọn riêng.

**Logic hiện tại:**
- `splitScenes(scenes)` — cùng hàm mà timeline dùng (xem [05](05-feature-timeline.md) F-5.5) → số hiệu card khớp số hiệu lane.
- Header: `Storyboard · <số content scene>`.
- Nếu có content scene thiếu frame: hiện `<N> without a frame — run hyperframes snapshot` kèm icon camera.
- Section `Overlays & transitions · <N>` — nút toggle, **mặc định đóng**.
- Nếu 0 content scene: `No content scenes yet — ask the agent in the AI Composer tab to add one.`

**Trạng thái:** THẬT.

---

## F-6.2 — Scene card

**Là gì:** Ô 16:9 với ảnh frame (nếu có), badge số hiệu góc trên trái, badge group (transition/overlay) góc trên phải, dot "live" góc dưới phải khi playhead đang ở trong scene, và dưới ô là tên scene + `0:04 → 0:08 · 4s`.

**Logic hiện tại:**
- `live` = `useLiveScenes(scenes).has(scene.id)` — tính ở `SceneStoryboard`, chỉ đổi khi playhead qua ranh giới scene (xem [04](04-feature-preview-player.md) F-4.4).
- `SceneCard` được bọc `React.memo`, và `onSelect` nhận `scene` làm tham số (thay vì closure `() => onSelect(scene)`) để handler giữ identity ổn định → qua một ranh giới scene chỉ **2 card** repaint, không phải cả storyboard.
- `hidden` (theo preview-settings) → ảnh `opacity-40 grayscale`, tên gạch kèm icon `EyeOffIcon`.
- Không có frame → icon `ImageOffIcon`.
- Click card → `onSelect(scene)` → set selectedId + **seek player tới `scene.start`**. Comment: "the point of a storyboard is to jump around by looking, not by scrubbing".

**Trạng thái:** THẬT.

---

## F-6.3 — Ghép frame snapshot vào scene

**Là gì:** Tìm ảnh đại diện cho mỗi scene từ các file snapshot có sẵn.

**Logic hiện tại** ([snapshots.ts](../../src/lib/studio/snapshots.ts)):
- `FRAME_PATTERN = /^frame-\d+-at-([\d.]+)s\.png$/` — quy ước tên do `hyperframes snapshot` sinh ra.
- `collectFrames(tree)` đi đệ quy **cây file đã có sẵn** ở client (không gọi API mới), trả `{path, seconds}[]` sort theo giây.
- `frameForScene(frames, scene)`:
  1. Lấy các frame nằm trong `[scene.start, scene.start + duration)`.
  2. Nếu có → chọn frame **gần giữa scene nhất** (không phải frame đầu). Lý do trong comment: nhiều scene bắt đầu ở 0s, chọn frame 0s cho tất cả làm storyboard trông như một poster bị lặp.
  3. Không có → lấy frame cuối cùng có `seconds <= scene.start`.
  4. Không có nữa → `null`.
- `frameUrl(slug, frame)` = `/api/hf/<slug>/files/<frame.path>`.

**Trạng thái:** THẬT (đọc), nhưng **sinh snapshot là MOCK/thiếu** — app không chạy được `hyperframes snapshot`, chỉ nhắc người dùng tự chạy CLI. Chỉ `warm-grain` có snapshots; 2 project còn lại không có frame nào.

**Kỳ vọng backend:**
- `POST /projects/:slug/snapshots` — chạy `hyperframes snapshot` (hoặc headless capture nội bộ), có option `{ at?: number[], perScene?: boolean, contactSheet?: boolean }`.
- Tự sinh snapshot **theo scene** (một frame giữa mỗi scene) thay vì theo mốc thời gian đều — hiện phải suy đoán ngược.
- Invalidate snapshot khi composition đổi (hiện frame cũ vẫn hiện cho scene đã sửa).
- Là job async có progress (render frame tốn giây).

---

## F-6.4 — Scene detail: header + điều hướng

**Là gì:** Tiêu đề = `scene.id`, dòng dưới = `scene.src` hoặc `inline in index.html`. Nút `Go to 0:04` để seek.

**Trạng thái:** THẬT.

---

## F-6.5 — Sửa timing scene (start / duration / track)

**Là gì:** Form 3 input number + nút `Save timing`.

**Logic hiện tại:**
- Client ([scene-timing-form.tsx](../../src/components/studio/scene-timing-form.tsx)):
  - `step` = 0.1 cho start/duration, 1 cho track.
  - Re-seed khi `seed = "<id>:<start>:<duration>:<trackIndex>"` đổi (chọn scene khác, hoặc server trả giá trị mới) — pattern "derived state during render", không dùng effect.
  - Nút disable khi `!dirty || !valid || pending`. `valid` = cả 3 field không rỗng và `Number.isFinite`.
  - **Không validate nghiệp vụ:** cho phép `start` âm, `duration` = 0 hoặc âm, `start + duration` vượt duration root.
- Server (`updateSceneTiming` — [sdk.server.ts:104](../../src/lib/hyperframes/sdk.server.ts#L104)):
  1. `openComposition(index.html)` ở **headless mode** (không có persist adapter) — SDK chỉ là transform + serializer, module này tự ghi, nên edit lỗi không để lại file nửa vời.
  2. `findByCompositionId(roots, sceneId)` — DFS tìm element có `data-composition-id` khớp.
  3. Không thấy → `{ok:false, error:"scene <id> not found"}` → HTTP 400.
  4. `composition.can({type:"setTiming", target: host.scopedId, ...timing})` — nếu SDK từ chối, trả message của SDK.
  5. `composition.setTiming(scopedId, timing)` → `writeFileSync(serialize())` → `dispose()`.
- Sau khi ok: `onProjectChanged()` → preview remount + RSC refresh.

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- Validate nghiệp vụ: `duration > 0`, `start >= 0`, cảnh báo khi `start+duration > rootDuration` (và đề nghị nới root, như `createScene` đang làm).
- **Ripple mode:** đổi duration của scene thì đẩy các scene sau — hiện phải sửa tay từng scene.
- Trả về `Scene` đã cập nhật (kể cả `rootDuration` mới) thay vì chỉ `{ok:true}` — hiện client buộc phải refresh cả trang.
- Undo (revision của composition).
- Batch: sửa nhiều scene trong một transaction.

---

## F-6.6 — Danh sách media của scene

**Là gì:** Section `Images & media · <N>`, mỗi item: thumbnail (ảnh thật) hoặc icon (film/audio), `src` nguyên văn, dòng meta `image · 0:02 → 0:05`.

**Logic hiện tại** (`collectMedia` — [scenes.server.ts:37](../../src/lib/hyperframes/scenes.server.ts#L37)):
- Query `img, video, audio, source`.
- Với `<source>`: owner là `parentElement` (tức `<video>`/`<audio>`).
- Kind theo tag của owner; tag khác → bỏ.
- Không có `src` → bỏ.
- `mediaUrl(slug, hostFile, src)`: URL tuyệt đối (`http://`, `//`, `data:`) → giữ nguyên; ngược lại resolve **theo thư mục của file composition chứa nó** rồi thành `/api/hf/<slug>/files/<resolved>`.
- Timing lấy từ `readClipTiming(owner)`, `duration ?? end`, có thể `null`.

**Trạng thái:** THẬT (chỉ đọc).

**Kỳ vọng backend:**
- Upload media vào project (`POST /projects/:slug/assets`), sinh proxy/thumbnail.
- Thay media của một element.
- Đọc metadata thật: kích thước ảnh, thời lượng video/audio, codec — hiện không có gì.
- Báo media **thiếu file** (src trỏ tới file không tồn tại) — hiện hiện thumbnail lỗi im lặng.
- Xoá media không dùng.

---

## F-6.7 — Sửa script (text trên màn hình)

**Là gì:** Section `Script · <N>`, mỗi dòng copy trong scene là một `<textarea>` autosize, autosave sau khi ngừng gõ.

**Logic đọc** (`readSceneScript` + `scriptLines` — [sdk.server.ts:44](../../src/lib/hyperframes/sdk.server.ts#L44)):
- Mở file scene (hoặc `index.html` với scene inline) bằng SDK.
- Đệ quy element; **bỏ** `script`, `style`, `template`.
- Chỉ lấy **leaf** (`children.length === 0`).
- Text = `element.text` normalize whitespace, và **chỉ nhận nếu `1 < length < 400`**.
- Trả `{ id: element.scopedId, text, file }` — `scopedId` là hf-id đã scope, chính là target của `setText`.
- Scene inline: chỉ đi subtree của host (`findByCompositionId(...).children`), không lấy cả file.

**Logic ghi** (`updateSceneScriptLine` — [sdk.server.ts:136](../../src/lib/hyperframes/sdk.server.ts#L136)):
1. Mở đúng `file` mà client gửi lên (không phải index.html).
2. `can({type:"setText", target: elementId, value: text})` → từ chối thì trả message SDK.
3. `setText` → `serialize()` → ghi.
4. **Tự động gọi `regenerateNarration(slug, sceneId, text)`** — comment: script đổi thì narration của scene đó cũ, nên TTS chạy lại.
5. Trả `{ok:true, narration}`.

**Logic autosave client** ([scene-script-editor.tsx](../../src/components/studio/scene-script-editor.tsx)):
- `AUTOSAVE_DELAY = 800ms` sau lần gõ cuối.
- Cũng save `onBlur` nếu dirty.
- Re-seed draft khi server trả text khác.
- **Bug đã được fix và ghi lại trong comment:** callback commit giữ trong `useRef` chứ không đọc từ closure, vì component cha re-render mỗi player tick và trả `onSave`/`line` mới → timer bị clear/restart liên tục nên autosave **chưa từng fire**. Nguyên nhân gốc (đồng hồ nằm trong React state ở tầng trên) nay đã được xử lý bằng `TimeStore` — xem [04](04-feature-preview-player.md) F-4.4 — nhưng phòng thủ bằng ref vẫn nên giữ.

**Trạng thái:** THẬT.

**Vấn đề đã biết:**
- Heuristic "leaf + 1<len<400" bắt **mọi** text, kể cả label trang trí, số liệu, ký tự đơn lẻ bị loại (len<=1). Không phân biệt "câu thoại" và "nhãn UI".
- Mỗi lần ghi rewrite cả file qua `serialize()` → thay đổi indentation toàn file, diff git rất ồn.
- Không có kiểm tra `baseVersion` như `PUT /source` → **sửa script có thể ghi đè edit đồng thời của agent mà không cảnh báo**.
- Sửa 1 dòng = 1 request = 1 lần rewrite file = 1 lần regenerate narration = 1 lần refresh cả trang.

**Kỳ vọng backend:**
- Có optimistic concurrency cho scene edit (giống `PUT /source`).
- Batch nhiều dòng trong 1 request.
- Đánh dấu tường minh element nào là "script/thoại" (ví dụ `data-hf-script`) thay vì heuristic.
- Tách quyết định "có regenerate TTS không" ra khỏi ghi text (hiện luôn regenerate, không tắt được).
- Trả `Scene` mới thay vì bắt refresh toàn trang.

---

## F-6.8 — Section Transition

**Là gì:** Hiển thị bối cảnh transition của scene đang chọn.

**Logic hiện tại:**
- Nếu scene **là** transition: card viền accent hiện `block.title ?? block.name`, `block.description`, dòng mono `block <name> · <tags…>`.
- Nếu không: liệt kê các transition **chồng lấn thời gian** với scene này:
  ```js
  overlapping = transitions.filter(t => t.id !== scene.id && t.start < end && t.start + t.duration > scene.start)
  ```
  Mỗi item có nút `Preview` → seek tới `t.start`.
- Không có gì chồng lấn: hướng dẫn `hyperframes add <block>` + mount bằng `data-composition-src`.

`transitions` = `scenes.filter(s => s.isTransition)`, tính ở ScenePane.

**Trạng thái:** THẬT (chỉ đọc + seek).

**Kỳ vọng backend:**
- `GET /registry/blocks?category=transitions` — duyệt registry từ trong app.
- `POST /projects/:slug/blocks` `{ name, start, duration, trackIndex }` — chạy `hyperframes add` **và** mount vào index.html.
- Xoá / thay transition.
- Preview một block trước khi cài.

---

## F-6.9 — Section Scene sound

**Là gì:** 2 dropdown (`Enter transition`, `Element reveal`) + 2 nút `Test` + nút `Hide from preview` / `Restore in preview`.

**Logic hiện tại** ([scene-audio.tsx](../../src/components/studio/scene-audio.tsx)):
- 12 lựa chọn transition sound, 12 reveal sound (xem [01](01-domain-model.md) §4).
- `Test` gọi `playTransitionSound()` / `playRevealSound()` → **synth Web Audio ngay trong browser**, không có file audio.
- Lưu vào `preview-settings.json` → `scenes[sceneId].{transitionSound,revealSound}`.
- `hidden` toggle → CSS `[data-composition-id="<id>"] { display:none !important }` được inject vào preview. Ghi chú UI: "Hidden in the preview only — the scene is still in index.html and still renders."

**Trạng thái:** MOCK ở phần âm thanh — comment ghi rõ: "The sounds are auditioned with the WebAudio synth rather than rendered into the composition — they describe the intent for the scene". Tức chọn xong **không có gì phát khi play video, và không đi vào bản render**. `hidden` là THẬT (ảnh hưởng preview).

**Kỳ vọng backend:**
- Quyết định: hoặc (a) render sound thành file wav và mount `<audio class="clip" data-start>` vào composition, hoặc (b) giữ là intent metadata và để pipeline render đọc.
- Nếu (a): endpoint `POST /projects/:slug/scenes/:id/sound` sinh wav từ tham số synth, lưu `preview-assets/sfx/`, mount vào scene.
- Cho phép upload SFX riêng thay vì chỉ 24 preset.
- Volume/offset cho từng sound.

---

## F-6.10 — Trạng thái pending / error dùng chung

**Logic hiện tại** ([scene-pane.tsx:68](../../src/components/studio/scene-pane.tsx#L68)):
- `submit(edit)` là hàm duy nhất cho cả 3 action `timing | script | tts`, gọi `PATCH /api/hf/<slug>/scene`.
- `busy = pending || preview.pending` — **một cờ chung**: đang lưu script thì nút Save timing cũng disable.
- `problem = error ?? preview.error` — một chỗ hiện lỗi.
- Lỗi không ok: đọc `payload.error`, fallback `save failed (<status>)`.

**Kỳ vọng backend:** trả mã lỗi có cấu trúc (`{ code, message, field? }`) để UI gắn lỗi vào đúng field thay vì một dòng chung.

---

## Chức năng CHƯA CÓ ở Scene

| Chức năng | Ghi chú |
|---|---|
| Xoá scene | Không có |
| Duplicate scene | Không có |
| Đổi tên scene id | Không có |
| Đổi thứ tự scene bằng kéo-thả | Không có |
| Tạo scene tại vị trí bất kỳ | Chỉ append cuối qua AI Composer |
| Chuyển scene inline ↔ scene file | Không có |
| Sửa style/layout scene bằng UI | Không có — phải sửa HTML thô |
| Thêm/xoá element trong scene | Không có |
| Sửa tween (start/duration/ease) | Không có — chỉ xem trên timeline |
| Thư viện template scene | Không có |
