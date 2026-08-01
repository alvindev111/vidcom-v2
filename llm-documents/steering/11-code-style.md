# 11 — Code style

## 1. Ngôn ngữ

- **Code, comment, commit message, tên biến: tiếng Anh.**
- **Tài liệu trong `llm-documents/`: tiếng Việt** (giữ nguyên thuật ngữ kỹ thuật, tên API, lệnh CLI).
- Thông báo lỗi trả cho người dùng: tiếng Anh ở tầng `message`; UI dịch nếu cần.

## 2. Đơn giản trước

- Code tối thiểu giải quyết đúng vấn đề. Không tính năng ngoài yêu cầu.
- Không abstraction cho code chỉ dùng một chỗ.
- Không "linh hoạt" hay "cấu hình được" khi chưa ai yêu cầu.
- Không xử lý lỗi cho tình huống không thể xảy ra.
- Viết 200 dòng mà 50 dòng là đủ → viết lại.

Câu hỏi tự kiểm: *một senior engineer có nói cái này phức tạp quá không?*

## 3. Thay đổi có phẫu thuật

Khi sửa code có sẵn:

- MUST NOT "cải thiện" code, comment hay format ở chỗ không liên quan.
- MUST NOT refactor thứ không hỏng.
- MUST theo style xung quanh, kể cả khi mình thích cách khác.
- Thấy dead code không liên quan → **nói ra**, đừng xoá.

Khi thay đổi của mình tạo ra thứ mồ côi (import, biến, hàm không còn ai dùng): MUST dọn — nhưng chỉ dọn thứ **chính mình** làm thừa ra.

Thước đo: mọi dòng thay đổi phải truy được về yêu cầu.

## 4. Doc comment cho hàm — bắt buộc

### 4.1 Cái gì bắt buộc có doc comment

| Đối tượng | Bắt buộc |
|---|---|
| Mọi hàm **export** | ✅ |
| Mọi use case trong `core/usecase` | ✅ + mục bổ sung ở §4.5 |
| Mọi method của **port** interface | ✅ |
| Mọi **MCP tool** | ✅ + mô tả là prompt, xem [05-mcp-tool-design](05-mcp-tool-design.md) §8 |
| Mọi type/interface export | ✅ |
| Hàm private mà tên chưa nói hết | ✅ |
| Hàm private một dòng, tên đã đủ rõ | không cần |

MUST NOT merge code có hàm export thiếu doc comment.

### 4.2 Cấu trúc

```ts
/**
 * <Một câu: hàm này TRẢ VỀ cái gì / LÀM gì. Không mô tả cách làm.>
 *
 * <Đoạn tuỳ chọn: vì sao viết như vậy, cạm bẫy, cách tiếp cận đã thử và hỏng,
 *  điều kiện biên mà signature không nói được.>
 */
```

Câu đầu MUST đứng một mình đọc được — nó là thứ hiện lên khi hover trong IDE.

### 4.3 Bắt buộc nói ra, vì type không nói được

| Tình huống | Phải ghi |
|---|---|
| Trả `null` / mảng rỗng | `null` **nghĩa là gì** — "không tìm thấy" khác "không hợp lệ" khác "ngoài phạm vi" |
| Có side effect | Ghi file nào, phát event gì, đụng cache nào |
| Mutate tham số | Nói rõ (và cân nhắc đừng mutate — §10) |
| Có thứ tự đảm bảo | "theo document order", "sort theo start tăng dần" |
| Throw thay vì trả `Result` | Vì sao đây là bug lập trình chứ không phải lỗi nghiệp vụ |
| Có I/O | Đọc/ghi đĩa, gọi network, spawn process |
| Đắt | "parse lại toàn bộ document" — để người gọi biết đừng gọi trong vòng lặp |
| Tham số optional có ngữ nghĩa | Bỏ qua thì hành vi khác thế nào |

### 4.4 Tham số khó hiểu — comment ngay tại tham số

Không nhồi hết vào `@param`. Repo đã làm đúng cách này, MUST giữ:

```ts
export function writeSourceFile(
  slug: string,
  path: string,
  code: string,
  /** Version the editor loaded; omit to force the write. */
  baseVersion?: string,
): Result<SourceFile, WriteError> { … }
```

```ts
export function readSceneElements(
  root: ParentNode,
  compositionId: string,
  /**
   * Whether a node belongs to this composition. Only needed when `root` spans
   * more than one composition — reading the entry document's own track, where
   * anything sitting inside a nested host is that scene's business.
   */
  owns: (node: Element) => boolean = () => true,
) { … }
```

### 4.5 Use case — bốn mục bắt buộc

Use case là API của Core, cả HTTP và MCP đều dựa vào. Doc comment MUST nói:

1. **Thao tác gì** dưới góc nhìn người dùng.
2. **Tiền điều kiện** — cần revision nào, project phải ở trạng thái gì.
3. **Ghi những gì** — file nào, entity nào, có sinh revision không.
4. **Tác dụng phụ** — event phát ra, thứ bị đánh dấu stale, job được tạo.

```ts
/**
 * Change a scene's start, duration or track index in the root composition.
 *
 * Requires `expectedRevision` from a previous read — a stale revision is
 * rejected rather than merged, because the agent and the CLI write the same
 * file (P7).
 *
 * Writes `index.html` through the SDK, which re-serializes the whole document:
 * indentation is normalised and `data-hf-id` attributes are stamped in. Emits
 * `project.changed`. Does NOT extend the root duration — a scene that would run
 * past the root is rejected with `duration_overflow` unless `extendRoot` is set.
 */
```

### 4.6 Không viết gì

- MUST NOT `@param`/`@returns` chỉ chép lại kiểu đã có trong TypeScript.
- MUST NOT câu rỗng: `/** Creates a scene. */` trên `createScene()`.
- MUST NOT chép tên hàm tách chữ hoa thành câu.
- MUST NOT `@author`, `@date`, `@version` — Git giữ những thứ đó.

Đạt / không đạt:

```ts
// ❌ không thêm thông tin nào
/** Reads the project. */
export function readProject(slug: string): Project | null

// ✅
/**
 * Project metadata read straight off `index.html`, or `null` when the slug is
 * not a project (no `hyperframes.json`) or the entry file is missing.
 *
 * Dimensions and duration come from the root host's `data-*` attributes, not
 * from `registry-item.json` — the JSON metadata is stale on these projects and
 * reports a portrait resolution for a 1920×1080 document (P1).
 */
export function readProject(slug: string): Project | null
```

### 4.7 Giữ doc comment đúng

Doc comment sai nguy hiểm hơn không có — người đọc tin nó và không đọc code.

- Đổi hành vi hàm → MUST cập nhật doc comment **trong cùng commit**.
- Đổi ngữ nghĩa `null`, thêm side effect, đổi thứ tự → MUST cập nhật.
- Review MUST bắt doc comment mô tả hành vi cũ.

---

## 5. Comment trong thân hàm — giải thích *tại sao*, không phải *cái gì*

Codebase hiện tại có một style comment rất tốt, MUST giữ. Mẫu:

> `// X, không phải Y: <lý do, gắn với một thất bại có thật>`

Ví dụ có sẵn trong repo:

```ts
// A number rather than a Tailwind class: the lane layout needs it arithmetically
// to place the playhead, and deriving that from a class string meant any edit to
// an arbitrary-value class ("w-[11rem]") silently produced NaN offsets.
export const TIMELINE_GUTTER_PX = 176;
```

```ts
// compositionRoot(), not `document.body`: the scaffolded scenes wrap their
// content in a <template>, whose children a body walk misses entirely.
```

```ts
// Held in a ref, not read from the closure: the parent re-renders on every
// player tick and hands down a fresh `onSave`. With those in the dependency
// list the timer was cleared and restarted ~60 times a second, so the autosave
// never actually fired.
```

Ba comment này đều: nêu lựa chọn, nêu lựa chọn bị loại, nêu **hậu quả thật** đã quan sát được.

Rule:

- MUST comment khi code trông kỳ quặc nhưng có lý do.
- MUST comment khi đã thử cách hiển nhiên và nó hỏng — ghi lại nó hỏng thế nào.
- MUST NOT comment thứ code đã tự nói (`// increment counter`).
- MUST NOT để comment mô tả hành vi cũ sau khi sửa code. Comment sai còn tệ hơn không có.

> Repo hiện có một ví dụ: comment ở `preview-settings.server.ts` nói stylesheet được inject vào *mọi* composition document, trong khi thực tế chỉ inject ở `/preview`. Đó là lỗi phải tránh.

## 6. TypeScript

- `strict: true`. MUST NOT `any`. Dùng `unknown` rồi thu hẹp.
- MUST NOT `as` để làm im lặng compiler. Ngoại lệ: shim cấp hệ thống (`globalThis.DOMParser`), và phải có comment.
- MUST NOT `!` (non-null assertion) trong Core. Xử lý `null` tường minh.
- Ưu tiên union type cụ thể hơn `string`: `"queued" | "running" | …`.
- Type cho boundary định nghĩa trong `contracts`, không lặp lại.
- MUST NOT tiền tố `I` cho interface.
- Export **type** riêng khỏi export **value** (`export type { … }`) để bundler tree-shake được.

## 7. Hàm

- Mọi hàm export MUST có doc comment — §4.
- Một hàm một việc. > 50 dòng → tách.
- Tham số > 3 → gộp thành object có tên field.
- MUST NOT boolean positional param: `save(path, true)` không đọc được. Dùng `save(path, { force: true })`.
- Trả sớm, tránh lồng sâu.
- Hàm thuần khi có thể — dễ test, dễ đọc.

## 8. Bất đồng bộ

- `async`/`await`, MUST NOT `.then()` chuỗi.
- MUST NOT floating promise. `void` tường minh nếu cố ý không chờ.
- Song song thì `Promise.all`, nhưng MUST cân nhắc giới hạn concurrency khi số lượng không biết trước.
- Mọi thao tác có thể treo (network, process con) MUST có timeout.

## 9. Lỗi

- Lỗi nghiệp vụ dự đoán được → `Result<T, DomainError>`, MUST NOT throw.
- Throw chỉ cho bug lập trình (vi phạm invariant nội bộ).
- MUST NOT `catch` rồi nuốt. Nuốt có chủ ý phải có comment nói vì sao.
- MUST NOT `catch (e) { throw new Error(e.message) }` — mất stack. Dùng `cause`.
- Thông báo lỗi nói **cái gì hỏng và làm gì tiếp**, không chỉ "failed".

Đạt: `"file changed on disk since you opened it — reload before saving"`
Không đạt: `"save failed"`

## 10. Bất biến & state

- `const` mặc định. `let` chỉ khi thật cần gán lại.
- MUST NOT mutate tham số đầu vào.
- MUST NOT global mutable state trong Core.
- Cache là state — phải có chủ sở hữu rõ ràng và cơ chế invalidate (xem [07-data-and-storage](07-data-and-storage.md) §7).

## 11. Số ma thuật

Đặt tên cho hằng có ý nghĩa domain, kèm comment giải thích giá trị:

```ts
/** 20 MB — a BGM bed, not a master. */
const MAX_BGM_BYTES = 20 * 1024 * 1024;
```

Comment kiểu này (đã có trong repo) tốt: nó nói **tại sao là 20 chứ không phải 200**.

## 12. Import

- Thứ tự: node builtin → external → nội bộ (`@vidcom/*`) → tương đối. Cách nhau một dòng trống.
- MUST NOT import vòng.
- MUST NOT vi phạm import boundary ([02-project-layout](02-project-layout.md) §2) — lint enforce.
- `import type` cho thứ chỉ dùng làm type.

## 13. Format & lint

- Prettier lo format. MUST NOT tranh luận format trong review.
- ESLint lo đúng/sai. Rule vi phạm boundary hoặc chính sách MUST là `error`, không phải `warn`.
- MUST NOT `eslint-disable` không kèm comment lý do.

## 14. Commit

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- Subject tiếng Anh, ở thể mệnh lệnh, ≤ 72 ký tự.
- Body giải thích **tại sao**, không phải liệt kê file đã sửa.
- Một commit một thay đổi logic. MUST NOT trộn refactor với thay đổi hành vi.
- Sửa golden file MUST giải thích trong commit body vì sao output đổi.
