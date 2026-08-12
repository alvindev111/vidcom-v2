# Spec Packaging & Distribution Runtime — Detailed Design

> **Reference**: [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) — **Approved 2026-08-07**
> **Main spec**: [Packaging & Distribution Runtime](./spec-packaging-and-distribution-inprocess.md)
> **Next**: Implementation Checklist — **được phép tạo** (gate §15 đã mở)
>
> **Trạng thái**: **APPROVED** ngày 2026-08-07 bởi alvin0 — xem [§15 Approval Gate](#15-approval-gate). Phase tiếp theo là Implementation Checklist; **production code vẫn bị chặn** cho tới khi checklist đó được duyệt riêng.

## 1. Overview

Giai đoạn 4 thay host chạy từ checkout bằng một Node SEA native cho từng nền tảng, nhưng giữ nguyên Hono Application Core, WriteAuthority, job scheduler và MCP Tool Registry đã chạy ở Giai đoạn 1–3. Binary nhúng frontend static export và các archive runtime có manifest/checksum; lần chạy đầu giải nén runtime bắt buộc vào app-data dưới một bootstrap lock. Một daemon giữ lease là execution authority duy nhất: UI gọi HTTP, MCP stdio dùng bridge có xác thực, và `vidcom render` là thin client của cùng daemon.

Design chia startup thành hai tầng: **host không-workspace** mở listener/auth/system UI trước, sau đó **FoundationManager** dựng hoặc thay foundation theo workspace mà không đổi port/session. Packaged smoke được build và chạy native trên macOS arm64, Windows x64 và Linux x64; Windows là release gate. Linux chỉ được defer qua một scope change mới và khi đó release MUST hạ tuyên bố hỗ trợ xuống macOS + Windows.

### 1.1 Links to Requirements

| Requirement | Design element |
|---|---|
| R1.1–R1.19 | Sec 4.3, 5.2–5.4, 7.1–7.7 — browser filesystem cô lập, mutable foundation, UI picker/New video |
| R2.1–R2.15 | Sec 4.4, 5.5–5.7, 6.2, 7.8–7.11 — discovery record, bearer handshake, remote Tool Registry, attachment lease |
| R3.1–R3.13 | Sec 5.8–5.9, 7.12–7.14, 8.1 — CLI mode và doctor |
| R4.1–R4.14 | Sec 4.2, 5.10–5.12, 10.4 — CJS SEA, frontend pack, static shell, http-driver |
| R5.1–R5.14 | Sec 4.5, 5.13–5.15, 6.3–6.4, 10.5 — runtime manifest, extraction, bootstrap ordering |
| R6.1–R6.11 | Sec 4.6, 5.16–5.18, 10.6 — HyperFrames shim, compiler env, TTS/Chromium |
| R7.1–R7.12 | Sec 4.7, 5.19, 6.5, 7.15 — import staging + recovery |
| R8.1–R8.8 | Sec 4.8, 9.1, 11.4 — packaged smoke native theo OS |
| R9.1–R9.7 | Sec 5.20, 9.2–9.4, 10.7 — checksum, source scan, provenance, telemetry |

## 2. Design Scope

### 2.1 In Scope

- Một build pipeline native sinh `vidcom`/`vidcom.exe`, SHA256SUMS và provenance manifest cho đúng OS/arch của runner.
- SEA host Hono trên loopback, frontend static export phục vụ từ asset trong binary, không ghi thư mục `out/` cạnh executable.
- Boot không-workspace, picker qua UI, tạo thư mục, activate/switch workspace trên cùng listener/session.
- Nút New video nối vào create-project use case có sẵn với bundled preset, không có capability editing mới.
- Daemon discovery, bearer credential, handshake, MCP stdio bridge, auto-start race và attachment lifecycle.
- CLI `app`, `serve`, `mcp`, `render`, `doctor`, `version` cộng các lệnh quản trị đã có; không có public `worker` mode.
- Archive runtime theo platform, extraction nguyên tử, manifest/checksum, repair qua doctor.
- HyperFrames CLI shim, esbuild native, FFmpeg/FFprobe, frozen CPython + VieNeu, motion library và Chrome cache.
- Import project ngoài workspace bằng staging/copy/rename có recovery.
- Packaged smoke trên macOS arm64, Windows x64, Linux x64 với PATH/HOME cô lập.

### 2.2 Out of Scope

- Matrix 3 OS × 2 kiến trúc, installer `.dmg`/`.msi`, signing certificate/notarization thật — Giai đoạn 6.
- Tauri/native picker, auto-update, telemetry sản phẩm, crash reporting, license/activation.
- Public `vidcom worker`, worker process tách riêng, nhiều workspace active trong cùng daemon.
- CRUD file/folder, asset upload mới, agent generation trong app, PTY/diff preview.
- Air-gapped first-run cho Chromium/weights; chỉ kiểm warm/offline sau khi cache đã có.
- Sửa version skew HyperFrames; giai đoạn này chỉ cảnh báo.

## 3. Research Summary

### 3.1 Node SEA assets và main format

- **Context**: binary phải chạy không có Node/node_modules và chứa frontend/runtime archives.
- **Key insight**: Node SEA cung cấp `node:sea.getAsset/getRawAsset`, nhưng injected `require()` không resolve package filesystem; ứng dụng phải bundle thành một main script. Node 24 cũng yêu cầu blob được tạo bằng cùng Node binary được inject. Cross-platform code cache/snapshot không portable.
- **Sources**: [Node 24 SEA documentation](https://nodejs.org/download/release/v24.18.0/docs/api/single-executable-applications.html), [`spikes/phase-0`](../../../../spikes/phase-0/README.md), [`spikes/phase-4` S1/S2](../../../../spikes/phase-4/README.md).
- **Impact**: DR-1/DR-2; main bundle CJS, `useCodeCache=false`, `useSnapshot=false`, build native trên runner đích, asset lớn lấy qua `getRawAsset`.

### 3.2 Next static export và dynamic project route

- **Context**: project slug chỉ tồn tại sau khi binary đã build.
- **Key insight**: `output: "export"` sinh file tĩnh; dynamic route cần `generateStaticParams`. Spike S2 chứng minh một sentinel `__shell` dùng được nếu host map cả HTML và payload RSC `.txt`, còn client đọc slug thật từ `location`.
- **Sources**: [Next static export](https://nextjs.org/docs/pages/guides/static-exports), [generateStaticParams](https://nextjs.org/docs/app/api-reference/functions/generate-static-params), [`spikes/phase-4/s2-export`](../../../../spikes/phase-4/s2-export).
- **Impact**: DR-3; server shell/client child, frontend pack và resolver route tường minh.

### 3.3 Hono Node listener

- **Context**: host SEA phải phục vụ Hono, SSE/upload và đóng listener sạch.
- **Key insight**: `@hono/node-server` chạy `app.fetch`, trả Node server handle và hỗ trợ graceful close; `serveStatic` mặc định dựa vào cwd nên không phù hợp asset trong SEA.
- **Source**: [Hono Node.js adapter](https://hono.dev/docs/getting-started/nodejs), S2 host spike.
- **Impact**: DR-4; host dispatch `/api/**` vào mutable Hono app, asset khác qua `SeaStaticAssetHost`, không dùng filesystem `serveStatic`.

### 3.4 Runtime/toolchain spike

- **Context**: `process.execPath` trong SEA là VidCom, esbuild có thể treo, TTS không có Python hệ thống.
- **Key insight**: HyperFrames CLI chạy qua `--vidcom-node` shim; in-process bundle PASS nếu đặt `ESBUILD_BINARY_PATH` và `ESBUILD_WORKER_THREADS=0`; frozen CPython + VieNeu đã prune sinh WAV; supervisor kill-tree không phụ thuộc execPath.
- **Source**: [`spikes/phase-4/README.md`](../../../../spikes/phase-4/README.md) S1a/S1b/S3/S4.
- **Impact**: DR-8/DR-9; extracted CLI nhưng Node host là chính SEA, compiler có timeout bắt buộc, Python nằm trong runtime archive.

### 3.5 Platform evidence boundary

- **Context**: Goals target ba OS nhưng spike Phase 4 mới có darwin arm64.
- **Key insight**: CI hiện kiểm source trên ba OS, không kiểm artifact; native archive và runner phải cùng OS/arch. GitHub runner có image theo OS/arch nhưng mỗi artifact vẫn cần job riêng.
- **Sources**: [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/larger-runners), [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml), spike Phase 4.
- **Impact**: DR-11; không cross-build artifact release trong Giai đoạn 4, không suy kết quả macOS sang Linux/Windows.

## 4. Architecture

### 4.1 System Overview

Binary có một process host và tối đa một active foundation. Host sở hữu listener, bootstrap nonce/session, static frontend, system routes và `FoundationManager`. Foundation sở hữu workspace-specific SQLite adapters, lease, WriteAuthority, scheduler, watcher và Hono routes. Việc đổi workspace thay foundation object dưới một mutex; listener và session stores không đổi.

MCP stdio bridge không dựng foundation. Nó đọc discovery record + bearer trong app-data, handshake đúng workspace/instance, dựng MCP server từ **cùng ToolDefinition registry** nhưng dùng `RemoteToolInvoker`; daemon mới chạy use case/audit. CLI render dùng cùng `DaemonClient`, enqueue job rồi wait hoặc detach theo contract ở Sec 7.13.

### 4.2 Component Diagram

```mermaid
flowchart LR
    Browser[Browser UI] -->|HTTP + cookie + SSE| Host
    AI[Codex / Claude] -->|MCP stdio| Bridge
    RenderCli[vidcom render] -->|daemon client| Discovery
    Bridge -->|bearer + handshake + allowlisted tool calls| Host
    Discovery[DaemonDiscoveryStore] -->|endpoint record| Host

    subgraph SEA[vidcom Node SEA]
      Host[LoopbackHost + StaticAssetHost]
      FM[FoundationManager]
      App[Hono app currentApp]
      Assets[SeaAssetSource]
      Runtime[RuntimeAssetManager]
      Host --> FM
      Host --> App
      Assets --> Host
      Assets --> Runtime
    end

    FM --> Core[Application Core]
    Core --> WA[WriteAuthority]
    Core --> Jobs[JobScheduler]
    Core --> Watch[WorkspaceWatcher]
    WA --> Workspace[(Workspace filesystem)]
    WA --> DB[(app-data vidcom.sqlite)]
    Jobs --> Toolchain[HyperFrames / FFmpeg / VieNeu]
    Runtime --> Native[(app-data native + models/cache)]
```

### 4.3 Boot, select và switch workspace

```mermaid
sequenceDiagram
    participant CLI as vidcom app/serve
    participant BC as BootstrapCoordinator
    participant Host as LoopbackHost
    participant UI as Browser
    participant FM as FoundationManager
    participant DB as SQLite + lease

    CLI->>BC: ensure runtime + migrate once
    BC->>Host: open 127.0.0.1:dynamic
    Host->>Host: currentApp = bootstrap app
    CLI->>UI: /?t=one-time-nonce
    UI->>Host: POST /api/v1/auth/exchange
    UI->>Host: browse/select workspace
    Host->>FM: activate(canonical workspace)
    FM->>DB: acquire workspace lease
    FM->>FM: reconcile → recovery → backfill → scheduler → watcher
    FM->>Host: atomic swap currentApp
    Host-->>UI: workspace active + projects
```

Switch workspace là state transition có rollback, không phải route mutation:

```mermaid
stateDiagram-v2
    [*] --> NoWorkspace
    NoWorkspace --> Starting: activate
    Starting --> Active: foundation ready + app swap
    Starting --> NoWorkspace: startup failed
    Active --> Switching: activate another workspace
    Switching --> Active: new foundation ready
    Switching --> RecoveringOld: new startup failed
    RecoveringOld --> Active: old foundation restored
    RecoveringOld --> NoWorkspace: restore failed
    Active --> LeaseLost: renew false/error
    LeaseLost --> Reacquiring: drop record + reject writes
    Reacquiring --> Active: lease regained
    Reacquiring --> NoWorkspace: failed, UI attached
    Reacquiring --> Stopped: failed, headless
    Active --> Stopped: shutdown
```

Luật switch:

1. `FoundationManager` serialize activate/switch bằng một mutex.
2. Validate/canonicalize target trước khi đụng foundation cũ.
3. Nếu có job non-terminal ở workspace cũ, trả `workspace_busy` và không đổi; Giai đoạn 4 không mặc định huỷ job.
4. Đưa host vào `switching`: system/auth routes còn dùng được; project mutation trả `503 workspace_switching`.
5. Stop scheduler/watcher, xoá discovery record cũ, release lease, đóng DB cũ.
6. Dựng foundation mới tới trạng thái ready rồi swap `currentApp` một lần.
7. Nếu bước 6 fail, thử dựng lại workspace cũ. Nếu rollback cũng fail, về `NoWorkspace`; listener/session vẫn sống để UI sửa.
8. Chỉ sau swap thành công mới ghi `active_workspace` và phát `workspace.changed`.

**Mất lease — ba lối, và lối nào áp cho ai.** R2.14 được **sửa ngày 2026-08-07** (người dùng duyệt) để có lối thứ ba; Design dùng cả ba:

1. `renew` fail ⇒ vào `Reacquiring`, **không** đóng gì ngay. Mọi đường ghi trả `workspace_lease_lost` từ giây đầu (WriteAuthority đã kiểm lease hai đầu mutex — §5.3), scheduler/watcher dừng, discovery record bị xoá **ngay** để không client mới nào nối vào.
2. Thử lấy lại lease **tối đa 2 lần trong một cửa sổ bằng TTL của lease (30 s)**. Nguyên nhân thường gặp nhất là máy vừa ngủ dậy hoặc SQLite bận nhất thời, và trong hai trường hợp đó lease chưa bị ai cướp.
3. Lấy lại được ⇒ về `Active`, publish lại discovery record với **`instanceId` cũ** (vẫn là tiến trình đó), phát `workspace.reattached`.
4. Không lấy lại được thì **rẽ theo việc có UI hay không**:
   - **Có UI attach** (`vidcom app`, hoặc bất kỳ daemon nào từng nhận attachment `kind: "ui"` — cùng cờ với luật `autoStarted` ở §4.4) ⇒ `NoWorkspace`. Foundation bị `stop()` hẳn, `currentApp` quay lại **bootstrap app**, listener và session sống tiếp. UI nhận `workspace.lease_lost` rồi vào màn chọn workspace với lý do hiển thị được.
   - **Headless** (`serve`, `serve --ensure`, không có UI attachment) ⇒ `Stopped`: đóng listener, thoát khác 0. Không có ai đọc màn hình, và một listener không workspace chỉ là xác chết cho bridge/render vấp phải.
5. Ở cả hai nhánh, host SHALL phát `workspace.lease_lost` **trước** khi đổi trạng thái, để UI đang mở không thấy kết nối chết không lý do.

**Vì sao `NoWorkspace` không tái sinh đúng cái bug R2.14 sinh ra để giết.** Bug đó là *listener mở* **và** *foundation còn sống* **và** *bridge vẫn ghi được* ([`next-host.ts:117`](../../../../packages/cli/src/next-host.ts#L117)). Lối `NoWorkspace` gỡ hai vế sau, bằng ba cơ chế đã có sẵn trong Design chứ không phải cơ chế mới:

| Vế của bug | Vì sao không còn |
|---|---|
| Foundation còn sống | `FoundationManager.stop()` chạy hẳn: không WriteAuthority, không scheduler, không watcher, không handle DB của workspace đó |
| Bridge tìm thấy daemon | Discovery record đã bị xoá **từ bước 1**, trước cả khi re-acquire bắt đầu |
| Bridge gọi được tool | Bootstrap app **không đăng ký** `/api/bridge/**`; nó chỉ có `/v1/auth/*`, `/v1/system/*`, `/v1/health` (§4.5). Route không tồn tại, không phải route trả lỗi |

Đây là **nghĩa vụ chứng minh bằng test**, không phải bằng lập luận — xem §11.3.

### 4.4 Daemon discovery, bridge và render CLI

```mermaid
sequenceDiagram
    participant Host as AI host / CLI
    participant Client as BridgeClient
    participant Store as DiscoveryStore
    participant Daemon as VidCom daemon
    participant Tools as Tool Registry/Core

    Host->>Client: spawn vidcom mcp / render
    Client->>Store: read record by workspace hash
    alt no valid daemon
      Client->>Daemon: spawn vidcom serve --ensure --workspace
      Daemon->>Store: publish record only after listener+lease ready
      Client->>Store: wait bounded for record
    end
    Client->>Daemon: POST bridge/handshake bearer
    Daemon-->>Client: canonicalRoot + instanceId + protocol set
    Client->>Daemon: attach (TTL lease)
    Client->>Daemon: allowlisted tool/render calls
    Daemon->>Tools: invoke same definition/use case
    Tools-->>Client: same Result/error/audit
```

Discovery record không chứa secret và không phải authority:

```json
{
  "schemaVersion": 1,
  "workspaceRoot": "/canonical/workspace",
  "workspaceHash": "sha256:...",
  "instanceId": "daemon_...",
  "pid": 1234,
  "host": "127.0.0.1",
  "port": 43127,
  "startedAt": "2026-08-07T00:00:00.000Z"
}
```

- Path: `<app-data>/daemon/<workspaceHash>.json`, atomic rename, `0600`/current-user ACL.
- Clear bearer giữ riêng ở `<app-data>/credentials`; SQLite chỉ giữ hash/lifecycle như hiện tại.
- Record chỉ được publish sau runtime/migration/lease/listener/handshake route ready; xoá trước khi release lease.
- Handshake MUST so canonical root và instance id từ record. PID/port sống không đủ.
- Attachment là lease trong memory của daemon `{attachmentId, kind: bridge|ui|render, expiresAt}`. Client heartbeat; mất heartbeat tự trừ. Đây là refcount daemon-owned, không nằm trong bridge. **Attachment chỉ đo client còn sống**, không đo công việc còn chạy.
- **Work hold tách khỏi attachment.** Daemon giữ thêm một `activeWorkHold` suy **trực tiếp từ job store**: có job non-terminal thuộc workspace này ⇒ hold còn. Nó **không** phải attachment, không cần heartbeat, và không biến mất khi client thoát.
  Đây là chỗ bản trước tự mâu thuẫn: `--detach` cho CLI thoát ngay (§7.13), mà attachment lại hết hạn khi mất heartbeat — nên nếu chỉ đếm attachment thì daemon tự tắt **giữa lúc render**. Suy hold từ job store là cách duy nhất đúng mà không bắt một tiến trình đã thoát phải tiếp tục heartbeat.
- **Điều kiện auto-shutdown = cả hai đều rỗng**: không còn attachment nào **và** `activeWorkHold` rỗng **và** daemon thuộc loại auto-start **và** đã qua grace period. UI attach luôn thắng auto-shutdown.

**Vòng đời bearer — ai mint, lúc nào, hỏng thì sao.** Kịch bản của R2.4 là máy sạch, daemon chưa từng chạy, AI host spawn `vidcom mcp` **trước tiên** — nên "bearer nằm ở app-data" chưa đủ để implement:

1. **Mint trong `BootstrapCoordinator.prepare()`**, sau migration và **trước** khi lấy lease. Nó dùng đúng credential service đang có (SQLite giữ hash + lifecycle), thêm một credential `kind: "bridge"` do hệ thống phát hành.
   **Chỗ ghi đã tồn tại — MUST dùng lại, MUST NOT tạo đường mới.** [`BridgeCredentialStore`](../../../../packages/adapter/src/fs/credential-store.ts#L86) của Phase 3 ghi clear token vào **`<app-data>/credentials`** (một *file*, không phải thư mục), bằng temp + `secureCredentialFile` + `writeFile` + `fsync` + `rename` — tức là ACL được siết **trước** khi có byte credential nào quan sát được, và trên Windows nó dùng `icacls /inheritance:r /grant:r <SID>:(R,W)` với SID của chính user ([`credential-store.ts:21-45`](../../../../packages/adapter/src/fs/credential-store.ts#L21)). Doc comment của class ghi thẳng "Stores the **future** MCP bridge credential" — nó được viết sẵn cho đúng giai đoạn này.
   Đường dẫn đó cũng là thứ [steering 09 §2](../../../steering/09-security.md) khoá: *"Token IPC cho MCP bridge lưu tại `<app-data>/credentials`, quyền `0600`"*. Một bản nháp trước của mục này viết `<app-data>/credentials/bridge.json`; nó vừa nghịch steering vừa nghịch code — `credentials` không thể vừa là file vừa là thư mục. Việc thật của Giai đoạn 4 ở đây là **nối dây và định nghĩa vòng đời**, không phải viết store mới.
2. **Bearer thuộc về app-data, không thuộc về process.** Đã có credential `bridge` hợp lệ thì boot sau dùng lại; daemon restart **không** làm bridge đang chạy mất quyền.
3. **Thứ tự bắt buộc**: mint/load bearer → lease → listener → **publish discovery record**. Record chỉ xuất hiện khi bearer đã sẵn sàng, nên client thấy record là chắc chắn đọc được credential — không có cửa sổ đọc hụt.
4. **Client đọc theo thứ tự ngược lại**: record trước, credential sau. Thiếu credential ⇒ `bridge_credential_unavailable` kèm hướng dẫn chạy `vidcom doctor --repair`; MUST NOT tự mint (bridge không phải authority, và mint từ hai phía sinh hai token).
5. **Handshake trả 401**: client đọc lại credential file **đúng một lần** (bắt trường hợp vừa xoay giữa chừng) rồi thử lại; vẫn 401 ⇒ `bridge_credential_invalid`, dừng. MUST NOT retry vòng lặp — 401 lặp lại nghĩa là app-data đã lệch, không phải nghẽn tạm thời.

**Xoay bearer — bốn thứ phải chốt, vì cơ chế đang có không tự trả lời được.** `McpCredentialService.rotate(id, overlapMs)` nhận **id** ([`mcp-credential-service.ts:78`](../../../../packages/core/src/service/mcp-credential-service.ts#L78)), trong khi `BridgeCredentialStore` chỉ lưu **token trần** — không id — và cột `label` **không unique**. Nên "xoay credential của bridge" hôm nay không có cách nào chỉ ra *xoay cái nào*. Bốn quyết định:

| # | Câu hỏi | Chốt |
|---|---|---|
| 1 | Nhận diện credential hệ thống bằng gì | **`app_settings.bridge_credential_id`** — bảng đã có, không thêm bảng (DR-10), không cần unique index trên `label`. Label `system:bridge` chỉ để `credential list` đọc được, **không** phải danh tính |
| 2 | Overlap có bằng 0 không | **Không — 60 s** |
| 3 | Thứ tự cập nhật | DB rotate → **ghi file atomic** → cập nhật `app_settings` → revoke attachment |
| 4 | Revoke attachment lúc nào | Bước cuối, **và** attach/renew kiểm `credentialId === app_settings.bridge_credential_id` |

**Vì sao overlap không bằng 0.** Với overlap 0, transaction rotate làm token cũ hết hiệu lực **ngay khi commit**, nhưng file vẫn đang giữ token cũ cho tới khi `rename` xong. Trong cửa sổ đó mọi bridge nhận 401, dùng hết **một lần đọc lại** được phép của luật 5, đọc trúng token cũ, rồi chết bằng `bridge_credential_invalid`. Cửa sổ tính bằng mili-giây nhưng hậu quả là hỏng thật. 60 s đủ để nuốt trọn bước ghi file và một nhịp heartbeat, đủ ngắn để một token nghi lộ không sống lâu. Overlap mặc định 5 phút của `DEFAULT_MCP_RUNTIME_CONFIG` giữ nguyên cho credential do người dùng phát hành; chỉ credential bridge dùng 60 s.

**Răng của "xoay thì attachment chết" nằm ở bước 4, không nằm ở overlap.** Trong 60 s đó token cũ vẫn **xác thực** được — đó là chủ đích, để lời gọi đang bay không đứt. Nhưng attach/renew SHALL so credential id vừa verify với `app_settings.bridge_credential_id`; lệch ⇒ `bridge_credential_invalid`. Nên token cũ **không giữ được và không tạo được** attachment, buộc client đọc lại file. Hai mục tiêu — không làm đứt việc đang chạy, và xoay là mất quyền — đạt cùng lúc mà không cần overlap 0.

**Hai đường cụt phải chặn tường minh:**

- **`vidcom credential revoke <id-của-bridge>` SHALL bị từ chối**, kèm hướng dẫn dùng `rotate --bridge`. Lý do: clear token **chỉ tồn tại trong file** (DB giữ hash), nên revoke để lại một hệ thống không có credential bridge nào hợp lệ **và không có lệnh nào mint lại** — MCP chết mà không có đường về.
- **`doctor --repair` khi file mất SHALL *xoay*, không phải "khôi phục".** Cũng vì DB chỉ có hash: token cũ không dựng lại được từ đâu cả. Repair mint credential mới, ghi file, cập nhật `app_settings`, và báo rõ là bearer đã đổi để người dùng biết các bridge đang chạy phải nối lại.

**CLI**: thêm `vidcom credential rotate --bridge` như đường tắt — nó tra id từ `app_settings` rồi gọi đúng `rotate(id, 60_000)`. Không thêm hình dạng lệnh mới ngoài cờ đó; parser hôm nay vốn đã từ chối `--overlap-ms <= 0` ([`credential.ts:48`](../../../../packages/cli/src/commands/credential.ts#L48)), nhất quán với quyết định 2. Nếu `app_settings.bridge_credential_id` trống (app-data mới), bootstrap `issue("system:bridge")` rồi ghi id — đó là đường mint lần đầu ở luật 1.

#### Xoay bearer phải crash-safe — bốn bước, ba nguồn, và một bất biến

Ba bước ghi (DB → file → `app_settings`) chạm **ba nguồn không nằm trong cùng một transaction**. Chết giữa chừng thì ba nguồn trỏ ba trạng thái khác nhau, và một trong số đó **làm hỏng MCP vĩnh viễn**: nếu chết sau khi DB commit mà chưa ghi file, clear token của credential thay thế chỉ tồn tại trong bộ nhớ tiến trình vừa chết — DB chỉ giữ hash — nên nó **không bao giờ dùng được**, còn token cũ hết hạn sau 60 s. Không có bước đọc lại thì app-data đó chết hẳn đường bridge.

**Bất biến làm gốc cho mọi recovery**: *token trong file là **secret duy nhất tồn tại**; DB và `app_settings` là **projection** phải được hoà lại theo nó.* Từ đó ra một luật một chiều, dễ phát biểu và dễ test: **file thắng khi token của nó còn dùng được; không dùng được thì mint mới.** MUST NOT có đường hoà ngược lại — DB không thể dựng lại một secret nó chưa từng giữ.

**Khoá.** Mọi đường chạm credential bridge — reconciliation lúc bootstrap, `rotate --bridge`, nhánh credential của `doctor --repair`, và mint lần đầu — SHALL chạy dưới **một khoá duy nhất `<app-data>/credential.lock`**, dùng đúng cơ chế atomic-mkdir + stale probe của §5.15. Không dùng chung `runtime-bootstrap.lock`: giữ khoá bootstrap suốt một lần xoay sẽ chặn cold start của một tiến trình không liên quan. **Thứ tự lấy khoá luôn là `bootstrap → credential`, không bao giờ ngược lại** — bootstrap giữ khoá của nó rồi mới lấy khoá credential, còn `rotate` chỉ lấy khoá credential, nên không có chu trình. Chờ có giới hạn; hết hạn ⇒ `bridge_rotation_in_progress`.

Khoá này là thứ chặn hai `rotate --bridge` song song. Nếu chỉ dựa vào DB thì kẻ thua đã bị `UPDATE … WHERE status = 'active'` loại ([`mcp-credential.ts:75-79`](../../../../packages/adapter/src/db/mcp-credential.ts#L75)) — nhưng nó **không** chặn được reconciliation lúc bootstrap chạy đè lên một lần xoay đang dở, và đó mới là race nguy hiểm.

**Reconciliation lúc bootstrap** — chạy sau migration, trước khi lấy lease, dưới khoá credential. Gọi `F` = token trong file, `S` = `app_settings.bridge_credential_id`:

| Trạng thái đọc được | Nghĩa là | Xử lý |
|---|---|---|
| `hash(F)` khớp một row **`active`** có `id == S` | nhất quán | không làm gì |
| `hash(F)` khớp một row **`active`** có `id != S` | chết **sau khi ghi file, trước khi cập nhật settings** | **roll forward**: đặt `S` = id đó |
| `hash(F)` khớp một row **`rotating` còn hạn**, và có row `active` với `rotated_from` = id đó | chết **sau DB commit, trước khi ghi file** — replacement mồ côi, secret đã mất | revoke replacement mồ côi, rồi **xoay lại** từ credential trong file theo đúng bốn bước |
| `hash(F)` khớp một row `rotating` **đã hết hạn**, hoặc không khớp row nào, hoặc **file không tồn tại** | quá 60 s mới khởi động lại, hoặc file bị xoá | **mint mới** (`issue("system:bridge")`), ghi file, đặt `S`; ghi log và `doctor` báo bearer đã đổi |

`rotated_from` là thứ nhận diện replacement mồ côi — nó đã có sẵn trong schema và được `rotate` ghi ([`mcp-credential-service.ts:99`](../../../../packages/core/src/service/mcp-credential-service.ts#L99)), nên không cần cột mới. Sau khi hoà xong, mọi row `active` mang label `system:bridge` mà **không** phải `S` SHALL bị revoke — nếu không, mỗi lần crash để lại một credential `active` vĩnh viễn không ai dùng được, và `credential list` dần thành rác.

**Chết sau bước 3 (cập nhật settings), trước bước 4 (revoke attachment)** không cần recovery: attachment cũ sẽ trượt ở lần `renew` kế tiếp vì luật so `credentialId` với `S`. Nó tự lành.

**Bốn con số và một luật sở hữu — không để implementation tự chọn.** Bản trước viện dẫn "grace period" và "manual owner" ba lần mà không định nghĩa cái nào, nên §11.3 có test cho một thuộc tính chưa tồn tại:

| Tham số | Giá trị | Vì sao |
|---|---:|---|
| Heartbeat của client | **5 s** | đủ thưa để không ồn, đủ dày để 20 s TTL cho 4 nhịp lỡ |
| Attachment TTL | **20 s** | mất 4 nhịp mới coi là chết; ngắn hơn thì mạng chậm làm rụng attachment sống |
| Deadline discovery/handshake/attach | **5 s** | giữ nguyên §9.1 |
| Grace period trước auto-shutdown | **60 s** | AI host đóng rồi mở lại phiên mới trong vài giây là chuyện thường; tắt ngay là bắt trả giá cold start vô ích |

**Luật sở hữu (`autoStarted`)** — daemon tự quyết, không đọc từ file nào:

- Daemon khởi động bằng `serve --ensure` (đường của `DaemonClient.ensure`) có `autoStarted = true`. Chỉ loại này mới đủ điều kiện auto-shutdown.
- `vidcom app` và `vidcom serve` chạy tay có `autoStarted = false` **vĩnh viễn** — người dùng bật thì người dùng tắt.
- Daemon `autoStarted = true` mà **từng** nhận một attachment `kind: "ui"` thì chuyển sang `false` và không quay lại. Đây là cách "UI attach luôn thắng auto-shutdown" được cưỡng chế: nếu chỉ kiểm attachment tại thời điểm hết grace, một lần refresh trang cũng đủ giết daemon giữa hai attachment.
- Thuộc tính này là state trong memory của daemon và **MUST NOT** vào discovery record — record không phải authority (§6.2), và client không cần biết.

### 4.5 Runtime extraction và cold-start ordering

```mermaid
flowchart TD
    Start[Process start] --> Lock[Acquire app-data bootstrap mkdir lock]
    Lock --> Verify[Verify embedded manifest + archive sha256]
    Verify --> Extract[Extract missing archives to same-filesystem temp]
    Extract --> Check[Validate allowlist, modes, package pins]
    Check --> Rename[Rename temp to versioned target]
    Rename --> Marker[Write .ready-sha last + runtime-manifest]
    Marker --> Migrate[Migrate SQLite once]
    Migrate --> Cred[Credential lock: reconcile file/DB/settings, mint if unusable]
    Cred --> Unlock[Release bootstrap lock]
    Unlock --> Lease[Acquire workspace lease if selected]
    Lease --> Reconcile[Recovery/backfill/scheduler/watcher]
    Reconcile --> Listen[Publish active daemon record]
```

**Hai flow startup, không phải một.** R5.13 khoá thứ tự `extract → migrate → lease → listener`; nhưng OQ-10 lại cần listener mở **trước** khi có workspace. Hai thứ đó không mâu thuẫn vì chúng là hai đường khác nhau — và Design phải nói rõ đường nào là đường nào:

| | `vidcom app` / `serve` **chưa có workspace** | `serve --workspace` / daemon auto-start |
|---|---|---|
| Thứ tự | extract → migrate → **listener (bootstrap app)** → *chờ người dùng chọn* → lease → foundation → swap | extract → migrate → **lease** → foundation → listener → publish discovery |
| Listener phục vụ gì trước lease | **chỉ** `/v1/auth/*`, `/v1/system/*`, `/v1/health` | không mở listener trước lease |
| Discovery record | **không publish** khi chưa có foundation | publish **sau** khi lease + handshake route ready |
| Vì sao | không có workspace thì không có lease để lấy; UI cần một cổng để chọn | client (bridge/render) chỉ được thấy daemon khi nó đã là execution authority |

Luật chung cho cả hai: **`extract → migrate` luôn đứng trước mọi thứ khác**, và **discovery record chỉ tồn tại khi daemon đã giữ lease**. Một listener chưa có foundation là hợp lệ cho UI nhưng **MUST NOT** xuất hiện với bridge/render — đó là lý do §7.11 tách `/api/v1/health` khỏi `/api/bridge/v1/ready`.

`BootstrapCoordinator` dùng atomic `mkdir(<app-data>/runtime-bootstrap.lock)` thay vì dựa vào SQLite chưa chắc đã migrate. Owner record chứa pid + process-start fingerprint + timestamp; stale lock chỉ reclaim sau bounded probe. Tất cả extraction và migration của một app-data được serialize. Migration được gọi đúng một lần trong một process boot.

Archive format là deterministic `.tar.gz`; package `tar@7.5.22` đã có trong lockfile được nâng thành dependency trực tiếp của package runtime. Extractor từ chối absolute path, `..`, symlink/hardlink và special file; chỉ regular file/directory trong manifest allowlist. Executable mode được manifest khai báo và áp lại sau extraction; Windows dùng ACL thay POSIX mode.

### 4.6 Render/TTS toolchain từ artifact

```mermaid
flowchart LR
    Job[Render job in daemon] --> Probe[Binary + compiler preflight]
    Probe --> Shim[spawn process.execPath --vidcom-node extracted hyperframes.mjs]
    Shim --> HF[HyperFrames CLI]
    HF --> Chrome[Chrome Headless Shell cache]
    HF --> FF[FFmpeg/FFprobe extracted]
    Job --> InProc[@hyperframes imports bundled in SEA]
    InProc --> Esbuild[ESBUILD_BINARY_PATH + WORKER_THREADS=0]
    TTS[TTS job] --> Py[Frozen CPython + VieNeu worker]
    Py --> Model[HF_HOME model cache]
```

- Hidden `--vidcom-node <script> ...` được dispatch trước public CLI parser, chỉnh `process.argv` rồi dynamic-import **chỉ** script nằm dưới verified `native/hyperframes` root.
- `NodeRenderBinaryProbe` trả command `[process.execPath, "--vidcom-node", cliPath]`, không còn `[process.execPath, cliPath]`.
- Mọi in-process compiler call chạy qua `CompilerGuard` đặt hai env bắt buộc và timeout. `doctor` chạy transform nhỏ qua đúng guard.
- VieNeu command trỏ frozen interpreter tuyệt đối + bundled worker; `HF_HOME` trỏ app-data models; warm offline đặt `HF_HUB_OFFLINE=1`.
- **`PYTHONUTF8=1` và `PYTHONIOENCODING=utf-8` là bắt buộc và phải được *ép*, không phải *mặc định*.** Đo trên Windows ([S9/N-2](../../../../spikes/phase-4/s9-windows-runtime/README.md)): interpreter đóng băng lấy encoding của `stdout` từ **codepage ANSI của hệ thống** — trên máy đo là `cp932` — nên `print()` một ký tự tiếng Việt raise `UnicodeEncodeError` ngay. `locale.getpreferredencoding()` cũng là `cp932`, nghĩa là mọi `open()` không khai `encoding` đọc sai. Với một sản phẩm mà nội dung chính là **tiếng Việt**, đây là hỏng ở đường chính, không phải trường hợp biên; và nó nổ trên mọi máy Windows có locale không UTF-8, không riêng CJK.
  Phase 3 đã chống đúng chỗ — `allowlistedEnvironment` ([`process-environment.ts:19-20`](../../../../packages/adapter/src/runtime/process-environment.ts#L19)) đặt cả hai biến, và `worker.py` khai `encoding="utf-8"` tường minh khi đọc/ghi file. Rủi ro của Giai đoạn 4 là **làm rơi nó trong lúc nối dây lại**: lệnh sidecar đổi từ `python3 worker.py` sang `<frozen>/python.exe worker.py` và đồng thời phải thêm `HF_HOME`, `HF_HUB_OFFLINE`, `SSL_CERT_FILE`… nên rất dễ tự dựng env mới thay vì đi qua helper. Vì vậy: **mọi** child process của Giai đoạn 4 — sidecar VieNeu, shim `--vidcom-node`, FFmpeg, Chromium — SHALL đi qua `allowlistedEnvironment`, và hai biến trên SHALL được **ghi đè vô điều kiện** thay vì `??=`, để một `PYTHONIOENCODING` lạ thừa kế từ shell cha không phá được narration.
- Chrome dùng cache path được quản lý/tường minh, không nhận Chrome hệ thống làm bằng chứng packaged smoke.
- **Shim chèn thêm một tầng tiến trình, nên hai luật của [steering 08 §6.1](../../../steering/08-jobs-and-queue.md) càng phải giữ nguyên**: survivor MUST NOT được suy từ quan hệ cha-con (con bị reparent khi cha chết) và MUST NOT được suy từ thành viên process group (`chrome-headless-shell` **đo được** là tự tách sang group riêng). Cơ chế hiện có ghi group + PID rồi verify nên nó không gãy vì thêm tầng — nhưng **containment vẫn là tầng phòng thủ bắt buộc thứ hai**, không phải dư thừa: mọi job spawn process con chạy trong workdir do hệ thống sở hữu, có marker, để recovery thu hồi thứ lọt qua lỗ đã biết của proof.

### 4.7 Import project

```mermaid
sequenceDiagram
    participant UI
    participant API
    participant Import as ProjectImportService
    participant Journal as workspace_operation
    participant FS as Real filesystem

    UI->>API: source token + target name
    API->>Import: plan/import actor=user
    Import->>FS: canonicalize source/target; reject overlap/symlink/special
    Import->>Journal: begin project_import + staging path
    Import->>FS: copy to temp sibling inside workspace filesystem
    Import->>FS: validate/backfill in staging
    Import->>FS: rename staging → final target (no overwrite)
    Import->>Journal: commit + project/workspace event
    Import-->>API: job terminal {projectId, slug}
```

Contract là **bất đồng bộ**: `POST /api/v1/projects/imports` trả **202 `{jobId}`** ngay (§7.15); `{projectId, slug}` chỉ xuất hiện ở **job result** khi job terminal, UI theo dõi qua job/event như mọi job khác. Sequence ở trên là vòng đời *job*, không phải vòng đời *request*.

Staging là sibling ẩn cùng filesystem (`<workspace>/.<slug>.vidcom-import-<operation>.tmp`) để final rename atomic. Nó có marker operation id; startup recovery hoàn tất hoặc xoá theo `workspace_operation`, không quét/xoá thư mục không có marker. Source chỉ đọc, không follow symlink, không sửa metadata/file gốc.

### 4.8 Build and packaged-smoke flow

```mermaid
flowchart LR
    Matrix{native runner} --> Mac[macOS arm64]
    Matrix --> Win[Windows x64]
    Matrix --> Linux[Linux x64]
    Mac --> Build[build frontend + archives + CJS + SEA]
    Win --> Build
    Linux --> Build
    Build --> Checksum[checksum + provenance + source scan]
    Checksum --> Smoke[clean HOME/PATH packaged smoke same OS]
    Smoke --> Upload[upload artifact + evidence]
```

Không job nào dùng artifact build từ OS khác. `useCodeCache` và `useSnapshot` tắt. Job smoke khôi phục **download cache** Chrome/HF vào HOME sạch nhưng không mồi runtime extraction/app-data.

### 4.9 Integration Points

| System | Direction | Protocol | Purpose |
|---|---|---|---|
| Browser UI | both | HTTP cookie + SSE | picker, project UI, job/event |
| AI host | in/out | MCP stdio | protocol-facing adapter |
| MCP bridge → daemon | both | loopback HTTP bearer | handshake, attach, allowlisted tool invocation |
| HyperFrames CLI | out | supervised child process | browser ensure, snapshot/render |
| Chrome download origin | out | HyperFrames browser ensure | first-run Chrome cache |
| Hugging Face | out | VieNeu/huggingface_hub | first-run model weights |
| Real filesystem | both | Node fs adapters | workspace, import, app-data runtime |
| GitHub Actions | build/test | native runner jobs | artifact proof per OS |

### 4.10 Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | Node 24.9.0 SEA + postject pinned | Phase 0/4 evidence; same toolchain as existing CI |
| HTTP | Hono + `@hono/node-server` | existing D4 boundary, graceful listener |
| UI build | Next 16 `output: "export"` | retain dev host/build tool; no Next in artifact runtime |
| FE API | `@alvin0/http-driver` fetch/SSE paths | one typed service catalog, runtime base URL, AbortController |
| DB | SQLite + Drizzle schema/migrator | existing app-data authority; no second DB |
| Archive | tar 7.5.22 + gzip | spike-proven, preserves modes, already locked |
| Process | existing NodeProcessSupervisor | measured kill-tree protocol |
| Tests | Vitest + real SQLite/fs + browser + artifact shell | match steering/testing and R8 |

## 5. Components and Interfaces

### 5.0 Component nằm ở package nào — và vì sao

[steering 02 §2](../../../steering/02-project-layout.md) **enforce import boundary bằng lint**, nên "component này thuộc package nào" không phải chi tiết triển khai: chọn sai thì build đỏ, và cách sửa sai lầm nhất là nới lint. Bảng này là một phần của Design.

| Component | Package | Vì sao ở đó |
|---|---|---|
| `BootstrapCoordinator`, `FoundationManager`, `LoopbackHost`, `SeaStaticAssetHost` | `cli` | Composition root. Chúng dựng infrastructure + application và sở hữu lock/listener cấp tiến trình — đúng việc của entrypoint, và `server` chỉ được export một Hono app |
| `SeaAssetSource`, `RuntimeAssetManager`, `CompilerGuard`, `BrowseTokenStore` | `adapter/runtime` (`CompilerGuard` → `adapter/hyperframes`) | Hiện thực port; chạm filesystem, process, env |
| `DaemonDiscoveryStore` | `adapter/fs` | File atomic + ACL, cùng họ với `credential-store.ts` |
| `DaemonClient` / `BridgeClient` | **`adapter/daemon`** (thư mục mới trong `@vidcom/adapter`, không phải package npm mới) | Hiện thực IPC: chạm `node:http`, filesystem discovery record, env. Người dùng là `cli` — cả `render` lẫn composition root của bridge. **`mcp` MUST NOT import nó**, xem hệ quả 4 |
| Route `/api/bridge/v1/*` | `server/routes` | Chúng là route Hono phía daemon |
| **Interface** `ToolInvoker` | `mcp` (`registry/types.ts`) | Registry ở lại `mcp` và chỉ biết interface. Đây là chỗ duy nhất `mcp` nói về việc "gọi tool ở đâu đó" |
| **Hiện thực** remote `ToolInvoker` | `cli` | `cli` là package duy nhất được phép nhìn thấy **cả** `mcp` lẫn `adapter` ([`cli/package.json`](../../../../packages/cli/package.json) khai đủ 7 workspace dep), và [`createMcpRegistry`](../../../../packages/cli/src/composition-root.ts) đã sống ở đây rồi |
| `FilesystemBrowserService` (chính sách), `ProjectImportService`, `DoctorService` (tổng hợp + phân loại + exit code) | `core` (`usecase`/`service`) + port | Đây là **quyết định nghiệp vụ**: luật token, giới hạn phân trang, canonicalize, phân loại bắt buộc/tuỳ chọn. Adapter dịch, không quyết ([steering 03 §2.4](../../../steering/03-architecture-ddd.md)) |
| Truy cập `node:fs` cho browse/import/doctor | `adapter/fs` | `core` **bị cấm** import `node:fs` trực tiếp |
| Mọi DTO/schema mới | `contracts` | Một shape một nguồn; HTTP và bridge cùng dùng |

**Bốn hệ quả bắt buộc, không phải khuyến nghị:**

1. **`server` MUST NOT import `packages/mcp`.** §5.7 nói endpoint `/api/bridge/v1/tools/:name` validate bằng `ToolDefinition` — nhưng registry nằm ở `packages/mcp`, mà lint cấm `server` import `mcp`. Giải: **schema của tool nằm ở `contracts`** (đúng vai trò steering 02 §1 giao cho package đó: *"HTTP DTO, **MCP tool schema**, error code"*); route bên `server` validate bằng schema từ `contracts` và **thực thi qua một invoker do composition root inject**.

   **Đính chính so với bản 2** (kiểm ngày 2026-08-07 trên code thật): phần "chuyển schema" **đã xong từ trước Giai đoạn 4**. [`packages/mcp/src/registry/schemas.ts`](../../../../packages/mcp/src/registry/schemas.ts) chỉ `export * from "@vidcom/contracts"`, các file `*-tools.ts` import `…InputSchema`/`…OutputSchema` trực tiếp từ `contracts`, và **không có một `z.object` nào** trong `packages/mcp`. Việc còn lại của Giai đoạn 4 **không phải** di chuyển schema mà là: `contracts` phải xuất **một catalogue `tên tool → {input, output, level}`** để route bridge bên `server` map được `:name` sang schema mà không cần registry. Xem checklist A.4.

2. **`core` trả `Result<T, DomainError>`, không throw** ([steering 03 §2.2](../../../steering/03-architecture-ddd.md)). Chữ ký ở §5.2 và §5.9 viết tắt cho dễ đọc; phần nằm trong `core` SHALL trả `Result`. `ProjectImportService` (§5.19) đã đúng dạng; `FilesystemBrowserService` và `DoctorCheck` SHALL theo cùng dạng.
3. **`packages/worker` giữ nguyên, không đụng.** Nó tồn tại trong repo và steering 02 §1 còn liệt `worker` trong danh sách entrypoint của `cli`. Giai đoạn 4 **không** expose mode `worker` (OQ-9) nhưng cũng **không** xoá package — không tạo orphan, không sửa steering vì một thứ chỉ bị hoãn.
4. **`mcp` MUST NOT import `adapter`.** [steering 02 §2](../../../steering/02-project-layout.md) luật 3 — `mcp` là adapter giao thức, nó dịch chứ không thực thi, nên nhận mọi thứ cần qua tham số do `cli` inject; §2.1 giải thích vì sao `worker` được import `adapter` mà `mcp` không. Luật được cưỡng chế ở **hai** chỗ (§2.2): block `packages/mcp/**` trong [`eslint.config.mjs`](../../../../eslint.config.mjs) và [`scripts/verify-import-boundaries.mjs`](../../../../scripts/verify-import-boundaries.mjs). Gate thứ hai cấm theo **prefix đường dẫn**: mọi thứ dưới `packages/adapter/` phân giải thành `@vidcom/adapter`, nên `adapter/daemon` không thoát được. Hệ quả cho Giai đoạn 4: remote `ToolInvoker` **không** đặt ở `mcp` — `mcp` khai interface, `cli` dựng hiện thực từ `adapter/daemon`. MUST NOT nới gate, MUST NOT thêm dep vào [`packages/mcp/package.json`](../../../../packages/mcp/package.json) (đang khai đúng 5: hai gói SDK, `contracts`, `core`, `zod`).

   **Lịch sử, để không ai đi lại đường cũ**: tới 2026-08-07 ba nguồn này nói khác nhau — bảng steering và ESLint *cho phép*, chỉ gate script *cấm*. Đó là lý do bản 2 của Design viết `DaemonClient` là thứ `mcp` dùng chung được: câu đó đọc đúng steering nhưng sẽ làm `test:boundaries` đỏ trong khi `lint` xanh. Mâu thuẫn đã được đóng bằng cách **thắt bảng steering + ESLint cho khớp gate** (khớp luôn code, vì `packages/mcp` vốn chưa từng import `adapter`).

**Bốn câu hỏi dependency của [steering 01 §3](../../../steering/01-backend-stack.md)** phải trả lời được trước khi thêm bất kỳ dependency nào. Giai đoạn 4 chỉ thêm **một** dependency thật:

| | `tar@7.5.22` (nâng thành direct dependency) | `@hono/node-server@2.0.12` — **đã là dependency**, không phải món mới |
|---|---|---|
| Chạy trong binary đã compile? | **Có** — và đây là rủi ro D2 phải kiểm: pure JS, không native addon, không đọc `__dirname`. Packaged smoke là chỗ chứng minh | Có; pure JS, đã dùng trong spike S2/S7 |
| Kéo theo bản thứ hai của thứ đã có? | Không — đã nằm trong lockfile, chỉ nâng lên direct | Không; nó là Node adapter **của chính Hono**, không phải HTTP framework thứ hai (steering 01 §1 cấm cái sau) |
| Viết được bằng ~30 dòng? | Không — extraction an toàn (traversal, symlink, mode) là chỗ dễ sai kín | Không — graceful close + streaming request/response |
| Cần network lúc runtime? | Không | Không |

> **Đính chính so với bản 2**: bản 2 viết "Giai đoạn 4 thêm hai" dependency. Kiểm lại ngày 2026-08-07: [`packages/server/package.json`](../../../../packages/server/package.json) **đã khai `@hono/node-server@2.0.12`** từ trước, nên cột phải là *bằng chứng đã trả lời*, không phải việc phải làm. Không có task nào cần thêm nó. `puppeteer-core@25.4.0` (dùng cho harness browser ở Phase G) cũng **đã** là devDependency của repo và đã nằm trong danh sách được phép của [steering 01 §5](../../../steering/01-backend-stack.md), nên Phase G không mở dependency mới.

### 5.1 `BootstrapCoordinator`

- **Purpose**: serialize runtime extraction and migration before any foundation/lease.
- **Interface**:

```ts
interface BootstrapCoordinator {
  prepare(input: {
    appDataRoot: AbsolutePath;
    assetSource: RuntimeAssetSource;
    repair: boolean;
  }): Promise<PreparedRuntime>;
}

interface PreparedRuntime {
  manifest: InstalledRuntimeManifest;
  paths: RuntimePaths;
  database: VidcomDatabase;
  release(): Promise<void>;
}
```

- `prepare()` owns bootstrap lock; callers MUST NOT independently call migration/extraction.
- `repair=false` refuses broken checksum; `doctor --repair` uses `repair=true`.
- `prepare()` cũng chạy **bridge credential reconciliation** (§4.4) sau migration và trước khi trả về, dưới `<app-data>/credential.lock`. Đây là nơi duy nhất một lần xoay chết giữa chừng được phát hiện và hoà lại, nên nó MUST chạy ở **mọi** boot, không chỉ boot đầu — một app-data đi qua crash rồi khởi động lại bằng đường `serve --ensure` cũng phải được chữa.

### 5.2 `FilesystemBrowserService`

- **Purpose**: bounded, authenticated navigation without exposing file contents.
- **Interface**:

```ts
interface FilesystemBrowserService {
  roots(sessionId: string): Promise<BrowseRoot[]>;
  list(input: { sessionId: string; token: string; cursor?: string }): Promise<BrowsePage>;
  createDirectory(input: { sessionId: string; parentToken: string; name: string }): Promise<BrowseEntry>;
  resolveSelection(input: { sessionId: string; token: string }): Promise<AbsolutePath>;
}
```

- `BrowseTokenStore` là in-memory, TTL ngắn, bind session + canonical path + stat identity; response vẫn có display path.
- File operation chạy trong bounded worker (`node:worker_threads`) với concurrency 2. Timeout terminate worker; request không giữ threadpool daemon vô hạn. Packaged smoke kiểm worker trên cả ba OS.
- **Worker MUST được tạo ở dạng eval** — `new Worker(<source>, { eval: true })` — và **MUST NOT** trỏ tới một file path (`new Worker(new URL("./browse-worker.js", import.meta.url))`). Trong SEA không có file thật để worker load; đây đúng là cơ chế đã làm esbuild **treo vĩnh viễn** ở S1b, và chế độ hỏng là **treo im lặng**, không phải lỗi. Dạng thông thường nhất lại là dạng sai, nên đây là ràng buộc chứ không phải gợi ý.
- Đã kiểm trong SEA thật ([S8](../../../../spikes/phase-4/README.md)): worker eval + `readdirSync` qua `postMessage` **OK**, `terminate()` giữa vòng lặp vô hạn **OK**, `Atomics` + `SharedArrayBuffer` **OK**. Test bắt buộc: một test dựng worker **dạng file path** và chứng minh nó fail/timeout có mã, để dạng sai không lặng lẽ quay lại.
- Chỉ trả directory entry; file thường trả tên + `isDir=false`, không stat size/nội dung.

### 5.3 `FoundationManager`

```ts
interface FoundationManager {
  status(): FoundationStatus;
  activate(workspaceRoot: AbsolutePath): Promise<Result<ActiveFoundationInfo, DomainError>>;
  stop(reason: "shutdown" | "lease-lost"): Promise<void>;
  currentApp(): ReturnType<typeof createServerApp>;
}
```

- Giữ host session/nonces bên ngoài foundation.
- Tách `startVidcomFoundation` thành `prepareFoundation` (không listener) và lifecycle handle idempotent `stop()`.
- `WriteAuthority` vẫn kiểm lease trước và sau mutex.
- **Mất lease không gọi `stop()` ngay.** Manager vào `Reacquiring`: từ chối ghi, dừng scheduler/watcher, xoá discovery record — nhưng giữ foundation object để lấy lại lease được mà không dựng lại từ đầu (§4.3). Chỉ khi re-acquire thất bại mới `stop("lease-lost")`.
- **Sau `stop("lease-lost")` thì host quyết, không phải manager.** Manager luôn về `NoWorkspace` và trả `currentApp` = bootstrap app; **host** mới là chỗ biết có UI attach hay không và do đó có đóng listener hay không (§4.3 bước 4). Tách như vậy để `FoundationManager` không phải biết gì về attachment, và để cùng một đường mã phục vụ cả `app` lẫn `serve`.

### 5.4 `LoopbackHost` và mutable request target

```ts
interface LoopbackHost {
  start(fetchTarget: () => (request: Request) => Response | Promise<Response>): Promise<HostHandle>;
}

interface HostHandle {
  host: "127.0.0.1";
  port: number;
  close(): Promise<void>;
}
```

- Node request listener đọc `currentApp` mỗi request; swap là assignment đồng bộ.
- `/api/**` vào current Hono app; path còn lại vào `SeaStaticAssetHost`.
- Bootstrap app đăng ký auth/system/health; active app thêm project/job/event/MCP routes.

### 5.5 `DaemonDiscoveryStore`

```ts
interface DaemonDiscoveryStore {
  read(workspaceRoot: AbsolutePath): Promise<DaemonRecord | null>;
  publish(record: DaemonRecord): Promise<void>;
  remove(workspaceRoot: AbsolutePath, instanceId: string): Promise<void>;
}
```

- Atomic temp+fsync+rename; mode/ACL bảo vệ.
- `remove` compare instanceId để daemon cũ không xoá record daemon mới.

### 5.6 `DaemonClient` và handshake

```ts
interface DaemonClient {
  ensure(input: { workspaceRoot: AbsolutePath; kind: AttachmentKind }): Promise<DaemonSession>;
}

interface DaemonSession {
  instanceId: string;
  attachmentId: string;
  baseUrl: string;
  invokeTool(name: ToolName, input: unknown, context: RemoteInvocationContext): Promise<unknown>;
  enqueueRender(input: EnqueueRenderRequest): Promise<{ jobId: JobId }>;
  getJob(jobId: JobId): Promise<JobDto>;
  cancelJob(jobId: JobId): Promise<void>;
  close(): Promise<void>;
}
```

- HTTP client có deadline cho discovery/handshake/call; không retry mutation mù.
- `ensure` spawn `serve --ensure` khi cần, xử lý race bằng startup lock + final lease/handshake.

### 5.7 Remote MCP Registry

- **Purpose**: giữ tool schema/list/era ở bridge nhưng execution ở daemon.
- `ToolDefinition` tiếp tục là nguồn duy nhất. `createMcpRegistry` nhận `ToolInvoker`; local invoker gọi Core, remote invoker gọi daemon allowlisted endpoint.
- **Interface `ToolInvoker` ở `packages/mcp/src/registry/types.ts`; hiện thực remote ở `packages/cli`.** `mcp` MUST NOT import `adapter/daemon` (§5.0 hệ quả 4) — nó chỉ nhận invoker qua tham số, đúng như `createMcpRegistry(infrastructure, application)` đang được `cli` gọi hôm nay:

```ts
// packages/mcp/src/registry/types.ts — mcp chỉ biết đến shape này
export interface ToolInvoker {
  invoke(name: string, raw: unknown, request: ToolRequestContext): Promise<ToolInvocation>;
}

// packages/cli/src/bridge/remote-tool-invoker.ts — cli là chỗ duy nhất thấy cả hai bên
export function createRemoteToolInvoker(client: DaemonClient): ToolInvoker;
```

- Bridge forward `protocolVersion`, credential/attachment id, request state và actor=`agent`; daemon sở hữu audit.
- MUST NOT có generic `request(method,path,body)` trong bridge. Bề mặt của `DaemonClient` mà invoker được dùng chỉ gồm: `handshake`, `attach`/`renew`/`detach`, `invokeTool(name, payload)`.

### 5.8 CLI command dispatcher

- Public union: `app | serve | mcp | render | doctor | version | approve | credential | backup | recovery`.
- Internal flag `--vidcom-node` được xử lý trước parser và không xuất hiện trong help/public type.
- Mọi human output của CLI trừ MCP dùng `stderr`/selected output writer; MCP stdout chỉ JSON-RPC.

### 5.9 Doctor service

```ts
type DoctorStatus = "ok" | "missing" | "broken" | "skipped";
interface DoctorCheck {
  id: string;
  required: boolean;
  run(context: DoctorContext): Promise<DoctorItem>;
  repair?(context: DoctorContext): Promise<DoctorItem>;
}
interface DoctorReport { version: 1; platform: string; items: DoctorItem[]; }
```

**Bảng phân loại — deliverable của R3.12.** Luật phân loại: thứ **ship trong artifact** là *required* (thiếu nghĩa là giải nén hỏng, không phải người dùng chưa tải); thứ **tải ở lần chạy đầu** cũng *required* theo OQ-11 nhưng có `skipped` khi chưa từng chạy render/TTS; thứ thuộc **máy/người dùng** là *optional*.

| id | Kiểm gì | required | Nguồn | `skipped` khi |
|---|---|:--:|---|---|
| `app-data.writable` | app-data tồn tại, mode/ACL đúng | ✅ | artifact | — |
| `db.migration` | schema version, `foreign_key_check` | ✅ | artifact | — |
| `runtime.manifest` | embedded ↔ installed manifest khớp | ✅ | artifact | — |
| `runtime.integrity` | sha256 từng archive đã giải nén | ✅ | artifact | `--deep` off → chỉ marker |
| `runtime.ffmpeg` | FFmpeg + FFprobe chạy được | ✅ | artifact | — |
| `runtime.esbuild-binary` | binary native có mặt, mode đúng | ✅ | artifact | — |
| `compiler.probe` | `transformSync` nhỏ qua `CompilerGuard` trong timeout | ✅ | artifact | — |
| `runtime.hyperframes` | CLI resolve + version | ✅ | artifact | — |
| `runtime.motion` | 5 thư viện + version pin | ✅ | artifact | — |
| `runtime.python` | interpreter đóng băng + stack khớp *core + phần phụ platform* (§5.13), liệt kê bằng `importlib.metadata` **không cần pip** | ✅ | artifact | — |
| `runtime.python-utf8` | `PYTHONUTF8`/`PYTHONIOENCODING` tới được sidecar: in một chuỗi tiếng Việt qua interpreter đã ship và đọc lại đúng | ✅ | artifact | — |
| `chrome.cache` | Chrome Headless Shell **chạy được** (`--version` có timeout), không chỉ tồn tại | ✅ | tải lần đầu | chưa từng render |
| `tts.model-cache` | weights VieNeu: đủ / thiếu / tải dở / **CA không tin được** | ✅ | tải lần đầu | chưa từng TTS |
| `workspace.active` | workspace active + ai giữ lease | ✅ | máy | chưa chọn workspace |
| `port.available` | bind được loopback | ✅ | máy | — |
| `settings.file` | `~/.vidcom/setting.json` có/parse được, và nếu khai `runtime.caBundlePath` thì file đó tồn tại/đọc được — **không in nội dung** | ⬜ | người dùng | file không tồn tại |
| `tts.elevenlabs` | có API key hay không | ⬜ | người dùng | luôn optional |

Exit code theo R3.7: mục **required** không `ok` ⇒ exit ≠ 0; mục **optional** không `ok` MUST NOT làm exit khác 0. `skipped` không tính là fail.

**`skipped` phải có nguồn sự thật, không phải suy đoán.** Ba mục dùng `skipped` và cả ba lấy từ dữ liệu đã có, **không thêm bảng nào**:

| Mục | `skipped` khi và chỉ khi |
|---|---|
| `chrome.cache` | bảng `job` chưa từng có job `render`/`snapshot` nào đạt trạng thái terminal trong app-data này |
| `tts.model-cache` | bảng `job` chưa từng có job TTS nào đạt terminal |
| `workspace.active` | `app_settings.active_workspace` chưa được ghi (tức chưa ai chọn workspace lần nào) |

**Trong job packaged smoke, `skipped` ở một mục required là FAIL.** R8.4 nói thành phần bắt buộc vắng mặt thì job SHALL fail chứ không skip, còn luật exit code ở trên lại nói `skipped` không tính fail — hai câu này đá nhau đúng ở chỗ smoke. Giải: `doctor` nhận `VIDCOM_DOCTOR_STRICT=1` (job smoke luôn đặt), và ở chế độ đó `skipped` trên mục required được tính như `missing`. Ngoài smoke, `skipped` giữ nguyên nghĩa "chưa tới lượt kiểm".

**`chrome.cache` MUST thực thi binary.** Đo được ở [S9/W-3](../../../../spikes/phase-4/s9-windows-runtime/README.md): cắt Chrome còn 1 MB rồi hỏi `hyperframes browser path` thì nó vẫn **trả đúng đường dẫn và exit 0**, không tải lại — CLI chỉ kiểm file tồn tại. Một cache tải dở đi lọt qua đó y như cache tốt, rồi job render chết bằng một lỗi không liên quan. Nên check này chạy `chrome-headless-shell --version` với timeout và so version với manifest; hỏi CLI lấy đường dẫn MUST NOT được coi là bằng chứng. Cùng tinh thần R6.11 đã áp cho compiler.

**`gpu.cuda` bị bỏ khỏi bảng.** Nó tồn tại ở bản trước như một mục optional, nhưng stack đã pin chỉ có `onnxruntime` bản CPU (§5.13) — không có `onnxruntime-gpu`, không có CUDA runtime trong archive — nên check đó **không bao giờ có thể trả `ok`**. Một mục vĩnh viễn không `ok` dạy người dùng bỏ qua output của `doctor`, và đó là thứ đắt hơn cái nó báo. TTS chạy CPU là quyết định của Giai đoạn 4; khi nào ship stack GPU thì mục này quay lại cùng với nó.

- Registry check deterministic theo thứ tự; `--json` dùng schema contracts.
- Redactor loại token, API key, credential body và build-machine absolute path.
- Repair chỉ extraction/runtime component; không tự sửa settings/project.

### 5.10 `SeaStaticAssetHost`

Build sinh hai SEA assets:

- `frontend-manifest.json`: `{path, offset, length, sha256, mime, cachePolicy}`.
- `frontend.pack`: concatenated raw bytes, không base64.

Runtime dùng `getRawAsset` và immutable `Uint8Array` view; không ghi pack ra đĩa. Resolver normalize URL, reject encoded traversal, map `/projects/<slug>` và các payload con sang `projects/__shell*`, còn lại exact/implicit `.html`. HTML/RSC `no-store`; hashed `/_next/static/**` immutable.

**`trailingSlash: false` — chốt tường minh, vì nó quyết định luật serve.** R4.5 đòi giá trị này được nói ra chứ không để mặc định ngầm. Export sinh `<tên>.html` chứ không phải `<tên>/index.html`, nên resolver map `/settings` → `settings.html` và `/projects/<slug>` → `projects/__shell.html`. Đổi giá trị này đổi luôn toàn bộ bảng map, nên nó là một phần của contract, không phải một tuỳ chọn build.

### 5.11 Frontend API driver

- Một service catalog trong `src/lib/api/services.ts`, id dạng `v1.<domain>.<action>`.
- `DriverBuilder.withBaseURL(resolveApiBaseUrl()).withServices(...).withTimeout(...)`.
- Không bật automatic version injection vì service URL đã chứa `api/v1`; tránh `/v1/v1`.
- Browser calls dùng Fetch path với `credentials: "include"`; SSE dùng `execServiceByStream` và abort khi unmount.
- **Base URL là runtime config, không phải build-time env.** `NEXT_PUBLIC_*` bị Next inline lúc build, nên nó vi phạm R4.10 ("**cùng một** bundle chạy được cả hai môi trường, chỉ bằng cấu hình"). Thay bằng: `resolveApiBaseUrl()` đọc một global runtime — `window.__VIDCOM_API_BASE_URL__` do host chèn — và **mặc định `location.origin`** khi global vắng mặt. Artifact không chèn gì ⇒ chạy same-origin; `next dev` chèn origin của daemon ⇒ chạy cross-origin. Một bundle, hai môi trường, không rebuild.
- **Ai chèn global đó ở dev**: `src/app/layout.tsx` render một `<script>` **chỉ khi** `process.env.NODE_ENV !== "production"`, nội dung lấy từ `process.env.VIDCOM_DEV_API_ORIGIN` mà `next dev` đọc lúc chạy. Production build loại nhánh đó bằng dead-code elimination nên **không chuỗi dev origin nào vào được pack** — đó là lý do "một bundle, hai môi trường" không mâu thuẫn với luật scan ngay dưới. MUST NOT dùng `NEXT_PUBLIC_*` cho giá trị này: Next inline nó lúc build và bundle hết chạy được ở môi trường kia.
- Artifact test scan cấm chuỗi `localhost:3000` và mọi dev origin trong pack đã build — với runtime config thì không có gì để lọt, và test giữ nguyên là chốt chặn.
- **Luật hostname không phải khuyến nghị — đã đo trên Chrome thật** ([S9/W-1](../../../../spikes/phase-4/s9-windows-runtime/README.md)):

  | daemon | cookie | quay lại | SSE |
  |---|---|:--:|:--:|
  | `127.0.0.1:<port>` | `SameSite=Strict` / `Lax` | ❌ | ❌ |
  | `localhost:<port>` | `SameSite=Strict` | ✅ | ✅ |

  `localhost:3000` → `localhost:<port>` giữ được `Strict` **qua port khác nhau**, nên không phải hạ cookie xuống `Lax`/`None` để dev chạy. Nhưng trỏ sai hostname thì `exchange` vẫn trả **200** và cookie **không bao giờ quay lại** — hỏng im lặng, không lỗi, không cảnh báo. Vì vậy `VIDCOM_DEV_API_ORIGIN` có hostname khác hostname của FE ⇒ dev host SHALL **fail lúc boot** (R4.12), MUST NOT để người phát triển tự đoán. `SameSite=None; Secure` chạy được trên `http://` loopback và là lối thoát cuối; artifact same-origin không cần, nên MUST NOT dùng.
- **SSE cũng phải gửi credential.** `execServiceByStream` SHALL nhận cùng request options như đường fetch, gồm `credentials: "include"`, vì cross-origin dev không tự đính cookie. Stream SHALL nhận `AbortSignal` và bị abort khi component dispose — nếu không, mỗi lần đổi workspace/điều hướng để lại một kết nối SSE treo trên daemon.
- Mọi caller kiểm `ResponseFormat.ok`; error mapper chuyển stable `error.code/field/details` vào UI.

### 5.12 Workspace/New video UI

- `WorkspacePickerPage`: roots, breadcrumb, paginated entries, create folder, select, timeout/permission error.
- `NewProjectDialog`: name + bundled preset (`vertical-shorts`, `horizontal-youtube`), submit guard, field error, collision error; success refresh/navigate.
- Không custom dimensions trong dialog; endpoint vẫn giữ contract custom hiện có cho caller khác.
- Đổi subtitle card thành mô tả project trống, không nói agent generation.

### 5.13 Runtime asset source and manifest

```ts
interface RuntimeAssetSource {
  readManifest(): EmbeddedRuntimeManifest;
  readArchive(key: RuntimeArchiveKey): Uint8Array;
}

interface EmbeddedArchive {
  key: string;
  platform: "darwin-arm64" | "win32-x64" | "linux-x64";
  sha256: ContentHash;
  bytes: number;
  target: string;
  entries: Array<{ path: string; sha256: ContentHash; mode: number }>;
}
```

Manifest pin Node, HyperFrames, esbuild, FFmpeg, CPython, VieNeu và motion versions.

**Danh sách Python được pin — deliverable của R5.14.** Đây là tập **đã đo trên bản cài thật ở hai nền tảng**, không phải mô tả cơ chế. Base là `python-build-standalone` CPython `3.12.13+20260805`; cài `vieneu==3.2.4` + `huggingface-hub` kéo về **77 package trên darwin arm64** và **79 trên win32 x64**, trong đó **21 package bị gỡ** ở cả hai.

**Danh sách là một core dùng chung cộng một phần phụ theo platform — không phải một danh sách duy nhất.** Bản trước viết một danh sách 56 dòng và một luật "lệch là fail"; [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md) cho thấy luật đó tự làm fail build Windows ngày đầu tiên:

| Platform | Package sau prune | Phần phụ so với core |
|---|---:|---|
| `darwin-arm64` | 55 | — |
| `win32-x64` | **57** | `colorama` (`click`/`tqdm` khai `platform_system == "Windows"`), `tzdata` (`pandas` không có tz database của OS) |
| `linux-x64` | **55** | **không có** — đo thật trong container `linux/amd64`, tập trùng khít core, không thừa không thiếu |

**Cả ba nền tảng đã đo, Windows là ngoại lệ duy nhất.** Linux resolve ra đúng 77 package như darwin và prune xuống đúng 55 package của core — nên "phần phụ theo platform" thực tế chỉ tồn tại ở Windows. Luật *core + phần phụ* vẫn giữ nguyên: nó mô tả **cơ chế**, và cơ chế đó đã chứng minh là cần thiết ở một trong ba nền tảng.

Cả hai phần phụ đều là dependency bắt buộc của package **đã nằm trong core**, nên chúng thuộc tập *giữ*, không phải tập *gỡ*. **Version của toàn bộ package core khớp tuyệt đối giữa darwin và Windows** — không dòng nào lệch — nên core dưới đây là core thật, không phải giao của hai tập rời rạc.

**`pip` bị gỡ khỏi stack ship đi.** Bản trước giữ `pip==26.2` trong tập core mà không nói vì sao. Lý do duy nhất nó có mặt là build dùng `pip install`/`pip uninstall` để dựng stack — đó là **công cụ build**, không phải thứ runtime cần. Đo trên Windows: gỡ pip còn **499 MB** (từ 511), toàn bộ chuỗi import của sidecar vẫn chạy, và `importlib.metadata.distributions()` — **thư viện chuẩn, không cần pip** — vẫn liệt kê đủ 57 package, nên check `runtime.python` của §5.9 không mất khả năng xác minh. Ship một trình cài package bên trong artifact vừa tốn 12 MB vừa mở một bề mặt không ai cần.

> Số darwin `492 MB / 145,9 MB` được đo **khi còn pip**; áp cùng luật thì nó giảm chừng 12 MB. Con số đó MUST được đo lại trên runner darwin, MUST NOT suy từ Windows — đúng luật mà chính mục này vừa đặt ra.

*Gỡ (21)* — một web UI demo cộng phần phụ thuộc của nó, không đường nào của sidecar chạm tới:

```
fastapi gradio gradio_client groovy hf-gradio llvmlite markdown-it-py mdurl numba
pillow pygments python-multipart rich safehttpx scikit-learn semantic-version
shellingham starlette tomlkit typer uvicorn
```

*Core giữ (55)* — pin theo version chính xác trong manifest, giống nhau ở mọi platform. `pip==26.2` xuất hiện lúc build rồi bị gỡ, nên nó **không** nằm trong danh sách này:

```
annotated-doc==0.0.5      annotated-types==0.8.0    anyio==4.14.2          audioread==3.1.0
brotli==1.2.0             certifi==2026.7.22        cffi==2.1.1            charset-normalizer==3.4.9
click==8.4.2              decorator==5.3.1          filelock==3.32.2       flatbuffers==25.12.19
fsspec==2026.7.0          h11==0.16.0               hf-xet==1.6.0          httpcore==1.0.9
httpx==0.28.1             huggingface_hub==1.26.1   idna==3.18             jinja2==3.1.6
joblib==1.5.3             lazy-loader==0.5          librosa==0.11.0        markupsafe==3.0.3
msgpack==1.2.1            narwhals==2.24.0          numpy==2.4.6           onnxruntime==1.28.0
orjson==3.11.9            packaging==26.3           pandas==3.0.5          perth==1.0.0
platformdirs==4.11.0      pooch==1.9.0              protobuf==7.35.1
pycparser==3.0            pydantic==2.13.4          pydantic_core==2.46.4  pydub==0.25.1
python-dateutil==2.9.0.post0                        pytz==2026.3.post1     pyyaml==6.0.3
requests==2.34.2          scipy==1.18.0             sea-g2p==0.8.3         six==1.17.0
soundfile==0.14.0         soxr==1.1.0               threadpoolctl==3.6.0   tokenizers==0.23.1
tqdm==4.70.0              typing-inspection==0.4.2  typing_extensions==4.16.0
urllib3==2.7.0            vieneu==3.2.4
```

*Phần phụ `win32-x64` (2)*:

```
colorama==0.4.6           tzdata==2026.3
```

**Đã kiểm** — ba cột, và **cột nào cũng đo trên nền tảng của chính nó**. Không còn ô ước lượng nào:

| | darwin arm64 | win32 x64 | linux x64 |
|---|---|---|---|
| Gỡ đủ 21 package, WAV vẫn ra | ✅ `worker.py --request`, voice từ catalogue | ⚠️ **chưa chứng minh** — xem N-1 dưới | ⚠️ chưa chạy TTS; chuỗi import PASS |
| Interpreter trần | 66 MB | 68 MB | **104 MB** |
| Không prune | 806 MB / 77 pkg | 815 MB / 79 pkg | **980 MB / 77 pkg** |
| **Sau prune, không `pip`** | **481 MB / 145 MB** | **499 MB / 152 MB** | **595 MB / 179 MB** |
| Package sau prune | **55** | 57 | **55** |

Cột darwin đo trên runner `macos-latest` (arm64) của GitHub qua [`phase4-python-stack.yml`](../../../../.github/workflows/phase4-python-stack.yml) — job tự fail nếu runner không phải arm64, nếu `pip` sống sót qua prune, hoặc nếu chuỗi import gãy, nên xanh nghĩa là số dùng được.

**Tập package của darwin trùng khít Linux và trùng khít core 55 trong tài liệu này** — kiểm bằng `diff`, kết quả rỗng. Ba nền tảng, một core, và Windows là ngoại lệ duy nhất với đúng hai package.

**Linux nặng hơn đáng kể, và đó là một hệ quả thiết kế chứ không phải một con số.** Interpreter Linux lớn hơn darwin **58 %** và stack sau prune lớn hơn ~24 % (595 so với 481 MB). Nghĩa là artifact Linux tải về nặng hơn ~36 MB và **giải nén nhiều hơn ~115 MB** so với darwin — trong khi §9.1 đang cho hai nền tảng **cùng** trần cold 120 s. Trần Linux vì vậy là **tạm**, và lần smoke Linux đầu tiên là chỗ xác nhận hoặc nới nó kèm số đo.

Build SHALL **fail** nếu tập package thực tế lệch khỏi *(core + phần phụ của platform đang build)* — thừa hay thiếu đều fail, vì thừa nghĩa là artifact phình mà không ai để ý và thiếu nghĩa là TTS chết trên máy người dùng. Danh sách + version là **một phần của checksum contract**, không phải tài liệu tham khảo. Đổi danh sách phải kèm số đo mới ở đây, **và số đo phải đến từ platform tương ứng** — suy từ platform khác là đúng cái sai mà bản trước mắc phải.

**Thêm một platform ⇒ thêm một hàng đo được, không phải một dòng suy diễn.** Trước khi bật packaged smoke cho `linux-x64`, phần phụ của nó MUST được đo và ghi vào bảng trên. Bảng thiếu một hàng thì build job của platform đó MUST fail, MUST NOT rơi về core.

**N-1 — TLS inspection làm hỏng đường tải weights, và nó không phải offline.** Đo trên máy Windows thật ([S9](../../../../spikes/phase-4/s9-windows-runtime/README.md)): mạng có firewall giải mã TLS **chỉ với `huggingface.co`** (`pypi.org`/`github.com`/`storage.googleapis.com` sạch), và CA của firewall không nằm trong trust store của Windows. CPython đóng băng dùng bundle `certifi` của chính nó chứ không dùng trust store của OS, nên:

- `pip`, browser, PowerShell vẫn chạy bình thường — **chỉ sidecar TTS chết**, với `CERTIFICATE_VERIFY_FAILED`.
- Đây là chế độ hỏng **thứ ba**: mạng thông (nên không phải `download_unavailable` theo nghĩa offline), nhưng tải không được.
- Môi trường doanh nghiệp là môi trường chính của một tool local-first, nên đây không phải trường hợp biên.

Design chốt ba thứ cho nó:

1. Mã lỗi riêng **`download_tls_untrusted`** (§8.1), tách khỏi `download_unavailable`. Adapter nhận diện qua `CERTIFICATE_VERIFY_FAILED` / `unable to get local issuer certificate` của sidecar và qua `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` của Node.
2. `doctor` check `tts.model-cache` và `chrome.cache` SHALL phân biệt lỗi này với "mất mạng", và thông điệp sửa lỗi SHALL nói thẳng: mạng của bạn có TLS inspection, trỏ CA của tổ chức vào cấu hình dưới đây.
3. Lối thoát cấu hình: `~/.vidcom/setting.json` nhận `runtime.caBundlePath`; hệ thống truyền nó xuống sidecar bằng `SSL_CERT_FILE` + `REQUESTS_CA_BUNDLE` và xuống mọi child Node bằng `NODE_EXTRA_CA_CERTS`. Hệ thống MUST NOT tự tắt xác minh chứng chỉ, và MUST NOT tự nhặt CA từ trust store của OS — tin một MITM là quyết định của người dùng, phải tường minh.
   **Key mới ⇒ phải vào schema.** [steering 07 §0](../../../steering/07-data-and-storage.md) quy định `setting.json` là **schema strict**: key lạ là **lỗi khởi động**, không phải bị bỏ qua. Nên `runtime.caBundlePath` SHALL được thêm vào schema của `ResolvedVidcomSettings` cùng lúc, nếu không người dùng viết nó vào sẽ làm app không khởi động được — đúng cái bẫy "misconfiguration khó tìm nhất" mà steering mô tả, chỉ theo chiều ngược lại. Env override đi cùng: `VIDCOM_CA_BUNDLE`, theo luật "env thắng file".

> Hệ quả cho R5.14: bằng chứng "WAV ra trên Windows" vẫn **chưa có**, vì máy đo nằm sau chính firewall này. Nó là bước bắt buộc của packaged smoke Windows (§11.4 bước 8), không được suy từ kết quả darwin.

### 5.14 `RuntimeAssetManager`

- `ensureAll`, `inspect`, `repair`, `pruneOldVersions`.
- **Quan sát được ở đâu — R5.11 có hai nửa và chỉ một nửa có UI.** Giải nén lần chạy đầu diễn ra **trước khi listener mở** ở cả hai flow (§4.5), nên nó **không thể** hiện trong UI: kênh duy nhất là `stderr` + log store, và Design tuyên bố thẳng như vậy thay vì để lại một câu SHALL không thực hiện được. Nửa còn lại thì có UI: re-extract do `doctor --repair` hoặc R3.13 kích hoạt **trong khi daemon đang sống** SHALL phát `runtime.preparing` / `runtime.ready` qua SSE đang có, và `GET /api/v1/system/runtime` trả trạng thái hiện tại cho client vừa mở.
- Target versioned: `<app-data>/native/<artifact-version>/<archive-key>/...`.
- `.ready-<archive-sha>` viết sau validation; `current.json` atomic trỏ version active.
- Không xoá version cũ khi process khác còn dùng; prune chỉ sau startup thành công và grace period.

### 5.15 Bootstrap lock — và khoá credential dùng chung cơ chế

- Atomic directory lock ở app-data; owner file không phải authority duy nhất.
- Bounded wait + stale probe `(pid, processStartIdentity)`; không reclaim chỉ vì timestamp.
- Windows không dựa vào unlink file đang mở; rename lock dir sang quarantine rồi xoá sau.
- **Hai khoá, cùng một cơ chế, thứ tự cố định.** `runtime-bootstrap.lock` bảo vệ extraction + migration; `credential.lock` bảo vệ vòng đời bearer bridge (§4.4). Chúng tách nhau vì một lần `rotate --bridge` MUST NOT chặn cold start của tiến trình khác. Thứ tự lấy khoá **luôn là `bootstrap → credential`**: `BootstrapCoordinator` giữ khoá bootstrap rồi mới lấy khoá credential cho bước reconciliation, còn `rotate`/`doctor --repair` chỉ lấy khoá credential. Không đường nào lấy ngược, nên không có chu trình — ràng buộc này là **luật**, không phải hệ quả tình cờ của thứ tự code hôm nay.

### 5.16 HyperFrames shim and binary probe

- `hyperframesCliPath`, `hyperframesPackagePath`, `motionLibraryRoot`, `nativeDependenciesRoot`, `browserCacheRoot` đều bắt buộc ở artifact composition root; fallback `require.resolve` chỉ còn dev/test.
- Shim validate realpath dưới verified runtime root trước dynamic import.
- Supervisor command array, không shell string; env đi qua `allowlistedEnvironment` — không truyền secret không cần thiết, **và ép `PYTHONUTF8`/`PYTHONIOENCODING` cùng `runtime.caBundlePath` như §4.6 quy định**. Tự dựng env cho child là đường làm mất cả hai bảo vệ đó cùng lúc.

### 5.17 `CompilerGuard`

```ts
interface CompilerGuard {
  run<T>(operation: () => Promise<T> | T, timeoutMs: number): Promise<Result<T, DomainError>>;
  probe(timeoutMs: number): Promise<Result<{ version: string }, DomainError>>;
}
```

Thiết lập env trước import/compiler initialization; restore env sau operation chỉ trong test process. Production set một lần lúc boot. Timeout trả `compiler_unavailable`, không treo.

### 5.18 Download cache coordinator

- Chrome cache và HF_HOME là download cache, không runtime extraction.
- Có per-component download lock, partial marker và timeout; `doctor` phân biệt missing/partial/broken/`download_tls_untrusted`.
- **Ba thứ đã đo, không còn là giả định** ([S9/W-3](../../../../spikes/phase-4/s9-windows-runtime/README.md)):
  1. `HTTPS_PROXY`/`HTTP_PROXY` **bị downloader lờ hoàn toàn** — nó vẫn tải 202 MB qua một proxy chết. Nên coordinator MUST NOT dựa vào biến proxy để điều khiển hay chặn download, và bước offline của CI phải chặn ở tầng mạng (§11.4 bước 11).
  2. Cache **tải dở** không tự phát hiện được bằng cách hỏi CLI: `hyperframes browser path` trả đường dẫn + exit 0 cho một binary 1 MB. Partial marker của coordinator là **nguồn sự thật duy nhất**, và `doctor` xác minh bằng cách chạy binary (§5.9).
  3. `HF_HUB_OFFLINE=1` với cache rỗng hỏng **đúng cách**: ~1 s, có thông điệp, không treo. Adapter ánh xạ thông điệp văn xuôi đó sang `download_unavailable`, và phân biệt với `download_tls_untrusted` theo §5.13.
- Debt còn lại: chế độ hỏng khi **thật sự mất mạng** lúc tải Chromium vẫn chưa đo được (proxy env không chặn được, chặn tầng mạng cần quyền admin). Packaged offline step là gate duy nhất.

### 5.19 `ProjectImportService`

```ts
interface ProjectImportService {
  plan(input: { source: AbsolutePath; targetName?: string }): Promise<Result<ImportPlan, DomainError>>;
  execute(input: ImportPlan & { actor: Actor }): Promise<Result<{ projectId: ProjectId; slug: string }, DomainError>>;
}
```

- Plan bind source canonical identity + target absence + digest; execute recheck trước copy.
- Copy regular files/directories only, ignore `node_modules/.git/.hyperframes`, reject symlink/special.
- Backfill dùng lại `bootstrapProject`/ProjectLifecycle; không có đường serialize identity thứ hai.

### 5.20 Artifact builder/provenance

- Script build fail nếu lockfile/tool versions khác manifest, archive có entry ngoài allowlist, sourcemap/source rời, secret pattern hoặc build-machine absolute root.
- Output: executable, `SHA256SUMS`, `artifact-manifest.json` gồm commit, dirty=false requirement cho release job, tool versions, archive hashes, platform.
- Giai đoạn 4 macOS ad-hoc sign sau injection; Windows unsigned + checksum; signing thật deferred.
- HyperFrames telemetry được disable trong extracted runtime lần đầu; release notes ghi quyết định.

## 6. Data Models

### 6.0 Relationship Diagram

```mermaid
erDiagram
    APP_SETTINGS ||--o| ACTIVE_WORKSPACE : stores
    WORKSPACE_LEASE ||--o| DAEMON_RECORD_FILE : describes
    WORKSPACE_OPERATION ||--o| IMPORT_STAGING_DIR : recovers
    PROJECT_REGISTRY ||--o{ JOB : owns
    PROJECT_REGISTRY ||--o{ MUTATION_JOURNAL : owns

    RUNTIME_MANIFEST_FILE ||--|{ READY_MARKER : validates
    RUNTIME_MANIFEST_FILE ||--|{ EXTRACTED_ARCHIVE : selects
```

`DAEMON_RECORD_FILE`, runtime manifest, marker và staging directory là filesystem operational state, không phải bảng SQLite.

### 6.1 Persistence Overview

- **Database**: existing `<app-data>/vidcom.sqlite`; không tạo database mới.
- **New tables**: none.
- **Modified table**: `workspace_operation` mở rộng `kind` thêm `project_import`.
- **Existing read/write**: `app_settings(active_workspace)`, `workspace_lease`, `job`, `project_registry`, audit/event/journal giữ nguyên owner.
- **Filesystem app-data mới**: `daemon/*.json`, `native/**`, runtime manifest/markers, bootstrap lock, cache locks.
- **Workspace tạm thời**: import staging sibling có marker; sau terminal không còn.
- **Transaction boundary**: import operation begin/commit trong SQLite bao quanh filesystem staging/publish theo coordinator recovery pattern; không giả vờ filesystem + SQLite là một ACID transaction.

### 6.2 Daemon record — filesystem

| Field | Type | Required | Rule |
|---|---|---:|---|
| schemaVersion | integer | yes | `1` |
| workspaceRoot | absolute canonical path | yes | match requested root |
| workspaceHash | sha256 | yes | filename and content match |
| instanceId | string | yes | unique per daemon process start |
| pid | positive integer | yes | diagnostic only |
| host | string | yes | exactly `127.0.0.1` |
| port | integer | yes | 1..65535 |
| startedAt | ISO timestamp | yes | diagnostic/stale hint |

Secret/attachment count/lease id MUST NOT nằm trong file.

### 6.3 Runtime manifests — filesystem

- Embedded manifest là build authority; installed manifest là projection của thứ đã verify/extract.
- Marker filename chứa archive digest; marker content chứa target version + verifiedAt, không được dùng thay digest verification khi `doctor --deep`.
- `current.json` chỉ đổi sau toàn bộ required archives ready.

### 6.4 Database Tables

#### `workspace_operation` — modified

- **Purpose**: recovery authority cho mutation workspace-level, nay gồm import.
- **Database**: `vidcom.sqlite`.
- **Owner**: `WorkspaceOperationJournal`/WriteAuthority coordinator.
- **Change**: `kind` check/enum từ `agent_kit_files | project_create | project_rename | project_delete` thành thêm `project_import`.
- **Columns used by import**:

| Column | DB type | Nullable | Rule |
|---|---|---:|---|
| id | INTEGER PK AUTOINCREMENT | no | operation id |
| workspace_root | TEXT | no | canonical target workspace |
| kind | TEXT | no | `project_import` |
| project_id | TEXT | yes | set khi identity đã biết |
| from_path | TEXT | yes | canonical source, audit/recovery only |
| to_path | TEXT | yes | final target |
| staging_path | TEXT | yes | same-filesystem temp with marker |
| status | TEXT | no | pending/committed/aborted/recovered/orphaned |
| actor | TEXT | no | user/agent/cli-external/system |
| action | TEXT | no | stable action name |
| created_at | TEXT | no | ISO time |

- **Indexes**: giữ existing unresolved/status index; no new query pattern requires another index.
- **Concurrency**: workspace lease + target `mkdir/rename` no-overwrite; coordinator recheck.

#### `app_settings` — existing table, one new key

- Key `active_workspace` chỉ ghi sau foundation swap thành công. Việc `selectWorkspace` hôm nay ghi nó như tác dụng phụ của resolve được tách ra (§7.13).
- **Key mới `bridge_credential_id`** — id của credential bridge đang hiệu lực (§4.4). Đây là *state vận hành*, đúng ranh giới [steering 07 §0](../../../steering/07-data-and-storage.md) vạch giữa `app_settings` và `setting.json`, nên nó **MUST NOT** xuất hiện ở file cấu hình người dùng. Không thêm bảng, không cần unique index trên `mcp_credential.label`.
- Không dual-write cùng value vào `~/.vidcom/setting.json`.

#### `workspace_lease` — existing, unchanged

- Một row/canonical workspace, TTL/renew như hiện tại.
- Daemon record chỉ được publish khi row thuộc lease id của foundation đó.

#### `job` — existing, unchanged

- Render CLI/bridge enqueue vào cùng bảng; không có queue thứ hai.
- Attachment/refcount MUST NOT ghi vào job.

### 6.5 Migration and Backfill

```mermaid
sequenceDiagram
    participant Boot as BootstrapCoordinator
    participant DB as vidcom.sqlite
    participant Migrator
    participant Foundation
    Boot->>Boot: acquire app-data bootstrap lock
    Boot->>DB: open existing Phase 3 file
    Boot->>Migrator: add project_import kind/check
    Migrator->>DB: foreign_key_check + schema drift validation
    Boot->>Boot: release bootstrap lock
    Foundation->>DB: acquire workspace lease
```

- **Migration**: forward-only Drizzle migration rebuilding `workspace_operation` if SQLite check constraint requires it; copy all rows, preserve ids/status.
- **Backfill**: none. Existing operation kinds remain byte-identical.
- **Rollback**: roll forward only; previous binary may not understand new kind. Release note marks DB forward compatibility boundary. Backup DB before migration using existing app-data backup policy.
- **Validation**: row count/kind distribution before/after, `foreign_key_check=0`, schema drift test, real Phase 3 fixture DB boot.

## 7. API / Interface Contracts

### 7.0 Hai chỗ Design đi khác steering — nêu ra, không đi vòng

[steering 00 §"Khi steering mâu thuẫn với yêu cầu"](../../../steering/00-index.md) bắt phải nêu mâu thuẫn thay vì im lặng làm khác. Có đúng hai chỗ:

1. **D1 "MCP là interface hạng nhất" vs R1.4.** [steering 04 §1](../../../steering/04-api-design.md) viết: *"Nếu một thao tác chỉ làm được qua HTTP mà không qua MCP, thiết kế sai."* Nhưng R1.4 (Goals đã duyệt) **cấm** expose API duyệt hệ thống file qua MCP dưới mọi hình thức, và bắt phải có test chứng minh Registry không chứa nó. `GET /api/v1/system/runtime` (§7.7b) theo cùng luật đó.
   Đây là ngoại lệ **có chủ ý và đã được duyệt**, không phải sơ suất: nhóm `/v1/system/*` không phải thao tác nghiệp vụ trên project — nó là bề mặt cấu hình của chính host, và cho agent quyền duyệt ổ đĩa là mở đúng thứ perimeter loopback đang đóng. Ranh giới: **chỉ** `/v1/system/*` được miễn D1; mọi use case chạm project vẫn phải gọi được qua MCP.
2. **`resource` số nhiều.** steering 04 §2 đòi danh từ số nhiều; `system/workspace`, `system/runtime` là số ít. Chúng là **singleton state của host**, không phải collection, và `system/workspace` đã tồn tại từ trước theo đúng dạng này. Giữ nhất quán với cái đã có thay vì sinh ra `systems/` vô nghĩa.
3. **"`mcp` không gọi `server`" — bridge không vi phạm, nhưng phải nói rõ vì sao.** [steering 02 §2](../../../steering/02-project-layout.md) cấm: *"MCP gọi HTTP nghĩa là nghiệp vụ đã rò lên tầng HTTP."* Bridge của R2 **gọi HTTP thật**. Khác biệt nằm ở chỗ luật đó nói về **phân tầng trong một tiến trình**: nghiệp vụ không được đi vòng qua HTTP để tới Core. Ở đây có **hai tiến trình**, và tiến trình bridge *không thể* gọi Core — nó không giữ lease, đó là toàn bộ lý do R2 tồn tại. HTTP ở đây là **IPC**, còn phía daemon route gọi thẳng Core.
   Ràng buộc rút ra, và nó là MUST: `packages/mcp` **MUST NOT import `packages/server`** — nó gọi qua `adapter/daemon` (§5.0); và DR-6 vẫn cấm `request(method, path, body)` tuỳ ý, nên bề mặt IPC đúng bằng tool allowlist chứ không phải một proxy HTTP.

**Luật validation áp cho mọi DTO mới của giai đoạn này** ([steering 06](../../../steering/06-validation.md)): schema đặt ở `contracts`, **`strict`** — field lạ bị **từ chối**, không bỏ qua âm thầm; validate cả body, query, path param lẫn header có nghĩa; và ở MCP validate **cả output**, vì trả sai shape là breaking change im lặng với AI host. Ba tầng validation không được trộn: schema ở boundary, invariant ở domain, còn "workspace này có đang bị tiến trình khác giữ lease không" là **nghiệp vụ**, thuộc Core.

Ngoài ba chỗ trên, Design theo steering: hình dạng lỗi `{error:{code,message,field?,details?}}` (04 §3.2), bảng map `ErrorCode → status` nằm một chỗ ở middleware (04 §3.3), thứ tự middleware cố định `requestId → logger → hostCheck → cors → auth → bodyLimit → validate → route → errorMapper` (04 §10), SSE một endpoint dùng chung có `id` + heartbeat (04 §7), và tác vụ dài trả `202 {jobId}` (04 §6).

Tất cả browser endpoint dưới `/api/v1`, session cookie bắt buộc trừ auth exchange/health. Bridge endpoint dưới `/api/bridge/v1`, bearer bắt buộc và không được expose qua browser/MCP tools.

**Body limit là 1 MiB cho mọi route trừ route upload asset, ở đó là 20 MiB.** Giới hạn được áp ở đúng mắt xích `bodyLimit` của chuỗi middleware cố định (steering 04 §10), nhận giới hạn theo route thay vì một hằng số toàn cục — MUST NOT thêm một `if` kiểm kích thước bên trong handler, vì như thế bytes đã vào tới route rồi. R4.6 hứa upload BGM tới 20 MB đi qua được host SEA, nên một giới hạn 1 MiB áp toàn cục sẽ giết đúng lời hứa đó. Giới hạn upload là một hằng số tường minh (`UPLOAD_BODY_LIMIT_BYTES = 20 * 1024 * 1024`) gắn vào đúng các route upload, không phải một `if` rải rác. Vượt giới hạn trả `413` với `error.code = "payload_too_large"` kèm giới hạn thật trong `details`, MUST NOT ngắt kết nối trần.

### 7.1 `GET /api/v1/system/filesystem/roots`

- **Purpose**: trả Home/Documents/Desktop hoặc Windows drive roots.
- **Response 200**: `{ roots: BrowseRootDto[] }`, mỗi root có `name`, `displayPath`, `token`, `canWrite`.
- **Security**: no MCP registration; token bind session.

### 7.2 `POST /api/v1/system/filesystem/entries`

- **Why POST**: absolute path/token không nằm trong URL/request log; đây là bounded query, không mutation.
- **Request**: `{ token: string, cursor?: string }`.
- **Response 200**: `{ directory, parentToken, entries, nextCursor, truncated }`.
- **Errors**: `browse_token_invalid`, `path_unreadable`, `path_timeout`, `not_directory`.

### 7.3 `POST /api/v1/system/directories`

- **Request**: `{ parentToken, name }`; name một segment, không slash/dot traversal.
- **Response 201**: created `BrowseEntryDto` + token.
- **Idempotency**: no; existing target returns 409 and never overwrites.

### 7.4 `GET /api/v1/system/workspace`

- **Response**: `{ state: "none"|"starting"|"active"|"switching"|"reacquiring"|"failed", workspace?: {...}, error?: DomainErrorDto }`.
- `reacquiring` phản ánh state machine §4.3: ghi đang bị từ chối nhưng tiến trình chưa chết. Thiếu nó thì UI không có cách nào hiển thị giai đoạn đó và sẽ hiện `active` sai trong lúc mọi mutation fail.
- Sau khi re-acquire thất bại ở nhánh có UI, state về `none` nhưng `error` SHALL giữ `workspace_lease_lost` — nếu không, màn chọn workspace hiện ra **không lý do** và người dùng tưởng app tự reset.

### 7.5 `PUT /api/v1/workspace/active`

- **Request chỉ nhận `{ selectionToken }`.** [steering 06 §5](../../../steering/06-validation.md) viết thẳng: *"MUST NOT có đường ghi nào nhận absolute path từ client hoặc AI"* — mà activate workspace là đường ghi (lấy lease, ghi `active_workspace`). Bản trước còn giữ `{ path }` "cho CLI/internal compatibility"; nhưng CLI **không đi qua endpoint này**: `vidcom render`/`serve --ensure` truyền workspace bằng **tham số tiến trình** rồi daemon tự activate nội bộ, nên nhánh `{ path }` trên HTTP không có người dùng thật và chỉ để lại một đường nhận absolute path từ browser session. Bỏ hẳn.
- Token và mọi đường dẫn của R1 SHALL đi qua **đúng một hàm canonicalize** đã có (steering 06 §5), MUST NOT dựng hàm resolve thứ hai cho picker.
- **Response 200**: workspace overview sau swap.
- **Errors**: 409 `workspace_busy`, 423/409 `workspace_lease_held`, 503 `workspace_start_failed` kèm rollback state.
- **Idempotency**: activate workspace đang active trả current overview, không restart foundation.

### 7.6 `POST /api/v1/projects`

- Contract hiện có giữ nguyên: `{name,presetId,width?,height?,fps?}` → `201 {projectId,slug}`.
- UI R1.19 chỉ gửi bundled preset; không thêm endpoint/backend capability.

### 7.7 Frontend events

- `GET /api/v1/events` giữ SSE contract; http-driver stream phải abort khi component dispose.
- **Sự kiện mới của giai đoạn này** — chúng được viện dẫn ở §4.3 và §5.14, nên phải nằm trong contract chứ không phải chỉ trong văn xuôi:

  | Event | Khi nào | UI làm gì |
  |---|---|---|
  | `workspace.changed` | swap foundation thành công | invalidate projects query |
  | `workspace.lease_lost` | renew fail, **trước** khi listener đóng | hiện lý do; đây là thông điệp cuối trước khi kết nối chết |
  | `workspace.reattached` | re-acquire lease thành công (§4.3) | gỡ banner, refresh state |
  | `runtime.preparing` / `runtime.ready` | re-extract lúc daemon đang sống (§5.14) | hiện tiến trình chuẩn bị runtime |

### 7.7b `GET /api/v1/system/runtime`

- **Purpose**: trạng thái runtime cho client vừa mở, khi nó bỏ lỡ `runtime.preparing` phát trước đó.
- **Response 200**: `{ state: "ready"|"preparing"|"broken", archives: [{key, status, version}], startedAt? }`.
- Cùng luật session như `/api/v1/system/*`; MUST NOT expose qua MCP (R1.4).

### 7.8 `POST /api/bridge/v1/handshake`

- **Auth**: bearer clear token từ credential file, verify qua hashed credential service.
- **Request**: `{ workspaceRoot, expectedInstanceId, clientKind, clientVersion }`.
- **Response**: `{ workspaceRoot, instanceId, protocolVersions, daemonVersion }`.
- Mismatch trả 409 `daemon_identity_mismatch`; không tiếp tục call.

### 7.9 Attachment endpoints

- `POST /api/bridge/v1/attachments` → `{attachmentId,heartbeatEveryMs,expiresAt}`.
- `PUT /api/bridge/v1/attachments/:id` renew; `DELETE` detach.
- Attachment id random 256-bit, bound credential+instance; stale expires automatically.

### 7.10 `POST /api/bridge/v1/tools/:name`

- `name` validate exact Tool Registry allowlist.
- Request `{input, protocolVersion, requestState?}`; schema validate bằng ToolDefinition.
- Response là stable domain result trước era stamp; remote MCP server stamps theo negotiated era.
- Destructive approval giữ nguyên; actor agent; daemon audit.

### 7.11 Daemon health/readiness

- `/api/v1/health`: process/listener alive, dùng cho browser.
- `/api/bridge/v1/ready`: bearer, trả instance/workspace/lease held; discovery validation dùng endpoint này, không dùng health trần.

### 7.12 `vidcom doctor`

```text
vidcom doctor [--workspace <path>] [--json] [--repair] [--deep]
```

- `--repair` phải tường minh; `--json` stdout chỉ một DoctorReport; human output stderr.
- Exit `0` khi mọi required check ok, `1` khi required missing/broken, `2` cho CLI input/internal report failure.

### 7.13 `vidcom render`

```text
vidcom render <project-id-or-slug> [--workspace <path>] [--preset <id>]
              [--detach] [--json]
```

- **Phân biệt id với slug**: `ProjectId` có dạng `project_<uuid>` (xem `projects/*/vidcom.json`). Giá trị khớp `^project_[0-9a-f-]{36}$` được xử lý là **id**; mọi giá trị khác là **slug** và resolve qua `resolveProjectIdBySlug` ([`project-reads.ts:290`](../../../../packages/core/src/usecase/project-reads.ts#L290)). MUST NOT thử id trước rồi fallback slug — một slug tình cờ trùng dạng id sẽ im lặng trỏ sai project.
- **Workspace khi không truyền `--workspace`** — thứ tự thật của code hôm nay, **không** phải thứ tự bản nháp trước ghi:

  | # | Nguồn | Ghi chú |
  |---|---|---|
  | 1 | `--workspace`, hoặc `VIDCOM_WORKSPACE` (env thắng file — [steering 07 §0](../../../steering/07-data-and-storage.md)) | cả hai vào cùng nhánh `explicit` |
  | 2 | **`cwd` có `vidcom.json`** | `cwd-project` → lấy thư mục **cha**; `cwd-solo` nếu cha không đọc được |
  | 3 | `active_workspace` trong app-data | |
  | 4 | `cwd` đọc được, không marker | ← nhánh `vidcom render` **MUST NOT** dùng |

  Bản nháp trước viết `active_workspace` **trước** `cwd` có marker. Đọc [`workspace-resolver.ts:45-54`](../../../../packages/core/src/domain/workspace-resolver.ts#L45) thì ngược lại: `cwd` có marker thắng `active`. Sai chiều này không vô hại — người dùng đứng trong thư mục project A, có `active_workspace` trỏ B đã lưu từ trước, gõ `vidcom render`: theo code thì render A, theo bản nháp thì render B. Đó đúng là kiểu "render nhầm chỗ" mà mục này sinh ra để chặn.
  > Doc comment của [`selectWorkspace`](../../../../packages/cli/src/workspace-selection.ts#L33) cũng ghi *"explicit -> saved active -> marker-backed cwd"*, tức **nó mô tả sai chính hàm nó đứng trên** — nhiều khả năng là nguồn của nhầm lẫn này. Sửa comment đó là việc một dòng, nằm ngoài phạm vi spec nhưng nên làm cùng lúc.

  Khác một chỗ so với hành vi hôm nay và là chỗ quan trọng: `vidcom render` **MUST NOT** nhận hàng 4 (`cwd` không marker) làm workspace (hành vi §1.5d của Goals). Không resolve được ⇒ exit `2` kèm thông điệp nói rõ cách chỉ định, MUST NOT lặng lẽ render vào một thư mục tình cờ.
- **`selectWorkspace` hôm nay ghi `active_workspace` như tác dụng phụ** ([`workspace-selection.ts:55-61`](../../../../packages/cli/src/workspace-selection.ts#L55)) — mọi lần resolve đều `set("active_workspace", …)`. Điều đó nghịch §6.4 ("chỉ ghi sau foundation swap thành công") và cho ra một hành vi bất ngờ: chạy `vidcom render --workspace X` một lần là **đổi workspace mặc định của UI** sang X. Giai đoạn 4 SHALL tách phần ghi đó ra khỏi resolve: chỉ `FoundationManager.activate` thành công mới ghi. Đây là **thay đổi hành vi có chủ ý**, không phải bất biến được giữ nguyên, nên nó phải nằm trong checklist chứ không phải được phát hiện lúc code.
- **Default**: ensure daemon, enqueue, poll với backoff, chờ terminal; thành công exit 0.
- `--detach`: return/print jobId ngay sau 202, exit 0. CLI **nhả attachment khi thoát** — daemon không tắt giữa render vì `activeWorkHold` suy từ job store giữ nó sống tới khi job terminal (§4.4), không phải vì attachment của một tiến trình đã chết.
- `Ctrl+C` lần đầu gửi cancel cho job do invocation này tạo, chờ bounded termination proof; lần hai thoát 130 và để daemon recovery.
- Exit: `0 succeeded`, `1 failed`, `2 input/connection`, `130 user cancel`. `cancelled` không gộp `failed`.
- JSON output stable `{jobId,status,result?,error?,warnings}`.
- **Idempotency key là bắt buộc ở wire, nên CLI phải chốt cách sinh nó.** `EnqueueRenderRequestSchema.idempotencyKey` là **required** (`z.string().min(1).max(255)`, [`delivery-loop-http.ts:29-33`](../../../../packages/contracts/src/delivery-loop-http.ts#L29)), và `JobStorePort.enqueue` trả `{ conflict: "idempotency_key_reused" }` khi cùng key đến với input khác. Hai lựa chọn cho khác nhau về hành vi người dùng: key **ngẫu nhiên mỗi lần gọi** ⇒ `vidcom render` chạy hai lần sinh **hai job**; key **suy tất định** từ (projectId, preset, bestEffort, revision) ⇒ lần gọi thứ hai **bám vào job đang chạy** thay vì xếp thêm. Design chốt **ngẫu nhiên mỗi invocation**, vì CLI là lệnh người dùng chủ động gọi và "chạy lại nghĩa là render lại" ít bất ngờ hơn; `--detach` in jobId để ai cần bám thì dùng `getJob`. MUST NOT để implementation tự chọn.
  Không nghịch [steering 08 §4](../../../steering/08-jobs-and-queue.md): luật ở đó ràng buộc **server** — *cùng key + cùng input ⇒ trả lại job cũ* — chứ không quy định client sinh key thế nào. Key ngẫu nhiên là key **khác**, nên hai job là hành vi đúng của cùng luật đó, không phải ngoại lệ.
- **Ánh xạ cờ sang field đã có**, không sinh contract thứ hai: `--preset <id>` → `renderPresetId`; `bestEffort` giữ default hiện tại của use case và **không** được expose thành cờ ở Giai đoạn 4 (thêm cờ là thêm public contract, ngoài phạm vi R3.3).
- **Khi UI đang mở nhưng chưa chọn workspace.** Một daemon ở trạng thái `NoWorkspace` **không publish discovery record** (§4.5), nên `vidcom render --workspace X` không thấy nó và sẽ tự spawn một daemon thứ hai giữ lease X — đúng luật, nhưng người dùng sau đó chọn X trong UI sẽ nhận `workspace_lease_held` từ `PUT /workspace/active` (§7.5). Đây là hành vi được chấp nhận của Giai đoạn 4, không phải bug; điều bắt buộc là **thông điệp phải nói được sự thật**: lỗi đó SHALL kèm `details.holder = {pid, startedAt}` đọc từ `workspace_lease`, và màn picker SHALL hiển thị nó dạng "workspace này đang được một tiến trình VidCom khác giữ" kèm hướng dẫn, MUST NOT hiện lỗi chung chung. Bàn giao lease giữa hai tiến trình là Giai đoạn 6 (D8).

### 7.14 `vidcom version`

- Human + `--json`; gồm VidCom version, HyperFrames version, build commit, platform tag, runtime manifest version.

### 7.15 `POST /api/v1/projects/imports`

- **Request**: `{sourceToken,targetName?}`; token từ filesystem browser, không raw path từ UI.
- **Response 202**: `{jobId}` vì import có thể lâu; import dùng existing job infrastructure type `project-import` và application service ở daemon.
- **Idempotency**: khoá ở **application layer**, không dựa vào unique index của DB. Lý do cụ thể: `uniqueIndex("uq_job_idempotency")` scope theo `(project_id, type, idempotency_key)` ([`schema.ts:274`](../../../../packages/adapter/src/db/schema.ts#L274)) và `project_id` **là NULL** cho tới khi import hoàn tất — mà SQLite coi mọi NULL là **khác nhau** trong unique index, nên constraint đó **không** chặn được import trùng.
  Nên `ProjectImportService` SHALL lookup trước khi enqueue theo khoá nghiệp vụ `(workspaceRoot, sourceCanonicalIdentity, targetName)`: nếu đã có job non-terminal khớp thì **trả lại jobId đó** thay vì tạo job mới; nếu có job terminal thành công thì trả 409 `project_import_conflict` vì target đã tồn tại. Lookup chạy dưới workspace lease nên hai request song song không cùng thắng.
- Source outside workspace only; overlap/target exists returns 409/422 trước enqueue.

## 8. Error Handling

### 8.1 Error Categories

| Code/category | Surface | Strategy |
|---|---|---|
| `runtime_manifest_invalid` | boot/doctor | fail before extraction; repair only with embedded verified asset |
| `runtime_extraction_incomplete` | boot/doctor | ignore no-marker target; remove/quarantine temp and retry |
| `bootstrap_lock_timeout` | boot | bounded failure with owner diagnostics, no parallel migration |
| `workspace_busy` | switch | 409, list active job ids/types; do not cancel silently |
| `workspace_lease_lost` | HTTP/MCP | reject writes immediately and drop the discovery record; bounded re-acquire (DR-14); on failure degrade to no-workspace when a UI is attached, close the listener when headless |
| `daemon_identity_mismatch` | bridge | discard record, bounded rediscovery; never send mutation |
| `daemon_unavailable` | bridge/CLI | one ensure attempt, then stable error; no infinite loop |
| `bridge_credential_unavailable` | bridge/CLI | credential file missing/unreadable; point at `doctor --repair`; never mint client-side |
| `bridge_credential_invalid` | bridge/CLI | 401 after exactly one credential re-read; stop, do not loop |
| `bridge_rotation_in_progress` | credential CLI/doctor | credential lock held past the bounded wait; report the owner, never rotate without the lock |
| `download_tls_untrusted` | Chrome/model/doctor | TLS interception, not offline; name it and point at `runtime.caBundlePath` |
| `payload_too_large` | upload | 413 with the real limit in `details`; never bare disconnect |
| `path_timeout` | picker | terminate browse worker, actionable UI error |
| `compiler_unavailable` | render/doctor | timeout with env/path diagnostics, no hang |
| `download_unavailable` | Chrome/model | fail job with retry hint; warm offline must still pass |
| `project_import_conflict` | import | abort staging/recovery, original untouched |
| `process_termination_unverified` | cancel | failed, not cancelled; preserve proof |

### 8.2 Response Strategy

- Giữ một `{error:{code,message,field?,details?}}` cho HTTP/MCP/CLI JSON.
- Retry chỉ cho discovery read, attachment heartbeat và transient download; mutation/tool call không auto-retry nếu chưa có idempotency key.
- Startup failure trước listener in structured stderr; failure sau listener hiển thị bootstrap UI.
- Workspace switch failure cố rollback old foundation; rollback failure về no-workspace thay vì giữ half-active app.

### 8.3 Logging & Observability

- Structured stderr/app-data log: process instance, workspace hash (không raw path ở info), phase, duration, outcome.
- Audit vẫn chứa actor/protocol/tool; bridge handshake/attach là operational log, không tool audit.
- Redact bearer, nonce, settings content, prompt/file contents.
- Build log ghi archive/version/hash, không ghi secret hay absolute source root vào artifact manifest.

## 9. Non-Functional Requirements

### 9.1 Performance

**Ngưỡng fail startup — deliverable của R4.9.** Đo từ process start tới listener nhận request đầu tiên, **không tính** thời gian tải Chrome/weights (đó là `download_unavailable`, đường khác).

**Đo trên flow nào**: §4.5 có hai flow và chúng làm hai khối lượng công việc khác nhau, nên một con số không nói được gì nếu không nói flow. Trần dưới đây áp cho **`serve --workspace`** — đường dài nhất (extract → migrate → lease → foundation → listener) và là đường mà bridge/render phụ thuộc. Flow `app` chưa-có-workspace được đo **riêng**, tới lúc listener phục vụ được `/v1/system/*`, và dùng **cùng trần cold** (nó chạy cùng phần extract/migrate) nhưng warm ceiling riêng vì không dựng foundation.

| Runner | Cold `serve --workspace` | Warm `serve --workspace` | Warm `app` (tới `/v1/system/*`) |
|---|---:|---:|---:|
| macOS arm64 | **≤ 120 s** | **≤ 3 s** | **≤ 2 s** |
| Linux x64 | **≤ 120 s** | **≤ 3 s** | **≤ 2 s** |
| Windows x64 | **≤ 180 s** | **≤ 5 s** | **≤ 3 s** |

Cột thứ ba là flow chưa-có-workspace: nó dừng ở listener nên không gánh lease + foundation, vì vậy trần warm chặt hơn. Cold thì hai flow dùng chung cột đầu vì cùng chạy `extract → migrate`.

Windows nới hơn vì antivirus quét file vừa giải nén — stack Python (**481 MB darwin / 499 MB Windows / 595 MB Linux** sau khi gỡ `pip`) là phần lớn thời gian cold. Exact packaged smoke `0fdbd35` đã chốt trần tạm bằng số runner thật: Linux cold/warm `serve --workspace` **1.007/1.004 s**, doctor cold/warm **23.974/6.201 s**, toàn job **10m12s**; Windows cold/warm serve **2.637/2.461 s**, doctor **133.284/11.883 s**, toàn job **21m30s**. Vì cả flow serve lẫn diagnostic cold đều còn dư địa lớn, giữ Linux **120 s** và Windows **180 s**; đây là quyết định theo evidence, không phải giữ nguyên bảng theo mặc định. Hai gate độc lập, cả hai đều fail được:

1. **Trần cứng** — vượt bảng trên ⇒ packaged smoke **fail**. Đây là số duy nhất chặn release.
2. **Chặn hồi quy** — mỗi runner ghi baseline ở lần smoke xanh đầu tiên; lần sau vượt **1,5 ×** baseline của chính runner đó ⇒ fail, kể cả khi còn dưới trần.
   **Baseline lưu ở `.github/perf-baseline/<runner-label>.json`, commit vào repo.** Không dùng CI cache: cache hết hạn thì gate im lặng biến mất, mà một gate tự tắt thì tệ hơn không có gate. Đổi baseline chỉ qua PR tường minh — nó là thay đổi ngưỡng, phải có người duyệt.

**Số đã đo trên Windows thật** ([S9](../../../../spikes/phase-4/s9-windows-runtime/README.md)): giải nén archive Python `155,2 MB nén → 510 MB` mất **26,9 s**, **đã bao gồm quét on-access** — máy đo chạy **Sophos Intercept X** với real-time protection bật (Defender tắt là vì Sophos sở hữu vai trò đó, không phải vì máy không có AV). Hosted runner evidence ở trên nay là authority cho trần CI; phép đo S9 còn giá trị giải thích vì sao Windows được 180 s thay vì bị ép theo macOS.

Trần cold giữ từ topology đã đo: SEA base 116 MB, archive Python 146 MB nén → 492 MB giải nén (§5.13). Sau remediation archive/native closure, exact isolated hosted-runner artifact `b4ba4ce` đo serve cold/warm: macOS **4.061/3.646 s**, Linux **7.223/7.022 s**, Windows **11.792/11.508 s**. Warm boot hiện authenticate generation khoảng 638 MB/8067 file ở outer SEA rồi inner CLI bootstrap; baseline cũ `0fdbd35` có trước topology này nên không còn đại diện. Giữ regression gate **1,5×** và đặt hard warm ceiling ở quantum 1 giây kế trên giới hạn đó: **6/11/18 s**; cold ceiling vẫn **120/120/180 s**. Warm-app **2/2/3 s** giữ nguyên vì chưa có measurement authority tương đương trong M.3a.

> Cả hai con số kích thước ở trên đo **khi stack còn `pip`**. §5.13 đã gỡ nó (−12 MB đo trên Windows), nên lần smoke đầu tiên của mỗi runner MUST ghi lại con số sau khi gỡ và cập nhật mục này.

- Bootstrap warm không extract lại archive; chỉ đọc manifest/marker và bounded integrity checks.
- Static asset host không base64-decode mỗi request; dùng packed raw bytes + immutable hash cache.
- Picker tối đa 500 entries/page, concurrency 2, timeout mặc định 5s; cursor stable trong một session page sequence.
- Bridge handshake/attachment deadline 5s; tool timeout theo tool/job contract.
- Smoke jobs tách khỏi static checks; cache ~1.7 GB theo version để không download mỗi run.

### 9.2 Security

- Listener bind literal `127.0.0.1`; giữ Host/origin/session middleware.
- Bridge bearer file/app-data directory có 0600/0700 hoặc current-user ACL. Threat model không hứa chặn process cùng user.
- Picker tokens bind session, canonical path và TTL; path revalidate mỗi operation; worker trả metadata tối thiểu.
- Archive extraction reject traversal/link/special file dù archive build nội bộ.
- Shim chỉ import path dưới verified runtime root; child process dùng args array.
- Không secret/sourcemap/source rời trong bundle; frontend không chứa dev origin.
- **Xác minh TLS không bao giờ bị tắt.** `runtime.caBundlePath` chỉ **thêm** một CA do người dùng chỉ định (§5.13); hệ thống MUST NOT đặt `NODE_TLS_REJECT_UNAUTHORIZED=0`, MUST NOT dùng `verify=False` ở sidecar, và MUST NOT tự nhặt CA từ trust store của OS. Một MITM chỉ được tin khi người dùng viết đường dẫn ra, và `doctor` phải nói được là đường dẫn đó đang có hiệu lực.

### 9.3 Availability and Recovery

- Runtime extraction/migration idempotent qua lock+marker+manifest.
- Foundation stop, listener close, watcher/scheduler stop đều idempotent.
- Discovery record stale không authority; handshake là gate cuối.
- Import và runtime temp có marker/recovery; không xoá directory lạ.
- Mất lease **không** để lại một writer thứ hai, dù tiến trình còn sống: từ giây đầu, ghi đã bị từ chối và discovery record đã biến mất, nên cả cửa sổ re-acquire lẫn trạng thái `NoWorkspace` sau đó đều không phục vụ được đường ghi nào (DR-14). Daemon headless vẫn dừng hẳn vì không có UI nào cần giữ listener cho.

### 9.4 Observability / Release Evidence

- SLI: cold/warm startup duration, extraction bytes, handshake latency, render job terminal result, leaked process proof, cache hit/miss.
- Mỗi packaged-smoke job upload DoctorReport, artifact manifest, SHA256SUMS, ffprobe result và platform metadata.
- Không dashboard/telemetry ngoài máy trong Giai đoạn 4.

## 10. Design Decisions

### DR-1: Node SEA native build per target runner

**Context**: native addons/runtime assets và code cache không portable.

**Options**: cross-build từ macOS; Bun compiled; native Node SEA.

**Decision**: native Node SEA trên runner cùng OS/arch, CJS bundle, code cache/snapshot off.

**Rationale**: Phase 0/4 evidence và R8.5.

**Implications**: ba build jobs; no claim cho artifact chưa smoke.

### DR-2: Runtime archives in SEA, extracted to app-data

**Options**: ship directory cạnh executable; load native direct from SEA; embedded tar archives.

**Decision**: verified tar.gz archives + manifest, atomic extraction to versioned app-data.

**Rationale**: one-file UX, native files cần real path, spike cold/warm PASS.

**Implications**: bootstrap lock, marker, doctor repair, archive security tests.

### DR-3: Static sentinel shell for runtime slugs

**Options**: query-only route; enumerate projects at build; sentinel shell.

**Decision**: `__shell` server page + client child + host mapping HTML/RSC; slug from location.

**Rationale**: project runtime-created, S2 PASS.

**Implications**: golden mapping tests; RSC export format pinned to Next version.

### DR-4: Listener outside workspace foundation

**Options**: restart listener per workspace; mutate Hono routes; mutable current app target.

**Decision**: stable Node listener reads mutable Hono app reference; foundation swap under mutex.

**Rationale**: preserves session/port and S6 evidence.

**Implications**: explicit switching/no-workspace states and rollback.

### DR-5: Loopback HTTP bridge with file discovery and identity handshake

**Options**: raw port record; Unix socket/named pipe; loopback bearer+handshake.

**Decision**: loopback HTTP, non-secret discovery file, bearer file, canonical workspace+instance handshake.

**Rationale**: reuse tested MCP credential/perimeter; S7 proves raw port unsafe; Windows socket unverified.

**Implications**: socket remains fallback only after Windows spike.

### DR-6: Remote ToolInvoker, not arbitrary HTTP proxy

**Options**: raw MCP byte proxy; duplicate tool definitions; same definitions + remote invoker.

**Decision**: ToolDefinition registry reused in bridge, handlers invoke allowlisted daemon tool endpoint.

**Rationale**: preserves dual-era SDK behavior and one contract source without exposing arbitrary HTTP.

**Implications**: daemon remains audit/execution authority; contract parity tests mandatory.

### DR-7: Daemon-owned attachment leases

**Options**: bridge-owned refcount file; persistent DB count; daemon in-memory TTL attachments.

**Decision**: daemon owns in-memory attachment leases + heartbeat; auto-start owner policy.

**Rationale**: abrupt bridge death cannot permanently leak count; count is ephemeral, not business data.

**Implications**: short expiry/grace; UI/manual owner prevents shutdown.

### DR-8: `vidcom render` waits by default, supports detach

**Options**: always return jobId; execute locally; daemon enqueue + wait/detach.

**Decision**: thin daemon client; default wait, `--detach` explicit.

**Rationale**: CI/batch expects terminal exit code; daemon must remain sole authority.

**Implications**: Ctrl+C cancellation and distinct exit codes are public contract.

### DR-9: SEA Node-host shim for HyperFrames CLI

**Options**: naive `[execPath,cli]`; ship Node sidecar; `--vidcom-node` shim.

**Decision**: shim with verified extracted CLI path.

**Rationale**: S1a/S4 PASS, 0 MB extra, supervisor remains valid.

**Implications**: hidden dispatch before parser; packaged cancel-tree test.

### DR-10: No new daemon/refcount SQLite table

**Options**: `daemon_instance` table; app_settings JSON; atomic operational files + memory.

**Decision**: discovery/runtime state in protected app-data files; attachment refcount in daemon memory. SQLite only changes import operation kind.

**Rationale**: bridge must discover before DB migration/write authority, state is ephemeral/rebuildable.

**Implications**: strict file schema/ACL/stale cleanup; DB remains business/authority store.

### DR-11: Three baseline platforms; Linux defer is a new scope decision

**Decision**: design and checklist baseline include macOS arm64, Windows x64, Linux x64. Windows cannot be cut. Linux defer is not an implementation shortcut; it reopens Goals/release claim.

**Rationale**: OQ-7 approved wording.

**Implications**: traceability/test matrix includes all three until explicit scope change.

### DR-12: UI API through one http-driver catalog

**Options**: retain raw relative fetch; wrapper per component; one service catalog.

**Decision**: one fetch-based driver with runtime base URL and SSE support.

**Rationale**: static artifact/dev cross-origin, R4.10, avoids duplicate error/credential logic.

**Implications**: no automatic version injection; all callers check `ResponseFormat.ok`; W-1 browser harness.

### DR-13: Import is async project-import job with same-filesystem staging

**Options**: synchronous request copy; app-data staging; workspace sibling staging job.

**Decision**: job + workspace sibling temp + workspace_operation recovery.

**Rationale**: import duration unbounded; rename atomic only same filesystem; original untouched.

**Implications**: schema enum migration and cleanup/recovery tests.

### DR-14: Bounded re-acquire, then degrade to no-workspace when a UI is watching

**Context**: the original R2.14 allowed only *re-acquire* or *stop including closing the listener*, so losing a workspace lease killed a UI that has nothing to do with that workspace — even though DR-4 deliberately put the listener and session outside the foundation.

**Options**: (a) terminal stop as originally written; (b) bounded re-acquire, then terminal stop; (c) bounded re-acquire, then drop to `NoWorkspace` with the listener alive.

**Decision**: (c), with a headless carve-out — no UI attachment means (b). This required amending R2.14 in the approved Goals; the amendment was approved 2026-08-07 rather than taken unilaterally.

**Rationale**: the common causes (machine resumed from sleep, momentary SQLite contention) are recoverable inside the lease TTL and nobody has stolen the lease yet, so re-acquire absorbs them. The residual case — another VidCom process genuinely took over — is rare and destroys no data, because writes were already refused; killing the whole process there buys nothing a bootstrap screen does not. A headless daemon has no screen to show, so degrading it would leave a zombie listener for bridge/render to trip over.

**Implications**: the discovery record is removed on the *first* renew failure, not after the retries, so no client attaches to a daemon that may be about to die. `currentApp` reverts to the bootstrap app, which does not register `/api/bridge/**` at all — the single-writer guarantee rests on route absence plus a stopped foundation, and §11.3 must prove both rather than assert them.

### DR-15: Per-platform Python pin lists, measured not derived

**Context**: §5.13 pinned one 56-package list measured on darwin arm64 and made drift a build failure, while DR-11 requires Windows and Linux builds.

**Options**: one cross-platform list with an escape hatch; loosen the drift rule to a warning; core list plus a measured per-platform supplement.

**Decision**: core plus measured supplement. Core is **55** after `pip` is dropped; Windows is `core + colorama + tzdata` = **57**.

**Rationale**: measured on a real Windows install ([S9](../../../../spikes/phase-4/s9-windows-runtime/README.md)) — both extras are required dependencies of packages already in the core (`click`/`tqdm` marker, `pandas` timezone data), and all **55 retained core packages** matched darwin version-for-version. Loosening the rule to a warning would discard the reason the rule exists.

**Implications**: a platform with no measured row fails its own build job rather than falling back to the core list; Linux must be measured before its release gate turns on.

## 11. Testing Strategy

### 11.1 Testing Levels

| Level | Scope | Tools |
|---|---|---|
| Unit | manifest, resolver, tokens, handshake compare, doctor aggregate, CLI parse/exit, import plan | Vitest |
| Contract | every new HTTP/bridge DTO, remote/local Tool Registry parity, doctor JSON | Hono request + schema/golden |
| Integration | real SQLite + temp fs: bootstrap lock, extraction, migration, discovery ACL, switch rollback, import recovery | Vitest/Node real adapters |
| Browser | nonce/session, dev cross-origin W-1, picker/New video, dynamic studio shell | real browser harness |
| Process | auto-start race, lease loss **hai nhánh** (UI → `NoWorkspace` giữ listener; headless → đóng listener, exit ≠ 0), attachment expiry, shim, cancel tree | child_process + existing supervisor proof |
| Packaged | binary cold/warm full loop on each native runner | workflow shell/PowerShell + ffprobe |

### 11.2 Persistence Verification

- Migrate a copied Phase 3 SQLite fixture; compare row counts/kinds, FK check and schema drift.
- Two processes cold-start same app-data: exactly one extraction/migration critical section; both reach correct daemon/bridge outcome.
- Runtime marker written last; kill at each extraction phase, next boot repairs without trusting partial target.
- Switch workspace proves old lease released, new lease held, `active_workspace` written only after swap; failure rolls back.
- Import kill after begin/copy/validate/rename; recovery reaches committed project or clean abort, original unchanged.
- No mocks of `node:fs`; symlink/EXDEV/Windows locks tested where OS supports.

### 11.3 Must-cover Scenarios

- Archive traversal/link/special-file rejection and executable mode/ACL.
- Discovery port hijack/instance mismatch; stale record; daemon lost after handshake.
- Two bridges auto-start simultaneously; loser connects winner; last bridge detach stops only auto daemon.
- Lease loss rejects writes and drops the discovery record immediately; then **UI branch** degrades to `NoWorkspace` with the listener alive and `/api/bridge/**` absent, **headless branch** closes the listener and exits non-zero. In both branches no second writer remains reachable (DR-14).
- Picker 200k-entry pagination, permission, timeout, token/session mismatch, TOCTOU symlink change.
- New video success, invalid name, duplicate slug, double submit; no backend capability added.
- Static host exact/implicit/sentinel/RSC mapping, MIME/cache/404/traversal.
- `--vidcom-node` rejects script outside runtime root.
- Missing either esbuild env causes bounded error in test harness, never hang.
- Browse worker dạng **file path** fail có mã trong SEA harness (dạng eval là dạng duy nhất được phép — §5.2).
- `vidcom render` gọi hai lần sinh **hai job** phân biệt; `--detach` + `getJob` bám đúng job đã in.
- `--detach` rồi CLI thoát: daemon **không** tắt giữa render (work hold suy từ job store), và tắt sau grace period khi job terminal.
- Import gọi hai lần cùng `(workspaceRoot, source, targetName)` trả **cùng jobId**, không tạo job thứ hai — chứng minh app-level lookup, vì unique index không chặn được khi `project_id` NULL.
- Cùng một frontend bundle chạy same-origin (artifact) và cross-origin (dev) chỉ bằng runtime config; SSE giữ cookie và abort khi dispose.
- `vidcom render` với `cwd` không có marker và không có `--workspace` ⇒ exit 2, không render nhầm thư mục.
- Chrome/model cold download then warm offline; W-3 real no-network error.
- **Chrome cache bị cắt cụt (partial) SHALL bị `doctor` bắt** — dựng lại đúng phép đo S9: truncate binary rồi chứng minh check fail, vì `hyperframes browser path` vẫn trả exit 0 cho nó.
- **Cookie cross-origin dev**: cùng hostname hai đầu ⇒ `Strict` sống qua fetch **và** SSE; khác hostname ⇒ dev host **fail lúc boot**, MUST NOT chạy tiếp rồi mất session im lặng.
- **Bearer bootstrap**: `vidcom mcp` trên app-data hoàn toàn trống tự khởi động daemon, daemon mint credential trước khi publish record, ghi `app_settings.bridge_credential_id`, bridge handshake thành công; xoá credential file ⇒ `bridge_credential_unavailable`.
- **Xoay bearer — đường vui**: `rotate --bridge` trong lúc một bridge đang chạy: lời gọi **đang bay** bằng token cũ vẫn qua trong cửa sổ 60 s, nhưng `attach`/`renew` bằng token cũ trả `bridge_credential_invalid` **ngay**, và client đọc lại file một lần rồi nối lại thành công.
- **Xoay bearer — kill ở từng ranh giới.** Mỗi hàng là một test riêng; không hàng nào suy được từ hàng khác, và mỗi hàng SHALL kết thúc bằng một bridge **nối lại được**:

  | Kill sau bước | Khởi động lại lúc | Reconciliation phải làm gì | Khẳng định |
  |---|---|---|---|
  | 1 — DB rotate | **trong** 60 s | revoke replacement mồ côi (tìm qua `rotated_from`), xoay lại từ token trong file | bridge cầm token cũ vẫn chạy rồi nhận token mới; đúng **một** row `active` mang label `system:bridge` |
  | 1 — DB rotate | **sau** 60 s | không còn credential dùng được ⇒ **mint mới** | file + `S` cùng trỏ credential mới; `doctor` báo bearer đã đổi; không row `active` mồ côi nào sót |
  | 2 — ghi file | bất kỳ | **roll forward**: đặt `S` = id của credential khớp hash trong file | **không** mint; id trong `S` đúng bằng id của token trong file |
  | 3 — cập nhật settings | bất kỳ | không làm gì | attachment cũ trượt ở `renew` kế tiếp, tự lành |

  Cộng một test cho trường hợp **file bị xoá** ở mọi thời điểm ⇒ mint mới, và một test khẳng định `hash(F)` khớp row `revoked` cũng đi nhánh mint chứ không nhánh roll-forward.
- **Hai `rotate --bridge` song song** ⇒ khoá `<app-data>/credential.lock` serialize chúng: đúng một lần ghi file tại một thời điểm, kết thúc file và `S` nhất quán; kẻ chờ quá hạn nhận `bridge_rotation_in_progress`. Và một test cho race thật sự nguy hiểm: **bootstrap reconciliation chạy đè lên một `rotate` đang dở** phải bị khoá chặn, không được "chữa" một trạng thái đang được cố ý thay đổi.
- **`credential revoke <id-của-bridge>`** ⇒ **bị từ chối** kèm hướng dẫn, và `app_settings.bridge_credential_id` không đổi.
- **`doctor --repair` khi file mất** ⇒ **mint mới** (không phải khôi phục), file + `app_settings` cùng trỏ credential mới, và báo rõ bearer đã đổi.
- **Auto-shutdown**: daemon `--ensure` không attachment + không job ⇒ tắt sau grace 60 s; cùng daemon đó sau khi có một attachment `kind: "ui"` ⇒ **không bao giờ** tự tắt; daemon do `app`/`serve` chạy tay ⇒ không bao giờ tự tắt.
- **Mất lease** — đây là nghĩa vụ chứng minh của DR-14, không phải một test lệ:
  - renew fail ⇒ discovery record biến mất **ngay**, ghi bị từ chối **ngay**, `workspace.lease_lost` phát ra **trước** khi đổi trạng thái;
  - re-acquire thành công ⇒ về `Active` với **cùng `instanceId`**, record được publish lại;
  - re-acquire fail **có UI attach** ⇒ về `NoWorkspace` mà listener/session vẫn sống; và **ba vế của bug cũ phải cùng lúc sai**: `POST /api/bridge/v1/tools/*` trả **404 vì route không tồn tại** (không phải 403/503 từ một route còn đăng ký), foundation đã stop (scheduler/watcher/DB handle đều đóng), discovery record vắng mặt;
  - re-acquire fail **headless** ⇒ listener đóng, exit ≠ 0;
  - và ở cả hai nhánh: tiến trình **đã cướp được lease** là writer duy nhất — một tool ghi qua nó thành công trong khi tiến trình cũ từ chối.
- **Upload 20 MB BGM đi qua host SEA** và SSE progress của job dài không bị buffer (R4.6); 21 MB trả `413 payload_too_large` kèm giới hạn thật.
- **Tập package Python đúng bằng core + phần phụ của platform đang build**; thừa hay thiếu một package đều làm build fail. `pip` **có mặt là fail** — nó là công cụ build, không được ship.
- **Sidecar in và đọc lại đúng tiếng Việt** trên máy có codepage ANSI không phải UTF-8 (đặt `PYTHONUTF8=""` để mô phỏng bị mất biến ⇒ test SHALL fail có mã, không được ra chuỗi hỏng). Đây là chế độ hỏng đo được ở S9/N-2.
- **Mọi child process đi qua `allowlistedEnvironment`**: một test liệt kê các điểm spawn và chứng minh không điểm nào tự dựng env — nếu không, hai bảo vệ UTF-8 và caBundlePath biến mất mà không ai thấy.
- `download_tls_untrusted` phân biệt được với `download_unavailable`, và `runtime.caBundlePath` đi tới cả sidecar Python lẫn child Node.
- Source/sourcemap/dev-origin/secret/build-root scan.

### 11.4 Packaged Smoke Matrix

Mỗi native runner thực hiện cùng script logic với OS-specific shell wrapper:

1. Build artifact và checksum.
2. Tạo clean HOME/app-data/workspace; PATH chỉ chứa OS essentials, không Node/Python.
3. Restore Chrome/HF download caches vào vị trí tường minh; app-data/runtime vẫn rỗng.
4. `version`, cold `doctor --repair`, warm `doctor --deep`.
5. Start app/serve, exchange nonce/session, picker activate workspace, create project từ preset.
6. Import fixture ngoài workspace.
7. MCP bridge trong lúc UI daemon sống: read/write, restart, state giữ nguyên, stale handshake reject.
8. TTS WAV, snapshot, render MP4; ffprobe codec/duration/audio. **Trên Windows đây là bằng chứng đầu tiên cho TTS** — S9 không tạo được vì mạng đo có TLS inspection (§5.13 N-1), nên bước này MUST NOT được suy từ kết quả darwin.
9. Upload BGM 20 MB và đọc SSE progress của một job dài qua host SEA (R4.6).
10. `vidcom render` wait, detach, cancel-mid-render. Bằng chứng huỷ SHALL là **termination proof có cờ `exhaustive`** đúng luật [steering 08 §6.1](../../../steering/08-jobs-and-queue.md), MUST NOT phát biểu thành "không còn process con nào sống sót": steering đã **rút lại** bảo đảm đó vì không nền tảng nào cung cấp được nó bằng Node thuần. Còn survivor sau khi cạn lượt verify ⇒ `process_termination_unverified`, MUST NOT ghi `cancelled`. Bước này SHALL kiểm thêm **tầng chứa thứ hai**: workdir có marker của job vẫn thu hồi được thứ lọt qua, kể cả khi shim của §4.6 chèn thêm một tầng tiến trình.
11. Cắt mạng **ở tầng mạng của runner** rồi chạy warm render/TTS offline. Đặt `HTTPS_PROXY`/`HTTP_PROXY` MUST NOT được coi là cắt mạng: S9 đo được downloader **lờ hẳn** hai biến đó và vẫn tải 202 MB, nên một bước offline viết bằng env sẽ xanh vì lý do sai.
12. Lease loss injection: write bị từ chối ngay, discovery record biến mất ngay, re-acquire có giới hạn; rồi **hạ về `NoWorkspace` với UI còn sống** (nhánh `app`) và **đóng listener + exit ≠ 0** (nhánh `serve` headless) — §4.3.
13. Scan artifact vicinity/app-data boundary; verify checksum/provenance.

Không step bắt buộc nào được skip. Linux job vắng mặt nghĩa là scope/release claim phải được duyệt lại, không phải CI xanh.

## 12. Traceability Matrix

| Goal | Design | Tests |
|---|---|---|
| R1.1–R1.10 | 5.2, 7.1–7.5, 9.2 | picker contract/integration/browser |
| R1.11–R1.18 | 4.3, 5.3–5.4 | no-workspace/switch/job-busy/rollback/lease tests |
| R1.19 | 5.11–5.12, 7.6 | New video UI success/failure/double-submit |
| R2.1–R2.3 | 4.4, 5.6–5.7 | local/remote registry parity + single writer |
| R2.4–R2.10 | 5.5–5.7, 7.8–7.10 | auto-start/race/auth/audit/events/multi-bridge |
| R2.11–R2.15 | 4.4, 5.7, 7.10 | allowlist, TTL/takeover, handshake hijack, lease loss, attachment refcount |
| R3.1–R3.4 | 5.8, 7.13–7.14 | CLI parse/help/render/version golden |
| R3.5–R3.13 | 5.9, 7.12, 8.1 | doctor registry/json/redaction/repair/concurrency |
| R4.1–R4.4 | 4.1–4.2, 5.10 | SEA boot/static host/no Node/node_modules |
| R4.5, R4.7–R4.9 | 5.10, DR-3, 9.1 | sentinel HTML/RSC/static export asset tests; cold/warm ceiling + regression baseline |
| R4.6 | Sec 7 (body limit), 11.4 bước 9 | SSE không buffer + upload 20 MB qua host SEA + 413 quá giới hạn |
| R4.10–R4.14 | 5.11, DR-1/DR-12 | http-driver base/SSE/dev-origin/CJS bundle tests |
| R5.1–R5.6 | 4.5, 5.13–5.15 | manifest/extract/marker/lock/cold-warm |
| R5.7–R5.14 | 5.13–5.18, 6.3 | path wiring/versions/ACL/migration order/Python pins |
| R6.1–R6.4 | 4.6, 5.16 | artifact render/shim/wrong-shape failure |
| R6.5–R6.9 | 4.6, 5.9, 5.18, 11.4 | TTS/Chrome cache/offline/cancel/version drift; UTF-8 env; TLS untrusted; partial-cache detection |
| R6.10–R6.11 | 5.17 | bundled imports/compiler env/timeout doctor probe |
| R7.1–R7.12 | 4.7, 5.19, 6.4–6.5, 7.15 | import plan/copy/recovery/overlap/symlink/Windows rename |
| R8.1–R8.8 | 4.8, 11.4 | three native packaged-smoke jobs |
| R9.1–R9.7 | 5.20, 9.2–9.4 | checksum/source scan/provenance/telemetry test |

## 13. Deferred Design Items

| # | Item | Why deferred | Target |
|---|---|---|---|
| D1 | x64 macOS, arm64 Linux/Windows matrix | PK-9 full matrix | Giai đoạn 6 |
| D2 | Real signing/notarization/installers | credentials/release infra | Giai đoạn 6 |
| D3 | Unix socket/named pipe default | Windows named pipe W-2 chưa verify; HTTP path đủ correctness | nếu HTTP discovery đau hoặc Giai đoạn 6 |
| D4 | Air-gapped Chrome/model seed | product/distribution scope mới | future offline spec |
| D5 | Public worker mode | chưa có measured isolation need | future operations spec |
| D6 | Tauri/native picker | browser picker đạt D3 | UX phase |
| D7 | HyperFrames multi-version runtime | R6 chỉ warning | Giai đoạn 6 |
| D8 | Bàn giao lease giữa hai tiến trình VidCom | §7.13 chỉ cần thông điệp nói đúng ai đang giữ | Giai đoạn 6 |

## 14. Quality Checklist

### Completeness

- [x] R1–R9 đều có component, contract và test mapping.
- [x] Persistence location/ownership/transaction/recovery được chỉ rõ.
- [x] Bảng modified `workspace_operation` có concrete columns/change/migration.
- [x] API browser, bridge, CLI và job import được khóa.
- [x] Error, security, performance, observability và packaged matrix có target.

### Clarity

- [x] Listener, foundation, daemon, bridge và runtime asset có owner riêng.
- [x] Mermaid phủ component, boot/switch, bridge, extraction, import, build.
- [x] W-1/W-2 đã đo trên Windows (S9); W-3 đóng một nửa, phần mất-mạng-thật vẫn là debt và **không** được ghi thành PASS.

### Decision Discipline

- [x] **15** quyết định vật chất có Context/Options/Decision/Rationale/Implications (DR-1…DR-15).
- [x] OQ-4/OQ-7/OQ-8 đã phản ánh wording được duyệt.
- [x] 18 quyết định nhỏ hơn được liệt kê ở §15 thay vì để ngỏ cho implementation.

### Consistency với code và steering

- [x] Mọi trích dẫn `file:line` được xác minh lại bằng codegraph, không lấy từ trí nhớ.
- [x] Bearer dùng lại `BridgeCredentialStore` + `<app-data>/credentials` đang có, không tạo đường dẫn mới (steering 09 §2).
- [x] Thứ tự resolve workspace ở §7.13 khớp `resolveWorkspace` thật, không khớp doc comment sai của `selectWorkspace`.
- [x] Hai chỗ đi khác steering được nêu tường minh ở §7.0, không đi vòng im lặng.
- [x] Key mới của `setting.json` được ghi là phải vào schema strict.
- [x] Đã quét **toàn bộ 14 file steering**, không còn file nào chưa đối chiếu.
- [x] Mỗi component mới có package đích và lý do (§5.0); import boundary do lint cưỡng chế được thoả — gồm chỗ `server` **không** được import `mcp`.
- [x] Bốn câu hỏi dependency của steering 01 §3 được trả lời cho cả hai dependency mới.
- [x] Không đường ghi nào nhận absolute path từ client (§7.5 chuyển sang token-only).

### Feasibility

- [x] SEA/HyperFrames/TTS/static shell dùng kết quả spike đã PASS.
- [x] Phần chưa chứng minh được bắt bằng packaged smoke trên OS đích.
- [x] Không thêm capability nghiệp vụ ngoài Goals. Ba bề mặt mới — `GET /v1/system/runtime`, bốn event, `runtime.caBundlePath` — đều là **diagnostics/cấu hình của host**, sinh ra để thoả một requirement đã có (R5.11, R2.14, R6.5), không mở thao tác mới trên project.

### Traceability

- [x] Mọi requirement map sang design/test ở Sec 12.
- [x] Không có design component mồ côi ngoài runtime cần để đạt R1–R9.
- [x] Implementation Checklist vẫn chưa tạo.

## 15. Approval Gate

> Do not create the implementation checklist or write production code until this section is explicitly confirmed.

- **Status**: **APPROVED** — bản 2 (2026-08-07), sau vòng review Design, vòng đo Windows/Linux [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md) và số đo darwin trên CI
- **Confirmed by**: alvin0
- **Confirmation date**: 2026-08-07
- **Phạm vi được duyệt**: 27 quyết định ở bảng dưới, hai quyết định phạm vi (R2.14 nới, N-1 trong phạm vi), và ước lượng **~177 SP**. Implementation Checklist **được phép tạo**; production code vẫn bị chặn cho tới khi chính checklist đó được duyệt.

**Đã chốt trong bản này** — không còn chờ quyết định, mọi thứ dưới đây đã có câu trả lời trong tài liệu:

| # | Món | Chốt ở đâu |
|---|---|---|
| 1 | `render` wait-by-default, `--detach`, Ctrl+C cancel, exit `0/1/2/130`, idempotency key **ngẫu nhiên mỗi invocation** | §7.13 |
| 2 | `workspace_operation.kind = project_import`, import chạy dưới job 202, idempotency khoá ở application layer | §6.4, §7.15 |
| 3 | Browser path token + POST query thay vì absolute path trong URL | §7.1–§7.3 |
| 4 | Ngưỡng startup: trần cứng theo OS + chặn hồi quy 1,5 ×, baseline commit vào `.github/perf-baseline/` | §9.1 |
| 5 | Danh sách Python là **core 55 + phần phụ theo platform** (Windows **57** = 55 + `colorama` + `tzdata`), build fail khi lệch | §5.13, DR-15 |
| 6 | Vòng đời bearer của bridge: daemon mint trong bootstrap, bền theo app-data, đọc lại đúng một lần khi 401 | §4.4 |
| 6b | Xoay bearer: danh tính qua `app_settings.bridge_credential_id`, overlap **60 s** (không phải 0), thứ tự DB → file → settings → revoke attachment, và attach so credential id nên token cũ không giữ được attachment. `revoke` id bridge bị từ chối; `doctor --repair` **mint mới** chứ không khôi phục | §4.4, §6.4 |
| 6c | Xoay bearer crash-safe: bất biến **file là secret duy nhất, DB/settings là projection**; reconciliation chạy **mọi boot** dưới `<app-data>/credential.lock`; replacement mồ côi nhận diện qua `rotated_from`; thứ tự khoá `bootstrap → credential` là luật | §4.4, §5.1, §5.15 |
| 7 | Attachment: heartbeat 5 s, TTL 20 s, grace 60 s; chỉ daemon `--ensure` được auto-shutdown và một lần có UI attach là mất quyền đó vĩnh viễn | §4.4 |
| 8 | Mất lease: re-acquire có giới hạn; thất bại thì **hạ về `NoWorkspace`** khi có UI, đóng listener khi headless. Record bị xoá ngay từ lần renew fail đầu | §4.3, DR-14 |
| 9 | Body limit 1 MiB, riêng upload 20 MiB; `413 payload_too_large` | §7 |
| 10 | `skipped` của doctor lấy từ bảng `job`/`app_settings`; trong smoke thì `skipped` trên mục required = fail | §5.9 |
| 11 | `chrome.cache` phải **chạy** binary, không tin đường dẫn do CLI trả về | §5.9 |
| 12 | Giải nén lần đầu chỉ có stderr/log; UI chỉ áp cho re-extract lúc daemon sống | §5.14 |
| 13 | Base URL dev chèn bằng script dev-only trong `layout.tsx`, không dùng `NEXT_PUBLIC_*` | §5.11 |
| 14 | `pip` bị gỡ khỏi stack ship đi (−12 MB đo được); `runtime.python` xác minh bằng `importlib.metadata` | §5.13 |
| 15 | `PYTHONUTF8`/`PYTHONIOENCODING` bị **ép** cho mọi child; không có nó thì tiếng Việt crash trên Windows locale không UTF-8 | §4.6, §5.16 |
| 16 | `gpu.cuda` bị bỏ khỏi bảng doctor — stack chỉ có `onnxruntime` CPU nên nó không bao giờ `ok` được | §5.9 |
| 17 | `trailingSlash: false` chốt tường minh vì nó quyết định toàn bộ bảng map của static host | §5.10 |
| 18 | Bốn event mới + `GET /api/v1/system/runtime` + state `reacquiring` vào contract, không để nằm trong văn xuôi | §7.4, §7.7, §7.7b |
| 19 | Bearer dùng lại `BridgeCredentialStore`/`<app-data>/credentials` đang có — không tạo `bridge.json` | §4.4 |
| 20 | Thứ tự resolve workspace sửa theo code thật (`cwd` có marker **thắng** `active_workspace`) | §7.13 |
| 21 | Tách việc ghi `active_workspace` ra khỏi `selectWorkspace` — đây là thay đổi hành vi có chủ ý | §7.13, §6.4 |
| 22 | Hai chỗ Design đi khác steering được nêu tường minh thay vì đi vòng | §7.0 |
| 23 | `runtime.caBundlePath` + `VIDCOM_CA_BUNDLE` phải vào schema strict của `setting.json` | §5.13 |
| 24 | Bảng **component → package** cho mọi component mới; `adapter/daemon` là thư mục mới trong `@vidcom/adapter`, `mcp` nhận `ToolInvoker` qua inject nên không thấy `server` **cũng không thấy `adapter`** | §5.0 hệ quả 4, §5.7 — *sửa 2026-08-07* |
| 25 | Route bridge bên `server` validate bằng schema từ `contracts`, không import `mcp`. Phần **di chuyển** schema đã xong từ trước; việc còn lại là **catalogue tên tool → schema** trong `contracts` | §5.0 hệ quả 1 — *sửa 2026-08-07* |
| 26 | `PUT /workspace/active` **chỉ nhận `selectionToken`** — bỏ nhánh `{path}`, vì không đường ghi nào được nhận absolute path từ client | §7.5 |
| 27 | Bốn câu hỏi dependency (steering 01 §3): Giai đoạn 4 thêm **đúng một** dependency thật là `tar@7.5.22`; `@hono/node-server@2.0.12` và `puppeteer-core@25.4.0` đã có sẵn trong repo. `packages/worker` giữ nguyên, không expose | §5.0 — *sửa 2026-08-07* |

**Hai quyết định phạm vi — đã được người dùng chốt ngày 2026-08-07:**

1. **R2.14 được nới.** Thêm lối thứ ba: mất lease mà re-acquire thất bại thì **hạ về `NoWorkspace`, giữ listener/session** khi có UI attach; headless vẫn đóng listener và thoát khác 0. Goals R2.14 đã sửa và ghi lý do; DR-14 viết lại; §4.3 có bảng chứng minh ba vế của bug cũ đều sai, và §11.3 biến nó thành nghĩa vụ test. **SP: R2 34→37.**
2. **N-1 nằm trong phạm vi Giai đoạn 4.** Mã lỗi `download_tls_untrusted`, doctor phân biệt được với mất mạng, `runtime.caBundlePath` + `VIDCOM_CA_BUNDLE` vào schema strict và đẩy xuống sidecar lẫn child Node. Không tự tắt xác minh chứng chỉ, không tự nhặt CA từ trust store OS. **SP: R6 21→25.**

Tổng ước lượng: **~170 → ~177 SP**.

**Trạng thái ba món nợ kiểm chứng** (cũ: W-1/W-2/W-3 chờ máy Windows):

- **W-1 — ĐÓNG** bằng harness Chrome thật. Kết quả vào §5.11.
- **W-2 — ĐÓNG một nửa**: transport PASS, nhưng Node không đặt được ACL cho named pipe ⇒ D3 giữ deferred với giá đã biết (cần native code), không còn là ẩn số.
- **W-3 — ĐÓNG một nửa**: bắt được hai chế độ hỏng im lặng (cache tải dở báo ok; `HTTPS_PROXY` bị lờ nên bước offline phải chặn ở tầng mạng). Chế độ mất mạng thật vẫn chờ runner CI.
- **Mới**: TTS ra WAV **trên Windows** chưa chứng minh được (N-1) — nó là bước bắt buộc của packaged smoke Windows.
- **Mới (N-2)**: encoding của interpreter đóng băng — đã đo, đã có luật ở §4.6, không còn là ẩn số.
- **Đã đo bổ sung (cùng ngày)**: `linux-x64` chạy trong container `linux/amd64` thật — **77 package, trùng khít darwin, prune còn đúng core 55**, nên phần phụ theo platform chỉ tồn tại ở Windows. Kích thước sau prune **595 MB / 179 MB**, nặng hơn darwin ~24 %; exact packaged evidence ở §9.1 sau đó xác nhận giữ trần cold 120 s.
- **Đính chính**: phép đo giải nén 26,9 s **đã có AV quét on-access** (Sophos Intercept X real-time); Defender tắt vì Sophos giữ vai trò đó, không phải vì máy không có AV. Thứ còn thiếu là **hạng phần cứng runner**, không phải antivirus.
- **darwin đã đo xong trên CI** (`macos-latest`, arm64): **481 MB / 145 MB** sau prune và gỡ `pip`, 55 package **trùng khít** Linux và trùng khít core trong §5.13 (`diff` rỗng). Cả ba nền tảng giờ đều là số đo thật, không còn ô suy diễn nào.
- **Số đo còn thiếu duy nhất là thứ chỉ packaged smoke mới sinh ra được**: cold start thật trên phần cứng runner, và TTS ra WAV trên Windows (bị N-1 chặn ở máy phát triển). Cả hai đều nằm trong R8, không chặn phê duyệt Design.

---

## 16. Phụ lục sửa sau phê duyệt — 2026-08-07 (bản 2.2)

> Bản 2 vẫn **APPROVED**. Phụ lục này không mở lại phạm vi, không thêm/bớt requirement và **không đổi ước lượng 177 SP**. Nó sửa bốn mươi chỗ mà bản 2 nói khác code, manifest authority hoặc hành vi runtime đã đo, phát hiện khi review và thực thi Implementation Checklist. Mỗi món nêu bằng chứng đã kiểm để không phải kiểm lại.

| # | Bản 2 nói | Code thật | Đã sửa ở |
|---|---|---|---|
| C-1 | `mcp` và `cli` "cả hai đều được phép import `adapter`", nên đặt `DaemonClient` ở `adapter/daemon` là đủ | [`scripts/verify-import-boundaries.mjs`](../../../../scripts/verify-import-boundaries.mjs) **cấm** `packages/mcp/**` → `@vidcom/adapter` và cấm theo prefix đường dẫn; [`packages/mcp/package.json`](../../../../packages/mcp/package.json) không khai `adapter`; `packages/mcp` không import `adapter` ở bất kỳ file nào. **Đã chốt thành luật** ở [steering/02](../../../steering/02-project-layout.md) §2 luật 3 + §2.1 + §2.2 ngày 2026-08-07, và thêm `@vidcom/adapter` vào block ESLint của `packages/mcp/**` — trước đó ba nguồn nói khác nhau nên `lint` xanh mà `test:boundaries` đỏ | §5.0 bảng + hệ quả 4, §5.7 |
| C-2 | "**Schema tool chuyển sang `contracts`**" là việc của Giai đoạn 4 | Đã xong từ trước: [`registry/schemas.ts`](../../../../packages/mcp/src/registry/schemas.ts) chỉ re-export `contracts`, và `packages/mcp` **không có `z.object` nào**. Việc còn lại là catalogue `tên tool → schema` cho route bridge | §5.0 hệ quả 1 |
| C-3 | "Giai đoạn 4 thêm hai dependency": `tar` và `@hono/node-server` | [`packages/server/package.json`](../../../../packages/server/package.json) đã khai `@hono/node-server@2.0.12`. Chỉ `tar` là món mới | §5.0 bảng bốn câu hỏi |
| C-4 | §8.1 liệt `workspace_lease_lost` trong nhóm mã lỗi phải thêm | [`packages/contracts/src/errors.ts`](../../../../packages/contracts/src/errors.ts) **đã có** `WorkspaceLeaseLost = "workspace_lease_lost"` | checklist A.1 |
| C-5 | Harness browser cho W-1 là thứ phải dựng | `puppeteer-core@25.4.0` đã là devDependency; [`spikes/phase-4/s9-windows-runtime/cookie-probe.mjs`](../../../../spikes/phase-4/s9-windows-runtime/cookie-probe.mjs) là harness chạy được, chỉ cần đưa vào `tests/` | checklist G.0 |
| C-6 | Thêm 14 member vào `ErrorCode` không được mô tả là thay đổi wire MCP | `GetJobStatusOutputSchema` kế thừa `JobSchema.error`, nên enum dùng chung tự động đi vào JSON Schema `tools/list`. Người dùng chốt giữ snapshot legacy/modern nguyên byte: 14 mã packaging chỉ công bố qua domain/HTTP/bridge; public MCP job schema giữ allowlist trước Phase A, và tool-error MCP chuẩn hoá mọi mã ngoài allowlist thành `internal` không kèm message/details riêng | checklist A.8, `tests/contracts/packaging-contracts.test.ts`, `tests/mcp/error-map.test.ts` |

| C-7 | DR-1 chốt "CJS bundle" nhưng không nói **công cụ nào** bundle; checklist H.1 đề xuất lấy `esbuild` từ runtime archive B.3 và ghi rõ "cần duyệt" | Đường đó chặn H.1 sau một tài sản phát hành chưa tồn tại: `build-runtime-archives.mjs` đòi config pin version + hash của Node/HyperFrames/esbuild/FFmpeg/CPython/VieNeu/motion cho ba OS, và file đó không có trong repo. **Bundler là `bun build --target=node --format=cjs`**: Bun đã là toolchain bắt buộc của repo (mọi script, mọi test chạy qua nó), nên **không thêm dependency nào vào `package.json` cũng không thêm dòng nào vào lockfile** — luật 6 vẫn nguyên. Phase 0 loại Bun ở vai trò **runtime** (`--compile` không load được `onnxruntime-node`/`sharp`); đây là vai trò **build-time**, output vẫn là CJS chạy dưới Node binary nhúng. Đã kiểm: bundle 5581 module, `node <bundle>` load được trong thư mục tạm **không có `node_modules`** ở bất kỳ cấp cha nào | checklist H.1, `scripts/build-cli-bundle.mjs`, `tests/build/cli-bundle.test.ts` |
| C-8 | §5.1 mô tả `assetSource` như input bắt buộc của mọi `BootstrapCoordinator.prepare()`, trong khi source checkout không có SEA blob hay runtime archive đã build | Source-dev vẫn chạy qua cùng coordinator và cùng `runtime-bootstrap.lock` để sở hữu migration + credential reconciliation, nhưng bỏ riêng extraction khi không có asset source. Artifact luôn có SEA source; nguồn filesystem chỉ được bật tường minh bằng `VIDCOM_RUNTIME_ASSETS` cho build/test. `runtimePathsFor` từ chối SEA chưa được prepare, nên artifact **không** fallback về `node_modules` hay dependency của máy build | checklist C.3, `packages/cli/src/runtime-paths-source.ts`, `tests/adapter/bootstrap-coordinator.test.ts` |
| C-9 | §5.13 khai `EmbeddedArchive.target` nhưng §5.14 lại viết cứng nơi publish là `<artifact-version>/<archive-key>`; builder vẫn parse `target`, nên hai authority có thể trỏ tới hai cây khác nhau | `archive.key` chỉ định danh blob SEA/filename marker; `archive.target` là normalized, non-overlapping publish location dưới version root. Một resolver duy nhất được dùng bởi extraction, installed-runtime reader, sentinel, `RuntimePaths` và doctor. Target lồng nhau fsync đúng cả source/destination parent khi publish/quarantine/restore; symlink hoặc special parent bị từ chối | checklist D.3b, `packages/adapter/src/runtime/runtime-asset-{source,manager}.ts`, `tests/adapter/runtime-asset-manager.test.ts` |
| C-10 | §5.17 cho `CompilerGuard.run()` nhận cả operation đồng bộ và mô tả timeout JS như bảo vệ đủ; `probe()` trả `{version}` | `transformSync` chặn event loop nên `Promise.race` không thể bắn timer. `run()` chỉ nhận operation async; transform thật chạy trong child riêng qua `NodeProcessSupervisor`, có deadline/kill proof và trả observation có mã. SEA/source boot chỉ import subpath compiler-free `@vidcom/adapter/compiler-guard` để đặt hai env **trước adapter barrel/HyperFrames/esbuild**; source launcher đặt thêm binary esbuild riêng của `tsx` trước khi import loader. AST inventory pin mọi import/call compiler và emitted-CJS test chứng minh Bun giữ ordering | checklist D.4, `packages/cli/src/{boot,compiler-preload,compiler-probe}.ts`, `packages/adapter/src/hyperframes/compiler-probe-child.ts`, `tests/{adapter/compiler-timeout-audit,build/cli-bundle}.test.ts` |
| C-11 | DR-1/§4.8 mô tả full CLI CJS là SEA `main`, còn §5.1 giao extraction cho `BootstrapCoordinator` bên trong graph đó | Node SEA `require` của embedded main chỉ nhận builtin; full CJS đánh giá `sharp`/esbuild/native externals **trước** coordinator có thể extract, nên một stage không thể boot ngoài checkout. Artifact dùng tiny bootstrap CJS chỉ builtin + runtime-extraction subpath, đọc manifest/archive assets nhúng, publish atomically, rồi xác minh fixed `node/cli/boot.cjs` là regular/contained và SHA-256 khớp manifest entry trước `createRequire`. Secondary CLI CJS nằm cạnh exact native dependency closure, cấu hình compiler rồi mới import main. Full `BootstrapCoordinator` sau đó chạy warm inspection dưới cùng lock và vẫn là authority duy nhất cho migration + credential; SEA preloader chỉ là authority pre-graph bắt buộc, không mở database. Ready marker không thay kiểm hash entry sẽ được thực thi | checklist D artifact AC/H.0, `scripts/{build-sea-bootstrap,build-artifact,build-sea}.mjs`, `packages/cli/src/sea-bootstrap.ts`, tests build/SEA cold-warm |
| C-12 | §5.13 chỉ nói gỡ `pip`, còn L.1 mô tả quét final artifact như một text payload đồng nhất | Frozen Python thật còn package/stdlib console scripts với absolute build shebang và wheel `RECORD` có hash ngẫu nhiên giống token; VieNeu runtime chỉ cần exact interpreter + worker + libraries. POSIX ship duy nhất `bin/python3`, Windows ship root `python.exe`, bỏ `Scripts/*`/sibling `bin/*` và `.dist-info/RECORD` nhưng giữ `METADATA`/code/native. Secondary CJS escape literal `sourceMappingURL=` thành JavaScript-equivalent `\x3d`. Final SEA bắt đầu bằng exact Node binary vốn có 6 AWS-shaped machine-code sequence + 4 sourcemap example literal; verifier chỉ trừ occurrence cùng `(rule id, byte offset, match digest)` trong exact `process.execPath`, còn mọi occurrence injected mới vẫn fail. Production proof: binary SHA `5b111f…e2bc0` render H.264/AAC narration trên PATH không có Node/Python | checklist D artifact AC, `scripts/{stage-artifact-runtime,build-cli-bundle,verify-artifact}.mjs`, tests stager/bundle/provenance |
| C-13 | Snapshot SEA bất biến và hash final executable được coi là đủ để bind byte đã inject | Snapshot chỉ chứng minh input trên đĩa; blob builder/postject vẫn có thể embed generation khác trong khi snapshot và outer executable hash đều tự nhất quán. Generation capability cũng chỉ bind directory inode: sau khi `build-sea` thoát, thay đồng thời executable + retained blob trong cùng generation từng làm verifier tự nhất quán với cặp mới; sau snapshot, lexical `.sea-inputs` cùng manifest cũng từng có thể bị thay bằng một generation mới tự nhất quán. Vì vậy sau mutation cuối `build-sea` phát strict seal v1 `{tag,generationId,artifact:{bytes,sha256},blob:{bytes,sha256},inputs:{codePath:".sea-inputs/main-loader.cjs",main:{bytes,sha256},assets:[{key,bytes,sha256}]}}`; asset keys unique và UTF-8 sorted. `inputs` chỉ được tạo từ in-memory records trong lúc copy original snapshot, không recapture pathname/manifest. `build-artifact` giữ record canonical **chỉ trong memory của parent** và truyền trực tiếp cho verifier, không lưu thành file authority có thể bị thay cùng generation. `build-sea` đồng thời giữ original snapshot root capability (`dev/ino/birthtime`) và revalidate trước/sau blob creation, injection và seal. SEA `main` là loader CJS built-in-only tối thiểu; product primary CJS là raw asset và chỉ chạy sau protocol marker non-configurable. Candidate self-report không phải authority: một blob A có loader hợp lệ + side effect vẫn có thể report raw primary B, rồi nối nguyên expected blob B ở đuôi để qua phép tìm substring; kể cả re-hash ngay trước `spawn` vẫn có khe vì child mở lại pathname sau check. Production verifier vì vậy **không chạy candidate**. Nó exact-schema/re-hash artifact + retained blob theo parent seal; parse thụ động exact Node 24.9 prep-blob (magic/flags/exec-argv extension, size_t 64-bit little-endian, code path/main, exact asset map, không code cache/exec argv, cursor phải EOF) và hash trực tiếp các main/asset spans theo `seal.inputs`, không mở snapshot path làm expected authority; rồi parse **resource mà Node loader thực sự chọn** trong executable: `NODE_SEA/__NODE_SEA_BLOB` trên Mach-O, PT_NOTE đầu tiên theo hành vi vendored postject trên ELF, hoặc `RT_RCDATA/NODE_SEA_BLOB` trên PE. Declared active extent phải có đúng size và mọi byte bằng retained blob qua streaming; header/range/trùng/format lệch đều fail-closed. Sau passive/resource/re-seal proof, verifier buộc current snapshot manifest + files khớp cùng `seal.inputs`, capture một root capability mới và bracket mọi runtime/frontend/forbidden scan bằng capability + projection revalidation trước cleanup/publication. Thứ tự authority là original in-memory projection/root capability → parent-memory seal → passive prep-blob main/assets → active-resource extent → current snapshot projection/capability → final seal/provenance; không có verification-time candidate turn. Regression root replacement, same-root child/manifest replacement và coherent artifact/blob replacement đều fail-closed; real SEA `badBlob || expectedBlob` chỉ được chạy trong negative-test seam và bad-main marker phải absent trên production verification path. Frontend provenance luôn build trong temp checkout mới | checklist D artifact AC/L.1 proof, `packages/cli/src/{sea-main-loader.cjs,sea-bootstrap.ts}`, `scripts/{sea-build-seal,build-artifact,build-sea,sea-blob,sea-resource,verify-artifact}.mjs`, `tests/build/{build-artifact,sea,artifact-provenance}.test.ts` |
| C-14 | Một lexical artifact generation path được coi là đủ authority cho mọi bước SEA/publish | Build và verifier chạy thành process riêng, còn directory có thể bị rename/replaced giữa prepare, snapshot, injection và publish. Publisher cấp capability bind canonical parent chain + generation `dev/ino`, serializes exact non-secret record để verifier process sau restore **authority gốc** thay vì recapture path mới; lock bind PID + OS process-start identity + token, journal bind digest toàn payload. `build-sea`/verifier revalidate capability trước/sau mutation; snapshot root/nested parents và output files phải real-contained, destination/provenance tạo bằng exclusive create nên symlink/hardlink không được follow. Cleanup chỉ chạy khi parent/snapshot capability còn đúng. Root/generation replacement, junction và PID reuse đều fail-closed | checklist D.3b/artifact AC, `scripts/{artifact-publish,directory-generation-publish,build-sea,verify-artifact}.mjs`, `tests/build/{artifact-publish,sea,artifact-provenance}.test.ts` |
| C-15 | Ghi chú thực thi K.6 kết luận import không thể dùng job store vì `NewJob.projectId` bắt buộc, rồi yêu cầu dùng operation id làm `jobId` | Schema SQLite đã cho `job.project_id` nullable và §7.15 yêu cầu client poll `/jobs/:jobId`; operation id không tồn tại ở job route nên cách đó tạo 404 khác. `Job`/`NewJob` được sửa khớp schema: import enqueue job cấp workspace với `projectId: null`; application service serialize lookup/enqueue vì unique index SQLite không serialize NULL. Song song, `workspace_operation(kind=project_import)` giữ staging marker và recovery authority. Startup abort pre-publish staging có marker hoặc backfill + recover post-publish directory; thư mục giống staging nhưng không có marker luôn được giữ nguyên. Project-scoped job events chỉ phát khi `projectId` khác null; progress import đọc từ job polling. Token browse phải khớp lại device/inode trước plan, worker recheck identity đầy đủ trước copy | checklist K.6/K.7, `packages/{core,adapter,worker,cli}/**`, `tests/{adapter,cli,server}/**` |
| C-16 | Route hoặc use case tồn tại được coi là đã nối vào production host | Import route, workspace activation, lease-loss và discovery chỉ đúng khi `startServing`/composition root truyền đủ dependency và teardown đúng foundation. Production host nay nối import scheduler/worker, workspace switch, lease monitor và discovery trên cùng listener; test đi qua Hono + SQLite + filesystem thật thay vì gọi service rời | checklist G.9/K.6/M.3b, `packages/cli/src/{commands/serve,next-host,startup,composition-root}.ts`, `tests/{cli,server}/**` |
| C-17 | Browser cache directory tồn tại được coi là cache đã phục hồi và clean machine có thể giải nén bằng dependency transitively available | Cache rỗng không được tạo destination/ready marker; zip extraction dùng dependency runtime exact `yauzl@3.4.0`, không dựa vào package tình cờ nằm trong checkout. Browser smoke tách cache absent với cache empty và chạy static bundle thật | checklist M.2/M.5, `package.json`, `scripts/packaged-smoke/environment.mjs`, `tests/{build,frontend}/**` |
| C-18 | Process-tree probe có thể dùng environment cha hoặc PATH để tìm `ps`/PowerShell/taskkill | Probe termination là một phần của trust boundary: POSIX dùng PATH/locale/TZ cố định; Windows dùng `SystemRoot` và absolute system executable, mọi spawn đi qua helper allowlist. Audit AST không còn exemption cho process supervisor | checklist D.7/M.3d, `packages/adapter/src/runtime/{process-supervisor,process-environment}.ts`, `tests/adapter/{process-supervisor,spawn-environment-audit}.test.ts` |
| C-19 | Throttle progress được phép bỏ mọi update gần nhau | Chuyển stage là semantic event, không phải sample phần trăm; `JobScheduler` luôn ghi khi stage đổi và chỉ throttle update trong cùng stage. Cancel smoke vì vậy quan sát được `rendering` trước khi gửi huỷ và đòi termination proof không survivor | checklist M.3c, `packages/{core,adapter}/**`, `tests/adapter/job-infrastructure.test.ts` |
| C-20 | Một số đo khởi động có thể gộp thời gian `serve` và `doctor` | Mỗi command là một process/cold-start riêng. Evidence lưu `identify`, cold `doctor --repair`, warm `doctor --deep` và listener readiness độc lập; baseline chỉ được chốt từ runner cùng OS sau lần CI đầu, không lấy tổng chuỗi làm trần của từng lệnh | §9.1, checklist M.3a/M.7, `scripts/packaged-smoke/bodies.mjs` |
| C-21 | Runtime chuẩn bị cho packaged smoke có thể trở thành nguồn release chỉ vì URL + digest đã pin | Ba bộ FFmpeg/ffprobe của mirror bên thứ ba chỉ là **CI smoke fixture không được phát hành**. Script fail nếu thiếu opt-in `VIDCOM_ALLOW_UNRELEASED_SMOKE_RUNTIME=1`; workflow ghi rõ human supply-chain gate còn mở. Release production vẫn phải dùng nguồn được duyệt (hoặc source build được duyệt) và MUST NOT tái dùng fixture này | checklist M.1/M.4 và supply-chain gate, `scripts/prepare-packaged-runtime.mjs`, `.github/workflows/packaged-smoke.yml` |
| C-22 | Workspace switch có thể giữ mọi registry cấp foundation hoặc buộc session đăng nhập lại | `EntryRegistry` chứa recovery capability cấp foundation nên phải clear lúc teardown; cookie/session thuộc listener host nên được giữ qua hot-swap. Test production listener chứng minh project mới nằm ở workspace mới, recovery token cũ mất hiệu lực và cùng cookie vẫn dùng được | §4.3, checklist M.3b/M.3d, `packages/cli/src/startup.ts`, `tests/{cli,server}/**` |
| C-23 | Chọn MCP/bridge bearer middleware phụ thuộc route handler có đang mount hay không | Perimeter thuộc namespace, không thuộc dependency graph. `/api/mcp` và `/api/bridge` luôn đi qua bearer auth; handler vắng mặt chỉ có thể thành 404 **sau** credential hợp lệ, browser cookie không bao giờ đổi hai namespace này sang session auth | §4.4, checklist M.3b, `packages/server/src/app.ts`, `tests/server/mcp-security.test.ts` |
| C-24 | Sau khi cho phép Bun hardlink package manifest/tree nguồn, esbuild executable trong chính package input vẫn bị áp luật `nlink === 1` của output phát hành | Linux Bun store hardlink cả `@esbuild/linux-x64/bin/esbuild`; nó là nguồn chỉ đọc sẽ được copy, không phải release authority. Stager cho phép nhiều link **chỉ ở source esbuild contained trong exact package root**; destination `node/bin/esbuild` vẫn phải là regular executable một link. Regression tạo hardlink input thật, stage xong và đòi output `nlink === 1` | checklist M.1, `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts` |
| C-25 | Manifest product validator yêu cầu POSIX execute bit cho cả bốn executable trên mọi nền tảng | Windows không lưu POSIX execute bit và stage đúng ghi mode `0o666` cho `.exe`; tên exact, hash, byte count, regular-file và archive closure vẫn là authority. Chỉ bỏ phép thử `mode & 0o111` cho `win32-x64`; POSIX vẫn fail-closed. Regression dựng full Windows manifest với bốn `.exe` mode `0o666` và validate bằng platform tường minh | checklist M.1/L.1, `packages/adapter/src/runtime/packaged-runtime-manifest.ts`, `tests/adapter/packaged-runtime-manifest.test.ts` |
| C-26 | Spike process-supervision coi PID trùng nhau là cùng process trong cả capture/kill/proof | PID có thể được Windows tái sử dụng ngay trong vòng proof; Actions đã thấy ledger không còn survivor nhưng spike vẫn báo hai PID sống. Spike nay bind PID với OS process-start identity giống production supervisor, chỉ kill/prove exact identity; PID tái sử dụng làm enumeration không exhaustive chứ không bị kill như process cũ. Regression thực tế là gate Windows cùng exact commit; macOS local vẫn PASS | checklist D.7/M.3d, `spikes/phase-3-checklist-gate/platform-supervisor.mjs`, `.github/workflows/process-supervision.yml` |
| C-27 | Full test matrix có thể dùng file-level parallelism mặc định như nhau trên mọi OS | Windows runner mất thêm ACL subprocess và giữ SQLite handle lâu hơn; 197 file xanh nhưng ba integration file cùng timeout khi chạy dưới full parallel load, trong khi lỗi duy nhất không liên quan tải là path separator. Vitest giới hạn Windows ở hai worker, vẫn chạy toàn bộ test chứ không skip/nới assertion; test symlink so với `path.normalize` thay vì hard-code `/` | checklist M.8, `vitest.config.ts`, `tests/build/packaged-smoke.test.ts` |
| C-28 | Sau lease loss, smoke có thể dùng browser cookie và đòi bridge handler trả 404 để chứng minh route đã gỡ | C-23 đã chốt perimeter theo namespace: `/api/bridge` luôn bearer-auth **trước** route matching. Khi foundation dừng, credential verifier cũng bị gỡ nên bootstrap surface đúng phải trả `401 credential_invalid`; trả 404 qua cookie vừa mâu thuẫn perimeter vừa làm lộ route presence. Smoke nay đòi namespace không reachable, rồi kiểm riêng NoWorkspace/listener/winner writer | checklist M.3b/M.3d, `scripts/packaged-smoke/bodies.mjs`, `packages/server/src/app.ts` |
| C-29 | HyperFrames CLI entry trong package input bị áp `nlink === 1` như file phát hành | Bun global store trên Linux hardlink cả `hyperframes/bin/hyperframes.mjs`. Stager cho phép shared **chỉ với exact source CLI regular/contained trong package root**; generated bundle ở staged tree và toàn bộ artifact output vẫn bắt buộc một link. Regression tạo hardlink input rồi chứng minh staged CLI là bản copy `nlink === 1` | checklist H.2/M.1, `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts` |
| C-30 | Test PATH rỗng luôn phải nhận termination proof exhaustive | Workflow degraded Windows chủ động tắt `powershell-cim`, nên không còn parent-capable enumerator và production contract bắt buộc trả `termination_proof_not_exhaustive`. Test PATH rỗng nay vẫn đòi zero survivor, nhưng kỳ vọng exhaustive/warning theo capability mà workflow cố ý tắt; đường bình thường vẫn bắt buộc exhaustive | checklist D.7/M.3d, `.github/workflows/process-supervision.yml`, `tests/adapter/process-supervisor.test.ts` |
| C-31 | Windows process identity qua `Get-Process` sẽ tránh WMI/CIM stall | `Get-Process` vẫn có thể kích hoạt PowerShell module discovery; cold runner đã treo đủ 15 giây dù `PSModulePath` rỗng. Probe nay gọi thẳng `[System.Diagnostics.Process]::GetProcessById`, format bằng .NET và parse strict một dòng; identity scheme/start timestamp, fail-closed lock và budget không đổi | checklist C.1/D.7/M.3d, `packages/adapter/src/runtime/process-supervisor.ts`, `tests/adapter/runtime-asset-manager.test.ts` |
| C-32 | Scanner secret có thể coi mọi literal `BEGIN ... PRIVATE KEY` hoặc `sk-ssh-...@openssh.com` trong binary là secret thật | Exact Windows FFmpeg chứa chuỗi parser NUL-terminated và tên thuật toán FIDO chuẩn của libssh, không chứa key material. Rule nay đòi PEM header có newline và loại đúng hai algorithm identifier chuẩn; không có file/hash allowlist, PEM hợp lệ vẫn fail. Quét lại binary SHA-256 `04e130…ad00` trả zero finding; focused provenance 37/37 | checklist L.1/M.1, `scripts/verify-artifact.mjs`, `tests/build/artifact-provenance.test.ts` |
| C-33 | HyperFrames exit `0` đủ để chuyển sang ffprobe; capture implementation mặc định của exact pin được coi là ổn định giữa host | Help/code của 0.7.86 xác nhận experimental fast capture mặc định bật trên macOS + hardware GPU; offline exact artifact exit `0` không tạo output. Production ép `PRODUCER_EXPERIMENTAL_FAST_CAPTURE=false` và router con false để mọi OS dùng screenshot path ổn định; sau exit `0` phải lấy regular-file/hash `artifactSource` trước ffprobe, thiếu output fail bằng lỗi riêng, và publication dùng lại chính source đã chứng minh | checklist M.3c/M.4, `packages/worker/src/render-job.ts`, `tests/adapter/render-job.test.ts` |
| C-34 | Assertion/cleanup của integration test có thể dùng `process.kill(pid, 0)` sau khi production proof đã bind process identity | Numeric PID có thể được tái sử dụng ngay sau termination; raw liveness vừa báo survivor giả vừa có thể làm cleanup giết process mới. Test capture exact start identity trước abort, mọi assertion và cleanup sau đó chỉ tác động khi targeted exhaustive probe vẫn khớp `(pid,startedAt)` | checklist D.7/M.3d, `tests/adapter/process-supervisor.test.ts` |
| C-35 | Release directory lock chỉ cần một lần rename sau khi ownership đã được assert | Windows antivirus/indexer có thể giữ handle ngắn và trả `EPERM`/`EACCES`/`EBUSY` dù lease vẫn đúng. Release retry tối đa 2 giây (không vượt lock timeout), reassert exact directory identity + owner nonce trước mỗi lần; ownership đổi hoặc lỗi khác đều fail-closed | checklist C.1/M.5, `packages/adapter/src/runtime/atomic-directory-lock.ts` |
| C-36 | Hai Vitest worker là đủ bounded concurrency cho Windows full suite | Run thật vẫn cho browser/process/lock integration tranh ACL, filesystem và process-table budget. Windows dùng một worker để serialize file-level integration, không skip test, không nới assertion hay test timeout; browser và process workflows chuyên biệt vẫn là gate riêng | checklist M.8/M.9, `vitest.config.ts` |
| C-37 | Nới hardlink cho HyperFrames CLI đã bao phủ toàn package input | Bun Linux còn hardlink `dist/hyperframe.manifest.json` và `dist/hyperframe.runtime.iife.js` từ global store. Hai exact source chỉ được đọc sau regular/contained proof nên cho phép shared; generated manifest và copied/sanitized runtime trong artifact vẫn bắt buộc single-link. Regression hardlink cả hai input và kiểm cả hai output | checklist H.2/M.1, `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts` |
| C-38 | Generic CI có thể tự quyết định chạy browser E2E nếu runner tình cờ có Chrome | Browser coverage đã có workflow chuyên biệt cài exact Chrome và ép `VIDCOM_REQUIRE_BROWSER=1` trên Linux/Windows. Windows generic CI tình cờ resolve Chrome hệ thống sau 13 phút suite tuần tự rồi timeout ca E2E 30 giây. `requireBrowser` nay skip có lý do khi là generic CI không có required flag; local vẫn chạy nếu có browser, dedicated workflow vẫn fail nếu thiếu/skip và là authority coverage | checklist G.9/M.6/M.9, `tests/support/browser-harness.ts`, `tests/frontend/browser-session.test.ts`, `.github/workflows/{ci,phase4-browser-session}.yml` |
| C-39 | Strict promotion có thể chạy trước repair và biến shallow integrity skip thành runtime hỏng | Exact Windows smoke cho `doctor --repair` chạy đến timeout 600 giây: `runtime.integrity` bị strict đổi `skipped` thành `missing`, nên repair giải nén lại toàn runtime vốn khoẻ. `runDoctor` nay chạy probe raw, chỉ repair `missing/broken` thật, rồi mới áp strict lên report cuối; shallow skip vẫn in `missing` dưới strict với remedy `--deep` nhưng không mutate runtime | checklist M.3a/M.5/M.9, `packages/cli/src/commands/doctor.ts`, `tests/cli/doctor.test.ts` |
| C-40 | Harness có thể dùng `child.kill("SIGTERM")` như graceful stop trên mọi OS | Windows Node force-terminate process thay vì chạy SIGTERM handler; daemon bị dừng sau UI smoke không kịp xoá discovery/nhả lease, làm mọi step sau thất bại `workspace is held`. Packaged harness spawn SEA với IPC fd và gửi exact `{type:"vidcom.shutdown"}`; `waitForShutdown` chỉ nghe kênh parent-held này khi nó tồn tại, chạy cùng idempotent `daemon.stop()` và gỡ listeners sau teardown. Không thêm network route hay capability cho browser/agent | checklist M.3a–M.4, `packages/cli/src/commands/serve.ts`, `scripts/packaged-smoke/bodies.mjs`, `tests/cli/serve.test.ts` |
| C-41 | Bun package hardlink chỉ ảnh hưởng executable và HyperFrames | Linux runner cho thấy GSAP motion asset cũng được hardlink từ package store. Mọi exact package-owned source asset đọc-only được phép shared sau khi chứng minh realpath, containment và regular file; bản staged/copy/sanitized trong artifact vẫn bắt buộc `nlink === 1`. Đây là cùng ranh giới input/output của C-24/C-29/C-37, không phải allowlist riêng cho GSAP | checklist H.5/M.3a, `scripts/stage-artifact-runtime.mjs`, `tests/build/stage-artifact-runtime.test.ts` |
| C-42 | Gọi thẳng .NET API trong Windows PowerShell 5.1 sẽ luôn nằm trong budget cold probe | Windows browser runner chứng minh chính cold CLR startup của PowerShell 5.1 vẫn có thể vượt 15 giây dù không chạy cmdlet/module discovery. Probe ưu tiên PowerShell 7 ở conventional system-protected path khi file thật tồn tại, fallback về Windows PowerShell tích hợp khi không có; cả hai gọi cùng `System.Diagnostics.Process.StartTime`, giữ nguyên `windows-start` identity scheme và fail-closed contract | checklist D.4/G.9/M.4, `packages/adapter/src/runtime/process-supervisor.ts`, `tests/adapter/runtime-asset-manager.test.ts` |
| C-43 | `doctor --repair` có thể chạy shallow probe rồi để strict tự biến integrity skip thành missing | Repair phải biết integrity có hỏng hay không trước khi quyết định mutation. CLI coi `--repair` là deep probe giống `--deep`; raw healthy runtime trả `ok`, raw failure mới đi vào repair, strict vẫn chỉ là report policy sau cùng | checklist H.6/M.3a, `packages/cli/src/commands/{doctor,main}.ts`, `tests/cli/doctor.test.ts` |
| C-44 | 240 byte đầu stderr đủ chẩn đoán renderer exit 0 không có artifact | HyperFrames in warning `id`/`pgrep` trước error box nên prefix che mất nguyên nhân offline thật. Failure giữ bounded 2 KiB suffix của stdout+stderr; không đổi exit/artifact proof và chưa đổi render behavior cho đến khi CI lộ exact root cause | checklist J.5c/M.3a, `packages/worker/src/render-job.ts`, `tests/adapter/render-job.test.ts` |
| C-45 | Temporary path string trên Windows luôn dùng cùng tên với directory enumeration | Runner đặt `HOME` bằng 8.3 alias `RUNNER~1` nhưng filesystem browse trả long canonical name, nên smoke driver không tìm được segment dù production import route khoẻ. Harness `realpath` source trước khi chọn root/token, tính containment bằng `path.relative` và match case-insensitive trên Windows; client vẫn chỉ dùng token server mint, không gửi raw path vào import | checklist K.6/M.3a, `scripts/packaged-smoke/bodies.mjs`, `tests/build/packaged-smoke.test.ts` |
| C-46 | Package runner sẽ tôn trọng shebang Node của postject như nhau trên mọi OS | `bunx` chạy CLI Emscripten của postject bằng Bun trên Linux và abort ở bước inject dù runtime staging/archive đã xanh; cùng package runner không phải authority cho runtime của build tool. Postject `1.0.0-alpha.6` nay là exact dev dependency trong lockfile và được gọi bằng exact `process.execPath` + resolved CLI path; version/provenance và SEA byte verification không đổi | checklist H.4/M.1/M.3a, `package.json`, `bun.lock`, `scripts/build-sea.mjs`, `tests/build/sea.test.ts` |
| C-47 | Đưa default route về loopback là một network cut fail-fast | macOS runner chứng minh route external qua loopback giữ kết nối Chromium chờ đủ 60 giây, làm `page.goto(http://localhost:...)` timeout dù server/render online cùng artifact xanh. Bốn route phủ IPv4/IPv6 nay mang `RTF_REJECT`, để external TCP fail ngay trong khi exact loopback host route vẫn thắng theo longest-prefix; cleanup xoá cùng destination/gateway và smoke vẫn phải chứng minh socket `1.1.1.1:443` bị chặn | checklist M.4, `scripts/packaged-smoke/network-cut.mjs`, `tests/build/packaged-smoke.test.ts` |
| C-48 | Postject chạy bằng Node sẽ inject được SEA blob ở mọi kích thước artifact | Repro Node 24.9.0 Linux chứng minh postject Emscripten vẫn abort khi blob vượt heap WASM khoảng 256 MiB; tăng biến JS `INITIAL_MEMORY` không thay đổi memory đã compile. Linux dùng injector ELF streaming bounded 1 MiB: relocate program-header table vào mapped gap có sẵn, chèn `PT_LOAD`/`PT_NOTE` đúng thứ tự, bật exact SEA fuse, fsync + identity-revalidate rồi atomic rename. Blob 300 MiB đã qua verifier độc lập và binary x86-64 chạy thật trong Linux; macOS/Windows tiếp tục dùng postject exact. Artifact provenance ghi cả injector nội bộ có version | checklist H.4/M.1/M.3a, `scripts/{inject-elf-sea,build-sea,verify-artifact}.mjs`, `tests/build/{sea,artifact-provenance}.test.ts` |
| C-49 | Baseline thiếu hoặc sai schema có thể được coi như runner lần đầu và chỉ báo `baselinePresent=false` | Sau khi ba runner đã có evidence đầu tiên, baseline là release gate đã commit chứ không còn là optional capture. Reader chỉ chấp nhận version 1, exact runner và đúng hai integer `coldServe`/`warmServe`; packaged smoke fail nếu file thiếu/hỏng/sai runner. Nhờ vậy xoá hoặc làm hỏng file trong PR không thể âm thầm tắt chặn hồi quy 1,5× | checklist H.6/M.7, `.github/perf-baseline/*.json`, `scripts/{measure-startup,packaged-smoke/bodies}.mjs`, `tests/build/startup-baseline.test.ts` |
| C-50 | Test injector ELF và Python probe có cùng filesystem/process budget trên mọi host | Injector chỉ ship trên Linux nhưng regression cấu trúc chạy ba OS; Windows không cho atomic replace khi chính process còn giữ source handle, nên đóng hai authenticated input handle sau identity revalidation và trước rename. Cleanup SEA thật dùng bounded retry có sẵn cho AV/indexer lock. VieNeu probe vẫn đòi cùng output/ready semantics, nhưng cold Python dưới Windows AV có budget 60 s và outer heavy-E2E 180 s thay vì timeout giả 10/30 s | checklist M.8/M.9, `scripts/inject-elf-sea.mjs`, `tests/{build/sea,adapter/vieneu-model-probe}.test.ts`, `tests/support/platform.ts` |
| C-51 | PR CI có thể vừa tự chạy heavy workflow vừa gọi lại cùng reusable workflow | `packaged-smoke.yml` và `phase4-browser-session.yml` đã tự nghe `pull_request`; gọi lại chúng từ `ci.yml` tạo hai run cùng concurrency key, bản sau cancel bản trước và làm CI wrapper đỏ dù mọi static job xanh. CI wrapper chỉ gọi hai reusable workflow khi `workflow_dispatch`; PR giữ hai standalone authority, không giảm platform/step coverage | checklist M.8/M.9, `.github/workflows/{ci,packaged-smoke,phase4-browser-session}.yml`, `tests/build/packaged-smoke.test.ts` |
| C-52 | Process/generic CI có thể chạy browser integration nếu runner tình cờ có Chrome | Exact-head Linux process runner launch Chrome hệ thống rồi chạm 30 s hook budget; exact-head Windows generic CI sau đó đứng hơn 30 phút ở full Test. `remote-asset-browser.test.ts` được chuyển vào `test:browser-session`, nơi workflow cài exact Chrome và ép browser; process contract bỏ test này, generic CI exclude rõ ràng thay vì dựa ambient software. Process path trigger vẫn giữ để thay đổi remote-asset gọi review liên quan | checklist M.8/M.9, `package.json`, `.github/workflows/{ci,process-supervision,phase4-browser-session}.yml`, `tests/build/packaged-smoke.test.ts` |
| C-53 | Product runtime chỉ có hai archive `node` + `hyperframes`; thêm BGM không đổi topology artifact | BGM là archive product thứ ba có digest/target/ownership riêng. Một canonical archive-set authority phải được dùng bởi stager, SEA, bootstrap manifest, verifier, doctor, provenance và smoke; không component nào được hard-code lại tập archive | checklist B/H/M, `scripts/{stage-artifact-runtime,build-sea,verify-artifact}.mjs`, `packages/adapter/src/runtime/packaged-runtime-manifest.ts` |
| C-54 | `tar@7.5.22` là dependency runtime mới duy nhất và mọi native closure đã chốt | Agent terminal là capability bắt buộc của packaged daemon, nên `node-pty@1.1.0` được pin exact, build/trust trên host, external khỏi CJS và stage cùng exact native closure theo OS/arch. Adapter barrel không được làm unrelated import crash; packaged terminal phải có probe thật | checklist B/H/M, `packages/adapter/src/agent/agent-terminal-pty.ts`, `scripts/{build-cli-bundle,stage-artifact-runtime}.mjs` |
| C-55 | `vidcom mcp` có thể dựng foundation/scheduler/watcher và giữ lease riêng | Stdio MCP chỉ là local transport adapter: canonical workspace → ensure/discover daemon → handshake → bridge attachment/renew → remote `ToolInvoker`. Nó không sở hữu database, scheduler, watcher hay workspace lease; stdout chỉ chứa MCP frames | checklist I/M, `packages/cli/src/commands/mcp.ts`, `packages/cli/src/bridge/remote-tool-invoker.ts`, `packages/mcp/src/stdio.ts` |
| C-56 | Scene seed standalone HTML 1920×1080 có thể mount như sub-composition trên mọi preset | Scene seed dùng HyperFrames `<template>` và dimensions từ preset; host mount mang cùng `data-width`/`data-height`. Motion quality không được thoả bằng dummy tween trong generator: authoring flow phải viết choreography thật trước validate/render | checklist G/M, `packages/core/src/usecase/project-writes.ts` |
| C-57 | Checkbox M/evidence cũ tiếp tục đại diện cho HEAD sau các thay đổi runtime | Evidence acceptance luôn bind exact current HEAD. Khi archive/native/MCP topology đổi hoặc bốn workflow đỏ, B/H/I/M và cross-platform AC được mở lại; chỉ retick sau local gate + bốn workflow xanh trên cùng SHA + production private-PATH proof | checklist B/H/I/M, `.github/workflows/**` |
| C-58 | Thin MCP có thể chạy bootstrap runtime/migration trước khi attach daemon nếu không giữ lease | `vidcom mcp` không được extract/repair runtime, migrate database hay gọi foundation ở cả explicit-workspace và active-workspace fallback. Nó chỉ canonicalize workspace, đọc discovery/credential và attach daemon hiện hữu; fallback chỉ đọc SQLite hiện hữu bằng connection ngắn hạn. Tool invocation/enqueue render dùng workload deadline 120 s tách khỏi control-plane/heartbeat 5 s | checklist I/M, `packages/cli/src/commands/mcp.ts`, `packages/adapter/src/daemon/daemon-client.ts` |
| C-59 | Giới hạn capture 64 KiB toàn cục đủ cho mọi process và có thể tăng toàn cục khi JSON lớn | Process supervisor giữ mặc định 64 KiB mỗi stream, nhưng caller được yêu cầu budget riêng với hard cap 8 MiB. HyperFrames diagnostics dùng 8 MiB vì project 35–50 scene sinh JSON lớn; vượt cap bị reject trước spawn và mọi caller khác vẫn giữ bounded default | checklist G/J/M, `packages/core/src/port/process.ts`, `packages/adapter/src/runtime/{process-supervisor,process-runner}.ts`, `packages/adapter/src/hyperframes/check.ts` |
| C-60 | Deep integrity bắt buộc tuần tự để giữ deterministic error | Warm ensure vẫn hash toàn bộ file mỗi lần, nhưng dùng shared bounded concurrency 8 giữa các archive. Kết quả lỗi đầu tiên vẫn theo thứ tự archive/path canonical, mọi task được drain bằng `Promise.allSettled`, và bounds cấu hình là 1–32; không cache chéo process hay bỏ hash | checklist H/M, `packages/adapter/src/runtime/runtime-integrity.ts` |
| C-61 | Smoke client không được retry bất kỳ request nào vì có thể che daemon failure | Harness chỉ retry đúng một lần khi read-only `GET /jobs/:id` gặp transport reset từ stale keep-alive sau một đoạn `spawnSync` dài. HTTP 4xx/5xx, mutation và lỗi transport lần hai không retry; failure vẫn kèm daemon status/tail. Đây là ổn định harness, không thay production retry contract | checklist M.3a/M.6, `scripts/packaged-smoke/bodies.mjs` |
| C-62 | HyperFrames CLI executable là closure đủ; browser helper scripts có thể đọc từ source package lúc chạy | Packaged HyperFrames archive phải stage và manifest chính xác ba browser helper `layout-audit`, `motion-sample`, `contrast-audit` cạnh command runtime. Verifier dùng exact allowlist và regression chạy `check --json` từ staged closure đã extract; lint unavailable do thiếu helper là artifact failure, không được bypass render gate | checklist H/J/M, `scripts/{stage-artifact-runtime,verify-artifact}.mjs`, `packages/adapter/src/runtime/packaged-runtime-manifest.ts` |
| C-63 | Runtime manager có thể canonicalize app-data sau khi constructor đã derive lock/native paths | Canonicalization phải xảy ra trước mọi path/lock derivation. Outer SEA gọi `prepareRuntimeAppDataRoot` rồi mới validate manifest và dựng manager; manager tiếp tục fail-closed nếu caller đưa alias. Điều này làm 8.3/long-path trên Windows hội tụ một authority thay vì tạo hai lock namespace. Windows directory ACL dùng grammar `:(OI)(CI)F`; test phải khớp command thật, không giữ expectation cú pháp sai | checklist H/M, `packages/cli/src/sea-bootstrap.ts`, `packages/adapter/src/runtime/{runtime-bootstrap,runtime-asset-manager}.ts`, `tests/{adapter,cli,e2e,server}/**` |
| C-64 | Process supervisor default 5 phút đủ cho mọi render vì job có timeout 30 phút | Supervisor timeout là gate thật và đã kill Apollo 300 s dù job outer còn sống. Render truyền explicit bounded budget từ authored duration × pixel ratio × fps: `120 s + 3 × work`, floor 10 phút, cap 90 phút; job outer 95 phút để còn verified teardown. Không nâng default toàn cục và không bỏ timeout | checklist J/M, `packages/worker/src/render-job.ts`, `tests/adapter/render-job.test.ts` |

> **Đính chính số lượng:** phụ lục hiện có **64 correction**. Đoạn tổng kết lịch sử ngay dưới đây mô tả C-1–C-52; C-53–C-64 cũng không mở rộng requirement, mà reconcile capability đã có với packaging/daemon/MCP contract và exact-HEAD evidence gate.

**Không có món nào trong sáu mươi bốn món này mở rộng requirement.** C-1 đổi *chỗ đặt code* (remote `ToolInvoker`: `mcp` → `cli`) theo hướng thắt boundary. C-6 đóng băng vocabulary của wire contract đã phát hành. C-8 giữ nguyên thứ tự cold boot và làm rõ source-dev. C-9 loại hai authority layout mâu thuẫn. C-10 thay một timeout không thể hoạt động với compiler đồng bộ bằng process boundary vốn đã được R6.11 yêu cầu. C-11 giữ nguyên SEA một-file/verified archive, nhưng tách stage tải code vì runtime thật không thể evaluate external native graph trước extraction. C-12 gỡ build/install metadata không có runtime caller và làm scanner phân biệt exact pinned Node baseline với payload VidCom thêm, nên gate purity vẫn chặt hơn chứ không có ID allowlist. C-13 đo bytes từ chính executable thay vì tin tool inject. C-14 bind mọi filesystem mutation vào cùng generation capability thay vì tin lexical path. C-15 khớp hai authority đã được requirement yêu cầu: job cho progress/terminal và workspace-operation cho recovery filesystem. C-16–C-20 sửa các giả định wiring, cache, process và phép đo bằng runtime evidence. C-21 giữ nguyên human supply-chain gate thay vì lén biến fixture CI thành nguồn release. C-22–C-23 làm rõ lifecycle capability/session và perimeter theo namespace. C-24/C-29/C-37/C-41 tiếp tục phân biệt mọi exact package-manager input có thể shared với release output bắt buộc một link. C-25 áp semantics quyền đúng theo filesystem đích mà không nới byte/path integrity. C-26 đưa spike proof về cùng process-identity authority production đã dùng, tránh vừa báo survivor giả vừa có nguy cơ kill PID mới. C-27/C-36/C-38 thay đổi scheduling test theo authority/chi phí runtime thật nhưng không giảm test coverage. C-28 giữ đúng thứ tự auth-before-routing đã chốt ở C-23 và tách khẳng định NoWorkspace khỏi route-presence leak. C-30 giữ degraded-proof trung thực thay vì đòi một capability đã bị workflow tắt. C-31/C-34/C-35 buộc probe, test cleanup và lock release về cùng authority identity/ownership fail-closed. C-32 làm scanner semantic hơn nhưng vẫn bắt secret material thật. C-33 thêm proof output và đóng mutable HyperFrames experiment, không thay render contract. C-39 tách mutation repair khỏi strict reporting policy. C-40 thêm parent-only lifecycle control để harness chạy đúng graceful stop đã có, không mở surface mới. C-42 đổi shell host khi có sẵn nhưng giữ nguyên .NET process-start authority và identity scheme. C-43 buộc repair có integrity diagnosis thật trước mutation. C-44 chỉ mở rộng bounded diagnostic để tìm root cause, không nới artifact acceptance. C-45 canonicalize duy nhất đường đi của smoke client, không nới production browser/import contract. C-46 chỉ cố định runtime của build tool đã pin/lock, không đổi SEA format hay bytes acceptance. C-47 làm network cut fail-fast thay vì loopback-hang, không cho thêm external egress. C-48 thay implementation injector Linux vì tool pin không xử lý được blob production-size; one-file SEA, fuse, active-resource byte verification và atomic publication vẫn giữ nguyên. C-49 làm baseline đã commit trở thành input bắt buộc có schema đóng, đúng với yêu cầu gate không được tự tắt. C-50 làm test dùng đúng lifecycle handle và process budget của host, không nới assertion hay artifact acceptance. C-51 chỉ loại orchestration trùng lặp trên PR; standalone heavy workflows và coverage ba OS vẫn giữ nguyên. C-52 giữ browser integration ở workflow đã cài exact Chrome, không giảm browser assertion hay process-supervision proof. C-53–C-64 tiếp tục đóng topology/runtime/MCP/evidence theo capability thật: không bootstrap side effect ở thin bridge, không nới timeout control-plane, không bỏ diagnostics khi output lớn, không bỏ deep hash để đạt performance, không retry mutation, và không coi source package là runtime closure của artifact.
