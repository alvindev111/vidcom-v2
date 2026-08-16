// Round 4 — fixes a measurement error in S-P12 and probes the two things
// round 3 could not answer: asset resolution after a swap, and whether a
// double-buffered root reload keeps the last frame on screen.
import { createRequire } from "node:module";
import { startSpikeServer } from "./server.mjs";

const require = createRequire(new URL("../../package.json", import.meta.url));
const puppeteer = (await import(require.resolve("puppeteer-core"))).default;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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
await page.waitForFunction(() => window.__spike.runtimeMessages.some((m) => m.type === "timeline"), { timeout: 15000 });

// ---------------------------------------------------------------- S-P14
// S-P12 was wrong: it preflighted the OLD root (still pointing at scene-1.html)
// while swapping in v2. Preflight the rebuilt root, assert the hidden document
// really contains v2, and measure cold cache too.
const e2e = await page.evaluate(async (urls) => {
  const measure = async (rootUrl, sceneUrl, cacheBust) => {
    const doc = window.__spike.doc();
    const layer = doc.querySelector('[data-composition-id="scene-1"]');
    const started = performance.now();
    const bust = cacheBust ? `?cb=${Date.now()}` : "";

    const fetched = await (await fetch(sceneUrl + bust, cacheBust ? { cache: "reload" } : {})).text();
    const parsed = new DOMParser().parseFromString(fetched, "text/html");
    const afterFetch = performance.now();

    const probe = document.createElement("hyperframes-player");
    probe.style.cssText = "position:absolute;left:0;top:0;width:320px;height:180px;opacity:0.01;z-index:-1";
    probe.setAttribute("src", rootUrl + bust);
    document.body.appendChild(probe);
    const health = { ready: false, timeline: false, scriptErrors: 0, rejections: 0, resourceErrors: 0 };
    const onMessage = (event) => {
      let inner = null;
      try { inner = probe.iframeElement?.contentWindow ?? null; } catch {}
      if (inner && event.source === inner && event.data?.source === "hf-preview" && event.data.type === "timeline") health.timeline = true;
    };
    window.addEventListener("message", onMessage);
    const deadline = performance.now() + 8000;
    let hiddenTitle = null;
    while (performance.now() < deadline) {
      if (probe.ready && probe.duration > 0) {
        health.ready = true;
        try {
          const hiddenDoc = probe.iframeElement.contentDocument;
          hiddenTitle = hiddenDoc?.querySelector("#scene-1-title")?.textContent ?? null;
          const view = hiddenDoc?.defaultView;
          if (view && !view.__spikeHealthHooked) {
            view.__spikeHealthHooked = true;
            view.addEventListener("error", () => { health.scriptErrors += 1; }, true);
            view.addEventListener("unhandledrejection", () => { health.rejections += 1; });
          }
        } catch {}
        if (hiddenTitle) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    window.removeEventListener("message", onMessage);
    probe.remove();
    const afterPreflight = performance.now();

    layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
    for (const stale of [...layer.querySelectorAll("script")]) {
      const fresh = doc.createElement("script");
      for (const attribute of stale.attributes) fresh.setAttribute(attribute.name, attribute.value);
      fresh.textContent = stale.textContent;
      stale.replaceWith(fresh);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const painted = performance.now();

    return {
      hiddenTitle,
      health,
      fetchMs: Math.round(afterFetch - started),
      preflightMs: Math.round(afterPreflight - afterFetch),
      swapPaintMs: Math.round(painted - afterPreflight),
      totalMs: Math.round(painted - started),
      liveTitle: doc.querySelector("#scene-1-title")?.textContent ?? null,
    };
  };
  const warm = await measure(urls.rootV2, urls.sceneV2, false);
  const cold = await measure(urls.rootV2, urls.sceneV2, true);
  return { warm, cold };
}, { rootV2: `${base}/compiled/root-v2.html`, sceneV2: `${base}/project-files/compositions/scene-1-v2.html` });

record(
  "S-P14 preflight really loads the REBUILT scene, and the budget holds",
  e2e.warm.hiddenTitle?.includes("SWAPPED") === true
    && e2e.warm.health.ready && e2e.warm.health.timeline
    && e2e.warm.totalMs < 500 && e2e.cold.totalMs < 500,
  e2e,
);

// ---------------------------------------------------------------- S-P15
// Asset resolution: after swapping in a scene that references ../assets/*,
// do the <img>, the <link> stylesheet and the CSS url() still resolve?
const assets = await page.evaluate(async (sceneUrl) => {
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const fetched = await (await fetch(sceneUrl)).text();
  const parsed = new DOMParser().parseFromString(fetched, "text/html");
  // head assets of the scene, merged into the root head under a scene key
  for (const stale of [...doc.head.querySelectorAll('[data-hf-scene-asset="scene-1"]')]) stale.remove();
  for (const node of [...parsed.head.querySelectorAll("link, style")]) {
    const fresh = doc.importNode(node, true);
    fresh.setAttribute("data-hf-scene-asset", "scene-1");
    doc.head.appendChild(fresh);
  }
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((r) => setTimeout(r, 800));

  const image = doc.querySelector("#asset-img");
  const styled = doc.querySelector("#asset-css");
  const linkNode = doc.head.querySelector('link[data-hf-scene-asset="scene-1"]');
  const computed = styled ? doc.defaultView.getComputedStyle(styled).backgroundImage : null;
  return {
    imgSrcResolved: image?.src.replace(location.origin, "") ?? null,
    imgLoaded: image ? image.naturalWidth > 0 : null,
    linkHrefResolved: linkNode?.href.replace(location.origin, "") ?? null,
    cssBackground: computed,
    cssApplied: computed !== null && computed !== "none",
    baseHref: doc.querySelector("base")?.getAttribute("href") ?? null,
  };
}, `${base}/project-files/compositions/scene-1-assets.html`);
record(
  "S-P15 naive swap BREAKS relative asset URLs (expected failure, documented)",
  assets.imgLoaded === false && assets.cssApplied === false,
  { ...assets, note: "scene refs are ../assets/*; the root document's <base> decides where they land" },
);

// ---------------------------------------------------------------- S-P15b
// The fix: rewrite every relative URL in the patch against the SCENE's own URL
// before inserting it into the root document.
const assetsFixed = await page.evaluate(async (sceneUrl) => {
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const fetched = await (await fetch(sceneUrl)).text();
  const parsed = new DOMParser().parseFromString(fetched, "text/html");

  const absolutize = (root) => {
    const attributes = [["img", "src"], ["source", "src"], ["video", "src"], ["audio", "src"], ["link", "href"], ["script", "src"], ["image", "href"], ["use", "href"]];
    for (const [selector, attribute] of attributes) {
      for (const node of root.querySelectorAll(selector)) {
        const value = node.getAttribute(attribute);
        if (!value || /^(https?:|data:|blob:|#|\/)/u.test(value)) continue;
        node.setAttribute(attribute, new URL(value, sceneUrl).href);
      }
    }
    for (const node of root.querySelectorAll("[style]")) {
      const style = node.getAttribute("style");
      if (style?.includes("url(")) {
        node.setAttribute("style", style.replace(/url\((["']?)([^"')]+)\1\)/gu, (whole, quote, value) =>
          /^(https?:|data:|blob:|\/)/u.test(value) ? whole : `url(${quote}${new URL(value, sceneUrl).href}${quote})`));
      }
    }
  };
  absolutize(parsed.head);
  absolutize(parsed.body);

  for (const stale of [...doc.head.querySelectorAll('[data-hf-scene-asset="scene-1"]')]) stale.remove();
  for (const node of [...parsed.head.querySelectorAll("link, style")]) {
    const fresh = doc.importNode(node, true);
    fresh.setAttribute("data-hf-scene-asset", "scene-1");
    doc.head.appendChild(fresh);
  }
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  await new Promise((r) => setTimeout(r, 900));

  const image = doc.querySelector("#asset-img");
  const styled = doc.querySelector("#asset-css");
  const computed = styled ? doc.defaultView.getComputedStyle(styled).backgroundImage : null;
  return {
    imgSrcResolved: image?.src.replace(location.origin, "") ?? null,
    imgLoaded: image ? image.naturalWidth > 0 : null,
    cssBackground: computed?.replace(location.origin, "") ?? null,
    cssApplied: computed !== null && computed !== "none",
  };
}, `${base}/project-files/compositions/scene-1-assets.html`);
record(
  "S-P15b rewriting relative URLs against the scene URL fixes asset resolution",
  assetsFixed.imgLoaded === true && assetsFixed.cssApplied === true,
  assetsFixed,
);

// ---------------------------------------------------------------- S-P16
// Double-buffered root reload: mount the new root in a second player behind the
// first, and only swap visibility once it is healthy. The old player keeps
// painting the whole time, so the last frame never disappears.
const doubleBuffer = await page.evaluate(async (rootV2) => {
  const stage = document.getElementById("stage");
  const live = window.__spike.player;
  const before = { time: live.currentTime, paused: live.paused, id: live.__spikeId };

  const next = document.createElement("hyperframes-player");
  next.style.cssText = "position:absolute;inset:0;opacity:0;pointer-events:none";
  next.setAttribute("src", rootV2);
  stage.appendChild(next);

  const deadline = performance.now() + 8000;
  let healthy = false;
  while (performance.now() < deadline) {
    if (next.ready && next.duration > 0) { healthy = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  const liveStillPainting = !!live.iframeElement?.contentDocument?.querySelector("[data-composition-id]");
  if (!healthy) { next.remove(); return { healthy, liveStillPainting, swapped: false }; }

  next.seek(before.time);
  if (!before.paused) next.play();
  next.style.opacity = "1";
  live.style.opacity = "0";
  await new Promise((r) => setTimeout(r, 300));
  const after = { time: next.currentTime, duration: next.duration };
  live.remove();
  window.__spike.player = next;
  return {
    healthy,
    liveStillPainting,
    swapped: true,
    driftFrames: Math.abs(after.time - before.time) * 30,
    before,
    after,
  };
}, `${base}/compiled/root-v2.html`);
record(
  "S-P16 double-buffered root reload keeps the old frame until the new one is healthy",
  doubleBuffer.healthy && doubleBuffer.liveStillPainting && doubleBuffer.swapped && doubleBuffer.driftFrames <= 1,
  doubleBuffer,
);

await browser.close();
server.close();
console.log("\n=== ROUND 4 SUMMARY ===");
for (const item of results) console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.id}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
