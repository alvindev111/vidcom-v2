// S9/W-2 — does the S7 bridge transport survive on Windows named pipes?
//
// S7 proved on POSIX that `http.createServer(getRequestListener(app.fetch))`
// serves the SAME Hono app over a unix socket with mode 600. The Windows half
// was never verified: named pipes have no chmod, so "0600 equivalent" has to
// come from the pipe's DACL, and Node does not expose one.
import { createServer } from "node:http";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";

const pipeName = `vidcom-spike-${process.pid}`;
const pipePath = `\\\\.\\pipe\\${pipeName}`;
const out = { pipePath, steps: {} };

const app = new Hono();
app.get("/api/bridge/v1/ready", (c) =>
  c.json({ instanceId: "daemon_spike", workspaceRoot: "C:\\tmp\\ws", leaseHeld: true }),
);
app.post("/api/bridge/v1/tools/:name", async (c) => {
  const body = await c.req.json();
  return c.json({ tool: c.req.param("name"), echo: body });
});

const server = createServer(getRequestListener(app.fetch));

const call = (method, path, body) =>
  new Promise((resolve, reject) => {
    const req = request(
      { socketPath: pipePath, method, path, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(pipePath, resolve);
});
out.steps.listen = "ok";

out.steps.get = await call("GET", "/api/bridge/v1/ready");
out.steps.post = await call("POST", "/api/bridge/v1/tools/list_projects", { input: { limit: 1 } });

// Second listener on the same name: the daemon single-instance question.
out.steps.secondListen = await new Promise((resolve) => {
  const dup = createServer(() => {});
  dup.once("error", (e) => resolve({ code: e.code, message: e.message }));
  dup.listen(pipePath, () => {
    dup.close();
    resolve({ code: "NO_ERROR", message: "second listen SUCCEEDED — no exclusivity" });
  });
});

// The security question: who is on the pipe's DACL?
try {
  const ps = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p=[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | Where-Object { $_ -like '*${pipeName}*' }; ` +
        `$acl = Get-Acl -Path $p; ` +
        `$acl.Owner; '---'; $acl.Access | ForEach-Object { "$($_.IdentityReference)=$($_.FileSystemRights)" }`,
    ],
    { encoding: "utf8" },
  );
  out.steps.acl = ps.trim().split(/\r?\n/);
} catch (e) {
  out.steps.acl = { error: String(e.stderr || e.message).slice(0, 400) };
}

server.close();
console.log(JSON.stringify(out, null, 2));
