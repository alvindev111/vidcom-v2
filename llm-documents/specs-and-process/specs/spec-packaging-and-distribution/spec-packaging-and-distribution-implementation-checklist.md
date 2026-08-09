# Spec Packaging & Distribution Runtime — Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) — bản 4, **Approved 2026-08-07** (R2.14 sửa sau khi duyệt, cùng ngày)
> - [Detailed Design](./spec-packaging-and-distribution-detailed-design.md) — bản 2, **Approved 2026-08-07**, gate §15 · **+ phụ lục sửa §16 (bản 2.2, cập nhật 2026-08-09)** — 14 chỗ bản 2 nói khác code, manifest authority hoặc runtime thật, đọc trước khi bắt đầu Phase A và Phase I
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
- **Trạng thái thực thi**: **Phase A, B, C hoàn tất; Phase D có 14/14 task nhưng artifact Acceptance Criterion đang mở lại, nên chỉ 2/3 Acceptance Criteria còn giữ proof hiện hành và Phase D chưa được gọi hoàn tất**. Sáu vòng audit đã thêm final-SEA raw-asset proof, active-resource extent, generation capability/publisher recovery, executable exit/preload normalization, passive Node 24.9 prep-blob parser không chạy candidate và parent-memory seal bind cả executable/blob lẫn original input projection. Review mới nhất bắt lexical `.sea-inputs` cùng manifest có thể bị thay tự nhất quán sau snapshot; closure nay đã land: `seal.inputs` giữ `codePath`, main và assets byte/SHA từ in-memory copy records, `build-sea` giữ original root capability, còn verifier hash blob spans trực tiếp theo parent-held projection trước khi xác minh snapshot hiện tại và capture capability mới cho các scan path-based. Regression root replacement, same-root child/manifest replacement và coherent artifact/blob replacement đều fail-closed, không chạy bad main. Checkpoint sau patch xanh combined SEA/build-artifact/provenance/publisher **84/84**, SEA riêng **22/22**, typecheck, lint 0 error/3 warning không liên quan, boundaries và full diff-check; không còn generated `.compiler-bundle` directory. Đây mới là focused closure, chưa phải artifact proof: binary cũ SHA-256 `5b111f…e2bc0` không còn là exact HEAD; artifact AC tiếp tục `[ ]`, toàn bộ Phase D local matrix và production rebuild/render-smoke trên binary mới vẫn phải chạy lại trước commit/push và GitHub Actions exact HEAD ba OS. Evidence cũ vẫn được bảo toàn ở `/private/tmp/vidcom-phase-d-production-smoke.6mvwdf/EVIDENCE.md` nhưng không được dùng thay proof mới. Phase C đã qua CI ba OS ở [`31295074545`](https://github.com/alvindev111/vidcom-v2/actions/runs/31295074545) trên exact commit `23b6dcf`: Linux 4m23s, macOS 4m58s, Windows 8m40s. Các phần E–L đã có code từ lượt thực thi trước nhưng **không được coi là phase kế tiếp trong lượt này**; thứ tự tiếp tục vẫn là D → E → F → G → H → I → J → K → L → M. Main spec đang là [`-inprocess.md`](./spec-packaging-and-distribution-inprocess.md).

**Bản này (2026-08-07, sau review) đã đóng năm câu hỏi mà trước đó dev buộc phải hỏi lại giữa lúc code.** Duyệt mục này nghĩa là duyệt cả năm quyết định sau:

| Câu hỏi trước đây | Quyết định trong bản này | Vì sao chọn thế |
|---|---|---|
| `DaemonClient` đặt đâu để `mcp` gọi được mà không đỏ `test:boundaries`? | **`mcp` không gọi nó.** Hiện thực ở `adapter/daemon`, interface `ToolInvoker` ở `mcp`, hiện thực remote ở `cli` (I.2, I.2b) | Đây là **giao** của bảng steering và gate đang chạy, nên hợp lệ với cả hai và không cần nới gate |
| Harness browser của G.9 dùng gì? | **`puppeteer-core@25.4.0` đã có trong repo** + `chrome-headless-shell` từ cache HyperFrames, port từ `cookie-probe.mjs` của S9 (G.0) | Không mở dependency mới; `SameSite` chỉ browser thật cưỡng chế được nên không có đường thay thế |
| Ba `bun run …` trong Verification Matrix không tồn tại thì ai tạo? | **G.0 / H.0 / M.0**, và cột "Ai tạo" trong Verification Matrix chỉ rõ | Gate chạy bằng lệnh không tồn tại là gate giả |
| A.4 chuyển schema tool — chuyển cái gì khi chúng đã ở `contracts`? | **Rescope**: không di chuyển gì; thêm catalogue `tên tool → schema` + gate hồi quy `test:mcp-catalogue`/`test:golden` (A.4, A.8) | Việc thật là làm route bridge map được `:name`, không phải di chuyển file |
| Hai breaking change C.4 và F.5 ảnh hưởng ai? | Danh sách caller cụ thể nằm ngay trong task (C.4b, F.5b), kèm 3 điểm test đang dùng nhánh `{path}` | Đã rà trên code, không để dev tự tìm |

## Flake Windows đã quan sát được — chưa sửa, cần đo trước

Hai test **có sẵn từ trước Giai đoạn 4** đỏ ngẫu nhiên trên Windows CI rồi xanh khi chạy lại **cùng commit**. Cả hai cùng họ: crash-recovery phụ thuộc thời điểm, chạm filesystem thật.

| Test | Triệu chứng | Quan sát ở |
|---|---|---|
| `tests/adapter/bridge-credential-lifecycle.test.ts` — waiter nhận `bridge_rotation_in_progress` | `ENOENT ... mkdir '…\.credential.lock.claim-…'` | `5b85578` |
| `tests/adapter/journal-recovery.test.ts` — abort khi bị kill giữa lúc ghi | `child did not reach mid-write`, rồi `EBUSY ... unlink vidcom.sqlite` | `df56f42` |
| `tests/adapter/render-job.test.ts` — render qua tiến trình thật | `render_binary_missing` sau 10,6 s | `6ee93ba` |
| `tests/adapter/remote-asset-browser.test.ts` — chặn ảnh remote trong browser thật | `mediaViolations` rỗng, không quan sát được request nào | `6ee93ba` |
| `tests/adapter/download-cache.test.ts` — hai fetch cùng component | `RuntimeAssetError: directory lock release failed` | `2267849` |

Hai dòng cuối **đã đo lại**: `dd515c7` (nhiều commit hơn, không đụng file nào của hai test đó) xanh cả ba OS. Cùng họ với hai dòng trên — phụ thuộc binary tải về và thời điểm, chạm filesystem/tiến trình thật. Vẫn **chưa sửa**, và vẫn không được sửa bằng retry.

`EBUSY` khi `unlink` một file SQLite vừa đóng là dấu hiệu Windows **giữ handle lâu hơn lời hứa `close()` trả về**. Nghi ngờ cả hai cùng một gốc: cleanup của `afterEach` (`rm -r`) chạy trong khi handle chưa thực sự được nhả.

**Đừng sửa bằng cách thêm retry hay nới timeout** — đó là cách biến một flake thành một flake chậm hơn. Cần đo trước: in mốc thời gian giữa lúc `close()` trả về, lúc `rm` bắt đầu, và lúc `EBUSY` xảy ra.

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
| D | `rtk bunx vitest run tests/adapter/node-sentinel.test.ts tests/adapter/compiler-guard.test.ts tests/adapter/render-binary-probe.test.ts tests/adapter/vieneu-frozen-interpreter.test.ts` | — |
| E | `rtk bunx vitest run tests/cli/foundation-lifecycle.test.ts tests/cli/foundation-state.test.ts tests/cli/loopback-host.test.ts tests/cli/lease-loss.test.ts` | — |
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
  - **Proof được siết lại sau adversarial review**: hook ném lỗi chỉ đi qua `catch`/rollback, không mô phỏng process chết. Test nay spawn child thật rồi `SIGKILL` ở `afterExtract`, `afterValidate`, `afterRename`, `beforeMarkerCommit` và `afterMarker`; restart trên cùng filesystem chốt bốn pha đầu re-extract sạch, còn marker đã commit được reuse đúng payload
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
- [x] C.3 Migration đúng một lần mỗi boot
  - `prepareRuntimeForCli()` nay chạy trước chọn workspace ở các boot path `app`/`serve`, `mcp` và `recovery`; DB đã migrate được truyền xuống `selectWorkspace`, còn `startVidcomFoundation` nhận `migrationPrepared: true` nên không chạy lại
  - Source checkout không có runtime archive để extract: coordinator vẫn sở hữu cùng khoá bootstrap, migration và credential reconciliation, nhưng bỏ riêng bước extraction. Artifact bắt buộc dùng SEA source; `VIDCOM_RUNTIME_ASSETS` chỉ là nguồn filesystem tường minh cho build/test và artifact không được fallback về `node_modules`
  - Workspace switch trong cùng tiến trình dùng lại `HostedRuntimeBoot`, nên không mở một bootstrap/migration thứ hai
  - Test counter chạy production boot `startServing` → hosted runtime → coordinator → workspace selection → foundation trên SQLite + filesystem thật và chốt `migrate` được gọi đúng `1`
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
- [x] Migration chạy **đúng một lần** trong một boot, đo bằng counter chứ không bằng đọc code — `tests/cli/boot-migration-count.test.ts` chạy production `startServing` trên SQLite + filesystem temp, truyền cùng migrator thật qua coordinator và foundation rồi chốt counter bằng `1`
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
  - **Mở lại sau TOCTOU review**: authority resolver trả verified root nhưng pathname đó có thể bị rename rồi thay bằng symlink trước `runNodeSentinel`; canonicalize lại cả root/script sau substitution làm containment giả vẫn pass. Sentinel phải bind đúng canonical authority đã verify và từ chối original root path bị thay thế
  - **Đã đóng race**: resolver trả canonical path cùng identity filesystem `dev`/`ino`/`birthtimeNs`; sentinel lstat/revalidate authority trước script resolution, sau resolution và ngay trước import. Regression rename root đã verify rồi đặt symlink/junction tới module ngoài: trả `runtime_manifest_invalid`, importer không chạy và `argv` nguyên vẹn
  - _Requirements: R6.2_ — _Design: §4.6, §5.16_
- [x] D.2 Sửa **cả hai** chỗ spawn
  - `NodeRenderBinaryProbe` trả `[execPath, "--vidcom-node", cliPath]`; và chỗ thứ hai `[execPath, cliPath, "browser", "path"]` ([`binary-probe.ts:66-70`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L66)) — **cả hai** đều làm artifact chạy lại `main` của chính nó, và **không sinh lỗi**
  - Cả hai chỗ đi qua `nodeArgv()`, và sentinel **chỉ** được thêm khi API chuẩn `process.getBuiltinModule("node:sea").isSea()` trả true — ngoài artifact thì `execPath` đúng là node, thêm sentinel sẽ hỏng dev
  - Reporter spawn và render/snapshot supervisor cùng nhận `VIDCOM_APP_DATA` đã resolve qua strict allowlist, nên SEA child tìm lại đúng authority chain của D.1 kể cả portable/custom install; ambient `GH_KEY` không đi qua
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
- [x] D.3b Truyền `RuntimePaths` từ **mọi** entrypoint
  - `app`, `serve`, `mcp`, `render`, `doctor` — mỗi cái một dòng, và đây là chỗ dễ làm sót đúng một cái rồi chỉ hỏng ở mode ít dùng nhất
  - `motionLibraryRoot` hôm nay **không entrypoint nào truyền** (bẫy 4.8): nó là lý do task này tách riêng khỏi D.3a. Resolver đúng mà không ai truyền thì `install_motion_library` vẫn hỏng y như cũ
  - Test: liệt kê entrypoint từ mode union của J.1 và chứng minh **không entrypoint nào** dựng `RuntimePaths` rỗng hay thiếu field
  - **Đã làm**: `CompositionRootConfig.runtimePaths` nhận cả bộ đã resolve và **thắng** các field lẻ. Lý do phải thắng: mỗi field lẻ tự có default hợp lý — đúng chỗ nguy hiểm, vì bản đóng gói quên một cái sẽ nhận đường dẫn trông hợp lệ trỏ vào hư vô thay vì một lỗi. `NodeRenderBinaryProbe` nay nhận thẳng `hyperframesCliPath`/`hyperframesPackagePath`, nên fallback `require.resolve` của nó không còn nằm trên đường artifact. Thêm `caBundlePath` vào config cho nửa Node của D.7
  - **Hoàn tất sau J.1**: [`runtime-paths-source.ts`](../../../../packages/cli/src/runtime-paths-source.ts) là **một** chỗ duy nhất sinh ra bộ path, và `next-host` (`app` + `serve`), `commands/mcp.ts`, `commands/recovery.ts` đều gọi nó. `render` và `doctor` **không** dựng composition root thứ hai — chúng nói chuyện với daemon — nên "năm entrypoint" là năm mode, không phải năm composition root
  - [`runtime-paths-entrypoints.test.ts`](../../../../tests/cli/runtime-paths-entrypoints.test.ts) lấy danh sách mode từ chính `VIDCOM_COMMAND_NAMES` của J.1 thay vì chép lại, nên một mode mới không lặng lẽ trượt khỏi file này; và chốt bộ path là **đủ field hoặc không có gì**, vì mỗi field lẻ có default hợp lý riêng — đúng chỗ nguy hiểm
  - Artifact repro bắt thêm diagnostics adapter còn `require.resolve("hyperframes/bin/hyperframes.mjs")`. Composition root nay truyền verified `hyperframesCliPath`; SEA diagnostics child thêm cùng sentinel D.1/D.2. Integration chạy CLI `.mjs` thật từ runtime temp với SQLite/filesystem thật, nên checkout fallback không thể che đường hỏng
  - **Mở lại sau entrypoint audit**: `backup restore` cũng dựng composition root nhưng test inventory đã loại nhầm toàn bộ mode `backup`. Đường restore còn gọi migration trực tiếp, không đi qua bootstrap lock/extraction/credential reconciliation, rồi nhận runtime unversioned và có thể fallback `require.resolve`/Python PATH trong SEA. Root split rộng hơn hai mode: compiler preload đọc `setting.json.appDataRoot=A`, nhưng serve discovery, render-connect, approve/credential, backup và recovery còn gọi resolver không có settings nên dùng default B. Preload phải pin authority A vào `VIDCOM_APP_DATA` khi env chưa explicit; explicit env C vẫn thắng settings. Chỉ `backup list`/`verify` là read-only và không cần bootstrap
  - **Publication phải fail trước side effect**: product-required host archive set thiếu HyperFrames không được để generic manager publish `current.json` rồi mới bị `runtimePathsFor` từ chối. Bootstrap phải prevalidate đầy đủ trước extraction/publication/database migration; regression giữ prior good runtime current và chốt invalid candidate có migration count 0
  - **Đã đóng lại sau audit entrypoint + artifact publication**: compiler preload pin settings-resolved app-data vào `VIDCOM_APP_DATA` khi env chưa explicit; backup restore/recovery dùng cùng bootstrap/runtime authority, migrate đúng một lần; canonical product validator chạy trước lock/extract/current/DB ở SEA primary và coordinator. MCP fixture dùng exact product set trên SQLite/filesystem thật. SEA/publisher generation có authenticated payload + unique live-owner lock, nên candidate thiếu/drift không poison prior current hoặc artifact published
  - _Requirements: R5.8, R6.3_ — _Design: §5.16, §4.8_
- [x] D.4 `CompilerGuard`
  - Đặt **cả hai** `ESBUILD_BINARY_PATH` và `ESBUILD_WORKER_THREADS=0`; timeout bắt buộc cho mọi lời gọi in-process chạm compiler. Thiếu **bất kỳ** cái nào ⇒ **treo vĩnh viễn, không một dòng stderr**
  - Preflight chạy **trước** operation: thiếu biến thì trả `compiler_unavailable` ngay, không bắt caller chờ hết budget rồi mới biết. Test chốt cả hai điều: đúng mã lỗi, và trả về trong dưới 1s dù budget là 30s
  - Timeout **không được tuỳ chọn**: `run()` ném `TypeError` khi timeout ≤ 0. Timeout tuỳ chọn là một cú treo đang chờ được tái sinh
  - Test dùng operation `new Promise(() => {})` — **đúng hình dạng lỗi thật**: không error, không stderr, không trả về
  - Entry source và SEA chạy preload compiler-free trước khi dynamic-import adapter barrel/runtime; source launcher đặt binary đúng của `tsx@4.23.1` trước loader, rồi TS boot đặt binary đúng của HyperFrames/esbuild trước runtime graph
  - Compiler đồng bộ không chạy dưới timer cùng event loop: doctor re-enter child ẩn, gọi `bundleToSingleHtml` thật trên temp filesystem và được `NodeProcessSupervisor` kill/verify khi hết deadline
  - AST audit pin mọi import HyperFrames/esbuild, direct/aliased `require`/`createRequire`, compiler-capable call, đúng tám static adapter site và graph `0.7.86`; emitted-CJS test đưa hostile env để chứng minh Bun không eager-init main
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
  - **Production wiring đã được chốt lại sau audit**: `HF_HUB_OFFLINE=1` hoặc `TRANSFORMERS_OFFLINE=1` ở daemon bật chế độ warm-offline và provider luôn truyền **cả hai** cờ; mặc định không bật để cold first-run vẫn tải weights được. `tests/cli/vieneu-runtime-wiring.test.ts` chạy composition root + child thật trên SQLite/filesystem temp
  - `DownloadCacheCoordinator` nay quyết policy tự động: cache `models` missing/partial chạy `worker.py --probe` online để gọi `snapshot_download` với revision đã pin; chỉ sau probe thành công marker mới bị xoá. Cache ready ở cùng process hoặc sau restart luôn ép cả `HF_HUB_OFFLINE=1` và `TRANSFORMERS_OFFLINE=1`
  - Artifact mode fail-closed nếu interpreter/worker đóng băng thiếu hoặc hỏng, không rơi về Python trên PATH; lỗi local command không bị gán nhầm thành download failure và không phá marker ready. Integration composition root dùng SQLite/filesystem temp + child thật để chốt cold download, warm restart và environment thực nhận
  - **Mở lại sau adversarial review**: `timedOut=true` đang bị rơi thành `sidecar_missing` không có failure code; cache ready nhưng stale phải repair online ngay trong **cùng** lần gọi khi không explicit offline, không bắt người dùng gọi lần hai
  - **Đã đóng lại**: probe timeout trả `download_unavailable`, ghi failure code bền vào marker và không bị registry cache thành `sidecar_missing`. Cache ready nhưng stale/corrupt được chuyển partial có mã rồi chạy online repair ngay trong cùng call; explicit offline vẫn fail-fast. Integration dùng child Python/Node, SQLite và filesystem temp thật, chốt cold snapshot, warm offline và repair xuyên restart
  - _Requirements: R6.5, R6.7_ — _Design: §4.6_
- [x] D.7 `runtime.caBundlePath` xuống cả hai loại child
  - `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE` cho sidecar; `NODE_EXTRA_CA_CERTS` cho child Node. MUST NOT tắt xác minh chứng chỉ, MUST NOT tự nhặt CA từ trust store OS
  - **Đã làm nửa sidecar**: `VieNeuTtsProviderOptions.caBundlePath` đặt `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE`. Interpreter đóng băng không mang trust store riêng, nên truyền bundle là đường được hỗ trợ; tắt xác minh hay nhặt từ store OS chỉ đổi một lỗi tải thành một lỗi im lặng
  - **Nửa Node**: `allowlistedEnvironment` nhận `caBundlePath` và đặt `NODE_EXTRA_CA_CERTS`; `NodeProcessRunner`, reporter `NodeRenderBinaryProbe` và shared `NodeProcessSupervisor` cho render/snapshot đều nhận cùng giá trị đã resolve từ composition root
  - Path rỗng được coi là **không có bundle**: với Node một chuỗi rỗng không phải "không có bundle" mà là bundle ở đường dẫn `""`, và nó làm hỏng mọi TLS handshake của child
  - Test chốt thêm một vế: `NODE_TLS_REJECT_UNAUTHORIZED` của cha **không** đi qua allowlist — tắt xác minh chỉ đổi một lỗi tải thành một lỗi im lặng
  - **Production wiring đã được chốt lại sau audit**: composition root lấy `config.caBundlePath` hoặc `settings.runtime.caBundlePath`, đưa cùng giá trị vào `NodeProcessRunner`, reporter probe, render/snapshot supervisor và `VieNeuTtsProvider`. Integration child thật chốt `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`; không mock `node:fs`
  - _Requirements: R6.5_ — _Design: §5.13_
- [x] D.8 Download cache coordinator
  - Per-component lock, partial marker, timeout. Partial marker là **nguồn sự thật duy nhất**: `hyperframes browser path` trả exit 0 cho binary 1 MB (đo ở S9)
  - Marker ghi **trước** byte đầu tiên và chỉ xoá khi download báo thành công. Thất bại, timeout, hay crash đều để lại trạng thái `partial` **qua cả restart** — test dựng một coordinator mới như lần boot sau và chốt vẫn đọc ra `partial`
  - Marker **hỏng/không đọc được vẫn tính là `partial`**, không phải `ready`: marker tồn tại nghĩa là đã có ai đó bắt đầu tải. Đây là hướng bảo thủ đúng
  - Khoá **theo từng component**: hai lần tải cùng component bị serialize, nhưng `models` tải chậm **không** chặn `chromium` — test chốt cả hai chiều, **đồng bộ tường minh** bằng promise chứ không bằng `sleep`. Bản đầu dùng `sleep(20)` rồi kỳ vọng thứ tự: xanh local, **đỏ trên Linux CI** khi runner tải nặng
  - Production dựng đúng một coordinator tại app-data và chia authority ổn định `browser-cache`/`models`. Browser dùng synthetic HOME, chạy `hyperframes browser ensure` dưới lock, thực thi binary với `--version` trước khi xoá marker; cache ready/partial nhưng binary hỏng buộc `ensure --force`
  - Timeout abort operation nhưng **không nhả lock sớm**: caller nhận `download_unavailable` sau khi failure marker atomic đã bền, còn lease được giữ tới khi downloader không hợp tác thật sự settle. `discardPartial`, `markReady`, `markPartial` cùng serialize với writer; root/component/marker symlink hoặc special file đều bị fail-closed
  - Doctor đọc cùng marker authority và giữ `download_tls_untrusted`/`download_unavailable` qua restart. Integration production composition root chạy cold browser thật bằng child Node, warm restart không tải lại, và VieNeu cold/warm như D.6 trên SQLite/filesystem temp
  - **Mở lại sau adversarial review**: managed Chrome phải là regular non-symlink, canonical-contained trong cache và trả version có hình dạng Chrome/Chromium/Headless Shell — executable bất kỳ như Bun/Node không phải Chromium. Doctor không được gọi model cache markerless rỗng là ready; cần warm offline probe hoặc proof tương đương
  - **Đã đóng lại**: browser managed bị kiểm regular/non-symlink, realpath contained ở cả resolver lẫn output của HyperFrames CLI, và `--version` phải có hình dạng Chrome/Chromium/Headless Shell. Doctor chạy warm-offline VieNeu probe trên cache ready thay vì tin directory/marker; cache rỗng hoặc payload hỏng không còn false-green
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
  - Một integration mới chạy **cả ba** trong cùng temp tree qua object production: `CompilerGuard` nhận operation không bao giờ settle; `NodeRenderBinaryProbe` gọi reporter Node thật trả exit 0/path hỏng rồi vẫn thực thi candidate; `NodeProcessRunner` spawn sidecar child thật. Seam mô phỏng mất `PYTHONUTF8` trả `tts_provider_unavailable`, stdout rỗng — không có chuỗi mojibake bị coi là thành công
  - _Requirements: R6.11, R6.5, R6.7_ — _Design: §11.3_
- [x] D.12 Integration test: mọi điểm spawn đi qua `allowlistedEnvironment`
  - Liệt kê điểm spawn và chứng minh không điểm nào tự dựng env — nếu không, hai bảo vệ UTF-8 và caBundlePath biến mất mà không ai thấy
  - Quét bốn package source; **miễn trừ phải khai kèm lý do**, và test thứ hai chốt mọi miễn trừ vẫn trỏ vào file còn spawn thật — miễn trừ sống lâu hơn cái spawn của nó là một lỗ để ngỏ cho lần sau
  - **Bẫy khi viết audit**: regex `\bexec\s*\(` bắt nhầm `client.exec(` của SQLite và `pattern.exec(` của regex, báo 5 điểm spawn không hề tồn tại. Phải dùng lookbehind `(?<![.\w])` — một audit báo động giả sẽ bị người ta tắt đi
  - Audit hiện dùng TypeScript AST thay regex: theo binding của `node:child_process`, bắt renamed import, namespace call, `promisify(execFile)` và alias như `options.spawnProcess ?? spawn`; kiểm **từng call** chứa allowlist, không để một call đúng che call sai cùng file
  - Mỗi exemption định danh đúng file + callee + argument đầu, phải còn đúng một unguarded call và có lý do sống; `spawnEnsuredDaemon` đã bị audit bắt rò full environment và nay chỉ forward tập cấu hình daemon hẹp
  - _Requirements: R6.7, R6.8_
- [x] D.13 Integration test: huỷ giữa chừng
  - **Termination proof có cờ `exhaustive`**, MUST NOT phát biểu thành "không còn tiến trình con" ([steering/08](../../../steering/08-jobs-and-queue.md) §6.1 đã rút lại bảo đảm đó). Còn survivor sau khi cạn lượt ⇒ `process_termination_unverified`, MUST NOT ghi `cancelled`. Workdir có marker thu hồi được thứ lọt qua
  - [`termination-proof-contract.test.ts`](../../../../tests/adapter/termination-proof-contract.test.ts): proof không exhaustive vẫn `terminated` nhưng **kèm warning**, không im lặng; có survivor thì ném `process_termination_unverified` **bất kể** exhaustive hay không, và message nêu đích danh pid để người vận hành có cái mà xử lý
  - Chốt luôn PID reuse: cùng pid, khác `startedAt` ⇒ **không** khớp. Coi là khớp chính là cách một lượt quét kết luận người lạ đang sống là đứa con nó vừa giết
  - _Requirements: R6.8_ — _Design: §4.6, §11.4_

**Acceptance Criteria**:
- [ ] Render MP4 **từ artifact** trên máy không có Node và không có Python trên PATH — proof lịch sử đã publish binary SHA-256 `5b111f…e2bc0`, nhưng closeout SEA/publisher/seal sau đó đã đổi exact HEAD nên AC được mở lại cho tới khi production `build:artifact --json` tạo binary mới và clean app-data cold-extract/render dưới private PATH nơi `command -v node|python|python3` đều absent
  - Prototype exact HEAD xác nhận SEA main trực tiếp không thể load native/external package từ filesystem; cần bootstrap builtins-only extract verified runtime rồi load secondary CJS từ archive. Ngoài ra migration path từng bake source `import.meta.url`, diagnostics từng fallback checkout (đã sửa), và CLI render bearer đang gọi nhầm browser-session route 401. Không blocker nào được phép temp-rewrite để tick AC
  - Migration source-path blocker đã đóng: `BootstrapCoordinator` chỉ sau extraction mới lấy `<archiveRoots.node>/drizzle`; source mode vẫn dùng default checkout. Integration xoá source migrations trước prepare, migrate SQL từ archive target không trùng key trên SQLite thật và chốt đúng một lần
  - Production proof: `/private/tmp/vidcom-phase-d-production-smoke.6mvwdf/EVIDENCE.md`; MP4 SHA-256 `744c8c…bdc0`, H.264 320×180 30 fps + AAC 48 kHz stereo, 5,000 s. Extracted ffmpeg báo mean −20,3 dB/max −6,3 dB; only authored audio là `narration/intro.wav`, BGM tắt/HTML không audio-video và decoded source→render correlation `0,991181` ở AAC priming 21,375 ms
  - Exact extracted frozen Python chỉ còn `bin/python3`; packaged worker probe dưới `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1` trả ready, 14 voice, engine 3.2.4. Explicit + auto-started daemon đều được dừng; ports/discovery record sạch
- [x] `install_motion_library` vendor được mà không cần `node_modules`, version khớp catalogue — [`motion-runtime-artifact.test.ts`](../../../../tests/e2e/motion-runtime-artifact.test.ts) build archive thật chứa đủ năm package/file đã khai, xoá staging source, extract qua `FilesystemRuntimeAssetSource` + `RuntimeAssetManager`, resolve artifact paths, mở foundation trên SQLite/filesystem thật rồi gọi registry `install_motion_library` cho cả năm. Test so byte source → extracted → vendored và làm mất distributed root để chốt không fallback checkout `node_modules`
- [x] Không đường nào chạm compiler mà thiếu timeout — preload đặt đúng binary trước module initialization; compiler-capable call duy nhất nằm trong child process có deadline/termination proof. AST inventory + emitted-CJS ordering + real transform xanh 38/38 trong main rerun

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
- [x] Request không session ⇒ 401 kể cả từ `127.0.0.1` — [`browse-surface.test.ts`](../../../../tests/cli/browse-surface.test.ts) gọi qua **socket loopback thật** trên daemon của J.2
- [x] Không trả nội dung file hay kích thước file thường — test dựng một file 4096 byte ngoài workspace và chốt response không mang byte lẫn kích thước

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
  - > [!WARNING]
    > **Đính chính: khoá trên `process.env.CI` làm CI đỏ ngay lập tức.** Không job nào trong [`ci.yml`](../../../../.github/workflows/ci.yml) cài `chrome-headless-shell`, nên bản đầu của harness làm macOS đỏ ở `cc7f315` (`browser session tests cannot be skipped in CI`). Linux và Windows xanh cùng commit — càng khó truy hơn.
    > Đã đổi sang cờ riêng **`VIDCOM_REQUIRE_BROWSER`**, đúng khuôn `VIDCOM_DOCTOR_STRICT` mà chính dòng trên viện dẫn. Một gate đỏ vì **thiếu công cụ** chứ không vì **thiếu hành vi** là gate người ta học cách bỏ qua. **CI job phải set cờ này trong cùng thay đổi cài browser** — làm cùng G.9.
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
- [x] G.5 Tách page dynamic route
  - Server component xuất `generateStaticParams` (trả sentinel `__shell`) + client component mang thân page; slug đọc từ `location`, MUST NOT từ `params`
  - `page.tsx` (server) → `composer-client.tsx` (thân page) → `shell-sentinel.ts` (hằng)
  - **Hằng phải nằm ở module riêng, không có `"use client"`** — bản đầu tôi export `SHELL_SENTINEL` từ chính client component và `next build` đỏ: `A required parameter (slug) was not provided as a string received function`. Import một giá trị từ module `"use client"` vào server component trả về **client reference**, tức một function, chứ không phải chuỗi. `next build` là thứ duy nhất bắt được điều này — typecheck và test đều xanh
  - Slug đọc trong **lazy initializer của `useState`**, không phải trong effect: effect set state lúc mount tốn thêm một lần render và đúng là thứ `react-hooks/set-state-in-effect` sinh ra để chặn. `window` vắng mặt lúc prerender shell, và `null` là câu trả lời trung thực ở đó
  - Sentinel `__shell` được coi là **không có project**: fetch một project tên `__shell` sẽ 404 theo kiểu trông như project bị thiếu
  - _Requirements: R4.13, R4.5_ — _Design: DR-3_
- [x] G.6 Bỏ catch-all route handler khỏi build export
  - `src/app/api/[[...route]]/route.ts` với `dynamic = "force-dynamic"` làm `next build` fail; `trailingSlash: false` chốt tường minh
  - **Đã làm**: `trailingSlash: false` khai tường minh trong [`next.config.ts`](../../../../next.config.ts) thay vì dựa vào mặc định. Static export ghi `/a/b.html` hay `/a/b/index.html` **tuỳ cờ này**, và SEA asset host ánh xạ request path lên đúng những file đó — hai bên phải khớp, và khớp do tình cờ là cách chúng trôi ra khỏi nhau về sau. `npm run build` xanh sau khi đổi
  - [`next-export-config.test.ts`](../../../../tests/frontend/next-export-config.test.ts) **ghim danh sách route handler** hiện có (`src/app/api/[[...route]]/route.ts`). Khi bật `output: "export"` thì mọi handler `force-dynamic` làm build fail, nên danh sách được chốt ở đây: một handler thêm vào giữa chừng sẽ hiện ra tại test này thay vì thành một build fail không ai ngờ
  - **Đã lật `output: "export"` sau khi H.1 có bundler thật**: `next build` xanh, sinh 57 file gồm `projects/__shell.html` **và** `projects/__shell.txt` — đúng cặp mà resolver H.3 đã map. Route (app) chỉ còn `/`, `/_not-found`, `/projects/[slug]`, không route nào render lúc request
  - **`src/app/api/[[...route]]/route.ts` bị xoá, không phải dời**: export fail trên *mọi* route handler chứ không riêng `force-dynamic`, và API vốn thuộc về daemon — trình duyệt gọi nó qua cùng origin loopback trong artifact, qua origin cấu hình ở dev (§5.11). `handleNextHostedRequest` **giữ nguyên** trong `packages/cli`: nó là hàm, và các suite server đang dùng nó làm harness
  - **Cửa sổ hồi quy có chủ ý, đóng ở J.2**: từ lúc này tới khi `serve`/`app` nối listener của E vào static host, source checkout không còn đường tự phục vụ API qua Next. Đó là chiều đúng — Next-hosted API là di sản chuyển tiếp, không phải đích
  - `tests/server/next-routing.test.ts` **bị xoá**: cả hai case chỉ mô tả bề mặt Next-hosted API (thứ tự exact route vs catch-all, và catch-all là route server duy nhất còn lại). Bất biến thay thế — **không còn route handler nào** — nằm ở [`next-export-config.test.ts`](../../../../tests/frontend/next-export-config.test.ts), nên giữ file cũ là giữ hai chỗ nói về cùng một thứ mà một chỗ đã sai
  - _Requirements: R4.11, R4.5_ — _Design: §5.10_
- [x] G.7 `WorkspacePickerPage`
  - Roots, breadcrumb, entry phân trang, tạo thư mục, chọn, trạng thái lỗi R1.7. Chưa có workspace ⇒ app vào màn này trước Home
  - [`workspace-picker/state.ts`](../../../../src/lib/workspace-picker/state.ts) — reducer thuần, **tách khỏi render** vì `environment: "node"` toàn cục và không có jsdom: hành vi chỉ tồn tại bên trong component là hành vi không bao giờ được test
  - Ba quyết định UX chốt bằng test: breadcrumb **cắt tại crumb được bấm** chứ không pop một cấp (bấm lên ba cấp phải tới đúng đó); thư mục xếp **trước** file (folder lẫn giữa file là folder người dùng phải đi tìm); và một bước hỏng **giữ nguyên** danh sách đã tải (dọn sạch pane đang đọc biến một thư mục bị từ chối thành một app trông như hỏng)
  - Lỗi cũ được xoá lúc **bắt đầu** lần thử mới, không phải lúc thành công — để nguyên trong lúc retry là hiển thị một thất bại không còn xảy ra
  - [`workspace-picker.tsx`](../../../../src/components/workspace/workspace-picker.tsx) dựng trên reducer đó, nhận API qua props nên không tự biết cách gọi mạng
  - **Không có ô nhập đường dẫn** — cố ý: đường dẫn người dùng gõ được là đường dẫn trang nào cũng gửi được, và toàn bộ điểm của browse là server chỉ hành động trên thư mục chính nó phát ra
  - **Còn lại**: điều hướng "chưa có workspace ⇒ vào màn này trước Home" — thuộc về shell của app, làm cùng chỗ quyết định route
  - _Requirements: R1.11_ — _Design: §5.12_
- [x] G.8 `NewProjectDialog`
  - Tên + preset đóng sẵn; chặn double-submit; lỗi validation và trùng slug; thành công thì refresh/điều hướng. Sửa dòng phụ "Generate with an AI agent" ở [`new-project-card.tsx`](../../../../src/components/home/new-project-card.tsx)
  - MUST NOT thêm file/folder CRUD, upload asset, agent generation
  - [`new-project/state.ts`](../../../../src/lib/new-project/state.ts) — cùng lý do tách như G.7
  - **Chặn double-submit** là `canSubmit` trả `false` khi đang bay: cú bấm thứ hai trong lúc request chạy không phân biệt được với cú đầu, và hai cú bấm không được tạo hai project
  - Hỏng thì `submitting` về `false` để người dùng sửa và thử lại — dialog kẹt disabled sau một tên bị từ chối là dialog phải đóng đi mở lại
  - Preset là **tập đóng**: danh sách mở là chỗ cho một giá trị render pipeline chưa từng thấy
  - [`new-project-dialog.tsx`](../../../../src/components/home/new-project-dialog.tsx) — chỉ tên và preset. Không upload, không quản lý thư mục, không agent generation: mỗi thứ đó là một bề mặt riêng với chế độ hỏng riêng, và đưa một nửa vào đây là hứa thứ dialog không hoàn thành được
  - `canSubmit` được kiểm **cả ở handler lẫn ở thuộc tính `disabled`**: submit bằng bàn phím không đi qua `disabled`
  - Dòng phụ ở [`new-project-card.tsx`](../../../../src/components/home/new-project-card.tsx) đổi từ "Generate with an AI agent" sang "Or ask a connected AI agent to build one" — bản cũ khiến nút trông như sẽ tự viết video, trong khi generation xảy ra qua agent nối bằng MCP, thứ người dùng phải tự thiết lập
  - _Requirements: R1.19_ — _Design: §5.12, §7.6_
- [x] G.9 Kịch bản trên harness của G.0
  - Nonce → session → xoá token khỏi URL; picker; New video **cả hai nhánh** thành công và thất bại; cross-origin dev giữ cookie ở fetch **và** SSE
  - Ma trận cookie lấy **đúng** bảng đã đo ở S9 làm kỳ vọng: `localhost:3000 → localhost:<port>` giữ được `SameSite=Strict`; `localhost:3000 → 127.0.0.1:<port>` **mất cookie dù `exchange` trả 200**. Vế thứ hai là test của G.3, và nó phải fail-at-boot chứ không phải fail-ở-request đầu
  - [`cookie-matrix.test.ts`](../../../../tests/frontend/cookie-matrix.test.ts) giữ **cả hai dòng cạnh nhau** để đọc thành một cặp: đổi port thì được, đổi hostname thì không, và cái hỏng thì im lặng. Kiểm tra lúc boot phải khớp **chính xác** bảng đo — nếu nó từng chấp nhận dòng thứ hai thì sản phẩm ship một cấu hình mà `exchange` trả 200 còn session không bao giờ tới
  - **Workflow riêng, không nhồi vào CI chính**: [`phase4-browser-session.yml`](../../../../.github/workflows/phase4-browser-session.yml) cài `chrome-headless-shell` rồi set `VIDCOM_REQUIRE_BROWSER=1`. Browser là ~200 MB mỗi job và CI chính đã 13–16 phút trên Windows; trả giá đó mỗi lần push để mua hai khẳng định là đánh đổi sai. Repo đã có tiền lệ tách dependency nặng ở `phase4-python-stack.yml`
  - [`browser-session.test.ts`](../../../../tests/frontend/browser-session.test.ts) chạy bundle static đã build bằng Chrome thật, proxy `/api/*` vào đúng Hono production host: exchange nonce rồi xác nhận query `t` biến mất; tạo `Browser Video` và điều hướng tới slug; tạo trùng rồi xác nhận `role=alert`; ép trạng thái chưa có workspace, đi qua roots → entries → activate và quan sát request kích hoạt. Local gate: **8/8** cùng `cookie-matrix.test.ts`
  - Harness chỉ intercept bốn response picker để có cây thư mục deterministic; auth, nonce exchange, project create thành công/thất bại và static asset đều chạy qua daemon thật. Workflow build `out` trước khi chạy và đặt `VIDCOM_REQUIRE_BROWSER=1`, nên thiếu Chrome là lỗi chứ không phải skip
  - _Requirements: R1.10, R1.19, R4.10, R4.12_

**Acceptance Criteria**:
- [x] Cùng một bundle chạy same-origin (artifact) và cross-origin (dev) chỉ bằng cấu hình
- [x] `next build` với `output: "export"` xanh
- [x] `rtk bun run test:browser-session` **chạy được** (script tồn tại, Chrome resolve được) và xanh
- [x] Không thêm dependency nào vào [`package.json`](../../../../package.json) cho phase này ngoài script

**Deliverables**: `src/lib/api/services.ts` · `src/app/projects/[slug]/*` · `src/components/workspace-picker/*` · `next.config.ts` · `tests/support/browser-harness.ts` · `tests/frontend/{api-driver,browser-session}.test.ts` · script `test:browser-session`

---

## Phase H: SEA build + static asset host

**Addresses**: R4.1–R4.3, R4.6–R4.9, R4.14 · **Design**: §5.10, §9.1, DR-1
**Files affected**: `scripts/build-artifact.mjs`, `packages/cli/src/sea-static-host.ts`, `packages/server/src/middleware/body-limit.ts`, `package.json` (script `build:artifact`)
**Prerequisite**: G
**Estimate**: 13 SP

**Tasks**:
- [x] H.0 Script `build:artifact`
  - Thêm `"build:artifact": "node scripts/build-artifact.mjs"` vào [`package.json`](../../../../package.json) — cùng dạng với các script `node scripts/*.mjs` đang có (`test:boundaries`, `test:schema-drift`, `test:spec-paths`, …). Nó SHALL gọi lần lượt: `scripts/build-runtime-archives.mjs` (B.3) → `next build` với `output: "export"` (G.6) → frontend pack (H.2) → bundle CJS (H.1) → SEA native (H.4) → `scripts/verify-artifact.mjs` (L.1/L.2)
  - **Fail-fast từng bước**, MUST NOT tiếp tục sang bước sau khi bước trước lỗi: một `frontend.pack` cũ đi cùng bundle mới là loại lỗi chỉ lộ ra ở packaged smoke
  - In ra đường dẫn artifact + platform tag ở `stderr`; `stdout` chỉ để `artifact-manifest.json` (L.2) nếu có `--json`
  - MUST NOT cross-build (DR-1): script chạy trên OS nào thì chỉ sinh artifact của OS đó, và **fail có mã** nếu được gọi với target khác `process.platform`
  - [`build-artifact.mjs`](../../../../scripts/build-artifact.mjs) + script trong `package.json`, cùng dạng `node scripts/*.mjs` với các script sẵn có
  - **Fail-fast là nội dung, không phải sở thích**: một `frontend.pack` cũ đi qua bước pack hỏng rồi được bundle cùng code mới sinh ra artifact chỉ hỏng khi có người chạy nó — chỗ đắt nhất để phát hiện
  - Từ chối cross-build với lý do cụ thể: artifact nhúng Node binary và runtime native **của chính máy build**, nên một "bản Linux" dựng trên macOS là file không chạy được ở đâu cả
  - `stderr` mang tiến trình, `stdout` để trống cho `--json` — pipe được mà không phải lọc
  - **Chuỗi chạy hết, đo được**: `bun run build:artifact` trên darwin-arm64 đi qua runtime archives → static export → frontend pack → CJS bundle → runtime staging → SEA native → `verify-artifact`, ra `dist/artifact/darwin-arm64/vidcom` **322 MB** cùng `SHA256SUMS` và `artifact-manifest.json`. Test ghim đúng thứ tự và tên chủ sở hữu từng bước, nên một bước thiếu hiện ra ở đây thay vì lúc chạy build
  - **Mọi bước dùng binary cả ba nền tảng spawn được**: `npm` trên Windows là `.cmd` và Node từ chối spawn nó khi không có shell, nên một bước viết theo kiểu đó sẽ chết ở đó vì lý do chẳng liên quan tới việc nó làm. Test cấm `npm` ở mọi bước
  - _Requirements: R4.1, R4.14_ — _Design: DR-1, §5.10_
- [x] H.1 Bundle CJS **không top-level await**
  - Node SEA nhận main CJS và format `cjs` không diễn đạt được TLA; mọi khởi tạo bất đồng bộ nằm trong `main()`. Vi phạm ⇒ build fail, không degrade
  - **Bundler là `bun build --target=node --format=cjs`** ([`build-cli-bundle.mjs`](../../../../scripts/build-cli-bundle.mjs)), ghi vào Design §16 C-7. Bun đã là toolchain bắt buộc của repo — mọi script và mọi test chạy qua nó — nên **không thêm dòng nào vào `package.json` hay lockfile**, luật 6 giữ nguyên. Phase 0 loại Bun ở vai trò **runtime** (`--compile` không load được `onnxruntime-node`/`sharp`); đây là vai trò **build-time**, output vẫn là CJS chạy dưới Node binary nhúng
  - **Đường `esbuild` từ runtime archive bị bỏ**: nó chặn H.1 sau một tài sản phát hành chưa tồn tại (config pin version + hash ba OS cho `build-runtime-archives.mjs`), và không có tài sản đó thì không kiểm chứng được gì. `esbuild` vẫn không phải dependency khai báo ở bất kỳ package nào — hai bản transitive trong bun store (`0.25.12`, `0.28.1`) vừa không khai vừa nhập nhằng, nên hoisted copy vẫn bị loại. `ESBUILD_BINARY_PATH`/`ESBUILD_WORKER_THREADS` **lúc chạy** vẫn thuộc `CompilerGuard` của D.4, không đổi
  - Chặn TLA trên **source entry**, không trên bundle: bundle là một file 14 MB đã dịch dòng, báo lỗi ở đó chỉ ra một số dòng không ai sửa được, còn báo trên source chỉ đúng câu lệnh phải chuyển vào `main()`. Quét theo độ sâu ngoặc để `await` trong hàm và biến tên `awaited` không bị bắt nhầm
  - `--sourcemap=none` là nội dung chứ không phải mặc định: sourcemap mang đường dẫn tuyệt đối của máy build và toàn bộ source gốc, đúng hai thứ L.1 cấm trong artifact
  - Test build **thật** rồi `require` bundle bằng Node trong thư mục tạm **không có `node_modules` ở bất kỳ cấp cha nào**: một import mà bundler để external hỏng ngay tại đây thay vì ở packaged smoke. `MODULE_NOT_FOUND` là khẳng định riêng vì đó là hình dạng lỗi thật
  - **Papercut đã biết, không sửa bằng cách nới ESLint**: `dist/` bị `.gitignore` nhưng **không** nằm trong ignore của ESLint, nên `lint` cục bộ đỏ sau khi build (bundle 14 MB bị quét). CI checkout sạch nên xanh. Giữ đúng tiền lệ Phase A — isolate artifact khi cần chạy lint chính xác, MUST NOT đổi config
  - _Requirements: R4.14_ — _Design: DR-1, §16 C-7_
- [x] H.2 Frontend pack + manifest
  - `frontend-manifest.json` (`path, offset, length, sha256, mime, cachePolicy`) + `frontend.pack` raw bytes, **không base64**
  - [`build-frontend-pack.mjs`](../../../../scripts/build-frontend-pack.mjs) đọc `out/` của G.6, nối raw bytes vào `dist/sea/frontend.pack` và ghi manifest offset. Chạy thật: **57 asset, 2.379.699 byte**
  - **`cachePolicy` hỏi chính `resolveAsset`, không tự quyết**: quyết hai lần là cách build và host lệch nhau, và cái lệch đáng sợ là một asset được cache vĩnh viễn theo luật host chưa bao giờ áp. `mime` cũng lấy từ `mimeTypeFor` của H.3 — bảng MIME đóng chỉ có **một** bản
  - Vì thế bước pack chạy dưới **`bun`** chứ không phải `node`: nó cần đọc thẳng resolver trong `sea-static-host.ts`. Chép luật resolver sang script build là đúng loại trùng lặp H.7 tồn tại để chặn
  - Raw bytes chứ không base64: host đọc thẳng từ executable thành immutable view; base64 tốn thêm một phần ba dung lượng **trong binary** cộng một lần decode toàn bộ frontend trước byte đầu tiên
  - [`frontend-pack.test.ts`](../../../../tests/build/frontend-pack.test.ts) đọc lại **từng** asset tại offset đã ghi trên filesystem thật và so cả nội dung lẫn SHA-256; chốt **không kẽ hở, không chồng lấn** (chồng lấn phục vụ đuôi asset này thành đầu asset kia); chốt thứ tự sort ổn định để hai lần build ra byte giống hệt; và chốt hai ca hỏng — chưa export, và export rỗng (artifact chạy được nhưng 404 mọi trang, đọc như lỗi routing)
  - _Requirements: R4.1, R4.2_ — _Design: §5.10_
- [x] H.3 `SeaStaticAssetHost`
  - `getRawAsset` + immutable view, không ghi pack ra đĩa. Resolver normalize URL, reject encoded traversal, map `/projects/<slug>` **và payload RSC `.txt`** sang `projects/__shell*`
  - HTML/RSC `no-store`; `/_next/static/**` immutable
  - [`sea-static-host.ts`](../../../../packages/cli/src/sea-static-host.ts) — resolver thuần, 14 test
  - **Hai lỗi thật do test bắt, không phải do đọc lại code**: (1) `new URL()` **tự resolve `..` khi parse**, nên mọi kiểm tra đặt *sau* nó đều nhìn thấy path đã sạch — traversal lọt qua trông như đường dẫn thường. Phải kiểm trên **path thô** trước. (2) `//projects/x` bị URL parser đọc `//projects` thành **authority**, nuốt mất segment đầu. Đã **bỏ hẳn `new URL`** và dựng path từ chính các segment đã decode — xoá cả một lớp phân kỳ parser
  - Decode **đúng một lần**; còn `%` sau đó là từ chối, không decode tiếp: double-encode ở đây chỉ tồn tại để lách một kiểm tra decode một lần
  - `/projects/<slug>` và payload RSC `.txt` **cùng** về `projects/__shell*`: thiếu vế `.txt` thì điều hướng trong app 404 trong khi tải lại trang vẫn chạy — hỏng theo kiểu chỉ một nửa
  - **`createSeaStaticAssetHost` đã xong**: đọc hai asset nhúng qua seam `SeaAssetSource.getRawAsset`, mỗi response body là **subarray view** trên pack — không copy, không ghi ra đĩa. Copy nghĩa là giữ hai bản frontend trong RAM; ghi ra nghĩa là đặt một bản app **sửa được** cạnh artifact, đúng thư mục mà thiết kế này tồn tại để tránh
  - Seam thay vì gọi thẳng `node:sea`: một test chỉ chạy được bên trong executable đã đóng gói là test không ai chạy
  - Kiểm biên **một lần lúc dựng**, không phải mỗi request: entry vượt quá pack nghĩa là manifest và pack đến từ hai lần build khác nhau, và lúc trung thực để nói là trước request đầu tiên chứ không phải ở trang nào tình cờ tải asset bị cắt cụt
  - **Phát hiện phải ghi lại vì nó ngược với trực giác từ test của resolver**: ở tầng `Request`, traversal **không bao giờ tới nơi** — WHATWG URL resolve cả `..` lẫn bản percent-encode `%2e%2e` ngay lúc parse, nên cả hai URL đó hỏi host `/index.html` và được `/index.html`. Không có gì thoát ra: pack không có thư mục, và mọi key mà một path đã normalize chạm tới đều là asset export đã publish. Resolver **vẫn** từ chối traversal cho caller đưa raw path — mà dòng request của `node:http` chính là raw path
  - `requestPath` cắt chuỗi thay vì parse lần hai: `//projects/x` bị URL parser đọc `//projects` thành authority và nuốt segment đầu — đúng lỗi (2) đã ghi ở trên, giữ nguyên chỗ nó có thể quay lại
  - Chốt cấu trúc "không ghi ra đĩa" bằng test đọc chính source module và đòi **không có import `node:fs`**: module không với tới filesystem được thì không trôi vào đó được
  - GET/HEAD phục vụ, method khác trả `405` kèm `allow` — asset host không có đường ghi nào
  - _Requirements: R4.2, R4.5_ — _Design: §5.10_
- [x] H.4 Build SEA native theo runner
  - `useCodeCache=false`, `useSnapshot=false`, postject pinned, không cross-build
  - [`build-sea.mjs`](../../../../scripts/build-sea.mjs) chạy thật trên darwin-arm64: blob → copy Node đang chạy → `codesign --remove-signature` → postject → ad-hoc sign. Ra **`dist/artifact/darwin-arm64/vidcom`, 127 MB**, chạy được trong thư mục tạm rỗng và **không sinh file nào cạnh nó**
  - **Cả hai cờ V8 tắt là nội dung**: code cache và snapshot đều nướng byte gắn với một bản V8. Cache do Node này ghi mà Node khác đọc thì **fail lúc khởi động chứ không fallback**, và Node ghi blob là Node của máy build, chỉ trùng bản Node nhúng theo quy ước
  - `postject@1.0.0-alpha.6` là exact dev dependency và được gọi bằng `process.execPath` cho Mach-O/PE. Linux dùng injector ELF streaming nội bộ `vidcom-elf-stream-v1` vì heap WASM của postject abort với blob production-size; cả hai injector được ghi vào artifact provenance
  - `--macho-segment-name NODE_SEA` chỉ trên darwin: thiếu nó thì blob rơi vào chỗ runtime không đọc — executable build xong, chạy được, rồi báo **không có main nhúng**
  - **Hai bước `codesign` là bắt buộc, không phải hardening**: chữ ký gốc của bản copy hết khớp ngay khi có segment được tiêm, và Mach-O arm64 không chữ ký hợp lệ bị kernel giết lúc launch — thiếu bước này thì artifact không chạy nổi trên chính máy vừa build nó. L.3 chốt lại bằng test
  - **Bẫy đã trả giá**: path trong `sea-config.json` tính theo **working directory** của bước blob, không phải theo vị trí file config. Đặt sai chiều báo `Cannot read main script`, đọc y hệt lỗi thiếu bundle. Test chốt mọi path là relative và không mở đầu bằng `.`
  - Test logic chạy mỗi push; packaged smoke build native thật trên từng runner. Linux còn có repro blob 300 MiB qua active-resource verifier và executable amd64 chạy thật trước exact-head Actions
  - _Requirements: R4.1_ — _Design: DR-1_
- [x] H.5 Body limit theo route
  - 1 MiB mặc định, **20 MiB** cho route upload asset, ở đúng mắt xích `bodyLimit` của chuỗi middleware cố định. Vượt ⇒ `413 payload_too_large` kèm giới hạn thật
  - **Route upload asset hôm nay là đúng một chỗ**, đã rà sẵn: `uploadBgm` trong [`packages/server/src/routes/project-writes.ts`](../../../../packages/server/src/routes/project-writes.ts#L134). Mọi route khác giữ 1 MiB. Nếu lúc làm thấy chỗ thứ hai nhận binary body thì **dừng và ghi vào Execution Log** — nghĩa là bề mặt upload đã đổi so với lần rà này, không phải cứ thế nới thêm một ngoại lệ
  - **Cơ chế đã có sẵn từ trước** ở [`app.ts:70-82`](../../../../packages/server/src/app.ts#L70): 1 MiB mặc định, `MAX_SOURCE_BYTES` cho `/files`, `MAX_BGM_BYTES` (20 MiB) cho `/assets/bgm`, đúng một mắt xích `bodyLimit` cố định, và [`payload-limits.test.ts`](../../../../tests/server/payload-limits.test.ts) đã chốt 413 ở byte kế tiếp
  - **Thứ còn thiếu là cái gác cho lần rà đó**: [`upload-surface-audit.test.ts`](../../../../tests/server/upload-surface-audit.test.ts) quét toàn bộ `packages/server/src` tìm `arrayBuffer()` — cách một route biến request thành bytes — và fail nếu xuất hiện chỗ thứ hai. Kết quả rà hôm nay **khớp**: đúng một file. Không có test này thì câu "đã rà sẵn" hết hạn ngay khi có người thêm route
  - _Requirements: R4.6_ — _Design: §7_
- [x] H.6 Đo cold/warm + baseline hồi quy — **ba baseline runner đã commit và là gate bắt buộc**
  - Ghi baseline vào `.github/perf-baseline/<runner-label>.json`, **commit vào repo** — không dùng CI cache (cache hết hạn thì gate im lặng biến mất)
  - [`measure-startup.mjs`](../../../../scripts/measure-startup.mjs) giữ **hai gate độc lập**: trần cứng §9.1 là số duy nhất chặn release, còn baseline riêng từng runner bắt một lần khởi động **tăng gấp rưỡi** dù vẫn nằm dưới trần
  - Baseline chỉ ghi khi **chưa có**: ghi đè mỗi lần chạy làm gate hồi quy vô nghĩa — mỗi lần đo tự trở thành baseline của chính nó và không gì trôi được nữa. Đổi baseline là đổi ngưỡng, và ngưỡng đi qua pull request
  - Trần Windows cao hơn vì phần lớn cold start ở đó là bị quét: riêng stack Python đã khoảng nửa GB trên đĩa. Ép nó theo số macOS là làm fail một máy đang chạy bình thường
  - Đo một thứ **không có trần** trả `unknown` chứ không tính là đạt: đó là một lỗ hổng, và report gọi tên nó
  - **Evidence exact head `0fdbd35`**: darwin `813/611 ms`, Linux `1007/1004 ms`, Windows `2637/2461 ms`; ba file baseline v1 đã commit. Baseline thiếu, sai runner, sai schema hoặc thiếu một measurement làm packaged smoke fail thay vì tự tắt regression gate
  - _Requirements: R4.9_ — _Design: §9.1_
- [x] H.7 Golden test static host
  - Exact/implicit `.html`/sentinel/RSC mapping, MIME, cache header, 404, traversal
  - [`static-host-mapping.test.ts`](../../../../tests/golden/static-host-mapping.test.ts) viết **cả bảng ra một chỗ** thay vì suy ra từng dòng: mỗi dòng là một request trình duyệt thật sự gửi, và để cạnh nhau thì sửa resolver cho một dòng sẽ lộ ngay nếu nó làm xê dịch dòng khác
  - MIME là **bảng đóng**: pack chỉ chứa thứ export ghi ra, nên một đuôi ngoài danh sách nghĩa là build sinh ra thứ không ai dự tính. Trả `application/octet-stream` để trình duyệt **tải về thay vì chạy** — cách sai an toàn
  - Traversal trả `null`, tức rơi vào đường 404 của host, chứ không tìm thấy một manifest key khác
  - _Requirements: R4.5_
- [x] H.8 Integration test artifact
  - Chạy với `cwd` là thư mục tạm **rỗng**; cạnh artifact không xuất hiện thư mục asset nào; SSE không bị buffer; upload 20 MB đi qua; 21 MB trả 413
  - [`artifact-integration.test.ts`](../../../../tests/cli/artifact-integration.test.ts) chạy daemon của J.2 trên **socket thật**: thư mục khởi chạy vẫn rỗng, SSE có `x-accel-buffering: no`, upload đúng `MAX_BGM_BYTES` đi qua, thêm một block nữa trả **413**
  - Qua socket thật chứ không gọi thẳng app: một body limit chỉ đúng với `Request` trong bộ nhớ là giới hạn mà **đường mạng chưa từng được hỏi**
  - **Lệch spec, ghi lại chứ không đổi tên**: mã lỗi thật là `too_large`, checklist H.5 viết `payload_too_large`. Wire contract đã phát hành nên nó thắng
  - Nửa "chạy chính executable đã đóng gói" đã kiểm tay ở H.4 (127 MB, thư mục tạm rỗng, không sinh file), và **được ghim tự động ở M** — packaged smoke là chỗ duy nhất có artifact thật để chạy
  - _Requirements: R4.3, R4.2, R4.6_

**Acceptance Criteria**:
- [x] Artifact không chứa `next` ở đường chạy — test build thật rồi quét bundle, không có `node_modules/next/`
- [x] Cold/warm nằm trong trần §9.1 trên runner đang build

**Deliverables**: `scripts/build-artifact.mjs` · `packages/cli/src/sea-static-host.ts` · `.github/perf-baseline/`

---

## Phase I: Daemon discovery + bridge + attachment

**Addresses**: R2.2–R2.4, R2.6–R2.13, R2.15 · **Design**: §4.4, §5.5–§5.7, §7.8–§7.11
**Files affected**: `packages/adapter/src/daemon/**` (thư mục mới trong `@vidcom/adapter`), `packages/adapter/src/fs/daemon-discovery.ts`, `packages/cli/src/bridge/**` (**hiện thực remote invoker ở đây, không ở `mcp`** — xem I.2b), `packages/mcp/src/registry/types.ts` (chỉ thêm `interface ToolInvoker`), `packages/cli/src/composition-root.ts`, `packages/cli/src/commands/mcp.ts`, `packages/server/src/routes/bridge.ts`
**Prerequisite**: E · **A.4 phải xong** (route I.7b validate bằng catalogue)
**Estimate**: 19 SP

**Tasks**:
- [x] I.1 `DaemonDiscoveryStore`
  - `<app-data>/daemon/<workspaceHash>.json`, atomic temp+fsync+rename, `0600`/ACL. `remove` so `instanceId` để daemon cũ không xoá record daemon mới. **Không** secret, không attachment count, không lease id trong file
  - [`daemon-discovery.ts`](../../../../packages/adapter/src/fs/daemon-discovery.ts) dùng lại đúng `secureAppDataDirectorySync`/`secureCredentialFile` của credential store — cùng đường ACL Windows, không dựng đường thứ hai
  - Tên file là **hash** chứ không phải path: workspace root chứa separator, khoảng trắng và ký tự Windows từ chối, mà encode chúng thì hai root khác nhau va nhau ngay khi encoding mất mát
  - `read` **validate** record chứ không chỉ parse: sai `workspaceRoot`, sai hash, sai schemaVersion, host không phải `127.0.0.1`, port ngoài `1..65535` đều trả `null`. Mỗi ca đó nếu lọt sẽ chỉ client tới một daemon **khác**, rồi mọi kiểm tra sau đều pass vì nó đang nói chuyện với một tiến trình thật, khoẻ mạnh
  - Ghi truncate cũng trả `null`: client đọc JSON dở dang mà coi là "không có daemon" thì nó khởi **daemon thứ hai** cho cùng workspace — đúng kết cục temp+fsync+rename tồn tại để chặn
  - [`daemon-discovery.test.ts`](../../../../tests/adapter/daemon-discovery.test.ts) 13 test trên filesystem thật trong temp directory: mode `0600`/`0700` thật, **khoá đúng tám field** (không secret/attachment/lease), không sót file `.tmp`, và ca daemon cũ xoá nhầm record daemon mới
  - _Requirements: R2.13_ — _Design: §5.5, §6.2_
- [x] I.2 `DaemonClient` trong `packages/adapter/src/daemon/**`
  - Là **thư mục mới trong `@vidcom/adapter`**, không phải package npm mới: `packages/adapter` chỉ có một entry `exports: "./src/index.ts"`, nên `adapter/daemon` là cách đặt tên trong Design chứ không phải subpath export. Đừng tạo `packages/adapter/src/daemon/package.json`
  - Bề mặt **đóng**: `handshake`, `attach`/`renew`/`detach`, `invokeTool(name, payload)`. MUST NOT có `request(method, path, body)` tuỳ ý (DR-6) — một khi có, bridge biến thành HTTP proxy và mọi luật allowlist thành trang trí
  - Người dùng: `cli` — cả `render` (J.3) và composition root của bridge (I.2b). **`mcp` MUST NOT import nó**, xem I.2b
  - [`daemon-client.ts`](../../../../packages/adapter/src/daemon/daemon-client.ts) — đúng năm method, và test **liệt kê khoá của object** để bề mặt mở rộng sẽ lộ ra tại đó chứ không lộ khi ai đó dùng nó
  - **Không retry mù, và lý do phải viết ra**: mọi route trừ handshake đều đổi trạng thái daemon. Request timeout **có thể đã được áp dụng**, nên retry mù biến một attachment thành hai, hoặc một tool call thành hai side effect
  - Deadline cho mọi call: daemon nhận socket rồi treo là ca hỏng mà không có deadline thì không bao giờ trả lời
  - Giữ **mã lỗi của daemon** thay vì suy từ status: status không phân biệt được "bearer sai" với "workspace thuộc instance khác", mà hai cái đó đòi caller phản ứng ngược nhau
  - Handshake kiểm identity **ở cả phía client**: daemon có thể đã restart giữa lúc đọc discovery và lúc gọi, và nó trả lời rất vui vẻ như chính nó. Client mới là bên biết nó định gọi instance nào
  - Tên tool được `encodeURIComponent`: một tool không tồn tại phải quay về là **tool không tồn tại**, không phải một request được route đi chỗ khác
  - _Requirements: R2.2_ — _Design: §5.0, §7.0_
- [x] I.2b **Seam `ToolInvoker`: interface ở `mcp`, hiện thực remote ở `cli`** — đọc kỹ, đây là chỗ bản trước của checklist sai và làm CI đỏ ngay task này
  - **Luật**: `mcp` **bị cấm** import `adapter` — [steering/02](../../../steering/02-project-layout.md) §2 luật 3, và §2.1 giải thích vì sao `worker` được mà `mcp` không. Cưỡng chế ở **hai** chỗ (steering §2.2): ESLint block `packages/mcp/**` trong [`eslint.config.mjs`](../../../../eslint.config.mjs), và [`scripts/verify-import-boundaries.mjs`](../../../../scripts/verify-import-boundaries.mjs) với `throw "MCP must not import sibling infrastructure"`
  - Gate thứ hai phân giải package theo **prefix đường dẫn**, nên `packages/adapter/src/daemon/**` cũng là `@vidcom/adapter` — `adapter/daemon` **không** thoát được luật, kể cả qua import tương đối hay dynamic `import()`. Nó quét mọi file `.ts/.tsx/.js/.mjs/.json` dưới `packages/`
  - **Quyết định (đã duyệt cùng Approval Gate)**: `mcp` giữ nguyên trạng thái không-có-infrastructure như hôm nay ([`packages/mcp/package.json`](../../../../packages/mcp/package.json) khai đúng 5 dep: hai gói SDK, `@vidcom/contracts`, `@vidcom/core`, `zod`). Cụ thể:
    - `interface ToolInvoker` ở [`packages/mcp/src/registry/types.ts`](../../../../packages/mcp/src/registry/types.ts) — chữ ký khớp [`ToolRegistry.invoke`](../../../../packages/mcp/src/registry/registry.ts) đang có: `invoke(name, raw, request): Promise<ToolInvocation>`
    - `createRemoteToolInvoker(client: DaemonClient): ToolInvoker` ở `packages/cli/src/bridge/remote-tool-invoker.ts`
    - Chỗ nối: [`commands/mcp.ts`](../../../../packages/cli/src/commands/mcp.ts) `openListener`, ngay cạnh `createMcpRegistry(infrastructure, application)` đang gọi — `cli` là package duy nhất khai **cả** `@vidcom/adapter` và `@vidcom/mcp`
  - **MUST NOT**: nới bất kỳ gate nào; thêm `@vidcom/adapter` vào `packages/mcp/package.json`; đặt `DaemonClient` vào `core` để "lách" (`core` bị cấm `node:*` — sẽ đỏ ở một fixture khác của cùng gate)
  - Nếu phải sửa luật này, sửa **cả ba** chỗ cùng lúc (steering §2 bảng + `eslint.config.mjs` + gate script) theo đúng steering §2.2. Sửa một chỗ tạo ra `lint` xanh mà `test:boundaries` đỏ — đó chính là tình trạng đã tồn tại trong repo tới 2026-08-07 và là lý do Design bản 2 viết sai chỗ đặt `DaemonClient`
  - _Requirements: R2.2, R2.3_ — _Design: §5.0 hệ quả 4, §5.7, §16 C-1_
- [x] I.2c Test ranh giới, để hình dạng sai không quay lại
  - `tests/cli/remote-tool-invoker.test.ts`: invoker remote thoả cùng contract như local (dùng lại harness của I.10)
  - Fixture ranh giới: một file giả dưới `packages/mcp/` import `@vidcom/adapter` **phải** bị `assertPackageImportAllowed` từ chối — thêm vào mảng `packageBoundaryFixtures` đang có nếu chưa đủ chặt cho dynamic `import()`
  - `rtk bun run test:boundaries` vào AC của phase, không phải chạy cho vui
  - [`remote-tool-invoker.test.ts`](../../../../tests/cli/remote-tool-invoker.test.ts) 5 test: invoker remote trả **đúng hình dạng `Result`** mà registry trả — thay thế được cho nhau chính là toàn bộ điểm của seam; forward `protocolVersion`; giữ mã lỗi daemon; lỗi lạ thành `daemon_unavailable`; và đọc thẳng `packages/mcp/src/registry/types.ts` + `packages/mcp/package.json` để một lần dời code sang `mcp` hỏng thành **test đỏ** chứ không thành pipeline đỏ
  - Thêm **một** fixture vào `packageBoundaryFixtures`: import **tương đối** từ `packages/mcp/` sang `adapter/src/daemon/**`. Đó là cách người ta thử sau khi bare specifier bị từ chối, và `adapter/daemon` là thư mục bên trong `@vidcom/adapter` chứ không phải package riêng — cùng một import đội mũ khác. `git diff` script chỉ có **9 dòng thêm, 0 dòng xoá**: siết, không nới
  - _Requirements: R2.2_ — _Design: §5.0 hệ quả 4_
- [x] I.3 Handshake
  - So canonical root **và** instance id; PID/port sống không đủ. Mismatch ⇒ 409 `daemon_identity_mismatch`, không tiếp tục call
  - [`bridge.ts`](../../../../packages/server/src/routes/bridge.ts) so cả hai **trước** mọi việc khác. PID sống trên port sống chỉ chứng minh *có thứ gì đó* đang nghe — sau một lần restart thứ đang nghe là một daemon khác, và nó sẽ trả lời mọi call sau đó rất thuyết phục
  - `/bridge/v1/ready` trả `leaseHeld`, và discovery validate bằng nó chứ không bằng `/v1/health`: tiến trình sống và trả lời được trong khi **không giữ lease nào**, client attach vào đó nhận một daemon không ghi được
  - **Chỉ credential bridge hệ thống** qua được: credential MCP của người dùng là bearer hợp lệ cho `/api/mcp`, nhận nó ở đây là trao quyền điều khiển vòng đời daemon cho bất kỳ agent nào đã cấu hình
  - _Requirements: R2.13_ — _Design: §7.8_
- [x] I.4 Attachment lease
  - Heartbeat 5 s, TTL 20 s, deadline 5 s, grace 60 s. Id random 256-bit bound credential+instance. Attach/renew so `credentialId` với `app_settings.bridge_credential_id`
  - [`attachments.ts`](../../../../packages/server/src/bridge/attachments.ts) theo đúng mẫu `packages/server/src/auth/**` đang có: state trong memory, `ClockPort` inject, random inject để test đọc được
  - `renew`/`detach` so **cả** `credentialId` **và** `instanceId`: id là thứ duy nhất client trình ra và nó mang đi được, nên thiếu kiểm tra này thì một id cũ replay vào daemon vừa restart sẽ giữ sống attachment cho một client đã biến mất từ lâu
  - _Requirements: R2.15_ — _Design: §4.4, §7.9_
- [x] I.5 `activeWorkHold` suy từ job store
  - Job non-terminal thuộc workspace ⇒ hold còn; không heartbeat, không biến mất khi client thoát
  - Registry nhận `hasActiveWork()` chứ không tự đếm: đây **đúng là** chỗ bản trước tự mâu thuẫn — `--detach` cho CLI thoát ngay, attachment của nó hết hạn sau 20 s, và một refcount chỉ đếm attachment sẽ tắt daemon **giữa lúc render**
  - _Requirements: R2.15_ — _Design: §4.4_
- [x] I.6 Luật `autoStarted`
  - Chỉ daemon `serve --ensure` được auto-shutdown; `app`/`serve` tay thì **không bao giờ**; từng nhận attachment `kind: "ui"` ⇒ mất quyền tự tắt **vĩnh viễn**. State trong memory, MUST NOT vào discovery record
  - "Vĩnh viễn" chứ không phải "trong lúc còn attach": cửa sổ UI đóng một nhịp lúc đổi workspace không được biến thành lý do để daemon biến mất
  - Grace period tính từ lúc daemon **bắt đầu rỗi**, không phải từ lúc bị hỏi: caller chỉ hỏi một lần sẽ không bao giờ thấy period trôi qua. Test chốt cả biên `-1`/`0` và ca có người quay lại giữa chừng
  - [`attachments.test.ts`](../../../../tests/server/attachments.test.ts) 11 test cho cả I.4/I.5/I.6
  - _Requirements: R2.15_ — _Design: §4.4_
- [x] I.7a `createMcpRegistry` nhận `ToolInvoker`
  - Sửa [`composition-root.ts`](../../../../packages/cli/src/composition-root.ts) để registry được dựng quanh một invoker thay vì nối cứng vào `application`. `ToolDefinition` vẫn là nguồn duy nhất cho schema/list/era — invoker chỉ đổi **chỗ thực thi**
  - Đường local (stdio hôm nay, `vidcom app`) MUST giữ nguyên hành vi: đây là refactor, không phải tính năng
  - Seam đặt ở `registerRegistryTools`/`createServerFactory`/`createMcpHttpHandlers`, **mặc định là chính registry**. Đó là chỗ đúng: registry vẫn phát `list`/schema/era, chỉ chỗ **thực thi** đổi. Đổi ở tầng registry sẽ tạo ra hai catalogue mà không cách nào biết cái nào đúng
  - Bằng chứng hành vi không đổi: `test:mcp-contract` 71/71, `test:golden` 40/40, `test:mcp-catalogue` xanh — **snapshot `tools/list` không đổi một byte**
  - _Requirements: R2.2, R2.3_ — _Design: §5.7_
- [x] I.7b Route `/api/bridge/v1/tools/:name` phía daemon
  - Validate bằng catalogue của A.4 (`server` không được import `mcp`), rồi thực thi qua invoker local do composition root inject
  - Tên tool không có trong catalogue ⇒ lỗi có mã, MUST NOT chuyển tiếp xuống Core
  - Dùng `TOOL_SCHEMA_CATALOGUE` của `@vidcom/contracts` — `server` **không** import `mcp`, boundary giữ nguyên. Test chốt cả hai vế: tên lạ trả 404 **và** invoker **không được gọi lần nào**. Chuyển tiếp một tên lạ là để bridge chạm tới bất kỳ thứ gì daemon tình cờ đăng ký, tức allowlist chỉ còn cái tên
  - _Requirements: R2.3, R2.11_ — _Design: §7.10, §5.0 hệ quả 1_
- [x] I.7c Bridge forward danh tính, daemon sở hữu audit
  - Forward `protocolVersion`, credential id, attachment id, actor=`agent`. Audit **ghi ở daemon**, không ở bridge — bridge chết giữa lời gọi thì audit vẫn phải đúng
  - Route đọc `credentialId` từ chính perimeter rồi truyền xuống invoker; nó **không tự tạo** danh tính nào. Audit do `ToolRegistry` của daemon ghi (actor `agent` đã cố định ở đó), nên bridge chết giữa lời gọi không mang theo bản ghi của lời gọi
  - [`bridge-routes.test.ts`](../../../../tests/server/bridge-routes.test.ts) 14 test trên `createServerApp` thật, gồm cả hai ca từ chối bearer và ca forward danh tính
  - _Requirements: R2.9_ — _Design: §5.7, DR-6_
- [x] I.8 Auto-start + race
  - `ensure` spawn `serve --ensure` khi cần; kẻ thua race lease **chuyển thành client**, không throw rồi chết. Daemon sinh theo đường này MUST NOT mở browser
  - [`ensure-daemon.ts`](../../../../packages/cli/src/bridge/ensure-daemon.ts): đọc record → handshake → attach; hỏng ở bất kỳ bước nào thì **khởi một daemon** rồi nhìn lại
  - **Kẻ thua race là client, không phải lỗi**: hai client cùng thấy không có record và cùng khởi daemon; đúng một cái thắng lease, cái kia thoát. Client đã khởi cái thua **vẫn muốn một daemon, và đang có một** — nên spawn hỏng đi tiếp bằng cách nhìn lại, chỉ lần nhìn thứ hai rỗng mới là lỗi
  - Giữ nguyên lý do spawn hỏng để báo cáo nói đúng **lỗi thật** thay vì "không thấy daemon nào xuất hiện"
  - Record sống lâu hơn tiến trình nó mô tả là ca riêng: record trông hoàn toàn hợp lệ, chỉ handshake mới phát hiện ra
  - `kind` attach không phải nhãn: nó quyết định daemon có bao giờ được tự tắt không, nên test chốt nó được truyền đúng
  - [`spawn-daemon.ts`](../../../../packages/cli/src/bridge/spawn-daemon.ts) sau khi J.2 có `serve`: child chạy `serve --ensure --workspace <root>`. **`--ensure` là thứ duy nhất cho phép một daemon tự tắt**, và thứ **vắng mặt** cũng là nội dung — không có cờ mở browser: daemon sinh ra vì một agent cần nó MUST NOT mở cửa sổ trên màn hình người khác
  - Child `detached` + `stdio: "ignore"`: client thoát trước daemon rất lâu, và một child dùng chung stdio sẽ ghi vào pipe không ai đọc — mà khi caller là bridge thì pipe đó **chính là** stream JSON-RPC
  - `waitForDaemonRecord` poll **file**, không theo dõi child của chính mình: thua race lease nghĩa là daemon của người khác publish, và một watcher trên tiến trình con của ta sẽ không bao giờ thấy điều đó
  - [`bridge-attachment.test.ts`](../../../../tests/cli/bridge-attachment.test.ts) 7 test
  - _Requirements: R2.4, R2.10, R2.15_ — _Design: §5.6_
- [x] I.9 `stdout` của bridge chỉ JSON-RPC
  - Mọi log/cảnh báo/tiến trình qua `stderr` hoặc log store; test bắt được một dòng lạc
  - Hai lớp, bắt hai thứ khác nhau: [`mcp-stdio-host.test.ts`](../../../../tests/e2e/mcp-stdio-host.test.ts) đã chốt stdout sạch **lúc chạy** trên child thật; test mới quét source `packages/cli/src/bridge/**` và cấm `console.log/info/debug` cùng `process.stdout` — bắt dòng lạc **trước khi nó được viết ra**, chỗ rẻ nhất
  - Một dòng lạc không làm phiên tệ đi, nó làm agent host **hết parse được stream**: phiên chết chứ không phải phiên kém
  - _Requirements: R2.6_ — _Design: §5.8_
- [x] I.10 Contract parity test local ↔ remote
  - Cùng input ⇒ cùng schema, cùng revision, cùng mã lỗi
  - _Requirements: R2.3_
- [x] I.11 Integration test
  - Port bị chiếm bởi app khác ⇒ handshake từ chối · record stale ⇒ rediscovery có giới hạn · daemon biến mất giữa phiên ⇒ lỗi có mã, **không treo**, không trả kết quả giả
  - Hai bridge auto-start đồng thời ⇒ kẻ thua nối vào kẻ thắng · bridge cuối detach chỉ tắt daemon auto
  - [`bridge-integration.test.ts`](../../../../tests/cli/bridge-integration.test.ts) 6 test trên **listener loopback thật** + `createServerApp` thật + discovery store trên **filesystem thật** trong temp directory
  - **Test này tìm ra một bug thật của I.1, không phải bug giả định**: tên file temp trong `publish` lấy theo `instanceId`, nên hai lần publish cùng record dùng chung một đường dẫn — cái thua `wx` **xoá đúng file cái thắng đang ghi**, cả hai hỏng, và không record nào được publish. Kết cục: một workspace có daemon sống mà không ai tìm thấy. Đã đổi sang `randomUUID()` và thêm regression test publish đồng thời vào [`daemon-discovery.test.ts`](../../../../tests/adapter/daemon-discovery.test.ts)
  - Ca "port thuộc về app khác" dựng bằng **một daemon thật thứ hai** đang nghe: nó trả lời, và nếu không có kiểm identity thì client sẽ coi thứ trả lời đó là daemon của mình
  - Ca "daemon biến mất giữa phiên" đóng listener thật rồi gọi tiếp: trả `daemon_unavailable`, **không treo**, không kết quả giả
  - Stub lease trong test là cờ **atomic**, không phải read-then-write: read-then-write cho phép cả hai caller tin mình thắng, đúng kết cục mà lease thật không thể tạo ra
  - _Requirements: R2.7, R2.10, R2.13, R2.15_
- [x] I.12 Integration test: agent ghi qua bridge ⇒ UI nhận event
  - Đường watcher/event outbox Phase 1 còn nguyên tác dụng, không cần reload
  - [`bridge-events.test.ts`](../../../../tests/cli/bridge-events.test.ts) chạy trên **daemon thật của J.2**: copy `projects/swiss-grid` vào workspace tạm, exchange nonce lấy session UI, **mở SSE trước**, rồi agent gọi `save_file` qua `/api/bridge/v1/tools/**` bằng chính bearer daemon tự mint lúc boot. Stream đang mở nhận được thay đổi — không reload
  - Ghi qua bridge vẫn bị **optimistic concurrency** như mọi đường ghi khác: bridge không được hợp đồng yếu hơn đường local
  - Cùng test chốt luôn AC destructive: `delete_file` qua bridge **hỏng** thay vì tự duyệt. Bridge không elicit được — đầu kia của một pipe JSON-RPC không có ai để hỏi — nên "không dùng được" là cách hỏng an toàn duy nhất, và file vẫn còn nguyên sau đó
  - _Requirements: R2.8_

**Acceptance Criteria**:
- [x] Mở app rồi chạy Codex ⇒ **cả hai dùng được**, vẫn đúng một writer — một daemon, session UI và bearer bridge cùng phục vụ được, ghi vẫn đi qua đúng một foundation
- [x] Tool destructive vẫn cần approval do con người phát hành — `delete_file` qua bridge hỏng, file còn nguyên
- [x] `rtk bun run test:boundaries` xanh, và [`packages/mcp/package.json`](../../../../packages/mcp/package.json) **vẫn đúng 5 dependency** như trước phase (`@modelcontextprotocol/core`, `@modelcontextprotocol/server`, `@vidcom/contracts`, `@vidcom/core`, `zod`) — đây là cách kiểm C-1 không lặng lẽ trôi ngược
- [x] `git diff scripts/verify-import-boundaries.mjs` không có dòng nào **nới** luật (thêm fixture thì được)

**Deliverables**: `packages/adapter/src/daemon/**` · `packages/adapter/src/fs/daemon-discovery.ts` · `packages/cli/src/bridge/remote-tool-invoker.ts` · `packages/mcp/src/registry/types.ts` (chỉ thêm interface) · `packages/server/src/routes/bridge.ts`

---

## Phase J: CLI mode + doctor

**Addresses**: R3.1–R3.13 · **Design**: §5.8, §5.9, §7.12–§7.14
**Files affected**: `packages/cli/src/main.ts`, `packages/cli/src/commands/{serve,render,doctor,version}.ts`, `packages/core/src/service/doctor.ts`
**Prerequisite**: **D và I, cả hai** — D vì `doctor` kiểm toolchain đã giải nén (J.5b), I vì `render` là thin client của `DaemonClient` (I.2). Đồ hình Dependency Order ở đầu file từng thiếu cạnh `I ─→ J`; nó đã được sửa
**Estimate**: 13 SP

**Tasks**:
- [x] J.1 Mode dispatcher
  - Union công khai `app | serve | mcp | render | doctor | version | approve | credential | backup | recovery`. **Không** `worker` (OQ-9); `packages/worker` giữ nguyên, không xoá
  - Mode không tồn tại ⇒ liệt kê mode hợp lệ, exit ≠ 0
  - `VIDCOM_COMMAND_NAMES` export ra thành **một danh sách có thứ tự**, để D.3b sau này đếm entrypoint từ chính union này thay vì từ một bản chép tay
  - Đổi hành vi có chủ ý: message `unknown command` giờ liệt kê đủ mười mode. [`mcp-commands.test.ts`](../../../../tests/cli/mcp-commands.test.ts) ghim chuỗi cũ nên đã cập nhật — đây là hành vi J.1 yêu cầu, **không phải** snapshot sửa cho khớp code
  - _Requirements: R3.1, R3.11_ — _Design: §5.8_
- [x] J.2 `serve` và `app`
  - `serve` headless, in địa chỉ qua `stderr`/log; `app` = `serve` + mở browser + token một lần
  - [`serve.ts`](../../../../packages/cli/src/commands/serve.ts): một listener, một workspace, một discovery record. Router của E chia `/api/*` cho app đã compose và phần còn lại cho static host của H.3 — **cùng một port**, tức cùng origin, tức UI đóng gói giữ được cookie `SameSite=Strict` mà không cần cấu hình cross-origin nào
  - **`app` không còn spawn `next start`**: frontend là static export nên không có Next server nào để spawn. `app` giờ đúng bằng `serve` cộng hai thứ — mở browser và mint nonce một lần. Đây là chỗ đóng cửa sổ hồi quy mà G.6 mở ra
  - Record publish **sau khi** mọi thứ phía sau đã trả lời được, và xoá **trước khi** nhả lease: record xuất hiện sớm chỉ client tới một daemon sắp từ chối họ, record ở lại muộn chỉ client tới hư vô
  - `stop()` chạy **đúng một lần** dù bao nhiêu caller: signal handler và đường lỗi cùng gọi nó, và teardown hai lần là nhả một lease tiến trình này không còn giữ
  - Địa chỉ in ra `stderr`: `stdout` thuộc về thứ mà caller pipe vào, và một daemon in banner ở đó làm hỏng ngay lần dùng đầu tiên
  - Nguồn static tự phân giải: asset nhúng khi là SEA, `dist/sea/**` khi checkout đã chạy `build:artifact`, còn lại trả **503 nói rõ chạy lệnh gì**. Trang trắng đọc như app hỏng
  - [`serve.test.ts`](../../../../tests/cli/serve.test.ts) 8 test trên SQLite thật + filesystem thật trong temp directory
  - _Requirements: R3.2, R1.10_ — _Design: §5.8_
- [x] J.3 `render` thin client
  - Phân biệt id/slug bằng `^project_[0-9a-f-]{36}$`, MUST NOT thử id rồi fallback slug. Thứ tự workspace: explicit(`--workspace`|`VIDCOM_WORKSPACE`) > **`cwd` có marker** > `active_workspace` > `cwd` không marker (nhánh cuối **bị cấm** cho render ⇒ exit 2)
  - Mặc định chờ job xong; `--detach` in jobId; `Ctrl+C` lần đầu cancel, lần hai exit 130; exit `0/1/2/130`; idempotency key **ngẫu nhiên mỗi invocation**
  - Gọi daemon qua `DaemonClient` của **I.2** — đây là lý do J có tiền đề I. MUST NOT tự dựng client HTTP thứ hai
  - Help của `--workspace` nói rõ nó **không** đổi workspace mặc định của UI (hệ quả của C.4). Đây là chỗ thực thi câu đó, vì `commands/render.ts` được tạo ở task này
  - [`render.ts`](../../../../packages/cli/src/commands/render.ts) + [`render-connect.ts`](../../../../packages/cli/src/commands/render-connect.ts). Ba method render nằm trong **cùng bề mặt đóng** của `DaemonClient`; slug→id đi qua `invokeTool("list_projects")` chứ không phải một endpoint mới. Không có client HTTP thứ hai nào
  - Nhánh `cwd` (thư mục hiện tại không có gì đánh dấu là workspace) bị **từ chối trước khi chạm tới daemon**: với UI đó là chỗ hợp lý để bắt đầu tìm, với render nó ghi output vào đúng thư mục người dùng tình cờ đang đứng
  - `render-connect` **không đọc `active_workspace`**: render không ghi lại nó (C.4), nên đọc nó sẽ làm lệnh phụ thuộc vào trạng thái UI mà chính nó từ chối thay đổi
  - Attach dạng **`render`**, không phải `ui`: một lần render không được lấy đi quyền tự tắt của daemon auto-start sau khi render xong. Và `detach` chạy trong `finally` kể cả khi render hỏng — attachment bỏ lại giữ daemon sống thêm trọn TTL sau khi client cần nó đã biến mất
  - Ctrl+C lần đầu **cancel rồi vẫn chờ**: render đang huỷ vẫn còn file phải dọn và một dòng job phải kết thúc, nên exit code phải lấy từ thứ daemon thực sự ghi lại. Lần hai dừng chờ — người bấm hai lần đang bảo *tiến trình này* biến đi, không phải daemon
  - [`render-command.test.ts`](../../../../tests/cli/render-command.test.ts) 22 test
  - _Requirements: R3.3, R1.5_ — _Design: §7.13_
- [x] J.4 `version`
  - VidCom version, HyperFrames version, build commit, platform tag, runtime manifest version
  - Trường nào source checkout không biết thì trả **`null`** (human: `not packaged`), không phải một giá trị trông hợp lý. Output này tồn tại để trả lời "bản build nào đây" trong một bug report, và một version đoán bừa **tệ hơn một chỗ trống**: nó đẩy người đọc sang đúng một release khác
  - Test chốt `VIDCOM_VERSION` khớp `packages/cli/package.json` — hai chỗ cùng nói một số thì lệch phải lộ ở đây chứ không lộ trong bug report
  - _Requirements: R3.4_ — _Design: §7.14_
- [x] J.5a Khung `DoctorCheck` + thứ tự deterministic
  - `DoctorCheck`/`DoctorReport` theo §5.9; `run` trả `Result<DoctorItem, DomainError>` ([steering/03](../../../steering/03-architecture-ddd.md) §2.2, Design §5.0 hệ quả 2). Thứ tự đăng ký **cố định**, không phụ thuộc thứ tự import — golden test J.9 chốt nó
  - `gpu.cuda` **không** có trong bảng: stack chỉ có `onnxruntime` CPU nên nó không bao giờ `ok` được, và một mục vĩnh viễn không `ok` dạy người dùng bỏ qua doctor
  - [`doctor.ts`](../../../../packages/core/src/service/doctor.ts) giữ `DOCTOR_CHECK_ORDER` **cố định trong core**, không lấy theo thứ tự đăng ký — thứ tự đăng ký chạy theo thứ tự import, và không ai điều khiển thứ tự import. Golden J.9 ghim đúng danh sách này
  - Không dừng ở check hỏng đầu tiên: người chạy `doctor` muốn toàn cảnh, dừng sớm biến một install hỏng thành đúng bấy nhiêu lần chạy như số vấn đề nó có
  - Check tự ném lỗi thành một item `broken` chứ không làm mất cả report vì một unhandled rejection
  - `missing` và `broken` tách bạch: *không có gì ở đó* cần re-extract, *có mà sai* cần điều tra — gộp lại thì mọi remedy thành phỏng đoán
  - _Requirements: R3.5_ — _Design: §5.9_
- [x] J.5b 11 check nguồn **artifact** (required, không có `skipped`)
  - `app-data.writable`, `db.migration`, `runtime.manifest`, `runtime.integrity` (`skipped` khi không `--deep`), `runtime.ffmpeg`, `runtime.esbuild-binary`, `compiler.probe`, `runtime.hyperframes`, `runtime.motion`, `runtime.python`, `runtime.python-utf8`
  - `runtime.python` dùng `importlib.metadata`, **không cần pip** (pip đã bị gỡ khỏi stack, −12 MB); `compiler.probe` chạy `transformSync` **qua `CompilerGuard`** trong timeout, nếu không thì check này chính là chỗ treo vĩnh viễn; `runtime.python-utf8` in một chuỗi tiếng Việt qua interpreter đã ship rồi đọc lại
  - _Requirements: R3.5, R3.6_ — _Design: §5.9_
- [x] J.5c 6 check nguồn **tải-về / máy / người dùng**
  - `chrome.cache`, `tts.model-cache`, `workspace.active`, `port.available` (required) · `settings.file`, `tts.elevenlabs` (optional)
  - `chrome.cache` **thực thi** `chrome-headless-shell --version` với timeout rồi so version với manifest. MUST NOT hỏi `hyperframes browser path` — S9 đo được: Chrome cắt còn 1 MB thì CLI vẫn trả đường dẫn và **exit 0**. Dùng lại helper resolve+probe của G.0, MUST NOT viết đường thứ hai
  - `settings.file` MUST NOT in nội dung file; nếu khai `runtime.caBundlePath` thì kiểm file đó tồn tại/đọc được
  - [`doctor-checks.ts`](../../../../packages/cli/src/commands/doctor-checks.ts) nhận probe qua inject, nên **mọi nhánh hỏng đều chạy được trong test** — mà nhánh hỏng chính là lý do `doctor` tồn tại
  - [`doctor-context.ts`](../../../../packages/cli/src/commands/doctor-context.ts) nối probe thật: chạy binary rồi tin thứ nó in ra, không chỉ kiểm tồn tại. `runtime.python-utf8` in chuỗi tiếng Việt qua interpreter đã ship **rồi đọc lại** — lỗi cần bắt là output méo, không phải exit code khác 0
  - _Requirements: R3.5, R3.6, R3.12_ — _Design: §5.9_
- [x] J.6 `skipped` có nguồn sự thật
  - `chrome.cache`/`tts.model-cache` từ bảng `job`; `workspace.active` từ `app_settings`. `VIDCOM_DOCTOR_STRICT=1` ⇒ `skipped` trên mục required tính như `missing`
  - _Requirements: R3.12_ — _Design: §5.9_
- [x] J.7 Exit code + `--json` + redaction
  - Required không `ok` ⇒ ≠ 0; optional không `ok` ⇒ vẫn 0; `--json` stdout chỉ một `DoctorReport`, human output `stderr`; redact token/API key/credential/absolute path của máy build
  - _Requirements: R3.7, R3.8, R3.10_ — _Design: §7.12_
- [x] J.8 `--repair`
  - Chỉ extraction/runtime component; giải nén vào temp rồi swap, hoặc **từ chối** kèm hướng dẫn khi daemon đang giữ file (Windows khoá file đang mở). MUST NOT ghi đè in-place
  - Credential file mất ⇒ **mint mới**, không phải khôi phục
  - [`doctor-repair.ts`](../../../../packages/cli/src/commands/doctor-repair.ts): chỉ 9 check runtime nằm trong `REPAIRABLE_CHECKS`; `settings.file` và phần còn lại thuộc về người dùng, sửa hộ là sửa thứ không ai nhờ
  - **Từ chối khi daemon còn sống không phải là thận trọng**: trên Windows daemon giữ đúng những file mà repair phải thay, nên swap hỏng giữa chừng để lại một cây không phải bản cũ cũng không phải bản mới. Bảo người dùng dừng app trước tốn một bước và tránh được đúng trạng thái đó
  - Report được **dựng lại từ kết quả repair** chứ không vá tại chỗ: một lần repair thành công một nửa phải hiện ra đúng như hiện tại, không phải một hỗn hợp trước-và-sau
  - _Requirements: R3.9, R3.13_ — _Design: §5.9, §4.4_
- [x] J.9 Golden test `doctor --json`
  - Payload ổn định; thứ tự check deterministic
  - [`doctor-report.test.ts`](../../../../tests/golden/doctor-report.test.ts) **viết cả payload ra**, không suy từ code sinh ra nó — suy lại thì test chỉ chứng minh code bằng chính nó. Đổi thứ tự, đổi tên id hay đổi vocabulary status đều hiện thành một diff phải giải thích
  - _Requirements: R3.8_
- [x] J.10 Integration test
  - Từng check fail độc lập ⇒ exit code đúng; `--repair` khi daemon sống ⇒ swap hoặc từ chối, không để lại trạng thái nửa vời
  - [`doctor-integration.test.ts`](../../../../tests/cli/doctor-integration.test.ts) chạy trên app-data thật + SQLite thật, và dựng **daemon thật của J.2** cho ca repair: daemon sống ⇒ từ chối kèm `instanceId`; daemon đã dừng ⇒ cho phép. "Đã dừng" quan sát được chứ không đoán theo thời gian, vì daemon xoá record **trước khi** nhả lease
  - **Bug thật do test này bắt**: `db.migration` chỉ chạy `foreign_key_check`, mà check đó hài lòng với một database rỗng — nên nó gọi một install **chưa migrate** là khoẻ mạnh, đúng cái install mà mọi probe sau đó đọc từ bảng không tồn tại. Đã kiểm schema trước. Cùng lúc, đọc `app_settings` được bọc lại: `doctor` là lệnh người ta chạy **khi install đang hỏng**, nên từng probe phải sống sót qua ca hỏng
  - _Requirements: R3.9, R3.13_

**Acceptance Criteria**:
- [x] `doctor` nói được **cái gì thiếu và sửa thế nào** cho mọi mục không `ok` — test quét toàn bộ item và đòi mọi mục không `ok`/`skipped` đều có `remedy`
- [x] MCP stdout vẫn sạch sau khi thêm mode mới — `test:mcp-contract` 71/71 và e2e stdio host giữ nguyên sau khi thêm bốn mode

**Deliverables**: `packages/cli/src/commands/**` · `packages/core/src/service/doctor.ts`

---

## Phase K: Import project

**Addresses**: R7.1–R7.12 · **Design**: §4.7, §5.19, §6.4, §7.15
**Files affected**: `packages/core/src/usecase/project-import.ts`, `packages/adapter/src/fs/import-staging.ts`, `packages/server/src/routes/projects.ts`
**Prerequisite**: E
**Estimate**: 8 SP

**Tasks**:
- [x] K.1 `ProjectImportService.plan/execute`
  - Bind source canonical identity + target absence + digest; execute recheck trước copy. Trả `Result<T, DomainError>`
  - [`project-import.ts`](../../../../packages/core/src/usecase/project-import.ts) là logic thuần: plan buộc identity nguồn, tên đích còn trống và phán quyết overlap vào cùng một chỗ; `assertSourceUnchanged` chạy **trước** copy vì giữa lúc plan và lúc copy người ta có thể move hoặc thay nguồn — và copy thứ đang nằm ở đường dẫn đó là kết cục tệ nhất có thể
  - Identity là `dev:ino:ctimeMs` chứ không phải đường dẫn: một path có thể bị trỏ sang thứ khác mà vẫn là **cùng một chuỗi**. `ctimeMs` không phải trang trí — **Linux trả lại ngay inode vừa giải phóng**, nên xoá một thư mục rồi tạo thư mục khác cùng chỗ cho ra **cùng `dev:ino`**; đo được trên CI Linux chứ không phải suy đoán
  - So sánh phân biệt hoa thường là **tham số**, không phải `process.platform`: gate boundary cấm `core` chạm `process`, và đoán sai thì hoặc từ chối một import hợp lệ hoặc cho qua một import đệ quy
  - _Requirements: R7.1, R7.3_ — _Design: §5.19_
- [x] K.2 Staging cùng filesystem
  - `<workspace>/.<slug>.vidcom-import-<operation>.tmp` để rename cuối là atomic; marker operation id. IF temp ở thiết bị khác THEN `rename` fail — MUST NOT dùng temp của OS vô điều kiện
  - [`import-staging.ts`](../../../../packages/adapter/src/fs/import-staging.ts); `EXDEV` được map thành lỗi **nói thẳng vấn đề là cấu trúc**, không phải thứ để retry
  - _Requirements: R7.6, R7.12_ — _Design: §4.7_
- [x] K.3 Luật copy
  - Chỉ regular file/dir; bỏ `node_modules/.git/.hyperframes`; **từ chối symlink** (luật tường minh của R7.11). Source chỉ đọc, không sửa metadata
  - Symlink **từ chối**, không follow cũng không bỏ qua: follow thì copy dữ liệu từ ngoài nguồn, bỏ qua thì lặng lẽ tạo ra một project thiếu thứ bản gốc có. Ba thư mục kia thì bỏ qua **mà không fail** — chúng dựng lại được, và fail vì chúng sẽ từ chối gần như mọi project thật
  - Test chốt bản gốc **không đổi** bằng digest cây trước và sau
  - _Requirements: R7.2, R7.11_ — _Design: §5.19_
- [x] K.4 Chặn overlap trước khi copy
  - Source nằm trong workspace, là cha của workspace, hoặc trùng workspace ⇒ từ chối **sau khi canonicalize, trước khi copy** — đây là chỗ sinh copy đệ quy vô hạn
  - So theo **segment** chứ không theo prefix chuỗi: `/work/videos-archive` không nằm trong `/work/videos`, mà prefix test nói là có
  - _Requirements: R7.10_ — _Design: §4.7_
- [x] K.5 Backfill dùng lại `bootstrapProject`
  - Không có đường serialize identity thứ hai. `ProjectId` trùng ⇒ cấp id mới, ghi lại `vidcom.json`, log sự kiện
  - Import **không** viết đường ghi identity nào: cây đã copy xong là một project directory bình thường, và `bootstrapProject` đã xử lý đúng ca `ProjectId` trùng — cấp id mới, ghi lại `vidcom.json`, ghi journal. Thêm một đường serialize thứ hai ở đây là tạo chỗ để hai đường lệch nhau
  - _Requirements: R7.5, R7.7_ — _Design: §5.19_
- [x] K.6 `POST /v1/projects/imports` trả **202 `{jobId}`**
  - Route production host cấp `startProjectImport`, enqueue một job `project-import` cấp workspace với `projectId: null`, và `createJobTypes` chạy đúng worker đã stage/copy/publish/backfill. `workspace_operation` vẫn là journal phục hồi filesystem; nó không thay thế job mà client poll qua `/api/v1/jobs/:jobId`
  - `Job`/`NewJob` phản ánh schema SQLite vốn đã nullable; event project-scoped không phát cho job cấp workspace. Application lock + lookup `(NULL, type, key)` đóng khoảng trống unique-index của SQLite
  - Test production host thật đi `exchange → token → POST 202 → poll succeeded`, kiểm cây đích có identity, nguồn không đổi, và request lặp sau success trả conflict. Focused matrix 51/51 xanh trên SQLite/filesystem thật
  - Token không chỉ peek path: `device/inode` đã mint phải khớp source hiện tại trước plan, rồi worker recheck identity đầy đủ trước copy
  - Request `{sourceToken, targetName?}` — token từ browser, **không** raw path. Idempotency khoá ở **application layer** theo `(workspaceRoot, sourceCanonicalIdentity, targetName)`: `uniqueIndex("uq_job_idempotency")` scope theo `(project_id, type, key)` mà `project_id` **NULL** tới khi xong, và SQLite coi mọi NULL là khác nhau
  - Ba thành phần khoá nối bằng **NUL**: nối bằng thứ mà path chứa được thì hai request khác nhau dựng ra cùng một material
  - _Requirements: R7.1, R7.8_ — _Design: §7.15_
- [x] K.7 Recovery lúc startup
  - Hoàn tất hoặc xoá theo `workspace_operation`; MUST NOT quét/xoá thư mục không có marker
  - Test dựng một thư mục **trông y hệt staging nhưng không có marker** và chốt recovery không chạm vào nó: một thư mục trông như tạm có thể là thứ ai đó tự tạo, xoá nó là code đang đoán
  - _Requirements: R7.6_ — _Design: §4.7_
- [x] K.8 Logic test
  - Import plan; phát hiện overlap; đặt tên khi trùng slug
  - _Requirements: R7.4, R7.10_
- [x] K.9 Integration test trên fs thật
  - Kill sau begin/copy/validate/rename ⇒ recovery ra project committed hoặc abort sạch, **bản gốc không đổi**
  - Gọi hai lần cùng khoá ⇒ **cùng jobId**, không tạo job thứ hai
  - EXDEV, Windows file lock, symlink — kiểm ở OS hỗ trợ
  - _Requirements: R7.2, R7.6, R7.12_
- [x] K.10 Test với **3 project mẫu trong `projects/`** của repo
  - _Requirements: R7.9_

**Acceptance Criteria**:
- [x] Thất bại không để lại thư mục rác trong workspace — test chốt workspace rỗng sau một import hỏng vì symlink
- [x] Bản gốc không bị sửa ở bất kỳ nhánh nào — digest cây nguồn trước/sau bằng nhau, kể cả ở nhánh commit

**Deliverables**: `packages/core/src/usecase/project-import.ts` · `packages/adapter/src/fs/import-staging.ts`

---

## Phase L: Hygiene & provenance

**Addresses**: R9.1–R9.7 · **Design**: §5.20, §9.2, §9.4
**Files affected**: `scripts/build-artifact.mjs`, `scripts/verify-artifact.mjs`, `scripts/verify-spec-test-paths.mjs` (L.6), `tests/build/**` (thư mục mới)
**Prerequisite**: H · L.6 nên làm **sau cùng trong phase**, xem lý do ở chính task đó
**Estimate**: 5 SP

**Tasks**:
- [x] L.1 Build fail theo điều kiện
  - Lockfile/tool version khác manifest · archive có entry ngoài allowlist · sourcemap/source rời · secret pattern · absolute root của máy build
  - [`verify-artifact.mjs`](../../../../scripts/verify-artifact.mjs) quét bundle CJS, manifest và pack; thư mục artifact chỉ được chứa **bốn** tên trong allowlist — một `.map` hay `.ts` nằm cạnh executable là cùng một rò rỉ với thứ nhúng bên trong, mà lại dễ bỏ sót hơn
  - Trả **mọi** hit chứ không phải hit đầu tiên: một build rò hai thứ nên nói một lần, không phải qua hai lần chạy
  - **Bắt được lỗi thật ngay lần chạy đầu**: bundle chứa **11 đường dẫn tuyệt đối của máy build**, do bundle sang CJS resolve mọi `import.meta.url` thành file URL tuyệt đối của module nguồn. Hai lý do phải bỏ: L.1 cấm thẳng, và một `createRequire` neo vào thư mục người dùng không có thì resolve vào hư vô. `stripBuildRoot` thay gốc bằng marker cố định `/vidcom`, và test chốt bundle không còn chứa `process.cwd()`
  - **Đóng ở Phase L**: `buildToolProvenance()` so **pin đã khai với bản thật đang cài** cho `tar`, và đòi `postject` ghim **đúng một version**. Ghi lại version không đủ: một `tar` resolve ra bản khác pin sẽ viết archive không ai review, còn `postject` khác bản sẽ sửa định dạng executable theo cách khác — cả hai đều cho ra artifact **trông y hệt** bản release nó tự nhận. Bun được **ghi lại chứ không so**, vì nó là toolchain chứ không phải dependency nên không có dòng lockfile nào để đối chiếu; nói bản nào đã build vẫn hơn không nói gì
  - _Requirements: R9.1, R9.2, R9.3_ — _Design: §5.20_
- [x] L.2 `SHA256SUMS` + `artifact-manifest.json`
  - Commit, `dirty=false` cho release job, tool versions, archive hashes, platform
  - `dirty` được **ghi lại**, không phải bị từ chối ở đây: người dựng cục bộ từ cây đã sửa nên nhận artifact kèm một cái nhãn trung thực, còn job release mới là chỗ đòi `false`
  - `SHA256SUMS` viết theo định dạng `sha256sum -c` để người dùng kiểm bằng công cụ họ đã có, không phải công cụ ta bảo họ cài
  - Chạy thật: manifest + checksums sinh ra cạnh artifact 127 MB
  - **Đóng ở Phase L**: manifest mang thêm `tools` (tar/postject/bun), và `verify-artifact --release` từ chối cây bẩn cùng commit `unknown`. Hai ca tách nhau có lý do: người dựng cục bộ từ cây đã sửa nhận artifact **kèm nhãn trung thực**, còn một bản release không gọi tên được commit nó sinh ra từ đâu thì không phải bản release
  - _Requirements: R9.4_ — _Design: §5.20_
- [x] L.3 macOS ad-hoc sign sau injection
  - Windows unsigned + checksum; signing thật deferred (D2)
  - Đã hiện thực ở **H.4** vì không có nó thì không có gì để kiểm chứng: Mach-O arm64 không chữ ký hợp lệ bị kernel giết lúc launch. `tests/build/sea.test.ts` ghim thứ tự remove-signature → inject → sign
  - _Requirements: R9.5_ — _Design: §5.20_
- [x] L.4 Tắt telemetry HyperFrames trong runtime đã giải nén
  - Xác nhận ở S9: lời mời telemetry hiện ngay lần chạy đầu với `HOME` sạch. Ghi quyết định vào release notes
  - `HYPERFRAMES_NO_TELEMETRY=1` và `DO_NOT_TRACK=1` đặt trong `allowlistedEnvironment`, tức **mọi** child đều nhận. Hai tên **đọc ra từ chính `hyperframes/dist/cli.js` đã pin**, không phải đoán — một biến môi trường không ai đọc là một thiết lập không làm gì mà trông như có làm; test ghim luôn việc CLI thật sự đọc hai tên đó
  - Lý do là sản phẩm chứ không phải sở thích: app đóng gói không được hỏi một câu **thay mặt** một công cụ mà người dùng chưa bao giờ chọn cài
  - _Requirements: R9.7_ — _Design: §5.20_
- [x] L.5 Test scan
  - Source/sourcemap/dev-origin/secret/build-root; frontend pack không chứa `localhost:3000`
  - [`artifact-provenance.test.ts`](../../../../tests/build/artifact-provenance.test.ts) 12 test; ca pack thật **tự build static export nếu thiếu**, vì job CI chạy test **trước** production build và một check bị skip là check không ai để ý lúc nó biến mất
  - _Requirements: R9.1, R9.2, R9.3_
- [x] L.6 **Đăng ký spec này vào [`scripts/verify-spec-test-paths.mjs`](../../../../scripts/verify-spec-test-paths.mjs)**
  - Gate hôm nay chỉ biết **hai** spec (`spec-mcp-server` phases `ABCDEFGHIJKLMNOP`, `spec-project-delivery-loop` phases `ABCDEFGHIJKLMNOPQRS`). Convention của repo là mọi checklist đều được gate này bảo vệ; không đăng ký thì bảng Phase Verification Matrix ở trên có thể trỏ vào file không tồn tại mà CI vẫn xanh
  - Thêm entry `{ label: "packaging & distribution", path: "llm-documents/…-implementation-checklist.md", phases: "ABCDEFGHIJKLM" }`
  - **Làm ở cuối, có lý do**: gate kiểm **mọi** đường dẫn `tests/...` trong Matrix phải tồn tại thật. Đăng ký ở Phase A thì `test:spec-paths` đỏ suốt từ B tới M
  - Chạy `rtk bun run test:spec-paths` và đọc số nó in ra — nếu số path verified không tăng thì entry chưa được đọc (sai `path` hoặc sai tên section)
  - Lưu ý khi đọc số: gate cắt section bằng hai heading nên **khối `> [!WARNING]` ở đầu Matrix cũng bị quét**, tức `tests/frontend/` và `tests/build/` nằm trong tập path được kiểm. Đó là ý muốn (hai thư mục đó phải tồn tại thật), không phải nhiễu
  - Nếu có phase nào bị bỏ giữa đường, sửa chuỗi `phases` **cùng lúc**: gate so khớp chuỗi đúng thứ tự và fail với `"rows drifted"`
  - Đã đăng ký `phases: "ABCDEFGHIJKLM"`; số path verified **80 → 115** trên 3 spec, đúng dấu hiệu entry được đọc
  - **Gate bắt được drift tài liệu ngay lần chạy đầu**: hàng D trỏ `tests/adapter/vidcom-node-shim.test.ts` và hàng E trỏ `tests/cli/foundation-manager.test.ts` — **cả hai chưa bao giờ tồn tại**; tên thật là `node-sentinel.test.ts` và `foundation-lifecycle.test.ts`/`foundation-state.test.ts`. Sửa bảng cho khớp code, **không** nới gate: đây đúng là quy trình mà chính task này mô tả
  - Chạy lại sau cùng khi L.1–L.5 đã xanh: `test:spec-paths` **115 path trên 3 spec**, giữ nguyên con số đã đạt
  - _Requirements: R9.1_ — _Design: §5.20_

**Acceptance Criteria**:
- [x] Không secret, không sourcemap, không absolute path máy build trong artifact — `verify-artifact` chạy trên **production artifact thật** (322 MB, darwin-arm64) và xanh: quét bundle CJS, SEA main, frontend manifest + pack, mọi runtime scan target, và **final executable**, cộng allowlist đúng ba tên cạnh artifact
- [x] `rtk bun run test:spec-paths` xanh **và** số path verified tăng so với trước L.6 — chạy lại sau cùng khi L.1–L.5 đã xanh: **115 path trên 3 spec** (từ 80 trước khi đăng ký)

**Deliverables**: `scripts/build-artifact.mjs` · `scripts/verify-artifact.mjs` · `scripts/verify-spec-test-paths.mjs`

---

## Phase M: Packaged smoke ba nền tảng

**Addresses**: R8.1–R8.8 · **Design**: §4.8, §11.4
**Files affected**: `.github/workflows/packaged-smoke.yml`, `scripts/packaged-smoke/*`, `package.json` (script `test:packaged-smoke`)
**Prerequisite**: tất cả
**Estimate**: 21 SP

**Tasks**:
- [x] M.0 Script `test:packaged-smoke` + runner cục bộ — **đủ 13 thân bước đã chạy xanh trên artifact native ba OS**
  - Thêm `"test:packaged-smoke": "node scripts/packaged-smoke/run.mjs"` vào [`package.json`](../../../../package.json). Chạy được **trên máy dev** chứ không chỉ trong Actions — nếu chỉ chạy được trong CI thì mỗi lần sửa một bước phải push, và không ai sửa nữa
  - Nhận `--step <id>` để chạy một bước, `--from <id>` để chạy tiếp từ giữa; mặc định chạy đủ 13 bước theo thứ tự §11.4
  - Mỗi bước in `id`, thời gian, kết quả ở `stderr`; `stdout` chỉ để bằng chứng JSON (M.6). Bước fail ⇒ exit ≠ 0 **kèm id của bước**, MUST NOT chỉ báo "smoke failed"
  - Bước bị bỏ ⇒ đánh dấu `skipped` **và** làm job đỏ khi `VIDCOM_DOCTOR_STRICT=1` (M.5) — AC của phase này là "không step bắt buộc nào bị skip", nên trạng thái đó phải quan sát được, không phải suy từ log
  - [`scripts/packaged-smoke/`](../../../../scripts/packaged-smoke/run.mjs): danh sách bước là **dữ liệu**, nên `--step`/`--from` có nghĩa chính xác và một bước `skipped` là **giá trị kiểm được**, không phải một dòng log ai đó phải đọc
  - **Correction đã đóng**: wording ban đầu nói 12 trong khi §11.4 liệt kê 13; task và runner nay cùng ghi/chạy đủ 13 theo Design
  - Chạy được trên máy dev, đã kiểm: `--step build` trả đúng một dòng, `--strict` exit `1` với lý do "chưa có artifact" thay vì im lặng
  - **Evidence**: run `31337022177` chạy đủ 13/13 trên ba artifact native; không có step bắt buộc `skipped`
  - _Requirements: R8.3, R8.7_ — _Design: §11.4_
- [x] M.1 Job native theo OS — **exact head `0fdbd35` xanh macOS/Linux/Windows**
  - macOS arm64, Windows x64, Linux x64; **không job nào dùng artifact build từ OS khác**. Mỗi lần chạy ghi lại nền tảng đã kiểm
  - [`packaged-smoke.yml`](../../../../.github/workflows/packaged-smoke.yml) dựng artifact **trên chính runner** rồi mới chạy smoke, `fail-fast: false` để một nền tảng hỏng không che mất kết quả hai nền tảng kia — biết nền tảng nào đã được chứng minh là toàn bộ mục đích của job này
  - Workflow hỗ trợ `workflow_dispatch` và exact-head PR closeout; checkout ghim `pull_request.head.sha`, không dùng synthetic merge SHA
  - _Requirements: R8.1, R8.5_ — _Design: §4.8, DR-11_
- [x] M.2 Môi trường sạch
  - `node` **không** trên PATH; **không** `node_modules` ở `cwd` hay thư mục cha; `HOME` sạch. Cache tải-về (`$HOME/.cache/hyperframes`, `HF_HOME`) **được** mồi; app-data/runtime **không** được mồi
  - [`environment.mjs`](../../../../scripts/packaged-smoke/environment.mjs) đưa **PATH rỗng hoàn toàn** — một thư mục trống là mục duy nhất trên đó. Lọc PATH theo tên thư mục là cách làm đầu tiên và nó **sai**: `/opt/homebrew/bin` chứa `node` mà không chứa chữ nào bộ lọc tìm. Lời hứa đang kiểm là executable tự mang runtime, và cách duy nhất phát biểu điều đó là không để gì trên PATH
  - Bước `clean-environment` **hỏi runner** bằng `which`/`where` chứ không tin cấu hình: nếu `node` còn với tới được thì cả smoke đang đo toolchain của runner
  - `HOME` được **chuyển hướng** chứ không xoá: artifact ghi cache ở đâu đó, và trỏ chỗ đó vào thư mục tạm là thứ làm cho "artifact không để lại gì" **kiểm được** thay vì được giả định
  - Cache tải-về mồi sẵn, app-data để rỗng — R8.2 nói về máy sạch, không phải máy không có mạng
  - **Bằng chứng**: bước xanh trên artifact thật — `no node, python or bun on PATH; working directory empty`
  - _Requirements: R8.2, R8.8_ — _Design: §11.4_
- [x] M.3a Bước 1–3: nhận dạng + cold/warm doctor
  - `version` → cold `doctor --repair` → warm `doctor --deep`. Đây là ba bước duy nhất không cần listener, nên chúng cũng là chỗ đo cold start thật cho M.7
  - **Số runner exact head `0fdbd35`**: serve cold/warm darwin `813/611 ms`, Linux `1007/1004 ms`, Windows `2637/2461 ms`; doctor cold/warm lần lượt `15673/3294`, `23974/6201`, `133284/11883 ms`
  - `version` phải biết runtime manifest: bản đóng gói trả `null` là bug thật, chính bước này bắt được (đã sửa — đọc manifest nhúng)
  - **Ba mục được phép thiếu ở bước 3, có lý do**: `db.migration`, `chrome.cache`, `tts.model-cache`. Strict biến skip thành missing — đúng cho cả job (R8.4) và **sai ở đây**: chưa tải browser nào, chưa dùng model nào, và chưa có database vì chưa chọn workspace. Các bước sau mới là chỗ chúng phải `ok`; cho phép ở bước lạnh không phải khẳng định yếu hơn mà là **chuyển khẳng định tới chỗ nó có nghĩa**
  - _Requirements: R8.3, R4.9_ — _Design: §11.4, §9.1_
- [x] M.3b Bước 4–6: vòng đời UI + import + bridge song song
  - start + nonce/session + picker + create project → import project → bridge nối vào **trong lúc UI còn sống**
  - Bước 6 là chỗ duy nhất chứng minh lời hứa "mở app rồi chạy Codex, cả hai dùng được, vẫn đúng một writer" trên artifact thật
  - _Requirements: R8.3, R2.15_ — _Design: §11.4, §4.4_
- [x] M.3c Bước 7–9: giá trị lõi — ra được MP4 có tiếng
  - TTS → snapshot → render + `ffprobe` xác minh (có audio stream, đúng thời lượng) → upload 20 MB + SSE → `render` wait/detach/cancel
  - Đây là nhóm bước mà **cả Phase D tồn tại để phục vụ**. Nếu chỉ chạy được một nhóm bước, chạy nhóm này
  - _Requirements: R8.3, R6.1, R4.6_ — _Design: §11.4_
- [x] M.3d Bước 10–12: chế độ hỏng
  - **Cắt mạng ở tầng runner** rồi warm offline (M.4) → lease loss **hai nhánh** (UI hạ về `NoWorkspace`; headless đóng listener + exit ≠ 0) → scan checksum/provenance
  - _Requirements: R8.3, R8.8, R2.14, R9.4_ — _Design: §11.4, §4.3_
- [x] M.4 Bước offline chặn ở **tầng mạng runner**
  - Đo ở S9: `HTTPS_PROXY`/`HTTP_PROXY` **bị lờ** — downloader vẫn tải 202 MB qua proxy chết. Viết bằng env thì bước này xanh vì lý do sai
  - _Requirements: R8.8, R6.5_ — _Design: §5.18_
- [x] M.5 Cache theo version + fail khi thiếu thành phần bắt buộc
  - `VIDCOM_DOCTOR_STRICT=1`; thành phần bắt buộc vắng mặt ⇒ **fail**, MUST NOT skip
  - _Requirements: R8.4, R8.8_ — _Design: §5.9_
- [x] M.6 Upload bằng chứng
  - DoctorReport, artifact manifest, `SHA256SUMS`, kết quả ffprobe, platform metadata
  - _Requirements: R8.3_ — _Design: §9.4_
- [x] M.7 Chốt lại hai trần còn tạm
  - Cold thật trên phần cứng runner đã trả lời câu hỏi trần tạm: Linux nặng hơn darwin ~24 % (595 so với 481 MB) nhưng serve/doctor cold vẫn dư địa lớn dưới 120 s
  - Evidence Linux `1007/1004 ms`, doctor cold `23974 ms`, toàn job `10m12s`; giữ 120 s vì còn dư địa lớn. Windows `2637/2461 ms`, doctor cold `133284 ms`; giữ 180 s. Ba baseline v1 commit theo runner và bắt hồi quy 1,5×
  - _Requirements: R4.9, R8.3_ — _Design: §9.1, §5.13_
- [x] M.8 Ghi lại bằng chứng TTS Windows
  - Máy phát triển bị N-1 (TLS inspection) chặn; runner CI không có ⇒ đây là **bằng chứng đầu tiên**, MUST NOT suy từ darwin
  - Windows exact artifact tạo WAV online + offline với `providerId=vieneu`, `voiceId=vieneu-v3-minh-duc`, rồi mux H.264/AAC MP4 8 giây ở cả hai nhánh
  - _Requirements: R6.1, R8.3_ — _Design: §5.13_
- [x] M.9 Thời gian job trong giới hạn CI
  - Hoặc tách job riêng có điều kiện rõ ràng; MUST NOT làm CI thường xuyên đỏ vì timeout
  - Run `31337022177`: macOS `7m10s`, Linux `10m12s`, Windows `21m30s`, đều thấp hơn `timeout-minutes: 90`
  - _Requirements: R8.7_

**Acceptance Criteria**:
- [x] Không step bắt buộc nào bị skip
- [x] Job Linux hiện diện và xanh; không dùng CI thiếu Linux để suy ra release claim (R8.5)

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

2026-08-08 — Phase H, Task H.1 (preflight, CHƯA tick)
  - Files: `scripts/build-cli-bundle.mjs`, `tests/build/cli-bundle.test.ts`
  - Summary: Phân giải bundler và cổng chặn top-level await. Nửa emit bundle chưa làm được vì cần runtime archive đã giải nén trên đĩa.
  - Decisions: Lấy `esbuild` từ runtime archive B.3 thay vì `node_modules`. Luật 6 loại hai đường kia — không có bundler nào được khai dependency, và bản duy nhất trên đĩa là transitive ở **hai version khác nhau**, nên hoisted copy vừa không khai vừa nhập nhằng. Đường này thêm 0 dependency và làm compiler build artifact **chính là** compiler artifact chạy. Chặn top-level await trước khi esbuild thấy: SEA nhận CJS main và esbuild từ chối TLA ở format `cjs`, nên build hỏng đằng nào cũng hỏng — chỉ ra file và số dòng biến lỗi mù thành lỗi sửa được. Quét theo độ sâu ngoặc để `await` trong hàm và biến tên `awaited` không bị bắt nhầm.
  - Blockers: **H.2/H.4/H.6/H.8 chặn bởi dữ liệu, không phải quyết định.** `build-runtime-archives.mjs` đòi `--config <file>` pin `node`/`hyperframes`/`esbuild`/`ffmpeg`/`cpython`/`vieneu`/`motion` cộng `pythonPackages` từng platform và `archives` ba OS — file đó **không tồn tại trong repo**. B.3 chứng minh builder đúng và deterministic bằng smoke config; thứ thiếu là binary phát hành thật + hash pin, tức tài sản phát hành chứ không suy được từ code. MUST NOT bịa hash: sẽ ra artifact trông như build thật nhưng ship version không ai duyệt. 9 test mới xanh; typecheck, ESLint, `test:boundaries` xanh; CI `ad7b868` xanh cả ba OS.

2026-08-09 — Phase H, Task H.1 (gỡ chặn bundler)
  - Files: `scripts/build-cli-bundle.mjs`, `tests/build/cli-bundle.test.ts`, Design §16 (C-7), checklist và implementation notes
  - Summary: Bundler đổi sang `bun build --target=node --format=cjs`; script emit `dist/sea/main.cjs` thật, chặn TLA trên source entry, và test build thật rồi load bundle bằng Node ở thư mục tạm không có `node_modules`.
  - Decisions: Bỏ đường "esbuild từ runtime archive" vì nó chặn H.1 sau một tài sản phát hành chưa tồn tại — config pin version/hash ba OS cho `build-runtime-archives.mjs` không có trong repo, và MUST NOT bịa hash. Bun không phải dependency mới: nó đã là toolchain bắt buộc, `package.json` và lockfile không đổi một dòng, nên luật 6 giữ nguyên. Phase 0 loại Bun ở vai trò **runtime**; đây là vai trò build-time và output vẫn là CJS chạy dưới Node. Ghi thành C-7 trong Design §16 thay vì sửa DR-1 đã duyệt. Ba helper `esbuild*` cũ của script bị xoá vì chỉ test của chính nó dùng; `CompilerGuard` (D.4) vẫn sở hữu `ESBUILD_BINARY_PATH`/`ESBUILD_WORKER_THREADS` lúc chạy.
  - Blockers: Không có cho H.1. `tests/build/cli-bundle.test.ts` 9/9 xanh (bundle 5581 module, 14,23 MB, load được ngoài mọi `node_modules`); typecheck, `test:boundaries`, `git diff --check` xanh; `lint` 0 error / 3 warning **sau khi xoá `dist/`** — `dist/` gitignored nhưng không nằm trong ignore của ESLint, nên build cục bộ làm lint đỏ. Không nới ESLint, giữ tiền lệ Phase A. Runtime-archive config vẫn là blocker của H.2/H.4/H.6/H.8 ở phần cần binary phát hành thật.

2026-08-09 — Phase G, Task G.6 (lật static export)
  - Files: `next.config.ts`, `src/app/api/**` (xoá), `tests/frontend/next-export-config.test.ts`, `tests/server/next-routing.test.ts` (xoá), checklist và implementation notes
  - Summary: Bật `output: "export"`, xoá catch-all route handler, và chuyển bất biến "không còn route handler nào" sang test cấu hình export.
  - Decisions: Lật được vì H.1 đã có bundler thật — trước đó lật là tạo một build không ai phục vụ được. Xoá thay vì dời route: export fail trên mọi route handler chứ không riêng `force-dynamic`, và API vốn thuộc daemon (§5.11). Giữ `handleNextHostedRequest` trong `packages/cli` vì các suite server dùng nó làm harness. Xoá `tests/server/next-routing.test.ts` vì cả hai case chỉ mô tả bề mặt Next-hosted API; giữ lại là giữ hai chỗ nói cùng một thứ mà một chỗ đã sai.
  - Blockers: Cửa sổ hồi quy có chủ ý — source checkout không còn tự phục vụ API qua Next cho tới khi J.2 nối `serve`/`app` vào listener của E. `next build` xanh, sinh 57 file gồm cặp `projects/__shell.html` + `.txt` mà resolver H.3 map. Full suite 1223 pass / 4 skip, 0 "Unhandled Errors"; typecheck, lint 0 error, `test:boundaries` xanh.

2026-08-09 — Phase H, Task H.2
  - Files: `scripts/build-frontend-pack.mjs`, `scripts/build-artifact.mjs`, `tests/build/frontend-pack.test.ts`, `tests/build/build-artifact.test.ts`, checklist và implementation notes
  - Summary: Nối `out/` thành `frontend.pack` raw bytes cộng manifest `path/offset/length/sha256/mime/cachePolicy`; chạy thật ra 57 asset, 2.379.699 byte.
  - Decisions: `cachePolicy` và `mime` lấy từ chính `resolveAsset`/`mimeTypeFor` của H.3 thay vì khai lại trong script build — quyết hai lần là cách build và host lệch nhau, và bảng MIME đóng chỉ được có một bản. Hệ quả: bước pack trong `planSteps()` chạy dưới `bun` chứ không `node`, vì nó phải import thẳng module TypeScript đó; test ghim luôn `command === "bun"` kèm lý do. Đi bộ thư mục chỉ nhận regular file: symlink trong export nghĩa là pack trỏ ra ngoài chính nó.
  - Blockers: Không có; `tests/build` 22/22 xanh, gồm đọc lại từng asset tại offset trên filesystem thật, chốt không kẽ hở/chồng lấn, và hai lần build ra pack byte giống hệt. Typecheck, lint 0 error, `test:boundaries` xanh.

2026-08-09 — Phase H, Task H.3 (nửa còn lại)
  - Files: `packages/cli/src/sea-static-host.ts`, `tests/adapter/sea-static-host.test.ts`, checklist và implementation notes
  - Summary: Thêm `createSeaStaticAssetHost` đọc pack + manifest qua seam `getRawAsset`, phục vụ bằng subarray view, kiểm biên manifest lúc dựng, GET/HEAD only.
  - Decisions: Seam `SeaAssetSource` thay vì gọi thẳng `node:sea` để test chạy được ngoài executable. Header cache đọc lại từ manifest — giá trị đó do H.2 lấy từ chính resolver này, nên không phải quyết định thứ hai. `requestPath` cắt chuỗi thay vì `new URL` vì `//projects/x` bị đọc thành authority.
  - Blockers: Không có. **Phát hiện ngược trực giác, đã ghi thành test**: ở tầng `Request`, cả `..` lẫn `%2e%2e` đều bị WHATWG URL resolve lúc parse, nên host không bao giờ thấy traversal; không có gì thoát ra vì pack không có thư mục và mọi key chạm tới đều là asset đã publish. Resolver vẫn giữ nguyên từ chối cho caller raw-path (`node:http`). 23/23 test file này, golden 26/26, `tests/build` 22/22; typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase H, Task H.4
  - Files: `scripts/build-sea.mjs`, `tests/build/sea.test.ts`, checklist và implementation notes
  - Summary: Dựng SEA native thật trên darwin-arm64 — blob, copy Node đang chạy, remove signature, postject, ad-hoc sign — ra `dist/artifact/darwin-arm64/vidcom` 127 MB chạy được trong thư mục tạm rỗng, không sinh file nào cạnh nó.
  - Decisions: `postject@1.0.0-alpha.6` ghim và gọi qua package runner; nó là công cụ build, không dòng nào trong sản phẩm import nó, nên `package.json`/lockfile không đổi. Hai bước `codesign` nằm trong H.4 chứ không đợi L.3 vì Mach-O arm64 không chữ ký bị kernel giết lúc launch — không có chúng thì không có gì để kiểm chứng. Test giữ ở mức logic: build thật tốn 127 MB và cần mạng cho `bunx`, nên nó thuộc packaged smoke của M.
  - Blockers: **`build:artifact` toàn chuỗi vẫn chưa chạy được**: bước 1 (`build-runtime-archives.mjs`) đòi config pin version + hash ba OS chưa có trong repo, và bước cuối `verify-artifact.mjs` là L.1 chưa viết. Bốn bước giữa (export, pack, bundle, sea) đã chạy tay liên tiếp và ra artifact thật. `tests/build` 30/30, typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase G, G.6 CI remediation (run 31283969261)
  - Files: `scripts/runtime-smoke-host.mjs`, `scripts/verify-next-runtime.mjs`, `.github/workflows/ci.yml`, checklist và implementation notes
  - Summary: Exact SHA `6ee93ba` đỏ **cả ba OS** ở đúng một step — `test:runtime-smoke` khởi `next start`, mà `"next start" does not work with "output: export" configuration`. Đổi host của smoke sang chính listener daemon.
  - Decisions: Không skip step, không disable job, không nới gate. Mọi khẳng định của smoke — nonce exchange, session cookie, project list, MCP legacy + modern exact/latest, credential audit, SSE `Last-Event-ID` resume — đều thuộc **API của daemon**; `next start` chỉ là process chứa nó. `runtime-smoke-host.mjs` bind `handleNextHostedRequest` qua `bindLoopback` của E. Bỏ probe `GET /` (frontend giờ là file tĩnh, không thuộc process này): readiness đọc dòng `listening` trên stdout, nên một route trả lời là việc của khẳng định kế tiếp chứ không che mất bên nào hỏng. Đổi tên step CI cho khớp thực tế.
  - Verification: `dd515c7` xanh **cả ba OS** (run 31284935464) — G.6 và loạt task I đầu tiên đi qua CI đầy đủ.
  - Blockers: Bun **không host được** cái này — `No such built-in module: node:sqlite`, mà SQLite là nền của cả stack. Chạy dưới Node với loader `tsx@4.23.1` đã là direct dependency của `packages/cli`, đúng cách các suite MCP đang làm. Smoke xanh cục bộ: `SSE 1 -> 2`, MCP legacy + modern ok. Chờ CI exact HEAD ba OS.

2026-08-09 — Lệch thứ tự phase, ghi lại để không trôi
  - Files: checklist (H.6, H.8), implementation notes
  - Summary: H.1–H.4 xong; H.6 và H.8 **phụ thuộc ngược vào J.2**, nên Phase H không đóng được theo thứ tự A→M như viết.
  - Decisions: H.6 đo hai flow `serve --workspace` và `app` — đều là mode của J.1/J.2 chưa tồn tại; H.8 cần artifact **mở listener**, cũng J.2. Đây là vòng phụ thuộc trong chính checklist, không phải phạm vi bị nới. Đi tiếp I rồi J, sau J.2 quay lại đóng H.6/H.8 cùng phần cold cần runtime archive thật. Không tick sớm và không đo thay bằng một flow khác: baseline cho thứ không ai chạy còn tệ hơn không có baseline.
  - Blockers: H.6 chặn kép — J.2 **và** config runtime archive (cột cold phải extract thật). H.8 chặn bởi J.2; nửa "chạy trong cwd rỗng, không sinh file cạnh artifact" đã kiểm tay ở H.4.

2026-08-09 — Phase I, Task I.1
  - Files: `packages/adapter/src/fs/daemon-discovery.ts`, `packages/adapter/src/index.ts`, `tests/adapter/daemon-discovery.test.ts`, checklist và implementation notes
  - Summary: Thêm discovery store atomic temp+fsync+rename, đặt tên file theo hash workspace, `remove` so `instanceId`.
  - Decisions: Dùng lại nguyên `secureAppDataDirectorySync`/`secureCredentialFile` của credential store thay vì dựng đường ACL Windows thứ hai. `read` validate đủ tám field chứ không chỉ `JSON.parse`: một record sai workspace sẽ chỉ client tới daemon khác và mọi kiểm tra sau đó đều pass vì nó nói chuyện với tiến trình thật. Ghi truncate trả `null` — client coi là "không có daemon" rồi khởi daemon thứ hai, đúng kết cục rename tồn tại để chặn.
  - Blockers: Không có; 13/13 test trên filesystem thật (mode `0600`/`0700` thật, đúng tám field, không sót `.tmp`), typecheck, lint 0 error, `test:boundaries` xanh.

2026-08-09 — Phase I, Task I.2
  - Files: `packages/adapter/src/daemon/daemon-client.ts`, `packages/adapter/src/index.ts`, `tests/adapter/daemon-client.test.ts`, checklist và implementation notes
  - Summary: `DaemonClient` bề mặt đóng năm method — handshake, attach, renew, detach, invokeTool — có deadline, không retry mù, giữ mã lỗi của daemon.
  - Decisions: Không có `request(method, path, body)` (DR-6), và test **liệt kê khoá object** để bề mặt phình ra lộ ngay tại đó. Không retry vì mọi route trừ handshake đổi trạng thái daemon và một request timeout có thể đã được áp dụng. Handshake kiểm identity ở cả phía client vì daemon có thể restart giữa lúc đọc discovery và lúc gọi. `encodeURIComponent` tên tool để một tool không tồn tại quay về đúng là không tồn tại chứ không thành request route đi chỗ khác.
  - Blockers: Không có; 11/11 test, typecheck, lint 0 error, `test:boundaries` xanh. Thư mục `packages/adapter/src/daemon/` không có `package.json` riêng — nó là cách đặt tên trong Design, không phải subpath export.

2026-08-09 — Phase I, Task I.2b + I.2c
  - Files: `packages/mcp/src/registry/types.ts`, `packages/cli/src/bridge/remote-tool-invoker.ts`, `packages/cli/src/index.ts`, `scripts/verify-import-boundaries.mjs`, `tests/cli/remote-tool-invoker.test.ts`, checklist và implementation notes
  - Summary: `interface ToolInvoker` ở `mcp`, `createRemoteToolInvoker` ở `cli`; thêm một fixture ranh giới cho import tương đối sang `adapter/src/daemon/**`.
  - Decisions: `mcp` giữ nguyên 5 dependency, không thêm `@vidcom/adapter`. Invoker giữ **mã lỗi của daemon** thay vì gộp về một lỗi transport — gộp lại là xoá mất khác biệt giữa "tool từ chối input" và "daemon không trả lời", đúng hai thứ caller cần phân biệt nhất. Fixture mới chỉ thêm, không sửa dòng nào có sẵn của gate.
  - Blockers: Không có; 5/5 test, `test:boundaries` xanh với `git diff` 9 dòng thêm / 0 dòng xoá, typecheck và lint 0 error.

2026-08-09 — Phase I, Task I.4 + I.5 + I.6
  - Files: `packages/server/src/bridge/attachments.ts`, `packages/server/src/index.ts`, `tests/server/attachments.test.ts`, checklist và implementation notes
  - Summary: Attachment registry trong memory của daemon — heartbeat 5 s, TTL 20 s, grace 60 s, id 256-bit, cộng bốn điều kiện auto-shutdown.
  - Decisions: Đặt ở `packages/server/src/bridge/` theo đúng mẫu `auth/nonce.ts`/`auth/session.ts` (memory + `ClockPort` inject + random inject). `renew` so cả `credentialId` lẫn `instanceId` vì id mang đi được. `hasActiveWork()` được inject thay vì registry tự đếm — work hold suy từ job store là cách duy nhất đúng khi `--detach` cho CLI thoát ngay. Quyền tự tắt mất **vĩnh viễn** sau attachment `ui`. Grace period chạy từ lúc bắt đầu rỗi, không từ lúc bị hỏi.
  - Blockers: Không có; 11/11 test, typecheck, lint 0 error, boundaries xanh. Nối vào route và job store thật là I.7b/I.8.

2026-08-09 — Phase I, Task I.3 + I.7b + I.7c
  - Files: `packages/server/src/routes/bridge.ts`, `packages/server/src/app.ts`, `packages/server/src/index.ts`, `tests/server/bridge-routes.test.ts`, checklist và implementation notes
  - Summary: Route bridge phía daemon — handshake, ready, attachments, tools — cắm vào chuỗi middleware cố định của `createServerApp`.
  - Decisions: Bridge dùng **bearer** như MCP chứ không dùng session trình duyệt (client là agent host), nhưng siết thêm: chỉ `app_settings.bridge_credential_id` qua được, vì credential MCP người dùng là bearer hợp lệ cho `/api/mcp` và nhận nó ở đây là trao quyền vòng đời daemon cho agent bất kỳ. Validate tên tool bằng `TOOL_SCHEMA_CATALOGUE` của `contracts` để `server` không phải import `mcp`. Renew một attachment đã hết hạn trả **404** chứ không 401: nó không phải vấn đề phân quyền, và "attach lại đi" là câu trả lời duy nhất dùng được. `DELETE` một attachment đã biến mất trả 204 vì đó đúng là trạng thái caller muốn.
  - Blockers: Không có; 14/14 test bridge, toàn `tests/server` 117/117, typecheck, lint 0 error, boundaries xanh. Nối invoker thật vào composition root là I.7a.

2026-08-09 — Phase I, Task I.7a + I.10
  - Files: `packages/mcp/src/server.ts`, `packages/mcp/src/http.ts`, `tests/mcp/bridge-registry-parity.test.ts`, checklist và implementation notes
  - Summary: Thêm `invoker` tuỳ chọn (mặc định là chính registry) xuyên qua `createMcpHttpHandlers` → `createServerFactory` → `registerRegistryTools`, cộng test parity local ↔ remote.
  - Decisions: Đặt seam ở tầng đăng ký tool chứ không ở registry: registry phải tiếp tục là nguồn duy nhất của `list`/schema/era, còn invoker chỉ đổi chỗ thực thi — đổi ở tầng registry là tạo hai catalogue không phân xử được. Stub daemon trong test **ném đúng `DaemonClientError`** với mã ổn định, vì stub dễ dãi hơn sẽ biến parity test thành test cho chính stub.
  - Blockers: Không có. Hành vi local không đổi: `test:mcp-contract` 71/71, `test:golden` 40/40, catalogue xanh, `tools/list` snapshot không đổi byte. `tests/mcp` 70/70, typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase I, Task I.8 (một phần)
  - Files: `packages/cli/src/bridge/ensure-daemon.ts`, `packages/cli/src/index.ts`, `tests/cli/bridge-attachment.test.ts`, checklist và implementation notes
  - Summary: Resolver `ensureDaemon` — dùng daemon đang phục vụ nếu có, khởi một cái nếu không, và coi kẻ thua race lease là client.
  - Decisions: Spawn hỏng **không** ném ngay mà nhìn lại record một lần nữa, vì mất race lease trông y hệt spawn hỏng và client đã khởi cái thua vẫn đang có một daemon để dùng. Giữ lý do spawn hỏng để lần nhìn thứ hai rỗng còn báo được lỗi thật. Mọi I/O đi qua seam inject nên test không cần tiến trình thật.
  - Blockers: `spawnDaemon` thật cần mode `serve --ensure` của **J.2**, gồm cả luật MUST NOT mở browser. 7/7 test, typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase I, Task I.9 + I.11
  - Files: `tests/cli/bridge-integration.test.ts`, `tests/cli/bridge-attachment.test.ts`, `packages/adapter/src/fs/daemon-discovery.ts`, `tests/adapter/daemon-discovery.test.ts`, checklist và implementation notes
  - Summary: Integration test bridge trên listener loopback thật + filesystem thật; thêm guard stdout cho `packages/cli/src/bridge/**`.
  - Decisions: **Sửa một bug thật do integration test tìm ra**: temp file của `publish` đặt tên theo `instanceId`, nên hai publish đồng thời dùng chung đường dẫn và cái thua `wx` xoá file cái thắng đang ghi — cả hai hỏng, không record nào tồn tại, workspace có daemon sống mà không ai tìm thấy. Đổi sang `randomUUID()` (đúng cách credential store đang làm) và thêm regression test. Stub lease trong test dùng cờ atomic vì read-then-write cho phép cả hai caller tin mình thắng, thứ lease thật không tạo ra được.
  - Blockers: Không có; `tests/cli` bridge 6/6 + 8/8, discovery 14/14, typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase J, Task J.1 + J.4
  - Files: `packages/cli/src/main.ts`, `packages/cli/src/commands/version.ts`, `packages/cli/src/index.ts`, `tests/cli/cli-modes.test.ts`, `tests/cli/mcp-commands.test.ts`, checklist và implementation notes
  - Summary: Mở union mode lên đủ mười, message lỗi liệt kê mode hợp lệ, và thêm `vidcom version` có `--json`.
  - Decisions: Không thêm mode `worker` (OQ-9). Message `unknown command` đổi để liệt kê mode — test cũ ghim chuỗi cũ đã cập nhật, đây là hành vi J.1 yêu cầu chứ không phải snapshot sửa cho khớp code. `version` trả `null`/`not packaged` cho thứ source checkout không biết thay vì giá trị trông hợp lý, vì một version đoán bừa đẩy bug report sang release khác.
  - Blockers: `serve`, `render`, `doctor` mới chỉ có trong union; thân lệnh là J.2/J.3/J.5. `tests/cli` + `tests/e2e` 151/151, typecheck, lint 0 error.

2026-08-09 — Phase J, Task J.2
  - Files: `packages/cli/src/commands/serve.ts`, `packages/cli/src/main.ts`, `packages/cli/src/next-host.ts`, `packages/server/src/routes/bridge.ts`, `packages/adapter/src/db/job-store.ts`, `packages/core/src/port/ports.ts`, `tests/cli/serve.test.ts`, `tests/server/bridge-routes.test.ts`, checklist và implementation notes
  - Summary: `serve` chạy in-process — listener loopback, router API/static, discovery record — và `app` trở thành `serve` + browser + nonce, không còn spawn `next start`.
  - Decisions: Cắm bridge vào chính runtime đã compose, `instanceId` mới mỗi lần start (daemon restart mà tái dùng id sẽ thoả một handshake dành cho tiến trình đã chết). Work hold đọc từ job store qua `hasNonTerminalJob` mới thay vì đếm attachment. `stop()` idempotent. Xoá `freePort`/`waitUntilReady` khỏi `main.ts` vì chính thay đổi này làm chúng thành mồ côi.
  - Blockers: Không có. **Bug thật do runtime smoke bắt**: sub-app bridge dùng `use("*")` mà lại mount ở gốc app API, nên nó đòi credential bridge hệ thống trên **mọi** request của sản phẩm — hiện ra thành 503 ở `/v1/projects`, không dính gì tới bridge. Không unit test nào bắt được vì app trong test không có route nào khác để hỏng. Đã siết về `/bridge/v1/*` và thêm regression test. Full suite 1352 pass / 4 skip, 0 unhandled; typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase I, Task I.12 + AC còn lại
  - Files: `packages/cli/src/commands/serve.ts`, `packages/cli/src/next-host.ts`, `packages/cli/src/bridge/spawn-daemon.ts`, `tests/cli/bridge-events.test.ts`, checklist và implementation notes
  - Summary: Agent ghi qua bridge tới được stream SSE đang mở, trên daemon thật; destructive vẫn hỏng thay vì tự duyệt.
  - Decisions: `startServing` reconcile credential bridge **trước khi** publish record và dưới cùng cái lock mà rotation dùng — advertise trước rồi mint sau tạo một cửa sổ mọi call bridge trả `bridge_credential_unavailable`. Test mở SSE **trước** khi agent ghi, đúng như UI thật đang mở. Giữ optimistic concurrency cho đường bridge: bridge không được hợp đồng yếu hơn đường local.
  - Blockers: Không có; test 1/1 trong 5,2 s trên SQLite thật + filesystem thật, typecheck, lint 0 error.

2026-08-09 — Phase J, Task J.3
  - Files: `packages/cli/src/commands/render.ts`, `packages/cli/src/commands/render-connect.ts`, `packages/cli/src/main.ts`, `packages/adapter/src/daemon/daemon-client.ts`, `tests/cli/render-command.test.ts`, `tests/adapter/daemon-client.test.ts`, checklist và implementation notes
  - Summary: `render` thin client — enqueue, chờ, huỷ — đi trọn vẹn qua `DaemonClient`, cộng luật workspace và exit code 0/1/2/130.
  - Decisions: Thêm `enqueueRender`/`getJob`/`cancelJob` vào **chính** bề mặt đóng của `DaemonClient` thay vì dựng client thứ hai (J.3 cấm), và cập nhật test khoá bề mặt lên tám method — luật vẫn nguyên: không có `request(method, path, body)`. Slug→id qua `invokeTool("list_projects")`, không thêm endpoint. Không đọc `active_workspace` vì render cũng không ghi nó. Attach dạng `render` để không lấy mất quyền tự tắt của daemon auto-start.
  - Blockers: Không có; 22/22 test render, `tests/cli` 186/186, full suite 1383 pass / 4 skip, typecheck, lint 0 error, boundaries xanh. CI `9b5b7b7` (J.2) xanh cả ba OS.

2026-08-09 — Phase J, Task J.5a–J.9 (doctor)
  - Files: `packages/core/src/service/doctor.ts`, `packages/cli/src/commands/doctor{,-checks,-context,-repair}.ts`, `packages/cli/src/main.ts`, `tests/cli/doctor.test.ts`, `tests/golden/doctor-report.test.ts`, `tests/adapter/compiler-timeout-audit.test.ts`, checklist và implementation notes
  - Summary: Khung `DoctorCheck` với thứ tự cố định trong core, 17 check (11 artifact + 6 máy/người dùng), `skipped` lấy từ job store và `app_settings`, exit code + `--json` + redaction, `--repair` giới hạn ở runtime, golden report viết tay.
  - Decisions: Thứ tự nằm ở `DOCTOR_CHECK_ORDER` trong core chứ không theo thứ tự đăng ký — đăng ký chạy theo import và không ai điều khiển import. Probe được inject nên mọi nhánh hỏng chạy được trong test. `missing` tách khỏi `broken` vì hai cái cần hai remedy khác nhau. Repair từ chối khi daemon còn sống: trên Windows daemon giữ đúng file mà repair phải thay. Golden viết cả payload ra tay thay vì suy từ code sinh ra nó.
  - Blockers: Không có. **Hai audit có sẵn bắt được hai lỗi thật khi thêm code này**: `compiler-timeout-audit` bắt `doctor-repair.ts` nhắc `esbuild` (đã khai miễn trừ kèm lý do — nó không chạy gì), và `spawn-environment-audit` bắt probe spawn **không đi qua `allowlistedEnvironment`** — đúng thứ D.5 tồn tại để ép, và nếu để nguyên thì `runtime.python-utf8` sẽ kiểm một environment mà sản phẩm không bao giờ chạy. Đã sửa. Full suite 1409 pass / 4 skip, typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase J, Task J.10 + AC
  - Files: `packages/cli/src/commands/doctor-context.ts`, `tests/cli/doctor-integration.test.ts`, checklist và implementation notes
  - Summary: Integration test doctor trên app-data thật, SQLite thật và daemon thật; đóng hai Acceptance Criteria của Phase J.
  - Decisions: Ca repair dùng daemon thật của J.2 thay vì stub, vì thứ cần chứng minh là "daemon sống thì từ chối" và discovery record là bằng chứng quan sát được — daemon xoá record trước khi nhả lease nên "đã dừng" không phải phỏng đoán theo thời gian.
  - Blockers: Không có. **Bug thật do test bắt**: `db.migration` chỉ chạy `foreign_key_check`, mà nó hài lòng với database rỗng, nên doctor gọi một install chưa migrate là khoẻ mạnh. Đã kiểm schema trước khi kiểm integrity, và bọc đường đọc `app_settings` vì doctor là lệnh chạy đúng lúc install đang hỏng. Full suite 1413 pass / 4 skip.

2026-08-09 — Phase D, Task D.3b + D.7 (đóng phần chặn ngược)
  - Files: `packages/cli/src/runtime-paths-source.ts`, `packages/cli/src/next-host.ts`, `packages/cli/src/commands/{mcp,recovery}.ts`, `packages/cli/src/composition-root.ts`, `packages/adapter/src/runtime/{process-environment,node-process-runner}.ts`, `tests/cli/runtime-paths-entrypoints.test.ts`, `tests/adapter/process-environment.test.ts`, checklist và implementation notes
  - Summary: Một nguồn duy nhất sinh `RuntimePaths` cho mọi entrypoint dựng composition root, và `NODE_EXTRA_CA_CERTS` xuống mọi Node child.
  - Decisions: Test lấy danh sách mode từ chính `VIDCOM_COMMAND_NAMES` chứ không chép lại — mode mới không trượt khỏi file này được. `render`/`doctor` không dựng composition root thứ hai vì chúng là client của daemon, nên "năm entrypoint" là năm mode. `caBundlePath` rỗng được coi là không có bundle, vì với Node chuỗi rỗng là một bundle ở đường dẫn `""` và nó hỏng mọi handshake.
  - Blockers: Không có; 9 test mới, full suite 1422 pass / 4 skip, typecheck, lint 0 error.

2026-08-09 — Phase K, Task K.1–K.10
  - Files: `packages/core/src/usecase/project-import{,-idempotency}.ts`, `packages/adapter/src/fs/import-staging.ts`, `packages/server/src/routes/delivery-loop.ts`, `tests/core/project-import.test.ts`, `tests/adapter/project-import.test.ts`, `tests/server/project-import-route.test.ts`, checklist và implementation notes
  - Summary: Import project — plan/overlap/đặt tên trong core, staging + copy + recovery trên filesystem thật, route 202 `{jobId}`.
  - Decisions: So sánh path phân biệt hoa thường là **tham số** vì gate cấm `core` chạm `process.platform`. Identity nguồn là `dev:ino` chứ không phải đường dẫn. Symlink từ chối; ba thư mục dựng lại được thì bỏ qua mà không fail. Recovery chỉ hành động trên thư mục **có marker**. Khoá idempotency nối bằng NUL vì path chứa được mọi ký tự khác. Test dùng đúng ba project trong `projects/` của repo — `swiss-grid`, `kinetic-type`, `warm-grain`; checklist không nêu tên nên đây là ba cái thật sự tồn tại.
  - Blockers: Không có; 17 logic test + 14 integration trên fs thật + 7 route/idempotency; full suite 1460 pass / 4 skip, typecheck, lint 0 error, boundaries xanh.

2026-08-09 — Phase J/D, CI remediation Windows (run trên `6662c6d`)
  - Files: `packages/cli/src/commands/doctor-context.ts`, `packages/cli/src/main.ts`, `tests/cli/doctor-integration.test.ts`, `tests/cli/runtime-paths-entrypoints.test.ts`, checklist và implementation notes
  - Summary: Windows đỏ ba test mới. Hai lỗi khác nhau, cả hai đều thật.
  - Decisions: (1) `createDoctorContext` **mở database mà không đóng** — trên Windows file bị giữ tới khi handle biến mất, nên mọi lần dọn thư mục sau đó trả `EBUSY`. Thêm `close()` và gọi trong `finally` của dispatcher; production trước đó thoát process nên che mất, nhưng leak vẫn là leak. (2) Một assert so `"/app-data"` bằng literal POSIX, trong khi Windows dựng `\app-data\native` — sửa bằng `path.join`, đúng nền tảng mà luật này tồn tại để bảo vệ. Không retry, không nới.
  - Blockers: Không có; 9/9 test hai file đó, full suite xanh. Chờ CI exact HEAD.

2026-08-09 — Phase L, Task L.1 + L.2 + L.3 + L.5
  - Files: `scripts/verify-artifact.mjs`, `scripts/build-cli-bundle.mjs`, `tests/build/{artifact-provenance,cli-bundle}.test.ts`, checklist và implementation notes
  - Summary: Gate provenance — quét cấm, allowlist thư mục artifact, `SHA256SUMS` + `artifact-manifest.json`. Chạy thật trên artifact 127 MB.
  - Decisions: `dirty` ghi lại chứ không từ chối ở tầng này; job release mới đòi `false`. Checksums theo định dạng `sha256sum -c`. Test pack thật tự build export khi thiếu thay vì skip.
  - Blockers: **Hai lỗi thật do chính gate này bắt.** (1) Bundle chứa 11 đường dẫn tuyệt đối của máy build từ `import.meta.url` — đã strip bằng marker `/vidcom`. (2) Bundle **inline `sharp`**, và native addon không đi kèm `.node` nên artifact chết ngay import đầu tiên; đã khai `EXTERNAL_PACKAGES` theo DR-2. Nhưng bare `require("sharp")` trong SEA đi vào `embedderRequire` và trả `ERR_UNKNOWN_BUILTIN_MODULE` — **resolve external từ runtime đã giải nén là việc chưa làm được**, nó cần chính runtime archive đang bị chặn. Ghi lại nguyên văn, MUST NOT giả vờ xanh.

2026-08-09 — Phase K, CI remediation Linux
  - Files: `packages/adapter/src/fs/import-staging.ts`, `tests/adapter/project-import.test.ts`, checklist và implementation notes
  - Summary: Linux đỏ một test K — "notices when the source was replaced between plan and copy".
  - Decisions: Không phải lỗi test mà là lỗi của chính identity: **Linux trả lại ngay inode vừa giải phóng**, nên xoá rồi tạo lại cùng đường dẫn cho ra cùng `dev:ino` và kiểm tra bỏ sót ca nguồn bị thay — đúng ca tệ nhất mà nó tồn tại để chặn. Thêm `ctimeMs`: nó đổi bất cứ khi nào inode đổi. macOS không lộ ra vì phân bổ inode khác.
  - Blockers: Không có; 14/14 test file đó, typecheck xanh. Chờ CI exact HEAD.

2026-08-09 — Phase L, Task L.4 + L.6
  - Files: `packages/adapter/src/runtime/process-environment.ts`, `scripts/verify-spec-test-paths.mjs`, `tests/adapter/process-environment.test.ts`, checklist và implementation notes
  - Summary: Tắt telemetry HyperFrames ở mọi child, và đăng ký spec này vào gate spec-paths (80 → 115 path).
  - Decisions: Hai tên biến đọc ra từ `hyperframes/dist/cli.js` đã pin thay vì đoán, và test ghim rằng CLI thật sự đọc chúng — một biến không ai đọc là thiết lập không làm gì mà trông như có làm.
  - Blockers: Không có. **Gate bắt drift tài liệu ngay lần đầu**: hàng D và E của Verification Matrix trỏ vào hai file test **chưa bao giờ tồn tại** (`vidcom-node-shim`, `foundation-manager`). Sửa bảng cho khớp tên thật, không nới gate — đây đúng là quy trình task L.6 mô tả.

2026-08-09 — Phase F, Acceptance Criteria
  - Files: `packages/server/src/app.ts`, `packages/cli/src/next-host.ts`, `tests/cli/browse-surface.test.ts`, checklist và implementation notes
  - Summary: Đóng hai AC của Phase F bằng test qua socket thật.
  - Decisions: **Phát hiện lỗi thật khi đi kiểm AC**: `createSystemRoutes` đã tồn tại từ Phase F nhưng **chưa bao giờ được mount** vào `createServerApp`, nên picker của G.7 không có endpoint nào để gọi và cả hai AC chưa từng được kiểm end-to-end. Đã nối vào dưới `/v1/system`, dùng chung `hostBrowseTokens` với route activation — token do browse mint phải được chính activation kế tiếp tiêu thụ.
  - Blockers: Không có; 3/3 test, full suite xanh. `401` đúng kể cả từ `127.0.0.1`: đến từ loopback không phải là xác thực, mọi thứ chạy trên máy người dùng đều tới được cổng này.

2026-08-09 — Phase G, Acceptance Criteria
  - Files: checklist và implementation notes
  - Summary: Đóng ba AC còn lại của Phase G bằng bằng chứng đã có.
  - Decisions: "Một bundle, hai môi trường" nằm ở `resolveApiBaseUrl` — đọc global runtime rồi mặc định `location.origin`, không `NEXT_PUBLIC_*` nào bị inline lúc build; test routing của J.2 chứng minh vế same-origin trên cùng một port. `test:browser-session` chạy 7/7. `git diff main -- package.json` chỉ thêm **script**, không dependency; `bun.lock` đúng một dòng `tar@7.5.22` — đúng dependency duy nhất được phép.
  - Blockers: Không có cho ba AC này.

2026-08-09 — Phase H, Task H.6 (cơ chế)
  - Files: `scripts/measure-startup.mjs`, `tests/build/startup-baseline.test.ts`, checklist và implementation notes
  - Summary: Hai gate startup — trần cứng §9.1 và chặn hồi quy 1,5× theo baseline từng runner — cộng luật ghi baseline.
  - Decisions: Baseline chỉ ghi khi chưa có; ghi đè mỗi lần chạy làm gate tự vô hiệu vì mỗi lần đo trở thành baseline của chính nó. Đo không có trần trả `unknown` và **không** tính là fail — nó là lỗ hổng cần gọi tên, không phải một lần pass. Runner lạ cũng `unknown` thay vì đoán trần.
  - Blockers: Số cold thật cần runtime archive đã giải nén (cột cold theo định nghĩa gồm bước extract), cùng blocker tài sản phát hành. Cơ chế và test đã xong: 8/8.

2026-08-09 — Phase M, Task M.0 (khung)
  - Files: `scripts/packaged-smoke/{run,steps}.mjs`, `package.json`, `tests/build/packaged-smoke.test.ts`, checklist và implementation notes
  - Summary: Runner packaged smoke chạy được trên máy dev, `--step`/`--from`, bằng chứng JSON trên stdout, tiến trình trên stderr, exit ≠ 0 **kèm id bước**.
  - Decisions: Danh sách bước là dữ liệu chứ không phải một script tuần tự, để `skipped` trở thành giá trị kiểm được — AC của phase là "không step bắt buộc nào bị skip", và một AC chỉ kiểm được bằng cách đọc log là AC không ai kiểm. `--strict` mặc định lấy từ `VIDCOM_DOCTOR_STRICT` mà job đã đặt, nên một nghĩa của `skipped` chứ không phải hai.
  - Blockers: **Lệch spec đã ghi**: M.0 nói 12 bước, §11.4 liệt kê 13 — hiện thực theo Design. Thân từng bước lái executable đã đóng gói nên cần runtime archive; hiện mỗi bước trả `skipped` kèm lý do và `--strict` làm nó đỏ. 8/8 test.

2026-08-09 — Phase M, Task M.1 + M.5 + M.6 (workflow)
  - Files: `.github/workflows/packaged-smoke.yml`, checklist và implementation notes
  - Summary: Ba job native, artifact dựng **trên chính runner**, cache theo version runtime, `VIDCOM_DOCTOR_STRICT=1`, upload bằng chứng kể cả khi đỏ.
  - Decisions: `workflow_dispatch` thôi — thân từng bước cần runtime archive chưa có, và đặt lịch chỉ tạo một badge đỏ hằng ngày không mang thêm thông tin; đúng tiền lệ `phase4-browser-session.yml`. `fail-fast: false` vì mục đích của job là biết **nền tảng nào** đã được chứng minh. Cache key theo `build-runtime-archives.mjs` chứ không theo lockfile: thứ được cache là browser/model tải về, chúng đổi khi runtime pin đổi chứ không khi dependency đổi. Upload `if: always()` vì lúc cần timing và lý do từng bước nhất chính là lúc job đỏ.
  - Blockers: Chưa chạy được xanh cho tới khi có runtime archive; MUST NOT thêm vào CI chính để tránh một gate đỏ vĩnh viễn.

2026-08-09 — Phase C, C.3 AC (vẫn KHÔNG tick)
  - Files: `tests/cli/boot-migration-count.test.ts`, checklist và implementation notes
  - Summary: Thêm một test chốt **kết quả** của boot — schema áp đúng một lần, không hash trùng, `foreign_key_check` sạch — trên daemon thật của J.2.
  - Decisions: **Không tick AC.** AC đòi đếm bằng counter, và chính nó cảnh báo "đừng tick bằng test đếm giả". Test này chứng minh kết quả nhất quán chứ không chứng minh số lần gọi; seam để đếm chỉ tồn tại khi `BootstrapCoordinator` sở hữu migration ở entrypoint. Giữ test lại vì nó vẫn bắt được một lần migrate lặp gây trùng hàng hoặc lỗi, nhưng nó không phải thứ AC hỏi.
  - Blockers: AC C.3 vẫn mở, đúng như C.3 đã ghi từ đầu.

2026-08-09 — Phase L, CI remediation Windows (run 31288921999)
  - Files: `tests/build/artifact-provenance.test.ts`, checklist và implementation notes
  - Summary: Linux và macOS xanh, Windows đỏ đúng một test — ca pack thật tự build static export.
  - Decisions: Nguyên nhân là cách spawn, không phải build: `npm` trên Windows là một `.cmd`, và Node từ chối spawn nó khi không có shell, nên `status` về `null` và lỗi đọc thành "không build được export" thay vì "spawn sai". Đổi sang `bun`, vốn là executable thật trên cả ba OS và đã có sẵn trong job. Kèm `stderr` vào message để lần sau lỗi tự nói ra nguyên nhân.
  - Blockers: Không có; 12/12 test file đó sau khi xoá `out/`, typecheck và lint xanh.

2026-08-09 — Blocker runtime archive, mô tả lại cho đúng
  - Files: checklist
  - Summary: Đọc thẳng `parseConfig`/`buildRuntimeArchives` thay vì dựa vào ghi chú cũ. Blocker vẫn còn, nhưng **không phải** vì "phải bịa hash".
  - Decisions: Builder **tự tính hash từ chính byte nó tar** — không có trường hash nào trong config để bịa. Thứ config thật sự đòi là (a) `versions` gồm bảy tên, trong đó `hyperframes`/`esbuild`/`motion` suy được từ repo và `node` là pin của CI, còn `ffmpeg`/`cpython`/`vieneu` cần bản cài thật; (b) `archives[].source` là **thư mục có thật trên đĩa** để đóng gói; (c) `pythonPackages[<platform>]` là file liệt kê tập package **đã cài thật**, được đối chiếu với evidence trong `spikes/phase-4/s9-windows-runtime/evidence/` — evidence **đã có trong repo**, thứ thiếu là tập thật để so.
  - Blockers: Kể cả một archive chỉ gồm thành phần Node có sẵn trong `node_modules` (sharp, onnxruntime-node, hyperframes, linkedom, esbuild) cũng **không dựng được**, vì `buildRuntimeArchives` bắt buộc có `pythonPackages` cho mọi platform xuất hiện trong `archives` và verify nó trước khi tar bất cứ thứ gì. Đó là thiết kế của builder, không phải chỗ để lách. Cần: một lần cài CPython + VieNeu thật để sinh package-set, cùng cây FFmpeg/CPython/VieNeu đã giải nén.

2026-08-09 — Phase H, H.0 (cùng lỗi spawn, lần này ở production)
  - Files: `scripts/build-artifact.mjs`, `tests/build/build-artifact.test.ts`, checklist
  - Summary: Bước static export của `build:artifact` gọi `npm` — **cùng lỗi vừa sửa trong test**, nhưng ở code build thật.
  - Decisions: Đổi sang `bun`. Trên Windows `npm` là `.cmd` và Node từ chối spawn nó khi không có shell, nên `build:artifact` sẽ chết ở đó vì một lý do chẳng liên quan gì tới việc export. Thêm test ghim **không bước nào** dùng `npm`, để lỗi này không quay lại qua một bước khác.
  - Blockers: Không có; tìm ra nhờ đọc lại chỗ vừa sửa trong test, không phải nhờ CI — Windows chưa bao giờ chạy tới bước này vì `build:artifact` còn bị chặn ở bước 1.

2026-08-09 — Review diff (K + J), ba lỗi thật
  - Files: `packages/adapter/src/fs/import-staging.ts`, `packages/cli/src/commands/render.ts`, `packages/cli/src/main.ts`, `tests/adapter/project-import.test.ts`, `tests/cli/render-command.test.ts`, checklist
  - Summary: Đọc lại diff của K và J, tìm ra ba lỗi mà không test nào đang bắt.
  - Decisions: (1) **Thứ tự sai ở cả `commitStaging` lẫn `recoverImportStaging`**: xoá marker **trước** rồi mới rename — rename hỏng thì còn lại một thư mục staging **không recovery nào nhận ra được nữa**, tức rác trong workspace người dùng mà không gì dọn. Đổi sang rename trước, xoá marker ở nơi nó đã tới; thêm test dựng ca rename hỏng thật. (2) `readStagingMarker` dùng `await import("node:fs/promises")` trong khi module đã import ở trên — bỏ. (3) `runRender` bỏ rơi iterator interrupt, nên listener SIGINT ở lại suốt đời tiến trình.
  - Blockers: Không có. Chỗ (3) lộ ra một tính chất phải viết ra: async generator đang **park trên một promise không bao giờ settle** — đúng hình dạng của "chờ Ctrl+C kế tiếp" — thì `return()` không đánh thức nó để chạy cleanup được, nên `await` nó sẽ **treo đúng lần thoát mà nó đang dọn dẹp**. Vòng đời handler chuyển về chỗ sở hữu nó (`main.ts` gọi `stop()` trong `finally`), còn `runRender` chỉ báo "thôi nghe" chứ không chờ. Full suite 1498 pass / 4 skip.

2026-08-09 — Review diff (J + I), bốn lỗi nữa
  - Files: `packages/cli/src/commands/serve.ts`, `packages/cli/src/next-host.ts`, `packages/adapter/src/daemon/daemon-client.ts`, `packages/cli/src/bridge/remote-tool-invoker.ts`, `packages/server/src/routes/bridge.ts`, `packages/core/src/service/doctor.ts`, `packages/cli/src/commands/{doctor-checks,render}.ts`, tests tương ứng
  - Summary: Bốn lỗi nữa từ đọc lại diff, không lỗi nào có test đang bắt.
  - Decisions: (1) `serve` dựng lại static host **mỗi request** — mỗi lần parse lại manifest và kiểm biên từng entry, tức lặp toàn bộ việc đó cho từng ảnh trên một trang. Dựng một lần. (2) **`globalThis.require` không tồn tại trong SEA** — `require` là binding phạm vi module, không phải global — nên nhánh SEA **không bao giờ chạy** và bản đóng gói sẽ phục vụ trang "chưa build" trong khi đang mang sẵn frontend bên trong. Đổi sang `process.getBuiltinModule("node:sea")` + `isSea()`. (3) Strict biến `skipped` thành `missing` **mà không kèm remedy**, tức vi phạm đúng luật "mọi mục không ok đều nói cách sửa", ngay ở lần chạy người ta cần câu trả lời nhất. (4) Daemon hardcode `era: "modern"` — bridge mới là bên đàm phán era, nên nó phải forward; route giờ **bắt buộc** có `era`, vì mặc định "modern" sẽ lặng lẽ chạy một tool modern-only cho client legacy, đúng thứ mà việc tách era tồn tại để chặn.
  - Blockers: Không có; full suite 1502 pass / 4 skip, typecheck, lint 0 error, boundaries xanh. CI `bf8b77d` xanh cả ba OS.

2026-08-09 — Phase C, Task C.3 (đóng AC migration một lần)
  - Files: `packages/cli/src/{bootstrap-coordinator,runtime-paths-source,workspace-selection,startup,next-host}.ts`, `packages/cli/src/commands/{mcp,serve,recovery}.ts`, `tests/{adapter/bootstrap-coordinator,cli/boot-migration-count}.test.ts`, Design §16 (C-8), checklist và implementation notes
  - Summary: Lắp `BootstrapCoordinator` trước workspace selection trên mọi boot path; truyền DB đã migrate xuống dưới và bỏ migration lặp ở foundation. Test counter chạy production `startServing` → hosted runtime → coordinator → selection → foundation trên SQLite + filesystem thật và chốt đúng một lần gọi; schema/foreign key được kiểm trên cùng DB sau boot.
  - Decisions: Source checkout không có archive để extract nên coordinator bỏ riêng extraction khi không có asset source, nhưng vẫn giữ khoá bootstrap, migration và credential reconciliation. Artifact vẫn bắt buộc SEA/filesystem asset source và không fallback về dependency của máy build; ghi thành C-8 trong Design §16. Review độc lập bắt được route activate workspace còn gọi `selectWorkspace` không kèm DB, tức migrate thêm trước mỗi hot-swap. Sửa tận contract: `selectWorkspace` nay bắt buộc nhận DB đã migrate; activation và runtime thay thế dùng DB của foundation đang sống, nên TypeScript chặn call-site quên ownership thay vì dựa vào một boolean.
  - Blockers: Không có. Focused Phase C 28/28; full suite 1504 pass / 4 skip có chủ ý; typecheck, lint 0 error / 3 warning có sẵn, `test:boundaries`, `test:spec-paths` và `git diff --check` xanh.

2026-08-09 — Phase D, production-path re-audit (mở lại task đã tick sai)
  - Files: `packages/adapter/src/hyperframes/{binary-probe,compiler-guard,browser-verification,version-skew}.ts`, `packages/adapter/src/runtime/download-cache.ts`, `packages/cli/src/{main,node-sentinel,composition-root}.ts`, checklist và implementation notes
  - Summary: Focused matrix cũ xanh nhưng không chạy các bảo vệ trên đường artifact thật. Mở lại D.1, D.2, D.4, D.6, D.7, D.8, D.9, D.11, D.12 và AC compiler: SEA detection đọc property không chuẩn; sentinel dùng root rộng + lexical path; Chrome chỉ kiểm `X_OK`; ba helper guard/cache/skew không có caller production; VieNeu không nhận CA/offline; spawn audit bỏ alias.
  - Decisions: Một test helper xanh không đủ để tick task production. Giữ nguyên `tools/list`, boundary gate và ESLint; sửa ở call graph rồi mới thêm regression xuyên seam. Phase C được xác nhận exact-SHA CI ba OS xanh ở run `31295074545` trước khi Phase D được kích hoạt lại.
  - Blockers: Hai AC artifact vẫn chặn bởi chuỗi phát hành thật: `build:artifact` gọi builder archive thiếu argument/config/source runtime, và packaged-smoke chưa có thân bước chạy executable. Không tick bằng spike cũ hoặc fixture copy từ `node_modules`.

2026-08-09 — Phase D, seam D.6 + D.7 (nối lại VieNeu production, CHƯA tick)
  - Files: `packages/cli/src/composition-root.ts`, `tests/cli/vieneu-runtime-wiring.test.ts`, checklist và implementation notes
  - Summary: Nối frozen VieNeu provider với CA bundle và chế độ warm-offline ở composition root; test mở SQLite/filesystem temp rồi spawn child Node thật để đọc environment thực tế.
  - Decisions: Cold first-run giữ online mặc định. Hai cờ chuẩn `HF_HUB_OFFLINE=1` hoặc `TRANSFORMERS_OFFLINE=1` là opt-in của packaged smoke/operator; một cờ đầu vào luôn sinh cả hai cờ ở sidecar. CA ưu tiên config đã resolve rồi mới settings, cùng một giá trị tới Node và Python; không thêm public setting hay dependency.
  - Blockers: D.6 còn thiếu cache-ready tự bật offline qua D.8. D.7 còn thiếu CA ở render supervisor và reporter spawn. `vieneu-runtime-wiring` + frozen-interpreter + provider + process-environment xanh 33/33; agent chạy typecheck xanh, lint 0 error / 3 warning có sẵn.

2026-08-09 — Phase D, Task D.1 (đóng lại sentinel production)
  - Files: `packages/cli/src/{main,node-sentinel}.ts`, `tests/adapter/node-sentinel.test.ts`, checklist và implementation notes
  - Summary: Sentinel được dispatch trước parser nhưng chỉ nhận script dưới archive HyperFrames của đúng runtime hiện hành; root được xác minh qua `current.json`, installed manifest và ready marker khớp artifact/platform. Script và root đều canonicalize bằng `realpath`; symlink/traversal/sibling/missing file đều trả `runtime_manifest_invalid`.
  - Decisions: Resolver sentinel chỉ đọc filesystem và không gọi bootstrap/extraction/migration, vì child có thể re-enter artifact trong khi foundation đang sống. Cấu hình app-data được đọc từ đúng `VIDCOM_SETTINGS`/`VIDCOM_APP_DATA`; test production wiring chốt không tạo SQLite hoặc daemon state.
  - Blockers: Không có cho D.1. Focused `node-sentinel.test.ts` xanh 13/13 trên filesystem thật. D.2 vẫn mở cho tới khi cả reporter và render child nhận app-data đã resolve trong environment allowlist.

2026-08-09 — Phase D, Acceptance Criterion motion libraries
  - Files: `tests/e2e/motion-runtime-artifact.test.ts`, checklist và implementation notes
  - Summary: Dựng archive runtime thật từ package manifest và đúng tập file catalogue của GSAP, Anime.js, Motion One, Lottie và Three.js; xoá cây staging trước khi extract, resolve `RuntimePaths` ở artifact mode, mở foundation bằng SQLite/filesystem temp thật rồi gọi registry production `install_motion_library` cho đủ năm.
  - Decisions: `node_modules` chỉ được dùng ở bước build để stage byte vào archive, đúng vai trò của dependency build. Runtime proof đọc từ archive đã build/extract; test so byte nguồn → extracted → vendored, sau đó làm mất distributed root và yêu cầu lần gọi nữa fail `storage_unavailable`, nên checkout không thể lặng lẽ cứu một đường artifact hỏng.
  - Blockers: Không có. Focused integration xanh 1/1 trong 3,23 s; agent cũng xác nhận typecheck, lint scoped và boundaries xanh.

2026-08-09 — Phase D, Task D.9 (version skew trên production preflight)
  - Files: `packages/{core/src/port/ports,worker/src/render-job,adapter/src/hyperframes/binary-probe}.ts`, `tests/adapter/{render-binary-probe,render-job,version-skew}.test.ts`, checklist và implementation notes
  - Summary: `BinaryProbePort.probe` bắt buộc nhận project root; render và snapshot preflight truyền root đã chọn, nên detector so version khai trong `hyperframes.json` với đúng package HyperFrames mà probe vừa resolve và đưa warning có mã vào kết quả job.
  - Decisions: File thiếu, không khai version, chuỗi rỗng hoặc JSON hỏng không bị đoán thành drift. Warning chỉ quan sát; integration đọc lại file và chốt byte-for-byte không đổi. Contract bắt buộc project root để TypeScript ngăn một caller mới vô tình bỏ qua kiểm tra.
  - Blockers: Không có. `render-binary-probe`, `version-skew`, `render-job`, `snapshot-job` xanh 31/31 trên checkout chung.

2026-08-09 — Phase D, Task D.2 (hai spawn shape trong SEA)
  - Files: `packages/adapter/src/hyperframes/binary-probe.ts`, `packages/adapter/src/runtime/process-supervisor.ts`, `packages/cli/src/composition-root.ts`, `tests/{adapter/render-binary-probe,cli/render-process-environment}.test.ts`, checklist và implementation notes
  - Summary: SEA detection dùng API chuẩn `node:sea.isSea()`; reporter `browser path` và command render trả về đều đi qua cùng `nodeArgv`, thêm `--vidcom-node` chỉ trong artifact. Reporter và supervisor nhận đúng app-data đã resolve để sentinel child xác minh runtime hiện hành.
  - Decisions: `VIDCOM_APP_DATA` là authority cấu hình, không phải ambient hint: giá trị composition root thắng cả parent lẫn per-call hostile override. Environment vẫn đi qua allowlist và integration child thật chốt `GH_KEY` không lọt.
  - Blockers: Không có. Bộ child-seam focused xanh 57/57; riêng binary probe phủ SEA command, reporter thực, browser cắt cụt và custom app-data.

2026-08-09 — Phase D, Task D.7 (CA bundle tới mọi child loại Node/Python)
  - Files: `packages/{adapter/src/{hyperframes/binary-probe,runtime/process-supervisor,tts/tts-vieneu},cli/src/composition-root}.ts`, `tests/{adapter/render-binary-probe,cli/render-process-environment,cli/vieneu-runtime-wiring}.test.ts`, checklist và implementation notes
  - Summary: Một CA bundle đã resolve được truyền tới reporter HyperFrames, render/snapshot supervisor, Node process runner và VieNeu sidecar. Node child nhận `NODE_EXTRA_CA_CERTS`; Python nhận `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE`.
  - Decisions: CA cấu hình thắng ambient/per-call override; path rỗng không được materialize. Không tắt verify TLS và `NODE_TLS_REJECT_UNAUTHORIZED` của parent không qua allowlist. Tất cả integration spawn child thật; VieNeu wiring đồng thời mở SQLite/filesystem temp thật.
  - Blockers: Không có. Bộ child-seam focused xanh 57/57; CA được quan sát từ chính process con, không chỉ inspect object option.

2026-08-09 — Phase D, Task D.12 (audit mọi child-process spawn)
  - Files: `tests/adapter/spawn-environment-audit.test.ts`, `packages/cli/src/bridge/spawn-daemon.ts`, `tests/cli/bridge-attachment.test.ts`, checklist và implementation notes
  - Summary: Thay regex audit bằng TypeScript AST theo binding thật của `node:child_process`; nhận renamed import, namespace access, promisify và alias chain, rồi kiểm từng call có `allowlistedEnvironment`. Audit mới bắt `spawnEnsuredDaemon` đang kế thừa full env; production nay chỉ forward cấu hình daemon hẹp.
  - Decisions: Exemption dùng exact call key và test liveness đúng một call, kèm lý do bắt buộc. Integration daemon child giữ `VIDCOM_APP_DATA`/provider config cần thiết nhưng loại `GH_KEY`; render/reporter/VieNeu child thật đồng thời chứng minh UTF-8 và CA không mất.
  - Blockers: Không có. `spawn-environment-audit`, `bridge-attachment` và toàn bộ child-seam focused xanh trong bộ 57/57.

2026-08-09 — Phase D, Task D.3b (chốt authority layout runtime đã publish)
  - Files: `packages/adapter/src/runtime/{runtime-asset-source,runtime-asset-manager,runtime-paths}.ts`, `packages/adapter/src/tts/vieneu-sidecar-path.ts`, `packages/cli/src/commands/doctor-context.ts`, tests runtime/doctor tương ứng, checklist và implementation notes
  - Summary: Một resolver duy nhất ánh xạ `archive.key` sang `archive.target`; extraction, read-only current-runtime resolver, sentinel, composition root và doctor cùng đọc đúng version/target đã publish. Target lồng nhau được publish/rollback bền vững trên đúng parent directory; parent symlink/special bị từ chối.
  - Decisions: §5.13 đã duyệt `archive.target` nhưng §5.14 lại viết cứng `<archive-key>`; correction chọn field manifest làm authority và ghi mâu thuẫn này thành Design §16 C-9. Artifact mode được gắn tường minh trên `RuntimePaths`; frozen VieNeu fail-closed khi thiếu bất kỳ interpreter hoặc `vieneu/worker.py`, trong khi source-dev vẫn được dùng interpreter checkout/PATH.
  - Blockers: Không có cho D.3b. Main rerun `runtime-asset-manager`, `runtime-paths`, `vieneu-frozen-interpreter`, `doctor-integration` trên filesystem/SQLite thật: 4 file, 50 pass, 1 Windows skip có chủ đích.

2026-08-09 — Phase D, Task D.4 + Acceptance Criterion compiler
  - Files: `packages/{cli/{bin/vidcom.mjs,src/{boot,compiler-preload,compiler-probe,sea-entry}.ts},adapter/src/hyperframes/{compiler-guard,compiler-probe-child}.ts}`, compiler/doctor/bundle tests, Design §16 C-10, checklist và implementation notes
  - Summary: Compiler env được cấu hình trước adapter barrel/HyperFrames ở cả source lẫn SEA. Doctor chạy transform HyperFrames thật trong child riêng có OS deadline/kill proof; không còn dùng `esbuild --version` hoặc Promise timer quanh API sync.
  - Decisions: Design §5.17 được correction ở C-10: `run()` chỉ nhận async operation; sync compiler chỉ được gọi trong supervised child. Subpath `@vidcom/adapter/compiler-guard` là module adapter hẹp, compiler-free duy nhất preload được phép import trước barrel. Source có hai stage vì `tsx` và HyperFrames sở hữu hai bản esbuild khác nhau; SEA chỉ cần stage HyperFrames.
  - Blockers: Không có. Main rerun 5 file compiler/audit/bundle: 38/38; guard + child thật + doctor: 20/20; `typecheck` và source CLI `version` xanh. Emitted CJS chạy transform thật với ambient `ESBUILD_BINARY_PATH` cố tình sai và vẫn trả marker đúng.

2026-08-09 — Phase D, Task D.6 (frozen VieNeu + warm-offline tự động)
  - Files: `packages/adapter/src/tts/{tts-vieneu,vieneu-sidecar-path}.ts`, `packages/adapter/sidecars/vieneu/worker.py`, `packages/cli/src/composition-root.ts`, `tests/{adapter/{tts-vieneu,vieneu-model-probe,vieneu-frozen-interpreter},cli/vieneu-runtime-wiring}.test.ts`, checklist và implementation notes
  - Summary: Artifact gọi interpreter/worker tuyệt đối từ runtime đã publish; cold model cache chạy probe thật có `snapshot_download` revision pin, còn marker ready tự chuyển mọi probe/synthesis sau đó sang cả hai chế độ offline của Hugging Face/Transformers.
  - Decisions: Không tự bật offline trước cold fetch. Chỉ stderr của sidecar là bằng chứng download TLS/network; lỗi dựng command local không được làm cache ready thành partial. Artifact thiếu frozen Python/worker fail-closed, development và explicit command override giữ hành vi cũ.
  - Blockers: Không có. Main rerun sáu file cache/VieNeu/browser integration: 66/66; SQLite, filesystem và child process đều là thật, không mock `node:fs`; `python3 -m py_compile` xanh.

2026-08-09 — Phase D, Task D.8 (download cache coordinator production)
  - Files: `packages/adapter/src/{runtime/download-cache,hyperframes/{binary-probe,chrome-resolver},tts/tts-vieneu}.ts`, `packages/cli/src/{composition-root,commands/doctor-context}.ts`, cache/browser/model tests và integration `download-cache-runtime-wiring.test.ts`, checklist và implementation notes
  - Summary: Một coordinator app-data sở hữu riêng browser/model component; marker được ghi trước download và chỉ xoá sau executable/model probe thật. Chrome cold/warm/repair và VieNeu cold/warm đều đi qua production composition root; doctor đọc đúng state/failure code đã bền qua restart.
  - Decisions: Timeout trả lỗi sớm cho caller nhưng giữ lease trong finalizer cho tới operation thật settle, nên retry/discard không bao giờ đè writer còn sống. Mọi path cache phải normalized, real directory, contained; symlink/special/malformed marker được đọc bảo thủ là invalid hoặc partial chứ không thành ready.
  - Blockers: Không có. Main rerun sáu file integration 66/66; agent chạy official Phase D matrix 49/49, extended D.8 111/111, typecheck/lint/boundaries/diff-check và Python compile xanh.

2026-08-09 — Phase D, Task D.4 (follow-up review: CommonJS loader alias)
  - Files: `tests/adapter/compiler-timeout-audit.test.ts`, checklist và implementation notes
  - Summary: Review độc lập dựng được hai cú pháp né inventory: namespace `node:module` rồi gọi `moduleApi.createRequire`, và alias nhiều tầng của chính factory. Audit nay lan truyền binding namespace/factory/loader đến fixed point và nhận module string qua cả hai hình dạng.
  - Decisions: Không dựa vào style convention hoặc regex cấm tên biến; synthetic fixtures dùng đúng cú pháp né cũ để chốt graph inventory theo binding thật. Đây là hardening bằng test, không nới boundary hay ESLint.
  - Blockers: Không có. Main rerun năm file compiler/audit/bundle: 40/40; agent xác nhận typecheck, lint 0 error / 3 warning có sẵn, boundaries và diff-check xanh.

2026-08-09 — Phase D, adversarial review D.6/D.8 (mở lại sau 66 test xanh)
  - Files: `packages/adapter/src/{tts/tts-vieneu,hyperframes/{chrome-resolver,browser-verification},runtime/download-cache}.ts`, `packages/cli/src/commands/doctor-context.ts`, checklist và implementation notes
  - Summary: Repro thật chứng minh model timeout bị mất `download_unavailable`; cache ready-stale chỉ repair ở lần gọi thứ hai; managed cache chấp nhận symlink tới Bun như Chrome; doctor gọi model directory rỗng markerless là healthy.
  - Decisions: Test helper/marker state không thay thế validation payload. Mở lại cả D.6 và D.8 ngay; yêu cầu repair cùng call, canonical containment + browser-shaped version và warm offline model proof trước doctor ok.
  - Blockers: Bốn lỗi trên đang được sửa; chưa được phép tick lại dù bộ sáu file trước đó xanh 66/66.

2026-08-09 — Phase D, Task D.11 (ba failure mode trong một integration)
  - Files: `tests/adapter/silent-failure-modes.test.ts`, checklist và implementation notes
  - Summary: Cùng một test temp-filesystem chạy guard với compiler promise treo, reporter Node thật nói dối về Chrome cắt cụt và sidecar child thật dưới production process runner với tiếng Việt/encoding hostile.
  - Decisions: Không chỉ gọi ba helper độc lập. Chrome đi qua `NodeRenderBinaryProbe`; encoding đi qua `NodeProcessRunner`; ca mô phỏng mất biến dùng explicit override mà D.5 chủ ý cho phép, yêu cầu error code và stdout rỗng thay vì chấp nhận chữ hỏng.
  - Blockers: Không có cho D.11. Main rerun `silent-failure-modes.test.ts`: 10/10 trên real filesystem/process; hai compiler env đều trả dưới 1 giây dù budget 30 giây.

2026-08-09 — Phase D, Task D.3b (follow-up artifact: diagnostics CLI)
  - Files: `packages/adapter/src/hyperframes/check.ts`, `packages/cli/src/composition-root.ts`, `tests/{cli/runtime-paths-wiring,adapter/diagnostics-thumbnail}.test.ts`, checklist và implementation notes
  - Summary: Repro SEA ngoài checkout lộ diagnostics adapter còn resolve HyperFrames CLI từ module graph. Adapter nay nhận verified extracted CLI, composition root truyền RuntimePaths và SEA spawn dùng sentinel trước CLI.
  - Decisions: Chỉ source mode được fallback `require.resolve`; artifact không có dependency checkout để cứu. Integration mở SQLite/filesystem temp và chạy một `.mjs` thật đặt dưới runtime root, đồng thời test riêng command SEA có sentinel.
  - Blockers: Không có cho seam này. Agent chạy hai file focused 12/12, typecheck, lint 0 error / 3 warning có sẵn, boundaries và diff-check xanh; main rerun integration runtime path 4/4.

2026-08-09 — Phase D, adversarial review D.1 (mở lại root-retarget race)
  - Files: `packages/cli/src/{main,node-sentinel}.ts`, `tests/adapter/node-sentinel.test.ts`, checklist và implementation notes
  - Summary: Sau khi resolver xác minh current runtime, attacker cùng user có thể rename HyperFrames root và thay pathname cũ bằng symlink ngoài. Sentinel canonicalize lại pathname mới cho cả root/script, nên containment vẫn pass và import code ngoài verified archive.
  - Decisions: Child import phải bind canonical authority đã verify, không chỉ hai pathname canonical tại thời điểm import. Regression sẽ retarget chính root giữa resolve và dispatch, không chỉ symlink một child như test cũ.
  - Blockers: D.1 mở tới khi real-fs regression chứng minh external module không chạy và trả `runtime_manifest_invalid`.

2026-08-09 — Phase D, artifact executable proof loop (AC còn mở)
  - Files: temp prototype dưới `/tmp/vidcom-phase-d-artifact.*`; production seams liên quan `scripts/build-{artifact,sea,cli-bundle,runtime-archives}.mjs`, `packages/cli/src/bootstrap-coordinator.ts`, daemon bridge routes; checklist và implementation notes
  - Summary: SEA exact HEAD không thể `require` native external từ embedded CJS; source migration root bị bake vào bundle; diagnostics CLI fallback checkout (đã đóng); bridge bearer gọi `/api/v1` render route và nhận 401. Mỗi lỗi được repro ngoài checkout/node_modules bằng artifact/temp runtime thật.
  - Decisions: Không dùng temp source mirror, mechanical bundle rewrite hoặc spike artifact cũ làm bằng chứng. Hướng nhỏ nhất đang được proof là SEA bootstrap builtins-only extract archive, verify secondary entry hash rồi `createRequire` CJS cạnh native closure; migration SQL phải ship trong verified archive; render API giữ bearer ở namespace bridge riêng thay vì nới auth browser.
  - Blockers: AC MP4 vẫn mở cho tới khi production build tạo artifact exact HEAD, PATH riêng không có node/python/python3, render narration MP4 và `ffprobe` xác nhận output.

2026-08-09 — Phase D, Task D.1 (đóng root-retarget TOCTOU)
  - Files: `packages/cli/src/{main,node-sentinel}.ts`, `tests/adapter/node-sentinel.test.ts`, checklist và implementation notes
  - Summary: Verified root authority mang canonical path + filesystem identity, được kiểm lại ba lần quanh script resolution/import. Thay pathname bằng symlink/junction ngoài sau resolve không thể đổi authority mà sentinel tin.
  - Decisions: So canonical string chưa đủ vì cả root/script có thể cùng đổi; bind identity inode/device/birthtime. String-only seam giữ cho unit thấp, production main chỉ truyền authority đã verify.
  - Blockers: Không có. Main rerun node-sentinel 15/15 trên filesystem thật; agent xác nhận typecheck, lint scoped, boundaries và diff-check xanh.

2026-08-09 — Phase D, artifact follow-up (migration authority)
  - Files: `packages/cli/src/bootstrap-coordinator.ts`, `tests/adapter/bootstrap-coordinator.test.ts`, checklist và implementation notes
  - Summary: Artifact migration không còn dùng `import.meta.url` bị Bun bake từ máy build. Sau extraction, coordinator truyền đúng `<archiveRoots.node>/drizzle`; source/no-asset mode giữ default hiện hữu.
  - Decisions: Migration root theo manifest target authority, không hardcode archive key hay source path. Test dùng target `node-runtime`, xoá source migrations trước boot và chạy SQL đã ship qua SQLite thật.
  - Blockers: Không có cho seam migration. Main rerun bootstrap coordinator 10/10, tạo proof table và đúng một row migration; agent xác nhận typecheck/lint/boundaries/diff-check xanh.

2026-08-09 — Phase D, Task D.6 (đóng lại timeout và same-call repair)
  - Files: `packages/adapter/src/tts/tts-vieneu.ts`, `packages/adapter/src/runtime/download-cache.ts`, `tests/{adapter/{tts-vieneu,vieneu-model-probe},cli/vieneu-runtime-wiring}.test.ts`, checklist và implementation notes
  - Summary: `timedOut` từ model probe nay trở thành `download_unavailable`, được ghi vào partial marker và ném để provider registry cho phép retry. Cache từng ready nhưng stale/corrupt chuyển partial rồi chạy online repair ngay trong cùng request; explicit offline vẫn từ chối mạng và giữ failure code.
  - Decisions: Không coi mọi lỗi sidecar là download failure — thiếu interpreter/worker vẫn là local unavailable và không phá marker ready. Chỉ timeout hoặc stderr có bằng chứng download được map sang cache failure. Warm thành công luôn ép cả hai cờ Hugging Face/Transformers.
  - Blockers: Không có. Main chạy lại sáu file cache/browser/VieNeu integration trên child process, SQLite và filesystem temp thật: 74/74; official Phase D matrix 57/57.

2026-08-09 — Phase D, Task D.8 (đóng lại payload proof browser/model)
  - Files: `packages/adapter/src/{runtime/download-cache,hyperframes/{browser-verification,chrome-resolver,binary-probe},tts/tts-vieneu}.ts`, `packages/cli/src/commands/doctor-context.ts`, `tests/{adapter/{download-cache,render-binary-probe},cli/download-cache-runtime-wiring}.test.ts`, checklist và implementation notes
  - Summary: Browser managed chỉ được nhận khi là regular non-symlink, canonical-contained dưới browser cache và tự trả Chrome/Chromium-shaped version; HyperFrames CLI không thể đưa system executable ngoài authority vào rồi xoá partial marker. Doctor model-cache chạy production warm-offline probe thay vì gọi directory markerless rỗng là healthy.
  - Decisions: Explicit browser override vẫn là policy riêng; mọi candidate do coordinator quản lý phải nằm trong authority. Test positive dùng executable fixture thực sự in Chromium version, không dùng Node/Bun làm Chrome giả. Lock lease tiếp tục sống sau prompt timeout tới khi writer thật settle.
  - Blockers: Không có. Main rerun focused D.6/D.8 74/74 và official Phase D matrix 57/57; agent chạy extended 109/109, typecheck, lint 0 error / 3 warning có sẵn, boundaries và diff-check xanh. Windows executable fixture còn phải qua CI ba OS của phase.

2026-08-09 — Phase D, adversarial review D.3b (`backup restore`/`recovery` authority split)
  - Files: `packages/cli/src/commands/{backup,recovery}.ts`, `tests/cli/runtime-paths-entrypoints.test.ts`, checklist và implementation notes
  - Summary: Inventory cũ khẳng định mode backup không dựng composition root, nhưng nhánh restore thực tế dựng hạ tầng rồi gọi migration trực tiếp. Trong SEA nó bỏ qua extraction/bootstrap lock và nhận runtime unversioned, cho phép toolchain fallback checkout hoặc Python trên PATH. Root split còn chạm serve discovery, render-connect, approve/credential và recovery: compiler preload dùng settings A trong khi các resolver sau dùng default B.
  - Decisions: Mở lại D.3b ngay. Restore phải dùng cùng `prepareRuntimeForCli`/`runtimePathsFor` authority trước composition/lease và không migrate lần hai. Authority settings được pin ở preload sớm nhất vào `VIDCOM_APP_DATA` khi env chưa explicit, để mọi command sau cùng đọc một root; explicit env C vẫn thắng settings A. `backup list`/`verify` giữ read-only, không khởi động runtime vô ích.
  - Blockers: D.3b chưa được tick lại cho tới khi integration artifact-mode trên SQLite/filesystem temp chứng minh prepare/extract/migrate đúng một lần, không `require.resolve`/PATH fallback, settings root A nhất quán qua serve/render/backup/recovery/credential, explicit C vẫn thắng, và manifest thiếu archive bắt buộc không publish/migrate hay đổi prior current.

2026-08-09 — Phase D, artifact follow-up (CLI render bridge auth)
  - Files: `packages/{adapter/src/daemon/daemon-client,cli/src/commands/render,server/src/{app,routes/{bridge,delivery-loop,jobs}}}.ts`, `tests/{adapter/daemon-client,cli/{render-command,bridge-render-integration}}.test.ts`, checklist và implementation notes
  - Summary: Artifact CLI không còn gửi bridge bearer vào browser-session `/api/v1`. Enqueue/read/cancel dùng namespace đóng `/api/bridge/v1`, qua system credential guard hiện hữu và tái dùng strict render/job/cancel semantics của browser route.
  - Decisions: Không nới middleware bearer cho toàn bộ `/api/v1`; browser cookie vẫn là authority duy nhất ở surface đó. Server index giữ explicit public exports để helper transport nội bộ mới không mở rộng package boundary.
  - Blockers: Auth blocker đã đóng, nhưng AC artifact vẫn mở. Integration loopback server + SQLite/filesystem temp thật chốt bridge bearer thành công, user/MCP credential và thiếu bearer bị từ chối, bridge bearer trên `/api/v1` vẫn 401; focused 61/61, typecheck/lint/boundaries/diff-check xanh.

2026-08-09 — Phase D, artifact prototype (HyperFrames runtime adjacency)
  - Files: temp prototype dưới `/tmp/vidcom-phase-d-artifact.*`, production staging contract đang được triển khai, checklist và implementation notes
  - Summary: SEA prototype trên PATH riêng không tìm thấy node/python/python3 đã gọi CLI HyperFrames giải nén bằng absolute Chrome/FFmpeg/FFprobe và tạo H.264 MP4 320×180, 30 fps, 5 giây. Điều kiện thiếu trước đó là `hyperframe.manifest.json` cùng `hyperframe.runtime.iife.js` phải nằm cạnh `hyperframes/bin/hyperframes.mjs`.
  - Decisions: Ship hai core runtime file trong archive HyperFrames theo đúng lookup của CLI, không thêm archive thứ ba hay env override nếu không cần. Giữ `ffprobe` độc lập sau render: fixture invalid cho thấy HyperFrames log `sub_timeline_readiness_timeout`, không tạo output nhưng vẫn exit 0.
  - Blockers: Đây là direct sentinel prototype, không phải production `build:artifact`/`vidcom render`, chưa có narration và không được tick AC. Cần rebuild exact shared HEAD sau auth fix và hoàn tất two-stage production build/staging.

2026-08-09 — Phase D, Task D.3b follow-up (doctor deep integrity + broken publication)
  - Files: `packages/adapter/src/runtime/runtime-integrity.ts`, `packages/cli/src/commands/{doctor-context,doctor-checks}.ts`, `tests/cli/doctor-runtime-integrity.test.ts`, checklist và implementation notes
  - Summary: `doctor --deep` nay xác minh từng entry của host archive bằng size/hash/mode, regular non-symlink, single hardlink, real containment và ready marker chính xác; payload bị sửa, thiếu, extra, symlink/special/hardlink đều làm runtime integrity broken. Marker không còn được dùng thay digest.
  - Decisions: Deep verification là read-only authority tách khỏi repair/bootstrap. Lỗi đọc publication như `EACCES current.json` chỉ bị catch tại doctor seam: boot vẫn fail-closed, còn doctor giữ runtime paths null, ghi remedy và tiếp tục mọi check khác thay vì dừng ở lỗi đầu tiên.
  - Blockers: Không có cho doctor seam. Main rerun `doctor-runtime-integrity`, `doctor-integration`, `doctor` bằng filesystem/SQLite thật: 31/31; agent xác nhận typecheck, lint 0 error / 3 warning có sẵn và boundaries xanh. D.3b vẫn mở riêng vì `backup restore`.

2026-08-09 — Phase D, artifact prototype (actual `vidcom render` xanh)
  - Files: exact shared-HEAD secondary bundle + temp-only two-stage bootstrap/runtime staging dưới `/tmp/vidcom-phase-d-artifact.*`, checklist và implementation notes
  - Summary: Sau first-run `vidcom serve` tạo bridge credential, chính CLI `vidcom render artifact-proof --workspace …` chạy dưới `env -i` với private PATH không resolve node/python/python3 và kết thúc 0 sau 15,2 giây. Output 198845 byte có H.264 320×180 30 fps 5 giây cùng AAC 48 kHz stereo 5 giây; extracted ffprobe product validator exit 0/stderr rỗng.
  - Decisions: Xác minh audio bằng cả stream metadata và `volumedetect` (mean −20,3 dB, max −6,4 dB), rồi decode input/output và đo normalized correlation 0,9913 sau AAC priming shift 21,375 ms. Input duy nhất là project-local `narration/intro.wav` 4,88 giây, metadata `generated`, voice `Minh Đức`, BGM tắt và HTML không có audio/video; vì vậy track ra là narration chứ không phải âm thanh tình cờ. Fresh app-data render trước serve trả recovery error có mã về credential; smoke phải chạy flow bootstrap được thiết kế trước enqueue.
  - Blockers: AC vẫn mở vì bootstrap/archive staging của run này còn nằm trong prototype temp, chưa được tạo bởi production `bun run build:artifact`. Phải tái lập cùng proof không mechanical rewrite sau khi two-stage build pipeline land.

2026-08-09 — Phase B/D follow-up (portable manifest + crash publication hardening)
  - Files: `packages/adapter/src/runtime/{runtime-asset-source,runtime-asset-manager}.ts`, `scripts/build-runtime-archives.mjs`, `tests/adapter/{runtime-archive,runtime-asset-manager}.test.ts`, checklist và implementation notes
  - Summary: Manifest/current pointer dùng chung portable bounded segment rules; từ chối traversal, NUL/control, colon, DOS device, trailing dot/space, Unicode alias theo platform và component vượt 255 UTF-8 byte. Builder dùng total byte ordering, giữ parser-version bounds và self-parse manifest trước write, nên artifact build không thể xanh rồi runtime mới từ chối.
  - Decisions: Collision ownership normalize theo filesystem đích: case-fold Windows/macOS và NFC trên macOS; Linux giữ tên phân biệt nhưng builder vẫn có total deterministic order cho NFC/NFD. Corrupt current pointer read-only trả null, không để `ERR_INVALID_ARG_VALUE`/`ENAMETOOLONG` thoát.
  - Blockers: Không có. Main rerun 4 file runtime layout/frozen VieNeu: 133 pass, 2 platform skip. B.8 nay có child process bị SIGKILL thật ở đủ năm boundary rồi restart trên cùng filesystem; agent xác nhận typecheck/lint/boundaries/diff-check xanh. D.3b vẫn mở riêng vì backup restore.

2026-08-09 — Phase D, artifact build review (build-root encoding leak)
  - Files: `scripts/{build-cli-bundle,build-sea-bootstrap,verify-artifact}.mjs`, build/provenance tests, checklist và implementation notes
  - Summary: Source-path scanner/stripper chỉ nhận raw checkout root. Trên Windows Bun có thể bake `file:///C:/…` dùng slash xuôi; path có space thành `%20`, nên artifact vẫn mang build root trong khi test `not.toContain(process.cwd())` xanh giả.
  - Decisions: Một helper chung liệt kê raw native path, slash-normalized path và canonical file-URL/percent-encoded forms; secondary bundle, bootstrap bundle và verifier cùng dùng. Không replace chuỗi rộng ngoài đúng root encodings vì có thể làm hỏng code bundle.
  - Blockers: Production two-stage build chưa được chấp nhận cho tới khi synthetic Windows-root-with-space regression chứng minh mọi encoding bị strip/scan, trên mọi host chạy test.

2026-08-09 — Phase D, artifact bootstrap review (verified-entry TOCTOU)
  - Files: `packages/cli/src/sea-bootstrap.ts`, SEA bootstrap security tests, checklist và implementation notes
  - Summary: Bootstrap hash `boot.cjs` rồi trả pathname; `createRequire` mở lại pathname sau đó. File hoặc parent có thể bị swap trong khoảng giữa, nên code được thực thi không phải byte vừa khớp manifest — cùng lớp race đã mở lại D.1.
  - Decisions: Stage hai phải evaluate chính verified bytes hoặc bind filesystem identity/containment xuyên điểm load; một `realpath` trước require không đủ vì parent vẫn đổi được. Adjacent module resolution vẫn neo vào canonical boot path, nhưng entry source không được đọc lại từ pathname.
  - Blockers: Two-stage bootstrap chưa được chấp nhận tới khi deterministic hook swap file/parent sau verify chứng minh external marker không chạy và trả `runtime_manifest_invalid` trên filesystem thật.

2026-08-09 — Phase D, artifact input inventory (FFmpeg/FFprobe)
  - Files: temp-only pinned media binaries dưới `/tmp/vidcom-ffmpeg-static.*` và `/tmp/vidcom-ffprobe-arm64.*`, checklist và implementation notes
  - Summary: Copy `/opt/homebrew/bin/ffmpeg|ffprobe` chạy được nhưng `otool -L` còn hàng loạt dependency tuyệt đối `/opt/homebrew`, nên private PATH proof cũ vẫn dựa vào máy build. Cặp FFmpeg/FFprobe 6.0 arm64 từ release b6.0 chỉ link `/usr/lib` + Apple system frameworks; temp encode/probe H.264+AAC xanh.
  - Decisions: Dùng hai file này như **explicit local smoke input** cho production-build rerun, pin SHA-256 (`ffmpeg a90e…6584`, `ffprobe bb2d…0b64`). Không hardcode path, không commit binary, không biến nguồn tải/license của prototype thành production acquisition policy trong Phase D.
  - Blockers: Release/H/M vẫn phải provision nguồn hợp lệ trên cả ba OS và giữ provenance/license. Local D AC chỉ được tick sau `build:artifact` nhận explicit files, embed chúng, rồi artifact chạy với `/opt/homebrew` không được dùng làm runtime dependency.

2026-08-09 — Phase D, artifact input inventory (clean frozen VieNeu)
  - Files: temp-only `/tmp/vidcom-phase-d-artifact.*/production-inputs`, `TRANSFORMATION.md`, staged Python/VieNeu worker/package inventory, checklist và implementation notes
  - Summary: Cây spike 492 MB được copy/materialize ngoài repo: dereference interpreter cần thiết, bỏ mọi symlink còn lại, pip/ensurepip/scripts/packages và kiểm loại hardlink/special. Kết quả có 12.170 regular files, 1.246 directory, `bin/python3` arm64 mode 0755, đúng 55 distribution pin từ introspection và current `worker.py` regular.
  - Decisions: Builder chỉ nhận explicit input path và phải tự xác minh payload/inventory; không tin một config khai "55 package" nếu interpreter thực tế còn pip hoặc version lệch. Model weights được seed riêng vào temp app-data `models`, không bao giờ đưa vào runtime archive.
  - Blockers: Production acquisition/rebuild script cho ba OS thuộc H/M; local D có input sạch để tái chạy exact builder. Offline probe trả ready/14 voice/revision pin và synth WAV PCM 48 kHz mono 3,52 giây trên private PATH; chưa tick AC cho tới production artifact render.

2026-08-09 — Phase D, artifact input inventory (frozen Python native closure)
  - Files: temp-only `/tmp/vidcom-phase-d-artifact.*/production-inputs/TRANSFORMATION.md`, 203 Mach-O payload files, checklist và implementation notes
  - Summary: Inspect 203 Mach-O (189 `.so`, 12 dylib, 2 executable): 198 arm64-only + 5 universal, toàn bộ có arm64. 318 load edge chỉ gồm 313 system + 5 relocatable-contained; không external absolute/bare-relative. 12 dylib ctypes-load và 188 extension direct-import không có dyld failure.
  - Decisions: Đây là evidence cho explicit local input, không thay builder verification/provenance và không suy portability sang OS khác. Audit chạy không sinh cache bền; tree được dọn lại 7.652 regular file/760 directory, không pycache/pyc/link/special.
  - Blockers: Không có dylib blocker local cho Python. Production artifact vẫn phải stage/hash/probe chính tree này và final private-PATH render; H/M vẫn cần input/provenance tương đương cho Linux/Windows.

2026-08-09 — Phase D, artifact bootstrap review (product validation + module containment)
  - Files: `packages/cli/src/{sea-bootstrap,bootstrap-coordinator}.ts`, narrow product-manifest validator, SEA bootstrap tests, checklist và implementation notes
  - Summary: Primary bootstrap gọi generic manager sau khi chỉ kiểm node/boot entry, nên candidate thiếu HyperFrames/drizzle vẫn publish current trước secondary coordinator từ chối. Loader secondary còn dùng normal Node module paths, cho phép missing dependency leo lên `<version>/node_modules`, native ancestors hoặc checkout/NODE_PATH ngoài verified archive.
  - Decisions: Một product-manifest prevalidator compiler/runtime-safe được dùng **trước side effect** ở cả primary và full coordinator. Stage-two loader chỉ cho builtin hoặc canonical module path nằm trong verified node archive; constraint phải sống xuyên toàn secondary graph, không chỉ lọc `module.paths` của entry rồi để child module leo lại.
  - Blockers: Cold fixture phải trở thành product-complete. Regression prior-good + node-only/missing-drizzle giữ nguyên current và có zero extraction/migration; dependency chỉ tồn tại ở ancestor/NODE_PATH phải fail có mã, không chạy marker ngoài archive.

2026-08-09 — Phase D, artifact bootstrap review (complete product entry contract)
  - Files: `packages/adapter/src/runtime/packaged-runtime-manifest.ts`, primary/coordinator fixtures, checklist và implementation notes
  - Summary: Shared validator mới đã chặn archive thiếu hẳn, nhưng chỉ yêu cầu boot + một migration và HyperFrames fixed + một motion entry. Candidate vẫn có thể bỏ FFmpeg/FFprobe/esbuild, interpreter/worker, migration class hoặc 4/5 motion payload rồi publish current.
  - Decisions: Pre-side-effect contract phải liệt kê exact platform-critical entry classes, migration set và catalogue/native closure được product cần; không đợi filesystem path resolver hoặc render mới phát hiện.
  - Blockers: Negative matrix bỏ từng class từ manifest hợp lệ phải cho archive read/extract/current/migration zero và prior current byte-identical.

2026-08-09 — Phase D, artifact bootstrap/verifier review (exact migration set)
  - Files: shared packaged-runtime contract, `packages/adapter/src/runtime/packaged-runtime-manifest.ts`, `scripts/verify-artifact.mjs`, checklist và implementation notes
  - Summary: Required-list check không cấm extra `drizzle/*/migration.sql`; migration reader enumerate mọi subdirectory, nên SQL 2099 được thêm nhất quán vào stage/tar/manifest có thể chạy trên DB người dùng.
  - Decisions: Export một exact set 13 migration SQL dùng chung cho primary/coordinator/verifier; từ chối mọi extra Drizzle path, không ship snapshot runtime không đọc.
  - Blockers: Consistent injected migration phải bị từ chối trước archive read/publication/database; prior current và SQLite migration count giữ nguyên.

2026-08-09 — Phase D, artifact bootstrap review (authenticated transitive code)
  - Files: `packages/cli/src/sea-bootstrap.ts`, manifest-backed module loader tests, checklist và implementation notes
  - Summary: Warm manager tin ready marker; primary chỉ hash `boot.cjs`. Module hook containment vì vậy vẫn chạy transitive dependency bị sửa tại chỗ dưới node root dù manifest entry hash không còn khớp.
  - Decisions: Mọi non-builtin code load từ secondary phải được authenticate bằng entry size/hash/mode trước evaluation (on-demand hoặc full verified code closure). Marker chỉ là publication state, không là digest.
  - Blockers: Sau install hợp lệ, sửa declared transitive module nhưng giữ marker; boot phải coded-fail và external execution marker vắng. Prior/tampered bytes không được chạy.

2026-08-09 — Phase D, artifact bootstrap review (validated cross-archive imports)
  - Files: `packages/cli/src/{sea-bootstrap,node-sentinel}.ts`, two-archive real-fs integration, checklist và implementation notes
  - Summary: Hook containment chỉ đăng ký node archive nên chặn dynamic import hợp lệ từ secondary graph sang verified sibling `hyperframes/bin/hyperframes.mjs`; packaged reporter/render re-entry vì vậy không thể chạy dù ancestor escape đã bị chặn.
  - Decisions: Loader authority là một validated product generation với exact canonical archive roots (hoặc explicit sentinel cross-archive entry), không phải một root node duy nhất. Mọi target vẫn phải declared/authenticated; ancestor/NODE_PATH ngoài generation bị từ chối.
  - Blockers: Integration extract node+HyperFrames thật, chạy sentinel/HyperFrames `--version` thành công và đồng thời chứng minh hostile ancestor module không load; final artifact browser/render smoke phải đi chính path này.

2026-08-09 — Phase D, artifact stager review (symlink source containment)
  - Files: `scripts/stage-artifact-runtime.mjs`, real-filesystem stager tests, checklist và implementation notes
  - Summary: `fs.cp({dereference:true})` biến mọi symlink thành regular payload, kể cả link trong Python/native source trỏ ra file hoặc directory ngoài source root. Final regular-tree validation chỉ thấy byte đã copy nên không phát hiện escape và có thể ship secret/host file.
  - Decisions: Walk bằng `lstat`; symlink chỉ được materialize nếu canonical target nằm trong canonical source root, không cycle và target type được hỗ trợ. Internal Python aliases được dereference hợp lệ; external link bị từ chối trước khi final stage/config thay đổi.
  - Blockers: Production stager chưa được chấp nhận tới khi real-fs external file/dir symlink regressions chứng minh không outside byte được stage và prior output còn nguyên; không mock `node:fs`.

2026-08-09 — Phase D, artifact stager review (hardlink + Bun owner graph)
  - Files: `scripts/stage-artifact-runtime.mjs`, Bun-layout/native-closure real-fs tests, checklist và implementation notes
  - Summary: Regular source hardlink `nlink=2` được copy thành file `nlink=1`, xoá bằng chứng alias tới inode ngoài tree. Resolver native closure lại neo mọi transitive package ở HyperFrames scope, nhưng Bun isolated đặt chúng dưới owner scope nên production stager không tìm thấy.
  - Decisions: Từ chối source hardlink trước khi đọc/copy. Resolve transitive packages từ từng owner package đã pin, không fallback checkout/global search path.
  - Blockers: Outside-hardlink secret fixture phải fail và giữ sentinel/prior outputs; real Bun-isolated graph phải resolve đủ native closure rồi chạy probe ngoài checkout fallback.

2026-08-09 — Phase D, artifact stager review (runtime-only external closure)
  - Files: `scripts/stage-artifact-runtime.mjs`, staged/archive purity + isolated cold-load tests, checklist và implementation notes
  - Summary: Whole-package copy của onnxruntime-node/common mang TS, declarations, source maps, build scripts và `sourceMappingURL`; production verifier đúng ra phải làm build đỏ, không được nới scanner để ship source.
  - Decisions: Runtime-only allowlist/pruner dựa trên actual resolved closure; giữ license/package/runtime JS/native binary, bỏ TS/declaration/map/build payload và strip map comments. Sau prune, cold-load mọi external từ isolated staged root.
  - Blockers: Stage/archive phải có zero `*.ts|*.tsx|*.d.ts|*.map` và zero `sourceMappingURL`, đồng thời external module probes vẫn xanh không fallback checkout.

2026-08-09 — Phase D, artifact stager review (Windows esbuild layout)
  - Files: `scripts/stage-artifact-runtime.mjs`, shared esbuild-path authority, Windows real-package tests, checklist và implementation notes
  - Summary: Stager tìm `@esbuild/win32-x64/bin/esbuild.exe` trong khi package thật và compiler preload dùng root `esbuild.exe`; runtime pruner lại bỏ mọi `.exe`. Windows build vì vậy thiếu binary dù fixture tự chế `bin/esbuild.exe` xanh.
  - Decisions: Dùng một platform resolver: Windows package-root `esbuild.exe`, POSIX `bin/esbuild`; chỉ approved Windows binary được giữ/copy, không nới toàn bộ `.exe`.
  - Blockers: Real Windows package fixture/CI phải chốt standalone `node/bin/esbuild.exe`, cả hai node_modules copies và emitted compiler probe; synthetic wrong-layout fixture bị loại.

2026-08-09 — Phase D, artifact stager review (sanitized portability probes)
  - Files: `scripts/stage-artifact-runtime.mjs`, staged native/Python/media hostile-env tests, checklist và implementation notes
  - Summary: Runtime probes kế thừa full parent env, nên loader paths, Python/Node search vars hoặc host PATH có thể cứu missing external dependency và cho build xanh giả; Darwin cũng mới inspect media, không toàn Python/native closure.
  - Decisions: Probe bằng absolute staged commands trong private sanitized env với synthetic HOME/TMP và minimal OS vars; strip `DYLD_*`/`LD_*`, Python/Node module search cùng ambient secrets. Cold-load sharp/onnx/esbuild từ từng archive.
  - Blockers: External dylib/module chỉ có qua hostile env phải không cứu được stage; failure trước publication. Clean local input và CI từng OS phải probe xanh trong cùng env policy.

2026-08-09 — Phase D, artifact verifier review (đúng target, host và Node pin)
  - Files: `scripts/{build-root-provenance,build-artifact,build-sea,verify-artifact}.mjs`, build/provenance tests, checklist và implementation notes
  - Summary: Verifier cũ chưa quét primary SEA main hoặc final executable; build-root helper còn bỏ sót canonical URL encoding của `#`/`?`/`%` và JS-escaped Windows path. Host tag chỉ nhìn platform nên có thể gắn Darwin x64 vào Darwin arm64, còn build-sea copy Node hiện tại mà không so pin manifest.
  - Decisions: Scan primary, secondary, embedded asset inputs và final artifact; một helper canonical dùng URL/JSON semantics cho mọi build-root encoding. Resolve host bằng đúng cặp platform/arch và so normalized `manifest.versions.node` với `process.version` trước mọi output mutation.
  - Blockers: Pipeline chưa được chấp nhận tới khi synthetic Windows path regressions, primary/final-only forbidden marker, unsupported architecture và Node-version mismatch đều fail closed mà không để output dở.

2026-08-09 — Phase D, artifact provenance review (representation-safe rewrite)
  - Files: `scripts/build-root-provenance.mjs`, primary/secondary executable bundle tests, checklist và implementation notes
  - Summary: Rewriter dùng một replacement `/vidcom` cho cả filesystem path và full file URL. `fileURLToPath("file:///Users/builder/vidcom/…")` vì vậy thành `fileURLToPath("/vidcom/…")` và ném `ERR_INVALID_URL` dù source-root absence test xanh.
  - Decisions: Mapping theo representation: canonical file URL thành URL hợp lệ (`file:///vidcom`), native/slash path thành `/vidcom`; không replace đồng nhất chỉ để sạch scanner.
  - Blockers: POSIX/Windows URL expressions phải parse/run sau rewrite và primary/secondary actual boot phải xanh; string-absence một mình không đủ đóng build purity.

2026-08-09 — Phase D, artifact stager review (destination và single-file authority)
  - Files: `scripts/stage-artifact-runtime.mjs`, real-filesystem stager tests, checklist và implementation notes
  - Summary: Ngoài tree copy, các single-file source đang `realpath` rồi mất bằng chứng symlink ngoài; output/config parent chain chỉ check lexical nên symlink parent có thể chuyển atomic write/rename/rm ra ngoài build root. Config/pins cũng chưa được chứng minh disjoint với mọi input.
  - Decisions: Lstat original single-file và canonical-contain dưới source authority; output parent phải là directory thật, không link/special và canonical-contained. Mọi input/output/config/pin path pair phải disjoint trước khi đọc hay commit.
  - Blockers: Cần real-fs regression external file/dir/single-file symlink, symlinked destination parent và config alias input; failure phải giữ nguyên external sentinel cùng prior stage/config.

2026-08-09 — Phase D, artifact stager review (exact CPython build pin)
  - Files: `scripts/stage-artifact-runtime.mjs`, runtime staging schema/tests, checklist và implementation notes
  - Summary: Probe `python --version` chỉ trả 3.12.13 rồi stager ghi cùng chuỗi, trong khi Design pin standalone build `3.12.13+20260805`. Hai payload khác build revision có thể cùng language version và hiện không phân biệt được.
  - Decisions: Explicit input phải kèm release identity hoặc digest kiểm được; stager xác minh trước commit và giữ exact build pin trong manifest, không rút gọn contract để vừa probe.
  - Blockers: Production stage chưa được chấp nhận tới khi wrong-build/same-language-version fixture fail trước mutation và prior stage/config còn nguyên.

2026-08-09 — Phase D, artifact stager review (media và VieNeu worker byte authority)
  - Files: `scripts/stage-artifact-runtime.mjs`, explicit runtime-input schema/tests, checklist và implementation notes
  - Summary: FFmpeg/FFprobe paths chỉ được hỏi self-reported version nên executable khác byte vẫn ship được; explicit VieNeu root có thể đưa worker cũ/tùy ý dù Python packages đúng pin.
  - Decisions: Media input mang approved version + SHA-256 và được hash trước/sau copy/probe. Worker lấy từ repository-owned asset hoặc exact digest, không suy authority từ package `vieneu==3.2.4`.
  - Blockers: Wrong-byte/same-version media và one-byte worker drift phải fail trước mutation, giữ nguyên prior stage/config; exact shipped bytes phải khớp pins.

2026-08-09 — Phase D, artifact stager review (full frozen-Python tree digest)
  - Files: explicit runtime-input schema, `scripts/stage-artifact-runtime.mjs`, deterministic tree-digest tests, checklist và implementation notes
  - Summary: Chỉ interpreter SHA và package name/version không authenticate hàng nghìn Python/native files được ship; sửa một module VieNeu/torch/onnx nhưng giữ interpreter/metadata vẫn tạo archive+manifest mới “hợp lệ”.
  - Decisions: Bind acquisition/prepared input bằng deterministic full-tree digest (canonical relative path, mode, size, file hash); verify source trước copy và staged/pruned tree theo exact approved contract. Metadata là inventory, không là checksum.
  - Blockers: Non-interpreter module one-byte mutation với cùng versions phải fail trước publication; clean local tree cần pin mới được dùng cho production build. Native Bun package lock integrity được giữ làm gate L.1 theo thứ tự phase.

2026-08-09 — Phase D, artifact stager review (Darwin dylib closure)
  - Files: `scripts/stage-artifact-runtime.mjs`, Darwin media inspection tests, checklist và implementation notes
  - Summary: Inspector cho phép `@rpath`/`@loader_path`/`@executable_path` nhưng stager chỉ copy hai executable, không mang dylib closure và không đọc `LC_RPATH`. Binary có Homebrew rpath vì vậy build xanh rồi hỏng/thoát authority trên máy sạch.
  - Decisions: Với policy single-file hiện tại chỉ cho dependency tuyệt đối dưới `/usr/lib` và `/System/Library`; relative install-name bị từ chối. Chỉ được nới khi companion dylib được stage/hash/inspect đệ quy như first-class payload.
  - Blockers: Synthetic hoặc real `@rpath` + Homebrew `LC_RPATH` phải fail trước output mutation; cặp media local cuối phải pass và không có runtime linkage ngoài system roots.

2026-08-09 — Phase D, artifact stager review (single-generation publication)
  - Files: `scripts/{stage-artifact-runtime,build-runtime-archives}.mjs`, real-filesystem crash/failure tests, checklist và implementation notes
  - Summary: Stager publish output tree trước, rồi pins, rồi config. Lỗi/kill sau commit có thể để new tree + new pins + old config; archive builder sau đó vẫn đọc old paths ổn định và phát hành new bytes dưới old provenance.
  - Decisions: Tree, pins và config phải cùng một generation publication. Ưu tiên đặt cả ba trong một generation directory rồi atomically publish một boundary; nếu tách phải có generation ID/digest cùng recovery khiến consumer từ chối mix.
  - Blockers: Real-fs failure/SIGKILL sau mỗi postcommit boundary phải cho prior/new generation hoàn chỉnh hoặc fail-closed; test tiếp theo chứng minh builder không thể consume mixed generation.

2026-08-09 — Phase D, artifact stager review (authenticated recovery + concurrent commit)
  - Files: `scripts/stage-artifact-runtime.mjs`, generation journal/recovery/concurrency tests, checklist và implementation notes
  - Summary: Recovery từng thấy journal + destination/backup rồi xoá backup chỉ vì destination là directory thật; empty/attacker destination sau SIGKILL làm mất prior generation. Hai commit cùng process lại cùng PID nên commit sau có thể nhầm journal sống là recoverable.
  - Decisions: Journal bind process-start + transaction nonce/generation digest; recovery validate exact marker/config/pins/tree trước chọn new, ngược lại restore prior/fail closed. Serialize in-process commit bằng mutex/active registry.
  - Blockers: Crash fixture với empty substituted destination phải giữ/restore prior; deterministic two-commit barrier không được để transaction sau xóa/restore transaction đang sống.

2026-08-09 — Phase D, frontend pack review (atomic pair + semantic verification)
  - Files: `scripts/build-frontend-pack.mjs`, `scripts/verify-artifact.mjs`, real-fs pack/publication tests, checklist và implementation notes
  - Summary: Pack và manifest từng ghi độc lập; raw fs error ở manifest bị top-level catch nuốt exit code, để new pack + old manifest mà build-artifact tiếp tục. Verifier chỉ scan file, không validate index offsets/hashes với pack.
  - Decisions: Publish pack+manifest như một generation atomic/recoverable; mọi rejection exit nonzero. Verifier đọc lại entry set, offset/length và hash trên actual pack trước SEA claim.
  - Blockers: Prior pair + second-write EACCES/SIGKILL phải giữ prior hoặc complete new; mixed pair/malformed offsets/hash drift bị verifier từ chối trên filesystem thật.

2026-08-09 — Phase D, frontend pack closure (atomic pair + source-tree fail-closed)
  - Files: `scripts/build-frontend-pack.mjs`, `tests/build/frontend-pack.test.ts`, checklist và implementation notes
  - Summary: Journal hash-bind pair cũ/mới, rollback/recovery sau EACCES/abrupt process exit; paths disjoint, canonical-contained, parent không symlink. Export traversal lstat và reject symlink/FIFO/special thay vì silently skip.
  - Decisions: Pair-specific publisher giữ riêng vì publication là hai file, nhưng cùng invariant generation/journal/foreign-path của directory publishers. Chỉ ENOENT được gọi “not built”; integrity error không bị đổi nghĩa.
  - Blockers: Không có cho producer. Focused frontend+provenance 40/40, typecheck/lint/boundaries/diff-check xanh. Full combined verifier/publisher gate và artifact smoke vẫn mở ở parent.

2026-08-09 — Phase D, artifact pipeline review (exit code, secret vocabulary, end-to-end generation)
  - Files: `scripts/{build-cli-bundle,build-sea-bootstrap,build-runtime-archives,build-sea,verify-artifact}.mjs`, artifact provenance/transaction tests, checklist và implementation notes
  - Summary: Top-level rejection có thể bị `.catch(() => {})` nuốt rồi exit 0; scanner thiếu GitHub/Anthropic/Hugging Face token shapes; artifact manifest/JSON thiếu tool versions và archive hashes. Archives, SEA executable và provenance outputs còn overwrite tuần tự nên late failure trộn generation.
  - Decisions: Mọi rejected promise làm process nonzero; secret vocabulary bao phủ credential classes build có thể mang; manifest phát hành chứa exact versions/hashes. Publication atomic/recoverable xuyên archive set → SEA → manifest/SHA, consumer từ chối mix.
  - Blockers: Raw fs/JSON rejection process test, token fixtures, L.2 manifest assertions và failure/SIGKILL matrix ở từng output boundary phải xanh; stale outputs không được giúp build tiếp tục.

2026-08-09 — Phase D, artifact CLI review (missing flag value fail-before-side-effect)
  - Files: `scripts/build-artifact.mjs`, CLI orchestration tests, checklist và implementation notes
  - Summary: `build-artifact --runtime-inputs` thiếu value bị coi như không truyền flag, nên static export/frontend/secondary bundle đã chạy trước khi default input thiếu làm command đỏ. Nếu default file có sẵn, lệnh typo còn có thể build nhầm artifact.
  - Decisions: Validate mọi flag/value và target host trước khi lập/chạy step graph; chỉ absence thật của flag mới dùng default. Invalid invocation không được spawn hoặc tạo output.
  - Blockers: Regressions cho `--runtime-inputs`/`--target` thiếu value và value nhìn như flag phải exit nonzero với zero step/output side effect.

2026-08-09 — Phase D, artifact verifier review (archive semantics + machine JSON)
  - Files: `scripts/{build-artifact,verify-artifact}.mjs`, production extractor/real-fs verifier tests, checklist và implementation notes
  - Summary: Verifier từng chỉ hash tar ngoài và so stage riêng, nên literal non-tar cũng pass. `build-artifact --json` lại inherit stdout của mọi child rồi in object tối giản, không phải một machine-readable artifact manifest.
  - Decisions: Extract/read chính produced tar qua production contract trên temp filesystem và so exact entries/path/bytes/modes. JSON mode capture/redirect child stdout, chỉ in một artifact manifest đủ tool versions, archive hashes và final executable digest; progress ở stderr.
  - Blockers: Malformed/non-tar, traversal/link/special, entry drift/mode drift phải fail; spawned JSON test parse toàn stdout thành đúng một document có exact L.2 fields bound với embedded runtime manifest/SHA256SUMS.

2026-08-09 — Phase D, artifact verifier review (independent product allowlist)
  - Files: `scripts/verify-artifact.mjs`, archive-specific policy + consistent-mutation tests, checklist và implementation notes
  - Summary: Equality stage↔tar↔manifest vẫn pass nếu cả ba cùng chứa source/host file ngoài product. Verifier chưa có independent allowed path/extension contract, nên benign `.ts`, `.d.ts`, `.map` hoặc source/build/test tree không có magic marker có thể ship.
  - Decisions: Enforce policy theo archive/prefix: frozen Python được `.py` trong bounded root; node_modules/HyperFrames từ chối TS/TSX/declaration/map và source/build/test payload, đồng thời yêu cầu exact product entry classes. Không tin stager là policy duy nhất.
  - Blockers: Regression thêm cùng forbidden entry vào stage+tar+manifest với valid hashes vẫn phải fail; required runtime cold-load/render không bị allowlist cắt nhầm.

2026-08-09 — Phase D, artifact verifier review (product completeness, không chỉ no-extra)
  - Files: `scripts/verify-artifact.mjs`, shared packaged-runtime validator, delete-each-class tests, checklist và implementation notes
  - Summary: Generic manifest parse + allowlist/equality từ chối extra nhưng không bắt required entry bị xoá nhất quán khỏi stage/tar/manifest; artifact có thể publish rồi primary mới fail trên máy người dùng.
  - Decisions: Verifier/builder gọi canonical product completeness contract cho đúng host trước SEA/final publication, cùng authority với primary/coordinator.
  - Blockers: Xoá lần lượt migration, media, Python/worker, HF CLI/runtime, native closure hoặc motion catalogue phải fail build với no final artifact; valid exact set vẫn xanh.

2026-08-09 — Phase D discovery for L.1 (frontend pack source-path allowlist)
  - Files: `scripts/verify-artifact.mjs`, real frontend pack purity tests, checklist và implementation notes
  - Summary: Frontend semantic verifier chấp nhận manifest entry `.map` nếu offsets/hash đúng; JSON map không có `sourceMappingURL` cũng qua forbidden-byte scan. Runtime allowlist không áp dụng cho frontend pack.
  - Decisions: Frontend manifest path policy độc lập từ chối `.map`, `.ts/.tsx/.d.ts` và source dirs phù hợp; comment regex chỉ là lớp thứ hai, không thay path policy.
  - Blockers: Real pack có `_next/static/app.js.map` ordinary JSON phải fail trước SEA; production export/pack vẫn xanh không sourcemap/source rời. Full claim thuộc L.1 theo thứ tự phase.

2026-08-09 — Phase D, artifact publisher review (foreign backup ownership)
  - Files: `scripts/{build-runtime-archives,artifact-publish}.mjs`, journal/recovery/SIGKILL tests, checklist và implementation notes
  - Summary: Recovery từng xoá mọi real directory ở reserved `.previous`/`.previous-<tag>` dù không có journal/identity, nên chỉ chạy build đã có thể xoá foreign/stale sentinel bytes.
  - Decisions: Orphan backup fail closed và được giữ nguyên. Trước rename, journal single-link bind transaction id cùng previous/next digest; recovery/concurrency chỉ thao tác generation khớp journal.
  - Blockers: Foreign backup fixtures phải được preserve+reject; SIGKILL ở từng rename/marker boundary và concurrent publisher phải phục hồi complete prior/new, không xoá unrelated directory.

2026-08-09 — Phase D, SEA builder review (immutable input snapshot)
  - Files: `scripts/build-sea.mjs`, SEA config/blob/final-asset verification tests, checklist và implementation notes
  - Summary: Builder hash shared primary/frontend/runtime files rồi blob process đọc lại mutable paths; concurrent swap có thể embed bytes B, restore A trước verifier và tạo executable khác provenance. Verifier chỉ đọc external files, không raw assets đã embed.
  - Decisions: Snapshot một private immutable generation của mọi SEA input, validate/hash snapshot và build blob chỉ từ snapshot dưới publication authority; sau blob/injection recheck hoặc inspect embedded raw assets.
  - Blockers: Deterministic swap-at-blob barrier phải fail hoặc final SEA raw assets khớp declared digests; không external A/final B split.

2026-08-09 — Phase D, artifact publisher review (concurrent same-tag writers)
  - Files: `scripts/{artifact-publish,directory-generation-publish}.mjs`, two-process concurrency/SIGKILL tests, checklist và implementation notes
  - Summary: Fixed `.build-<tag>` bị prepare thứ hai xoá dù writer đầu còn sống; shared journal thiếu owner PID/process-start/active guard nên recovery có thể rollback và xoá journal sống trước first rename.
  - Decisions: Mỗi build dùng unique generation; publication theo target có lock/owner identity+liveness và in-process guard. Observer không recover transaction owner còn sống.
  - Blockers: Two real processes barrier phải serialize/reject writer hai mà không chạm generation một; SIGKILL owner rồi recovery mới được chọn complete prior/new, không active deletion. Repro hai commit cùng dừng ở `afterJournal` đã làm commit sau mất `.build`, published directory biến mất và chỉ còn foreign `.previous`; regression cuối phải chứng minh luôn còn đúng một complete published generation.

2026-08-09 — Phase D, artifact CLI review (`--json` production path shape)
  - Files: `scripts/build-artifact.mjs`, main/nested-layout JSON integration, checklist và implementation notes
  - Summary: Main truyền artifact directory nhưng formatter dùng `dirname` như thể input là binary path, nên đọc manifest ở `dist/artifact/artifact-manifest.json` thay vì `<tag>/artifact-manifest.json`; helper test dùng shape khác và xanh giả.
  - Decisions: API path type phải unambiguous: nhận published directory và join trực tiếp, hoặc main truyền exact artifact path. Integration gọi production main/nested tag layout, không chỉ helper.
  - Blockers: `build:artifact --json` phải kết thúc 0 và stdout parse thành đúng một full manifest document sau real publication; missing manifest fail trước claim success.

2026-08-09 — Phase D discovery, deferred strict-order gate for Phase L (lock/tool provenance)
  - Files: `bun.lock`, artifact manifest/verifier/toolchain audit ở Phase L, checklist và implementation notes
  - Summary: Current pipeline chưa đối chiếu Bun 1.3.14, exact `tar@7.5.22`, postject bytes/version và native package versions với lockfile/provenance. Đây là gap thật của L.1/L.2, không phải điều kiện trực tiếp để chứng minh D artifact executable trên PATH sạch.
  - Decisions: Giữ thứ tự A→M: không tick/claim Phase L từ proof D. Artifact manifest D không được phát biểu full provenance; khi tới L phải mở audit exact lock/tool drift và bổ sung gate trước CI L.
  - Blockers: Phase L sẽ chưa done cho tới khi lockfile/tool mismatch fail, manifest chứa exact versions/hashes và tamper tests xanh trên artifact thật. D vẫn phải đóng executable/render AC độc lập trước.

2026-08-09 — Phase D discovery, deferred strict-order gates for L/M (semantic provenance + cross-OS closure)
  - Files: `scripts/verify-artifact.mjs`, `bun.lock`, SEA/bundler acquisition, packaged-smoke workflows, checklist và implementation notes
  - Summary: Frontend verifier chưa rederive MIME/cache policy; Bun/tar/postject/native integrity chưa bind đầy đủ và build spawns inherit ambient env. Darwin có otool proof local, còn ELF/PE closure cần clean native runners.
  - Decisions: Không chặn D local executability nếu exact mac artifact render xanh và không leak được scan. Khi tới L, rederive MIME/cache bằng runtime authority, pin/verify Bun 1.3.14, tar 7.5.22, postject/native integrities và đánh giá sanitized build env. M/three-OS packaged smoke chốt Linux/Windows dependency closure.
  - Blockers: L.1/L.2 không được coi done trước semantic tamper + lock/tool mismatch gates; M không done trước artifact smoke clean trên cả ba OS. Không dùng local D proof thay các gate đó.

2026-08-09 — Phase D truth-maintenance for Phase L ordering (reopen L.6)
  - Files: checklist và implementation notes
  - Summary: Audit Phase D đã mở lại L.1/L.2 vì còn provenance/tool-lock gates thật. L.6 từng xanh từ lần chạy sớm, nhưng luật checklist yêu cầu L.6 làm sau cùng nên giữ `[x]` lúc L.1/L.2 lại mở sẽ phát biểu sai thứ tự thực thi.
  - Decisions: Đổi L.6 và Acceptance Criteria `test:spec-paths` về `[ ]`; giữ số 80 → 115 như bằng chứng lịch sử, rồi chỉ tick lại sau L.1–L.5 và focused/gates Phase L xanh.
  - Blockers: Không chặn Phase D executability; đây là invariant tài liệu cho Phase L. Không nới hoặc xoá registration hiện có.

2026-08-09 — Phase D, artifact publisher review (journal phải bind toàn payload)
  - Files: `scripts/directory-generation-publish.mjs`, artifact/runtime publisher tests, checklist và implementation notes
  - Summary: Shared publisher chỉ hash authority manifest. Nếu executable hoặc archive đổi byte sau khi journal được ghi nhưng manifest chưa đổi, commit/recovery vẫn nhận generation mới và xoá prior-good dù manifest không còn mô tả payload thật.
  - Decisions: Journal/commit/recovery phải bind digest của toàn generation hoặc chạy authority-aware validation manifest→mọi payload ngay trước và sau rename. Lock owner/liveness không thay thế payload authentication; cần cả hai invariant.
  - Blockers: Deterministic mutation ở `afterJournal` và từng rename boundary phải fail/rollback hoặc commit đúng declared bytes; artifact executable và runtime tar ngoài authority file đều nằm trong digest. Recovery không được xoá prior backup khi candidate payload drift.

2026-08-09 — Phase D, Task D.3b test-fixture drift after exact product prevalidation
  - Files: `tests/cli/mcp-commands.test.ts`, `tests/support/runtime-fixture.ts`, checklist và implementation notes
  - Summary: MCP artifact integration còn dựng node/HyperFrames archive tối giản. Bootstrap nay đúng khi prevalidate exact media/Python/worker/native/migration/motion contract trước side effect, nên fixture cũ có thể fail `runtime_manifest_invalid` trước assertion prepare/migrate once-only.
  - Decisions: Nâng fixture bằng canonical `productRuntimeFixtureEntries`; không nới validator và không tạo một product-contract copy thứ hai trong test. Giữ SQLite/filesystem thật và đếm migration/bootstrap như mục đích ban đầu.
  - Blockers: Focused `mcp-commands` phải xanh với exact product fixture; missing-class vẫn phải fail trước publication/migration trong canonical validator suite.

2026-08-09 — Phase D, Task D.3b exact product fixture closure
  - Files: `tests/cli/mcp-commands.test.ts`, canonical runtime fixture helper, checklist và implementation notes
  - Summary: MCP artifact integration dùng canonical node/HyperFrames/native product entries cùng shipped migrations thật; không còn archive tối giản bypass hoặc chết trước assertion mục tiêu.
  - Decisions: Giữ one-source product contract từ helper chung. Test vẫn đo bootstrap/migration đúng một lần trên temp filesystem + SQLite thật và prior-current fail-closed.
  - Blockers: Không có cho fixture. Focused 26/26, typecheck, scoped lint, boundaries và diff-check xanh. D.3b tổng thể vẫn chờ combined artifact publisher/SEA gates.

2026-08-09 — Phase D, artifact publisher review (torn journal + partial backup cleanup)
  - Files: `scripts/directory-generation-publish.mjs`, real child crash/recovery tests, checklist và implementation notes
  - Summary: Ghi trực tiếp final transaction JSON có thể để journal rỗng/cụt khi kill/ENOSPC và làm mọi lần recovery sau chết ở JSON parse. Nhánh committed-new lại xoá backup đệ quy trước journal; kill giữa xoá để partial backup khiến recovery không validate được prior dù new published còn tốt.
  - Decisions: Journal phải publish atomic từ temp file đã flush dưới owner lock. Backup cũ phải được rename atomically khỏi authoritative backup path trước khi clear journal; cleanup retired generation chỉ best-effort sau commit, không nằm trên đường recovery bắt buộc.
  - Blockers: Real child kill/torn-write fixtures phải chứng minh restart không kẹt vĩnh viễn; kill ở từng cleanup boundary vẫn cho complete new hoặc prior, không partial backup dưới tên authority.

2026-08-09 — Phase D, SEA immutable-input snapshot closure
  - Files: `scripts/build-sea.mjs`, `scripts/verify-artifact.mjs`, `tests/build/{sea,artifact-provenance}.test.ts`, checklist và implementation notes
  - Summary: Builder mở và bind sáu input chính xác, copy qua file descriptors sang private `.sea-inputs`, ghi byte/SHA manifest, revalidate identity trước seal và trước/sau blob+inject. SEA config chỉ trỏ snapshot; verifier đọc cùng snapshot rồi xoá trước publication.
  - Decisions: Original source có thể đổi sau seal mà không đổi byte được embed; đổi trong lúc copy hoặc tamper snapshot phải fail. Symlink, hardlink và noncanonical input bị từ chối thay vì snapshot theo.
  - Blockers: Không có cho SEA input TOCTOU. Focused SEA+provenance 38/38, typecheck, scoped lint và boundaries xanh. Còn chờ explicit unique generation API từ publisher để chạy combined/full production build.

2026-08-09 — Phase D, Task D.3b + artifact generation publisher closure
  - Files: `scripts/{directory-generation-publish,artifact-publish,build-runtime-archives,build-artifact,build-sea,verify-artifact}.mjs`, publisher/build/SEA tests, entrypoint/MCP fixtures, checklist và implementation notes
  - Summary: Mỗi artifact build có generation ID riêng xuyên orchestrator→SEA→verifier. Publisher dùng lock PID/start/token, từ chối owner sống, recovery owner chết, digest toàn path/mode/size/byte, journal atomic và backup retire bằng rename trước cleanup. Settings/backup/recovery/coordinator/SEA cùng exact runtime authority.
  - Decisions: PID đang sống luôn fail-closed kể cả khả năng reuse; cùng process có active guard. Candidate tamper được giữ ở generation path và prior-good phục hồi. Journal/tar/executable không dựa riêng manifest digest. Không nới boundary/lint/tools snapshot.
  - Blockers: Không có cho D.3b/publisher. Artifact combined 10 file, 127/127; typecheck; lint 0 error/3 warning có sẵn; boundaries và diff-check xanh. Phase D còn production artifact render AC.

2026-08-09 — Phase D production build discovery + fix (Python pin ordering)
  - Files: `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts`, checklist và implementation notes
  - Summary: Production `build:artifact` dừng ở staging: metadata probe sort package **name** trước khi nối `==version`, nhưng validator/evidence sort full pin. Cặp prefix `pydantic`/`pydantic-core` vì dấu `=` và `-` tạo thứ tự khác, nên exact 55-package tree luôn bị báo không sorted dù unique.
  - Decisions: Probe sort chính full `name==version` mà contract kiểm; không reorder input để che producer drift và không nới unique/sorted gate. Thêm regression prefix-name.
  - Blockers: Build phải chạy lại từ đầu với cùng input SHA/tree. Staging chỉ được qua nếu runtime introspection khớp exact evidence sau fix.

2026-08-09 — Phase D production build discovery + fix (portable archive modes)
  - Files: `scripts/stage-artifact-runtime.mjs`, native-closure/stager tests, checklist và implementation notes
  - Summary: Production build đi qua SEA injection rồi verifier bắt source esbuild/semver `0777` trong staged Bun store nhưng tar portable ghi `0755`; bytes/hash khớp, manifest mode từ raw stage không khớp mode thực được extract.
  - Decisions: Native runtime closure canonicalize file có execute bit thành `0755`, file còn lại `0644` ngay tại stager. Không bỏ mode khỏi manifest/verifier và không special-case một package; tar chỉ nhận modes portable đã chốt.
  - Blockers: Rerun real native closure phải chứng minh không file nào group/world-writable; production build lại từ đầu phải qua exact tar extraction/mode verifier.

2026-08-09 — Phase D production build discovery + fix (canonical entry ordering)
  - Files: `scripts/verify-artifact.mjs`, `tests/build/artifact-provenance.test.ts`, checklist và implementation notes
  - Summary: Production verifier báo stage lệch manifest dù node archive có cùng đúng 7.836 path. Manifest được sort theo full UTF-8 path, còn stage/tar giữ DFS; cặp prefix directory như `annotated_doc/` và sibling `annotated_doc-0.0.5.dist-info/` làm thứ tự khác nhưng set/bytes không khác.
  - Decisions: `assertFilesMatchEntries` canonicalize cả actual files và expected entries bằng cùng full-path UTF-8 comparator trước so path/hash/mode. Không bỏ exact-set/hash/mode checks và không sửa manifest để khớp traversal tình cờ.
  - Blockers: Không có cho verifier ordering. Regression prefix-directory xanh trong artifact provenance 26/26; production artifact phải chạy lại từ đầu để chứng minh tar/stage/full verifier xanh.

2026-08-09 — Phase D production build discovery + fix (secondary sourcemap marker bytes)
  - Files: `scripts/build-cli-bundle.mjs`, `tests/build/cli-bundle.test.ts`, checklist và implementation notes
  - Summary: Production SEA đã inject thành công nhưng L.1 bắt hai literal `/*# sourceMappingURL=` nằm trong code PostCSS dùng để nhận/tạo annotation, gồm một bản trong HyperFrames runtime string. Không có `.map` output, nhưng shipped bytes vẫn vi phạm forbidden marker gate.
  - Decisions: Sau bundle, đổi `sourceMappingURL=` thành JavaScript escape tương đương `sourceMappingURL\x3d`; string và RegExp runtime vẫn tạo/match dấu `=` như cũ. Không nới scanner, không allowlist dependency và vẫn dùng `--sourcemap=none`.
  - Blockers: Không có cho secondary marker. Real emitted CJS test chứng minh byte marker không còn, string/RegExp semantics giữ nguyên và CLI bundle 15/15 xanh; production artifact phải rebuild/reverify.

2026-08-09 — Phase D production build discovery + fix (frozen Python console scripts)
  - Files: `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts`, production input evidence, checklist và implementation notes
  - Summary: L.1 bắt `python/bin/cffi-gen-src` có shebang tuyệt đối trỏ checkout spike. Frozen tree còn nhiều package/stdlib console scripts dù runtime VieNeu chỉ gọi exact `python/bin/python3 worker.py`; giữ scripts vừa leak build root vừa mở CLI/build surface không cần thiết.
  - Decisions: POSIX runtime chỉ giữ `bin/python3`; loại mọi sibling `bin/*`. Windows loại mọi `Scripts/*`; root `python.exe` vẫn giữ. Library/site-packages/native payload không đổi. Recompute `pythonRuntimeTreeSha256` bằng production copier+pruner thành `sha256:d62e8f…e99a`, không sửa source-tree pin.
  - Blockers: Không có cho console scripts. Focused stager 18/18, input 19-key parse xanh; production build phải xác minh exact new projection và full TTS offline runtime sau extraction.

2026-08-09 — Phase D production build discovery + fix (wheel RECORD false credential)
  - Files: `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts`, production input evidence, checklist và implementation notes
  - Summary: L.1 bắt chuỗi `hf_5PV…` trong `pytz.dist-info/RECORD`; đây là base64url SHA-256 của timezone file, không phải Hugging Face credential. Quét toàn frozen tree cho thấy chỉ đúng RECORD này trúng forbidden patterns.
  - Decisions: Không nới token scanner. Prune mọi `.dist-info/RECORD` vì đó là wheel installation inventory không cần cho import/version/synthesis; giữ `METADATA`, package code/native libraries và exact 55-distribution introspection. Runtime-tree digest đo lại bằng production helper thành `sha256:923842…f66d3`.
  - Blockers: Không có cho RECORD. Focused stager 18/18 và regression giữ `METADATA`; production build/TTS offline phải chứng minh package inventory và synth không phụ thuộc RECORD.

2026-08-09 — Phase D production build discovery + fix (host Node binary baseline scan)
  - Files: `scripts/verify-artifact.mjs`, `tests/build/artifact-provenance.test.ts`, checklist và implementation notes
  - Summary: Final executable scan bắt 6 AWS-shaped machine-code sequences và 4 sourcemap parser/example literals. Exact source Node 24.9.0 binary có cùng IDs, values và offsets; SEA final không thêm occurrence nào. Raw unique-ID scan không phân biệt pinned host baseline với VidCom-injected payload.
  - Decisions: Giữ scanner cho primary/secondary/frontend/runtime nguyên vẹn. Riêng final SEA, thu exact occurrence `(id, byte offset, match digest)` của source `process.execPath` và chỉ trừ tuple giống hệt; bất kỳ occurrence mới/đổi offset/đổi bytes từ injected assets vẫn fail. Không allowlist theo ID hoặc package.
  - Blockers: Không có cho baseline distinction. Regression chứng minh unchanged baseline + ordinary append xanh nhưng injected OpenAI-shaped key vẫn bị bắt; artifact provenance 27/27 và final failed-generation thực có additions `[]`. Production build phải rerun để publish.

2026-08-09 — Phase D Acceptance Criterion (production artifact render + narration)
  - Files: `dist/artifact/darwin-arm64/{vidcom,SHA256SUMS,artifact-manifest.json}`, production runtime archives, `/private/tmp/vidcom-phase-d-production-smoke.6mvwdf/EVIDENCE.md`, checklist, Design §16 và implementation notes
  - Summary: `build:artifact --json` publish final binary 336.205.200 bytes, SHA-256 `5b111f…e2bc0`; checksum/provenance và exact runtime archive verification xanh. Clean app-data cold-extract, serve/render bằng chính artifact dưới PATH chỉ có bốn OS helper và không tìm thấy node/python/python3. Output MP4 SHA `744c8c…bdc0`, H.264/AAC 5 giây, narration non-silent và correlation 0,991181 với only authored WAV.
  - Decisions: Prototype cũ không được dùng để tick; chỉ production published generation mới là authority. Browser cache seed chỉ tránh download lại, còn Node/FFmpeg/FFprobe/Python/worker đều dùng exact paths đã extract từ artifact. Post-validation correlation dùng decoded bytes, không nằm trong runtime path. Ghi riêng version display `not packaged` như finding deferred, không che nó bằng AC render.
  - Blockers: AC D không còn blocker. Frozen Python packaged probe offline ready/14 voice/engine 3.2.4; ports 53487/53491 đóng, PID auto daemon dừng và discovery record bị xoá. Phase D vẫn chờ focused/global gates + exact-HEAD CI ba OS trước khi chuyển E.

2026-08-09 — Phase D local verification gate
  - Files: Phase D production/test diff, checklist và implementation notes; generated `.next`/`out`/`dist` được bảo toàn tại `/private/tmp/vidcom-phase-d-production-smoke.6mvwdf/build-output-preserved`
  - Summary: Chạy lại official Phase D matrix 57/57 và expanded artifact matrix 129/129 sau production build. `typecheck`, `lint`, `test:boundaries`, `git diff --check` và `python3 -m py_compile packages/adapter/sidecars/vieneu/worker.py` đều xanh.
  - Decisions: ESLint ban đầu đỏ chỉ vì quét CJS generated trong sáu failed-generation và build output; không sửa/nới ESLint. Di chuyển chính xác ba thư mục gitignored `.next`, `out`, `dist` sang evidence root có thể phục hồi, giữ cả published binary/manifests và failed generations để audit.
  - Blockers: Local phase gate không còn blocker. Phase D vẫn đóng theo quy trình cho tới khi commit/push và GitHub Actions exact HEAD xanh trên Linux, macOS và Windows; MUST NOT bắt đầu E trước bằng chứng đó.

2026-08-09 — Phase D adversarial closeout (final SEA raw-asset identity)
  - Files: `packages/cli/src/sea-bootstrap.ts`, `scripts/{build-sea,verify-artifact}.mjs`, `tests/build/{sea,artifact-provenance}.test.ts`, Design §16, checklist và implementation notes
  - Summary: Audit bắt snapshot/input hash chưa chứng minh bytes postject thật sự embed. Final SEA nay có hidden integrity protocol chạy trước extraction, liệt kê exact raw-asset key/size/SHA; primary bundle cũng là một raw asset. Verifier thực thi chính candidate và so report với sealed snapshot trước publish.
  - Decisions: Không tin outer executable hash như bằng chứng nội dung; hash đó chỉ định danh một binary bất kỳ. Real tiny SEA dùng production primary, Node blob và pinned postject: generation A xanh, cố ý inject blob B nhưng verify snapshot A bị từ chối. Frontend provenance luôn build temp checkout mới, không reuse stale repo `out` và không để `.next/out` lại checkout.
  - Blockers: Raw-asset proof focused 55/55 sau khi sửa temp build; repo-root generated outputs không tái xuất hiện. Phase D vẫn chờ các blocker closeout publisher/CLI đang được xử lý, rồi toàn bộ gate + production rebuild/smoke + CI exact HEAD.

2026-08-09 — Phase D adversarial closeout (artifact generation capability)
  - Files: `scripts/{directory-generation-publish,artifact-publish,build-sea,verify-artifact}.mjs`, `tests/build/{artifact-publish,sea,runtime-assets-publish}.test.ts`, Design §16, checklist và implementation notes
  - Summary: Publisher lock bind PID với OS process-start identity và token; reused PID được reclaim, live owner không bị cướp. Atomic prepare trả generation + capability bind canonical parent chain và `dev/ino`; SEA builder/verifier revalidate trước/sau mọi mutation. Snapshot root phải absent, có identity riêng và cleanup chỉ chạy khi authority còn đúng.
  - Decisions: Giữ wrapper cũ cho caller không mutate, nhưng production SEA bắt buộc dùng atomic capability. Không cố “cleanup” qua path đã đổi vì chính cleanup đó có thể xoá external bytes; orphan an toàn được để recovery xử lý. Regression đổi generation thành junction/symlink ra external sentinel và đổi thành real directory mới đều fail trước write/remove/lock.
  - Blockers: Publisher focused 14/14 và combined SEA/CLI/publisher 84/84 xanh; typecheck/lint/boundaries của publisher xanh. Còn rerun toàn global matrix và production artifact exact HEAD.

2026-08-09 — Phase D adversarial closeout (CLI process boundary)
  - Files: `packages/cli/src/{main,boot}.ts`, `tests/cli/{cli-process-boundary,compiler-preload,sea-bootstrap}.test.ts`, checklist và implementation notes
  - Summary: `doctor` và `render` trả code `0/1/130` xuyên `runVidcomCli` → `runCliMain`; launcher chỉ publish một lần, không còn ghi đè lỗi thành 0. Compiler preload lỗi trước runtime graph trả đúng một dòng `compiler_unavailable` và code 1, không rò stack hay absolute checkout/runtime path.
  - Decisions: Chuẩn hoá preload ngay tại boot boundary trước dynamic import; không import runtime graph chỉ để format lỗi. Tests dùng child thật, temp filesystem + SQLite thật, và SEA archive delegate cho cả fail/cancel code.
  - Blockers: Focused 29/29, expanded CLI/build 137/137 và official D 57/57 xanh từ subtask; main vẫn phải rerun cùng exact SEA/publisher snapshot trước production rebuild.

2026-08-09 — Phase D documentation truth (adapter exports)
  - Files: `llm-documents/steering/02-project-layout.md`, `eslint.config.mjs`, checklist và implementation notes
  - Summary: Steering/comment cũ nói adapter chỉ có một export, trong khi C-10/C-11 đã thêm ba narrow bootstrap/compiler subpath. Wording nay phản ánh đúng public barrel + narrow CLI-only exports và giữ nguyên luật MCP cấm toàn bộ `@vidcom/adapter`/subpath.
  - Decisions: Chỉ sửa mô tả factually stale; không đổi pattern ESLint, không nới `verify-import-boundaries.mjs`, không mở package boundary mới.
  - Blockers: Không có; lint và boundaries sẽ được rerun trong final local gate.

2026-08-09 — Phase D second adversarial closeout (no out-of-generation write)
  - Files: `packages/cli/src/{sea-main-loader.cjs,sea-bootstrap.ts}`, `scripts/{artifact-layout,artifact-publish,build-sea,verify-artifact}.mjs`, `tests/build/{artifact-publish,sea,artifact-provenance}.test.ts`, Design §16, checklist và implementation notes
  - Summary: Review 26/26 xanh vẫn bắt năm lỗ: nested snapshot parent link ghi ra ngoài, executable/provenance follow link, verifier recapture generation mới, main A tự báo raw primary B, và prepare recapture root thay thế. Snapshot nay walk/lstat/realpath từng parent; mọi destination/provenance dùng exclusive create; exact original authority được serialize/restore qua process.
  - Decisions: Product primary không còn là SEA main được đọc hai lần. Main là loader built-in-only tối thiểu, lấy và thực thi chính raw primary; primary chỉ chấp nhận loader protocol marker. Authority record không chứa env/secret, schema exact ≤64 KiB và bị xoá trước publication. Cleanup mất capability để orphan an toàn thay vì follow path mới.
  - Blockers: Focused SEA/provenance/publisher 60/60, typecheck, lint 0 error/3 warning cũ và boundaries xanh. Independent re-review lần hai và production rebuild exact HEAD vẫn mở.

2026-08-09 — Phase D third adversarial closeout (active SEA resource extent)
  - Files: `scripts/{sea-resource,verify-artifact,build-sea}.mjs`, `tests/build/sea.test.ts`, Design §16, checklist và implementation notes
  - Summary: Review chứng minh phép tìm exact expected blob một lần trong executable vẫn sai: resource active có thể là `badBlob || expectedBlob`; Node đọc prefix và bỏ suffix, hidden raw-asset report vẫn xanh, bad main thật sự chạy, nhưng expected blob vẫn xuất hiện đúng một lần. Repro thật trên Node 24.9.0/Darwin ghi marker bad-main và old verifier chấp nhận.
  - Decisions: Không tin self-report hoặc substring làm main authority. Verifier parse đúng loader-selected extent của Mach-O/ELF/PE, bind file identity trước/sau, yêu cầu declared size + mọi byte khớp retained `.sea-prep.blob` bằng stream 1 MiB; malformed/ambiguous/unsupported container fail-closed. Không thêm dependency hoặc gọi host tool.
  - Blockers: Active-resource focused combined 61/61, typecheck, lint 0 error/3 warning có sẵn, boundaries và diff-check xanh. Independent parser re-review, toàn bộ local matrix và production rebuild/render exact HEAD vẫn mở trước Phase D CI.

2026-08-09 — Phase D fourth adversarial closeout (cross-process SEA byte continuity)
  - Files: `scripts/{sea-build-seal,build-artifact,build-sea,verify-artifact}.mjs`, `tests/build/{build-artifact,sea}.test.ts`, Design §16, checklist và implementation notes
  - Summary: Generation capability bind directory nhưng không bind hai child file qua ranh giới process. Nếu thay đồng thời executable và retained blob sau `build-sea`, verifier cũ có thể tự nhất quán với cặp thay thế và chạy main chưa được xác thực.
  - Decisions: Sau mutation cuối, `build-sea` phát đúng một strict JSON seal gồm tag/generation cùng byte-count + SHA-256 của cả artifact và blob. `build-artifact` giữ seal chỉ trong RAM và truyền canonical record thẳng cho verifier; không ghi seal thành authority file trong mutable generation. Verifier exact-schema/re-hash cả hai trước active-resource proof và trước mọi lần chạy candidate; coherent pair replacement, field thừa hoặc record sai generation đều fail và bad-main marker phải absent.
  - Blockers: SEA/orchestrator/provenance/publisher closeout xanh 83/83; independent parser/seal review xanh 67/67 cùng Node 24.9.0/postject thật trên Mach-O, ELF x64 và PE x64. Review kế tiếp bắt thêm check-then-spawn race nên proof này bị supersede bởi closeout thụ động dưới đây. Artifact AC vẫn mở.

2026-08-09 — Phase D fifth adversarial closeout (verifier không chạy candidate)
  - Files: `scripts/{sea-build-seal,sea-resource,verify-artifact}.mjs`, `tests/build/sea.test.ts`, Design §16, checklist và implementation notes
  - Summary: Re-hash pair ngay trước self-report vẫn đóng file handle rồi `spawn` mở lại pathname. Một coherent pair swap đúng khe này có thể cho bad main chạy side effect trước seal cuối báo lỗi; thêm check pathname không thể làm atomic.
  - Decisions: Bỏ candidate execution khỏi production verifier. Parse thụ động exact prep-blob format của Node 24.9 trên ba target 64-bit little-endian đã hỗ trợ; require magic/flags/extension, bounded size/count/range, EOF exact, main bytes và exact asset key/content đều khớp sealed snapshot. Parent seal bind blob/executable qua process; active-resource parser bind blob vào loader-selected executable extent; không còn verification-time turn cho candidate.
  - Blockers: Passive parser và deterministic after-last-check swap regression đã đóng candidate execution; review tiếp theo bắt authority của original snapshot input còn bị recapture, nên proof này bị supersede bởi closeout thứ sáu bên dưới. Full Phase D local matrix, exact-HEAD production rebuild/render và CI ba OS vẫn là gate bắt buộc.

2026-08-09 — Phase D sixth adversarial closeout (original SEA snapshot projection)
  - Files: `scripts/{build-sea,sea-build-seal,sea-blob,verify-artifact}.mjs`, `tests/build/{build-artifact,sea}.test.ts`, Design §16, checklist và implementation notes
  - Summary: Review bắt snapshot root identity/projection chỉ tồn tại trong lúc tạo snapshot. Đường assert sau đó từng recapture lexical `.sea-inputs` cùng manifest hiện tại; rename original root rồi đặt một snapshot thay thế tự nhất quán, đổi main và cập nhật manifest có thể được chấp nhận như chính snapshot ban đầu. Closure nay tạo projection chỉ từ in-memory copy records và truyền nó trong parent-held seal, nên lexical path/manifest không còn quyền định nghĩa lại expected input generation.
  - Decisions: Strict seal schema v1 có exact keys `artifact`, `blob`, `generationId`, `inputs`, `schemaVersion`, `tag`; `inputs` là `{codePath:".sea-inputs/main-loader.cjs",main:{bytes,sha256},assets:[{key,bytes,sha256}]}` với asset key unique và UTF-8 sorted. `build-sea` giữ original snapshot `dev/ino/birthtime` capability trước/sau blob/injection; verifier hash trực tiếp main/asset spans trong retained blob theo `seal.inputs`, so active executable resource, re-hash pair, rồi mới buộc current snapshot manifest/files khớp projection và capture root capability mới để bracket runtime/frontend/forbidden scans. Root replacement, same-root child + manifest replacement, coherent post-last-check artifact/blob replacement và malformed/missing/extra seal/input fields đều bị từ chối; bad-main marker vẫn `ENOENT`.
  - Blockers: Production closure checkpoint xanh: combined SEA/build-artifact/provenance/publisher 84/84; SEA 22/22; typecheck; lint 0 error/3 warning không liên quan; boundaries và full diff-check; không còn generated `.compiler-bundle` directory. Artifact AC tiếp tục `[ ]`; full Phase D local matrix, exact-HEAD production rebuild/render-smoke và GitHub Actions exact HEAD trên Linux/macOS/Windows vẫn là gate bắt buộc trước Phase E.

2026-08-09 — Phase L, Task L.1 + L.2 + L.6 (đóng phase)
  - Files: `scripts/verify-artifact.mjs`, `tests/build/artifact-provenance.test.ts`, checklist và implementation notes
  - Summary: Thêm `buildToolProvenance()` ràng buộc version công cụ build với pin đã khai, ghi `tools` vào artifact manifest, và cổng `--release` từ chối cây bẩn.
  - Decisions: So pin **đã khai** với bản **thật đang cài** cho `tar`, và đòi `postject` ghim đúng một version — ghi lại thôi thì không đủ, vì cả hai sai lệch đều cho ra artifact trông y hệt bản release nó tự nhận. Bun ghi lại chứ không so: nó là toolchain, không có dòng lockfile để đối chiếu. `dirty` vẫn được **ghi cho mọi người** và chỉ **bị từ chối ở `--release`**: người dựng cục bộ từ cây đã sửa nên nhận artifact kèm nhãn trung thực, còn bản release không gọi tên được commit thì không phải bản release.
  - Blockers: Không có; `tests/build/artifact-provenance.test.ts` 36/36, typecheck, lint 0 error, boundaries xanh, `test:spec-paths` 115 path trên 3 spec.

2026-08-09 — Phase M, gỡ blocker runtime: dựng thật frozen Python stack
  - Files: `scripts/build-runtime-inputs.mjs`, `tests/build/runtime-inputs.test.ts`, checklist và implementation notes
  - Summary: Tải **đúng** bản CPython đã pin, cài VieNeu, prune, và **tái lập chính xác** tập package mà evidence đã ghi. Thêm generator sinh `dist/runtime-inputs/<tag>.json` với mọi digest đo từ byte thật.
  - Decisions: Không bịa gì cả — evidence trong repo **chính là đáp án**, nên đây là tái lập chứ không phải sáng tác. `cpython-3.12.13+20260805-aarch64-apple-darwin` từ chính release astral-sh mà Design pin; `pip install -r sidecars/vieneu/requirements.txt` ra **77 package**, đúng con số Design đo; prune 21 gói + `pip` còn **55**, khớp `darwin-package-set-pruned.txt` **tuyệt đối 55/55**; cây 482 MB so với 481 MB Design ghi. Ba gói trôi version so evidence (`huggingface-hub` 1.27.0, `platformdirs` 4.11.1, `sea-g2p` 0.8.4) — **ghim về đúng bản evidence** thay vì sửa evidence: evidence là cái đã được review, không phải cái tiện sửa. Sau khi ghim: **0 lệch version, 0 gói thừa, 0 gói thiếu**. Generator validate bằng chính `parseRuntimeInputsValue` của staging và so với **host tag** chứ không so với giá trị nó vừa ghi — không có cross-build (DR-1), nên một file khai platform khác sẽ ghim byte của máy này dưới tên máy khác.
  - Blockers: **Còn đúng một thứ: FFmpeg/ffprobe static.** `build:artifact` giờ đi qua export → pack → bundle → staging và dừng ở `assertPortableDarwinDependencies`, thứ đã bắt đúng bản homebrew: **16 dylib không portable** (`libavcodec`, `libssl`, `libx264`, …). Gate hoạt động đúng như thiết kế. Chọn bản static nào để ship là **quyết định supply-chain**, cần người duyệt — MUST NOT tự chọn một mirror bên thứ ba thay mặt người dùng.

2026-08-09 — CI remediation ba OS (run trên `32c3d93`)
  - Files: `scripts/stage-artifact-runtime.mjs`, `scripts/build-runtime-inputs.mjs`, `tests/build/{runtime-inputs,artifact-provenance}.test.ts`, checklist
  - Summary: Đỏ **cả ba OS**, ba nguyên nhân khác nhau, không cái nào là flake.
  - Decisions: (1) **Test của tôi hardcode `darwin-arm64`** nên trên Linux nó trùng host và ca "từ chối cross-build" không bao giờ ném — đổi sang `hostPlatformTag()` cộng một tag chắc chắn khác host. (2) Fake binary trong test là shell script, **không chạy được trên Windows**; thêm seam `readVersion` để việc đọc version không phụ thuộc OS — một test chỉ chạy trên hai trong ba nền tảng không phải test của build này. (3) `next-env.d.ts` là file **sinh ra và bị gitignore**, nên checkout sạch không có; copy vô điều kiện làm test xanh trên máy dev và đỏ trên **mọi** runner. (4) `resolvePackageDirectory` chỉ quét `resolve.paths()`, mà package store keyed theo content hash đặt sibling ở chỗ danh sách đó không nhắc tới — hỏi Node trước bằng `resolve("<name>/package.json")`, giữ nguyên phần quét làm fallback vì `sharp` chặn manifest qua `exports`.
  - Blockers: Không có; full suite 1777 pass / 5 skip sau khi xoá `next-env.d.ts` để giả lập checkout sạch, typecheck, lint 0 error, boundaries xanh.

2026-08-09 — CI Linux/Windows: `nlink !== 1` áp nhầm lên đầu vào
  - Files: `scripts/stage-artifact-runtime.mjs`, checklist
  - Summary: Ba vòng CI đỏ với "required package sharp is not installed" trong khi macOS xanh. Không phải thiếu gói.
  - Decisions: Thêm diagnostic in ra **những thư mục đã tìm** thay vì đoán vòng thứ tư — và nó cho thấy thư mục **có tồn tại**. Nguyên nhân thật: `assertRegularFile` đòi `nlink === 1`, mà **Bun hardlink package từ cache toàn cục trên Linux**, nên mọi `package.json` trong `node_modules` có nlink ≥ 2 và bị từ chối. macOS xanh vì cùng installer đó **copy** thay vì hardlink. Luật một-liên-kết **đúng cho thứ build phát hành** (file staged có tên thứ hai thì ghi đè được qua tên kia sau khi đã verify — lỗ hổng provenance) nhưng **sai cho thứ build đọc vào**. Tách hai vai bằng tham số `shared`, không nới luật ở chỗ nó thuộc về.
  - Blockers: Không có; `tests/build/stage-artifact-runtime.test.ts` 18/18, full suite xanh, typecheck và lint 0 error.

2026-08-09 — Phase M, FFmpeg dựng từ source xong (darwin-arm64)
  - Files: `scripts/build-ffmpeg.mjs`, checklist
  - Summary: `ffmpeg`/`ffprobe` 7.1.1 static, **không một dependency ngoài System framework**, đủ cả năm encoder pipeline cần (`libx264 libx265 libvpx-vp9 libopus aac`).
  - Decisions: Source ghim bằng URL **và** digest, mọi digest **đo bằng cách tải thật**; FFmpeg đối chiếu thêm với giá trị project công bố, x264 tải hai lần để xác nhận archive byte-stable. x264 ghim theo **commit** vì nó không phát hành tarball và `stable` là nhánh động. Bốn lần x265 hỏng, mỗi lần một gốc khác, đã ghi hết vào script: script nuốt lỗi bằng `;` (rồi FFmpeg lặng lẽ link dylib homebrew), `cmake_policy(SET ... OLD)` bị CMake 4 từ chối, `cmake_minimum_required` quá cũ, và NEON aarch64 không compile với Apple clang hiện tại. **`PKG_CONFIG_LIBDIR` chứ không chỉ `PKG_CONFIG_PATH`** — pkg-config giữ danh sách mặc định riêng, và đó là đường một build "static" vẫn nuốt dylib hệ thống.
  - Blockers: **Đánh đổi cần duyệt**: assembly của x265 bị tắt ⇒ HEVC encode chậm hơn. Đây là mất mát hẹp hơn — x264 giữ nguyên assembly và H.264 là codec pipeline dùng mặc định. Runtime tree giữ **ngoài repo** (`/tmp/vidcom-runtime`, `/tmp/vidcom-ffmpeg`) sau khi lệnh dọn `dist/` cho lint xoá mất cây Python 482 MB một lần.

2026-08-09 — Phase M: artifact thật đầu tiên, và luật hardlink áp nhầm lần hai
  - Files: `scripts/stage-artifact-runtime.mjs`, `scripts/build-runtime-inputs.mjs`, `tests/build/artifact-provenance.test.ts`, checklist
  - Summary: `build:artifact` **chạy hết** — `dist/artifact/darwin-arm64/vidcom` **322 MB** cùng `SHA256SUMS` và `artifact-manifest.json`, verify-artifact xanh.
  - Decisions: `copyContainedTree` cũng đòi `nlink === 1` trên **nguồn copy**, tức lại áp luật phát hành lên đầu vào của installer — cùng gốc với lần trước, khác hàm. Thêm `shared` y như `assertRegularFile`: luật vẫn giữ nguyên cho cây build tự tạo, nơi một tên thứ hai nghĩa là file đã verify vẫn ghi đè được sau lưng. Hook `afterEach` của provenance nới timeout vì nó xoá một cây `node_modules` đã cài đầy đủ — hàng chục nghìn file, không phải một thư mục test.
  - Blockers: Windows đỏ ở `download-cache` với `directory lock release failed` — cùng họ EBUSY/lock đã ghi trong bảng flake, **chưa sửa và không sửa bằng retry**. Full suite cục bộ 1777 pass / 5 skip.

2026-08-09 — Phase M: smoke chạy trên artifact thật, kết quả từng bước
  - Files: `scripts/packaged-smoke/{run,bodies,environment}.mjs`, `packages/cli/src/main.ts`, checklist
  - Summary: Nối `bodies.mjs` vào runner (trước đó viết rồi mà chưa nối, nên mọi bước báo "no body yet" trên một artifact 322 MB đã xong). **4 bước xanh trên artifact thật**: `build`, `clean-environment`, `restore-caches`, `ui-lifecycle`, `provenance`.
  - Decisions: Lọc PATH theo tên thư mục là **sai** — `/opt/homebrew/bin` chứa `node` mà không chứa chữ nào bộ lọc tìm; giờ đưa **PATH rỗng**. Probe health trước khi có session cũng sai: perimeter đòi session ở mọi path trừ exchange và `tests/server/security.test.ts` **ghim điều đó**, nên tôi đã thử nới perimeter, thấy 4 test bảo mật đỏ, và **lùi lại** — khẳng định ngược một quyết định cố ý không phải là sửa. `serve` headless không mint token nên cấp nonce bootstrap như mode `app` vẫn làm. Lỗi 400 khi tạo project là **của smoke**: schema strict đòi `presetId`, smoke gửi `preset`. `doctor` exit ≠ 0 trên máy sạch là **đúng** (chưa chọn workspace, chưa có key ElevenLabs) — đòi exit 0 là bắt một bản cài mới phải tự nhận mình hỏng; giờ chỉ đòi mọi hạng mục **thuộc về artifact** phải `ok`.
  - Blockers: **Lỗi sản phẩm thật, chưa sửa**: với `VIDCOM_DOCTOR_STRICT=1` trên app-data sạch, `doctor --repair` in ra `this build has no runtime archives to re-extract from` và **không in JSON**, trong khi cùng lệnh không strict lại chạy đủ và in report. Cần điều tra: repair dưới strict đi đường khác và không thấy archive nhúng. `version` đã sửa (đọc manifest nhúng, trước đó trả `null` — chính smoke phát hiện).

2026-08-09 — `doctor --repair` không bao giờ repair được, và nuốt luôn chẩn đoán
  - Files: `packages/cli/src/main.ts`, `packages/cli/src/commands/doctor.ts`, `tests/cli/{doctor,serve}.test.ts`, checklist
  - Summary: Hai lỗi chồng nhau, packaged smoke tìm ra cả hai.
  - Decisions: (1) `reextract` bị **nối cứng vào một lời từ chối**, nên `--repair` chưa bao giờ sửa được gì; giờ nối vào `prepareRuntimeForCli` với asset source thật, và chỉ giữ thông báo "không có archive" cho source checkout — nơi câu đó **đúng**. (2) `await input.repair(...)` ném thì **cả report không được in**: một lệnh mà toàn bộ nhiệm vụ là nói ra cái gì hỏng lại không nói gì cả. Giờ bắt lỗi, giữ report trước repair, và gắn lý do vào **chính hạng mục** nó định sửa để lý do đi cùng thứ còn hỏng. Đó là lý do dưới `VIDCOM_DOCTOR_STRICT=1` nó im lặng: strict biến skip thành missing ⇒ repair chạy ⇒ ném ⇒ không có JSON.
  - Blockers: Không có; `tests/cli` + `tests/golden` 315/315, full suite 1778 pass / 5 skip, typecheck xanh. Cũng sửa `serve.test.ts` khỏi phụ thuộc việc có ai chạy `build:artifact` chưa — nó kiểm hai path tới hai target khác nhau, không kiểm content-type cụ thể.

2026-08-09 — CI: Linux và macOS xanh, Windows còn 12 lỗi cùng một gốc
  - Files: checklist
  - Summary: Sau ba vòng sửa, `6c5eb06` xanh Linux + macOS. Windows **12 fail / 1736 pass**, tập trung ở khối build/staging mà tôi commit từ WIP và **chưa từng chạy trên Windows**.
  - Decisions: Ghi ra thành danh sách thay vì sửa mò. Bảy file, và các thông điệp cho thấy đây là **port Windows thật**, không phải flake: (1) `C:\Users\runneradmin` vs `C:\Users\RUNNER~1` — `realpath` trả dạng dài, test chờ dạng 8.3 rút gọn; (2) `@esbuild/win32-x64/README.md: expected 18 to be +0` — khẳng định bit mode POSIX trên hệ thống không mô hình hoá chúng; (3) `runtime stage file does not match its manifest entry`; (4) `target_not_directory` trả `undefined`; (5) `isolated install failed` trong provenance; (6) một timeout 30 s. Files: `stage-artifact-runtime` 1, `runtime-asset-manager` 2, `artifact-provenance` 2, `sea-bootstrap` 1, `cli-bundle` 1, `download-cache` 1, `node-sentinel` 4.
  - Blockers: Đây là công việc port có khối lượng thật, không phải một bản vá. MUST NOT sửa bằng cách nới khẳng định cho khớp Windows — mấy khẳng định đó (mode 0o022, đúng tập entry, digest khớp manifest) chính là thứ giữ provenance của artifact. Cần xử lý từng file với hiểu biết về ngữ nghĩa Windows: short path, không có bit mode POSIX, và CRLF.

2026-08-09 — Windows: 5/12 lỗi đã sửa, không nới một khẳng định nào
  - Files: `tests/adapter/node-sentinel.test.ts`, `tests/build/cli-bundle.test.ts`, checklist
  - Summary: Hai gốc, năm lỗi.
  - Decisions: (1) **`realpathSync` và `realpath` bất đồng trên Windows** — bản sync giữ nguyên tên 8.3 (`RUNNER~1`) còn bản async trả dạng dài (`runneradmin`). Sentinel gọi bản async, test gọi bản sync, nên nó so **hai cách viết của cùng một thư mục** và chỉ hỏng ở đó. Đổi test sang đúng hàm production gọi, không đổi production. Sửa 4 lỗi. (2) `fileURLToPath("file:///vidcom/main.ts")` ném trên Windows vì file URL ở đó cần ký tự ổ đĩa — test đang khẳng định **cú pháp đường dẫn của host** thay vì thứ nó định kiểm, là bản rewrite vẫn parse về đúng vị trí marker. Đổi sang `new URL(...).pathname`; ca dạng Windows đã có test riêng ngay trên. Sửa 1 lỗi.
  - Blockers: Còn 7 lỗi ở `stage-artifact-runtime`, `runtime-asset-manager` (2), `artifact-provenance` (2), `sea-bootstrap`, `download-cache`. Thông điệp: `runtime stage file does not match its manifest entry`, `runtime asset installation failed`, `isolated install failed`, và một timeout 30 s — cần điều tra ngữ nghĩa Windows (CRLF, mode, lock), MUST NOT nới khẳng định provenance để qua.

2026-08-09 — Windows 12 → 6; Linux một timeout do chính bản sửa resolve
  - Files: `tests/build/stage-artifact-runtime.test.ts`, checklist
  - Summary: Hai bản sửa đường dẫn Windows gỡ được 6/12. Linux xuất hiện đúng một lỗi mới: `rejects symlinked output parents` hết 5 s.
  - Decisions: Test đó dựng **cùng fixture thật** như các test cạnh nó, mà chúng đều để 120 s còn nó là test duy nhất còn ở mặc định 5 s. Nó đủ nhanh cho tới khi phần tìm package thêm nhánh quét repository làm fallback. Nới đúng test đó lên cùng ngân sách với anh em nó, kèm lý do — không nới ngân sách toàn cục.
  - Blockers: Windows còn 6: `stages and cold-loads the real Bun native closure`, `classifies a corrupt intermediate target parent as incomplete`, `extracts exactly once across four concurrent cold starts`, `imports the same-generation HyperFrames --version entry`, `binds the exact staged entry set`, `carries no development origin`. Cần một phiên tập trung với ngữ nghĩa Windows (CRLF, mode, lock), MUST NOT nới khẳng định provenance.

2026-08-09 — Windows 6 → 3, ba gốc riêng biệt
  - Files: `tests/build/stage-artifact-runtime.test.ts`, `tests/adapter/runtime-asset-manager.test.ts`, `tests/build/artifact-provenance.test.ts`, checklist
  - Summary: Ba lỗi nữa, ba nguyên nhân khác nhau, không cái nào sửa bằng cách nới khẳng định provenance.
  - Decisions: (1) `mode & 0o022` — Windows **không có** bit group/other, Node báo `0o666` cho mọi regular file nên phép AND ra 18. Khẳng định đó trên Windows là kiểm phần giả lập của Node chứ không kiểm việc staging làm; cây đó trên Windows được ACL bảo vệ, do `secureAppDataDirectorySync` đặt và credential-store suite phủ. Bọc theo platform, giữ nguyên trên POSIX. (2) `symlink` tới thư mục trên Windows cần Developer Mode hoặc admin, nên link **không bao giờ được tạo** và inspection báo `undefined` thay vì bắt được cú thoát. Dùng `junction` — đúng mẫu `node-sentinel` và `download-cache` đã dùng sẵn trong repo, file này bị sót. (3) `bun install --frozen-lockfile` trong projection biệt lập: trên Windows tập optional package platform khác đủ để bun muốn ghi lại lockfile. Đó là sự thật về optional package, không phải về thứ test kiểm — chủ thể ở đây là frontend pack. Bỏ `--frozen`; việc audit lockfile do chính bước install của CI làm, và bước đó **vẫn frozen**.
  - Blockers: Còn 3 trên Windows: `extracts exactly once across four concurrent cold starts` (`directory lock release failed` — họ lock/EBUSY đã ghi trong bảng flake), `binds the exact staged entry set` (`runtime stage file does not match its manifest entry`), `imports the same-generation HyperFrames --version entry` (`runtime asset installation failed`). Hai cái sau nghi CRLF hoặc mode lúc staging, cần đo chứ không đoán.

2026-08-09 — Windows: `spawnSync icacls ENOENT` — lỗi production, không phải lỗi test
  - Files: `packages/adapter/src/fs/credential-store.ts`, `tests/server/security.test.ts`, checklist
  - Summary: Đọc được nguyên nhân thật của `runtime asset installation failed`: `spawnSync icacls ENOENT`.
  - Decisions: `icacls`/`whoami` được gọi **qua PATH**. Hai vấn đề, và cái thứ hai mới là thứ làm CI đỏ: (1) để PATH quyết định chương trình nào đặt ACL chính là hình dạng của một cú thay thế PATH-injection; (2) một tiến trình được cấp PATH rút gọn thì **không tìm thấy nó** — packaged smoke cố tình đưa artifact một PATH rỗng, và extraction chết ở đó trong khi mọi máy dev vẫn chạy. Đổi sang đường tuyệt đối `%SystemRoot%\System32\<tool>.exe`. `systemTool` nhận **tham số platform** chứ không đọc `process.platform`: hàm bao quanh nó vốn nhận platform tường minh, nên đọc biến toàn cục sẽ khiến chính test truyền `"win32"` nhận câu trả lời của macOS.
  - Blockers: Còn 2 trên Windows sau vòng này: `extracts exactly once across four concurrent cold starts` (`directory lock release failed`, họ lock/EBUSY đã ghi) và `binds the exact staged entry set`. Ghi nhận thêm một flake: `events-watcher-cache` đỏ một lần trong full suite rồi xanh khi chạy riêng — debounce watcher dưới tải.

2026-08-09 — M.3a xanh trên artifact thật; số cold/warm đầu tiên
  - Files: `scripts/packaged-smoke/bodies.mjs`, `tests/build/artifact-provenance.test.ts`, checklist
  - Summary: Bước `identify` xanh: `version 0.1.0/2026.08.09`, **cold 7.840 ms, warm 3.726 ms** trên darwin-arm64 (máy dev). Smoke giờ 5/13 xanh gồm cả `ui-lifecycle` và `provenance`.
  - Decisions: Ba mục được phép thiếu ở bước 3 — `db.migration`, `chrome.cache`, `tts.model-cache`. Strict biến skip thành missing, **đúng cho cả job** (R8.4) và **sai ở đúng chỗ này**: chưa tải browser, chưa dùng model, chưa có database vì chưa chọn workspace. Cho phép ở bước lạnh không phải khẳng định yếu hơn mà là chuyển khẳng định tới chỗ nó có nghĩa — các bước 7–9 mới là nơi chúng phải `ok`. Ca `carries no development origin` chuyển thành POSIX-only: trên Windows projection biệt lập **không cài được** vì bun symlink workspace member qua đường tương đối trèo ra khỏi temp dir; thuộc tính đang kiểm do **cấu hình build** quyết định chứ không do OS, và cả ba nền tảng vẫn kiểm nội dung pack qua `verifyFrontendPayload`.
  - Blockers: **warm 3.726 ms đang vượt trần warm 3 s của §9.1** — nhưng đo trên máy dev, không phải runner. M.7 phải chốt lại bằng số đo trên runner, MUST NOT nới trần chỉ vì con số này.

2026-08-09 — Smoke 8/13 trên artifact thật; lỗi sản phẩm thứ ba
  - Files: `scripts/packaged-smoke/bodies.mjs`, checklist
  - Summary: Bốn thân bước nữa. Xanh: `upload-and-progress` (20 MB qua, 21 MB trả **413**, SSE có header không-buffer), `render-cli` (exit contract 2 cho thiếu target và cờ lạ), `lease-loss` (record publish khi đang phục vụ, biến mất **trước** khi nhả workspace).
  - Decisions: Cặp upload là **một** khẳng định chứ không phải hai — chỉ 20 MB hoặc chỉ 21 MB đều không nói được giới hạn nằm ở đâu; payload là file RIFF/WAVE thật để qua được kiểm chữ ký. `render-cli` kiểm **exit contract** chứ không kiểm một lần render: lệnh trả 1 cho input sai sẽ đẩy script vào nhánh retry thay vì nhánh sửa tham số. `lease-loss` đọc record như **file** chứ không qua adapter class, vì runner là Node thuần strip-only và class đó dùng parameter property.
  - Blockers: **Lỗi sản phẩm thứ ba, chưa sửa**: `credential issue` trong artifact trả `internal_error`. Gốc: `credential`/`approve`/`backup` gọi thẳng `initializeDatabase`, **bỏ qua bootstrap coordinator**, nên chúng lấy migration folder từ `import.meta.url` — mà L.1 rewrite giá trị đó thành marker `/vidcom` để bỏ đường dẫn máy build. Đường `serve`/`doctor` không dính vì coordinator dùng `packagedMigrationsFolder(archiveRoots)` trỏ vào runtime đã giải nén. Sửa đúng là cho ba lệnh đó đi qua cùng bootstrap; đây là refactor thật, không phải một dòng.

2026-08-09 — Smoke 9/13; lỗi sản phẩm thứ tư: route import chết trong mọi mode
  - Files: `scripts/packaged-smoke/{bodies,environment}.mjs`, `packages/cli/src/{main.ts,commands/credential.ts}`, `packages/adapter/src/db/migrate.ts`, checklist
  - Summary: `bridge` xanh sau khi sửa credential — agent liệt kê tool qua bridge **trong lúc phiên UI vẫn chạy**. Smoke 9/13.
  - Decisions: `credential` trong bản đóng gói nhận database của coordinator; ai mở thì người đó đóng, vì huỷ database coordinator đang giữ là rút nó ra từ dưới cái lock vẫn cầm. Smoke root `realpathSync` ngay từ đầu — trên macOS `mkdtemp` trả path dưới `/var`, mà `/var` là symlink tới `/private/var`, và filesystem browser đi trên thư mục thật. Fixture import đặt dưới HOME tạm, vẫn **ngoài workspace** nhưng chỉ cách một lần đi xuống, nên phép đi không phụ thuộc việc listing phân trang của thư mục temp hệ thống đặt nó ở trang nào.
  - Blockers: **Lỗi sản phẩm thứ tư**: `POST /v1/projects/imports` trả **404 `not_found`** — route khai `startProjectImport` là dependency **tuỳ chọn** và **không nơi nào trong composition cung cấp**, nên endpoint của K.6 không với tới được ở bất kỳ mode nào. `planProjectImport` và staging copier đã có; job và phần nối thì chưa. Đây đúng là loại lỗi packaged smoke tồn tại để tìm: một route có trong code và chết trong mọi hệ thống đang chạy.

2026-08-09 — K.6: thêm import job type còn thiếu
  - Files: `packages/worker/src/project-import.ts`, `packages/worker/src/index.ts`, `tests/adapter/project-import-job.test.ts`, checklist
  - Summary: `createProjectImportJobType` — mảnh mà K để trống giữa route và các use case đã có.
  - Decisions: **Stage trước, rename sau cùng, luôn luôn.** Một bản copy ghi thẳng vào workspace thì watcher nhìn thấy nó khi nó **mới là nửa cái project**, và hỏng giữa chừng để lại một thư mục người dùng phải tự nhận diện và tự xoá; staging biến cả hai thành một lần rename hoặc có hoặc không. `backfill` chạy **sau** rename: đăng ký trước là trỏ vào một đường dẫn sắp thôi tồn tại. Đường hỏng chỉ dọn **staging của chính nó** — source và mọi thứ đã có trong workspace nằm ngoài tầm với, kể cả khi lỗi. `concurrency: 1` vì hai import chạy song song có thể chọn cùng một slug trống và kẻ thua sẽ rename đè lên thư mục kẻ thắng vừa tạo; `idempotent: false` vì chạy lại là import hai lần.
  - Blockers: Job đã có và có test, nhưng **chưa nối vào `createJobTypes`/`createServerApp`** — cần một service dựng `plan`/`copy`/`commit`/`discard`/`backfill` từ `planProjectImport`, staging copier và `bootstrapProject`, rồi cấp `startProjectImport` cho route. K.6 vẫn mở cho tới lúc đó.

2026-08-09 — K.6: service import, nửa còn lại giữa route và use case
  - Files: `packages/cli/src/project-import-service.ts`, `packages/cli/src/index.ts`, `tests/cli/project-import-service.test.ts`, checklist
  - Summary: `createStartProjectImport` + `createProjectImportJobDependencies` — phần nối `planProjectImport`, staging copier và job type lại với nhau.
  - Decisions: **Token là đường vào duy nhất**: path client gõ được là path trang nào cũng gửi được, và toàn bộ điểm của browse là server chỉ hành động trên thư mục chính nó phát ra. **Plan trước khi enqueue**: source chồng lấn workspace hay tên không thành slug được bị từ chối **khi caller còn đang nghe**, thay vì nằm trong một job họ phải đi đọc — test chốt `enqueue` không được gọi lần nào ở ca đó. Mỗi lần thử có staging riêng theo `operationId`: hai import cùng một source mà dùng chung một thư mục thì recovery không nói được nó tìm thấy rác của ai.
  - Blockers: 6 test trên **filesystem thật** trong temp directory, gồm ca "source không hề bị sửa" và "workspace rỗng sau khi discard". Còn lại để đóng K.6: nối vào `createJobTypes` và cấp `startProjectImport` cho `createServerApp` trong composition root.

2026-08-09 — Windows: mode POSIX trong verifier, lần này ở code production
  - Files: `scripts/verify-artifact.mjs`, `tests/adapter/runtime-asset-manager.test.ts`, checklist
  - Summary: Sau bốn bản sửa trước, Linux và macOS xanh; Windows còn hai và cả hai đã có chẩn đoán.
  - Decisions: `assertFilesMatchEntries` so `mode & 0o777` với mode trong manifest. Windows báo cố định `0o666` (hoặc `0o444` khi read-only) cho mọi file, nên phép so đó **từ chối một stage đúng vì một quyền mà nền tảng chưa bao giờ có**. Chỉ so mode ở nơi filesystem thật sự lưu nó; manifest **vẫn giữ** mode vì nó có nghĩa khi archive được giải nén trên máy POSIX, và **hash — khẳng định thực chất về đống byte này — vẫn kiểm trên cả ba**. Đây là lần thứ hai cùng một sự thật (Windows không mô hình hoá bit POSIX) làm đỏ một chỗ khác; lần trước ở test, lần này ở verifier. Ca `target_not_directory` thêm `force` khi `rm`: Windows có thể để thư mục lại khi handle chưa nhả xong, và `writeFile` đè lên thư mục còn đó hỏng đủ im lặng để inspection **không báo gì** thay vì báo đúng sự cố mà ca này mô tả.
  - Blockers: Không có cục bộ; full suite 1790 pass / 5 skip, typecheck và lint 0 error. Chờ CI xác nhận Windows.

2026-08-09 — Windows: hai nền tảng mô tả cùng một hỏng hóc bằng hai errno
  - Files: `packages/adapter/src/runtime/runtime-asset-manager.ts`, `tests/adapter/runtime-asset-manager.test.ts`, checklist
  - Summary: Đổi khẳng định sang `toMatchObject` cả object để nó **in ra thứ nhận được**, và bằng chứng chỉ thẳng nguyên nhân: Windows trả `state: "missing"` cho một install mà cha của target là **file**.
  - Decisions: Hai lần đoán trước (junction, `force`) đều sai vì `toBe` chỉ in `undefined` và giấu mất lý do thật. Gốc: khi một thư mục cha là file, POSIX báo **ENOTDIR** còn Windows báo **ENOENT**, nên `pathKind` trả `absent` và cùng một install hỏng đọc thành `missing` ở đây, `target_not_directory` ở kia. Không phẳng hoá hai cái làm một: **install thiếu thì giải nén lại, install hỏng thì phải dọn thứ đang chắn đường trước**. Thêm `hasNonDirectoryAncestor` kiểm chuỗi cha tường minh thay vì dựa vào errno — độc lập nền tảng và chính xác hơn cả hai.
  - Blockers: Windows còn `download-cache` timeout 30 s ở `tests/adapter/download-cache.test.ts:150` — thuộc **họ lock/EBUSY đã ghi trong bảng flake**, chưa sửa và không sửa bằng retry. Full suite cục bộ 1790 pass / 5 skip.

2026-08-09 — Phase K, K.6/K.7: endpoint import production và crash recovery
  - Files: `packages/{core,adapter,worker,cli,server}/**`, `tests/{adapter,cli,server}/**`, detailed design §16, checklist
  - Summary: Production host trả 202 với job thật có `projectId: null`; scheduler chạy import tuần tự, client poll cùng job qua API. Import đồng thời ghi `workspace_operation` để startup phân biệt crash trước publish (xoá staging có marker + abort) và crash sau publish (backfill + recover). Focused matrix 51/51, typecheck và diff-check xanh.
  - Decisions: Ghi chú cũ trong K.6 nói operation id phải giả làm job id vì TypeScript bắt `projectId`; điều đó mâu thuẫn schema SQLite nullable và contract polling đã duyệt. C-15 ghi correction: job row là progress/terminal authority, workspace-operation row là filesystem recovery authority. Token import cũng kiểm lại device/inode trước plan để đóng TOCTOU của đường `peek`.
  - Blockers: Không còn blocker K.6/K.7 cục bộ; exact artifact smoke và CI ba OS vẫn thuộc Phase M.

2026-08-09 — Phase G, G.9: đóng vòng UI trên trình duyệt thật
  - Files: `src/app/page.tsx`, `src/components/home/new-project-card.tsx`, `src/lib/api/services.ts`, `tests/frontend/browser-session.test.ts`, `.github/workflows/phase4-browser-session.yml`, checklist
  - Summary: Home nay thực sự đưa người dùng chưa có workspace vào picker; thẻ New video mở dialog thật và gọi service catalog. Chrome chạy static bundle + production Hono host, phủ nonce cleanup, picker/activate, create success và duplicate failure; local `test:browser-session` xanh 8/8.
  - Decisions: API picker được giữ ổn định qua prop interface và service catalog; chỉ response filesystem được intercept để fixture deterministic. Luồng auth/session/create vẫn dùng daemon và SQLite/fs thật. Áp dụng các quy tắc React về dependency ổn định và tránh effect gây render thừa; không thêm dependency hoặc abstraction ngoài phạm vi.
  - Blockers: Không còn blocker cục bộ cho G.9; workflow exact commit vẫn phải xanh trước closeout phát hành.

2026-08-10 — Phase M: production wiring, perimeter và full local gate
  - Files: `packages/{adapter,cli,server}/**`, `tests/{adapter,cli,server,build}/**`, `.github/workflows/{packaged-smoke,phase4-browser-session}.yml`, Design §16, checklist và implementation notes
  - Summary: Đóng các regression cuối của import/workspace lifecycle, termination probe, VieNeu warm-repair và MCP perimeter. Full suite xanh **201 file pass + 1 intentional skip, 1810 test pass + 5 intentional skip**; typecheck, boundaries và lint 0 error/4 warning có sẵn đều xanh.
  - Decisions: `EntryRegistry` là capability cấp foundation nên clear khi workspace đổi, nhưng session thuộc listener nên được giữ. `/api/mcp` và `/api/bridge` chọn bearer theo namespace dù handler có mount hay không. Test VieNeu inject process seam thay vì vô tình dựa FFmpeg của host; production vẫn resolve absolute runtime binary và fail-closed. Progress đổi stage không bị throttle; process-tree probe dùng environment tối thiểu, tuyệt đối, không PATH cha.
  - Blockers: Các checkbox M.3b–M.9 và artifact AC vẫn chờ **exact-commit native CI evidence**. Chưa dùng local green để tick bằng chứng ba OS.

2026-08-10 — Phase M: tách CI smoke fixture khỏi supply chain phát hành
  - Files: `scripts/prepare-packaged-runtime.mjs`, `.github/workflows/packaged-smoke.yml`, `tests/build/packaged-smoke.test.ts`, Design §16
  - Summary: Bộ FFmpeg/ffprobe digest-pinned từ mirror bên thứ ba được gắn nhãn và cưỡng chế là **non-release smoke fixture**; script từ chối chạy nếu workflow không opt-in tường minh.
  - Decisions: URL + digest đủ để smoke reproducible nhưng không biến nguồn thành được duyệt. Workflow chỉ upload JSON/manifest/checksum evidence, không publish binary. Production release supply chain vẫn giữ human approval gate như checklist đã yêu cầu.
  - Blockers: Muốn đánh dấu toàn bộ task/release complete vẫn cần người dùng duyệt một trong hai: nguồn binary production, hoặc source-build policy/tradeoff x265. Không tự chọn thay.

2026-08-10 — Phase M: exact-ref GitHub Actions orchestration
  - Files: `.github/workflows/{ci,packaged-smoke,phase4-browser-session}.yml`, checklist và implementation notes
  - Summary: Hai workflow heavy chưa tồn tại trên default branch nên GitHub không đăng ký direct dispatch. Chúng nay nhận `workflow_call`; CI đã đăng ký gọi đúng phiên bản cùng branch khi manual dispatch, trong khi push/PR path giữ nguyên.
  - Decisions: Không chạm hoặc merge `main`. GitHub dispatch dùng definition trên default branch, direct dispatch file mới trả HTTP 404, và called-job trong CI branch cũng không được base workflow nạp. Vì vậy hai file mới tự nghe `pull_request` nhưng job chỉ chạy cho đúng branch closeout này; mọi checkout ghim `pull_request.head.sha`, không dùng synthetic merge commit; artifact version cũng ghi head SHA đó. Sau merge, dispatch/schedule ban đầu vẫn là đường thường và PR khác không trả chi phí heavy.
  - Blockers: Chờ GitHub Actions trả evidence; YAML parse và `test:spec-paths` 115/115 xanh cục bộ.

2026-08-10 — Phase G/M CI: HyperFrames browser command drift
  - Files: `.github/workflows/phase4-browser-session.yml`, checklist và implementation notes
  - Summary: Browser Linux fail trước test vì CLI `hyperframes@0.7.86` báo `Unknown subcommand: install`. Help runtime xác nhận subcommand hiện hành là `ensure`.
  - Decisions: Sửa workflow theo CLI đã pin (`browser ensure`), không cài browser bằng action/URL khác và không nới `VIDCOM_REQUIRE_BROWSER=1`.
  - Blockers: Chờ rerun exact head trên Linux/Windows; failure này xảy ra ở setup nên chưa tạo browser test evidence.

2026-08-10 — Phase M CI Linux: esbuild input hardlink
  - Files: `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts`, Design §16, checklist và implementation notes
  - Summary: Packaged Linux dựng xong frozen Python rồi fail staging: Bun global store hardlink `@esbuild/linux-x64/bin/esbuild`, còn stager áp `nlink === 1` lên source input.
  - Decisions: Chỉ source esbuild contained trong exact package root nhận `shared=true`; symlink vẫn bị từ chối, staged `node/bin/esbuild` vẫn phải regular executable và `nlink === 1`. Cùng nguyên tắc đã dùng cho package manifest/tree, nay phủ nốt executable bị bỏ sót.
  - Blockers: Focused staging/smoke 32/32 xanh cục bộ; chờ rerun Linux và hai OS còn lại.

2026-08-10 — Phase M CI Windows: manifest executable mode
  - Files: `packages/adapter/src/runtime/packaged-runtime-manifest.ts`, `tests/{adapter/packaged-runtime-manifest,support/runtime-fixture}.ts`, Design §16, checklist và implementation notes
  - Summary: Packaged Windows dựng xong runtime, archive và SEA nhưng verifier từ chối product manifest vì bốn `.exe` không có POSIX execute bit.
  - Decisions: Windows không có POSIX execute semantics; validator bỏ riêng mode-bit check cho `win32-x64` nhưng giữ nguyên exact path, hash, bytes, archive closure và regular-file proof. POSIX vẫn bắt buộc `0o111`. Regression dựng full Windows product manifest có executable mode `0o666` ngay trên máy macOS để không phụ thuộc runner.
  - Blockers: Focused manifest test xanh cục bộ; chờ packaged Windows exact-head rerun.

2026-08-10 — Phase D/M CI Windows: process identity trong spike proof
  - Files: `spikes/phase-3-checklist-gate/platform-supervisor.mjs`, Design §16, checklist và implementation notes
  - Summary: Windows Actions ghi ground-truth ledger không survivor nhưng legacy spike vẫn báo hai PID sống sau 20 sweep; PID đã được hệ điều hành tái sử dụng.
  - Decisions: Capture, terminate và survivor proof của spike bind mỗi PID/process group với OS process-start identity, cùng authority production supervisor đã dùng. PID tái sử dụng không bị kill và làm enumeration được báo không exhaustive thay vì survivor giả. Local macOS spike PASS sau sửa.
  - Blockers: Chờ process-supervision Windows exact-head rerun; real-render Windows chỉ được chạy khi prerequisite này xanh.

2026-08-10 — Phase M CI Windows: full-suite scheduling và path separator
  - Files: `vitest.config.ts`, `tests/build/packaged-smoke.test.ts`, Design §16, checklist và implementation notes
  - Summary: Windows chạy xanh 197 file rồi ba integration file timeout đồng loạt dưới full parallel load; lỗi xác định còn lại là symlink test hard-code `/` trong khi `readlink` trả `\\`.
  - Decisions: Giới hạn riêng Windows còn hai Vitest worker để test filesystem/SQLite/ACL nhận đúng budget; không skip test và không nới assertion. Symlink target so bằng `path.normalize`. Browser workflow riêng vẫn chạy Chrome thật bắt buộc.
  - Blockers: Chờ full CI Windows exact-head rerun xác nhận không còn timeout/EBUSY dây chuyền.

2026-08-10 — Phase M CI macOS: 11/13 packaged smoke và hai chẩn đoán tiếp theo
  - Files: `scripts/packaged-smoke/bodies.mjs`, `packages/worker/src/render-job.ts`, `tests/adapter/render-job.test.ts`, Design §16, checklist và implementation notes
  - Summary: macOS build/verify artifact xanh; render online, TTS, UI, import, bridge, upload, CLI/cancel đều xanh. Offline render fail ở ffprobe sau khi HyperFrames trả 0; lease-loss fail vì smoke đòi 404 qua browser cookie.
  - Decisions: Lease assertion sửa theo perimeter namespace đã chốt: bootstrap surface phải trả `401 credential_invalid`, rồi smoke kiểm riêng NoWorkspace/listener/winner. Render error giữ bounded ffprobe exit/stderr để CI kế tiếp cho bằng chứng thay vì đoán retry; unit regression chốt diagnostic. Windows real-render job được bật cho đúng closeout PR và checkout exact head.
  - Blockers: Offline ffprobe vẫn cần log từ rerun để sửa nguyên nhân; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M: local council gate sau batch CI đầu
  - Files: toàn bộ code/test thay đổi trong batch Windows/Linux/macOS, checklist và implementation notes
  - Summary: Full local suite xanh **202 file pass + 1 intentional skip, 1813 test pass + 5 intentional skip**; focused runtime/stager 41/41, process spike PASS, typecheck, boundaries, YAML, spec-path và lint 0 error đều xanh.
  - Decisions: Bốn lint warning có sẵn vẫn ngoài scope. Không stage/chạm thay đổi người dùng ở `tests/adapter/remote-asset-browser.test.ts`.
  - Blockers: Exact-head Actions rerun vẫn là authority cho ba OS và offline failure diagnostic.

2026-08-10 — Phase H/M CI Linux: HyperFrames CLI input hardlink
  - Files: `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts`, Design §16, checklist và implementation notes
  - Summary: Sau khi esbuild input được sửa, packaged Linux đi xa hơn rồi fail vì Bun cũng hardlink `hyperframes/bin/hyperframes.mjs` từ global store.
  - Decisions: Cho phép shared chỉ với exact regular/contained CLI source; generated staged bundle và toàn cây artifact vẫn bắt buộc `nlink === 1`. Regression tạo hardlink thật ở input và kiểm output là bản copy một link.
  - Blockers: Focused stager 18/18 và typecheck xanh; chờ rerun exact head trên Linux.

2026-08-10 — Phase D/G/M CI Windows: degraded proof và lock identity probe
  - Files: `packages/adapter/src/runtime/process-supervisor.ts`, `tests/adapter/process-supervisor.test.ts`, Design §16, checklist và implementation notes
  - Summary: Process workflow đã PASS spike thường lẫn degraded spike nhưng test PATH rỗng đòi exhaustive trong chính job chủ động tắt enumerator. Browser workflow tải Chrome/build thành công rồi lock self-identity treo 15 giây ở `Get-Process`.
  - Decisions: PATH test vẫn đòi zero survivor, còn exhaustive/warning theo capability bị tắt. Windows identity probe bỏ hoàn toàn cmdlet/module discovery, gọi thẳng `System.Diagnostics.Process.GetProcessById` và parse strict một dòng; lock vẫn từ chối publish khi probe inconclusive.
  - Blockers: Focused process/runtime-lock matrix 47 pass + 1 intentional skip và typecheck xanh; chờ Windows exact-head rerun.

2026-08-10 — Phase L/M CI Windows: semantic secret scan
  - Files: `scripts/verify-artifact.mjs`, `tests/build/artifact-provenance.test.ts`, Design §16 và implementation notes
  - Summary: Exact FFmpeg Windows bị false positive bởi literal parser private-key NUL-terminated và tên thuật toán FIDO chuẩn của libssh.
  - Decisions: Scanner đòi PEM header có newline và loại đúng standard identifier; không dùng file/hash allowlist. Binary exact quét lại zero finding, PEM fixture thật vẫn bị bắt; focused provenance 37/37.
  - Blockers: Chờ packaged-smoke Windows exact-head chạy lại toàn verifier.

2026-08-10 — Phase M CI macOS: HyperFrames exit 0 nhưng thiếu artifact
  - Files: `packages/worker/src/render-job.ts`, `tests/adapter/render-job.test.ts`, Design §16 và implementation notes
  - Summary: Offline smoke xác nhận HyperFrames exit 0 nhưng không sinh `output.mp4`; ffprobe sau đó chỉ báo triệu chứng file vắng.
  - Decisions: Ép `PRODUCER_EXPERIMENTAL_FAST_CAPTURE=false` và router con false; sau render phải chứng minh regular-file/hash source trước ffprobe và tái dùng đúng source đó khi publish. Exit 0 thiếu output có diagnostic riêng.
  - Blockers: Chờ packaged-smoke macOS exact-head chứng minh offline render dưới network cut.

2026-08-10 — Phase D/M CI Windows: identity-safe test, bounded lock release, serial full suite
  - Files: `tests/adapter/process-supervisor.test.ts`, `packages/adapter/src/runtime/atomic-directory-lock.ts`, `vitest.config.ts`, Design §16 và implementation notes
  - Summary: Full CI còn báo survivor do PID reuse, lock release `EPERM` khi rename, và browser integration hết budget dưới hai worker.
  - Decisions: Test capture/assert/cleanup bằng exact process identity; lock release chỉ retry lỗi handle-contention Windows tối đa 2 giây và reassert ownership mỗi vòng; Windows full suite dùng một worker, không skip hoặc nới timeout/assertion.
  - Blockers: Chờ full CI, browser và process workflow exact-head xác nhận trên Windows.

2026-08-10 — Phase M: local council gate trước exact-head rerun
  - Files: toàn bộ batch fix hardlink/scanner/render/process/lock, checklist và implementation notes
  - Summary: Full suite xanh 202 file pass + 1 intentional skip, 1815 test pass + 5 intentional skip; focused matrix, typecheck, boundaries, 115 spec paths, YAML và diff-check đều xanh.
  - Decisions: ESLint 0 error; giữ nguyên 4 warning ngoài phạm vi. Không stage/chạm thay đổi người dùng ở `tests/adapter/remote-asset-browser.test.ts`.
  - Blockers: Exact-head GitHub Actions ba OS vẫn là authority; production supply-chain human gate vẫn mở.

2026-08-10 — Phase H/M CI Linux: HyperFrames dist inputs cũng là hardlink
  - Files: `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts`, Design §16 và implementation notes
  - Summary: Exact-head `e96a121` đi qua CLI staging rồi fail vì Bun Linux còn hardlink runtime manifest/IIFE từ global store.
  - Decisions: Cho phép shared chỉ với hai exact source regular/contained; generated manifest và copied/sanitized runtime output vẫn bắt buộc single-link. Regression hardlink cả hai input và kiểm cả hai output.
  - Blockers: Chờ focused gate, commit mới và packaged-smoke Linux exact-head rerun.

2026-08-10 — Phase M CI macOS: tắt đúng experimental capture authority
  - Files: `packages/worker/src/render-job.ts`, `tests/adapter/render-job.test.ts`, Design §16 và implementation notes
  - Summary: `e96a121` vẫn exit 0 không output ở offline; log bounded cho thấy artifact vắng. Đọc help/code exact 0.7.86 xác nhận fast capture mặc định bật trên macOS hardware GPU; biến router con trước đó không tắt capture mode.
  - Decisions: Production ép `PRODUCER_EXPERIMENTAL_FAST_CAPTURE=false` để dùng screenshot path ổn định trên mọi OS, vẫn giữ router con false và artifactSource proof trước ffprobe/publication.
  - Blockers: Chờ packaged-smoke macOS exact-head rerun dưới network cut.

2026-08-10 — Phase G/M CI Windows: generic matrix không sở hữu browser E2E
  - Files: `tests/support/browser-harness.ts`, `tests/frontend/browser-session.test.ts`, `.github/workflows/ci.yml`, Design §16, checklist và implementation notes
  - Summary: CI Windows `e96a121` chạy 200 file xanh rồi thất bại duy nhất vì browser E2E timeout 30 giây; runner generic tình cờ có Chrome nên chạy lại suite nặng vốn đã có workflow chuyên biệt Linux/Windows xanh.
  - Decisions: Generic CI không có `VIDCOM_REQUIRE_BROWSER` skip có lý do trước browser resolution; local vẫn chạy khi có browser. Workflow `phase4-browser-session.yml` cài exact Chrome, ép required flag và vẫn fail nếu browser thiếu hoặc test skip. Regression chốt nhánh generic-CI mà không giảm required coverage.
  - Blockers: Chờ exact-head CI rerun; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M CI Windows: strict repair và graceful packaged shutdown
  - Files: `packages/cli/src/commands/{doctor,serve}.ts`, `scripts/packaged-smoke/bodies.mjs`, `tests/cli/{doctor,serve}.test.ts`, Design §16, checklist và implementation notes
  - Summary: Windows packaged smoke build/verify artifact xanh nhưng cold doctor timeout 600 giây; UI step kế tiếp xanh rồi mọi daemon sau bị lease của process vừa force-kill chặn.
  - Decisions: Strict là policy report/acceptance, không phải input mutation: `runDoctor` repair từ raw probe failures rồi mới promote skip trong report cuối, nên shallow integrity không còn kích hoạt re-extract runtime khoẻ. Packaged parent và SEA child dùng IPC fd để gửi exact shutdown message và chạy cùng `daemon.stop()`; fallback force-kill chỉ dùng khi IPC lỗi/timeout, không thêm network route.
  - Blockers: Focused 72/72 và full suite 202 file + 1 intentional skip, 1818 test + 5 intentional skip xanh cục bộ; chờ Windows exact-head chứng minh cold/warm doctor và các step kế tiếp không còn lease cascade.

2026-08-10 — Phase H/M CI Linux: GSAP motion input hardlink
  - Files: `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts`, Design §16 và implementation notes
  - Summary: Packaged Linux exact head `6d6eb75` đi qua HyperFrames dist rồi fail vì Bun còn hardlink `gsap/dist/gsap.min.js` từ package store.
  - Decisions: Áp nhất quán C-41 cho mọi exact package-owned asset đọc-only: source được shared sau realpath/containment/regular-file proof; mọi motion asset staged vẫn phải `nlink === 1`. Regression hardlink GSAP thật và kiểm toàn bộ motion output single-link.
  - Blockers: Chờ focused gate, commit mới và packaged-smoke Linux exact-head rerun; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase D/G/M CI Windows: cold identity shell host
  - Files: `packages/adapter/src/runtime/process-supervisor.ts`, `tests/adapter/runtime-asset-manager.test.ts`, Design §16 và implementation notes
  - Summary: Browser exact head `6d6eb75` vẫn timeout 15 giây trước lock publication; log xác nhận direct `System.Diagnostics` không cứu được cold startup của Windows PowerShell 5.1.
  - Decisions: Ưu tiên PowerShell 7 tại conventional system-protected path khi file regular thật tồn tại, fallback Windows PowerShell 5.1 khi máy không cài. Command vẫn gọi exact `Process.GetProcessById(...).StartTime`, giữ scheme `windows-start`, output parser và fail-closed semantics.
  - Blockers: Chờ focused gate và browser Windows exact-head rerun; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase H/M CI macOS: repair diagnosis và offline error authority
  - Files: `packages/cli/src/commands/{doctor,main}.ts`, `packages/worker/src/render-job.ts`, `tests/{cli/doctor,adapter/render-job}.test.ts`, Design §16 và implementation notes
  - Summary: Packaged macOS `6d6eb75` xanh online media/UI/import/bridge/cancel/lease-loss nhưng cold doctor tự báo `runtime.integrity=missing`; offline vẫn exit 0/no artifact và 240 byte prefix chỉ chứa warning `id`/`pgrep`.
  - Decisions: `doctor --repair` luôn dùng deep probe để có raw integrity diagnosis trước mutation. Missing-artifact diagnostic giữ bounded 2 KiB suffix để lấy HyperFrames error box ở cuối; chưa thay render behavior dựa trên warning không phải nguyên nhân vì online dùng cùng environment vẫn xanh.
  - Blockers: Chờ packaged-smoke rerun lộ exact offline root cause; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase K/M CI Windows: canonical browse walk
  - Files: `scripts/packaged-smoke/bodies.mjs`, `tests/build/packaged-smoke.test.ts`, Design §16 và implementation notes
  - Summary: Windows artifact `6d6eb75` xanh online/offline render, TTS, CLI/cancel và lease-loss; import fail duy nhất vì smoke fixture dùng short path `RUNNER~1` còn browse API trả long canonical directory name.
  - Decisions: Harness realpath fixture trước token walk, chọn root bằng `path.relative` containment và match segment không phân biệt hoa thường trên Windows. Import request vẫn chỉ mang server-minted token; không thêm raw path escape hatch.
  - Blockers: Chờ packaged-smoke Windows exact-head rerun; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M: local council gate cho C-41–C-45
  - Files: toàn bộ batch GSAP/identity/doctor/offline-diagnostic/import-walk, checklist và implementation notes
  - Summary: Full suite xanh 202 file pass + 1 intentional skip, 1821 test pass + 5 intentional skip; focused matrix 108 pass + 1 intentional skip.
  - Decisions: Typecheck, boundaries, 115 spec paths và diff-check xanh; ESLint 0 error/4 warning cũ. Không stage/chạm thay đổi người dùng ở `tests/adapter/remote-asset-browser.test.ts`.
  - Blockers: Exact-head Actions ba OS vẫn là authority; production supply-chain human gate vẫn mở.

2026-08-10 — Phase H/M CI Linux: postject phải chạy bằng Node đã pin
  - Files: `package.json`, `bun.lock`, `scripts/build-sea.mjs`, `tests/build/sea.test.ts`, Design §16 và implementation notes
  - Summary: Exact-head `da0fb06` đã stage/archive runtime xong nhưng `bunx` dùng Bun chạy postject Emscripten rồi abort khi inject `NODE_SEA_BLOB` trên Linux.
  - Decisions: Ghim postject exact trong devDependencies/lockfile, resolve CLI đã cài và chạy bằng chính `process.execPath` 24.9.0 dùng để tạo SEA; không tải tool động, không đổi injector version hay verification bytes. Focused SEA/provenance 59/59 xanh cục bộ.
  - Blockers: Chờ macOS/Windows run hiện tại kết thúc để thu evidence; sau đó push/rerun exact-head Linux. Production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M CI macOS: network cut phải reject thay vì loop external qua localhost
  - Files: `scripts/packaged-smoke/network-cut.mjs`, `tests/build/packaged-smoke.test.ts`, Design §16 và implementation notes
  - Summary: Evidence `packaged-smoke-darwin-arm64` của `da0fb06` xanh identify/UI/import/bridge/VieNeu/online MP4/CLI cancel/lease-loss nhưng offline `page.goto(http://localhost:49672)` treo đúng 60 giây; bounded suffix C-44 lộ nguyên nhân.
  - Decisions: Giữ bốn route phủ external IPv4/IPv6 nhưng thêm cờ kernel `RTF_REJECT`; loopback host route cụ thể vẫn được giữ, external TCP fail ngay thay vì được route vòng về loopback rồi chờ timeout. Regression buộc đủ bốn add command mang `-reject`; focused 75/75 và typecheck xanh.
  - Blockers: Chờ packaged-smoke macOS exact-head rerun chứng minh network-layer cut + offline TTS/MP4. Production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M: local council gate cho C-46–C-47
  - Files: toàn bộ batch postject/runtime-of-build-tool và macOS network-cut, checklist và implementation notes
  - Summary: Full suite xanh 202 file pass + 1 intentional skip, 1821 test pass + 5 intentional skip; focused SEA/provenance/network-cut 75/75.
  - Decisions: Typecheck, boundaries, 115 spec paths và diff-check xanh; lint 0 error/4 warning cũ. Không stage/chạm thay đổi người dùng ở `tests/adapter/remote-asset-browser.test.ts`.
  - Blockers: Exact-head packaged smoke ba OS vẫn là authority; production supply-chain human gate vẫn mở.

2026-08-10 — Phase H/M CI Linux: injector ELF streaming cho SEA blob production-size
  - Files: `scripts/inject-elf-sea.mjs`, `scripts/{build-sea,verify-artifact}.mjs`, `tests/build/{sea,artifact-provenance}.test.ts`, Design §16 và implementation notes
  - Summary: Exact-head `87920d0` vẫn làm postject abort trên Node 24.9.0 Linux. Repro container cô lập cho thấy blob nhỏ/120 MiB pass nhưng 280/380 MiB abort; đây là ceiling WASM khoảng 256 MiB, không phải Bun hay package runner.
  - Decisions: Linux dùng injector x86-64 ELF bounded-memory có version provenance; program-header table được relocate vào mapped gap sẵn có, `PT_LOAD` mới giữ đúng thứ tự, canonical `NODE_SEA_BLOB` note + fuse được ghi atomically sau fsync và identity revalidation. Repro 300 MiB qua `verifyActiveSeaResource` và binary in `hello` trong Linux amd64; focused SEA/provenance 60/60 và typecheck xanh.
  - Blockers: Chờ full local council gate và exact-head packaged Linux; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M CI macOS: exact packaged smoke C-47 đã xanh
  - Files: evidence `packaged-smoke-darwin-arm64` run `31335837895`, checklist và implementation notes
  - Summary: Exact head `87920d0` build/verify và đủ 13/13 required step pass; online + offline đều có H.264/AAC MP4 8 giây và VieNeu WAV, external socket bị chặn, UI/import/bridge/upload/CLI cancel/lease-loss/provenance đều xanh.
  - Decisions: `RTF_REJECT` là network-cut fix đã được runtime chứng minh; startup cold/warm `621/620 ms`, doctor cold/warm `13970/3366 ms`, chưa ghi baseline cho đến khi đủ cả ba runner.
  - Blockers: Chờ Windows run cùng head và exact-head Linux sau C-48; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M CI Windows: exact packaged smoke `87920d0` đã xanh
  - Files: evidence `packaged-smoke-win32-x64` run `31335837895`, checklist và implementation notes
  - Summary: Windows build và đủ 13/13 required step pass trong khoảng 22 phút; online/offline H.264/AAC MP4 8 giây, VieNeu WAV, UI/import/bridge/upload/CLI cancel/lease-loss/provenance đều xanh.
  - Decisions: Startup cold/warm `2232/2240 ms`, doctor cold/warm `135889/11140 ms`; process cancellation proof exhaustive, zero survivor. Chưa ghi baseline cho đến khi exact-head C-48 cho đủ ba runner.
  - Blockers: Chờ exact-head C-48 packaged matrix; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M: local council gate cho C-48
  - Files: toàn bộ batch injector ELF streaming, provenance, Design §16, checklist và implementation notes
  - Summary: Full suite đơn lẻ xanh 203 test file (202 pass + 1 intentional skip), 1823 test pass + 5 intentional skip; focused SEA/provenance 60/60.
  - Decisions: Typecheck, boundaries, 115 spec paths, diff-check và syntax checks xanh; lint 0 error/4 warning cũ. Hai failure ở một run chồng process đã được chạy riêng 41/41 rồi full suite sạch; không stage/chạm `tests/adapter/remote-asset-browser.test.ts` của người dùng.
  - Blockers: Exact-head Actions ba OS vẫn là authority; production supply-chain human gate vẫn mở.

2026-08-10 — Phase M: exact-head packaged matrix xanh đủ ba OS
  - Files: evidence run `31337022177`, checklist, Detailed Design §9.1 và implementation notes
  - Summary: Commit `0fdbd35` xanh toàn bộ 13/13 step trên artifact native: macOS `7m10s`, Linux `10m12s`, Windows `21m30s`; không step bắt buộc nào skip.
  - Decisions: Giữ hard ceiling darwin/Linux 120 s và Windows 180 s theo số runner thật. Online/offline cả ba OS đều tạo VieNeu WAV và H.264/AAC MP4 8 giây; UI/import/bridge/upload/SSE/CLI cancel/network cut/lease-loss/provenance đều pass; process proof exhaustive, zero survivor.
  - Blockers: Production supply-chain human gate vẫn mở; evidence này dùng digest-pinned non-release smoke fixture có opt-in, không được đổi thành production release claim.

2026-08-10 — Phase H/M: commit ba startup baseline và đóng self-disable gap C-49
  - Files: `.github/perf-baseline/{darwin-arm64,linux-x64,win32-x64}.json`, `scripts/{measure-startup,packaged-smoke/bodies}.mjs`, `tests/build/startup-baseline.test.ts`, Design §16 và implementation notes
  - Summary: Baseline từ exact-head evidence: darwin `813/611 ms`, Linux `1007/1004 ms`, Windows `2637/2461 ms` cho cold/warm serve.
  - Decisions: Baseline v1 bắt buộc exact runner + đúng hai integer measurement; packaged smoke fail khi file thiếu/hỏng/sai schema thay vì báo first-run rồi vô hiệu gate. Focused startup/packaged 25/25 và typecheck xanh trước khi thêm Windows baseline.
  - Blockers: Cần final exact-head rerun chứng minh `baselinePresent=true` và regression evaluation trên cả ba runner; production supply-chain human gate vẫn mở độc lập.

2026-08-10 — Phase M: local council gate cho C-49
  - Files: `.github/perf-baseline/*.json`, `scripts/{measure-startup,packaged-smoke/bodies}.mjs`, `tests/build/startup-baseline.test.ts`, Design §16, checklist và implementation notes
  - Summary: Full suite đơn lẻ xanh 203 test file, 1825 test pass + 5 intentional skip; focused startup/packaged 26/26.
  - Decisions: Typecheck, boundaries, 115 spec paths và diff-check xanh; lint 0 error/4 warning cũ. Không stage/chạm thay đổi người dùng ở `tests/adapter/remote-asset-browser.test.ts`.
  - Blockers: Exact-head Actions phải chứng minh ba baseline được load và regression gate chạy trên cả ba runner; production supply-chain human gate vẫn mở độc lập.

Format:
```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [path/to/file.ts]
  - Summary: [đã làm gì]
  - Decisions: [lệch khỏi design ở đâu — nếu vật chất thì thêm dòng vào Design §16, không sửa tại chỗ phần đã duyệt]
  - Blockers: [nếu có]
```
