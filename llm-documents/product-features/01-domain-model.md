# 01 — Domain model & layout dữ liệu

## 1. Layout project trên đĩa

```
projects/<slug>/
├── hyperframes.json        (BẮT BUỘC — dấu hiệu nhận biết project)
├── index.html             (BẮT BUỘC — root composition, entry hard-code)
├── meta.json              tuỳ chọn — { id, name, createdAt }
├── registry-item.json     tuỳ chọn — title, description, dimensions, duration, files[]
├── package.json           tuỳ chọn — script gọi hyperframes CLI
├── preview-settings.json  do studio ghi
├── AGENTS.md / CLAUDE.md  hướng dẫn cho AI agent (studio không đọc)
├── compositions/
│   ├── intro.html         sub-composition = scene
│   ├── graphics.html
│   ├── captions.html
│   ├── scene-1.html       do studio sinh ra (action `generate`)
│   └── editorial-flash-overlay.html   block cài từ registry
├── assets/
│   └── swiss-grid.svg
├── narration/
│   ├── scene-1.json       sidecar TTS do studio ghi
│   └── scene-1.wav        (nếu chạy `hyperframes tts` thật)
├── snapshots/
│   ├── frame-00-at-0s.png     do `hyperframes snapshot` sinh
│   ├── frame-01-at-1.2s.png
│   └── contact-sheet.jpg
└── preview-assets/bgm/<file>  nhạc nền upload từ studio
```

### `hyperframes.json`
```json
{
  "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
  "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
  "paths": { "blocks": "compositions", "components": "compositions/components", "assets": "assets" },
  "media": { "autoProxy": true }
}
```
Studio **chỉ đọc field `registry`** (bỏ dấu `/` cuối). Các field `paths`/`media` hiện bị bỏ qua hoàn toàn.

### `registry-item.json`
Studio chỉ đọc `title`, `description`, `dimensions.width`, `dimensions.height`. `duration` và `files[]` bị bỏ qua (duration lấy từ HTML).

### `meta.json`
Chỉ đọc `name` (làm fallback cho title). `createdAt` không dùng.

## 2. Hợp đồng `data-*` của HyperFrames (nguồn sự thật thật sự)

Studio **không tin metadata JSON**, nó đọc trực tiếp attribute trên DOM. Comment tại [projects.server.ts:117](../../src/lib/hyperframes/projects.server.ts#L117) ghi rõ lý do: `extractCompositionMetadata()` của `@hyperframes/parsers` báo sai trên các project này (báo `resolution: "portrait"` cho document 1920×1080, id null, duration null).

| Attribute | Ý nghĩa | Đọc bởi |
|---|---|---|
| `data-composition-id` | ID của composition host. Có mặt = là một composition | `readComposition`, `readCompositionHosts` |
| `data-width` / `data-height` | Kích thước canvas. **Host nào có cả 2 attribute này = ROOT** | `rootHost()` |
| `data-composition-src` | Đường dẫn file sub-composition. Có = scene riêng file; không = scene inline | `readScenes` |
| `data-start` | Giây bắt đầu, tương đối với composition cha | `readClipTiming` |
| `data-duration` | Thời lượng (giây) | `readClipTiming` |
| `data-end` | Legacy — thay cho duration | `readClipTiming` |
| `data-track-index` | Thứ tự lớp (z/stacking intent của tác giả) | `readClipTiming` |
| `data-layer` | Legacy — thay cho track-index | `readClipTiming` |
| `data-volume` | Âm lượng cho `<audio>`/`<video>` runtime-managed | dùng khi sinh BGM |
| `class="clip"` | Đánh dấu element được runtime quản lý visibility/playback | `TIMED_SELECTOR` |
| `data-hf-id` | ID do SDK stamp vào khi `serialize()` | SDK dùng làm `scopedId` để `setText`/`setTiming` |

Cách xác định root ([projects.server.ts:149](../../src/lib/hyperframes/projects.server.ts#L149)):
```js
hosts.find(h => h.hasAttribute("data-width") && h.hasAttribute("data-height")) ?? hosts[0]
```
Mọi `[data-composition-id]` **khác root** = một **scene**, sort theo `trackIndex` **giảm dần** (lớp trên cùng trước).

Ví dụ thực tế (`projects/warm-grain/index.html`):
```html
<div id="main-composition" data-composition-id="main-video"
     data-width="1920" data-height="1080" data-start="0" data-duration="14">   ← ROOT

  <div id="grain-overlay-comp" data-composition-id="grain-overlay"
       data-width="1920" data-height="1080"
       data-start="0" data-duration="10" data-track-index="100">               ← scene INLINE
     <div class="grain-texture"></div>
     <script>/* gsap timeline */</script>
  </div>

  <div id="intro-layer" class="comp-layer" data-composition-id="intro"
       data-composition-src="compositions/intro.html"
       data-start="0" data-duration="2.5" data-track-index="1"></div>          ← scene FILE

  <div id="flash-transition" class="comp-layer clip" data-composition-id="editorial-flash-overlay"
       data-composition-src="compositions/editorial-flash-overlay.html"
       data-start="4.6" data-duration="1" data-track-index="50"></div>         ← transition BLOCK

  <script>/* gsap timeline điều khiển #a-roll */</script>
</div>
```

Lưu ý: `grain-overlay` **có cả `data-width`/`data-height`** nhưng không phải root vì `rootHost()` lấy phần tử **đầu tiên** thoả điều kiện theo document order — `main-composition` đứng trước. Đây là điểm dễ vỡ, backend mới nên xác định root tường minh hơn (ví dụ: element không có composition-host cha nào).

### Đăng ký GSAP timeline
Convention của HyperFrames: mỗi composition đăng ký timeline của nó lên `window.__timelines[<composition-id>]`, timeline ở trạng thái `paused: true`. Runtime seek các timeline này theo transport. Studio **không thực thi** script — nó chỉ parse tĩnh.

## 3. Các kiểu dữ liệu TypeScript

Toàn bộ ở [src/lib/studio/types.ts](../../src/lib/studio/types.ts).

### `FileNode` — cây file
```ts
{ path: string;       // relative project root, dùng làm React key + id chọn
  name: string;
  kind: "file" | "folder";
  children?: FileNode[]; }
```

### `SourceFile` — một file text đang mở
```ts
{ path: string;
  code: string;
  foldableLines: number[];  // dòng 1-based mở block (theo indentation)
  saved: boolean;           // luôn true khi đọc từ server
  version: string; }        // `${mtimeMs.toString(36)}-${size.toString(36)}`
```
> `foldableLines` là **di sản** của `code-view.tsx` đã bị xoá; `CodeEditor` (CodeMirror) không dùng nó. `saved` cũng luôn `true`. Backend mới có thể bỏ cả hai.

### `Scene` — đơn vị trung tâm
```ts
{ id: string;                 // = data-composition-id
  src: string | null;         // file sub-composition, null = inline trong index.html
  start: number;              // giây, tương đối root
  duration: number;
  trackIndex: number;
  block: SceneBlock | null;   // xuất xứ registry (nếu là block cài sẵn)
  isTransition: boolean;
  media: SceneMedia[];
  script: SceneScriptLine[];  // copy trên màn hình, theo document order
  narration: Narration | null;
  elements: SceneElement[];   // element + tween cho timeline mở rộng
  unresolvedEffects: number; } // số tween parser không giải được (target tạo trong loop)
```

### `SceneBlock` — xuất xứ registry
```ts
{ name: string;            // từ comment <!-- hyperframes-registry-item: <name> -->
  title: string | null;
  description: string | null;
  category: string | null; // resolveBlockCategory(tags): "transitions" | "vfx" | …
  tags: string[]; }
```

### `SceneMedia`
```ts
{ kind: "image" | "video" | "audio";
  url: string;    // đã resolve thành /api/hf/<slug>/files/...
  src: string;    // nguyên văn trong HTML
  start: number | null;
  duration: number | null; }
```

### `SceneElement` + `SceneEffect` — nội dung bên trong scene
```ts
SceneElement {
  id: string;       // "#element-id" hoặc "tag:index" hoặc selector của tween
  label: string;
  kind: "image" | "video" | "audio" | "element";
  start: number | null;     // null = tác giả không khai timing riêng
  duration: number | null;
  src: string | null;
  effects: SceneEffect[]; }

SceneEffect {
  id: string;                    // `${scriptIndex}:${animation.id}`
  method: string;                // "to" | "from" | "fromTo" | "set"
  start: number;                 // giây, tương đối scene
  duration: number;
  ease: string | null;
  propertyGroup: string | null; } // position|scale|size|rotation|visual
```

### `RootTrack` — track riêng của `index.html`
```ts
{ id: string;          // composition id của root
  duration: number;
  elements: SceneElement[];
  unresolvedEffects: number; }
```
Tồn tại vì: composition kiểu "footage-led" chỉ có 1 `<video class="clip">` + graphics đè lên. `readScenes` chỉ thấy nested host → footage và các camera move viết trong `index.html` **hoàn toàn mất khỏi timeline**. Trả `null` nếu không có gì ở root level.

### `Narration` — sidecar TTS
```ts
{ sceneId: string;
  text: string;
  voice: string;                     // luôn "af_heart"
  status: "mock" | "generated";      // generated = có file wav trên đĩa
  audioPath: string;                 // "narration/<sceneId>.wav"
  command: string;                   // lệnh CLI sinh ra wav thật
  revision: number;                  // tăng dần mỗi lần regenerate
  updatedAt: string; }                // ISO
```

### `SceneScriptLine` — một dòng chữ sửa được
```ts
{ id: string;    // hf-id (đã scope) — target của SDK setText
  text: string;
  file: string; } // file project-relative sở hữu element
```

### `TerminalLine` / `AgentId` — cho AI Composer
```ts
type AgentId = "claude" | "codex";
TerminalLine { kind: "command" | "output" | "muted" | "accent"; text: string; }
```

### `HyperframesProject` — cho Home
```ts
{ slug, title, description?, width, height, duration: number|null, entry }
```

## 4. `PreviewSettings` — cấu hình preview

Ở [src/lib/studio/preview-settings.ts](../../src/lib/studio/preview-settings.ts), lưu tại `<project>/preview-settings.json`.

```ts
PreviewSettings {
  tone: {
    enabled: boolean;              // default false — CỐ Ý (xem ghi chú dưới)
    colorMode: "dark" | "cream";
    backgroundColor: string;       // hex #rrggbb
    backgroundFx: "none"|"scan"|"particles"|"rings"|"lorenz";
    mainLight: string; mainLightPosition: LightPositionKey; mainLightIntensity: LightIntensityKey;
    softLight: string; softLightPosition: LightPositionKey; softLightIntensity: LightIntensityKey;
  };
  theme: { variables: Record<string,string> };  // chỉ 6 biến cố định
  bgm: { enabled: boolean; volume: 0..1; loop: boolean; track: {name,path} | null };
  subtitles: { enabled: boolean; override: boolean; color: string; activeColor: string;
               fontSize: 8..200; bottom: 0..900 };
  scenes: Record<sceneId, { transitionSound: TransitionSound; revealSound: RevealSound; hidden: boolean }>;
}
```

Enum cố định:
- `LIGHT_POSITIONS` — 9 vị trí (`top-left` … `bottom-right`), mỗi vị trí map ra `{x,y}` phần trăm.
- `LIGHT_INTENSITIES` — `low`(α .14) `medium`(.22) `high`(.30) `max`(.40).
- `BACKGROUND_FX` — 5 giá trị.
- `THEME_VARIABLES` — `--primary --primary-light --accent --accent-light --success --info`.
- `TRANSITION_SOUNDS` — 12: gong rise bass chime sweep boom alarm chord ascending retro minimal dramatic.
- `REVEAL_SOUNDS` — 12: ping pop chime click bubble woosh sparkle drop tick bell blip snap.

Default: `DEFAULT_PREVIEW_SETTINGS` — tone off, subtitles on nhưng override off, bgm off, fontSize 72px / bottom 120px (sized cho canvas 1080p, không phải cho web page).

> Hai default `false` là **quyết định thiết kế có lý do ghi trong code**: `tone.enabled=false` vì overlay là layer blend toàn khung, project không yêu cầu thì phải render y như tác giả viết (bật mặc định đã làm trắng bợt một project nền cream). `subtitles.override=false` vì composition đã tự style caption thì phải giữ thiết kế của nó.

### Validation / normalize
`normalizePreviewSettings(raw)` ([preview-settings.ts:211](../../src/lib/studio/preview-settings.ts#L211)) **không bao giờ throw**:
- `hex()` — chỉ chấp nhận `/^#[0-9a-f]{6}$/i`, sai thì lấy default.
- `number(v, fallback, min, max)` — clamp.
- `oneOf(v, allowed, fallback)`.
- `bool(v, fallback)`.
- `theme.variables` bị **khoá cứng** vào 6 key trong `THEME_VARIABLES` — key lạ bị loại bỏ.
- `scenes` giữ mọi key (scene id là tự do) nhưng normalize từng giá trị.

`mergePreviewSettings(current, patch)` — merge **theo section** rồi normalize lại. Lý do: UI gửi một section mỗi lần, nên edit đồng thời ở card khác không bị payload cũ ghi đè.

## 5. Bảng tóm tắt: dữ liệu nào ở đâu

| Dữ liệu | Nguồn sự thật | Ai ghi |
|---|---|---|
| Kích thước, thời lượng, danh sách scene, timing | attribute `data-*` trong `index.html` | tác giả / agent / SDK |
| Nội dung scene (element, tween, media, text) | file HTML của scene | tác giả / agent / SDK |
| Xuất xứ block | comment `<!-- hyperframes-registry-item: X -->` + registry HTTP | `hyperframes add` |
| Title / description project | `registry-item.json` → `meta.json` → slug | `hyperframes init` |
| Tone/màu/BGM/subtitle/sound/hidden | `preview-settings.json` | studio |
| Job TTS | `narration/<sceneId>.json` | studio |
| Audio TTS thật | `narration/<sceneId>.wav` | `hyperframes tts` (CLI, ngoài app) |
| Poster frame storyboard | `snapshots/frame-NN-at-Ts.png` | `hyperframes snapshot` (CLI, ngoài app) |
| Nhạc nền | `preview-assets/bgm/<file>` | studio (upload) |

Điểm cần quyết định khi viết lại backend: **giữ file-as-source-of-truth hay chuyển sang DB?** Xem [13-backend-requirements.md](13-backend-requirements.md) §2.
