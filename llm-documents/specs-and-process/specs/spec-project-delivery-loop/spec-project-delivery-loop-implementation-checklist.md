# Spec Project Delivery Loop — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-project-delivery-loop-detailed-goal.md) — bản 12, Approved 2026-08-04
> - [Detailed Design](./spec-project-delivery-loop-detailed-design.md) — bản 6, Approved 2026-08-04
> - [Main spec](./spec-project-delivery-loop-pending.md)
> - Spike gate: [phase-3-checklist-gate](../../../../spikes/phase-3-checklist-gate/README.md) · [phase-3-detailed-design](../../../../spikes/phase-3-detailed-design/README.md) · [phase-3-render](../../../../spikes/phase-3-render/README.md) · [phase-3-agent-kit-host](../../../../spikes/phase-3-agent-kit-host/README.md)

## Context

> [!NOTE]
> Đây là nguồn sự thật trung tâm trong lúc thực thi. Mọi task phải được cập nhật tại đây.
> Công việc persistence chỉ hoàn tất khi có **cả** logic test **và** integration test trên SQLite thật + filesystem thật trong temp directory. **MUST NOT** mock `node:fs`, MUST NOT dùng in-memory stand-in ([steering/10](../../../steering/10-testing.md), Design §11.1).

Checklist chuyển Goals bản 12 và Design bản 6 thành task 1–4 giờ, giữ đúng ranh giới `HTTP/MCP → usecase → port → adapter` của [steering/03](../../../steering/03-architecture-ddd.md).

Bốn trọng tâm rủi ro, và cả bốn đều **đã có bằng chứng chạy thật** nên rủi ro là *thực thi* chứ không phải *khả thi*:

1. **Process supervision** (Phase F) — `kill(-pgid)` hiện tại **đang rò** Chromium trong repo; ba pha capture→kill→probe đã đo PASS nhưng phải port từ spike sang adapter.
2. **Migration** (Phase B) — `job` table-rebuild là loại migration Phase 2 đã trả giá một lần.
3. **Tách `sourceRevision`** (Phase D) — đúng chỗ bản 4 của Goals từng xếp sai `snapshots/`/`renders/`.
4. **Fixture Phase 1/2 vẫn xanh trong khi marker semantics đã đổi** (Phase R) — rủi ro *im lặng*, nên có phase riêng thay vì gộp.

## Approval Gate

> Không viết production code cho tới khi mục này được người dùng xác nhận tường minh.

- **Status**: **✅ APPROVED 2026-08-04** — nội dung checklist được duyệt. **Code Execution CHƯA bắt đầu theo yêu cầu tường minh của người dùng** ("approve nhưng không thực hiện code").
- **Confirmed by**: Người dùng
- **Confirmation date**: 2026-08-04
- **Trạng thái thực thi**: **Chưa bắt đầu.** Không task nào được đánh `[/]` hay `[x]`; Execution Log rỗng; `spec-project-delivery-loop-pending.md` **giữ nguyên tên** — đổi sang `-inprocess.md` chỉ xảy ra khi Phase A thực sự bắt đầu (AGENTS.md §Task Execution Workflow bước 3).
- **Notes**:
  - Design bản 7 và Goals bản 12 đã duyệt; `steering/08` đã đồng bộ (§2.1 Design).
  - **Phase B, D, E, F là gate**: không sang phase sau khi gate còn đỏ. Lý do ở Dependency Order.
  - **Re-estimate đã làm** (Design §14 đòi): ~211 SP, không phải ~190 SP của Goals. Chi tiết ở §Estimate.
  - **Chín điểm vá executability đã đóng** (mục ngay dưới) — không còn quyết định nào phải hỏi lại giữa chừng.
  - Ba mục Design còn `[ ]` **không chặn** Code Execution: năm type chưa có shape (định nghĩa ở Phase K), số CI Linux/Windows (Phase S), và chính con số estimate này.
  - **Điểm bắt đầu khi được lệnh chạy**: Phase A, task A.1.

### Vá executability 2026-08-04 — chín điểm, sau khi đối chiếu checklist với repo thật

Mỗi điểm dưới đây là một chỗ tài liệu mô tả sai code hiện có. Cả chín đều thuộc loại **sẽ chặn giữa chừng và bắt hỏi lại**, nên được đóng ở đây thay vì lúc implement.

1. **`JobStorePort.complete()` không tồn tại.** Design §6.4 và bản đầu của F.10 viết "MUST NOT đi qua `complete()` vốn ép `succeeded`". Bề mặt thật là `finish(id, outcome: JobOutcome)` với union `succeeded | failed | cancelled` ([`ports.ts:349`](../../../../packages/core/src/port/ports.ts#L349), [`types.ts:377-380`](../../../../packages/core/src/port/types.ts#L377-L380)). Việc đúng là **mở rộng `JobOutcome`**, không phải tránh một method không có.
2. **Adapter `finish` có hai lỗi chờ sẵn cho `partial`** ([`job-store.ts:150-163`](../../../../packages/adapter/src/db/job-store.ts#L150-L163)): `result` **chỉ** được serialize khi `status === "succeeded"` → outcome `partial` sẽ ghi `result = NULL` và **mất `missingSceneIds`**; `progress` chỉ set `1` khi `succeeded` → `partial` giữ progress cũ, trái với luật `partial ⇒ progress = 1`. Cả hai câm lặng, không throw.
3. **`finish` đã có sẵn nửa CAS**, không cần thêm mệnh đề `WHERE`: nó đã là `WHERE id = ? AND status IN ('queued','running')`. Cái **thiếu** là nó không trả về việc mình có áp dụng hay không, nên caller không phân biệt được "settle thành công" với "thua race". Sửa đúng là **trả số hàng bị ảnh hưởng**, không phải thêm `expectedStatus`.
4. **Bốn lint của VD-3 KHÔNG nằm ở `src/lib`.** Design §5.13 viết vậy; thực tế phân tán và hai trong bốn cái **chỉ tồn tại dưới dạng số học trong JSX**:
   | Lint | Ở đâu thật |
   |---|---|
   | stranded tween | [`timeline-elements.tsx:124-130`](../../../../src/components/studio/timeline-elements.tsx#L124-L130) — reduce trong component |
   | element overrun | [`timeline-elements.tsx:205`](../../../../src/components/studio/timeline-elements.tsx#L205) — số học trong render |
   | unresolved selector | field `unresolvedEffects` do **parser** sinh ([`hyperframes/types.ts:77`](../../../../packages/adapter/src/hyperframes/types.ts#L77)), đã có trong `dto.ts` |
   | empty scene | [`hyperframes/parse.ts:271`](../../../../packages/adapter/src/hyperframes/parse.ts#L271) |
   Nên M.1 **không phải "di chuyển một module"** mà là *trích luật ra khỏi JSX và đặt nó vào Core kèm mã Diagnostic*. Hai cái sau đã có nguồn ở adapter nên chỉ cần bọc thành Diagnostic.
5. **`packages/agent-kit/` và `packages/worker/` đã tồn tại.** `agent-kit` là scaffold rỗng (`prompts/.gitkeep`, `skills/.gitkeep`) chứ không phải chưa có; `worker` đã có `tts-job.ts` và `index.ts` để đăng ký job type. Phase Q/I/J là **thêm nội dung vào package có sẵn**, và `index.ts` của worker phải được cập nhật để đăng ký hai job type mới.
6. **Migration nằm ở `packages/adapter/drizzle/`**, không phải `drizzle/` ở gốc ([`drizzle.config.ts`](../../../../drizzle.config.ts) `out`). `drizzle-kit@1.0.0-rc.4`; nếu nó không sinh đúng table-rebuild thì **được phép sửa tay** `migration.sql` (tiền lệ Phase 2), và drift check so `schema.ts` ↔ snapshot nên hand-edit không làm nó đỏ.

7. **`DomainEvent.payload` là `Record<string, unknown>`** ([`domain.ts:18-22`](../../../../packages/contracts/src/domain.ts#L18-L22), zod `z.record(z.string(), z.unknown())`). Tin tốt: đưa `partial` vào payload `job.done` **không** cần đổi contract. Tin xấu: **không có guard của compiler** — nếu payload sai tên field thì không ai báo. Test SSE (O.10) là lớp bảo vệ **duy nhất**, nên nó phải assert đúng shape chứ không chỉ assert "có event".
8. **Scope workspace MUST NOT phát `DomainEvent`.** Hai ràng buộc chặn cứng: `DomainEvent.projectId` là `ProjectId` **không nullable**, và `ck_event_type` chỉ nhận đúng bốn giá trị `file.changed | project.changed | job.progress | job.done` ([`schema.ts`](../../../../packages/adapter/src/db/schema.ts)). Agent-kit install ghi ở gốc workspace nên **không có** `projectId` để bịa, và thêm loại event mới sẽ tốn một migration cộng đổi contract. Vì vậy `mutateWorkspace` chỉ ghi `audit_entry` (với `project_id = NULL`) và **không** phát event. Ghi ở đây để không ai ứng biến giữa chừng.

9. **Ba usecase/domain "mới" thật ra đã tồn tại** — tạo file song song sẽ sinh **đường ghi thứ hai** cho cùng một thao tác:
   | Checklist bản đầu định tạo | Đã có ở đâu |
   |---|---|
   | `domain/scene-timing.ts` | [`domain/invariants.ts`](../../../../packages/core/src/domain/invariants.ts) — `validateSceneTiming`, và `SceneTimingInput` **đã mang `trackIndex` + `rootDuration`** |
   | `usecase/scene-insert.ts` | [`project-writes.ts:339`](../../../../packages/core/src/usecase/project-writes.ts#L339) `createScene` |
   | `usecase/scene-timing.ts` | [`project-writes.ts:130`](../../../../packages/core/src/usecase/project-writes.ts#L130) `setSceneTiming` |
   Vùng narration cũng đã có `NarrationRecord` + `regenerateNarration` ([:284](../../../../packages/core/src/usecase/project-writes.ts#L284)). C.4 và N.1–N.4 đổi thành **mở rộng**, không tạo mới.

Kèm hai đính chính vào Design (đã áp): Decision 1 Context mô tả thiếu — `readProjectRefAt` hôm nay đòi **cả ba** `hyperframes.json` + `vidcom.json` hợp lệ + `index.html`, chứ không chỉ hai; và `resolveWorkspace` hiện sống ở [`packages/cli/src/workspace-selection.ts`](../../../../packages/cli/src/workspace-selection.ts) với `active_workspace` lưu qua `AppSettingsStore`, nên C.1 và O.1 phải chạm file đó.

## Sequencing Strategy

**Chosen strategy**: **Hybrid — Foundation-First + Risk-First**.

**Rationale**: contract/schema phải ổn định trước (Foundation-First), nhưng process supervision và migration có blast radius lớn nhất lên code Phase 1/2 đang chạy nên được kiểm chứng sớm (Risk-First). Bề mặt HTTP/MCP chỉ nối sau khi Core chứng minh được ba invariant: `sourceRevision` không bị ghi dẫn xuất làm tiến, composite workspace rollback được cả batch, và `cancelled` chỉ ghi sau proof.

## Dependency Order

```text
A Baseline: dependency + contract + error code
└─→ B SQLite migration — GATE
    ├─→ C Domain thuần (không I/O)
    └─→ D WriteAuthority: mutateSource/mutateDerived — GATE
        ├─→ E WorkspaceMutationCoordinator + directory lifecycle — GATE
        │   └─→ L ProjectLifecycle CRUD
        └─→ K Workspace resolve/scan/identity/state store
F ProcessSupervisorPort ba pha — GATE  (chỉ phụ thuộc A)
├─→ G RenderRootPort + orphan reclaim
├─→ H RemoteAssetGuard runtime (CSP + observer)
└─→ B, D, F, G, H ─→ I Render job
                    └─→ J Snapshot job
C + K ─→ M Diagnostics + Thumbnail
C + D ─→ N Scene timing + narration cues
E ─────→ Q Agent-kit bundle + installer
I, J, K, L, M, N ─→ O HTTP routes
O + Q ─────────────→ P MCP tool surface
tất cả ───────────→ R Fixture audit Phase 1/2
tất cả ───────────→ S CI gate + contract matrix + release
```

**Recommended execution order**: A → B → **F** → C → D → E → G → H → I → J → K → L → M → N → Q → O → P → R → S

> F được kéo lên ngay sau B dù không phụ thuộc B: nó sửa một **bug đang tồn tại** ([`node-process-runner.ts:137`](../../../../packages/adapter/src/runtime/node-process-runner.ts#L137) rò Chromium), và mọi phase render/snapshot phía sau đứng trên nó.

**Parallelizable**: F song song được với B/C/D (khác file, khác bảng). K song song được với E sau khi D xanh. M và N song song được với nhau.

---

## LLM Agent — Skill Activation Per Phase

| Phase | Skills to activate | Source files to read BEFORE modifying |
|-------|---------------------|--------------------------------------|
| A, B | — | [`packages/adapter/src/db/schema.ts`](../../../../packages/adapter/src/db/schema.ts) (FULL) · [`journal.ts`](../../../../packages/adapter/src/db/journal.ts) (search `preparePrevious`) |
| C | — | [`path-policy.ts`](../../../../packages/core/src/domain/path-policy.ts) (FULL) · [`workspace-resolver.ts`](../../../../packages/core/src/domain/workspace-resolver.ts) (FULL) |
| D, E | — | [`write-authority.ts`](../../../../packages/core/src/service/write-authority.ts) (FULL) · [`journal.ts`](../../../../packages/adapter/src/db/journal.ts) (FULL) |
| F | `.agents/skills/bun/SKILL.md` (runtime khác biệt Node/Bun) | [`node-process-runner.ts`](../../../../packages/adapter/src/runtime/node-process-runner.ts) (FULL) · [`process-port.ts`](../../../../packages/core/src/port/process-port.ts) (FULL) · [`job-scheduler.ts`](../../../../packages/core/src/service/job-scheduler.ts) (FULL) · [spike `platform-supervisor.mjs`](../../../../spikes/phase-3-checklist-gate/platform-supervisor.mjs) (FULL — port nguyên thuật toán) |
| G, H, I, J | — | [`hyperframes/document.ts`](../../../../packages/adapter/src/hyperframes/document.ts) · [`hyperframes/parse.ts`](../../../../packages/adapter/src/hyperframes/parse.ts) (search `buildDocument`) |
| K, L | — | [`workspace-fs.ts`](../../../../packages/adapter/src/fs/workspace-fs.ts) (FULL) · [`bootstrap-project.ts`](../../../../packages/core/src/usecase/bootstrap-project.ts) (FULL) |
| O | `.agents/skills/hono/SKILL.md`, `.agents/skills/http-driver/SKILL.md` | route hiện có trong `packages/server/src/routes/` |
| P | `.agents/skills/mcp-builder/SKILL.md` | `packages/mcp/src/registry/job-tools.ts` (FULL — mở rộng, MUST NOT register trùng tên) |
| Q | `.agents/skills/mcp-builder/SKILL.md` | [`steering/14`](../../../steering/14-agent-kit-and-skills.md) (FULL) · [spike ma trận host](../../../../spikes/phase-3-agent-kit-host/README.md) |

**Steering đọc một lần trước khi bắt đầu**: [01 stack](../../../steering/01-backend-stack.md) · [03 DDD](../../../steering/03-architecture-ddd.md) · [07 data](../../../steering/07-data-and-storage.md) · [**08 jobs**](../../../steering/08-jobs-and-queue.md) — **đã sửa cho spec này**, đọc §2, §3, §6.1 · [10 testing](../../../steering/10-testing.md) · [11 code style](../../../steering/11-code-style.md).

---

## Task Status Legend

- `[ ]` — Not started
- `[/]` — In progress
- `[x]` — Complete (implemented, tested, validated)
- `[!]` — Blocked (kèm ghi chú nêu blocker)

---

## Phase A: Baseline — dependency, contract, error code

**Addresses**: R6.12, R6.14, R7.9b, R12 · **Design**: §4.6, §7.1, §8.1
**Files affected**: `package.json`, `packages/contracts/src/dto.ts`, `packages/core/src/port/types.ts`
**Prerequisite**: None
**Estimate**: 8 SP

**Tasks**:
- [ ] A.1 Chuyển `hyperframes` từ `devDependencies` sang `dependencies`
  - Render là tính năng runtime; hiện nó là devDependency nên bản ship sẽ thiếu binary
  - Pin `HYPERFRAMES_EXPECTED_VERSION = "0.7.86"` làm hằng số có tên
  - _Requirements: R6.1_ — _Design: §4.6_
- [ ] A.2 Thêm `ErrorCode` mới
  - `project_invalid`, `identity_parse_error`, `composition_parse_error`, `no_composition`, `no_scenes`, `remote_asset_not_local`, `render_binary_missing`, `process_termination_unverified`, `confirmation_required`, `rollback_payload_pruned`
  - _Requirements: R1.2c, R6.12, R6.15_ — _Design: §7.1, §8.1_
- [ ] A.3 Thêm warning code ổn định (không phải error)
  - `external_dependency_unpinned`, `sub_timeline_readiness_timeout`, `termination_proof_not_exhaustive`, `engine_version_drift`
  - Warning là **giá trị có mã**, MUST NOT là chuỗi tự do — client quyết định hiển thị bằng mã
  - _Requirements: R6.14, R6.15b_ — _Design: §7.1_
- [ ] A.4 Mở rộng `JobStatus` và `JobDto`
  - `partial` vào union; thêm `warnings: {code,message}[] | null` và `cleanupPending: boolean`
  - `TERMINAL_JOB_STATUSES` = `succeeded | partial | failed | cancelled`
  - `Job extends JobDto` ([`types.ts:356`](../../../../packages/core/src/port/types.ts#L356)) nên hai field mới bắt buộc phải map trong [`toJob`](../../../../packages/adapter/src/db/job-store.ts#L44) — TypeScript sẽ bắt nếu quên, đây là lỗi ồn chứ không câm
  - _Requirements: R7.9b, R6.6b, R6.14_ — _Design: §6.4_
- [ ] A.5 Thêm hai `PathPurpose`
  - `state-write`, `workspace-agent-kit` vào union ở `port/types.ts` (logic ở Phase C)
  - _Requirements: R4.10, R13.12_ — _Design: §5.19_
- [ ] A.6 Unit test contract
  - Zod response chấp nhận `partial`; `warnings` round-trip giữ nguyên **thứ tự**; `TERMINAL_JOB_STATUSES` có đúng 4 phần tử
  - _Requirements: R7.9b_

**Acceptance Criteria**:
- [ ] `npm run typecheck` xanh sau khi thêm `partial` — mọi `switch` trên `JobStatus` đã xử lý nhánh mới (đây là cách tìm hết call site, không phải grep)
- [ ] `hyperframes` resolve được từ `dependencies` bằng `require.resolve("hyperframes/package.json")`

**Deliverables**: `package.json` · `packages/contracts/src/dto.ts` · `packages/core/src/port/types.ts`

---

## Phase B: SQLite migration — **GATE**

**Addresses**: R4.4c, R6.6b, R6.14, R7.9b, R13.11 · **Design**: §6.4, §6.5
**Files affected**: `packages/adapter/src/db/schema.ts`, `drizzle/`, `scripts/verify-schema-drift.mjs`
**Prerequisite**: A
**Estimate**: 21 SP
**Read first**: [`schema.ts`](../../../../packages/adapter/src/db/schema.ts) (FULL) · spike [`migration-remediation.ts`](../../../../spikes/phase-3-detailed-design/migration-remediation.ts) (FULL — protocol table-rebuild đã PASS)

**Tasks**:
- [ ] B.1 `ALTER TABLE revision ADD COLUMN advances_source integer NOT NULL DEFAULT 1 CHECK (advances_source IN (0,1))`
  - Expand-only. Default `1` đúng nghĩa cho **mọi** hàng lịch sử — chúng đều là ghi nội dung, nên **không backfill**
  - _Requirements: R4.4c_ — _Design: §6.4 `revision`_
- [ ] B.2 Table-rebuild `job` trong một transaction
  - `ck_job_status` mở thêm `partial`; thêm `cleanup_pending integer NOT NULL DEFAULT 0 CHECK IN (0,1)` và `warnings_json text NULL CHECK (json_valid)`
  - Dựng lại **toàn bộ** index/FK/check của bảng cũ — liệt kê tường minh, MUST NOT dựa vào drizzle sinh đủ
  - `job.type` **không** đổi: nó không có check constraint, nên `render`/`snapshot` là zero-migration
  - _Requirements: R7.9b, R6.6b, R6.14_ — _Design: §6.4 `job`, Finding 2_
- [ ] B.3 `CREATE TABLE workspace_operation` + `workspace_operation_step`
  - Header: `kind` CHECK `agent_kit_files|project_create|project_rename|project_delete`; `status` CHECK `pending|committed|aborted|recovered|orphaned`; `project_id` nullable **không FK bắt buộc** (delete phải giữ journal sau khi registration bị gỡ)
  - Step: PK `(operation_id, ordinal)` + UNIQUE `(operation_id, path)`; spill policy previous-content **dùng lại** của Phase 2
  - _Requirements: R12.10b, R13.11_ — _Design: §6.4, Decision 4_
- [ ] B.4 Ba index mới
  - `idx_revision_source (project_id, advances_source, id DESC)` · `idx_revision_derived_path (project_id, path, id DESC) WHERE advances_source = 0` · `idx_job_cleanup (cleanup_pending) WHERE cleanup_pending = 1`
  - _Requirements: R4.4c, R6.7b_ — _Design: §6.4_
- [ ] B.5 Rollback helper cho table-rebuild `job`
  - Preflight **từ chối** rollback khi còn hàng `status='partial'`, nêu count. **MUST NOT** map im lặng sang `succeeded`
  - Dùng cùng protocol rename-table của `mcp-migration-rollback.ts`
  - _Requirements: R7.9b_ — _Design: §6.5_
- [ ] B.6 Cập nhật schema drift snapshot
  - `npm run test:schema-drift` phải xanh; nếu `drizzle-kit` không sinh đúng table-rebuild thì **được phép sửa tay** `migration.sql` (tiền lệ Phase 2)
  - _Requirements: —_ — _Design: §6.5_

**Tasks — Real Datastore Tests**:
- [ ] B.7 Migration test: hàng `revision` cũ đọc ra `advances_source = 1`; `advances_source = 7` bị CHECK chặn
- [ ] B.8 Migration test: hàng `job` cũ giữ nguyên byte/nghĩa; `INSERT status='partial'` thành công; `warnings_json` JSON lỗi bị chặn; `cleanup_pending = 2` bị chặn
- [ ] B.9 Migration test: `job.type='render'` insert được **không** cần DDL enum
- [ ] B.10 Migration test: `PRAGMA foreign_key_check` rỗng, `integrity_check` OK sau migration
- [ ] B.11 Rollback test: còn `partial` → preflight từ chối kèm count; hết `partial` → rollback sạch

**Acceptance Criteria**:
- [ ] Toàn bộ ~180 test Phase 1/2 vẫn xanh sau migration
- [ ] `foreign_key_check` rỗng; index mới xuất hiện trong `sqlite_master`
- [ ] **GATE**: không sang phase sau nếu bất kỳ test B.7–B.11 đỏ

**Deliverables**: `packages/adapter/src/db/schema.ts` · migration mới trong `drizzle/` · rollback helper · `tests/adapter/migration-*.test.ts`

---

## Phase F: ProcessSupervisorPort ba pha — **GATE**

> Đặt ngay sau B vì nó **sửa một bug đang tồn tại**, không phải thêm tính năng.

**Addresses**: R6.6b, R6.6b-i, R6.6b-ii · **Design**: §5.9, §5.20, Decision 12, Finding 11
**Files affected**: `packages/core/src/port/process-port.ts`, `packages/adapter/src/runtime/`, `packages/core/src/service/job-scheduler.ts`
**Prerequisite**: A
**Estimate**: 26 SP
**Read first**: [`node-process-runner.ts`](../../../../packages/adapter/src/runtime/node-process-runner.ts) (FULL) · [`job-scheduler.ts`](../../../../packages/core/src/service/job-scheduler.ts) (FULL) · [spike `platform-supervisor.mjs`](../../../../spikes/phase-3-checklist-gate/platform-supervisor.mjs) (FULL)

**Tasks — Port + adapter**:
- [ ] F.1 Khai `ProcessSupervisorPort` + `ProcessTerminationProof`
  - `capturedPids`, `capturedGroups`, `survivors`, `sweeps`, `exhaustive`; hằng số có tên `PROCESS_CAPTURE_INTERVAL_MS = 250`, `PROCESS_VERIFY_SWEEP_INTERVAL_MS = 100`, `PROCESS_VERIFY_MAX_SWEEPS = 20`
  - `ProcessPort` cũ **giữ nguyên** cho TTS — MUST NOT đổi contract đang có
  - _Requirements: R6.6b_ — _Design: §5.9_
- [ ] F.2 Ba primitive theo nền tảng, thuật toán phía trên **không** rẽ nhánh OS
  - POSIX: `ps -Ao pid=,ppid=,pgid=` · `kill(-pgid)` / `kill(pid)` · `kill(pid,0)` với **`EPERM` = còn sống**
  - Windows: PowerShell CIM → `tasklist` thoái hoá · `taskkill /t /f` **awaited** · `tasklist /fi "PID eq"` so **theo cột PID**
  - `wmic` **MUST NOT** xuất hiện (D10)
  - _Requirements: R6.6b-ii_ — _Design: §5.9, Finding 12_
- [ ] F.3 Pha capture
  - Poll bao đóng descendant mỗi `PROCESS_CAPTURE_INTERVAL_MS` **trong lúc process chạy**, tích luỹ PID cụ thể + pgid phân biệt
  - Thiếu pha này thì sau khi cha chết không còn cách nào tìm lại đám con — đây là pha hôm nay hoàn toàn không tồn tại
  - _Requirements: R6.6b_ — _Design: §5.9_
- [ ] F.4 Pha kill + verify
  - Kill mọi group đã ghi, rồi mọi PID đã ghi, rồi root. Verify probe **từng PID đã ghi**, nạp PID mới xuất hiện, dừng ở hai lượt rỗng liên tiếp
  - Survivor sau `MAX_SWEEPS` → `ProcessTerminationUnverifiedError`
  - _Requirements: R6.6b_ — _Design: §5.9_
- [ ] F.5 Sửa bug đang tồn tại ở `killProcessTree`
  - [`node-process-runner.ts:137`](../../../../packages/adapter/src/runtime/node-process-runner.ts#L137) `kill(-pid)` để sót Chromium; Windows `spawn(taskkill).unref()` không await
  - **Quyết định phải trả lời trong task này**: sửa luôn `ProcessPort` cũ (TTS cũng hưởng) hay chỉ supervisor mới. Comment tại chỗ nói về sidecar VieNeu/Python — đúng cho ca đó; nếu chỉ sửa supervisor thì **MUST** cập nhật comment để không ai đọc nhầm là đã an toàn chung
  - _Requirements: R6.6b_ — _Design: §15, Finding 11_
- [ ] F.6 Thoái hoá khi không có enumerator cho `ppid`
  - Capture chỉ còn root group; proof `exhaustive: false` + warning `termination_proof_not_exhaustive`
  - Luật là **trung thực, không phải zero survivor**: proof MUST NOT báo sạch khi process còn sống
  - _Requirements: R6.6b-i_ — _Design: §5.9_

**Tasks — JobScheduler (§5.20)**:
- [ ] F.7 Poll cờ cancel bền trong lúc handler chạy
  - `CANCELLATION_POLL_MS = 250`, gọi `store.isCancellationRequested`, thấy cờ thì `controller.abort()`; clear trong `finally` cùng chỗ `heartbeat`
  - _Requirements: R6.6b_ — _Design: §5.20_
- [ ] F.8 Phân biệt abort-do-cancel với abort-do-timeout
  - Field `abortReason: "cancel" | "timeout" | null` set **trước** `controller.abort()`; catch đọc field, **MUST NOT** đoán từ loại error — nếu không cancel sẽ rơi vào nhánh retry của timeout
  - _Requirements: R6.6b_ — _Design: §5.20_
- [ ] F.9 Terminal settle **báo được** thắng hay thua race
  - `finish` **đã có** nửa CAS: `WHERE id = ? AND status IN ('queued','running')` ([`job-store.ts:161`](../../../../packages/adapter/src/db/job-store.ts#L161)). **MUST NOT** thêm `expectedStatus` chồng lên nó
  - Cái thiếu: nó trả `void`, nên caller không phân biệt "settle thành công" với "thua race". Đổi thành trả **số hàng bị ảnh hưởng** (hoặc `applied: boolean`); scheduler map `0` → `no_change`
  - Đây là thứ làm luật "không có artifact published + status cancelled" đúng được, không chỉ là ý định
  - _Requirements: R6.6b_ — _Design: §5.9, §5.20_ — _Vá executability #3_
- [ ] F.10 Mở rộng `JobOutcome` với `partial` — **không** thêm method mới
  - Thêm nhánh `{ status: "partial"; result: unknown }` vào [`JobOutcome`](../../../../packages/core/src/port/types.ts#L377)
  - `JobStorePort.complete()` **không tồn tại** — đừng đi tìm nó; bề mặt thật chỉ có `finish(id, outcome)`
  - _Requirements: R7.9b_ — _Design: §6.4_ — _Vá executability #1_
- [ ] F.11 Sửa **hai lỗi câm** trong adapter `finish` mà `partial` sẽ kích hoạt
  - [`job-store.ts:152`](../../../../packages/adapter/src/db/job-store.ts#L152): `result` chỉ serialize khi `succeeded` → outcome `partial` ghi `NULL` và **mất `missingSceneIds`**
  - [`job-store.ts:157`](../../../../packages/adapter/src/db/job-store.ts#L157): `progress` chỉ set `1` khi `succeeded` → `partial` giữ progress cũ, trái luật `partial ⇒ progress = 1`
  - Cả hai **không throw**. Test phải khẳng định **giá trị đã ghi**, không chỉ khẳng định "không lỗi"
  - _Requirements: R7.9b_ — _Design: §6.4_ — _Vá executability #2_
- [ ] F.12 `recoverStale` biết `partial`
  - Coi `partial` là terminal (không requeue, không finalize lại); set `cleanup_pending` khi job treo còn render root chưa release
  - _Requirements: R7.9b, R6.7b_ — _Design: §5.20_
- [ ] F.13 Đăng ký hai job type mới ở `packages/worker/src/index.ts`
  - Package **đã tồn tại** và đã đăng ký `tts-job`; `render`/`snapshot` thêm vào cùng chỗ. `job.type` không có check constraint nên đây là zero-migration
  - _Requirements: R6.1, R7.1_ — _Vá executability #5_

**Tasks — Process Tests** (adapter thật, không mock):
- [ ] F.14 Port `s1e` thành test vitest: fixture tự tách group, naive leak vs ba pha không leak
- [ ] F.15 Test: sweep cạn còn survivor → `process_termination_unverified`, **không** ghi `cancelled`
- [ ] F.16 Test: sweep rỗng nhưng `exhaustive:false` → `cancelled` **kèm** warning `termination_proof_not_exhaustive`
- [ ] F.17 Test: sweep theo quan hệ cha-con **bị chứng minh là báo sai** — assert nó trả rỗng trong lúc PID probe còn thấy sống
- [ ] F.18 Test: abort do cancel không đi vào nhánh retry của timeout
- [ ] F.19 Test: race cancel/complete ở barrier trước publish — cancel thắng → không artifact; terminal đã settle → cancel `no_change`
- [ ] F.20 Test: `finish` với outcome `partial` ghi **đúng** `result` JSON và `progress = 1` (chốt F.11 — hai lỗi câm)
- [ ] F.21 Test skip **có thông báo** khi Chromium/FFmpeg vắng mặt, MUST NOT pass im lặng

**Acceptance Criteria**:
- [ ] `npm run spike:process-supervision` xanh trên máy dev
- [ ] Không test nào suy survivor từ ppid hoặc từ thành viên process group (R6.6b-ii)
- [ ] **GATE**: F.14–F.20 xanh trước khi bắt đầu I/J

**Deliverables**: `packages/core/src/port/process-port.ts` · `packages/adapter/src/runtime/process-supervisor.ts` + primitive theo OS · `packages/core/src/service/job-scheduler.ts` · `tests/adapter/process-supervisor.test.ts`

---

## Phase C: Domain thuần — không I/O

**Addresses**: R1, R2, R10, R11, R4.10, R13.12, R6.15 · **Design**: §5.1, §5.4, §5.14, §5.19, §5.10 (phần static)
**Files affected**: `packages/core/src/domain/` (`invariants.ts` mở rộng; `platform-preset.ts` mới)
**Prerequisite**: A
**Estimate**: 18 SP
**Read first**: [`path-policy.ts`](../../../../packages/core/src/domain/path-policy.ts) (FULL — đặc biệt `isGloballyBlocked`) · [`workspace-resolver.ts`](../../../../packages/core/src/domain/workspace-resolver.ts) (FULL)

**Tasks**:
- [ ] C.1 Viết lại `resolveWorkspace` theo bảng quyết định 8 dòng
  - `WorkspaceSource = explicit | cwd-project | cwd-solo | active | cwd`; `readable` thay `valid`; `hasIdentityFile` xét **sự có mặt**, MUST NOT xét tính hợp lệ
  - Hàm thuần, không I/O — composition root nạp candidate
  - **Call site thật nằm ở [`packages/cli/src/workspace-selection.ts`](../../../../packages/cli/src/workspace-selection.ts)**, và `active_workspace` lưu qua `AppSettingsStore`, không phải file riêng. Sửa domain mà quên file này thì logic mới không có ai gọi
  - _Requirements: R1.2e, R1.10_ — _Design: §5.1, §4.3.1_ — _Vá executability_
- [ ] C.2 `PlatformPresetCatalog`
  - `PLATFORM_PRESETS`, `assertCatalogEncodable()` (từ chối lúc khởi động nếu preset có kích thước lẻ), `inferPreset`, `validateCustom` (chẵn, 128…7680, fps 1…120)
  - _Requirements: R2.4b–4d, R2.7, R3.4_ — _Design: §5.4_
- [ ] C.3 `pathPolicy` — hai purpose mới với **exception hẹp tường minh**
  - `isGloballyBlocked` chặn **mọi** segment `startsWith(".")`, nên `state-write` và `workspace-agent-kit` phải có cửa hẹp theo đúng pattern exception của `system-write`
  - `state-write`: chỉ `.vidcom/` + các nhánh §5.6 sở hữu · `workspace-agent-kit`: đúng tập literal `AGENTS.md`, `CLAUDE.md`, `AGENTS.vidcom.md`, `CLAUDE.vidcom.md`, `.agents/skills/`, `.claude/skills/`
  - `.env*` chặn ở **cả hai** purpose mới; `node_modules`/`.git`/`.hyperframes` chặn nguyên
  - _Requirements: R4.10, R4.11, R13.12, R13.13_ — _Design: §5.19_
- [ ] C.4 `planRipple` + `detectTrackGapsAndOverlaps` — **mở rộng [`domain/invariants.ts`](../../../../packages/core/src/domain/invariants.ts)**, không tạo file mới
  - `validateSceneTiming` đã tồn tại ở đó và `SceneTimingInput` **đã mang `trackIndex` + `rootDuration`**. Tạo `domain/scene-timing.ts` song song = hai nhà cho cùng một invariant, đúng thứ spec này đang loại bỏ
  - Chỉ dịch scene **trong cùng track**; `rootDuration` là `max` trên **mọi** track; hở/chồng chỉ tính trong cùng track, chồng giữa track là **hợp lệ**
  - _Requirements: R10.1–3, R10.2b, R10.7_ — _Design: §5.14, Decision 9_ — _Vá executability #9_
- [ ] C.5 `NarrationCueService.readCues` + `buildNarrationClips`
  - Sidecar một-cue cũ đọc thành **đúng một** cue, MUST NOT ghi đè
  - _Requirements: R11.2, R11.3_ — _Design: §5.15_
- [ ] C.6 `scanRemoteMedia` + `scanExternalDependencies` (static)
  - Quét CSS `url(...)`, local stylesheet, element attribute. Script/stylesheet/font: **không** chặn, chỉ warning + `reproducible:false`
  - _Requirements: R6.15, R6.15b_ — _Design: §5.10_

**Tasks — Logic Tests**:
- [ ] C.7 Unit test bảng 8 dòng của `resolveWorkspace`, gồm `cwd` có `vidcom.json` **lỗi** → vẫn chọn cwd, **không** rơi xuống active
- [ ] C.8 Unit test `validateCustom` bounds · `inferPreset` không khớp → `custom` · `assertCatalogEncodable`
- [ ] C.9 Unit test path: `.vidcom/state.json` qua `state-write` **được**, qua `write-source` **bị chặn**; `.env` chặn ở cả hai purpose mới; `workspace-agent-kit` không resolve được vào trong một project
- [ ] C.10 Unit test `planRipple` trên project **nhiều track**: track khác **không** dịch; chồng giữa track **không** là lỗi
- [ ] C.11 Unit test `scanRemoteMedia` bắt được asset trong **CSS `url(...)`**, không chỉ attribute

**Acceptance Criteria**:
- [ ] Không file nào trong `packages/core/` import `node:fs` — luật do **ESLint flat config** áp lên `packages/core/**` và bắt lúc `npm run lint`. `npm run test:boundaries` chỉ chứng minh **luật còn hiệu lực** (nó lint fixture), MUST NOT nhầm nó là phép kiểm file mới của bạn
- [ ] Test multi-track có thật — luật per-track chỉ tồn tại trong tài liệu nếu fixture chỉ có một track

**Deliverables**: `packages/core/src/domain/workspace-resolver.ts` · `packages/core/src/domain/platform-preset.ts` · `packages/core/src/domain/path-policy.ts` · `packages/core/src/domain/invariants.ts` (mở rộng) · `packages/core/src/usecase/narration-cues.ts` · `packages/core/src/service/remote-asset-scan.ts`

---

## Phase D: WriteAuthority — `mutateSource` / `mutateDerived` — **GATE**

**Addresses**: R4.4, R4.4b, R4.4c · **Design**: §5.18, §6.1, Decision 3, Decision 14
**Files affected**: `packages/core/src/service/write-authority.ts`, `packages/adapter/src/db/journal.ts`
**Prerequisite**: B
**Estimate**: 21 SP
**Read first**: [`write-authority.ts`](../../../../packages/core/src/service/write-authority.ts) (FULL) · [`journal.ts`](../../../../packages/adapter/src/db/journal.ts) (search `preparePrevious`, `LARGE_PREVIOUS_CONTENT_THRESHOLD`)

**Tasks**:
- [ ] D.1 Tách thành hai method, bỏ `purpose` do caller truyền
  - `mutateSource(SourceMutationRequest)` luôn `advances_source=1`; `mutateDerived(DerivedMutationRequest)` luôn `0`
  - **Breaking change bắt buộc**: `MutationRequest.purpose?: "write-source" | "system-write"` hiện cho caller tự chọn — thêm `state-write` vào đó sẽ mở đúng cái lỗ Decision 3 đang bịt
  - _Requirements: R4.4c_ — _Design: §5.18_
- [ ] D.2 Bảng suy purpose từ `(method, path)` — allowlist compile-time
  - 5 dòng: `mutateSource`+identity/preview/narration → `system-write` · `mutateSource`+còn lại → `write-source` · `mutateDerived`+`.vidcom/**` → `state-write` · `mutateDerived`+`snapshots|renders/**` → `write-asset` · `mutateWorkspace`+literal → `workspace-agent-kit`
  - Path không khớp dòng nào của method đang gọi → `not_allowed_for_purpose`, **MUST NOT** fallback sang method khác
  - _Requirements: R4.4c_ — _Design: §5.18_
- [ ] D.3 `mutateDerived` composite nhiều file
  - Snapshot publish N ảnh + contact sheet + `state.json` như **một** composite; dùng lại `StagedAssetPort` đã có cho artifact nhị phân
  - _Requirements: R7.4_ — _Design: §5.18, §5.11_
- [ ] D.4 `latestSourceRevision(projectId)` trên `MutationJournalPort`
  - `id` lớn nhất với `advances_source = 1`, dùng `idx_revision_source`
  - _Requirements: R4.4c_ — _Design: §6.4_
- [ ] D.5 Prune K generation cho derived rollback payload
  - `DERIVED_ROLLBACK_GENERATIONS = 3` hằng số có tên; giữ K bản gần nhất theo `(project_id, path)` với `advances_source=0`
  - Xoá payload (`revision_blob` row + object trong `PreviousContentStore`) nhưng **giữ revision row** — `computedAtSourceRevision` và audit phải sống lâu hơn payload
  - Chạy **trong cùng transaction với publish**, MUST NOT là job nền
  - Rollback vượt K trả `rollback_payload_pruned`, MUST NOT im lặng thành công
  - _Requirements: R4.4_ — _Design: §6.1, Decision 14_

**Tasks — Real Datastore Tests** (test quan trọng nhất của spec):
- [ ] D.6 Ghi `state.json` · `context/**` · `snapshots/**` · `renders/**` — **cả bốn** MUST NOT làm `latestSourceRevision` tiến
- [ ] D.7 Một job render chạy xong MUST NOT làm snapshot bị nhãn stale
- [ ] D.8 `mutateDerived` với path `index.html` → `not_allowed_for_purpose`, **không** fallback sang `mutateSource`
- [ ] D.9 Publish lần K+1 xoá payload cũ nhất nhưng **giữ** revision row; rollback vượt K trả `rollback_payload_pruned`
- [ ] D.10 `latestSourceRevision` dùng `idx_revision_source` (assert query plan, không chỉ kết quả)

**Acceptance Criteria**:
- [ ] Không caller nào truyền được cờ `advancesSource` hay `purpose` — kiểm bằng type, không bằng review
- [ ] **GATE**: D.6–D.9 xanh trước Phase E/I/J

**Deliverables**: `packages/core/src/service/write-authority.ts` · `packages/adapter/src/db/journal.ts` · `tests/core/source-revision.test.ts`

---

## Phase E: WorkspaceMutationCoordinator + directory lifecycle — **GATE**

**Addresses**: R5, R12.10b, R13.11 · **Design**: §5.7, §5.18, §6.4, Decision 4
**Files affected**: `packages/core/src/service/workspace-mutation-coordinator.ts`, `packages/core/src/port/`, `packages/adapter/src/fs/`
**Prerequisite**: D
**Estimate**: 21 SP

**Tasks**:
- [ ] E.1 `WorkspaceOperationJournalPort` + adapter
  - Header/step theo B.3; protocol capture → publish → settle giống composite project nhưng **không** revision/backup
  - _Requirements: R13.11_ — _Design: Decision 4_
- [ ] E.2 `WriteAuthority.mutateWorkspace` (facade public)
  - **MUST NOT phát `DomainEvent`**: `DomainEvent.projectId` không nullable và `ck_event_type` khoá đúng 4 loại — scope workspace không có `projectId` để bịa. Chỉ ghi `audit_entry` với `project_id = NULL` (_Vá executability #8_)
  - Coordinator là dependency **nội bộ sau facade**; MUST NOT inject thẳng vào installer/route/MCP
  - HTTP/MCP schema **không** nhận `workspaceRoot` — composition root inject root đã resolve
  - `writes[].content` là `string | Uint8Array` để khớp `MutationRequest`
  - _Requirements: R13.11_ — _Design: §5.18_
- [ ] E.3 `ProjectDirectoryPort` + `FsProjectDirectoryAdapter`
  - `stageCreate` / `publishCreate` / `rename` / `quarantine` / `restoreQuarantine` / `removeOwned`
  - Core MUST NOT import `node:fs` chỉ vì class có chữ "Manager"
  - _Requirements: R5.1, R5.10_ — _Design: §5.7_
- [ ] E.4 Serialize target collision
  - Mutex dưới lease single-writer + query join pending/orphaned step theo target path trong transaction begin; trùng target → `write_conflict`
  - SQLite **không** tạo được partial index cross-table theo status của bảng header — MUST NOT giả có index đó
  - _Requirements: R12.10b_ — _Design: §6.4_
- [ ] E.5 Recovery một operation terminal hoá **cả batch**
  - Step publish fail → restore theo ordinal **giảm dần**; rollback fail → `orphaned`, chặn mutation trùng target
  - MUST NOT settle từng file thành các operation độc lập
  - _Requirements: R12.10b_ — _Design: Decision 4, Finding 10_

**Tasks — Real Datastore Tests**:
- [ ] E.6 Agent-kit fail ở step N → restore N−1 step và terminal hoá **một** workspace operation
- [ ] E.7 Hai operation đồng thời đụng cùng path → đúng một bắt đầu, cái kia `write_conflict` (test `Promise.all`)
- [ ] E.8 `mutateWorkspace` MUST NOT insert vào `revision`
- [ ] E.9 Crash ở từng boundary staging→rename→DB settle không để lại folder nửa vời

**Acceptance Criteria**:
- [ ] `mutation_journal`, `mutation_step`, `revision_step`, `revision_blob` **không đổi cấu trúc**
- [ ] **GATE**: E.6–E.9 xanh trước Phase L/Q

**Deliverables**: `packages/core/src/service/workspace-mutation-coordinator.ts` · `packages/core/src/port/ports.ts` (thêm 2 port) · `packages/adapter/src/fs/project-directory.ts`

---

## Phase G: RenderRootPort + orphan reclaim

**Addresses**: R6.7b · **Design**: §5.9, Decision 7
**Prerequisite**: F
**Estimate**: 10 SP

**Tasks**:
- [ ] G.1 `RenderRootPort.acquire/release` + `FsRenderRootAdapter`
  - `mkdir <stagingRoot>/<jobId>/` + marker `.vidcom-render-owner` `{jobId, createdAt}`; `environment` trả `TEMP`/`TMP`/`HYPERFRAMES_FFMPEG_PATH`/`HYPERFRAMES_FFPROBE_PATH`
  - _Requirements: R6.7b_ — _Design: §5.9, Finding 3_
- [ ] G.2 `reclaimOrphans` — **bốn** điều kiện đồng thời
  - dưới staging root · marker + `jobId` hợp lệ · quá `RENDER_WORKDIR_ORPHAN_GRACE_SECONDS = 3600` · job không chạy
  - **MUST NOT** quét `TEMP` chung — xoá theo pattern tên có thể xoá workdir của `hyperframes` do người dùng tự chạy
  - Trả **số đã xoá + lỗi**; thất bại im lặng ở đường dọn rác là cách leak quay lại mà không ai biết
  - _Requirements: R6.7b_ — _Design: Decision 7_
- [ ] G.3 Recovery lúc khởi động chạy **hai việc độc lập**
  - `recoverStale` (đã có) và `reclaimOrphans` (mới). Cái thứ hai không phụ thuộc cái thứ nhất — một root có thể mồ côi trong khi job của nó đã kết thúc sạch, nếu `release` từng thất bại
  - _Requirements: R6.7b_ — _Design: §4.4.2_

**Tasks — Tests**:
- [ ] G.4 Integration: `release` lỗi → `cleanupPending: true`, recovery thu hồi sau
- [ ] G.5 Integration: root thiếu **bất kỳ** một trong bốn điều kiện → **không** bị xoá (4 test, mỗi điều kiện một ca)
- [ ] G.6 Test khoá giá trị `RENDER_WORKDIR_ORPHAN_GRACE_SECONDS = 3600`

**Deliverables**: `packages/core/src/port/ports.ts` (thêm `RenderRootPort`) · `packages/adapter/src/fs/render-root.ts`

---

## Phase H: RemoteAssetGuard runtime — CSP + observer

**Addresses**: R6.15, R6.15b · **Design**: §5.10, Decision 11
**Prerequisite**: C, F
**Estimate**: 16 SP
**Read first**: spike [`runtime-media-csp-guard.mjs`](../../../../spikes/phase-3-detailed-design/runtime-media-csp-guard.mjs) · [`runtime-external-observer.mjs`](../../../../spikes/phase-3-detailed-design/runtime-external-observer.mjs)

**Tasks**:
- [ ] H.1 Inject CSP làm phần tử **đầu tiên** của `<head>`
  - `img-src 'self' data: blob:` + `media-src 'self' data: blob:`, trước **mọi** node tác giả có thể chạy
  - _Requirements: R6.15_ — _Design: §5.10_
- [ ] H.2 Listener `securitypolicyviolation` → callback loopback nonce-bound
  - Chỉ bind loopback; token ngẫu nhiên theo job, **không log**; payload phải khớp job đang chạy; server đóng trong `finally`
  - Token **không** one-shot — một render có thể có nhiều report; chống replay bằng lifecycle ngắn + dedupe
  - _Requirements: R6.15_ — _Design: §5.10, Decision 11_
- [ ] H.3 `PerformanceObserver` cho external dependency
  - `{type:"resource", buffered:true}`, chỉ nhận initiator `script|link|css|font`, **loại chính callback URL**, dedupe theo `(initiatorType,url)`, cap 100 entry/job
  - Probe đầu tiên đã tự tạo vòng lặp feedback — các điều kiện này là safety contract, không phải tối ưu
  - _Requirements: R6.15b_ — _Design: §5.10_
- [ ] H.4 Guard đóng **trước publish**
  - Violation → bỏ staging artifact + fail `remote_asset_not_local`. Artifact của HyperFrames luôn là staging cho tới khi callback đóng và report media rỗng
  - _Requirements: R6.15_ — _Design: §4.3.2_

**Tasks — Tests**:
- [ ] H.5 Integration: `new Image()` tạo bằng JS lúc runtime bị chặn; asset server nhận **0 byte** request
- [ ] H.6 Integration: script external tạo động được observer ghi **đúng một lần**; callback URL **không** tự xuất hiện; >100 entry bị cap
- [ ] H.7 Golden: document injection (CSP + bootstrap) — contract cần chạy lại khi bump HyperFrames

**Acceptance Criteria**:
- [ ] Tài liệu và code **không** phát biểu "chặn mọi remote media" — câu đúng là "chặn remote media **do document khai**". Lỗ `blob:` + `connect-src` là D8/Giai đoạn 4
- [ ] `externalDependencies` tới client **kể cả khi render thành công**

**Deliverables**: `packages/core/src/service/remote-asset-guard.ts` · `packages/adapter/src/hyperframes/document.ts` (injection) · `packages/adapter/src/runtime/guard-callback-server.ts`

---

## Phase I: Render job

**Addresses**: R6 · **Design**: §5.8, §4.3.2, Decision 6, 8
**Prerequisite**: B, D, F, G, H
**Estimate**: 16 SP

**Tasks**:
- [ ] I.1 `BinaryProbe` — **bốn** binary
  - `hyperframes` (resolve qua `require.resolve` + `process.execPath`, **không** qua PATH), Chromium, FFmpeg, FFprobe
  - `render_binary_missing` mang `details.missing: string[]` — nêu **từng** binary, MUST NOT gộp thành "render failed"
  - Version lệch minor+ → warning `engine_version_drift`
  - _Requirements: R6.12_ — _Design: §4.6, §8.2_
- [ ] I.2 `createRenderJobHandler`
  - `maxAttempts: 1` + `idempotent: false` (output không byte-deterministic nên retry sinh artifact thứ hai cho một yêu cầu)
  - Không hai render cùng project song song — dùng `nextQueued(types, excluded)` **đã có**
  - _Requirements: R6.8, R6.11_ — _Design: §5.8_
- [ ] I.3 Gate trạng thái trước enqueue
  - `empty` → `no_composition` · 0 scene → `no_scenes` · `invalid` → `project_invalid`
  - _Requirements: R6.2b, R6.2c_ — _Design: §4.3.2_
- [ ] I.4 `bestEffort` mặc định `true`
  - Warning vào **job metadata VÀ tới client**, không chỉ stdout; `bestEffort: false` fail bằng **mã ổn định**, không phải message
  - _Requirements: R6.14_ — _Design: Decision 8_
- [ ] I.5 Publish qua `mutateDerived`
  - `renders/<name>.mp4` + sidecar; **KHÔNG** làm `sourceRevision` tiến
  - _Requirements: R4.4_ — _Design: §4.3.2_

**Tasks — Tests**:
- [ ] I.6 Integration: `authored` + 0 scene → render **từ chối** (đối chiếu J.6 và M.5 — ba đường khác nhau có chủ đích)
- [ ] I.7 Integration: thiếu từng binary → `details.missing` nêu đúng tên
- [ ] I.8 Integration: crash render → artifact **không** công bố **và** render root nhận diện được là orphan theo 4 điều kiện
- [ ] I.9 Integration: cancel render → descendant = 0 **trước khi** status thành `cancelled`

**Deliverables**: `packages/worker/src/render-job.ts`

---

## Phase J: Snapshot job

**Addresses**: R7 · **Design**: §5.11, §6.3.2, Decision 13
**Prerequisite**: I
**Estimate**: 13 SP
**Read first**: spike [`s3b-at-failure-modes.mjs`](../../../../spikes/phase-3-checklist-gate/s3b-at-failure-modes.mjs) — ba lỗ của CLI

**Tasks**:
- [ ] J.1 Một invocation cho cả tập scene
  - `hyperframes snapshot --at <m1>,<m2>,…,<mN> --no-end --describe false --output <staging>` qua cùng `ProcessSupervisorPort`
  - Chỉ nhận PNG; bỏ `contact-sheet.jpg` CLI tự sinh
  - _Requirements: R7.4_ — _Design: Decision 13_
- [ ] J.2 Map output → scene **theo timestamp**, không theo ordinal
  - Parse token `-at-<t>s` trong tên file, so **theo số** (`1.0`→`1s`, `1.5`→`1.5s`, `-5.0`→`at--5s`)
  - Lý do: timestamp không parse được bị CLI **bỏ im lặng**, làm ordinal dịch — `01` sẽ trỏ vào midpoint thứ ba
  - _Requirements: R7.9_ — _Design: §5.11_
- [ ] J.3 Hai tiền điều kiện VidCom **phải tự làm**
  - Validate `0 <= t <= rootDuration`: CLI trả **frame** cho `999` và `-5`, không trả lỗi
  - Dedupe midpoint trước khi gửi, rồi fan-out kết quả cho mọi scene chia sẻ midpoint
  - _Requirements: R7.9_ — _Design: §5.11_
- [ ] J.4 Terminal `partial` + `partialAtSourceRevision`
  - `computedAtSourceRevision` **null** khi partial; contact sheet **chỉ** khi complete
  - Phạm vi sinh lại theo bảng R7.9c: so `sourceRevision` với `partialAtSourceRevision`, tính lại danh sách scene trước
  - _Requirements: R7.9b, R7.9c_ — _Design: §5.11, §6.3_
- [ ] J.5 Ghép contact sheet deterministic **sau khi** mọi scene của generation hiện tại đủ, publish như một derived composite

**Tasks — Tests**:
- [ ] J.6 Integration: `authored` + 0 scene → snapshot **thành công rỗng**
- [ ] J.7 Integration: partial → retry **cùng** revision (chỉ scene thiếu) **và** retry **khác** revision (toàn bộ) — đường (b) là chỗ sai im lặng
- [ ] J.8 Integration: một midpoint bị CLI bỏ **không** làm scene sau bị gán nhầm ảnh
- [ ] J.9 Integration: midpoint quá `rootDuration` hoặc âm bị **VidCom** từ chối trước khi spawn
- [ ] J.10 Golden: mapping ordinal↔timestamp — chạy lại khi bump HyperFrames

**Deliverables**: `packages/worker/src/snapshot-job.ts`

---

## Phase K: Workspace resolve/scan/identity/state store

**Addresses**: R1, R3, R4 · **Design**: §5.2, §5.3, §5.5, §5.6, §6.2, §6.3
**Prerequisite**: D
**Estimate**: 21 SP

**Tasks**:
- [ ] K.1 `scanWorkspace` — quét **một cấp**
  - Bỏ qua `node_modules`, `.git`, `.hyperframes`, mọi dir bắt đầu bằng `.`
  - Phân loại: `authored` / `empty` / `invalid(identity)` / `invalid(composition)` / `candidate` / bỏ qua
  - Cache **hai tầng** theo `(path, mtime, size)`: metadata và parse tách riêng
  - _Requirements: R1.9, R1.12_ — _Design: §5.2, §9.1_
- [ ] K.2 `EntryRegistry` — **không có bảng**
  - `mint` idempotent theo `(workspaceRoot, slug)`; `resolve`; `revoke` khi identity phục hồi; `clear` khi đổi workspace
  - Persist nó là tạo định danh bền **thứ hai** song song `ProjectId`
  - _Requirements: R1.2c-iii, R1.13_ — _Design: §5.3, Decision 2_
- [ ] K.3 `ProjectIdentityService` — `vidcom.json` schema v1
  - Zod strict: key lạ → lỗi nêu **tên field**, không nêu giá trị; parse lỗi → **KHÔNG** ghi đè
  - `schemaVersion` cao hơn binary → từ chối mở, MUST NOT đọc theo schema cũ
  - `serialize` byte-deterministic: key ổn định, indent 2, newline cuối
  - _Requirements: R3.1, R3.3, R3.7, R3.9_ — _Design: §5.5, §6.2_
- [ ] K.4 Backfill `platform` lazy khi mở project
  - Không phải batch migration; idempotent (đọc lại thấy có `platform` thì bỏ qua); đi qua `WriteAuthority` có journal
  - Ba project prototype (`kinetic-type`, `swiss-grid`, `warm-grain`) hiện chỉ có `{ id }` và là test case thật
  - _Requirements: R3.4_ — _Design: §6.5_
- [ ] K.5 `ProjectStateStore` — sở hữu toàn bộ `.vidcom/`
  - `ensure` (cấu trúc + `.gitignore`) · `writeState`/`writeContext` qua `mutateDerived` · append `.jsonl` atomic (không qua transaction) · `pruneLogs` · `reconcile` **một chiều** SQLite → `.vidcom`
  - _Requirements: R4.1, R4.1b, R4.5, R4.7, R4.8b_ — _Design: §5.6, Decision 5_
- [ ] K.6 Định nghĩa **năm type còn thiếu shape** (Design §14 ghi nợ)
  - `RenderState`, `ProjectContext`, `JobLogLine`, `RevisionLogLine`, `StructuredLogLine`
  - Cả năm là payload nội bộ `.vidcom/`, không ràng buộc DB, không qua biên HTTP/MCP
  - _Requirements: R4.3, R4.5_ — _Design: §6.3, §14_
- [ ] K.7 `stale` **không** được lưu
  - Nó là phép so `computedAtSourceRevision < sourceRevision`. Cờ phải được ai đó cập nhật; phép so thì không thể lệch
  - _Requirements: R4.4b_ — _Design: §6.3_

**Tasks — Tests**:
- [ ] K.8 Integration: folder trống mở được (chặn đứng hiện tại)
- [ ] K.9 Integration: `cwd` có `vidcom.json` **lỗi** → mở đúng project đó ở `invalid`, **không** rơi xuống active
- [ ] K.10 Integration: active workspace bị xoá → **cảnh báo** nêu path cũ rồi fallback
- [ ] K.11 Integration: `entryId` từ workspace A **không** resolve sau khi đổi sang workspace B
- [ ] K.12 Integration: `.vidcom/.gitignore` → `git status` sạch sau khi mở project + chạy job; chỉ `project-context.md` được track
- [ ] K.13 Golden: `project-context.md` deterministic — **không** absolute path / timestamp / jobId
- [ ] K.14 Integration: **không có đường nào** từ `.vidcom/` ghi ngược vào SQLite; `reconcile` chỉ rebuild một chiều
- [ ] K.15 Perf: scan 100 project sinh tổng hợp — stat < 500 ms, parse cold < 2 s, warm < 100 ms

**Acceptance Criteria**:
- [ ] Perf task ở trên đạt cả ba ngưỡng; nếu không → **quay lại Design** (D9 đổi contract `WorkspaceEntry`), MUST NOT tự sửa trong implementation

**Deliverables**: `packages/core/src/usecase/scan-workspace.ts` · `packages/core/src/service/entry-registry.ts` · `packages/core/src/usecase/project-identity.ts` · `packages/core/src/service/project-state-store.ts`

---

## Phase L: ProjectLifecycle CRUD

**Addresses**: R5 · **Design**: §5.7, §4.4.1
**Prerequisite**: E, K
**Estimate**: 16 SP

**Tasks**:
- [ ] L.1 `create` — một composite mutation
  - `WriteAuthority.createProjectRoot` begin operation bền → dựng toàn bộ project trong **sibling staging dot-dir** → validate hash/schema → commit registration + **đúng một** revision + audit/event → atomic rename staging thành slug
  - `vidcom.json` chỉ xuất hiện trong final root cùng toàn bộ file còn lại. Crash trước rename để lại staging bị scanner bỏ qua
  - _Requirements: R5.1_ — _Design: §5.7_
- [ ] L.2 `adopt` — chỉ ghi `vidcom.json`, **MUST NOT** sửa file nội dung của người dùng
- [ ] L.3 `rename` — journal `{fromSlug,toSlug,projectId}` trước I/O → atomic directory rename → transaction cập nhật registration. Giữ nguyên `ProjectId`
- [ ] L.4 `remove` — backup **verify được TRƯỚC khi chạm đĩa** → journal → atomic rename sang quarantine dot-dir → transaction gỡ registration → dọn quarantine. **MUST NOT** recursive-delete live root trực tiếp
- [ ] L.5 `ProjectLocator` — nghiệp vụ chỉ nhận `ProjectId`; recovery nhận `entryId`
  - Tập operation nhận `entryId` phải **đóng ở đúng bốn** (R1.2c-iv)
  - _Requirements: R1.2c-iv_ — _Design: §5.7, Decision 2_

**Tasks — Tests**:
- [ ] L.6 Integration: create atomic — crash ở từng boundary không để final folder nửa vời
- [ ] L.7 Integration: adopt **không** sửa file người dùng (so hash trước/sau)
- [ ] L.8 Integration: rename giữ `ProjectId`; recovery nhìn old/new root, **không** mint ID mới
- [ ] L.9 Integration: delete có backup verify; job đang chạy chặn delete
- [ ] L.10 Integration: một tool nghiệp vụ **từ chối** `entryId` — tập đóng trên giấy không đủ

**Deliverables**: `packages/core/src/usecase/project-lifecycle.ts`

---

## Phase M: Diagnostics + Thumbnail

**Addresses**: R8, R9 · **Design**: §5.12, §5.13
**Prerequisite**: C, K
**Estimate**: 13 SP

**Tasks**:
- [ ] M.1 Đưa **4 cảnh báo hiện có** (VD-3) vào Core — **trích luật, không phải di chuyển module**
  - Design §5.13 nói chúng ở `src/lib`; **sai**. Vị trí thật, và hai trong bốn cái chỉ tồn tại dưới dạng số học trong JSX:

    | Lint | Ở đâu thật | Hình dạng công việc |
    |---|---|---|
    | stranded tween | [`timeline-elements.tsx:124-130`](../../../../src/components/studio/timeline-elements.tsx#L124-L130) | trích `reduce` ra hàm thuần ở Core |
    | element overrun | [`timeline-elements.tsx:205`](../../../../src/components/studio/timeline-elements.tsx#L205) | trích số học ra hàm thuần ở Core |
    | unresolved selector | field `unresolvedEffects` do parser sinh ([`types.ts:77`](../../../../packages/adapter/src/hyperframes/types.ts#L77)) | bọc field có sẵn thành Diagnostic |
    | empty scene | [`parse.ts:271`](../../../../packages/adapter/src/hyperframes/parse.ts#L271) | bọc điều kiện có sẵn thành Diagnostic |

  - Sau khi trích, component **phải** dùng lại hàm Core thay vì giữ bản sao — nếu không sẽ có hai nguồn sự thật cho cùng một cảnh báo, đúng thứ spec này đang cố loại bỏ
  - _Requirements: R9 VD-3_ — _Design: §5.13_ — _Vá executability #4_
- [ ] M.2 Thêm 4 diagnostic mới: `platform-mismatch`, `narration-overflow`, `missing-asset`, `no-composition`/`no-scenes`
- [ ] M.3 Tích hợp `hyperframes check` → `lint:<rule>`
  - Vắng mặt → `lintSourceAvailable: false` và **nêu rõ**, MUST NOT trả rỗng
  - _Requirements: R9.3, R9.4_ — _Design: §5.13, §8.2_
- [ ] M.4 `forEntry(entryId)` — đường recovery
  - **KHÔNG** gọi parser composition, **KHÔNG** ghi `.vidcom`; `computedAtSourceRevision` null
  - _Requirements: R9.1, R9.8d, R9.8e_ — _Design: §5.13_
- [ ] M.5 `ThumbnailResolver`
  - `seedKind: "slug"` **chỉ** cho `invalidKind: "identity"` — `entryId` đổi mỗi phiên nên dùng nó làm seed sẽ đổi màu card mỗi lần khởi động
  - _Requirements: R8.2b_ — _Design: §5.12_

**Tasks — Tests**:
- [ ] M.6 Integration: `authored` + 0 scene → diagnostics `no-scenes`
- [ ] M.7 Integration: `invalid` → diagnostics **vẫn chạy**, render/mutation từ chối `project_invalid` (bảng R1.2d, **từng dòng một test**)
- [ ] M.8 Integration: `check` vắng → cờ `lintSourceAvailable: false`, không rỗng
- [ ] M.9 Integration: đường `entryId` **không** ghi `.vidcom`
- [ ] M.10 Unit: seed theo `ProjectId` vs slug

**Deliverables**: `packages/core/src/usecase/diagnostics.ts` · `packages/core/src/usecase/thumbnail.ts`

---

## Phase N: Scene timing + narration cues (usecase)

**Addresses**: R10, R11 · **Design**: §5.14, §5.15
**Prerequisite**: C, D
**Estimate**: 13 SP

**Tasks**:
- [ ] N.1 **Mở rộng `createScene`** trong [`project-writes.ts:339`](../../../../packages/core/src/usecase/project-writes.ts#L339) — nhận `{ index, trackIndex? }` + ripple theo track, **một revision**
  - `createScene` và `setSceneTiming` **đã tồn tại**; tạo `usecase/scene-insert.ts` mới sẽ là đường ghi thứ hai cho cùng một thao tác (_Vá executability #9_)
- [ ] N.2 `empty → authored`: scene đầu tiên được chèn, root composition sinh **cùng revision**
- [ ] N.3 **Mở rộng `setSceneTiming`** ([`project-writes.ts:130`](../../../../packages/core/src/usecase/project-writes.ts#L130)) — `duration_overflow` mang `details.limitKind` (`runtime`|`root`) + `actualSeconds` + `maxSeconds` + `extendRootAllowed`
  - Client quyết định hiện nút gì bằng **field**, MUST NOT parse message
  - _Requirements: R10.5c_ — _Design: §8.2_
- [ ] N.4 Narration nhiều cue: một `<audio class="clip hf-narration">` cho mỗi cue, `data-start` từ document
  - Đi qua vùng `NarrationRecord` / `regenerateNarration` **đã có** ([`project-writes.ts:284`](../../../../packages/core/src/usecase/project-writes.ts#L284)), không dựng đường narration thứ hai
- [ ] N.5 Sửa **đúng một** cue → cue khác **không** bị stale

**Tasks — Tests**:
- [ ] N.6 Integration: ripple trên project **nhiều track** — track khác **không** dịch
- [ ] N.7 Integration: chèn scene đầu tiên → `empty → authored` trong một revision
- [ ] N.8 Integration: đọc sidecar một-cue cũ thành đúng một cue; nhiều `<audio>` đúng `data-start`

**Deliverables**: `packages/core/src/usecase/project-writes.ts` (mở rộng `createScene`, `setSceneTiming`, vùng narration) · `packages/core/src/usecase/narration-cues.ts` (đọc/ghi cue, mới)

---

## Phase Q: Agent-kit bundle + installer

**Addresses**: R13 · **Design**: §5.17, Decision 10
**Prerequisite**: E
**Estimate**: 21 SP
**Read first**: [`steering/14`](../../../steering/14-agent-kit-and-skills.md) (FULL) · [spike ma trận host](../../../../spikes/phase-3-agent-kit-host/README.md)

**Tasks**:
- [ ] Q.1 Nội dung agent-kit + build asset nhúng + manifest hash **trong binary**
  - MUST NOT là lock file trong workspace
  - _Requirements: R13_ — _Design: §4.6_
- [ ] Q.2 **Hai** manifest theo host — mapping do **bằng chứng**, không do quy ước
  - `codex` → `AGENTS.md` + `.agents/skills/**`, `link` **không expose**, recovery là `manual_merge`
  - `claude-code` → `CLAUDE.md` + `.claude/skills/**`, `link` append `@CLAUDE.vidcom.md` + `expectedContentHash`
  - _Requirements: R13.7-i_ — _Design: §5.17, Decision 10_
- [ ] Q.3 Sáu `FileState` + bốn outcome
  - `missing|current_pristine|current_modified|outdated|newer|foreign`; `newer` **không** bị hạ cấp
  - _Requirements: R13.9a_ — _Design: §5.17_
- [ ] Q.4 Suy `usableBy` từ **router native được discover**, không từ file chỉ dẫn chính
  - Cả hai host gọi được probe từ `vidcom/SKILL.md` dù file chỉ dẫn vắng mặt, nên `AGENTS.md` `foreign` **không** làm host `blocked` khi router còn nguyên
  - _Requirements: R13.9b, R13.9b-i_ — _Design: §5.17, Decision 10_
- [ ] Q.5 Boundary schema: discriminated union `.strict()`
  - Nhánh install dùng array `.min(1)` + unique host; field của nhánh khác bị **schema** từ chối, không phải code
  - `installationState.files`/`usableBy`/`recovery` có key **đúng bằng** selected-host set, không placeholder cho host không chọn
  - _Requirements: R12.9, R12.9-iii_ — _Design: §5.17, §7.2_
- [ ] Q.6 Ghi qua `mutateWorkspace` — audit `project_id = NULL`, **không** revision/backup

**Tasks — Tests**:
- [ ] Q.7 6 state per-file; `current_pristine`+`missing` → `installed`; mọi `current_pristine` → `already_installed`
- [ ] Q.8 Hai host `degraded` → **`partial`** không phải `blocked`
- [ ] Q.9 `AGENTS.md` rỗng-có-marker nhưng router native còn → **`degraded`**; router không parse/discover → `blocked`
- [ ] Q.10 `link` đổi Claude `usableBy` `degraded` → `ready`; `host: "codex"` bị `schema_invalid`
- [ ] Q.11 `hosts` rỗng → `schema_invalid`; chọn một host → file host kia **không** vào `expectedFiles`
- [ ] Q.12 Sync (AK-8): tool trong `AGENTS.md` ↔ Registry · tool skill tham chiếu tồn tại · router `/vidcom-*` có `SKILL.md`
- [ ] Q.13 Batch rollback: fail giữa chừng → restore mọi step, **không** revision

**Deliverables**: `packages/agent-kit/` · `usecase/agent-kit-install.ts`

---

## Phase O: HTTP routes

**Addresses**: R1, R5–R11, R13 · **Design**: §7.1
**Prerequisite**: I, J, K, L, M, N
**Estimate**: 16 SP

**Tasks**:
- [ ] O.1 Route workspace/project: `GET /v1/workspace` · `PUT /v1/workspace/active` (phát sự kiện đổi workspace cho `EntryRegistry.clear`) · `POST /v1/projects` · `POST /v1/projects/:slug/adopt` (slug vì candidate chưa có `ProjectId`) · `PATCH`/`DELETE /v1/projects/:id`
- [ ] O.2 Route job: `POST .../renders` · `POST .../snapshots` (cả hai `idempotencyKey`) · `GET /v1/jobs/:jobId` (gồm `partial`, `warnings`, `cleanupPending`) · `POST /v1/jobs/:jobId/cancel` (202, idempotent) · `GET /v1/jobs/:jobId/termination-proof`
- [ ] O.3 Route nội dung: diagnostics · scenes · scene timing · narration-cues (GET/PUT/PATCH với `expectedContentHash`)
- [ ] O.4 Route recovery `entryId`: diagnostics · thay identity · rename · delete (backup + confirmation/grant)
- [ ] O.5 `GET /v1/renders/:jobId/download` — Range + ETag
- [ ] O.6 `POST /v1/agent-kit/install`
- [ ] O.7 Error mapping theo §8.1 — giữ nguyên shape `ErrorDetail`, **không** thêm shape thứ hai

**Tasks — Tests**:
- [ ] O.8 Integration: HTTP và MCP gọi **cùng** usecase (MP-2) — không có đường thứ hai
- [ ] O.9 Integration: mã lỗi đúng status theo bảng §8.1
- [ ] O.10 Integration: SSE `job.progress`/`job.done` mang `partial` — assert **đúng shape payload**, không chỉ assert "có event": `payload` là `Record<string, unknown>` nên compiler không bảo vệ gì (_Vá executability #7_)

**Deliverables**: `packages/server/src/routes/*`

---

## Phase P: MCP tool surface

**Addresses**: R12 · **Design**: §5.16, §7.2
**Prerequisite**: O, Q
**Estimate**: 13 SP

**Tasks**:
- [ ] P.1 Bốn tool mới: `validate_project`, `start_snapshot`, `start_render`, `install_agent_kit`
- [ ] P.2 **Mở rộng** `get_job_status` đã có ở `registry/job-tools.ts`
  - Thêm `partial`, warnings, `cleanupPending`, outcome; poll có backoff
  - **MUST NOT** register tool thứ hai cùng tên
  - _Requirements: R12.1_ — _Design: §5.16_
- [ ] P.3 `tools/list` thứ tự **deterministic**; golden **cả hai era** phải cập nhật
- [ ] P.4 Tool không degrade được sang legacy thì **ẩn** khỏi `tools/list` legacy, **không** lỗi lúc gọi
- [ ] P.5 Audit: MCP tool ghi thêm `protocol_version`

**Tasks — Tests**:
- [ ] P.6 Contract: 5 tool × 2 era
- [ ] P.7 Golden `tools/list` cả hai era
- [ ] P.8 Union strict: field nhánh khác bị schema từ chối

**Deliverables**: `packages/mcp/src/registry/*`

---

## Phase R: Fixture audit Phase 1/2 — rủi ro im lặng

> Task riêng theo yêu cầu tường minh của Design (Decision 1 Implications, §15). **MUST NOT** gộp vào task đổi scanner.

**Addresses**: Decision 1 · **Design**: Decision 1, §15
**Prerequisite**: tất cả phase code
**Estimate**: 8 SP

**Tasks**:
- [ ] R.1 Liệt kê **mọi** fixture Phase 1/2 giả định "project = có `hyperframes.json` + `index.html`"
  - Rủi ro chính **không** phải viết code mới mà là fixture cũ **vẫn xanh trong khi hành vi đã khác**
  - _Design: Decision 1_
- [ ] R.2 Với từng fixture: quyết định giữ / sửa sang marker `vidcom.json` / xoá, ghi lý do
- [ ] R.3 Thêm test chứng minh định nghĩa **cũ** không còn được chấp nhận ở đường mới
- [ ] R.4 Rà `packages/adapter/src/fs/workspace-fs.ts:39-58` và mọi call site của định nghĩa cũ

**Acceptance Criteria**:
- [ ] Không còn hai định nghĩa "project tồn tại" cùng sống trong test suite

---

## Phase S: CI gate + contract matrix + release

**Addresses**: toàn spec · **Design**: §5.9, §11, §14
**Prerequisite**: tất cả
**Estimate**: 10 SP

**Tasks**:
- [ ] S.1 Đọc kết quả `process-supervision.yml` lần chạy đầu trên Linux + Windows
  - Ghi số vào [spike README](../../../../spikes/phase-3-checklist-gate/README.md): naive có leak không · PowerShell CIM tốn bao nhiêu ms · số sweep tới hội tụ
  - _Design: §5.9, §14_
- [ ] S.2 Đọc kết quả `s1f` render thật trên Windows
  - `chrome-headless-shell` trên Windows có tách process group không. Nếu có → cách sửa đã đúng. Nếu **không** → ghi là thuộc tính nền tảng, MUST NOT bỏ pha capture (một code path phải đúng ở mọi nơi)
  - _Design: §5.9_
- [ ] S.3 Nếu Windows vừa **không** có enumerator `ppid` vừa leak với naive → **quay lại Design §5.9**, không tự xử trong implementation
- [ ] S.4 Mở rộng `test:golden` sang golden mới của spec này (tiền lệ: Phase 2 từng bỏ sót)
- [ ] S.5 Cập nhật `verify-spec-test-paths.mjs` cho Verification Matrix mới
- [ ] S.6 Release gate: `typecheck` · `lint` · `test:boundaries` · `test` · `test:golden` · `test:schema-drift` · `test:mcp-contract` · `test:runtime-smoke` · `spike:process-supervision` — tất cả xanh trên **cả ba** OS

---

## Files Changed Summary

| File | Phase(s) | Changes |
|------|----------|---------|
| `package.json` | A | `hyperframes` sang `dependencies`; script `spike:process-supervision` (đã có) |
| `packages/contracts/src/dto.ts` | A | `partial`, `warnings`, `cleanupPending`, error/warning code |
| `packages/adapter/src/db/schema.ts` | B | +1 cột `revision`, table-rebuild `job`, +2 bảng workspace, +3 index |
| `packages/adapter/drizzle/` | B | migration mới — **không** phải `drizzle/` ở gốc (`drizzle.config.ts` `out`) |
| `packages/core/src/port/process-port.ts` | F | `ProcessSupervisorPort` + `ProcessTerminationProof` (`ProcessPort` cũ giữ nguyên) |
| `packages/adapter/src/runtime/node-process-runner.ts` | F | sửa bug `kill(-pid)` rò Chromium; `taskkill` awaited |
| `packages/adapter/src/runtime/process-supervisor.ts` | F | **mới** — ba pha + primitive theo OS |
| `packages/core/src/service/job-scheduler.ts` | F | cancel poll, `abortReason`, CAS settle, `partial` |
| `packages/core/src/domain/path-policy.ts` | C | hai purpose mới + exception hẹp |
| `packages/core/src/domain/workspace-resolver.ts` | C | bảng quyết định 8 dòng |
| `packages/cli/src/workspace-selection.ts` | C, O | call site thật của resolver + `active_workspace` qua `AppSettingsStore` |
| `packages/core/src/service/write-authority.ts` | D, E | `mutateSource`/`mutateDerived`/`mutateWorkspace` + 3 method lifecycle |
| `packages/adapter/src/db/journal.ts` | D | `latestSourceRevision`, prune K generation |
| `packages/adapter/src/db/job-store.ts` | A, F | `partial` vào `JobOutcome`; sửa 2 lỗi câm ở `finish`; trả rows-affected |
| `src/components/studio/timeline-elements.tsx` | M | dùng lại hàm lint đã trích ra Core, bỏ bản sao trong JSX |
| `packages/core/src/service/workspace-mutation-coordinator.ts` | E | **mới** |
| `packages/worker/src/render-job.ts` · `snapshot-job.ts` | I, J | file mới trong package **đã có**; `worker/src/index.ts` phải đăng ký hai job type |
| `packages/server/src/routes/*` | O | route mới + mở rộng |
| `packages/mcp/src/registry/*` | P | 4 tool mới + mở rộng `get_job_status` |
| `packages/agent-kit/` | Q | scaffold **đã có** (`prompts/.gitkeep`, `skills/.gitkeep`) — công việc là nội dung + manifest |

---

## Estimate — re-estimate theo yêu cầu Design §14

| Phase | SP | Ghi chú |
|---|---|---|
| A Baseline | 8 | |
| B Migration — GATE | 21 | table-rebuild + 2 bảng + rollback preflight |
| C Domain thuần | 18 | |
| D WriteAuthority — GATE | 21 | tách đôi + bảng suy purpose + prune |
| E Coordinator — GATE | 21 | Decision 4 là chỗ tốn code nhất |
| F Process supervision — GATE | 29 | ba pha + sửa scheduler + sửa bug đang có + 2 lỗi câm ở job-store (+3 sau vá executability) |
| G Render root | 10 | |
| H Runtime asset guard | 16 | |
| I Render job | 16 | |
| J Snapshot job | 13 | |
| K Workspace/identity/state | 21 | |
| L Project CRUD | 16 | |
| M Diagnostics + thumbnail | 16 | |
| N Scene + narration | 13 | |
| O HTTP | 16 | |
| P MCP | 13 | |
| Q Agent-kit | 21 | |
| R Fixture audit | 8 | rủi ro im lặng, không gộp |
| S CI + release | 10 | |
| **Tổng** | **~211** | +6 sau vá executability (F +3, M +3) |

**So với Goals (~190 SP)**: **+21**. Trong đó +6 đến từ vá executability — hai lỗi câm ở `job-store.finish` và việc trích lint khỏi JSX đều là công việc thật mà bản đầu của checklist đếm thiếu vì tin vào mô tả của Design thay vì đọc code. Tăng ở F (ba pha thay hai pha, cộng sửa bug đang tồn tại — Finding 11 phát hiện sau khi Goals ước lượng), D (tách `mutateSource`/`mutateDerived` + prune K generation), R (phase riêng thay vì gộp). Giảm ở chỗ bỏ native sidecar/toolchain MSVC (DG-1) và snapshot còn một invocation (Decision 13). Con số ~190 của Goals **không còn dùng lại được** theo hướng nào.

---

## Requirements Coverage Matrix

| Requirement | Covered by | Verified by |
|---|---|---|
| R1 workspace & marker | C.1, K.1, K.2 | C.7, K.8–K.11 |
| R2 preset platform | C.2 | C.8 |
| R3 `vidcom.json` | K.3, K.4 | K.3 golden, K.4 integration |
| R4 `.vidcom/` | D.1–D.5, K.5–K.7 | D.6–D.10, K.12–K.14 |
| R5 project CRUD | E.3, L.1–L.5 | L.6–L.10 |
| R6 render MP4 | F, G, H, I | F.14–F.21, G.4–G.6, H.5–H.7, I.6–I.9 |
| R6.6b-i/ii proof bounded | F.1, F.4, F.6 | F.15, F.16, F.17 |
| R7 snapshot | J.1–J.5, F.10, F.11 | J.6–J.10, F.20 |
| R8 thumbnail | M.5 | M.10 |
| R9 diagnostics | M.1–M.4 | M.6–M.9 |
| R10 scene/ripple | C.4, N.1–N.3 | C.10, N.6, N.7 |
| R11 narration cue | C.5, N.4, N.5 | N.8 |
| R12 MCP tool | P.1–P.5 | P.6–P.8 |
| R12.10b composite rollback | E.5 | E.6, E.7 |
| R13 agent-kit | Q.1–Q.6 | Q.7–Q.13 |
| Decision 1 fixture risk | R.1–R.4 | R.3 |

> Mọi goal xuất hiện ở đây, map tới ≥1 task và ≥1 test.

---

## Deferred Items Reference

| # | Issue | Effort | Dependency |
|---|---|---|---|
| D1 | Vendor GSAP/font, chặn network toàn phần | ~13 SP | Giai đoạn 4 đóng gói |
| D2 | Fingerprint per-scene cho snapshot | ~8 SP | Giai đoạn 5 |
| D3 | Expose workdir từ HyperFrames upstream | — | upstream |
| D4 | Tiến độ render qua kênh có contract thay vì stdout | ~5 SP | upstream |
| D5 | `entryId` bền qua restart | ~5 SP | khi có nhu cầu thật |
| D6 | Undo một lượt agent trên nhiều revision | ~13 SP | Giai đoạn 5 |
| D7 | Zero-survivor bằng Job Object (Windows) | ~13 SP | Giai đoạn 4 — cơ chế **đã PASS**, còn lại là đóng gói |
| D8 | Siết `connect-src`/bỏ `blob:` | ~8 SP | chung task với D1 |
| D9 | Scan hai pha nếu target 2 s không đạt | ~8 SP | chỉ khi K.15 đỏ |

Chi tiết: §13 [Detailed Design](./spec-project-delivery-loop-detailed-design.md).

---

## Execution Log

> Append một entry mỗi phiên làm việc.

_Chưa bắt đầu. Approval Gate đã `Approved` 2026-08-04, nhưng người dùng yêu cầu **chưa thực hiện code**. Entry đầu tiên sẽ được ghi khi Phase A bắt đầu._

Format:
```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [path/to/file.ts]
  - Summary: [đã làm gì]
  - Decisions: [lệch khỏi design — nếu material thì cập nhật detailed-design.md]
  - Blockers: [nếu có]
```
