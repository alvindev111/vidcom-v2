# 08 — Jobs & queue

## 1. Cái gì phải là job

Bất cứ thao tác nào **không** chắc chắn xong trong một HTTP request:

| Job | Thời lượng điển hình |
|---|---|
| `render` | phút |
| `snapshot` | giây |
| `tts` | giây → chục giây |
| `transcribe` | chục giây |
| `remove-background` | chục giây |
| `agent-session` | phút, có stream |
| `project-import` | giây |

MUST NOT chạy những thứ trên trong request handler. Không có job infrastructure thì phần lớn yêu cầu chức năng ở doc 13 không làm được.

## 2. Vòng đời

```
queued → running → succeeded
                 → partial
                 → failed
                 → cancelled
```

- `queued → running`: worker nhận job, ghi `startedAt`, `workerId`.
- Chỉ bốn trạng thái cuối là **terminal**. Không có state nào khác.
- `partial` là kết quả **thành công một phần có thể tiếp tục**: job sinh ra tập artifact mà một phần còn thiếu, và lần chạy sau chỉ cần bù phần thiếu. Dùng khi "tất cả hoặc không gì" sẽ vứt đi công đã làm được — ví dụ snapshot thiếu vài scene. `progress = 1`, `result` MUST nêu phần còn thiếu. MUST NOT giả `partial` thành `succeeded`: mọi thứ dẫn xuất từ nó sẽ tin là đã đủ.
- MUST NOT xoá job ngay khi xong — giữ để UI hiện lịch sử; dọn theo policy (§8).

## 3. Bản ghi job

```ts
interface Job {
  id: JobId;
  type: "render" | "snapshot" | "tts" | "transcribe" | "agent" | "import";
  projectId: ProjectId;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  input: unknown;              // đã validate theo schema của type
  progress: number;            // 0..1
  stage: string | null;        // "rendering frame 120/300"
  result: unknown | null;
  error: { code: string; message: string } | null;
  // Cảnh báo không làm job fail nhưng người dùng phải thấy. MUST tới client,
  // không chỉ nằm trong log — một cảnh báo không ai đọc biến "chấp nhận rủi ro
  // có thông báo" thành "bỏ qua rủi ro im lặng".
  warnings: { code: string; message: string }[] | null;
  // Job đã terminal nhưng tài nguyên ngoài (thư mục làm việc, process) chưa dọn
  // được. Recovery lúc khởi động thu hồi. MUST NOT chặn job terminal hoá.
  cleanupPending: boolean;
  attempt: number;
  idempotencyKey: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  workerId: string | null;
  heartbeatAt: string | null;
}
```

Lưu trong bảng `job` của `<app-data>/vidcom.sqlite`. MUST persist — job phải sống qua restart.

## 4. Nhận job

```
POST /api/v1/projects/:id/renders  →  202 { jobId, status: "queued" }
```

- MUST trả `202` ngay, không chờ.
- MUST validate input **trước** khi enqueue — job hỏng nằm trong queue là rác.
- MUST hỗ trợ `Idempotency-Key`: cùng key + cùng input → trả lại job cũ, không tạo job thứ hai.
- MCP: `start_render` trả `{ jobId, pollWith: "get_job_status" }`.

> **Job model của ta độc lập với protocol.** MCP `2026-07-28` có extension `io.modelcontextprotocol/tasks` làm đúng việc này (`tasks/get` polling, `tasks/update`). Adapter modern SHOULD map job sang extension đó khi host hỗ trợ, fallback về tool `get_job_status`; adapter legacy chỉ có tool. MUST NOT để hình dạng của tasks extension rò ngược vào Core. Xem [13-mcp-protocol-compatibility](13-mcp-protocol-compatibility.md) §3.3.

## 5. Progress

Hai đường, cùng một nguồn:

| Cách | Dùng khi |
|---|---|
| `GET /api/v1/jobs/:id` | poll, MCP `get_job_status` |
| SSE `job.progress` trên `/api/v1/events` | UI realtime |

Rule:

- `progress` là `0..1`, đơn điệu tăng. MUST NOT tụt lùi.
- `stage` là chuỗi cho người đọc, đổi được tự do.
- MUST throttle event — render 300 frame không được bắn 300 event.
- MUST NOT ước lượng progress bằng cách đoán. Không biết thì để `progress` đứng yên và cập nhật `stage`.

## 6. Cancel

```
POST /api/v1/jobs/:id/cancel  →  202
```

- Cancel là **hợp tác**: worker kiểm tra cancellation token ở các mốc an toàn.
- MUST dọn sạch output dở dang. Một file MP4 nửa chừng không được nằm trong `renders/`.
- MUST kill cả cây process, và MUST xác minh trước khi ghi `cancelled`.
- Job đã terminal → cancel là no-op, trả `200`, không lỗi.

### 6.1 Kill cây process — bảo đảm thật, không phải bảo đảm mong muốn

Bản trước viết "**MUST NOT để process con sống sót**". Đo thật cho thấy không nền tảng nào cung cấp được bảo đảm đó bằng công cụ thuần Node, nên luật ấy mô tả một điều hệ thống không làm được — loại luật nguy hiểm nhất trong một source of truth, vì mọi tầng trên sẽ tin nó. Thay bằng **bounded best-effort có khai báo**. Bằng chứng: [spike checklist-gate](../../spikes/phase-3-checklist-gate/README.md).

Ba pha, giống nhau trên mọi nền tảng; khác biệt OS chỉ nằm ở primitive enumerate/kill/probe:

1. **Capture** — trong lúc process chạy, tích luỹ PID cụ thể và các process group phân biệt. Thiếu pha này thì sau khi cha chết không còn cách nào tìm lại đám con.
2. **Kill** — mọi group đã ghi, rồi mọi PID đã ghi. Lệnh kill ngoài tiến trình MUST được **await**, không fire-and-forget.
3. **Verify** — probe **từng PID đã ghi trực tiếp**, lặp tới khi hai lượt liên tiếp rỗng.

Hai điều cấm, mỗi cái ứng một cách đo đã báo *thành công trong lúc đang rò*:

- **MUST NOT** suy survivor từ **quan hệ cha-con**. Con được reparent khi cha chết, nên duyệt theo cha-con trả về rỗng đúng lúc leak xảy ra.
- **MUST NOT** suy survivor từ **thành viên process group**. Process engine (đo được với `chrome-headless-shell`) tự tách sang group riêng, nên leak theo định nghĩa nằm ngoài tập được quét.

Hệ quả bắt buộc:

- Còn survivor sau khi cạn số lượt verify → lỗi `process_termination_unverified`. **MUST NOT** ghi `cancelled`.
- Proof MUST mang cờ cho biết nó **cạn kiệt hay bị chặn** (`exhaustive`). Process sinh sau lượt capture cuối nằm ngoài tập đã ghi; đó là lỗ đã biết, không được coi là đã đóng.
- Vì lỗ đó có thật, **containment là tầng phòng thủ thứ hai bắt buộc**: job spawn process con MUST chạy trong thư mục do hệ thống sở hữu, có marker, để recovery thu hồi được thứ lọt qua. MUST NOT coi containment là dư thừa khi verify đã sạch.
- Nền tảng không có nguồn quan hệ cha-con thì pha capture thoái hoá. Ở trạng thái đó luật là **trung thực, không phải zero survivor**: proof MUST NOT báo sạch trong lúc process còn sống. Rò mà khai báo thì containment thu hồi được; rò mà giấu thì không tầng nào đỡ.

## 7. Timeout, retry, recovery

| Cơ chế | Rule |
|---|---|
| Timeout | Mỗi type một timeout riêng, cấu hình được. Hết giờ → `failed` + kill process |
| Heartbeat | Worker cập nhật `heartbeatAt` định kỳ |
| Recovery | Lúc khởi động: job `running` mà `heartbeatAt` quá hạn → đánh `failed` (crash) hoặc requeue nếu type đó idempotent |
| Retry | Chỉ retry lỗi **transient** (mạng, tài nguyên tạm hết). MUST NOT retry lỗi input |
| Backoff | Exponential, có trần, có `maxAttempts` |

MUST NOT retry vô hạn. MUST NOT requeue job không idempotent.

## 8. Concurrency

- Giới hạn concurrency **theo type**, không phải giới hạn toàn cục — render nặng CPU, TTS nặng khác.
- Render MUST giới hạn chặt (thường 1) — máy người dùng, không phải server farm.
- MUST NOT để job chiếm hết tài nguyên đến mức UI không phản hồi.
- Job cùng project cùng type: MUST tuần tự, không song song (tránh hai render ghi cùng file).

## 9. Output

- Worker ghi vào **temp**, verify xong mới move vào vị trí cuối (nguyên tắc atomic của [07-data-and-storage](07-data-and-storage.md) §4).
- MUST verify trước khi publish: file tồn tại, kích thước > 0, probe được (ffprobe với media).
- Verify hỏng → job `failed`, MUST NOT publish output nghi ngờ.
- Output vào workspace (`renders/`, `narration/*.wav`, `snapshots/`) vì chúng thuộc project.

## 10. Dọn dẹp

- Job terminal giữ N ngày hoặc M bản ghi gần nhất, cấu hình được.
- Temp file của job đã chết MUST được dọn lúc khởi động.
- MUST NOT dọn output nằm trong workspace — đó là tài sản người dùng.

## 11. Worker chạy ở đâu

- Mặc định: in-process với daemon, tách bằng concurrency limit.
- `vidcom worker`: process riêng, dùng khi render/TTS cần cô lập (crash không kéo đổ daemon).
- Dù chạy ở đâu, worker MUST đi qua cùng Core và cùng service ghi file — MUST NOT có đường ghi riêng.

## 12. Job đặc biệt: agent session

Agent session là job **có stream**, không chỉ có progress:

- Stream output qua SSE `agent.output`.
- MUST kill được, MUST có timeout.
- MUST giới hạn số session đồng thời.
- Mọi tool call của agent đi vào audit như tool call MCP thường ([05-mcp-tool-design](05-mcp-tool-design.md) §9).
- MUST NOT cho agent quyền vượt ngoài tool set đã khai báo, kể cả khi nó chạy như job nội bộ.
