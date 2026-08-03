# 07 — Narration / TTS

File liên quan: [tts.server.ts](../../src/lib/hyperframes/tts.server.ts), [scene-narration.tsx](../../src/components/studio/scene-narration.tsx), [api/hf/[slug]/scene/route.ts](../../src/app/api/hf/[slug]/scene/route.ts)

> **Cập nhật 2026-08-03 — TTS thật đã có.** Phần "Logic hiện tại" bên dưới mô tả
> đường mock cũ (`src/lib/hyperframes/tts.server.ts`), vẫn còn cho scene mới tạo.
> Đường sinh audio thật nằm ở [§ TTS thật](#tts-thật-2026-08-03) cuối tài liệu.

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

---

## TTS thật (2026-08-03)

Đã làm được phần **Bắt buộc** ở trên, trừ mục "chọn voice từ UI" (vẫn là API-only).

### Kiến trúc

```
HTTP  POST /api/v1/projects/:id/narration/synthesize ─┐
MCP   start_tts ──────────────────────────────────────┴─▶ job "tts"
                                                            │
                        synthesizeNarration() ◀─────────────┘
                                │
                        TtsPort.synthesize()  →  TtsRegistry
                                │                    ├── ElevenLabsTtsProvider (cloud, có word timing)
                                │                    └── VieNeuTtsProvider (local, sidecar Python)
                                │                         └── FFmpeg normalize → WAV 44.1k mono
                                ▼
                        WriteAuthority.mutateComposite()
                        → narration/<sceneId>.wav + narration/<sceneId>.json (một revision)
```

`TtsPort` **trả bytes**, không tự ghi vào workspace — `WriteAuthority` vẫn là cửa duy nhất chạm đĩa của project (03-architecture-ddd §3.5).

### Sidecar JSON sau khi sinh thật

`status` vẫn được suy ra lúc đọc từ sự tồn tại của wav (F-7.2 không đổi). Thêm ba field:

```json
{
  "sceneId": "scene-1",
  "text": "Xin chào các bạn",
  "voice": "vieneu-v3-pham-tuyen",
  "status": "generated",
  "audioPath": "narration/scene-1.wav",
  "command": "vidcom tts --scene scene-1 --provider vieneu --voice vieneu-v3-pham-tuyen --rate 0",
  "revision": 7,
  "updatedAt": "2026-08-03T10:00:00.000Z",
  "staleSince": null,
  "provider": "vieneu",
  "durationSeconds": 4.52,
  "words": [{ "text": "Xin", "startSeconds": 0, "endSeconds": 0.31 }],
  "wordTimingSource": "estimated",
  "engine": { "modelId": "vieneu-v3-turbo", "modelRevision": "…", "effectiveDevice": "cpu", "sampleRate": 44100 }
}
```

`engine` là provenance — model, revision, device, rate thực tế.

### Word timing — highlight transcript từng từ

`words` **luôn có** khi cue có từ để đọc, với mọi engine. `wordTimingSource` nói nó đến từ đâu, và consumer buộc phải phân biệt được hai loại:

| `wordTimingSource` | Nguồn | Dùng được cho |
|---|---|---|
| `engine` | Alignment engine đo trên audio thật (ElevenLabs trả character alignment) | Highlight từng từ đúng tới âm tiết; alignment thật |
| `estimated` | Chia thời lượng cue theo **số ký tự** từng từ (VieNeu không có alignment) | Highlight chạy theo lời; **không** phải alignment — nó lệch dần trong một câu |

Chia theo số ký tự chứ không chia đều: "chuyển" đọc lâu hơn "và" thấy rõ, chia đều thì tới cuối câu dài highlight đã đi trước giọng. Từ cuối lấy đúng mốc `endSeconds` của cue nên không hở/không tràn ở biên — đúng chỗ dễ bị bắt lỗi nhất.

Cue điều khiển trong ngoặc (`[ngắt vừa]`, `[cười]`) **không** được tính timing: chúng không được đọc ra.

Timing với engine trả theo **cụm** cũng được tách thành từng từ, nên consumer chỉ phải xử lý một contract.

`checkWordTimings()` chặn trước khi publish: đúng thứ tự, không chồng nhau, không vượt thời lượng audio (dung sai 1ms cho sai số làm tròn). Caption dựng từ boundary sai lệch trôi rất rõ mà nhìn triệu chứng thì cực khó ra nguyên nhân.

`words` đi tới client qua `SceneDto.narration` trong studio snapshot sẵn có — không cần endpoint mới.

**Chưa có:** phần *render* highlight (nhóm từ thành cụm caption, đánh dấu từ đang đọc). Đó là Giai đoạn 5; dữ liệu thì đã đủ và đã được validate.

### Mount vào preview/render — đã xong

`buildCompositionDocument()` (đường dựng document **duy nhất**, P3) gọi `readNarrationClips()` rồi
`buildNarrationHtml()` sinh `<audio class="clip hf-narration" data-start="…" data-duration="…">`,
cùng cơ chế `buildBgmHtml()` đã dùng. Start time lấy từ `data-*` của document, không lấy từ sidecar (P1).
Chỉ inject ở root document. Điều này giải quyết **Vấn đề đã biết #6**.

### Cấu hình

`~/.vidcom/setting.json` (xem [steering/07-data-and-storage](../steering/07-data-and-storage.md#0-cấu-hình-người-dùng--vidcomsettingjson)):

```json
{
  "tts": {
    "defaultProviderId": "vieneu",
    "defaultVoiceId": "vieneu-v3-pham-tuyen",
    "defaultRatePercent": 0,
    "defaultComputeDevice": "cpu",
    "elevenlabs": { "apiKey": "sk-…" },
    "vieneu": {
      "command": ["C:/path/.venv/Scripts/python.exe", "C:/path/sidecars/vieneu/worker.py"],
      "modelRevision": null
    }
  }
}
```

`ELEVENLABS_API_KEY` trong env thắng `tts.elevenlabs.apiKey`. `tts.vieneu.modelRevision` được truyền xuống sidecar thành `VIDCOM_VIENEU_REVISION` để pin weights.

### Voice recommended

`TtsVoiceDto.recommended` là shortlist VidCom đề xuất, xếp trước trong catalog. Với VieNeu là 4 giọng:

```
vieneu-v3-doan-trang    Đoan Trang
vieneu-v3-minh-duc      Minh Đức
vieneu-v3-ngoc-linh     Ngọc Linh
vieneu-v3-pham-tuyen    Phạm Tuyên
```

Engine v3 Turbo ship 14 preset; đây là 4 cái được đưa lên đầu để lần narration đầu tiên là **một lựa chọn**, không phải một cuộc khảo sát. Quan trọng: id trong shortlist chỉ xuất hiện khi `list_preset_voices()` của engine **thật sự** báo giọng đó — VidCom không bao giờ tự dựng ra một voice mà engine sẽ từ chối. Cài bản engine không có một trong 4 giọng thì giọng đó đơn giản là vắng mặt.

### Chính sách CPU/GPU

- Enum device chỉ có `cpu | gpu`, **không có `auto`** — mặc định `cpu`.
- GPU chỉ xuất hiện trong catalog sau khi sidecar **cấp phát thật** được một tensor CUDA.
- Xin GPU trên máy không có → lỗi rõ ràng, **không** âm thầm chạy CPU.

### Cost và idempotency

Job `tts` **không idempotent, không retry** (`maxAttempts: 1`). Synthesis tính phí và output không byte-deterministic, nên requeue sau crash sẽ tính phí lần hai và commit revision thứ hai cho một yêu cầu duy nhất. Job hỏng thì đứng hỏng; người dùng quyết định có chi tiếp không.

### Còn thiếu

- UI chọn provider/voice (đợt này dừng ở API).
- Render caption/highlight từ `words` — Giai đoạn 5. Dữ liệu đã đủ.
- Vấn đề đã biết #1, #2, #3, #4, #7 vẫn còn. **#5 đã giải quyết một nửa**: giờ biết audio dài bao lâu (`durationSeconds`) và từng từ nằm ở giây nào; còn thiếu phần cảnh báo khi `durationSeconds > scene.duration`.
