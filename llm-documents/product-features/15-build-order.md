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

**Gate kỹ thuật: ĐÃ ĐÓNG.** Spike thay thế đã chọn Node SEA và loại Bun native-loader rewrite; Giai đoạn 1–3 đã chạy trên quyết định này. Mọi thay đổi toolchain sau này MUST chạy lại smoke test artifact (xem PK-1 ở §"Ba việc làm ngay"). Bằng chứng và lệnh tái hiện: [spikes/phase-0](../../spikes/phase-0/README.md).

---

## Giai đoạn 1 — Nền móng (3–4 tuần)

Không có tính năng mới cho người dùng. Đây là phần không thể thêm sau.

> **Hoàn tất 2026-08-01.** Checklist 118/118, toàn bộ finding trong `review.md` đã xử lý, GitHub Actions CI xanh. Chi tiết: [spec Core Backend Foundation](../specs-and-process/specs/spec-core-backend-foundation/spec-core-backend-foundation-complete.md).

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

> **Hoàn tất 2026-08-02.** Phase 2 ship một Registry gồm 10 tool (`list_projects`, `get_project_context`, `list_scenes`, `read_composition`, `create_scene`, `set_scene_timing`, `set_text`, `save_file`, `delete_file`, `delete_scene`) qua stdio và Streamable HTTP, phục vụ legacy `2025-11-25` lẫn modern `2026-07-28`. Destructive flow dùng daemon-issued grant + verified backup; CLI có approval, credential, backup và recovery admin. Local matrix 423 tests + 22 golden tests và remote CI #6 trên ship commit đều xanh.

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

**Mốc:** **Đạt ở local demo** — exact SDK clients resolve source-checkout Phase 2 command `vidcom mcp` từ clean packed CLI artifact, list/call đủ tool; modern host hoàn tất elicitation → trusted CLI approval → `delete_file` retry, nhả lease và giữ stdout protocol-only. Đây chưa phải packaged Node SEA của Phase 4.

---

## Giai đoạn 3 — Đóng vòng lặp sản phẩm (re-baseline 7–8 tuần)

Đây là lúc vidcom thành công cụ dùng được thay vì prototype. Re-baseline 2026-08-04 kéo agent-kit vào cùng vòng lặp vì harness phải **biết** quy trình trước khi có thể dùng MCP; chi tiết/AC authoritative nằm ở [spec Project Delivery Loop](../specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-detailed-goal.md).

> **Hoàn tất 2026-08-05** — checklist ✅, xem [spec Project Delivery Loop](../specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-complete.md).
>
> **Nợ còn lại — 3.4 chỉ xong một nửa.** Cột "Vì sao ở đây" của 3.4 hứa *"`New video` thành luồng hoàn chỉnh"*, nhưng checklist map R5 vào E.3 + L.1–L.5 + Phase O — **toàn bộ là Core/adapter/HTTP, không có một task FE nào**. Kết quả: `POST /v1/projects` chạy được, còn nút `New video` trong UI vẫn `disabled`. Đã chuyển thành **5.0** để không mất dấu. Bài học đi kèm: một requirement có User Story nói về UI thì checklist của nó phải có task UI, nếu không "complete" chỉ đúng ở tầng dưới.

| # | Việc | ID | Vì sao ở đây |
|---|---|---|---|
| 3.1 | Workspace chạy ở folder bất kỳ; `vidcom.json` là marker; state `empty`/`invalid` + recovery `entryId` | R1 | Bỏ giả định `projects/` và project luôn có composition |
| 3.2 | Preset platform + schema/backfill `vidcom.json` | R2, R3 | Tạo project đúng output ngay từ đầu |
| 3.3 | `.vidcom/` projection + `sourceRevision` tách ghi nguồn/dẫn xuất | R4 | Harness đọc được state mà không tạo dual-authority |
| 3.4 | Tạo / nhận / xoá / đổi tên project với journal + backup | R5, PM-2, PM-4 | "New video" thành luồng hoàn chỉnh, recovery được |
| 3.5 | **Render MP4** — job async, progress, cancel tree, recovery, download | R6, PR-1 | Không có cái này thì sản phẩm không sinh ra thứ người dùng cần |
| 3.6 | Snapshot theo scene + contact sheet + partial retry | R7, PR-5, PR-6 | Storyboard/thumbnail có hình thật |
| 3.7 | Thumbnail thật ở Home | R8, PM-5 | Bỏ mock, có fallback ổn định cho invalid entry |
| 3.8 | Diagnostics endpoint + `hyperframes check`, giữ cảnh báo hiện có | R9, VD-1..3 | Agent và người dùng thấy lỗi trước render |
| 3.9 | Scene: chèn vị trí, ripple **theo track**, validate timing | R10, SC-4, SC-5, SC-8 | Sửa duration không phá timeline multi-track |
| 3.10 | Narration nhiều cue/scene, tương thích sidecar cũ | R11, NT-7 | Không mất thoại trong scene nhiều câu |
| 3.11 | MCP: 4 tool vòng lặp + `install_agent_kit`; HTTP/MCP dùng cùng usecase | R12, MP-1/2/11/12 | Agent tự validate/snapshot/render/poll được |
| 3.12 | Agent-kit hai manifest host + install/link/replace + 3 test sync | R13, AK-1..6, AK-8 | Harness biết quy trình và cài đúng workspace/host |

**Mốc:** một người dùng mở app, tạo project, nhờ AI dựng scene, nghe narration, xuất ra MP4.

---

## Giai đoạn 4 — Đóng gói & runtime phân phối (re-baseline 7–8 tuần) ✅

> **Đóng 2026-08-16** — spec chuyển sang [`-complete.md`](../specs-and-process/specs/spec-packaging-and-distribution/spec-packaging-and-distribution-complete.md), 13 phase A–M và 174/174 mục. Mục cuối cùng là AC artifact của Phase D: nguồn release mà C-21 duyệt chưa bao giờ có code chạy nó, nên `scripts/build-release-media.mjs` dựng ffmpeg/ffprobe 7.1.1 từ đúng các pin upstream và `prepare-packaged-runtime --release-media` chỉ nhận binary có provenance khớp cả nguồn lẫn bytes. Artifact production ở commit `3f49e7c` (SHA-256 `fb658b6b…56d7a1`) render **MP4 8,000000 s `h264`+`aac`** với PATH rỗng và app-data/runtime rỗng. Packaged smoke ba OS, browser session và process gate đều xanh ở exact head.
>
> **Còn mang sang Giai đoạn 6**: dựng nguồn release cho Linux x64 và Windows x64 **trên chính host của chúng** (DR-1 cấm cross-build), ký/notarize và full 3 OS × 2 kiến trúc. Bước `offline` của smoke chỉ chạy được nơi cắt được mạng ở tầng runner.

> **Detailed Goals đã duyệt 2026-08-07** — nguồn authoritative là [spec Packaging & Distribution Runtime](../specs-and-process/specs/spec-packaging-and-distribution/spec-packaging-and-distribution-detailed-goal.md). Scope hiện là khoảng **170 SP**: ba artifact native target (macOS arm64, Windows x64, Linux x64), packaged smoke trên runner cùng OS, Windows là release gate. `vidcom worker` bị loại khỏi Giai đoạn 4 vì daemon đã sở hữu scheduler; thêm mode này sẽ tạo đường điều phối job thứ hai. Nút `New video` mức tối thiểu được kéo từ 5.0 vào 4.4/R1.19 để artifact tự đi hết vòng demo.

| # | Việc | ID |
|---|---|---|
| 4.1 | **Đã chuyển lên 3.12** — nội dung agent-kit | AK-1, AK-2, AK-3 |
| 4.2 | **Đã chuyển lên 3.12** — cài tường minh ở gốc workspace theo host; không cài lúc tạo/mở project, không version trong `vidcom.json` | AK-4, AK-5, AK-6 |
| 4.3 | **Đã chuyển lên 3.12** — 3 test đồng bộ agent-kit ↔ Tool Registry | AK-8 |
| 4.4 | Directory picker server-driven + token flow + UI chọn/đổi workspace + UI tạo project từ preset tối thiểu | PK-3 |
| 4.5 | Workspace lock/lease, single-writer daemon, MCP bridge qua IPC có xác thực | PK-4 |
| 4.6 | `vidcom` CLI đủ mode + `doctor`; `render` là thin client của daemon; **không có mode `worker`** trong giai đoạn này | PK-5, PK-8 |
| 4.7 | Node SEA: nhúng frontend asset, bỏ Next | PK-6 |
| 4.8 | Giải nén sidecar runtime vào app-data lần chạy đầu — **kèm cả thư viện motion**: `install_motion_library` đọc chúng từ `node_modules`, thứ không tồn tại trong artifact. Giải nén theo layout `<packageName>/<packagePath>` (giữ `package.json` để guard version còn chạy) rồi truyền đường dẫn qua `CompositionRootConfig.motionLibraryRoot`. Thiếu bước này thì vendor thư viện fail trên máy sạch, đúng tình huống nó tồn tại để phục vụ | PK-7 |
| 4.9 | Import project có sẵn | PK-12 |
| 4.10 | Smoke test trên artifact, máy sạch, cùng OS với artifact: macOS arm64 + Windows x64 + Linux x64 | — |

**Mốc:** một file tải xuống, chạy được trên máy chưa cài gì. — **Đạt 2026-08-16**: artifact `darwin-arm64` từ nguồn release được duyệt đi hết vòng nhận dạng → doctor → chọn workspace → tạo/import project → MCP bridge cạnh UI → TTS + snapshot + render MP4 → upload/SSE → lease loss → provenance, với `node`/`python`/`bun` không có trên PATH.

---

## Giai đoạn 5 — Trải nghiệm editing (re-baseline 9–11 tuần)

> **Spec đã mở lại 2026-08-21 cho R16–R20** — [spec Editing Experience](../specs-and-process/specs/spec-editing-experience/spec-editing-experience-inprocess.md). R1–R15/S0–P18 và toàn bộ C-01, H-01–H-04, M-01–M-07, L-01, G-01–G-03 vẫn có closure evidence tại production-source authority `03a2df5659552ad9638d05888f08b3a0fba38f2f`; P19–P25 xử lý thumbnail Storyboard, Arrange canvas, preview audio, inspector và story-motion/agent-kit rồi dựng lại Odyssey.

| # | Việc | ID |
|---|---|---|
| 5.0 | **Đã chuyển lên Giai đoạn 4 / R1.19** — UI tạo project từ preset ở mức tối thiểu; CRUD file/folder, upload asset và agent generation vẫn ở 5.5/Giai đoạn 6 | R5 — nợ từ GĐ 3 |
| 5.1 | Kéo bar / kéo mép trên timeline để đổi timing | SC-7 |
| 5.2 | Kéo-thả đổi thứ tự scene | SC-6 |
| 5.3 | Undo/redo cấp composition | CE-8 |
| 5.4 | Giữ `PlayerHost` khi ghi; mọi cập nhật, kể cả preview settings, đổi engine bằng double-buffer. **PR-11 hot-reload từng composition chuyển sang GĐ 6** sau spike | PR-10, PF-5 |
| 5.5 | CRUD file/folder + upload asset + probe metadata | FA-1, FA-2, FA-3 |
| 5.6 | Word-level timestamp → caption đồng bộ (làm `activeColor` có nghĩa) | NT-8 |
| 5.7 | Thư viện template scene | SC-12 |
| 5.8 | Cảnh báo khi đóng tab dirty; timecode có thập phân; phím tắt transport | — |
| 5.9 | Registry: duyệt catalog, cài **và mount** block | RG-1, RG-2 |
| 5.10 | Dải thumbnail trên clip timeline (lấy mẫu, cache, huỷ, virtualization) | FA-4 (một phần) |
| 5.11 | Kéo asset từ panel Media vào timeline (thả tạo scene bọc asset) | FA-2, SC-4 |
| 5.12 | Chọn nhiều clip: dịch nhóm, xoá nhóm, một mục undo | SC-9 |

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

| Giai đoạn | Nội dung | Ước lượng | Mốc | Trạng thái |
|---|---|---|---|---|
| 0 | Spike | ~1 tuần | Biết D2 khả thi không | ✅ 2026-08-01 — chọn Node SEA |
| 1 | Nền móng | 3–4 tuần | Backend 100% Hono, CI xanh | ✅ 2026-08-01 — 118/118 |
| 2 | MCP thật | 2–3 tuần | AI sửa được project qua tool | ✅ 2026-08-02 — 10 tool, 2 era |
| 3 | Đóng vòng lặp | 7–8 tuần (re-baseline 2026-08-04) | Xuất được MP4 có tiếng | ✅ 2026-08-05 — còn nợ R5 UI → 5.0 |
| 4 | Đóng gói & runtime phân phối | 7–8 tuần (re-baseline 2026-08-07) | Một file thực thi, smoke native trên 3 target | ✅ 2026-08-16 — 174/174; AC cuối đóng bằng C-71 (release media dựng từ nguồn được duyệt), MP4 8 s `h264`+`aac` render từ artifact production trên PATH rỗng |
| 5 | Editing UX | re-baseline 9–11 tuần (~212 SP, 2026-08-16) | Studio dùng thoải mái | 🟡 **đang thực thi** — Goals bản 7, Design bản 12, Checklist đều duyệt 2026-08-16; S0 xong, kế tiếp P0 |
| 6 | AI Composer & hoàn thiện | — | Sản phẩm đầy đủ | ⬜ chưa mở spec |

> Giai đoạn 4 đã đổi tên từ "Agent kit & đóng gói" sau khi AK-1..3/4/5/6/8 chuyển lên 3.12. Detailed Goals đã xác nhận phần còn lại **không thuần đóng gói**: còn single-writer daemon/MCP bridge, runtime artifact, UI workspace/project tối thiểu và packaged smoke native.

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
