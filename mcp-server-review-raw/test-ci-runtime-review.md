# Raw review — Test, CI, runtime và release evidence

Phạm vi review read-only: Phase Verification Matrix / Phase P, package scripts, GitHub Actions, MCP contract/golden tests, AI-host stdio smoke, Next runtime smoke, packaged evidence và khả năng tái hiện remote CI. Ngoài file raw này, không sửa production code, test, spec hay checklist.

## Kết luận nhanh

Local Verification Matrix hiện tại tái hiện được và xanh trên checkout `b0830f12a2c2a2fbe3e8c8800cdf7cbd8d1db2e3`: frozen install không đổi dependency, 423/423 test pass, 22/22 golden pass, build/runtime/schema drift đều pass, không có test `.skip`/`.todo`/`.only`. Tuy vậy, có một lỗi production mức **High** mà toàn bộ gate hiện tại bỏ sót: exact/latest MCP HTTP handler làm rơi `authInfo`, khiến audit mất `credentialId`. Ngoài ra contract matrix và “real AI-host” smoke đang chứng minh ít hơn tên/Definition of Done tuyên bố.

## Findings theo severity

### HIGH — Exact revision và `/latest` làm rơi credential context trước Registry/audit

**Evidence**

- Hono đã truyền credential đã verify vào SDK handler qua `authInfo.clientId` tại `packages/server/src/routes/mcp.ts:25-30`.
- Nhưng exact-pin wrapper gọi `inner(request)` thay vì `inner(request, options)` tại `packages/mcp/src/http.ts:67-69`.
- Entry `/api/mcp` không qua nhánh match này nên vẫn có credential; `/api/mcp/<revision>` và `/api/mcp/latest` qua wrapper và mất credential context.
- `tests/server/mcp-security.test.ts:187-223` chỉ kiểm Registry audit trên entry `/api/mcp`. Test structural dispatch tại `tests/server/mcp-security.test.ts:124-138` dùng fake handler nên không chạy wrapper thật. `tests/mcp/revision-pin.test.ts:220-236` chỉ so output, không assert auth/audit.

**Reproduction hiện tại**

Probe trực tiếp cùng production handler:

```text
key=""             status=200 auditCredentialId="cred-pin"
key="2025-11-25"   status=200 auditCredentialId=null
key="2026-07-28"   status=200 auditCredentialId=null
key="latest"       status=200 auditCredentialId=null
```

Probe qua Hono thật với bearer verifier trả `credential_hono_pin` và path `/api/mcp/2025-11-25`:

```json
{"status":200,"auditCredentialId":null}
```

**Impact / edge cases**

- Authentication perimeter vẫn chặn request thiếu bearer, nhưng audit của mọi tool call qua exact/latest không còn biết credential nào đã gọi.
- Ảnh hưởng cả legacy exact pins, modern exact pin và moving alias `latest`; gồm cả destructive calls.
- Vi phạm mục tiêu credential attribution/audit của N.6–N.9 và Definition of Done audit, đồng thời phá khả năng revoke/forensics theo credential.

**Fix đề xuất**

- Đổi nhánh match thành `inner(request, options)`.
- Thêm integration assertions qua `createServerApp` cho entry, một legacy pin, modern pin và `latest`; gọi Registry tool thật rồi assert audit `credentialId` giống credential đã verify và không chứa bearer plaintext.

### MEDIUM — “2 era × 2 transport production-tool contract matrix” chỉ chứng minh error dispatch cho 9/10 tools

**Evidence**

- `tests/mcp/contract-matrix.test.ts:19-29` chỉ kỳ vọng success shape cho `list_projects`; mọi tool khác chỉ cần `isError === true`.
- Harness cố tình trả `readProjectRef: null`, để trống `composition`/`journal`/`authority`, rồi cast `unknown as VidcomToolDependencies` tại `tests/mcp/support.ts:63-77`.
- Vì vậy đa số call dừng ở `project_not_found`, chưa đi qua success mapping, output validation, write-audit ownership, revision/diagnostics hay destructive grant/backup flow.
- Production-bin E2E chỉ gọi legacy `list_projects` và modern `delete_file` tại `tests/e2e/mcp-stdio-host.test.ts:98-145`.
- Checklist P.1 nói “chạy mọi tool phù hợp” và AC P nói mọi registry tool có automated contract evidence tại `spec-mcp-server-implementation-checklist.md:653-664`.

**Impact / edge cases**

- Một regression chỉ làm sai success output của `get_project_context`, `list_scenes`, `read_composition`, `create_scene`, `set_scene_timing`, `set_text`, `save_file` hoặc `delete_scene` có thể vẫn qua matrix 2×2.
- Core/use-case tests ở layer thấp hơn không chứng minh Registry mapping + SDK transport projection của success result.

**Fix đề xuất**

- Dựng temp workspace/project thật và production composition dependencies cho contract fixture.
- Ít nhất mỗi production tool phải có một successful Registry invocation khóa exact output; các output đại diện read/write/destructive phải chạy qua cả 4 era×transport cells.
- Giữ missing-project cases như negative matrix riêng, không dùng chúng thay cho success coverage.

### MEDIUM — “real AI-host” / Claude Code Definition of Done chưa có host-binary evidence

**Evidence**

- Test mang tên `real AI-host CLI smoke` nhưng import/instantiate trực tiếp MCP SDK client trong Vitest tại `tests/e2e/mcp-stdio-host.test.ts:8-12,68-69,98,118-124`.
- Detailed Goals Definition of Done yêu cầu “Một AI host thật” và “Claude Code (legacy)” tại `spec-mcp-server-detailed-goal.md:404-409`.
- Main spec tự mô tả evidence thực tế là exact SDK clients tại `spec-mcp-server-complete.md:106-108`.
- Checkout hiện có binary dùng được để kiểm tiếp: `claude --version` → `2.1.207 (Claude Code)`; `codex --version` → `codex-cli 0.146.0`, nhưng test/CI không chạy chúng.

**Impact**

- SDK conformance không bắt được host-specific config, process lifecycle, stdio framing tolerance, environment inheritance hoặc host revision behavior.
- Claim “AI host thật/Claude Code dùng được” mạnh hơn evidence hiện có.

**Fix đề xuất**

- Hoặc thêm hermetic smoke dùng actual Claude Code/Codex MCP configuration trong temp home, giới hạn read-only tool và timeout chặt.
- Hoặc sửa DoD/demo wording thành “exact MCP SDK client harness” và giữ actual-host validation ở trạng thái chưa xác minh/deferred.

### MEDIUM (evidence gap) — Remote CI xanh chưa được chứng minh trên current exact HEAD

**Evidence**

- Current clean checkout: `HEAD = origin/main = b0830f12a2c2a2fbe3e8c8800cdf7cbd8d1db2e3`.
- Docs chỉ ghi CI xanh cho ship `db7fd68` và closeout candidate `f01d4b4` tại `spec-mcp-server-complete.md:104-108`.
- Sau `f01d4b4` còn hai commit docs: `124619f` và `b0830f1` (41 insertions/21 deletions trên 6 doc files; production code không đổi).
- Checklist Acceptance Criteria yêu cầu “remote CI xanh trên đúng commit” tại `spec-mcp-server-implementation-checklist.md:662-665`.
- Live verification hiện bị chặn: cả `gh run list --workflow CI ...` và GitHub check-runs API trả HTTP 404 cho repository, nên không thể xác nhận run của `b0830f1` trong session review.

**Assessment**

- Đây không phải bằng chứng CI fail. Production code current giống candidate `f01d4b4` và toàn bộ local gates hiện xanh.
- Nhưng current exact HEAD chưa có evidence remote tái hiện được trong repo/session này, nên không nên ghi “confirmed current remote CI” nếu chưa lấy được Actions run.

**Fix đề xuất**

- Xác minh Actions run theo exact SHA `b0830f1`, lưu run URL/id/conclusion vào closeout evidence.
- Nếu repo private làm reviewer không đọc được Actions, lưu một evidence artifact/check URL có quyền truy cập phù hợp thay vì chỉ ghi số run cũ trong prose.

### LOW — Named `test:mcp-contract` không chứa chính contract matrix/negative/revision-pin suites

**Evidence**

- `package.json:18` chỉ chạy `ci-guards`, `write-authority`, `registry`, legacy/modern transport và stdio E2E.
- Nó không chạy `tests/mcp/contract-matrix.test.ts`, `tests/mcp/negative-contract-matrix.test.ts`, `tests/mcp/revision-pin.test.ts`.
- CI hiện vẫn bắt chúng vì `bun run test` tại `.github/workflows/ci.yml:44-48` chạy trước named gate.

**Impact**

- Chạy riêng script mang tên MCP contract có thể xanh dù matrix/revision negative bị hỏng.
- CI không bỏ sót ở cấu hình hiện tại, nên severity thấp.

**Fix đề xuất**

- Cho `test:mcp-contract` chạy toàn bộ `tests/mcp/*.test.ts` (golden giữ ở gate riêng) hoặc liệt kê đủ matrix/negative/revision-pin.

### LOW — Next runtime smoke chỉ chạm legacy entry list và cleanup có thể pass khi child chưa thoát

**Evidence**

- `scripts/verify-next-runtime.mjs:112-124` gửi raw `tools/list` tới `/api/mcp` không protocol envelope/header, nên chỉ chứng minh legacy no-header default trên entry route.
- Không gọi exact/latest, modern HTTP, tool success mutation hay assert credentialId trong durable audit; vì vậy không bắt được finding High ở trên.
- Cleanup `scripts/verify-next-runtime.mjs:135-141` race child exit với timeout 5 giây nhưng không fail/kill cứng khi timeout thắng.

**Fix đề xuất**

- Thêm modern pinned/latest call qua production Next route và kiểm audit credential attribution.
- Sau SIGTERM, nếu child chưa exit trong deadline thì SIGKILL và fail smoke; assert exit signal/code mong đợi.

### INFO / scope boundary — Không có packaged/clean-machine artifact evidence trong Phase 2

**Evidence**

- CLI production smoke hiện load source TypeScript bằng `tsx/esm/api` tại `packages/cli/bin/vidcom.mjs:2-5`; `tsx` là runtime dependency tại `packages/cli/package.json:10-18`.
- Runtime smoke start `node_modules/next/dist/bin/next` trong source checkout tại `scripts/verify-next-runtime.mjs:75-82`.
- CI chỉ chạy Ubuntu source checkout (`.github/workflows/ci.yml:13-16`) và không build/test Node SEA artifact hay OS×arch matrix.
- Main spec đã nói rõ packaged SEA artifact là carry-over tại `spec-mcp-server-complete.md:116-120`; canonical build order đặt Node SEA và clean-machine artifact smoke ở Phase 4 (`llm-documents/product-features/15-build-order.md:117-128`).

**Assessment**

- Đây không phải failure so với phạm vi Phase 2 đã duyệt.
- Nhưng Phase P evidence **không** chứng minh packaged binary, máy sạch hay release-ready cross-platform; không nên suy rộng local source runtime smoke thành packaged evidence.

## Current gate evidence — rerun trong review

Checkout trước/sau command sạch, không có file production/spec/test bị sửa.

| Gate | Kết quả current checkout |
|---|---|
| `rtk bun install --frozen-lockfile` | exit 0; 870 installs / 1034 packages; no changes |
| `rtk bun run typecheck` | exit 0 |
| `rtk bun run lint` | exit 0; 0 errors, 10 warnings có sẵn trong `.temp-documents/addyosmani-loop-engineering/app.js` |
| `rtk bun run test:boundaries` | exit 0 |
| `rtk bun run test` | exit 0; 66 files, 423 tests pass |
| `rtk bun run test:golden` | exit 0; 6 files, 22 tests pass |
| `rtk bun run test:mcp-contract` | exit 0; 6 files, 51 tests pass |
| focused matrix/negative/listener | exit 0; 3 files, 10 tests pass |
| `rtk bun run build` | exit 0; Next 16.2.12 production build |
| `rtk bun run test:runtime-smoke` | exit 0; `MCP bearer route ok; SSE 1 -> 2` |
| `rtk bun run test:schema-drift` | exit 0; 4 migration artifacts in sync |
| `rtk git diff --check` | exit 0 |
| skip scan | không có `.skip`, `.todo`, `.only`, `skip: true`, `todo: true` trong tests/config |
| worktree | clean; `HEAD = origin/main = b0830f12...` |
| remote CI live lookup | chưa xác minh được; GitHub API/`gh run list` HTTP 404 |

## Positive observations

- Full local gates và counts trong closeout hiện tái hiện đúng: 423 full tests, 22 golden, 51 named MCP guard.
- Golden gate thực sự bao gồm cả `tests/golden` và `tests/mcp/golden` (`package.json:17`), khóa tools/list legacy+modern và result shape.
- Không có skipped/todo/only test được phát hiện.
- Frozen install, build, real `next start`, bearer route, SSE resume, schema drift và diff check đều chạy thật, không chỉ dựa vào prose evidence.
- Packaged SEA/clean-machine gap đã được docs current ghi rõ là carry-over, không bị giấu trong implementation code.

