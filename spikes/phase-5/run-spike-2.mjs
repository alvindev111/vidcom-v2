// Round 2 probes — the four questions round 1 did NOT answer.
import { createRequire } from "node:module";
import { startSpikeServer } from "./server.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const puppeteer = (await import(require.resolve("puppeteer-core"))).default;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (id, pass, detail) => {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} — ${JSON.stringify(detail)}`);
};

const { server, port } = await startSpikeServer(0);
const base = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("[pageerror]", error.message));

await page.goto(`${base}/fixture/host.html`, { waitUntil: "load" });
await page.evaluate((src) => window.__spike.mount(src), `${base}/fixture/index.html`);
await page.waitForFunction(() => window.__spike.runtimeMessages.some((m) => m.type === "timeline"), { timeout: 15000 });

// ---------------------------------------------------------------- S-P5
// The common edit: text changes, the [data-start] set does NOT. Does the
// runtime still publish a timeline? If not, "wait for timeline" is the wrong ack.
await page.evaluate(() => { window.__spike.player.pause(); window.__spike.player.seek(1); });
await sleep(400);

const textOnly = await page.evaluate(async () => {
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const before = {
    timelines: window.__spike.runtimeMessages.filter((m) => m.type === "timeline").length,
    title: doc.querySelector("#scene-1-title")?.textContent ?? null,
    clipIds: [...doc.querySelectorAll("[data-start]")].map((n) => n.id).join("|"),
  };
  const html = await (await fetch("compositions/scene-1-textonly.html")).text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((r) => setTimeout(r, 2500));
  return {
    before,
    afterTitle: doc.querySelector("#scene-1-title")?.textContent ?? null,
    afterClipIds: [...doc.querySelectorAll("[data-start]")].map((n) => n.id).join("|"),
    timelinesAfter: window.__spike.runtimeMessages.filter((m) => m.type === "timeline").length,
    statesAfter: window.__spike.runtimeMessages.filter((m) => m.type === "state").length,
  };
});
const republished = textOnly.timelinesAfter > textOnly.before.timelines;
record("S-P5 text-only swap: does runtime republish timeline?", republished, {
  visibleTextChanged: textOnly.afterTitle !== textOnly.before.title,
  clipSetUnchanged: textOnly.afterClipIds === textOnly.before.clipIds,
  republishedTimeline: republished,
  verdict: republished
    ? "timeline republished — 'wait for timeline' works as ack"
    : "NO timeline for content-only edits — ack must not depend on it",
});

// ---------------------------------------------------------------- S-P6
// Scene starting at t=6: are caption timings scene-local or root-absolute?
await page.evaluate(() => { window.__spike.player.seek(6.8); });
await sleep(600);
const sceneOffset = await page.evaluate(() => {
  const view = window.__spike.doc().defaultView;
  const doc = window.__spike.doc();
  const cue = doc.querySelector('[data-composition-id="scene-2"] .caption');
  return {
    rootTime: window.__spike.player.currentTime,
    captionProbe: view.__vidcomCaption ?? null,
    layerStart: doc.querySelector('[data-composition-id="scene-2"]')?.getAttribute("data-start") ?? null,
    cueSceneStart: cue?.getAttribute("data-scene-start") ?? null,
    activeInScene2: [...(cue?.querySelectorAll(".w.active") ?? [])].map((n) => n.textContent),
  };
});
// At root 6.8s the scene-local time is 0.8s ⇒ the word spanning 0.50–1.20 ("bốn")
// must light up. A script that treats spans as root-absolute lights nothing.
record(
  "S-P6 scene with start≠0: caption clock converts root→scene",
  sceneOffset.activeInScene2.includes("bốn"),
  { ...sceneOffset, expected: ["bốn"], note: "root 6.8s − layer start 6s = 0.8s scene-local ⇒ the 0.50–1.20 word lights up" },
);

// ---------------------------------------------------------------- S-P7
// fps is rational: {numerator, denominator}. Does Number(fps) work? And do 24/60 boot?
const fpsProbe = await page.evaluate(() => {
  const timeline = window.__spike.runtimeMessages.find((m) => m.type === "timeline");
  return { raw: timeline?.fps ?? null, viaNumber: Number(timeline?.fps), isNaN: Number.isNaN(Number(timeline?.fps)) };
});
const fpsVariants = {};
for (const fps of [24, 60]) {
  const page2 = await browser.newPage();
  await page2.goto(`${base}/fixture/host.html`, { waitUntil: "load" });
  await page2.evaluate((src) => window.__spike.mount(src), `${base}/fixture/index-fps${fps}.html`);
  const ok = await page2
    .waitForFunction(() => window.__spike.runtimeMessages.some((m) => m.type === "timeline"), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  fpsVariants[fps] = await page2.evaluate(() => {
    const timeline = window.__spike.runtimeMessages.find((m) => m.type === "timeline");
    return { booted: !!timeline, fps: timeline?.fps ?? null };
  });
  fpsVariants[fps].booted = fpsVariants[fps].booted && ok;
  await page2.close();
}
record("S-P7 fps is rational and must be parsed as such", fpsProbe.isNaN === true && fpsVariants[24].booted && fpsVariants[60].booted, {
  ...fpsProbe,
  variants: fpsVariants,
  verdict: "Number(fps) is NaN — caption clock MUST read {numerator, denominator}",
});

// ---------------------------------------------------------------- S-P8
// Root reload with the SAME url: does the iframe refetch, or serve from cache?
const sameUrl = await page.evaluate(async () => {
  const player = window.__spike.player;
  const url = player.getAttribute("src");
  const before = player.iframeElement.contentWindow.performance.timeOrigin;
  player.setAttribute("src", url); // identical string
  await new Promise((r) => setTimeout(r, 2500));
  let after = null;
  try { after = player.iframeElement.contentWindow.performance.timeOrigin; } catch {}
  return { url, reloaded: after !== null && after !== before, before, after };
});
record("S-P8 re-setting the identical src reloads the document", sameUrl.reloaded, {
  ...sameUrl,
  verdict: sameUrl.reloaded ? "same-URL reload works; no cache-buster needed" : "same URL is a no-op — reload needs a revisioned URL or cache-busting",
});

// ---------------------------------------------------------------- S-P9
// How long does a swap take end to end (R4.1c budget is 500 ms)?
const latency = await page.evaluate(async () => {
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const html = await (await fetch("compositions/scene-1-v2.html")).text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const started = performance.now();
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { paintedAfterMs: performance.now() - started, title: doc.querySelector("#scene-1-title")?.textContent ?? null };
});
record("S-P9 swap paints well inside the 500 ms budget", latency.paintedAfterMs < 500, latency);

await browser.close();
server.close();
console.log("\n=== ROUND 2 SUMMARY ===");
for (const item of results) console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.id}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
