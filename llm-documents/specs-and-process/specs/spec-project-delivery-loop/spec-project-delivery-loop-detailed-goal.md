# Spec Project Delivery Loop — Detailed Goals

> **Reference**: [Main Spec File](./spec-project-delivery-loop-pending.md)
> **Bản 10 — 2026-08-04.** Đóng spike host bằng hai CLI thật: Codex 0.146.0 chỉ discover `.agents/skills`, Claude Code 2.1.220 chỉ discover `.claude/skills`; cả hai chấp nhận frontmatter `x-vidcom-agent-kit`. Claude theo được `@CLAUDE.vidcom.md`, Codex không theo dòng `Read and follow ./AGENTS.vidcom.md.`. Hệ quả: manifest cài tách theo host; `link` chỉ còn cho Claude; Codex nhận hướng dẫn merge thủ công. Bằng chứng còn cho thấy router native vẫn hoạt động khi file chỉ dẫn chính không thuộc VidCom, nên `blocked` được quyết định bởi router skill, còn file chỉ dẫn chung phân biệt `ready` với `degraded`. Gate kỹ thuật đã đóng; chỉ còn xác nhận Goals tường minh.
> **Bản 9 — 2026-08-04.** Xử lý finding cuối trước Design: contract `install_agent_kit` thành discriminated union và tách `operationResult` khỏi trạng thái cài; diagnostics qua `entryId` không ghi projection khi chưa có `ProjectId`; render workdir dùng root sở hữu theo job với grace constant; remote media phủ cả CSS `url(...)`, còn external script/stylesheet/font làm artifact `reproducible: false`; sửa FFprobe, ước lượng và lịch. Kiểm chứng render tiêu chí 1–5 trên Node 24.9.0 đã PASS theo đúng phạm vi spike, gồm crash trong temp root có marker. Ma trận host vẫn chờ quyền chạy hai CLI SaaS thật.
> **Bản 8 — 2026-08-04.** Sửa hai lỗ logic bản 7 tự tạo và dọn năm điểm lệch văn bản. (1) **`degraded` bị tính thành `blocked`**: ngưỡng viết là "không host nào `ready`", nên hai host cùng `degraded` ra `blocked` dù cả hai vẫn đọc được một phần. Ngưỡng đúng là `blocked` — `blocked` nghĩa *"không ai đọc được gì"*, không phải *"không ai hoàn hảo"*. (2) **`usableBy` suy từ state của một file là sai nguồn**: `AGENTS.md` bị xoá sạch nội dung mà giữ marker vẫn là `current_modified` nhưng host thật ra `blocked`; và sau `link` thì file chính vẫn `foreign` trong khi host đã dùng được. Đổi sang **effective instruction chain** — nhờ đó `link` mới thay đổi được `usableBy`, tức mới có lý do tồn tại (R13.9b, 9b-i, 9e-i). (3) `hosts` **bắt buộc và không rỗng**, bỏ lời gọi không tham số vốn mâu thuẫn với "cài theo host được chọn" (R12.9–9-iii). (4) Bỏ operation recovery thứ năm "nhận lại project" — mơ hồ và đọc được thành tự ghi đè `vidcom.json` (R1.2c-iv). (5) Dọn: "hai cơ chế" → ba · "còn mở OQ-6" → đã chốt cách quyết định · authority trong main spec · lịch 6 vs 6–7 tuần · Approval Gate vừa nói "chỉ còn hai spike" vừa để ba dòng "cần xác nhận".
> **Bản 7 — 2026-08-04.** **Chín OQ đã đóng** (§7): bảy bằng quyết định, hai (OQ-4 render, OQ-6 thư mục skill) bằng *quyết định chạy spike* với tiêu chí PASS tường minh ở §7.1/§7.2. Sửa ba blocker, hai trong đó là cùng một lỗi gốc — **suy outcome cài agent-kit từ trạng thái TRƯỚC operation**: (1) thuật toán outcome viết lại theo trạng thái **sau** operation, loại trừ lẫn nhau, và `blocked` định nghĩa bằng `usableBy` chứ không bằng đếm file (R13.9a); `usableBy` thành enum `ready|degraded|blocked`. (2) Marker một mình không chứng minh nội dung còn nguyên, nên thêm **manifest hash bundled trong binary** (không phải lock file trong workspace) → sáu state per-file, tách `current_pristine`/`current_modified`, và thêm `newer` để một binary cũ không hạ cấp agent-kit mới. (3) Project `vidcom.json` lỗi **không có `ProjectId`** để gọi các đường được phép; thêm `invalidKind` (`identity`/`composition`) và **`entryId`** opaque theo phiên daemon cho đúng tập operation recovery (R1.2c-i…2c-iv). Cộng: R9.8c trả đúng `invalidReason.code` thay vì luôn `composition_parse_error`.
> **Bản 6 — 2026-08-04.** **OQ-9 duyệt**: `explicit > cwd-có-marker > active > cwd`, ghi vào steering/07 §3. Bịt năm lỗ còn hở của bản 5: (1) cwd-có-marker xét **sự có mặt** của `vidcom.json`, không xét tính hợp lệ — marker lỗi MUST NOT làm app nhảy sang active workspace khác (R1.2e); active không đọc được thì cảnh báo rồi fallback (R1.10c). (2) `invalid` có **mã ổn định** + line/column và một **bảng hành vi dùng chung** — diagnostics vẫn chạy, render/snapshot/mutation từ chối `project_invalid`, không bao giờ tự sửa `index.html` (R1.2c–2d, R6.2c, R7.2c, R9.8c). (3) `cwd-solo` phải xác nhận **trước khi ghi**, vì "tool được gọi tường minh" không đồng nghĩa "người dùng biết" (R1.5c). (4) Snapshot partial gắn với **`partialAtSourceRevision`** — source đổi giữa hai lần thì sinh lại toàn bộ, không trộn hai generation (R7.9b–9e). (5) `MAX_PROJECT_DURATION_SECONDS` là **guard sản phẩm**, không phải giới hạn encoder, và `duration_overflow` có discriminator `limitKind` (R10.5b–5d).
> **Bản 5 — 2026-08-04.** Sửa 8 finding vòng review thứ hai. Ba cái nặng nhất là **do bản 4 tự tạo ra**: (1) `contentRevision` xếp `snapshots/**` và `renders/**` vào tập làm revision tiến — tức tái tạo đúng bug nó vừa sửa, một tầng sâu hơn; đổi thành **`sourceRevision`** đếm *input render*, kèm bảng phân loại và một câu hỏi kiểm được (§3). (2) Ba outcome cài agent-kit không phủ hết trạng thái — một bản **đã cài đúng** bị báo `blocked`; thay bằng **bốn state per-file** (`missing`/`current`/`outdated`/`foreign`) và một bảng suy outcome 6 dòng (R13.9a), cộng `usableBy` theo từng host. (3) "Không có đường code nào ghi đè" mâu thuẫn với append và cờ thay; tách thành **ba operation** `install` / `link` / `replace` với tiền điều kiện riêng (§4.6 Luật 1). Kèm: `invalid` cho `index.html` parse lỗi (R1.2b), **bảng quyết định workspace** thay ba AC chồng nhau (+OQ-9), ngoại lệ `cwd-solo` cho M5 (R1.5b), snapshot `partial` retry được (R7.9b–9c), và ba nguồn giới hạn thời lượng phân biệt (R10.5b).
> **Bản 4 — 2026-08-04.** Sửa 8 finding review vòng một. **Bỏ `skills-lock.json`** theo quyết định người dùng: nó là sổ sách bên ngoài cho một bài toán giải được bằng cấu trúc, và schema của nó xung đột với [`skills-lock.json`](../../../../skills-lock.json) mà tooling skill của người dùng đang dùng. Thay bằng **install không bao giờ ghi đè** + **version marker nhúng trong file đã cài** (§4.6). Kèm bốn sửa nghiệp vụ: tách **content revision** khỏi ghi dẫn xuất (R4.4), **ripple theo từng track** (R10), **kết quả cài phải trung thực** — không báo `installed` khi harness sẽ không đọc được (R13.9–9c), và **zero-scene** được đặc tả ở render/snapshot/diagnostics (R6.2b, R7.2b, R9.8b). Bổ sung bounds cho preset `custom` (R2.4b–4d).
> **Bản 3 — 2026-08-04.** Bổ sung **M5**: agent-kit (`AGENTS.md`, `CLAUDE.md`, thư mục skill dot-dir) cài ở **gốc workspace**, workspace-local, bằng hành động tường minh — không nhân bản xuống từng project, và MUST NOT cài vào `~/.claude`/`~/.codex`. Hệ quả: R13 viết lại quanh scope workspace và nhận thêm AK-6; R12 nhận tool thứ năm `install_agent_kit`; R5 bỏ phần ghi agent-kit vào project; `WriteAuthority` nhận scope thứ hai (§3, R13.11) vì hôm nay **không có đường ghi nào ở cấp workspace**.
> **Bản 2 — 2026-08-04.** Viết lại sau khi chốt mô hình sản phẩm (M1–M4): VidCom là binary chạy ở folder bất kỳ, `vidcom.json` là marker của project, project tồn tại trước khi có nội dung, và giá trị cốt lõi là điều phối harness bằng SKILL. Bản 1 (11 requirement) giả định workspace là `projects/` trong repo và project luôn có composition — cả hai đều sai. Đánh số lại R1–R13.
> Trạng thái: **✅ APPROVED 2026-08-04**. Cả 9 OQ và hai spike Goals đã đóng (§7); Detailed Design đã bắt đầu theo xác nhận tường minh của người dùng.

## Spec Goal

Biến vidcom từ prototype thành công cụ dùng được ở bất cứ đâu: người dùng chạy entrypoint `vidcom` **trong một folder bất kỳ**, **tạo** project với preset platform, để **harness dựng** nội dung qua SKILL và MCP tool, **nghe** narration, **thấy** hình thật, và **xuất** ra MP4. Giai đoạn 3 kiểm entrypoint CLI/executable này; đóng gói Node SEA thành binary phân phối thuộc Giai đoạn 4 (§2).

Kèm hai việc nền: chốt **cấu trúc `vidcom.json` + `.vidcom/`** để project tự mô tả được nó là gì và đã xảy ra chuyện gì; và ship **agent-kit** để Codex/Claude Code biết quy trình dựng video mà người dùng không phải giải thích lại mỗi lần.

---

## Introduction

Giai đoạn 1 dựng nền móng (write authority, job, event, auth). Giai đoạn 2 mở đường cho AI (10 MCP tool, dual-era). Cả hai đều **không sinh ra thứ người dùng mang đi được**, và cả hai đều được viết dưới giả định "workspace là `projects/` trong repo". Giai đoạn 3 sửa cả hai điều đó.

Tài liệu này chuyển 13 nhóm yêu cầu thành acceptance criteria dạng EARS. Nó nói **cái gì** và **vì sao**, không nói **thế nào** — kiến trúc, bảng, endpoint và component thuộc `detailed-design.md`, chưa được phép tạo.

---

## 1. Bối cảnh

### 1.1 Mô hình sản phẩm — nguồn của R1, R3, R5, R12, R13

```
người dùng chạy   vidcom            (entrypoint CLI/executable; đóng gói ở Giai đoạn 4)
                    │
                    ├─ cwd không có vidcom.json  → cwd LÀ workspace
                    │     scan MỘT cấp subfolder → folder nào có vidcom.json là một project
                    │
                    └─ cwd CÓ vidcom.json        → workspace là folder CHA
                          project đang mở = cwd, vào studio thẳng
```

**Một workspace, hai phía cùng nhìn vào nó.** Người dùng mở `c:/abc/bdf` → `bdf` là workspace của VidCom **và** của Codex/Claude Code. Harness chỉ đọc chỉ dẫn ở gốc workspace, nên agent-kit phải nằm ở đó:

```
c:/abc/bdf/                       ← workspace: cả VidCom và harness cùng coi đây là gốc
├── AGENTS.md   .agents/skills/   ← bộ Codex (khi host `codex` được chọn)
├── CLAUDE.md   .claude/skills/   ← bộ Claude Code (khi host `claude-code` được chọn)
├── my-tiktok-video/  vidcom.json ← project
└── client-explainer/ vidcom.json ← project

  runtime:  harness ──MCP──▶ VidCom daemon        (gọi tool, đọc/ghi project)
  học việc: harness ──đọc──▶ AGENTS.md + skills   (biết gọi tool nào, theo thứ tự nào)
```

Hai đường này **khác nhau và cả hai đều cần**: MCP là cách harness *làm*, agent-kit ở workspace là cách harness *biết phải làm gì*. Tool schema nói tool làm gì; skill nói ghép chúng thành một ý định của người dùng ([steering/14 §6](../../../steering/14-agent-kit-and-skills.md#6-skill-vs-mô-tả-tool-vs-mcp-prompt)).

> **Skill nào?** Đây là skill để **dùng** VidCom (dựng video qua MCP), MUST NOT lẫn với skill để **phát triển** VidCom (`.agents/skills/bun`, `hono`… của repo này). Hai loại instruction, hai đối tượng đọc — [steering/14 §1](../../../steering/14-agent-kit-and-skills.md#1-hai-loại-instruction--must-not-lẫn) đã tách và spec này giữ đúng ranh giới đó.

| # | Tính chất | Requirement |
|---|---|---|
| M1 | `vidcom.json` là **marker** của project, không chỉ là file identity | R1, R3 |
| M2 | Workspace là folder người dùng mở, **kể cả khi trống** | R1 |
| M3 | Project tồn tại hợp lệ **trước khi** có nội dung (`empty` → `authored`) | R1, R5 |
| M4 | Giá trị cốt lõi là **điều phối harness bằng SKILL**, không phải editor | R12, R13 |
| M5 | Agent-kit cài ở **gốc workspace**, không nhân bản xuống từng project; cài bằng **hành động tường minh**, không tự ghi lúc khởi động | R13 |

### 1.2 Cái gì đã có — để không làm lại

Ba mục của build-order Giai đoạn 3 **đã xong**:

| Đã xong | Ở đâu | Hệ quả |
|---|---|---|
| TTS thật, duration thật, word timing, mount audio vào preview/render | [`synthesize-narration.ts`](../../../../packages/core/src/usecase/synthesize-narration.ts), `buildCompositionDocument()`, [doc 07 §TTS thật](../../../product-features/07-feature-narration-tts.md#tts-thật-2026-08-03) | R6 (render) **thừa hưởng tiếng** miễn là dùng đúng document builder duy nhất (P3). MUST NOT dựng đường build thứ hai |
| Sửa script **không** regenerate TTS, chỉ đánh `staleSince` | [`project-writes.ts:236`](../../../../packages/core/src/usecase/project-writes.ts#L236) | Bug narration #2 của [doc 12 §E](../../../product-features/12-mock-vs-real.md) đã đóng. Còn bug #1 (chỉ lấy `script[0]`) → R11 |
| Allowlist asset + Range + chặn `AGENTS.md`/`package.json`/dotfile | [`path-policy.ts`](../../../../packages/core/src/domain/path-policy.ts), [`project-reads.ts:50-91`](../../../../packages/server/src/routes/project-reads.ts#L50-L91) | SE-2 và FA-8 đã đóng. R4 phải nới policy cho `.vidcom/` **mà không** mở lại lỗ đã bịt. Lưu ý: policy đang chặn `agents.md` — R13 ghi `AGENTS.md` ở **gốc workspace** (không vào project, M5) nên cần đường riêng ở scope riêng |

Nền móng spec này **dựa vào và MUST NOT viết lại**: `WriteAuthority.mutateComposite()` · `JobScheduler` + `JobStorePort` · `EventOutboxPort` + SSE `/api/v1/events` · `bootstrapProject()` · Tool Registry protocol-agnostic của Phase 2.

### 1.3 Cái gì phải đổi — khoảng cách với mô hình

| Mô hình | Code hôm nay | Ở đâu |
|---|---|---|
| Có `vidcom.json` → là project | Marker là `hyperframes.json` **+** `index.html`; thiếu `vidcom.json` hợp lệ thì project bị **loại khỏi danh sách** | [`workspace-fs.ts:39-58`](../../../../packages/adapter/src/fs/workspace-fs.ts#L39-L58) |
| Mở được folder trống | cwd chỉ hợp lệ nếu **đã có** subfolder chứa marker cũ; không có → `selection_required` → **throw** | [`workspace-selection.ts:17-21`](../../../../packages/cli/src/workspace-selection.ts#L17-L21), [`workspace-resolver.ts:23`](../../../../packages/core/src/domain/workspace-resolver.ts#L23) |
| Project rỗng vẫn hợp lệ | `readProjectRefAt()` đòi `index.html` mới trả ref | [`workspace-fs.ts:44`](../../../../packages/adapter/src/fs/workspace-fs.ts#L44) |
| Agent-kit ship vào workspace | [`packages/agent-kit/`](../../../../packages/agent-kit/) **rỗng** — hai file `.gitkeep` | — |
| Quy trình 9 bước gọi 4 tool | `validate_project`, `start_snapshot`, `start_render`, `get_job_status` **không tồn tại** trong Registry 10 tool | [steering/14 §3](../../../steering/14-agent-kit-and-skills.md#3-quy-trình-chuẩn--thứ-agent-phải-theo) |
| Ghi được vào **gốc workspace** | **Không có đường nào.** `resolveProjectPath()` bắt buộc có `ProjectRef` và giam mọi thứ trong `ref.root`; `WriteAuthority` journal mutation theo `projectId`. Ghi `<workspace>/AGENTS.md` không có project để neo vào | [`resolve.ts:64-87`](../../../../packages/adapter/src/fs/resolve.ts#L64-L87) |
| Ghi được dot-dir và `AGENTS.md` | `isGloballyBlocked()` chặn mọi segment bắt đầu bằng `.`; `agents.md`/`claude.md` nằm trong `PROTECTED_FILES` | [`path-policy.ts:30-56`](../../../../packages/core/src/domain/path-policy.ts#L30-L56) |

---

## 2. Phạm vi

### Trong phạm vi

R1 workspace & marker · R2 preset platform · R3 `vidcom.json` · R4 `.vidcom/` · R5 project CRUD + nhận candidate · R6 render MP4 · R7 snapshot + contact sheet · R8 thumbnail Home · R9 diagnostics · R10 scene insert/ripple/validate · R11 narration nhiều đoạn · R12 **năm** MCP tool mới · R13 agent-kit.

### Ngoài phạm vi — nói tường minh để khỏi tranh luận lúc thực thi

| Không làm | Vì sao / đi đâu |
|---|---|
| Node SEA, nhúng frontend vào binary, bỏ Next | PK-6/PK-7 — Giai đoạn 4. Spec này giao và kiểm cùng entrypoint `vidcom` ở dạng CLI/executable; binary phân phối là dependency tương lai, không phải deliverable của Giai đoạn 3 |
| Directory picker server-driven + token flow | PK-3 — Giai đoạn 4. Spec này chỉ dùng cwd và `--workspace` |
| Workspace lock/lease, single-writer daemon qua IPC | PK-4 — Giai đoạn 4. Lease per-workspace đã có ở Phase 1 và được dùng nguyên trạng |
| Cài agent-kit vào thư mục **của host** (`~/.claude/skills`, config Codex toàn máy) | Ngoài — spec này chỉ cài vào **gốc workspace**, một đường dẫn đã biết. Đoán layout toàn máy của từng host là bài toán khác |
| Nhân bản agent-kit xuống **từng project** | Ngoài theo quyết định người dùng 2026-08-04: chỉ cài ở workspace. `AGENTS.md`/`CLAUDE.md` đang có trong 3 project prototype **không bị chạm tới** |
| MCP prompt (`agent-kit/prompts/`) | AK-7 — Giai đoạn 4 |
| Agent chạy **trong** app (PTY, streaming, diff preview) | AI-1..AI-14 — Giai đoạn 6. Spec này để người dùng tự chạy Codex/Claude Code ở terminal của họ |
| Duplicate project, import zip/git, export zip | PM-8, PK-12 — Giai đoạn 4 |
| Đổi `sceneId`, duplicate scene, split scene, kéo-thả đổi thứ tự | SC-2/3/6/9 — Giai đoạn 5 |
| Kéo bar/mép trên timeline | SC-7 — Giai đoạn 5. Spec này làm **ripple ở tầng nghiệp vụ**, UI vẫn là form |
| Render caption/highlight từ `words` | Giai đoạn 5 — dữ liệu đã đủ và đã validate |
| Batch render, render cloud, publish, transparent overlay | PR-2/3/4/8 — Giai đoạn 6 |
| Undo/redo cấp composition | CE-8 — Giai đoạn 5 |
| CRUD file/folder, upload asset ảnh/video | FA-1/2/3 — Giai đoạn 5 |
| UI chọn provider/voice TTS | Giai đoạn 5. R11 chỉ chạm **số đoạn**, không chạm chọn giọng |
| Quick fix tự động áp dụng (VD-4) | R9 chỉ **đề xuất** giá trị, người dùng tự áp |
| Multi-user, auth nhiều tài khoản, quota | Local-first, một người một máy |

### Ranh giới dễ hiểu sai

- **R6 render dùng lại document builder của preview.** Không có "render pipeline riêng". Preview lệch render là bug, không phải trade-off (P3).
- **R7 snapshot không phải cache.** `snapshots/` là nội dung project ([steering/07 §2](../../../steering/07-data-and-storage.md#2-quy-tắc-phân-loại--hỏi-một-câu)), MUST NOT chuyển sang app-data.
- **R9 diagnostics chỉ đọc.** Không sửa gì, không ghi gì vào workspace ngoài bản cache trong `.vidcom/`.
- **R10 ripple là nghiệp vụ, không phải UI.** Một request, nhiều scene, **một** revision.
- **R13 ship chỉ dẫn, không ship agent.** Agent-kit là file văn bản đi vào **gốc workspace**; harness vẫn do người dùng tự chạy ở terminal của họ.
- **MCP và agent-kit là hai kênh khác nhau, không thay nhau được.** MCP là cách harness *làm* (gọi tool, chịu cưỡng chế của server). Agent-kit là cách harness *biết phải làm gì*. Một luật an toàn MUST được server cưỡng chế, MUST NOT chỉ nằm trong `AGENTS.md` — không phải host nào cũng đọc file ([steering/14 §6](../../../steering/14-agent-kit-and-skills.md#6-skill-vs-mô-tả-tool-vs-mcp-prompt)).

---

## 3. Data and Persistence Scope

- **Persisted data involved**:
  - *Gốc workspace (public, người dùng sở hữu)*: manifest của host được chọn — Codex: `AGENTS.md` + `.agents/skills/**`; Claude Code: `CLAUDE.md` + `.claude/skills/**` — agent-kit để **dùng** VidCom (R13). **Không có file lock nào**: version nằm trong marker của chính các file đã cài (§4.6).
  - *Trong project (public, người dùng sở hữu)*: `vidcom.json` (**marker + cấu hình khai báo**), `.vidcom/**` (state per-project — R4), `index.html` + `compositions/*.html` (timing/mount khi insert/ripple), `snapshots/**`, `renders/**`, `narration/*.json` (nhiều cue/scene).
  - *App-data (hidden, vận hành)*: bảng `job` (render/snapshot), revision + audit + event của mọi mutation, `project_registration`, `active_workspace`, backup trước thao tác destructive.
- **Data ownership**: workspace cho chỉ dẫn dùng chung; project cho artifact; app-data cho state vận hành có tính giao dịch. Bốn khái niệm MUST NOT lẫn — `~/.vidcom/setting.json` là **máy/người dùng** ([steering/07 §0](../../../steering/07-data-and-storage.md#0-cấu-hình-người-dùng--vidcomsettingjson)), `<workspace>/AGENTS.md` + skill là **chỉ dẫn cho harness**, `vidcom.json` là **project khai báo**, `.vidcom/` là **project vận hành**.
- **Lifecycle**:
  - `vidcom.json` — tạo khi tạo project hoặc khi người dùng **nhận** một candidate; cập nhật khi đổi preset hoặc render/narration default. **Không** mang version agent-kit (§4.2); xoá nó nghĩa là project **không còn là project**.
  - `.vidcom/` — tạo lúc mở project lần đầu; log rotate theo ngày, có retention; xoá được bằng tay và hệ thống dựng lại phần dựng lại được, MUST NOT crash.
  - Agent-kit ở gốc workspace — ghi **chỉ khi người dùng hoặc harness gọi tường minh**; operation mặc định `install` **không bao giờ ghi đè** file đã tồn tại và MUST NOT chạy lại lúc khởi động ([steering/14 §8](../../../steering/14-agent-kit-and-skills.md#8-cài-đặt-vào-workspace-người-dùng)). `replace` và Claude-only `link` là operation riêng, đòi host/đích tường minh + `expectedContentHash`; `replace` chỉ áp dụng file có marker VidCom và không bao giờ áp dụng `foreign`/`newer` (§4.6, R12.9).
  - `renders/` — người dùng xoá được; xoá MP4 MUST NOT làm job history mâu thuẫn.
  - `snapshots/` — bị **đánh dấu stale** khi composition đổi, không bị xoá tự động.
  - Xoá project — MUST tạo backup restore được trước khi chạm đĩa, ghi đường dẫn backup vào audit.
- **Consistency requirements**:
  - Mọi ghi vào đĩa của người dùng đi qua **một** `WriteAuthority` — kể cả ghi ở gốc workspace. Ripple, tạo project, insert scene, cài agent-kit = **một** composite mutation, **một** revision. MUST NOT sinh installer ghi vòng ngoài authority ([steering/07 §4](../../../steering/07-data-and-storage.md#4-ghi-file--quy-tắc-cứng)).
  - `WriteAuthority` nhận **scope thứ hai**: `workspace` bên cạnh `project`. Scope workspace vẫn atomic, vẫn precondition content hash, vẫn audit; revision neo vào workspace chứ không vào `projectId`.
  - **`sourceRevision` đếm *input của render*, không đếm "mọi thứ đã ghi".** Câu hỏi phân loại là một câu duy nhất và nó kiểm được: *"đổi file này thì byte của bản render tiếp theo có khác không?"*

    | Vào `sourceRevision` (input) | Không vào (output dẫn xuất) |
    |---|---|
    | `index.html`, `compositions/**` | `snapshots/**` |
    | `assets/**` | `renders/**` |
    | `narration/*.wav` + `narration/*.json` | `.vidcom/state.json`, `.vidcom/context/**` |
    | `preview-settings.json` | `.vidcom/**/*.jsonl`, `.vidcom/cache/**` |
    | `vidcom.json` (preset đổi kích thước render) | |

    Mọi thứ ở cột phải đi qua `WriteAuthority` để có atomic + audit, nhưng **MUST NOT làm `sourceRevision` tiến**.
    `sourceRevision` chỉ định danh **input local** trong bảng. IF render quan sát external script/stylesheet/font HTTP(S) được phép theo R6.15b THEN sidecar SHALL mang `reproducible: false` và danh sách URL; cam kết “cùng revision → cùng output” chỉ áp dụng khi `reproducible: true`. MUST NOT dùng một `sourceRevision` local để tuyên bố determinism cho byte CDN không nằm trong project.
  - **Vì sao `snapshots/**` và `renders/**` phải ở cột phải.** Bản 4 xếp chúng vào cột trái và tự tạo lại đúng cái bug nó vừa sửa: snapshot tính trên revision N → ghi ảnh vào `snapshots/` → revision thành N+1 → snapshot **vừa tạo xong đã stale** theo R7.6. Nặng hơn: chạy render sẽ làm snapshot cũ đi dù composition không đổi một byte. Chúng là **kết quả** của việc đọc input, không phải input — dùng một bộ đếm cho cả hai thì bất kỳ output nào cũng vô hiệu hoá mọi output khác. Cùng lỗi, một tầng sâu hơn (R4.4, R7.5, R7.6, R9.9).
  - Slug project unique trong workspace; `ProjectId` unique toàn cục; đổi tên **giữ nguyên `ProjectId`**.
  - Precondition bắt buộc: content hash cho file, revision cho entity. `vidcom.json` chịu cùng luật.
  - Job render/snapshot có idempotency key; **`maxAttempts: 1`** cho render (output không byte-deterministic).
- **Query and reporting needs**: list project trong workspace kèm preset, state (`empty`/`authored`/`invalid`), thumbnail, `updatedAt`, `sceneCount`, `renderStatus`; list candidate chưa nhận; list render theo thời gian giảm dần; diagnostics filter theo `severity`/`sceneId`; job history của một project đọc từ `.vidcom/`.
- **Volume and growth assumptions**: 10–100 project/workspace; 5–50 scene/project; 1–20 MP4/project (10–200 MB); ~1 PNG/scene; log `.vidcom/` cỡ KB/ngày. Một người dùng, một máy — không có yêu cầu đồng thời cao.
- **Migration/backfill expectations**:
  - **Luật marker đổi** — đây là migration lớn nhất của spec. Mọi fixture test Phase 1/2 dựng project theo marker cũ MUST được rà lại; fixture cũ vẫn xanh trong khi hành vi đã khác là rủi ro chính (xem Risks).
  - `vidcom.json` từ `{ id }` → schema có version: **MUST backfill lúc bootstrap**, suy preset từ `data-width`/`data-height`. Ba project hiện có (`kinetic-type`, `swiss-grid`, `warm-grain`) đều đang ở dạng `{ id }` — test case thật.
  - `.vidcom/` tạo mới, không migration.
  - Narration một-cue → nhiều-cue (R11): sidecar cũ MUST đọc được như **một cue duy nhất**; MUST NOT vứt file cũ.
  - Bảng `job` nhận thêm type `render`, `snapshot` — kiểm check constraint có phải table-rebuild như Phase 2 đã gặp.
  - `AGENTS.md`/`CLAUDE.md` đã tồn tại trong 3 project prototype — theo quyết định "chỉ cài ở workspace", R13 **không chạm tới chúng**. Chúng là file của người dùng và ở ngoài phạm vi agent-kit.
  - Nếu gốc workspace đã có file chỉ dẫn chính của host do người dùng sở hữu THEN R13 MUST NOT ghi đè. Sau khi router skill cài đúng, host SHALL là `degraded` và outcome `partial`, không phải `blocked`; Claude có thể `link` file phụ, Codex chỉ trả recovery `manual_merge` (R13.9–9e).
  - Gốc workspace có thể **đã có `skills-lock.json`** của tooling skill riêng của người dùng — repo này là một ví dụ thật, và schema của nó (`{ version, skills: { <tên>: { source, sourceType, computedHash } } }`) không tương thích với bất kỳ thứ gì agent-kit cần. VidCom **MUST NOT đọc, ghi, hay merge vào file đó**. Đây là lý do bản 4 bỏ hẳn khái niệm lock file: không có file, không có xung đột.
- **Audit and compliance needs**: mọi mutation ghi audit với `actor`. Xoá project là destructive → backup + audit + approval grant nếu đến từ MCP (MP-7). `.vidcom/logs/` MUST NOT chứa secret — MUST NOT log nội dung `~/.vidcom/setting.json`, API key, hay bearer credential.

---

## 4. Cấu trúc file per-project — bản chốt để document hoá

> Người dùng yêu cầu tường minh: *"tôi cần structure trước cấu trúc các file này để document hoá nó"*. Đây là bản chốt ở phase Goals; zod schema và kiểu chi tiết thuộc Design.

### 4.1 Bốn vùng, đừng lẫn

| Vùng | Đường dẫn | Là gì | Git |
|---|---|---|---|
| Cấu hình máy/người dùng | `~/.vidcom/setting.json` | API key, workspace root, TTS default toàn máy. **Đã có**, spec này không chạm | — |
| Chỉ dẫn cho harness | Codex: `<workspace>/AGENTS.md` + `.agents/skills/**`; Claude Code: `<workspace>/CLAUDE.md` + `.claude/skills/**` | Agent-kit để **dùng** VidCom, chỉ cài manifest của host được chọn. **Workspace-local**, MUST NOT cài vào `~/.claude` hay `~/.codex` | **commit** |
| Cấu hình project (khai báo) | `<project>/vidcom.json` | **Marker** + preset, kích thước, render/narration default | **commit** |
| State project (vận hành) | `<project>/.vidcom/` | Job history, revision index, log, diagnostics cache, ngữ cảnh cho harness | phần lớn **ignore** |

Câu hỏi phân loại của [steering/07 §2](../../../steering/07-data-and-storage.md#2-quy-tắc-phân-loại--hỏi-một-câu) — *"copy folder sang máy khác, thiếu file này thì render có khác không?"* — cho: `vidcom.json` **có**, `.vidcom/` **không**. Đó cũng chính là chỗ spec này đi ngược steering; xem R4 và OQ-1.

### 4.2 `vidcom.json`

```json
{
  "schemaVersion": 1,
  "id": "project_01JQ8Z9K3M4N5P6Q7R8S9T0V",
  "platform": {
    "presetId": "vertical-shorts",
    "orientation": "vertical",
    "aspectRatio": "9:16",
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "targets": ["tiktok", "instagram-reels", "youtube-shorts"],
    "recommendedMaxDurationSeconds": 180
  },
  "render": {
    "defaultPresetId": "h264-source-fps",
    "outputDirectory": "renders"
  },
  "narration": {
    "defaultProviderId": "vieneu",
    "defaultVoiceId": "vieneu-v3-pham-tuyen"
  },
  "createdAt": "2026-08-04T09:00:00.000Z",
  "updatedAt": "2026-08-04T09:00:00.000Z"
}
```

> **Không có field `agentKit`.** Bản 1 và 2 dự kiến giữ chỗ cho nó ở đây theo AK-4. Quyết định 2026-08-04 (agent-kit cài ở **gốc workspace**, một bản dùng chung) làm chỗ đó sai: để version trong `vidcom.json` nghĩa là N project khai N version cho **một** bản đã cài — mâu thuẫn có sẵn từ ngày đầu. Bản 4 đi thêm một bước: version cũng **không** nằm trong một file lock ở workspace, mà nằm trong **marker của chính các file agent-kit** (§4.6) — version đi cùng nội dung nó mô tả thì không thể lệch. [Steering/14 §8](../../../steering/14-agent-kit-and-skills.md#8-cài-đặt-vào-workspace-người-dùng) đã được đồng bộ theo quyết định này sau Goals approval.

Luật:

- **File này là marker.** Có nó → folder là project. Không có nó → không phải project, dù có `hyperframes.json` (M1).
- **Schema strict, có version.** Key lạ → lỗi nêu tên field, MUST NOT bỏ qua im lặng. Cùng luật với `~/.vidcom/setting.json`.
- `id` giữ nguyên hành vi hiện có ([`bootstrap-project.ts`](../../../../packages/core/src/usecase/bootstrap-project.ts)) — không đổi khi di chuyển folder, cấp lại khi phát hiện trùng.
- `platform.width/height/fps` là **bản sao có chủ đích** của `data-*` trên `index.html`. `data-*` vẫn là nguồn sự thật (P1); `vidcom.json` là **ý định đã khai**. Lệch nhau → **diagnostic**, không tự sửa (R9.5).
- `narration.default*` **không** ghi đè `~/.vidcom/setting.json` về provider khả dụng; nó chỉ chọn mặc định *trong* những gì máy có. Máy không có provider đó → lỗi rõ ràng, MUST NOT âm thầm đổi giọng.
- MUST NOT chứa secret. Schema strict không có chỗ cho chúng.

### 4.3 Catalog preset — hai cái, cộng `custom`

| `presetId` | `orientation` | Aspect | Kích thước | fps | Nhắm tới |
|---|---|---|---|---|---|
| `vertical-shorts` | `vertical` | 9:16 | 1080×1920 | 30 | TikTok, Instagram Reels, YouTube Shorts |
| `horizontal-youtube` | `horizontal` | 16:9 | 1920×1080 | 30 | YouTube long-form |
| `custom` | suy từ kích thước | suy | giữ nguyên | giữ nguyên | — (project cũ / kích thước lạ) |

Hai preset, không phải sáu. Người dùng nêu đúng hai hướng; thêm 1:1 và 4:5 là suy diễn chưa ai yêu cầu. Catalog là **dữ liệu** — thêm preset về sau không phải sửa code gọi.

### 4.4 Trạng thái của một project

| State | Nghĩa | Xác định bằng |
|---|---|---|
| `empty` | Có `vidcom.json`, chưa có composition. Chờ harness dựng | `vidcom.json` hợp lệ, không có `index.html` |
| `authored` | Có composition parse được | `vidcom.json` hợp lệ + `index.html` parse được |
| `invalid` | Có `vidcom.json` nhưng nội dung không parse được | `vidcom.json` lỗi, hoặc `index.html` lỗi |
| `candidate` | **Không phải project** — có `hyperframes.json`, chưa có `vidcom.json` | chờ người dùng nhận |

`empty` là trạng thái mới, chưa từng tồn tại trong code. Mọi đường đọc hôm nay được bảo đảm có `index.html` để parse; nhánh "chưa có gì" phải có mặt ở **diagnostics, snapshot, render, thumbnail** — bốn chỗ ít ai mở và dễ quên nhất.

**`authored` không đồng nghĩa với "có scene".** `authored` chỉ nói `index.html` parse được; nó có thể chứa **0 scene**, và đó là trạng thái **hợp lệ** — [steering/03 §2.1](../../../steering/03-architecture-ddd.md) nói rõ `rootDuration = 0` khi không còn scene nào và invariant `duration > 0` MUST NOT áp cho root, vì người dùng phải xoá được scene cuối cùng. Nên có **ba** trạng thái nội dung, không phải hai:

| Nội dung | Render | Snapshot | Diagnostics |
|---|---|---|---|
| `empty` — không có `index.html` | từ chối `no-composition` (R6.2) | từ chối `no-composition` (R7.2) | `no-composition`, thông tin (R9.8) |
| `authored`, 0 scene | từ chối `no-scenes` (R6.2b) — root duration 0, không có gì để encode | **thành công rỗng** (R7.2b): 0 ảnh, không contact sheet, `sceneCount: 0` | `no-scenes`, thông tin (R9.8b) |
| `authored`, ≥1 scene | đường thường | đường thường | đường thường |

Hai cột giữa **khác nhau có chủ đích**: snapshot của một composition rỗng là một tập rỗng — một câu trả lời đúng. Render của nó là một file 0 giây — một artifact vô nghĩa mà người dùng sẽ tưởng là bug của render.

### 4.5 `.vidcom/`

```text
<project>/.vidcom/
├── .gitignore              ignore mọi thứ TRỪ context/project-context.md (OQ-2)
├── state.json              state hiện tại của project (một file, ghi có journal)
├── context/
│   ├── project-context.md  digest cho harness: preset, scene, duration, narration, vấn đề đang mở
│   └── diagnostics.json    kết quả R9 lần chạy gần nhất, kèm revision nó được tính trên
├── jobs/
│   ├── index.jsonl         append-only: một dòng một chuyển trạng thái job
│   └── <jobId>.json        input, outcome, artifact path, thời lượng của một job
├── revisions/
│   └── index.jsonl         append-only: revision, path, contentHash, actor, timestamp, summary
├── logs/
│   └── <YYYY-MM-DD>.jsonl  structured log per-project, rotate theo ngày, có retention
└── cache/
    └── parse/<contentHash>.json   parse cache — dựng lại được, xoá lúc nào cũng an toàn
```

`state.json`:

```json
{
  "schemaVersion": 1,
  "projectId": "project_01JQ8Z9K3M4N5P6Q7R8S9T0V",
  "state": "authored",
  "sceneCount": 6,
  "lastOpenedAt": "2026-08-04T09:00:00.000Z",
  "sourceRevision": 42,
  "snapshots": { "computedAtSourceRevision": 40, "sceneCount": 6, "complete": true, "partialAtSourceRevision": null, "missingSceneIds": [] },
  "lastRender": { "jobId": "job_01JQ...", "status": "done", "artifact": "renders/2026-08-04-1080x1920.mp4", "computedAtSourceRevision": 41 },
  "diagnostics": { "computedAtSourceRevision": 42, "errorCount": 0, "warningCount": 3 },
  "pendingRecovery": []
}
```

`sourceRevision` là revision của **input render** mới nhất (§3 — bảng phân loại). Mọi khối dẫn xuất ghi `computedAtSourceRevision` — giá trị `sourceRevision` mà nó được tính trên. Stale là một phép so, **không** phải một cờ được lưu:

```
stale  ⇔  computedAtSourceRevision < sourceRevision
```

Không lưu cờ `stale` vì cờ phải được ai đó cập nhật, và cái không được cập nhật thì nói dối. Phép so thì không thể lệch.

Và vì **không** output nào — `state.json`, `context/**`, `snapshots/**`, `renders/**` — làm `sourceRevision` tiến, một output không thể tự làm mình cũ và cũng không thể làm output khác cũ. Render xong thì snapshot vẫn tươi; snapshot xong thì bản render vẫn khớp. Đó là tính chất phải có, không phải tối ưu.

Luật ghi — **ba lớp, không một lớp**:

| Nhóm | File | Đường ghi | `sourceRevision` | Vì sao |
|---|---|---|---|---|
| Input render | `vidcom.json`, `index.html`, `compositions/**`, `assets/**`, `narration/**`, `preview-settings.json` | **Qua `WriteAuthority`**: atomic, precondition, revision, audit, event | **tiến** | Đổi chúng thì byte của bản render tiếp theo khác |
| Output artifact | `snapshots/**`, `renders/**` | **Qua `WriteAuthority`**: atomic, precondition, audit, event | **KHÔNG tiến** | Là *kết quả* của việc đọc input. Làm revision tiến ở đây khiến mỗi output vô hiệu hoá mọi output khác |
| State + ngữ cảnh (dẫn xuất) | `state.json`, `context/**` | **Qua `WriteAuthority`**: atomic, precondition, audit, event | **KHÔNG tiến** | Bị đọc để ra quyết định nên phải atomic. Nhưng chúng *mô tả* input, không *là* input |
| Nhật ký append-only | `jobs/index.jsonl`, `revisions/index.jsonl`, `logs/*.jsonl` | Append atomic, **không** revision cho từng dòng | **KHÔNG tiến** | Một revision cho mỗi dòng log là biến journal thành log — sai công cụ, và giá là mỗi tick tiến độ render tốn một transaction |
| Cache | `cache/**` | Ghi thoải mái, xoá thoải mái | **KHÔNG tiến** | Dựng lại được |

Ranh giới **authority** (nguồn sự thật) — **đã chốt** (OQ-1, 2026-08-04):

- **SQLite trong app-data là authority và engine giao dịch**: revision + audit + event + grant commit trong **một** transaction. Đó là điều kiện `mutateComposite` đang dựa vào và MUST NOT bỏ.
- `.vidcom/revisions/` và `.vidcom/jobs/` là **projection bền, đọc được bởi người và harness**, ghi trong cùng mutation flow. Chúng trả lời "chuyện gì đã xảy ra với project này" **offline** — đúng mục tiêu người dùng nêu.
- Projection **lệch** phải phát hiện được (R4.8) và **rebuild được từ SQLite** (R4.8b).
- Projection **MUST NOT ghi ngược** vào SQLite theo bất kỳ đường nào. Đây là chỗ ranh giới có thể bị mờ dần: một tính năng "đọc lại lịch sử từ `.vidcom/` khi SQLite thiếu" nghe hợp lý và biến projection thành authority thứ hai. Dual-authority không có "nguồn nào đúng" — chỉ có hai nguồn cùng tự tin.

### 4.6 Gốc workspace — agent-kit để dùng VidCom

```text
<workspace>/
├── AGENTS.md               chỉ dẫn dùng VidCom (Codex đọc)
├── CLAUDE.md               bản sao byte-for-byte của AGENTS.md (Claude Code đọc)
├── .agents/skills/         ← workspace-local, KHÔNG phải ~/.claude hay ~/.codex
│   ├── vidcom/SKILL.md            router — entry point
│   ├── vidcom-project/SKILL.md    tạo / mở / cấu trúc project
│   ├── vidcom-scene/SKILL.md      scene: tạo, timing, text, thứ tự
│   ├── vidcom-look/SKILL.md       tone, palette, subtitle, BGM
│   ├── vidcom-narration/SKILL.md  TTS và caption
│   ├── vidcom-render/SKILL.md     snapshot, render, job
│   └── vidcom-fix/SKILL.md        đọc diagnostics và sửa
├── my-tiktok-video/        project
└── client-explainer/       project
```

**Đích cài là workspace-local, dứt khoát.** Skill nằm trong folder người dùng đang mở, đi cùng workspace khi họ copy hay commit nó. MUST NOT cài vào `~/.claude`, `~/.codex`, hay bất kỳ đường dẫn toàn máy nào — VidCom không sở hữu cấu hình host của người dùng, và một skill ghi vào đó sẽ theo họ sang mọi project không liên quan.

#### Không có lock file — hai luật thay thế nó

Bản 1–3 dự kiến một `skills-lock.json` giữ hash từng file để biết cái nào người dùng đã sửa. **Bỏ** theo quyết định người dùng 2026-08-04, vì hai lý do và cả hai đều đúng:

1. **Nó xung đột với tooling đang có.** Gốc workspace có thể đã có `skills-lock.json` của tooling skill riêng của người dùng — [repo này là một ví dụ thật](../../../../skills-lock.json), schema `{ version, skills: { <tên>: { source, sourceType, computedHash } } }`, không tương thích với thứ agent-kit cần. Hai tooling tranh một tên file là bài toán không đáng có.
2. **Nó là sổ sách cho một bài toán giải được bằng cấu trúc.** Lock file tồn tại để trả lời "file này người dùng đã sửa chưa". Nhưng nếu install **không bao giờ ghi đè**, câu hỏi đó không cần trả lời.

Hai luật thay nó:

**Luật 1 — `install` chỉ tạo file thiếu.** Đây là luật của **một** operation, không phải của cả hệ thống. Bản 4 viết "không có đường code nào ghi đè" rồi ngay sau đó cho phép append (R13.9e) và cờ thay (R13.10) — tự mâu thuẫn. Sửa bằng cách tách **ba operation phân biệt**, mỗi cái có tiền điều kiện riêng; spike §7.2 giới hạn `link` vào đúng host có import native:

| Operation | Chạm file đã tồn tại? | Tiền điều kiện | Ai gọi được |
|---|---|---|---|
| `install` | **Không, bao giờ** | không cần | CLI + `install_agent_kit` (mặc định) |
| `link` | **Có** — append `@CLAUDE.vidcom.md` vào `CLAUDE.md` | yêu cầu tường minh **+** `expectedContentHash` của file đích | **chỉ Claude Code**; Codex không có import tương đương đã được kiểm chứng |
| `replace` | **Có** — thay toàn bộ nội dung | yêu cầu tường minh **+** `expectedContentHash` **+** file đích **phải có marker** | chỉ khi người dùng yêu cầu |

Ba luật cứng bao quanh bảng này:

- `install` là **mặc định** và là thứ duy nhất `install_agent_kit` làm khi **không truyền `operation`** — riêng shape `install` bắt buộc `hosts` không rỗng (R12.9-i). `link` pin `host: "claude-code"`; `replace` chọn đúng một host và một `relativePath`; ba shape MUST NOT trộn field. Gọi lại `install` bao nhiêu lần cũng không ghi đè gì (R12.10).
- `link` và `replace` **MUST NOT** xảy ra như tác dụng phụ. Chúng là operation riêng, người dùng phải yêu cầu, và chúng mang `expectedContentHash` để không ghi lên một phiên bản khác với phiên bản người dùng đã xem.
- `replace` **MUST NOT** chạm file **không có marker**. File không marker là file người dùng viết; không có tình huống nào VidCom được phép thay nó. Muốn vậy thì người dùng tự xoá.

AK-5 vì thế không dựa vào "không tồn tại đường ghi đè" — nó dựa vào: **đường duy nhất ghi lên file đã có đều đòi người dùng nói ra, kèm hash họ đã xem.**

**Luật 2 — Version nằm trong file nó mô tả.** Mỗi file agent-kit mang một marker:

```markdown
<!-- vidcom-agent-kit: 3.0.0 -->        ← AGENTS.md, CLAUDE.md
```
```yaml
---
name: vidcom-scene
x-vidcom-agent-kit: 3.0.0               ← mỗi SKILL.md, trong frontmatter đã có
---
```

**Marker một mình chỉ chứng minh version nguồn lúc cài, KHÔNG chứng minh nội dung còn nguyên.** Người dùng xoá sạch nội dung một `SKILL.md` mà giữ dòng marker thì marker vẫn nói version hiện tại — và bản 6 dựa vào đó để kết luận "đọc được đầy đủ". Đó là khẳng định sai.

Cần thêm **một** thông tin, và nó **không** phải lock file trong workspace: binary đã mang sẵn nội dung nguồn, nên nó cũng mang được **manifest hash của chính nội dung bundled đó**:

```ts
// nhúng trong binary lúc build — mô tả nội dung của BINARY, không phải state của workspace
{
  "AGENTS.md":                        "sha256:…",
  ".agents/skills/vidcom/SKILL.md":   "sha256:…"
}
```

Khác `skills-lock.json` ở đúng chỗ quan trọng: manifest này **không sống trong folder người dùng**, không cần đồng bộ, không xung đột với tooling nào, và không thể cũ — nó là một phần của binary. Nó trả lời *"nội dung này có đúng bằng bản tôi ship không"*, không trả lời *"người dùng đã sửa gì"*.

Với marker + manifest, có **sáu** trạng thái per-file, loại trừ lẫn nhau:

| Trạng thái file | Điều kiện | `install` làm gì |
|---|---|---|
| `missing` | Không có file | **Ghi** |
| `current_pristine` | Marker = version binary **và** hash khớp bản bundled | Không làm gì. Đây là trạng thái duy nhất chứng minh được "đọc được đầy đủ" |
| `current_modified` | Marker = version binary nhưng hash **khác** bản bundled | Không chạm. Người dùng đã sửa — nội dung có thể đã rỗng |
| `outdated` | Marker **thấp hơn** version binary | Không ghi đè. Báo có bản mới + đường `replace` |
| `newer` | Marker **cao hơn** version binary | Không chạm. Một binary cũ MUST NOT hạ cấp agent-kit mới hơn — đây là trạng thái bản 6 thiếu, và nó rơi vào `foreign` hoặc `outdated`, cả hai đều xử lý sai |
| `foreign` | Không có marker VidCom hợp lệ | Không chạm, không bao giờ. File người dùng viết |

**Ba** câu hỏi, **ba** cơ chế — MUST NOT gộp:

| Câu hỏi | Trả lời bằng | Dùng ở |
|---|---|---|
| *"File này của ai, version nào?"* | marker | phân loại 6 state |
| *"Nội dung có đúng bản tôi ship?"* | manifest hash bundled | tách `current_pristine` khỏi `current_modified` |
| *"Nội dung có đúng bản người dùng vừa xem?"* | `expectedContentHash` người dùng truyền vào | tiền điều kiện của `link` Claude và `replace` |

Cái mất: **refresh tự động**. Lên bản mới là `replace` tường minh, hoặc xoá file rồi `install`. Chấp nhận được — refresh im lặng vào folder người dùng là thứ họ không nhờ, và một agent-kit cũ vẫn hoạt động chứ không hỏng.

**Tên thư mục skill — đã chốt bằng spike thật** (OQ-6, §7.2). Codex dùng `<workspace>/.agents/skills/`; Claude Code dùng `<workspace>/.claude/skills/`. Cài theo `hosts` được chọn (R13.7-i) và MUST NOT ép một thư mục chung: cả hai host đều từ chối thư mục của host kia trong phép thử kích hoạt native + MCP probe.

---

## 5. Requirements

### Requirement 1 — Mở VidCom ở folder bất kỳ; `vidcom.json` là marker

**User Story:** Là người dùng, tôi muốn chạy `vidcom` trong folder bất kỳ và mọi folder con có `vidcom.json` tự hiện ra là một project, để bắt đầu làm video ở chỗ tôi muốn mà không phải khai báo gì.

#### Bảng quyết định workspace — một chuỗi ưu tiên duy nhất

Bản 4 để R1.1, R1.4 và R1.10 chồng điều kiện lên nhau: "mọi cwd đọc được đều là workspace" mâu thuẫn với "cwd có marker thì workspace là cha" và với "explicit/active thắng cwd". Thay bằng **một** bảng, đọc từ trên xuống, dòng đầu khớp thì thắng:

Thứ tự đã chốt (OQ-9 **duyệt** 2026-08-04):

```
explicit  >  cwd có vidcom.json (kể cả marker lỗi)  >  active đã lưu  >  cwd thông thường
```

Đọc bảng từ trên xuống, dòng đầu khớp thì thắng:

| # | Điều kiện | Workspace | Project mở sẵn | `source` |
|---|---|---|---|---|
| 1 | `--workspace` / `VIDCOM_WORKSPACE` trỏ tới thư mục **đọc được** | đúng thư mục đó | không | `explicit` |
| 2 | `--workspace` có mặt nhưng không đọc được | — | — | **lỗi**, nêu đường dẫn (R1.11) |
| 3 | cwd **có file** `vidcom.json` — hợp lệ **hoặc lỗi** — và cha của cwd đọc được | **cha** của cwd | **cwd** (state `authored`/`empty`/**`invalid`**) | `cwd-project` |
| 4 | cwd **có file** `vidcom.json` — hợp lệ **hoặc lỗi** — và cha không đọc được | **cwd** | **cwd** | `cwd-solo` (R1.5) |
| 5 | active workspace đã lưu, còn đọc được | active | không | `active` |
| 6 | active workspace đã lưu nhưng **không còn đọc được** | rơi xuống dòng 7 | không | **cảnh báo**, không im lặng (R1.10c) |
| 7 | cwd đọc được | cwd | không | `cwd` |
| 8 | còn lại | — | — | **lỗi**, nêu đường dẫn và lý do |

**Dòng 3–4 xét *sự có mặt* của `vidcom.json`, không xét tính hợp lệ của nó.** Đây là chỗ bản 5 hở: nếu chỉ nhận marker hợp lệ thì một `vidcom.json` bị lỗi cú pháp sẽ làm cwd **rơi xuống dòng 5** và app âm thầm mở một workspace khác. Người dùng đang đứng trong project của họ, gõ `vidcom`, và được đưa tới một chỗ hoàn toàn khác — với nguyên nhân thật (một dấu phẩy sai trong `vidcom.json`) không xuất hiện ở đâu cả. Marker hỏng là **tín hiệu vẫn đọc được**: nó nói "đây là một project", chỉ không nói được project nào.

**Dòng 3–4 nằm trên dòng 5**, theo [steering/07 §3](../../../steering/07-data-and-storage.md#3-workspace-root--cwd-là-input-tường-minh-không-là-dependency-ngầm) đã đồng bộ sau Goals approval. `cd` vào một folder project là tín hiệu **tường minh**, không phải fallback; active workspace là thứ lưu từ phiên trước nên nó là fallback.

#### Acceptance Criteria

1. WHEN VidCom khởi động THEN hệ thống SHALL resolve workspace theo **đúng** bảng trên AND SHALL quét **một cấp** thư mục con của workspace để tìm project.
2. WHEN một thư mục con chứa `vidcom.json` hợp lệ THEN hệ thống SHALL coi đó là một project, **kể cả khi thiếu `index.html` hoặc `hyperframes.json`** AND SHALL gán state `empty`, `authored` hoặc `invalid` theo §4.4.
2b. IF `vidcom.json` hợp lệ AND `index.html` **tồn tại nhưng không parse được** THEN hệ thống SHALL gán state `invalid` kèm lý do parse, SHALL liệt kê project trong danh sách, AND MUST NOT tự sửa file, MUST NOT loại nó khỏi danh sách im lặng (PM-7).
2c. WHEN một lý do `invalid` được trả về THEN nó SHALL mang **mã ổn định** — `composition_parse_error` cho `index.html`, `identity_parse_error` cho `vidcom.json` — kèm `line`/`column` **nếu parser cung cấp**, AND MUST NOT trả raw stack trace hay message của thư viện parse. Stack trace không giúp người dùng sửa HTML của họ và nó lộ đường dẫn nội bộ; một mã ổn định thì client dịch được và test khoá được.
2c-i. WHEN state là `invalid` THEN payload SHALL mang `invalidKind` phân biệt **hai** nguyên nhân, vì chúng khác nhau ở một điểm quyết định: có `ProjectId` hay không.

   | `invalidKind` | Nguyên nhân | Identity đọc được? | Định danh dùng để gọi |
   |---|---|---|---|
   | `composition` | `vidcom.json` **hợp lệ**, `index.html` parse lỗi | có | `ProjectId` bình thường |
   | `identity` | chính `vidcom.json` parse lỗi | **không** | `entryId` (R1.2c-iii) |

   ```json
   { "projectId": "project_…", "state": "invalid",
     "invalidKind": "composition",
     "invalidReason": { "code": "composition_parse_error", "line": 42, "column": 7 } }
   ```
   ```json
   { "entryId": "entry_…", "projectId": null, "slug": "my-video", "state": "invalid",
     "invalidKind": "identity",
     "invalidReason": { "code": "identity_parse_error", "line": 3, "column": 12 } }
   ```

2c-ii. WHEN `invalidKind` là `composition` THEN project SHALL dùng `ProjectId` bình thường cho diagnostics, đổi tên và xoá — identity vẫn đọc được nên không có gì đặc biệt.
2c-iii. WHEN `invalidKind` là `identity` THEN hệ thống SHALL cấp một **`entryId`** để gọi các đường recovery, AND MUST NOT bịa một `ProjectId` rồi ghi ngược vào file đang lỗi. `entryId` là opaque token với đúng bốn tính chất:

   - Chỉ sống trong **phiên daemon** hiện tại; không bền, không lưu.
   - **Không** phải path, và MUST NOT decode được thành path bởi client ([steering/07 §10](../../../steering/07-data-and-storage.md#10-project-id): path MUST NOT là ID).
   - **Không** phải `ProjectId`, và MUST NOT được nhận ở chỗ đòi `ProjectId`.
   - Server tự ánh xạ nó tới đường dẫn **đã qua containment check**, đúng như với `ProjectId`.

   Sau khi identity được sửa thành công, `entryId` **hết hiệu lực** và item nhận `ProjectId` thật.

   > Đây là chỗ bản 6 hở logic: nó yêu cầu liệt kê project khi `vidcom.json` parse lỗi, và cho phép diagnostics/đổi tên/xoá — nhưng khi JSON lỗi thì không đọc được `id`, mà mọi đường đó đều đang nhận `projectId`. Không có `entryId` thì AC không thực hiện được, và lối thoát duy nhất còn lại là **cấp `ProjectId` giả rồi ghi vào file đang lỗi** — tức ghi đè dữ liệu người dùng ở đúng lúc họ cần nó nhất để sửa.

2c-iv. WHEN một operation nhận `entryId` THEN nó SHALL chỉ thuộc tập **recovery**, và tập đó SHALL đóng ở **đúng bốn** operation:

   | Operation | Tiền điều kiện |
   |---|---|
   | Đọc diagnostic identity | — |
   | Thay `vidcom.json` | `expectedContentHash` |
   | Đổi tên | — |
   | Xoá | approval grant (R5.8) |

   Render, snapshot, scene mutation và mọi tool nghiệp vụ khác **vẫn bắt buộc `ProjectId`** — MUST NOT đổi toàn bộ API sang locator union chỉ vì một nhánh recovery.

   > Bản 7 có operation thứ năm, "nhận lại project nếu file không cứu được", và nó **bị bỏ**: nó không có semantics rõ ràng và đọc được thành "tự ghi đè `vidcom.json`" — tức đúng thứ R1.2d cấm. Mọi thứ nó định làm đã nằm trong "thay `vidcom.json` với `expectedContentHash`", chỉ khác là đường đó **buộc người dùng nêu hash họ đã xem**. Một cụm từ mơ hồ trong tập recovery nguy hiểm hơn ở chỗ khác, vì recovery là lúc dữ liệu người dùng đã hỏng một phần.
2d. WHEN project ở state `invalid` THEN hành vi SHALL là **một** bộ luật dùng chung cho mọi đường, không phải mỗi endpoint tự quyết:

   | Đường | Hành vi khi `invalid` |
   |---|---|
   | Liệt kê project | **Vẫn xuất hiện**, kèm `invalidKind`, lý do có mã, và `projectId` **hoặc** `entryId` (R1.2c-i) |
   | Diagnostics (R9) | **Vẫn chạy**, và trả đúng `invalidReason.code` — đây là chỗ người dùng đi tìm nguyên nhân, nên nó MUST NOT là đường bị chặn |
   | Render (R6), Snapshot (R7) | **Từ chối** với `project_invalid` |
   | Mutation phụ thuộc composition (R10 insert/ripple, set text, set timing) | **Từ chối** với `project_invalid` |
   | Mutation **không** phụ thuộc composition (sửa `vidcom.json`, đổi tên, xoá project) | Vẫn cho — đổi tên hay xoá một project hỏng là đúng thứ người dùng cần làm. Với `invalidKind: "identity"` thì qua `entryId` (R1.2c-iv) |
   | Bootstrap / tự sửa | **MUST NOT** ghi đè `index.html` hay `vidcom.json`, MUST NOT "sửa hộ", MUST NOT bootstrap đè lên chúng |

   > Bản 5 chỉ đặc tả đường `empty` và `authored`-0-scene ở R6/R7; `invalid` không có đường nào. Không có bảng này thì mỗi endpoint tự đoán, và cái dễ đoán sai nhất là diagnostics — chặn nó nghĩa là chặn đúng công cụ dùng để tìm ra vì sao project hỏng.
2e. IF cwd có `vidcom.json` **lỗi** THEN hệ thống SHALL vẫn chọn workspace theo dòng 3/4 của bảng AND SHALL mở project đó ở state `invalid` kèm lý do — MUST NOT rơi xuống active workspace. Một marker hỏng MUST NOT làm app âm thầm nhảy sang workspace khác: nguyên nhân thật (một dấu phẩy sai) sẽ không xuất hiện ở đâu, còn triệu chứng thì là "app mở sai chỗ".
3. WHEN workspace không chứa project nào (kể cả thư mục hoàn toàn trống) THEN hệ thống SHALL mở thành công với danh sách rỗng và đường tạo project đầu tiên — MUST NOT trả `selection_required`, MUST NOT throw. *(Đóng lỗ chặn đứng tại [`workspace-selection.ts:17-21`](../../../../packages/cli/src/workspace-selection.ts#L17-L21) và [`workspace-resolver.ts:23`](../../../../packages/core/src/domain/workspace-resolver.ts#L23).)*
4. WHEN cwd **chính nó có file** `vidcom.json` AND cha của cwd đọc được THEN hệ thống SHALL nhận thư mục **cha** làm workspace AND SHALL mở cwd làm project đang hoạt động (bảng, dòng 3) — kể cả khi marker đó lỗi (R1.2e).
5. IF cwd có file `vidcom.json` AND thư mục cha không đọc được (cwd là root, hoặc không có quyền) THEN hệ thống SHALL nhận cwd làm **workspace-của-một-project** AND SHALL vẫn mở được project đó (bảng, dòng 4).
5b. WHEN ở chế độ `cwd-solo` (R1.5) THEN gốc workspace và gốc project **là cùng một thư mục**, nên cài agent-kit ở "gốc workspace" đồng nghĩa vật lý với ghi vào gốc project. Đây là **ngoại lệ được chấp nhận** của M5, không phải vi phạm: invariant của M5 là *"một bản agent-kit cho mỗi workspace, không nhân bản"* — trong chế độ này workspace **là** một project nên vẫn đúng một bản, không có nhân bản.
5c. WHEN cài agent-kit ở chế độ `cwd-solo` THEN hệ thống SHALL yêu cầu xác nhận **trước khi ghi byte đầu tiên**, không phải cảnh báo sau khi ghi:
   - **CLI / UI**: hiện đường dẫn đích cụ thể và đòi xác nhận.
   - **MCP**: trả `confirmation_required` — hoặc một acknowledgement riêng cho `cwd-solo` — AND MUST NOT ghi trong lần gọi đầu.

   > Lý do: harness tự gọi `install_agent_kit` **vẫn thoả** "được gọi tường minh" theo R13.8, nhưng con người chưa chắc biết nó đang sắp ghi `AGENTS.md` thẳng vào folder project của họ. "Tường minh với tool" không đồng nghĩa "tường minh với người dùng", và ở chế độ này khoảng cách giữa hai thứ đó là một file lạ xuất hiện trong repo của họ.
6. WHEN một thư mục con chứa `hyperframes.json` nhưng **không** có `vidcom.json` THEN hệ thống SHALL liệt kê nó là **candidate chưa nhận** AND MUST NOT tính là project AND MUST NOT tự ghi bất kỳ file nào vào đó.
7. WHEN người dùng nhận một candidate THEN hệ thống SHALL ghi `vidcom.json` qua `WriteAuthority` với `platform` suy từ kích thước hiện có (R3.4) AND project SHALL xuất hiện trong danh sách.
8. WHEN một thư mục con chứa `vidcom.json` **không parse được** THEN hệ thống SHALL liệt kê nó với state `invalid`, `invalidKind: "identity"`, `projectId: null` và một `entryId` (R1.2c-iii) kèm lý do (PM-7) — AND MUST NOT loại nó khỏi danh sách im lặng, MUST NOT ghi đè file, MUST NOT cấp `ProjectId` giả.
9. WHEN quét workspace THEN hệ thống SHALL bỏ qua `node_modules`, `.git`, `.hyperframes` và mọi thư mục bắt đầu bằng `.` AND MUST NOT quét đệ quy sâu hơn một cấp — project lồng trong project không được tính.
10. WHEN thứ tự ưu tiên workspace được áp dụng THEN hệ thống SHALL theo **đúng bảng quyết định** ở trên và [steering/07 §3](../../../steering/07-data-and-storage.md#3-workspace-root--cwd-là-input-tường-minh-không-là-dependency-ngầm): (a) candidate đọc được là đủ, MUST NOT đòi có project sẵn; (b) thứ tự `explicit > cwd-có-marker > active > cwd`; (c) cwd-có-marker xét sự có mặt, không xét tính hợp lệ (R1.2e). Code MUST NOT lệch văn bản steering đã đồng bộ.
10b. WHEN workspace được resolve THEN hệ thống SHALL báo `source` đã dùng (`explicit` / `cwd-project` / `cwd-solo` / `active` / `cwd`) — người dùng phải biết được **vì sao** app đang mở chỗ này, không phải đoán.
10c. IF active workspace đã lưu **không còn đọc được** (thư mục bị xoá, ổ ngoài bị rút, mất quyền) THEN hệ thống SHALL phát cảnh báo nêu đường dẫn cũ và lý do, rồi fallback xuống dòng tiếp theo của bảng — MUST NOT bỏ qua im lặng. Một workspace biến mất không tiếng nào làm người dùng nghĩ họ mất project, trong khi thật ra chỉ là app đang mở chỗ khác.
11. WHEN `--workspace` trỏ tới đường dẫn không tồn tại hoặc không đọc được THEN hệ thống SHALL báo lỗi nêu rõ đường dẫn AND MUST NOT tự tạo thư mục ([steering/07 §3](../../../steering/07-data-and-storage.md#3-workspace-root--cwd-là-input-tường-minh-không-là-dependency-ngầm)).
12. WHEN workspace có 100+ thư mục con THEN việc quét SHALL không đọc toàn cây của từng project — chỉ những file cần để xác định marker và state.
13. WHEN người dùng đổi sang workspace khác THEN hệ thống SHALL nhả lease của workspace cũ trước khi nhận workspace mới.

### Requirement 2 — Chọn preset platform trước khi project được tạo

**User Story:** Là người dùng, tôi muốn chọn dạng dọc hay ngang trước khi project được tạo, để video được tối ưu cho platform cụ thể thay vì là một video chung chung.

#### Acceptance Criteria

1. WHEN người dùng mở luồng tạo project THEN hệ thống SHALL trình bày catalog preset (§4.3) với ít nhất `vertical-shorts` và `horizontal-youtube`, mỗi mục nêu rõ orientation, kích thước, và platform nó nhắm tới.
2. IF request tạo project không mang `presetId` THEN hệ thống SHALL từ chối với `schema_invalid` nêu `field: "presetId"` AND MUST NOT tạo bất kỳ file hay thư mục nào.
3. WHEN project được tạo với một preset THEN hệ thống SHALL ghi `data-width`/`data-height` của preset vào root composition **và** `platform` tương ứng vào `vidcom.json`, trong **một** revision.
4. WHEN `presetId` là `custom` AND request không mang `width`/`height` THEN hệ thống SHALL từ chối với `schema_invalid`.
4b. IF `presetId` là `custom` AND `width` hoặc `height` không phải số nguyên, **không chia hết cho 2**, nhỏ hơn 128, hoặc lớn hơn 7680 THEN hệ thống SHALL từ chối với `schema_invalid` nêu đúng field và luật bị vi phạm.
4c. IF `presetId` là `custom` AND `fps` không phải số nguyên trong khoảng 1…120 THEN hệ thống SHALL từ chối với `schema_invalid` nêu `field: "fps"`.
4d. WHEN một preset `custom` hợp lệ được nhận THEN hệ thống SHALL suy `orientation` và `aspectRatio` từ `width`/`height` AND SHALL để `recommendedMaxDurationSeconds` là `null` — VidCom không biết platform đích của một kích thước tự khai, và đoán nó là bịa.
   > AC 4b–4d tồn tại vì AC 7 chỉ kiểm catalog **lúc khởi động**. Không có chúng, `custom` là đường vòng cho `0×0`, `1081×1921` hay `fps: 0` — mỗi cái đều được nhận ở đây rồi **fail lúc render**, tức fail xa chỗ gây ra hàng chục phút và một job đã tính phí. Validate ở biên nhận, không ở biên dùng.
5. WHEN người dùng đổi preset của project **đã có scene** THEN hệ thống SHALL cảnh báo tường minh rằng layout tính theo pixel sẽ lệch, AND SHALL chỉ tiến hành sau xác nhận, AND SHALL ghi cả giá trị cũ và mới vào audit.
6. WHEN preset đổi thành công THEN hệ thống SHALL đánh dấu snapshot của project là stale (R7.6).
7. IF một preset trong catalog có kích thước không chia hết cho 2 THEN hệ thống SHALL từ chối preset đó lúc khởi động, vì H.264 không encode được kích thước lẻ.
8. WHEN harness đọc project context THEN preset và orientation SHALL có mặt trong `project-context.md` (R4.3) — agent phải biết nó đang dựng video dọc hay ngang trước khi viết layout.

### Requirement 3 — `vidcom.json` là marker và cấu hình khai báo

**User Story:** Là người dùng, tôi muốn cấu hình project nằm trong folder project, để copy folder sang máy khác vẫn giữ đúng preset và input local. Reproducibility của output chỉ được cam kết khi sidecar render ghi `reproducible: true` (R6.4, R6.15b).

#### Acceptance Criteria

1. WHEN hệ thống đọc `vidcom.json` có key không thuộc schema THEN hệ thống SHALL báo lỗi nêu **tên field** và luật bị vi phạm, AND MUST NOT nêu giá trị (có thể là dữ liệu người dùng), AND MUST NOT bỏ qua field đó.
2. WHEN `vidcom.json` thiếu trong một thư mục THEN thư mục đó SHALL không phải project (R1.6) — MUST NOT tự tạo file để biến nó thành project.
3. WHEN `vidcom.json` tồn tại nhưng **parse lỗi** THEN hệ thống SHALL gán state `invalid` và không mở project đó, AND MUST NOT ghi đè file — chỉ file *sai* mới là lỗi, ghi đè nó là xoá dữ liệu người dùng.
4. WHEN `vidcom.json` thiếu `platform` (project cũ chỉ có `{ id }`, hoặc candidate vừa được nhận) THEN hệ thống SHALL suy `platform` từ `data-width`/`data-height` của root composition — khớp preset trong catalog thì dùng preset đó, không khớp thì `presetId: "custom"`; không có composition thì để `platform` null và gán state `empty` — AND SHALL ghi lại qua đường có journal.
5. WHEN ghi `vidcom.json` THEN hệ thống SHALL đi qua `WriteAuthority` với precondition content hash, atomic, có revision và audit — MUST NOT có đường ghi thứ hai.
6. WHEN `platform.width/height/fps` lệch `data-*` trên `index.html` THEN hệ thống SHALL phát diagnostic `platform-mismatch` (R9.5) AND MUST NOT tự sửa bên nào.
7. WHEN `vidcom.json` được serialize THEN hệ thống SHALL sinh byte deterministic (thứ tự key ổn định, indent 2, newline cuối) để golden file bắt được thay đổi ngoài ý muốn.
8. IF request cố ghi secret vào `vidcom.json` THEN hệ thống SHALL từ chối — schema strict không có chỗ cho chúng.
9. WHEN `schemaVersion` cao hơn version binary hiểu được THEN hệ thống SHALL từ chối mở project với lỗi nêu rõ cần bản VidCom mới hơn AND MUST NOT đọc theo schema cũ rồi ghi đè — đó là cách mất dữ liệu.

### Requirement 4 — `.vidcom/` mang state vận hành của project

**User Story:** Là người dùng dùng Codex/Claude Code, tôi muốn project chứa state, log và ngữ cảnh của chính nó, để harness hiểu project đang ở đâu mà không phải hỏi lại tôi hay dò một database ẩn.

> **Yêu cầu này đi ngược [steering/07 §2 và §6](../../../steering/07-data-and-storage.md#2-quy-tắc-phân-loại--hỏi-một-câu) đang có hiệu lực.** Xung đột đã được nêu và người dùng xác nhận chọn phương án này ngày 2026-08-04. Sửa steering là **deliverable của spec này** (R4.9), không phải việc làm sau.

#### Acceptance Criteria

1. WHEN project được mở lần đầu THEN hệ thống SHALL tạo `.vidcom/` theo cấu trúc §4.5 kèm `.vidcom/.gitignore`.
1b. WHEN `.vidcom/.gitignore` được sinh THEN nó SHALL ignore **mọi thứ trừ** `context/project-context.md` (OQ-2):

   ```gitignore
   *
   !.gitignore
   !context/
   context/*
   !context/project-context.md
   ```

   `state.json` **MUST NOT** được commit — nó chứa `lastOpenedAt`, job ID và state vận hành của một máy cụ thể. `diagnostics.json` cũng ignore: nó dựng lại được và gắn với một `sourceRevision` cụ thể. Harness trên máy khác cần context thì daemon dựng lại lúc mở project.
2. WHEN `.vidcom/` bị người dùng xoá THEN hệ thống SHALL dựng lại phần dựng lại được và tiếp tục chạy, AND SHALL ghi cảnh báo nêu rõ nhật ký lịch sử đã mất — MUST NOT crash, MUST NOT chặn mở project.
3. WHEN state của project đổi THEN hệ thống SHALL cập nhật `context/project-context.md` để harness đọc được: preset và orientation, danh sách scene kèm timing, tổng thời lượng, trạng thái narration từng scene, và các diagnostic đang mở.
3b. WHEN `context/project-context.md` được sinh THEN nó SHALL là file **commit được** (OQ-2), nên nó MUST: deterministic (cùng input → cùng byte) · MUST NOT chứa absolute path · MUST NOT chứa timestamp kiểu "mở lần cuối" · MUST NOT chứa job ID local · MUST NOT chứa secret. Đây là **file duy nhất** trong `.vidcom/` đi vào Git của người dùng, nên nó là file duy nhất phải chịu bốn luật này — bất kỳ giá trị gắn với một máy cụ thể lọt vào đây sẽ thành diff nhiễu ở mọi commit và có thể lộ đường dẫn máy người dùng.
4. WHEN ghi `state.json`, `context/**`, `snapshots/**` hoặc `renders/**` THEN hệ thống SHALL đi qua `WriteAuthority` (atomic, precondition, audit, event) AND MUST NOT làm `sourceRevision` của project tiến — cả bốn đều là **output**, không phải input render (§3). Ghi ra một output MUST NOT làm chính nó, hay một output khác, trở thành cũ.
4b. WHEN một khối dẫn xuất được ghi THEN nó SHALL mang `computedAtSourceRevision` — giá trị `sourceRevision` mà nó được tính trên AND stale SHALL được suy bằng phép so `computedAtSourceRevision < sourceRevision`, MUST NOT lưu thành cờ. Cờ phải được ai đó cập nhật, và cái không được cập nhật thì nói dối.
4c. WHEN quyết định một file có làm `sourceRevision` tiến hay không THEN luật SHALL là một câu hỏi duy nhất: *"đổi file này thì byte của bản render tiếp theo có khác không?"* — AND phân loại đó SHALL được khoá bằng test, không bằng quy ước, vì đây đúng là chỗ bản 4 xếp sai `snapshots/**` và `renders/**`.
5. WHEN ghi `jobs/index.jsonl`, `revisions/index.jsonl` hoặc `logs/*.jsonl` THEN hệ thống SHALL append atomic AND MUST NOT tạo một revision cho mỗi dòng.
6. IF một dòng trong file `.jsonl` bị hỏng (ghi dở do crash) THEN hệ thống SHALL bỏ qua đúng dòng đó khi đọc, ghi cảnh báo, AND SHALL vẫn đọc được các dòng còn lại.
7. WHEN log được ghi THEN hệ thống MUST NOT ghi secret vào đó: API key, bearer credential, nội dung `~/.vidcom/setting.json`, hay body request chứa chúng.
8. WHEN người dùng chạy lệnh đối chiếu THEN hệ thống SHALL so `.vidcom/revisions/index.jsonl` với revision trong SQLite AND SHALL báo mọi chỗ lệch kèm hướng lệch.
8b. WHEN `.vidcom/revisions/` hoặc `.vidcom/jobs/` lệch với SQLite THEN hệ thống SHALL **rebuild projection từ SQLite** AND MUST NOT ghi ngược từ `.vidcom/` vào SQLite theo bất kỳ đường nào (OQ-1). SQLite là authority; `.vidcom/` là projection. Cho projection ghi ngược là tạo dual-authority, và dual-authority không có "nguồn nào đúng" — chỉ có hai nguồn cùng tự tin.
9. WHEN spec này hoàn tất THEN [steering/07-data-and-storage](../../../steering/07-data-and-storage.md) §2 và §6 SHALL được cập nhật kèm Decision Record (Context / Options / Decision / Rationale / Implications) nêu rõ vì sao state per-project được phép nằm trong workspace.
10. WHEN path policy được nới để ghi được vào `.vidcom/` THEN hệ thống SHALL dùng một purpose riêng chỉ cho `.vidcom/` AND MUST NOT bỏ luật chặn dotfile chung — luật đó đang chặn `.env`, `.git` và `.hyperframes`.
11. WHEN `.vidcom/` được resolve THEN hệ thống SHALL vẫn áp containment (canonicalize + resolve symlink) như mọi path khác — nới purpose MUST NOT nới containment.
12. WHEN `logs/` vượt retention THEN hệ thống SHALL xoá file cũ hơn cutoff AND SHALL ghi số file đã xoá. Retention SHALL đọc từ `projectLogRetentionDays` trong `~/.vidcom/setting.json`, mặc định **14**, validate **số nguyên `0…365`**; giá trị `0` nghĩa là không giữ project log (OQ-3). Giá trị ngoài khoảng → lỗi khởi động nêu tên field, đúng luật schema strict của [steering/07 §0](../../../steering/07-data-and-storage.md#0-cấu-hình-người-dùng--vidcomsettingjson).

### Requirement 5 — Tạo, nhận, xoá, đổi tên project

**User Story:** Là người dùng, tôi muốn nút `New video` hoạt động thật và xoá/đổi tên/nhận được project, để không phải chạy CLI và dọn được thử nghiệm thất bại.

#### Acceptance Criteria

1. WHEN người dùng tạo project với tên hợp lệ và một preset THEN hệ thống SHALL tạo thư mục trong workspace đang mở kèm `vidcom.json`, `hyperframes.json`, `preview-settings.json` mặc định và root composition mang kích thước preset — trong **một** composite mutation. MUST NOT ghi `AGENTS.md`, `CLAUDE.md` hay skill vào project: agent-kit chỉ ở gốc workspace (M5).
2. WHEN project được tạo THEN hệ thống SHALL trả về `ProjectId` và slug để vào studio ngay AND state SHALL là `authored`.
3. WHEN tên project sinh ra slug không khớp `[a-z0-9-]+` THEN hệ thống SHALL từ chối với `schema_invalid` nêu `field: "name"`.
4. IF slug đã tồn tại trong workspace THEN hệ thống SHALL từ chối AND MUST NOT ghi vào thư mục đang có.
5. WHEN tạo project thất bại giữa chừng THEN hệ thống SHALL không để lại thư mục nửa vời: hoặc project hoàn chỉnh, hoặc không có gì — AND recovery lúc khởi động SHALL xử lý được trạng thái dở.
6. WHEN người dùng nhận một candidate (R1.7) THEN hệ thống SHALL chỉ ghi `vidcom.json` AND MUST NOT sửa `index.html`, `hyperframes.json`, `AGENTS.md` hay bất kỳ file nội dung nào của người dùng.
7. WHEN người dùng xoá project THEN hệ thống SHALL tạo backup verify được trước khi chạm đĩa, ghi đường dẫn backup vào audit, AND SHALL yêu cầu xác nhận tường minh.
8. IF yêu cầu xoá đến từ MCP THEN hệ thống SHALL yêu cầu approval grant do daemon phát hành, đúng cơ chế MP-7 đã có ở Phase 2.
9. WHEN project bị xoá THEN hệ thống SHALL gỡ registration trong app-data AND SHALL giữ audit + backup — xoá dấu vết của việc xoá là mất khả năng phục hồi.
10. WHEN người dùng đổi tên project THEN hệ thống SHALL đổi slug/thư mục AND SHALL **giữ nguyên `ProjectId`** AND SHALL cập nhật registration — đường dẫn MUST NOT là ID.
11. IF project đang có job chạy (render/snapshot/tts) THEN hệ thống SHALL từ chối xoá và đổi tên, nêu job đang chặn.
12. WHEN project được tạo, nhận, xoá hoặc đổi tên THEN hệ thống SHALL phát event để danh sách project cập nhật qua SSE, không cần reload trang.

### Requirement 6 — Render MP4

**User Story:** Là người dùng, tôi muốn render MP4 ngay trong app, thấy tiến độ, huỷ được, và tải file về.

#### Acceptance Criteria

1. WHEN người dùng yêu cầu render THEN hệ thống SHALL enqueue một job `render` AND SHALL trả về `jobId` ngay, MUST NOT block request.
2. IF project ở state `empty` THEN hệ thống SHALL từ chối render với `no-composition` AND MUST NOT enqueue job.
2b. IF project ở state `authored` nhưng có **0 scene** (root duration bằng 0 — trạng thái hợp lệ theo [steering/03 §2.1](../../../steering/03-architecture-ddd.md)) THEN hệ thống SHALL từ chối render với `no-scenes` AND MUST NOT enqueue job AND MUST NOT sinh file MP4 nào — một video 0 giây là artifact vô nghĩa mà người dùng sẽ đọc thành bug của render.
2c. IF project ở state `invalid` THEN hệ thống SHALL từ chối render với `project_invalid` kèm lý do có mã (R1.2c) AND MUST NOT enqueue job (R1.2d).
3. WHEN job render chạy THEN hệ thống SHALL phát tiến độ có giới hạn (0…1) kèm stage đọc được qua SSE AND SHALL cập nhật `.vidcom/jobs/`.
4. WHEN render hoàn tất THEN hệ thống SHALL ghi MP4 vào `renders/` **và** một sidecar metadata (preset, kích thước, fps, thời lượng, `computedAtSourceRevision`, thời gian chạy, `reproducible`, `externalDependencies`) AND SHALL phát event hoàn tất. Việc ghi này MUST NOT làm `sourceRevision` tiến (R4.4) — bản render vừa xong MUST NOT bị nhãn "không khớp source", và nó MUST NOT làm snapshot của project stale (R7.6b).
5. WHEN người dùng tải bản render THEN hệ thống SHALL serve file với Range request và content type đúng, đi qua đúng allowlist asset đã có.
6. WHEN người dùng huỷ job render THEN hệ thống SHALL **kill process con** (Chromium/FFmpeg) AND SHALL dọn output dở AND SHALL đưa job về `cancelled` — MUST NOT để lại process ăn CPU sau khi UI báo đã huỷ.
6b. WHEN huỷ job render THEN hệ thống SHALL:
   - **kill cả cây process tường minh** — job object trên Windows, process group trên POSIX — AND MUST NOT dựa vào cascade đóng pipe. *(Spike §7.1 tiêu chí 4: cả 6 descendant chết theo khi kill PID cha, nhưng Windows không có ngữ nghĩa đó — chúng chết vì Chrome mất CDP và FFmpeg mất stdin. Hành vi thuận tiện, không phải bảo đảm.)*
   - **chỉ chuyển job sang `cancelled` sau khi xác minh không còn descendant nào sống** — MUST NOT báo `cancelled` rồi mới đi kill. Báo trước là đúng thứ làm người dùng thấy CPU vẫn cháy sau khi UI nói đã xong.
   - **xoá work directory** của job, không chỉ output dở.
   - IF xoá work directory thất bại THEN job SHALL mang `cleanupPending: true` AND việc thu hồi SHALL để recovery xử lý (R6.7b) — MUST NOT retry vô hạn trong đường huỷ, và MUST NOT im lặng bỏ qua.
7. IF daemon crash giữa lúc render THEN recovery lúc khởi động SHALL đưa job về trạng thái cuối xác định được AND MUST NOT để lại MP4 dở dạng trông như hợp lệ.
7b. WHEN bắt đầu render THEN VidCom SHALL tạo một **render root riêng theo job** dưới vùng staging do VidCom sở hữu, ghi marker chứa `jobId` vào root đó, và truyền root cho process con (`TEMP`/`TMP` trên Windows; output staging do VidCom kiểm soát trên POSIX) — HyperFrames không expose workdir ngẫu nhiên của nó nên VidCom MUST NOT cố suy ownership từ tên `hf-render-*`/`work-*` đơn lẻ.

   WHEN recovery thu hồi render root mồ côi THEN nó SHALL xoá **chỉ** root thoả **đồng thời cả bốn** điều kiện, AND MUST NOT quét hay xoá `TEMP` chung:
   1. nằm dưới **render staging root xác định** mà VidCom tự khai;
   2. mang **marker sở hữu của VidCom** với `jobId` hợp lệ ngay tại root theo job;
   3. cũ hơn `RENDER_WORKDIR_ORPHAN_GRACE_SECONDS`, mặc định **3600 giây**;
   4. `jobId` đó **không** thuộc một job đang chạy.

   AND recovery SHALL ghi **số thư mục đã xoá** và **mọi lỗi cleanup**, MUST NOT thất bại im lặng.

   > Bốn điều kiện là bốn tầng bảo vệ khác nhau, không phải một luật viết dài: staging root chặn phạm vi, marker chặn xoá đồ của người khác, cutoff chặn xoá thứ vừa tạo, và "không thuộc job đang chạy" chặn đúng race hay xảy ra nhất — hai daemon, hoặc một recovery chạy trong khi một render đang sống. Đây là cùng hình dạng `BackupPort.cleanupOrphanPayloads(olderThan)` đã có trong Core, nên không phải phát minh mới. Spike Node 24 xác minh việc đặt `TEMP`/`TMP` vào root có marker buộc orphan `hf-render-*` nằm đúng bên trong root đó (§7.1b-i).
   > *(Spike §7.1 tiêu chí 5: đo trực tiếp 3 orphan trước → 3 orphan sau một render thành công. Leak không bị chặn; mỗi lần huỷ và mỗi lần crash để lại ~1 MB vĩnh viễn.)*
8. WHEN job render thất bại THEN hệ thống SHALL giữ nguyên trạng thái thất bại với lý do đọc được AND MUST NOT retry tự động — output không byte-deterministic, retry sinh artifact thứ hai cho một yêu cầu duy nhất (cùng lý do `tts` dùng `maxAttempts: 1`).
9. WHEN render dựng document THEN hệ thống SHALL dùng **đúng** `buildCompositionDocument()` mà preview dùng (P3) AND SHALL bao gồm narration đã mount và preview settings đã áp — preview khớp output là invariant, không phải mục tiêu.
10. IF project chưa bật tone/overlay THEN bản render SHALL giữ body gốc byte-for-byte (P4).
11. WHEN nhiều yêu cầu render cùng project đến cùng lúc THEN hệ thống SHALL giới hạn concurrency theo type AND SHALL không chạy hai render của cùng project song song.
12. IF Chromium, FFmpeg hoặc FFprobe không khả dụng THEN hệ thống SHALL fail với mã lỗi nêu **từng binary nào** thiếu AND MUST NOT báo lỗi chung "render failed". Việc kiểm binary SHALL hoàn tất trước khi launch Chromium.
13. WHEN người dùng xoá file MP4 bằng tay THEN job history SHALL vẫn là `done` AND artifact SHALL được báo `missing` — MUST NOT sửa lịch sử để khớp đĩa.
14. WHEN một job render được enqueue THEN nó SHALL mang `bestEffort`, **mặc định `true`**:
   - `bestEffort: true` — readiness warning (ví dụ `sub_timeline_readiness_timeout`) **không** làm job fail; artifact vẫn được công bố. Warning SHALL được **lưu vào job metadata** AND SHALL được trả về client — MUST NOT chỉ nằm trong stdout của process con.
   - `bestEffort: false` — readiness warning SHALL làm job **fail bằng mã lỗi ổn định** AND artifact MUST NOT được công bố.

   > Mặc định là `true` vì strict **hiện làm project mẫu `warm-grain` thất bại dù output hợp lệ**: project này cảnh báo `sub_timeline_readiness_timeout` (budget 45 s) ở mọi lần render đã đo, mà bản MP4 vẫn đúng 420 frame và audio đúng vị trí (spike §7.1). Chọn `false` làm mặc định nghĩa là ship một sản phẩm không render nổi chính project mẫu đã dùng làm gate.
   > Nhưng warning MUST đi tới client: một cảnh báo chỉ tồn tại trong stdout của child process là một cảnh báo không ai đọc, và nó biến `bestEffort: true` từ "chấp nhận rủi ro có thông báo" thành "bỏ qua rủi ro im lặng".
15. WHEN composition tham chiếu **media asset** qua URL `http(s)` — trong thuộc tính của `<img>`, `<video>`, `<audio>`, `<source>`, trong CSS `url(...)` của HTML hoặc stylesheet local, hoặc qua request image/video/audio quan sát được lúc render — THEN render SHALL từ chối với mã ổn định **`remote_asset_not_local`** nêu đúng URL và nguồn tham chiếu, AND SHALL yêu cầu đưa asset vào `assets/**` — MUST NOT tự tải về work directory. Ba project prototype SHALL được rà và chuyển remote media hiện có sang `assets/**`; cụ thể tối thiểu gồm `warm-grain` `natural-paper.png` trong CSS và MP4 S3 của `kinetic-type`.

   Lý do là **determinism**, không phải bảo mật hay hiệu năng: `sourceRevision` (§3) đếm byte của input trong project. Một media asset ở URL remote có thể **đổi nội dung mà `sourceRevision` không đổi** — hai bản render cùng revision cho ra hai video khác nhau, và không có gì trong hệ thống phát hiện được. Cho tải remote nghĩa là `sourceRevision` không còn đủ và phải thêm **remote content digest** vào định nghĩa revision: lớn hơn đáng kể về scope, và không phải việc của Giai đoạn 3.

   *(Spike §7.1 phát hiện D: `warm-grain` tải `transparenttextures.com/patterns/natural-paper.png` từ CSS `background: url(...)` vào `workdir/_remote_media/` — 101 KB đi thẳng vào pixel của bản render. Chỉ quét element media sẽ bỏ lọt đúng asset đã phát hiện.)*
15b. IF render quan sát external **script, stylesheet hoặc font** HTTP(S) THEN Giai đoạn 3 MAY tiếp tục render, nhưng job SHALL phát warning ổn định `external_dependency_unpinned`, sidecar SHALL ghi URL đã quan sát và `reproducible: false`, và client SHALL thấy cảnh báo — MUST NOT tuyên bố cùng `sourceRevision` cho cùng output. IF không có external dependency nào và mọi input đều local THEN sidecar SHALL ghi `reproducible: true`.

   Cả ba project mẫu nạp GSAP từ CDN (`cdn.jsdelivr.net/npm/gsap@3.14.2`), `kinetic-type` còn nạp Google Fonts. Vendor script/font và chặn toàn bộ network thuộc Giai đoạn 4 cùng đóng gói runtime; spec đó MUST tham chiếu lại đây. Đây là **thu hẹp tường minh của guarantee**, không phải bỏ qua determinism: Phase 3 chỉ hứa reproducibility khi sidecar nói `true`.

### Requirement 7 — Snapshot theo scene và contact sheet

**User Story:** Là người dùng, tôi muốn snapshot theo từng scene để storyboard có hình thật, và snapshot tự hết hiệu lực khi tôi sửa composition.

#### Acceptance Criteria

1. WHEN người dùng yêu cầu snapshot THEN hệ thống SHALL enqueue job `snapshot` AND SHALL trả `jobId` ngay.
2. IF project ở state `empty` THEN hệ thống SHALL từ chối với `no-composition` AND MUST NOT enqueue job.
2b. IF project ở state `authored` nhưng có **0 scene** THEN job SHALL **thành công rỗng**: 0 ảnh, không contact sheet, `sceneCount: 0` — AND MUST NOT lỗi. Khác với render (R6.2b) có chủ đích: snapshot của một composition rỗng là một tập rỗng, tức một câu trả lời đúng.
2c. IF project ở state `invalid` THEN hệ thống SHALL từ chối với `project_invalid` kèm lý do có mã (R1.2c) AND MUST NOT enqueue job (R1.2d) — khác `authored`-0-scene: ở đây không đọc nổi composition để biết có scene nào.
3. WHEN job snapshot chạy THEN hệ thống SHALL sinh một ảnh cho **mỗi** scene, chọn frame trong scene theo quy tắc xác định (mặc định: giữa scene), AND SHALL ghi vào `snapshots/`.
4. WHEN **mọi** scene đã có ảnh THEN hệ thống SHALL sinh contact sheet AND SHALL ghi cùng thư mục. IF thiếu bất kỳ scene nào THEN hệ thống MUST NOT sinh contact sheet — một contact sheet thiếu scene không tự nói ra là nó thiếu, và người dùng sẽ đọc nó thành "video của tôi có bấy nhiêu beat".
5. WHEN snapshot hoàn tất **đầy đủ** (mọi scene có ảnh) THEN hệ thống SHALL ghi vào `state.json` giá trị `computedAtSourceRevision` cùng `complete: true` (R4.4b). Ghi ảnh vào `snapshots/**` MUST NOT làm `sourceRevision` tiến (R4.4), nên bộ ảnh vừa tạo MUST NOT stale ngay tại thời điểm tạo.
6. WHEN một **input render** đổi (composition, asset, narration, preview settings, hay preset) THEN `sourceRevision` tiến, nên snapshot SHALL **tự trở thành stale** theo phép so `computedAtSourceRevision < sourceRevision` (R4.4b) AND MUST NOT bị xoá ảnh — ảnh cũ vẫn hữu ích hơn ô trống, miễn là được nhãn đúng.
6b. WHEN một job render chạy xong THEN snapshot của project SHALL **không** trở thành stale, vì `renders/**` không phải input (§3) — chạy render MUST NOT làm hình storyboard bị nhãn "cũ" khi composition không đổi một byte.
7. WHEN client đọc storyboard THEN hệ thống SHALL trả kèm cờ stale cho từng ảnh để UI nói được "hình này cũ".
8. WHEN snapshot dựng document THEN hệ thống SHALL dùng cùng đường build của preview/render (P3).
9. IF một scene không render được ảnh THEN hệ thống SHALL hoàn tất các scene còn lại AND SHALL báo đúng scene nào thất bại vì sao — một scene lỗi MUST NOT làm mất cả bộ.
9b. WHEN một hoặc nhiều scene thất bại THEN job SHALL kết thúc ở outcome **`partial`**, không phải `succeeded` — AND `state.json` SHALL ghi trạng thái partial gắn với **đúng revision nó được tính trên**, AND MUST NOT ghi `computedAtSourceRevision` cho bộ ảnh. Ghi nó nghĩa là khai "bộ này khớp revision N" cho một bộ không đầy đủ, và mọi consumer đọc `stale = false` rồi tin là đủ.

   ```json
   "snapshots": {
     "complete": false,
     "partialAtSourceRevision": 42,
     "missingSceneIds": ["scene-3"]
   }
   ```

9c. WHEN người dùng yêu cầu snapshot lại sau một lần `partial` THEN hệ thống SHALL quyết định phạm vi sinh lại bằng cách so `sourceRevision` **hiện tại** với `partialAtSourceRevision`:

   | Điều kiện | Phạm vi sinh lại |
   |---|---|
   | `sourceRevision === partialAtSourceRevision` | **Chỉ** các scene trong `missingSceneIds` — ảnh đã thành công vẫn đúng |
   | `sourceRevision !== partialAtSourceRevision` | **Toàn bộ** tập ảnh — các ảnh thành công trước đó có thể đã cũ, và tái dùng chúng là trộn hai generation vào một contact sheet |
   | Danh sách scene đã thêm/xoá scene | Tính lại danh sách scene **trước khi** quyết định phạm vi — `missingSceneIds` cũ có thể trỏ tới scene không còn tồn tại |

   > Đây là lỗ của bản 5: nó chỉ nói "retry phần thiếu" mà không gắn phần thiếu đó với revision nào. Source đổi giữa hai lần chạy thì "chỉ sinh scene thiếu" cho ra một bộ ảnh **nửa cũ nửa mới** — và bộ đó được đánh `complete: true`, tức khai là khớp revision hiện tại. Sai im lặng, và triệu chứng là một contact sheet trông hợp lý nhưng vài frame thuộc về một phiên bản khác của video.
   > **Không** dùng fingerprint per-scene ở giai đoạn này: `sourceRevision` toàn project thô hơn (một byte đổi ở scene 1 làm sinh lại cả bộ) nhưng đơn giản và **không thể sai theo hướng nguy hiểm**. Fingerprint per-scene là tối ưu của Giai đoạn 5, sau khi có nhu cầu thật.
9d. WHEN bộ ảnh trở nên đầy đủ THEN hệ thống SHALL sinh contact sheet AND ghi `computedAtSourceRevision` cùng `complete: true` trong cùng lần đó.
9e. WHILE một generation đang `partial` THEN contact sheet của generation **trước** MUST NOT được trình bày như contact sheet hiện tại — nó SHALL được nhãn theo `computedAtSourceRevision` của chính nó, hoặc không hiển thị. Một contact sheet cũ đứng ở chỗ của bản mới là cách nói dối khó phát hiện nhất trong cả R7: nó luôn trông đúng.
10. WHEN snapshot đã tồn tại, `complete: true`, và `sourceRevision` **không** đổi THEN hệ thống SHALL không sinh lại (PR-6). **`complete: true` là điều kiện bắt buộc** — không có nó, một lần `partial` sẽ khoá vĩnh viễn các scene còn thiếu: chúng không bao giờ được retry vì "composition không đổi".

### Requirement 8 — Thumbnail thật ở danh sách project

**User Story:** Là người dùng, tôi muốn thấy thumbnail thật của project, để nhận ra project bằng mắt.

#### Acceptance Criteria

1. WHEN project có contact sheet hoặc snapshot scene THEN danh sách SHALL hiển thị hình thật đó, ưu tiên xác định được (contact sheet → frame scene đầu).
2. IF project chưa có snapshot nào THEN danh sách SHALL hiển thị placeholder ổn định **theo `ProjectId`**, không theo vị trí trong lưới — thêm/xoá project MUST NOT đổi màu card của project khác.
2b. IF project ở `invalidKind: "identity"` (không có `ProjectId` — R1.2c-iii) THEN placeholder SHALL ổn định theo **slug** trong phạm vi phiên, AND SHALL được đánh dấu là project lỗi — MUST NOT dùng `entryId` làm nguồn ổn định, vì `entryId` chỉ sống trong một phiên daemon nên card sẽ đổi màu mỗi lần khởi động lại.
3. WHEN thumbnail được serve THEN hệ thống SHALL đi qua đúng allowlist asset đã có AND SHALL trả ETag theo content hash.
4. WHEN snapshot của project là stale THEN danh sách SHALL vẫn hiển thị hình cũ AND SHALL đánh dấu là cũ.
5. WHEN project mới được tạo THEN hệ thống SHALL không tự chạy snapshot đồng bộ trong request tạo — thumbnail xuất hiện sau, qua job.
6. WHEN danh sách hiển thị card THEN hệ thống SHALL kèm orientation/preset và state (`empty`/`authored`/`invalid`) để người dùng phân biệt được video dọc/ngang và project chưa có nội dung bằng mắt.

### Requirement 9 — Diagnostics endpoint

**User Story:** Là người dùng, tôi muốn một chỗ liệt kê mọi vấn đề của project, để biết cái gì đang sai trước khi render.

#### Acceptance Criteria

1. WHEN người dùng yêu cầu diagnostics của một project THEN hệ thống SHALL trả danh sách `Diagnostic` có cấu trúc (dùng đúng type [`diagnostics.ts`](../../../../packages/contracts/src/diagnostics.ts) đã có) kèm revision mà chúng được tính trên. Riêng đường recovery cho `invalidKind: "identity"` SHALL trả `sourceRevision: null` vì chưa có identity hợp lệ để tạo revision.
2. WHEN diagnostics được tính THEN hệ thống SHALL giữ đủ **4 cảnh báo hiện có**: stranded tween, element overrun, unresolved selector, empty scene (VD-3) — port sang Core MUST NOT làm mất cái nào.
3. WHEN `hyperframes check` khả dụng THEN hệ thống SHALL gộp kết quả của nó vào cùng danh sách với `code: "lint:<rule>"`.
4. IF `hyperframes check` không khả dụng hoặc timeout THEN hệ thống SHALL trả các diagnostic nội bộ kèm **cờ nêu rõ nguồn check vắng mặt** AND MUST NOT trả danh sách rỗng như thể project sạch.
5. WHEN `platform` trong `vidcom.json` lệch `data-*` trên composition THEN hệ thống SHALL phát diagnostic `platform-mismatch` kèm cả hai giá trị.
6. WHEN `narration.durationSeconds` của một scene lớn hơn `scene.duration` THEN hệ thống SHALL phát diagnostic `narration-overflow` kèm `fix` đề xuất giá trị `data-duration` mới (đóng phần còn thiếu của NT-3).
7. WHEN một `src` trong composition trỏ tới file không tồn tại THEN hệ thống SHALL phát diagnostic `missing-asset` (FA-5).
8. IF project ở state `empty` THEN hệ thống SHALL trả một diagnostic `no-composition` mang tính thông tin AND MUST NOT lỗi — project chưa được dựng không phải project hỏng.
8b. IF project ở state `authored` nhưng có **0 scene** THEN hệ thống SHALL trả một diagnostic `no-scenes` mang tính thông tin, phân biệt được với `no-composition` AND MUST NOT lỗi — agent phải biết được nó đang ở "chưa có file" hay "có file nhưng chưa có beat nào".
8c. IF project ở state `invalid` THEN diagnostics **SHALL vẫn chạy** và trả một diagnostic có `code` **đúng bằng `invalidReason.code`** đã xác định ở R1.2c — `identity_parse_error` khi `invalidKind` là `identity`, `composition_parse_error` khi là `composition` — kèm `line`/`column` nếu có, AND MUST NOT từ chối với `project_invalid`. Diagnostics là **ngoại lệ duy nhất** trong bảng R1.2d: render và mutation bị chặn, nhưng đây đúng là chỗ người dùng tới để tìm nguyên nhân, nên chặn nó là chặn công cụ chẩn đoán vì cái nó cần chẩn đoán.
8d. IF `invalidKind` là `identity` THEN diagnostic SHALL được trả từ **đường recovery** nhận `entryId` (R1.2c-iv) AND MUST NOT gọi parser composition — không có `ProjectId` để resolve, và composition không phải thứ đang hỏng. Bản 6 luôn trả `composition_parse_error` cho mọi `invalid`, tức báo sai nguyên nhân đúng ở chỗ người dùng đang tìm nguyên nhân.
8e. IF diagnostics chạy qua `entryId` cho `invalidKind: "identity"` THEN kết quả SHALL chỉ được trả trong response của phiên daemon AND MUST NOT ghi `.vidcom/**`, audit/project projection hay bịa `ProjectId`. Persistence chỉ được phép trở lại sau operation recovery tạo được `vidcom.json` hợp lệ và một `ProjectId` thật.
9. WHEN diagnostics chạy cho project có `ProjectId` hợp lệ THEN hệ thống SHALL ghi kết quả vào `.vidcom/context/diagnostics.json` kèm `computedAtSourceRevision` (R4.4b), để harness đọc được mà không cần gọi API. Việc ghi này MUST NOT làm `sourceRevision` tiến — nếu tiến, bản vừa ghi cũ ngay tại thời điểm ghi. Đường `entryId` ở R9.8e là ngoại lệ bắt buộc và MUST NOT đi qua AC này.
10. WHEN không parse được một tween THEN hệ thống SHALL **đếm** số lượng không parse được AND MUST NOT bịa start time (P5).
11. WHEN diagnostics chạy THEN hệ thống MUST NOT ghi vào bất kỳ file nào của composition — nó là đường chỉ đọc.

### Requirement 10 — Chèn scene ở giữa, ripple edit, validate timing

**User Story:** Là người dùng, tôi muốn chèn scene ở giữa timeline và đổi duration mà các scene sau tự dịch, không để lại lỗ hổng hay chồng lấn.

> **Ripple là thao tác theo từng track, không theo cả composition.** Domain có `trackIndex` trên scene clip ([steering/03 §2.1](../../../steering/03-architecture-ddd.md)), nên hai scene **chồng thời gian ở hai track khác nhau là hợp lệ và có thể là chủ đích** — đó là cách dựng overlay, lower-third, hay transition chồng lấn. Luật "không hở, không chồng" chỉ có nghĩa **trong một track**. Áp nó cho cả composition là biến một project multi-track thành một danh sách lỗi giả và làm ripple đẩy những scene không liên quan.

#### Acceptance Criteria

1. WHEN người dùng chèn scene tại vị trí `n` **của một track** THEN hệ thống SHALL tạo scene có **file `src` riêng** (P11), mount đúng vị trí `n` trong track đó, dịch mọi scene sau nó **trong cùng track**, và điều chỉnh root duration — tất cả trong **một** revision. Scene ở track khác MUST NOT bị dịch.
1b. IF request không nêu `trackIndex` THEN hệ thống SHALL dùng track của scene tham chiếu, hoặc track 0 khi không có scene tham chiếu — AND SHALL nêu track đã dùng trong response, MUST NOT để người gọi phải đoán.
2. WHEN người dùng đổi duration của một scene với ripple bật THEN hệ thống SHALL dịch start time của mọi scene sau nó **trong cùng track** AND SHALL cập nhật root duration trong **một** revision.
2b. WHEN root duration được tính lại THEN nó SHALL là `max(scene.start + scene.duration)` trên **mọi track** ([steering/03 §2.1](../../../steering/03-architecture-ddd.md)) AND SHALL bằng 0 khi không còn scene nào — invariant `duration > 0` MUST NOT áp cho root.
3. WHEN ripple hoàn tất THEN thứ tự scene trong track SHALL không đổi AND SHALL không có khoảng hở hay chồng lấn giữa các scene **liền kề trong cùng track**. Chồng lấn **giữa các track** MUST NOT bị coi là lỗi và MUST NOT bị tự sửa.
3b. WHEN composition dùng nhiều hơn một track THEN response của insert/ripple SHALL nêu rõ track nào bị ảnh hưởng và scene nào đã dịch — im lặng ở đây làm người dùng không biết cái gì vừa di chuyển.
4. IF `duration <= 0` hoặc `start < 0` THEN hệ thống SHALL từ chối với `timing_invalid` nêu field AND MUST NOT ghi gì (đóng bug #20 của doc 12).
5. IF tổng thời lượng sau ripple vượt `MAX_PROJECT_DURATION_SECONDS` THEN hệ thống SHALL báo `duration_overflow` với `details.limitKind: "runtime"` AND SHALL từ chối ghi.
5b. WHEN giới hạn thời lượng được kiểm THEN hệ thống SHALL phân biệt **ba** giới hạn, mỗi cái một hành vi:

   | Giới hạn | Nguồn | Hành vi | Mã |
   |---|---|---|---|
   | `MAX_PROJECT_DURATION_SECONDS` — **guard sản phẩm** của VidCom, mặc định **3600 giây** | hằng số có tên trong `contracts` | **Từ chối ghi** | `duration_overflow`, `limitKind: "runtime"` |
   | `recommendedMaxDurationSeconds` của preset | catalog preset (§4.3) | **Cảnh báo**, không bao giờ chặn | diagnostic `platform-duration-recommendation` |
   | `scene.start + scene.duration` vượt root duration hiện tại | tính từ composition | Nới root **hoặc** đòi `extendRoot`, không im lặng ([steering/03 §2.1](../../../steering/03-architecture-ddd.md)) | `duration_overflow`, `limitKind: "root"` |

   > **Không gọi 3600 giây là giới hạn của "encoder" hay "runtime engine"** — chưa có bằng chứng nào cho thấy FFmpeg hay Chromium giới hạn ở đó, và đặt tên theo một nguyên nhân không tồn tại làm người sau tin rằng nới nó là bất khả thi. Nó là **guard tài nguyên/vận hành của VidCom**: một project một giờ ăn quá nhiều thời gian render và đĩa để chạy lặng lẽ. Đặt đúng tên thì nó là một quyết định sản phẩm có thể xem lại; đặt sai tên thì nó thành một luật vật lý giả.
   > Hằng số MUST có tên và có test khoá giá trị — một ngưỡng nằm rải trong code là ngưỡng sẽ lệch. Và `recommendedMaxDurationSeconds` MUST NOT chặn: TikTok gợi ý 180 giây không phải lý do để VidCom từ chối video 200 giây của người dùng.
5c. WHEN `duration_overflow` được trả về THEN nó SHALL mang discriminator để client phân biệt được hai loại **mà không phải đoán từ message**:

   ```json
   { "code": "duration_overflow",
     "details": { "limitKind": "runtime", "actualSeconds": 3700, "maxSeconds": 3600, "extendRootAllowed": false } }
   ```
   ```json
   { "code": "duration_overflow",
     "details": { "limitKind": "root", "actualSeconds": 42.5, "maxSeconds": 40, "extendRootAllowed": true } }
   ```

   `extendRootAllowed` là thứ quyết định UI hiện nút gì: `limitKind: "root"` thì có đường đi tiếp (nới root), `limitKind: "runtime"` thì không. Dùng chung một `code` mà không có discriminator nghĩa là client phải parse message tiếng người để biết nên hiện nút nào.
5d. WHEN một thay đổi timing được xử lý THEN thứ tự kiểm SHALL là:

   ```
   tính root duration mới
   → vượt MAX_PROJECT_DURATION_SECONDS      → từ chối (limitKind: "runtime")
   → vượt recommendedMaxDurationSeconds     → cho ghi + diagnostic cảnh báo
   → scene vượt root duration hiện tại      → nới root, hoặc đòi extendRoot (limitKind: "root")
   ```

   Thứ tự này bắt buộc: kiểm hard limit **trước** khi nới root, nếu không việc nới root có thể tự đưa project vượt hard limit rồi mới bị từ chối — tức từ chối sau khi đã tính toán trên một trạng thái không hợp lệ.
6. WHEN ripple hoặc insert thất bại giữa chừng THEN hệ thống SHALL để composition ở đúng trạng thái trước đó — không có trạng thái "một nửa scene đã dịch".
7. WHEN người dùng đổi duration với ripple **tắt** THEN hệ thống SHALL chỉ đổi scene đó AND SHALL phát diagnostic nếu tạo ra hở hoặc chồng lấn **trong track của nó** — không ép, nhưng không im lặng. Diagnostic SHALL nêu `trackIndex`, vì "scene 3 chồng scene 4" không đủ để tìm ra chỗ sai khi có nhiều track.
8. WHEN scene được chèn hoặc dịch THEN hệ thống SHALL giữ **một thứ tự scene duy nhất** dùng chung storyboard và timeline (P6).
9. WHEN narration của một scene bị dịch thời gian THEN audio đã mount SHALL được dịch theo, vì `data-start` lấy từ document chứ không từ sidecar.
10. WHEN insert hoặc ripple thành công THEN response SHALL trả **entity đã cập nhật** kèm revision và diagnostics (CE-6), không phải `{ok:true}`.
11. IF project ở state `empty` AND người dùng/harness chèn scene đầu tiên THEN hệ thống SHALL tạo cả root composition theo preset trong `vidcom.json` AND state SHALL chuyển sang `authored` trong cùng revision.

### Requirement 11 — Nhiều đoạn narration trong một scene

**User Story:** Là người dùng, tôi muốn nhiều đoạn narration trong một scene, mỗi đoạn có timing riêng, để scene 5 câu thoại không bị mất 4 câu.

#### Acceptance Criteria

1. WHEN một scene có nhiều dòng script THEN hệ thống SHALL cho phép nhiều cue narration cho scene đó, mỗi cue có text, voice, offset trong scene, và duration riêng.
2. WHEN sidecar narration định dạng cũ (một text duy nhất) được đọc THEN hệ thống SHALL coi là **một cue** AND MUST NOT vứt hay ghi đè file cũ.
3. WHEN nhiều cue được mount vào composition THEN hệ thống SHALL sinh một phần tử audio cho mỗi cue với `data-start` tính từ start của scene AND SHALL giữ đúng cơ chế mount đã có.
4. IF hai cue trong một scene chồng thời gian THEN hệ thống SHALL phát diagnostic AND MUST NOT tự dịch chúng.
5. IF tổng thời lượng cue vượt `scene.duration` THEN hệ thống SHALL phát `narration-overflow` (R9.6).
6. WHEN người dùng sửa một dòng script THEN hệ thống SHALL chỉ đánh **cue tương ứng** là stale AND MUST NOT chạm cue khác — mở rộng đúng hành vi `staleSince` đã có.
7. WHEN word timing được sinh cho nhiều cue THEN hệ thống SHALL giữ `checkWordTimings()` chạy cho **từng** cue AND SHALL không cho boundary vượt thời lượng audio của cue đó.
8. WHEN scene bị xoá THEN mọi cue của nó SHALL bị dọn cùng, đúng như `deleteScene` đang làm với một cue.

### Requirement 12 — Năm MCP tool mà quy trình chuẩn cần

**User Story:** Là người dùng dùng harness, tôi muốn agent gọi được validate, snapshot, render, đọc job và tự lấy skill về, để nó tự kiểm tra việc mình vừa làm thay vì báo xong rồi để tôi phát hiện sai.

> **Không còn cắt được.** Quy trình chuẩn 9 bước ở [steering/14 §3](../../../steering/14-agent-kit-and-skills.md#3-quy-trình-chuẩn--thứ-agent-phải-theo) gọi đúng bốn tool đầu ở bước 5, 6, 8. Cắt R12 là ship agent-kit tham chiếu tool không tồn tại. Tool thứ năm (`install_agent_kit`) là đường để harness **tự pull skill về workspace** — nó biến việc cài từ một bước thủ công thành một câu hỏi agent tự trả lời được.

#### Acceptance Criteria

1. WHEN registry được nạp THEN hệ thống SHALL expose `validate_project`, `start_snapshot`, `start_render`, `get_job_status` và `install_agent_kit` AND SHALL định nghĩa mỗi tool **một lần**, protocol-agnostic (MP-2).
2. WHEN một tool trong nhóm này được gọi THEN nó SHALL đi qua **đúng** use case mà HTTP dùng — MUST NOT có đường thứ hai vào Core.
3. WHEN `start_render` hoặc `start_snapshot` được gọi THEN nó SHALL trả `jobId` AND MUST NOT chờ job xong trong một tool call.
4. WHEN `get_job_status` được gọi THEN nó SHALL trả status, progress và outcome AND SHALL đủ để agent poll có backoff (W5) mà không cần endpoint khác.
5. WHEN tool được gọi THEN audit SHALL ghi cả protocol version (MP-12).
6. WHEN `tools/list` được gọi THEN thứ tự SHALL deterministic AND golden file của **cả hai** era SHALL được cập nhật.
7. IF một tool không degrade được sang legacy THEN nó SHALL bị ẩn khỏi `tools/list` của legacy (MP-11) thay vì lỗi lúc gọi.
8. WHEN `validate_project` được gọi trên project state `empty` THEN nó SHALL trả `no-composition` (R9.8) chứ không lỗi — agent phải phân biệt được "chưa dựng" với "dựng sai".
9. WHEN `install_agent_kit` được gọi THEN input SHALL là **đúng một** nhánh của discriminated union sau; field của nhánh khác SHALL bị từ chối bởi schema strict:

   ```ts
   type InstallAgentKitInput =
     | { operation?: "install"; hosts: ("codex" | "claude-code")[] }
     | { operation: "link"; host: "claude-code"; expectedContentHash: string }
     | { operation: "replace"; host: "codex" | "claude-code"; relativePath: string; expectedContentHash: string };
   ```

   - Bỏ `operation` nghĩa là `install`; nhánh đó bắt buộc `hosts` không rỗng và không có mặc định.
   - `link` chỉ nhận `host: "claude-code"`, chọn `CLAUDE.md` và append đúng import native `@CLAUDE.vidcom.md`; `host: "codex"` SHALL bị `schema_invalid`. Spike §7.2 chứng minh Codex không theo dòng tham chiếu tương đương, nên MUST NOT ship operation không có hiệu lực.
   - `replace.relativePath` SHALL chỉ nhận đúng một path trong manifest bundled của host đã chọn; path ngoài manifest hoặc thuộc host khác SHALL bị `schema_invalid` trước khi ghi.
   - Đích luôn nằm dưới **gốc workspace đã resolve** (R13.7) — MUST NOT nhận workspace path từ tham số.

   Sau một operation thành công, tool SHALL trả payload tách hai câu hỏi:

   ```ts
   {
     operationResult: { status: "applied" | "no_change"; changedFiles: { relativePath: string; contentHash: string }[] };
     installationState: {
       outcome: "installed" | "already_installed" | "partial" | "blocked";
       files: AgentKitFileState[];
       usableBy: Partial<Record<Host, "ready" | "degraded" | "blocked">>; // key đúng selected hosts
     };
   }
   ```

   `operationResult` nói operation vừa làm gì; `installationState` là trạng thái **sau** operation theo R13.9a–9b. Một `link` Claude có thể `applied` trong khi installation `partial`; hai giá trị đó không mâu thuẫn và MUST NOT bị ép vào một enum.
   Mỗi `AgentKitFileState` SHALL tối thiểu mang `host`, `relativePath`, `state`, `contentHash` hiện tại (hoặc `null` khi thiếu) và action hợp lệ tiếp theo. Nhờ đó caller lấy hash của **đúng file** trước khi gọi `link`/`replace`; MUST NOT có một hash chung mơ hồ cho nhiều host/file. Với Codex `foreign`/`current_modified`, action SHALL là `manual_merge` từ `AGENTS.vidcom.md`, không phải `link`.
9-i. IF nhánh `install` có `hosts` vắng mặt hoặc rỗng THEN tool SHALL từ chối với `schema_invalid` nêu `field: "hosts"` AND MUST NOT ghi gì. Lối thoát "mặc định cả hai host" bị loại vì nó trái luật **không cài rác cho host người dùng không dùng** (R13.7-i).
9-ii. WHEN CLI hoặc UI khởi động luồng `install` THEN nó SHALL yêu cầu người dùng **chọn host** trước khi gọi — MUST NOT tự chọn hộ. Luồng `replace` SHALL yêu cầu chọn đúng một host và đúng một file manifest đang được hiển thị cùng hash; `link` chỉ được hiển thị cho Claude Code.
9-iii. WHEN `expectedFiles` và `usableBy` được tính THEN chúng SHALL chỉ tính trên host được chọn bởi input (`hosts` với `install`, `host` với `link`/`replace`) — file chỉ dẫn của host không được chọn MUST NOT vào tập file mong đợi, và MUST NOT ảnh hưởng outcome.
10. WHEN `install_agent_kit` được gọi lần thứ hai bằng nhánh `install` với cùng `hosts` sau một lần `installed` THEN `operationResult.status` SHALL là `no_change`, `installationState.outcome` SHALL là `already_installed`, AND tool MUST NOT ghi file nào. `link` và `replace` là operation riêng và MUST NOT bị `install` kích hoạt (§4.6 Luật 1).
10b. IF tool được gọi bằng nhánh `link` hoặc `replace` THEN nó SHALL đòi `expectedContentHash` của đúng file đích (R13.9e, R13.10) AND SHALL từ chối với `write_conflict` khi hash không khớp — agent MUST NOT được phép sửa file người dùng mà không nêu ra nó đang sửa bản nào. Mutation thất bại SHALL trả tool error và composite rollback; MUST NOT trả một `operationResult` giả thành công.
11. WHEN `install_agent_kit` ghi vào workspace THEN nó SHALL đi qua `WriteAuthority` scope `workspace` (R13.11) — MUST NOT là đường ghi riêng của MCP.
12. WHEN `installationState.outcome` là `blocked` hoặc `partial` THEN payload SHALL trả recovery action theo host (R13.9d): Claude Code có thể trả đúng dòng `@CLAUDE.vidcom.md`; Codex SHALL trả `manual_merge` với source/destination tuyệt đối. Agent phải nói lại được một hành động cụ thể, MUST NOT bịa một dòng import Codex mà spike không chứng minh.

### Requirement 13 — Agent-kit pull được về gốc workspace

**User Story:** Là người dùng, tôi muốn pull `AGENTS.md` + skill của VidCom về gốc workspace, để Codex/Claude Code đọc được ngay và biết quy trình dựng video mà tôi không phải giải thích lại mỗi lần.

> Kéo AK-1..3 từ Giai đoạn 4 lên theo quyết định người dùng 2026-08-04, **kèm AK-4, AK-5, AK-6, AK-8** — AK-1..3 một mình nằm trong binary, không có đường tới folder người dùng và không có gì chặn nó mục (xem OQ-8).
> Phạm vi cài: **chỉ gốc workspace** (M5). MUST NOT nhân bản xuống từng project.

#### Nội dung agent-kit (AK-1, AK-2, AK-3)

1. WHEN `packages/agent-kit` được build THEN nó SHALL chứa `AGENTS.md`, `vidcom/SKILL.md` (router) và 6 skill con đúng tên ở [steering/14 §2](../../../steering/14-agent-kit-and-skills.md#2-cấu-trúc): `vidcom-project`, `vidcom-scene`, `vidcom-look`, `vidcom-narration`, `vidcom-render`, `vidcom-fix`.
2. WHEN build chạy THEN `CLAUDE.md` SHALL được **sinh từ** `AGENTS.md` byte-for-byte AND MUST NOT được sửa tay như file thứ hai.
3. WHEN `AGENTS.md` được viết THEN nó SHALL chứa đủ 7 mục bắt buộc của [steering/14 §4](../../../steering/14-agent-kit-and-skills.md#4-agentsmd-ship-vào-project--nội-dung-bắt-buộc) và 6 key rule, SHALL nêu quy trình chuẩn 9 bước dạng rút gọn, AND SHALL nêu cách liệt kê project trong workspace — harness khởi động ở gốc workspace nên nó chưa biết project nào tồn tại.
4. WHEN một skill được viết THEN nó SHALL có frontmatter `name` + `description` nói **khi nào dùng và khi nào không**, SHALL nói bằng **tool** chứ không bằng lệnh shell hay đường dẫn file, AND SHALL có mục "khi nào KHÔNG dùng skill này" (S1–S8).
5. WHEN agent-kit được viết THEN nó SHALL bằng **tiếng Anh** ([steering/14 §9](../../../steering/14-agent-kit-and-skills.md#9-ngôn-ngữ)) AND MUST NOT trộn instruction repo-level của vidcom vào — đây là skill để **dùng** VidCom, không phải để **phát triển** VidCom ([steering/14 §1](../../../steering/14-agent-kit-and-skills.md#1-hai-loại-instruction--must-not-lẫn)).
6. WHEN agent-kit nêu một luật an toàn THEN luật đó SHALL đồng thời được **server cưỡng chế** AND MUST NOT chỉ tồn tại trong `AGENTS.md` — không phải host nào cũng đọc file trong workspace.

#### Pull về workspace (AK-4, AK-5, AK-6)

7. WHEN người dùng chạy lệnh cài tường minh, hoặc harness gọi `install_agent_kit` (R12.9) THEN hệ thống SHALL ghi **manifest của host được chọn** vào gốc workspace: Codex gồm `AGENTS.md` + `.agents/skills/**`; Claude Code gồm `CLAUDE.md` + `.claude/skills/**`. Mỗi file mang version marker (§4.6), và hệ thống MUST NOT tạo file lock nào.
7-i. WHEN `hosts` được chọn THEN hệ thống SHALL cài từng manifest vào đúng thư mục đã được spike xác nhận (OQ-6, §7.2): `codex → .agents/skills`, `claude-code → .claude/skills`. IF chỉ một host được chọn THEN file chỉ dẫn và thư mục skill của host kia MUST NOT được ghi — cài cho host người dùng không dùng là rác trong folder của họ.
7b. WHEN agent-kit được cài THEN đích SHALL luôn nằm trong gốc workspace AND hệ thống MUST NOT ghi vào `~/.claude`, `~/.codex`, hay bất kỳ đường dẫn cấu hình toàn máy nào — VidCom không sở hữu cấu hình host của người dùng, và skill ghi ở đó sẽ theo họ sang mọi project không liên quan.
7c. WHEN cài agent-kit THEN hệ thống MUST NOT đọc, ghi, hay merge vào `<workspace>/skills-lock.json` — file đó thuộc tooling skill riêng của người dùng và schema của nó không tương thích ([repo này là ví dụ thật](../../../../skills-lock.json)).
7d. IF tooling skill của người dùng đang quản một skill trùng tên với skill của VidCom THEN hệ thống SHALL báo trùng tên và bỏ qua đúng file đó (theo R13.9) AND MUST NOT ghi đè — hai tooling tranh một file là chuyện người dùng phải biết, không phải chuyện để giải quyết im lặng.
8. WHEN agent-kit được cài THEN hệ thống SHALL cài **chỉ khi được gọi tường minh** AND MUST NOT ghi lúc khởi động, MUST NOT ghi khi mở project — đó là rác trong thư mục người dùng ([steering/14 §8](../../../steering/14-agent-kit-and-skills.md#8-cài-đặt-vào-workspace-người-dùng)).
9. WHEN operation là `install` THEN hệ thống SHALL chỉ ghi các file ở trạng thái `missing` (§4.6 Luật 2) AND MUST NOT chạm file ở trạng thái `current_pristine`, `current_modified`, `outdated`, `newer` hay `foreign`. Đây là hành vi mặc định khi **`operation` không được truyền**; `hosts` vẫn bắt buộc (R12.9-i).
9-i. WHEN trạng thái per-file được xác định THEN hệ thống SHALL dùng marker để biết version và **manifest hash bundled trong binary** để biết nội dung có đúng bản đã ship — MUST NOT dựa vào marker một mình, AND MUST NOT tạo file lock nào trong workspace để lưu hash (§4.6 Luật 2).
9a. WHEN bất kỳ operation `install` / `link` / `replace` nào kết thúc thành công THEN hệ thống SHALL suy đúng **một** `installationState.outcome` từ trạng thái của toàn bộ tập file mong đợi của host được chọn **SAU** operation, theo thuật toán loại trừ sau — MUST NOT suy từ trạng thái trước operation và MUST NOT dùng outcome này thay cho `operationResult` (R12.9):

   ```
   mutation thất bại
       → trả error, composite rollback; KHÔNG trả install outcome

   mọi file mong đợi của host được chọn là current_pristine
       → có file vừa ghi   → installed
       → không ghi gì      → already_installed

   còn file current_modified / outdated / newer / foreign
       → MỌI host được chọn ở `blocked`          → blocked
       → còn ≥1 host ở `ready` HOẶC `degraded`  → partial
   ```

   > Bản 6 suy outcome từ trạng thái **trước** operation và hở hai chỗ vì thế:
   > - **`current` + `missing` → không khớp dòng nào.** Trường hợp phổ biến nhất: `AGENTS.md` đã cài đúng, một `SKILL.md` mới của bản này còn thiếu. Suy từ trạng thái sau thì nó là `installed`, hiển nhiên.
   > - **Dòng 4 và 5 chồng nhau** khi `blocked` được định nghĩa bằng việc đếm file. Lấy `usableBy` làm nguồn thì chồng lấn biến mất.
   >
   > Bản 7 lại sai một bậc khác: nó viết "không host nào ở `ready` → `blocked`", tức **hai host đều `degraded` cũng ra `blocked`** — trong khi cả hai vẫn đọc được một phần và người dùng vẫn có giá trị. `blocked` phải nghĩa *"không ai đọc được gì"*, không phải *"không ai hoàn hảo"*. Ngưỡng đúng là `blocked`, không phải `ready`.

9b. WHEN `usableBy` được suy THEN nó SHALL được suy từ **effective host chain** đã được kiểm chứng của từng host: router skill native quyết định host có gọi được VidCom hay không; file chỉ dẫn chính cung cấp ngữ cảnh chung nhưng không phải điều kiện duy nhất để discover router. MUST NOT suy từ marker hay trạng thái của một file đơn lẻ:

   ```json
   { "usableBy": { "codex": "ready", "claudeCode": "degraded" } }
   ```

   | Giá trị | Điều kiện |
   |---|---|
   | `ready` | Router native được discover (`$vidcom` Codex, `/vidcom` Claude Code), mọi skill bắt buộc `current_pristine`, và nội dung chỉ dẫn chung của host có hiệu lực |
   | `degraded` | Router native vẫn được discover, nhưng skill phụ hoặc nội dung chỉ dẫn chung thiếu / `current_modified` / `outdated` / `newer` |
   | `blocked` | Router native không được discover/parse, nên không có đường đã xác minh tới VidCom |

   Hai kết quả spike buộc phải tách hai lớp này:
   - Codex gọi được probe từ `.agents/skills/vidcom/SKILL.md` dù `AGENTS.md` không chứa router; Claude Code cũng gọi được từ `.claude/skills/vidcom/SKILL.md` dù không có `CLAUDE.md`. Vì vậy file chỉ dẫn chính hỏng không được báo `blocked` khi router native vẫn hoạt động.
   - `link` chỉ có ý nghĩa ở Claude Code: `@CLAUDE.vidcom.md` làm nội dung chỉ dẫn phụ có hiệu lực. Codex không theo dòng tham chiếu tương đương, nên merge thủ công là recovery duy nhất được ship cho file `AGENTS.md` của người dùng.
9b-i. WHEN effective host chain được đánh giá THEN "tới được router" SHALL nghĩa là **xác minh được bằng mapping §7.2**: skill router nằm đúng thư mục host, đọc/parse được, và có thể được kích hoạt bằng cú pháp native. `ready` SHALL đòi thêm mọi skill bắt buộc `current_pristine` và nội dung chỉ dẫn chung có hiệu lực. IF router không xác minh được THEN giá trị SHALL là `blocked`; IF router xác minh được nhưng phần còn lại không đầy đủ THEN SHALL là `degraded`, MUST NOT là `blocked`.
9b-ii. IF một file ở trạng thái `newer` (marker cao hơn version binary) THEN hệ thống MUST NOT chạm nó, MUST NOT coi nó là `outdated` hay `foreign`, AND SHALL báo rằng workspace đang có agent-kit mới hơn binary. Một binary cũ hạ cấp agent-kit mới là mất dữ liệu không ai yêu cầu.
9c. IF `AGENTS.md` hoặc `CLAUDE.md` ở trạng thái `foreign` THEN hệ thống SHALL ghi bản VidCom ra tên phụ cùng host (`AGENTS.vidcom.md` / `CLAUDE.vidcom.md`) AND MUST NOT ghi đè file chính. File phụ chỉ làm nội dung chỉ dẫn chung có hiệu lực khi Claude `link` nó hoặc người dùng merge thủ công; router native được đánh giá độc lập theo R13.9b-i.
9d. WHEN outcome là `partial` hoặc `blocked` THEN hệ thống SHALL trả recovery action cụ thể theo host. Với Claude Code, khi file chính `foreign`, action có thể là dòng copy được `@CLAUDE.vidcom.md` kèm file đích. Với Codex, action SHALL là `manual_merge` nêu đường dẫn tuyệt đối `AGENTS.vidcom.md → AGENTS.md`; MUST NOT đưa một dòng `Read and follow ...` như thể host sẽ import nó.
9e. WHEN operation là **`link`** THEN `host` SHALL là `claude-code`, hệ thống SHALL append đúng dòng `@CLAUDE.vidcom.md` vào cuối `CLAUDE.md`, SHALL đòi `expectedContentHash`, AND MUST NOT sửa hay xoá dòng nào khác. `link` MUST NOT xảy ra như tác dụng phụ của `install`; Codex MUST NOT expose operation này (§4.6 Luật 1, §7.2).
9e-i. WHEN Claude `link` thành công THEN effective host chain SHALL được đánh giá lại. IF router và mọi skill bắt buộc `current_pristine` THEN `usableBy.claudeCode` SHALL chuyển từ `degraded` sang `ready`; nếu skill còn thiếu hoặc lệch version thì SHALL vẫn là `degraded`. Operation chỉ tồn tại vì spike §7.2 chứng minh host thật sự theo import này.
10. WHEN operation là **`replace`** THEN hệ thống SHALL đòi cả `expectedContentHash` **và** file đích phải có marker của VidCom, AND MUST NOT `replace` một file `foreign` hay `newer` trong bất kỳ trường hợp nào — `foreign` là file người dùng viết, `newer` là bản mới hơn binary đang chạy. Muốn thay chúng thì người dùng tự xoá rồi `install`.
10b. IF một file ở trạng thái `outdated` hoặc `current_modified` THEN `install` SHALL báo trạng thái đó và nêu đường `replace` tường minh AND MUST NOT tự thay — refresh im lặng vào folder người dùng là thứ họ không nhờ, và một agent-kit cũ vẫn hoạt động chứ không hỏng.
11. WHEN ghi vào gốc workspace THEN hệ thống SHALL đi qua `WriteAuthority` **scope `workspace`**: atomic temp+rename, precondition content hash, audit — AND MUST NOT dùng installer ghi vòng ngoài authority ([steering/07 §4](../../../steering/07-data-and-storage.md#4-ghi-file--quy-tắc-cứng)).
12. WHEN path policy cho phép ghi agent-kit THEN nó SHALL là purpose riêng, chỉ cho đúng tập file agent-kit ở đúng gốc workspace, AND MUST NOT bỏ `agents.md`/`claude.md` khỏi `PROTECTED_FILES` cho các purpose khác, AND MUST NOT bỏ luật chặn dotfile chung nếu thư mục skill là dot-dir.
13. WHEN cài agent-kit THEN containment SHALL vẫn được áp ở gốc workspace (canonicalize + resolve symlink) — scope mới MUST NOT là scope không kiểm soát.
14. IF gốc workspace không ghi được (read-only, không quyền) THEN hệ thống SHALL báo lỗi nêu rõ đường dẫn và lý do AND SHALL vẫn cho dùng VidCom bình thường — thiếu agent-kit làm harness kém thông tin, không làm app hỏng.
15. WHEN cài xong THEN hệ thống SHALL báo cho người dùng **những gì đã ghi ở đâu** — ghi im lặng vào folder người dùng là thứ họ có quyền biết.

#### Chống mục (AK-8)

16. WHEN CI chạy THEN SHALL có test đối chiếu danh sách tool trong `AGENTS.md` với Tool Registry, test mọi tool mà skill tham chiếu đều tồn tại, AND test mọi `/vidcom-*` mà router trỏ tới đều có `SKILL.md` — lệch thì **đỏ CI**.
17. WHEN một tool được thêm, đổi tên, xoá, hoặc đổi mức quyền THEN `AGENTS.md` và skill liên quan SHALL được cập nhật trong cùng thay đổi — cưỡng chế bằng test ở AC 16, không bằng review.
18. Thư mục skill đích SHALL giữ đúng mapping đã PASS bằng **bằng chứng chạy thật** ở §7.2: Codex `.agents/skills`, Claude Code `.claude/skills`. Regression test SHALL kích hoạt router bằng cú pháp native (`$vidcom` / `/vidcom`) và gọi đúng một tool giả lập — MUST NOT dừng ở "file được tìm thấy".
18b. Frontmatter `x-vidcom-agent-kit` SHALL được giữ vì cả hai host đã parse và gọi probe thành công. `link` SHALL chỉ tồn tại cho Claude Code với `@CLAUDE.vidcom.md`; Codex MUST NOT có `link` cho tới khi một import native tương đương vượt cùng tiêu chí probe, không chỉ được model nhắc lại bằng văn bản.

---

## 6. Traceability

| Requirement | ID doc 13 | build-order | Nguồn |
|---|---|---|---|
| R1 | PK-2 (mở rộng), PM-1, PM-7 | — | Mô hình sản phẩm M1/M2/M3, 2026-08-04 |
| R2 | PM-9 (mở rộng) | — | Người dùng, 2026-08-04 |
| R3 | PM-9 | — | Người dùng, 2026-08-04 + M1 |
| R4 | SE-9, SE-10 | — | Người dùng, 2026-08-04 |
| R5 | PM-2, PM-4, PM-7 | 3.6 | build-order + M3 |
| R6 | PR-1 | 3.1 | build-order — "ưu tiên cao nhất" |
| R7 | PR-5, PR-6 | 3.2 | build-order |
| R8 | PM-5 | 3.8 | build-order |
| R9 | VD-1, VD-2, VD-3, FA-5, NT-3 (phần còn lại) | 3.5 | build-order |
| R10 | SC-4, SC-5, SC-8 | 3.7 | build-order |
| R11 | NT-7 | 3.4b | build-order + doc 07 §Vấn đề đã biết #1 |
| R12 | MP-1, MP-2, MP-11, MP-12 | — | Hệ quả của R6/R7/R9 + steering/14 §3; tool thứ năm từ M5 |
| R13 | AK-1, AK-2, AK-3, AK-4, AK-5, **AK-6**, AK-8 | 4.1, 4.2, 4.3 (kéo lên) | Mô hình sản phẩm M4 + M5, 2026-08-04 |

Không có requirement nào không truy được về nguồn. Không có mục nào của Giai đoạn 3 (sau re-baseline) thiếu requirement — kiểm bằng bảng re-baseline trong [main spec](./spec-project-delivery-loop-pending.md#re-baseline-build-order-giai-đoạn-3-vs-code-thật).

Chuỗi phụ thuộc dài nhất: **R3 → R1 → R5 → (R6, R7, R9) → R12 → R13**. R13 không thể xong trước R12, và R12 không thể xong trước R6/R7/R9.

---

## 7. Quyết định đã chốt — trước đây là OQ-1…OQ-9

Tất cả chín câu đã được trả lời ngày 2026-08-04. **Bảy** câu đóng bằng quyết định; **hai** câu (OQ-4, OQ-6) được chốt giá trị cuối bằng spike thật, vì chúng không thể đóng bằng văn bản.

| # | Quyết định | Requirement chịu ảnh hưởng |
|---|---|---|
| **OQ-1** | **SQLite là authority và engine giao dịch.** `.vidcom/revisions/` và `.vidcom/jobs/` là **projection bền, đọc được**. Projection lệch phải **phát hiện được và rebuild được từ SQLite**. `.vidcom/` **MUST NOT ghi ngược** vào SQLite. Giữ nguyên nền Phase 2, không có dual-authority | R4.8, R4.8b |
| **OQ-2** | **Không commit `state.json`** — nó chứa `lastOpenedAt`, job ID và state vận hành. Chỉ commit `context/project-context.md`, và chỉ khi nó **deterministic, không absolute path, không timestamp, không job ID, không secret**. Ignore: `state.json`, `diagnostics.json`, `jobs/`, `revisions/`, `logs/`, `cache/`. Harness cần context mới thì daemon dựng lại lúc mở project | R4.1b, R4.3b |
| **OQ-3** | **14 ngày**, cấu hình bằng `projectLogRetentionDays` trong `~/.vidcom/setting.json`. Validate số nguyên `0…365`; `0` nghĩa là không giữ project log | R4.12 |
| **OQ-4** | **ĐÃ CHẠY 2026-08-04** (§7.1, bằng chứng: [`spikes/phase-3-render/`](../../../../spikes/phase-3-render/README.md)). Kết luận: **feasibility PASS có điều kiện** — đường render khả thi, không cần viết lại R6. **Artifact safety PASS · cleanup gap đã đặc tả** (R6.6b, R6.7b) · **runtime Node 24.9.0 PASS tiêu chí 1–5**, gồm temp root sở hữu theo job | R6.6b, R6.7b, R6.14, R6.15 |
| **OQ-5** | **Hai preset + `custom`.** Không thêm 1:1 hay 4:5 khi chưa có nhu cầu thật | §4.3 |
| **OQ-6** | **ĐÃ CHẠY 2026-08-04** (§7.2). Cài theo host được chọn: `codex → .agents/skills`, `claude-code → .claude/skills`. Cả hai nhận frontmatter marker; chỉ Claude theo `@CLAUDE.vidcom.md`, nên `link` là Claude-only và Codex dùng `manual_merge` | R12.9, R13.7, R13.18 |
| **OQ-7** | **Có.** Cập nhật [15-build-order](../../../product-features/15-build-order.md) ngay sau khi Goals được duyệt, cùng lúc đổi trạng thái tài liệu | ngoài AC — việc của SM |
| **OQ-8** | **Chốt toàn bộ**: AK-1/2/3/4/5/6/8 · `WriteAuthority` scope `workspace` · `install`/`replace` cho hai host + Claude-only `link` theo §7.2 · test đồng bộ agent-kit ↔ Tool Registry. Nếu phải cắt capacity thì **cắt R11 trước** | R13, R12 |
| **OQ-9** | **`explicit > cwd-có-marker > active > cwd`**, ghi vào steering/07 §3. Kèm: cwd-có-marker xét **sự có mặt** của `vidcom.json` chứ không xét tính hợp lệ (R1.2e); active không đọc được thì cảnh báo rồi fallback (R1.10c) | R1 |

### 7.1 Spike render (OQ-4) — **ĐÃ CHẠY 2026-08-04**

> Bằng chứng đầy đủ, log và script tái lập: [`spikes/phase-3-render/README.md`](../../../../spikes/phase-3-render/README.md).
>
> **Kết quả gate — ba câu, không gộp thành một:**
> - **Feasibility: PASS có điều kiện.** Đường render chạy được đầu-cuối; không tiêu chí nào buộc viết lại R6.
> - **Artifact safety: PASS. Cleanup gap đã hiểu và có AC.** HyperFrames thô vẫn leak khi crash/huỷ; Node 24 spike chứng minh VidCom có thể giam orphan vào render root có marker theo job để recovery thu hồi (R6.6b, R6.7b).
> - **Runtime: PASS trên Node 24.9.0 và 26.5.0.** Node 24 đã chạy đủ tiêu chí 1–5, không chỉ render cơ bản.
>
> MUST NOT ghi kết quả này thành "6/6 PASS". Hai tiêu chí không phải pass sạch, và gộp chúng vào một con số là mất đúng phần thông tin spike sinh ra.

| # | Kiểm | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | Render composition 3–5 giây | **PASS** | `intro.html` → 3.0 s / 236.7 KB / 54.3 s (1 worker); root 14 s → 3.5 MB / 73.3 s (2 worker) |
| 2 | Render composition **có narration** | **PASS** | Inject đúng shape `buildNarrationHtml()` → log `"hasAudio":true` |
| 3 | `ffprobe` xác nhận w/h/fps/duration **và audio stream** | **PASS** | 2 stream: h264 1920×1080 30/1 14.0 s 420 frame + aac 48 kHz stereo 14.0 s. Và audio **đúng vị trí**: cửa sổ 10.0–12.5 s = −11.9 dB, cửa sổ 0–5 s = −91.0 dB |
| 4 | Huỷ → Chromium **và** FFmpeg bị kill | **PASS** (2/2 lần) | Cây 6 descendant (1 ffmpeg + 5 chrome-headless-shell); kill **chỉ PID cha** → 0 còn sống sau 6 s; artifact không công bố |
| 5 | Crash → output dở **không** được coi là hợp lệ | **PASS** ở phần quyết định · **FAIL** ở phần dọn rác | Không MP4 nào được công bố, và **không `.mp4` nào trong work dir** — nhờ checkpoint `artifact validated` trước khi move. Nhưng crash **và** huỷ đều leak work dir ~1 MB, và render thành công **không** dọn orphan của lần trước (3 orphan trước → 3 sau) |
| 6 | Chạy dưới **đúng** Node/runtime app dùng | **PASS** | Xanh trên **Node v26.5.0** và **v24.9.0** — runtime CI ghim ([`ci.yml:52`](../../../../.github/workflows/ci.yml#L52)); Node 24 chạy đủ render, narration, ffprobe, cancel và crash |

Kiểm 4 và 5 quan trọng hơn kiểm 1 — và đó đúng là hai chỗ spike trả về thông tin không đoán được:

- **Tiêu chí 4 pass nhờ cơ chế không phải bảo đảm.** Windows **không** kill process con khi cha chết. Cả 6 descendant chết theo gần như chắc chắn vì **đóng pipe**: Chrome thoát khi CDP đứt, FFmpeg thoát khi stdin đóng. Đó là hành vi *thuận tiện*, không phải *bảo đảm* — nên R6.6 vẫn phải kill cả cây tường minh.
- **Tiêu chí 5 tách làm hai nửa với kết quả trái nhau.** Nửa nguy hiểm (artifact công bố nhầm) **pass sạch**. Nửa còn lại — dọn rác — fail, và fail theo kiểu **không bị chặn**: mỗi lần huỷ và mỗi lần crash để lại ~1 MB trong `TEMP` vĩnh viễn.

### 7.1b Bốn AC bổ sung sau spike — **đã viết vào R6**

Cả bốn là **thêm**, không phải sửa R6:

| AC | Nội dung chốt |
|---|---|
| **R6.6b** | Kill cả cây process tường minh (job object / process group), không dựa cascade pipe · chỉ chuyển `cancelled` **sau khi xác minh không còn descendant** · xoá work directory · xoá thất bại → `cleanupPending: true`, để recovery xử lý |
| **R6.7b** | Tạo render root riêng theo job, marker ở root; truyền `TEMP`/`TMP` hoặc output staging cho child. Thu hồi chỉ root thoả bốn điều kiện: dưới staging root · marker+`jobId` hợp lệ · quá `RENDER_WORKDIR_ORPHAN_GRACE_SECONDS` (3600 s) · job không chạy. **MUST NOT quét `TEMP` chung** |
| **R6.14** | `bestEffort` mặc định **`true`** (`warm-grain` strict fail dù output hợp lệ) · warning **lưu vào job metadata và trả về client** · `bestEffort: false` → readiness warning làm job fail bằng mã ổn định, không công bố artifact |
| **R6.15** | Remote media gồm element, CSS `url(...)` và request runtime → `remote_asset_not_local`; migrate media remote của sample vào `assets/**`. Script/stylesheet/font remote được phép ở Phase 3 nhưng bắt buộc warning + URL + `reproducible:false` |

### 7.1b-i Kiểm chứng Node 24.9.0 — **PASS 2026-08-04**

**Không** chỉ tiêu chí 1–3. Tiêu chí 4 và 5 chạm trực tiếp `child_process`, signal handling và cleanup — đúng ba thứ có thể khác nhau giữa hai major Node, và đúng hai tiêu chí mà kết quả trên 26.5.0 phụ thuộc vào hành vi đóng pipe. Phạm vi tối thiểu:

| # | Kết quả trên Node 24.9.0 |
|---|---|
| 1 | **PASS** — render 3.0 s: H.264 1920×1080, 30 fps, 90 frame; render narration 14.0 s: H.264 + AAC, 420 frame; audio 10.0–12.5 s = **−11.9 dB**, nền 0–5 s = **−91.0 dB** |
| 2 | **PASS** — cancel thấy đúng 6 descendant (1 FFmpeg + 5 Chrome); kill PID cha → 0 còn sống sau 6 s; không có artifact công bố; log pipeline ghi `nodeVersion: "v24.9.0"` |
| 3 | **PASS** — crash kill cả cây → 0 còn sống, không có artifact; HyperFrames thô leak 1.04 MB. Khi child nhận `TEMP`/`TMP` là root có marker do VidCom kiểm soát, orphan duy nhất nằm tại `<owned-root>/hf-render-I8okOf`, chứng minh recovery có thể áp containment + marker + `jobId` mà không quét `TEMP` chung |

Node ZIP được tải portable, hash SHA-256 khớp `SHASUMS256.txt` chính thức; không cài vào máy. FFmpeg/FFprobe dùng lại sidecar portable của spike. Artifact và orphan do lượt kiểm này được dọn sau khi ghi evidence.

### 7.1c Phát hiện phụ đáng giá cho Design

| Phát hiện | Ảnh hưởng |
|---|---|
| Thiếu binary → lỗi **nêu tên từng binary** (`FFmpeg not found` / `FFprobe not found`), fail **trước khi** launch Chrome | **R6.12 đã khả thi sẵn** — chỉ cần đừng bọc lại thành "render failed" |
| `hyperframes` resolve ffmpeg qua `HYPERFRAMES_FFMPEG_PATH`, không bundle binary | Đường cho **PK-7** đã có: VidCom set env var trỏ vào sidecar đã giải nén là đủ |
| Pipeline có checkpoint `artifact validated` **trước khi** move file vào đích | Nền của R6.7 — VidCom MUST giữ đúng thứ tự này, MUST NOT tự dựng lại |
| `hyperframes validate` **deprecated** → `hyperframes check` | Khớp đúng tên lệnh **R9.3** đã viết |
| `--workers` scale thật: 90 frame/1 worker = 54 s; 420 frame/2 worker = 73 s | Render là job phút-cấp đúng như R6 giả định (R6.11 concurrency có cơ sở) |

### 7.2 Ma trận spike thư mục skill (OQ-6)

| Host | `.agents/skills` | `.claude/skills` | Frontmatter lạ (`x-vidcom-agent-kit`) | Dòng link trong file chỉ dẫn |
|---|:-:|:-:|:-:|:-:|
| Codex 0.146.0 | **PASS** — `$vidcom` gọi probe | **FAIL** — skill không được đăng ký | **PASS** | **FAIL** — `Read and follow ./AGENTS.vidcom.md.` không đưa token vào effective instructions |
| Claude Code 2.1.220 | **FAIL** — `Unknown command: /vidcom` | **PASS** — `/vidcom` gọi probe | **PASS** | **PASS** — `@CLAUDE.vidcom.md` truyền đúng token tới probe |

Tiêu chí PASS: agent **kích hoạt được router bằng cú pháp native** (`$vidcom` với Codex, `/vidcom` với Claude Code) và **gọi đúng một tool MCP giả lập** — MUST NOT dừng ở "file được tìm thấy". Một skill được đọc mà không được chọn thì kết quả với người dùng giống hệt như không có skill.

Harness tái lập và tóm tắt evidence nằm tại [`spikes/phase-3-agent-kit-host/`](../../../../spikes/phase-3-agent-kit-host/). Ngày 2026-08-04, sau khi người dùng cho phép tường minh, mỗi ca dùng workspace tổng hợp ngoài repo và MCP `vidcom_probe`; một câu trả lời text không có record server không được tính PASS. Codex chạy read-only, chỉ allowlist + auto-approve `vidcom_probe`; Claude dùng strict MCP config và chỉ allow tool tương ứng.

**Quyết định OQ-6:** cài manifest riêng theo host (`codex → AGENTS.md + .agents/skills/**`; `claude-code → CLAUDE.md + .claude/skills/**`). Giữ marker frontmatter. Giữ `link` chỉ cho Claude Code; Codex dùng recovery `manual_merge`. Bất kỳ mapping/import mới nào trong tương lai phải vượt lại cùng probe trước khi vào manifest.

---

## 8. Quality Checklist

**Completeness**
- [x] Mọi user role được nêu (người dùng cuối; harness qua MCP)
- [x] Có normal case, edge case và error case cho từng requirement
- [x] Mọi tương tác đều có phản hồi hệ thống được định nghĩa
- [x] Business rule và constraint được nêu (M1–M5; P1, P3, P4, P5, P6, P11; W1–W7; S1–S8; steering 03, 07 và 14)
- [x] Data and Persistence Scope hoàn thành (§3)
- [x] Ownership, lifecycle, consistency, query, migration đều được nêu
- [x] Trạng thái mới `empty` được nêu ở **mọi** đường đọc bị ảnh hưởng (R6.2, R7.2, R8.6, R9.8, R10.11, R12.8)
- [x] Trạng thái `authored` **0 scene** — phân biệt với `empty` — được đặc tả ở render, snapshot và diagnostics (§4.4, R6.2b, R7.2b, R9.8b)
- [x] Trạng thái `invalid` được phủ ở **cả hai** nguyên nhân (`vidcom.json` lỗi — R1.8; `index.html` lỗi — R1.2b) **và** có một bảng hành vi dùng chung cho mọi đường (R1.2d), trong đó diagnostics là ngoại lệ vẫn chạy được (R9.8c)
- [x] Lý do `invalid` có **mã ổn định** + line/column, không phải raw stack trace (R1.2c)
- [x] Marker cwd **bị lỗi** vẫn giữ được tín hiệu workspace — không âm thầm nhảy sang active (R1.2e)
- [x] Snapshot `partial` gắn với `partialAtSourceRevision`, nên retry sau khi source đổi **sinh lại toàn bộ** thay vì trộn hai generation (R7.9c)
- [x] `duration_overflow` có discriminator `limitKind` + `extendRootAllowed`, và hằng số được đặt tên theo **nguyên nhân thật** (guard sản phẩm, không phải giới hạn encoder) — R10.5b–5c
- [x] `custom` preset có bounds tường minh, validate ở biên **nhận** chứ không ở biên dùng (R2.4b–4d)
- [x] Kết quả cài agent-kit là một **state machine đủ và loại trừ lẫn nhau**: 6 state per-file, outcome suy từ trạng thái **sau** operation, `blocked` định nghĩa bằng `usableBy` (R13.9a). Kiểm bằng các tổ hợp dễ sai: `current_pristine` + `missing`, file chỉ dẫn `foreign` + router pristine, và router không discover/parse được.
- [x] `usableBy` là **enum ba giá trị** theo từng host, suy từ effective host chain đã được spike kiểm chứng: router native quyết định `blocked`, còn file chỉ dẫn chung phân biệt `ready`/`degraded`; `AGENTS.md` hỏng nhưng `$vidcom` còn discover được SHALL là `degraded`, không báo sai `blocked` (R13.9b, 9b-i)
- [x] `blocked` chỉ khi **mọi** selected host `blocked`; hai host cùng `degraded` ra `partial` (R13.9a)
- [x] `install_agent_kit` là discriminated union: `install.hosts` bắt buộc không rỗng; `link.host` chỉ nhận `claude-code`; `replace.host+relativePath` chọn đúng một đích; `expectedFiles`/`usableBy` chỉ tính trên host được input chọn (R12.9-i…9-iii)
- [x] Kết quả tool tách `operationResult` khỏi `installationState`, nên Claude `link: applied` + installation `partial` không bị ép thành một outcome sai (R12.9, R13.9a)
- [x] Tập operation nhận `entryId` đóng ở **đúng bốn**, không có mục nào mơ hồ đọc được thành "tự ghi đè" (R1.2c-iv)
- [x] `newer` được bảo vệ — binary cũ MUST NOT hạ cấp agent-kit mới hơn (R13.9b-ii)
- [x] Project `invalidKind: "identity"` có định danh gọi được (`entryId`) mà **không** cần bịa `ProjectId` hay ghi vào file đang lỗi (R1.2c-iii), và tập operation nhận `entryId` là tập **đóng** (R1.2c-iv)
- [x] Diagnostic của project `invalid` trả đúng `invalidReason.code`, không phải một mã cố định (R9.8c–8d)
- [x] Diagnostics qua `entryId` không bịa `ProjectId`, trả `sourceRevision:null` và MUST NOT ghi `.vidcom/**`; projection chỉ trở lại sau khi identity hợp lệ (R9.1, R9.8e, R9.9)
- [x] Snapshot `partial` **retry được** — `complete: false` chặn R7.10 khoá vĩnh viễn các scene còn thiếu (R7.9b–9c)
- [x] Ba nguồn giới hạn thời lượng được phân biệt, mỗi cái một hành vi và một mã (R10.5b)
- [x] Remote media phủ cả CSS `url(...)` và request runtime; external script/stylesheet/font làm sidecar `reproducible:false`, nên guarantee không vượt quá dữ liệu mà `sourceRevision` thật sự đếm (R6.4, R6.15–15b)
- [x] Orphan cleanup có root sở hữu theo job, marker+`jobId`, grace constant 3600 s và active-job guard; spike Node 24 chứng minh HyperFrames workdir bị giam dưới root đó (R6.7b, §7.1b-i)
- [x] Chỉ **một** chuỗi ưu tiên workspace, dạng bảng, không có AC nào chồng điều kiện (R1 §Bảng quyết định)
- [x] Approval Gate có mặt và đã được xác nhận tường minh trước khi bắt đầu Design

**Clarity**
- [x] Dùng MUST / MUST NOT / SHALL nhất quán
- [x] Viết từ góc nhìn hành vi quan sát được, không nêu cách hiện thực
- [x] Mọi tham chiếu code có đường dẫn và số dòng kiểm được
- [x] Bốn vùng lưu trữ được phân biệt tường minh (§4.1): `~/.vidcom/setting.json` / agent-kit ở gốc workspace / `vidcom.json` / `.vidcom/`
- [x] Bốn state của project được định nghĩa bằng điều kiện kiểm được (§4.4)
- [x] Ranh giới MCP (cách harness *làm*) vs agent-kit (cách harness *biết*) được nêu tường minh (§1.1, §2)
- [x] Đích cài agent-kit nêu cả cái được phép (gốc workspace) và cái bị cấm (`~/.claude`, `~/.codex`) — R13.7b

**Consistency**
- [x] EARS dùng xuyên suốt
- [x] Không có requirement nào mâu thuẫn requirement khác — sweep ở bản 4 (4 chỗ M5 còn sót) và **sweep lại ở bản 5** cho ba mâu thuẫn bản 4 tự tạo: `snapshots`/`renders` trong tập làm revision tiến, `blocked` khớp cả bản đã cài đúng, và "không có đường ghi đè" vs append/cờ thay
- [x] Không có hai chỗ nào tự trả lời cùng một câu hỏi theo hai cách khác nhau — luật này bị vi phạm ở bản 3 **và** bản 4, nên nó được kiểm tường minh mỗi vòng chứ không giả định
- [x] Mỗi luật "luôn/không bao giờ" được kiểm xem có ngoại lệ nào ở chỗ khác trong tài liệu — bản 4 khai hai luật tuyệt đối ("không đường nào ghi đè", "version không thể lệch với nội dung") mà cả hai đều có ngoại lệ nằm ngay dưới. Ngoại lệ giờ được nêu tại chỗ: §4.6 Luật 1 (`install`/`replace` + Claude-only `link`) và Luật 2 (marker chứng minh version nguồn, không chứng minh nội dung)
- [x] **Xung đột steering đã được nhận diện, được người dùng chấp nhận và có deliverable đóng nó**: R4 vs steering/07 §2/§6; R4.9 bắt buộc sửa steering ngay sau Goals approval, trước khi Design được coi là hoàn tất. Đây là post-approval deliverable, không tạo vòng lặp bắt Goals phải hoàn thành việc chỉ được làm sau Goals
- [x] **build-order lệch đã có quyết định và thời điểm sửa** — OQ-7 bắt buộc cập nhật doc 15 ngay sau Goals approval, cùng lần chuyển trạng thái. Requirement-level consistency đã đóng; file sync là post-approval deliverable của SM

**Testability**
- [x] Mọi AC verify được bằng test
- [x] Điều kiện thành công quan sát được (file tồn tại, mã lỗi, revision, state, byte của golden file, CI đỏ)
- [x] Nêu rõ chỗ cần datastore thật thay vì mock
- [x] Nêu rõ chỗ test phải **skip có thông báo** khi Chromium/FFmpeg vắng mặt
- [x] Nêu rõ ba trạng thái workspace mới phải phủ: folder trống, candidate chưa nhận, project `empty`

---

## Approval Gate

> Do not start detailed design until this section is explicitly confirmed.

- **Status**: **✅ APPROVED 2026-08-04** (bản 10) — Detailed Design đã bắt đầu: [spec-project-delivery-loop-detailed-design.md](./spec-project-delivery-loop-detailed-design.md)
- **Confirmed by**: Người dùng — yêu cầu tiếp tục sang Detailed Design sau khi OQ-1…OQ-9 và hai spike Goals đã đóng.
- **Confirmation date**: 2026-08-04

### Đã chốt — không còn là gate

| Mục | Trạng thái |
|---|---|
| **OQ-1…OQ-9** | Đóng cả chín (§7): bảy bằng quyết định, OQ-4/OQ-6 bằng kết quả spike thật |
| **Capacity** | **~190 SP / 7–8 tuần lịch** — bảng requirement cộng 190: base bản 8 là 180 + 10 SP ở R6 cho process-tree/workdir recovery và external dependency policy do spike phát hiện |
| **Thang cắt** | **R11** → **R4 `cache/`** → **R9 phần `hyperframes check`**. MUST NOT cắt R12, AK-8, hay scope `workspace` |
| **Ba deliverable sửa steering** | steering/07 §2+§6 (R4.9) · steering/07 §3 (R1.10, OQ-9) · steering/14 §8 (ba câu sai: đích cài, version trong `vidcom.json`, và "file phụ = thành công") |
| **Render + runtime gate** | ✅ Node 26.5.0 và CI Node 24.9.0; render/narration/ffprobe/cancel/crash đã chạy. Cleanup gap chuyển thành R6.6b/R6.7b với render root sở hữu theo job |
| **Spike ma trận host** | ✅ Codex 0.146.0: `.agents/skills`, frontmatter PASS, link FAIL. Claude Code 2.1.220: `.claude/skills`, frontmatter và `@CLAUDE.vidcom.md` PASS. Manifest/link contract đã đồng bộ vào R12/R13 |

### Gate còn lại

Không còn gate ở pha Goals. Approval Gate của Detailed Design nằm trong tài liệu Design và vẫn phải được xác nhận riêng trước khi tạo Implementation Checklist.
