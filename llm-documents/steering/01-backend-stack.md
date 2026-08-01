# 01 — Backend stack

## 1. Stack cố định

| Lớp | Lựa chọn | Ghi chú |
|---|---|---|
| Ngôn ngữ | TypeScript, `strict: true` | Không JavaScript thuần trong `packages/` |
| HTTP framework | **Hono** | Trùng với studio server chính thức của HyperFrames |
| Runtime đích | **Node SEA (Node 24 LTS toolchain đã kiểm thử)** | Bun `--compile` trực tiếp và native-loader rewrite đều thất bại; Node SEA cold/warm probe ONNX + Sharp đã PASS ngày 2026-08-01 |
| MCP modern (`2026-07-28`) | `@modelcontextprotocol/server@2.x` + `core@2.x` | Package **server**, không phải `client` |
| MCP legacy (≤ `2025-11-25`) | `@modelcontextprotocol/sdk@1.x` | Bắt buộc — phải phục vụ cả hai thế hệ |
| HTML parse (server) | `linkedom` | Đúng **một** bản trong dependency tree |
| Composition engine | `@hyperframes/{core,sdk,studio-server,parsers,lint}` | Node-only |
| Validation | Một thư viện schema duy nhất cho cả HTTP và MCP | Xem [06-validation](06-validation.md) |
| DB vận hành | SQLite | File trong app-data, không phải trong workspace |

MUST NOT thêm HTTP framework thứ hai. MUST NOT thêm ORM nặng — truy vấn SQLite viết tay hoặc query builder mỏng.

**Hai SDK MCP là ngoại lệ có chủ đích** cho rule "không hai thư viện cùng việc": hai thế hệ protocol không nói chuyện được với nhau và không có package nào phục vụ cả hai. Xem [13-mcp-protocol-compatibility](13-mcp-protocol-compatibility.md).

MUST pin version của cả hai SDK. Nâng là thay đổi có chủ đích, kèm chạy lại contract test.

## 2. Ràng buộc runtime

### 2.1 Node-only dependency

`@hyperframes/*` phụ thuộc native binary và Node API. Hệ quả:

- MUST đặt `export const runtime = "nodejs"` ở Route Handler forward chừng nào Next còn host.
- MUST giữ `serverExternalPackages` trong `next.config.ts` chừng nào Next còn host.
- MUST NOT dùng Edge runtime ở bất kỳ đâu.

### 2.2 `DOMParser` shim

`@hyperframes/parsers` gọi `DOMParser` của DOM. Node không có. MUST cài shim **một lần duy nhất**, ở điểm khởi động của Core, trước mọi lời gọi parse:

```ts
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
}
```

MUST NOT lặp lại shim này ở nhiều module — hai bản `linkedom` nghĩa là hai `DOMParser` implementation.

### 2.3 Native dependency đã biết

Những thứ sau **không nhúng được** vào JS bundle và ảnh hưởng trực tiếp tới D2:

| Dependency | Loại |
|---|---|
| `esbuild` | binary theo platform |
| `onnxruntime-node` | `.node` addon (TTS) |
| `sharp` + libvips | `.node` addon |
| `puppeteer-core` + Chromium | browser runtime, tải lúc chạy |
| FFmpeg / FFprobe | binary ngoài |

Kết quả spike Phase 0: executable Bun trực tiếp không load được `onnxruntime-node` và `sharp`; Bun native-loader rewrite vẫn không resolve dependency filesystem động. Node SEA nhúng archive native có manifest/checksum đã chạy được ONNX + Sharp ở cold extraction và warm cache. D2 MUST dùng Node SEA và build artifact riêng theo OS × kiến trúc; không được quay lại Bun loader nếu chưa có spike mới phủ đúng probe. Xem [kết quả spike](../../spikes/phase-0/README.md).

MUST truy cập chúng qua **port** trong Core, không gọi trực tiếp từ use case (xem [03-architecture-ddd](03-architecture-ddd.md) §3). Lý do: khi đóng gói phải thay chỗ tìm binary mà không sửa nghiệp vụ.

## 3. Chính sách dependency

Trước khi thêm bất kỳ dependency nào, trả lời được cả 4:

1. **Nó có chạy trong binary đã compile không?** Native addon và thứ đọc `__dirname`/`require.resolve` lúc runtime là rủi ro trực tiếp cho D2.
2. **Nó có kéo theo bản thứ hai của thứ đã có không?** Đặc biệt `linkedom`, `esbuild`, `sharp`.
3. **Có thể viết bằng ~30 dòng không?** Nếu có, viết.
4. **Nó có cần network lúc runtime không?** Local-first — mọi network call phải là lựa chọn tường minh, có timeout, và fail mềm.

MUST pin exact version cho mọi thứ ảnh hưởng output render (`@hyperframes/*`, `esbuild`, Chromium). Render phải deterministic; caret range làm hỏng điều đó.

## 4. Version của HyperFrames

Mỗi project có `package.json` gọi `npx hyperframes@<version>`. App bundle mang version riêng.

- MUST đọc version mà project khai báo khi mở project.
- MUST cảnh báo khi lệch version với runtime đang bundle.
- MUST NOT tự nâng version trong file của người dùng.

## 5. Những gì bị cấm

| Cấm | Vì sao |
|---|---|
| Import `next` trong `packages/**` | D4 — backend phải chạy độc lập dưới Hono host của Node SEA |
| Import `react` trong `packages/core` hoặc `packages/server` | Core không biết UI |
| Gọi `process.cwd()` để tìm project | Workspace do người dùng chọn, phải inject (xem [07-data-and-storage](07-data-and-storage.md)) |
| `child_process` với chuỗi shell | Dùng argument array. Xem [09-security](09-security.md) |
| Ghi bí mật vào bundle | API key, license key — xem doc 14 §2 |
| `console.log` trong đường MCP stdio | `stdout` chỉ chứa MCP protocol message |

## 6. Logging

- MUST dùng structured logger, không `console.*` trực tiếp trong `packages/`.
- MCP mode: mọi log ra `stderr` hoặc log store. MUST NOT ghi ra `stdout`.
- MUST redact prompt và nội dung file người dùng trước khi ghi log.
- Log level qua env var, mặc định `info`.
