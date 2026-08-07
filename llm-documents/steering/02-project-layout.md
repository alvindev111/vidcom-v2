# 02 — Project layout

## 1. Cấu trúc package

```text
packages/
├── core/                    Application Core — không phụ thuộc framework
│   ├── domain/              entity, value object, invariant thuần
│   ├── usecase/             một file một use case
│   ├── port/                interface ra thế giới ngoài (chỉ khai báo)
│   ├── service/             logic dùng chung giữa nhiều use case
│   └── error/               domain error class + error code
├── adapter/                 hiện thực các port của core
│   ├── fs/                  workspace filesystem
│   ├── hyperframes/         parse, SDK, preview build
│   ├── db/                  SQLite: job, audit, settings
│   ├── renderer/            Chromium/puppeteer
│   └── tts/                 TTS engine
├── server/                  Hono app. Export `app`. Không import `next`
│   ├── routes/              một file một nhóm resource
│   ├── middleware/          auth, log, error mapping
│   └── app.ts               ráp mọi thứ, export `app`
├── mcp/                     MCP adapter — gọi core, KHÔNG gọi server
│   ├── registry/tools/      định nghĩa tool, protocol-agnostic ← nguồn sự thật
│   ├── http.ts              createMcpHandler → handler Request/Response thuần
│   ├── stdio.ts             serveStdio
│   └── revisions.ts         re-export hằng số revision, đối chiếu với contracts
├── worker/                  chạy job dài
├── contracts/               schema dùng chung: HTTP DTO, MCP tool schema, error code
├── agent-kit/               ASSET, không phải code — nhúng vào binary, cài ở gốc workspace
│   ├── AGENTS.md            nguồn sinh manifest chỉ dẫn theo host
│   ├── CLAUDE.md            bản sao của AGENTS.md (Claude Code đọc file này)
│   ├── skills/<name>/SKILL.md
│   └── prompts/             MCP prompt expose qua server
└── cli/                     entrypoint: app / serve / mcp / worker / render / doctor

src/                         Next.js — chỉ UI
├── app/
│   ├── api/[[...route]]/route.ts    ĐÚNG MỘT file server của Next
│   ├── page.tsx
│   └── projects/[slug]/page.tsx
├── components/
└── lib/                     helper thuần cho client
```

## 2. Import boundary — bắt buộc, enforce bằng lint

| Package | Được import | Bị cấm |
|---|---|---|
| `core` | `contracts` | `hono`, `next`, `react`, `adapter/*`, `node:fs` trực tiếp |
| `adapter/*` | `core` (để implement port), `contracts` | `server`, `mcp`, `next`, `react` |
| `server` | `core`, `adapter`, `contracts` | `next`, `react`, `mcp` |
| `mcp` | `core`, `contracts` | `next`, `react`, `server`, **`adapter`** |
| `worker` | `core`, `adapter`, `contracts` | `next`, `react`, `server`, `mcp` |
| `contracts` | — | tất cả |
| `agent-kit` | — (chỉ markdown, không có code) | tất cả |
| `src/**` | `contracts` (chỉ type) | `core`, `adapter`, `server`, `mcp`, `node:*` |

Ba luật quan trọng nhất:

1. **`core` không import `adapter`.** Core khai báo port; adapter implement; composition root (`cli`) nối lại. Ngược chiều là sai.
2. **`mcp` không gọi `server`.** Hai adapter ngang hàng, cùng gọi Core. MCP gọi HTTP nghĩa là nghiệp vụ đã rò lên tầng HTTP.
3. **`mcp` cũng không import `adapter`.** Nó nhận mọi thứ cần qua tham số do `cli` inject (`createMcpRegistry(infrastructure, application)`), nên `packages/mcp/package.json` chỉ khai `contracts` + `core` + SDK + `zod`.

### 2.1 Vì sao `worker` được import `adapter` mà `mcp` thì không

Câu hỏi này sẽ được hỏi lại, nên trả lời một lần ở đây.

`adapter/*` đã bị cấm import `mcp` và `server`. Luật 3 chỉ làm chiều còn lại đối xứng: **`mcp` là adapter giao thức, nó dịch chứ không thực thi.** Việc của nó là biến JSON-RPC thành lời gọi Core và biến `DomainError` thành mã lỗi MCP. Nó không mở file, không mở DB, không spawn process — nên nó không cần `adapter`, và không cần thì không mở.

`worker` thì ngược lại: nó **là** chỗ infrastructure chạy. Một job render phải chạm filesystem, FFmpeg, Chromium. Cấm nó import `adapter` là biến `cli` thành nơi phải chuyển tiếp mọi thứ, không được gì.

Cái giá của luật 3 là một interface mỏng: khi `mcp` cần gọi ra ngoài (ví dụ bridge gọi daemon), nó khai `interface` rồi để `cli` dựng hiện thực. Cái được là `packages/mcp` test được mà không cần dựng infrastructure, và `@vidcom/adapter` — vốn chỉ có **một** `exports: "./src/index.ts"`, tức mở là mở hết Drizzle, `node:fs`, `puppeteer-core`, TTS — không lọt vào tầng giao thức.

> `cli` không có dòng trong bảng vì nó là composition root: nó được import **tất cả**, và là package duy nhất thấy được cả `mcp` lẫn `adapter`. Mọi chỗ hai bên cần gặp nhau thì gặp ở đây.

### 2.2 Hai gate cưỡng chế, phải khớp nhau

Bảng trên được cưỡng chế bởi **hai** thứ, và cả hai MUST nói cùng một câu:

1. **ESLint** `no-restricted-imports`, một block cho mỗi `packages/*/**/*.ts` trong [`eslint.config.mjs`](../../eslint.config.mjs) — chạy bằng `bun run lint`.
2. **[`scripts/verify-import-boundaries.mjs`](../../scripts/verify-import-boundaries.mjs)** — chạy bằng `bun run test:boundaries`. Nó bắt được thứ ESLint bỏ sót: import theo **đường dẫn tương đối** vượt biên package, và `packages/adapter/src/<bất kỳ>/**` cũng phân giải thành `@vidcom/adapter` nên không có thư mục con nào "lách" được luật.

MUST cập nhật **cả hai** khi sửa bảng này, và MUST thêm fixture vào gate thứ hai để chính nó tự kiểm. Sửa một chỗ là tạo ra tình trạng `lint` xanh nhưng `test:boundaries` đỏ (hoặc ngược lại) — đúng loại lỗi làm người sửa tin rằng gate mới là thứ sai.

## 3. Vì sao `src/` chỉ còn UI

D4: `src/app/api/[[...route]]/route.ts` là file server **duy nhất** của Next. Nó chỉ làm một việc:

```ts
import { handle } from "hono/vercel";
import { app } from "@vidcom/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
```

MUST NOT thêm logic vào file này. MUST NOT tạo Route Handler nào khác dưới `src/app/api/`.

**Server component MUST NOT đọc filesystem.** Trang lấy dữ liệu bằng client fetch tới Hono. Đây là điều kiện để bỏ Next ở Mức 2 — còn một RSC đọc đĩa là D4 chưa đạt.

## 4. Quy tắc đặt tên

### File
- `kebab-case.ts` cho mọi file.
- Một use case một file, tên = tên use case: `create-scene.ts`, `save-source-file.ts`.
- Một MCP tool một file, tên = tên tool: `set-scene-timing.ts`.
- Port: `<tên>-port.ts` (`workspace-port.ts`, `renderer-port.ts`).
- Adapter: `<tên>-<công-nghệ>.ts` (`workspace-fs.ts`, `renderer-puppeteer.ts`).
- Test: cạnh file được test, `<tên>.test.ts`.

### Symbol
- Type/interface/class: `PascalCase`. Interface **không** thêm tiền tố `I`.
- Hàm, biến: `camelCase`.
- Hằng cấp module: `SCREAMING_SNAKE_CASE`.
- Port interface kết thúc bằng `Port`: `WorkspacePort`, `TtsPort`.
- Use case export **một** hàm tên bằng động từ: `createScene()`, `saveSourceFile()`.

### Không đặt tên
MUST NOT dùng `utils.ts`, `helpers.ts`, `common.ts`, `misc.ts`, `index.ts` chứa logic. Nếu không đặt được tên cho một file, nó chưa có trách nhiệm rõ ràng.

`index.ts` chỉ được dùng làm **barrel re-export** của một package, không chứa implementation.

## 5. Kích thước và tách file

- File > **300 dòng** → xem lại. Không phải luật cứng, là tín hiệu.
- Hàm > **50 dòng** → tách.
- Một file export nhiều hơn một khái niệm chính → tách.

Điều ngược lại cũng đúng: MUST NOT tạo abstraction cho code chỉ dùng một chỗ. Xem [11-code-style](11-code-style.md) §2.

## 6. `agent-kit` — asset, không phải code

`packages/agent-kit/` chứa **markdown ship cho AI agent**: nguồn `AGENTS.md`/`CLAUDE.md`, skill và MCP prompt. Khi được gọi tường minh, installer sinh manifest host ở **gốc workspace**; không nhân bản vào từng project.

- Không có file `.ts` nào. Không import gì, không ai import nó **như code** — `packages/mcp` và `packages/cli` **nhúng** nó qua SEA assets rồi ghi ra đĩa.
- Nội dung ở đây là **contract với AI**, mục ngang với tool schema. Đổi tool mà không đổi agent-kit là để lại tài liệu sai trong project người dùng.

Luật viết và đồng bộ: [14-agent-kit-and-skills](14-agent-kit-and-skills.md).

## 7. Quy tắc cho package `contracts`

`contracts` là chỗ **duy nhất** định nghĩa hình dạng dữ liệu đi qua boundary:

- HTTP request/response DTO;
- MCP tool input/output schema;
- error code enum;
- domain event payload.

MUST NOT định nghĩa lại cùng một shape ở hai nơi. HTTP và MCP phục vụ cùng use case → cùng contract nguồn.

`contracts` **không** import gì cả. Nó là lá của dependency graph.
