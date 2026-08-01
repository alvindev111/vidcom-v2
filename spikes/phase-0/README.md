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
