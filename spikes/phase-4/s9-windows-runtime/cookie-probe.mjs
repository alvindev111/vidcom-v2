// S9/W-1 — the dev cross-origin session question, measured in a real browser.
//
// Goals R4.10 wants ONE frontend bundle that works same-origin (artifact) and
// cross-origin (`next dev` on :3000 talking to a dynamic daemon port). Design
// §5.11 assumes `credentials: "include"` plus `sameSite: "Strict"` is enough as
// long as both ends use the same hostname. SameSite is enforced only by the
// browser, so curl cannot answer this. Chrome can.
//
// Matrix: {daemon hostname} x {SameSite attribute}, plus an SSE read over the
// same connection, because §5.11 also promises the stream carries the cookie.
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  `${process.env.USERPROFILE}\\.cache\\hyperframes\\chrome\\chrome-headless-shell\\win64-152.0.7928.2\\chrome-headless-shell-win64\\chrome-headless-shell.exe`;

const FE_ORIGIN = "http://localhost:3000";

// ---- daemon ---------------------------------------------------------------
const daemon = new Hono();

const cors = (c) => {
  const origin = c.req.header("origin");
  if (origin === FE_ORIGIN) {
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-credentials", "true");
    c.header("access-control-allow-headers", "content-type");
    c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  }
};

daemon.options("/api/*", (c) => {
  cors(c);
  return c.body(null, 204);
});

daemon.post("/api/v1/auth/exchange", (c) => {
  cors(c);
  const sameSite = c.req.query("samesite") ?? "Strict";
  const secure = c.req.query("secure") === "1";
  const attrs = [`vidcom_session=sid-${Date.now()}`, "Path=/", "HttpOnly", `SameSite=${sameSite}`];
  if (secure) attrs.push("Secure");
  c.header("set-cookie", attrs.join("; "));
  return c.json({ ok: true, sent: attrs.join("; ") });
});

daemon.get("/api/v1/system/workspace", (c) => {
  cors(c);
  const cookie = c.req.header("cookie") ?? "";
  return c.json({ cookieSeen: cookie.includes("vidcom_session"), rawCookie: cookie });
});

daemon.get("/api/v1/events", (c) => {
  cors(c);
  const cookie = c.req.header("cookie") ?? "";
  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-store");
  return c.body(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ cookieSeen: cookie.includes("vidcom_session") })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
  );
});

const daemonServer = createServer(getRequestListener(daemon.fetch));
await new Promise((r) => daemonServer.listen(0, "127.0.0.1", r));
const daemonPort = daemonServer.address().port;

// ---- "next dev" stand-in --------------------------------------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>W-1</title><script>
window.run = async (base) => {
  const out = { base };
  try {
    const ex = await fetch(base + "/api/v1/auth/exchange" + location.search, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: "{}",
    });
    out.exchangeStatus = ex.status;
    out.setCookieAccepted = (await ex.json()).ok === true;
  } catch (e) { out.exchangeError = String(e); return out; }
  try {
    const ws = await fetch(base + "/api/v1/system/workspace", { credentials: "include" });
    out.workspaceStatus = ws.status;
    out.cookieSentBack = (await ws.json()).cookieSeen;
  } catch (e) { out.workspaceError = String(e); }
  try {
    const sse = await fetch(base + "/api/v1/events", {
      credentials: "include", headers: { accept: "text/event-stream" },
    });
    out.sseStatus = sse.status;
    out.sseCookieSeen = (await sse.text()).includes('"cookieSeen":true');
  } catch (e) { out.sseError = String(e); }
  return out;
};
</script><body>ready</body>`;

const feServer = createServer((_, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((r) => feServer.listen(3000, "127.0.0.1", r));

// ---- drive it -------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const results = [];

for (const [hostLabel, host] of [
  ["cross-hostname (127.0.0.1)", "127.0.0.1"],
  ["same-hostname (localhost)", "localhost"],
]) {
  for (const [attrLabel, query] of [
    ["SameSite=Strict", "?samesite=Strict"],
    ["SameSite=Lax", "?samesite=Lax"],
    ["SameSite=None; Secure", "?samesite=None&secure=1"],
  ]) {
    const page = await browser.newPage();
    await page.goto(`${FE_ORIGIN}/${query}`, { waitUntil: "domcontentloaded" });
    const r = await page.evaluate((base) => window.run(base), `http://${host}:${daemonPort}`);
    await page.close();
    results.push({ daemon: hostLabel, cookie: attrLabel, ...r });
  }
}

await browser.close();
daemonServer.close();
feServer.close();

console.log(`FE origin        : ${FE_ORIGIN}`);
console.log(`daemon port      : ${daemonPort}\n`);
for (const r of results) {
  console.log(
    `${r.daemon.padEnd(28)} ${r.cookie.padEnd(22)} ` +
      `exchange=${r.exchangeStatus ?? r.exchangeError} ` +
      `cookieSentBack=${r.cookieSentBack} sseCookie=${r.sseCookieSeen}`,
  );
}
console.log("\nJSON:", JSON.stringify(results, null, 2));
