# VieNeu-TTS sidecar

Bản chạy local của [VieNeu-TTS v3 Turbo](https://github.com/pnnbao97/VieNeu-TTS). Đây là **asset**, không phải code TypeScript — `packages/adapter` nhúng nó và ghi ra đĩa, không import.

## Cài đặt

```bash
python -m venv .venv
# Windows
.venv\Scripts\pip install -r packages/adapter/sidecars/vieneu/requirements.txt
# macOS / Linux
.venv/bin/pip install -r packages/adapter/sidecars/vieneu/requirements.txt
```

Sau đó trỏ VidCom tới interpreter đó trong `~/.vidcom/setting.json`:

```json
{
  "tts": {
    "vieneu": {
      "command": [
        "C:/WorkHere/Coding/vidcom-v2/.venv/Scripts/python.exe",
        "C:/WorkHere/Coding/vidcom-v2/packages/adapter/sidecars/vieneu/worker.py"
      ],
      "modelRevision": null
    }
  }
}
```

Không khai `command` thì VidCom dùng `python`/`python3` trên PATH với worker đã ship — thường không phải venv có torch, nên hãy khai.

## Chạy thật để kiểm

Test bình thường dùng `ProcessPort` giả — **giả process không bắt được lời gọi SDK sai**, và đó đúng là lỗi đã lọt lần đầu viết provider này. Muốn kiểm thật:

```bash
# 1. cài engine (torch-free, ONNX)
python -m venv .venv
.venv/Scripts/pip install -r packages/adapter/sidecars/vieneu/requirements.txt   # Windows
# .venv/bin/pip install -r ...                                                    # macOS/Linux

# 2. chạy — model tải một lần vào cache tạm, hoặc trỏ VIDCOM_VIENEU_MODEL_CACHE để tái dùng
VIDCOM_VIENEU_REAL=1 \
VIDCOM_VIENEU_COMMAND='["/abs/path/.venv/bin/python","/abs/path/packages/adapter/sidecars/vieneu/worker.py"]' \
VIDCOM_VIENEU_MODEL_CACHE="$HOME/.vidcom/models" \
bun run test:vieneu-real
```

Không đặt `VIDCOM_VIENEU_COMMAND` thì nó lấy `tts.vieneu.command` trong `~/.vidcom/setting.json`, rồi mới đến worker mặc định. Không đặt `VIDCOM_VIENEU_REAL=1` thì cả file bị skip kèm thông báo.

Nó kiểm: catalog voice lấy từ engine thật; đọc một câu tiếng Việt rồi chuẩn hoá ra WAV 44.1k mono với duration hợp lý và `modelRevision` truy được; và xin GPU trên máy CPU-only phải **lỗi** chứ không âm thầm chạy CPU.

Cần **truy cập được huggingface.co**. Mạng có TLS-intercept sẽ làm `huggingface_hub` hỏng ở bước tải — trỏ `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE` tới CA root của tổ chức, hoặc dùng `HF_ENDPOINT` mirror.

## Voice

Catalog do engine quyết: `--probe` gọi `list_preset_voices()` và VidCom suy id từ tên
(`Phạm Tuyên` → `vieneu-v3-pham-tuyen`). Không có danh sách hardcode nào trong TypeScript,
nên upstream thêm giọng là tự có, và VidCom không thể mời một giọng mà engine sẽ từ chối.

Bốn giọng được VidCom đề xuất (`recommended: true`, xếp đầu catalog):
`vieneu-v3-doan-trang`, `vieneu-v3-minh-duc`, `vieneu-v3-ngoc-linh`, `vieneu-v3-pham-tuyen`.
Bản engine đang cài không có giọng nào trong đó thì giọng đó vắng mặt — shortlist không ghi đè probe.

## Model weights nằm ở đâu

**Không nằm trong repo.** Sidecar bắt buộc phải nhận `HF_HOME` là một đường dẫn tuyệt đối và từ chối chạy nếu thiếu — VidCom truyền `<app-data>/models`. Từ đó nó pin luôn `HF_HUB_CACHE` và `TORCH_HOME` vào cùng gốc, nên không thư viện nào rơi về mặc định `~/.cache` hay thư mục làm việc hiện tại. Checkpoint v3 Turbo nặng vài trăm MB tới vài GB; để nó rơi vào checkout nghĩa là mỗi lần clone kéo theo nó.

Xoá cache = xoá `<app-data>/models`. Lần chạy sau sẽ tải lại.

Muốn dồn hết vào một chỗ thì khai `appDataRoot` trong `~/.vidcom/setting.json` (hoặc đặt `VIDCOM_APP_DATA`) — sqlite, model, backup đi theo.

## CPU và GPU

CPU là mặc định và luôn khả dụng. GPU chỉ xuất hiện trong catalog voice sau khi `worker.py --probe` **cấp phát thật** được một tensor trên CUDA — driver có mặt là chưa đủ, vì một driver không dùng được sẽ chỉ lộ ra khi batch đầu tiên hỏng.

`requirements.txt` cài bản **torch-free** (ONNX Runtime). Muốn mở GPU thì cài thêm extra `legacy` — `pip install "vieneu[legacy]"` — nó kéo torch/torchaudio/transformers, rồi khởi động lại VidCom (catalog được cache trong một vòng đời process).

> Upstream 3.2.4 chỉ publish hai extra: `legacy` và `pdf`. **Không có `vieneu[gpu]`** — gõ vậy pip chỉ cảnh báo "does not provide the extra" rồi cài bản base CPU, tức đúng kiểu âm thầm rơi về CPU mà chính sách device này muốn chặn.

Xin GPU trên máy không có → job hỏng kèm thông báo rõ, **không** âm thầm chạy CPU. Đây là chủ ý: một job chậm gấp mười lần mà không ai biết vì sao là thứ khó chẩn đoán hơn nhiều so với một lỗi thẳng thắn.

## Giao thức

```
worker.py --probe
  → stdout: {"schemaVersion":1,"ready":bool,"gpu":bool}

worker.py --request <in.json> --response <out.json>
  in:  {"schemaVersion":1,"modelId":"vieneu-v3-turbo","device":"cpu"|"gpu",
        "voice":"<tên speaker>","outputDir":"<scratch>","cues":[{"id","text"}]}
  out: {"schemaVersion":1,"provider":"vieneu","modelId":"vieneu-v3-turbo",
        "effectiveDevice":"cpu"|"gpu","assets":[{"cueId","path"}]}
```

Request/response đi qua **file**, không qua stdout: `vidcom mcp` dùng chung stdout với luồng giao thức MCP, một dòng print lạc từ dependency Python là đủ làm hỏng nó. Ngoài `--probe`, mọi thứ sidecar nói đều ra stderr.

## Ghi chú cho Giai đoạn 4

Khi đóng gói Node SEA, thư mục này phải được **giải nén ra `nativeDependenciesRoot`** rồi mới chạy, giống `packages/agent-kit`. Suy đường dẫn từ source checkout sẽ hỏng trên artifact.
