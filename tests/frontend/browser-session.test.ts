import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startNextHostedRuntime } from "@vidcom/cli";
import type { Browser, Page } from "puppeteer-core";
import { browserAvailability, browserIsRequired, requireBrowser } from "../support/browser-harness";
import { describe, expect, it } from "vitest";

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function mime(filename: string): string {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function clickText(page: Page, selector: string, text: string): Promise<void> {
  const elements = await page.$$(selector);
  for (const element of elements) {
    const content = await element.evaluate((node) => node.textContent?.trim() ?? "");
    if (content.includes(text)) {
      await element.click();
      return;
    }
  }
  throw new Error(`${selector} containing ${text} was not found`);
}

async function writeResponse(response: ServerResponse, value: Response): Promise<void> {
  response.statusCode = value.status;
  value.headers.forEach((header, name) => response.setHeader(name, header));
  response.end(Buffer.from(await value.arrayBuffer()));
}

/**
 * The harness that verifies the rest of Phase G.
 *
 * Cookie `SameSite` and SSE behaviour are enforced by a real browser and by
 * nothing else — spike S9 measured `curl` answering differently — so these
 * cases cannot be moved to node. What can be checked everywhere is that the
 * harness itself is honest about whether it ran.
 */
describe("browser session harness", () => {
  it("reports a runnable browser or says why not", async () => {
    const availability = await browserAvailability();

    if (availability.available) {
      expect(availability.chromePath).toBeDefined();
      // Executed, not merely found: a truncated download leaves a file that
      // cannot launch, and S9 showed the download tool reporting success for it.
      expect(availability.version?.length).toBeGreaterThan(0);
      return;
    }
    expect(availability.reason).toContain("chrome-headless-shell");
  });

  it("treats a missing browser as fatal only where it was installed", () => {
    // Keyed on its own flag, not on CI: no job installs the browser yet, and a
    // gate that fails for a missing tool rather than a missing behaviour is a
    // gate people learn to ignore. Nobody should download 200 MB to run the
    // unit suite either.
    const flag = process.env.VIDCOM_REQUIRE_BROWSER;
    expect(browserIsRequired()).toBe(flag === "true" || flag === "1");
  });

  it("never skips silently", async () => {
    if (browserIsRequired()) {
      // In CI a missing browser must raise rather than return a skip.
      await expect(requireBrowser()).resolves.toMatchObject({ run: true });
      return;
    }
    const outcome = await requireBrowser();
    if (outcome.run) {
      expect(outcome.chromePath.length).toBeGreaterThan(0);
      return;
    }
    // A skip always carries its reason to stdout.
    expect(outcome.message).toContain("skipped");
    process.stdout.write(`${outcome.message}\n`);
  });

  it("drives nonce cleanup, picker, and both New video outcomes through the static bundle", async () => {
    const available = await requireBrowser();
    if (!available.run) {
      process.stdout.write(`${available.message}\n`);
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-browser-ui-"));
    const workspace = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    await mkdir(workspace);
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
      settings: process.env.VIDCOM_SETTINGS,
    };
    const nonce = Buffer.alloc(32, 13).toString("base64url");
    process.env.VIDCOM_APP_DATA = appData;
    process.env.VIDCOM_WORKSPACE = workspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    process.env.VIDCOM_SETTINGS = path.join(root, "setting.json");
    let runtime: Awaited<ReturnType<typeof startNextHostedRuntime>> | null = null;
    let browser: Browser | null = null;
    let server: ReturnType<typeof createServer> | null = null;
    try {
      server = createServer();
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("browser harness did not reserve a port");
      const port = address.port;
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      runtime = await startNextHostedRuntime(port, workspace);
      const baseUrl = `http://127.0.0.1:${port}`;
      server = createServer(async (request, response) => {
        try {
          const requestUrl = new URL(request.url ?? "/", baseUrl);
          if (requestUrl.pathname.startsWith("/api/")) {
            const bytes = await bodyOf(request);
            await writeResponse(response, await runtime!.app.request(new Request(requestUrl, {
              method: request.method,
              headers: request.headers as HeadersInit,
              ...(bytes.byteLength === 0 ? {} : { body: Uint8Array.from(bytes).buffer }),
            })));
            return;
          }
          const relative = requestUrl.pathname === "/"
            ? "index.html"
            : /^\/projects\/[^/]+$/u.test(requestUrl.pathname)
              ? "projects/__shell.html"
              : requestUrl.pathname.slice(1);
          const contents = await readFile(path.join(process.cwd(), "out", relative));
          response.writeHead(200, { "content-type": mime(relative) });
          response.end(contents);
        } catch {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
      const puppeteer = await import("puppeteer-core");
      browser = await puppeteer.launch({
        executablePath: available.chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/?t=${encodeURIComponent(nonce)}`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.body.textContent?.includes("Projects") === true);
      expect(new URL(page.url()).searchParams.has("t")).toBe(false);

      await clickText(page, "button", "New video");
      await page.locator('[role="dialog"] input').fill("Browser Video");
      await clickText(page, '[role="dialog"] button', "Create video");
      await page.waitForFunction(() => location.pathname === "/projects/browser-video");

      await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
      await clickText(page, "button", "New video");
      await page.locator('[role="dialog"] input').fill("Browser Video");
      await clickText(page, '[role="dialog"] button', "Create video");
      await page.waitForSelector('[role="alert"]');
      expect(await page.locator('[role="alert"]').map((element) => element.textContent).wait())
        .toMatch(/exists|available|failed|create/iu);

      let activationObserved = false;
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/v1/system/workspace") {
          void request.respond({ status: 200, contentType: "application/json", body: '{"workspaceRoot":null}' });
        } else if (pathname === "/api/v1/system/filesystem/roots") {
          void request.respond({
            status: 200,
            contentType: "application/json",
            body: '{"roots":[{"displayPath":"Fixture","token":"root-token"}]}',
          });
        } else if (pathname === "/api/v1/system/filesystem/entries") {
          void request.respond({
            status: 200,
            contentType: "application/json",
            body: '{"displayPath":"Fixture","entries":[{"name":"Chosen","isDirectory":true,"token":"chosen-token"}]}',
          });
        } else if (pathname === "/api/v1/workspace/active") {
          activationObserved = true;
          void request.respond({
            status: 200,
            contentType: "application/json",
            body: '{"workspaceRoot":"Fixture/Chosen","reauthRequired":true}',
          });
        } else {
          void request.continue();
        }
      });
      await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
      await page.waitForSelector('[aria-label="Choose a workspace folder"]');
      await clickText(page, "button", "Fixture");
      await page.waitForFunction(() => document.body.textContent?.includes("Chosen") === true);
      await clickText(page, "button", "Chosen");
      await page.waitForFunction(() => document.body.textContent?.includes("Use this folder") === true);
      await clickText(page, "button", "Use this folder");
      await page.waitForFunction(() => document.readyState === "complete");
      expect(activationObserved).toBe(true);
    } finally {
      await browser?.close();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await runtime?.foundation.stop();
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE;
      else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE;
      else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
      if (prior.settings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = prior.settings;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
