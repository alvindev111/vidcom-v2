# 07 — Data & storage

## 0. Cấu hình người dùng — `~/.vidcom/setting.json`

Vùng thứ ba, nhỏ nhưng đứng **trước** hai vùng kia trong thứ tự khởi động: nó có quyền khai app-data nằm ở đâu, nên phải đọc được trước khi biết app-data là gì. Vì thế nó ở đường dẫn cố định theo home, không theo convention app-data của OS.

```text
~/.vidcom/
└── setting.json     (0600 / Windows ACL chỉ current user)
```

```json
{
  "appDataRoot": null,
  "workspaceRoot": null,
  "tts": {
    "defaultProviderId": "vieneu",
    "defaultVoiceId": "vieneu-v3-pham-tuyen",
    "defaultRatePercent": 0,
    "defaultComputeDevice": "cpu",
    "elevenlabs": { "apiKey": null },
    "vieneu": { "command": null, "modelRevision": null }
  }
}
```

Luật:

- **Schema strict.** Key sai chính tả → **lỗi khởi động** nêu tên field, MUST NOT bỏ qua. Một setting bị âm thầm phớt lờ là loại misconfiguration khó tìm nhất: API key nằm đó mà daemon vẫn báo healthy.
- **File không có = mặc định.** File rỗng cũng vậy. Chỉ file *sai* mới là lỗi.
- **Env thắng file.** `VIDCOM_APP_DATA`, `VIDCOM_WORKSPACE`, `ELEVENLABS_API_KEY` override, để CI và một lần chạy lẻ không phải ghi secret xuống đĩa, và để operator sửa được mà không cần mở file.
- **Quyền `0600`** và directory `0700` — file này chứa API key dịch vụ trả phí, cùng mức bảo vệ như `<app-data>/credentials` ([09-security](09-security.md) §2).
- MUST NOT log nội dung file, kể cả trong message lỗi parse. Lỗi nêu **tên field và luật bị vi phạm**, không nêu giá trị.
- `VIDCOM_HOME` đổi thư mục, `VIDCOM_SETTINGS` chỉ thẳng file — cho test và bản portable.
- Entry point app tạo sẵn file template lúc khởi động (để người dùng không phải đoán schema); `vidcom mcp` **không** tạo — nó do AI host spawn, ghi vào home như tác dụng phụ của một handshake là không phải việc của nó.

Ranh giới với `app_settings` trong SQLite: file này là **cấu hình người dùng khai**; bảng SQLite là **state vận hành** (`active_workspace`…). Cùng một thứ MUST NOT nằm ở cả hai chỗ.

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
├── renders/
└── .vidcom/              projection bền, đọc được; authority vẫn là SQLite
```

### Application-data hệ điều hành — HIDDEN
State vận hành, không thuộc về project.

```text
<app-data>/
├── settings.json    vidcom.sqlite
├── credentials      (0600)
├── bgm/             reusable audio + licence/provenance ledger
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
| BGM library + licence/provenance ledger | app-data | Nguồn dùng lại giữa project; `install_bgm` copy exact bytes vào `preview-assets/bgm/` nên project đã cài vẫn render độc lập |
| `narration/*.wav` | **project** | Đi vào bản render |
| Parse cache | app-data | Dựng lại được |
| Registry cache | app-data | Dựng lại được |
| Job state, audit, revision | app-data | **Authority** vận hành trong SQLite; commit transaction được |
| `.vidcom/jobs/`, `.vidcom/revisions/`, `.vidcom/logs/` | project | Projection bền/người đọc được; rebuild một chiều từ SQLite, MUST NOT ghi ngược |
| `.vidcom/context/project-context.md` | project | Context deterministic cho harness; không absolute path/timestamp/job ID/secret |
| Chromium, FFmpeg, TTS model | app-data | Runtime, không thuộc project |

MUST NOT ghi bí mật vào workspace. MUST NOT đặt **authority** state vận hành vào workspace. `.vidcom/` là ngoại lệ projection đã chốt: SQLite vẫn là authority + engine giao dịch; projection lệch phải phát hiện/rebuild được và MUST NOT được dùng để phục hồi ngược SQLite.

## 3. Workspace root — cwd là input tường minh, không là dependency ngầm

MUST NOT gọi `process.cwd()` rải rác để tự tìm project. Bản mock có `PROJECTS_ROOT = join(process.cwd(), "projects")` — dependency ngầm, không hoạt động khi đóng gói. Entrypoint được phép đọc cwd **một lần** như một input của bảng quyết định dưới đây rồi inject `WorkspaceRoot` xuống.

`WorkspaceRoot` được resolve **một lần** ở composition root và inject xuống. Thứ tự ưu tiên:

1. `--workspace <absolute-path>` / `VIDCOM_WORKSPACE` / config MCP tường minh;
2. cwd có **file** `vidcom.json` (xét sự có mặt, kể cả file parse lỗi) → workspace là thư mục cha; nếu cha không đọc được thì dùng cwd ở chế độ `cwd-solo` và phải cảnh báo/xác nhận trước mọi ghi workspace-level;
3. workspace active đã lưu nếu còn đọc được; nếu mất thì cảnh báo nêu path rồi fallback;
4. cwd đọc được → dùng cwd làm workspace;
5. nếu không có đường nào đọc được thì yêu cầu người dùng chọn; MUST NOT tự tạo thư mục đoán được.

Lý do cwd-có-marker đứng trên active: `cd my-video && vidcom` MUST NOT âm thầm mở workspace cũ. Marker lỗi vẫn giữ ưu tiên để lỗi được hiển thị tại đúng project, không bị che bởi fallback.

## 4. Ghi file — quy tắc cứng

Mọi ghi lên workspace MUST đi qua facade **`WriteAuthority` duy nhất** trong Core. Use case MUST NOT gọi `writeFile`, directory port hay journal port trực tiếp. Facade có method tách theo ý nghĩa (`mutateSource`, `mutateDerived`, `mutateWorkspace`, project-directory lifecycle); caller MUST NOT truyền một boolean để tự chọn có tăng source revision hay không.

Scope project dùng journal/revision/backup hiện có. Scope workspace-level dùng coordinator operation/step nội bộ để rollback batch và directory staging, nhưng coordinator MUST NOT được inject trực tiếp ra usecase; agent-kit mutation không bịa `projectId` và không tạo revision/backup.

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
- Payload rollback và revision authority lưu ở app-data; MUST NOT copy payload lịch sử đầy đủ vào workspace.
- `.vidcom/revisions/` và `.vidcom/jobs/` được phép chứa **projection** đọc được của dữ liệu SQLite. Chúng không phải nội dung revision/authority, MUST được gitignore, rebuild một chiều và MUST NOT ghi ngược vào SQLite.
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
