# Execution Goal — spec-editing-experience

**Goal**: chạy hết [checklist](./spec-editing-experience-implementation-checklist.md) theo thứ tự
`S0 → P0 → P3 → P4 → P1 → P2 → P5 → P6 → P7 → P8 → P9 → P10 → P11`. Xong = mọi task + AC `[x]`, mỗi phase
có `PASS` trong Execution Log, coverage kín R1–R12, spec `inprocess` → `complete`.

**Thẩm quyền**: Goals bản 7 → Design bản 12 → steering → code hiện tại → diff nhỏ nhất. Theo nguyên văn
"Mười luật bất biến" + "Autonomous Execution Contract" của checklist (L1 ghi qua
`WriteAuthority.mutateSource`, L4 nội dung quyết ở Core, L5 test `environment: "node"`).

**Mỗi phiên**: đọc `git status --short` + Execution Log + cuối `implementation-notes.html`. Có `[/]` ⇒
resume trước; không thì task `[ ]` đầu tiên đủ prerequisite (`[!]`/`NOT EXECUTED`/Deliverables trống = chưa
đóng). Đọc skill + "Read first" của phase trước khi sửa; task `<n>.0` sửa steering làm trước code.

**Mỗi task**: Analyze → `[/]` + checkpoint (task, HEAD, command) → test fail → implement → focused test →
phase gate → cập nhật checklist + notes → `[x]`. Không rewrite code đã đạt AC, không fake PASS.

**CI là runner chính, không chỉ để đa OS**: `GH_TOKEN` từ `GH_KEY` trong `.env` (không in token ra
log/notes), `gh workflow run "<name>" --ref <branch>` + `gh run watch` + `gh run download` lấy artifact; ghi
URL + conclusion từng OS vào Execution Log. Thiếu Chrome/FFmpeg/artifact ở máy ⇒ đẩy lên Actions lấy
evidence thật; `[!]` chỉ khi CI cũng không chạy được. Đỏ ⇒ sửa trước task kế. Workflow: `CI` dispatch =
typecheck·lint·boundaries·test (FFmpeg bắt buộc)·mcp-contract·golden·schema-drift·spec-paths·build·
runtime-smoke, 3 OS · `Browser session` = kéo-thả/preview/R4.1c <500 ms (Linux+Win) · `Packaged smoke` =
P8 catalog trong artifact, 11.5d (3 tag) · `Process supervision gate` = render/kill P4+P7 · `VieNeu real
engine` = TTS thật cho caption P6.

**FE**: trước khi code UI, Read [`reference-editor/README.md`](./reference-editor/README.md) + ảnh của
phase: `02-timeline.jpg` (P1/P2/P7/P9) · `01-overview.jpg` (P4) · `rail-media|fonts|images|videos.jpg` (P5)
· `rail-templates.jpg` (P8) · `rail-edit.jpg`+`03-edit-panel.jpg` (P10). Lấy affordance/bố cục/empty state,
không copy pixel; xung đột ⇒ Goals/Design thắng. Kéo chuột **thêm** chứ không thay input số; logic ra khỏi
component để test node được; UI không tự tính timing/cue/tên file.

**Dừng hỏi khi**: đổi AC, mở scope, hạ security, hoặc hành động ngoài repo.
