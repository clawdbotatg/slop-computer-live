// Generate ONE icon for a new app and publish it into nextjs/public/icons/.
//
// Usage:
//   node add-icon.mjs <name> "<prompt>"
//   (or from repo root: `yarn workspace @slop/icon-gen add <name> "<prompt>"`)
//
// What it does:
//   1. Reads icons.json for model/style/styleHint settings + the style ref.
//   2. Generates a single icon via OpenAI images.edit using the style ref.
//   3. Writes it to ./out/icons/<name>.png (cache) AND
//      ../nextjs/public/icons/<name>.png (the path the relay's apps catalog
//      uses for `icon: "/icons/<name>.png"`).
//   4. Appends a { name, prompt } entry to icons.json so the batch
//      regenerator stays in sync.
//
// Pick a <name> that matches the app id in packages/relay/src/index.ts
// (e.g. "wallet", "browser", "glossary"). The icon is referenced as
// "/icons/<name>.png" in DEFAULT_APPS.

import OpenAI, { toFile } from "openai";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressIcon } from "./compress.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const localEnv = path.join(here, ".env");
if (fs.existsSync(localEnv)) process.loadEnvFile(localEnv);

const [, , rawName, ...promptParts] = process.argv;
const name = (rawName ?? "").trim();
const prompt = promptParts.join(" ").trim();

if (!name || !prompt) {
  console.error('usage: node add-icon.mjs <name> "<prompt>"');
  console.error('  e.g. node add-icon.mjs paint "An artist\'s paint-palette icon with paintbrush sticking out."');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`error: name must be kebab-case [a-z0-9-]+ (got "${name}")`);
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("error: OPENAI_API_KEY env var is required (set in packages/icon-gen/.env)");
  process.exit(1);
}

const configPath = path.join(here, "icons.json");
const cfg = JSON.parse(await fsp.readFile(configPath, "utf8"));
const {
  model = "gpt-image-1",
  style,
  size = "1024x1024",
  quality = "high",
  background = "transparent",
  styleHint,
} = cfg;

const styleAbs = path.resolve(here, style);
if (!fs.existsSync(styleAbs)) {
  console.error(`error: style reference not found: ${styleAbs}`);
  process.exit(1);
}

const cacheDir = path.join(here, "out", "icons");
const publicDir = path.resolve(here, "..", "nextjs", "public", "icons");
await fsp.mkdir(cacheDir, { recursive: true });
await fsp.mkdir(publicDir, { recursive: true });

const cacheFile = path.join(cacheDir, `${name}.png`);
const publicFile = path.join(publicDir, `${name}.png`);

if (fs.existsSync(publicFile)) {
  console.error(`error: ${publicFile} already exists. Delete it first or pick a different name.`);
  process.exit(1);
}

const fullPrompt = [
  prompt,
  styleHint,
  "Single subject, centered, isolated. No text, no watermark, no border.",
].join("\n");

const client = new OpenAI();
const ext = path.extname(styleAbs).slice(1).toLowerCase() || "png";
const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
const refFile = await toFile(await fsp.readFile(styleAbs), `style.${ext}`, { type: mime });

console.log(`Generating "${name}" (model=${model}, size=${size}, quality=${quality}) …`);
const t0 = Date.now();
const result = await client.images.edit({
  model,
  image: [refFile],
  prompt: fullPrompt,
  size,
  quality,
  background,
  n: 1,
});
const b64 = result.data[0]?.b64_json;
if (!b64) {
  console.error("error: no image data in response");
  process.exit(1);
}

const buf = Buffer.from(b64, "base64");
await fsp.writeFile(cacheFile, buf);
const compressed = await compressIcon(buf);
await fsp.writeFile(publicFile, compressed);
console.log(`  ✓ ${cacheFile}  (${(buf.length / 1024).toFixed(0)} KB raw)`);
console.log(
  `  ✓ ${publicFile}  (${(compressed.length / 1024).toFixed(0)} KB compressed, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);

if (Array.isArray(cfg.items)) {
  const existing = cfg.items.findIndex(i => i.name === name);
  if (existing === -1) {
    cfg.items.push({ name, prompt });
    await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`  ✓ appended { name: "${name}" } to icons.json`);
  } else {
    console.log(`  ⊙ icons.json already had "${name}"; not appending`);
  }
}

console.log(`\nDone. Reference it as "/icons/${name}.png" in the relay's DEFAULT_APPS entry.`);
