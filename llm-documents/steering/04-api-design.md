# 04 — API design (HTTP / Hono)

## 1. Nguyên tắc

HTTP adapter là **consumer ngang hàng** với MCP của use case Core (D1). Operation có input biểu diễn an
toàn trên cả hai transport MUST có parity HTTP/MCP và gọi cùng use case. Hai defer tường minh là thao
tác theo phiên studio cục bộ (D7) và input file/blob cục bộ (D9); dù chỉ expose qua HTTP, nghiệp vụ vẫn
MUST nằm ở Core và D9 không được biến thành tool MCP nhận absolute path.

Adapter chỉ làm 5 việc: parse & validate input → gọi use case → map `Result` sang HTTP → stream nếu cần → audit. MUST NOT chứa nghiệp vụ.

## 2. URL

```
/api/v1/<resource>[/<id>[/<sub-resource>]]
```

- Versioned từ đầu: `/api/v1/`. Bản mock không có version và giờ mọi thay đổi đều là breaking.
- Resource là **danh từ số nhiều**: `projects`, `scenes`, `jobs`, `renders`.
- MUST NOT dùng verb trong path (`/createScene` sai). Verb nằm ở HTTP method.
- MUST NOT dùng endpoint đa năng phân nhánh bằng field `action` trong body — bản mock có `PATCH /scene { action }` với 4 nhánh, và hệ quả là không version được, không phân quyền được, không test riêng được.

Ánh xạ tối thiểu:

| Method | Path | Việc |
|---|---|---|
| `GET` | `/api/v1/projects` | list |
| `POST` | `/api/v1/projects` | tạo |
| `GET` | `/api/v1/projects/:id` | chi tiết |
| `DELETE` | `/api/v1/projects/:id` | xoá |
| `GET` | `/api/v1/projects/:id/studio-snapshot` | gộp dữ liệu mở studio |
| `GET` | `/api/v1/projects/:id/files?path=` | đọc file |
| `PUT` | `/api/v1/projects/:id/files` | ghi file |
| `POST` | `/api/v1/projects/:id/scenes` | tạo scene |
| `PATCH` | `/api/v1/projects/:id/scenes/:sceneId` | sửa timing |
| `DELETE` | `/api/v1/projects/:id/scenes/:sceneId` | xoá scene |
| `POST` | `/api/v1/projects/:id/renders` | bắt đầu render → `jobId` |
| `GET` | `/api/v1/jobs/:jobId` | trạng thái job |
| `GET` | `/api/v1/events` | SSE stream |

## 3. Response

### 3.1 Thành công

MUST trả **entity đã cập nhật**, không phải xác nhận rỗng.

```jsonc
// PATCH /api/v1/projects/p1/scenes/intro
{
  "scene":   { "id": "intro", "start": 0, "duration": 2.5, "trackIndex": 1, "revision": 12 },
  "project": { "id": "p1", "duration": 14, "revision": 37 },
  "diagnostics": []
}
```

Lý do: bản mock trả `{ ok: true }` nên client phải `router.refresh()` → re-parse toàn bộ project sau **mỗi** lần sửa một dòng chữ.

MUST kèm `revision` ở mọi entity ghi được — client cần nó cho lần ghi sau.

MUST kèm `diagnostics` ở mọi response làm thay đổi composition. Người dùng phải biết ngay là vừa tạo ra tween chạy sau khi scene kết thúc.

### 3.2 Lỗi

Một hình dạng duy nhất, cho cả HTTP và MCP:

```jsonc
{
  "error": {
    "code": "scene_not_found",       // machine-readable, enum trong contracts
    "message": "scene intro not found",
    "field": "sceneId",              // tuỳ chọn, để UI gắn lỗi vào ô nhập
    "details": { "projectId": "p1" }
  }
}
```

MUST NOT trả `{ "error": "some string" }`.

### 3.3 Map `ErrorCode` → status

| Nhóm | Status |
|---|---|
| Input sai schema | `400` |
| Chưa xác thực | `401` |
| Không đủ quyền | `403` |
| Không tìm thấy | `404` |
| Xung đột ghi (content hash lệch) | `409` |
| Vi phạm invariant nghiệp vụ | `422` |
| Quá lớn | `413` |
| Chưa hỗ trợ loại | `415` |
| Lỗi hệ thống | `500` |

Bảng map nằm **một chỗ** trong middleware, không rải trong từng route.

### 3.4 Xung đột ghi (409)

MUST trả kèm nội dung hiện tại của server để client diff/merge:

```jsonc
{
  "error": { "code": "write_conflict", "message": "file changed on disk since you opened it" },
  "current": { "path": "index.html", "content": "…", "contentHash": "sha256:…", "revision": 38 }
}
```

Bản mock chỉ bảo "reload before saving" — người dùng mất toàn bộ thay đổi.

## 4. Input

- Body JSON, `content-type: application/json`, trừ upload (multipart).
- MUST validate bằng schema từ `contracts` (xem [06-validation](06-validation.md)).
- Path param, query param cũng phải validate — không tin `c.req.param()`.
- MUST đặt giới hạn kích thước tường minh cho mọi endpoint nhận body.

## 5. Idempotency và concurrency

- `GET`, `PUT`, `DELETE` MUST idempotent.
- Mọi ghi lên file hoặc entity MUST nhận `expectedContentHash` hoặc `expectedRevision`. Thiếu → `400`, **không** ghi đè liều (**P7**).
- `POST` tạo job MUST nhận `Idempotency-Key` tuỳ chọn để retry không sinh hai job.

## 6. Tác vụ dài

MUST NOT chạy render/TTS/snapshot trong request.

```
POST /api/v1/projects/:id/renders   → 202 { "jobId": "j_123", "status": "queued" }
GET  /api/v1/jobs/j_123             → { status, progress, result?, error? }
POST /api/v1/jobs/j_123/cancel      → 202
```

Chi tiết: [08-jobs-and-queue](08-jobs-and-queue.md).

## 7. Streaming (SSE)

Một endpoint SSE dùng chung cho mọi loại event:

```
GET /api/v1/events?projects=p1,p2
```

Event type tối thiểu: `job.progress` · `job.done` · `file.changed` · `project.changed` · `agent.output`.

- MUST có `id` để client resume bằng `Last-Event-ID`.
- MUST có heartbeat định kỳ (proxy và webview đóng kết nối im lặng).
- MUST kiểm tra SSE không bị buffer khi Next còn host (rủi ro R4c ở doc 14).

MUST NOT mở một SSE endpoint riêng cho mỗi feature.

## 8. Serve asset project

Bản mock để `/files/[...path]` đọc **mọi** file trong project, kể cả `AGENTS.md`, `package.json`, `.env`.

Rule mới:

- MUST allowlist theo loại file, không chỉ chống path traversal.
- MUST hỗ trợ Range request cho video/audio.
- MUST đặt cache header theo loại: asset immutable cache dài, composition HTML `no-store`.
- MUST NOT serve file cấu hình hoặc file có khả năng chứa secret.

## 9. Cache

Bản mock đặt `no-store` cho **mọi** thứ kể cả runtime script. Rule mới:

| Nội dung | Header |
|---|---|
| Runtime script | `public, max-age=31536000, immutable` + version trong URL |
| Asset tĩnh của project | `ETag` + `must-revalidate` |
| Preview HTML | `no-store` |
| API JSON | `no-store` |

## 10. Middleware — thứ tự cố định

```
requestId → logger → hostCheck → cors → auth → bodyLimit → validate → route → errorMapper
```

`hostCheck` trước `auth`: chống DNS rebinding phải chặn trước khi đụng tới credential.
