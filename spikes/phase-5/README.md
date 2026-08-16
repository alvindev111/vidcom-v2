# Spike Giai đoạn 5 — preview partial reload & caption clock

Chạy **2026-08-16**, năm vòng. Đếm trung thực: **24 probe hợp lệ PASS + 1 bị thay thế** — 25 kết quả trong năm script, S-P12 đo sai và bị S-P14 thay, Chrome thật (`puppeteer-core` + Google Chrome), player và runtime **thật**
lấy từ `node_modules/@hyperframes/{player,core}`. Không mock.

```bash
node spikes/phase-5/run-spike.mjs        # vòng 1 — 6 probe
node spikes/phase-5/run-spike-2.mjs      # vòng 2 — 5 probe
node spikes/phase-5/build-production-docs.mjs   # dựng tài liệu preview bằng builder production
node spikes/phase-5/run-spike-3.mjs      # vòng 3 — 6 probe trên pipeline production
node spikes/phase-5/run-spike-4.mjs      # vòng 4 — e2e đúng nội dung mới, asset, double-buffer
node spikes/phase-5/run-spike-5.mjs      # vòng 5 — double-buffer là cơ chế chính: transport, health, clamp
node spikes/phase-5/inspect.mjs          # in cây DOM preview sau khi runtime boot
```

`CHROME_PATH` override được đường dẫn Chrome.

## Vì sao có spike này

Detailed Design bản 3 §5.9/§5.14 dựng hai cơ chế đọc từ mã runtime nhưng **chưa chạy thử**: nạp lại
một sub-composition mà không dựng lại player (R4), và caption tô từng từ theo đồng hồ seek-safe (R6).
Design tự chặn: không viết production code cho R4/R6 trước khi bốn probe này có kết quả.

Vòng 2 (`run-spike-2.mjs`) thêm năm probe cho những câu vòng 1 **không** trả lời.

## Kết quả vòng 1 — 6/6 PASS, lặp lại 2 lần

| # | Probe | Kết quả | Bằng chứng |
|---|---|---|---|
| S-P0 | Runtime boot và phát `timeline` | **PASS** | thứ tự message: `analytics → stage-size → timeline → state → ready`; `fps = 30/1` |
| S-P1 | Thay subtree một sub-composition tại chỗ | **PASS** | runtime phát `timeline` mới; `__clipManifest` chứa clip `swapped-extra` vừa thêm; player **giữ nguyên danh tính**; trôi **0 khung** (đo lúc pause) |
| S-P2 | Swap hỏng rồi rollback | **PASS, nhưng đọc kỹ** | script scene ném `scene boom`; agent gắn lại children cũ; player còn sống; runtime vẫn phát `state`. **`brokenVisible: "BROKEN"` — nội dung hỏng ĐÃ hiện ra trước khi rollback.** Rollback cứu được trạng thái, **không** cứu được khung hình |
| S-P3 | Preflight trước khi nạp lại root | **PASS** | URL tốt: `ready=true, duration=12`; URL hỏng (500): `ready=false, duration=0` sau 6 s; `src` của player **không đổi** |
| S-P3b | Nạp lại root giữ transport | **PASS** | cùng instance player, trôi **0 khung** sau khi khôi phục |
| S-P4 | Caption bám đồng hồ runtime | **PASS** | phát → `["ba"]`; seek 1.4 s → `["hai"]`; `playbackRate = 2` → `["hai"]`; pause + seek 2.4 s → `["ba"]` |

## Kết quả vòng 2 — 5/5 PASS

| # | Probe | Kết quả đo |
|---|---|---|
| S-P5 | Sửa **chỉ text**, tập `[data-start]` không đổi | **PASS** — runtime **vẫn** phát `timeline` mới. Nên "đợi `timeline`" dùng được làm tín hiệu xác nhận cho cả ca sửa nội dung thuần |
| S-P6 | Scene bắt đầu ở `t = 6` | **PASS sau khi sửa script** — mốc trong span là **thời gian scene**; script phải trừ `data-start` của layer. Bản chưa sửa tô **rỗng** ở root 6.8 s; bản sửa tô đúng `["bốn"]` |
| S-P7 | `fps` của runtime | **PASS** — `fps` là **hữu tỉ** `{numerator: 30, denominator: 1}`; `Number(fps)` ra **NaN**. Script vòng 1 vì thế im lặng rơi về mặc định 30 và *tình cờ* đúng |
| S-P8 | Gán lại **cùng** URL cho `src` | **PASS** — iframe nạp lại thật (`performance.timeOrigin` đổi). Không cần `?r=` để phá cache |
| S-P9 | Độ trễ swap DOM tới khung vẽ | **PASS** — **17–19 ms** cho phương án hot-swap cũ; chỉ là số đo thành phần, **không** chứng minh R4.1c và không còn là cơ chế được chọn |

## Kết quả vòng 3 — 6/6 PASS, chạy trên **builder production**

Vòng 1–2 dùng fixture tự viết. Vòng 3 dựng tài liệu bằng **chính** `buildSubCompositionHtml` mà
[`document.ts`](../../packages/adapter/src/hyperframes/document.ts) gọi, phục vụ theo hình dạng
production: tài liệu compile ở `/compiled/root.html`, file project thô ở `/project-files/`.

| # | Probe | Kết quả đo |
|---|---|---|
| S-P10a | Tài liệu compile boot được | **PASS** — runtime nạp scene qua `data-composition-src` (resolve theo `<base href="/project-files/">`); root **không** inline scene |
| S-P10 | Patch swap khớp với thứ runtime tự nạp | **PASS** — fetch đúng URL runtime dùng rồi `replaceChildren` cho DOM **giống hệt** bản runtime tự dựng |
| **S-P11** | Script trong subtree swap có chạy không? | **PASS — và đây là phát hiện nặng nhất của cả spike: KHÔNG.** `DOMParser`/`importNode` đánh dấu script "already started", nên `sideEffectRan = 0` dù `scriptsInDom = 1`. Phải **tạo lại** từng `<script>` mới chạy (`sideEffectRan = 1`) |
| S-P11b | `ready && duration` có bắt được scene ném lỗi không? | **PASS — không.** `ready = true`, `duration = 12` trong khi script scene ném. Chỉ listener `error` bắt được (`errorsSeen = 1`) |
| **S-P13** | Rollback DOM có dừng được side effect không? | **PASS — không.** `setInterval` của scene cũ vẫn chạy sau khi thay children: tick 14 → 26. Swap cần **hợp đồng dispose** |
| S-P12 | Độ trễ phương án hot-swap | **SUPERSEDED** — số 122 ms preflight nhầm root cũ; S-P14 sửa phép đo, và vòng 5 sau đó loại toàn bộ phương án hot-swap |

## Kết quả vòng 4 — 4/4 PASS, sửa một lỗi đo của vòng 3

| # | Probe | Kết quả đo |
|---|---|---|
| **S-P14** | Sửa lỗi đo của S-P12 | **PASS.** S-P12 preflight **root cũ** (vẫn trỏ `scene-1.html`) trong khi swap v2 — nên con số 122 ms của nó không chứng minh điều tài liệu nói. S-P14 preflight **root đã dựng lại** (`root-v2.html`), khẳng định tài liệu ẩn thật sự chứa `"Scene one — SWAPPED"`, chạy đủ `PreflightHealth`, và đo **cả warm lẫn cold cache**: **126 ms / 120 ms** |
| **S-P15** | Swap ngây thơ với scene có asset tương đối | **PASS (thất bại có chủ đích).** `../assets/dot.gif` trong scene resolve theo `<base href>` của **root** thành `/assets/dot.gif` ⇒ ảnh **không load**, CSS **không áp**. Đây là lỗi thật của phương án swap thô |
| **S-P15b** | Viết lại URL tương đối theo URL của **scene** | **PASS.** Sau khi absolutize `src`/`href`/`url()` theo URL scene: ảnh load, `background-image` áp đúng `/project-files/assets/dot.gif` |
| **S-P16** | Nạp lại root kiểu **double-buffer** | **PASS.** Mount root mới ở player thứ hai phía sau, chờ khoẻ rồi mới đổi hiển thị: player cũ **vẫn vẽ suốt quá trình**, trôi **0 khung**. Đây là cách giữ khung cuối mà không cần poster |

> Một vòng debug bị đốt vì lỗi của **server spike**, không phải của thiết kế: `.css` phục vụ dưới
> `application/octet-stream` nên trình duyệt parse ra **0 rule** và im lặng không áp. Đã sửa bảng MIME.

## Kết quả vòng 5 — 4/4 PASS, sau **ba lần FAIL thật**

Người dùng chốt 2026-08-16: danh tính ổn định là **`PlayerHost` của vidcom**, và **double-buffer cho
mọi thay đổi**. Vòng 5 đo chính cơ chế đó.

| # | Probe | Kết quả đo |
|---|---|---|
| **S-P17** | Giữ time · play state · rate · muted qua buffer swap | **PASS sau khi sửa hai thứ.** Lần đầu trôi **11 khung** vì transport được lấy **trước** preflight — đồng hồ vẫn chạy suốt ~500 ms chờ. Lấy mẫu **tại đúng lúc swap** ⇒ trôi **0 khung**; rate 1.5 và muted giữ nguyên; `PlayerHost` giữ danh tính, chỉ engine bên trong đổi thế hệ |
| **S-P18** | Buffer không khoẻ phải bị từ chối | **PASS sau khi sửa hợp đồng health.** Lần đầu buffer hỏng vẫn **được nhận**: `ready + timeline` đạt **trước khi** sub-composition kịp nạp. Health giờ đòi thêm **mọi layer `[data-composition-src]` đã có children** cộng **cửa sổ im lặng 150 ms** không lỗi. Root có scene 404 ⇒ `scenesLoaded: false` ⇒ hết hạn **2.5 s** ⇒ **không swap**, engine cũ vẫn vẽ |
| **S-P19** | Duration mới ngắn hơn | **PASS** — playhead 9 s kẹp về 5 s đúng thời lượng mới |
| **S-P20** | Collector có thật sự bắt được lỗi không? | **PASS sau khi sửa chỗ tiêm.** Lần đầu **FAIL**: root có script ném và ảnh 404 vẫn "khoẻ" (`scriptErrors: 0`) vì collector gắn **từ host** — quá muộn, script root chạy lúc parse. Chuyển collector thành script builder tiêm ngay sau `<head>`, trước authored script ⇒ bắt đúng `scriptErrors: 1`, `resourceErrors: 1`, từ chối trong **101–105 ms** |

**Ngân sách sau khi chỉnh** (cửa sổ im lặng 400 → **150 ms**, hết hạn 8 s → **2.5 s**): swap khoẻ đo
được **251–252 ms** (trước đó 525 ms — **vượt** AC 500 ms của R4.1c); buffer hỏng vì lỗi script bị từ chối
sau **101–105 ms**; buffer hỏng vì scene không nạp bị từ chối sau **2.5 s** (đường hết hạn, không phải
đường ngân sách).

### Phát hiện lật lại kết luận vòng 3

**Runtime KHÔNG chạy script trong sub-composition.** Đo trực tiếp trên root hỏng có chủ đích:
`scriptsInScene: 1`, `ranSideEffect: null`, không có `pageerror` nào. Nghĩa là:

- Kết luận vòng 3 "swap phải **tạo lại** `<script>` mới chạy" là đúng về mặt DOM nhưng **sai về mặt
  parity**: làm vậy sẽ chạy code mà đường nạp gốc **không bao giờ** chạy, tức preview lệch render.
- Với mô hình double-buffer đã chốt, cả vấn đề này lẫn hợp đồng dispose (S-P13) **biến mất khỏi phạm
  vi**: không còn swap DOM tại chỗ.
- Giới hạn đã biết: fixture khai scene qua `data-composition-src` và compiler **không** inline chúng.
  Project khai kiểu khác (inline lúc build) có thể chạy script khác đi — phải kiểm lại lúc thực thi.

## Mười một phát hiện đổi thiết kế

1. **Swap phải viết lại URL tương đối theo URL của scene (S-P15/S-P15b).** Không làm thì ảnh, `<link>`
   và `url()` trong scene đều trỏ sai sau khi swap — hỏng im lặng, vì DOM trông đúng.

2. **Giữ khung cuối = double-buffer, không phải poster (S-P16).** Player thứ hai nạp root mới phía
   sau, chỉ đổi hiển thị khi nó khoẻ. Không cần một nguồn ảnh "khung hiện tại" mà hệ thống chưa có.

3. **Runtime quét lại `[data-start]` mỗi tick.** Thay subtree trong tài liệu preview là cơ chế
   **được hỗ trợ sẵn**: runtime dựng lại `__clipTree`, cập nhật `__clipManifest`, phát `timeline` mới.
   Không cần HyperFrames mở API nạp-lại-một-phần. (Tập control action của runtime — `play`, `pause`,
   `seek`, `tick`, `set-*`, `enable-pick-mode` — **không** có action nào nạp lại composition.)

4. **Runtime là nguồn đồng hồ cho caption.** Nó phát `{source:"hf-preview", type:"state", frame,
   isPlaying, playbackRate}` mỗi khi frame đổi, và `type:"timeline"` mang `fps`. Script tiêm trong
   cùng tài liệu quan sát được các message này (spike bọc `window.parent.postMessage`), nên highlight
   đúng cả khi seek, khi pause, khi đổi tốc độ — ba tình huống mà `requestAnimationFrame` luôn sai.

5. **Script của scene không tự chạy khi swap (S-P11).** Đây là thứ có thể ship một tính năng trông
   như chạy: text đổi, timeline đổi, nhưng mọi hoạt cảnh GSAP trong scene **im lặng không chạy**.
   Agent bắt buộc phải tạo lại từng `<script>` (copy attribute + nội dung) sau khi gắn children.

6. **Đã chạy thì không "gỡ" được (S-P13).** Timer và listener của scene cũ sống tiếp sau khi DOM bị
   thay. Rollback DOM **không** phải rollback trạng thái ⇒ cần hợp đồng dispose, hoặc chấp nhận nạp
   lại root cho scene có script.

7. **`ready && duration > 0` không phải tín hiệu sức khoẻ (S-P11b).** Player báo sẵn sàng trong khi
   script scene đang ném. Preflight phải nghe `error`, `unhandledrejection`, và lỗi tải tài nguyên.

8. **Rollback không giữ được khung hình.** S-P2 đo được nội dung hỏng hiện ra trước khi agent gắn lại
   children cũ. Muốn "khung cuối không bao giờ mất" thì phải **kiểm bản mới ở player ẩn trước**, rồi
   mới đụng vào DOM đang chiếu; rollback chỉ là lưới an toàn cuối cùng và **có nháy hình**.

9. **`fps` là hữu tỉ, và quy đổi root → scene là bắt buộc.** `Number(fps)` ra `NaN` (S-P7) và mốc
   caption là thời gian **scene** chứ không phải root (S-P6). Hai lỗi này che nhau ở vòng 1: fixture
   chạy 30 fps với scene bắt đầu ở 0 nên cả hai sai đều vô hình.

10. **Preflight phải dùng một `<hyperframes-player>` ẩn, không phải `<iframe>` trần.** Runtime chỉ
   khởi động khi **player tiêm** nó (`_injectRuntime`); một iframe trần tải cùng URL không phát message
   nào. Tín hiệu preflight tin cậy nhất là `player.ready && player.duration > 0`, không phải nghe
   message — hai player sống trên cùng trang làm việc so `event.source` không đáng tin.

11. **Sub-composition được runtime nạp vào cùng tài liệu**, không phải iframe lồng: layer
   `[data-composition-id][data-composition-src]` được điền children từ file scene, và `data-duration`
   của layer bị đổi thành `data-hf-authored-duration`. Agent hot-swap vì thế làm việc trên **children
   của layer**, không phải thay cả layer.

## Chưa đo được — nợ lại lúc thực thi

- **Parity preview ↔ render thật** (R6.14): spike chỉ chạy preview.
- **`data-fps` của root không đổi được fps runtime trong fixture này**: đặt 24 và 60 vẫn báo `30/1`.
  Fixture thiếu thứ mà project thật khai fps ở đó; phải xác định lại khi nối vào pipeline thật.
- **R4.1c end-to-end**: spike chỉ đo riêng `PlayerHost.reload()`; browser test còn phải đo
  response→first-new-frame và SSE-received→first-new-frame, gồm cả preview settings.

Hai món nợ cũ — hợp đồng dispose và `<head>` của sub-composition khi hot-swap — **không còn thuộc
contract** sau quyết định double-buffer. Giữ khung cuối khi tài liệu mới hỏng đã PASS ở S-P16/S-P18.

## Ảnh hưởng tạm thời sau vòng 1–4 — **đã bị quyết định vòng 5 thay thế**

- Các dòng dưới ghi lại vì sao thiết kế từng đi theo hot-swap; chúng **không còn là contract**.
- Contract cuối ở vòng 5: giữ `PlayerHost`, dựng engine đệm cho mọi update, collector do daemon tiêm,
  rồi swap engine khi khoẻ (S-P17–S-P20).
- Kết quả cũ: swap thay children, preflight player ẩn và ack `timeline`; S-P15/S-P11/S-P13 sau đó
  chứng minh đường này hỏng URL/parity/dispose nên bị loại.
- §5.8: bỏ `?r=` — gán lại cùng URL vẫn nạp lại (S-P8).
- §5.14: đồng hồ caption là `state.frame`, `fps` đọc theo **hữu tỉ** `{numerator, denominator}` (S-P7),
  và mốc word phải trừ `data-start` của layer chứa nó (S-P6).
- R4.1c vẫn cần browser gate response→frame/SSE-received→frame. S-P9, S-P14 và con số reload
  251–252 ms chỉ là feasibility evidence cho các đoạn con, không phải phép đo đầy đủ của AC.

## File

- `fixture/index.html` — root composition + script caption tiêm
- `fixture/compositions/scene-1.html`, `scene-1-v2.html`, `scene-2.html` — sub-composition, bản v2 là "bản đã sửa" để swap
- `fixture/host.html` — trang chủ mount `<hyperframes-player>` một lần
- `server.mjs` — static server (map `/vendor/*` sang `node_modules`), `/fixture/broken-root.html` trả 500 cho nhánh lỗi
- `run-spike.mjs` — vòng 1 · `run-spike-4.mjs` — vòng 4 (`project/assets/*`, `index-v2.html` là fixture của nó)
- `run-spike.mjs` — sáu probe vòng 1 · `run-spike-2.mjs` — năm probe vòng 2 · `run-spike-3.mjs` — sáu probe vòng 3 (pipeline production)
- `build-production-docs.mjs` — dựng tài liệu bằng `buildSubCompositionHtml`; `project/` là project nguồn; `compiled/` là đầu ra
- `fixture/compositions/scene-1-textonly.html`, `fixture/index-fps{24,60}.html` — fixture của vòng 2
- `inspect.mjs`, `probe-debug.mjs` — công cụ chẩn đoán dùng khi dựng spike
