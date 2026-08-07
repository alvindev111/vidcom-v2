/**
 * S7 — đóng OQ-2: loopback HTTP + bearer, hay unix socket / named pipe?
 *
 * Bản 3 đề xuất loopback HTTP vì `/api/mcp` và `McpCredentialService` đã tồn tại
 * và đã có test, và ghi "socket cần code mới cho hai họ OS". Nó cũng thừa nhận
 * cần handshake (R2.13) vì port là động.
 *
 * Spike hỏi hai câu đo được:
 *   A. Nguy cơ chiếm port có thật không? Tức: daemon nhả port, một tiến trình
 *      lạ chiếm đúng port đó, bridge cầm endpoint record cũ nối vào — nó có gửi
 *      mutation của workspace vào tiến trình lạ không?
 *   B. `@hono/node-server` có listen được trên unix socket không? Nếu có thì
 *      "code mới cho hai họ OS" thu lại còn Windows named pipe, và cả một lớp
 *      rủi ro của (A) biến mất vì không còn port để chiếm.
 */
import { createServer } from "node:http";
import { unlinkSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = { A_portSteal: {}, B_unixSocket: {} };
const listen = (server, ...args) => new Promise((r) => server.listen(...args, r));
const close = (server) => new Promise((r) => server.close(r));

// ---------- A. Nguy cơ chiếm port ----------
{
  // Daemon thật của workspace X.
  const daemon = createServer((_q, s) => {
    s.writeHead(200, { "Content-Type": "application/json" });
    s.end(JSON.stringify({ who: "vidcom-daemon", workspace: "/Users/me/workspace-X" }));
  });
  await listen(daemon, 0, "127.0.0.1");
  const port = daemon.address().port;
  out.A_portSteal.endpointRecord = { port, workspace: "/Users/me/workspace-X" };

  // Daemon chết. Endpoint record trên đĩa vẫn còn — đúng kịch bản §3 mô tả.
  await close(daemon);

  // Một tiến trình lạ chiếm đúng port đó.
  const stranger = createServer((_q, s) => {
    s.writeHead(200, { "Content-Type": "application/json" });
    s.end(JSON.stringify({ who: "some-other-app" }));
  });
  let stolen = false;
  try { await listen(stranger, port, "127.0.0.1"); stolen = true; } catch { stolen = false; }
  out.A_portSteal.strangerTookSamePort = stolen;

  if (stolen) {
    // Bridge NGÂY THƠ: chỉ kiểm "có ai trả lời ở port này không".
    const naive = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
    out.A_portSteal.naiveBridgeSees = naive;
    out.A_portSteal.naiveBridgeWouldSendMutation = naive.who !== "vidcom-daemon"
      ? "CÓ — gửi vào tiến trình lạ"
      : "không";

    // Bridge CÓ HANDSHAKE (R2.13): so workspaceRoot + instance id trước tool call.
    const handshake = naive.who === "vidcom-daemon" && naive.workspace === "/Users/me/workspace-X";
    out.A_portSteal.handshakeBridgeRefuses = !handshake;
    await close(stranger);
  }
}

// ---------- B. Unix socket ----------
{
  const socketPath = path.join(tmpdir(), `vidcom-s7-${process.pid}.sock`);
  try { unlinkSync(socketPath); } catch {}

  const { serve } = await import(process.env.SPIKE_HONO_SERVER);
  const { Hono } = await import(process.env.SPIKE_HONO);
  const app = new Hono().get("/api/mcp/ping", (c) => c.json({ ok: true, transport: "unix" }));

  let server;
  try {
    server = serve({ fetch: app.fetch, path: socketPath });
    await new Promise((r) => setTimeout(r, 300));
    out.B_unixSocket.honoNodeServerAccepts = true;
  } catch (error) {
    out.B_unixSocket.honoNodeServerAccepts = false;
    out.B_unixSocket.error = String(error?.message ?? error);
  }

  if (out.B_unixSocket.honoNodeServerAccepts) {
    try {
      const mode = statSync(socketPath).mode & 0o777;
      out.B_unixSocket.defaultMode = mode.toString(8);
      chmodSync(socketPath, 0o600);
      out.B_unixSocket.modeAfterChmod = (statSync(socketPath).mode & 0o777).toString(8);
    } catch (error) {
      out.B_unixSocket.statError = String(error?.message ?? error);
    }
    // fetch() của Node nói được unix socket qua `unix:` prefix? Thử cả hai đường.
    try {
      const res = await fetch(`http://localhost/api/mcp/ping`, {
        // @ts-expect-error — Node 24 hỗ trợ `unix` trong dispatcher, thử đường undici.
        unix: socketPath,
      });
      out.B_unixSocket.fetchOverSocket = { status: res.status, body: await res.text() };
    } catch (error) {
      out.B_unixSocket.fetchOverSocket = `fetch() không nói unix trực tiếp: ${String(error?.message ?? error)}`;
    }
    // Đường chắc chắn có: http.request với option socketPath.
    const nodeHttp = await import("node:http");
    const viaHttp = await new Promise((resolve) => {
      const req = nodeHttp.request(
        { socketPath, path: "/api/mcp/ping", method: "GET" },
        (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); },
      );
      req.on("error", (e) => resolve(`lỗi: ${e.message}`));
      req.end();
    });
    out.B_unixSocket.viaHttpSocketPath = viaHttp;
    try { server.close?.(); } catch {}
    try { unlinkSync(socketPath); } catch {}
  }
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
