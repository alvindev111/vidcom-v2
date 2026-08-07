# Spec Packaging & Distribution Runtime — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) — bản 4, **Approved 2026-08-07** (R2.14 sửa sau khi duyệt, cùng ngày)
> - [Detailed Design](./spec-packaging-and-distribution-detailed-design.md) — bản 2, **Approved 2026-08-07**, gate §15
> - [Main spec](./spec-packaging-and-distribution-pending.md)
> - Spike gate: [phase-4](../../../../spikes/phase-4/README.md) · [S9 Windows/Linux/darwin](../../../../spikes/phase-4/s9-windows-runtime/README.md)

## Context

> [!NOTE]
> Đây là nguồn sự thật trung tâm trong lúc thực thi. Mọi task phải được cập nhật tại đây.
> Công việc persistence chỉ hoàn tất khi có **cả** logic test **và** integration test trên SQLite thật + filesystem thật trong temp directory. **MUST NOT** mock `node:fs` ([steering/10](../../../steering/10-testing.md), Design §11.1).

Checklist chuyển Design bản 2 thành task 1–4 giờ, giữ đúng ranh giới `HTTP/MCP → usecase → port → adapter` của [steering/03](../../../steering/03-architecture-ddd.md) và **bảng component → package ở Design §5.0** — bảng đó là bắt buộc, không phải gợi ý, vì import boundary được cưỡng chế bằng lint.

**Điều làm giai đoạn này khác ba giai đoạn trước**: mọi thứ ở đây chỉ hỏng **trên artifact**. Giai đoạn 1–3 xanh từ source checkout và cả ba đều dựa vào thứ artifact không có. Nên checklist này có một luật xuyên suốt: *một phase chưa xong nếu nó mới chỉ chạy từ checkout.*

**Năm chỗ rủi ro, và cả năm đều đã có bằng chứng đo được** nên rủi ro là *thực thi* chứ không phải *khả thi*:

1. **Hỏng im lặng, không phải lỗi** (Phase D) — hình dạng spawn cũ làm artifact **chạy lại `main` của chính nó**; esbuild **treo vĩnh viễn** nếu thiếu một trong hai env; `hyperframes browser path` trả **exit 0** cho một Chrome cắt cụt. Không có test bắt thì CI xanh trong khi sản phẩm đứng im.
2. **Xoay bearer cắt ngang ba nguồn** (Phase C) — DB, file, `app_settings` không nằm trong một transaction; chết sai chỗ là **MCP hỏng vĩnh viễn** vì clear token chỉ tồn tại trong file.
3. **Tách `startVidcomFoundation`** (Phase E) — `createInfrastructure`/`createApplication` nướng `workspaceRoot` và `leaseId` vào; đổi workspace lúc runtime là tear-down + rebuild toàn bộ foundation trong khi listener còn sống.
4. **`output: 'export'` chạm FE nhiều hơn tưởng** (Phase G) — `generateStaticParams` không sống được trong `"use client"`, payload RSC hard-code sentinel nên `params` luôn trả `__shell`.
5. **Encoding tiếng Việt trên Windows** (Phase D) — interpreter đóng băng lấy encoding từ codepage ANSI; Phase 3 đã chống bằng `allowlistedEnvironment`, và Giai đoạn 4 rất dễ làm rơi đúng lúc nối dây lại.

## Approval Gate

> Không viết production code cho tới khi mục này được người dùng xác nhận tường minh.

- **Status**: **Pending Confirmation**
- **Confirmed by**: —
- **Confirmation date**: —
- **Notes**: Design gate §15 đã mở (alvin0, 2026-08-07) nên checklist này được phép tồn tại. Nhưng **Code Execution vẫn bị chặn** cho tới khi chính mục này được duyệt — đây là gate thứ hai và độc lập.

## Sequencing Strategy

**Chosen strategy**: **Hybrid — Foundation-First + Risk-First**.

**Rationale**: runtime phải có mặt trên đĩa trước khi bất cứ thứ gì khác chạy được trên artifact (Foundation-First: A → B → C). Nhưng **Phase D được kéo lên ngay sau C** dù nhiều phase khác cũng chỉ phụ thuộc C: nó chứa cả ba chế độ hỏng-im-lặng đã đo được, và nếu chúng lộ ra ở tuần cuối thì mọi phase render/TTS/doctor phía sau đã xây trên cát. Bề mặt UI và bridge chỉ nối sau khi Core chứng minh được ba bất biến: extraction nguyên tử, đúng một writer, và toolchain gọi được từ artifact.

## Dependency Order

```text
A Contract & error baseline
└─→ B Runtime manifest + archive + extraction — GATE
    └─→ C Bootstrap ordering + hai lock + credential reconciliation — GATE
        ├─→ D Toolchain từ artifact — GATE  (rủi ro cao nhất, kéo lên sớm)
        │   └─→ J CLI mode + doctor
        └─→ E Host/foundation split + lease loss ba lối — GATE
            ├─→ F Filesystem browser API
            │   └─→ G Frontend: http-driver + export + picker + New video
            │       └─→ H SEA build + static asset host
            ├─→ I Daemon discovery + bridge + attachment
            └─→ K Import project
H ─→ L Hygiene & provenance
tất cả ─→ M Packaged smoke ba nền tảng
```

**Recommended execution order**: A → B → C → **D** → E → F → G → H → I → J → K → L → M

> D đứng trước E dù E không phụ thuộc D: D là chỗ duy nhất trong spec có **ba chế độ hỏng không sinh lỗi**, và giá trị lõi của sản phẩm (render ra MP4 có tiếng) nằm sau nó. Phát hiện muộn ở đây đắt hơn mọi phase khác.

**Parallelizable**: D song song được với E/F sau khi C xanh (khác package, khác file). K song song được với I sau khi E xanh. L song song được với I/J/K sau khi H xanh.

---

## LLM Agent — Skill Activation Per Phase

> [!IMPORTANT]
> Trước khi implement mỗi phase, MUST activate skill tương ứng và đọc file nguồn liệt kê ở cột phải.

| Phase | Skills to activate | Source files to read BEFORE modifying |
|---|---|---|
| A | — | [`contracts/src/delivery-loop-http.ts`](../../../../packages/contracts/src/delivery-loop-http.ts) (FULL) · [`core/src/port/types.ts`](../../../../packages/core/src/port/types.ts) (search `ErrorCode`) |
| B | `.agents/skills/bun/SKILL.md` | [`credential-store.ts`](../../../../packages/adapter/src/fs/credential-store.ts) (FULL — `secureAppDataDirectorySync` là mẫu ACL) · [spike S1b](../../../../spikes/phase-4/README.md) |
| C | — | [`workspace-selection.ts`](../../../../packages/cli/src/workspace-selection.ts) (FULL — migrate 2 lần + ghi `active_workspace` là tác dụng phụ) · [`mcp-credential-service.ts`](../../../../packages/core/src/service/mcp-credential-service.ts) (FULL) · [`db/mcp-credential.ts`](../../../../packages/adapter/src/db/mcp-credential.ts) (FULL) |
| D | `.agents/skills/bun/SKILL.md` | [`binary-probe.ts`](../../../../packages/adapter/src/hyperframes/binary-probe.ts) (FULL — **hai** chỗ spawn) · [`vieneu-sidecar-path.ts`](../../../../packages/adapter/src/tts/vieneu-sidecar-path.ts) (FULL) · [`process-environment.ts`](../../../../packages/adapter/src/runtime/process-environment.ts) (FULL) · [`tts-vieneu.ts`](../../../../packages/adapter/src/tts/tts-vieneu.ts) (search `HF_HOME`) · [S1a/S1b/S3](../../../../spikes/phase-4/README.md) |
| E | `.agents/skills/hono/SKILL.md` | [`startup.ts`](../../../../packages/cli/src/startup.ts) (FULL — `createInfrastructure`/`createApplication` nướng root+leaseId) · [`next-host.ts`](../../../../packages/cli/src/next-host.ts) (FULL — `onLeaseLost` hiện giữ listener) · [S6](../../../../spikes/phase-4/README.md) |
| F | `.agents/skills/hono/SKILL.md` | [`workspace-resolver.ts`](../../../../packages/core/src/domain/workspace-resolver.ts) (FULL) · [`workspace-fs.ts`](../../../../packages/adapter/src/fs/workspace-fs.ts) (search `resolveWorkspace`) · [S8 worker eval](../../../../spikes/phase-4/README.md) |
| G | `.agents/skills/http-driver/SKILL.md` | [`src/lib/api/browser-session.ts`](../../../../src/lib/api/browser-session.ts) (FULL) · [`src/app/projects/[slug]/page.tsx`](../../../../src/app/projects/%5Bslug%5D/page.tsx) (FULL — đang là `"use client"`) · [`new-project-card.tsx`](../../../../src/components/home/new-project-card.tsx) (FULL) · [S2](../../../../spikes/phase-4/s2-export) · [S9 cookie matrix](../../../../spikes/phase-4/s9-windows-runtime/README.md) |
| H | `.agents/skills/bun/SKILL.md`, `.agents/skills/hono/SKILL.md` | [`next.config.ts`](../../../../next.config.ts) (FULL) · [`src/app/api/[[...route]]/route.ts`](../../../../src/app/api/%5B%5B...route%5D%5D/route.ts) (FULL — phải biến mất khỏi build export) · [spike phase-0 SEA](../../../../spikes/phase-0/README.md) |
| I | `.agents/skills/mcp-builder/SKILL.md` | [`commands/mcp.ts`](../../../../packages/cli/src/commands/mcp.ts) (FULL) · [`commands/credential.ts`](../../../../packages/cli/src/commands/credential.ts) (FULL) · [steering/13](../../../steering/13-mcp-protocol-compatibility.md) (FULL) · [S7](../../../../spikes/phase-4/README.md) |
| J | — | [`main.ts`](../../../../packages/cli/src/main.ts) (FULL — `parseVidcomCommand` coi mọi `--` là `app`) · [`project-reads.ts`](../../../../packages/core/src/usecase/project-reads.ts) (search `resolveProjectIdBySlug`) |
| K | — | [`db/schema.ts`](../../../../packages/adapter/src/db/schema.ts) (search `workspace_operation`, `uq_job_idempotency`) · [`bootstrap-project.ts`](../../../../packages/core/src/usecase/bootstrap-project.ts) (FULL) |
| L | — | [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml) (FULL) |
| M | — | [`.github/workflows/phase4-python-stack.yml`](../../../../.github/workflows/phase4-python-stack.yml) (FULL — mẫu job đo đã chạy thật) · [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md) |

**Steering đọc một lần trước khi bắt đầu**: [01 stack](../../../steering/01-backend-stack.md) §3 (bốn câu hỏi dependency), §5 (danh sách cấm) · [02 layout](../../../steering/02-project-layout.md) §2 (**import boundary — lint cưỡng chế**) · [03 DDD](../../../steering/03-architecture-ddd.md) §2.2 · [04 API](../../../steering/04-api-design.md) §10 (thứ tự middleware) · [06 validation](../../../steering/06-validation.md) §2, §5 · [07 data](../../../steering/07-data-and-storage.md) §0 (**schema strict**) · [08 jobs](../../../steering/08-jobs-and-queue.md) §6.1 (**zero-survivor đã bị rút lại**) · [09 security](../../../steering/09-security.md) §2 · [10 testing](../../../steering/10-testing.md) · [11 code style](../../../steering/11-code-style.md).

---

## Phase Verification Matrix

Mỗi phase chạy focused command dưới đây trên SQLite/filesystem thật, rồi `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run test:boundaries` khi chạm boundary, và `rtk git diff --check`. Phase M chạy toàn bộ gate trên ba OS qua GitHub Actions.

| Phase | Focused verification command |
|---|---|
| A | `rtk bunx vitest run tests/contracts/packaging-contracts.test.ts` |
| B | `rtk bunx vitest run tests/adapter/runtime-archive.test.ts tests/adapter/runtime-asset-manager.test.ts` |
| C | `rtk bunx vitest run tests/adapter/bootstrap-coordinator.test.ts tests/adapter/bridge-credential-lifecycle.test.ts tests/adapter/database-migration.test.ts` |
| D | `rtk bunx vitest run tests/adapter/vidcom-node-shim.test.ts tests/adapter/compiler-guard.test.ts tests/adapter/render-binary-probe.test.ts tests/adapter/vieneu-frozen-interpreter.test.ts` |
| E | `rtk bunx vitest run tests/cli/foundation-manager.test.ts tests/cli/loopback-host.test.ts tests/cli/lease-loss.test.ts` |
| F | `rtk bunx vitest run tests/core/filesystem-browser.test.ts tests/server/system-routes.test.ts tests/adapter/browse-worker.test.ts` |
| G | `rtk bunx vitest run tests/frontend/api-driver.test.ts` và `rtk bun run test:browser-session` |
| H | `rtk bunx vitest run tests/adapter/sea-static-host.test.ts tests/server/payload-limits.test.ts` và `rtk bun run build:artifact` |
| I | `rtk bunx vitest run tests/adapter/daemon-discovery.test.ts tests/mcp/bridge-registry-parity.test.ts tests/cli/bridge-attachment.test.ts` |
| J | `rtk bunx vitest run tests/cli/cli-modes.test.ts tests/cli/doctor.test.ts tests/golden/doctor-report.test.ts` |
| K | `rtk bunx vitest run tests/adapter/project-import.test.ts tests/adapter/workspace-mutation-coordinator.test.ts` |
| L | `rtk bunx vitest run tests/build/artifact-provenance.test.ts` |
| M | `rtk bun run test:packaged-smoke` trên macOS arm64, Windows x64, Linux x64 |

---

## Task Status Legend

- `[ ]` — Not started
- `[/]` — In progress
- `[x]` — Complete (implemented, tested, validated)
- `[!]` — Blocked (kèm ghi chú nêu blocker)

---

## Phase A: Contract & error baseline

**Addresses**: R1.7, R2.x, R3.8, R6.5 · **Design**: §5.0, §7.0, §8.1
**Files affected**: `packages/contracts/src/*`, `packages/core/src/port/types.ts`
**Prerequisite**: None
**Estimate**: 5 SP

**Tasks**:
- [ ] A.1 Thêm `ErrorCode` mới
  - `bridge_credential_unavailable`, `bridge_credential_invalid`, `bridge_rotation_in_progress`, `download_tls_untrusted`, `payload_too_large`, `workspace_lease_lost`, `daemon_identity_mismatch`, `daemon_unavailable`, `compiler_unavailable`, `runtime_manifest_invalid`, `runtime_extraction_incomplete`, `bootstrap_lock_timeout`, `path_timeout`, `browse_token_invalid`, `project_import_conflict`
  - _Requirements: R1.7, R2.7, R6.5_ — _Design: §8.1_
- [ ] A.2 Thêm DTO của R1 vào `contracts`
  - `BrowseRootDto`, `BrowseEntryDto`, `BrowsePage`, request/response của §7.1–§7.3, `SystemWorkspaceDto` với state union **gồm `reacquiring`**, `SystemRuntimeDto`
  - Mọi schema **`strict`** — field lạ bị từ chối, không bỏ qua âm thầm
  - _Requirements: R1.1, R1.2, R1.7_ — _Design: §7.1–§7.4, §7.7b_
- [ ] A.3 Thêm DTO của bridge vào `contracts`
  - Handshake request/response, attachment create/renew, tool invoke envelope
  - _Requirements: R2.13, R2.15_ — _Design: §7.8–§7.10_
- [ ] A.4 **Chuyển schema tool sang `contracts`**
  - Đây là điều kiện để route `/api/bridge/v1/tools/:name` bên `server` validate được: lint **cấm** `server` import `mcp` ([steering/02](../../../steering/02-project-layout.md) §2). Definition/handler ở lại `packages/mcp`; chỉ **schema** chuyển đi
  - _Requirements: R2.3, R2.11_ — _Design: §5.0_
- [ ] A.5 Thêm `runtime.caBundlePath` vào schema `setting.json` + env `VIDCOM_CA_BUNDLE`
  - `setting.json` là **schema strict** ([steering/07](../../../steering/07-data-and-storage.md) §0): key lạ là **lỗi khởi động**, nên không thêm vào schema thì người dùng làm theo hướng dẫn của `doctor` sẽ không boot được
  - _Requirements: R6.5_ — _Design: §5.13_
- [ ] A.6 Thêm event mới vào contract SSE
  - `workspace.lease_lost`, `workspace.reattached`, `runtime.preparing`, `runtime.ready`
  - _Requirements: R2.8, R5.11_ — _Design: §7.7_
- [ ] A.7 Contract test
  - Mọi schema mới từ chối field lạ; state union có đủ 6 giá trị; error code round-trip
  - _Requirements: R1.7_

**Acceptance Criteria**:
- [ ] `rtk bun run typecheck` xanh — mọi `switch` trên `ErrorCode` đã xử lý nhánh mới
- [ ] `rtk bun run test:boundaries` xanh — `server` **không** import `mcp` sau khi chuyển schema

**Deliverables**: `packages/contracts/src/**` · `packages/core/src/port/types.ts`

---

## Phase B: Runtime manifest + archive + extraction — **GATE**

**Addresses**: R5.1–R5.6, R5.9, R5.10, R5.12 · **Design**: §4.5, §5.13, §5.14
**Files affected**: `packages/adapter/src/runtime/runtime-asset-*.ts`, `scripts/build-runtime-archives.mjs`, `package.json`
**Prerequisite**: A
**Estimate**: 13 SP

**Tasks**:
- [ ] B.1 Nâng `tar@7.5.22` thành dependency trực tiếp
  - Bốn câu hỏi của [steering/01](../../../steering/01-backend-stack.md) §3 đã trả lời ở Design §5.0 — chép kết luận vào commit message, không trả lời lại
  - _Requirements: R5.1_ — _Design: §5.0, §4.5_
- [ ] B.2 `EmbeddedRuntimeManifest` + `RuntimeAssetSource`
  - Đọc qua `node:sea.getRawAsset`; manifest pin Node, HyperFrames, esbuild, FFmpeg, CPython, VieNeu, motion
  - Dev/test dùng nguồn filesystem để chạy được ngoài SEA
  - _Requirements: R5.1, R5.5_ — _Design: §5.13_
- [ ] B.3 Script build archive theo `<os>-<arch>`
  - `.tar.gz` deterministic; **fail** nếu tập package Python lệch *(core 55 + phần phụ platform)*; `pip` **có mặt là fail**
  - Số đã đo: darwin 481 MB/145 MB · Windows 499/152 (+`colorama`,`tzdata`) · Linux 595/179
  - _Requirements: R5.1, R5.14_ — _Design: §5.13, DR-15_
- [ ] B.4 Extractor an toàn
  - Từ chối absolute path, `..`, symlink/hardlink, special file; chỉ regular file/dir trong allowlist; áp lại mode từ manifest; Windows dùng ACL
  - _Requirements: R5.2, R5.4_ — _Design: §4.5_
- [ ] B.5 `RuntimeAssetManager`: `ensureAll`/`inspect`/`repair`/`pruneOldVersions`
  - Target `<app-data>/native/<artifact-version>/<archive-key>/`; giải nén vào temp **cùng filesystem** rồi rename; `.ready-<sha>` viết **sau cùng**; `current.json` atomic
  - _Requirements: R5.2, R5.3, R5.10_ — _Design: §5.14_
- [ ] B.6 App-data `0700`/ACL
  - Dùng lại `secureAppDataDirectorySync` đang có, MUST NOT viết đường thứ hai
  - _Requirements: R5.9_ — _Design: §9.2_
- [ ] B.7 Logic test
  - Manifest parse/verify; resolver chọn đúng archive theo platform; thiếu archive ⇒ lỗi nói rõ nền tảng nào được hỗ trợ
  - _Requirements: R5.5_
- [ ] B.8 Integration test trên filesystem thật
  - Traversal/symlink/special-file bị từ chối; kill giữa chừng ở **từng pha** (extract, validate, rename, marker) ⇒ lần sau coi là chưa giải nén và làm lại; xoá `native/**` bằng tay ⇒ dựng lại được
  - _Requirements: R5.3, R5.4, R5.10_ — _Design: §11.2_
- [ ] B.9 Integration test: hai tiến trình cold-start đồng thời
  - Đúng **một** tiến trình giải nén; tiến trình kia chờ hoặc dùng kết quả, MUST NOT ghi chồng
  - _Requirements: R5.6_

**Acceptance Criteria**:
- [ ] Giải nén không ghi gì vào workspace hay cạnh artifact (R5.12)
- [ ] Warm path không giải nén lại — chỉ đọc manifest/marker
- [ ] Build fail khi tập package Python lệch một dòng

**Deliverables**: `packages/adapter/src/runtime/runtime-asset-source.ts` · `runtime-asset-manager.ts` · `scripts/build-runtime-archives.mjs`

---

## Phase C: Bootstrap ordering + hai lock + credential reconciliation — **GATE**

**Addresses**: R5.13, R2.5 · **Design**: §4.4, §4.5, §5.1, §5.15, §6.4
**Files affected**: `packages/cli/src/bootstrap-coordinator.ts`, `packages/cli/src/workspace-selection.ts`, `packages/adapter/src/fs/credential-store.ts`
**Prerequisite**: B
**Estimate**: 16 SP

**Tasks**:
- [ ] C.1 `BootstrapCoordinator.prepare()`
  - Thứ tự khoá: `extract → migrate (một lần) → credential reconciliation → release`. Callers MUST NOT tự gọi migration/extraction
  - _Requirements: R5.13_ — _Design: §5.1_
- [ ] C.2 Hai lock atomic-mkdir + stale probe
  - `runtime-bootstrap.lock` (extraction+migration) và `credential.lock` (bearer). Thứ tự lấy **luôn** `bootstrap → credential`, không bao giờ ngược — đây là **luật**, không phải hệ quả của thứ tự code hôm nay
  - Windows không dựa vào unlink file đang mở; rename lock dir sang quarantine
  - _Requirements: R5.6, R5.13_ — _Design: §5.15_
- [ ] C.3 Migration đúng một lần mỗi boot
  - Hôm nay `selectWorkspace` migrate **hai** lần rồi foundation migrate lần ba ([`workspace-selection.ts:23-30`](../../../../packages/cli/src/workspace-selection.ts#L23), [`:57-60`](../../../../packages/cli/src/workspace-selection.ts#L57))
  - _Requirements: R5.13_ — _Design: §4.5_
- [ ] C.4 **Tách việc ghi `active_workspace` khỏi `selectWorkspace`**
  - Hôm nay resolve nào cũng `set("active_workspace", …)`, nên `vidcom render --workspace X` **đổi luôn workspace mặc định của UI**. Chỉ `FoundationManager.activate` thành công mới được ghi
  - Đây là **thay đổi hành vi có chủ ý**, không phải bất biến giữ nguyên
  - _Requirements: R1.5_ — _Design: §6.4, §7.13_
- [ ] C.5 Mint/load bridge bearer
  - Dùng lại [`BridgeCredentialStore`](../../../../packages/adapter/src/fs/credential-store.ts#L86) và đường dẫn `<app-data>/credentials` **đang có** — MUST NOT tạo file mới. Ghi id vào `app_settings.bridge_credential_id`; label `system:bridge` chỉ để hiển thị
  - _Requirements: R2.5_ — _Design: §4.4, §6.4_
- [ ] C.6 Xoay bearer bốn bước
  - `rotate(id, 60_000)` → ghi file atomic → cập nhật `app_settings` → revoke attachment. Overlap **60 s, không phải 0** (0 mở cửa sổ giữa DB commit và rename file, nơi client tiêu hết một lần đọc lại rồi chết)
  - `credential rotate --bridge` tra id từ `app_settings`; `credential revoke <id-bridge>` **bị từ chối**
  - _Requirements: R2.5_ — _Design: §4.4_
- [ ] C.7 Reconciliation mọi boot
  - Bất biến: **file là secret duy nhất, DB/settings là projection**. Bốn nhánh theo bảng §4.4; replacement mồ côi nhận qua `rotated_from`; row `active` label `system:bridge` không phải `S` bị revoke
  - _Requirements: R2.5_ — _Design: §4.4, §5.1_
- [ ] C.8 Migration `workspace_operation.kind += project_import`
  - Forward-only; rebuild bảng nếu check constraint đòi; giữ nguyên id/status
  - _Requirements: R7.6_ — _Design: §6.5_
- [ ] C.9 Logic test
  - Thứ tự bốn bước; bảng bốn nhánh reconciliation; luật thứ tự khoá
  - _Requirements: R5.13, R2.5_
- [ ] C.10 Integration test trên SQLite + fs thật — **kill ở từng ranh giới**
  - Kill sau DB rotate, restart **trong** 60 s ⇒ revoke mồ côi + xoay lại; restart **sau** 60 s ⇒ **mint mới**; kill sau ghi file ⇒ **roll forward** `S`, không mint; kill sau settings ⇒ tự lành
  - File bị xoá ⇒ mint mới; `hash(F)` khớp row `revoked` ⇒ nhánh mint, không phải roll-forward
  - _Requirements: R2.5_ — _Design: §11.3_
- [ ] C.11 Integration test: hai `rotate --bridge` song song + reconciliation đè lên rotate đang dở
  - Khoá serialize; kẻ chờ quá hạn nhận `bridge_rotation_in_progress`
  - _Requirements: R2.5_
- [ ] C.12 Integration test: migration trên fixture DB Phase 3 thật
  - Row count/kind distribution trước-sau, `foreign_key_check=0`, schema drift
  - _Requirements: R7.6_ — _Design: §6.5_

**Acceptance Criteria**:
- [ ] Migration chạy **đúng một lần** trong một boot, đo bằng counter chứ không bằng đọc code
- [ ] Mọi nhánh kill ở C.10 kết thúc bằng một bridge **nối lại được**
- [ ] Không nhánh nào để lại hơn một row `active` mang label `system:bridge`

**Deliverables**: `packages/cli/src/bootstrap-coordinator.ts` · `packages/cli/src/workspace-selection.ts` · `packages/adapter/src/fs/credential-store.ts` · migration mới

---

## Phase D: Toolchain từ artifact — **GATE**, rủi ro cao nhất

**Addresses**: R5.7, R5.8, R6.1–R6.11 · **Design**: §4.6, §5.16, §5.17, §5.18
**Files affected**: `packages/cli/src/main.ts`, `packages/adapter/src/hyperframes/binary-probe.ts`, `packages/adapter/src/tts/*`, `packages/adapter/src/runtime/process-environment.ts`
**Prerequisite**: C
**Estimate**: 25 SP

**Tasks**:
- [ ] D.1 Sentinel `--vidcom-node`
  - Dispatch **trước** parser công khai, chỉnh `process.argv` rồi dynamic-import **chỉ** script dưới verified `native/hyperframes` root. MUST NOT xuất hiện trong help hay danh sách mode của R3.11
  - Hôm nay [`parseVidcomCommand`](../../../../packages/cli/src/main.ts#L34) coi mọi argv bắt đầu bằng `--` là `vidcom app` — sentinel rơi thẳng vào đó
  - _Requirements: R6.2_ — _Design: §4.6, §5.16_
- [ ] D.2 Sửa **cả hai** chỗ spawn
  - `NodeRenderBinaryProbe` trả `[execPath, "--vidcom-node", cliPath]`; và chỗ thứ hai `[execPath, cliPath, "browser", "path"]` ([`binary-probe.ts:66-70`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L66)) — **cả hai** đều làm artifact chạy lại `main` của chính nó, và **không sinh lỗi**
  - _Requirements: R6.2, R6.4_ — _Design: §4.6_
- [ ] D.3 Nối dây resolve toolchain ở composition root
  - `hyperframesCliPath`, `hyperframesPackagePath`, `motionLibraryRoot`, `nativeDependenciesRoot`, `browserCacheRoot` bắt buộc ở artifact; `require.resolve` chỉ còn dev/test
  - `motionLibraryRoot` hôm nay **không entrypoint nào truyền** — đây là bẫy 4.8
  - _Requirements: R5.7, R5.8, R6.3_ — _Design: §5.16_
- [ ] D.4 `CompilerGuard`
  - Đặt **cả hai** `ESBUILD_BINARY_PATH` và `ESBUILD_WORKER_THREADS=0`; timeout bắt buộc cho mọi lời gọi in-process chạm compiler. Thiếu **bất kỳ** cái nào ⇒ **treo vĩnh viễn, không một dòng stderr**
  - _Requirements: R6.10, R6.11_ — _Design: §5.17_
- [ ] D.5 **Ép** `PYTHONUTF8`/`PYTHONIOENCODING`
  - Đổi `??=` thành ghi đè vô điều kiện trong [`allowlistedEnvironment`](../../../../packages/adapter/src/runtime/process-environment.ts#L19); mọi child (sidecar, shim, FFmpeg, Chromium) đi qua helper đó
  - Đo được ở S9/N-2: interpreter đóng băng lấy encoding từ codepage ANSI (`cp932` trên máy đo) ⇒ in tiếng Việt là `UnicodeEncodeError`
  - _Requirements: R6.7_ — _Design: §4.6, §5.16_
- [ ] D.6 VieNeu chạy interpreter đóng băng
  - `defaultVieNeuCommand` hôm nay trả `["python3"|"python", worker.py]`; đổi sang đường dẫn tuyệt đối tới interpreter đã giải nén. Giữ override `~/.vidcom/setting.json`
  - `HF_HOME` trỏ app-data; warm offline đặt `HF_HUB_OFFLINE=1` — hôm nay [`tts-vieneu.ts:322-327`](../../../../packages/adapter/src/tts/tts-vieneu.ts#L322) **không** đặt cờ này
  - _Requirements: R6.5, R6.7_ — _Design: §4.6_
- [ ] D.7 `runtime.caBundlePath` xuống cả hai loại child
  - `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE` cho sidecar; `NODE_EXTRA_CA_CERTS` cho child Node. MUST NOT tắt xác minh chứng chỉ, MUST NOT tự nhặt CA từ trust store OS
  - _Requirements: R6.5_ — _Design: §5.13_
- [ ] D.8 Download cache coordinator
  - Per-component lock, partial marker, timeout. Partial marker là **nguồn sự thật duy nhất**: `hyperframes browser path` trả exit 0 cho binary 1 MB (đo ở S9)
  - _Requirements: R6.5_ — _Design: §5.18_
- [ ] D.9 Cảnh báo version skew HyperFrames
  - Project khai version khác artifact ⇒ cảnh báo có mã, MUST NOT im lặng render bằng version khác, MUST NOT tự nâng file người dùng
  - _Requirements: R6.9_ — _Design: §5.18_
- [ ] D.10 Logic test
  - Shim từ chối script ngoài runtime root; hình dạng spawn cũ bị test bắt (nếu không có test thì nó quay lại mà CI vẫn xanh)
  - _Requirements: R6.2, R6.4_
- [ ] D.11 Integration test — ba chế độ hỏng im lặng
  - Thiếu **mỗi** env của esbuild ⇒ lỗi có mã trong timeout, **không bao giờ treo**; Chrome cắt cụt ⇒ check fail (thực thi `--version`, không hỏi CLI); sidecar in tiếng Việt với `PYTHONUTF8=""` ⇒ fail có mã, không ra chuỗi hỏng
  - _Requirements: R6.11, R6.5, R6.7_ — _Design: §11.3_
- [ ] D.12 Integration test: mọi điểm spawn đi qua `allowlistedEnvironment`
  - Liệt kê điểm spawn và chứng minh không điểm nào tự dựng env — nếu không, hai bảo vệ UTF-8 và caBundlePath biến mất mà không ai thấy
  - _Requirements: R6.7, R6.8_
- [ ] D.13 Integration test: huỷ giữa chừng
  - **Termination proof có cờ `exhaustive`**, MUST NOT phát biểu thành "không còn tiến trình con" ([steering/08](../../../steering/08-jobs-and-queue.md) §6.1 đã rút lại bảo đảm đó). Còn survivor sau khi cạn lượt ⇒ `process_termination_unverified`, MUST NOT ghi `cancelled`. Workdir có marker thu hồi được thứ lọt qua
  - _Requirements: R6.8_ — _Design: §4.6, §11.4_

**Acceptance Criteria**:
- [ ] Render MP4 **từ artifact** trên máy không có Node và không có Python trên PATH
- [ ] `install_motion_library` vendor được mà không cần `node_modules`, version khớp catalogue
- [ ] Không đường nào chạm compiler mà thiếu timeout

**Deliverables**: `packages/cli/src/main.ts` · `binary-probe.ts` · `compiler-guard.ts` · `vieneu-sidecar-path.ts` · `tts-vieneu.ts` · `process-environment.ts`

---

## Phase E: Host/foundation split + lease loss ba lối — **GATE**

**Addresses**: R1.12, R1.13, R1.17, R1.18, R2.1, R2.12, R2.14, R4.4 · **Design**: §4.3, §5.3, §5.4
**Files affected**: `packages/cli/src/startup.ts`, `packages/cli/src/foundation-manager.ts`, `packages/cli/src/loopback-host.ts`, `packages/cli/src/next-host.ts`
**Prerequisite**: C
**Estimate**: 17 SP

**Tasks**:
- [ ] E.1 Tách `startVidcomFoundation`
  - Thành `prepareFoundation` (không listener) + lifecycle handle `stop()` idempotent. `createInfrastructure(config)` nướng `workspaceRoot` và `createApplication(infra, leaseId)` nướng `leaseId` ([`startup.ts:154`](../../../../packages/cli/src/startup.ts#L154), [`:216`](../../../../packages/cli/src/startup.ts#L216)) — đổi workspace là tear-down + rebuild toàn bộ
  - _Requirements: R1.12_ — _Design: §5.3_
- [ ] E.2 `LoopbackHost` + `currentApp` đổi được
  - Listener đọc `currentApp` mỗi request; swap là assignment đồng bộ; `/api/**` vào Hono app, còn lại vào static host
  - _Requirements: R1.17, R4.4_ — _Design: §5.4_
- [ ] E.3 Trạng thái "chưa chọn workspace"
  - Bootstrap app chỉ đăng ký `/v1/auth/*`, `/v1/system/*`, `/v1/health` — **không** `/api/bridge/**`. MUST NOT im lặng nhận `cwd` làm workspace
  - _Requirements: R1.17_ — _Design: §4.5_
- [ ] E.4 `FoundationManager.activate` + switch có rollback
  - Mutex; canonicalize trước khi đụng foundation cũ; job non-terminal ⇒ `workspace_busy`; `503 workspace_switching` cho mutation; swap một lần; rollback về foundation cũ, thất bại thì `NoWorkspace`
  - _Requirements: R1.12, R1.18_ — _Design: §4.3_
- [ ] E.5 Lease loss ba lối
  - Renew fail ⇒ từ chối ghi **ngay** + xoá discovery record **ngay** → re-acquire tối đa 2 lượt trong TTL 30 s → thành công thì `Active` với **`instanceId` cũ**; thất bại thì `NoWorkspace` (có UI attach) hoặc đóng listener + exit ≠ 0 (headless)
  - Phát `workspace.lease_lost` **trước** khi đổi trạng thái
  - _Requirements: R2.14_ — _Design: §4.3, DR-14_
- [ ] E.6 Giữ nguyên perimeter
  - Loopback-only, kiểm `Host`, giới hạn origin — R1 MUST NOT nới bất kỳ luật nào
  - _Requirements: R1.13_ — _Design: §9.2_
- [ ] E.7 Logic test
  - State machine: mọi transition hợp lệ và mọi transition bị cấm
  - _Requirements: R1.12, R2.14_
- [ ] E.8 Integration test: đổi workspace
  - Nhả lease cũ, lấy lease mới, refresh project **không restart tiến trình**; `active_workspace` chỉ ghi **sau** swap thành công; job đang chạy ⇒ từ chối có lý do
  - _Requirements: R1.12, R1.18_
- [ ] E.9 Integration test: mất lease — **ba vế của bug cũ phải cùng lúc sai**
  - `POST /api/bridge/v1/tools/*` trả **404 vì route không tồn tại** (không phải 403/503 từ route còn đăng ký) · foundation đã stop · discovery record vắng mặt
  - Nhánh headless ⇒ listener đóng, exit ≠ 0. Và: tiến trình **đã cướp lease** là writer duy nhất
  - _Requirements: R2.14, R2.1_ — _Design: §11.3_

**Acceptance Criteria**:
- [ ] Đổi workspace không đóng cổng, không mất session
- [ ] Không có cửa sổ nào tồn tại hai writer

**Deliverables**: `packages/cli/src/foundation-manager.ts` · `loopback-host.ts` · `startup.ts` · `next-host.ts`

---

## Phase F: Filesystem browser API

**Addresses**: R1.1–R1.10, R1.14–R1.16 · **Design**: §5.2, §7.1–§7.5
**Files affected**: `packages/core/src/service/filesystem-browser.ts`, `packages/core/src/port/`, `packages/adapter/src/fs/`, `packages/server/src/routes/system.ts`
**Prerequisite**: E
**Estimate**: 10 SP

**Tasks**:
- [ ] F.1 Port + adapter cho browse
  - Chính sách (token, giới hạn, canonicalize) ở `core`; truy cập `node:fs` ở `adapter/fs` — `core` **bị cấm** import `node:fs` ([steering/02](../../../steering/02-project-layout.md) §2)
  - Trả `Result<T, DomainError>`, không throw ([steering/03](../../../steering/03-architecture-ddd.md) §2.2)
  - _Requirements: R1.1, R1.2_ — _Design: §5.0, §5.2_
- [ ] F.2 Worker **dạng eval**
  - `new Worker(<source>, { eval: true })` — MUST NOT trỏ file path. Trong SEA không có file thật; đây đúng cơ chế đã làm esbuild treo ở S1b, và chế độ hỏng là **treo im lặng**
  - Concurrency 2, timeout terminate worker
  - _Requirements: R1.14, R1.15_ — _Design: §5.2_
- [ ] F.3 `BrowseTokenStore`
  - In-memory, TTL ngắn, bind session + canonical path + stat identity. Dùng lại **đúng một** hàm canonicalize đã có ([steering/06](../../../steering/06-validation.md) §5), MUST NOT dựng hàm resolve thứ hai
  - _Requirements: R1.8, R1.16_ — _Design: §5.2_
- [ ] F.4 Endpoint `/v1/system/*`
  - `GET filesystem/roots`, `POST filesystem/entries` (POST để absolute path không nằm trong URL log), `POST directories`, `GET workspace`, `GET runtime`
  - Windows liệt kê **gốc ổ đĩa**; POSIX đi lên tới `/`
  - _Requirements: R1.1, R1.6, R1.9_ — _Design: §7.1–§7.4, §7.7b_
- [ ] F.5 `PUT /v1/workspace/active` **chỉ nhận `selectionToken`**
  - Bỏ nhánh `{path}`: không đường ghi nào được nhận absolute path từ client ([steering/06](../../../steering/06-validation.md) §5). CLI truyền workspace bằng tham số tiến trình, không qua endpoint này
  - Lỗi `workspace_lease_held` kèm `details.holder = {pid, startedAt}`
  - _Requirements: R1.5_ — _Design: §7.5, §7.13_
- [ ] F.6 MUST NOT expose qua MCP
  - Test chứng minh Tool Registry không chứa bất kỳ tool nào của `/v1/system/*`
  - _Requirements: R1.4_ — _Design: §7.0_
- [ ] F.7 Logic test
  - Browse entry mapping; token binding; phân trang; lỗi có mã cho từng nhánh R1.7
  - _Requirements: R1.2, R1.7_
- [ ] F.8 Integration test trên fs thật
  - Thư mục 200k entry ⇒ phân trang, không treo · permission denied ⇒ mã lỗi, **không 500** · timeout ⇒ worker bị terminate · TOCTOU: symlink đổi giữa hai request ⇒ token cũ không còn hợp lệ
  - _Requirements: R1.7, R1.14, R1.15, R1.16_
- [ ] F.9 Test: worker **dạng file path** fail có mã trong SEA harness
  - Để dạng sai không lặng lẽ quay lại
  - _Requirements: R1.15_ — _Design: §5.2_

**Acceptance Criteria**:
- [ ] Request không session ⇒ 401 kể cả từ `127.0.0.1`
- [ ] Không trả nội dung file hay kích thước file thường

**Deliverables**: `packages/core/src/service/filesystem-browser.ts` · `packages/adapter/src/fs/browse-*.ts` · `packages/server/src/routes/system.ts`

---

## Phase G: Frontend — http-driver, static export, picker, New video

**Addresses**: R1.11, R1.19, R4.5, R4.10–R4.13 · **Design**: §5.11, §5.12, §7.6
**Files affected**: `src/lib/api/**`, `src/app/**`, `src/components/home/new-project-card.tsx`, `next.config.ts`
**Prerequisite**: F
**Estimate**: 12 SP

**Tasks**:
- [ ] G.1 Service catalog + http-driver
  - Một catalog `src/lib/api/services.ts`, id `v1.<domain>.<action>`; **không** bật automatic version injection (URL đã chứa `api/v1`, tránh `/v1/v1`)
  - _Requirements: R4.10_ — _Design: §5.11_
- [ ] G.2 Base URL là **runtime config**
  - `resolveApiBaseUrl()` đọc `window.__VIDCOM_API_BASE_URL__`, mặc định `location.origin`. Script chèn global chỉ render khi `NODE_ENV !== "production"` → production dead-code-eliminate. MUST NOT dùng `NEXT_PUBLIC_*`
  - _Requirements: R4.10_ — _Design: §5.11_
- [ ] G.3 Dev host fail lúc boot khi hostname lệch
  - Đo ở S9: `localhost:3000` → `127.0.0.1:<port>` thì `exchange` trả **200** mà cookie **không bao giờ quay lại** — hỏng im lặng. Cùng hostname giữ được `SameSite=Strict` qua port khác
  - _Requirements: R4.12_ — _Design: §5.11_
- [ ] G.4 SSE gửi credential + abort khi dispose
  - `execServiceByStream` nhận cùng request options gồm `credentials: "include"` và `AbortSignal`
  - _Requirements: R4.10, R4.6_ — _Design: §5.11_
- [ ] G.5 Tách page dynamic route
  - Server component xuất `generateStaticParams` (trả sentinel `__shell`) + client component mang thân page; slug đọc từ `location`, MUST NOT từ `params`
  - _Requirements: R4.13, R4.5_ — _Design: DR-3_
- [ ] G.6 Bỏ catch-all route handler khỏi build export
  - `src/app/api/[[...route]]/route.ts` với `dynamic = "force-dynamic"` làm `next build` fail; `trailingSlash: false` chốt tường minh
  - _Requirements: R4.11, R4.5_ — _Design: §5.10_
- [ ] G.7 `WorkspacePickerPage`
  - Roots, breadcrumb, entry phân trang, tạo thư mục, chọn, trạng thái lỗi R1.7. Chưa có workspace ⇒ app vào màn này trước Home
  - _Requirements: R1.11_ — _Design: §5.12_
- [ ] G.8 `NewProjectDialog`
  - Tên + preset đóng sẵn; chặn double-submit; lỗi validation và trùng slug; thành công thì refresh/điều hướng. Sửa dòng phụ "Generate with an AI agent" ở [`new-project-card.tsx`](../../../../src/components/home/new-project-card.tsx)
  - MUST NOT thêm file/folder CRUD, upload asset, agent generation
  - _Requirements: R1.19_ — _Design: §5.12, §7.6_
- [ ] G.9 Test browser harness
  - Nonce → session → xoá token khỏi URL; picker; New video **cả hai nhánh** thành công và thất bại; cross-origin dev giữ cookie ở fetch **và** SSE
  - _Requirements: R1.10, R1.19, R4.10, R4.12_

**Acceptance Criteria**:
- [ ] Cùng một bundle chạy same-origin (artifact) và cross-origin (dev) chỉ bằng cấu hình
- [ ] `next build` với `output: "export"` xanh

**Deliverables**: `src/lib/api/services.ts` · `src/app/projects/[slug]/*` · `src/components/workspace-picker/*` · `next.config.ts`

---

## Phase H: SEA build + static asset host

**Addresses**: R4.1–R4.3, R4.6–R4.9, R4.14 · **Design**: §5.10, §9.1, DR-1
**Files affected**: `scripts/build-artifact.mjs`, `packages/cli/src/sea-static-host.ts`, `packages/server/src/middleware/body-limit.ts`
**Prerequisite**: G
**Estimate**: 13 SP

**Tasks**:
- [ ] H.1 Bundle CJS **không top-level await**
  - Node SEA nhận main CJS và esbuild từ chối TLA ở format `cjs`; mọi khởi tạo bất đồng bộ nằm trong `main()`. Vi phạm ⇒ build fail, không degrade
  - _Requirements: R4.14_ — _Design: DR-1_
- [ ] H.2 Frontend pack + manifest
  - `frontend-manifest.json` (`path, offset, length, sha256, mime, cachePolicy`) + `frontend.pack` raw bytes, **không base64**
  - _Requirements: R4.1, R4.2_ — _Design: §5.10_
- [ ] H.3 `SeaStaticAssetHost`
  - `getRawAsset` + immutable view, không ghi pack ra đĩa. Resolver normalize URL, reject encoded traversal, map `/projects/<slug>` **và payload RSC `.txt`** sang `projects/__shell*`
  - HTML/RSC `no-store`; `/_next/static/**` immutable
  - _Requirements: R4.2, R4.5_ — _Design: §5.10_
- [ ] H.4 Build SEA native theo runner
  - `useCodeCache=false`, `useSnapshot=false`, postject pinned, không cross-build
  - _Requirements: R4.1_ — _Design: DR-1_
- [ ] H.5 Body limit theo route
  - 1 MiB mặc định, **20 MiB** cho route upload asset, ở đúng mắt xích `bodyLimit` của chuỗi middleware cố định. Vượt ⇒ `413 payload_too_large` kèm giới hạn thật
  - _Requirements: R4.6_ — _Design: §7_
- [ ] H.6 Đo cold/warm + baseline hồi quy
  - Ghi baseline vào `.github/perf-baseline/<runner-label>.json`, **commit vào repo** — không dùng CI cache (cache hết hạn thì gate im lặng biến mất)
  - _Requirements: R4.9_ — _Design: §9.1_
- [ ] H.7 Golden test static host
  - Exact/implicit `.html`/sentinel/RSC mapping, MIME, cache header, 404, traversal
  - _Requirements: R4.5_
- [ ] H.8 Integration test artifact
  - Chạy với `cwd` là thư mục tạm **rỗng**; cạnh artifact không xuất hiện thư mục asset nào; SSE không bị buffer; upload 20 MB đi qua; 21 MB trả 413
  - _Requirements: R4.3, R4.2, R4.6_

**Acceptance Criteria**:
- [ ] Artifact không chứa `next` ở đường chạy
- [ ] Cold/warm nằm trong trần §9.1 trên runner đang build

**Deliverables**: `scripts/build-artifact.mjs` · `packages/cli/src/sea-static-host.ts` · `.github/perf-baseline/`

---

## Phase I: Daemon discovery + bridge + attachment

**Addresses**: R2.2–R2.4, R2.6–R2.13, R2.15 · **Design**: §4.4, §5.5–§5.7, §7.8–§7.11
**Files affected**: `packages/adapter/src/daemon/**` (mới), `packages/adapter/src/fs/daemon-discovery.ts`, `packages/mcp/src/bridge/**`, `packages/server/src/routes/bridge.ts`
**Prerequisite**: E
**Estimate**: 19 SP

**Tasks**:
- [ ] I.1 `DaemonDiscoveryStore`
  - `<app-data>/daemon/<workspaceHash>.json`, atomic temp+fsync+rename, `0600`/ACL. `remove` so `instanceId` để daemon cũ không xoá record daemon mới. **Không** secret, không attachment count, không lease id trong file
  - _Requirements: R2.13_ — _Design: §5.5, §6.2_
- [ ] I.2 Package mới `adapter/daemon` cho `DaemonClient`
  - Dùng chung bởi `mcp` (bridge) và `cli` (`render`); đây là cách duy nhất để `mcp` **không** phải import `server` ([steering/02](../../../steering/02-project-layout.md) §2)
  - _Requirements: R2.2_ — _Design: §5.0, §7.0_
- [ ] I.3 Handshake
  - So canonical root **và** instance id; PID/port sống không đủ. Mismatch ⇒ 409 `daemon_identity_mismatch`, không tiếp tục call
  - _Requirements: R2.13_ — _Design: §7.8_
- [ ] I.4 Attachment lease
  - Heartbeat 5 s, TTL 20 s, deadline 5 s, grace 60 s. Id random 256-bit bound credential+instance. Attach/renew so `credentialId` với `app_settings.bridge_credential_id`
  - _Requirements: R2.15_ — _Design: §4.4, §7.9_
- [ ] I.5 `activeWorkHold` suy từ job store
  - Job non-terminal thuộc workspace ⇒ hold còn; không heartbeat, không biến mất khi client thoát
  - _Requirements: R2.15_ — _Design: §4.4_
- [ ] I.6 Luật `autoStarted`
  - Chỉ daemon `serve --ensure` được auto-shutdown; `app`/`serve` tay thì **không bao giờ**; từng nhận attachment `kind: "ui"` ⇒ mất quyền tự tắt **vĩnh viễn**. State trong memory, MUST NOT vào discovery record
  - _Requirements: R2.15_ — _Design: §4.4_
- [ ] I.7 Remote Tool Registry
  - `ToolDefinition` là nguồn duy nhất; `createMcpRegistry` nhận `ToolInvoker`; remote invoker gọi endpoint allowlisted. **MUST NOT** có `request(method,path,body)` tuỳ ý
  - Bridge forward `protocolVersion`, credential/attachment id, actor=`agent`; daemon sở hữu audit
  - _Requirements: R2.2, R2.3, R2.9, R2.11_ — _Design: §5.7, DR-6_
- [ ] I.8 Auto-start + race
  - `ensure` spawn `serve --ensure` khi cần; kẻ thua race lease **chuyển thành client**, không throw rồi chết. Daemon sinh theo đường này MUST NOT mở browser
  - _Requirements: R2.4, R2.10, R2.15_ — _Design: §5.6_
- [ ] I.9 `stdout` của bridge chỉ JSON-RPC
  - Mọi log/cảnh báo/tiến trình qua `stderr` hoặc log store; test bắt được một dòng lạc
  - _Requirements: R2.6_ — _Design: §5.8_
- [ ] I.10 Contract parity test local ↔ remote
  - Cùng input ⇒ cùng schema, cùng revision, cùng mã lỗi
  - _Requirements: R2.3_
- [ ] I.11 Integration test
  - Port bị chiếm bởi app khác ⇒ handshake từ chối · record stale ⇒ rediscovery có giới hạn · daemon biến mất giữa phiên ⇒ lỗi có mã, **không treo**, không trả kết quả giả
  - Hai bridge auto-start đồng thời ⇒ kẻ thua nối vào kẻ thắng · bridge cuối detach chỉ tắt daemon auto
  - _Requirements: R2.7, R2.10, R2.13, R2.15_
- [ ] I.12 Integration test: agent ghi qua bridge ⇒ UI nhận event
  - Đường watcher/event outbox Phase 1 còn nguyên tác dụng, không cần reload
  - _Requirements: R2.8_

**Acceptance Criteria**:
- [ ] Mở app rồi chạy Codex ⇒ **cả hai dùng được**, vẫn đúng một writer
- [ ] Tool destructive vẫn cần approval do con người phát hành

**Deliverables**: `packages/adapter/src/daemon/**` · `packages/adapter/src/fs/daemon-discovery.ts` · `packages/mcp/src/bridge/**` · `packages/server/src/routes/bridge.ts`

---

## Phase J: CLI mode + doctor

**Addresses**: R3.1–R3.13 · **Design**: §5.8, §5.9, §7.12–§7.14
**Files affected**: `packages/cli/src/main.ts`, `packages/cli/src/commands/{serve,render,doctor,version}.ts`, `packages/core/src/service/doctor.ts`
**Prerequisite**: D, I
**Estimate**: 13 SP

**Tasks**:
- [ ] J.1 Mode dispatcher
  - Union công khai `app | serve | mcp | render | doctor | version | approve | credential | backup | recovery`. **Không** `worker` (OQ-9); `packages/worker` giữ nguyên, không xoá
  - Mode không tồn tại ⇒ liệt kê mode hợp lệ, exit ≠ 0
  - _Requirements: R3.1, R3.11_ — _Design: §5.8_
- [ ] J.2 `serve` và `app`
  - `serve` headless, in địa chỉ qua `stderr`/log; `app` = `serve` + mở browser + token một lần
  - _Requirements: R3.2, R1.10_ — _Design: §5.8_
- [ ] J.3 `render` thin client
  - Phân biệt id/slug bằng `^project_[0-9a-f-]{36}$`, MUST NOT thử id rồi fallback slug. Thứ tự workspace: explicit(`--workspace`|`VIDCOM_WORKSPACE`) > **`cwd` có marker** > `active_workspace` > `cwd` không marker (nhánh cuối **bị cấm** cho render ⇒ exit 2)
  - Mặc định chờ job xong; `--detach` in jobId; `Ctrl+C` lần đầu cancel, lần hai exit 130; exit `0/1/2/130`; idempotency key **ngẫu nhiên mỗi invocation**
  - _Requirements: R3.3_ — _Design: §7.13_
- [ ] J.4 `version`
  - VidCom version, HyperFrames version, build commit, platform tag, runtime manifest version
  - _Requirements: R3.4_ — _Design: §7.14_
- [ ] J.5 Doctor registry
  - 17 check theo bảng §5.9, thứ tự deterministic. `chrome.cache` **thực thi** binary `--version`, MUST NOT hỏi CLI lấy đường dẫn. `runtime.python` dùng `importlib.metadata`, không cần pip. `gpu.cuda` **không** có trong bảng
  - _Requirements: R3.5, R3.6, R3.12_ — _Design: §5.9_
- [ ] J.6 `skipped` có nguồn sự thật
  - `chrome.cache`/`tts.model-cache` từ bảng `job`; `workspace.active` từ `app_settings`. `VIDCOM_DOCTOR_STRICT=1` ⇒ `skipped` trên mục required tính như `missing`
  - _Requirements: R3.12_ — _Design: §5.9_
- [ ] J.7 Exit code + `--json` + redaction
  - Required không `ok` ⇒ ≠ 0; optional không `ok` ⇒ vẫn 0; `--json` stdout chỉ một `DoctorReport`, human output `stderr`; redact token/API key/credential/absolute path của máy build
  - _Requirements: R3.7, R3.8, R3.10_ — _Design: §7.12_
- [ ] J.8 `--repair`
  - Chỉ extraction/runtime component; giải nén vào temp rồi swap, hoặc **từ chối** kèm hướng dẫn khi daemon đang giữ file (Windows khoá file đang mở). MUST NOT ghi đè in-place
  - Credential file mất ⇒ **mint mới**, không phải khôi phục
  - _Requirements: R3.9, R3.13_ — _Design: §5.9, §4.4_
- [ ] J.9 Golden test `doctor --json`
  - Payload ổn định; thứ tự check deterministic
  - _Requirements: R3.8_
- [ ] J.10 Integration test
  - Từng check fail độc lập ⇒ exit code đúng; `--repair` khi daemon sống ⇒ swap hoặc từ chối, không để lại trạng thái nửa vời
  - _Requirements: R3.9, R3.13_

**Acceptance Criteria**:
- [ ] `doctor` nói được **cái gì thiếu và sửa thế nào** cho mọi mục không `ok`
- [ ] MCP stdout vẫn sạch sau khi thêm mode mới

**Deliverables**: `packages/cli/src/commands/**` · `packages/core/src/service/doctor.ts`

---

## Phase K: Import project

**Addresses**: R7.1–R7.12 · **Design**: §4.7, §5.19, §6.4, §7.15
**Files affected**: `packages/core/src/usecase/project-import.ts`, `packages/adapter/src/fs/import-staging.ts`, `packages/server/src/routes/projects.ts`
**Prerequisite**: E
**Estimate**: 8 SP

**Tasks**:
- [ ] K.1 `ProjectImportService.plan/execute`
  - Bind source canonical identity + target absence + digest; execute recheck trước copy. Trả `Result<T, DomainError>`
  - _Requirements: R7.1, R7.3_ — _Design: §5.19_
- [ ] K.2 Staging cùng filesystem
  - `<workspace>/.<slug>.vidcom-import-<operation>.tmp` để rename cuối là atomic; marker operation id. IF temp ở thiết bị khác THEN `rename` fail — MUST NOT dùng temp của OS vô điều kiện
  - _Requirements: R7.6, R7.12_ — _Design: §4.7_
- [ ] K.3 Luật copy
  - Chỉ regular file/dir; bỏ `node_modules/.git/.hyperframes`; **từ chối symlink** (luật tường minh của R7.11). Source chỉ đọc, không sửa metadata
  - _Requirements: R7.2, R7.11_ — _Design: §5.19_
- [ ] K.4 Chặn overlap trước khi copy
  - Source nằm trong workspace, là cha của workspace, hoặc trùng workspace ⇒ từ chối **sau khi canonicalize, trước khi copy** — đây là chỗ sinh copy đệ quy vô hạn
  - _Requirements: R7.10_ — _Design: §4.7_
- [ ] K.5 Backfill dùng lại `bootstrapProject`
  - Không có đường serialize identity thứ hai. `ProjectId` trùng ⇒ cấp id mới, ghi lại `vidcom.json`, log sự kiện
  - _Requirements: R7.5, R7.7_ — _Design: §5.19_
- [ ] K.6 `POST /v1/projects/imports` trả **202 `{jobId}`**
  - Request `{sourceToken, targetName?}` — token từ browser, **không** raw path. Idempotency khoá ở **application layer** theo `(workspaceRoot, sourceCanonicalIdentity, targetName)`: `uniqueIndex("uq_job_idempotency")` scope theo `(project_id, type, key)` mà `project_id` **NULL** tới khi xong, và SQLite coi mọi NULL là khác nhau
  - _Requirements: R7.1, R7.8_ — _Design: §7.15_
- [ ] K.7 Recovery lúc startup
  - Hoàn tất hoặc xoá theo `workspace_operation`; MUST NOT quét/xoá thư mục không có marker
  - _Requirements: R7.6_ — _Design: §4.7_
- [ ] K.8 Logic test
  - Import plan; phát hiện overlap; đặt tên khi trùng slug
  - _Requirements: R7.4, R7.10_
- [ ] K.9 Integration test trên fs thật
  - Kill sau begin/copy/validate/rename ⇒ recovery ra project committed hoặc abort sạch, **bản gốc không đổi**
  - Gọi hai lần cùng khoá ⇒ **cùng jobId**, không tạo job thứ hai
  - EXDEV, Windows file lock, symlink — kiểm ở OS hỗ trợ
  - _Requirements: R7.2, R7.6, R7.12_
- [ ] K.10 Test với **3 project mẫu trong `projects/`** của repo
  - _Requirements: R7.9_

**Acceptance Criteria**:
- [ ] Thất bại không để lại thư mục rác trong workspace
- [ ] Bản gốc không bị sửa ở bất kỳ nhánh nào

**Deliverables**: `packages/core/src/usecase/project-import.ts` · `packages/adapter/src/fs/import-staging.ts`

---

## Phase L: Hygiene & provenance

**Addresses**: R9.1–R9.7 · **Design**: §5.20, §9.2, §9.4
**Files affected**: `scripts/build-artifact.mjs`, `scripts/verify-artifact.mjs`
**Prerequisite**: H
**Estimate**: 5 SP

**Tasks**:
- [ ] L.1 Build fail theo điều kiện
  - Lockfile/tool version khác manifest · archive có entry ngoài allowlist · sourcemap/source rời · secret pattern · absolute root của máy build
  - _Requirements: R9.1, R9.2, R9.3_ — _Design: §5.20_
- [ ] L.2 `SHA256SUMS` + `artifact-manifest.json`
  - Commit, `dirty=false` cho release job, tool versions, archive hashes, platform
  - _Requirements: R9.4_ — _Design: §5.20_
- [ ] L.3 macOS ad-hoc sign sau injection
  - Windows unsigned + checksum; signing thật deferred (D2)
  - _Requirements: R9.5_ — _Design: §5.20_
- [ ] L.4 Tắt telemetry HyperFrames trong runtime đã giải nén
  - Xác nhận ở S9: lời mời telemetry hiện ngay lần chạy đầu với `HOME` sạch. Ghi quyết định vào release notes
  - _Requirements: R9.7_ — _Design: §5.20_
- [ ] L.5 Test scan
  - Source/sourcemap/dev-origin/secret/build-root; frontend pack không chứa `localhost:3000`
  - _Requirements: R9.1, R9.2, R9.3_

**Acceptance Criteria**:
- [ ] Không secret, không sourcemap, không absolute path máy build trong artifact

**Deliverables**: `scripts/build-artifact.mjs` · `scripts/verify-artifact.mjs`

---

## Phase M: Packaged smoke ba nền tảng

**Addresses**: R8.1–R8.8 · **Design**: §4.8, §11.4
**Files affected**: `.github/workflows/packaged-smoke.yml`, `scripts/packaged-smoke/*`
**Prerequisite**: tất cả
**Estimate**: 21 SP

**Tasks**:
- [ ] M.1 Job native theo OS
  - macOS arm64, Windows x64, Linux x64; **không job nào dùng artifact build từ OS khác**. Mỗi lần chạy ghi lại nền tảng đã kiểm
  - _Requirements: R8.1, R8.5_ — _Design: §4.8, DR-11_
- [ ] M.2 Môi trường sạch
  - `node` **không** trên PATH; **không** `node_modules` ở `cwd` hay thư mục cha; `HOME` sạch. Cache tải-về (`$HOME/.cache/hyperframes`, `HF_HOME`) **được** mồi; app-data/runtime **không** được mồi
  - _Requirements: R8.2, R8.8_ — _Design: §11.4_
- [ ] M.3 12 bước smoke theo §11.4
  - version → cold `doctor --repair` → warm `doctor --deep` → start + nonce/session + picker + create project → import → bridge trong lúc UI sống → TTS/snapshot/render + ffprobe → upload 20 MB + SSE → render wait/detach/cancel → **cắt mạng ở tầng runner** rồi warm offline → lease loss hai nhánh → scan checksum/provenance
  - _Requirements: R8.3_ — _Design: §11.4_
- [ ] M.4 Bước offline chặn ở **tầng mạng runner**
  - Đo ở S9: `HTTPS_PROXY`/`HTTP_PROXY` **bị lờ** — downloader vẫn tải 202 MB qua proxy chết. Viết bằng env thì bước này xanh vì lý do sai
  - _Requirements: R8.8, R6.5_ — _Design: §5.18_
- [ ] M.5 Cache theo version + fail khi thiếu thành phần bắt buộc
  - `VIDCOM_DOCTOR_STRICT=1`; thành phần bắt buộc vắng mặt ⇒ **fail**, MUST NOT skip
  - _Requirements: R8.4, R8.8_ — _Design: §5.9_
- [ ] M.6 Upload bằng chứng
  - DoctorReport, artifact manifest, `SHA256SUMS`, kết quả ffprobe, platform metadata
  - _Requirements: R8.3_ — _Design: §9.4_
- [ ] M.7 Chốt lại hai trần còn tạm
  - Cold thật trên phần cứng runner; **trần Linux 120 s đang bằng darwin trong khi Linux giải nén nhiều hơn ~24 %** (595 so với 481 MB) ⇒ xác nhận hoặc nới **kèm số đo**, MUST NOT giữ nguyên vì bảng đã viết sẵn
  - _Requirements: R4.9, R8.3_ — _Design: §9.1, §5.13_
- [ ] M.8 Ghi lại bằng chứng TTS Windows
  - Máy phát triển bị N-1 (TLS inspection) chặn; runner CI không có ⇒ đây là **bằng chứng đầu tiên**, MUST NOT suy từ darwin
  - _Requirements: R6.1, R8.3_ — _Design: §5.13_
- [ ] M.9 Thời gian job trong giới hạn CI
  - Hoặc tách job riêng có điều kiện rõ ràng; MUST NOT làm CI thường xuyên đỏ vì timeout
  - _Requirements: R8.7_

**Acceptance Criteria**:
- [ ] Không step bắt buộc nào bị skip
- [ ] Job Linux vắng mặt ⇒ scope/release claim phải được duyệt lại, **không** phải CI xanh (R8.5)

**Deliverables**: `.github/workflows/packaged-smoke.yml` · `scripts/packaged-smoke/**`

---

## Files Changed Summary

| File / thư mục | Phase | Thay đổi |
|---|---|---|
| `packages/contracts/src/**` | A | DTO, error code, schema tool chuyển về đây |
| `packages/adapter/src/runtime/**` | B, D | asset source/manager, compiler guard, env allowlist |
| `packages/adapter/src/fs/**` | B, C, F, I, K | ACL, credential store, browse, discovery, import staging |
| `packages/adapter/src/daemon/**` | I | **package mới** — IPC client dùng chung `mcp`/`cli` |
| `packages/adapter/src/hyperframes/binary-probe.ts` | D | hai chỗ spawn đổi hình dạng |
| `packages/adapter/src/tts/**` | D | interpreter đóng băng, `HF_HUB_OFFLINE`, CA bundle |
| `packages/core/src/service/**` | C, F, J, K | doctor, filesystem browser, import |
| `packages/cli/src/**` | C, D, E, H, J | bootstrap, shim, foundation manager, loopback host, mode |
| `packages/server/src/routes/**` | F, I, K | system, bridge, imports |
| `packages/mcp/src/bridge/**` | I | remote invoker |
| `src/**` | G | http-driver, export, picker, New video |
| `scripts/**` | B, H, L, M | build archive/artifact, verify, smoke |
| `.github/workflows/**` | H, M | perf baseline, packaged smoke |

**Tổng ước lượng**: **177 SP** — A 5 · B 13 · C 16 · D 25 · E 17 · F 10 · G 12 · H 13 · I 19 · J 13 · K 8 · L 5 · M 21.

> Con số này **phân hoạch lại** ước lượng theo R ở [main spec](./spec-packaging-and-distribution-pending.md) (R1 26 · R2 37 · R3 13 · R4 21 · R5 21 · R6 25 · R7 8 · R8 21 · R9 5), không phải một ước lượng thứ hai. Tổng giữ nguyên.

---

## Requirements Coverage Matrix

| Requirement | Covered by | Verified by |
|---|---|---|
| R1.1–R1.10 picker API | F.1–F.6 | F.7, F.8, G.9 |
| R1.11 UI picker | G.7 | G.9 |
| R1.12 đổi workspace runtime | E.1, E.4 | E.7, E.8 |
| R1.13 perimeter | E.6 | E.9, F.8 |
| R1.14–R1.16 giới hạn/timeout/TOCTOU | F.2, F.3 | F.8, F.9 |
| R1.17 boot không-workspace | E.2, E.3 | E.7, H.8 |
| R1.18 đổi workspace khi có job | E.4 | E.8 |
| R1.19 New video | G.8 | G.9 |
| R2.1, R2.12, R2.14 single-writer + lease | E.5, C.5 | E.9, M.3 |
| R2.2–R2.4, R2.10 bridge + auto-start | I.2, I.7, I.8 | I.10, I.11 |
| R2.5 credential | C.5–C.7 | C.10, C.11 |
| R2.6 stdout sạch | I.9 | I.9, M.3 |
| R2.7 daemon biến mất | I.3 | I.11 |
| R2.8 event tới UI | I.12 | I.12 |
| R2.9 audit actor | I.7 | I.10 |
| R2.11 không mở bề mặt | I.7, F.6 | I.10, F.6 |
| R2.13 handshake | I.1, I.3 | I.11, M.3 |
| R2.15 refcount + race | I.4–I.6, I.8 | I.11 |
| R3.1–R3.4 mode | J.1–J.4 | J.9, J.10 |
| R3.5–R3.13 doctor | J.5–J.8 | J.9, J.10 |
| R4.1–R4.3 SEA | H.1–H.4 | H.8 |
| R4.4 Hono app không đổi | E.2 | H.8 |
| R4.5 sentinel + RSC | G.5, G.6, H.3 | H.7 |
| R4.6 SSE + upload | G.4, H.5 | H.8 |
| R4.7 pin + no sourcemap | L.1 | L.5 |
| R4.8 dev host còn dùng được | G.2, G.6 | G.9 |
| R4.9 ngưỡng cold/warm | H.6 | M.7 |
| R4.10–R4.13 http-driver + export | G.1–G.6 | G.9 |
| R4.14 CJS không TLA | H.1 | H.8 |
| R5.1–R5.6 archive + extraction | B.1–B.5 | B.7–B.9 |
| R5.7, R5.8 motion library | D.3 | D.10, M.3 |
| R5.9, R5.12 quyền + không ghi bậy | B.6 | B.8 |
| R5.10 dựng lại được | B.5 | B.8 |
| R5.11 quan sát được | B.5, J.8 | J.10 |
| R5.13 thứ tự cold start | C.1–C.3 | C.9, C.12 |
| R5.14 danh sách Python pin | B.3 | B.3 build gate |
| R6.1 render có tiếng | D.6 | M.3, M.8 |
| R6.2–R6.4 hình dạng spawn | D.1, D.2 | D.10, D.11 |
| R6.5 Chromium/weights/TLS | D.7, D.8 | D.11, M.4 |
| R6.6 FFmpeg từ archive | D.3 | M.3 |
| R6.7 sidecar + UTF-8 | D.5, D.6 | D.11, D.12 |
| R6.8 kill cây process | D.13 | D.13, M.3 |
| R6.9 version skew | D.9 | D.9 |
| R6.10, R6.11 in-process + compiler | D.4 | D.11 |
| R7.1–R7.12 import | K.1–K.7 | K.8–K.10 |
| R8.1–R8.8 packaged smoke | M.1–M.9 | M.3 |
| R9.1–R9.7 hygiene | L.1–L.4 | L.5 |

> Mọi requirement xuất hiện ở đây, map tới ≥1 task và ≥1 test.

---

## Deferred Items Reference

| # | Issue | Effort | Dependency |
|---|---|---|---|
| D1 | Matrix 3 OS × 2 kiến trúc | — | Giai đoạn 6 |
| D2 | Signing/notarization thật, installer `.dmg`/`.msi` | — | credentials/release infra |
| D3 | Unix socket / named pipe làm mặc định | — | cần native code để đặt ACL cho pipe (đo ở S9) |
| D4 | Air-gapped seed cho Chromium/weights | — | spec offline mới |
| D5 | Public `worker` mode | — | chưa có measured isolation need |
| D6 | Tauri / native picker | — | UX phase |
| D7 | HyperFrames multi-version runtime | — | Giai đoạn 6 |
| D8 | Bàn giao lease giữa hai tiến trình | — | Giai đoạn 6 |
| D9 | TLS inspection — nếu bị đưa ra ngoài phạm vi | — | **hiện đang trong phạm vi** (quyết định 2026-08-07) |

Chi tiết: [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) và [Design §13](./spec-packaging-and-distribution-detailed-design.md).

---

## Nợ kiểm chứng mang sang từ Design

| # | Món | Đóng ở đâu |
|---|---|---|
| W-2 | ACL của named pipe — Node không có API đặt security descriptor | D3 deferred; không chặn đường mặc định |
| W-3 | Chế độ hỏng khi **mất mạng thật** lúc tải Chromium | M.4 |
| W-4 | TTS ra WAV **trên Windows** — máy phát triển bị N-1 chặn | M.8 |
| — | Cold start thật trên phần cứng runner; trần Linux còn tạm | M.7 |
| — | Windows-specific chưa chạm ở S9: ACL thay `0700`/`0600`, `rename` qua thiết bị, khoá file khi re-extract, kill tree qua `powershell-cim` | B.6, K.9, J.8, D.13 |

---

## Execution Log

> [!NOTE]
> Mỗi phiên làm việc một entry: ngày, phase/task, file đã sửa, quyết định đáng ghi, blocker.

_Chưa bắt đầu — Code Execution bị chặn cho tới khi Approval Gate ở trên được duyệt._

Format:
```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [path/to/file.ts]
  - Summary: [đã làm gì]
  - Decisions: [lệch khỏi design ở đâu — nếu vật chất thì cập nhật detailed-design.md]
  - Blockers: [nếu có]
```
