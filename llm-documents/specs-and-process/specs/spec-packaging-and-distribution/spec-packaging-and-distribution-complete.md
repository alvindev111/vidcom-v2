# Spec Packaging & Distribution Runtime

> **Related Documents**:
> - [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) — **Approved** (2026-08-07). 13/13 OQ đã đóng; ba bản sửa OQ-4/OQ-7/OQ-8 đã được duyệt lại
> - [Spike Phase 4](../../../../spikes/phase-4/README.md) — **bốn vòng, mười spike**: S1a/S1b/S2/S3 mở gate kỹ thuật; S4/S5/S6/S7 đóng OQ bằng số đo; S8 kiểm worker trong SEA; [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md) chạy trên Windows và đóng W-1/W-2/W-3 + blocker B1
> - [Detailed Design](./spec-packaging-and-distribution-detailed-design.md) — **Approved** (2026-08-07), bản 2: sau vòng review Design, vòng đo Windows/Linux và số đo darwin trên CI
> - [Implementation Checklist](./spec-packaging-and-distribution-implementation-checklist.md) — **Approved** (2026-08-07), 13 phase A–M, 177 SP. Code execution hoàn tất 2026-08-16 — 174/174 mục
>
> Spec này hiện thực **Giai đoạn 4** của [15-build-order](../../../product-features/15-build-order.md#giai-đoạn-4--đóng-gói--runtime-phân-phối-re-baseline-78-tuần): mục 4.4–4.10 (4.1–4.3 đã chuyển lên 3.12 và **đã xong**). Mức đóng gói tương ứng: [doc 14 §18](../../../product-features/14-local-first-mcp-packaging-architecture.md) Mức 2 + Mức 3, cộng phần baseline của Mức 4 cho ba artifact native và packaged smoke; full 3 OS × 2 kiến trúc vẫn ở Giai đoạn 6.

## Spec Goal

Biến vidcom từ *"chạy được trong checkout của người phát triển"* thành **một file tải xuống chạy được trên máy chưa cài gì**: không Node, không `bun install`, không `node_modules`, không Next.

Đo được bằng một đường chạy duy nhất, trên **artifact**, ở một máy sạch:

```
tải một file → chạy → chọn thư mục workspace trong UI → import/tạo project
  → AI host spawn `vidcom mcp` TRONG KHI UI đang mở → dựng scene
  → narration ra tiếng → render ra MP4 mở lên xem đúng → `vidcom doctor` xanh
```

Ba chữ quan trọng nhất trong câu trên: **trên artifact**. Giai đoạn 1–3 đều xanh khi chạy từ source checkout, và cả ba đều dựa vào những thứ artifact không có — `node_modules`, `next start`, `require.resolve`, `process.execPath` là `node`. Giai đoạn 4 là lúc trả giá cho từng cái.

---

## Bối cảnh — vì sao giai đoạn này không phải "chỉ đóng gói"

Build-order ban đầu xếp Giai đoạn 4 là 3–4 tuần và mô tả nó như phần còn lại sau khi agent-kit chuyển lên 3.12; tài liệu đó đã được re-baseline sau khi Goals được duyệt. Đọc code cho thấy phase này **không thuần đóng gói**: có hai subsystem chưa tồn tại và một giả định đang sai.

| # | Sự thật trong code hôm nay | Hệ quả |
|---|---|---|
| 1 | `vidcom app` spawn `next start` từ `process.cwd()/node_modules/next/dist/bin/next` — [`main.ts:116`](../../../../packages/cli/src/main.ts#L116) | Artifact không có `node_modules`. Mode `app` **không tồn tại** ngoài checkout |
| 2 | `vidcom mcp` tự lấy workspace lease; lease thứ hai bị từ chối — [`startup.ts:207`](../../../../packages/cli/src/startup.ts#L207) | AI host **không** dùng được khi UI đang mở. Single-writer đang được cưỡng chế bằng cách loại trừ, không bằng bridge (PK-4 chưa có) |
| 3 | Render spawn `[process.execPath, <hyperframes CLI>]`, CLI resolve bằng `require.resolve` — [`binary-probe.ts:98`](../../../../packages/adapter/src/hyperframes/binary-probe.ts#L98) | Trong SEA, `process.execPath` là **chính binary vidcom**, không phải `node`; và không có `node_modules/hyperframes`. Render/snapshot fail trên artifact |
| 4 | `motionLibraryRoot` có trong `CompositionRootConfig` nhưng **không entrypoint nào truyền** — [`composition-root.ts:314`](../../../../packages/cli/src/composition-root.ts#L314) | `install_motion_library` đọc `node_modules` của checkout. Đây là bẫy 4.8 mà build-order đã cảnh báo |
| 5 | `nativeDependenciesRoot` đã được truyền ở cả hai entrypoint, nhưng **không có ai giải nén vào đó** — [`next-host.ts:60`](../../../../packages/cli/src/next-host.ts#L60) | Đường dẫn đúng, thư mục rỗng. VieNeu/FFmpeg báo missing đúng trên artifact |
| 6 | Không có `serve` / `worker` / `render` / `doctor` / `version` — [`main.ts:30`](../../../../packages/cli/src/main.ts#L30) | PK-5 mới xong 6/11 mode; không có `doctor` thì người dùng máy sạch không có cách nào tự chẩn đoán |
| 7 | Không có endpoint `/v1/system/*`, không có UI chọn thư mục | D3 ("người dùng bật web lên và chọn thư mục") **chưa đạt**; hôm nay workspace chỉ đến từ `cwd` và `--workspace` |
| 8 | `resolveWorkspace` **luôn resolve**: `cwd` đọc được mà không có marker vẫn thành workspace — [`workspace-resolver.ts:39-64`](../../../../packages/core/src/domain/workspace-resolver.ts#L39) | Không tồn tại trạng thái "chưa chọn workspace". Trên máy sạch, app **im lặng** nhận thư mục tạm làm workspace và lấy lease trên đó ⇒ tiền đề của UI chọn workspace không kiểm được (OQ-10) |
| 9 | Daemon mất lease vẫn giữ listener mở: `onLeaseLost` chỉ revoke session + dừng background — [`next-host.ts:117`](../../../../packages/cli/src/next-host.ts#L117) | Cộng với takeover sau TTL ⇒ **hai daemon cùng sống**, cái không lease vẫn nhận request từ bridge |
| 10 | Migration SQLite chạy **ba lần** mỗi lần boot và **trước** khi có lease — [`workspace-selection.ts:23-30`](../../../../packages/cli/src/workspace-selection.ts#L23), [`:57-60`](../../../../packages/cli/src/workspace-selection.ts#L57) | Hai tiến trình cold-start đồng thời migrate song song, không có gì bảo vệ |
| 11 | 8 file adapter `import` **tĩnh** `@hyperframes/{core,sdk,studio-server,parsers}`; `next.config.ts` giữ chúng + `esbuild` + `linkedom` external | HyperFrames không chỉ được gọi qua CLI mà còn **in-process**. Câu hỏi feasibility của SEA nhân đôi (S1b) |

Mục 2, 3 và 7 là ba chỗ đắt. Chúng không phải "bundle rồi ship" — chúng là code mới ở tầng nghiệp vụ và tầng UI. Mục 8–11 được thêm ở bản 2 của Detailed Goals sau vòng review: chúng không phải hardening mà là **correctness**, và chúng là lý do R1/R2/R8 được ước lượng lại.

---

## Spec Stories

- **Một file, máy sạch**:
    - Là người dùng, tôi muốn **tải một file và chạy được ngay**, không phải cài Node, Python, hay chạy `npm install`.
    - Là người dùng, tôi muốn lần chạy đầu **tự chuẩn bị mọi thứ nó cần** và nói cho tôi biết nó đang làm gì, thay vì báo lỗi thiếu binary.
    - Là người dùng, tôi muốn các binary phụ nằm **trong thư mục ẩn của hệ điều hành**, không nằm cạnh file tôi vừa tải về.
    - Là người dùng, tôi muốn `vidcom doctor` **nói thẳng cái gì thiếu và sửa thế nào**, để không phải đoán khi render fail.

- **Chọn chỗ lưu project bằng UI**:
    - Là người dùng, tôi muốn **chọn thư mục workspace ngay trong app**, không phải gõ `--workspace` với đường dẫn tuyệt đối.
    - Là người dùng, tôi muốn **tạo thư mục mới** ngay trong bước chọn, để bắt đầu ở chỗ trống.
    - Là người dùng, tôi muốn **đổi workspace** mà không phải kill app rồi chạy lại.
    - Là người dùng, tôi muốn app **không mở cửa cho trang web khác** đọc ổ đĩa của tôi chỉ vì nó đang chạy localhost.

- **AI host và UI cùng làm việc**:
    - Là người dùng, tôi muốn mở Codex/Claude Code **trong khi app đang mở**, và cả hai nhìn thấy cùng một trạng thái project.
    - Là người dùng, tôi muốn agent sửa file thì **UI thấy ngay**, không phải reload.
    - Là người dùng, tôi muốn khi app chưa chạy mà AI host gọi `vidcom mcp` thì nó **vẫn dùng được**, hoặc nói rõ tôi phải làm gì.
    - Là người dùng, tôi **không** muốn hai tiến trình cùng ghi vào project của tôi.

- **Mang project của tôi vào**:
    - Là người dùng đã có project HyperFrames ở chỗ khác, tôi muốn **import nó vào workspace** mà không phải copy tay và tự sửa file.
    - Là người dùng, tôi muốn import **không sửa gì vào bản gốc** của tôi, và không im lặng ghi đè project đang có cùng tên.

- **Tin được vào bản tải về**:
    - Là người dùng, tôi muốn biết file tôi tải về **đúng là bản phát hành** (checksum), và trên macOS không bị hệ điều hành từ chối chạy.
    - Là người phát triển, tôi muốn CI **kiểm trên artifact**, không kiểm trên checkout — vì bug của giai đoạn này chỉ xuất hiện ở artifact.

---

## Spec Planning

- **Supplementary files**:
  - [Detailed Goals](./spec-packaging-and-distribution-detailed-goal.md) — **Approved** (2026-08-07). Spike gate đã mở, 13/13 OQ đã đóng, và ba bản sửa OQ-4/OQ-7/OQ-8 đã được duyệt lại.
  - [Detailed Design](./spec-packaging-and-distribution-detailed-design.md) — **Approved** (2026-08-07). 27 quyết định chốt ở §15; ~177 SP.
  - [Implementation Checklist](./spec-packaging-and-distribution-implementation-checklist.md) — **Approved** (2026-08-07), đã thực thi tuần tự A→M và đóng ngày 2026-08-16.
- **Date**: chưa chốt. Ước lượng **7–8 tuần lịch** (bản 4), đã được đồng bộ sang build-order thay cho baseline cũ 3–4 tuần. Lý do lệch: baseline cũ được viết khi Giai đoạn 4 còn được hiểu là "bundle những gì đã chạy được"; thực tế nó chứa hai subsystem chưa tồn tại (MCP bridge của R2, thực thi toolchain trên artifact của R6), một mảng UI mới (R1), một thay đổi lifecycle mà bản 1 tính thiếu (tách `startVidcomFoundation` để đổi workspace lúc runtime — spike cho thấy phần *boot không-workspace* thì rẻ, phần *tách foundation* thì không), và — sau spike — một CPython đóng băng phải ship cùng artifact. Đây là thứ tự tương đối, không phải cam kết lịch. Spike đã chạy xong và **không** nằm trong estimate.
- **Capacity**: **~177 SP** ước lượng planning qua 9 requirement (bản 1: ~120, bản 2: ~150, bản 4: ~165, sau vòng duyệt Goals: ~170). Vòng review Design + đo Windows cộng thêm **7 SP**: R2 34→37 (R2.14 được nới thành ba lối — người dùng duyệt 2026-08-07) và R6 21→25 (xử lý TLS inspection N-1, cộng ép UTF-8 cho sidecar — cả hai đo được ở [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md)). Coi là **sàn**: Phase 2 (132 SP) và Phase 3 (190 SP) đều nở ra ở phase Design. Vòng spike thứ hai làm hai hạng mục rẻ đi (OQ-10 chỉ là một biến đổi được; OQ-13 chọn shim nên không phải ship thêm Node runtime) nhưng không đủ để hạ con số — phần đắt của R1 là tách `startVidcomFoundation`, thứ R1.12 cần dù thế nào. Vòng duyệt 2026-08-07 **cộng thêm 5 SP vào R1** (21→26): OQ-8 hứa "~5 SP cho nút New video" từ bản 2 nhưng **chưa bao giờ vào bảng** — R1.19 giờ ghi nó ra.

| R | Nội dung | ID | SP | Cắt được? |
|---|---|---|---|---|
| R1 | Directory picker server-driven + token flow + **UI chọn workspace** + boot không-workspace + đổi workspace runtime + **UI tạo project từ preset** (OQ-8 → R1.19) | PK-3 | 26 | Không — D3 chưa đạt, và không có nó thì "chạy file tải về" không có bước đầu tiên |
| R2 | Single-writer daemon + MCP bridge qua IPC có xác thực (gồm handshake, mất lease **ba lối**, race auto-start) | PK-4 | 37 | Không — hôm nay UI và AI host loại trừ nhau |
| R3 | `vidcom` đủ mode + `doctor` | PK-5, PK-8 | 13 | Một phần — `worker` cắt được (OQ-9) |
| R4 | Node SEA: bundle backend, **nhúng frontend static export**, http-driver, bỏ Next khỏi artifact | PK-6 | 21 | Không — đây là D2 |
| R5 | Giải nén native runtime + **thư viện motion** + sidecar + **CPython đóng băng đã prune/pin** + binary esbuild vào app-data lần chạy đầu | PK-7 | 21 | Không — bẫy 4.8 |
| R6 | Toolchain render/TTS chạy được **từ artifact**: hyperframes CLI **+ in-process**, hình dạng spawn mới, cây tiến trình, timeout compiler, Chromium, FFmpeg, VieNeu, **UTF-8 ép cho sidecar + xử lý TLS inspection (N-1)** | PK-7, PK-8 | 25 | Không — không có nó thì artifact không render được, tức không có sản phẩm |
| R7 | Import project có sẵn từ ngoài workspace | PK-12 | 8 | **Có** — ứng viên cắt số 1 |
| R8 | Smoke test trên artifact, máy sạch, trong CI (ba nền tảng, cô lập PATH/HOME) | — | 21 | Không — MUST NOT cắt; đây là thứ duy nhất chứng minh mốc đạt |
| R9 | Hygiene & provenance của artifact | PK-10 (một phần) | 5 | Một phần — chỉ giữ checksum + ad-hoc signature |

Thang cắt nếu velocity không tới: **R7** (8) → **R3 mode `worker`** (3). MUST NOT cắt R8, MUST NOT cắt R6, MUST NOT cắt phần "không có secret trong bundle" của R9.

- **Testing**: logic test cho mọi hàm thuần mới (browse entry mapping, doctor check aggregation, manifest/checksum verify, import plan); **integration test trên SQLite trong app-data + filesystem thật trong thư mục tạm** cho lease/bridge/extraction/import; golden file cho payload `doctor --json` và `system/browse`; **smoke test chạy trên artifact đã build** (R8) là tầng bắt buộc mới của giai đoạn này.
  > Datastore thật vẫn là **SQLite trong app-data + filesystem trong temp directory**. MUST NOT mock `node:fs`.
  > Test R8 MUST chạy với `node` **không có trên PATH** và **không có `node_modules`** cạnh artifact. Đây là điều kiện duy nhất phân biệt nó với 113 test hiện có.
  > Test thiếu binary MUST **skip có thông báo** ở job thường và MUST **fail** ở job smoke — cùng luật đã áp cho FFmpeg (`VIDCOM_REQUIRE_FFMPEG`) và VieNeu ở Phase 2/3.
- **Risks**: xem [Detailed Goals §6](./spec-packaging-and-distribution-detailed-goal.md). Bốn cái nặng nhất **sau spike**:
  - **~~R6 là gate kỹ thuật~~ — đã đóng, nhưng rủi ro đổi bản chất thành "hỏng im lặng".** S1a/S1b PASS nên cấu trúc artifact không đổi. Nhưng hai chế độ hỏng đo được đều **không báo lỗi**: hình dạng spawn hôm nay làm artifact **vào lại `main` của chính nó** thay vì chạy CLI, và esbuild trong SEA **treo vĩnh viễn** nếu thiếu `ESBUILD_BINARY_PATH` hoặc `ESBUILD_WORKER_THREADS=0`. Không có test bắt hai thứ này thì CI vẫn xanh trong khi sản phẩm đứng im.
  - **~~TTS chưa có đường thực hiện~~ — đã đóng bằng cách ship một Python.** S3 PASS: CPython đóng băng + `vieneu==3.2.4` torch-free ra WAV trên máy không có `python3`. Giá: **+150 MB artifact** (đã prune) và **1,6 GB weights** ở lần chạy đầu. Rủi ro còn lại là danh sách package không pin (phình thêm 95 MB không ai để ý) và upstream đổi API mà không có compile step nào bắt.
  - **`output: 'export'` chạm FE nhiều hơn bản 2 nghĩ.** Ngoài catch-all route handler làm `next build` fail và origin dev không được lọt vào artifact: `generateStaticParams` **không sống được trong file `"use client"`** (phải tách server shell / client child), và payload RSC hard-code sentinel nên `params` luôn trả `__shell` — slug phải đọc từ `location`.
  - **"Chạy trên máy sạch" không kiểm được trên máy phát triển.** Máy nào build artifact đều có Node, Python, FFmpeg. Không có job CI cô lập PATH/HOME thì R8 sẽ xanh vì lý do sai.
- **Commitments**:
  - Một file thực thi (~300 MB) cho nền tảng đang build; chạy trên máy chưa cài Node/Python và mở được UI. **Cần mạng ở lần chạy đầu** để lấy weights TTS (~1,6 GB) và Chrome Headless Shell (94,5 MB, ~8 s đo thật) — mốc là "chưa cài gì", **không phải "không mạng"**. Biên giới đã chốt ở OQ-12: thứ không lấy sau được thì ship, thứ lấy được thì tải.
  - Người dùng chọn được workspace trong UI, không cần cờ dòng lệnh.
  - AI host gọi `vidcom mcp` **trong khi UI đang mở** và cả hai thấy cùng state; vẫn đúng một writer, và bridge xác minh được nó nối đúng daemon.
  - `vidcom doctor` liệt kê đủ thành phần runtime với trạng thái và cách sửa; exit code phản ánh trạng thái theo bảng phân loại bắt buộc/tuỳ chọn.
  - Render MP4 và snapshot chạy được **từ artifact**, không phải từ checkout. **Narration ra tiếng trên máy chưa cài Python là commitment đầy đủ** — S3 PASS nên điều kiện của bản 2 được gỡ.
  - Smoke test trên artifact chạy trong CI và **fail** khi một thành phần bắt buộc vắng mặt.
  - Không có secret, không có sourcemap trong bundle; artifact có checksum ghi lại.

## Phase Approvals

- **Detailed Goals**: **Approved** — người dùng duyệt ngày 2026-08-07 sau khi chấp nhận ba bản sửa OQ-4/OQ-7/OQ-8. OQ-7 chốt ba nền tảng target, Windows là release gate; defer Linux chỉ qua một scope change mới và phải tuyên bố hẹp lại.
  **Sửa sau khi duyệt (2026-08-07, cùng ngày, người dùng duyệt riêng):** R2.14 được nới từ hai lối lên **ba lối** — thêm "hạ xuống chưa-có-workspace, giữ listener" cho trường hợp có UI; headless vẫn dừng hẳn. Bất biến single-writer không đổi, nhưng trở thành nghĩa vụ chứng minh bằng test thay vì bằng việc đóng tiến trình.
- **Detailed Design**: **Approved** — alvin0 duyệt ngày 2026-08-07 sau bốn vòng review (blocker P1, steering 14/14, đo ba nền tảng). Gate §15 đã mở; xem [Detailed Design](./spec-packaging-and-distribution-detailed-design.md).
- **Implementation Checklist**: **Approved / Complete** — người dùng yêu cầu thực thi trọn vẹn ngày 2026-08-07; đóng ngày 2026-08-16 với mục cuối cùng (Phase D artifact AC) khép lại bằng C-71 ([13 phase A–M, 177 SP](./spec-packaging-and-distribution-implementation-checklist.md)).

## During Spec
- **Standups**: bắt đầu 2026-08-07 tại Phase A; tiến độ và bằng chứng được ghi trong Execution Log của checklist.
- **Impediments**: **ba món nợ kiểm chứng đã chạy trên máy Windows ngày 2026-08-07** — xem [S9](../../../../spikes/phase-4/s9-windows-runtime/README.md). Hai đóng hẳn, hai đóng một nửa với giá đã biết, và vòng đo sinh thêm hai món mới.

  | # | Trạng thái | Kết quả đo | Đi vào đâu |
  |---|---|---|---|
  | **W-1** | **ĐÓNG** | Cùng hostname hai đầu ⇒ `SameSite=Strict` sống qua port khác, cả fetch lẫn SSE. Khác hostname ⇒ `exchange` trả 200 mà cookie **không bao giờ quay lại** — hỏng im lặng, đúng lý do R4.12 đòi fail tường minh | Design §5.11 |
  | **W-2** | **ĐÓNG một nửa** | Transport PASS: cùng Hono app qua `\\.\pipe\…`, GET/POST 200, `EADDRINUSE` cho luôn single-instance. Nhưng **Node không có tham số đặt security descriptor** ⇒ "tương đương 0600" cần native code | D3 giữ deferred, giá đã biết |
  | **W-3** | **ĐÓNG một nửa** | `HTTPS_PROXY` **bị lờ** (tải thật 202 MB qua proxy chết) ⇒ bước offline của R8.8 phải chặn ở **tầng mạng runner**. Cache **tải dở** được `browser path` báo ok exit 0 ⇒ hỏng im lặng. `HF_HUB_OFFLINE=1` + cache rỗng hỏng đúng cách: 1 s, có thông điệp, không treo | Design §5.9, §11.3 |
  | **B1** (mới, từ review Design) | **ĐÓNG — cả ba nền tảng đã đo thật** | Windows resolve **79** package (thừa `colorama` + `tzdata`); **darwin và Linux đều 77**, prune còn đúng core **55** và `diff` giữa hai tập là rỗng. Luật "một danh sách, lệch là fail" sẽ tự làm fail build Windows ngày đầu. Sau prune, không `pip`: **481 / 499 / 595 MB** (darwin đo trên `macos-latest` của CI) | Design §5.13, DR-15 |
  | **N-1** (mới) | **MỞ** | Mạng có FortiGate TLS inspection **chỉ với `huggingface.co`**; CA không có trong trust store. CPython đóng băng dùng `certifi` ⇒ **không tải được weights**. Không phải offline, không phải online | Design §5.13, mã lỗi `download_tls_untrusted` |
  | **W-4** (mới) | **MỞ** | **TTS ra WAV trên Windows chưa chứng minh được** vì N-1. Không suy được từ darwin | Bước 8 của packaged smoke Windows |

  Thời gian giải nén đo được: **26,9 s** cho 510 MB (18 core, NVMe), **đã có AV quét on-access** — máy đo chạy Sophos Intercept X real-time (Defender tắt vì Sophos giữ vai trò đó). Thứ còn thiếu là **hạng phần cứng của runner**, không phải antivirus; lần smoke Windows đầu tiên chốt lại trần 180 s.

  Windows còn là nơi **OQ-7 nói không được cắt**: ACL thay `0700`/`0600` (R5.9, R2.5), `rename` qua thiết bị (R5.3, R7.12), khoá file khi `doctor` re-extract (R3.13), kill cây process qua `powershell-cim` thay `ps` (R6.8). Những mục này **chưa** nằm trong vòng S9 và vẫn chờ vòng kiểm Windows tiếp theo.
- **Adjustments**: **hai bug Phase 3 đã sửa trước khi vào Giai đoạn 4** (2026-08-07) — xem [Detailed Goals §1.8](./spec-packaging-and-distribution-detailed-goal.md). Chúng nằm ngoài phạm vi giai đoạn này về mặt nguồn gốc, nhưng R3.5 và R8.3 dựa vào chúng nên sửa trước rẻ hơn sửa sau.

## Spec Review
- **Completed** (2026-08-16): 13 phase A–M đóng, 174/174 mục checklist. Mục cuối cùng còn mở — render MP4 **từ production release artifact** — đóng bằng C-71: nguồn release mà C-21 đã duyệt từ Phase M chưa bao giờ có code chạy nó, nên đường duy nhất tới artifact vẫn là smoke fixture. `scripts/build-release-media.mjs` dựng ffmpeg/ffprobe 7.1.1 từ đúng các pin upstream, và runtime input của artifact pin đúng digest provenance đo được.
- **Demo**: Artifact production tại commit `3f49e7c` (`dirty=false`, SHA-256 `fb658b6b…56d7a1`, `ffmpeg 7.1.1`) chạy packaged smoke với **PATH rỗng** và app-data/runtime rỗng: nhận dạng, cold/warm doctor, chọn workspace và tạo project qua UI, import từ ngoài workspace, MCP bridge 35/35 tool cạnh một UI lease, **MP4 8,000000 s có video + audio** từ VieNeu WAV + snapshot, upload 20 MB/SSE, render wait/detach/cancel với exhaustive zero-survivor proof, lease loss cả hai nhánh, và provenance/checksum.
- **Feedback**: 12/13 bước xanh trên máy dev; `offline` là bước duy nhất không chạy được ở đó vì nó đòi cắt mạng ở **tầng runner** (`sudo -n route`) — đúng lý do M.4 tồn tại, và nó đã đóng bằng exact-head CI ba OS. Ba nền tảng native (macOS arm64, Linux x64, Windows x64) vẫn xanh ở exact head với fixture runtime; nguồn release mới hiện chỉ dựng cho host chạy driver, và DR-1 vẫn cấm cross-build.

## Spec Retrospective
- **Well**: Giữ smoke chạy **trên artifact** chứ không trên checkout là thứ tìm ra gần như mọi lỗi thật của giai đoạn này — `version` trả `null`, `doctor --repair` không bao giờ repair được, hình dạng spawn làm artifact vào lại `main` của chính nó. Luật "digest quyết định bytes, không phải URL" cho phép đổi transport mà không hạ chuẩn. Verifier artifact bắt được prefix build nằm trong checkout, đúng loại lỗi chỉ lộ ra trên máy người dùng.
- **Not Well**: C-21 duyệt nguồn release rồi để đó **chín ngày** mà không có code chạy nó; một quyết định được duyệt nhưng không thực thi trông giống hệt một quyết định đã xong cho tới lúc có người đi đóng AC. Baseline startup một sample suýt biến hai gate thành một gate (C-67). Nhiều vòng CI đỏ vì test/harness budget chứ không vì sản phẩm (C-65, C-66, C-68, C-70).
- **Improvements**: Mỗi correction ghi "nguồn/đường được duyệt" nên kèm luôn task tạo code chạy nó, nếu không nó là tài liệu chứ không phải cơ chế. Gate thống kê cần tối thiểu số mẫu ngay từ lần đặt baseline đầu tiên.

## Next Spec Adjustments
- **Changes**: Release artifact phải dựng từ `build-release-media.mjs` + `prepare-packaged-runtime --release-media`; fixture của mirror bên thứ ba chỉ dùng cho CI smoke và MUST NOT phát hành.
- **Carry-over**: Dựng nguồn release cho Linux x64 và Windows x64 trên chính host của chúng (DR-1); ký/notarize và full 3 OS × 2 kiến trúc vẫn ở Giai đoạn 6; W-2 (security descriptor cho named pipe Windows) và N-1 (TLS inspection với `huggingface.co`) vẫn mở.
- **Lessons**: Một danh sách nguồn được duyệt không sinh ra binary nào. Và provenance phải trả lời hai câu độc lập — record nêu đúng nguồn, **và** bytes cạnh nó vẫn khớp record — vì một record chỉ tự đồng ý với chính nó thì cho bất kỳ binary nào được phát hành dưới tên một source build.
