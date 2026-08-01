# 14 — Agent kit: AGENTS.md, skill và quy trình chuẩn

VidCom export MCP cho AI host (**D1**). Nhưng tool schema **không đủ** để agent làm việc đúng — nó biết gọi được cái gì, không biết **nên gọi theo thứ tự nào** và **khi nào thì dừng lại hỏi**.

`packages/agent-kit/` là chỗ chứa phần chỉ dẫn đó.

---

## 1. Hai loại instruction — MUST NOT lẫn

| | Đối tượng | Ở đâu | Ai đọc |
|---|---|---|---|
| **Repo-level** | Agent làm việc **trên codebase vidcom** | `AGENTS.md` gốc + `llm-documents/steering/` | Agent phát triển app |
| **Shipped agent-kit** | Agent làm video **qua MCP của vidcom** | `packages/agent-kit/` → ghi vào project người dùng | Codex / Claude Code của người dùng cuối |

Tài liệu này nói về loại thứ hai. Nội dung hai loại MUST NOT trộn: người dùng cuối không cần biết import boundary của ta, và agent phát triển app không cần quy trình dựng video.

---

## 2. Cấu trúc

```text
packages/agent-kit/
├── AGENTS.md                    template ghi vào từng project người dùng
├── CLAUDE.md                    bản sao byte-for-byte của AGENTS.md
├── skills/
│   ├── vidcom/SKILL.md          router — entry point, đọc trước tiên
│   ├── vidcom-project/SKILL.md  tạo / mở / cấu trúc project
│   ├── vidcom-scene/SKILL.md    scene: tạo, timing, text, thứ tự
│   ├── vidcom-look/SKILL.md     tone, palette, subtitle, BGM
│   ├── vidcom-narration/SKILL.md TTS và caption
│   ├── vidcom-render/SKILL.md   snapshot, render, job
│   └── vidcom-fix/SKILL.md      đọc diagnostics và sửa
└── prompts/                     MCP prompt expose qua server
```

`CLAUDE.md` là bản sao của `AGENTS.md`, không phải symlink — Claude Code đọc `CLAUDE.md`, Codex đọc `AGENTS.md`. HyperFrames làm đúng vậy, ta theo.

MUST sinh `CLAUDE.md` từ `AGENTS.md` lúc build, MUST NOT sửa tay hai file.

---

## 3. Quy trình chuẩn — thứ agent phải theo

Đây là nội dung trung tâm của agent-kit. Mọi skill đều tham chiếu về đây.

```
1. DISCOVER   server/discover        → protocol version, capabilities, tool set
2. ORIENT     list_projects
              get_project_context    → scene, timing, revision, diagnostics hiện có
3. PLAN       nói lại ý định bằng lời; mơ hồ thì HỎI, không đoán
4. EDIT       create_scene / set_scene_timing / set_text / …
              mỗi call kèm expectedRevision lấy từ bước trước
5. VALIDATE   validate_project       → đọc diagnostics
6. PREVIEW    start_snapshot         → nhìn frame thật, không tin tưởng mù
7. NARRATE    start_tts              → chỉ khi scene có thoại
8. RENDER     start_render → get_job_status (poll, không block)
9. REPORT     đã đổi gì, revision nào, diagnostic nào còn lại
```

### Luật của quy trình

| # | Luật |
|---|---|
| W1 | **MUST NOT bỏ bước 2.** Không đoán `sceneId`, không đoán timing. Đọc trước khi ghi |
| W2 | **MUST NOT bỏ bước 5.** Sửa xong mà không validate là giao việc chưa xong |
| W3 | `expectedRevision` MUST lấy từ output của call ngay trước, không cache qua nhiều lượt |
| W4 | Thao tác destructive MUST được người dùng xác nhận, không tự quyết |
| W5 | Job MUST poll có backoff, MUST NOT vòng lặp chặt |
| W6 | Bước 9 MUST nói **diagnostic còn lại**, kể cả khi tác vụ chính đã xong |
| W7 | Gặp `write_conflict` MUST đọc lại rồi merge, MUST NOT ghi đè bằng cách bỏ `expectedRevision` |

### Cấm tuyệt đối trong agent-kit

| Cấm | Vì sao |
|---|---|
| Sửa `index.html` / `compositions/*.html` bằng file tool của agent | Daemon là single writer, có content-hash concurrency. Ghi vòng sau lưng gây conflict và mất revision/audit |
| Đoán đường dẫn tuyệt đối | Tool nhận `projectId` + đường dẫn tương đối |
| Coi `start_tts` trả về là đã có audio | Nó trả `jobId`. Audio chỉ tồn tại khi job `succeeded` |
| Tự chạy `hyperframes` CLI song song với app | Hai đường ghi |

Ngoại lệ cho dòng đầu: nếu người dùng **chủ động** yêu cầu sửa file thô, agent MUST dùng tool `save_file` (có `expectedContentHash`), không dùng file tool của riêng nó.

---

## 4. `AGENTS.md` ship vào project — nội dung bắt buộc

Theo đúng bộ khung mà HyperFrames dùng, vì agent đã quen đọc dạng đó:

| Mục | Nội dung |
|---|---|
| **Skills — USE THESE FIRST** | Trỏ `/vidcom` làm router; bảng intent → skill |
| **Quy trình chuẩn** | 9 bước ở §3, dạng rút gọn |
| **Tool reference** | Bảng tool theo mức read / write / job / destructive |
| **Project structure** | `index.html`, `compositions/`, `assets/`, `narration/`, `preview-settings.json`, `renders/` |
| **Key rules** | Invariant của HyperFrames mà agent phải giữ (xem dưới) |
| **Validate — ALWAYS** | `validate_project` sau mọi thay đổi, sửa hết `error` trước khi báo xong |
| **Troubleshooting** | 4 diagnostic thường gặp và cách sửa |

### Key rules phải nêu trong `AGENTS.md`

Rút từ P1–P11 và những gì runtime thực sự yêu cầu:

1. Mọi element có timing cần `data-start`, `data-duration`, `data-track-index`, và `class="clip"`.
2. Timeline GSAP phải `paused: true` và đăng ký lên `window.__timelines[<composition-id>]`.
3. Scene mới phải là **file sub-composition riêng** với `data-composition-src` — host inline không được runtime quản lý visibility nên nó hiện suốt video (**P11**).
4. Tween viết sau khi clip của scene kết thúc thì **không bao giờ chạy** — nới `data-duration` hoặc dời tween.
5. Đổi màu / tone / subtitle / BGM đi qua preview settings, **không** sửa composition source (**P2**).
6. Chỉ logic deterministic — không `Date.now()`, không `Math.random()`, không fetch.

---

## 5. Skill — format và luật

### Format
Theo chuẩn `SKILL.md` có frontmatter:

```markdown
---
name: vidcom-scene
description: Tạo, sửa timing, sửa text và đổi thứ tự scene qua MCP của VidCom. Dùng khi người dùng muốn thêm/bớt/chỉnh một beat của video. Không dùng cho tone màu và nhạc nền (→ /vidcom-look).
---
```

`description` là thứ router dùng để chọn skill. MUST nói **khi nào dùng** và **khi nào không**.

### Luật viết skill

| # | Luật |
|---|---|
| S1 | Một skill một ý định. Skill "quản lý mọi thứ" là skill không bao giờ được chọn đúng |
| S2 | MUST có `/vidcom` làm **router duy nhất**, mọi skill khác được nó trỏ tới |
| S3 | Skill MUST nói bằng **tool**, không bằng lệnh shell hay đường dẫn file |
| S4 | MUST nêu tiền điều kiện: cần `projectId` chưa, cần `expectedRevision` từ tool nào |
| S5 | MUST nêu tác dụng phụ đáng ngạc nhiên (sửa script làm narration stale) |
| S6 | MUST có mục "khi nào KHÔNG dùng skill này" |
| S7 | MUST NOT chép lại tool schema — schema là nguồn sự thật, skill nói **cách dùng** |
| S8 | Ví dụ trong skill MUST là một chuỗi tool call thật, không phải mô tả trừu tượng |

---

## 6. Skill vs mô tả tool vs MCP prompt

Ba thứ khác nhau, MUST NOT nhồi vào cùng một chỗ:

| | Trả lời | Ở đâu | Dài |
|---|---|---|---|
| **Mô tả tool** | Tool này làm gì, tiền điều kiện, tác dụng phụ | tool schema ([05](05-mcp-tool-design.md) §8) | 2–5 câu |
| **Skill** | Ghép nhiều tool thành một ý định của người dùng | `agent-kit/skills/` | 1 trang |
| **MCP prompt** | Mẫu hội thoại có tham số người dùng chọn từ UI của host | `agent-kit/prompts/` | ngắn |

Không phải host nào cũng đọc file trong project. Nên:

- Thông tin **bắt buộc để gọi tool đúng** MUST nằm trong **mô tả tool** — nó luôn tới được agent.
- Skill và `AGENTS.md` là **tăng cường**, MUST NOT là nơi duy nhất chứa một luật an toàn.

Ví dụ: "destructive cần xác nhận" phải được **server cưỡng chế** (từ chối nếu chưa xác nhận), không chỉ ghi trong `AGENTS.md`.

---

## 7. Đồng bộ với tool contract — chống mục

Agent-kit mục là agent làm sai. Nguy hiểm hơn tài liệu người đọc mục, vì agent tin tuyệt đối.

| Thay đổi | MUST cập nhật |
|---|---|
| Thêm / đổi tên / xoá tool | bảng tool trong `AGENTS.md` + skill liên quan |
| Đổi mức quyền của tool | `AGENTS.md` + skill |
| Thêm diagnostic code mới | mục Troubleshooting |
| Đổi quy trình chuẩn | §3 ở đây + `AGENTS.md` + mọi skill trỏ tới nó |
| Thêm protocol revision | phần degrade trong `AGENTS.md` nếu tool bị ẩn ở legacy |

**Cưỡng chế bằng test, không bằng review:**

- MUST có test đối chiếu danh sách tool trong `AGENTS.md` với Tool Registry — lệch thì đỏ CI.
- MUST có test mọi skill tham chiếu tool tồn tại.
- MUST có test mọi `/vidcom-*` mà router trỏ tới đều có `SKILL.md`.

Đây là ba test rẻ và chặn đúng loại lỗi hay xảy ra nhất.

---

## 8. Cài đặt vào project người dùng

- `agent-kit` nhúng trong binary (D2), MUST NOT đọc từ đĩa cạnh executable.
- Ghi `AGENTS.md` + `CLAUDE.md` vào project khi **tạo project**, và khi **mở project** nếu file thiếu hoặc lệch version.
- MUST ghi version của agent-kit vào `vidcom.json` để biết khi nào cần refresh.
- File người dùng đã sửa tay: MUST NOT ghi đè im lặng. Hoặc hỏi, hoặc ghi ra `AGENTS.vidcom.md` và báo.
- Skill cài vào đâu tuỳ host. MUST cung cấp lệnh tường minh (`vidcom skills install`) thay vì đoán thư mục của từng host.

MUST NOT ghi skill vào workspace mỗi lần khởi động — đó là rác trong thư mục người dùng.

---

## 9. Ngôn ngữ

- `AGENTS.md`, `CLAUDE.md`, skill, prompt: **tiếng Anh**. Đây là file agent đọc, và model hoạt động tốt nhất với tiếng Anh; người dùng cuối cũng có thể không phải người Việt.
- Ngoại lệ: nếu sau này có bản địa hoá, MUST là file riêng theo locale, MUST NOT trộn hai ngôn ngữ trong một file.

Khác với `llm-documents/` — tài liệu nội bộ vẫn tiếng Việt ([12-documentation-rules](12-documentation-rules.md) §6).

---

## 10. Cấm

| Cấm | Vì sao |
|---|---|
| Đặt luật an toàn **chỉ** trong `AGENTS.md` | Không phải host nào cũng đọc. Server phải cưỡng chế |
| Chép tool schema vào skill | Hai nguồn sự thật, chắc chắn lệch |
| Skill hướng dẫn chạy shell / sửa file trực tiếp | Vòng qua single writer |
| Ship agent-kit lệch version với tool contract | Agent làm sai theo tài liệu của chính ta |
| Ghi đè `AGENTS.md` người dùng đã sửa | Mất công sức của họ |
| Trộn instruction repo-level vào agent-kit | §1 |
