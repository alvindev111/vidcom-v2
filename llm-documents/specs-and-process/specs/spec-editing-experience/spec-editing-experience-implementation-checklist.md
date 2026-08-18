# Spec Editing Experience — Implementation Checklist

> **Reference**: [Detailed Goals](./spec-editing-experience-detailed-goal.md) — bản 7, Approved 2026-08-16
> **Design**: [Detailed Design](./spec-editing-experience-detailed-design.md) — bản 12, Approved 2026-08-16
> **Main spec**: [spec-editing-experience-inprocess.md](./spec-editing-experience-inprocess.md)
> **Spike evidence**: [`spikes/phase-5/README.md`](../../../../spikes/phase-5/README.md) — 24 probe hợp lệ PASS + 1 superseded

## Context

Tài liệu này là **nguồn sự thật về thứ tự, trạng thái và evidence thực thi**. Nó không thay thế các
nguồn có thẩm quyền khác: Detailed Goals quyết định hành vi sản phẩm; Detailed Design quyết định
contract kỹ thuật; steering quyết định ranh giới kiến trúc; code hiện tại quyết định tên
file/symbol thật. Khi hai nguồn lệch nhau, dùng quy trình **Design drift** bên dưới, không chọn im
lặng một phía.

**Đọc trước khi chạy bất kỳ phase nào** (một lần, đầu phiên làm việc):
1. [`spec-rule.md`](../../rules/spec-rule.md) +
   [`implementation-guide.md`](../../rules/implementation-guide.md) — phase gate, vòng lặp per-task,
   quality gate và design-drift.
2. [Detailed Goals](./spec-editing-experience-detailed-goal.md) rồi
   [Detailed Design](./spec-editing-experience-detailed-design.md) — đọc header/approval, §5–§11 và
   §17 trước khi chọn task.
3. [`02-project-layout`](../../../steering/02-project-layout.md) ·
   [`03-architecture-ddd`](../../../steering/03-architecture-ddd.md) ·
   [`07-data-and-storage`](../../../steering/07-data-and-storage.md) ·
   [`10-testing`](../../../steering/10-testing.md) ·
   [`11-code-style`](../../../steering/11-code-style.md) — luật luôn áp dụng.
4. Các steering chuyên biệt trong bảng skill/read-first của phase: API/validation/security cho HTTP,
   MCP/protocol/agent-kit cho tool, documentation rules khi cập nhật spec.

> **Override cục bộ cho ví dụ cũ trong `implementation-guide.md`**: repo này dùng Hono + Core
> use case/port/adapter; các câu ví dụ nhắc Elysia hoặc “service abstract static” không phải convention
> của vidcom-v2. Code hiện tại + steering 02/03 mới là mẫu phải theo.

### Các điểm lệch steering đã được giải quyết trước khi thực thi

Approval checklist này đồng thời cho phép các cập nhật steering **hẹp** dưới đây. Agent phải sửa
steering ở phase được chỉ định **trước** khi viết đường code liên quan, ghi vào
`implementation-notes.html`, rồi tiếp tục; không mở lại câu hỏi đã được Design bản 12 chốt.

| Xung đột hiện tại | Quyết định có thẩm quyền cho spec này | Việc phải làm khi thực thi |
|---|---|---|
| `implementation-guide.md` yêu cầu branch sạch và commit đã push trước khi đánh `[x]` | Worktree hiện hữu của người dùng phải được bảo toàn; evidence gắn với source identity ở task 11.5a, commit/push chỉ khi người dùng yêu cầu | Áp dụng Autonomous Contract 1, 3, 11; không sửa guide dùng chung |
| steering 04 §4 nói upload là multipart | R5/Design §5.10 và §7.7 đã chốt XHR gửi raw `File`, daemon stream body trên listener HTTP/1.1 để giữ progress/cancel và RSS cho 500 MB | Task 5.0 cập nhật steering 04 cho raw bounded streaming upload trước task 5.1–5.7c |
| steering 03/04 yêu cầu MCP parity, steering 05 nói mọi write undo được qua revision history | Undo/redo là affordance của **studio session**, không phải project-content use case stateless; MCP write vẫn gọi cùng Core use case nhưng không được chèn vào stack UI. Decision 12/D7 cấm tool MCP undo/redo | Task S0.5 cập nhật steering 03/04/05 trước production code; P11.3a kiểm không drift, giữ tool parity cho các use case nội dung và không thêm tool undo/redo |
| steering 03/04 yêu cầu mọi HTTP use case có MCP parity, nhưng R5 nhận file local tới 500 MB | Giai đoạn 5 không phát tool upload/tree CRUD/apply-font mới: chưa có blob/resource transfer + authority an toàn, và MCP không được nhận absolute path. `save_file`/`delete_file` hiện hữu không bị gọi nhầm là parity đầy đủ | Approval checklist chốt ngoại lệ transport D9; task S0.5 ghi vào steering 03/04/05 trước P5 mà không đưa nghiệp vụ ra khỏi Core hoặc phát minh transport trong lúc implement |
| steering 08 coi mọi “snapshot” là job; P7 dùng batch renderer trực tiếp | Thumbnail timeline là derived-cache tương tác, bounded/cancellable/backpressured, không phải snapshot artifact bền và không ghi project | Task 7.0 làm rõ ngoại lệ trong steering 04/08 trước khi tạo route P7 |
| steering 10 còn test legacy `confirm` và coi MRTR là xác nhận, trái steering 05/13 | Cả hai era dùng daemon-issued approval grant; MRTR chỉ là kênh dẫn, legacy trả `approval_required` | Task S0.5 đồng bộ steering 10 trước production code; P11.3a kiểm lại trước contract test |

### Mười luật bất biến của spec này (vi phạm = task chưa xong)

| # | Luật | Nguồn |
|---|---|---|
| L1 | Mọi ghi project đi qua **`WriteAuthority.mutateSource`** — file authored là step `write`/`delete`, preview settings là step **`kind: "entity"`** trong cùng `CompositeRequest` (xem `project-writes.ts:107` làm mẫu). `mutateEntity` là helper **private** trong `WriteAuthority`, **không** phải API để gọi và **không** được đổi thành public. Không có đường ghi filesystem/entity thứ hai. | Goals §Spec Goal · Design §5.5 |
| L2 | Một thao tác nội dung của người dùng = **một** mutation composite. Ngoại lệ **duy nhất**: thả file từ ngoài vào timeline (R11.2) = upload rồi mount = hai mutation. | Design §6.1 |
| L3 | Mọi ghi mang precondition: `expectedContentHash` (file) hoặc `expectedRevision` (entity/plan). Thiếu ⇒ `PreconditionRequired` 400. | Goals §Spec Goal, steering 06 §7 |
| L4 | Quyết định nội dung nằm ở Core; UI/route không tự tính timing, thứ tự, cue hay tên file. Cơ chế cần dependency infrastructure (SVG DOM parser, media/font probe) đi qua Core port và Adapter hiện thực, không kéo dependency vào Core. | steering 03 · Design §5.12 |
| L5 | Test logic chạy dưới `environment: "node"` (repo **không có** jsdom/happy-dom). Hành vi chỉ tồn tại trong component là hành vi không test được. | Goals §Testing |
| L6 | Mã lỗi theo steering 04 §3.3: invariant nghiệp vụ **422**, xung đột hash **409**, quá lớn **413**, chưa hỗ trợ loại **415**. Map ở **middleware**, không rải trong route. | Design §8.1 |
| L7 | Lịch sử undo **không persist**: bộ nhớ daemon, khoá `(studioSessionId, projectId)`, tối đa 50 mục. Không thêm bảng SQLite cho nó. | Goals OQ-2, Design §6.1 |
| L8 | Schema request/response định nghĩa một lần trong `packages/contracts/src/editing.ts`, export qua `index.ts`; bề mặt được expose cả HTTP/MCP phải import lại cùng shape, không copy Zod ở route/tool. Ngoại lệ browser-only D7/D9 vẫn dùng contract tập trung cho HTTP, không tạo schema MCP giả. | Design §7 |
| L9 | Mọi port/service mới phải được nối ở production composition root (`packages/cli/src/composition-root.ts`) và startup/recovery tương ứng; unit test với port giả không chứng minh wiring production. | steering 02/03 · Design §4.5 |
| L10 | Persistence test dùng SQLite file thật + filesystem temp thật; migration phải generate/version/package được và boot hai lần idempotent. Không mock `node:fs`, không dùng DB in-memory thay evidence. | spec-rule · steering 07/10 |

## Autonomous Execution Contract

Mục này là chỉ dẫn tường minh để agent có thể chạy liên tục **sau khi Approval Gate của checklist
được người dùng duyệt**, không hỏi lại về lựa chọn kỹ thuật đã nằm trong phạm vi spec.

1. **Khôi phục trước khi chọn việc mới**: đầu mỗi phiên đọc `git status --short`, diff hiện tại,
   Execution Log và phần cuối `implementation-notes.html`. Nếu có đúng một task `[/]`, resume task
   đó trước mọi task `[ ]`; không tin trạng thái checkbox nếu diff/evidence hiện tại mâu thuẫn. Nếu
   phiên trước dừng giữa lệnh test, chạy lại focused gate từ đầu và ghi evidence mới.
2. Một prerequisite `P<n>` được coi là `[x]` **chỉ khi** mọi task và Acceptance Criteria của phase đó
   là `[x]`, Deliverables đã ghi đường dẫn thật, và phase gate có dòng `PASS` trong Execution Log.
   `[!]`, `NOT EXECUTED`, Deliverables trống hoặc chỉ có test hẹp hơn phạm vi đều có nghĩa phase chưa
   đóng. Khi không có task `[/]`, chọn task `[ ]` đầu tiên theo **Recommended execution order** có mọi
   prerequisite đã đóng; trong một phase làm theo thứ tự task từ trên xuống.
3. Chỉ một task `[/]` tại một thời điểm. Trước khi đổi `[ ]` → `[/]`, ghi một dòng checkpoint vào
   Execution Log gồm task, baseline `HEAD`, trạng thái dirty và focused command dự kiến; điều này là
   điểm phục hồi nếu agent/context bị thay giữa chừng.
4. Nếu code đã có hành vi task yêu cầu, **không rewrite**: thêm/kiểm evidence đúng phạm vi, log file
   hiện hữu và đánh `[x]` khi mọi gate pass.
5. Nếu file/symbol đã đổi tên, dùng CodeGraph trước, rồi `rg --files`/`rg` để tìm equivalent hiện tại;
   cập nhật `Files affected` + Execution Log và tiếp tục. Đây không phải lý do hỏi người dùng.
6. Quy tắc chọn khi có nhiều cách kỹ thuật cùng đáp ứng AC: Goals → Design → steering → pattern gần
   nhất trong code → diff nhỏ nhất. Ghi lựa chọn vào `implementation-notes.html`.
7. Nếu phát hiện thiếu task nhưng không đổi AC/contract, chèn task vào phase đúng, cập nhật dependency
   + coverage matrix, log rồi tiếp tục. Task ước vượt 4 giờ phải tách trước khi code.
8. Nếu cần đổi interface §5/§7, data model §6 hoặc Decision Record §10, cập nhật Detailed Design
   **trước**, thêm Decision/erratum, đồng bộ checklist và log; tiếp tục mà không hỏi nếu thay đổi chỉ
   là kỹ thuật nội bộ và vẫn giữ nguyên AC/security/scope.
9. Chỉ dừng để hỏi khi lựa chọn sẽ đổi hành vi người dùng/AC, mở rộng scope, hạ security hoặc cần một
   hành động ngoài repo chưa được uỷ quyền. Môi trường thiếu Chrome/network không chặn task độc lập:
   ghi `[!]` cho đúng evidence, tiếp tục nhánh không phụ thuộc, tuyệt đối không fake PASS.
10. Test đỏ do diff hiện tại ⇒ sửa trước khi đi tiếp. Test đỏ có sẵn ⇒ chứng minh bằng baseline, ghi
   log và không disable/đổi assertion để che lỗi.
11. Không tự làm sạch/stash/reset worktree, commit, push, mở PR hoặc cập nhật hệ thống ngoài repo nếu
   request thực thi không yêu cầu. Với checklist này, câu “branch sạch/commit đã push” trong
   `implementation-guide.md` bị override: task được đóng bằng source identity + evidence tại chỗ;
   khi có PR, exact-HEAD CI chỉ là gate bổ sung.
12. Mỗi task: Analyze → `[/]` → test fail (khi áp dụng) → implement → focused test → phase gate →
    cập nhật checklist + `implementation-notes.html` → `[x]` → task sẵn sàng tiếp theo.
13. Nếu thiếu `node_modules`, chạy `bun install --frozen-lockfile`; không sửa lockfile để “cho qua”.
    Nếu thiếu Chromium và network có sẵn, dùng đúng bootstrap của workflow:
    `node node_modules/hyperframes/bin/hyperframes.mjs browser ensure` để cài vào cache mà resolver
    hiện tại đọc; không đổi sang cache Playwright khác. Nếu network không có thì ghi `[!]` cho đúng
    browser evidence và tiếp tục task độc lập, không hỏi lại và không giả PASS.

## Approval Gate

> Không viết production code trước khi mục này được xác nhận tường minh.

- **Status**: **Approved**
- **Confirmed by**: người dùng (chủ dự án)
- **Confirmation date**: 2026-08-16
- **Notes / required revisions before code execution**: Việc duyệt
  bao gồm bảng **Các điểm lệch steering**, erratum path `applyCompositionOps` và D9 MCP blob/file-manager
  R5 ở trên; Detailed Design bản 12 đã Approved, không cần một vòng duyệt Design khác.

## Sequencing Strategy

**Chosen strategy**: Foundation-First, rồi Feature-Slice.

**Rationale**: Tám requirement (R2, R3, R5, R6, R8, R9, R10, R11) đều cần trực tiếp hoặc gián tiếp
**cùng** một nền: receipt trong biên
mutation, step `mkdir`/`rmdir`, `write-staged`, và sự kiện có `paths`. Làm nền trước một lần rẻ hơn
sửa `WriteAuthority` lặp lại theo từng feature. Sau nền, mỗi requirement là một lát cắt dọc đi từ
Core ra UI.

## Dependency Order

```
S0              → P0
P0              → P3
P0 + P3         → P1, P2, P4, P5
P0 + P4 + P5    → P7
P0 + P2 + P3    → P8
P3 + P4         → P6
P2 + P3 + P5    → P9
P0 + P2 + P3 + P4 → P10
P1…P10          → P11
```

**Recommended execution order**: S0 → P0 → P3 → P4 → P1 → P2 → P5 → P6 → P7 → P8 → P9 → P10 → P11.

**Parallelizable**: checklist mặc định cho **một agent tuần tự**. Nếu nhiều agent được người dùng cho
  phép tường minh, sau P0 làm P3; sau P3 có thể tách P4 · P1 · P5, P2 cũng chờ P3;
  P8 chờ thêm P2,
P6 chờ P3 + P4; P7 chờ thêm safe-CSS seam của P5; còn P9/P10/P11 giữ dependency như sơ đồ. Không tự spawn agent từ tài liệu này.

---

## LLM Agent — Skill Activation Per Phase

> [!IMPORTANT]
> Trước khi thực thi mỗi phase, MUST đọc skill và các file nguồn ở hàng tương ứng. Không đoán API.

| Phase | Skills to activate | Source files to read BEFORE modifying |
|---|---|---|
| S0 Bootstrap | `.agents/skills/bun/SKILL.md` | Approval Gate của checklist, header của ba tài liệu spec, `git status --short`, `package.json` scripts, Packaging implementation checklist đang in-process, steering 03/04/05/10 (các câu xung đột trong bảng trên) |
| P0 Nền Core | `.agents/skills/bun/SKILL.md` (chạy test) | `packages/core/src/service/write-authority.ts` (FULL — `executeComposite`, `validateCompositePreconditions`, `executeValidatedComposite`), `packages/core/src/port/types.ts` (search `CompositeStep`, `WriteEnvelope`, `StagedFileSource`), `packages/core/src/port/ports.ts` (search `CompositeMutationJournalPort`), `packages/adapter/src/db/schema.ts` (search `workspace_operation`) |
| P1 Kéo timing | `.agents/skills/bun/SKILL.md` | `src/components/studio/timeline.tsx`, `src/components/studio/timeline-track.tsx`, `src/lib/studio/format.ts`, `packages/core/src/usecase/project-writes.ts` (search `setSceneTiming`) |
| P2 Thứ tự + nhóm | `.agents/skills/bun/SKILL.md` | `src/lib/studio/scene-order.ts` (FULL), `packages/core/src/domain/invariants.ts` (FULL), `packages/core/src/usecase/project-writes.ts` (search `setSceneTiming`), `packages/core/src/usecase/scene-deletion.ts` (search `prepareSceneDeletion`, `digestPlan`) |
| P3 Undo/redo | `.agents/skills/bun/SKILL.md` + `.agents/skills/hono/SKILL.md` | P0 deliverables, `packages/cli/src/{composition-root.ts,startup.ts,next-host.ts}`, `packages/server/src/{app.ts,routes/project-writes.ts,middleware/error-mapper.ts}`, `src/lib/api/services.ts` |
| P4 Preview host | `.agents/skills/bun/SKILL.md` | `src/components/studio/use-hyperframes-player.ts` (FULL), `src/components/studio/studio-shell.tsx`, `packages/adapter/src/hyperframes/document.ts` (FULL), `packages/core/src/usecase/project-reads.ts` (search `getProjectPreview`), `packages/worker/src/render-job.ts` (search `preflightRenderDocument`), `spikes/phase-5/run-spike-5.mjs` (FULL) |
| P5 File & asset | `.agents/skills/bun/SKILL.md` + `.agents/skills/hono/SKILL.md` | `llm-documents/steering/04-api-design.md` §4, `packages/server/src/app.ts` (body limit), `packages/server/src/routes/project-writes.ts` (search `assets/bgm`), `packages/core/src/usecase/project-assets.ts`, `packages/core/src/usecase/file-deletion.ts`, `packages/adapter/src/fs/workspace-fs.ts`, `packages/adapter/src/runtime/node-process-runner.ts`, `packages/adapter/src/hyperframes/font-compatibility.ts`, `packages/cli/src/{composition-root.ts,startup.ts}` |
| P6 Caption | `.agents/skills/bun/SKILL.md` | `packages/core/src/domain/word-timings.ts` (FULL), `packages/core/src/port/tts-port.ts` (search `TtsWordTiming`), `packages/adapter/src/hyperframes/sdk-ops.ts` (FULL `applyCompositionOps`) + `parse.ts` (caller), `packages/adapter/src/hyperframes/preview-style.ts` (FULL), `spikes/phase-5/fixture/index.html` (script caption đã đo) |
| P7 Thumbnail | `.agents/skills/bun/SKILL.md` + skill global `hyperframes-cli` (đọc `SKILL.md` từ skill catalog đang hoạt động) | `llm-documents/steering/04-api-design.md` §6 + `08-jobs-and-queue.md`, deliverable của P5: `packages/adapter/src/hyperframes/safe-css.ts` (chưa tồn tại trước P5), `packages/worker/src/snapshot-job.ts` (FULL — mẫu batch + AbortSignal), `packages/core/src/usecase/thumbnail.ts`, `packages/adapter/src/hyperframes/parse.ts` (FULL), `src/components/studio/timeline-elements.tsx` |
| P8 Catalog + block | `.agents/skills/bun/SKILL.md` + `.agents/skills/http-driver/SKILL.md` | `packages/core/src/usecase/motion-library-install.ts` (FULL), `node_modules/@hyperframes/core/dist/registry/types.d.ts` (schema 0.7.86 thực), `node_modules/hyperframes/dist/cli.js` (search `DEFAULT_REGISTRY_URL`, `fetchRegistryManifest`, `fetchItemManifest`), `packages/adapter/src/bgm/bgm-provider.ts` (bounded HTTPS/SSRF pattern), `packages/adapter/src/runtime/{runtime-paths.ts,packaged-runtime-manifest.ts,runtime-asset-source.ts}`, `packages/cli/src/runtime-paths-source.ts`, `scripts/{stage-artifact-runtime,build-runtime-archives,verify-artifact}.mjs` |
| P9 Kéo asset | `.agents/skills/bun/SKILL.md` + `.agents/skills/hono/SKILL.md` | P5 + P2 + P3 deliverables, `packages/core/src/usecase/project-writes.ts` (search `createScene`), `packages/cli/src/startup.ts`, `src/components/studio/scene-media-list.tsx` |
| P10 Draft & phím tắt | `.agents/skills/bun/SKILL.md` + `.agents/skills/http-driver/SKILL.md` | `src/components/studio/use-source-files.ts` (FULL), `src/app/projects/[slug]/composer-client.tsx` (FULL), `src/lib/studio/format.ts` |
| P11 Chốt chất lượng | `.agents/skills/bun/SKILL.md` + `.agents/skills/mcp-builder/SKILL.md` | `llm-documents/steering/{03-architecture-ddd,04-api-design,05-mcp-tool-design,10-testing,13-mcp-protocol-compatibility}.md` (các đoạn D1/parity/approval), `tests/support/browser-harness.ts` (FULL), `package.json` (FULL), `.github/workflows/phase4-browser-session.yml`, `packages/mcp/src/registry/registry.ts` (FULL), `packages/mcp/src/registry/write-tools.ts`, `packages/agent-kit/AGENTS.md` |

**Lưu ý về template**: template checklist nhắc tới `backend-docs/` và `frontend-docs/` — hai thư mục đó **không tồn tại** trong repo này. Luật code nằm ở
`llm-documents/steering/11-code-style.md`; đọc nó một lần trước P0.

---

## Task Status Legend

- `[ ]` — chưa bắt đầu
- `[/]` — đang làm
- `[x]` — xong (đã implement, có test, đã validate)
- `[!]` — bị chặn (kèm ghi chú nêu rõ vì sao)

---

## Phase S0: Bootstrap thực thi sau khi checklist được duyệt

**Addresses**: phase gate, provenance và khả năng tiếp tục qua nhiều phiên
**Design reference**: Design Approval Gate §15 · `spec-rule.md` Task Execution Workflow
**Files affected**: main spec + mọi reference do S0.2 discover trong repo; `llm-documents/steering/{03-architecture-ddd,04-api-design,05-mcp-tool-design,10-testing}.md`; tạo `implementation-notes.html`
**Prerequisite**: Approval Gate của checklist đã được người dùng chuyển sang `Approved`
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: header/Approval Gate của Goals, Design, checklist và main spec; `package.json`;
`git status --short`; trạng thái/gate còn mở trong
`../spec-packaging-and-distribution/spec-packaging-and-distribution-implementation-checklist.md`;
steering 03/04/05/10 ở đúng các đoạn D1/parity/history/approval đã liệt kê

**Tasks**:
- [x] S0.1 Xác nhận Goals, Design và checklist đều Approved; nếu chưa thì dừng trước production code
  - _Requirements: process gate_ — _Design: §15 · spec-rule workflow_
- [x] S0.2 Đổi main spec `pending` → `inprocess` và sửa **mọi** tham chiếu tên file cũ
  - Trước rename, chạy `rg -l "spec-editing-experience-"'pending' --glob '!node_modules/**' --glob '!dist/**'`
    từ repo root và dùng **kết quả hiện tại** làm danh sách authority; không hard-code số file hay đoán
    Design/`process.md` có link. Sửa mọi kết quả + rename file bằng thao tác recoverable.
  - **Kiểm bắt buộc sau khi đổi**: cùng lệnh `rg` ghép pattern ở trên trả về **rỗng**; mọi target
    Markdown vừa sửa tồn tại. Chạy `bun run test:spec-paths` như regression repo, nhưng không dùng
    nó làm bằng chứng cho spec này vì script chưa đăng ký Editing Experience cho tới task 11.5a.
  - Không đổi nội dung Goals/Design đã duyệt — chỉ sửa đường dẫn
  - _Requirements: process state_ — _Design: §15 · spec-rule workflow_
- [x] S0.3 Tạo `implementation-notes.html` cạnh checklist: tiếng Việt, một trang Tailwind CDN; có mục quyết định, lệch Design, trade-off, bất ngờ/gotcha, test/evidence và blocker; append **ngay trong từng task**, không batch cuối phase
  - _Requirements: execution evidence_ — _Design: §11, §15 · spec-rule workflow_
- [x] S0.4 Ghi baseline vào Execution Log: HEAD, `git status --short`, thay đổi có sẵn của người dùng; chạy `bun run typecheck` và focused suite gần nhất hoặc ghi rõ lỗi baseline có sẵn
  - Ghi riêng trạng thái spec Packaging và exact AC packaged/release còn mở. Nếu exact-host artifact +
    runtime inputs đã có, chạy full strict packaged smoke baseline; nếu không thì ghi `NOT EXECUTED`.
    P11 chỉ được gọi một failure là baseline khi có evidence S0 hoặc nó map đúng nguyên văn tới AC
    Packaging vẫn đang mở ở source identity lúc P11 chạy.
  - Không stage/ghi đè thay đổi không thuộc spec; không tự commit/push/PR.
  - _Requirements: provenance_ — _Design: §11_
- [x] S0.5 Đồng bộ authority steering đã được Approval Gate ratify, **trước production code**
  - Sửa steering 03/04: D1 vẫn bắt mọi nghiệp vụ/use case ở Core, nhưng parity transport chỉ bắt
    operation có input biểu diễn an toàn trên cả HTTP/MCP; local studio-session D7 và local-file/blob
    D9 là hai defer tường minh, không phải giấy phép đặt nghiệp vụ trong route.
  - Sửa steering 05: write vẫn audit/precondition, nhưng chỉ mutation có `origin.kind:"ui"` và
    đúng session mới vào history; MCP/CLI/external write không vào stack UI; không phát tool undo/redo.
  - Sửa steering 10: legacy thiếu daemon approval grant trả `approval_required`; modern MRTR chỉ là
    kênh dẫn tới grant, không phải bằng chứng duyệt; bỏ expectation `confirm:true` cũ.
  - Chỉ sửa đúng các câu xung đột được liệt kê; ghi diff + link mục steering vào
    `implementation-notes.html`, rồi chạy link/check format trước khi đóng S0.
  - _Requirements: process authority; Deferred D7/D9_ — _Design: §7, Decision 12, §13, §15_

**Acceptance Criteria**:
- [x] Main spec ở trạng thái `inprocess`; mọi link được S0.2 sửa đều trỏ target tồn tại
- [x] `implementation-notes.html` tồn tại; baseline ghi rõ PASS (typecheck, write-authority 26/26) và không có FAIL có sẵn
- [x] Steering 03/04/05/10 không còn câu buộc agent chọn ngược D7/D9 hoặc approval-grant contract

**Deliverables Created / Modified**:
- `llm-documents/specs-and-process/specs/spec-editing-experience/spec-editing-experience-inprocess.md` — đổi tên từ `-pending.md` (git mv), header + Phase Approvals + Standups cập nhật
- `llm-documents/specs-and-process/specs/spec-editing-experience/implementation-notes.html` — mới
- `llm-documents/product-features/15-build-order.md`, `…/spec-editing-experience-detailed-goal.md`, `…/spec-editing-experience-implementation-checklist.md` — sửa link tên file
- `llm-documents/steering/{03-architecture-ddd,04-api-design,05-mcp-tool-design,10-testing}.md` — đồng bộ D7/D9, lịch sử UI và approval grant

---

## Phase 0: Nền Core — receipt, step thư mục, staged write, sự kiện có `paths`

**Addresses**: điều kiện tiên quyết của R2, R3, R5, R8, R9, R10, R11
**Design reference**: §5.5, §5.7, §5.11 (bảng step thư mục), Decision 1/4/11
**Files affected**: `packages/core/src/port/{types.ts,ports.ts,mutation-observer.ts}`, `packages/core/src/service/write-authority.ts`, `packages/core/src/usecase/reconcile-composite-mutation.ts`, `packages/adapter/src/fs/{workspace-fs.ts,staged-asset.ts,mutation-capture.ts,watcher.ts,large-content-store.ts}`, `packages/adapter/src/db/{schema.ts,journal.ts,event-outbox.ts,migrate.ts}`, `drizzle/**`, `packages/adapter/src/runtime/packaged-runtime-manifest.ts`, `packages/contracts/src/{editing.ts,errors.ts,index.ts}`, `packages/server/src/middleware/error-mapper.ts`, `packages/cli/src/{composition-root.ts,startup.ts}`
**Prerequisite**: S0
**Skill**: `.agents/skills/bun/SKILL.md` — mục chạy test, để chạy `bun run test` sau mỗi task
**Read first**: `packages/core/src/service/write-authority.ts` (FULL) — hiểu `executeComposite`, thứ tự capture → backup → publish → commit → `discardCaptures`

**Tasks**:
- [x] 0.1 Thêm `MutationOrigin` và `MutationReceipt` vào `packages/core/src/port/mutation-observer.ts`
  - `MutationOrigin { kind: "ui"|"mcp"|"cli"|"system"; sessionId: string|null; label: string|null; historyAction: "record"|"undo"|"redo"|"ignore"; historyOperation:{id,targetReceiptId}|null }`
  - `UndoContentRef = inline(bytes,encoding,hash) | object(hash,encoding)` và `UndoContentPort`
    `retainBytes(storage:inline|object)/retainFile/resolve/release`; mở rộng `LargePreviousContentStore` hiện có bằng streaming
    file/object + live lease, không tạo bảng/history row.
  - `MutationReceiptStep` là **union năm nhánh**: `file` undoable có
    `beforeContent`/`afterContent: UndoContentRef|null`, `file` non-undoable (chỉ hash +
    `omittedReason:"not-undoable"`), `directory` (`op`, `path`, `existedBefore`, `undoable`),
    `pending-mount` (operation + state trước/sau), và `entity` (`undoable:boolean`, `backingPath`,
    before/after state, from/to revision).
  - Receipt có `paths` = path thực sự đổi và
    `readGuards:{path,state:file(contentHash)|directory}[]` cho ownership dependency không bị mutation ghi.
    Không flatten guard thành một tập path đối xứng: ownership và typed dependency có hai phép barrier
    khác nhau ở task 3.1b. Chỉ Core thêm guard đã resolve; transport không nhận field này.
  - `MutationObserverPort { claimHistoryOperation(...); abortHistoryOperation(...);
    blockHistoryOperation(...); emit(receipt);
    observeExternalChange(...); invalidateProject(...) }` — **không ném**. `observeExternalChange`
    chỉ nhận path watcher đã phân loại external; receipt own-write không đi method này.
  - Receipt id bền `journal:<decimal JournalId>` theo Design bản 12 (không ULID mới, không cột DB mới). Nhánh recovery dựng lại đúng id và id trỏ thẳng tới audit journal.
  - _Requirements: R3.1_ — _Design: §5.5_
- [x] 0.2a `CompositeRequest` nhận `origin: MutationOrigin`
  - **Bridge chỉ tồn tại trong P0**: vì P3 chưa có session/header/UI helper, các browser route hiện hữu
    dùng một hằng có tên `UNTRACKED_UI_ORIGIN = {kind:"ui", sessionId:null, label:null,
    historyAction:"ignore", historyOperation:null}` để giữ compile + hành vi hiện tại. Không rải object literal và không coi
    receipt của bridge là lịch sử người dùng. Task 3.3 phải xoá hằng này rồi server **tự** dựng
    `{kind:"ui", sessionId, historyAction:"record", historyOperation:null}` từ header hợp lệ; nhãn do server/use case quyết,
    không tin `kind`, `historyAction` hoặc label tuỳ ý từ payload.
  - Mọi call site không phải browser truyền đúng nguồn (`"mcp"`, `"cli"`, `"system"` cho recovery/bootstrap) với `sessionId:null`, `label:null`, `historyAction:"ignore"`, `historyOperation:null`; compile toàn monorepo bắt mọi call site thiếu.
  - _Requirements: R3.1_ — _Design: Decision 1_
- [x] 0.2b `CompositeRequest` nhận typed internal `historyReadGuards`
  - Thêm internal `historyReadGuards?:{path,state:file(hash)|directory}[]`; `WriteAuthority` resolve/dedupe và kiểm
    hash dưới project mutex trước capture/publish. HTTP/MCP schema không nhận field này; catalog Core
    là caller đầu tiên thêm reuse target. Cùng canonical path + khác hash ⇒ schema invalid; path trùng
    mutation step bị từ chối để không có hai precondition authority. Mismatch ⇒ `WriteConflict` và
    zero write. Khi có grant, read-guard hashes được nhập vào `observedHashes` để binding cũng khóa chúng.
  - _Requirements: R3.1, R3.5_ — _Design: Decision 1_
- [x] 0.3a Retain content và reserve history bên trong `executeValidatedComposite`
  - Sau capture/trước publish, retain before/after content: ≤64 KiB inline, lớn hơn hoặc staged source
    vào content object theo stream; **tổng inline mỗi receipt tối đa 256 KiB**, phần còn lại ép object
    dù từng file nhỏ. Retain lỗi ⇒ dừng trước publish. Receipt dùng refs + hash, không
    dựng `Uint8Array` lớn từ `validated.intent`.
  - Với origin undo/redo, gọi `claimHistoryOperation` sau mọi precondition/retain và ngay trước publish
    khi project mutex còn giữ; claim fail ⇒ `WriteConflict`, zero write. Rollback/abort gọi
    `abortHistoryOperation`; reconciled-committed hoàn tất bằng `emit`, outcome mơ hồ invalidate stack.
  - _Requirements: R3.1, R3.5_ — _Design: §5.5_
- [x] 0.3b Phát receipt **sau** `commitComposite`, **trước** `discardCaptures` và chuyển ownership refs
  - Entity validated intent có `undoable` chỉ Core use case đặt; standalone `mutateEntity` false,
    cleanup trong source composite có thể true. Transport schema không nhận cờ này từ client.
  - Bọc `emit` trong `try/catch` **riêng**, ngoài khối commit; `EmitResult.ok === false` ⇒ gọi `observer.invalidateProject(projectId, "history-desync")`
  - Quyền sở hữu refs chuyển cho observer khi nhận thành công; fail/rollback/observer reject phải
    release. Nhánh duplicate recovery để `MutationHistory` release refs bản trùng, không leak ref-count.
  - _Requirements: R3.1, R3.5_ — _Design: §5.5_
- [x] 0.3c Receipt cho reconcile-committed và startup recovery
  - Reconcile-committed cùng process phát receipt với origin/reservation gốc. Startup reconcile chạy
    trước listener phát cùng id/steps/paths nhưng origin `system/ignore`, không persist history secret
    và không dựng lại stack phiên cũ; `id = journal:<JournalId>` để observer idempotent.
  - _Requirements: R3.1, R3.5_ — _Design: §5.5_
- [x] 0.4 Sự kiện composite mang `paths` và source đã redact
  - Payload thành `{ composite: true, paths, source: origin.kind }`; **dựng từ validated intents trước
    `commitComposite`** và persist trong cùng giao dịch outbox. Không serialize `sessionId`, label,
    historyAction, historyOperation hay `readGuards` vào event/SSE/audit payload.
  - Thêm Core port `ProjectPathInvalidator.invalidate(projectId, paths)`. `WriteAuthority` gọi sau
    commit bằng đúng tập path đó; composition root hiện fan-out tới `ProjectCache`, P7 nối thêm
    thumbnail/dependency cache. `WorkspaceWatcher` cũng nhận port này thay vì concrete `ProjectCache`.
  - Port/fan-out non-throwing, isolate từng consumer (ProjectCache trước); lỗi cache sau commit chỉ
    log/metric redacted, không đổi mutation thành failure/không giết watcher hoặc bỏ consumer kế tiếp.
  - `WriteEnvelope.changeSeq:number|null`: journal commit trả seq event insert cùng transaction;
    unchanged/no-event là null. Thêm `EventOutboxPort.latestProjectSeq(projectId)` + hiện thực SQL
    `MAX(seq) WHERE project_id = ?`, trả 0 khi chưa có event; watcher dùng exact seq từ `append` hiện có.
    Không query latest sau mutation để gán nhầm seq của write khác.
  - _Requirements: R8.1d, R10.6_ — _Design: §5.7_
- [x] 0.5a Mở contract `CompositeStep` + capture cho `mkdir` / `rmdir`
  - `mkdir.expectExisting:"absent"|"either"`: absent collision ⇒ conflict; either chỉ no-op khi target
    là directory và ghi `existedBefore:true` + directory read guard, file/symlink ⇒ conflict. `rmdir`:
    hợp lệ khi `entries(path) ⊆ {path của step delete/rmdir đứng trước trong cùng mutation}` — validate trên **snapshot + tập đã lên kế hoạch**, không hỏi trạng thái tương lai
  - Mở rộng `WorkspacePort`/mutation-capture bằng union file/directory, không gọi `readFile` trên thư mục. Capture thư mục chỉ ghi `existedBefore`, không bytes.
  - _Requirements: R5.1–5.3_ — _Design: §5.11, Decision 11_
- [x] 0.5b Nối publish/rollback/journal/reconcile cho step thư mục
  - Publish `mkdir` không recursive/không overwrite; race có mục ngoài xuất hiện ⇒ conflict/reconcile, không nhận vơ mục đó. Rollback chỉ `rmdir` thư mục do mutation tạo và còn rỗng.
  - Publish `rmdir` chỉ khi rỗng; race có mục ngoài xuất hiện ⇒ fail an toàn, không xoá. Rollback chỉ `mkdir` khi thư mục vắng.
  - Journal serialize/check/reconcile cả hai kind; thứ tự `mkdir` nông-trước, file delete trước, `rmdir` sâu-trước và sau mọi file delete trong cây.
  - _Requirements: R5.1–5.3_ — _Design: §5.11, Decision 11_
- [x] 0.5c Tracker/watcher cho state file, directory và absent
  - Đổi `WrittenHashTracker` thành tracker trạng thái `file(hash) | directory | absent` cho **mọi**
    path. Arm theo `journalId` trước publish; watcher gặp path pending phải chờ settle rồi resample.
    Commit chọn after-state, rollback chọn before-state; trạng thái không xác định/lệch đi đường
    external. Own `mkdir`/`rmdir`/delete không được phát giả event `source:"external"` rồi tự chặn undo.
  - Sau khi xác nhận external, watcher gọi cả `ProjectPathInvalidator` và
    `MutationObserverPort.observeExternalChange`; own-write echo không gọi observer. Hai fan-out đều
    isolate lỗi để history/cache consumer hỏng không giết watcher.
  - `fs.watch` filename phải qua `WorkspacePort` resolver/containment rồi mới thành canonical `RelPath`;
    reject absolute/`..`/NUL/symlink escape, không `path.join` + cast thẳng trước khi hash/event/barrier.
  - _Requirements: R5.1–5.3_ — _Design: §5.11, Decision 11_
- [x] 0.6a Thêm `CompositeStep` kind `write-staged` cho authored write
  - Guard hiện tại (`authored writes cannot use a staged file source`) đổi thành: authored **chỉ** được staged qua `write-staged`, và hash phải khớp sau publish
  - Step có `undoable` do Core use case đặt: asset upload chỉ create (`expectedContentHash:null`, false);
    catalog/history cho phép create hoặc replace có precondition (true). Route không nhận
    `sourcePath`/role/ref; chỉ use case nhận opaque `StagedFileSource` từ adapter port.
  - Publish tái sử dụng/mở rộng `StagedAssetPort.stageFile → commit/cleanup`: O_NOFOLLOW + regular-file
    + hash verify. Create dùng hard-link no-overwrite/EXDEV `COPYFILE_EXCL`; replace copy/link vào temp
    cùng target directory rồi atomic swap dưới capture/rollback, không overwrite ngoài precondition.
    `write-staged` yêu cầu parent directory đã tồn tại/contained và không tự `mkdir recursive`; caller
    cần parent mới phải thêm step `mkdir` journaled đứng trước (catalog/rename/redo package).
  - _Requirements: R5.4e_ — _Design: Decision 4_
- [x] 0.6b Chuyển toàn bộ hậu kiểm/cleanup staged và large-content store sang streaming
  - Sửa `WorkspaceFs.readHash`, nhánh cleanup target của `AppDataAssetStager` **và**
    `WorkspaceWatcher.observe` sang hash bằng stream; mở rộng `LargePreviousContentStore.put/read`
    với file stream + verify hash (không `readFile` object lớn). Watcher mở no-follow, phân biệt regular
    file/directory/absent. Tuyệt đối không `readFile()` asset lớn ở hậu kiểm/rollback/own-write
    suppression; notification thư mục không được rơi vào vòng retry.
  - _Requirements: R5.4e_ — _Design: Decision 4_
- [x] 0.7 `PendingMountTransition` bền từ `beginComposite`
  - `beginComposite(..., pending?: open | close | reopen)` — `operationId` luôn ở top-level và ghi
    vào cột `pending_transition`; `close.previousFailure` do Core lấy từ row (không từ client),
    `reopen` mang `expectedSceneId` + failure cần restore và chỉ history inverse tạo.
  - `open.record` gồm `assetPath`, `assetContentHash`, `uploadFingerprint`, at/track/project. Validate trước publish: path/hash đúng step `write-staged` cùng journal và fingerprint khớp canonical metadata + staged content hash; `close` khớp row uploaded; `reopen` khớp row mounted + scene. `mountedRevision` lấy từ revision commit, không nhận từ client.
  - `commitComposite` đọc ý định đã bền và áp trong **cùng** transaction; `reconcileCompositeMutation` khi kết luận `committed` **cũng** áp lại
  - _Requirements: R11.3b_ — _Design: §5.21, §6.5_
- [x] 0.8 Migration: bảng `pending_mount` + cột `pending_transition` — sinh bằng **`bun run db:generate`** (`drizzle-kit generate`), giữ file migration sinh ra trong diff; **không** viết SQL tay ngoài pipeline drizzle
  - Cột/CHECK theo §6.4, gồm `asset_content_hash` + `upload_fingerprint`; index `(project_id, state)`
    và `(state, updated_at)`; cặp `last_error_code`/`last_error_message` cùng null hoặc cùng có.
    Thêm expression index trên `mutation_journal` để tra open `pending_transition.operationId` sau
    khi row pending bị retention xoá; operation đã từng tồn tại không được mở lại như ULID mới.
  - `mounted`: có scene+revision, không lỗi; `uploaded_unmounted`: không result, có thể có lỗi; `abandoned`: không result và bắt buộc có lý do.
  - Generate bằng `bun run db:generate`, boot DB file thật hai lần; thêm migration vào `packages/adapter/src/runtime/packaged-runtime-manifest.ts` và artifact staging/smoke. **Không** đổi `workspace_operation`.
  - _Requirements: R11.3b_ — _Design: §6.4, §6.5_
- [x] 0.9 Bổ sung contract/error mapper và production wiring
  - Tạo `packages/contracts/src/editing.ts`, export ở `index.ts`; HTTP/MCP sẽ dùng chung schema. Thêm `InvariantViolated` (422), `IntegrityMismatch` (422) nếu chưa có; map `PreconditionRequired` thành 400, `TooLarge` 413, `UnsupportedMedia` 415 ở middleware.
  - `WriteAuthorityDependencies` nhận observer; P0 cung cấp hằng no-op non-throwing ở Core để mọi CLI/test call site vẫn compile. Đây là wiring **tạm thời có tên**, không được còn ở production sau task 3.1d.
  - Nối journal/pending-transition port mới ở `packages/cli/src/composition-root.ts`; `packages/cli/src/startup.ts` chạy reconcile đúng thứ tự trước khi nhận request.
  - _Requirements: R3, R5, R9, R11_ — _Design: §4.5, §7, §8.1_
- [x] 0.10a Unit test contract thuần cho P0
  - Unit: union receipt/content refs + ownership/release; 1.024 file nhỏ/receipt không vượt 256 KiB
    inline và 50 receipt không vượt 12,5 MiB inline; `mkdir`/`rmdir` precondition, order, race cả
    hai chiều; mkdir absent-vs-either, file/symlink collision và directory read guard; guard
    `write-staged` create-vs-replace/undoable/opaque source; error mapping.
  - _Requirements: R3.1, R3.5, R5.1–5.3, R11.3b_ — _Design: §5.5, §5.11, §8.1, §11.1_
- [x] 0.10b Integration test persistence/wiring cho P0
  - Integration (SQLite **file thật** + fs tạm thật): resolve receipt `beforeContent/afterContent` ra
    đúng bytes/hash sau `discardCaptures`; emit ném/reject ⇒ mutation vẫn `ok` + warning
    `history-unavailable` + invalidate + không leak ref; migration/boot idempotent; composition root
    resolve journal/pending/content port và observer seam.
  - _Requirements: R3.1, R3.5, R11.3b_ — _Design: §5.5, §6.5, §11.2_
- [x] 0.10c Integration test staged write, watcher và invalidator cho P0
  - `write-staged`: source symlink/non-regular/source đổi lúc copy/target race bị từ chối; giả lập EXDEV vẫn publish no-overwrite; post-publish + cleanup + watcher hash không gọi `readFile` và RSS giữ dưới gate P5.
  - Watcher thật: own write/delete/mkdir/rmdir mỗi loại bị suppress đúng một lần; external file,
    directory và delete phát event + gọi `ProjectPathInvalidator` và `observeExternalChange` đúng path;
    không retry directory. External rename/delete thư mục cha phải barrier receipt guard file con;
    path chung prefix nhưng khác segment (`assets/a`, `assets/ab`) không được conflict.
  - Watcher filename absolute/traversal/NUL/symlink escape bị bỏ an toàn: không đọc ngoài project,
    không event, không cache invalidation và không history barrier.
  - Một invalidator consumer ném: mutation vẫn ok, ProjectCache + consumer sau vẫn được gọi, watcher
    tiếp tục nhận event; có diagnostic nhưng không duplicate event/write.
  - _Requirements: R3.1, R3.5, R5.1–5.3_ — _Design: §5.5, §5.11, §11.2_
- [x] 0.10d Integration test memory/ref lifecycle cho P0
  - Payload staged/object 250 MiB và 50 receipt refs không làm heap tăng theo tổng bytes; evict/clear/
    duplicate recovery release đúng ref, startup cleanup không xoá object journal/live-history còn dùng.
  - _Requirements: R3.1, R3.5, R5.1–5.3, R11.3b_ — _Design: §5.5, §6.5, §11.2_
- [x] 0.10e Recovery/failure-injection test cho P0
  - Failure injection ở từng ranh `capture → publish → commit → discard`; kill sau publish/trước commit ⇒ reconcile phát receipt cùng id và để record `uploaded_unmounted` đúng lý do, không ghi/rollback hai lần.
  - Ép watcher observe trước settlement và sau commit/rollback: nó chờ tracker, suppress đúng
    terminal state; settlement không xác định hoặc hash/state lệch phải phát external, không nuốt.
  - _Requirements: R3.1, R3.5, R5.1–5.3, R11.3b_ — _Design: §5.5, §5.11, §6.5, §11.2_

**Acceptance Criteria**:
- [x] Toàn bộ suite hiện có vẫn xanh (`bun run test`) — P0 là thay đổi contract, hồi quy là rủi ro chính
- [x] Một mutation composite ba file sinh **một** receipt với ba step
- [x] Receipt phát ở cả nhánh commit thường và nhánh reconciled-committed
- [x] Không có bảng nào ngoài `pending_mount` được tạo; lịch sử undo **không** chạm SQLite (L7)
- [x] Artifact staging fixture/manifest verifier tìm thấy migration mới và startup production test
  reconcile được journal/pending transition; SEA binary thật được đóng ở P11, không chặn P0 vì thiếu runtime input ngoài spec
- [x] Own write/delete/mkdir/rmdir không bị watcher gắn nhãn external; file/directory đổi thật bên ngoài vẫn invalidates đúng path
- [x] Watcher chỉ phát canonical contained `RelPath`; filename không hợp lệ không được chạm filesystem ngoài project hay history
- [x] Receipt undoable lớn giữ content bằng leased object ref, không giữ toàn payload trong heap và không tạo persistence cho stack

**Deliverables Created / Modified**:
- Core/contract: `packages/core/src/{port/mutation-observer.ts,service/write-authority.ts,service/composite-recovery.ts,usecase/reconcile-composite-mutation.ts,service/project-path-invalidator.ts}`, `packages/contracts/src/{editing.ts,errors.ts,index.ts}`.
- Adapter/persistence/runtime: `packages/adapter/src/{fs,db,runtime}/**`, migrations `20260817153223_small_power_pack` + `20260817162114_solid_daredevil`, production wiring `packages/cli/src/{composition-root.ts,startup.ts}` và server/MCP error/route call sites.
- Verification: P0 suites trong `tests/{core,adapter,contracts,server,cli,mcp}/**`, artifact runtime contract, golden MCP fixtures; local full gate 225 files/2.135 tests PASS và focused P0 gates ghi trong Execution Log.
- Exact-source CI evidence: run `32077416522` tại `6c220acdc1089d3e5b6c3b221149a50cc417d8ed`; 8/8 jobs PASS. Ba artifact `packaged-smoke-{linux-x64,darwin-arm64,win32-x64}` đã tải về `/tmp/vidcom-p0-ci-32077416522.k4UYG1`; mỗi smoke JSON strict có 13/13 required steps PASS, không `evidenceError`, manifest `dirty:false` và commit đúng SHA.

---

## Phase 1: Kéo timing trên timeline (R1)

**Addresses**: R1.1–1.13
**Design reference**: §5.1, §5.2
**Files affected**: `src/lib/studio/{editor-interaction.ts,snap.ts}`, `src/components/studio/timeline*.tsx`
**Prerequisite**: P0 + P3 (`paths` và helper session-aware cho browser mutation)
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: `src/components/studio/timeline-track.tsx`, `packages/core/src/usecase/project-writes.ts` (search `setSceneTiming`)

**Tasks**:
- [x] 1.1 `snap.ts`: `snapToleranceSeconds` (8 px quy đổi theo zoom, kẹp `[1 khung, 0.5 s]`), `snapTime`, `roundToFrame`, `hitZone` (mép 8 px mỗi bên, **không quá 40 %** chiều rộng clip)
  - _Requirements: R1.6, R1.6b, R1.7, R1.13_ — _Design: §5.2_
- [x] 1.2 `editor-interaction.ts`: reducer thuần cho phiên kéo — `beginDrag`/`moveDrag`/`commitDrag`, `Esc` huỷ, hiển thị mốc snap và số scene ripple
  - `commitDrag` trả `null` khi không đổi gì ⇒ **không** gửi request
  - _Requirements: R1.1–1.5, R1.8_ — _Design: §5.1_
- [x] 1.3 Nối timeline vào route 7.1 — một request khi thả, kèm `expectedContentHash`
  - 409 hash lệch ⇒ giữ nguyên hiển thị, hiện "nguồn đã đổi" + hành động tải lại
  - 422 vượt root ⇒ hiện lựa chọn `extendRoot`; 422 vượt `MAX_PROJECT_DURATION_SECONDS` ⇒ từ chối, không có lựa chọn nới
  - _Requirements: R1.4, R1.9–1.11_ — _Design: §7.1, §8.1_
- [x] 1.4 Giữ form timing hiện có hoạt động song song
  - _Requirements: R1.12_ — _Design: §5.1, §7.1_
- [x] 1.5 Unit test (node) cho `snap` và reducer; browser test kéo thân/kéo mép/Esc
  - Ca biên bắt buộc: clip **20 px** (hit-zone còn thân để kéo), hai cận zoom
  - _Requirements: R1.1–1.13_ — _Design: §9.1, §11_

**Acceptance Criteria**:
- [x] Kéo phát **đúng một** request ghi (đếm lời gọi trong test)
- [x] Không ghi gì trong lúc kéo và khi thả về đúng chỗ cũ

**Deliverables Created / Modified**:
- Pure interaction: `src/lib/studio/{snap.ts,editor-interaction.ts,scene-timing-mutation.ts,file-version-cache.ts}`.
- UI/snapshot path: `src/components/studio/{timeline.tsx,timeline-track.tsx,timeline-toolbar.tsx,scene-pane.tsx,player-time.tsx,preview-panel.tsx,studio-shell.tsx}`, `src/app/projects/[slug]/composer-client.tsx`, `packages/{contracts/src/dto.ts,core/src/usecase/project-reads.ts}`.
- Verification: `tests/frontend/{snap.test.ts,editor-interaction.test.ts,scene-timing-mutation.test.ts,file-version-cache.test.ts,browser-session.test.ts}`, server/API contract fixtures; local full gate 242 files/2.219 tests PASS plus required Browser session 12/12. Exact-source CI run `32091740200` PASS Linux x64 + Windows x64 at `43db9b1d45fdf163087597935b9db951422e1f0f`.

---

## Phase 2: Thứ tự scene + thao tác nhóm (R2, R12)

**Addresses**: R2.1–2.12, R12.1–12.8
**Design reference**: §5.3, §5.4, §7.2, §7.2b, §7.3, §7.4a/b
**Files affected**: `packages/core/src/domain/plan-scene-order.ts`, `packages/core/src/usecase/{project-writes,reorder-scenes,move-scenes,delete-scenes,compact-track}.ts`, `packages/server/src/routes/project-writes.ts`, `src/lib/studio/editor-interaction.ts`, `src/components/studio/scene-storyboard.tsx`
**Prerequisite**: P0 + P3 (cần history để chứng minh đúng một mục undo)
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: `src/lib/studio/scene-order.ts` (FULL), `packages/core/src/domain/invariants.ts` (FULL), `packages/core/src/usecase/project-writes.ts` (FULL `createScene`), `packages/core/src/usecase/scene-deletion.ts` (search `prepareSceneDeletion`)

**Tasks**:
- [x] 2.1 `plan-scene-order.ts`: `planReorder` (giữ gap), `planCompact`, `planGroupShift` (all-or-nothing), `planSceneInsertion`
  - `toIndex` = vị trí **trong nhóm, trong track** — không phải chỉ số toàn timeline
  - Nhóm content ↔ transition/overlay phân loại ở **Core** bằng `groupOf`, không ở UI
  - Tách insertion/shift/root-duration logic từ `createScene`; `createScene`, catalog new-scene và
    mount asset dùng chung planner rồi tự ghép đúng một composite, không gọi use case commit lồng nhau.
  - _Requirements: R2.2, R2.3, R2.7, R7.3, R11.1, R12.4_ — _Design: §5.3_
- [x] 2.2 Use case `reorderScenes`, `compactTrack` (route riêng, **không** phải cờ), `moveScenes`, `deleteScenes`
  - `deleteScenes` dùng `prepare → grant → execute` và `backup: true`; execute nhận lại
    `{sceneIds,expectedRevision,grantId}`, re-plan + reserve như `deleteScene` hiện có; xoá cả file scene + sidecar
  - `sceneIds` bắt buộc non-empty/unique; duplicate ⇒ `DuplicateMutationTarget`, zero plan/write.
  - _Requirements: R2.4, R2.3, R12.4, R12.5_ — _Design: §5.4, §7.4a/b_
- [x] 2.3 Route 7.2, 7.2b, 7.3, 7.4a, 7.4b
  - _Requirements: R2, R12_ — _Design: §7_
- [x] 2.4 UI: kéo-thả storyboard + timeline; vùng chọn (`Shift` cùng track, `Shift` khác track ⇒ anchor mới, `Cmd/Ctrl` thêm-bớt, marquee); kéo nhóm với **anchor snap** và **ripple tắt**
  - `Alt`/`Option` + mũi tên dịch scene; giữ focus + thông báo trợ năng sau khi sắp lại
  - `Esc` bỏ chọn; hiện số clip đang chọn
  - _Requirements: R2.1, R2.8–2.12, R12.1–12.3, R12.4b–4e, R12.7_ — _Design: §5.1_
- [x] 2.5a Unit/integration: planner gap, ranh giới nhóm, all-or-nothing; đếm **một** mutation và **một** mục undo cho xoá nhóm
  - _Requirements: R2, R12_ — _Design: §5.3, §5.4, §11, §17_
- [/] 2.5b Browser: storyboard/timeline kéo-thả, vùng chọn, kéo nhóm, xoá nhóm và bàn phím/focus/announcement
  - _Requirements: R2, R12_ — _Design: §5.1, §5.4, §11, §17_

**Acceptance Criteria**:
- [x] Thứ tự sau khi thả trùng thứ tự cũ ⇒ không ghi
- [x] Storyboard và timeline đánh số từ **cùng** `splitScenes`
- [x] Chồng lấn trong track là **diagnostic**, không phải lỗi chặn

**Deliverables Created / Modified**: `packages/core/src/domain/plan-scene-order.ts`,
`packages/core/src/usecase/{scene-order-write,reorder-scenes,compact-track,move-scenes,delete-scenes}.ts`,
`packages/core/src/{index.ts,usecase/project-writes.ts}`,
`tests/core/{plan-scene-order,scene-order-usecases,scene-deletion}.test.ts`,
`tests/adapter/project-destructive-usecases.test.ts`, `packages/contracts/src/editing.ts`,
`packages/server/src/routes/project-writes.ts`, `packages/cli/src/next-host.ts`,
`tests/{contracts/api-contracts,server/scene-order-routes}.test.ts`
(2.1–2.3), `src/lib/studio/{editor-interaction,scene-order,scene-order-mutation}.ts`,
`src/components/studio/{editor-interaction-context,scene-card,scene-storyboard,timeline,timeline-track,timeline-toolbar}.tsx`,
`tests/frontend/{editor-interaction,scene-order,scene-order-mutation}.test.ts`
(UI node evidence ở 2.4; browser evidence bổ sung ở 2.5b)

---

## Phase 3: Undo/redo (R3)

**Addresses**: R3.1–3.9
**Design reference**: §5.6, §5.7, §7.5, §7.6
**Files affected**: `packages/server/src/service/mutation-history.ts`, `packages/core/src/usecase/apply-mutation-inverse.ts`, `packages/cli/src/{composition-root.ts,startup.ts,next-host.ts}`, `packages/server/src/{app.ts,routes/*}`, `src/lib/{api/services.ts,studio/ids.ts}`, `src/components/studio/*`
**Prerequisite**: P0
**Skill**: `.agents/skills/bun/SKILL.md` + `.agents/skills/hono/SKILL.md` — test, middleware, header
**Read first**: P0 deliverables; `createInfrastructure`/`createApplication` trong `packages/cli/src/composition-root.ts`; startup trước listener; `projectWrites` + `createServerApp` wiring trong `packages/cli/src/next-host.ts`; `packages/server/src/routes/project-writes.ts` (FULL)

**Tasks**:
- [x] 3.1a `MutationHistory` khoá `(studioSessionId, projectId)`, 50 mục và hiện thực reservation của `MutationObserverPort`
  - Public method khớp port Core chính xác: `claimHistoryOperation`/`abortHistoryOperation`/
    `blockHistoryOperation`/`emit`/`observeExternalChange` + `invalidateProject`; không tạo adapter khác tên. Push khi
    `historyAction === "record"` và undoable.
  - `begin(direction)` cấp reservation `{operationId,targetReceiptId}`; chỉ một pending/committing mỗi
    stack. Claim ngay trước publish; emit undo/redo atomically move receipt gốc rồi release receipt
    nghịch đảo. Cancel/rollback trả stack nguyên trạng; clear/dispose defer nếu đã committing.
    Claim recheck target còn top + attachment + barrier **đúng direction**; redo-only barrier không
    huỷ undo reservation an toàn và ngược lại.
  - Inverse receipt đã claim không tự barrier target/entry cũ của stack sở hữu; nó vẫn barrier session
    khác. Record mới cùng stack dùng LIFO/branch-cut, không tự block entry cũ.
  - _Requirements: R3.1, R3.5, R3.9_ — _Design: §5.6_
- [x] 3.1b Barrier ownership/dependency có hướng cho history
  - Receipt không được push vào stack (khác phiên/nguồn, `ignore`, hoặc `record` non-undoable kể cả
    cùng phiên) dùng hai primitive segment-safe: `ownedOverlap(A,B)` đối xứng equal/ancestor và
    `invalidates(changed,guards)` có hướng, chỉ true khi changed path bằng/là ancestor của guard path.
    `undoBlocked = ownedOverlap(old.paths,incoming.paths) || invalidates(old.paths,incoming.readGuards)`;
    `redoBlocked = ownedOverlap(old.paths,incoming.paths) || invalidates(incoming.paths,old.readGuards)`.
    Child/sibling đổi dưới directory-existence guard không block sai; dependency edit không block undo
    mount chỉ-đọc nhưng block redo.
  - `observeExternalChange(projectId,paths)` không push entry: block undo bằng ownership overlap;
    block redo thêm `invalidates(external.paths,old.readGuards)`, không giả external event có read guard.
    Áp lên mọi stack live với reason `source-changed-externally`. Chỉ watcher gọi sau own-write
    suppression; không suy lại từ SSE và không cho `WriteAuthority` gọi đường này.
  - Barrier gắn từng entry ở cả undo/redo stack; chỉ top bị đánh dấu mới block hướng đó. State trả
    `undoBlocked/redoBlocked` + reason riêng; entry sạch phía trên vẫn áp được, không xoá/nhảy entry sâu.
  - Step/read-guard precondition lệch trước publish ⇒ `WriteAuthority.blockHistoryOperation` settle
    reservation và mark đúng target/direction `source-changed-externally`; route cancel sau đó no-op.
    Không chờ watcher debounce mới disable nút.
  - _Requirements: R3.5–R3.5b_ — _Design: §5.6, §5.7_
- [x] 3.1c Attachment lifecycle, invalidation và ownership của content refs
  - Receipt UI chỉ push khi studio ID đang attach đúng auth session/project. Startup recovery với
    session cũ chưa attach không được dựng lại stack; release refs và chỉ barrier stack live giao path.
  - `invalidateProject` non-throwing; emit lỗi sau commit phải settle/hủy reservation, block project
    và release refs sau operation committing, không để `busy`/lease treo.
  - `attach/detach` bind studio ID với browser auth session + project; detach explicit clear sau
    operation committing. SSE attachment đếm lease; chỉ stream cuối disconnect mới đặt grace 30 s,
    reconnect cancel timer. Explicit DELETE revoke generation; SSE reconnect không resurrect, chỉ
    POST attach lại được với stack rỗng. Live attachment không TTL.
  - Nhận `UndoContentPort`; ignore/non-undoable/id trùng/redo branch-cut/mục 51/clear/dispose release
    refs đúng một lần. Stack chỉ giữ metadata + refs trong memory, không persist/reconstruct từ objects.
  - _Requirements: R3.1, R3.5, R3.9_ — _Design: §5.6_
- [x] 3.1d Production lifecycle/wiring cho đúng **một** `MutationHistory` mỗi daemon/workspace foundation
  - `createInfrastructure` dựng singleton trước `createApplication` và trước startup reconcile; `WriteAuthority` nhận chính object đó làm observer.
  - `WorkspaceWatcher` nhận chính observer singleton đó; external event gọi `observeExternalChange`,
    còn own-write echo đã suppress không được chạm history. Không dựng observer phụ chỉ cho watcher.
  - `next-host.ts` truyền **cùng object identity** vào `/undo`, `/redo`, `/history`; không `new MutationHistory()` trong route/app factory, không import Server từ Core.
  - Workspace switch/dispose bỏ history cũ; CLI/MCP headless vẫn dựng observer để receipt recovery/invalidations an toàn. Xoá no-op production wiring của P0.
  - _Requirements: R3.1, R3.5, R3.8_ — _Design: §4.5, §5.5, §5.6_
- [x] 3.2 `applyMutationInverse` ở Core
  - Undo resolve `beforeContent`, redo resolve `afterContent`; object ref đi internal `write-staged`
    theo stream, inline đi `write`; step thư mục đảo phép **và đảo thứ tự**, precondition **theo hướng** (bảng §5.7)
  - Kiểm hash từng path **trước khi ghi gì**; lệch ⇒ `WriteConflict` + `details.blockedBy`
  - Entry có step `delete` ⇒ `backup: true`
  - Step `pending-mount`: undo close ⇒ reopen cùng composite và restore failure; redo ⇒ close theo
    scene/revision mới. Không được để row mounted trỏ scene đã bị undo.
  - Entity step undoable đảo toàn before/after state với revision/hash precondition; standalone
    preview-settings vẫn false. Delete scene có cleanup settings phải còn đúng một mục undo.
  - _Requirements: R3.2–3.5, R3.5b_ — _Design: §5.7_
- [x] 3.3 Route 7.5 (`/undo`, `/redo`) và 7.6 (`/history`) — **bắt buộc** header `x-vidcom-studio-session`, thiếu ⇒ 400
  - `/history` trả `{canUndo,canRedo,busy,depth,nextUndoLabel,nextRedoLabel,undoBlocked,redoBlocked,
    undoBlockedReason,redoBlockedReason}`; mỗi hướng lấy barrier đúng top entry.
  - Undo/redo dùng `begin` rồi truyền operation vào `MutationOrigin`; không có `peek → await apply →
    commit` ở route. Nhánh không commit luôn `cancel` trong `finally`; operation đồng thời trả 409.
  - Route 7.6b POST attach/DELETE detach; mọi browser mutation/history kiểm ID đã attach đúng auth
    session/project. SSE dùng cùng ID, disconnect schedule grace; unknown/cross-project ID ⇒ 400 zero write.
  - Mọi route ghi từ browser (không riêng history) validate cùng header và dựng `origin.kind="ui"`; nhãn do route/use case định nghĩa, payload không điều khiển origin/history.
  - Xoá bridge `UNTRACKED_UI_ORIGIN` của P0; test/`rg` chứng minh production server không còn
    `historyAction:"ignore"` cho browser write và không có đường browser mutation bỏ qua helper header.
  - _Requirements: R3.7, R3.8_ — _Design: §7.5, §7.6_
- [x] 3.4 UI: nút undo/redo hiện nhãn thao tác; khi top của hướng đó bị block hiện lý do + hai lối
  thoát (tải lại nguồn / giữ nguyên); nói rõ lịch sử theo **phiên**
  - `src/lib/studio/ids.ts` sinh ULID chuẩn Crockford từ Web Crypto + timestamp, không thêm runtime dependency; cùng helper dùng lại cho pending-mount `operationId`. `packages/contracts/src/editing.ts` là validator ULID duy nhất.
  - Sinh `studioSessionId` một lần cho mỗi composer/project mount bằng `useRef`; gửi header trong **mọi** browser mutation; không persist vào storage, reload tạo id mới.
  - Await attach trước khi enable write/SSE; unmount/pagehide gọi detach best-effort. Reconnect SSE trong
    cùng page tái dùng ID nên không mất stack trong grace.
  - _Requirements: R3.5b, R3.7, R3.8_ — _Design: §5.6, §7.5, §7.6_
- [x] 3.5 **Không** phát hành tool MCP undo/redo
  - _Requirements: Deferred D7_ — _Design: Decision 12_
- [x] 3.6a Unit/integration: stack 50 mục/cắt redo; undo file tạo/thay thế + backup; receipt recovery trùng id; path giao/không giao giữa hai phiên
  - Thiếu/sai header ⇒ 400 và không ghi; ULID fixed-vector/invalid alphabet/clock+random seam;
    production test chứng minh observer và route history cùng object/hành vi. Startup recovery trước
    attach **không** tái tạo stack cũ; recovery cùng daemon với attachment live vẫn hoàn tất đúng stack.
  - Ref-count test cho ignore/id trùng/branch-cut/eviction/clear; redo package staged lớn sau catalog
    cache eviction vẫn đúng bytes và RSS không tăng theo payload.
  - Race barrier: hai undo đồng thời; mutation cùng phiên/khác phiên chen trước claim; clear/dispose
    khi pending và khi committing; failure trước publish, rollback, reconcile-committed. Project và
    stack phải cùng kết quả, inverse refs release đúng một lần, không có cửa sổ commit-stack ở route.
    Incoming chỉ bật barrier hướng đối diện không làm claim hiện tại fail.
  - _Requirements: R3_ — _Design: §5.6, §5.7, §11, §17_
- [x] 3.6b Unit/integration: synchronous block, directional barrier và failure sau commit
  - Precondition lệch trước watcher event phải gọi block operation đúng một lần, `busy=false`, top
    giữ nguyên nhưng direction bị block và UI có đúng hai escape paths; retry không lặp 409 với nút bật.
  - Ép `emit` fail sau commit: mutation vẫn thành công + warning, mọi stack project bị block,
    reservation/busy/ref-count về trạng thái ổn định.
  - _Requirements: R3_ — _Design: §5.6, §5.7, §11, §17_
- [x] 3.6c Unit/integration: directional barrier matrix và entry sâu
  - Delete scene có entity cleanup vẫn undo/redo cả source + preview settings trong một entry; thay
    preview settings độc lập không vào history nhưng block receipt cũ giao backing path; nonundoable
    same-session file mutation cũng là barrier. Test ownership-vs-guard có hướng: receipt catalog reuse
    mới block undo entry cũ sở hữu file shared; external edit dependency không block undo mount chỉ đọc
    nhưng block redo của nó; thêm sibling dưới directory guard không block, xoá/rename chính directory
    hoặc ancestor vẫn block.
  - Mark barrier ở entry thứ hai khi top còn sạch: undo top thành công, sau đó entry thứ hai mới block;
    phủ tương tự redo và reason riêng cho hai hướng, không clear/skip entry sâu.
  - Undo/redo một entry không tự đánh dấu barrier cho phần stack cùng session vừa được khôi phục, nhưng
    inverse receipt vẫn đánh dấu entry giao path của session khác.
  - _Requirements: R3_ — _Design: §5.6, §5.7, §11, §17_
- [x] 3.6d Browser: undo/redo labels và blocked escape paths; hai tab tách session; reload trang ⇒ lịch sử rỗng
  - Chứng minh reload/unmount release refs stack cũ sau detach/grace; transient SSE reconnect <30 s
    giữ stack; hai SSE stream overlap thì stream cũ đóng không clear stream mới; spoof ID từ auth
    session/project khác bị từ chối. Sau explicit detach + POST attach lại cùng ID, close event từ
    generation SSE cũ không được decrement/clear attachment mới.
  - _Requirements: R3_ — _Design: §5.6, §7.5, §7.6, §11, §17_

**Acceptance Criteria**:
- [x] Undo một mutation composite hoàn tác **mọi** file của nó, không hoàn tác một phần
- [x] Undo bị chặn ⇒ **không ghi gì** và stack giữ nguyên
- [x] Production không còn dùng no-op observer; một receipt phát trong `WriteAuthority` nhìn thấy ngay ở `/history` của đúng session
- [x] Production không còn `UNTRACKED_UI_ORIGIN`; mọi browser mutation thiếu/sai session header trả 400 trước khi ghi
- [x] Mục 51/clear/reload/duplicate receipt giải phóng content refs; reload không thể dựng lại stack từ object store

**Deliverables Created / Modified**:
- Core/history runtime: `packages/core/src/usecase/apply-mutation-inverse.ts`, `packages/server/src/service/mutation-history.ts`, `packages/server/src/routes/{history,studio-session,events}.ts`, `packages/cli/src/{composition-root,next-host}.ts`
- Browser contract/UI: `packages/contracts/src/editing.ts`, `src/lib/studio/{ids,studio-session,history-controls}.ts`, `src/app/projects/[slug]/composer-client.tsx`, `src/components/studio/{studio-session-context,use-mutation-history,timeline-toolbar}.tsx`
- Evidence: `tests/{core/apply-mutation-inverse,server/history-routes,server/mutation-history,server/mutation-history-barriers,server/mutation-history-lifecycle,frontend/history-controls,frontend/browser-session}.test.ts`; Browser session run `32085708059` at exact SHA `5cdc21a0ba18b37efdbcab56c3185e23beb9b44d` (Linux x64 + Windows x64 PASS; workflow publishes no artifacts)

---

## Phase 4: Preview `PlayerHost` + double-buffer (R4)

**Addresses**: R4.1–4.7
**Design reference**: §5.8, §5.9, Decision 6
**Files affected**: `src/components/studio/{player-host.tsx,preview-buffer.ts}`, `packages/adapter/src/hyperframes/{document.ts,preview-style.ts}`, `packages/core/src/usecase/project-reads.ts`, `packages/worker/src/render-job.ts`, `packages/server/src/routes/project-reads.ts`
**Prerequisite**: P0 + P3 (`paths` và cùng session/origin cho các mutation kích reload)
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: `src/components/studio/use-hyperframes-player.ts` (FULL), `packages/adapter/src/hyperframes/document.ts` (FULL), `spikes/phase-5/run-spike-5.mjs` (FULL — `waitHealthy` và `reload` là bản mẫu **đã đo**, port thẳng chứ đừng phát minh lại)

**Tasks**:
- [x] 4.1 Bắt buộc `DocumentOptions.mode: "preview" | "render"` tại mọi call site của document builder
  - Dùng discriminated union: `preview` bắt buộc `projectRevision + changeSeq`, `render` cấm hai field đó.
    `getProjectPreview` truyền preview+revision; preflight/worker/render/snapshot truyền render;
    compile/test chứng minh không còn default/global ngầm.
  - `buildHealthCollectorScript()` được preview builder tiêm **ngay sau `<head>`**, trước mọi script tác giả; **không** tái sử dụng `injectRuntimeAssetGuardDocument` vì guard đó thuộc render/snapshot path.
  - Ghi `window.__vidcomHealth = {scriptErrors, rejections, resourceErrors}`; listener `error` ở pha capture phân biệt lỗi tài nguyên với lỗi script
  - **Chỉ tiêm cho preview**, không cho render
  - _Requirements: R4.6_ — _Design: §5.9_
- [x] 4.2 Route preview trả `Cache-Control: no-store`
  - `getProjectPreview` đọc project revision + latest project outbox seq trước build, tiêm cả hai vào
    health collector và trả `X-Vidcom-Project-Revision` + `X-Vidcom-Change-Seq`; changeSeq từ collector
    là nguồn quyết định swap vì external watcher không tạo project revision. Project chưa có event dùng
    changeSeq 0; seq global của project khác không được lọt vào preview này.
  - _Requirements: R4.1b_ — _Design: §5.8_
- [x] 4.3a `preview-buffer.ts`: state machine/health/reload engine đệm thuần điều phối
  - Trình tự đúng: dựng đệm `opacity: 0` phía sau → chờ health (`ready && timeline && scenesLoaded && collectorSeen` + **cửa sổ im lặng 150 ms**, hết hạn **2.5 s**) → **lấy mẫu transport tại thời điểm này** → `seek(min(time, duration mới))` + khôi phục `rate`/`muted`/play → đổi hiển thị → gỡ engine cũ
  - Health không đạt ⇒ **gỡ đệm**, giữ engine đang chiếu, báo lỗi kèm `PreflightHealth`
  - Coordinator latest-wins: `desiredChangeSeq` tăng đơn điệu + generation token; coalesce HTTP/SSE
    trùng seq; tối đa một candidate; seq mới dispose candidate cũ. Mọi continuation sau
    `await` kiểm generation/project token nên completion/error cũ chỉ cleanup, không swap/ghi đè lỗi.
    Track `visibleChangeSeq`; swap candidate D>C advance cả visible/desired tới D, nên SSE D tới sau
    không reload lại tài liệu đang hiển thị.
  - _Requirements: R4.1, R4.1a, R4.1b, R4.2, R4.2c, R4.3_ — _Design: §5.9_
- [x] 4.3b `PlayerHost` giữ danh tính/transport và nối mọi reload vào state machine 4.3a
  - `requestReload({url,targetChangeSeq})`; candidate chỉ swap khi collector báo
    `changeSeq >= targetChangeSeq`; stale chỉ retry một lần/generation rồi báo `preview_stale`, giữ
    engine cũ. Không để lifecycle React theo `previewUrl` remount host; đổi
    project/unmount abort health wait và cleanup candidate + visible engine đúng một lần.
  - _Requirements: R4.1–R4.4_ — _Design: §5.8, §5.9_
- [x] 4.4 `previewUrl` bỏ `?r=`; mọi thay đổi (kể cả preview settings) đi qua buffer
  - Cùng URL sau mutation phải trả revision/nội dung mới và `Cache-Control: no-store`; không cache nội bộ theo URL cũ.
  - _Requirements: R4.5_ — _Design: §5.8, §5.9, Goals bản 7_
- [x] 4.5 Ghi từ ngoài qua SSE dùng **cùng** đường buffer
  - External file/preview-settings edit có project revision không đổi vẫn reload vì SSE seq tăng.
  - _Requirements: R4.7_ — _Design: §5.8, §5.9_
- [x] 4.6a Unit/integration document mode: preview collector đứng trước script tác giả; render **không** có collector; project chưa event = seq 0 và project khác không ảnh hưởng; cùng URL/no-store trả content/changeSeq mới
  - _Requirements: R4_ — _Design: §5.9, §11_ — _Evidence: S-P17…S-P20_
- [x] 4.6b Browser test theo bốn probe đã đo: transport đầy đủ (0 khung, rate, muted) · buffer thiếu scene bị từ chối · clamp khi ngắn hơn · collector bắt lỗi script + 404
  - Race test A/B/C liên tiếp: trì hoãn A để hoàn tất sau C, duplicate HTTP+SSE của B, và error A
    đến muộn; chỉ C được swap/hiện trạng thái, tối đa một candidate, không reload trùng. Thêm đổi
    project/unmount giữa health wait để chứng minh không late swap/leak engine.
  - Candidate target C nhưng collector trả D>C: swap D đúng một lần, SSE D đến sau coalesce.
  - _Requirements: R4_ — _Design: §5.9, §11_ — _Evidence: S-P17…S-P20_

**Acceptance Criteria**:
- [x] `PlayerHost.id` không đổi qua nhiều lần ghi liên tiếp
- [x] Tài liệu mới hỏng ⇒ khung cuối **vẫn hiển thị**, engine cũ không bị gỡ

**Deliverables Created / Modified**:
- Preview document/identity: `packages/adapter/src/hyperframes/document.ts`, `packages/core/src/port/ports.ts`, `packages/core/src/usecase/project-reads.ts`, `packages/server/src/routes/project-reads.ts`
- Stable host/buffer/UI wiring: `src/components/studio/{preview-buffer,player-host,hyperframes-player-environment,use-hyperframes-player,studio-shell}.ts{,x}`, `src/lib/studio/{preview-reload,studio-session}.ts`
- Evidence: `tests/adapter/composition-hf.test.ts`, `tests/core/project-usecases.test.ts`, `tests/server/project-routes.test.ts`, `tests/frontend/{preview-buffer,player-host,preview-buffer-browser}.test.ts`, `tests/frontend/fixtures/preview-buffer-browser-{harness,server}.ts`; Browser session run `32089458505` at exact implementation SHA `41db32660387a12720f631705baff8afb6b0e085` (Linux x64 + Windows x64 PASS; workflow publishes no artifacts)

---

## Phase 5: File, thư mục, asset, font (R5)

**Addresses**: R5.1–5.9 (gồm 4b–4g, 6b–6d)
**Design reference**: §5.10, §5.11, §5.12, §7.7–7.10
**Files affected**: `llm-documents/steering/04-api-design.md`, `packages/core/src/port/ports.ts`, `packages/core/src/usecase/{ingest-asset,create-entry,rename-entry,delete-entry,apply-font}.ts`, `packages/core/src/domain/{magic-bytes,asset-names}.ts`, `packages/adapter/src/{fs/asset-staging.ts,media/probe.ts,hyperframes/{svg-sanitizer,safe-css}.ts}`, `packages/adapter/package.json`, `packages/server/src/{app.ts,routes/*}`, `packages/cli/src/{composition-root.ts,startup.ts}`, `src/components/studio/file-explorer.tsx`
**Prerequisite**: P0 + P3 (`write-staged`, `mkdir`/`rmdir` và helper session-aware cho XHR/browser mutation)
**Skill**: `.agents/skills/bun/SKILL.md` + `.agents/skills/hono/SKILL.md` — test và nhận body dạng stream
**Read first**: `packages/server/src/app.ts` + `packages/server/src/routes/project-writes.ts` (body limit và route `assets/bgm`; **không** nhầm với `packages/core/src/usecase/project-writes.ts`), `packages/core/src/usecase/file-deletion.ts`, `packages/adapter/src/runtime/node-process-runner.ts`, `packages/adapter/src/hyperframes/{dom.ts,font-compatibility.ts}`, `packages/cli/src/composition-root.ts` (search `ffprobePath`)

**Tasks**:
- [ ] 5.0 Đồng bộ steering 04 §4 trước khi viết upload route: upload có thể là multipart **hoặc** raw
  binary stream khi contract yêu cầu progress/cancel và payload lớn; vẫn bắt buộc schema metadata,
  auth, body limit theo bytes thật và backpressure. Ghi rõ route R5 dùng
  `application/octet-stream`/raw `File`, không biến ngoại lệ thành body không giới hạn.
  - _Requirements: R5.4–5.5b_ — _Design: §5.10, §7.7 · Steering reconciliation_
- [ ] 5.1 Core domain `detectAssetKind`/`matchesDeclaredKind`/`sanitizeFilename`/`resolveCollision` + Adapter `SvgSanitizerPort`
  - Bảng giới hạn: ảnh 25 MB · video 500 MB · audio 100 MB · font 5 MB; allowlist đuôi theo Goals R5
  - Adapter tái dùng `linkedom` hiện có qua `hyperframes/dom.ts`; Core chỉ phụ thuộc port, không import
    Adapter/DOM package. Port nhận opaque `StagedFileSource`, không source path/raw client string. SVG
    dùng DOM transform strict, không regex: reject DOCTYPE/entity; bỏ active/embed element + `on*`;
    URL attr/CSS chỉ cho fragment `#id`. `<style>`/`style` dùng PostCSS + tokenizer value chung
    **`packages/adapter/src/hyperframes/safe-css.ts`** (file mới của task này), bỏ `@import`/unsafe URL, không regex. Khai `postcss` direct đúng version transitive
    đang resolve trong lock là **8.5.25** (upstream range `^8.5.8`), không thêm package tarball mới;
    output parse lại được và sanitize lần hai byte-identical.
  - _Requirements: R5.4, R5.4b–4e, R5.8_ — _Design: §5.12_
- [ ] 5.2a `AssetStagingPort` + adapter staging theo luồng
  - `open(ref,{filename,maxBytes})`; Core cộng dồn, adapter đếm/hash để staging không vô hạn.
    `finalize` raw cho `requestContentHash`; non-SVG publish source này. SVG sanitizer adapter nhận
    opaque staged source (≤25 MB, UTF-8 strict), trả clean string; Core mở writer thứ hai cho output,
    finalize lấy `assetContentHash`, discard raw. `discard()` idempotent sau finalize tới settle;
    mọi nhánh finally dọn source không publish. Raw SVG không được move.
  - `discard()` trong `finally`; `.vidcom/tmp/` quét khi khởi động, xoá mục quá 24 giờ
  - _Requirements: R5.4–5.5b_ — _Design: §5.10_
- [ ] 5.2b `ingestAsset` + upload fingerprint/replay/pending-mount open
  - Probe **sau** move, best-effort — thất bại ⇒ metadata `unknown`, upload vẫn 201
  - `pendingMount?` chỉ có ở bước 1 của thao tác thả
  - Parent `assets/` thiếu ⇒ thêm `mkdir either` trong cùng composite trước `write-staged`; staged
    adapter không tự mkdir. Upload non-undoable giữ directory đã tạo.
  - Tính `uploadFingerprint = sha256(canonicalJson({kind,filenameNfc,atSeconds,
    trackIndex,requestContentHash}))` từ body gốc; `assetContentHash` lấy từ bytes cuối sau sanitize.
    Hai SVG raw khác nhau nhưng output sạch giống nhau vẫn là payload khác. Exact POST replay cùng operation/fingerprint discard temp + trả kết quả
    cũ, không move/revision; fingerprint khác ⇒ 409. Nếu row đã retention xoá nhưng journal từng thấy
    operation ⇒ 404 trước mutation; không tái dùng id cũ.
  - _Requirements: R5.4–5.7_ — _Design: §5.10_
- [ ] 5.2c Media/font probe adapters + production composition-root/startup wiring
  - Media adapter dùng `ProcessPort`/`NodeProcessRunner` với `binaries.ffprobePath` đã resolve trong composition root, không gọi binary qua ambient PATH; font adapter dùng dependency `fontkit` đã có, không thêm parser/runtime package.
  - Composition root nối hai adapter; startup dọn staging >24 h trước khi serve, lỗi cleanup là diagnostic có cấu trúc chứ không chặn boot.
  - _Requirements: R5.6–5.8_ — _Design: §5.10_
- [ ] 5.3 CRUD file/thư mục ở Core: `createEntry`, `renameEntry`, `deleteEntry`
  - Cây con nở thành **một** composite (`write-staged`/`delete` + `mkdir`/`rmdir`); xoá dùng `prepare → grant → execute`
  - Execute delete lặp `{path,expectedRevision,grantId}`, re-enumerate/re-hash/re-plan rồi reserve;
    không giữ plan/capability trong RAM giữa hai request.
  - Rename/move không `readFile` cả cây: `WorkspacePort.openStagedSource(ref,path,expectedHash)` tạo
    capability nội bộ no-follow/regular-file; plan là mkdir target → `write-staged` non-undoable cho
    từng file (concurrency tối đa 8) → delete/rmdir source. Source chỉ xoá sau khi mọi target publish;
    client không truyền `sourcePath`. Delete/backup/capture file lớn cũng đi object/file stream.
  - Create folder và target dirs của rename dùng `mkdir absent`, không merge vào directory xuất hiện
    do race. Rename file nhận expected hash; rename folder nhận `expectedTreeDigest` từ GET tree,
    canonical theo ordered path/kind/hash. Re-enumerate no-follow; reject same/ancestor/descendant,
    symlink/special file. Race sau digest check bị step/rmdir precondition dưới mutex bắt zero-write.
  - _Requirements: R5.1–5.3_ — _Design: §5.11_
- [ ] 5.4 `applyFont` — use case **tự đọc** family/style từ file font, **không** nhận từ client; font vào bộ chọn; preview và render dùng file trong project
  - Không đọc được ⇒ giữ file, không hiện trong bộ chọn, nêu lý do
  - Font name/style NFC ≤256 code point, reject control, serialize bằng `escapeCssString`; font RelPath
    percent-encode từng segment. Không nối raw font metadata/path vào CSS/HTML.
  - Thêm `{path:fontPath,state:file(fontContentHash)}` vào `historyReadGuards`: external delete không block undo gỡ
    style nhưng block redo; redo recheck hash dưới mutex kể cả watcher chưa hết debounce.
  - _Requirements: R5.6b–6d_ — _Design: §5.11_
- [ ] 5.5 Route 7.7 (stream + metadata qua query), 7.8a–7.8d, 7.9, 7.10
  - Trong dispatcher `bodyLimit` của `packages/server/src/app.ts`, bypass **chỉ** đúng method/path
    `POST /api/v1/projects/:id/assets`, sau request-id/logger/Host/CORS/session auth; không nới/bỏ limit
    cho route khác. Không thay bằng Hono `bodyLimit` 500 MB: khi thiếu `Content-Length` hoặc dùng
    `Transfer-Encoding`, implementation hiện cài gom mọi chunk trước `next()`. Giới hạn theo kind do
    Core + staging adapter cùng đếm. Không gọi `arrayBuffer()`/`text()` cho binary body; truyền
    `ReadableStream` với backpressure và `c.req.raw.signal`.
  - Request/response import từ `packages/contracts/src/editing.ts`; validate metadata all-or-none trước khi đọc body.
  - _Requirements: R5_ — _Design: §7_
- [ ] 5.6 UI: cây file có tạo/đổi tên/xoá; dropzone upload có tiến độ byte + huỷ; hiện metadata hoặc `unknown` kèm lý do
  - Listener hiện là HTTP/1.1 nên **không** dùng browser `fetch` + request `ReadableStream`/`duplex:"half"` (Chromium từ chối trên HTTP/1.x). Dùng `XMLHttpRequest.send(file)` với raw `File`, không multipart/không `arrayBuffer`; `upload.onprogress.loaded / file.size` cho 0–90 %, 90–100 % chờ finalize/probe/response. `xhr.abort()` phải đóng request, kích `c.req.raw.signal`, dừng staging và dọn temp.
  - Đặt `Content-Type: application/octet-stream`; server không tin media type này để phân loại mà
    vẫn dùng kind đã validate + magic bytes/sanitizer. Không để browser tự đổi thành multipart.
  - XHR gửi cùng cookie/session và `x-vidcom-studio-session` như mọi browser mutation; dùng helper session-aware chung từ P3, không mở client API thứ hai thiếu auth/precondition.
  - _Requirements: R5.5, R5.5b, R5.6, R5.7, R5.9_ — _Design: §5.10, §7.7_
- [ ] 5.7a Unit/HTTP contract: magic byte, SVG sanitize, tên/collision; containment (`../`, symlink, absolute) trên **mọi** route file mới; body limit route khác vẫn 1 MiB
  - SVG cases: script/foreignObject/event attr, href/xlink/style `url()` mọi scheme, DOCTYPE/entity,
    malformed, fragment local, idempotence. Font metadata cases: quote/backslash/newline/`}`/`url()`;
    CSS parse lại chỉ có đúng một font-face + một local URL.
  - SVG raw khác nhau nhưng sanitize cùng output phải có request fingerprint khác; asset hash giống.
  - _Requirements: R5_ — _Design: §5.10–§5.12, §7, §11_
- [ ] 5.7b Streaming integration: đúng **500 MB** được nhận, 500 MB + 1 byte và 512 MB bị 413 sớm; RSS đỉnh <64 MB; huỷ giữa chừng ⇒ `.vidcom/tmp` sạch; không gọi `arrayBuffer`
  - Dùng SQLite file thật + temp fs thật; kiểm startup cleanup và AbortSignal/backpressure. Phủ cả
    request có `Content-Length` và client chunked/no-content-length để chứng minh Hono body-limit không
    buffer route upload; route JSON/file/BGM hiện hữu vẫn giữ limit cũ. Browser/listener test phải đi
    qua `bindLoopback` HTTP/1.1 thật và XHR path, không chỉ `app.request()`.
  - Replay cùng operation với bytes/metadata giống ⇒ không ghi lần hai; đổi một trong filename/kind/
    at/track/bytes ⇒ 409 sau khi dọn temp. Row đã xoá do retention nhưng journal còn dấu ⇒ 404 và zero write.
  - _Requirements: R5.4–5.5b_ — _Design: §5.10, §9.1, §11.2_
- [ ] 5.7c Filesystem/font integration: đổi tên cây 200 file ⇒ một revision; ép lỗi file 100 ⇒ rollback; font probe/apply thật; composition-root wiring
  - Dùng SQLite file thật + temp fs thật, không mock `node:fs`; cây có asset lớn và test RSS chứng
    minh rename/delete/rollback không giữ tổng bytes trong heap, target/source không cùng tồn tại dở dang sau settle.
  - Tree digest stale, target xuất hiện giữa plan/mutex, rename vào descendant, symlink/special entry
    đều zero-write; `mkdir absent` không merge cây, `either` chỉ reuse directory thật.
  - _Requirements: R5_ — _Design: §9.1, §11.2, §17_

**Acceptance Criteria**:
- [ ] Không lúc nào tồn tại file dở dang ở vị trí đích
- [ ] Font hỏng ⇒ upload vẫn 201; chỉ `applyFont` mới 422

**Deliverables Created / Modified**: (điền port/adapter/route/UI, migration nếu có và memory evidence khi thực thi)

---

## Phase 6: Caption (R6)

**Addresses**: R6.1–6.14
**Design reference**: §5.13, §5.14, §5.15, §7.11
**Files affected**: `packages/core/src/domain/{models,plan-caption-cues}.ts`, `packages/core/src/usecase/generate-captions.ts`, `packages/adapter/src/hyperframes/{parse,sdk-ops,preview-style}.ts`, `packages/server/src/routes/*`, `src/components/studio/scene-narration.tsx`
**Prerequisite**: P3 + P4 (session-aware mutation và script tiêm đi cùng đường dựng tài liệu preview)
**Skill**: `.agents/skills/bun/SKILL.md`
**Read first**: `packages/core/src/domain/word-timings.ts` (FULL), `packages/adapter/src/hyperframes/sdk-ops.ts` (FULL `applyCompositionOps`) + `parse.ts` (caller), `spikes/phase-5/fixture/index.html` (script caption **đã đo** — cách đọc `state.frame`, fps hữu tỉ, trừ `layerStart`)

**Tasks**:
- [ ] 6.1 `plan-caption-cues.ts` — planner thuần
  - Rebase **một chỗ duy nhất**: `absolute = cue.start + word.startSeconds`
  - Cắt cue: > 84 Unicode code point **hoặc** > 7 giây **hoặc** im lặng ≥ 0.6 giây; sàn 1.2 giây theo thang ưu tiên gộp → kéo dài trong chỗ trống → **kẹp**; không gộp qua ranh giới narration cue; không chồng, không vượt `sceneEnd`. Cue text canonical = spoken words join bằng một U+0020, punctuation giữ trong token.
  - _Requirements: R6.2–6.5_ — _Design: §5.13_
- [ ] 6.2 `generateCaptions` — thay **trọn** khối `.captions` trong một mutation; scene không có narration ⇒ **422**
  - Thêm structured `CompositionOp.replaceCaptions {target,cues,timingSource}`. Core chỉ truyền model;
    Adapter `applyCompositionOps` thay block và dựng node bằng DOM `textContent`/`setAttribute`, word/cue
    là text thuần, timing finite. Không Core string concat/import `linkedom`, không raw markup transport.
  - _Requirements: R6.1, R6.10, R6.13_ — _Design: §5.15_
- [ ] 6.3 Markup: `<span class="w" data-start data-end>` với mốc **tuyệt đối theo scene**; `data-caption-timing="engine|estimated"`
  - _Requirements: R6.6, R6.7_ — _Design: §5.14_
- [ ] 6.4 `buildCaptionRuntimeScript()` — đọc `{source:"hf-preview", type:"state", frame}`, `fps` **hữu tỉ** `{numerator, denominator}`, và trừ `data-start` của layer chứa span
  - `subtitles.activeColor` từ preview settings
  - _Requirements: R6.8_ — _Design: §5.14_
- [ ] 6.5 Stale: sửa script ⇒ đánh dấu stale, **không** tự chạy TTS; UI cảnh báo nhịp có thể sai
  - Đường đánh dấu nằm trong use case ghi narration/source và sidecar caption, không dựa riêng vào component state; reload/SSE vẫn đọc được stale từ source.
  - _Requirements: R6.11, R6.12_ — _Design: §5.13, §5.15_
- [ ] 6.6a Unit/integration: planner bốn ngưỡng, kẹp, đa cue, rebase; generate thay trọn block và stale persistence
  - Payload độc hại `</span><script>`, entity, bidi/control vẫn round-trip thành text và không tạo
    node/attribute thực thi; timing NaN/Infinity bị từ chối trước serialize. `p.textContent` khớp cue
    text, có khoảng trắng giữa từ và không sinh khoảng trắng sai quanh punctuation attached.
  - _Requirements: R6.14_ — _Design: §5.13–§5.15, §11, §17_
- [ ] 6.6b Browser: highlight khi phát/seek/đổi tốc độ và scene `start ≠ 0`; chuẩn bị fixture parity preview ↔ render ba mốc cho P11.2
  - _Requirements: R6.8, R6.14_ — _Design: §5.14, §11, §17_

**Acceptance Criteria**:
- [ ] Sinh lại caption không để sót cue cũ
- [ ] Preview và render cho cùng nhịp highlight

**Deliverables Created / Modified**: (điền planner/use case/runtime/markup, test và parity evidence khi thực thi)

---

## Phase 7: Dải thumbnail trên clip (R10)

**Addresses**: R10.1–10.9
**Design reference**: §5.20, §7.15
**Files affected**: `llm-documents/steering/{04-api-design,08-jobs-and-queue}.md`, `packages/core/src/port/ports.ts` (`CompositionDependencyPort`, `ThumbnailPort`, `ProjectPathInvalidator`), `packages/core/src/usecase/timeline-thumbnails.ts`, `packages/adapter/{package.json,src/hyperframes/{dependency-graph.ts,snapshot-thumbnail.ts}}`, `packages/adapter/src/cache/thumbnail-cache.ts`, `packages/adapter/src/fs/watcher.ts`, `packages/cli/src/composition-root.ts`, `packages/server/src/routes/*`, `src/components/studio/timeline-elements.tsx`
**Prerequisite**: P0 + P4 + P5 (`paths`, renderer/document path và safe-CSS tokenizer)
**Skill**: `.agents/skills/bun/SKILL.md` + skill global `hyperframes-cli` nếu harness có (resolve qua skill catalog, **không** hard-code đường dẫn home). Harness **không** có skill đó ⇒ không phải blocker: đọc `packages/adapter/src/hyperframes/*` và `node_modules/hyperframes` để lấy hành vi CLI, ghi `NOT AVAILABLE` vào Execution Log rồi tiếp tục
**Read first**: `packages/worker/src/snapshot-job.ts` (FULL — batch `--at`, AbortSignal và staging hiện có), `packages/adapter/src/hyperframes/{parse.ts,dom.ts}` (FULL — parser **chưa** thu `@import`, `url()`, font, module import, đệ quy), `packages/adapter/package.json` + `node_modules/@hyperframes/parsers/package.json` (acorn versions đã có)

**Tasks**:
- [ ] 7.0 Đồng bộ steering 04 §6 và steering 08 trước khi viết route thumbnail: phân biệt
  `snapshot` artifact bền (job) với batch thumbnail timeline derived-cache tương tác. Ngoại lệ chỉ
  hợp lệ khi có giới hạn 256 mốc, scheduler daemon 2 active/8 queued, AbortSignal xuyên suốt,
  capacity failure hữu hạn, không ghi project và không tạo artifact trong `snapshots/`.
  - _Requirements: R10.5–R10.9_ — _Design: §5.20, §7.15 · Steering reconciliation_
- [ ] 7.1a `CompositionDependencyPort` — graph HTML/CSS/JS/font đệ quy, canonical và phát hiện chu trình
  - Adapter thu HTML `src`/`href`; CSS dùng PostCSS + tokenizer value `packages/adapter/src/hyperframes/safe-css.ts` (deliverable P5) cho
    `@import`/`url()` + font; JS AST bằng
    `acorn`/`acorn-walk` cho static import/export-from, literal `import()` và `new URL(...,import.meta.url)`.
    Khai direct `acorn` **8.18.0** + `acorn-walk` **8.3.5** đúng resolution trong lock; không phantom
    import/package copy mới.
    Parse fail hoặc gặp dependency động không chứng minh được (`import(expr)`, URL runtime) ⇒
    `dependency_graph_unavailable` + placeholder; CSS `var()`/custom property có thể cấp URL mà không
    resolve tĩnh chắc chắn cũng fail-closed. Không cache fingerprint thiếu/không fallback
    project-wide. Đường ngoài project
    không vào fingerprint project; watcher invalidation xoá memo graph cho path đổi ngoài app.
  - Tham chiếu project đang thiếu vẫn trả path + trạng thái `missing`; file xuất hiện sau đó phải làm fingerprint đổi. Rename/delete invalidates cả path cũ lẫn mới.
  - _Requirements: R10.6_ — _Design: §5.20_
- [ ] 7.1b Nối invalidation dependency/thumbnail vào single-writer và watcher
  - Nối `ProjectPathInvalidator` của P0 tại composition root: một fan-out gọi `ProjectCache` và
    dependency/thumbnail invalidator. Commit trong `WriteAuthority` và external event từ
    `WorkspaceWatcher` phải đi cùng seam; không instrument SSE/route và không import Server từ Core/Adapter.
  - Invalidation dùng overlap equal/ancestor theo segment, nên đổi/xoá directory cha invalidates scene
    có dependency con; common prefix khác segment không trượt nhầm cache.
  - _Requirements: R10.6_ — _Design: §5.20_
- [ ] 7.2a Contract `ThumbnailPort.renderBatch(ref, keys, signal)` + fingerprint/profile của `ThumbnailService`
  - `fingerprint = sha256(hash scene + ordered(path,state,hash) phụ thuộc + hồ sơ render)`;
    `atSeconds` scene-local, tâm `(i+.5)*duration/count`, lượng tử `round(t*fps)/fps` và clamp frame cuối.
  - Public chỉ nhận enum `timeline-v1`; daemon resolve profile: fit aspect project vào box 160×160
    physical px (round, min 1) + fps/runtimeDigest/rendererVersion. Client không gửi dimension/digest;
    profile khác ⇒ 400. Render key hash canonical JSON `{fingerprint,atSeconds,resolvedProfile}`.
  - **Tính lại fingerprint trước khi ghi cache**; lệch ⇒ vứt kết quả, xếp lại
  - _Requirements: R10.6, R10.7_ — _Design: §5.20_
- [ ] 7.2b Batch renderer + scheduler hữu hạn
  - Một POST route gọi đúng **một batch** cho một scene/profile theo mẫu `snapshot-job.ts` (`hyperframes snapshot --at ...`), không coalesce mơ hồ giữa request có AbortSignal khác và không spawn process từng ô. Chỉ tái sử dụng builder/process pattern: **không** enqueue snapshot job, không ghi `snapshots/` vào project/revision. PNG temp ở app-data đổi sang WebP bằng `binaries.ffmpegPath`; không ambient PATH/dependency mới.
  - Scheduler hữu hạn toàn daemon: tối đa 2 batch chạy + 8 batch chờ; một queued batch cho mỗi
    `(project,scene,profile)`, request mới supersede queued request cũ; abort xoá queue ngay. Batch
    tối đa 256 mốc unique. Queue đầy trả failure `thumbnail_capacity`, không tạo promise/process mới.
    Fingerprint đổi sau render chỉ retry một lần khi generation còn hiện hành, lần hai trả
    `source_changing`, không requeue vô hạn.
  - _Requirements: R10.5–R10.8_ — _Design: §5.20_
- [ ] 7.2c `ThumbnailCacheAdapter` có namespace project và budget toàn daemon
  - `ThumbnailCacheAdapter`: namespace đĩa `<app-data>/cache/thumbnails/<sha256(projectId)>/`, `renderKey = sha256(canonicalJson({fingerprint,atSeconds,profile}))`, LRU tổng 512 MB + memory 128 ảnh, tmp+rename; API `get/put(projectId,key)` không đọc chéo project.
  - _Requirements: R10.6, R10.7_ — _Design: §5.20_
- [ ] 7.3 Route 7.15 — NDJSON, mỗi dòng `{atSeconds, status, url?, reason?}`; ảnh phục vụ qua route riêng, `Cache-Control: immutable`; `AbortSignal` đi **suốt chuỗi** tới tiến trình snapshot
  - POST kiểm scene thuộc project. GET chỉ nhận key `/^[0-9a-f]{64}$/`, gọi cache bằng `(projectId,key)` và trả 404 cho namespace khác; không ghép input thô vào path.
  - Disconnect kill tiến trình thật và không ghi cache dở; placeholder reason dùng error code ổn định từ contract chung.
  - Schema từ chối batch trộn scene/profile, quá 256 mốc hoặc trùng mốc; output đúng một dòng cho mỗi
    mốc theo thứ tự request, kể cả `thumbnail_capacity`/`source_changing`/
    `dependency_graph_unavailable`.
  - Từ chối NaN/Infinity/âm/ngoài duration; scene `start ≠ 0` vẫn render local time, UI không cộng start.
  - Từ chối profile lạ và field profile object thừa; test client không thể khuếch đại cache bằng
    width/runtimeDigest giả.
  - _Requirements: R10.5, R10.8_ — _Design: §7.15_
- [ ] 7.4 UI: `count = max(1, ceil(clipWidthPx / 80))`, mẫu tại tâm; đổi **mật độ** theo zoom; placeholder ổn định; virtualization tới **từng ô**, biên một khung nhìn
  - Huỷ request/ô ra ngoài `viewport ± 1 viewport`; zoom tạo bộ mốc mới, không scale bitmap cũ.
  - _Requirements: R10.1–10.4, R10.9_ — _Design: §5.20, §7.15_
- [ ] 7.5a Unit/integration cache/renderer: công thức + key; batch cùng project/profile thành một process; WebP; LRU; source đổi lúc render ⇒ bỏ kết quả cũ
  - Dùng hai temp project thật và process adapter có failure injection; abort kill child + không cache partial; key traversal/sai shape/project khác ⇒ 404; missing→present dependency/profile runtime đổi ⇒ miss; dynamic dependency/parse fail ⇒ placeholder và zero cache; LRU tính tổng qua mọi namespace; project tree/revision không đổi sau thumbnail.
  - Stress 20 batch chứng minh ≤2 process, queue ≤8, supersede/abort giải phóng slot, capacity trả
    placeholder, và source đổi liên tục dừng sau đúng một retry.
  - Fixture scene bắt đầu 6 s chứng minh sample local 0…duration, không render root time 6…end.
  - _Requirements: R10_ — _Design: §5.20, §11, §17_
- [ ] 7.5b Integration/browser invalidation/virtualization: đổi **CSS dùng chung** và watcher ngoài app ⇒ trượt đúng scene; clip >5 viewport chỉ sinh `viewport ± 1`
  - _Requirements: R10_ — _Design: §5.20, §11, §17_

**Acceptance Criteria**:
- [ ] Ghi ngoài app (file watcher) cũng làm mất hiệu lực đồ thị phụ thuộc + thumbnail liên quan

**Deliverables Created / Modified**: (điền port/service/adapters/routes/UI, cache metrics và browser evidence khi thực thi)

---

## Phase 8: Catalog, template, block (R7, R9)

**Addresses**: R7.1–7.7, R9.1–9.9
**Design reference**: §5.16, §5.16b, §5.17, §7.12, §7.13a/b
**Files affected**: `packages/core/src/port/ports.ts` (`CatalogPort`), `packages/adapter/src/catalog/*`, `packages/adapter/assets/catalog/**`, `packages/adapter/src/runtime/{runtime-paths.ts,packaged-runtime-manifest.ts,runtime-asset-source.ts}`, `packages/cli/src/runtime-paths-source.ts`, `scripts/{update-bundled-catalog,stage-artifact-runtime,build-runtime-archives,verify-artifact}.mjs`, `scripts/packaged-smoke/{steps,bodies}.mjs`, runtime fixture/config/tests, `packages/core/src/usecase/{prepare-catalog-install,execute-catalog-install}.ts`, `packages/server/src/routes/*`, `src/components/studio/*`
**Prerequisite**: P0 + P2 + P3 (dùng chung `planSceneInsertion`, cần history để test undo atomic)
**Skill**: `.agents/skills/bun/SKILL.md` + `.agents/skills/http-driver/SKILL.md`
**Read first**: `packages/core/src/usecase/motion-library-install.ts` (FULL — vendor nhiều file một mutation), HyperFrames registry types + remote resolver nêu ở bảng trên (FULL phần liên quan — upstream dùng `hyperframes:*`, example là project scaffold, có `registryDependencies`, không có version/digest), `packages/adapter/src/bgm/bgm-provider.ts` (HTTPS, redirect, DNS public guard, timeout, bounded read), runtime paths/manifest + artifact staging

**Tasks**:
- [ ] 8.1a Contract `CatalogItem`, version/compatibility và trạng thái materialization
  - Bundled item dùng semver; snapshot HyperFrames dùng `version = "git:<40 lowercase hex>"`, `source.revision/committedAt`, và dependency closure topo-sort.
  - Normalize upstream `minCliVersion` thành `compatibility.minHyperframesVersion`; validate semver,
    so với runtime 0.7.86 và hiện incompatibility trước mount. Khai `compare-versions` direct 6.1.1
    đã transitively có, không tự viết comparator/không thêm artifact bytes.
  - Bundled/materialized package có `integrity {algo:"sha256", files, manifest}` +
    `materialization:"verified"`; network listing metadata-only có `integrity:null` +
    `materialization:"metadata"`. Provenance sau install luôn lấy từ package verified, không từ listing.
  - _Requirements: R7.1, R9.1, R9.5_ — _Design: §5.16_
- [ ] 8.1b Normalize schema HyperFrames 0.7.86 thành template/block VidCom
  - Normalize **đúng schema 0.7.86**: chỉ top-level `type:"hyperframes:block"` ⇒ `kind:"block"`. `hyperframes:example` là full-project scaffold nên **không** map thành template; `hyperframes:component` chỉ được nhận khi là dependency của block. Template là scene package VidCom curate trong bundled manifest, đúng một scene entry và không target root `index.html`; shape/type khác bị bỏ với diagnostic ổn định.
  - Top-level block bắt buộc đúng một file `type:"hyperframes:composition"`; target canonical thành
    `entry`. Zero/hai entry bị drop; composition của dependency không được chọn làm entry. Bundled
    template khai entry tường minh và entry phải thuộc exact verified file set.
  - Upstream không có group/category: adapter dùng category rule versioned theo tag/name, fallback
    `Other`; bundled khai tường minh, UI không tự suy. Name/dependency phải là kebab slug ≤128,
    không raw-interpolate URL/path. Enforce NFC/bounds Design §5.16 cho mọi metadata.
  - _Requirements: R7.1, R9.1, R9.5_ — _Design: §5.16_
- [ ] 8.2a Bundled catalog và artifact runtime
  - Bundled manifest/files là tài sản frozen tại `packages/adapter/assets/catalog/**` và phải nằm trong
    source diff; mỗi snapshot ghi upstream commit/digest nguồn. `scripts/update-bundled-catalog.mjs`
    là tool maintainer nhận **commit 40-hex tường minh**; build/build:artifact không resolve `main` và không gọi mạng.
  - Thêm `catalogAssetRoot` vào `RuntimePaths`/`RUNTIME_PATH_NAMES`; development trỏ adapter assets, artifact trỏ `<hyperframes archive>/catalog`. `stage-artifact-runtime.mjs` copy catalog vào HyperFrames staging root; cập nhật required archive entries, packaged manifest validator, runtime path source, artifact verifier/fixture/smoke — không tạo fallback source-tree.
  - _Requirements: R7.6, R9.7, R9.7b, R9.7c_ — _Design: §5.16, Decision 9_
- [ ] 8.2b `CatalogPort` cache `<app-data>/cache/catalog/`: TTL 24 h, SWR, atomic tmp+rename, negative ≤60 s, offline không chờ mạng
  - Network fetch HTTPS-only, manual redirect tối đa 3 và revalidate host mỗi hop; DNS/private-address guard theo BGM provider; allowlist cố định `api.github.com` + `raw.githubusercontent.com`, không URL từ payload. Timeout/AbortSignal đi xuyên request.
  - Resolve branch `main` qua GitHub API thành commit 40-hex + `committedAt`; mọi manifest/file sau đó tải từ raw URL chứa **đúng commit**, không dùng `main`. Đồng thời nhiều lần refresh dùng single-flight.
  - Refresh chỉ tải index + item manifest metadata ở cùng commit, concurrency tối đa 8; mở/list catalog
    **không** tải file payload. `materialize(name,version,signal)` mới resolve dependency closure và
    tải payload.
  - _Requirements: R7.6, R9.7, R9.7b, R9.7c_ — _Design: §5.16, Decision 9_
- [ ] 8.2c Materialize payload catalog có bounds, atomic cache và pin lifecycle
  - `materialize(name,version,signal)` resolve dependency closure và stream file của item được chọn
    vào temp trong khi hash; sinh verified package rồi atomic publish
    **toàn package**. Failure/cancel dọn temp và rơi về stale/bundled với source/reason tường minh.
  - Bounds bắt buộc theo bytes thật: index ≤2 MiB/≤1.024 item; manifest ≤2 MiB; closure ≤256 item,
    ≤1.024 file, mỗi file ≤25 MiB, tổng package ≤250 MiB. Payload package cache LRU tổng 1 GiB;
    vượt trần ⇒ `TooLarge`, không partial publish. Thiếu/sai `Content-Length` hoặc redirect không reset count.
  - `materialize` trả `{path,contentHash,source:StagedFileSource,encoding}[]`, không `Uint8Array[]`;
    mỗi call giữ verified-cache pin trong phạm vi call và release `finally`; `prepare` không giữ
    source/pin trong RAM lúc chờ approval, `execute` mới giữ tới mutation settle. `UndoContentPort`
    giữ refs cần cho redo sau commit.
  - _Requirements: R7.6, R9.7, R9.7b, R9.7c_ — _Design: §5.16, Decision 9_
- [ ] 8.3 Kiểm verified package trước khi ghi (§5.16b): từ chối item còn
  `materialization:"metadata"` · path traversal · path trùng · **tập chính xác** khớp manifest ·
  digest từng file + digest manifest canonicalize
  - Normalize tag bằng NFC + dedupe + sort code point; manifest digest phủ cả
    title/description/category/**canonical sorted tags**/compatibility/duration/**entry**. Mount ghi
    một `data-catalog-provenance` canonical JSON đã HTML-attribute-escape; parse round-trip đúng object,
    không cho metadata thoát attribute/tag.
  - _Requirements: R9.5b, R9.5c_ — _Design: §5.16b, §8.1_
- [ ] 8.4a Plan/policy cho cài + mount: `binding.planDigest` phủ **toàn bộ** exact plan,
  `targetHashes` phủ mọi target đang tồn tại; một composite gồm file + mount + provenance
  - Parent dirs package là step `mkdir either` tường minh, nông-trước; không để file publish tự mkdir
    recursive ngoài journal. Undo chỉ rmdir directory lần cài tạo và còn rỗng, giữ directory có trước.
  - Bất biến `kind`: `template` chỉ `new-scene`; `block` cả hai; kind khác ⇒ `InvariantViolated` 422
  - Prepare union `choice_required | skipped | ready`; intent có
    `existingPolicy?:reuse|replace|skip`. Giống hệt vẫn hỏi `Reuse & mount/Skip`; reuse ⇒ file
    `reuse` nhưng **vẫn mount**, replace bị từ chối. Khác version/unmanaged chỉ hỏi Replace/Skip,
    reuse bị từ chối; skip zero write; **cùng version khác digest ⇒ 422** không cho replace.
  - Target tồn tại nhưng thiếu provenance hợp lệ ⇒ `comparison:"unmanaged"`, existing
    version/integrity null + target hashes; không giả là đã cài. Replace bind exact pre-image để undo
    khôi phục file người dùng, Skip zero write.
  - _Requirements: R7.3, R9.3–R9.6_ — _Design: §5.17_
- [ ] 8.4b Assembly một composite file + mount + provenance
  - `new-scene` gọi `planSceneInsertion`; `into-scene` lấy content qua `CompositionPort.applyOps`;
    không gọi `createScene()` commit lồng/không copy insertion logic, và chỉ một `mutateSource`.
  - New-scene tạo wrapper/sidecar sceneId duy nhất trỏ entry package; into-scene thêm sub-composition
    layer scene-local 0, clamp theo duration scene, overlay track kế tiếp. Chèn cùng item hai lần không
    trùng sceneId/path; provenance gắn từng instance. `paths` + typed `readGuards` phủ mọi target package;
    file action `reuse` đi `historyReadGuards` kèm digest còn create/replace đã ở `paths`. Event paths
    vẫn chỉ chứa file thực sự đổi.
  - _Requirements: R7.3–R7.5, R9.3–R9.4c, R9.8_ — _Design: §5.17_
- [ ] 8.4c Exact-intent `prepare → grant → execute`
  - `prepare` materialize package trước khi tạo plan/grant; intent gồm `expectedRevision`; grant bind
    `version` + manifest digest đã verified, action/fromHash kể cả `null`, mount/provenance rồi release
    source/pin. `targetHashes` chỉ chứa hash thật của mutation target đang có + reuse read-guards;
    target phải vắng được khóa bằng planDigest và step expected-null, không dùng hash giả. `execute` nhận lại cùng
    `{projectId,name,version,mount,existingPolicy,expectedRevision}`, materialize lại, dựng lại binding
    và `planReserve(grantId,binding)`; đổi bất kỳ intent/digest/hash/revision nào
    đều fail trước mutation. Execute hash lại bytes cache, giữ pin tới settle rồi release `finally`.
    Không có in-memory pending-plan sống qua hai request và grant expire/revoke không được rò pin.
  - _Requirements: R9.5–R9.8_ — _Design: §5.17_
- [ ] 8.5 UI: lọc theo `kind` rồi tag/từ khoá; cảnh báo tương thích trước khi chèn; chọn + cuộn tới scene mới; trạng thái rỗng có lý do
  - Đường chèn template gọi `new-scene`; block cho phép target Design §5.17; UI hiện provenance
    `bundled|cache|network`, `stale`, version và trạng thái “sẽ xác minh khi cài” nếu metadata-only;
    sau materialize/install hiện digest thật. Lỗi integrity không bị đổi thành “offline”.
  - `choice_required` hiện đúng existing/candidate version+digest: identical có `Reuse & mount/Skip`;
    khác version hoặc unmanaged có `Replace/Skip`. Unmanaged nói rõ file không có provenance, không
    hiện version giả. Skip không mount; sau reuse UI nói file cũ được dùng lại và mount mới đã tạo.
  - _Requirements: R7.1, R7.2, R7.4–7.6, R9.1, R9.2, R9.4c_ — _Design: §5.16, §5.17_
- [ ] 8.6a Unit/cache: lọc kind/category/tag/query; type đầy đủ `hyperframes:*`; category rule/fallback/bounds; top-level entry đúng một/zero/hai + dependency composition không tranh entry; example không thành template/root-index không lọt; canonical digest + provenance escape/round-trip; dependency topo/cycle/missing/target collision; duplicate/traversal; TTL/SWR/negative cache và source/stale semantics
  - Fake HTTP phủ commit pinning (không request raw `/main/`), mở catalog không request payload,
    materialize chỉ request closure đã chọn, HTTP downgrade, redirect ra host/private IP, redirect
    loop, timeout/abort, concurrent single-flight, mọi byte/item/file/package/cache bound và partial
    stream cleanup; không dùng mạng registry thật.
  - _Requirements: R7, R9_ — _Design: §5.16, §11, §17_
- [ ] 8.6b Mutation integration: digest lệch ⇒ zero write; cài + mount = một mutation; same-version/different-digest ⇒ 422; failure injection rollback
  - Undo gỡ mount + file lần cài tạo, khôi phục file thay thế, không đụng file có từ trước không bị sửa.
  - Parent dir package thiếu/có sẵn/race file-vs-directory: journal/reconcile đúng; undo xoá đúng dir
    lần cài tạo và không xoá dir có trước hoặc dir đã có entry mới.
  - Package fixture lớn đi hoàn toàn qua `write-staged` create/replace; prepare/execute/undo/redo không
    materialize payload tổng vào heap, catalog LRU eviction sau install không làm redo mất content.
  - _Requirements: R7, R9_ — _Design: §5.16–§5.17, §11, §17_
- [ ] 8.6c Approval/exact-intent integration và pin cleanup
  - Phủ dialog bị bỏ, grant expire/revoke, daemon restart giữa prepare/execute, execute đổi mount/name,
    cache eviction và failure trước/sau reserve; pin/refcount về baseline, không partial write.
  - _Requirements: R9.5–R9.8_ — _Design: §5.16–§5.17, §11, §17_
- [ ] 8.6d Repeat-mount/LIFO/shared-dependency integration
  - Phủ identical reuse vẫn mount; insert cùng template/block hai lần có scene instance riêng; replace
    và skip; unmanaged collision replace/skip + restore pre-image; undo LIFO lần hai chỉ gỡ instance
    hai, undo lần một mới gỡ file mutation một đã tạo.
  - Hai studio session mount cùng package vào hai scene khác nhau: receipt reuse của tab B read-guard
    file shared và block tab A undo xoá dependency; không phát invalidation giả cho read-guard-only path.
    Đổi file reuse sau plan nhưng trước mutex hoặc redo trong cửa sổ watcher debounce đều fail zero-write.
  - _Requirements: R7, R9_ — _Design: §5.16–§5.17, §11, §17_
- [ ] 8.6e Thêm packaged-smoke step tự chứa `editing-experience-runtime`
  - Khi P11 chạy, step dùng app-data/workspace sạch với private PATH + runner network cut; boot daemon/DB hai
    lần, đọc và cài bundled catalog, xác minh migration/catalog digest/runtime path và tuyệt đối
    không đọc source tree. Step tự tạo prerequisite của nó, không phụ thuộc
    `ui-lifecycle`/`render-media`, để `--step editing-experience-runtime` là evidence độc lập.
  - Đăng ký step là required trong `scripts/packaged-smoke/steps.mjs` và trả evidence machine-readable;
    ở P8 dùng unit/fixture test cho registration/body, chưa yêu cầu runner đặc quyền. Full smoke thật
    vẫn chạy ở P11 để bắt regression chéo phase.
  - _Requirements: R7.6–R7.7, R9.7–R9.7c_ — _Design: §5.16, §9, §11_

**Acceptance Criteria**:
- [ ] Mọi màn hình catalog hiện `source` (`bundled`/`cache`/`network`) và cờ `stale`
- [ ] Build/staging test không gọi mạng, runtime fixture không chứa đường dẫn source tree và bundled
  template không thể thay root `index.html`; SEA binary + runner network cut được đóng ở P11

**Deliverables Created / Modified**: (điền manifest/assets/adapter/use case/UI, digest và packaged-smoke evidence khi thực thi)

---

## Phase 9: Kéo asset vào timeline (R11)

**Addresses**: R11.1–11.9
**Design reference**: §5.21, §7.14, §7.14b
**Files affected**: `packages/core/src/usecase/mount-asset.ts`, `packages/adapter/src/db/pending-mount.ts`, `packages/contracts/src/editing.ts`, `packages/cli/src/{composition-root.ts,startup.ts}`, `packages/server/src/routes/*`, `src/components/studio/{scene-media-list.tsx,timeline.tsx}`
**Prerequisite**: P2 + P3 + P5
**Skill**: `.agents/skills/bun/SKILL.md` + `.agents/skills/hono/SKILL.md`
**Read first**: P5 deliverables, `packages/core/src/usecase/project-writes.ts` (search `createScene` — mẫu scene mới ba file)

**Tasks**:
- [ ] 9.1 `mountAsset` tạo **scene bọc asset**; Core **tự probe** duration theo `assetContentHash`, không nhận từ client; không probe được ⇒ 422, file vẫn ở Media
  - Input là discriminated union: asset có sẵn nhận path/hash/at/track và không operationId; retry
    pending chỉ nhận operationId/precondition/onOverflow, rồi Core đọc path/hash/at/track từ row cùng project.
  - Ảnh: mặc định **4 giây**; `onOverflow: "shrink" | "extend-root"`; "shrink" chỉ rút scene bọc, **không** in/out point
  - Dùng `planSceneInsertion` từ P2 để dựng root ops rồi ghép wrapper/sidecar/pending close trong một
    composite; không gọi `createScene()` lồng và không copy thuật toán shift/root duration.
  - `historyReadGuards` gồm `{path:assetPath,state:file(assetContentHash)}`; undo gỡ reference vẫn được, redo bị block
    nếu asset đã đổi/xoá và luôn recheck hash đồng bộ trước publish.
  - _Requirements: R11.1, R11.4, R11.4b, R11.5, R11.6, R11.6b_ — _Design: §5.21_
- [ ] 9.2a `PendingMountPort` + route 7.14b (GET liệt kê, DELETE = `abandon`)
  - Port chỉ có `lookup/listPending/markFailed/abandon`; **không** có `open/close`: hai transition đó chỉ
    journal adapter áp trong transaction từ P0. `lookup` trả union `active(record) | expired |
    never-seen`, adapter phân biệt bằng row pending + expression-index journal; route/use case không
    query SQLite trực tiếp và không gộp `expired` với `never-seen`.
  - `listPending` chỉ trả `uploaded_unmounted` theo `updatedAt`; mounted/abandoned là tombstone ẩn,
    chỉ exact lookup thấy để idempotency/expiry không biến thành item pending giả.
  - `markFailed`/`abandon` compare-and-set chỉ trên `uploaded_unmounted`; abandon lặp idempotent,
    nhưng mounted/cross-project bị từ chối. Race abandon↔close phải cho đúng một phía thắng; close
    thua thì composite mount rollback, abandon thua thì không đổi row mounted.
  - Validate nhóm upload `operationId` + `atSeconds` + `trackIndex` all-or-none; ULID, giây hữu hạn ≥0, track integer ≥0. `operationId` gắn project; `uploadFingerprint` server-side phân biệt replay giống/khác ⇒ 409 khi khác.
  - _Requirements: R11.3b_ — _Design: §5.10, §5.21, §6.4, §6.5, §7.14b_
- [ ] 9.2b Retention/replay/startup cho pending mount: `mounted` 24 giờ, `abandoned` 7 ngày
  - Startup: `uploaded_unmounted` quá 7 ngày → `abandoned`; `mounted` giữ tombstone 24 h rồi xoá;
    replay trong 24 h trả đúng result cũ. Sau TTL, tra open-transition qua journal expression index
    rồi trả 404 **trước mutation**; không coi operation cũ là ID mới và không tạo scene/file lần hai.
    Cleanup chỉ ở startup sau khi history daemon cũ đã mất; không periodic-delete row mà receipt undo
    của daemon hiện tại còn tham chiếu.
  - _Requirements: R11.3b_ — _Design: §5.10, §5.21, §6.4, §6.5, §7.14b_
- [ ] 9.3 UI: **một** máy trạng thái `uploading → mounting → done | uploaded_unmounted → retry`; một thanh tiến độ cho cả hai bước; Media hiện "đã upload, chưa mount" kèm nút thử lại
  - Asset có sẵn gọi mount một mutation, không tạo `operationId`; file ngoài gọi upload (`open`) rồi mount (`close`) và tái dùng operationId. Upload hỏng/huỷ ⇒ không gọi mount.
  - Hiển thị rõ undo chỉ gỡ mount/scene wrapper, **không** xoá file asset đã upload.
  - Lỗi transport upload mơ hồ ⇒ GET pending operation trước: đã có row thì đi thẳng mount, chưa có
    và journal chưa từng thấy mới resend file; 404 expired là terminal, không tự sinh operation mới.
  - _Requirements: R11.2, R11.3, R11.3b, R11.8_ — _Design: §5.21_
- [ ] 9.4 Chọn + cuộn tới clip mới; clip thiếu nguồn hiện trạng thái thiếu kèm đường dẫn
  - _Requirements: R11.7, R11.9_ — _Design: §5.21, §7.14_
- [ ] 9.5a Pending-mount integration: state/retention, cross-project, replay giống/khác payload, trong/sau TTL, upload lỗi ⇒ zero mount mutation
  - Chạy SQLite file + temp fs thật và production composition-root/startup thật.
  - Chứng minh retry mount có operationId bỏ qua mọi path/hash/time/track từ client (schema từ chối
    field thừa), dùng record server-side; xoá row theo TTL nhưng giữ journal rồi replay ⇒ 404/zero write.
  - Race abandon/markFailed với close/reopen; không nhánh nào ghi đè row mounted hoặc để scene mount
    thành công khi row đã abandoned.
  - _Requirements: R11_ — _Design: §5.21, §6.4–§6.5, §11, §17_
- [ ] 9.5b Recovery failure injection: kill sau upload publish/trước settle và sau mount publish/trước close; kiểm `lastFailure`/`interrupted`, idempotency và restart UI query
  - _Requirements: R11.3b_ — _Design: §5.21, §6.4–§6.5, §11.2_
- [ ] 9.5c Browser/undo: một progress/một result, huỷ từng ranh giới, retry uploaded-unmounted; undo gỡ wrapper+sidecar và **giữ asset**
  - Pending operation: undo đồng thời reopen row + hiện "mount đã hoàn tác, file vẫn ở Media"; redo
    đóng lại row. Existing-asset mount không tạo pending row. Failure injection không để row mounted
    trỏ scene vắng.
  - Sau undo, sửa/xoá asset ngoài app ⇒ redoBlocked; asset đổi khi vẫn mounted không cản undo gỡ mount.
  - _Requirements: R11_ — _Design: §5.21, §6.4–§6.5, §11, §17_

**Acceptance Criteria**:
- [ ] Kill tiến trình giữa upload và mount ⇒ mở lại app vẫn thấy "đã upload, chưa mount"

**Deliverables Created / Modified**: (điền schema adapter/use case/routes/UI, restart/replay/undo evidence khi thực thi)

---

## Phase 10: Draft, timecode, phím tắt (R8)

**Addresses**: R8.1–8.6 (gồm 1b–1e)
**Design reference**: §5.18, §5.19
**Files affected**: `src/lib/studio/{draft-store.ts,transport-keys.ts,format.ts}`, `src/components/studio/use-source-files.ts`, `src/app/projects/[slug]/composer-client.tsx`
**Prerequisite**: P0 + P2 + P3 + P4 (`paths`, Alt-move, undo và reload buffer)
**Skill**: `.agents/skills/bun/SKILL.md` + `.agents/skills/http-driver/SKILL.md`
**Read first**: `src/components/studio/use-source-files.ts` (FULL — dòng bỏ draft khi đóng tab), `src/app/projects/[slug]/composer-client.tsx` (FULL — chỗ SSE tải lại snapshot)

**Tasks**:
- [ ] 10.1 `draft-store.ts`: `DraftEntry {path, baseHash, baseRevision, draft, acknowledgedChangeSeq, incomingGeneration, incomingStatus, incoming, resolution}`; `incomingStatus = idle|loading|ready|failed`; `incoming.content: string | null` (null = file bị xoá ngoài)
  - Ba lựa chọn conflict: `resolved-keep` **rebase** base lên incoming (giữ được thì phải lưu được); `resolved-take` thay draft; `compare` giữ conflict mở và hiển thị incoming/draft song song. Ca `incoming.content === null` ⇒ giữ draft và tạo lại file khi ghi.
  - _Requirements: R8.1d_ — _Design: §5.18_
- [ ] 10.2 Ba đường cảnh báo: đóng tab/cửa sổ trình duyệt · đóng **tab editor** có draft (thay hành vi bỏ draft hiện tại) · điều hướng/đổi project
  - _Requirements: R8.1, R8.1b, R8.1c, R8.2_ — _Design: §5.18_
- [ ] 10.3 SSE dùng `paths`: có draft đụng ⇒ hỏi; không đụng ⇒ làm mới im lặng
  - Content và preview-settings đều vào buffer P4; compare/keep/take không làm rơi draft đang mở.
  - Conflict path dùng overlap equal/ancestor segment-safe. Mỗi path có generation theo SSE seq;
    event lập tức đặt `loading` + conflict và disable save **trước** GET; fetch chỉ apply nếu còn latest,
    404 = deleted/ready, lỗi mạng = failed + retry/reload và vẫn disable save. Event mới sau keep nhưng
    trước save phải mở conflict lại; SSE gap refetch toàn bộ draft mở trước khi enable save.
  - Response save của chính draft lấy exact `WriteEnvelope.changeSeq`, coalesce SSE `<=` seq đó và chỉ
    clear pending generation không mới hơn response; event B mới hơn response A vẫn giữ conflict B.
    Response no-op/null seq cập nhật base nhưng không clear incoming pending.
  - _Requirements: R8.1d, R8.1e_ — _Design: §5.18, §5.9_
- [ ] 10.4 `formatTimecode(seconds, fps)` → `m:ss.ff` với `ff = floor((seconds % 1) * fps)`
  - _Requirements: R8.3_ — _Design: §5.19_
- [ ] 10.5 `TRANSPORT_BINDINGS` là **nguồn duy nhất** cho xử lý phím và bảng phím tắt
  - `Space` · `←`/`→` một khung · `Shift`+`←`/`→` một giây · `Home`/`End` · `Alt`+mũi tên dịch scene · `Esc` bỏ chọn · `mod`+`Z` / `mod`+`Shift`+`Z`
  - Không nuốt phím khi con trỏ trong ô nhập
  - _Requirements: R8.4–8.6_ — _Design: §5.19_
- [ ] 10.6a Unit: draft reducer keep/take/compare + incoming deleted/save-after-keep; `transportActionFor`; `formatTimecode` hai frame liền nhau
  - Phủ response A về sau B, SSE của chính save đến trước/sau response, external B đến trước response A,
    save click trong khi latest GET còn pending/failed, external directory parent, common-prefix khác
    segment, event mới sau keep trước save và SSE gap; draft không nhận snapshot stale/không overwrite im lặng.
  - _Requirements: R8_ — _Design: §5.18, §5.19, §11, §17_
- [ ] 10.6b Browser: mọi warning path, SSE khi đang gõ, compare UI, modifier macOS/khác và input không bị nuốt phím
  - Phủ keep/take/compare, incoming deleted, save sau keep không 409, mọi warning path, modifier macOS/khác, input không bị nuốt phím.
  - _Requirements: R8_ — _Design: §5.18, §5.19, §11, §17_

**Acceptance Criteria**:
- [ ] Không đường nào bỏ draft mà không hỏi

**Deliverables Created / Modified**: (điền reducer/UI/bindings, browser conflict/warning evidence khi thực thi)

---

## Phase 11: Chốt chất lượng

**Addresses**: verification gate của R4.1c, R6.14, và parity MCP
**Design reference**: §5.9 (ngân sách), §7 (MCP parity), §11
**Files affected**: `tests/**`, `package.json`, `.github/workflows/{phase4-browser-session,packaged-smoke}.yml`, `scripts/{verify-spec-test-paths,source-identity}.mjs`, `scripts/packaged-smoke/{steps,bodies}.mjs`, `packages/mcp/src/**`, `packages/contracts/src/**`, `packages/agent-kit/{AGENTS.md,CLAUDE.md,src/generated-bundle.ts}`
**Prerequisite**: P1–P10
**Skill**: `.agents/skills/bun/SKILL.md` + `.agents/skills/mcp-builder/SKILL.md`
**Read first**: `llm-documents/steering/{03-architecture-ddd,04-api-design,05-mcp-tool-design,10-testing,13-mcp-protocol-compatibility}.md` (các đoạn D1/parity/approval), `tests/support/browser-harness.ts` (FULL)

**Tasks**:
- [ ] 11.1 **Browser test đo R4.1c end-to-end**: **< 500 ms** cho bốn ca
  - Browser write: đo từ **response success** → khung đầu phản ánh nội dung/changeSeq mới, riêng content mutation và preview-settings mutation.
  - Ghi ngoài: đo từ **SSE durable event được browser nhận** → khung đầu phản ánh nội dung/changeSeq mới, riêng content mutation và preview-settings mutation (project revision có thể không đổi).
  - Cả bốn dùng cùng `previewUrl`, response `no-store`, xác minh nội dung khung mới chứ không chỉ event/DOM; con số spike **251–252 ms** chỉ là `PlayerHost.reload()`, không phải evidence AC.
  - _Requirements: R4.1c_ — _Design: §5.9, §11.2, §17_
- [ ] 11.2 Parity preview ↔ render cho caption (R6.14) trên project thật
  - Capture đúng cùng project/revision tại ba mốc trước/đang/sau từ; so frame/active-word và lưu artifact evidence, không so hai DOM giả.
  - _Requirements: R6.14_ — _Design: §5.14, §11.1–§11.2_
- [ ] 11.3a Kiểm steering MCP không drift và chốt shared tool contracts; **không** phát hành undo/redo
  - Trước khi sửa tool, đối chiếu steering 03/04/05/10 sau S0.5 với Design §7/D7/D9 và contract
    approval-grant. Nếu còn câu cũ thì S0 chưa đóng hợp lệ: sửa checkpoint S0.5/evidence trước rồi mới
    tiếp tục P11, không tạo thêm một quyết định mới ở đây.
  - Ghi ngoại lệ D9: R5 local upload/tree CRUD/apply-font không có tool mới ở Giai đoạn 5; không nhận
    absolute path, không nhét binary 500 MB vào JSON/MCP và không gọi `save_file` là parity giả.
  - Chốt input/output chung trong `packages/contracts` cho bảy tool; HTTP và MCP import lại, không copy
    Zod. Ghi rõ Decision 12/D7 trong registry/agent-kit: không có tool undo/redo.
  - _Requirements: R2, R6, R7, R9, R11, R12; Deferred D7/D9_ — _Design: §7 MCP parity, Decision 12, §13_
- [ ] 11.3b Tool scene MCP: `reorder_scenes`, `move_scenes`, `delete_scenes`
  - Gọi trực tiếp cùng Core use case của P2; khai permission và `availableInLegacy` theo registry hiện
    tại. `delete_scenes` giữ prepare/grant/execute, daemon approval grant một lần và cùng error semantics;
    không bypass xác nhận hoặc tự dựng planner trong tool.
  - _Requirements: R2, R12_ — _Design: §7 MCP parity_
- [ ] 11.3c Tool catalog/content MCP: `list_catalog_items`, `generate_captions`, `install_catalog_item`, `mount_asset`
  - `list_catalog_items` là read tool dùng cùng filter/output `{items,source,stale}` của route 7.12;
    không gọi mạng khác policy `CatalogPort` và không tạo schema catalog thứ hai.
  - `install_catalog_item` dùng input-required hiện có cho choice identical/different/unmanaged rồi
    approval grant; retry lặp exact intent/policy/revision. Không biến `choice_required` thành auto-replace.
  - Ba tool ghi `generate_captions`/`install_catalog_item`/`mount_asset` gọi trực tiếp use case
    P6/P8/P9, dùng precondition/probe/pending semantics giống HTTP; không thêm transport-only mutation
    hay tự đưa receipt MCP vào studio history.
  - _Requirements: R6, R7, R9, R11_ — _Design: §7 MCP parity_
- [ ] 11.3d Contract parity, agent-kit và packaged catalogue cho bảy tool
  - Contract test chạy hai lần legacy + modern, HTTP/MCP cùng error semantics và không có Zod schema copy. Update `packages/agent-kit/AGENTS.md`, `CLAUDE.md`, generated bundle/skills bằng build script rồi chạy `test:agent-kit`.
  - Mở rộng packaged-smoke step `editing-experience-runtime` của P8 để assert MCP catalogue trong cả
    legacy/modern có đúng tool mới; P11.5d sẽ build và chạy lại step trên source identity cuối.
  - _Requirements: R2, R6, R7, R9, R11, R12_ — _Design: §7 MCP parity, §11_
- [ ] 11.4 Xác nhận fps thật của project (fixture spike không đổi được fps runtime bằng `data-fps`) và ghi kết quả vào `spikes/phase-5/README.md`
  - _Requirements: R6.8_ — _Design: §5.14, §11_
- [ ] 11.5a Chốt Verification Matrix và source identity không phụ thuộc staging
  - Thêm `## Phase Verification Matrix` vào checklist trước `## Task Status Legend`, theo đúng thứ tự
    `S0,P0,P1,…,P11`, chỉ ghi test path **đã tồn tại**; Design §11 link tới matrix này thay vì copy.
    Mở config của `scripts/verify-spec-test-paths.mjs` từ chuỗi phase một ký tự sang mảng phase id để
    vẫn kiểm đúng ba spec cũ, rồi đăng ký Editing Experience với 13 id trên. Script hiện chỉ kiểm ba
    spec cũ nên PASS trước task này không phải evidence của spec.
  - Thêm `scripts/source-identity.mjs`: digest canonical gồm HEAD + mode/path/content của union
    `git diff --name-only -z HEAD` và `git ls-files --others --exclude-standard -z`; marker riêng cho
    file deleted/symlink. Với entry còn tồn tại, dùng `lstat`: mode chuẩn hoá Git
    `100644|100755|120000`, regular file hash bytes, symlink hash **link-target bytes từ `readlink`**
    chứ không follow. Entry deleted mang mode + blob id từ HEAD. Encode từng record có length-prefix
    trước khi hash để path/content không thể ghép mơ hồ; resolve containment, reject NUL/absolute/`..`
    trước khi đọc và sort bằng UTF-8 path bytes (`Buffer.compare`), không dùng locale.
    Không dựa vào index/staging và không bỏ sót file untracked. Chỉ loại ba file thay đổi thuần log/state
    của spec này: checklist, `implementation-notes.html`, main spec `inprocess`; steering, Design,
    Goals, tests, scripts, generated bundle và mọi source khác vẫn nằm trong digest.
    CLI `node scripts/source-identity.mjs --json` trả `{head,digest,paths}` theo thứ tự ổn định.
  - Unit-test staged-only, unstaged, untracked, deleted, symlink và evidence-only change. Ghi identity
    trước mỗi gate 11.5b–e; identity đổi ⇒ chỉ gate đã chạy từ digest cũ phải chạy lại.
  - _Requirements: all_ — _Design: §11, §17_
- [ ] 11.5b Chạy static/local gates — đúng script có trong `package.json`
  - `bun run typecheck` (`tsc --noEmit`) · `bun run lint` (`eslint`) · `bun run test` (`vitest run`)
  - `bun run test:boundaries` · `bun run test:golden` · `bun run test:mcp-catalogue` ·
    `bun run test:mcp-contract` · `bun run test:schema-drift` · `bun run test:spec-paths` ·
    `bun run test:agent-kit` · `bun run test:vieneu-sidecar` · `bun run test:runtime-smoke`
  - _Requirements: all_ — _Design: §11, §17_
- [ ] 11.5c Chạy browser gate exact-identity
  - Gom browser evidence của spec vào `tests/frontend/editing-experience-browser.test.ts`; thêm file đó vào `test:browser-session` và workflow browser; chạy `bun run test:browser-session`. Thiếu Chrome local ⇒ `[!]` có lý do, nhưng workflow với `VIDCOM_REQUIRE_BROWSER=1` phải fail, không coi skip là PASS.
  - _Requirements: R1–R4, R6–R12_ — _Design: §11, §17_
- [ ] 11.5d Chạy build + artifact gate exact-identity
  - Nếu exact-host runtime inputs chưa có và network sẵn, chuẩn bị **smoke fixture đã pin** bằng
    `VIDCOM_ALLOW_UNRELEASED_SMOKE_RUNTIME=1 node scripts/prepare-packaged-runtime.mjs --artifact-version 0.1.0-editing-smoke`,
    rồi build không có `--release`. Evidence này chỉ đóng packaged compatibility của spec; không được
    gọi là production-release/supply-chain approval. Network không có ⇒ `[!]` đúng artifact gate và
    tiếp tục gate độc lập, không tự hạ điều kiện hay dùng artifact cũ.
  - `bun run build` · `bun run build:artifact`; gate packaged của **spec này** là step tự chứa P8:
    chạy strict `bun run test:packaged-smoke -- --step editing-experience-runtime` với
    `VIDCOM_DOCTOR_STRICT=1` và `VIDCOM_SMOKE_NETWORK_CUT=1`. Gate cần runner có quyền cắt mạng; nếu
    local không có, chỉ cùng step trong workflow `packaged-smoke.yml` ở đúng source identity thay thế
    được. Plain smoke không cắt mạng hoặc run cũ không phải evidence offline.
  - Ghi output `source-identity.mjs` trước build và step riêng. CI chỉ được dùng khi identity là
    worktree sạch và SHA workflow đúng HEAD chứa toàn bộ source/test/tooling; CI cũ, synthetic merge
    SHA hoặc workflow chỉ chứa một phần diff không đóng gate.
  - _Requirements: all_ — _Design: §11, §17_
- [ ] 11.5e Chạy full strict packaged regression trên cùng source identity
  - Sau step riêng vẫn chạy **full** strict packaged smoke để phát hiện regression chéo phase. Failure
    mới do diff spec gây ra chặn P11. Chỉ failure trùng baseline đã ghi ở S0 và đúng AC production-release
    còn mở của Giai đoạn 4 mới được log `OUT-OF-SCOPE BASELINE`; nó không biến step
    `editing-experience-runtime` đã PASS thành fail và không được tuyên bố là Giai đoạn 4 đã hoàn tất.
  - Ghi lại `source-identity.mjs` trước full smoke và so với 11.5d; khác digest ⇒ rebuild rồi chạy lại
    step riêng trước khi full smoke. Exact failure/result phải vào Execution Log, không chỉ link run.
  - _Requirements: all_ — _Design: §11, §17_
- [ ] 11.6 Council closeout và chuyển trạng thái spec
  - SM: mọi task/AC/matrix/evidence hoàn tất, không còn `[/]`/`[!]` chưa giải quyết; Execution Log và `implementation-notes.html` đồng bộ.
  - PO: kiểm UX/failure state/undo scope từng R1–R12; Dev: review boundary, persistence, artifact, security và diff ngoài scope.
  - Chỉ sau đó discover bằng `rg -l "spec-editing-experience-"'inprocess' --glob '!node_modules/**' --glob '!dist/**'`,
    đổi main spec `inprocess` → `complete`, sửa mọi kết quả và kiểm cùng lệnh trả rỗng; không tự push/PR.
  - _Requirements: process closeout_ — _Design: §14–§15 · spec-rule workflow_

**Acceptance Criteria**:
- [ ] R4.1c có số đo thật, không phải suy ra từ spike
- [ ] MCP và HTTP không có schema trùng lặp định nghĩa hai nơi
- [ ] Packaged artifact boot được DB migration, đọc bundled catalog, chạy MCP catalogue và không dựa vào source tree

**Deliverables Created / Modified**: (điền test/artifact/agent-kit/spec closeout, exact-source-identity gate evidence khi thực thi)

---

## Files Changed Summary

(điền trong lúc thực thi — mỗi phase ghi vào mục **Deliverables** của phase đó)

## Validation Commands and Evidence Policy

| Gate | Khi chạy | Lệnh/evidence tối thiểu | Quy tắc PASS |
|---|---|---|---|
| Focused unit | Mỗi task domain/UI pure | `bunx vitest run <exact-test-file>` | Test mới + hồi quy gần nhất xanh; ghi exact file |
| Core persistence | P0, P3, P5, P8, P9 | Focused integration với SQLite file thật + temp fs thật | Có failure injection/rollback/restart; không mock `node:fs` |
| Contract/boundary | Cuối phase có API/MCP | `bun run typecheck`; `bun run test:boundaries`; focused contract test | Không schema copy, không import ngược Core → Server/Adapter |
| Browser | P1–P4, P6–P10 | `bun run test:browser-session` | Test feature nằm trong script/workflow; Chrome skip không phải PASS khi evidence bắt buộc |
| Artifact — staging | P0 (migration), P8 (catalog bundled) | focused `stage-artifact-runtime`/runtime-manifest/boot tests với fixture thật | Staged tree có file đúng digest, không fallback source tree; chưa cần exact-host SEA runtime input |
| Artifact — Editing step | **P11 bắt buộc** | strict `--step editing-experience-runtime` với `VIDCOM_SMOKE_NETWORK_CUT=1` trên runner có quyền, hoặc cùng step trong workflow exact-identity | Private PATH + network cut; boot migration, bundled catalog, MCP catalogue; không đọc source tree |
| Artifact — full regression | P11 sau step riêng | full strict packaged smoke | Failure mới chặn spec. Chỉ failure khớp baseline S0 và đúng AC production-release còn mở của Giai đoạn 4 được ghi `OUT-OF-SCOPE BASELINE`; không được gọi PASS hay dùng spec này để đóng nợ Packaging |
| Full local | P11 | Tất cả lệnh ở task 11.5b–11.5e | Cùng exact source identity; worktree sạch thì identity đó ánh xạ đúng HEAD; không lấy run cũ thay thế |
| Remote CI | Khi có PR/workflow | URL run + SHA + matrix result | Chỉ evidence bổ sung; mọi required job ở cùng exact HEAD |

Nếu một lệnh không chạy được, ghi `NOT EXECUTED` hoặc `[!]` cùng nguyên nhân và tiếp tục task độc lập;
không đổi thành PASS từ suy luận, artifact cũ hoặc test gần giống.

## Requirements Coverage Matrix

> Design §17 là traceability chi tiết từng AC. Bảng này thêm **task thực thi + evidence đóng gate**;
> mọi range dưới đây bao phủ toàn bộ AC, kể cả hậu tố `b/c/d/e`.

| Requirement / AC | Implementation task | Test/evidence đóng gate |
|---|---|---|
| R1.1–1.5 | 1.2–1.3 | reducer + browser body/edge/Esc; request counter = 1/0 |
| R1.6–1.7, 1.13 | 1.1 | unit snap ở hai cận zoom, fps rounding, clip 20 px |
| R1.8–1.11 | 1.2–1.3 | unit ripple + browser extend/cap/hash-conflict |
| R1.12 | 1.4 | browser form timing vẫn ghi qua cùng use case |
| R2.1–2.4 | 2.1–2.4 | planner gap/compact + browser indicator + one mutation |
| R2.5–2.9 | 2.1–2.5b | Core invariant/group + cross-track/error/no-op/numbering |
| R2.10–2.12 | 2.4–2.5b | browser keyboard focus/announcement/boundary no-op |
| R3.1–1c | 0.1–0.6b, 3.1a–3.2 | one receipt/one inverse; created/replaced files + backup |
| R3.2–3.4 | 3.2–3.3 | real-fs undo/redo/branch-cut integration |
| R3.5–5b | 0.3a–0.4, 3.1a–3.4 | external/two-session ownership + typed dependency barrier; sync precondition block; two escape paths |
| R3.6–3.9 | 3.1a–3.6d | WriteAuthority audit; empty/reload/50-entry browser+unit |
| R4.1–1b, 2–4, 6 | 4.1–4.6b | PlayerHost identity, health reject, transport/clamp/last-frame probes |
| R4.1c | 11.1 | four response/SSE → first-new-frame measurements <500 ms |
| R4.5, R4.7 | 4.2, 4.4–4.6b, 11.1 | same URL/no-store; settings + external SSE through buffer |
| R5.1–3 | 0.5a–0.5c, 5.3, 5.5–5.7c | containment; tree 200 files; destructive grant/backup/rollback |
| R5.4–4g | 0.6a–0.6b, 5.1–5.2c, 5.5–5.7c | stream limits/magic/SVG/name/collision/RSS/cancel/probe |
| R5.5–5b | 5.5–5.7c | XHR raw-File progress + abort qua listener HTTP/1.1, server AbortSignal cleanup |
| R5.6–7 | 5.2a–5.2c, 5.4–5.7c | metadata/font real adapter; unknown reason/probe failure |
| R5.8–9 | 5.1, 5.6–5.7c | allowlist unit + typed empty/failure UI |
| R6.1–5 | 6.1–6.2 | planner thresholds/rebase/scene bounds + one mutation |
| R6.6–10 | 6.2–6.4 | per-word absolute markup + rational-fps runtime browser |
| R6.11–13 | 6.2, 6.5 | stale persisted; no auto-TTS; missing narration 422 |
| R6.14 | 6.6a–6.6b, 11.2, 11.4 | real preview/render three-frame parity + project fps |
| R7.1–2 | 8.1a–8.1b, 8.5 | required kind, template filter/search UI |
| R7.3–5 | 8.4a–8.6e | template new-scene path + atomic undo/provenance |
| R7.6–7 | 8.2a–8.2c, 8.5–8.6e | bundled offline empty/failure UX + packaged smoke |
| R8.1–2 | 10.1–10.3, 10.6a–10.6b | all close/navigation/SSE conflict paths incl compare |
| R8.3 | 10.4, 10.6a–10.6b | adjacent-frame unit across supported fps |
| R8.4–6 | 10.5–10.6b | shared binding table + browser input/modifier checks |
| R9.1–4c | 8.1a–8.1b, 8.4a–8.5 | kind-aware catalog, mount target, visible selection |
| R9.5–5d | 8.2a–8.4c, 8.6a–8.6e | source allowlist, canonical digest, reinstall matrix |
| R9.6–8 | 8.2a–8.2c, 8.4a–8.4c, 8.6a–8.6e | no overwrite, offline/SWR, failure-injection rollback |
| R9.9 | 3.2, 8.6b | undo deletes created/restores replaced/leaves untouched |
| R10.1–4 | 7.2a–7.4 | sampling formula/center/zoom density/stable placeholder |
| R10.5 | 7.2a–7.5b | viewport abort kills process and leaves no cache partial |
| R10.6–7 | 0.4, 7.1a–7.2c, 7.5a–7.5b | dependency fingerprint, selective invalidation, cache hit |
| R10.8–9 | 7.3–7.5b | reason placeholder + per-cell viewport±1 browser evidence |
| R11.1–3b | 0.7–0.10e, 5.2a–5.2c, 9.1–9.5c | one/two mutation boundaries; persistent retry/restart |
| R11.4–6b | 9.1, 9.5a–9.5c | real duration/unknown/4s/shrink-vs-extend cases |
| R11.7–9 | 3.2, 9.3–9.5c | select/scroll, undo keeps asset, missing-source UI |
| R12.1–3 | 2.4–2.5b | shift same/cross track, mod toggle, marquee browser |
| R12.4–4e | 1.1, 2.1–2.5b | anchor snap, no ripple, all-or-nothing/root/cap/no reorder |
| R12.5–8 | 2.2–2.5b, 3.1a | destructive group delete, one undo, count/Esc, track preserved |
| steering D1 — MCP parity | 11.3a–11.3d | shared schema + same Core use case; legacy/modern contract, grant policy, agent-kit và packaged catalogue |

## Deferred Items Reference (Giai đoạn 6)

D1 undo cho thao tác filesystem · D2 trim/in-out/re-speed clip media · D3 preview block trước khi cài
(RG-3) · D4 sort "Popular"/Favorites · D5 sửa keyframe/tween trên timeline · D6 safe margin/style
caption · D7 tool MCP undo/redo · **D8 PR-11 hot-reload từng sub-composition** (chuyển từ R4.1a bản 5) ·
**D9 MCP blob/resource transfer + parity upload/tree CRUD/apply-font R5** (không nhận absolute path).

## Execution Log

> Mỗi task xong ghi một dòng. Link chi tiết quyết định/gotcha sang `implementation-notes.html`.

| Date/time | Task | Files/deliverables | Commands/evidence | Result | Design drift / blocker | Next ready |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | S0.1 sau khi gate được duyệt |
| 2026-08-17 21:39 +07 | S0.1–S0.4 evidence reconciliation | Main spec `-inprocess.md`; checklist; notes | Approval Gate `Approved`; `-inprocess.md` tồn tại, `-pending.md` không tồn tại và Markdown search tên cũ rỗng; notes ghi baseline `HEAD=8c55b81`, typecheck PASS, write-authority 26/26 PASS; rerun tại `57f602f`: typecheck PASS, write-authority 26/26 PASS | `PASS` | Main spec còn dòng checklist Pending; đồng bộ trạng thái Approved trước khi đóng S0 | S0.5 |
| 2026-08-17 21:37 +07 | S0.5 checkpoint | `llm-documents/steering/{03-architecture-ddd,04-api-design,05-mcp-tool-design,10-testing}.md`; checklist; notes | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; worktree clean; planned `bun run test:spec-paths` + steering drift search + Markdown link check | `IN PROGRESS` | Test-fail step N/A: authority-only documentation sync already ratified by Approval Gate | Resume S0.5 |
| 2026-08-17 21:39 +07 | S0.5 | Steering 03/04/05/10; checklist; notes | Scoped drift search PASS; `git diff --check` PASS; `bun run test:spec-paths` PASS 115/115; typo `origin.kind:"studio"` corrected to Design-authoritative `"ui"` | `PASS` | Steering 13 vẫn có wording legacy và thuộc read-first/gate của P11.3a; không dùng nó để giả PASS ngoài scope S0 | Close S0 |
| 2026-08-17 21:39 +07 | Phase S0 gate | Main spec; steering 03/04/05/10; checklist; notes | All S0 tasks + AC `[x]`; typecheck PASS; write-authority 26/26 PASS under `environment: node`; spec-paths 115/115 PASS; state/link/diff checks PASS | `PASS` | Không có blocker; chưa sửa production code | P0.0/P0.1 theo thứ tự task |
| 2026-08-17 21:45 +07 | 0.1 checkpoint | `packages/core/src/port/mutation-observer.ts`; Core/Adapter barrels; `packages/adapter/src/fs/large-content-store.ts`; focused test | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty chỉ gồm S0 docs/steering của goal này; planned `bun x vitest run tests/adapter/large-content-store.test.ts` | `IN PROGRESS` | Không có blocker; CodeGraph + full P0 read-first + always-on steering đã đọc | Resume 0.1 |
| 2026-08-17 21:47 +07 | 0.1 | Core mutation observer/content-ref contract; streaming object retention + live lease; focused test | Red: 3 fail/1 pass do thiếu `retainBytes`/`retainFile`; green: focused store+journal 17/17; typecheck PASS; scoped lint PASS; boundaries PASS; full `bun run test` 222 files pass + 1 intentional skip, 2077 pass + 5 intentional skip | `PASS` | Không có SQLite history row; object source no-follow + regular-file/hash/state verify; cleanup hợp nhất durable refs với live refs | 0.2a |
| 2026-08-17 21:50 +07 | 0.2a checkpoint | `MutationOrigin` propagation qua CompositeRequest/WriteInvocation; browser bridge; MCP/CLI/system callers; focused test | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty chỉ thay đổi goal S0 + 0.1; planned `bun x vitest run tests/core/mutation-origin.test.ts` rồi typecheck toàn monorepo | `IN PROGRESS` | Không có blocker; actor mapping giữ source đúng cho wrapper single-write trong P0 | Resume 0.2a |
| 2026-08-17 21:58 +07 | 0.2a | `CompositeRequest.origin`; `WriteInvocation.origin`; Core actor mapper; MCP registry; P0 browser bridge + route call sites; focused/HTTP regressions | Red: focused origin test 1 fail vì mapper chưa tồn tại; compile catch liệt kê mọi caller thiếu origin. Green: typecheck PASS; mutation/authority/usecase/adapter/CLI/MCP focused 175/175; HTTP project/delivery/narration cùng authority set 141/141; lint PASS với 5 warning pre-existing ngoài scope; boundaries + `git diff --check` PASS | `PASS` | Production chỉ có hai điểm tạo ignore origin: Core mapper cho non-browser/default và `UNTRACKED_UI_ORIGIN` bridge có tên; P3.3 phải xoá bridge | 0.2b |
| 2026-08-17 21:59 +07 | 0.2b checkpoint | Typed internal `historyReadGuards`; canonical dedupe; mutex precondition; grant observed hashes; transport exclusion; focused test | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty chỉ thay đổi goal S0 + P0.1 + P0.2a; planned `bun x vitest run tests/core/history-read-guards.test.ts tests/core/write-authority.test.ts` rồi typecheck/boundaries | `IN PROGRESS` | Không có blocker; P0 read-first và Design §5.5 đã đọc full | Resume 0.2b |
| 2026-08-17 22:03 +07 | 0.2b | `CompositeRequest.historyReadGuards`; WriteAuthority canonical resolve/dedupe/overlap + file/directory precondition; grant binding; strict transport regression | Red: real SQLite/temp-fs focused 2 fail vì stale/conflicting guard vẫn ghi. Green: guard/authority/transport focused 47/47; typecheck, lint (0 error; 5 warning pre-existing), boundaries, `git diff --check` PASS | `PASS` | Guard kiểm dưới project mutex trước T1/capture/publish; mismatch zero journal/write; chỉ file hash nhập `observedHashes`, directory giữ typed state | 0.3a |
| 2026-08-17 22:04 +07 | 0.3a checkpoint | Retain before/after refs sau capture trước publish; 64 KiB/item + 256 KiB total inline; staged streaming; history reservation claim/abort | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty chỉ thay đổi goal S0 + P0.1–0.2b; planned focused `tests/core/write-authority-history.test.ts` + real store/authority regression, rồi typecheck/boundaries | `IN PROGRESS` | Không có blocker; task 0.3b sở hữu emit/ownership transfer, 0.3c sở hữu recovery receipt | Resume 0.3a |
| 2026-08-17 22:11 +07 | 0.3a | WriteAuthority retention + reservation lifecycle; bounded fake content port; real content store/composite regressions | Red: claim/publish fault test trả `recovery_required` khi injector vô tình chặn cả rollback; seam được thu hẹp đúng publish-only rồi green. Focused authority/scene/real-store 63/63; typecheck, lint 0 error, boundaries, diff-check PASS | `PASS` | Inline ≤64 KiB/ref và ≤256 KiB/mutation; large before dùng rollback file; retain/claim fail zero publish; rollback abort claim, ambiguous invalidate | 0.3b |
| 2026-08-17 22:12 +07 | 0.3b checkpoint | Post-commit receipt ordering; entity undoable authority; emit reject/throw ownership; transport exclusion | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty chỉ goal S0 + P0.1–0.3a; planned receipt shape/order/ownership focused tests + typecheck/boundaries | `IN PROGRESS` | Emit seam đã được đặt để settle 0.3a; còn audit entity policy, strict transport và duplicate ownership contract | Resume 0.3b |
| 2026-08-17 22:13 +07 | 0.3b | Stable `journal:<id>` receipt; post-commit/pre-discard emit; entity Core policy; ref transfer/reject cleanup; strict transport | Focused receipt/authority/entity/transport + real store 67/67; typecheck PASS; prior lint/boundaries/diff gate PASS and no production lint delta | `PASS` | Observer success nhận ownership; reject/throw release + warning + invalidate. Duplicate-ID release thuộc implementation `MutationHistory` P3.1c theo checklist, port/EmitResult đã giữ contract | 0.3c |
| 2026-08-17 22:14 +07 | 0.3c checkpoint | Same-process reconciled-commit receipt; startup reconcile system/ignore receipt; stable id/paths/steps; no session persistence | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.3b; planned reconciliation/startup focused tests + typecheck/boundaries | `IN PROGRESS` | Không persist origin/session secret; startup receipt phải dựng từ durable journal steps | Resume 0.3c |
| 2026-08-17 22:15 +07 | 0.3c | Same-process WriteAuthority reconcile delivery; Core startup reconciliation recovery receipt; startup clock seam | Same-process + real SQLite/temp-fs startup focused 42/42; broader P0 receipt/recovery 77/77; typecheck, lint 0 error, boundaries, diff-check PASS | `PASS` | Same-process giữ origin/reservation gốc; startup dựng `system/ignore`, readGuards rỗng, non-undoable, không persist/resurrect session | 0.4 |
| 2026-08-17 22:16 +07 | 0.4 checkpoint | Redacted composite event paths/source; ProjectPathInvalidator fan-out; envelope changeSeq; latestProjectSeq; watcher integration | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.3c; planned journal/outbox + authority/watcher focused tests, typecheck/boundaries | `IN PROGRESS` | Không có blocker; source event chỉ origin.kind, cấm session/label/history/readGuards | Resume 0.4 |
| 2026-08-17 22:23 +07 | 0.4 | Composite outbox payload; `ProjectPathInvalidator` + isolated fan-out; watcher port; exact `WriteEnvelope.changeSeq`; project-local outbox max | Red/compile: missing fan-out import, invalid test origin/history operation và branded path bị typecheck bắt; direct `bun test` bị loại vì Bun runner không có `node:sqlite`. Green dùng runner chuẩn: typecheck PASS; Vitest/Node focused 4 files/65 tests PASS; lint 0 error (5 warning pre-existing), boundaries và `git diff --check` PASS | `PASS` | Event persist exact `paths/source` không có session/label/history/readGuards; entity recovery dùng backing path. Fan-out dùng chung cho WriteAuthority/watcher, ProjectCache đứng đầu; consumer/observability throw không đổi mutation hoặc chặn consumer sau | 0.5a |
| 2026-08-17 22:24 +07 | 0.5a checkpoint | `CompositeStep` mkdir/rmdir; typed directory capture; snapshot + planned-delete validation; collision/read-guard cases | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty chỉ thay đổi goal S0 + P0.1–0.4; planned focused contract/authority tests under Vitest Node, then typecheck/boundaries | `IN PROGRESS` | 0.5a chỉ mở contract, validate và capture; publish/rollback/journal/reconcile thuộc 0.5b, tracker/watcher terminal-state thuộc 0.5c | Resume 0.5a |
| 2026-08-17 22:30 +07 | 0.5a | Composite directory contracts; no-follow stat/direct-entry snapshot port; typed state-only capture; Core precondition planner + generated guard | Red: 2/2 directory-capture tests fail vì adapter rename directory rồi `readFile`/so object như hash. Green: typecheck PASS; focused Core/real-fs 4 files/70 tests PASS; lint 0 error (5 warning pre-existing), boundaries và diff-check PASS | `PASS` | `mkdir absent` chặn mọi collision; `either` chỉ no-op với directory và sinh directory guard; file/symlink conflict. `rmdir` chỉ nhận direct entries có delete/rmdir đúng loại đứng trước. Publish/rollback/journal vẫn thuộc 0.5b | 0.5b |
| 2026-08-17 22:30 +07 | 0.5b checkpoint | Directory publish/rollback; durable kind+existedBefore; recovery classification; ordering/race tests | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.5a; planned real SQLite/temp-fs composite directory test đỏ, focused recovery/journal, then typecheck/boundaries | `IN PROGRESS` | Không có recursive mkdir/overwrite; mkdir nông-trước, delete trước rmdir, rmdir sâu-trước; 0.5c mới thay tracker state | Resume 0.5b |
| 2026-08-17 22:45 +07 | 0.5b | Non-recursive directory publish/restore; rollback outside removed tree; durable `existed_before`; generated migration + packaged manifest; recovery/order/race tests | Red: real SQLite/temp-fs directory composite fail trước publish/journal support. Green: typecheck PASS; focused 8 files/97 tests PASS; `db:generate` created `20260817153223_small_power_pack`; schema-drift PASS 28 artifacts; lint 0 error, boundaries, diff-check PASS | `PASS` | mkdir shallow-first; every descendant delete/rmdir precedes parent rmdir. External mkdir/non-empty rmdir preserved. Rollback slots for files under removed trees live outside outermost rmdir; commit/abort cleanup never fsyncs deleted parent | 0.5c |
| 2026-08-17 22:45 +07 | 0.5c checkpoint | Terminal state tracker `file|directory|absent`; journal settle wait; canonical watcher resolution; external invalidator + history barrier | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.5b; planned watcher/tracker test đỏ, real fs events + fault isolation, typecheck/boundaries | `IN PROGRESS` | Own echo chỉ suppress khi state terminal khớp; mismatch/unknown đi external. Không dùng raw filename để hash/event/barrier trước resolver containment | Resume 0.5c |
| 2026-08-17 22:56 +07 | 0.5c | Journal-correlated state tracker; settle/resample loop; contained watcher path; external invalidator/history barrier; composite production wiring | Red: tracker contract fail `tracker.arm is not a function`; real watcher external file/directory tests fail vì canonical capability `/private/var/...` bị so với aliased ref root `/var/...`. Green: typecheck PASS; focused 6 files/92 tests PASS; lint 0 error/5 baseline warnings; boundaries và diff-check PASS | `PASS` | Candidate chỉ thành `RelPath` sau resolver syntax/purpose/symlink containment; filesystem read dùng `ResolvedPath`. Watcher chờ mọi mutation mới phát sinh trong lúc sample rồi đọc lại; commit chọn after, rollback before, unknown/mismatch external. Composite dùng arm/settle, không để lại legacy hash record trùng | 0.6a |
| 2026-08-17 22:57 +07 | 0.6a checkpoint | `write-staged` authored-only contract; Core-owned undoable; opaque staged source; no-overwrite create và atomic replace dưới capture | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty chỉ goal S0 + P0.1–0.5c; planned contract red test, real staged publish/security cases, focused Core/Adapter, then typecheck/lint/boundaries | `IN PROGRESS` | Route/MCP không nhận source path hay role; parent phải có sẵn hoặc được tạo bằng step mkdir đứng trước. 0.6b mới chuyển toàn bộ hậu kiểm/cleanup sang streaming | Resume 0.6a |
| 2026-08-17 23:06 +07 | 0.6a | Authored-only `write-staged`; Core-owned undoable/create-replace policy; existing-or-journaled parent; staged no-overwrite/EXDEV local-temp publish | Red: `write-staged` bị rơi thành delete intent, trả success nhưng `fileHashes:{}` và không tạo target. Green: typecheck PASS; focused 6 files/92 tests PASS; lint 0 error/5 baseline warnings; boundaries và diff-check PASS | `PASS` | Upload `undoable:false` chỉ create; `undoable:true` create/replace. Ordinary authored `write` vẫn cấm staged source. Route/MCP không có schema `sourcePath`. Existing replace pre-image còn dùng bytes contract cũ; chuyển sang file/object stream đúng scope 0.6b | 0.6b |
| 2026-08-17 23:07 +07 | 0.6b checkpoint | Stream hash/read/cleanup for WorkspaceFs, staged target, watcher and LargePreviousContentStore; no-follow regular-file state | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.6a; planned readFile-forbidden red tests, large-file/ref lifecycle focused suite, typecheck/lint/boundaries | `IN PROGRESS` | Directory notification phải kết thúc như state, không retry. Streaming pre-image phải vẫn giữ journal capture invariant/recovery; không sửa AC hay hạ hash verification | Resume 0.6b |
| 2026-08-17 23:11 +07 | 0.6b | Chunked no-follow hash for WorkspaceFs/watcher, staged cleanup/recovery, mutation capture; verified object-store open/read | Red: `WorkspaceFs.readHash` follow symlink và staged cleanup follow raced target symlink rồi resolve thành công. Green: typecheck PASS; focused 7 files/63 tests PASS; targeted `readFile` search không còn match; lint 0 error/5 baseline warnings; boundaries và diff-check PASS | `PASS` | Buffer cố định 1 MiB; mọi hash target đòi regular file. Directory/absent là terminal watcher state. `LargePreviousContentStore.open` trả staged capability đã verify; legacy `read` verify trong cùng chunked pass. Existing replace T1 vẫn giữ durable pre-image theo journal invariant | 0.7 |
| 2026-08-17 23:12 +07 | 0.7 checkpoint | Durable `PendingMountTransition` contract at beginComposite; open/close/reopen validation; commit/reconcile atomic apply | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.6b; planned pure contract red test + journal transaction seam tests, then focused persistence/recovery/typecheck | `IN PROGRESS` | 0.7 mở contract/logic; 0.8 mới generate schema/migration. operationId luôn top-level; close failure đọc server row, reopen chỉ history inverse | Resume 0.7 |
| 2026-08-17 23:16 +07 | 0.7 | Pending mount models/query port; Core open/close/reopen binding under mutex; T1 journal parameter; close receipt revision | Red contract compile: hydrated `PendingCompositeMutation` thiếu required transition field. Green: typecheck PASS; focused 3 files/66 tests PASS; lint 0 error/5 baseline warnings after removing one new unused import; boundaries và diff-check PASS | `PASS` | Open khớp exact write-staged path/hash/project/fingerprint và ULID; close recheck uploaded row + previousFailure; reopen chỉ matching undo inverse. Adapter SQL persistence/apply và generated migration không nhận vơ ở đây: exact scope 0.8 | 0.8 |
| 2026-08-17 23:17 +07 | 0.8 checkpoint | Drizzle `pending_mount` + journal transition column/index; transactional apply; migration/manifest/boot validation | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.7; planned real SQLite red persistence test, schema edit, `bun run db:generate`, schema-drift/manifest/double-boot | `IN PROGRESS` | Không viết migration SQL tay, không đổi workspace_operation. Migration phải giữ row/FK cũ và operation open history lookup sau retention | Resume 0.8 |
| 2026-08-17 23:27 +07 | 0.8 | Generated pending-mount migration, durable journal transition/apply, SQLite query/status store, packaged migration allowlist | Red: composite journal 12/13 failed because `mutation_journal` had no `pending_transition`. Green: `bun run db:generate` created `20260817162114_solid_daredevil`; focused adapter/manifest 22/22 PASS; migration boot twice + row/FK/CHECK/JSON PASS; open/close/reopen + expired/never-seen PASS; schema-drift PASS; typecheck PASS; boundaries PASS; artifact provenance+staging 62/62 PASS; lint 0 error/5 baseline warnings; diff-check PASS | `PASS` | First artifact test exposed missing product allowlist for both generated P0 migrations; added exact reviewed paths and reran green. One mistyped `bun run boundaries` reported `Script not found`; corrected authoritative command `bun run test:boundaries` PASS. No hand-written migration SQL, no workspace_operation change | 0.9 |
| 2026-08-17 23:29 +07 | 0.9 checkpoint | Shared editing contracts/error statuses; named noop observer seam; production pending store + observer/reconcile wiring | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.8; planned contract/error-map red tests and composition-root wiring assertion, then typecheck/focused CLI-server-core gates | `IN PROGRESS` | Error enum already has TooLarge/UnsupportedMedia but lacks InvariantViolated/IntegrityMismatch; PreconditionRequired is wrongly 409. Startup sequence already orders reconciliation before listener; production application currently omits pendingMount and observer from WriteAuthority/reconcile | Resume 0.9 |
| 2026-08-17 23:35 +07 | 0.9 | Shared strict editing/pending schemas; error mapping; named noop observer; pending/content/observer production wiring and startup reconcile | Red: editing schemas undefined, error vocabulary missing 2 codes, PreconditionRequired returned 409 (3/16 failed). Green: focused contract/server/core/CLI 61/61 PASS; MCP catalogue 2/2; full MCP contract + stdio E2E 86/86; typecheck/boundaries/spec-paths/diff-check PASS; lint 0 error/5 baseline warnings | `PASS` | Full MCP gate exposed strict WriteEnvelope finalization missing `changeSeq`: first delete_file, then all projected single writes once schema became strict. Propagated exact composite token through WriteResult/project-writes and made MCP envelope require number|null; no committed write is misreported as failure. Startup remains migration→lease→reconcile→listener and now passes same named observer | 0.10a |
| 2026-08-17 23:37 +07 | 0.10a checkpoint | Pure P0 contract/unit coverage delta, especially receipt memory ceilings | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.9; planned node-only red tests for 1,024-step receipt and 50-receipt cumulative inline bound, then focused core/contracts/error gates | `IN PROGRESS` | Existing unit tests already cover ref ownership/release, staged create-vs-replace/undoable/opaque source, mkdir absent/either file+symlink collision/read guard, rmdir snapshot/order, both directory race directions and error map. Không duplicate; chỉ thêm quota delta và chạy aggregate evidence | Resume 0.10a |
| 2026-08-17 23:41 +07 | 0.10a | Pure P0 receipt/content ownership, quota, directory/staged guards and shared error mapping | Red: origin `historyAction=ignore` vẫn retain 2 inline refs; post-capture mkdir race test ban đầu đòi `WriteConflict` nhưng invariant đúng là `RecoveryRequired`. Green: focused core 43/43; aggregate unit/contracts/error 75/75; MCP contract + stdio 89/89; typecheck/boundaries/spec-paths/diff-check PASS; lint 0 error/5 baseline warnings | `PASS` | History-disabled writes không retain/ref-transfer và receipt không undoable. 1,024 file nhỏ giữ inline receipt dưới 256 KiB; 50 receipt dưới 12.5 MiB. External post-capture mkdir được giữ nguyên và escalates vì không chứng minh ownership; non-empty rmdir race giữ file ngoài và trả conflict. Không đổi production race semantics để chiều fake | 0.10b |
| 2026-08-17 23:42 +07 | 0.10b checkpoint | P0 persistence/wiring integration: real SQLite file + real temporary filesystem | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.10a; planned node-only red tests for post-discard receipt resolution, observer throw/reject non-fatal release/invalidate, migration reboot, and composition-root port identity | `IN PROGRESS` | Resume existing integration coverage first; add only missing AC evidence. No UI/browser scope in this task | Resume 0.10b |
| 2026-08-17 23:44 +07 | 0.10b | Real SQLite/file-FS receipt persistence, observer failure lifecycle, migration reboot and composition-root identity | `RED N/A`: implementation từ 0.4–0.9 đã đạt AC, integration mới PASS ngay; không tạo lỗi giả/không rewrite code đã đạt AC. Green: focused aggregate 42/42; typecheck/boundaries/spec-paths/diff-check PASS; lint 0 error/5 baseline warnings | `PASS` | Sau capture discard, cả before/after object refs resolve đúng bytes/hash. Observer throw và explicit reject vẫn commit `ok`, warning `history-unavailable`, invalidate 1 lần; released lease cho phép cleanup object receipt-only nhưng giữ object durable từ SQLite. Composition root nối đúng cùng journal cho single/composite và exact pending/content/observer instances; real DB reboot idempotent giữ PASS | 0.10c |
| 2026-08-17 23:45 +07 | 0.10c checkpoint | P0 staged-write, watcher suppression/external barrier and invalidator integration | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.10b; planned node-only inventory then red integration for missing staged source/EXDEV/target race, watcher own-vs-external directory semantics, segment-safe parent barriers and fanout failure isolation | `IN PROGRESS` | Read P0 Read-first remains authoritative; use real temp filesystem/watcher where AC requires it and keep all timing/cue logic out of scope | Resume 0.10c |
| 2026-08-17 23:50 +07 | 0.10c | Guarded staged streaming, EXDEV no-overwrite, real watcher canonical barriers and invalidator isolation | Red: staged suite 3/4 failed—source identity mutation accepted, injected EXDEV seam unused, fallback target race not exercised. First green introduced FileHandle pipeline timeout in 2 existing staged-authority tests; replaced with explicit 1 MiB positional loop. Green: staged 5/5 incl 250 MiB RSS `<64 MiB`; focused authority/stager 31/31; aggregate P0 FS/watcher 58/58; rerun core set 38/38; typecheck/boundaries/spec-paths/diff-check PASS; lint 0 error/5 baseline warnings | `PASS` | Source now compares dev/ino/size/mtime/ctime before/after copy and closes handles deterministically. Injectable filesystem operations make EXDEV/race proof portable without mocking `node:fs`; fallback still link no-overwrite. Watcher hashes via readHash (readFile throws in test), suppresses own file/delete/mkdir/rmdir, emits exact external file/dir/delete and parent rename paths, rejects invalid filenames, keeps `assets/a` distinct from `assets/ab`; invalidator failure preserves cache-first/later consumer/one revision+event | 0.10d |
| 2026-08-17 23:51 +07 | 0.10d checkpoint | P0 250 MiB object/receipt memory and reference lifecycle | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.10c; planned node-only red lifecycle tests for 50 object receipts without heap growth, evict/clear/duplicate recovery exact release, and startup cleanup protection for durable journal plus live-history leases | `IN PROGRESS` | Reuse 250 MiB streaming harness from 0.10c; measure isolated process memory where aggregate Vitest RSS is not authoritative | Resume 0.10d |
| 2026-08-17 23:53 +07 | 0.10d | P0 object streaming, 50-lease ref-count lifecycle and safe compaction | `RED N/A`: P0 storage implementation already met the new lifecycle tests; no production rewrite. Green: large/store/journal/staged/core aggregate 68/68; 250 MiB staged/object streaming PASS, 50 shared object leases heap delta `<32 MiB`; typecheck/boundaries/spec-paths/diff-check PASS; lint 0 error/5 baseline warnings | `PASS` | Partial “evict” release keeps shared object; final “clear” release removes exactly large+shared objects; duplicate lease release once does not delete original. `journal.listPreviousObjectHashes()` protects durable SQLite refs and store live lease set protects in-process refs during cleanup. Per Design §5.6, production item-51/clear/duplicate-receipt owner is `MutationHistory` P3.1c/3.6a and remains unclaimed/unclosed there; P0 only proves the port/storage contract | 0.10e |
| 2026-08-17 23:54 +07 | 0.10e checkpoint | P0 capture→publish→commit→discard failure injection and tracker settlement races | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + P0.1–0.10d; planned node-only inventory then red tests at missing failure boundaries, post-publish/pre-commit reconciliation receipt/pending-mount outcome, and watcher sampling before settlement for committed/rolled-back/unknown/mismatch | `IN PROGRESS` | Preserve exact journal id and avoid fake duplicate write/rollback evidence; real SQLite/temp FS where persistence matters | Resume 0.10e |
| 2026-08-17 23:57 +07 | 0.10e | Capture→publish→commit→discard injection, post-publish recovery and watcher settlement matrix | Red: discard failure after committed T2 returned `RecoveryRequired` because cleanup shared commit try/catch. Green: core 44/44; real staged pending-open T2 trigger reconciles `journal:1` without mtime/write change and creates `uploaded_unmounted`; recovery/tracker aggregate 105/105; typecheck/boundaries/spec-paths/diff-check PASS; lint 0 error/5 baseline warnings | `PASS` | Added post-terminal best-effort discard: cleanup failure returns `ok` + `capture-cleanup-unavailable`, exact one receipt/revision/write, zero reconcile call. Existing real injection covers capture/publish/T2a/T2b/T2c and external race; tracker waits before settle, suppresses matching committed/rolled-back state, and routes unknown/mismatch external | P0 phase gate |
| 2026-08-17 23:58 +07 | P0 phase-gate checkpoint | Full regression + all P0 AC + CI workflow matrix/artifacts | Baseline `HEAD=57f602f57cefda11a505240a87da641475a00a90`; dirty goal S0 + completed P0.1–0.10e; planned `bun run test`, required build/runtime/schema/golden/MCP gates, then dispatch workflow `CI` on `feat-editor` with `GH_TOKEN` loaded from `GH_KEY` without printing secret | `IN PROGRESS` | No P3 work until every P0 AC is evidenced and CI is green; CI failure is repaired before advancing | Resume P0 phase gate |
| 2026-08-18 00:01 +07 | P0 local phase gate + CI source identity | Full local regression and exact remote-ref eligibility | First full run: 5 stale expectations failed (migration 13→15, PreconditionRequired 409→400, delete changeSeq, 2 tools/list goldens). Fixed and targeted 18/18 PASS. Second full run PASS 225 files/2,135 tests; 1 file/5 VieNeu-real tests conditionally skipped. Explicit MCP 90/90, golden 45/45, typecheck/lint(0 error/5 baseline warning)/boundaries/schema-drift/spec-paths/build/runtime-smoke PASS | `IN PROGRESS` | Remote `refs/heads/feat-editor=57f602f57cefda11a505240a87da641475a00a90`, equal baseline HEAD and excludes all dirty P0 changes. `CI` workflow_dispatch has no patch input; dispatch now would be stale evidence. No commit/push performed without explicit authority. P0 AC/Deliverables remain unchecked until exact-source CI 3 OS + artifacts PASS | Await commit/push authority, then dispatch `CI` |
| 2026-08-18 00:03 +07 | P0 pre-push scope audit | Exact checkpoint contents and credential hygiene | 83 tracked modifications + 13 untracked files; untracked set is 4 generated migration artifacts plus 9 P0 source/tests. No binary, symlink or mode change; `git diff --check` PASS. Credential-pattern scan found only literal variable names in checklist, no secret value; `.env` is excluded | `READY, NOT PUSHED` | Diff size 5,117 insertions/303 deletions reflects approved S0 steering/spec logs + P0 contract/core/adapter/wiring/tests/goldens. No stage/commit/push performed. Proposed checkpoint scope is the complete current worktree, because splitting would make migrations/contracts/call sites fail compile or stale the exact-source evidence | Await explicit commit/push authority |
| 2026-08-18 00:04 +07 | P0 exact-source CI authorization gate | Third consecutive goal turn at the same external-state boundary | Re-read worktree, Execution Log and notes. Local `HEAD` and remote `refs/heads/feat-editor` are both `57f602f57cefda11a505240a87da641475a00a90`; remote therefore still excludes the audited S0+P0 checkpoint. Workflow has no patch input, so dispatching it would test stale source | `BLOCKED` | No stage/commit/push was performed. P0 phase AC and Deliverables remain open; P3 remains prohibited. The blocker is authorization, not a test failure or permission to weaken evidence | User must explicitly authorize committing the full current S0+P0 checkpoint and pushing it to `feat-editor`; then resume with `CI` dispatch/watch/download |
| 2026-08-18 05:00 +07 | P0 exact-source CI authorization resumed | Publish the complete audited S0+P0 checkpoint, then execute CI on that exact remote SHA | User explicitly authorized push and directed that equivalent in-scope checkpoint pushes/CI runs should not pause for repeated confirmation. Re-read worktree/log/notes; branch is `feat-editor`; GitHub CLI authentication and `git diff --check` PASS | `IN PROGRESS` | Authorization covers the complete current S0+P0 worktree and subsequent in-repo checkpoint pushes needed by this checklist; it does not weaken any CI or source-identity gate | Commit/push, resolve exact remote SHA, dispatch/watch/download `CI` |
| 2026-08-18 05:08 +07 | P0 CI repair checkpoint | Repair exact-source Linux full-suite timeout before any next phase | Commit `8f0b8291ccd0bf7d564f6416b2900c97201ada98` pushed and workflow run `32074075799` matched that exact SHA. Linux job `95523332662` failed one test: `tests/adapter/large-content-store.test.ts:124` exceeded Vitest's default 5,000 ms while streaming/verifying the 2 MiB object twice under full-suite load; 2,132 tests passed, 5 skipped | `IN PROGRESS` | CI red is authoritative. Production storage code is unchanged; the focused lifecycle assertion gets an explicit bounded 15,000 ms timeout, still stricter than the existing 30,000 ms 250 MiB stress test | Focused node test, gate checks, commit/push, rerun exact-source `CI` |
| 2026-08-18 05:09 +07 | P0 CI timeout repair local gate | Node-only focused lifecycle suite and diff integrity | `bunx vitest run tests/adapter/large-content-store.test.ts --environment node`: 1 file, 7/7 PASS in 3.37 s; `git diff --check` PASS | `PASS` | macOS job `95523332691` from the red run independently completed the same full test/build/runtime chain successfully; Linux red remains preserved as evidence and cannot be overridden by this focused pass | Commit/push repair and rerun full exact-source `CI` |
| 2026-08-18 05:31 +07 | P0 Windows CI repair checkpoint | Preserve no-follow regular-file capability and portable directory rollback injection | Exact-source run `32074754533`, commit `5a79919725abc5c00ae6ecd046bd8cce162552f6`: Windows primary job `95525641902` failed 5 tests. Four stable symlink fixtures were followed because Windows ignores `O_NOFOLLOW`; one publish-conflict fixture compared a POSIX suffix against a Windows path | `IN PROGRESS` | Add adapter-owned lstat/open/fstat/lstat identity validation instead of weakening security tests; normalize only the injected test suffix for separators. Linux/macOS primary, Linux/Windows browser and Linux/macOS packaged jobs in the same run had passed | Run five focused node suites, typecheck/lint/diff-check, commit/push and dispatch a fresh exact-source `CI` |
| 2026-08-18 05:33 +07 | P0 Windows CI repair local gate | Cross-platform no-follow primitive and portable conflict fixture | `bunx vitest run` five affected adapter suites with `environment node`: 5 files, 62/62 PASS in 3.65 s; typecheck PASS; lint 0 errors/5 baseline warnings; `git diff --check` PASS | `PASS` | Production reads now reject stable symlinks before open and reject path/handle identity changes after open; no security AC was relaxed. Windows is still the authoritative reproduction environment, so this focused local PASS only authorizes a fresh exact-source CI run | Commit/push repair and dispatch/watch/download fresh `CI` |
| 2026-08-18 05:43 +07 | P0 macOS CI repair checkpoint | Keep the broad delivery HTTP integration bounded under full-suite runner contention | Exact-source run `32076588983`, commit `d28dd1f28f4cf0dbd5125a9de035401e6707fc6b`: macOS primary job `95531046579` passed 2,132 tests/223 files, then the single broad delivery-loop route test hit its explicit 30,000 ms contended-suite timeout; the affected no-follow suites all passed on macOS | `IN PROGRESS` | No production or assertion change. Raise only the named contended integration bound to 60,000 ms; focused runtime remains measured separately so a real hang is not presented as PASS | Focused node route suite, typecheck/diff-check, commit/push, fresh exact-source `CI` |
| 2026-08-18 05:45 +07 | P0 macOS timeout repair local gate | Delivery-loop real SQLite/filesystem route integration | `bunx vitest run tests/server/delivery-loop-routes.test.ts --environment node`: 1 file, 9/9 PASS in 6.96 s, test body 5.91 s; typecheck and `git diff --check` PASS | `PASS` | Focused runtime is far below both old and new bounds, supporting runner contention rather than an application hang; exact-source three-OS CI remains mandatory | Commit/push and dispatch fresh `CI` |
| 2026-08-18 06:29 +07 | P0 phase gate | Full exact-source CI matrix, packaged evidence download and all P0 AC | [Run `32077416522`](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522), exact commit `6c220acdc1089d3e5b6c3b221149a50cc417d8ed`: primary [Linux](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530458), [macOS](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530464), [Windows](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530440) SUCCESS; browser [Linux](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530568), [Windows](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530548) SUCCESS; packaged [Linux](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530536), [macOS](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530537), [Windows](https://github.com/alvindev111/vidcom-v2/actions/runs/32077416522/job/95533530516) SUCCESS | `PASS` | Downloaded all three evidence artifacts to `/tmp/vidcom-p0-ci-32077416522.k4UYG1`: each strict smoke has 13/13 required steps PASS, zero non-pass, `evidenceError:null`, two startup checks OK, zero render-cancellation survivors/exhaustive proof; each manifest has exact commit and `dirty:false`. Download bundles intentionally contain evidence/manifest rather than executable, so their `SHA256SUMS` executable entry cannot be re-hashed locally; the workflow's pre-upload “Validate complete release evidence” step passed on every OS. Earlier red runs remain logged and were superseded only after their fixes passed exact-source CI | P0 closed; proceed P3 |
| 2026-08-18 06:36 +07 | 3.1a checkpoint | Analyze `MutationHistory` stack/reservation contract before implementation | Baseline HEAD `eb0da9160666baa5b1d1b46e7b0853971b066906`; worktree clean before checkpoint. Planned red/green command: `bunx vitest run tests/server/mutation-history.test.ts --environment node` | `IN PROGRESS` | Design §5.6 and exact Core `MutationObserverPort` names govern; one stack per `(studioSessionId,projectId)`, 50 entries, claim-before-publish and atomic original-receipt movement | Write failing node tests, then minimum server implementation |
| 2026-08-18 06:39 +07 | 3.1a | In-memory `MutationHistory` stack/reservation state machine and exact Core observer surface | Red: focused suite failed before collection because `packages/server/src/service/mutation-history.ts` did not exist. Green: `tests/server/mutation-history.test.ts` 8/8 with explicit node environment; typecheck PASS; boundaries PASS; lint 0 errors/5 baseline warnings; diff-check PASS | `PASS` | Proves per-session/project 50-entry cap, redo branch cut, one pending/committing operation, top+attachment+direction recheck at claim, atomic original receipt move, inverse-ref release, abort/committing-clear safety, no owner self-barrier and cross-session barrier. P3 phase remains open; 3.1b owns exhaustive path/dependency barrier cases and 3.1c owns full attachment/ref lifecycle | 3.1b |
| 2026-08-18 06:40 +07 | 3.1b checkpoint | Directional ownership/dependency barriers plus synchronous precondition blocking | Baseline HEAD/remote `34258f1c57f46af6df91d78b3838bc5c88be07d8`; worktree clean before checkpoint. Planned red/green: `bunx vitest run tests/server/mutation-history-barriers.test.ts tests/core/write-authority.test.ts --environment node` | `IN PROGRESS` | Current history contains the primitives, but exhaustive segment/direction/deep-entry proof is absent and Core does not yet call `blockHistoryOperation` when inverse step/read-guard preconditions conflict | Add red tests, wire the missing Core call, then focused gates |
| 2026-08-18 06:42 +07 | 3.1b | Segment-safe ownership and directional dependency barriers; synchronous Core conflict settlement | Red: new server barrier suite passed its existing primitives, while the new Core assertion failed because observer blocks were empty. Green: history/reservation/barrier + WriteAuthority suites 61/61 with explicit node environment; typecheck, boundaries, diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Covers equal/ancestor versus sibling-prefix ownership, same-session non-undoable barriers, undo-safe/redo-blocked and redo-safe/undo-blocked dependencies, directory child versus parent invalidation, deep-entry/top behavior, external events and idempotent cancel after synchronous block. Core calls the exact observer port only for undo/redo `WriteConflict` fields belonging to step/read-guard preconditions, before any write | 3.1c |
| 2026-08-18 06:43 +07 | 3.1c checkpoint | Attachment generations/SSE grace and exact content-ref ownership | Baseline HEAD/remote `c4b429bbf81382753c55756f0e117e410816563c`; worktree clean. Planned red/green: `bunx vitest run tests/server/mutation-history-lifecycle.test.ts tests/server/mutation-history*.test.ts --environment node` | `IN PROGRESS` | Audit found a real lifecycle gap: current abort/emit lookup requires a still-live attachment, so explicit detach after claim can strand a committing operation. Current project invalidation can also leave `busy` until a later callback. Both must settle safely without weakening attachment checks at begin/claim | Add lifecycle/ref-count race tests, then implement generation/grace and one-time release |
| 2026-08-18 06:49 +07 | 3.1c | Attachment binding/generation, overlapping SSE leases, deferred committing disposal and exact content-ref ownership | Red: lifecycle suite 6/8 failed on detach-after-claim emit/abort, missing lease/attachment API and desync `busy`; a second red isolated stale cancelled grace callback deleting the new lease generation. Green: four focused history/Core suites 71/71 with explicit node environment; typecheck, boundaries, diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | UI receipts push only for attached session/project; unattached UI and startup recovery remain barriers and release refs. Explicit detach revokes immediately but committed inverse/abort can settle against existing stack then clear. SSE counts overlap, final close starts 30 s grace, reconnect cancels via grace generation, old callback cannot clear new attach. Duplicate delivery releases its newly transferred ownership; item 51, redo cut, inverse, clear, detach, dispose and desync release each lease exactly once. Desync settles busy synchronously and preserves blocked metadata | 3.1d |
| 2026-08-18 06:51 +07 | 3.1d checkpoint | Replace the P0 no-op with one production history identity across foundation, authority, watcher and server dependency seam | Baseline HEAD/remote `8f56ff556bda8c5980890bfd297d8a2eb4eea11a`; worktree clean. Planned red/green: `bunx vitest run tests/cli/runtime-paths-wiring.test.ts tests/cli/foundation-lifecycle.test.ts --environment node` | `IN PROGRESS` | Startup already creates infrastructure before application/reconcile and watcher/listener; missing pieces are concrete construction, watcher injection, teardown disposal and active server dependency plumbing. Actual undo/history route registration remains task 3.3, but its dependency must already be the same singleton | Add failing production identity/lifecycle assertions, then wire without constructing observers in route/app factories |
| 2026-08-18 06:53 +07 | 3.1d | One concrete history singleton across production foundation consumers and teardown | Red: runtime wiring failed because `MutationHistory` was not exported/constructed; shutdown failed because the P0 no-op had no `dispose`. Green: startup/runtime/watcher/real hosted delivery integration 55/55 with explicit node environment; typecheck, boundaries, diff-check PASS; lint 0 errors/5 baseline warnings; `rg` finds one production `new MutationHistory` and no CLI/Server `NOOP_MUTATION_OBSERVER` | `PASS` | `createInfrastructure` constructs history beside `LargePreviousContentStore`, before application and startup reconcile; same identity reaches WriteAuthority, reconcile callback, WorkspaceWatcher and active `createServerApp.history` route seam. Foundation teardown disposes it after watcher stop and before lease/database release, so workspace replacement cannot retain old stacks. CLI/MCP headless construction follows the same foundation. Endpoint registration/behavior remains explicitly unclaimed until 3.3 | 3.2 |
| 2026-08-18 06:56 +07 | 3.2 checkpoint | Core inverse planner for file/staged/directory/entity/pending-mount receipts | Baseline HEAD/remote `c9880021067852fe37405a37b17a2e3c3b6d8891`; worktree clean. Planned red/green: `bunx vitest run tests/core/apply-mutation-inverse.test.ts tests/core/write-authority.test.ts --environment node` | `IN PROGRESS` | Design §5.7 requires one all-precondition composite: undo uses before content/reversed order, redo after content/original order, object refs stay staged, entity uses full target state plus current monotonic revision and direction hash, and pending mount reopens/closes in the same journal | Add failing planner/authority tests, then implement/export and wire content dependency |
| 2026-08-18 07:02 +07 | 3.2 | Core `applyMutationInverse`, direction-aware composite planning and exact inverse receipt return | Red: all 4 planner tests failed because the use case/export did not exist. Green: planner + WriteAuthority 50/50; related project/scene/file/composite/recovery suites 97/97; typecheck, boundaries, diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Undo reverses all receipt steps and resolves before refs; redo preserves order/uses after refs and carries read guards. Object refs remain opaque `write-staged`; UTF-8 inline stays validated text. Directory existed-before rules, full entity patch with monotonic revision + direction hash, and pending reopen/close share one composite. Any generated or original delete enables backup. WriteAuthority returns the exact already-emitted inverse receipt only for history operations; step/read-guard/entity conflicts synchronously block and include canonical `details.blockedBy`, with zero write | 3.3 |
| 2026-08-18 07:05 +07 | 3.3 checkpoint | Auth-bound studio header helper, attach/detach/history/undo/redo routes, SSE leases and browser-origin cutover | Baseline HEAD/remote `0eb4129aea89751ba7112b38f28708e10fdb931b`; worktree clean. Planned red/green: `bunx vitest run tests/server/history-routes.test.ts tests/server/project-routes.test.ts tests/server/delivery-loop-routes.test.ts tests/server/events.test.ts --environment node` | `IN PROGRESS` | Browser auth token fingerprint is the attachment owner; header uses the single contracts ULID validator. Every editor write must validate attachment and receive a server-chosen label/origin. Global lifecycle/recovery operations outside a mounted project remain non-history Core operations, not a second UI-history bridge | Add failing HTTP/zero-write/race tests, then register routes and remove `UNTRACKED_UI_*` production bridge |
| 2026-08-18 07:13 +07 | 3.3 | Auth-bound studio lifecycle, history HTTP routes, reservation-safe inverse and browser-origin cutover | Red: new route suite 5/5 failed with 404 history endpoints or a browser write succeeding without the required header. Green: focused history/project/delivery/events/origin suites 28/28; complete Server gate 171/171; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Contracts expose one canonical ULID validator reused by studio IDs. POST/DELETE attach binds header to the authenticated cookie fingerprint and project; history/write/cross-project requests fail 400 before authority. Undo/redo reserve before await, send the server-owned operation origin through Core and always cancel non-commits. SSE opens/closes the same attachment lease. All browser project writers use the shared helper in the active host; server-owned labels replace transport control. The P0 `UNTRACKED_UI_*` module is deleted and production Server/CLI contains no literal `historyAction:"ignore"` browser bridge | Commit/push checkpoint, then 3.4 |
| 2026-08-18 07:15 +07 | 3.4 checkpoint | Per-project studio ULID, attach-before-write/SSE lifecycle, shared mutation headers and history controls | Baseline HEAD/remote `3116266c0c95ac1b69e6686dcffe7e130f82c399`; worktree clean before checkpoint. Planned red/green: `bunx vitest run tests/frontend/studio-session.test.ts tests/frontend/api-driver.test.ts tests/frontend/history-controls.test.ts --environment node` | `IN PROGRESS` | Read required editor README and inspected `02-timeline.jpg`: history belongs in the compact timeline action toolbar, with labels/status visible but without copying pixels. Use a keyed composer child so one `useRef` ULID belongs to one project mount; attach must settle before rendering any mutation surface or opening the fetch-based SSE stream. Logic stays in node-testable modules; no timing/cue/file decisions move into components | Add failing ULID/request/lifecycle/history-state tests, then minimum UI wiring |
| 2026-08-18 07:25 +07 | 3.4 | Per-project ephemeral studio identity, attach-first mutation/SSE transport and labelled history controls | Red: focused suites failed collection because ULID, studio request and history-control modules did not exist. Green: focused frontend 25/25; all frontend 71/71; combined frontend/Core/Server regression 97/97; production Next build, typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | A keyed composer mount owns one Web Crypto ULID in `useRef`, never storage. It attaches before rendering StudioShell, detaches best-effort on unmount/pagehide, and replaces EventSource with credentialed fetch SSE so the same header, project query, abort, resume ID and reconnect ID are preserved. Every current browser project mutation uses the context request helper; agent terminal remains MCP-origin and machine-level licence writes remain outside project history. Timeline follows the reference's compact action bar, shows server labels, disables busy/blocked directions, explains stable barrier reasons, and exposes Reload source/Keep current. Both escape actions clear the session stack; only Reload remounts the source UI. Contracts now contain the sole ULID regex; Core imports that validator for pending mount | Commit/push checkpoint, then 3.5 |
| 2026-08-18 07:26 +07 | 3.5 checkpoint | Prove undo/redo remain browser-only and absent from every MCP catalogue/transport | Baseline HEAD/remote `2fcd8c2666c7e1aa9f8daf207ae221872cc82b03`; worktree clean. Planned evidence: `bunx vitest run tests/contracts/tool-schema-catalogue.test.ts tests/mcp/server-factory.test.ts tests/mcp/bridge-registry-parity.test.ts --environment node` plus registry/schema name audit | `IN PROGRESS` | CodeGraph shows all exposed tools flow through `TOOL_SCHEMA_CATALOGUE` and `ToolRegistry.list`; no implementation change is warranted if both canonical catalogue and modern/legacy/bridge lists already exclude undo/redo/history. HTTP history routes are intentionally browser-session capabilities, not MCP tools | Run focused contract/registry tests and exact name audit |
| 2026-08-18 07:26 +07 | 3.5 | Deferred D7 remains closed: no MCP undo/redo/history tool | Canonical schema catalogue, server factory and bridge parity suites 8/8 PASS under node; exact definition/schema-key audit returned no `undo`, `redo` or `history` MCP tool | `PASS` | Existing architecture already met the AC, so production code was not rewritten. Both legacy/modern MCP lists and bridge projection originate in the tested canonical registry; the new HTTP routes remain browser-auth + attached-studio only | Commit/push documentation checkpoint, then 3.6a |
| 2026-08-18 07:27 +07 | 3.6a checkpoint | Close the broad history lifecycle/recovery/ref-count/large-staged evidence matrix without duplicating 3.1 tests | Baseline HEAD/remote `63c8bf20072b0af2797964bde47966f7979b85a5`; worktree clean. Planned gate: `bunx vitest run tests/server/mutation-history*.test.ts tests/server/history-routes.test.ts tests/core/apply-mutation-inverse.test.ts tests/core/write-authority.test.ts tests/cli/runtime-paths-wiring.test.ts --environment node` plus focused new production-route/recovery/staged-retention cases | `IN PROGRESS` | Existing suites already cover 50/cut-redo, directional inter-session paths, unattached recovery, duplicate/ref release, detach/SSE generations, pending/committing clear/dispose, pre-publish/rollback/reconcile and inline/RSS bounds. Audit must add only missing exact cases: production history route shares the foundation observer, file create/replace backup semantics at the inverse boundary, and any staged object eviction/recovery gap not actually asserted | Map fixtures, write failing tests for real gaps, then run the full matrix |
| 2026-08-18 07:29 +07 | 3.6a | Full history lifecycle/recovery/ref-count/large-staged integration matrix | Ten node suites 95/95 PASS; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Existing evidence covers cap/branch-cut, create/replace/delete inverse ordering + backup, duplicate recovery IDs, directional cross-session overlap, absent/invalid studio IDs, attachment/recovery/ref ownership, 1,024-file + 50-receipt inline bounds, 250 MiB RSS, claim/publish/rollback/reconcile races and deferred clear/dispose. Added two missing real seams: hosted `PUT /files` records in the exact foundation singleton read by `/history`; a 2 MiB retained staged object survives deletion of its original catalog-cache file and is planned as `write-staged` for redo. No production rewrite was needed for these already-correct behaviors | Commit/push checkpoint, then 3.6b |
| 2026-08-18 07:30 +07 | 3.6b checkpoint | Join synchronous Core blocking to HTTP state/retry behavior and post-commit observer fail-safe | Baseline HEAD/remote `e0ea965c77bf87197740d6551292007188c013c5`; worktree clean. Planned gate: `bunx vitest run tests/server/history-routes.test.ts tests/server/mutation-history-lifecycle.test.ts tests/core/write-authority.test.ts tests/frontend/history-controls.test.ts --environment node` | `IN PROGRESS` | Core already proves one synchronous block call before publish and mutation success on observer emit failure; MutationHistory already proves desync settles all reservations/releases refs; UI view-model proves both blocked reasons disable the direction. Missing boundary evidence is a 409 route attempt followed by `busy=false`/blocked top and a retry rejected by `begin` with no second authority invocation | Add the focused route case, then run the joined matrix |
| 2026-08-18 07:30 +07 | 3.6b | Synchronous block through HTTP plus post-commit history fail-safe matrix | Route/history/Core/UI suites 65/65 PASS; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | New route test injects the pre-watcher conflict at the authority boundary: first undo returns 409, synchronous observer block leaves the same top/depth with `busy=false` and the correct directional reason; retry returns 409 in `begin` and authority invocation count stays one. Existing joined tests prove exactly one Core block call, UI disables with both escape paths, observer emit failure after commit remains a successful mutation with warning, project-wide desync settles reservations and releases refs once | Commit/push checkpoint, then 3.6c |
| 2026-08-18 07:31 +07 | 3.6c checkpoint | Complete symmetric directional/deep-entry matrix and composite scene-delete entity evidence | Baseline HEAD/remote `aca14d6fa1899c4b6c4a6f9d62d7670ab6ce5a54`; worktree clean. Planned gate: `bunx vitest run tests/server/mutation-history-barriers.test.ts tests/server/mutation-history.test.ts tests/core/scene-deletion.test.ts tests/core/apply-mutation-inverse.test.ts tests/core/write-authority.test.ts --environment node` | `IN PROGRESS` | Existing barriers cover same-session non-undoable ownership, dependency edit undo-safe/redo-blocked, incoming consumer undo-block, directory sibling/ancestor behavior and deep undo. Scene deletion already plans source+narration+preview cleanup in one composite; inverse planner already restores entity state. Missing explicit symmetry is a blocked deep redo entry revealed only after a clean redo, plus a joined assertion that scene cleanup entity is Core-owned undoable and inverse restores the full scene map | Add only those assertions, then run the full matrix |
| 2026-08-18 07:32 +07 | 3.6c | Symmetric directional barrier/deep-entry and scene cleanup entity matrix | Five node suites 77/77 PASS; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Added the missing redo-depth mirror: after two undos, an externally blocked lower redo stays hidden while the clean top applies, then becomes the blocked top without skip/clear. Scene deletion assertion now proves its preview-settings cleanup step is Core-owned `undoable:true` inside the same backed-up composite; inverse coverage restores the full scene map with current monotonic revision/hash. Joined existing tests cover non-undoable same-session barrier, ownership-vs-guard direction, sibling directory safety, ancestor invalidation and cross-session inverse barrier | Commit/push checkpoint, then P3 phase gate |
| 2026-08-18 07:34 +07 | 3.6d checkpoint | Real-browser history controls, isolated tab sessions, reload/detach/SSE lifecycle and spoof rejection | Baseline HEAD/remote `936439a8f42da3135fa090673c3584e0d0a46209`; worktree clean. Planned red/green: `bun run test:browser-session`, joined lifecycle route tests under node, then exact-head `Browser session` workflow on Linux x64 + Windows x64 | `IN PROGRESS` | Repo's Puppeteer/Chrome harness is the required browser runner. Browser evidence must exercise rendered labels/escape actions and distinct tab-owned ULIDs; node integration remains the deterministic owner for 30 s grace, overlapping-stream generation and auth/project spoof races that cannot be safely time-travelled in a page | Add failing browser scenario and only the minimum test seam if needed |
| 2026-08-18 07:50 +07 | 3.6d | Real Chrome history UX/session isolation plus generation-safe SSE lifecycle | Red: deterministic lifecycle test exposed stale old-generation SSE close decrementing a newly attached lease; initial browser run also exposed the harness buffering SSE instead of streaming it. Green: local Browser session 11/11; joined route/events/lifecycle/UI 25/25; typecheck, boundaries, diff-check PASS; lint 0 errors/5 baseline warnings. Exact SHA `5cdc21a0ba18b37efdbcab56c3185e23beb9b44d`: [run 32085708059](https://github.com/alvindev111/vidcom-v2/actions/runs/32085708059), Linux x64 `success` (job 95557685599), Windows x64 `success` (job 95557685413). `gh run download` returned `no valid artifacts found` because this workflow has no upload step | `PASS` | Event leases now carry attachment generation internally; an old stream close is ignored after explicit detach/reattach. Browser drives server label, both blocked escapes, same-auth tab ULID isolation, reload-empty history, fresh source reload, different-auth stolen-ID rejection and wrong-project rejection. Harness streams/cancels SSE instead of materializing an infinite response. Existing create-card slug redirect remains an unrelated pre-existing regression; the focused history path uses the immutable project id already used by project cards/API | Phase P3 gate |
| 2026-08-18 07:50 +07 | Phase P3 gate | All P3 tasks, five AC and deliverables | Full `bun run test`: 234 files PASS + 1 intentional skip, 2185 tests PASS + 5 intentional skips; production build PASS locally and in both Browser session jobs; typecheck PASS; lint 0 errors/5 baseline warnings; boundaries and diff-check PASS; exact-head Browser session Linux/Windows PASS | `PASS` | No open P3 blocker. Server generation token is internal and leaves HTTP/contracts unchanged; D7 remains deferred with no MCP undo/redo tool | P4.1 |
| 2026-08-18 07:53 +07 | 4.1 checkpoint | Discriminated preview/render document options and earliest-head health collector | Baseline HEAD/remote `1ba31cd514790cf9f4892ce051d9ee234d339b30`; worktree clean. Planned red/green: `bunx vitest run tests/adapter/composition-hf.test.ts tests/server/project-routes.test.ts tests/adapter/render-job.test.ts tests/adapter/snapshot-job.test.ts --environment node`, then typecheck/boundaries | `IN PROGRESS` | P4 Bun skill and all phase Read-first files were read in full; `01-overview.jpg` confirms a stable central canvas with transport/timeline outside the engine. Core port will own one discriminated options type. Preview reads current journal revision plus outbox project sequence; render/preflight explicitly select render. Collector is injected immediately after the first head tag only for preview, before authored scripts and separate from the render runtime guard | Add compile/runtime tests that fail on the current untagged options and missing collector |
| 2026-08-18 07:57 +07 | 4.1 | Core-owned preview/render document mode, preview identity and earliest-head health collector | Red: adapter preview test failed because the current document began with HyperFrames base/runtime scripts and had no health collector. Green: composition/project-route/render/snapshot focused 33/33 plus motion-library browser integration matrix 34/34 total; typecheck compile assertions PASS; lint 0 errors/5 baseline warnings; boundaries and diff-check PASS | `PASS` | `CompositionDocumentOptions` is one discriminated Core port type: preview requires both revision fields, render forbids them. `getProjectPreview` reads journal revision and project-local outbox seq, while render preflight explicitly selects render. Adapter injects the collector immediately after `<head>` only for preview, before base/runtime/authored scripts; it records script errors, unhandled rejections and capture-phase resource errors. Runtime asset guard remains a separate render concern | Commit/push checkpoint, then 4.2 |
| 2026-08-18 07:58 +07 | 4.2 checkpoint | Preview response identity headers on both v1 and legacy routes | Baseline HEAD/remote `077718c`; worktree clean. Planned red/green: `bunx vitest run tests/server/project-routes.test.ts tests/core/project-usecases.test.ts --environment node`, then typecheck/boundaries | `IN PROGRESS` | 4.1 already reads the exact project revision and project-local outbox sequence before build; 4.2 must return those same sampled values with the HTML and expose them as `X-Vidcom-Project-Revision`/`X-Vidcom-Change-Seq` while preserving `no-store`. No second read after build, which could make collector and headers disagree | Add failing header assertions, then expose the already-sampled identity |
| 2026-08-18 07:59 +07 | 4.2 | Preview no-store plus sampled revision/change-sequence response headers | Red: route test received null for both identity headers. Green: Server/Core focused 46/46; typecheck, boundaries and diff-check PASS | `PASS` | `getProjectPreview` now returns the exact identity sampled before build alongside HTML; both v1 and legacy routes serialize those same values as headers and retain `Cache-Control: no-store`. There is no post-build reread, so header and injected collector cannot describe different snapshots | Commit/push checkpoint, then 4.3a |
| 2026-08-18 08:01 +07 | 4.3a checkpoint | Pure preview health wait and latest-wins buffer coordinator | Baseline HEAD/remote `7b8b7b0`; worktree clean. Planned red/green: `bunx vitest run tests/frontend/preview-buffer.test.ts --environment node`, then frontend regression/typecheck/boundaries | `IN PROGRESS` | Pure module will expose the measured 150 ms quiet/2.5 s timeout policy, transport sample-at-swap, candidate generation and project token checks without importing React/DOM. Environment owns engine creation/health reads/visibility/disposal; coordinator owns one candidate, monotonic desired/visible seq, duplicate coalescing and stale continuation suppression. 4.3b will supply the real HyperFrames/DOM adapter and one stale retry | Add failing health/transport/A-B-C/D-greater-than-C tests, then implement minimum coordinator |
| 2026-08-18 08:03 +07 | 4.3a | Pure health waiter and latest-wins preview buffer coordinator | Red: focused suite failed collection because `preview-buffer.ts` did not exist. Green: focused 7/7; all frontend node suites 78/78; typecheck and boundaries PASS; lint 0 errors/5 baseline warnings; diff-check PASS | `PASS` | Health requires ready+timeline+scenes+collector and a 150 ms quiet window, rejects any collector counter and times out at 2.5 s. Coordinator creates hidden candidates synchronously, aborts/disposes the prior generation before the next, samples live transport only after health, clamps time, restores pause/rate/mute, shows before removing live, and keeps live on rejection. Target/collector D>C advances desired+visible to D; duplicate D coalesces. Project/unmount disposal and late A/B continuations cannot swap or overwrite C error/state | Commit/push checkpoint, then 4.3b |
| 2026-08-18 08:05 +07 | 4.3b checkpoint | Stable PlayerHost identity and real HyperFrames/DOM adapter for every reload | Baseline HEAD/remote `49b0210cf2aee2863017f208299192dc2b1aeb5b`; worktree clean. Planned red/green: `bunx vitest run tests/frontend/player-host.test.ts --environment node`, then all frontend node suites/typecheck/boundaries | `IN PROGRESS` | Current hook remounts the visible custom element whenever `previewUrl` changes. New host must own the stable container and bridge 4.3a to real player elements; `requestReload({url,targetChangeSeq})` verifies collector sequence, retries stale once per generation, preserves sampled transport, and project/unmount cleanup disposes candidate plus visible exactly once. React will depend on project identity, not URL churn | Add failing adapter/host tests before replacing the URL-keyed lifecycle |
| 2026-08-18 08:16 +07 | 4.3b | Stable PlayerHost, same-origin health adapter and project-keyed React lifecycle | Red: focused suite failed collection because `player-host.ts` did not exist. Green: host/buffer 11/11; all frontend node suites 82/82; typecheck and boundaries PASS; lint 0 errors/5 baseline warnings; diff-check PASS | `PASS` | One project-scoped host owns a replaceable visible engine and exposes a stable id on the stage. The real adapter reads daemon collector identity/counters from `iframeElement`, requires the runtime `scenes` timeline signal and every nested composition child, and mounts hidden candidates behind the live engine. Stale candidates retry exactly once with the same generation; failures retain live transport/frame and include health. React mount depends on project id, not preview URL; project/unmount aborts health and disposes candidate plus visible once | Commit/push checkpoint, then 4.4 exact changeSeq and same URL |
| 2026-08-18 08:18 +07 | 4.4 checkpoint | Same preview URL and exact mutation sequence through the buffer | Baseline HEAD/remote `d6e3f38`; worktree clean. Planned red/green: `bunx vitest run tests/frontend/preview-reload.test.ts tests/frontend/player-host.test.ts tests/server/project-routes.test.ts --environment node`, then frontend/server regression/typecheck/boundaries | `IN PROGRESS` | Studio still increments a local revision and appends `?r=`; 4.3b keeps that only as a temporary bridge. Every successful browser write must now surface its response `changeSeq` to one shell reload function, including preview settings. Route evidence must issue the identical URL twice around a write and observe fresh body/collector sequence under `no-store`, without an application URL cache | Add failing source-contract and same-URL integration assertions, then propagate exact response sequence with the smallest callback change |
| 2026-08-18 08:32 +07 | 4.4 | Same-URL preview reload driven by exact durable write sequence | Red: focused suite failed collection because `preview-reload.ts` did not exist. First server regression then exposed strict HTTP schemas missing `changeSeq`; MCP 2-era × 2-transport matrix exposed its separate strict preview-settings schema. Green: focused 14/14, frontend 85/85, server 176/176, Core 325/325, MCP contract 92/92, API contracts 7/7; typecheck/boundaries/diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Removed local revision state and every `?r=` path. File, preview settings/BGM upload, scene timing/script/TTS, motion/BGM install, AI generate and undo/redo responses now carry their own required nullable sequence through strict HTTP/MCP schemas; Studio reloads only a non-null exact token via the unchanged preview URL. Same URL requested before/after a simulated committed snapshot returned different body/revision/seq with `no-store`, proving the route has no URL-content cache | Commit/push checkpoint, then 4.5 SSE same buffer path |
| 2026-08-18 08:34 +07 | 4.5 checkpoint | Project SSE sequence feeds the same exact-seq preview buffer path | Baseline HEAD/remote `daed881`; worktree clean. Planned red/green: `bunx vitest run tests/frontend/studio-session.test.ts tests/frontend/preview-reload.test.ts --environment node`, then frontend/events regression/typecheck/boundaries | `IN PROGRESS` | MountedStudio currently debounces SSE into snapshot refresh/eventRevision only, so an external file or preview-settings event never calls PlayerHost. SSE `id` is the durable outbox sequence. The debounce must retain the greatest valid project-event id, pass it to StudioShell, and invoke the existing `previewReloadRequest`/`requestReload`; HTTP plus SSE duplicates then coalesce in 4.3a instead of creating a second path | Add failing sequence parser/source wiring assertions, then propagate the event id without remounting the shell |
| 2026-08-18 08:37 +07 | 4.5 | Project-scoped SSE sequence through the same preview buffer | Red: focused test failed because `studioEventChangeSeq` did not exist. Green: focused 9/9; all frontend node suites 86/86; joined server event/watcher suites 12/12; typecheck and boundaries PASS; lint 0 errors/5 baseline warnings; diff-check PASS | `PASS` | SSE debounce now retains the greatest canonical safe-integer event id only when event data explicitly names the mounted project; global host events, other projects, malformed ids and global resync ids still refresh snapshots but cannot become a project preview target. The monotonic sequence is passed into StudioShell and uses the same unchanged-URL `previewReloadRequest`/PlayerHost call as HTTP writes, so HTTP+SSE duplicates coalesce. External `file.changed` for `index.html` or `preview-settings.json` needs no project revision bump | Commit/push checkpoint, then 4.6a document-mode integration matrix |
| 2026-08-18 08:39 +07 | 4.6a checkpoint | Consolidated document-mode and same-URL integration evidence | Baseline HEAD/remote `ebec2a8`; worktree clean. Planned gate: `bunx vitest run tests/adapter/composition-hf.test.ts tests/core/project-usecases.test.ts tests/server/project-routes.test.ts --environment node`, then typecheck/boundaries | `IN PROGRESS` | Existing tests already lock collector-before-authored-script, render exclusion and same-URL/no-store freshness; those will not be rewritten. Missing explicit evidence is project-local outbox isolation: a project with no event must inject/header seq 0 even when another project has a higher global event. Add only that failing assertion and join the existing evidence | Extend the route fixture with project-scoped sequences, confirm the old unscoped fake fails, then make the smallest test-fixture/use-case assertion needed |
| 2026-08-18 08:42 +07 | 4.6a | Document-mode integration matrix and project-local zero sequence | Red: route test failed because the fixture had no project-scoped sequence control. Green: joined adapter/Core/server matrix 55/55; typecheck, import boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Existing coverage remains the authority for collector-before-authored-script, render exclusion and identical no-store URL freshness. The route fixture now models `latestProjectSeq(projectId)` instead of a global scalar; a project with no events stays at collector/header sequence 0 even after another project advances to 99 | Commit/push checkpoint, then 4.6b browser probes and race matrix |
| 2026-08-18 08:46 +07 | 4.6b checkpoint | Real-browser preview-buffer probes and race closeout | Baseline HEAD/remote `9dc4786`; worktree clean. Planned red/green: extend `tests/frontend/browser-session.test.ts`, run `bun run build && VIDCOM_REQUIRE_BROWSER=1 bun run test:browser-session` when Chrome is local, then dispatch `Browser session` on Linux/Windows | `IN PROGRESS` | Pure node suites already lock A/B/C latest-wins, duplicate coalescing, D>C, one candidate and unmount cleanup. Missing browser evidence must exercise the shipped Studio/HyperFrames DOM seam: stable host, zero-frame/rate/mute transport, shorter-duration clamp, missing nested scene rejection, and collector script/resource failures while the live player remains visible | Add the smallest real-browser assertions to the existing authenticated static-bundle harness; CI is mandatory evidence if local Chrome is unavailable |
| 2026-08-18 08:52 +07 | 4.6b | Real-browser transport, failure collector, race and lifecycle matrix | Red: focused suite failed collection because the browser fixture did not exist. Green local: probe 1/1, node buffer/host 11/11, required Browser session 4 files/12 tests, build/typecheck/boundaries/diff-check PASS; lint 0 errors/5 baseline warnings. [Run `32089458505`](https://github.com/alvindev111/vidcom-v2/actions/runs/32089458505) at `41db32660387a12720f631705baff8afb6b0e085`: [Linux x64](https://github.com/alvindev111/vidcom-v2/actions/runs/32089458505/job/95568643678) SUCCESS, [Windows x64](https://github.com/alvindev111/vidcom-v2/actions/runs/32089458505/job/95568643677) SUCCESS; `gh run download` reported no artifacts because this workflow publishes none | `PASS` | Chrome executes bundled production PlayerHost/DOM adapter against same-origin iframe documents with the production collector. It proves zero-frame/rate/mute preservation, shorter clamp, missing scene rejection, authored exception and 404 counters, live-frame retention, A/B/C plus duplicate B, D>C coalescing, at most one candidate and dispose during delayed health. Host id remains stable through every reload | Run full P4 phase gate and close AC/deliverables |
| 2026-08-18 08:56 +07 | Phase P4 gate | All P4 tasks, two AC and deliverables | First full run exposed two stale MCP `tools/list` goldens for 4.4 `changeSeq`; updated only legacy/modern generated snapshots and focused golden 4/4 PASS. Second full `bun run test`: 238 files PASS + 1 intentional skip, 2,206 tests PASS + 5 intentional skips. Production build, typecheck, boundaries, local required-browser suite and exact implementation-SHA Browser session Linux/Windows PASS; lint 0 errors/5 baseline warnings; diff-check PASS | `PASS` | No P4 blocker remains. Preview-only collector precedes authored scripts; render has none; project-local sequence, unchanged URL, stable host, latest-wins swap, stale retry, transport preservation and failure retention are covered through Core/route/node/real-browser seams. Golden drift found by the full gate was fixed before advancement | P1.1 |
| 2026-08-18 08:57 +07 | 1.1 checkpoint | Pure timeline snap geometry | Baseline HEAD/remote `bd31538`; worktree clean. Planned red/green: `bunx vitest run tests/frontend/snap.test.ts --environment node`, then all frontend node suites/typecheck/boundaries | `IN PROGRESS` | P1 Bun instructions and phase read-first material are loaded; reference README plus `02-timeline.jpg` confirm a visible snap toggle, percent zoom and distinct clip-edge affordances. No current `snap.ts` exists. Implement only the four Design §5.2 pure functions; the 20 px clip must retain a body zone and both zoom extremes must preserve the 8 px feel within frame/0.5 s clamps | Add the failing node contract before the smallest pure module |
| 2026-08-18 08:58 +07 | 1.1 | Pure snap tolerance, frame quantization and bounded hit zones | Red: focused suite failed collection because `src/lib/studio/snap.ts` did not exist. Green: focused 4/4; all frontend node suites 91/91; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Eight screen pixels convert through the current pixels-per-second value and clamp to one frame/0.5 s. Nearest eligible marker preserves its identity for UI affordance; snap-off timing rounds to the nearest frame. Edge handles use `min(8px, 40% width)`, leaving a body interval even on 20 px and 10 px clips | Commit/push checkpoint, then 1.2 interaction reducer |
| 2026-08-18 08:59 +07 | 1.2 checkpoint | Pure drag-session reducer and commit projection | Baseline HEAD/remote `8c4b4c7`; worktree clean. Planned red/green: `bunx vitest run tests/frontend/editor-interaction.test.ts --environment node`, then all frontend node suites/typecheck/boundaries | `IN PROGRESS` | UI preview math stays in a pure module; ripple preview delegates to Core `planRipple` rather than recreating the business planner in a component. Drag stores original timing, pointer origin, preview timing, active snap marker and moved-scene count. Move events do not emit writes; Esc clears the session; commit projects only changed timing and returns null for an unchanged drop | Add body/left/right/snap/ripple/Esc/no-op failing contracts before the reducer |
| 2026-08-18 09:03 +07 | 1.2 | Pure drag session, optimistic timing and commit projection | Red: focused suite failed collection because `editor-interaction.ts` did not exist. First lint gate then rejected a frontend import from `@vidcom/core`; replaced it with a structural timeline clip and a display-only ripple count, leaving committed planning in Core. Green: focused 4/4; all frontend node suites 95/95; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Body and both trim handles preserve their opposite timing fields, snap exposes the exact marker, snap-off rounds to frames, ripple preview shows how many following scenes visibly shift, and Esc clears the drag. Pointer movement only updates reducer state; `commitDrag` emits minimal timing fields once and returns null when timing is unchanged | Commit/push checkpoint, then 1.3 route wiring |
| 2026-08-18 09:04 +07 | 1.3 checkpoint | Timeline drag UI and exact timing mutation | Baseline HEAD/remote `8db68ee`; worktree clean. Planned red/green: node contract for one-request/error classification plus frontend tests, then typecheck/boundaries/browser phase gate | `IN PROGRESS` | Design §5.1 received a no-AC-change erratum before code: Studio snapshot must expose authored `frameRate` (fallback 30), because frame quantization cannot use a UI guess. Timeline will consume the entry file hash, call the existing PATCH route only on a non-null commit, preserve optimistic/live timing on failure, expose reload for 409, expose extendRoot only for root overflow, and never expose it for runtime overflow | Add failing contract/source wiring tests, then make the smallest snapshot and component path |
| 2026-08-18 09:12 +07 | 1.3 | Pointer drag wiring, exact timing request and conflict/overflow recovery UI | Red: focused suite first failed because `scene-timing-mutation.ts` did not exist; after adding snapshot `frameRate`, strict API contract then failed on its stale fixture. Green: focused frontend/server/contracts 23/23; all frontend node suites 99/99; production build, typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Pointer moves only update the pure optimistic reducer; pointer-up computes the final sample and sends one PATCH only for a non-null commit with the current entry hash. Studio snapshot carries authored fps with 30 fps fallback. Success advances the exact `changeSeq` and entry hash; 409 restores authored display plus reload action; root 422 alone offers Extend root; runtime 422 is terminal with no extension action | Commit/push checkpoint, then 1.4 numeric timing form parity |
| 2026-08-18 09:14 +07 | 1.4 checkpoint | Numeric timing form remains usable after timeline writes | Baseline HEAD/remote `e5d5949`; worktree clean. Planned red/green: node contract for refreshing the file-version cache, then focused frontend/typecheck/boundaries | `IN PROGRESS` | The existing form and route are already present and remain visible; no rewrite is warranted. Audit found one coexistence gap: `ScenePane` initializes its hash map only once, so after a timeline drag refreshes the snapshot, the form can send the old entry hash and receive 409. The smallest fix is a pure file-version mapper plus prop-driven synchronization; route/session/changeSeq behavior stays unchanged | Add the failing latest-snapshot hash test, wire it in an effect, then verify both timing paths |
| 2026-08-18 09:15 +07 | 1.4 | Numeric timing form parity after pointer timing writes | Red: focused suite failed collection because the snapshot file-version mapper did not exist. Green: timing mutation + cache focused 4/4; all frontend node suites 100/100; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | The existing numeric form, layout, validation and route remain untouched. `ScenePane` now replaces its internal file-version map whenever the server snapshot's `files` prop changes, so a prior timeline drag cannot leave the form submitting a stale entry hash; removed files are not retained. Existing session header, exact `changeSeq`, error and pending paths remain shared | Commit/push checkpoint, then 1.5 node/browser closeout |
| 2026-08-18 09:16 +07 | 1.5 checkpoint | Node boundary matrix plus real-browser body/edge/Esc drag | Baseline HEAD/remote `54a7623`; worktree clean. Planned gate: retain existing snap/reducer node cases, extend the authenticated static-bundle browser harness to count real PATCH requests, run build + required local Chrome, then dispatch Browser session on Linux/Windows at the pushed SHA | `IN PROGRESS` | Node coverage already proves the 20 px body zone, both snap-tolerance clamps, body/left/right math, frame rounding, snap identity, ripple preview, Esc and no-op commit, so it will not be rewritten. Missing evidence is pointer capture against the production Timeline in a browser: body and edge drops must each yield one write, while Esc after movement yields none | Add the smallest browser actions/request-body assertions, run local required-browser gate, then push and dispatch exact-SHA CI |
| 2026-08-18 09:28 +07 | 1.5 | Node geometry plus real-browser pointer capture/request counting | Red: first browser run could not find the new clip selector; after adding it, the harness exposed that New video is intentionally scene-empty and then that the selector had been attached to the gutter label rather than the timed clip. Seeded one scene through production Core and moved the test attribute to the actual lane clip. Green local: focused node 13/13, required Browser session 4 files/12 tests, production build, typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings. [Run `32091740200`](https://github.com/alvindev111/vidcom-v2/actions/runs/32091740200) at `43db9b1d45fdf163087597935b9db951422e1f0f`: [Linux x64](https://github.com/alvindev111/vidcom-v2/actions/runs/32091740200/job/95575122026) SUCCESS, [Windows x64](https://github.com/alvindev111/vidcom-v2/actions/runs/32091740200/job/95575122126) SUCCESS; `gh run download` reported no artifacts because this workflow publishes none | `PASS` | Chrome drives real mouse pointer capture on the production static bundle: body drag changes inline left then emits one PATCH with start; right-edge drag changes width then emits one PATCH with duration; Esc after a moved body preview emits no third request. Node retains 20 px hit-zone and both zoom-clamp cases. The seeded scene is created through Core/WriteAuthority, not injected DOM | Run full P1 phase gate and close AC/deliverables |
| 2026-08-18 09:31 +07 | Phase P1 gate | All P1 tasks, both AC and deliverables | Full `bun run test`: 242 files PASS + 1 intentional VieNeu-real skip, 2.219 tests PASS + 5 intentional skips. Focused node 13/13, required local Browser session 12/12, production build/typecheck/boundaries/diff-check and exact-SHA Browser session Linux/Windows PASS; lint 0 errors/5 baseline warnings | `PASS` | No P1 blocker remains. Mouse dragging is additive to the numeric form; timing/candidate/request logic remains outside components; Core remains authoritative for committed ripple/root/runtime decisions; every successful write flows through the existing route, session header, expected hash and exact change sequence | P2.1 |
| 2026-08-18 09:34 +07 | 2.1 checkpoint | Pure scene order/compact/group-shift/insertion planners | Baseline HEAD/remote `e5d237d`; worktree clean. Planned red/green: `tests/core/plan-scene-order.test.ts` under Vitest node, then Core regression/typecheck/boundaries | `IN PROGRESS` | Bun skill and all P2 Read-first sources loaded. Design §5.3 received a no-AC-change erratum before code: gap means leading/inter-slot gaps within `{track,group}`; cross-track leaves source clips unmoved, retains target gaps and inserts one zero boundary; planners return minimal timing changes/root/noOp, insertion also returns `beforeSceneId`. Core owns `groupOf`; UI does not supply a classification decision | Add failing gap/group/all-or-nothing/insertion tests, then implement the pure planner and extract createScene planning without changing its composite boundary |
| 2026-08-18 09:38 +07 | 2.1 | Pure reorder/compact/group-shift/insertion planners and createScene extraction | Red: focused suite failed collection because `plan-scene-order.ts` did not exist. Green: planner 7/7; joined planner/createScene/Core integration 53/53; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | Core `groupOf` matches transition/provenance/overlay-id classification. Same-track reorder preserves leading/inter-slot gaps inside one group; cross-track leaves source clips in place, keeps target gaps and adds one zero boundary. Compact is explicit, group shift validates the entire set before returning any change, overlap gaps remain valid diagnostics, and insertion returns timing/tail shifts/root/beforeSceneId only. `createScene` now consumes that planner and still publishes one three-file composite; future catalog/asset callers can compose the same pure plan without nesting a committing use case | Commit/push checkpoint, then 2.2 use cases |
| 2026-08-18 09:40 +07 | 2.2 checkpoint | Reorder/compact/move mutations and exact-intent bulk scene deletion | Baseline HEAD/remote `0824718`; worktree clean. Planned red/green: new Core use-case tests with captured CompositeRequest plus existing real adapter destructive/history integration, then typecheck/boundaries | `IN PROGRESS` | Timing use cases share one Core apply/write helper, return changed=false with zero write for no-op, enforce root/runtime before apply, and emit overlap diagnostics rather than reject. Bulk deletion cannot loop `deleteScene`: it must plan shared-source ownership, sidecars, settings cleanup and root once; prepare binds canonical ordered sceneIds/revision/plan/hash set, execute re-plans and sends one backup composite/grant so history receives one receipt | Add failing no-op/one-composite/all-or-nothing/exact-intent tests, then implement without route work (owned by 2.3) |
| 2026-08-18 09:49 +07 | 2.2 | Core order mutations and exact-intent bulk scene deletion | Red: new focused suite ran 5/5 failures because all four use cases were absent. Green: planner/order/deletion plus real SQLite/filesystem destructive integration 38/38 PASS; typecheck, boundaries and `git diff --check` PASS; lint 0 errors/5 baseline warnings | `PASS` | `reorderScenes`, separate `compactTrack`, and `moveScenes` load and validate the current entry hash, then share one Core executor. No-op calls `noteUnchanged` with zero apply/write; root/runtime overflow fail before apply; gaps/overlaps remain diagnostics. `prepareDeleteScenes` rejects empty/duplicate targets before project I/O, canonicalizes the set, plans shared-source ownership plus all narration/settings cleanup, and binds revision/digest/target hashes. `deleteScenes` re-plans and submits one grant-bound `backup:true` composite. The real adapter test proves two scenes produce one revision, one verified backup and one history receipt | Commit/push checkpoint, then 2.3 routes |
| 2026-08-18 09:51 +07 | 2.3 checkpoint | HTTP routes 7.2, 7.2b, 7.3, 7.4a and 7.4b | Baseline HEAD/remote `74930b3`; worktree clean. Bun + Hono skills loaded in full. Planned red/green: shared strict editing schemas and Hono `app.request()` contract tests, then production next-host wiring/typecheck/boundaries | `IN PROGRESS` | Reuse `project-writes.ts` rather than add a second route module. All browser mutations obtain server-owned `studioWriteInvocation`; prepare also requires the attached session before creating an approval request. Timing responses return current entry/revision/diagnostics/changeSeq and explicit `changed`; destructive prepare returns plan + requested grantId, while execute repeats exact sceneIds/revision from the body and grantId from the path. Approval service is injected from the existing composition root; no transport may choose origin/history semantics | Add failing strict-schema/session/dispatch/prepare-execute route tests before route implementation |
| 2026-08-18 09:57 +07 | 2.3 | Strict shared contracts and five Hono routes with production wiring | Red contract: the five schemas were undefined. Red route: static `/scenes/order` was captured by existing `/:sceneId` and deletion prepare was 404. Green: route/contracts plus history/write-cutover/foundation aggregate 20/20 PASS; typecheck, production Next build, boundaries and `git diff --check` PASS; lint 0 errors/5 baseline warnings | `PASS` | Static order/move/deletion routes now register before `/:sceneId`; compact remains a distinct track route and strict reorder rejects a `compact` flag. Shared request/response schemas cover all five endpoints. Every commit route gets server-owned attached-session history origin; prepare enforces the same attachment before creating an approval request. Execute repeats sceneIds/revision and uses only the path grantId. No-op returns current file/revision with `changed:false`, null changeSeq and zero authority calls. Next-host injects the existing approval requester | Commit/push checkpoint, then 2.4 UI |
| 2026-08-18 10:00 +07 | 2.3 approval lifecycle correction | Browser confirmation must turn the requested grant into an issued grant before WriteAuthority reserve | Red: execute-route test proved zero calls to `ApprovalService.issue`. Green: route 3/3 and typecheck PASS after injecting the existing issue method and calling it only after strict body/path validation plus attached studio-session validation | `PASS` | Prepare still only creates a requested exact-intent grant. The authenticated execute click is the UI approval boundary: server issues that same request as approver `ui`, then passes the returned ID into `deleteScenes`; journal T1/WriteAuthority still reserve and compare the immutable binding. No grant bypass or auto-approval occurs at prepare time | Push correction, then 2.4 checkpoint |
| 2026-08-18 10:01 +07 | 2.4 checkpoint | Storyboard/timeline reorder, shared selection, group move/delete and keyboard accessibility | Baseline HEAD/remote `27b13f3`; worktree clean. Re-read reference README and visually inspected `02-timeline.jpg`; audited `splitScenes`, storyboard/card, StudioShell selection, timeline/lane/toolbar and editor reducer. Planned red/green: node-only reducer/request tests first, then lift interaction state to StudioShell and wire both surfaces | `IN PROGRESS` | Preserve the reference's pinned track gutter, explicit snap control and visible lane affordance; add insertion markers/count/empty states without pixel copying. `EditorInteractionState` becomes the shared selection source passed to storyboard and timeline. Timeline clip-body retains R1 timing; gutter reorder is the distinct R2 gesture. Group body drag uses the dragged clip as the only snap anchor, excludes all selected clips as candidates and commits `moveScenes` with ripple false. Storyboard uses the same reorder request and `splitScenes` numbering. Delete uses prepare→visible confirmation→execute; all request/body/error classification stays outside JSX | Add failing pure selection/group-drag/reorder-request/delete-request tests, then implement the smallest shared state and UI wiring |
| 2026-08-18 10:15 +07 | 2.4 | Shared selection, two-surface reorder, group timing drag and confirmed bulk deletion UI | Red: interaction suite lacked range/additive/marquee/group APIs and included a selected clip as a snap candidate; reorder intent functions and the request module were absent. Green: focused 13/13 and joined frontend 32/32 PASS; full regression 247 files PASS + 1 intentional VieNeu-real skip, 2,247 tests PASS + 5 intentional skips; production build, typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | One provider now owns selection for storyboard and timeline. Shift/Cmd-Ctrl/marquee/Esc/count are pure reducer paths and create no history. Group body drag previews one anchor delta, excludes the selected set from snap and commits one move request without ripple; track indices remain unchanged. Storyboard cards and pinned timeline names expose separate one-scene reorder gestures with insertion marker and Alt/Option arrows; keyed scene controls preserve identity and polite live regions announce positions, while boundary arrows send no mutation and are not reported as errors. Clip body remains timing-only. Bulk delete sends sorted exact intent to prepare, displays a visible confirmation, then executes the same grant/revision/scene set and clears selection only after success. Both surfaces still number from `splitScenes`; failures never optimistically reorder authored props. Real focus/pointer evidence remains assigned to 2.5b | Commit/push 2.4, then 2.5a unit/integration closeout |
| 2026-08-18 10:21 +07 | 2.5a checkpoint | Close the exact one-mutation/one-undo evidence gap without rewriting covered planners | Baseline HEAD/remote `63f0acc`; worktree clean. Audit command: CodeGraph over `planReorder`, `planGroupShift`, `deleteScenes`, WriteAuthority observer and MutationHistory, followed by focused test reads | `IN PROGRESS` | Existing node planner cases already prove positional gaps, group-relative bounds, overlay isolation, cross-track behavior, all-or-nothing negative shift, compact and no-op. The real SQLite/filesystem deletion case proves one revision, one verified backup and one emitted receipt, but its fake observer does not prove that the receipt produces exactly one undo entry. Replace only that observer seam with an attached real `MutationHistory`, retain the revision/backup/file assertions, then assert depth 1 and the composite label | First make the integration test fail against the current fake observer contract, then wire the real history service and run focused plus P2 aggregate gates |
| 2026-08-18 10:22 +07 | 2.5a | Planner matrix plus one real composite history entry for bulk deletion | Red: the real SQLite/filesystem deletion emitted one receipt into a fake observer, but an attached `MutationHistory` remained at depth 0. Green: inject the production `LargePreviousContentStore` into WriteAuthority and the real attached MutationHistory; focused destructive test 1/1 and P2 aggregate 9 files/62 tests PASS; typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `PASS` | No production code changed. Existing exact planner assertions retain positional gaps, enforce group-relative bounds without touching overlays, reject partial/negative group shifts and cover cross-track/no-op/compact. Bulk delete now proves the full chain on real SQLite and filesystem: one project revision, one verified backup, both owned scene files removed, history depth exactly 1, next undo label `Delete 2 scenes`, and the top receipt is journal:1 at project revision 1 | Commit/push 2.5a, then 2.5b real-browser evidence |
| 2026-08-18 10:24 +07 | 2.5b checkpoint | Real Chrome evidence for every P2 pointer, selection, destructive and keyboard surface | Baseline HEAD/remote `2ffe2f7`; worktree clean. Playwright skill loaded; `npx` prerequisite PASS. Audited the dedicated `Browser session` workflow and its authenticated production static-bundle harness | `IN PROGRESS` | Extend the existing required-browser test instead of creating a second server/runtime. Seed several scenes through production Core, with one moved to another track before the page loads. Add stable semantic selectors only where browser evidence needs them. Drive native storyboard and gutter drag while observing insertion markers and exactly one order request; drive Shift same/cross-track, Ctrl additive toggle and empty-surface marquee; drive a selected group body drag and verify one `/scenes/move` request; delete that group via visible prepare-confirm-execute; drive Alt/Option arrows and prove focus plus live announcement and boundary no-mutation. Existing timing/history/browser-session assertions remain intact | Add browser assertions first and run required local Chrome red, then implement only missing semantic hooks/interaction corrections, rerun locally, commit/push and dispatch `Browser session` Linux/Windows at the exact SHA |
| 2026-08-18 10:34 +07 | 2.5b local gate | Required local Chrome on the production static bundle | Initial RED: storyboard selector absent; after semantic hooks, keyboard focus stayed on body because the card button used `display:contents`; group drag also collapsed the selected set on pointer-down. Green: required Browser session 4 files/12 tests PASS; P2 node aggregate 9 files/62 tests, production build, typecheck, boundaries and diff-check PASS; lint 0 errors/5 baseline warnings | `LOCAL PASS / CI PENDING` | Native mouse drag observes before/after insertion markers and exactly one request on storyboard and pinned gutter. Alt/Option reorder retains the keyed scene button focus, announces the new position, and a boundary press sends zero requests. Real clicks prove Shift same-track, Shift cross-track reset and Ctrl toggle; marquee selects every intersected clip including a cross-track row. Dragging a selected member keeps the group and sends one shared-delta move without ripple; visible confirmation sends identical prepare/execute deletion intent and removes every selected scene. Existing timing, Esc no-write, history isolation, cookie/SSE and preview-buffer cases still pass | Commit/push exact source and dispatch `Browser session` on Linux/Windows; do not close 2.5b until both jobs succeed and evidence URL is logged |
| 2026-08-18 10:39 +07 | 2.5b CI correction | [`Browser session` run 32096017382](https://github.com/alvindev111/vidcom-v2/actions/runs/32096017382), exact SHA `f9a8afe83e790a51fff3f7f1795ca534eb29928f` | Linux x64 [job 95587408163](https://github.com/alvindev111/vidcom-v2/actions/runs/32096017382/job/95587408163): `failure`; Windows x64 [job 95587408260](https://github.com/alvindev111/vidcom-v2/actions/runs/32096017382/job/95587408260): browser step `failure` (run finalization pending when inspected). Both timed out waiting for `/scenes/move`: the test helper dragged the first DOM clip, which is not guaranteed to be a member of the marquee selection across layouts | `FAIL → LOCAL PASS / CI RERUN PENDING` | Harness-only fix selects the explicit marquee anchor by `sceneId`; production code is unchanged. Required focused Chrome 1/1 and full Browser session 4 files/12 tests PASS; typecheck and `git diff --check` PASS. The nonexistent `test:diff-check` package script was not counted as source failure | Commit/push the deterministic harness and rerun Browser session at its exact SHA; close only after both OS jobs succeed |
| 2026-08-18 10:45 +07 | 2.5b CI correction 2 | [`Browser session` run 32096306180](https://github.com/alvindev111/vidcom-v2/actions/runs/32096306180), exact SHA `186f2cdab10e4ccd8cceaa8e95e133a9b6d80944` | Linux x64 [job 95588240027](https://github.com/alvindev111/vidcom-v2/actions/runs/32096306180/job/95588240027): `failure`; Windows x64 [job 95588239858](https://github.com/alvindev111/vidcom-v2/actions/runs/32096306180/job/95588239858): `failure`. Both still timed out before `/scenes/move`, disproving that explicit anchor identity alone was sufficient | `FAIL / FIX IN PROGRESS` | Code-path audit found that a snap-resolved no-op leaves `commitDrag` null by design. The fixed 24 px gesture can fall inside the snap tolerance as fit scale/layout changes, so the browser case must control this UI precondition instead of relying on incidental geometry. Next harness gesture turns Snap off through the visible toolbar, verifies `aria-pressed=false`, then drags the explicit selected anchor; node evidence continues to own anchor-snap arithmetic | Run required Chrome locally, commit/push, and dispatch a new exact-SHA Linux/Windows run |
| 2026-08-18 10:50 +07 | 2.5b CI correction 3 | [`Browser session` run 32096629592](https://github.com/alvindev111/vidcom-v2/actions/runs/32096629592), exact SHA `727e3fbc8dcb209accad9fba661dba6f5cdb212a` | Linux x64 [job 95589152325](https://github.com/alvindev111/vidcom-v2/actions/runs/32096629592/job/95589152325): `failure`; Windows x64 [job 95589152478](https://github.com/alvindev111/vidcom-v2/actions/runs/32096629592/job/95589152478): `failure`. Both hit the same pre-request timeout even with Snap visibly disabled | `FAIL / FIX IN PROGRESS` | Snap was not the cause. The platform seam is pointer-capture delivery: the clip preview rerender can lose DOM pointer capture before `pointerup`; the handler previously returned before consulting the authoritative interaction drag. Minimal production correction releases capture only when present but always calls `endDrag`; `endDrag` already rejects a non-owned/no-op gesture by scene id and state. Browser assertion now separately proves preview `left` changed before awaiting the network request. Focused required Chrome 1/1, interaction node 8/8, full Browser session 12/12, typecheck and diff-check PASS locally | Commit/push, then rerun both OS at exact SHA |
| 2026-08-18 10:55 +07 | 2.5b CI correction 4 | [`Browser session` run 32096969160](https://github.com/alvindev111/vidcom-v2/actions/runs/32096969160), exact SHA `42d376fe4a8bc67346139413c781b367bef0fac5` | Linux x64 [job 95590126255](https://github.com/alvindev111/vidcom-v2/actions/runs/32096969160/job/95590126255): `failure`; Windows x64 [job 95590126215](https://github.com/alvindev111/vidcom-v2/actions/runs/32096969160/job/95590126215): `failure`. New assertion proved preview `left` stayed `0px`, so failure precedes pointer-up and the pointer-up workaround is disproven | `FAIL / FIX IN PROGRESS` | Marquee updated the shared selection but left the primary scene on the prior cross-track clip. Pointer-down on the group anchor then changed primary, expanding/collapsing rows during the gesture and moving the target vertically. Minimal correction makes marquee propagate the reducer-owned `anchorSceneId` to primary selection when it completes, so layout settles before group drag; the unproven pointer-up change is reverted. Focused required Chrome 1/1, interaction node 8/8, typecheck and diff-check PASS locally | Run full local Browser session, commit/push, then rerun both OS at exact SHA |
| 2026-08-18 10:58 +07 | 2.5b CI correction 5 | [`Browser session` run 32097226007](https://github.com/alvindev111/vidcom-v2/actions/runs/32097226007), exact SHA `ff58c04a94f45dc2a874d0facd0435ecd77d60e3` | Linux x64 [job 95590817559](https://github.com/alvindev111/vidcom-v2/actions/runs/32097226007/job/95590817559): `failure`, preview remained `0px`; Windows x64 [job 95590817580](https://github.com/alvindev111/vidcom-v2/actions/runs/32097226007/job/95590817580): running when checkpoint written | `FAIL / FIX IN PROGRESS` | Marquee-primary hypothesis did not change Linux and its production change is reverted. Harness had never fixed a viewport even though timeline hit zones and fit scale are pixel geometry; the next correction sets an explicit 1440×1000 desktop viewport before navigation and fails immediately if a 4-second seed clip has no >20 px draggable body. This is test determinism, not a product rule. Focused required Chrome 1/1, typecheck and diff-check PASS locally | Run full local Browser session, commit/push, record Windows final conclusion, and rerun both OS |
| 2026-08-18 11:02 +07 | 2.5b CI correction 6 | [`Browser session` run 32097416882](https://github.com/alvindev111/vidcom-v2/actions/runs/32097416882), exact SHA `464934be014b66fb3d5bf57cc90b538f08532de5` | Linux x64 [job 95591371576](https://github.com/alvindev111/vidcom-v2/actions/runs/32097416882/job/95591371576): `failure`, clip-width guard passed but preview read remained `0px`; Windows x64 [job 95591371717](https://github.com/alvindev111/vidcom-v2/actions/runs/32097416882/job/95591371717): running when checkpoint written | `FAIL / FIX IN PROGRESS` | Geometry hypothesis is disproven and viewport/width changes are reverted. The harness issued CDP mouse movement, immediately read style and released without waiting for React to commit the preview; renderer scheduling differs across OS. `dragTimelineClip` now waits up to 5 seconds for the actual `left` or `width` UI property to change before release. This synchronizes on behavior rather than delay or network timeout. Focused required Chrome 1/1, full Browser session 12/12, typecheck and diff-check PASS locally | Commit/push, record Windows final conclusion, then rerun both OS at exact SHA |
| 2026-08-18 11:05 +07 | 2.5b CI correction 7 | [`Browser session` run 32097637956](https://github.com/alvindev111/vidcom-v2/actions/runs/32097637956), exact SHA `dd4ad0a2b24d579da1b5a58e497548545a108035` | Linux x64 [job 95591990534](https://github.com/alvindev111/vidcom-v2/actions/runs/32097637956/job/95591990534): `failure`, the explicit preview wait itself timed out; Windows x64 [job 95591990342](https://github.com/alvindev111/vidcom-v2/actions/runs/32097637956/job/95591990342): running when checkpoint written | `FAIL / FIX IN PROGRESS` | Renderer timing is not the cause: raw `page.mouse` never reached the target. Unlike locator clicks, it does not auto-scroll an element whose bounding box is outside the viewport. Helper now scrolls the explicit clip anchor to viewport center and waits one animation frame before measuring/dragging, while retaining the preview-condition wait. Focused required Chrome 1/1, typecheck and diff-check PASS locally | Run full local Browser session, commit/push, record Windows final conclusion, then rerun both OS |
| 2026-08-18 11:08 +07 | 2.5b CI diagnostic | [`Browser session` run 32097851057](https://github.com/alvindev111/vidcom-v2/actions/runs/32097851057), exact SHA `eddba0b9211c26d48957a92f9a251cfb9ff48007` | Linux x64 [job 95592563876](https://github.com/alvindev111/vidcom-v2/actions/runs/32097851057/job/95592563876): `failure`, preview wait still timed out after scroll; Windows x64 [job 95592563840](https://github.com/alvindev111/vidcom-v2/actions/runs/32097851057/job/95592563840): running when checkpoint written | `FAIL / DIAGNOSTIC IN PROGRESS` | No further behavioral hypothesis will be applied without event evidence. Harness now captures up to 30 trusted mouse/pointer events at document capture plus target rect, viewport and `elementFromPoint` at the intended press coordinate; on failure the assertion prints this structured, secret-free diagnostic. Focused required Chrome 1/1, full Browser session 12/12, typecheck and diff-check PASS locally | Commit/push diagnostic and run both OS; inspect exact trace before next correction |
| 2026-08-18 11:12 +07 | 2.5b diagnostic result | [`Browser session` run 32098041371](https://github.com/alvindev111/vidcom-v2/actions/runs/32098041371), exact SHA `265c32e9ee6e992ea555878fd68e00aa44de46e4` | Linux x64 [job 95593065717](https://github.com/alvindev111/vidcom-v2/actions/runs/32098041371/job/95593065717): `failure`; Windows x64 [job 95593065757](https://github.com/alvindev111/vidcom-v2/actions/runs/32098041371/job/95593065757): running when checkpoint written | `FAIL / EVIDENCE-BASED FIX IN PROGRESS` | Trace proved target and geometry were correct: rect 79.75×27 at y=435 inside 800×600, hit target `scene-2`, pointerdown delivered with buttons=1. Of the requested three stepped moves, CI delivered only the first pointermove from x=520.5 to 528.5; +8 px is the snap boundary and left remained 0. Harness now sends one trusted final move directly to x+24 instead of relying on intermediate CDP steps, while preserving the preview condition and failure diagnostic. Focused required Chrome 1/1, full Browser session 12/12, typecheck and diff-check PASS locally | Commit/push and rerun both OS at exact SHA |

## Final Authoring-Readiness Audit

- [x] Approval Gate đã `Approved` 2026-08-16; S0 hoàn tất trước production code
- [x] Mọi task có prerequisite, skill/read-first, Requirements và Design reference
- [x] Mọi phase có Deliverables và focused verification; persistence dùng SQLite/temp-fs thật
- [x] Tất cả port/service mới có production composition-root/startup/packaged-artifact task
- [x] Không còn path/symbol không tồn tại được dùng làm điểm sửa bắt buộc
- [x] Coverage matrix phủ R1–R12 và mọi AC suffix; mọi endpoint task/subtask đều tồn tại; R4.1c có đúng bốn phép đo
- [x] Dependency graph không yêu cầu test một capability chưa được phase trước tạo
- [x] Full gate dùng script thật trong `package.json`, browser test mới nằm trong CI script/workflow
- [x] Sáu lệch steering đã có quyết định, phase cập nhật authority và phạm vi approval tường minh;
  agent không phải dừng để hỏi lại trong lúc implement
- [x] Source identity P11 bao phủ staged/unstaged/untracked/deleted/symlink, không tự đổi theo log
  checklist và bắt rerun gate khi digest đổi
- [x] Artifact gate của spec có packaged-smoke step tự chứa, network cut và exact identity; không
  lấy nợ production-release của Packaging làm PASS hoặc blocker giả cho capability Editing
- [x] HTTP/MCP parity chốt bảy tool dùng chung Core/contract; D7 loại undo/redo và D9 defer blob +
  file-manager R5 mà không phát minh absolute-path transport
- [x] Rename `pending`/`inprocess` dùng discovery động với pattern không tự match command audit;
  không hard-code danh sách tham chiếu
- [x] Design bản 12 đã đồng bộ receipt reservation/session/per-entry ownership barrier/ref bound; entity + pending-mount
  undo; change-seq-aware preview latest-wins; staged upload/SVG/font/caption; dependency scheduler
  thumbnail; normalized catalog exact-intent/repeat mount/provenance; shared scene insertion planner.
- [x] Link Markdown đã được kiểm trực tiếp; `bun run test:spec-paths` xanh nhưng chỉ là regression cho
  ba spec cũ, không bị trình bày sai như evidence của Editing Experience. Task 11.5a sở hữu việc đăng ký spec này.
- [x] Approval Gate đã được người dùng chuyển sang `Approved`; S0 đã PASS, task kế tiếp là P0
