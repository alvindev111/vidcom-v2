# Giai đoạn 0 — Kết quả spike

Ngày chạy: 2026-08-01. Checkout: `1553de6` trên macOS arm64.

| Thành phần                        |                                               Version |
| --------------------------------- | ----------------------------------------------------: |
| Bun                               |                                                1.3.14 |
| Node.js                           | 25.6.1 (baseline); 24.9.0 (SEA toolchain đã kiểm thử) |
| HyperFrames CLI / core            |                                                0.7.86 |
| MCP modern server / client / core |                                                 2.0.0 |
| MCP legacy SDK                    |                                                1.30.0 |
| Next.js                           |                                               16.2.12 |
| onnxruntime-node                  |                                                1.21.1 |
| sharp                             |                                                0.35.3 |
| esbuild                           |                                               0.25.12 |
| puppeteer-core                    |                                                25.4.0 |

## Kết luận gate

| #   | Kết quả                                        | Bằng chứng                                                                                                                                         | Quyết định                                                            |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0.1 | **FAIL trực tiếp; PASS qua fallback Node SEA** | Bun compile trực tiếp không load được ONNX/Sharp. Node SEA nhúng archive native có checksum, cold extraction và warm cache đều chạy được hai probe | Chọn Node SEA làm runtime đóng gói D2; loại Bun native-loader rewrite |
| 0.2 | **PASS trong phạm vi parse/lint/list**         | `lint` quét 6 file, 0 error, exit 0; `compositions` đọc 7 composition, exit 0                                                                      | Chưa cần Node sidecar cho các lệnh CLI đã thử                         |
| 0.3 | **PASS**                                       | Modern `2026-07-28` và legacy `2025-11-25` cùng PID, cùng trả `tools/list` và `tools/call`; binary Bun compile cũng chạy exit 0                    | Dual-stack khả thi                                                    |
| 0.4 | **PASS**                                       | Exact route trả `{"route":"exact"}`; hai URL còn lại vào optional catch-all                                                                        | Kế hoạch cắt chuyển D4 theo từng route đứng vững                      |

Gate kỹ thuật của Phase 0 đã được giải quyết bằng fallback Node SEA. **Phase 1 chưa tự động bắt đầu**: thay đổi runtime là quyết định thiết kế cần được xác nhận trước khi thực thi checklist. Không có production code nào được viết trong spike này.

## 0.1 — Bun compile và native dependency

Chạy từ thư mục này:

```bash
bun install
bun run bun-compile.ts
mkdir -p .artifacts
bun build --compile ./bun-compile.ts --outfile .artifacts/phase-0-bun-compile
./.artifacts/phase-0-bun-compile
```

Kết quả khi chạy source dưới Bun: cả năm probe đều hoạt động.

Kết quả từ executable đã compile:

| Probe               | Kết quả executable                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@hyperframes/core` | PASS — đọc runtime nhúng 340.767 byte. Published package không ship `runtime/entry.ts`, nên build source trả `null` đúng contract |
| `esbuild`           | PASS — transform TypeScript thành `const answer = 42;`                                                                            |
| `puppeteer-core`    | PASS — tạo 33 Chromium argument. **Không** chứng minh Chromium đã được bundle hoặc launch được                                    |
| `onnxruntime-node`  | **FAIL** — Bun giải nén `.node` vào temp nhưng không đặt `libonnxruntime.1.21.1.dylib` cạnh nó; `@rpath` không resolve được       |
| `sharp`             | **FAIL** — executable không load được runtime `darwin-arm64` dù source checkout load và xử lý PNG được                            |

Thử nhúng archive gồm native package rồi giải nén trước khi `createRequire` cũng không đủ. Archive 82 MB giải nén đủ 358 entry, nhưng compiled executable không resolve được dependency bare `onnxruntime-common` từ package đã giải nén. Vì vậy fallback cần một loader/package rewrite riêng theo platform; không thể chỉ copy `node_modules` ra app-data.

**Quyết định ban đầu:** không dùng Bun `--compile` trực tiếp làm implementation D2. Spike thay thế so sánh:

1. Node SEA với native addon/runtime được nhúng rồi giải nén có manifest và checksum.
2. Bun executable với loader native được rewrite tường minh theo platform.

Kết quả so sánh nằm ngay dưới đây.

## 0.1b — So sánh packaging thay thế

Chạy từ thư mục `spikes/phase-0`:

```bash
bun install --frozen-lockfile
bun run packaging:build

cache_dir="$(mktemp -d)"
VIDCOM_SPIKE_CACHE="$cache_dir" ./.artifacts/packaging-alternatives/phase-0-node-sea
VIDCOM_SPIKE_CACHE="$cache_dir" ./.artifacts/packaging-alternatives/phase-0-node-sea

bun_cache_dir="$(mktemp -d)"
VIDCOM_SPIKE_CACHE="$bun_cache_dir" ./.artifacts/packaging-alternatives/phase-0-bun-native-loader
```

Cả hai artifact nhúng cùng archive `darwin-arm64` gồm 34 package runtime, kích thước 18.814.624 byte, SHA-256 `a317286c107a81d5a060b6d230c8b0812edbea078bc963155f399b0bce98b237`. Archive và manifest SHA-256 được nhúng trong executable; lần chạy đầu giải nén vào cache theo checksum, lần sau dùng marker `.ready`. Hai lần prepare liên tiếp tạo đúng cùng checksum.

| Phương án                          | Kích thước artifact | Cold cache                                                               | Warm cache                          | Kết quả  |
| ---------------------------------- | ------------------: | ------------------------------------------------------------------------ | ----------------------------------- | -------- |
| Node SEA 24.9.0                    |            129,2 MB | ONNX 1.21.1 + Sharp PNG PASS; `cacheHit: false`                          | ONNX + Sharp PASS; `cacheHit: true` | **PASS** |
| Bun 1.3.14 + native-loader rewrite |             78,7 MB | Giải nén PASS nhưng compiled resolver không resolve `onnxruntime-common` | Lỗi tương tự                        | **FAIL** |

Node SEA được chạy từ working directory tạm, với cache trống, không dựa vào `node_modules` của checkout. Binary Mach-O arm64 chỉ link framework/thư viện hệ thống macOS và đã qua `codesign --verify`.

Bun loader đã thử đủ ba mức:

1. Bare `createRequire` từ runtime đã giải nén.
2. Đặt `NODE_PATH` và gọi `Module._initPaths()`.
3. Gọi entry ONNX bằng đường dẫn tuyệt đối và materialize dependency link ngay trong package.

Cả ba vẫn thất bại ở resolver của compiled Bun. Đây không còn là lỗi thiếu file archive: `onnxruntime-common` hiện diện ở top-level và qua nested symlink, nhưng compiled resolver không đi theo dependency filesystem động.

**Quyết định D2:** dùng **Node SEA** với JavaScript entry đã bundle và native runtime archive theo OS × kiến trúc. Không tiếp tục viết loader riêng trên private resolver API của Bun. Build phải pin Node toolchain, sinh checksum/manifest, ký executable và smoke-test cold + warm trên từng artifact.

## 0.2 — HyperFrames CLI dưới Bun

```bash
bun ../../node_modules/hyperframes/bin/hyperframes.mjs lint ../../projects/warm-grain --json
bun ../../node_modules/hyperframes/bin/hyperframes.mjs compositions ../../projects/warm-grain
```

`lint` trả `ok: true`, 0 error, 18 warning, quét 6 file. `compositions` đọc 7 composition. Cả hai exit 0.

Phạm vi này chứng minh CLI khởi động, parse và chạy lint dưới Bun. Nó chưa chứng minh `render`, TTS, Chromium hay FFmpeg chạy được dưới Bun; các đường đó phụ thuộc kết quả packaging mới.

## 0.3 — MCP dual-stack cùng process

```bash
bun run mcp-dual-stack.ts
bun build --compile ./mcp-dual-stack.ts --outfile .artifacts/phase-0-mcp-dual-stack
./.artifacts/phase-0-mcp-dual-stack
```

Modern dùng `createMcpHandler` + Streamable HTTP in-process và pin negotiation `2026-07-28`. Legacy dùng low-level `Server` + `InMemoryTransport` của SDK 1.30.0. Hai client cùng gọi tool echo trong một PID; source và executable đã compile đều exit 0.

Phát hiện API quan trọng:

- Client v2 mặc định giữ posture `legacy`; muốn modern phải đặt `versionNegotiation` là `auto` hoặc pin `2026-07-28`.
- `McpServer` hand-constructed qua `InMemoryTransport` không tự biến thành modern serving entry. `createMcpHandler` là đường HTTP đúng để phân loại envelope, phục vụ `server/discover` và stamp `resultType`/cache hint.
- Hai generation không xung đột runtime/global/peer dependency trong cùng process hoặc Bun bundle. Adapter legacy dùng low-level `Server`; không chia sẻ trực tiếp schema type Zod v4 của modern server với SDK 1.x.

## 0.4 — Độ ưu tiên route Next

```bash
cd next-route-precedence
bun run dev --hostname 127.0.0.1 --port 43117
curl --fail http://127.0.0.1:43117/api/probe/exact
curl --fail http://127.0.0.1:43117/api/probe/other
curl --fail http://127.0.0.1:43117/api
```

Kết quả trên Next 16.2.12:

```text
/api/probe/exact -> {"route":"exact"}
/api/probe/other -> {"route":"optional-catch-all"}
/api             -> {"route":"optional-catch-all"}
```

## Q10 — `server@2` có tự phục vụ legacy không? (spike bổ sung, 2026-08-01)

Câu hỏi phát sinh khi soạn spec Phase 2. Spike 0.3 chứng minh hai generation SDK sống chung được, nhưng nó phục vụ legacy bằng low-level `Server` của `sdk@1.30.0`. Chưa ai kiểm chứng liệu **một mình `@modelcontextprotocol/server@2.0.0`** có phủ được cả hai era hay không — nếu có thì một nửa dual-stack biến mất.

Ca quan trọng nhất là **stdio + legacy**, vì Claude Code `2.1.207` chỉ nói legacy (`LATEST = 2025-11-25`, **0** lần xuất hiện `2026-07-28` trong binary) và spawn MCP server qua stdio.

```bash
bun run mcp-legacy-via-server-v2.ts        # HTTP, một handler, hai client
bun run mcp-legacy-stdio-via-server-v2.ts  # stdio, hai child process
```

Trong cả hai probe, **phía server chỉ import `@modelcontextprotocol/server`**. `sdk@1.x` chỉ xuất hiện ở phía *client*, đóng vai host legacy.

### Cơ chế tìm thấy trong type definition

| API | Option | Mặc định |
|---|---|---|
| `createMcpHandler` | `legacy?: 'stateless' \| 'reject'` | **`'stateless'`** — mỗi request legacy được phục vụ bằng một instance mới từ cùng factory |
| `serveStdio` | `legacy?: 'serve' \| 'reject'` | **`'serve'`** — kết nối được pin era ở lần trao đổi mở đầu, cùng factory phục vụ cả hai era |

Spike 0.3 đặt `legacy: "reject"`, nên nó chưa bao giờ chạm vào đường phục vụ legacy của `server@2`.

### Kết quả

| Probe | Client | Era negotiate | `tools/list` | `tools/call` |
|---|---|---|---|---|
| HTTP | `sdk@1.x` | `2025-11-25` | `["echo"]` | `legacy-ok` |
| HTTP | `client@2.x` pin `2026-07-28` | `2026-07-28` | `["echo"]` | `modern-ok` |
| stdio | `sdk@1.x` | `2025-11-25` | `["echo"]` | `legacy-stdio-ok` |
| stdio | `client@2.x` pin `2026-07-28` | `2026-07-28` | `["echo"]` | `modern-stdio-ok` |

Factory được gọi với `era` là `"legacy"` rồi `"modern"` — cùng một factory, hai era.

### Stamp field theo era là tự động

Đọc raw JSON-RPC response ở probe HTTP:

| Field | Result gửi cho legacy | Result gửi cho modern |
|---|---|---|
| `resultType` | không có | có |
| `ttlMs` | không có | có |
| `cacheScope` | không có | có (`"private"`) |

`server/discover` trả sẵn `cacheScope: "private"`, `resultType: "complete"`, `supportedVersions: ["2026-07-28"]`.

### Giới hạn đã ghi nhận

- **`GET` trả `405`** ở chế độ `legacy: 'stateless'`. Đây là các thao tác session đời 2025 (SSE stream, DELETE session). Server tool-only của VidCom không dùng chúng, nhưng phải ghi vào tài liệu.
- `responseMode: "json"` in cảnh báo: *"drops mid-call notifications... other notifications emitted before a result are dropped"*. Nếu Phase 2 cần progress notification thì **không** dùng `responseMode: "json"`.
- `server/discover` chỉ liệt kê `supportedVersions: ["2026-07-28"]`. Đó là method modern-only nên hợp lý, nhưng nghĩa là danh sách revision legacy phải được công bố ở chỗ khác nếu ta muốn quảng bá nó.

### Kết luận

**Q10 = CÓ, cho cả HTTP lẫn stdio.** `@modelcontextprotocol/server@2.0.0` một mình phủ cả hai generation.

Hệ quả:

1. **Không cần `sdk@1.x` phía server.** Nó tụt xuống thành **devDependency** — dùng làm client legacy trong contract test.
2. Kiến trúc "hai transport adapter" ở steering 13 §4 **không còn đúng**: đúng hơn là **một handler, một factory, SDK tự quyết era**. Phần cần ta viết là Tool Registry và ánh xạ lỗi, không phải hai stack song song.
3. Endpoint định địa chỉ theo revision (`/api/mcp/<revision>`) vẫn giữ giá trị — nhưng để **pin và debug**, không phải để chọn implementation.
