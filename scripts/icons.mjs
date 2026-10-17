// public/icon.svg から PNG アイコン一式を生成する（npm run icons）
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../public/icon.svg", import.meta.url));
const out = (name) => new URL(`../public/${name}`, import.meta.url).pathname;

await sharp(svg).resize(180, 180).png().toFile(out("apple-touch-icon.png"));
await sharp(svg).resize(192, 192).png().toFile(out("icon-192.png"));
await sharp(svg).resize(512, 512).png().toFile(out("icon-512.png"));
// maskable: 角丸を外して安全領域に収める
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#ffffff" } })
  .composite([{ input: await sharp(svg).resize(400, 400).png().toBuffer(), gravity: "center" }])
  .png()
  .toFile(out("icon-512-maskable.png"));
console.log("icons generated");
