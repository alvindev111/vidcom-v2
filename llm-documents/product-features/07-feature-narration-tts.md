# 07 — Narration / TTS

File liên quan: [tts.server.ts](../../src/lib/hyperframes/tts.server.ts), [scene-narration.tsx](../../src/components/studio/scene-narration.tsx), [api/hf/[slug]/scene/route.ts](../../src/app/api/hf/[slug]/scene/route.ts)

---

## F-7.1 — Lưu trữ narration

**Là gì:** Mỗi scene có tối đa một bản ghi narration, lưu thành sidecar JSON cạnh composition.

**Logic hiện tại:**
- Đường dẫn: `<project>/narration/<sceneId>.json`
- Audio dự kiến: `<project>/narration/<sceneId>.wav` (đường dẫn tương đối lưu trong `audioPath`)
- Voice **hard-code**: `DEFAULT_VOICE = "af_heart"`
- Nội dung file (ví dụ thật, `projects/warm-grain/narration/scene-1.json`):
```json
{
  "sceneId": "scene-1",
  "text": "Ship faster, meet less",
  "voice": "af_heart",
  "status": "mock",
  "audioPath": "narration/scene-1.wav",
  "command": "hyperframes tts --text \"Ship faster, meet less\" --voice af_heart -o narration/scene-1.wav",
  "revision": 6,
  "updatedAt": "2026-07-31T11:23:53.012Z"
}
```

**Trạng thái:** THẬT (ghi file thật).

---

## F-7.2 — Đọc narration + xác định status

**Logic hiện tại** (`readNarration` — [tts.server.ts:33](../../src/lib/hyperframes/tts.server.ts#L33)):
1. Không có sidecar → `null`.
2. Parse JSON; parse lỗi → `null` (fail mềm, không throw).
3. **`status` bị override lúc đọc**:
   ```js
   status: existsSync(join(dir, stored.audioPath)) ? "generated" : "mock"
   ```
   Tức: file wav xuất hiện trên đĩa (do chạy `hyperframes tts` thật ngoài app) **thắng** giá trị lưu trong record. Đây là cách app "phát hiện" audio thật mà không cần biết ai tạo nó.

**Trạng thái:** THẬT.

---

## F-7.3 — Regenerate narration

**Là gì:** Ghi lại job TTS cho một scene.

**Logic hiện tại** (`regenerateNarration` — [tts.server.ts:55](../../src/lib/hyperframes/tts.server.ts#L55)):
1. Đọc bản cũ để lấy `revision`.
2. Tạo record mới: `status: "mock"` **luôn luôn**, `revision: (previous?.revision ?? 0) + 1`, `updatedAt: new Date().toISOString()`.
3. `command` = `hyperframes tts --text "<escaped>" --voice af_heart -o narration/<sceneId>.wav` (escape `"` thành `\"`).
4. `mkdirSync(narration/, {recursive:true})` rồi ghi JSON (pretty 2 space + newline cuối).
5. Trả record.

**Ai gọi nó:**
| Nguồn | Text dùng |
|---|---|
| `PATCH /scene` action `tts` | text client gửi lên |
| `updateSceneScriptLine()` — sau khi sửa 1 dòng script | text **của dòng vừa sửa** |
| `createScene()` — khi tạo scene mới | `title` (chính là prompt người dùng gõ) |

**Trạng thái:** MOCK — **không có audio nào được tạo ra**. Comment [tts.server.ts:12](../../src/lib/hyperframes/tts.server.ts#L12): "`hyperframes tts` (Kokoro-82M) là generator thật, nhưng cần `pip install kokoro-onnx soundfile` — không có ở đây, nên regenerate chỉ ghi lại job với `status: "mock"` và đúng lệnh sẽ render wav. Không có gì trong UI khẳng định audio tồn tại đến khi wav thật nằm trên đĩa."

---

## F-7.4 — UI narration

**Là gì:** Section `Narration (TTS)` trong Scene detail.

**Logic hiện tại** ([scene-narration.tsx](../../src/components/studio/scene-narration.tsx)):
- `text = narration?.text ?? scriptText` với `scriptText = scene.script[0]?.text ?? null` — **chỉ lấy dòng script ĐẦU TIÊN** làm text mặc định.
- Không có text nào → `No script in this scene, so there is nothing to voice yet.`
- Badge trạng thái:
  - `narration.status === "generated"` → `audio ready` (màu accent)
  - `narration` tồn tại nhưng mock → `mock · no audio` (xám)
  - `narration === null` → `not generated`
- Bảng meta (mono, chỉ khi có narration): `voice`, `file`, `run` (lệnh CLI đầy đủ), `revision`.
- Nút `Regenerate TTS` → `PATCH /scene {action:"tts", sceneId, text}`.

**Trạng thái:** THẬT ở phần UI/ghi record, MOCK ở phần audio.

---

## Vấn đề đã biết

1. **Chỉ lấy `script[0]`** làm narration mặc định. Scene có 5 dòng thoại thì 4 dòng còn lại bị bỏ.
2. **Sửa bất kỳ dòng script nào cũng ghi narration bằng text của dòng đó** ([sdk.server.ts:157](../../src/lib/hyperframes/sdk.server.ts#L157)) → sửa dòng thứ 3 làm narration trở thành nội dung dòng 3, ghi đè narration cũ. Đây là hành vi sai về nghiệp vụ.
3. **Voice cố định** `af_heart`, không đổi được từ UI.
4. **Không có phát thử audio** — kể cả khi wav tồn tại, UI không có player để nghe.
5. **Không có timing** cho narration: không biết audio bắt đầu ở giây nào, dài bao lâu, có khớp `scene.duration` không.
6. `wav` không được mount vào composition → **narration không phát khi preview**, cũng không có mặt trong render.
7. `revision` chỉ để đếm, không dùng để invalidate wav cũ (wav là 1 file cố định `<sceneId>.wav`, revision 6 và revision 1 dùng cùng tên).

---

## Kỳ vọng backend

### Bắt buộc
- **Chạy TTS thật.** Hai lựa chọn:
  - (a) Gọi `hyperframes tts` CLI (Kokoro-82M local, cần Python deps) — như `command` đang mô tả.
  - (b) Gọi TTS service (ElevenLabs / OpenAI / Azure / self-host) và ghi wav vào `narration/`.
- Là **job async**: `POST /projects/:slug/narration` → `{ jobId }`, `GET /jobs/:id` → `{ status: queued|running|done|failed, progress, audioPath?, error? }`. TTS mất giây tới chục giây, không nên block request.
- Trả **duration thật** của audio sau khi render → dùng để:
  - Cảnh báo khi `audioDuration > scene.duration`.
  - Đề xuất tự nới `data-duration` của scene cho khớp lời thoại.
- Mount audio vào composition: sinh `<audio class="clip" src="narration/<id>.wav" data-start="<sceneStart>" data-volume="…">` để runtime phát theo transport.

### Nên có
- Chọn voice từ danh sách (`GET /tts/voices`), lưu per-scene và có default per-project.
- Tham số: speed, pitch, emphasis, pause.
- Narration nhiều đoạn per scene (mỗi dòng script một đoạn) với timing riêng, thay vì một text duy nhất.
- **Word-level timestamps** → dùng để sinh caption đồng bộ (đang có `subtitles` settings nhưng không có nguồn timing nào).
- Cache theo hash `(text, voice, params)` → không render lại nội dung không đổi.
- Tên file có revision/hash (`narration/<id>-<hash>.wav`) để tránh cache browser dính bản cũ.
- Xoá narration.
- Nút preview audio trong UI.
- Tách rời: sửa script **không** tự động regenerate TTS, thay vào đó đánh dấu narration là `stale` và để người dùng bấm regenerate (hoặc bật autoregenerate).
