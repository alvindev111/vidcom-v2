# 10 — Testing

## 1. Điểm xuất phát

Repo hiện có **0 test**. Toàn bộ lý do tách Application Core là để test được nghiệp vụ mà không cần dựng HTTP hay UI. Nếu Core ra đời mà vẫn không có test, việc tách chỉ là di chuyển file.

Rule: **test đi cùng code trong cùng PR.** Không có mục "thêm test sau".

## 2. Kim tự tháp

| Tầng | Chạy gì | Tỉ trọng | Tốc độ |
|---|---|---|---|
| Unit | domain, use case với port giả | nhiều nhất | ms |
| Golden file | output của parse / serialize / build HTML | nhiều | ms |
| Contract | schema HTTP + MCP tool | vừa | ms |
| Integration | adapter thật + filesystem tạm | ít | giây |
| Smoke (packaged) | binary đã build, máy sạch | rất ít | phút |

## 3. Unit test cho Core

Core không có I/O → test bằng port giả, không cần mock framework.

```ts
const workspace = fakeWorkspace({ "index.html": "<div data-composition-id=…>" });
const clock = fixedClock("2026-08-01T00:00:00Z");

const result = await createScene({ workspace, clock, … }, { projectId, title: "Intro" });

expect(result.ok).toBe(true);
expect(result.value.scene.start).toBe(10);
```

Rule:
- MUST dùng `ClockPort` / `IdPort` giả — không `new Date()`, không random. Test không deterministic là test vô dụng.
- MUST test cả nhánh lỗi, không chỉ happy path.
- MUST NOT dùng mock library để mock module. Port giả là đủ và rõ hơn.

## 4. Golden-file test — quan trọng nhất với dự án này

Ba chỗ bắt buộc, vì cả ba đều tạo ra output mà một thay đổi nhỏ có thể phá hỏng toàn bộ project của người dùng:

### 4.1 `composition.serialize()`
SDK viết lại **cả document** từ DOM: chuẩn hoá indentation, stamp `data-hf-id`. Một lần nâng version `@hyperframes/sdk` có thể đổi output.

```
fixtures/serialize/
├── warm-grain-input.html
├── warm-grain-expected.html     ← đã review bằng mắt, commit vào repo
```

MUST fail khi output lệch. Khi lệch **có chủ đích**, cập nhật expected file trong cùng PR và giải thích trong commit.

### 4.2 `buildPreviewCss()` + inject preview settings
P2/P3: preview và render phải khớp. Golden file cho từng tổ hợp: tone off, tone dark, tone cream, mỗi backgroundFx, subtitle override on/off, scene hidden.

### 4.3 Parse → `Scene[]`
Snapshot cấu trúc scene/element/effect từ các fixture composition. Đây là logic dày đặc edge case (xem [11-parsing-logic](../product-features/11-parsing-logic.md)):

| Edge case bắt buộc có fixture |
|---|
| Sub-composition bọc trong `<template>` |
| Scene inline (không có `data-composition-src`) |
| Root host xác định khi có nhiều host mang `data-width`/`data-height` |
| Selector GSAP scope theo composition id (`normalizeTarget`) |
| Tween không resolve được → `unresolvedEffects` đếm đúng, **không** bịa start |
| Element không có timing riêng, chỉ có tween |
| Media ở cấp body (A-roll ngoài root host) → root track |
| Legacy `data-end` / `data-layer` |
| Hai script GSAP trong một scene → effect id không trùng |

## 5. Contract test

### HTTP
Với mỗi endpoint: request hợp lệ → shape response đúng schema; request sai → đúng `ErrorCode` và status.

### MCP
Với mỗi tool: input schema, output schema, và **mức quyền đã khai báo**.

MUST có test khoá tool contract. Đổi contract làm hỏng mọi AI host đang dùng — test phải là thứ chặn lại, không phải người review.

MUST test: tool write từ chối khi thiếu `expectedRevision`; tool destructive từ chối khi thiếu xác nhận.

**Chạy hai lần, một lần cho mỗi thế hệ protocol** (xem [13-mcp-protocol-compatibility](13-mcp-protocol-compatibility.md) §7):

| Test | Legacy | Modern `2026-07-28` |
|---|---|---|
| Từ chối destructive khi chưa xác nhận | thiếu `confirm` | chưa qua vòng MRTR |
| Hình dạng result | không có `resultType` | có `resultType` |
| List result | không có `ttlMs`/`cacheScope` | **có**, `cacheScope: "private"` |
| Resource not found | `-32002` | `-32602` |
| Version lạ | — | `-32022` kèm danh sách version hỗ trợ |
| Thiếu version header | mặc định `2025-03-26` | — |
| `server/discover` | không có | **bắt buộc có** |

Golden file cho `tools/list` của **cả hai** thế hệ, và MUST kiểm thứ tự deterministic qua nhiều lần gọi.

### Agent kit
Ba test rẻ, chặn đúng loại lỗi hay xảy ra nhất ([14-agent-kit-and-skills](14-agent-kit-and-skills.md) §7):

- Danh sách tool trong `AGENTS.md` khớp Tool Registry.
- Mọi tool được skill tham chiếu đều tồn tại.
- Mọi `/vidcom-*` mà router trỏ tới đều có `SKILL.md`.

## 6. Integration test

Chạy adapter thật trên thư mục tạm.

Bắt buộc:

| Kịch bản |
|---|
| Ghi atomic: kill giữa chừng không để lại file hỏng |
| Content hash lệch → `409` kèm nội dung server |
| Hai ghi đồng thời cùng file → đúng một thắng |
| Path traversal: `../`, absolute path, symlink trỏ ra ngoài → bị chặn |
| Job: start → progress → cancel; start → crash → recovery lúc khởi động |
| File watcher: sửa file từ ngoài → cache invalidate → event phát ra |
| Workspace lock: daemon thứ hai không chiếm được |

MUST dùng thư mục tạm thật, MUST NOT mock `node:fs` — bug ở đây là bug filesystem thật.

## 7. Smoke test trên artifact đã đóng gói

Chạy trên **binary đã build**, máy sạch, không phải source checkout:

- khởi động, chọn workspace, mở một project;
- render một composition ngắn ra MP4;
- chạy TTS một câu;
- chụp snapshot;
- AI host spawn `vidcom mcp`, gọi vài tool, restart, khôi phục state;
- `stdout` của MCP mode sạch (không lẫn log).

MUST chạy trên đủ build matrix trước khi tuyên bố release-ready.

## 8. Những gì KHÔNG cần test

- UI component thuần trình bày.
- Getter/setter, mapper một dòng.
- Thư viện bên thứ ba.
- Code sắp bị xoá trong migration.

Test coverage không phải mục tiêu. **Không có ngưỡng % bắt buộc.** Thứ bắt buộc là: mọi use case có test, mọi golden file ở §4 tồn tại, mọi kịch bản §6 được phủ.

## 9. Fixture

- Đặt trong `fixtures/`, commit vào repo.
- MUST nhỏ và tối giản — một fixture chứng minh một thứ.
- MUST có comment nói fixture này tồn tại để bắt lỗi gì.
- MUST NOT dùng project thật của người dùng làm fixture.

## 10. CI

- Chạy: typecheck, lint (kể cả import boundary của [02-project-layout](02-project-layout.md) §2), unit, golden, contract, integration.
- Smoke packaged chạy ở job riêng, trên artifact.
- Golden file lệch MUST làm đỏ CI, không được auto-update.
