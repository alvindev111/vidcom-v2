// Round 3 — run against the PRODUCTION preview builder.
// The document under test is built by `buildSubCompositionHtml` (the same call
// packages/adapter/src/hyperframes/document.ts makes), served with production-shaped
// routes: compiled root at /compiled/root.html, raw project files under /project-files/.
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
page.on("pageerror", (error) => console.log("[pageerror]", error.message.slice(0, 80)));

await page.goto(`${base}/fixture/host.html`, { waitUntil: "load" });
await page.evaluate((src) => window.__spike.mount(src), `${base}/compiled/root.html`);
const booted = await page
  .waitForFunction(() => window.__spike.runtimeMessages.some((m) => m.type === "timeline"), { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
record("S-P10a compiled production document boots", booted, {
  loadedFrom: "/compiled/root.html (buildSubCompositionHtml)",
  sceneInlined: await page.evaluate(() => !!window.__spike.doc().querySelector("#scene-1-title")),
});

// ---------------------------------------------------------------- S-P10
// Parity: the runtime fetched compositions/scene-1.html itself (resolved through
// <base href>). Our hot swap fetches the SAME url and replaces children. If the
// resulting DOM differs from what the runtime produced, the patch pipeline is wrong.
const parity = await page.evaluate(async () => {
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const nativeHtml = layer.innerHTML;
  const sceneUrl = new URL(layer.getAttribute("data-composition-src"), doc.baseURI).href;
  const fetched = await (await fetch(sceneUrl)).text();
  const parsed = new DOMParser().parseFromString(fetched, "text/html");
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((r) => setTimeout(r, 300));
  const patchedHtml = layer.innerHTML;
  const strip = (html) => html.replace(/\s+/gu, " ").trim();
  return {
    sceneUrl: sceneUrl.replace(location.origin, ""),
    identical: strip(nativeHtml) === strip(patchedHtml),
    nativeSample: strip(nativeHtml).slice(0, 120),
    patchedSample: strip(patchedHtml).slice(0, 120),
    baseHref: doc.querySelector("base")?.getAttribute("href") ?? null,
  };
});
record("S-P10 hot-swap patch matches what the runtime loads natively", parity.identical, parity);

// ---------------------------------------------------------------- S-P11
// Health: does `ready && duration > 0` catch a scene whose script throws?
// S-P2 suggested no. Measure it, and measure what DOES catch it.
const health = await page.evaluate(async () => {
  const doc = window.__spike.doc();
  const view = doc.defaultView;
  const signals = { errors: 0, rejections: 0, resourceErrors: 0 };
  view.addEventListener("error", (event) => {
    if (event.target && event.target !== view) signals.resourceErrors += 1;
    else signals.errors += 1;
  }, true);
  view.addEventListener("unhandledrejection", () => { signals.rejections += 1; });

  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const fetched = await (await fetch(new URL("compositions/scene-1-broken.html", doc.baseURI).href)).text();
  const parsed = new DOMParser().parseFromString(fetched, "text/html");
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((r) => setTimeout(r, 600));
  const naive = { sideEffectRan: view.__sceneSideEffect ?? 0, errors: signals.errors, scriptsInDom: layer.querySelectorAll("script").length };

  // Re-create every <script> so the browser actually executes it. Nodes coming from
  // DOMParser/importNode are flagged "already started" and never run.
  for (const stale of [...layer.querySelectorAll("script")]) {
    const fresh = doc.createElement("script");
    for (const attribute of stale.attributes) fresh.setAttribute(attribute.name, attribute.value);
    fresh.textContent = stale.textContent;
    stale.replaceWith(fresh);
  }
  await new Promise((r) => setTimeout(r, 700));
  const recreated = { sideEffectRan: view.__sceneSideEffect ?? 0, errors: signals.errors, tick: view.__sceneTick ?? 0 };

  const player = window.__spike.player;
  return { playerReady: player.ready, playerDuration: player.duration, naive, recreated };
});
record(
  "S-P11 scripts in a swapped subtree DO NOT execute unless re-created",
  health.naive.sideEffectRan === 0 && health.naive.scriptsInDom > 0 && health.recreated.sideEffectRan > 0,
  { ...health, verdict: "DOMParser/importNode marks scripts already-started; a naive swap ships a scene whose animation code never runs" },
);
record(
  "S-P11b `ready && duration` does not catch a throwing scene; an error listener does",
  health.playerReady === true && health.playerDuration > 0 && health.recreated.errors > 0,
  { playerReady: health.playerReady, playerDuration: health.playerDuration, errorsSeen: health.recreated.errors,
    verdict: "preflight health must listen for error/unhandledrejection/resource-error" },
);

// ---------------------------------------------------------------- S-P13
// Removing the <script> node does not undo what the script already did.
const sideEffects = await page.evaluate(async () => {
  const doc = window.__spike.doc();
  const view = doc.defaultView;
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const tickBefore = view.__sceneTick ?? 0;
  const fetched = await (await fetch(new URL("compositions/scene-1.html", doc.baseURI).href)).text();
  const parsed = new DOMParser().parseFromString(fetched, "text/html");
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((r) => setTimeout(r, 600));
  const tickAfter = view.__sceneTick ?? 0;
  return { tickBefore, tickAfter, stillTicking: tickAfter > tickBefore, globalsLeft: view.__sceneSideEffect ?? 0 };
});
record("S-P13 rolling back the DOM does NOT stop a scene's side effects", sideEffects.stillTicking, {
  ...sideEffects,
  verdict: "swap needs a dispose contract (timers/listeners) — DOM replacement alone leaks the old scene's timers",
});

// ---------------------------------------------------------------- S-P12
// End-to-end latency for R4.1c: write-response → fetch → preflight → live swap → paint.
const e2e = await page.evaluate(async (compiledRoot) => {
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const started = performance.now();

  // 1. fetch the rebuilt scene (what the daemon just wrote)
  const fetched = await (await fetch(new URL("compositions/scene-1-v2.html", doc.baseURI).href)).text();
  const parsed = new DOMParser().parseFromString(fetched, "text/html");
  const afterFetch = performance.now();

  // 2. hidden preflight: mount the compiled root in an offscreen player
  const probeStart = performance.now();
  const probe = document.createElement("hyperframes-player");
  probe.style.cssText = "position:absolute;left:0;top:0;width:320px;height:180px;opacity:0.01;z-index:-1";
  probe.setAttribute("src", compiledRoot);
  document.body.appendChild(probe);
  const deadline = performance.now() + 8000;
  let preflightOk = false;
  while (performance.now() < deadline) {
    if (probe.ready && probe.duration > 0) { preflightOk = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  probe.remove();
  const afterPreflight = performance.now();

  // 3. live swap + first painted frame
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const painted = performance.now();

  return {
    preflightOk,
    fetchMs: Math.round(afterFetch - started),
    preflightMs: Math.round(afterPreflight - probeStart),
    swapPaintMs: Math.round(painted - afterPreflight),
    totalMs: Math.round(painted - started),
    title: doc.querySelector("#scene-1-title")?.textContent ?? null,
  };
}, `${base}/compiled/root.html`);
record("S-P12 end-to-end swap fits the 500 ms budget of R4.1c", e2e.totalMs < 500, e2e);

await browser.close();
server.close();
console.log("\n=== ROUND 3 SUMMARY ===");
for (const item of results) console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.id}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
