// Batch icon-set generator using OpenAI gpt-image-1.
//
// Usage:
//   OPENAI_API_KEY=sk-... node generate.mjs <config.json>
//   (or just `yarn gen` — uses icons.json)
//
// Reads `<config.json>` (default: icons.json), generates every icon in
// `items[]` that doesn't already exist on disk, composites them into a
// single sheet, and writes a manifest.
//
// To add ONE icon for a new app, prefer `node add-icon.mjs <name> "<prompt>"`
// — it also publishes the result into packages/nextjs/public/icons/.
//
// Strategy (per the gpt-image-1 community guidance):
//   1. Use ONE style-reference image to lock palette/stroke/lighting.
//   2. Generate each icon individually via images.edit, passing the ref.
//   3. Composite the grid locally with sharp — never ask the model to
//      assemble the sheet, that's where it falls apart.
//
// If `style` doesn't exist on disk and `bootstrapPrompt` is set, the script
// generates the hero ref from scratch first, saves it at `style`, and uses
// it for the rest of the run.

import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localEnv = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
if (fs.existsSync(localEnv)) process.loadEnvFile(localEnv);

const configPath = process.argv[2] ?? "icons.json";
const cfg = JSON.parse(await fsp.readFile(configPath, "utf8"));
const {
  model = "gpt-image-1",
  style,
  outDir = "./out",
  size = "1024x1024",
  quality = "high",
  background = "transparent",
  styleHint = "Match the reference image's palette, stroke weight, lighting, and rendering style exactly.",
  items,
  sheet: sheetCfg = {},
  concurrency = 2,
} = cfg;

const sheet = {
  cols: sheetCfg.cols ?? 8,
  cell: sheetCfg.cell ?? 256,
  padding: sheetCfg.padding ?? 16,
  bg: sheetCfg.bg ?? { r: 0, g: 0, b: 0, alpha: 0 },
};

if (!style) die("config.style (path to style reference image) is required");
if (!Array.isArray(items) || items.length === 0) die("config.items[] is required");
if (!process.env.OPENAI_API_KEY) die("OPENAI_API_KEY env var is required");

const styleAbs = path.resolve(path.dirname(configPath), style);
const outAbs = path.resolve(path.dirname(configPath), outDir);
const iconsDir = path.join(outAbs, "icons");
await fsp.mkdir(iconsDir, { recursive: true });

const client = new OpenAI();

if (!fs.existsSync(styleAbs)) {
  if (!cfg.bootstrapPrompt) {
    die(`style reference not found: ${styleAbs}\n  → add config.bootstrapPrompt to generate one from scratch`);
  }
  console.log(`No style ref at ${styleAbs} — bootstrapping hero …`);
  const bootPrompt = [
    cfg.bootstrapPrompt,
    styleHint,
    "Single subject, centered, isolated. No text, no watermark, no border.",
  ].join("\n");
  const t0 = Date.now();
  const r = await client.images.generate({
    model,
    prompt: bootPrompt,
    size,
    quality,
    background,
    n: 1,
  });
  const b64 = r.data[0].b64_json;
  if (!b64) die("bootstrap generation returned no image data");
  await fsp.mkdir(path.dirname(styleAbs), { recursive: true });
  await fsp.writeFile(styleAbs, Buffer.from(b64, "base64"));
  console.log(`  ✓ wrote style ref → ${styleAbs}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

async function generateOne({ name, prompt }) {
  const file = path.join(iconsDir, `${name}.png`);
  if (cfg.skipExisting !== false && fs.existsSync(file)) {
    return { name, file, skipped: true };
  }
  const fullPrompt = [
    prompt,
    styleHint,
    "Single subject, centered, isolated. No text, no watermark, no border.",
  ].join("\n");

  const ext = path.extname(styleAbs).slice(1).toLowerCase() || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  const refFile = await toFile(await fsp.readFile(styleAbs), `style.${ext}`, { type: mime });
  const result = await client.images.edit({
    model,
    image: [refFile],
    prompt: fullPrompt,
    size,
    quality,
    background,
    n: 1,
  });

  const b64 = result.data[0].b64_json;
  if (!b64) throw new Error("no image data in response");
  await fsp.writeFile(file, Buffer.from(b64, "base64"));
  return { name, file };
}

console.log(`Generating ${items.length} icons (concurrency=${concurrency}) …`);
const queue = [...items];
const done = [];
const failed = [];

await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const t0 = Date.now();
      try {
        const r = await generateOne(item);
        done.push(r);
        if (r.skipped) {
          console.log(`  ⊙ ${item.name}  (cached)`);
        } else {
          console.log(`  ✓ ${item.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        }
      } catch (e) {
        failed.push({ name: item.name, error: e.message });
        console.error(`  × ${item.name}: ${e.message}`);
      }
    }
  }),
);

if (done.length === 0) die("no icons generated, aborting");
if (failed.length) console.warn(`(${failed.length} failed, see manifest)`);

console.log("Compositing sheet …");
done.sort((a, b) => items.findIndex(i => i.name === a.name) - items.findIndex(i => i.name === b.name));

const cols = sheet.cols;
const rows = Math.ceil(done.length / cols);
const W = cols * sheet.cell + (cols + 1) * sheet.padding;
const H = rows * sheet.cell + (rows + 1) * sheet.padding;

const composites = [];
const manifest = {
  generatedAt: new Date().toISOString(),
  model,
  width: W,
  height: H,
  cell: sheet.cell,
  padding: sheet.padding,
  cols,
  rows,
  items: [],
  failed,
};

for (let i = 0; i < done.length; i++) {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const left = sheet.padding + col * (sheet.cell + sheet.padding);
  const top = sheet.padding + row * (sheet.cell + sheet.padding);
  const buf = await sharp(done[i].file)
    .resize(sheet.cell, sheet.cell, { fit: "contain", background: sheet.bg })
    .png()
    .toBuffer();
  composites.push({ input: buf, left, top });
  manifest.items.push({
    name: done[i].name,
    x: left,
    y: top,
    w: sheet.cell,
    h: sheet.cell,
    file: path.relative(outAbs, done[i].file),
  });
}

const sheetPath = path.join(outAbs, "sheet.png");
await sharp({
  create: { width: W, height: H, channels: 4, background: sheet.bg },
})
  .composite(composites)
  .png()
  .toFile(sheetPath);

const manifestPath = path.join(outAbs, "sheet.json");
await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`✓ ${sheetPath}`);
console.log(`✓ ${manifestPath}`);

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
