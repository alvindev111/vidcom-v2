# 03 — Tab Code: File explorer + Editor

File liên quan: [code-pane.tsx](../../src/components/studio/code-pane.tsx), [file-explorer.tsx](../../src/components/studio/file-explorer.tsx), [file-tree-item.tsx](../../src/components/studio/file-tree-item.tsx), [file-icon.tsx](../../src/components/studio/file-icon.tsx), [editor-panel.tsx](../../src/components/studio/editor-panel.tsx), [editor-tab-bar.tsx](../../src/components/studio/editor-tab-bar.tsx), [editor-footer.tsx](../../src/components/studio/editor-footer.tsx), [code-editor.tsx](../../src/components/studio/code-editor.tsx), [use-source-files.ts](../../src/components/studio/use-source-files.ts), [projects.server.ts](../../src/lib/hyperframes/projects.server.ts)

Layout: split ngang 26% (explorer) / 74% (editor).

---

## F-3.1 — Cây file project

**Là gì:** Sidebar liệt kê toàn bộ file/thư mục của project, folder mở/đóng được, file có icon theo đuôi, file đang sửa dở có dot màu accent.

**Logic hiện tại:**
- `readProjectTree(slug)` đệ quy `readdirSync`, **bỏ** `node_modules`, `.git`, `.hyperframes` (`IGNORED_ENTRIES`).
- Sort: folder trước file, rồi `localeCompare` theo tên.
- `path` chuẩn hoá `\` → `/`, dùng làm React key và id chọn.
- Cây được render **toàn bộ ở server**, gửi kèm page — không lazy load.
- State mở/đóng folder: `useState<string[]>` ở client, **mặc định đóng hết** (kể cả folder chứa file đang mở).
- Folder rỗng render chữ `empty` in nghiêng.
- Icon theo đuôi ([file-icon.tsx](../../src/components/studio/file-icon.tsx)): `html` cam, `py` xanh sky, `json` amber, `wav` teal, `txt` xám, còn lại `FileTextIcon` xám.

**Trạng thái:** THẬT (chỉ đọc).

**Kỳ vọng backend:**
- Lazy load theo thư mục cho project lớn: `GET /projects/:slug/tree?path=&depth=`.
- Trả `size` + `mtime` để UI báo file lớn / vừa đổi.
- Watch (SSE/WebSocket) để cây tự cập nhật khi agent thêm file — hiện phải `router.refresh()`.

---

## F-3.2 — Nút New file / New folder

**Là gì:** 2 icon button ở header sidebar Files.

**Logic hiện tại:** Không có `onClick`. Chỉ có `aria-label`.

**Trạng thái:** NÚT CHẾT.

**Kỳ vọng backend:**
- `POST /projects/:slug/files` `{ path, kind: "file"|"folder", content? }`
- `DELETE /projects/:slug/files?path=`
- `PATCH` rename/move: `{ from, to }`
- Validate: nằm trong project, không ghi đè file có sẵn, đuôi nằm trong whitelist (hoặc mở rộng whitelist), chặn tên nguy hiểm.

---

## F-3.3 — Mở file (lazy fetch)

**Là gì:** Click file trong cây → mở tab editor.

**Logic hiện tại** ([use-source-files.ts](../../src/components/studio/use-source-files.ts)):
1. Chỉ `index.html` được ship sẵn cùng page (`files={entry ? [entry] : []}` ở [page.tsx:43](../../src/app/projects/[slug]/page.tsx#L43)).
2. File khác: `GET /api/hf/<slug>/source?path=<encoded>`.
3. Nếu file **đã mở**: giữ nguyên draft (kể cả edit chưa lưu), chỉ activate tab.
4. Fetch lỗi → set `openError`, và **rút path khỏi order** (không để tab rỗng treo lại).
5. Trong lúc fetch: `loading = path`, editor hiện `opening <path>…`.

Server (`readSourceFile`):
- `editablePath()` kiểm tra: nằm trong project (`resolveWithinProject`), tồn tại, là file, và **đuôi nằm trong whitelist** `html css js mjs ts json md txt py svg`.
- Ngoài whitelist → `404 { error: "file is not editable" }`. Nghĩa là `.png`, `.wav`, `.jpg` **không mở được** trong editor (đúng ý, nhưng UI không phân biệt "không được sửa" với "không tồn tại").

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- Phân biệt lỗi rõ ràng: `404 not_found` vs `415 unsupported_type` vs `413 too_large`.
- Preview cho file binary (ảnh/audio) thay vì báo lỗi.
- Trả `mimeType`, `encoding`, `lineEnding` để editor xử lý đúng CRLF.

---

## F-3.4 — Tab bar

**Là gì:** Dải tab ngang, mỗi tab có icon + tên file, nút × để đóng. Tab dirty hiện **dot thay cho ×** đến khi hover.

**Logic hiện tại:**
- Thứ tự tab = `order: string[]`, append khi mở mới.
- Đóng tab: xoá khỏi `order` **và xoá luôn draft** — comment ghi rõ "reopening reads the file fresh", tức **edit chưa lưu bị mất không cảnh báo**.
- Đóng tab đang active → activate tab cuối cùng còn lại.
- `dirtyPaths` = tab nào có `draft !== file.code`.

**Trạng thái:** THẬT.

**Kỳ vọng backend:** không cần. Nhưng **UX cần sửa**: hỏi xác nhận trước khi đóng tab dirty; hoặc backend lưu draft (autosave nháp) để không mất.

---

## F-3.5 — CodeMirror editor

**Là gì:** Editor code có syntax highlight, số dòng, fold, theme theo light/dark, `⌘S`/`Ctrl+S` để lưu.

**Logic hiện tại** ([code-editor.tsx](../../src/components/studio/code-editor.tsx)):
- Mount **imperative** (không JSX-controlled): `new EditorView({parent, state})`. Lý do trong comment: value do React kiểm soát sẽ giành con trỏ với editor mỗi keystroke.
- `key={active.file.path}` ở EditorPanel → **đổi tab = build editor mới** (đổi language support + document mới).
- Language theo đuôi: `html`→html, `css`→css, `js|mjs|ts`→javascript (`typescript: path.endsWith(".ts")`), `json`→json, còn lại **plain text**.
- Theme: `Compartment` reconfigure sang `oneDark` khi `resolvedTheme === "dark"`, ngược lại `[]`.
- Callback `onChange`/`onSave` giữ trong ref và cập nhật mỗi render → editor không cần rebuild để nhận callback mới.
- Khi `initialCode` đổi (file bị ghi lại trên đĩa, hoặc save trả về): **dispatch thay toàn bộ document** thay vì rebuild editor → giữ scroll position.
- `basicSetup` từ package `codemirror` (bao gồm line numbers, fold gutter, history/undo, search, autocomplete cơ bản, bracket matching).

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- Nếu muốn multi-user: cần CRDT/OT + presence (Yjs) → backend phải có WebSocket doc server.
- Nếu muốn LSP (autocomplete HTML/CSS thông minh, lint inline): backend host language server.
- Format on save (prettier) — endpoint `POST /format`.

---

## F-3.6 — Lưu file + chống ghi đè (optimistic concurrency)

**Là gì:** Footer hiện đường dẫn + trạng thái `Saved` / `Unsaved changes` / `Saving…`. Khi dirty mới hiện hàng nút `Revert` + `Save ⌘S`.

**Logic hiện tại:**
1. Client `PUT /api/hf/<slug>/source` body `{ path, code, baseVersion }` — `baseVersion` là `version` của lần đọc.
2. Server `writeSourceFile()`:
   - `editablePath()` lại → không hợp lệ: `404 "file is not editable"`.
   - Nếu `baseVersion` được gửi **và** khác `fileVersion(target)` hiện tại → **`409`** với message: `"file changed on disk since you opened it — reload before saving"`.
   - Ngược lại `writeFileSync` rồi đọc lại và trả `SourceFile` mới.
   - Ghi được nhưng đọc lại thất bại → `500`.
3. `version = "<mtimeMs base36>-<size base36>"` — đủ để phát hiện "có ai đó ghi vào file này".
4. Guard kích thước ở route: `code.length > 2MB` → `413`.
5. Save thành công: draft = code mới → tab clean. Rồi gọi `onProjectChanged()` → bump revision + `router.refresh()` → **preview rebuild và toàn bộ scene được parse lại**.
6. `Revert`: chỉ set `draft = file.code` (local, không gọi server).
7. Save khi `draft === file.code` → **return sớm, không gọi API**.

Lý do thiết kế (comment [use-source-files.ts:17](../../src/components/studio/use-source-files.ts#L17)): "the agent is the main author of these files, so a manual edit should land only when the user asks for it" → **không autosave** cho code, khác với script line và preview settings (có autosave).

**Trạng thái:** THẬT.

**Kỳ vọng backend:**
- Giữ nguyên optimistic concurrency, nhưng dùng **hash nội dung (sha256)** thay vì mtime+size — mtime không đáng tin trên một số filesystem/container, và mtime+size trùng nhau vẫn có thể là nội dung khác.
- Khi 409, trả kèm **nội dung server hiện tại** để UI diff/merge chứ không chỉ bắt reload.
- Ghi atomic: write temp file rồi `rename` — hiện `writeFileSync` trực tiếp, crash giữa lúc ghi làm hỏng composition.
- Ghi lịch sử phiên bản (mỗi save = 1 revision) để có undo cấp file và rollback.
- Validate HTML trước khi ghi (chạy `hyperframes check`/lint) và **cảnh báo** — hiện có thể lưu HTML hỏng làm cả studio 404.
- Event bus để các tab/khách khác biết file vừa đổi.

---

## F-3.7 — Reload sau khi file bị sửa ngoài app

**Là gì:** Nếu agent hoặc CLI sửa file khi tab đang mở, editor phải cập nhật.

**Logic hiện tại:** **chỉ khi có `router.refresh()`** (tức sau một hành động ghi trong app). Không có file watcher. `useEffect` theo `initialCode` sẽ thay document — nhưng `initialCode` chỉ đổi cho `index.html` (file duy nhất đến từ RSC props); các file fetch qua API **không bao giờ tự refresh**.

**Trạng thái:** KHUYẾT.

**Kỳ vọng backend:** file watcher + push (SSE/WS) `{ type: "file-changed", path, version }` để client refetch hoặc cảnh báo xung đột ngay lúc đó.
