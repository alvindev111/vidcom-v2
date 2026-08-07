# S9 — vòng Windows: đóng W-1, W-2, W-3 và blocker B1

> Chạy ngày **2026-08-07** trên `win32 x64` (Windows 11 Pro 26200, 18 core, NVMe KIOXIA), Node `v26.5.0`, commit `82d99bb`.
> Mục đích: ba món nợ kiểm chứng mà [spec pending §During Spec](../../../llm-documents/specs-and-process/specs/spec-packaging-and-distribution/spec-packaging-and-distribution-pending.md) ghi là "chờ máy Windows", cộng blocker B1 phát hiện lúc review Design (danh sách package Python chỉ đo trên darwin).

| Câu hỏi | Kết quả |
|---|---|
| **B1** — danh sách package Python có giống nhau trên Windows? | **KHÁC** — thừa đúng 2 package. Luật build hiện tại sẽ fail. |
| **W-1** — cookie session cross-origin ở chế độ dev | **ĐÓNG** — luật "hai đầu cùng hostname" đúng, và sai hostname thì **hỏng im lặng** |
| **W-2** — named pipe trên Windows | **ĐÓNG một nửa** — transport PASS; **không có API nào đặt được ACL** |
| **W-3** — chế độ hỏng khi tải Chromium/weights | **ĐÓNG một nửa** + **hai chế độ hỏng im lặng mới** |
| **N-1** (mới) — TLS inspection của mạng doanh nghiệp | Chặn hẳn weights TTS; không phải offline, không phải online |
| **N-2** (mới) — encoding của interpreter đóng băng | `cp932` mặc định ⇒ **in tiếng Việt là crash**. Phase 3 đã chống, Giai đoạn 4 dễ làm rơi |

---

## B1 — stack Python trên Windows lệch đúng 2 package

**Cách làm**: `python-build-standalone` CPython `3.12.13+20260805` (`x86_64-pc-windows-msvc`, `install_only_stripped`) → `pip install vieneu==3.2.4 huggingface-hub>=0.24` → so tập package với [Detailed Design §5.13](../../../llm-documents/specs-and-process/specs/spec-packaging-and-distribution/spec-packaging-and-distribution-detailed-design.md).

```
darwin arm64 : 77 package (56 giữ + 21 gỡ)
win32 x64    : 79 package
chênh lệch   : +colorama  +tzdata     (không thiếu package nào)
```

Cả hai đều là hệ quả tất yếu, không phải nhiễu:

- **`colorama`** — `click==8.4.2` và `tqdm==4.70.0` đều khai `colorama; platform_system == "Windows"`. Cả hai đều nằm trong tập **giữ**, nên `colorama` cũng phải giữ.
- **`tzdata`** — `pandas==3.0.5` cần database timezone; POSIX lấy từ hệ điều hành, Windows không có nên pip kéo `tzdata` về.

**Version của cả 56 package giữ lại khớp tuyệt đối với danh sách đã pin trên darwin** — không có một dòng lệch. Nghĩa là danh sách không cần viết lại, chỉ cần một phần phụ theo nền tảng.

**Hệ quả cho Design**: luật "build SHALL fail nếu tập package thực tế lệch khỏi danh sách" đúng về tinh thần nhưng sai về hình dạng — nó cần **một core dùng chung + phần phụ theo `<os>-<arch>`**, nếu không build Windows fail ngay ngày đầu. Chi tiết ở §5.13 của Design (đã sửa).

### Linux đo bổ sung — container `linux/amd64` thật

Chạy trong `ubuntu:24.04` (đúng thứ `ubuntu-latest` phân giải ra, khớp [`docker/ci/Dockerfile`](../../../docker/ci/Dockerfile)) qua Rancher Desktop, cùng CPython `3.12.13+20260805` bản `x86_64-unknown-linux-gnu`:

```
77 package  — trùng khít darwin, không thừa không thiếu
prune 21    → 55 package, đúng bằng core; imports OK; pip đã gỡ
```

**Nên "phần phụ theo platform" chỉ tồn tại ở Windows.** Luật *core + phần phụ* vẫn đúng và vẫn cần — nó mô tả cơ chế, và cơ chế đó chứng minh là cần ở một trong ba nền tảng.

### Kích thước — ba nền tảng, mỗi cột đo trên chính nó

| | darwin arm64 | win32 x64 | linux x64 |
|---|---:|---:|---:|
| CPython trần | 66 MB | 68 MB | **104 MB** |
| Stack đầy đủ | 806 MB | 815 MB | **980 MB** |
| **Sau prune, không `pip`** | **481 MB** | **499 MB** | **595 MB** |
| **tar.gz tương ứng** | **145 MB** | **152 MB** | **179 MB** |
| Package sau prune | 55 | 57 | 55 |

Prune gỡ đủ 21 package trên cả ba (không package nào vắng mặt). Cột darwin đo trên runner `macos-latest` của GitHub qua [`phase4-python-stack.yml`](../../../.github/workflows/phase4-python-stack.yml) — không dựng lại được ở máy Windows vì wheel là của macOS arm64. **Tập package của darwin trùng khít Linux**, `diff` rỗng.

> Ước lượng trước đó (~480 MB / ~143 MB, suy từ việc gỡ `pip` tốn 12 MB trên Windows) hoá ra lệch 1–2 MB. Nó đúng — nhưng nó đúng một cách may mắn, và luật "MUST NOT suy số của nền tảng này từ nền tảng khác" vẫn giữ nguyên: điều đáng tin là phép đo, không phải phép suy.

**Linux là nền tảng nặng nhất, hơn darwin ~24 % sau prune.** Interpreter Linux một mình đã lớn hơn 58 %. Điều đó đụng thẳng vào §9.1 của Design, nơi Linux và macOS đang dùng **chung** trần cold 120 s — trần Linux vì vậy là tạm, chờ lần smoke đầu tiên.

### Thời gian giải nén — cận dưới cho trần §9.1

```
tar xzf python-pruned.tar.gz  (155 MB nén → 510 MB, 18 core, NVMe)
real 26,9 s     user 5,0 s     sys 16,9 s
```

> **Đính chính (cùng ngày, sau khi soi kỹ hơn).** Vòng đầu tôi đọc `Get-MpComputerStatus → RealTimeProtectionEnabled = False` rồi kết luận "máy này không có AV quét, nên 26,9 s là sàn". **Sai.** Defender tắt vì **Sophos Intercept X** đang sở hữu real-time protection, chứ không phải vì máy không có AV:
>
> ```
> AV: Sophos Intercept X    productState=0x41000  → rtStatus=0x10  REAL-TIME ON
> AV: Windows Defender      productState=0x60100  → rtStatus=0x01  off
> Sophos File Scanner Service   Running
> ```
>
> Nên **26,9 s đã bao gồm quét on-access** của một AV doanh nghiệp — thường nặng hơn Defender. Điều con số này *không* đại diện là **phần cứng của runner CI**: 18 core + NVMe ở đây so với 2–4 core của hosted runner. Đó mới là lý do nó chưa chốt được trần, và lý do đó yếu hơn lý do tôi viết lần đầu.

---

## W-1 — cookie session cross-origin ở chế độ dev

**Cách làm**: [`cookie-probe.mjs`](cookie-probe.mjs) dựng một daemon Hono (`@hono/node-server`) trên `127.0.0.1:<động>` và một "next dev" giả trên `localhost:3000`, rồi lái Chrome thật (chrome-headless-shell 152, qua `puppeteer-core`) chạy đúng chuỗi của R4.10: `POST /auth/exchange` → `GET /system/workspace` → đọc SSE, tất cả với `credentials: "include"`.

| daemon | thuộc tính cookie | exchange | cookie quay lại | SSE có cookie |
|---|---|:--:|:--:|:--:|
| `127.0.0.1:<port>` | `SameSite=Strict` | 200 | **❌** | **❌** |
| `127.0.0.1:<port>` | `SameSite=Lax` | 200 | **❌** | **❌** |
| `127.0.0.1:<port>` | `SameSite=None; Secure` | 200 | ✅ | ✅ |
| `localhost:<port>` | `SameSite=Strict` | 200 | ✅ | ✅ |
| `localhost:<port>` | `SameSite=Lax` | 200 | ✅ | ✅ |
| `localhost:<port>` | `SameSite=None; Secure` | 200 | ✅ | ✅ |

Ba kết luận, cả ba đều đi thẳng vào Design:

1. **Luật "hai đầu cùng hostname" là đủ và đúng.** `localhost:3000` → `localhost:<port>` giữ được `SameSite=Strict` qua **port khác nhau** — port không thuộc định nghĩa "site", đúng như §1.6 của Goals nói. Không phải nới cookie xuống `Lax` hay `None` để dev chạy được.
2. **Sai hostname thì hỏng im lặng.** `exchange` trả **200**, `Set-Cookie` trông như đã thành công, nhưng cookie **không bao giờ được gửi lại** — cả fetch lẫn SSE. Không có lỗi, không có cảnh báo. Đây chính xác là lý do R4.12 đòi hệ thống **fail tường minh** khi cấu hình dev trỏ hai hostname khác nhau: browser sẽ không nói cho người phát triển biết.
3. **SSE fetch-based mang cookie y hệt đường fetch thường.** Lời hứa của Design §5.11 đứng vững — nhưng nó đứng vững vì `credentials: "include"`, nên câu SHALL đó phải giữ nguyên, không phải ghi chú.

Phụ: `SameSite=None; Secure` **chạy được trên `http://` loopback** (Chrome coi 127.0.0.1/localhost là origin đáng tin). Đó là lối thoát nếu bao giờ không pin được hostname — ghi lại để khỏi phải đo lại, **không** phải khuyến nghị: artifact chạy same-origin nên không cần, và `None` nới rộng hơn mức cần.

---

## W-2 — named pipe trên Windows

**Cách làm**: [`pipe-probe.mjs`](pipe-probe.mjs) — đúng cấu trúc S7 đã kiểm trên POSIX: `http.createServer(getRequestListener(app.fetch)).listen("\\\\.\\pipe\\…")`, cùng một Hono app có route `bridge/v1/ready` và `bridge/v1/tools/:name`.

```
listen        ok
GET  ready    200  {"instanceId":"daemon_spike","workspaceRoot":"C:\\tmp\\ws","leaseHeld":true}
POST tools    200  {"tool":"list_projects","echo":{"input":{"limit":1}}}
listen lần 2  EADDRINUSE
```

- **Transport PASS** — cùng Hono app, cùng `getRequestListener`, không phải sửa gì.
- **`EADDRINUSE` ở lần listen thứ hai** là tin tốt ngoài dự tính: tên pipe cho luôn tính loại trừ, tức nó tự làm được single-instance mà loopback port không làm được.
- **Nhưng phần bảo mật thì không đóng được.** `Get-Acl` trên pipe fail `ERROR_PIPE_BUSY (231)`; `GetNamedSecurityInfo` với `SE_FILE_OBJECT` fail `ERROR_INVALID_PARAMETER (87)`; `PipesAclExtensions` không có trong PS 5.1. Quan trọng hơn mọi cách đọc: **Node không có tham số nào để *đặt* security descriptor cho pipe** — `net.Server.listen` chỉ nhận đường dẫn. Nên "tương đương `0600`" trên named pipe **không đạt được bằng Node thuần**; nó cần một tầng native.

**Hệ quả**: D3 (named pipe làm mặc định) giữ nguyên trạng thái deferred, nhưng **giá của nó giờ đã biết**: không phải "chưa kiểm", mà là "cần native code để đặt ACL". Đường mặc định loopback HTTP + bearer + handshake không bị ảnh hưởng.

---

## W-3 — chế độ hỏng khi tải Chromium / weights

Ba phép đo, **hai chế độ hỏng im lặng mới**.

### A) `HTTPS_PROXY` bị lờ hoàn toàn

Đặt `HTTPS_PROXY=http://127.0.0.1:9` và `HTTP_PROXY` như nhau rồi chạy `hyperframes browser path` với `HOME` rỗng: nó **tải thật 202 MB trong 15 giây**. Cùng họ với phát hiện của S5 (`PUPPETEER_DOWNLOAD_BASE_URL` bị lờ) — **không có đường env nào chặn hay lái được download**.

> Hệ quả cho R8.8: bước "chạy offline" của job smoke **MUST chặn ở tầng mạng của runner** (firewall/network namespace), MUST NOT giả vờ bằng biến môi trường. Viết bằng env thì bước đó sẽ xanh vì lý do sai.

### B) Cache "tải dở" được báo là **ok** — hỏng im lặng

Cắt binary Chrome còn 1 MB rồi hỏi lại đường dẫn:

```
$ hyperframes browser path
C:\…\chrome-headless-shell.exe        ← trả đường dẫn
exit=0                                 ← exit 0
$ ls -la …\chrome-headless-shell.exe
1.048.576 bytes                        ← vẫn 1 MB, không tải lại
```

`hyperframes browser path` **chỉ kiểm file có tồn tại**, không kiểm toàn vẹn, không kiểm chạy được. Một cache tải dở đi qua nó như một cache tốt, và job render sẽ chết sau đó bằng một lỗi không liên quan.

> Hệ quả cho §5.9: check `chrome.cache` **MUST thực sự chạy binary** (`--version` có timeout), MUST NOT hỏi CLI lấy đường dẫn rồi coi đó là bằng chứng. Đây là cùng một luật R6.11 đã áp cho compiler, áp sang Chromium.

### C) `HF_HUB_OFFLINE=1` với cache rỗng — chế độ hỏng **tốt**

```
elapsed = 1 s
vieneu sidecar is not ready: An error happened while trying to locate the file
on the Hub and we cannot find the requested files in the local cache…
{"schemaVersion": 1, "ready": false, "gpu": false, "voices": [], "engineVersion": "3.2.4"}
```

Nhanh, có thông điệp, **không treo** — đúng thứ R6.5 cần. Hai lưu ý: thông điệp là văn xuôi chứ không có mã, nên adapter phải ánh xạ nó sang `download_unavailable`; và `ready:false` **không phân biệt** "thiếu weights" với "interpreter hỏng", trong khi §5.9 cần phân biệt `missing`/`partial`/`broken`.

Phụ: `engineVersion` giờ trả `"3.2.4"` — bug #2 của S3 đã được sửa, xác nhận trên Windows.

### Còn treo

Chế độ hỏng khi **thật sự mất mạng** lúc tải Chromium vẫn chưa đo được: `HTTPS_PROXY` bị lờ (A), và chặn ở tầng mạng cần quyền admin trên máy này. Bước offline của R8.8 vẫn là chỗ duy nhất bắt được nó.

---

## N-1 (mới) — TLS inspection của mạng doanh nghiệp chặn hẳn weights TTS

Không nằm trong ba món nợ, nhưng lộ ra ngay khi chạy TTS thật và đủ nghiêm trọng để ghi.

Chạy `worker.py --probe` bằng interpreter đóng băng:

```
[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local
issuer certificate (_ssl.c:1010) thrown while requesting HEAD
https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo/resolve/main/onnx_int8/vieneu_prefill.onnx
```

Soi chuỗi chứng chỉ thì rõ nguyên nhân, và nó **có chọn lọc**:

| host | chứng chỉ |
|---|---|
| `pypi.org` | sạch — GlobalSign |
| `github.com` | sạch — Sectigo |
| `storage.googleapis.com` | sạch — Google Trust Services |
| **`huggingface.co`** | **`CN=FG100FTK19017630, O=Fortinet`** — firewall đứng giữa |

Firewall FortiGate chỉ chặn-và-giải-mã `huggingface.co` (đúng kiểu phân loại theo category "AI/ML"), và **CA của nó không có trong trust store của Windows** (`Cert:\LocalMachine\Root` lẫn `CurrentUser\Root` đều không có).

Vì sao cái này quan trọng với sản phẩm:

- **CPython đóng băng không dùng trust store của Windows.** Nó dùng bundle `certifi` đi kèm. Máy nào có TLS inspection thì `pip`, browser, PowerShell vẫn chạy (chúng tin CA của firewall qua store hoặc bundle riêng) nhưng **sidecar TTS thì không**.
- **Chế độ hỏng là một loại thứ ba**: không phải offline (mạng vẫn thông), không phải online (tải không được). R6.5 chỉ viết cho "máy offline", `doctor` sẽ báo sai loại lỗi, và người dùng doanh nghiệp — tức người dùng chính của một tool local-first — sẽ thấy narration chết mà không hiểu vì sao.
- **Chưa có gì trong Design chạm tới nó**: không mã lỗi, không doctor check, không lối thoát cấu hình.

**Không tự ý bypass.** Cách chữa hiển nhiên là trỏ `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE` vào CA của công ty — nhưng CA đó không được provision vào máy này, nên tin nó là một quyết định bảo mật của người dùng/IT, không phải của spike. Vì vậy **TTS ra WAV trên Windows vẫn chưa chứng minh được**, và đó là món duy nhất của vòng này không đóng được.

---

## N-2 (mới) — interpreter đóng băng lấy encoding từ codepage ANSI, và tiếng Việt chết

Lộ ra khi in một chuỗi tiếng Việt qua interpreter đã ship:

```
$ ./python/python.exe -c "import sys,locale; print(sys.stdout.encoding, locale.getpreferredencoding())"
cp932 cp932                      ← codepage ANSI của máy, không phải UTF-8

$ ./python/python.exe -c "print('ấđọ')"
UnicodeEncodeError: 'cp932' codec can't encode character 'ấ' … illegal multibyte sequence

$ PYTHONUTF8=1 ./python/python.exe -c "print('ấđọ')"
ấđọ                              ← sửa được bằng một biến môi trường
```

`sys.getfilesystemencoding()` là `utf-8` nên **đường dẫn không sao**; thứ hỏng là `stdout`/`stderr` và `locale.getpreferredencoding()` — cái sau quyết định encoding của mọi `open()` không khai tường minh. Với một sản phẩm mà nội dung chính là tiếng Việt, đây là hỏng ở đường chính. Nó nổ trên **mọi** máy Windows có locale không UTF-8, không riêng CJK.

**Tin tốt: Phase 3 đã chống đúng chỗ.** [`process-environment.ts:19-20`](../../../packages/adapter/src/runtime/process-environment.ts#L19) đặt `PYTHONIOENCODING=utf-8` và `PYTHONUTF8=1` cho mọi child, còn `worker.py` khai `encoding="utf-8"` tường minh khi đọc/ghi file.

**Rủi ro là Giai đoạn 4 làm rơi nó.** Lệnh sidecar đổi từ `python3 worker.py` sang `<frozen>/python.exe worker.py` **và cùng lúc** phải thêm `HF_HOME`, `HF_HUB_OFFLINE`, `SSL_CERT_FILE` — tức là đúng lúc dễ tự dựng env mới thay vì đi qua helper. Thêm một điểm yếu nhỏ: hai biến đang đặt bằng `??=`, nên một `PYTHONIOENCODING` lạ thừa kế từ shell cha vẫn lọt. Design §4.6 giờ yêu cầu **ép** thay vì mặc định, và §11.3 có test cho nó.

---

## Phụ — ba quan sát nhỏ, ghi để khỏi đo lại

- **`pip` không cần ship.** Gỡ pip: 511 → **499 MB**, chuỗi import của sidecar vẫn chạy, và `importlib.metadata.distributions()` (thư viện chuẩn) vẫn liệt kê đủ 57 package — nên `doctor` vẫn xác minh được stack mà không cần trình cài package nằm trong artifact. → Design §5.13.
- **Chạy binary thì bắt được cache hỏng.** Chrome bị cắt còn 1 MB: `browser path` trả exit 0, nhưng thực thi nó trả thẳng `Exec format error`. Đó là lý do §5.9 đổi check sang `--version`.
- **Telemetry của HyperFrames hiện lời mời ở `HOME` sạch** ngay lần chạy đầu — xác nhận R9.7 cần tắt nó trong runtime đã giải nén, không phải giả định.

---

## Dựng lại

```bash
cd spikes/phase-4/s9-windows-runtime
curl -sSL -o cpython-win.tar.gz \
  "https://github.com/astral-sh/python-build-standalone/releases/download/20260805/cpython-3.12.13+20260805-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
tar xzf cpython-win.tar.gz
./python/python.exe -m pip install "vieneu==3.2.4" "huggingface-hub>=0.24"
./python/python.exe -m pip list --format=freeze | sort   # so với evidence/win-package-set.txt

# Cài CỤC BỘ trong thư mục spike. MUST NOT dùng `bun add` ở đây: bun leo lên
# package.json của repo và sẽ vừa thêm @hono/node-server vừa **bỏ pin** hono
# (4.12.33 → ^4.13.0). Đó là thay đổi production, không phải thay đổi spike.
npm install --no-save --prefix . hono@4.12.33 @hono/node-server puppeteer-core@25.4.0

node pipe-probe.mjs      # W-2
node cookie-probe.mjs    # W-1  (cần chrome-headless-shell trong cache hyperframes)
```

Tập package đo được nằm ở [`evidence/win-package-set.txt`](evidence/win-package-set.txt) (79 dòng, trước prune) và [`evidence/win-package-set-pruned.txt`](evidence/win-package-set-pruned.txt) (58 dòng, sau prune).
