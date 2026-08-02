# Spec MCP Server — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-mcp-server-detailed-goal.md) — Approved, reconfirmed 2026-08-02
> - [Detailed Design](./spec-mcp-server-detailed-design.md) — v6, Pending Confirmation
> - [Main spec](./spec-mcp-server-inprocess.md)
> - [Canonical build order](../../../product-features/15-build-order.md) — Phase 2

## Context

> [!NOTE]
> Đây là nguồn sự thật trung tâm trong lúc thực thi. Mọi task phải được cập nhật tại đây.
> Công việc persistence chỉ hoàn tất khi có cả logic test và integration test trên SQLite thật + filesystem thật trong temp directory. Không mock `node:fs`.

Checklist chuyển Detailed Goals và Detailed Design v6 thành các task 1–4 giờ, giữ đúng ranh giới `MCP adapter → Application Core → port → adapter`. Trọng tâm rủi ro là migration composite, T1/T2 durability, recovery classifier, approval grant và terminal tool audit; các bề mặt MCP chỉ được nối sau khi các nền tảng đó xanh.

## Approval Gate

> Không viết production code cho tới khi mục này được người dùng xác nhận tường minh.

- **Status**: **Pending Confirmation**
- **Confirmed by**: —
- **Confirmation date**: —
- **Notes / required revisions before code execution**: Checklist được audit sâu ngày 2026-08-02. Detailed Design v6 và checklist này phải được duyệt cùng nhau; sau đó thực thi theo Dependency Order. Phase B là migration gate, Phase E–F là durability gate, Phase P là release gate.
- **Vá executability 2026-08-02** (6 điểm, sau khi đối chiếu checklist với repo thật):
  1. `get_project_context.scenes` từng có hai cách đọc — Design §7 nay khai `SceneContextSchema` dùng chung với `list_scenes`, và tách rõ khỏi `SceneSchema` đầy đủ của studio snapshot HTTP.
  2. Design §7 thêm bảng ký hiệu rút gọn: shape lồng nhau lấy từ schema có sẵn ở `contracts/src/dto.ts`, không khai lại.
  3. Execution Contract khoá **zod@4.4.3** làm schema library và thêm nó vào runtime dependency của `@vidcom/mcp` (A.2) — trước đó A.2 chỉ liệt kê MCP SDK.
  4. Execution Contract khoá **được phép sửa tay `migration.sql`** khi `drizzle-kit@1.0.0-rc.4` không sinh đúng table-rebuild; nêu rõ drift check B.9 so `schema.ts` ↔ `snapshot.json` nên hand-edit không làm nó đỏ.
  5. Thêm **M.11**: mở rộng `test:golden` sang `tests/mcp/golden`; script hiện tại chỉ quét `tests/golden` nên golden Phase M sẽ bị bỏ sót ở release gate P.7.
  6. Design thêm **§5.16 `McpRuntimeConfig`** — type này trước đó chỉ tồn tại trong Execution Contract, khiến rule X.2 (design drift) bị kích hoạt oan.

## Sequencing Strategy

**Chosen strategy**: **Hybrid — Foundation-First + Risk-First**.

**Rationale**: contracts/ports phải ổn định trước, nhưng migration và recovery là phần có blast radius lớn nhất lên 180 test Phase 1 nên được kiểm chứng sớm. Tool Registry, transport và CLI chỉ nối sau khi Core chứng minh được invariant “consistent hoặc quarantine”.

## Dependency Order

```text
A Contracts + dependency baseline
└─→ B SQLite migration — GATE
    └─→ C Core ports/models
        ├─→ D Journal transaction primitives
        │   └─→ E Composite WriteAuthority — GATE
        │       └─→ F Recovery + project write gate — GATE
        │           ├─→ G Read model + recovery visibility
        │           ├─→ H Approval grant service
        │           └─→ I Backup store + restore
        │               └─→ J Core write/destructive use cases
        └──────────────────────────────┘
G + H + J ─→ K Durable tool audit
G + H + J + K ─→ L Tool Registry + 10 tools
L ─→ M Dual-era transports + exact revision pin
B + H + M ─→ N HTTP credential + Hono mount
F + H + I + M + N ─→ O CLI/admin surfaces + stdio smoke
G…O ─→ P Contract matrix + milestone verification
```

**Recommended execution order**: A → B → C → D → E → F → G → H → I → J → K → L → M → N → O → P.

**Parallelizable**: G ∥ H ∥ I sau F; N có thể chuẩn bị credential persistence sau B nhưng chỉ mount sau M. Không song song D/E/F vì cùng chạm journal/recovery invariant.

**Hard gates**:
- B phải xanh, gồm fresh DB + legacy-data rebuild + unresolved backfill, trước D.
- E và F phải xanh trên failure injection trước bất kỳ destructive tool nào ở L.
- Không mount `/api/mcp*` trước N; không chạy AI-host smoke trước O.
- Không đánh dấu spec complete trước P, full local gates và remote CI.

## Capacity Breakdown

| Phase | Nội dung | SP |
|---|---|---:|
| A | Dependency, contracts, skeleton, baseline | 6 |
| B | 5 bảng mới, 2 table-rebuild, migration/backfill | 10 |
| C | Core ports, models, source hash, recovery status | 7 |
| D | Journal/grant/audit transaction primitives | 10 |
| E | Composite WriteAuthority + rollback verification | 10 |
| F | Recovery classifier, gate, admin resolution | 10 |
| G | Read surface + recovery visibility | 5 |
| H | Approval grant lifecycle | 7 |
| I | Backup store, retention, restore | 8 |
| J | Core write/destructive use cases | 11 |
| K | Durable tool audit policy | 7 |
| L | Tool Registry + 10 tools | 10 |
| M | Legacy/modern HTTP + stdio transport | 9 |
| N | MCP credential + Hono mount | 8 |
| O | CLI/admin commands + host smoke | 8 |
| P | Contract matrix, golden, CI closeout | 6 |
| | **Tổng** | **132 SP** |

132 SP là estimate planning sau khi scope đã mở rộng thêm composite recovery, grant, backup, credential và admin recovery. Nó thay thế ước lượng build-order 2–3 tuần ban đầu; lịch thực tế chỉ chốt sau khi có velocity của đội.

## LLM Agent — Skill Activation Per Phase

> [!IMPORTANT]
> Trước mỗi phase, đọc skill và source được liệt kê. Mỗi hàm/type export mới phải có doc comment theo steering 11 §4.

| Phase | Skills to activate | Steering | Source files to read BEFORE modifying |
|---|---|---|---|
| A | `.agents/skills/bun/SKILL.md`, `.agents/skills/mcp-builder/SKILL.md` | 01, 02, 06, 10, 11 | `package.json`, `bun.lock`, `packages/{contracts,mcp}/package.json`, `packages/contracts/src/**`, `packages/mcp/src/index.ts` |
| B | `.agents/skills/bun/SKILL.md` | 07 §9, 10 §6 | `packages/adapter/src/db/{schema,migrate,journal}.ts`, foundation migration, migration tests (FULL) |
| C | `.agents/skills/bun/SKILL.md` | 03, 06, 07 | `packages/core/src/{domain/models,port/ports,port/types,domain/preview-settings}.ts`, `packages/adapter/src/{fs/workspace-fs,hyperframes/parse}.ts` (FULL) |
| D | `.agents/skills/bun/SKILL.md` | 03 §2.3, 07 §4–6, 10 | `packages/adapter/src/db/journal.ts`, `packages/core/src/port/{ports,types}.ts`, journal/recovery tests (FULL) |
| E | `.agents/skills/bun/SKILL.md` | 03 §3.5, 07 §4–6 | `write-authority.ts` (FULL), `atomic-write.ts`, `workspace-fs.ts`, write-authority/concurrency tests |
| F | `.agents/skills/bun/SKILL.md` | 07 §4–6, 09, 10 | `reconcile-pending-mutations.ts`, `staged-recovery.ts`, startup flow and recovery tests (FULL) |
| G | `.agents/skills/bun/SKILL.md` | 03 §3, 05 §5, 06 | `project-reads.ts`, `models.ts`, `parse.ts`, `project-cache.ts` (FULL) |
| H | `.agents/skills/bun/SKILL.md` | 05 §3, 09 §9 | journal ports/adapter from D, `canonical-json.ts`, deterministic Clock/ID test helpers |
| I | `.agents/skills/bun/SKILL.md` | 07 §1–6, 09 §5 | `atomic-write.ts`, `workspace-fs.ts`, app-data path wiring, migration/schema from B |
| J | `.agents/skills/bun/SKILL.md` | 03, 05, 06, 07 | `project-writes.ts`, `sdk-ops.ts`, `parse.ts`, `preview-settings.ts`, Core use-case tests (FULL) |
| K | `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md` | 05 §9, 09 §10 | `journal.ts`, `schema.ts`, logger/metrics seams, D–F terminal flows |
| L | `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md` | 05 (FULL), 06, 13 §4 | contracts from A, Core use cases G–J, `packages/mcp/src/**` |
| M | `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md` | 01 §1/§6, 13 (FULL) | Q10 spikes, installed `server@2` exports/types, Tool Registry from L |
| N | `.agents/skills/hono/SKILL.md`, `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md` | 04 §10, 09 §1–4, 13 | `server/src/app.ts`, perimeter/session middleware, listener, credential store, server security tests (FULL) |
| O | `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md` | 01 §6, 07 §3, 09 | `cli/src/{main,composition-root,startup,workspace-selection}.ts`, Phase 1 CLI tests (FULL) |
| P | `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md` | 10, 13 §7 | all MCP tests/goldens, CI workflow, `package.json`, build order docs |

**Read once before Phase A**: [code style](../../../steering/11-code-style.md), [documentation rules](../../../steering/12-documentation-rules.md), [implementation guide](../../rules/implementation-guide.md).

## Nghĩa vụ thường trực trong suốt thực thi

- [ ] **X.0** Tạo và cập nhật `implementation-notes.html` trong thư mục spec: một trang tiếng Việt, Tailwind CDN; ghi design drift, tradeoff, surprise và blocker ngay khi phát sinh.
- [ ] **X.1** Cập nhật checklist trước/sau từng task; chỉ một task `[/]` cho mỗi author; ghi Execution Log mỗi session.
- [ ] **X.2** Nếu interface/data model/Decision Record lệch thực tế, dừng task và sửa Detailed Design trước khi tiếp tục.
- [ ] **X.3** Mọi shell command dùng `rtk`; không log secret; stdout của MCP stdio chỉ dành cho protocol.
- [ ] **X.4** Mỗi phase persistence có logic test và SQLite/filesystem thật; không mock `node:fs`.

## Execution Contract — khóa quyết định để không phải hỏi lại

Các giá trị và convention dưới đây là quyết định thực thi, không phải gợi ý. Agent MUST dùng chúng trừ khi source chứng minh bất khả thi; khi đó áp dụng Design Drift, không tự chọn phương án khác.

| Chủ đề | Quyết định đã khóa |
|---|---|
| Dependency | Runtime trong `@vidcom/mcp`: `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/core@2.0.0`, **`zod@4.4.3`**. Root devDependency: `@modelcontextprotocol/sdk@1.30.0`, `@modelcontextprotocol/client@2.0.0`. Tất cả exact, không caret/tilde. |
| Schema library | **zod**, exact `4.4.3` — cùng bản `packages/contracts` đang dùng. Khai schema trong `packages/contracts/src/mcp.ts`; `@vidcom/mcp` cần zod trực tiếp vì `registerTool` nhận zod schema. MUST NOT thêm thư viện schema thứ hai. |
| Migration authoring | `drizzle-kit@1.0.0-rc.4` sinh khung; **được phép sửa tay `migration.sql`** khi RC không sinh đúng table-rebuild giữ `id`/parent FK/autoincrement. Điều kiện: `snapshot.json` phải khớp `schema.ts`. Drift check ở B.9 so `schema.ts` ↔ `snapshot.json`, **không** so nội dung `migration.sql`, nên hand-edit không làm nó đỏ. Không cần hỏi lại về việc này. |
| Server identity | MCP server name `vidcom-mcp-server`; version import trực tiếp từ `packages/mcp/package.json` bằng JSON module (`resolveJsonModule` đã bật; `0.1.0` ở baseline), không hard-code bản thứ hai. |
| Tool names | Dùng đúng 10 tên đã duyệt: `list_projects`, `get_project_context`, `list_scenes`, `read_composition`, `create_scene`, `set_scene_timing`, `set_text`, `save_file`, `delete_scene`, `delete_file`. Đây là ngoại lệ có chủ đích với khuyến nghị service-prefix của skill; MUST NOT tự thêm `vidcom_`. |
| Tool response | Registry trả canonical object `O`; MCP adapter luôn phát cả `structuredContent: O` và một `content[type=text]` là canonical JSON của cùng `O`. Error dùng một mapper, không trả raw stack/message hạ tầng. |
| Pagination/format | Không thêm `limit`, cursor hay `response_format` ngoài schema §7 đã duyệt. Phase 2 project local có contract cố định; thay đổi schema là Design Drift. |
| Modern cache fields | Không tự hard-code `resultType`, `ttlMs`, `cacheScope` nếu `server@2.0.0` sở hữu stamping. Golden khóa output thực tế của exact SDK; SDK đổi thì R9.8 fail. |
| Runtime defaults | Khai một `McpRuntimeConfig`: approval request TTL **10 phút**; issued grant TTL **5 phút**; terminal grant retention **7 ngày**; backup payload retention **30 ngày**; orphan backup grace **24 giờ**; credential rotation overlap mặc định **5 phút**. Tests dùng injected Clock/config, không chờ thời gian thật. |
| Config surface | Các default nằm ở composition root, truyền bằng constructor/DI. Chỉ CLI rotation expose override `--overlap-ms <positive-int>`; không tạo env var hoặc config file mới trong Phase 2. |
| Migration rollback | Startup `migrateDatabase()` vẫn forward-only. Tạo `packages/adapter/src/db/mcp-migration-rollback.ts` với `inspectMcpRollbackSafety()` và `rollbackMcpMigration()`; không gọi tự động, không mount HTTP/MCP/CLI. Test chạy refusal + safe path trên copy SQLite thật. |
| Backup seam | Phase E chỉ implement orchestration qua `BackupPort` và deterministic fake; không có destructive production caller. Phase I mới implement `AppDataBackupStore` trên filesystem thật; Phase J mới bật destructive use case. |
| Approval surface | Phase 2 chỉ cần trusted CLI `vidcom approve`; UI approval là đường hợp lệ trong Goals nhưng không phải deliverable của checklist này. MCP chỉ `request`, không `issue`. |
| Admin CLI output | Success của `approve`, `credential`, `backup`, `recovery` là một JSON object trên stdout + newline; error một dòng đã redact trên stderr. Exit `0` success, `2` input/domain rejection, `1` infra/unexpected. Riêng `vidcom mcp` dành toàn bộ stdout cho MCP frames. |
| Audit forwarding | Registry sinh đúng một `PendingToolAudit`, đặt vào `ToolContext.writeInvocation`; mọi Core write use case truyền nguyên vẹn xuống authority. HTTP/UI/CLI/internal mặc định `toolAudit=null`. MUST NOT ghi tool audit hậu nghiệm sau handler success. |
| Existing callers | `WriteAuthority.mutate(request, actor, invocation?)` dùng optional third argument; caller hai tham số Phase 1 không sửa. Mọi thay đổi buộc sửa hàng loạt caller cũ là dấu hiệu implementation sai hoặc Design Drift. |

### Khi nào agent được dừng để hỏi

- **Không hỏi** về tên file, version, TTL, output shape, CLI format, test command, backup seam hoặc migration rollback mechanism — bảng trên đã khóa.
- **Tự sửa trong phạm vi task** khi chỉ là tên helper private hoặc chia nhỏ file nội bộ mà không đổi public contract; ghi Execution Log.
- **Dừng và cập nhật Design trước** chỉ khi source/SDK exact-version làm một interface/schema/transaction invariant đã duyệt không thể hiện thực, hoặc phải đổi security/workspace boundary. Đánh dấu task `[!]`, nêu evidence và section bị ảnh hưởng.
- Pre-existing test fail không được bỏ qua: chạy lại test đó trên baseline/checkout snapshot; nếu thật sự có trước, ghi exact command/output và không sửa ngoài scope.

## Canonical Artifact Map

Đây là đường dẫn mặc định phải tạo/sửa. Không tạo một kiến trúc song song. Nếu một file trở nên quá lớn, được tách helper cạnh owner nhưng phải giữ export owner và cập nhật `Files Changed Summary`.

| Phase | Production artifacts | Test artifacts |
|---|---|---|
| A | `packages/contracts/src/mcp.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/index.ts`, `packages/mcp/src/{index,revisions,error-map,http,stdio}.ts`, `packages/mcp/src/registry/{types,schemas}.ts`, package manifests/lock | `tests/contracts/mcp-contracts.test.ts`, boundary script/tests |
| B | `packages/adapter/src/db/{schema,migrate,mcp-migration-rollback}.ts`, `packages/adapter/drizzle/<timestamp>_mcp_server/{migration.sql,snapshot.json}`, `scripts/verify-schema-drift.mjs` | `tests/adapter/mcp-database-migration.test.ts` |
| C | `packages/core/src/port/{types,ports}.ts`, `packages/core/src/domain/{models,preview-settings}.ts`, `packages/adapter/src/{fs/workspace-fs,hyperframes/parse}.ts` | `tests/core/mcp-domain-contracts.test.ts`, `tests/adapter/mcp-port-adapters.test.ts` |
| D | `packages/adapter/src/db/journal.ts` và repository helper cùng `db/` nếu cần | `tests/adapter/mcp-journal-transactions.test.ts` |
| E | `packages/core/src/service/write-authority.ts` | `tests/core/composite-write-authority.test.ts`, `tests/adapter/composite-write-persistence.test.ts` |
| F | `packages/core/src/usecase/{reconcile-pending-mutations,resolve-orphaned-mutation}.ts`, startup/composition wiring | `tests/core/composite-recovery.test.ts`, `tests/adapter/composite-recovery-persistence.test.ts` |
| G | `packages/core/src/usecase/project-reads.ts`, read contracts/models, `packages/adapter/src/hyperframes/parse.ts` | `tests/core/mcp-project-reads.test.ts`, `tests/adapter/mcp-read-model.test.ts` |
| H | `packages/core/src/service/approval-service.ts`, `packages/adapter/src/db/approval-grant.ts` | `tests/core/approval-service.test.ts`, `tests/adapter/approval-grant-persistence.test.ts` |
| I | `packages/adapter/src/fs/app-data-backup-store.ts`, `packages/core/src/usecase/restore-backup.ts`, composition/startup wiring | `tests/adapter/backup-store.test.ts`, `tests/core/restore-backup.test.ts` |
| J | `packages/core/src/usecase/{project-writes,scene-deletion}.ts`, preview/narration/HyperFrames ops | `tests/core/mcp-project-writes.test.ts`, `tests/adapter/destructive-usecases.test.ts` |
| K | `packages/core/src/service/tool-audit-service.ts`, journal/audit repository + metrics/logger wiring | `tests/core/tool-audit-policy.test.ts`, `tests/adapter/tool-audit-persistence.test.ts` |
| L | `packages/mcp/src/registry/{registry,read-tools,write-tools,destructive-tools}.ts` | `tests/mcp/registry.test.ts`, `tests/mcp/tools.test.ts` |
| M | `packages/mcp/src/{http,stdio,revisions,error-map,index}.ts`, root `package.json` script `test:golden` | `tests/mcp/{legacy-transport,modern-transport,revision-pin}.test.ts`, `tests/mcp/golden/**` |
| N | `packages/core/src/service/mcp-credential-service.ts`, `packages/adapter/src/db/mcp-credential.ts`, `packages/server/src/middleware/mcp-bearer-auth.ts`, `packages/server/src/app.ts`, composition root | `tests/adapter/mcp-credential.test.ts`, `tests/server/mcp-security.test.ts`, `tests/server/mcp-listener.test.ts` |
| O | `packages/cli/src/commands/{mcp,approve,credential,backup,recovery}.ts`, `packages/cli/src/{main,composition-root,startup}.ts` | `tests/cli/mcp-commands.test.ts`, `tests/e2e/mcp-stdio-host.test.ts` |
| P | package scripts, `.github/workflows/ci.yml`, spec/product docs | `tests/mcp/contract-matrix.test.ts`, final goldens/fixtures |

## Phase Verification Matrix

Mỗi phase chạy focused command dưới đây trước khi chạy `rtk bun run typecheck`, `rtk bun run lint` và `rtk git diff --check`. Phase chạm boundary chạy thêm `rtk bun run test:boundaries`. Không mark phase `[x]` nếu command chưa có exit code 0 trong Execution Log.

| Phase | Focused verification command |
|---|---|
| A | `rtk bun install --frozen-lockfile` rồi `rtk bun run test -- tests/contracts/mcp-contracts.test.ts` và full baseline gates |
| B | `rtk bun run test -- tests/adapter/mcp-database-migration.test.ts` |
| C | `rtk bun run test -- tests/core/mcp-domain-contracts.test.ts tests/adapter/mcp-port-adapters.test.ts` |
| D | `rtk bun run test -- tests/adapter/mcp-journal-transactions.test.ts` |
| E | `rtk bun run test -- tests/core/composite-write-authority.test.ts tests/adapter/composite-write-persistence.test.ts tests/core/write-authority.test.ts` |
| F | `rtk bun run test -- tests/core/composite-recovery.test.ts tests/adapter/composite-recovery-persistence.test.ts tests/core/reconcile-pending-mutations.test.ts` |
| G | `rtk bun run test -- tests/core/mcp-project-reads.test.ts tests/adapter/mcp-read-model.test.ts` |
| H | `rtk bun run test -- tests/core/approval-service.test.ts tests/adapter/approval-grant-persistence.test.ts` |
| I | `rtk bun run test -- tests/adapter/backup-store.test.ts tests/core/restore-backup.test.ts` |
| J | `rtk bun run test -- tests/core/mcp-project-writes.test.ts tests/adapter/destructive-usecases.test.ts tests/core/project-usecases.test.ts` |
| K | `rtk bun run test -- tests/core/tool-audit-policy.test.ts tests/adapter/tool-audit-persistence.test.ts` |
| L | `rtk bun run test -- tests/mcp/registry.test.ts tests/mcp/tools.test.ts` |
| M | `rtk bun run test -- tests/mcp/legacy-transport.test.ts tests/mcp/modern-transport.test.ts tests/mcp/revision-pin.test.ts` rồi `rtk bun run test:golden` (phải bao gồm `tests/mcp/golden` sau M.11) |
| N | `rtk bun run test -- tests/adapter/mcp-credential.test.ts tests/server/mcp-security.test.ts tests/server/mcp-listener.test.ts tests/server/security.test.ts` |
| O | `rtk bun run test -- tests/cli/mcp-commands.test.ts tests/e2e/mcp-stdio-host.test.ts tests/cli/startup.test.ts` |
| P | `rtk bun install --frozen-lockfile`; `rtk bun run typecheck`; `rtk bun run lint`; `rtk bun run test:boundaries`; `rtk bun run test`; `rtk bun run test:golden`; `rtk bun run build`; `rtk bun run test:runtime-smoke`; `rtk bun run test:schema-drift`; `rtk git diff --check` |

## Task Status Legend

`[ ]` chưa bắt đầu · `[/]` đang làm · `[x]` hoàn tất sau test/verify/log · `[!]` bị chặn và có lý do

---

## Phase A: Dependency, contracts và MCP skeleton

**Addresses**: R1, R3, R4, R5, R6, R6c, R9
**Design reference**: §5.1–5.2, §6.2–6.3, §7, §8, DR-1, DR-6, DR-9
**Files affected**: `package.json`, `bun.lock`, `packages/{contracts,mcp}/package.json`, `packages/contracts/src/**`, `packages/mcp/src/**`, boundary scripts/tests
**Prerequisite**: Detailed Goals + Design approved; checklist Approval Gate approved
**Skill**: `.agents/skills/bun/SKILL.md`; `.agents/skills/mcp-builder/SKILL.md` chỉ để đối chiếu schema/annotation, chưa dựng transport
**Read first**: activation table Phase A

**Tasks**:
- [ ] A.1 Ghi baseline checkout và chạy frozen install, typecheck, lint, boundary, test, build; lưu số test/commit vào Execution Log. _Requirements: R9_ — _Design: §11_
- [ ] A.2 Pin runtime `@modelcontextprotocol/server@2.0.0` + `core@2.0.0` + `zod@4.4.3` trong `@vidcom/mcp`; chuyển root `sdk@1.30.0` và `client@2.0.0` thành exact devDependency, xoá runtime client hiện tại khỏi root dependencies và xoá sibling dependency `@vidcom/adapter` khỏi `@vidcom/mcp`. _Requirements: R1.2, R3, R4, R9.1_ — _Design: §4.8, DR-1/8_
- [ ] A.3 Khai `SUPPORTED_REVISIONS`, `Era`, `ToolLevel`, `WriteEnvelope`, `WriteInvocation`, `ProjectRecoveryStatus` trong SDK-neutral contracts/Core owner; không import SDK. _Requirements: R1.3, R6c.8, R7.4, R9.8_ — _Design: §5.1, §5.6, §6.2–6.3, DR-6/9/20_
- [ ] A.4 Bổ sung `ErrorCode` mới và strict input/output schema zod cho 10 tool trong `packages/contracts/src/mcp.ts`; khai `SceneContextSchema` mới, tái dùng `ProjectSummarySchema`/`RootTrackSchema`/`PreviewSettingsSchema`/`DiagnosticSchema` sẵn có ở `dto.ts` thay vì khai lại; output schema luôn là structured canonical shape. _Requirements: R1.1, R5, R6, R6b, R6d_ — _Design: §7 (bảng ký hiệu rút gọn), §8.1_
- [ ] A.5 Dựng package skeleton `mcp/registry/tools`, `http.ts`, `stdio.ts`, `revisions.ts`, `error-map.ts`; chưa register tool hay transport. _Requirements: R1.1–4_ — _Design: §4.2, §5.13_
- [ ] A.6 Mở rộng import-boundary test để cấm SDK type trong Core/Registry, cấm `mcp↔server` import hai chiều và cấm `packages/mcp` import sibling infrastructure `@vidcom/adapter`. _Requirements: R1.2–4, R6c.9_ — _Design: §5.1–5.2, DR-8_
- [ ] A.7 Thêm contract unit test cho strict schema, ErrorCode, revision constant và dependency placement; nâng SDK lệch tập revision phải đỏ. _Requirements: R1.3, R9.7–8_ — _Design: §11.1–11.2, DR-6_

**Acceptance Criteria**:
- [ ] Frozen install không đổi lockfile ngoài dependency đã khai báo; `sdk@1.x` không nằm trong production path.
- [ ] Contracts compile độc lập, không import MCP SDK; boundary negative fixtures đỏ đúng lỗi.
- [ ] Baseline Phase 1 vẫn xanh trước khi sang migration.

**Deliverables**: contracts MCP, package skeleton, dependency/boundary tests, baseline log.

---

## Phase B: SQLite schema và migration — GATE

**Addresses**: R5b, R6, R6b, R6d, R7, R9
**Design reference**: §6.0–6.5, DR-2, DR-12, DR-18
**Files affected**: `packages/adapter/src/db/{schema,migrate,journal}.ts`, `packages/adapter/drizzle/<mcp-migration>/**`, adapter exports, migration/database tests
**Prerequisite**: A
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase B; foundation migration và mọi test đang inspect schema

**Tasks**:
- [ ] B.1 Thêm Drizzle schema cho `mutation_step`, `revision_step`, `approval_grant`, `mcp_credential`, `backup_manifest` với cột/check/FK/index đúng §6.4. _Requirements: R5b, R6, R6b, R6d_ — _Design: §6.4_
- [ ] B.2 Mở rộng `revision.kind` với `composite`; rebuild table mà giữ id, parent FK, row cũ và autoincrement sequence. _Requirements: R5b.2_ — _Design: §6.1, §6.4 `revision`, DR-2_
- [ ] B.3 Rebuild `mutation_journal`: thêm `composite`, `rolled_back`, `grant_id`, `backup_id`, `tool_audit_json`, indexes và JSON check. _Requirements: R5b.3–4e, R7.4c_ — _Design: §6.1, §6.4 `mutation_journal`, DR-18/19_
- [ ] B.4 Backfill đúng một `mutation_step` cho mọi legacy journal unresolved `pending`/`orphaned`; terminal row không cần backfill. _Requirements: R5b.4–4e_ — _Design: §6.1, §6.5_
- [ ] B.5 Tạo `db/mcp-migration-rollback.ts`: `inspectMcpRollbackSafety()` đếm từng blocker và `rollbackMcpMigration()` chỉ chạy sau report safe; rebuild/drop đúng thứ tự FK, không nối vào startup forward migrator. _Requirements: R5b, R9.5_ — _Design: §6.1 rollback, §6.5_
- [ ] B.6 Siết file SQLite `0600`/Windows ACL lúc tạo hoặc mở, không làm hỏng database hiện có. _Requirements: R6d.3, R7.7_ — _Design: §5.14, DR-10_
- [ ] B.7 Real SQLite migration test: fresh DB, reopen idempotent, Phase-1 fixture preservation và pending/orphaned backfill có đúng ordered step. _Requirements: R5b, R9.5_ — _Design: §6.5, §11.2_
- [ ] B.8 Real SQLite constraint test: mọi FK/check/unique/partial-index, `foreign_key_check`, JSON validity và file mode hiện hữu/mới. _Requirements: R5b, R6, R6d, R9.5_ — _Design: §6.4, §11.2_
- [ ] B.9 Test rollback safety cả refusal và safe path; thêm `scripts/verify-schema-drift.mjs` + root script `test:schema-drift` để snapshot migration tree trước/sau `drizzle-kit generate` và fail nếu command tạo/sửa artifact. _Requirements: R9.5_ — _Design: §6.5, §11.2_

**Acceptance Criteria**:
- [ ] Fresh DB và DB Phase 1 có dữ liệu đều migrate thành công, `foreign_key_check` sạch.
- [ ] Recovery source `mutation_step` không rỗng cho legacy unresolved row.
- [ ] Không mất row/id/hash/audit/revision Phase 1; rollback không phá lịch sử.

**Deliverables**: migration MCP reviewable + rollback safety, schema mới, migration integration tests.

---

## Phase C: Core ports và domain models

**Addresses**: R2, R5, R5b, R6b, R7
**Design reference**: §5.5–5.12, §6.2–6.3, DR-3, DR-9, DR-11
**Files affected**: `packages/core/src/{domain,port}/**`, `packages/contracts/src/**`, `packages/adapter/src/{fs,hyperframes}/**`, Core/adapter unit tests
**Prerequisite**: B
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase C

**Tasks**:
- [ ] C.1 Khai `CompositeStep`, `CompositeRequest`, `StepIntent/Result`, `PendingMutationContext`, `GrantBinding/Transition`, `PendingToolAudit` bằng type SDK-neutral. _Requirements: R1.3, R5b.1–4e, R6_ — _Design: §5.6, §5.8, §5.12_
- [ ] C.2 Mở rộng `MutationJournalPort` với composite begin/attach/commit/abort/orphan, step reads, audit ownership và recovery-status reads; không để `Tx` lọt vào Core. _Requirements: R5b, R6, R7_ — _Design: §5.8 port contract, DR-3_
- [ ] C.3 Thêm `BackupPort`, credential/grant persistence port, metric/log seam và doc comment nêu I/O/null/side effect. _Requirements: R6, R6b.9, R6d, R7_ — _Design: §5.11–5.14_
- [ ] C.4 Thêm `WorkspacePort.exists/deleteAtomic`; adapter thực hiện containment + atomic semantics cùng allowlist hiện có. _Requirements: R5b.3–4e, R6b.2/4/7_ — _Design: §5.10 P1_
- [ ] C.5 Mở rộng `CompositionModel.sources` với hash/byteSize; parse adapter hash ngay trong lượt đọc, không thêm I/O. _Requirements: R2.2–5_ — _Design: §5.5_
- [ ] C.6 Thêm `scenesRemove` vào preview patch và `staleSince` vào narration normalization; record cũ thiếu field phải ra `null`. _Requirements: R5.7, R5b.6–7, R6b.8_ — _Design: §5.10 P2/P3, DR-11_
- [ ] C.7 Unit/adapter test cho shape/normalization, delete containment, sources deterministic và no-SDK-type boundary. _Requirements: R1.3, R2, R5b, R6b_ — _Design: §11.1–11.2_

**Acceptance Criteria**:
- [ ] Core vẫn chỉ biết port/data; mọi export mới có doc comment.
- [ ] Legacy narration không bị đánh dấu stale giả; source hash khớp bytes thật.
- [ ] Filesystem delete không vượt canonical project boundary.

**Deliverables**: composite/recovery/grant/backup contracts, port extensions, source/narration models.

---

## Phase D: Journal transaction primitives

**Addresses**: R5b, R6, R7
**Design reference**: §5.6–5.8, §5.12, §6.1/6.4, DR-2/3/12/18/19
**Files affected**: `packages/adapter/src/db/journal.ts`, supporting repositories, adapter exports, journal tests
**Prerequisite**: C
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase D

**Tasks**:
- [ ] D.1 Implement `beginComposite` T1: journal + ordered step rows + canonical redacted audit context + optional grant reserve CAS trong một transaction. _Requirements: R5b.1, R6.3–5, R7.4c_ — _Design: §5.6 step 4, §6.1 T1_
- [ ] D.2 Implement `attachBackup` để persist `backup_id` và enrich pending audit trước filesystem step đầu. _Requirements: R6b.9, R7.8_ — _Design: §5.6 step 5, §5.12, DR-18_
- [ ] D.3 Implement T2b `commitComposite`: phân loại one-step/composite, revision/steps/entity/audits/event/backup/grant/journal atomic. _Requirements: R5b.2, R7.3–4_ — _Design: §5.6 step 8, §6.1 T2b, DR-12_
- [ ] D.4 Implement T2a `abortComposite`: terminal abort, clear context/link, release reserved grant; trả context in-memory cho failure audit. _Requirements: R5b.3, R7.4b_ — _Design: §6.1 T2a, §5.12_
- [ ] D.5 Implement T2c `orphanComposite`: error audit + grant invalidation + orphan terminal atomically; transaction fail giữ pending. _Requirements: R5b.3–4e, R7.4c_ — _Design: §6.1 T2c, DR-16/19_
- [ ] D.6 Implement step/context/status reads, `isJournalOwned(invocationId)`, `readProjectRecoveryStatus`, latest project revision và exact journal↔grant lookup. _Requirements: R2.11, R5b, R6, R7_ — _Design: §5.7, §5.12, §6.3_
- [ ] D.7 Giữ `begin/commit/abort/recover/orphan` Phase 1 qua facade một-step; dual-write `revision_step` + `revision_blob`, giữ action/kind cũ. _Requirements: R5b.5, R9.6_ — _Design: §5.6 one-step table, DR-12_
- [ ] D.8 Real SQLite tests cho T1 và T2a/b/c row set, exact grant/context links, terminal idempotency và one-step row semantics. _Requirements: R5b, R6, R7, R9.5_ — _Design: §11.2_
- [ ] D.9 Failure/concurrency tests cho reserve CAS race, unique grant link và transaction rollback khi audit/grant/event/FK write lỗi. _Requirements: R5b, R6, R7, R9.5–6_ — _Design: §11.2_

**Acceptance Criteria**:
- [ ] Không có committed composite thiếu revision step, tool audit, event hoặc grant terminal transition.
- [ ] Retry terminal transaction không tạo audit/revision trùng.
- [ ] Toàn bộ Phase 1 journal tests vẫn xanh.

**Deliverables**: composite journal adapter và transaction-level integration suite.

---

## Phase E: Composite WriteAuthority — GATE

**Addresses**: R5, R5b, R6, R7
**Design reference**: §5.6, §6.2, DR-3/4/12/16/19
**Files affected**: `packages/core/src/service/write-authority.ts`, related ports/types, core + real datastore tests
**Prerequisite**: D
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase E

**Tasks**:
- [ ] E.1 Implement `mutateComposite` dưới lease + project mutex + `assertProjectWritable`, trước T1 và trước mọi filesystem write. _Requirements: R5b.1/4, R2.11_ — _Design: §5.6 step 1_
- [ ] E.2 Resolve/canonicalize mọi target, kể cả entity backing path; reject duplicate canonical target và path purpose mismatch. _Requirements: R5.9, R5b.1_ — _Design: §5.6 step 2, §8.1_
- [ ] E.3 Validate toàn bộ file/entity/project revision precondition và optional grant plan trước T1; conflict không chạm đĩa. _Requirements: R5.1–3, R6.3/9_ — _Design: §5.6 step 3, DR-4_
- [ ] E.4 Persist T1, gọi `BackupPort` và attach verified manifest khi `backup=true`, rồi apply ordered write/delete/entity step atomically từng target; phase này dùng deterministic fake, real `AppDataBackupStore` thuộc I. _Requirements: R5b.1–2, R6b.9–10_ — _Design: §5.6 step 4–6_
- [ ] E.5 Khi step lỗi, rollback landed steps theo ordinal giảm dần và verify từng `fromHash`/absence; success → T2a, failure → T2c. _Requirements: R5b.3/4e_ — _Design: §5.6 step 7, DR-16_
- [ ] E.6 Khi all-landed, chạy T2b; T2 failure thử đúng một inline reconcile và nếu chưa terminal thì trả `recovery_required`, không rollback đĩa. _Requirements: R5b.4/4b, R7.4c_ — _Design: §5.6 step 8–9, DR-19_
- [ ] E.7 Reimplement `mutate(request, actor, invocation?)` bằng composite một-step; caller hai tham số giữ nguyên result/action/kind, MCP caller có thể truyền durable audit context. _Requirements: R5b.5, R7.4_ — _Design: §5.6 one-step semantics, DR-12/20_
- [ ] E.8 Unit test pure planning/validation: no-op, duplicate canonical target, purpose mismatch, all-precondition validation và optional `WriteInvocation` forwarding. _Requirements: R5, R5b.1, R7.4_ — _Design: §5.6, §11.2, DR-20_
- [ ] E.9 Real SQLite/filesystem test: multi-file, file+entity, ordered apply, one revision/steps và precondition race không chạm đĩa. _Requirements: R5, R5b.1–2, R9.5_ — _Design: §11.2_
- [ ] E.10 Failure-injection test: step failure rollback/verify, rollback failure→orphan, T2a/b/c failure→one inline reconcile→pending gate. _Requirements: R5b.3–4e, R7.4c, R9.6_ — _Design: §5.6–5.7, §11.2_
- [ ] E.11 Chạy toàn bộ Phase-1 write-authority/concurrency suite và chứng minh two-argument `mutate()` byte-compatible. _Requirements: R5b.5_ — _Design: DR-12, §11.2_

**Acceptance Criteria**:
- [ ] Một composite thành công sinh đúng một `projectRevision` và `revision_step[]` đầy đủ.
- [ ] Không nhánh nào công bố aborted/rolled_back nếu hash verify chưa chứng minh.
- [ ] T2 failure giữ durable context và từ chối write kế tiếp bằng `recovery_required`.

**Deliverables**: composite write authority, one-step facade, failure-injection suite.

---

## Phase F: Recovery, quarantine và admin resolution — GATE

**Addresses**: R2.11, R5b.3–4e, R7.4b–4c, R9.6
**Design reference**: §4.6, §5.7, §6.3, DR-5/16/18/19
**Files affected**: `reconcile-pending-mutations.ts`, new recovery service/use cases, startup wiring, journal adapter, recovery tests
**Prerequisite**: E
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase F

**Tasks**:
- [ ] F.1 Tách pure step classifier cho write/delete/entity dựa hash thật; tuyệt đối không tin `step.status`. _Requirements: R5b.4–4d_ — _Design: §5.7 classifier_
- [ ] F.2 Implement mutation decision: unknown→orphan; all-landed→roll forward; none-landed→abort; mixed→reverse rollback + verify. _Requirements: R5b.4b–4e_ — _Design: §5.7 flow, DR-5_
- [ ] F.3 Dùng persisted `grant_id` + `tool_audit_json` cho T2 retry/terminal audit; đảm bảo retry không audit hoặc consume/release grant trùng. _Requirements: R6.4, R7.1–4c_ — _Design: §5.7, DR-18/19_
- [ ] F.4 Thay startup reconciler cũ bằng per-journal reconciliation có report pending/recovered/rolledBack/orphaned và project isolation. _Requirements: R5b.4, R8.5_ — _Design: §5.7_
- [ ] F.5 Implement `resolveOrphanedMutation` cho `restore-previous` và `accept-current` dưới lease/mutex, bypass gate chỉ đúng journal và audit actor `cli-external`. _Requirements: R5b.4d–4e_ — _Design: §5.7 admin resolution_
- [ ] F.6 Gate mọi write khi project còn ít nhất một pending/orphaned; resolve một journal không mở gate nếu còn journal khác. _Requirements: R2.11, R5b.4d–4e_ — _Design: §6.3_
- [ ] F.7 Unit test classifier/decision thuần: tampered `step.status`, write/delete/entity all/none/mixed/unknown và reverse rollback order. _Requirements: R5b.4b–4e_ — _Design: §5.7, §11.2_
- [ ] F.8 Real persistence test: T2a/b/c injection, exact grant/audit recovery, repeated startup, rollback failure→orphan và all-landed roll-forward không sửa đĩa. _Requirements: R5b, R7, R9.6_ — _Design: §5.7, §11.2_
- [ ] F.9 Admin-resolution test: restore/accept validation, crash giữa resolution, bypass đúng journal và two-unresolved gate không mở sớm. _Requirements: R2.11, R5b.4d–4e_ — _Design: §5.7, §6.3, §11.2_

**Acceptance Criteria**:
- [ ] Mọi observed state về đúng một terminal outcome hoặc giữ gate; không có “best guess”.
- [ ] Recovery all-landed giữ filesystem và commit đúng grant/audit của journal.
- [ ] Admin resolution crash-safe; gate chỉ gỡ sau verify + terminal transaction.

**Deliverables**: deterministic reconciler, project gate, Core resolution use case, recovery suite.

---

## Phase G: Read model và recovery visibility

**Addresses**: R2
**Design reference**: §5.3/5.5, §6.3, §7.1–7.4
**Files affected**: `project-reads.ts`, `models.ts`, HyperFrames parse adapter, contracts, cache/read tests
**Prerequisite**: F
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase G

**Tasks**:
- [ ] G.1 Expose `sources` từ parse cho entry + mọi referenced sub-composition với canonical relative path/hash/byteSize. _Requirements: R2.2–5_ — _Design: §5.5_
- [ ] G.2 Mở rộng studio snapshot/context với `fileHashes`, `projectRevision`, `entityRevision`, diagnostics và `ProjectRecoveryStatus`. _Requirements: R2.2–3/11_ — _Design: §6.2–6.3, §7.2_
- [ ] G.3 Mở rộng list project/scene và read composition outputs; không lộ absolute path, enforce allowlist/size trước content. _Requirements: R2.1/4–10_ — _Design: §7.1/7.3/7.4_
- [ ] G.4 Đảm bảo cache invalidation và read lúc gate vẫn hoạt động nhưng luôn báo unresolved journals. _Requirements: R2.11_ — _Design: §5.7, §6.3_
- [ ] G.5 Unit/integration test: hashes khớp đĩa, đủ precondition cho write kế tiếp, outside/forbidden/too-large, pending/orphan visibility và no absolute path. _Requirements: R2_ — _Design: §11.2_

**Acceptance Criteria**:
- [ ] `get_project_context` ở trạng thái ready đủ dữ kiện gọi mọi write tool.
- [ ] Read lúc recovery gate không bị chặn và không trình bày project healthy.
- [ ] Không có lượt đọc filesystem dư chỉ để tính hash.

**Deliverables**: enriched read model/contracts và regression tests.

---

## Phase H: Approval grant lifecycle

**Addresses**: R6
**Design reference**: §4.4–4.5, §5.8, §6.4 `approval_grant`, DR-3/4/16
**Files affected**: new Core approval service/port, adapter grant repository, CLI/UI admin injection seam, grant tests
**Prerequisite**: F
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase H

**Tasks**:
- [ ] H.1 Implement `request(binding, summary)` với canonical binding, request TTL mặc định 10 phút và deterministic ID/Clock/config ports. _Requirements: R6.2–3_ — _Design: §5.8_
- [ ] H.2 Implement admin-only `issue(requestId, ui|cli)` CAS requested→issued, reject expired request, set issued grant TTL mặc định 5 phút. _Requirements: R6.2/5_ — _Design: §5.8_
- [ ] H.3 Implement `planReserve` domain validation và map approval-expired/invalid/conflict; T1 vẫn là authority cuối. _Requirements: R6.3/5/9_ — _Design: §5.8, DR-3/4_
- [ ] H.4 Implement revoke và lifecycle cleanup terminal rows; không prune grant gắn unresolved journal. _Requirements: R6.4–5_ — _Design: §4.5, §6.1 retention_
- [ ] H.5 Giới hạn Registry dependency bằng `Pick<ApprovalService,"request">`; issue/revoke chỉ composition root admin path có. _Requirements: R6.2/8_ — _Design: §5.2, §5.8_
- [ ] H.6 Unit tests cho canonical binding và 7-state transition table, request/grant expiry boundaries, error mapping và reserved no-timeout. _Requirements: R6.3–5/9, R9.4_ — _Design: §5.8, §11.2_
- [ ] H.7 Real SQLite concurrency/cleanup tests: replay, two-reserve CAS, revoke-vs-reserve, binding/hash/revision mismatch, reuse after release và retention không đụng unresolved grant. _Requirements: R6.3–5/9, R9.4–5_ — _Design: §6.1, §11.2_

**Acceptance Criteria**:
- [ ] Agent/MCP code không thể issue grant bằng type/runtime path.
- [ ] Hai destructive requests cạnh tranh cùng grant: đúng một request thắng.
- [ ] Grant orphaned/rollback-failed không quay về issued.

**Deliverables**: ApprovalService, SQLite lifecycle adapter, concurrency suite.

---

## Phase I: Backup store, retention và restore

**Addresses**: R6b.9–10, R7.8
**Design reference**: §5.11, §6.4 `backup_manifest`, DR-15
**Files affected**: new Core backup use cases/port, adapter backup store, composition root, backup tests
**Prerequisite**: F
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase I

**Tasks**:
- [ ] I.1 Implement app-data backup layout và canonical manifest/hash; không ghi absolute path vào public output/audit. _Requirements: R6b.9, R7.6–8_ — _Design: §5.11_
- [ ] I.2 Implement atomic `create`: temp dir, payload copy, fsync, verify mọi hash, rename publish; failure không để published manifest. _Requirements: R6b.9_ — _Design: §5.11, DR-15_
- [ ] I.3 Implement read/readPayloads/verify/list với manifest integrity và project scoping. _Requirements: R6b.9_ — _Design: §5.11_
- [ ] I.4 Implement `prunePayloads` mặc định 30 ngày, giữ metadata/FK và set `payload_pruned_at`; cleanup orphan payload chỉ sau grace mặc định 24 giờ. _Requirements: R6b.9_ — _Design: §5.11, §6.1 retention_
- [ ] I.5 Implement Core `restoreBackup`: verify payload, precondition bằng destructive revision `to_hash`, composite revision mới, actor `cli-external`. _Requirements: R6b.9–10_ — _Design: §5.11, DR-15_
- [ ] I.6 Wire backup store/prune vào composition root/startup; startup failure không mở listener sai trạng thái. _Requirements: R6b.9, R8.5_ — _Design: §5.11_
- [ ] I.7 Real filesystem store tests: temp/fsync/verify/rename failure, tamper detection, manifest scoping, prune/expired và 24-hour orphan grace boundary. _Requirements: R6b.9, R9.5_ — _Design: §5.11, §11.2_
- [ ] I.8 Real SQLite/filesystem restore tests: attach revision/audit IDs, exact `to_hash` precondition, later-edit conflict, new restore revision và metadata FK survives prune. _Requirements: R6b.9–10, R7.8, R9.5_ — _Design: §5.11, §11.2_

**Acceptance Criteria**:
- [ ] Destructive mutation không chạm target trước khi backup publish + verify.
- [ ] Restore không overwrite thay đổi mới hơn.
- [ ] Retention không phá audit/history FK.

**Deliverables**: BackupStore adapter, restore use case, startup cleanup và tests.

---

## Phase J: Core write và destructive use cases

**Addresses**: R5, R5b.5–7, R6b
**Design reference**: §5.4, §5.9a–5.10, §7.5–7.10, DR-11/13/15/20
**Files affected**: `project-writes.ts`, new deletion planner/use cases, preview/narration models, HyperFrames ops, Core integration tests
**Prerequisite**: E + F + G + I; H cho destructive execution
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase J

**Tasks**:
- [ ] J.1 Viết lại `createScene` thành một composite (scene file + entry + narration sidecar), nhận entry hash + optional `WriteInvocation`, trả scene/project/WriteEnvelope. _Requirements: R5.1–5, R5b.5, R7.4_ — _Design: §5.4, §5.6, §7.5, DR-20_
- [ ] J.2 Giữ `setSceneTiming` file-hash precondition, nhận optional `WriteInvocation`, domain timing errors và trả entity/project/envelope đầy đủ. _Requirements: R5.1–6, R7.4_ — _Design: §5.4, §7.6, DR-20_
- [ ] J.3 Mở rộng `setSceneScript`: source + narration `staleSince` trong cùng composite, truyền optional `WriteInvocation`; không tự chạy TTS. _Requirements: R5.7, R5b.6–7, R7.4_ — _Design: §5.10 P3, §7.7, DR-11/20_
- [ ] J.4 Siết `saveSourceFile` size/protected allowlist và output hash/envelope; nhận optional `WriteInvocation`, conflict kèm current state. _Requirements: R5.1–4/8–9, R7.4_ — _Design: §7.8, §8.2, DR-20_
- [ ] J.5 Implement pure `planSceneDeletion` + `digestPlan` cho shared src, inline, latest, last scene=0, narration và preview cleanup. _Requirements: R6b.1–8/11–12_ — _Design: §5.9a, DR-13_
- [ ] J.6 Implement `prepareSceneDeletion` I/O: collect model/settings/narration/hashes/revision, validate scene, build binding. _Requirements: R6.3/9, R6b_ — _Design: §5.9a, DR-4/13_
- [ ] J.7 Implement `deleteScene` composite với verified backup, grant transition, all cleanup, one revision và complete output. _Requirements: R6, R6b.1–12_ — _Design: §5.9a–5.11, §7.10_
- [ ] J.8 Implement `prepareFileDeletion`: allowlist/protected/hash/reference scan, latest project revision, canonical plan/digest/binding; không ghi. _Requirements: R6.3/9, R6b.9–10_ — _Design: §5.9b, §7.9, DR-4/13_
- [ ] J.9 Implement `deleteFile` chỉ nhận approved plan + grant, revalidate qua T1, backup và one-delete/one-revision result; truyền optional `WriteInvocation`. _Requirements: R6, R6b.9–10, R7.4_ — _Design: §5.9b, §7.9, DR-15/20_
- [ ] J.10 Unit test use-case/planner: create plan, stale narration, timing/save errors, 6 scene-deletion cases, file reference safety và last-scene warning. _Requirements: R5, R5b.5–7, R6b.1–8/11–12_ — _Design: §11.1_
- [ ] J.11 Real SQLite/filesystem test: create atomicity, single-step/composite audit forwarding, delete cleanup, one revision, verified backup và restore conflict. _Requirements: R5, R5b.5–7, R6b, R7.4, R9.5_ — _Design: §11.2, DR-20_
- [ ] J.12 Failure-injection test tại từng crash boundary của create/delete, chứng minh terminal outcome hoặc recovery gate và không audit kép. _Requirements: R5b.3–4e, R6b.10, R7.4b–4c, R9.6_ — _Design: §5.6–5.7, §11.2_

**Acceptance Criteria**:
- [ ] `create_scene`-ready use case sinh đúng một revision; crash không để project usable ở trạng thái nửa vời.
- [ ] `deleteScene` phủ đủ mount/file/root/narration/settings/backup trong một mutation.
- [ ] Tất cả error paths không chạm đĩa hoặc giữ recovery gate.

**Deliverables**: production Core write/destructive use cases và comprehensive tests.

---

## Phase K: Durable tool audit policy

**Addresses**: R7
**Design reference**: §5.12, §6.1/6.4, DR-7/18/19
**Files affected**: new Core audit service, adapter audit repository/journal integration, logger/metric wiring, audit tests
**Prerequisite**: D + F + J
**Skill**: `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase K

**Tasks**:
- [ ] K.1 Implement canonical redaction và `PendingToolAudit` schema-versioned serialization; cấm secret/raw file/absolute path. _Requirements: R7.2/6–7_ — _Design: §5.12_
- [ ] K.2 Implement `prepareWrite`, `recordRead`, `recordFailure` và retry đúng một lần + logger/metric escalation. _Requirements: R7.1/4b/5_ — _Design: §5.12, DR-7_
- [ ] K.3 Gắn terminal success/orphan audit vào T2/recovery với đúng `protocol_version`, credential id, project revision, grant/backup IDs. _Requirements: R7.2–4c/8_ — _Design: §5.12, §6.4 audit_
- [ ] K.4 Implement ownership decision theo invocation ID; lookup lỗi chỉ metric/log, không ghi audit phỏng đoán. _Requirements: R7.1/4b–4c_ — _Design: §5.12_
- [ ] K.5 Đảm bảo T2a clear context chuyển ownership về caller; T2b/T2c/recovery giữ journal-owned semantics và chống audit kép. _Requirements: R7.1/4b–4c_ — _Design: §5.12, DR-18/19_
- [ ] K.6 Unit test policy/redaction/ownership: read fail-open, pre-T1/rolled-back best-effort, retry-once, ownership unknown và canonical payload. _Requirements: R7.1–2/4b/5–7_ — _Design: §5.12, §11.2_
- [ ] K.7 Real SQLite failure injection: terminal fail-closed, all-landed indeterminate, orphan terminal, T2a ownership handoff và one-step tool audit cùng revision. _Requirements: R7.1–4c/8, R9.5–6_ — _Design: §5.12, §11.2, DR-20_
- [ ] K.8 Verify audit query indexes và row relation tool→revision→mutation; retention/prune không làm mất giải thích lịch sử. _Requirements: R7.2–3/8_ — _Design: §6.4_

**Acceptance Criteria**:
- [ ] Committed mutation không thể thiếu tool audit.
- [ ] Failure đã chứng minh không đổi đĩa không bị biến thành user error vì audit store.
- [ ] Mỗi invocation có tối đa một terminal tool audit row.

**Deliverables**: ToolAuditService, durable audit wiring, policy/failure tests.

---

## Phase L: Tool Registry và 10 tools

**Addresses**: R1, R2, R5, R6, R7
**Design reference**: §5.1–5.4, §7.1–7.10, §8.2
**Files affected**: `packages/mcp/src/registry/**`, contracts, MCP unit/contract tests
**Prerequisite**: G + H + J + K
**Skill**: `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase L và mcp-builder best practices/TypeScript guide

**Tasks**:
- [ ] L.1 Implement `ToolDefinition` gồm `projectIdOf`, level-derived annotations, `ToolContext` gồm invocation/write context, output validation và deterministic Registry registration/list. _Requirements: R1.1/5–6, R7.2/4_ — _Design: §5.1–5.2, DR-20_
- [ ] L.2 Implement Registry invoke pipeline: strict input → `projectIdOf` → level/grant policy → prepare one pending audit → Core handler với `writeInvocation` → output schema → ownership/audit policy; không gọi HTTP. _Requirements: R1.2–4, R7_ — _Design: §5.2, §5.12, DR-20_
- [ ] L.3 Register `list_projects` với concise description, read annotations và structured output. _Requirements: R2.1/10–11_ — _Design: §7.1_
- [ ] L.4 Register `get_project_context` và `list_scenes`, đủ hash/revision/diagnostics/recovery cho next action. _Requirements: R2.2–4/10–11_ — _Design: §7.2–7.3_
- [ ] L.5 Register `read_composition` với allowlist/size/path errors và content hash. _Requirements: R2.5–10_ — _Design: §7.4_
- [ ] L.6 Register `create_scene` và `set_scene_timing`; thiếu/stale precondition không ghi, output entity + envelope. _Requirements: R5.1–6_ — _Design: §7.5–7.6_
- [ ] L.7 Register `set_text` và `save_file`; expose narration stale/protected/size behavior trong description và output. _Requirements: R5.1–4/7–9_ — _Design: §7.7–7.8_
- [ ] L.8 Register `delete_scene`: thiếu grant tạo approval request; modern trả MRTR input-required, legacy actionable `approval_required`; retry re-plan. _Requirements: R6.1–9, R6b_ — _Design: §4.4, §7.10_
- [ ] L.9 Register `delete_file` với reference safety, grant, backup và complete output. _Requirements: R6, R6b.9–10_ — _Design: §7.9_
- [ ] L.10 Descriptor/schema tests khóa exact name/title/description/input/output/annotations/level, legacy visibility và deterministic order. _Requirements: R1.1/5–6, R9.3_ — _Design: §11.1, §11.3_
- [ ] L.11 Invoke tests chạy đủ 10 handler, invalid input, output mismatch, `projectIdOf`, `WriteInvocation` forwarding và CI guard mọi Registry tool có case. _Requirements: R1.2–4, R7.1–4c, R9.7_ — _Design: §5.2, §11.1, DR-20_

**Acceptance Criteria**:
- [ ] Tool được định nghĩa đúng một lần; schema/handler không lặp ở transport.
- [ ] Mỗi tool có title, actionable description, strict input/output và đủ annotation; annotation không thay authorization.
- [ ] Output đủ để agent quyết định bước kế tiếp mà không read thừa.

**Deliverables**: Tool Registry, 10 tool definitions, registry test coverage gate.

---

## Phase M: Dual-era transport và exact revision pin

**Addresses**: R3, R4, R6, R6c, R9.1–4/8
**Design reference**: §5.13, §7.11, DR-1/6/14
**Files affected**: `packages/mcp/src/{http,stdio,revisions,error-map,index}.ts`, transport tests/goldens
**Prerequisite**: L
**Skill**: `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase M; Q10 spike; installed `server@2` source/types

**Tasks**:
- [ ] M.1 Implement server factory `vidcom-mcp-server` lấy version từ package, một register function dùng Registry cho cả hai era/transport; không tự viết initialize/discover/result stamping. _Requirements: R1.2, R3, R4.5_ — _Design: §5.13, DR-1_
- [ ] M.2 Làm legacy stdio path trước: initialize revisions, no modern fields, resource error `-32002`, clean close. _Requirements: R4.1/3–5, R8_ — _Design: §5.13_
- [ ] M.3 Làm legacy stateless HTTP: no-version default `2025-03-26`, GET/DELETE 405, same Registry. _Requirements: R4.2/5–6, R6c.1/5–6_ — _Design: §5.13, §7.11_
- [ ] M.4 Bật modern stdio/HTTP: `server/discover`, resultType, private cache hint, header mismatch, MRTR codec. _Requirements: R3.1–5, R6.6_ — _Design: §5.13_
- [ ] M.5 Implement pinned HTTP wrapper bằng SDK classifier + exact allowlist, delegate invalid JSON, handle batch/header/body and same-era mismatch. _Requirements: R6c.2–4/8_ — _Design: §5.13, DR-14_
- [ ] M.6 Implement pinned stdio factory `--protocol`; không pin thì SDK classify/negotiate. _Requirements: R6c.7_ — _Design: §5.13, DR-14_
- [ ] M.7 Implement era-aware domain/protocol error mapper, including resource code split và unsupported `-32022` với toàn bộ revision. _Requirements: R3.6, R4.4, R5, R6_ — _Design: §8.1–8.2_
- [ ] M.8 Legacy transport tests bằng `sdk@1.30.0`: stdio + stateless HTTP, no-header default, no modern fields, resource code và stdout sạch. _Requirements: R4, R8.1–2, R9.1–4_ — _Design: §11.2–11.3_
- [ ] M.9 Modern transport tests bằng `client@2.0.0`: stdio + HTTP, discover/result/cache fields, MRTR `requestState` và header mismatch. _Requirements: R3, R6.6, R9.1–4_ — _Design: §11.2–11.3_
- [ ] M.10 Exact-pin tests: entry/pinned/latest/stdio, same-era mismatch, unknown revision, invalid JSON delegation, batch và cùng canonical result qua mọi path. _Requirements: R6c, R9.2/4/8_ — _Design: §5.13, §11.2–11.3, DR-14_
- [ ] M.11 Mở rộng root script `test:golden` thành `vitest run tests/golden tests/mcp/golden` để golden MCP nằm trong release gate; hiện script chỉ quét `tests/golden` nên golden Phase M sẽ bị bỏ sót ở P.7. _Requirements: R9.3_ — _Design: §11.3_

**Acceptance Criteria**:
- [ ] Một factory + một Registry phục vụ bốn tổ hợp era×transport.
- [ ] Pin so exact revision, không chỉ era; SDK vẫn sở hữu validation ladder.
- [ ] stdout stdio không có log trong transport tests.

**Deliverables**: dual-era HTTP/stdio adapter và transport contract suite.

---

## Phase N: MCP credential và Hono mount

**Addresses**: R6c, R6d, R7.2/6, R9.2/5
**Design reference**: §5.13–5.14, §7.11, DR-8/10/17
**Files affected**: Core credential service/adapter, `packages/server/src/app.ts` + middleware/routes, composition root, server security tests
**Prerequisite**: B + H + M
**Skill**: `.agents/skills/hono/SKILL.md`, `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase N

**Tasks**:
- [ ] N.1 Implement credential issue: 32 CSPRNG bytes, `vcmcp_` base64url, canonical SHA-256 unique digest; secret trả đúng một lần. _Requirements: R6d.2–3_ — _Design: §5.14, DR-17_
- [ ] N.2 Implement verify constant-shape, active/rotating window, lazy revoke, timing-safe compare và đồng nhất `credential_invalid`. _Requirements: R6d.1/4–5_ — _Design: §5.14_
- [ ] N.3 Implement rotate tạo id mới + overlap mặc định 5 phút (override explicit), revoke immediate, list metadata không secret. _Requirements: R6d.4–5_ — _Design: §5.14_
- [ ] N.4 Add `mcpBearerAuth` request context với credentialId; không chấp nhận session cookie cho MCP và không đòi bearer ở stdio. _Requirements: R6d.1/6–7_ — _Design: §5.1, §5.14_
- [ ] N.5 Tách Hono auth branch sau hostCheck/strictCors và trước body/handler; giữ loopback, Host và cross-origin perimeter Phase 1. _Requirements: R6c.5, R6d.1_ — _Design: §5.14, §7.11_
- [ ] N.6 Mount structural `McpRouteDependencies` cho `/api/mcp`, revisions và latest; server/mcp không import nhau. _Requirements: R6c.1–6/9_ — _Design: §5.13, DR-8_
- [ ] N.7 Unit + real SQLite credential tests cho entropy/hash/status/rotation/revoke/lazy expiry/overlap boundary và list không secret. _Requirements: R6d.2–5, R9.5_ — _Design: §5.14, §11.2_
- [ ] N.8 Hono `app.request()` tests cho auth rejection uniformity, credentialId context/audit, session-cookie rejection, middleware trace order và GET/DELETE 405. _Requirements: R6c.5, R6d.1/6–7_ — _Design: §5.14, §7.11, §11.2_
- [ ] N.9 Real listener tests cho entry/pinned/latest, Host/CORS/body, simultaneous legacy+modern clients và clean handler close. _Requirements: R3, R4, R6c, R9.2_ — _Design: §11.1–11.2_

**Acceptance Criteria**:
- [ ] Không request MCP HTTP nào qua được nếu thiếu bearer hợp lệ, kể cả loopback.
- [ ] Token không nằm trong SQLite/log/URL/workspace; audit chỉ có credential id.
- [ ] Existing Hono browser session routes vẫn giữ nguyên hành vi.

**Deliverables**: credential lifecycle, bearer middleware, MCP Hono mount, security suite.

---

## Phase O: CLI/admin surfaces và AI-host smoke

**Addresses**: R6, R6b.9, R6c.7, R6d.2/4–5/7, R8
**Design reference**: §5.7, §5.11, §5.15
**Files affected**: `packages/cli/src/**`, composition/startup wiring, CLI tests, smoke fixtures/scripts
**Prerequisite**: F + H + I + M + N
**Skill**: `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase O

**Tasks**:
- [ ] O.1 Refactor CLI dispatch thành subcommands mà giữ `vidcom app` hiện tại; parse args strict và errors chỉ stderr. _Requirements: R8.1–4_ — _Design: §5.15_
- [ ] O.2 Implement `vidcom mcp [--workspace] [--protocol]`: workspace resolution chuẩn, lease/startup deps, stdio start và no credential HTTP. _Requirements: R6c.7, R6d.7, R8.1–4_ — _Design: §5.13, §5.15_
- [ ] O.3 Implement SIGINT/SIGTERM clean close: transport, watcher, lease, DB; không log stdout. _Requirements: R8.2/5_ — _Design: §5.15_
- [ ] O.4 Implement trusted admin `vidcom approve <requestId>`; không expose issue qua MCP. _Requirements: R6.2/7–8_ — _Design: §5.8, §5.15_
- [ ] O.5 Implement `credential issue|list|rotate|revoke [--overlap-ms]` với secret one-time, JSON stdout, redacted error và exit-code contract. _Requirements: R6d.2–6_ — _Design: §5.14–5.15_
- [ ] O.6 Implement `backup list|verify|restore`; restore gọi Core, không ghi filesystem trực tiếp. _Requirements: R6b.9, R7.8_ — _Design: §5.11, §5.15_
- [ ] O.7 Implement `recovery inspect|reconcile|resolve`; inspect read-only, reconcile deterministic, resolve bắt buộc choice exact. _Requirements: R5b.4d–4e_ — _Design: §5.7, §5.15_
- [ ] O.8 CLI tests cho strict dispatch/args, JSON admin output, exit codes, missing workspace, protocol pin error, signal cleanup và lease release. _Requirements: R6, R8.1–5_ — _Design: §5.15, §11.1–11.3_
- [ ] O.9 AI-host smoke: client thật spawn stdio legacy rồi modern, list/call tool, approval round-trip, clean shutdown và stdout chỉ protocol frames. _Requirements: R3, R4, R6, R8, R9.1–2_ — _Design: §11.1–11.3_

**Acceptance Criteria**:
- [ ] AI host thật spawn `vidcom mcp` và bắt tay cả hai era.
- [ ] Missing workspace không đoán/tạo folder; pin lạ báo revision hỗ trợ.
- [ ] Admin commands audit actor đúng và không bypass Core/write authority.

**Deliverables**: CLI command tree, admin operations và stdio host smoke.

---

## Phase P: Contract matrix, golden và milestone verification

**Addresses**: R9 và Definition of Done 1–12
**Design reference**: §11, §12
**Files affected**: `tests/mcp/**`, fixtures/goldens, CI workflow, package scripts, product/spec docs
**Prerequisite**: G–O complete
**Skill**: `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase P

**Tasks**:
- [ ] P.1 Dựng parameterized matrix 2 era × 2 transport dùng exact client `sdk@1.30.0`/`client@2.0.0`; chạy mọi tool phù hợp. _Requirements: R9.1–2/7_ — _Design: §11.1–11.2_
- [ ] P.2 Commit golden `tools/list` legacy + modern và result shape; kiểm deterministic order nhiều lượt, modern cache private và legacy không có modern fields. _Requirements: R3.3–4, R4.3, R9.3_ — _Design: §11.1/11.3_
- [ ] P.3 Contract negative matrix: missing/stale precondition, missing/replay/expired grant, unknown revision, no-header default, resource-code split, hidden legacy tool. _Requirements: R1.6, R3–6, R9.4_ — _Design: §11.3_
- [ ] P.4 Real datastore recovery matrix: composite all/none/mixed/unknown, T2a/b/c failures, exact grant/audit recovery, repeated reconcile và project gate. _Requirements: R5b, R6, R7, R9.5–6_ — _Design: §11.2_
- [ ] P.5 Real datastore destructive matrix: approval lifecycle, backup publish/attach/prune/restore, delete outcomes, crash boundaries và audit relation. _Requirements: R6, R6b, R7, R9.4–6_ — _Design: §11.2_
- [ ] P.6 Add CI guard “mọi registry tool có contract case”, revision constants match SDK, one-step audit forwarding, stdout cleanliness và schema drift. _Requirements: R7.4, R9.7–8, R8.1–2_ — _Design: §11, DR-6/20_
- [ ] P.7 Chạy đúng toàn bộ command trong Phase Verification Matrix, gồm `test:schema-drift` và `git diff --check`; ghi command, exit code, test count, commit SHA vào Execution Log/notes. _Requirements: Definition of Done 10–12_ — _Design: §11_
- [ ] P.8 Chạy AI-host demo end-to-end và cập nhật main spec/build-order/product docs bằng behavior thật; push và xác minh remote CI trước closeout. _Requirements: Definition of Done 1–12_ — _Design: §12_

**Acceptance Criteria**:
- [ ] Mọi combination era×transport và mọi registry tool có automated contract evidence.
- [ ] Full local gates + remote CI xanh trên đúng commit; không skipped test.
- [ ] Detailed Design/checklist/implementation notes khớp code đã ship trước khi đổi spec thành complete.

**Deliverables**: contract/golden/durability matrix, CI gates, verified demo và closeout evidence.

---

## Files Changed Summary

| Area | Phase(s) | Expected changes |
|---|---|---|
| `package.json`, `bun.lock`, CI/scripts | A, B, M, P | exact MCP dependencies, `test:schema-drift`, `test:golden` mở rộng, verification commands/gates |
| `packages/contracts/src/**` | A, C | MCP/recovery/write contracts, schemas, ErrorCode, revisions |
| `packages/adapter/src/db/**`, `packages/adapter/drizzle/**` | B, D, H, K, N | schema/migration, journal, grant, audit, credential persistence |
| `packages/adapter/src/fs/**` | C, I | delete capability, backup store, SQLite/secret permissions |
| `packages/adapter/src/hyperframes/**` | C, G, J | source hashes, deletion planning inputs, ops |
| `packages/core/src/domain/**`, `port/**` | C | composite/grant/backup/recovery contracts and models |
| `packages/core/src/service/**` | E, H, K | WriteAuthority, ApprovalService, ToolAuditService |
| `packages/core/src/usecase/**` | F, G, I, J | recovery/reads/restore/create/set/delete use cases |
| `packages/mcp/src/**` | A, L, M | Registry, 10 tools, error map, HTTP/stdio transports |
| `packages/server/src/**` | N | bearer auth branch and structural MCP mount |
| `packages/cli/src/**` | I, N, O | composition wiring, mcp/admin/recovery commands |
| `tests/**` | A–P | unit, real SQLite/fs, contract, golden, smoke |
| `llm-documents/**` | P + design drift | execution log, notes, behavior/build-order closeout |

**Estimated scope**: 16 phases, 140 numbered implementation tasks, 132 SP. Line/file count chưa ước lượng vì migration SQL và failure-injection fixtures phụ thuộc generated output; không dùng line count làm completion gate.

## Requirements Coverage Matrix

| Detailed Goal | Implementation tasks | Primary verification |
|---|---|---|
| R1 — protocol-agnostic Registry | A.3–A.7, L.1–L.2/L.10–L.11, M.1 | A.6–A.7 boundary/contracts; L.10–L.11 registry; P.1/P.6 |
| R2 — read tools | C.5, G.1–G.5, L.3–L.5 | G.5 integration; P.1–P.3 contract/golden |
| R3 — modern era | A.2–A.3, M.1/M.4/M.7/M.9–M.10 | M.9–M.10 + P.1–P.3 |
| R4 — legacy era | A.2–A.3, M.1–M.3/M.7–M.8/M.10 | M.8/M.10 + P.1–P.3 |
| R5 — write preconditions/tools | A.4, E.2–E.3/E.8–E.11, J.1–J.4/J.10–J.12, L.6–L.7 | E.8–E.11/J.10–J.12; P.3–P.4 |
| R5b — composite Core/recovery | B.1–B.5, C.1–C.2, D.1–D.8, E.1–E.11, F.1–F.9 | migration + focused failure-injection + P.4 |
| R6 — approval grant | B.1/B.3, H.1–H.7, J.6–J.9, L.8–L.9, O.4 | H.6–H.7/J.10–J.12/P.3–P.5 |
| R6b — deleteScene/backup | C.4/C.6, I.1–I.8, J.5–J.12, O.6 | I.7–I.8/J.10–J.12/P.5 |
| R6c — revision-addressed endpoint | A.3, M.5–M.10, N.5–N.9, O.2 | M.8–M.10/N.8–N.9/P.1–P.3 |
| R6d — HTTP credential | B.1/B.6, N.1–N.9, O.5 | N.7–N.9/P.1 |
| R7 — audit | A.3, B.1/B.3, D.1–D.6, E.7–E.10, J.1–J.4/J.9/J.11–J.12, K.1–K.8, L.1–L.2/L.11, P.4–P.6 | K.6–K.8, one-step forwarding, P.4–P.6 |
| R8 — `vidcom mcp` | M.2/M.6/M.8, O.1–O.3/O.8–O.9 | O.8–O.9/P.6–P.8 |
| R9 — contract/CI | A.1/A.7, B.7–B.9, D.8–D.9, E.8–E.11, F.7–F.9, P.1–P.8 | Phase P complete |

> Mọi detailed requirement có ít nhất một implementation task và automated verification. Acceptance gate không được duyệt nếu script audit phát hiện task thiếu `_Requirements` hoặc `_Design`.

## Deferred Items Reference

| # | Item | Why deferred | Target |
|---|---|---|---|
| D1 | Tasks extension | Chưa có job thật để map | Phase 3 |
| D2 | `validate_project`, render/snapshot/TTS tools | Ngoài Phase 2 | Phase 3 |
| D3 | Agent-kit và MCP prompts | Tool set phải ổn định trước | Phase 4 |
| D4 | `add_block`, `upload_asset`, `reorder_scenes`, `duplicate_scene` | Core use case chưa có | Phase 3/5 |
| D5 | OpenTelemetry, audit retention scheduler | Không chặn Phase 2 | Sau |
| D6 | Xác minh protocol revision Codex | Binary chưa có để kiểm | Khi có binary |
| D7 | Gỡ `revision_blob` và journal denormalization | Giữ compatibility Phase 1 | Spec sau |
| D8 | AI Composer trong app | MCP server không tự làm UI mock chạy thật | Phase 6 |
| D9 | Bộ MCP effectiveness evaluations 10 câu read-only | Tool/agent-kit chưa ổn định; làm sớm sẽ đánh giá contract tạm | Phase 4 cùng agent-kit |

## Planning Quality Checklist

**Completeness**:
- [x] Mọi component/interface/data model của Design v6 có task, gồm DR-20 audit forwarding.
- [x] Mọi requirement R1–R9 có task và test trong coverage matrix.
- [x] Mọi phase có test task; phase persistence có SQLite/filesystem thật.
- [x] Integration nối Core → Registry → transport → server/CLI → host thật.

**Clarity**:
- [x] Mỗi task nêu artifact/behavior cụ thể và Requirements/Design reference.
- [x] Phase có files, prerequisites, skills và read-first.
- [x] Failure/rollback/recovery outcome được tách, không gom thành “error handling”.

**Sequencing**:
- [x] Migration/recovery risk được kiểm chứng trước MCP surface.
- [x] Legacy transport được làm trước modern theo host evidence.
- [x] Destructive tool chỉ xuất hiện sau grant + backup + recovery gates.

**Feasibility**:
- [x] Task lớn đã tách logic / real datastore / failure injection / regression; mỗi task mục tiêu 1–4 giờ.
- [x] Không task nào yêu cầu deploy hoặc feedback thủ công để được đánh dấu code-complete.
- [x] Q12 Codex và evaluations được defer, không chặn scope.

**Project-specific**:
- [x] Mỗi phase có Skill/Read-first annotations.
- [x] Workspace isolation, path containment, SQLite transaction và real filesystem được phủ.
- [x] Approval Gate giữ `Pending Confirmation`; production code vẫn bị chặn.

## Execution Log

> Append một entry mỗi work session. Design drift vật chất phải cập nhật Detailed Design trước khi tiếp tục.

_Chưa bắt đầu code execution._

Format:
```text
YYYY-MM-DD — Phase X, Task X.n
  - Files: [...]
  - Summary: [...]
  - Verification: [...]
  - Decisions: [design drift và section đã cập nhật]
  - Blockers: [...]
```
