# Spec MCP Server — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-mcp-server-detailed-goal.md) — Approved, reconfirmed 2026-08-02
> - [Detailed Design](./spec-mcp-server-detailed-design.md) — v6, Approved 2026-08-02
> - [Main spec](./spec-mcp-server-complete.md)
> - [Canonical build order](../../../product-features/15-build-order.md) — Phase 2

## Context

> [!NOTE]
> Đây là nguồn sự thật trung tâm trong lúc thực thi. Mọi task phải được cập nhật tại đây.
> Công việc persistence chỉ hoàn tất khi có cả logic test và integration test trên SQLite thật + filesystem thật trong temp directory. Không mock `node:fs`.

Checklist chuyển Detailed Goals và Detailed Design v6 thành các task 1–4 giờ, giữ đúng ranh giới `MCP adapter → Application Core → port → adapter`. Trọng tâm rủi ro là migration composite, T1/T2 durability, recovery classifier, approval grant và terminal tool audit; các bề mặt MCP chỉ được nối sau khi các nền tảng đó xanh.

## Approval Gate

> Không viết production code cho tới khi mục này được người dùng xác nhận tường minh.

- **Status**: **Approved — Code Execution authorized**
- **Confirmed by**: Người dùng qua lệnh `/goal` thực thi toàn bộ checklist A→P
- **Confirmation date**: 2026-08-02
- **Notes / required revisions before code execution**: Checklist được audit sâu ngày 2026-08-02. Detailed Design v6 và checklist này đã được duyệt cùng nhau qua `/goal`; Code Execution sau đó thực thi theo Dependency Order. Phase B là migration gate, Phase E–F là durability gate, Phase P là release gate.
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
- Không mount `/api/mcp*` trước N; không chạy exact SDK-host smoke trước O.
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

- [x] **X.0** Tạo và cập nhật `implementation-notes.html` trong thư mục spec: một trang tiếng Việt, Tailwind CDN; ghi design drift, tradeoff, surprise và blocker ngay khi phát sinh.
- [x] **X.1** Cập nhật checklist trước/sau từng task; chỉ một task `[/]` cho mỗi author; ghi Execution Log mỗi session.
- [x] **X.2** Nếu interface/data model/Decision Record lệch thực tế, dừng task và sửa Detailed Design trước khi tiếp tục.
- [x] **X.3** Mọi shell command dùng `rtk`; không log secret; stdout của MCP stdio chỉ dành cho protocol.
- [x] **X.4** Mỗi phase persistence có logic test và SQLite/filesystem thật; không mock `node:fs`.

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

Mỗi phase chạy `rtk bun run test:spec-paths` rồi focused command dưới đây trước khi chạy `rtk bun run typecheck`, `rtk bun run lint` và `rtk git diff --check`. Phase chạm boundary chạy thêm `rtk bun run test:boundaries`. Không mark phase `[x]` nếu command chưa có exit code 0 trong Execution Log.

| Phase | Focused verification command |
|---|---|
| A | `rtk bun install --frozen-lockfile` rồi `rtk bun run test -- tests/contracts/mcp-contracts.test.ts` và full baseline gates |
| B | `rtk bun run test -- tests/adapter/mcp-database-migration.test.ts` |
| C | `rtk bun run test -- tests/core/workspace-and-path-policy.test.ts tests/adapter/composition-hf.test.ts tests/contracts/api-contracts.test.ts` |
| D | `rtk bun run test -- tests/adapter/composite-journal.test.ts tests/adapter/lease-journal.test.ts` |
| E | `rtk bun run test -- tests/core/write-authority.test.ts tests/adapter/composite-write-authority.test.ts tests/e2e/foundation-milestone.test.ts` |
| F | `rtk bun run test -- tests/core/composite-recovery.test.ts tests/adapter/composite-recovery-persistence.test.ts tests/core/reconcile-pending-mutations.test.ts` |
| G | `rtk bun run test -- tests/core/project-usecases.test.ts tests/golden/parse.test.ts tests/adapter/composition-hf.test.ts` |
| H | `rtk bun run test -- tests/core/approval-service.test.ts tests/adapter/approval-grants.test.ts` |
| I | `rtk bun run test -- tests/adapter/backup-store.test.ts tests/core/restore-backup.test.ts` |
| J | `rtk bun run test -- tests/core/project-usecases.test.ts tests/core/scene-deletion.test.ts tests/core/file-deletion.test.ts tests/adapter/project-destructive-usecases.test.ts` |
| K | `rtk bun run test -- tests/core/tool-audit-policy.test.ts tests/adapter/tool-audit-persistence.test.ts` |
| L | `rtk bun run test -- tests/mcp/registry.test.ts tests/mcp/tools.test.ts` |
| M | `rtk bun run test -- tests/mcp/legacy-transport.test.ts tests/mcp/modern-transport.test.ts tests/mcp/revision-pin.test.ts` rồi `rtk bun run test:golden` (phải bao gồm `tests/mcp/golden` sau M.11) |
| N | `rtk bun run test -- tests/adapter/mcp-credential.test.ts tests/server/mcp-security.test.ts tests/server/mcp-listener.test.ts tests/server/security.test.ts` |
| O | `rtk bun run test -- tests/cli/mcp-commands.test.ts tests/e2e/mcp-stdio-host.test.ts tests/cli/startup.test.ts` |
| P | `rtk bun install --frozen-lockfile`; `rtk bun run test:spec-paths`; `rtk bun run typecheck`; `rtk bun run lint`; `rtk bun run test:boundaries`; `rtk bun run test`; `rtk bun run test:golden`; `rtk bun run build`; `rtk bun run test:runtime-smoke`; `rtk bun run test:schema-drift`; `rtk git diff --check` |

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
- [x] A.1 Ghi baseline checkout và chạy frozen install, typecheck, lint, boundary, test, build; lưu số test/commit vào Execution Log. _Requirements: R9_ — _Design: §11_
- [x] A.2 Pin runtime `@modelcontextprotocol/server@2.0.0` + `core@2.0.0` + `zod@4.4.3` trong `@vidcom/mcp`; chuyển root `sdk@1.30.0` và `client@2.0.0` thành exact devDependency, xoá runtime client hiện tại khỏi root dependencies và xoá sibling dependency `@vidcom/adapter` khỏi `@vidcom/mcp`. _Requirements: R1.2, R3, R4, R9.1_ — _Design: §4.8, DR-1/8_
- [x] A.3 Khai `SUPPORTED_REVISIONS`, `Era`, `ToolLevel`, `WriteEnvelope`, `WriteInvocation`, `ProjectRecoveryStatus` trong SDK-neutral contracts/Core owner; không import SDK. _Requirements: R1.3, R6c.8, R7.4, R9.8_ — _Design: §5.1, §5.6, §6.2–6.3, DR-6/9/20_
- [x] A.4 Bổ sung `ErrorCode` mới và strict input/output schema zod cho 10 tool trong `packages/contracts/src/mcp.ts`; khai `SceneContextSchema` mới, tái dùng `ProjectSummarySchema`/`RootTrackSchema`/`PreviewSettingsSchema`/`DiagnosticSchema` sẵn có ở `dto.ts` thay vì khai lại; output schema luôn là structured canonical shape. _Requirements: R1.1, R5, R6, R6b, R6d_ — _Design: §7 (bảng ký hiệu rút gọn), §8.1_
- [x] A.5 Dựng package skeleton `mcp/registry/tools`, `http.ts`, `stdio.ts`, `revisions.ts`, `error-map.ts`; chưa register tool hay transport. _Requirements: R1.1–4_ — _Design: §4.2, §5.13_
- [x] A.6 Mở rộng import-boundary test để cấm SDK type trong Core/Registry, cấm `mcp↔server` import hai chiều và cấm `packages/mcp` import sibling infrastructure `@vidcom/adapter`. _Requirements: R1.2–4, R6c.9_ — _Design: §5.1–5.2, DR-8_
- [x] A.7 Thêm contract unit test cho strict schema, ErrorCode, revision constant và dependency placement; nâng SDK lệch tập revision phải đỏ. _Requirements: R1.3, R9.7–8_ — _Design: §11.1–11.2, DR-6_

**Acceptance Criteria**:
- [x] Frozen install không đổi lockfile ngoài dependency đã khai báo; `sdk@1.x` không nằm trong production path.
- [x] Contracts compile độc lập, không import MCP SDK; boundary negative fixtures đỏ đúng lỗi.
- [x] Baseline Phase 1 vẫn xanh trước khi sang migration.

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
- [x] B.1 Thêm Drizzle schema cho `mutation_step`, `revision_step`, `approval_grant`, `mcp_credential`, `backup_manifest` với cột/check/FK/index đúng §6.4. _Requirements: R5b, R6, R6b, R6d_ — _Design: §6.4_
- [x] B.2 Mở rộng `revision.kind` với `composite`; rebuild table mà giữ id, parent FK, row cũ và autoincrement sequence. _Requirements: R5b.2_ — _Design: §6.1, §6.4 `revision`, DR-2_
- [x] B.3 Rebuild `mutation_journal`: thêm `composite`, `rolled_back`, `grant_id`, `backup_id`, `tool_audit_json`, indexes và JSON check. _Requirements: R5b.3–4e, R7.4c_ — _Design: §6.1, §6.4 `mutation_journal`, DR-18/19_
- [x] B.4 Backfill đúng một `mutation_step` cho mọi legacy journal unresolved `pending`/`orphaned`; terminal row không cần backfill. _Requirements: R5b.4–4e_ — _Design: §6.1, §6.5_
- [x] B.5 Tạo `db/mcp-migration-rollback.ts`: `inspectMcpRollbackSafety()` đếm từng blocker và `rollbackMcpMigration()` chỉ chạy sau report safe; rebuild/drop đúng thứ tự FK, không nối vào startup forward migrator. _Requirements: R5b, R9.5_ — _Design: §6.1 rollback, §6.5_
- [x] B.6 Siết file SQLite `0600`/Windows ACL lúc tạo hoặc mở, không làm hỏng database hiện có. _Requirements: R6d.3, R7.7_ — _Design: §5.14, DR-10_
- [x] B.7 Real SQLite migration test: fresh DB, reopen idempotent, Phase-1 fixture preservation và pending/orphaned backfill có đúng ordered step. _Requirements: R5b, R9.5_ — _Design: §6.5, §11.2_
- [x] B.8 Real SQLite constraint test: mọi FK/check/unique/partial-index, `foreign_key_check`, JSON validity và file mode hiện hữu/mới. _Requirements: R5b, R6, R6d, R9.5_ — _Design: §6.4, §11.2_
- [x] B.9 Test rollback safety cả refusal và safe path; thêm `scripts/verify-schema-drift.mjs` + root script `test:schema-drift` để snapshot migration tree trước/sau `drizzle-kit generate` và fail nếu command tạo/sửa artifact. _Requirements: R9.5_ — _Design: §6.5, §11.2_

**Acceptance Criteria**:
- [x] Fresh DB và DB Phase 1 có dữ liệu đều migrate thành công, `foreign_key_check` sạch.
- [x] Recovery source `mutation_step` không rỗng cho legacy unresolved row.
- [x] Không mất row/id/hash/audit/revision Phase 1; rollback không phá lịch sử.

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
- [x] C.1 Khai `CompositeStep`, `CompositeRequest`, `StepIntent/Result`, `PendingMutationContext`, `GrantBinding/Transition`, `PendingToolAudit` bằng type SDK-neutral. _Requirements: R1.3, R5b.1–4e, R6_ — _Design: §5.6, §5.8, §5.12_
- [x] C.2 Mở rộng `MutationJournalPort` với composite begin/attach/commit/abort/orphan, step reads, audit ownership và recovery-status reads; không để `Tx` lọt vào Core. _Requirements: R5b, R6, R7_ — _Design: §5.8 port contract, DR-3_
- [x] C.3 Thêm `BackupPort`, credential/grant persistence port, metric/log seam và doc comment nêu I/O/null/side effect. _Requirements: R6, R6b.9, R6d, R7_ — _Design: §5.11–5.14_
- [x] C.4 Thêm `WorkspacePort.exists/deleteAtomic`; adapter thực hiện containment + atomic semantics cùng allowlist hiện có. _Requirements: R5b.3–4e, R6b.2/4/7_ — _Design: §5.10 P1_
- [x] C.5 Mở rộng `CompositionModel.sources` với hash/byteSize; parse adapter hash ngay trong lượt đọc, không thêm I/O. _Requirements: R2.2–5_ — _Design: §5.5_
- [x] C.6 Thêm `scenesRemove` vào preview patch và `staleSince` vào narration normalization; record cũ thiếu field phải ra `null`. _Requirements: R5.7, R5b.6–7, R6b.8_ — _Design: §5.10 P2/P3, DR-11_
- [x] C.7 Unit/adapter test cho shape/normalization, delete containment, sources deterministic và no-SDK-type boundary. _Requirements: R1.3, R2, R5b, R6b_ — _Design: §11.1–11.2_

**Acceptance Criteria**:
- [x] Core vẫn chỉ biết port/data; mọi export mới có doc comment.
- [x] Legacy narration không bị đánh dấu stale giả; source hash khớp bytes thật.
- [x] Filesystem delete không vượt canonical project boundary.

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
- [x] D.1 Implement `beginComposite` T1: journal + ordered step rows + canonical redacted audit context + optional grant reserve CAS trong một transaction. _Requirements: R5b.1, R6.3–5, R7.4c_ — _Design: §5.6 step 4, §6.1 T1_
- [x] D.2 Implement `attachBackup` để persist `backup_id` và enrich pending audit trước filesystem step đầu. _Requirements: R6b.9, R7.8_ — _Design: §5.6 step 5, §5.12, DR-18_
- [x] D.3 Implement T2b `commitComposite`: phân loại one-step/composite, revision/steps/entity/audits/event/backup/grant/journal atomic. _Requirements: R5b.2, R7.3–4_ — _Design: §5.6 step 8, §6.1 T2b, DR-12_
- [x] D.4 Implement T2a `abortComposite`: terminal abort, clear context/link, release reserved grant; trả context in-memory cho failure audit. _Requirements: R5b.3, R7.4b_ — _Design: §6.1 T2a, §5.12_
- [x] D.5 Implement T2c `orphanComposite`: error audit + grant invalidation + orphan terminal atomically; transaction fail giữ pending. _Requirements: R5b.3–4e, R7.4c_ — _Design: §6.1 T2c, DR-16/19_
- [x] D.6 Implement step/context/status reads, `isJournalOwned(invocationId)`, `readProjectRecoveryStatus`, latest project revision và exact journal↔grant lookup. _Requirements: R2.11, R5b, R6, R7_ — _Design: §5.7, §5.12, §6.3_
- [x] D.7 Giữ `begin/commit/abort/recover/orphan` Phase 1 qua facade một-step; dual-write `revision_step` + `revision_blob`, giữ action/kind cũ. _Requirements: R5b.5, R9.6_ — _Design: §5.6 one-step table, DR-12_
- [x] D.8 Real SQLite tests cho T1 và T2a/b/c row set, exact grant/context links, terminal idempotency và one-step row semantics. _Requirements: R5b, R6, R7, R9.5_ — _Design: §11.2_
- [x] D.9 Failure/concurrency tests cho reserve CAS race, unique grant link và transaction rollback khi audit/grant/event/FK write lỗi. _Requirements: R5b, R6, R7, R9.5–6_ — _Design: §11.2_

**Acceptance Criteria**:
- [x] Không có committed composite thiếu revision step, tool audit, event hoặc grant terminal transition.
- [x] Retry terminal transaction không tạo audit/revision trùng.
- [x] Toàn bộ Phase 1 journal tests vẫn xanh.

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
- [x] E.1 Implement `mutateComposite` dưới lease + project mutex + `assertProjectWritable`, trước T1 và trước mọi filesystem write. _Requirements: R5b.1/4, R2.11_ — _Design: §5.6 step 1_
- [x] E.2 Resolve/canonicalize mọi target, kể cả entity backing path; reject duplicate canonical target và path purpose mismatch. _Requirements: R5.9, R5b.1_ — _Design: §5.6 step 2, §8.1_
- [x] E.3 Validate toàn bộ file/entity/project revision precondition và optional grant plan trước T1; conflict không chạm đĩa. _Requirements: R5.1–3, R6.3/9_ — _Design: §5.6 step 3, DR-4_
- [x] E.4 Persist T1, gọi `BackupPort` và attach verified manifest khi `backup=true`, rồi apply ordered write/delete/entity step atomically từng target; phase này dùng deterministic fake, real `AppDataBackupStore` thuộc I. _Requirements: R5b.1–2, R6b.9–10_ — _Design: §5.6 step 4–6_
- [x] E.5 Khi step lỗi, rollback landed steps theo ordinal giảm dần và verify từng `fromHash`/absence; success → T2a, failure → T2c. _Requirements: R5b.3/4e_ — _Design: §5.6 step 7, DR-16_
- [x] E.6 Khi all-landed, chạy T2b; T2 failure thử đúng một inline reconcile và nếu chưa terminal thì trả `recovery_required`, không rollback đĩa. _Requirements: R5b.4/4b, R7.4c_ — _Design: §5.6 step 8–9, DR-19_
- [x] E.7 Reimplement `mutate(request, actor, invocation?)` bằng composite một-step; caller hai tham số giữ nguyên result/action/kind, MCP caller có thể truyền durable audit context. _Requirements: R5b.5, R7.4_ — _Design: §5.6 one-step semantics, DR-12/20_
- [x] E.8 Unit test pure planning/validation: no-op, duplicate canonical target, purpose mismatch, all-precondition validation và optional `WriteInvocation` forwarding. _Requirements: R5, R5b.1, R7.4_ — _Design: §5.6, §11.2, DR-20_
- [x] E.9 Real SQLite/filesystem test: multi-file, file+entity, ordered apply, one revision/steps và precondition race không chạm đĩa. _Requirements: R5, R5b.1–2, R9.5_ — _Design: §11.2_
- [x] E.10 Failure-injection test: step failure rollback/verify, rollback failure→orphan, T2a/b/c failure→one inline reconcile→pending gate. _Requirements: R5b.3–4e, R7.4c, R9.6_ — _Design: §5.6–5.7, §11.2_
- [x] E.11 Chạy toàn bộ Phase-1 write-authority/concurrency suite và chứng minh two-argument `mutate()` byte-compatible. _Requirements: R5b.5_ — _Design: DR-12, §11.2_

**Acceptance Criteria**:
- [x] Một composite thành công sinh đúng một `projectRevision` và `revision_step[]` đầy đủ.
- [x] Không nhánh nào công bố aborted/rolled_back nếu hash verify chưa chứng minh.
- [x] T2 failure giữ durable context và từ chối write kế tiếp bằng `recovery_required`.

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
- [x] F.1 Tách pure step classifier cho write/delete/entity dựa hash thật; tuyệt đối không tin `step.status`. _Requirements: R5b.4–4d_ — _Design: §5.7 classifier_
- [x] F.2 Implement mutation decision: unknown→orphan; all-landed→roll forward; none-landed→abort; mixed→reverse rollback + verify. _Requirements: R5b.4b–4e_ — _Design: §5.7 flow, DR-5_
- [x] F.3 Dùng persisted `grant_id` + `tool_audit_json` cho T2 retry/terminal audit; đảm bảo retry không audit hoặc consume/release grant trùng. _Requirements: R6.4, R7.1–4c_ — _Design: §5.7, DR-18/19_
- [x] F.4 Thay startup reconciler cũ bằng per-journal reconciliation có report pending/recovered/rolledBack/orphaned và project isolation. _Requirements: R5b.4, R8.5_ — _Design: §5.7_
- [x] F.5 Implement `resolveOrphanedMutation` cho `restore-previous` và `accept-current` dưới lease/mutex, bypass gate chỉ đúng journal và audit actor `cli-external`. _Requirements: R5b.4d–4e_ — _Design: §5.7 admin resolution_
- [x] F.6 Gate mọi write khi project còn ít nhất một pending/orphaned; resolve một journal không mở gate nếu còn journal khác. _Requirements: R2.11, R5b.4d–4e_ — _Design: §6.3_
- [x] F.7 Unit test classifier/decision thuần: tampered `step.status`, write/delete/entity all/none/mixed/unknown và reverse rollback order. _Requirements: R5b.4b–4e_ — _Design: §5.7, §11.2_
- [x] F.8 Real persistence test: T2a/b/c injection, exact grant/audit recovery, repeated startup, rollback failure→orphan và all-landed roll-forward không sửa đĩa. _Requirements: R5b, R7, R9.6_ — _Design: §5.7, §11.2_
- [x] F.9 Admin-resolution test: restore/accept validation, crash giữa resolution, bypass đúng journal và two-unresolved gate không mở sớm. _Requirements: R2.11, R5b.4d–4e_ — _Design: §5.7, §6.3, §11.2_

**Acceptance Criteria**:
- [x] Mọi observed state về đúng một terminal outcome hoặc giữ gate; không có “best guess”.
- [x] Recovery all-landed giữ filesystem và commit đúng grant/audit của journal.
- [x] Admin resolution crash-safe; gate chỉ gỡ sau verify + terminal transaction.

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
- [x] G.1 Expose `sources` từ parse cho entry + mọi referenced sub-composition với canonical relative path/hash/byteSize. _Requirements: R2.2–5_ — _Design: §5.5_
- [x] G.2 Mở rộng studio snapshot/context với `fileHashes`, `projectRevision`, `entityRevision`, diagnostics và `ProjectRecoveryStatus`. _Requirements: R2.2–3/11_ — _Design: §6.2–6.3, §7.2_
- [x] G.3 Mở rộng list project/scene và read composition outputs; không lộ absolute path, enforce allowlist/size trước content. _Requirements: R2.1/4–10_ — _Design: §7.1/7.3/7.4_
- [x] G.4 Đảm bảo cache invalidation và read lúc gate vẫn hoạt động nhưng luôn báo unresolved journals. _Requirements: R2.11_ — _Design: §5.7, §6.3_
- [x] G.5 Unit/integration test: hashes khớp đĩa, đủ precondition cho write kế tiếp, outside/forbidden/too-large, pending/orphan visibility và no absolute path. _Requirements: R2_ — _Design: §11.2_

**Acceptance Criteria**:
- [x] `get_project_context` ở trạng thái ready đủ dữ kiện gọi mọi write tool.
- [x] Read lúc recovery gate không bị chặn và không trình bày project healthy.
- [x] Không có lượt đọc filesystem dư chỉ để tính hash.

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
- [x] H.1 Implement `request(binding, summary)` với canonical binding, request TTL mặc định 10 phút và deterministic ID/Clock/config ports. _Requirements: R6.2–3_ — _Design: §5.8_
- [x] H.2 Implement admin-only `issue(requestId, ui|cli)` CAS requested→issued, reject expired request, set issued grant TTL mặc định 5 phút. _Requirements: R6.2/5_ — _Design: §5.8_
- [x] H.3 Implement `planReserve` domain validation và map approval-expired/invalid/conflict; T1 vẫn là authority cuối. _Requirements: R6.3/5/9_ — _Design: §5.8, DR-3/4_
- [x] H.4 Implement revoke và lifecycle cleanup terminal rows; không prune grant gắn unresolved journal. _Requirements: R6.4–5_ — _Design: §4.5, §6.1 retention_
- [x] H.5 Giới hạn Registry dependency bằng `Pick<ApprovalService,"request">`; issue/revoke chỉ composition root admin path có. _Requirements: R6.2/8_ — _Design: §5.2, §5.8_
- [x] H.6 Unit tests cho canonical binding và 7-state transition table, request/grant expiry boundaries, error mapping và reserved no-timeout. _Requirements: R6.3–5/9, R9.4_ — _Design: §5.8, §11.2_
- [x] H.7 Real SQLite concurrency/cleanup tests: replay, two-reserve CAS, revoke-vs-reserve, binding/hash/revision mismatch, reuse after release và retention không đụng unresolved grant. _Requirements: R6.3–5/9, R9.4–5_ — _Design: §6.1, §11.2_

**Acceptance Criteria**:
- [x] Agent/MCP code không thể issue grant bằng type/runtime path.
- [x] Hai destructive requests cạnh tranh cùng grant: đúng một request thắng.
- [x] Grant orphaned/rollback-failed không quay về issued.

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
- [x] I.1 Implement app-data backup layout và canonical manifest/hash; không ghi absolute path vào public output/audit. _Requirements: R6b.9, R7.6–8_ — _Design: §5.11_
- [x] I.2 Implement atomic `create`: temp dir, payload copy, fsync, verify mọi hash, rename publish; failure không để published manifest. _Requirements: R6b.9_ — _Design: §5.11, DR-15_
- [x] I.3 Implement read/readPayloads/verify/list với manifest integrity và project scoping. _Requirements: R6b.9_ — _Design: §5.11_
- [x] I.4 Implement `prunePayloads` mặc định 30 ngày, giữ metadata/FK và set `payload_pruned_at`; cleanup orphan payload chỉ sau grace mặc định 24 giờ. _Requirements: R6b.9_ — _Design: §5.11, §6.1 retention_
- [x] I.5 Implement Core `restoreBackup`: verify payload, precondition bằng destructive revision `to_hash`, composite revision mới, actor `cli-external`. _Requirements: R6b.9–10_ — _Design: §5.11, DR-15_
- [x] I.6 Wire backup store/prune vào composition root/startup; startup failure không mở listener sai trạng thái. _Requirements: R6b.9, R8.5_ — _Design: §5.11_
- [x] I.7 Real filesystem store tests: temp/fsync/verify/rename failure, tamper detection, manifest scoping, prune/expired và 24-hour orphan grace boundary. _Requirements: R6b.9, R9.5_ — _Design: §5.11, §11.2_
- [x] I.8 Real SQLite/filesystem restore tests: attach revision/audit IDs, exact `to_hash` precondition, later-edit conflict, new restore revision và metadata FK survives prune. _Requirements: R6b.9–10, R7.8, R9.5_ — _Design: §5.11, §11.2_

**Acceptance Criteria**:
- [x] Destructive mutation không chạm target trước khi backup publish + verify.
- [x] Restore không overwrite thay đổi mới hơn.
- [x] Retention không phá audit/history FK.

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
- [x] J.1 Viết lại `createScene` thành một composite (scene file + entry + narration sidecar), nhận entry hash + optional `WriteInvocation`, trả scene/project/WriteEnvelope. _Requirements: R5.1–5, R5b.5, R7.4_ — _Design: §5.4, §5.6, §7.5, DR-20_
- [x] J.2 Giữ `setSceneTiming` file-hash precondition, nhận optional `WriteInvocation`, domain timing errors và trả entity/project/envelope đầy đủ. _Requirements: R5.1–6, R7.4_ — _Design: §5.4, §7.6, DR-20_
- [x] J.3 Mở rộng `setSceneScript`: source + narration `staleSince` trong cùng composite, truyền optional `WriteInvocation`; không tự chạy TTS. _Requirements: R5.7, R5b.6–7, R7.4_ — _Design: §5.10 P3, §7.7, DR-11/20_
- [x] J.4 Siết `saveSourceFile` size/protected allowlist và output hash/envelope; nhận optional `WriteInvocation`, conflict kèm current state. _Requirements: R5.1–4/8–9, R7.4_ — _Design: §7.8, §8.2, DR-20_
- [x] J.5 Implement pure `planSceneDeletion` + `digestPlan` cho shared src, inline, latest, last scene=0, narration và preview cleanup. _Requirements: R6b.1–8/11–12_ — _Design: §5.9a, DR-13_
- [x] J.6 Implement `prepareSceneDeletion` I/O: collect model/settings/narration/hashes/revision, validate scene, build binding. _Requirements: R6.3/9, R6b_ — _Design: §5.9a, DR-4/13_
- [x] J.7 Implement `deleteScene` composite với verified backup, grant transition, all cleanup, one revision và complete output. _Requirements: R6, R6b.1–12_ — _Design: §5.9a–5.11, §7.10_
- [x] J.8 Implement `prepareFileDeletion`: allowlist/protected/hash/reference scan, latest project revision, canonical plan/digest/binding; không ghi. _Requirements: R6.3/9, R6b.9–10_ — _Design: §5.9b, §7.9, DR-4/13_
- [x] J.9 Implement `deleteFile` chỉ nhận approved plan + grant, revalidate qua T1, backup và one-delete/one-revision result; truyền optional `WriteInvocation`. _Requirements: R6, R6b.9–10, R7.4_ — _Design: §5.9b, §7.9, DR-15/20_
- [x] J.10 Unit test use-case/planner: create plan, stale narration, timing/save errors, 6 scene-deletion cases, file reference safety và last-scene warning. _Requirements: R5, R5b.5–7, R6b.1–8/11–12_ — _Design: §11.1_
- [x] J.11 Real SQLite/filesystem test: create atomicity, single-step/composite audit forwarding, delete cleanup, one revision, verified backup và restore conflict. _Requirements: R5, R5b.5–7, R6b, R7.4, R9.5_ — _Design: §11.2, DR-20_
- [x] J.12 Failure-injection test tại từng crash boundary của create/delete, chứng minh terminal outcome hoặc recovery gate và không audit kép. _Requirements: R5b.3–4e, R6b.10, R7.4b–4c, R9.6_ — _Design: §5.6–5.7, §11.2_

**Acceptance Criteria**:
- [x] `create_scene`-ready use case sinh đúng một revision; crash không để project usable ở trạng thái nửa vời.
- [x] `deleteScene` phủ đủ mount/file/root/narration/settings/backup trong một mutation.
- [x] Tất cả error paths không chạm đĩa hoặc giữ recovery gate.

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
- [x] K.1 Implement canonical redaction và `PendingToolAudit` schema-versioned serialization; cấm secret/raw file/absolute path. _Requirements: R7.2/6–7_ — _Design: §5.12_
- [x] K.2 Implement `prepareWrite`, `recordRead`, `recordFailure` và retry đúng một lần + logger/metric escalation. _Requirements: R7.1/4b/5_ — _Design: §5.12, DR-7_
- [x] K.3 Gắn terminal success/orphan audit vào T2/recovery với đúng `protocol_version`, credential id, project revision, grant/backup IDs. _Requirements: R7.2–4c/8_ — _Design: §5.12, §6.4 audit_
- [x] K.4 Implement ownership decision theo invocation ID; lookup lỗi chỉ metric/log, không ghi audit phỏng đoán. _Requirements: R7.1/4b–4c_ — _Design: §5.12_
- [x] K.5 Đảm bảo T2a clear context chuyển ownership về caller; T2b/T2c/recovery giữ journal-owned semantics và chống audit kép. _Requirements: R7.1/4b–4c_ — _Design: §5.12, DR-18/19_
- [x] K.6 Unit test policy/redaction/ownership: read fail-open, pre-T1/rolled-back best-effort, retry-once, ownership unknown và canonical payload. _Requirements: R7.1–2/4b/5–7_ — _Design: §5.12, §11.2_
- [x] K.7 Real SQLite failure injection: terminal fail-closed, all-landed indeterminate, orphan terminal, T2a ownership handoff và one-step tool audit cùng revision. _Requirements: R7.1–4c/8, R9.5–6_ — _Design: §5.12, §11.2, DR-20_
- [x] K.8 Verify audit query indexes và row relation tool→revision→mutation; retention/prune không làm mất giải thích lịch sử. _Requirements: R7.2–3/8_ — _Design: §6.4_

**Acceptance Criteria**:
- [x] Committed mutation không thể thiếu tool audit.
- [x] Failure đã chứng minh không đổi đĩa không bị biến thành user error vì audit store.
- [x] Mỗi invocation có tối đa một terminal tool audit row.

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
- [x] L.1 Implement `ToolDefinition` gồm `projectIdOf`, level-derived annotations, `ToolContext` gồm invocation/write context, output validation và deterministic Registry registration/list. _Requirements: R1.1/5–6, R7.2/4_ — _Design: §5.1–5.2, DR-20_
- [x] L.2 Implement Registry invoke pipeline: strict input → `projectIdOf` → level/grant policy → prepare one pending audit → Core handler với `writeInvocation` → output schema → ownership/audit policy; không gọi HTTP. _Requirements: R1.2–4, R7_ — _Design: §5.2, §5.12, DR-20_
- [x] L.3 Register `list_projects` với concise description, read annotations và structured output. _Requirements: R2.1/10–11_ — _Design: §7.1_
- [x] L.4 Register `get_project_context` và `list_scenes`, đủ hash/revision/diagnostics/recovery cho next action. _Requirements: R2.2–4/10–11_ — _Design: §7.2–7.3_
- [x] L.5 Register `read_composition` với allowlist/size/path errors và content hash. _Requirements: R2.5–10_ — _Design: §7.4_
- [x] L.6 Register `create_scene` và `set_scene_timing`; thiếu/stale precondition không ghi, output entity + envelope. _Requirements: R5.1–6_ — _Design: §7.5–7.6_
- [x] L.7 Register `set_text` và `save_file`; expose narration stale/protected/size behavior trong description và output. _Requirements: R5.1–4/7–9_ — _Design: §7.7–7.8_
- [x] L.8 Register `delete_scene`: thiếu grant tạo approval request; modern trả MRTR input-required, legacy actionable `approval_required`; retry re-plan. _Requirements: R6.1–9, R6b_ — _Design: §4.4, §7.10_
- [x] L.9 Register `delete_file` với reference safety, grant, backup và complete output. _Requirements: R6, R6b.9–10_ — _Design: §7.9_
- [x] L.10 Descriptor/schema tests khóa exact name/title/description/input/output/annotations/level, legacy visibility và deterministic order. _Requirements: R1.1/5–6, R9.3_ — _Design: §11.1, §11.3_
- [x] L.11 Invoke tests chạy đủ 10 handler, invalid input, output mismatch, `projectIdOf`, `WriteInvocation` forwarding và CI guard mọi Registry tool có case. _Requirements: R1.2–4, R7.1–4c, R9.7_ — _Design: §5.2, §11.1, DR-20_

**Acceptance Criteria**:
- [x] Tool được định nghĩa đúng một lần; schema/handler không lặp ở transport.
- [x] Mỗi tool có title, actionable description, strict input/output và đủ annotation; annotation không thay authorization.
- [x] Output đủ để agent quyết định bước kế tiếp mà không read thừa.

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
- [x] M.1 Implement server factory `vidcom-mcp-server` lấy version từ package, một register function dùng Registry cho cả hai era/transport; không tự viết initialize/discover/result stamping. _Requirements: R1.2, R3, R4.5_ — _Design: §5.13, DR-1_
- [x] M.2 Làm legacy stdio path trước: initialize revisions, no modern fields, resource error `-32002`, clean close. _Requirements: R4.1/3–5, R8_ — _Design: §5.13_
- [x] M.3 Làm legacy stateless HTTP: no-version default `2025-03-26`, GET/DELETE 405, same Registry. _Requirements: R4.2/5–6, R6c.1/5–6_ — _Design: §5.13, §7.11_
- [x] M.4 Bật modern stdio/HTTP: `server/discover`, resultType, private cache hint, header mismatch, MRTR codec. _Requirements: R3.1–5, R6.6_ — _Design: §5.13_
- [x] M.5 Implement pinned HTTP wrapper bằng SDK classifier + exact allowlist, delegate invalid JSON, handle batch/header/body and same-era mismatch. _Requirements: R6c.2–4/8_ — _Design: §5.13, DR-14_
- [x] M.6 Implement pinned stdio factory `--protocol`; không pin thì SDK classify/negotiate. _Requirements: R6c.7_ — _Design: §5.13, DR-14_
- [x] M.7 Implement era-aware domain/protocol error mapper, including resource code split và unsupported `-32022` với toàn bộ revision. _Requirements: R3.6, R4.4, R5, R6_ — _Design: §8.1–8.2_
- [x] M.8 Legacy transport tests bằng `sdk@1.30.0`: stdio + stateless HTTP, no-header default, no modern fields, resource code và stdout sạch. _Requirements: R4, R8.1–2, R9.1–4_ — _Design: §11.2–11.3_
- [x] M.9 Modern transport tests bằng `client@2.0.0`: stdio + HTTP, discover/result/cache fields, MRTR `requestState` và header mismatch. _Requirements: R3, R6.6, R9.1–4_ — _Design: §11.2–11.3_
- [x] M.10 Exact-pin tests: entry/pinned/latest/stdio, same-era mismatch, unknown revision, invalid JSON delegation, batch và cùng canonical result qua mọi path. _Requirements: R6c, R9.2/4/8_ — _Design: §5.13, §11.2–11.3, DR-14_
- [x] M.11 Mở rộng root script `test:golden` thành `vitest run tests/golden tests/mcp/golden` để golden MCP nằm trong release gate; hiện script chỉ quét `tests/golden` nên golden Phase M sẽ bị bỏ sót ở P.7. _Requirements: R9.3_ — _Design: §11.3_

**Acceptance Criteria**:
- [x] Một factory + một Registry phục vụ bốn tổ hợp era×transport.
- [x] Pin so exact revision, không chỉ era; SDK vẫn sở hữu validation ladder.
- [x] stdout stdio không có log trong transport tests.

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
- [x] N.1 Implement credential issue: 32 CSPRNG bytes, `vcmcp_` base64url, canonical SHA-256 unique digest; secret trả đúng một lần. _Requirements: R6d.2–3_ — _Design: §5.14, DR-17_
- [x] N.2 Implement verify constant-shape, active/rotating window, lazy revoke, timing-safe compare và đồng nhất `credential_invalid`. _Requirements: R6d.1/4–5_ — _Design: §5.14_
- [x] N.3 Implement rotate tạo id mới + overlap mặc định 5 phút (override explicit), revoke immediate, list metadata không secret. _Requirements: R6d.4–5_ — _Design: §5.14_
- [x] N.4 Add `mcpBearerAuth` request context với credentialId; không chấp nhận session cookie cho MCP và không đòi bearer ở stdio. _Requirements: R6d.1/6–7_ — _Design: §5.1, §5.14_
- [x] N.5 Tách Hono auth branch sau hostCheck/strictCors và trước body/handler; giữ loopback, Host và cross-origin perimeter Phase 1. _Requirements: R6c.5, R6d.1_ — _Design: §5.14, §7.11_
- [x] N.6 Mount structural `McpRouteDependencies` cho `/api/mcp`, revisions và latest; server/mcp không import nhau. _Requirements: R6c.1–6/9_ — _Design: §5.13, DR-8_
- [x] N.7 Unit + real SQLite credential tests cho entropy/hash/status/rotation/revoke/lazy expiry/overlap boundary và list không secret. _Requirements: R6d.2–5, R9.5_ — _Design: §5.14, §11.2_
- [x] N.8 Hono `app.request()` tests cho auth rejection uniformity, credentialId context/audit, session-cookie rejection, middleware trace order và GET/DELETE 405. _Requirements: R6c.5, R6d.1/6–7_ — _Design: §5.14, §7.11, §11.2_
- [x] N.9 Real listener tests cho entry/pinned/latest, Host/CORS/body, simultaneous legacy+modern clients và clean handler close. _Requirements: R3, R4, R6c, R9.2_ — _Design: §11.1–11.2_

**Acceptance Criteria**:
- [x] Không request MCP HTTP nào qua được nếu thiếu bearer hợp lệ, kể cả loopback.
- [x] Token không nằm trong SQLite/log/URL/workspace; audit chỉ có credential id.
- [x] Existing Hono browser session routes vẫn giữ nguyên hành vi.

**Deliverables**: credential lifecycle, bearer middleware, MCP Hono mount, security suite.

---

## Phase O: CLI/admin surfaces và exact SDK-host smoke

**Addresses**: R6, R6b.9, R6c.7, R6d.2/4–5/7, R8
**Design reference**: §5.7, §5.11, §5.15
**Files affected**: `packages/cli/src/**`, composition/startup wiring, CLI tests, smoke fixtures/scripts
**Prerequisite**: F + H + I + M + N
**Skill**: `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`
**Read first**: activation table Phase O

**Tasks**:
- [x] O.1 Refactor CLI dispatch thành subcommands mà giữ `vidcom app` hiện tại; parse args strict và errors chỉ stderr. _Requirements: R8.1–4_ — _Design: §5.15_
- [x] O.2 Implement `vidcom mcp [--workspace] [--protocol]`: workspace resolution chuẩn, lease/startup deps, stdio start và no credential HTTP. _Requirements: R6c.7, R6d.7, R8.1–4_ — _Design: §5.13, §5.15_
- [x] O.3 Implement SIGINT/SIGTERM clean close: transport, watcher, lease, DB; không log stdout. _Requirements: R8.2/5_ — _Design: §5.15_
- [x] O.4 Implement trusted admin `vidcom approve <requestId>`; không expose issue qua MCP. _Requirements: R6.2/7–8_ — _Design: §5.8, §5.15_
- [x] O.5 Implement `credential issue|list|rotate|revoke [--overlap-ms]` với secret one-time, JSON stdout, redacted error và exit-code contract. _Requirements: R6d.2–6_ — _Design: §5.14–5.15_
- [x] O.6 Implement `backup list|verify|restore`; restore gọi Core, không ghi filesystem trực tiếp. _Requirements: R6b.9, R7.8_ — _Design: §5.11, §5.15_
- [x] O.7 Implement `recovery inspect|reconcile|resolve`; inspect read-only, reconcile deterministic, resolve bắt buộc choice exact. _Requirements: R5b.4d–4e_ — _Design: §5.7, §5.15_
- [x] O.8 CLI tests cho strict dispatch/args, JSON admin output, exit codes, missing workspace, protocol pin error, signal cleanup và lease release. _Requirements: R6, R8.1–5_ — _Design: §5.15, §11.1–11.3_
- [x] O.9 Exact SDK-host smoke: installed legacy/modern MCP clients spawn stdio, list/call tool, approval round-trip, clean shutdown và stdout chỉ protocol frames. _Requirements: R3, R4, R6, R8, R9.1–2_ — _Design: §11.1–11.3_

**Acceptance Criteria**:
- [x] Exact installed MCP SDK clients spawn resolved `vidcom mcp` và bắt tay cả hai era; không claim actual Claude Code/Codex binary.
- [x] Missing workspace không đoán/tạo folder; pin lạ báo revision hỗ trợ.
- [x] Admin commands audit actor đúng và không bypass Core/write authority.

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
- [x] P.1 Dựng parameterized matrix 2 era × 2 transport dùng exact client `sdk@1.30.0`/`client@2.0.0`; chạy mọi tool phù hợp. _Requirements: R9.1–2/7_ — _Design: §11.1–11.2_
- [x] P.2 Commit golden `tools/list` legacy + modern và result shape; kiểm deterministic order nhiều lượt, modern cache private và legacy không có modern fields. _Requirements: R3.3–4, R4.3, R9.3_ — _Design: §11.1/11.3_
- [x] P.3 Contract negative matrix: missing/stale precondition, missing/replay/expired grant, unknown revision, no-header default, resource-code split, hidden legacy tool. _Requirements: R1.6, R3–6, R9.4_ — _Design: §11.3_
- [x] P.4 Real datastore recovery matrix: composite all/none/mixed/unknown, T2a/b/c failures, exact grant/audit recovery, repeated reconcile và project gate. _Requirements: R5b, R6, R7, R9.5–6_ — _Design: §11.2_
- [x] P.5 Real datastore destructive matrix: approval lifecycle, backup publish/attach/prune/restore, delete outcomes, crash boundaries và audit relation. _Requirements: R6, R6b, R7, R9.4–6_ — _Design: §11.2_
- [x] P.6 Add CI guard “mọi registry tool có contract case”, revision constants match SDK, one-step audit forwarding, stdout cleanliness và schema drift. _Requirements: R7.4, R9.7–8, R8.1–2_ — _Design: §11, DR-6/20_
- [x] P.7 Chạy đúng toàn bộ command trong Phase Verification Matrix, gồm `test:schema-drift` và `git diff --check`; ghi command, exit code, test count, commit SHA vào Execution Log/notes. _Requirements: Definition of Done 10–12_ — _Design: §11_
- [x] P.8 Chạy exact SDK-host demo end-to-end và cập nhật main spec/build-order/product docs bằng behavior thật; push và xác minh remote CI trước closeout. _Requirements: Definition of Done 1–12_ — _Design: §12_

**Acceptance Criteria**:
- [x] Mọi combination era×transport và mọi registry tool có automated contract evidence.
- [x] Full local gates + remote CI xanh trên đúng commit; không skipped test.
- [x] Detailed Design/checklist/implementation notes khớp code đã ship trước khi đổi spec thành complete.

**Deliverables**: contract/golden/durability matrix, CI gates, verified demo và closeout evidence.

---

## Review Remediation Dependency Order

```text
R Filesystem consistency + recovery
├─→ S Core contracts, reads, tools và audit
├─→ T HTTP transport + security
└─→ U CLI lifecycle + operability
R + S + T + U ─→ V Evidence, process và closeout
```

Nguồn finding canonical: `mcp-server-review.md` và 7 raw report trong `mcp-server-review-raw/`. Mỗi task dưới đây đóng đúng một finding hợp nhất; không được mark `[x]` chỉ bằng việc test cũ vẫn xanh.

## Phase R: Filesystem consistency, recovery và retention — REVIEW GATE

**Addresses**: C-01, H-01–H-04, M-12–M-14
**Design reference**: §17.1–17.4, DR-21–DR-24
**Files affected**: Core write/recovery ports và services, filesystem/SQLite adapters, startup ordering, real race/crash tests
**Prerequisite**: Phase P complete; raw review đã đọc đầy đủ; main spec đã reopen
**Skill**: `.agents/skills/bun/SKILL.md`, `.agents/skills/mcp-builder/SKILL.md`

**Tasks**:
- [x] R.1 **C-01** — thay primitive publish bằng durable capture/CAS: external edit tại validation→T1, T1→backup hoặc backup→publish phải còn nguyên và mutation không commit; backup lấy đúng captured bytes. _Requirements: R5, R5b, R6b_ — _Design: §17.1, DR-21_
- [x] R.2 **H-01** — đưa exact lease owner/expiry và unresolved project gate vào cùng transaction T1; thêm two-connection handover barrier test. _Requirements: R5b, R7_ — _Design: §17.2, DR-22_
- [x] R.3 **H-02** — recovery revalidate/capture filesystem tại settlement boundary; edit giữa classify và T2 giữ gate thay vì công bố revision stale. _Requirements: R5b, R7_ — _Design: §17.1–17.2, DR-21/22_
- [x] R.4 **H-03** — scope startup recovery theo workspace đang lease; targeted recovery acquire lease của workspace chứa journal trước mọi read/write. _Requirements: R5b, R8_ — _Design: §17.2, DR-22_
- [x] R.5 **H-04** — backup failure dùng `abortOrReconcile`; chỉ trả `backup_failed` khi terminal, nếu không trả `recovery_required` với journal/phase. _Requirements: R5b, R6b, R7_ — _Design: §17.3, DR-23_
- [x] R.6 **M-12** — prune backup theo tombstone/rename → durable state → physical delete và reconcile crash residue. _Requirements: R6b_ — _Design: §17.4, DR-24_
- [x] R.7 **M-13** — recovery chạy trước retention; backup gắn unresolved journal không được prune. _Requirements: R5b, R6b_ — _Design: §17.4, DR-24_
- [x] R.8 **M-14** — bỏ duplicate rollback bytes khỏi hot SQLite path bằng content-addressed payload reference/retention policy; test asset lớn và DB growth. _Requirements: R5b, R6b_ — _Design: §17.4, DR-24_

**Acceptance Criteria**:
- [x] Barrier tests real filesystem/SQLite chứng minh external bytes không mất ở mọi review window.
- [x] Không process nào inspect/write workspace không giữ lease.
- [x] Pending/orphaned journal giữ đủ backup/rollback payload để reconcile hoặc admin resolve.

---

## Phase S: Core contracts, read model, tool safety và audit

**Addresses**: H-05–H-07, M-01–M-08, M-11, L-03–L-04, L-07
**Design reference**: §17.5–17.8, DR-25–DR-28
**Files affected**: contracts, parser/models, Core reads/writes/deletion, Registry/audit, credential/grant services, golden tests
**Prerequisite**: R complete
**Skill**: `.agents/skills/bun/SKILL.md`, `.agents/skills/mcp-builder/SKILL.md`

**Tasks**:
- [x] S.1 **H-05** — canonical project-relative reference set gồm nested scene, root track và relative media owner; `delete_file` deny mọi referenced target. _Requirements: R6b_ — _Design: §17.5, DR-25_
- [x] S.2 **H-06** — `create_scene` enforce duration/start/sum invariant trước apply/T1; 0, âm, overflow không tạo file/journal/revision. _Requirements: R5_ — _Design: §17.5_
- [x] S.3 **H-07** — modern `input_required` ghi đúng một terminal caller-owned audit trước transport mapping. _Requirements: R7_ — _Design: §17.6, DR-26_
- [x] S.4 **M-01** — reject empty timing patch ở schema và Core, không serialize/churn revision. _Requirements: R5_ — _Design: §17.5_
- [x] S.5 **M-02** — `set_text` trả narration stale đúng khi sidecar tồn tại; cập nhật schema/design và test absent/present. _Requirements: R5_ — _Design: §17.5_
- [x] S.6 **M-03** — khóa response-finalization semantics để mutation committed không bị báo ordinary failure do output validation hậu commit. _Requirements: R5, R7_ — _Design: §17.6, DR-26_
- [x] S.7 **M-04** — `WriteEnvelope.fileHashes` chỉ nhận canonical `RelPath` key. _Requirements: R5_ — _Design: §17.5_
- [x] S.8 **M-05** — rewrite đủ 10 tool descriptions: use/don't-use, precondition source, side effect, errors/recovery; cập nhật goldens. _Requirements: R1–R6_ — _Design: §17.5_
- [x] S.9 **M-06** — audit persist duration và revision before/after cho read/error/pre-T1/commit/recovery. _Requirements: R7_ — _Design: §17.6, DR-26_
- [x] S.10 **M-07** — `list_projects` isolate malformed project và bound concurrency/pagination theo contract cập nhật. _Requirements: R2_ — _Design: §17.7, DR-27_
- [x] S.11 **M-08** — missing referenced source trả bounded diagnostic/state, không throw `internal`. _Requirements: R2_ — _Design: §17.7, DR-27_
- [x] S.12 **M-11** — transition requested/issued grant quá TTL sang expired trước retention cleanup; giữ unresolved reserved rows. _Requirements: R6_ — _Design: §17.4_
- [x] S.13 **L-03** — Core credential `list()` trả summary không có `secretHash`. _Requirements: R6d_ — _Design: §17.8, DR-28_
- [x] S.14 **L-04** — MCP text content dùng canonical JSON byte-equivalent với `structuredContent`. _Requirements: R1, R3, R4_ — _Design: §17.6_
- [x] S.15 **L-07** — bound `--overlap-ms` trong product maximum và ECMAScript Date range ở CLI + Core. _Requirements: R6d, R8_ — _Design: §17.8_

---

## Phase T: HTTP transport và security hardening

**Addresses**: H-08, M-09–M-10, L-01–L-02
**Design reference**: §17.9, DR-29
**Files affected**: MCP HTTP wrapper, Hono perimeter/routes, DB initialization, security/transport tests
**Prerequisite**: R complete; có thể triển khai sau S nhưng Verification Matrix chỉ chạy khi cả hai complete
**Skill**: `.agents/skills/hono/SKILL.md`, `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`

**Tasks**:
- [x] T.1 **H-08** — forward `options.authInfo` qua entry, mọi exact pin và `latest`; Hono→real SDK→Registry audit giữ credential ID, không giữ bearer. _Requirements: R6c, R6d, R7_ — _Design: §17.9, DR-29_
- [x] T.2 **M-09** — exact-pin wrapper giữ SDK `Content-Type`/invalid-body validation ladder trước revision mismatch. _Requirements: R3, R4, R6c_ — _Design: §17.9_
- [x] T.3 **M-10** — request logger chỉ ghi method + pathname, không query secret/absolute path trước auth. _Requirements: R6d_ — _Design: §17.9_
- [x] T.4 **L-01** — CORS phát canonical configured origin, không reflect request value; khóa credentialed preflight. _Requirements: R6d_ — _Design: §17.9_
- [x] T.5 **L-02** — precreate app-data `0700`, SQLite/main-WAL-SHM owner-only trước sensitive write. _Requirements: R6d_ — _Design: §17.9_

---

## Phase U: CLI lifecycle, workspace isolation và executable contract

**Addresses**: H-09–H-10, M-15–M-19
**Design reference**: §17.10, DR-30
**Files affected**: startup/composition root, MCP stdio lifecycle, workspace selection, admin commands, CLI error mapping, bin artifact/tests
**Prerequisite**: R complete
**Skill**: `.agents/skills/bun/SKILL.md`, `.agents/skills/mcp-builder/SKILL.md`

**Tasks**:
- [x] U.1 **H-09** — idempotent unwind luôn thử listener/scheduler/watcher/lease/DB và ném `AggregateError` sau cùng. _Requirements: R8_ — _Design: §17.10, DR-30_
- [x] U.2 **H-10** — track bin `100755`, tạo resolved `vidcom` command trong clean artifact test và spawn đúng command; docs không overclaim SEA. _Requirements: R8, R9_ — _Design: §17.10_
- [x] U.3 **M-15** — stdin EOF/stdout close dừng MCP, cleanup và nhả lease. _Requirements: R8_ — _Design: §17.10_
- [x] U.4 **M-16** — cài signal abort gate trước startup và giữ handler tới cleanup settled; test signal giữa startup/double signal. _Requirements: R8_ — _Design: §17.10_
- [x] U.5 **M-17** — explicit workspace invalid fail fast, không fallback active/cwd và không acquire lease. _Requirements: R8_ — _Design: §17.10_
- [x] U.6 **M-18** — validate backup ID/target trước full writer runtime; restore dùng targeted minimal runtime đúng workspace. _Requirements: R6b, R8_ — _Design: §17.10_
- [x] U.7 **M-19** — unexpected CLI error thành một dòng stable/redacted; production launcher không phát experimental warning vào contract stderr. _Requirements: R8_ — _Design: §17.10_

---

## Phase V: Contract evidence, process truth và release closeout

**Addresses**: M-20–M-24, L-05–L-06, L-08
**Design reference**: §17.11, DR-31
**Files affected**: contract/golden/E2E/runtime tests, scripts/CI, checklist/spec/design/notes/product docs
**Prerequisite**: R–U complete
**Skill**: `.agents/skills/mcp-builder/SKILL.md`, `.agents/skills/bun/SKILL.md`

**Tasks**:
- [x] V.1 **M-20** — success-path Registry/transport matrix cho đủ 10 tool qua representative 2×2 cells; negative matrix giữ riêng. _Requirements: R9_ — _Design: §17.11, DR-31_
- [x] V.2 **M-21** — chạy actual Claude Code/Codex host smoke hermetic hoặc hạ wording DoD về exact SDK harness với evidence trung thực. _Requirements: R8, R9_ — _Design: §17.11_
- [x] V.3 **M-22** — sửa mọi stale Phase Verification Matrix path, thêm existence guard và rerun từng focused gate. _Requirements: R9_ — _Design: §17.11_
- [x] V.4 **M-23** — canonicalize approval fact v6 trong Goals/Design/Checklist/Main spec. _Requirements: R9_ — _Design: §17.11_
- [x] V.5 **L-05** — `test:mcp-contract` chứa matrix, negative và revision-pin suites thật. _Requirements: R9_ — _Design: §17.11_
- [x] V.6 **L-06** — sắp `implementation-notes.html` theo B→P→R→V hoặc đánh sequence index rõ ràng. _Requirements: R9_ — _Design: §17.11_
- [x] V.7 **L-08** — runtime smoke chạy legacy entry + modern exact/latest, audit credential; child timeout phải fail và kill cứng. _Requirements: R6c, R6d, R8, R9_ — _Design: §17.11_
- [x] V.8 **M-24** — push final remediation SHA và lưu remote CI evidence trên exact HEAD. _Requirements: R9_ — _Design: §17.11, DR-31_

**Acceptance Criteria**:
- [x] 43/43 review findings có task `[x]`, regression evidence và raw-to-fix traceability.
- [x] Full local Verification Matrix exit 0, không skip/todo/only.
- [x] Remote CI xanh trên exact remediation implementation HEAD trước khi đổi spec về `complete`; exact closeout HEAD được xác minh CI riêng trước khi kết thúc goal.

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

**Estimated scope**: 21 phases, 183 numbered implementation tasks. 43 remediation task Phase R→V được thêm sau implementation review; completion gate mới là 183/183 và 43/43 finding có regression evidence.

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
- [x] Integration nối Core → Registry → transport → server/CLI → exact installed SDK-host harness.

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
- [x] Approval Gate ghi **Approved — Code Execution authorized**; `/goal` duyệt Design v6 + checklist trước production code A→P.

## Execution Log

> Append một entry mỗi work session. Design drift vật chất phải cập nhật Detailed Design trước khi tiếp tục.

2026-08-02 — Phase A, Task A.1
  - Files: [`spec-mcp-server-implementation-checklist.md`, `implementation-notes.html`, `spec-mcp-server-inprocess.md`, `spec-mcp-server-detailed-design.md`]
  - Summary: Người dùng xác nhận Design v6 + checklist và authorize Code Execution bằng `/goal`; bắt đầu chụp baseline checkout trước production edit.
  - Verification: `bun install --frozen-lockfile`, typecheck, lint (0 error, 10 warning pre-existing trong `.temp-documents`), boundaries, 32 files/180 tests và production build đều exit 0 tại commit `f4c838b`.
  - Decisions: không có design drift; áp dụng nguyên Execution Contract đã khóa.
  - Blockers: không có.

2026-08-02 — Phase A complete, Phase B Task B.1
  - Files: [`package.json`, `bun.lock`, `packages/contracts/src/**`, `packages/mcp/**`, `packages/server/src/middleware/error-mapper.ts`, `scripts/verify-import-boundaries.mjs`, `tests/contracts/**`]
  - Summary: Hoàn tất 7/7 task Phase A; bắt đầu schema/migration hard gate Phase B.
  - Verification: focused MCP contracts 4/4; full suite 33 files/184 tests; frozen install, typecheck, lint (0 error), boundaries, build và `git diff --check` exit 0.
  - Decisions: revision test đối chiếu 5 legacy revisions với public SDK constant; modern `2026-07-28` được khóa riêng vì SDK 2.0.0 không public-export modern allowlist.
  - Blockers: không có.

2026-08-02 — Phase B complete, Phase C Task C.1
  - Files: [`packages/adapter/src/db/**`, `packages/adapter/drizzle/20260802070444_unusual_robbie_robertson/**`, `packages/adapter/src/fs/credential-store.ts`, `scripts/verify-schema-drift.mjs`, `tests/adapter/**`]
  - Summary: Hoàn tất 9/9 task Phase B: migration Phase-2 duy nhất, backfill legacy unresolved journal, rollback safety, SQLite file hardening và schema-drift guard; bắt đầu Core ports/domain models Phase C.
  - Verification: focused migration 1 file/5 tests; schema drift, typecheck, lint (0 error), boundaries, full suite 34 files/189 tests và production build đều exit 0.
  - Decisions: wrapper migrator tắt FK trước transaction rồi bật/kiểm lại sau migrate vì SQLite bỏ qua `PRAGMA foreign_keys = OFF` bên trong transaction; `migration.sql` được chỉnh tay đúng Execution Contract để backfill ordered step và giữ một Phase-2 artifact.
  - Blockers: không có.

2026-08-02 — Phase C complete, Phase D Task D.1
  - Files: [`packages/core/src/{domain,port,usecase}/**`, `packages/contracts/src/dto.ts`, `packages/adapter/src/fs/**`, `packages/adapter/src/hyperframes/**`, `tests/{adapter,contracts,core,golden,server}/**`]
  - Summary: Hoàn tất 7/7 task Phase C: SDK-neutral composite/grant/backup contracts, composite journal port extension, atomic delete, parse-source metadata, scene-removal patch và narration stale normalization; bắt đầu journal transaction primitives Phase D.
  - Verification: focused 4 files/60 tests; boundaries, typecheck, lint (0 error), full suite 34 files/193 tests, production build và `git diff --check` đều exit 0.
  - Decisions: dùng `CompositeMutationJournalPort extends MutationJournalPort` để contract composite bắt buộc mà không đưa placeholder vào adapter Phase 1 trước Phase D; source metadata được băm từ raw string ngay lượt parse và de-duplicate theo first-reference order.
  - Blockers: không có.

2026-08-02 — Phase D complete, Phase E Task E.1
  - Files: [`packages/adapter/src/db/journal.ts`, `packages/core/src/service/canonical-json.ts`, `tests/adapter/{composite-journal,lease-journal}.test.ts`]
  - Summary: Hoàn tất 9/9 task Phase D: T1, T2a/b/c, durable reads/gate, one-step dual-write facade và SQLite failure/concurrency coverage; bắt đầu Composite WriteAuthority hard gate Phase E.
  - Verification: focused 5 files/22 tests; full suite 35 files/201 tests; schema drift, typecheck, lint (0 error), boundaries, production build và `git diff --check` đều exit 0.
  - Decisions: expired reserve được lazy-persist bằng transaction result rồi mới throw; terminal commit retry bị từ chối trước insert nên không tạo revision/audit trùng; abort clear context/link còn commit/orphan giữ durable ownership.
  - Blockers: không có.

2026-08-02 — Phase E complete, Phase F Task F.1
  - Files: [`packages/core/src/service/write-authority.ts`, `tests/core/write-authority.test.ts`, `tests/adapter/composite-write-authority.test.ts`, `tests/e2e/foundation-milestone.test.ts`]
  - Summary: Hoàn tất 11/11 task Phase E: composite authority dưới lease/mutex/gate, precondition toàn cục, ordered apply/rollback/verify, T2 inline reconcile, one-step facade và real SQLite/filesystem failure coverage; bắt đầu pure recovery classifier Phase F.
  - Verification: focused write/concurrency 7 files/66 tests; full suite 36 files/217 tests; schema drift, typecheck, lint (0 error), boundaries, production build và `git diff --check` đều exit 0.
  - Decisions: one-step composite giữ nguyên `file.changed`/`project.changed`, revision kind, audit action và result shape của Phase 1; multi-step dùng `project.changed` với marker composite. T2 failure không rollback bytes đã landed và project gate chặn write kế tiếp.
  - Blockers: không có.

2026-08-02 — Phase F complete, Phase G Task G.1
  - Files: [`packages/core/src/service/composite-recovery.ts`, `packages/core/src/usecase/{reconcile-composite-mutation,resolve-orphaned-mutation}.ts`, `packages/adapter/src/db/journal.ts`, `packages/cli/src/{composition-root,startup}.ts`, `tests/{core,adapter}/**`]
  - Summary: Hoàn tất 9/9 task Phase F: hash classifier, deterministic terminal decision, per-journal startup recovery, exact grant/audit replay, project gate và hai admin resolution crash-safe; bắt đầu read-model Phase G.
  - Verification: focused recovery 3 files/25 tests và persistence matrix 9 tests; full suite 38 files/241 tests; schema drift, typecheck, lint (0 error), boundaries, production build và `git diff --check` đều exit 0.
  - Decisions: debug `step.status` không tham gia classifier; all-landed chỉ roll-forward, mixed mới rollback; admin resolution bypass gate đúng journal nhưng giữ gate nếu còn unresolved journal khác; invalidated grant không được revive khi accept/restore.
  - Blockers: không có.

2026-08-02 — Phase G complete, Phase H Task H.1
  - Files: [`packages/contracts/src/{dto,mcp}.ts`, `packages/core/src/{domain/models,usecase/project-reads}.ts`, `tests/{core,golden,contracts,server,adapter}/**`]
  - Summary: Hoàn tất 5/5 task Phase G: source metadata không thêm I/O, studio/MCP context có toàn bộ precondition và recovery, compact project/scene reads, bounded composition read và cache-safe recovery visibility; bắt đầu approval lifecycle Phase H.
  - Verification: focused read-model 6 files/62 tests; full suite 38 files/245 tests; schema drift, typecheck, lint (0 error), boundaries, production build và `git diff --check` đều exit 0.
  - Decisions: parse source hashes là nguồn fileHashes; recovery status luôn đọc live ngoài composition cache; read composition dùng resolve allowlist rồi stat size trước content; HTTP snapshot giữ field Phase 1 và thêm field canonical Phase 2.
  - Blockers: không có.

2026-08-02 — Phase H complete, Phase I Task I.1
  - Files: [`packages/core/src/service/approval-service.ts`, `packages/core/src/port/{ports,types}.ts`, `packages/adapter/src/db/approval-grants.ts`, `packages/mcp/src/registry/types.ts`, `packages/cli/src/{composition-root,startup}.ts`, `tests/{core,adapter,mcp}/**`]
  - Summary: Hoàn tất 7/7 task Phase H: deterministic request/issue/plan/revoke/cleanup lifecycle, Registry request-only capability, SQLite CAS và concurrency/retention coverage; bắt đầu backup store Phase I.
  - Verification: focused approval 3 files/29 tests; full suite 41 files/265 tests; schema drift, typecheck, lint (0 error), boundaries, production build và `git diff --check` đều exit 0.
  - Decisions: Registry chỉ nhận Pick request; issue/revoke nằm ở admin surface của composition root; T1 tiếp tục là reserve authority cuối; reserved grant không timeout và unresolved orphan giữ invalidated grant qua retention.
  - Blockers: không có.

2026-08-02 — Phase I, Task I.1 complete; Task I.2
  - Files: [`packages/adapter/src/fs/backup-store.ts`, `packages/adapter/src/index.ts`, `packages/core/src/port/ports.ts`, `tests/adapter/backup-store.test.ts`]
  - Summary: App-data layout đã được khóa theo project/backup ID; manifest canonical, entry sắp xếp ổn định, hash không chứa trường DB mutable và không công bố absolute source path. Bắt đầu atomic publication.
  - Verification: focused backup-store 1 file/6 tests; typecheck và lint (0 error, 10 warning pre-existing trong `.temp-documents`) exit 0.
  - Decisions: `revisionId` và `payloadPrunedAt` là metadata DB mutable nên không tham gia manifest hash hoặc immutable disk comparison.
  - Blockers: không có.

2026-08-02 — Phase I, Task I.2 complete; Task I.3
  - Files: [`packages/adapter/src/fs/backup-store.ts`, `tests/adapter/backup-store.test.ts`]
  - Summary: `create` ghi payload/manifest vào temp, fsync file và directory, verify toàn bộ hash trước atomic rename; mọi lỗi copy hoặc FK publication đều dọn temp/published directory. Bắt đầu read/integrity/scoping.
  - Verification: focused atomic-failure test 1/1 pass trên filesystem và SQLite thật.
  - Decisions: DB insert diễn ra sau rename; nếu transaction publication lỗi, catch dọn directory vừa publish nên không có public manifest không được DB quản lý.
  - Blockers: không có.

2026-08-02 — Phase I, Task I.3 complete; Task I.4
  - Files: [`packages/adapter/src/fs/backup-store.ts`, `tests/adapter/backup-store.test.ts`]
  - Summary: read/readPayloads/verify/list đã đối chiếu immutable manifest với DB, kiểm hash và byte size từng payload, phát hiện cả manifest/payload tamper và lọc list theo project. Bắt đầu retention/orphan cleanup.
  - Verification: focused integrity/scoping tests 2/2 pass trên filesystem và SQLite thật.
  - Decisions: read trả metadata mới nhất từ DB chỉ sau khi immutable disk manifest khớp; payload đã prune trả danh sách rỗng có chủ ý.
  - Blockers: không có.

2026-08-02 — Phase I, Task I.4 complete; Task I.5
  - Files: [`packages/adapter/src/fs/backup-store.ts`, `tests/adapter/backup-store.test.ts`]
  - Summary: retention xóa payload cũ theo strict cutoff nhưng giữ manifest/FK và ghi `payload_pruned_at`; orphan cleanup chỉ xóa directory không có DB row sau grace. Bắt đầu Core restoreBackup.
  - Verification: focused retention/grace-boundary tests 2/2 pass; toàn bộ backup-store 6/6 pass.
  - Decisions: directory có DB metadata luôn được giữ dù mtime cũ; orphan đúng cutoff 24 giờ chưa bị xóa.
  - Blockers: không có.

2026-08-02 — Phase I, Task I.5 complete; Task I.6
  - Files: [`packages/core/src/{port,usecase}/**`, `packages/core/src/service/write-authority.ts`, `packages/adapter/src/db/journal.ts`, `tests/core/restore-backup.test.ts`]
  - Summary: Core restore verify payload, đọc đúng destructive revision steps theo backup FK, dùng từng `to_hash` làm precondition, phục hồi file/entity/new-file trong một composite mới và persist audit `cli:restore` trước I/O. Bắt đầu production wiring/retention startup.
  - Verification: typecheck exit 0; focused restore/journal/authority 3 files/37 tests pass.
  - Decisions: thêm read-only journal seam `(backupId, revisionId)` vì BackupPort chỉ sở hữu payload; command audit dùng cột durable context hiện có nhưng giữ shape tool-audit cũ để không phá recovery/backfill.
  - Blockers: không có.

2026-08-02 — Phase I, Task I.6 complete; Task I.7
  - Files: [`packages/cli/src/{composition-root,startup}.ts`, `tests/cli/startup.test.ts`]
  - Summary: Production root đã inject AppDataBackupStore vào WriteAuthority; startup prune payload 30 ngày và cleanup orphan sau 24 giờ trong reconciliation gate, trước job/scheduler/watcher/listener. Bắt đầu hoàn thiện failure matrix filesystem.
  - Verification: startup 14/14, typecheck và lint (0 error, 10 warning pre-existing) exit 0; listener test quan sát payload/orphan đã được cleanup trước khi mở.
  - Decisions: retention và grace có config milliseconds trên CompositionRootConfig, default theo spec; mọi lỗi cleanup đi qua StartupError(reconciliation) nên listener không mở.
  - Blockers: không có.

2026-08-02 — Phase I, Task I.7 complete; Task I.8
  - Files: [`packages/adapter/src/fs/backup-store.ts`, `tests/adapter/backup-store.test.ts`]
  - Summary: Real filesystem matrix phủ failure injection temp/fsync/verify/rename, manifest/payload tamper, project scoping, strict prune cutoff và orphan 24-hour grace. Bắt đầu end-to-end restore trên SQLite/filesystem thật.
  - Verification: backup-store 9/9 pass; typecheck exit 0.
  - Decisions: inject ba operation seam tối thiểu trong constructor; production defaults vẫn gọi fsync/rename Node thật, test chỉ thay đúng failure point còn mọi file/SQLite I/O là thật.
  - Blockers: không có.

2026-08-02 — Phase I complete, Phase J Task J.1
  - Files: [`packages/{core,adapter,cli}/src/**`, `tests/{core,adapter,cli}/**`]
  - Summary: Hoàn tất 8/8 task Phase I: atomic backup store, retention/orphan cleanup, Core restore, durable CLI audit và production wiring; bắt đầu composite createScene Phase J.
  - Verification: focused restore 1 file/3 tests; full Vitest 44 files/282 tests; schema drift, typecheck, lint (0 error), boundaries, production build và `git diff --check` exit 0.
  - Decisions: restore lấy precondition từ revision_step theo exact backup/revision FK; payload prune giữ manifest/revision links; command audit durable dùng cùng journal context nhưng không đổi legacy tool-audit shape.
  - Blockers: không có. Lệnh `bun test` trực tiếp không thuộc Verification Matrix và dùng Bun runner thiếu `node:sqlite`; command chuẩn `bun run test` (Vitest) đã pass 282/282.

2026-08-02 — Phase J, Task J.1 complete; Task J.2
  - Files: [`packages/core/src/usecase/project-writes.ts`, `packages/server/src/routes/project-writes.ts`, `tests/core/project-usecases.test.ts`]
  - Summary: createScene ghi scene source, entry mount và narration sidecar trong đúng một composite; entry hash do caller cung cấp, durable WriteInvocation truyền nguyên vẹn và output trả scene/project/envelope. Bắt đầu setSceneTiming output/audit cutover.
  - Verification: focused createScene 1/1; affected Core/server/E2E 3 files/37 tests; typecheck và diff check exit 0.
  - Decisions: legacy HTTP route đọc entry hash rồi truyền explicit precondition; không giữ chuỗi ba mutation cũ.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.2 complete; Task J.3
  - Files: [`packages/core/src/usecase/project-writes.ts`, `tests/core/project-usecases.test.ts`]
  - Summary: setSceneTiming giữ file hash precondition/domain validation, forward WriteInvocation và trả SceneContext/ProjectSummary/WriteEnvelope đầy đủ. Bắt đầu atomic narration-stale update cho set_text.
  - Verification: Core/server focused 2 files/36 tests; typecheck exit 0.
  - Decisions: one-step vẫn đi qua `mutate(..., invocation)` để giữ audit action/file semantics Phase 1, envelope được dựng từ kết quả authority.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.3 complete; Task J.4
  - Files: [`packages/core/src/usecase/project-writes.ts`, `tests/core/project-usecases.test.ts`]
  - Summary: setSceneScript cập nhật source và narration `staleSince` trong một composite, giữ generated payload, không chạy TTS, forward durable tool audit và trả output canonical. Bắt đầu harden saveSourceFile.
  - Verification: Core/server focused 2 files/36 tests; typecheck exit 0.
  - Decisions: scene không có narration vẫn là một-step composite; scene có narration bắt buộc sidecar hợp lệ để tránh commit source mà stale marker thất bại.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.4 complete; Task J.5
  - Files: [`packages/core/src/usecase/project-writes.ts`, `packages/server/src/routes/project-writes.ts`, `tests/{core,server,e2e}/**`]
  - Summary: saveSourceFile kiểm UTF-8 byte limit và protected/path allowlist trước authority, forward invocation, trả hash/envelope; HTTP V1 map về response cũ. Bắt đầu pure scene deletion planner.
  - Verification: affected Core/server/E2E 4 files/40 tests; typecheck exit 0.
  - Decisions: canonical Core output không mang content; HTTP boundary bổ sung lại request content để giữ Phase-1 API contract.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.5 complete; Task J.6
  - Files: [`packages/core/src/usecase/scene-deletion.ts`, `tests/core/scene-deletion.test.ts`]
  - Summary: Pure planner khóa 6 edge case: unique/shared source, inline, latest duration, last scene=0 warning, narration và preview cleanup; digest dùng canonical JSON. Bắt đầu I/O prepare/binding.
  - Verification: planner/digest 7/7; typecheck exit 0.
  - Decisions: digest nhận injected hashContent để Core không import Node crypto; entry source là nguồn đầu tiên theo parser first-read invariant.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.6 complete; Task J.7
  - Files: [`packages/core/src/usecase/scene-deletion.ts`, `tests/core/scene-deletion.test.ts`]
  - Summary: prepareSceneDeletion thu thập live model/settings/narration hashes, khóa project revision và dựng exact GrantBinding từ pure plan. Bắt đầu destructive execution.
  - Verification: planner/prepare 9/9; typecheck exit 0.
  - Decisions: settings entity hash lấy từ journal state; narration JSON/WAV resolve theo capability riêng; binding không do Registry tự dựng.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.7 complete; Task J.8
  - Files: [`packages/core/src/{domain/models,port/types,service/write-authority,usecase/scene-deletion}.ts`, `packages/adapter/src/hyperframes/sdk-ops.ts`, `tests/core/scene-deletion.test.ts`]
  - Summary: deleteScene re-plan, bind grant, sửa entry/root, xoá unique source+narration, patch settings và tạo verified backup trong một composite; output có project/envelope/backup ID. Bắt đầu file deletion prepare.
  - Verification: scene deletion + HyperFrames focused 3 files/17 tests; typecheck exit 0.
  - Decisions: CompositeRequest nhận diagnostics optional để last-scene warning đi cùng revision; mutateComposite surface backupId nội bộ rồi delete use case tách khỏi strict envelope.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.8 complete; Task J.9
  - Files: [`packages/core/src/usecase/file-deletion.ts`, `tests/core/file-deletion.test.ts`]
  - Summary: prepareFileDeletion khóa allowlist/protected/hash/reference/latest revision và dựng canonical plan/binding không ghi. Bắt đầu grant-bound execution.
  - Verification: file deletion planner 4/4; typecheck exit 0.
  - Decisions: reference scan phủ scene src, media src/url và element src; protected path bị chặn trước resolve/read.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.9 complete; Task J.10
  - Files: [`packages/core/src/usecase/file-deletion.ts`, `tests/core/file-deletion.test.ts`]
  - Summary: deleteFile chỉ nhận plan đã duyệt, re-plan exact, reserve grant qua T1, backup trước delete và trả one-revision envelope/backup ID. Bắt đầu aggregate unit matrix Phase J.
  - Verification: file prepare/delete 6/6; typecheck exit 0.
  - Decisions: caller-modified plan bị approval_invalid trước authority; binding mới từ live re-plan là đối tượng T1 so với grant durable.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.10 complete; Task J.11
  - Files: [`tests/core/{project-usecases,scene-deletion,file-deletion,invariants}.test.ts`]
  - Summary: Unit matrix phủ create composite plan/audit, narration stale, timing/save error, 6 scene-delete edge, reference safety và last-scene warning. Bắt đầu real SQLite/filesystem integration.
  - Verification: 4 files/54 tests pass; typecheck exit 0.
  - Decisions: invalid timing được kiểm ở use-case boundary ngoài pure invariant test để chứng minh không gọi authority.
  - Blockers: không có.

2026-08-02 — Phase J, Task J.11 complete; Task J.12
  - Files: [`tests/adapter/project-destructive-usecases.test.ts`]
  - Summary: Real production adapters chứng minh create atomic 3-step, one-step/composite audit cùng revision, full scene cleanup một revision, verified backup và later-edit restore conflict. Bắt đầu crash/failure matrix.
  - Verification: real SQLite/filesystem integration 2/2; typecheck exit 0.
  - Decisions: fixture dùng CompositionHf thật và issued grant qua ApprovalService/SQLite, không bypass T1.
  - Blockers: không có.

2026-08-02 — Phase J complete; Phase K, Task K.1
  - Files: [`packages/core/src/usecase/{project-writes,scene-deletion,file-deletion}.ts`, `packages/core/src/{domain/models,port/types,service/write-authority}.ts`, `packages/adapter/src/hyperframes/sdk-ops.ts`, `apps/web/src/server/http-v1.ts`, `tests/{core,adapter}/**`]
  - Summary: Hoàn tất 12/12 task Phase J: write use cases trả canonical envelope, scene/file deletion có deterministic plan + approval binding + verified backup, và crash matrix chứng minh terminal/recovery outcome không audit kép. Bắt đầu canonical audit redaction/serialization Phase K.
  - Verification: schema drift, typecheck, lint (0 errors), boundaries, 47 files/306 tests, production build và git diff check đều exit 0.
  - Decisions: HTTP V1 map canonical Core output về response cũ để giữ compatibility; destructive output tách backup ID khỏi strict WriteEnvelope; diagnostics được commit cùng revision.
  - Blockers: không có.

2026-08-02 — Phase K, Task K.1 complete; Task K.2
  - Files: [`packages/core/src/service/tool-audit-service.ts`, `packages/core/src/index.ts`, `tests/core/tool-audit-policy.test.ts`]
  - Summary: Canonical policy redacts secret/raw content và POSIX/Windows/UNC absolute path đệ quy; pending audit schema v1 có normalize/serialize/parse tại persistence boundary. Bắt đầu audit service retry/escalation.
  - Verification: focused audit policy 6/6; typecheck và git diff check exit 0.
  - Decisions: credentialId/grantId/backupId là non-secret identifier được giữ; các field content/text/script/prompt và credential material bị thay bằng sentinel ổn định.
  - Blockers: không có.

2026-08-02 — Phase K, Task K.2 complete; Task K.3
  - Files: [`packages/core/src/{port/types,port/ports,service/tool-audit-service}.ts`, `tests/core/tool-audit-policy.test.ts`]
  - Summary: ToolAuditService chuẩn bị write context và ghi read/pre-T1 failure fail-open; repository failure được retry đúng một lần rồi warn/error + counter theo policy. Bắt đầu terminal journal/audit persistence wiring.
  - Verification: focused audit policy 10/10; typecheck và focused lint exit 0.
  - Decisions: Core phụ thuộc ToolAuditPort nhỏ; timestamp do ClockPort inject; retry-success có metric riêng còn user outcome không bị audit store thay đổi.
  - Blockers: không có.

2026-08-02 — Phase K, Task K.3 complete; Task K.4
  - Files: [`packages/adapter/src/db/{journal,tool-audit}.ts`, `packages/adapter/src/index.ts`, `tests/adapter/{composite-journal,tool-audit-persistence}.test.ts`]
  - Summary: Tool read/pre-T1 row được ghi vào SQLite app-data; journal enrich grant/backup và T2 success/T2c orphan ghi terminal tool row với protocol/credential/invocation cùng revision khi có. Bắt đầu ownership decision theo invocation.
  - Verification: focused Core+SQLite audit 3 files/21 tests; typecheck và focused lint exit 0.
  - Decisions: journal áp canonical serializer tại T1/attachBackup; audit created_at giữ invokedAt durable; command audit không bị ép qua tool schema.
  - Blockers: không có.

2026-08-02 — Phase K, Task K.4 complete; Task K.5
  - Files: [`packages/core/src/service/tool-audit-service.ts`, `tests/core/tool-audit-policy.test.ts`]
  - Summary: Ownership được quyết theo invocation ID; journal-owned không ghi thêm, caller-owned mới recordFailure, lookup lỗi trả unknown và chỉ error log + metric. Bắt đầu khóa semantics T2a/T2b/T2c/recovery.
  - Verification: focused audit policy 13/13; typecheck exit 0.
  - Decisions: recordFailureIfCallerOwned bao trọn decision để Registry không thể vô tình coi lookup exception là caller-owned.
  - Blockers: không có.

2026-08-02 — Phase K, Task K.5 complete; Task K.6
  - Files: [`packages/adapter/src/db/journal.ts`, `tests/adapter/{composite-journal,composite-recovery-persistence}.test.ts`]
  - Summary: T2a/rollback verified clear context nên caller-owned; committed, recovered và orphaned giữ durable invocation ownership, terminal retry không tạo row kép. Bắt đầu chốt unit policy matrix.
  - Verification: focused ownership/recovery 3 files/32 tests; typecheck exit 0.
  - Decisions: terminal journal giữ redacted context như ownership tombstone; chỉ T2a/T2 rollback đã chứng minh filesystem sạch mới clear.
  - Blockers: không có.

2026-08-02 — Phase K, Task K.6 complete; Task K.7
  - Files: [`tests/core/tool-audit-policy.test.ts`]
  - Summary: Unit matrix khóa canonical redaction/schema, read fail-open, retry đúng một lần, failure escalation, journal/caller/unknown ownership và không ghi phỏng đoán. Bắt đầu real SQLite failure injection.
  - Verification: focused audit policy 13/13 exit 0.
  - Decisions: K.6 tái dùng cùng fake ports với service contract, không mock implementation nội bộ.
  - Blockers: không có.

2026-08-02 — Phase K, Task K.7 complete; Task K.8
  - Files: [`tests/adapter/tool-audit-persistence.test.ts`]
  - Summary: SQLite trigger injection chứng minh terminal audit fail làm rollback toàn T2 và giữ journal indeterminate; retry tạo đúng one-step tool row cùng revision; T2a handoff và orphan terminal không audit kép. Bắt đầu index/relation/retention verification.
  - Verification: focused Core+SQLite audit 2 files/17 tests; typecheck exit 0.
  - Decisions: failure injection đặt tại INSERT tool audit để chứng minh revision, mutation audit và journal terminal transition cùng rollback transaction.
  - Blockers: không có.

2026-08-02 — Phase K complete; Phase L, Task L.1
  - Files: [`packages/core/src/{port/types,port/ports,service/tool-audit-service}.ts`, `packages/adapter/src/db/{journal,tool-audit}.ts`, `tests/core/tool-audit-policy.test.ts`, `tests/adapter/{tool-audit-persistence,composite-journal,backup-restore}.test.ts`]
  - Summary: Hoàn tất 8/8 task Phase K: canonical redaction, retry/escalation, durable T1→T2/T2c audit, ownership decision và SQLite failure/index/retention evidence. Bắt đầu deterministic Tool Registry Phase L.
  - Verification: focused 4 files/31 tests; full 49 files/324 tests; schema drift, typecheck, lint, boundaries, build và diff check đều exit 0.
  - Decisions: existing audit indexes đủ theo design không đổi cấu trúc; query planner chọn idx_audit_action; tool→revision→mutation được chứng minh bằng join cùng revision FK.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.1 complete; Task L.2
  - Files: [`packages/mcp/src/registry/{types,registry}.ts`, `packages/mcp/src/index.ts`, `tests/mcp/registry.test.ts`]
  - Summary: ToolDefinition/Context/Descriptor là single source; annotations bị derive từ level, registration chống trùng, list sort/filter era và output strict validation. Bắt đầu invoke pipeline/audit forwarding.
  - Verification: focused Registry 4/4; typecheck exit 0.
  - Decisions: annotations caller truyền vào bị canonicalize lúc register nên metadata không thể hạ mức destructive; transport chỉ nhận descriptor, không nhận handler internals.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.2 complete; Task L.3
  - Files: [`packages/mcp/src/registry/{types,registry}.ts`, `packages/core/src/service/tool-audit-service.ts`, `tests/mcp/registry.test.ts`]
  - Summary: Invoke pipeline strict-validate, derive scope/grant, tạo một pending audit, forward WriteInvocation, validate output và áp read/write ownership policy; không import HTTP. Bắt đầu tool list_projects.
  - Verification: Registry + audit policy 2 files/21 tests; typecheck và focused lint exit 0.
  - Decisions: write success chỉ được trả khi durable journal còn ownership tombstone; transport context không thể cung cấp actor/invocation/write audit.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.3 complete; Task L.4
  - Files: [`packages/mcp/src/registry/read-tools.ts`, `packages/mcp/src/index.ts`, `tests/mcp/registry.test.ts`]
  - Summary: list_projects dùng bounded Core context, trả projectId/dimensions/duration/revision/recovery, read annotations và mô tả chỉ dẫn scope kế tiếp. Bắt đầu context/list scenes.
  - Verification: Registry focused 9/9; typecheck exit 0.
  - Decisions: tool dùng listProjectContexts thay vì legacy listProjects để không lộ workspace root và luôn có recovery gate.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.4 complete; Task L.5
  - Files: [`packages/mcp/src/registry/read-tools.ts`, `tests/mcp/registry.test.ts`]
  - Summary: get_project_context và list_scenes dùng shared compact SceneContext, luôn trả hash/revision/recovery; full context thêm diagnostics/settings/fileHashes. Bắt đầu bounded read_composition.
  - Verification: Registry focused 11/11; runtime tests pass, type mismatch rootTrack được khóa bằng output schema parse tại handler boundary.
  - Decisions: output use-case được parse ngay trong factory và Registry parse lần cuối; đây là defense-in-depth ở Core→MCP schema boundary.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.5 complete; Task L.6
  - Files: [`packages/mcp/src/registry/read-tools.ts`, `tests/mcp/registry.test.ts`]
  - Summary: read_composition gọi bounded Core use case, mô tả rõ project-relative allowlist, size rejection, content hash và recovery. Bắt đầu create/timing write tools.
  - Verification: Registry focused 12/12; typecheck và focused lint exit 0.
  - Decisions: Registry không đọc filesystem hay map lỗi đường dẫn; Core giữ capability/path policy, tool chỉ sở hữu schema và mô tả.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.6 complete; Task L.7
  - Files: [`packages/mcp/src/registry/write-tools.ts`, `packages/mcp/src/index.ts`, `tests/mcp/registry.test.ts`]
  - Summary: create_scene/set_scene_timing có strict precondition schemas, canonical output và forward nguyên WriteInvocation vào Core atomic use cases. Bắt đầu set_text/save_file.
  - Verification: Registry focused 14/14; typecheck và focused lint exit 0.
  - Decisions: timing input phẳng được map duy nhất ở handler sang Core timing patch; Registry không nhân đôi domain validation.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.7 complete; Task L.8
  - Files: [`packages/mcp/src/registry/write-tools.ts`, `tests/mcp/registry.test.ts`]
  - Summary: set_text/save_file forward WriteInvocation, expose narration stale/no-TTS và allowlist/protected/size/hash behavior trong public descriptions. Bắt đầu delete_scene approval/MRTR flow.
  - Verification: Registry focused 16/16; typecheck exit 0.
  - Decisions: raw text/content chỉ tồn tại trong strict input và được ToolAuditService redact trước durable context; handler không tự ghi audit.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.8 complete; Task L.9
  - Files: [`packages/mcp/src/registry/{types,registry,destructive-tools}.ts`, `packages/mcp/src/index.ts`, `tests/mcp/registry.test.ts`]
  - Summary: delete_scene plan trước khi request, tạo đúng một approval request; modern phát InputRequiredSignal với requestState, legacy trả approval_required có requestId/hướng dẫn retry; có grant thì Core re-plan. Bắt đầu delete_file.
  - Verification: Registry focused 19/19; focused lint exit 0; typecheck sau brand fixture correction.
  - Decisions: input-required là protocol-neutral control signal, chỉ transport Phase M map sang MRTR; Registry không import SDK transport.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.9 complete; Task L.10
  - Files: [`packages/mcp/src/registry/destructive-tools.ts`, `tests/mcp/registry.test.ts`]
  - Summary: delete_file plan/reference-check trước approval, hỗ trợ dual-era request, re-plan live khi có grant, và trả deleted/envelope/backupId từ Core. Bắt đầu khóa descriptor/schema toàn bộ 10 tools.
  - Verification: Registry focused 20/20; typecheck và focused lint exit 0.
  - Decisions: prepareFileDeletion chạy trước mọi request để không xin duyệt target stale/referenced; execution vẫn re-plan lần nữa trong deleteFile.
  - Blockers: không có.

2026-08-02 — Phase L, Task L.10 complete; Task L.11
  - Files: [`packages/mcp/src/registry/all-tools.ts`, `packages/mcp/src/index.ts`, `tests/mcp/registry.test.ts`]
  - Summary: Central registration phủ đúng 10 tools; inline descriptor contract khóa exact metadata/annotations/order, cả modern và legacy cùng visibility theo spec. Bắt đầu invoke coverage/forwarding guard.
  - Verification: Registry focused 21/21; typecheck exit 0; registry lint sạch sau loại bỏ unused destructuring.
  - Decisions: deterministic list sort theo name độc lập registration order; schema object giữ nguyên identity từ contracts để transport không tái khai báo.
  - Blockers: không có.

2026-08-02 — Phase L complete; Phase M, Task M.1
  - Files: [`packages/mcp/src/registry/**`, `packages/core/src/service/tool-audit-service.ts`, `tests/mcp/{registry,tools}.test.ts`]
  - Summary: Hoàn tất 11/11 task Phase L: 10 single-source definitions, strict invoke/audit pipeline, dual-era approval control signal, exact descriptor contract và handler/forwarding coverage guard. Bắt đầu shared SDK server factory Phase M.
  - Verification: focused 2 files/23 tests; full 51 files/347 tests; typecheck, lint (0 errors), boundaries, schema drift, build và diff check exit 0 sau final fixture brand fix.
  - Decisions: all-tools registration là public composition seam duy nhất; transports Phase M chỉ consume Registry descriptors/invoke, không lặp schema/handlers.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.1 complete; Task M.2
  - Files: [`packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`, `tests/mcp/server-factory.test.ts`]
  - Summary: Factory dùng identity `vidcom-mcp-server` với version đọc trực tiếp từ package; đúng một register function map Registry descriptors/invoke cho cả hai era và mọi transport, còn initialize/discover/result projection thuộc SDK. Bắt đầu legacy stdio path.
  - Verification: server-factory focused 1/1; typecheck, lint (0 errors, 10 warning có sẵn) và diff check exit 0.
  - Decisions: modern audit revision đọc qua SDK envelope key; legacy đọc negotiated revision từ SDK server accessor. Root test chỉ dùng public structural behavior để giữ runtime SDK dependency nằm trong `@vidcom/mcp`.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.2 complete; Task M.3
  - Files: [`packages/mcp/src/stdio.ts`, `packages/mcp/src/index.ts`, `tests/mcp/fixtures/stdio-server.ts`, `tests/mcp/legacy-transport.test.ts`]
  - Summary: `serveStdio` mặc định legacy serve, cùng factory/Registry; client SDK 1.30 thật negotiate, list/call tool, nhận result không có modern fields và đóng child sạch. Bắt đầu legacy stateless HTTP.
  - Verification: legacy stdio focused 1/1; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: stdout không có application log; lỗi ngoài băng chỉ đi qua callback stderr. Resource-not-found code split được khóa tại shared era-aware mapper M.7 theo Dependency Order, không tự chèn transport ladder ở M.2.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.3 complete; Task M.4
  - Files: [`packages/mcp/src/http.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`, `tests/mcp/{support,legacy-transport}.ts`, `tests/mcp/fixtures/stdio-server.ts`]
  - Summary: Entry HTTP dùng `createMcpHandler` stateless legacy mặc định; SDK 1.30 thật list/call cùng Registry, raw POST không version được SDK default, GET/DELETE trả 405 và handler close sạch. Bắt đầu modern stdio/HTTP.
  - Verification: legacy transport focused 1 file/2 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: stateless HTTP lấy exact audit revision từ SDK request header hoặc `DEFAULT_NEGOTIATED_PROTOCOL_VERSION`; SSE/JSON response shaping giữ nguyên theo SDK, test không tự áp đặt parser server.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.4 complete; Task M.5
  - Files: [`packages/mcp/src/server.ts`, `tests/mcp/{support,modern-transport}.ts`]
  - Summary: Modern client v2 thật chạy stdio + HTTP, discover identity/supported version, complete result/cache private, header mismatch và MRTR input_required→elicitation→retry thành công qua cùng Registry. Bắt đầu exact pinned HTTP wrapper.
  - Verification: modern focused 2/2; combined Phase M 3 files/5 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: transport chỉ merge `grantId` đã type-check sơ bộ từ accepted input response; strict tool input schema và Core grant validation vẫn là authority. SDK tự stamp serverInfo/result/cache và tự drive MRTR.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.5 complete; Task M.6
  - Files: [`packages/mcp/src/http.ts`, `tests/mcp/revision-pin.test.ts`]
  - Summary: Handler map có entry, sáu exact revisions và moving latest alias; mỗi pin dùng factory allowlist cùng SDK classifier, exact same-era compare, invalid JSON delegation, batch default và initialize-body classification. Bắt đầu pinned stdio.
  - Verification: revision-pin focused 4/4; combined Phase M 4 files/9 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: classifier rejection được delegate nguyên cho SDK; wrapper chỉ tự materialize `UnsupportedProtocolVersionError` khi classification hợp lệ nhưng revision khác exact pin. Unsupported data luôn liệt kê toàn bộ shared allowlist.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.6 complete; Task M.7
  - Files: [`packages/mcp/src/stdio.ts`, `tests/mcp/fixtures/stdio-server.ts`, `tests/mcp/revision-pin.test.ts`]
  - Summary: Stdio pin thu hẹp factory allowlist; modern exact pin đồng thời dùng SDK `legacy: reject`, unpinned/legacy giữ negotiation SDK. Test modern pin thành công và legacy opening bị từ chối -32022. Bắt đầu shared error mapper.
  - Verification: revision-pin focused 5/5; combined Phase M 4 files/10 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: server SDK export `LATEST_PROTOCOL_VERSION` vẫn mang nghĩa legacy latest, nên modern boundary lấy `SUPPORTED_REVISIONS[0]` từ shared contracts. Edge modern-only allowlist cần `legacy: reject` để tránh SDK initialize fallback về legacy latest.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.7 complete; Task M.8
  - Files: [`packages/mcp/src/error-map.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`, `tests/mcp/error-map.test.ts`]
  - Summary: Một exhaustive mapper phủ mọi ErrorCode, resource miss split legacy -32002/modern -32602, infra/recovery -32603, conflict/approval detail và recovery no-blind-retry guidance; server callback dùng canonical tool error. Bắt đầu khóa full legacy contract.
  - Verification: error-map focused 3/3; combined Phase M 5 files/13 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: McpServer high-level API chuẩn hóa handler failure thành CallToolResult `isError`; numeric MCP category được giữ machine-readable trong `io.vidcom/error` metadata và JSON text. Unsupported endpoint vẫn dùng SDK `UnsupportedProtocolVersionError` thực sự.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.8 complete; Task M.9
  - Files: [`tests/mcp/{support,legacy-transport}.ts`, `tests/mcp/fixtures/stdio-server.ts`]
  - Summary: Legacy SDK 1.30 contract phủ stdio + stateless HTTP, no-header default, absence của mọi modern field, Registry list/call, actual -32002 resource tool error và stdout/stderr/child close cleanliness. Bắt đầu full modern contract.
  - Verification: legacy focused 2/2; không có skipped test.
  - Decisions: probe error chạy qua cùng Registry/server callback, không gọi mapper trực tiếp; wire projection khác nhau giữa legacy revisions được assert theo canonical text thay vì giả định structuredContent luôn có.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.9 complete; Task M.10
  - Files: [`tests/mcp/{support,modern-transport}.ts`]
  - Summary: Modern client 2.0 contract phủ stdio + HTTP discover identity, supportedVersions, complete/input_required resultType, cache private, exact requestState MRTR retry, -32020 header mismatch và actual -32602 resource tool error. Bắt đầu full exact-pin matrix.
  - Verification: modern focused 2/2; combined legacy+modern 2 files/4 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: wire fields được assert từ captured raw HTTP response, không từ client neutral model vốn đã strip codec-only members.
  - Blockers: không có.

2026-08-02 — Phase M, Task M.10 complete; Task M.11
  - Files: [`tests/mcp/revision-pin.test.ts`]
  - Summary: Exact-pin matrix phủ entry, sáu revision handlers, latest identity alias, legacy same-era mismatch, valid-envelope unknown revision, invalid JSON delegation, legacy batch, modern exact HTTP/stdio và canonical echo result đồng nhất. Bắt đầu mở rộng golden gate.
  - Verification: Phase M transport command 3 files/11 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: unknown modern revision fixture mang envelope/headers hợp lệ để chạm đúng unsupported rung; request thiếu envelope đúng ra bị -32602 trước revision check và không được test sai thành -32022.
  - Blockers: không có.

2026-08-02 — Phase M complete; Phase N, Task N.1
  - Files: [`package.json`, `packages/mcp/src/{server,http,stdio,error-map,index}.ts`, `tests/mcp/{server-factory,legacy-transport,modern-transport,revision-pin,error-map,support}.ts`, `tests/mcp/fixtures/stdio-server.ts`]
  - Summary: Hoàn tất 11/11 Phase M và 3/3 AC: một SDK factory/Registry cho era×transport, exact HTTP/stdio pin, MRTR/cache/error mapping và root golden gate đã bao gồm MCP. Bắt đầu credential issue N.1.
  - Verification: transport 3 files/11 tests; full 56 files/362 tests; golden 5 files/18 tests; schema drift, typecheck, lint (0 errors), boundaries, build và diff check exit 0.
  - Decisions: transport không tự viết initialize/discover/result projection; exact wrapper chỉ dùng SDK classifier/allowlist và modern stdio pin dùng legacy reject để khóa fallback edge.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.1 complete; Task N.2
  - Files: [`packages/core/src/{port/ports,service/mcp-credential-service,index}.ts`, `packages/adapter/src/{db/mcp-credential,runtime/mcp-credential-crypto,index}.ts`, `tests/adapter/mcp-credential.test.ts`]
  - Summary: Credential issue sinh đúng 32 CSPRNG bytes, encode `vcmcp_` base64url, lưu duy nhất canonical SHA-256 digest và trả plaintext đúng tại issuance boundary. Bắt đầu verify constant-shape/lazy expiry.
  - Verification: focused credential 1 file/3 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: Core chỉ phụ thuộc `McpCredentialCryptoPort`; Node adapter sở hữu random/hash/timing-safe primitive. Repository chỉ nhận `McpCredentialRecord`, nên plaintext không thể đi qua persistence seam.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.2 complete; Task N.3
  - Files: [`packages/core/src/service/mcp-credential-service.ts`, `packages/adapter/src/{db/mcp-credential,runtime/mcp-credential-crypto}.ts`, `tests/adapter/mcp-credential.test.ts`]
  - Summary: Verify từ chối shape sai trước hash, lookup canonical digest, timing-safe compare trong process, chấp nhận active/unexpired rotating và lazy-revoke đúng boundary `expiresAt <= now`. Bắt đầu rotate/revoke/list.
  - Verification: focused credential 1 file/5 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: Core chỉ trả `{id}` hoặc `null`, không phân biệt malformed/unknown/revoked/expired; HTTP middleware N.4 sẽ map mọi `null` thành cùng `credential_invalid`.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.3 complete; Task N.4
  - Files: [`packages/core/src/service/mcp-credential-service.ts`, `packages/adapter/src/db/mcp-credential.ts`, `tests/adapter/mcp-credential.test.ts`]
  - Summary: Rotate tạo credential/id mới, nối `rotatedFrom`, CAS credential cũ sang rotating với overlap mặc định 5 phút hoặc override; revoke immediate và list chỉ trả metadata. Bắt đầu bearer middleware.
  - Verification: focused credential 1 file/7 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: rotate thất bại không trả secret chưa persist; repository ghép old transition và replacement insert trong một SQLite transaction. Revoke replay dùng cùng lỗi `credential_invalid`.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.4 complete; Task N.5
  - Files: [`packages/server/src/middleware/perimeter.ts`, `tests/server/mcp-security.test.ts`]
  - Summary: `mcpBearerAuth` parse đúng một Bearer value, verify qua structural service, đặt duy nhất credentialId vào typed Hono context; missing/cookie/wrong-scheme/invalid đều cùng 401 credential_invalid. Bắt đầu tách auth branch trong app.
  - Verification: focused MCP security 1 file/5 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: middleware chỉ biết verifier interface, không import Core service/Adapter/MCP. Stdio không đi qua Hono và vì vậy không bị thêm bearer contract.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.5 complete; Task N.6
  - Files: [`packages/server/src/app.ts`, `packages/server/src/listener.ts`, `tests/server/{mcp-security,security}.test.ts`]
  - Summary: Hono auth branch chạy sau Host/CORS và trước body; `/api/mcp*` luôn bearer, mọi route khác giữ session auth. Listener nhận structural fetch app để typed Hono context không rò type coupling. Bắt đầu structural MCP mount.
  - Verification: focused MCP + existing security 2 files/20 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: khi chưa inject credential verifier, MCP branch deny-by-default thay vì rơi về browser session. Host và hostile Origin dừng trước verify đúng perimeter order.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.6 complete; Task N.7
  - Files: [`packages/server/src/{app,routes/mcp,index}.ts`, `packages/mcp/src/http.ts`, `tests/server/mcp-security.test.ts`]
  - Summary: Structural `McpRouteDependencies` mount entry, exact revisions và latest; verified credentialId được pass bằng SDK authInfo không mang bearer plaintext. MCP map tự cung cấp unsupported fallback nhưng vẫn enumerate đúng canonical keys. Bắt đầu hoàn chỉnh credential test matrix.
  - Verification: focused server mount + revision pin 2 files/14 tests; typecheck, lint (0 errors), boundary checker và diff check exit 0.
  - Decisions: server không import MCP/SDK và chỉ dispatch structural handler. Lệnh `check:boundaries` không tồn tại nên dừng ở script lookup; chạy lại đúng root script `test:boundaries` exit 0.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.7 complete; Task N.8
  - Files: [`tests/core/mcp-credential-service.test.ts`, `tests/adapter/mcp-credential.test.ts`]
  - Summary: Unit + real SQLite matrix phủ one-time secret seam, CSPRNG 32 byte, canonical hash/unique, active/rotating/revoked, exact overlap, lazy expiry, rotate rollback và list không secret. Bắt đầu full Hono app.request security matrix.
  - Verification: credential matrix 2 files/12 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: test rollback cố ý gây unique-digest failure trong replacement insert và xác nhận transaction phục hồi credential cũ về active, không để replacement row.
  - Blockers: không có.

2026-08-02 — Phase N, Task N.8 complete; Task N.9
  - Files: [`tests/server/mcp-security.test.ts`, `tests/mcp/support.ts`]
  - Summary: Full `app.request()` matrix khóa uniform 401, cookie rejection, Host/CORS/auth/body order, entry/exact/latest dispatch, credentialId trong Registry audit và SDK-owned GET/DELETE 405. Bắt đầu real listener concurrency.
  - Verification: MCP app + existing browser security 2 files/25 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: audit assertion chạy qua raw JSON-RPC tools/call và ToolRegistry thật; không gọi context/audit service trực tiếp. Logs và serialized audit đều không chứa bearer.
  - Blockers: không có.

2026-08-02 — Phase N complete; Phase O, Task O.1
  - Files: [`tests/server/mcp-listener.test.ts`, Phase N credential/Core/Adapter/Hono/MCP files]
  - Summary: Real loopback listener phục vụ entry/pinned/latest, perimeter Host/CORS/body, SDK 1.30 + 2.0 đồng thời và clean close. Hoàn tất 9/9 Phase N cùng 3/3 AC; bắt đầu CLI strict dispatch.
  - Verification: Phase N focused 4 files/36 tests + Core unit 3 tests; full 60 files/387 tests; schema drift, typecheck, lint (0 errors), boundaries, build và diff check exit 0.
  - Decisions: WHATWG fetch tự ghi đè Host nên hostile-Host wire test dùng `node:http` để gửi header thật. Listener test đóng cả clients, socket và bảy SDK handler instances.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.1 complete; Task O.2
  - Files: [`packages/cli/src/main.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: CLI có strict top-level command tree, bare invocation alias app, `vidcom app` giữ launch flow cũ; app flags reject unknown/duplicate/missing/invalid values và input error chỉ đi stderr với exit 2. Bắt đầu `vidcom mcp` runtime.
  - Verification: CLI dispatch + existing startup 2 files/17 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: `runCliMain` tách process-I/O boundary để test stderr/exit contract không cần spawn TS entry; bare `vidcom` vẫn alias app theo product architecture.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.2 complete; Task O.3
  - Files: [`packages/cli/src/{composition-root,startup,commands/mcp,main,index,cli-error}.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: `vidcom mcp` parse workspace/exact pin strict, dùng canonical workspace resolver, full migration→lease→recovery→scheduler→watcher startup và SDK stdio không bearer. Production registry đăng ký đúng 10 tools. Bắt đầu signal shutdown.
  - Verification: CLI MCP + startup 2 files/19 tests; typecheck, lint (0 errors), boundaries và diff check exit 0.
  - Decisions: gom sáu runtime TTL/retention vào `McpRuntimeConfig` tại composition root; đồng thời wire audit và credential services tại sole production composition seam. Stdio không tạo/verify HTTP credential.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.3 complete; Task O.4
  - Files: [`packages/cli/src/commands/mcp.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: SIGINT/SIGTERM dùng một idempotent shutdown gate; foundation stop đóng transport → scheduler/watcher → lease → SQLite, listener cleanup gỡ cả hai signal handlers. Bắt đầu trusted approve command.
  - Verification: CLI MCP + startup 2 files/21 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: `runMcpCommand` giữ process sống đến signal thay vì trả ngay sau start; duplicate/cross-signal chỉ gọi stop đúng một lần. Không có stdout application log.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.4 complete; Task O.5
  - Files: [`packages/cli/src/{commands/approve,output,main,index}.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: `vidcom approve <requestId>` mở/migrate app-data DB, gọi ApprovalService issue với approver cli, đóng DB và in đúng một JSON object. Invalid/expired/replay là domain exit 2. Bắt đầu credential admin.
  - Verification: CLI commands + startup 2 files/22 tests; typecheck, lint (0 errors) và diff check exit 0.
  - Decisions: approve không cần workspace/lease vì chỉ chuyển trạng thái app-data grant qua atomic repository; MCP Registry dependency tiếp tục chỉ expose `request`, không thể gọi issue.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.5 complete; Task O.6
  - Files: [`packages/cli/src/{commands/credential,main,index}.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: Credential admin phủ issue/list/rotate/revoke, positive overlap override, one-time secret JSON và metadata list không secret/digest; lifecycle chạy trên SQLite app-data thật. Bắt đầu backup admin.
  - Verification: CLI commands + startup 2 files/23 tests; typecheck, lint giữ baseline 10 warnings (0 errors), diff check exit 0.
  - Decisions: list cố ý omit cả secretHash dù digest không phải plaintext, giảm disclosure; service domain `credential_invalid` map về exit 2 cùng một message, mọi lỗi hạ tầng vẫn exit 1.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.6 complete; Task O.7
  - Files: [`packages/adapter/src/fs/backup-store.ts`, `packages/cli/src/{commands/backup,main,index}.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: Backup admin có strict list tùy chọn project, verify integrity và restore theo backup ID; restore khởi tạo foundation/lease rồi gọi Core `restoreBackup` qua WriteAuthority, không tự ghi workspace. Bắt đầu recovery admin.
  - Verification: focused CLI + backup store + real restore 3 files/23 tests; typecheck, lint giữ baseline 10 warnings (0 errors), boundaries và diff check exit 0.
  - Decisions: list không project dùng adapter-only `listAll` cho trusted local administration mà không nới Core `BackupPort`; verify unknown là input error, tampered payload trả JSON `valid:false`; restore chạy job recovery/scheduler thật và luôn stop foundation trong finally.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.7 complete; Task O.8
  - Files: [`packages/cli/src/{commands/recovery,main,index}.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: Recovery admin có inspect read-only, reconcile một journal theo hash durable và resolve orphan qua đúng một choice tường minh; mọi write/resolve chạy dưới workspace lease và Core recovery use case. Bắt đầu CLI contract suite.
  - Verification: focused CLI + persistence + Core recovery 3 files/34 tests; typecheck, lint giữ baseline 10 warnings (0 errors), boundaries và diff check exit 0.
  - Decisions: targeted recovery runtime không gọi startup reconcile-all để command không thay đổi journal khác; inspect chỉ đọc projection đã redact previous content; parser từ chối thiếu choice, hai choice hoặc choice lạ trước khi mở DB/workspace.
  - Blockers: không có.

2026-08-02 — Phase O, Task O.8 complete; Task O.9
  - Files: [`packages/cli/src/main.ts`, `tests/cli/{mcp-commands,startup}.test.ts`]
  - Summary: CLI contract suite phủ strict dispatch/admin args, JSON outputs, input/infrastructure exit codes, missing workspace, protocol pin, signal idempotence và real SQLite lease release. Bắt đầu exact SDK stdio smoke.
  - Verification: CLI command + startup 2 files/35 tests; typecheck, lint giữ baseline 10 warnings (0 errors), boundaries và diff check exit 0.
  - Decisions: `runCliMain` nhận injectable execute seam chỉ để chứng minh unexpected failure exit 1 mà không đụng môi trường thật; missing workspace test kiểm marker không được tự tạo; runtime stop được xác nhận bằng workspace_lease row count 0.
  - Blockers: không có.

2026-08-02 — Phase O complete; Phase P, Task P.1
  - Files: [`packages/cli/{bin/vidcom.mjs,package.json}`, root `package.json`, `bun.lock`, `tests/e2e/mcp-stdio-host.test.ts`]
  - Summary: Exact installed legacy/modern MCP clients spawn source-checkout launcher Phase 2, negotiate từng revision, list/call 10 tools, modern elicitation gọi trusted approve CLI rồi retry destructive delete thành công; cả hai child đóng sạch và nhả lease. Đây không phải actual Claude Code/Codex binary evidence. Bắt đầu 2×2 contract matrix.
  - Verification: exact Phase O matrix 3 files/36 tests; frozen install, typecheck, lint baseline 10 warnings (0 errors), boundaries, production build và diff check exit 0.
  - Decisions: source-checkout launcher Phase 2 dùng Node + `tsx/esm/api` wrapper vì Node raw TS không resolve extensionless workspace imports còn Bun 1.3.14 thiếu `node:sqlite`; đây không phải packaged SEA Phase 4. Smoke coi hai SDK parser thành công trên toàn stream là protocol-only stdout evidence và kiểm stderr ngoài Node experimental warning bằng rỗng.
  - Blockers: không có.

2026-08-02 — Phase P, Task P.1 complete; Task P.2
  - Files: [`tests/mcp/{contract-matrix,support}.ts`, `tests/mcp/fixtures/contract-matrix-server.ts`]
  - Summary: Parameterized evidence chạy đủ 10 production descriptors trên legacy/modern × stdio/HTTP bằng exact installed SDKs; mỗi cell list deterministic và gọi mọi tool với guarded missing-project outcome. Bắt đầu golden tools/list/result.
  - Verification: contract matrix 1 file/4 cells, 40 tool calls; typecheck, lint baseline 10 warnings (0 errors), boundaries và diff check exit 0.
  - Decisions: P.1 dùng cùng `registerVidcomTools` production descriptors nhưng deterministic missing-project dependencies để tách transport contract khỏi destructive durability; real success/destructive paths thuộc P.4/P.5 và O.9 đã có một approval round-trip thật.
  - Blockers: không có.

2026-08-02 — Phase P, Task P.2 complete; Task P.3
  - Files: [`tests/mcp/golden/{tools-list.test.ts,fixtures/*.json}`]
  - Summary: Committed raw-wire goldens khóa legacy/modern tools/list đủ schema và complete tools/call result; ba lượt list mỗi era giữ byte-equivalent order, modern list có private cache còn legacy không có modern fields. Bắt đầu negative contract matrix.
  - Verification: focused golden 1 file/4 tests; full `test:golden` 6 files/22 tests; typecheck, lint baseline 10 warnings (0 errors) và diff check exit 0.
  - Decisions: snapshot raw SDK-owned HTTP result thay vì client-normalized object để giữ `resultType`; cache metadata chỉ thuộc modern tools/list theo actual SDK contract, complete tool result có resultType nhưng không ttl/cache.
  - Blockers: không có.

2026-08-02 — Phase P, Task P.3 complete; Task P.4
  - Files: [`tests/mcp/negative-contract-matrix.test.ts`]
  - Summary: Negative matrix khóa missing/stale precondition, missing/replayed/expired grant, unknown revision, no-header legacy default, resource-code era split và modern-only hidden tool; dùng production schemas/error mapper và ApprovalService. Bắt đầu real datastore recovery matrix.
  - Verification: focused negative suite 7 files/65 tests; typecheck, lint baseline 10 warnings (0 errors) và diff check exit 0.
  - Decisions: unknown modern revision fixture mang đủ envelope `_meta` để đi tới revision allowlist thay vì dừng sớm ở envelope validation; stale precondition chạy production save_file descriptor với injected authority conflict.
  - Blockers: không có.

2026-08-02 — Phase P, Task P.4 complete; Task P.5
  - Files: [`tests/core/{composite-recovery,reconcile-pending-mutations}.test.ts`, `tests/adapter/{composite-recovery-persistence,composite-journal,composite-write-authority}.test.ts`]
  - Summary: Existing real SQLite/filesystem matrix chứng minh all/none/mixed/unknown decisions, T2a/T2b/T2c injected failures, exact reserved grant/audit recovery, retry idempotence và per-project recovery gate. Bắt đầu destructive datastore matrix.
  - Verification: focused recovery matrix 5 files/38 tests exit 0.
  - Decisions: không thêm duplicate aggregator test; evidence nằm ở production journal/workspace integration suites, còn pure classifier suite khóa decision table và không tin persisted step status.
  - Blockers: không có.

2026-08-02 — Phase P, Task P.5 complete; Task P.6
  - Files: [`tests/core/{approval-service,file-deletion,scene-deletion,restore-backup}.test.ts`, `tests/adapter/{backup-store,backup-restore,project-destructive-usecases}.test.ts`, `tests/mcp/registry.test.ts`, `tests/e2e/mcp-stdio-host.test.ts`]
  - Summary: Destructive matrix phủ approval lifecycle, exact binding/replay/expiry, backup atomic publish/attach/prune/restore, file/scene outcomes, mid-step/T2 crash boundaries, revision/audit relation và production MCP delete round-trip. Bắt đầu CI guards.
  - Verification: focused destructive matrix 9 files/73 tests exit 0.
  - Decisions: giữ scenario theo layer và production seam thay vì một test khổng lồ; E2E là bằng chứng delete_file + trusted CLI approval thật, real adapter suite là bằng chứng delete_scene/backup/audit durability.
  - Blockers: không có.

2026-08-02 — Phase P, Task P.6 complete; Task P.7
  - Files: [`tests/mcp/ci-guards.test.ts`, `package.json`, `.github/workflows/ci.yml`]
  - Summary: CI có named guards cho registry-case parity, exact SDK revision compatibility, one-step audit forwarding, stdio cleanliness, committed goldens và schema drift. Bắt đầu exact Verification Matrix.
  - Verification: `test:mcp-contract` 6 files/51 tests; schema drift 4 migration artifacts; typecheck, lint baseline 10 warnings (0 errors) và diff check exit 0.
  - Decisions: modern revision guard dùng chính SDK 2.0 Client pin validator; legacy allowlist so sánh toàn bộ runtime constant. Dedicated CI suite chạy lại evidence trọng yếu dù full test đã bao phủ để drift hiện tên gate rõ ràng.
  - Blockers: không có.

2026-08-02 — Phase P, Task P.7 complete; Task P.8
  - Files: [Phase Verification Matrix và generated build artifacts không tracked]
  - Summary: Chạy nguyên văn toàn bộ local Verification Matrix trên commit gốc `f4c838b43744e676798c1fb2fc58a46cfecd1219`; mọi command exit 0, không skipped test. Bắt đầu exact SDK-host demo/docs/remote closeout.
  - Verification: `bun install --frozen-lockfile` exit 0 (870 installs/1034 packages, no changes); `typecheck` 0; `lint` 0 với baseline 10 warnings; `test:boundaries` 0; `test` 0 (66 files/423 tests); `test:golden` 0 (6 files/22 tests); `build` 0; `test:runtime-smoke` 0 (production MCP bearer route + SSE 1→2); `test:schema-drift` 0 (4 artifacts); `git diff --check` 0.
  - Decisions: ghi SHA pre-commit để liên kết exact working-tree baseline; closeout audit bổ sung MCP Registry/credential injection vào Next host và nâng runtime smoke thành bearer call thật. P.8 sẽ tạo ship commit mới rồi chạy/xác minh remote CI trên SHA đó trước closeout.
  - Blockers: không có.

2026-08-02 — Phase P complete; 140/140 tasks
  - Files: [`tests/e2e/mcp-stdio-host.test.ts`, `.github/workflows/ci.yml`, main spec, Detailed Design, build-order và product docs]
  - Summary: Exact SDK-host demo rerun xanh; behavior thật đã cập nhật vào main spec/build-order/product docs. Ship commit `db7fd685af37e8efcd0e6c09df92aa1865911414` được push và GitHub Actions CI #6 hoàn tất Success trước closeout.
  - Verification: local exact Verification Matrix 10/10 exit 0; exact SDK-host demo 1/1; remote CI #6 run `30744778718` Success 2m54s trên `db7fd68`, CI #7 run `30744858938` Success 2m56s trên `f01d4b4`; full 66 files/423 tests, MCP guard 6/51, golden 6/22, không skipped test. Warning GitHub Actions Node 20 deprecation cho `actions/checkout@v4`/`setup-node@v4` không phải product failure.
  - Decisions: spec chuyển `inprocess` → `complete` chỉ sau remote ship CI xanh. Closeout commit chỉ đổi evidence/status docs và sẽ được push/xác minh CI riêng để bảo đảm remote main đúng trạng thái 140/140.
  - Blockers: không có.

2026-08-02 — Review remediation, Phase R Task R.1
  - Files: [`mcp-server-review.md`, `mcp-server-review-raw/*.md`, main spec, Detailed Design v7, checklist, `implementation-notes.html`]
  - Summary: Đọc đầy đủ 7 raw report, hợp nhất 43 finding thành Phase R→V và reopen spec từ Complete sang In Process. Bắt đầu C-01 bằng durable capture/CAS thay cho validate-rồi-rename.
  - Verification: task audit có 43 finding mapping; main spec/checklist/design links chuyển sang `inprocess`; chưa mark finding nào complete trước regression test.
  - Decisions: §17 và DR-21–DR-31 khóa filesystem CAS, lease-scoped recovery, response finalization, retention, HTTP context và CLI lifecycle trước production edit.
  - Blockers: không có.

2026-08-02 — Phase R, Task R.1 complete; Task R.2
  - Files: [`packages/core/src/{port,service}/**`, `packages/adapter/src/{fs,db}/**`, `packages/adapter/drizzle/20260802120436_late_sheva_callister/**`, `tests/{core,adapter}/**`]
  - Summary: Durable same-filesystem capture/CAS thay thế publish overwrite; journal persist rollback slot trước publish, backup đọc captured bytes, external target tạo ở bốn race window được giữ nguyên và mutation không commit. Bắt đầu transactional lease/recovery gate H-01.
  - Verification: focused 5 files/51 tests pass gồm 4 real-filesystem barrier regression; schema drift 6 artifacts, typecheck, lint 0 errors, boundaries và `git diff --check` đều exit 0.
  - Decisions: entity revision 0 giữ logical default `fromHash` trong journal nhưng CAS filesystem dùng physical `null`; DB capture invariant liên kết `previous_content` với `captured_hash` để phân biệt đúng virtual default và file thật.
  - Blockers: không có.

2026-08-02 — Phase R, Task R.2 complete; Task R.3
  - Files: [`packages/core/src/port/{ports,types}.ts`, `packages/core/src/service/write-authority.ts`, `packages/adapter/src/db/journal.ts`, `packages/adapter/src/fs/{mutation-capture,watcher}.ts`, `tests/{adapter,cli}/**`]
  - Summary: T1 nhận exact lease ID, lấy SQLite write lock bằng guarded update, kiểm expiry + project workspace + unresolved gate trong cùng transaction trước journal insert. Two-connection handover chứng minh stale daemon không tạo journal/chạm disk. Bắt đầu recovery settlement CAS H-02.
  - Verification: two-connection regression 1/1; focused affected 7 files/60 tests; full 66 files/428 tests; typecheck, lint 0 errors, boundaries, schema drift 6 artifacts và `git diff --check` đều exit 0.
  - Decisions: `project_registry.workspace_root` là binding lease→project; legacy multi-unresolved fixtures seed terminal status tạm thời thay vì mở bypass production. Watcher bỏ qua durable mutation artifacts và root-self notifications để CAS rename không giả external event.
  - Blockers: không có.

2026-08-02 — Phase R, Task R.3 complete; Task R.4
  - Files: [`packages/core/src/{service/composite-recovery,usecase/reconcile-composite-mutation}.ts`, `tests/{core,adapter}/composite-recovery*.test.ts`]
  - Summary: Recovery capture/revalidate mọi observed target bằng same-filesystem CAS ngay settlement boundary; mixed rollback dùng CAS capture thay cho write/delete overwrite. External edit classify→T2 giữ journal pending và không tạo revision stale. Bắt đầu workspace-scoped recovery lease H-03.
  - Verification: new real SQLite/filesystem barrier 1/1; focused 4 files/35 tests; full 66 files/429 tests; typecheck, lint 0 errors, boundaries, schema drift và `git diff --check` exit 0.
  - Decisions: settlement slot dùng namespace ordinal riêng nhưng cùng primitive; CAS conflict trả `recovery_required` và bảo toàn external bytes, còn unknown observation tiếp tục chuyển orphan để giữ project gate.
  - Blockers: không có.

2026-08-02 — Phase R, Task R.4 complete; Task R.5
  - Files: [`packages/core/src/{port/ports,usecase/reconcile-composite-mutation}.ts`, `packages/adapter/src/db/journal.ts`, `packages/cli/src/{startup,composition-root,commands/recovery}.ts`, `tests/{cli,adapter}/**`]
  - Summary: Startup list/reconcile chỉ journal có registration thuộc exact leased workspace; runtime resolver không fallback ra root khác. Targeted recovery đọc journal registration trước, tạo workspace adapter và acquire đúng lease rồi mới inspect/write filesystem. Bắt đầu backup abort-or-reconcile H-04.
  - Verification: cross-workspace startup regression 1/1 và wrong-selector targeted recovery regression xanh; CLI focused 2 files/36 tests; full 66 files/430 tests; typecheck, boundaries, schema drift và `git diff --check` exit 0.
  - Decisions: global reconciliation bắt buộc `workspaceRoot`; journal query join `project_registry`; selector UI/env không được override workspace sở hữu targeted journal. Xóa import phát sinh để lint trở lại đúng 10 baseline warnings.
  - Blockers: không có.

2026-08-02 — Phase R, Task R.5 complete; Task R.6
  - Files: [`packages/core/src/service/write-authority.ts`, `tests/core/write-authority.test.ts`]
  - Summary: Hai nhánh backup unavailable/create/verify dùng chung abort-restored-or-inline-reconcile; chỉ trả backup_failed khi T2a hoặc reconcile chứng minh aborted/rolled_back, còn pending trả recovery_required kèm journalId/phase. Bắt đầu crash-safe backup prune M-12.
  - Verification: failure injection abort fail + reconcile pending/terminal 2/2; focused 3 files/38 tests; full 66 files/432 tests; typecheck, lint 0 errors, boundaries, schema drift và `git diff --check` exit 0.
  - Decisions: captures chỉ discard sau terminal proof; null abort context buộc reconcile thay vì giả định đã đóng; grant release tiếp tục nằm trong same T2a adapter transaction.
  - Blockers: không có.

2026-08-02 — Phase R, Task R.6 complete; Task R.7
  - Files: [`packages/adapter/src/fs/backup-store.ts`, `tests/adapter/backup-store.test.ts`]
  - Summary: Payload prune đổi sang atomic payload→.payload.pruning, fsync directory, durable payload_pruned_at, rồi physical delete; mỗi lần prune reconcile residue trước/after DB crash. Bắt đầu recovery-before-retention M-13.
  - Verification: two crash-boundary regressions pass; backup/startup focused 3 files/28 tests; full 66 files/433 tests; typecheck, lint 0 errors, boundaries, schema drift và `git diff --check` exit 0.
  - Decisions: tombstone với DB null được restore trước retry; DB đã marked thì tombstone/payload residue bị xóa; metadata không bao giờ nói payload còn khả dụng sau physical delete.
  - Blockers: không có.

2026-08-02 — Phase R, Task R.7 complete; Task R.8
  - Files: [`packages/cli/src/startup.ts`, `packages/adapter/src/fs/backup-store.ts`, `tests/{adapter,cli}/**`]
  - Summary: Startup reconcile scoped journals trước backup retention; prune loại backup còn gắn pending/orphaned và tính tuổi linked backup từ terminal revision.created_at thay vì manifest tuổi cũ. Bắt đầu content-addressed large rollback payload M-14.
  - Verification: unresolved/terminal-age regression pass; focused 3 files/36 tests; full 66 files/434 tests; typecheck, lint 0 errors, boundaries, schema drift và `git diff --check` exit 0.
  - Decisions: backup recovery vừa terminal không bị prune ngay dù manifest đã quá tuổi; unattached terminal metadata vẫn dùng created_at; unresolved luôn exempt bất kể cutoff.
  - Blockers: không có.

2026-08-02 — Phase R complete, Task R.8 complete; Phase S, Task S.1
  - Files: [`packages/adapter/src/{db/journal.ts,db/schema.ts,fs/large-content-store.ts}`, `packages/adapter/drizzle/20260802123804_lumpy_old_lace/`, `packages/cli/src/{composition-root.ts,startup.ts,commands/recovery.ts}`, `tests/adapter/{composite-journal,mcp-database-migration}.test.ts`]
  - Summary: Rollback payload trên 64 KiB được fsync vào immutable SHA-256 object store; journal/revision rows chỉ giữ hash + byte size, startup GC chỉ xóa object quá grace và không còn reference durable. Cả composite lẫn legacy/staged recovery hydrate cùng object. Bắt đầu canonical reference graph H-05.
  - Verification: 2 MiB regression chứng minh 4 metadata rows cùng một object, SQLite inline bytes bằng 0 và page footprint nhỏ hơn payload; ENOSPC trước T1 không để journal, T2 không rewrite object đã durable. Focused 5 files/40 tests và full 66 files/436 tests; typecheck, lint 0 errors, schema drift 8 artifacts exit 0.
  - Decisions: ngưỡng inline 64 KiB; referenced object giữ vô hạn để recovery/restore không mất bytes; orphan object chỉ compact ở startup sau grace 24 giờ và sau recovery, không chạy trong request.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.1 complete; Task S.2
  - Files: [`packages/core/src/domain/models.ts`, `packages/core/src/usecase/file-deletion.ts`, `packages/adapter/src/hyperframes/parse.ts`, `fixtures/parse/project-references.html`, `tests/{core,adapter,golden}/**`]
  - Summary: Parser expose tập `{owner,path}` canonical project-relative cho direct scene source, nested media/narration và root-track media; URL/data/absolute/project-escaping bị loại. delete_file chỉ quyết định theo tập canonical, không so raw src/API URL. Bắt đầu timing invariants create_scene H-06.
  - Verification: real repro nested `../assets/logo.svg` bị deny; unit phủ root/nested/same-basename; parser phủ external/data/escape. Focused 4 files/28 tests; full 66 files/439 tests; typecheck, lint 0 errors và boundary gate exit 0.
  - Decisions: reference resolution lấy owner source đã thực sự parse; scene source thiếu/unreadable vẫn là reference từ entry nhưng media fallback giữ owner entry; dedupe theo owner+path để không mất provenance.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.2 complete; Task S.3
  - Files: [`packages/core/src/domain/invariants.ts`, `packages/core/src/usecase/project-writes.ts`, `tests/core/project-usecases.test.ts`, `tests/adapter/project-destructive-usecases.test.ts`]
  - Summary: createScene dùng timing invariant chung trước applyOps/T1; end time bắt buộc hữu hạn ngoài duration/start/track rules. Bắt đầu terminal audit cho modern input_required H-07.
  - Verification: Core regression khẳng định applyOps/mutation đều 0; real SQLite/filesystem test khẳng định duration 0/âm/overflow không tạo scene/narration, journal hoặc revision. Focused 2 files/43 tests; full 66 files/443 tests; typecheck và lint 0 errors exit 0.
  - Decisions: create_scene được phép mở rộng root duration nên validate với Number.MAX_VALUE; riêng non-finite start+duration trả duration_overflow trước serialization.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.3 complete; Task S.4
  - Files: [`packages/mcp/src/registry/registry.ts`, `tests/mcp/{registry,modern-transport}.test.ts`, `tests/e2e/mcp-stdio-host.test.ts`]
  - Summary: Registry persist terminal approval_required audit trước khi rethrow InputRequiredSignal; ownership lookup ngăn caller ghi đè journal-owned context. Modern transport và real stdio smoke khóa một error round trước một retry-success round. Bắt đầu reject empty timing patch M-01.
  - Verification: focused policy/registry/HTTP/SQLite 4 files/42 tests; executable stdio focused 3 files/25 tests; full 66 files/444 tests; typecheck và lint 0 errors exit 0.
  - Decisions: input_required là terminal outcome của invocation round hiện tại, không phải success; requestState được audit nhưng schema/message không được copy dư; MRTR retry là invocation mới và có audit riêng.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.4 complete; Task S.5
  - Files: [`packages/contracts/src/mcp.ts`, `packages/core/src/usecase/project-writes.ts`, `tests/contracts/mcp-contracts.test.ts`, `tests/core/project-usecases.test.ts`]
  - Summary: SetSceneTiming schema yêu cầu ít nhất một field; Core duplicate guard trả schema_invalid trước parse/source/SDK/T1. Bắt đầu sửa narrationStale absent/present M-02.
  - Verification: contract chấp nhận riêng start/duration/trackIndex và reject empty; Core chứng minh 0 source read/applyOps/mutation; golden 1 file/4 tests, focused 3 files/64 tests, full 66 files/446 tests; typecheck và lint 0 errors exit 0.
  - Decisions: refine giữ strict object/schema surface hiện tại; Core guard sau project lookup để không đổi precedence project_not_found của caller nội bộ.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.5 complete; Task S.6
  - Files: [`packages/contracts/src/mcp.ts`, `packages/core/src/usecase/project-writes.ts`, `llm-documents/.../spec-mcp-server-detailed-design.md`, `tests/{contracts,core,mcp}/**`]
  - Summary: SetText output đổi narrationStale literal thành boolean; Core chỉ stale sidecar và trả true khi narration hiện hữu, scene absent trả false với đúng một source step. Bắt đầu response-finalization M-03.
  - Verification: present/absent Core regressions, contract true/false và golden legacy/modern pass; focused 4 files/50 tests; full 66 files/448 tests; typecheck và lint 0 errors exit 0.
  - Decisions: giữ boolean thay vì thêm enum để không mở rộng surface ngoài finding; scene.narration là nguồn quyết định, missing sidecar khi model nói present vẫn fail storage như trước.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.6 complete; Task S.7
  - Files: [`packages/contracts/src/errors.ts`, `packages/mcp/src/{registry/registry.ts,error-map.ts}`, `packages/server/src/middleware/error-mapper.ts`, `tests/{adapter,contracts,mcp}/**`]
  - Summary: Post-commit output validation failure dùng committed_response_error riêng với committed flag/invocation/revision và do-not-retry guidance; journal-owned success audit không bị ghi đè thành ordinary failure. Bắt đầu canonical fileHashes key M-04.
  - Verification: real SQLite/filesystem malformed create_scene chứng minh file+journal+revision committed, audit ok và wire special outcome; focused 3 files/34 tests + contract 2/9; full 66 files/450 tests; typecheck/lint 0 errors exit 0.
  - Decisions: không giả rollback sau T2; distinct error code là machine-readable terminal outcome, MCP internal category giữ retryable=false; revision identity lấy từ raw envelope khi an toàn.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.7 complete; Task S.8
  - Files: [`packages/contracts/src/mcp.ts`, `tests/contracts/mcp-contracts.test.ts`, `tests/mcp/golden/fixtures/tools-list-{legacy,modern}.json`]
  - Summary: `WriteEnvelope.fileHashes` dùng key schema project-relative canonical; absolute, drive-qualified, traversal segment, backslash, duplicate separator, dot segment và empty key đều bị từ chối. Bắt đầu rewrite mô tả đủ 10 tool M-05.
  - Verification: contract/golden/registry focused 3 files/34 tests; full 66 files/451 tests; typecheck và lint 0 errors exit 0.
  - Decisions: giữ validation ở WriteEnvelope thay vì siết mọi `RelativePathSchema` reader để thay đổi chỉ tác động write response contract; JSON Schema phát hành cùng min/max/pattern trong cả hai era golden.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.8 complete; Task S.9
  - Files: [`packages/mcp/src/registry/{read-tools,write-tools,destructive-tools}.ts`, `tests/mcp/{registry.test.ts,golden/**}`]
  - Summary: Cả 10 tool description dùng cùng contract ngôn ngữ gồm use when, do not use, nguồn precondition, side effects và errors/recovery; giữ nguyên các chi tiết source-size, narration/TTS, approval, backup và output identity. Bắt đầu audit timing/revision M-06.
  - Verification: registry/tools/golden focused 3 files/29 tests; full 66 files/451 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: khóa năm marker bằng automated assertion cho cả hai era và giữ full text trong golden/inline snapshot; không tạo metadata field mới vì finding chỉ yêu cầu discovery description.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.9 complete; Task S.10
  - Files: [`packages/{core,adapter,mcp,cli}/**/{tool-audit-service,types,tool-audit,journal,registry,startup}.ts`, `llm-documents/.../spec-mcp-server-detailed-design.md`, `tests/{core,adapter,mcp,cli}/**`]
  - Summary: Mọi terminal tool audit persist invocation time, durationMs, revisionBefore và revisionAfter; Registry phủ read/pre-T1/caller error, journal phủ commit/orphan/recovered commit, startup phủ recovered abort. Bắt đầu list_projects tolerance/pagination M-07.
  - Verification: focused 5 files/68 tests; full 66 files/453 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: metadata mới nằm trong audit detail, mutation success vẫn dùng revision_id làm after identity nên không cần migration; pending schema v1 cũ thiếu revisionBefore normalize thành null; revision observation fail-open có metric/log.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.10 complete; Task S.11
  - Files: [`packages/contracts/src/mcp.ts`, `packages/core/src/usecase/project-reads.ts`, `packages/mcp/src/registry/read-tools.ts`, `llm-documents/.../spec-mcp-server-detailed-design.md`, `tests/{contracts,core,mcp}/**`]
  - Summary: list_projects có default limit 20/max 100, lexical cursor ổn định, page parse batch tối đa 4 và per-project warning diagnostic; output thêm diagnostics/nextCursor trong cả hai era. Bắt đầu missing referenced source M-08.
  - Verification: focused 5 files/76 tests + contract matrix 2 era × 2 transport/4 tests; full 66 files/455 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: cursor là projectId cuối page và filter lexical lớn hơn nên cursor bị xóa vẫn tiến; nextCursor dựa trên selected refs kể cả item malformed để không lặp; enumerate workspace failure vẫn terminal storage error.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.11 complete; Task S.12
  - Files: [`packages/contracts/src/mcp.ts`, `packages/core/src/usecase/project-reads.ts`, `packages/mcp/src/registry/read-tools.ts`, `llm-documents/.../spec-mcp-server-detailed-design.md`, `tests/{core,mcp}/**`]
  - Summary: Scene reference thiếu source trả fileContentHash=null và một warning referenced_source_missing theo unique path trong get_project_context/list_scenes; không throw internal hay tạo hash giả. Bắt đầu grant expiry M-11.
  - Verification: focused 6 files/81 tests gồm matrix 2 era × 2 transport; full 66 files/456 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: nested source missing là nullable scene state; entry source vẫn hard dependency; list_scenes thêm diagnostics, SceneContext hash nullable đồng bộ mọi write/read output và golden.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.12 complete; Task S.13
  - Files: [`packages/core/src/{port/ports.ts,service/approval-service.ts}`, `packages/adapter/src/db/approval-grants.ts`, `tests/{core,adapter,mcp}/**`]
  - Summary: Retention entrypoint chuyển mọi requested/issued quá TTL sang expired trước khi xóa terminal row; reserved không nằm trong expiry transition và unresolved journal link vẫn chặn cleanup. Bắt đầu credential summary L-03.
  - Verification: focused 4 files/40 tests; full 66 files/458 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: thêm `expireDue(now)` vào grant port để lifecycle nằm trong datastore atomic update; cleanup service gọi transition theo clock rồi mới áp retention cutoff; không đổi schema hay expiry semantics của reserved.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.13 complete; Task S.14
  - Files: [`packages/core/src/{port/types.ts,service/mcp-credential-service.ts}`, `packages/cli/src/commands/credential.ts`, `tests/{core,adapter}/mcp-credential*.test.ts`]
  - Summary: Core `list()` trả DTO `McpCredentialSummary` không có `secretHash`; CLI tiêu thụ trực tiếp public DTO thay vì tự lọc persistence record. Bắt đầu canonical MCP text content L-04.
  - Verification: focused 3 files/34 tests; full 66 files/459 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: port persistence tiếp tục dùng full record để verify/rotate; redaction thuộc Core service boundary để mọi caller nhận cùng non-secret contract, không chỉ CLI.
  - Blockers: không có.

2026-08-02 — Phase S, Task S.14 complete; Task S.15
  - Files: [`packages/mcp/src/server.ts`, `tests/mcp/{contract-matrix.test.ts,golden/fixtures/result-*.json}`]
  - Summary: Thành công tools/call serialize text bằng canonical JSON của đúng validated structuredContent; byte ordering được khóa trên cả hai era và hai transport. Bắt đầu overlap bound L-07.
  - Verification: focused 4 files/12 tests gồm matrix 2 era × 2 transport; full 66 files/459 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: tái sử dụng Core canonicalizeJson thay vì thêm serializer MCP thứ hai; structuredContent giữ object validated, text là canonical byte representation của chính object đó.
  - Blockers: không có.

2026-08-02 — Phase S complete; Phase T, Task T.1
  - Files: [`packages/core/src/service/mcp-credential-service.ts`, `packages/cli/src/commands/credential.ts`, `llm-documents/.../spec-mcp-server-detailed-design.md`, `tests/{core,cli}/**`]
  - Summary: Rotation overlap có default 5 phút và product cap 24 giờ; CLI chặn ngoài `1..86_400_000`, Core chặn config/override ngoài `0..cap` và expiry ngoài ECMAScript Date trước persistence. Bắt đầu authInfo forwarding H-08.
  - Verification: focused 3 files/35 tests; full 66 files/460 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: 24 giờ là product maximum mới của §17.8; Core vẫn cho 0 để cấu hình overlap tức thời, CLI override tiếp tục positive như contract; Date edge dùng giới hạn ±8.64e15 ms.
  - Blockers: không có.

2026-08-02 — Phase T, Task T.1 complete; Task T.2
  - Files: [`packages/mcp/src/http.ts`, `tests/server/mcp-security.test.ts`]
  - Summary: Pinned wrapper forward nguyên handler options khi revision match; real Hono bearer path qua SDK đến Registry audit hoạt động cho entry, mọi exact pin và latest, chỉ persist credential ID. Bắt đầu exact-pin validation ladder M-09.
  - Verification: focused 4 files/22 tests; full 66 files/460 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: bearer chỉ tồn tại ở perimeter verifier; downstream AuthInfo dùng token rỗng và verified clientId; test iterate canonical SUPPORTED_REVISIONS để revision mới không tái tạo lỗ hổng.
  - Blockers: không có.

2026-08-02 — Phase T, Task T.2 complete; Task T.3
  - Files: [`packages/mcp/src/http.ts`, `tests/mcp/revision-pin.test.ts`]
  - Summary: Exact-pin wrapper delegate POST thiếu/sai JSON Content-Type cho SDK trước clone/classify; invalid JSON tiếp tục đi qua SDK parse ladder trước pin mismatch. Bắt đầu pathname-only logger M-10.
  - Verification: focused 3 files/15 tests; full 66 files/460 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: dùng official `isJsonContentType` của exact server SDK; test khóa status/code/id vì entry và pinned SDK configuration có thể dùng wording parse error khác nhau nhưng cùng canonical rung.
  - Blockers: không có.

2026-08-02 — Phase T, Task T.3 complete; Task T.4
  - Files: [`packages/server/src/middleware/perimeter.ts`, `tests/server/security.test.ts`]
  - Summary: Pre-auth request logger chỉ ghi HTTP method và URL pathname; origin, mọi query key/value và encoded absolute path không còn đi vào log. Bắt đầu canonical CORS L-01.
  - Verification: focused 2 files/25 tests; full 66 files/460 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: giữ exported helper để không break server surface nhưng đổi semantic thành pathname-only; test assert exact log line thay vì blacklist từng secret key.
  - Blockers: không có.

2026-08-02 — Phase T, Task T.4 complete; Task T.5
  - Files: [`packages/server/src/middleware/perimeter.ts`, `tests/server/security.test.ts`]
  - Summary: CORS canonicalize configured/request origin rồi phát configured constant; trusted credentialed OPTIONS preflight kết thúc 204 trước auth với fixed methods/headers và credentials policy. Bắt đầu app-data/SQLite permission L-02.
  - Verification: focused 2 files/26 tests; full 66 files/461 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: chỉ HTTP(S) origins do URL canonicalizer chấp nhận được map; preflight method/header ngoài fixed allowlist bị từ chối, response không echo raw Origin hay requested headers.
  - Blockers: không có.

2026-08-02 — Phase T complete; Phase U, Task U.1
  - Files: [`packages/adapter/src/{db/client.ts,fs/credential-store.ts}`, `tests/{adapter/node-sqlite,server/security}.test.ts`]
  - Summary: App-data được tạo/repair 0700 trước file nhạy cảm; SQLite main/WAL/SHM precreate 0600 và owner-only ACL trước open/WAL writes, rồi resecure sau bật WAL. Bắt đầu idempotent unwind H-09.
  - Verification: focused 3 files/27 tests; full 66 files/462 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: POSIX test chạy dưới umask 0 và stat live sidecars; Windows directory ACL bỏ inheritance và grant current SID OI/CI full control trước khi tạo file; file ACL giữ current SID read/write.
  - Blockers: không có.

2026-08-02 — Phase U, Task U.1 complete; Task U.2
  - Files: [`packages/cli/src/startup.ts`, `tests/cli/startup.test.ts`]
  - Summary: Shutdown dùng một concurrency-safe promise và independent cleanup actions theo listener→scheduler→watcher→lease→DB; mọi lỗi được gom AggregateError sau khi đủ bước đã chạy. Bắt đầu executable artifact H-10.
  - Verification: focused 2 files/41 tests; full 66 files/467 tests; typecheck, lint 0 errors và git diff --check exit 0.
  - Decisions: repeated/concurrent stop trả cùng promise và không gọi handle lần hai; startup error giữ nguyên nếu cleanup sạch, nếu cleanup lỗi thì AggregateError giữ startup cause cùng mọi unwind error.
  - Blockers: không có.

2026-08-02 — Phase U, Task U.2 complete; Task U.3
  - Files: [`packages/cli/bin/vidcom.mjs`, `tests/e2e/mcp-stdio-host.test.ts`, `llm-documents/{product-features,specs-and-process}/**`]
  - Summary: Launcher được track `100755`; e2e pack CLI vào temp sạch, kiểm execute bit, tạo host-local resolved `vidcom` command rồi dùng đúng command đó cho legacy/modern MCP và trusted approval. Bắt đầu EOF/stdout lifecycle M-15.
  - Verification: `git ls-files -s` trả `100755`; exact SDK-host smoke 1 file/1 test, full suite 66/467, typecheck, lint 0 errors và diff check đều exit 0.
  - Decisions: Phase 2 artifact chỉ đóng gói source CLI và dùng dependency graph đã cài của checkout; docs gọi đúng source-checkout launcher và giữ self-contained Node SEA ở Phase 4.
  - Blockers: không có.

2026-08-02 — Phase U, Task U.3 complete; Task U.4
  - Files: [`packages/mcp/src/stdio.ts`, `packages/cli/src/commands/mcp.ts`, `tests/{mcp/stdio-lifecycle,cli/mcp-commands}.test.ts`]
  - Summary: Stdio handle nay phát completion sau stdin EOF/stdout close/explicit close; CLI dùng cùng idempotent shutdown path cho host disconnect và signal, nên toàn bộ foundation cleanup và lease release vẫn chạy. Bắt đầu pre-start signal gate M-16.
  - Verification: focused 2 files/25 tests; full suite 67/471; typecheck, lint 0 errors và diff check exit 0.
  - Decisions: SDK transport vẫn sở hữu protocol wire; VidCom chỉ bọc process lifecycle quanh handle và không sửa dependency. Disconnect close listener trước, rồi composition root gọi exhaustive runtime stop idempotently.
  - Blockers: không có.

2026-08-02 — Phase U, Task U.4 complete; Task U.5
  - Files: [`packages/cli/src/{commands/mcp,startup}.ts`, `tests/cli/{mcp-commands,startup}.test.ts`]
  - Summary: Signal gate được cài trước startup; abort checkpoint giữa mỗi phase làm foundation unwind phần đã dựng. Repeated signals bị hấp thụ cho đến khi cleanup settle rồi mới gỡ handlers. Bắt đầu explicit-workspace fail-fast M-17.
  - Verification: focused 3 files/47 tests; full suite 67/474; typecheck, lint 0 errors, boundaries và diff check exit 0.
  - Decisions: không có hard-exit signal thứ hai; cả SIGINT/SIGTERM dùng một AbortController và một idempotent cleanup path. Cleanup failure vẫn propagate, chỉ exact abort reason sau cleanup sạch mới là normal shutdown.
  - Blockers: không có.

2026-08-02 — Phase U, Task U.5 complete; Task U.6
  - Files: [`packages/{core/src/domain/workspace-resolver,cli/src/workspace-selection}.ts`, `tests/{core/workspace-and-path-policy,cli/mcp-commands}.test.ts`]
  - Summary: Explicit candidate invalid nay là terminal selection error ở cả Core và CLI; CLI validate trước active/cwd/settings/foundation nên không fallback và không acquire lease. Bắt đầu targeted backup restore M-18.
  - Verification: focused 2 files/42 tests; full suite 67/475; typecheck, lint 0 errors, boundaries và diff check exit 0.
  - Decisions: explicit hợp lệ cũng bỏ đọc active/cwd; chỉ mode không explicit mới dùng saved active rồi marker-backed cwd. Error không echo absolute path.
  - Blockers: không có.

2026-08-02 — Phase U, Task U.6 complete; Task U.7
  - Files: [`packages/cli/src/commands/backup.ts`, `tests/cli/mcp-commands.test.ts`]
  - Summary: Restore preflight đọc/verify manifest, retention/revision link và registered marker-backed target trước writer runtime; valid restore mở đúng registration workspace với DB+lease+Core application tối thiểu. Bắt đầu stable/redacted stderr M-19.
  - Verification: focused 3 files/33 tests; full suite 67/475; typecheck, lint 0 errors, boundaries và diff check exit 0.
  - Decisions: backup restore không còn gọi active workspace resolver; không chạy bootstrap/reconcile/retention/jobs/scheduler/watcher/listener. Core restore vẫn verify lại sau lease để giữ defense-in-depth.
  - Blockers: không có.

2026-08-02 — Phase U complete; Phase V, Task V.1
  - Files: [`packages/cli/{bin/vidcom.mjs,src/main.ts}`, `tests/{cli/mcp-commands,e2e/mcp-stdio-host}.test.ts`]
  - Summary: Unexpected CLI failure luôn trả `internal_error` một dòng; source launcher suppress duy nhất exact SQLite ExperimentalWarning. E2E bỏ filter và khóa raw stderr cho MCP success lẫn real ENOTDIR failure. Bắt đầu 10-tool success matrix M-20.
  - Verification: focused 2 files/28 tests; full suite 67/476; typecheck, lint 0 errors, boundaries và diff check exit 0.
  - Decisions: CliInputError giữ stable public message sau newline folding; mọi non-input exception không công bố message/path/token/SQL. Warning khác vẫn đi qua original emitWarning.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.1 complete; Task V.2
  - Files: [`tests/mcp/support.ts`, `tests/mcp/{contract-matrix,negative-contract-matrix}.test.ts`]
  - Summary: Production Registry matrix nay chạy success-path cho đủ 10 tool qua legacy/modern × stdio/HTTP; destructive cells dùng grant deterministic và negative contract vẫn ở suite riêng. Bắt đầu đối chiếu actual-host wording M-21.
  - Verification: focused positive + negative matrix 2 files/8 tests và typecheck exit 0.
  - Decisions: fixture dùng production `registerVidcomTools` cùng Core use cases với project/read/write/approval state deterministic; mỗi cell khóa structured output và canonical text thay vì chấp nhận error như coverage giả.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.2 complete; Task V.3
  - Files: [`tests/e2e/mcp-stdio-host.test.ts`, Detailed Goals, checklist, `implementation-notes.html`]
  - Summary: Evidence được gọi đúng là exact installed MCP SDK-host harness; DoD/O.9/P.8 không còn claim actual Claude Code/Codex binary. Actual-host validation được ghi rõ là release-artifact gate chưa được Phase 2 chứng minh. Bắt đầu sửa stale Verification Matrix M-22.
  - Verification: exact SDK CLI smoke 1 file/2 tests, typecheck và git diff --check exit 0; wording scan không còn `real AI-host`/`AI host thật` trong spec evidence.
  - Decisions: không chạy user-installed Claude/Codex CLI vì config/auth/plugin state không hermetic; giữ bằng chứng mạnh nhất có thể tái hiện trong CI là SDK 1.30.0/client 2.0.0 spawn resolved command trên temp workspace/app-data.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.3 complete; Task V.4
  - Files: [`scripts/verify-spec-test-paths.mjs`, `package.json`, Phase Verification Matrix, MCP result goldens]
  - Summary: Thay toàn bộ stale focused paths ở C/D/E/G/H/J bằng owner tests hiện hữu; guard parse đủ A→P và fail nếu bất kỳ test path biến mất. Rerun từng focused row A→O; cập nhật result goldens từ missing-project sang V.1 success fixture. Bắt đầu approval fact v6 M-23.
  - Verification: existence guard 37 paths/16 phases; A→O lần lượt 8, 5, 27, 17, 34, 25, 58, 21, 15, 65, 20, 25, 11+23 golden, 37, 49 tests — mọi gate exit 0; typecheck và diff check exit 0.
  - Decisions: guard chỉ đọc canonical Phase Verification Matrix, không cố validate lịch sử Execution Log; P chạy guard trước static/full/runtime gates để file rename làm CI đỏ ngay.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.4 complete; Task V.5
  - Files: [Detailed Goals, Detailed Design, Implementation Checklist, main in-process spec]
  - Summary: Bốn canonical spec surfaces nay cùng một fact: người dùng duyệt Design v6 + checklist bằng `/goal` ngày 2026-08-02 và chính lệnh đó authorize Code Execution A→P. Xóa mọi câu v6 “chờ tái xác nhận”/`Pending Confirmation`. Bắt đầu script matrix L-05.
  - Verification: cross-document approval wording scan không còn trạng thái mâu thuẫn; git diff --check exit 0.
  - Decisions: phân biệt Goals reconfirmation với Design v6/checklist execution authorization nhưng cùng khóa một ngày và một user action; Design v7 là remediation record sau review, không viết lại approval history v6.
  - Blockers: không có.

2026-08-02 — Phase V dependency-order correction
  - Files: [Phase V task order]
  - Summary: Chuyển M-24 exact-final-SHA/remote-CI xuống sau L-05/L-06/L-08; push trước ba local mutations còn lại sẽ làm HEAD evidence stale ngay lập tức.
  - Verification: Phase V vẫn có đúng một task `[/]`; task count và finding mapping không đổi.
  - Decisions: giữ nguyên finding IDs và scope, chỉ sửa closeout dependency order thành local scripts/docs/runtime → final commit/push/remote CI.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.5 complete; Task V.6
  - Files: [`package.json`]
  - Summary: Named `test:mcp-contract` gate nay chạy thật success 2×2 matrix, negative matrix và revision-pin bên cạnh Registry/transports/audit/executable smoke. Bắt đầu notes ordering L-06.
  - Verification: dedicated MCP contract gate 9 files/71 tests, typecheck và git diff --check exit 0.
  - Decisions: giữ focused gate explicit thay vì gọi toàn bộ test để CI failure nêu đúng contract surface bị drift.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.6 complete; Task V.7
  - Files: [`implementation-notes.html`]
  - Summary: Thêm visible sequence index canonical A→P→R→V, tự gắn sequence/anchor cho mọi section trong khi giữ physical append history nguyên vẹn. Bắt đầu runtime smoke L-08.
  - Verification: index parser nhận đủ 91/91 headings; first order A-start/A-complete/B/C/D và tail V.1→V.5; git diff --check exit 0.
  - Decisions: không di chuyển 91 historical sections vì dễ tạo diff/noise và làm mất append provenance; deterministic index dựa phase/task number, stable tie-break theo source order.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.7 complete; Task V.8
  - Files: [`scripts/{verify-next-runtime,runtime-smoke-process}.mjs`, `tests/e2e/runtime-smoke-process.test.ts`]
  - Summary: Production Next smoke dùng exact legacy client tại entry và modern client tại exact/latest, gọi list_projects bằng bearer rồi đọc SQLite xác nhận ba audit rows giữ đúng credential/protocol. Shutdown timeout nay SIGKILL nhưng vẫn fail. Bắt đầu final SHA/remote CI M-24.
  - Verification: production build + runtime smoke exit 0 (`legacy + modern exact/latest`, audit credential, SSE 1→2); hard-kill regression 1/1; typecheck, focused lint và diff check exit 0.
  - Decisions: dùng official installed clients thay raw JSON request để chứng minh negotiation; read-only DatabaseSync chỉ quan sát audit sau tool calls; graceful-timeout luôn là smoke failure kể cả hard kill thành công.
  - Blockers: không có.

2026-08-02 — Phase V, Task V.8 complete; 183/183 tasks
  - Files: [`spec-mcp-server-implementation-checklist.md`, `implementation-notes.html`, `spec-mcp-server-complete.md`, `spec-mcp-server-{detailed-goal,detailed-design}.md`]
  - Summary: Đóng M-24 và toàn bộ remediation: 43/43 finding có raw-to-fix traceability/regression evidence; spec chuyển `inprocess` → `complete` sau khi implementation SHA đã xanh local và remote.
  - Verification: full local matrix trên `90e5594685c99a110149da5ba57b19ba2548d964` exit 0 — spec-path guard 37 paths/16 phases, typecheck/boundaries/schema-drift/build/runtime/diff check xanh, full test 68 files/477 tests, golden 6 files/23 tests; CI push run `30752396368` Success 3m13s trên exact SHA đó.
  - Decisions: closeout là docs-only commit; chạy lại full matrix rồi push/xác minh CI trên exact final HEAD trước khi đóng goal. Không tạo commit evidence tự tham chiếu vô hạn; final HEAD/run được lưu trong GitHub CI và báo cáo closeout.
  - Blockers: không có.

Format:
```text
YYYY-MM-DD — Phase X, Task X.n
  - Files: [...]
  - Summary: [...]
  - Verification: [...]
  - Decisions: [design drift và section đã cập nhật]
  - Blockers: [...]
```
