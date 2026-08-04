// Sinh WAV 16-bit PCM mono hợp lệ, không cần ffmpeg — để test criterion 2 (render có narration).
import { writeFileSync } from "node:fs";
const [, , out, secondsRaw] = process.argv;
const seconds = Number(secondsRaw ?? 3);
const rate = 44100, samples = Math.round(rate * seconds);
const data = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i++) {
  // 440 Hz với envelope, để nghe được và ffprobe đọc được dữ liệu thật
  const env = Math.min(1, i / (rate * 0.05), (samples - i) / (rate * 0.05));
  data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000 * env), i * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(data.length, 40);
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} — ${seconds}s, ${rate}Hz mono 16-bit, ${(36 + data.length + 8)} bytes`);
