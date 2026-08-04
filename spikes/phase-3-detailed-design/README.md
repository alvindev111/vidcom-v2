# Giai đoạn 3 — Spike Detailed Design

Ngày chạy: **2026-08-04**. Đây là fixture/evidence cho Detailed Design, không phải production implementation. Mọi output nằm trong temp riêng và được dọn sau probe; FFmpeg/FFprobe dùng bản portable của spike render, không cài vào máy và không sửa dependency repo.

## Kết quả

| # | Probe | Kết quả | Thiết kế bị tác động |
|---|---|---|---|
| 1 | `job-cancellation-contract.ts` | **FAIL contract hiện tại** — sau request cancel 500 ms job vẫn `running`; chỉ terminal sau 3102 ms khi child tự thoát; persisted cancel không nối vào signal | `JobScheduler` phải poll cancel bền và abort signal đang chạy |
| 2 | `migration-contract.ts` | **FAIL DDL v1** — `partial` bị `ck_job_status` từ chối; boolean `7` và JSON lỗi lại được nhận | `job` phải table-rebuild; cột mới phải có CHECK thật |
| 3 | `migration-remediation.ts` | **PASS** — giữ row cũ, nhận `partial`, từ chối boolean/JSON lỗi | Chốt 1 `ADD COLUMN ... CHECK` + 1 table-rebuild + 2 bảng workspace |
| 4 | `runtime-remote-media.mjs` | **FAIL static-only** — `new Image()` tải URL runtime dù scanner thấy 0 và CLI exit 0 | Static scanner không đủ cho R6.15 |
| 5 | `runtime-media-csp-guard.mjs` | **PASS remediation** — CSP chặn trước khi server asset nhận byte; callback nhận đúng URL/directive; staged artifact có thể discard | Chốt CSP + `securitypolicyviolation` trong chính lượt render |
| 6 | `runtime-external-observer.mjs` | **PASS remediation** trên render thật — script DOM tạo động được tải và observer báo đúng URL/type | R6.15b dùng Resource Timing + loopback; phải lọc callback, dedupe và cap |
| 7 | `snapshot-cli-contract.mjs` | **PASS midpoint**, đồng thời xác nhận CLI luôn tạo thêm `contact-sheet.jpg` | Chạy staging riêng từng scene, chỉ lấy PNG; VidCom ghép sheet sau khi complete |
| 8 | `job-object-contract.ps1` + `job-object-tree.mjs` | **PASS** — create suspended → assign Job Object → resume; đóng handle giết root/child/grandchild, survivors `[]` | Windows dùng bundled supervisor sidecar theo run; không dùng `taskkill` làm proof |

## Hai kết quả âm phải được giữ lại

1. Probe Resource Timing ngây thơ đã tự quan sát request callback và tạo feedback loop. Contract đúng phải loại chính callback URL, chỉ nhận `script | link | css | font`, dedupe và cap 100 entry/job.
2. `hyperframes snapshot` không chạy cùng đường composition runtime như render đối với fixture script động; kết luận R6.15b vì vậy lấy từ **render thật**, không từ snapshot.

## Lệnh tái lập

```powershell
bun spikes/phase-3-detailed-design/job-cancellation-contract.ts
bun spikes/phase-3-detailed-design/migration-contract.ts
bun spikes/phase-3-detailed-design/migration-remediation.ts
node spikes/phase-3-detailed-design/snapshot-cli-contract.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File spikes/phase-3-detailed-design/job-object-contract.ps1 `
  -NodePath C:\nvm4w\nodejs\node.exe `
  -TargetScript spikes/phase-3-detailed-design/job-object-tree.mjs
```

Ba probe render nhận đối số đầu là thư mục portable chứa `ffmpeg.exe` + `ffprobe.exe`:

```powershell
node spikes/phase-3-detailed-design/runtime-remote-media.mjs <ffmpeg-bin>
node spikes/phase-3-detailed-design/runtime-media-csp-guard.mjs <ffmpeg-bin>
node spikes/phase-3-detailed-design/runtime-external-observer.mjs <ffmpeg-bin>
```

## Giới hạn bằng chứng

- Job Object spike chứng minh protocol Win32 và zero survivor trên cây ba tầng. Implementation vẫn phải build/package/hash sidecar và chạy adapter contract trên Node 24.9.0 + 26.5.0.
- PowerShell `Add-Type` chỉ là harness để gọi Win32 trong spike; production MUST NOT phụ thuộc PowerShell.
- Resource Timing quan sát script/style/font để đánh dấu `reproducible:false`; Phase 3 chưa chặn toàn bộ network external.

`verify-doc-links.mjs` là verifier phụ: vòng cuối đã kiểm 9 tài liệu bị tác động và không còn local link trỏ tới file thiếu.
