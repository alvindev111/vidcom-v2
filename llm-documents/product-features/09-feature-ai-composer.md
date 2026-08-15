# 09 — AI Composer

File liên quan: [ai-composer-panel.tsx](../../src/components/studio/ai-composer-panel.tsx), [agent-terminal-client.ts](../../src/lib/studio/agent-terminal-client.ts), [agent-session.ts](../../src/lib/studio/agent-session.ts), [agent-terminal.ts (routes)](../../packages/server/src/routes/agent-terminal.ts), [start-agent-terminal.ts](../../packages/core/src/usecase/start-agent-terminal.ts), [agent-terminal-pty.ts](../../packages/adapter/src/agent/agent-terminal-pty.ts), [project-writes.ts](../../packages/server/src/routes/project-writes.ts) (`mcpTranscript`)

Tab thứ 3 của SourcePane. Tab trigger luôn có viền accent (kể cả khi không active) để "AI surface" luôn nhận diện được.

---

## F-9.1 — Chọn agent

**Là gì:** Toggle group `Claude Code` / `Codex`, badge `mock MCP`, và dòng bên phải `codex · ~/projects/<slug>`.

**Logic hiện tại:** `AgentId = "claude" | "codex"`, default `"codex"`. Label và command map trong [agent-session.ts](../../src/lib/studio/agent-session.ts):
```ts
AGENT_LABEL   = { claude: "Claude Code", codex: "Codex" }
AGENT_COMMAND = { claude: "claude",      codex: "codex" }
```

**Trạng thái:** MOCK — chọn agent chỉ đổi transcript hiển thị, không có process nào.

---

## F-9.2 — Transcript mở đầu (canned)

**Là gì:** Terminal thật chạy chính CLI `claude` hoặc `codex` của người dùng.

**Logic hiện tại:**
- Daemon spawn CLI dưới pseudo-terminal (`node-pty`) với `cwd` = thư mục project, qua [`NodePtyAgentTerminals`](../../packages/adapter/src/agent/agent-terminal-pty.ts). Policy — agent nào được phép, tái gắn thay vì mở phiên thứ hai, trần số phiên đồng thời — nằm ở use case [`startAgentTerminal`](../../packages/core/src/usecase/start-agent-terminal.ts).
- Output đi về client bằng SSE (`GET /v1/projects/:id/agent-terminal/:sessionId/stream`), phím gõ và resize đi lên bằng POST. Không dùng WebSocket: upgrade sẽ đi vòng qua middleware perimeter (Host check, CORS, session cookie).
- Agent được trỏ vào MCP HTTP của **chính daemon đang chạy** (`/api/mcp`) với một credential riêng nhãn `agent:terminal`. Không spawn `vidcom mcp`: server stdio đó cần lease workspace mà daemon đang giữ, nên nó khởi động rồi chết và agent báo "Tools: (none)".
- Bearer đi qua biến môi trường (`VIDCOM_MCP_TOKEN`), không bao giờ qua argv — Claude Code nội suy `${VAR}` trong `--mcp-config`, Codex có `bearer_token_env_var`.

Render ([ai-composer-panel.tsx](../../src/components/studio/ai-composer-panel.tsx)): xterm.js + addon-fit, nạp động trong effect vì trang này là static export và xterm chạm `document` lúc khởi tạo.

**Nhập tiếng Việt — hai lỗi riêng biệt, đừng lẫn:**

1. **Console code page (Windows).** Ứng dụng ở chế độ virtual-terminal input nhận phím do ConPTY mã hoá **qua console input code page**. Máy đặt 932 thì mọi dấu tiếng Việt thành `?` (`Chào bạn` → `Ch?o b?n`). Đã đo: node-pty tự nó không hỏng (cmd.exe echo giữ nguyên dấu), `useConptyDll: true` không sửa được, winpty cũng không. Cách sửa duy nhất hiệu quả là đặt code page trước khi agent khởi động — xem [consoleLaunchPlan](../../packages/adapter/src/agent/executable-lookup.ts).
2. **Bộ gõ vs xterm.** UniKey/EVKey không phát composition event mà gõ backspace rồi thay ký tự; xterm reset textarea ẩn sau mỗi phím nên ký tự cần thay đã biến mất. Vì vậy pane có thêm một `<input>` thật ở đáy: gõ ở đó, Enter đẩy cả dòng xuống pty.

**Trạng thái:** THẬT. Đã kiểm chứng bằng phiên Codex trả về đủ 18 tool của server `vidcom` kèm `Auth: Bearer token`.

---

## F-9.3 — "Generate scene" — phần THẬT

**Là gì:** Input text + nút `Generate scene`. Đây là **hành động ghi thật** duy nhất của tab này.

**Luồng:**
```
UI: prompt "Team retro cadence"
 └─ append vào transcript:  ""  ·  "> Team retro cadence"  ·  "· mcp hyperframes.add_scene …"
 └─ PATCH /api/hf/<slug>/scene { action: "generate", prompt }
      ├─ prompt.trim() rỗng → 400 { error: "prompt is empty" }
      └─ createScene(slug, prompt)                       ← GHI THẬT
           └─ ok → 200 { ok, sceneId, transcript: mcpTranscript(...) }
 └─ append transcript trả về, clear input, onProjectChanged()
```

### `createScene(slug, title, {duration = 4})` — [sdk.server.ts:244](../../src/lib/hyperframes/sdk.server.ts#L244)

1. `openProjectFile(slug, "index.html")` → SDK composition (headless).
2. `findRootHost(roots)` — element có **cả** `data-width`, `data-height`, `data-composition-id`. Không thấy → `{ok:false, error:"root composition not found"}`.
3. Tính `start`:
   ```js
   hosts = root.children.filter(c => c.attributes["data-composition-id"])
   ends  = hosts.map(c => Number(data-start ?? 0) + Number(data-duration ?? 0))
   start = ends.length ? Math.max(...ends) : 0
   ```
   → scene mới **luôn append vào cuối** timeline. Lưu ý: chỉ xét `root.children` (con **trực tiếp**), không đệ quy.
4. `duration = opts.duration ?? 4` — hard-code 4 giây.
5. Tính `sceneId`:
   ```js
   generated = hosts.map(c => /^scene-(\d+)$/.exec(id)).filter(Boolean).map(m => Number(m[1]))
   sceneId   = `scene-${generated.length ? Math.max(...generated)+1 : 1}`
   ```
   Comment: chỉ đếm các scene **do studio sinh ra trước đó**; đếm cả overlay và transition block sẽ làm scene đầu tiên thành `scene-6`.
6. `trackIndex = max(0, ...hosts.map(data-track-index ?? 0)) + 1`.
7. Ghi file scene mới `compositions/<sceneId>.html` bằng template `sceneCompositionHtml()`:
   - Document đầy đủ, `1920px × 1080px` hard-code, `background: transparent`, font `"Outfit", sans-serif`.
   - `<div id data-composition-id data-width="1920" data-height="1080" data-start="0" data-duration="<n>">` + `<h2>` chứa title đã escape.
   - **Không có GSAP timeline** — comment: "Minimal static scene — no GSAP timeline, so nothing to register."
   - `escapeHtml` xử lý `& < > "`.
8. Mount vào root bằng fragment:
   ```html
   <div id="<sceneId>-layer" class="comp-layer clip"
        data-composition-id="<sceneId>" data-composition-src="compositions/<sceneId>.html"
        data-start="<start>" data-duration="<duration>" data-track-index="<trackIndex>"></div>
   ```
   Comment quan trọng: **mỗi scene sinh ra phải có file sub-composition riêng**. Một host inline chỉ có `data-composition-id` mà không có `src` **không được runtime quản lý visibility** → nó render suốt cả video thay vì chỉ trong khoảng thời gian của nó.
9. `can({type:"addElement", parent: root.scopedId, index: root.children.length, html: fragment})` → từ chối thì trả message SDK.
10. `addElement(...)`.
11. Nới duration root nếu cần: `if (start + duration > rootDuration) setTiming(root, {duration: start + duration})`.
12. `save()` → `serialize()` → ghi `index.html`, `dispose()`.
13. `regenerateNarration(slug, sceneId, title)` — narration dùng **chính prompt** làm text.
14. Trả `{ok, sceneId, start, duration, narration}`.

**Trạng thái:** THẬT — file được tạo, `index.html` được sửa, duration root được nới, narration record được ghi.

**Vấn đề đã biết:**
- Prompt được dùng **nguyên văn làm tiêu đề `<h2>`** và làm text narration. Không có AI nào diễn giải nó. Gõ "làm một scene có 3 cột số liệu" thì scene chỉ hiện đúng câu đó dưới dạng chữ.
- Duration cứng 4s, kích thước cứng 1920×1080, font cứng `Outfit` — không đọc từ project.
- Không có animation.
- `trackIndex` = max+1 → scene mới luôn nằm **trên cùng**, kể cả trên overlay grain có trackIndex 100 (đúng ý ở đây nhưng dễ sai với các layout khác).
- Không có cách xoá scene đã sinh ra.

---

## F-9.4 — Transcript MCP giả (sau khi generate)

**Logic hiện tại** (`mcpTranscript` — [route.ts:104](../../src/app/api/hf/[slug]/scene/route.ts#L104)): server dựng chuỗi dòng terminal:
```
$ codex
● Codex CLI · MCP server "hyperframes" (stdio) · workspace <slug>

> <prompt>

· mcp hyperframes.list_compositions
· mcp hyperframes.add_scene { id: "<sceneId>", start: <n>, duration: <n> }
· mcp hyperframes.tts { scene: "<sceneId>", voice: "af_heart" } → narration/<sceneId>.wav
· mcp hyperframes.lint
✓ <sceneId> written to index.html — open the Video Scene tab to edit it
```
Comment ghi rõ: "The scene and its narration record are real writes; the MCP session around them is scripted — no Codex process is running."

Điểm đáng chú ý: 3 trong 4 tool call được liệt kê là **giả**:
- `list_compositions` — không gọi
- `tts` — chỉ ghi record, không tạo wav
- `lint` — không chạy lint nào

Chỉ `add_scene` là thật.

**Trạng thái:** MOCK.

---

## Kỳ vọng backend

### 1. Chạy agent thật
Hai kiến trúc khả thi:

**(a) MCP server + agent CLI (giống transcript đang mô phỏng)**
- Backend expose một **MCP server** với tool set: `list_compositions`, `read_composition`, `add_scene`, `set_timing`, `set_text`, `add_element`, `add_block`, `tts`, `snapshot`, `lint`, `check`, `render`.
- Spawn `claude` / `codex` CLI trong PTY, cwd = project dir, stdio nối MCP.
- Stream output PTY về client qua WebSocket/SSE → terminal hiện transcript **thật**.
- Cần: quản lý process (timeout, kill, giới hạn concurrent), sandbox (agent có quyền ghi cả filesystem), audit log mọi tool call.
- `@modelcontextprotocol/client` đã có trong `package.json` — có lẽ là dự định ban đầu.

**(b) Gọi model API trực tiếp**
- Backend gọi Claude API với tool-use, tools = các operation của SDK.
- Dễ kiểm soát hơn (không có shell), nhưng mất khả năng dùng skill/workflow của HyperFrames CLI (`/hyperframes`, `/motion-graphics`, …) mà project mẫu đang trông vào (xem `projects/*/AGENTS.md`).

Khuyến nghị: **(a)** vì HyperFrames đã có hệ skill/workflow rất dày, và `AGENTS.md` trong mỗi project đã viết cho agent CLI.

### 2. Yêu cầu chức năng cho AI Composer đầy đủ
| Chức năng | Ghi chú |
|---|---|
| Chat nhiều lượt có lịch sử | Hiện mỗi generate độc lập, lịch sử chỉ là mảng local, mất khi đổi tab |
| Streaming token/tool-call | Hiện chờ xong rồi mới in một cục |
| Hủy giữa chừng | Không có |
| Diff preview trước khi apply | Không có — agent ghi thẳng |
| Undo một lượt agent | Không có |
| Cho phép agent đọc preview settings / snapshot / lỗi lint | Không có |
| Attach ảnh/brief/URL làm input | Không có |
| Chọn model / effort | Không có |
| Giới hạn quyền (chỉ được ghi trong project) | Hiện không cần vì không có agent thật; **bắt buộc** khi có |
| Hiển thị chi phí token | Không có |
| Nhiều session song song | Không có |

### 3. Cần cho `createScene` tốt hơn
- Nhận đủ tham số: `{ prompt, duration?, start?, trackIndex?, template?, width?, height? }`.
- Chèn tại vị trí bất kỳ (kèm ripple đẩy scene sau).
- Template thư viện (title card, stat, quote, lower-third…) thay vì một `<h2>` trơ.
- Đọc kích thước/font/palette từ project thay vì hard-code.
- Sinh GSAP timeline cơ bản (fade in/out) để scene không tĩnh chết.
- `DELETE /projects/:slug/scenes/:id` — xoá file + xoá mount + thu hẹp root duration.
