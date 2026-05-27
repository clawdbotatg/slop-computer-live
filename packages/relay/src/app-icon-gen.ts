// Server-side app-icon generation. Lets a third party (host-scoped token,
// NO repo access) ask the relay to generate a desktop icon for their app
// from a text prompt, in the house Mac-OS-9/cyberdelic style. The relay
// stores the result in its runtime app-icons dir and serves it — so adding
// an app + a style-matched icon is a pure-API flow: no `yarn icon:add`, no
// commit, no redeploy.
//
// Mirrors the card.ts pattern (relay already depends on `openai` and has
// OPENAI_API_KEY configured). We DON'T compress with sharp (not a relay
// dep) — the raw gpt-image-1 PNG is stored as-is and rendered downscaled in
// the browser. Compressing server-side is a future optimization.

import OpenAI, { toFile } from "openai";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// style-ref.png + icons.json ship in packages/icon-gen. The relay runs from
// packages/relay, so the sibling path resolves on prod (and locally). Both
// overridable via env for non-standard layouts.
const STYLE_REF_PATH = process.env.APP_ICON_STYLE_REF ?? path.resolve(process.cwd(), "../icon-gen/style-ref.png");
const ICONS_CFG_PATH = process.env.APP_ICON_CFG ?? path.resolve(process.cwd(), "../icon-gen/icons.json");

// Fallback if icons.json isn't readable at runtime — keeps generated icons
// on-style even if the icon-gen package isn't deployed alongside the relay.
const FALLBACK_STYLE_HINT =
  "STYLE: classic Mac OS 9 desktop icon, 3/4 isometric perspective, chunky soft-3D rendering with hard silhouette. " +
  "PALETTE: deep purple (#1a0524) and black base, hot magenta (#ff2bd6) primary, electric cyan (#3df0ff) and lime " +
  "(#aaff3d) accents, occasional bone white highlights. TEXTURE: subtle CRT scanline overlay, faint magenta bloom, " +
  "1-bit ordered dithering in shadows. RIM: thin 1-pixel neon magenta outline glow. Transparent background. Single " +
  "icon, centered, no label, no caption, no border, no shadow plate.";

function styleHint(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(ICONS_CFG_PATH, "utf8")) as { styleHint?: unknown };
    if (typeof cfg.styleHint === "string" && cfg.styleHint.trim()) return cfg.styleHint;
  } catch {
    /* fall through to baked-in hint */
  }
  return FALLBACK_STYLE_HINT;
}

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  if (!config.openAiApiKey) throw new Error("OPENAI_API_KEY is not set on the relay");
  cachedClient = new OpenAI({ apiKey: config.openAiApiKey });
  return cachedClient;
}

export function appIconGenAvailable(): boolean {
  return !!config.openAiApiKey && fs.existsSync(STYLE_REF_PATH);
}

// Generate one icon PNG from a prompt. Throws on misconfig / API error.
export async function generateAppIcon(prompt: string): Promise<Buffer> {
  if (!fs.existsSync(STYLE_REF_PATH)) throw new Error(`style ref not found at ${STYLE_REF_PATH}`);
  const refBytes = await fs.promises.readFile(STYLE_REF_PATH);
  const refFile = await toFile(refBytes, "style.png", { type: "image/png" });
  const fullPrompt = [prompt, styleHint(), "Single subject, centered, isolated. No text, no watermark, no border."].join(
    "\n",
  );
  const client = getClient();
  const result = await client.images.edit({
    model: "gpt-image-1",
    image: [refFile],
    prompt: fullPrompt,
    size: "1024x1024",
    quality: "medium",
    background: "transparent",
    n: 1,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image data returned from image model");
  return Buffer.from(b64, "base64");
}
