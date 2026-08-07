// Hold a libuv-created named pipe open while GetNamedSecurityInfo reads its DACL.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

const name = `vidcom-acl-${process.pid}`;
const server = createServer((_, res) => res.end("ok"));
await new Promise((r) => server.listen(`\\\\.\\pipe\\${name}`, r));
try {
  console.log(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "pipe-acl.ps1", "-PipeName", name],
      { encoding: "utf8" },
    ),
  );
} catch (e) {
  console.log("ERR", String(e.stdout || "") + String(e.stderr || ""));
}
server.close();
