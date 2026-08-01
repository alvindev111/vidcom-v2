Thứ tự chức năng cần làm
Giai đoạn 0 — Spike (~1 tuần). Chặn mọi thứ
Việc	Xong nghĩa là
0.1	Bun --compile với onnxruntime-node, sharp, esbuild, puppeteer-core	Biết D2 khả thi hay phải đổi sang Node SEA
0.2	Chạy hyperframes CLI dưới Bun (nó khai engines: node >=22)	Biết cần Node sidecar không
0.3	Hai SDK MCP (server@2.x + sdk@1.x) sống chung một process	Biết dual-stack khả thi
0.4	Route cụ thể của Next thắng optional catch-all	Kế hoạch cắt chuyển D4 đứng vững
0.1 hoặc 0.3 hỏng → dừng, thiết kế lại. Đừng viết production code trước khi biết.

Kết quả spike ngày 2026-08-01: **0.1 Bun trực tiếp FAIL nhưng fallback Node SEA PASS; 0.2 PASS trong phạm vi parse/lint/list; 0.3 PASS; 0.4 PASS**. Gate kỹ thuật đã chọn Node SEA; Phase 1 chờ xác nhận thay đổi thiết kế/checklist. Bằng chứng và lệnh tái hiện: [spikes/phase-0/README.md](spikes/phase-0/README.md).

Giai đoạn 1 — Nền móng (3–4 tuần)
Không có tính năng mới. Đây là phần không thể thêm sau.

Dựng package + lint import boundary → test harness + CI → golden-file cho serialize() → WorkspaceRoot bỏ cwd → port/adapter + chuyển parse sang Core → service ghi file duy nhất (content hash, atomic, revision, audit) → resolveInProject() bịt lỗ traversal → schema validation + ErrorCode → auth (loopback, nonce→cookie, Host check) → cắm Hono catch-all, cắt route đọc trước ghi sau → bỏ RSC đọc filesystem → job infrastructure → SSE + file watcher.

Mốc: src/ chỉ còn một file forward. CI xanh.

Giai đoạn 2 — MCP chạy thật (2–3 tuần)
Tool Registry protocol-agnostic → tool đọc → transport modern (server/discover, resultType, CacheableResult) → transport legacy + negotiation + map error code → tool ghi kèm expectedRevision → tool destructive + MRTR → audit có protocol version → contract test chạy 2 lần → vidcom mcp stdout sạch.

Mốc: Claude Code / Codex sửa được project thật qua tool.

Giai đoạn 3 — Đóng vòng lặp sản phẩm (3–4 tuần)
Render MP4 → snapshot theo scene → TTS thật + mount audio → sửa 2 bug narration → diagnostics endpoint → tạo/xoá project → scene xoá/chèn/ripple → thumbnail thật → allowlist asset.

Mốc: người dùng mở app, nhờ AI dựng scene, nghe narration, xuất MP4.

Giai đoạn 4 — Agent kit & đóng gói (3–4 tuần)
AGENTS.md + skill router → cài/refresh agent-kit → 3 test đồng bộ → directory picker + token → workspace lock + single writer → vidcom CLI đủ mode → Node SEA, bỏ Next → giải nén sidecar → import project cũ → smoke test trên artifact.

Mốc: một file tải xuống, chạy trên máy sạch.

Giai đoạn 5 — Editing UX (3–4 tuần)
Kéo timing / kéo-thả thứ tự → undo/redo → không remount player khi ghi → CRUD file + upload asset → word timestamp cho caption → template scene → registry.

Giai đoạn 6 — AI Composer & hoàn thiện
Agent thật trong app → streaming/cancel/diff/undo → sandbox → build matrix + signing + auto-update → render cloud → audio nâng cao.

Nếu chỉ chọn được 3 việc
PK-1 — spike packaging native đã chọn Node SEA. Mọi thay đổi toolchain phải chạy lại smoke test artifact.
Service ghi file duy nhất + golden-file serialize() — mọi đường ghi xây trên đó; làm sau nghĩa là viết lại.
Render MP4 — sản phẩm hiện chưa sinh ra được thứ người dùng thực sự cần.
Ước lượng tuần là thứ tự tương đối, không phải cam kết lịch — tôi không biết quy mô đội và thời gian dành cho dự án.
