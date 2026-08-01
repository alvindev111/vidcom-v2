# Spec Core Backend Foundation — Detailed Goals

> **Reference**: [Main Spec](./spec-core-backend-foundation-inprocess.md)
>
> **Source scope**: [Phase 1 — Nền móng](../../../product-features/15-build-order.md#giai-đoạn-1--nền-móng-34-tuần), mục 1.1–1.13.

## Spec Goal

Tạo một nền móng backend local-first có ranh giới kiến trúc kiểm chứng được, giữ an toàn dữ liệu project, có perimeter bảo mật cho daemon local, và cung cấp API/job/event contracts ổn định để HTTP UI và MCP ở các giai đoạn sau cùng gọi một Application Core. Kết quả của spec không thêm capability sản phẩm mới; nó thay thế những dependency ngầm và đường I/O phân tán bằng các hợp đồng có thể kiểm thử.

## Baseline đã xác nhận

- `PROJECTS_ROOT` hiện phụ thuộc `process.cwd()` nên workspace không thể được chọn/inject ổn định khi đóng gói.
- Trang studio RSC hiện gọi trực tiếp các module đọc project, source tree, scene, root track và preview settings từ filesystem.
- Các đường ghi hiện chưa có một write authority duy nhất; một số đường dùng ghi trực tiếp và `openProjectFile()` chưa canonicalize/kiểm tra symlink containment.
- Version của source editor hiện dựa trên `mtime` và size, không phải content hash.
- Repo chưa có test bảo vệ các symbol đọc/ghi chính.
- Phase 0 đã xác nhận Node SEA là hướng D2, dual-stack MCP khả thi và route cụ thể của Next thắng optional catch-all.

## Vai trò liên quan

- **Người dùng VidCom**: sở hữu workspace/project và cần file không bị hỏng, mất hoặc lộ.
- **UI client**: mở studio, đọc snapshot, ghi thay đổi có kiểm soát và nhận event realtime.
- **MCP/CLI client**: về sau phải gọi cùng use case và nhận cùng error contract như HTTP.
- **Kỹ sư/maintainer**: cần ranh giới package, test deterministic và migration từng bước.
- **Local daemon/worker operator**: cần auth, recovery, concurrency và log/audit đủ để chẩn đoán.

## Data and Persistence Scope

- **Persisted data involved**: project marker/metadata, composition và project assets/settings; job state; revision index/content; audit record; application settings; registry/cache metadata.
- **Data ownership**: composition, render inputs và output thuộc workspace/project công khai; job, audit, revision index/content, credential, log và cache thuộc application-data ẩn của hệ điều hành.
- **Lifecycle**: project file sống theo workspace; mỗi mutation thành công tạo revision/audit; job terminal được giữ theo retention policy cấu hình được; temp/stale job artifacts được dọn khi khởi động mà không xóa output người dùng.
- **Consistency requirements**: project file là source of truth; mọi mutation cần expected content hash hoặc revision; ghi atomic; một writer cho mỗi workspace; job enqueue hỗ trợ idempotency; progress đơn điệu; migration SQLite có version và idempotent.
- **Query and reporting needs**: list project có thứ tự deterministic; studio snapshot trả đủ dữ liệu để mở studio trong một contract; job có thể query theo ID và phát progress/event; audit truy được theo mutation/job/tool actor mà không chứa secret hoặc nội dung file.
- **Volume and growth assumptions**: local-first, một người dùng/máy; nhiều project trong một workspace; cache phải có giới hạn; event phải debounce/throttle; SQLite dùng WAL và một writer.
- **Migration/backfill expectations**: project HyperFrames hiện có vẫn mở được; project thiếu ID ổn định được nhận diện/migrate mà không đổi nội dung composition; schema application-data tự migrate khi khởi động; không đưa composition vào DB.
- **Audit and compliance needs**: audit mọi file mutation và hành vi có quyền; phân biệt actor; redact token, prompt, nội dung file và absolute user path ở log info; credential không nằm trong workspace và có quyền truy cập hệ điều hành hạn chế.

## Requirements

### R1 — Package boundaries và composition root

**User Story:** Là maintainer, tôi muốn backend được chia thành các package có hướng phụ thuộc cưỡng chế được, để Core dùng chung cho HTTP và MCP mà không chứa transport hoặc infrastructure.

#### Acceptance Criteria

1. WHEN workspace được typecheck hoặc lint THEN hệ thống SHALL kiểm tra các package `core`, `adapter`, `server`, `mcp`, `worker`, `contracts`, `agent-kit` và `cli` theo boundary đã công bố.
1a. WHEN Phase 1 chạy job THEN worker SHALL chạy in-process cùng daemon; package `worker` SHALL tồn tại với boundary được cưỡng chế nhưng SHALL NOT bắt buộc tách process cho tới Phase 4.
2. IF code trong Core import Hono, Next, MCP SDK, Node filesystem, adapter cụ thể hoặc đọc global runtime state THEN boundary check SHALL fail CI.
3. WHEN một use case cần I/O, thời gian hoặc ID THEN Core SHALL nhận dependency qua port thay vì import adapter hoặc singleton.
4. WHEN HTTP và MCP cần cùng một capability THEN cả hai adapter SHALL gọi cùng use case contract và không sao chép business rule vào route/tool handler.
5. WHEN application khởi động THEN chỉ composition root SHALL nối port với adapter cụ thể.
6. WHEN chạy CI THEN thứ tự import hoặc dependency vi phạm SHALL làm job thất bại với file vi phạm có thể xác định được.

### R2 — Test harness và regression gates

**User Story:** Là kỹ sư thay đổi backend, tôi muốn regression suite nhanh và deterministic, để biết một migration có đổi parse, serialize, contract hoặc filesystem behavior hay không.

#### Acceptance Criteria

1. WHEN CI chạy THEN hệ thống SHALL chạy typecheck, lint/import-boundary, unit, golden, contract và integration tests; bất kỳ suite nào fail SHALL làm CI fail.
2. WHEN một thay đổi chạm bất kỳ đường ghi production hiện có được đề xuất THEN CI SHALL yêu cầu golden test cho `composition.serialize()` đã tồn tại và xanh trên fixture đã review, và SHALL fail nếu chưa có.
3. WHEN output serialize, preview document hoặc parse structure khác golden đã commit THEN CI SHALL fail và SHALL NOT tự cập nhật expected output.
4. WHEN Core tạo timestamp hoặc identifier trong test THEN test SHALL dùng clock/ID deterministic và cho cùng kết quả qua nhiều lần chạy.
5. WHEN filesystem concurrency, traversal, atomic write, watcher, workspace lock hoặc job recovery được kiểm THEN integration test SHALL dùng filesystem/SQLite thật trong thư mục tạm, không mock `node:fs`.
6. WHEN một use case hoặc boundary contract mới được thêm THEN test happy path và failure path tương ứng SHALL đi cùng thay đổi đó.

### R3 — Workspace và project identity tường minh

**User Story:** Là người dùng, tôi muốn VidCom mở đúng workspace tôi chọn và nhận diện project ổn định khi di chuyển thư mục, để đóng gói hoặc đổi thư mục chạy không làm app nhìn nhầm dữ liệu.

#### Acceptance Criteria

1. WHEN runtime resolve workspace THEN hệ thống SHALL ưu tiên workspace tường minh, rồi active workspace đã lưu, rồi cwd chỉ khi có project marker hợp lệ; nếu không có nguồn hợp lệ, hệ thống SHALL yêu cầu chọn workspace.
2. IF không có workspace hợp lệ THEN hệ thống SHALL NOT tự tạo hoặc đoán thư mục project.
3. WHEN Core hoặc adapter xử lý project THEN workspace root SHALL được inject và không được suy ra bằng `process.cwd()` bên trong Core/server module.
4. WHEN project folder được di chuyển trong hoặc giữa workspace THEN project ID SHALL giữ ổn định.
5. WHEN project hiện có thiếu marker ID hợp lệ THEN hệ thống SHALL gán ID ổn định mà không sửa composition content.
6. WHEN hai project có cùng ID do copy folder THEN project mở sau SHALL nhận ID mới và hệ thống SHALL ghi audit/log cho sự kiện đó.

### R4 — Filesystem/HyperFrames ports và parse compatibility

**User Story:** Là UI hoặc MCP client, tôi muốn cùng một Core đọc và hiểu project HyperFrames, để transport không tạo ra hai cách diễn giải composition khác nhau.

#### Acceptance Criteria

1. WHEN Core cần đọc workspace, parse composition hoặc dựng preview document THEN hệ thống SHALL thực hiện qua port có documented success/error semantics.
2. WHEN parse project THEN `data-*` trong composition SHALL là source of truth cho dimension, duration, scene và timing; metadata chỉ được dùng làm fallback đã xác định.
3. WHEN parser không resolve được effect/tween THEN hệ thống SHALL báo số unresolved và SHALL NOT bịa timing mặc định.
4. WHEN parse các edge case đã liệt kê trong steering testing fixtures THEN output SHALL khớp golden structure deterministic.
5. WHEN preview hoặc render về sau cần document THEN chúng SHALL dùng cùng một document-building contract; Phase 1 SHALL không tạo đường preview thứ hai.
6. WHEN một port method có thể trả `null`, conflict hoặc system failure THEN hợp đồng SHALL mô tả rõ ý nghĩa và behavior throw/non-throw.

### R5 — Một write authority cho mọi project mutation

**User Story:** Là người dùng hoặc agent, tôi muốn mọi lần ghi project được kiểm tra, atomic và có lịch sử, để thay đổi đồng thời hoặc crash không phá hay ghi đè dữ liệu.

#### Acceptance Criteria

1. WHEN bất kỳ HTTP, UI, worker hoặc Core use case ghi project file THEN mutation SHALL đi qua cùng một write authority; không có direct project write path thứ hai.
2. WHEN write authority nhận yêu cầu THEN nó SHALL phân biệt hai loại mutation và áp precondition tương ứng:
   - **File mutation** (ghi nguyên nội dung một file: composition, source file) SHALL yêu cầu `expectedContentHash`.
   - **Entity mutation** (patch có ngữ nghĩa merge như section của `preview-settings.json`) SHALL yêu cầu `expectedRevision` của entity, SHALL merge theo section đã công bố, và SHALL NOT yêu cầu content hash của file nền.
   Cả hai loại SHALL dùng chung đường atomic write, revision, audit, invalidate và event ở AC4–AC6.
3. WHEN client yêu cầu ghi mà thiếu precondition tương ứng với loại mutation ở AC2 THEN hệ thống SHALL từ chối trước khi thay đổi file.
3a. WHEN expected hash/revision khác state hiện tại THEN hệ thống SHALL trả conflict machine-readable kèm content hash, revision và nội dung server hiện tại cần cho diff/merge.
3b. WHEN client gửi version theo định dạng `mtime`+`size` cũ THEN hệ thống SHALL từ chối bằng ErrorCode riêng biệt nêu rõ định dạng version đã đổi, và SHALL NOT coi đó là ghi không kiểm tra; UI SHALL được cutover sang content hash trong cùng bước migrate endpoint tương ứng.
4. WHEN mutation hợp lệ THEN hệ thống SHALL validate nội dung phù hợp, ghi temp cùng filesystem, đồng bộ dữ liệu cần thiết và atomic rename trước khi công bố thành công.
5. WHEN process bị dừng giữa một mutation THEN file đích SHALL vẫn là bản hoàn chỉnh trước đó hoặc bản hoàn chỉnh mới, không phải bản ghi dở.
6. WHEN mutation thành công THEN hệ thống SHALL tạo revision và audit record, invalidate cache và phát đúng một logical `file.changed` event theo thứ tự đã cam kết.
7. WHEN hai mutation cùng expected state chạy đồng thời THEN đúng một mutation SHALL thành công và mutation còn lại SHALL nhận conflict.
8. WHEN mutation tạo output destructive hoặc thay thế dữ liệu THEN hệ thống SHALL có backup/audit đủ để khôi phục phạm vi thao tác đã công bố.

### R6 — Path containment, allowlist và file access safety

**User Story:** Là chủ workspace, tôi muốn mọi đường dẫn do UI/AI gửi chỉ có thể truy cập bên trong project **và chỉ chạm tới loại file được phép**, để file ngoài project, symlink escape và file cấu hình nội bộ đều không bị đọc hoặc ghi.

#### Acceptance Criteria

1. WHEN bất kỳ boundary nhận project-relative path THEN hệ thống SHALL đi qua đúng một canonical path resolver dùng chung trước mọi read/write.
2. WHEN input chứa traversal, absolute path hoặc canonical target nằm ngoài project THEN hệ thống SHALL từ chối bằng ErrorCode machine-readable và SHALL không thực hiện I/O trên target.
3. WHEN path đi qua symlink THEN hệ thống SHALL resolve symlink và kiểm containment lại trước khi cho phép truy cập.
4. WHEN `openProjectFile()` hoặc chức năng tương đương mở file do client chọn THEN nó SHALL chịu cùng resolver và policy như mọi file operation khác.
5. WHEN một endpoint phục vụ asset của project ra ngoài THEN nó SHALL áp allowlist theo loại file **cùng lúc với** việc migrate endpoint đó, và SHALL NOT phục vụ file cấu hình hoặc file có khả năng chứa secret — tối thiểu chặn `.env*`, `package.json`, `AGENTS.md`, `CLAUDE.md` và dotfile.
6. WHEN một request yêu cầu file nằm ngoài allowlist THEN hệ thống SHALL từ chối bằng ErrorCode phân biệt được với "không tìm thấy", và SHALL không tiết lộ sự tồn tại của file qua thông điệp lỗi.
7. WHEN integration suite chạy THEN traversal bằng `..`, absolute path, symlink escape và truy cập file ngoài allowlist SHALL đều bị chặn trên filesystem thật.

### R7 — Schema validation và error contract dùng chung

**User Story:** Là UI/MCP client, tôi muốn input và lỗi có schema ổn định, để hiển thị đúng lỗi, retry đúng trường hợp và không phụ thuộc chuỗi tiếng Anh.

#### Acceptance Criteria

1. WHEN boundary nhận body, query, path param hoặc tool input THEN hệ thống SHALL validate bằng schema từ package contracts trước khi gọi Core.
2. WHEN input vượt giới hạn kích thước hoặc sai schema THEN hệ thống SHALL từ chối trước I/O và trả ErrorCode, message cùng field/details khi phù hợp.
3. WHEN Core gặp lỗi nghiệp vụ dự đoán được THEN use case SHALL trả typed Result/DomainError thay vì throw.
4. WHEN HTTP hoặc MCP trả lỗi THEN adapter SHALL map từ cùng một ErrorCode enum và Core SHALL không biết HTTP status hay MCP error number.
5. WHEN một entity có thể ghi được được trả về sau mutation THEN response SHALL chứa entity đã cập nhật và revision thay vì chỉ `{ ok: true }`.
5a. WHEN response mutation được định nghĩa THEN nó SHALL bao gồm trường `diagnostics` với **kiểu dữ liệu ổn định** đã khai trong contracts; Phase 1 SHALL trả mảng rỗng, và bộ quy tắc sinh diagnostics thuộc Phase 3. Client SHALL NOT phải đổi contract khi Phase 3 bắt đầu điền dữ liệu vào trường này.
6. WHEN contract thay đổi không tương thích THEN contract test SHALL fail trước khi merge.

### R8 — Local authentication perimeter

**User Story:** Là người dùng chạy VidCom trên máy cá nhân, tôi muốn local API chỉ phục vụ phiên VidCom hợp lệ, để website khác không thể đọc hoặc sửa project của tôi.

#### Acceptance Criteria

1. WHEN daemon lắng nghe HTTP THEN nó SHALL chỉ bind loopback, chọn/xử lý port tường minh và SHALL NOT bind `0.0.0.0`.
2. WHEN request có Host không thuộc loopback host/port đang chạy THEN hệ thống SHALL từ chối trước khi đọc credential hoặc chạy auth.
3. WHEN request cross-origin không thuộc UI allowlist THEN hệ thống SHALL từ chối; hệ thống SHALL NOT wildcard hoặc phản chiếu Origin.
4. WHEN app mở browser bằng one-time nonce hợp lệ THEN UI SHALL đổi nonce lấy cookie `HttpOnly`, `SameSite=Strict` và loại nonce khỏi URL hiển thị/history flow.
5. WHEN nonce hết hạn hoặc đã dùng THEN lần exchange tiếp theo SHALL bị từ chối.
6. WHEN request API không có session/token hợp lệ THEN hệ thống SHALL từ chối kể cả request đến từ localhost.
7. WHEN middleware chạy THEN thứ tự security SHALL bảo đảm host check và CORS xảy ra trước auth, validation xảy ra trước route business logic.
8. WHEN credential cho bridge được lưu THEN nó SHALL nằm trong application-data, không vào workspace/log, và có permission/ACL hạn chế tương đương `0600`.

### R9 — Hono cutover có tương thích

**User Story:** Là người dùng hiện tại, tôi muốn migration từ Next route sang Hono không làm studio ngừng hoạt động, để nền móng có thể thay từng phần an toàn.

#### Acceptance Criteria

1. WHEN Hono được gắn dưới optional catch-all THEN một route Next cụ thể chưa migrate SHALL tiếp tục thắng và giữ behavior hiện có.
2. WHEN một route được migrate THEN read route SHALL được cut over và verify trước write route phụ thuộc nó.
3. WHEN client gọi API nền móng mới THEN resource URL SHALL nằm dưới `/api/v1`, dùng method/resource semantics đã công bố và không dùng action multiplexer.
4. WHEN một route cũ chưa có endpoint tương đương đã verify THEN hệ thống SHALL giữ forward/compatibility path thay vì xóa làm gãy client.
5. WHEN cutover hoàn tất THEN `src/` SHALL không chứa server business/filesystem code ngoài một forward entry vào server package.
6. WHEN routing contract suite chạy THEN exact-route precedence, error mapping và migrated route response schema SHALL được kiểm tự động.
7. WHEN một route vừa cutover bị phát hiện lỗi THEN hệ thống SHALL cho phép hoàn tác bằng cách khôi phục route Next cụ thể tương ứng mà không cần revert các route đã migrate khác; mỗi bước cutover SHALL được ghi lại đủ để thực hiện hoàn tác đó.
8. WHEN một route đã cutover THEN hệ thống SHALL có ít nhất một kiểm chứng chạy được xác nhận behavior tương đương trước và sau, để việc quyết định hoàn tác dựa trên bằng chứng thay vì cảm tính.

### R10 — API-backed project list và studio snapshot

**User Story:** Là UI client, tôi muốn mở danh sách project và studio từ API snapshot, để React Server Components không phụ thuộc trực tiếp filesystem và cùng contract có thể được desktop client tái sử dụng.

#### Acceptance Criteria

1. WHEN UI cần danh sách project THEN nó SHALL lấy dữ liệu qua `GET /api/v1/projects` thay vì gọi filesystem module trong RSC.
2. WHEN UI mở một project THEN nó SHALL lấy dữ liệu khởi tạo qua `GET /api/v1/projects/:id/studio-snapshot`.
3. WHEN snapshot thành công THEN response SHALL chứa đủ project summary, entry source/version, tree, scenes, root track và preview settings để render trạng thái studio ban đầu mà không có RSC filesystem read bổ sung.
4. WHEN project không tồn tại hoặc snapshot không hợp lệ THEN API SHALL trả ErrorCode/status phù hợp và SHALL không rò absolute path.
5. WHEN project files thay đổi ngoài VidCom sau snapshot THEN watcher/event path SHALL cho phép client biết snapshot đã stale mà không cần `router.refresh()` toàn trang sau mỗi mutation.
6. WHEN migration hoàn tất THEN page/layout/component server code SHALL không import module đọc filesystem/project `.server` trực tiếp.

### R11 — Persistent job foundation

**User Story:** Là UI/MCP client, tôi muốn tác vụ dài chạy như job bền vững, để request trả nhanh, có thể theo dõi/hủy và app phục hồi rõ ràng sau restart.

#### Acceptance Criteria

1. WHEN một thao tác không chắc hoàn thành trong request THEN hệ thống SHALL enqueue job đã validate và trả job ID ngay, không chạy công việc dài trong handler.
2. WHEN job chuyển trạng thái THEN nó SHALL tuân theo `queued → running → succeeded|failed|cancelled`; chỉ ba trạng thái sau là terminal.
3. WHEN client đọc job THEN response SHALL có status, progress `0..1`, stage, result/error, attempt và các timestamp cần thiết theo contract.
4. WHEN progress cập nhật THEN giá trị SHALL không giảm và event SHALL được throttle; nếu không biết phần trăm, hệ thống SHALL cập nhật stage mà không đoán progress.
5. WHEN client gửi cùng idempotency key và cùng input THEN hệ thống SHALL trả job cũ thay vì tạo bản ghi thứ hai.
6. WHEN cancel được yêu cầu THEN worker SHALL dừng hợp tác ở safe point, dọn output dở và không để child process sống sót; cancel job terminal SHALL là no-op thành công.
7. WHEN daemon khởi động và thấy running job có heartbeat quá hạn THEN hệ thống SHALL fail hoặc requeue theo tính idempotent đã công bố, không để job treo vô hạn.
8. WHEN scheduler chạy THEN concurrency SHALL giới hạn theo job type và job cùng project/cùng type SHALL không chạy song song.
9. WHEN job state được persist hoặc migrate THEN SQLite trong application-data SHALL dùng versioned idempotent migration và giữ state qua restart.
10. WHEN SQLite được mở THEN nó SHALL chạy ở chế độ WAL và SHALL chỉ có một writer cho mỗi database; nhiều reader đồng thời SHALL không bị chặn bởi writer.
11. WHEN database file nằm trong application-data THEN nó SHALL NOT được đặt trong workspace của người dùng ở bất kỳ trường hợp nào.

### R12 — Event stream, watcher và cache coherence

**User Story:** Là UI client, tôi muốn nhận một luồng event có thể resume khi file hoặc job đổi, để giao diện cập nhật realtime mà không polling toàn workspace.

#### Acceptance Criteria

1. WHEN client có phiên hợp lệ kết nối `GET /api/v1/events` THEN hệ thống SHALL mở một SSE stream dùng chung cho các event type đã công bố.
2. WHEN event được gửi THEN nó SHALL có event ID deterministic/monotonic đủ để client resume bằng `Last-Event-ID` trong retention window.
3. WHEN kết nối im lặng THEN hệ thống SHALL gửi heartbeat định kỳ để phát hiện disconnect và tránh proxy/webview đóng ngầm.
4. WHEN file project bị sửa bởi công cụ ngoài THEN watcher SHALL debounce thay đổi, invalidate cache liên quan và phát `file.changed`/`project.changed` phù hợp.
5. WHEN write authority tự ghi file THEN watcher SHALL nhận diện content hash vừa ghi và SHALL không tạo event loop hoặc duplicate logical event.
6. WHEN cache promise reject THEN entry lỗi SHALL bị xóa; WHEN cache vượt giới hạn project THEN policy SHALL evict entry thay vì tăng vô hạn.
7. WHEN job progress hoặc completion thay đổi THEN poll endpoint và SSE SHALL phản ánh cùng một persisted job state.
8. WHEN SSE chạy qua host Next trong thời gian cutover THEN integration test SHALL xác nhận event không bị buffer sai và reconnect/resume hoạt động.

### R13 — Runtime compatibility và completion milestone

**User Story:** Là kỹ sư phát hành, tôi muốn nền móng giữ tương thích với quyết định Node SEA và có exit criteria rõ ràng, để Phase 4 không phải viết lại backend vì API runtime phụ thuộc Bun.

#### Acceptance Criteria

1. WHEN code production mới trong các package nền móng được review THEN nó SHALL chạy trên Node runtime đã chọn và SHALL không yêu cầu Bun-only API.
2. WHEN native dependency cần đường dẫn runtime THEN package contract SHALL cho phép runtime path được inject; package SHALL không giả định dependency nằm cạnh source checkout.
3. WHEN Phase 1 được tuyên bố hoàn tất THEN `src/` SHALL chỉ giữ một server forward entry, CI bắt buộc SHALL xanh và không có route/RSC business logic đọc ghi filesystem trực tiếp.
4. WHEN Phase 1 hoàn tất THEN app SHALL vẫn list/mở được project hiện có, lưu mutation qua write authority, khôi phục job state và phát event trên runtime phát triển được hỗ trợ.
5. WHEN đánh giá completion THEN Node SEA artifact smoke đầy đủ SHALL được ghi rõ là gate của Phase 4, không được tuyên bố hoàn tất trong Phase 1 nếu chưa thực hiện.

## Scope boundaries

### Trong phạm vi

- Toàn bộ Phase 1 mục 1.1–1.13.
- Migration tương thích của project list, studio snapshot và các route đọc/ghi cần thiết để đạt mốc Phase 1.
- Test/CI và dữ liệu vận hành tối thiểu cho write, auth, jobs, events và cache.
- Ràng buộc runtime để không phá quyết định Node SEA của Phase 0.
- **Allowlist loại file khi phục vụ asset** (R6 AC5–AC7). Kéo vào Phase 1 vì R9 AC5 buộc route asset phải migrate trong phase này; migrate mà không kèm allowlist là bê nguyên lỗ đọc `.env`/`package.json`/`AGENTS.md` sang stack mới, trong khi chi phí thêm lúc migrate gần bằng không.
- **Kiểu dữ liệu `diagnostics`** trong response mutation (R7 AC5a) — chỉ hình dạng contract, Phase 1 trả mảng rỗng.

### Ngoài phạm vi

- Bộ MCP tools thật, protocol negotiation và MRTR của Phase 2.
- Render MP4, TTS thật, snapshot media, Range request cho asset và feature CRUD của Phase 3. **Bộ quy tắc sinh diagnostics** (VD-1/2/3) cũng thuộc Phase 3 — Phase 1 chỉ khai kiểu dữ liệu.
- Build Node SEA cuối, nhúng frontend, sidecar extraction, signing/notarization và smoke matrix của Phase 4.
- Timeline drag/drop, undo/redo UI và editing UX của Phase 5.
- AI Composer trong app, cloud render và các capability Phase 6.
- Multi-user, SaaS auth và CRDT.

## Assumptions và constraints

- VidCom là local-first, một người dùng trên một máy; single-writer áp dụng cho đường ghi VidCom nhưng editor ngoài vẫn được phép sửa project.
- Project file tiếp tục là source of truth; SQLite không chứa composition content.
- Migration phải giữ app chạy được ở mỗi bước; exact Next route vẫn thắng optional catch-all như Phase 0 đã chứng minh.
- Node SEA là hướng packaging được duyệt cho D2; Bun vẫn có thể dùng làm package manager/dev tool nếu không rò thành runtime requirement.
- **Ràng buộc quy trình:** nếu một thay đổi yêu cầu quay lại Bun native-loader hoặc thay Node SEA, công việc phải dừng để tạo spike/decision mới thay vì đổi D2 ngầm. Đây là luật quy trình, không phải thuộc tính hệ thống kiểm chứng được — nên nó nằm ở đây thay vì trong acceptance criteria.
- Ước lượng 3–4 tuần là thứ tự tương đối theo build order, không phải cam kết giao hàng.

## Traceability to canonical build order

| Build item | Requirement | Steering rule chi phối |
|---|---|---|
| 1.1 Packages + lint boundary | R1 | [02-project-layout](../../../steering/02-project-layout.md) §1–§2 · [03-architecture-ddd](../../../steering/03-architecture-ddd.md) §2, §5–§6 |
| 1.2 Test harness + CI | R2 | [10-testing](../../../steering/10-testing.md) §2, §10 |
| 1.3 Serialize golden before writes | R2 | [10-testing](../../../steering/10-testing.md) §4.1 |
| 1.4 Injectable WorkspaceRoot | R3 | [07-data-and-storage](../../../steering/07-data-and-storage.md) §3, §10 |
| 1.5 Filesystem/HyperFrames ports + parse Core | R4 | [03-architecture-ddd](../../../steering/03-architecture-ddd.md) §2.3, §3.1, §3.3–§3.4 |
| 1.6 Single write service | R5 | [07-data-and-storage](../../../steering/07-data-and-storage.md) §4–§6 |
| 1.7 `resolveInProject()` + allowlist | R6 | [06-validation](../../../steering/06-validation.md) §5 · [09-security](../../../steering/09-security.md) §5–§6 |
| 1.8 Schema + ErrorCode | R7 | [06-validation](../../../steering/06-validation.md) §2–§4, §8 · [04-api-design](../../../steering/04-api-design.md) §3 |
| 1.9 Local auth perimeter | R8 | [09-security](../../../steering/09-security.md) §1–§4 · [04-api-design](../../../steering/04-api-design.md) §10 |
| 1.10 Hono catch-all cutover | R9 | [02-project-layout](../../../steering/02-project-layout.md) §3 · [04-api-design](../../../steering/04-api-design.md) §2 |
| 1.11 Remove RSC filesystem reads | R10 | [02-project-layout](../../../steering/02-project-layout.md) §3 |
| 1.12 Job infrastructure | R11 | [08-jobs-and-queue](../../../steering/08-jobs-and-queue.md) toàn bộ · [07-data-and-storage](../../../steering/07-data-and-storage.md) §9 |
| 1.13 SSE + watcher + event invalidation | R12 | [04-api-design](../../../steering/04-api-design.md) §7 · [07-data-and-storage](../../../steering/07-data-and-storage.md) §7–§8 |
| Phase 0 D2 decision / Phase 1 milestone | R13 | [01-backend-stack](../../../steering/01-backend-stack.md) §1–§2 |

Nguyên tắc domain bị chi phối xuyên suốt: **P1** (`data-*` là source of truth) ở R4 · **P2/P3** (preview settings không rewrite source; một code path dựng document) ở R4 AC5 · **P5** (đếm, không đoán) ở R4 AC3 · **P7** (optimistic concurrency) ở R5.

## Quality validation

- [x] Mỗi mục Phase 1 có requirement trace trực tiếp.
- [x] Happy path, conflict, crash/recovery và security error paths được nêu.
- [x] Data ownership, lifecycle, consistency, migration và audit được xác định ở mức requirement.
- [x] Acceptance criteria dùng EARS và có thể chuyển thành test/check cụ thể.
- [x] Phần ngoài phạm vi tách rõ Phase 2–6 để tránh scope creep.
- [x] Node SEA được giữ như constraint, không kéo packaging implementation vào Phase 1.
- [x] Mỗi requirement trace tới steering rule chi phối nó.
- [x] Không AC nào phụ thuộc capability thuộc phase sau (diagnostics đã tách kiểu dữ liệu khỏi bộ quy tắc).
- [x] Không phase nào migrate code mà bỏ lại lỗ bảo mật đã biết (allowlist đi cùng cutover route asset).
- [x] Stakeholder/user xác nhận Detailed Goals — duyệt ngày 2026-08-01.

## Approval Gate

> Không bắt đầu Detailed Design cho đến khi phần này được người dùng xác nhận rõ ràng.

- **Status**: **Approved**
- **Confirmed by**: Chủ dự án (alvin0)
- **Confirmation date**: 2026-08-01
- **Notes / required revisions before design**: Chờ phản hồi về phạm vi R1–R13, đặc biệt mốc “`src/` chỉ còn một server forward entry” và planning baseline story points.
- **Sửa đổi sau review ngày 2026-08-01**:
  - R1 AC1/AC1a — bổ sung package `worker`, chốt Phase 1 chạy worker in-process.
  - R2 AC2 — viết lại theo EARS hợp lệ (`BEFORE … THEN` không phải pattern EARS).
  - R5 AC2/AC3/AC3a/AC3b — tách **file mutation** (content hash) khỏi **entity mutation** (revision + merge theo section); thêm đường migrate version `mtime`+`size` → content hash.
  - R6 — đổi tiêu đề và thêm AC5–AC7 cho allowlist loại file; kéo allowlist vào phạm vi Phase 1.
  - R7 AC5/AC5a — tách kiểu dữ liệu `diagnostics` (Phase 1) khỏi bộ quy tắc sinh diagnostics (Phase 3).
  - R9 AC7/AC8 — thêm khả năng hoàn tác từng route đã cutover kèm kiểm chứng tương đương.
  - R11 AC10/AC11 — thêm WAL, single writer, và cấm đặt database trong workspace.
  - R13 — bỏ AC5 cũ (luật quy trình) sang `Assumptions và constraints`.
  - Bảng traceability — thêm cột steering rule chi phối.
