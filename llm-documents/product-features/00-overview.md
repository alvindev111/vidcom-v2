# 00 — Tổng quan hệ thống

## 1. Sản phẩm là gì

vidcom-v2 = **web studio để soạn và xem trước video dạng HTML animation**, chạy trên framework **HyperFrames** (`@hyperframes/*` v0.7.86, của HeyGen).

Một "video" trong hệ thống này **không phải file MP4**, mà là **một thư mục project** chứa:
- `index.html` — root composition (khung 1920×1080, khai báo thời lượng, mount các scene con)
- `compositions/*.html` — sub-composition = scene
- `assets/` — ảnh/SVG/video
- `narration/*.json` — bản ghi job TTS
- `preview-settings.json` — cấu hình look & sound của preview
- `hyperframes.json`, `meta.json`, `registry-item.json` — metadata

Studio này **đọc/ghi trực tiếp lên các file đó**. Không có database.

## 2. Tech stack hiện tại

| Lớp | Công nghệ |
|---|---|
| Framework | Next.js `16.2.12` (App Router, RSC), React `19.2.4` |
| Runtime dev | Bun (`bun.lock`) |
| UI | Tailwind CSS v4, shadcn/ui, radix-ui, lucide-react, next-themes (dark default) |
| Layout | `react-resizable-panels` |
| Code editor | CodeMirror 6 (`codemirror`, `@codemirror/lang-{html,css,javascript,json}`, theme `one-dark`) |
| Video engine | `@hyperframes/core`, `@hyperframes/sdk`, `@hyperframes/studio-server`, `@hyperframes/player`, `@hyperframes/parsers` |
| HTML parse (server) | `linkedom` (shim `globalThis.DOMParser` cho Node) |
| Audio | Web Audio API (tự synth âm thanh, không dùng file) |
| Dependency chưa dùng | `@modelcontextprotocol/client` (đã cài, chưa gọi ở đâu) |

`next.config.ts` để `serverExternalPackages` cho toàn bộ `@hyperframes/*` + `esbuild` + `linkedom` — các package này là Node-only, không bundle được, và `linkedom` phải chỉ có **một** bản để `DOMParser` không bị nhân đôi.

## 3. Cấu trúc mã nguồn

```
src/
  app/
    page.tsx                          # Home: danh sách project
    projects/[slug]/page.tsx          # Studio (server component, force-dynamic)
    layout.tsx                        # ThemeProvider, font Geist
    api/hf/
      runtime/route.ts                # GET: script runtime HyperFrames
      [slug]/preview/route.ts         # GET: HTML preview (đã inject runtime + settings)
      [slug]/files/[...path]/route.ts # GET: asset tĩnh trong project
      [slug]/source/route.ts          # GET/PUT: đọc/ghi 1 file text
      [slug]/scene/route.ts           # PATCH: timing | script | tts | generate
      [slug]/preview-settings/route.ts# GET/PATCH/POST: cấu hình preview + upload BGM
  components/
    home/*                            # Card, grid, thumbnail placeholder
    studio/*                          # Toàn bộ studio (36 file)
    ui/*                              # shadcn primitives
  lib/
    hyperframes/*.server.ts           # Lớp đọc/ghi project (server-only)
    studio/*                          # Kiểu dữ liệu + helper thuần (dùng cả 2 phía)
projects/
  swiss-grid/ kinetic-type/ warm-grain/   # 3 project mẫu
```

Quy ước: file `*.server.ts` có `import "server-only"` — chỉ chạy trên server, được import trực tiếp bởi RSC hoặc route handler. `src/lib/studio/*` là code thuần, dùng chung client/server (trừ `preview-sounds.ts` có `"use client"`).

## 4. Layout UI của Studio

```
┌───────────────────────── /projects/[slug] ─────────────────────────┐
│ SourcePane (38%)              │ PreviewPanel (62%)                 │
│ ┌───────────────────────────┐ │ ┌────────────────────────────────┐ │
│ │ [←] Code | Video Scene |  │ │ │ PreviewCanvas (62% cao)        │ │
│ │     AI Composer   [theme] │ │ │  <hyperframes-player> letterbox│ │
│ ├───────────────────────────┤ │ ├────────────────────────────────┤ │
│ │ Tab Code:                 │ │ │ PlaybackBar (h-11)             │ │
│ │  FileExplorer | Editor    │ │ │  ▶ 0:03/0:14 ──●── 🔊 1x ⧉    │ │
│ │                           │ │ ├────────────────────────────────┤ │
│ │ Tab Video Scene:          │ │ │ Timeline (38% cao)             │ │
│ │  Storyboard (52%)         │ │ │  toolbar · ruler · lanes       │ │
│ │  ── Scene | Preview editor│ │ │  (root track + scene lanes)    │ │
│ │                           │ │ │                                │ │
│ │ Tab AI Composer:          │ │ │                                │ │
│ │  terminal + prompt input  │ │ │                                │ │
│ └───────────────────────────┘ │ └────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

Điểm thiết kế quan trọng: **player được mount ở `StudioShell`** ([studio-shell.tsx:47](../../src/components/studio/studio-shell.tsx#L47)), không ở trong PreviewPanel. Lý do: tab Scene bên trái cũng seek nó, và cả hai bên cần cùng một `currentTime`. Đổi tab bên trái **không unmount** player → video vẫn đang chạy.

## 5. Luồng dữ liệu (đọc)

```
Request /projects/swiss-grid
   │
   ├─ readProject(slug)          → title, width, height, duration, entry
   ├─ readSourceFile(slug,"index.html") → code + version
   ├─ readProjectTree(slug)      → FileNode[] (bỏ node_modules/.git/.hyperframes)
   ├─ readScenes(slug)           → Scene[]   ← nặng nhất, xem 11-parsing-logic.md
   ├─ readRootTrack(slug)        → RootTrack | null
   └─ readPreviewSettings(slug)  → PreviewSettings (normalize kể cả file lỗi)
   │
   ▼
<StudioShell …props/>  (client component, nhận toàn bộ snapshot)
   │
   ▼
useHyperframesPlayer("/api/hf/<slug>/preview")
   │
   ▼ (browser)
<hyperframes-player src> → iframe → GET /api/hf/<slug>/preview
   │                                    │
   │                                    ├─ buildSubCompositionHtml(dir,"index.html",RUNTIME_URL,filesBase)
   │                                    └─ injectPreviewSettings(root:true) → +<style>, +tone overlay, +<audio bgm>
   ▼
runtime fetch các `data-composition-src` → GET /api/hf/<slug>/files/compositions/*.html
runtime fetch asset            → GET /api/hf/<slug>/files/assets/*
```

## 6. Luồng dữ liệu (ghi) — quan trọng cho backend mới

Mọi thao tác ghi đều kết thúc bằng một trong **hai** callback ở `StudioShell`, tuỳ theo việc ghi đó có làm đổi *scene là gì* hay không:

```
UI action → fetch(api) → ghi file trên đĩa → response
                                              │
              ┌───────────────────────────────┴───────────────────────────────┐
              ▼                                                               ▼
   handleProjectChanged()                                            rebuildPreview()
   (sửa source / timing / script / tạo scene)                        (chỉ preview-settings)
              │                                                               │
    ┌─────────┴──────────┐                                          setRevision(r+1)
    ▼                    ▼                                          (chỉ remount player)
setRevision(r+1)   router.refresh()
(đổi ?r= trên      (RSC re-render → đọc lại
 preview URL →      project từ đĩa → props mới)
 remount player)
```

Lý do tách (comment [studio-shell.tsx:59](../../src/components/studio/studio-shell.tsx#L59)): một thay đổi preview-settings **không** đổi scene — giá trị chỉ được bake vào tài liệu preview, còn scene / file tree / root track trên server không đụng tới. Refresh cả trang cho mỗi lần đổi màu nghĩa là **re-parse toàn bộ project sau mỗi lần kéo color picker**.

Có 3 nhóm ghi:

| Nhóm | Endpoint | Ghi gì |
|---|---|---|
| Sửa source thô | `PUT /source` | ghi nguyên văn 1 file text, có kiểm tra `baseVersion` |
| Sửa qua SDK | `PATCH /scene` (`timing`/`script`/`generate`) | `openComposition()` → op → `serialize()` → ghi lại HTML |
| Cấu hình preview | `PATCH/POST /preview-settings` | ghi `preview-settings.json`, hoặc lưu file BGM |
| TTS | `PATCH /scene` (`tts`) | ghi `narration/<sceneId>.json` |

**Cảnh báo cho backend mới:** SDK `serialize()` **viết lại toàn bộ document từ DOM**: `<script>`/`<style>` giữ nguyên nội dung nhưng **indentation bị chuẩn hoá** và **`data-hf-id` bị stamp thêm** vào mọi element ([sdk.server.ts:38](../../src/lib/hyperframes/sdk.server.ts#L38)). So sánh `projects/warm-grain/index.html` (đã bị SDK ghi, có `data-hf-id`) với `projects/swiss-grid/index.html` (chưa) sẽ thấy rõ. Đây là hành vi có chủ ý, chấp nhận theo studio chính thức của HyperFrames.

## 7. Cách một project được coi là hợp lệ

`projectDir(slug)` ([projects.server.ts:50](../../src/lib/hyperframes/projects.server.ts#L50)):
1. `resolveWithinProject(PROJECTS_ROOT, slug)` — chặn path traversal, trả `null` nếu thoát khỏi `projects/`.
2. Phải tồn tại `<dir>/hyperframes.json`.
3. Entry **luôn hard-code** là `index.html`; nếu thiếu → `readProject` trả `null` → 404.

`PROJECTS_ROOT = join(process.cwd(), "projects")` — tức phụ thuộc cwd của process Next.js.

## 8. Bảo mật hiện tại

- **Không có auth, không có session, không có user.** Mọi endpoint mở.
- Chống path traversal duy nhất bằng `resolveWithinProject` của `@hyperframes/core` (dùng ở `readProjectFile`, `editablePath`, `projectDir`).
- Whitelist đuôi file cho phép sửa: `html css js mjs ts json md txt py svg` ([projects.server.ts:293](../../src/lib/hyperframes/projects.server.ts#L293)).
- Giới hạn kích thước: source `2 MB`, BGM `20 MB`.
- Tên file BGM upload bị sanitize: `name.replace(/[^\w.-]+/g,"-").replace(/^-+/,"")`.
- **Không có** rate limit, CSRF token, kiểm tra content-type nghiêm ngặt, virus scan, hay giới hạn tổng dung lượng project.

## 9. Cache & hiệu năng hiện tại

- Mọi route/page đặt `export const dynamic = "force-dynamic"` + header `cache-control: no-store` → **không cache gì cả**, vì file trên đĩa có thể bị agent/CLI sửa ngoài app.
- `blockCache: Map<string, SceneBlock|null>` trong `scenes.server.ts` — cache theo `registryBaseUrl#name`, **process-lifetime, không TTL, không giới hạn size**.
- `memoPerProject()` ([projects.server.ts:130](../../src/lib/hyperframes/projects.server.ts#L130)) — memo một giá trị mỗi project, invalidate bằng `projectFingerprint()` (`path:mtimeMs:size` của mọi file trong project). Promise reject thì tự xoá khỏi cache. Đã bọc **cả 5** read nặng: `readProject`, `buildPreviewHtml`, `readProjectTree`, `readRootTrack`, `readScenes`.
- Khi **cache miss**: parse `index.html` ít nhất **4 lần** (`readProject`, `readCompositionHosts`, `readRootTrack`, và SDK `openComposition` cho mỗi scene inline), cộng 1 lần parse cho mỗi file sub-composition, cộng 1 `openComposition` SDK cho mỗi scene. Với project ~5 scene là ~12 lần parse HTML.
- Chi phí còn lại: `projectFingerprint()` **`stat` toàn bộ cây** mỗi lần gọi, và nó được gọi một lần cho mỗi hàm memo → 5 lần duyệt cây mỗi lần render trang. Backend mới nên đổi sang invalidate theo **event của file watcher**.
- `readBlock` gọi HTTP ra `raw.githubusercontent.com` với timeout 4s cho mỗi block lạ → load trang có thể chậm 4s nếu mạng lỗi (đã bọc try/catch, fail mềm).

## 10. Đích đến — đọc ở đâu

Tài liệu 00–12 mô tả **hiện trạng**. Định hướng và luật hiện thực nằm ở nơi khác:

| Câu hỏi | Đọc |
|---|---|
| Kiến trúc đích, đóng gói, MCP, workspace | [14-local-first-mcp-packaging-architecture](14-local-first-mcp-packaging-architecture.md) |
| Danh sách chức năng cần có | [13-backend-requirements](13-backend-requirements.md) |
| Làm theo thứ tự nào | [15-build-order](15-build-order.md) |
| Viết code thế nào | [`steering/`](../steering/00-index.md) |

Bốn quyết định đã chốt (doc 14 §1): **D1** MCP hạng nhất · **D2** một file thực thi · **D3** web UI + workspace người dùng chọn · **D4** backend 100% Hono, Next chỉ forward.

## 11. Trạng thái tổng quát

Đây là **giai đoạn mock/prototype**. Xem chi tiết [12-mock-vs-real.md](12-mock-vs-real.md). Tóm tắt:

- **THẬT:** đọc project, parse scene/timeline, preview bằng player thật, sửa source file, sửa timing/text qua SDK, ghi `preview-settings.json`, upload BGM, tạo scene mới (file + mount thật), ghi sidecar narration.
- **MOCK:** transcript agent (Claude/Codex), transcript MCP, TTS (chỉ ghi lệnh, không render wav), poster thumbnail ở Home, âm thanh scene (chỉ audition WebAudio, không đi vào render).
- **NÚT CHẾT:** New file / New folder / New project / Pop out preview.
- **CHƯA CÓ:** render/export MP4, tạo project, xoá/đổi tên file, xoá scene, kéo-thả timeline, undo/redo, lint/check, snapshot, cài block từ registry, multi-user.
