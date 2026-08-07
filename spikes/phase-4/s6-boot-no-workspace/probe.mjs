/**
 * S6 — đóng OQ-10: mở listener TRƯỚC khi có workspace, dựng foundation SAU.
 *
 * Bản 3 của Goals viết đây là "thay đổi lifecycle" và ước lượng R1 lên 21 SP vì
 * nó. Câu hỏi thật: cần sửa bao nhiêu để đạt?
 *
 * Hai sự thật trong code hôm nay làm việc này rẻ hơn tưởng:
 *   - `createServerApp` nhận MỌI route group dựa vào foundation là optional
 *     (`if (deps.projectReads)`, `if (deps.jobs)`…); chỉ `createAuthRoutes` là
 *     vô điều kiện.
 *   - `nonces` và `sessions` được dựng TRƯỚC foundation ở `next-host.ts` và
 *     không phụ thuộc workspace.
 *
 * Nên giả thuyết là: giữ một biến `currentApp` đổi được, mở listener trỏ vào
 * biến đó, rồi thay app khi người dùng chọn workspace — không đóng cổng, không
 * mất session. Spike này kiểm giả thuyết đó bằng chính `createServerApp` thật.
 */
import { createServer } from "node:http";

const { createServerApp } = await import(process.env.SPIKE_SERVER_BUNDLE);

const clock = { now: () => new Date() };

// Hai store này sống ở tầng tiến trình, không thuộc foundation — đó là lý do
// session sống sót qua lần đổi app.
class Nonces {
  #issued = new Set();
  register(value) { this.#issued.add(value); }
  consume(value) { return this.#issued.delete(value); }
}
class Sessions {
  #tokens = new Map();
  mint() { const t = `s-${this.#tokens.size + 1}`; this.#tokens.set(t, { id: t }); return { token: t }; }
  verify(token) { return { valid: this.#tokens.has(token), renewed: false }; }
  revokeAll() { this.#tokens.clear(); }
}

const JOB = {
  id: "job-1", type: "render", status: "succeeded", projectId: "p-1",
  attempts: 1, maxAttempts: 1, createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), progress: 1, input: {}, result: null, error: null,
};

const nonces = new Nonces();
const sessions = new Sessions();
const PORT = Number(process.env.SPIKE_PORT ?? 53100);

// Phase 1: CHƯA có workspace — chỉ auth. Không truyền một dep foundation nào.
let currentApp = createServerApp({ port: PORT, uiOrigins: [`http://127.0.0.1:${PORT}`], nonces, sessions });

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]]),
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  // Đọc biến ở mỗi request — đây là toàn bộ "cơ chế" của boot hai pha.
  const response = await currentApp.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const hit = async (path, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: { Host: `127.0.0.1:${PORT}`, ...headers },
  });
  return { status: r.status, body: (await r.text()).slice(0, 120) };
};

const out = { phase1: {}, phase2: {} };

// Phase 1: listener đã mở, foundation chưa tồn tại.
out.phase1.authRouteExists = await hit("/api/v1/auth/session");
out.phase1.projectRoute = await hit("/api/v1/projects");
out.phase1.jobRoute = await hit("/api/v1/jobs/job-1");

// Đổi session hợp lệ để chứng minh nó sống sót qua lần swap.
const { token } = sessions.mint();
out.phase1.withSession = await hit("/api/v1/projects", { Cookie: `vidcom_session=${token}` });
out.phase1.jobWithSession = await hit("/api/v1/jobs/job-1", { Cookie: `vidcom_session=${token}` });

// Phase 2: người dùng chọn workspace ⇒ dựng foundation ⇒ THAY app.
// Ở sản phẩm thật, `projectReads` đến từ foundation; ở đây là một stub đủ để
// chứng minh route xuất hiện mà cổng không đóng.
currentApp = createServerApp({
  port: PORT,
  uiOrigins: [`http://127.0.0.1:${PORT}`],
  nonces,
  sessions,
  // JobStorePort là dep foundation dễ thoả nhất — đủ để chứng minh một route
  // group xuất hiện SAU khi listener đã mở, và trả 200 thật chứ không chỉ "khác 404".
  jobs: {
    enqueue: async () => ({ job: JOB, reused: false }),
    get: async (id) => (id === "job-1" ? JOB : null),
    latestTerminal: async () => null,
  },
});

out.phase2.jobRoute = await hit("/api/v1/jobs/job-1");
out.phase2.jobWithSession = await hit("/api/v1/jobs/job-1", { Cookie: `vidcom_session=${token}` });

out.phase2.samePort = server.address().port === PORT;
out.phase2.listenerNeverClosed = server.listening;

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
server.close();
