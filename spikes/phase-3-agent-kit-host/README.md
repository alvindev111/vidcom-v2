# Giai đoạn 3 — Spike ma trận host agent-kit (gate OQ-6)

Trạng thái: **PASS — ma trận đã chạy trên hai host SaaS thật ngày 2026-08-04**.

Kiểm cục bộ đã PASS: MCP client gọi `vidcom_probe` nhận `VIDCOM_PROBE_OK selftest`; `codex mcp list` nhận đúng stdio command/args; cả hai script qua ESLint và Bun bundle. Ma trận sau đó được chạy bằng Codex CLI 0.146.0 và Claude Code 2.1.220 trên Node v26.5.0, sau khi người dùng cho phép gửi fixture tổng hợp tới OpenAI và Anthropic.

Mục tiêu không phải chứng minh file tồn tại. Mỗi ca phải kích hoạt router bằng cú pháp native (`$vidcom` ở Codex, `/vidcom` ở Claude Code) và gọi đúng một lần MCP tool cục bộ `vidcom_probe`.

## Ma trận

| Host | `.agents/skills` | `.claude/skills` | `x-vidcom-agent-kit` | Dòng link instruction |
|---|---|---|---|---|
| Codex 0.146.0 | **PASS** | **FAIL** | **PASS** | **FAIL** với `Read and follow ./AGENTS.vidcom.md.` |
| Claude Code 2.1.220 | **FAIL** (`Unknown command: /vidcom`) | **PASS** | **PASS** | **PASS** với `@CLAUDE.vidcom.md` |

Mỗi PASS ở bảng là một record thật do `vidcom_probe` ghi, đúng `caseId` và (với link) đúng `linkToken`; text model không có record không được tính. Codex link case trả `LINK_NOT_FOLLOWED`, xác nhận skill vẫn được discover nhưng file phụ không đi vào effective instructions.

Quyết định sản phẩm:

- `codex` cài `AGENTS.md` + `.agents/skills/**`; không expose operation `link`, recovery cho file người dùng là merge thủ công từ `AGENTS.vidcom.md`.
- `claude-code` cài `CLAUDE.md` + `.claude/skills/**`; operation `link` append đúng `@CLAUDE.vidcom.md` với `expectedContentHash`.
- Giữ frontmatter `x-vidcom-agent-kit`: cả hai host đều parse file và gọi probe thành công.

## Harness

- [`run-matrix.mjs`](./run-matrix.mjs) tạo workspace tổng hợp riêng dưới `%TEMP%` (không nằm trong Git repo, để host không nạp source/instruction dự án), chạy hai thư mục cho mỗi host, rồi kiểm frontmatter lạ và dòng link trên thư mục được host nhận.
- [`mock-mcp.mjs`](./mock-mcp.mjs) expose đúng một tool và ghi `caseId`/`linkToken` vào JSONL. Một câu trả lời văn bản không có record tool call không được tính là PASS.
- Codex chạy `--ephemeral --ignore-user-config --sandbox read-only`, allowlist và auto-approve **chỉ** `vidcom_probe`; Claude chạy `--no-session-persistence --strict-mcp-config --permission-mode dontAsk` và allow đúng tool tương ứng. Fixture không chứa source dự án.

```powershell
node spikes/phase-3-agent-kit-host/run-matrix.mjs
# hoặc chạy lại riêng một host:
node spikes/phase-3-agent-kit-host/run-matrix.mjs codex
node spikes/phase-3-agent-kit-host/run-matrix.mjs claude-code
```

Lệnh trên gửi prompt và fixture tổng hợp tới host SaaS được chọn qua tài khoản CLI hiện có, nên mỗi lần chạy vẫn cần đồng ý tường minh. Kết quả thô được ghi tạm vào `%TEMP%/vidcom-host-matrix-*/results.json`; README này giữ kết luận tái lập được, còn temp fixture phải được dọn sau review.
