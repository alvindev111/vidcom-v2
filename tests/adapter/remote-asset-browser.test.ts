import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import puppeteer, { type Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { injectRuntimeAssetGuardDocument, LoopbackRuntimeAssetGuard } from "@vidcom/adapter";
import { evaluateRemoteAssetGuard, type JobId } from "@vidcom/core";

function chromeExecutable(): string | null {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
        ]
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (found) return found;
  if (process.platform !== "win32") {
    for (const command of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
      try { return execFileSync("which", [command], { encoding: "utf8" }).trim() || null; }
      catch { /* continue */ }
    }
  }
  return null;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("test server has no port"));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    };
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, 2_000);
    server.close((error) => finish(error ?? undefined));
    server.closeIdleConnections();
  });
}

const executablePath = chromeExecutable();
// A hosted Windows cold start includes antivirus inspection of Chrome. Keep
// the hook bounded without treating that one-time launch cost as a skipped test.
const BROWSER_LAUNCH_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 30_000;
if (!executablePath) console.warn("SKIPPING remote-asset browser integration: Chrome/Chromium is not installed");

describe.skipIf(!executablePath)("remote asset guard in a real browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: executablePath!,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, BROWSER_LAUNCH_TIMEOUT_MS);

  afterAll(async () => { await browser?.close(); });

  it("blocks a runtime-created remote image before the asset server receives any request", async () => {
    const jobId = "job_runtime_media_browser" as JobId;
    const guard = new LoopbackRuntimeAssetGuard();
    const opened = await guard.open(jobId);
    let guardClosed = false;
    let assetRequests = 0;
    const asset = createServer((_request, response) => {
      assetRequests += 1;
      response.writeHead(200, { "content-type": "image/png" }).end();
    });
    const assetPort = await listen(asset);
    const imageUrl = `http://127.0.0.1:${assetPort}/runtime.png`;
    // The listener is authored after the guard's own, so it runs after it — and
    // the guard reports with a synchronous XHR. By the time this flag is set,
    // the report has already been delivered, which makes it a signal the test
    // can wait on instead of a fixed sleep.
    const html = injectRuntimeAssetGuardDocument(
      `<!doctype html><html><head><meta charset="utf-8"><script>`
      + `addEventListener("securitypolicyviolation",()=>{globalThis.__guardViolation=true;});`
      + `addEventListener("load",()=>{const image=new Image();image.src=${JSON.stringify(imageUrl)};document.body.append(image);});`
      + `</script></head><body></body></html>`,
      opened,
    );
    const document = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
    const documentPort = await listen(document);
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${documentPort}/`, { waitUntil: "load" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const snapshot = await guard.close(jobId, opened.token);
      guardClosed = true;
      expect(assetRequests).toBe(0);
      expect(snapshot.mediaViolations).toEqual([{
        url: imageUrl,
        source: "observed-request",
        reference: "img-src",
      }]);
      expect(evaluateRemoteAssetGuard(snapshot)).toMatchObject({
        ok: false,
        error: { code: "remote_asset_not_local" },
      });
    } finally {
      await page.close();
      await Promise.all([
        close(document),
        close(asset),
        ...(guardClosed ? [] : [guard.close(jobId, opened.token).then(() => undefined)]),
      ]);
    }
  });

  it("observes a duplicated dynamic script exactly once and excludes callback traffic", async () => {
    const jobId = "job_runtime_external_browser" as JobId;
    const guard = new LoopbackRuntimeAssetGuard();
    const opened = await guard.open(jobId);
    let guardClosed = false;
    let resourceRequests = 0;
    const resource = createServer((_request, response) => {
      resourceRequests += 1;
      response.writeHead(200, { "content-type": "text/javascript" })
        .end("globalThis.__guardScriptLoads=(globalThis.__guardScriptLoads||0)+1;");
    });
    const resourcePort = await listen(resource);
    const baseUrl = `http://127.0.0.1:${resourcePort}`;
    const html = injectRuntimeAssetGuardDocument(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      opened,
    );
    const documentServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
    const documentPort = await listen(documentServer);
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${documentPort}/`, { waitUntil: "domcontentloaded" });
      await page.evaluate((dynamicUrl) => {
        for (let index = 0; index < 2; index += 1) {
          const node = document.createElement("script");
          node.src = dynamicUrl;
          document.head.append(node);
        }
      }, `${baseUrl}/dynamic.js`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const scriptLoads = await page.evaluate(() => (globalThis as typeof globalThis & { __guardScriptLoads?: number })
        .__guardScriptLoads ?? 0);
      const snapshot = await guard.close(jobId, opened.token);
      guardClosed = true;
      expect(scriptLoads).toBe(2);
      expect(resourceRequests).toBeGreaterThanOrEqual(1);
      expect(snapshot.externalDependencies).toEqual([`${baseUrl}/dynamic.js`]);
      expect(snapshot.externalDependencies.some((url) => url.endsWith("/report"))).toBe(false);
      expect(evaluateRemoteAssetGuard(snapshot)).toEqual({
        ok: true,
        value: { externalDependencies: snapshot.externalDependencies },
      });
    } finally {
      await page.close();
      await Promise.all([
        close(documentServer),
        close(resource),
        ...(guardClosed ? [] : [guard.close(jobId, opened.token).then(() => undefined)]),
      ]);
    }
  }, 20_000);
});
