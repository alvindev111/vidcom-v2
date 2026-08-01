# Spec Core Backend Foundation

> **Status**: In process — mở lại để xử lý toàn bộ finding review và completion gate commit/push.

> **Related Documents**:
> - [Detailed Goals](./spec-core-backend-foundation-detailed-goal.md) — đã duyệt 2026-08-01
> - [Detailed Design](./spec-core-backend-foundation-detailed-design.md) — đã duyệt 2026-08-01
> - [Implementation Checklist](./spec-core-backend-foundation-implementation-checklist.md) — hoàn tất 118/118 ngày 2026-08-01
> - [Phase 0 evidence](../../../../spikes/phase-0/README.md)
> - [Canonical build order](../../../product-features/15-build-order.md#giai-đoạn-1--nền-móng-34-tuần)

## Spec Goal

Xây nền móng backend có thể kiểm thử và bảo vệ dữ liệu cho VidCom: mọi HTTP/MCP adapter dùng chung Application Core, mọi ghi project đi qua một write authority an toàn, UI không còn đọc filesystem từ RSC, và backend có auth, job, event cùng CI đủ để các giai đoạn sau phát triển mà không phải viết lại nền tảng.

## Spec Stories

- **Kiến trúc có ranh giới**:
  - Là một kỹ sư VidCom, tôi muốn Core độc lập với transport và hạ tầng để HTTP và MCP có thể dùng chung nghiệp vụ.
  - Là một maintainer, tôi muốn import boundary được CI cưỡng chế để kiến trúc không thoái hóa theo thời gian.
- **Dữ liệu project an toàn**:
  - Là người dùng, tôi muốn mọi lần lưu là atomic, có phát hiện xung đột và có revision/audit để project không bị hỏng hoặc bị ghi đè im lặng.
  - Là người dùng, tôi muốn VidCom chỉ truy cập file nằm thật sự trong project, kể cả khi có symlink hoặc input độc hại.
- **Local daemon an toàn và quan sát được**:
  - Là người dùng desktop, tôi muốn API local chỉ chấp nhận phiên do VidCom cấp, không bị website khác gọi qua DNS rebinding hoặc CORS.
  - Là UI/MCP client, tôi muốn tác vụ dài có trạng thái bền vững và sự kiện realtime để không phải giữ request mở hoặc đoán tiến độ.
- **Migration không làm gián đoạn app**:
  - Là người dùng hiện tại, tôi muốn các route được cắt chuyển từng bước mà studio vẫn mở và đọc project được trong suốt migration.
  - Là kỹ sư phát hành, tôi muốn CI khóa parse/serialize, contract và filesystem behavior trước khi thay các đường ghi.

## Spec Planning

- **Supplementary files**:
  - [Detailed Goals](./spec-core-backend-foundation-detailed-goal.md) — **đã duyệt 2026-08-01**
  - [Detailed Design](./spec-core-backend-foundation-detailed-design.md) — **đã duyệt 2026-08-01**
  - [Implementation Checklist](./spec-core-backend-foundation-implementation-checklist.md) — **đã duyệt 2026-08-01**
- **Date**: Thực thi và hoàn tất ngày 2026-08-01 sau khi đủ ba phase gate.
- **Capacity**: **83 Story Points**, breakdown theo 15 phase ở [Implementation Checklist](./spec-core-backend-foundation-implementation-checklist.md) §Capacity. Không phải cam kết lịch.
  - Diễn biến: 55 (ước lượng ban đầu) → 73 (sau review Detailed Design bổ sung lease/journal/entity_state/event_outbox) → **83** (sau review Checklist bổ sung Phase I use case + composition root, identity bootstrap, bridge credential, compat wrapper).
  - Giả định để ước lượng: repo hiện có **0 test**, nên R2 gồm cả việc dựng test harness từ số không, không chỉ viết test.
  - Ước lượng 3–4 tuần ở build order giả định một đội đã quen codebase làm toàn thời gian. Nếu khác, con số phải đổi trước khi cam kết bất cứ điều gì.
- **Testing**: Typecheck, lint/import-boundary, unit, golden, contract và integration trên filesystem/**SQLite** thật trong thư mục tạm; golden `serialize()` phải có trước thay đổi đường ghi
  > Lưu ý lệch rule: `spec-rule.md` §3 yêu cầu "a real PostgreSQL test database". Project này dùng SQLite ở application-data và không có PostgreSQL ở bất kỳ đâu. Spec theo SQLite là đúng; rule cần được sửa cho khớp project.
- **Risks**:
  - **Migration breadth**: RSC và các route `/api/hf` đang gọi trực tiếp nhiều module filesystem; cutover sai thứ tự có thể làm studio không mở được.
  - **Write compatibility**: `@hyperframes/sdk` serialize lại toàn document; thay đổi SDK hoặc save path có thể tạo diff lớn hay làm hỏng project.
  - **Filesystem races**: Người dùng có thể sửa file bằng editor ngoài khi daemon đang mở project; hash, watcher và cache phải nhất quán.
  - **Security regression**: Localhost API vẫn bị DNS rebinding/CORS attack nếu thứ tự middleware hoặc token flow sai.
  - **Packaging drift**: Phase 0 đã chọn Node SEA; dependency Bun-only trong production packages sẽ làm sai quyết định D2 dù packaging đầy đủ thuộc Phase 4.
  - **Bê lỗ bảo mật sang stack mới**: route asset phải migrate trong Phase 1 (R9 AC5). Nếu migrate mà hoãn allowlist sang Phase 3, endpoint mới vẫn đọc được `.env`, `package.json`, `AGENTS.md`. Đã xử lý bằng cách kéo allowlist vào R6 AC5–AC7 và vào phạm vi Phase 1.
  - **Version format skew**: client hiện gửi `baseVersion` dạng `mtime`+`size`; write authority mới yêu cầu content hash. Cutover lệch nhịp sẽ làm mọi lần save gãy hoặc bỏ qua kiểm tra xung đột. Đã xử lý bằng R5 AC3b.
  - **Estimate chưa kiểm chứng**: 83 SP đã có breakdown theo 15 phase, nhưng repo chưa có test nào để làm mốc vận tốc — con số vẫn chưa hiệu chỉnh được bằng dữ liệu thật.
- **Commitments**:
  - Không thêm tính năng người dùng mới trong spec này; chỉ xây nền móng của Phase 1, mục 1.1–1.13.
  - Không migrate một route mà bỏ lại lỗ bảo mật đã biết trên route đó — hardening đi cùng cutover, không hoãn sang phase sau.
  - Giữ app chạy được ở mỗi bước và cắt route đọc trước route ghi.
  - Không thay đường ghi hiện tại trước khi golden `serialize()` và test harness tương ứng chạy xanh.
  - Không viết production code trước khi Detailed Goals, Detailed Design và Implementation Checklist được duyệt rõ ràng.
  - Production runtime mới phải tương thích hướng Node SEA đã được Phase 0 chứng minh; không mở lại Bun native-loader nếu không có spike mới.

## Phase Approvals

- **Detailed Goals**: **Approved** — duyệt ngày 2026-08-01 sau vòng review sửa A1–A4, B1–B5, C1–C4
- **Detailed Design**: **Approved** — duyệt 2026-08-01 sau vòng review sửa 7 finding P1 + 2 P2
- **Implementation Checklist**: **Approved** — chủ dự án mở Code Execution bằng goal ngày 2026-08-01; thực thi tuần tự Phase A→O với gate B trước G/H/N và J trước K

## During Spec

- **Standups**: 2026-08-01 — mở Code Execution, xác minh đủ 118 task ID, bắt đầu Phase A
- **Impediments**:
  - Chưa có blocker kỹ thuật từ Phase 0; Approval Gate của Implementation Checklist đã được mở ngày 2026-08-01.
- **Adjustments**:
  - D2 đã chuyển từ Bun executable sang Node SEA sau khi Bun không load được native addon trong artifact compile.
  - Bun native-loader rewrite đã bị loại; HyperFrames CLI chưa cần Node sidecar cho các lệnh parse/lint/list đã thử.
  - Sau review Detailed Goals ngày 2026-08-01: kéo **allowlist loại file** vào phạm vi Phase 1 (trước đó để ở Phase 3) vì route asset buộc phải migrate trong phase này; tách **kiểu dữ liệu `diagnostics`** khỏi bộ quy tắc sinh diagnostics; tách **file mutation** khỏi **entity mutation** trong write authority; thêm đường migrate version `mtime`+`size` → content hash.
  - Rule templates đã được sửa từ "real PostgreSQL test database" sang datastore thật của project (SQLite + filesystem thật), vì project không có PostgreSQL.
  - Sau review Detailed Design ngày 2026-08-01 (7 finding P1, 2 P2): thêm workspace lease chéo process, journal-first cho mutation, `ResolvedPath` capability, `entity_state`, `event_outbox`, ma trận legacy alias, sửa job idempotency, hoàn chỉnh vòng đời session.
  - Dependency runtime mới đã chốt: `node:sqlite` (built-in, tránh native addon cho Node SEA), `drizzle-orm@1.0.0-rc.4`, `zod@4.4.3` — pin exact, không caret.
  - Sau review Implementation Checklist ngày 2026-08-01 (9 finding P1, 6 phụ): thêm Phase I (use case + composition root + startup order), tách cutover route đọc/ghi theo **method có trong file** thay vì theo route, thêm task identity bootstrap giải vòng phụ thuộc FK, thêm bridge credential store (R8 AC8), giữ compat wrapper `src/lib/hyperframes` tới Phase N, khôi phục bảng Skill Activation, thêm nghĩa vụ `implementation-notes.html`.
  - Hậu review implementation ngày 2026-08-01: vá allowlist bypass qua symlink canonical target; abort journal ngay khi atomic write lỗi nhưng giữ pending nếu commit lỗi sau write; chuẩn hóa conflict revision về `0`; missing entity state trả `internal`. Detailed Design §5.5/§5.6 được đồng bộ trong cùng phiên.

## Spec Review

- **Completed**: 118/118 task ID; Phase A→O tuần tự; gate B trước G/H/N và J trước K đều được giữ.
- **Demo**: Playwright trên Next thật mở studio, lưu source, Regenerate TTS và AI Composer với 0 console error. E2E tự động chạy đủ ba project mẫu qua list → snapshot → save → job → event/SSE.
- **Feedback**: Toàn bộ CI bắt buộc xanh sau vòng hậu review: frozen install, typecheck, lint, boundary và 31 file/170 test. Production build cũng xanh. Persistence đã rebuild Drizzle thuần với một foundation migration, không compatibility shim; P1 symlink allowlist và P2 journal cleanup đã có regression coverage. Node SEA artifact smoke đầy đủ vẫn là gate Phase 4 theo đúng R13 AC5, không phải deliverable đã hoàn tất ở Phase 1.

## Spec Retrospective

- **Well**: Golden gate sớm giữ serialize/preview ổn định; cutover từng route và test filesystem/SQLite thật bắt được race, crash, no-overwrite và compatibility. Ghi design drift cùng lúc giữ contract, schema và recovery thống nhất.
- **Not Well**: Lease renewal bị bỏ sót trong implementation ban đầu dù design đã ghi 10 giây; chỉ browser session dài hơn TTL mới lộ 409. Test containment ban đầu chỉ phủ symlink thoát project, chưa phủ symlink nội-project trỏ vào file bị allowlist cấm. Next production build vẫn cảnh báo NFT trace rộng, và lint còn warning trong `.temp-documents` ngoài phạm vi spec.
- **Improvements**: Các daemon lifecycle sau nên có test vượt TTL ngay từ Phase startup; mỗi phase route cần browser smoke dài hơn lease TTL. Phase 4 phải xử lý NFT/package tracing cùng Node SEA cold/warm artifact matrix trước release.

## Next Spec Adjustments

- **Changes**: Dùng composition root, Core use case, WriteAuthority, job store và event outbox vừa hoàn tất làm baseline bắt buộc cho HTTP/MCP tiếp theo.
- **Carry-over**: Phase 2 nối MCP transport; Phase 3 worker/render thật; Phase 4 Node SEA extraction, native sidecar, signing/notarization, cold/warm smoke theo OS × kiến trúc và xử lý package tracing.
- **Lessons**: Runtime truth cần cả integration test lẫn browser session đủ dài; exit 0 phải được phân biệt rõ với warning còn tồn tại; composite filesystem/database mutation cần journal metadata đủ để recovery quyết định mà không đoán.
