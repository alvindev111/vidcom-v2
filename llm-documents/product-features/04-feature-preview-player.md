# 04 — Preview & Player (transport)

File liên quan: [use-hyperframes-player.ts](../../src/components/studio/use-hyperframes-player.ts), [preview-canvas.tsx](../../src/components/studio/preview-canvas.tsx), [playback-bar.tsx](../../src/components/studio/playback-bar.tsx), [api/hf/[slug]/preview/route.ts](../../src/app/api/hf/[slug]/preview/route.ts), [api/hf/runtime/route.ts](../../src/app/api/hf/runtime/route.ts), [api/hf/[slug]/files/[...path]/route.ts](../../src/app/api/hf/[slug]/files/[...path]/route.ts)

---

## F-4.1 — Build tài liệu preview

**Là gì:** Endpoint trả về HTML mà player load vào iframe.

**Logic hiện tại:**
```
GET /api/hf/<slug>/preview
  └─ buildPreviewHtml(slug)
       └─ buildSubCompositionHtml(dir, "index.html", "/api/hf/runtime", "/api/hf/<slug>/files/")
            (hàm của @hyperframes/studio-server — cùng transform mà `hyperframes preview` dùng)
  └─ injectPreviewSettings(slug, html, { root: true })
       ├─ chèn <style id="hf-preview-settings"> trước </head>  (hoặc prepend nếu không có </head>)
       └─ chèn trước </body>: tone overlay + <audio id="hf-preview-bgm" class="clip">
  └─ Response 200, content-type text/html, cache-control no-store
```
Không tìm được project/entry → `404 "composition not found"` (text/plain).

`buildSubCompositionHtml` làm gì (từ package, không phải code repo này):
- Inject `<script src="/api/hf/runtime">` — runtime HyperFrames.
- Đặt `<base href="/api/hf/<slug>/files/">` để mọi URL tương đối trong composition resolve về route files.

**Trạng thái:** THẬT — dùng đúng code path của `hyperframes preview`, nên preview và render không lệch nhau.

**Kỳ vọng backend:**
- Endpoint này nên có ETag theo (mtime của mọi file trong project + hash preview-settings) để player không phải reload full khi không cần.
- Cần chế độ "preview isolated": render **một scene** riêng lẻ (hiện chỉ preview toàn bộ root).
- Cần chế độ preview theo revision/lịch sử.

---

## F-4.2 — Phục vụ runtime

**Là gì:** `GET /api/hf/runtime` trả JS IIFE của runtime HyperFrames.

**Logic hiện tại:** `getHyperframeRuntimeScript()` — constant đã build sẵn trong package. Comment giải thích tại sao **không** dùng `loadHyperframeRuntimeSource()`: hàm đó build từ `entry.ts` bằng esbuild và trả `null` với package đã publish.

`cache-control: no-store` — runtime không đổi giữa các request nhưng vẫn không cache.

**Trạng thái:** THẬT.

**Kỳ vọng backend:** cache immutable theo version package (`/api/hf/runtime?v=0.7.86`, `cache-control: public, max-age=31536000, immutable`).

---

## F-4.3 — Phục vụ asset project

**Là gì:** `GET /api/hf/<slug>/files/<...path>` trả mọi file trong project.

**Logic hiện tại:**
- `readProjectFile` → `resolveWithinProject` chặn traversal, phải là file tồn tại.
- Content-type từ `getMimeType(target)` của `@hyperframes/studio-server`.
- **Không** inject preview-settings ở đây. Comment [route.ts:18](../../src/app/api/hf/[slug]/files/[...path]/route.ts#L18): runtime inline body của sub-composition vào document root, nên stylesheet inject ở root đã tới được scene rồi; inject thêm mỗi file sẽ nhân bản stylesheet một lần mỗi scene.
  > ⚠️ **Không khớp comment:** [preview-settings.server.ts:80](../../src/lib/hyperframes/preview-settings.server.ts#L80) nói "The stylesheet goes into every composition document". Hành vi **thực tế** là chỉ inject ở `/preview`. Comment ở `preview-settings.server.ts` là tài liệu lỗi thời (có thể từ lần refactor trước). Backend mới cần chốt rõ một trong hai.
- Không có Range request → seek trong file video lớn kém hiệu quả.
- `cache-control: no-store` cho **mọi** asset, kể cả ảnh/font.

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- Range requests (206) cho video/audio.
- `cache-control` theo loại: asset immutable hash-named cache lâu, composition HTML no-store.
- ETag/If-None-Match.
- Giới hạn quyền: hiện **bất kỳ ai** đọc được mọi file trong `projects/`, kể cả `AGENTS.md`, `package.json`, `.env` nếu có.

---

## F-4.4 — Mount player & mirror state

**Là gì:** Custom element `<hyperframes-player>` được nhúng vào canvas, state của nó được mirror vào React — **trừ đồng hồ**, thứ được tách hẳn ra ngoài React.

### Kiến trúc đồng hồ: `TimeStore` (file [player-time.tsx](../../src/components/studio/player-time.tsx))

Player phát `timeupdate` ~10 lần/giây. Giữ `currentTime` trong `useState` ở đỉnh studio nghĩa là **re-render mọi thứ bên dưới** mỗi tick — cả hai pane, mọi storyboard card, mọi timeline lane, mọi tween row — chỉ để dịch một đường kẻ vài pixel. Nên đồng hồ nằm trong một external store:

```ts
interface TimeStore { get(): number; set(s: number): void; subscribe(fn: () => void): () => void }
```

- `createTimeStore()` — closure giữ `time`, `Set<listener>`; `set()` **no-op nếu giá trị không đổi**.
- `PlayerTimeProvider` — React context, đặt ở `StudioShell` bọc cả hai pane.
- 4 consumer, mỗi cái tiêu thụ đồng hồ theo cách rẻ nhất có thể:

| Hook / component | Re-render khi nào | Dùng ở đâu |
|---|---|---|
| `useCurrentTime()` | **mỗi tick** — chỉ gọi từ leaf hiển thị đúng con số | `Scrubber` trong playback bar |
| `TimeReadout` | mỗi tick, nhưng cô lập trong một `<span>` | playback bar, timeline toolbar |
| `useLiveScenes(spans)` | **chỉ khi tập scene "live" đổi** (tức qua ranh giới scene) | storyboard, timeline |
| `Playhead` | **không re-render** — ghi thẳng DOM qua `subscribe` | timeline, timeline ruler |

Chi tiết đáng chú ý:
- `useCurrentTime` / `useLiveScenes` dùng `React.useSyncExternalStore` với `getServerSnapshot` trả `0` / `""` (chưa phát gì trên server).
- `useLiveScenes` trả về **một `Set`**, không phải một id: overlay và transition chạy đè lên content scene nên nhiều lane có thể live cùng lúc. So sánh bằng **chuỗi id đã join** để React biết khi nào tập thay đổi.
- `Playhead` ghi `element.style.transform = translate3d(x,0,0)` chứ **không** dùng `left` — `left` bắt layout lại mọi lane và tick sau nó, 10 lần/giây. Có `willChange: "transform"`.
- Component ăn theo scene được `React.memo` (`SceneCard`), và callback ở `StudioShell`/`Timeline` được `useCallback` giữ identity ổn định (`toggleHidden`, `toggleExpanded(id, expanded)`, `onSelect(scene)`) — nếu không thì memo vô nghĩa.

`PlayerState` giờ **không còn `currentTime`**:
```ts
{ duration, paused, ready, muted, playbackRate, error }
```
Comment trong code: "Every field here changes a handful of times per session, so a change to this object can safely re-render the studio."

**Logic hiện tại** ([use-hyperframes-player.ts](../../src/components/studio/use-hyperframes-player.ts)):
1. `await import("@hyperframes/player")` — **client-only**, để đăng ký custom element.
2. `document.createElement("hyperframes-player")`, set `src`, `position:absolute; inset:0`, appendChild vào container ref.
3. Reset `INITIAL` state **sau** await (tránh setState đồng bộ trong effect body).
4. Listener:
   - `timeupdate` → `sync()` mirror `currentTime`, `duration`, `paused`, `muted`, `playbackRate`.
   - `ready` → set `ready:true, error:null`, **rồi `player.seek(player.currentTime)`**. Lý do (comment): runtime chỉ áp visibility per-clip trên một tick, nên frame đầu tiên hiện **mọi scene cùng lúc** — một scene ở giây thứ 10 nằm đè lên scene mở đầu. Một lần seek tại thời điểm hiện tại buộc tick đó chạy mà không dịch transport.
   - `error` / `playbackerror` / `runtimeprotocolerror` → set `error` = `detail.message ?? event.type`.
5. Nếu `player.ready` đã true trước khi gắn listener → gọi `onReady()` thủ công.
6. Cleanup: `pause()`, `remove()`, `playerRef=null`.
7. Effect dep là `[previewUrl]` → **đổi URL = remount player hoàn toàn**. Đây là cơ chế reload sau khi ghi file: `StudioShell` bump `revision` → URL thành `/preview?r=N`.

State mirror: `{ currentTime, duration, paused, ready, muted, playbackRate, error }`.

**Trạng thái:** THẬT (player thật của HyperFrames, không phải iframe tự làm).

Ngoài đồng hồ, `sync()` còn mirror `duration/paused/muted/playbackRate` vào React — nhưng có **early-return so sánh từng field**, nên tick nào không đổi gì thì `setState` trả về đúng object cũ và React bỏ qua. Nếu không, chỉ riêng việc kiểm tra `paused` 10 lần/giây cũng đã re-render cả studio.

**Vấn đề đã biết:**
- Remount player = **mất vị trí phát**: mỗi lần lưu file/sửa timing, video quay về đầu.
- Không có event `durationchange`; `duration` chỉ cập nhật qua `timeupdate`/`ready`.
- ~~`sync()` chạy mỗi tick → toàn bộ StudioShell re-render~~ → **đã xử lý** bằng `TimeStore` + early-return ở trên.

**Kỳ vọng backend:**
- Không trực tiếp; nhưng để giữ vị trí phát sau khi ghi, backend nên hỗ trợ **hot-reload từng composition** (push "composition X changed" để runtime reload riêng scene đó) thay vì buộc client remount toàn bộ.

---

## F-4.5 — Canvas letterbox

**Là gì:** Khung đen giữ đúng tỉ lệ khung hình của composition.

**Logic hiện tại:** container ngoài `containerType: size`; khung trong `aspectRatio` = `width/height` của project, `width: min(100cqw, ${100*aspectRatio}cqh)` → tự letterbox theo trục ngắn hơn. Player được append vào div **không có React children** để React không reconcile quanh node mount imperative.

Overlay trạng thái: `loading composition…` khi `!ready && !error`; message lỗi màu đỏ khi `error`.

**Trạng thái:** THẬT.

---

## F-4.6 — Playback bar

**Là gì:** Thanh điều khiển dưới canvas.

| Control | Hành vi |
|---|---|
| Play/Pause | `controls.toggle()` — gọi `player.play()`/`pause()` rồi tự đảo `paused` trong state |
| Timecode | `<TimeReadout duration>` → `formatTimecode(time) / formatTimecode(duration)`, format `M:SS`. Component riêng để tick chỉ re-render cái span này |
| Seek slider | tách thành `<Scrubber>` riêng (nó là chỗ duy nhất trong bar cần `useCurrentTime()`). `max = duration \|\| 1`, `step = 0.05` giây, `onValueChange` → `seek()` ngay (không chờ commit) |
| Mute | `player.muted = !player.muted` |
| Playback rate | Nút text, **cycle** qua `[0.5, 1, 1.5, 2]` |
| Pop out preview | `PictureInPicture2Icon` — **không có onClick** |

Toàn bộ disable khi `!state.ready`.

**Trạng thái:** THẬT, trừ Pop out = NÚT CHẾT.

**Vấn đề:** `formatTimecode` chỉ ra `M:SS` — mất phần thập phân. Với video 10s và timeline chính xác tới 0.05s, hiển thị `0:03` là quá thô; ruler timeline cũng dùng cùng format.

**Kỳ vọng backend:** không cần. Cần bổ sung phía UI: frame counter, timecode `M:SS.mmm` hoặc `HH:MM:SS:FF`, phím tắt (space, ←/→, J/K/L), loop range, in/out point.

---

## Chức năng CHƯA CÓ ở preview

| Chức năng | Ghi chú |
|---|---|
| Render / export MP4 | **Không có gì cả.** CLI có `hyperframes render`, app chưa gọi |
| Xuất frame PNG hiện tại | Không có |
| Snapshot / contact sheet | CLI có, app chỉ **đọc** kết quả |
| Fullscreen | Không có |
| Pop out / PiP | Nút chết |
| Safe-area / guide overlay | Không có |
| So sánh trước/sau khi sửa | Không có |
| Preview 1 scene riêng | Không có |
| Chọn tỉ lệ khác (9:16, 1:1) để xem trước | Không có — luôn theo `data-width`/`data-height` |
