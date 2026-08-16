# Editor reference — motionvid.ai (chụp 2026-08-15)

Nguồn: https://motionvid.ai/motion-graphics/eoZFiUOYeluupHCW1X5V (chưa login).
Chụp lại: `node capture.mjs` (puppeteer-core của repo + Chrome hệ thống); ảnh gốc 1600×1000 PNG,
bản lưu ở đây đã hạ xuống 1280 JPEG cho nhẹ repo.

**Đây là tham chiếu hành vi, không phải mục tiêu sao chép giao diện.** Sản phẩm khác mô hình:
vidcom local-first, nguồn chân lý là file HTML trong project, generation qua agent MCP.

## Bố cục tổng thể (`01-overview.jpg`)

- Rail trái dọc, icon + nhãn: AI Chat · Edit · Media · Videos · Fonts · Colors · Images · Projects · Templates.
- Panel trái rộng ~400px đổi nội dung theo rail. Có nút collapse (mũi tên) ở mép phải panel.
- Giữa: canvas preview, nền xám, khung video giữ tỉ lệ.
- Dưới canvas: thanh transport + timeline (không phải panel riêng, cùng cột với canvas).
- Header: back Home · badge tỉ lệ `16:9` · settings · Duplicate · Share/Export.

## Timeline (`02-timeline.jpg`)

Ba hàng từ trên xuống:
1. Toolbar mode: con trỏ chọn / kéo cắt (scissors).
2. Toolbar hành động: `Add track` · `Add text` · `Add audio` · `Add zoom` · toggle magnet (snap). Giữa là `0:00 ▶ 0:15`. Phải là zoom timeline (− slider + , `100%`).
3. Ruler mốc `0s / 5s / 10s / 15s` + playhead tam giác kéo được.
4. Track row: cột trái cố định (số track, mắt ẩn/hiện, loa mute, thùng rác xoá) + lane clip. Nút `+ Add track` nằm trên cột trái. Cuối lane có ô `+` thêm clip.
5. Clip hiển thị dải thumbnail nhiều frame, không phải một ảnh.

Chi tiết đáng lấy cho 5.1/5.2: track header có eye/mute/delete; snap là toggle rõ ràng; zoom timeline là slider có phần trăm; clip là dải frame.

## Panel Edit (`rail-edit.jpg`, `03-edit-panel.jpg`)

- Breadcrumb tab: `Project` | thumbnail scene. Chọn scene ở timeline mới edit được scene ("Pick a scene to edit it").
- Trường project: Title · Aspect ratio (9:16 / 16:9 / 1:1 / 4:5) · Dimensions w×h · Frame rate (input + preset 24/30/60).

## AI Chat (`01-overview.jpg`)

- Empty state "What should we change?" + chip gợi ý: Add a scene at the end · Change the color theme · Make the whole video shorter · Punch up the narration.
- Ô nhập dưới cùng: attach file, chọn Brand, nút gửi. Có dropdown chọn style ("Sketchbook").

## Media (`rail-media.jpg`)

Tab Media / Documents / References. Dropzone "Drop images or videos here or click to upload — drag any item onto the timeline · paste a screenshot". Empty state "No media yet.".

## Templates (`rail-templates.jpg`)

Chip lọc theo chủ đề (Maps, Charts, Dashboard, Diagrams, Stats, Countdown, Social Media, News, Lists, Typography, Titles, Explainers, Process, Timeline, Mockups, UGC, Ads, Product, Filmmaking, UI Design) + sort Newest/Popular + Favorites. Lưới thẻ 2 cột, mỗi thẻ có nút tim.

Ảnh còn lại: `rail-videos/fonts/colors/images.jpg`.
