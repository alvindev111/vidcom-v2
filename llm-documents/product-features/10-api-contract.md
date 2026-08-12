# 10 — Đặc tả HTTP API hiện tại

> **Cập nhật backend Phase 2 (2026-08-02):** phần `/api/hf/*` bên dưới mô tả compatibility routes cũ. Backend Hono hiện còn phục vụ `/api/v1/*`, SSE và MCP. MCP có entry `/api/mcp`, exact revision `/api/mcp/<revision>` và moving alias `/api/mcp/latest`; tất cả `/api/mcp*` bắt buộc bearer credential, chạy sau Host/CORS perimeter và không chấp nhận browser session cookie thay thế.

MCP HTTP dùng cùng Tool Registry **34 production tools** với stdio; schema được sinh từ catalogue chung, không duy trì một danh sách transport riêng. Exact revisions hiện support: modern `2026-07-28` và legacy `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`. Unknown pin trả MCP error `-32022` kèm allowlist; không header giữ legacy default. Credential chỉ được lưu dạng hash, có issue/list/rotate/revoke qua trusted CLI và `credentialId` được audit mà không log bearer plaintext.

Tất cả route nằm dưới `/api/hf/`, đều `export const dynamic = "force-dynamic"`.

Các compatibility route `/api/hf/*` không có versioning riêng. Nhận định “không có auth” không áp dụng cho `/api/mcp*`; MCP luôn fail-closed nếu thiếu verifier/credential.

Tổng: **6 route**, **9 method**.

---

## 1. `GET /api/hf/runtime`

Trả script runtime HyperFrames.

| | |
|---|---|
| Params | không |
| 200 | `text/javascript; charset=utf-8`, body = `getHyperframeRuntimeScript()` |
| Headers | `cache-control: no-store` |
| Lỗi | không có nhánh lỗi |

---

## 2. `GET /api/hf/{slug}/preview`

Tài liệu HTML mà `<hyperframes-player src>` load.

| | |
|---|---|
| 200 | `text/html; charset=utf-8` — composition đã inject runtime + preview settings (`root: true`) |
| 404 | `text/plain` `"composition not found"` — project không tồn tại hoặc thiếu `index.html` |
| Headers | `cache-control: no-store` |

Client dùng query `?r=<revision>` chỉ để **cache-bust / remount**, server không đọc nó.

---

## 3. `GET /api/hf/{slug}/files/{...path}`

Asset tĩnh trong project.

| | |
|---|---|
| Path param | `path[]` — segment join bằng `/`, resolve trong project dir |
| 200 | content-type từ `getMimeType()`, body raw (string hoặc `Uint8Array`) |
| 404 | `text/plain` `"not found"` — project không tồn tại, path thoát khỏi project, không tồn tại, hoặc không phải file |
| Headers | `cache-control: no-store` |

Không hỗ trợ Range. Không inject preview settings (có chủ ý — xem [04](04-feature-preview-player.md) F-4.3).

---

## 4. `GET /api/hf/{slug}/source?path={path}`

Đọc một file text để mở trong editor.

**Request:** query `path` (bắt buộc, đường dẫn relative project root).

**200:**
```json
{ "file": {
    "path": "compositions/intro.html",
    "code": "<!doctype html>…",
    "foldableLines": [3, 7, 12],
    "saved": true,
    "version": "1m8k2p9-1a4" } }
```

**Lỗi:**
| Status | Body | Khi nào |
|---|---|---|
| 400 | `{"error":"path is required"}` | thiếu query `path` |
| 404 | `{"error":"file is not editable"}` | project không có, path thoát, file không tồn tại, không phải file, **hoặc đuôi ngoài whitelist** |

Whitelist đuôi: `html css js mjs ts json md txt py svg`.

---

## 5. `PUT /api/hf/{slug}/source`

Lưu file đã sửa.

**Request:**
```json
{ "path": "index.html",
  "code": "…",
  "baseVersion": "1m8k2p9-1a4" }   // tuỳ chọn; bỏ = force write
```

**200:** `{ "ok": true, "file": { …SourceFile mới… } }`

**Lỗi:**
| Status | Body | Khi nào |
|---|---|---|
| 400 | `{"error":"invalid JSON body"}` | body không parse được |
| 400 | `{"error":"path and code are required"}` | thiếu `path`, hoặc `code` không phải string |
| 413 | `{"error":"file is larger than 2 MB"}` | `code.length > 2*1024*1024` |
| 404 | `{"error":"file is not editable"}` | như GET |
| **409** | `{"error":"file changed on disk since you opened it — reload before saving"}` | `baseVersion !== fileVersion(target)` |
| 500 | `{"error":"write succeeded but the file could not be re-read"}` | ghi xong nhưng đọc lại thất bại |

---

## 6. `GET /api/hf/{slug}/preview-settings`

**200:** `{ "settings": { …PreviewSettings đã normalize… } }`

Project không tồn tại → vẫn trả `200` với `DEFAULT_PREVIEW_SETTINGS` (`normalizePreviewSettings(null)`). **Không có nhánh 404** — hành vi khác các route còn lại.

---

## 7. `PATCH /api/hf/{slug}/preview-settings`

Patch **theo section** — section không gửi thì giữ nguyên.

**Request** (mọi field tuỳ chọn):
```json
{ "tone":      { "enabled": true, "mainLight": "#ff8a3d" },
  "theme":     { "variables": { "--primary": "#00ffcc" } },
  "bgm":       { "volume": 0.45 },
  "subtitles": { "fontSize": 96 },
  "scenes":    { "captions": { "hidden": true, "transitionSound": "retro", "revealSound": "chime" } } }
```

**200:** `{ "ok": true, "settings": { …bản đã merge + normalize… } }`

**Lỗi:**
| Status | Body |
|---|---|
| 400 | `{"error":"invalid JSON body"}` |
| 404 | `{"error":"project not found"}` |

Ghi chú: **không validate schema đầu vào** — giá trị sai (`fontSize: "big"`, `mainLight: "red"`) không bị từ chối, chỉ bị `normalizePreviewSettings` thay bằng default/clamp. Response trả về giá trị thực đã lưu, nên client tự thấy khác biệt.

Với `scenes`: patch merge **cả object scene**, không merge từng field — client (`patchScene`) tự đọc giá trị hiện tại rồi spread trước khi gửi.

---

## 8. `POST /api/hf/{slug}/preview-settings`

Upload nhạc nền (multipart).

**Request:** `multipart/form-data`, field `file`.

**200:** `{ "ok": true, "settings": { …settings mới, bgm.enabled = true, bgm.track set… } }`

**Lỗi:**
| Status | Body | Khi nào |
|---|---|---|
| 400 | `{"error":"no file uploaded"}` | `formData()` fail hoặc field `file` không phải `File` |
| 413 | `{"error":"file is larger than 20 MB"}` | `file.size > 20*1024*1024` |
| 404 | `{"error":"project not found"}` | project không có, hoặc tên file rỗng sau sanitize |

Lưu tại `preview-assets/bgm/<sanitized-name>` — **ghi đè im lặng** nếu trùng tên.

---

## 9. `PATCH /api/hf/{slug}/scene`

Endpoint đa năng cho mọi thao tác scene. Phân nhánh theo `action`.

**Lỗi chung:**
| Status | Body |
|---|---|
| 400 | `{"error":"invalid JSON body"}` |
| 400 | `{"error":"unknown action"}` |

### 9a. `action: "timing"`

```json
{ "action": "timing", "sceneId": "graphics",
  "start": 2.5, "duration": 6, "trackIndex": 3 }
```
`start`/`duration`/`trackIndex` đều tuỳ chọn (chỉ field nào gửi mới đổi).

- **200:** `{ "ok": true }` ← **không trả scene mới**, client phải refresh cả trang.
- **400:** `{"error":"project not found"}` | `{"error":"composition not found"}` | `{"error":"scene <id> not found"}` | message từ `composition.can()` | `{"error":"edit rejected by the SDK"}`

### 9b. `action: "script"`

```json
{ "action": "script", "sceneId": "intro",
  "file": "compositions/intro.html",
  "elementId": "hf-a1b2",
  "text": "Ship faster, meet less" }
```
- **200:** `{ "ok": true, "narration": { …Narration mới… } | null }` ← ghi text **và** regenerate narration.
- **400:** `{"error":"file not found"}` | message từ `can()` | `{"error":"edit rejected by the SDK"}`

Lưu ý: `file` do **client** quyết định (lấy từ `SceneScriptLine.file`). Server không kiểm tra file đó có thuộc scene `sceneId` không. `openProjectFile` dùng `join(paths.dir, file)` — **không đi qua `resolveWithinProject`** ⇒ về lý thuyết `file: "../../etc/passwd"` sẽ resolve ra ngoài project. Thực tế `openComposition` sẽ fail khi parse, và `existsSync` chặn phần lớn, nhưng đây là **lỗ hổng cần bịt** ở backend mới.

### 9c. `action: "tts"`

```json
{ "action": "tts", "sceneId": "scene-1", "text": "Ship faster, meet less" }
```
- **200:** `{ "ok": true, "narration": { … } }`
- **404:** `{"error":"project not found"}`

Không validate `text` rỗng.

### 9d. `action: "generate"`

```json
{ "action": "generate", "prompt": "Team retro cadence" }
```
- **200:**
```json
{ "ok": true, "sceneId": "scene-2",
  "transcript": [ {"kind":"command","text":"codex"}, … ] }
```
- **400:** `{"error":"prompt is empty"}` | `{"error":"project not found"}` | `{"error":"composition not found"}` | `{"error":"root composition not found"}` | message `can()` | `{"error":"insert rejected by the SDK"}`

---

## v1 — Background music (2026-08-12)

Các endpoint dưới đây dùng cùng Core use case với MCP `search_bgm`, `list_bgm_beds` và `install_bgm`.

### `GET /api/v1/bgm/search?mood=<text>&limit=<1..12>`

- Query bắt buộc `mood`, `limit` mặc định 8.
- Tìm đồng thời qua Openverse và ccMixter; adapter mở rộng một taxonomy mood nhỏ (gồm các từ Việt phổ biến) sang tag tìm kiếm tiếng Anh rồi interleave kết quả để không lệ thuộc một catalog.
- Chỉ trả track Public Domain, CC0 hoặc CC BY; CC BY bắt buộc holder + URL HTTP(S). Mỗi track có `providerId`, `trackId`, `sourceUrl`, `attribution`, duration, extension và tags, nhưng không lộ download URL cho agent.
- Response có `providers[]` với `ok | empty | unavailable` và message fail-soft, cộng `offlineFallbackAvailable: true`. Mọi provider cùng lỗi vẫn trả `200` với `tracks: []`; client chuyển sang `GET /api/v1/bgm`.
- Request outbound chỉ HTTPS, timeout 8 giây, chặn địa chỉ private/link-local/loopback ở mỗi redirect và pin DNS lúc connect. JSON tối đa 1 MiB; audio tối đa 20 MiB và phải khớp content type + magic bytes.

### `GET /api/v1/bgm`

Trả năm bed synth, shipped tracks và thư viện máy. Đây là đường offline; availability và licence được báo theo dữ liệu thật, không tự gắn nhãn “royalty-free”.

### `POST /api/v1/projects/:id/bgm`

Body phải có đúng một selector: `bedId`, `trackId`, `libraryEntryId` hoặc `providerTrack`, cùng `expectedRevision`. Với remote selector:

```json
{
  "providerTrack": { "providerId": "openverse", "trackId": "<exact-id>" },
  "expectedRevision": 4,
  "volume": 0.12,
  "loop": true
}
```

Server tải lại và revalidate **đúng** identity đó, không tự đổi track; đóng băng bytes + licence + attribution + source provenance trong machine library, rồi ghi asset và preview settings bằng một mutation có optimistic concurrency. Render sau đó chỉ dùng asset local.

MCP là surface ưu tiên cho agent: `search_bgm` có `openWorldHint: true`; `install_bgm` cũng open-world khi dùng `providerTrack`. REST phục vụ studio/client nhưng giữ cùng schema và use case.

---

## v1 — Narration / TTS (2026-08-03)

Hai endpoint mới trên `packages/server`, **không** thuộc API mock `/api/hf/*` ở trên.
Contract nguồn: `packages/contracts/src/tts.ts`. Cùng use case được expose qua MCP
(`list_tts_voices`, `start_tts`, `get_job_status`) — D1.

### `GET /api/v1/projects/:id/tts/voices`

- **200:** `{ "providers": [ { "id", "label", "available", "unavailableReason", "voices": [ { "id", "providerId", "label", "language", "modelId", "supportsEmotionCues", "computeDevices", "recommended" } ], "allowsCustomVoiceId", "customVoiceDefaults" } ] }`
- **404** `project_not_found`

Provider không chạy được **vẫn có trong danh sách** với `available: false` và
`unavailableReason` ∈ `credential_missing | sidecar_missing | audio_toolchain_missing`
— UI nói được phải làm gì thay vì im lặng bớt lựa chọn. `computeDevices` chỉ chứa
`"gpu"` khi máy có GPU dùng được thật.

`recommended: true` là shortlist VidCom đề xuất, **không** phải đánh giá chất lượng
— `false` nghĩa là "không nằm trong shortlist", không phải "nên tránh". Voice
recommended được **xếp trước** trong mảng, nên UI render tuần tự là đã đúng thứ tự.

| Provider | Recommended |
|---|---|
| `vieneu` | `vieneu-v3-doan-trang`, `vieneu-v3-minh-duc`, `vieneu-v3-ngoc-linh`, `vieneu-v3-pham-tuyen` — nhưng **chỉ khi** engine đã cài thật sự có preset đó; catalog vẫn do `list_preset_voices()` của engine quyết |
| `elevenlabs` | cả 4 stock voice, vì danh sách đó tự nó đã là shortlist. Cloned voice → `false` |

### `POST /api/v1/projects/:id/narration/synthesize`

```json
{ "sceneIds": ["scene-1"], "providerId": "vieneu", "voiceId": "vieneu-v3-pham-tuyen",
  "modelId": null, "ratePercent": 0, "computeDevice": "cpu" }
```

- **202:** `{ "jobId": "job_…", "status": "queued" }` — poll `GET /api/v1/jobs/:jobId`
- Header `Idempotency-Key` tuỳ chọn: trim, rỗng/whitespace coi như không gửi, tối đa 255 ký tự
- **400** `schema_invalid` (kèm `field`) — body sai, `ratePercent` ngoài `-10..20`, `sceneIds` rỗng hoặc > 50, `computeDevice` không thuộc `cpu|gpu`, `Idempotency-Key` quá dài
- **404** `project_not_found` | `not_found` (scene chưa có narration text)
- **409** `idempotency_key_reused`
- **422** `tts_voice_not_supported` (`field: voiceId|modelId`) | `tts_credential_missing` | `scene_not_found` | `duplicate_mutation_target`
- **503** `tts_provider_unavailable` (`field: providerId|computeDevice`, hoặc không field khi thiếu FFmpeg)

**Validate hết trước khi enqueue.** Provider/voice/device/scene/narration-text đều
được kiểm ở route (và ở tool MCP) — job không thể thành công thì không được vào
queue, và lỗi phải chỉ đúng field thay vì hiện ra sau vài phút dưới dạng job failed.

### Job `tts`

`GET /api/v1/jobs/:jobId` trả `error.code` là **mã TTS thật** (`tts_quota_exceeded`,
`tts_credential_missing`, …), không phải `internal`. Job này `idempotent: false`,
`maxAttempts: 1` — xem [07-feature-narration-tts](07-feature-narration-tts.md#cost-và-idempotency).

`POST /api/v1/jobs/:jobId/cancel` dừng engine thật (kill cả cây process) và **không
publish gì** nếu batch chưa ghi.

---

## Tổng hợp vấn đề của API hiện tại (cần khắc phục khi viết lại)

| # | Vấn đề | Ảnh hưởng |
|---|---|---|
| 1 | Không auth / không phân quyền | Ai truy cập được URL đều đọc/ghi được mọi project |
| 2 | Route `/files` đọc được **mọi** file trong project | Rò `AGENTS.md`, `package.json`, secret nếu có |
| 3 | `action:"script"` dùng `join()` không qua `resolveWithinProject` | Path traversal tiềm ẩn |
| 4 | Chỉ `PUT /source` có optimistic concurrency | `scene`/`preview-settings` ghi đè im lặng |
| 5 | Response ghi trả `{ok:true}` thay vì entity mới | Client buộc `router.refresh()` toàn trang sau mỗi edit |
| 6 | Không có schema validation đầu vào | Giá trị sai bị âm thầm thay bằng default |
| 7 | Endpoint đa năng `PATCH /scene` với 4 action | Khó version, khó phân quyền, khó test |
| 8 | Không có mã lỗi máy đọc được (chỉ `error: string`) | UI không gắn lỗi vào field |
| 9 | Ghi file không atomic | Crash giữa lúc ghi làm hỏng composition |
| 10 | `cache-control: no-store` cho mọi thứ kể cả runtime/asset | Băng thông + độ trễ |
| 11 | Không có endpoint: create project, delete/rename file, delete scene, render, snapshot, lint, registry | Xem [13](13-backend-requirements.md) |
| 12 | `GET /preview-settings` không 404 khi project không tồn tại | Không nhất quán |
