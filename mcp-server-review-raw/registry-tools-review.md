# Raw review — MCP contracts, Tool Registry và 10 tools

## Phạm vi và cách kiểm tra

- Review read-only phần implementation của Phase A và Phase L: `packages/contracts/src/mcp.ts`, `packages/mcp/src/registry/**`, đường handler tương ứng trong Core, và seam đăng ký tool vào MCP SDK.
- Đối chiếu với:
  - `llm-documents/steering/05-mcp-tool-design.md`
  - `llm-documents/steering/06-validation.md`
  - `llm-documents/steering/13-mcp-protocol-compatibility.md`
  - Phase A/L và Execution Contract của `spec-mcp-server-implementation-checklist.md`
  - §5.1–5.4, §5.12 và §7.1–7.10 của Detailed Design v6.
- Dùng CodeGraph trước khi đọc source trực tiếp. Không sửa production/test source trong quá trình review.

Các lệnh kiểm chứng chính:

```text
rtk codegraph explore "MCP Server checklist Phase A Phase L packages/contracts MCP schemas packages/mcp registry tool handlers structuredContent annotations project scoping"
rtk bun run test -- tests/contracts/mcp-contracts.test.ts tests/mcp/registry.test.ts tests/mcp/tools.test.ts
# Kết quả: 3 test files pass, 27/27 tests pass.
```

Các probe read-only/in-memory bổ sung được ghi cạnh từng finding.

## Findings theo mức độ nghiêm trọng

### HIGH-1 — Modern destructive request tạo approval nhưng không có terminal tool audit

**Evidence**

- Steering bắt buộc mọi tool call được audit, không ngoại lệ: `llm-documents/steering/05-mcp-tool-design.md:7-13`.
- Registry tạo `PendingToolAudit` cho destructive trước handler: `packages/mcp/src/registry/registry.ts:113-137`.
- Khi handler phát `InputRequiredSignal`, Registry rethrow ngay: `packages/mcp/src/registry/registry.ts:139-145`.
- Toàn bộ logic terminal audit chỉ chạy sau đó: `packages/mcp/src/registry/registry.ts:154-167`.
- `requestDestructiveApproval()` đã persist một approval request trước khi phát signal: `packages/mcp/src/registry/destructive-tools.ts:29-49`.
- Transport chỉ đổi signal thành MCP `input_required`; nó không audit: `packages/mcp/src/server.ts:67-92`.

**Impact / repro logic**

Gọi `delete_scene` hoặc `delete_file` qua modern MCP mà chưa có `grantId`:

1. `approvals.request()` tạo row `requested`.
2. Handler throw `InputRequiredSignal`.
3. Registry bỏ qua `terminalEntry()` và mọi nhánh `recordFailure*()`.
4. Client nhận `input_required`, nhưng không có `audit_entry` cho tool call đã tạo approval request.

Legacy không mắc đúng nhánh này vì handler trả `approval_required` như một `Result`, nên Registry tiếp tục audit. Đây là sai khác observability giữa hai era.

**Suggested fix**

- Registry phải coi `input_required` là terminal outcome của vòng gọi hiện tại và audit nó trước khi transport mapping.
- Không ghi nó là mutation failure nếu chưa có T1; dùng caller-owned best-effort audit với mã/trạng thái machine-readable dành cho approval/input-required.
- Thêm integration test modern cho cả `delete_scene` và `delete_file`: số approval request tăng một, số tool audit tăng đúng một, không có journal/revision.

### HIGH-2 — `create_scene` ghi được duration bằng 0, âm, hoặc overflow

**Evidence**

- Steering nói rõ `duration > 0` là invariant bắt buộc trong Core, không phải schema: `llm-documents/steering/06-validation.md:3-12` và `:23-32`.
- Schema chỉ yêu cầu finite, không positive: `packages/contracts/src/mcp.ts:111-117`.
- `createScene()` lấy `duration = input.duration ?? 4`, tính timing/root duration rồi ghi trực tiếp, không gọi `validateSceneTiming`: `packages/core/src/usecase/project-writes.ts:333-360` và `:377-425`.
- `setSceneTiming()` có gọi validator đúng cách, cho thấy invariant đã có sẵn nhưng bị bỏ qua ở create: `packages/core/src/usecase/project-writes.ts:146-152`; validator ở `packages/core/src/domain/invariants.ts:11-41`.

Probe schema:

```text
rtk bun -e '...CreateSceneInputSchema.safeParse(...duration:-1...); ...duration:0...'
=> {"negativeDuration":true,"zeroDuration":true}
```

**Impact / repro**

`create_scene { duration: -1 }` hoặc `{ duration: 0 }` đi qua schema và Core, tạo source/mount/narration trong một composite revision với timing không hợp lệ. Với số finite rất lớn, `start + duration` có thể thành `Infinity`; HTML/root timing có thể bị ghi trước khi output validation trả lỗi. Đây là corruption do một public write tool gây ra.

**Suggested fix**

- Giữ schema shape-only như steering yêu cầu.
- Trong `createScene()`, gọi invariant Core tương ứng trước `applyOps()` và trước `mutateComposite()`; ít nhất reject non-finite effective sum, `duration <= 0`, và unsafe root extension.
- Thêm Core + real adapter test cho `0`, số âm, cực lớn/overflow; assert không có mutation/journal/revision/file change.

### HIGH-3 — `delete_file` bỏ sót reference tương đối của scene và toàn bộ root-track reference

**Evidence**

- Reference guard chỉ so requested path với `scene.src`, raw `scene.media.src`, HTTP `scene.media.url`, và `scene.elements.src`; không đọc `rootTrack`: `packages/core/src/usecase/file-deletion.ts:32-35`.
- Parser giữ `media.src` đúng raw attribute từ file scene, trong khi URL mới được normalize theo owner file: `packages/adapter/src/hyperframes/parse.ts:108-124`.
- Root-level elements được parse riêng vào `rootTrack`: `packages/adapter/src/hyperframes/parse.ts:221-234`, rồi được đưa vào model tại `:291-309`.
- Unit test reference safety chỉ phủ direct `scene.src === path`: `tests/core/file-deletion.test.ts:23-53` và `:116-122`.

Probe trực tiếp:

```text
# Model có scene source compositions/s.html và media.src="../assets/logo.svg".
# Requested delete path là canonical project-relative "assets/logo.svg".
rtk bun -e '...prepareFileDeletion(...path:"assets/logo.svg"...)...'
=> {"ok":true,"value":{"plan":{"path":"assets/logo.svg",...}}}
```

**Impact / repro**

Một scene ở `compositions/s.html` chứa `<img src="../assets/logo.svg">`. Agent gọi `delete_file` cho `assets/logo.svg`; prepare/approve/re-plan đều không nhận ra reference, nên mutation được phép xóa file và composition bị hỏng. Root composition có element tham chiếu file cũng bị bỏ sót hoàn toàn. Backup giúp restore thủ công nhưng không thay thế reference safety bắt buộc.

**Suggested fix**

- Parser/Core model nên expose một tập reference canonical theo project, resolve relative với file owner; không so raw `src` hoặc API URL.
- Bao gồm direct `data-composition-src`, mọi `src` có authoring significance, nested scene references và root-track elements.
- Thêm test direct/nested/root, `../assets/*`, URL external/data URI, và cùng basename ở hai thư mục.

### MEDIUM-1 — `set_scene_timing` nhận payload không có thay đổi và vẫn churn file/revision

**Evidence**

- Cả `start`, `duration`, `trackIndex` đều optional, không có object refine yêu cầu ít nhất một field: `packages/contracts/src/mcp.ts:125-133`.
- Core validate effective current timing, rồi luôn gọi `applyOps()` với `value: input.timing`, và luôn gọi authority mutation: `packages/core/src/usecase/project-writes.ts:146-165`.
- Adapter tạo một `setTiming` op ngay cả khi value rỗng và serialize lại source: `packages/adapter/src/hyperframes/sdk-ops.ts:41-47` và `:63-89`.

Probe in-memory trên fixture thật:

```text
rtk bun -e '...applyCompositionOps(...,[{kind:"setTiming",target:"inline",value:{}}])...'
=> {"ok":true,"same":false}
```

Schema probe cũng trả `emptyTiming:true`.

**Impact**

Agent gửi `{ projectId, sceneId, expectedContentHash }` sẽ tạo serialization diff, content hash mới, revision và audit dù không yêu cầu thay đổi timing. Điều này gây conflict giả cho caller khác và tạo history noise.

**Suggested fix**

- Input schema refine yêu cầu ít nhất một trong ba timing field.
- Core vẫn cần guard tương tự vì business use case có thể được HTTP/internal gọi không qua MCP schema.
- Test assert empty patch không gọi `applyOps`/authority.

### MEDIUM-2 — `set_text` báo `narrationStale=true` ngay cả khi scene không có narration

**Evidence**

- Public schema khóa cả `scene.narrationStale` qua `SceneContextSchema` và top-level `narrationStale` là literal `true`: `packages/contracts/src/mcp.ts:141-156`.
- Core chỉ thêm sidecar stale step khi `scene.narration !== null`: `packages/core/src/usecase/project-writes.ts:231-247`.
- Nhưng response luôn hard-code `scene.narrationStale: true` và top-level `true`: `packages/core/src/usecase/project-writes.ts:256-275`.
- Read model tính đúng nghĩa `scene.narration !== null && staleSince !== null`: `packages/core/src/usecase/project-reads.ts:61-80`.
- Existing success test chỉ dùng fixture `withNarration: true`: `tests/core/project-usecases.test.ts:418-445`.

**Impact / repro logic**

Với scene legacy/inline có `narration: null`, `set_text` chỉ sửa source nhưng trả `narrationStale=true`. Lần gọi `get_project_context` kế tiếp trả `false` cho cùng scene. Agent có thể quyết định sai rằng cần regenerate một narration tồn tại.

**Suggested fix**

- Sửa Detailed Design §7.7 trước vì contract approved hiện hard-code literal `true`.
- Dùng boolean hoặc trạng thái rõ hơn (`absent | current | stale`); nếu giữ boolean thì trả `false` khi narration không tồn tại.
- Test cả scene có và không có narration.

### MEDIUM-3 — Output validation sau commit có thể biến mutation thành công thành lỗi trả về, trong khi audit đã ghi `ok`

**Evidence**

- Registry gọi handler trước, sau đó mới parse public output: `packages/mcp/src/registry/registry.ts:139-151`.
- Nếu parse fail, Registry đổi result thành `internal`: `packages/mcp/src/registry/registry.ts:146-151`.
- Với write success, Registry chỉ kiểm journal ownership sau đó: `packages/mcp/src/registry/registry.ts:154-166`.
- Journal đã commit revision và chèn tool audit outcome `'ok'` trong T2: `packages/adapter/src/db/journal.ts:378-403`.

**Impact**

Nếu một handler/Core regression trả sai public shape sau khi filesystem+SQLite commit thành công, caller nhận `internal` dù write và audit đều thành công. Caller có thể retry dựa trên false-negative, gặp conflict hoặc tạo hành vi ngoài ý muốn. Audit outcome cũng không còn phản ánh wire result.

**Suggested fix**

Đây là vấn đề thiết kế, không chỉ thêm `try/catch`. Cần xác định một response-finalization contract sao cho:

- Shape public có thể được chứng minh/validate trước terminal commit, hoặc
- wire không được đổi terminal success thành error sau commit; lỗi serialization/output phải có outcome/audit riêng phản ánh "mutation committed, response failed".

Thêm integration test với deliberately malformed write output và SQLite/filesystem thật, assert state, audit và response có semantics thống nhất.

### MEDIUM-4 — `WriteEnvelope.fileHashes` không enforce key là canonical relative path

**Evidence**

- Design mô tả `fileHashes` là `Record<RelPath, ContentHash>`.
- Runtime schema lại dùng `z.record(z.string(), ContentHashSchema)`: `packages/contracts/src/mcp.ts:34-40`.
- Cùng schema được lồng trong mọi write output.

Probe:

```text
WriteEnvelopeSchema.safeParse({
  projectRevision: 1,
  entityRevision: null,
  fileHashes: { "/etc/passwd": validHash },
  diagnostics: []
}).success
=> true
```

**Impact**

Core hiện tạo path từ bounded capabilities, nên chưa thấy exploit trực tiếp. Tuy nhiên output validator không thực hiện nhiệm vụ fail-closed nếu adapter/Core regression làm rò absolute/internal path; nó cũng không khóa contract `RelPath` như checklist A.4/L.1 tuyên bố.

**Suggested fix**

- Dùng record key schema/refinement từ canonical relative-path rule, không chỉ `string`.
- Reject `/`, Windows drive/UNC, backslash, empty/dot/dot-dot segments và non-canonical aliases.
- Test key nested trong `fileHashes`, không chỉ strictness của root object.

### MEDIUM-5 — Tool descriptions chưa đạt steering bắt buộc cho agent prompt

**Evidence**

- Steering yêu cầu mô tả nói rõ khi dùng/khi không dùng, side effects, nguồn lấy precondition, và thông tin/mã lỗi bắt buộc: `llm-documents/steering/05-mcp-tool-design.md:127-146`.
- Descriptions hiện tại:
  - reads: `packages/mcp/src/registry/read-tools.ts:29-47`, `:54-70`, `:74-90`, `:99-117`;
  - writes: `packages/mcp/src/registry/write-tools.ts:29-47`, `:50-73`, `:81-99`, `:102-120`;
  - destructive: `packages/mcp/src/registry/destructive-tools.ts:83-113`, `:120-149`.
- Snapshot test khóa nguyên các description hiện tại nhưng không đánh giá rule nội dung: `tests/mcp/registry.test.ts:340-480`.

**Gaps cụ thể**

- Hầu hết tool không nói "không dùng khi nào".
- Write/destructive tools không chỉ rõ lấy `expectedContentHash`/`expectedRevision` từ `get_project_context`, `read_composition`, hoặc output write trước.
- `set_scene_timing` không nói `duration_overflow`, không nói đây không phải timing element.
- `set_text` không nói `file` phải thuộc đúng scene/element.
- `delete_file` không mô tả retry với issued `grantId` rõ như `delete_scene`.

**Impact**

Host/agent luôn thấy descriptions nhưng có thể không đọc skill. Thiếu precondition/error guidance tạo tool-call sai, retry thừa và tăng approval request không cần thiết.

**Suggested fix**

Viết lại descriptions ngắn nhưng đủ: use/don't-use, nguồn precondition, side effect, key error/recovery step. Cập nhật descriptor snapshot/golden hai era.

### MEDIUM-6 — Tool audit thiếu duration và revision-before/revision-after theo steering

**Evidence**

- Steering yêu cầu mỗi tool call ghi thời điểm, tên, level, project, input redact, result, revision trước/sau và duration: `llm-documents/steering/05-mcp-tool-design.md:148-152`.
- `ToolAuditEntry` không có timestamp/duration/revision-before/revision-after: `packages/core/src/port/types.ts:52-63`.
- Registry terminal detail chỉ chứa `{ input, invocationId }`: `packages/mcp/src/registry/registry.ts:113` và `:170-187`.
- Write row có `revision_id` sau commit, nhưng không lưu previous revision hay elapsed time; read row cũng không có latency.

**Impact**

Audit không trả lời được mutation bắt đầu từ revision nào hoặc tool mất bao lâu, làm yếu conflict/latency investigation và không đạt steering 05 §9.

**Suggested fix**

- Bổ sung timing qua injected monotonic clock và revision-before/after vào terminal audit detail/schema hoặc cột phù hợp.
- Với writes, previous revision phải được lấy trong write authority/journal transaction để tránh race; không suy hậu nghiệm ở Registry.
- Test read success/error, pre-T1 reject, committed write và recovered write.

### MEDIUM-7 — `list_projects` fail toàn bộ nếu chỉ một project parse lỗi

**Evidence**

- `listProjectContexts()` dùng `Promise.all` trên mọi project và một `try/catch` bao toàn bộ: `packages/core/src/usecase/project-reads.ts:107-130`.
- Parser đọc file do user/agent/CLI cùng sửa; steering yêu cầu read normalization không làm sập bề mặt đọc: `llm-documents/steering/06-validation.md:39-57`.

**Impact / repro logic**

Một project có entry/config lỗi làm `parseProject()` throw; `Promise.all` reject và `list_projects` trả `storage_unavailable`, nên agent không thể khám phá bất kỳ project khỏe mạnh nào còn lại.

**Suggested fix**

- Isolate lỗi theo project. Contract cần quyết định rõ skip project hỏng hay trả một item recovery/error-safe; nếu thêm field thì cập nhật Design trước.
- Thêm real workspace test gồm một project tốt và một project malformed.

### MEDIUM-8 — Missing referenced source có thể làm `get_project_context` throw thay vì trả diagnostics

**Evidence**

- Parser vẫn giữ `host.src` khi referenced file không resolve/read được, nhưng chỉ record source/hash khi file tồn tại: `packages/adapter/src/hyperframes/parse.ts:186-200`.
- `sceneContexts()` lookup hash và throw nếu thiếu: `packages/core/src/usecase/project-reads.ts:61-80`.
- `getProjectContext()` gọi `sceneContexts()` ngoài một local catch: `packages/core/src/usecase/project-reads.ts:156-170`.
- Registry catch biến exception thành generic `internal`: `packages/mcp/src/registry/registry.ts:139-145`.

**Impact**

Project đang author dở với `data-composition-src` trỏ file thiếu không nhận được context/diagnostic để agent sửa; agent chỉ thấy internal error. Đây trái mục tiêu read tolerant và recovery visibility.

**Suggested fix**

- Không throw vì missing hash. Biểu diễn source missing bằng diagnostic + nullable/explicit file state trong `SceneContext` (có thể cần Design Drift), hoặc bảo đảm parser luôn trả một bounded missing-source record.
- Test missing referenced composition, malformed source và symlink-rejected source.

### LOW-1 — Text content dùng `JSON.stringify`, chưa phải canonical JSON như Execution Contract

**Evidence**

- Execution Contract khóa: adapter phát `structuredContent: O` và một text content là canonical JSON của cùng `O`.
- Server phát đúng cả hai channel, nhưng text dùng `JSON.stringify(output)`: `packages/mcp/src/server.ts:75-80`.

**Impact**

Hai channel cùng semantic value, nhưng key order của nested record phụ thuộc insertion order; chưa có guarantee canonical byte representation. Điều này có thể làm golden/prompt cache kém ổn định khi map construction order thay đổi.

**Suggested fix**

- Dùng canonical JSON serializer dùng chung, rồi khóa text bytes trong golden cho object có nested record order khác nhau.

### LOW-2 — L.11 "đủ 10 handler" chỉ phủ early exit cho phần lớn tools

**Evidence**

- Coverage table gọi đủ 10 tên, nhưng ngoài `list_projects`, 9 case dùng dependency không có project và chỉ assert chung `project_not_found`: `tests/mcp/tools.test.ts:61-103`.
- Chỉ `save_file` và `set_scene_timing` có real success path qua Registry để kiểm `WriteInvocation`: `tests/mcp/tools.test.ts:167-195`.
- Các bug duration, narration-stale và delete reference phía trên đều lọt qua focused suite 27/27.

**Impact**

Guard chứng minh registration/name sync và first lookup, nhưng chưa chứng minh từng Registry handler map đủ input, gọi đúng use case, forward audit, validate đúng output và xử lý success/error đặc thù.

**Suggested fix**

- Data-driven success + characteristic failure case cho từng tool qua Registry.
- Với destructive: initial approval ở hai era, retry grant, re-plan changed, success output/audit.
- Với reads: success output thật, recovery metadata, missing/corrupt source.

## Checked areas không thấy lỗi trong slice này

- Đúng đúng 10 tool names được duyệt, `snake_case`, không tự thêm prefix: registration ở `packages/mcp/src/registry/all-tools.ts:21-30`.
- Tool được định nghĩa một lần ở Registry; transports dùng `registry.list()`/`registry.invoke()` thay vì lặp handler.
- `ToolRegistry.list()` sort tên deterministic và lọc `availableInLegacy`: `packages/mcp/src/registry/registry.ts:63-75`.
- Annotation được Registry derive lại từ level, caller không thể khai metadata safety khác lúc register: `packages/mcp/src/registry/registry.ts:34-43` và `:54-60`. Mapping read/write/destructive hiện đúng.
- Cả 10 root input/output object đều dùng `z.strictObject`; focused contract test xác nhận unknown root key bị `unrecognized_keys`.
- `projectIdOf()` đúng scope cho 9 project tools; `list_projects` trả `null`. Registry chỉ derive scope sau successful input parse.
- Write handlers forward `context.writeInvocation`; destructive handlers gọi Core prepare/re-plan và không có capability `issue/revoke` approval trong registry dependency type.
- Không thấy tool nhận explicit absolute filesystem path; external file arguments được đưa qua Core workspace resolver. Resolver hiện reject absolute, backslash, drive path, dot/dot-dot và re-check canonical symlink containment.
- `read_composition` dùng allowlist/size/hash/recovery path; `set_text` kiểm file+element thuộc scene trước mutation; mọi public write schema có concurrency precondition bắt buộc.
- Registry validate output của mọi normal `Result.ok`; modern input-required là control result riêng của SDK.
- Server phát cả `structuredContent` và text content của cùng object; raw infrastructure stack/message không được trả từ Registry catch.
- Runtime dependency placement đúng Execution Contract: `@modelcontextprotocol/server@2.0.0`, `core@2.0.0`, `zod@4.4.3` ở `@vidcom/mcp`; legacy sdk/client là exact root devDependencies; contracts/registry không import SDK type.

## Verification summary

- `rtk bun run test -- tests/contracts/mcp-contracts.test.ts tests/mcp/registry.test.ts tests/mcp/tools.test.ts`
  - Exit 0
  - 3 files passed
  - 27 tests passed
- Schema probe xác nhận: negative/zero create duration được nhận, empty timing được nhận, absolute `fileHashes` key được nhận.
- HyperFrames in-memory probe xác nhận empty `setTiming` serialize ra bytes khác.
- Core direct probe xác nhận nested-relative referenced asset vẫn được `prepareFileDeletion()` chấp nhận.

