# 12 — Thật vs Mock vs Nút chết

Bảng kiểm kê trạng thái từng chức năng. Dùng để biết viết lại backend cần **thay** cái gì và cần **giữ** cái gì.

---

## A. THẬT — đã hoạt động, ghi/đọc đĩa thật

| Chức năng | Chi tiết |
|---|---|
| Liệt kê project | Đọc `projects/`, lọc theo `hyperframes.json` |
| Đọc metadata project | width/height/duration từ `data-*`, title từ registry/meta |
| Đọc cây file | `readProjectTree`, bỏ node_modules/.git/.hyperframes |
| Mở file text | Whitelist 10 đuôi, lazy fetch |
| Editor CodeMirror | Syntax highlight, fold, theme, ⌘S |
| Lưu file | + optimistic concurrency 409 |
| Revert local | Bỏ draft, về nội dung đĩa |
| Preview HTML | `buildSubCompositionHtml` — **đúng code path của `hyperframes preview`** |
| Serve runtime | `getHyperframeRuntimeScript()` |
| Serve asset | Mọi file trong project, mime tự động |
| Player HyperFrames | Custom element thật, transport thật |
| Play/pause/seek/mute/rate | Điều khiển player thật |
| Timeline | Toàn bộ: ruler, zoom, lane, playhead, scrub |
| Parse scene | Nested composition host + timing |
| Parse element/tween | DOM pass + GSAP static parse |
| Root track | Media & motion ở cấp entry document |
| Cảnh báo stranded/overrun/unresolved | Lint nghiệp vụ, chính xác |
| Storyboard | Card, số hiệu chia sẻ với timeline, badge group |
| Ghép frame snapshot | Đọc `snapshots/frame-*.png`, chọn frame giữa scene |
| Xuất xứ block (registry) | Đọc marker + fetch registry-item.json |
| Nhận diện transition | Theo category/tags của block |
| Liệt kê transition chồng lấn | Tính overlap |
| Liệt kê media của scene | img/video/audio/source + resolve URL |
| Sửa timing scene | Qua SDK `setTiming` → ghi `index.html` |
| Sửa text scene | Qua SDK `setText` → ghi file scene |
| Autosave script (800ms) | Có |
| Tạo scene mới | Ghi file `compositions/scene-N.html` + mount + nới root duration |
| Ghi narration sidecar | `narration/<id>.json` |
| Phát hiện wav thật | `existsSync(audioPath)` → status `generated` |
| Preview settings | Đọc/ghi `preview-settings.json`, normalize an toàn |
| Inject tone/palette/subtitle CSS | Vào tài liệu preview |
| Ẩn scene khỏi preview | CSS `display:none !important` |
| Upload BGM | Lưu `preview-assets/bgm/`, mount `<audio class="clip">` |
| BGM scrub theo timeline | Vì `class="clip"` → runtime quản lý |
| Web Audio synth 24 sound | Code synth hoạt động thật (nhưng chỉ audition) |
| Theme light/dark | next-themes |
| Layout resizable | react-resizable-panels |

---

## B. MOCK — có UI, có dữ liệu, nhưng không làm việc thật

| Chức năng | Mock ở đâu | Cái gì thật trong đó |
|---|---|---|
| **Transcript agent** (Claude/Codex) | `terminalTranscript()` — chuỗi hard-code | Không có gì. Không process, không PTY |
| **Transcript MCP** sau generate | `mcpTranscript()` — server dựng chuỗi | Chỉ dòng `add_scene` phản ánh việc thật; `list_compositions`, `tts`, `lint` đều giả |
| **AI hiểu prompt** | Không có AI | Prompt được dùng nguyên văn làm `<h2>` và text narration |
| **TTS** | `regenerateNarration` chỉ ghi JSON + lệnh CLI | Record thật, `revision` tăng, `status:"mock"`. **Không có wav** |
| **Scene sound** (transition/reveal) | Chỉ audition bằng Web Audio khi bấm Test | Lựa chọn được lưu vào JSON, nhưng không phát khi play và không vào render |
| **Thumbnail project ở Home** | `posterFor(index)` — 5 style theo vị trí | Chỉ là placeholder màu + tên project |
| **Badge "mock MCP"** | Nhãn tự thừa nhận | — |

---

## C. NÚT CHẾT — UI có, không có handler

| Nút | Vị trí | File |
|---|---|---|
| `New video` | Home, card đầu lưới | [new-project-card.tsx](../../src/components/home/new-project-card.tsx) — `<button disabled>` |
| `New file` | Header sidebar Files | [file-explorer.tsx:61](../../src/components/studio/file-explorer.tsx#L61) — không `onClick` |
| `New folder` | Header sidebar Files | [file-explorer.tsx:68](../../src/components/studio/file-explorer.tsx#L68) — không `onClick` |
| `Pop out preview` (PiP) | Playback bar, cuối | [playback-bar.tsx:100](../../src/components/studio/playback-bar.tsx#L100) — không `onClick` |

---

## D. HOÀN TOÀN CHƯA CÓ — không có UI, không có API

### Render / xuất bản
| Chức năng | CLI có? |
|---|---|
| Render MP4 | ✅ `hyperframes render` |
| Batch render | ✅ |
| Render cloud (HeyGen / AWS Lambda / Cloud Run) | ✅ |
| Publish | ✅ `hyperframes publish` |
| Xuất frame PNG hiện tại | ✅ `hyperframes snapshot` |
| Contact sheet | ✅ |
| Xuất transparent overlay | ✅ |
| Download project (zip) | ❌ |

### Chất lượng / validation
| Chức năng | CLI có? |
|---|---|
| `hyperframes check` / `lint` | ✅ — app **không gọi** |
| `hyperframes keyframes` diagnostics | ✅ |
| `hyperframes compare` / `grade-compare` | ✅ |
| `hyperframes beats` | ✅ |
| `hyperframes doctor` | ✅ |

### Quản lý project & file
- Tạo project (`hyperframes init`)
- Xoá / đổi tên / duplicate project
- Tạo / xoá / đổi tên / di chuyển file & folder
- Upload asset (ảnh/video) vào project
- Xoá asset không dùng
- Import từ zip / git

### Quản lý scene
- Xoá scene
- Duplicate scene
- Đổi `sceneId`
- Đổi thứ tự bằng kéo-thả
- Chèn scene tại vị trí bất kỳ (chỉ append cuối)
- Chuyển inline ↔ file
- Ripple edit
- Split scene tại playhead
- Thêm/xoá element trong scene
- Sửa tween (start/duration/ease)

### Registry / block
- Duyệt catalog (`hyperframes catalog`)
- Cài block (`hyperframes add`)
- Preview block trước khi cài
- Xoá / thay block đã cài

### Media
- Đọc metadata thật (dimension ảnh, duration video, codec)
- Sinh proxy / thumbnail
- Transcribe (`hyperframes transcribe` — CLI có)
- Remove background (`hyperframes remove-background` — CLI có)
- Color grade / LUT

### MCP & AI (theo D1)
- **MCP server thật** — chưa có dòng nào. Chỉ có `@modelcontextprotocol/client@2.0.0` trong `dependencies` (package **client**, không dùng làm server)
- **Dual-stack protocol** — phải phục vụ cả legacy (≤ `2025-11-25`) lẫn modern (`2026-07-28`); hai SDK không nói chuyện được với nhau
- Tool Registry protocol-agnostic
- `server/discover`, MRTR, tasks extension
- Agent CLI chạy thật (PTY / sandbox / audit)
- **Agent kit** — `AGENTS.md` + skill ship vào project để Codex/Claude Code biết quy trình

### Đóng gói & phân phối (theo D2/D3)
- Bun `--compile` thành một executable
- Nhúng frontend asset vào binary
- Directory picker server-driven + token flow
- `vidcom` CLI đa mode (`app`/`serve`/`mcp`/`worker`/`render`/`doctor`)
- Workspace lock/lease, single-writer daemon
- Giải nén sidecar runtime (Chromium, FFmpeg, TTS model) vào app-data
- Code signing, notarization, auto-update

### Cộng tác & vận hành
- Auth / user / phân quyền
- Multi-user editing (presence, CRDT)
- Undo / redo (cả cấp file và cấp composition)
- Version history / rollback
- Comment / review
- File watcher → push update
- Job queue + progress cho tác vụ dài
- Audit log
- Telemetry / analytics (CLI có `hyperframes telemetry`)

### UX còn thiếu
- Phím tắt transport (space, ←/→, J/K/L)
- Fullscreen preview
- Timecode có frame / thập phân (hiện chỉ `M:SS`)
- Loop / in-out point
- Cảnh báo khi đóng tab dirty (hiện **mất edit im lặng**)
- Tìm kiếm trong project (grep)
- Command palette

---

## E. Bug / nợ kỹ thuật đã xác định

| # | Vấn đề | File | Mức độ |
|---|---|---|---|
| 1 | Sửa **bất kỳ** dòng script nào cũng ghi đè narration bằng text dòng đó | [sdk.server.ts:157](../../src/lib/hyperframes/sdk.server.ts#L157) | Cao — sai nghiệp vụ |
| 2 | Narration chỉ lấy `script[0]` làm text mặc định | [scene-detail.tsx:187](../../src/components/studio/scene-detail.tsx#L187) | Cao |
| 3 | `openProjectFile` không qua `resolveWithinProject` → path traversal tiềm ẩn | [sdk.server.ts:25](../../src/lib/hyperframes/sdk.server.ts#L25) | Cao — bảo mật |
| 4 | Route `/files` cho đọc **mọi** file trong project | files route | Cao — bảo mật |
| 5 | Không có auth trên bất kỳ endpoint nào | toàn bộ | Cao — bảo mật |
| 6 | Đóng tab dirty **mất edit không cảnh báo** | [use-source-files.ts:90](../../src/components/studio/use-source-files.ts#L90) | Trung bình |
| 7 | Mỗi write → remount player → **video về 0s** | [studio-shell.tsx:54](../../src/components/studio/studio-shell.tsx#L54) | Trung bình — UX |
| 8 | ~~Write → re-parse 12+ lần HTML~~ — **đã giảm nhẹ** bằng `memoPerProject()` bọc cả 5 read nặng. Còn lại: `projectFingerprint()` stat toàn cây 5 lần/render, và một byte đổi làm invalidate toàn bộ | [projects.server.ts:130](../../src/lib/hyperframes/projects.server.ts#L130) · [11](11-parsing-logic.md) §9 | Thấp |
| 9 | ~~`sync()` mỗi tick → re-render cả StudioShell~~ — **ĐÃ XỬ LÝ** bằng `TimeStore` + `React.memo` + `Playhead` ghi thẳng DOM | [player-time.tsx](../../src/components/studio/player-time.tsx) | ✅ |
| 10 | `formatTimecode` chỉ `M:SS` → tick 0.5s in cùng label | [format.ts:2](../../src/lib/studio/format.ts#L2) | Thấp |
| 11 | `scene`/`preview-settings` không có optimistic concurrency | scene + preview-settings route | Trung bình |
| 12 | Ghi file không atomic (`writeFileSync` trực tiếp) | mọi chỗ ghi | Trung bình |
| 13 | `blockCache` không TTL, cache negative vô hạn | [scenes.server.ts:67](../../src/lib/hyperframes/scenes.server.ts#L67) | Thấp |
| 14 | `readBlock` timeout 4s **mỗi** block lạ → load chậm khi offline | [scenes.server.ts:75](../../src/lib/hyperframes/scenes.server.ts#L75) | Thấp |
| 15 | Comment ở `preview-settings.server.ts:80` **sai** so với hành vi thật | [preview-settings.server.ts:80](../../src/lib/hyperframes/preview-settings.server.ts#L80) | Thấp — tài liệu |
| 16 | `SourceFile.foldableLines` + `saved` là **dead field** | [types.ts:13](../../src/lib/studio/types.ts#L13) | Thấp |
| 17 | `@modelcontextprotocol/client` cài mà không dùng | package.json | Thấp |
| 18 | `rootHost()` = "phần tử đầu có width+height" — dễ chọn sai | [projects.server.ts:149](../../src/lib/hyperframes/projects.server.ts#L149) | Trung bình |
| 19 | Element key fallback `tag:rows.size` không stable | [scene-elements.server.ts:57](../../src/lib/hyperframes/scene-elements.server.ts#L57) | Thấp |
| 20 | Timing form không validate nghiệp vụ (cho phép duration ≤ 0, start âm) | [scene-timing-form.tsx](../../src/components/studio/scene-timing-form.tsx) | Trung bình |
| 21 | Upload BGM cùng tên **ghi đè im lặng**, không xoá được track cũ | [preview-settings.server.ts:54](../../src/lib/hyperframes/preview-settings.server.ts#L54) | Thấp |
| 22 | Project có HTML lỗi bị **im lặng loại khỏi danh sách**, không báo lỗi | [projects.server.ts:216](../../src/lib/hyperframes/projects.server.ts#L216) | Trung bình |
| 23 | `subtitles.activeColor` vô dụng — không có nguồn word-timestamp sinh `.active` | [preview-settings.ts:452](../../src/lib/studio/preview-settings.ts#L452) | Thấp |
| 24 | Không có file watcher — file bị sửa ngoài app không tự cập nhật | — | Trung bình |
| 25 | `.gitignore copy` — file rác trong repo | root | Thấp |
