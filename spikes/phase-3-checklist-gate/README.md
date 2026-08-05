# Spike — Checklist Gate (Phase 3)

> **Chạy 2026-08-04** trên darwin 25.5.0 / Node 24.9.0 / hyperframes 0.7.86.
> Mục đích: đóng **ba số chưa đo** mà [Detailed Design](../../llm-documents/specs-and-process/specs/spec-project-delivery-loop/spec-project-delivery-loop-detailed-design.md) §14 Feasibility liệt kê là điều kiện trước khi lập Implementation Checklist.
> Đây **không** phải chấp thuận Design. Nó cung cấp số để §14 tick được hoặc để kích hoạt đường lùi đã khai.

## Kết quả một dòng

| Spike | Câu hỏi | Verdict | Hệ quả |
|---|---|---|---|
| **S1** POSIX kill+sweep | group kill hội tụ trong bao nhiêu sweep? | ⚠️ **PASS giả** | Đo sai mục tiêu — xem S1b/S1c |
| **S1b** group vs descendant | descendant có nằm trong process group không? | ❌ **KHÔNG** | Chromium tự tách pgid |
| **S1c** survivor thật | `kill(-pgid)` có giết Chromium không? | ❌ **LEAK 5 process** | §5.9 POSIX sai; `killProcessTree` hiện tại hỏng |
| **S1d** remediation | capture-rồi-kill-PID-đã-ghi có bịt được không? | ✅ **WORKS** | 0 leak / 3 lần, 2 sweep, ~170 ms |
| **S1e** đa nền tảng | thuật toán ba pha có đứng trên mọi OS không? | ✅ **PASS** darwin + Linux + Windows | 0 survivor; 2 sweep trên cả ba OS |
| **S2** scan 100 project | target hai tầng §9.1 có đứng không? | ✅ **PASS** | stat 1.5 ms · parse 488 ms / 2000 ms |
| **S3 + S3b** `--at` fail | một timestamp hỏng có giết cả batch không? | ✅ **KHÔNG** | Decision 13 đứng — nhưng lộ hai lỗ khác |

**Trạng thái W1/W2**: đã đóng bằng [GitHub Actions run 30965814511](https://github.com/dinh-ai-system-exe-com-vn/vidcom-v2/actions/runs/30965814511) trên exact commit `17958d4`. Linux (`ps`) tái hiện leak ngây thơ ở `escaping` + `leaf`, nhưng ba pha capture 3 PID/2 group và sạch sau 2 sweep trong 120.4 ms. Windows dùng `powershell-cim` (459 ms ở lần probe), naive không leak trên runner này, còn ba pha capture 4 PID/1 group và sạch sau 2 sweep trong 1921.7 ms; lượt lặp cũng PASS trong 1906.7 ms. Cả ba OS đều `exhaustive=true`, 0 survivor.

---

## S1 → S1d: chuỗi tự bác bỏ

Đây là chuỗi đáng đọc theo thứ tự, vì spike đầu **PASS mà sai**.

### S1 — `s1-posix-kill-sweep.mjs`

Đo đúng như §5.9 mô tả: kill process group, sweep tới hai lượt rỗng liên tiếp. Kết quả `PASS_POSIX`, p95 = 2 sweep, 0 survivor, 8 lần cancel.

**Nhưng**: mỗi lần chỉ quan sát được ~2 PID trong group. Một lượt render chạy Chromium và FFmpeg, nên con số 2 là dấu hiệu hoặc render chưa tới giai đoạn đa tiến trình, hoặc — tệ hơn — chúng **không** phải thành viên group. Sweep tìm thành viên group, nên nếu leak nằm ngoài group thì sweep không bao giờ thấy nó. PASS ở đây có thể là PASS mù.

### S1b — `s1b-group-vs-descendants.mjs`

So hai tập trên một render đang chạy:
- `group` = mọi PID có `pgid == rootPid` — thứ `kill(-pgid)` chạm tới
- `descendant` = bao đóng ppid từ `rootPid` — thứ thật sự phải chết

```
descendantCount: 6   groupCount: 2
escaped: 5 × chrome-headless-shell, pgid 48602 (= chính pid của nó)
verdict: GROUP_IS_NOT_THE_CLOSURE_SEE_NOTES
```

**`chrome-headless-shell` tự đặt mình vào process group riêng.** `kill(-rootPid)` không bao giờ nhắm tới nó.

### S1c — `s1c-posix-survivor-truth.mjs` — spike quyết định

Ghi PID cụ thể lúc còn sống, kill group như code hiện tại làm, rồi probe **từng PID** bằng `kill(pid, 0)`:

```
inGroupCount: 1        outOfGroupCount: 5
survivorsByDirectPidProbe: 5 × chrome-headless-shell
ppidWalkAfterKillCount: 0
verdict: GROUP_KILL_LEAKS
```

Hai kết luận, cái thứ hai nguy hiểm hơn cái thứ nhất:

1. **`kill(-pgid)` để sót 5 process Chromium.** [`node-process-runner.ts:137`](../../packages/adapter/src/runtime/node-process-runner.ts#L137) làm đúng việc đó hôm nay. Comment ở đó nói về sidecar VieNeu/Python — đúng cho ca đó, **không** đúng cho render.
2. **Bẫy đo lường**: `ppidWalkAfterKillCount: 0` trong khi 5 process còn sống. Cha chết thì con được reparent sang `pid 1`, nên mọi sweep đi theo ppid từ `rootPid` sẽ báo *sạch* đúng trong tình huống đang leak. Verify sweep **MUST** probe PID đã ghi trực tiếp, MUST NOT đi theo ppid.

### S1d — `s1d-posix-remediation.mjs`

Thuật toán sửa:

```
capture (trong lúc chạy, mỗi 250 ms) : tích luỹ PID cụ thể + tập pgid phân biệt
kill                                 : kill mọi pgid đã ghi, rồi mọi PID đã ghi
verify (mỗi 100 ms, tối đa 20 lượt)  : probe kill(pid,0) trên mọi PID đã ghi
                                       + nạp PID mới xuất hiện vào tập
                                       dừng khi hai lượt liên tiếp rỗng
```

```
3/3 iteration: survivors []   sweeps 2   exhaustive true
meanCapturedPids 11.3   capturedGroupCount 4   meanTotalMs 169.5
distinctCommands: chrome-headless-shell, ffmpeg, node, bun, <defunct>
verdict: REMEDIATION_WORKS
```

**Rủi ro còn lại**: process sinh giữa lượt capture cuối và lúc kill vẫn nằm ngoài `capturedPids`. Đây đúng là giới hạn R6.6b-i đã ghi cho Windows — spike này chứng minh **nó áp cho POSIX luôn**, không phải chỉ Windows.

### S1e — `s1e-cross-platform-supervision.mjs` + `platform-supervisor.mjs` + `process-tree-fixture.mjs`

S1c/S1d dùng render thật, nên chúng chỉ chạy được ở nơi tải được Chromium và chỉ chứng minh hành vi của **một** engine. Để thành contract test đa nền tảng, hai thứ phải đổi.

**Fixture tổng hợp thay Chromium.** Thứ cần tái hiện không phải Chromium mà là **hình dạng**: một descendant rời process group của root, cộng một descendant nữa bên dưới nó. `detached: true` cho đúng điều đó trên cả hai họ OS — process group mới trên POSIX, process group mới trên Windows. Bốn process Node ngồi không, không mạng, không Chromium, không FFmpeg.

**Mọi khác biệt nền tảng gói vào đúng ba primitive** (`platform-supervisor.mjs`), thuật toán phía trên không rẽ nhánh theo OS:

| Primitive | POSIX | Windows |
|---|---|---|
| `enumerate()` | `ps -Ao pid=,ppid=,pgid=` | `powershell-cim` → `tasklist-csv` (thoái hoá). `wmic` **đã bỏ** — xem D10 |
| `killGroup(id)` | `process.kill(-pgid, SIGKILL)` | `taskkill /pid <id> /t /f`, **awaited** |
| `killPid(pid)` | `process.kill(pid, SIGKILL)` | `taskkill /pid <pid> /f` |
| `isAlive(pid)` | `process.kill(pid, 0)`; `EPERM` = còn sống | `tasklist /fi "PID eq <pid>"`, **so theo cột PID** |

Hai chỗ dễ sai đã bịt sẵn trong primitive:
- `isAlive` trên Windows **không** được tìm `"<pid>"` trong cả dòng: CSV của `tasklist` là `"image","PID","Session","Session#","Mem"`, nên pid 1 sẽ khớp nhầm cột Session# của mọi process trong session 1. Phải parse theo cột.
- `isAlive` trên POSIX coi `EPERM` là **còn sống**, không phải lỗi — pid tồn tại nhưng thuộc user khác.

**Verdict tách làm hai, có chủ đích.** Naive group kill có leak hay không là **thuộc tính nền tảng**, không phải điều kiện PASS: nếu một OS nào đó group kill thật sự là bao đóng thì đó là phát hiện hữu ích, không phải thất bại. Gate chỉ là: fixture khởi động đủ 4 process, và arm ba pha để lại 0 survivor với `exhaustive: true`. Tách như vậy để một fixture không spawn được không thể "PASS" nhờ không có gì để giết.

Kết quả darwin:

```
naive     : leaked true  — survivorRoles ["escaping","leaf"]  ppidWalkCountAfterKill 0
three-phase: leaked false — capturedPids 3, capturedGroups 2, sweeps 2, exhaustive true
verdict PASS
```

Fixture tái hiện đúng cả hai lỗi của S1c: leak **và** bẫy đo lường (`ppidWalkCountAfterKill: 0` trong lúc 2 process còn sống).

**Dữ kiện Windows đã kiểm, và nó buộc phải sửa thiết kế** — không phải rủi ro chờ CI:

- `wmic` **đã bị gỡ** khỏi Windows Server 2025 và Windows 11 24H2, và khỏi ảnh `windows-latest` của GitHub từ 9/2025 ([runner-images #11228](https://github.com/actions/runner-images/issues/11228)). Lỗi này đã đập vào thư viện process-tree của Node ngoài đời thật ([ps-tree #69](https://github.com/indexzero/ps-tree/issues/69): `spawn wmic.exe ENOENT on Windows Server 2025`).
- `tasklist` không có `ppid`. Nên trên Windows hiện đại, **PowerShell CIM là nguồn duy nhất còn lại** cho quan hệ cha-con.
- Hệ quả: lệnh cấm PowerShell tuyệt đối của Design bản 4 làm pha capture **chết**. Đã thu hẹp ở bản 6 — cấm ở hot path, cho phép một lần ở đường cancel (cancel là vài lần/ngày).
- **`wmic` bị bỏ hẳn (D10)**, không giữ làm fast path: không nền tảng CI nào còn chạy nó, nên giữ lại là giữ một nhánh không ai test phục vụ Windows cũ — đúng hình dạng lỗi đã cắn spec này hai lần.
- `taskkill /t` đi theo quan hệ cha-con của kernel chứ không theo process group, nên Windows có thể **không** leak với arm naive. Trường hợp đó vẫn `PASS` và ghi vào `platformProperty`.

**Trạng thái thoái hoá có luật riêng: trung thực, không phải zero survivor.** Khi không có enumerator cho `ppid`, capture chỉ còn root group — đòi zero survivor là đòi thứ nền tảng không làm được. Thứ nó vẫn phải làm được là **không nói dối**: proof MUST NOT báo sạch trong lúc process còn sống. Leak mà khai thì containment R6.7b thu hồi được; leak mà giấu thì không tầng nào đỡ. Gate CI ở nhánh này kiểm đúng điều đó.

`VIDCOM_DISABLE_ENUMERATORS=powershell-cim` ép chạy nhánh thoái hoá. Cần nó vì một máy còn `wmic` sẽ **không bao giờ** đi vào nhánh đó một cách tự nhiên — mà đó đúng là nhánh proof dễ nói dối nhất.

### S1f — `s1f-real-render-windows.mjs`

Fixture tổng hợp tái hiện **hình dạng** leak, không phải `chrome-headless-shell`. Trên macOS hình dạng đó đã được xác nhận bằng render thật (S1c); Windows thì chưa, nên một thói quen riêng của Chromium ở đó — Job Object riêng, cờ breakaway, hoặc `taskkill /t` đã đủ — sẽ không lộ ra từ bốn process Node.

S1f chạy render thật, ghi ground truth **lúc còn sống**, chạy đúng thuật toán ba pha, rồi probe từng PID. Chạy được mọi nền tảng; job CI đặt ở Windows vì đó là chỗ thiếu, nhưng chạy trên Linux/macOS là cách so sánh hợp lệ.

Kết quả darwin: `TERMINATED_CLEAN` · `engineLeavesRootProcessGroup: true` (5 descendant ngoài group) · 6 PID capture, 2 group, 2 sweep, ~160 ms.

Hard fail của S1f **chỉ** là `LEAKED_AND_PROOF_LIED`. Leak mà proof khai báo trả exit 0 — vì containment lo được, và biến nó thành đỏ sẽ khuyến khích đúng thứ cần tránh: một proof lạc quan.

---

## S2 — `s2-scan-100-projects.mjs`

```
fixture : 100 project · trung bình 83 KB · 2598 scene · 5–50 scene/project
tier 1 stat        1.5 ms   / target 500 ms    PASS
tier 2 parse cold  488.2 ms / target 2000 ms   PASS
warm (cache)       1.9 ms   / target 100 ms    PASS
verdict: PASS — D9 vẫn deferred
```

**Fixture đã phải sửa một lần.** Bản đầu độn byte bằng CSS trong `<style>`; đó là **một text node**, parser đi qua nó gần như miễn phí, và số ra 74 ms — đẹp nhưng vô nghĩa. Bản đúng độn bằng element lồng nhau có thuộc tính, và số nhảy lên 488 ms (6,5×). Ghi lại đây vì bài học lặp lại được: benchmark parser bằng byte count là tự lừa.

**Cảnh báo diễn giải**: filesystem còn nóng (vừa ghi xong), parse chạy bằng `linkedom` in-process, và implementation thật còn phải phân loại + parse `vidcom.json`. Biên 4× đủ rộng để kết luận đứng, nhưng con số không phải là trần.

---

## S3 / S3b — `s3-snapshot-partial-at.mjs`, `s3b-at-failure-modes.mjs`

### Câu hỏi gốc: đóng

Không input nào trong 5 ca thử làm abort cả invocation. **Decision 13 đứng vững** — một invocation batch cho cả tập scene, retry gửi lại tập midpoint còn thiếu.

### Hai lỗ mới, quan trọng hơn câu hỏi gốc

| `--at` | exit | file ra | Vấn đề |
|---|---|---|---|
| `1.0,999.0,3.0` | 0 | 3 (`frame-01-at-999s.png`) | timestamp **quá duration** vẫn ra frame |
| `1.0,-5.0,3.0` | 0 | 3 (`frame-01-at--5s.png`) | timestamp **âm** vẫn ra frame |
| `1.0,abc,3.0` | 0 | **2** (`at-1s`, `at-3s`) | timestamp rác bị **bỏ im lặng** |
| `1.0,,3.0` | 0 | **2** | slot rỗng bị bỏ im lặng |
| `1.0,1.0,3.0` | 0 | 3 (hai file cùng `at-1s`) | trùng không bị gộp |

**Lỗ 1 — CLI không validate range.** Midpoint tính sai quay về dưới dạng *một tấm ảnh*, không phải lỗi. VidCom sẽ đánh dấu generation hoàn tất với frame sai. **VidCom phải tự validate midpoint theo root duration trước khi spawn** — CLI sẽ không làm hộ.

**Lỗ 2 — ordinal dịch khi có timestamp bị bỏ.** `1.0,abc,3.0` ra `frame-00-at-1s.png` + `frame-01-at-3s.png`. Ordinal `01` giờ trỏ vào midpoint thứ **ba**. Design §5.11 nói "map theo ordinal" — **sai**. Phải map theo token `-at-<t>s` trong tên file, so **theo số**, và coi midpoint không có file là `missingSceneIds`.

**Lỗ 3 — trùng không bị gộp.** Hai scene cùng midpoint ra hai file cùng timestamp khác ordinal. Phải dedupe midpoint trước khi gửi, nếu không mapping theo timestamp lại nhập nhằng.

Định dạng tên file quan sát được: `frame-<nn>-at-<t>s.png`, `t` bỏ số 0 thừa (`1.0` → `1s`, `1.5` → `1.5s`), số âm ra hai gạch (`-5.0` → `at--5s`).

---

## Chạy lại

```bash
npm run spike:process-supervision                                # ~10 s, MỌI nền tảng, không dependency
node spikes/phase-3-checklist-gate/s2-scan-100-projects.mjs      # ~2 s
node spikes/phase-3-checklist-gate/s3b-at-failure-modes.mjs      # ~6 phút, cần Chromium
node spikes/phase-3-checklist-gate/s1c-posix-survivor-truth.mjs  # ~30 s, POSIX, cần Chromium
node spikes/phase-3-checklist-gate/s1d-posix-remediation.mjs     # ~1 phút, POSIX, cần Chromium
```

`s1-posix-kill-sweep.mjs` và `s1b-group-vs-descendants.mjs` giữ lại làm bằng chứng cho chuỗi tự bác bỏ; đừng dùng verdict của S1 làm căn cứ.

`npm run spike:process-supervision` là cái duy nhất chạy trong CI: nó không import gì ngoài `node:` builtin, không cần `bun install`, không cần Chromium/FFmpeg. Exit khác 0 nghĩa là fixture không khởi động được hoặc thuật toán ba pha rò — cả hai đều cần người xem.

## Trạng thái W1/W2

| # | Việc | Trạng thái |
|---|---|---|
| W1 | Thuật toán ba pha trên Windows: `taskkill /T /F` awaited + capture/probe theo PID | **PASS hai lượt**: 4 PID/1 group, 2 sweep, 1921.7/1906.7 ms, 0 survivor |
| W2 | Windows có enumerator cho ppid không | **PASS**: `powershell-cim` có parent, 142 row, 459 ms; `tasklist` có 142 row nhưng không có parent |
| W3 | Linux — cùng câu hỏi, trước đây chưa ai đặt | **PASS**: naive leak `escaping` + `leaf`; ba pha 3 PID/2 group, 2 sweep, 120.4 ms, 0 survivor |
| W4 | `chrome-headless-shell` thật trên Windows có tách group không | **Không trên runner đo được**; render thật có 7 descendant, tất cả cùng root group. Ba pha capture 7 PID/1 group, 2 sweep, 2298.6 ms, `TERMINATED_CLEAN` |

Không cái nào còn chặn Design: cách sửa đã đo PASS trên cả ba OS và không phụ thuộc thuộc tính group riêng của từng nền tảng. Capture vẫn bắt buộc dù Windows runner này không tái hiện việc tách group, vì Linux/macOS đã chứng minh group kill có thể rò.
