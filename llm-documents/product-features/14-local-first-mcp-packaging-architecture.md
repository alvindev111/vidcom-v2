# 14 — Định hướng kiến trúc local-first, MCP và đóng gói ứng dụng

> **Trạng thái:** Định hướng kiến trúc. Chưa phải Detailed Design, chưa khởi động spec process.
> §1 là **hướng đi đã chốt** của dự án. Phần còn lại là đề xuất cách hiện thực và các rủi ro đã xác định.
>
> **Hiện trạng 2026-08-02:** Giai đoạn 2 đã được hiện thực và xác minh local: một Registry 10 tool phục vụ legacy/modern qua stdio và Streamable HTTP; write composite/recovery, approval grant, backup, audit và credential đều dùng SQLite/filesystem production. Node SEA và authenticated IPC bridge vẫn thuộc Giai đoạn 4.

Tài liệu này mô tả *cách* hiện thực các yêu cầu chức năng ở [13-backend-requirements.md](13-backend-requirements.md). Application Core phải bảo toàn 11 nguyên tắc **P1–P11** ở doc 13 §1 — đặc biệt **P3** (preview và render dùng chung code path), vì nó ràng buộc trực tiếp cách chia module ở §6.

---

## 1. Hướng đã chốt

Ba quyết định định hình toàn bộ phần còn lại:

| # | Quyết định | Hệ quả chính |
|---|---|---|
| **D1** | **MCP là interface hạng nhất.** VidCom export một MCP server để Codex/Claude/AI host điều khiển backend qua tool contract có giới hạn. | MCP không phải adapter phụ. Use case nào không gọi được qua MCP thì coi như chưa hoàn chỉnh. §6.2, §11 |
| **D2** | **Đóng gói thành một file thực thi**, che giấu source backend và frontend. Người dùng nhận một binary, không nhận source code. | Node SEA nhúng JS bundle + native runtime archive có checksum. §2, §3, §14 (R1) |
| **D3** | **Người dùng bật web lên, chọn thư mục lưu project.** Project nằm public trong thư mục đó (xem được, copy được, Git commit được). Mọi thứ khác bị giấu. | Cần cơ chế chọn thư mục **không có native dialog**. §9. Ranh giới public/hidden: §10 |
| **D4** | **Backend 100% do Hono xử lý. Next.js chỉ forward.** Không có nghiệp vụ nào ở lại trong Route Handler hay server component của Next. | Một backend duy nhất, hai host. Xoá bỏ rủi ro "hai đường ghi song song". §5 |

Backend mới: **Hono + TypeScript**. Development vẫn có thể dùng Bun; artifact phát hành chạy bằng Node SEA.

> Xác nhận: `hyperframes` CLI **đã dùng Hono** — `node_modules/hyperframes/dist/studio/index.js` import `hono`, và CLI khai báo dep `hono` + `@hono/node-server`. Chọn Hono trùng với studio server chính thức của HyperFrames, không phải lựa chọn tuỳ tiện.

---

## 2. Che giấu được đến đâu — và phải làm gì với phần không giấu được

D2 đạt được mục tiêu thực tế: **người dùng không nhận source code, không copy-paste được logic, không sửa được backend**. Đó là mức bảo vệ hợp lệ và là điều compile làm tốt.

Nhưng cần phân biệt ba mức để không thiết kế sai:

| Mức | Ai | Compile giải quyết? |
|---|---|---|
| Người dùng thường / đối thủ copy nhanh | Không đọc được logic, không tái sử dụng source | ✅ Có |
| Reverse engineer có chủ đích | Binary vẫn disassemble được; SEA nhúng JS bundle, có thể trích xuất | ❌ Không |
| Bí mật thật (API key, license signing key, thuật toán tính phí) | Bất cứ thứ gì nằm trong bundle đều đọc được | ❌ Không — **phải nằm server-side** |

### Chiến lược che giấu — làm tối đa những gì có tác dụng

**Backend** (chạy dưới dạng binary trên máy người dùng):
- Bundle entry CommonJS rồi nhúng vào Node SEA, **không kèm sourcemap**.
- Pin exact Node build toolchain; tắt code cache/snapshot khi build khác platform.
- Không để file `.ts`/`.js` nào của backend nằm ngoài binary.

**Frontend** (bắt buộc gửi tới browser để chạy):
- Build production, minify, **tắt sourcemap**, bỏ comment.
- Nhúng asset đã build **vào trong SEA assets**, serve từ memory — không có thư mục `dist/` để người dùng mở.
- Chấp nhận: HTML/CSS/JS vẫn đọc được qua DevTools. Không có cách nào tránh, kể cả Tauri (webview cũng là browser).

**Không bao giờ nhúng vào bundle:**
- API key của dịch vụ trả phí (TTS cloud, model API).
- License signing key / logic verify license offline.
- Bất cứ thứ gì mà việc lộ ra làm mất doanh thu.

Những thứ này phải nằm sau một dịch vụ do VidCom kiểm soát. Nếu sản phẩm cần chạy offline hoàn toàn, thì **không được có** bí mật loại này trong thiết kế ngay từ đầu.

### Hệ quả thiết kế
Vì logic quan trọng nằm trong backend chạy local (không phải trong frontend), việc chuyển nghiệp vụ từ Next.js server component sang Application Core **cũng chính là** việc tăng mức che giấu. Frontend càng mỏng, càng ít lộ.

---

## 3. "Một file thực thi" — thực tế đạt được đến đâu

Node SEA nhúng Hono + MCP + frontend asset thành một executable. **Native dependency của pipeline video** không nằm trực tiếp trong JS bundle; chúng được đóng thành archive theo platform, nhúng như SEA asset và giải nén có checksum vào app-data:

| Thành phần | Loại | Bằng chứng trong `node_modules` |
|---|---|---|
| `esbuild` | binary theo platform | `@esbuild/darwin-arm64` — `@hyperframes/core` gọi vào từ HTML compiler |
| `onnxruntime-node` | `.node` addon | prebuilt `darwin` / `linux` / `win32` × `arm64` / `x64` — runtime TTS (Kokoro) |
| `sharp` + libvips | `.node` addon | `@img/sharp-darwin-arm64`, `sharp-libvips-darwin-arm64`, fallback `sharp-wasm32` |
| Chromium | browser runtime | tải qua `@puppeteer/browsers`, dùng bởi `puppeteer-core@25.4.0` — cho **snapshot/render**, không phải preview |
| FFmpeg/FFprobe | binary | cho xử lý audio/video |
| Font, template, registry asset | data | `giget` fetch template từ network |

⚠️ **Cảnh báo thêm:** `package.json` gốc có `"ignoreScripts": ["sharp", "unrs-resolver"]` — postinstall của sharp đang bị bỏ qua. Packaged build phải xử lý native binary của sharp tường minh, không dựa vào postinstall.

### Mục tiêu phát hành thực tế

> **Một file tải xuống. Một icon để chạy. Người dùng không thấy thành phần bên trong.**

Cách đạt: executable tự giải nén sidecar và runtime asset vào application-data ở lần chạy đầu (`vidcom doctor` kiểm tra và bổ sung). Người dùng vẫn thấy "một file"; các binary phụ nằm trong thư mục ẩn của hệ điều hành, không nằm cạnh file tải về.

Mỗi OS × kiến trúc CPU cần artifact, code signing và kiểm thử riêng.

---

## 4. Kiến trúc tổng thể

```text
┌──────────────────┐   HTTP + SSE/WS   ┌───────────────────────────────┐
│ Web UI / WebView │ ────────────────▶ │  HOST (đổi được, không đổi    │
└──────────────────┘                   │  code của app bên trong)      │
                                       │                               │
                                       │  dev  : Next.js               │
                                       │         api/[[...route]]      │
                                       │         → handle(app)         │
                                       │  prod : Node SEA              │
                                       │         serve({app.fetch})    │
                                       │                               │
                                       │  ┌─────────────────────────┐  │
                                       │  │ Hono app  — SINGLE      │  │
                                       │  │ 127.0.0.1  WRITER       │  │
                                       │  └───────────┬─────────────┘  │
                                       └──────────────┼────────────────┘
┌──────────────────┐   MCP stdio                      │
│ Codex / Claude   │ ─────────┐                       │
│ hoặc AI host     │          │                       │
└──────────────────┘          ▼                       │
                    ┌────────────────────┐  local IPC │
                    │ vidcom mcp bridge  │ ───────────┤
                    │ (stdio ⇄ IPC)      │  + token   │
                    └────────────────────┘            │
                                       ┌──────────────▼────────────────┐
                                       │ Application Core              │
                                       │ use case + domain rule        │
                                       └──────┬──────────────┬─────────┘
                                  ┌───────────▼──┐      ┌────▼────────┐
                                  │ Workspace    │      │ Job workers │
                                  │ filesystem   │      │ render/TTS  │
                                  └──────────────┘      └─────────────┘
```

Ba nguyên tắc bất biến:

1. **HTTP và MCP chỉ là adapter.** Cả hai gọi chung Application Core. Không được cài lại nghiệp vụ theo hai cách khác nhau — nếu không, AI và UI sẽ hành xử khác nhau trên cùng một thao tác.
2. **Next.js không phải một tầng** (D4). Nó là host tạm thời của Hono app, thay được bằng `@hono/node-server` trong Node SEA mà không sửa code trong app. Xem §5.
3. **Daemon là single writer.** MCP bridge không tự ghi file; nó là client của daemon (§8).

---

## 5. Next.js chỉ forward — Hono là backend duy nhất (D4)

### 5.1 Cơ chế

Hono có adapter chính thức cho Next.js App Router: `hono/vercel`. Một Route Handler catch-all duy nhất nhận mọi request và giao thẳng cho Hono app.

```ts
// src/app/api/[[...route]]/route.ts  — file DUY NHẤT của Next trong tầng API
import { handle } from "hono/vercel";
import { app } from "@vidcom/server";   // Hono app, không biết gì về Next

// Bắt buộc: HyperFrames là Node-only (esbuild, linkedom, native addon).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
```

Hono app tự khai báo `basePath` và **không import bất cứ thứ gì từ `next`**:

```ts
// packages/server/src/app.ts
import { Hono } from "hono";
export const app = new Hono().basePath("/api");
```

### 5.2 Vì sao điều này quan trọng hơn vẻ ngoài

Cùng một object `app` chạy được dưới **hai host** mà không sửa dòng nào:

| Giai đoạn | Host | Cách chạy |
|---|---|---|
| Development | Next.js Route Handler | `handle(app)` qua `hono/vercel` |
| Đóng gói (D2) | Node SEA | `@hono/node-server` với `serve({ fetch: app.fetch })` |
| Spike/dev Bun | Bun runtime | Chỉ dùng khi đường code không phụ thuộc compiled native loader |

Nghĩa là **không có "port backend sang Hono" ở cuối dự án**. Backend là Hono ngay từ commit đầu tiên; việc bỏ Next chỉ là đổi host và bỏ một file.

### 5.3 Cắt chuyển từng route — an toàn nhờ độ ưu tiên của Next

Next App Router khớp route theo thứ tự: **static → dynamic → catch-all → optional catch-all**. Nên `src/app/api/hf/[slug]/preview/route.ts` (cụ thể) **thắng** `src/app/api/[[...route]]/route.ts` (optional catch-all).

Quy trình cắt chuyển từng endpoint:

```
1. Viết handler trong Hono app          → chưa có traffic (route cũ vẫn thắng)
2. Test handler Hono trực tiếp
3. XOÁ file route cũ của Next           → traffic tự rơi xuống catch-all
4. Xác minh, sang endpoint tiếp theo
```

> ⚠️ Độ ưu tiên này là **giả định chịu tải** của cả kế hoạch migration. Xác minh bằng một smoke test ngay ở bước đầu, trước khi dựa vào nó cho 6 route.

Ở mỗi thời điểm, **đúng một** implementation phục vụ một endpoint. Không bao giờ có hai backend cùng ghi — đây là điều xoá bỏ rủi ro R4 (§14).

### 5.4 Cấu trúc package đề xuất

```text
packages/
├── core/      Application Core — không phụ thuộc framework nào
├── server/    Hono app: route, validation, SSE, auth. Export `app`
├── mcp/       MCP adapter — gọi core, không gọi server
└── cli/       entrypoint: app / serve / mcp / worker / render / doctor
src/           Next.js: page, component, và ĐÚNG MỘT file api/[[...route]]/route.ts
```

Ràng buộc lint nên đặt ngay từ đầu: `packages/core` **cấm** import `hono`, `next`, `react`. `packages/server` cấm import `next`.

### 5.5 Cần chú ý khi Next còn làm host

| Vấn đề | Xử lý |
|---|---|
| `runtime = "nodejs"` | Bắt buộc. Edge runtime không chạy được HyperFrames (esbuild, native addon) |
| `serverExternalPackages` | Vẫn phải giữ trong `next.config.ts` chừng nào Next còn host — Hono app import HyperFrames |
| SSE qua Route Handler | Hono `streamSSE` trả `Response` có `ReadableStream`; Next Node runtime pass-through được. Cần verify không bị buffer — test progress event của job dài |
| Upload lớn (BGM 20MB) | Test qua đường Route Handler trước khi tin |
| Server component đọc filesystem | **Phải bỏ.** Trang studio hiện đẩy snapshot qua RSC props — thay bằng client fetch tới Hono (§15.3). Đây là phần D4 chưa đạt nếu bỏ sót |

---

## 6. Ranh giới module

### 6.1 Application Core

Sở hữu: project use case · composition/scene editing · validation & diagnostics · revision và optimistic concurrency · orchestration render/TTS/snapshot · approval, audit, state transition · port cho filesystem, database, renderer, TTS.

Không được phụ thuộc: Hono request, MCP transport, React, Tauri, `process.cwd()`.

**Ràng buộc từ P3:** preview và render phải đi qua **cùng một** hàm build document (`buildSubCompositionHtml` + hàm inject preview-settings). Core phải expose đúng một entry point cho việc này, không cho adapter tự ghép.

### 6.2 MCP adapter — hạng nhất (D1)

Vì MCP là interface chính, nó được thiết kế **trước**, và HTTP adapter là consumer thứ hai của cùng use case set.

Trách nhiệm: khai báo tool/resource/prompt contract · validate input/output · resolve workspace và project context · gọi Application Core · audit mọi tool call · trả `jobId` cho thao tác dài · **không cho AI quyền shell hoặc filesystem tuỳ ý**.

> **Hai thế hệ protocol, phải phục vụ cả hai.** Revision `2026-07-28` bỏ session, bỏ handshake `initialize`, bỏ server-initiated request và đổi hình dạng result — thực chất là MCP thế hệ 2. Hai generation SDK không nói chuyện được với nhau:
>
> | | Legacy (≤ `2025-11-25`) | Modern (`2026-07-28`) |
> |---|---|---|
> | Package | `@modelcontextprotocol/sdk@1.30.0` | `@modelcontextprotocol/{server,core}@2.0.0` |
> | Trạng thái | có session | stateless |
>
> Implementation Phase 2 dùng `@modelcontextprotocol/server@2.0.0` làm **runtime dependency duy nhất** cho MCP và `@modelcontextprotocol/sdk@1.30.0` chỉ làm legacy test client. Một Tool Registry protocol-agnostic phục vụ cả hai era trên HTTP lẫn stdio; raw-wire goldens khóa era-specific result/cache fields. Luật đầy đủ: [steering/13-mcp-protocol-compatibility](../steering/13-mcp-protocol-compatibility.md).

### 6.3 Hono HTTP adapter — **toàn bộ** backend HTTP (D4)

Route và versioned API · schema validation · local auth/session · map domain error thành HTTP status + machine-readable code · streaming progress (SSE/WS) · phục vụ frontend asset **đã nhúng trong binary** · directory-picker API (§9) · không chạy render/TTS dài trong request.

Không được import `next` ở bất kỳ đâu trong `packages/server`. Adapter phải chạy được độc lập dưới `@hono/node-server` — đó là bài kiểm tra xem D4 đã đạt chưa (§5.2).

### 6.4 Worker adapter

Render, TTS, snapshot, transcribe: persistent job state · progress event · timeout, cancellation, restart recovery · giới hạn concurrency · verify output trước khi publish.

---

## 7. Process model

Một binary, nhiều mode:

```text
vidcom                        # = vidcom app
vidcom app                    # khởi động daemon + mở browser tới UI
vidcom serve --workspace <p>  # daemon headless
vidcom mcp --workspace <p>    # MCP stdio, để AI host spawn làm subprocess
vidcom approve <requestId>    # duyệt destructive request từ trusted local CLI
vidcom credential ...         # issue/list/rotate/revoke bearer cho HTTP
vidcom backup ...             # list/verify/restore backup
vidcom recovery ...           # inspect/reconcile/resolve journal recovery
vidcom worker                 # chưa thuộc Giai đoạn 4; chỉ thêm ở phase sau nếu có nhu cầu cô lập đã đo
vidcom render <project>       # render headless cho CI/batch
vidcom doctor                 # kiểm tra Chromium, FFmpeg, TTS model, quyền, workspace
vidcom version
```

Với MCP stdio: **`stdout` chỉ chứa MCP protocol message**. Mọi log đi qua `stderr` hoặc structured log store — một dòng `console.log` lạc vào stdout sẽ làm hỏng handshake.

**Runtime Phase 2 hiện tại:** source-checkout launcher là executable Node wrapper đăng ký `tsx` loader rồi chạy source CLI để dùng `node:sqlite`; clean-artifact smoke pack CLI và resolve đúng tên lệnh `vidcom`, nhưng đây chưa phải artifact phát hành tự chứa. `vidcom mcp` resolve workspace, migrate app-data SQLite, lấy workspace lease, reconcile recovery, khởi động watcher/scheduler và serve stdio trong cùng subprocess. Packaged Node SEA và IPC bridge tới app daemon vẫn thuộc Phase 4; lease hiện bảo đảm không có hai VidCom writers sở hữu cùng workspace.

---

## 8. Single writer và local IPC

UI và MCP hoạt động đồng thời. Hai process cùng sửa composition hoặc cùng mở database không phối hợp là hỏng dữ liệu.

1. **Hono daemon là single writer** cho workspace đang mở.
2. `vidcom mcp` là bridge kết nối tới daemon qua local IPC **có xác thực**.
3. Daemon chưa chạy → MCP khởi động headless daemon; không chọn nhánh từ chối vì AI host không có UI đáng tin để chuyển hướng dẫn tới người dùng.
4. Mỗi workspace có lock/lease ngăn hai daemon cùng sở hữu.
5. Mọi file write: content hash + atomic temp-write & rename + revision/audit record.
6. File watcher tiếp nhận thay đổi từ CLI/editor bên ngoài, invalidate cache, phát event cho UI.

> **Làm rõ:** single-writer áp dụng cho **các đường ghi của VidCom**. Người dùng vẫn được sửa project bằng công cụ ngoài (đó là điểm của D3) — những thay đổi đó được **phát hiện**, không bị **ngăn cản**. Điều bị cấm là hai đường ghi *của VidCom* chạy song song.

---

## 9. Chọn thư mục workspace — không cần native dialog

D3 nói "người dùng bật web lên và chọn thư mục". Ràng buộc: web UI trong browser **không lấy được absolute path** (`<input type="file" webkitdirectory>` chỉ cho tên tương đối; File System Access API giữ handle ở phía browser, không chia sẻ được với Hono/MCP, và hỗ trợ không đồng đều).

### 9.1 Hướng chính — server-driven directory picker

Chìa khoá: **backend chạy trên chính máy người dùng**. Nên không cần browser đọc filesystem — backend đọc hộ.

```
GET  /api/system/home                    → home dir, các vị trí gợi ý (Documents, Desktop)
GET  /api/system/browse?path=<abs>       → { entries: [{name, isDir}], parent, canWrite }
POST /api/workspace/open  { path }       → validate, lấy lease, scan project, set active
POST /api/workspace/create { path, name} → tạo thư mục mới rồi open
```

UI render một trình duyệt thư mục bằng chính dữ liệu đó. Ưu điểm: **đúng một executable, không cần native shell, không cần signing cho Tauri**, hoạt động trên mọi browser.

⚠️ **Đây là một filesystem browser expose qua HTTP.** Bắt buộc:
- chỉ bind loopback;
- **bắt buộc token** cho `/api/system/*` (không có token → 401, kể cả từ localhost);
- kiểm tra `Host` header (chống DNS rebinding);
- chỉ trả tên entry và cờ `isDir`/`canWrite` — **không** trả nội dung file;
- không cho browse khi chưa có session hợp lệ.

**Cấp token:** khi `vidcom app` mở browser, nó mở URL kèm one-time token (`http://127.0.0.1:<port>/?t=<nonce>`); UI đổi nonce lấy session cookie `HttpOnly` rồi xoá nonce khỏi URL. Nonce dùng một lần, hết hạn ngắn.

### 9.2 Hướng nâng cấp — native shell (sau)

Tauri v2 làm shell mỏng: native folder dialog, quản lý lifecycle sidecar, đóng gói/ký/update theo nền tảng.

> Lưu ý: Tauri v2 dùng **system webview** (WKWebView / WebView2 / webkitgtk), **không** bundle Chromium. Nó không thay thế được Chromium cho snapshot/render — hai thứ độc lập.

Đây là nâng cấp UX, không phải điều kiện cần. Hướng 8.1 đã thoả D2 + D3.

---

## 10. Workspace public vs application-data hidden

Đây là hiện thực trực tiếp của D3.

### 10.1 Thư mục người dùng chọn — PUBLIC

Chỉ chứa artifact người dùng sở hữu, xem được, copy được, commit được:

```text
<workspace-root>/
├── project-a/
│   ├── vidcom.json            ID + metadata không bí mật, để nhận diện lại khi thư mục bị di chuyển
│   ├── hyperframes.json       config HyperFrames (registry, paths)
│   ├── meta.json              id, name, createdAt
│   ├── registry-item.json     title, description, dimensions
│   ├── index.html             root composition
│   ├── compositions/          sub-composition = scene
│   ├── assets/                ảnh, SVG, video, font
│   ├── narration/             <sceneId>.json + <sceneId>.wav
│   ├── snapshots/             frame-NN-at-Ts.png, contact-sheet.jpg
│   ├── preview-assets/bgm/    nhạc nền người dùng upload
│   ├── preview-settings.json  tone, palette, BGM, subtitle, per-scene
│   └── renders/               output MP4
└── project-b/
```

> **`preview-settings.json` BẮT BUỘC nằm trong project, không được chuyển sang app-data.** Nó là **input của render** (P2/P3): preview và render đọc cùng file này. Đưa nó ra ngoài thì project copy sang máy khác sẽ render ra hình khác.
>
> Cùng lý do với `snapshots/` và `preview-assets/bgm/` — chúng là nội dung của project, không phải state vận hành.

### 10.2 Application-data của hệ điều hành — HIDDEN

```text
<vidcom-application-data>/
├── settings.json     workspace active, preference
├── jobs.sqlite       job queue + trạng thái
├── audit.sqlite      audit log tool call & file mutation
├── credentials       token IPC, quyền 0600
├── logs/
├── cache/            registry cache, parse cache, proxy media
└── runtime/          Chromium, FFmpeg, TTS model, sidecar đã giải nén
```

Không lưu secret trong project. Log phải redact prompt/source nhạy cảm trước khi ghi.

### 10.3 Workspace resolution

Thứ tự ưu tiên:

1. `--workspace <absolute-path>` hoặc cấu hình MCP tường minh;
2. workspace active do app lưu trong `settings.json`;
3. working directory của MCP **nếu** thư mục đó có project marker hợp lệ;
4. yêu cầu người dùng chọn — **không tự động ghi vào một thư mục đoán được**.

Mọi path phải canonicalize và kiểm tra vẫn nằm trong workspace/project **sau khi** resolve symlink.

### 10.4 Project ID và trùng lặp

`vidcom.json` mang project ID. Người dùng copy thư mục project → hai folder cùng ID. Quy tắc:
- ID trùng → project mở sau được cấp ID mới, ghi lại `vidcom.json`, và log sự kiện.
- Không dùng path làm ID (thư mục di chuyển được — đó là mục đích của `vidcom.json`).

---

## 11. Thiết kế MCP an toàn (D1)

MCP **không** "điều khiển backend tuỳ ý". AI chỉ gọi được những use case backend cho phép, với input đã validate.

### 11.1 Tool theo phạm vi nghiệp vụ

| Nhóm | Tool | Mức |
|---|---|---|
| Đọc | `list_projects`, `get_project_context`, `read_composition`, `list_scenes`, `get_diagnostics`, `list_registry_blocks` | read |
| Sửa scene | `create_scene`, `duplicate_scene`, `set_scene_timing`, `set_text`, `reorder_scenes` | write |
| Sửa file | `save_file` (bắt buộc `expectedContentHash`), `upload_asset` | write |
| Block | `add_block` | write |
| Kiểm tra | `validate_project` | read |
| Job dài | `start_tts`, `start_snapshot`, `start_render`, `get_job_status`, `cancel_job` | job |
| Phá huỷ | `delete_scene`, `delete_file`, `delete_project` | **destructive** |

### 11.2 Chính sách theo mức

- **read** — chạy tự do.
- **write** — audit đầy đủ, trả entity + revision mới, có thể undo qua revision history.
- **job** — trả `jobId` ngay, không block; có tool theo dõi và huỷ.
- **destructive** — cần **approval grant** do daemon phát hành sau hành động của con người (bấm trong UI hoặc `vidcom approve`). Grant bind với tool + `projectId` + đối tượng + `expectedRevision`, dùng một lần, có hạn. Agent **không** tự tạo được — một cờ `confirm` do agent tự đặt không chứng minh gì. Core tạo backup trước khi xoá.

### 11.3 Không expose

`run_shell` · `write_any_file` · `execute_sql` · `call_arbitrary_endpoint` · raw path ngoài workspace · credential hoặc internal runtime config · `/api/system/browse` (directory picker chỉ dành cho UI, không dành cho AI).

### 11.4 Quy ước output

Mọi tool ghi trả **entity + revision mới**, không phải `{ ok: true }`. Tác vụ dài trả `jobId` kèm resource để theo dõi progress. Lỗi trả machine-readable code, không chỉ chuỗi tiếng Anh.

---

## 12. MCP không tự làm AI Composer chạy thật

MCP cung cấp capability **cho một AI host bên ngoài**. Tab AI Composer trong VidCom là chuyện khác — nó cần một AI *bên trong* sản phẩm. Hai hướng:

**Hướng A — Agent CLI + MCP.** Backend spawn Codex/Claude CLI trong process được kiểm soát; agent kết nối tới VidCom MCP; output và tool event stream về UI. Cần timeout, kill, concurrency limit, sandbox, audit. Ưu điểm: dùng lại toàn bộ skill/workflow của HyperFrames (`/hyperframes`, `/motion-graphics`…) mà `projects/*/AGENTS.md` đang trông vào.

**Hướng B — Model API + tool-use.** Backend gọi model API trực tiếp, đăng ký tool từ cùng Application Core. Dễ kiểm soát quyền hơn, nhưng phải tự xây session, prompt, skill và billing/token tracking.

Việc export MCP server (D1) **không** tự động biến tab AI Composer hiện tại thành agent thật.

---

## 13. Local security baseline

- Chỉ bind `127.0.0.1`/loopback — không bao giờ mặc định `0.0.0.0`.
- Port động; phát hiện và xử lý port conflict.
- Session/token ngắn hạn giữa UI, MCP bridge và daemon. Token IPC lưu tại `<app-data>/credentials` quyền `0600` (Windows: ACL tương đương).
- Kiểm tra `Host` header — chống DNS rebinding.
- Giới hạn CORS/origin.
- Chống path traversal **và** symlink escape (canonicalize sau khi resolve).
- **Allowlist khi serve asset** — không chỉ chống traversal. Hiện `/api/hf/<slug>/files/[...path]` trả **mọi** file trong project, kể cả `AGENTS.md`, `package.json`, `.env` nếu có. Backend mới chỉ serve loại file thuộc danh sách cho phép.
- Schema validation cho cả HTTP và MCP.
- Magic-byte validation + size limit cho upload.
- Không truyền user input qua shell string — dùng argument array.
- Audit mọi tool call và file mutation.
- Code signing / notarization cho release artifact.
- Backup trước thao tác phá huỷ; có restore.

---

## 14. Rủi ro đã xác định

| # | Rủi ro | Bằng chứng | Ảnh hưởng | Xử lý đề xuất |
|---|---|---|---|---|
| R1 | **ĐÃ GIẢI QUYẾT bằng Node SEA** — Bun trực tiếp và Bun loader đều FAIL; Node SEA PASS | SEA nhúng archive 34 package, cold/warm đều chạy ONNX + Sharp; checksum và code signature hợp lệ ([bằng chứng](../../spikes/phase-0/README.md)) | Không còn chặn kỹ thuật; còn phase approval | Pin Node toolchain, build archive riêng mỗi OS × kiến trúc, smoke-test cold + warm |
| R2 | **ĐÃ XÁC MINH PASS trong phạm vi parse/lint/list** — CLI chạy dưới Bun | `lint` quét 6 file, `compositions` đọc 7 composition, cả hai exit 0 ([bằng chứng](../../spikes/phase-0/README.md)) | Không chặn đường CLI đã thử | Chưa cần Node sidecar cho parse/lint/list; render/TTS vẫn phải test cùng packaging mới |
| R3 | **Repo hiện có 0 test** | không có file `*.test.*`/`*.spec.*`, không có test runner | Refactor sang Core không có lưới an toàn | §16 |
| ~~R4~~ | ~~Migration song song vi phạm single-writer~~ | — | — | **ĐÃ GIẢI QUYẾT bởi D4.** Chỉ có một implementation backend (Hono); Next chỉ forward. Cắt chuyển bằng cách xoá route cũ của Next, không bao giờ có hai backend cùng ghi. §5.3 |
| R4b | **ĐÃ XÁC MINH PASS** — route cụ thể thắng optional catch-all trên Next 16.2.12 | Exact route và catch-all trả marker khác nhau trong spike ([bằng chứng](../../spikes/phase-0/README.md)) | Kế hoạch cutover đứng vững | Giữ smoke fixture; chạy lại khi nâng major Next |
| R4c | **SSE và upload lớn đi qua Next Route Handler** chưa được xác minh | Hono `streamSSE` trả `ReadableStream`; BGM upload tới 20MB | Progress job có thể bị buffer; upload có thể bị chặn | Test sớm; nếu hỏng, đó là lý do đẩy nhanh sang `vidcom serve` |
| R5 | **Registry fetch qua HTTP khi mở project** — timeout 4s mỗi block lạ | `readBlock` ([11-parsing-logic.md](11-parsing-logic.md) §3) | Local-first mà mở project phải chờ mạng | Cache registry persist trong `<app-data>/cache`, có TTL, không cache negative vô hạn; offline mode tường minh |
| R6 | **Version skew HyperFrames** | mỗi project có `package.json` gọi `npx hyperframes@0.7.86`; app bundle mang version riêng | Project render khác nhau giữa CLI và app | Đọc version project yêu cầu → cảnh báo hoặc pin |
| R7 | **`ignoreScripts: ["sharp","unrs-resolver"]`** trong `package.json` gốc | postinstall bị bỏ qua | Packaged build thiếu native binary | Xử lý tường minh trong build pipeline |
| R8 | **Chromium tải runtime, không bundle** | `@puppeteer/browsers` + `puppeteer-core@25.4.0` | Máy offline không render được | Quyết định bundle hay first-run download (§17 câu 4); `vidcom doctor` kiểm tra |
| R9 | **Chưa có đường import project có sẵn** | 3 project mẫu đang ở `projects/` trong repo | Người dùng cũ mất dữ liệu khi chuyển sang workspace | Bước import ở lần chạy đầu |

---

## 15. Tác động đến checkout hiện tại

### 15.1 Project root
`PROJECTS_ROOT = join(process.cwd(), "projects")` ([projects.server.ts:34](../../src/lib/hyperframes/projects.server.ts#L34)). Backend mới phải thay dependency ngầm vào `cwd` bằng một `WorkspaceRoot` được resolve tường minh và inject vào storage adapter. Đây là thay đổi đầu tiên và rẻ nhất.

### 15.2 Cache đã có sẵn — giữ lại
Checkout hiện đã có `memoPerProject()` ([projects.server.ts:130](../../src/lib/hyperframes/projects.server.ts#L130)): memo một giá trị cho mỗi project, invalidate bằng `projectFingerprint()` = danh sách `path:mtimeMs:size` của mọi file trong project. Nó bọc các read parse HTML (`readProject`, `buildPreviewHtml`, `readProjectTree`). Promise bị reject sẽ tự xoá khỏi cache.

Application Core nên **giữ mô hình này**, nhưng nâng cấp: fingerprint hiện `stat` toàn bộ cây mỗi lần gọi. Với file watcher (§8.6) có thể đổi sang invalidate theo event thay vì stat-mỗi-lần.

### 15.3 Next.js — những gì phải rời đi để đạt D4

Checkout hiện có 3 nhóm phụ thuộc vào Next ở phía server. D4 yêu cầu **cả ba** phải chuyển sang Hono:

| # | Đang là gì | Sau D4 |
|---|---|---|
| 1 | 6 Route Handler dưới `/api/hf/` ([10-api-contract.md](10-api-contract.md)) | Chuyển thành Hono route; xoá dần theo §5.3 |
| 2 | **Server component đọc filesystem** — `page.tsx` gọi `readProject` / `readScenes` / `readRootTrack` / `readProjectTree` / `readPreviewSettings` rồi đẩy xuống client dưới dạng **RSC props** ([page.tsx:37-47](../../src/app/projects/[slug]/page.tsx#L37)) | Client fetch một endpoint gộp |
| 3 | `serverExternalPackages` cho HyperFrames | Giữ chừng nào Next còn host Hono app; bỏ khi chuyển sang `vidcom serve` |

Nhóm 2 là phần **dễ bị bỏ sót nhất** — nó không nằm dưới `/api/` nên catch-all không chạm tới. Endpoint thay thế:

```
GET /api/projects/:id/studio-snapshot
  → { project, tree, entryFile, scenes, rootTrack, previewSettings }
```

Trang `/` (Home) cũng đang gọi `listProjects()` trong server component → cần `GET /api/projects`.

Chừng nào còn RSC đọc filesystem, D4 **chưa đạt** và Next chưa bỏ được. Đây cũng là tiền đề cho static export ở Mức 2.

Ngoài ra `@hyperframes/player` là custom element client-side — phần đó không đổi.

### 15.4 MCP hiện tại
Transcript MCP trong AI Composer đang là mock ([09-feature-ai-composer.md](09-feature-ai-composer.md) F-9.4): trong 4 tool call hiển thị, chỉ `add_scene` là ghi thật; `list_compositions`, `tts`, `lint` đều giả. Backend mới cần MCP server/transport và tool contract riêng. **Không dùng transcript UI làm bằng chứng rằng MCP operation đã chạy.**

---

## 16. Testing — điều kiện cần cho việc tách Core

Repo hiện **không có test nào** (R3). Toàn bộ giá trị của việc tách Application Core là để test được nghiệp vụ mà không cần dựng HTTP/UI. Tối thiểu cần:

| Loại | Đối tượng | Vì sao |
|---|---|---|
| Unit | Parsing logic ([11-parsing-logic.md](11-parsing-logic.md)) | Phần dễ regress nhất, nhiều edge case (`<template>`, root host, normalizeTarget, unresolved tween) |
| **Golden-file** | `composition.serialize()` | SDK viết lại cả document; một lần nâng version package có thể làm hỏng mọi project. So sánh output với file mẫu đã duyệt |
| Golden-file | `buildPreviewCss()` + `injectPreviewSettings()` | P2/P3 — preview phải khớp render |
| Contract | MCP tool input/output schema | AI phụ thuộc contract; đổi ngầm là breaking change |
| Integration | Job lifecycle: start → progress → cancel → restart recovery | Không test được bằng tay |
| Smoke (packaged) | Chạy trên artifact đã build, máy sạch | Mức 4, §18 |

---

## 17. Quyết định đã đóng và câu hỏi còn lại

Đã chốt qua D1/D2/D3: interface chính (MCP), hình thức phát hành (một executable), cách chọn workspace (web + server-driven picker). Danh sách dưới đây giữ cả quyết định đã đóng lẫn câu hỏi dành cho phase sau:

1. **Đã đóng ở OQ-1:** daemon do bridge tự khởi động là headless và tự dừng khi bridge cuối cùng ngắt, trừ khi UI còn attach; không cài background service độc lập.
2. **Đã đóng ở OQ-2:** MCP bridge dùng loopback HTTP + bearer + handshake `workspaceRoot`/instance id. Unix socket/named pipe là phương án dự phòng đã đo trên POSIX, chưa kiểm Windows.
3. Workspace active là global (một tại một thời điểm) hay cho phép nhiều workspace đồng thời?
4. **Đã đóng ở OQ-3/OQ-12:** FFmpeg/FFprobe, esbuild và CPython đóng băng được bundle; Chrome Headless Shell và weights VieNeu tải ở lần chạy đầu rồi cache. Mốc là máy chưa cài gì nhưng cần mạng ở lần chạy đầu.
5. Database vận hành: một DB global hay một DB cho mỗi workspace?
6. AI Composer đi hướng A (agent CLI + MCP) hay hướng B (model API + tool-use)?
7. Tính năng nào bắt buộc offline, tính năng nào được phép gọi cloud?
8. Có nên chạy `hyperframes studio` (đã là Hono) làm sidecar cho phần preview/serve thay vì viết lại?
9. Có license/activation không? Nếu có thì phần verify nằm ở đâu — vì §2 đã chỉ ra nó **không** được nằm trong bundle.

---

## 18. Các mức đóng gói

> **Thứ tự task nằm ở [15-build-order](15-build-order.md).** Mục này mô tả **các mức đóng gói** — trạng thái artifact ở từng nấc — không phải backlog.

### Bước 0 — Spike, làm trước mọi thứ
Kết quả ngày 2026-08-01: Bun direct compile FAIL; spike thay thế chọn **Node SEA PASS** và loại Bun native-loader rewrite; R2 PASS trong phạm vi parse/lint/list; dual-stack MCP PASS; R4b PASS. Gate kỹ thuật đã giải quyết. Phase 1 chỉ bắt đầu sau khi thay đổi runtime/design và checklist được xác nhận. Xem [bằng chứng Phase 0](../../spikes/phase-0/README.md).

### Mức 1 — Hono thành backend, Next thành vỏ (D4)

Thứ tự có chủ đích — mỗi bước để lại app chạy được:

1. **Dựng khung.** `packages/core` + `packages/server` (§5.4) + lint rule cấm import chéo.
2. **Cắm catch-all** `src/app/api/[[...route]]/route.ts` với một route `GET /api/health`. Xác minh **R4b**: thêm một route test trùng đường dẫn với route cụ thể đang có, xác nhận route cụ thể vẫn thắng. Nếu sai, đổi kế hoạch ngay tại đây.
3. **`WorkspaceRoot`** — thay `cwd/projects` bằng giá trị inject được vào storage adapter. Chuyển `memoPerProject` sang Core (§15.2).
4. **Cắt chuyển 6 route** theo §5.3, ưu tiên đường **đọc** trước (`/preview`, `/files`, `/source` GET) rồi mới đường **ghi** (`/source` PUT, `/scene`, `/preview-settings`). Mỗi route: viết Hono → test → xoá file Next.
5. **Xác minh R4c** ngay khi cắt route ghi: SSE progress và upload BGM 20MB qua Route Handler.
6. **Bỏ RSC đọc filesystem** (§15.3 nhóm 2) — `GET /api/projects` và `GET /api/projects/:id/studio-snapshot`. Hoàn tất D4.
7. **MCP adapter** gọi cùng use case, chạy từ build artifact TypeScript.
8. **Test song song từ bước 1**, không để sau (§16). Golden-file cho `serialize()` phải có trước khi cắt route ghi.

Kết thúc Mức 1: `src/` không còn code server nào ngoài đúng một file forward.

### Mức 2 — Headless executable
- Bỏ Next: `@hono/node-server` phục vụ `app.fetch`; frontend build static, nhúng vào binary.
- Bundle Hono + MCP + frontend asset vào Node SEA.
- Directory-picker API + token flow (§9.1).
- Kiểm thử: cold start, restart recovery, workspace lock, MCP handshake, stdout sạch.

> Vì `app` không đổi giữa Mức 1 và Mức 2, bước này là **đổi host**, không phải viết lại.

### Mức 3 — Application bundle
- Installer một file; giải nén sidecar/runtime asset vào app-data ở lần chạy đầu.
- `vidcom doctor` kiểm tra và bổ sung runtime thiếu.
- Checksum + ad-hoc signature ở baseline; signing certificate/notarization thật, update strategy và crash reporting thuộc full release.
- Import project có sẵn (R9).

### Mức 4 — Full release
- Build matrix macOS / Windows / Linux × arm64 / x64.
- Smoke test chạy **trên artifact**, máy sạch, không phải source checkout.
- Kiểm tra render / TTS / FFmpeg / Chromium thật.
- Xác minh AI host spawn được `vidcom mcp`, gọi tool, restart và khôi phục state.
- Ghi checksum và provenance cho release artifact.

### Mức 5 — Tuỳ chọn
Tauri shell + native folder dialog (§9.2) như nâng cấp UX.

---

## 19. Tài liệu tham khảo

Kiểm tra lần cuối: 2026-08-01.

- Hono: <https://hono.dev/docs>
- **Hono trên Next.js / adapter `hono/vercel`** (cơ chế §5.1): <https://hono.dev/docs/getting-started/vercel>
- Hono `@hono/node-server` (fallback host): <https://hono.dev/docs/getting-started/nodejs>
- Hono trên Bun: <https://hono.dev/docs/getting-started/bun>
- Hono streaming / SSE helper: <https://hono.dev/docs/helpers/streaming>
- Next.js route precedence (giả định R4b): <https://nextjs.org/docs/app/api-reference/file-conventions/dynamic-routes>
- Bun standalone executable: <https://bun.sh/docs/bundler/executables>
- Bun embedded files: <https://bun.sh/docs/bundler/executables#embedding-files>
- Node.js single executable applications: <https://nodejs.org/api/single-executable-applications.html>
- MCP spec `2026-07-28` (modern) + changelog: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- MCP spec `2025-11-25` (legacy mới nhất): <https://modelcontextprotocol.io/specification/2025-11-25>
- MCP TypeScript SDK, server guide: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md>
- Node.js Single Executable Applications (fallback cho R1): <https://nodejs.org/api/single-executable-applications.html>
- Tauri v2 sidecar: <https://v2.tauri.app/develop/sidecar/>
- Tauri v2 plugins/dialog: <https://v2.tauri.app/plugin/>
- Next.js static export: <https://nextjs.org/docs/app/guides/static-exports>
