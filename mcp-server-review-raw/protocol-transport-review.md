# Raw review — MCP protocol và transport

- Reviewer scope: dual-era MCP `2024-10-07`…`2025-11-25` + `2026-07-28`; HTTP + stdio; exact revision pin; negotiation; header/body/batch/error ladder; MRTR; result/cache stamping; deterministic `tools/list`; stdout và close.
- Baseline commit: `b0830f12a2c2a2fbe3e8c8800cdf7cbd8d1db2e3`
- Review mode: read-only đối với production/spec; file này là raw artifact duy nhất được thêm theo yêu cầu điều phối review.
- Sources đối chiếu: Phase M/P của `spec-mcp-server-implementation-checklist.md`, steering `13-mcp-protocol-compatibility.md`, package đã cài `@modelcontextprotocol/server@2.0.0`, client test `@modelcontextprotocol/sdk@1.30.0` và `@modelcontextprotocol/client@2.0.0`.

## Findings

### [HIGH] PT-01 — Pinned HTTP và `/latest` làm mất `authInfo`, nên audit mọi tool call qua các URL này mất `credentialId`

**Evidence**

- `packages/server/src/routes/mcp.ts:25-30` chuyển credential đã verify thành `options.authInfo.clientId` khi gọi mọi handler.
- `packages/mcp/src/http.ts:49` nhận `options`, nhưng nhánh exact-match tại `packages/mcp/src/http.ts:67-69` gọi `inner(request)` thay vì `inner(request, options)`.
- `packages/mcp/src/server.ts:44-45` chỉ có thể lấy `credentialId` từ `requestContext.http.authInfo` hoặc `factoryContext.authInfo`; khi wrapper bỏ options, cả hai đều trống.
- SDK đã cài nói rõ `authInfo` là pass-through, không tự suy ra từ Authorization header: `node_modules/.bun/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts:3810-3818`. Runtime thật chuyển nó vào factory/handler tại `.../dist/index.mjs:1258-1262`, `1298-1304`, `1326-1345`.

**Concrete edge/repro**

Request đã qua Hono bearer auth vẫn được thực thi thành công, nhưng entry route audit đúng `credential_probe`, còn exact legacy pin, exact modern pin và `latest` đều ghi `null`.

```bash
rtk bun --eval '
import { createMcpHttpHandlers } from "./packages/mcp/src/http.ts";
import { createTransportRegistry } from "./tests/mcp/support.ts";
const request = () => new Request("http://vidcom.test/api/mcp", {
  method: "POST",
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "echo_project", arguments: { projectId: "project-auth" }
  } })
});
for (const key of ["", "2025-03-26"]) {
  const audits = [];
  const http = createMcpHttpHandlers(createTransportRegistry(audits));
  const response = await http.handlers.get(key)(request(), {
    authInfo: { token: "redacted", clientId: "credential_probe", scopes: [] }
  });
  console.error(JSON.stringify({ key: key || "entry", status: response.status,
    credentialId: audits[0]?.credentialId ?? null }));
  await http.close();
}
'
```

Observed:

```text
{"key":"entry","status":200,"credentialId":"credential_probe"}
{"key":"2025-03-26","status":200,"credentialId":null}
```

Raw modern envelope probe cho cả `2026-07-28` và `latest` cũng trả HTTP 200 nhưng audit `credentialId:null`.

**Impact**

- Authentication vẫn chặn request trước handler, nên đây không phải auth bypass.
- Tuy nhiên toàn bộ tool call qua `/api/mcp/<supported-revision>` và `/api/mcp/latest`, kể cả destructive/write, không còn principal trong audit. Điều này vi phạm Requirement 6d.6 và Requirement 7.2, phá khả năng truy nguyên credential đã thực hiện mutation.

**Suggested fix**

- Đổi nhánh exact-match thành `inner(request, options)`.
- Thêm integration test dùng **real** `createMcpHttpHandlers` + Registry audit, parameterize `""`, một legacy exact pin, `2026-07-28`, `latest`; assert `credentialId` ở cả legacy và modern tool call.
- Test structural fake handler hiện có không đủ vì nó chỉ chứng minh Hono truyền options tới wrapper, không chứng minh wrapper truyền tiếp vào SDK.

### [MEDIUM] PT-02 — Exact-pin wrapper trả `-32022` trước validation `Content-Type`, làm lệch SDK-owned HTTP error ladder

**Evidence**

- `packages/mcp/src/http.ts:51-62` clone + JSON-parse + classify body mà không kiểm media type.
- Khi revision mismatch, `packages/mcp/src/http.ts:67-69` tự trả `UnsupportedProtocolVersion` ngay.
- SDK runtime đã cài kiểm POST `Content-Type` **trước** đọc/classify body tại `node_modules/.bun/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist/index.mjs:1326-1338`; non-JSON media type phải trả HTTP 415, code `-32000`, `id:null`.
- Detailed Design §5.13 và M.5 yêu cầu exact wrapper không thay SDK validation ladder.

**Concrete edge/repro**

```bash
rtk bun --eval '
import { createMcpHttpHandlers } from "./packages/mcp/src/http.ts";
import { createTransportRegistry } from "./tests/mcp/support.ts";
const make = () => new Request("http://vidcom.test/api/mcp", {
  method: "POST",
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "text/plain",
    "MCP-Protocol-Version": "2025-11-25"
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })
});
const http = createMcpHttpHandlers(createTransportRegistry());
for (const key of ["", "2025-06-18"]) {
  const response = await http.handlers.get(key)(make());
  console.error(JSON.stringify({ key: key || "entry", status: response.status,
    body: await response.text() }));
}
await http.close();
'
```

Observed:

```text
entry: HTTP 415, JSON-RPC -32000, id null
2025-06-18 pin: HTTP 400, JSON-RPC -32022, id 7
```

**Impact**

- Cùng một malformed HTTP request đi qua entry và pinned route nhận hai ladder khác nhau.
- Version mismatch che mất lỗi transport cơ bản, trả một request id mà SDK cố ý không echo cho lỗi media type, và làm exact endpoint không còn là thin pinning wrapper quanh SDK.

**Suggested fix**

- Trước khi clone/classify, nếu POST không có JSON media type hợp lệ, delegate nguyên request + options cho SDK; có thể dùng export `isJsonContentType` của `server@2`.
- Khóa matrix `Content-Type` thiếu/sai × exact/mismatch × legacy/modern; assert pinned route giữ nguyên status/code/id của entry cho các rung xảy ra trước pin comparison.

### [MEDIUM, TEST SHIELD] PT-03 — Phase M/P tests không chạy real SDK boundary cho auth ở pinned routes và thiếu validation-ladder matrix

Đây là coverage gap trực tiếp cho PT-01/PT-02, không phải defect độc lập trong runtime.

**Evidence**

- `tests/server/mcp-security.test.ts:124-139` dùng một fake structural handler nên chỉ chứng minh `createMcpRoutes()` truyền credential vào wrapper.
- Test real Registry audit tại `tests/server/mcp-security.test.ts:187-218` chỉ gọi `/api/mcp`, không gọi exact pin hay `latest`.
- `tests/mcp/revision-pin.test.ts:98-110` khóa invalid JSON delegation, nhưng không có wrong/missing `Content-Type`.
- `tests/mcp/revision-pin.test.ts:53-60` chỉ kiểm đủ map key. HTTP executable cases chỉ exercise một old exact revision (`2025-06-18`), default `2025-03-26`, modern và latest; không parameterize toàn bộ revision.
- `tests/mcp/contract-matrix.test.ts` gọi handler pin trực tiếp mà không truyền `authInfo`, nên matrix 2 era × 2 transport không thể bắt credential loss.

**Suggested fix**

- Thêm real Hono + Registry audit case cho entry/exact/latest, cả legacy/modern.
- Thêm table-driven HTTP ladder case: content type, invalid JSON, classifier reject, exact mismatch, notification mismatch, batch.
- Thêm exact revision loop cho cả 5 legacy HTTP pins bằng raw exact headers/body; official legacy v1 client luôn mở với latest nên raw wire case là cần thiết để test old exact URL.
- Thêm successful stdio pin loop cho cả 5 legacy revisions; hiện official v1 client thực tế negotiate thành công cả 5 nhưng repo không khóa regression này.

## Checked areas không thấy defect

1. **Dependency pin**: `packages/mcp/package.json` pin runtime `@modelcontextprotocol/server: 2.0.0`; root devDependencies pin `sdk: 1.30.0`, `client: 2.0.0`. Legacy SDK không nằm trong runtime package.
2. **Revision constants**: `SUPPORTED_REVISIONS` là modern `2026-07-28` + đúng 5 revision legacy mà installed server export. `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` runtime là `2025-03-26`, `LATEST_PROTOCOL_VERSION` legacy là `2025-11-25`.
3. **Exact HTTP old revisions**: raw `tools/list` với header exact đã trả 200 cho cả `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`.
4. **Exact stdio old revisions**: official `sdk@1.30.0` client negotiate/list thành công trên cả 5 `--protocol` legacy pins. Modern pin từ chối legacy opening bằng `-32022` và advertised set của endpoint pin là `['2026-07-28']`, phù hợp exact entry posture.
5. **Era projection**: modern golden có `resultType`; `tools/list` có `ttlMs:0`, `cacheScope:'private'`; legacy golden không có modern fields.
6. **Deterministic list**: `ToolRegistry.list()` sort theo name tại `packages/mcp/src/registry/registry.ts:63-75`; golden gọi lặp ba lần cho mỗi era.
7. **MRTR**: modern stdio/HTTP tests chạy `input_required` → elicitation → retry qua `requestState`; e2e destructive stdio chạy approval CLI thật và audit destructive thật.
8. **Legacy transport semantics**: no-header default, GET/DELETE 405, resource error split và legacy batch happy path đều có runtime evidence.
9. **stdout/close**: real AI-host CLI smoke kiểm legacy + modern child exit, stdout protocol-only, stderr bình thường sạch và lease release; HTTP closers đóng entry + từng pinned handler một lần, `latest` chỉ alias nên không tạo duplicate closer.
10. **Unknown revision**: HTTP wrapper trả `-32022` với global shared allowlist; notification mismatch trả 202/no body.

## Commands đã chạy

```bash
rtk bunx vitest run \
  tests/mcp/revision-pin.test.ts \
  tests/mcp/legacy-transport.test.ts \
  tests/mcp/modern-transport.test.ts \
  tests/mcp/contract-matrix.test.ts \
  tests/mcp/negative-contract-matrix.test.ts \
  tests/mcp/golden/tools-list.test.ts \
  tests/server/mcp-security.test.ts \
  tests/server/mcp-listener.test.ts \
  tests/e2e/mcp-stdio-host.test.ts
```

Kết quả: **9 files passed, 37 tests passed, 0 failed**, Vitest 4.1.10, duration 7.05s.

Ngoài ra đã chạy các read-only Bun probes được ghi trong PT-01/PT-02, raw exact HTTP loop cho 5 legacy revisions, successful stdio loop cho 5 legacy revisions, và inspect trực tiếp installed SDK source/types.
