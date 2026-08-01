# vidcom-v2 — Tài liệu chức năng (Feature Inventory)

Mục đích: liệt kê **toàn bộ chức năng** của app hiện tại + **logic chi tiết** đang chạy, để làm cơ sở viết lại backend.

Thời điểm chụp: `2026-08-01`, branch `main`, commit gần nhất `af24493` (working tree có nhiều thay đổi chưa commit).

> ⚠️ **Lưu ý về tính thời sự.** Trong lúc tài liệu này được viết, một refactor đang diễn ra ở tầng transport của studio: đồng hồ phát được tách khỏi React state sang một external store (`src/components/studio/player-time.tsx`). Các mục liên quan đã được cập nhật theo kiến trúc mới, nhưng một số file (`timeline-track.tsx`, `timeline-ruler.tsx`, `timeline-toolbar.tsx`) có thể còn đang được sửa. Chi tiết: [04-feature-preview-player.md](04-feature-preview-player.md) §F-4.4. **Mọi phần mô tả backend/API/parsing không bị ảnh hưởng bởi refactor này** — nó thuần tuý là tối ưu render phía client.

## Đọc theo thứ tự nào

| File | Nội dung |
|---|---|
| [00-overview.md](00-overview.md) | Kiến trúc, tech stack, luồng dữ liệu, sơ đồ tổng, quy ước chung |
| [01-domain-model.md](01-domain-model.md) | Toàn bộ kiểu dữ liệu, layout file trên đĩa, hợp đồng `data-*` của HyperFrames |
| [02-feature-project-library.md](02-feature-project-library.md) | Trang danh sách project (Home) |
| [03-feature-code-editor.md](03-feature-code-editor.md) | Tab Code: file explorer, tabs, CodeMirror, save + chống ghi đè |
| [04-feature-preview-player.md](04-feature-preview-player.md) | Preview iframe, runtime injection, transport (play/seek/rate/mute) |
| [05-feature-timeline.md](05-feature-timeline.md) | Timeline: lane, ruler, zoom, root track, element/effect rows, cảnh báo |
| [06-feature-storyboard-scene.md](06-feature-storyboard-scene.md) | Storyboard + Scene detail: timing, media, transition, script |
| [07-feature-narration-tts.md](07-feature-narration-tts.md) | Narration / TTS sidecar |
| [08-feature-preview-settings.md](08-feature-preview-settings.md) | Preview editor: tone/lighting, palette, BGM, subtitles, sound per-scene |
| [09-feature-ai-composer.md](09-feature-ai-composer.md) | AI Composer: transcript mock + generate scene thật |
| [10-api-contract.md](10-api-contract.md) | Đặc tả HTTP API hiện tại (request/response/status/lỗi) |
| [11-parsing-logic.md](11-parsing-logic.md) | Toàn bộ logic parse composition — phần khó nhất khi viết lại |
| [12-mock-vs-real.md](12-mock-vs-real.md) | Cái gì thật, cái gì mock, cái gì là nút chết |
| [13-backend-requirements.md](13-backend-requirements.md) | Yêu cầu chức năng mong muốn cho backend mới |
| [14-local-first-mcp-packaging-architecture.md](14-local-first-mcp-packaging-architecture.md) | **Hướng đi tiếp theo:** export MCP cho AI điều khiển · đóng gói một file thực thi · web UI + workspace do người dùng chọn |
| [15-build-order.md](15-build-order.md) | **Thứ tự xây dựng — backlog chuẩn.** Mọi lộ trình khác trỏ về đây |

## Quan hệ với `steering/`

| Thư mục | Trả lời |
|---|---|
| `product-features/` (đây) | Hệ thống **đang là gì**, **sẽ thành gì**, và **làm theo thứ tự nào** |
| [`steering/`](../steering/00-index.md) | **Phải viết code thế nào** — luật thường trực, đọc trước mọi task |

Tài liệu 00–12 mô tả **hiện trạng** (bản mock). Tài liệu 13–15 mô tả **đích đến**. Luật hiện thực nằm ở `steering/`.

## Quy ước trong tài liệu

Mỗi chức năng được ghi theo 4 mục:

- **Là gì** — chức năng người dùng thấy.
- **Logic hiện tại** — code đang làm chính xác điều gì (kèm file:line).
- **Trạng thái** — `THẬT` (ghi/đọc đĩa thật) · `MOCK` (giả lập) · `NÚT CHẾT` (UI có, không có handler).
- **Kỳ vọng backend** — backend mới cần cung cấp gì để chức năng đó đầy đủ.

## Tóm tắt 1 câu

vidcom-v2 là **studio web để soạn video HTML** (framework HyperFrames): đọc project là thư mục trên đĩa, parse `index.html` ra scene/timeline, cho sửa code + sửa timing + sửa text + đặt tone/màu/nhạc, preview bằng player thật, và có một tab AI Composer mô phỏng agent tạo scene.
