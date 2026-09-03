// 用法: node scripts/gen-style-thumbs.mjs   (需 .env 里 AGNES_API_KEY;已存在的缩略图跳过)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const KEY = env.AGNES_API_KEY;
const BASE = env.AGNES_API_BASE_URL || "https://api.agnes-ai.cn/v1";
// 从 lib/style-library.ts 正则抽出 id+name+prompt,避免引入 TS 运行时
const src = readFileSync("lib/style-library.ts", "utf8");
const entries = [...src.matchAll(/id: "([\w-]+)", name: "([^"]+)", category: "\w+", prompt: "([^"]+)"/g)].map(m => ({ id: m[1], name: m[2], prompt: m[3] }));

const QUALITY_TAG = "masterpiece, best quality, ultra-detailed, 8k uhd, highres, sharp focus";

function enhancePrompt(prompt) {
  const trimmed = prompt.trim();
  if (/masterpiece|best quality|ultra-detailed/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}, ${QUALITY_TAG}`;
}

for (const { id, name, prompt } of entries) {
  const out = resolve("public/styles", `${id}.png`);
  if (existsSync(out)) { console.log("skip", id); continue; }
  const enhancedPrompt = enhancePrompt(`${prompt},单张风格示意插画,无文字`);
  const res = await fetch(`${BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: enhancedPrompt, size: "1K" }),
  });
  const json = await res.json();
  const url = json?.data?.[0]?.url;
  if (!url) { console.error("FAIL", id, JSON.stringify(json).slice(0, 200)); continue; }
  const img = await fetch(url);
  writeFileSync(out, Buffer.from(await img.arrayBuffer()));
  console.log("ok", id, name);
}
