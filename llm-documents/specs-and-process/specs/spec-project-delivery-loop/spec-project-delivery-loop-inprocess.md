# Spec Project Delivery Loop

> **Related Documents**:
> - [Detailed Goals](./spec-project-delivery-loop-detailed-goal.md) — **✅ Approved 2026-08-04**
> - [Detailed Design](./spec-project-delivery-loop-detailed-design.md) — **✅ Approved 2026-08-04**
> - [Implementation Checklist](./spec-project-delivery-loop-implementation-checklist.md) — **✅ Approved 2026-08-04; đang thực thi**
>
> Spec này hiện thực **Giai đoạn 3** của [15-build-order](../../../product-features/15-build-order.md#giai-đoạn-3--đóng-vòng-lặp-sản-phẩm-34-tuần), đã **re-baseline** theo trạng thái code thật ngày 2026-08-04, và **kéo AK-1..3 từ Giai đoạn 4 lên** theo quyết định của người dùng cùng ngày.

## Spec Goal

Đóng vòng lặp sản phẩm: người dùng chạy entrypoint `vidcom` **trong một folder bất kỳ**, tạo project với preset platform, nhờ harness (Codex/Claude Code) dùng SKILL dựng scene, nghe narration, và **xuất ra MP4** — không rời app, không gõ CLI HyperFrames. Giai đoạn 3 giao và kiểm entrypoint CLI/executable; đóng gói Node SEA thành binary phân phối thuộc Giai đoạn 4.

Đo được bằng một đường chạy duy nhất: `vidcom` trong folder trống → tạo project dọc → harness dựng scene qua MCP → narration phát được → render → tải MP4 mở lên xem đúng.

---

## Mô hình sản phẩm — đọc trước khi đọc requirement

Chốt ngày 2026-08-04. Đây là thứ định hình toàn bộ spec, và nó **khác** giả định của code hiện tại.

```
người dùng chạy   vidcom            (entrypoint CLI/executable; đóng gói ở Giai đoạn 4)
                    │
                    ├─ cwd không có vidcom.json  → cwd LÀ workspace
                    │     scan một cấp subfolder → folder nào có vidcom.json là một project
                    │
                    └─ cwd CÓ vidcom.json        → workspace là folder CHA
                          project đang mở = cwd, vào studio thẳng

  c:/abc/bdf/              ← workspace: cả VidCom và Codex/Claude Code cùng coi đây là gốc
  ├── AGENTS.md  .agents/skills/        ← manifest Codex, khi host `codex` được chọn
  ├── CLAUDE.md  .claude/skills/        ← manifest Claude Code, khi host `claude-code` được chọn
  │                                        workspace-local, KHÔNG phải ~/.claude, ~/.codex
  │                                        version nằm trong marker của chính file, không có lock
  ├── my-tiktok-video/     vidcom.json  ← một project
  ├── client-explainer/    vidcom.json  ← một project
  ├── notes/                            ← không phải project, bỏ qua
  └── imported-hf/         hyperframes.json, KHÔNG có vidcom.json
                                        ← "candidate chưa nhận", chờ người dùng bấm nhận

  runtime:  harness ──MCP──▶ VidCom daemon         (gọi tool, đọc/ghi project)
  học việc: harness ──đọc──▶ AGENTS.md + skills    (biết gọi tool nào, theo thứ tự nào)
```

Năm tính chất bắt buộc của mô hình này:

| # | Tính chất | Hệ quả cho spec |
|---|---|---|
| M1 | **`vidcom.json` là marker của project**, không chỉ là file identity | Đổi luật marker đang có (R1, R3) |
| M2 | Workspace là folder người dùng mở, kể cả khi **trống** | Phải bỏ luật "cwd chỉ hợp lệ nếu đã có project" (R1.3) |
| M3 | Project tồn tại hợp lệ **trước khi** có nội dung | Project có state `empty` → `authored` (R1.4, R5) |
| M4 | Giá trị cốt lõi là **điều phối harness bằng SKILL**, không phải editor | Agent-kit vào phạm vi (R13); MCP tool cho render/snapshot/check **không còn cắt được** (R12) |
| M5 | Agent-kit cài ở **gốc workspace**, workspace-local, bằng **hành động tường minh** | Cần scope ghi mới ở cấp workspace (R13.11); không nhân bản xuống project (R5.1); tool `install_agent_kit` (R12.9) |

**MCP và agent-kit là hai kênh khác nhau, cả hai đều cần.** MCP là cách harness *làm*; agent-kit ở gốc workspace là cách harness *biết phải làm gì*. Một luật an toàn MUST được server cưỡng chế, MUST NOT chỉ nằm trong `AGENTS.md` — không phải host nào cũng đọc file.

> **Skill nào?** Skill để **dùng** VidCom, MUST NOT lẫn với skill để **phát triển** VidCom (`.agents/skills/bun`, `hono`… của repo này). [steering/14 §1](../../../steering/14-agent-kit-and-skills.md#1-hai-loại-instruction--must-not-lẫn) đã tách hai loại và spec này giữ đúng ranh giới.

### Khoảng cách với code hôm nay

| Mô hình | Code hôm nay | Ở đâu |
|---|---|---|
| Có `vidcom.json` → là project | Marker là **`hyperframes.json` + `index.html`**; thiếu `vidcom.json` hợp lệ thì project bị **loại khỏi danh sách** | [`workspace-fs.ts:39-58`](../../../../packages/adapter/src/fs/workspace-fs.ts#L39-L58) |
| Mở được folder trống | cwd chỉ hợp lệ nếu **đã có** subfolder chứa `hyperframes.json`+`index.html`; không có → `selection_required` → **throw** | [`workspace-selection.ts:17-21`](../../../../packages/cli/src/workspace-selection.ts#L17-L21), [`workspace-resolver.ts:23`](../../../../packages/core/src/domain/workspace-resolver.ts#L23) |
| Project rỗng vẫn hợp lệ | `readProjectRefAt()` đòi `index.html` tồn tại mới trả ref | [`workspace-fs.ts:44`](../../../../packages/adapter/src/fs/workspace-fs.ts#L44) |
| Điều phối harness bằng SKILL | [`packages/agent-kit/`](../../../../packages/agent-kit/) **rỗng** — chỉ hai file `.gitkeep` | — |
| Quy trình 9 bước gọi 4 tool | `validate_project`, `start_snapshot`, `start_render`, `get_job_status` **không tồn tại** trong Registry 10 tool | [steering/14 §3](../../../steering/14-agent-kit-and-skills.md#3-quy-trình-chuẩn--thứ-agent-phải-theo) |
| Ghi được vào **gốc workspace** | **Không có đường nào.** `resolveProjectPath()` bắt buộc có `ProjectRef` và giam mọi thứ trong `ref.root`; `WriteAuthority` journal mutation theo `projectId` | [`resolve.ts:64-87`](../../../../packages/adapter/src/fs/resolve.ts#L64-L87) |
| Ghi được dot-dir và `AGENTS.md` | `isGloballyBlocked()` chặn mọi segment bắt đầu bằng `.`; `agents.md`/`claude.md` nằm trong `PROTECTED_FILES` | [`path-policy.ts:30-56`](../../../../packages/core/src/domain/path-policy.ts#L30-L56) |

M2 là **chặn đứng**: hôm nay chạy VidCom trong folder mới là không mở được, nên "mở app rồi tạo project đầu tiên" — chính mốc của giai đoạn này — không thể xảy ra.

M5 chạm một chỗ **chưa tồn tại**: không có scope ghi nào ở cấp workspace. Đó là lý do R13 đắt hơn con số AK-1..3 gợi ra.

---

## Re-baseline: build-order §Giai đoạn 3 vs code thật

Build-order liệt kê 9 mục. Ba trong số đó **đã được Phase 1/2 làm xong trước** — spec này không làm lại.

| build-order | ID | Trạng thái thật 2026-08-04 | Trong spec |
|---|---|---|---|
| 3.1 Render MP4 — job async, progress, download | PR-1 | Không có dòng nào | ✅ R6 |
| 3.2 Snapshot theo scene + contact sheet + invalidate | PR-5, PR-6 | Không có; `snapshots/` chỉ được **đọc** | ✅ R7 |
| 3.3 TTS thật + duration + mount audio | NT-1, NT-3, NT-4 | **XONG** 2026-08-03 — [07 §TTS thật](../../../product-features/07-feature-narration-tts.md#tts-thật-2026-08-03), [`synthesize-narration.ts`](../../../../packages/core/src/usecase/synthesize-narration.ts) | ❌ trừ cảnh báo `durationSeconds > scene.duration` → gộp vào R9 |
| 3.4a Bỏ auto-regenerate khi sửa script | NT-13 | **XONG** — [`project-writes.ts:236`](../../../../packages/core/src/usecase/project-writes.ts#L236) đánh `staleSince` | ❌ |
| 3.4b Nhiều đoạn narration / scene | NT-7 | Chưa — một record/scene ([`plan-narration-synthesis.ts:112`](../../../../packages/core/src/usecase/plan-narration-synthesis.ts#L112)) | ✅ R11 |
| 3.5 Diagnostics endpoint + `hyperframes check` | VD-1, VD-2, VD-3 | `Diagnostic` type có; lint 4 cảnh báo **chưa port sang Core**; chưa có endpoint | ✅ R9 |
| 3.6 Tạo / xoá / đổi tên project | PM-2, PM-4 | Không có; `bootstrapProject` chỉ **đăng ký** thư mục đã tồn tại | ✅ R5 |
| 3.7 Scene chèn vị trí bất kỳ + ripple + validate timing | SC-4, SC-5, SC-8 | Chỉ append cuối; có mã lỗi `timing_invalid`/`duration_overflow` nhưng chưa có ripple | ✅ R10 |
| 3.8 Thumbnail thật ở Home | PM-5 | Mock — `posterFor(index)` | ✅ R8 |
| 3.9 Allowlist asset + Range request | SE-2, FA-8 | **XONG** — [`path-policy.ts`](../../../../packages/core/src/domain/path-policy.ts), [`project-reads.ts:50-91`](../../../../packages/server/src/routes/project-reads.ts#L50-L91) | ❌ |

**Bổ sung sau khi chốt mô hình sản phẩm** (2026-08-04):

| Mục | ID | Vì sao ở giai đoạn này |
|---|---|---|
| Workspace mở được folder bất kỳ + `vidcom.json` làm marker + nhận candidate | PK-2 (mở rộng), PM-1, PM-7, PK-12 (một phần) | M1 + M2. Không có nó thì R5 "tạo project" không có chỗ đứng, và folder mới không mở được |
| Preset platform bắt buộc khi tạo project | PM-9 (mở rộng) | Không có nó thì R5 phải đoán canvas size |
| `vidcom.json` + `.vidcom/` per-project | PM-9 | `vidcom.json` hiện chỉ mang `{ id }`. Preset, render config, job history, log đều không có nhà. Version agent-kit **không** thuộc đây — nó thuộc workspace (§4.2 của Goals) |
| **Agent-kit pull được về gốc workspace**: `AGENTS.md` + skill router `/vidcom` + 6 skill con | AK-1, AK-2, AK-3 (+AK-4, AK-5, AK-6, AK-8 — xem ghi chú) | M4 + M5. Kéo từ Giai đoạn 4 lên theo quyết định người dùng: đây là giá trị cốt lõi của sản phẩm, không phải phần đóng gói |

> **Ghi chú về phạm vi agent-kit.** Người dùng chọn "kéo AK-1..3". Nhưng AK-1..3 một mình **không bao giờ tới được folder người dùng** — nó nằm trong binary và không có đường ghi ra ngoài. Nên R13 buộc phải kèm:
> - **AK-4 + AK-6** — cài vào gốc workspace bằng hành động tường minh (CLI + MCP tool `install_agent_kit`).
> - **AK-5** — operation mặc định `install` không ghi đè file đã tồn tại. `link` chỉ tồn tại cho Claude Code (`@CLAUDE.vidcom.md`); Codex dùng merge thủ công theo kết quả spike. `link`/`replace` đòi `expectedContentHash`; `replace` không chạm `foreign`/`newer`. Không cần lock file trong workspace.
> - **AK-8** — 3 test đồng bộ agent-kit ↔ Tool Registry. Ship agent-kit không có test đồng bộ là ship một tài liệu sẽ mục, mà agent tin nó tuyệt đối ([steering/14 §7](../../../steering/14-agent-kit-and-skills.md#7-đồng-bộ-với-tool-contract--chống-mục)).
> - **Scope `workspace` cho `WriteAuthority`** — bắt buộc về kỹ thuật, không phải lựa chọn: hôm nay không tồn tại cách nào ghi `<workspace>/AGENTS.md` mà không sinh đường ghi thứ hai vào đĩa người dùng.
>
> Đây là **mở rộng so với câu hỏi đã hỏi** — cần xác nhận ở gate, xem OQ-8.
>
> **Và nó làm steering/14 §8 sai ở ba câu.** (a) *"ghi `AGENTS.md` + `CLAUDE.md` vào project khi tạo project"* — đích là gốc workspace và chỉ ghi manifest host được chọn. (b) *"MUST ghi version của agent-kit vào `vidcom.json`"* — version nằm trong marker của chính file đã cài, không ở `vidcom.json` (N project không thể khai N version cho một bản đã cài) và không ở lock file nào. (c) *"hoặc hỏi, hoặc ghi ra `AGENTS.vidcom.md` và báo"* — ghi file phụ một mình **không** làm nội dung có hiệu lực; Claude cần `@CLAUDE.vidcom.md`, Codex cần merge thủ công. Sửa steering/14 §8 là deliverable thứ hai của spec này, cạnh R4.9 (sửa steering/07).

---

## Spec Stories

- **Chạy VidCom ở đâu cũng được**:
    - Là người dùng, tôi muốn chạy `vidcom` **trong folder bất kỳ**, kể cả folder trống, để bắt đầu một video mới ở chỗ tôi muốn.
    - Là người dùng, tôi muốn mọi folder con có `vidcom.json` **tự hiện ra là một project**, để không phải khai báo gì thêm.
    - Là người dùng, tôi muốn chạy `vidcom` **bên trong** folder project thì vào thẳng project đó, giống cách tôi dùng Codex/Claude Code.
    - Là người dùng có sẵn project HyperFrames, tôi muốn VidCom **hỏi trước khi nhận** nó vào, không tự ghi file vào folder của tôi.

- **Tạo project có định hướng platform**:
    - Là người dùng, tôi muốn **chọn dọc hay ngang trước khi project được tạo**, để video được tối ưu cho TikTok/Reel/Shorts hoặc YouTube long thay vì một khung chung chung.
    - Là người dùng, tôi muốn nút `New video` **hoạt động thật**, để không phải chạy `hyperframes init` bằng tay.
    - Là người dùng, tôi muốn **xoá và đổi tên project** trong app, để dọn được thử nghiệm thất bại.
    - Là người dùng, tôi muốn thấy **thumbnail thật**, để nhận ra project bằng mắt.

- **Project là một folder tự mô tả**:
    - Là người dùng, tôi muốn mỗi project mang **cấu hình khai báo trong `vidcom.json`** (preset, kích thước, fps, voice mặc định, render preset), để copy folder sang máy khác vẫn giữ đúng cấu hình. Cam kết cùng input cho cùng output chỉ áp dụng khi render sidecar ghi `reproducible: true`; external script/stylesheet/font được phép ở Giai đoạn 3 phải ghi URL, cảnh báo và `reproducible: false`.
    - Là người dùng dùng Codex/Claude Code, tôi muốn project chứa **`.vidcom/` với state, log và ngữ cảnh**, để harness hiểu project đang ở đâu mà không phải hỏi lại tôi hay dò database ẩn.
    - Là người dùng, tôi muốn mở project cũ **không bị chặn** — hệ thống tự suy preset từ kích thước hiện có và ghi lại.

- **Harness dựng video hộ tôi**:
    - Là người dùng, tôi muốn **pull `AGENTS.md` + skill của VidCom về gốc workspace**, để Codex/Claude Code đọc được ngay khi mở và biết quy trình dựng video mà tôi không phải giải thích lại mỗi lần.
    - Là người dùng, tôi muốn skill nằm **trong workspace của tôi**, không phải được cài vào `~/.claude` hay `~/.codex` — VidCom không nên sửa cấu hình toàn máy của tôi.
    - Là người dùng, tôi muốn **harness tự pull skill về được** qua một tool, để nó tự trang bị mà tôi không phải nhớ chạy lệnh nào.
    - Là người dùng, tôi muốn harness **tự kiểm tra việc nó vừa làm** (validate, snapshot, render) qua tool thật, thay vì báo xong rồi để tôi phát hiện sai.
    - Là người dùng, tôi muốn agent **không được ghi thẳng vào file composition** sau lưng app, để không mất revision và audit.

- **Xuất được thứ tôi cần**:
    - Là người dùng, tôi muốn **render MP4** ngay trong app, thấy tiến độ, huỷ được, và tải file về.
    - Là người dùng, tôi muốn **snapshot theo từng scene** để storyboard có hình thật, và snapshot **tự hết hiệu lực** khi tôi sửa composition.

- **Sửa scene mà không tự tay tính lại thời gian**:
    - Là người dùng, tôi muốn **chèn scene ở giữa** timeline, không chỉ append cuối.
    - Là người dùng, tôi muốn **ripple edit** — đổi duration một scene thì các scene sau tự dịch.
    - Là người dùng, tôi muốn bị **chặn khi nhập timing vô nghĩa**, thay vì làm hỏng composition im lặng.

- **Narration đúng nghiệp vụ**:
    - Là người dùng, tôi muốn **nhiều đoạn narration trong một scene**, mỗi đoạn timing riêng, để scene 5 câu thoại không mất 4 câu.
    - Là người dùng, tôi muốn **được cảnh báo khi narration dài hơn scene**, kèm đề xuất `data-duration` mới.

- **Chất lượng có chỗ để xem**:
    - Là người dùng, tôi muốn một chỗ **liệt kê mọi vấn đề của project**, để biết cái gì đang sai trước khi render.

---

## Spec Planning

- **Supplementary files**:
  - [Detailed Goals](./spec-project-delivery-loop-detailed-goal.md) — **✅ Approved 2026-08-04** (bản 10).
  - [Detailed Design](./spec-project-delivery-loop-detailed-design.md) — **Pending Confirmation** (bản 2); deep review và 8 spike contract đã hoàn tất.
  - Implementation Checklist — **chưa tạo**, bị Phase Gate `Design → Implement` chặn
- **Date**: 2026-08-04 → 2026-09-26 (**7–8 tuần lịch**). **Vượt ước lượng 3–4 tuần của build-order**, vì spec nhận thêm mô hình workspace/marker và agent-kit. Là thứ tự tương đối, không phải cam kết lịch. Các spike gate chạy **trước** Design và không nằm trong estimate implementation.
- **Capacity**: **~190 SP** ước lượng planning qua 13 requirement. Bảng requirement cộng đúng **190**: base bản 8 là 180 SP, cộng **10 SP vào R6 ở bản 9** cho process-tree kill, render-root recovery và external dependency policy do spike phát hiện. Phase 2 (132 SP) đã cho thấy ước lượng ban đầu không giữ được khi scope mở ra lúc design; con số này nên được coi là **sàn**, không phải trần.
  > Bản 4 là lần đầu con số **giảm**, và nó giảm vì một yêu cầu bị bỏ chứ không vì ai ước lượng lại: `skills-lock.json` là sổ sách bên ngoài cho một bài toán mà luật không-ghi-đè làm biến mất. Bản 5 tăng lại 4 SP vì luật đó **quá đơn giản so với thực tế** — vẫn cần `replace` và `link` có điều kiện; spike bản 10 giới hạn `link` vào Claude Code thay vì ship một operation Codex không có hiệu lực.

| R | Nội dung | SP | Cắt được? |
|---|---|---|---|
| R1 | Workspace mở folder bất kỳ + marker `vidcom.json` + nhận candidate | 8 | Không — M2 đang chặn đứng |
| R2 | Preset platform + catalog | 5 | Không — chặn R5 |
| R3 | Schema `vidcom.json` mở rộng | 8 | Không — chặn R1, R2, R5, R13 |
| R4 | `.vidcom/` per-project state | 13 | Một phần — `cache/` cắt được |
| R5 | Tạo / xoá / đổi tên / nhận project | 16 | Không — mốc của giai đoạn |
| R6 | Render MP4 + process-tree/workdir recovery + external dependency policy | 31 | Không — PR-1 ưu tiên cao nhất toàn dự án; +10 SP từ finding spike |
| R7 | Snapshot theo scene + contact sheet + invalidate + retry phần thiếu | 14 | Không — chặn R8 |
| R8 | Thumbnail thật ở Home | 5 | Không |
| R9 | Diagnostics endpoint | 13 | Một phần — `hyperframes check` integration cắt được |
| R10 | Scene chèn / ripple / validate timing | 13 | Không |
| R11 | Nhiều đoạn narration / scene | 13 | **Có** — ứng viên cắt số 1, hoãn sang Giai đoạn 5 |
| R12 | 5 MCP tool: `validate_project` / `start_snapshot` / `start_render` / `get_job_status` / `install_agent_kit` | 10 | **Không còn cắt được** — quy trình 9 bước của agent-kit gọi đúng bốn tool đầu |
| R13 | Agent-kit: manifest riêng Codex/Claude + router + 6 skill + **scope ghi workspace** + `install`/`replace` và Claude-only `link` + state machine outcome + 3 test đồng bộ | 41 | Một phần — xem OQ-8 |

Thang cắt nếu velocity không tới: **R11** (13) → **R4 `cache/`** (3) → **R9 phần `hyperframes check`** (4). MUST NOT cắt R12, MUST NOT cắt 3 test đồng bộ của R13, MUST NOT cắt scope `workspace` — bỏ nó nghĩa là ghi vòng ngoài `WriteAuthority`.

- **Testing**: logic test cho mọi domain function thuần (marker/workspace resolution, preset resolution, ripple recalculation, timing invariant, diagnostic aggregation); **integration test trên SQLite trong app-data + filesystem thật trong thư mục tạm** cho mọi đường ghi (`vidcom.json`, `.vidcom/`, tạo/xoá/nhận project, render output, snapshot output); golden file cho `vidcom.json` serialize, payload diagnostics, và `tools/list` của cả hai era; **3 test đồng bộ agent-kit ↔ Tool Registry** (AK-8); failure-injection test cho job render bị kill giữa lúc chạy.
  > Datastore thật của spec này là **SQLite trong app-data + filesystem trong temp directory**, đúng runtime production. MUST NOT mock `node:fs`, MUST NOT dùng in-memory stand-in cho datastore.
  > Render và snapshot cần Chromium + FFmpeg thật. Test cần chúng phải **skip có thông báo** khi binary vắng mặt, MUST NOT pass im lặng — cùng cách đã áp cho VieNeu ở Phase 2.
  > Test workspace phải phủ **folder trống**, folder chỉ có candidate chưa nhận, và folder có project `empty` — ba trạng thái hôm nay chưa tồn tại.
  > Test cài agent-kit phải phủ sáu trường hợp: cài lần đầu (`installed`), cài lại (no-op, không file nào bị ghi đè), file chỉ dẫn chính của host là `foreign` nhưng router native pristine (`degraded`/`partial`, **không** `blocked`), chỉ chọn một host (không sinh file host kia), file mang marker version cũ (báo có bản mới, không tự thay), và gốc workspace read-only. Đây là toàn bộ chỗ AK-5 và luật báo-kết-quả-trung-thực có thể sai.
  > Test ripple phải phủ project **nhiều track**: dịch scene ở track 1 MUST NOT làm scene ở track 0 di chuyển, và chồng lấn giữa hai track MUST NOT bị báo là lỗi. Không có test này thì luật per-track chỉ tồn tại trong tài liệu.
  > Test `sourceRevision` phải chứng minh **bốn** điều, không chỉ một: ghi `state.json`/`context/**` không làm nó tiến; ghi `snapshots/**` không làm nó tiến; ghi `renders/**` không làm nó tiến; và một job render chạy xong **không** làm snapshot bị nhãn stale. Ba điều sau là ba chỗ bản 4 sai — không có test thì cách sai duy nhất quan sát được là "cache lúc nào cũng stale" và không ai truy được vì sao.
  > Test cài agent-kit phải phủ **6 state per-file × thuật toán outcome** (R13.9a), và bắt buộc có sáu tổ hợp dễ báo sai: `current_pristine` + `missing` → `installed` · mọi file `current_pristine` → `already_installed` · file chỉ dẫn `foreign` + router pristine → host **`degraded`** · **hai host cùng `degraded` → `partial`, MUST NOT `blocked`** · router skill không parse/discover được → host **`blocked`** · `newer` → binary cũ MUST NOT hạ cấp.
  > Test `link` chỉ chạy cho Claude Code và phải chứng minh `@CLAUDE.vidcom.md` đổi `usableBy` từ `degraded` sang `ready` khi toàn bộ skill pristine (R13.9e-i). Schema phải từ chối `link` với `host: "codex"`; Codex recovery phải trả `manual_merge`, không trả một dòng import giả.
  > Test `hosts` phải có: `hosts` rỗng → `schema_invalid`; chọn một host → file của host kia MUST NOT vào `expectedFiles` và MUST NOT làm outcome thành `partial`.
  > Test `entryId` phải chứng minh: project có `vidcom.json` lỗi vẫn liệt kê được, diagnostics identity chạy được, `vidcom.json` thay được với `expectedContentHash`, đổi tên và xoá được — **và** một tool nghiệp vụ (render/snapshot/scene) **từ chối** `entryId`. Tập recovery phải đóng thật, không chỉ đóng trên giấy.
  > Test `.gitignore` của `.vidcom/` phải chứng minh `git status` sạch sau khi mở project và chạy một job — chỉ `context/project-context.md` được track. Cộng một test determinism: sinh `project-context.md` hai lần trên cùng input cho ra cùng byte, và nó không chứa absolute path, timestamp mở-lần-cuối, hay job ID.
  > Test snapshot phải có **hai** đường retry sau `partial`, không một: (a) `sourceRevision` **không đổi** → chỉ sinh scene còn thiếu; (b) `sourceRevision` **đã đổi** → sinh lại toàn bộ, MUST NOT tái dùng ảnh cũ. Đường (b) là chỗ dễ sai và sai im lặng — kết quả là một contact sheet trông hợp lý với vài frame thuộc phiên bản khác của video.
  > Test workspace phải có một case `vidcom.json` **lỗi cú pháp** ở cwd, và chứng minh app mở đúng project đó ở state `invalid` — MUST NOT rơi xuống active workspace. Cùng bộ test phải có case active workspace bị xoá → cảnh báo + fallback, không im lặng.
  > Test `invalid` phải chứng minh diagnostics **vẫn chạy** trong khi render/snapshot/mutation bị từ chối `project_invalid` — bảng R1.2d chỉ có giá trị khi từng dòng có một test.

- **Risks**:
  - **Đổi luật marker chạm vào đường đọc của mọi thứ.** `listProjects()` / `readProjectRefAt()` / `listProjectCandidates()` / `selectWorkspace()` đang cùng giả định `hyperframes.json`+`index.html`. Đổi sang `vidcom.json` là đổi **định nghĩa "project tồn tại"** — mọi test Phase 1/2 dựng fixture project đều đi qua giả định cũ. Rủi ro không phải viết code mới, mà là **fixture cũ vẫn xanh trong khi hành vi đã khác**.
  - **Project state `empty` là trạng thái chưa từng tồn tại.** Mọi đường đọc hôm nay được bảo đảm có `index.html` để parse. Cho phép project không có composition nghĩa là mỗi read path phải có nhánh "chưa có gì" — và nhánh đó dễ bị quên đúng ở chỗ ít ai mở: diagnostics, snapshot, render, thumbnail.
  - **`.vidcom/` đi ngược steering đang có hiệu lực.** [steering/07](../../../steering/07-data-and-storage.md) §2 nói *"MUST NOT ghi state vận hành vào workspace"*, §6 nói revision *"MUST NOT làm bẩn workspace bằng thư mục lịch sử"*, và [`path-policy.ts:48`](../../../../packages/core/src/domain/path-policy.ts#L48) chặn **mọi** segment bắt đầu bằng `.`. Người dùng đã được thông báo và **xác nhận chọn state đầy đủ trong `.vidcom/`**. Hệ quả: spec này phải sửa steering 07 §2/§6 kèm Decision Record, và nới path-policy bằng purpose mới — MUST NOT nới bằng cách bỏ luật chặn dotfile chung, vì đó là thứ đang chặn `.env` và `.git`.
  - **Ranh giới authority `.vidcom/` ↔ SQLite đã chốt (OQ-1), nhưng nó là thứ dễ mờ dần khi thực thi.** SQLite là authority và engine giao dịch; `.vidcom/revisions/` và `.vidcom/jobs/` là projection bền, rebuild được từ SQLite, và **MUST NOT ghi ngược**. Rủi ro còn lại không phải quyết định sai mà là **xói mòn**: một tính năng nghe rất hợp lý — "SQLite thiếu thì đọc lại lịch sử từ `.vidcom/`" — biến projection thành authority thứ hai, và dual-authority không có "nguồn nào đúng", chỉ có hai nguồn cùng tự tin. R4.8b là luật chặn, và nó cần một test chứ không chỉ một câu.
  - **Agent-kit mục là agent làm sai, và agent tin tài liệu tuyệt đối.** Đây là rủi ro khác loại với bug thường: không crash, không đỏ test, chỉ là agent lặng lẽ làm sai theo tài liệu của chính ta. 3 test đồng bộ (AK-8) là thứ duy nhất chặn được, nên chúng MUST NOT bị cắt.
  - **Agent-kit tham chiếu 4 tool chưa tồn tại.** Quy trình 9 bước ở [steering/14 §3](../../../steering/14-agent-kit-and-skills.md#3-quy-trình-chuẩn--thứ-agent-phải-theo) gọi `validate_project`, `start_snapshot`, `start_render`, `get_job_status` — không cái nào có trong Registry 10 tool của Phase 2. R13 **phụ thuộc cứng** vào R12, và R12 phụ thuộc R6/R7/R9. Đây là chuỗi phụ thuộc dài nhất của spec.
  - **Scope `workspace` cho `WriteAuthority` là rủi ro cùng loại với composite mutation của Phase 2.** `resolveProjectPath()` đang giam mọi thứ trong `ref.root` và journal neo theo `projectId`; thêm một scope không có `projectId` chạm vào chính chỗ ~180 test bám vào. Hai cái dễ sai: (a) containment ở gốc workspace phải chặt bằng containment trong project — nới scope MUST NOT thành nới kiểm soát; (b) recovery lúc khởi động phải biết xử lý mutation không có project. Cắt góc ở đây là mở một đường ghi thứ hai vào đĩa người dùng, đúng thứ [steering/07 §4](../../../steering/07-data-and-storage.md#4-ghi-file--quy-tắc-cứng) cấm.
  - **Mapping host đã được spike chốt nhưng có thể trôi theo phiên bản host.** Codex 0.146.0 chỉ nhận `.agents/skills`; Claude Code 2.1.220 chỉ nhận `.claude/skills`. Cả hai chấp nhận frontmatter marker; chỉ Claude theo import file phụ. Rủi ro còn lại là regression khi CLI đổi discovery/import, nên R13.18 giữ probe native + MCP call làm test tương thích — không quay lại đo bằng việc file tồn tại.
  - **Ghi vào folder người dùng cần sự đồng ý, không chỉ cần đúng kỹ thuật.** Gốc workspace có thể là một Git repo đang có `AGENTS.md` của họ. R13.9 xử lý bằng hash + tên phụ, nhưng rủi ro còn lại là **cài im lặng**: người dùng thấy file lạ xuất hiện trong repo mà không hiểu ai ghi. R13.8 và R13.15 (chỉ cài khi được gọi tường minh, và báo rõ đã ghi gì ở đâu) là hai luật chặn chuyện đó, và chúng MUST NOT bị coi là nice-to-have.
  - **Render MP4 là rủi ro vận hành lớn nhất.** Job chạy phút, ăn Chromium + FFmpeg, ghi file lớn. Ba chỗ dễ sai: (a) huỷ giữa chừng phải **kill được process con**, không để lại zombie ăn CPU; (b) crash giữa lúc render phải không để lại MP4 dở dạng trông như hợp lệ; (c) render **không** idempotent về byte, nên retry tự động ghi hai artifact cho một yêu cầu — bài học `tts` (`maxAttempts: 1`) áp dụng trực tiếp.
  - **Ripple edit chạm đúng phần Phase 2 vừa ổn định.** Đổi duration một scene phải ghi timing **nhiều** scene + root duration trong **một** revision, tức đi qua `mutateComposite` — chỗ có ~180 test bám vào. Sai ở đây là hỏng nền móng, không chỉ hỏng timeline.
  - **Ripple trên project nhiều track dễ sai theo cách không ai thấy ngay.** Domain có `trackIndex`, nên chồng lấn giữa hai track là **chủ đích** (overlay, lower-third, transition), không phải lỗi. Áp luật "không hở không chồng" cho cả composition sẽ (a) đẩy những scene không liên quan và (b) sinh một danh sách diagnostic giả. Cái nguy hiểm là project một track — trường hợp phổ biến nhất — **không phát hiện được sai này**, nên test phải có project nhiều track hoặc luật per-track chỉ tồn tại trong tài liệu.
  - **Preset ghi vào composition có thể phá project đang chạy.** Người dùng chọn "preset ghi thật `data-width`/`data-height`" (giữ P1). Đổi preset sau khi có scene sẽ làm mọi layout tính theo pixel bị lệch. Cần cảnh báo tường minh; MUST NOT đổi preset im lặng khi bootstrap project cũ.
  - **`hyperframes check` là process ngoài.** Không có nó thì diagnostics mất một nguồn. Phải degrade rõ ràng, MUST NOT trả danh sách rỗng như thể project sạch.
  - **Render đã khả thi trên Node 26.5.0 và runtime CI 24.9.0, nhưng cleanup không được HyperFrames bảo đảm.** Spike OQ-4 chạy đủ render/narration/ffprobe/cancel/crash; artifact safety pass, còn HyperFrames thô leak workdir khi crash/huỷ. R6.6b/R6.7b bắt buộc kill cây tường minh và giam workdir vào root có marker theo job; đây là rủi ro implementation còn lại, không còn là câu hỏi feasibility.

- **Commitments**:
  - `vidcom` chạy được trong folder trống và tạo được project đầu tiên từ trong app — không CLI HyperFrames.
  - Mọi folder con có `vidcom.json` là một project; project HyperFrames nhập từ ngoài được **hỏi trước khi nhận**.
  - Người dùng render được MP4 có tiếng narration và tải về được.
  - Harness đọc manifest đúng host ở gốc workspace (`AGENTS.md` + `.agents/skills/**` hoặc `CLAUDE.md` + `.claude/skills/**`) và tự validate/snapshot/render được việc nó vừa làm.
  - Agent-kit pull được về workspace bằng một lệnh CLI **hoặc** một MCP tool; gọi lại `install` là no-op an toàn, `replace` có cho cả hai host, còn `link` chỉ có cho Claude Code và mọi mutation đều có precondition hash + phạm vi đích đóng.
  - `vidcom.json` và `.vidcom/` có schema được document hoá và có golden file.
  - `install` agent-kit **không bao giờ ghi đè** file đã tồn tại; Claude `link`/`replace` không xảy ra như tác dụng phụ; trạng thái cài chỉ báo `blocked` khi router native không được xác minh và dùng `degraded` khi router còn hoạt động nhưng chỉ dẫn chung chưa đầy đủ.
  - Mọi đường ghi mới đi qua `WriteAuthority` — kể cả ghi ở gốc workspace, kể cả từ agent. Không có đường ghi thứ hai vào đĩa người dùng.

## Phase Approvals

- **Detailed Goals**: **✅ APPROVED 2026-08-04** — bản 10, cả 9 OQ đóng và cả hai spike gate PASS ([render](../../../../spikes/phase-3-render/README.md), [ma trận host](../../../../spikes/phase-3-agent-kit-host/README.md)).
- **Detailed Design**: **Pending Confirmation** — bản 2 đã deep review, 8 spike contract và ba deliverable steering/build-order đã đồng bộ; chờ duyệt tường minh trước Checklist.
- **Implementation Checklist**: Pending Confirmation — MUST NOT tạo trước khi Detailed Design được duyệt tường minh.

## During Spec

- **Standups**: chưa bắt đầu.
- **Impediments**: **DG-1** — R6.6b yêu cầu Windows Job Object; Win32 protocol đã PASS nhưng production stack hiện chỉ cho TypeScript/Node SEA. Cần duyệt native C sidecar bundled, hoặc quay lại Goals hạ guarantee sang awaited `taskkill /T /F` + verify.
- **Adjustments**:
  - 2026-08-04 — **Detailed Design deep review + 8 spike contract.** Sửa cancel signal/proof, `job.partial` table-rebuild, runtime CSP + Resource Timing, snapshot staging per-scene, workspace operation/step journal, directory lifecycle, facade `WriteAuthority` và selected-host `usableBy`. Đồng bộ steering/01/02/07/14 + build-order. Design còn đúng một gate DG-1 về ngoại lệ native sidecar; chưa tạo Checklist.
  - 2026-08-04 — Re-baseline scope Giai đoạn 3: bỏ 3.3, 3.4a, 3.9 (đã xong ở Phase 1/2), thêm preset platform và `vidcom.json`/`.vidcom/` theo yêu cầu người dùng. 11 requirement, 125 SP.
  - 2026-08-04 — Xung đột `.vidcom/` với steering/07 được nêu; người dùng chọn "state đầy đủ trong `.vidcom/`". Spec nhận thêm việc **sửa steering**.
  - 2026-08-04 — **Chốt mô hình sản phẩm** (M1–M4): binary chạy ở folder bất kỳ, `vidcom.json` là marker, project tồn tại trước khi có nội dung, giá trị cốt lõi là điều phối harness bằng SKILL. Spec nhận thêm R1 (workspace/marker) và R13 (agent-kit AK-1..3 kéo từ Giai đoạn 4). R12 chuyển từ "ứng viên cắt" sang **không cắt được**. 13 requirement, ~174 SP, 5–6 tuần. Đánh số lại R1–R13.
  - 2026-08-04 — **Chốt M5**: agent-kit cài ở **gốc workspace** (`AGENTS.md`, `CLAUDE.md`, `.agents/skills/` hoặc `.claude/skills/`, `skills-lock.json`), workspace-local, bằng hành động tường minh; **không** nhân bản xuống project và **không** cài vào `~/.claude`/`~/.codex`. Hệ quả: `WriteAuthority` nhận scope `workspace` (chưa tồn tại hôm nay), R12 nhận tool thứ năm `install_agent_kit`, R5 bỏ phần ghi agent-kit vào project, field `agentKit` bị bỏ khỏi `vidcom.json` (version thuộc workspace, không thuộc project), và **steering/14 §8 phải sửa**. ~183 SP, 6 tuần.
  - 2026-08-04 — **Review bản 3 trả về 8 finding; sửa hết ở bản 4.** Bốn cái đổi nghiệp vụ: (1) **bỏ `skills-lock.json`** — schema xung đột với lock file của tooling skill người dùng, và luật *install không bao giờ ghi đè* + *version marker trong chính file* thay nó hoàn toàn (−7 SP); (2) tách **content revision** khỏi ghi dẫn xuất — trước đó ghi `diagnostics.json` làm chính nó cũ ngay tại thời điểm ghi; (3) **ripple theo từng track** — domain có `trackIndex` nên chồng lấn giữa hai track là hợp lệ, luật "không hở không chồng" chỉ đúng trong một track; (4) cài agent-kit phải báo **`installed`/`partial`/`blocked`** — ghi được `AGENTS.vidcom.md` không phải cài thành công vì không host nào bảo đảm đọc file phụ. Ba cái còn lại: bounds cho preset `custom`, đặc tả `authored` 0 scene, và bốn chỗ M5 còn sót trong tài liệu. ~176 SP.

  - 2026-08-04 — **Review vòng hai trả về 8 finding; sửa hết ở bản 5.** Ba cái nặng nhất là **do bản 4 tự tạo ra**, không phải nợ cũ: (1) `contentRevision` xếp `snapshots/**` và `renders/**` vào tập làm revision tiến — tái tạo đúng bug bản 4 vừa sửa, một tầng sâu hơn; đổi thành **`sourceRevision`** đếm *input render*; (2) ba outcome cài agent-kit báo một bản **đã cài đúng** là `blocked`; thay bằng 4 state per-file + bảng suy outcome 6 dòng + `usableBy` theo host; (3) luật "không có đường code nào ghi đè" mâu thuẫn với append và cờ thay ngay trong cùng requirement; tách thành ba operation `install`/`link`/`replace`. Năm cái còn lại: `invalid` cho `index.html` parse lỗi, bảng quyết định workspace (+**OQ-9**: đảo thứ tự so với steering/07 §3), ngoại lệ `cwd-solo` cho M5, snapshot `partial` retry được, và ba nguồn giới hạn thời lượng. ~180 SP. Deliverable sửa steering lên **ba** (07 §2, 07 §6, 07 §3, 14 §8).

  - 2026-08-04 — **Review vòng ba: hướng N4–N8 được chấp nhận, kèm 5 đề xuất bịt lỗ; áp hết ở bản 6.** **OQ-9 duyệt** — `explicit > cwd-có-marker > active > cwd`. Năm lỗ được bịt: (1) cwd-có-marker xét **sự có mặt** chứ không xét tính hợp lệ của `vidcom.json` — bản 5 để một marker lỗi làm app âm thầm nhảy sang active workspace khác, với nguyên nhân thật (một dấu phẩy sai) không xuất hiện ở đâu; (2) `invalid` nhận mã ổn định `composition_parse_error` + line/column và một **bảng hành vi dùng chung** — quan trọng nhất là diagnostics **vẫn chạy**, vì chặn nó là chặn đúng công cụ dùng để tìm ra vì sao project hỏng; (3) `cwd-solo` phải xác nhận **trước khi ghi** — harness gọi `install_agent_kit` thoả "tường minh với tool" nhưng con người chưa chắc biết `AGENTS.md` sắp vào folder project của họ; (4) snapshot partial gắn `partialAtSourceRevision` — không có nó, retry sau khi source đổi cho ra bộ ảnh nửa cũ nửa mới rồi đánh dấu `complete: true`; (5) `MAX_PROJECT_DURATION_SECONDS` đặt tên theo **nguyên nhân thật** (guard sản phẩm) thay vì "giới hạn encoder" chưa có bằng chứng, và `duration_overflow` nhận discriminator `limitKind` + `extendRootAllowed`. ~183 SP.

  - 2026-08-04 — **Review vòng bốn: 3 blocker + 1 lỗi nhỏ, và toàn bộ 9 OQ được quyết định.** Hai blocker đầu là **cùng một lỗi gốc**: bảng outcome cài agent-kit suy từ trạng thái **trước** operation, nên (a) `current` + `missing` — trường hợp phổ biến nhất, `AGENTS.md` đã cài và một skill mới còn thiếu — không khớp dòng nào, và (b) marker một mình được dùng để khẳng định "đọc được đầy đủ" dù người dùng có thể xoá sạch nội dung mà giữ marker. Sửa bằng: thuật toán suy từ trạng thái **sau** operation với `blocked` định nghĩa qua `usableBy`; `usableBy` thành enum `ready|degraded|blocked`; và **manifest hash bundled trong binary** — không phải lock file trong workspace — để tách `current_pristine` khỏi `current_modified`, cộng state `newer` để binary cũ không hạ cấp agent-kit mới. Blocker 3: project có `vidcom.json` lỗi **không có `ProjectId`** nên mọi AC "vẫn liệt kê, vẫn diagnostics, vẫn xoá được" là không thực hiện được; thêm `invalidKind` và `entryId` opaque theo phiên daemon, với tập operation recovery **đóng**. Lỗi nhỏ: R9.8c luôn trả `composition_parse_error` kể cả khi nguyên nhân là `vidcom.json`. **Quyết định OQ**: OQ-1 SQLite là authority + projection rebuild được, không ghi ngược · OQ-2 chỉ commit `project-context.md` với bốn ràng buộc determinism · OQ-3 `projectLogRetentionDays` 0…365, mặc định 14 · OQ-4/OQ-6 chạy spike với tiêu chí PASS tường minh (§7.1/§7.2) · OQ-5 hai preset · OQ-7 cập nhật build-order · OQ-8 chốt toàn bộ agent-kit, cắt R11 trước nếu thiếu capacity · OQ-9 đã duyệt vòng trước. ~188 SP.

  - 2026-08-04 — **Review vòng năm: 2 lỗ logic + 5 điểm lệch văn bản; sửa ở bản 8.** Cả hai lỗ là **do bản 7 tự tạo**, và cùng nằm ở `usableBy`: (1) ngưỡng `blocked` viết là "không host nào `ready`", nên **hai host cùng `degraded` cũng ra `blocked`** dù cả hai vẫn đọc được một phần — `blocked` phải nghĩa "không ai đọc được gì", không phải "không ai hoàn hảo"; (2) `usableBy` suy từ **state của một file** nên sai hai chiều: `AGENTS.md` bị xoá sạch nội dung mà giữ marker vẫn ra `degraded` (thật ra `blocked`), và sau `link` thì file chính vẫn `foreign` nên `link` **không đổi được gì** — tức một operation không có lý do tồn tại. Sửa bằng **effective instruction chain**: usability là "có chuỗi xác minh được tới router `/vidcom` hay không", không phải state của một file. Thêm: `hosts` bắt buộc và không rỗng (bỏ lời gọi không tham số vốn mâu thuẫn với "cài theo host được chọn"), và bỏ operation recovery thứ năm "nhận lại project" vì nó mơ hồ và đọc được thành tự ghi đè `vidcom.json`. Dọn 5 điểm lệch: "hai cơ chế" → ba · "còn mở OQ-6" · authority "chưa chốt" trong main spec · lịch 6 vs 6–7 tuần · Approval Gate vừa nói "chỉ còn hai spike" vừa để ba dòng "cần xác nhận". ~190 SP.

  - 2026-08-04 — **Spike render (gate OQ-4) đã chạy.** Bằng chứng và script tái lập: [`spikes/phase-3-render/README.md`](../../../../spikes/phase-3-render/README.md). Kết luận **ba câu, MUST NOT gộp thành "6/6 PASS"**: **feasibility PASS có điều kiện** (đường render chạy đầu-cuối, không cần viết lại R6) · **artifact safety PASS, cleanup FAIL** (đã có AC xử lý) · **runtime Node 24.9.0 còn chờ xác minh**. Hai tiêu chí quan trọng nhất trả về thông tin không đoán được: (a) **tiêu chí 4 pass nhờ cơ chế không phải bảo đảm** — Windows không kill process con khi cha chết; cả 6 descendant chết theo vì đóng pipe (Chrome mất CDP, FFmpeg mất stdin), nên R6.6b vẫn phải kill cả cây tường minh và chỉ báo `cancelled` **sau khi xác minh** không còn descendant; (b) **tiêu chí 5 tách hai nửa trái nhau** — nửa nguy hiểm (công bố artifact nhầm) pass sạch nhờ checkpoint `artifact validated` trước khi move file, nhưng nửa dọn rác fail **không bị chặn**: cả huỷ lẫn crash leak work dir ~1 MB, và render thành công không dọn orphan của lần trước (đo: 3 orphan trước → 3 sau). Hệ quả: **bốn AC đã thêm vào R6** — R6.6b (kill cây + verify + `cleanupPending`), R6.7b (thu hồi **chỉ** thư mục thoả bốn điều kiện: prefix xác định, marker sở hữu, quá cutoff, không thuộc job đang chạy — **không quét `TEMP` chung**), R6.14 (`bestEffort` mặc định `true`, warning vào job metadata và tới client), R6.15 (remote **media** asset → `remote_asset_not_local`, là AC riêng vì lý do determinism, không ghép vào `bestEffort`). Kèm một giới hạn phải nói ra ở R6.15b: **cả ba project mẫu nạp GSAP từ CDN**, nên cấm mọi HTTP(S) ở giai đoạn này sẽ làm cả ba không render được — R6.15 **thu hẹp** lỗ determinism chứ không đóng nó; đóng hẳn thuộc Giai đoạn 4. Phát hiện phụ có giá: R6.12 đã khả thi sẵn (lỗi nêu tên từng binary, fail trước khi launch Chrome) và PK-7 có đường vào sẵn (`HYPERFRAMES_FFMPEG_PATH`).

  - 2026-08-04 — **Bản 9 + kiểm Node 24.9.0.** Đã sửa bốn blocker contract cuối: remote media phủ cả CSS `url(...)`, script/stylesheet/font remote bắt buộc `reproducible:false`; `install_agent_kit` thành discriminated union và tách `operationResult`/`installationState`; diagnostics `entryId` không ghi projection khi chưa có `ProjectId`; cleanup dùng render root có marker theo job và grace constant 3600 s. Node 24 chạy đủ render/narration/ffprobe/cancel/crash: 6 descendant → 0 sống, không artifact; orphan 1.04 MB bị giam đúng dưới root sở hữu khi truyền `TEMP`/`TMP`. Bảng SP cộng đúng 190 và lịch sửa thành 7–8 tuần. Còn gate ma trận host và xác nhận Goals.

  - 2026-08-04 — **Bản 10 + spike host thật.** Với fixture tổng hợp và MCP probe: Codex CLI 0.146.0 PASS `.agents/skills`, FAIL `.claude/skills`; Claude Code 2.1.220 cho kết quả ngược lại. Cả hai PASS frontmatter `x-vidcom-agent-kit`. Claude PASS import `@CLAUDE.vidcom.md`; Codex discover router nhưng trả `LINK_NOT_FOLLOWED` cho dòng `Read and follow ./AGENTS.vidcom.md.`. Hệ quả: manifest tách theo host, `link` chỉ còn cho Claude, Codex dùng `manual_merge`. Spike cũng bác giả định bản 8 rằng file chỉ dẫn chính hỏng luôn làm host `blocked`: router skill native vẫn gọi MCP độc lập, nên trường hợp đó là `degraded`; chỉ router không discover/parse mới là `blocked`. Gate kỹ thuật đóng, còn xác nhận Goals tường minh.

## Spec Review

- **Completed**: chưa bắt đầu.
- **Demo**: chưa bắt đầu.
- **Feedback**: chưa bắt đầu.

## Spec Retrospective

- **Well**: chưa bắt đầu.
- **Not Well**: chưa bắt đầu.
- **Improvements**: chưa bắt đầu.

## Next Spec Adjustments

- **Changes**: chưa bắt đầu.
- **Carry-over**: chưa bắt đầu.
- **Lessons**:
  - Đã áp ngay ở bản 1: **đọc code trước khi tin build-order**. Ba trong chín mục của Giai đoạn 3 đã xong trước khi spec mở, một mục (NT-3) xong một nửa. Không kiểm thì spec này thừa ~30 SP làm lại thứ đang chạy.
  - Đã áp ở bản 2: **chốt mô hình sản phẩm trước khi viết acceptance criteria**. Bản 1 giả định workspace là `projects/` trong repo và project luôn có composition. Cả hai đều sai so với sản phẩm thật, và cái sai đó lan vào 11 requirement chứ không nằm ở một chỗ.
  - Build-order §Giai đoạn 3/4 hiện **lệch** với spec này (3.3/3.4a/3.9 đã xong; AK-1..3/4/5/6/8 đã lên Giai đoạn 3). [doc 13 §4](../../../product-features/13-backend-requirements.md) cảnh báo đúng tình huống này: hai bản lộ trình sẽ lệch nhau. Cần cập nhật build-order — xem OQ-7.
  - Bản 3 cho thấy một luật đáng giữ cho các spec sau: **mỗi lần mô hình sản phẩm rõ thêm một tầng, kiểm lại các quyết định lưu trữ đã chốt.** Field `agentKit` trong `vidcom.json` đúng ở bản 1–2 và sai ở bản 3, không vì ai sai mà vì đích cài đổi từ project sang workspace. Ba lần lộ ra ba chỗ steering phải sửa (07 §2, 07 §6, 14 §8) — steering viết dưới giả định cũ thì cũng mục như agent-kit mục.
  - Bản 4 thêm ba bài học, cả ba đến từ review chứ không từ việc viết:
    - **Trước khi thêm một file để theo dõi state, hỏi xem có luật nào làm state đó không cần tồn tại.** `skills-lock.json` sinh ra để trả lời "file này người dùng sửa chưa"; luật *không bao giờ ghi đè* làm câu hỏi đó biến mất. Sổ sách là cách đắt nhất để giải một bài toán mà một invariant giải được miễn phí.
    - **Dữ liệu dẫn xuất mà dùng chung bộ đếm với dữ liệu nguồn thì tự vô hiệu hoá.** Nó không crash, không đỏ test — chỉ là cache lúc nào cũng stale và không ai tìm ra vì sao. Spec sau MUST hỏi "ghi cái này có làm cái nó mô tả đổi không" cho **mọi** dữ liệu dẫn xuất.
    - **Một tài liệu tự nhận "không có mâu thuẫn" thì phải kiểm được, không phải tick được.** Bản 3 tick ô đó trong khi đang mang bốn mâu thuẫn từ M5. Checklist chỉ có giá trị khi từng ô trỏ tới một chỗ cụ thể trong tài liệu — ô nào không trỏ được thì nó là lời tự khen.
  - Bản 5 thêm hai bài học, và cả hai đắt hơn ba bài trên vì chúng nói về **cách sửa**, không về cách viết:
    - **Sửa một bug khái niệm ở một chỗ không có nghĩa là đã sửa nó.** Bản 4 tách content revision khỏi `state.json`/`context/**` rồi để `snapshots/**` và `renders/**` ở lại tập cũ — cùng một bug, cùng một tài liệu, một tầng sâu hơn. Khi phát hiện một lớp phân loại sai, MUST liệt kê **toàn bộ** thành viên của lớp đó và phân loại lại từng cái, không sửa những cái vừa được nêu tên trong finding.
    - **Suy một outcome từ trạng thái TRƯỚC operation là sai nguồn, không phải thiếu dòng.** Bản 5 và 6 đều cố bịt bảng outcome cài agent-kit bằng cách thêm dòng, và cả hai lần đều còn tổ hợp không khớp. Nguyên nhân không phải bảng thiếu — nó là bảng hỏi sai câu: "trước khi cài, tập file ở trạng thái nào" thay vì "sau khi cài, harness dùng được không". Khi một bảng phân nhánh phải thêm dòng lần thứ hai, MUST kiểm lại nó đang suy từ **nguồn** nào trước khi thêm dòng thứ ba.
    - **Đặt tên một ngưỡng theo nguyên nhân mình chưa kiểm là tạo ra một luật vật lý giả.** Bản 5 gọi 3600 giây là "hard limit của runtime/encoder" mà không có bằng chứng FFmpeg hay Chromium giới hạn ở đó. Hệ quả không phải một bug — nó là người sau đọc và tin rằng nới ngưỡng đó là bất khả thi. Ngưỡng nào do ta chọn thì MUST đặt tên theo lý do ta chọn (`MAX_PROJECT_DURATION_SECONDS`, guard tài nguyên), để nó còn là một quyết định xem lại được.
    - **Một luật tuyệt đối là dấu hiệu cần kiểm, không phải dấu hiệu đã xong.** Bản 4 viết hai luật "không bao giờ" ("không đường nào ghi đè", "version không thể lệch với nội dung") và cả hai đều có ngoại lệ nằm cách đó vài dòng. Luật tuyệt đối làm tài liệu đọc dứt khoát hơn thực tế, và ngoại lệ bị đẩy xuống chỗ khác thay vì được thiết kế. Chỗ nào viết "luôn" hay "không bao giờ", MUST grep lại chính tài liệu xem mình có tự phá nó không.
