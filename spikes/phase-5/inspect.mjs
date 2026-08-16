import { createRequire } from "node:module";
import { startSpikeServer } from "./server.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const puppeteer = (await import(require.resolve("puppeteer-core"))).default;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const { server, port } = await startSpikeServer(0);
const base = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: ["--no-sandbox"], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
await page.goto(`${base}/fixture/host.html`, { waitUntil: "load" });
await page.evaluate((src) => window.__spike.mount(src), `${base}/fixture/index.html`);
await new Promise((r) => setTimeout(r, 4000));

const dump = await page.evaluate(() => {
  const doc = window.__spike.doc();
  return {
    hasDoc: !!doc,
    bodyStart: doc?.body?.outerHTML.slice(0, 1200) ?? null,
    compositionIds: [...(doc?.querySelectorAll("[data-composition-id]") ?? [])].map((n) => ({ id: n.getAttribute("data-composition-id"), tag: n.tagName, childIds: [...n.children].map((c) => c.id || c.tagName) })),
    clipManifest: JSON.stringify(doc?.defaultView?.__clipManifest ?? null).slice(0, 600),
  };
});
console.log(JSON.stringify(dump, null, 2));
await browser.close();
server.close();
