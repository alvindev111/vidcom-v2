# 07 — Data & storage

## 1. Hai vùng lưu trữ — không được lẫn

### Workspace người dùng chọn — PUBLIC
Artifact người dùng sở hữu: xem được, copy được, Git commit được, mở bằng công cụ khác được.

```text
<workspace>/<project>/
├── vidcom.json            project ID + metadata không bí mật
├── hyperframes.json       config HyperFrames
├── meta.json  registry-item.json
├── index.html             root composition
├── compositions/  assets/  narration/  snapshots/
├── preview-assets/bgm/
├── preview-settings.json
└── renders/
```

### Application-data hệ điều hành — HIDDEN
State vận hành, không thuộc về project.

```text
<app-data>/
├── settings.json    vidcom.sqlite
├── credentials      (0600)
└── logs/  cache/  runtime/
```

`vidcom.sqlite` là database vận hành duy nhất. Job, audit, revision, lease,
event outbox và settings dạng bảng dùng chung file này để mutation có thể commit
revision + audit + event trong một transaction; MUST NOT tách chúng thành các
database không thể transaction cùng nhau.

## 2. Quy tắc phân loại — hỏi một câu

> *Nếu người dùng copy thư mục project sang máy khác, thiếu file này thì kết quả render có khác không?*

**Có** → thuộc project (public). **Không** → app-data (hidden).

Hệ quả bắt buộc:

| File | Vị trí | Vì sao |
|---|---|---|
| `preview-settings.json` | **project** | Là **input của render** (P2/P3). Đưa ra ngoài thì copy project sang máy khác sẽ render khác |
| `snapshots/` | **project** | Nội dung project, không phải cache |
| `preview-assets/bgm/` | **project** | Người dùng upload, thuộc về video |
| `narration/*.wav` | **project** | Đi vào bản render |
| Parse cache | app-data | Dựng lại được |
| Registry cache | app-data | Dựng lại được |
| Job state, audit, log | app-data | Vận hành |
| Chromium, FFmpeg, TTS model | app-data | Runtime, không thuộc project |

MUST NOT ghi bí mật vào workspace. MUST NOT ghi state vận hành vào workspace.

## 3. Workspace root — không có `cwd`

MUST NOT gọi `process.cwd()` để tìm project. Bản mock có `PROJECTS_ROOT = join(process.cwd(), "projects")` — dependency ngầm, không hoạt động khi đóng gói.

`WorkspaceRoot` được resolve **một lần** ở composition root và inject xuống. Thứ tự ưu tiên:

1. `--workspace <absolute-path>` hoặc config MCP tường minh;
2. workspace active trong `settings.json`;
3. cwd của MCP **nếu** thư mục đó có project marker hợp lệ;
4. yêu cầu người dùng chọn — MUST NOT tự tạo thư mục đoán được.

## 4. Ghi file — quy tắc cứng

Mọi ghi lên workspace MUST đi qua **một** service duy nhất trong Core. Use case MUST NOT gọi `writeFile` của port trực tiếp.

Service đó làm đúng thứ tự này:

```
1. resolveInProject(path)              → null thì dừng
2. so contentHash với expectedHash     → lệch thì 409 kèm nội dung hiện tại
3. validate nội dung nếu là composition (hyperframes check)
4. ghi ATOMIC: temp file cùng filesystem → fsync → rename
5. ghi revision record
6. ghi audit record
7. invalidate cache
8. phát event `file.changed`
```

- **Atomic bắt buộc.** Bản mock dùng `writeFileSync` thẳng — crash giữa lúc ghi làm hỏng composition.
- Temp file MUST cùng filesystem với đích, nếu không `rename` không atomic.
- Bước 3 MUST NOT chặn khi chỉ là diagnostic (xem [06-validation](06-validation.md) §8).

## 5. Concurrency

### Content hash, không phải mtime+size

Bản mock dùng `version = "<mtimeMs base36>-<size base36>"`. Không đủ: mtime không đáng tin trên một số filesystem và container; hai nội dung khác nhau có thể trùng mtime+size.

MUST dùng `sha256` của nội dung. Format: `"sha256:<hex>"`.

### Áp dụng ở đâu

MUST: **mọi** đường ghi. Bản mock chỉ có ở `PUT /source`; `PATCH /scene` và `PATCH /preview-settings` ghi đè im lặng.

### Single writer

- Hono daemon là single writer cho workspace đang mở.
- MCP bridge là client của daemon, MUST NOT tự ghi.
- Mỗi workspace có lock/lease; hai daemon không được cùng sở hữu.
- Lock MUST tự hết hạn — daemon crash không được khoá workspace vĩnh viễn.

Làm rõ: single-writer áp dụng cho **đường ghi của VidCom**. Người dùng vẫn sửa project bằng công cụ ngoài — thay đổi đó được **phát hiện**, không bị **ngăn**.

## 6. Revision & rollback

Mỗi ghi thành công sinh một revision: `{ id, projectId, path, contentHash, parentRevision, actor, timestamp, summary }`.

- `actor` phân biệt `user` / `agent` / `cli-external` / `system`.
- Nội dung revision lưu ở app-data, MUST NOT làm bẩn workspace bằng thư mục lịch sử.
- MUST giữ đủ để undo một lượt agent hoàn chỉnh, không chỉ một file.
- Trước thao tác **destructive** MUST tạo backup và ghi lại đường dẫn backup trong audit.

## 7. Cache

Mô hình đã có và đáng giữ: `memoPerProject()` — memo một giá trị mỗi project, invalidate bằng fingerprint (`path:mtime:size` toàn cây).

Nâng cấp bắt buộc khi port sang Core:

- MUST đổi sang invalidate **theo event của file watcher**, không `stat` toàn cây mỗi lần gọi.
- MUST giữ hành vi: promise reject thì tự xoá khỏi cache — kết quả lỗi không được nhớ như trạng thái của project.
- MUST có giới hạn số project cache (LRU), không giữ vô hạn.

### Registry cache
Bản mock fetch registry qua HTTP timeout 4s cho mỗi block lạ, cache trong `Map` không TTL, cache cả kết quả `null` vĩnh viễn. Rule mới:

- Persist trong `<app-data>/cache`, sống qua các lần khởi động.
- Có TTL.
- MUST NOT cache negative vô hạn.
- Offline MUST NOT làm chậm việc mở project — dùng cache, đánh dấu `stale`, không chờ mạng.

## 8. File watcher

- MUST watch workspace đang mở; phát `file.changed` cho UI và invalidate cache.
- MUST debounce — một lần `serialize()` chạm nhiều file.
- MUST phân biệt ghi của chính mình với ghi từ ngoài (so contentHash vừa ghi), để không tự kích hoạt vòng lặp.

## 9. Database

- SQLite, file trong app-data.
- Dùng cho: job, audit, settings, revision index, registry cache.
- MUST NOT lưu nội dung composition trong DB — file là artifact chính (D3).
- MUST có migration có version, chạy tự động lúc khởi động, idempotent.
- WAL mode; một writer.

## 10. Project ID

- `vidcom.json` mang project ID, ổn định khi thư mục bị di chuyển.
- MUST NOT dùng path làm ID.
- Trùng ID (người dùng copy thư mục) → project mở sau được cấp ID mới, ghi lại `vidcom.json`, log sự kiện.
