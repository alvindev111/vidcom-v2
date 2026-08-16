// Round 5 — double-buffer is now THE reload mechanism (user decision 2026-08-16),
// so it gets measured properly: full transport matrix, health collected from
// before the first authored script runs, and an unhealthy buffer that must be rejected.
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
page.on("pageerror", (error) => console.log("[pageerror]", error.message.slice(0, 70)));
await page.goto(`${base}/fixture/host.html`, { waitUntil: "load" });

// The host helper mirrors the designed PlayerHost: a stable wrapper that owns
// transport and swaps the engine element underneath.
await page.evaluate((rootUrl) => {
  const stage = document.getElementById("stage");
  window.__host = {
    identity: "player-host-1",
    engineGeneration: 0,
    engine: null,
    async mount(url) {
      const engine = document.createElement("hyperframes-player");
      engine.style.cssText = "position:absolute;inset:0";
      engine.setAttribute("src", url);
      engine.__generation = ++window.__host.engineGeneration;
      stage.appendChild(engine);
      window.__host.engine = engine;
      await window.__host.waitHealthy(engine);
      return engine;
    },
    /** PreflightHealth: hook as early as the document exists, wait for sub-compositions
     *  to actually load, then require a quiet window with zero errors. `ready + timeline`
     *  alone resolves BEFORE authored scene scripts have run (measured in round 5). */
    waitHealthy(engine, timeout = 2500, quietMs = 150) {
      return new Promise((resolve) => {
        const health = { ready: false, timeline: false, scenesLoaded: false, collectorSeen: false, scriptErrors: 0, rejections: 0, resourceErrors: 0 };
        let hooked = false;   // true once the injected collector is readable
        // Read the collector the daemon injected as the first head script. Attaching
        // listeners from here is too late: an authored root script runs during parse.
        const hook = () => {
          let view = null;
          try { view = engine.iframeElement?.contentWindow ?? null; } catch {}
          const injected = view?.__vidcomHealth;
          if (!injected) return;
          hooked = true;
          health.collectorSeen = true;
          health.scriptErrors = injected.scriptErrors;
          health.rejections = injected.rejections;
          health.resourceErrors = injected.resourceErrors;
        };
        const onMessage = (event) => {
          let inner = null;
          try { inner = engine.iframeElement?.contentWindow ?? null; } catch {}
          if (inner && event.source === inner && event.data?.source === "hf-preview" && event.data.type === "timeline") health.timeline = true;
        };
        window.addEventListener("message", onMessage);
        const started = performance.now();
        let settledAt = null;
        const tick = setInterval(() => {
          hook();
          if (engine.ready && engine.duration > 0) health.ready = true;
          // Every declared sub-composition must have loaded its children, otherwise a
          // scene script that throws has simply not run yet.
          let scenesLoaded = false;
          try {
            const doc = engine.iframeElement?.contentDocument;
            const layers = [...(doc?.querySelectorAll("[data-composition-src]") ?? [])];
            scenesLoaded = layers.length > 0 && layers.every((layer) => layer.childElementCount > 0);
          } catch {}
          health.scenesLoaded = scenesLoaded;
          const failed = health.scriptErrors > 0 || health.rejections > 0 || health.resourceErrors > 0;
          const structurallyReady = health.ready && health.timeline && health.scenesLoaded && health.collectorSeen;
          if (structurallyReady && settledAt === null) settledAt = performance.now();
          if (!structurallyReady) settledAt = null;
          const quiet = settledAt !== null && performance.now() - settledAt >= quietMs;
          if (quiet || failed || performance.now() - started > timeout) {
            clearInterval(tick);
            window.removeEventListener("message", onMessage);
            resolve({ ok: quiet && !failed, health, waitedMs: Math.round(performance.now() - started) });
          }
        }, 25);
      });
    },
    /** Reload = build a second engine behind the live one, swap only when healthy. */
    async reload(url) {
      const live = window.__host.engine;
      const next = document.createElement("hyperframes-player");
      next.style.cssText = "position:absolute;inset:0;opacity:0;pointer-events:none";
      next.setAttribute("src", url);
      next.__generation = ++window.__host.engineGeneration;
      stage.appendChild(next);
      const health = await window.__host.waitHealthy(next);
      // Sample transport AT swap time: the clock kept running through preflight, and
      // sampling before it costs one frame per ~30 ms of wait (measured: 11 frames).
      const transport = { time: live.currentTime, paused: live.paused, rate: live.playbackRate, muted: live.muted };
      if (!health.ok) { next.remove(); return { swapped: false, health, transport, liveAlive: !!live.iframeElement?.contentDocument }; }
      const clamped = Math.min(transport.time, Math.max(0, next.duration));
      next.seek(clamped);
      next.playbackRate = transport.rate;
      next.muted = transport.muted;
      if (!transport.paused) next.play();
      next.style.opacity = "1";
      next.style.pointerEvents = "";
      live.remove();
      window.__host.engine = next;
      const immediate = { time: next.currentTime, paused: next.paused, rate: next.playbackRate, muted: next.muted };
      await new Promise((r) => setTimeout(r, 250));
      return {
        swapped: true, health, transport, clamped, immediate,
        after: { time: next.currentTime, paused: next.paused, rate: next.playbackRate, muted: next.muted, duration: next.duration },
      };
    },
  };
  return window.__host.mount(rootUrl);
}, `${base}/compiled/root.html`);

// ---------------------------------------------------------------- S-P17
// Transport matrix: playing, non-zero time, rate and muted must all survive.
const matrix = await page.evaluate(async (rootV2) => {
  const host = window.__host;
  host.engine.seek(3.5);
  host.engine.playbackRate = 1.5;
  host.engine.muted = true;
  host.engine.play();
  await new Promise((r) => setTimeout(r, 500));
  const before = { time: host.engine.currentTime, paused: host.engine.paused, rate: host.engine.playbackRate, muted: host.engine.muted, generation: host.engine.__generation };
  const result = await host.reload(rootV2);
  return { before, result, hostIdentityStable: host.identity === "player-host-1", generationAfter: host.engine.__generation };
}, `${base}/compiled/root-v2.html`);
record(
  "S-P17 buffer swap preserves time, play state, rate and muted",
  matrix.result.swapped
    && Math.abs(matrix.result.immediate.time - matrix.result.clamped) * 30 <= 1
    && matrix.result.after.paused === matrix.result.transport.paused
    && matrix.result.after.rate === matrix.result.transport.rate
    && matrix.result.after.muted === matrix.result.transport.muted
    && matrix.hostIdentityStable,
  { ...matrix, driftFrames: Math.abs(matrix.result.immediate.time - matrix.result.clamped) * 30,
    note: "drift measured at the swap instant; `after` is 250 ms later and legitimately advanced because playback continued" },
);

// ---------------------------------------------------------------- S-P18
// A broken root must be rejected by the health contract, and the live engine
// must keep painting — this is the R4.6 guarantee, measured.
const rejected = await page.evaluate(async (brokenUrl) => {
  const host = window.__host;
  const liveGenerationBefore = host.engine.__generation;
  const before = { time: host.engine.currentTime, title: host.engine.iframeElement?.contentDocument?.querySelector("#scene-1-title")?.textContent ?? null };
  const result = await host.reload(brokenUrl);
  await new Promise((r) => setTimeout(r, 200));
  return {
    result,
    liveGenerationAfter: host.engine.__generation,
    sameEngine: host.engine.__generation === liveGenerationBefore,
    stillPainting: !!host.engine.iframeElement?.contentDocument?.querySelector("[data-composition-id]"),
    titleNow: host.engine.iframeElement?.contentDocument?.querySelector("#scene-1-title")?.textContent ?? null,
    before,
  };
}, `${base}/compiled/root-missing.html`);
record(
  "S-P18 buffer whose scene never loads is rejected; the live frame survives",
  rejected.result.swapped === false && rejected.sameEngine && rejected.stillPainting,
  rejected,
);

// ---------------------------------------------------------------- S-P19
// Shorter new duration must clamp instead of leaving the playhead past the end.
const clamp = await page.evaluate(async (shortUrl) => {
  const host = window.__host;
  host.engine.pause();
  host.engine.seek(9);
  await new Promise((r) => setTimeout(r, 200));
  const before = host.engine.currentTime;
  const result = await host.reload(shortUrl);
  return { before, result };
}, `${base}/compiled/root-short.html`);
record(
  "S-P19 playhead clamps to the new (shorter) duration",
  clamp.result.swapped && clamp.result.after.time <= clamp.result.after.duration + 0.001 && clamp.result.after.duration < clamp.before,
  clamp,
);

// ---------------------------------------------------------------- S-P20
// Collector proof: a root that LOADS fine (scenesLoaded true) but whose own script
// throws and whose <img> 404s must be rejected, and rejected fast.
const collector = await page.evaluate(async (badUrl) => {
  const host = window.__host;
  const started = performance.now();
  const result = await host.reload(badUrl);
  return { result, elapsedMs: Math.round(performance.now() - started), stillPainting: !!host.engine.iframeElement?.contentDocument?.querySelector("[data-composition-id]") };
}, `${base}/compiled/root-rooterror.html`);
record(
  "S-P20 health collector catches a throwing root script and a 404 resource",
  collector.result.swapped === false
    && (collector.result.health.health.scriptErrors > 0 || collector.result.health.health.resourceErrors > 0)
    && collector.elapsedMs < 3000
    && collector.stillPainting,
  collector,
);

await browser.close();
server.close();
console.log("\n=== ROUND 5 SUMMARY ===");
for (const item of results) console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.id}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
