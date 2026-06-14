// Server-side equivalent of CardWindow's client canvas bake. Draws the title
// overlay — a small "TITLE" bar + cyan uppercase body text in a translucent
// window — onto the room's card.png, producing the published unfurl PNG.
//
// Uses `pureimage` (pure JS — no native binary, so it installs identically on
// the Mac build box and the Linux prod box). Geometry mirrors CardWindow.tsx:
// font = sizeFrac × width, window centered at (x,y) fractions of the image.
import * as PImageNS from "pureimage";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// pureimage ships as CJS; tolerate either interop shape.
const PImage: any = (PImageNS as any).default ?? PImageNS;

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/card-bake.js → ../assets (source tree, present on prod via git pull).
const FONT_PATH = path.join(here, "..", "assets", "Silkscreen-Regular.ttf");

let fontReady = false;
function ensureFont(): void {
  if (fontReady) return;
  const fnt = PImage.registerFont(FONT_PATH, "Silkscreen");
  fnt.loadSync ? fnt.loadSync() : fnt.load();
  fontReady = true;
}

export type CardTitle = { text: string; x: number; y: number; sizeFrac: number };

export async function bakeCardPublished(
  cardPngPath: string,
  outPath: string,
  title: CardTitle,
): Promise<number> {
  ensureFont();
  const img = await PImage.decodePNGFromStream(createReadStream(cardPngPath));
  const W: number = img.width;
  const H: number = img.height;
  const ctx: any = img.getContext("2d");

  const text = (title.text || "").toUpperCase().replace(/\n/g, " ").trim();
  const F = Math.max(8, title.sizeFrac * W); // body font px
  const TBH = Math.max(F * 0.45, 28); // title bar height
  const tbFont = Math.max(F * 0.26, 14);
  const vpad = Math.max(F * 0.18, 12);
  const hpad = Math.max(F * 0.32, 20);

  ctx.font = `${Math.round(F)}pt Silkscreen`;
  const textW = text ? ctx.measureText(text).width : 0;
  const bodyW = Math.max(F * 3, 200, textW + hpad * 2);
  const bodyH = F + vpad * 2;
  const winW = bodyW;
  const winH = TBH + bodyH;
  const x0 = Math.round(title.x * W - winW / 2);
  const y0 = Math.round(title.y * H - winH / 2);

  const rect = (color: string, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const centered = (color: string, t: string, cx: number, baseline: number, font: string) => {
    ctx.font = font;
    const w = ctx.measureText(t).width;
    ctx.fillStyle = color;
    ctx.fillText(t, Math.round(cx - w / 2), Math.round(baseline));
  };

  rect("rgba(10,4,30,0.32)", x0, y0, winW, winH); // window bg
  rect("rgba(255,62,201,0.6)", x0, y0 + TBH - 2, winW, 2); // titlebar underline
  centered("rgba(255,255,255,0.95)", "TITLE", x0 + winW / 2, y0 + TBH / 2 + tbFont * 0.35, `${Math.round(tbFont)}pt Silkscreen`);
  rect("rgba(0,0,0,0.28)", x0, y0 + TBH, bodyW, bodyH); // body bg
  if (text) {
    const cx = x0 + winW / 2;
    const by = y0 + TBH + bodyH / 2 + F * 0.35;
    centered("rgba(0,0,0,0.6)", text, cx + F * 0.04, by + F * 0.06, `${Math.round(F)}pt Silkscreen`); // shadow
    centered("#3fcfff", text, cx, by, `${Math.round(F)}pt Silkscreen`); // cyan title
  }
  // Magenta window border (4 strips — pureimage strokeRect is unreliable).
  const b = 2;
  rect("#ff3ec9", x0, y0, winW, b);
  rect("#ff3ec9", x0, y0 + winH - b, winW, b);
  rect("#ff3ec9", x0, y0, b, winH);
  rect("#ff3ec9", x0 + winW - b, y0, b, winH);

  await PImage.encodePNGToStream(img, createWriteStream(outPath));
  return statSync(outPath).size;
}
