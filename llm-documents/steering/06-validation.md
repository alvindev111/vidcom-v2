# 06 — Validation

## 1. Ba tầng, ba trách nhiệm khác nhau

| Tầng | Trả lời câu hỏi | Ở đâu | Sai thì |
|---|---|---|---|
| **Schema** | Dữ liệu có đúng hình dạng không? | boundary (HTTP, MCP) | `400` / MCP invalid params |
| **Nghiệp vụ** | Thao tác có hợp lệ trong domain không? | Core use case | `422` + `ErrorCode` |
| **Normalize** | Dữ liệu trên đĩa méo thì đọc thế nào? | adapter đọc file | không bao giờ throw |

MUST NOT trộn ba tầng. Kiểm tra `duration > 0` không thuộc schema — nó là invariant domain và MCP cũng phải được bảo vệ, không chỉ HTTP.

## 2. Schema validation

- Một thư viện schema duy nhất cho cả HTTP và MCP.
- Schema định nghĩa **một lần** trong `packages/contracts`, cả hai adapter import.
- MUST validate: body, query, path param, header có ý nghĩa.
- MUST validate **cả output** ở MCP — AI phụ thuộc contract, trả sai shape là breaking change im lặng.
- MUST `strict` — field lạ bị từ chối, không bị bỏ qua âm thầm.

MUST NOT tự viết validate bằng `if (typeof x !== "string")` rải rác trong route.

## 3. Validation nghiệp vụ — thuộc Core

Danh sách tối thiểu, rút từ những chỗ bản mock **không** kiểm tra:

| Kiểm tra | Bản mock | Rule mới |
|---|---|---|
| `duration > 0` | không có — form cho nhập 0 và số âm | bắt buộc |
| `start >= 0` | không có | bắt buộc |
| `start + duration` vượt root duration | không có | từ chối, hoặc nới root nếu được yêu cầu tường minh |
| `trackIndex` là số nguyên | không có | bắt buộc |
| `sceneId` tồn tại | có | giữ |
| File thuộc scene đang sửa | **không có** — client tự gửi `file`, server không đối chiếu | bắt buộc |
| Đường dẫn nằm trong project | có (`resolveWithinProject`) nhưng **thiếu** ở `openProjectFile` | bắt buộc ở **mọi** đường vào |
| `text` không rỗng khi TTS | không có | bắt buộc |
| Prompt không rỗng | có | giữ |

## 4. Normalize khi đọc — không bao giờ throw

File trên đĩa do người dùng, agent và CLI cùng ghi. File hỏng **không được** làm sập studio.

Mô hình đã có và đáng giữ nguyên (`normalizePreviewSettings`):

```ts
hex(value, fallback)                 // sai format → fallback
number(value, fallback, min, max)    // clamp
oneOf(value, allowed, fallback)
bool(value, fallback)
```

Rule:

- Hàm normalize MUST tổng: mọi input đều ra một object hợp lệ, đầy đủ.
- JSON parse lỗi → dùng default, **log warning**, MUST NOT throw.
- MUST giữ danh sách key đóng ở chỗ nó phải đóng (ví dụ `theme.variables` chỉ nhận 6 biến đã khai báo).
- MUST NOT normalize im lặng ở boundary ghi. Đọc thì khoan dung, ghi thì nghiêm — người dùng gửi `fontSize: "big"` phải nhận lỗi, không phải nhận `72` mà không biết.

Đây là điểm khác biệt quan trọng với bản mock: hiện `PATCH /preview-settings` nhận mọi thứ rồi âm thầm thay bằng default.

## 5. Đường dẫn — quy tắc cứng

Mọi đường dẫn từ bên ngoài (HTTP, MCP, file config) MUST đi qua đúng một hàm:

```ts
resolveInProject(projectRef, relativePath): AbsolutePath | null
```

Hàm đó MUST:

1. Từ chối absolute path và `..` ngay từ đầu.
2. Join rồi **canonicalize**.
3. **Resolve symlink** rồi kiểm tra lại vẫn nằm trong project.
4. Trả `null` khi vi phạm — không throw, không log path người dùng gửi vào ở mức info.

Bước 3 là chỗ bản mock thiếu. Và `openProjectFile` trong `sdk.server.ts` hiện `join()` thẳng, không qua containment check.

MUST NOT có đường ghi nào nhận absolute path từ client hoặc AI.

## 6. Upload

| Kiểm tra | Bắt buộc |
|---|---|
| Kích thước | có, giới hạn tường minh theo loại |
| **Magic bytes** | có — `accept="audio/*"` ở input HTML bypass được |
| Đuôi file trong allowlist | có |
| Sanitize tên file | có |
| Trùng tên | MUST NOT ghi đè im lặng — hoặc từ chối, hoặc đổi tên, và nói cho người dùng biết |
| Probe metadata (duration, dimension, codec) | có với media |

## 7. Concurrency là một dạng validation

Mọi ghi MUST kiểm tra `expectedContentHash` (file) hoặc `expectedRevision` (entity).

- Thiếu field đó → `400`, MUST NOT ghi đè liều.
- Lệch → `409` kèm nội dung hiện tại của server.

Bản mock chỉ có ở `PUT /source`; `PATCH /scene` và `PATCH /preview-settings` ghi đè im lặng. Xem [07-data-and-storage](07-data-and-storage.md) §4.

## 8. Diagnostics ≠ validation

Phân biệt rõ:

- **Validation** chặn thao tác. Trả lỗi.
- **Diagnostics** cho biết composition đang có vấn đề. **Không** chặn.

Tween chạy sau khi scene kết thúc là diagnostic, không phải lỗi — người dùng có quyền lưu trạng thái dở dang. Nhưng response MUST kèm diagnostic đó.

Schema:

```ts
type Diagnostic = {
  severity: "error" | "warning" | "info";
  code: "stranded-tween" | "element-overrun" | "unresolved-selector" | "empty-scene"
      | "missing-asset" | "duration-overflow" | `lint:${string}`;
  sceneId?: string; elementId?: string; effectId?: string;
  file?: string; line?: number;
  message: string;
  fix?: { kind: "set-attribute"; target: string; attribute: string; value: string };
};
```

Bốn diagnostic hiện có MUST được giữ: stranded tween · element overrun · unresolved selector · empty scene.
