# Spike Phase 4 — gate kỹ thuật trước Detailed Design

> Chạy ngày **2026-08-06** trên `darwin arm64`, Node `v24.9.0`, commit `c9922fd`.
> Mục đích: đóng bốn câu hỏi PASS/FAIL mà [Detailed Goals §5](../../llm-documents/specs-and-process/specs/spec-packaging-and-distribution/spec-packaging-and-distribution-detailed-goal.md) chặn Design lại để chờ. Không viết production code.

| Spike | Câu hỏi | Kết quả |
|---|---|---|
| **S3** | TTS ra WAV trên máy không có Python | **PASS, nhưng giá đắt** — 150 MB archive + 1,6 GB weights |
| **S1a** | SEA spawn được HyperFrames CLI khi `process.execPath` là artifact | **PASS qua shim**; hình dạng hôm nay FAIL im lặng |
| **S1b** | `@hyperframes/*` gọi in-process từ SEA | **PASS có điều kiện** — thiếu điều kiện thì **treo**, không lỗi |
| **S2** | Next `output: 'export'` phục vụ được `/projects/<slug>` từ SEA | **PASS sau hai thay đổi FE bắt buộc** |

Kết luận chung: **không spike nào FAIL cứng**, nên cấu trúc đóng gói của bản 2 đứng vững. Nhưng cả bốn đều sinh ràng buộc mới, và ba trong số đó là thứ nếu phát hiện lúc đang code thì mất ngày.

---

## S3 — TTS trên máy không có Python

**Cách làm**: `python-build-standalone` CPython `3.12.13+20260805` (`aarch64-apple-darwin`, `install_only_stripped`) → `pip install vieneu==3.2.4 huggingface-hub` → chạy [`worker.py`](../../packages/adapter/sidecars/vieneu/worker.py) bằng đường dẫn tuyệt đối tới interpreter đóng băng, trong `env -i` với `PATH=/usr/bin:/bin` (không có `python3` của homebrew) và `HOME` sạch.

**Kết quả: PASS.** Một dòng tiếng Việt ra WAV hợp lệ.

```
probe        ready=true, 14 preset voice, gpu=false
synthesize   exit 0
WAV          4,88 s · 234.240 sample · mean_volume -20,1 dB · max -6,3 dB
```

Bằng chứng: [`s3-tts-no-python/evidence/cue1.vieneu.wav`](s3-tts-no-python/evidence/cue1.vieneu.wav). Cách dựng lại: [`s3-tts-no-python/setup.sh`](s3-tts-no-python/setup.sh).

**Đo được — đây là phần đắt:**

| Thứ | Kích thước |
|---|---|
| CPython trần (tar.gz / giải nén) | 23,8 MB / 66 MB |
| Cả stack `vieneu==3.2.4` (tar.gz / giải nén) | **245 MB / 805 MB** |
| Stack đã prune (tar.gz / giải nén) | **150 MB / 508 MB** |
| Weights HF tải lần đầu (`HF_HOME`) | **1,6 GB** |
| Cold (tải weights + synth) | 23,5 s |
| Warm | 7,1 s |

Torch-free đúng như [`requirements.txt`](../../packages/adapter/sidecars/vieneu/requirements.txt) nói (`import torch` → `ModuleNotFoundError`). Nhưng `vieneu==3.2.4` kéo theo cả một stack không dùng tới. Prune được **313 MB** mà WAV vẫn ra. Vòng đầu chỉ xoá thư mục lớn (805 → 508 MB); vòng review Design gỡ **đủ 21 package** bằng `pip uninstall` và đo lại: **492 MB giải nén / 145,9 MB nén**, WAV vẫn hợp lệ.

```
fastapi gradio gradio_client groovy hf-gradio llvmlite markdown-it-py mdurl numba
pillow pygments python-multipart rich safehttpx scikit-learn semantic-version
shellingham starlette tomlkit typer uvicorn
```

Còn lại **56 package** — danh sách pin đầy đủ ở [Detailed Design §5.13](../../llm-documents/specs-and-process/specs/spec-packaging-and-distribution/spec-packaging-and-distribution-detailed-design.md).

Còn lại là thật: `scipy` 98 MB, `onnxruntime` 74 MB, `numpy` 33 MB.

**Hệ quả cho Goals:**

- **P-C giữ được** ("không Python trên máy người dùng") — nhưng bằng cách **ship một Python**, không bằng cách bỏ Python. Câu chữ của P-C phải sửa cho đúng thứ thật sự xảy ra.
- **R6.1 giữ nguyên được**: "render ra MP4 có tiếng narration trên máy không cài gì" là hứa được. Không cần viết lại như nhánh FAIL của R6.1 dự phòng.
- **Nhưng lời hứa "một file tải xuống" thì phải nói lại con số.** Cộng dồn: SEA base ~110–130 MB + Python stack đã prune 150 MB + FFmpeg → **~300 MB tải về**, và **1,6 GB weights + 150–200 MB Chromium** ở lần chạy đầu. Đây là quyết định sản phẩm cùng hạng OQ-3, và nó **chưa có OQ**.
- **Prune là requirement, không phải tối ưu hoá.** 297 MB là chênh lệch giữa "tải 300 MB" và "tải 450 MB". Danh sách package được ship phải được chốt và pin, không để `pip install` quyết định.

**Hai bug Phase 3 lộ ra khi chạy thật** (không thuộc phạm vi Giai đoạn 4, nhưng làm narration hỏng hôm nay):

1. **Voice id trả về là repr của tuple Python.** `probe()` làm `[str(name) for name in engine.list_preset_voices()]`, mà `list_preset_voices()` trả **tuple** `(label, id)` — [`worker.py:113`](../../packages/adapter/sidecars/vieneu/worker.py#L113). Nên catalogue của VidCom chứa `"('Minh Đức — Nam · Bắc · Phong cách tin tức', 'Minh Đức')"`. Đưa chuỗi đó ngược lại `infer(voice=…)`:
   ```
   Voice '('Minh Đức — Nam · Bắc · Phong cách tin tức', 'Minh Đức')' not found.
   Available: ['Minh Đức', 'Phạm Tuyên', …]
   ```
   Truyền `"Minh Đức"` thì chạy. Tức là **mọi voice chọn từ catalogue đều fail**.
2. **`engineVersion` luôn rỗng.** `getattr(vieneu, "__version__", "")` không có thuộc tính đó, nên R3.5 (`doctor` báo version sidecar) không có gì để báo.

**Một luật nữa cho R6.5/offline:** `snapshot_download` vẫn gọi mạng ở lần chạy warm (cảnh báo HF Hub in ra mỗi lần). Đặt `HF_HUB_OFFLINE=1` thì chạy hoàn toàn từ cache — đã kiểm, exit 0. [`tts-vieneu.ts:322-327`](../../packages/adapter/src/tts/tts-vieneu.ts#L322) hôm nay đặt `HF_HOME`/`HF_HUB_CACHE`/`TORCH_HOME` nhưng **không** đặt cờ này.

---

## S1a — spawn HyperFrames CLI từ artifact

**Ba hình dạng, mỗi hình dạng một lần chạy** (hình dạng `naive` tự gọi lại chính binary, chạy chung một tiến trình thì hỏng phép đo). Tất cả trong `env -i`, `PATH=/usr/bin:/bin`, **không có `node`**, cwd là thư mục tạm.

| Hình dạng | Lệnh | Kết quả |
|---|---|---|
| `naive` (code hôm nay) | `[execPath, cliPath, …]` | **exit 97** — SEA nhận `argv[1]` là **chính nó**, CLI không bao giờ chạy |
| `shim` | `[execPath, "--vidcom-node", cliPath, …]` rồi `import()` | **OK** |
| `sidecar` | `[nodeĐãGiảiNén, cliPath, …]` | **OK** |

Điểm quan trọng của `naive`: nó **không báo lỗi**. `argv` mà binary nhận là

```
[".../s1a-spawn-cli/.artifacts/sea-entry-bin",
 ".../s1a-spawn-cli/.artifacts/sea-entry-bin",
 ".../node_modules/hyperframes/bin/hyperframes.mjs", …]
```

— artifact chạy lại chính main của nó với đường dẫn CLI làm tham số thường. Trong production đó là **daemon tự khởi động thêm một lần nữa**, không phải một lỗi render.

**Đo qua `shim`, đúng shape [`render-job.ts:369-379`](../../packages/worker/src/render-job.ts#L369) dùng:**

| Lệnh | exit | thời gian |
|---|---|---|
| `hyperframes --version` → `0.7.86` | 0 | 249 ms |
| `compositions <project>` → 7 composition | 0 | 1.223 ms |
| `browser path` (chỗ spawn thứ hai, [`binary-probe.ts:66`](../../packages/adapter/src/hyperframes/binary-probe.ts#L66)) | 0 | 1.249 ms |
| `render <project> -o out.mp4 --workers 1 --quiet --best-effort` | 0 | **65,8 s** |
| `sidecar --version` (Node thật) | 0 | 206 ms |

MP4 verify bằng FFprobe: `h264 · 1920×1080 · duration=14.000000 · 4.807.398 byte`. **Tiêu chí PASS (a) đạt.**

Ghi thêm: lần chạy `--no-best-effort` **fail có lý do nội dung**, không phải lý do đóng gói — `Render blocked by 1 correctness warning: sub_timeline_readiness_timeout`. Nghĩa là đường render chạy hết: Chrome khởi động, serve `http://localhost:<port>/index.html`, capture frame, ffmpeg encode.

**Tiêu chí PASS (b) — huỷ giữa chừng — ~~KHÔNG đạt~~ → ĐÃ ĐÍNH CHÍNH Ở VÒNG 2.** Lần chạy này giết tiến trình cha giữa render (SIGALRM giây 30) và để lại hai tiến trình sống:

```
44299  sea-entry-bin --vidcom-node …/hyperframes.mjs render … --best-effort
44338  ffmpeg -f image2pipe … -o …/work-3f11ab1c-…/video-only.mp4
```

> **Đính chính (S4).** Kết quả trên là **lỗi của spike, không phải của shim**: nó dùng `spawn` trần — không `detached`, không giết theo process group. Chạy lại đúng giao thức của [`process-supervisor.ts`](../../packages/adapter/src/runtime/process-supervisor.ts) thì **cả shim lẫn sidecar đều 0 tiến trình sống sót** (§Vòng 2 → S4). Suy luận kèm theo — "luật kill MUST NOT nhận diện con bằng `execPath`" — cũng sai: supervisor nhận diện bằng `(pid, startedAt)` + pgid và không hề đọc `execPath`.
>
> Giữ đoạn này nguyên văn thay vì xoá, vì nó là ví dụ đắt: **một spike sai giao thức tạo ra một requirement sai**, và requirement đó suýt chọn sai phương án đóng gói.

**Chọn shim hay sidecar?** Cả hai PASS. Vòng 1 nghiêng về sidecar vì cây tiến trình; vòng 2 bác bỏ lý do đó và đo lại giá — Node là **35,9 MB nén** (không phải ~110 MB như vòng 1 ghi), còn shim tốn 0 MB và +43 ms mỗi lần spawn. → **OQ-13 chốt shim**, xem §Vòng 2.

**Ghi thêm — telemetry.** CLI in ra stderr ở lần chạy đầu:

> `Hyperframes collects anonymous usage data to improve the tool. … If you sign in to HeyGen, your account (email, or username) is linked to your usage. Disable anytime: hyperframes telemetry disable`

Sản phẩm local-first mà toolchain nhúng tự gửi dữ liệu là chuyện phải quyết, không phải chuyện bỏ qua. Nó đi qua stderr nên **không** vi phạm R2.6, nhưng thuộc R9.

---

## S1b — gọi `@hyperframes/*` in-process từ SEA

**Cách làm**: bundle đúng nhóm import mà adapter dùng hôm nay (`@hyperframes/core`, `/core/registry`, `/sdk`, `/studio-server`, `/parsers/gsap-parser`, cộng `linkedom`) bằng esbuild → CJS → Node SEA. Chạy trong thư mục tạm, `env -i`, không `node`, không `node_modules`.

**Kết quả: PASS.** 9/9 bước, binary 119,8 MB, bundle 3,36 MB, 503 module đầu vào (104 của `@hyperframes`, 124 của `linkedom`).

```
resolveWithinProject   ok      parseNumeric  ok      resolveBlockCategory  ok ("scenes")
linkedom               ok      runtimeScript ok (340.767 byte)
parseGsapScript        ok      openComposition ok (1 root element)
readClipTiming         ok (7 clip; clip đầu duration=14, trackIndex=0)
editAndSerialize       ok (setText qua composition.dispatch → serialize, 6.584 byte, đã đổi)
buildSubCompositionHtml ok (8.961 byte)
```

`execPath` trong kết quả là chính artifact — đúng điều kiện SEA.

**Nhưng `esbuild` là một điều kiện, và thiếu nó thì hệ thống TREO.**

`@hyperframes/core` gọi esbuild ở hai chỗ: `dist/compiler/htmlBundler.js:650` (`transformSync`) và `dist/inline-scripts/hyperframesRuntime.engine.js:22` (`buildSync`). esbuild định vị **binary native** của nó bằng `require.resolve("esbuild")` — thứ không tồn tại trong SEA. Ma trận đo được:

| `ESBUILD_BINARY_PATH` | `ESBUILD_WORKER_THREADS` | Kết quả |
|---|---|---|
| chưa đặt | mặc định | **TREO** — SIGALRM sau 25 s, **không một dòng stderr** |
| đã đặt | mặc định | **TREO** — y hệt |
| chưa đặt | `0` | lỗi sạch, exit 1: *"The esbuild JavaScript API cannot be bundled…"* |
| **đã đặt** | **`0`** | **PASS** — `transformSync` trả `const answer = 42;` |

Cơ chế: API sync của esbuild chạy qua **worker thread** ([`main.js:1794-1808`](../../node_modules/.bun/esbuild@0.25.12/node_modules/esbuild/lib/main.js)), và worker đó khởi động bằng `__filename` — trong SEA không phải file thật, nên `Atomics.wait` chờ vĩnh viễn. Tắt worker thread thì rơi về nhánh `child_process`, lúc đó mới cần `ESBUILD_BINARY_PATH` trỏ vào binary đã giải nén.

**Hệ quả cho Goals:**

- **R6.10 chốt được về phía "bundle được"**, không phải "đổi sang resolve động". 8 điểm `import` tĩnh giữ nguyên.
- Nhưng R5 phải ship **binary native của esbuild** trong archive, và R6 phải **đặt hai biến môi trường** ở mọi đường gọi in-process. Thiếu một trong hai = **treo không dấu vết** — tệ hơn lỗi, và là thứ `doctor` không phát hiện được bằng cách kiểm sự tồn tại của file.
- **Đề nghị một AC mới**: mọi đường gọi in-process chạm compiler SHALL có **timeout**, để chế độ hỏng là lỗi có mã chứ không phải treo.
- Đối lập đáng chú ý với S1a: **CLI spawn ra thì esbuild chạy bình thường** (`compositions` PASS), vì nó có `node_modules` thật. Vấn đề chỉ thuộc về đường in-process.

**Một ràng buộc phụ**: Node SEA nhận main **CJS**, mà esbuild từ chối `top-level await` ở format cjs. Cả hai entry của spike phải bọc trong `async function main()`. Entry của artifact sẽ chịu cùng luật.

---

## S2 — Next `output: 'export'` phục vụ từ SEA

App Next nhỏ độc lập ([`s2-export/`](s2-export/)), theo tiền lệ `spikes/phase-0/next-route-precedence/`: một page `"use client"` ở `/`, một dynamic route `/projects/[slug]`, một catch-all route handler sao chép hình dạng của [`src/app/api/[[...route]]/route.ts`](../../src/app/api/[[...route]]/route.ts). Next `16.2.12`.

**Hai thứ chặn `next build`, cả hai đều là requirement chứ không phải chi tiết Design:**

1. **Catch-all route handler — R4.11 xác nhận bằng build thật, không phải suy luận:**
   ```
   Error: export const dynamic = "force-dynamic" on page "/api/[[...route]]"
   cannot be used with "output: export".
   > Build error occurred
   Error: Failed to collect page data for /api/[[...route]]
   ```

2. **`generateStaticParams` không sống được trong file `"use client"` — bản 2 chưa biết:**
   ```
   The exported configuration object in a source file needs to have a very
   specific format from which some properties can be statically parsed at
   compiled-time.
     ./app/projects/[slug]/page.tsx  [Client Component Browser]
   ```
   Nên page phải **tách đôi**: một server component xuất `generateStaticParams`, và toàn bộ thân page cũ chuyển thành một client component con. [`src/app/projects/[slug]/page.tsx`](../../src/app/projects/[slug]/page.tsx) hôm nay là `"use client"` → **bắt buộc phải sửa**, không phải tuỳ chọn.

Sau hai thay đổi đó build PASS:

```
Route (app)
┌ ○ /
├ ○ /_not-found
└ ● /projects/[slug]
  └ /projects/__shell
```

**Layout xuất ra** (mặc định `trailingSlash: false`): `out/index.html`, `out/404.html`, `out/projects/__shell.html` — tức `<tên>.html`, **không** phải `<tên>/index.html`. Tổng 36 file, 768 KB.

**Thứ bản 2 chưa tính: Next 16 phát sinh cả file payload RSC `.txt`** cạnh HTML (`out/projects/__shell/__next.projects.$d$slug.__PAGE__.txt`, …). Router phía client fetch chúng khi điều hướng, nên host SEA phải map **cả chúng** về shell, không chỉ map HTML.

**Host SEA phục vụ từ bộ nhớ** ([`host-entry.mjs`](s2-export/host-entry.mjs), binary 117,4 MB, nhúng 36 file / 916 KB):

| Request | Kết quả |
|---|---|
| `GET /` | 200, `X-Served-Via: direct` |
| `GET /projects/a-slug-that-did-not-exist-at-build` | 200, `X-Served-Via: shell-html`, trả đúng shell |
| `GET /projects/<slug lạ>/__next.projects.$d$slug.__PAGE__.txt` | 200, `X-Served-Via: shell-rsc` |
| SSE `GET /sse` | 5 event, mốc `+275 / +575 / +875 / +1176 / +1478 ms` — **không bị buffer** |
| `POST /upload` 20 MB | `{"bytes":20971520}` |
| Cạnh binary sau khi chạy | **không có thư mục asset nào** |

**Ràng buộc FE thứ ba, và là cái sắc nhất:** payload RSC trong shell **hard-code sentinel**:

```json
"c": ["", "projects", "__shell"]
```

Nghĩa là `params` mà Next trả cho page luôn là `__shell`, bất kể URL thật. [`src/app/projects/[slug]/page.tsx:31`](../../src/app/projects/[slug]/page.tsx#L31) hôm nay đọc slug bằng `React.use(params)` → **sẽ luôn nhận `__shell`**. Slug thật phải đọc từ `location`.

**Chưa kiểm**: cookie session cross-origin ở chế độ dev. SameSite chỉ do browser cưỡng chế nên `curl` không kiểm được; cần một harness browser. Phân tích vẫn đứng: port không thuộc định nghĩa "site" nên `sameSite: "Strict"` đi được, **nhưng `localhost` và `127.0.0.1` là hai site khác nhau**, nên hai đầu dev phải pin về **cùng một hostname**.

---

## Vòng 2 — bốn spike đóng OQ (2026-08-06)

Vòng 1 mở gate kỹ thuật. Vòng 2 nhắm vào **11 open question** đang chặn Design, lấy số thật thay cho phỏng đoán. Ba trong bốn spike **bác bỏ** một giả định của Goals bản 3.

| Spike | Câu hỏi | Kết quả |
|---|---|---|
| **S4** | shim hay sidecar Node? (OQ-13) | **Lý do chọn sidecar của bản 3 SAI** — kill-tree sạch ở cả hai |
| **S5** | Chromium bundle hay tải? (OQ-3, 11, 12) | Tải: **8 s / 94,5 MB → 196 MB đĩa**; cache theo `$HOME` |
| **S6** | boot khi chưa có workspace (OQ-10) | **Rẻ hơn bản 3 nhiều** — một biến đổi được, không phải rewrite lifecycle |
| **S7** | transport bridge (OQ-2) | Chiếm port **có thật**; unix socket chạy được với cùng Hono app |

---

### S4 — shim hay sidecar Node (OQ-13)

Bản 3 khuyến nghị **sidecar** với lý do: *"với shim, cha và con cùng một `execPath`, nên mọi luật kill/nhận diện của R6.8 phải né đường dẫn và dễ sai lặng lẽ."*

**Lý do đó sai.** Đọc [`process-supervisor.ts`](../../packages/adapter/src/runtime/process-supervisor.ts): luật kill **không dùng `execPath`**. Nó `spawn(detached: true)` cho con một process group riêng, liệt kê `ps -Ao pid=,ppid=,pgid=,lstart=`, lấy hậu duệ của `rootPid`, giết theo group, rồi quét xác minh bằng cặp `(pid, startedAt)`.

Chạy đúng giao thức đó với cả hai hình dạng, huỷ render ở giây thứ 25:

| Hình dạng | Tiến trình bắt được | Process group | Sống sót | Sweeps |
|---|---|---|---|---|
| shim | 26 | 4 | **0** | 2 |
| sidecar | 25 | 4 | **0** | 2 |

Cả hai **CLEAN**. Kết quả "để lại mồ côi" ở vòng 1 là lỗi của spike — nó dùng `spawn` trần, không `detached`, không giết theo group.

**Giá thật của mỗi bên**, đo lại:

| | shim | sidecar |
|---|---|---|
| Cộng vào bản tải về | **0** | Node 112 MB thô → **35,9 MB nén** |
| Chi phí mỗi lần spawn | +43 ms | — |
| Kill-tree | sạch | sạch |

Bản 3 ghi sidecar tốn "~110 MB" — sai, vì đó là kích thước chưa nén. Con số thật là **36 MB**.

→ **OQ-13: chọn shim.** Nó miễn phí, và lý lẽ duy nhất chống lại nó đã bị bác bỏ. R6.8 bỏ câu "MUST NOT nhận diện con bằng `execPath`" — luật hiện có đã đúng sẵn, việc cần làm chỉ là **test huỷ-giữa-chừng**, không phải sửa cơ chế.

---

### S5 — Chromium: bundle hay tải (OQ-3, OQ-11, OQ-12)

`hyperframes browser ensure` tải **Chrome Headless Shell v152.0.7928.2** (không phải Chromium đầy đủ).

| | |
|---|---|
| Tải về | **94,5 MB**, **~8 s** |
| Trên đĩa | **196 MB** |
| Warm `ensure` | **1,08 s**, `Source: cache` |
| Cache ở đâu | **`$HOME/.cache/hyperframes/chrome/…`** |

Ba hệ quả:

1. **Bundle là lựa chọn tồi.** +196 MB vào một artifact đang ~300 MB, cho một thành phần tải hết 8 giây. → **OQ-3: tải ở lần chạy đầu**, xác nhận.
2. **Cache theo `$HOME`, không phải app-data.** R8.2 yêu cầu smoke chạy với `HOME` sạch ⇒ **mỗi lần chạy tải lại**. Đây chính là quả bom R8.8 nói tới, giờ có đường dẫn cụ thể để cache: `$HOME/.cache/hyperframes` và `HF_HOME`.
3. **Trên máy có Chrome hệ thống, `browser path` trả `/Applications/Google Chrome.app`** — tức máy phát triển **che mất** vấn đề. Đúng loại "PASS giả" mà §6 cảnh báo. Chỉ khi cache có sẵn nó mới trả headless shell đã tải.

**Không có đường override nguồn tải.** Thử `PUPPETEER_DOWNLOAD_BASE_URL` và `CHROME_DOWNLOAD_BASE_URL`: cả hai **bị lờ**, vẫn tải từ nguồn gốc. Nghĩa là (a) cài đặt air-gapped không làm được qua đường này, (b) OQ-3 mang một phụ thuộc cứng vào việc với tới server của Google. Đường thoát nếu cần air-gap: layout cache là tất định (`chrome-headless-shell/mac_arm-<ver>/chrome-headless-shell-mac-arm64/`), nên VidCom **tự seed cache** từ archive của mình được.

Chế độ hỏng khi thật sự mất mạng **chưa kiểm** — không có cách chặn mạng đáng tin trên máy này, và hai biến môi trường trên không dùng được để giả lập.

---

### S6 — boot khi chưa có workspace (OQ-10)

Bản 3 gọi đây là "thay đổi lifecycle" và tính nó vào R1 13→21 SP. Hai sự thật trong code làm nó rẻ hơn nhiều:

- [`createServerApp`](../../packages/server/src/app.ts) nhận **mọi** route group dựa vào foundation là **optional** (`if (deps.projectReads)`, `if (deps.jobs)`…); chỉ `createAuthRoutes` là vô điều kiện.
- `nonces` và `sessions` được dựng **trước** foundation ở `next-host.ts` và không phụ thuộc workspace.

Chạy với `createServerApp` thật, một biến `currentApp` đổi được, listener đọc biến đó mỗi request:

| | Phase 1 (chưa có workspace) | Phase 2 (sau khi thay app) |
|---|---|---|
| `/api/v1/jobs/job-1` không session | 401 `auth_required` | 401 `auth_required` |
| `/api/v1/jobs/job-1` **có session** | **404 `not_found`** — route chưa tồn tại | **200** + body của job |
| Cổng | 53100 | 53100, **listener chưa từng đóng** |

Session cấp ở phase 1 **dùng được nguyên vẹn** ở phase 2.

Toàn bộ cơ chế là: **một biến đổi được + gọi `createServerApp` lần thứ hai**. `createServerApp` chỉ đăng ký route, không I/O.

→ **OQ-10: listener mở trước, foundation dựng sau** — xác nhận, và **rẻ**. Phần đắt của R1 không nằm ở đây mà ở `startVidcomFoundation` (vẫn nướng `workspaceRoot` vào `createInfrastructure`) — nhưng đó là việc R1.12 cần dù có OQ-10 hay không, nên **làm một lần dùng cho cả hai**.

*Lưu ý phạm vi*: spike dùng `JobStorePort` stub. Nó chứng minh **cơ chế hai pha**, không chứng minh dựng foundation thật lúc runtime là rẻ.

---

### S7 — transport của bridge (OQ-2)

**A. Nguy cơ chiếm port là thật.** Dựng daemon ở port động, ghi endpoint record, đóng daemon, cho một tiến trình lạ bind đúng port đó:

```
endpointRecord            { port: 53305, workspace: "/Users/me/workspace-X" }
strangerTookSamePort      true
naiveBridgeSees           { who: "some-other-app" }
naiveBridgeWouldSendMutation   CÓ — gửi vào tiến trình lạ
handshakeBridgeRefuses    true
```

R2.13 không phải hardening. Không có handshake thì bridge gửi mutation của workspace vào một app lạ, và `hostCheck` (khoá theo `127.0.0.1:<port>`) **không** phát hiện được.

**B. Unix socket chạy được với cùng Hono app.** `serve({ path })` của `@hono/node-server` bị lờ (không tạo socket file), nhưng đường đúng thì chạy:

```js
http.createServer(getRequestListener(app.fetch)).listen(socketPath)
```

```
listens         true
mode            755 mặc định → chmod 600 OK
GET /api/mcp/ping   200  {"ok":true,"transport":"unix"}
```

Tức "socket cần code mới cho hai họ OS" thu lại còn **~5 dòng trên POSIX**, dùng lại nguyên Hono app. Windows named pipe dùng cùng API `listen(path)` nhưng **chưa kiểm** trên máy này.

→ **OQ-2**: cả hai đường đều dùng được. Socket **xoá hẳn** lớp rủi ro (A) vì không còn port để chiếm; loopback HTTP **giảm nhẹ** nó bằng R2.13. Xem quyết định ở Goals §7.

---

## Vòng 3 — S8: `worker_threads` trong SEA (kiểm khi review Design)

Design §5.2 cho `FilesystemBrowserService` chạy file operation trong một **bounded worker** để thoả R1.14 (giới hạn entry) và R1.15 (timeout UNC/network drive). Đó đúng là cơ chế đã làm esbuild **treo vĩnh viễn** ở S1b — API sync của esbuild khởi động worker bằng `__filename`, mà trong SEA `__filename` không phải file thật, nên `Atomics.wait` chờ mãi.

Câu hỏi: Design né bằng "eval bundle" — né như thế có đủ không?

| Kiểm | Kết quả |
|---|---|
| `new Worker(code, { eval: true })` rồi `readdirSync` qua `postMessage` | **OK** |
| `worker.terminate()` giữa lúc worker đang `while(true){}` | **OK**, exit code 1 |
| `Atomics.store/notify` + `SharedArrayBuffer` giữa main và worker | **OK**, đọc lại đúng `42` |

**PASS cả ba.** Nên §5.2 khả thi — nhưng chỉ ở **dạng eval**. Điểm cần nói rõ trong Design: một implementer viết `new Worker(new URL("./browse-worker.js", import.meta.url))` — dạng thông thường nhất — sẽ đâm đúng cái bẫy đã hạ esbuild, và chế độ hỏng là **treo im lặng**, không phải lỗi. Ràng buộc này giờ là MUST NOT trong §5.2.

---

## Việc phải làm ở Goals trước khi mở Design

1. **P-C viết lại**: "artifact không cần Python **cài sẵn**" thay cho "không Python" — vì nó ship một Python (S3).
2. **OQ mới — ngân sách tải về.** ~300 MB artifact + 1,6 GB weights + Chromium. Cùng hạng OQ-3, chưa ai chốt.
3. **OQ mới — shim hay sidecar Node** cho S1a: 43 ms nhanh hơn và cây tiến trình sạch hơn, đổi lấy ~110 MB.
4. **R5 thêm**: binary native của esbuild vào archive; danh sách package Python được ship phải pin (prune 297 MB).
5. **R6 thêm**: `ESBUILD_BINARY_PATH` + `ESBUILD_WORKER_THREADS=0` ở mọi đường in-process, **và timeout** để hỏng thành lỗi chứ không thành treo.
6. **R4.5 chốt**: sentinel `__shell` + `trailingSlash: false` + map cả payload RSC; page dynamic tách server shell / client child; slug đọc từ `location` chứ không từ `params`.
7. **R6.8 siết**: kill cây process phải đi qua tầng shim, và MUST NOT nhận diện tiến trình con bằng `execPath`.
8. **R6.5 thêm**: đặt `HF_HUB_OFFLINE=1` khi cache đã có.
9. **Ngoài phạm vi giai đoạn này nhưng phải mở issue**: hai bug voice-id và `engineVersion` của sidecar VieNeu (§S3).
