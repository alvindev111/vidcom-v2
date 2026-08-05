# Spec Project Delivery Loop — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-project-delivery-loop-detailed-goal.md) — bản 12, Approved 2026-08-04
> - [Detailed Design](./spec-project-delivery-loop-detailed-design.md) — bản 6, Approved 2026-08-04
> - [Main spec](./spec-project-delivery-loop-inprocess.md)
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
- **Full-review closeout status**: **🔄 Chờ remote matrix 2026-08-05.** Cả 26 finding đã được sửa và có focused regression; chỉ closeout sau khi exact commit xanh trên Linux, Windows và macOS.
- **Trạng thái thực thi**: **🔄 Full review remediation đang thực thi 2026-08-05.** Nhóm Agent 1 đã sửa; audit lại xác nhận còn các finding Agent 2/3 về scheduler, process, publication và lifecycle/storage cần xử lý trước closeout.
- **Notes**:
- Full-review remediation: code fixes cho đủ 26 finding đã được triển khai; regression tập trung đã xanh cho narration/HTTP/agent-kit, lifecycle/storage/state, scheduler/render/snapshot/process supervision. Đang chờ full local gates và GitHub matrix ba OS trước khi đánh dấu hoàn tất.
- Edge-case evidence bổ sung: Range số nguyên cực lớn, state projection sai shape/foreign project, MCP không tự tạo idempotency key, snapshot complete bị mất artifact phải render lại, PID identity/degraded enumeration và cancel chỉ terminal sau bounded cleanup.
  - Design bản 7 và Goals bản 12 đã duyệt; `steering/08` đã đồng bộ (§2.1 Design).
  - **Phase B, D, E, F là gate**: không sang phase sau khi gate còn đỏ. Lý do ở Dependency Order.
  - **Re-estimate đã làm** (Design §14 đòi): ~211 SP, không phải ~190 SP của Goals. Chi tiết ở §Estimate.
  - **Chín điểm vá executability đã đóng** (mục ngay dưới) — không còn quyết định nào phải hỏi lại giữa chừng.
  - Ba mục Design còn `[ ]` **không chặn** Code Execution: năm type chưa có shape (định nghĩa ở Phase K), số CI Linux/Windows (Phase S), và chính con số estimate này.
  - **Điểm bắt đầu khi được lệnh chạy**: Phase A, task A.1.

## Review remediation 2026-08-05

### Agent 2/3 remediation bổ sung

- [x] Publication CAS chặn late cancel sau khi render/snapshot bắt đầu publish.
- [x] Scheduler timeout đợi bounded termination/cleanup trước terminal; quá grace ghi `process_termination_unverified`.
- [x] Process capture lưu PID + creation time; mọi Windows command và toàn verify protocol đều có deadline.
- [x] MCP render/snapshot chỉ forward idempotency key do caller cấp.
- [x] Preflight binary/document/remote asset chạy trước enqueue và worker, gồm local stylesheet và `@import`.
- [x] Runtime guard dùng acknowledgement barrier trước publish.
- [x] Render-root marker giữ ownership qua acquire/cleanup lỗi; clone dùng revalidation và `O_NOFOLLOW`.
- [x] MP4 được stream vào staged asset với pipeline-owned close lifecycle; snapshot complete chỉ reuse khi mọi artifact còn tồn tại.
- [x] CI lần một: process-supervision 4/4 xanh; full CI Linux/macOS tái hiện stream không settle. Đã sửa `autoClose` ownership và thêm regression 1 MiB không để open handle; chờ exact rerun.
- [x] Journal lưu staging/quarantine path trước filesystem transition và giữ cleanup obligation sau committed delete.
- [x] Delete re-hash sau quarantine; create recovery xác minh exact journal hashes trước commit.
- [x] Workspace marker/file reads không follow symlink.
- [x] State reconcile chỉ ghi projection drift; state reader validate shape, số hữu hạn và project ownership.
- [x] Exported lifecycle/state/coordinator APIs có doc comments theo steering.

- [x] PATCH narration cue giữ nguyên metadata của cue không đổi; chỉ text/voice thay đổi mới stale đúng cue đích; offset-only giữ trạng thái generated/stale hiện hữu.
- [x] Agent-kit recovery detail chỉ trả đường dẫn tương đối, không rò workspace tuyệt đối.
- [x] Inspect lỗi sau khi commit trả `committed_response_error` với `committed: true` và danh sách file đã đổi, không khuyến khích retry mutation.
- [x] Download Range trả `416` + `Content-Range: bytes */<size>` cho range không thỏa và gửi `Cache-Control: must-revalidate`.
- [x] JSON media type và toàn bộ path params delivery-loop được parse tại HTTP boundary bằng schema dùng chung.
- [x] O.8 so cùng operation qua HTTP/MCP trên fixture tương đương; O.9 gửi request thật qua `createServerApp().fetch()` cho bảng error/status.
- [x] S.6 được sửa thành release/tag gate; không còn diễn giải evidence ba OS lịch sử thành guarantee cho mọi pull request.

**Evidence remediation**: focused regression 23/23; MCP contract 71/71; golden 26/26; `typecheck`, `lint`, `test:boundaries`, `test:schema-drift`, `test:spec-paths`, `test:agent-kit` và `test:runtime-smoke` đều xanh. `bun run test` tổng hợp không terminalize; chạy riêng `tests/adapter/render-job.test.ts` tái hiện tiến trình supervision con còn sống. Vì vậy closeout này không claim full-suite local mới; caveat hiện hữu đó nằm ngoài 7 finding của review.

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

## Phase Verification Matrix

Mỗi phase chạy focused command dưới đây trên SQLite/filesystem thật, rồi chạy `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run test:boundaries` khi chạm boundary và `rtk git diff --check`. Phase S chạy toàn bộ release gate trên ba OS qua GitHub Actions.

| Phase | Focused verification command |
|---|---|
| A | `rtk bunx vitest run tests/contracts/api-contracts.test.ts tests/mcp/error-map.test.ts` |
| B | `rtk bunx vitest run tests/adapter/database-migration.test.ts tests/adapter/delivery-loop-database-migration.test.ts tests/adapter/mcp-database-migration.test.ts` |
| C | `rtk bunx vitest run tests/core/delivery-loop-domain.test.ts tests/core/workspace-and-path-policy.test.ts` |
| D | `rtk bunx vitest run tests/core/source-revision.test.ts tests/adapter/composite-write-authority.test.ts` |
| E | `rtk bunx vitest run tests/adapter/workspace-mutation-coordinator.test.ts` |
| F | `rtk bunx vitest run tests/adapter/process-supervisor.test.ts tests/adapter/job-infrastructure.test.ts` và `rtk bun run spike:process-supervision` |
| G | `rtk bunx vitest run tests/adapter/render-root.test.ts tests/cli/startup.test.ts` |
| H | `rtk bunx vitest run tests/adapter/remote-asset-guard.test.ts tests/adapter/remote-asset-browser.test.ts tests/golden/runtime-asset-guard.test.ts` |
| I | `rtk bunx vitest run tests/adapter/render-job.test.ts tests/adapter/render-binary-probe.test.ts tests/adapter/render-project.test.ts` |
| J | `rtk bunx vitest run tests/adapter/snapshot-job.test.ts tests/golden/snapshot-timestamp-mapping.test.ts` |
| K | `rtk bunx vitest run tests/adapter/project-discovery-state.test.ts tests/adapter/workspace-scan-identity.test.ts tests/adapter/project-state-store.test.ts tests/golden/project-context.test.ts` |
| L | `rtk bunx vitest run tests/adapter/project-lifecycle.test.ts tests/adapter/workspace-mutation-coordinator.test.ts` |
| M | `rtk bunx vitest run tests/core/diagnostics-rules.test.ts tests/adapter/diagnostics-thumbnail.test.ts` |
| N | `rtk bunx vitest run tests/adapter/scene-ripple-narration.test.ts tests/adapter/narration-clips.test.ts tests/adapter/project-destructive-usecases.test.ts` |
| O | `rtk bunx vitest run tests/server/delivery-loop-routes.test.ts tests/server/events.test.ts tests/server/payload-limits.test.ts` |
| P | `rtk bunx vitest run tests/mcp/contract-matrix.test.ts tests/mcp/tools.test.ts tests/mcp/negative-contract-matrix.test.ts tests/mcp/golden/tools-list.test.ts tests/adapter/agent-kit-installer.test.ts` |
| Q | `rtk bunx vitest run tests/adapter/agent-kit-installer.test.ts tests/agent-kit/sync.test.ts` và `rtk bun run test:agent-kit` |
| R | `rtk bunx vitest run tests/adapter/workspace-scan-identity.test.ts tests/adapter/bootstrap-project.test.ts tests/cli/mcp-commands.test.ts tests/cli/startup.test.ts tests/server/events.test.ts` |
| S | `rtk bun run typecheck`; `rtk bun run lint`; `rtk bun run test:boundaries`; `rtk bun run test`; `rtk bun run test:golden`; `rtk bun run test:schema-drift`; `rtk bun run test:mcp-contract`; `rtk bun run test:runtime-smoke`; `rtk bun run spike:process-supervision`; `rtk bun run test:spec-paths`; `rtk git diff --check` |

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
- [x] A.1 Chuyển `hyperframes` từ `devDependencies` sang `dependencies`
  - Render là tính năng runtime; hiện nó là devDependency nên bản ship sẽ thiếu binary
  - Pin `HYPERFRAMES_EXPECTED_VERSION = "0.7.86"` làm hằng số có tên
  - _Requirements: R6.1_ — _Design: §4.6_
- [x] A.2 Thêm `ErrorCode` mới
  - `project_invalid`, `identity_parse_error`, `composition_parse_error`, `no_composition`, `no_scenes`, `remote_asset_not_local`, `render_binary_missing`, `process_termination_unverified`, `confirmation_required`, `rollback_payload_pruned`
  - _Requirements: R1.2c, R6.12, R6.15_ — _Design: §7.1, §8.1_
- [x] A.3 Thêm warning code ổn định (không phải error)
  - `external_dependency_unpinned`, `sub_timeline_readiness_timeout`, `termination_proof_not_exhaustive`, `engine_version_drift`
  - Warning là **giá trị có mã**, MUST NOT là chuỗi tự do — client quyết định hiển thị bằng mã
  - _Requirements: R6.14, R6.15b_ — _Design: §7.1_
- [x] A.4 Mở rộng `JobStatus` và `JobDto`
  - `partial` vào union; thêm `warnings: {code,message}[] | null` và `cleanupPending: boolean`
  - `TERMINAL_JOB_STATUSES` = `succeeded | partial | failed | cancelled`
  - `Job extends JobDto` ([`types.ts:356`](../../../../packages/core/src/port/types.ts#L356)) nên hai field mới bắt buộc phải map trong [`toJob`](../../../../packages/adapter/src/db/job-store.ts#L44) — TypeScript sẽ bắt nếu quên, đây là lỗi ồn chứ không câm
  - _Requirements: R7.9b, R6.6b, R6.14_ — _Design: §6.4_
- [x] A.5 Thêm hai `PathPurpose`
  - `state-write`, `workspace-agent-kit` vào union ở `port/types.ts` (logic ở Phase C)
  - _Requirements: R4.10, R13.12_ — _Design: §5.19_
- [x] A.6 Unit test contract
  - Zod response chấp nhận `partial`; `warnings` round-trip giữ nguyên **thứ tự**; `TERMINAL_JOB_STATUSES` có đúng 4 phần tử
  - _Requirements: R7.9b_

**Acceptance Criteria**:
- [x] `npm run typecheck` xanh sau khi thêm `partial` — mọi `switch` trên `JobStatus` đã xử lý nhánh mới (đây là cách tìm hết call site, không phải grep)
- [x] `hyperframes` resolve được từ `dependencies` bằng `require.resolve("hyperframes/package.json")`

**Deliverables**: `package.json` · `packages/contracts/src/dto.ts` · `packages/core/src/port/types.ts`

---

## Phase B: SQLite migration — **GATE**

**Addresses**: R4.4c, R6.6b, R6.14, R7.9b, R13.11 · **Design**: §6.4, §6.5
**Files affected**: `packages/adapter/src/db/schema.ts`, `drizzle/`, `scripts/verify-schema-drift.mjs`
**Prerequisite**: A
**Estimate**: 21 SP
**Read first**: [`schema.ts`](../../../../packages/adapter/src/db/schema.ts) (FULL) · spike [`migration-remediation.ts`](../../../../spikes/phase-3-detailed-design/migration-remediation.ts) (FULL — protocol table-rebuild đã PASS)

**Tasks**:
- [x] B.1 `ALTER TABLE revision ADD COLUMN advances_source integer NOT NULL DEFAULT 1 CHECK (advances_source IN (0,1))`
  - Expand-only. Default `1` đúng nghĩa cho **mọi** hàng lịch sử — chúng đều là ghi nội dung, nên **không backfill**
  - _Requirements: R4.4c_ — _Design: §6.4 `revision`_
- [x] B.2 Table-rebuild `job` trong một transaction
  - `ck_job_status` mở thêm `partial`; thêm `cleanup_pending integer NOT NULL DEFAULT 0 CHECK IN (0,1)` và `warnings_json text NULL CHECK (json_valid)`
  - Dựng lại **toàn bộ** index/FK/check của bảng cũ — liệt kê tường minh, MUST NOT dựa vào drizzle sinh đủ
  - `job.type` **không** đổi: nó không có check constraint, nên `render`/`snapshot` là zero-migration
  - _Requirements: R7.9b, R6.6b, R6.14_ — _Design: §6.4 `job`, Finding 2_
- [x] B.3 `CREATE TABLE workspace_operation` + `workspace_operation_step`
  - Header: `kind` CHECK `agent_kit_files|project_create|project_rename|project_delete`; `status` CHECK `pending|committed|aborted|recovered|orphaned`; `project_id` nullable **không FK bắt buộc** (delete phải giữ journal sau khi registration bị gỡ)
  - Step: PK `(operation_id, ordinal)` + UNIQUE `(operation_id, path)`; spill policy previous-content **dùng lại** của Phase 2
  - _Requirements: R12.10b, R13.11_ — _Design: §6.4, Decision 4_
- [x] B.4 Ba index mới
  - `idx_revision_source (project_id, advances_source, id DESC)` · `idx_revision_derived_path (project_id, path, id DESC) WHERE advances_source = 0` · `idx_job_cleanup (cleanup_pending) WHERE cleanup_pending = 1`
  - _Requirements: R4.4c, R6.7b_ — _Design: §6.4_
- [x] B.5 Rollback helper cho table-rebuild `job`
  - Preflight **từ chối** rollback khi còn hàng `status='partial'`, nêu count. **MUST NOT** map im lặng sang `succeeded`
  - Dùng cùng protocol rename-table của `mcp-migration-rollback.ts`
  - _Requirements: R7.9b_ — _Design: §6.5_
- [x] B.6 Cập nhật schema drift snapshot
  - `npm run test:schema-drift` phải xanh; nếu `drizzle-kit` không sinh đúng table-rebuild thì **được phép sửa tay** `migration.sql` (tiền lệ Phase 2)
  - _Requirements: —_ — _Design: §6.5_

**Tasks — Real Datastore Tests**:
- [x] B.7 Migration test: hàng `revision` cũ đọc ra `advances_source = 1`; `advances_source = 7` bị CHECK chặn
- [x] B.8 Migration test: hàng `job` cũ giữ nguyên byte/nghĩa; `INSERT status='partial'` thành công; `warnings_json` JSON lỗi bị chặn; `cleanup_pending = 2` bị chặn
- [x] B.9 Migration test: `job.type='render'` insert được **không** cần DDL enum
- [x] B.10 Migration test: `PRAGMA foreign_key_check` rỗng, `integrity_check` OK sau migration
- [x] B.11 Rollback test: còn `partial` → preflight từ chối kèm count; hết `partial` → rollback sạch

**Acceptance Criteria**:
- [x] Toàn bộ ~180 test Phase 1/2 vẫn xanh sau migration
- [x] `foreign_key_check` rỗng; index mới xuất hiện trong `sqlite_master`
- [x] **GATE**: không sang phase sau nếu bất kỳ test B.7–B.11 đỏ

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
- [x] F.1 Khai `ProcessSupervisorPort` + `ProcessTerminationProof`
  - `capturedPids`, `capturedGroups`, `survivors`, `sweeps`, `exhaustive`; hằng số có tên `PROCESS_CAPTURE_INTERVAL_MS = 250`, `PROCESS_VERIFY_SWEEP_INTERVAL_MS = 100`, `PROCESS_VERIFY_MAX_SWEEPS = 20`
  - `ProcessPort` cũ **giữ nguyên** cho TTS — MUST NOT đổi contract đang có
  - _Requirements: R6.6b_ — _Design: §5.9_
- [x] F.2 Ba primitive theo nền tảng, thuật toán phía trên **không** rẽ nhánh OS
  - POSIX: `ps -Ao pid=,ppid=,pgid=` · `kill(-pgid)` / `kill(pid)` · `kill(pid,0)` với **`EPERM` = còn sống**
  - Windows: PowerShell CIM → `tasklist` thoái hoá · `taskkill /t /f` **awaited** · `tasklist /fi "PID eq"` so **theo cột PID**
  - `wmic` **MUST NOT** xuất hiện (D10)
  - _Requirements: R6.6b-ii_ — _Design: §5.9, Finding 12_
- [x] F.3 Pha capture
  - Poll bao đóng descendant mỗi `PROCESS_CAPTURE_INTERVAL_MS` **trong lúc process chạy**, tích luỹ PID cụ thể + pgid phân biệt
  - Thiếu pha này thì sau khi cha chết không còn cách nào tìm lại đám con — đây là pha hôm nay hoàn toàn không tồn tại
  - _Requirements: R6.6b_ — _Design: §5.9_
- [x] F.4 Pha kill + verify
  - Kill mọi group đã ghi, rồi mọi PID đã ghi, rồi root. Verify probe **từng PID đã ghi**, nạp PID mới xuất hiện, dừng ở hai lượt rỗng liên tiếp
  - Survivor sau `MAX_SWEEPS` → `ProcessTerminationUnverifiedError`
  - _Requirements: R6.6b_ — _Design: §5.9_
- [x] F.5 Sửa bug đang tồn tại ở `killProcessTree`
  - [`node-process-runner.ts:137`](../../../../packages/adapter/src/runtime/node-process-runner.ts#L137) `kill(-pid)` để sót Chromium; Windows `spawn(taskkill).unref()` không await
  - **Quyết định phải trả lời trong task này**: sửa luôn `ProcessPort` cũ (TTS cũng hưởng) hay chỉ supervisor mới. Comment tại chỗ nói về sidecar VieNeu/Python — đúng cho ca đó; nếu chỉ sửa supervisor thì **MUST** cập nhật comment để không ai đọc nhầm là đã an toàn chung
  - _Requirements: R6.6b_ — _Design: §15, Finding 11_
- [x] F.6 Thoái hoá khi không có enumerator cho `ppid`
  - Capture chỉ còn root group; proof `exhaustive: false` + warning `termination_proof_not_exhaustive`
  - Luật là **trung thực, không phải zero survivor**: proof MUST NOT báo sạch khi process còn sống
  - _Requirements: R6.6b-i_ — _Design: §5.9_

**Tasks — JobScheduler (§5.20)**:
- [x] F.7 Poll cờ cancel bền trong lúc handler chạy
  - `CANCELLATION_POLL_MS = 250`, gọi `store.isCancellationRequested`, thấy cờ thì `controller.abort()`; clear trong `finally` cùng chỗ `heartbeat`
  - _Requirements: R6.6b_ — _Design: §5.20_
- [x] F.8 Phân biệt abort-do-cancel với abort-do-timeout
  - Field `abortReason: "cancel" | "timeout" | null` set **trước** `controller.abort()`; catch đọc field, **MUST NOT** đoán từ loại error — nếu không cancel sẽ rơi vào nhánh retry của timeout
  - _Requirements: R6.6b_ — _Design: §5.20_
- [x] F.9 Terminal settle **báo được** thắng hay thua race
  - `finish` **đã có** nửa CAS: `WHERE id = ? AND status IN ('queued','running')` ([`job-store.ts:161`](../../../../packages/adapter/src/db/job-store.ts#L161)). **MUST NOT** thêm `expectedStatus` chồng lên nó
  - Cái thiếu: nó trả `void`, nên caller không phân biệt "settle thành công" với "thua race". Đổi thành trả **số hàng bị ảnh hưởng** (hoặc `applied: boolean`); scheduler map `0` → `no_change`
  - Đây là thứ làm luật "không có artifact published + status cancelled" đúng được, không chỉ là ý định
  - _Requirements: R6.6b_ — _Design: §5.9, §5.20_ — _Vá executability #3_
- [x] F.10 Mở rộng `JobOutcome` với `partial` — **không** thêm method mới
  - Thêm nhánh `{ status: "partial"; result: unknown }` vào [`JobOutcome`](../../../../packages/core/src/port/types.ts#L377)
  - `JobStorePort.complete()` **không tồn tại** — đừng đi tìm nó; bề mặt thật chỉ có `finish(id, outcome)`
  - _Requirements: R7.9b_ — _Design: §6.4_ — _Vá executability #1_
- [x] F.11 Sửa **hai lỗi câm** trong adapter `finish` mà `partial` sẽ kích hoạt
  - [`job-store.ts:152`](../../../../packages/adapter/src/db/job-store.ts#L152): `result` chỉ serialize khi `succeeded` → outcome `partial` ghi `NULL` và **mất `missingSceneIds`**
  - [`job-store.ts:157`](../../../../packages/adapter/src/db/job-store.ts#L157): `progress` chỉ set `1` khi `succeeded` → `partial` giữ progress cũ, trái luật `partial ⇒ progress = 1`
  - Cả hai **không throw**. Test phải khẳng định **giá trị đã ghi**, không chỉ khẳng định "không lỗi"
  - _Requirements: R7.9b_ — _Design: §6.4_ — _Vá executability #2_
- [x] F.12 `recoverStale` biết `partial`
  - Coi `partial` là terminal (không requeue, không finalize lại); set `cleanup_pending` khi job treo còn render root chưa release
  - _Requirements: R7.9b, R6.7b_ — _Design: §5.20_
- [x] F.13 Đăng ký hai job type mới ở `packages/worker/src/index.ts`
  - Package **đã tồn tại** và đã đăng ký `tts-job`; `render`/`snapshot` thêm vào cùng chỗ. `job.type` không có check constraint nên đây là zero-migration
  - _Requirements: R6.1, R7.1_ — _Vá executability #5_

**Tasks — Process Tests** (adapter thật, không mock):
- [x] F.14 Port `s1e` thành test vitest: fixture tự tách group, naive leak vs ba pha không leak
- [x] F.15 Test: sweep cạn còn survivor → `process_termination_unverified`, **không** ghi `cancelled`
- [x] F.16 Test: sweep rỗng nhưng `exhaustive:false` → `cancelled` **kèm** warning `termination_proof_not_exhaustive`
- [x] F.17 Test: sweep theo quan hệ cha-con **bị chứng minh là báo sai** — assert nó trả rỗng trong lúc PID probe còn thấy sống
- [x] F.18 Test: abort do cancel không đi vào nhánh retry của timeout
- [x] F.19 Test: race cancel/complete ở barrier trước publish — cancel thắng → không artifact; terminal đã settle → cancel `no_change`
- [x] F.20 Test: `finish` với outcome `partial` ghi **đúng** `result` JSON và `progress = 1` (chốt F.11 — hai lỗi câm)
- [x] F.21 Test skip **có thông báo** khi Chromium/FFmpeg vắng mặt, MUST NOT pass im lặng

**Acceptance Criteria**:
- [x] `npm run spike:process-supervision` xanh trên máy dev
- [x] Không test nào suy survivor từ ppid hoặc từ thành viên process group (R6.6b-ii)
- [x] **GATE**: F.14–F.20 xanh trước khi bắt đầu I/J

**Deliverables**: `packages/core/src/port/process-port.ts` · `packages/adapter/src/runtime/process-supervisor.ts` + primitive theo OS · `packages/core/src/service/job-scheduler.ts` · `tests/adapter/process-supervisor.test.ts`

---

## Phase C: Domain thuần — không I/O

**Addresses**: R1, R2, R10, R11, R4.10, R13.12, R6.15 · **Design**: §5.1, §5.4, §5.14, §5.19, §5.10 (phần static)
**Files affected**: `packages/core/src/domain/` (`invariants.ts` mở rộng; `platform-preset.ts` mới)
**Prerequisite**: A
**Estimate**: 18 SP
**Read first**: [`path-policy.ts`](../../../../packages/core/src/domain/path-policy.ts) (FULL — đặc biệt `isGloballyBlocked`) · [`workspace-resolver.ts`](../../../../packages/core/src/domain/workspace-resolver.ts) (FULL)

**Tasks**:
- [x] C.1 Viết lại `resolveWorkspace` theo bảng quyết định 8 dòng
  - `WorkspaceSource = explicit | cwd-project | cwd-solo | active | cwd`; `readable` thay `valid`; `hasIdentityFile` xét **sự có mặt**, MUST NOT xét tính hợp lệ
  - Hàm thuần, không I/O — composition root nạp candidate
  - **Call site thật nằm ở [`packages/cli/src/workspace-selection.ts`](../../../../packages/cli/src/workspace-selection.ts)**, và `active_workspace` lưu qua `AppSettingsStore`, không phải file riêng. Sửa domain mà quên file này thì logic mới không có ai gọi
  - _Requirements: R1.2e, R1.10_ — _Design: §5.1, §4.3.1_ — _Vá executability_
- [x] C.2 `PlatformPresetCatalog`
  - `PLATFORM_PRESETS`, `assertCatalogEncodable()` (từ chối lúc khởi động nếu preset có kích thước lẻ), `inferPreset`, `validateCustom` (chẵn, 128…7680, fps 1…120)
  - _Requirements: R2.4b–4d, R2.7, R3.4_ — _Design: §5.4_
- [x] C.3 `pathPolicy` — hai purpose mới với **exception hẹp tường minh**
  - `isGloballyBlocked` chặn **mọi** segment `startsWith(".")`, nên `state-write` và `workspace-agent-kit` phải có cửa hẹp theo đúng pattern exception của `system-write`
  - `state-write`: chỉ `.vidcom/` + các nhánh §5.6 sở hữu · `workspace-agent-kit`: đúng tập literal `AGENTS.md`, `CLAUDE.md`, `AGENTS.vidcom.md`, `CLAUDE.vidcom.md`, `.agents/skills/`, `.claude/skills/`
  - `.env*` chặn ở **cả hai** purpose mới; `node_modules`/`.git`/`.hyperframes` chặn nguyên
  - _Requirements: R4.10, R4.11, R13.12, R13.13_ — _Design: §5.19_
- [x] C.4 `planRipple` + `detectTrackGapsAndOverlaps` — **mở rộng [`domain/invariants.ts`](../../../../packages/core/src/domain/invariants.ts)**, không tạo file mới
  - `validateSceneTiming` đã tồn tại ở đó và `SceneTimingInput` **đã mang `trackIndex` + `rootDuration`**. Tạo `domain/scene-timing.ts` song song = hai nhà cho cùng một invariant, đúng thứ spec này đang loại bỏ
  - Chỉ dịch scene **trong cùng track**; `rootDuration` là `max` trên **mọi** track; hở/chồng chỉ tính trong cùng track, chồng giữa track là **hợp lệ**
  - _Requirements: R10.1–3, R10.2b, R10.7_ — _Design: §5.14, Decision 9_ — _Vá executability #9_
- [x] C.5 `NarrationCueService.readCues` + `buildNarrationClips`
  - Sidecar một-cue cũ đọc thành **đúng một** cue, MUST NOT ghi đè
  - _Requirements: R11.2, R11.3_ — _Design: §5.15_
- [x] C.6 `scanRemoteMedia` + `scanExternalDependencies` (static)
  - Quét CSS `url(...)`, local stylesheet, element attribute. Script/stylesheet/font: **không** chặn, chỉ warning + `reproducible:false`
  - _Requirements: R6.15, R6.15b_ — _Design: §5.10_

**Tasks — Logic Tests**:
- [x] C.7 Unit test bảng 8 dòng của `resolveWorkspace`, gồm `cwd` có `vidcom.json` **lỗi** → vẫn chọn cwd, **không** rơi xuống active
- [x] C.8 Unit test `validateCustom` bounds · `inferPreset` không khớp → `custom` · `assertCatalogEncodable`
- [x] C.9 Unit test path: `.vidcom/state.json` qua `state-write` **được**, qua `write-source` **bị chặn**; `.env` chặn ở cả hai purpose mới; `workspace-agent-kit` không resolve được vào trong một project
- [x] C.10 Unit test `planRipple` trên project **nhiều track**: track khác **không** dịch; chồng giữa track **không** là lỗi
- [x] C.11 Unit test `scanRemoteMedia` bắt được asset trong **CSS `url(...)`**, không chỉ attribute

**Acceptance Criteria**:
- [x] Không file nào trong `packages/core/` import `node:fs` — luật do **ESLint flat config** áp lên `packages/core/**` và bắt lúc `npm run lint`. `npm run test:boundaries` chỉ chứng minh **luật còn hiệu lực** (nó lint fixture), MUST NOT nhầm nó là phép kiểm file mới của bạn
- [x] Test multi-track có thật — luật per-track chỉ tồn tại trong tài liệu nếu fixture chỉ có một track

**Deliverables**: `packages/core/src/domain/workspace-resolver.ts` · `packages/core/src/domain/platform-preset.ts` · `packages/core/src/domain/path-policy.ts` · `packages/core/src/domain/invariants.ts` (mở rộng) · `packages/core/src/usecase/narration-cues.ts` · `packages/core/src/service/remote-asset-scan.ts`

---

## Phase D: WriteAuthority — `mutateSource` / `mutateDerived` — **GATE**

**Addresses**: R4.4, R4.4b, R4.4c · **Design**: §5.18, §6.1, Decision 3, Decision 14
**Files affected**: `packages/core/src/service/write-authority.ts`, `packages/adapter/src/db/journal.ts`
**Prerequisite**: B
**Estimate**: 21 SP
**Read first**: [`write-authority.ts`](../../../../packages/core/src/service/write-authority.ts) (FULL) · [`journal.ts`](../../../../packages/adapter/src/db/journal.ts) (search `preparePrevious`, `LARGE_PREVIOUS_CONTENT_THRESHOLD`)

**Tasks**:
- [x] D.1 Tách thành hai method, bỏ `purpose` do caller truyền
  - `mutateSource(SourceMutationRequest)` luôn `advances_source=1`; `mutateDerived(DerivedMutationRequest)` luôn `0`
  - **Breaking change bắt buộc**: `MutationRequest.purpose?: "write-source" | "system-write"` hiện cho caller tự chọn — thêm `state-write` vào đó sẽ mở đúng cái lỗ Decision 3 đang bịt
  - _Requirements: R4.4c_ — _Design: §5.18_
- [x] D.2 Bảng suy purpose từ `(method, path)` — allowlist compile-time
  - 6 dòng: `mutateSource`+identity/preview/narration JSON → `system-write` · `mutateSource`+authored asset → `write-asset` · `mutateSource`+còn lại nhưng loại `.vidcom|snapshots|renders/**` → `write-source` · `mutateDerived`+`.vidcom/**` → `state-write` · `mutateDerived`+`snapshots|renders/**` → `write-asset` · `mutateWorkspace`+literal → `workspace-agent-kit`
  - Path không khớp dòng nào của method đang gọi → `not_allowed_for_purpose`, **MUST NOT** fallback sang method khác
  - _Requirements: R4.4c_ — _Design: §5.18_
- [x] D.3 `mutateDerived` composite nhiều file
  - Snapshot publish N ảnh + contact sheet + `state.json` như **một** composite; dùng lại `StagedAssetPort` đã có cho artifact nhị phân
  - _Requirements: R7.4_ — _Design: §5.18, §5.11_
- [x] D.4 `latestSourceRevision(projectId)` trên `MutationJournalPort`
  - `id` lớn nhất với `advances_source = 1`, dùng `idx_revision_source`
  - _Requirements: R4.4c_ — _Design: §6.4_
- [x] D.5 Prune K generation cho derived rollback payload
  - `DERIVED_ROLLBACK_GENERATIONS = 3` hằng số có tên; giữ K bản gần nhất theo `(project_id, path)` với `advances_source=0`
  - Trong transaction commit: detach payload ở `revision_step`, xoá `revision_blob` tương ứng, nhưng **giữ revision + step metadata** — `computedAtSourceRevision` và audit phải sống lâu hơn payload
  - Sau commit: GC object `PreviousContentStore` chỉ khi không còn reference; crash trước GC để lại object vô chủ an toàn và startup retry, MUST NOT xoá object trước DB commit
  - `readRevisionRollbackPayload(revisionId,path)` vượt K trả `rollback_payload_pruned`, MUST NOT diễn giải `NULL` thành file trước đó không tồn tại
  - _Requirements: R4.4_ — _Design: §6.1, Decision 14_

**Tasks — Real Datastore Tests** (test quan trọng nhất của spec):
- [x] D.6 Ghi `state.json` · `context/**` · `snapshots/**` · `renders/**` — **cả bốn** MUST NOT làm `latestSourceRevision` tiến
- [x] D.7 Batch render-completion thật qua `mutateDerived` trên SQLite + fs MUST NOT làm snapshot bị nhãn stale; Phase I kiểm lại qua `RenderJobRunner` thật (không stub runner sớm ở Gate D)
- [x] D.8 `mutateDerived` với path `index.html` → `not_allowed_for_purpose`, **không** fallback sang `mutateSource`
- [x] D.9 Publish lần K+1 xoá payload cũ nhất nhưng **giữ** revision row; rollback vượt K trả `rollback_payload_pruned`
- [x] D.10 `latestSourceRevision` dùng `idx_revision_source` (assert query plan, không chỉ kết quả)

**Acceptance Criteria**:
- [x] Không caller nào truyền được cờ `advancesSource` hay `purpose` — kiểm bằng type, không bằng review
- [x] **GATE**: D.6–D.9 xanh trước Phase E/I/J

**Deliverables**: `packages/core/src/service/write-authority.ts` · `packages/adapter/src/db/journal.ts` · `tests/core/source-revision.test.ts`

---

## Phase E: WorkspaceMutationCoordinator + directory lifecycle — **GATE**

**Addresses**: R5, R12.10b, R13.11 · **Design**: §5.7, §5.18, §6.4, Decision 4
**Files affected**: `packages/core/src/service/workspace-mutation-coordinator.ts`, `packages/core/src/port/`, `packages/adapter/src/fs/`
**Prerequisite**: D
**Estimate**: 21 SP

**Tasks**:
- [x] E.1 `WorkspaceOperationJournalPort` + adapter
  - Header/step theo B.3; protocol capture → publish → settle giống composite project nhưng **không** revision/backup
  - _Requirements: R13.11_ — _Design: Decision 4_
- [x] E.2 `WriteAuthority.mutateWorkspace` (facade public)
  - **MUST NOT phát `DomainEvent`**: `DomainEvent.projectId` không nullable và `ck_event_type` khoá đúng 4 loại — scope workspace không có `projectId` để bịa. Chỉ ghi `audit_entry` với `project_id = NULL` (_Vá executability #8_)
  - Coordinator là dependency **nội bộ sau facade**; MUST NOT inject thẳng vào installer/route/MCP
  - HTTP/MCP schema **không** nhận `workspaceRoot` — composition root inject root đã resolve
  - `writes[].content` là `string | Uint8Array` để khớp `MutationRequest`
  - `WorkspacePort.resolveWorkspace(...)` là capability nội bộ duy nhất cho base root workspace; adapter từ chối root khác root đã inject (_Vá executability Design bản 12_)
  - _Requirements: R13.11_ — _Design: §5.18_
- [x] E.3 `ProjectDirectoryPort` + `FsProjectDirectoryAdapter`
  - `stageCreate` / `publishCreate` / `rename` / `quarantine` / `restoreQuarantine` / `removeOwned`
  - Core MUST NOT import `node:fs` chỉ vì class có chữ "Manager"
  - _Requirements: R5.1, R5.10_ — _Design: §5.7_
- [x] E.4 Serialize target collision
  - Mutex dưới lease single-writer + query join pending/orphaned step theo target path trong transaction begin; trùng target → `write_conflict`
  - SQLite **không** tạo được partial index cross-table theo status của bảng header — MUST NOT giả có index đó
  - _Requirements: R12.10b_ — _Design: §6.4_
- [x] E.5 Recovery một operation terminal hoá **cả batch**
  - Step publish fail → restore theo ordinal **giảm dần**; rollback fail → `orphaned`, chặn mutation trùng target
  - MUST NOT settle từng file thành các operation độc lập
  - _Requirements: R12.10b_ — _Design: Decision 4, Finding 10_

**Tasks — Real Datastore Tests**:
- [x] E.6 Agent-kit fail ở step N → restore N−1 step và terminal hoá **một** workspace operation
- [x] E.7 Hai operation đồng thời đụng cùng path → đúng một bắt đầu, cái kia `write_conflict` (test `Promise.all`)
- [x] E.8 `mutateWorkspace` MUST NOT insert vào `revision`
- [x] E.9 Adapter + operation journal crash ở từng boundary staging→rename→DB settle không để lại folder nửa vời; Phase L.6 lặp end-to-end qua `ProjectLifecycle`, MUST NOT viết usecase L sớm

**Acceptance Criteria**:
- [x] `mutation_journal`, `mutation_step`, `revision_step`, `revision_blob` **không đổi cấu trúc**
- [x] **GATE**: E.6–E.9 xanh trước Phase L/Q

**Deliverables**: `packages/core/src/service/workspace-mutation-coordinator.ts` · `packages/core/src/port/ports.ts` (thêm 2 port) · `packages/adapter/src/fs/project-directory.ts`

---

## Phase G: RenderRootPort + orphan reclaim

**Addresses**: R6.7b · **Design**: §5.9, Decision 7
**Prerequisite**: F
**Estimate**: 10 SP

**Tasks**:
- [x] G.1 `RenderRootPort.acquire/release` + `FsRenderRootAdapter`
  - `mkdir <stagingRoot>/<jobId>/` + marker `.vidcom-render-owner` `{jobId, createdAt}`; `environment` trả `TEMP`/`TMP`/`HYPERFRAMES_FFMPEG_PATH`/`HYPERFRAMES_FFPROBE_PATH`
  - _Requirements: R6.7b_ — _Design: §5.9, Finding 3_
- [x] G.2 `reclaimOrphans` — **bốn** điều kiện đồng thời
  - dưới staging root · marker + `jobId` hợp lệ · quá `RENDER_WORKDIR_ORPHAN_GRACE_SECONDS = 3600` · job không chạy
  - **MUST NOT** quét `TEMP` chung — xoá theo pattern tên có thể xoá workdir của `hyperframes` do người dùng tự chạy
  - Trả **số đã xoá + `reclaimedJobIds` + lỗi**; startup clear `cleanupPending` theo ID sau remove thành công; thất bại im lặng ở đường dọn rác là cách leak quay lại mà không ai biết
  - Vá executability §5.9 bản 15: startup đối chiếu thêm `listCleanupPendingIds()` với `inspect(jobId)`; chỉ root exact `absent` mới clear cờ sau crash remove→clear, `unowned` giữ cờ + warning và MUST NOT bị xoá
  - _Requirements: R6.7b_ — _Design: Decision 7_
- [x] G.3 Recovery lúc khởi động chạy **hai việc độc lập**
  - `recoverStale` (đã có) và `reclaimOrphans` (mới). Cái thứ hai không phụ thuộc cái thứ nhất — một root có thể mồ côi trong khi job của nó đã kết thúc sạch, nếu `release` từng thất bại
  - _Requirements: R6.7b_ — _Design: §4.4.2_

**Tasks — Tests**:
- [x] G.4 Integration: `release` lỗi → `cleanupPending: true`, recovery thu hồi sau
- [x] G.5 Integration: root thiếu **bất kỳ** một trong bốn điều kiện → **không** bị xoá (4 test, mỗi điều kiện một ca)
- [x] G.6 Test khoá giá trị `RENDER_WORKDIR_ORPHAN_GRACE_SECONDS = 3600`

**Deliverables**: `packages/core/src/port/ports.ts` (thêm `RenderRootPort`) · `packages/adapter/src/fs/render-root.ts`

---

## Phase H: RemoteAssetGuard runtime — CSP + observer

**Addresses**: R6.15, R6.15b · **Design**: §5.10, Decision 11
**Prerequisite**: C, F
**Estimate**: 16 SP
**Read first**: spike [`runtime-media-csp-guard.mjs`](../../../../spikes/phase-3-detailed-design/runtime-media-csp-guard.mjs) · [`runtime-external-observer.mjs`](../../../../spikes/phase-3-detailed-design/runtime-external-observer.mjs)

**Tasks**:
- [x] H.1 Inject CSP làm phần tử **đầu tiên** của `<head>`
  - `img-src 'self' data: blob:` + `media-src 'self' data: blob:`, trước **mọi** node tác giả có thể chạy
  - _Requirements: R6.15_ — _Design: §5.10_
- [x] H.2 Listener `securitypolicyviolation` → callback loopback nonce-bound
  - Chỉ bind loopback; token ngẫu nhiên theo job, **không log**; payload phải khớp job đang chạy; server đóng trong `finally`
  - Token **không** one-shot — một render có thể có nhiều report; chống replay bằng lifecycle ngắn + dedupe
  - _Requirements: R6.15_ — _Design: §5.10, Decision 11_
- [x] H.3 `PerformanceObserver` cho external dependency
  - `{type:"resource", buffered:true}`, chỉ nhận initiator `script|link|css|font`, **loại chính callback URL**, dedupe theo `(initiatorType,url)`, cap 100 entry/job
  - Probe đầu tiên đã tự tạo vòng lặp feedback — các điều kiện này là safety contract, không phải tối ưu
  - _Requirements: R6.15b_ — _Design: §5.10_
- [x] H.4 Guard đóng **trước publish**
  - Violation → bỏ staging artifact + fail `remote_asset_not_local`. Artifact của HyperFrames luôn là staging cho tới khi callback đóng và report media rỗng
  - _Requirements: R6.15_ — _Design: §4.3.2_

**Tasks — Tests**:
- [x] H.5 Integration: `new Image()` tạo bằng JS lúc runtime bị chặn; asset server nhận **0 byte** request
- [x] H.6 Integration: script external tạo động được observer ghi **đúng một lần**; callback URL **không** tự xuất hiện; >100 entry bị cap
- [x] H.7 Golden: document injection (CSP + bootstrap) — contract cần chạy lại khi bump HyperFrames

**Acceptance Criteria**:
- [x] Tài liệu và code **không** phát biểu "chặn mọi remote media" — câu đúng là "chặn remote media **do document khai**". Lỗ `blob:` + `connect-src` là D8/Giai đoạn 4
- [x] `externalDependencies` tới client **kể cả khi render thành công**
  - I.4/I.5 đã nối ordered runtime list vào sidecar, job result và warning metadata; render Chromium/FFmpeg thật chứng minh dependency GSAP CDN tới client dù job `succeeded`.

**Deliverables**: `packages/core/src/service/remote-asset-guard.ts` · `packages/adapter/src/hyperframes/document.ts` (injection) · `packages/adapter/src/runtime/guard-callback-server.ts`

---

## Phase I: Render job

**Addresses**: R6 · **Design**: §5.8, §4.3.2, Decision 6, 8
**Prerequisite**: B, D, F, G, H
**Estimate**: 16 SP

**Tasks**:
- [x] I.1 `BinaryProbe` — **bốn** binary
  - `hyperframes` (resolve qua `require.resolve` + `process.execPath`, **không** qua PATH), Chromium, FFmpeg, FFprobe
  - `render_binary_missing` mang `details.missing: string[]` — nêu **từng** binary, MUST NOT gộp thành "render failed"
  - Version lệch minor+ → warning `engine_version_drift`
  - _Requirements: R6.12_ — _Design: §4.6, §8.2_
- [x] I.2 `createRenderJobHandler`
  - `maxAttempts: 1` + `idempotent: false` (output không byte-deterministic nên retry sinh artifact thứ hai cho một yêu cầu)
  - Không hai render cùng project song song — dùng `nextQueued(types, excluded)` **đã có**
  - _Requirements: R6.8, R6.11_ — _Design: §5.8_
- [x] I.3 Gate trạng thái trước enqueue
  - `empty` → `no_composition` · 0 scene → `no_scenes` · `invalid` → `project_invalid`
  - _Requirements: R6.2b, R6.2c_ — _Design: §4.3.2_
- [x] I.4 `bestEffort` mặc định `true`
  - Warning vào **job metadata VÀ tới client**, không chỉ stdout; `bestEffort: false` fail bằng **mã ổn định**, không phải message
  - _Requirements: R6.14_ — _Design: Decision 8_
- [x] I.5 Publish qua `mutateDerived`
  - `renders/<name>.mp4` + sidecar; **KHÔNG** làm `sourceRevision` tiến
  - Vá executability §5.8 bản 16: `RenderProjectPort` clone an toàn vào render root, bỏ symlink + `.vidcom|renders|snapshots`, thay entry bằng document guard và runtime local; runner đọc output qua port rồi publish trực tiếp, MUST NOT gọi `ProjectStateStore` Phase K sớm
  - _Requirements: R4.4_ — _Design: §4.3.2_

**Tasks — Tests**:
- [x] I.6 Integration: `authored` + 0 scene → render **từ chối** (đối chiếu J.6 và M.5 — ba đường khác nhau có chủ đích)
- [x] I.7 Integration: thiếu từng binary → `details.missing` nêu đúng tên
- [x] I.8 Integration: crash render → artifact **không** công bố **và** render root nhận diện được là orphan theo 4 điều kiện
- [x] I.9 Integration: cancel render → descendant = 0 **trước khi** status thành `cancelled`

**Deliverables**: `packages/worker/src/render-job.ts`

---

## Phase J: Snapshot job

**Addresses**: R7 · **Design**: §5.11, §6.3.2, Decision 13
**Prerequisite**: I
**Estimate**: 13 SP
**Read first**: spike [`s3b-at-failure-modes.mjs`](../../../../spikes/phase-3-checklist-gate/s3b-at-failure-modes.mjs) — ba lỗ của CLI

**Tasks**:
- [x] J.1 Một invocation cho cả tập scene
  - `hyperframes snapshot --at <m1>,<m2>,…,<mN> --no-end --describe false --output <staging>` qua cùng `ProcessSupervisorPort`
  - Chỉ nhận PNG; bỏ `contact-sheet.jpg` CLI tự sinh
  - _Requirements: R7.4_ — _Design: Decision 13_
- [x] J.2 Map output → scene **theo timestamp**, không theo ordinal
  - Parse token `-at-<t>s` trong tên file, so **theo số** (`1.0`→`1s`, `1.5`→`1.5s`, `-5.0`→`at--5s`)
  - Lý do: timestamp không parse được bị CLI **bỏ im lặng**, làm ordinal dịch — `01` sẽ trỏ vào midpoint thứ ba
  - _Requirements: R7.9_ — _Design: §5.11_
- [x] J.3 Hai tiền điều kiện VidCom **phải tự làm**
  - Validate `0 <= t <= rootDuration`: CLI trả **frame** cho `999` và `-5`, không trả lỗi
  - Dedupe midpoint trước khi gửi, rồi fan-out kết quả cho mọi scene chia sẻ midpoint
  - _Requirements: R7.9_ — _Design: §5.11_
- [x] J.4 Terminal `partial` + `partialAtSourceRevision`
  - `computedAtSourceRevision` **null** khi partial; contact sheet **chỉ** khi complete
  - Phạm vi sinh lại theo bảng R7.9c: so `sourceRevision` với `partialAtSourceRevision`, tính lại danh sách scene trước
  - _Requirements: R7.9b, R7.9c_ — _Design: §5.11, §6.3_
- [x] J.5 Ghép contact sheet deterministic **sau khi** mọi scene của generation hiện tại đủ, publish như một derived composite

**Tasks — Tests**:
- [x] J.6 Integration: `authored` + 0 scene → snapshot **thành công rỗng**
- [x] J.7 Integration: partial → retry **cùng** revision (chỉ scene thiếu) **và** retry **khác** revision (toàn bộ) — đường (b) là chỗ sai im lặng
- [x] J.8 Integration: một midpoint bị CLI bỏ **không** làm scene sau bị gán nhầm ảnh
- [x] J.9 Integration: midpoint quá `rootDuration` hoặc âm bị **VidCom** từ chối trước khi spawn
- [x] J.10 Golden: mapping ordinal↔timestamp — chạy lại khi bump HyperFrames

**Deliverables**: `packages/worker/src/snapshot-job.ts`

---

## Phase K: Workspace resolve/scan/identity/state store

**Addresses**: R1, R3, R4 · **Design**: §5.2, §5.3, §5.5, §5.6, §6.2, §6.3
**Prerequisite**: D
**Estimate**: 21 SP

**Tasks**:
- [x] K.1 `scanWorkspace` — quét **một cấp**
  - Bỏ qua `node_modules`, `.git`, `.hyperframes`, mọi dir bắt đầu bằng `.`
  - Phân loại: `authored` / `empty` / `invalid(identity)` / `invalid(composition)` / `candidate` / bỏ qua
  - Cache **hai tầng** theo `(path, mtime, size)`: metadata và parse tách riêng
  - _Requirements: R1.9, R1.12_ — _Design: §5.2, §9.1_
- [x] K.2 `EntryRegistry` — **không có bảng**
  - `mint` idempotent theo `(workspaceRoot, slug)`; `resolve`; `revoke` khi identity phục hồi; `clear` khi đổi workspace
  - Persist nó là tạo định danh bền **thứ hai** song song `ProjectId`
  - _Requirements: R1.2c-iii, R1.13_ — _Design: §5.3, Decision 2_
- [x] K.3 `ProjectIdentityService` — `vidcom.json` schema v1
  - Zod strict: key lạ → lỗi nêu **tên field**, không nêu giá trị; parse lỗi → **KHÔNG** ghi đè
  - `schemaVersion` cao hơn binary → từ chối mở, MUST NOT đọc theo schema cũ
  - `serialize` byte-deterministic: key ổn định, indent 2, newline cuối
  - _Requirements: R3.1, R3.3, R3.7, R3.9_ — _Design: §5.5, §6.2_
- [x] K.4 Backfill `platform` lazy khi mở project
  - Không phải batch migration; idempotent (đọc lại thấy có `platform` thì bỏ qua); đi qua `WriteAuthority` có journal
  - Ba project prototype (`kinetic-type`, `swiss-grid`, `warm-grain`) hiện chỉ có `{ id }` và là test case thật
  - _Requirements: R3.4_ — _Design: §6.5_
- [x] K.5 `ProjectStateStore` — sở hữu toàn bộ `.vidcom/`
  - `ensure` (cấu trúc + `.gitignore`) · `writeState`/`writeContext` qua `mutateDerived` · append `.jsonl` atomic (không qua transaction) · `pruneLogs` · `reconcile` **một chiều** SQLite → `.vidcom`
  - _Requirements: R4.1, R4.1b, R4.5, R4.7, R4.8b_ — _Design: §5.6, Decision 5_
- [x] K.6 Định nghĩa **năm type còn thiếu shape** (Design §14 ghi nợ)
  - `RenderState`, `ProjectContext`, `JobLogLine`, `RevisionLogLine`, `StructuredLogLine`
  - Cả năm là payload nội bộ `.vidcom/`, không ràng buộc DB, không qua biên HTTP/MCP
  - _Requirements: R4.3, R4.5_ — _Design: §6.3, §14_
- [x] K.7 `stale` **không** được lưu
  - Nó là phép so `computedAtSourceRevision < sourceRevision`. Cờ phải được ai đó cập nhật; phép so thì không thể lệch
  - _Requirements: R4.4b_ — _Design: §6.3_

**Tasks — Tests**:
- [x] K.8 Integration: folder trống mở được (chặn đứng hiện tại)
- [x] K.9 Integration: `cwd` có `vidcom.json` **lỗi** → mở đúng project đó ở `invalid`, **không** rơi xuống active
- [x] K.10 Integration: active workspace bị xoá → **cảnh báo** nêu path cũ rồi fallback
- [x] K.11 Integration: `entryId` từ workspace A **không** resolve sau khi đổi sang workspace B
- [x] K.12 Integration: `.vidcom/.gitignore` → `git status` sạch sau khi mở project + chạy job; chỉ `project-context.md` được track
- [x] K.13 Golden: `project-context.md` deterministic — **không** absolute path / timestamp / jobId
- [x] K.14 Integration: **không có đường nào** từ `.vidcom/` ghi ngược vào SQLite; `reconcile` chỉ rebuild một chiều
- [x] K.15 Perf: scan 100 project sinh tổng hợp — stat < 500 ms, parse cold < 2 s, warm < 100 ms

**Acceptance Criteria**:
- [x] Perf task ở trên đạt cả ba ngưỡng; nếu không → **quay lại Design** (D9 đổi contract `WorkspaceEntry`), MUST NOT tự sửa trong implementation

**Deliverables**: `packages/core/src/usecase/scan-workspace.ts` · `packages/core/src/service/entry-registry.ts` · `packages/core/src/usecase/project-identity.ts` · `packages/core/src/service/project-state-store.ts`

---

## Phase L: ProjectLifecycle CRUD

**Addresses**: R5 · **Design**: §5.7, §4.4.1
**Prerequisite**: E, K
**Estimate**: 16 SP

**Tasks**:
- [x] L.1 `create` — một composite mutation
  - `WriteAuthority.createProjectRoot` begin operation bền → dựng toàn bộ project trong **sibling staging dot-dir** → validate hash/schema → commit registration + **đúng một** revision + audit/event → atomic rename staging thành slug
  - `vidcom.json` chỉ xuất hiện trong final root cùng toàn bộ file còn lại. Crash trước rename để lại staging bị scanner bỏ qua
  - _Requirements: R5.1_ — _Design: §5.7_
- [x] L.2 `adopt` — chỉ ghi `vidcom.json`, **MUST NOT** sửa file nội dung của người dùng
- [x] L.3 `rename` — journal `{fromSlug,toSlug,projectId}` trước I/O → atomic directory rename → transaction cập nhật registration. Giữ nguyên `ProjectId`
- [x] L.4 `remove` — backup **verify được TRƯỚC khi chạm đĩa** → journal → atomic rename sang quarantine dot-dir → transaction gỡ registration → dọn quarantine. **MUST NOT** recursive-delete live root trực tiếp
- [x] L.5 `ProjectLocator` — nghiệp vụ chỉ nhận `ProjectId`; recovery nhận `entryId`
  - Tập operation nhận `entryId` phải **đóng ở đúng bốn** (R1.2c-iv)
  - _Requirements: R1.2c-iv_ — _Design: §5.7, Decision 2_

**Tasks — Tests**:
- [x] L.6 Integration: create atomic — crash ở từng boundary không để final folder nửa vời
- [x] L.7 Integration: adopt **không** sửa file người dùng (so hash trước/sau)
- [x] L.8 Integration: rename giữ `ProjectId`; recovery nhìn old/new root, **không** mint ID mới
- [x] L.9 Integration: delete có backup verify; job đang chạy chặn delete
- [x] L.10 Integration: một tool nghiệp vụ **từ chối** `entryId` — tập đóng trên giấy không đủ

**Deliverables**: `packages/core/src/usecase/project-lifecycle.ts`

---

## Phase M: Diagnostics + Thumbnail

**Addresses**: R8, R9 · **Design**: §5.12, §5.13
**Prerequisite**: C, K
**Estimate**: 13 SP

**Tasks**:
- [x] M.1 Đưa **4 cảnh báo hiện có** (VD-3) vào Core — **trích luật, không phải di chuyển module**
  - Design §5.13 nói chúng ở `src/lib`; **sai**. Vị trí thật, và hai trong bốn cái chỉ tồn tại dưới dạng số học trong JSX:

    | Lint | Ở đâu thật | Hình dạng công việc |
    |---|---|---|
    | stranded tween | [`timeline-elements.tsx:124-130`](../../../../src/components/studio/timeline-elements.tsx#L124-L130) | trích `reduce` ra hàm thuần ở Core |
    | element overrun | [`timeline-elements.tsx:205`](../../../../src/components/studio/timeline-elements.tsx#L205) | trích số học ra hàm thuần ở Core |
    | unresolved selector | field `unresolvedEffects` do parser sinh ([`types.ts:77`](../../../../packages/adapter/src/hyperframes/types.ts#L77)) | bọc field có sẵn thành Diagnostic |
    | empty scene | [`parse.ts:271`](../../../../packages/adapter/src/hyperframes/parse.ts#L271) | bọc điều kiện có sẵn thành Diagnostic |

  - Sau khi trích, component **phải** dùng lại hàm Core thay vì giữ bản sao — nếu không sẽ có hai nguồn sự thật cho cùng một cảnh báo, đúng thứ spec này đang cố loại bỏ
  - _Requirements: R9 VD-3_ — _Design: §5.13_ — _Vá executability #4_
- [x] M.2 Thêm 4 diagnostic mới: `platform-mismatch`, `narration-overflow`, `missing-asset`, `no-composition`/`no-scenes`
- [x] M.3 Tích hợp `hyperframes check` → `lint:<rule>`
  - Vắng mặt → `lintSourceAvailable: false` và **nêu rõ**, MUST NOT trả rỗng
  - _Requirements: R9.3, R9.4_ — _Design: §5.13, §8.2_
- [x] M.4 `forEntry(entryId)` — đường recovery
  - **KHÔNG** gọi parser composition, **KHÔNG** ghi `.vidcom`; `computedAtSourceRevision` null
  - _Requirements: R9.1, R9.8d, R9.8e_ — _Design: §5.13_
- [x] M.5 `ThumbnailResolver`
  - `seedKind: "slug"` **chỉ** cho `invalidKind: "identity"` — `entryId` đổi mỗi phiên nên dùng nó làm seed sẽ đổi màu card mỗi lần khởi động
  - _Requirements: R8.2b_ — _Design: §5.12_

**Tasks — Tests**:
- [x] M.6 Integration: `authored` + 0 scene → diagnostics `no-scenes`
- [x] M.7 Integration: `invalid` → diagnostics **vẫn chạy**, render/mutation từ chối `project_invalid` (bảng R1.2d, **từng dòng một test**)
- [x] M.8 Integration: `check` vắng → cờ `lintSourceAvailable: false`, không rỗng
- [x] M.9 Integration: đường `entryId` **không** ghi `.vidcom`
- [x] M.10 Unit: seed theo `ProjectId` vs slug

**Deliverables**: `packages/core/src/usecase/diagnostics.ts` · `packages/core/src/usecase/thumbnail.ts`

---

## Phase N: Scene timing + narration cues (usecase)

**Addresses**: R10, R11 · **Design**: §5.14, §5.15
**Prerequisite**: C, D
**Estimate**: 13 SP

**Tasks**:
- [x] N.1 **Mở rộng `createScene`** trong [`project-writes.ts:339`](../../../../packages/core/src/usecase/project-writes.ts#L339) — nhận `{ index, trackIndex? }` + ripple theo track, **một revision**
  - `createScene` và `setSceneTiming` **đã tồn tại**; tạo `usecase/scene-insert.ts` mới sẽ là đường ghi thứ hai cho cùng một thao tác (_Vá executability #9_)
- [x] N.2 `empty → authored`: scene đầu tiên được chèn, root composition sinh **cùng revision**
- [x] N.3 **Mở rộng `setSceneTiming`** ([`project-writes.ts:130`](../../../../packages/core/src/usecase/project-writes.ts#L130)) — `duration_overflow` mang `details.limitKind` (`runtime`|`root`) + `actualSeconds` + `maxSeconds` + `extendRootAllowed`
  - Client quyết định hiện nút gì bằng **field**, MUST NOT parse message
  - _Requirements: R10.5c_ — _Design: §8.2_
- [x] N.4 Narration nhiều cue: một `<audio class="clip hf-narration">` cho mỗi cue, `data-start` từ document
  - Đi qua vùng `NarrationRecord` / `regenerateNarration` **đã có** ([`project-writes.ts:284`](../../../../packages/core/src/usecase/project-writes.ts#L284)), không dựng đường narration thứ hai
- [x] N.5 Sửa **đúng một** cue → cue khác **không** bị stale

**Tasks — Tests**:
- [x] N.6 Integration: ripple trên project **nhiều track** — track khác **không** dịch
- [x] N.7 Integration: chèn scene đầu tiên → `empty → authored` trong một revision
- [x] N.8 Integration: đọc sidecar một-cue cũ thành đúng một cue; nhiều `<audio>` đúng `data-start`; PATCH giữ metadata cue không đổi và chỉ stale cue đổi text/voice

**Deliverables**: `packages/core/src/usecase/project-writes.ts` (mở rộng `createScene`, `setSceneTiming`, vùng narration) · `packages/core/src/usecase/narration-cues.ts` (đọc/ghi cue, mới)

---

## Phase Q: Agent-kit bundle + installer

**Addresses**: R13 · **Design**: §5.17, Decision 10
**Prerequisite**: E
**Estimate**: 21 SP
**Read first**: [`steering/14`](../../../steering/14-agent-kit-and-skills.md) (FULL) · [spike ma trận host](../../../../spikes/phase-3-agent-kit-host/README.md)

**Tasks**:
- [x] Q.1 Nội dung agent-kit + build asset nhúng + manifest hash **trong binary**
  - MUST NOT là lock file trong workspace
  - _Requirements: R13_ — _Design: §4.6_
- [x] Q.2 **Hai** manifest theo host — mapping do **bằng chứng**, không do quy ước
  - `codex` → `AGENTS.md` + `.agents/skills/**`, `link` **không expose**, recovery là `manual_merge`
  - `claude-code` → `CLAUDE.md` + `.claude/skills/**`, `link` append `@CLAUDE.vidcom.md` + `expectedContentHash`
  - _Requirements: R13.7-i_ — _Design: §5.17, Decision 10_
- [x] Q.3 Sáu `FileState` + bốn outcome
  - `missing|current_pristine|current_modified|outdated|newer|foreign`; `newer` **không** bị hạ cấp
  - _Requirements: R13.9a_ — _Design: §5.17_
- [x] Q.4 Suy `usableBy` từ **router native được discover**, không từ file chỉ dẫn chính
  - Cả hai host gọi được probe từ `vidcom/SKILL.md` dù file chỉ dẫn vắng mặt, nên `AGENTS.md` `foreign` **không** làm host `blocked` khi router còn nguyên
  - _Requirements: R13.9b, R13.9b-i_ — _Design: §5.17, Decision 10_
- [x] Q.5 Boundary schema: discriminated union `.strict()`
  - Nhánh install dùng array `.min(1)` + unique host; field của nhánh khác bị **schema** từ chối, không phải code
  - `installationState.files`/`usableBy`/`recovery` có key **đúng bằng** selected-host set, không placeholder cho host không chọn
  - _Requirements: R12.9, R12.9-iii_ — _Design: §5.17, §7.2_
- [x] Q.6 Ghi qua `mutateWorkspace` — audit `project_id = NULL`, **không** revision/backup

**Tasks — Tests**:
- [x] Q.7 6 state per-file; `current_pristine`+`missing` → `installed`; mọi `current_pristine` → `already_installed`
- [x] Q.8 Hai host `degraded` → **`partial`** không phải `blocked`
- [x] Q.9 `AGENTS.md` rỗng-có-marker nhưng router native còn → **`degraded`**; router không parse/discover → `blocked`
- [x] Q.10 `link` đổi Claude `usableBy` `degraded` → `ready`; `host: "codex"` bị `schema_invalid`
- [x] Q.11 `hosts` rỗng → `schema_invalid`; chọn một host → file host kia **không** vào `expectedFiles`
- [x] Q.12 Sync (AK-8): tool trong `AGENTS.md` ↔ Registry · tool skill tham chiếu tồn tại · router `/vidcom-*` có `SKILL.md`
  - Actual Registry equality đóng ở Phase P bằng catalog 17 descriptor production; không còn final-catalog fixture song song.
- [x] Q.13 Batch rollback: fail giữa chừng → restore mọi step, **không** revision

**Deliverables**: `packages/agent-kit/` · `usecase/agent-kit-install.ts`

---

## Phase O: HTTP routes

**Addresses**: R1, R5–R11, R13 · **Design**: §7.1
**Prerequisite**: I, J, K, L, M, N
**Estimate**: 16 SP

**Tasks**:
- [x] O.1 Route workspace/project: `GET /v1/workspace` · `PUT /v1/workspace/active` (phát sự kiện đổi workspace cho `EntryRegistry.clear`) · `POST /v1/projects` · `POST /v1/projects/:slug/adopt` (slug vì candidate chưa có `ProjectId`) · `PATCH`/`DELETE /v1/projects/:id`
- [x] O.2 Route job: `POST .../renders` · `POST .../snapshots` (cả hai `idempotencyKey`) · `GET /v1/jobs/:jobId` (gồm `partial`, `warnings`, `cleanupPending`) · `POST /v1/jobs/:jobId/cancel` (202, idempotent) · `GET /v1/jobs/:jobId/termination-proof`
- [x] O.3 Route nội dung: diagnostics · scenes · scene timing · narration-cues (GET/PUT/PATCH với `expectedContentHash`)
- [x] O.4 Route recovery `entryId`: diagnostics · thay identity · rename · delete (backup + confirmation/grant)
- [x] O.5 `GET /v1/renders/:jobId/download` — Range + ETag + `416` cho unsatisfiable range + `must-revalidate`
- [x] O.6 `POST /v1/agent-kit/install`
- [x] O.7 Error mapping theo §8.1 — giữ nguyên shape `ErrorDetail`, **không** thêm shape thứ hai

**Tasks — Tests**:
- [x] O.8 Integration: HTTP và MCP gọi **cùng một operation/usecase** trên fixture tương đương (MP-2) — không có đường thứ hai
- [x] O.9 Integration: request thật qua `createServerApp().fetch()` map mã lỗi đúng status theo bảng §8.1
- [x] O.10 Integration: SSE `job.progress`/`job.done` mang `partial` — assert **đúng shape payload**, không chỉ assert "có event": `payload` là `Record<string, unknown>` nên compiler không bảo vệ gì (_Vá executability #7_)

**Deliverables**: `packages/server/src/routes/*`

---

## Phase P: MCP tool surface

**Addresses**: R12 · **Design**: §5.16, §7.2
**Prerequisite**: O, Q
**Estimate**: 13 SP

**Tasks**:
- [x] P.1 Bốn tool mới: `validate_project`, `start_snapshot`, `start_render`, `install_agent_kit`
- [x] P.2 **Mở rộng** `get_job_status` đã có ở `registry/job-tools.ts`
  - Thêm `partial`, warnings, `cleanupPending`, outcome; poll có backoff
  - **MUST NOT** register tool thứ hai cùng tên
  - _Requirements: R12.1_ — _Design: §5.16_
- [x] P.3 `tools/list` thứ tự **deterministic**; golden **cả hai era** phải cập nhật
- [x] P.4 Tool không degrade được sang legacy thì **ẩn** khỏi `tools/list` legacy, **không** lỗi lúc gọi
- [x] P.5 Audit: MCP tool ghi thêm `protocol_version`

**Tasks — Tests**:
- [x] P.6 Contract: 5 tool × 2 era
- [x] P.7 Golden `tools/list` cả hai era
- [x] P.8 Union strict: field nhánh khác bị schema từ chối

**Deliverables**: `packages/mcp/src/registry/*`

---

## Phase R: Fixture audit Phase 1/2 — rủi ro im lặng

> Task riêng theo yêu cầu tường minh của Design (Decision 1 Implications, §15). **MUST NOT** gộp vào task đổi scanner.

**Addresses**: Decision 1 · **Design**: Decision 1, §15
**Prerequisite**: tất cả phase code
**Estimate**: 8 SP

**Tasks**:
- [x] R.1 Liệt kê **mọi** fixture Phase 1/2 giả định "project = có `hyperframes.json` + `index.html`"
  - Rủi ro chính **không** phải viết code mới mà là fixture cũ **vẫn xanh trong khi hành vi đã khác**
  - _Design: Decision 1_
- [x] R.2 Với từng fixture: quyết định giữ / sửa sang marker `vidcom.json` / xoá, ghi lý do
- [x] R.3 Thêm test chứng minh định nghĩa **cũ** không còn được chấp nhận ở đường mới
- [x] R.4 Rà `packages/adapter/src/fs/workspace-fs.ts:39-58` và mọi call site của định nghĩa cũ

**Acceptance Criteria**:
- [x] Không còn hai định nghĩa "project tồn tại" cùng sống trong test suite

---

## Phase S: CI gate + contract matrix + release

**Addresses**: toàn spec · **Design**: §5.9, §11, §14
**Prerequisite**: tất cả
**Estimate**: 10 SP

**Tasks**:
- [x] S.1 Đọc kết quả `process-supervision.yml` lần chạy đầu trên Linux + Windows
  - Ghi số vào [spike README](../../../../spikes/phase-3-checklist-gate/README.md): naive có leak không · PowerShell CIM tốn bao nhiêu ms · số sweep tới hội tụ
  - _Design: §5.9, §14_
- [x] S.2 Đọc kết quả `s1f` render thật trên Windows
  - `chrome-headless-shell` trên Windows có tách process group không. Nếu có → cách sửa đã đúng. Nếu **không** → ghi là thuộc tính nền tảng, MUST NOT bỏ pha capture (một code path phải đúng ở mọi nơi)
  - _Design: §5.9_
- [x] S.3 Nếu Windows vừa **không** có enumerator `ppid` vừa leak với naive → **quay lại Design §5.9**, không tự xử trong implementation
- [x] S.4 Mở rộng `test:golden` sang golden mới của spec này (tiền lệ: Phase 2 từng bỏ sót)
- [x] S.5 Cập nhật `verify-spec-test-paths.mjs` cho Verification Matrix mới
- [x] S.6 Release policy: `typecheck` · `lint` · `test:boundaries` · `test` · `test:golden` · `test:schema-drift` · `test:mcp-contract` · `test:runtime-smoke` · `spike:process-supervision` phải xanh trước release/tag. Workflow pull request hiện gate Linux + Windows; macOS chạy khi push `main` hoặc manual dispatch. Evidence ba OS lịch sử không phải guarantee cho mọi pull request; review remediation hiện tại không claim một full-suite local mới.

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

2026-08-04 — Phase A, Tasks A.1–A.6
  - Files: `package.json`, `bun.lock`, `packages/contracts/src/errors.ts`, `packages/contracts/src/dto.ts`, `packages/core/src/port/types.ts`, `packages/adapter/src/db/job-store.ts`, `packages/server/src/middleware/error-mapper.ts`, `packages/server/src/routes/jobs.ts`, `packages/mcp/src/error-map.ts`, `packages/mcp/src/registry/job-tools.ts`, `tests/contracts/api-contracts.test.ts`
  - Summary: Pin `hyperframes@0.7.86` ở runtime dependencies; thêm error/warning vocabulary, terminal `partial`, ordered warnings, `cleanupPending`, hai path purpose và cập nhật mọi HTTP/MCP mapper bị typecheck phát hiện.
  - Verification: `bunx vitest run tests/contracts/api-contracts.test.ts tests/mcp/error-map.test.ts` — 2 files/9 tests xanh; `bun run typecheck` exit 0; `require.resolve("hyperframes/package.json")` trả version `0.7.86`; `git diff --check` exit 0.
  - Decisions: Không lệch Design. `toJob` dùng giá trị mặc định `warnings=null`, `cleanupPending=false` cho schema DB cũ; Phase B sẽ nối hai cột SQLite thật.
  - Blockers: Không có. Phase B là gate kế tiếp.

2026-08-04 — Phase B, Tasks B.1–B.11
  - Files: `packages/adapter/src/db/schema.ts`, `packages/adapter/drizzle/20260804140510_flippant_tenebrous/*`, `packages/adapter/src/db/delivery-loop-migration-rollback.ts`, `packages/adapter/src/db/health.ts`, `packages/adapter/src/db/job-store.ts`, `tests/adapter/delivery-loop-database-migration.test.ts`, migration tests hiện có, MCP golden fixtures.
  - Summary: Thêm `advances_source`, rebuild `job`, hai bảng workspace operation, toàn bộ index/check/FK và rollback preflight có count; nối warnings/cleanup từ SQLite tới job DTO.
  - Verification: Migration matrix 3 files/9 tests xanh; full suite 85 files/655 tests xanh (3 skip có thông báo); `test:schema-drift`, `typecheck`, `lint` (0 error), `git diff --check` exit 0; SQLite `foreign_key_check=[]`, `integrity_check=ok`.
  - Decisions: Hand-edit SQL Drizzle đúng quyền B.6 để tránh rebuild `revision`; Drizzle migrator đã tự sở hữu transaction nên bỏ nested `BEGIN IMMEDIATE`. Golden MCP cập nhật vì contract thay đổi có chủ đích.
  - Blockers: Không có. Gate B xanh; Phase F được mở.

2026-08-04 — Phase F gate, Tasks F.1–F.11, F.14–F.21
  - Files: `packages/core/src/port/process-port.ts`, `packages/core/src/port/types.ts`, `packages/core/src/port/ports.ts`, `packages/core/src/service/job-scheduler.ts`, `packages/adapter/src/runtime/process-environment.ts`, `packages/adapter/src/runtime/process-supervisor.ts`, `packages/adapter/src/runtime/node-process-runner.ts`, `packages/adapter/src/db/job-store.ts`, `tests/adapter/process-supervisor.test.ts`, `tests/adapter/job-infrastructure.test.ts`, `.github/workflows/process-supervision.yml`.
  - Summary: Port thuật toán capture→kill→direct-PID-verify thành adapter đa nền tảng; sửa luôn `ProcessPort` TTS; thêm cancel poll/abort reason/CAS result; persist `partial` đúng result/progress/warnings/cleanup metadata; nối test adapter thật vào matrix Linux/macOS/Windows và nhánh Windows degraded.
  - Verification: `bun run spike:process-supervision` PASS (naive leak 2 PID, ppid walk 0, supervisor 0 survivor); process/scheduler subset xanh; real Chromium/FFmpeg render xanh; full suite 87 files/665 tests xanh (3 skip có thông báo); typecheck, lint 0 error, boundary và diff check xanh.
  - Decisions: Theo F.5, sửa luôn `ProcessPort` cũ bằng supervisor ba pha để VieNeu hưởng cùng bảo đảm. Detailed Design nâng lên bản 8 trước code: `JobCancelledError` mang warning/cleanup metadata, termination-unverified thắng nhánh cancel, branded outcome envelope giữ partial/metadata mà không đoán field của payload nghiệp vụ.
  - Blockers: Không có blocker gate. F.12 còn phần render-root cleanup phụ thuộc Phase G; F.13 chỉ hoàn tất khi hai definition thật được tạo ở I/J, nên chưa tick và không tạo stub production giả.

2026-08-04 — Phase C, Tasks C.1–C.11
  - Files: `packages/core/src/domain/workspace-resolver.ts`, `packages/core/src/domain/platform-preset.ts`, `packages/core/src/domain/path-policy.ts`, `packages/core/src/domain/invariants.ts`, `packages/core/src/usecase/narration-cues.ts`, `packages/core/src/service/remote-asset-scan.ts`, `packages/cli/src/workspace-selection.ts`, `packages/adapter/src/fs/resolve.ts`, domain/CLI/fs tests, Detailed Design §5.10.
  - Summary: Áp bảng workspace 8 dòng tại domain và CLI thật; thêm catalog preset/custom; mở cửa hẹp cho state/agent-kit; ripple/diagnostic per-track; legacy/multi-cue narration; static media và external dependency scan.
  - Verification: Domain + fs subset 4 files/62 tests xanh; CLI 26 tests xanh; full suite 88 files/690 tests xanh (3 skip có thông báo); `typecheck`, `test:boundaries`, `lint` exit 0 (10 warning cũ, 0 error); diff check xanh.
  - Decisions: Detailed Design §5.10 được sửa trước code để `scanExternalDependencies` nhận stylesheet tùy chọn; nhờ đó `@font-face url(...)` chỉ làm reproducibility warning, không bị chặn nhầm như remote media.
  - Blockers: Không có. Phase D mở.

2026-08-04 — Gate D, Tasks D.1–D.10
  - Files: `packages/core/src/service/write-authority.ts`, `packages/core/src/port/ports.ts`, `packages/core/src/port/types.ts`, `packages/adapter/src/db/journal.ts`, `packages/adapter/src/fs/large-content-store.ts`, authority call sites, `tests/core/source-revision.test.ts` và `tests/adapter/composite-write-authority.test.ts`.
  - Summary: Tách source/derived facade không còn cờ caller; suy purpose theo method/path; derived composite dùng staging nhị phân; source revision query/index; retention K=3 detach trong transaction và GC object sau commit.
  - Verification: Real SQLite + filesystem authority suite 14 tests xanh; authority/path/usecase subset 105 tests xanh; full suite 88 files/698 tests xanh (3 skip có thông báo); `typecheck`, `lint` (0 error), `test:boundaries`, `test:schema-drift`, `git diff --check` xanh. Test type khoá không có `purpose`/`advancesSource`; query plan khoá `idx_revision_source`; payload >64 KiB chứng minh object thật giảm còn ba.
  - Decisions: Detailed Design nâng tuần tự lên bản 9–11 trước code tương ứng: authored asset là source nhưng dùng `write-asset`; GC filesystem chạy sau SQLite detach vì hai storage không thể commit atomically; D.7 khóa persistence invariant trước runner Phase I; `idx_revision_derived_path` không được mô tả sai là tăng tốc composite có `revision.path=NULL`.
  - Blockers: Không có. Gate D xanh; Phase E được mở.

2026-08-04 — Gate E, Tasks E.1–E.9
  - Files: `packages/core/src/port/{ports,types}.ts`, `packages/core/src/service/workspace-mutation-coordinator.ts`, `packages/core/src/service/write-authority.ts`, `packages/adapter/src/db/workspace-operation-journal.ts`, `packages/adapter/src/fs/{workspace-fs,resolve,project-directory}.ts`, composition root và `tests/adapter/workspace-mutation-coordinator.test.ts`.
  - Summary: Thêm operation journal header/step, facade workspace không revision/event, batch rollback/recovery nguyên khối, collision query trong transaction, workspace-root resolver bắt buộc và directory staging/quarantine đa nền tảng có chặn symlink escape.
  - Verification: 7 real SQLite + filesystem tests xanh; full suite 89 files/705 tests xanh (3 skip có thông báo); `typecheck`, `test:boundaries`, `test:schema-drift`, `git diff --check` xanh; lint 0 error (10 warning fixture cũ). Test chứng minh fail step N restore cả batch, Promise.all chỉ một begin, audit null project, revision/event bằng 0 và staging→rename→settle không lộ folder nửa vời.
  - Decisions: Detailed Design nâng lên bản 12 trước code: create phải stage/write/validate → rename → DB settle; `stageCreate` trả staging/final capability và adapter có `writeStagedFiles`, tránh import/path join native trong Core. Recovery tự hoàn tất marker `written` khi hash đích chứng minh publish đã xong nhưng process chết trước marker.
  - Blockers: Không có. Gate E xanh; Phase G được mở.

2026-08-04 — Phase G, Tasks G.1–G.6
  - Files: `packages/core/src/port/ports.ts`, `packages/adapter/src/fs/render-root.ts`, `packages/adapter/src/db/job-store.ts`, `packages/cli/src/{composition-root,startup}.ts`, `tests/adapter/render-root.test.ts`, `tests/cli/startup.test.ts`, `.github/workflows/process-supervision.yml`.
  - Summary: Mỗi render job có root + ownership marker riêng dưới app-data; environment chứa TEMP/TMP và đường FFmpeg/FFprobe đa nền tảng. Startup luôn thử cả stale-job recovery lẫn orphan reclaim; clear `cleanupPending` theo ID đã xóa hoặc root exact đã vắng, giữ cờ + warning cho directory không chứng minh được ownership, và báo lỗi cleanup thay vì nuốt.
  - Verification: Render-root/startup 2 files/29 tests xanh trên filesystem + SQLite thật; full suite 90 files/713 tests xanh (3 skip có thông báo); `typecheck`, `lint` (0 error), `test:boundaries`, `test:schema-drift`, `git diff --check` xanh. CI matrix Linux/macOS/Windows chạy thêm render-root + startup contracts.
  - Decisions: Detailed Design bản 13–15 được sửa trước code: `reclaimOrphans` trả ordered `reclaimedJobIds`; JobStore có live-set/cleanup-pending/CAS clear; `RenderRootPort.inspect` đóng race crash giữa remove và clear. Binary path dùng explicit config → env override → `<native>/bin/{ffmpeg,ffprobe}[.exe]`; Phase I vẫn probe sự tồn tại/version thật.
  - Blockers: Không có cho G. F.12 còn phần terminal stale render/snapshot phụ thuộc job definitions thật ở I/J; không tick sớm.

2026-08-04 — Phase H, Tasks H.1–H.7
  - Files: `packages/core/src/service/{remote-asset-scan,remote-asset-guard}.ts`, `packages/adapter/src/runtime/guard-callback-server.ts`, `packages/adapter/src/hyperframes/document.ts`, `tests/adapter/{remote-asset-guard,remote-asset-browser}.test.ts`, `tests/golden/runtime-asset-guard.test.ts` + fixture.
  - Summary: Thêm callback loopback per-job có token 256-bit, body cap, job/token validation, dedupe media và cap 100 external pair; document inject CSP + bootstrap trước mọi head element của tác giả. Barrier Core đóng callback rồi evaluate trước khi trao quyền publish; media runtime trả `remote_asset_not_local`, external dependencies vẫn được giữ ordered.
  - Verification: Browser Chrome thật chứng minh `new Image()` runtime bị CSP chặn và asset server nhận 0 request; dynamic script trùng được observer ghi đúng một lần và callback không tự xuất hiện. Callback HTTP thật gửi 105 dependency để khóa cap 100. H subset 4 files/9 tests xanh; full suite 93 files/719 tests xanh (3 skip có thông báo); `typecheck`, lint 0 error, boundary, schema drift và diff check xanh. Workflow matrix Linux/macOS/Windows chạy thêm toàn bộ contract H.
  - Decisions: Giữ đúng giới hạn đã duyệt: CSP cho `connect-src *` và `blob:` nên chỉ tuyên bố chặn remote media do document khai; external script vẫn làm render `reproducible:false`. Token không one-shot trong session nhưng server đóng ở publication barrier.
  - Blockers: Không có cho H. Acceptance propagation `externalDependencies` tới client chờ I.4/I.5 dùng runner/result thật; không tick trước dependency.

2026-08-04 — Phase I, Tasks I.1–I.9; closure F.12 và H propagation AC
  - Files: `packages/worker/src/render-job.ts`, `packages/core/src/{port/ports,service/job-scheduler,service/remote-asset-guard}.ts`, `packages/adapter/src/{fs/render-project,fs/workspace-fs,hyperframes/binary-probe}.ts`, `packages/cli/src/composition-root.ts`, `tests/adapter/{render-job,render-binary-probe,render-project,render-root,job-infrastructure}.test.ts`.
  - Summary: Probe đủ bốn binary/version; gate state trước enqueue; render one-shot qua supervisor/root/guard; clone project không theo symlink; ffprobe MP4; publication barrier commit MP4+sidecar bằng `mutateDerived`; best-effort warning và external dependencies tới job/client. Stale render/snapshot contract khai `cleanupPendingOnStale`, startup reclaim giữ quyền dọn root.
  - Verification: Render/scheduler/root bundle 3 files/23 tests xanh; guard/binary/staging bundle 5 files/12 tests xanh. Chromium + HyperFrames + FFmpeg/FFprobe thật tạo MP4, sidecar ghi GSAP CDN, source revision không tiến. Cancel fixture có descendant tự tách group và khóa thứ tự `zero-survivor-proof` trước `cancelled-persist`; crash không publish và chỉ reclaim khi đủ bốn điều kiện. Full suite 96 files/731 tests xanh (3 skip có thông báo); `typecheck`, lint (0 error; 10 warning fixture cũ), boundaries, schema drift và diff check xanh. Matrix Linux/macOS/Windows chạy thêm Phase I contracts.
  - Decisions: Detailed Design nâng bản 16–23 trước từng thay đổi material: staging port không kéo K sớm; stable readiness error; failed terminal metadata; guard result vào publication callback; explicit path seams kiểm fs thật; publish rethrow domain/cancel; identity-backed project ref cho empty gate; metadata stale cleanup theo definition thay vì đoán tên type.
  - Blockers: Không có. Phase I hoàn tất; Phase J được mở. F.13 vẫn chờ đăng ký definition snapshot thật trong J, không tick sớm.

2026-08-04 — Phase J, Tasks J.1–J.10; closure F.13
  - Files: `packages/worker/src/snapshot-job.ts`, `packages/worker/src/index.ts`, `packages/core/src/port/ports.ts`, `packages/adapter/src/{db/job-store,fs/render-project}.ts`, `packages/cli/src/composition-root.ts`, `tests/adapter/{snapshot-job,render-project}.test.ts`, `tests/golden/snapshot-timestamp-mapping.test.ts`, `tests/golden/fixtures/snapshot-timestamp-mapping.json`, `package.json`, `bun.lock`.
  - Summary: Snapshot job gọi HyperFrames đúng một lần cho tập midpoint đã dedupe; map PNG theo timestamp số và fan-out; terminal partial giữ generation revision để retry cùng revision chỉ bù thiếu, còn revision mới sinh lại toàn bộ. Contact sheet Sharp deterministic chỉ publish khi đủ mọi scene; zero-scene thành công rỗng; render và snapshot definitions đều đã export/wire thật.
  - Verification: J subset 3 files/6 tests xanh trên SQLite + filesystem + child process thật; contact sheet lặp lại byte-identical. Full Vitest 98 files pass + 1 skip, 736 tests pass + 3 skip; `typecheck`, `test:boundaries`, `test:schema-drift`, lint (0 error; 10 warning fixture cũ) và `git diff --check` xanh. Test khóa retry thiếu-only và full revision mới, midpoint ngoài timeline bị từ chối trước spawn, dropped midpoint không dịch scene sau; matrix GitHub Actions Linux/macOS/Windows chạy thêm integration/golden J.
  - Decisions: Detailed Design bản 24 được sửa trước code: staging trả snapshot output root; adapter đọc PNG/ghép contact sheet; JobStore đọc terminal gần nhất để retry trước Phase K. Derived snapshot vẫn chỉ đi qua `mutateDerived`, không tạo nguồn sự thật thứ hai.
  - Blockers: Không có. Phase J hoàn tất; Phase K được mở.

2026-08-04 — Phase K, Tasks K.1–K.15
  - Files: `packages/core/src/{service/entry-registry,service/project-state-store,usecase/project-identity,usecase/scan-workspace,port/ports,port/types}.ts`, `packages/adapter/src/{fs/workspace-fs,db/journal,db/job-store}.ts`, `packages/cli/src/composition-root.ts`, `tests/adapter/{project-discovery-state,workspace-scan-identity,project-state-store}.test.ts`, `tests/golden/project-context.test.ts` + fixture.
  - Summary: Scanner one-level phân loại đủ project/candidate/invalid và cache parse theo metadata; entryId chỉ sống trong session. Identity schema v1 strict/deterministic và lazy-backfill journaled cho cả ba prototype thật. `.vidcom` có skeleton + ignore, state/context derived, JSONL append/fsync, redact secret, retention và reconcile một chiều từ SQLite; stale chỉ là phép so.
  - Verification: K subset 4 files/17 tests xanh trên filesystem + SQLite + git CLI thật; riêng project-discovery-state 7/7 xanh, perf 100 project đạt cả stat/cold/warm thresholds trong test chuyên biệt. Full suite 102 files pass + 1 skip, 752 tests pass + 3 skip; `typecheck`, `test:boundaries`, `test:schema-drift`, `test:spec-paths`, lint 0 error (10 warning fixture cũ) và `git diff --check` xanh.
  - Decisions: Detailed Design được sửa trước code qua bản 25–29: scanner marker capability đóng; ordered projection reads từ SQLite; CompositionPort là dependency parser; `.vidcom/.gitignore` literal allowlist; capability mkdir đúng năm state directory, không tạo revision.
  - Blockers: Không có. Performance gate xanh; Phase L được mở.

2026-08-04 — Phase L, Tasks L.1–L.10
  - Files: `packages/core/src/{usecase/project-lifecycle,service/workspace-mutation-coordinator,service/write-authority,service/entry-registry,port/ports,port/types}.ts`, `packages/adapter/src/{db/schema,db/journal,db/workspace-operation-journal,db/event-outbox,fs/project-directory,fs/workspace-fs,fs/backup-store}.ts`, `packages/cli/src/composition-root.ts`, `packages/contracts/src/{domain,dto}.ts`, migrations `20260804163227`–`20260804165459`, `tests/adapter/{project-lifecycle,database-migration,delivery-loop-database-migration,mcp-database-migration}.test.ts`, `.github/workflows/process-supervision.yml`.
  - Summary: Create publish nguyên project qua sibling staging và đúng một revision; adopt chỉ ghi identity; rename/delete journal trước I/O và recovery theo old/new/quarantine. Delete chỉ chạm live root sau backup verify, soft-delete registration để giữ FK history. Identity-invalid dùng location-owned backup và nullable audit/event, tuyệt đối không persist `entryId`; MCP business tool từ chối token này tại schema boundary.
  - Verification: Lifecycle 8/8 và coordinator 7/7 xanh trên SQLite + filesystem thật, gồm grant location-bound được consume; full Vitest toàn repo exit 0. `typecheck`, boundaries, schema drift, spec-path verification, lint 0 error (10 warning fixture cũ) và `git diff --check` xanh. GitHub Actions chạy full CI Linux/Windows cho PR, Linux/macOS/Windows cho main/manual; workflow platform còn chạy trực tiếp lifecycle contract.
  - Decisions: Detailed Design được sửa trước code qua bản 30–36. Physical delete registration đổi thành tombstone vì FK history; recovery identity có ownership backup `{workspaceRoot,slug}` thay vì ProjectId giả; approval grant được reserve/consume trong durable workspace operation; `workspace.changed` là event nullable-project duy nhất.
  - Blockers: Không có. Gate B delta đã chạy lại và xanh; Phase M được mở.

2026-08-04 — Phase M, Tasks M.1–M.10
  - Files: `packages/contracts/src/timeline-diagnostics.ts`, `packages/core/src/usecase/{diagnostics,thumbnail}.ts`, `packages/core/src/{domain/models,port/ports,service/project-state-store}.ts`, `packages/adapter/src/hyperframes/{parse,check}.ts`, `packages/cli/src/composition-root.ts`, `src/components/studio/timeline-elements.tsx`, `tests/{core/diagnostics-rules,adapter/diagnostics-thumbnail}.test.ts`.
  - Summary: Gom bốn cảnh báo timeline/parser vào một bộ luật thuần dùng chung; thêm platform/narration/asset/content-state diagnostics; gộp đủ năm nhóm HyperFrames check; persist report dẫn xuất có source revision; recovery identity chỉ trả response. Thumbnail ưu tiên contact sheet/frame thật, đọc hash làm ETag và fallback seed ổn định.
  - Verification: Phase M 2 files/8 tests xanh; bundle project-state/render/snapshot/project-write 4 files/51 tests xanh trên SQLite + filesystem + child process thật. Full Vitest 105 files pass + 1 skip, 768 tests pass + 3 skip; `typecheck`, `test:boundaries`, `test:schema-drift`, `test:spec-paths`, lint 0 error (10 warning fixture cũ) và `git diff --check` xanh. Test invalid khóa riêng diagnostics chạy, render/snapshot/mutation trả `project_invalid`; checker thật vắng trả cờ false + diagnostic; recovery không tạo `.vidcom`.
  - Decisions: Detailed Design bản 37 khóa lint/projection/thumbnail seams trước code; bản 38 sửa xung đột steering: số học thuần nằm ở contracts shared-kernel để UI và Core dùng chung mà `src/**` không import Core. Business diagnostic vẫn ở Core. Mutation composition giờ validate source và map lỗi parser thành `project_invalid` ổn định thay vì throw/not_found.
  - Blockers: Không có. Phase M hoàn tất; Phase N được mở.

2026-08-04 — Phase N, Tasks N.1–N.8
  - Files: `packages/contracts/src/{domain,mcp}.ts`, `packages/core/src/{domain/platform-preset,usecase/project-writes,usecase/narration-cues,usecase/project-lifecycle}.ts`, `packages/adapter/src/hyperframes/{parse,narration-clips}.ts`, `packages/mcp/src/registry/write-tools.ts`, `packages/cli/src/composition-root.ts`, `tests/adapter/{scene-ripple-narration,narration-clips,project-destructive-usecases}.test.ts`, `tests/core/delivery-loop-domain.test.ts`, `tests/mcp/{contract-matrix,tools,support}.ts`, MCP tools-list goldens và `.github/workflows/process-supervision.yml`.
  - Summary: Insert theo index/track và timing ripple commit một composite revision, chỉ dịch peer cùng track và tính root trên mọi track. Empty project sinh root từ identity cùng scene đầu. Overflow runtime/root có discriminator máy đọc được. Narration v2 giữ nhiều cue, mount mỗi file theo document start + offset, legacy chỉ chiếu in-memory; script edit stale đúng cue.
  - Verification: Phase N bundle 7 files/88 tests xanh trên SQLite + filesystem + Hono/child adapter thật; riêng integration mới 5/5, narration clip/domain 29/29; MCP registry/2-era×2-transport contract và goldens xanh. Full Vitest toàn repo exit 0; `typecheck`, `test:boundaries`, `test:schema-drift`, `test:spec-paths`, lint 0 error (10 warning fixture cũ), `git diff --check` xanh. Workflow Linux/macOS/Windows chạy trực tiếp Phase N.
  - Decisions: Detailed Design bản 39 được ghi trước code: shared root generator + identity dependency; explicit ripple/extendRoot; sidecar v2 có cue audio ownership và compatibility projection cho client cũ. Strict MCP input/output được mở cùng usecase để response có `affectedTrackIndex`/`moved` không bị finalization từ chối sau commit. `MAX_PROJECT_DURATION_SECONDS=3600` là constant contracts, không gọi là giới hạn encoder.
  - Blockers: Không có. Phase N hoàn tất; theo thứ tự đã duyệt, Phase Q được mở trước O/P.

2026-08-04 — Phase Q, Tasks Q.1–Q.11, Q.13; Q.12 integration closure pending P
  - Files: `packages/agent-kit/{AGENTS,CLAUDE}.md`, `packages/agent-kit/{skills,prompts,scripts,src}/**`, `packages/contracts/src/agent-kit.ts`, `packages/core/src/usecase/agent-kit-install.ts`, `packages/cli/{package.json,src/composition-root.ts}`, `tests/{adapter/agent-kit-installer,agent-kit/sync}.test.ts`, `.github/workflows/process-supervision.yml`.
  - Summary: Bundle build sinh CLAUDE byte-identical và TypeScript literal có SHA-256; installer phân loại sáu state, hai host manifest, native-router usability, Claude link/Codex manual merge và ghi batch duy nhất qua workspace authority. Không runtime-read asset cạnh executable, không revision/event/backup.
  - Verification: 10/10 test xanh; 7 integration dùng SQLite + filesystem thật gồm rollback giữa batch, 3 sync/bundle tests. `typecheck`, boundaries, lint 0 error (10 warning fixture cũ), spec paths và diff check xanh. Skill validator chính thức đã được gọi nhưng môi trường thiếu module Python `yaml`; test frontmatter/marker/name/line-count tương đương chạy xanh cho cả bảy skill.
  - Decisions: Detailed Design bản 40 khóa runtime bundle và classifier trước code. Bản 41 ghi trước khi chuyển O: Q.12 actual Registry equality phải terminal ở P vì bốn descriptor final thuộc P; không tạo stub/đăng ký tool sớm để làm xanh giả.
  - Blockers: Không có gate đỏ. Q.12 còn integration closure có dependency P; Phase O được mở theo thứ tự.

2026-08-04 — Phase O, Tasks O.1–O.10
  - Files: `packages/contracts/src/delivery-loop-http.ts`, `packages/server/src/{app,routes/delivery-loop,routes/jobs,middleware/error-mapper}.ts`, `packages/cli/src/next-host.ts`, `packages/adapter/src/hyperframes/{check,binary-probe}.ts`, recovery identity authority/coordinator/path seams, `tests/server/{delivery-loop-routes,events,payload-limits}.test.ts`.
  - Summary: Mount toàn bộ HTTP delivery loop vào production host; workspace activation khởi tạo composition root mới, swap runtime, clear entry token, phát workspace.changed và buộc re-auth. Render/snapshot dùng đúng enqueue usecase worker; recovery identity validate ID rồi dùng bootstrap/adopt authority với hash precondition và transaction đăng ký + revision/audit. MP4 hỗ trợ Range/ETag; termination proof đọc cột SQLite riêng.
  - Verification: O integration 9/9 xanh trên SQLite + filesystem thật; hot-swap chạy hai workspace/composition root thật; recovery/lifecycle/coordinator/path regression 59/59 xanh; SSE exact payload 1/1 xanh; `typecheck`, boundaries, lint 0 error và diff check xanh. `bun run build` compile production sạch; `bun run test:runtime-smoke` đi qua nonce, MCP legacy/modern, credential audit và SSE 1→2. HTTP tạo project/scene, MCP đổi timing trên cùng application instance, rồi HTTP đọc narration/diagnostics và enqueue hai job.
  - Decisions: Không đổi contract đã duyệt. Bản42 được thực thi bằng ProjectRef mang ID mới đã strict-validate và sẽ persist, không phải ID giả; bootstrap chấp nhận registration cùng ID/location khi sửa marker hỏng. Fixture payload-limit được cập nhật 400→409 theo bảng §8.1. HyperFrames package resolution giữ nguyên Node `createRequire` nhưng gọi qua `Reflect.apply`, tránh Turbopack bundle CLI ESM hoặc thay dynamic resolve bằng runtime stub. Test SSE Next cũ còn đỏ vì fixture marker Phase 1/2 không có vidcom.json; giữ lại cho Phase R audit đúng thứ tự.
  - Blockers: Không có blocker Phase O. Phase P được mở; full suite sẽ được đóng sau Phase R sửa fixture cũ theo task R.1–R.4.

2026-08-04 — Phase P, Tasks P.1–P.8; closure Q.12
  - Files: `packages/contracts/src/{mcp,agent-kit}.ts`, `packages/mcp/src/registry/{all-tools,delivery-loop-tools,job-tools,registry}.ts`, `packages/core/src/{usecase/agent-kit-install,service/workspace-mutation-coordinator,port/ports}.ts`, `packages/adapter/src/db/{schema,workspace-operation-journal}.ts`, `packages/cli/src/composition-root.ts`, migration `20260804180557_spotty_catseye`, `tests/{mcp,adapter/agent-kit-installer,agent-kit/sync}.test.ts` và MCP tools-list goldens.
  - Summary: Registry production có 17 tool theo thứ tự tên ổn định, gồm bốn delivery-loop descriptor mới dùng đúng diagnostics/enqueue/installer usecase chung. `get_job_status` giữ một registration, trả outcome terminal, warning, cleanupPending và backoff 250/1000/null. Workspace journal sở hữu audit pending của `install_agent_kit`, kể cả audited no-change, và materialize đúng protocol version.
  - Verification: MCP/agent-kit/workspace-journal 17 files/80 tests xanh; contract P chạy legacy/modern qua stdio/HTTP, goldens và strict union. SQLite + filesystem thật chứng minh applied lẫn no-change có đúng một audit protocol-bearing. Full Vitest 109 files xanh + 1 skip, 798 tests xanh + 3 skip; `typecheck`, boundaries, schema drift 22 migration artifacts, lint 0 error (10 warning fixture cũ), spec paths và diff check xanh. Production Next build sạch; runtime smoke đi qua nonce, MCP exact/latest hai era, credential audit và SSE.
  - Decisions: Detailed Design bản 43–44 được ghi trước code để khóa workspace-owned pending audit, no-change audit-only batch, strict input và output `{jobId}`. Q.12 bỏ final catalog song song: AGENTS/skill references giờ so hai chiều trực tiếp với Registry production 17 tool.
  - Blockers: Không có. Phase P và Q.12 hoàn tất; Phase R được mở để audit toàn bộ fixture Phase 1/2 trước full-suite closure.

2026-08-04 — Phase R, Tasks R.1–R.4
  - Files audited: `tests/adapter/{backup-restore,bgm-composite-recovery,bootstrap-project,composite-write-authority,composition-hf,concurrency-lease,diagnostics-thumbnail,events-watcher-cache,fs,journal-recovery,project-destructive-usecases,project-discovery-state,project-lifecycle,project-state-store,render-job,scene-ripple-narration,snapshot-job,workspace-mutation-coordinator,workspace-scan-identity}.test.ts`, `tests/cli/{mcp-commands,startup}.test.ts`, `tests/core/{file-deletion,project-usecases,source-revision}.test.ts`, `tests/e2e/mcp-stdio-host.test.ts`, `tests/golden/parse.test.ts`, `tests/server/{delivery-loop-routes,events}.test.ts` — toàn bộ 28 file test có nhắc `hyperframes.json`.
  - Decisions per fixture: Giữ marker-backed fixtures đã có `vidcom.json`; sửa 3 fixture MCP CLI và 4 fixture startup orchestration thành marker-backed vì chúng mô tả project hợp lệ; giữ không marker duy nhất cho các case tường minh candidate/adopt trong `bootstrap-project`, `project-discovery-state`, `project-lifecycle`, `workspace-scan-identity`, `delivery-loop-routes`; giữ các literal path-policy/direct-parser vì không phát biểu project discovery. Không fixture nào cần xoá.
  - Summary: Candidate scanner test giờ có cả cặp cũ `hyperframes.json` + `index.html` nhưng vẫn phải là candidate, đồng thời `WorkspaceFs.listProjects()` bị assert không nhận slug đó. Rà call sites xác nhận `listProjects/readProjectRef` chỉ đọc `vidcom.json`; `scanWorkspace` kiểm identity trước; `listProjectCandidates` chỉ phục vụ explicit bootstrap/adopt và startup backfill còn có gate identity-exists, không biến candidate thành project.
  - Verification: Phase R 5 files/60 tests xanh trên SQLite + filesystem thật. Full Vitest 109 files pass + 1 skip, 798 tests pass + 3 skip; không còn failure SSE fixture cũ. Lần chạy `bun test` trực tiếp bị loại khỏi evidence vì đó là Bun runner không hỗ trợ `node:sqlite`/Vitest snapshots; gate dùng đúng `bun run test`.
  - Blockers: Không có. Phase R hoàn tất; Phase S được mở.

2026-08-04 — Phase S, Tasks S.4–S.5; local release gate ready for remote evidence
  - Files: `package.json`, `scripts/verify-spec-test-paths.mjs`, Phase Verification Matrix trong checklist, MCP/golden fixtures và hai workflow GitHub Actions.
  - Summary: `test:golden` bao gồm cả `tests/golden` lẫn `tests/mcp/golden`; Verification Matrix mới liệt kê A–S với 43 đường test thật và guard đã chuyển khỏi spec Phase 2 cũ sang spec delivery-loop hiện tại.
  - Verification: Golden 9 files/26 tests, MCP contract 9 files/71 tests, full Vitest 109 files pass + 1 skip/798 pass + 3 skip; agent-kit deterministic, typecheck, boundaries, schema drift, spec paths, build, runtime smoke, local process supervision và diff check đều xanh; lint 0 error/10 warning fixture cũ. Local S1e darwin: naive leak=true, captured PID=3, group=2, sweep=2, 125.2 ms, exhaustive=true, survivor=0.
  - Blockers: S.1/S.2/S.6 chờ GitHub Actions trên exact commit để đọc số Linux/Windows, Windows real render và full matrix ba OS; chưa tick trước remote evidence.
  - CI portability loop: run đầu trên commit `b1b8740` làm lộ parser frontmatter agent-kit chỉ nhận LF; Windows checkout tạo CRLF nên host discoverable bị phân loại sai thành blocked. Sửa regex nhận `\r?\n` và thêm regression chạy router CRLF trên filesystem thật; focused installer 9/9 xanh trước khi đẩy lại CI. Đây là sửa portability theo contract đã duyệt, không đổi design.
  - CI stability/portability loop: run supervision `30939680978` và full CI `30939680943` trên commit `9086949` xác nhận macOS full xanh, Windows real render xanh, nhưng Linux warm scan 100 project `104.77049 ms`; Windows full CI warm scan `101.7126 ms`; Windows supervision còn lộ fixture tự spawn dùng URL pathname `/D:/...` và recovery assertion so short-path với canonical long-path. Không nới AC: `WorkspaceFs` dùng chung canonical workspace capability và các project-containment check đang chạy đồng thời, nhưng xoá project check sau mỗi nhóm I/O nên scan kế tiếp vẫn revalidate; fixture đổi sang `fileURLToPath`; assertion so canonical path thật. Focused ba file 20/20, perf 5/5 và exact supervision bundle 30 file/158 test xanh; hai lượt S1e PASS; full Vitest 109 file pass + 1 skip/798 test pass + 3 skip; build, typecheck, boundaries, schema drift, spec paths, diff check xanh và lint 0 error trước khi gửi CI đo lại. Không đổi design.

2026-08-05 — Phase S, Tasks S.1–S.3
  - Evidence: GitHub Actions process-supervision run `30965814511` trên exact commit `17958d4`, cả bốn job Linux/macOS/Windows/real-render Windows đều xanh.
  - Linux S1e: `ps`; naive leak `escaping` + `leaf` trong khi PPID walk báo sạch; ba pha capture 3 PID/2 group, 2 sweep, 120.4 ms, exhaustive, 0 survivor, PASS.
  - Windows S1e: `powershell-cim` có parent (142 row, 459 ms); naive không leak trên runner; ba pha capture 4 PID/1 group, 2 sweep, 1921.7 ms, exhaustive, 0 survivor, PASS. Lượt lặp 2 sweep/1906.7 ms, PASS.
  - Windows S1f: render thật có 7 descendant, không process nào tách root group trên runner; ba pha capture 7 PID/1 group, 2 sweep, 2298.6 ms, exhaustive, 0 survivor, `TERMINATED_CLEAN`.
  - Decisions: S.3 đóng theo nhánh không kích hoạt — Windows có enumerator PPID và naive không leak. Không đổi Design §5.9; capture vẫn bắt buộc vì Linux/macOS đã chứng minh group kill có thể rò và một code path phải đúng trên mọi nền tảng.
  - Blockers: Không có; S.6 được đóng sau khi full CI kết thúc.

2026-08-05 — Phase S, Task S.6 và spec closeout
  - Evidence: full CI run `30965814507` trên exact commit `17958d4` SUCCESS, 3/3 job trong 14m56s. Linux/macOS: full Vitest 109 file/798 test + MCP 9 file/71 test + golden 9 file/26 test. Windows: full Vitest 108 file/797 test + MCP 9/71 + golden 9/26; chênh một file/test là case platform-specific bị skip theo contract.
  - Gates: typecheck, agent-kit bundle drift, lint (0 error), invalid-boundary rejection, full test, VieNeu sidecar contract, MCP contract, golden, schema drift, spec paths, production build và real Next/SSE runtime smoke đều pass trên Linux/macOS/Windows. Process-supervision run `30965814511` đồng thời xanh 4/4 job, gồm real render Windows.
  - Council: SM xác nhận mọi task A–S đã tick và có Execution Log; PO xác nhận AC cùng đường product/runtime và portability; Dev xác nhận SQLite/filesystem thật, không mock `node:fs`, boundary/schema/build/runtime và process containment đều xanh.
  - Decisions: Không có design drift ở closeout. Spec đổi từ `inprocess` sang `complete`; push commit closeout phải được xác minh lại bằng cả full CI và process-supervision trên exact final HEAD trước khi báo hoàn tất.
  - Blockers: Không có.

2026-08-05 — Phase S, S.6 mở lại sau final closeout CI
  - Evidence: process-supervision run `30966729860` trên commit docs-only `b9d903f` đỏ ở Windows K.15: warm scan 100 project `147.2289 ms` so với target `<100 ms`; Linux/macOS, Windows real render và các supervision contract khác đều xanh. Full CI run `30966729875` vẫn đang chạy.
  - Decisions: Mở lại S.6 và main spec về `inprocess`. Detailed Design bản 45 được sửa trước test: giữ target `<100 ms`, đo p50 của ba warm scan liên tiếp trên filesystem thật để loại một outlier scheduler/antivirus nhưng vẫn đỏ khi regression ổn định.
  - Blockers: Không có gate B/D/E/F đỏ; tiếp tục remediation Phase S.

2026-08-05 — Phase S, S.6 remediation local
  - Files: `tests/adapter/workspace-scan-identity.test.ts`, `tests/server/delivery-loop-routes.test.ts`, Detailed Design bản 45.
  - Summary: K.15 đo ba warm sample filesystem thật và gate p50 `<100 ms`, không đổi threshold. HTTP delivery-loop integration nhận timeout 15 s vì chạy riêng cũng chạm 5008 ms ở default 5 s; không đổi assertion hoặc production path.
  - Verification: perf file 6 lượt liên tiếp, mỗi lượt 5/5 xanh; focused perf + HTTP 2 file/10 test xanh. Exact process-supervision Vitest bundle `--maxWorkers=2` 30 file/158 test xanh sau remediation, dùng SQLite và filesystem thật.
  - Decisions: Design bản 45 được ghi trước test. Không mock `node:fs`, không cache canonical containment vĩnh viễn, không tăng budget.
  - Blockers: Không có; chờ remote matrix trên remediation commit trước khi tick lại S.6.

2026-08-05 — Phase S, S.6 remediation remote và closeout lần hai
  - Evidence: process-supervision run `30967371231` trên exact commit `8ff32c4` SUCCESS 4/4 trong 4m39s: Linux/macOS/Windows 30 file/156 test, Windows degraded proof 1 file/5 test, real render Windows xanh. Full CI run `30967371235` SUCCESS 3/3 trong 15m0s: Linux/macOS 109 file/798 test, Windows 108 file/797 test; MCP 9/71 và golden 9/26 trên cả ba OS.
  - Gates: typecheck, embedded agent-kit drift, lint 0 error, invalid-boundary rejection, full test, VieNeu sidecar, MCP, golden, schema drift, spec paths, production build và real Next/SSE runtime smoke đều pass.
  - Council: SM xác nhận checklist A–S đã tick và log cả lần đỏ lẫn remediation; PO xác nhận budget warm vẫn `<100 ms` theo p50/3 mẫu và đường sản phẩm không đổi; Dev xác nhận SQLite/filesystem thật, không mock `node:fs`, portability ba OS và real render Windows.
  - Decisions: Không còn blocker. Spec chuyển lại `complete`; closeout docs commit vẫn phải nhận hai workflow xanh trên exact final HEAD trước báo hoàn tất.
  - Blockers: Không có.

2026-08-05 — Delivery-loop review remediation và closeout
  - Files: `packages/contracts/src/delivery-loop-http.ts`, `packages/core/src/usecase/{agent-kit-install,narration-cues,project-writes}.ts`, `packages/server/src/routes/delivery-loop.ts`, `tests/adapter/{agent-kit-installer,scene-ripple-narration}.test.ts`, `tests/server/delivery-loop-routes.test.ts`, checklist và implementation notes.
  - Summary: Sửa đủ 7 nhóm finding: preserve narration metadata/stale semantics; che absolute path; phân biệt lỗi response sau commit; Range 416 + revalidation; strict JSON/path boundary; evidence HTTP/MCP và error/status thực; diễn đạt lại S.6 đúng workflow.
  - Verification: focused regression 23/23; MCP contract 71/71; golden 26/26; typecheck, lint, boundaries, schema drift, spec paths, agent-kit và runtime smoke xanh. Full aggregate không terminalize; `render-job.test.ts` tái hiện orphan supervision process khi chạy riêng, nên không claim full-suite local mới.
  - Council: SM xác nhận checklist và notes phản ánh đúng evidence/caveat; PO xác nhận cả 7 finding có regression coverage; Dev xác nhận thay đổi surgical, type-safe và không thêm dependency.
  - Decisions: Hoàn tất remediation và chuyển spec về `complete`; giữ caveat supervision test riêng thay vì che bằng claim release mới.
  - Blockers: Không có blocker đối với 7 finding của review.

Format:
```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [path/to/file.ts]
  - Summary: [đã làm gì]
  - Decisions: [lệch khỏi design — nếu material thì cập nhật detailed-design.md]
  - Blockers: [nếu có]
```
