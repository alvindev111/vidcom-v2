# 05 — MCP tool design

MCP là interface hạng nhất (**D1**). Thiết kế tool **trước**, HTTP route theo sau.

> ⚠️ **Đọc kèm [13-mcp-protocol-compatibility](13-mcp-protocol-compatibility.md).** Ta phải phục vụ **hai thế hệ protocol** cùng lúc: legacy (`2024-10-07` … `2025-11-25`) và modern (`2026-07-28`). Mọi rule dưới đây định nghĩa tool ở mức **protocol-agnostic**; cách nó xuất hiện trên dây khác nhau theo thế hệ.

## 1. Luật nền

1. **Một tool = một use case.** MUST NOT có tool đa năng phân nhánh bằng field `action`.
2. **Tool gọi Core trực tiếp**, không gọi qua HTTP.
3. **AI không có quyền tuỳ ý.** Không shell, không ghi file bất kỳ, không SQL, không gọi endpoint tự do.
4. **Mọi tool call được audit.** Không có ngoại lệ.
5. **`stdout` chỉ chứa MCP protocol message.** Một `console.log` lạc chỗ làm hỏng handshake.

## 2. Đặt tên

`snake_case`, động từ + danh từ: `create_scene`, `set_scene_timing`, `get_job_status`.

Tiền tố theo hành vi để AI đọc contract là đoán được:

| Tiền tố | Nghĩa |
|---|---|
| `list_` / `get_` / `read_` | đọc, không đổi state |
| `create_` / `set_` / `add_` / `save_` | ghi |
| `delete_` | phá huỷ |
| `start_` | mở job dài, trả `jobId` |
| `cancel_` | huỷ job |
| `validate_` | chạy kiểm tra, không đổi state |

## 3. Phân mức và chính sách

| Mức | Tool | Chính sách |
|---|---|---|
| **read** | `list_projects`, `get_project_context`, `read_composition`, `list_scenes`, `get_diagnostics`, `list_registry_blocks`, `get_job_status` | chạy tự do; audit ở mức nhẹ |
| **write** | `create_scene`, `duplicate_scene`, `set_scene_timing`, `set_text`, `reorder_scenes`, `save_file`, `upload_asset`, `add_block` | audit đầy đủ; bắt buộc `expectedRevision`/`expectedContentHash`; trả entity + revision mới; không tự đi vào lịch sử undo của UI |
| **job** | `start_tts`, `start_snapshot`, `start_render`, `cancel_job` | trả `jobId` ngay, không block |
| **destructive** | `delete_scene`, `delete_file`, `delete_project` | **cần xác nhận** — cơ chế khác nhau theo thế hệ, xem dưới; Core tạo backup trước khi xoá |

MUST khai báo mức trong metadata của tool, không chỉ ghi trong mô tả.

Lịch sử undo là affordance của phiên studio cục bộ: chỉ mutation có `origin.kind: "ui"`, session đã
attach đúng project và `historyAction: "record"` mới được ghi vào stack đó. Write từ MCP, CLI, watcher
hay nguồn external vẫn đi qua cùng Core, precondition và audit nhưng không vào stack UI. MUST NOT phát
tool MCP undo/redo.

### Xác nhận thao tác destructive — approval grant, không phải cờ

> **Sửa 2026-08-01.** Bản trước chấp nhận `confirm: true` (legacy) và coi MRTR là bằng chứng duyệt (modern). Cả hai **sai**: chúng chỉ chứng minh *client gửi phản hồi*, không chứng minh *con người đã duyệt* — một agent tự đặt `confirm: true` là hợp lệ về giao thức.

Tool mức `destructive` MUST yêu cầu một **approval grant**:

| Thuộc tính | Ràng buộc |
|---|---|
| Ai phát hành | **Daemon**, sau hành động của con người — bấm trong UI, hoặc chạy `vidcom approve` tường minh |
| Bind với | tên tool + `projectId` + định danh đối tượng + `expectedRevision` |
| Số lần dùng | **một lần** — chống replay |
| Hết hạn | ngắn, cấu hình được |
| Agent có tự tạo được không | **Không** |

Vai trò của hai era:

| Era | Vai trò |
|---|---|
| Modern | MRTR (`InputRequiredResult`) là **kênh dẫn** người dùng tới bước lấy grant. Không phải bằng chứng duyệt |
| Legacy | Trả `approval_required` kèm hướng dẫn lấy grant. MUST NOT chấp nhận cờ do agent tự đặt |

Quyết định "có được xoá không" nằm ở **Core**. Transport chỉ dịch sang cơ chế của era đang phục vụ. Xem [13-mcp-protocol-compatibility](13-mcp-protocol-compatibility.md) §3.2.

## 4. Không bao giờ expose

| Tool | Vì sao |
|---|---|
| `run_shell` / `exec` | AI có toàn quyền máy người dùng |
| `write_any_file` | thoát khỏi workspace |
| `execute_sql` | vượt qua mọi invariant |
| `call_arbitrary_endpoint` | vô hiệu hoá phân mức quyền |
| bất kỳ tool nhận **absolute path** từ AI | dùng `projectId` + đường dẫn tương đối |
| `browse_directory` | directory picker chỉ dành cho UI người dùng (doc 14 §9), không dành cho AI |
| tool trả credential, token, đường dẫn runtime nội bộ | rò cấu hình |

## 5. Hình dạng input/output

Schema định nghĩa trong `contracts`, dùng chung với HTTP DTO.

```ts
// input
{
  projectId: string;            // KHÔNG phải absolute path
  sceneId: string;
  start?: number;
  duration?: number;
  trackIndex?: number;
  expectedRevision: number;     // bắt buộc với mọi tool write
}

// output — tool write
{
  scene: { … },                 // entity mới
  project: { id, duration, revision },
  diagnostics: Diagnostic[]
}
```

Rule:

- MUST trả **entity + revision mới**. MUST NOT trả `{ ok: true }`.
- MUST kèm `diagnostics` khi thao tác có thể tạo ra lỗi authoring (tween stranded, element overrun, scene rỗng).
- MUST trả lỗi có `code` machine-readable, cùng enum với HTTP.
- Output MUST đủ để AI quyết định bước tiếp theo mà không phải gọi thêm tool đọc.

Điều cuối quan trọng: nếu sau mỗi `set_scene_timing` mà AI phải gọi `read_composition` để biết chuyện gì xảy ra, contract đang thiếu thông tin.

## 6. Tool job

```jsonc
// start_render → trả ngay
{ "jobId": "j_123", "status": "queued", "pollWith": "get_job_status" }

// get_job_status
{ "jobId": "j_123", "status": "running", "progress": 0.42,
  "stage": "rendering frame 120/300", "result": null, "error": null }
```

MUST NOT block tool call chờ job xong. MCP host có timeout riêng, và một render vài phút sẽ đứt giữa chừng.

## 7. Resolve context

- `projectId` từ `vidcom.json`, ổn định khi thư mục bị di chuyển.
- Workspace resolve theo thứ tự ở doc 14 §10.3. MUST NOT đoán thư mục.
- Nếu chưa có workspace active → trả lỗi có hướng dẫn, MUST NOT tự tạo thư mục.

## 8. Mô tả tool

Mô tả tool là prompt — AI đọc nó để quyết định gọi hay không.

- MUST nói rõ **khi nào dùng** và **khi nào không**.
- MUST nêu tác dụng phụ: `set_text` sẽ đánh dấu narration của scene là stale.
- MUST nêu tiền điều kiện: cần `expectedRevision` lấy từ tool nào.
- MUST NOT viết mô tả mơ hồ kiểu "quản lý scene".

Ví dụ đạt:

> `set_scene_timing` — Đổi start/duration/trackIndex của một scene trong root composition. Cần `expectedRevision` lấy từ `get_project_context` hoặc từ output của tool write trước đó. Nếu `start + duration` vượt thời lượng root, thao tác bị từ chối kèm `duration_overflow` — nới root bằng cách gọi lại với `extendRoot: true`. Không dùng để đổi timing của element bên trong scene.

### Mô tả tool vs skill

Mô tả tool là thứ **luôn** tới được agent, kể cả host không đọc file trong project. Nên:

- Thông tin **bắt buộc để gọi đúng** (tiền điều kiện, tác dụng phụ, mã lỗi) MUST nằm ở đây.
- Cách **ghép nhiều tool** thành một ý định nằm ở skill ([14-agent-kit-and-skills](14-agent-kit-and-skills.md)).
- Luật an toàn MUST được **server cưỡng chế**, MUST NOT chỉ viết trong mô tả hay trong `AGENTS.md`.

## 9. Audit

Mỗi tool call ghi: thời điểm, tên tool, mức, `projectId`, input đã redact, kết quả (ok/error code), revision trước và sau, thời lượng.

Audit ghi vào bảng `audit_entry` trong `<app-data>/vidcom.sqlite`, MUST NOT ghi vào workspace của người dùng.

## 10. Versioning

Phân biệt hai loại version, đừng lẫn:

| | Ai đổi | Ở đâu |
|---|---|---|
| **Protocol revision** | MCP spec | [13-mcp-protocol-compatibility](13-mcp-protocol-compatibility.md) |
| **Tool contract** | Chúng ta | mục này |

Đổi tool contract là breaking change với mọi AI host đang dùng.

- Thêm field tuỳ chọn: được.
- Đổi tên tool, xoá field, đổi kiểu, siết validation: MUST giữ tool cũ và đánh dấu deprecated ít nhất một release.
- MUST có contract test khoá schema, **chạy cho cả hai thế hệ protocol** (xem [10-testing](10-testing.md) §5).
- Tool nào không degrade được xuống legacy MUST bị ẩn khỏi legacy `tools/list`, MUST NOT expose rồi lỗi lúc gọi.

## 11. Nhắc lại: MCP ≠ AI Composer

Export MCP server cho AI host bên ngoài **không** làm tab AI Composer trong app chạy thật. Đó là hạng mục riêng (doc 14 §12). MUST NOT mô tả tính năng theo kiểu ngụ ý ngược lại — bản mock hiện in ra transcript `mcp hyperframes.tts` trong khi không có wav nào được tạo.
