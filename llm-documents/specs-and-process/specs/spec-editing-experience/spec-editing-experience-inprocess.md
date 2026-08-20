# Spec Editing Experience (Giai đoạn 5) — IN PROCESS (DEEP-REVIEW REMEDIATION)

> **Related Documents**:
> - [Detailed Goals](./spec-editing-experience-detailed-goal.md)
> - [Detailed Design](./spec-editing-experience-detailed-design.md)
> - [Implementation Checklist](./spec-editing-experience-implementation-checklist.md)
> - [Execution Goal — prompt khởi động cho LLM agent](./spec-editing-experience-execution-goal.md)
> - [Deep post-implementation review 2026-08-20](./spec-editing-experience-deep-review-2026-08-20.md)
> - [Tham chiếu UX — ảnh chụp editor motionvid.ai](./reference-editor/README.md)
>
> **Backlog nguồn**: [15-build-order §Giai đoạn 5](../../../product-features/15-build-order.md) — mục 5.1–5.9.
> 5.0 (nút `New video`) **đã trả ở Giai đoạn 4 / R1.19**, không thuộc spec này.

## Spec Goal

Biến studio từ "xem được, sửa bằng form" thành "sửa trực tiếp được": kéo timing và thứ tự
trên timeline, undo/redo, preview không giật khi ghi, quản lý file/asset trong app, caption
đồng bộ theo từng từ, và thư viện template/registry để bắt đầu nhanh — mọi thao tác đi qua
đúng đường ghi đã có (`WriteAuthority` kèm `expectedContentHash`/`expectedRevision`), không mở đường ghi thứ hai.

## Spec Stories

- **Timeline trực tiếp**:
    - Là người dựng video, tôi muốn kéo bar và kéo mép clip trên timeline để đổi start/duration, để không phải nhập số trong form cho mỗi lần chỉnh nhỏ.
    - Là người dựng video, tôi muốn kéo-thả đổi thứ tự scene, để sắp lại mạch video mà không tự tính lại thời điểm từng scene.
    - Là người dựng video, tôi muốn bật/tắt snap và thấy timeline zoom được, để chỉnh chính xác ở cả mức giây lẫn mức khung hình.
- **An toàn khi sửa**:
    - Là người dựng video, tôi muốn undo/redo ở cấp composition, để thử một hướng dựng rồi quay lại mà không sợ mất bản cũ.
    - Là người dựng video, tôi muốn preview không tua về đầu mỗi lần ghi, để giữ được mạch khi tinh chỉnh liên tục.
    - Là người dựng video, tôi muốn được cảnh báo khi đóng tab lúc còn thay đổi chưa ghi, để không mất việc đang làm.
- **Tài sản trong project**:
    - Là người dựng video, tôi muốn tạo/đổi tên/xoá file & thư mục và upload ảnh/video/audio/**font** ngay trong app, để không phải chuyển qua trình quản lý file của hệ điều hành.
    - Là người dựng video, tôi muốn thấy metadata thật của asset (kích thước, thời lượng, codec), để biết clip có khớp canvas và độ dài scene không.
- **Timeline đọc được và thao tác hàng loạt**:
    - Là người dựng video, tôi muốn clip hiện dải khung hình thật, để nhận ra scene bằng mắt mà không phải phát thử.
    - Là người dựng video, tôi muốn kéo asset từ panel Media thả vào timeline, để đưa tài sản vào video mà không phải tự viết thẻ trong file.
    - Là người dựng video, tôi muốn chọn nhiều clip rồi thao tác một lần, để không lặp lại cùng một chỉnh sửa cho từng scene.
- **Nội dung & khởi đầu nhanh**:
    - Là người dựng video, tôi muốn **sinh caption từ narration** và thấy nó sáng theo từng từ khớp giọng đọc, để phần chữ tự có và chạy đúng nhịp thay vì phải tự gõ rồi tự canh.
    - Là người dựng video, tôi muốn chèn scene từ thư viện template, để dựng nhanh những dạng scene lặp lại.
    - Là người dựng video, tôi muốn duyệt catalog registry, **cài block và mount nó vào composition**, để thành phần dựng sẵn xuất hiện ngay trong video chứ không chỉ nằm trong thư mục project.

## Spec Planning

- **Date**: 2026-08-15 - [TBD] — **9–11 tuần** là kỳ vọng làm việc ở ~212 SP, không phải 3–4 tuần của build-order: người dùng đã chọn làm hết 12 requirement thay vì cắt phạm vi (OQ-8), và cả GĐ 3 lẫn GĐ 4 đều nở gấp đôi.
- **Capacity**: **~212 Story Points** (bản 5 sau sáu vòng review 2026-08-15; bản 1 là ~128 và đã bị đo là thấp — R2/R3/R5/R6/R9 đều cần capability backend chưa tồn tại). Coi là **sàn**; chốt lại sau Design.
- **Testing**: logic thuần chạy dưới `environment: "node"` (repo không có jsdom/happy-dom — reducer/planner phải tách khỏi render như G.7/G.8 đã làm); thao tác ghi verify qua filesystem thật trong thư mục tạm + SQLite app-data thật, không mock `node:fs`; luồng chuột/kéo-thả và luồng preview verify bằng harness Chrome thật đã có (`test:browser-session`, `tests/support/browser-harness.ts`).
- **Risks**:
  - **Ghi liên tục khi kéo**: mỗi pixel kéo mà ghi file là một lần parse + serialize + revision bump. Không có mô hình commit rõ ràng thì timeline vừa chậm vừa đẻ ra rác trong journal/audit.
  - **Undo trên nguồn file, không phải trên state**: nguồn chân lý là HTML/CSS trên đĩa, và agent MCP ghi cùng lúc. Undo dựa vào stack trong RAM sẽ ghi đè thay đổi của agent.
  - ~~**Registry cần mạng, artifact thì không**~~ — **đã đóng 2026-08-15**: catalog bundled trong artifact + cache khi có mạng (OQ-4), nên màn hình registry/template dùng được offline.
  - **Kéo-thả thiếu bàn phím**: form timing hiện tại là đường duy nhất chỉnh chính xác; nếu bỏ nó để lấy chuột thì mất luôn khả năng nhập số.
  - **Ước lượng nở**: GĐ 3 (7–8 tuần) và GĐ 4 (7–8 tuần) đều nở gấp đôi so với con số đầu. 3–4 tuần cho 12 hạng mục là con số của backlog, không phải của Design.
- **Commitments**:
  - Không thêm đường ghi thứ hai: mọi mutation đi qua use case Core + `WriteAuthority` kèm `expectedContentHash` (file) hoặc `expectedRevision` (entity), đúng luật concurrency ở [06-validation §7](../../../steering/06-validation.md).
  - Code lấy từ registry chỉ được ghi vào project sau khi kiểm version + checksum; block chạy trong preview và render nên nguồn phải là registry đã cấu hình sẵn.
  - Mọi hành vi mới đều có test chạy được không cần trình duyệt, trừ đúng phần chỉ browser cưỡng chế được.
  - Không kéo AI Composer trong app (GĐ 6) vào spec này.

## Quyết định phạm vi đã chốt (2026-08-15)

| # | Quyết định |
|---|---|
| OQ-2 | Undo/redo phạm vi **phiên làm việc**, tối đa **50 bước**; không thêm bảng SQLite |
| OQ-4 | Registry + template: **catalog bundled trong artifact + cache khi có mạng**, dùng được offline |
| OQ-5 | Template (R7) và block (R9) **chung một catalog**, lọc theo tag |
| OQ-6 | Upload: ảnh 25 MB · video 500 MB · audio 100 MB · font 5 MB; SVG nhận kèm sanitize bắt buộc |
| OQ-8 | **Không cắt phạm vi** — làm hết **12** requirement, chấp nhận **9–11 tuần** |
| OQ-9 | Snap **8 px** trên màn hình, kẹp trong [1 khung, 0.5 s]; làm tròn timing về **khung hình gần nhất** |
| OQ-10 | Caption cue: cắt khi > **84 ký tự** hoặc > **7 giây**, sàn thời lượng **1.2 giây**, ngắt ở khoảng im lặng ≥ **0.6 giây** |
| R4 (bản 7) | Bất biến là **`PlayerHost`** của vidcom, không phải `<hyperframes-player>`; **double-buffer cho mọi cập nhật preview, kể cả preview settings**; PR-11 hot-reload từng composition chuyển sang GĐ 6 |
| R9.9 (bản 5) | Cài + mount block là **một** mutation; undo xoá file mutation **tạo mới**, khôi phục pre-image của file mutation **thay thế**, và không đụng file không bị mutation sửa |
| Phạm vi bản 5 | Thêm **R10** dải thumbnail, **R11** kéo asset vào timeline, **R12** chọn nhiều clip |
| Undo | Đơn vị undo là **một mutation `WriteAuthority` trọn vẹn** — undo chèn template gỡ cả scene HTML và narration sidecar, vì `createScene` ghi ba file trong một mutation |

## Phase Approvals
- **Detailed Goals**: **Approved (bản 7)** — bản 6 sửa R4.1/1a/1b sang `PlayerHost` + double-buffer; bản 7 đồng bộ R4.5 để preview settings không còn đường hot-reload riêng; PR-11 chuyển sang GĐ 6
- **Detailed Design**: **Approved (bản 12), 2026-08-16** — ngoài receipt id/error/streaming/registry
  của lượt đầu, audit authoring-readiness đã khóa reservation + lifecycle history, undo entity/pending
  mount, typed read-guard barrier + synchronous block, preview latest-wins theo project-scoped changeSeq,
  scheduler thumbnail hữu hạn, SVG/font/caption escaping,
  catalog exact-intent/repeat mount/category-provenance, scene insertion planner dùng chung, và
  external watcher barrier theo ownership/dependency có hướng mà không tự block bởi own-write echo;
  CRUD cây dùng tree digest/mkdir precondition và draft refetch khóa save tới generation mới nhất.
  Audit checklist cuối ghi tường minh steering variance cho raw upload/thumbnail request/session undo,
  sửa path thật của `applyCompositionOps`, và defer MCP blob/file-manager parity R5 thành D9 thay vì
  mở tool nhận absolute path
- **Implementation Checklist**: **Approved 2026-08-16** — đồng bộ từ Goals bản 7 + toàn bộ
  contract/failure-cleanup gate của Design bản 12; S0 bắt đầu thực thi sau khi gate được duyệt

## During Spec
- **Standups**: 2026-08-16 — S0 chạy: spec chuyển `pending` → `inprocess`, `implementation-notes.html` tạo, baseline ghi vào Execution Log của checklist. 2026-08-20 — audit hậu triển khai mở lại spec: C-01, H-01–H-04, M-01–M-07, L-01 và G-01–G-03 trở thành remediation gate bắt buộc trước merge/release.
- **Impediments**: Không có blocker môi trường tại thời điểm mở gate. CI là runner evidence chính; local thiếu Chrome/FFmpeg/artifact không được dùng để hạ gate.
- **Adjustments**:
  - Giữ nguyên toàn bộ checkbox/evidence lịch sử của S0–P11; không sửa quá khứ thành “chưa chạy”.
  - Bổ sung R13–R15, Design bản 13 và P12–P18 để xử lý độc lập các finding mới.
  - Trạng thái `COMPLETE` ngày 2026-08-19 là mốc hoàn tất phạm vi checklist cũ, không còn là release verdict sau audit 2026-08-20.

## Spec Review
- **Completed**: Phạm vi R1–R12/checklist S0–P11 đã hoàn tất theo evidence lịch sử; remediation R13–R15/P12–P18 đang mở.
- **Demo**: Chưa được phép gọi release-ready cho tới khi deep-review closure matrix và CI exact-source đều xanh.
- **Feedback**: NO-GO theo deep review 2026-08-20; mọi Critical/High phải đóng trước merge, toàn bộ Medium/Low/governance phải đóng trước release.

## Spec Retrospective
- **Well**: —
- **Not Well**: —
- **Improvements**: —

## Next Spec Adjustments
- **Changes**: —
- **Carry-over**: —
- **Lessons**: —
