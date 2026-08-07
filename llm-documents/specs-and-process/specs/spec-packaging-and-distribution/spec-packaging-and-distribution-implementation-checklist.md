# Spec Packaging & Distribution Runtime — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) — bản 4, **Approved 2026-08-07** (R2.14 sửa sau khi duyệt, cùng ngày)
> - [Detailed Design](./spec-packaging-and-distribution-detailed-design.md) — bản 2, **Approved 2026-08-07**, gate §15 · **+ phụ lục sửa §16 (bản 2.1, cùng ngày)** — 5 chỗ bản 2 nói khác code thật, đọc trước khi bắt đầu Phase A và Phase I
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

## Năm chỗ Design bản 2 nói khác code — đã sửa, đọc trước khi code

> [!IMPORTANT]
> Phát hiện khi review checklist (2026-08-07), đã sửa vào [Design §16](./spec-packaging-and-distribution-detailed-design.md) và vào các task tương ứng dưới đây. Không món nào mở lại phạm vi; tổng vẫn **177 SP**. Liệt kê ở đây vì dev đọc checklist trước khi đọc phụ lục Design.

| # | Bản 2 nói | Code thật | Task chịu trách nhiệm |
|---|---|---|---|
| C-1 | `mcp` được import `adapter`, nên `DaemonClient` ở `adapter/daemon` là dùng chung được | `mcp` **bị cấm** import `adapter`, cấm theo **prefix đường dẫn** nên `adapter/daemon` không thoát được. `packages/mcp/package.json` cũng không khai `adapter`. Luật này đã được chốt vào [steering/02](../../../steering/02-project-layout.md) §2 luật 3 + §2.1 ngày 2026-08-07 (trước đó ba nguồn nói khác nhau — xem N-A) | **I.2, I.2b, I.7a** |
| C-2 | "Chuyển schema tool sang `contracts`" là việc của giai đoạn này | Đã xong từ trước: `registry/schemas.ts` chỉ re-export `contracts`, `packages/mcp` không có `z.object` nào | **A.4** |
| C-3 | Giai đoạn 4 thêm hai dependency | `@hono/node-server@2.0.12` đã có trong `packages/server`. Chỉ `tar` là mới | **B.1** |
| C-4 | `workspace_lease_lost` là mã lỗi phải thêm | `contracts/src/errors.ts` đã có `WorkspaceLeaseLost` | **A.1** |
| C-5 | Harness browser là thứ phải dựng từ đầu | `puppeteer-core@25.4.0` đã là devDependency; `spikes/phase-4/s9-windows-runtime/cookie-probe.mjs` là harness chạy được | **G.0** |

**Và bốn thứ hạ tầng mà bản trước của checklist này giả định có sẵn nhưng thực ra không có** — mỗi thứ giờ có task tường minh, vì "verify bằng lệnh không tồn tại" là gate giả:

| Thiếu | Ai tạo |
|---|---|
| `bun run build:artifact` | **H.0** |
| `bun run test:browser-session` | **G.0** |
| `bun run test:packaged-smoke` | **M.0** |
| Spec này chưa được đăng ký vào [`scripts/verify-spec-test-paths.mjs`](../../../../scripts/verify-spec-test-paths.mjs) (gate chỉ biết 2 spec cũ) | **L.6** |

## Approval Gate

> Không viết production code cho tới khi mục này được người dùng xác nhận tường minh.

- **Status**: **Pending Confirmation**
- **Confirmed by**: —
- **Confirmation date**: —
- **Notes**: Design gate §15 đã mở (alvin0, 2026-08-07) nên checklist này được phép tồn tại. Nhưng **Code Execution vẫn bị chặn** cho tới khi chính mục này được duyệt — đây là gate thứ hai và độc lập.

**Bản này (2026-08-07, sau review) đã đóng năm câu hỏi mà trước đó dev buộc phải hỏi lại giữa lúc code.** Duyệt mục này nghĩa là duyệt cả năm quyết định sau:

| Câu hỏi trước đây | Quyết định trong bản này | Vì sao chọn thế |
|---|---|---|
| `DaemonClient` đặt đâu để `mcp` gọi được mà không đỏ `test:boundaries`? | **`mcp` không gọi nó.** Hiện thực ở `adapter/daemon`, interface `ToolInvoker` ở `mcp`, hiện thực remote ở `cli` (I.2, I.2b) | Đây là **giao** của bảng steering và gate đang chạy, nên hợp lệ với cả hai và không cần nới gate |
| Harness browser của G.9 dùng gì? | **`puppeteer-core@25.4.0` đã có trong repo** + `chrome-headless-shell` từ cache HyperFrames, port từ `cookie-probe.mjs` của S9 (G.0) | Không mở dependency mới; `SameSite` chỉ browser thật cưỡng chế được nên không có đường thay thế |
| Ba `bun run …` trong Verification Matrix không tồn tại thì ai tạo? | **G.0 / H.0 / M.0**, và cột "Ai tạo" trong Verification Matrix chỉ rõ | Gate chạy bằng lệnh không tồn tại là gate giả |
| A.4 chuyển schema tool — chuyển cái gì khi chúng đã ở `contracts`? | **Rescope**: không di chuyển gì; thêm catalogue `tên tool → schema` + gate hồi quy `test:mcp-catalogue`/`test:golden` (A.4, A.8) | Việc thật là làm route bridge map được `:name`, không phải di chuyển file |
| Hai breaking change C.4 và F.5 ảnh hưởng ai? | Danh sách caller cụ thể nằm ngay trong task (C.4b, F.5b), kèm 3 điểm test đang dùng nhánh `{path}` | Đã rà trên code, không để dev tự tìm |

## Sequencing Strategy

**Chosen strategy**: **Hybrid — Foundation-First + Risk-First**.

**Rationale**: runtime phải có mặt trên đĩa trước khi bất cứ thứ gì khác chạy được trên artifact (Foundation-First: A → B → C). Nhưng **Phase D được kéo lên ngay sau C** dù nhiều phase khác cũng chỉ phụ thuộc C: nó chứa cả ba chế độ hỏng-im-lặng đã đo được, và nếu chúng lộ ra ở tuần cuối thì mọi phase render/TTS/doctor phía sau đã xây trên cát. Bề mặt UI và bridge chỉ nối sau khi Core chứng minh được ba bất biến: extraction nguyên tử, đúng một writer, và toolchain gọi được từ artifact.

## Dependency Order

```text
A Contract & error baseline
└─→ B Runtime manifest + archive + extraction — GATE
    └─→ C Bootstrap ordering + hai lock + credential reconciliation — GATE
        ├─→ D Toolchain từ artifact — GATE  (rủi ro cao nhất, kéo lên sớm)
        │   └─→ J CLI mode + doctor          ← cần CẢ D và I, xem cạnh I ─→ J dưới
        └─→ E Host/foundation split + lease loss ba lối — GATE
            ├─→ F Filesystem browser API
            │   └─→ G Frontend: http-driver + export + picker + New video
            │       └─→ H SEA build + static asset host
            ├─→ I Daemon discovery + bridge + attachment
            │   └─→ J CLI mode + doctor      ← `render` là thin client của DaemonClient (I.2)
            └─→ K Import project
H ─→ L Hygiene & provenance
tất cả ─→ M Packaged smoke ba nền tảng
```

> **J có hai tiền đề, không phải một.** Cạnh `I ─→ J` từng thiếu trong bản trước: J.3 (`render` thin client) gọi `DaemonClient` do I.2 sinh ra, nên bắt đầu J trước khi I xanh là tự dựng client thứ hai rồi phải xoá. `Recommended execution order` bên dưới đã đúng; chỉ đồ hình sai.

**Recommended execution order**: A → B → C → **D** → E → F → G → H → I → J → K → L → M

> D đứng trước E dù E không phụ thuộc D: D là chỗ duy nhất trong spec có **ba chế độ hỏng không sinh lỗi**, và giá trị lõi của sản phẩm (render ra MP4 có tiếng) nằm sau nó. Phát hiện muộn ở đây đắt hơn mọi phase khác.

**Parallelizable**: D song song được với E/F sau khi C xanh (khác package, khác file). K song song được với I sau khi E xanh. L song song được với I/J/K sau khi H xanh.

---

## LLM Agent — Skill Activation Per Phase

> [!IMPORTANT]
> Trước khi implement mỗi phase, MUST activate skill tương ứng và đọc file nguồn liệt kê ở cột phải.

| Phase | Skills to activate | Source files to read BEFORE modifying |
|---|---|---|
| A | — | [`contracts/src/errors.ts`](../../../../packages/contracts/src/errors.ts) (FULL — 56 `ErrorCode` đang có, **gồm `WorkspaceLeaseLost`**) · [`contracts/src/delivery-loop-http.ts`](../../../../packages/contracts/src/delivery-loop-http.ts) (FULL) · [`mcp/src/registry/schemas.ts`](../../../../packages/mcp/src/registry/schemas.ts) + [`registry/read-tools.ts`](../../../../packages/mcp/src/registry/read-tools.ts) (FULL — bằng chứng schema đã ở `contracts`) · [`core/src/port/types.ts`](../../../../packages/core/src/port/types.ts) (search `ErrorCode` — chỉ tiêu thụ) |
| B | `.agents/skills/bun/SKILL.md` | [`credential-store.ts`](../../../../packages/adapter/src/fs/credential-store.ts) (FULL — `secureAppDataDirectorySync` là mẫu ACL) · [spike S1b](../../../../spikes/phase-4/README.md) |
| C | — | [`workspace-selection.ts`](../../../../packages/cli/src/workspace-selection.ts) (FULL — migrate 2 lần + ghi `active_workspace` là tác dụng phụ) · [`mcp-credential-service.ts`](../../../../packages/core/src/service/mcp-credential-service.ts) (FULL) · [`db/mcp-credential.ts`](../../../../packages/adapter/src/db/mcp-credential.ts) (FULL) |
| D | `.agents/skills/bun/SKILL.md` | [`binary-probe.ts`](../../../../packages/adapter/src/hyperframes/binary-probe.ts) (FULL — **hai** chỗ spawn) · [`vieneu-sidecar-path.ts`](../../../../packages/adapter/src/tts/vieneu-sidecar-path.ts) (FULL) · [`process-environment.ts`](../../../../packages/adapter/src/runtime/process-environment.ts) (FULL) · [`tts-vieneu.ts`](../../../../packages/adapter/src/tts/tts-vieneu.ts) (search `HF_HOME`) · [S1a/S1b/S3](../../../../spikes/phase-4/README.md) |
| E | `.agents/skills/hono/SKILL.md` | [`startup.ts`](../../../../packages/cli/src/startup.ts) (FULL — `createInfrastructure`/`createApplication` nướng root+leaseId) · [`next-host.ts`](../../../../packages/cli/src/next-host.ts) (FULL — `onLeaseLost` hiện giữ listener) · [S6](../../../../spikes/phase-4/README.md) |
| F | `.agents/skills/hono/SKILL.md` | [`workspace-resolver.ts`](../../../../packages/core/src/domain/workspace-resolver.ts) (FULL) · [`workspace-fs.ts`](../../../../packages/adapter/src/fs/workspace-fs.ts) (search `resolveWorkspace`) · [S8 worker eval](../../../../spikes/phase-4/README.md) |
| G | `.agents/skills/http-driver/SKILL.md` | [`src/lib/api/browser-session.ts`](../../../../src/lib/api/browser-session.ts) (FULL) · [`src/app/projects/[slug]/page.tsx`](../../../../src/app/projects/%5Bslug%5D/page.tsx) (FULL — đang là `"use client"`) · [`new-project-card.tsx`](../../../../src/components/home/new-project-card.tsx) (FULL) · [`vitest.config.ts`](../../../../vitest.config.ts) (FULL — `environment: "node"` toàn cục, không có `jsdom`) · [`spikes/…/cookie-probe.mjs`](../../../../spikes/phase-4/s9-windows-runtime/cookie-probe.mjs) (**FULL — harness sẽ port vào `tests/`, đừng viết lại**) · [S2](../../../../spikes/phase-4/s2-export) · [S9 cookie matrix](../../../../spikes/phase-4/s9-windows-runtime/README.md) |
| H | `.agents/skills/bun/SKILL.md`, `.agents/skills/hono/SKILL.md` | [`next.config.ts`](../../../../next.config.ts) (FULL) · [`src/app/api/[[...route]]/route.ts`](../../../../src/app/api/%5B%5B...route%5D%5D/route.ts) (FULL — phải biến mất khỏi build export) · [spike phase-0 SEA](../../../../spikes/phase-0/README.md) |
| I | `.agents/skills/mcp-builder/SKILL.md` | **[`scripts/verify-import-boundaries.mjs`](../../../../scripts/verify-import-boundaries.mjs) (FULL — đọc `assertPackageImportAllowed` TRƯỚC khi tạo file nào)** · [`packages/mcp/package.json`](../../../../packages/mcp/package.json) + [`packages/cli/package.json`](../../../../packages/cli/package.json) (FULL — ai được thấy `adapter`) · [`commands/mcp.ts`](../../../../packages/cli/src/commands/mcp.ts) (FULL — `createMcpRegistry` được inject ở `openListener`) · [`cli/src/composition-root.ts`](../../../../packages/cli/src/composition-root.ts) (search `createMcpRegistry`) · [`mcp/src/registry/registry.ts`](../../../../packages/mcp/src/registry/registry.ts) (search `invoke` — chữ ký mà `ToolInvoker` phải khớp) · [`commands/credential.ts`](../../../../packages/cli/src/commands/credential.ts) (FULL) · [steering/13](../../../steering/13-mcp-protocol-compatibility.md) (FULL) · [S7](../../../../spikes/phase-4/README.md) |
| J | — | [`main.ts`](../../../../packages/cli/src/main.ts) (FULL — `parseVidcomCommand` coi mọi `--` là `app`) · [`project-reads.ts`](../../../../packages/core/src/usecase/project-reads.ts) (search `resolveProjectIdBySlug`) |
| K | — | [`db/schema.ts`](../../../../packages/adapter/src/db/schema.ts) (search `workspace_operation`, `uq_job_idempotency`) · [`bootstrap-project.ts`](../../../../packages/core/src/usecase/bootstrap-project.ts) (FULL) |
| L | — | [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml) (FULL) · [`scripts/verify-spec-test-paths.mjs`](../../../../scripts/verify-spec-test-paths.mjs) (FULL — mẫu đăng ký spec, 2 spec đang có) |
| M | — | [`.github/workflows/phase4-python-stack.yml`](../../../../.github/workflows/phase4-python-stack.yml) (FULL — mẫu job đo đã chạy thật) · [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md) |

**Steering đọc một lần trước khi bắt đầu**: [01 stack](../../../steering/01-backend-stack.md) §3 (bốn câu hỏi dependency), §5 (danh sách cấm) · [02 layout](../../../steering/02-project-layout.md) §2 (**import boundary — lint cưỡng chế**) · [03 DDD](../../../steering/03-architecture-ddd.md) §2.2 · [04 API](../../../steering/04-api-design.md) §10 (thứ tự middleware) · [06 validation](../../../steering/06-validation.md) §2, §5 · [07 data](../../../steering/07-data-and-storage.md) §0 (**schema strict**) · [08 jobs](../../../steering/08-jobs-and-queue.md) §6.1 (**zero-survivor đã bị rút lại**) · [09 security](../../../steering/09-security.md) §2 · [10 testing](../../../steering/10-testing.md) · [11 code style](../../../steering/11-code-style.md).

---

## Phase Verification Matrix

Mỗi phase chạy focused command dưới đây trên SQLite/filesystem thật, rồi `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run test:boundaries` khi chạm boundary, và `rtk git diff --check`. Phase M chạy toàn bộ gate trên ba OS qua GitHub Actions.

> [!WARNING]
> **Ba lệnh có dấu † chưa tồn tại trong [`package.json`](../../../../package.json).** Repo hôm nay có 20 script và không có script nào trong số đó. Task tạo chúng nằm ngay trong phase tương ứng và **phải làm trước** mọi task khác của phase đó, nếu không thì "verify" của phase là câu lệnh không chạy được.
>
> Tương tự, `tests/frontend/` và `tests/build/` là **thư mục mới** — `tests/` hôm nay chỉ có `adapter, agent-kit, cli, contracts, core, e2e, golden, mcp, server, support`. [`vitest.config.ts`](../../../../vitest.config.ts) đặt `environment: "node"` **toàn cục** và repo **không có `jsdom`/`happy-dom`**, nên test nào cần `window`/`location` phải đi qua seam inject (xem G.2), MUST NOT giả định môi trường DOM.

| Phase | Focused verification command | Lệnh/thư mục phải tạo trước |
|---|---|---|
| A | `rtk bunx vitest run tests/contracts/packaging-contracts.test.ts` **và** `rtk bun run test:mcp-contract` **và** `rtk bun run test:golden` — hai cái sau là gate hồi quy cho A.4 | — |
| B | `rtk bunx vitest run tests/adapter/runtime-archive.test.ts tests/adapter/runtime-asset-manager.test.ts` | — |
| C | `rtk bunx vitest run tests/adapter/bootstrap-coordinator.test.ts tests/adapter/bridge-credential-lifecycle.test.ts tests/adapter/database-migration.test.ts` | — |
| D | `rtk bunx vitest run tests/adapter/vidcom-node-shim.test.ts tests/adapter/compiler-guard.test.ts tests/adapter/render-binary-probe.test.ts tests/adapter/vieneu-frozen-interpreter.test.ts` | — |
| E | `rtk bunx vitest run tests/cli/foundation-manager.test.ts tests/cli/loopback-host.test.ts tests/cli/lease-loss.test.ts` | — |
| F | `rtk bunx vitest run tests/core/filesystem-browser.test.ts tests/server/system-routes.test.ts tests/adapter/browse-worker.test.ts` | — |
| G | `rtk bunx vitest run tests/frontend/api-driver.test.ts` và `rtk bun run test:browser-session` **†** (→ `tests/frontend/browser-session.test.ts`) | thư mục `tests/frontend/` + script `test:browser-session` + harness `tests/support/browser-harness.ts` → **G.0** |
| H | `rtk bunx vitest run tests/adapter/sea-static-host.test.ts tests/server/payload-limits.test.ts` và `rtk bun run build:artifact` **†** | script `build:artifact` → **H.0** |
| I | `rtk bunx vitest run tests/adapter/daemon-discovery.test.ts tests/mcp/bridge-registry-parity.test.ts tests/cli/bridge-attachment.test.ts tests/cli/remote-tool-invoker.test.ts` **và** `rtk bun run test:boundaries` | — |
| J | `rtk bunx vitest run tests/cli/cli-modes.test.ts tests/cli/doctor.test.ts tests/golden/doctor-report.test.ts` | — |
| K | `rtk bunx vitest run tests/adapter/project-import.test.ts tests/adapter/workspace-mutation-coordinator.test.ts` | — |
| L | `rtk bunx vitest run tests/build/artifact-provenance.test.ts` **và** `rtk bun run test:spec-paths` | thư mục `tests/build/` + đăng ký spec vào gate → **L.6** |
| M | `rtk bun run test:packaged-smoke` **†** trên macOS arm64, Windows x64, Linux x64 | script + `scripts/packaged-smoke/**` → **M.0** |

> **Bảng này bị một gate đọc.** [`scripts/verify-spec-test-paths.mjs`](../../../../scripts/verify-spec-test-paths.mjs) parse đúng section này của các spec đã đăng ký, đối chiếu chuỗi phase và kiểm **mọi** đường dẫn dạng `tests/…` phải tồn tại thật.
>
> **Viết prose trong section này phải cẩn thận**: gate quét bằng regex `tests\/[A-Za-z0-9._/-]+` trên **toàn bộ** đoạn từ heading này tới `## Task Status Legend`, kể cả văn xuôi và callout — một ví dụ giả trong câu văn cũng bị đòi phải tồn tại. Nên khi nói về đường dẫn chung chung, dùng dấu ellipsis `…`, **đừng** viết `tests` + `/` + ba dấu chấm: dạng đó khớp regex, rồi đỏ trên Linux nhưng **xanh trên Windows** (Windows tự cắt dấu chấm ở cuối tên). Đúng loại lệch nền tảng mà cả giai đoạn này tồn tại để bắt. Sau khi L.6 đăng ký spec này (`phases: "ABCDEFGHIJKLM"`), mỗi lần thêm/đổi một đường dẫn ở bảng trên mà chưa có file tương ứng là `test:spec-paths` đỏ. Đó là lý do L.6 nằm ở **cuối**: đăng ký sớm thì gate đỏ suốt mười hai phase.

---

## Task Status Legend

- `[ ]` — Not started
- `[/]` — In progress
- `[x]` — Complete (implemented, tested, validated)
- `[!]` — Blocked (kèm ghi chú nêu blocker)

---

## Phase A: Contract & error baseline

**Addresses**: R1.7, R2.x, R3.8, R6.5 · **Design**: §5.0, §7.0, §8.1, §16 (C-2, C-4)
**Files affected**: `packages/contracts/src/errors.ts` (nơi `ErrorCode` **được khai báo**), `packages/contracts/src/mcp.ts`, `packages/contracts/src/dto.ts`, `packages/contracts/src/settings.ts`, `packages/core/src/port/types.ts` (chỉ **tiêu thụ** `ErrorCode`: `errorCode: ErrorCode | null` ở audit entry và `error.code` ở job result)
**Prerequisite**: None
**Estimate**: 5 SP

**Tasks**:
- [ ] A.1 Thêm `ErrorCode` mới vào [`packages/contracts/src/errors.ts`](../../../../packages/contracts/src/errors.ts)
  - `bridge_credential_unavailable`, `bridge_credential_invalid`, `bridge_rotation_in_progress`, `download_tls_untrusted`, `payload_too_large`, `daemon_identity_mismatch`, `daemon_unavailable`, `compiler_unavailable`, `runtime_manifest_invalid`, `runtime_extraction_incomplete`, `bootstrap_lock_timeout`, `path_timeout`, `browse_token_invalid`, `project_import_conflict` — **14 mã, không phải 15**
  - **`workspace_lease_lost` đã tồn tại** (`WorkspaceLeaseLost = "workspace_lease_lost"`, cùng file). Design §8.1 liệt nó như mã mới; đó là C-4 ở §16. Thêm lần nữa là lỗi biên dịch, nên đây không phải chi tiết vô hại
  - `ErrorCode` là **`enum`**, member PascalCase, value snake_case — theo đúng 56 member đang có, MUST NOT dùng union string cho mã mới
  - Hai cặp dễ nhập nhằng, ghi lý do vào chỗ khai báo để lần sau không ai gộp: `payload_too_large` (giới hạn **body HTTP**, kèm giới hạn thật trong `details`) khác `TooLarge = "too_large"` (**asset** vượt hạn mức của project); `bridge_credential_invalid` (bearer của **bridge**, có đường xoay ở C.6) khác `CredentialInvalid = "credential_invalid"` (credential MCP của người dùng)
  - _Requirements: R1.7, R2.7, R6.5_ — _Design: §8.1, §16 C-4_
- [ ] A.2 Thêm DTO của R1 vào `contracts`
  - `BrowseRootDto`, `BrowseEntryDto`, `BrowsePage`, request/response của §7.1–§7.3, `SystemWorkspaceDto` với state union **gồm `reacquiring`**, `SystemRuntimeDto`
  - Mọi schema **`strict`** — field lạ bị từ chối, không bỏ qua âm thầm
  - _Requirements: R1.1, R1.2, R1.7_ — _Design: §7.1–§7.4, §7.7b_
- [ ] A.3 Thêm DTO của bridge vào `contracts`
  - Handshake request/response, attachment create/renew, tool invoke envelope
  - _Requirements: R2.13, R2.15_ — _Design: §7.8–§7.10_
- [ ] A.4 **Catalogue `tên tool → schema` trong `contracts`** — *không phải* di chuyển schema
  - **Đọc trước khi làm**: việc "chuyển schema sang `contracts`" mà Design bản 2 giao cho giai đoạn này **đã xong từ trước** (C-2 ở §16). Bằng chứng: [`packages/mcp/src/registry/schemas.ts`](../../../../packages/mcp/src/registry/schemas.ts) chỉ có `export * from "@vidcom/contracts"`; [`read-tools.ts`](../../../../packages/mcp/src/registry/read-tools.ts) đã import `ListProjectsInputSchema`/`ListProjectsOutputSchema` từ `contracts`; và **không có một `z.object`/`z.strictObject` nào** trong `packages/mcp`. Bắt đầu bằng cách "chuyển" là sửa thứ không hỏng
  - **Việc thật**: route `/api/bridge/v1/tools/:name` bên `server` nhận `:name` là **string lúc runtime** và phải map nó sang schema. Hôm nay chỉ `ToolRegistry.definitions` (ở `packages/mcp`) làm được việc đó, mà lint cấm `server` import `mcp`. Nên `contracts` phải xuất một map tường minh:

    ```ts
    // packages/contracts/src/mcp.ts
    export const TOOL_SCHEMA_CATALOGUE = {
      list_projects: { input: ListProjectsInputSchema, output: ListProjectsOutputSchema, level: "read" },
      // …một entry cho mỗi tool đang đăng ký
    } as const satisfies Record<string, ToolSchemaEntry>;
    ```

  - **`ToolDefinition`/handler/annotations ở lại `packages/mcp`** — chỉ map schema đi ra. Registry SHALL đọc catalogue này thay vì khai lại, nếu không là hai nguồn sự thật cho cùng một tên tool
  - Kèm test: **mọi** tool trong `ToolRegistry` có entry trong catalogue và ngược lại. Thiếu chiều nào thì một tool mới sẽ lặng lẽ 404 ở route bridge trong khi vẫn chạy qua stdio
  - _Requirements: R2.3, R2.11_ — _Design: §5.0 hệ quả 1, §16 C-2_
- [ ] A.5 Thêm `runtime.caBundlePath` vào schema `setting.json` + env `VIDCOM_CA_BUNDLE`
  - `setting.json` là **schema strict** ([steering/07](../../../steering/07-data-and-storage.md) §0): key lạ là **lỗi khởi động**, nên không thêm vào schema thì người dùng làm theo hướng dẫn của `doctor` sẽ không boot được
  - _Requirements: R6.5_ — _Design: §5.13_
- [ ] A.6 Thêm event mới vào contract SSE
  - `workspace.lease_lost`, `workspace.reattached`, `runtime.preparing`, `runtime.ready`
  - _Requirements: R2.8, R5.11_ — _Design: §7.7_
- [ ] A.7 Contract test
  - Mọi schema mới từ chối field lạ; state union có đủ 6 giá trị; error code round-trip
  - _Requirements: R1.7_
- [ ] A.8 **Gate hồi quy cho A.4** — đây là chỗ Phase A có thể phá thứ đang chạy
  - A.4 chạm nguồn sự thật của tool schema, mà repo đang pin shape đó bằng **mười** file test: [`tests/mcp/golden/tools-list.test.ts`](../../../../tests/mcp/golden/tools-list.test.ts) (snapshot `tools/list`) và 9 file trong `test:mcp-contract` (`contract-matrix`, `negative-contract-matrix`, `revision-pin`, `registry`, `ci-guards`, `legacy-transport`, `modern-transport`, `e2e/mcp-stdio-host`, `core/write-authority`)
  - Chạy `rtk bun run test:mcp-contract` và `rtk bun run test:golden` **trước** khi sửa để có mốc, rồi sau khi sửa. Snapshot `tools/list` MUST giữ **nguyên xi**: catalogue là refactor nội bộ, agent bên ngoài không được thấy gì khác
  - Nếu snapshot đổi thì **dừng và báo**, MUST NOT cập nhật snapshot cho khớp code mới — đó là cách một breaking change đi qua mà không ai duyệt
  - Thêm `tests/contracts/tool-schema-catalogue.test.ts` cho hai chiều đối chiếu ở A.4, và script `"test:mcp-catalogue"` gọi riêng nó vào [`package.json`](../../../../package.json)
  - _Requirements: R2.3, R2.11_ — _Design: §16 C-2_

**Acceptance Criteria**:
- [ ] `rtk bun run typecheck` xanh — mọi `switch` trên `ErrorCode` đã xử lý nhánh mới
- [ ] `rtk bun run test:boundaries` xanh — `server` **không** import `mcp`, `mcp` **không** import `adapter`
- [ ] `rtk bun run test:mcp-contract` và `rtk bun run test:golden` xanh, và snapshot `tools/list` **không đổi một byte** so với `HEAD` trước Phase A
- [ ] [`packages/contracts/package.json`](../../../../packages/contracts/package.json) vẫn chỉ có `zod@4.4.3` — catalogue không được lôi thêm gì vào package mà mọi package khác đều import

**Deliverables**: `packages/contracts/src/errors.ts` · `packages/contracts/src/mcp.ts` · `packages/contracts/src/dto.ts` · `tests/contracts/**`

---

## Phase B: Runtime manifest + archive + extraction — **GATE**

**Addresses**: R5.1–R5.6, R5.9, R5.10, R5.12 · **Design**: §4.5, §5.13, §5.14
**Files affected**: `packages/adapter/src/runtime/runtime-asset-*.ts`, `scripts/build-runtime-archives.mjs`, `package.json`
**Prerequisite**: A
**Estimate**: 13 SP

**Tasks**:
- [ ] B.1 Nâng `tar@7.5.22` thành dependency trực tiếp — **món dependency mới duy nhất của cả giai đoạn**
  - Bốn câu hỏi của [steering/01](../../../steering/01-backend-stack.md) §3 đã trả lời ở Design §5.0 — chép kết luận vào commit message, không trả lời lại
  - `@hono/node-server` **không phải việc phải làm**: [`packages/server/package.json`](../../../../packages/server/package.json) đã khai `2.0.12`. Design bản 2 viết "thêm hai" là C-3 ở §16. Đừng thêm lần nữa, và nhất là đừng để `bun add` nới pin `hono@4.12.33` — spike S9 đã ghi lại đúng cái bẫy đó
  - Pin **chính xác** `7.5.22`, không `^`: nó chạy trong binary đã compile
  - _Requirements: R5.1_ — _Design: §5.0, §4.5, §16 C-3_
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
**Files affected**: `packages/cli/src/bootstrap-coordinator.ts`, `packages/cli/src/workspace-selection.ts`, `packages/adapter/src/fs/credential-store.ts`. C.4b chỉ **ghi lại** yêu cầu về help của `--workspace`; file `commands/render.ts` **chưa tồn tại** (`commands/` hôm nay có `approve, backup, credential, mcp, recovery`) và được tạo ở J.3 — nên phần help thực thi ở J.3, không ở đây
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
  - Hôm nay resolve nào cũng `set("active_workspace", …)` ([`workspace-selection.ts:58`](../../../../packages/cli/src/workspace-selection.ts#L58)), nên `vidcom render --workspace X` **đổi luôn workspace mặc định của UI**. Chỉ `FoundationManager.activate` thành công mới được ghi
  - Đây là **thay đổi hành vi có chủ ý**, không phải bất biến giữ nguyên
  - _Requirements: R1.5_ — _Design: §6.4, §7.13_
- [ ] C.4b Rà **toàn bộ** người đọc/ghi `active_workspace` trước khi đổi — danh sách đã rà sẵn, đừng tự tìm lại
  - **Ghi**: `workspace-selection.ts:58` (chỗ bị lấy đi) → chuyển sang `FoundationManager.activate` (E.4)
  - **Đọc**: `activeWorkspace()` ở [`workspace-selection.ts:23-28`](../../../../packages/cli/src/workspace-selection.ts#L23) (giữ nguyên — đọc vẫn đúng), [`workspace-resolver.ts`](../../../../packages/core/src/domain/workspace-resolver.ts) qua `input.active` + cảnh báo `active_workspace_unreadable`, và doctor check `workspace.active` (J.6)
  - **Test đang chốt hành vi cũ**: [`tests/adapter/project-discovery-state.test.ts:109-112`](../../../../tests/adapter/project-discovery-state.test.ts#L109) và [`tests/core/workspace-and-path-policy.test.ts:47-50`](../../../../tests/core/workspace-and-path-policy.test.ts#L47). Cả hai kiểm nhánh **đọc**, nên chúng SHALL vẫn xanh không cần sửa — **nếu phải sửa một trong hai thì dừng lại**: nghĩa là đã đổi luôn cả đường resolve chứ không chỉ đường ghi
  - Ghi một dòng vào release notes cùng chỗ với L.4. Help của `render` nói rõ `--workspace` **không** đổi mặc định của UI nữa — câu đó thực thi ở **J.3** vì `commands/render.ts` chưa tồn tại; ở đây chỉ chốt nội dung
  - _Requirements: R1.5_ — _Design: §7.13_
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
- [ ] D.3a Kiểu `RuntimePaths` + resolver hai chế độ
  - Một chỗ duy nhất trả `hyperframesCliPath`, `hyperframesPackagePath`, `motionLibraryRoot`, `nativeDependenciesRoot`, `browserCacheRoot`. Chế độ artifact: **bắt buộc đủ cả năm**, thiếu một là lỗi có mã lúc bootstrap, không phải lúc render. Chế độ dev/test: `require.resolve` như hôm nay
  - `require.resolve` MUST NOT còn xuất hiện trên đường artifact — test D.10 chứng minh bằng cách chạy resolver với `require.resolve` bị stub thành throw
  - _Requirements: R5.7, R6.3_ — _Design: §5.16_
- [ ] D.3b Truyền `RuntimePaths` từ **mọi** entrypoint
  - `app`, `serve`, `mcp`, `render`, `doctor` — mỗi cái một dòng, và đây là chỗ dễ làm sót đúng một cái rồi chỉ hỏng ở mode ít dùng nhất
  - `motionLibraryRoot` hôm nay **không entrypoint nào truyền** (bẫy 4.8): nó là lý do task này tách riêng khỏi D.3a. Resolver đúng mà không ai truyền thì `install_motion_library` vẫn hỏng y như cũ
  - Test: liệt kê entrypoint từ mode union của J.1 và chứng minh **không entrypoint nào** dựng `RuntimePaths` rỗng hay thiếu field
  - _Requirements: R5.8, R6.3_ — _Design: §5.16, §4.8_
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
**Files affected**: `packages/core/src/service/filesystem-browser.ts`, `packages/core/src/port/`, `packages/adapter/src/fs/`, `packages/server/src/routes/system.ts`, `packages/server/src/routes/delivery-loop.ts` + `tests/server/delivery-loop-routes.test.ts` (**breaking change F.5b**)
**Prerequisite**: E · trong phase: **F.3 trước F.5** (test của F.5b cần mint được `selectionToken`)
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
- [ ] F.5b Bốn điểm phải sửa cùng lúc với F.5 — **breaking change, đã rà sẵn caller**
  - [`packages/server/src/routes/delivery-loop.ts`](../../../../packages/server/src/routes/delivery-loop.ts) (route `put("/v1/workspace/active")`, hiện `parse(ActivateWorkspaceRequestSchema, …)` rồi gọi `dependencies.activateWorkspace(input.path)`) — đổi cả **chữ ký dependency**, không chỉ schema
  - `ActivateWorkspaceRequestSchema` trong `contracts` — đổi ở A.2, đây là chỗ tiêu thụ
  - [`tests/server/delivery-loop-routes.test.ts`](../../../../tests/server/delivery-loop-routes.test.ts) — **ba** chỗ đang gửi `body: JSON.stringify({ path: … })` (khoảng dòng 141, 255, 585). Cả ba SHALL đổi sang `selectionToken`, nghĩa là harness test cần mint được token qua `BrowseTokenStore` (F.3) ⇒ **F.3 phải xong trước F.5**
  - Bất kỳ chỗ nào trong `src/**` gọi service `v1.workspace.activate` (G.1) — catalog phải khai `selectionToken`, không phải `path`
  - Ghi vào release notes: một client cũ gửi `{path}` giờ nhận `schema_invalid`, **không** phải im lặng bỏ qua field lạ ([steering/07](../../../steering/07-data-and-storage.md) §0 schema strict)
  - _Requirements: R1.5_ — _Design: §7.5_
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
**Files affected**: `src/lib/api/**`, `src/app/**`, `src/components/home/new-project-card.tsx`, `next.config.ts`, `package.json` (script `test:browser-session`), `tests/frontend/**`, `tests/support/browser-harness.ts`
**Prerequisite**: F
**Estimate**: 12 SP

**Tasks**:
- [ ] G.0 **Harness browser + script `test:browser-session`** — làm trước G.1, vì nó là thứ verify mọi task còn lại của phase
  - **Công nghệ đã chốt, không mở lại**: `puppeteer-core@25.4.0` (**đã** là devDependency của repo) lái `chrome-headless-shell` thật. Không thêm Playwright, không thêm `jsdom`. `SameSite` **chỉ browser cưỡng chế được** — S9 đã chứng minh `curl` trả kết quả sai ở đây, nên không có đường thay thế nhẹ hơn
  - **Port từ [`spikes/phase-4/s9-windows-runtime/cookie-probe.mjs`](../../../../spikes/phase-4/s9-windows-runtime/cookie-probe.mjs)**, đừng viết lại: nó đã có sẵn daemon Hono trên port động + "next dev" giả trên `localhost:3000` + chuỗi `exchange → system/workspace → SSE` với `credentials: "include"`
  - Đường tới Chrome: **dùng `browserCacheRoot` của `RuntimePaths`** (D.3a, đã xong trước G) + thực thi `--version` để xác nhận binary chạy được, MUST NOT tin đường dẫn suông (bẫy S9/W-3). Env `CHROME_PATH` override cho máy dev. Tách helper này ra một chỗ vì **J.5c dùng lại đúng nó** cho check `chrome.cache` — hai đường resolve Chrome là hai chỗ để hỏng khác nhau
  - Chrome vắng mặt ⇒ test **`skipped` có lý do in ra**, MUST NOT xanh im lặng. Trong CI (`process.env.CI`) thì vắng mặt là **fail**, cùng luật với `VIDCOM_DOCTOR_STRICT` ở M.5
  - Thêm `"test:browser-session": "vitest run tests/frontend/browser-session.test.ts"` vào [`package.json`](../../../../package.json) và tạo `tests/frontend/`
  - _Requirements: R4.12, R1.10_ — _Design: §5.11, §16 C-5_
- [ ] G.1 Service catalog + http-driver
  - Một catalog `src/lib/api/services.ts`, id `v1.<domain>.<action>`; **không** bật automatic version injection (URL đã chứa `api/v1`, tránh `/v1/v1`)
  - _Requirements: R4.10_ — _Design: §5.11_
- [ ] G.2 Base URL là **runtime config**
  - `resolveApiBaseUrl()` đọc `window.__VIDCOM_API_BASE_URL__`, mặc định `location.origin`. Script chèn global chỉ render khi `NODE_ENV !== "production"` → production dead-code-eliminate. MUST NOT dùng `NEXT_PUBLIC_*`
  - **Chữ ký phải test được dưới `environment: "node"`**: [`vitest.config.ts`](../../../../vitest.config.ts) đặt node toàn cục và repo **không có `jsdom`/`happy-dom`**, nên hàm SHALL nhận nguồn qua tham số có mặc định — `resolveApiBaseUrl(source: { __VIDCOM_API_BASE_URL__?: string; location: { origin: string } } = globalThis as never)`. Đọc `window` trực tiếp trong thân hàm ⇒ `tests/frontend/api-driver.test.ts` không viết được, và cách "sửa" tự nhiên nhất là thêm `jsdom` — một dependency không ai duyệt
  - Chỉ **hai** test cần browser thật (G.0): cookie `SameSite` và SSE. Phần còn lại của driver là logic thuần, chạy dưới node
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
- [ ] G.9 Kịch bản trên harness của G.0
  - Nonce → session → xoá token khỏi URL; picker; New video **cả hai nhánh** thành công và thất bại; cross-origin dev giữ cookie ở fetch **và** SSE
  - Ma trận cookie lấy **đúng** bảng đã đo ở S9 làm kỳ vọng: `localhost:3000 → localhost:<port>` giữ được `SameSite=Strict`; `localhost:3000 → 127.0.0.1:<port>` **mất cookie dù `exchange` trả 200**. Vế thứ hai là test của G.3, và nó phải fail-at-boot chứ không phải fail-ở-request đầu
  - _Requirements: R1.10, R1.19, R4.10, R4.12_

**Acceptance Criteria**:
- [ ] Cùng một bundle chạy same-origin (artifact) và cross-origin (dev) chỉ bằng cấu hình
- [ ] `next build` với `output: "export"` xanh
- [ ] `rtk bun run test:browser-session` **chạy được** (script tồn tại, Chrome resolve được) và xanh
- [ ] Không thêm dependency nào vào [`package.json`](../../../../package.json) cho phase này ngoài script

**Deliverables**: `src/lib/api/services.ts` · `src/app/projects/[slug]/*` · `src/components/workspace-picker/*` · `next.config.ts` · `tests/support/browser-harness.ts` · `tests/frontend/{api-driver,browser-session}.test.ts` · script `test:browser-session`

---

## Phase H: SEA build + static asset host

**Addresses**: R4.1–R4.3, R4.6–R4.9, R4.14 · **Design**: §5.10, §9.1, DR-1
**Files affected**: `scripts/build-artifact.mjs`, `packages/cli/src/sea-static-host.ts`, `packages/server/src/middleware/body-limit.ts`, `package.json` (script `build:artifact`)
**Prerequisite**: G
**Estimate**: 13 SP

**Tasks**:
- [ ] H.0 Script `build:artifact` — làm trước H.1, vì mọi task sau đo bằng nó
  - Thêm `"build:artifact": "node scripts/build-artifact.mjs"` vào [`package.json`](../../../../package.json) — cùng dạng với các script `node scripts/*.mjs` đang có (`test:boundaries`, `test:schema-drift`, `test:spec-paths`, …). Nó SHALL gọi lần lượt: `scripts/build-runtime-archives.mjs` (B.3) → `next build` với `output: "export"` (G.6) → frontend pack (H.2) → bundle CJS (H.1) → SEA native (H.4) → `scripts/verify-artifact.mjs` (L.1/L.2)
  - **Fail-fast từng bước**, MUST NOT tiếp tục sang bước sau khi bước trước lỗi: một `frontend.pack` cũ đi cùng bundle mới là loại lỗi chỉ lộ ra ở packaged smoke
  - In ra đường dẫn artifact + platform tag ở `stderr`; `stdout` chỉ để `artifact-manifest.json` (L.2) nếu có `--json`
  - MUST NOT cross-build (DR-1): script chạy trên OS nào thì chỉ sinh artifact của OS đó, và **fail có mã** nếu được gọi với target khác `process.platform`
  - _Requirements: R4.1, R4.14_ — _Design: DR-1, §5.10_
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
**Files affected**: `packages/adapter/src/daemon/**` (thư mục mới trong `@vidcom/adapter`), `packages/adapter/src/fs/daemon-discovery.ts`, `packages/cli/src/bridge/**` (**hiện thực remote invoker ở đây, không ở `mcp`** — xem I.2b), `packages/mcp/src/registry/types.ts` (chỉ thêm `interface ToolInvoker`), `packages/cli/src/composition-root.ts`, `packages/cli/src/commands/mcp.ts`, `packages/server/src/routes/bridge.ts`
**Prerequisite**: E · **A.4 phải xong** (route I.7b validate bằng catalogue)
**Estimate**: 19 SP

**Tasks**:
- [ ] I.1 `DaemonDiscoveryStore`
  - `<app-data>/daemon/<workspaceHash>.json`, atomic temp+fsync+rename, `0600`/ACL. `remove` so `instanceId` để daemon cũ không xoá record daemon mới. **Không** secret, không attachment count, không lease id trong file
  - _Requirements: R2.13_ — _Design: §5.5, §6.2_
- [ ] I.2 `DaemonClient` trong `packages/adapter/src/daemon/**`
  - Là **thư mục mới trong `@vidcom/adapter`**, không phải package npm mới: `packages/adapter` chỉ có một entry `exports: "./src/index.ts"`, nên `adapter/daemon` là cách đặt tên trong Design chứ không phải subpath export. Đừng tạo `packages/adapter/src/daemon/package.json`
  - Bề mặt **đóng**: `handshake`, `attach`/`renew`/`detach`, `invokeTool(name, payload)`. MUST NOT có `request(method, path, body)` tuỳ ý (DR-6) — một khi có, bridge biến thành HTTP proxy và mọi luật allowlist thành trang trí
  - Người dùng: `cli` — cả `render` (J.3) và composition root của bridge (I.2b). **`mcp` MUST NOT import nó**, xem I.2b
  - _Requirements: R2.2_ — _Design: §5.0, §7.0_
- [ ] I.2b **Seam `ToolInvoker`: interface ở `mcp`, hiện thực remote ở `cli`** — đọc kỹ, đây là chỗ bản trước của checklist sai và làm CI đỏ ngay task này
  - **Luật**: `mcp` **bị cấm** import `adapter` — [steering/02](../../../steering/02-project-layout.md) §2 luật 3, và §2.1 giải thích vì sao `worker` được mà `mcp` không. Cưỡng chế ở **hai** chỗ (steering §2.2): ESLint block `packages/mcp/**` trong [`eslint.config.mjs`](../../../../eslint.config.mjs), và [`scripts/verify-import-boundaries.mjs`](../../../../scripts/verify-import-boundaries.mjs) với `throw "MCP must not import sibling infrastructure"`
  - Gate thứ hai phân giải package theo **prefix đường dẫn**, nên `packages/adapter/src/daemon/**` cũng là `@vidcom/adapter` — `adapter/daemon` **không** thoát được luật, kể cả qua import tương đối hay dynamic `import()`. Nó quét mọi file `.ts/.tsx/.js/.mjs/.json` dưới `packages/`
  - **Quyết định (đã duyệt cùng Approval Gate)**: `mcp` giữ nguyên trạng thái không-có-infrastructure như hôm nay ([`packages/mcp/package.json`](../../../../packages/mcp/package.json) khai đúng 5 dep: hai gói SDK, `@vidcom/contracts`, `@vidcom/core`, `zod`). Cụ thể:
    - `interface ToolInvoker` ở [`packages/mcp/src/registry/types.ts`](../../../../packages/mcp/src/registry/types.ts) — chữ ký khớp [`ToolRegistry.invoke`](../../../../packages/mcp/src/registry/registry.ts) đang có: `invoke(name, raw, request): Promise<ToolInvocation>`
    - `createRemoteToolInvoker(client: DaemonClient): ToolInvoker` ở `packages/cli/src/bridge/remote-tool-invoker.ts`
    - Chỗ nối: [`commands/mcp.ts`](../../../../packages/cli/src/commands/mcp.ts) `openListener`, ngay cạnh `createMcpRegistry(infrastructure, application)` đang gọi — `cli` là package duy nhất khai **cả** `@vidcom/adapter` và `@vidcom/mcp`
  - **MUST NOT**: nới bất kỳ gate nào; thêm `@vidcom/adapter` vào `packages/mcp/package.json`; đặt `DaemonClient` vào `core` để "lách" (`core` bị cấm `node:*` — sẽ đỏ ở một fixture khác của cùng gate)
  - Nếu phải sửa luật này, sửa **cả ba** chỗ cùng lúc (steering §2 bảng + `eslint.config.mjs` + gate script) theo đúng steering §2.2. Sửa một chỗ tạo ra `lint` xanh mà `test:boundaries` đỏ — đó chính là tình trạng đã tồn tại trong repo tới 2026-08-07 và là lý do Design bản 2 viết sai chỗ đặt `DaemonClient`
  - _Requirements: R2.2, R2.3_ — _Design: §5.0 hệ quả 4, §5.7, §16 C-1_
- [ ] I.2c Test ranh giới, để hình dạng sai không quay lại
  - `tests/cli/remote-tool-invoker.test.ts`: invoker remote thoả cùng contract như local (dùng lại harness của I.10)
  - Fixture ranh giới: một file giả dưới `packages/mcp/` import `@vidcom/adapter` **phải** bị `assertPackageImportAllowed` từ chối — thêm vào mảng `packageBoundaryFixtures` đang có nếu chưa đủ chặt cho dynamic `import()`
  - `rtk bun run test:boundaries` vào AC của phase, không phải chạy cho vui
  - _Requirements: R2.2_ — _Design: §5.0 hệ quả 4_
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
- [ ] I.7a `createMcpRegistry` nhận `ToolInvoker`
  - Sửa [`composition-root.ts`](../../../../packages/cli/src/composition-root.ts) để registry được dựng quanh một invoker thay vì nối cứng vào `application`. `ToolDefinition` vẫn là nguồn duy nhất cho schema/list/era — invoker chỉ đổi **chỗ thực thi**
  - Đường local (stdio hôm nay, `vidcom app`) MUST giữ nguyên hành vi: đây là refactor, không phải tính năng
  - _Requirements: R2.2, R2.3_ — _Design: §5.7_
- [ ] I.7b Route `/api/bridge/v1/tools/:name` phía daemon
  - Validate bằng catalogue của A.4 (`server` không được import `mcp`), rồi thực thi qua invoker local do composition root inject
  - Tên tool không có trong catalogue ⇒ lỗi có mã, MUST NOT chuyển tiếp xuống Core
  - _Requirements: R2.3, R2.11_ — _Design: §7.10, §5.0 hệ quả 1_
- [ ] I.7c Bridge forward danh tính, daemon sở hữu audit
  - Forward `protocolVersion`, credential id, attachment id, actor=`agent`. Audit **ghi ở daemon**, không ở bridge — bridge chết giữa lời gọi thì audit vẫn phải đúng
  - _Requirements: R2.9_ — _Design: §5.7, DR-6_
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
- [ ] `rtk bun run test:boundaries` xanh, và [`packages/mcp/package.json`](../../../../packages/mcp/package.json) **vẫn đúng 5 dependency** như trước phase (`@modelcontextprotocol/core`, `@modelcontextprotocol/server`, `@vidcom/contracts`, `@vidcom/core`, `zod`) — đây là cách kiểm C-1 không lặng lẽ trôi ngược
- [ ] `git diff scripts/verify-import-boundaries.mjs` không có dòng nào **nới** luật (thêm fixture thì được)

**Deliverables**: `packages/adapter/src/daemon/**` · `packages/adapter/src/fs/daemon-discovery.ts` · `packages/cli/src/bridge/remote-tool-invoker.ts` · `packages/mcp/src/registry/types.ts` (chỉ thêm interface) · `packages/server/src/routes/bridge.ts`

---

## Phase J: CLI mode + doctor

**Addresses**: R3.1–R3.13 · **Design**: §5.8, §5.9, §7.12–§7.14
**Files affected**: `packages/cli/src/main.ts`, `packages/cli/src/commands/{serve,render,doctor,version}.ts`, `packages/core/src/service/doctor.ts`
**Prerequisite**: **D và I, cả hai** — D vì `doctor` kiểm toolchain đã giải nén (J.5b), I vì `render` là thin client của `DaemonClient` (I.2). Đồ hình Dependency Order ở đầu file từng thiếu cạnh `I ─→ J`; nó đã được sửa
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
  - Gọi daemon qua `DaemonClient` của **I.2** — đây là lý do J có tiền đề I. MUST NOT tự dựng client HTTP thứ hai
  - Help của `--workspace` nói rõ nó **không** đổi workspace mặc định của UI (hệ quả của C.4). Đây là chỗ thực thi câu đó, vì `commands/render.ts` được tạo ở task này
  - _Requirements: R3.3, R1.5_ — _Design: §7.13_
- [ ] J.4 `version`
  - VidCom version, HyperFrames version, build commit, platform tag, runtime manifest version
  - _Requirements: R3.4_ — _Design: §7.14_
- [ ] J.5a Khung `DoctorCheck` + thứ tự deterministic
  - `DoctorCheck`/`DoctorReport` theo §5.9; `run` trả `Result<DoctorItem, DomainError>` ([steering/03](../../../steering/03-architecture-ddd.md) §2.2, Design §5.0 hệ quả 2). Thứ tự đăng ký **cố định**, không phụ thuộc thứ tự import — golden test J.9 chốt nó
  - `gpu.cuda` **không** có trong bảng: stack chỉ có `onnxruntime` CPU nên nó không bao giờ `ok` được, và một mục vĩnh viễn không `ok` dạy người dùng bỏ qua doctor
  - _Requirements: R3.5_ — _Design: §5.9_
- [ ] J.5b 11 check nguồn **artifact** (required, không có `skipped`)
  - `app-data.writable`, `db.migration`, `runtime.manifest`, `runtime.integrity` (`skipped` khi không `--deep`), `runtime.ffmpeg`, `runtime.esbuild-binary`, `compiler.probe`, `runtime.hyperframes`, `runtime.motion`, `runtime.python`, `runtime.python-utf8`
  - `runtime.python` dùng `importlib.metadata`, **không cần pip** (pip đã bị gỡ khỏi stack, −12 MB); `compiler.probe` chạy `transformSync` **qua `CompilerGuard`** trong timeout, nếu không thì check này chính là chỗ treo vĩnh viễn; `runtime.python-utf8` in một chuỗi tiếng Việt qua interpreter đã ship rồi đọc lại
  - _Requirements: R3.5, R3.6_ — _Design: §5.9_
- [ ] J.5c 6 check nguồn **tải-về / máy / người dùng**
  - `chrome.cache`, `tts.model-cache`, `workspace.active`, `port.available` (required) · `settings.file`, `tts.elevenlabs` (optional)
  - `chrome.cache` **thực thi** `chrome-headless-shell --version` với timeout rồi so version với manifest. MUST NOT hỏi `hyperframes browser path` — S9 đo được: Chrome cắt còn 1 MB thì CLI vẫn trả đường dẫn và **exit 0**. Dùng lại helper resolve+probe của G.0, MUST NOT viết đường thứ hai
  - `settings.file` MUST NOT in nội dung file; nếu khai `runtime.caBundlePath` thì kiểm file đó tồn tại/đọc được
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
**Files affected**: `scripts/build-artifact.mjs`, `scripts/verify-artifact.mjs`, `scripts/verify-spec-test-paths.mjs` (L.6), `tests/build/**` (thư mục mới)
**Prerequisite**: H · L.6 nên làm **sau cùng trong phase**, xem lý do ở chính task đó
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
- [ ] L.6 **Đăng ký spec này vào [`scripts/verify-spec-test-paths.mjs`](../../../../scripts/verify-spec-test-paths.mjs)**
  - Gate hôm nay chỉ biết **hai** spec (`spec-mcp-server` phases `ABCDEFGHIJKLMNOP`, `spec-project-delivery-loop` phases `ABCDEFGHIJKLMNOPQRS`). Convention của repo là mọi checklist đều được gate này bảo vệ; không đăng ký thì bảng Phase Verification Matrix ở trên có thể trỏ vào file không tồn tại mà CI vẫn xanh
  - Thêm entry `{ label: "packaging & distribution", path: "llm-documents/…-implementation-checklist.md", phases: "ABCDEFGHIJKLM" }`
  - **Làm ở cuối, có lý do**: gate kiểm **mọi** đường dẫn `tests/...` trong Matrix phải tồn tại thật. Đăng ký ở Phase A thì `test:spec-paths` đỏ suốt từ B tới M
  - Chạy `rtk bun run test:spec-paths` và đọc số nó in ra — nếu số path verified không tăng thì entry chưa được đọc (sai `path` hoặc sai tên section)
  - Lưu ý khi đọc số: gate cắt section bằng hai heading nên **khối `> [!WARNING]` ở đầu Matrix cũng bị quét**, tức `tests/frontend/` và `tests/build/` nằm trong tập path được kiểm. Đó là ý muốn (hai thư mục đó phải tồn tại thật), không phải nhiễu
  - Nếu có phase nào bị bỏ giữa đường, sửa chuỗi `phases` **cùng lúc**: gate so khớp chuỗi đúng thứ tự và fail với `"rows drifted"`
  - _Requirements: R9.1_ — _Design: §5.20_

**Acceptance Criteria**:
- [ ] Không secret, không sourcemap, không absolute path máy build trong artifact
- [ ] `rtk bun run test:spec-paths` xanh **và** số path verified tăng so với trước L.6

**Deliverables**: `scripts/build-artifact.mjs` · `scripts/verify-artifact.mjs` · `scripts/verify-spec-test-paths.mjs`

---

## Phase M: Packaged smoke ba nền tảng

**Addresses**: R8.1–R8.8 · **Design**: §4.8, §11.4
**Files affected**: `.github/workflows/packaged-smoke.yml`, `scripts/packaged-smoke/*`, `package.json` (script `test:packaged-smoke`)
**Prerequisite**: tất cả
**Estimate**: 21 SP

**Tasks**:
- [ ] M.0 Script `test:packaged-smoke` + runner cục bộ
  - Thêm `"test:packaged-smoke": "node scripts/packaged-smoke/run.mjs"` vào [`package.json`](../../../../package.json). Chạy được **trên máy dev** chứ không chỉ trong Actions — nếu chỉ chạy được trong CI thì mỗi lần sửa một bước phải push, và không ai sửa nữa
  - Nhận `--step <id>` để chạy một bước, `--from <id>` để chạy tiếp từ giữa; mặc định chạy đủ 12 bước theo thứ tự §11.4
  - Mỗi bước in `id`, thời gian, kết quả ở `stderr`; `stdout` chỉ để bằng chứng JSON (M.6). Bước fail ⇒ exit ≠ 0 **kèm id của bước**, MUST NOT chỉ báo "smoke failed"
  - Bước bị bỏ ⇒ đánh dấu `skipped` **và** làm job đỏ khi `VIDCOM_DOCTOR_STRICT=1` (M.5) — AC của phase này là "không step bắt buộc nào bị skip", nên trạng thái đó phải quan sát được, không phải suy từ log
  - _Requirements: R8.3, R8.7_ — _Design: §11.4_
- [ ] M.1 Job native theo OS
  - macOS arm64, Windows x64, Linux x64; **không job nào dùng artifact build từ OS khác**. Mỗi lần chạy ghi lại nền tảng đã kiểm
  - _Requirements: R8.1, R8.5_ — _Design: §4.8, DR-11_
- [ ] M.2 Môi trường sạch
  - `node` **không** trên PATH; **không** `node_modules` ở `cwd` hay thư mục cha; `HOME` sạch. Cache tải-về (`$HOME/.cache/hyperframes`, `HF_HOME`) **được** mồi; app-data/runtime **không** được mồi
  - _Requirements: R8.2, R8.8_ — _Design: §11.4_
- [ ] M.3a Bước 1–3: nhận dạng + cold/warm doctor
  - `version` → cold `doctor --repair` → warm `doctor --deep`. Đây là ba bước duy nhất không cần listener, nên chúng cũng là chỗ đo cold start thật cho M.7
  - _Requirements: R8.3, R4.9_ — _Design: §11.4, §9.1_
- [ ] M.3b Bước 4–6: vòng đời UI + import + bridge song song
  - start + nonce/session + picker + create project → import project → bridge nối vào **trong lúc UI còn sống**
  - Bước 6 là chỗ duy nhất chứng minh lời hứa "mở app rồi chạy Codex, cả hai dùng được, vẫn đúng một writer" trên artifact thật
  - _Requirements: R8.3, R2.15_ — _Design: §11.4, §4.4_
- [ ] M.3c Bước 7–9: giá trị lõi — ra được MP4 có tiếng
  - TTS → snapshot → render + `ffprobe` xác minh (có audio stream, đúng thời lượng) → upload 20 MB + SSE → `render` wait/detach/cancel
  - Đây là nhóm bước mà **cả Phase D tồn tại để phục vụ**. Nếu chỉ chạy được một nhóm bước, chạy nhóm này
  - _Requirements: R8.3, R6.1, R4.6_ — _Design: §11.4_
- [ ] M.3d Bước 10–12: chế độ hỏng
  - **Cắt mạng ở tầng runner** rồi warm offline (M.4) → lease loss **hai nhánh** (UI hạ về `NoWorkspace`; headless đóng listener + exit ≠ 0) → scan checksum/provenance
  - _Requirements: R8.3, R8.8, R2.14, R9.4_ — _Design: §11.4, §4.3_
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
| `packages/adapter/src/daemon/**` | I | **thư mục mới** trong `@vidcom/adapter` — IPC client, người dùng là `cli` (`mcp` không được import) |
| `packages/adapter/src/hyperframes/binary-probe.ts` | D | hai chỗ spawn đổi hình dạng |
| `packages/adapter/src/tts/**` | D | interpreter đóng băng, `HF_HUB_OFFLINE`, CA bundle |
| `packages/core/src/service/**` | C, F, J, K | doctor, filesystem browser, import |
| `packages/cli/src/**` | C, D, E, H, J | bootstrap, shim, foundation manager, loopback host, mode |
| `packages/server/src/routes/**` | F, I, K | system, bridge, imports |
| `packages/mcp/src/registry/types.ts` | I | **chỉ thêm `interface ToolInvoker`** — không thêm dependency, không import `adapter` |
| `packages/cli/src/bridge/**` | I | **hiện thực** remote invoker (chỗ duy nhất thấy cả `mcp` và `adapter`) |
| `src/**` | G | http-driver, export, picker, New video |
| `tests/frontend/**`, `tests/build/**` | G, L | **thư mục test mới** — `tests/` hôm nay không có hai cái này |
| `package.json` | A, B, G, H, M | `tar` direct dep (B) + 4 script mới: `test:mcp-catalogue` (A.8), `test:browser-session` (G.0), `build:artifact` (H.0), `test:packaged-smoke` (M.0) |
| `scripts/**` | B, H, L, M | build archive/artifact, verify, smoke |
| `scripts/verify-spec-test-paths.mjs` | L | đăng ký spec này vào gate (L.6) |
| `.github/workflows/**` | H, M | perf baseline, packaged smoke |

**Tổng ước lượng**: **177 SP** — A 5 · B 13 · C 16 · D 25 · E 17 · F 10 · G 12 · H 13 · I 19 · J 13 · K 8 · L 5 · M 21.

> Con số này **phân hoạch lại** ước lượng theo R ở [main spec](./spec-packaging-and-distribution-pending.md) (R1 26 · R2 37 · R3 13 · R4 21 · R5 21 · R6 25 · R7 8 · R8 21 · R9 5), không phải một ước lượng thứ hai. Tổng giữ nguyên.

**Vòng review 2026-08-07 tách bảy task và thêm bảy task; SP mỗi phase không đổi.** Task được tách thì SP chia lại trong cùng phase; task thêm là việc **đã ngầm nằm trong Acceptance Criteria cũ** (một AC đòi `rtk bun run build:artifact` thì cái script đó là việc phải làm, chỉ là chưa ai viết nó ra).

| Đổi | Trước | Sau | Vì sao |
|---|---|---|---|
| Tách | D.3 | D.3a, D.3b | Resolver đúng mà không entrypoint nào truyền là bẫy 4.8 — hai lỗi khác nhau, hai task khác nhau |
| Tách | I.2 | I.2, I.2b, I.2c | Chỗ đặt code là quyết định ranh giới, không phải chi tiết của việc viết client |
| Tách | I.7 | I.7a, I.7b, I.7c | Ba lớp khác nhau: composition root, route, audit |
| Tách | J.5 | J.5a, J.5b, J.5c | 17 check trong một task thì Execution Log mất nghĩa đúng ở phase dài nhất |
| Tách | M.3 | M.3a–M.3d | 12 bước × 3 OS trong một ô `[ ]` là ô không bao giờ tick được nửa vời |
| Thêm | — | A.8, C.4b, F.5b, G.0, H.0, L.6, M.0 | Ba script + một gate + một harness + hai danh sách caller — tất cả đều là điều kiện để verify của phase chạy được |

> Luật cũ "task 1–4 giờ" giờ đúng với **mọi** task còn lại. Nếu trong lúc làm phát hiện một task nữa vượt 4 giờ, tách nó và ghi vào Execution Log — MUST NOT để một `[/]` treo nhiều ngày, vì đó là cách một phase mất khả năng quan sát.

---

## Requirements Coverage Matrix

| Requirement | Covered by | Verified by |
|---|---|---|
| R1.1–R1.4, R1.6–R1.10 picker API | F.1–F.4, F.6 | F.7, F.8, G.9 |
| R1.5 workspace active (**breaking**) | C.4, C.4b, F.5, F.5b | C.9, E.8, F.7 |
| R1.11 UI picker | G.7 | G.9 |
| R1.12 đổi workspace runtime | E.1, E.4 | E.7, E.8 |
| R1.13 perimeter | E.6 | E.9, F.8 |
| R1.14–R1.16 giới hạn/timeout/TOCTOU | F.2, F.3 | F.8, F.9 |
| R1.17 boot không-workspace | E.2, E.3 | E.7, H.8 |
| R1.18 đổi workspace khi có job | E.4 | E.8 |
| R1.19 New video | G.8 | G.9 |
| R2.1, R2.12, R2.14 single-writer + lease | E.5, C.5 | E.9, M.3d |
| R2.2–R2.4, R2.10 bridge + auto-start | I.2, I.2b, I.7a, I.8 | I.2c, I.10, I.11 |
| R2.5 credential | C.5–C.7 | C.10, C.11 |
| R2.6 stdout sạch | I.9 | I.9, M.3b |
| R2.7 daemon biến mất | I.3 | I.11 |
| R2.8 event tới UI | I.12 | I.12 |
| R2.9 audit actor | I.7c | I.10 |
| R2.11 không mở bề mặt | I.7b, F.6 | I.10, F.6 |
| R2.13 handshake | I.1, I.3 | I.11, M.3b |
| R2.15 refcount + race | I.4–I.6, I.8 | I.11, M.3b |
| R3.1–R3.4 mode | J.1–J.4 | J.9, J.10 |
| R3.5–R3.13 doctor | J.5a–J.5c, J.6–J.8 | J.9, J.10, M.3a |
| R4.1–R4.3 SEA | H.1–H.4 | H.8 |
| R4.4 Hono app không đổi | E.2 | H.8 |
| R4.5 sentinel + RSC | G.5, G.6, H.3 | H.7 |
| R4.6 SSE + upload | G.4, H.5 | H.8 |
| R4.7 pin + no sourcemap | L.1 | L.5 |
| R4.8 dev host còn dùng được | G.2, G.6 | G.0, G.9 |
| R4.9 ngưỡng cold/warm | H.6 | M.3a, M.7 |
| R4.10–R4.13 http-driver + export | G.1–G.6 | G.0, G.9 |
| R4.14 CJS không TLA | H.1 | H.8 |
| R5.1–R5.6 archive + extraction | B.1–B.5 | B.7–B.9 |
| R5.7, R5.8 motion library | D.3a, D.3b | D.10, M.3c |
| R5.9, R5.12 quyền + không ghi bậy | B.6 | B.8 |
| R5.10 dựng lại được | B.5 | B.8 |
| R5.11 quan sát được | B.5, J.8 | J.10 |
| R5.13 thứ tự cold start | C.1–C.3 | C.9, C.12 |
| R5.14 danh sách Python pin | B.3 | B.3 build gate |
| R6.1 render có tiếng | D.6 | M.3c, M.8 |
| R6.2–R6.4 hình dạng spawn | D.1, D.2 | D.10, D.11 |
| R6.5 Chromium/weights/TLS | D.7, D.8 | D.11, M.4 |
| R6.6 FFmpeg từ archive | D.3a, D.3b | M.3c |
| R6.7 sidecar + UTF-8 | D.5, D.6 | D.11, D.12 |
| R6.8 kill cây process | D.13 | D.13, M.3c |
| R6.9 version skew | D.9 | D.9 |
| R6.10, R6.11 in-process + compiler | D.4 | D.11 |
| R7.1–R7.12 import | K.1–K.7 | K.8–K.10, M.3b |
| R8.1–R8.8 packaged smoke | M.0–M.9 | M.3a–M.3d |
| R9.1–R9.7 hygiene | L.1–L.4, L.6 | L.5, M.3d |

> Mọi requirement xuất hiện ở đây, map tới ≥1 task và ≥1 test.

**Năm task là hạ tầng verify, không phải requirement**: A.8, G.0, H.0, L.6, M.0. Chúng vẫn có `_Requirements:_` vì chúng gác một requirement cụ thể, nhưng giá trị của chúng là **làm cho việc kiểm các requirement khác chạy được**. Ghi ra đây để lần review sau không ai gộp chúng vào task chức năng rồi mất luôn — đó chính là cách bản trước của checklist này để hổng ba câu lệnh và một gate.

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

## Nợ tài liệu — không chặn code, nhưng đừng để trôi

| # | Món | Trạng thái |
|---|---|---|
| N-A | Ba nguồn nói khác nhau về `mcp` → `adapter`: bảng [steering/02](../../../steering/02-project-layout.md) §2 **cho phép**, ESLint **cho phép** (block `packages/mcp/**` không liệt `@vidcom/adapter`), gate [`verify-import-boundaries.mjs`](../../../../scripts/verify-import-boundaries.mjs) **cấm** | **Đóng 2026-08-07** — chọn hướng **thắt lại** cho khớp code hiện tại: steering §2 bảng + luật 3 + §2.1 (giải thích bất đối xứng `worker`) + §2.2 (hai gate phải khớp), và thêm `@vidcom/adapter` vào block ESLint của `packages/mcp/**`. Không sửa dòng code sản phẩm nào — `packages/mcp` vốn đã tuân thủ. `lint`, `typecheck`, `test:boundaries` xanh sau khi sửa |
| N-B | Design bản 2 §5.0/§8.1 có 5 câu nói khác code; đã đính chính ở [§16](./spec-packaging-and-distribution-detailed-design.md) chứ không sửa tại chỗ để giữ dấu vết bản đã duyệt | **Đóng** — đọc §16 trước Phase A và Phase I |

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
  - Decisions: [lệch khỏi design ở đâu — nếu vật chất thì thêm dòng vào Design §16, không sửa tại chỗ phần đã duyệt]
  - Blockers: [nếu có]
```
