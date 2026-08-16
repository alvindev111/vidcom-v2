import { createRequire } from "node:module";

// Repo root là 5 cấp trên thư mục này; puppeteer-core đã là devDependency của repo.
const repoRoot = new URL("../../../../../", import.meta.url);
const require = createRequire(new URL("package.json", repoRoot));
const puppeteer = (await import(require.resolve("puppeteer-core"))).default;

// Ảnh ghi cạnh chính script này.
const OUT = new URL(".", import.meta.url).pathname;
const URL = "https://motionvid.ai/motion-graphics/eoZFiUOYeluupHCW1X5V";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: false,
  args: ["--no-sandbox", "--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 }).catch((e) => console.log("goto:", e.message));
await sleep(12000);

// dismiss cookie banner
const clickText = async (text) => {
  const handle = await page.evaluateHandle((t) => {
    const nodes = [...document.querySelectorAll("button,a,[role=button]")];
    return nodes.find((n) => n.innerText?.trim().toLowerCase() === t.toLowerCase()) ?? null;
  }, text);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
};
console.log("deny:", await clickText("Deny"));
await sleep(1500);

const shot = async (name, clip) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  console.log("shot", name);
};

await shot("01-overview");
await shot("02-timeline", { x: 480, y: 780, width: 1120, height: 220 });

// left rail tabs
for (const tab of ["Edit", "Media", "Videos", "Fonts", "Colors", "Images", "Templates"]) {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button,[role=button],a")].find((n) => n.innerText?.trim() === t);
    if (!el) return false;
    el.click();
    return true;
  }, tab);
  if (!ok) { console.log("no tab", tab); continue; }
  await sleep(2500);
  await shot(`rail-${tab.toLowerCase()}`);
}

// back to Edit panel, click a timeline clip to reveal properties
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button,[role=button],a")].find((n) => n.innerText?.trim() === "Edit");
  el?.click();
});
await sleep(2000);
await shot("03-edit-panel");

await browser.close();
