# Steering — Index

Đây là **always-on steering** cho vidcom-v2. Đọc trước khi viết bất kỳ dòng code backend nào.

Steering ≠ spec. Steering là **luật thường trực**, áp dụng cho mọi task, không cần opt-in. Spec process (`llm-documents/specs-and-process/`) chỉ chạy khi người dùng yêu cầu tường minh.

## Cách dùng

| Tình huống | Đọc file nào |
|---|---|
| Thêm/sửa endpoint | [04-api-design](04-api-design.md) · [06-validation](06-validation.md) · [09-security](09-security.md) |
| Thêm/sửa MCP tool | [05-mcp-tool-design](05-mcp-tool-design.md) · [13-mcp-protocol-compatibility](13-mcp-protocol-compatibility.md) · [06-validation](06-validation.md) · [14-agent-kit-and-skills](14-agent-kit-and-skills.md) §7 |
| Viết skill / sửa AGENTS.md ship cho agent | [14-agent-kit-and-skills](14-agent-kit-and-skills.md) |
| Thêm nghiệp vụ mới | [03-architecture-ddd](03-architecture-ddd.md) · [02-project-layout](02-project-layout.md) |
| Ghi file / đụng workspace | [07-data-and-storage](07-data-and-storage.md) |
| Tác vụ dài (render/TTS/snapshot) | [08-jobs-and-queue](08-jobs-and-queue.md) |
| Thêm dependency | [01-backend-stack](01-backend-stack.md) |
| Viết test | [10-testing](10-testing.md) |
| Bất kỳ lúc nào viết code | [11-code-style](11-code-style.md) |
| Viết/sửa tài liệu | [12-documentation-rules](12-documentation-rules.md) |

## Danh sách file

| File | Nội dung |
|---|---|
| [01-backend-stack.md](01-backend-stack.md) | Runtime, framework, dependency policy, những gì bị cấm |
| [02-project-layout.md](02-project-layout.md) | Cấu trúc package, import boundary, quy tắc đặt tên |
| [03-architecture-ddd.md](03-architecture-ddd.md) | Application Core, port/adapter, use case, domain model |
| [04-api-design.md](04-api-design.md) | REST convention, error contract, versioning, SSE |
| [05-mcp-tool-design.md](05-mcp-tool-design.md) | MCP tool contract, phân mức quyền, audit |
| [06-validation.md](06-validation.md) | Schema validation tại boundary, normalize, nghiệp vụ |
| [07-data-and-storage.md](07-data-and-storage.md) | Workspace vs app-data, ghi file, concurrency, cache |
| [08-jobs-and-queue.md](08-jobs-and-queue.md) | Job lifecycle, progress, cancel, recovery |
| [09-security.md](09-security.md) | Local security baseline |
| [10-testing.md](10-testing.md) | Chiến lược test, golden file, contract test |
| [11-code-style.md](11-code-style.md) | **Doc comment bắt buộc cho hàm**, TypeScript style, comment policy, error handling |
| [12-documentation-rules.md](12-documentation-rules.md) | Khi nào và cách cập nhật tài liệu |
| [13-mcp-protocol-compatibility.md](13-mcp-protocol-compatibility.md) | **Tương thích legacy ↔ `2026-07-28`**: một runtime SDK phục vụ hai era, negotiation, MRTR, tasks extension |
| [14-agent-kit-and-skills.md](14-agent-kit-and-skills.md) | **AGENTS.md + skill ship cho Codex/Claude Code**, quy trình chuẩn 9 bước |

## Nguyên tắc bất biến

Bốn quyết định kiến trúc (từ [14-local-first-mcp-packaging-architecture](../product-features/14-local-first-mcp-packaging-architecture.md) §1) — mọi steering rule bên dưới phục vụ chúng:

| | Quyết định |
|---|---|
| **D1** | MCP là interface hạng nhất. Use case nào không gọi được qua MCP thì coi như chưa hoàn chỉnh. |
| **D2** | Đóng gói thành một file thực thi. Người dùng nhận binary, không nhận source. |
| **D3** | Người dùng chọn thư mục workspace. Project public ở đó; mọi thứ khác ẩn. |
| **D4** | Backend 100% Hono. Next.js chỉ forward, không chứa nghiệp vụ. |

Mười một nguyên tắc domain (từ [13-backend-requirements](../product-features/13-backend-requirements.md) §1) **P1–P11** phải được bảo toàn khi viết lại. Nhắc lại những cái ràng buộc code backend mạnh nhất:

- **P1** — hợp đồng `data-*` trên HTML là nguồn sự thật, không phải metadata JSON.
- **P2** — preview settings không bao giờ rewrite composition source.
- **P3** — preview và render dùng **chung một** code path.
- **P5** — đếm, không đoán: dữ liệu không parse được thì báo số lượng, không bịa giá trị.
- **P7** — optimistic concurrency khi ghi file.

## Khi steering mâu thuẫn với yêu cầu

Nêu mâu thuẫn ra và hỏi trước khi làm khác. Không im lặng đi đường vòng.

## Khi steering thiếu hoặc sai

Steering là tài liệu sống. Nếu một rule cản trở việc đúng đắn, hoặc thực tế đã đi khác rule, **sửa steering trong cùng PR** với thay đổi code — đừng để rule mục ra. Xem [12-documentation-rules](12-documentation-rules.md).
