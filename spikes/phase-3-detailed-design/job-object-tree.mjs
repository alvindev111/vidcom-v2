import { fork, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [role = "root", pidFile] = process.argv.slice(2);

if (role === "child") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  process.send?.({ childPid: process.pid, grandchildPid: grandchild.pid });
  setInterval(() => {}, 1000);
} else {
  if (!pidFile) throw new Error("pid file is required");
  const child = fork(import.meta.filename, ["child", pidFile], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", async ({ childPid, grandchildPid }) => {
    await writeFile(pidFile, JSON.stringify({ rootPid: process.pid, childPid, grandchildPid }));
  });
  setInterval(() => {}, 1000);
}
