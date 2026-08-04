// Mô phỏng đúng buildNarrationHtml() của VidCom: <audio class="clip hf-narration" data-start data-duration>
// data-start lấy từ data-* của document (P1), không lấy từ sidecar.
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
let html = readFileSync(file, "utf8");
const marker = '<div data-hf-id="hf-dhbi" id="scene-1-layer"';
if (!html.includes(marker)) { console.error("marker not found"); process.exit(1); }
const audio = '<audio class="clip hf-narration" src="narration/scene-1.wav" data-start="10" data-duration="2.5" data-track-index="200"></audio>\n';
html = html.replace(marker, audio + marker);
writeFileSync(file, html);
console.log("injected <audio class=\"clip hf-narration\"> at data-start=10 duration=2.5");
