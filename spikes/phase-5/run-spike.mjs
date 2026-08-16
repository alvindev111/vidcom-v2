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
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("[pageerror]", error.message));
page.on("console", (message) => {
  const text = message.text();
  if (/error|Error/u.test(text)) console.log("[console]", text.slice(0, 200));
});

await page.goto(`${base}/fixture/host.html`, { waitUntil: "load" });
await page.evaluate((src) => window.__spike.mount(src), `${base}/fixture/index.html`);

// Wait for the runtime to publish its first timeline.
const booted = await page
  .waitForFunction(() => window.__spike.runtimeMessages.some((m) => m.type === "timeline"), { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
record("S-P0 runtime boots and publishes timeline", booted, {
  messages: await page.evaluate(() => window.__spike.runtimeMessages.map((m) => m.type).slice(0, 6)),
  fps: await page.evaluate(() => window.__spike.runtimeMessages.find((m) => m.type === "timeline")?.fps ?? null),
});

if (!booted) {
  console.log(await page.evaluate(() => document.getElementById("stage").innerHTML.slice(0, 400)));
}

// ---------------------------------------------------------------- S-P1
// Swap one sub-composition subtree in place; runtime must notice via its
// per-tick rescan of [data-start] and republish the timeline.
await page.evaluate(() => window.__spike.player.play());
await sleep(600);
await page.evaluate(() => window.__spike.player.pause());
await page.evaluate(() => window.__spike.player.seek(2));
await sleep(300);

const swap = await page.evaluate(async () => {
  const player = window.__spike.player;
  const before = {
    playerId: player.__spikeId,
    time: player.currentTime,
    timelineCount: window.__spike.runtimeMessages.filter((m) => m.type === "timeline").length,
  };
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  // What a real hot swap does: studio fetched the rebuilt scene HTML, parsed it,
  // and hands the agent the new body. Agent keeps the old children for rollback.
  const response = await fetch("compositions/scene-1-v2.html");
  const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
  const kept = [...layer.childNodes].map((n) => n.cloneNode(true));
  layer.replaceChildren(...[...parsed.body.childNodes].map((n) => doc.importNode(n, true)));
  const extra = doc.createElement("p");
  extra.className = "clip";
  extra.id = "swapped-extra";
  extra.setAttribute("data-start", "1");
  extra.setAttribute("data-duration", "2");
  extra.textContent = "extra clip";
  layer.appendChild(extra);
  window.__spikeKept = kept;
  return { before };
});

const swapNoticed = await page
  .waitForFunction(
    (baseline) => window.__spike.runtimeMessages.filter((m) => m.type === "timeline").length > baseline,
    { timeout: 4000 },
    swap.before.timelineCount,
  )
  .then(() => true)
  .catch(() => false);

const manifestPicksUpExtra = await page
  .waitForFunction(
    () => JSON.stringify(window.__spike.doc().defaultView.__clipManifest ?? {}).includes("swapped-extra"),
    { timeout: 4000, polling: 200 },
  )
  .then(() => true)
  .catch(() => false);

const afterSwap = await page.evaluate((before) => {
  const player = window.__spike.player;
  const doc = window.__spike.doc();
  const manifest = doc.defaultView.__clipManifest ?? {};
  return {
    playerIdentical: player.__spikeId === before.playerId,
    swappedTitle: doc.querySelector("#scene-1-title")?.textContent ?? null,
    manifestHasExtra: JSON.stringify(manifest).includes("swapped-extra"),
    timeAfter: player.currentTime,
    timeBefore: before.time,
    playing: !player.paused,
  };
}, swap.before);

record("S-P1 in-place subtree swap picked up by runtime rescan", swapNoticed && afterSwap.playerIdentical && manifestPicksUpExtra, {
  manifestPicksUpExtra,
  ...afterSwap,
  driftFrames: Math.abs(afterSwap.timeAfter - afterSwap.timeBefore) * 30,
  noticedNewTimeline: swapNoticed,
});

// ---------------------------------------------------------------- S-P4
// Caption highlight must follow the runtime clock across play, seek and rate.
const captionPlay = await page.evaluate(() => window.__vidcomCaptionProbe ?? window.__spike.doc().defaultView.__vidcomCaption);
await page.evaluate(() => window.__spike.player.seek(1.4));
await sleep(400);
const captionAtSeek = await page.evaluate(() => window.__spike.doc().defaultView.__vidcomCaption);
await page.evaluate(() => { window.__spike.player.playbackRate = 2; });
await sleep(400);
const captionAtRate = await page.evaluate(() => window.__spike.doc().defaultView.__vidcomCaption);
await page.evaluate(() => window.__spike.player.pause());
await page.evaluate(() => window.__spike.player.seek(2.4));
await sleep(400);
const captionPaused = await page.evaluate(() => window.__spike.doc().defaultView.__vidcomCaption);

record(
  "S-P4 caption highlight follows runtime clock (play/seek/rate/pause)",
  captionAtSeek?.active?.includes("hai") === true && captionPaused?.active?.includes("ba") === true,
  { play: captionPlay?.active ?? null, seek1_4: captionAtSeek?.active ?? null, rate2: captionAtRate?.active ?? null, pausedSeek2_4: captionPaused?.active ?? null },
);

// ---------------------------------------------------------------- S-P2
// Failure path: swap in a subtree whose script throws; agent must restore the
// previous node and the canvas must keep showing the old frame.
const failure = await page.evaluate(async () => {
  const doc = window.__spike.doc();
  const layer = doc.querySelector('[data-composition-id="scene-1"]');
  const beforeTitle = doc.querySelector("#scene-1-title")?.textContent ?? null;
  const kept = [...layer.childNodes].map((n) => n.cloneNode(true));
  const broken = doc.createElement("div");
  broken.innerHTML = '<h1 id="scene-1-title">BROKEN</h1>';
  const script = doc.createElement("script");
  script.textContent = 'throw new Error("scene boom")';
  layer.replaceChildren(broken, script);
  await new Promise((r) => setTimeout(r, 400));
  const brokenVisible = doc.querySelector("#scene-1-title")?.textContent ?? null;
  // Agent rollback path.
  layer.replaceChildren(...kept);
  await new Promise((r) => setTimeout(r, 500));
  return {
    beforeTitle,
    brokenVisible,
    restoredTitle: doc.querySelector("#scene-1-title")?.textContent ?? null,
    playerAlive: !!window.__spike.player.iframeElement.contentDocument,
    runtimeStillPublishing: window.__spike.runtimeMessages.filter((m) => m.type === "state").length > 0,
  };
});
record("S-P2 failed swap can be rolled back in place", failure.restoredTitle === failure.beforeTitle && failure.playerAlive && failure.runtimeStillPublishing, failure);

// ---------------------------------------------------------------- S-P3
// Root reload: preflight a hidden iframe before touching the player's src.
const preflight = await page.evaluate(async (urls) => {
  // Preflight with an offscreen player, not a bare iframe: the runtime only boots
  // when the player injects it (`_injectRuntime`), and it needs a real layout box.
  // Success signal is the player's own `ready` + `duration`, which needs no
  // message routing between two live players on the same page.
  const probe = async (url) => {
    const element = document.createElement("hyperframes-player");
    element.style.cssText = "position:absolute;left:0;top:0;width:320px;height:180px;opacity:0.01;z-index:-1";
    element.setAttribute("src", url);
    document.body.appendChild(element);
    const deadline = performance.now() + 6000;
    let ok = false;
    while (performance.now() < deadline) {
      if (element.ready && element.duration > 0) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    const detail = { ready: element.ready, duration: element.duration };
    element.remove();
    return { ok, why: ok ? "ready+duration" : "timeout", detail };
  };
  const good = await probe(urls.good);
  const before = window.__spike.player.getAttribute("src");
  const bad = await probe(urls.bad);
  return { good, bad, srcUnchangedAfterBadPreflight: window.__spike.player.getAttribute("src") === before };
}, { good: `${base}/fixture/index.html`, bad: `${base}/fixture/broken-root.html` });

record("S-P3 offscreen-player preflight gates root reload", preflight.good.ok && !preflight.bad.ok && preflight.srcUnchangedAfterBadPreflight, preflight);

// Root reload happy path: keep player identity and restore transport.
const rootReload = await page.evaluate(async () => {
  const player = window.__spike.player;
  const before = { id: player.__spikeId, time: player.currentTime, paused: player.paused };
  player.setAttribute("src", player.getAttribute("src") + "?r=2");
  await new Promise((resolve) => {
    if (player.ready) return resolve();
    player.addEventListener("ready", () => resolve(), { once: true });
    setTimeout(resolve, 6000);
  });
  player.seek(before.time);
  await new Promise((r) => setTimeout(r, 300));
  return { before, after: { id: player.__spikeId, time: player.currentTime }, drift: Math.abs(player.currentTime - before.time) * 30 };
});
record("S-P3b root reload keeps player instance and transport", rootReload.before.id === rootReload.after.id && rootReload.drift <= 1, rootReload);

await browser.close();
server.close();

console.log("\n=== SPIKE SUMMARY ===");
for (const item of results) console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.id}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
