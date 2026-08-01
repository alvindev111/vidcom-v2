# 13 — MCP protocol compatibility (legacy ↔ 2026-07-28)

`2026-07-28` không phải một bản vá. Nó bỏ session, bỏ handshake `initialize`, bỏ server-initiated request, đổi hình dạng result. Trên thực tế đây là **MCP thế hệ 2**.

VidCom export MCP cho AI host bên ngoài (**D1**). Ta không kiểm soát được host nào kết nối tới. Nên **MUST hỗ trợ cả hai thế hệ**.

Kiểm chứng lần cuối: 2026-08-01.

---

## 1. Hai thế hệ

| | Legacy | Modern |
|---|---|---|
| Revision | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` | `2026-07-28` |
| Package npm | `@modelcontextprotocol/sdk@1.30.0` | `@modelcontextprotocol/{core,client,server}@2.0.0` |
| Hằng số | `LATEST_PROTOCOL_VERSION = "2025-11-25"`<br>`DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"` | `FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28"`<br>`SUPPORTED_MODERN_PROTOCOL_VERSIONS = [nó]` |
| Trạng thái | có state (session) | **stateless** |

**Hai generation SDK không nói chuyện được với nhau.** `@modelcontextprotocol/client@2.0.0` chỉ hỗ trợ modern; `sdk@1.30.0` chỉ hỗ trợ legacy. Không có một package nào phục vụ cả hai — đó là việc của chúng ta.

> Ghi chú dependency: repo hiện có `@modelcontextprotocol/client@2.0.0` trong `dependencies` (package **client**, không dùng để làm server). `sdk@1.30.0` chỉ có mặt do `shadcn` và `@google/genai` kéo vào. Để làm server MUST thêm `@modelcontextprotocol/server@2.0.0` (modern) và `@modelcontextprotocol/sdk` (legacy) một cách tường minh.

---

## 2. Khác biệt cốt lõi

Nguồn: [changelog chính thức 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

### 2.1 Bỏ hẳn

| Bỏ | Thay bằng |
|---|---|
| Session + header `Mcp-Session-Id` | Server-minted handle truyền như tham số tool bình thường |
| `initialize` / `notifications/initialized` | Mỗi request tự mang protocol version + client capabilities trong `_meta` |
| HTTP GET endpoint, `resources/subscribe` / `unsubscribe` | `subscriptions/listen` — một POST-response stream dài |
| `ping`, `logging/setLevel`, `notifications/roots/list_changed` | log level per-request qua `_meta.io.modelcontextprotocol/logLevel` |
| SSE resumability, `Last-Event-ID`, SSE event id | Stream đứt = mất request; client **MUST** phát lại với request ID mới |
| Server-initiated request (`roots/list`, `sampling/createMessage`, `elicitation/create`) | **MRTR** — xem §2.3 |

### 2.2 Thêm bắt buộc

| Thêm | Ràng buộc |
|---|---|
| `server/discover` | Server **MUST** implement. Quảng bá version hỗ trợ, capabilities, identity |
| `resultType` trên mọi result | `"complete"` hoặc `"input_required"`. Result từ server đời cũ thiếu field → client **MUST** coi là `"complete"` |
| `CacheableResult`: `ttlMs` + `cacheScope` | **Bắt buộc** trên `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list`. `cacheScope` là `"public"` \| `"private"` |
| Header `Mcp-Method`, `Mcp-Name` | Bắt buộc trên Streamable HTTP POST |
| `x-mcp-header` | Custom header lấy từ tham số tool |
| `extensions` trên `ClientCapabilities` / `ServerCapabilities` | Cho extension ngoài core |

### 2.3 MRTR — Multi Round-Trip Requests

Thay thế toàn bộ cơ chế server hỏi ngược client. Server trả `InputRequiredResult` (`resultType: "input_required"`) với field `inputRequests`; client **retry chính request đó** kèm `inputResponses`.

Đây là thay đổi quan trọng nhất với thiết kế của chúng ta — xem §3.2.

### 2.4 Tasks thành extension

Task rời core, thành `io.modelcontextprotocol/tasks`. Thiết kế lại: bỏ `tasks/result` (blocking), dùng `tasks/get` (polling) + `tasks/update` (client gửi input vào), bỏ `tasks/list`, và server được trả task handle **không cần** per-request opt-in.

### 2.5 Error code

Chính sách phân vùng mới: `-32000`–`-32019` implementation-defined (grandfathered), **`-32020`–`-32099` dành riêng cho spec**.

| Lỗi | Legacy | Modern |
|---|---|---|
| Resource not found | `-32002` | **`-32602`** (Invalid Params) |
| `HeaderMismatch` | — | `-32020` |
| `MissingRequiredClientCapability` | — | `-32021` |
| `UnsupportedProtocolVersion` | — | `-32022` |

### 2.6 Deprecated (còn chạy, đừng dùng mới)

Roots · Sampling · Logging · transport HTTP+SSE · `includeContext: "thisServer"|"allServers"` · OAuth Dynamic Client Registration (ưu tiên Client ID Metadata Documents).

Cửa sổ deprecation tối thiểu 12 tháng theo feature lifecycle policy.

---

## 3. Ảnh hưởng tới thiết kế của VidCom

### 3.1 Stateless hợp với ta

Daemon local vốn không cần session MCP — workspace và project resolve theo `projectId`, không theo connection. MUST NOT thiết kế bất kỳ tool nào phụ thuộc state của connection, kể cả khi phục vụ legacy host.

### 3.2 Xác nhận thao tác destructive → dùng MRTR

[05-mcp-tool-design](05-mcp-tool-design.md) §3 yêu cầu tool destructive phải xác nhận. Cách hiện thực khác nhau theo thế hệ:

| Thế hệ | Cách |
|---|---|
| Modern | Trả `InputRequiredResult` với `inputRequests` hỏi xác nhận. Client retry kèm `inputResponses`. **Đây là cách idiomatic** |
| Legacy | Tham số `confirm: true` + `expectedRevision` trên chính tool call |

MUST hỗ trợ cả hai. Quyết định "có được xoá không" nằm ở **Core**, không ở adapter — adapter chỉ dịch sang cơ chế của thế hệ tương ứng.

### 3.3 Job ↔ tasks extension

[08-jobs-and-queue](08-jobs-and-queue.md) định nghĩa job riêng của ta (`start_render` → `jobId` → `get_job_status`). Modern có sẵn extension `io.modelcontextprotocol/tasks` làm đúng việc đó.

Rule:
- MUST giữ job model của Core độc lập với protocol. `jobId` là khái niệm của ta.
- MCP adapter modern **SHOULD** map job sang tasks extension khi host khai báo hỗ trợ nó, fallback về tool `get_job_status` khi không.
- MCP adapter legacy chỉ có tool `get_job_status`.
- MUST NOT để hình dạng của tasks extension rò ngược vào Core.

### 3.4 `resultType` và `CacheableResult`

- Modern: mọi result MUST có `resultType`. `tools/list` và các list result MUST có `ttlMs` + `cacheScope`.
- `cacheScope` cho VidCom: **`"private"`**. Danh sách tool và resource gắn với workspace của một người dùng; intermediary không được cache dùng chung.
- `ttlMs` cho `tools/list`: đặt ngắn — tool set của ta tĩnh, nhưng project list thì không.
- Legacy: không có các field này. MUST NOT gửi chúng cho legacy client.

### 3.5 Thứ tự `tools/list` phải deterministic

Spec khuyến nghị để client cache được và tăng prompt cache hit. MUST sort tool theo thứ tự cố định (alphabet hoặc thứ tự khai báo), MUST NOT phụ thuộc thứ tự duyệt `Map`/`Object.keys`.

### 3.6 Logging deprecated

Modern bỏ `logging/setLevel` và deprecate feature Logging; khuyến nghị log ra `stderr` (stdio) hoặc OpenTelemetry. Trùng với rule đã có ở [01-backend-stack](01-backend-stack.md) §6 — giữ nguyên, không thêm gì.

### 3.7 OpenTelemetry

Modern chuẩn hoá `traceparent` / `tracestate` / `baggage` trong `_meta`. SHOULD propagate xuống Core và job để trace một tool call xuyên suốt tới lúc render xong.

---

## 4. Kiến trúc dual-stack bắt buộc

```
                        ┌──────────────────────────┐
AI host legacy ────────▶│ legacy transport adapter │──┐
(sdk 1.x)               │ @modelcontextprotocol/sdk│  │
                        └──────────────────────────┘  │
                                                      ├──▶ Tool Registry ──▶ Application Core
                        ┌──────────────────────────┐  │    (protocol-agnostic)
AI host modern ────────▶│ modern transport adapter │──┘
(2026-07-28)            │ @modelcontextprotocol/   │
                        │ server@2.0.0             │
                        └──────────────────────────┘
```

### Luật

1. **Tool Registry là nguồn sự thật duy nhất.** Định nghĩa tool (tên, mức quyền, input/output schema, handler) khai báo **một lần**, protocol-agnostic. Hai transport adapter chỉ dịch.
2. MUST NOT viết một tool hai lần cho hai thế hệ.
3. MUST NOT để kiểu dữ liệu của bất kỳ SDK nào rò vào Core hay vào Tool Registry. Registry dùng type của `packages/contracts`.
4. Tính năng chỉ có ở modern (MRTR, tasks extension, `resultType`, `CacheableResult`) MUST được **degrade** ở adapter legacy, không được làm hỏng tool.
5. Tool nào **không** degrade được xuống legacy MUST khai báo tường minh và bị ẩn khỏi legacy `tools/list` — MUST NOT expose rồi lỗi lúc gọi.

### Cấu trúc

```text
packages/mcp/
├── registry/          định nghĩa tool, protocol-agnostic  ← nguồn sự thật
│   └── tools/         một file một tool
├── transport-legacy/  @modelcontextprotocol/sdk@1.x
├── transport-modern/  @modelcontextprotocol/server@2.x
└── negotiate.ts       chọn adapter theo version
```

---

## 5. Version negotiation

| Tình huống | Xử lý |
|---|---|
| Request mang protocol version hợp lệ | Route tới adapter đúng thế hệ |
| Version không hỗ trợ | Trả `UnsupportedProtocolVersion` (`-32022` ở modern), kèm **danh sách version ta hỗ trợ** |
| Không có version (legacy HTTP) | Mặc định `2025-03-26` — đúng `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` của SDK 1.x |
| STDIO, chưa biết đời | Modern client dùng `server/discover` để dò. MUST implement `server/discover` **và** vẫn chấp nhận `initialize` của legacy |

MUST khai báo tập version hỗ trợ ở **một chỗ** trong `contracts`, không hardcode rải rác.

MUST log version đã negotiate vào audit của mỗi tool call — khi debug hành vi lạ, biết host đời nào là bước đầu tiên.

---

## 6. Rules

| # | Rule |
|---|---|
| M1 | MUST hỗ trợ cả legacy và modern chừng nào chưa có dữ liệu cho thấy không host nào dùng legacy |
| M2 | MUST định nghĩa tool **một lần** trong Tool Registry; adapter chỉ dịch |
| M3 | MUST NOT để type của SDK rò vào Core hoặc Registry |
| M4 | MUST NOT thiết kế tool phụ thuộc session/connection state |
| M5 | MUST implement `server/discover` cho modern |
| M6 | MUST trả `resultType` + `CacheableResult` ở modern, MUST NOT gửi chúng cho legacy |
| M7 | MUST sort `tools/list` deterministic |
| M8 | MUST dùng `cacheScope: "private"` |
| M9 | MUST NOT dùng feature đã deprecated (Roots, Sampling, Logging, HTTP+SSE) cho code mới |
| M10 | MUST map error code theo thế hệ — resource-not-found là `-32002` ở legacy, `-32602` ở modern |
| M11 | MUST NOT tự cấp phát error code trong dải `-32020`–`-32099` (dành cho spec) |
| M12 | MUST ẩn tool không degrade được khỏi legacy `tools/list` |
| M13 | MUST ghi protocol version vào audit mỗi tool call |
| M14 | MUST pin version của cả hai SDK; nâng version là thay đổi có chủ đích, kèm chạy lại contract test |

---

## 7. Testing

Bổ sung cho [10-testing](10-testing.md) §5:

- Contract test MUST chạy **hai lần**, một lần cho mỗi thế hệ.
- MUST có test: tool destructive từ chối khi thiếu xác nhận — ở legacy là thiếu `confirm`, ở modern là chưa qua vòng MRTR.
- MUST có test: version không hỗ trợ → `UnsupportedProtocolVersion` kèm danh sách version.
- MUST có test: thiếu version header → mặc định `2025-03-26`.
- MUST có test: modern result có `resultType` và `ttlMs`/`cacheScope`; legacy result **không** có.
- MUST có test: `tools/list` trả đúng thứ tự, ổn định qua nhiều lần gọi.
- Golden file cho `tools/list` của **cả hai** thế hệ — đây là contract mà AI host phụ thuộc.

---

## 8. Sunset legacy

Chưa bỏ được. Điều kiện để cân nhắc bỏ:

1. Các AI host chính (Claude Code, Codex) đã dùng modern ở bản ổn định.
2. Telemetry cho thấy không còn kết nối legacy trong N tháng.
3. Thông báo trước ít nhất một release.

Trước khi đó, MUST NOT xoá adapter legacy dù nó phiền.

---

## 9. Kết quả spike và câu hỏi còn lại

Phase 0 chạy ngày 2026-08-01 trên Bun 1.3.14. Bằng chứng tái hiện nằm ở [spikes/phase-0](../../spikes/phase-0/README.md).

| # | Trạng thái | Kết quả / câu hỏi còn lại |
|---|---|---|
| S1 | **ĐÃ XÁC MINH** | Modern HTTP dùng `createMcpHandler(factory)` để phân loại envelope và phục vụ `server/discover`. Client v2 mặc định giữ posture legacy; phải opt-in `versionNegotiation: auto` hoặc pin `2026-07-28`. Hand-constructed `McpServer` qua `InMemoryTransport` không tự trở thành modern serving entry |
| S2 | **PASS qua adapter tách biệt** | `@modelcontextprotocol/server@2.0.0` và `sdk@1.30.0` cùng PID, cùng bundle, cùng trả `tools/list` và `tools/call`; không thấy xung đột runtime/global/peer dependency. Legacy dùng low-level `Server`, không chia sẻ trực tiếp schema type Zod v4 với modern server |
| S3 | **PASS cho dual-stack** | Bun `--compile` nuốt được cả hai SDK và executable gọi được cả hai tool. Nhánh D2 dùng Bun vẫn FAIL vì native addon; fallback Node SEA đã PASS và không làm thay đổi boundary dual-stack |
| S4 | **CHƯA XÁC MINH — gate Phase 2.6/2.8** | Extension `io.modelcontextprotocol/tasks` — SDK v2 hỗ trợ tới đâu, hay phải tự implement? |
| S5 | **CHƯA XÁC MINH — gate Phase 2.6** | MRTR trên transport stdio hoạt động thế nào khi client retry — có ràng buộc gì về request ID? |
| S6 | **CHƯA XÁC MINH — gate trước ưu tiên host** | Claude Code và Codex hiện đang nói protocol revision nào? |

MUST giải quyết S4–S6 trước khi khoá phần thiết kế tương ứng ở Phase 2. Không được suy diễn kết quả của Phase 0 cho ba câu hỏi này.

---

## 10. Tham khảo

- Changelog `2026-07-28`: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- Spec `2026-07-28`: <https://modelcontextprotocol.io/specification/2026-07-28>
- MRTR pattern: <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>
- Error code policy: <https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes>
- Deprecated registry: <https://modelcontextprotocol.io/specification/2026-07-28/deprecated>
- Feature lifecycle: <https://modelcontextprotocol.io/community/feature-lifecycle>
- Spec `2025-11-25` (legacy mới nhất): <https://modelcontextprotocol.io/specification/2025-11-25>
