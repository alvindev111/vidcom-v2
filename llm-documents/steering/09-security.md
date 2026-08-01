# 09 — Security baseline (local-first)

"Chạy local" không có nghĩa là an toàn. Một daemon HTTP trên máy người dùng vẫn bị tấn công từ trang web bất kỳ đang mở trong cùng browser.

## 1. Network binding

| Rule | Chi tiết |
|---|---|
| MUST | Bind `127.0.0.1` / loopback |
| MUST NOT | Bind `0.0.0.0`, kể cả sau cờ cấu hình |
| MUST | Port động; xử lý port conflict tường minh |
| MUST | In port ra `stderr`/log, không hardcode trong UI |

## 2. Xác thực

Không có auth thì **mọi trang web** người dùng đang mở có thể gọi `http://127.0.0.1:<port>` và đọc/ghi project của họ.

- MUST có token cho **mọi** endpoint, kể cả từ localhost.
- Luồng cấp token: `vidcom app` mở browser với one-time nonce trên URL → UI đổi nonce lấy session cookie `HttpOnly` `SameSite=Strict` → xoá nonce khỏi URL.
- Nonce MUST dùng một lần, hết hạn ngắn.
- Token IPC cho MCP bridge lưu tại `<app-data>/credentials`, quyền `0600` (Windows: ACL tương đương).
- MUST NOT ghi token vào workspace, log, hay URL còn lại trong history.

## 3. Chống DNS rebinding

MUST kiểm tra `Host` header, chỉ chấp nhận `127.0.0.1:<port>` / `localhost:<port>`. Đặt middleware này **trước** auth.

Không có bước này, một domain do kẻ tấn công kiểm soát có thể trỏ về `127.0.0.1` và bypass same-origin.

## 4. CORS

- Mặc định **từ chối** mọi cross-origin.
- Chỉ allowlist origin của chính UI.
- MUST NOT dùng `Access-Control-Allow-Origin: *`.
- MUST NOT phản chiếu `Origin` của request vào header response.

## 5. Đường dẫn

Đã nêu ở [06-validation](06-validation.md) §5, nhắc lại vì đây là bề mặt tấn công lớn nhất:

- Đúng **một** hàm `resolveInProject()` cho mọi đường vào.
- MUST resolve symlink rồi kiểm tra lại containment.
- MUST NOT nhận absolute path từ client hoặc AI.

Lỗ hiện có phải bịt: `openProjectFile` trong `sdk.server.ts` dùng `join(paths.dir, file)` không qua containment check, và `file` do client tự gửi.

## 6. Serve file

Bản mock để `/files/[...path]` đọc **mọi** file trong project.

- MUST allowlist theo loại file.
- MUST NOT serve `.env`, `package.json`, `AGENTS.md`, `CLAUDE.md`, dotfile, hay bất cứ thứ gì ngoài asset của composition.
- Traversal-safe **không đủ** — file nằm đúng trong project vẫn có thể là thứ không nên lộ.

## 7. Upload

- Kiểm tra **magic bytes**, không tin `content-type` hay đuôi file.
- Giới hạn kích thước theo loại.
- Sanitize tên file; MUST NOT ghi đè im lặng.
- Ghi vào temp, verify, rồi mới move vào workspace.

## 8. Process con

- MUST NOT dựng lệnh bằng chuỗi shell. Dùng argument array.
- MUST NOT nội suy input người dùng hay AI vào lệnh.
- MUST đặt timeout và kill cả cây process.
- MUST giới hạn số process đồng thời.
- MUST NOT truyền secret qua argv (hiện trong process list) — dùng env hoặc stdin.

## 9. Quyền của AI

- AI chỉ gọi được tool đã khai báo ([05-mcp-tool-design](05-mcp-tool-design.md)).
- Không shell, không SQL, không ghi file tuỳ ý, không absolute path.
- Tool **destructive** cần xác nhận + backup trước.
- Mọi tool call vào audit.
- Agent session chạy như job MUST chịu cùng giới hạn — không có "đường tắt nội bộ".

## 10. Log & audit

| Rule | |
|---|---|
| MUST | Audit mọi tool call và mọi file mutation |
| MUST | Redact prompt, nội dung file, token trước khi log |
| MUST | Audit ghi vào `<app-data>/audit.sqlite` |
| MUST NOT | Log vào workspace của người dùng |
| MUST NOT | Log token, credential, hay đường dẫn tuyệt đối chứa tên người dùng ở mức `info` |

## 11. Bí mật trong bundle

Từ doc 14 §2 — compile **không** phải security boundary.

MUST NOT nhúng vào executable:
- API key của dịch vụ trả phí;
- license signing key hoặc logic verify license offline;
- bất cứ giá trị nào mà lộ ra là mất doanh thu.

Những thứ đó nằm sau dịch vụ do VidCom kiểm soát. Nếu sản phẩm phải chạy offline hoàn toàn thì thiết kế MUST NOT có bí mật loại này ngay từ đầu.

## 12. Release artifact

- Code signing / notarization cho mọi nền tảng.
- Ghi checksum và provenance.
- Update qua kênh có xác thực chữ ký.

## 13. Checklist trước khi merge một endpoint mới

- [ ] Có validate schema input (body, query, param)?
- [ ] Có giới hạn kích thước body?
- [ ] Đường dẫn đi qua `resolveInProject()`?
- [ ] Ghi có kiểm `expectedContentHash` / `expectedRevision`?
- [ ] Lỗi trả `ErrorCode` machine-readable?
- [ ] Có audit nếu là thao tác ghi?
- [ ] Không rò absolute path / cấu hình nội bộ trong response?
- [ ] Nếu là tool MCP: đã phân mức và khai báo mức chưa?
