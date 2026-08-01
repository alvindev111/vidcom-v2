
---
Spec Review

P1 — Staged index bỏ sót các fix hậu review đã biết.
packages/adapter/src/fs/resolve.ts:83-84 chỉ kiểm allowlist trên path đầu vào, chưa kiểm canonical target; symlink nội-project như assets/x.png → package.json vẫn vượt R6 AC3/AC5–AC7. packages/core/src/service/write-authority.ts:289,319-330,338-340,383-401 chưa abort journal khi filesystem write lỗi, còn trả nullable revision và phân loại missing entity state sai. Working tree đã có fix cùng 8 regression tests nhưng chưa stage, trong khi spec-core-backend-foundation-complete.md:3,83-85 tuyên bố hoàn tất. Cần stage đồng bộ code, tests và spec updates rồi chạy lại toàn bộ gate trước khi commit.

P2 — Spec được đánh dấu Complete trước completion gate “commit pushed”.
spec-core-backend-foundation-implementation-checklist.md:120-124 và toàn bộ 118 task đã [x]; spec-core-backend-foundation-complete.md:3 tuyên bố Complete, nhưng Execution Log tại spec-core-backend-foundation-implementation-checklist.md:757-760 ghi rõ chưa commit. Điều này trái implementation-guide.md:149-154,235-240, quy định [x] chỉ sau test, log và commit pushed. Giữ spec ở inprocess hoặc chưa tick completion cho tới khi review fixes được commit/push.

P2 — 35/118 task thiếu traceability bắt buộc.
Trái implementation-guide.md:41-45, có 4 task thiếu _Requirements và 33 task thiếu _Design: A.5–A.7, D.6, E.6–E.7, F.1, F.5, G.11–G.13, H.8–H.10, I.6–I.7, J.9–J.10, K.3–K.6, K.10, L.8, M.6, N.2, N.3, N.6, N.7, N.9–N.12, O.5–O.6; xem các task từ spec-core-backend-foundation-implementation-checklist.md:153 đến :678. Bổ sung cả requirement và design reference cho từng task trước khi coi coverage hoàn chỉnh.

P2 — Thiếu Skill và Read first trực tiếp trên từng phase.
Checklist chỉ có bảng tổng hợp tại spec-core-backend-foundation-implementation-checklist.md:89-110; các phase header, ví dụ Phase A tại :132-134, chỉ có Addresses/Design/Prerequisite. Cả Phase A–O đều vi phạm spec-rule.md:37-38 và readiness gate implementation-guide.md:39-45. Thêm annotation trực tiếp cho từng phase hoặc sửa process rule trước khi phê duyệt checklist.

P3 — Số bảng migration tự mâu thuẫn.
spec-core-backend-foundation-detailed-design.md:929 và checklist F.3 tại spec-core-backend-foundation-implementation-checklist.md:303-309 chốt 11 bảng ứng dụng, nhưng spec-core-backend-foundation-detailed-design.md:1165-1167 vẫn nói migration 0001 tạo 8 bảng. Sửa thành 11 để design, checklist và migration evidence thống nhất.

P3 — Closeout còn nội dung pre-approval đã lỗi thời.
spec-core-backend-foundation-complete.md:43 nói rule vẫn bắt PostgreSQL, nhưng cùng file :76 nói rule đã sửa. spec-core-backend-foundation-detailed-design.md:4 vẫn ghi checklist “chờ duyệt” dù :1601-1604 đã Approved; :1605-1610 vẫn liệt kê các quyết định còn chờ. spec-core-backend-foundation-detailed-goal.md:297-300 cũng vừa Approved vừa ghi “chờ phản hồi”. Dọn các trạng thái cũ để tài liệu complete không tự mâu thuẫn.

---
Core arch review

High — Workspace selection still guesses ./projects. packages/cli/src/next-host.ts:46 does path.resolve(process.env.VIDCOM_WORKSPACE ?? "projects"); resolveWorkspace() and persisted active workspace are never used in production. Starting without the env var silently selects/creates intent around cwd instead of requesting selection. Violates R3 AC1–AC3.

High — Missing BGM precondition is coerced to revision 0. packages/contracts/src/dto.ts:344-347 uses z.coerce.number(). The route passes form?.get("expectedRevision"), which is null when absent; Zod converts null/"" to 0. Confirmed with a runtime probe. A project without preview-settings.json is seeded at revision 0, so an upload without any precondition succeeds. Violates R5 AC3.

High — Source-write callers can escalate themselves to write-asset. packages/core/src/service/write-authority.ts:126-130 infers purpose solely from the requested path. Thus saveSourceFile() can submit assets/payload.exe; packages/core/src/domain/path-policy.ts:97-99 allows every extension beneath asset roots. This bypasses source extension policy and media magic-byte/staging rules intended only for upload/job flows. Repro path: PUT /api/v1/projects/:id/files with path: "assets/payload.exe" and expectedContentHash: null. Violates R6 AC5–AC6 and design §5.6.

High — Lease can be lost while a write waits on the mutex. packages/core/src/service/write-authority.ts:214-223 calls assertHeld() before queueing on ProjectMutex; it never rechecks after acquiring the mutex. A second request can pass the check, wait behind a slow mutation, then write a different file after the lease expires or another daemon takes it. Violates R5 AC7 and the single-writer guarantee in design §5.5.

High — Scene timing domain invariant is implemented but not enforced. packages/core/src/usecase/project-writes.ts:115-138 sends timing directly to applyOps() and write authority without calling validateSceneTiming() from packages/core/src/domain/invariants.ts:12-40. A patch such as start=7,duration=4 on an 8-second root passes boundary shape validation and can persist a duration overflow instead of returning duration_overflow. Violates design §8.1 and steering 03 §2.1 / 06 §3.

High — Generic composition writes skip required content validation. packages/core/src/service/write-authority.ts:298-324 hashes, journals, and writes content directly; neither dependencies nor code provide a composition validation step. With a correct hash, saveSourceFile() can replace index.html with invalid composition content. Violates R5 AC4 and steering 07 §4 step 3.

Medium — Import-boundary CI has concrete bypasses. eslint.config.mjs:49-62 blocks only node:fs, not valid Node imports fs or fs/promises; it also has no rule for global runtime reads. Runtime lint probes showed import { readFile } from "fs/promises" produced only an unused-import warning and globalThis.setInterval produced zero errors. Existing packages/core/src/service/job-scheduler.ts:27-29 already reads that global state. scripts/verify-import-boundaries.mjs:14-28 tests only Core→adapter. Violates R1 AC2/AC6.

Medium — First write conflict can violate its declared response schema. packages/core/src/service/write-authority.ts:281-290 places latestRevision() directly into current.revision; it can be null for an existing project file before the first mutation. packages/contracts/src/dto.ts:298-304 requires a nonnegative number. A stale hash on such a file produces a 409 payload that fails the committed contract. Violates R5 AC3a and R7 AC6.

---
Fs security review

7 high-severity findings covering symlink allowlist bypass, TOCTOU, unsafe recovery deletion, stored XSS, asset durability, Windows credential exposure, and watcher crashes.
1 medium finding for permanently lost watcher events after transient persistence failure.

---
Server api review

P0: no runnable nonce/bootstrap launch path; clean startup remains unauthenticated.
High: global 1 MiB limit breaks valid 2 MiB source and 20 MiB BGM contracts.
High: runtime guesses <cwd>/projects, violating workspace resolution.
High: scene script endpoint can mutate another scene’s file.
High: UI snapshots never refresh after writes and no SSE client exists.
Medium: SSE payload violates its strict schema; resync omits id.
Medium: missing preconditions and timing invariants map to incorrect error codes/statuses.

---
Db jobs review

1 P0: staged recovery có thể xóa file sai project hoặc ngoài project.
5 P1: scheduler không thức sau startup; mất stage update; thiếu timeout/retry; job event lệch state; lease loss bị bỏ qua.
1 P2: recovery sai khi preview-settings.json chưa tồn tại.

---

Hyperframes review

Highest-confidence findings sent to parent:
P1: generated scenes do not extend root duration.
P1: generate lost scene styling and narration sidecar creation.
P2: ordinary nested <template> elements hijack full-document parsing.
P2: generated scenes use the wrong DOM insertion index.
P2: preview-setting PATCH requests race their own revision precondition.
P2: router.refresh() leaves the client-held studio snapshot stale.

---

Cli packaging review
[P1] Fresh UI launch has no production nonce/bootstrap path — packages/cli/src/next-host.ts:42-44, packages/cli/package.json:6
The host only consumes VIDCOM_BOOTSTRAP_NONCE, but staged production code never issues that nonce, calls bindLoopback, opens /?t=..., or exposes a CLI bin. Root dev/start still launches Next directly. Runtime: open fresh app → ensureBrowserSession() sees no t → GET /api/v1/projects → 401 forever. This violates R8 AC4’s CLI→browser exchange and R13 AC4’s list/open milestone. Add a real CLI/daemon entrypoint that selects workspace, starts the listener, issues/registers the nonce, opens the URL, and owns shutdown.

[P1] Next host guesses <cwd>/projects instead of resolving workspace identity — packages/cli/src/next-host.ts:46
With no environment variable, every Next process silently chooses path.resolve("projects"); active workspace settings and marker validation are bypassed. A packaged launch from another cwd will expose an empty/wrong directory instead of requesting selection. This directly violates R3 and steering 07’s explicit → active → marker-backed cwd → selection_required order.

[P1] The production scheduler stops polling after startup — packages/cli/src/next-host.ts:64
runAvailable() is called once. If the queue is empty then, a later JobStore.enqueue() has no notifier or polling loop to call it again, so the job remains queued until restart. The E2E test masks this by constructing a second scheduler and manually calling runAvailable(). R11 requires the in-process scheduler to process newly enqueued work. Add a queue wake-up/continuous scheduler lifecycle and test enqueue-after-startup through the production instance.

[P1] Lease-loss transition is discarded — packages/cli/src/startup.ts:92
renew() returns false when ownership is lost, but the interval ignores both that result and rejection. Runtime: daemon B steals an expired lease → daemon A’s renew returns false → A keeps its sessions/scheduler/watcher active; writes eventually fail through assertHeld, but revokeAll() and the reviewed Lost-state transition never happen. Design §5.12 explicitly requires “stop accepting mutations + revoke all sessions, reads remain available.”

[P1] Startup/shutdown does not unwind listener and watcher lifecycles — packages/cli/src/startup.ts:140-150
stop() never closes the returned listener. On listener bind failure after watcher.start(), the catch path destroys SQLite but never closes the watcher. Intended standalone sequence: watcher opens → listener fails → watcher keeps the process alive and may dispatch into a destroyed DB. On successful shutdown, HTTP may remain bound after lease/DB teardown. Use an unwind stack: stop accepting HTTP, stop scheduler/jobs, close watcher, clear renewal, release lease, then destroy DB; apply the same reverse cleanup on partial startup failure.

[P2] Listener app-factory failures escape the bind promise — packages/server/src/listener.ts:41
If appSource(address.port) throws after the socket starts listening, the exception escapes the event callback; the promise is not rejected with LoopbackBindError, and the bound server is not closed. Wrap factory construction and close/reject on failure.

Verification: targeted CLI/security/Next routing suites passed, 25/25 tests; git diff --cached --check passed. These findings are lifecycle/integration gaps not covered by those tests.
No new Node SEA incompatibility was found in the staged production packages: Bun-only APIs are lint-blocked and nativeDependenciesRoot is injectable. Full SEA artifact/extraction/signing/platform smoke remains correctly deferred to Phase 4; prior Phase-0 proof is bounded to macOS arm64.

---

Tests ci review

P0 — Clean CI cannot reach tests/build. Root workspace includes only packages/* ([package.json (line 6)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/package.json:6)), while root TypeScript includes every **/*.ts, including spikes/phase-0/** ([tsconfig.json (line 33)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tsconfig.json:33)). CI installs only the root workspace then typechecks ([ci.yml (line 32)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/.github/workflows/ci.yml:32)). The spike’s dependencies live in its separate package/lockfile ([spikes/phase-0/package.json (line 11)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/spikes/phase-0/package.json:11)). An isolated index checkout fails typecheck/build on missing spike dependencies. Exclude spikes from root tsconfig/build or install/typecheck them as a separate workspace/job.

P1 — Import-boundary CI proves only one forbidden edge. Core’s rule bans a small denylist ([eslint.config.mjs (line 42)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/eslint.config.mjs:42)); it does not enforce “Core may depend only on contracts/ports.” The negative script checks only @vidcom/adapter ([verify-import-boundaries.mjs (line 14)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/scripts/verify-import-boundaries.mjs:14)). Runtime proof with the staged config: node:sqlite, @vidcom/server, @vidcom/worker, and process.cwd() in a Core file all produce errorCount=0. Use an allowlist or complete deny rules and add negative cases for Node built-ins, transports, and runtime globals.

P1 — Declared valid payload sizes are rejected before route validation. Global body limit is 1 MiB ([app.ts (line 52)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/packages/server/src/app.ts:52)), while contracts accept source content up to 2 MiB ([dto.ts (line 287)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/packages/contracts/src/dto.ts:287)) and BGM up to 20 MiB ([dto.ts (line 344)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/packages/contracts/src/dto.ts:344)). A real 2 MiB multipart BGM request returned 413 too_large. Existing coverage uploads only four bytes ([write-cutover.test.ts (line 100)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tests/server/write-cutover.test.ts:100)). Configure per-route limits including encoding overhead and test below/above each advertised boundary.

P1 — Path tests miss an exploitable allowlist bypass. Resolver authorizes the client path after canonicalization, not the canonical target ([resolve.ts (line 76)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/packages/adapter/src/fs/resolve.ts:76), [resolve.ts (line 83)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/packages/adapter/src/fs/resolve.ts:83)). Tests cover only symlinks escaping the project ([fs.test.ts (line 58)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tests/adapter/fs.test.ts:58)). Staged-index repro: assets/cover.png -> ../package.json resolves successfully to package.json under read-asset. Re-check purpose against the canonical relative target and add protected-file symlink fixtures.

P1 — R12 AC8’s “Next SSE” test bypasses Next. The test calls handleNextHostedRequest() directly ([events.test.ts (line 141)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tests/server/events.test.ts:141), [events.test.ts (line 152)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tests/server/events.test.ts:152)); it never exercises the staged Next route, hono/vercel adapter, network buffering, or reconnect/resume. A broken catch-all export could still pass. Run this through a real Next server and assert replay/resume plus no-buffer behavior.

P2 — The milestone “e2e” bypasses production lifecycle wiring. Recovery, scheduler, watcher, and listener hooks are all no-ops ([foundation-milestone.test.ts (line 49)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tests/e2e/foundation-milestone.test.ts:49)); the test constructs Hono in memory and manually enqueues/runs jobs ([foundation-milestone.test.ts (line 95)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tests/e2e/foundation-milestone.test.ts:95), [foundation-milestone.test.ts (line 122)](/Users/dinh-ai/Documents/workspace/coding/vidcom-v2/tests/e2e/foundation-milestone.test.ts:122)). Keep it as integration coverage, but add a real supported-runtime smoke test before treating R13 AC4 as automated.

---

## Resolution — phiên remediation 2026-08-01

| Nhóm finding | Trạng thái | Bằng chứng hiện hành |
|---|---|---|
| Spec state, traceability, Skill/Read-first, 11-table wording, stale approval text | Resolved | Main spec đã trả về `inprocess` trong lúc sửa; script audit xác nhận đúng 118 task, 0 task thiếu Requirements/Design và 15/15 phase có annotation trực tiếp. Detailed Goals/Design đã dọn trạng thái chờ cũ. |
| Symlink allowlist, TOCTOU, source privilege escalation, nullable revision, journal abort, missing entity state | Resolved | `resolve.ts` authorize cả input và canonical target; WriteAuthority re-resolve/re-hash ngay trước write, recheck lease sau mutex, source mặc định `write-source`, revision mặc định 0 và abort đúng pre-write failure. Regression nằm ở `fs.test.ts`, `write-authority.test.ts`, `write-cutover.test.ts`. |
| Staged recovery, asset durability, missing settings, credential ACL, stored preview injection | Resolved | Recovery chỉ chấp nhận temp thật trong app-data và target qua project identity/allowlist; asset stage fsync/no-overwrite; thêm case preview settings biến mất. Credential POSIX/Windows và escaping preview đã có integration/contract coverage. |
| Watcher crash và transient persistence failure | Resolved | Watcher retry persistence, bắt lỗi tạo/`error`, đóng handle lỗi, restart có debounce và huỷ restart khi shutdown; regression dùng watcher giả phát `error`. |
| Workspace, CLI bootstrap, scheduler lifecycle, lease transition, cleanup, listener factory | Resolved | Production dùng explicit → active → marker-backed cwd → selection required; CLI bin sinh nonce 32 byte và mở URL; scheduler polling liên tục; lease loss dừng background/revoke session; listener/scheduler/watcher cleanup được test ở success và partial failure; app-factory throw đóng socket. |
| Timing/content/scene/template/script invariants và UI write races | Resolved | Timing gọi domain invariant; generic source chạy `CompositionHf.validateSource`; scene ownership, nested template, root duration, insertion index, serialized preview PATCH và snapshot/SSE refresh đã có code/test; generated scene nay có style và narration assertion. |
| Jobs stage/timeout/retry/event authority | Resolved | Scheduler có timeout + bounded transient-only retry với exponential backoff; stage-only update được persist, `retrying` được ghi trước khi emit và event đọc lại persisted state. Enqueue-after-startup được production polling xử lý. |
| Payload limits và error mapping | Resolved | Source/BGM dùng contract constants 2 MiB/20 MiB, middleware dành encoding overhead, quá giới hạn trả 413; test thật chấp nhận đúng boundary và từ chối byte kế tiếp; BGM null/empty revision không còn thành 0. |
| Boundary/clean checkout/Drizzle-only | Resolved | Root TS loại `spikes/**`; boundary probe phủ bare Node builtins, runtime globals và các package cấm; production scan chặn Kysely. Persistence là Drizzle trực tiếp trên `node:sqlite`; `drizzle-kit generate` báo không drift. |
| Real Next/SSE/runtime milestone | Resolved | CI chạy `scripts/verify-next-runtime.mjs` sau build qua `next start` thật: nonce exchange, workspace list, watcher, no-buffer SSE và reconnect `Last-Event-ID`. GitHub Actions run `30706454500` của commit `c8828a8` đã Success. |

Local gate: frozen install không đổi lockfile; typecheck, lint (0 error), boundary, **32 file/180 test**, production build, real Next runtime smoke và Drizzle schema-drift đều xanh.
