# 03 — Kiến trúc & DDD

## 1. Hình dạng tổng thể

```
adapter HTTP (Hono) ─┐
                     ├─▶ Application Core ─▶ Port ─▶ adapter (fs, hyperframes, db, renderer, tts)
adapter MCP ─────────┘
```

Hai luật:

1. **HTTP và MCP là hai adapter ngang hàng**, cùng gọi một tập use case. Nghiệp vụ nằm ở Core, không ở adapter.
2. **Core không biết ai gọi nó.** Không `Request`, không `Context` của Hono, không transport MCP, không `process.cwd()`.

Kiểm tra nhanh xem có vi phạm không: *nếu bỏ hoàn toàn tầng HTTP, MCP có làm được mọi việc không?* Nếu không — nghiệp vụ đã rò lên adapter, và D1 chưa đạt.

## 2. Tầng

### 2.1 Domain (`core/domain`)

Entity, value object và invariant thuần. Không I/O, không async trừ khi thật cần.

Domain của vidcom xoay quanh:

| Khái niệm | Là gì |
|---|---|
| `Workspace` | thư mục người dùng chọn, chứa nhiều project |
| `Project` | một thư mục có `hyperframes.json` + `index.html` |
| `Composition` | tài liệu HTML gốc (`index.html`) |
| `Scene` | một composition host lồng trong root |
| `SceneElement` / `SceneEffect` | element có timing riêng và các tween tác động lên nó |
| `RootTrack` | media + motion ở cấp entry document |
| `PreviewSettings` | tone, palette, BGM, subtitle, per-scene |
| `Narration` | job TTS của một scene |
| `Job` | tác vụ dài: render, tts, snapshot |
| `Revision` | một lần ghi có thể rollback |

Invariant thuộc domain, MUST NOT nằm rải trong route handler:

- `duration > 0`, `start >= 0`.
- `scene.start + scene.duration` vượt root duration → hoặc nới root, hoặc từ chối. Không im lặng.
- Scene sinh ra phải có file `src` riêng (**P11**) — host inline không được runtime quản lý visibility.
- Ghi text vào element phải qua `hf-id`, không qua selector đoán được.

### 2.2 Use case (`core/usecase`)

Một use case = một thao tác người dùng hoặc AI có thể yêu cầu.

Hình dạng chuẩn:

```ts
export interface CreateSceneInput {
  projectId: ProjectId;
  title: string;
  duration?: number;
  start?: number;
  trackIndex?: number;
}

export interface CreateSceneOutput {
  scene: Scene;
  project: ProjectSummary;   // trả entity mới, KHÔNG phải { ok: true }
  diagnostics: Diagnostic[];
}

export async function createScene(
  deps: { workspace: WorkspacePort; composition: CompositionPort; clock: ClockPort },
  input: CreateSceneInput,
): Promise<Result<CreateSceneOutput, DomainError>> { … }
```

Quy tắc:

- MUST nhận dependency qua tham số `deps`, không import adapter, không dùng singleton.
- MUST trả `Result<T, DomainError>` — không throw cho lỗi nghiệp vụ dự đoán được. Throw chỉ dành cho bug lập trình.
- MUST trả **entity đã cập nhật**, không phải `{ ok: true }`. Đây là bug thật của bản mock: client buộc phải refresh cả trang sau mỗi edit.
- MUST là nơi duy nhất quyết định thứ tự các bước. Adapter không được tự ghép nhiều thao tác Core thành một.

### 2.3 Port (`core/port`)

Chỉ interface. Core khai báo cái nó **cần**, không mô tả cái adapter **có**.

```ts
export interface WorkspacePort {
  listProjects(): Promise<ProjectRef[]>;
  readFile(ref: ProjectRef, path: string): Promise<FileContent | null>;
  writeFile(ref: ProjectRef, path: string, content: string, expected?: ContentHash):
    Promise<Result<FileContent, WriteConflict>>;
  // …
}
```

Port tối thiểu cần có: `WorkspacePort`, `CompositionPort` (parse + SDK edit), `PreviewPort` (build document), `RendererPort`, `TtsPort`, `SnapshotPort`, `JobStorePort`, `AuditPort`, `RegistryPort`, `ClockPort`, `IdPort`.

Mỗi method của port MUST có doc comment ([11-code-style](11-code-style.md) §4). Port là hợp đồng giữa Core và adapter — người viết adapter chỉ nhìn thấy interface, nên `null` nghĩa là gì, có ném lỗi không, có atomic không đều phải nằm ở đó.

**`ClockPort` và `IdPort` là bắt buộc.** `new Date()` và random ID gọi trực tiếp trong Core làm test không deterministic và golden-file test vô dụng.

### 2.4 Adapter (`adapter/*`)

Implement port. Được biết về `node:fs`, `linkedom`, `@hyperframes/*`, SQLite, puppeteer.

MUST NOT chứa quyết định nghiệp vụ. Adapter dịch, không quyết.

Ví dụ ranh giới đúng:
- Adapter biết `data-duration` là attribute nào và đọc nó ra sao.
- Core quyết định `duration` hợp lệ hay không và có nới root hay không.

## 3. Ràng buộc riêng của vidcom

### 3.1 P3 — preview và render một code path

Preview và render MUST đi qua **cùng một** hàm dựng document:

```
buildPreviewDocument(project, settings, { root: boolean }) → html
```

MUST NOT có hai đường dựng HTML. Nếu render inject preview-settings khác với preview, người dùng thấy một đằng nhận một nẻo. Core expose đúng một entry point; `PreviewPort` và `RendererPort` cùng gọi nó.

### 3.2 P2 — preview settings không rewrite source

Đổi màu, âm lượng, subtitle MUST chỉ ghi `preview-settings.json` và inject CSS/markup lúc dựng document. MUST NOT đụng vào composition HTML.

### 3.3 P1 — `data-*` là nguồn sự thật

Đọc kích thước, thời lượng, danh sách scene, timing **từ attribute trên DOM**, không từ `registry-item.json` hay `meta.json`. Metadata JSON chỉ dùng làm fallback cho title/description/dimension.

### 3.4 P5 — đếm, không đoán

Khi parser không giải được (tween có target dựng trong loop, selector động):

- MUST đếm và báo (`unresolvedEffects: number`).
- MUST NOT bịa giá trị mặc định.

Nguyên văn lý do trong code hiện tại: *"a made-up start time on a timeline is worse than a gap."*

### 3.5 Mọi write đi qua một chỗ

Core phải có một service duy nhất chịu trách nhiệm ghi file project, lo: content hash check, atomic write, revision record, audit, phát event. Use case gọi service đó, MUST NOT gọi `writeFile` của port trực tiếp. Xem [07-data-and-storage](07-data-and-storage.md).

## 4. Error

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface DomainError {
  code: ErrorCode;          // enum trong contracts, machine-readable
  message: string;          // cho người đọc
  field?: string;           // để UI gắn lỗi vào đúng ô nhập
  details?: Record<string, unknown>;
}
```

- `ErrorCode` định nghĩa **một lần** trong `contracts`, dùng chung HTTP và MCP.
- Adapter HTTP map `ErrorCode` → HTTP status. Adapter MCP map `ErrorCode` → MCP error. Core không biết status code.
- MUST NOT trả lỗi chỉ là chuỗi tiếng Anh — bản mock làm vậy và UI không gắn được lỗi vào field nào.

## 5. Composition root

Chỉ `packages/cli` được phép nối adapter cụ thể vào port:

```ts
const deps = {
  workspace: new FsWorkspace(workspaceRoot),
  composition: new HyperframesComposition(),
  renderer: new PuppeteerRenderer(runtimePaths),
  clock: systemClock,
  // …
};
```

Đây là chỗ **duy nhất** biết cả hai phía. Mọi nơi khác chỉ thấy interface.

## 6. Cấm

| Cấm | Vì sao |
|---|---|
| Nghiệp vụ trong route handler | Adapter phải mỏng; MCP sẽ không có nghiệp vụ đó |
| Adapter gọi adapter khác | Core điều phối, adapter không |
| Singleton/global state trong Core | Không test được, không chạy song song được |
| `new Date()` / `Math.random()` trong Core | Dùng `ClockPort` / `IdPort` |
| Use case gọi use case khác qua HTTP | Gọi hàm trực tiếp |
| Trả `{ ok: true }` | Trả entity mới (§2.2) |
