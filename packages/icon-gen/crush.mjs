// Crush every PNG in packages/nextjs/public/icons/ in place.
//
// Usage:
//   node crush.mjs           # crush all public icons
//   (or from repo root: `yarn icon:crush`)
//
// For each icon, if there's no raw copy in out/icons/ yet, the current
// public file is copied there first — so we preserve the high-res source
// before crushing in place. Re-running is safe and idempotent.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressIcon, DEFAULT_TARGET_PX } from "./compress.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "nextjs", "public", "icons");
const cacheDir = path.join(here, "out", "icons");

await fsp.mkdir(cacheDir, { recursive: true });

const files = (await fsp.readdir(publicDir)).filter(f => f.endsWith(".png")).sort();
if (files.length === 0) {
  console.log(`No PNGs found in ${publicDir}`);
  process.exit(0);
}

console.log(`Crushing ${files.length} icons to ${DEFAULT_TARGET_PX}px …\n`);

let totalBefore = 0;
let totalAfter = 0;
for (const f of files) {
  const publicFile = path.join(publicDir, f);
  const cacheFile = path.join(cacheDir, f);
  const before = (await fsp.stat(publicFile)).size;
  totalBefore += before;

  if (!fs.existsSync(cacheFile)) {
    await fsp.copyFile(publicFile, cacheFile);
  }

  const compressed = await compressIcon(cacheFile);
  await fsp.writeFile(publicFile, compressed);
  totalAfter += compressed.length;

  const beforeKB = (before / 1024).toFixed(0).padStart(5);
  const afterKB = (compressed.length / 1024).toFixed(0).padStart(4);
  console.log(`  ${f.padEnd(24)} ${beforeKB} KB → ${afterKB} KB`);
}

const beforeMB = (totalBefore / 1024 / 1024).toFixed(1);
const afterMB = (totalAfter / 1024 / 1024).toFixed(2);
const pct = (100 * (1 - totalAfter / totalBefore)).toFixed(1);
console.log(`\nTotal: ${beforeMB} MB → ${afterMB} MB  (${pct}% smaller)`);
