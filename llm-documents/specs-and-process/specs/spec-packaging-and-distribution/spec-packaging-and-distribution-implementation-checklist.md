# Spec Packaging & Distribution Runtime — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) — bản 4, **Approved 2026-08-07** (R2.14 sửa sau khi duyệt, cùng ngày)
> - [Detailed Design](./spec-packaging-and-distribution-detailed-design.md) — bản 2, **Approved 2026-08-07**, gate §15 · **+ phụ lục sửa §16 (bản 2.1, cùng ngày)** — 5 chỗ bản 2 nói khác code thật, đọc trước khi bắt đầu Phase A và Phase I
> - [Main spec](./spec-packaging-and-distribution-inprocess.md)
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

- **Status**: **Approved**
- **Confirmed by**: alvin0
- **Confirmation date**: 2026-08-07
- **Notes**: Design gate §15 đã mở (alvin0, 2026-08-07) nên checklist này được phép tồn tại. Gate thứ hai này — Code Execution — **đã duyệt cùng ngày**, sau vòng review cuối vá bốn chỗ (B.3 nguồn danh sách package Python + normalize tên, A.4 `ToolSchemaEntry` dùng lại `ToolLevel` sẵn có, H.5 nêu tên route upload `uploadBgm`, và `test:mcp-catalogue` lệch giữa Matrix và Files Changed Summary), cộng N-C vào bảng Nợ tài liệu.
- **Trạng thái thực thi**: **Phase A, B, C, E, F hoàn tất; D 12/14 — cập nhật 2026-08-08**. F đóng 9/9 với CI ba OS xanh ở commit `5b85578`; 1123 test toàn repo. D còn D.3b và nửa Node của D.7 chờ **J.1**, cùng hai Acceptance Criteria chờ **H.0** và D.3b — điều kiện gỡ ghi ngay tại từng task. Phase G là gate kế tiếp. Phase C: 11/12 task tick, C.3 một phần có chủ ý; 2/3 Acceptance Criteria tick, AC "migration đúng một lần mỗi boot" để trống có lý do ghi ngay tại C.3. CI ba OS xanh ở [`31247413684`](https://github.com/alvindev111/vidcom-v2/actions/runs/31247413684) trên commit `bfbf7c0`; 929 test toàn repo. Stdio hardening commit `d754b2bdc1f83d50b6864dc39a1e8717f86209db` đã push và workflow [`31199182402`](https://github.com/alvindev111/vidcom-v2/actions/runs/31199182402) kết thúc `success`: macOS arm64 4m06s, Linux x64 6m13s, Windows x64 16m08s. Trước Phase B đã activate lại Bun skill và đọc FULL `credential-store.ts` + spike Phase 4 theo bảng Skill Activation. Focused command của Phase B chạy xanh trên filesystem thật; typecheck, ESLint và `test:boundaries` xanh. **CI ba OS xanh ở [`31244020503`](https://github.com/alvindev111/vidcom-v2/actions/runs/31244020503) trên commit `d71f95e`**: macOS arm64 3m, Linux x64 6m, Windows x64 13m (riêng step Test 494s). Phase B mất **năm vòng CI** vì một bug Windows chỉ lộ ra khi `AtomicDirectoryLock` lần đầu chạy trên nền đó — chi tiết ở B.9 và `implementation-notes.html`. Phase C là gate kế tiếp. Main spec đang là [`-inprocess.md`](./spec-packaging-and-distribution-inprocess.md).

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
> **Bốn lệnh có dấu † chưa tồn tại trong [`package.json`](../../../../package.json).** Repo hôm nay có 20 script và không có script nào trong số đó. Task tạo chúng nằm ngay trong phase tương ứng và **phải làm trước** mọi task khác của phase đó, nếu không thì "verify" của phase là câu lệnh không chạy được. (Bản trước đếm ba vì bỏ sót `test:mcp-catalogue` của A.8 — Files Changed Summary vẫn đếm bốn, nên đây là chỗ lệch chứ không phải task mới.)
>
> Tương tự, `tests/frontend/` và `tests/build/` là **thư mục mới** — `tests/` hôm nay chỉ có `adapter, agent-kit, cli, contracts, core, e2e, golden, mcp, server, support`. [`vitest.config.ts`](../../../../vitest.config.ts) đặt `environment: "node"` **toàn cục** và repo **không có `jsdom`/`happy-dom`**, nên test nào cần `window`/`location` phải đi qua seam inject (xem G.2), MUST NOT giả định môi trường DOM.

| Phase | Focused verification command | Lệnh/thư mục phải tạo trước |
|---|---|---|
| A | `rtk bunx vitest run tests/contracts/packaging-contracts.test.ts` **và** `rtk bun run test:mcp-catalogue` **†** (→ `tests/contracts/tool-schema-catalogue.test.ts`) **và** `rtk bun run test:mcp-contract` **và** `rtk bun run test:golden` — hai cái cuối là gate hồi quy cho A.4 | script `test:mcp-catalogue` → **A.8** |
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
- [x] A.1 Thêm `ErrorCode` mới vào [`packages/contracts/src/errors.ts`](../../../../packages/contracts/src/errors.ts)
  - `bridge_credential_unavailable`, `bridge_credential_invalid`, `bridge_rotation_in_progress`, `download_tls_untrusted`, `payload_too_large`, `daemon_identity_mismatch`, `daemon_unavailable`, `compiler_unavailable`, `runtime_manifest_invalid`, `runtime_extraction_incomplete`, `bootstrap_lock_timeout`, `path_timeout`, `browse_token_invalid`, `project_import_conflict` — **14 mã, không phải 15**
  - **`workspace_lease_lost` đã tồn tại** (`WorkspaceLeaseLost = "workspace_lease_lost"`, cùng file). Design §8.1 liệt nó như mã mới; đó là C-4 ở §16. Thêm lần nữa là lỗi biên dịch, nên đây không phải chi tiết vô hại
  - `ErrorCode` là **`enum`**, member PascalCase, value snake_case — theo đúng 56 member đang có, MUST NOT dùng union string cho mã mới
  - Hai cặp dễ nhập nhằng, ghi lý do vào chỗ khai báo để lần sau không ai gộp: `payload_too_large` (giới hạn **body HTTP**, kèm giới hạn thật trong `details`) khác `TooLarge = "too_large"` (**asset** vượt hạn mức của project); `bridge_credential_invalid` (bearer của **bridge**, có đường xoay ở C.6) khác `CredentialInvalid = "credential_invalid"` (credential MCP của người dùng)
  - _Requirements: R1.7, R2.7, R6.5_ — _Design: §8.1, §16 C-4_
- [x] A.2 Thêm DTO của R1 vào `contracts`
  - `BrowseRootDto`, `BrowseEntryDto`, `BrowsePage`, request/response của §7.1–§7.3, `SystemWorkspaceDto` với state union **gồm `reacquiring`**, `SystemRuntimeDto`
  - Mọi schema **`strict`** — field lạ bị từ chối, không bỏ qua âm thầm
  - _Requirements: R1.1, R1.2, R1.7_ — _Design: §7.1–§7.4, §7.7b_
- [x] A.3 Thêm DTO của bridge vào `contracts`
  - Handshake request/response, attachment create/renew, tool invoke envelope
  - _Requirements: R2.13, R2.15_ — _Design: §7.8–§7.10_
- [x] A.4 **Catalogue `tên tool → schema` trong `contracts`** — *không phải* di chuyển schema
  - **Đọc trước khi làm**: việc "chuyển schema sang `contracts`" mà Design bản 2 giao cho giai đoạn này **đã xong từ trước** (C-2 ở §16). Bằng chứng: [`packages/mcp/src/registry/schemas.ts`](../../../../packages/mcp/src/registry/schemas.ts) chỉ có `export * from "@vidcom/contracts"`; [`read-tools.ts`](../../../../packages/mcp/src/registry/read-tools.ts) đã import `ListProjectsInputSchema`/`ListProjectsOutputSchema` từ `contracts`; và **không có một `z.object`/`z.strictObject` nào** trong `packages/mcp`. Bắt đầu bằng cách "chuyển" là sửa thứ không hỏng
  - **Việc thật**: route `/api/bridge/v1/tools/:name` bên `server` nhận `:name` là **string lúc runtime** và phải map nó sang schema. Hôm nay chỉ `ToolRegistry.definitions` (ở `packages/mcp`) làm được việc đó, mà lint cấm `server` import `mcp`. Nên `contracts` phải xuất một map tường minh:

    ```ts
    // packages/contracts/src/mcp.ts
    export const TOOL_SCHEMA_CATALOGUE = {
      list_projects: { input: ListProjectsInputSchema, output: ListProjectsOutputSchema, level: "read" },
      // …một entry cho mỗi tool đang đăng ký
    } as const satisfies Record<string, ToolSchemaEntry>;
    ```

  - `ToolSchemaEntry` khai **cùng file** [`packages/contracts/src/mcp.ts`](../../../../packages/contracts/src/mcp.ts), ngay trên catalogue: `{ input: z.ZodType; output: z.ZodType; level: ToolLevel }`. **`ToolLevel` đã tồn tại ở chính file đó** (`"read" | "write" | "job" | "destructive"`, dòng 47) và `ToolDefinition.level` ở [`mcp/src/registry/types.ts:54`](../../../../packages/mcp/src/registry/types.ts#L54) đang dùng đúng nó — MUST NOT khai union thứ hai, **đặc biệt đừng bỏ sót `job`**
  - **`ToolDefinition`/handler/annotations ở lại `packages/mcp`** — chỉ map schema đi ra. Registry SHALL đọc catalogue này thay vì khai lại, nếu không là hai nguồn sự thật cho cùng một tên tool
  - Kèm test: **mọi** tool trong `ToolRegistry` có entry trong catalogue và ngược lại. Thiếu chiều nào thì một tool mới sẽ lặng lẽ 404 ở route bridge trong khi vẫn chạy qua stdio
  - _Requirements: R2.3, R2.11_ — _Design: §5.0 hệ quả 1, §16 C-2_
- [x] A.5 Thêm `runtime.caBundlePath` vào schema `setting.json` + env `VIDCOM_CA_BUNDLE`
  - `setting.json` là **schema strict** ([steering/07](../../../steering/07-data-and-storage.md) §0): key lạ là **lỗi khởi động**, nên không thêm vào schema thì người dùng làm theo hướng dẫn của `doctor` sẽ không boot được
  - _Requirements: R6.5_ — _Design: §5.13_
- [x] A.6 Thêm event mới vào contract SSE
  - `workspace.lease_lost`, `workspace.reattached`, `runtime.preparing`, `runtime.ready`
  - _Requirements: R2.8, R5.11_ — _Design: §7.7_
- [x] A.7 Contract test
  - Mọi schema mới từ chối field lạ; state union có đủ 6 giá trị; error code round-trip
  - _Requirements: R1.7_
- [x] A.8 **Gate hồi quy cho A.4** — đây là chỗ Phase A có thể phá thứ đang chạy
  - **Resolved 2026-08-07 theo lựa chọn 1 của người dùng**: public MCP giữ allowlist error code trước Phase A; 14 mã packaging bị từ chối ở `get_job_status` và được redaction thành `internal` nếu đi vào tool-error. Invariant catalogue chạy sau full registration; E2E `npm pack` dùng cache trong temp root. Golden 26/26, MCP contract 71/71, catalogue 2/2; hai fixture giữ đúng SHA-256 baseline và không đổi byte.
  - A.4 chạm nguồn sự thật của tool schema, mà repo đang pin shape đó bằng **mười** file test: [`tests/mcp/golden/tools-list.test.ts`](../../../../tests/mcp/golden/tools-list.test.ts) (snapshot `tools/list`) và 9 file trong `test:mcp-contract` (`contract-matrix`, `negative-contract-matrix`, `revision-pin`, `registry`, `ci-guards`, `legacy-transport`, `modern-transport`, `e2e/mcp-stdio-host`, `core/write-authority`)
  - Chạy `rtk bun run test:mcp-contract` và `rtk bun run test:golden` **trước** khi sửa để có mốc, rồi sau khi sửa. Snapshot `tools/list` MUST giữ **nguyên xi**: catalogue là refactor nội bộ, agent bên ngoài không được thấy gì khác
  - Nếu snapshot đổi thì **dừng và báo**, MUST NOT cập nhật snapshot cho khớp code mới — đó là cách một breaking change đi qua mà không ai duyệt
  - Thêm `tests/contracts/tool-schema-catalogue.test.ts` cho hai chiều đối chiếu ở A.4, và script `"test:mcp-catalogue"` gọi riêng nó vào [`package.json`](../../../../package.json)
  - _Requirements: R2.3, R2.11_ — _Design: §16 C-2_

**Acceptance Criteria**:
- [x] `rtk bun run typecheck` xanh — mọi `switch` trên `ErrorCode` đã xử lý nhánh mới
- [x] `rtk bun run test:boundaries` xanh — `server` **không** import `mcp`, `mcp` **không** import `adapter`
- [x] `rtk bun run test:mcp-contract` và `rtk bun run test:golden` xanh, và snapshot `tools/list` **không đổi một byte** so với `HEAD` trước Phase A
- [x] [`packages/contracts/package.json`](../../../../packages/contracts/package.json) vẫn chỉ có `zod@4.4.3` — catalogue không được lôi thêm gì vào package mà mọi package khác đều import

**Deliverables**: `packages/contracts/src/errors.ts` · `packages/contracts/src/mcp.ts` · `packages/contracts/src/dto.ts` · `tests/contracts/**`

---

## Phase B: Runtime manifest + archive + extraction — **GATE**

**Addresses**: R5.1–R5.6, R5.9, R5.10, R5.12 · **Design**: §4.5, §5.13, §5.14
**Files affected**: `packages/adapter/src/runtime/runtime-asset-*.ts`, `scripts/build-runtime-archives.mjs`, `package.json`
**Prerequisite**: A
**Estimate**: 13 SP

**Tasks**:
- [x] B.1 Nâng `tar@7.5.22` thành dependency trực tiếp — **món dependency mới duy nhất của cả giai đoạn**
  - Bốn câu hỏi của [steering/01](../../../steering/01-backend-stack.md) §3 đã trả lời ở Design §5.0 — chép kết luận vào commit message, không trả lời lại
  - `@hono/node-server` **không phải việc phải làm**: [`packages/server/package.json`](../../../../packages/server/package.json) đã khai `2.0.12`. Design bản 2 viết "thêm hai" là C-3 ở §16. Đừng thêm lần nữa, và nhất là đừng để `bun add` nới pin `hono@4.12.33` — spike S9 đã ghi lại đúng cái bẫy đó
  - Pin **chính xác** `7.5.22`, không `^`: nó chạy trong binary đã compile
  - _Requirements: R5.1_ — _Design: §5.0, §4.5, §16 C-3_
- [x] B.2 `EmbeddedRuntimeManifest` + `RuntimeAssetSource`
  - Đọc qua `node:sea.getRawAsset`; manifest pin Node, HyperFrames, esbuild, FFmpeg, CPython, VieNeu, motion
  - Dev/test dùng nguồn filesystem để chạy được ngoài SEA
  - _Requirements: R5.1, R5.5_ — _Design: §5.13_
- [x] B.3 Script build archive theo `<os>-<arch>`
  - `.tar.gz` deterministic; **fail** nếu tập package Python lệch *(core 55 + phần phụ platform)*; `pip` **có mặt là fail**
  - Số đã đo: darwin 481 MB/145 MB · Windows 499/152 (+`colorama`,`tzdata`) · Linux 595/179
  - **Danh sách kỳ vọng là file có sẵn, đừng gõ lại**: [`evidence/linux-package-set-pruned.txt`](../../../../spikes/phase-4/s9-windows-runtime/evidence/linux-package-set-pruned.txt) (55) · [`darwin-…`](../../../../spikes/phase-4/s9-windows-runtime/evidence/darwin-package-set-pruned.txt) (55) · [`win-…`](../../../../spikes/phase-4/s9-windows-runtime/evidence/win-package-set-pruned.txt) (58). Cách đối chiếu đã chạy thật ở [`phase4-python-stack.yml:130-136`](../../../../.github/workflows/phase4-python-stack.yml#L130) — dùng lại hình dạng đó
  - **File evidence Windows chụp trước bước gỡ `pip`, đừng dùng thẳng làm kỳ vọng**: 58 dòng = 55 core + `colorama` + `tzdata` + **`pip`**. Bảng của [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md) ghi **57** sau prune (dòng 55) trong khi §W-1 ghi file 58 dòng (dòng 252) — hai câu trong cùng một tài liệu, và câu đúng cho gate là **57**. Kỳ vọng: `linux/darwin = 55 core`, `windows = 55 core + colorama + tzdata`, `pip` vắng mặt ở **cả ba**
  - **Normalize tên trước khi diff**, nếu không thì gate đỏ giả trên Windows: `pip list --format=freeze` in khác nhau giữa hai nền — `huggingface-hub`/`huggingface_hub`, `pydantic-core`/`pydantic_core`, `typing-extensions`/`typing_extensions`, `jinja2`/`Jinja2`, `pyyaml`/`PyYAML`, `markupsafe`/`MarkupSafe`. So bằng `name.lower().replace("_", "-")`, **version thì so nguyên xi** (56 version giữ lại đã đo là khớp tuyệt đối giữa darwin và Windows — lệch version là lỗi thật)
  - _Requirements: R5.1, R5.14_ — _Design: §5.13, DR-15_
- [x] B.4 Extractor an toàn
  - Từ chối absolute path, `..`, symlink/hardlink, special file; chỉ regular file/dir trong allowlist; áp lại mode từ manifest; Windows dùng ACL
  - _Requirements: R5.2, R5.4_ — _Design: §4.5_
- [x] B.5 `RuntimeAssetManager`: `ensureAll`/`inspect`/`repair`/`pruneOldVersions`
  - Target `<app-data>/native/<artifact-version>/<archive-key>/`; giải nén vào temp **cùng filesystem** rồi rename; `.ready-<sha>` viết **sau cùng**; `current.json` atomic
  - **Bound đọc state tách làm hai, đừng gộp lại**: manifest đã cài được đối chiếu **byte-for-byte** với projection kỳ vọng (`exactRegularFileMatches`, không có trần cố định) — dùng `MAX_STATE_BYTES` 1 MiB ở đây làm manager tự ghi manifest lớn rồi tự báo `broken` (blocker B.5, đã tái hiện hai lần). Marker + `current.json` giữ trần 1 MiB; `pruneOldVersions` đọc manifest persisted qua trần riêng `MAX_INSTALLED_MANIFEST_BYTES`
  - Verify: [`tests/adapter/runtime-asset-manager.test.ts`](../../../../tests/adapter/runtime-asset-manager.test.ts) — 8 test xanh. Regression được chứng minh bằng cách inject lại bound cũ: thêm trần 1 MiB vào `exactRegularFileMatches` ⇒ 4/8 đỏ với `runtime metadata publication did not produce a ready installation`; bỏ `MAX_INSTALLED_MANIFEST_BYTES` khỏi `isOwnedVersion` ⇒ đúng test prune đỏ
  - _Requirements: R5.2, R5.3, R5.10_ — _Design: §5.14_
- [x] B.6 App-data `0700`/ACL
  - Dùng lại `secureAppDataDirectorySync` đang có, MUST NOT viết đường thứ hai
  - Đã xác nhận **không có đường thứ hai**: `icacls` chỉ xuất hiện trong [`credential-store.ts`](../../../../packages/adapter/src/fs/credential-store.ts); `runtime-asset-manager.prepareRoot` và `runtime-asset-extractor` đều gọi lại đúng helper đó
  - Verify (POSIX): app-data root, `native/`, version root, archive root và directory lồng nhau đều `0700`; file giữ **mode từ manifest** (`0644` và `0755`), không bị helper ép về `0700`
  - _Requirements: R5.9_ — _Design: §9.2_
- [x] B.7 Logic test
  - Manifest parse/verify; resolver chọn đúng archive theo platform; thiếu archive ⇒ lỗi nói rõ nền tảng nào được hỗ trợ
  - Verify: [`tests/adapter/runtime-archive.test.ts`](../../../../tests/adapter/runtime-archive.test.ts) — 13 negative case của strict parser (extra key, schema version, `current.json`, archive key `runtime-manifest.json`, entry `.ready-*`, `..`, hash sai, platform lạ, python pin không exact/không sorted/rỗng) đều trả `runtime_manifest_invalid`; resolver lọc đúng archive của host; host không có archive ⇒ message chứa cả `requested` lẫn danh sách `supported`
  - _Requirements: R5.5_
- [x] B.8 Integration test trên filesystem thật
  - Traversal/symlink/special-file bị từ chối; kill giữa chừng ở **từng pha** (extract, validate, rename, marker) ⇒ lần sau coi là chưa giải nén và làm lại; xoá `native/**` bằng tay ⇒ dựng lại được
  - Extractor: absolute path, `..`, symlink, hardlink, character device, file không khai trong manifest, sai SHA, sai byte length, thiếu entry, content drift — mỗi case **không để lại destination**
  - **Pha `afterMarker` không giống bốn pha kia**: marker đã commit nên lần chạy sau `reused` chứ không re-extract, chỉ `current.json` được publish lại. Test tách riêng và assert `extracted: []` — nếu ép nó cũng phải re-extract là hiểu sai thiết kế
  - _Requirements: R5.3, R5.4, R5.10_ — _Design: §11.2_
- [x] B.9 Integration test: hai tiến trình cold-start đồng thời
  - Đúng **một** tiến trình giải nén; tiến trình kia chờ hoặc dùng kết quả, MUST NOT ghi chồng
  - Bốn `RuntimeAssetManager` (lock instance riêng) chạy `ensureAll` song song: `observer.preparing` được gọi **đúng 1 lần**, đúng một kết quả có `extracted` khác rỗng, cả bốn cùng `versionRoot`
  - Cross-process thật: spawn một process Node sống, ghi `owner.json` của lock trỏ vào PID + `processStartIdentity` **đo bằng `probeProcessIdentity`**, `ensureAll` trả `bootstrap_lock_timeout` và **không** ghi đè; kill process đó xong thì lần sau reclaim được lock và cài thành công
  - **Bug Windows do gate này bắt được — đừng để tái phát.** Triệu chứng: **mọi** `ensureAll` trên Windows chết với `bootstrap_lock_timeout` dù thư mục rỗng, không có tranh chấp nào. Nguyên nhân gốc, đo trên runner sau khi ba giả thuyết đầu đều sai: `windowsProbeEnvironment` đặt **`PSModulePath` trỏ vào thư mục module gốc**, và điều đó làm **mọi cmdlet duyệt process treo quá 20s** — qua cả `Get-Process` (.NET) lẫn `Get-CimInstance` (WMI). Cùng shell đó chạy `'ok'` trong 244ms, và `PSModulePath=""` trả lời trong 324ms
  - **`PSModulePath=""` không đồng nghĩa với xoá biến**: xoá thì PowerShell tự tính mặc định và treo lại. Rỗng cũng **chặt hơn** giá trị cũ — không thư mục nào trên module path đưa được code vào probe. Test pin giá trị rỗng trên mọi nền tảng vì chỉ Windows CI mới bắt được nếu ai đó "sửa lại cho gọn"
  - Bốn thay đổi khác đi kèm, đúng độc lập với nguyên nhân gốc: `probeCurrentProcessIdentity()` cache danh tính của chính process; `PROCESS_IDENTITY_PROBE_TIMEOUT_MS` tách khỏi 2s của probe kết thúc process; probe chạy **trước** khi bấm giờ deadline và fail nhanh với lý do thật thay vì đổ lỗi cho tranh chấp không tồn tại — chính điều này biến các vòng đoán mò thành các vòng loại trừ có bằng chứng; và danh tính mang **prefix scheme**, với luật scheme lạ ⇒ *không chứng minh được đã chết*, để đổi cách đo không biến process còn sống thành mục tiêu bị cướp lock
  - **Bẫy môi trường CI**: job bị `cancelled` vì chạm `timeout-minutes` thì GitHub **không upload log**. Một test spawn process con rồi `await` exit không giới hạn giữ vitest worker mở vô hạn, đủ để đốt cả budget job và không để lại bằng chứng nào. Cleanup phải có trần và `unref()`
  - _Requirements: R5.6_ — _liên quan C.2_

**Acceptance Criteria**:
- [x] Giải nén không ghi gì vào workspace hay cạnh artifact (R5.12) — test snapshot `readdir` của workspace và thư mục cạnh artifact trước/sau `ensureAll`, không đổi
- [x] Warm path không giải nén lại — chỉ đọc manifest/marker — `ensureAll` lần hai trả `extracted: []`, `reused: ["node"]`
- [x] Build fail khi tập package Python lệch một dòng — chạy thật `scripts/build-runtime-archives.mjs` với evidence thật: thiếu 1 package / thừa 1 package / lệch 1 version / có `pip` đều exit khác 0 và **không** ghi `runtime-manifest.json`; bản khớp tuyệt đối thì build ra manifest 55 pin

**Deliverables**: `packages/adapter/src/runtime/runtime-asset-source.ts` · `runtime-asset-manager.ts` · `scripts/build-runtime-archives.mjs`

---

## Phase C: Bootstrap ordering + hai lock + credential reconciliation — **GATE**

**Addresses**: R5.13, R2.5 · **Design**: §4.4, §4.5, §5.1, §5.15, §6.4
**Files affected**: `packages/cli/src/bootstrap-coordinator.ts`, `packages/cli/src/workspace-selection.ts`, `packages/adapter/src/fs/credential-store.ts`. C.4b chỉ **ghi lại** yêu cầu về help của `--workspace`; file `commands/render.ts` **chưa tồn tại** (`commands/` hôm nay có `approve, backup, credential, mcp, recovery`) và được tạo ở J.3 — nên phần help thực thi ở J.3, không ở đây
**Prerequisite**: B
**Estimate**: 16 SP

**Tasks**:
- [x] C.1 `BootstrapCoordinator.prepare()`
  - Thứ tự khoá: `extract → migrate (một lần) → credential reconciliation → release`. Callers MUST NOT tự gọi migration/extraction
  - **Lệch có chủ ý so với Design §5.1**: `PreparedRuntime` **chưa có** field `paths`. `RuntimePaths` và resolver hai chế độ là **D.3a**; dựng một shape tạm ở đây sẽ tạo đúng cái "chỗ thứ hai quyết đường dẫn runtime" mà D.3a sinh ra để chặn. Thay vào đó trả `versionRoot` + `archiveRoots` do `RuntimeAssetManager` đã tính. **D.3b thêm `paths` khi resolver là nguồn duy nhất** — đừng thêm sớm hơn
  - `reconcileCredential` là tham số inject, không phải hiện thực cứng: C.5–C.7 lắp vào chỗ này mà không phải sửa coordinator
  - Verify: [`tests/adapter/bootstrap-coordinator.test.ts`](../../../../tests/adapter/bootstrap-coordinator.test.ts) — 7 test trên SQLite + filesystem thật
  - _Requirements: R5.13_ — _Design: §5.1_
- [x] C.2 Hai lock atomic-mkdir + stale probe
  - `runtime-bootstrap.lock` (extraction+migration) và `credential.lock` (bearer). Thứ tự lấy **luôn** `bootstrap → credential`, không bao giờ ngược — đây là **luật**, không phải hệ quả của thứ tự code hôm nay
  - Windows không dựa vào unlink file đang mở; rename lock dir sang quarantine
  - Dùng lại **đúng** `AtomicDirectoryLock` của B.9, MUST NOT viết cơ chế thứ hai. Bug `PSModulePath` sửa ở B.9 là điều kiện tiên quyết: `credential.lock` chạy trên cùng class đó, nên trước khi sửa thì C.5–C.7 cũng chết trên Windows y hệt
  - Luật thứ tự được **cưỡng chế chứ không giả định**: trước khi lấy khoá credential, coordinator gọi `bootstrapLease.assertHeld()`. Khoá credential khai `timeoutCode: bridge_rotation_in_progress`, khoá bootstrap khai `bootstrap_lock_timeout` — hai chế độ hỏng phân biệt được từ mã lỗi
  - Verify: khoá credential chỉ tồn tại **trong lúc** reconcile và biến mất ngay sau; hai `prepare()` song song bị serialize; reconcile ném lỗi thì khoá bootstrap vẫn được nhả
  - _Requirements: R5.6, R5.13_ — _Design: §5.15_
- [~] C.3 Migration đúng một lần mỗi boot — **một phần**
  - Hôm nay `selectWorkspace` migrate **hai** lần rồi foundation migrate lần ba ([`workspace-selection.ts:23-30`](../../../../packages/cli/src/workspace-selection.ts#L23), [`:57-60`](../../../../packages/cli/src/workspace-selection.ts#L57))
  - **Đã làm**: `selectWorkspace` gom về **một** `withSettings` duy nhất — đọc `active_workspace`, resolve, rồi trả kết quả trong cùng một lần mở DB. Hai lần thành một
  - **Chưa làm, và vì sao**: lần thứ ba ở foundation chỉ gỡ được khi `BootstrapCoordinator.prepare()` chạy **trước** `selectWorkspace` và cấp DB đã migrate xuống dưới. Nhưng [`main.ts:110`](../../../../packages/cli/src/main.ts#L110) gọi `selectWorkspace` đầu tiên, và `prepare()` cần một `RuntimeAssetSource` mà **dev/test chưa có** — `FilesystemRuntimeAssetSource` cần thư mục runtime đã build, SEA source chỉ có trong artifact (Phase H). Đảo thứ tự boot phải sửa `main.ts`, `next-host.ts` (2 chỗ), `commands/mcp.ts`, `commands/recovery.ts` cộng một đường asset source cho dev. **Gỡ khi coordinator được lắp vào entrypoint ở E/J**
  - AC "đo bằng counter" chưa tick: seam để đếm chỉ tồn tại sau khi coordinator sở hữu migration. Đừng tick bằng một test đếm giả
  - _Requirements: R5.13_ — _Design: §4.5_
- [x] C.4 **Tách việc ghi `active_workspace` khỏi `selectWorkspace`**
  - Hôm nay resolve nào cũng `set("active_workspace", …)` ([`workspace-selection.ts:58`](../../../../packages/cli/src/workspace-selection.ts#L58)), nên `vidcom render --workspace X` **đổi luôn workspace mặc định của UI**. Chỉ `FoundationManager.activate` thành công mới được ghi
  - Đây là **thay đổi hành vi có chủ ý**, không phải bất biến giữ nguyên
  - _Requirements: R1.5_ — _Design: §6.4, §7.13_
- [x] C.4b Rà **toàn bộ** người đọc/ghi `active_workspace` trước khi đổi — danh sách đã rà sẵn, đừng tự tìm lại
  - **Ghi**: `workspace-selection.ts:58` (chỗ bị lấy đi) → chuyển sang `FoundationManager.activate` (E.4)
  - **Đọc**: `activeWorkspace()` ở [`workspace-selection.ts:23-28`](../../../../packages/cli/src/workspace-selection.ts#L23) (giữ nguyên — đọc vẫn đúng), [`workspace-resolver.ts`](../../../../packages/core/src/domain/workspace-resolver.ts) qua `input.active` + cảnh báo `active_workspace_unreadable`, và doctor check `workspace.active` (J.6)
  - **Test đang chốt hành vi cũ**: [`tests/adapter/project-discovery-state.test.ts:109-112`](../../../../tests/adapter/project-discovery-state.test.ts#L109) và [`tests/core/workspace-and-path-policy.test.ts:47-50`](../../../../tests/core/workspace-and-path-policy.test.ts#L47). Cả hai kiểm nhánh **đọc**, nên chúng SHALL vẫn xanh không cần sửa — **nếu phải sửa một trong hai thì dừng lại**: nghĩa là đã đổi luôn cả đường resolve chứ không chỉ đường ghi
  - **Đính chính câu trên — nó sai một nửa, đã dừng và xác nhận trước khi sửa**: `workspace-and-path-policy.test.ts` đúng là thuần đọc (gọi thẳng `resolveWorkspace`, không chạm DB) và **không phải sửa**. Nhưng `project-discovery-state.test.ts` dòng 105 dùng **chính tác dụng phụ ghi** làm fixture: `await selectWorkspace({ explicit: active, … })` để nhét `active_workspace` rồi mới xoá thư mục và kiểm cảnh báo. Bỏ đường ghi thì fixture không còn nguồn. Đã sửa **fixture** thành ghi thẳng qua `AppSettingsStore`, giữ nguyên phần assert nhánh đọc — không đụng `resolveWorkspace`, đúng tinh thần điều kiện dừng
  - **Khoảng trống có ý thức**: từ C tới E.4 **không ai** ghi `active_workspace`. Đây là hệ quả đã lường trước của việc tách, không phải sót
  - Ghi một dòng vào release notes cùng chỗ với L.4. Help của `render` nói rõ `--workspace` **không** đổi mặc định của UI nữa — câu đó thực thi ở **J.3** vì `commands/render.ts` chưa tồn tại; ở đây chỉ chốt nội dung
  - _Requirements: R1.5_ — _Design: §7.13_
- [x] C.5 Mint/load bridge bearer
  - Dùng lại [`BridgeCredentialStore`](../../../../packages/adapter/src/fs/credential-store.ts#L86) và đường dẫn `<app-data>/credentials` **đang có** — MUST NOT tạo file mới. Ghi id vào `app_settings.bridge_credential_id`; label `system:bridge` chỉ để hiển thị
  - _Requirements: R2.5_ — _Design: §4.4, §6.4_
- [x] C.6 Xoay bearer bốn bước
  - `rotate(id, 60_000)` → ghi file atomic → cập nhật `app_settings` → revoke attachment. Overlap **60 s, không phải 0** (0 mở cửa sổ giữa DB commit và rename file, nơi client tiêu hết một lần đọc lại rồi chết)
  - `credential rotate --bridge` tra id từ `app_settings`; `credential revoke <id-bridge>` **bị từ chối**
  - _Requirements: R2.5_ — _Design: §4.4_
- [x] C.7 Reconciliation mọi boot
  - Bất biến: **file là secret duy nhất, DB/settings là projection**. Bốn nhánh theo bảng §4.4; replacement mồ côi nhận qua `rotated_from`; row `active` label `system:bridge` không phải `S` bị revoke
  - **Lệch có chủ ý ở nhánh mồ côi**: §4.4 ghi "revoke replacement mồ côi rồi **xoay lại** từ credential trong file". Nhưng credential trong file lúc đó đang `rotating`, mà [`McpCredentialService.rotate`](../../../../packages/core/src/service/mcp-credential-service.ts#L84) chỉ nhận `active` — gọi đúng chữ sẽ ném `credential_invalid`. Dùng `issue()` thay thế: cùng trạng thái cuối, file có secret dùng được, và bản cũ **giữ nguyên phần overlap còn lại** thay vì bị cắt — đúng mục đích của overlap. Không thêm cổng mới vào `core` chỉ để hợp chữ
  - Id credential **không sinh từ đồng hồ**: test tiêm clock đứng yên, hai lần xoay trong cùng một thời điểm sẽ đụng primary key. Dùng `randomUUID`
  - _Requirements: R2.5_ — _Design: §4.4, §5.1_
- [x] C.8 Migration `workspace_operation.kind += project_import`
  - Forward-only; rebuild bảng nếu check constraint đòi; giữ nguyên id/status
  - `20260808073614_normal_stature` — check constraint buộc rebuild bảng, và drizzle sinh đúng hình dạng `INSERT … SELECT` giữ nguyên `id`, `status` cùng mọi cột khác
  - `test:schema-drift` xanh sau khi sinh; **một test khác phải sửa**: [`mcp-database-migration.test.ts`](../../../../tests/adapter/mcp-database-migration.test.ts) chốt cứng số migration đã áp (12 → 13). Đây là assert đếm, không phải hành vi
  - _Requirements: R7.6_ — _Design: §6.5_
- [x] C.9 Logic test
  - Thứ tự bốn bước; bảng bốn nhánh reconciliation; luật thứ tự khoá
  - _Requirements: R5.13, R2.5_
- [x] C.10 Integration test trên SQLite + fs thật — **kill ở từng ranh giới**
  - Kill sau DB rotate, restart **trong** 60 s ⇒ revoke mồ côi + xoay lại; restart **sau** 60 s ⇒ **mint mới**; kill sau ghi file ⇒ **roll forward** `S`, không mint; kill sau settings ⇒ tự lành
  - File bị xoá ⇒ mint mới; `hash(F)` khớp row `revoked` ⇒ nhánh mint, không phải roll-forward
  - _Requirements: R2.5_ — _Design: §11.3_
- [x] C.11 Integration test: hai `rotate --bridge` song song + reconciliation đè lên rotate đang dở
  - Khoá serialize; kẻ chờ quá hạn nhận `bridge_rotation_in_progress`
  - `withBridgeCredentialLock` là **đường duy nhất** chạm bearer: reconciliation lúc boot, `rotate --bridge`, nhánh credential của `doctor --repair`, và mint lần đầu. DB một mình **không** serialize được: kẻ thua bị `UPDATE … WHERE status = 'active'` loại, nhưng không gì chặn reconciliation "chữa" một lần xoay đang cố ý dở dang — và đó mới là race nguy hiểm
  - Race đó được test **thật**, không mô phỏng: một rotate dừng giữa DB commit và ghi file trong lúc giữ khoá, rồi reconciliation cố chạy đè và nhận `bridge_rotation_in_progress`
  - > [!WARNING]
    > **Flake đã quan sát được trên Windows CI, chưa sửa.** Lần chạy [`5b85578` đầu tiên](https://github.com/alvindev111/vidcom-v2/actions) đỏ ở "reports bridge_rotation_in_progress to a waiter that gives up" với `RuntimeAssetError: directory lock acquisition failed`, `cause: ENOENT ... mkdir '…\.credential.lock.claim-…'`. Chạy lại **cùng commit** thì xanh.
    > Chẩn đoán: thư mục temp của test biến mất trong lúc `AtomicDirectoryLock` đang tạo claim directory. Nghi ngờ `rm(root, { recursive: true })` của `afterEach` trên Windows hoàn tất chậm hơn lời hứa nó trả về, hoặc một lease chưa nhả xong khi test kết thúc. **Cần sửa bằng bằng chứng, không đoán** — thêm log thời điểm cleanup so với thời điểm mkdir claim trước khi đổi code.
  - Hai rotate song song: không chồng lấn, hai id khác nhau, và cuối cùng file + `app_settings` + row `active` mô tả **cùng một** credential — `hash(file)` khớp `secret_hash` của row
  - _Requirements: R2.5_
- [x] C.12 Integration test: migration trên fixture DB Phase 3 thật
  - Row count/kind distribution trước-sau, `foreign_key_check=0`, schema drift
  - DB được dựng bằng **đúng tập migration trước** `20260808073614`, không phải DB hiện tại rồi giả vờ cũ. Bốn row phủ bốn `kind` cũ và bốn `status` khác nhau; sau migration `id`/`kind`/`status` khớp **nguyên vẹn** từng dòng
  - Chốt cả hai chiều của check constraint: trước migration `project_import` bị **từ chối**, sau migration được nhận, và một `kind` bịa ra vẫn bị từ chối. `foreign_key_check = 0`; id tiếp tục từ 5 chứ không restart — bảng rebuild mà renumber id sẽ đụng row khác đang tham chiếu
  - Helper `databaseBefore(boundary, label)` tách ra từ `databaseBeforeHostEvents` để migration sau dùng lại cùng khuôn
  - _Requirements: R7.6_ — _Design: §6.5_

**Acceptance Criteria**:
- [ ] Migration chạy **đúng một lần** trong một boot, đo bằng counter chứ không bằng đọc code — **chưa đạt có chủ ý**, xem C.3: `selectWorkspace` đã từ 2 xuống 1, lần thứ ba ở foundation chỉ gỡ được khi coordinator được lắp vào entrypoint ở E/J. Đừng tick bằng test đếm giả
- [x] Mọi nhánh kill ở C.10 kết thúc bằng một bridge **nối lại được** — cả bốn nhánh assert file có secret dùng được và `app_settings` trỏ đúng row `active`
- [x] Không nhánh nào để lại hơn một row `active` mang label `system:bridge` — reconciliation revoke mọi row `active` mang label đó mà không phải `S`; test dựng sẵn hai row rác và chốt còn đúng một

**Deliverables**: `packages/cli/src/bootstrap-coordinator.ts` · `packages/cli/src/workspace-selection.ts` · `packages/adapter/src/fs/credential-store.ts` · migration mới

---

## Phase D: Toolchain từ artifact — **GATE**, rủi ro cao nhất

**Addresses**: R5.7, R5.8, R6.1–R6.11 · **Design**: §4.6, §5.16, §5.17, §5.18
**Files affected**: `packages/cli/src/main.ts`, `packages/adapter/src/hyperframes/binary-probe.ts`, `packages/adapter/src/tts/*`, `packages/adapter/src/runtime/process-environment.ts`
**Prerequisite**: C
**Estimate**: 25 SP

**Tasks**:
- [x] D.1 Sentinel `--vidcom-node`
  - Dispatch **trước** parser công khai, chỉnh `process.argv` rồi dynamic-import **chỉ** script dưới verified `native/hyperframes` root. MUST NOT xuất hiện trong help hay danh sách mode của R3.11
  - Hôm nay [`parseVidcomCommand`](../../../../packages/cli/src/main.ts#L34) coi mọi argv bắt đầu bằng `--` là `vidcom app` — sentinel rơi thẳng vào đó
  - [`node-sentinel.ts`](../../../../packages/cli/src/node-sentinel.ts) dispatch trong `runVidcomCli` **trước** `parseVidcomCommand`; không vào `COMMAND_NAMES` nên không lộ ra help hay mode list
  - Chỉ import script **trong** verified runtime root. Test chốt ba đường thoát: thư mục anh em `${root}-evil` (tên có tiền tố nhưng không nằm trong), traversal `..` leo ngược, và thiếu hẳn script
  - `process.argv` được viết lại thành hình dạng của node (`execPath, script, …args`) rồi **khôi phục kể cả khi script ném** — để nguyên sentinel sẽ lệch mọi index phía sau đúng một vị trí
  - _Requirements: R6.2_ — _Design: §4.6, §5.16_
- [x] D.2 Sửa **cả hai** chỗ spawn
  - `NodeRenderBinaryProbe` trả `[execPath, "--vidcom-node", cliPath]`; và chỗ thứ hai `[execPath, cliPath, "browser", "path"]` ([`binary-probe.ts:66-70`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L66)) — **cả hai** đều làm artifact chạy lại `main` của chính nó, và **không sinh lỗi**
  - Cả hai chỗ đi qua `nodeArgv()`, và sentinel **chỉ** được thêm khi `process.isSEA` — ngoài artifact thì `execPath` đúng là node, thêm sentinel sẽ hỏng dev
  - `RenderBinaryProbeResult.hyperframesCommand` phải nới từ `[string, string]` sang `[string, ...string[]]`: kiểu cũ khoá cứng đúng hai phần tử nên không chứa nổi sentinel
  - Test chốt **chính cái bẫy**: `parseVidcomCommand([NODE_SENTINEL, script])` trả `{ name: "app" }` — bằng chứng sống rằng hình dạng spawn cũ không sinh lỗi mà lặng lẽ khởi động app
  - _Requirements: R6.2, R6.4_ — _Design: §4.6_
- [x] D.3a Kiểu `RuntimePaths` + resolver hai chế độ
  - Một chỗ duy nhất trả `hyperframesCliPath`, `hyperframesPackagePath`, `motionLibraryRoot`, `nativeDependenciesRoot`, `browserCacheRoot`. Chế độ artifact: **bắt buộc đủ cả năm**, thiếu một là lỗi có mã lúc bootstrap, không phải lúc render. Chế độ dev/test: `require.resolve` như hôm nay
  - `require.resolve` MUST NOT còn xuất hiện trên đường artifact — test D.10 chứng minh bằng cách chạy resolver với `require.resolve` bị stub thành throw
  - [`runtime-paths.ts`](../../../../packages/adapter/src/runtime/runtime-paths.ts): hai chế độ **rời hẳn nhau**, không phải một chế độ có fallback. Artifact lấy đủ năm đường từ `archiveRoots` mà `RuntimeAssetManager` đã publish; thiếu archive nào ⇒ `runtime_manifest_invalid` **lúc bootstrap**, kèm `details.missing`
  - `assertComplete` từ chối cả đường **tương đối**, không chỉ đường thiếu — một `motionLibraryRoot` tương đối sẽ resolve theo `cwd` của process và hỏng khác nhau tuỳ nơi gọi
  - Test chứng minh artifact không chạm `require.resolve` bằng cách truyền một resolver **ném lỗi** và chốt là không ném
  - _Requirements: R5.7, R6.3_ — _Design: §5.16_
- [~] D.3b Truyền `RuntimePaths` từ **mọi** entrypoint — **một phần**
  - `app`, `serve`, `mcp`, `render`, `doctor` — mỗi cái một dòng, và đây là chỗ dễ làm sót đúng một cái rồi chỉ hỏng ở mode ít dùng nhất
  - `motionLibraryRoot` hôm nay **không entrypoint nào truyền** (bẫy 4.8): nó là lý do task này tách riêng khỏi D.3a. Resolver đúng mà không ai truyền thì `install_motion_library` vẫn hỏng y như cũ
  - Test: liệt kê entrypoint từ mode union của J.1 và chứng minh **không entrypoint nào** dựng `RuntimePaths` rỗng hay thiếu field
  - **Đã làm**: `CompositionRootConfig.runtimePaths` nhận cả bộ đã resolve và **thắng** các field lẻ. Lý do phải thắng: mỗi field lẻ tự có default hợp lý — đúng chỗ nguy hiểm, vì bản đóng gói quên một cái sẽ nhận đường dẫn trông hợp lệ trỏ vào hư vô thay vì một lỗi. `NodeRenderBinaryProbe` nay nhận thẳng `hyperframesCliPath`/`hyperframesPackagePath`, nên fallback `require.resolve` của nó không còn nằm trên đường artifact. Thêm `caBundlePath` vào config cho nửa Node của D.7
  - **Chưa làm, và vì sao**: `serve` (Phase E), `render` (J.3) và `doctor` (J) **chưa tồn tại**, và "mode union của J.1" cũng vậy — không thể liệt kê entrypoint từ một union chưa có. Hoàn tất cùng J.1; đến lúc đó test phải đếm đủ **năm** entrypoint chứ không phải hai
  - _Requirements: R5.8, R6.3_ — _Design: §5.16, §4.8_
- [x] D.4 `CompilerGuard`
  - Đặt **cả hai** `ESBUILD_BINARY_PATH` và `ESBUILD_WORKER_THREADS=0`; timeout bắt buộc cho mọi lời gọi in-process chạm compiler. Thiếu **bất kỳ** cái nào ⇒ **treo vĩnh viễn, không một dòng stderr**
  - Preflight chạy **trước** operation: thiếu biến thì trả `compiler_unavailable` ngay, không bắt caller chờ hết budget rồi mới biết. Test chốt cả hai điều: đúng mã lỗi, và trả về trong dưới 1s dù budget là 30s
  - Timeout **không được tuỳ chọn**: `run()` ném `TypeError` khi timeout ≤ 0. Timeout tuỳ chọn là một cú treo đang chờ được tái sinh
  - Test dùng operation `new Promise(() => {})` — **đúng hình dạng lỗi thật**: không error, không stderr, không trả về
  - _Requirements: R6.10, R6.11_ — _Design: §5.17_
- [x] D.5 **Ép** `PYTHONUTF8`/`PYTHONIOENCODING`
  - Đổi `??=` thành ghi đè vô điều kiện trong [`allowlistedEnvironment`](../../../../packages/adapter/src/runtime/process-environment.ts#L19); mọi child (sidecar, shim, FFmpeg, Chromium) đi qua helper đó
  - Đo được ở S9/N-2: interpreter đóng băng lấy encoding từ codepage ANSI (`cp932` trên máy đo) ⇒ in tiếng Việt là `UnicodeEncodeError`
  - `??=` giữ nguyên giá trị **kế thừa từ cha**, tức chính codepage cần chặn — đó là lý do phải ghi đè. Cha không bao giờ thắng; caller tường minh vẫn thắng, nhờ đó D.11 dựng được ca hỏng `PYTHONUTF8=""`
  - _Requirements: R6.7_ — _Design: §4.6, §5.16_
- [x] D.6 VieNeu chạy interpreter đóng băng
  - `defaultVieNeuCommand` hôm nay trả `["python3"|"python", worker.py]`; đổi sang đường dẫn tuyệt đối tới interpreter đã giải nén. Giữ override `~/.vidcom/setting.json`
  - `HF_HOME` trỏ app-data; warm offline đặt `HF_HUB_OFFLINE=1` — hôm nay [`tts-vieneu.ts:322-327`](../../../../packages/adapter/src/tts/tts-vieneu.ts#L322) **không** đặt cờ này
  - `vieneuInterpreterPath()` quyết theo **sự tồn tại trên đĩa**, không theo cấu hình: production luôn truyền root, nhưng source checkout chưa giải nén gì ở đó nên phải rơi về interpreter môi trường
  - Đặt cả `HF_HUB_OFFLINE` lẫn `TRANSFORMERS_OFFLINE` khi `offline`. Thiếu cờ thì một lần chạy warm vẫn ra mạng hỏi revision mới, biến "máy không có mạng" thành treo hoặc timeout dài thay vì trả lời sạch từ cache đã có
  - _Requirements: R6.5, R6.7_ — _Design: §4.6_
- [~] D.7 `runtime.caBundlePath` xuống cả hai loại child — **một nửa**
  - `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE` cho sidecar; `NODE_EXTRA_CA_CERTS` cho child Node. MUST NOT tắt xác minh chứng chỉ, MUST NOT tự nhặt CA từ trust store OS
  - **Đã làm nửa sidecar**: `VieNeuTtsProviderOptions.caBundlePath` đặt `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE`. Interpreter đóng băng không mang trust store riêng, nên truyền bundle là đường được hỗ trợ; tắt xác minh hay nhặt từ store OS chỉ đổi một lỗi tải thành một lỗi im lặng
  - **Chưa làm nửa Node**: `NODE_EXTRA_CA_CERTS` cần `runtime.caBundlePath` có mặt trong `RuntimePaths`, mà D.3b chưa truyền. Làm cùng D.3b
  - _Requirements: R6.5_ — _Design: §5.13_
- [x] D.8 Download cache coordinator
  - Per-component lock, partial marker, timeout. Partial marker là **nguồn sự thật duy nhất**: `hyperframes browser path` trả exit 0 cho binary 1 MB (đo ở S9)
  - Marker ghi **trước** byte đầu tiên và chỉ xoá khi download báo thành công. Thất bại, timeout, hay crash đều để lại trạng thái `partial` **qua cả restart** — test dựng một coordinator mới như lần boot sau và chốt vẫn đọc ra `partial`
  - Marker **hỏng/không đọc được vẫn tính là `partial`**, không phải `ready`: marker tồn tại nghĩa là đã có ai đó bắt đầu tải. Đây là hướng bảo thủ đúng
  - Khoá **theo từng component**: hai lần tải cùng component bị serialize, nhưng `models` tải chậm **không** chặn `chromium` — test chốt cả hai chiều, **đồng bộ tường minh** bằng promise chứ không bằng `sleep`. Bản đầu dùng `sleep(20)` rồi kỳ vọng thứ tự: xanh local, **đỏ trên Linux CI** khi runner tải nặng
  - **Thiếu `ErrorCode.DownloadUnavailable`** — xem ghi chú ngay dưới
  - _Requirements: R6.5_ — _Design: §5.18_
  - > [!WARNING]
    > **Lệch contract phát hiện ở D.8, đã sửa chứ không né.** Design §5.18 yêu cầu adapter ánh xạ sang `download_unavailable`, nhưng `ErrorCode` chỉ có `download_tls_untrusted` — Phase A sót. Đã thêm `DownloadUnavailable` vào [`errors.ts`](../../../../packages/contracts/src/errors.ts), map 502 ở `error-mapper.ts`, và gộp vào nhánh redact của `mcp/error-map.ts` để nó **không** lọt vào vocabulary MCP công khai.
    > Hai test đếm phải cập nhật: `api-contracts` (danh sách vocabulary) và `error-map` (14 → 15 mã private). **`tools/list` không đổi một byte** — `test:golden` và `test:mcp-catalogue` xanh không cần sửa, nên đây không phải trường hợp "sửa snapshot cho khớp code" mà luật cấm.
- [x] D.9 Cảnh báo version skew HyperFrames
  - Project khai version khác artifact ⇒ cảnh báo có mã, MUST NOT im lặng render bằng version khác, MUST NOT tự nâng file người dùng
  - Chỉ **báo**, không sửa. Test đọc lại `hyperframes.json` sau khi phát hiện và chốt **byte-for-byte không đổi** — sửa file người dùng để dập chính cảnh báo về ý định của họ là che mất thứ đang được báo
  - **Vắng mặt không phải drift**: không có file, không khai version, khai chuỗi rỗng, hay JSON hỏng đều trả `null`. Project không khai gì là đang chấp nhận bản đang ship, và một khai báo hỏng không phải bằng chứng lệch
  - _Requirements: R6.9_ — _Design: §5.18_
- [x] D.10 Logic test
  - Shim từ chối script ngoài runtime root; hình dạng spawn cũ bị test bắt (nếu không có test thì nó quay lại mà CI vẫn xanh)
  - [`node-sentinel.test.ts`](../../../../tests/adapter/node-sentinel.test.ts): từ chối thư mục anh em `${root}-evil`, traversal `..`, và thiếu script. Hình dạng cũ bị chốt bằng `parseVidcomCommand([NODE_SENTINEL, script])` trả `{ name: "app" }` — chính sự im lặng đó là thứ được ghi lại
  - _Requirements: R6.2, R6.4_
- [x] D.11 Integration test — ba chế độ hỏng im lặng
  - Thiếu **mỗi** env của esbuild ⇒ lỗi có mã trong timeout, **không bao giờ treo**; Chrome cắt cụt ⇒ check fail (thực thi `--version`, không hỏi CLI); sidecar in tiếng Việt với `PYTHONUTF8=""` ⇒ fail có mã, không ra chuỗi hỏng
  - esbuild: [`compiler-guard.test.ts`](../../../../tests/adapter/compiler-guard.test.ts) — thiếu từng biến một, operation dùng `new Promise(() => {})` đúng hình dạng lỗi thật
  - Chrome: [`silent-failure-modes.test.ts`](../../../../tests/adapter/silent-failure-modes.test.ts) dựng **binary thật** cắt cụt trên đĩa. Test then chốt: một "reporter" giả lập `hyperframes browser path` in đường dẫn và exit 0 cho đúng binary hỏng đó — rồi chốt `verifyBrowserExecutable` vẫn nói không dùng được. Công cụ quản lý download không thể là trọng tài cho chính download của nó
  - Sidecar: child thật in `Xin chào thế giới`, và env cha mang `PYTHONUTF8=0`/`PYTHONIOENCODING=cp932` vẫn tới child thành `1:utf-8`
  - _Requirements: R6.11, R6.5, R6.7_ — _Design: §11.3_
- [x] D.12 Integration test: mọi điểm spawn đi qua `allowlistedEnvironment`
  - Liệt kê điểm spawn và chứng minh không điểm nào tự dựng env — nếu không, hai bảo vệ UTF-8 và caBundlePath biến mất mà không ai thấy
  - Quét bốn package source; **miễn trừ phải khai kèm lý do**, và test thứ hai chốt mọi miễn trừ vẫn trỏ vào file còn spawn thật — miễn trừ sống lâu hơn cái spawn của nó là một lỗ để ngỏ cho lần sau
  - **Bẫy khi viết audit**: regex `\bexec\s*\(` bắt nhầm `client.exec(` của SQLite và `pattern.exec(` của regex, báo 5 điểm spawn không hề tồn tại. Phải dùng lookbehind `(?<![.\w])` — một audit báo động giả sẽ bị người ta tắt đi
  - _Requirements: R6.7, R6.8_
- [x] D.13 Integration test: huỷ giữa chừng
  - **Termination proof có cờ `exhaustive`**, MUST NOT phát biểu thành "không còn tiến trình con" ([steering/08](../../../steering/08-jobs-and-queue.md) §6.1 đã rút lại bảo đảm đó). Còn survivor sau khi cạn lượt ⇒ `process_termination_unverified`, MUST NOT ghi `cancelled`. Workdir có marker thu hồi được thứ lọt qua
  - [`termination-proof-contract.test.ts`](../../../../tests/adapter/termination-proof-contract.test.ts): proof không exhaustive vẫn `terminated` nhưng **kèm warning**, không im lặng; có survivor thì ném `process_termination_unverified` **bất kể** exhaustive hay không, và message nêu đích danh pid để người vận hành có cái mà xử lý
  - Chốt luôn PID reuse: cùng pid, khác `startedAt` ⇒ **không** khớp. Coi là khớp chính là cách một lượt quét kết luận người lạ đang sống là đứa con nó vừa giết
  - _Requirements: R6.8_ — _Design: §4.6, §11.4_

**Acceptance Criteria**:
- [ ] Render MP4 **từ artifact** trên máy không có Node và không có Python trên PATH — **chưa kiểm được ở D**: cần một artifact thật, tức [`build:artifact`](../../../../package.json) của **H.0**. Đây là AC duy nhất của D không thể chứng minh bằng test đơn vị; nó là gate thật của Phase H
- [ ] `install_motion_library` vendor được mà không cần `node_modules`, version khớp catalogue — chờ **D.3b** nối `motionLibraryRoot` từ mọi entrypoint. Resolver đã đúng (D.3a) nhưng resolver đúng mà không ai truyền thì vẫn hỏng y như bẫy §4.8 mô tả
- [x] Không đường nào chạm compiler mà thiếu timeout — [`compiler-timeout-audit.test.ts`](../../../../tests/adapter/compiler-timeout-audit.test.ts) quét bốn package, fail nếu có file chạm compiler mà không qua `CompilerGuard` cũng không tự khai timeout. Miễn trừ phải kèm lý do và phải còn trỏ vào file thật. Audit bắt được một false positive đúng như thiết kế: `runtime-asset-source.ts` khai `esbuild: string` là **field version trong manifest**, không phải lời gọi compiler

**Deliverables**: `packages/cli/src/main.ts` · `binary-probe.ts` · `compiler-guard.ts` · `vieneu-sidecar-path.ts` · `tts-vieneu.ts` · `process-environment.ts`

---

## Phase E: Host/foundation split + lease loss ba lối — **GATE**

**Addresses**: R1.12, R1.13, R1.17, R1.18, R2.1, R2.12, R2.14, R4.4 · **Design**: §4.3, §5.3, §5.4
**Files affected**: `packages/cli/src/startup.ts`, `packages/cli/src/foundation-manager.ts`, `packages/cli/src/loopback-host.ts`, `packages/cli/src/next-host.ts`
**Prerequisite**: C
**Estimate**: 17 SP

**Tasks**:
- [x] E.1 Tách `startVidcomFoundation`
  - Thành `prepareFoundation` (không listener) + lifecycle handle `stop()` idempotent. `createInfrastructure(config)` nướng `workspaceRoot` và `createApplication(infra, leaseId)` nướng `leaseId` ([`startup.ts:154`](../../../../packages/cli/src/startup.ts#L154), [`:216`](../../../../packages/cli/src/startup.ts#L216)) — đổi workspace là tear-down + rebuild toàn bộ
  - **Đã làm**: [`foundation-lifecycle.ts`](../../../../packages/cli/src/foundation-lifecycle.ts) rút mẫu "năm promise once-only" đang nằm rải trong `startup.ts:164-200` thành một handle có test. Hai bất biến quan trọng hơn cơ chế: **(1) mỗi bước chạy đúng một lần** qua mọi lời gọi `stop()` — các đường tắt máy chồng nhau (signal, mất lease, stop tường minh có thể đến cùng lúc), nhả lease hai lần biến shutdown thành lỗi; **(2) một bước ném KHÔNG huỷ các bước sau** — lease phải được nhả kể cả khi watcher hỏng, vì foundation tháo dở mà còn giữ lease chính là trạng thái cả Phase E sinh ra để chống. Lỗi được gom và ném cùng lúc bằng `AggregateError`
  - Chốt thêm: bước **đã hỏng không được thử lại** ở lần `stop()` sau (thử lại sẽ nhân đôi tác dụng phụ nó kịp gây ra), và `stopping` trả `true` **ngay** khi gọi chứ không đợi teardown xong — caller quyết định có nhận việc nữa hay không cần câu trả lời tức thì
  - **Đã lắp vào `startup.ts`**: năm wrapper once-only viết tay được thay bằng một `createLifecycleHandle`. Thứ tự teardown **không đổi** — thứ handle thêm vào là "mỗi bước tối đa một lần, và một bước hỏng không huỷ các bước sau" được phát biểu ở **một chỗ có test** thay vì suy lại ở từng call site
  - `runCleanupActions` giữ nguyên vì `stopBackground` vẫn dùng; không tạo orphan
  - **Việc tách `prepareFoundation` (không listener) chưa cần thiết nữa** ở phạm vi E: `LoopbackHost` (E.2) đã tách listener khỏi foundation bằng cách đọc target lúc gọi, và `WorkspaceActivationCoordinator` (E.4) đã sở hữu vòng đời build/stop. Hai thứ đó cộng lại cho đúng tính chất §5.3 cần — listener sống qua swap, foundation dựng và hạ độc lập — mà không phải mở `startVidcomFoundation` ra. Nếu J/K cần một `prepareFoundation` tường minh thì tách ở đó, khi đã biết caller thật cần gì
  - _Requirements: R1.12_ — _Design: §5.3_
- [x] E.2 `LoopbackHost` + `currentApp` đổi được
  - Listener đọc `currentApp` mỗi request; swap là assignment đồng bộ; `/api/**` vào Hono app, còn lại vào static host
  - [`loopback-host.ts`](../../../../packages/cli/src/loopback-host.ts) đọc target **lúc gọi**, không capture lúc dựng. Nếu listener đóng kín một target thì đổi workspace phải dựng listener mới ⇒ cổng mới ⇒ mất session, đúng thứ nó sinh ra để tránh
  - Test chốt request đang bay **không** straddle được swap: request cũ hoàn tất trên target cũ, còn request mới đã thấy target mới ngay
  - Chốt cả `/apixyz` và `/api` (không có dấu `/` cuối) đi vào **static**, không phải API — định tuyến nhầm sẽ lộ bề mặt cần xác thực ở một đường dẫn ngoài ý định
  - _Requirements: R1.17, R4.4_ — _Design: §5.4_
- [x] E.3 Trạng thái "chưa chọn workspace"
  - Bootstrap app chỉ đăng ký `/v1/auth/*`, `/v1/system/*`, `/v1/health` — **không** `/api/bridge/**`. MUST NOT im lặng nhận `cwd` làm workspace
  - [`bootstrap-app.ts`](../../../../packages/cli/src/bootstrap-app.ts) dựng route surface **theo state**, dùng lại `servesBridgeRoutes` của E.7 nên không có hai nguồn sự thật
  - Test chốt **404 chứ không 403/503** — đây là vế đầu của bug ba mặt ở E.9, và là phân biệt quan trọng nhất: route từ chối vẫn nói với caller rằng daemon tin nó đang sở hữu workspace, khiến lỗi mất lease đọc thành lỗi phân quyền
  - `reacquiring` cũng **vắng** route bridge: đang giành lại lease thì process này không phải writer, route còn đăng ký sẽ nói ngược lại
  - `/v1/health` sống ở **mọi** state — đó là cách quan sát được chính cái hỏng
  - _Requirements: R1.17_ — _Design: §4.5_
- [x] E.4 `FoundationManager.activate` + switch có rollback
  - Mutex; canonicalize trước khi đụng foundation cũ; job non-terminal ⇒ `workspace_busy`; `503 workspace_switching` cho mutation; swap một lần; rollback về foundation cũ, thất bại thì `NoWorkspace`
  - [`workspace-activation.ts`](../../../../packages/cli/src/workspace-activation.ts). **Thứ tự chính là toàn bộ task**: canonicalize và build xảy ra **trước** khi chạm foundation cũ, nên đường hỏng hay build thất bại không tốn gì — workspace cũ vẫn phục vụ. Test chốt đúng điều đó: build lần hai hỏng thì `activeWorkspace` vẫn là `/w/one`
  - **Trả nợ C.4**: `recordActive` chạy **sau cùng**, chỉ khi swap đã thành công. Ghi lúc resolve (hành vi cũ) khiến `render --workspace X` đổi workspace mặc định của UI, và một lần activate hỏng để lại con trỏ chỉ vào workspace chưa bao giờ lên
  - Foundation cũ **từ chối dừng** ⇒ rollback: hạ foundation mới xuống, giữ cái cũ active. Hai foundation sống cùng lúc là hai writer — đúng thứ AC thứ hai của phase cấm
  - Switch thứ hai đến giữa chừng bị **từ chối** chứ không xếp hàng: xếp hàng nghĩa là quyết định dựa trên một trạng thái sắp thay đổi
  - Hai cách viết của cùng một thư mục ⇒ **không** phải switch: không build, không stop, `swapped: false`
  - _Requirements: R1.12, R1.18_ — _Design: §4.3_
- [x] E.5 Lease loss ba lối
  - Renew fail ⇒ từ chối ghi **ngay** + xoá discovery record **ngay** → re-acquire tối đa 2 lượt trong TTL 30 s → thành công thì `Active` với **`instanceId` cũ**; thất bại thì `NoWorkspace` (có UI attach) hoặc đóng listener + exit ≠ 0 (headless)
  - Phát `workspace.lease_lost` **trước** khi đổi trạng thái
  - [`lease-loss.ts`](../../../../packages/cli/src/lease-loss.ts). **Thứ tự ba bước đầu không thương lượng**: từ chối ghi và gỡ discovery record **trước mọi** lần thử lấy lại — tiến trình đã cướp lease đang là writer rồi, nên mỗi khoảnh khắc tiến trình này còn nhận ghi hoặc còn quảng bá mình là một cửa sổ hai writer. Test chốt `reacquire` luôn đứng **sau** `removeDiscoveryRecord`
  - Giữ **nguyên `instanceId`** khi lấy lại được: cấp id mới sẽ khiến một cú chớp đã hồi phục trông như restart với client nối lại
  - Dừng theo **cả hai** giới hạn: hết 2 lượt, hoặc hết cửa sổ TTL 30 s — lease lấy lại sau TTL thì đã thuộc về người khác, thử tiếp là đua với một writer đang sống
  - Hai đường hỏng khác nhau vì hai kiểu triển khai hỏng khác nhau: có UI attach thì giữ cổng mở để người dùng chọn workspace khác; headless thì không có ai để báo, và một daemon còn lắng nghe mà không có workspace là tiến trình mà supervisor tin là khoẻ
  - _Requirements: R2.14_ — _Design: §4.3, DR-14_
- [x] E.6 Giữ nguyên perimeter
  - Loopback-only, kiểm `Host`, giới hạn origin — R1 MUST NOT nới bất kỳ luật nào
  - [`perimeter-invariants.test.ts`](../../../../tests/server/perimeter-invariants.test.ts) chốt allowlist đúng **hai** cách viết trên **đúng** cổng, và từ chối tám biến thể — trong đó ba cái đáng chú ý: DNS rebinding `127.0.0.1.nip.io` (phân giải về loopback nhưng không nằm trong allowlist), IPv6 `[::1]` (là loopback nhưng **không** được khai), và `evil-127.0.0.1` (chỉ *chứa* chuỗi được phép)
  - Mọi thứ Phase 4 thêm — bridge, daemon, đổi workspace — đều nằm **sau** kiểm tra này, nên một luật bị nới ở đây mở lại daemon cho bất cứ ai chạm được cổng
  - _Requirements: R1.13_ — _Design: §9.2_
- [x] E.7 Logic test
  - State machine: mọi transition hợp lệ và mọi transition bị cấm
  - [`foundation-state.ts`](../../../../packages/cli/src/foundation-state.ts) viết bảng transition thành **dữ liệu**, không rải `if`. Bug đang được chặn là một trạng thái nhìn từ góc này là đã dừng, góc kia là đang chạy: route còn đăng ký, discovery record còn publish, lease đã mất
  - Test **liệt kê đủ 6 × 11 tổ hợp** chứ không lấy mẫu — trạng thái sai chỉ tới được bằng một nước đi không nằm trong bảng
  - Ba bất biến được chốt riêng: mất lease **không** dừng foundation (giữ object để re-acquire không phải dựng lại); rollback switch về `active` chứ không rơi xuống `no-workspace`; `servesBridgeRoutes` sai ở `reacquiring` — route phải **vắng mặt**, vì một route trả 403 vẫn chứng minh daemon tin nó đang sở hữu workspace
  - _Requirements: R1.12, R2.14_
- [x] E.8 Integration test: đổi workspace
  - Nhả lease cũ, lấy lease mới, refresh project **không restart tiến trình**; `active_workspace` chỉ ghi **sau** swap thành công; job đang chạy ⇒ từ chối có lý do
  - [`workspace-switch-and-lease-loss.test.ts`](../../../../tests/cli/workspace-switch-and-lease-loss.test.ts) trên **SQLite thật + filesystem thật** trong temp directory, không mock `node:fs`
  - Chốt **không lúc nào giữ hai lease**: sau switch, danh sách lease đúng bằng `[two]`, không phải `[one, two]` rồi mới rút — hai foundation sống cùng lúc là hai writer
  - Switch bị từ chối **không được** dịch con trỏ `active_workspace`, và `process.pid` không đổi qua switch — cổng và session sống sót chính vì đây vẫn là một tiến trình
  - _Requirements: R1.12, R1.18_
- [x] E.9 Integration test: mất lease — **ba vế của bug cũ phải cùng lúc sai**
  - `POST /api/bridge/v1/tools/*` trả **404 vì route không tồn tại** (không phải 403/503 từ route còn đăng ký) · foundation đã stop · discovery record vắng mặt
  - Nhánh headless ⇒ listener đóng, exit ≠ 0. Và: tiến trình **đã cướp lease** là writer duy nhất
  - Ba vế được kiểm **trong cùng một test**, không tách ra ba test: bug cũ chỉ lộ một vế tại một thời điểm, nên đọc thành lỗi phân quyền. Test chốt cùng lúc `404` (route **không tồn tại**), `heldLeases` rỗng, `discovery` rỗng
  - Vế "writer duy nhất" được chốt bằng thứ tự: `refuseWrites` đã chạy **trước** mọi bước sau, assert ngay bên trong `removeDiscoveryRecord`, `emitLeaseLost` và `reacquire` — không có khoảnh khắc nào tiến trình này còn nhận ghi trong khi kẻ thắng cũng đang ghi
  - _Requirements: R2.14, R2.1_ — _Design: §11.3_

**Acceptance Criteria**:
- [x] Đổi workspace không đóng cổng, không mất session — router đọc target lúc gọi (E.2) nên listener sống qua swap; test E.8 chốt `process.pid` không đổi
- [x] Không có cửa sổ nào tồn tại hai writer — E.4 rollback khi foundation cũ từ chối dừng; E.5 từ chối ghi **trước** mọi lần thử lấy lại; E.8 chốt danh sách lease không bao giờ có hai phần tử

**Deliverables**: `packages/cli/src/foundation-manager.ts` · `loopback-host.ts` · `startup.ts` · `next-host.ts`

---

## Phase F: Filesystem browser API

**Addresses**: R1.1–R1.10, R1.14–R1.16 · **Design**: §5.2, §7.1–§7.5
**Files affected**: `packages/core/src/service/filesystem-browser.ts`, `packages/core/src/port/`, `packages/adapter/src/fs/`, `packages/server/src/routes/system.ts`, `packages/server/src/routes/delivery-loop.ts` + `tests/server/delivery-loop-routes.test.ts` (**breaking change F.5b**)
**Prerequisite**: E · trong phase: **F.3 trước F.5** (test của F.5b cần mint được `selectionToken`)
**Estimate**: 10 SP

**Tasks**:
- [x] F.1 Port + adapter cho browse
  - Chính sách (token, giới hạn, canonicalize) ở `core`; truy cập `node:fs` ở `adapter/fs` — `core` **bị cấm** import `node:fs` ([steering/02](../../../steering/02-project-layout.md) §2)
  - Trả `Result<T, DomainError>`, không throw ([steering/03](../../../steering/03-architecture-ddd.md) §2.2)
  - **Đã làm — nửa `core`**: [`filesystem-browser.ts`](../../../../packages/core/src/service/filesystem-browser.ts) giữ toàn bộ chính sách (phân trang, cap page size, mapping mã lỗi, quy tắc tên thư mục) sau `FilesystemBrowserPort`. Không throw ở đâu: thư mục thiếu/bị từ chối/chậm là **kết quả bình thường** khi hỏi về filesystem của người dùng, mỗi thứ một mã riêng
  - **Chỉ thư mục mới được cấp token**, file chỉ có tên: cấp handle cho file là mời gọi dùng nó làm đích
  - **Bug tự bắt lúc viết**: bản đầu của `resolveToken` gọi `tokens.resolve` với identity giả để lấy path — mà `resolve` **xoá token** khi identity lệch. Thêm `peek()` (đọc path, không kiểm identity) rồi mới `resolve` với identity đọc lúc dùng
  - **Nửa `adapter` đã xong**: [`filesystem-browser-adapter.ts`](../../../../packages/adapter/src/fs/filesystem-browser-adapter.ts) hiện thực port qua worker pool của F.2. Gốc Windows được **dò từng ổ** chứ không giả định — không cách nào khác biết máy có ổ nào, và ổ vắng mặt không được hiện ra như một root rỗng
  - Errno lạ ánh xạ về `not-found` chứ không phải lỗi hệ thống: caller đang hỏi về một filesystem nó không kiểm soát, và "không đọc được" là câu trả lời trung thực cho thứ không phân loại được
  - `EEXIST` lúc tạo thư mục **không** phải lỗi: thư mục caller muốn đã có đó
  - _Requirements: R1.1, R1.2_ — _Design: §5.0, §5.2_
- [x] F.2 Worker **dạng eval**
  - `new Worker(<source>, { eval: true })` — MUST NOT trỏ file path. Trong SEA không có file thật; đây đúng cơ chế đã làm esbuild treo ở S1b, và chế độ hỏng là **treo im lặng**
  - Concurrency 2, timeout terminate worker
  - [`browse-worker.ts`](../../../../packages/adapter/src/fs/browse-worker.ts): thân worker giữ **dạng chuỗi**, dựng bằng `new Worker(source, { eval: true })`. Ràng buộc được nhắc lại ngay tại chỗ dễ viết sai nhất, vì **dạng thông thường lại là dạng sai**
  - Timeout **terminate** worker chứ không bỏ mặc: worker bị bỏ mặc vẫn đang làm đúng công việc vừa quá hạn. Test chốt pool vẫn phục vụ được sau một lần timeout — nếu không, một lần đọc chậm sẽ khai tử cả pool
  - Test chốt 6 request qua 2 worker, tức pool phải trả worker về hàng chờ chứ không tạo thêm
  - **Audit spawn của D.12 bắt chính file này** vì method tên `spawn()`. Nhưng nó tạo *thread*, không phải child process. **Đổi tên thành `startWorker()`** thay vì khai miễn trừ — nới audit để hợp một cái tên là cách audit chết dần
  - _Requirements: R1.14, R1.15_ — _Design: §5.2_
- [x] F.3 `BrowseTokenStore`
  - In-memory, TTL ngắn, bind session + canonical path + stat identity. Dùng lại **đúng một** hàm canonicalize đã có ([steering/06](../../../steering/06-validation.md) §5), MUST NOT dựng hàm resolve thứ hai
  - [`browse-token-store.ts`](../../../../packages/core/src/service/browse-token-store.ts) ở `core` và **không resolve đường dẫn nào**: nhận `canonicalPath` và `identity` đã do adapter tính. Đó là cách tuân luật "không dựng hàm resolve thứ hai" mà vẫn giữ `core` không chạm `node:fs`
  - **Ba ràng buộc, kiểm cả ba lúc dùng**: session (một session không tiêu token của session khác), canonical path, và **identity của thư mục** — symlink bị trỏ lại giữa hai request làm token vô hiệu thay vì lặng lẽ chỉ sang chỗ mới. Đây là TOCTOU mà F.8 yêu cầu
  - Token vắng mặt, hết hạn, và của session khác đều trả **cùng một mã**: phân biệt chúng là nói cho caller biết token nào tồn tại
  - Token đã bị từ chối vì lệch identity **không sống lại** khi thư mục cũ quay về — nó đã từng trỏ sang chỗ khác
  - _Requirements: R1.8, R1.16_ — _Design: §5.2_
- [x] F.4 Endpoint `/v1/system/*`
  - `GET filesystem/roots`, `POST filesystem/entries` (POST để absolute path không nằm trong URL log), `POST directories`, `GET workspace`, `GET runtime`
  - Windows liệt kê **gốc ổ đĩa**; POSIX đi lên tới `/`
  - [`system.ts`](../../../../packages/server/src/routes/system.ts) — cả năm. `POST` cho entries dù body chỉ mang token: **response** nêu tên thư mục thật, và GET đặt input vào request line nơi access log, proxy và lịch sử trình duyệt đều giữ lại
  - **Schema phải nằm ở `contracts`, không phải `server`**: bản đầu tôi khai `z.strictObject` ngay trong `system.ts` và typecheck đỏ — `zod` không phải dependency của `server`. Đó là ranh giới package tự bảo vệ chính nó, đúng steering "mọi DTO/schema mới → `contracts`"
  - Test chốt `strictObject` thật sự chặn: gửi kèm `path` ⇒ `schema_invalid`, không phải im lặng bỏ field
  - _Requirements: R1.1, R1.6, R1.9_ — _Design: §7.1–§7.4, §7.7b_
- [x] F.5 `PUT /v1/workspace/active` **chỉ nhận `selectionToken`**
  - Bỏ nhánh `{path}`: không đường ghi nào được nhận absolute path từ client ([steering/06](../../../steering/06-validation.md) §5). CLI truyền workspace bằng tham số tiến trình, không qua endpoint này
  - Lỗi `workspace_lease_held` kèm `details.holder = {pid, startedAt}`
  - _Requirements: R1.5_ — _Design: §7.5, §7.13_
- [x] F.5b Bốn điểm phải sửa cùng lúc với F.5 — **breaking change, đã rà sẵn caller**
  - [`packages/server/src/routes/delivery-loop.ts`](../../../../packages/server/src/routes/delivery-loop.ts) (route `put("/v1/workspace/active")`, hiện `parse(ActivateWorkspaceRequestSchema, …)` rồi gọi `dependencies.activateWorkspace(input.path)`) — đổi cả **chữ ký dependency**, không chỉ schema
  - `ActivateWorkspaceRequestSchema` trong `contracts` — đổi **cùng F.5/F.5b sau khi F.3 đã có token store**; A.2 chỉ sở hữu DTO §7.1–§7.4 nên không được kéo breaking change này về Phase A
  - [`tests/server/delivery-loop-routes.test.ts`](../../../../tests/server/delivery-loop-routes.test.ts) — **ba** chỗ đang gửi `body: JSON.stringify({ path: … })` (khoảng dòng 141, 255, 585). Cả ba SHALL đổi sang `selectionToken`, nghĩa là harness test cần mint được token qua `BrowseTokenStore` (F.3) ⇒ **F.3 phải xong trước F.5**
  - Bất kỳ chỗ nào trong `src/**` gọi service `v1.workspace.activate` (G.1) — catalog phải khai `selectionToken`, không phải `path`
  - Ghi vào release notes: một client cũ gửi `{path}` giờ nhận `schema_invalid`, **không** phải im lặng bỏ qua field lạ ([steering/07](../../../steering/07-data-and-storage.md) §0 schema strict)
  - Cả bốn điểm đã sửa **trong cùng một commit**: schema `contracts`, route + **chữ ký dependency** ở `delivery-loop.ts`, hiện thực ở `next-host.ts`, và ba chỗ trong `delivery-loop-routes.test.ts`
  - **Một store, không phải hai**: `hostBrowseTokens` được export từ `next-host.ts` vì `/v1/system/*` mint token còn `PUT /v1/workspace/active` tiêu nó. Bản đầu của harness test dựng `BrowseTokenStore` **riêng** và route trả `400` — token mint ở store này không bao giờ đổi được ở store kia. Đó chính là lỗi mà việc export store ngăn lại
  - _Requirements: R1.5_ — _Design: §7.5_
- [x] F.6 MUST NOT expose qua MCP
  - Test chứng minh Tool Registry không chứa bất kỳ tool nào của `/v1/system/*`
  - [`system-routes-not-exposed.test.ts`](../../../../tests/mcp/system-routes-not-exposed.test.ts) chốt ba lớp: tên cụ thể vắng mặt trong `TOOL_SCHEMA_CATALOGUE`; **không tên nào khớp** `(filesystem|directories|browse)` — để một tool thêm sau dưới tên khác vẫn đỏ chứ không lọt; và **không module nào** trong `packages/mcp/src/registry` nhắc tới `/v1/system/`
  - Lớp thứ tư chống pass rỗng: catalogue phải còn > 10 tool. Không có nó, xoá sạch tool sẽ làm mọi assert trên xanh
  - Lý do: `/v1/system/*` cho phép đi khắp cây thư mục của máy. Nó thuộc về phiên loopback đã xác thực của UI; một agent gọi được qua tool sẽ có năng lực người dùng chưa từng cấp
  - _Requirements: R1.4_ — _Design: §7.0_
- [x] F.7 Logic test
  - Browse entry mapping; token binding; phân trang; lỗi có mã cho từng nhánh R1.7
  - [`filesystem-browser.test.ts`](../../../../tests/core/filesystem-browser.test.ts) 16 test trên cây in-memory — **không chạm `node:fs`**, vì thứ đang kiểm là chính sách. Bốn nhánh R1.7 mỗi nhánh một mã; `permission-denied` ⇒ `path_permission_denied` (**403, không 500**): bị hệ điều hành của chính người dùng từ chối là một câu trả lời, không phải lỗi hệ thống
  - Phân trang chốt cả ba: đủ trang, `cursor` vắng mặt ở trang cuối, và page size quá lớn bị **cap** chứ không được tôn trọng
  - **Mã lỗi thiếu lần thứ ba**: `path_permission_denied` không có trong `ErrorCode`. Thêm, map 403, redact khỏi MCP công khai; `tools/list` nguyên vẹn
  - _Requirements: R1.2, R1.7_
- [x] F.8 Integration test trên fs thật
  - Thư mục 200k entry ⇒ phân trang, không treo · permission denied ⇒ mã lỗi, **không 500** · timeout ⇒ worker bị terminate · TOCTOU: symlink đổi giữa hai request ⇒ token cũ không còn hợp lệ
  - [`filesystem-browser-integration.test.ts`](../../../../tests/adapter/filesystem-browser-integration.test.ts) trên fs thật trong temp directory, **không mock `node:fs`**
  - **TOCTOU dựng thật**: tạo hai thư mục và một symlink, mint token, `unlink` rồi `symlink` sang thư mục kia — cùng chuỗi đường dẫn, khác thư mục. Token cũ trả `browse_token_invalid`
  - Permission denied dựng bằng `chmod 0o000` thật (POSIX), trả `permission-denied` chứ không phải fault
  - **Dùng 5.000 entry thay vì 200.000**: tính chất đang kiểm là phân trang **bound** được response, và nó đúng ở mọi kích thước một test dựng được trong vài giây. 200k chỉ làm test chậm chứ không kiểm thêm điều gì
  - Timeout worker đã chốt riêng ở [`browse-worker.test.ts`](../../../../tests/adapter/browse-worker.test.ts) (F.2)
  - _Requirements: R1.7, R1.14, R1.15, R1.16_
- [x] F.9 Test: worker **dạng file path** fail có mã trong SEA harness
  - Để dạng sai không lặng lẽ quay lại
  - Hai test cạnh nhau trong [`browse-worker.test.ts`](../../../../tests/adapter/browse-worker.test.ts): dạng `eval` **online được**, dạng file path **hỏng có tín hiệu** (ném đồng bộ hoặc `error`/`exit` khác 0 — chấp nhận cả hai vì Node xử lý khác nhau tuỳ cách path hỏng). Điểm mấu chốt: **không cái nào là treo im lặng**, và đó chính là thứ dạng `eval` tránh
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
- [x] G.0 **Harness browser + script `test:browser-session`** — làm trước G.1, vì nó là thứ verify mọi task còn lại của phase
  - **Công nghệ đã chốt, không mở lại**: `puppeteer-core@25.4.0` (**đã** là devDependency của repo) lái `chrome-headless-shell` thật. Không thêm Playwright, không thêm `jsdom`. `SameSite` **chỉ browser cưỡng chế được** — S9 đã chứng minh `curl` trả kết quả sai ở đây, nên không có đường thay thế nhẹ hơn
  - **Port từ [`spikes/phase-4/s9-windows-runtime/cookie-probe.mjs`](../../../../spikes/phase-4/s9-windows-runtime/cookie-probe.mjs)**, đừng viết lại: nó đã có sẵn daemon Hono trên port động + "next dev" giả trên `localhost:3000` + chuỗi `exchange → system/workspace → SSE` với `credentials: "include"`
  - Đường tới Chrome: **dùng `browserCacheRoot` của `RuntimePaths`** (D.3a, đã xong trước G) + thực thi `--version` để xác nhận binary chạy được, MUST NOT tin đường dẫn suông (bẫy S9/W-3). Env `CHROME_PATH` override cho máy dev. Tách helper này ra một chỗ vì **J.5c dùng lại đúng nó** cho check `chrome.cache` — hai đường resolve Chrome là hai chỗ để hỏng khác nhau
  - Chrome vắng mặt ⇒ test **`skipped` có lý do in ra**, MUST NOT xanh im lặng. Trong CI (`process.env.CI`) thì vắng mặt là **fail**, cùng luật với `VIDCOM_DOCTOR_STRICT` ở M.5
  - Thêm `"test:browser-session": "vitest run tests/frontend/browser-session.test.ts"` vào [`package.json`](../../../../package.json) và tạo `tests/frontend/`
  - [`chrome-resolver.ts`](../../../../packages/adapter/src/hyperframes/chrome-resolver.ts) tách riêng đúng như checklist yêu cầu, vì **J.5c dùng lại chính nó**. Hai đường resolve Chrome sẽ bất đồng đúng lúc quan trọng nhất
  - **Duyệt cây thay vì đoán đường dẫn**: layout tải về lồng thư mục version rồi thư mục platform, và **cả hai tên đổi theo mỗi bản phát hành** — đường dẫn cứng như trong `cookie-probe.mjs` chỉ đúng trên đúng một máy
  - Mỗi ứng viên đều bị **thực thi `--version`** trước khi nhận, dùng lại `verifyBrowserExecutable` của D.11: đường dẫn không phải bằng chứng, và S9 đã đo được công cụ tải báo thành công cho một binary không chạy nổi
  - [`browser-harness.ts`](../../../../tests/support/browser-harness.ts): thiếu Chrome ⇒ **skip có in lý do** trên máy dev, **fail** trong CI (`process.env.CI`). Hai luật khác nhau có chủ ý — không ai nên phải tải 200 MB để chạy unit suite, và không gì nên báo xanh cho test chưa từng chạy
  - _Requirements: R4.12, R1.10_ — _Design: §5.11, §16 C-5_
- [x] G.1 Service catalog + http-driver
  - Một catalog `src/lib/api/services.ts`, id `v1.<domain>.<action>`; **không** bật automatic version injection (URL đã chứa `api/v1`, tránh `/v1/v1`)
  - Test quét **toàn bộ** catalog chốt không URL nào chứa `/v1/v1/` — version injection chồng lên đây sinh 404 trông như route thiếu chứ không như prefix nhân đôi
  - `credentials: "include"` trên **mọi** lời gọi: session là cookie, request thiếu nó bị trả lời như ẩn danh — đọc thành lỗi phân quyền chứ không phải thiếu header
  - **`serviceRequest` trả `{ url, init }` chứ không trả `Request`**: base cùng origin là chuỗi rỗng, và `new Request("/api/...")` **ném trong Node** dù chạy được trong trình duyệt. Dựng object ở đây làm mọi call site không test được ngoài trình duyệt — và cách "sửa" tự nhiên nhất lại là thêm một DOM environment không ai duyệt
  - _Requirements: R4.10_ — _Design: §5.11_
- [x] G.2 Base URL là **runtime config**
  - `resolveApiBaseUrl()` đọc `window.__VIDCOM_API_BASE_URL__`, mặc định `location.origin`. Script chèn global chỉ render khi `NODE_ENV !== "production"` → production dead-code-eliminate. MUST NOT dùng `NEXT_PUBLIC_*`
  - **Chữ ký phải test được dưới `environment: "node"`**: [`vitest.config.ts`](../../../../vitest.config.ts) đặt node toàn cục và repo **không có `jsdom`/`happy-dom`**, nên hàm SHALL nhận nguồn qua tham số có mặc định — `resolveApiBaseUrl(source: { __VIDCOM_API_BASE_URL__?: string; location: { origin: string } } = globalThis as never)`. Đọc `window` trực tiếp trong thân hàm ⇒ `tests/frontend/api-driver.test.ts` không viết được, và cách "sửa" tự nhiên nhất là thêm `jsdom` — một dependency không ai duyệt
  - Chỉ **hai** test cần browser thật (G.0): cookie `SameSite` và SSE. Phần còn lại của driver là logic thuần, chạy dưới node
  - [`base-url.ts`](../../../../src/lib/api/base-url.ts) đúng chữ ký checklist yêu cầu — nguồn là tham số có mặc định. Test `is callable without any browser globals at all` chốt chính điều đó
  - Không có `NEXT_PUBLIC_*`: giá trị đó bị inline lúc build và sai với mọi lần chạy trừ đúng lần nó được build. Daemon chọn cổng loopback trống lúc chạy nên origin không thể biết trước
  - Chuỗi rỗng khi không có nguồn nào ⇒ request tương đối cùng origin: đúng trong trình duyệt, và trung thực ở nơi không có origin
  - _Requirements: R4.10_ — _Design: §5.11_
- [x] G.3 Dev host fail lúc boot khi hostname lệch
  - Đo ở S9: `localhost:3000` → `127.0.0.1:<port>` thì `exchange` trả **200** mà cookie **không bao giờ quay lại** — hỏng im lặng. Cùng hostname giữ được `SameSite=Strict` qua port khác
  - [`dev-host-check.ts`](../../../../src/lib/api/dev-host-check.ts). **Fail lúc boot, không phải lúc request đầu** — đây là toàn bộ điểm của task: hỏng ở request đọc thành lỗi xác thực và đẩy người gặp nó đi lục code session, còn hỏng lúc boot nêu đúng nguyên nhân một lần, trước khi thứ gì kịp trông như hỏng
  - Thông điệp lỗi **phải nêu phần im lặng** (`exchange` trả 200) — test chốt chuỗi đó, vì thiếu nó thì thông điệp vẫn dẫn người đọc đi sai hướng
  - Port khác nhau **không** phải lệch: port không thuộc về site, nên `SameSite=Strict` sống sót
  - _Requirements: R4.12_ — _Design: §5.11_
- [x] G.4 SSE gửi credential + abort khi dispose
  - `execServiceByStream` nhận cùng request options gồm `credentials: "include"` và `AbortSignal`
  - `serviceStream` dùng `fetch` chứ **không** `EventSource`: `EventSource` không gửi được credential cross-origin và không abort được. Cả hai đều cần — session là cookie, và một stream sống lâu hơn component giữ nó sẽ giữ luôn kết nối cùng subscription phía server sau khi người dùng đã rời đi
  - `Last-Event-ID` chỉ gửi khi có, để stream mới không xin resume từ một vị trí không tồn tại
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
  - **Route upload asset hôm nay là đúng một chỗ**, đã rà sẵn: `uploadBgm` trong [`packages/server/src/routes/project-writes.ts`](../../../../packages/server/src/routes/project-writes.ts#L134). Mọi route khác giữ 1 MiB. Nếu lúc làm thấy chỗ thứ hai nhận binary body thì **dừng và ghi vào Execution Log** — nghĩa là bề mặt upload đã đổi so với lần rà này, không phải cứ thế nới thêm một ngoại lệ
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

> Con số này **phân hoạch lại** ước lượng theo R ở [main spec](./spec-packaging-and-distribution-inprocess.md) (R1 26 · R2 37 · R3 13 · R4 21 · R5 21 · R6 25 · R7 8 · R8 21 · R9 5), không phải một ước lượng thứ hai. Tổng giữ nguyên.

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
| N-C | [S9 §W-1](../../../../spikes/phase-4/s9-windows-runtime/README.md) tự mâu thuẫn về tập package Windows sau prune: bảng ghi **57**, §W-1 ghi file evidence **58 dòng** — vì `win-package-set-pruned.txt` chụp **trước** bước gỡ `pip` | **Đóng trong checklist** — B.3 chốt kỳ vọng là 57 (55 core + `colorama` + `tzdata`, không `pip`) và nói rõ đừng dùng thẳng file evidence. Sửa lại README của S9 thì tốt nhưng **không chặn code** |
| N-B | Design bản 2 §5.0/§8.1 có 5 câu nói khác code; đã đính chính ở [§16](./spec-packaging-and-distribution-detailed-design.md) chứ không sửa tại chỗ để giữ dấu vết bản đã duyệt | **Đóng** — đọc §16 trước Phase A và Phase I |

---

## Execution Log

> [!NOTE]
> Mỗi phiên làm việc một entry: ngày, phase/task, file đã sửa, quyết định đáng ghi, blocker.

2026-08-07 — Phase A, Task A.1
  - Files: `packages/contracts/src/errors.ts`, `packages/mcp/src/error-map.ts`, `packages/server/src/middleware/error-mapper.ts`, `tests/contracts/packaging-contracts.test.ts`
  - Summary: Thêm đúng 14 error code packaging, giữ `WorkspaceLeaseLost` hiện hữu, phân biệt hai cặp mã dễ nhập nhằng và cập nhật đầy đủ các mapper exhaustive.
  - Decisions: `payload_too_large` map HTTP 413; các lỗi runtime/bridge khả dụng map 5xx hoặc 401/409 theo ý nghĩa contract. Không đổi Design.
  - Blockers: Không có; focused test 1/1 và typecheck xanh.

2026-08-07 — Phase A, Task A.4
  - Files: `packages/contracts/src/mcp.ts`, `packages/mcp/src/registry/registry.ts`, `tests/contracts/tool-schema-catalogue.test.ts`
  - Summary: Xuất catalogue schema/level đủ 18 tool public và buộc registry kiểm identity hai schema cùng level khi đăng ký.
  - Decisions: Tool giả trong unit test vẫn được phép không có trong catalogue; gate hai chiều A.8 bảo đảm bề mặt public không thiếu hoặc thừa. Không đổi wire schema hay snapshot.
  - Blockers: Không có; catalogue test 2/2 và typecheck xanh.

2026-08-07 — Phase A, Task A.2
  - Files: `packages/contracts/src/dto.ts`, `tests/contracts/packaging-contracts.test.ts`
  - Summary: Thêm contract strict cho filesystem roots/entries/page/create-directory, workspace lifecycle sáu state và runtime archive state.
  - Decisions: Entry chỉ mang metadata điều hướng (`name`, display path, token, `isDir`, `canWrite`), không có content hay size; page dùng cursor nullable và cờ `truncated` tường minh.
  - Blockers: Không có; focused contract 2/2 và typecheck xanh.

2026-08-07 — Phase A, Task A.3
  - Files: `packages/contracts/src/dto.ts`, `tests/contracts/packaging-contracts.test.ts`
  - Summary: Thêm handshake request/response, create/renew attachment và bridge tool invocation/result envelope dạng strict.
  - Decisions: Attachment id khóa ở 256 bit dạng 64 ký tự hex; response tool giữ `Result` domain trước era stamping và không chứa transport metadata.
  - Blockers: Không có; focused contract 3/3 và typecheck xanh.

2026-08-07 — Phase A, Task A.5
  - Files: `packages/contracts/src/settings.ts`, `packages/adapter/src/fs/settings-file.ts`, `tests/adapter/settings-file.test.ts`
  - Summary: Thêm `runtime.caBundlePath` vào schema strict/resolved defaults và áp `VIDCOM_CA_BUNDLE` với ưu tiên cao hơn file, kể cả khi file vắng.
  - Decisions: Contracts nhận override qua tham số thuần; adapter là lớp duy nhất đọc `process.env`, giữ package contracts không phụ thuộc Node runtime.
  - Blockers: Không có; settings test 23/23 trên filesystem temp thật và typecheck xanh.

2026-08-07 — Phase A, Task A.6
  - Files: `packages/contracts/src/domain.ts`, `packages/contracts/src/dto.ts`, `packages/adapter/src/db/schema.ts`, `packages/adapter/src/db/event-outbox.ts`, `packages/adapter/drizzle/20260807144527_amazing_kitty_pryde/**`, `tests/contracts/packaging-contracts.test.ts`, `tests/server/events.test.ts`, `tests/adapter/database-migration.test.ts`
  - Summary: Mở contract và outbox bền vững cho bốn event host mới; migration rebuild bảo toàn row cũ và cập nhật check constraint.
  - Decisions: Event type có hai catalogue project/host dùng chung; host event bắt buộc `project_id=NULL`, project event bắt buộc có project id.
  - Blockers: Không có; 10/10 focused tests xanh trên SQLite + filesystem temp thật, typecheck xanh.

2026-08-07 — Phase A, Task A.7
  - Files: `tests/contracts/packaging-contracts.test.ts`
  - Summary: Audit strictness cho toàn bộ DTO mới, đủ sáu workspace state, đủ ba bridge client kind và round-trip 14 error code qua `ErrorDetailSchema`.
  - Decisions: Kiểm từng nested schema trực tiếp thay vì chỉ kiểm response ngoài, để unknown key ở entry/archive cũng bị khóa.
  - Blockers: Không có; focused contract 5/5 và typecheck xanh.

2026-08-07 — Phase A, Task A.8 (blocked; A.4 reopened)
  - Files: Không sửa snapshot; evidence từ `test:mcp-contract`, `test:golden`, `test:mcp-catalogue` và SHA-256 fixtures.
  - Summary: Catalogue 2/2 xanh nhưng regression MCP 63/71 và golden 24/26; snapshot files vẫn đúng hash baseline, generated output thêm 14 enum value qua `JobSchema.error`.
  - Decisions: Dừng theo gate; MUST NOT cập nhật fixture. Mở lại A.4 vì registry guard làm hỏng schema-probe definitions trùng tên trong unit test.
  - Blockers: Wire-schema drift cần quyết định/fix không đổi snapshot; npm cache `~/.npm` không ghi được làm hai E2E smoke fail độc lập.

2026-08-07 — Phase A, Task A.4 (resumed; complete)
  - Files: `packages/contracts/src/mcp.ts`, `packages/mcp/src/registry/registry.ts`, `packages/mcp/src/registry/all-tools.ts`, `tests/contracts/tool-schema-catalogue.test.ts`
  - Summary: Giữ catalogue đủ 18 tool và chuyển invariant identity/tập tên sang điểm kết thúc `registerVidcomTools`, sau khi bề mặt public đã đăng ký trọn vẹn.
  - Decisions: `ToolRegistry.register` vẫn là primitive dùng được cho definition probe; chỉ full public registration mới bị seal hai chiều với catalogue. Không nới catalogue và không nới test registry.
  - Blockers: Không có; catalogue 2/2, MCP contract 71/71 và typecheck xanh.

2026-08-07 — Phase A, Task A.8 (complete after user decision)
  - Files: `packages/contracts/src/mcp.ts`, `packages/mcp/src/error-map.ts`, `packages/mcp/src/registry/registry.ts`, `packages/mcp/src/registry/all-tools.ts`, `tests/contracts/packaging-contracts.test.ts`, `tests/mcp/error-map.test.ts`, `tests/e2e/mcp-stdio-host.test.ts`, Design §16
  - Summary: Đóng wire drift mà không sửa fixture: `get_job_status` chỉ nhận error vocabulary đã phát hành; 14 mã packaging không thể xuất hiện trong structured output hay canonical MCP tool-error.
  - Decisions: Thực thi lựa chọn 1 của người dùng và ghi thành C-6. `npm pack` dùng cache filesystem thật trong temp root để test độc lập với home; không mock `node:fs` và không nới gate.
  - Blockers: Đã đóng; golden 26/26, MCP contract 71/71, catalogue 2/2. Fixture hashes giữ `283b32…c35bd` (legacy) và `011b16…b44c` (modern), `git diff --exit-code` xanh.

2026-08-07 — Phase A, phase verification (local complete; CI pending)
  - Files: `spikes/phase-4/s2-export/app/projects/[slug]/studio-client.tsx`, `spikes/phase-4/s7-bridge-transport/probe.mjs`, checklist và implementation notes
  - Summary: Focused contracts 10/10, catalogue 2/2, typecheck, boundaries, MCP contract 71/71, golden 26/26 và lint exact đều xanh; `contracts` vẫn chỉ phụ thuộc `zod@4.4.3`.
  - Decisions: Sửa hai lỗi lint tracked thay vì nới rule. Các build artifact/virtualenv Git-ignored được di chuyển tạm ra `/private/tmp` khi chạy `rtk bun run lint`, rồi khôi phục đủ đúng path; không đổi ESLint, script lint hay ignore list.
  - Blockers: Local gate đã đóng. Chưa được sang Phase B cho tới khi commit/push Phase A và GitHub Actions của đúng HEAD xanh.

2026-08-07 — Phase A, Task A.6 (migration preservation hardening)
  - Files: `tests/adapter/database-migration.test.ts`, implementation notes
  - Summary: Thêm đường upgrade từ toàn bộ migration trước A.6 trên SQLite file thật, seed hai row host/project cũ, rồi chứng minh rebuild giữ nguyên payload/project/seq và row mới tiếp tục ở seq 3.
  - Decisions: Kiểm cả `pragma_foreign_key_check` sau upgrade; không chỉ dựa vào fresh-schema test hay đọc SQL migration.
  - Blockers: Không có; migration + event integration 7/7 xanh trên temp filesystem thật.

2026-08-07 — Phase A, council review (F.5b sequencing clarification)
  - Files: `spec-packaging-and-distribution-implementation-checklist.md`, implementation notes
  - Summary: Sửa cross-reference mâu thuẫn ở F.5b: schema token-only được đổi cùng F.5/F.5b, không phải A.2.
  - Decisions: Giữ dependency order đã duyệt: F.3 phải mint được `selectionToken` trước khi route, dependency signature, schema và ba caller test cùng đổi nguyên tử. A.2 vẫn đúng phạm vi §7.1–§7.4; không kéo production code Phase F về Phase A chỉ để tạo trạng thái giữa chừng không typecheck.
  - Blockers: Không có; Design §7.5/C-26 và nhiệm vụ F.5/F.5b không đổi phạm vi hay acceptance criteria.

2026-08-07 — Phase A, Task A.2 (page-bound review hardening)
  - Files: `packages/contracts/src/dto.ts`, `tests/contracts/packaging-contracts.test.ts`, implementation notes
  - Summary: Cưỡng chế giới hạn contract tối đa 500 entry mỗi page thay vì chỉ mô tả “bounded”.
  - Decisions: Đặt `.max(500)` ngay trên `BrowsePageSchema.entries`, là response boundary dùng chung; test khóa cả biên 500 hợp lệ và 501 bị từ chối.
  - Blockers: Không có; focused packaging contracts 7/7 xanh.

2026-08-07 — Phase A, Task A.5 (ambient-environment review hardening)
  - Files: `tests/adapter/settings-file.test.ts`, implementation notes
  - Summary: Cô lập `VIDCOM_CA_BUNDLE` ở mỗi test và chứng minh file-only fallback trên filesystem temp thật khi env không có.
  - Decisions: Giữ nguyên production resolver `env > file > default`; harness lưu/khôi phục giá trị ambient để CI có CA bundle không làm thay đổi kỳ vọng default. Không mock `node:fs`.
  - Blockers: Không có; settings 24/24 xanh cả khi process cha không có env và khi chạy với `VIDCOM_CA_BUNDLE=/ambient/ci-ca.pem`; ESLint scoped xanh.

2026-08-07 — Phase A, Task A.6 (event-catalogue review hardening)
  - Files: `packages/adapter/src/db/event-outbox.ts`, implementation notes
  - Summary: Loại danh sách năm host event bị lặp trong type guard; mapper giờ lấy trực tiếp `HOST_DOMAIN_EVENT_TYPES` từ contracts.
  - Decisions: Dùng Set nội bộ cho runtime narrowing. SQL CHECK và migration tiếp tục giữ literal snapshot xác định vì đó là schema lịch sử phải review được, không sinh động lúc runtime.
  - Blockers: Không có; focused event/migration 7/7 và typecheck xanh sau thay đổi.

2026-08-07 — Phase A, Task A.5 (pure-logic persistence coverage)
  - Files: `tests/contracts/packaging-contracts.test.ts`, implementation notes
  - Summary: Bổ sung logic test trực tiếp cho `resolveVidcomSettings`, tách khỏi adapter I/O để khóa precedence và normalization của CA bundle.
  - Decisions: Chứng minh file-only; env override được trim và thắng file; blank/null override là absent, còn file `null` được giữ là cấu hình tường minh.
  - Blockers: Không có; packaging contracts 10/10 và typecheck xanh. Cùng settings integration 24/24 trên filesystem temp thật, A.5 có đủ logic + integration theo rule persistence.

2026-08-07 — Phase A, council-review local closeout
  - Files: toàn bộ diff Phase A, checklist, implementation notes
  - Summary: Chạy lại sau mọi review fix: focused contracts/settings/migration/events 41/41, catalogue 2/2, MCP 71/71, golden 26/26, typecheck và import boundaries đều xanh.
  - Decisions: Exact `rtk bun run lint` chạy trong clean-checkout-equivalent sau khi tạm isolate đúng 13 artifact/virtualenv Git-ignored rồi khôi phục toàn bộ; 0 error/2 warning, không đổi ESLint/ignore. Snapshot không đổi byte.
  - Blockers: Local không còn blocker; fixture SHA giữ legacy `283b32…c35bd`, modern `011b16…b44c`, `git diff --check` xanh. Phase A vẫn chờ commit/push và CI đúng HEAD.

2026-08-07 — Phase A, CI remediation (run 31193565392)
  - Files: `tests/adapter/mcp-database-migration.test.ts`, `tests/contracts/api-contracts.test.ts`, checklist, implementation notes
  - Summary: Full matrix của exact SHA `00cf080` phát hiện hai baseline test cũ: migration count vẫn đòi 11 thay vì 12, và shared `ErrorCode` vocabulary chưa liệt 14 mã Phase A.
  - Decisions: Cập nhật đúng hai contract expectation; đây không phải `tools/list` snapshot. Không sửa production code, workflow, ESLint hay import boundary. GH_KEY read-only dùng list/watch; keyring OAuth chỉ dùng dispatch vì fine-grained PAT trả 403 cho `actions:write`.
  - Blockers: Local remediation xanh đầy đủ: targeted 11/11, full `bun run test` 852 pass / 3 skip, packaging 10/10, catalogue 2/2, MCP 71/71, golden 26/26, typecheck, boundaries và lint exact 0 error/2 warning. Phase A vẫn bị chặn cho tới khi fix được commit/push và một run exact HEAD mới xanh đủ Windows/macOS/Linux.

2026-08-07 — Phase A, CI remediation verification (run 31194897230)
  - Files: checklist và implementation notes
  - Summary: Workflow `CI` dạng `workflow_dispatch` bắt đúng remediation SHA `3548562a7a717887f5cbc0c8f3a6ddcad472b6bc`; cả Linux x64, macOS arm64 và Windows x64 đều kết thúc `success`.
  - Decisions: Xác thực bằng `GH_TOKEN=$GH_KEY gh run watch --exit-status` rồi đối chiếu metadata `headSha`, `status`, `conclusion` và từng job qua `gh run view`. Giữ Phase B đóng trong lúc commit/push chính entry closeout này để CI còn phải xanh trên exact docs HEAD.
  - Blockers: Implementation HEAD không còn blocker. Closeout docs chưa được xem là gate cuối cho tới khi commit/push và run exact HEAD tiếp theo xanh đủ ba OS.

2026-08-07 — Phase A, closeout-doc CI failure (run 31196365800)
  - Files: `tests/mcp/revision-pin.test.ts`, checklist và implementation notes
  - Summary: Exact SHA `23101b32704eaf7949fc2f011b2469a156d10de1` xanh Linux/macOS nhưng Windows fail 1/855: case stdio revision pin chạm timeout 30s; 850 test khác pass và contract expectation không lệch.
  - Decisions: Không retry mù, không tăng timeout, skip/disable job hay nới gate. Đã lấy failed log, so với run trước cùng code (Windows pass 3.049s) và chạy focused local 5 lần (197–293ms) để xác nhận race/lifecycle platform-specific trước khi sửa.
  - Blockers: Phase A tiếp tục bị chặn. Đang review lifecycle child process/version-negotiation và cleanup để tạo hardening cấu trúc, sau đó phải chạy lại local gates, commit/push và CI exact HEAD đủ ba OS.

2026-08-07 — Phase A, Windows stdio lifecycle hardening
  - Files: `tests/mcp/revision-pin.test.ts`, checklist và implementation notes
  - Summary: Thay ba child process gián tiếp bằng một raw real-stdio child: cùng pinned server reject legacy `initialize` với `-32022`, rồi accept modern `server/discover` và `tools/call`; process close thật được await trong `finally`.
  - Decisions: Giữ nguyên một test và timeout 30s; không retry/skip. Drain stderr chủ động, dùng Node hiện hành + loader `tsx@4.23.1` đã là direct dependency của `packages/cli`, không thêm dependency/lockfile. High-level SDK v1/v2 real-stdio vẫn được khóa ở contract matrix và transport suites.
  - Blockers: Focused file 7/7, typecheck, scoped ESLint và `git diff --check` xanh; real-child case chạy lặp 10/10 trong 197–311ms. Chưa đóng Phase A cho tới khi full local matrix và exact-HEAD CI ba OS xanh.

2026-08-07 — Phase A, stdio hardening full local verification
  - Files: `tests/mcp/revision-pin.test.ts`, checklist và implementation notes
  - Summary: Sau hardening, full `rtk bun run test` xanh 852 pass / 3 skip trong 56,36s; Phase A matrix xanh packaging 10/10, catalogue 2/2, MCP 71/71, golden 26/26, cùng typecheck và import boundaries.
  - Decisions: Chạy exact `rtk bun run lint` trong clean-checkout-equivalent bằng cách tạm isolate đúng 13 artifact/virtualenv Git-ignored rồi khôi phục đủ; kết quả 0 error/2 warning. Không đổi ESLint, boundary gate, dependency/lockfile, timeout hay retry.
  - Blockers: Local không còn blocker. `tools/list` giữ nguyên byte với SHA legacy `283b32a91410b83bd4c6134ee68cbe9ee34995f9ac9364ae9afa0db4120c35bd`, modern `011b16d1b465bff21d2fcc82e1d9771a581d96b9660bc0052b8d2171d456b44c`; Phase A vẫn chờ commit/push và CI exact HEAD xanh đủ ba OS.

2026-08-08 — Phase A, stdio hardening CI verification (run 31199182402)
  - Files: checklist và implementation notes
  - Summary: Workflow `CI` bắt đúng SHA `d754b2bdc1f83d50b6864dc39a1e8717f86209db`; macOS arm64, Linux x64 và Windows x64 đều kết thúc `success`, gồm full Test, focused MCP/golden/schema/matrix, production build và real Next/SSE smoke.
  - Decisions: Xác thực bằng `GH_TOKEN=$GH_KEY gh run watch 31199182402 --exit-status` (exit 0), rồi đối chiếu `headSha`, conclusion và từng job qua `gh run view`. Thời lượng: macOS 4m06s, Linux 6m13s, Windows 16m08s; Windows full Test riêng xanh sau 9m58s.
  - Blockers: Không có; Phase A hoàn tất. Phase B được phép bắt đầu theo dependency order sau khi activate skill và đọc trọn nguồn bắt buộc của phase.

2026-08-08 — Phase B, Task B.1
  - Files: `packages/adapter/package.json`, `bun.lock`, checklist và implementation notes
  - Summary: Nâng `tar@7.5.22` từ dependency bắc cầu đã có trong lockfile thành dependency trực tiếp, pin exact tại `@vidcom/adapter` — package sở hữu `adapter/runtime` và sẽ import extractor.
  - Decisions: Dùng lại đúng lock entry `tar@7.5.22`, không tạo version thứ hai. Không thêm lại `@hono/node-server`, không nới `hono`; bốn câu hỏi dependency giữ nguyên câu trả lời ở Design §5.0 và sẽ được chép vào commit message Phase B.
  - Blockers: Không có; `bun install --frozen-lockfile` báo 885 installs/1048 packages, no changes; `hono@4.12.33` và `@hono/node-server@2.0.12` giữ nguyên, `git diff --check` xanh.

2026-08-08 — Phase B, Task B.2
  - Files: `packages/adapter/src/runtime/runtime-asset-source.ts`, `packages/adapter/src/index.ts`, checklist và implementation notes
  - Summary: Thêm manifest runtime strict/immutable, SEA source đọc qua `node:sea.getRawAsset`, filesystem source cho dev/test, và resolver chọn toàn bộ archive theo `<os>-<arch>`.
  - Decisions: Manifest pin Node, HyperFrames, esbuild, FFmpeg, CPython, VieNeu, đúng 5 motion package và package Python của đủ ba platform. Archive key/target/entry/hash/mode/artifact version đều canonical để không biến dữ liệu build thành path traversal; missing platform trả mã `runtime_manifest_invalid` kèm requested/supported rõ ràng.
  - Blockers: Không có; `rtk bun run typecheck`, ESLint scoped và `git diff --check` xanh. Logic matrix chi tiết được khóa ở B.7 theo đúng thứ tự checklist.

2026-08-08 — Phase B, Task B.3
  - Files: `scripts/build-runtime-archives.mjs`, `package.json`, checklist và implementation notes
  - Summary: Thêm builder `.tar.gz` deterministic theo config `<os>-<arch>`, sinh manifest hash/bytes/entry/mode và gate package Python từ evidence có sẵn thay vì chép lại danh sách.
  - Decisions: Normalize đúng `lowercase + underscore→hyphen`, nhưng so version nguyên xi theo evidence từng platform. Core darwin/Linux bắt buộc trùng 55; Windows bắt buộc core + `colorama` + `tzdata` = 57; `pip` luôn fail. Source symlink/hardlink/special-file bị chặn từ build, tar dùng sorted files + epoch mtime + portable gzip.
  - Blockers: Không có; deterministic smoke build hai lần cho byte-identical SHA `62c4d7bc1d763adf00578c773a6790d1a4e5d0b9195b214831c68294aadc3872`, giữ 2 entry và mode 0755. Gate negative từ chối một package thừa và từ chối `pip`; ESLint, typecheck, diff check xanh.

2026-08-08 — Phase B, Task B.4
  - Files: `packages/adapter/src/runtime/runtime-asset-extractor.ts`, `packages/adapter/src/index.ts`, checklist và implementation notes
  - Summary: Thêm extractor preflight toàn bộ tar header trước khi tạo destination, chỉ nhận file/directory đúng allowlist, kiểm archive SHA/bytes, expansion budget, exact file set, hash cây sau extract và áp lại mode manifest.
  - Decisions: Dùng event completion của `tar@7.5.22` thay `node:stream.finished` vì Parser/Unpack là EventEmitter trên Bun; cùng decompression budget được áp ở cả list/extract. Windows đi qua đúng `secureAppDataDirectorySync`; lỗi archive hỏng map `runtime_manifest_invalid`, lỗi extract/cleanup map `runtime_extraction_incomplete`.
  - Blockers: Không có; Bun real-FS build→parse→extract giữ file 0755 và root 0700, symlink/malformed bị từ chối trước khi destination tồn tại. Node/tsx smoke safe/traversal/malformed cũng xanh; typecheck, ESLint scoped và `git diff --check` xanh. Negative matrix chính thức nằm ở B.7/B.8.

2026-08-08 — Phase B, B.2/B.3 review hardening
  - Files: `packages/adapter/src/runtime/runtime-asset-source.ts`, `scripts/build-runtime-archives.mjs`, checklist và implementation notes
  - Summary: Khóa ba namespace filesystem mà B.5 sẽ sở hữu: artifact version không được đè `current.json`, archive key không được đè installed `runtime-manifest.json`, entry gốc không được chiếm `.ready-*`.
  - Decisions: Chặn ngay ở cả build config/source walk và strict embedded-manifest parser, không đẩy collision xuống manager sau khi filesystem đã bị ghi. So tên control case-insensitive để giữ đúng trên Windows.
  - Blockers: Không có; ba negative smoke đều trả `runtime_manifest_invalid`; typecheck, ESLint scoped và `git diff --check` xanh.

Format:
```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [path/to/file.ts]
  - Summary: [đã làm gì]
  - Decisions: [lệch khỏi design ở đâu — nếu vật chất thì thêm dòng vào Design §16, không sửa tại chỗ phần đã duyệt]
  - Blockers: [nếu có]
```
