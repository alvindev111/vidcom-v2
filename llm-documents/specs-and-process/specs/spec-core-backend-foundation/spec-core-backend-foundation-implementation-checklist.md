# Spec Core Backend Foundation — Implementation Checklist

> **Reference**: [Detailed Goals](./spec-core-backend-foundation-detailed-goal.md) (duyệt 2026-08-01) · [Detail Design](./spec-core-backend-foundation-detailed-design.md) (duyệt 2026-08-01)
> **Build order**: [15-build-order](../../../product-features/15-build-order.md) Phase 1, mục 1.1–1.13
> **Revision**: v2 — sửa 9 finding P1 + 6 finding phụ từ vòng review ngày 2026-08-01

## Context

> [!NOTE]
> Đây là nguồn sự thật trung tâm của agent trong lúc thực thi. Mọi task phải được theo dõi ở đây.
> Với công việc chạm persistence, checklist chưa hoàn tất cho tới khi có **cả** logic test **và** verification trên datastore thật — SQLite + filesystem thật trong temp dir.

Tài liệu này chia Phase 1 thành task thực thi được, mỗi task trace ngược về một detailed goal (**cái gì**) và một design element (**làm thế nào**).

> **Đính chính v1**: bản trước ghi `.agents/skills/` không tồn tại. **Sai** — repo có 5 skill (`bun`, `hono`, `http-driver`, `mcp-builder`, `ponytail`). Bảng Skill Activation đã được khôi phục ở §"Skill & Steering activation". Chỉ `llm-documents/backend-docs/coding-rules.md` là không tồn tại; luật code của project nằm ở [`llm-documents/steering/`](../../../steering/00-index.md).

## Approval Gate

> Không viết production code cho tới khi mục này được xác nhận rõ ràng.

- **Status**: **Approved**
- **Confirmed by**: Chủ dự án (goal mở Code Execution)
- **Confirmation date**: 2026-08-01
- **Notes / required revisions before code execution**: Thực thi tuần tự Phase A→O; B phải xanh trước G/H/N; J phải hoàn tất trước K; mọi design drift phải được sửa trong Detailed Design cùng lúc.

## Sequencing Strategy

**Chosen strategy**: **Foundation-First** với một nhánh Risk-First chèn sớm.

**Rationale**: Ranh giới package, write authority và test harness không thêm sau được. Nhánh Risk-First là Phase B: golden `serialize()` phải xanh **trước** khi bất kỳ đường ghi nào bị đụng (R2 AC2).

## Dependency Order

```
A (monorepo + boundary lint + CI typecheck/lint + skills + notes)
└─→ B (golden baseline — GATE; harness TRUNG LẬP, chưa gắn vào adapter)
    └─→ C (contracts: zod schema + ErrorCode + Diagnostic)
        └─→ D (domain + 9 port + WorkspaceResolver + PathPolicy)
            ├─→ E (adapter/fs)
            ├─→ F (adapter/db + bảng identity)
            └─ E + F ─→ G (WriteAuthority + lease + journal + bootstrapProject)
                        └─ G + D ─→ H (adapter/hyperframes + COMPAT WRAPPER)
                                    └─ G + H ─→ I (use case + composition root + startup order)
            D ────────────────────→ J (Hono app + middleware + auth + bridge credential)
            I + J ────────────────→ K (cutover route ĐỌC + snapshot API)
            F ────────────────────→ L (job infra)
            F ────────────────────→ M (event outbox + SSE + watcher + cache)
            I + K + L + M ────────→ N (cutover route GHI + legacy alias + xoá module cũ)
                                    └─→ O (milestone verification)
```

**Recommended execution order**: A → B → C → D → E → F → G → H → I → J → K → L → M → N → O

**Parallelizable**: E ∥ F sau D. J ∥ {E,F,G,H,I} vì J chỉ cần C+D. L ∥ M sau F.

**Ràng buộc cứng**:
- **K không bắt đầu trước J** — không expose route khi chưa có perimeter auth.
- **G/H/N không bắt đầu trước khi B xanh** — R2 AC2 là điều kiện chặn.
- **C trước D** — D dùng `DomainError`, `ErrorCode`, kiểu domain từ contracts.
- **D trước J** — `SessionPort` khai ở D.

> **Sửa sau review**: v1 để D chỉ phụ thuộc B (nhưng D dùng type của C) và J chỉ phụ thuộc C (nhưng dùng `SessionPort` của D). Đã sửa thành C → D → J.

## Capacity breakdown

| Phase | Nội dung | SP |
|---|---|---:|
| A | Monorepo, boundary lint, CI, skills, notes | 5 |
| B | Golden baseline harness + 9 fixture parse + golden serialize | 6 |
| C | contracts: zod schema, ErrorCode, Diagnostic | 3 |
| D | domain + 9 port + WorkspaceResolver + PathPolicy | 5 |
| E | adapter/fs + ResolvedPath + allowlist | 5 |
| F | adapter/db: Drizzle node:sqlite, migration, 11 bảng + identity bootstrap | 7 |
| G | WriteAuthority + lease + journal + reconciliation + bootstrapProject | 9 |
| H | adapter/hyperframes + compat wrapper | 6 |
| I | Use case + composition root + startup order | 6 |
| J | Hono app, middleware, auth, session, bridge credential | 6 |
| K | Cutover 3 route đọc + snapshot API + bỏ RSC read | 6 |
| L | Job infra + `noop-probe` + recovery | 5 |
| M | Event outbox + SSE + watcher + cache | 5 |
| N | Cutover route ghi + legacy alias + xoá module cũ | 7 |
| O | Milestone verification | 2 |
| | **Tổng** | **83** |

**83 SP** (v1: 73, gốc: 55). Tăng do bổ sung Phase I (use case + composition root), identity bootstrap, bridge credential, và compat wrapper — đều là thứ v1 thiếu.

Ước lượng để lập kế hoạch, **không phải cam kết lịch** — repo chưa từng có test nên chưa có mốc vận tốc.

## Skill & Steering activation per phase

> [!IMPORTANT]
> Trước mỗi phase, **bắt buộc** kích hoạt skill và đọc steering + file nguồn tương ứng.

| Phase | Skill (`.agents/skills/`) | Steering | File nguồn đọc trước khi sửa |
|---|---|---|---|
| A | `bun/SKILL.md` (build, test runner, workspace) | [02-project-layout](../../../steering/02-project-layout.md) §1–2 · [01-backend-stack](../../../steering/01-backend-stack.md) | `package.json`, `eslint.config.mjs`, `next.config.ts` |
| B | `bun/SKILL.md` (test) | [10-testing](../../../steering/10-testing.md) §4 | `src/lib/hyperframes/sdk.server.ts` (FULL), `projects/warm-grain/index.html`, `projects/swiss-grid/index.html` |
| C | — | [06-validation](../../../steering/06-validation.md) · [04-api-design](../../../steering/04-api-design.md) §3 | `src/lib/studio/types.ts` (FULL), `src/lib/studio/preview-settings.ts` |
| D | — | [03-architecture-ddd](../../../steering/03-architecture-ddd.md) §2 · [11-code-style](../../../steering/11-code-style.md) §4 | `src/lib/hyperframes/projects.server.ts` (FULL) |
| E | — | [06-validation](../../../steering/06-validation.md) §5 · [09-security](../../../steering/09-security.md) §5–6 | `projects.server.ts` (`resolveWithinProject`, `editablePath`), `sdk.server.ts` (`openProjectFile`) |
| F | `bun/SKILL.md` | [07-data-and-storage](../../../steering/07-data-and-storage.md) §9 | — |
| G | — | [07-data-and-storage](../../../steering/07-data-and-storage.md) §4–6 | `projects.server.ts` (`writeSourceFile`, `fileVersion`), `preview-settings.server.ts` |
| H | — | [03-architecture-ddd](../../../steering/03-architecture-ddd.md) §3 · [11-parsing-logic](../../../product-features/11-parsing-logic.md) FULL | `scenes.server.ts`, `scene-elements.server.ts`, `root-track.server.ts`, `composition-root.server.ts` |
| I | — | [03-architecture-ddd](../../../steering/03-architecture-ddd.md) §2.2, §5 | — |
| J | **`hono/SKILL.md`** (routing, middleware, validation) | [09-security](../../../steering/09-security.md) §1–4 · [04-api-design](../../../steering/04-api-design.md) §10 | — |
| K | **`hono/SKILL.md`** · `http-driver/SKILL.md` (nếu dùng cho fetch layer của UI) | [02-project-layout](../../../steering/02-project-layout.md) §3 · [04-api-design](../../../steering/04-api-design.md) §2 | `src/app/projects/[slug]/page.tsx` (FULL), `src/app/page.tsx`, mọi file `src/app/api/hf/**` |
| L | — | [08-jobs-and-queue](../../../steering/08-jobs-and-queue.md) FULL | — |
| M | **`hono/SKILL.md`** (streaming/SSE) | [04-api-design](../../../steering/04-api-design.md) §7 · [07-data-and-storage](../../../steering/07-data-and-storage.md) §7–8 | `projects.server.ts` (`memoPerProject`, `projectFingerprint`) |
| N | **`hono/SKILL.md`** | [07-data-and-storage](../../../steering/07-data-and-storage.md) §4 | `src/app/api/hf/[slug]/scene/route.ts` (FULL), `src/components/studio/use-source-files.ts` |
| O | — | [10-testing](../../../steering/10-testing.md) §10 | — |

`mcp-builder/SKILL.md` **không** dùng ở Phase 1 — MCP thuộc Phase 2. `ponytail/SKILL.md` dùng khi cần ép giải pháp tối giản cho task phụ.

**Đọc một lần trước khi bắt đầu**: [11-code-style](../../../steering/11-code-style.md) — đặc biệt §4 (doc comment bắt buộc mọi hàm export) và §5 (comment giải thích *tại sao*).

## Nghĩa vụ thường trực trong suốt thực thi

Áp dụng cho **mọi** phase, không phải task riêng của phase nào — theo [AGENTS.md](../../../../AGENTS.md) mục 4:

- [x] **X.0 Cập nhật `implementation-notes.html`** — file một trang, tiếng Việt, Tailwind qua CDN, đặt trong thư mục spec này.
  - Ghi **ngay khi phát sinh**, không gom cuối phase: quyết định không có trong spec · chỗ làm khác design · đánh đổi đã chọn · bất ngờ/cạm bẫy gặp phải.
  - Lệch design vật chất → cập nhật `detailed-design.md` **cùng lúc**.
- [x] **X.00 Cập nhật checklist này** — đánh dấu trạng thái task, ghi Execution Log mỗi phiên.
- [x] Đổi trạng thái spec `pending` → `inprocess` khi bắt đầu Phase A.

## Task Status Legend

`[ ]` chưa bắt đầu · `[/]` đang làm · `[x]` xong (code + test + verify) · `[!]` bị chặn (ghi lý do)

---

## Phase A: Monorepo, import boundary, CI

**Addresses**: R1 · **Design**: §4.2, §5.1, D1 · **Prerequisite**: không

**Tasks**:
- [x] A.1 Dựng workspace `packages/{contracts,core,adapter,server,mcp,worker,agent-kit,cli}`
  - `package.json` mỗi package, tsconfig kế thừa, path alias `@vidcom/*`
  - `mcp`, `agent-kit` chỉ skeleton có boundary — nội dung ở phase sau
  - _Requirements: R1 AC1, AC1a_ — _Design: §4.2_
- [x] A.2 ESLint `no-restricted-imports` theo bảng boundary, mức `error`
  - Đúng 9 dòng của [02-project-layout](../../../steering/02-project-layout.md) §2
  - Thêm rule cấm Bun-only API trong `packages/**` (R13 AC1)
  - _Requirements: R1 AC2, AC6, R13 AC1_ — _Design: D1, D10_
- [x] A.3 Thêm dependency, **pin exact version**
- `drizzle-orm@1.0.0-rc.4`, `drizzle-kit@1.0.0-rc.4`, `zod@4.4.3`, `hono@<exact>`, `@hono/zod-validator@<exact>`
  - **Không** dùng caret — pin đúng nghĩa (sửa finding: v1 ghi `zod@^4` mà gọi là pin)
  - **Không** thêm `better-sqlite3`
  - _Requirements: R13 AC1_ — _Design: §4.6, D11, D12, D17_
- [x] A.4 CI: **typecheck + lint** (chưa có test job — test runner dựng ở B.1)
  - Node 24 pin minor version
  - _Requirements: R2 AC1_ — _Design: §11.1_
- [x] A.5 **Sửa steering 07 §1** — một `vidcom.sqlite` thay `jobs.sqlite` + `audit.sqlite`
  - _Design: D5_
- [x] A.6 Tạo `implementation-notes.html` rỗng có khung sẵn (Tailwind CDN, tiếng Việt)
  - _Requirements: —_ — _AGENTS.md mục 4_
- [x] A.7 Test: fixture import sai chiều → lint fail
  - _Requirements: R1 AC6_

**Acceptance Criteria**:
- [x] `npx tsc --noEmit` sạch toàn workspace
- [x] Import vi phạm boundary làm CI đỏ, log chỉ đúng file vi phạm
- [x] Mọi dependency mới pin exact, không caret
- [x] Steering 07 §1 khớp thiết kế một database

**Deliverables**: `packages/*/package.json`, `eslint.config.mjs`, `.github/workflows/ci.yml`, `llm-documents/steering/07-data-and-storage.md`, `implementation-notes.html`

---

## Phase B: Golden baseline — GATE

**Addresses**: R2 · **Design**: §11.2, Finding 3 · **Prerequisite**: A

> [!IMPORTANT]
> Phải **xanh** trước khi bất kỳ task nào ở G, H hoặc N chạy. R2 AC2 là điều kiện chặn.
>
> **Sửa sau review**: harness đặt ở vị trí **trung lập** (`tests/golden/`), import `@hyperframes/sdk` trực tiếp và đọc project mẫu — **không** đặt trong `packages/adapter/hyperframes` vì package đó tới Phase H mới tồn tại. H sẽ trỏ lại harness vào adapter mới mà **không** đổi expected file.

**Tasks**:
- [x] B.1 Dựng test runner + `tests/golden/` + thêm test job vào CI
  - _Requirements: R2 AC1_ — _Design: §11.1_
- [x] B.2 Golden `composition.serialize()` trên `warm-grain` (đã bị SDK ghi) và `swiss-grid` (chưa)
  - Expected commit vào repo; CI fail khi lệch; **không** auto-update
  - _Requirements: R2 AC2, AC3_ — _Design: §11.2_
- [x] B.3 Chín fixture parse tối giản, mỗi cái comment nói bắt lỗi gì
  - `<template>` wrap · scene inline · nhiều host có width+height · selector scope theo composition id · tween unresolved · element chỉ có tween · media cấp body · legacy `data-end`/`data-layer` · hai script GSAP một scene
  - _Requirements: R2 AC5, R4 AC4_ — _Design: §11.3_
- [x] B.4 Golden `buildPreviewCss()` + inject preview settings
  - tone off/dark/cream × 5 backgroundFx × subtitle override on/off × scene hidden
  - _Requirements: R2 AC3, R4 AC5_ — _Design: §11.2_
- [x] B.5 Clock/ID giả deterministic dùng chung
  - _Requirements: R2 AC4_ — _Design: §5.2_

**Acceptance Criteria**:
- [x] Chạy suite hai lần cho kết quả giống hệt
- [x] Sửa một byte output `serialize()` → CI đỏ
- [x] Cả 9 edge case parse có fixture và đang xanh
- [x] Harness **không** import từ `packages/adapter/**`

**Deliverables**: `tests/golden/**`, `fixtures/**`, `vitest.config.ts`

---

## Phase C: `contracts` — schema, ErrorCode, Diagnostic

**Addresses**: R7 · **Design**: §5.1, §6.3, §8 · **Prerequisite**: B

**Tasks**:
- [x] C.1 `ErrorCode` enum đầy đủ theo §8.1, gồm `workspace_lease_lost`, `workspace_lease_denied`, `idempotency_key_reused`, `version_format_legacy`, `asset_not_allowed`, `precondition_required`
  - _Requirements: R7 AC4_ — _Design: §8.1_
- [x] C.2 Kiểu `Diagnostic` — **chỉ hình dạng**, Phase 1 luôn `[]`
  - _Requirements: R7 AC5a_ — _Design: §6.3_
- [x] C.3 zod schema cho mọi DTO của §7 (request + response từng endpoint)
  - _Requirements: R7 AC1_ — _Design: §7_
- [x] C.4 Kiểu domain dùng chung: `ProjectId`, `RelPath`, `ContentHash`, `Actor`, `DomainEvent`, `DomainError`
  - _Requirements: R7 AC3_ — _Design: §5.2_
- [x] C.5 Contract test khoá shape response
  - _Requirements: R7 AC6_ — _Design: §11.1_

**Acceptance Criteria**:
- [x] `contracts` **không import package nội bộ `@vidcom/*`**; được phép import `zod`
  - *(Sửa finding: v1 ghi "không import gì" trong khi C.3 yêu cầu zod — mâu thuẫn)*
- [x] Đổi shape không tương thích → contract test đỏ trước khi merge

**Deliverables**: `packages/contracts/src/{errors,diagnostics,dto,domain}.ts`

---

## Phase D: Domain, port, WorkspaceResolver, PathPolicy

**Addresses**: R3, R4 (một phần), R6 (phần thuần) · **Design**: §5.2, §5.3, §5.6 · **Prerequisite**: **C**

**Tasks**:
- [x] D.1 Domain type + invariant thuần (`duration > 0`, `start >= 0`, vs root duration)
  - _Requirements: R4 AC2_ — _Design: §6.2_
- [x] D.2 Khai 9 port interface, **mỗi method có doc comment**
  - `WorkspacePort`, `CompositionPort`, `MutationJournalPort`, `LeasePort`, `SessionPort`, `EventOutboxPort`, `JobStorePort`, `ClockPort`, `IdPort`
  - Doc comment nói rõ `null` nghĩa gì, có I/O không, đắt hay không ([11-code-style](../../../steering/11-code-style.md) §4.3)
  - **`EventOutboxPort` không nhận kiểu transaction của Kysely** — xem finding phụ ở M.1
  - _Requirements: R4 AC1, AC6_ — _Design: §5.2_
- [x] D.3 `Result<T, DomainError>` + helper
  - _Requirements: R7 AC3_ — _Design: §8_
- [x] D.4 `WorkspaceResolver` — 4 mức ưu tiên, **không** tự tạo/đoán thư mục
  - _Requirements: R3 AC1, AC2, AC3_ — _Design: §5.3_
- [x] D.5 `PathPolicy` thuần: `checkSyntax`, `checkPurpose` — không chạm đĩa
  - _Requirements: R6 AC1, AC2_ — _Design: §5.6, D14_
- [x] D.6 Unit test: invariant, resolver order, PathPolicy 5 purpose
  - _Requirements: R2 AC6_

**Acceptance Criteria**:
- [x] `packages/core` không import `node:fs`, `hono`, `next`, `react`, adapter — lint xác nhận
- [x] Mọi hàm export có doc comment

**Deliverables**: `packages/core/{domain,port,error}/**`

---

## Phase E: `adapter/fs`

**Addresses**: R6 · **Design**: §5.6, D14 · **Prerequisite**: D

**Tasks**:
- [x] E.1 `ResolvedPath` branded type + `WorkspacePort.resolve()`
  - syntax → join/canonicalize → realpath **ancestor gần nhất đang tồn tại** → containment lại → `checkPurpose`
  - _Requirements: R6 AC1, AC3_ — _Design: §5.6_
- [x] E.2 Allowlist 5 purpose + **bảng mapping `PathRejection` → `ErrorCode` → HTTP** (design §5.6, bắt buộc, không để adapter tự chọn)
  - `read-asset`, `read-source`, `write-source`, `write-asset`, `system-write`
  - `system-write` **không** reachable từ route nào
  - _Requirements: R6 AC5, AC6_ — _Design: §5.6_
- [x] E.3 **Khoá extension + MIME cho `read-asset`** — hai điều kiện AND (thư mục **và** đuôi)
  - Danh sách đuôi chốt ở design §5.6; MIME suy **từ đuôi**, không từ nội dung do client kiểm soát
  - Đuôi ngoài danh sách → `asset_not_allowed` dù nằm trong thư mục được phép
  - *(Sửa finding: v1 chỉ khoá theo thư mục)*
  - _Requirements: R6 AC5_ — _Design: §5.6_
- [x] E.4 `writeAtomic`: temp cùng filesystem → fsync → rename
  - _Requirements: R5 AC4, AC5_ — _Design: §4.3.1_
- [x] E.5 `readTree`, `readFile`, `readHash` (sha256), `stat` — đều nhận `ResolvedPath`
  - _Requirements: R4 AC1_ — _Design: §5.2_
- [x] E.6 Integration test filesystem thật — containment
  - `..`, absolute path, symlink escape, **ancestor** symlink escape × 5 purpose
  - _Requirements: R6 AC7, R2 AC5_
- [x] E.7 Integration test — allowlist & tạo mới
  - Đuôi ngoài danh sách bị chặn trong thư mục hợp lệ; **tạo file mới (target chưa tồn tại) thành công**; kill giữa `writeAtomic` → file đích còn nguyên bản cũ
  - _Requirements: R6 AC6, R5 AC5_

**Acceptance Criteria**:
- [x] Không đường gọi `readFile`/`writeAtomic` bằng string thô — typecheck xác nhận
- [x] `asset_not_allowed` phân biệt được với `not_found`, không tiết lộ file có tồn tại

**Deliverables**: `packages/adapter/fs/{resolve,workspace-fs,atomic-write}.ts`

---

## Phase F: `adapter/db` + bảng identity

**Addresses**: R11 (nền), R12 (nền), R5 (nền), R3 · **Design**: §6.4, §6.5, D11, D17 · **Prerequisite**: D

**Tasks**:
- [x] F.1 Kết nối Drizzle trực tiếp với `node:sqlite` `DatabaseSync`, không còn dialect/facade Kysely; có smoke test result metadata
  - _Design: D17_
- [x] F.2 Bật WAL, một writer; khai Drizzle schema DB một chỗ
  - _Requirements: R11 AC10_ — _Design: §6.1_
- [x] F.3 Drizzle migration nền tạo **11 bảng ứng dụng**
  - `project_registry`, `workspace_lease`, `mutation_journal`, `revision`, `revision_blob`, `entity_state`, `audit_entry`, `event_outbox`, `job`, `app_settings`, `registry_cache`
  - Drizzle quản lý `__drizzle_migrations`; không còn bảng migration Kysely
  - *(Sửa finding: v1 ghi "12 bảng" — sai)*
  - Chỉ viết `up`, không viết `down`
  - _Requirements: R11 AC9_ — _Design: §6.4_
- [x] F.4 Drizzle migrator chạy lúc khởi động, idempotent, **trước** khi mở listener; không có compatibility shim ORM cũ
  - _Requirements: R11 AC9_ — _Design: §6.5_
- [x] F.5 Integration test: migration từ DB rỗng, chạy lại idempotent, `PRAGMA integrity_check`, mọi CHECK/FK/partial-unique
  - _Requirements: R2 AC5_
- [x] F.6 Smoke test bề mặt Drizzle + `node:sqlite` đang dùng
  - _Requirements: R13 AC1_ — _Design: D11_

**Acceptance Criteria**:
- [x] DB ở app-data, **không** trong workspace
- [x] `PRAGMA journal_mode` trả `wal`

**Deliverables**: `packages/adapter/src/db/{client,schema}.ts`, `packages/adapter/drizzle/**`, `drizzle.config.ts`

---

## Phase G: WriteAuthority — lease, journal, reconciliation, bootstrap identity

**Addresses**: R5, R3 · **Design**: §4.3.1, §5.5, §5.12, D13 · **Prerequisite**: **B xanh**, E, F

> Phần rủi ro cao nhất của spec.

**Tasks**:
- [x] G.1 `WorkspaceLease`: acquire / renew / release / assertHeld
  - `INSERT … ON CONFLICT DO UPDATE WHERE expires_at < now`; TTL 30s, renew 10s; chiếm lease quá hạn → audit `lease.stolen`
  - _Requirements: R5 AC7_ — _Design: §5.12_
- [x] G.2 `MutationJournalPort`: `begin` / `abort` / `listPending`
  - _Requirements: R5 AC6_ — _Design: §5.2_
- [x] G.3 `MutationJournalPort.commit()` — **một** transaction
  - journal→`committed` + `revision` + `revision_blob` + `entity_state` (nếu entity) + `audit_entry` + `event_outbox`
  - **Đây là nơi duy nhất ghi `event_outbox` trong luồng mutation** — M.1 chỉ thêm đường append **ngoài** mutation
  - _Requirements: R5 AC6_ — _Design: §4.3.1_
- [x] G.4 `WriteAuthority.mutate()` — tầng lease + mutex `projectId`
  - _Requirements: R5 AC1, AC7_ — _Design: §5.5_
- [x] G.5 Precondition **file mutation**: `expectedContentHash`; `null` chỉ hợp lệ khi tạo mới
  - Từ chối format `mtime`+`size` cũ bằng `version_format_legacy`
  - _Requirements: R5 AC2, AC3, AC3b_ — _Design: §5.5, D2_
- [x] G.6 Precondition **entity mutation**: `expectedRevision` **và** `entity_state.content_hash` còn khớp file nền
  - Xử lý trạng thái `revision = 0` (entity tồn tại logic, chưa có file) theo bảng design §4.3.3
  - _Requirements: R5 AC2, AC3a_ — _Design: §5.5, D3_
- [x] G.7 Conflict response kèm nội dung server hiện tại để diff/merge
  - _Requirements: R5 AC3a_ — _Design: §7.5_
- [x] G.8 **`bootstrapProject()`** — giải vòng phụ thuộc FK
  - Transaction A: `INSERT project_registry` trước → seed entity → journal `pending`; sau atomic write `vidcom.json` qua purpose `system-write`, transaction B commit revision/blob/audit/event
  - Đây là lý do backfill **không** cần đường ghi thứ hai
  - Seed `entity_state` cho `preview-settings`: có file → `revision = 1` + hash thật; không có file → `revision = 0` + hash bản normalize mặc định (design §4.3.3)
  - *(Sửa finding: v1 không có task này và có vòng phụ thuộc FK)*
  - _Requirements: R3 AC5, R5 AC1_ — _Design: §6.5_
- [x] G.9 Xử lý **trùng project ID** khi copy thư mục
  - Project mở sau nhận ID mới, ghi lại `vidcom.json`, audit sự kiện
  - _Requirements: R3 AC6_ — _Design: §6.5, §9.4 (design)_
- [x] G.10 Reconciliation lúc khởi động cho journal `pending` — 4 nhánh theo bảng §4.3.1
  - `orphaned` phải surface, không nuốt
  - _Requirements: R5 AC5_ — _Design: §6.5_
- [x] G.11 Integration test — crash boundary
  - Kill ở từng mốc; khởi động lại cho đúng `aborted`/`recovered`/`orphaned`
  - _Requirements: R5 AC5, R2 AC5_
- [x] G.12 Integration test — concurrency & lease
  - Hai mutation cùng `expectedContentHash` → đúng một thắng; daemon B không acquire được khi A giữ; A chết → B chiếm sau TTL; mất lease → `workspace_lease_lost`
  - _Requirements: R5 AC7_
- [x] G.13 Integration test — identity
  - Project thiếu `vidcom.json` → sinh ID, composition **không đổi** · project di chuyển thư mục → **giữ** ID · hai thư mục trùng ID → cấp mới + audit
  - _Requirements: R3 AC4, AC5, AC6_

**Acceptance Criteria**:
- [x] Không đường ghi project thứ hai — grep xác nhận chỉ `WriteAuthority` gọi `writeAtomic`
- [x] Mất lease → mutation từ chối, đường đọc vẫn chạy
- [x] Ba kịch bản identity đều pass trên filesystem thật

**Deliverables**: `packages/core/service/write-authority.ts`, `packages/core/usecase/bootstrap-project.ts`, `packages/adapter/db/{journal,lease}.ts`

---

## Phase H: `adapter/hyperframes` + compat wrapper

**Addresses**: R4 · **Design**: §5.4, §4.3.2 · **Prerequisite**: **B xanh**, D

> **Sửa sau review**: v1 định xoá `src/lib/hyperframes/*.server.ts` ngay ở phase này, trong khi page và Next route còn dùng tới K/N. Phase H **giữ compat wrapper**; xoá ở N.

**Tasks**:
- [x] H.1 Chuyển `projects.server.ts` sang adapter (project ref, tree, source read)
  - Bỏ `process.cwd()`; cài `DOMParser` shim **một lần** ở entry adapter
  - _Requirements: R4 AC1, R3 AC3_ — _Design: §5.4_
- [x] H.2 Chuyển `composition-root.server.ts` + `scene-elements.server.ts`
  - Giữ nguyên thuật toán; giữ `<template>` handling
  - _Requirements: R4 AC1_ — _Design: §5.4_
- [x] H.3 Chuyển `scenes.server.ts` + `root-track.server.ts`
  - _Requirements: R4 AC1_ — _Design: §5.4_
- [x] H.4 Sửa hai chỗ đã xác định
  - Root host = `nearestHost(node) === null`; element key fallback `tag:rows.size` → path trong DOM tree
  - _Requirements: R4 AC4_ — _Design: §5.4_
- [x] H.5 `parseProject()` trả **một** `CompositionModel` dùng chung project/scenes/rootTrack
  - _Requirements: R4 AC1_ — _Design: §4.3.2_
- [x] H.6 `buildDocument()` — **đường duy nhất** dựng preview (P3)
  - _Requirements: R4 AC5_ — _Design: §5.2_
- [x] H.7 `applyOps()` qua SDK, trả HTML đã serialize, **không** tự ghi đĩa
  - _Requirements: R5 AC1_ — _Design: §5.2_
- [x] H.8 **Compat wrapper**: `src/lib/hyperframes/*.server.ts` giữ nguyên chữ ký, ủy quyền xuống adapter
  - App vẫn chạy trong suốt H → N
  - _Requirements: R9 AC4_
- [x] H.9 Trỏ golden harness của B vào adapter mới, **không** đổi expected file
  - _Requirements: R2 AC3_
- [x] H.10 Giữ "đếm, không đoán" cho `unresolvedEffects`; test 9 fixture qua `parseProject()`
  - _Requirements: R4 AC3, AC4_

**Acceptance Criteria**:
- [x] Golden `serialize()` của B vẫn xanh sau khi chuyển
- [x] App chạy bình thường; không có đường dựng preview thứ hai
- [x] `src/lib/hyperframes/*.server.ts` chỉ còn là wrapper mỏng

**Deliverables**: `packages/adapter/hyperframes/{parse,document,sdk-ops}.ts`, `src/lib/hyperframes/*.server.ts` (thu về wrapper)

---

## Phase I: Application use case + composition root + startup order

**Addresses**: R1 AC4, AC5 · **Design**: §5 (design), §2.2 (goals R1) · **Prerequisite**: G, H

> **Phase mới sau review.** v1 chỉ có port, adapter và route — thiếu tầng use case và composition root, nên nghiệp vụ rất dễ rơi ngược vào Hono handler.

**Tasks**:
- [x] I.1 Use case đọc: `listProjects`, `getStudioSnapshot`, `readSourceFile`, `readAsset`, `getPreviewSettings`
  - Mỗi use case nhận `deps` qua tham số, trả `Result`
  - _Requirements: R1 AC3, AC4, R10 AC1, AC2_ — _Design: §5 (design) §2.2_
- [x] I.2 Use case ghi: `saveSourceFile`, `patchPreviewSettings`, `uploadBgm`, `setSceneTiming`, `setSceneScript`
  - Mọi cái gọi `WriteAuthority`, **không** gọi `writeAtomic` trực tiếp
  - Trả entity + revision + `diagnostics: []`
  - _Requirements: R5 AC1, R7 AC5, AC5a_ — _Design: §5.5_
- [x] I.3 Use case legacy giữ tương thích: `regenerateNarration` (tts), `createScene` (generate)
  - Hành vi giữ nguyên nhưng đường ghi đi qua WriteAuthority
  - _Requirements: R9 AC4_ — _Design: §7.11, D16_
- [x] I.4 **Composition root** ở `packages/cli` — nơi **duy nhất** nối port với adapter cụ thể
  - _Requirements: R1 AC5_ — _Design: §5 (design) §5_
- [x] I.5 **Startup order** tường minh, mỗi bước fail thì dừng có thông điệp rõ
  - `migration → acquire lease → reconciliation journal → job recovery → identity backfill → scheduler + watcher → mở HTTP listener`
  - Listener **chỉ** mở sau khi mọi bước trên xong
  - _Requirements: R11 AC9, R5 AC5, R3 AC5_ — _Design: §6.5_
- [x] I.6 Unit test happy path + failure path cho **mỗi** use case
  - Dùng port giả; clock/ID deterministic
  - _Requirements: R2 AC6_
- [x] I.7 Integration test startup order: từng bước fail → daemon không mở listener

**Acceptance Criteria**:
- [x] Bỏ hoàn toàn tầng HTTP thì mọi use case vẫn gọi được — kiểm bằng test gọi thẳng use case
- [x] Không route handler nào chứa nghiệp vụ
- [x] `packages/cli` là nơi duy nhất `new` adapter cụ thể

**Deliverables**: `packages/core/usecase/**`, `packages/cli/{composition-root,startup}.ts`

---

## Phase J: Hono app, middleware, auth, bridge credential

**Addresses**: R8 · **Design**: §5.7, §5.8, §4.3.4, D15 · **Prerequisite**: **D** (SessionPort)

**Tasks**:
- [x] J.1 Hono `app` với `basePath('/api')`, export từ `packages/server`, **không** import `next`
  - _Requirements: R9 AC3_ — _Design: §5.1 (design)_
- [x] J.2 Middleware chain đúng thứ tự
  - `requestId → logger → hostCheck → cors → auth → bodyLimit → validate → route → errorMapper`
  - _Requirements: R8 AC7_ — _Design: §5.8_
- [x] J.3 `hostCheck` + CORS từ chối mặc định (không wildcard, không phản chiếu `Origin`)
  - _Requirements: R8 AC2, AC3_ — _Design: §5.8_
- [x] J.4 Nonce: 32 byte, TTL 60s, một lần, đánh dấu đã dùng **trước** khi mint
  - _Requirements: R8 AC4, AC5_ — _Design: §5.8_
- [x] J.5 Session: token **mới** (≠ nonce), lưu `sha256`, in-memory, TTL 12h / idle 2h
  - `Referrer-Policy: no-referrer`; logger redact query `t`
  - _Requirements: R8 AC4, AC6_ — _Design: §5.8, D15_
- [x] J.6 **Bridge credential store** — R8 AC8
  - File trong app-data, quyền `0600` (Windows: ACL tương đương); **không** vào workspace, không vào log
  - CLI đọc credential để MCP bridge (Phase 2) kết nối daemon
  - *(Sửa finding: v1 chỉ làm nonce/session của browser, bỏ sót AC8 nhưng coverage vẫn đánh dấu R8 xong)*
  - _Requirements: R8 AC8_ — _Design: §5.12, §9.2_
- [x] J.7 `errorMapper` — nơi **duy nhất** biết ErrorCode → HTTP status
  - _Requirements: R7 AC4_ — _Design: §5.7_
- [x] J.8 Bind loopback, port động, xử lý conflict
  - _Requirements: R8 AC1_ — _Design: §9.2_
- [x] J.9 Integration test bảo mật
  - Host lạ → 403 **trước** auth; cross-origin → 403; không session → 401 kể cả localhost; nonce dùng hai lần → fail; restart daemon → cookie cũ vô hiệu; `?t=` không có trong log
  - _Requirements: R8 AC2–AC6, R2 AC5_
- [x] J.10 Integration test credential file: quyền thật trên đĩa là `0600`, không đọc được bởi user khác
  - _Requirements: R8 AC8_

**Acceptance Criteria**:
- [x] Không endpoint nào (trừ `/auth/exchange`) phục vụ request thiếu session
- [x] Token phiên khác nonce — test xác nhận
- [x] Credential file có quyền đúng, kiểm trên filesystem thật

**Deliverables**: `packages/server/{app,middleware/**,routes/auth}.ts`, `packages/adapter/fs/credential-store.ts`

---

## Phase K: Cutover route ĐỌC + snapshot API

**Addresses**: R9, R10 · **Design**: §4.4, §7.2, §7.3, D4, D16 · **Prerequisite**: I, **J**

> **Sửa sau review**: chỉ xoá file route Next **chỉ có GET**. File có nhiều method giữ tới Phase N.
>
> | File | Method | Xoá ở |
> |---|---|---|
> | `runtime/route.ts` | GET | **K** |
> | `[slug]/preview/route.ts` | GET | **K** |
> | `[slug]/files/[...path]/route.ts` | GET | **K** |
> | `[slug]/source/route.ts` | GET + **PUT** | **N** |
> | `[slug]/preview-settings/route.ts` | GET + **PATCH** + **POST** | **N** |
> | `[slug]/scene/route.ts` | PATCH | **N** |

**Tasks**:
- [x] K.1 Gắn Hono vào Next qua `src/app/api/[[...route]]/route.ts`
  - `runtime = "nodejs"`, `dynamic = "force-dynamic"`, export đủ method, **không** logic
  - _Requirements: R9 AC1_ — _Design: §5.1 (design)_
- [x] K.2 Smoke test precedence trên codebase thật trước khi dựa vào nó
  - _Requirements: R9 AC1_ — _Design: Finding 2_
- [x] K.3 Cutover `GET /runtime` → `/api/v1/runtime` + legacy alias; xoá `runtime/route.ts`; verify
  - _Requirements: R9 AC2, AC4_
- [x] K.4 Cutover `GET /files/*` → `/api/v1/projects/:id/assets/*` **kèm allowlist + MIME lock**; alias; xoá file; verify
  - _Requirements: R9 AC2, R6 AC5_
- [x] K.5 Cutover `GET /preview` → `/api/v1/projects/:id/preview`; alias; xoá file; verify
  - _Requirements: R9 AC2_
- [x] K.6 Thêm `/api/v1/projects/:id/files?path=` và `/api/v1/projects/:id/preview-settings` (GET); **chuyển UI sang dùng chúng**
  - **Không** xoá file Next tương ứng — chúng còn write handler
  - Trong cửa sổ K→N tồn tại hai đường đọc cùng dữ liệu; cả hai gọi **cùng use case** nên không lệch hành vi (design §4.4)
  - _Requirements: R9 AC4_
- [x] K.7 `GET /api/v1/projects` + `GET /api/v1/projects/:id/studio-snapshot`
  - Đủ để mở studio trong **một** request
  - _Requirements: R10 AC1, AC2, AC3_ — _Design: §7.2, §7.3_
- [x] K.8 Bỏ RSC đọc filesystem ở `src/app/page.tsx` và `src/app/projects/[slug]/page.tsx`
  - _Requirements: R10 AC6_ — _Design: §14.3 (design)_
- [x] K.9 Không rò absolute path trong lỗi
  - _Requirements: R10 AC4_ — _Design: §8.2_
- [x] K.10 Routing contract test: precedence, error mapping, tương đương trước/sau **mỗi** cutover
  - _Requirements: R9 AC6, AC8_

**Acceptance Criteria**:
- [x] Studio mở được sau **mỗi** bước; không bước nào app hỏng
- [x] Không `.server.ts` nào được import từ `src/app/**`
- [x] Ba file route đã xoá; ba file còn lại vẫn phục vụ write

**Deliverables**: `src/app/api/[[...route]]/route.ts`, `packages/server/routes/{runtime,assets,preview,projects}.ts`, xoá 3 file route

---

## Phase L: Job infrastructure

**Addresses**: R11 · **Design**: §5.9, §4.5, §6.4 · **Prerequisite**: F

**Tasks**:
- [x] L.1 `JobStorePort` + `SqliteJobStore`; claim bằng `UPDATE … WHERE status='queued'` rồi kiểm 1 dòng đổi
  - _Requirements: R11 AC1, AC2_ — _Design: §6.4_
- [x] L.2 Idempotency `(project_id, type, idempotency_key)` + `input_hash` canonicalize
  - Ba trường hợp: retry / `409 idempotency_key_reused` / khác project
  - _Requirements: R11 AC5_ — _Design: §5.9_
- [x] L.3 Scheduler in-process, concurrency **theo type**, cùng `(project,type)` tuần tự
  - _Requirements: R11 AC8_ — _Design: §5.9_
- [x] L.4 Progress đơn điệu + throttle; cancel hợp tác tại safe point, dọn output dở, terminal → no-op
  - _Requirements: R11 AC4, AC6_ — _Design: §4.5_
- [x] L.5 Heartbeat + recovery lúc khởi động (fail hoặc requeue theo `idempotent`)
  - _Requirements: R11 AC7_ — _Design: §4.5_
- [x] L.6 Job type `noop-probe` theo đặc tả ở design §5.9
  - `input: { steps, delayMs, failAtStep? }`; safe point ở **đầu mỗi vòng**; khai `idempotent: true` để test nhánh requeue
  - _Requirements: R11 AC1_ — _Design: §5.9_
- [x] L.7 `GET /api/v1/jobs/:id`, `POST /api/v1/jobs/:id/cancel`
  - _Requirements: R11 AC3_ — _Design: §7.7_
- [x] L.8 Integration test: lifecycle, cancel, kill → recovery, idempotency ba trường hợp
  - _Requirements: R2 AC5_

**Acceptance Criteria**:
- [x] Job state sống qua restart
- [x] Không job nào vượt concurrency limit của type

**Deliverables**: `packages/core/service/job-scheduler.ts`, `packages/adapter/db/job-store.ts`, `packages/worker/noop-probe.ts`

---

## Phase M: Event outbox, SSE, watcher, cache

**Addresses**: R12 · **Design**: §5.10, §5.11, §4.3.3, D7 · **Prerequisite**: F

**Tasks**:
- [x] M.1 `EventOutboxPort.append()` — đường ghi event **ngoài** mutation (watcher, job progress)
  - Event **trong** mutation do G.3 ghi trong transaction của journal — M **không** ghi lại
  - Port **không** nhận kiểu transaction của Kysely; journal tự gọi hàm nội bộ của adapter
  - *(Sửa finding: v1 có cả `appendInTx` ở port lẫn ghi trong G.2 → nguy cơ ghi trùng và rò kiểu Kysely vào core)*
  - _Requirements: R12 AC2_ — _Design: §5.10_
- [x] M.2 `GET /api/v1/events` SSE
  - `Last-Event-ID` đọc từ outbox (sống qua restart); heartbeat `:hb` 15s; ngoài retention → `gap: true` + event `resync`
  - _Requirements: R12 AC1, AC2, AC3_ — _Design: §7.8_
- [x] M.3 File watcher + debounce 150ms; so `lastWrittenHash` để không tự kích hoạt vòng lặp
  - _Requirements: R12 AC4, AC5_ — _Design: §4.3.3_
- [x] M.4 Watcher nhích `entity_state.revision` khi file nền bị sửa ngoài
  - _Requirements: R12 AC4, R5 AC2_ — _Design: §4.3.3_
- [x] M.5 `ProjectCache` — memo `CompositionModel` chung, invalidate theo **event**, LRU 20, reject thì xoá entry
  - _Requirements: R12 AC6_ — _Design: §5.11, D7_
- [x] M.6 Integration test
  - Resume `Last-Event-ID` **sau restart**; ngoài retention → `resync`; `job.progress` không sinh revision vẫn có `seq`; sửa ngoài `preview-settings.json` → patch revision cũ nhận `write_conflict`; ghi từ WriteAuthority **không** sinh event trùng
  - SSE qua host Next **không bị buffer**
  - _Requirements: R12 AC5, AC7, AC8_

**Acceptance Criteria**:
- [x] Poll endpoint và SSE phản ánh **cùng** persisted job state
- [x] Mỗi mutation sinh **đúng một** logical event

**Deliverables**: `packages/adapter/db/event-outbox.ts`, `packages/adapter/fs/watcher.ts`, `packages/core/service/project-cache.ts`, `packages/server/routes/events.ts`

---

## Phase N: Cutover route GHI + legacy alias + xoá module cũ

**Addresses**: R5, R9 · **Design**: §4.4, §7.5, §7.6, §7.10, §7.11, D16 · **Prerequisite**: I, K, L, M

**Tasks**:
- [x] N.1 `PUT /api/v1/projects/:id/files` qua WriteAuthority
  - 409 kèm khối `current` để diff/merge
  - _Requirements: R5 AC3, AC3a, R7 AC5_ — _Design: §7.5_
- [x] N.2 Client đổi `baseVersion` → `expectedContentHash` **trong cùng bước** với N.1
  - Server phát hiện format cũ bằng regex ở design §7.5 → `version_format_legacy`; **không** bao giờ coi format lạ là bỏ qua kiểm tra
  - `src/components/studio/use-source-files.ts`
  - _Requirements: R5 AC3b_
- [x] N.3 Xoá `[slug]/source/route.ts` (cả GET lẫn PUT đã có tương đương); verify
  - _Requirements: R9 AC2_
- [x] N.4 `PATCH /api/v1/projects/:id/preview-settings` — entity mutation
  - _Requirements: R5 AC2_ — _Design: §7.6_
- [x] N.5 `POST /api/v1/projects/:id/assets/bgm` — **composite mutation**
  - Nhận `expectedRevision` của `preview-settings`
  - Stage: ghi asset vào temp → journal `begin` → move asset vào `preview-assets/bgm/` → commit (patch settings + revision + audit + event)
  - Crash giữa chừng → reconciliation dọn asset mồ côi hoặc hoàn tất; **không** để settings trỏ file chưa tồn tại
  - Kiểm magic bytes; không ghi đè im lặng
  - *(Sửa finding: v1 gọi là entity mutation nhưng thiếu `expectedRevision` và không xử lý hai tài nguyên)*
  - _Requirements: R5 AC1, AC2, AC5, AC8_ — _Design: §7.10_
- [x] N.6 Xoá `[slug]/preview-settings/route.ts`; verify
  - _Requirements: R9 AC2_
- [x] N.7 Tách `PATCH /scene` action `timing` và `script` thành route `/api/v1` riêng
  - _Requirements: R9 AC3_
- [x] N.8 **Legacy alias bắt buộc** cho `tts` và `generate` trong Hono
  - Hình dạng response chốt **byte-for-byte** ở design §7.11 — `narration.status` vẫn `"mock"`, `transcript` vẫn dựng sẵn
  - Chỉ đường ghi bên dưới đổi sang WriteAuthority; **không** thêm hành vi mới
  - _Requirements: R9 AC4_ — _Design: §7.11, D16_
- [x] N.9 Xoá `[slug]/scene/route.ts`; verify tab AI Composer và nút Regenerate TTS vẫn chạy
  - _Requirements: R9 AC4_
- [x] N.10 Xoá `src/lib/hyperframes/*.server.ts` (compat wrapper) — **chỉ sau khi** mọi consumer đã chuyển
  - _Requirements: R9 AC5_
- [x] N.11 Ghi lại từng bước cutover đủ để hoàn tác một route
  - _Requirements: R9 AC7_
- [x] N.12 Contract test khoá **cả hai** hình dạng (v1 và legacy) trước/sau cutover
  - _Requirements: R9 AC8_

**Acceptance Criteria**:
- [x] Nút *Regenerate TTS* và tab *AI Composer* vẫn chạy
- [x] Mọi ghi có precondition; không đường nào ghi đè im lặng
- [x] Upload BGM crash giữa chừng không để lại asset mồ côi hoặc settings trỏ file thiếu

**Deliverables**: `packages/server/routes/{files,preview-settings,scenes,legacy}.ts`, xoá 3 file route còn lại, xoá `src/lib/hyperframes/*.server.ts`

---

## Phase O: Milestone verification

**Addresses**: R13 · **Design**: §9, §12 · **Prerequisite**: N

**Tasks**:
- [x] O.1 Xác nhận `src/` chỉ còn **một** server forward entry
  - _Requirements: R13 AC3_ — _Design: §5.2 (design)_
- [x] O.2 Kiểm không package production nào dùng Bun-only API
  - _Requirements: R13 AC1_ — _Design: D10_
- [x] O.3 Native dependency path inject được, không giả định nằm cạnh source checkout
  - _Requirements: R13 AC2_ — _Design: §4.6_
- [x] O.4 End-to-end trên 3 project mẫu: list → mở → sửa → lưu → job → event
  - _Requirements: R13 AC4_ — _Design: §12_
- [x] O.5 Ghi rõ Node SEA artifact smoke là gate **Phase 4**
  - _Requirements: R13 AC5_
- [ ] O.6 Hoàn tất `implementation-notes.html`; cập nhật spec hiện hành §Spec Review + Retrospective; đổi tên spec `inprocess` → `complete`

**Acceptance Criteria**:
- [ ] Toàn bộ CI bắt buộc xanh
- [x] Ba project mẫu vẫn mở, sửa và lưu được

---

## Files Changed Summary

| File / thư mục | Phase | Thay đổi |
|---|---|---|
| `packages/contracts/**` | C | mới |
| `packages/core/{domain,port,error}/**` | D | mới |
| `packages/core/usecase/**` | G, I | mới |
| `packages/core/service/**` | G, L, M | write-authority, job-scheduler, project-cache |
| `packages/adapter/fs/**` | E, J, M | resolve, atomic write, credential store, watcher |
| `packages/adapter/db/**` | F, G, L, M | Drizzle schema/migration, journal, lease, job store, outbox |
| `packages/adapter/hyperframes/**` | H | chuyển từ `src/lib/hyperframes/` |
| `packages/server/**` | J, K, L, M, N | Hono app, middleware, routes |
| `packages/cli/**` | I | composition root, startup order |
| `packages/worker/noop-probe.ts` | L | mới |
| `src/app/api/[[...route]]/route.ts` | K | mới — file server **duy nhất** của Next |
| `src/app/api/hf/{runtime,[slug]/preview,[slug]/files}` | K | **xoá 3 file GET-only** |
| `src/app/api/hf/[slug]/{source,preview-settings,scene}` | N | **xoá 3 file còn lại** (có write handler) |
| `src/app/{page,projects/[slug]/page}.tsx` | K | bỏ RSC filesystem read |
| `src/lib/hyperframes/*.server.ts` | H → N | H thu về wrapper; N xoá |
| `src/components/studio/use-source-files.ts` | N | `baseVersion` → `expectedContentHash` |
| `eslint.config.mjs` | A | boundary rules |
| `llm-documents/steering/07-data-and-storage.md` | A | sửa §1 một database |
| `llm-documents/steering/{05-mcp-tool-design,08-jobs-and-queue,09-security}.md` | A | đồng bộ các tham chiếu audit/job sang `vidcom.sqlite` |
| `package.json`, `bun.lock`, `tsconfig*.json` | A | Bun workspaces, path alias, cấu hình TypeScript kế thừa và dependency pin exact |
| `.github/workflows/ci.yml`, `scripts/verify-import-boundaries.mjs` | A | CI Node/Bun đã pin và negative test cho import boundary |
| `tests/golden/**`, `fixtures/**` | B | mới |
| `implementation-notes.html` | A → O | ghi liên tục |

## Requirements Coverage Matrix

| Requirement | Task | Test |
|---|---|---|
| R1 AC1–3, AC6 boundaries | A.1, A.2, D.2 | A.7 |
| R1 AC4, AC5 use case + composition root | **I.1–I.5** | **I.6, I.7** |
| R2 Test harness | A.4, B.1–B.5 | toàn suite; B.2 là gate |
| R3 AC1–3 workspace resolve | D.4 | D.6 |
| R3 AC4–6 identity | **G.8, G.9** | **G.13** |
| R4 Ports & parse | D.2, H.1–H.7, H.10 | B.3, H.9, H.10 |
| R5 Write authority | G.1–G.8, N.1, N.4, N.5 | G.11, G.12, N.12 |
| R6 Path + allowlist + MIME | D.5, E.1–E.3 | E.6, E.7 |
| R7 Schema & error | C.1–C.4, J.7, I.2 | C.5 |
| R8 AC1–7 perimeter | J.2–J.5, J.8 | J.9 |
| R8 AC8 bridge credential | **J.6** | **J.10** |
| R9 Hono cutover | K.1, K.3–K.6, N.3, N.6–N.9, N.11 | K.2, K.10, N.12 |
| R10 List & snapshot | K.7, K.8, K.9 | K.10 |
| R11 Job foundation | L.1–L.7 | L.8 |
| R12 Event/watcher/cache | M.1–M.5 | M.6 |
| R13 Runtime & milestone | O.1–O.5 | O.4 |

**In đậm** = coverage v1 thiếu hoặc chỉ trỏ vào section design thay vì task.

## Deferred Items Reference

| # | Việc | Effort | Phụ thuộc |
|---|---|---|---|
| D1 | Range request cho asset | 2 SP | Phase 3 |
| D2 | Bộ quy tắc sinh diagnostics | 8 SP | lint engine, Phase 3 |
| D3 | Tách `worker` thành process riêng | 3 SP | Phase 4 |
| D4 | Undo/redo trên `revision_blob` | 8 SP | Phase 5 |
| D5 | Xoay vòng / hết hạn session dài | 2 SP | Phase 4 |
| D6 | Schema `subscriptions/listen` cho MCP modern | 3 SP | Phase 2 |
| D7 | Hai daemon khác `--app-data` cùng workspace | 3 SP | Phase 4, nếu có nhu cầu thật |
| D8 | Fallback `better-sqlite3` | 2 SP | chỉ khi `node:sqlite` phá vỡ API |
| D9 | Gỡ legacy alias `/api/hf/*` | 2 SP | Phase 2–3 |

Chi tiết: [Detail Design](./spec-core-backend-foundation-detailed-design.md) §13.

## Execution Log

> Ghi một entry mỗi phiên làm việc.

2026-08-01 — Phase A, Task A.1
  - Files: `package.json`, `bun.lock`, `tsconfig.json`, `tsconfig.base.json`, `packages/**`, `eslint.config.mjs`, `.github/workflows/ci.yml`, `scripts/verify-import-boundaries.mjs`, `llm-documents/steering/{05,07,08,09}-*.md`, `spec-core-backend-foundation-inprocess.md`, `spec-core-backend-foundation-detailed-goal.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Mở Code Execution, xác minh đúng 118 task ID, dựng 8 workspace package, thêm import boundary, pin dependency, tạo CI static checks, đồng bộ một `vidcom.sqlite` và hoàn tất negative test cho lint boundary.
  - Decisions: Giữ ngoại lệ migration tường minh cho `src/app/api/hf/**` và `src/lib/hyperframes/*.server.ts` tới H/K/N. Đồng bộ thêm steering 05/08/09 vì chúng còn tham chiếu hai database cũ. Checkout có staged baseline từ trước nên chưa commit để tránh trộn thay đổi thuộc người dùng.
  - Blockers: Không có blocker code; còn 10 lint warning có sẵn trong `.temp-documents`, không làm CI fail.

2026-08-01 — Phase B, Task B.1–B.5
  - Files: `vitest.config.ts`, `tests/golden/**`, `tests/support/**`, `fixtures/{serialize,parse,preview}/**`, `package.json`, `.github/workflows/ci.yml`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Khóa golden serialize cho hai project, 9 regression fixture parse, ma trận preview 60 tổ hợp và helper Clock/ID deterministic. Suite 15 test chạy xanh hai lượt liên tiếp; negative check sửa một byte expected serialize đã đỏ đúng yêu cầu.
  - Decisions: Harness tiếp tục import SDK trực tiếp ở vùng trung lập; helper Clock/ID dùng structural typing đúng chữ ký §5.2 để tái sử dụng khi Core port xuất hiện. Không thay expected theo adapter chưa tồn tại.
  - Blockers: Không có. Không phát sinh design drift.

2026-08-01 — Phase C, Task C.1–C.5
  - Files: `packages/contracts/src/{errors,diagnostics,dto,domain,index}.ts`, `tests/contracts/api-contracts.test.ts`, `vitest.config.ts`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Khai ErrorCode, Diagnostic, branded domain types và strict zod schemas cho request/response §7; contract suite khóa vocabulary, success/error/binary/SSE/no-content shapes và từ chối field lạ.
  - Decisions: `cancel` dùng response không body vì §7.7 chỉ cam kết status 202/200; `cancel_requested` giữ là cờ persistence, không đưa sai vào job status. Vitest resolve package public entry để contract test kiểm đúng boundary sử dụng thật.
  - Blockers: Không có. Không phát sinh design drift.

2026-08-01 — Phase D, Task D.1–D.6
  - Files: `packages/core/src/{domain,error,port}/**`, `tests/core/**`, `packages/contracts/src/errors.ts`, `tests/contracts/api-contracts.test.ts`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Dựng invariant timing thuần, 9 port interface có semantics I/O/null, Result helpers, workspace resolver theo đúng ưu tiên và PathPolicy 5 purpose; 23 core test xanh.
  - Decisions: Resolver nhận candidate đã được composition root xác minh marker để Core không chạm filesystem. ResolvedPath là capability branded; mọi port đọc/ghi nhận capability thay vì string thô.
  - Blockers: Không có. Design drift đã xử lý: thêm `timing_invalid` vào §8 và ErrorCode vì invariant timing là lỗi domain 422, không phải `schema_invalid` 400.

2026-08-01 — Phase E, Task E.1–E.7
  - Files: `packages/adapter/src/fs/**`, `packages/adapter/src/index.ts`, `packages/core/src/domain/models.ts`, `tests/adapter/fs.test.ts`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Hoàn tất canonical resolver, 5-purpose allowlist, extension/MIME mapping, atomic fsync+rename, workspace reads và 13 integration test filesystem thật gồm crash bằng SIGKILL.
  - Decisions: Mapping PathRejection dùng một bảng duy nhất; symlink escape và outside project cố ý trả cùng message. Atomic write có pre-rename hook chỉ để đặt child process đúng crash boundary, không thay đổi WorkspacePort.
  - Blockers: Không có. Không phát sinh design drift.

2026-08-01 — Phase F, Task F.1–F.6
  - Files: `packages/adapter/src/db/**`, `packages/adapter/src/index.ts`, `tests/adapter/{node-sqlite,database-migration}.test.ts`, `package.json`, `bun.lock`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Bọc node:sqlite cho Kysely, mở một WAL database ở app-data, tạo 11 bảng application bằng forward migration và khóa migration/constraint/native API bằng integration tests.
  - Decisions: Test root chỉ import public `@vidcom/adapter`, không mượn dependency Kysely xuyên workspace. Đồng bộ `@types/node` 24.13.3 với Node 24 runtime để node:sqlite được typecheck chính thức.
  - Blockers: Không có. Không phát sinh design drift.

2026-08-01 — Phase G, Task G.1–G.13
  - Files: `packages/core/src/{service/write-authority,usecase/bootstrap-project,usecase/reconcile-pending-mutations,domain/preview-settings,port/**}.ts`, `packages/adapter/src/{db/{lease,journal,schema,migrations/0001_init},fs/workspace-fs}.ts`, `tests/{core,adapter}/**`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Hoàn tất lease, journal-first WriteAuthority, file/entity precondition, bootstrap identity, duplicate-ID audit và startup reconciliation. 22 test trọng tâm xanh; 5 crash test dùng SIGKILL thật tại bốn boundary và tình huống third-party write.
  - Decisions: Journal lưu bytes trước write để recovery tạo được `revision_blob`; orphan trả journal ID trong report và audit đủ ba hash. Bootstrap dùng transaction A trước filesystem và transaction B sau rename vì SQLite không thể giữ atomic transaction xuyên filesystem I/O.
  - Blockers: Không có. Design drift đã đồng bộ ở §4.3.1/§5.2/§6.4/§6.5: bổ sung previous content vào journal và thay mô tả bootstrap một transaction bằng hai transaction có pending intent bắc cầu.

2026-08-01 — Phase H, Task H.1–H.10
  - Files: `packages/adapter/src/hyperframes/**`, `packages/adapter/package.json`, `packages/core/src/domain/models.ts`, `src/lib/hyperframes/*.server.ts`, `tests/{golden,adapter}/**`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Chuyển project/DOM/scene/root/SDK/document logic sang CompositionHf adapter; compat modules còn 166 dòng forwarding. Golden serialize + preview và 9 fixture parse đều chạy qua adapter, 18 test H/golden xanh; production build và ba HTTP smoke path trả 200.
  - Decisions: Root host dùng ancestry, fallback element ID dùng DOM path; một base document builder sở hữu duy nhất `buildSubCompositionHtml`. `applyOps` nhận union SDK-neutral và chỉ trả serialization; các legacy write wrapper được giữ tới Phase I/N để app không gãy giữa cutover.
  - Blockers: Không có. Design drift đã đồng bộ: `CompositionOp` đổi từ string/unknown mở sang union `setText | setTiming | addElement` để lỗi shape bị chặn ở typecheck.

2026-08-01 — Phase I, Task I.1–I.7
  - Files: `packages/core/src/usecase/{project-reads,project-writes}.ts`, `packages/core/src/{domain/models,port/ports,service/write-authority}.ts`, `packages/adapter/src/{fs/workspace-fs,hyperframes/sdk-ops}.ts`, `packages/cli/src/{composition-root,startup}.ts`, `src/lib/hyperframes/{projects,scenes}.server.ts`, `tests/{core,cli}/**`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Hoàn tất 5 read, 5 write và 2 legacy use case không phụ thuộc HTTP; dựng composition root duy nhất và startup sequence 8 bước. 35 test I xanh; toàn core/adapter/cli/golden 116 test xanh.
  - Decisions: Asset read có port bytes riêng để không làm hỏng binary; upload ghi asset trước rồi mới patch settings. Startup release lease và đóng DB nếu bất kỳ prerequisite nào fail; listener là bước cuối duy nhất.
  - Blockers: Không có blocker code. Acceptance “route handler không chứa nghiệp vụ” cố ý để mở tới J/K/N cutover; không đánh dấu trước bằng chứng. Design drift đã đồng bộ: WorkspacePort thêm `readBytes` cho `readAsset`.

2026-08-01 — Phase J, Task J.1–J.10
  - Files: `packages/server/src/{app,auth/**,middleware/**,routes/auth,listener,index}.ts`, `packages/server/package.json`, `packages/adapter/src/fs/credential-store.ts`, `packages/adapter/src/index.ts`, `tests/server/security.test.ts`, `bun.lock`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Dựng Hono base `/api`, khóa perimeter requestId → logger → hostCheck → cors → auth → bodyLimit → validate → route → errorMapper; hoàn tất nonce/session, bridge credential và listener loopback port động. 13 test J cùng toàn bộ 22 file/135 test xanh.
  - Decisions: Listener nhận app factory theo actual OS-selected port để Host allowlist không dùng port 0. Credential dùng POSIX `0600`; Windows xoá inherited ACL rồi chỉ grant read/write cho SID hiện tại bằng argument array, không qua shell.
  - Blockers: Không có. Không phát sinh design drift; `npx hono request` của skill không có executable trong package Hono đã pin, nên endpoint được kiểm bằng chính `app.request()` và listener HTTP thật. Harness `app.request()` phải gửi Host tường minh vì WHATWG Request không tự sinh header này.

2026-08-01 — Phase K, Task K.1–K.10
  - Files: `packages/{core,adapter,server,cli}/src/**`, `src/app/{api,page,projects}/**`, `src/components/{home,studio}/**`, `src/lib/api/browser-session.ts`, `projects/*/vidcom.json`, `tests/server/{project-routes,next-routing}.test.ts`, `tests/core/project-usecases.test.ts`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Gắn Hono qua optional catch-all, xác minh exact-route precedence trên Next thật rồi cutover tuần tự runtime → asset → preview. Thêm project/files/settings/snapshot APIs, chuyển home và studio khỏi RSC filesystem sang browser API; Playwright mở studio thật với 0 console error. Toàn suite 24 file/143 test xanh, lint exit 0, build exit 0.
  - Decisions: Preview use case nhận URL runtime/base qua option để cùng một builder phục vụ v1 và alias. Compatibility PUT legacy tạm chấp nhận cả mtime-size và SHA-256 trong cửa sổ K→N; PUT v1 ở N vẫn từ chối legacy. Next host singleton bootstrap database/identity trước khi dispatch catch-all.
  - Blockers: Không có blocker cho K. Acceptance “không `.server.ts` trong `src/app/**`” cố ý còn mở tới N vì ba mixed-method file phải giữ write handler. Build xanh nhưng NFT còn cảnh báo trace rộng từ Next host filesystem adapter; không làm CI fail và sẽ được đánh giá lại khi N xoá compatibility imports.

2026-08-01 — Phase L, Task L.1–L.8
  - Files: `packages/core/src/{port,service}/**`, `packages/adapter/src/db/job-store.ts`, `packages/worker/src/noop-probe.ts`, `packages/server/src/{app,routes/jobs}.ts`, `packages/cli/src/{composition-root,startup,next-host}.ts`, `tests/{adapter/job-infrastructure,server/job-routes}.test.ts`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Hoàn tất SQLite job store, scheduler in-process, noop-probe, API đọc/huỷ và startup recovery. Toàn suite 26 file/150 test xanh; typecheck, import boundary, lint và production build đều exit 0.
  - Decisions: Scheduler query bỏ qua cặp project/type đang active để tránh head-of-line blocking nhưng vẫn khóa tuần tự cùng cặp. Progress chỉ persist tối đa 4 lần/giây và luôn đơn điệu; terminal update/cancel là no-op. Recovery requeue type idempotent, fail type không idempotent, và hoàn tất cancel đã được yêu cầu.
  - Blockers: Không có. Design drift đã đồng bộ ở §5.2/§5.9: Job nội bộ chứa trường scheduler không lộ qua HTTP; port thêm cancellation read, stale requeue và excluded active pair; thứ tự noop safe point được sửa thành kiểm huỷ thật sự ở đầu vòng. Build vẫn chỉ có NFT warning đã ghi ở K.

2026-08-01 — Phase M, Task M.1–M.6
  - Files: `packages/core/src/{service/{project-cache,job-scheduler},usecase/project-reads,service/write-authority}.ts`, `packages/adapter/src/{db/event-outbox,fs/watcher}.ts`, `packages/server/src/{app,routes/events}.ts`, `packages/cli/src/{composition-root,next-host}.ts`, `tests/{adapter/events-watcher-cache,server/events}.test.ts`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Hoàn tất outbox retention 24h/5000, SSE durable resume/resync/heartbeat, job events, watcher 150ms, external entity revision và shared CompositionModel LRU. Toàn suite 28 file/156 test xanh; typecheck, boundary, lint và build exit 0.
  - Decisions: SSE poll trực tiếp sequence SQLite và đặt no-buffer headers; Next catch-all được integration-test bằng chính host adapter. Watcher dùng own-write hash tracker, observed-hash dedupe và bỏ qua sibling temp của atomic write. Production composition root chia sẻ cache/tracker/outbox cho reads, writes, jobs và watcher.
  - Blockers: Không có. Design drift đã đồng bộ ở §4.3.3/§5.11: thêm observer hash sau journal commit, dedupe notification/temp file, và production-injected optional ProjectCache. Build vẫn có một NFT warning đã biết tới N.

2026-08-01 — Phase N, Task N.1–N.12
  - Files: `packages/{contracts,core,adapter,server,cli}/src/**`, `src/components/studio/**`, `src/app/projects/[slug]/page.tsx`, `src/app/api/hf/[slug]/{source,preview-settings,scene}/route.ts` (xoá), `src/lib/hyperframes/*.server.ts` (xoá), `tests/{adapter,contracts,server}/**`, `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`
  - Summary: Cutover toàn bộ source/settings/BGM/scene writes qua Hono + WriteAuthority; giữ đúng legacy alias tts/generate; xoá ba mixed route và toàn bộ compatibility `.server.ts`. Contract/integration suite khóa v1 + legacy, conflict current, legacy-version rejection, no-overwrite và ba crash state BGM. Playwright lưu source, regenerate TTS và AI Composer trên Next thật với response 200 và 0 console error.
  - Decisions: Rollback theo từng route: (1) source — bật v1 + client, smoke rồi mới xoá exact route; hoàn tác bằng khôi phục route/client cũ; (2) settings/BGM — bật v1, chạy crash suite rồi mới xoá route; hoàn tác bằng khôi phục route và hook cũ nhưng giữ migration additive; (3) scene — bật v1 timing/script + legacy aliases, browser smoke rồi mới xoá route; hoàn tác bằng khôi phục exact route và UI calls. Compatibility wrappers chỉ xoá sau `rg` không còn consumer.
  - Blockers: Không có. Design drift đã đồng bộ: snapshot trả entity revision riêng; journal thêm staged temp/target để composite recovery xác định bốn trạng thái. Playwright phát hiện lease hết sau 30 giây dù design yêu cầu renew 10 giây; startup nay renew định kỳ và `stop()` dọn interval/lease/watcher/database, các integration test dùng lifecycle này.

2026-08-01 — Phase O, Task O.1–O.6
  - Files: `packages/cli/src/composition-root.ts`, `tests/e2e/foundation-milestone.test.ts`, `src/components/studio/use-preview-settings.ts`, `spec-core-backend-foundation-{detailed-design,implementation-checklist,complete}.md`, `implementation-notes.html`
  - Summary: Xác nhận `src/` chỉ còn optional catch-all server entry, production packages không có Bun API, và native sidecar root được inject. E2E thật trên ba project khóa list → snapshot → hash-precondition save → noop job → durable event/SSE. Frozen install, typecheck, lint, boundary và toàn bộ 31 file/161 test đều xanh; production build xanh.
  - Decisions: Node SEA artifact cold/warm, extraction, signing và platform matrix vẫn là gate Phase 4, không bị tuyên bố hoàn tất trong Phase 1. Contract `nativeDependenciesRoot` chỉ mở seam cho loader Phase 4, không kéo native worker vào foundation. Spec hiện hành được hoàn tất trực tiếp rồi đổi `inprocess` → `complete`; không khôi phục bản `pending` đã được rename khi mở execution.
  - Blockers: Không có. Lint còn 10 warning pre-existing trong `.temp-documents`; build còn một NFT broad-trace warning từ Next host nhưng cả hai exit 0. Lint Phase O bắt một ref mutation trong render ở preview settings; đã chuyển đồng bộ revision sang effect và chạy lại toàn CI.

2026-08-01 — Hậu review, finding P1/P2
  - Files: `packages/adapter/src/fs/resolve.ts`, `packages/core/src/service/write-authority.ts`, `tests/{adapter/fs,core/write-authority}.test.ts`, `spec-core-backend-foundation-{detailed-design,implementation-checklist,inprocess}.md`, `implementation-notes.html`
  - Summary: Vá bypass allowlist qua symlink nội-project bằng cách authorize cả client path lẫn canonical target path. File/entity mutation nay abort journal ngay khi atomic write lỗi; conflict revision không còn null; missing entity state trả `internal`. Regression đỏ trước fix và xanh sau fix; toàn suite tăng lên 31 file/169 test.
  - Decisions: Không abort khi file đã ghi nhưng journal commit lỗi — giữ pending để startup reconciliation hoàn tất. Detailed Design §5.5/§5.6 đã khóa rõ boundary này và yêu cầu kiểm purpose hai lần. Cùng error invariant được áp dụng cho cả entity patch và composite BGM.
  - Blockers: Không có. Frozen install, typecheck, lint, import boundary, 169 test và production build đều exit 0; chỉ còn 10 warning tài liệu tạm và NFT trace warning đã biết.

2026-08-01 — Hậu review, đổi persistence Kysely → Drizzle (đang thực hiện)
  - Files: `spec-core-backend-foundation-detailed-design.md`, `spec-core-backend-foundation-implementation-checklist.md`, `implementation-notes.html`, `package.json`, `packages/adapter/package.json`, `bun.lock`
  - Summary: Mở lại Phase F và đổi Decision 17 sang Drizzle ORM trên driver chính thức `node:sqlite`; inventory cho thấy migration chạm 10 adapter/runtime file và các integration test đang truy vấn DB trực tiếp.
  - Decisions: Không giữ facade Kysely trong production. Drizzle schema là nguồn sự thật; Drizzle Kit sinh migration SQL reviewable; WAL, 11 bảng, journal transaction, outbox và recovery semantics không đổi.

2026-08-01 — Hoàn tất lại Phase F bằng Drizzle

  - Summary: Xoá dependency và toàn bộ production/test query Kysely; nối `drizzle-orm/node-sqlite` trực tiếp với `DatabaseSync`; Drizzle schema quản lý 11 bảng, CHECK/FK/index và một foundation migration sạch, reviewable.
  - Scope correction: Theo xác nhận của chủ dự án, bỏ hoàn toàn compatibility shim ORM cũ vì đây là greenfield. Runtime chỉ còn Drizzle ORM/Drizzle Kit; database dev cũ phải tạo lại từ migration Drizzle.
  - Evidence: `typecheck` xanh; 11 suite DB/job/recovery/SSE với 34 test xanh; fresh + reopen + WAL/integrity/FK/CHECK/partial-unique đều xanh; một foundation migration sạch và `drizzle-kit generate` báo không có schema drift.
  - Blockers: Chưa có blocker. `drizzle-orm/node-sqlite` hiện ở 1.0.0-rc.4 nên version được pin và full migration/runtime CI là gate bắt buộc trước khi đánh dấu lại Phase F.

Format:
```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [...]
  - Summary: [...]
  - Decisions: [lệch so với design → cập nhật detailed-design.md cùng lúc]
  - Blockers: [...]
```
