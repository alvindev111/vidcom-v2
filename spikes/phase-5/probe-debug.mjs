import { createRequire } from "node:module";
import { startSpikeServer } from "./server.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const puppeteer = (await import(require.resolve("puppeteer-core"))).default;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const { server, port } = await startSpikeServer(0);
const base = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: ["--no-sandbox"], defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${base}/fixture/host.html`, { waitUntil: "load" });

const out = await page.evaluate(async (url) => {
  const log = [];
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.source === "hf-preview") log.push({ type: data.type, sameAsProbe: event.source === window.__probeFrame?.iframeElement?.contentWindow });
  });
  const probe = document.createElement("hyperframes-player");
  probe.style.cssText = "position:absolute;left:0;top:0;width:320px;height:180px;opacity:0.01;z-index:-1";
  probe.setAttribute("src", url);
  document.body.appendChild(probe);
  window.__probeFrame = probe;
  await new Promise((r) => setTimeout(r, 6000));
  return { log: log.slice(0, 12), ready: probe.ready, duration: probe.duration, hasIframe: !!probe.iframeElement };
}, `${base}/fixture/index.html`);

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
