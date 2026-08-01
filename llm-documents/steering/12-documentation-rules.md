# 12 — Documentation rules

## 1. Bản đồ tài liệu

```
llm-documents/
├── steering/            LUẬT THƯỜNG TRỰC — always-on, áp dụng mọi task
├── product-features/    MÔ TẢ HỆ THỐNG — hiện trạng + định hướng
└── specs-and-process/   SPEC — chỉ chạy khi người dùng yêu cầu tường minh
```

| Thư mục | Trả lời câu hỏi | Cập nhật khi |
|---|---|---|
| `steering/` | *Phải làm thế nào?* | Quy tắc đổi, hoặc thực tế đã đi khác quy tắc |
| `product-features/` | *Hệ thống đang là gì và sẽ thành gì?* | Hành vi đổi, hoặc quyết định kiến trúc đổi |
| `specs-and-process/` | *Task cụ thể này làm ra sao?* | Trong vòng đời một spec |

MUST NOT trộn ba loại. Một quyết định kiến trúc không nằm trong steering; một quy tắc coding không nằm trong product-features.

## 2. Steering

- Viết dạng **luật**: MUST / MUST NOT / SHOULD. Không viết dạng tuỳ bút.
- Mỗi rule phải **kiểm tra được** — người review hoặc lint phải phán được đúng/sai.
- Rule nào có lý do không hiển nhiên MUST kèm lý do, tốt nhất là gắn với một thất bại có thật trong repo.
- MUST NOT chép lại nội dung của product-features. Link sang.
- Đánh số file để có thứ tự đọc. Thêm file mới → cập nhật [00-index](00-index.md).

Rule nào không ai theo nổi, hoặc code đã đi khác từ lâu: **sửa hoặc xoá**. Steering mục nát còn hại hơn không có.

## 3. product-features

Mỗi chức năng viết theo bốn mục cố định:

```
**Là gì**        — chức năng người dùng thấy
**Logic hiện tại** — code làm chính xác điều gì, kèm file:line
**Trạng thái**    — THẬT | MOCK | NÚT CHẾT | CHƯA CÓ
**Kỳ vọng backend** — backend mới cần cung cấp gì
```

Rule:

- MUST ghi rõ **THẬT vs MOCK**. Đây là điểm giá trị nhất của bộ tài liệu — không được để người đọc tưởng một thứ mock là đã chạy.
- MUST kèm `file:line` khi mô tả logic, dạng markdown link.
- MUST ghi thời điểm chụp và commit ở đầu tài liệu tổng.
- MUST nêu rủi ro và nợ kỹ thuật đã biết, kèm bằng chứng — không nêu chung chung.

## 4. Tham chiếu code

- Dùng markdown link, không backtick: `[projects.server.ts:130](../../src/lib/hyperframes/projects.server.ts#L130)`.
- MUST trỏ tới **symbol**, không tới dòng ngẫu nhiên giữa hàm.
- Số dòng sẽ mục. Khi sửa code làm lệch anchor trong tài liệu, MUST cập nhật cùng PR.
- Đường dẫn tương đối tính từ vị trí file tài liệu.

## 5. Khi nào phải cập nhật tài liệu

| Thay đổi | Cập nhật |
|---|---|
| Thêm/đổi/xoá endpoint | [04-api-design](04-api-design.md) nếu đổi convention · product-features doc API |
| Thêm/đổi MCP tool | [05-mcp-tool-design](05-mcp-tool-design.md) nếu đổi luật · contract test |
| Đổi hành vi người dùng thấy được | product-features feature tương ứng |
| Quyết định kiến trúc | product-features doc kiến trúc + steering nếu sinh ra luật mới |
| Thêm dependency | [01-backend-stack](01-backend-stack.md) |
| Đổi cấu trúc thư mục | [02-project-layout](02-project-layout.md) |
| Sửa xong một mục trong bảng nợ kỹ thuật | Đánh dấu đã xử lý, **không xoá dòng** — giữ lịch sử |

**Cập nhật trong cùng PR với code.** MUST NOT để lại "sẽ cập nhật doc sau".

## 6. Ngôn ngữ và trình bày

- Tài liệu: **tiếng Việt**. Giữ nguyên thuật ngữ kỹ thuật, tên API, tên file, lệnh CLI, thông báo lỗi.
- MUST NOT dịch: `content hash`, `optimistic concurrency`, `single writer`, `port`, `adapter`, `atomic write`, tên tool MCP, tên package.
- Bảng thay cho đoạn văn dài khi nội dung là danh sách đối chiếu.
- Code block có ghi ngôn ngữ.
- Một câu một ý. Không viết câu ba mệnh đề lồng nhau.
- MUST NOT viết mở bài kiểu "Trong tài liệu này chúng ta sẽ…". Vào thẳng.

## 7. Trung thực

Đây là rule quan trọng nhất của toàn bộ mục này.

- MUST NOT mô tả thứ chưa tồn tại bằng thì hiện tại.
- MUST đánh dấu rõ: `THẬT` / `MOCK` / `NÚT CHẾT` / `CHƯA CÓ` / `ĐỀ XUẤT`.
- MUST NOT dùng transcript, log giả, hay UI làm bằng chứng rằng một thao tác đã chạy. Bản mock in ra `mcp hyperframes.tts → narration/scene-1.wav` trong khi không có wav nào được tạo — tài liệu MUST nói thẳng điều đó.
- Rủi ro chưa xác minh MUST ghi là **chưa xác minh**, kèm cách xác minh.
- Số liệu và claim kỹ thuật MUST kiểm chứng được — dẫn file, dẫn `node_modules`, dẫn output lệnh.

## 8. Diagram

- ASCII art trong code block, MUST NOT dùng ảnh (không diff được).
- Mũi tên phải đúng chiều gọi. Diagram mâu thuẫn với phần chữ là bug tài liệu.
- Giữ diagram nhỏ. Một diagram một ý.

## 9. Cấu trúc file tài liệu

- Một chủ đề một file. File > ~400 dòng → cân nhắc tách.
- Bắt đầu bằng `# <số> — <tiêu đề>`.
- Có mục lục ở file index, không lặp mục lục trong từng file.
- Section đánh số để trích dẫn chéo được (`§4.2`).
- Cross-reference dùng số section, MUST cập nhật khi đánh số lại.

## 10. Comment trong code vs tài liệu

| Thuộc về | Nội dung |
|---|---|
| Doc comment trên hàm | Hàm trả về gì, `null` nghĩa là gì, side effect, tiền điều kiện, giá phải trả |
| Comment trong thân hàm | Vì sao dòng này viết thế này; cái gì đã thử và hỏng |
| Tài liệu | Hệ thống làm được gì; luật chung; quyết định kiến trúc |

MUST NOT chép comment code vào tài liệu, và ngược lại. Chúng mục với tốc độ khác nhau.

Xem [11-code-style](11-code-style.md) §4 (doc comment bắt buộc cho hàm) và §5 (comment trong thân hàm).
