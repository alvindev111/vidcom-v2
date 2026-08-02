# Spec MCP Server — Detailed Goals

> **Reference**: [Main Spec File](./spec-mcp-server-complete.md)
> **Sửa lớn 2026-08-02** sau audit Detailed Design: AC 2.11 công bố recovery status, AC 5b.3–4e chuyển sang invariant "chứng minh nhất quán hoặc quarantine", AC 7.4b–4c bổ sung outcome indeterminate khi T2 lỗi, và threat boundary của approval được ghi rõ. Deep review checklist đã đồng bộ lại Data and Persistence Scope vốn còn sót câu “không có migration”; không đổi acceptance criteria đã duyệt. Trạng thái: Approved — reconfirmed 2026-08-02.

## Spec Goal

Cung cấp **bộ tool MCP của Phase 2** để một AI host bên ngoài (Codex, Claude Code) đọc và sửa project VidCom an toàn, không đụng filesystem trực tiếp. Mọi tool đi qua Application Core, chịu cùng invariant, cùng write authority và cùng audit như đường HTTP.

> Đây **không** phải "mọi khả năng của backend đều có đường vào cho AI". Render, TTS, snapshot, validate, registry, asset đều **chưa** có tool ở Phase 2 — xem §Phạm vi. Mục tiêu là dựng đúng bộ khung và bộ tool đầu tiên, để các giai đoạn sau chỉ việc thêm tool vào registry đã có.

---

## 1. Bối cảnh kiến trúc — thuật ngữ chuẩn

Sau spike Q10, kiến trúc **không còn** hai adapter theo era. Dùng đúng ba thuật ngữ sau, MUST NOT lẫn:

| Thuật ngữ | Nghĩa | Số lượng ở Phase 2 |
|---|---|---|
| **Transport vật lý** | Cách byte đi tới server | **Hai**: Streamable HTTP và stdio |
| **Protocol era** | Thế hệ giao thức MCP | **Hai**: legacy (≤ `2025-11-25`) và modern (`2026-07-28`) |
| **Transport adapter theo era** | Hai stack code song song | **Không còn** — đã bị spike Q10 loại bỏ |

`@modelcontextprotocol/server@2.0.0` **một mình** phục vụ cả hai era, trên cả hai transport vật lý:

```
AI host legacy  (sdk 1.x, ≤ 2025-11-25) ──┐
                                          ├──▶ @modelcontextprotocol/server@2.x
AI host modern  (2026-07-28) ─────────────┘      createMcpHandler  (HTTP)
                                                 serveStdio        (stdio)
                                                         │
                                                  factory({ era })
                                                         │
                                                         ▼
                                            Tool Registry (protocol-agnostic)
                                                         │
                                                         ▼
                                              Application Core
```

| Runtime dependency | Vai trò |
|---|---|
| `@modelcontextprotocol/server@2.x` + `core@2.x` | **Runtime** — phục vụ cả hai era |
| `@modelcontextprotocol/sdk@1.x` | **devDependency** — chỉ làm client legacy trong contract test |
| `@modelcontextprotocol/client@2.x` | **devDependency** — chỉ làm client modern trong contract test |

Bằng chứng và lệnh tái hiện: [spikes/phase-0 §Q10](../../../../spikes/phase-0/README.md). Luật thường trực: [steering 13](../../../steering/13-mcp-protocol-compatibility.md).

---

## 2. Nền tảng Phase 1 — cái gì dùng được, cái gì phải nâng cấp

### 2.1 Dùng được ngay

| Có sẵn | Dùng cho |
|---|---|
| Use case đọc: `listProjects`, `getStudioSnapshot`, `getProjectPreview`, `readSourceFile`, `readAsset`, `getPreviewSettings`, `resolveProjectIdBySlug` | tool đọc |
| `WriteAuthority.mutate()` cho **một** file hoặc **một** entity, có precondition, trả `revision` + `diagnostics` | tool ghi đơn giản |
| `saveSourceFile`, `patchPreviewSettings`, `setSceneTiming` | `save_file`, `set_scene_timing` |
| `ErrorCode` enum trong `packages/contracts` | mã lỗi dùng chung HTTP ↔ MCP |
| `Actor` đã có giá trị `"agent"` | phân biệt agent trong audit |
| `audit_entry` đã có cột `protocol_version`, `revision_id`, `action`, `outcome`, `error_code`, `detail` | audit tool call — **không cần migration** |
| Audit row được ghi **trong cùng transaction** với mutation (`journal.commit()`) | audit atomic cho tool ghi |
| `JobStorePort` + `JobScheduler` | tool job (Phase 3) |
| Composition root với pattern injection | mount MCP handler |

### 2.2 Khoảng trống phải lấp — **nằm trong phạm vi Phase 2**

Review phát hiện Detailed Goals bản trước đánh giá quá cao Phase 1. Ba khoảng trống dưới đây **chặn** Requirement 5 và 6b:

| # | Khoảng trống | Bằng chứng | Hệ quả |
|---|---|---|---|
| **G1** | `WriteAuthority.mutate()` chỉ nhận **một** file **hoặc** một entity mỗi lần — `MutationRequest` là union hai nhánh đơn | [write-authority.ts:20](../../../../packages/core/src/service/write-authority.ts#L20) | Không thể ghi nhiều file trong một revision. Chặn `createScene` atomic và chặn toàn bộ `deleteScene` |
| **G2** | `createScene` thực hiện **ba** lần ghi rời: file scene → `index.html` → narration. Output là `{ sceneId, start, duration, narration }`, **không có** `revision`, **không có** `diagnostics` | [project-writes.ts:240](../../../../packages/core/src/usecase/project-writes.ts#L240) | Crash giữa chừng để lại project nửa vời. Vi phạm AC 5.4 và 5.5 |
| **G3** | `setSceneScript` chỉ ghi source, **không** đánh dấu narration stale | [project-writes.ts:153](../../../../packages/core/src/usecase/project-writes.ts#L153) | Vi phạm AC 5.7 |

→ Phạm vi Phase 2 **bao gồm nâng cấp Core**, không chỉ thêm `deleteScene`. Xem Requirement 5b.

---

## Data and Persistence Scope

- **Persisted data involved**: `audit_entry`, `mutation_journal`, `mutation_step`, `revision`, `revision_step`, `revision_blob`, `entity_state`, `event_outbox`, `approval_grant`, `mcp_credential`, `backup_manifest`; file composition/asset trong workspace và payload backup trong app-data.
- **Data ownership**: audit, journal, revision, backup thuộc **application-data**; composition và asset thuộc **workspace của người dùng**. Ranh giới chốt ở [steering 07](../../../steering/07-data-and-storage.md) §1–2, spec này MUST NOT làm nhoè.
- **Lifecycle**: audit chỉ ghi thêm. Grant có expiry/terminal cleanup; credential có issue/rotate/revoke; backup payload có retention hữu hạn nhưng manifest metadata được giữ cho audit/history (xem AC 6b.9, R6 và R6d).
- **Consistency requirements**: mọi tool ghi bắt buộc precondition. **Một tool ghi = một revision**, kể cả khi nó chạm nhiều file (G1/G2).
- **Query and reporting needs**: truy vấn audit theo `projectId`, `action`, `createdAt` — index đã có.
- **Volume and growth assumptions**: một phiên agent tạo hàng chục đến hàng trăm tool call. Audit tăng tuyến tính; retention chưa làm ở Phase 2, ghi nhận là nợ.
- **Migration/backfill expectations**: có một migration Phase 2: tạo **5 bảng mới** (`mutation_step`, `revision_step`, `approval_grant`, `mcp_credential`, `backup_manifest`) và rebuild **2 bảng hiện hữu** (`revision`, `mutation_journal`) để mở rộng check constraint/context. Backfill đúng một `mutation_step` cho mỗi legacy journal unresolved `pending`/`orphaned`; row terminal không backfill. `audit_entry.protocol_version` đã tồn tại nên không sửa bảng audit.
- **Audit and compliance needs**: xem Requirement 7.

---

## Requirements

### Requirement 1 — Tool Registry protocol-agnostic

**User Story:** Là maintainer, tôi muốn định nghĩa mỗi tool đúng một lần, để hai transport vật lý và hai era không làm phát sinh nhiều bản định nghĩa.

#### Acceptance Criteria
1. WHEN một tool được khai báo THEN registry SHALL lưu tên, mức quyền, input schema, output schema, mô tả và handler ở **một** chỗ duy nhất.
2. WHEN transport HTTP hoặc stdio phục vụ một tool THEN nó SHALL đọc định nghĩa từ registry, và MUST NOT chứa bản sao của schema hay handler.
3. IF một định nghĩa tool tham chiếu kiểu dữ liệu của bất kỳ MCP SDK nào THEN CI SHALL fail — registry chỉ dùng kiểu từ `packages/contracts`.
4. WHEN handler của tool chạy THEN nó SHALL gọi use case của `packages/core`, và MUST NOT gọi HTTP của `packages/server`.
5. WHEN `tools/list` được gọi nhiều lần với cùng trạng thái THEN thứ tự tool SHALL giống nhau từng lần.
6. WHEN một tool bị gọi ở era legacy mà nó không degrade được THEN nó SHALL bị ẩn khỏi `tools/list` của era đó, và MUST NOT xuất hiện rồi lỗi lúc gọi.

### Requirement 2 — Bộ tool đọc

**User Story:** Là người dùng, tôi muốn agent đọc được cấu trúc project trước khi sửa, để nó không đoán scene id, timing hay content hash.

#### Acceptance Criteria
1. WHEN agent gọi `list_projects` THEN system SHALL trả danh sách project trong workspace đang mở kèm `projectId`, tiêu đề, kích thước và thời lượng.
2. WHEN agent gọi `get_project_context` với `projectId` hợp lệ THEN system SHALL trả scene, timing, `revision` hiện tại, `diagnostics`, **và `contentHash` của mọi file composition liên quan** — không chỉ file entry.
3. WHEN agent nhận kết quả `get_project_context` với `recovery.writeStatus = "ready"` THEN nó SHALL có đủ dữ kiện để gọi **bất kỳ** tool ghi nào ngay sau đó mà không cần gọi thêm tool đọc.
4. WHEN agent gọi `list_scenes` THEN system SHALL trả từng scene kèm `id`, `src`, `start`, `duration`, `trackIndex`, `isTransition`, số phần tử con và `contentHash` của file chứa nó.
5. WHEN agent gọi `read_composition` THEN system SHALL trả nội dung file kèm `contentHash` để dùng làm precondition cho lần ghi sau.
6. IF `projectId` không tồn tại THEN system SHALL trả `project_not_found`.
7. IF đường dẫn nằm ngoài project THEN system SHALL trả `path_outside_project` và MUST NOT đọc file.
8. IF file được yêu cầu không thuộc allowlist loại file composition/text THEN system SHALL trả `asset_not_allowed` và MUST NOT trả nội dung.
9. IF file vượt giới hạn kích thước đọc THEN system SHALL trả `too_large` và MUST NOT trả nội dung một phần.
10. WHEN tool đọc trả về THEN nó MUST NOT chứa đường dẫn tuyệt đối của máy người dùng.
11. WHEN project có journal `pending` hoặc `orphaned` chưa resolve THEN mọi read result chứa project đó SHALL vẫn cho phép chẩn đoán nhưng MUST trả `writeStatus = "recovery_required"` và định danh journal unresolved; nó MUST NOT trình bày project như đang healthy hoặc cho agent dùng kết quả đó để write tiếp.

> AC 2.2 và 2.4 tồn tại vì `StudioSnapshot` hiện chỉ có `entryFile.contentHash` ([project-reads.ts:150](../../../../packages/core/src/usecase/project-reads.ts#L150)). Không có hash từng sub-composition thì AC 2.3 không thể đúng.

### Requirement 3 — Phục vụ era modern `2026-07-28`

**User Story:** Là AI host đời mới, tôi muốn VidCom nói đúng `2026-07-28`, để tôi dùng được `server/discover`, caching và MRTR thay vì bản degrade.

> Phần lớn hành vi dưới đây do `@modelcontextprotocol/server@2.x` cung cấp. Các AC này là **điều phải kiểm chứng bằng test**, không phải code phải tự viết. MUST NOT tự implement lại (steering 13 §4 M5, M6).

#### Acceptance Criteria
1. WHEN host modern gọi `server/discover` THEN system SHALL trả capabilities, identity và `supportedVersions`.
2. WHEN `server/discover` trả `supportedVersions` THEN nó SHALL chỉ liệt kê **revision modern** — đó là hành vi của SDK và của spec, vì `server/discover` là method modern-only. Danh sách revision **legacy** SHALL được công bố ở tài liệu và ở thông báo lỗi `UnsupportedProtocolVersion`, MUST NOT kỳ vọng nó xuất hiện trong `server/discover`.
3. WHEN system trả bất kỳ result nào cho host modern THEN result SHALL có `resultType` là `"complete"` hoặc `"input_required"`.
4. WHEN system trả `tools/list` cho host modern THEN result SHALL có `ttlMs` và `cacheScope`, và `cacheScope` SHALL là `"private"`.
5. WHEN host gửi request thiếu hoặc lệch header `Mcp-Method` / `Mcp-Name` trên Streamable HTTP THEN system SHALL trả `-32020` HeaderMismatch.
6. IF host yêu cầu một protocol revision system không hỗ trợ THEN system SHALL trả `-32022` UnsupportedProtocolVersion **kèm danh sách revision hỗ trợ**, gồm cả legacy lẫn modern.

### Requirement 4 — Phục vụ era legacy và negotiation

**User Story:** Là người dùng Claude Code, tôi muốn VidCom hoạt động với host của tôi hôm nay, không phải chờ host nâng cấp.

> Claude Code `2.1.207` **chỉ nói legacy** (`LATEST = 2025-11-25`, 0 lần xuất hiện `2026-07-28` trong binary). Legacy là đường **duy nhất** chạy được với nó → làm trước, kiểm chứng trước.

#### Acceptance Criteria
1. WHEN host legacy thực hiện `initialize` THEN system SHALL bắt tay thành công với revision nằm trong tập hỗ trợ.
2. WHEN request không mang protocol version THEN system SHALL mặc định `2025-03-26`.
3. WHEN system phục vụ host legacy THEN result MUST NOT chứa `resultType`, `ttlMs` hay `cacheScope`.
4. WHEN lỗi resource-not-found xảy ra THEN system SHALL trả `-32002` cho host legacy và `-32602` cho host modern.
5. WHEN cùng một process phục vụ đồng thời host legacy và host modern THEN cả hai SHALL dùng **cùng một Tool Registry** và **cùng một factory**, và MUST NOT tồn tại hai stack code theo era.
6. WHEN `legacy: 'stateless'` đang bật trên HTTP THEN `GET` và `DELETE` SHALL trả `405`, và tài liệu cho host SHALL nêu rõ giới hạn này.

### Requirement 5 — Tool ghi với precondition bắt buộc

**User Story:** Là người dùng, tôi muốn agent sửa được project nhưng không bao giờ ghi đè im lặng lên thay đổi của tôi hoặc của công cụ khác.

#### Acceptance Criteria
1. WHEN agent gọi một tool ghi THEN input SHALL bắt buộc có `expectedRevision` (entity) hoặc `expectedContentHash` (file).
2. IF tool ghi thiếu precondition THEN system SHALL trả `precondition_required` và MUST NOT ghi.
3. IF precondition lệch với trạng thái hiện tại THEN system SHALL trả `write_conflict` và MUST NOT ghi.
4. WHEN tool ghi thành công THEN output SHALL chứa **entity đã cập nhật**, `revision` mới và `diagnostics`, và MUST NOT chỉ là `{ ok: true }`.
5. WHEN một tool ghi chạm nhiều file THEN toàn bộ SHALL nằm trong **một** mutation, sinh **một** revision, và MUST NOT để lại trạng thái nửa vời khi crash giữa chừng.
6. WHEN agent gọi `set_scene_timing` với timing vi phạm invariant THEN system SHALL trả `timing_invalid` hoặc `duration_overflow` và MUST NOT ghi.
7. WHEN một tool ghi thay đổi script của scene THEN system SHALL đánh dấu narration của scene đó là **stale**, và output SHALL báo điều đó.
8. IF nội dung gửi cho `save_file` vượt giới hạn kích thước THEN system SHALL trả `too_large` và MUST NOT ghi.
9. IF `save_file` nhắm tới đường dẫn ngoài allowlist loại file cho phép ghi THEN system SHALL trả `asset_not_allowed` và MUST NOT ghi.

### Requirement 5b — Nâng cấp Core để AC 5.4, 5.5 và 5.7 khả thi

**User Story:** Là kỹ sư, tôi muốn write authority hỗ trợ mutation nhiều file, để "một thao tác = một revision" là sự thật chứ không phải lời hứa.

> Đây là **công việc Core nằm trong Phase 2**, phát sinh từ G1–G3 ở §2.2.

#### Acceptance Criteria
1. WHEN `WriteAuthority` nhận một yêu cầu ghi **composite** THEN nó SHALL chấp nhận nhiều thao tác file cộng tuỳ chọn một thao tác entity trong **một** lời gọi.
2. WHEN một mutation composite commit THEN nó SHALL sinh **đúng một** revision và **đúng một** audit row cho tool đã gây ra nó.
3. IF một step thất bại trước khi toàn bộ step được ghi THEN system SHALL rollback các step đã landed theo thứ tự ngược và verify từng target. IF verification chứng minh mọi target đã về `fromHash` (hoặc không tồn tại khi `fromHash = null`) THEN mutation SHALL được đánh dấu `aborted`; IF rollback hoặc verification không thành công THEN mutation SHALL chuyển `orphaned`, approval grant liên quan SHALL bị invalidated, project SHALL bị chặn write và system SHALL trả `recovery_required`.
4. IF tiến trình dừng sau khi journal T1 đã commit nhưng trước transaction kết thúc T2 THEN recovery SHALL phân loại từng step bằng trạng thái filesystem thực tế và SHALL chỉ tiếp tục write bình thường khi đã chứng minh project ở trạng thái hoàn toàn trước hoặc hoàn toàn sau mutation. Trạng thái chưa chứng minh được SHALL bị quarantine bằng project write gate, không được công bố nhầm là rollback/commit thành công.
4b. WHEN recovery phát hiện **mọi** step đã ghi xong trên đĩa THEN nó SHALL **hoàn tất** mutation (roll forward): commit revision và audit, giữ nguyên đĩa. Đây là hành vi của cơ chế journal Phase 1 và MUST NOT bị đổi.
4c. WHEN recovery phát hiện **không step nào** đã landed THEN nó SHALL abort mutation và giữ nguyên đĩa; WHEN phát hiện **một phần** step đã landed THEN nó SHALL hoàn tác các step đó theo thứ tự ngược và chỉ đánh dấu `rolled_back` sau khi verify toàn bộ trạng thái trước mutation.
4d. IF recovery không phân loại được trạng thái của một step THEN nó SHALL **không thực hiện thêm filesystem write**, đánh dấu mutation là `orphaned`, invalidate grant liên quan, chặn mọi write tiếp theo của project và trả hướng dẫn recovery tường minh.
4e. IF rollback hoặc verification thất bại THEN system SHALL dừng mọi rollback tự động còn lại, giữ journal `orphaned`, giữ project write gate và MUST NOT tái phát hành grant đã dùng cho destructive attempt đó.

   > **Sửa 2026-08-02 sau review Detailed Design — đã được tái xác nhận cùng AC 2.11 và AC 7.4b–4c.**
   > Bản duyệt trước nói "đưa project về trạng thái trước mutation" cho **mọi** ca crash. Điều đó **mâu thuẫn với hệ thống đang chạy**: `reconcilePendingMutations` hiện roll **forward** khi file trên đĩa đã mang `toHash` ([reconcile-pending-mutations.ts:44](../../../../packages/core/src/usecase/reconcile-pending-mutations.ts#L44)). Bắt composite luôn rollback sẽ đổi hành vi của `mutate()` một step và phá bộ test Phase 1.
   > Ngoài ra roll-forward là hành vi **đúng** ở ca all-landed: người dùng yêu cầu thao tác đó, nó đã hoàn tất trên đĩa, chỉ còn thiếu sổ sách. Hoàn tác nó là huỷ việc đã thành công.
   > Điều bất biến thật sự cần giữ là: **không cho phép write tiếp khi trạng thái chưa được chứng minh nhất quán**. AC 3–4e nêu đầy đủ failure, crash, roll-forward, rollback và quarantine; nó không hứa điều bất khả thi rằng rollback luôn thành công khi storage đang lỗi.
5. WHEN `createScene` chạy THEN nó SHALL dùng mutation composite, và output SHALL chứa `revision` và `diagnostics`.
6. WHEN `setSceneScript` chạy thành công THEN narration của scene tương ứng SHALL được đánh dấu stale trong cùng mutation.
7. WHEN narration bị đánh dấu stale THEN system MUST NOT tự động chạy lại TTS — đó là hành vi Phase 3 (`NT-13`).

### Requirement 6 — Thao tác destructive cần xác nhận có thể kiểm chứng

**User Story:** Là người dùng, tôi muốn agent không xoá được thứ gì nếu **tôi** chưa đồng ý — không phải nếu *agent tự nói* là tôi đã đồng ý.

> **Sửa sau review.** Bản trước dựa vào `confirm: true` (legacy) và MRTR (modern). Cả hai chỉ chứng minh **client gửi phản hồi**, không chứng minh **con người đã duyệt** — một agent tự đặt `confirm: true` là hợp lệ về mặt giao thức. Phase 2 dùng **approval grant** do daemon phát hành; agent không tự tạo được.
>
> **Threat model**: guarantee này áp cho client bị giới hạn trong MCP surface. Một process có quyền shell/filesystem ngang user OS có thể gọi local-admin CLI hoặc sửa workspace trực tiếp và nằm ngoài security boundary của MCP; `vidcom approve` được xem là trusted local-admin channel. Phase 2 cung cấp guardrail chống destructive call vô tình/replay, không tuyên bố chống một agent đã có toàn quyền OS. Nếu cần proof-of-human-presence mạnh hơn thì phải dùng UI/OS-mediated approval trong spec riêng.

#### Acceptance Criteria
1. WHEN agent gọi một tool mức `destructive` mà không kèm approval grant hợp lệ THEN system SHALL từ chối với `approval_required`, và MUST NOT thực hiện.
2. WHEN approval grant được phát hành THEN nó SHALL do **daemon** tạo, sau một hành động của con người: bấm xác nhận trong UI, hoặc chạy lệnh CLI `vidcom approve` tường minh.
3. WHEN approval grant được tạo THEN nó SHALL bind với **tên tool + `projectId` + định danh đối tượng + `expectedRevision`**, và system SHALL từ chối nếu bất kỳ thành phần nào lệch lúc dùng.
4. WHEN approval grant được dùng một lần THEN nó SHALL trở nên vô hiệu — chống replay.
5. WHEN approval grant quá hạn THEN system SHALL từ chối với `approval_expired`; thời hạn SHALL ngắn và cấu hình được.
6. WHEN host là modern THEN system SHALL dùng **MRTR** để dẫn người dùng tới bước lấy grant: trả `InputRequiredResult` mô tả rõ thứ sắp bị xoá và cách duyệt. MRTR là **kênh dẫn**, không phải bằng chứng duyệt.
7. WHEN host là legacy THEN system SHALL trả `approval_required` kèm hướng dẫn lấy grant. MUST NOT chấp nhận một cờ `confirm` do agent tự đặt.
8. WHEN quyết định "có được xoá không" được đưa ra THEN nó SHALL nằm trong Core; transport chỉ dịch sang cơ chế của era tương ứng.
9. IF `expectedRevision` lệch tại thời điểm dùng grant THEN system SHALL trả `write_conflict` và MUST NOT xoá.

### Requirement 6b — Use case `deleteScene` trong Core

**User Story:** Là người dùng, tôi muốn xoá một scene mà project vẫn hợp lệ sau đó, để tôi không phải tự dọn phần thừa.

#### Acceptance Criteria
1. WHEN `deleteScene` chạy thành công THEN system SHALL gỡ phần tử mount khỏi `index.html`.
2. WHEN scene bị xoá có `data-composition-src` **và không mount nào khác trỏ tới cùng file đó** THEN system SHALL xoá file sub-composition.
3. IF nhiều mount dùng chung một `data-composition-src` THEN system SHALL gỡ **chỉ** mount được yêu cầu và **giữ** file, và output SHALL nêu rõ file được giữ lại vì còn tham chiếu.
4. IF scene là **inline** (không có `data-composition-src`) THEN system SHALL gỡ phần tử host cùng toàn bộ subtree của nó, và không có file nào bị xoá.
5. WHEN scene bị xoá là scene kết thúc muộn nhất THEN system SHALL đặt `data-duration` của root bằng điểm kết thúc muộn nhất trong các scene còn lại.
6. IF scene bị xoá là scene **cuối cùng còn lại** THEN system SHALL đặt root duration về **0** và SHALL phát một diagnostic mức `warning` báo composition đang rỗng. MUST NOT xoá root host.
   > Chốt 2026-08-01: invariant `duration > 0` chỉ áp cho **scene clip**, không áp cho root duration — root là giá trị dẫn xuất. [steering 03](../../../steering/03-architecture-ddd.md) §2.1 đã được làm rõ tương ứng.
7. WHEN scene bị xoá có narration THEN system SHALL xoá **cả** sidecar JSON **và** file audio `.wav` nếu tồn tại.
8. WHEN scene bị xoá có mục trong `preview-settings.json` (`scenes[sceneId]`) THEN system SHALL gỡ mục đó.
9. WHEN thao tác xoá bắt đầu THEN system SHALL tạo backup mọi file sắp bị xoá hoặc sửa, đặt trong `<app-data>`, có định danh gắn với `revision`, có retention hữu hạn cấu hình được, và **có đường restore tường minh** được ghi vào audit.
10. WHEN `deleteScene` chạy THEN toàn bộ thay đổi trên SHALL nằm trong **một** mutation composite (Requirement 5b) — một revision, một audit row.
11. IF `sceneId` không tồn tại THEN system SHALL trả `scene_not_found` và MUST NOT ghi.
12. WHEN `deleteScene` thành công THEN output SHALL chứa project đã cập nhật, `revision` mới và `diagnostics`.

### Requirement 6c — Endpoint MCP định địa chỉ theo protocol revision

**User Story:** Là kỹ sư và là AI host, tôi muốn pin được một revision qua URL, để debug và cấu hình không phụ thuộc vào việc đoán từ header.

> Sau spike Q10, endpoint theo revision **không còn** để chọn implementation — SDK tự phân loại era. Nó tồn tại để **pin, test và debug**.

#### Sơ đồ đường dẫn

```
/api/mcp                    ← entry point chuẩn, SDK tự phân loại era
/api/mcp/2026-07-28         ← pin modern
/api/mcp/2025-11-25         ← pin legacy
/api/mcp/2025-06-18
/api/mcp/2025-03-26         ← cũng là mặc định khi client không nêu version
/api/mcp/2024-11-05
/api/mcp/2024-10-07
/api/mcp/latest             ← alias tới revision mới nhất hỗ trợ
```

#### Acceptance Criteria
1. WHEN request tới `/api/mcp` THEN system SHALL để SDK phân loại era in-band và phục vụ tương ứng.
2. WHEN request tới `/api/mcp/<revision>` với revision được hỗ trợ THEN system SHALL ép era tương ứng, và SHALL từ chối nếu hình dạng wire không khớp revision được pin.
3. WHEN request tới `/api/mcp/<revision>` với revision **không** được hỗ trợ THEN system SHALL trả `UnsupportedProtocolVersion` kèm danh sách revision hỗ trợ, và MUST NOT rơi về revision khác.
4. WHEN `/api/mcp/latest` được gọi THEN system SHALL phục vụ bằng revision mới nhất đang hỗ trợ, và tài liệu SHALL nêu rõ đây là **moving target**.
5. WHEN endpoint MCP HTTP nhận request THEN nó SHALL đi qua cùng perimeter Phase 1: chỉ loopback, kiểm `Host`, từ chối cross-origin mặc định.
6. WHEN cùng một tool được gọi qua `/api/mcp`, qua `/api/mcp/<revision>` và qua stdio THEN kết quả SHALL giống nhau, vì cả ba dùng chung Tool Registry.
7. WHEN chạy stdio THEN pin revision SHALL qua cờ `--protocol <revision>`; không có cờ thì để SDK phân loại.
8. WHEN danh sách revision hỗ trợ thay đổi THEN nó SHALL đến từ **một** hằng số trong `packages/contracts`, và route, thông báo lỗi cùng test SHALL đọc từ đó.
9. WHEN handler MCP được mount vào Hono THEN nó SHALL đi qua injection trong `ServerAppDependencies`; `packages/mcp` MUST NOT import `packages/server` và ngược lại.

#### Vì sao không đặt dưới `/api/v1/`

`/api/v1/` là version của **HTTP API do ta định nghĩa**; revision MCP do spec MCP định nghĩa và đổi theo nhịp riêng. Lồng hai trục version tạo hai từ vựng cho cùng một thứ. MCP mount ngang cấp: `/api/mcp/<revision>`. MUST NOT đặt tên `/api/mcp/v1`, `/api/mcp/v2`.

### Requirement 6d — Credential cho AI host qua HTTP

**User Story:** Là người dùng, tôi muốn chỉ AI host tôi cho phép mới gọi được MCP của tôi, và tôi thu hồi được quyền đó khi cần.

> Chốt: xử lý trong **MCP Bridge**, tách khỏi session cookie của UI. Bản trước dừng ở đó — chưa đủ. Vòng đời credential phải được định nghĩa.

#### Acceptance Criteria
1. WHEN AI host gọi endpoint MCP HTTP THEN nó SHALL phải xác thực; system MUST NOT phục vụ tool call không xác thực, kể cả từ loopback.
2. WHEN credential được cấp THEN nó SHALL do người dùng chủ động phát hành qua UI hoặc lệnh CLI tường minh, và MUST NOT được tạo ngầm khi có request lạ.
3. WHEN credential được lưu THEN nó SHALL nằm trong `<app-data>` với quyền `0600` (Windows: ACL tương đương), và MUST NOT nằm trong workspace, log hay URL.
4. WHEN người dùng yêu cầu thu hồi THEN system SHALL vô hiệu credential ngay, và request tiếp theo dùng nó SHALL bị từ chối.
5. WHEN người dùng yêu cầu xoay vòng THEN system SHALL cấp credential mới và vô hiệu cái cũ, có khoảng chồng lấn cấu hình được để host kịp cập nhật.
6. WHEN credential được dùng THEN audit SHALL ghi định danh credential, MUST NOT ghi giá trị bí mật.
7. WHEN stdio được dùng THEN credential HTTP MUST NOT bắt buộc — quyền truy cập đã do việc spawn subprocess quyết định.

### Requirement 7 — Audit mọi tool call

**User Story:** Là người dùng, tôi muốn xem lại agent đã làm gì trên project của mình, để tôi tin tưởng được khi để nó chạy lúc tôi không nhìn.

> **Sửa sau review.** Bảng `audit_entry` **đã có** cột `protocol_version` ([schema.ts:147](../../../../packages/adapter/src/db/schema.ts#L147)) — không cần thêm cột, không cần migration. Bản trước nói ngược lại là sai.

#### Quan hệ giữa audit tool và audit mutation

Hiện `journal.commit()` ghi một audit row với `action` là `"file.write"` hoặc `"entity.patch"` — đó là bản ghi **kết quả**. Phase 2 thêm bản ghi **nguyên nhân**:

| Loại row | `action` | `revision_id` | Khi nào |
|---|---|---|---|
| Tool call | `tool:<tên tool>` | revision do tool sinh, hoặc `NULL` với tool đọc | mọi tool call |
| Mutation | `file.write` / `entity.patch` | revision tương ứng | khi có ghi (đã có sẵn) |

Đây là **thêm row**, không thay thế và không sửa row mutation. Sau khi `createScene` chuyển sang mutation composite (Requirement 5b), một tool ghi sinh đúng một row mỗi loại.

#### Acceptance Criteria
1. WHEN bất kỳ tool nào được gọi THEN system SHALL áp dụng audit policy cho tool call đó: terminal write SHALL có đúng một durable audit row; tool đọc, rejection trước T1 hoặc failure đã rollback SHALL thử ghi audit và chỉ được thiếu row khi audit store lỗi đã được escalation theo AC 4b/5.
2. WHEN audit row được tạo THEN nó SHALL chứa: thời điểm, `action = "tool:<tên>"`, actor `agent`, `projectId` (nếu có), `outcome` ok/error, `error_code` khi lỗi, và **`protocol_version`** đã negotiate — dùng **cột `protocol_version` đã có sẵn**.
3. WHEN tool ghi thành công THEN audit row của tool SHALL có `revision_id` trỏ tới revision mà nó sinh ra.
4. WHEN tool **ghi terminal-success** THEN audit row của nó SHALL được ghi **trong cùng T2** với revision/grant/journal commit — **fail-closed**: audit hỏng thì T2 không commit; nếu filesystem đã all-landed, tool SHALL trả `recovery_required` và AC 7.4c áp dụng thay vì tuyên bố success hoặc error cuối cùng.
4b. WHEN tool ghi bị từ chối **trước T1** (validation, grant hoặc precondition), hoặc step failure đã rollback + verify thành công THEN audit lỗi là **best-effort có leo thang**: thử lại một lần, thất bại thì log mức `error` và tăng metric. MUST NOT biến lỗi ghi audit thành lỗi trả về người dùng ở nhánh này.
   > Ở các nhánh này system đã chứng minh không còn thay đổi trên đĩa, nên mất audit là lỗ hổng quan sát, không phải lỗ hổng an toàn.
4c. IF filesystem đã all-landed nhưng T2 chưa commit THEN outcome SHALL là **indeterminate**, journal và audit context SHALL còn durable, project SHALL bị chặn write, và recovery SHALL quyết định outcome cuối. System MUST NOT ghi một audit lỗi best-effort rồi bỏ journal, vì recovery có thể roll forward mutation thành công.
5. WHEN tool **đọc** chạy THEN audit là **fail-open**: nếu ghi audit thất bại, tool vẫn trả kết quả, nhưng system SHALL log sự cố ở mức cảnh báo.
6. WHEN audit row được tạo THEN `detail` SHALL được redact theo policy, và MUST NOT chứa token, credential hay nội dung file thô.
7. WHEN audit được ghi THEN nó SHALL nằm trong `<app-data>`, và MUST NOT ghi vào workspace của người dùng.
8. WHEN thao tác destructive chạy THEN audit SHALL ghi định danh backup và đường restore.

> AC 7.4 và 7.5 là lời giải cho mâu thuẫn mà review chỉ ra. Chúng khác nhau vì tool ghi **có** transaction để bám vào, tool đọc thì không.

### Requirement 8 — `vidcom mcp` chạy được như AI host mong đợi

**User Story:** Là AI host, tôi muốn spawn `vidcom mcp` như một subprocess stdio và bắt tay thành công ngay.

#### Acceptance Criteria
1. WHEN `vidcom mcp` chạy ở chế độ stdio THEN `stdout` SHALL chỉ chứa MCP protocol message.
2. WHEN system cần log THEN log SHALL đi ra `stderr` hoặc log store, và MUST NOT đi ra `stdout`.
3. WHEN `vidcom mcp --workspace <path>` chạy với đường dẫn hợp lệ THEN system SHALL dùng workspace đó.
4. IF không xác định được workspace THEN system SHALL trả lỗi có hướng dẫn rõ ràng, và MUST NOT tự tạo hay đoán thư mục.
5. WHEN process nhận tín hiệu dừng THEN nó SHALL đóng sạch, giải phóng lease nếu đang giữ.

### Requirement 9 — Bộ test khoá contract cho cả hai era

**User Story:** Là maintainer, tôi muốn CI chặn mọi thay đổi làm vỡ contract với AI host, vì host bên ngoài không nâng cấp cùng nhịp với ta.

#### Acceptance Criteria
1. WHEN contract test chạy THEN chúng SHALL chạy **hai lần**, một lần cho mỗi era, dùng `sdk@1.x` làm client legacy và `client@2.x` làm client modern.
2. WHEN contract test chạy THEN chúng SHALL phủ **cả hai transport vật lý**: HTTP và stdio.
3. WHEN `tools/list` đổi THEN golden file của **cả hai** era SHALL fail cho tới khi được cập nhật có chủ đích.
4. WHEN test chạy THEN chúng SHALL kiểm: thiếu precondition → `precondition_required`; destructive thiếu grant → `approval_required`; grant dùng lại → từ chối; grant hết hạn → `approval_expired`; revision lạ → `-32022` kèm danh sách; thiếu version header → mặc định `2025-03-26`; result modern có `resultType` còn legacy thì không.
5. WHEN test đường ghi chạy THEN chúng SHALL dùng **SQLite và filesystem thật** trong thư mục tạm, và MUST NOT mock `node:fs`.
6. WHEN test mutation composite chạy THEN nó SHALL phủ: none-landed → abort; all-landed → roll forward; mixed → rollback + verify; unknown hoặc rollback failure → orphaned + project write gate; T2 failure sau all-landed → durable pending rồi recovery commit đúng grant và audit.
7. WHEN CI chạy THEN nó SHALL fail nếu có tool trong registry chưa có contract test.
8. WHEN nâng version SDK THEN test SHALL đối chiếu tập revision mà `contracts` công bố với tập SDK thực sự hỗ trợ.

---

## Phạm vi

### Trong phạm vi

| | Nội dung | Build order |
|---|---|---|
| ✅ | Tool Registry protocol-agnostic | 2.1 |
| ✅ | Tool đọc: `list_projects`, `get_project_context`, `read_composition`, `list_scenes` | 2.2 |
| ✅ | Phục vụ era modern qua `createMcpHandler` / `serveStdio` | 2.3 |
| ✅ | Phục vụ era legacy qua cùng handler + negotiation + map error code | 2.4 |
| ✅ | Tool ghi: `create_scene`, `set_scene_timing`, `set_text`, `save_file` | 2.5 |
| ✅ | **Nâng cấp Core: mutation composite, `createScene` atomic, narration stale** (G1–G3) | 2.5 mở rộng |
| ✅ | Tool destructive + approval grant + backup + `deleteScene` | 2.6 |
| ✅ | Audit tool call, dùng cột `protocol_version` sẵn có | 2.7 |
| ✅ | Contract test hai era × hai transport | 2.8 |
| ✅ | `vidcom mcp` mode, `stdout` sạch | 2.9 |
| ✅ | Transport HTTP, endpoint theo revision, credential cho AI host | 2.10 |

### Ngoài phạm vi

| Nội dung | Vì sao | Sẽ làm ở |
|---|---|---|
| `validate_project` / diagnostics endpoint đầy đủ | Core chưa có use case validate độc lập | Giai đoạn 3 (VD-1, VD-2) |
| `start_render`, `start_snapshot`, `start_tts` | Core chưa có job type nào cho render/TTS/snapshot | Giai đoạn 3 |
| Tasks extension `io.modelcontextprotocol/tasks` | SDK có schema, không có task manager; và chưa có job thật để map | Giai đoạn 3 |
| Chạy lại TTS khi narration stale | Chỉ đánh dấu ở Phase 2 | Giai đoạn 3 (NT-13) |
| `AGENTS.md` + skill ship cho agent | Cần tool set ổn định trước | Giai đoạn 4 (AK-1..AK-8) |
| MCP prompts | Chưa cần để đóng vòng lặp Phase 2 | Giai đoạn 4 (AK-7) |
| `add_block`, `upload_asset`, `reorder_scenes`, `duplicate_scene` | Core chưa có use case tương ứng | Giai đoạn 3 và 5 |
| OpenTelemetry trace context | Ưu tiên thấp | Sau |
| Retention/dọn dẹp audit | Nợ đã ghi nhận | Sau |
| AI Composer trong app chạy thật | Hạng mục riêng; MCP server **không** tự làm nó chạy | Giai đoạn 6 |

---

## Quyết định đã chốt

| # | Câu hỏi | Quyết định | Ngày |
|---|---|---|---|
| Q1 | `deleteScene` chưa có trong Core | **Phương án A** — thêm vào Phase 2; gỡ `SC-1` khỏi build order 3.7 | 2026-08-01 |
| Q5 | Transport nào | **Cả stdio lẫn Streamable HTTP** | 2026-08-01 |
| Q8 | Mount endpoint MCP ở đâu | **Injection qua `ServerAppDependencies`** — giữ nguyên cả hai lệnh cấm import | 2026-08-01 |
| Q9 | Có `/api/mcp/latest` không | **Có**, kèm cảnh báo moving target | 2026-08-01 |
| Q7 | Auth cho AI host | **MCP Bridge**, vòng đời credential định nghĩa ở Requirement 6d | 2026-08-01 |
| Q6 | Cột audit cho protocol revision | **Dùng cột `protocol_version` đã có** — không thêm cột, không migration. *Sửa lại quyết định trước.* | 2026-08-01 |
| Q2 | Revision của Claude Code | **Legacy only** — `2.1.207`, `LATEST = 2025-11-25`, 0 lần `2026-07-28`. Legacy làm trước | 2026-08-01 |
| Q3 | Tasks extension trong SDK v2 | Có schema + `RELATED_TASK_META_KEY`, **không** có task manager → giữ ngoài phạm vi | 2026-08-01 |
| Q4 | MRTR và request ID | Tương quan qua **`requestState`**, không qua request ID | 2026-08-01 |
| Q10 | `server@2` tự phục vụ legacy được không | **Có**, cả HTTP lẫn stdio (4/4 probe). `sdk@1.x` xuống devDependency | 2026-08-01 |

---

## Câu hỏi mở còn lại — giải trong Detailed Design

| # | Câu hỏi | Ảnh hưởng |
|---|---|---|
| Q11 | `contracts` re-export hằng số revision từ SDK, hay tự khai báo rồi assert khớp trong test? | Nghiêng về tự khai báo + test đối chiếu (AC 9.8) |
| Q12 | Codex `0.146.0` nói revision nào? | Không chặn thiết kế; ảnh hưởng thứ tự viết test và tài liệu cấu hình |
| Q13 | Approval grant lưu ở đâu và hình dạng ra sao — row trong SQLite hay token ký? | Requirement 6. Cả hai đều đạt AC; chọn theo độ phức tạp |
| Q14 | Mutation composite cần cột mới trong `mutation_journal` không, hay dùng nhiều row cùng một journal id? | Có thể phát sinh migration; Requirement 5b |
| Q15 | Retention mặc định cho backup destructive là bao lâu? | AC 6b.9 |

---

## Định nghĩa hoàn thành

1. Exact installed MCP SDK legacy/modern clients spawn được resolved `vidcom mcp`, bắt tay thành công, `stdout` sạch.
2. Cùng bộ tool gọi được qua Streamable HTTP có xác thực, cho kết quả giống stdio, cả khi client tự negotiate lẫn khi pin `/api/mcp/<revision>`.
3. Exact legacy SDK `1.30.0` và modern client `2.0.0` **cùng** dùng được bộ tool đó; actual Claude Code/Codex binary validation thuộc release-artifact gate, chưa được claim bởi Phase 2.
4. Khi `recovery.writeStatus = "ready"`, agent đọc project rồi sửa scene ngay, không cần gọi thêm tool đọc để lấy `contentHash`.
5. `create_scene` sinh **một** revision; crash giữa chừng được reconcile về trạng thái nhất quán hoặc project bị quarantine và chặn write cho tới khi recovery được resolve.
6. `set_text` đánh dấu narration stale và nói ra điều đó.
7. Xoá scene bị chặn cho tới khi có approval grant do daemon phát hành; agent tự đặt cờ **không** qua được.
8. Sau khi xoá: mount đã gỡ, file xoá đúng theo quy tắc tham chiếu, root duration đúng, narration JSON + WAV đã dọn, preview-settings đã dọn, có backup restore được — tất cả trong **một** revision.
9. Audit có `protocol_version` cho mọi tool call; tool ghi fail-closed, tool đọc fail-open.
10. `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run test:boundaries`, toàn bộ test/build/runtime/schema-drift gates pass và CI xanh.
11. Contract test chạy hai era × hai transport; golden `tools/list` tồn tại cho cả hai era.
12. Không có nghiệp vụ mới nào nằm trong `packages/mcp` — tất cả ở `packages/core`.

---

## Approval Gate

> Gate Goals đã được tái xác nhận tường minh ngày 2026-08-02. Detailed Design bản 6 và Implementation Checklist được người dùng duyệt cùng nhau qua lệnh `/goal` ngày 2026-08-02; lệnh đó đồng thời authorize Code Execution A→P. DR-20 sửa bridge audit nhưng không thay đổi acceptance criteria trong tài liệu Goals này.

- **Status**: **Approved**
- **Confirmed by**: người dùng (chủ dự án)
- **Original confirmation date**: 2026-08-01
- **Reconfirmation date**: 2026-08-02
- **Notes**: Người dùng đã tái xác nhận AC 2.11, AC 5b.3–4e và AC 7.4b–4c sau audit recovery durability; sau đó `/goal` duyệt Design v6 + checklist và mở Code Execution A→P. Các quyết định còn lại của lần duyệt 2026-08-01 được giữ nguyên.
