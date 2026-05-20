// Shared icon compressor.
//
// gpt-image-1 returns 1024x1024 PNGs at ~1.5-2 MB each. The desktop renders
// icons at 88px (TRASH_SIZE / DesktopIcon DEFAULT_SIZE), so shipping the raw
// 1024 to the browser is ~20x more bytes than needed even at 3x retina.
//
// We keep the raw 1024 in `out/icons/` (the cache) and ship a compressed
// copy to `public/icons/`. Cache stays high-res so we can re-crush to a
// different target later without re-paying OpenAI.

import sharp from "sharp";
import fsp from "node:fs/promises";

export const DEFAULT_TARGET_PX = 256;

// Returns a compressed PNG buffer. `input` can be a Buffer or a file path.
export async function compressIcon(input, { size = DEFAULT_TARGET_PX } = {}) {
  const src = Buffer.isBuffer(input) ? input : await fsp.readFile(input);
  return sharp(src)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ palette: true, compressionLevel: 9, effort: 10 })
    .toBuffer();
}
