# 13 — Yêu cầu chức năng cho backend mới

Tài liệu này tổng hợp **"mong muốn nó có thể làm được gì"** — chức năng đích, không phải cách hiện thực.

Kiến trúc local-first đề xuất để hiện thực các yêu cầu này được trình bày tại [14-local-first-mcp-packaging-architecture.md](14-local-first-mcp-packaging-architecture.md). Tài liệu 14 hiện là định hướng thảo luận, chưa phải Detailed Design đã duyệt.

---

## 1. Nguyên tắc phải giữ lại

Đây là những quyết định thiết kế **đúng** của bản mock, viết lại backend phải bảo toàn:

| # | Nguyên tắc | Lý do |
|---|---|---|
| P1 | **Hợp đồng `data-*` trên HTML là nguồn sự thật**, không phải metadata JSON | API metadata của package báo sai (xem [11](11-parsing-logic.md) §1) |
| P2 | **Preview settings không bao giờ rewrite composition source** — chỉ inject CSS/markup | Đổi màu/âm lượng không làm bẩn file tác giả |
| P3 | **Preview và render dùng cùng một code path** (`buildSubCompositionHtml` + cùng hàm inject) | Preview khớp output |
| P4 | **Project chưa bật tone thì render y nguyên bản gốc** (byte-for-byte body) | Bật overlay mặc định đã làm trắng bợt project nền cream |
| P5 | **Đếm, không đoán** — tween không parse được thì báo số lượng, không bịa start time | "a made-up start time on a timeline is worse than a gap" |
| P6 | **Một thứ tự scene duy nhất** dùng chung storyboard + timeline | Trước đó 2 pane đánh số độc lập và không khớp nhau |
| P7 | **Optimistic concurrency khi ghi file** | Agent/CLI cùng ghi các file này |
| P8 | **Không autosave code**, có autosave cho text/settings | Agent là tác giả chính của code; edit tay chỉ landing khi người dùng yêu cầu |
| P9 | **`compositionRoot()` xử lý `<template>`** | Bỏ là mất toàn bộ nội dung scene scaffold |
| P10 | **Sub-composition phục vụ verbatim**, không bọc thành document đầy đủ | Bọc lại làm scene có layout đúng nhưng không vẽ gì |
| P11 | **Scene sinh ra phải có file `src` riêng**, không mount inline | Host inline không được runtime quản lý visibility → hiện suốt video |

---

## 2. Quyết định kiến trúc cần chốt trước

### 2.1 File-as-source-of-truth hay Database?

| | File (hiện tại) | DB + file | Full DB |
|---|---|---|---|
| Agent CLI / `hyperframes` CLI vẫn dùng được | ✅ | ✅ | ❌ |
| Multi-user, version history, query nhanh | ❌ | ✅ | ✅ |
| Đồng bộ 2 nguồn | — | phải giải quyết | — |
| Phù hợp workflow HyperFrames (skill, AGENTS.md) | ✅ | ✅ | ❌ |

**Khuyến nghị:** **DB + file**. File HTML vẫn là artifact chính (để CLI/agent/render dùng được), DB làm **index + metadata + history**:
- DB lưu: user, project registry, revision (diff/snapshot), job (render/tts/snapshot), preview settings, narration metadata, audit log.
- File lưu: composition HTML, asset, wav — cái mà render pipeline và agent cần.
- File watcher đồng bộ file → DB index.

### 2.2 Single-tenant hay multi-tenant?

Hiện `PROJECTS_ROOT = cwd/projects` → single-tenant, một thư mục chung. Nếu multi-user cần:
- `storage/<userId|orgId>/<projectSlug>/`
- hoặc object storage (S3/R2) + workspace tạm khi render/edit.
Lưu ý: HyperFrames CLI và agent làm việc trên **filesystem thật**, nên object storage cần bước checkout/checkin.

### 2.3 Tác vụ dài chạy ở đâu?

Các tác vụ **không thể** làm trong một HTTP request:
- Render MP4 (phút)
- TTS (giây–chục giây)
- Snapshot (giây)
- Agent session (phút, streaming)
- Transcribe, remove-background

Cần: **job queue + worker + progress streaming** (SSE/WebSocket). Không có cái này thì phần lớn chức năng "mong muốn" không làm được.

---

## 3. Chức năng đích — theo nhóm

### 3.1 Project management

| ID | Chức năng | Ưu tiên |
|---|---|---|
| PM-1 | List project có phân trang, sort, filter, search | Cao |
| PM-2 | Tạo project từ template/example (`hyperframes init`) | Cao |
| PM-3 | Tạo project từ brief AI (prompt → project hoàn chỉnh) | Trung |
| PM-4 | Đổi tên / duplicate / xoá project | Cao |
| PM-5 | Thumbnail thật (từ snapshot, tự sinh nếu chưa có) | Cao |
| PM-6 | Metadata mở rộng: `updatedAt`, `sceneCount`, `renderStatus`, `duration` | Cao |
| PM-7 | Báo lỗi project không parse được (thay vì im lặng loại bỏ) | Cao |
| PM-8 | Import (zip/git) / Export (zip) | Thấp |
| PM-9 | Settings project: kích thước canvas, fps, palette default, voice default | Trung |

### 3.2 File & asset

| ID | Chức năng | Ưu tiên |
|---|---|---|
| FA-1 | CRUD file/folder (tạo, xoá, đổi tên, di chuyển) | Cao |
| FA-2 | Upload asset (ảnh/video/audio/font) | Cao |
| FA-3 | Probe metadata asset (dimension, duration, codec, size) | Cao |
| FA-4 | Sinh proxy/thumbnail cho video lớn | Trung |
| FA-5 | Phát hiện asset thiếu (src trỏ file không tồn tại) | Cao |
| FA-6 | Phát hiện & xoá asset không dùng | Thấp |
| FA-7 | Lazy tree cho project lớn | Trung |
| FA-8 | Range request cho video/audio | Trung |
| FA-9 | Cache header hợp lý theo loại asset | Trung |
| FA-10 | Preview file binary (ảnh/audio) trong editor | Thấp |
| FA-11 | Tìm kiếm nội dung trong project (grep) | Trung |

### 3.3 Composition editing

| ID | Chức năng | Ưu tiên |
|---|---|---|
| CE-1 | Lưu file + optimistic concurrency bằng **content hash** (không phải mtime+size) | Cao |
| CE-2 | Khi 409 trả kèm **nội dung server** để diff/merge | Cao |
| CE-3 | Ghi atomic (temp + rename) | Cao |
| CE-4 | Revision history mỗi lần ghi + rollback | Cao |
| CE-5 | Validate HTML trước ghi (`hyperframes check`) + cảnh báo | Cao |
| CE-6 | Trả về **entity đã cập nhật** thay vì `{ok:true}` | Cao |
| CE-7 | Batch edit trong một transaction | Trung |
| CE-8 | Undo/redo cấp composition | Cao |
| CE-9 | Format on save (prettier) | Thấp |
| CE-10 | LSP cho HTML/CSS/JS trong editor | Thấp |
| CE-11 | Collaborative editing (CRDT + presence) | Thấp |

### 3.4 Scene

| ID | Chức năng | Ưu tiên |
|---|---|---|
| SC-1 | Xoá scene (xoá file + xoá mount + thu hẹp root duration) | Cao |
| SC-2 | Duplicate scene | Trung |
| SC-3 | Đổi `sceneId` (cập nhật mọi tham chiếu: mount, selector GSAP, narration, preview settings) | Trung |
| SC-4 | Chèn scene tại vị trí bất kỳ | Cao |
| SC-5 | **Ripple edit** — đổi duration thì đẩy scene sau | Cao |
| SC-6 | Đổi thứ tự bằng kéo-thả | Cao |
| SC-7 | Sửa timing bằng kéo bar / kéo mép trên timeline | Cao |
| SC-8 | Validate nghiệp vụ timing (`duration > 0`, `start >= 0`, cảnh báo vượt root) | Cao |
| SC-9 | Split scene tại playhead | Thấp |
| SC-10 | Thêm/xoá element trong scene | Trung |
| SC-11 | Sửa tween (start/duration/ease/property) | Trung |
| SC-12 | Thư viện template scene (title card, stat, quote, lower-third…) | Cao |
| SC-13 | Chuyển scene inline ↔ file | Thấp |
| SC-14 | Đánh dấu tường minh vai trò scene (`data-hf-role`) thay vì regex tên id | Trung |
| SC-15 | Đánh dấu tường minh element script (`data-hf-script`) thay vì heuristic độ dài text | Trung |

### 3.5 Validation / diagnostics

| ID | Chức năng | Ưu tiên |
|---|---|---|
| VD-1 | Endpoint validate trả diagnostic có cấu trúc | Cao |
| VD-2 | Tích hợp `hyperframes check` / `lint` | Cao |
| VD-3 | Giữ 4 cảnh báo hiện có: stranded tween, element overrun, unresolved selector, empty scene | Cao |
| VD-4 | Quick fix (đề xuất giá trị `data-duration` mới) | Trung |
| VD-5 | `hyperframes keyframes` diagnostics | Thấp |
| VD-6 | Hiện diagnostic inline trong editor (gutter marker) | Trung |

Schema đề xuất:
```ts
type Diagnostic = {
  severity: "error" | "warning" | "info";
  code: "stranded-tween" | "element-overrun" | "unresolved-selector" | "empty-scene"
      | "missing-asset" | "duration-overflow" | "lint:<rule>";
  sceneId?: string; elementId?: string; effectId?: string;
  file?: string; line?: number;
  message: string;
  fix?: { kind: "set-attribute"; target: string; attribute: string; value: string };
};
```

### 3.6 Narration / TTS

| ID | Chức năng | Ưu tiên |
|---|---|---|
| NT-1 | **Chạy TTS thật** (Kokoro CLI hoặc TTS service) | Cao |
| NT-2 | Job async + progress | Cao |
| NT-3 | Trả duration audio thật → cảnh báo lệch với `scene.duration`, đề xuất nới | Cao |
| NT-4 | **Mount audio vào composition** (`<audio class="clip" data-start>`) để preview & render có tiếng | Cao |
| NT-5 | Chọn voice (list voices), lưu per-scene + default per-project | Cao |
| NT-6 | Tham số: speed, pitch, pause | Trung |
| NT-7 | Nhiều đoạn narration per scene, mỗi đoạn timing riêng | Cao |
| NT-8 | **Word-level timestamps** → sinh caption đồng bộ (điều kiện để `subtitles.activeColor` có ý nghĩa) | Cao |
| NT-9 | Cache theo hash `(text, voice, params)` | Trung |
| NT-10 | Tên file có hash/revision (tránh cache browser dính bản cũ) | Trung |
| NT-11 | Nút phát thử audio trong UI | Cao |
| NT-12 | Xoá narration | Trung |
| NT-13 | **Sửa script KHÔNG tự động regenerate TTS** — chỉ đánh dấu `stale` | Cao (sửa bug) |
| NT-14 | Transcribe audio có sẵn → script (`hyperframes transcribe`) | Thấp |

### 3.7 Audio / sound design

| ID | Chức năng | Ưu tiên |
|---|---|---|
| AU-1 | Chốt: scene sound render thành wav & mount, hay giữ là intent metadata cho render pipeline | Cao |
| AU-2 | Nhiều track BGM với start/duration/fade/gain | Trung |
| AU-3 | Upload SFX riêng (không chỉ 24 preset) | Trung |
| AU-4 | Auto-ducking BGM dưới narration | Trung |
| AU-5 | Normalize loudness (LUFS) | Thấp |
| AU-6 | Probe BGM (ffprobe): duration, sample rate, channels | Cao |
| AU-7 | Validate magic bytes upload audio | Cao |
| AU-8 | Xoá/quản lý track đã upload | Trung |
| AU-9 | Waveform để trim/canh beat | Trung |
| AU-10 | Thư viện nhạc / gợi ý theo mood | Thấp |

### 3.8 Preview & Render

| ID | Chức năng | Ưu tiên |
|---|---|---|
| PR-1 | **Render MP4** (`hyperframes render`) — job async, progress, download | **Cao nhất** |
| PR-2 | Batch render nhiều project/preset | Trung |
| PR-3 | Render cloud (HeyGen / AWS Lambda / Cloud Run) | Trung |
| PR-4 | Publish | Thấp |
| PR-5 | Snapshot: theo mốc thời gian **và** theo scene, + contact sheet | Cao |
| PR-6 | Invalidate snapshot khi composition đổi | Cao |
| PR-7 | Xuất frame PNG hiện tại | Trung |
| PR-8 | Render transparent overlay | Thấp |
| PR-9 | Preview **một scene** riêng lẻ | Trung |
| PR-10 | Hot-reload preview settings **không remount player** (giữ vị trí phát) | Cao |
| PR-11 | Hot-reload từng composition thay vì reload cả root | Cao |
| PR-12 | ETag cho `/preview` theo mtime + hash settings | Trung |
| PR-13 | Cache immutable cho `/runtime` theo version | Thấp |
| PR-14 | So sánh trước/sau (`hyperframes compare`) | Thấp |

### 3.9 Registry / block

| ID | Chức năng | Ưu tiên |
|---|---|---|
| RG-1 | Duyệt catalog registry từ trong app | Trung |
| RG-2 | Cài block (`hyperframes add`) + mount vào composition | Trung |
| RG-3 | Preview block trước khi cài | Thấp |
| RG-4 | Xoá / thay block đã cài | Trung |
| RG-5 | Registry cache có TTL + persist, không cache negative vô hạn | Trung |
| RG-6 | Fallback khi offline (không chờ 4s mỗi block) | Trung |

### 3.10 AI Composer

| ID | Chức năng | Ưu tiên |
|---|---|---|
| AI-1 | **Chạy agent thật** — MCP server + PTY agent CLI (khuyến nghị) hoặc model API + tool-use | Cao |
| AI-2 | Streaming output (token + tool call) qua SSE/WS | Cao |
| AI-3 | Chat nhiều lượt, lịch sử lưu server | Cao |
| AI-4 | Hủy giữa chừng | Cao |
| AI-5 | Diff preview trước khi apply | Cao |
| AI-6 | Undo một lượt agent | Cao |
| AI-7 | Sandbox + giới hạn quyền ghi trong project | **Bắt buộc** khi có AI-1 |
| AI-8 | Audit log mọi tool call | Cao |
| AI-9 | Agent đọc được context: preview settings, snapshot, diagnostic lint | Trung |
| AI-10 | Attach ảnh / brief / URL làm input | Trung |
| AI-11 | Chọn model / effort | Thấp |
| AI-12 | Hiển thị token/chi phí | Thấp |
| AI-13 | Nhiều session song song | Thấp |
| AI-14 | Giới hạn concurrent process + timeout + kill | Cao |

MCP tool set đề xuất (khớp transcript đang mock): `list_compositions`, `read_composition`, `add_scene`, `delete_scene`, `set_timing`, `set_text`, `add_element`, `add_block`, `tts`, `snapshot`, `lint`, `check`, `render`.

### 3.11 MCP protocol & dual-stack (D1)

Luật chi tiết: [steering/13-mcp-protocol-compatibility](../steering/13-mcp-protocol-compatibility.md).

| ID | Chức năng | Ưu tiên |
|---|---|---|
| MP-1 | MCP server thật, chạy được (`vidcom mcp`, stdio) | **Cao nhất** |
| MP-2 | Tool Registry protocol-agnostic — định nghĩa tool một lần | Cao |
| MP-3 | Transport adapter **modern** `2026-07-28` (`@modelcontextprotocol/server@2.x`) | Cao |
| MP-4 | Transport adapter **legacy** ≤ `2025-11-25` (`@modelcontextprotocol/sdk@1.x`) | Cao |
| MP-5 | Version negotiation + `server/discover` | Cao |
| MP-6 | `resultType` + `CacheableResult` (`ttlMs`, `cacheScope: "private"`) ở modern | Cao |
| MP-7 | MRTR cho xác nhận thao tác destructive | Cao |
| MP-8 | Map job sang tasks extension `io.modelcontextprotocol/tasks` | Trung |
| MP-9 | Map error code theo thế hệ (`-32002` ↔ `-32602`) | Cao |
| MP-10 | `tools/list` thứ tự deterministic | Trung |
| MP-11 | Ẩn tool không degrade được khỏi legacy `tools/list` | Trung |
| MP-12 | Audit ghi protocol version mỗi tool call | Cao |
| MP-13 | OpenTelemetry trace context qua `_meta` | Thấp |

### 3.12 Agent kit — skill & instruction (D1)

Luật chi tiết: [steering/14-agent-kit-and-skills](../steering/14-agent-kit-and-skills.md).

| ID | Chức năng | Ưu tiên |
|---|---|---|
| AK-1 | `AGENTS.md` + `CLAUDE.md` ship vào project người dùng | Cao |
| AK-2 | Skill router `/vidcom` + 6 skill con | Cao |
| AK-3 | Quy trình chuẩn 9 bước, tham chiếu từ mọi skill | Cao |
| AK-4 | Cài/refresh agent-kit khi tạo & mở project; ghi version vào `vidcom.json` | Cao |
| AK-5 | Không ghi đè file người dùng đã sửa | Cao |
| AK-6 | `vidcom skills install` — lệnh tường minh, không đoán thư mục host | Trung |
| AK-7 | MCP prompt expose qua server (host nào cũng nhận được) | Trung |
| AK-8 | 3 test đồng bộ agent-kit ↔ Tool Registry | Cao |

### 3.13 Đóng gói & phân phối (D2/D3)

| ID | Chức năng | Ưu tiên |
|---|---|---|
| PK-1 | **Spike**: Bun `--compile` với native addon thật (`onnxruntime-node`, `sharp`, `esbuild`, `puppeteer-core`) | **Chặn mọi thứ** |
| PK-2 | `WorkspaceRoot` inject được, bỏ `process.cwd()` | Cao |
| PK-3 | Directory picker server-driven + one-time token flow | Cao |
| PK-4 | Workspace lock/lease, single-writer daemon | Cao |
| PK-5 | `vidcom` CLI đa mode: `app`/`serve`/`mcp`/`worker`/`render`/`doctor`/`version` | Cao |
| PK-6 | Nhúng frontend asset vào binary, serve từ memory | Cao |
| PK-7 | Giải nén sidecar runtime vào app-data ở lần chạy đầu | Trung |
| PK-8 | `vidcom doctor` kiểm tra Chromium/FFmpeg/TTS/quyền | Trung |
| PK-9 | Build matrix macOS/Windows/Linux × arm64/x64 | Trung |
| PK-10 | Code signing, notarization, checksum, provenance | Trung |
| PK-11 | Auto-update + crash reporting | Thấp |
| PK-12 | Import project có sẵn vào workspace | Trung |

### 3.14 Bảo mật & vận hành

| ID | Chức năng | Ưu tiên |
|---|---|---|
| SE-1 | Auth (session/JWT) + phân quyền per-project | **Bắt buộc trước khi deploy** |
| SE-2 | Giới hạn `/files` — không expose `AGENTS.md`, `package.json`, secret | Cao |
| SE-3 | Bịt path traversal ở `openProjectFile` (action `script`) | Cao |
| SE-4 | Schema validation mọi endpoint (zod/valibot) | Cao |
| SE-5 | Mã lỗi máy đọc được `{ code, message, field? }` | Cao |
| SE-6 | Rate limit | Trung |
| SE-7 | Giới hạn dung lượng project / quota | Trung |
| SE-8 | Validate magic bytes cho upload | Cao |
| SE-9 | Audit log | Trung |
| SE-10 | Structured logging + tracing | Trung |
| SE-11 | Health check / readiness | Trung |
| SE-12 | Backup / restore project | Trung |

### 3.15 Hiệu năng

| ID | Chức năng | Ưu tiên |
|---|---|---|
| PF-1 | **Parse một lần, cache theo content hash** — thay 12+ lần parse mỗi refresh | Cao |
| PF-2 | File watcher + invalidate cache | Cao |
| PF-3 | Push update qua SSE/WS thay vì `router.refresh()` toàn trang | Cao |
| PF-4 | Trả entity cập nhật để client patch state cục bộ | Cao |
| PF-5 | Không remount player khi ghi (xem PR-10/PR-11) | Cao |
| PF-6 | Cache header hợp lý (xem FA-9, PR-12, PR-13) | Trung |

---

## 4. Lộ trình

Thứ tự xây dựng nằm ở **một chỗ duy nhất**: [15-build-order](15-build-order.md).

MUST NOT lặp lại lộ trình ở đây hay ở doc 14 — hai bản sẽ lệch nhau. Tài liệu này giữ **danh sách chức năng có ID**; doc 15 giữ **thứ tự làm**.

---

## 5. Bảng mapping: endpoint cũ → mới (gợi ý)

| Endpoint cũ | Endpoint mới đề xuất |
|---|---|
| `GET /api/hf/runtime` | `GET /api/runtime?v=<pkgVersion>` (cache immutable) |
| `GET /api/hf/{slug}/preview` | `GET /api/projects/{id}/preview` (+ `?scene=<id>` cho preview 1 scene) |
| `GET /api/hf/{slug}/files/{...}` | `GET /api/projects/{id}/assets/{...}` (có phân quyền + Range + ETag) |
| `GET /api/hf/{slug}/source?path=` | `GET /api/projects/{id}/files?path=` |
| `PUT /api/hf/{slug}/source` | `PUT /api/projects/{id}/files` (hash-based concurrency, trả diagnostics) |
| — | `POST` / `DELETE` / `PATCH /api/projects/{id}/files` (CRUD file) |
| `GET /api/hf/{slug}/preview-settings` | `GET /api/projects/{id}/preview-settings` |
| `PATCH /api/hf/{slug}/preview-settings` | `PATCH /api/projects/{id}/preview-settings` |
| `POST /api/hf/{slug}/preview-settings` (BGM) | `POST /api/projects/{id}/audio/bgm` |
| `PATCH /scene {action:"timing"}` | `PATCH /api/projects/{id}/scenes/{sceneId}` |
| `PATCH /scene {action:"script"}` | `PATCH /api/projects/{id}/scenes/{sceneId}/script` (batch được) |
| `PATCH /scene {action:"tts"}` | `POST /api/projects/{id}/scenes/{sceneId}/narration` → `{jobId}` |
| `PATCH /scene {action:"generate"}` | `POST /api/projects/{id}/scenes` (tạo scene) + `POST /api/projects/{id}/agent/messages` (agent thật) |
| — | `DELETE /api/projects/{id}/scenes/{sceneId}` |
| — | `POST /api/projects/{id}/renders` → `{jobId}`; `GET /api/jobs/{jobId}`; `GET /api/renders/{id}/download` |
| — | `POST /api/projects/{id}/snapshots` → `{jobId}` |
| — | `GET /api/projects/{id}/diagnostics` |
| — | `GET /api/registry/blocks`, `POST /api/projects/{id}/blocks` |
| — | `GET /api/projects/{id}/events` (SSE: file-changed, job-progress, agent-stream) |
| — | `GET /api/tts/voices` |
