# Spec Packaging & Distribution Runtime — Detailed Goals

> **Reference**: [Main Spec File](./spec-packaging-and-distribution-pending.md)
> **Bản 4 — 2026-08-06.** Viết sau khi soi code thật của Giai đoạn 3 đã hoàn tất (commit `c9922fd`) và sau **hai vòng spike Phase 4** ([`spikes/phase-4/README.md`](../../../../spikes/phase-4/README.md)). Tài liệu này nói **cái gì** và **vì sao**; kiến trúc, bảng schema, endpoint, cấu trúc archive và tên file thuộc [`detailed-design.md`](./spec-packaging-and-distribution-detailed-design.md), đã được mở sau khi Goals được duyệt.
> Trạng thái: **APPROVED** (2026-08-07) — **Design đã mở**. Spike gate đã mở (S1a, S1b, S2, S3 đều PASS), 13/13 open question đã đóng (§7), và vòng duyệt lại đã chấp nhận ba bản sửa OQ-4/OQ-7/OQ-8. Detailed Design được phép tạo; Implementation Checklist và production code vẫn bị gate sau chặn.
>
> **Sửa sau khi duyệt — 2026-08-07 (vòng review Design):**
> - **R6.8 và R8.3 bỏ câu "chứng minh không còn tiến trình con".** Nó nghịch [steering 08 §6.1](../../../steering/08-jobs-and-queue.md) — nơi bảo đảm zero-survivor đã bị rút lại sau khi đo thật — và nghịch cả Design (§11.4), vốn đã chuyển sang termination proof có cờ `exhaustive` cộng containment workdir. Ba tài liệu giờ nói cùng một thứ; checklist trước đó **không thể** thoả đồng thời hai contract.
> - **R2.14 nới thành ba lối.** Vòng đo Windows và vòng review Design cho thấy câu chữ hai-lối buộc Design phải đóng cả tiến trình khi mất lease, giết một UI vốn không phụ thuộc workspace. Thêm lối "hạ xuống chưa-có-workspace" cho trường hợp **có UI**; headless vẫn dừng hẳn. Bất biến single-writer không đổi và trở thành nghĩa vụ chứng minh bằng test. → **R2.14**, Design **DR-14**.
> - **SP: R2 34→37, R6 21→25, tổng ~170→~177.** R2 gánh lối thứ ba; R6 gánh xử lý TLS inspection (N-1) mà [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md) đo được và người dùng chốt là **trong phạm vi** Giai đoạn 4.
>
> **Lịch sử vòng phản biện 2026-08-07 — ba OQ từng được yêu cầu sửa trước khi duyệt:**
> - **OQ-7**: bỏ khẳng định "Linux gần như trùng macOS" (không có bằng chứng — spike mới chạy `darwin arm64`) và gỡ mâu thuẫn *cam kết ba nền tảng nhưng cho cắt một*. Viết lại thành: ba artifact target, **Windows là release gate**, defer Linux là thay đổi phạm vi có chủ đích phải tuyên bố hẹp lại → **R8.5**.
> - **OQ-4**: sửa nhân quả — vấn đề không phải render *chạy ở đâu* mà là CLI tự dựng foundation/scheduler hoặc tự publish ⇒ execution authority thứ hai. Chốt invariant thin-client → **R3.3**.
> - **OQ-8**: giới hạn diễn đạt theo **capability** thay vì theo URL, kèm minimum UX và test bắt buộc → **R1.19**.
> - **SP: R1 21→26, tổng ~170.** OQ-8 hứa "~5 SP" từ bản 2 nhưng chưa bao giờ vào bảng.
>
> **Đổi so với bản 3** (sau vòng spike thứ hai — S4, S5, S6, S7):
> - **Đóng nốt 11 OQ còn mở.** Sáu cái đóng bằng **số đo**, năm cái bằng lý lẽ kiến trúc. §8 ghi rõ cái nào thuộc loại nào, vì chỉ loại thứ hai mới tranh luận được.
> - **Ba giả định của bản 3 bị bác bỏ** (§1.9): (a) lý do chọn sidecar sai — supervisor không dùng `execPath`, kill-tree sạch ở cả hai hình dạng, và Node nén chỉ 35,9 MB chứ không phải ~110 MB ⇒ **OQ-13 đổi sang shim**; (b) OQ-10 rẻ hơn nhiều — một biến đổi được, không phải rewrite lifecycle; (c) Chromium là **Chrome Headless Shell 94,5 MB / 8 s**, không phải 150–200 MB.
> - **R6.8 sửa lại**: bỏ câu "MUST NOT nhận diện con bằng `execPath`" — cơ chế hiện có đã đúng, việc cần làm chỉ là test.
> - **R2.13 được chứng minh là correctness**, không phải hardening: S7 dựng lại kịch bản chiếm port và bridge ngây thơ gửi mutation vào tiến trình lạ.
> - Ước lượng **~165 SP / 7–8 tuần**; vòng duyệt 2026-08-07 nâng lên **~170** (R1 21→26, xem §8 mục 3).
>
> **Đổi ở bản 3** (sau vòng spike thứ nhất):
> - **P-C viết lại**: artifact không cần Python **cài sẵn** — nhưng nó **ship một Python**. Câu "không Python" là sai.
> - **OQ-6 đóng hẳn** (S2 trả lời bằng cấu trúc `__shell` cụ thể). Thêm **OQ-12** (ngân sách tải về ~300 MB + 1,6 GB weights) và **OQ-13** (shim hay sidecar Node).
> - **Chế độ hỏng mới, chưa từng có trong bản 2: TREO, không lỗi.** esbuild trong SEA treo vĩnh viễn nếu thiếu hai biến môi trường → R6.11 (timeout) + R6.10 viết lại.
> - R4.5 chốt cụ thể theo S2: sentinel `__shell`, `<tên>.html`, map cả payload RSC; thêm R4.13 (tách server shell / client child) và R4.14 (main CJS, không top-level await).
> - R5.1/R5.14 thêm: binary native esbuild + CPython đóng băng + danh sách package Python **đã prune và pin**. R6.5 thêm `HF_HUB_OFFLINE`. R6.8 siết theo cây tiến trình của shim. R9.7 thêm: telemetry của HyperFrames CLI.
> - Ước lượng lại: **R5 13→21, R6 13→21**; tổng **~150 → ~165 SP**, **7–8 tuần**.
>
> **Đổi ở bản 2** (sau vòng review):
> - **OQ-5 và OQ-6 đã đóng** bằng quyết định sản phẩm: giữ Next nhưng chuyển sang `output: 'export'`, frontend gọi backend qua **http-driver** với base URL tuyệt đối. §1.5 và R4 viết lại theo đó.
> - Thêm **S3** (TTS trên máy không có Python) và mở rộng **S1** thành hai câu hỏi (spawn CLI **và** gọi `@hyperframes/*` in-process từ SEA).
> - Thêm **OQ-10** (boot khi chưa có workspace) và **OQ-11** (Chromium trong job smoke).
> - Thêm AC cho 4 lỗ correctness: handshake của bridge (R2.13), daemon mất lease (R2.14), race auto-start (R2.15), thứ tự cold start + migration một lần (R5.13).
> - Thêm luật còn thiếu cho picker (R1.14–R1.16), đổi workspace lúc runtime (R1.18), doctor re-extract (R3.13), import (R7.10–R7.12).
> - Sửa **ba chỗ bản 1 nói sai sự thật** — xem **§1.5**. Một trong ba chỗ đó review cũng nói sai theo chiều ngược lại; §1.5 ghi cả hai.

## Spec Goal

Người dùng tải **một file**, chạy nó trên máy **chưa cài gì**, và đi hết vòng lặp sản phẩm mà Giai đoạn 3 đã dựng: chọn thư mục workspace trong UI → có project → agent dựng scene qua MCP **trong khi UI đang mở** → nghe narration → render MP4 → mở file xem đúng.

Giai đoạn 1–3 đã hoàn thành nghiệp vụ. Giai đoạn 4 chỉ làm một việc, nhưng làm cho **hết**: chuyển toàn bộ nghiệp vụ đó ra khỏi giả định *"có một checkout, có `node_modules`, có Node trên PATH"*.

---

## Introduction

Ba giai đoạn trước đều xanh khi chạy từ source. Không cái nào sinh ra thứ mang đi được:

| Giai đoạn | Sinh ra gì | Chạy được ở đâu |
|---|---|---|
| 1 — Core backend | write authority, job, event, auth, lease | checkout |
| 2 — MCP | 10 tool, dual-era, approval, credential, audit | checkout (`tsx` loader + `node:sqlite`) |
| 3 — Delivery loop | workspace/marker, project CRUD, render MP4, snapshot, diagnostics, 18 tool, agent-kit | checkout (`vidcom app` spawn `next start`) |

Giai đoạn 4 nhận một hệ thống **đã đúng nghiệp vụ** và phải làm nó **đúng cả khi không còn checkout**. Đây không phải refactor: bốn giả định dưới đây nằm rải trong code và mỗi cái phải được thay bằng một cơ chế thật.

| Giả định | Ở đâu | Artifact có không |
|---|---|---|
| Có `node_modules/next` ở `cwd` | [`main.ts:116`](../../../../packages/cli/src/main.ts#L116) | Không |
| `process.execPath` là `node` và chạy được script `.mjs` bất kỳ | [`binary-probe.ts:98`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L98) | Không — nó là chính binary vidcom |
| `require.resolve("hyperframes/...")` giải được | `binary-probe.ts` | Không |
| Thư viện motion resolve từ `node_modules` | [`composition-root.ts:314`](../../../../packages/cli/src/composition-root.ts#L314) | Không — và [checkout này cũng đang thiếu chúng](#12-bằng-chứng-thư-viện-motion-không-đáng-tin-cả-trong-checkout) |

Và hai thứ **chưa từng tồn tại**: đường để UI chọn thư mục (D3), và đường để MCP nói chuyện với daemon thay vì loại trừ nó (PK-4).

---

## 1. Bối cảnh

### 1.1 Mô hình runtime sau Giai đoạn 4 — nguồn của R2, R3, R4, R5

```
    một file:  vidcom[.exe]                      (Node SEA, không sourcemap, không source .ts/.js rời)
        │
        ├── SEA assets (trong binary, người dùng không thấy)
        │     frontend Next `output: 'export'` (HTML/CSS/JS) → serve TỪ MEMORY, không có thư mục `out`
        │     native-runtime-<os>-<arch>.<ext>    → FFmpeg/FFprobe, binary native esbuild
        │     python-runtime archive             → CPython đóng băng + stack vieneu đã prune/pin,
        │                                           cộng worker.py của sidecar VieNeu      ◄── R5.14
        │     motion-libraries archive           → 5 thư viện đã pin version
        │     hyperframes toolchain archive      → CLI + dependency của nó
        │     manifest + sha256 cho từng archive
        │
        └── mode (PK-5)
              vidcom            = vidcom app      daemon + mở browser + token một lần
              vidcom serve      daemon headless
              vidcom mcp        BRIDGE stdio ⇄ daemon, KHÔNG tự ghi           ◄── R2
              (vidcom worker    ĐÃ LOẠI khỏi Giai đoạn 4 — OQ-9: đường điều phối job thứ hai)
              vidcom render     render headless cho CI/batch
              vidcom doctor     kiểm + bổ sung runtime                        ◄── R3
              vidcom version
              + approve / credential / backup / recovery (đã có từ Phase 2)

    app-data (thư mục ẩn của OS, 0700)            ◄── giải nén lần chạy đầu, R5
      vidcom.sqlite  credentials  logs/  cache/  render-roots/
      native/bin/{ffmpeg,ffprobe,esbuild}   ◄── esbuild là ĐƯỜNG DẪN mà R6.11 phải trỏ tới
      native/python/…  → interpreter đóng băng; native/vieneu/worker.py
      native/motion/<packageName>/…    native/hyperframes/…
      models/  ◄── weights VieNeu ~1,6 GB, TẢI chứ không giải nén (OQ-12)
      .ready-<sha256> marker cho từng archive đã giải nén xong

    workspace (thư mục NGƯỜI DÙNG chọn trong UI)  ◄── R1
      project-a/vidcom.json …   project-b/…   AGENTS.md  .agents/skills/
```

Ba tính chất bắt buộc:

| # | Tính chất | Requirement |
|---|---|---|
| P-A | **Người dùng chỉ thấy một file.** Mọi binary phụ nằm trong app-data, không nằm cạnh file tải về | R5, R9 |
| P-B | **Đúng một writer cho một workspace**, nhưng UI và AI host **cùng làm việc được** | R2 |
| P-C | **Artifact không được phụ thuộc bất cứ thứ gì người dùng phải cài trước** ngoài OS: không cần Node, **không cần Python cài sẵn**, không npm. Cách đạt là **ship một Python đóng băng** (S3 PASS: CPython `python-build-standalone` 3.12.13 + `vieneu==3.2.4`, torch-free, chạy được với `env -i` và không có `python3` trên PATH), không phải bỏ Python. Bản 1–2 viết "không Python" là **sai** | R4, R5, R6 |

P-B là chỗ mô hình đổi bản chất. Hôm nay single-writer được cưỡng chế bằng **loại trừ**: `vidcom mcp` tự lấy lease, và nếu app đang giữ thì nó throw `workspace is held by <holder>` ([`startup.ts:207`](../../../../packages/cli/src/startup.ts#L207)). Đúng về dữ liệu, sai về sản phẩm — giá trị cốt lõi của VidCom là *agent dựng video hộ người dùng trong khi người dùng đang xem preview*. Mô hình đó chưa chạy được một lần nào.

### 1.2 Bằng chứng: thư viện motion không đáng tin cả trong checkout

Build-order 4.8 cảnh báo `install_motion_library` đọc `node_modules`. Kiểm tra checkout này ngày 2026-08-06 cho thấy vấn đề còn sớm hơn thế:

```
packages/adapter/package.json  khai gsap ^3.15.0, animejs ^4.5.0, motion ^12.43.0,
                               lottie-web ^5.13.0, three ^0.185.1
bun.lock                       có cả 5 (gsap@3.15.0 …)
node_modules trên máy này      KHÔNG có cái nào  (cả root lẫn packages/adapter)
```

Nghĩa là đường vendor thư viện motion đang phụ thuộc vào **trạng thái install của máy đang chạy**, không phải vào thứ gì được ship. Trên artifact nó chắc chắn fail; trong checkout nó fail **tuỳ máy**. Đây là lý do R5 phải ship thư viện motion như một archive có checksum, và phải nối `motionLibraryRoot` — trường đã tồn tại nhưng **không entrypoint nào truyền vào** ([`next-host.ts:91`](../../../../packages/cli/src/next-host.ts#L91), [`mcp.ts:93`](../../../../packages/cli/src/commands/mcp.ts#L93) chỉ truyền `nativeDependenciesRoot`).

### 1.3 Cái gì đã có — để không làm lại

| Đã có | Ở đâu | Giai đoạn 4 dùng thế nào |
|---|---|---|
| Node SEA nhúng archive native, cold/warm PASS, codesign hợp lệ | [spike Phase 0](../../../../spikes/phase-0/README.md) §0.1 | R4/R5 **productionize** spike này, không thí nghiệm lại |
| Hono app độc lập, không import `next` | [`app.ts`](../../../../packages/server/src/app.ts), `listener.ts` | R4 chỉ **đổi host**; MUST NOT viết lại route |
| Nonce một lần → session cookie `HttpOnly` | [`auth/nonce.ts`](../../../../packages/server/src/auth/nonce.ts), `routes/auth.ts` | R1 dùng nguyên cơ chế; chỉ thêm `/v1/system/*` vào perimeter |
| Perimeter: loopback-only, `Host` check, CSRF origin | [`middleware/perimeter.ts`](../../../../packages/server/src/middleware/perimeter.ts) | R1 dựa vào, MUST NOT nới |
| Bearer credential cho MCP HTTP + `BridgeCredentialStore` 0600 | [`fs/credential-store.ts`](../../../../packages/adapter/src/fs/credential-store.ts), `McpCredentialService` | R2 dùng làm xác thực của bridge |
| `WorkspaceLease`: TTL 30s, `renew` mỗi 10s, **takeover khi `expires_at < now`** + audit `lease.stolen` | [`db/lease.ts:36-56`](../../../../packages/adapter/src/db/lease.ts#L36) | R2 giữ nguyên semantics, đổi **ai** giữ lease. R2.12 **đã có cơ chế**, việc còn lại là test — §1.5 |
| Streamable HTTP MCP endpoint + stdio server | [`routes/mcp.ts`](../../../../packages/server/src/routes/mcp.ts), `commands/mcp.ts` | R2: bridge nối stdio của host vào daemon |
| Agent-kit bundle text nhúng trong JS | [`agent-kit/scripts/build.mjs`](../../../../packages/agent-kit/scripts/build.mjs) | Tiền lệ cho R4 (nhưng frontend là binary + lớn → SEA asset, không phải TS literal) |
| `nativeDependenciesRoot`, `defaultVieNeuCommand(extractionRoot)` | `next-host.ts`, `tts/vieneu-sidecar-path.ts` | R5 **đổ nội dung** vào đường dẫn đã có |
| `hyperframesCliPath` / `hyperframesPackagePath` là **optional constructor param**; `require.resolve` chỉ là fallback | [`binary-probe.ts:39-57`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L39) | R6.3 là **nối dây ở entrypoint** (giống `motionLibraryRoot`), nhẹ hơn bản 1 mô tả — §1.5 |
| Nonce → session cookie đã chạy **ở cả FE**: đổi `?t=`, xoá khỏi history | [`src/lib/api/browser-session.ts`](../../../../src/lib/api/browser-session.ts) | R1.10 phần FE **đã đạt**; còn lại là base URL tuyệt đối cho http-driver |
| Mọi page FE **đã là `"use client"`** và gọi `/api/v1/*` bằng `fetch` tương đối | `src/app/page.tsx`, `src/app/projects/[slug]/page.tsx` | R4: không có RSC data fetching nào phải tháo → `output: 'export'` khả thi (§1.5) |
| Node SEA giải nén archive native rồi `createRequire` từ app-data: onnxruntime + sharp **PASS** cold và warm | [spike Phase 0](../../../../spikes/phase-0/README.md) §0.1b | R5 dùng cho **binary native** (FFmpeg, esbuild). **Không** cần cho `@hyperframes/*`: S1b chứng minh import tĩnh bundle thẳng vào SEA chạy được (§1.7) |
| `@hyperframes/{core,sdk,studio-server,parsers}` + `linkedom` **bundle được vào SEA**, 9/9 bước PASS không cần `node_modules` | [spike Phase 4 §S1b](../../../../spikes/phase-4/README.md) | R6.10 giữ nguyên 8 điểm `import` tĩnh; việc thật là hai biến môi trường của esbuild |
| Adopt candidate trong workspace | `POST /v1/projects/:slug/adopt` | R7 là chuyện **khác**: nguồn nằm **ngoài** workspace |
| 113 test file, harness SQLite + fs thật | `tests/` | R8 thêm một tầng: chạy trên **artifact** |

### 1.4 Cái gì phải đổi — khoảng cách với mô hình

| Mô hình | Code hôm nay | Ở đâu |
|---|---|---|
| UI chọn thư mục workspace | Không có `/v1/system/*`, FE không có màn chọn thư mục; workspace chỉ từ `cwd`/`--workspace` | `routes/*.ts`, `src/components/**` |
| `vidcom app` serve UI từ binary | Spawn `next start` từ `cwd/node_modules` | [`main.ts:116`](../../../../packages/cli/src/main.ts#L116) |
| `vidcom mcp` là bridge | Tự dựng foundation, tự lấy lease, tự chạy watcher/scheduler | [`commands/mcp.ts`](../../../../packages/cli/src/commands/mcp.ts), `startup.ts` |
| 11 mode | 6 mode: `app`, `mcp`, `approve`, `credential`, `backup`, `recovery` | [`main.ts:30`](../../../../packages/cli/src/main.ts#L30) |
| Render tự chứa | `[process.execPath, require.resolve("hyperframes/…")]` | [`binary-probe.ts:98`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L98) |
| Thư viện motion được ship | Resolve từ `node_modules`; `motionLibraryRoot` không ai truyền | [`composition-root.ts:314`](../../../../packages/cli/src/composition-root.ts#L314) |
| Import project từ ngoài | Không có đường nào; chỉ `adopt` folder đã nằm trong workspace | `ProjectLifecycle` |
| Test trên artifact | 113 test đều chạy trên source; e2e chỉ pack CLI với `node_modules` của checkout | `tests/e2e/**` |
| Có trạng thái **"chưa có workspace"** | `resolveWorkspace` **luôn resolve**: cwd đọc được nhưng không có marker → `source: "cwd"`. Một thư mục tạm rỗng thành workspace **im lặng** | [`workspace-resolver.ts:39-64`](../../../../packages/core/src/domain/workspace-resolver.ts#L39) |
| Listener mở được **trước** khi có workspace | `startVidcomFoundation` bắt buộc `config.workspaceRoot` và lấy lease **trong** startup sequence, trước khi listener mở | [`startup.ts:148`](../../../../packages/cli/src/startup.ts#L148), [`:204-207`](../../../../packages/cli/src/startup.ts#L204) |
| Daemon mất lease thì **ngừng ghi** | `onLeaseLost` chỉ `sessions.revokeAll()` + `stopBackground()`; listener vẫn mở, tiến trình vẫn sống, write path không bị chặn | [`next-host.ts:117`](../../../../packages/cli/src/next-host.ts#L117), [`startup.ts:210-222`](../../../../packages/cli/src/startup.ts#L210) |
| Migration chạy **một lần, sau lease** | `selectWorkspace` migrate **hai lần** (`activeWorkspace` rồi set active), foundation migrate lần **thứ ba** — cả ba **trước** khi có lease | [`workspace-selection.ts:23-30`](../../../../packages/cli/src/workspace-selection.ts#L23), [`:57-60`](../../../../packages/cli/src/workspace-selection.ts#L57) |
| `@hyperframes/*` chỉ dùng qua CLI | **8 file adapter `import` tĩnh** `@hyperframes/{core,sdk,studio-server,parsers}`; `next.config.ts` giữ chúng + `esbuild` + `linkedom` làm external | `packages/adapter/src/hyperframes/**`, `next.config.ts` |
| FE gọi API qua base URL cấu hình được | `fetch("/api/v1/…")` tương đối, phụ thuộc catch-all route handler của Next | `src/app/**`, `src/components/**` |

---

### 1.5 Ba chỗ bản 1 nói sai, và một chỗ review nói sai theo chiều ngược lại

Ghi lại tường minh, vì Design sẽ đọc bản này như sự thật và estimate theo nó.

**(a) Lease "steal" — bản 1 đúng, review sai.** Review khẳng định "không có steal, `grep -rn steal packages/` = 0". `grep "steal"` thật sự trả 0, nhưng vì token trong code là **`stolen`**, không phải `steal`: `acquire` dùng `ON CONFLICT … DO UPDATE … WHERE workspace_lease.expires_at < now` — tức takeover theo hết hạn — và ghi audit `action: "lease.stolen"` kèm `previousHolderId` ([`lease.ts:36-56`](../../../../packages/adapter/src/db/lease.ts#L36)). Vòng `renew` 10s cũng đã có ở [`startup.ts:210-222`](../../../../packages/cli/src/startup.ts#L210).
→ **R2.12 gần như đã xong**; việc còn lại là **test** cho đường hết-hạn-rồi-bị-lấy và giữ audit đó. Đây là chỗ *rẻ hơn* cả bản 1 và review nghĩ.

**(b) `setting.json` — bản 1 sai.** §3 bản 1 viết "MUST NOT tự ghi API key rỗng vào `setting.json`". Hôm nay `ensureVidcomSettingsFile` **cố ý** ghi template `elevenlabs: { apiKey: null }` khi file chưa tồn tại, và comment giải thích lý do (discoverability: người dùng được bảo "điền key vào file" phải thấy đúng shape) — [`settings-file.ts:112-131`](../../../../packages/adapter/src/fs/settings-file.ts#L112). Nó **không ghi gì** khi file đã tồn tại, kể cả khi file bị hỏng.
→ Luật đúng là **bảo tồn**, không phải cấm: giữ hành vi tạo template `null`, MUST NOT ghi đè file có sẵn, MUST NOT ghi **giá trị secret thật**. §3 đã sửa theo.

**(c) `require.resolve` — bản 1 nói quá.** `hyperframesCliPath` / `hyperframesPackagePath` là optional constructor param và `require.resolve` chỉ là **fallback** khi không ai truyền ([`binary-probe.ts:39-57`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L39)). Việc thật của R6.3 là **nối dây ở entrypoint**, giống `motionLibraryRoot`.
→ Nhưng có một chỗ **nặng hơn** cả bản 1 và review đều bỏ: `binary-probe` còn spawn `process.execPath` lần thứ hai để hỏi đường dẫn Chromium (`[cliPath, "browser", "path"]`, [`:66-70`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L66)). Trong SEA đó là chính artifact. R6.4 phải phủ **cả hai** chỗ spawn, không chỉ đường render.

**(d) Boot khi chưa có workspace — review sai mechanism, nhưng lỗ thì thật và sắc hơn.** Review nói "cwd là thư mục tạm rỗng ⇒ `CliInputError` ⇒ tiến trình chết trước khi listener mở". Đọc `resolveWorkspace` thì ngược lại: cwd **đọc được** mà không có marker vẫn trả `resolved(cwd.root, "cwd")` ([`workspace-resolver.ts:39-64`](../../../../packages/core/src/domain/workspace-resolver.ts#L39)); chỉ khi cwd **không đọc được** mới ra `status: "error"`.
→ Hệ quả thật: app **không crash**, nó **im lặng nhận thư mục tạm làm workspace**, lấy lease trên đó, và ghi `active_workspace` vào app-data. Nghĩa là điều kiện tiền đề của R1.11 ("IF chưa có workspace active") **không bao giờ đúng** trong thiết kế hôm nay — không có khái niệm "chưa có workspace" để mà kiểm. OQ-10 đóng chuyện này, và S6 đo được là nó **rẻ** — một biến `currentApp` đổi được, không phải rewrite lifecycle (§1.9c). Phần đắt nằm ở chỗ khác: tách `startVidcomFoundation`, thứ R1.12 cần dù thế nào.

**(e) TTS trên máy sạch — review đúng phần kết luận, sai phần bằng chứng.** `worker.py` **không** `import torch`: đường CPU của upstream v3 Turbo chạy ONNX Runtime và cố ý torch-free, torch chỉ đến từ extra `legacy` cho GPU ([`worker.py:33-37`](../../../../packages/adapter/sidecars/vieneu/worker.py#L33), [`requirements.txt`](../../../../packages/adapter/sidecars/vieneu/requirements.txt)). Cái thật sự cần là: **một Python interpreter** + `vieneu==3.2.4` + `huggingface-hub` + weights tải từ HF vào app-data (`HF_HOME` bắt buộc tuyệt đối).
→ Kết luận của review vẫn đứng: `defaultVieNeuCommand` trả `["python3"|"python", worker.py]` ([`vieneu-sidecar-path.ts:36-43`](../../../../packages/adapter/src/tts/vieneu-sidecar-path.ts#L36)), nên P-C **viết như bản 1–2** ("không Python") + R6.1 + R8.3 + R6.7 **không cùng đúng được**. Vì stack CPU là torch-free, phương án đóng băng interpreter khả thi hơn bản 1 giả định — nhưng khả thi tới mức nào là câu hỏi PASS/FAIL. → **S3 đã chạy và PASS** (§1.7d): cách thoát không phải bỏ Python mà là **ship một Python đóng băng**, và P-C được viết lại theo đó (§1.1).

### 1.6 OQ-5 / OQ-6 đã đóng: Next `output: 'export'` + http-driver

Quyết định (2026-08-06): **giữ Next trong repo**, chuyển sang `output: 'export'` để build ra static file nhúng vào SEA, và frontend gọi backend qua **http-driver** (`@alvin0/http-driver`) với base URL cấu hình được thay cho `fetch` đường tương đối.

Điều này khả thi vì một sự thật đã kiểm: **mọi page đã là `"use client"` và đã tự fetch** (`src/app/page.tsx`, `src/app/projects/[slug]/page.tsx`) — không có RSC data fetching, không có server action nào phải tháo. Đây là lý do quyết định này rẻ, và nó đóng cả OQ-5 (Next đi hay ở) lẫn phần "SPA fallback hay không" của OQ-6.

Nhưng nó **sinh ra ba việc mới**, và cả ba đều là requirement, không phải chi tiết Design:

| # | Việc | Vì sao |
|---|---|---|
| 1 | **Catch-all route handler phải rời khỏi đường build.** `src/app/api/[[...route]]/route.ts` khai `dynamic = "force-dynamic"` và export POST/PUT/PATCH/DELETE/OPTIONS. `output: 'export'` không xuất được route handler như thế | Không xử lý thì `next build` **fail**, không phải degrade → R4.11 |
| 2 | **Dev trở thành cross-origin.** FE ở `localhost:3000`, daemon ở port động. `strictCors` hôm nay chỉ cho `http://127.0.0.1:<port>` + `http://localhost:<port>` ([`next-host.ts:118`](../../../../packages/cli/src/next-host.ts#L118)); origin dev không nằm trong danh sách | Origin dev MUST NOT có mặt trong artifact → R4.12. Cookie session `sameSite: "Strict"` ([`auth.ts:42-44`](../../../../packages/server/src/routes/auth.ts#L42)) **vẫn đi được vì port không thuộc định nghĩa "site"** — nhưng chỉ khi hai đầu **cùng hostname**: `localhost` và `127.0.0.1` là **hai site khác nhau** (một registrable domain, một IP literal), nên dev pin `localhost` ở cả FE lẫn daemon, và fetch phải `credentials: "include"` |
| 3 | **`/projects/[slug]` phải chốt một cấu trúc.** `output: 'export'` chỉ sinh HTML cho params mà `generateStaticParams` liệt kê được; slug là do người dùng tạo nên không liệt kê được | **S2 đã chốt** (§1.7): một HTML shell dùng chung, emit bằng `generateStaticParams` trả đúng một sentinel `__shell`, host SEA phục vụ nó cho mọi `/projects/*`, slug đọc từ `location`. Đây là phần còn lại của OQ-6 → **OQ-6 đóng hẳn**, chi tiết ở R4.5/R4.13 |

### 1.7 Kết quả spike Phase 4 — gate đã mở

Chạy 2026-08-06 trên `darwin arm64`, Node `v24.9.0`. Bằng chứng và cách dựng lại: [`spikes/phase-4/README.md`](../../../../spikes/phase-4/README.md).

| Spike | Kết quả | Thứ nó chốt |
|---|---|---|
| **S1a** — spawn CLI | **PASS qua shim** | R6.2, R6.4, R6.8, **OQ-13** |
| **S1b** — gọi in-process | **PASS có điều kiện** | R6.10, **R6.11**, R5.1 |
| **S2** — frontend export | **PASS sau hai thay đổi FE** | R4.5, **R4.13**, **R4.14**, R4.11 |
| **S3** — TTS không Python | **PASS, giá đắt** | P-C, R6.1, R6.7, R5.1, **R5.14**, **OQ-12** |

Không cái nào FAIL cứng, nên cấu trúc đóng gói của bản 2 đứng vững. Bốn thứ đo được đổi requirement:

**(a) Hình dạng spawn hôm nay không lỗi — nó chạy lại chính app.** `[process.execPath, cliPath, …]` trong SEA cho binary nhận `argv[1]` là **chính nó**, nên CLI không bao giờ chạy và tiến trình vào lại main của artifact. Ba hình dạng đo được:

| Hình dạng | Kết quả |
|---|---|
| `[execPath, cliPath, …]` — code hôm nay | **artifact vào lại `main` của chính nó** với đường dẫn CLI làm tham số thường; CLI không bao giờ chạy, và không có lỗi nào nói vì sao. (Spike thoát bằng exit 97 vì probe của nó tự cài một guard — sản phẩm thật **không** có guard đó, nên hành vi là daemon khởi động thêm một lần nữa) |
| shim: `[execPath, "--vidcom-node", cliPath, …]` rồi `import()` | OK — `--version` 249 ms, `compositions` 1.223 ms, `browser path` 1.249 ms, **render ra MP4 h264 1920×1080 `duration=14.000000` trong 65,8 s** |
| sidecar: `[nodeĐãGiảiNén, cliPath, …]` | OK — 206 ms |

Cả hai đường sống đều PASS. **OQ-13 chốt shim** sau khi S4 bác bỏ lý lẽ chống lại nó (§1.9a).

**(b) Chế độ hỏng mới, chưa từng có trong bản 1–2: TREO, không lỗi.** `@hyperframes/core` gọi esbuild ở `dist/compiler/htmlBundler.js:650` và `dist/inline-scripts/hyperframesRuntime.engine.js:22`. API sync của esbuild chạy qua worker thread khởi động bằng `__filename` — trong SEA không phải file thật, nên `Atomics.wait` chờ vĩnh viễn:

| `ESBUILD_BINARY_PATH` | `ESBUILD_WORKER_THREADS` | Kết quả |
|---|---|---|
| chưa đặt | mặc định | **TREO**, không một dòng stderr |
| đã đặt | mặc định | **TREO** |
| chưa đặt | `0` | lỗi sạch, exit 1 (*"cannot be bundled"*) |
| **đã đặt** | **`0`** | **PASS** |

`doctor` kiểm sự tồn tại của file **không phát hiện được** trạng thái này → R6.11 bắt buộc có timeout.

**(c) `output: 'export'` chạm FE nhiều hơn §1.6 nghĩ.** Ngoài catch-all route handler (R4.11, đã xác nhận bằng build thật), còn hai thứ:
- `generateStaticParams` **không sống được trong file `"use client"`** — Next từ chối. Page dynamic phải tách server shell / client child → R4.13.
- Payload RSC của shell **hard-code sentinel**: `"c":["","projects","__shell"]`. Nên `params` luôn trả `__shell` bất kể URL. [`src/app/projects/[slug]/page.tsx:31`](../../../../src/app/projects/[slug]/page.tsx#L31) đang đọc slug bằng `React.use(params)` → phải đổi sang `location`.

Layout xuất ra (mặc định `trailingSlash: false`): `out/projects/__shell.html`, tức `<tên>.html`. Next 16 còn phát sinh **file payload RSC `.txt`** cạnh HTML mà router client fetch khi điều hướng — host SEA phải map cả chúng.

**(d) TTS được, nhưng đổi câu chuyện phát hành.** CPython `python-build-standalone` 3.12.13 + `vieneu==3.2.4` (torch-free) ra WAV `4,88 s` hợp lệ với `env -i` và không `python3` trên PATH.

| Thứ | Kích thước |
|---|---|
| Stack đầy đủ (tar.gz / giải nén) | 245 MB / 805 MB |
| **Stack đã prune** (tar.gz / giải nén) | **150 MB / 508 MB** |
| Weights HF lần đầu | **1,6 GB** |
| Cold / warm | 23,5 s / 7,1 s |

Prune được 297 MB mà WAV vẫn ra: `gradio` + `gradio_client` + `hf_gradio` + `fastapi` + `uvicorn` + `starlette` + `safehttpx` (một web UI demo) và `llvmlite` 125 MB + `numba` 29 MB + `sklearn` 47 MB + `PIL` 14 MB. Còn lại là thật: `scipy` 98 MB, `onnxruntime` 74 MB, `numpy` 33 MB. → R5.14 và **OQ-12**.

### 1.9 Vòng spike thứ hai — đóng OQ bằng số thật

Vòng 1 mở gate kỹ thuật. Vòng 2 (cùng ngày) nhắm vào các OQ đang chặn Design. **Ba trong bốn spike bác bỏ một giả định của bản 3.** Bằng chứng: [`spikes/phase-4/README.md` §Vòng 2](../../../../spikes/phase-4/README.md).

**(a) S4 — lý do bản 3 chọn sidecar là SAI.** Bản 3 viết: *"với shim, cha và con cùng một `execPath`, nên mọi luật kill của R6.8 phải né đường dẫn và dễ sai lặng lẽ."* Đọc [`process-supervisor.ts`](../../../../packages/adapter/src/runtime/process-supervisor.ts) thì luật kill **không dùng `execPath`**: `spawn(detached)` → `ps -Ao pid=,ppid=,pgid=,lstart=` → hậu duệ của `rootPid` → giết theo **process group** → xác minh bằng `(pid, startedAt)`. Chạy đúng giao thức đó, huỷ render ở giây 25:

| Hình dạng | Tiến trình bắt được | Group | Sống sót |
|---|---|---|---|
| shim | 26 | 4 | **0** |
| sidecar | 25 | 4 | **0** |

Kết quả "mồ côi" của vòng 1 là lỗi của spike (dùng `spawn` trần, không `detached`). Và giá của sidecar cũng bị bản 3 ghi sai: Node là 112 MB **thô** nhưng **35,9 MB nén** — không phải "~110 MB". → **OQ-13 chọn shim**, R6.8 sửa lại.

**(b) S5 — Chromium rẻ hơn và cache sai chỗ.** `hyperframes browser ensure` tải **Chrome Headless Shell** (không phải Chromium đầy đủ): **94,5 MB, ~8 s**, thành **196 MB** trên đĩa; warm `ensure` **1,08 s**. Ba hệ quả: bundle là lựa chọn tồi (→ OQ-3 xác nhận *tải*); cache nằm ở **`$HOME/.cache/hyperframes/chrome/…`** chứ không phải app-data, nên `HOME` sạch của R8.2 nghĩa là **tải lại mỗi lần** (→ R8.8 có đường dẫn cụ thể để cache); và trên máy có Chrome hệ thống, `browser path` trả `/Applications/Google Chrome.app` — máy phát triển **che mất** vấn đề, đúng loại PASS giả §6 cảnh báo.

Thêm một ràng buộc: **không có đường override nguồn tải** (`PUPPETEER_DOWNLOAD_BASE_URL` và `CHROME_DOWNLOAD_BASE_URL` đều bị lờ). Air-gapped không làm được qua đường này; nếu cần thì VidCom phải **tự seed cache** — layout là tất định nên làm được.

**(c) S6 — OQ-10 rẻ hơn bản 3 tính.** Chạy với `createServerApp` thật, một biến `currentApp` đổi được:

| | Phase 1 (chưa có workspace) | Phase 2 (sau khi thay app) |
|---|---|---|
| `/api/v1/jobs/job-1` **có session** | **404** — route chưa tồn tại | **200** + body |
| Cổng | 53100 | 53100, **listener chưa từng đóng** |

Session cấp ở phase 1 dùng nguyên ở phase 2. Toàn bộ cơ chế là **một biến đổi được + gọi `createServerApp` lần hai** — hàm đó chỉ đăng ký route, không I/O. Phần đắt của R1 **không** nằm ở đây mà ở `startVidcomFoundation` (vẫn nướng `workspaceRoot` vào `createInfrastructure`) — nhưng đó là việc R1.12 cần dù có OQ-10 hay không, nên **làm một lần dùng cho cả hai**.

**(d) S7 — chiếm port là thật, và socket cũng chạy được.** Daemon nhả port, tiến trình lạ bind đúng port đó, bridge cầm record cũ:

```
strangerTookSamePort           true
naiveBridgeSees                { who: "some-other-app" }
naiveBridgeWouldSendMutation   CÓ — gửi vào tiến trình lạ
handshakeBridgeRefuses         true
```

R2.13 vì thế là **correctness**, không phải hardening. Và đường socket không đắt như bản 3 nghĩ: `http.createServer(getRequestListener(app.fetch)).listen(socketPath)` chạy với **cùng Hono app**, mode `600` sau `chmod`, `GET /api/mcp/ping` → 200. Tức "code mới cho hai họ OS" thu lại còn **~5 dòng trên POSIX**; Windows named pipe dùng cùng API `listen(path)` nhưng **chưa kiểm**.

### 1.8 Hai bug Phase 3 — **ĐÃ SỬA** trước khi vào Giai đoạn 4 (2026-08-07)

Spike làm lộ hai defect có từ Phase 3. Chúng nằm ngoài phạm vi giai đoạn này về nguồn gốc, nhưng **R3.5 và R8.3 dựa vào cả hai**, nên sửa trước rẻ hơn để lại.

1. **Voice id trả về là repr của tuple Python.** `probe()` làm `[str(name) for name in engine.list_preset_voices()]` nhưng upstream trả **cặp `(label, name)`** — label mang giới/vùng/phong cách, và chỉ phần tử thứ hai là tên engine chấp nhận. Catalogue của VidCom vì thế chứa `"('Minh Đức — Nam · Bắc · Phong cách tin tức', 'Minh Đức')"`; đưa chuỗi đó ngược lại `infer(voice=…)` thì engine trả `Voice … not found` — tức **mọi voice chọn từ catalogue đều fail**.
   → Sửa bằng `speaker_name()` ([`worker.py`](../../../../packages/adapter/sidecars/vieneu/worker.py)), viết chịu được cả trường hợp upstream đổi sang trả chuỗi trần.
2. **`engineVersion` luôn rỗng.** `getattr(vieneu, "__version__", "")` — upstream 3.2.4 **không định nghĩa thuộc tính đó** (đã kiểm trên bản cài thật), nên nó luôn trả `""` và R3.5 không có version nào để báo.
   → Sửa bằng `engine_version()` đọc từ package metadata; trả `'3.2.4'` trên bản cài thật.

**Đã verify với engine thật**, không phải bằng suy luận:

| Kiểm | Kết quả |
|---|---|
| `engine_version()` | `'3.2.4'` (trước: `''`) |
| `probe()` — 14 voice | `['Minh Đức', 'Phạm Tuyên', 'Thái Sơn', …]`, **không còn tuple repr** |
| Synth bằng voice **lấy từ chính catalogue** | WAV 2,24 s — đúng đường trước đây fail |
| `tests/adapter/tts-vieneu.integration.test.ts` | **3 PASS** với engine thật |
| Cùng test trên code **trước khi sửa** | **2 FAIL** — `voice label must be the bare engine name` |

Test được siết thêm một assertion cho đúng defect này. Nó cần thiết vì assertion cũ (`voice.id` khớp `/^vieneu-v3-[a-z0-9-]+$/`) **vẫn xanh** trên tên đã hỏng: slug hoá một tuple repr vẫn ra chuỗi khớp pattern. Lý do sâu hơn khiến bug lọt: file integration này opt-in qua `VIDCOM_VIENEU_REAL=1` và **chưa từng chạy** — chính comment đầu file đã cảnh báo "a fake process cannot catch a wrong SDK call", rồi điều đó xảy ra lần thứ hai.

*Còn lại*: `engineVersion` được parse ở [`tts-vieneu.ts:274`](../../../../packages/adapter/src/tts/tts-vieneu.ts#L274) nhưng **chưa có consumer nào** — R3.5 là consumer đầu tiên. Nên chưa có đường public để test khẳng định nó; khi R3.5 làm `doctor` thì thêm assertion ở đó.

---

## 2. Phạm vi

### Trong phạm vi

R1 directory picker + token flow + UI · R2 single-writer daemon + MCP bridge · R3 CLI đủ mode + `doctor` · R4 Node SEA + nhúng frontend + bỏ Next khỏi artifact · R5 giải nén native runtime + thư viện motion + sidecar · R6 toolchain render/TTS chạy từ artifact · R7 import project có sẵn · R8 smoke test trên artifact · R9 hygiene & provenance.

### Ngoài phạm vi — nói tường minh để khỏi tranh luận lúc thực thi

| Không làm | Vì sao / đi đâu |
|---|---|
| Build matrix đủ 3 OS × 2 kiến trúc | PK-9 — Giai đoạn 6. Giai đoạn 4 build **và kiểm** trên nền tảng của runner (OQ-7) |
| Code signing thật + notarization Apple + installer `.dmg`/`.msi` | PK-10 — Giai đoạn 6. Giai đoạn 4 chỉ giữ ad-hoc signature + checksum (R9) |
| Auto-update, crash reporting, telemetry | PK-11 — Giai đoạn 6 |
| Tauri shell + native folder dialog | [doc 14 §9.2](../../../product-features/14-local-first-mcp-packaging-architecture.md), Mức 5 — nâng cấp UX, không phải điều kiện cần |
| License / activation | doc 14 §17 câu 9 — chưa có quyết định sản phẩm, và §2 đã chỉ ra nó không được nằm trong bundle |
| Nhiều workspace mở đồng thời | doc 14 §17 câu 3 — một workspace active tại một thời điểm, giữ nguyên Phase 3 |
| Agent chạy **trong** app (PTY, streaming, diff preview) | AI-1..AI-14 — Giai đoạn 6. Giai đoạn 4 chỉ làm cho agent **ngoài** app dùng được song song với UI |
| MCP prompt (`agent-kit/prompts/`) làm tính năng | AK-7 — file đã có trong bundle, nhưng đăng ký prompt qua MCP là Giai đoạn 6 |
| Duplicate / export zip / export git | PM-8 — Giai đoạn 5. R7 chỉ **import vào** |
| CRUD file/folder, upload asset ảnh/video, agent generation, file explorer | FA-1..3 — Giai đoạn 5. **Nút `New video` thì ngược lại: đã kéo vào** (OQ-8 → R1.19) ở mức *nối UI vào use case tạo project đã có*, vì artifact mà CTA chính bị disable thì không demo được vòng lặp. Ranh giới là **capability**, không phải URL: không thêm capability backend nào ngoài tạo project từ preset |
| Sửa `hyperframes` version skew (R6 của doc 14) | Cảnh báo thì có (R6.9); pin/resolve nhiều version là Giai đoạn 6 |
| Offline mode tường minh cho registry fetch | R5 của doc 14 — cache đã có; chuyển sang chế độ offline có công tắc là Giai đoạn 5 |

### Ranh giới dễ hiểu sai

- **R4 là đổi host, không phải viết lại backend.** Hono `app` không đổi một dòng (D4 đã đạt ở Phase 1). Cái đổi là ai gọi `app.fetch` và frontend đến từ đâu. Nếu Design thấy mình đang sửa route, Design đã đi sai. *Ngoại lệ, và chúng nằm ở FE chứ không ở Hono app*: đổi cách **gọi** API (relative `fetch` → http-driver với base URL, R4.10), một công tắc origin dev ở perimeter (R4.12), và — mới ở bản 3 sau S2 — **tách page dynamic thành server shell / client child** cùng đọc slug từ `location` (R4.13). Ba việc này thuộc R4. Luật vẫn đứng: **route của Hono app không đổi một dòng**; nếu Design thấy mình đang sửa `packages/server/src/routes/**` để chạy được trên SEA thì Design đã đi sai.
- **R2 không nới single-writer, nó chuyển chỗ cưỡng chế.** Vẫn đúng một tiến trình ghi; cái mới là tiến trình thứ hai **được phép nhờ** tiến trình thứ nhất ghi hộ. MUST NOT có đường ghi thứ hai vào đĩa người dùng ([steering/07 §4](../../../steering/07-data-and-storage.md#4-ghi-file--quy-tắc-cứng)).
- **R5 không phải cache.** App-data runtime là **thành phần của sản phẩm** được giải nén, không phải dữ liệu tối ưu hoá. Thiếu nó thì app không chạy, nên nó phải có checksum và phải tự phục hồi.
- **R1 là một filesystem browser expose qua HTTP.** Đây là bề mặt tấn công mới nguy hiểm nhất của cả dự án. Nó MUST NOT bao giờ được expose cho MCP ([doc 14 §11.3](../../../product-features/14-local-first-mcp-packaging-architecture.md)).
- **R6 là *cả hai*: cách gọi **và** thêm binary vào archive.** Bản 1–2 nói nó "không phải thêm binary" — sau spike thì không đúng nữa. Phần *cách gọi* vẫn là phần khó: `process.execPath` trong SEA không phải Node (R6.2), và esbuild cần hai biến môi trường nếu không muốn treo (R6.11). Nhưng phần *archive* đã lớn lên thật: một CPython đóng băng, một binary native esbuild, và một danh sách package Python phải pin (R5.1, R5.14). Nếu Design chỉ làm một trong hai vế, artifact hỏng theo kiểu **im lặng** chứ không báo lỗi.
- **R8 không phải "chạy lại test suite trên binary".** Nó là một tập nhỏ, chọn có chủ đích, chạy trong môi trường **cô lập PATH và HOME**. Chạy 113 test trên artifact không chứng minh thêm gì so với chạy 8 test đúng chỗ.

---

## 3. Data and Persistence Scope

- **Persisted data involved**:
  - *App-data (hidden, vận hành)* — **mới ở giai đoạn này**: `native/**` (FFmpeg/FFprobe, **binary native esbuild**, **CPython đóng băng + stack vieneu**, `worker.py` của sidecar VieNeu, thư viện motion, toolchain hyperframes), marker `.ready-<sha256>` cho từng archive, `runtime-manifest` ghi archive nào đã giải nén ở version nào **và danh sách package Python đã pin** (R5.14); credential của bridge; endpoint/port của daemon đang chạy để bridge tìm được.
  - *App-data (đã có)*: `vidcom.sqlite` (job, journal, audit, lease, credential, approval), `logs/`, `cache/`, `models/`, `render-roots/`.
  - *Workspace (public)*: **không thêm gì**. Giai đoạn 4 MUST NOT ghi thêm bất cứ loại file nào vào thư mục người dùng, ngoài project mà R7 import vào.
  - *`~/.vidcom/setting.json`*: giữ nguyên schema Phase 3; lần chạy đầu trên máy sạch phải chịu được **file không tồn tại**. Hành vi hiện có được **bảo tồn**: khi file chưa tồn tại, hệ thống tạo template có `elevenlabs: { apiKey: null }` để người dùng thấy đúng shape ([`settings-file.ts:112-131`](../../../../packages/adapter/src/fs/settings-file.ts#L112)); khi file đã tồn tại — **kể cả khi hỏng** — hệ thống MUST NOT ghi. MUST NOT ghi giá trị secret thật vào file. (Bản 1 viết ngược điều này — §1.5b.)
- **Data ownership**: app-data thuộc **artifact** (xoá được, dựng lại được); workspace thuộc **người dùng**; `~/.vidcom/setting.json` thuộc **máy/người dùng** ([steering/07 §0](../../../steering/07-data-and-storage.md#0-cấu-hình-người-dùng--vidcomsettingjson)). Ba vùng MUST NOT lẫn. Câu hỏi phân loại của [steering/07 §2](../../../steering/07-data-and-storage.md#2-quy-tắc-phân-loại--hỏi-một-câu) cho `native/**`: copy project sang máy khác **không** cần nó → app-data, đúng chỗ.
- **Lifecycle**:
  - `native/**` — tạo ở lần chạy đầu hoặc bởi `doctor`; xoá được bằng tay và hệ thống **dựng lại được**, MUST NOT crash; version binary mới → giải nén lại theo checksum mới, bản cũ được thu hồi.
  - Marker `.ready-<sha256>` — chỉ ghi **sau khi** toàn bộ archive đã ở đúng chỗ; đây là thứ phân biệt "giải nén xong" với "giải nén dở".
  - `models/` (weights VieNeu ~1,6 GB) — **tải, không giải nén**, nên vòng đời khác `native/**`: nó lớn hơn cả artifact, nó cần mạng ở lần đầu, và xoá nó **không** làm app hỏng mà chỉ làm TTS phải tải lại. Cache SHALL dùng lại được giữa các version artifact khi model revision không đổi, và `doctor` SHALL phân biệt "chưa tải" với "tải dở". Sau khi có cache đầy đủ, đường TTS SHALL chạy **offline** (`HF_HUB_OFFLINE`, R6.5).
  - Credential của bridge — phát hành khi daemon khởi động, thu hồi khi daemon dừng; `0600` (Windows: ACL tương đương).
  - Endpoint của daemon — ghi khi lấy được lease, xoá khi nhả lease; stale record MUST được phát hiện, MUST NOT làm bridge treo.
  - Project được import (R7) — sống tiếp như project bình thường; bản gốc ngoài workspace **không bị chạm**.
- **Consistency requirements**:
  - Giải nén phải **atomic theo archive**: giải vào thư mục tạm rồi rename, hoặc ghi marker cuối cùng. Đọc một `native/**` chưa có marker MUST bị coi là chưa có.
  - Hai tiến trình cùng lần chạy đầu (app và `vidcom mcp` khởi động cùng lúc) MUST NOT giải nén song song vào cùng đích.
  - **Thứ tự cold start là chính tắc**: giải nén runtime → migrate SQLite **một lần** → lấy lease → mở listener. Migration MUST NOT chạy nhiều lần trong một lần boot (hôm nay chạy tới **ba** lần — §1.4), và hai tiến trình cold-start đồng thời MUST NOT migrate song song. §3 bản 1 chỉ chặn race của giải nén và bỏ sót race của migration; cả hai đều phải chặn → R5.13.
  - Bridge MUST xác minh nó nối đúng daemon **trước tool call đầu tiên**: endpoint record là stale-detectable chưa đủ, vì port động có thể đã bị tiến trình khác chiếm. Handshake phải so `workspaceRoot` + instance id → R2.13.
  - Daemon **không còn giữ lease** MUST NOT tiếp tục nhận write: hôm nay listener vẫn mở sau `onLeaseLost` (§1.4) → R2.14.
  - Mọi ghi vào workspace từ bridge đi qua **cùng một** `WriteAuthority` của daemon, cùng lease, cùng revision, cùng audit. `actor` phải phân biệt được `user` và `agent`.
  - Import project (R7) là **một** composite mutation: copy nội dung + ghi/đổi `vidcom.json` + đăng ký. Nửa vời không được để lại project không nhận diện được.
- **Query and reporting needs**: `doctor` cần đọc trạng thái từng thành phần runtime (có/không, version, đường dẫn, cách sửa) và trả được **dạng máy đọc** cho CI; bridge cần tìm daemon của một workspace; UI cần list thư mục con của một đường dẫn tuyệt đối kèm cờ `isDir`/`canWrite`.
- **Volume and growth assumptions** — đo thật, không ước:

  | Nằm ở đâu | Thứ gì | Kích thước |
  |---|---|---|
  | **Trong artifact** (tải một lần) | binary SEA base ([spike Phase 0](../../../../spikes/phase-0/README.md)) | 110–130 MB |
  | | CPython đóng băng + stack vieneu **đã prune** ([§1.7d](#17-kết-quả-spike-phase-4--gate-đã-mở)) | **150 MB** (chưa prune: 245 MB) |
  | | FFmpeg/FFprobe + esbuild + toolchain hyperframes + motion (~10 MB) | hàng chục MB |
  | | **Cộng lại** | **~300 MB** |
  | **Giải nén ra app-data** | stack Python sau giải nén | **508 MB** (chưa prune: 805 MB) |
  | **Tải ở lần chạy đầu** | weights VieNeu | **1,6 GB** |
  | | Chromium (OQ-3) | 150–200 MB |

  Hai con số quyết định câu chuyện phát hành: **~300 MB tải về** và **~1,75 GB kéo thêm ở lần chạy đầu**. Chúng là lý do **OQ-12** tồn tại, và là lý do R8.8 bắt runner phải cache. Prune (R5.14) đáng 95 MB tải về và 297 MB trên đĩa — đủ lớn để là requirement, không phải tối ưu hoá.
- **Migration/backfill expectations**:
  - Người dùng Phase 3 đang có app-data từ checkout → binary phải đọc **đúng app-data đó**, chạy migration SQLite như hôm nay, và MUST NOT tạo một app-data thứ hai vì cách resolve đường dẫn đổi.
  - 3 project mẫu trong `projects/` của repo là **test case thật** của R7 (rủi ro R9 của doc 14).
  - `hyperframes` version trong project (`npx hyperframes@0.7.86`) vs version trong artifact → R6.9 cảnh báo, không tự sửa.
- **Audit and compliance needs**: mọi tool call qua bridge audit như hôm nay, không mất `actor`; giải nén runtime ghi log có version + checksum; `doctor` MUST NOT in ra secret, token, hay nội dung `setting.json`; log MUST NOT chứa đường dẫn tuyệt đối của máy build trong artifact phát hành.

---

## 4. Requirements

Ký hiệu: **SHALL** = bắt buộc · **MUST NOT** = cấm · Mọi AC viết dạng EARS.

### R1 — Directory picker server-driven + token flow + UI chọn workspace (PK-3)

*Vì sao*: D3 nói "người dùng bật web lên, chọn thư mục lưu project". Hôm nay không có đường nào làm việc đó trong UI. Người dùng nhận một binary sẽ không có `--workspace` để gõ.

- **R1.1** — Hệ thống SHALL cung cấp API để UI **liệt kê** hệ thống file: điểm khởi đầu (home + các vị trí gợi ý như Documents/Desktop) và nội dung của một đường dẫn tuyệt đối.
- **R1.2** — Khi liệt kê một thư mục, hệ thống SHALL chỉ trả **tên entry**, cờ `isDir`, cờ ghi được, và đường dẫn cha. Hệ thống MUST NOT trả nội dung file, kích thước file bí mật, hay bất kỳ dữ liệu nào của file thường.
- **R1.3** — IF request tới API hệ thống file không có session hợp lệ THEN hệ thống SHALL trả 401, **kể cả** khi request đến từ `127.0.0.1`.
- **R1.4** — Hệ thống MUST NOT expose API hệ thống file qua MCP dưới bất kỳ hình thức nào (tool, resource, prompt). Phải có test chứng minh Registry không chứa nó.
- **R1.5** — WHEN người dùng chọn một thư mục làm workspace THEN hệ thống SHALL validate (tồn tại, là thư mục, ghi được), lấy lease, scan project, và đặt nó thành workspace active.
- **R1.6** — WHEN người dùng yêu cầu tạo thư mục mới trong bước chọn THEN hệ thống SHALL tạo rồi mở nó như workspace; IF thư mục đã tồn tại THEN hệ thống SHALL nói rõ và MUST NOT ghi đè nội dung có sẵn.
- **R1.7** — IF thư mục không đọc được vì quyền, hoặc là đường dẫn không tồn tại, hoặc là file THEN hệ thống SHALL trả lỗi **có mã máy đọc được** và UI SHALL hiển thị được nó; hệ thống MUST NOT trả 500 cho một entry không đọc được.
- **R1.8** — Hệ thống SHALL canonicalize mọi đường dẫn **sau khi** resolve symlink, và SHALL chặn escape ra ngoài phạm vi đã cho phép ở mọi API mới của R1.
- **R1.9** — Trên Windows, hệ thống SHALL liệt kê được **gốc các ổ đĩa** (không có một "/" duy nhất để bắt đầu); trên POSIX, SHALL đi lên tới `/`.
- **R1.10** — WHEN `vidcom app` khởi động THEN hệ thống SHALL mở browser với **token một lần**, UI SHALL đổi token lấy session cookie `HttpOnly` rồi **xoá token khỏi URL**; token SHALL hết hạn ngắn và dùng được **một lần**.
- **R1.11** — **UI là deliverable, không phải hệ quả.** Hệ thống SHALL có màn chọn workspace hiển thị đường dẫn hiện tại, cây thư mục điều hướng được, nút tạo thư mục mới, nút chọn, và trạng thái lỗi của R1.7. IF chưa có workspace active THEN app SHALL vào màn này trước khi vào Home.
- **R1.12** — WHEN người dùng đổi workspace từ trong UI THEN hệ thống SHALL nhả lease cũ, lấy lease mới, và làm mới danh sách project **mà không cần khởi động lại tiến trình**. Đây **không** phải một AC đơn: `createInfrastructure(config)` nướng `workspaceRoot` vào và `createApplication(infrastructure, leaseId)` nướng `leaseId` vào ([`startup.ts:154`](../../../../packages/cli/src/startup.ts#L154), [`:216`](../../../../packages/cli/src/startup.ts#L216)); watcher, scheduler, journal, `resolveProjectRef` đều bám vào đó. Đổi workspace = **tear down + rebuild toàn bộ foundation** trong khi listener và session còn sống. Requirement này SHALL được estimate như một thay đổi lifecycle. Chia đôi cho đúng: **nửa HTTP đã đo và rẻ** — cùng cơ chế `currentApp` của R1.17 (§1.9c), không đóng cổng, không mất session; **nửa foundation thì không** — và đó mới là phần đắt. Hai nửa dùng chung một cơ chế nên **làm một lần** cho cả R1.17 lẫn R1.12.
- **R1.13** — Hệ thống SHALL giữ nguyên mọi luật perimeter đang có (loopback-only, kiểm `Host`, giới hạn origin). R1 MUST NOT nới bất kỳ luật nào trong số đó.
- **R1.14** — WHEN liệt kê một thư mục THEN hệ thống SHALL **giới hạn số entry** trả về trong một response và nói rõ là đã bị cắt (hoặc phân trang được). Một thư mục 200k entry MUST NOT làm daemon treo hay làm response phình không giới hạn.
- **R1.15** — IF một đường dẫn không trả lời trong một khoảng thời gian có giới hạn (network drive, UNC share, mount đã mất) THEN hệ thống SHALL bỏ dở phép đọc đó và trả lỗi có mã theo R1.7; MUST NOT để request treo vô hạn và MUST NOT để nó giữ tài nguyên của daemon.
- **R1.16** — Hệ thống SHALL **dùng chính kết quả đã canonicalize** cho thao tác tiếp theo, chứ không canonicalize để kiểm rồi dùng lại đường dẫn thô (TOCTOU: symlink đổi giữa hai bước). Một đường dẫn đã validate ở request trước MUST NOT được coi là còn hợp lệ ở request sau.
- **R1.17** — Hệ thống SHALL có trạng thái **"chưa chọn workspace"** phân biệt được với "cwd tình cờ đọc được". WHEN chưa có workspace được chọn tường minh THEN listener SHALL mở và phục vụ **chỉ** `/v1/auth/*` + `/v1/system/*`, foundation chưa được dựng, và UI SHALL vào màn R1.11. Hệ thống MUST NOT im lặng nhận `cwd` làm workspace rồi lấy lease trên đó (hành vi hôm nay — §1.5d). Cơ chế **đã chốt và đã đo** (OQ-10, §1.9c): giữ một `currentApp` đổi được, listener đọc nó mỗi request, và gọi `createServerApp` lần thứ hai khi foundation sẵn sàng — không đóng cổng, không mất session.
- **R1.18** — WHEN người dùng đổi workspace mà **đang có job chạy** trên workspace cũ THEN hệ thống SHALL từ chối đổi kèm lý do đọc được, hoặc huỷ job theo đúng luật supervision của Phase 3 (kill cây process, dọn workdir) trước khi đổi. Hệ thống MUST NOT bỏ rơi tiến trình con đang ghi vào workspace vừa bị nhả lease.
- **R1.19** — UI SHALL nối nút tạo project vào **use case tạo project đã có**, không thêm capability backend nào khác (OQ-8). Mức tối thiểu bắt buộc: nhập **tên project** · chọn **preset đóng sẵn** (chưa cần custom dimensions) · **chặn double-submit** và hiện trạng thái đang tạo · hiện lỗi **validation** và lỗi **trùng slug** · thành công thì làm mới danh sách hoặc điều hướng vào project mới · gọi qua **http-driver dùng chung của R4.10**, MUST NOT thêm một đường `fetch` riêng · sửa dòng phụ "Generate with an AI agent" ở [`new-project-card.tsx`](../../../../src/components/home/new-project-card.tsx) vì thứ được tạo là **project trống từ preset**, không phải agent sinh ra. Phải có test cho **cả hai** nhánh: tạo thành công và tạo thất bại. Hệ thống MUST NOT thêm file/folder CRUD, upload asset, agent generation hay file explorer — nếu Design chạm vào chúng thì đã vượt phạm vi.

### R2 — Single-writer daemon + MCP bridge qua IPC có xác thực (PK-4)

*Vì sao*: đây là chỗ mô hình sản phẩm chưa từng chạy. Hôm nay mở app rồi chạy Codex là **không dùng được** — lease bị từ chối.

- **R2.1** — Hệ thống SHALL bảo đảm đúng **một** tiến trình VidCom giữ quyền ghi cho một workspace tại một thời điểm.
- **R2.2** — WHEN AI host spawn `vidcom mcp` cho một workspace đang có daemon giữ lease THEN `vidcom mcp` SHALL phục vụ đầy đủ tool contract bằng cách **chuyển tiếp** tới daemon, và MUST NOT tự ghi vào workspace, MUST NOT mở database vận hành để ghi, MUST NOT tranh lease.
- **R2.3** — Kết quả tool qua bridge SHALL **giống hệt** kết quả tool khi cùng use case chạy trong daemon: cùng schema, cùng revision, cùng mã lỗi. Phải có test so sánh hai đường trên cùng input.
- **R2.4** — IF chưa có daemon nào giữ workspace THEN `vidcom mcp` SHALL **tự khởi động một daemon headless** rồi phục vụ qua nó (OQ-1 đã đóng). MUST NOT từ chối kèm hướng dẫn: AI host spawn subprocess và không có nơi nào hiển thị hướng dẫn cho người dùng đọc, nên từ chối nghĩa là agent chết ở tool call đầu mà người dùng không biết vì sao. Daemon sinh theo đường này MUST NOT mở browser.
- **R2.5** — Kết nối bridge → daemon SHALL được **xác thực**; credential SHALL nằm trong app-data với quyền chỉ chủ sở hữu đọc được (`0600` / ACL tương đương). Threat model nói cho đúng: cơ chế này chặn **user khác trên cùng máy** và chặn **trang web bất kỳ** (không có ambient credential, cộng perimeter loopback + `Host` + origin). Nó **KHÔNG** chặn được một tiến trình khác chạy dưới **cùng user** — user đó đọc được file credential, và AI host chạy đúng dưới user đó. Requirement MUST NOT hứa nhiều hơn thế.
- **R2.6** — Bridge SHALL giữ `stdout` **chỉ chứa MCP protocol message**. Mọi log, cảnh báo, tiến trình đi qua `stderr` hoặc log store. Phải có test bắt được một dòng lạc vào stdout.
- **R2.7** — WHEN daemon biến mất giữa phiên (đóng app, crash) THEN bridge SHALL trả lỗi MCP có mã rõ ràng cho tool call đang chạy, MUST NOT treo vô hạn, và MUST NOT trả kết quả giả.
- **R2.8** — WHEN agent ghi qua bridge THEN UI SHALL nhận được event và cập nhật **mà người dùng không phải reload** (đường watcher/event outbox đã có từ Phase 1 phải còn nguyên tác dụng).
- **R2.9** — Audit của mọi tool call qua bridge SHALL ghi đúng `actor` là agent và giữ nguyên mọi luật approval của Phase 2: tool destructive vẫn cần approval grant do con người phát hành.
- **R2.10** — IF hai AI host cùng spawn bridge cho cùng workspace THEN cả hai SHALL hoạt động; hệ thống MUST NOT cho phép cái thứ hai vượt qua lease hay ghi song song.
- **R2.11** — Bridge SHALL không thêm bề mặt nào ngoài tool contract: MUST NOT proxy request HTTP tuỳ ý tới daemon, MUST NOT expose `/v1/system/*` (R1.4), MUST NOT expose endpoint quản trị (credential, approve).
- **R2.12** — Lease SHALL có TTL và renew; WHEN tiến trình giữ lease chết không nhả THEN một tiến trình mới SHALL lấy được lease sau khi lease hết hạn, và sự kiện đó SHALL được log. *Cơ chế này đã có* (TTL 30s, renew 10s, takeover theo `expires_at`, audit `lease.stolen` — §1.5a); phần việc của giai đoạn này là **test** đường đó và giữ nó không bị mất khi R2.14/R1.12 đổi lifecycle.
- **R2.13** — WHEN bridge nối tới một daemon THEN nó SHALL **handshake xác minh** trước tool call đầu tiên: daemon trả về `workspaceRoot` đã canonicalize và một **instance id** của lần chạy, và bridge SHALL huỷ kết nối nếu không khớp với thứ nó định nối. Phát hiện endpoint record stale là **không đủ**: port là động, nên một record cũ cộng một port đã bị tiến trình khác chiếm có thể khiến bridge gửi mutation của workspace này vào một tiến trình lạ. Phải có test cho trường hợp port bị chiếm bởi một app khác.
- **R2.14** *(sửa 2026-08-07, người dùng duyệt — xem ghi chú cuối mục)* — WHEN daemon **mất lease** giữa phiên (renew fail, bị takeover sau TTL) THEN nó SHALL từ chối **mọi** đường ghi với một mã lỗi rõ ràng, SHALL xoá discovery record **ngay**, và SHALL đi theo **một trong ba** lối:
  1. **re-acquire được lease** → tiếp tục phục vụ;
  2. **hạ xuống trạng thái chưa-có-workspace**: foundation bị dừng hẳn (không WriteAuthority, không scheduler, không watcher, không handle DB của workspace đó) trong khi listener và session còn sống để UI hiện được lý do và cho người dùng chọn lại workspace;
  3. **tự dừng — gồm đóng listener**.

  Lối 2 chỉ được dùng khi **có UI để hiển thị**; daemon headless (`serve`, `serve --ensure`) không có ai đọc màn hình nên SHALL đi lối 3. Điều kiện bất biến cho cả ba lối: **một tiến trình không giữ lease MUST NOT phục vụ bất kỳ đường ghi nào và MUST NOT tìm thấy được bởi bridge/render.**

  Hôm nay `onLeaseLost` chỉ revoke session và dừng background, listener vẫn mở và tiến trình vẫn sống (§1.4), nên cộng với R2.12 sẽ thành **hai daemon cùng sống** và cái không lease vẫn nhận request từ bridge. Phải có test: sau khi mất lease, một tool ghi qua bridge SHALL fail có mã, MUST NOT ghi được.

  > **Vì sao sửa.** Bản duyệt lần đầu chỉ cho hai lối (re-acquire hoặc dừng hẳn), nên Design buộc phải đóng cả tiến trình — giết luôn một UI vốn không phụ thuộc workspace, trong khi kiến trúc host/foundation (DR-4) tách hai thứ đó ra từ đầu. Lối 2 giữ nguyên thứ R2.14 sinh ra để bảo vệ: bug bị chặn là *listener mở **và** foundation còn sống **và** bridge vẫn ghi được*, mà lối 2 gỡ bỏ foundation lẫn discovery record, đồng thời bootstrap app không đăng ký route `/api/bridge/**` (§4.5 của Design). Việc phân biệt hai thứ đó là **nghĩa vụ chứng minh bằng test**, không phải bằng lập luận.
- **R2.15** — IF hai bridge cùng tự khởi động daemon cho cùng workspace (kịch bản của **OQ-1**) THEN kẻ thua race lease SHALL **chuyển thành client** nối vào kẻ thắng, chứ không throw rồi chết. Và vì OQ-1 chốt **tự khởi động** (R2.4), luật "daemon do bridge sinh ra tự dừng khi bridge cuối cùng ngắt" SHALL dựa trên một **refcount liên tiến trình mà chủ sở hữu là daemon**, không phải bridge — bridge chết đột ngột không được làm rò refcount. Daemon MUST NOT tắt khi vẫn còn UI session đang attach (nếu không nó phá R2.8).

### R3 — `vidcom` đủ mode + `doctor` (PK-5, PK-8)

*Vì sao*: người dùng máy sạch không có `node_modules` để đọc log, không có cách nào biết vì sao render fail. `doctor` là mặt tiền chẩn đoán duy nhất.

- **R3.1** — Hệ thống SHALL cung cấp các mode: `app` (mặc định), `serve`, `mcp`, `render`, `doctor`, `version`, cộng các lệnh quản trị đã có (`approve`, `credential`, `backup`, `recovery`). Mode `worker` **không** thuộc Giai đoạn 4 (OQ-9 đã đóng): nó là đường điều phối job thứ hai.
- **R3.2** — `vidcom serve` SHALL chạy daemon headless (không mở browser) và in ra địa chỉ đang lắng nghe qua `stderr` hoặc log; `vidcom app` SHALL bằng `serve` + mở browser + token một lần (R1.10).
- **R3.3** — `vidcom render <project>` SHALL là **thin client của daemon**. Mọi **enqueue, execution, cancellation và publication** của một render MUST do daemon đang giữ workspace lease thực hiện. IF chưa có daemon THEN CLI SHALL khởi động một daemon headless (cùng luật R2.4) rồi gửi **đúng cùng một render command**. CLI MUST NOT dựng `WriteAuthority`, `JobScheduler`, hay một render pipeline riêng.
  Đây là ranh giới cần nói cho đúng: bản thân việc render "trong tiến trình gọi" không phải vấn đề — vấn đề là một tiến trình thứ hai **tự điều phối và tự publish**, tức một **execution authority thứ hai**. Mô hình đúng đã có: `POST /v1/projects/:id/renders` enqueue rồi trả **202 + jobId** ([`delivery-loop.ts:169`](../../../../packages/server/src/routes/delivery-loop.ts#L169)).
  CLI vẫn SHALL exit với code phản ánh kết quả để CI/batch dùng được mà không cần UI. **Bốn thứ Design phải chốt**, không thuộc Goals: (1) mặc định CLI **chờ job xong** hay trả `jobId` ngay — nghiêng về *chờ*, thêm `--detach`; (2) `Ctrl+C` có gửi cancel job không; (3) daemon do CLI sinh sống tới khi nào rồi dừng thế nào (cùng refcount R2.15); (4) exit code và JSON output khi job **fail** và khi job **cancel** — hai trạng thái khác nhau, MUST NOT gộp.
- **R3.4** — `vidcom version` SHALL in version của artifact, version `hyperframes` mà nó mang, và định danh nền tảng (`<os>-<arch>`).
- **R3.5** — `vidcom doctor` SHALL kiểm và báo trạng thái của **tối thiểu**: app-data tồn tại và ghi được · trạng thái migration SQLite · `~/.vidcom/setting.json` (có/không, parse được/không, **không in nội dung**) · FFmpeg + FFprobe · Chromium · toolchain hyperframes + version · **interpreter Python đóng băng + stack đã pin khớp danh sách (R5.14)** · sidecar VieNeu + **model cache: chưa tải / tải dở / đủ** · thư mục thư viện motion và 5 thư viện đã pin · integrity của từng archive đã giải nén (checksum) · **đường in-process chạm compiler trả kết quả trong timeout (R6.11), không chỉ kiểm binary esbuild có tồn tại** · workspace active và ai đang giữ lease · port khả dụng.
- **R3.6** — Mỗi mục `doctor` SHALL có: trạng thái (`ok` / `missing` / `broken` / `skipped`), thứ được phát hiện (đường dẫn, version), và **hành động sửa** khi không `ok`.
- **R3.7** — `vidcom doctor` SHALL exit **khác 0** khi có mục bắt buộc không `ok`, và exit 0 khi mọi mục bắt buộc `ok`. Mục tuỳ chọn không `ok` MUST NOT làm exit khác 0.
- **R3.8** — `vidcom doctor` SHALL có dạng output **máy đọc được** cho CI, ngoài dạng người đọc.
- **R3.9** — WHEN `doctor` phát hiện một thành phần thuộc R5 thiếu hoặc sai checksum THEN nó SHALL **bổ sung được** (giải nén lại) theo yêu cầu tường minh của người dùng, và SHALL báo rõ đã ghi gì ở đâu.
- **R3.10** — `vidcom doctor` MUST NOT in secret, token, API key, hay nội dung credential — kể cả ở dạng rút gọn.
- **R3.11** — IF người dùng gọi một mode không tồn tại THEN hệ thống SHALL liệt kê mode hợp lệ và exit khác 0 (hành vi hôm nay của [`main.ts:38`](../../../../packages/cli/src/main.ts#L38) phải được giữ).
- **R3.12** — Mỗi mục ở R3.5 SHALL được **phân loại tường minh** là *bắt buộc* hay *tuỳ chọn*, và bảng phân loại đó là một deliverable của Design, không phải suy diễn lúc code. Ranh giới đã rõ sau spike: thứ **ship trong artifact** (interpreter Python, esbuild, FFmpeg, toolchain, motion) là **bắt buộc** — thiếu nó nghĩa là giải nén hỏng, không phải người dùng chưa tải. Thứ **tải ở lần chạy đầu** (Chromium, weights VieNeu) cũng là **bắt buộc** (OQ-11 đã đóng), nên `vidcom doctor` exit 0 ở R8.3 buộc runner phải cache cả hai — không cache thì mỗi lần smoke kéo ~1,7 GB, vi phạm R8.7 và chết trên runner offline (R8.8).
- **R3.13** — WHEN `doctor` giải nén lại một thành phần (R3.9) trong khi **daemon đang chạy và đang giữ file mở** (FFmpeg/Chromium đang render; Windows khoá file đang mở) THEN hệ thống SHALL giải nén vào thư mục tạm rồi **swap**, hoặc **từ chối** kèm hướng dẫn dừng daemon. Hệ thống MUST NOT ghi đè in-place lên file đang được một tiến trình khác dùng, và MUST NOT để lại thành phần ở trạng thái nửa vời khi swap fail.

### R4 — Node SEA: bundle backend, nhúng frontend, bỏ Next khỏi artifact (PK-6, D2)

- **R4.1** — Hệ thống SHALL sinh **một file thực thi** cho nền tảng đang build, chứa Hono app, MCP adapter, CLI, và frontend đã build.
- **R4.2** — Artifact SHALL serve frontend **từ trong binary**, không đọc thư mục `dist`/`out` nào cạnh file thực thi. Sau khi chạy, cạnh artifact MUST NOT xuất hiện thư mục asset của frontend.
- **R4.3** — Artifact MUST NOT chứa `next` ở đường chạy: không spawn `next start`, không phụ thuộc `node_modules` ở `cwd`. Phải có test chứng minh artifact chạy được với `cwd` là một thư mục tạm rỗng.
- **R4.4** — Hono `app` SHALL **không đổi** giữa host Next (dev) và host SEA. Route, validation, middleware, mã lỗi giữ nguyên; nếu Design phải sửa route để chạy được trên SEA thì đó là lỗi thiết kế cần ghi lại, không phải thay đổi bình thường.
- **R4.5** — Artifact SHALL phục vụ mọi đường điều hướng của frontend, gồm đường studio của một project **có slug không tồn tại lúc build**. Cấu trúc **đã chốt bằng S2** (§1.7c), OQ-6 đóng hẳn: `generateStaticParams` của `/projects/[slug]` trả đúng **một sentinel `__shell`**; host SEA phục vụ `out/projects/__shell.html` cho mọi `/projects/*`; slug thật đọc từ `location`. Hệ thống SHALL map **cả file payload RSC** mà Next sinh cạnh shell (`__next.*.txt`) — router client fetch chúng khi điều hướng, và không map thì điều hướng trong app gãy dù mở URL trực tiếp vẫn chạy. `trailingSlash` SHALL được chốt tường minh (export mặc định ra `<tên>.html`, không phải `<tên>/index.html`) vì nó quyết định luật serve của host.
- **R4.6** — SSE progress của job và upload lớn (BGM tới 20 MB) SHALL hoạt động qua host SEA; đây là R4c của [doc 14 §14](../../../product-features/14-local-first-mcp-packaging-architecture.md) chuyển từ Next sang host mới, và nó SHALL được kiểm bằng test, không bằng suy luận.
- **R4.7** — Build SHALL pin toolchain Node và tắt sourcemap; artifact MUST NOT chứa file `.ts`/`.js` của backend nằm ngoài binary.
- **R4.8** — **OQ-5 đã đóng: giữ Next trong repo**, ở vai trò *build tool cho static export* + *host phát triển*. Artifact MUST NOT chứa Next ở đường chạy (R4.3). Vì frontend đã gọi API qua HTTP với base URL cấu hình được (R4.10), hai môi trường dùng **cùng một** frontend bundle và **cùng một** Hono app, nên CI SHALL chứng minh điều đó bằng cách chạy cùng một tập route đại diện qua host SEA — không cần một cặp test "hai host" song song như bản 1 yêu cầu. Quy trình dev frontend SHALL được document hoá và còn dùng được sau khi chuyển sang export.
- **R4.9** — Cold start của artifact SHALL đo được, ghi lại, **và có ngưỡng fail tường minh** (cold và warm, đo trên nền tảng của runner). Một con số "đo được và ghi lại" mà không có ngưỡng thì không fail được, tức không phải AC — ngưỡng đó là deliverable của Design và MUST được chốt cùng lúc với baseline.
- **R4.10** — Frontend SHALL gọi backend qua **http-driver** với **base URL cấu hình được** (một `ServiceApi` registry, một driver), thay cho `fetch` đường tương đối rải trong component. Cùng một bundle SHALL chạy được cả khi FE và daemon **cùng origin** (artifact) và **khác origin** (dev), chỉ bằng cấu hình. Đường đổi nonce → session cookie đang có ([`browser-session.ts`](../../../../src/lib/api/browser-session.ts)) SHALL đi qua cùng driver đó và SHALL gửi credential (cookie) trong cả hai chế độ.
- **R4.11** — Đường build export SHALL không còn phụ thuộc catch-all route handler của Next (`src/app/api/[[...route]]/route.ts`, `dynamic = "force-dynamic"`): route đó SHALL bị loại khỏi build export hoặc bị bỏ hẳn. IF nó còn trong build THEN `next build` fail — đây là lỗi build, không phải degrade, nên phải có kiểm tra tự động trong CI.
- **R4.12** — Origin của host phát triển (ví dụ `http://localhost:3000`) SHALL chỉ được thêm vào danh sách origin cho phép **ở chế độ dev**, qua một công tắc tường minh. Artifact phát hành MUST NOT chấp nhận origin đó, và phải có test chứng minh. Mọi luật perimeter còn lại (loopback-only, kiểm `Host`, CSRF origin) giữ nguyên. Cấu hình dev SHALL pin **cùng một hostname** ở cả hai đầu: cookie session là `sameSite: "Strict"` và tuy port không thuộc định nghĩa "site", `localhost` và `127.0.0.1` **là hai site khác nhau** — trộn hai cái thì cookie bị chặn (§1.6). IF cấu hình dev trỏ hai hostname khác nhau THEN hệ thống SHALL fail tường minh, MUST NOT để người phát triển đoán vì sao mất session.
- **R4.13** — Mọi page dynamic route SHALL tách thành **server component xuất `generateStaticParams`** + **client component mang thân page**. Next từ chối `generateStaticParams` trong file `"use client"` (§1.7c), nên đây là thay đổi bắt buộc, không phải lựa chọn: [`src/app/projects/[slug]/page.tsx`](../../../../src/app/projects/[slug]/page.tsx) hôm nay là `"use client"`. Thân page SHALL đọc slug từ `location`, MUST NOT đọc từ `params` — payload RSC của shell hard-code `__shell` nên `params` luôn trả sentinel.
- **R4.14** — Entry của artifact SHALL là **CJS không có top-level await**. Node SEA nhận main CJS, và esbuild từ chối top-level await ở format `cjs` (§1.7); mọi khởi tạo bất đồng bộ SHALL nằm trong một hàm `main()`. Đây là ràng buộc của công cụ, không phải phong cách — vi phạm thì build fail, không degrade.

### R5 — Giải nén native runtime + thư viện motion + sidecar vào app-data lần chạy đầu (PK-7, bẫy 4.8)

- **R5.1** — Artifact SHALL mang, dưới dạng asset nhúng, các archive runtime theo `<os>-<arch>`: binary xử lý media (FFmpeg/FFprobe), **binary native của `esbuild`** (R6.11 cần đường dẫn tới nó), sidecar TTS VieNeu **cộng một CPython đóng băng đã cài sẵn stack của nó** (§1.7d — `worker.py` một mình không chạy được), **5 thư viện motion đã pin version**, và toolchain hyperframes (theo R6).
- **R5.2** — WHEN artifact chạy lần đầu và một archive chưa được giải nén THEN hệ thống SHALL giải nén nó vào app-data, verify checksum, rồi ghi marker hoàn tất. Lần chạy sau SHALL **bỏ qua** bước này (warm path).
- **R5.3** — IF giải nén bị ngắt giữa chừng THEN lần chạy sau SHALL coi archive đó là **chưa giải nén** và làm lại; hệ thống MUST NOT dùng một thư mục giải nén dở.
- **R5.4** — IF checksum không khớp THEN hệ thống SHALL từ chối dùng thành phần đó, báo lỗi có mã, và giải nén lại; MUST NOT chạy tiếp im lặng.
- **R5.5** — IF archive cho nền tảng đang chạy không tồn tại trong artifact THEN hệ thống SHALL nói rõ nền tảng nào được hỗ trợ, và MUST NOT fail bằng một lỗi thiếu file mơ hồ.
- **R5.6** — WHEN hai tiến trình VidCom cùng khởi động lần đầu THEN chỉ một tiến trình SHALL giải nén một archive; tiến trình kia SHALL chờ hoặc dùng kết quả, và MUST NOT ghi chồng lên.
- **R5.7** — Thư viện motion SHALL được giải nén theo layout `<packageName>/<packagePath>` và **giữ `package.json`** để guard version còn chạy; hệ thống SHALL truyền đường dẫn đó qua `motionLibraryRoot` **ở mọi entrypoint** (hôm nay không entrypoint nào truyền — §1.2).
- **R5.8** — WHEN `install_motion_library` chạy trên artifact THEN nó SHALL vendor được thư viện vào project **mà không cần `node_modules`**, và version vendor được SHALL khớp version trong catalogue.
- **R5.9** — App-data SHALL được tạo với quyền chỉ chủ sở hữu truy cập (`0700` / ACL tương đương), giữ nguyên luật đang có của `secureAppDataDirectorySync`.
- **R5.10** — WHEN người dùng xoá thư mục `native/**` bằng tay THEN lần chạy sau (hoặc `doctor`) SHALL dựng lại được; hệ thống MUST NOT crash và MUST NOT mất dữ liệu project.
- **R5.11** — Việc giải nén SHALL quan sát được, và **nói rõ ở đâu**: ở lần chạy đầu trên máy sạch UI chưa mở, nên kênh bắt buộc là **`stderr` của CLI** (được phép — R2.6 chỉ cấm `stdout` của bridge) cộng log store; WHEN UI đã mở THEN tiến trình chuẩn bị runtime SHALL hiển thị được trong UI. Một requirement "người dùng thấy được" mà không nói thấy ở đâu thì không kiểm được.
- **R5.12** — Giải nén MUST NOT ghi bất cứ thứ gì vào workspace của người dùng hay cạnh file artifact.
- **R5.13** — Cold start SHALL theo **đúng thứ tự**: giải nén (R5.2) → migrate SQLite **một lần** → lấy lease → mở listener. Hệ thống MUST NOT migrate nhiều lần trong một lần boot (hôm nay `selectWorkspace` migrate hai lần rồi foundation migrate lần thứ ba — §1.4), và IF hai tiến trình cold-start đồng thời (kịch bản R5.6) THEN chỉ một tiến trình được migrate; tiến trình kia SHALL chờ. Migration chạy **trước** khi có lease là hiện trạng và là một race chưa được bảo vệ — Design SHALL chỉ ra cơ chế bảo vệ (không nhất thiết là lease, nhưng phải là một cái).
- **R5.14** — Danh sách package của stack Python SHALL được **prune và pin tường minh**, không để `pip install vieneu==3.2.4` quyết định. Đo thật (§1.7d): cài trần ra **805 MB**, prune còn **508 MB** mà WAV vẫn ra — 297 MB đó là một web UI demo (`gradio`, `fastapi`, `uvicorn`, `starlette`) và `llvmlite`/`numba`/`sklearn`/`PIL`. Đây là chênh lệch giữa tải ~300 MB và ~450 MB nên nó là **requirement, không phải tối ưu hoá**. Build SHALL fail nếu stack thực tế lệch khỏi danh sách đã pin (cùng tinh thần R9.6), và `doctor` SHALL kiểm được stack đã giải nén khớp danh sách đó.

### R6 — Toolchain render/TTS chạy được **từ artifact** (PK-7, PK-8)

*Vì sao*: đây là requirement mà build-order không có mục riêng và là chỗ dễ mất cả giai đoạn. Render hôm nay spawn `[process.execPath, <hyperframes CLI>]`. Trong SEA, `process.execPath` là chính artifact.

- **R6.1** — WHEN người dùng render một project từ artifact trên máy **không có Node và không có Python trên PATH** THEN hệ thống SHALL render ra MP4 hợp lệ **có tiếng narration**. S1a và S3 đều PASS (§1.7a, §1.7d) nên AC này giữ nguyên phạm vi đầy đủ — bản 2 để sẵn một nhánh hạ thấp phòng khi S3 FAIL, nhánh đó **không dùng đến**.
- **R6.2** — Cách thực thi toolchain hyperframes từ artifact **đã chốt bằng S1a** (§1.7a): hình dạng `[process.execPath, cliPath, …]` hôm nay MUST NOT dùng — trong SEA nó làm **artifact chạy lại chính `main` của nó** thay vì chạy CLI, và không sinh lỗi nào. Hệ thống SHALL dùng đường **shim**: artifact tự làm Node host qua một argv sentinel rồi `import()` CLI (OQ-13 đã đóng, §1.9a). Sidecar Node cũng PASS và đã đo (35,9 MB nén) — giữ làm phương án dự phòng, không phải phương án mặc định. Vì chọn shim, R5 **không** phải mang thêm Node runtime.
  Kèm một ràng buộc ở tầng CLI: argv sentinel SHALL được xử lý **trước** parser lệnh hiện có và MUST NOT là một mode công khai. Hôm nay [`parseVidcomCommand`](../../../../packages/cli/src/main.ts#L34) coi mọi argv bắt đầu bằng `--` là `vidcom app`, rồi `parseAppCommandArgs` throw `unknown app argument` — nên một sentinel dạng `--…` rơi thẳng vào đường đó. Nó cũng MUST NOT xuất hiện trong danh sách mode mà R3.11 in ra.
- **R6.3** — Hệ thống MUST NOT dùng `require.resolve` trên `node_modules` để tìm toolchain ở đường chạy production; đường resolve SHALL đi qua cấu hình được inject (cùng nguyên tắc với `nativeDependenciesRoot`). *Đường inject đã tồn tại* — `hyperframesCliPath` / `hyperframesPackagePath` là optional constructor param và `require.resolve` chỉ là fallback (§1.5c) — nên việc thật là **nối dây ở entrypoint**, giống `motionLibraryRoot` của R5.7.
- **R6.4** — Snapshot, diagnostics (`hyperframes check`) và mọi đường khác đang spawn cùng CLI SHALL dùng **cùng một** cơ chế resolve **và cùng một hình dạng spawn của R6.2**; MUST NOT có hai cách tìm toolchain. Requirement này phủ **cả** chỗ spawn thứ hai mà bản 1 bỏ sót: `binary-probe` gọi `process.execPath [cliPath, "browser", "path"]` để tìm Chromium ([`binary-probe.ts:66-70`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L66)) — trong SEA đó là chính artifact. Chế độ hỏng ở **cả hai** chỗ là **im lặng**, không phải lỗi render: artifact chạy lại main của nó (§1.7a). Phải có test bắt được hình dạng cũ, vì không có test thì nó quay lại mà CI vẫn xanh.
- **R6.5** — Chromium SHALL được **tải ở lần chạy đầu** (OQ-3 đã đóng: Chrome Headless Shell, 94,5 MB / ~8 s, §1.9b), không bundle; IF không có và không lấy được (máy offline) THEN hệ thống SHALL báo lỗi có mã, nói rõ cách khắc phục, và MUST NOT để job render treo. Cùng luật cho weights của VieNeu: WHEN cache đã đầy đủ THEN hệ thống SHALL chạy được **hoàn toàn offline** — đã kiểm bằng `HF_HUB_OFFLINE=1` (§1.7d). Không đặt cờ đó thì `snapshot_download` vẫn gọi mạng ở mọi lần chạy warm; [`tts-vieneu.ts:322-327`](../../../../packages/adapter/src/tts/tts-vieneu.ts#L322) hôm nay đặt `HF_HOME`/`HF_HUB_CACHE`/`TORCH_HOME` nhưng **không** đặt nó.
- **R6.6** — FFmpeg/FFprobe SHALL đến từ archive nhúng, không từ PATH của máy người dùng; IF phát hiện binary trên PATH THEN hệ thống MUST NOT ưu tiên nó hơn bản đã ship (trừ khi người dùng override tường minh qua cấu hình đã có).
- **R6.7** — Sidecar VieNeu SHALL chạy bằng **interpreter đóng băng do artifact ship** (R5.1), không bằng `python3` của máy người dùng. `defaultVieNeuCommand` hôm nay trả `["python3"|"python", worker.py]` ([`vieneu-sidecar-path.ts:36-43`](../../../../packages/adapter/src/tts/vieneu-sidecar-path.ts#L36)) — đó là đường phải đổi. Luật cấu hình đang có được giữ: `~/.vidcom/setting.json` SHALL override được lệnh sidecar cho người dùng muốn dùng Python riêng. IF interpreter đã ship thiếu hoặc sai checksum THEN `doctor` SHALL báo `missing` kèm hành động sửa, và TTS provider đó SHALL degrade rõ ràng chứ không fail toàn app.
- **R6.8** — Mọi luật process supervision của Phase 3 (kill cây process, workdir có marker theo job, `maxAttempts: 1` cho render) SHALL còn nguyên hiệu lực khi tiến trình cha là artifact. Hình dạng của R6.2 **chèn thêm một tầng tiến trình** (artifact → artifact-làm-Node-host → Chromium/ffmpeg), nên luật kill SHALL đi hết cây qua tầng đó. *Cơ chế hiện có đã đúng*: [`process-supervisor.ts`](../../../../packages/adapter/src/runtime/process-supervisor.ts) `spawn(detached)`, liệt kê `ps`, giết theo **process group**, xác minh bằng `(pid, startedAt)` — nó **không** dùng `execPath`, nên việc cha và con cùng đường dẫn không ảnh hưởng gì (§1.9a bác bỏ giả định ngược lại của bản 3). Việc thật là **một test huỷ-giữa-chừng**, không phải sửa cơ chế.

  *(Sửa 2026-08-07 — câu chữ cũ nghịch steering.)* Bản trước viết test đó "chứng minh **không còn tiến trình con nào**". [steering 08 §6.1](../../../steering/08-jobs-and-queue.md) đã **rút lại** bảo đảm zero-survivor sau khi đo thật: không nền tảng nào cung cấp được nó bằng công cụ Node thuần, và steering gọi loại luật đó là "nguy hiểm nhất trong một source of truth" vì mọi tầng trên sẽ tin nó. Nên R6.8 SHALL đòi **bounded best-effort có khai báo**: một **termination proof** mang cờ `exhaustive` cho biết nó cạn kiệt hay bị chặn; còn survivor sau khi cạn lượt verify ⇒ `process_termination_unverified` và MUST NOT ghi `cancelled`. Vì lỗ đó có thật, **containment là tầng phòng thủ bắt buộc thứ hai**: job spawn process con MUST chạy trong workdir do hệ thống sở hữu, có marker, để recovery thu hồi thứ lọt qua. Hệ thống MUST NOT suy survivor từ quan hệ cha-con (con bị reparent) hay từ thành viên process group (`chrome-headless-shell` **đo được** là tự tách group).
- **R6.9** — IF project khai một version `hyperframes` khác version artifact mang THEN hệ thống SHALL cảnh báo (R6 của doc 14) và MUST NOT im lặng render bằng version khác.
- **R6.10** — Mọi đường **gọi `@hyperframes/*` in-process** SHALL chạy được từ artifact. **S1b đã chốt cách làm** (§1.7b): `@hyperframes/{core,sdk,studio-server,parsers}` cùng `linkedom` **bundle thẳng vào SEA được** — 9/9 bước PASS trong thư mục tạm, không `node_modules`, không `node` trên PATH. Nên **8 điểm `import` tĩnh của adapter giữ nguyên**; MUST NOT đổi chúng sang resolve động, vì đó là công vô ích. MUST NOT có hai copy `linkedom` (hai `DOMParser`). Việc thật còn lại nằm ở R6.11.
- **R6.11** — WHEN một đường in-process chạm compiler của `@hyperframes/core` THEN hệ thống SHALL đặt **cả hai**: `ESBUILD_BINARY_PATH` trỏ vào binary native đã giải nén (R5.1) **và** `ESBUILD_WORKER_THREADS=0`. Thiếu **bất kỳ** cái nào thì tiến trình **treo vĩnh viễn, không một dòng stderr** — không phải lỗi, không phải degrade (ma trận đo được ở §1.7b). Vì trạng thái treo không phát hiện được bằng cách kiểm sự tồn tại của file, hệ thống SHALL đặt **timeout** cho mọi lời gọi in-process chạm compiler, và IF timeout THEN trả lỗi có mã nói rõ hai biến này. `doctor` SHALL kiểm bằng cách **thực sự gọi một `transformSync` nhỏ có timeout**, MUST NOT chỉ kiểm binary có tồn tại.

### R7 — Import project có sẵn vào workspace (PK-12)

- **R7.1** — Hệ thống SHALL cho người dùng **import một project từ đường dẫn ngoài workspace** vào workspace hiện tại.
- **R7.2** — Import SHALL **không sửa gì** ở bản gốc: nguồn được đọc, không được ghi, không được di chuyển (trừ khi người dùng chọn di chuyển tường minh).
- **R7.3** — WHEN nguồn không phải project hợp lệ THEN hệ thống SHALL nói rõ thiếu gì, và MUST NOT import nửa vời.
- **R7.4** — IF slug đích đã tồn tại trong workspace THEN hệ thống SHALL từ chối hoặc đề nghị tên khác; MUST NOT ghi đè project đang có.
- **R7.5** — IF project được import mang `ProjectId` đã tồn tại THEN hệ thống SHALL cấp ID mới, ghi lại `vidcom.json`, và log sự kiện (luật §10.4 của doc 14).
- **R7.6** — Import SHALL là **một** mutation atomic: hoàn tất thì project nhận diện được và mở được; thất bại thì workspace không còn lại thư mục rác.
- **R7.7** — Import SHALL backfill mọi thứ Phase 3 yêu cầu ở một project (schema `vidcom.json`, preset suy từ kích thước, `.vidcom/` dựng lại được) — dùng lại đường bootstrap đã có, MUST NOT viết đường thứ hai.
- **R7.8** — Import SHALL ghi audit; IF nguồn lớn THEN người dùng SHALL thấy được tiến trình thay vì thấy app treo.
- **R7.9** — 3 project mẫu trong `projects/` của repo SHALL import được thành công như test case thật (rủi ro R9 của doc 14).
- **R7.10** — IF đường dẫn nguồn **nằm trong workspace hiện tại**, hoặc **là thư mục cha** của workspace, hoặc trùng workspace THEN hệ thống SHALL từ chối kèm lý do đọc được. Đây là chỗ sinh copy đệ quy vô hạn, và nó phải bị chặn **trước** khi bắt đầu copy, sau khi canonicalize (cùng luật R1.16).
- **R7.11** — Hệ thống SHALL có **một luật tường minh cho symlink** trong project nguồn: đi theo (copy nội dung đích) hay giữ nguyên link hay từ chối. Luật đó SHALL giống nhau ở mọi entry và MUST NOT cho phép symlink dẫn ra ngoài project nguồn biến thành đường copy dữ liệu ngoài phạm vi người dùng chọn.
- **R7.12** — Import SHALL staging **trên cùng filesystem với workspace đích** để bước cuối là một `rename` atomic (R7.6). IF thư mục tạm nằm trên thiết bị khác THEN `rename` fail — đây là bẫy §6 đã ghi cho R5 và nó áp **y nguyên** cho R7; hệ thống MUST NOT dùng thư mục tạm của OS một cách vô điều kiện.

### R8 — Smoke test trên artifact, máy sạch, trong CI

*Vì sao*: mọi requirement trên đây có thể xanh trên máy phát triển và đỏ trên máy người dùng. Đây là requirement duy nhất phát hiện được chuyện đó.

- **R8.1** — CI SHALL có một job chạy **trên artifact đã build**, không phải trên source checkout.
- **R8.2** — Job đó SHALL chạy với `node` **không có trên PATH**, **không có `node_modules`** trong `cwd` hay thư mục cha, và với app-data ở một `HOME` sạch.
  "Sạch" ở đây nghĩa là **không mang trạng thái của máy phát triển**, không phải "rỗng tuyệt đối": app-data, `~/.vidcom/setting.json` và mọi thứ artifact tự giải nén SHALL bắt đầu từ con số không, còn **cache tải-về của R8.8** (`$HOME/.cache/hyperframes`, `HF_HOME`) được phép mồi sẵn. Ranh giới: mồi một thứ artifact **tự tải được** là tiết kiệm băng thông; mồi một thứ artifact **phải tự giải nén** là làm hỏng phép thử. IF job không phân biệt được hai loại đó THEN nó không chứng minh được R5.2 (cold rồi warm).
- **R8.3** — Smoke SHALL phủ, tối thiểu: `vidcom version` · `vidcom doctor` exit 0 **theo bảng phân loại bắt buộc/tuỳ chọn của R3.12** · **cold start** rồi **warm start** (chứng minh giải nén một lần) · mở một workspace trống qua API picker với token flow thật · import một project mẫu · render ra MP4 verify được bằng FFprobe · **một dòng TTS ra WAV có độ dài đúng** (S3 PASS nên đây là mục bắt buộc, không còn điều kiện) · snapshot một scene · AI host spawn `vidcom mcp` **trong khi daemon đang chạy**, gọi một tool đọc và một tool ghi, và restart bridge rồi vẫn thấy state đúng · `stdout` của bridge sạch · **handshake của bridge từ chối một endpoint record stale** (R2.13) · **daemon mất lease thì tool ghi qua bridge fail có mã** (R2.14) · **mở studio của một project có slug tạo sau khi build** (R4.5) · **huỷ render giữa chừng rồi thu được termination proof có cờ `exhaustive`**, và workdir có marker thu hồi được thứ lọt qua (R6.8 — MUST NOT phát biểu thành "không còn tiến trình con", xem steering 08 §6.1) · **một đường in-process chạm compiler trả kết quả trong timeout**, chứ không treo (R6.11).
- **R8.4** — IF một thành phần bắt buộc vắng mặt trong job smoke THEN job SHALL **fail**, MUST NOT skip. (Ở job test thường, skip-có-thông-báo vẫn là hành vi đúng.)
- **R8.5** — Smoke SHALL chạy **trên runner cùng OS với artifact đang kiểm**, cho cả ba nền tảng target: macOS arm64, Windows x64, Linux x64 (OQ-7). Mỗi lần chạy SHALL ghi lại nền tảng đã kiểm. **Windows x64 là release gate**, MUST NOT bị cắt. IF Linux x64 bị defer THEN tài liệu phát hành SHALL tuyên bố hỗ trợ **macOS + Windows** và MUST NOT tuyên bố đạt mục tiêu ba nền tảng — một artifact chưa ai chạy smoke trên đó **không phải** một nền tảng được hỗ trợ. Lưu ý hiện trạng: CI hôm nay kiểm **source** trên cả ba OS ([`ci.yml`](../../../../.github/workflows/ci.yml)) nhưng chưa kiểm **artifact đã đóng gói** trên OS nào — đây là tầng mới R8 phải dựng, không phải tầng có sẵn để mở rộng.
- **R8.6** — Smoke SHALL chứng minh cạnh artifact **không xuất hiện** source, sourcemap, hay thư mục asset của frontend sau khi chạy.
- **R8.7** — Thời gian chạy job smoke SHALL nằm trong giới hạn CI hiện tại, hoặc được tách thành job riêng có điều kiện rõ ràng; MUST NOT làm CI thường xuyên đỏ vì timeout.
- **R8.8** — **Mọi thành phần tải-ở-lần-chạy-đầu** SHALL được **cache trên runner** giữa các lần chạy job smoke. Có hai thành phần như vậy, không phải một: **Chromium** (94,5 MB tải → 196 MB đĩa, cache ở `$HOME/.cache/hyperframes/chrome`) và **weights VieNeu** (~1,6 GB ở `HF_HOME`, vì R8.3 bắt smoke phải ra WAV thật). Job smoke MUST NOT tải lại chúng mỗi lần — ~1,7 GB mỗi lần chạy vi phạm R8.7 và chết trên runner offline. Cache SHALL có key theo version của thành phần, và job SHALL có **một bước chạy offline sau lần đầu** để chứng minh R6.5 (`HF_HUB_OFFLINE` cho weights, lỗi có mã cho Chromium). Cả hai đường dẫn cache đều theo `HOME`, mà R8.2 lại bắt `HOME` sạch — nên cấu hình cache của runner phải trỏ tường minh, không dựa vào mặc định. IF một thành phần không cache được THEN nó SHALL bị đảo sang "tuỳ chọn" ở R3.12 và bước tương ứng của R8.3 bị cắt — nhưng đó là **hạ thấp mốc**, cần duyệt, MUST NOT làm im lặng.

### R9 — Hygiene & provenance của artifact (PK-10 một phần)

- **R9.1** — Artifact MUST NOT chứa API key, credential, signing key, hay bất kỳ bí mật nào ([doc 14 §2](../../../product-features/14-local-first-mcp-packaging-architecture.md)). Phải có kiểm tra tự động, không chỉ một câu cam kết.
- **R9.2** — Artifact MUST NOT chứa sourcemap; frontend SHALL được build production, minify.
- **R9.3** — Artifact MUST NOT chứa đường dẫn tuyệt đối của máy build ở output người dùng thấy được (log, error message, asset).
- **R9.4** — Mỗi artifact SHALL có checksum ghi lại cùng version + nền tảng, để người tải về verify được.
- **R9.5** — Trên macOS, artifact SHALL có signature hợp lệ ở mức tối thiểu (ad-hoc) để OS không từ chối chạy; notarization đầy đủ là PK-10, Giai đoạn 6.
- **R9.6** — **Build lặp lại được về thành phần** (không phải reproducible build theo nghĩa checksum-identical): cùng commit + cùng toolchain đã pin SHALL cho ra artifact chạy được với **cùng bộ thành phần và cùng checksum cho từng archive nhúng**, và MUST NOT phụ thuộc trạng thái `node_modules` của máy build một cách ngầm (§1.2 là ví dụ đang có). Bit-for-bit identical là mục tiêu của Giai đoạn 6, không phải của R9 — bản 1 đặt tên requirement rộng hơn thứ nó kiểm.
- **R9.7** — Hệ thống SHALL có một quyết định tường minh về **telemetry của toolchain đi kèm**. HyperFrames CLI thu thập dữ liệu sử dụng và in thông báo ở lần chạy đầu ("*collects anonymous usage data… If you sign in to HeyGen, your account is linked to your usage*", §1.7a). Một sản phẩm local-first mà thành phần nhúng tự gửi dữ liệu là chuyện sản phẩm, không phải chi tiết vận hành: artifact SHALL **hoặc** tắt telemetry mặc định (`hyperframes telemetry disable` ở bước giải nén R5), **hoặc** nói ra trong tài liệu phát hành. MUST NOT để mặc định im lặng. Thông báo đó đi qua `stderr` nên **không** vi phạm R2.6.

---

## 5. Spike gate — ĐÃ MỞ

Hai vòng, chín spike. **Vòng 1** (S1a, S1b, S2, S3) hỏi *cách đóng gói có khả thi không*; **vòng 2** (S4, S5, S6, S7) hỏi *các OQ nên chốt thế nào*. Vòng 2 ghi ở **§1.9**; phần dưới đây là vòng 1.

Bốn câu hỏi dưới đây có thể **đổi cách đóng gói** hoặc **đổi phạm vi**, nên chúng chạy **trước** Design, cùng lý do với Phase 0. Chúng đã chạy ngày 2026-08-06; kết quả tóm tắt ở **§1.7**, bằng chứng đầy đủ và cách dựng lại ở [`spikes/phase-4/README.md`](../../../../spikes/phase-4/README.md). Không viết production code trong spike.

Tiêu chí PASS được giữ nguyên ở đây để đối chiếu — thứ đổi là cột kết quả.

### S1a — spawn CLI khi máy không có Node

**Câu hỏi**: SEA gọi được hyperframes CLI bằng cách nào, khi `process.execPath` là chính artifact và không có `node_modules`? Có **hai** chỗ spawn: đường render, và `binary-probe` hỏi đường dẫn Chromium (§1.5c).

**PASS khi**: từ một binary SEA, ở một thư mục tạm, với `node` **không có trên PATH**, render được một project ra MP4 mà FFprobe đọc được đúng thời lượng; và huỷ giữa chừng không để lại process con sống.

**Kết quả: PASS.** MP4 `h264 · 1920×1080 · duration=14.000000 · 4.807.398 byte`, exit 0, 65,8 s. Hình dạng hôm nay (`[execPath, cliPath]`) **không chạy CLI và không báo lỗi**; hai đường thay thế đều chạy (§1.7a).

> **Đính chính của vòng 2.** Lần chạy đầu ghi phần huỷ là "không đạt" vì giết cha để lại shim + `ffmpeg` sống. Đó là **lỗi của spike**: nó dùng `spawn` trần, không `detached`, không giết theo process group. Chạy lại đúng giao thức của `process-supervisor.ts` (S4, §1.9a) thì **cả shim lẫn sidecar đều 0 tiến trình sống sót**. Kết luận đúng là PASS cả hai tiêu chí; việc còn lại là một **test huỷ-giữa-chừng** ở R6.8.

→ R6.2, R6.4, R6.8, **OQ-13**.

### S1b — gọi `@hyperframes/*` in-process

**Câu hỏi**: bundle hay resolve động được `@hyperframes/core` + `/sdk` + `/studio-server` + `/parsers` cùng `esbuild` (native binary) và **một** copy `linkedom` vào/từ SEA?

**PASS khi**: từ binary SEA, thư mục tạm, không `node` trên PATH, parse + edit được một composition qua đường in-process (mở composition, đọc clip timing, ghi lại) không cần `node_modules`.

**Kết quả: PASS, và câu trả lời là bundle tĩnh** — 9/9 bước, binary 119,8 MB, bundle 3,36 MB, 503 module đầu vào. Không cần đổi 8 điểm `import` sang resolve động. **Nhưng lộ ra một chế độ hỏng chưa từng có trong bản 1–2: treo vĩnh viễn, không stderr**, nếu thiếu `ESBUILD_BINARY_PATH` hoặc `ESBUILD_WORKER_THREADS=0` (§1.7b). → R6.10, **R6.11**, R5.1.

### S2 — Frontend chạy được từ host SEA với `output: 'export'`

**Câu hỏi**: cấu trúc route nào phục vụ được `/projects/[slug]` khi export chỉ sinh HTML cho params liệt kê được?

**PASS khi**: từ binary, mở được Home và studio của một project **có slug không tồn tại lúc build**; SSE progress của một job dài không bị buffer; upload 20 MB đi qua được; không có thư mục asset nào xuất hiện trên đĩa; và **cùng bundle đó** chạy được ở chế độ dev cross-origin (R4.10/R4.12) với cookie session đi kèm.

**Kết quả: PASS sau hai thay đổi FE bắt buộc.** Slug lạ → shell (200), payload RSC → shell (200), SSE `+275/+575/+875/+1176/+1478 ms` không buffer, upload nhận đủ `20971520` byte, không file nào rơi ra đĩa. Hai thứ chặn build và cả hai là requirement: catch-all route handler (R4.11, xác nhận bằng build thật) và `generateStaticParams` không sống được trong `"use client"` (R4.13). → R4.5, R4.11, **R4.13**, **R4.14**.

**Chưa kiểm**: cookie session cross-origin ở chế độ dev. SameSite chỉ do browser cưỡng chế nên `curl` không kiểm được — cần một harness browser. Phân tích ở R4.12 (`localhost` ≠ `127.0.0.1`) **chưa có bằng chứng chạy**, và đó là món nợ kiểm chứng duy nhất còn lại của gate này.

### S3 — TTS trên máy không có Python

**Câu hỏi**: `defaultVieNeuCommand` trả `["python3"|"python", worker.py]`. Trên máy sạch không có Python, có đường nào ship được stack CPU (torch-free: `vieneu==3.2.4` + `huggingface-hub` + ONNX Runtime) để một dòng chữ ra WAV?

**PASS khi**: từ binary SEA trên máy **không có `python3` trên PATH** và `HOME` sạch, một dòng tiếng Việt ra WAV có độ dài đúng; và đo được kích thước archive cộng thêm, kích thước weights lần đầu, thời gian lần chạy đầu.

**Kết quả: PASS.** WAV `4,88 s`, mean −20,1 dB. Cách thoát là **ship một Python đóng băng**, không phải bỏ Python — nên **P-C được viết lại** (§1.1) chứ không phải R6.1 bị hạ thấp. Giá: 150 MB archive đã prune + 1,6 GB weights lần đầu (§1.7d). → P-C, R6.1, R6.7, R5.1, **R5.14**, **OQ-12**.

---

## 6. Risks

- **~~R6/S1 là gate kỹ thuật đội lốt task.~~ ĐÃ ĐÓNG bằng S1a/S1b.** SEA chạy được CLI (qua shim hoặc sidecar) và bundle được `@hyperframes/*` in-process, nên cấu trúc artifact **không đổi**. Rủi ro còn lại đổi bản chất: không còn là "liệu có chạy được" mà là **"hỏng thì có biết không"** — hai chế độ hỏng đo được đều **im lặng** (spawn sai hình dạng chạy lại chính app; esbuild thiếu env treo vĩnh viễn). R6.4 và R6.11 là hai luật chặn, và cả hai cần test chứ không chỉ cần câu.
- **"Máy sạch" không kiểm được trên máy phát triển.** Máy nào build được artifact đều có Node, Python, có thể có FFmpeg. Không cô lập PATH/HOME thì R8 xanh vì lý do sai, và bug lộ ra ở người dùng đầu tiên. Đây là rủi ro **PASS giả** — cùng loại với hai giả định bị spike bác bỏ ở Phase 3.
- **Bridge có thể trở thành một implementation nghiệp vụ thứ hai.** R2 dễ trôi: thêm một nhánh "nếu không nối được daemon thì tự làm" là tạo đúng thứ [doc 14 §4](../../../product-features/14-local-first-mcp-packaging-architecture.md) cấm — hai đường ghi hành xử khác nhau trên cùng thao tác. R2.2 và R2.3 là hai luật chặn, và chúng cần test chứ không chỉ cần câu.
- **Directory picker là bề mặt tấn công mới lớn nhất của dự án.** Một filesystem browser trên HTTP, chạy trên máy người dùng. Sai một chỗ (thiếu token, thiếu kiểm `Host`, trả nội dung file, quên canonicalize sau symlink) là lỗ đọc ổ đĩa. Phase 1–3 đã dựng perimeter đúng; rủi ro là R1 **nới nó ra** để cho tiện.
- **`output: 'export'` chạm vào FE routing, không chỉ chạm build — và nhiều hơn bản 2 nghĩ.** S2 đã chốt cấu trúc (sentinel `__shell`), nhưng đo được **ba** thay đổi FE bắt buộc chứ không phải một: tách server shell / client child (R4.13), đọc slug từ `location` chứ không từ `params`, và map cả payload RSC. Rủi ro còn lại là **coi chúng là chi tiết Design** rồi phát hiện lúc `next build` đỏ — cùng loại với catch-all route handler (R4.11) và origin dev lọt vào artifact (R4.12).
- **Kích thước tải về đổi nghĩa của chữ "một file tải xuống".** Đo thật: SEA base ~110–130 MB + stack Python đã prune 150 MB + FFmpeg ⇒ **~300 MB tải về**; lần chạy đầu kéo thêm **1,6 GB weights VieNeu** và **94,5 MB Chrome Headless Shell** (~8 s, S5). Không prune thì cộng thêm 95 MB nữa. **OQ-12 đã chốt** biên giới: thứ không lấy sau được thì ship, thứ lấy được thì tải. Rủi ro còn lại không phải con số mà là **cách nói**: mốc giờ là "chưa cài gì, **có mạng ở lần chạy đầu**", và nếu commitment không sửa theo thì người dùng đầu tiên ở chỗ mạng kém sẽ thấy một sản phẩm treo.
- **App-data của người dùng Phase 3 phải dùng lại được.** Nếu cách resolve app-data đổi khi chạy dưới artifact, người dùng nội bộ sẽ thấy job/audit/credential "biến mất" — thực ra là một app-data thứ hai. Không có test cho chuyện này thì không ai phát hiện đến khi mất dữ liệu.
- **Giải nén là đường ghi mới, và nó ghi vào chỗ có SQLite đang mở.** Đua giữa hai tiến trình lần chạy đầu, marker ghi trước khi xong, antivirus giữ file trên Windows, rename qua thiết bị khác — bốn cách fail đã biết. R5.3/R5.6 là hai luật chặn.
- **Máy phát triển che mất lỗi Chromium.** Trên máy có Chrome hệ thống, `browser path` trả `/Applications/Google Chrome.app` và mọi thứ xanh; chỉ khi `HOME` sạch và không có Chrome hệ thống mới lộ ra là artifact phải tải 94,5 MB (S5, §1.9b). Đây là **PASS giả** cùng loại với "máy sạch không kiểm được trên máy phát triển", nhưng ở một thành phần cụ thể đã biết tên.
- **Không có đường override nguồn tải Chromium.** `PUPPETEER_DOWNLOAD_BASE_URL` và `CHROME_DOWNLOAD_BASE_URL` đều bị lờ (§1.9b). Nghĩa là artifact mang một **phụ thuộc cứng vào việc với tới server của Google** ở lần chạy đầu, và không có mirror nội bộ nào cắm vào được. Nếu sau này cần bán cho môi trường air-gapped thì đường duy nhất là VidCom tự seed cache — làm được vì layout tất định, nhưng là việc chưa ai tính.
- **`doctor` dễ trở thành nơi rò secret.** Nó tồn tại để in ra trạng thái cấu hình, và cấu hình chứa API key. R3.10 phải có test, không phải chỉ có ý định.
- **Ước lượng 3–4 tuần của build-order là con số cũ.** Nó được viết khi Giai đoạn 4 còn được hiểu là "bundle những gì đã chạy được", trước khi 4.1–4.3 chuyển lên 3.12 và trước khi lộ ra rằng R2 và R6 là subsystem mới. Ước lượng lại sau spike Phase 4 và vòng duyệt là **~170 SP / 7–8 tuần**, và nên coi là sàn: mỗi bản đọc code kỹ hơn lại tìm thêm việc, chưa bản nào tìm ra ít đi.
- **~~TTS là lời hứa chưa có đường thực hiện.~~ ĐÃ ĐÓNG bằng S3** — nhưng đường đó **nặng**, và rủi ro chuyển sang chỗ khác. Bản 1–2 nói "sidecar VieNeu là một archive" trong khi archive đó chỉ có `worker.py` + `requirements.txt`; giờ nó là **một CPython đóng băng cộng cả stack** (R5.1). Ba rủi ro mới đi kèm: (1) danh sách package không pin thì artifact phình 95 MB mà không ai để ý (R5.14); (2) weights 1,6 GB tải ở lần chạy đầu biến "chạy trên máy chưa cài gì" thành "chạy trên máy chưa cài gì **nhưng có mạng**"; (3) upstream `vieneu` đổi API hoặc đổi tập dependency thì stack đã pin vỡ, và không có compile step nào bắt được.
- **Boot khi chưa có workspace là thay đổi lifecycle, không phải thêm route.** Hôm nay không tồn tại trạng thái "chưa có workspace": `resolveWorkspace` luôn resolve, tệ nhất là im lặng nhận `cwd` (§1.5d), và `startVidcomFoundation` lấy lease **trong** startup sequence trước khi listener mở. R1.11 yêu cầu điều ngược lại. → **OQ-10**, và nó đội chi phí R1.
- **Đổi workspace lúc runtime là rebuild foundation.** `workspaceRoot` bị nướng vào `createInfrastructure`, `leaseId` bị nướng vào `createApplication`; watcher/scheduler/journal bám theo. Cộng với job đang chạy trên workspace cũ (R1.18), đây là composite mutation có tiến trình con đang sống — chỗ dễ để lại process mồ côi ghi vào workspace vừa nhả lease.
- **Bridge có thể nối vào đúng port nhưng sai tiến trình.** Endpoint record stale + port động bị tiến trình khác chiếm = mutation của workspace này gửi vào một app lạ. `hostCheck` khoá theo `127.0.0.1:<port>` nên nó **không** phát hiện được chuyện đó. → R2.13, và nó là correctness chứ không phải hardening.
- **Hai daemon cùng sống là kịch bản có thật.** R2.12 cho phép takeover sau TTL, nhưng daemon mất lease hôm nay vẫn giữ listener mở (§1.4). → R2.14.
- **Migration là race chưa được bảo vệ.** Một lần boot migrate tới **ba** lần, tất cả **trước** khi có lease; hai tiến trình cold-start đồng thời (kịch bản R5.6) migrate song song. §3 bản 1 chỉ chặn race của giải nén. → R5.13.
- **`output: 'export'` đổi luôn threat surface của dev.** Dev thành cross-origin, nên phải thêm origin vào danh sách cho phép — và đúng thứ đó MUST NOT có mặt trong artifact (R4.12). Đây là kiểu rủi ro "nới perimeter cho tiện" mà §2 đã cảnh báo cho R1, giờ áp cho R4.

---

## 7. Open Questions — đã đóng hết

**Còn mở: 0. Đã đóng: 13.** OQ-5/OQ-6 đóng bằng quyết định sản phẩm (§1.6) và S2 (§1.7c); OQ-2/3/10/13 đóng bằng **số đo** ở vòng spike thứ hai (§1.9); OQ-11/12 đóng bằng số đo cộng một quyết định sản phẩm; OQ-1/4/7/8/9 đóng bằng lý lẽ kiến trúc — chúng không phải câu hỏi feasibility nên không spike được, và §8 ghi rõ cái nào thuộc loại nào.

| # | Câu hỏi | Đề xuất |
|---|---|---|
| **OQ-1** | ~~`vidcom mcp` khi chưa có daemon: tự khởi động, hay từ chối?~~ | **ĐÃ ĐÓNG — tự khởi động daemon headless.** Không spike được (là quyết định UX), nhưng lý lẽ dứt khoát: AI host spawn subprocess và **không có nơi nào hiển thị hướng dẫn cho người dùng đọc**, nên "từ chối kèm hướng dẫn" nghĩa là agent chết ở tool call đầu mà người dùng không biết vì sao. Kèm luật: daemon do bridge sinh ra tự dừng khi bridge cuối cùng ngắt, qua **refcount liên tiến trình có chủ sở hữu là daemon** (không phải bridge — bridge chết đột ngột không được làm rò refcount), và MUST NOT tắt dưới chân UI đang attach → **R2.15** |
| **OQ-2** | ~~Transport IPC: loopback HTTP + bearer, hay Unix socket / named pipe?~~ | **ĐÃ ĐÓNG — loopback HTTP + bearer, và R2.13 là bắt buộc.** S7 đo cả hai (§1.9d): socket **rẻ hơn bản 3 nghĩ** (~5 dòng trên POSIX, dùng lại nguyên Hono app, mode 600) và **xoá hẳn** nguy cơ chiếm port; nhưng nửa Windows của nó **chưa kiểm**, mà OQ-7 nói Windows là nơi mọi thứ vỡ. Chọn HTTP vì `/api/mcp` + `McpCredentialService` đã có test, và vì R2.13 — thứ cần có dù chọn đường nào — đã đóng đúng lớp rủi ro đó (S7 chứng minh handshake từ chối được tiến trình lạ). **Socket là phương án dự phòng đã đo sẵn**: nếu port discovery trên Windows đau, đổi sang socket không phải viết lại nghiệp vụ |
| **OQ-3** | ~~Chromium: bundle hay tải ở lần chạy đầu?~~ | **ĐÃ ĐÓNG — tải ở lần chạy đầu.** S5 đo (§1.9b): thứ tải về là **Chrome Headless Shell**, **94,5 MB / ~8 s**, thành 196 MB trên đĩa; warm 1,08 s. Bundle nghĩa là +196 MB vào một artifact đang ~300 MB cho một thành phần tải hết 8 giây — không đáng. FFmpeg/FFprobe vẫn **bundle** (nhỏ, mọi đường TTS/render đều cần). Ràng buộc kèm theo: **không có đường override nguồn tải**, nên air-gapped chỉ làm được bằng cách VidCom tự seed cache. Xem **OQ-11** |
| **OQ-4** | ~~`vidcom render` chạy trong tiến trình gọi hay qua daemon?~~ | **ĐÃ ĐÓNG — `vidcom render` là thin client của daemon.** *Lý do của bản 4 nói chưa chính xác và đã sửa*: render "trong tiến trình gọi" **tự nó** không phải đường ghi thứ hai — cái nguy hiểm là CLI **tự dựng foundation/scheduler hoặc tự publish output**, vì lúc đó nó thành **execution authority thứ hai**. Mô hình đúng đã có sẵn trong code: `POST /v1/projects/:id/renders` enqueue rồi trả **202 + jobId**, scheduler chạy bất đồng bộ ([`delivery-loop.ts:169`](../../../../packages/server/src/routes/delivery-loop.ts#L169)). → **R3.3** |
| **OQ-5** | ~~Repo bỏ Next hẳn, hay giữ `next dev` làm host phát triển?~~ | **ĐÃ ĐÓNG (2026-08-06)**: **giữ Next**, chuyển sang `output: 'export'` làm build tool cho static asset + host dev; artifact không chứa Next ở đường chạy. Kéo theo R4.8, R4.10, R4.11, R4.12 — xem §1.6 |
| **OQ-6** | ~~`/projects/[slug]`: query param, hay SPA fallback từ host SEA?~~ | **ĐÃ ĐÓNG HẲN (2026-08-06)**: cơ chế là static export + gọi API qua **http-driver** với base URL cấu hình được (§1.6); cấu trúc là **sentinel `__shell`** + slug đọc từ `location` + map cả payload RSC, do **S2** chốt bằng build và serve thật (§1.7c) → R4.5, R4.13 |
| **OQ-7** | ~~Phạm vi nền tảng của Giai đoạn 4?~~ | **ĐÃ ĐÓNG — ba artifact native tối thiểu: macOS arm64, Windows x64, Linux x64**; mỗi artifact MUST vượt packaged smoke **trên runner cùng OS**. **Windows x64 là release gate bắt buộc, MUST NOT bị cắt.** IF thiếu velocity THEN **Linux x64 là ứng viên defer đầu tiên** — nhưng đó là một **thay đổi phạm vi có chủ đích**: Giai đoạn 4 khi đó chỉ được tuyên bố hỗ trợ **macOS + Windows**, và MUST NOT tuyên bố đạt mục tiêu ba nền tảng hay packaged smoke đầy đủ. *Bản 4 đưa ra một lý do sai và đã rút*: "Linux gần như trùng macOS" là khẳng định **không có bằng chứng** — toàn bộ spike Phase 4 mới chạy trên `darwin arm64`, và Linux có nhóm rủi ro riêng mà macOS không có: glibc/loader, executable bit, `xdg-open`, dependency chạy được của Chrome Headless Shell, và native binary của CPython/ONNX/esbuild/FFmpeg khác nhau theo distro. CI hôm nay kiểm **source** trên cả ba OS ([`ci.yml`](../../../../.github/workflows/ci.yml)) nhưng **chưa kiểm artifact đã đóng gói** trên OS nào. Ưu tiên Windows đứng vững vì nó là nơi ACL/`rename`/khoá file/kill-tree vỡ; Linux **chưa được chứng minh là rẻ**, chỉ là chưa được ưu tiên |
| **OQ-8** | ~~Có kéo 5.0 (nút `New video`) vào Giai đoạn 4 không?~~ | **ĐÃ ĐÓNG — có, và giới hạn diễn đạt theo *capability*, không theo URL.** Giai đoạn 4 chỉ **nối UI vào use case tạo project đã có**; MUST NOT thêm bất kỳ backend capability mới nào ngoài *tạo project từ preset*. Không kéo theo file/folder CRUD, upload asset, agent generation, hay file explorer. Backend **đã sẵn sàng**: `POST /v1/projects` validate preset, gọi `ProjectLifecycle.create` qua write authority, trả 201 ([`delivery-loop.ts:147`](../../../../packages/server/src/routes/delivery-loop.ts#L147)). Nút bị disable chỉ vì một comment **đã lỗi thời** nói backend chưa nối ([`new-project-card.tsx`](../../../../src/components/home/new-project-card.tsx)). → **R1.19** |
| **OQ-9** | ~~Mode `worker` (PK-5) có thuộc Giai đoạn 4 không?~~ | **ĐÃ ĐÓNG — không.** Job hôm nay chạy trong daemon và đã có supervision; một mode `worker` tách rời là **đường điều phối job thứ hai**, cùng loại rủi ro với đường ghi thứ hai của OQ-4. Bỏ khỏi phạm vi Giai đoạn 4 và ghi lý do vào build-order (deliverable ở §8) |
| **OQ-10** | ~~Boot khi chưa chọn workspace: listener trước, hay giữ hiện trạng?~~ | **ĐÃ ĐÓNG — listener mở trước, foundation dựng sau, và nó RẺ.** S6 chạy với `createServerApp` thật (§1.9c): phase 1 route foundation trả **404** dù session hợp lệ, phase 2 sau khi thay app trả **200** trên **cùng cổng, listener chưa từng đóng**, session cũ dùng nguyên. Cơ chế = **một biến `currentApp` đổi được + gọi `createServerApp` lần hai**; hàm đó chỉ đăng ký route, không I/O. Phần đắt của R1 không nằm ở đây mà ở `startVidcomFoundation` — việc R1.12 cần dù có OQ-10 hay không, nên **làm một lần dùng cho cả hai**. Xem **R1.17** |
| **OQ-11** | ~~Thành phần tải-ở-lần-chạy-đầu trong job smoke: bắt buộc hay tuỳ chọn?~~ | **ĐÃ ĐÓNG — bắt buộc + cache trên runner, cho cả hai thành phần.** R8.3 yêu cầu render ra MP4 thật **và** một dòng TTS ra WAV thật; smoke không làm được hai việc đó thì không chứng minh mốc. S5 cho đường dẫn cụ thể để cache: **`$HOME/.cache/hyperframes/chrome`** (Chromium) và **`HF_HOME`** (weights) — cả hai theo `HOME`, mà R8.2 lại bắt `HOME` sạch, nên nếu không cache thì mỗi lần chạy kéo lại ~1,7 GB. Cache key theo version thành phần, cộng **một bước chạy offline sau lần đầu** để kiểm R6.5. Xem **R3.12**, **R8.8** |
| **OQ-12** | ~~Ngân sách tải về?~~ | **ĐÃ ĐÓNG — artifact ~300 MB; weights và Chromium tải theo yêu cầu.** Biên giới: thứ **không thể lấy sau** thì ship (interpreter Python — không có Python thì không bootstrap được), thứ **lấy được** thì tải (weights 1,6 GB, Chrome Headless Shell 94,5 MB/8 s theo S5). Kéo theo hai việc: mốc phát biểu lại thành "**chưa cài gì, có mạng ở lần chạy đầu**" và commitment ở main spec sửa theo; và **R5.14 prune là bắt buộc** — 297 MB trên đĩa / 95 MB tải về là chênh lệch giữa giữ và không giữ lời hứa "một file" |
| **OQ-13** | ~~Hình dạng spawn của R6.2: shim hay sidecar?~~ | **ĐÃ ĐÓNG — shim.** Bản 3 chọn sidecar vì cho rằng shim làm cha/con cùng `execPath` nên kill-tree dễ sai. **S4 bác bỏ** (§1.9a): supervisor nhận diện bằng `(pid, startedAt)` + process group, không hề dùng `execPath`; huỷ render giữa chừng cho **0 tiến trình sống sót ở cả hai** hình dạng. Và giá sidecar cũng bị ghi sai — Node là **35,9 MB nén**, không phải ~110 MB. Còn lại: shim tốn **0 MB** và +43 ms mỗi lần spawn; sidecar tốn 36 MB. Chọn shim; việc cần làm là **test huỷ-giữa-chừng** (R6.8), không phải sửa cơ chế |

---

## 8. Approval Gate

> **Trạng thái: APPROVED — chuyển sang Design.** (Người dùng duyệt ngày 2026-08-07.)
>
> Spike gate đã mở và 13/13 OQ đã đóng. Vòng duyệt đầu bác **hai lý do**; bản sửa dưới đây đã được người dùng duyệt lại, gồm thay đổi cam kết phát hành của OQ-7:
>
> | | Bản 4 viết | Vòng duyệt bác | Đã sửa thành |
> |---|---|---|---|
> | **OQ-7** | "Linux gần như trùng macOS", cắt Linux trước | Khẳng định **không có bằng chứng** — spike mới chạy trên `darwin arm64`. Và câu tự mâu thuẫn: cam kết ba nền tảng rồi lại cho cắt một, trong khi R8 là MUST NOT cắt | Ba artifact target; **Windows là release gate**; defer Linux là **thay đổi phạm vi có chủ đích**, và khi đó MUST NOT tuyên bố đạt ba nền tảng (R8.5) |
> | **OQ-4** | "render trong tiến trình gọi = đường ghi thứ hai" | Sai nhân quả: vấn đề không phải *chạy ở đâu* mà là CLI **tự dựng foundation/scheduler hoặc tự publish** ⇒ **execution authority thứ hai** | Invariant thin-client ở **R3.3**, kèm bốn thứ Design phải chốt |
>
> **OQ-8** được duyệt với cách diễn đạt giới hạn theo **capability**, không theo URL → **R1.19**.
>
> Ba OQ này là loại "đóng bằng lý lẽ kiến trúc" mà §8 mục 2 đã nói là loại **duy nhất tranh luận được** — và vòng duyệt đã dùng đúng chỗ đó.

Đã xác nhận bốn thứ:

1. **Phạm vi** R1–R9 và các mục **ngoài phạm vi** ở §2.
2. **Cách các OQ được đóng** (§7). Chúng không cùng một loại, và §7 ghi rõ loại nào là loại nào:
   - *Đóng bằng số đo* — OQ-2, 3, 10, 11, 12, 13 (và OQ-6 phần cấu trúc). Nếu không đồng ý, cách phản bác là **chạy lại spike**, không phải tranh luận.
   - *Đóng bằng lý lẽ kiến trúc* — OQ-1, 4, 7, 8, 9. Chúng không phải câu hỏi feasibility nên không spike được; đây là chỗ ý kiến của anh **thay đổi được** quyết định.
   - *Đóng bằng quyết định sản phẩm* — OQ-5, và phần "chấp nhận ngân sách" của OQ-12.
3. **Ước lượng ~170 SP / 7–8 tuần** — hoặc yêu cầu cắt theo thang cắt ở main spec. Vòng spike thứ hai làm **hai** hạng mục rẻ đi (OQ-10 chỉ là một biến đổi được; OQ-13 chọn shim nên R5 không phải mang thêm Node runtime) nhưng **không** hạ con số: phần đắt của R1 là tách `startVidcomFoundation`, thứ R1.12 cần dù có OQ-10 hay không, và R2 vẫn phải làm handshake mà S7 vừa chứng minh là correctness. Vòng duyệt 2026-08-07 cộng **5 SP vào R1** (21→26) vì OQ-8 hứa chi phí đó từ bản 2 mà **chưa bao giờ vào bảng SP** — R1.19 giờ ghi nó ra. Giữ ~170 làm **sàn**.
4. ~~Hai bug Phase 3 ở §1.8 đi đâu~~ — **đã quyết và đã sửa** (2026-08-07, §1.8): sửa ngay, trước Giai đoạn 4, vì R3.5 và R8.3 dựa vào cả hai. Đã verify với engine thật; integration test siết thêm assertion và được chứng minh là **fail trên code trước khi sửa**. Không còn câu hỏi phạm vi nào mở.

**Ba món nợ kiểm chứng — đã chuyển thành todo có chủ, chờ máy Windows** (W-1..W-3, chi tiết ở [main spec §During Spec](./spec-packaging-and-distribution-pending.md)). Không cái nào chặn Design; cả ba nên chạy **cùng lượt** với vòng kiểm Windows đầu tiên, vì Windows cũng là nơi ACL/`rename`/khoá file/kill-tree của R5.9, R7.12, R3.13, R6.8 phải được kiểm.

| # | Chưa kiểm | Chặn requirement | Rủi ro nếu sai |
|---|---|---|---|
| **W-1** | Cookie cross-origin ở chế độ dev — gồm luật `localhost` ≠ `127.0.0.1` | R4.10, R4.12 | Vòng lặp dev frontend mất session; **artifact không ảnh hưởng** |
| **W-2** | Named pipe trên Windows (POSIX socket đã PASS ở S7) | OQ-2 *dự phòng*, R2.5 | Phương án dự phòng đắt hơn dự tính; đường mặc định không ảnh hưởng |
| **W-3** | Chế độ hỏng khi thật sự mất mạng lúc tải Chromium | R6.5, R8.8 | `doctor` báo sai kiểu lỗi hoặc job treo; bước offline của R8.8 bắt được |

Deliverable tài liệu kèm theo khi Goals được duyệt: cập nhật [15-build-order](../../../product-features/15-build-order.md) §Giai đoạn 4 (trỏ tới spec này, ghi quyết định OQ-9 bỏ mode `worker`) và [doc 14 §17](../../../product-features/14-local-first-mcp-packaging-architecture.md) (đóng câu 1, 2, 4 theo OQ-1/2/3).
