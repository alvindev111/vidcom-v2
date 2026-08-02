# 15 — Thứ tự xây dựng

Đây là **backlog chuẩn duy nhất**. [13-backend-requirements](13-backend-requirements.md) giữ danh sách chức năng có ID; tài liệu này giữ **thứ tự làm**. Doc 14 §18 mô tả các mức đóng gói, không phải thứ tự task.

Ký hiệu ID theo doc 13 §3 (`PK-1`, `MP-2`, `CE-1`, …).

## Nguyên tắc sắp xếp

1. **Cái chặn đứng dự án làm trước.** Nếu Bun không compile được native addon thì D2 phải đổi cách — biết sớm rẻ hơn biết muộn.
2. **Cái không thể thêm sau làm sớm.** Auth, boundary, atomic write, test harness — nhét vào sau nghĩa là viết lại.
3. **Mỗi mốc để lại app chạy được.** Không có giai đoạn "app hỏng trong 3 tuần".
4. **Đóng vòng lặp sản phẩm trước khi làm đẹp.** Render MP4 quan trọng hơn kéo-thả timeline.

---

## Giai đoạn 0 — Spike (1 tuần). Chặn mọi thứ

Không viết production code trước khi xong.

| # | Việc | ID | Xong nghĩa là |
|---|---|---|---|
| 0.1 | Bun `--compile` một binary gọi `@hyperframes/core` (esbuild), `onnxruntime-node`, `sharp`, `puppeteer-core` | PK-1 | Biết D2 khả thi hay phải chuyển Node SEA / giải nén addon ra app-data |
| 0.2 | Chạy `hyperframes` CLI dưới Bun (nó khai báo `engines: node >=22`) | — | Biết Bun đủ hay cần Node sidecar |
| 0.3 | Dựng thử MCP server tối thiểu bằng `@modelcontextprotocol/server@2.x` **và** `sdk@1.x` trong cùng process | MP-3, MP-4 | Biết hai SDK sống chung được không (S1, S2 ở steering 13 §9) |
| 0.4 | Xác minh độ ưu tiên route Next: route cụ thể thắng optional catch-all | — | Kế hoạch cắt chuyển D4 đứng vững (R4b) |

**Nếu 0.1 hoặc 0.3 thất bại → dừng, thiết kế lại, không đi tiếp.**

### Kết quả chạy ngày 2026-08-01

| # | Kết quả | Quyết định |
|---|---|---|
| 0.1 | **FAIL trực tiếp; PASS qua fallback** — Bun executable không load được `onnxruntime-node`/`sharp`; Node SEA nhúng archive native chạy được cả cold extraction và warm cache | Chọn Node SEA cho D2; loại Bun native-loader rewrite |
| 0.2 | **PASS trong phạm vi parse/lint/list** — hai lệnh thật exit 0 trên project mẫu | Chưa cần Node sidecar cho các đường CLI đã thử |
| 0.3 | **PASS** — modern `2026-07-28` và legacy `2025-11-25` cùng PID; source và Bun executable đều gọi tool thành công | Dual-stack khả thi |
| 0.4 | **PASS** — route cụ thể thắng optional catch-all trên Next 16.2.12 | Cutover D4 theo từng route đứng vững |

**Gate kỹ thuật hiện tại: READY FOR DESIGN APPROVAL.** Spike thay thế đã chọn Node SEA và loại Bun native-loader rewrite. Phase 1 chưa tự động bắt đầu; phải xác nhận thay đổi thiết kế/runtime và checklist trước khi viết production code. Bằng chứng và lệnh tái hiện: [spikes/phase-0](../../spikes/phase-0/README.md).

---

## Giai đoạn 1 — Nền móng (3–4 tuần)

Không có tính năng mới cho người dùng. Đây là phần không thể thêm sau.

| # | Việc | ID |
|---|---|---|
| 1.1 | Dựng `packages/{core,adapter,server,mcp,contracts,agent-kit,cli}` + **lint import boundary** | — |
| 1.2 | Test harness + CI: typecheck, lint, unit, golden, contract | — |
| 1.3 | **Golden-file cho `serialize()`** — phải có trước khi đụng bất kỳ đường ghi nào | — |
| 1.4 | `WorkspaceRoot` inject được, bỏ `process.cwd()` | PK-2 |
| 1.5 | Port + adapter cho filesystem và HyperFrames; chuyển parse logic sang Core | — |
| 1.6 | **Service ghi file duy nhất**: content hash, atomic temp+rename, revision, audit, invalidate, event | CE-1, CE-3, CE-4 |
| 1.7 | `resolveInProject()` — canonicalize + resolve symlink + containment. Bịt lỗ `openProjectFile` | SE-3 |
| 1.8 | Schema validation ở boundary; `ErrorCode` enum trong `contracts` | SE-4, SE-5 |
| 1.9 | Auth: loopback bind, one-time nonce → session cookie, `Host` check, CORS từ chối mặc định | SE-1 |
| 1.10 | Cắm Hono qua `api/[[...route]]` — cắt chuyển route **đọc** trước, **ghi** sau | D4 |
| 1.11 | Bỏ RSC đọc filesystem: `GET /api/v1/projects`, `GET /api/v1/projects/:id/studio-snapshot` | D4 |
| 1.12 | Job infrastructure: SQLite, lifecycle, progress, cancel, recovery, concurrency theo type | — |
| 1.13 | SSE `/api/v1/events` + file watcher + cache invalidate theo event | PF-2, PF-3 |

**Mốc:** `src/` không còn code server nào ngoài một file forward. `npx tsc` sạch, CI xanh.

---

## Giai đoạn 2 — MCP chạy thật (2–3 tuần)

D1 là quyết định số một, nhưng nó cần nền móng ở giai đoạn 1.

| # | Việc | ID |
|---|---|---|
| 2.1 | Tool Registry protocol-agnostic | MP-2 |
| 2.2 | Bộ tool đọc: `list_projects`, `get_project_context`, `read_composition`, `list_scenes` | MP-1 |
| 2.3 | Transport modern `2026-07-28` + `server/discover` + `resultType` + `CacheableResult` | MP-3, MP-5, MP-6 |
| 2.4 | Transport legacy ≤ `2025-11-25` + negotiation + map error code theo thế hệ | MP-4, MP-9 |
| 2.4b | **Nâng cấp Core**: `WriteAuthority` hỗ trợ mutation composite (nhiều file + tuỳ chọn một entity, một revision, recovery được) | CE-7 |
| 2.4c | **Nâng cấp Core**: `createScene` dùng mutation composite, trả `revision` + `diagnostics`; `setSceneScript` đánh dấu narration stale | CE-6, NT-13 |
| 2.5 | Bộ tool ghi: `create_scene`, `set_scene_timing`, `set_text`, `save_file` — kèm precondition bắt buộc | MP-1 |
| 2.6 | Tool destructive + **approval grant do daemon phát hành** + backup restore được · **kèm use case `deleteScene` trong Core** | MP-7, SC-1 |
| 2.10 | Transport Streamable HTTP, endpoint theo revision + vòng đời credential cho AI host | MP-3, MP-4 |

> **Cập nhật 2026-08-01.** 2.4b/2.4c bổ sung sau review spec: `WriteAuthority` hiện chỉ ghi được một file hoặc một entity mỗi lần, và `createScene` đang ghi ba lần rời không có revision chung. Không có hai mục này thì "một thao tác = một revision" và `deleteScene` đều không khả thi. Giai đoạn 2 vì thế **rộng hơn** ước lượng 2–3 tuần ban đầu.
| 2.7 | Audit mọi tool call, ghi cả protocol version | MP-12, SE-9 |
| 2.8 | Contract test chạy **hai lần**, một lần mỗi thế hệ | — |
| 2.9 | `vidcom mcp` mode, `stdout` sạch | PK-5 |

**Mốc:** Claude Code / Codex kết nối được và sửa được một project thật qua tool, không đụng file trực tiếp.

---

## Giai đoạn 3 — Đóng vòng lặp sản phẩm (3–4 tuần)

Đây là lúc vidcom thành công cụ dùng được thay vì prototype.

| # | Việc | ID | Vì sao ở đây |
|---|---|---|---|
| 3.1 | **Render MP4** — job async, progress, download | PR-1 | Không có cái này thì sản phẩm không sinh ra thứ người dùng cần |
| 3.2 | Snapshot theo scene + contact sheet + invalidate khi composition đổi | PR-5, PR-6 | Storyboard hiện trống; thumbnail Home đang mock |
| 3.3 | **TTS thật** + trả duration + **mount audio vào composition** | NT-1, NT-3, NT-4 | Narration hiện chỉ ghi lệnh CLI, không có tiếng khi preview lẫn render |
| 3.4 | Sửa bug narration: bỏ auto-regenerate khi sửa script, hỗ trợ nhiều đoạn/scene | NT-13, NT-7 | Bug nghiệp vụ đã xác định (doc 12 #1, #2) |
| 3.5 | Diagnostics endpoint + tích hợp `hyperframes check`, giữ 4 cảnh báo hiện có | VD-1, VD-2, VD-3 | Đã có logic, chỉ chưa expose |
| 3.6 | Tạo / xoá / đổi tên project | PM-2, PM-4 | "New video" đang là nút chết |
| 3.7 | Scene: chèn vị trí bất kỳ, **ripple edit**, validate timing (xoá đã chuyển lên 2.6 ngày 2026-08-01) | SC-4, SC-5, SC-8 | Hiện chỉ append cuối, sửa duration để lại lỗ hổng |
| 3.8 | Thumbnail thật ở Home | PM-5 | |
| 3.9 | Allowlist khi serve asset; Range request | SE-2, FA-8 | Lỗ bảo mật đã xác định |

**Mốc:** một người dùng mở app, tạo project, nhờ AI dựng scene, nghe narration, xuất ra MP4.

---

## Giai đoạn 4 — Agent kit & đóng gói (3–4 tuần)

| # | Việc | ID |
|---|---|---|
| 4.1 | `AGENTS.md` + `CLAUDE.md` + skill router `/vidcom` + 6 skill con | AK-1, AK-2, AK-3 |
| 4.2 | Cài/refresh agent-kit khi tạo & mở project; version trong `vidcom.json`; không ghi đè file đã sửa | AK-4, AK-5 |
| 4.3 | 3 test đồng bộ agent-kit ↔ Tool Registry | AK-8 |
| 4.4 | Directory picker server-driven + token flow | PK-3 |
| 4.5 | Workspace lock/lease, single-writer daemon, MCP bridge qua IPC có xác thực | PK-4 |
| 4.6 | `vidcom` CLI đủ mode + `doctor` | PK-5, PK-8 |
| 4.7 | Node SEA: nhúng frontend asset, bỏ Next | PK-6 |
| 4.8 | Giải nén sidecar runtime vào app-data lần chạy đầu | PK-7 |
| 4.9 | Import project có sẵn | PK-12 |
| 4.10 | Smoke test trên artifact, máy sạch | — |

**Mốc:** một file tải xuống, chạy được trên máy chưa cài gì.

---

## Giai đoạn 5 — Trải nghiệm editing (3–4 tuần)

| # | Việc | ID |
|---|---|---|
| 5.1 | Kéo bar / kéo mép trên timeline để đổi timing | SC-7 |
| 5.2 | Kéo-thả đổi thứ tự scene | SC-6 |
| 5.3 | Undo/redo cấp composition | CE-8 |
| 5.4 | Không remount player khi ghi; hot-reload preview settings | PR-10, PR-11, PF-5 |
| 5.5 | CRUD file/folder + upload asset + probe metadata | FA-1, FA-2, FA-3 |
| 5.6 | Word-level timestamp → caption đồng bộ (làm `activeColor` có nghĩa) | NT-8 |
| 5.7 | Thư viện template scene | SC-12 |
| 5.8 | Cảnh báo khi đóng tab dirty; timecode có thập phân; phím tắt transport | — |
| 5.9 | Registry: duyệt catalog, cài block | RG-1, RG-2 |

---

## Giai đoạn 6 — AI Composer trong app & hoàn thiện

| # | Việc | ID |
|---|---|---|
| 6.1 | Chọn hướng A (agent CLI + MCP) hay B (model API + tool-use) | AI-1 |
| 6.2 | Streaming output, hủy giữa chừng, diff preview trước khi apply, undo một lượt | AI-2, AI-4, AI-5, AI-6 |
| 6.3 | Sandbox + giới hạn concurrent + timeout | AI-7, AI-14 |
| 6.4 | Build matrix đầy đủ, signing, notarization, auto-update, crash reporting | PK-9, PK-10, PK-11 |
| 6.5 | Render cloud, batch render, publish | PR-2, PR-3, PR-4 |
| 6.6 | Nhiều track BGM, ducking, SFX upload, waveform | AU-2..AU-9 |

---

## Bảng tóm tắt

| Giai đoạn | Nội dung | Ước lượng | Mốc |
|---|---|---|---|
| 0 | Spike | ~1 tuần | Biết D2 khả thi không |
| 1 | Nền móng | 3–4 tuần | Backend 100% Hono, CI xanh |
| 2 | MCP thật | 2–3 tuần | AI sửa được project qua tool |
| 3 | Đóng vòng lặp | 3–4 tuần | Xuất được MP4 có tiếng |
| 4 | Agent kit & đóng gói | 3–4 tuần | Một file thực thi |
| 5 | Editing UX | 3–4 tuần | Studio dùng thoải mái |
| 6 | AI Composer & hoàn thiện | — | Sản phẩm đầy đủ |

Ước lượng là **thứ tự tương đối**, không phải cam kết lịch.

## Ba việc làm ngay nếu chỉ chọn được ba

1. **PK-1** — spike packaging với native addon; đã chọn Node SEA và phải giữ smoke test artifact.
2. **1.6 + 1.3** — service ghi file duy nhất và golden-file cho `serialize()`. Mọi thứ khác xây trên đó.
3. **PR-1** — render MP4. Sản phẩm hiện chưa sinh ra được thứ người dùng thực sự cần.

## Những gì cố ý để sau

| Việc | Vì sao |
|---|---|
| Multi-user / CRDT | Local-first, một người dùng một máy |
| Auth nhiều tài khoản | Không phải sản phẩm SaaS |
| Split scene, sửa tween trực tiếp | Nice-to-have, không chặn ai |
| LSP trong editor | Agent là tác giả chính của code |
| Bản địa hoá | Chưa có người dùng cuối |
