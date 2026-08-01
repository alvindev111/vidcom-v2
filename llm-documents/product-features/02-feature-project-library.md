# 02 — Project Library (Home `/`)

File liên quan: [src/app/page.tsx](../../src/app/page.tsx), [src/components/home/](../../src/components/home/), [src/lib/studio/poster.ts](../../src/lib/studio/poster.ts)

---

## F-2.1 — Liệt kê project

**Là gì:** Trang chủ hiển thị lưới card, mỗi card = một project video. Header ghi `<N> compositions · click one to open the composer`.

**Logic hiện tại:**
1. `listProjectSlugs()` — `readdirSync(projects/)`, lọc directory, lọc tiếp bằng `projectDir(name) !== null` (tức phải có `hyperframes.json`), `sort()` theo alphabet.
2. Với mỗi slug, `readProject(slug)`:
   - Bắt buộc có `index.html`, không thì bỏ project khỏi danh sách.
   - Parse `index.html` → `readComposition()` lấy `width`/`height`/`duration` từ attribute root host.
   - `title` = `registry-item.json.title` || `meta.json.name` || slug.
   - `description` = `registry-item.json.description` || undefined.
   - `width` = attr `data-width` ?? `registry-item.dimensions.width` ?? **1920**.
   - `height` tương tự, fallback **1080**.
   - `duration` = `rootTiming.duration ?? rootTiming.end` — **có thể null** (không fallback).
3. Page là `force-dynamic` — đọc đĩa mỗi request.
4. Nếu 0 project: hiện hướng dẫn `bunx hyperframes init projects/<name> --example blank`.

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- `GET /projects` phân trang + sort (tên / ngày sửa / thời lượng).
- Trả thêm: `updatedAt` (mtime), `sceneCount`, `hasSnapshots`, `renderStatus`.
- Cache có invalidation theo mtime thay vì đọc lại toàn bộ mỗi request (hiện parse HTML của **mọi** project mỗi lần vào Home).

---

## F-2.2 — Card project

**Là gì:** Mỗi card có: thumbnail, tiêu đề, dòng meta `10s · 1920×1080`, nút `Open`. Cả thumbnail và tiêu đề đều là link tới `/projects/<slug>`.

**Logic hiện tại:**
- `formatDuration(seconds)` ([poster.ts:40](../../src/lib/studio/poster.ts#L40)): số nguyên → `10s`, lẻ → `5.5s` (1 chữ số thập phân). `null` → không hiện phần duration.
- Hover đổi border sang `--studio-accent`.

**Trạng thái:** THẬT.

---

## F-2.3 — Thumbnail placeholder

**Là gì:** Ô 16:9 hiển thị **tên project trên một background style cố định**, không phải frame thật của video.

**Logic hiện tại:** `posterFor(index)` = `POSTERS[index % 5]`. 5 style hard-code: cream/serif, black/mono-uppercase, off-white/medium, gradient navy, neutral-900/mono. Style gắn theo **vị trí trong lưới**, nên thêm/xoá project sẽ đổi màu card khác.

**Trạng thái:** MOCK. Comment trong code: "Real poster frames come from `hyperframes snapshot`; until a project has one, its card gets a stable style derived from its position".

**Kỳ vọng backend:**
- Trả `posterUrl` thật: ưu tiên `snapshots/contact-sheet.jpg` hoặc frame giữa video (`snapshots/frame-*.png`).
- Nếu chưa có snapshot: backend tự sinh (headless chromium seek 1 frame) và cache.
- Hỗ trợ animated preview (GIF/WebM ngắn) khi hover — tuỳ chọn.

---

## F-2.4 — Nút "New video"

**Là gì:** Card đầu lưới, viền nét đứt, icon `+`, chữ "New video" / "Generate with an AI agent".

**Logic hiện tại:** `<button disabled>`. Comment: "Creating a project means running `hyperframes init` on the server, which is not wired yet".

**Trạng thái:** NÚT CHẾT.

**Kỳ vọng backend:**
- `POST /projects` với body `{ name, example?, width?, height?, brief? }`.
- Chạy `hyperframes init projects/<name> --example <example>` (hoặc scaffold nội bộ tương đương).
- Validate slug: unique, `[a-z0-9-]+`, không trùng thư mục có sẵn.
- Trả về slug để redirect thẳng vào studio.
- Biến thể "Generate with an AI agent": nhận brief text → chạy workflow agent tạo project. Cần job queue + streaming progress (xem [09](09-feature-ai-composer.md) và [13](13-backend-requirements.md) §5).

---

## F-2.5 — Theme toggle

**Là gì:** Nút chuyển light/dark/system, có mặt cả ở Home và Studio.

**Logic hiện tại:** `next-themes`, `attribute="class"`, `defaultTheme="dark"`, `enableSystem`, `disableTransitionOnChange`. Lưu ở localStorage phía client.

**Trạng thái:** THẬT (client-side).

**Kỳ vọng backend:** không cần, trừ khi muốn lưu preference theo user account.

---

## Chức năng CHƯA CÓ ở Home

| Chức năng | Ghi chú |
|---|---|
| Tìm kiếm / filter project | Không có |
| Xoá project | Không có |
| Đổi tên / duplicate project | Không có |
| Import project (zip / git) | Không có |
| Xuất / download project | Không có |
| Trạng thái render (queued/rendering/done) | Không có |
| Hiển thị lỗi project (HTML không parse được) | Project lỗi bị **im lặng loại khỏi danh sách** — không có báo lỗi |
