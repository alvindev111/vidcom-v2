# Delivery Loop — Multi-agent Raw Review

- Ngày: 2026-08-05
- Chế độ: read-only
- Nội dung: raw outputs từ các agent review

## Agent 1 — Surfaces, contracts và release

### RAW OUTPUT

# RAW REVIEW — Delivery Loop Surfaces, Contracts và Release

## Phạm vi

Review read-only các phần:

- HTTP delivery-loop routes, middleware, auth/CORS/host check, body limit, Range/ETag, error mapping.
- MCP delivery-loop tools, strict schema, audit ownership, protocol-era behavior.
- Agent-kit bundle/installer/host semantics.
- Diagnostics, scene timing, narration cues.
- Contract/integration tests, fixture audit, CI/release gates.
- Độ trung thực của implementation checklist và implementation notes.

Không sửa file. `git status --short` không có thay đổi.

## Commands / verification

- Dùng nhiều truy vấn `rtk codegraph explore ...` trước khi dùng `rg`/đọc file để dựng call path.
- Đọc detailed design, checklist, implementation notes và steering liên quan.
- `rtk npm run test:spec-paths`
  - PASS: `Verified 80 Verification Matrix test paths across 2 specs.`
- Focused Vitest:
  - `tests/server/delivery-loop-routes.test.ts`
  - `tests/adapter/scene-ripple-narration.test.ts`
  - `tests/adapter/agent-kit-installer.test.ts`
  - Không chạy được test nào vì môi trường thiếu physical package `zod`; đây là lỗi dependency của workspace hiện tại, không được tính là code regression.
- Không cài dependency.

---

## Findings

### HIGH — PATCH một narration cue phá metadata và làm im lặng audio của mọi cue

**Vị trí**

- `packages/core/src/usecase/project-writes.ts:777-789`
- `packages/core/src/usecase/project-writes.ts:803-822`
- Claim liên quan: `spec-project-delivery-loop-implementation-checklist.md:751`

**Bằng chứng / call path**

```text
HTTP PATCH /narration-cues/:cueId
→ patchNarrationCue()
→ đọc toàn bộ current cues
→ chỉ giữ cueId/text/voice/offsetSeconds
→ replaceNarrationCues()
→ initialCue() cho TẤT CẢ cue
```

`replaceNarrationCues()` dựng lại mỗi cue bằng `initialCue()`. Vì vậy các field hiện có bị mất:

- `durationSeconds`
- `staleSince`
- `status`
- `audioPath`
- `words`
- `wordTimingSource`
- metadata engine/command liên quan

Mọi cue được đưa về `status: "mock"` và `durationSeconds: null`, kể cả cue không được patch.

**Tác động**

Chỉ sửa text/voice/offset của một cue có thể khiến narration đã generate của tất cả cue trong scene biến mất khỏi preview/render. Adapter narration bỏ cue `mock`, nên WAV vẫn còn trên đĩa nhưng không được mount.

Checklist đánh dấu N.5 `[x]` — “sửa đúng một cue → cue khác không bị stale” — nhưng code hiện còn phá mạnh hơn stale: metadata generated của cue khác bị reset.

**Edge case / tái hiện**

1. Tạo sidecar v2 có hai cue, cả hai `status:"generated"`, có `audioPath`, `durationSeconds`, `words`.
2. PATCH cue đầu với `offsetSeconds` mới và hash đúng.
3. Đọc sidecar sau PATCH.
4. Cả hai cue trở thành `mock`; duration/word timing biến mất.

**Test thiếu**

- Không có integration test PATCH đúng một cue rồi chứng minh byte/metadata của cue còn lại giữ nguyên.
- `tests/adapter/scene-ripple-narration.test.ts:188-230` chỉ kiểm `setSceneScript` đánh stale đúng cue.
- N.8 chỉ kiểm legacy normalization và nhiều `<audio>`, không kiểm PATCH.

**Sửa tối thiểu**

Không gọi public replace-path làm mất metadata. Khi patch:

- Preserve nguyên object của cue không được chọn.
- Preserve metadata của cue được chọn nếu chỉ đổi offset.
- Nếu đổi text/voice, chỉ cue đó chuyển stale theo policy; không reset cue khác.
- Thêm một integration test sidecar hai cue generated.

---

### MEDIUM — Agent-kit trả absolute workspace path qua HTTP và MCP

**Vị trí**

- `packages/core/src/usecase/agent-kit-install.ts:191-202`
- `packages/server/src/routes/delivery-loop.ts:243-247`
- `packages/mcp/src/registry/delivery-loop-tools.ts:126-133`

**Bằng chứng**

`AgentKitInstaller.inspect()` gọi `resolveWorkspace()` rồi nội suy `resolvedMain.value` và `resolvedAuxiliary.value` vào `installationState.recovery[].detail`.

Giá trị đó là absolute path. Output được trả nguyên qua:

- `POST /api/v1/agent-kit/install`
- MCP `install_agent_kit`

Điều này lệch security steering: endpoint/tool không được rò absolute path hoặc runtime-internal path trong response.

**Tác động**

AI host, transcript, telemetry hoặc UI có thể nhận tên user và layout filesystem cục bộ, ví dụ:

```text
Merge C:\Users\<name>\Videos\workspace\AGENTS.vidcom.md into ...
```

**Edge case / tái hiện**

Workspace có `AGENTS.md` foreign và router VidCom còn nguyên. Gọi install Codex; recovery `manual_merge` chứa hai absolute path.

**Test thiếu**

`tests/adapter/agent-kit-installer.test.ts` kiểm state/outcome/link/rollback nhưng không assert output không chứa workspace root.

**Sửa tối thiểu**

Dùng `AGENTS.md`, `AGENTS.vidcom.md`, `CLAUDE.md`, `CLAUDE.vidcom.md` dạng relative path trong `detail`. Absolute resolved path chỉ dùng nội bộ cho containment/I/O.

---

### MEDIUM — Agent-kit có thể commit thành công nhưng trả lỗi retryable sau bước inspect

**Vị trí**

- `packages/core/src/usecase/agent-kit-install.ts:118-140`
- `packages/mcp/src/registry/registry.ts:212-233`

**Bằng chứng / call path**

```text
mutateWorkspace() commit thành công
→ journal/audit đã sở hữu success
→ AgentKitInstaller.inspect() chạy lần hai
→ read/resolve lỗi
→ apply() trả DomainError
→ Registry trả lỗi cho caller
```

Cơ chế `committed_response_error` trong Registry chỉ xử lý output parse failure. Nó không xử lý handler tự trả lỗi sau khi mutation đã commit.

**Tác động**

Caller thấy lỗi thông thường và có thể retry dù batch đã được áp dụng. Retry replace/link thường trở thành conflict; trạng thái người dùng khó hiểu và audit nói success trong khi response nói failure.

**Edge case**

Permission/antivirus/external mutation làm một file không đọc được ngay sau khi batch publish hoàn tất.

**Test thiếu**

Fault-injection hiện chỉ kiểm publication fail giữa batch và rollback; không có lỗi ở post-commit inspection.

**Sửa tối thiểu**

Nếu post-commit inspect lỗi sau khi `writes.length > 0`, trả `committed_response_error` với `committed:true`, `changedFiles` và hướng dẫn không retry mutation; hoặc tạo output state từ dữ liệu commit mà không cần một lượt I/O có thể fail.

---

### MEDIUM — Unsatisfiable Range bị biến thành download toàn bộ MP4; cache policy thiếu

**Vị trí**

- `packages/server/src/routes/delivery-loop.ts:92-114`
- Test hiện có: `tests/server/delivery-loop-routes.test.ts:287-330`

**Bằng chứng**

`range()` trả `null` cho cả hai trường hợp:

- Không có `Range`.
- `Range` có nhưng unsatisfiable, ví dụ `bytes=999-1000` cho file 6 byte.

`bytesResponse()` coi mọi `null` là full response `200`, nên client yêu cầu range ngoài file lại nhận toàn bộ video.

Header chung cũng không có `Cache-Control: must-revalidate`, trái cache policy cho project asset.

**Tác động**

Media player/resume client có thể tải lại toàn bộ MP4 lớn thay vì nhận `416`. Với request lặp, chi phí memory/bandwidth tăng đáng kể.

**Test thiếu**

Test chỉ phủ:

- Range hợp lệ `bytes=2-4`.
- Exact `If-None-Match`.

Thiếu:

- Start ngoài EOF.
- Suffix zero.
- Empty file.
- Invalid end/start.
- `Content-Range: bytes */<size>` khi `416`.
- Cache-Control.

**Sửa tối thiểu**

Phân biệt `absent`, `valid`, `unsatisfiable`. Trả `416` và `Content-Range: bytes */${size}` cho unsatisfiable range; thêm `Cache-Control: must-revalidate`.

---

### MEDIUM — HTTP boundary chưa thực hiện đầy đủ strict validation đã claim

**Vị trí**

- `packages/server/src/routes/delivery-loop.ts:73-86`
- `packages/server/src/routes/delivery-loop.ts:130-131`
- `packages/server/src/routes/delivery-loop.ts:179-229`
- `packages/server/src/app.ts:61-83`

**Bằng chứng**

- `json()` parse body nhưng không cưỡng chế `Content-Type: application/json`.
- `jobId()` chỉ kiểm non-empty rồi cast branded type.
- `slug`, `sceneId`, `cueId`, `entryId` lấy trực tiếp từ `c.req.param()` rồi cast/chuyển xuống Core.
- Chỉ `projectId` dùng `ProjectParamsSchema`.

Điều này lệch steering 04/06: body, header có nghĩa và mọi path param phải validate bằng contract schema.

**Tác động**

Boundary behavior không nhất quán; malformed/overlong identifiers có thể đi sâu tới filesystem lookup, registry lookup hoặc DB query rồi trả `404/422` thay vì `400 schema_invalid`. Content-type sai vẫn có thể được chấp nhận.

Path containment hiện vẫn giảm rủi ro traversal cho narration path, nên chưa thấy đường thoát workspace trực tiếp.

**Test thiếu**

Không có bảng negative HTTP contract cho mọi path param và content type.

**Sửa tối thiểu**

Thêm strict param schemas dùng chung trong contracts và một helper parse params. Reject JSON route khi media type không phải `application/json`.

---

### MEDIUM — Checklist O.8/O.9 và N.5 được tick cao hơn mức bằng chứng thực tế

**Vị trí claim**

- `spec-project-delivery-loop-implementation-checklist.md:751`
- `spec-project-delivery-loop-implementation-checklist.md:819-820`
- `implementation-notes.html:227-235`

**Bằng chứng**

- N.5 bị code hiện tại vi phạm như finding HIGH.
- O.9 ghi “Integration: mã lỗi đúng status”, nhưng `tests/server/delivery-loop-routes.test.ts:111-127` chỉ gọi trực tiếp `errorStatus()`; không gửi request qua middleware/route/error mapper.
- O.8 ghi HTTP và MCP gọi cùng usecase. Test được notes viện dẫn tạo scene qua HTTP rồi sửa timing qua MCP — hai thao tác khác nhau. Nó chứng minh cùng runtime, không trực tiếp chứng minh cùng operation không có đường thứ hai.
- Notes Phase O nói “toàn bộ delivery loop” và “Không có design drift”, trong khi negative Range, strict path/header boundary và cue PATCH chưa được phủ.

**Tác động**

Checklist đóng release dù một acceptance claim quan trọng về narration sai và HTTP error integration chưa thật sự được chứng minh.

**Sửa tối thiểu**

- Mở lại N.5 cho tới khi có regression test hai cue generated.
- Đổi O.9 thành integration request table thực sự đi qua `createServerApp().fetch()`.
- Với O.8, gọi cùng một operation qua HTTP và MCP trên hai fixture tương đương rồi so mutation/audit/result semantics.

---

### LOW — “Release gate ba OS” không phải pre-merge gate trên pull request

**Vị trí**

- `spec-project-delivery-loop-implementation-checklist.md:889`
- `.github/workflows/ci.yml:4-5`
- `.github/workflows/ci.yml:37-43`

**Bằng chứng**

Checklist S.6 claim toàn bộ release gate xanh trên cả ba OS. Workflow CI pull request chỉ chạy Linux + Windows; macOS chỉ chạy push vào `main` hoặc manual dispatch.

Implementation log có run IDs ba OS, gồm remediation run `30967371231` và `30967371235`, nhưng repository workflow không ngăn merge dựa trên macOS trong mọi PR.

**Tác động**

Claim lịch sử có thể đúng cho commit đã ghi, nhưng guarantee liên tục “mọi release change được chặn trước merge trên ba OS” không được workflow tự cưỡng chế.

**Sửa tối thiểu**

Hoặc:

- Ghi rõ S.6 là gate trước release/tag, không phải trước merge; hoặc
- Bắt buộc manual three-OS dispatch/check trước closeout/release.

---

## Claim lệch spec/checklist tổng hợp

| Claim | Kết quả review |
|---|---|
| N.5 sửa đúng một cue, cue khác không bị stale | Sai; PATCH reset metadata của mọi cue |
| N.8 là verification đủ cho toàn R11 | Chưa đủ; không phủ PATCH metadata preservation |
| O.8 HTTP/MCP gọi cùng usecase | Code nhìn chung dùng Core chung, nhưng test được viện dẫn không chứng minh cùng operation |
| O.9 integration error/status | Chỉ test mapper trực tiếp, chưa phải route integration |
| O.5 Range + ETag | Happy path có; unsatisfiable range và cache policy thiếu |
| Q agent-kit không rò path nội bộ | Không đạt; recovery detail chứa absolute path |
| S.6 ba OS | Có evidence log lịch sử; PR gate hiện chỉ hai OS |

---

## Các phần đã kiểm tra và chưa thấy lỗi đáng báo

- Middleware order đúng:
  `requestId → logger → hostCheck → cors → auth → bodyLimit → routes → errorMapper`.
- `hostCheck` đứng trước auth.
- Browser endpoints dùng session cookie; MCP path dùng bearer credential.
- Body limit tường minh:
  - regular 1 MiB
  - source theo `MAX_SOURCE_BYTES`
  - BGM theo `MAX_BGM_BYTES`
- Error mapping tập trung tại `error-mapper.ts`; shape `ErrorDetail` được giữ thống nhất.
- Render download dùng `readAsset(..., "read-asset")`, nên artifact path vẫn qua allowlist/containment.
- MCP Registry:
  - Tool định nghĩa một lần.
  - Sort deterministic theo tên.
  - Strict input và output validation.
  - Legacy visibility filter có thật.
  - Protocol version được đưa vào audit context.
- Năm delivery-loop tool được register đúng một lần; `get_job_status` được mở rộng ở descriptor hiện có.
- Contract matrix thực sự đăng ký production descriptors và chạy hai era trên HTTP + stdio.
- Agent-kit:
  - Selected-host manifest.
  - Không ghi đè foreign/newer trong install.
  - Link chỉ Claude.
  - No-change MCP có audit-only workspace operation.
  - Batch rollback có fault-injection test.
- Diagnostics:
  - `forEntry()` không parse composition và không ghi `.vidcom`.
  - `forProject()` dùng derived mutation, không tăng source revision.
  - Lint unavailable được nêu rõ, không trả diagnostics rỗng im lặng.
  - Internal diagnostics và platform/missing-asset families có test đáng kể.
- Scene timing:
  - Ripple chỉ trong cùng track.
  - Chặn ripple đổi track.
  - Root/runtime overflow có structured discriminator.
- Fixture audit có execution log và regression cho marker mới/candidate cũ.
- `test:spec-paths` xác nhận toàn bộ đường test trong matrix tồn tại.

---

## Chưa xác minh

- Không tái chạy được focused/full Vitest, typecheck hoặc runtime smoke vì workspace thiếu physical `zod` và các dependency runtime khác. Kết quả import failure không được quy thành bug implementation.
- Không xác minh độc lập GitHub Actions run IDs hoặc nội dung log remote; chỉ xác nhận repository ghi nhất quán việc mở lại S.6 rồi đóng lại sau remediation.
- Không chạy packaged binary/smoke trên máy sạch.
- Không kiểm chứng release branch-protection rules ngoài nội dung workflow trong repository.

---

## Agent 3 — Jobs, process supervision và security

### RAW OUTPUT

# RAW review — Delivery Loop: jobs, process supervision, render/snapshot, runtime asset guard và security

## Phạm vi và cách kiểm tra

Review chỉ đọc, không sửa file.

Đã đối chiếu:

- `spec-project-delivery-loop-detailed-design.md`, tập trung §4.3.2, §4.4.2, §5.8–5.13, §5.20, §9.2, Decision 11–13, Testing Strategy.
- `spec-project-delivery-loop-implementation-checklist.md`, tập trung Phase F–J, M và S.
- Code thực tế của process supervisor, scheduler/job store, render root, runtime guard, render/snapshot runner, render-project staging, thumbnail và MCP delivery tools.
- Call paths qua CodeGraph trước khi đọc/search file.

Lệnh chính:

```text
rtk codegraph explore "spec-project-delivery-loop implementation ProcessSupervisorPort ..."
rtk codegraph explore "NodeProcessSupervisor ... JobScheduler ..."
rtk codegraph explore "FsRenderRootAdapter ... recoverRenderRoots ..."
rtk codegraph explore "createRenderJobHandler and createSnapshotJobHandler ..."
rtk codegraph explore "GuardCallbackServer RuntimeAssetGuardAdapter ..."
rtk codegraph explore "SqliteJobStore enqueue ... idempotency concurrency"
rtk rg ... các spec, implementation và test liên quan
rtk bunx vitest run tests/adapter/process-supervisor.test.ts tests/adapter/render-root.test.ts tests/adapter/remote-asset-guard.test.ts tests/adapter/render-job.test.ts tests/adapter/snapshot-job.test.ts --reporter=dot
```

Focused Vitest không nạp được test nào vì workspace thiếu dependency vật lý `zod`:

```text
Cannot find package 'zod' imported from packages/core/src/usecase/project-identity.ts
Test Files 5 failed; Tests no tests
```

Không cài dependency.

---

## Findings

### HIGH — Cancel có thể thắng sau khi artifact đã publish, tạo trạng thái `cancelled` nhưng MP4/snapshot đã tồn tại

**Vị trí**

- `packages/worker/src/render-job.ts`, publication barrier ngay trước `mutateDerived`, khoảng dòng 378–393.
- `packages/worker/src/snapshot-job.ts:429-457`.
- `packages/core/src/service/job-scheduler.ts:261-277`.

**Bằng chứng / call path**

```text
JobScheduler.execute
  → definition.run
    → context.throwIfCancelled()
    → authority.mutateDerived(...)   // mutation có thể kéo dài
    → return success
  → context.throwIfCancelled()       // scheduler kiểm tra lại sau handler
  → finish(...)
```

Render/snapshot chỉ kiểm tra cancel trước khi gọi composite mutation. Nếu `requestCancel` đến sau lần kiểm tra đó nhưng trong lúc `mutateDerived` đang commit, artifact vẫn được publish. Khi handler trả về, scheduler kiểm tra lại và ném `JobCancelledError`, sau đó ghi `cancelled`.

Test được đánh dấu F.19 chỉ chặn trước `throwIfCancelled()` rồi cancel; test không giữ execution bên trong `mutateDerived`, nên không bao phủ cửa sổ nguy hiểm này.

**Tác động**

- Vi phạm trực tiếp contract Design §5.9: không được có “artifact đã publish nhưng job cancelled”.
- Client thấy cancelled và có thể retry, trong khi artifact/derived revision đầu đã tồn tại.
- Audit, cleanup và UX báo sai sự thật.

**Tái hiện**

Cho `mutateDerived` dừng ở barrier sau khi đã bắt đầu; gửi cancel; cho mutation commit và trả về. Job sẽ đi vào nhánh cancelled ở scheduler dù artifact đã được ghi.

**Test thiếu**

- Cancel đúng lúc `mutateDerived` đang commit.
- Cancel sau publication commit nhưng trước handler return.
- Xác nhận terminal state và artifact không thể mâu thuẫn.

**Sửa tối thiểu**

Thêm publication barrier có CAS bền: trước commit, atomically kiểm tra cancel và chuyển job sang trạng thái/flag “publishing”; sau khi barrier thắng, cancel muộn phải là `no_change`. Không thể sửa chỉ bằng thêm một `throwIfCancelled()` nữa.

---

### HIGH — Scheduler timeout ghi terminal trước khi process supervisor hoàn tất kill/verify và release

**Vị trí**

- `packages/core/src/service/job-scheduler.ts:261-268`
- `packages/core/src/service/job-scheduler.ts:282-329`
- Render/snapshot timeout đều 30 phút, cùng ProcessSupervisor timeout.

**Bằng chứng / call path**

Scheduler dùng:

```ts
await Promise.race([
  definition.run(...),
  timeoutPromiseThatAbortsAndRejectsImmediately,
]);
```

Khi timeout:

1. `controller.abort()` được gọi.
2. Timeout promise reject ngay.
3. Scheduler đi thẳng vào catch, cleanup/retry/fail.
4. `definition.run` vẫn chạy nền; ProcessSupervisor mới bắt đầu capture/kill/verify và runner chưa release render root.

Render/snapshot không khai `definition.cleanup`, nên scheduler có thể persist `failed`, xóa active slot và cho job kế tiếp chạy trước khi child tree được xác minh hoặc root được release.

Test timeout hiện tại còn củng cố hành vi sai: handler là `new Promise(() => {})`, và test chỉ đòi scheduler tự kết thúc; không kiểm tra resource/process còn sống.

**Tác động**

- Job terminal trước termination proof.
- `cleanupPending` có thể bị ghi `false` dù root release sau đó thất bại.
- `stop()/waitForIdle()` có thể trả về trong khi handler/process còn chạy.
- Với job idempotent, retry có thể chạy song song invocation cũ.
- Với render/snapshot, slot concurrency được giải phóng sớm.

**Edge case**

Scheduler timeout được arm trước prepare/probe/stage, trong khi supervisor timeout chỉ được arm khi child spawn. Vì vậy scheduler gần như luôn timeout trước supervisor.

**Test thiếu**

- Handler bắt abort, mất 100–500 ms để kill/verify rồi mới settle; assert job còn `running` đến lúc proof hoàn tất.
- Timeout + release thất bại phải persist `cleanupPending`.
- `waitForIdle` không được trả khi handler abort-aware chưa settle.

**Sửa tối thiểu**

Khi scheduler timeout, set `abortReason` và abort, nhưng chờ handler settle trong một termination-grace có giới hạn. Chỉ persist terminal/retry sau khi handler trả proof/cleanup metadata. Nếu grace cạn, fail `process_termination_unverified` thay vì coi invocation đã kết thúc.

---

### HIGH — Process supervisor có thể kill nhầm process không liên quan do PID reuse

**Vị trí**

- `packages/adapter/src/runtime/process-supervisor.ts:101`
- `packages/adapter/src/runtime/process-supervisor.ts:112-124`

**Bằng chứng**

Supervisor tích lũy số PID thuần trong `Set<number>` suốt một render dài. Khi cancel, nó kill mọi PID từng quan sát, rồi probe/kill lại theo số PID. Không lưu process creation time/start identity.

Một Chromium helper có thể thoát sớm; OS tái sử dụng PID đó cho process khác trong thời gian render còn chạy. Lúc cancel, VidCom sẽ `SIGKILL`/`taskkill /F` process mới không thuộc job.

**Tác động**

- Có thể terminate ứng dụng/process khác của cùng máy.
- Đây là security/safety issue, đặc biệt với render dài và máy có churn process cao.
- Proof cũng có thể báo survivor giả do PID đã tái sử dụng.

**Test thiếu**

Fixture hiện ngắn và chỉ kiểm tra leak; không mô phỏng PID reuse hoặc identity mismatch.

**Sửa tối thiểu**

Capture identity `(pid, creation/start time)` và xác minh identity trước mọi kill/probe. Windows CIM có thể lấy `CreationDate`; POSIX cần primitive ổn định tương đương. Nếu không chứng minh identity, không kill PID đó và trả proof không exhaustive/unverified.

**Design gap**

Detailed Design yêu cầu tích lũy PID nhưng chưa khóa chống PID reuse; đây là lỗi trong chính contract thiết kế, không chỉ implementation.

---

### HIGH — Primitive Windows không có timeout; cancel/verify có thể treo vô hạn

**Vị trí**

- `packages/adapter/src/runtime/process-supervisor.ts:170-184` — PowerShell CIM.
- `packages/adapter/src/runtime/process-supervisor.ts:220-231` — `taskkill`.
- `packages/adapter/src/runtime/process-supervisor.ts:233-249` — `tasklist`.

**Bằng chứng**

Các `execFileAsync` không truyền `timeout`. Design §5.9 yêu cầu `Get-CimInstance` có timeout riêng và vắng mặt phải degrade, nhưng implementation có thể chờ vô hạn nếu CIM/WMI, `taskkill` hoặc `tasklist` treo.

`PROCESS_VERIFY_MAX_SWEEPS` không tạo bound thực tế vì từng sweep có thể không bao giờ trả về.

**Tác động**

- Cancel không settle.
- Daemon stop treo.
- Job giữ active slot và heartbeat mãi.
- Kết hợp với scheduler timeout finding trên, DB có thể đã ghi failed trong khi child handler treo nền.

**Test thiếu**

- Enumerator/kill/probe command bị treo.
- Fallback/degraded proof khi command quá timeout.

**Sửa tối thiểu**

Đặt timeout cứng cho từng primitive; enumerate timeout → `exhaustive:false`, kill/probe timeout → proof unverified, không giả định process đã chết.

---

### HIGH — Default idempotency key của MCP làm render/snapshot bị “đóng băng” qua mọi source revision

**Vị trí**

- `packages/mcp/src/registry/delivery-loop-tools.ts:82-84`
- `packages/mcp/src/registry/delivery-loop-tools.ts:105-107`
- `packages/adapter/src/db/job-store.ts:268-273`

**Bằng chứng**

Khi caller không gửi key:

```ts
render:${hash({ projectId, bestEffort, renderPresetId })}
snapshot:${hash({ projectId })}
```

Key không chứa `sourceRevision` hay request nonce. Job store tìm idempotent theo `(projectId, type, idempotencyKey)` không giới hạn trạng thái/thời gian.

Sau một render/snapshot đầu tiên, mọi call mặc định cùng project sẽ trả lại job cũ, kể cả sau khi project đã chỉnh sửa.

**Tác động**

- Agent tuân thủ tool bình thường không thể render revision mới.
- Snapshot sau edit trả job thành công cũ và có thể khiến người dùng xem ảnh stale.
- Retry sau failed cũng luôn nhận lại failed job cũ nếu không tự chế key.

**Tái hiện**

1. `start_render({projectId})` → job A.
2. Sửa source, sourceRevision tăng.
3. `start_render({projectId})` → vẫn job A.

**Test thiếu**

Tests chỉ kiểm tra store reuse/conflict chung; không test default MCP key qua hai source revision.

**Sửa tối thiểu**

Đưa `sourceRevision` đã gate vào default key, hoặc chỉ tạo key khi client gửi explicit idempotency key. Với snapshot retry partial cùng revision, revision-aware key vẫn giữ được reuse có chủ đích.

---

### MEDIUM — Static remote-asset preflight không chạy trước enqueue và không quét local stylesheet

**Vị trí**

- `packages/worker/src/render-job.ts:293,301`
- `packages/worker/src/snapshot-job.ts:362,368`
- `packages/core/src/service/remote-asset-scan.ts:10-30`
- Design: detailed design dòng 101, 371–374, 812, 896, 1686.

**Bằng chứng**

Design yêu cầu:

- Probe bốn binary trước enqueue.
- Quét HTML/CSS, gồm local stylesheet, trước enqueue.

Code enqueue chỉ `prepareRender/prepareSnapshot` rồi insert job. Binary probe và scan chạy trong worker, sau khi claim/acquire. Hai runner gọi:

```ts
scanRemoteMedia([{ html: baseDocument, ... }], [])
```

nên tham số local stylesheet luôn rỗng. `scanExternalDependencies` cũng không nhận stylesheet.

**Tác động**

- Stable error tạo job rác thay vì trả ngay tại boundary.
- Remote media trong CSS local không được static-report đúng `file:line`; chỉ trông vào runtime CSP.
- External font/import trong CSS local có thể thiếu khỏi static dependency list.

**Test thiếu**

C.11 chỉ test scanner thuần với CSS truyền trực tiếp; không test call path render/snapshot thực sự nạp stylesheet từ project.

**Sửa tối thiểu**

Tạo preflight dùng chung tại enqueue và defensive recheck trong worker; đọc local stylesheet references rồi truyền đầy đủ vào cả hai scanner.

**Checklist/design lệch code**

Phase I.1 và các acceptance liên quan đều `[x]`, nhưng thứ tự “trước enqueue” trong Design không tồn tại ở implementation.

---

### MEDIUM — Runtime guard không có flush/ack barrier, report cuối trang có thể mất trước publish

**Vị trí**

- `packages/adapter/src/runtime/guard-callback-server.ts:83-101`
- `packages/adapter/src/runtime/guard-callback-server.ts:151-172`
- Render close/evaluate sau child exit; snapshot tương tự.

**Bằng chứng**

Bootstrap gửi report bằng fire-and-forget:

```js
fetch(callbackUrl, ...).catch(() => {})
```

Không giữ pending promises, không có page-side flush/ack. Worker đợi HyperFrames process exit rồi đóng callback server. Nếu CSP violation hoặc PerformanceObserver callback xảy ra sát lúc page/browser đóng, request có thể bị browser hủy trước khi tới loopback. Server-side `close()` chỉ đợi request đã tới server, không chứng minh report còn nằm trong renderer đã được gửi.

**Tác động**

- Runtime media violation có thể bị bỏ lọt và artifact được publish.
- External dependency cuối phiên có thể không xuất hiện; `reproducible` báo sai.

**Test thiếu**

H.5/H.6 chờ report trong page đang sống; không có case “emit violation rồi đóng page/process ngay”.

**Sửa tối thiểu**

Có protocol flush/ack trước browser teardown, hoặc bootstrap giữ pending count và engine chờ guard-ready/flush complete. Chỉ thêm `keepalive:true` là giảm xác suất, chưa phải proof.

---

### MEDIUM — `RenderRoot.acquire` có thể để lại unowned root vĩnh viễn nếu ghi marker thất bại

**Vị trí**

- `packages/adapter/src/fs/render-root.ts:51-58`
- `packages/adapter/src/fs/render-root.ts:121-128`

**Bằng chứng**

`acquire` tạo directory trước rồi mới `writeAtomic` marker, không có catch cleanup. Nếu marker write/sync thất bại, root còn lại nhưng thiếu/hỏng marker. `reclaimOrphans` cố ý bỏ qua root không có marker, nên không bao giờ thu hồi tự động.

**Tác động**

- Leak app-data vĩnh viễn.
- Job có thể fail trước khi runner đặt `acquired=true`/vào finally.
- Startup chỉ warning/giữ obligation nếu có cleanupPending; trường hợp acquire throw thường chưa persist flag.

**Test thiếu**

Fault injection giữa `mkdir(root)` và marker sync.

**Sửa tối thiểu**

Nếu marker publication thất bại, xóa chính directory vừa tạo trong catch, rồi rethrow. Đây là root mới được tạo bằng `recursive:false`, nên ownership của lần acquire hiện tại đã rõ.

---

### MEDIUM — Clone “không follow symlink” vẫn có TOCTOU và có thể copy file ngoài project

**Vị trí**

- `packages/adapter/src/fs/render-project.ts:18-29`
- `packages/adapter/src/fs/render-project.ts:43-51`

**Bằng chứng**

Code dựa vào `Dirent.isSymbolicLink()` từ `readdir`, rồi sau đó `copyFile(from,to)`/recursive `readdir(from)`. Một entry có thể bị thay từ regular file/directory sang symlink/junction giữa hai thao tác; `copyFile` hoặc recursion sẽ follow target mới.

Tương tự, `readSnapshotArtifacts` lọc `Dirent.isFile()` rồi mới `readFile`, vẫn có cửa sổ swap.

**Tác động**

Project bị mutate đồng thời có thể kéo dữ liệu ngoài project vào render root. Với project/script độc hại, đây là boundary confidentiality cần harden.

**Test thiếu**

Race file→symlink và directory→junction giữa enumerate/copy.

**Sửa tối thiểu**

Copy qua handle mở no-follow và kiểm tra identity sau open; với directory, xác minh realpath/handle containment ở từng bước. Ít nhất lstat ngay trước copy giảm cửa sổ nhưng không đóng hoàn toàn.

---

### MEDIUM — Render MP4 được đọc toàn bộ vào RAM trước composite publish

**Vị trí**

- `packages/adapter/src/fs/render-project.ts:63-65`
- `packages/worker/src/render-job.ts`, lúc dựng writes cho `mutateDerived`.

**Bằng chứng**

`readArtifact` dùng `readFile(outputPath)` và trả `Uint8Array`; toàn bộ MP4 được giữ trong memory rồi đi qua mutation/journal staging.

**Tác động**

Video dài/high-resolution có thể OOM daemon. Product cho phép duration tới 3600 giây và kích thước custom lớn; artifact hàng GB là edge thực tế.

**Test thiếu**

Không có large-artifact/memory-bound test.

**Sửa tối thiểu**

Thêm path/file-handle staged publication cho artifact lớn, hash/commit streaming; giữ `Uint8Array` cho sidecar và asset nhỏ.

**Design gap**

Interface Design §5.8 cũng dùng `readArtifact(): Uint8Array`, nên đây là giới hạn thiết kế cần sửa, không chỉ implementation.

---

### LOW — Snapshot complete được tái sử dụng chỉ theo DB result, không xác minh artifact còn tồn tại

**Vị trí**

- `packages/worker/src/snapshot-job.ts:320-326`
- `packages/core/src/usecase/thumbnail.ts:33-44`

**Bằng chứng**

Nếu prior complete có cùng revision và scene IDs, runner trả nguyên result cũ mà không đọc/hash ảnh hoặc contact sheet. Nếu file bị xóa/corrupt ngoài daemon, job mới vẫn `succeeded`; thumbnail mới fallback placeholder khi đọc, tạo bất nhất.

**Tác động**

API job báo thành công nhưng artifact thiếu.

**Test thiếu**

Xóa một snapshot/contact sheet sau successful job rồi start snapshot cùng revision.

**Sửa tối thiểu**

Trước fast-path reuse, xác minh tất cả path và hash/ít nhất existence; thiếu file thì regenerate phần thiếu.

---

## Claims checklist/design lệch implementation

1. Design dòng 371–374 và 896 yêu cầu binary/static HTML+CSS preflight trước enqueue; code thực hiện sau claim và không nạp local stylesheet.
2. Checklist F.19 `[x]` tuyên bố race cancel/complete ở publication barrier đã khóa, nhưng test chỉ cancel trước barrier; code vẫn có race cancel trong `mutateDerived`.
3. Design §5.9 yêu cầu Windows CIM timeout riêng; implementation không có timeout cho CIM/taskkill/tasklist.
4. Checklist S.6 tuyên bố full release gate xanh, nhưng trạng thái dependency vật lý hiện tại không cho chạy lại các focused suites; claim lịch sử chưa thể tái xác minh trong workspace này.
5. Design/Checklist coi PID capture là proof theo concrete PID nhưng không xử lý PID reuse; guarantee an toàn còn thiếu ở cấp design.

---

## Phần đã kiểm tra và chưa thấy lỗi rõ ràng

- `terminationResult` không cho terminal cancelled khi `survivors` còn phần tử; proof rỗng nhưng non-exhaustive sinh warning ổn định.
- POSIX `EPERM` được coi là process còn sống.
- Windows `tasklist` parse đúng cột PID, không substring-match CSV.
- Render root reclaim giữ chính sách bảo thủ: không xóa root thiếu/hỏng/sai marker và không quét TEMP chung.
- Startup reconcile `cleanupPending` chỉ clear khi root exact absent hoặc đã reclaim thành công.
- CSP được inject ngay sau opening `<head>`, trước nội dung do tác giả kiểm soát.
- Callback bind loopback, token random per job, compare constant-time, body cap 16 KiB, external report cap 100.
- Snapshot map output theo timestamp, validate midpoint range, dedupe midpoint và fan-out.
- Snapshot `partial` có `computedAtSourceRevision:null`, `partialAtSourceRevision`, không tạo contact sheet mới khi thiếu scene.
- Scheduler giữ per-type concurrency và per-project/type exclusion trong một daemon.
- Job-store idempotency insert xử lý race unique-key bằng re-read.
- Thumbnail xác minh hash tồn tại trước khi trả image và dùng slug seed cho invalid identity.

---

## Chưa xác minh

- Browser integration H.5/H.6 thực tế vì `puppeteer-core` không có trong physical dependencies.
- Sharp/contact-sheet integration vì `sharp` không có trong physical dependencies.
- Toàn bộ focused Vitest vì import graph dừng ở thiếu `zod`.
- CI process-supervision đa OS và real Windows render chỉ được thấy qua tài liệu/run ID; không chạy lại tại máy này.
- Hành vi HyperFrames với nested iframe/sub-composition và phạm vi CSP kế thừa chưa được xác minh runtime.
- Atomic/durability behavior khi OS crash thật giữa fsync/rename/SQLite commit chưa fault-inject ở review này.

---

## Agent 2 — Core/DDD, lifecycle và storage

### RAW OUTPUT

# RAW Review — Core/DDD, workspace lifecycle và storage atomicity

## 1. Phạm vi và lệnh đã chạy

Review read-only, không sửa code/docs.

Đã đối chiếu:

- Detailed Design: §4.3.1, §4.4.1, §5.1–5.7, §5.18–5.19, §6.1–6.5, Decision 2–5.
- Checklist: Phase B, D, E, K, L và execution log tương ứng.
- Steering: architecture/DDD, validation/path, data/storage, security, testing, code style.

Các lệnh chính:

```text
rtk codegraph explore "Review spec-project-delivery-loop implementation..."
rtk codegraph explore "WriteAuthority and WorkspaceMutationCoordinator..."
rtk codegraph explore "ProjectLifecycle..."
rtk codegraph explore "resolveWorkspace ... WorkspaceScanner ... ProjectIdentityService..."
rtk codegraph explore "ProjectStateStore..."
rtk codegraph explore "delivery loop SQLite migration..."
rtk rg -n ... <spec/checklist/code/tests>
rtk proxy powershell ... Get-Content ... Select-Object ...
rtk bun run test -- tests/adapter/workspace-mutation-coordinator.test.ts \
  tests/adapter/project-lifecycle.test.ts \
  tests/adapter/project-state-store.test.ts \
  tests/adapter/delivery-loop-database-migration.test.ts
```

Focused tests không load được vì workspace thiếu package vật lý `zod`:

```text
Error: Cannot find package 'zod' imported from
packages/core/src/usecase/project-identity.ts
Test Files 4 failed; Tests no tests
```

Đây là giới hạn môi trường, không được tính là code test fail/pass. Không cài dependency.

## 2. Findings

### Critical

Không xác nhận được finding Critical.

### High

#### H1 — Crash ngay sau directory rename nhưng trước khi ghi `staging_path` làm recovery mất dấu directory

- Chính: `packages/core/src/service/workspace-mutation-coordinator.ts:167-170`, `301-302`.
- Recovery liên quan: `packages/core/src/service/workspace-mutation-coordinator.ts:619-650`, `684-705`.
- Adapter tạo tên deterministic: `packages/adapter/src/fs/project-directory.ts:62-75`, `126-135`.

Bằng chứng:

- Create gọi `stageCreate()` trước, sau đó mới `journal.setDirectoryPaths(...)`.
- Delete gọi `quarantine()`—đã atomically đổi tên live project—trước, sau đó mới lưu quarantine path.
- Recovery coi `stagingPath === null` là `"absent"`.

Tác động:

- Create crash giữa hai call để lại sibling staging dot-directory không được journal biết tới; recovery abort operation nhưng không dọn staging.
- Delete crash giữa hai call làm live project biến mất vào quarantine, nhưng recovery không biết quarantine ở đâu và terminal hóa `orphaned`. Project không còn ở đường live dù backup/journal vẫn tồn tại.
- Vi phạm trực tiếp E.9/L.6 và protocol crash recovery trong Design §5.7.

Edge case tái hiện:

1. `journal.begin()` thành công.
2. `directories.quarantine()` hoặc `stageCreate()` thành công.
3. Kill process trước `setDirectoryPaths()`.
4. Restart và gọi `recoverPending()`.
5. Create bị abort nhưng staging còn; delete thành orphaned trong khi live root đã mất.

Test thiếu:

- Process/crash fixture dừng đúng sau side effect filesystem, không phải proxy throw rồi để cùng stack `catch` cleanup.
- Assert startup recovery tìm và xử lý tên deterministic theo `operationId`.

Sửa tối thiểu:

- Tính/stash staging/quarantine path deterministic trong journal trước filesystem rename; hoặc cho recovery tái dựng exact path từ `slug + operationId`.
- Không dựa duy nhất vào `staging_path` được ghi sau side effect.

#### H2 — Delete đã commit thành công nhưng cleanup lỗi lại trả `recovery_required`; recovery không bao giờ đọc operation đã committed

- Chính: `packages/core/src/service/workspace-mutation-coordinator.ts:304-320`.
- Terminal hóa: `packages/adapter/src/db/workspace-operation-journal.ts:386-391`.
- Recovery filter: `packages/adapter/src/db/workspace-operation-journal.ts:507-514`.
- Call path: `ProjectLifecycle.remove()` → `WriteAuthority.deleteProjectRoot()` → coordinator.

Bằng chứng:

```text
commitProjectLifecycle(...)
removeOwned(quarantine)
```

Cả hai nằm trong cùng `try`. Nếu `removeOwned` throw:

- DB đã soft-delete registration;
- audit, event, grant consumption và operation status `committed` đã commit;
- method vẫn trả `recovery_required`.

Nhưng `listPending()` chỉ chọn `pending|orphaned`, nên operation committed này không được recovery xử lý.

Tác động:

- API báo thất bại dù deletion đã hoàn tất về nghiệp vụ.
- Retry gặp project-not-found/grant consumed.
- Quarantine có thể tồn tại vĩnh viễn và chiếm toàn bộ bytes của project.
- User không có đường recovery tự động đúng với error được trả.

Edge case:

- Inject lỗi `removeOwned` sau `commitProjectLifecycle`.
- Quan sát `project_registry.deleted_at != NULL`, grant consumed, operation committed, quarantine còn.
- `recoverPending()` trả rỗng.

Test thiếu:

- Cleanup failure sau DB settle.
- Restart phải reclaim committed lifecycle cleanup obligation.

Sửa tối thiểu:

- Sau commit, deletion phải trả success kèm `cleanupPending`/warning và persist cleanup obligation; hoặc recovery phải quét committed delete có `staging_path` còn tồn tại.
- Không trả `recovery_required` nếu recovery hiện tại không thể thấy operation đó.

#### H3 — Destructive delete có TOCTOU sau khi backup/approval hash đã xác minh

- Binding/backup check: `packages/core/src/usecase/project-lifecycle.ts:275-304`.
- Journal directory step không mang content precondition: `packages/core/src/service/workspace-mutation-coordinator.ts:284-297`.
- Quarantine diễn ra sau đó: `packages/core/src/service/workspace-mutation-coordinator.ts:301`.

Bằng chứng:

- `ProjectLifecycle.remove()` xác minh backup entries khớp `GrantBinding.targetHashes`.
- Sau kiểm tra này, coordinator nhận chỉ `verifiedBackupId`, slug và projectId.
- Delete journal step dùng `fromHash: null`; coordinator không kiểm lại tree/hash trước hoặc sau quarantine.

Tác động:

- External editor được hệ thống cho phép có thể sửa file sau backup verification nhưng trước quarantine.
- Byte mới chưa nằm trong backup và chưa nằm trong approval plan vẫn bị quarantine rồi xóa.
- Grant “bind target hashes” không còn đúng tại mutation boundary; destructive backup không bảo đảm phục hồi byte vừa bị xóa.

Edge case:

1. Plan delete và cấp grant cho hash A.
2. Backup A được verify.
3. Sửa `index.html` thành B ngay trước `directories.quarantine()`.
4. Delete commit và xóa B; backup chỉ chứa A.

Test thiếu:

- Hook sửa file sau `backups.verify()` nhưng trước quarantine.
- Assert delete phải restore/refuse, grant không consumed.

Sửa tối thiểu:

- Sau quarantine, hash tree trong quarantine và so với verified backup manifest/binding trước DB commit.
- Nếu lệch, restore quarantine về live root, abort journal và release/invalidate grant phù hợp.

#### H4 — Create recovery commit registry/revision chỉ dựa vào “directory tồn tại”, không xác minh file/hash journal

- Chính: `packages/core/src/service/workspace-mutation-coordinator.ts:616-640`.
- `inspect()` chỉ kiểm loại directory: `packages/adapter/src/fs/project-directory.ts:158-166`.
- Commit ghi journal hashes vào revision: `packages/adapter/src/db/workspace-operation-journal.ts:298-340`.

Bằng chứng:

- Recovery create kiểm `finalState === "directory"` và staging absent.
- Sau đó đánh dấu mọi step written và commit lifecycle.
- Không đọc/hash từng final file; không xác minh `vidcom.json`, preview settings hoặc manifest thực tế.

Tác động:

- External modification/xóa file trong khoảng crash→restart khiến SQLite registration, revision_step và entity_state khẳng định hash cũ dù filesystem khác.
- Project có thể được đăng ký authored/empty sai hoặc mang identity khác.
- Phá invariant SQLite authority phản ánh mutation đã landed.

Edge case:

1. Crash sau `publishCreate`, trước DB settle.
2. Xóa hoặc sửa `preview-settings.json`/`vidcom.json`.
3. Restart recovery.
4. Operation vẫn recovered, registration/revision được commit bằng `to_hash` cũ.

Test thiếu:

- Crash post-publish rồi sửa/xóa mỗi final file trước recovery.
- Assert mismatch phải orphan/rollback/manual recovery, không commit success.

Sửa tối thiểu:

- Resolve và hash toàn bộ ordered steps tại final root trước `markWritten`.
- Chỉ commit khi mọi actual hash đúng `toHash`, đồng thời validate identity/required files.

### Medium

#### M1 — Scanner/identity marker read bypass symlink containment policy

- Marker stat/read: `packages/adapter/src/fs/workspace-fs.ts:91-116`.
- Scanner callers: `packages/core/src/usecase/scan-workspace.ts:49-60`, `102-109`.
- Identity caller: `packages/core/src/usecase/project-identity.ts:83-102`.
- Safe resolver để đối chiếu: `packages/adapter/src/fs/resolve.ts:65-91`.

Bằng chứng:

- `statWorkspaceFile()` dùng `stat(path.join(...))`.
- `readWorkspaceFile()` dùng `readFile(path.join(...))`.
- Cả hai follow symlink nhưng không `realpath` target và containment-check.
- Những đường ghi/read thông thường lại dùng `resolveProjectPath()` có canonical symlink containment.

Tác động:

- `vidcom.json` hoặc `index.html` symlink ra ngoài workspace vẫn được scanner đọc/parse.
- Có thể tạo ProjectId/platform/scenes dựa trên file ngoài project và làm workspace overview/diagnostics lộ metadata ngoài scope.
- Vi phạm steering 06/09: mọi path config phải resolve symlink và kiểm containment.

Edge case:

- Project direct child có `vidcom.json` hoặc `index.html` là symlink tới file ngoài workspace.
- Scan phân loại từ nội dung ngoài thay vì `invalid`/reject.

Test thiếu:

- Symlink cho cả ba literal marker trên POSIX/Windows-capable fixture.

Sửa tối thiểu:

- Trong capability đóng này, `lstat` reject symlink hoặc `realpath` literal target rồi containment-check với canonical direct-child project root.

#### M2 — `ProjectStateStore.reconcile()` không phát hiện drift; report luôn nói mọi projection đã đổi

- Chính: `packages/core/src/service/project-state-store.ts:311-346`.
- Startup caller: `packages/cli/src/composition-root.ts:462-474`.
- Contract: Design §5.6/§6.3 (`ReconcileReport`), Goals R4.8/R4.8b.

Bằng chứng:

- Không đọc/so sánh projection hiện tại.
- Luôn tạo state với `lastOpenedAt = clock.now()`.
- Luôn publish ba file.
- Luôn trả `{ rebuilt:true, stateChanged:true, jobsChanged:true, revisionsChanged:true }`.

Tác động:

- R4.8 “projection lệch phải phát hiện được” chưa được hiện thực; chỉ có unconditional rebuild.
- Mỗi open tạo state byte mới và derived revision/audit dù jobs/revisions không đổi.
- Report không thể dùng cho diagnostics/telemetry vì luôn báo drift.

Edge case:

- Gọi `reconcile()` hai lần với SQLite và filesystem không đổi.
- Lần hai vẫn báo toàn bộ changed/rebuilt.

Test thiếu:

- Projection pristine → toàn bộ flags false, không mutation/revision mới.
- Chỉ jobs lệch → chỉ `jobsChanged=true`.

Sửa tối thiểu:

- Serialize expected bytes, đọc hash hiện tại, chỉ publish path lệch và trả flags từ so sánh thực tế.
- Tách update `lastOpenedAt` khỏi nghĩa “projection drift” nếu vẫn cần cập nhật mỗi open.

#### M3 — `readState()` cast JSON không validate shape

- Chính: `packages/core/src/service/project-state-store.ts:237-244`.
- Caller hiện hữu: `packages/cli/src/next-host.ts` qua CodeGraph.

Bằng chứng:

```ts
return JSON.parse(file.content) as ProjectStateFile;
```

Chỉ syntax JSON được kiểm; schemaVersion, projectId, numeric fields, status union và cấm persisted `stale` không được kiểm.

Tác động:

- File projection bị sửa tay/corrupt nhưng parse được sẽ đi vào application dưới type giả.
- `writeState()` cấm `stale`, trong khi `readState()` có thể nhận lại chính shape bị cấm.
- Lỗi xuất hiện xa nguồn, trái nguyên tắc đọc dữ liệu méo phải normalize/reconcile an toàn.

Edge case:

```json
{"schemaVersion":1,"projectId":"other","snapshots":{"stale":true}}
```

`readState()` trả object truthy thay vì `null`/reconcile.

Test thiếu:

- Valid JSON nhưng thiếu field, sai projectId, sai schemaVersion, chứa `stale`.

Sửa tối thiểu:

- Schema/guard nội bộ; invalid trả `null` và kích hoạt reconcile từ SQLite.

### Low

#### L1 — Exported Core APIs thiếu doc comment theo steering

Ví dụ:

- `packages/core/src/usecase/project-lifecycle.ts:76`, `102`, `139`, `217`, `233`, `254`.
- `packages/core/src/service/project-state-store.ts:222`, `237`, `246`, `259`, `268`, `282`.
- `packages/core/src/service/workspace-mutation-coordinator.ts:135`, `209`, `268`, `326`.

Steering 11 §4 yêu cầu mọi export/function/usecase nêu tiền điều kiện, file/entity ghi, revision/event và side effect. Nhiều method lifecycle quan trọng chỉ có class-level comment.

Tác động chủ yếu là maintainability và contract drift; không phải lỗi runtime.

Sửa tối thiểu: thêm doc comment đúng bốn mục cho usecase/lifecycle, không chép lại signature.

## 3. Checklist/design claims không khớp code hoặc bằng chứng test

1. **E.9 và L.6 được đánh `[x]` nhưng test không mô phỏng process crash ở mọi boundary.**

   - `tests/adapter/project-lifecycle.test.ts:72-149` dùng Proxy throw; cùng call stack bắt lỗi và cleanup staging.
   - `tests/adapter/workspace-mutation-coordinator.test.ts:250-278` tự gọi `removeOwned()` rồi `journal.abort()`.
   - Không có test kill/restart giữa `stageCreate|quarantine` và `setDirectoryPaths`.
   - Vì vậy không chứng minh H1.

2. **L.4 “dọn quarantine” được đánh hoàn tất nhưng không có durable cleanup obligation sau commit.**

   - `removeOwned` lỗi sau commit tạo H2; `listPending` loại operation committed.

3. **K.5/R4.8 “reconcile/phát hiện lệch” chỉ có rebuild unconditional.**

   - Test `project-state-store.test.ts` chỉ đưa projection giả rồi xác nhận bị overwrite; không test pristine/no-change.
   - `ReconcileReport` hiện không phản ánh so sánh.

4. **Recovery create theo Design “validate hash/schema” chưa khớp.**

   - Normal create hash content trước begin, nhưng recovery post-publish không hash/validate final tree trước commit.

5. **Checklist migration B.7–B.11 có test nguồn thật, nhưng focused rerun hiện không thực thi được do thiếu physical `zod`.**

   - Execution log lịch sử nói suite xanh; trong workspace review hiện tại không thể tái xác minh.

## 4. Đã kiểm tra và chưa thấy lỗi rõ ràng

- `resolveWorkspace()` giữ đúng ưu tiên `explicit > cwd marker > active > cwd`, marker xét presence chứ không parse validity.
- `EntryRegistry` là session-only, có revoke/clear; chưa thấy persistence tạo identity thứ hai.
- `WriteAuthority.inferMutationPurpose()` tách source/derived/workspace bằng method và closed path policy; không còn caller chọn `purpose/advances_source`.
- `mutateDerived()` từ chối path source, dùng composite journal và không làm `latestSourceRevision` tiến theo thiết kế.
- Project composite commit ghi revision + revision_step + audit + event trong một SQLite transaction.
- Workspace agent-kit mutation không insert revision/event; audit nullable-project được settle trong transaction.
- Collision query giữ pending/orphaned target và không giả định cross-table partial unique index.
- Migration chính có `advances_source` CHECK/default, job rebuild thêm `partial`, cleanup/warnings constraints, workspace operation header/step và indexes.
- Rollback helper từ chối khi có `partial` hoặc unresolved workspace operation; bật lại foreign keys và kiểm `foreign_key_check`.
- ProjectLifecycle tạo backup và verify trước delete; agent grant được reserve trong journal begin và consume cùng lifecycle commit.
- Rename giữ stable ProjectId trong DB path bình thường và recovery đã có test post-rename/pre-settle.
- Path policy chính `resolveProjectPath`/`resolveWorkspacePath` canonicalize symlink ancestor và áp purpose lại sau canonicalization.

## 5. Câu hỏi/chưa xác minh

- Không chạy được focused integration tests do thiếu `zod`; không tự cài dependency theo chỉ đạo.
- Chưa xác minh trên Windows thật behavior rename/fsync/quarantine khi antivirus/file handle giữ directory.
- Chưa xác minh rollback helper trên database đã chạy toàn bộ migration sau Phase B, đặc biệt dữ liệu ở các cột/migration mới hơn.
- Chưa xác minh GC của `PreviousContentStore` đối với object được `prepare()` trước khi `journal.begin()` thất bại.
- Chưa chứng minh duplicate `ProjectId` khi người dùng copy nguyên project được phát hiện và remint theo steering 07 §10; cần review riêng registry/scan duplicate-ID flow.

---
