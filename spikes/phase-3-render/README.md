# Giai đoạn 3 — Spike render (gate OQ-4)

Ngày chạy: **2026-08-04**. Checkout `0009a95` trên **Windows 11 Pro 10.0.26200, x64**.

Gate này thuộc pha **Goals** của [spec-project-delivery-loop](../../llm-documents/specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-detailed-goal.md) §7.1 — chạy để trả lời một câu duy nhất: *`hyperframes render` có chạy được dưới runtime của repo này không, và R6 có khả thi như đã viết không.* Đây **không** phải chấp thuận Goals, cũng không phải chuyển sang Design.

## Môi trường

| Thành phần | Version | Nguồn |
|---|---|---|
| Node.js | **v26.5.0** (win32 x64) | máy dev, lượt spike đầu |
| Node.js CI ghim | **v24.9.0** | [`.github/workflows/ci.yml:52`](../../.github/workflows/ci.yml#L52); ZIP portable, SHA-256 `6873514c3e6a012917cc6f95ce48a6289253370d025f1b69db290d70feebfa6e` khớp `SHASUMS256.txt` chính thức |
| Bun | 1.3.14 | máy dev |
| HyperFrames CLI | **0.7.86** (0.7.90 available) | `node_modules/hyperframes` |
| Chrome | `chrome-headless-shell` **win64-152.0.7928.2** | `~/.cache/hyperframes/chrome/` — hyperframes tự quản |
| FFmpeg | **6.1.1-essentials** (gyan.dev build) | npm `ffmpeg-static@5.3.0`, portable trong scratchpad |
| FFprobe | **4.0.2** | npm `ffprobe-static` |
| CPU / RAM / Disk | Intel Ultra 5 125H, 18 cores / 47.5 GB / 335.9 GB free | `hyperframes doctor` |

**Máy chưa từng có FFmpeg/FFprobe.** Chúng được cài **portable vào scratchpad** và đưa vào `PATH` cho từng lệnh — không cài gì vào máy, không sửa `package.json` của repo.

## Kết luận gate — ba câu, không gộp thành một con số

- **Feasibility: PASS có điều kiện.** Đường render chạy được đầu-cuối. Không tiêu chí nào buộc viết lại R6.
- **Artifact safety: PASS. Cleanup gap đã hiểu và có AC.** HyperFrames thô vẫn leak; VidCom có thể giam orphan vào root có marker theo job.
- **Runtime: PASS trên Node 26.5.0 và 24.9.0.** Node 24 đã chạy đủ tiêu chí 1–5.

**MUST NOT ghi kết quả này thành "6/6 PASS."** Hai trong sáu tiêu chí không pass sạch, và gộp chúng vào một con số là xoá đúng phần thông tin spike sinh ra.

| # | Tiêu chí | Kết quả |
|---|---|---|
| 1 | Render composition 3–5 giây | **PASS** |
| 2 | Render composition **có narration** | **PASS** |
| 3 | `ffprobe` xác nhận width/height/fps/duration **và audio stream** | **PASS** |
| 4 | Huỷ giữa chừng → Chromium **và** FFmpeg bị kill | **PASS** (2/2 lần) — nhưng **nhờ cơ chế không phải bảo đảm**, xem bên dưới |
| 5 | Crash → output dở **không** được coi là hợp lệ | **PASS** phần artifact safety · **FAIL** phần dọn rác |
| 6 | Chạy dưới đúng Node/runtime app dùng | **PASS** — 26.5.0 và 24.9.0 đều xanh; Node 24 phủ render, narration, ffprobe, cancel và crash |

Bốn AC đã được viết vào R6 để xử lý phần fail: **R6.6b** (kill cây process + verify + `cleanupPending`), **R6.7b** (thu hồi workdir mồ côi theo 4 điều kiện), **R6.14** (`bestEffort`), **R6.15** (remote media asset).

### Kiểm lại trên Node 24.9.0 — 2026-08-04

| Kiểm | Kết quả |
|---|---|
| Render 3 giây | H.264 1920×1080, 30 fps, 90 frame, 242,358 byte |
| Narration 14 giây | H.264 + AAC, 420 frame; cửa sổ 10–12.5 s **−11.9 dB**, nền 0–5 s **−91.0 dB** |
| Cancel | 6 descendant (1 FFmpeg + 5 Chrome), kill PID cha → 0 sống, không artifact; pipeline log ghi `nodeVersion:"v24.9.0"` |
| Crash thô | 0 process sống, không artifact, leak mới 1.04 MB dưới `%TEMP%` |
| Crash trong root sở hữu | đặt `TEMP`/`TMP` vào root có marker theo job → orphan duy nhất ở `<owned-root>/hf-render-I8okOf`; đủ cơ sở cho containment + ownership + `jobId` của R6.7b |

HyperFrames 0.7.86 xác nhận thêm giới hạn API: trên Windows nó tự `mkdtemp(<os.tmpdir()>/hf-render-)` và không expose workdir. Vì vậy marker phải nằm ở **render root theo job do VidCom tạo**, không phải giả định VidCom có thể chèn marker vào thư mục ngẫu nhiên bên trong sau khi crash.

---

## Tiêu chí 1 — render được

```bash
export PATH="<scratchpad>/bin:$PATH"
node node_modules/hyperframes/bin/hyperframes.mjs render projects/warm-grain \
  -c compositions/intro.html -o <scratchpad>/c1.mp4 --quality draft --workers 1
```

```
◇  c1.mp4
   236.7 KB · 3.0s video · rendered in 54.3s
```

- 90 frame, 1 worker, `captureMode: drawelement`, `static-dedup` reused 38/128 frame (30%).
- Root composition đầy đủ (14 s, 420 frame, 2 worker): **3.5 MB, 73.3 s**.
- Pipeline có checkpoint `"message":"artifact validated"` **trước khi** công bố file — đây là lý do tiêu chí 5 pass.

## Tiêu chí 2 — narration vào được bản render

`projects/warm-grain/narration/scene-1.json` là **mock** (`status:"mock"`, không có wav), và `index.html` gốc **không** có mount audio — mount là việc của `buildCompositionDocument()` phía VidCom. Nên spike **tự dựng đúng thứ VidCom sẽ sinh** trên một bản copy:

1. Sinh WAV thật bằng Node thuần ([`make-wav.mjs`](./make-wav.mjs)) — 440 Hz, 2.5 s, 44.1 kHz mono 16-bit. Không dùng ffmpeg để tránh phụ thuộc vòng.
2. Inject đúng shape của `buildNarrationHtml()` ([`inject-narration.mjs`](./inject-narration.mjs)):
   ```html
   <audio class="clip hf-narration" src="narration/scene-1.wav"
          data-start="10" data-duration="2.5" data-track-index="200"></audio>
   ```
   `data-start="10"` lấy từ `data-start` của `scene-1-layer` trong document, **không** lấy từ sidecar — đúng luật P1.

Render log: `"phase":"encode" … "hasAudio":true`. Runtime nhận đúng clip.

## Tiêu chí 3 — ffprobe xác nhận

```
index=0  codec_name=h264  width=1920  height=1080  r_frame_rate=30/1  duration=14.000000  nb_frames=420
index=1  codec_name=aac   sample_rate=48000  channels=2             duration=14.000000  nb_frames=658
nb_streams=2  format_name=mov,mp4,m4a,3gp,3g2,mj2  size=3619611
```

Và **audio nằm đúng chỗ**, không phải một track im lặng cho có:

| Cửa sổ | mean_volume | Nghĩa |
|---|---|---|
| 10.0 – 12.5 s (đúng `data-start=10`) | **−11.9 dB** | có tiếng thật |
| 0 – 5 s (không mount narration) | **−91.0 dB** | im lặng |

Đây là bằng chứng cho tiền đề của **R6.9**: narration mount qua `<audio class="clip">` với `data-start` lấy từ document thì tới được bản render, đúng vị trí.

## Tiêu chí 4 — huỷ giữa chừng

[`cancel-test.ps1`](./cancel-test.ps1). Chiến lược: kill **chỉ PID cha** (cách naive mà một implementation cẩu thả sẽ làm), rồi đếm descendant còn sống sau 6 s.

Cây process tại thời điểm huỷ — **cả hai lần**:

```
node (parent)
├── ffmpeg.exe                       ← con trực tiếp
└── chrome-headless-shell.exe        ← con trực tiếp
    ├── chrome-headless-shell.exe    ← 4 cháu (renderer/gpu/utility)
    ├── chrome-headless-shell.exe
    ├── chrome-headless-shell.exe
    └── chrome-headless-shell.exe
```

| Lần | Huỷ ở | Descendant lúc huỷ | Còn sống sau 6 s | Artifact |
|---|---|---|---|---|
| 1 | ~4 s (đang capture) | 6 | **0** | không công bố |
| 2 | ~57 s (sát pha encode) | 6 | **0** | không công bố |

**PASS, nhưng đọc kỹ cơ chế.** Windows **không** kill process con khi cha chết — nên việc cả 6 descendant chết theo gần như chắc chắn là **hệ quả của đóng pipe**: Chrome thoát khi CDP connection đứt, FFmpeg thoát khi stdin đóng. Đó là một hành vi *thuận tiện*, không phải một *bảo đảm*.

> **Hệ quả cho R6.6:** vẫn phải kill cả cây process tường minh (job object trên Windows, process group trên POSIX). MUST NOT dựa vào cascade đóng pipe — một FFmpeg đang buffer nhiều, hoặc một Chrome bị detach, không có gì bảo đảm sẽ thoát. Spike này chứng minh đường thuận tiện *hoạt động ở đây*, không chứng minh nó *đủ*.

## Tiêu chí 5 — crash giữa lúc render

[`crash-test.ps1`](./crash-test.ps1). `taskkill /PID <node> /T /F` ở giây ~23 — không cho cleanup handler nào chạy.

**Phần quyết định: PASS.**

```
=== ARTIFACT CÓ BỊ CÔNG BỐ NHẦM KHÔNG ===
  output KHÔNG tồn tại — crash không công bố artifact
```

Không có MP4 nào ở đường dẫn output, và **không có `.mp4` nào trong work directory** — tức không tồn tại file nào có thể bị nhầm là bản render hoàn chỉnh. `hyperframes` chỉ move file vào đích sau checkpoint `artifact validated`.

**Phần dọn rác: FAIL.** Crash để lại nguyên work directory:

```
C:\Users\<user>\AppData\Local\Temp\hf-render-ODBdfO   ~1.04 MB, 9 files
├── audio.aac                    68 511 B   ← audio đã extract
├── compiled/
│   ├── index.html              797 043 B   ← document đã compile
│   └── compositions/*.html      (5 file)
├── downloads/_remote_media/
│   └── download_8351f9e24884.png  101 491 B
└── captured-frames/             (rỗng — frame đã stream đi)
```

Ba phát hiện phụ, và cái thứ ba là cái đáng lo:

1. **Huỷ (tiêu chí 4) cũng leak** một work dir cùng cỡ. Không chỉ crash.
2. Render **thành công** thì tự dọn work dir của chính nó.
3. Một render thành công **KHÔNG** dọn orphan của lần crash trước — đo trực tiếp: 3 orphan trước khi chạy, **3 orphan sau khi chạy xong**. Tức leak **không bị chặn**: mỗi lần huỷ và mỗi lần crash để lại ~1 MB trong `TEMP` vĩnh viễn.

> **Hệ quả cho R6.6 / R6.7:** R6.6 hiện chỉ nói "dọn output dở" — không nói gì về work directory. R6.7 nói recovery phải đưa job về trạng thái xác định — cũng không nói gì về thu hồi work dir mồ côi. Cần bổ sung, và đã có **tiền lệ đúng hình dạng** trong Core: `BackupPort.cleanupOrphanPayloads(olderThan)` dọn payload mồ côi theo cutoff grace. Việc này là *thêm một AC*, không phải viết lại R6.

## Tiêu chí 6 — runtime

| | Version |
|---|---|
| Máy chạy spike | Node **v26.5.0** và portable **v24.9.0** |
| CI ghim | Node **24.9.0** |
| `hyperframes` yêu cầu | `>=22` |

Cả hai đều thoả yêu cầu của hyperframes và đều đã chạy pipeline thật. Node 24.9.0 phủ đủ tiêu chí 1–5 như bảng ở đầu tài liệu. Không có `.nvmrc`; `package.json` gốc và `packages/cli` đều không khai `engines`, nên CI pin vẫn là runtime chuẩn của gate này.

Đây là khoảng cách phải nói ra chứ không lấp: một render pipeline đi qua native addon (`sharp`, `onnxruntime-node`) và Chromium là đúng loại thứ có thể khác nhau giữa hai major Node.

---

## Phát hiện phụ — dùng cho Design

| # | Phát hiện | Ảnh hưởng |
|---|---|---|
| A | Thiếu binary → lỗi **nêu tên từng binary** (`FFmpeg not found`, `FFprobe not found`), fail **trước khi** launch Chrome, exit 1 | **R6.12 đã khả thi sẵn** — chỉ cần đừng bọc lại thành "render failed" |
| B | `hyperframes` resolve ffmpeg qua `HYPERFRAMES_FFMPEG_PATH`, không bundle binary | Đường cho **PK-7** (giải nén sidecar runtime vào app-data) đã có; VidCom set env var là đủ |
| C | Pipeline có checkpoint `artifact validated` trước khi công bố | Nền cho **R6.7**; VidCom nên giữ đúng thứ tự này chứ không tự dựng lại |
| D | Render tải **media asset** remote vào `workdir/_remote_media/`. `warm-grain` PNG nằm trong CSS `background: url(...)`, không phải element media. Cả ba project còn nạp GSAP CDN; `kinetic-type` thêm Google Fonts + MP4 S3 | R6.15 phải phủ element **và CSS/request runtime**, migrate media vào `assets/**`. Script/font được phép ở Phase 3 nhưng bắt buộc warning, URL và `reproducible:false`; chỉ artifact `reproducible:true` mới nhận guarantee cùng local revision → cùng output |
| E | `hyperframes validate` **deprecated** → dùng `hyperframes check` | Khớp đúng tên lệnh **R9.3** đã viết |
| F | Mọi lần render `warm-grain` đều cảnh báo `sub_timeline_readiness_timeout` (budget 45 s) nhưng `--best-effort` (default) vẫn ra output | Đã chốt R6.14: mặc định `bestEffort:true`, warning phải vào metadata/client; strict làm job fail bằng mã ổn định |
| G | 420 frame / 2 worker = 73 s; 90 frame / 1 worker = 54 s | Render là job phút-cấp đúng như R6 giả định. `--workers` scale thật |

## Tái lập

```bash
# 1. ffmpeg + ffprobe portable (KHÔNG cài vào máy)
mkdir spike && cd spike && echo '{"private":true}' > package.json
npm install ffmpeg-static ffprobe-static
mkdir bin
cp node_modules/ffmpeg-static/ffmpeg.exe bin/
cp node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe bin/
export PATH="$PWD/bin:$PATH"

# 2. Tiêu chí 1 + 3
node node_modules/hyperframes/bin/hyperframes.mjs render projects/warm-grain \
  -c compositions/intro.html -o c1.mp4 --quality draft --workers 1
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,duration,nb_frames \
  -show_entries format=nb_streams,duration,size -of default=nw=1 c1.mp4

# 3. Tiêu chí 2 — dựng narration như VidCom sẽ dựng
cp -r projects/warm-grain wg
node make-wav.mjs wg/narration/scene-1.wav 2.5
node inject-narration.mjs wg/index.html
node node_modules/hyperframes/bin/hyperframes.mjs render wg -o c2.mp4 --quality draft --workers 2
ffmpeg -hide_banner -ss 10 -t 2.5 -i c2.mp4 -af volumedetect -f null NUL   # mong đợi ~-11.9 dB
ffmpeg -hide_banner -ss 0  -t 5   -i c2.mp4 -af volumedetect -f null NUL   # mong đợi ~-91 dB

# 4. Tiêu chí 4 và 5
pwsh -File cancel-test.ps1 -Project wg -Out c4.mp4 -FfmpegDir bin -KillAfterSec 55
pwsh -File crash-test.ps1  -Project wg -Out c5.mp4 -FfmpegDir bin -KillAfterSec 20
```

## Dọn dẹp sau spike

Spike tự gây ra 3 orphan work dir (2 từ hai lần cancel, 1 từ lần crash) và **đã dọn tay** sau khi ghi bằng chứng:

```
trước dọn: hf-render-LZL5dt  hf-render-ODBdfO  hf-render-hqU2Ja
sau dọn:   0 orphan
```

FFmpeg/FFprobe nằm portable trong scratchpad — **không cài vào máy**, không sửa `package.json` của repo, không có `.mp4` nào lọt vào repo (`git status` sạch ngoài hai file spec + thư mục spike này).

Việc phải dọn tay chính là bằng chứng cho tiêu chí 5: nếu R6.7b đã tồn tại thì recovery sẽ làm việc này.

## Việc còn lại trước khi xác nhận Goals

**Bốn AC đã viết vào R6** — R6.6b, R6.7b, R6.14, R6.15/15b (xem [§7.1b của Detailed Goals](../../llm-documents/specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-detailed-goal.md)).

Còn lại:

1. **Spike ma trận host** (§7.2 của Detailed Goals) — gate còn lại của OQ-6.
2. **Xác nhận Goals tường minh**, sau ma trận host.
