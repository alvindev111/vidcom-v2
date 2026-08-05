# Thứ tự chức năng cần làm

> **File này là bản rút gọn.** Backlog chuẩn duy nhất là
> [llm-documents/product-features/15-build-order.md](llm-documents/product-features/15-build-order.md).
> Khi hai file lệch nhau, **build-order đúng**.
>
> Sửa build-order thì MUST đồng bộ file này ngay trong cùng lần sửa. Doc 13 §4 đã
> cảnh báo hai bản lộ trình sẽ lệch; lần lệch gần nhất (2026-08-04 → 08-05) làm
> file này giữ danh sách Giai đoạn 3 cũ suốt một vòng re-baseline.
>
> Đồng bộ lần cuối: **2026-08-05**.

| Giai đoạn | Nội dung | Trạng thái |
|---|---|---|
| 0 | Spike | ✅ 2026-08-01 — chọn Node SEA |
| 1 | Nền móng | ✅ 2026-08-01 — 118/118 |
| 2 | MCP chạy thật | ✅ 2026-08-02 — 10 tool, 2 era |
| 3 | Đóng vòng lặp sản phẩm | ✅ 2026-08-05 — còn nợ R5 UI → 5.0 |
| 4 | Đóng gói & runtime phân phối | ⬜ chưa mở spec |
| 5 | Trải nghiệm editing | ⬜ chưa mở spec |
| 6 | AI Composer & hoàn thiện | ⬜ chưa mở spec |

## Giai đoạn 0 — Spike (~1 tuần). Chặn mọi thứ

| # | Việc | Xong nghĩa là |
|---|---|---|
| 0.1 | Bun `--compile` với `onnxruntime-node`, `sharp`, `esbuild`, `puppeteer-core` | Biết D2 khả thi hay phải đổi sang Node SEA |
| 0.2 | Chạy `hyperframes` CLI dưới Bun (nó khai `engines: node >=22`) | Biết cần Node sidecar không |
| 0.3 | Hai SDK MCP (`server@2.x` + `sdk@1.x`) sống chung một process | Biết dual-stack khả thi |
| 0.4 | Route cụ thể của Next thắng optional catch-all | Kế hoạch cắt chuyển D4 đứng vững |

0.1 hoặc 0.3 hỏng → dừng, thiết kế lại. Đừng viết production code trước khi biết.

**Kết quả 2026-08-01:** 0.1 Bun trực tiếp **FAIL** nhưng fallback **Node SEA PASS** · 0.2 PASS trong phạm vi parse/lint/list · 0.3 PASS · 0.4 PASS. Gate đã đóng, chọn Node SEA. Mọi thay đổi toolchain sau này phải chạy lại smoke test artifact. Bằng chứng: [spikes/phase-0/README.md](spikes/phase-0/README.md).

## Giai đoạn 1 — Nền móng (3–4 tuần) ✅

Không có tính năng mới. Đây là phần không thể thêm sau.

Dựng package + lint import boundary → test harness + CI → golden-file cho `serialize()` → `WorkspaceRoot` bỏ cwd → port/adapter + chuyển parse sang Core → service ghi file duy nhất (content hash, atomic, revision, audit) → `resolveInProject()` bịt lỗ traversal → schema validation + `ErrorCode` → auth (loopback, nonce→cookie, Host check) → cắm Hono catch-all, cắt route đọc trước ghi sau → bỏ RSC đọc filesystem → job infrastructure → SSE + file watcher.

**Mốc:** `src/` chỉ còn một file forward. CI xanh. — Đạt 2026-08-01, checklist 118/118.

## Giai đoạn 2 — MCP chạy thật (2–3 tuần) ✅

Tool Registry protocol-agnostic → tool đọc → transport modern (`server/discover`, `resultType`, `CacheableResult`) → transport legacy + negotiation + map error code → **nâng cấp Core: `WriteAuthority` composite mutation** → **`createScene` dùng composite, `setSceneScript` đánh dấu narration stale** → tool ghi kèm `expectedRevision` → tool destructive + grant do daemon phát hành + backup → transport Streamable HTTP + credential cho AI host → audit có protocol version → contract test chạy 2 lần → `vidcom mcp` stdout sạch.

**Mốc:** Claude Code / Codex sửa được project thật qua tool. — Đạt 2026-08-02: 10 tool, legacy `2025-11-25` + modern `2026-07-28`, 423 tests + 22 golden xanh.

## Giai đoạn 3 — Đóng vòng lặp sản phẩm (re-baseline 7–8 tuần) ✅

Re-baseline 2026-08-04 kéo agent-kit từ Giai đoạn 4 lên, vì harness phải **biết** quy trình trước khi dùng được MCP. AC authoritative: [spec Project Delivery Loop](llm-documents/specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-detailed-goal.md).

| # | Việc | ID |
|---|---|---|
| 3.1 | Workspace chạy ở folder bất kỳ; `vidcom.json` là marker; state `empty`/`invalid` + recovery `entryId` | R1 |
| 3.2 | Preset platform + schema/backfill `vidcom.json` | R2, R3 |
| 3.3 | `.vidcom/` projection + `sourceRevision` tách ghi nguồn/dẫn xuất | R4 |
| 3.4 | Tạo / nhận / xoá / đổi tên project với journal + backup | R5 |
| 3.5 | **Render MP4** — job async, progress, cancel tree, recovery, download | R6 |
| 3.6 | Snapshot theo scene + contact sheet + partial retry | R7 |
| 3.7 | Thumbnail thật ở Home | R8 |
| 3.8 | Diagnostics endpoint + `hyperframes check` | R9 |
| 3.9 | Scene: chèn vị trí, ripple **theo track**, validate timing | R10 |
| 3.10 | Narration nhiều cue/scene, tương thích sidecar cũ | R11 |
| 3.11 | MCP: 4 tool vòng lặp + `install_agent_kit` | R12 |
| 3.12 | Agent-kit hai manifest host + install/link/replace + 3 test sync | R13 |

**Mốc:** người dùng mở app, nhờ AI dựng scene, nghe narration, xuất MP4.

**Nợ còn lại:** 3.4 giao R5 ở tầng Core/adapter/HTTP (`POST /v1/projects` chạy được) nhưng checklist **không có task FE nào**, nên nút `New video` vẫn `disabled`. Đã chuyển thành **5.0**.

## Giai đoạn 4 — Đóng gói & runtime phân phối (3–4 tuần)

*(4.1–4.3 — nội dung agent-kit — đã chuyển lên 3.12.)*

Directory picker + token flow → workspace lock/lease + single-writer daemon + MCP bridge qua IPC → `vidcom` CLI đủ mode + `doctor` → Node SEA nhúng frontend asset, bỏ Next → giải nén sidecar runtime **và thư viện motion** vào app-data lần chạy đầu → import project có sẵn → smoke test trên artifact máy sạch.

Thư viện motion là bẫy dễ bỏ sót: `install_motion_library` đọc chúng từ `node_modules`, thứ artifact không có. Xem 4.8 trong build-order.

**Mốc:** một file tải xuống, chạy trên máy chưa cài gì.

## Giai đoạn 5 — Trải nghiệm editing (3–4 tuần)

**5.0 — nối UI tạo project** (nợ từ 3.4: bỏ `disabled`, dialog tên + preset, `POST /v1/projects`, kèm test cho route) → kéo timing / kéo-thả thứ tự scene → undo/redo → không remount player khi ghi → CRUD file + upload asset → word timestamp cho caption → template scene → registry.

## Giai đoạn 6 — AI Composer & hoàn thiện

Agent thật trong app → streaming/cancel/diff/undo → sandbox → build matrix + signing + auto-update → render cloud → audio nâng cao.

## Nếu chỉ chọn được 3 việc

1. **PK-1** — spike packaging đã chọn Node SEA. Mọi thay đổi toolchain phải chạy lại smoke test artifact.
2. **Service ghi file duy nhất + golden-file `serialize()`** — mọi đường ghi xây trên đó; làm sau nghĩa là viết lại.
3. **Render MP4** — sản phẩm không sinh ra được thứ người dùng thực sự cần nếu thiếu nó.

Ước lượng tuần là thứ tự tương đối, không phải cam kết lịch.
