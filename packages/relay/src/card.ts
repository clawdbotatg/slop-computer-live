// Generate a podcast-guest title card by compositing the guest's PFP onto
// the slop.computer template via gpt-image-2.
//
// The template lives in the frontend at packages/nextjs/public/card-template.png
// (committed). We pass it + the uploaded PFP as the two reference images
// to images.edit. The green-screen dot on the template is a POSITION MARKER
// — the model background-removes the guest and places them as a free-floating
// cutout at that spot, replacing the green entirely.
//
// This is a single-shot, ephemeral generator: the frontend gets back PNG
// bytes and decides what to do with them. Nothing is persisted server-side.

import OpenAI, { toFile } from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

// Resolve the template relative to the relay's source dir so it works
// the same in `tsx watch` (src/) and `node dist/` builds. From either
// location, ../../nextjs/public/card-template.png is the committed copy.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  process.env.CARD_TEMPLATE_PATH ?? path.join(HERE, "..", "..", "nextjs", "public", "card-template.png"),
);

const MODEL = "gpt-image-2-2026-04-21";
// 1536x1024 is the closest gpt-image-2 landscape size to the template's
// native ~1536x984 — keeps the layout undistorted.
const SIZE = "1536x1024";

// Hard ceiling on the OpenAI call. gpt-image-2 at this size normally
// returns in ~30-90s; the SDK's default 10-min timeout × 2 retries means a
// stalled request can silently hold the per-room job for ~30 min, which
// reads as "chugging forever" with no result. Fail fast and loud instead.
const OPENAI_TIMEOUT_MS = 180_000;

// Minimal structured-logger shape (pino-compatible). The relay passes its
// request logger so card-gen stages land in the same log stream with room
// context; falls back to a console shim for standalone use.
export type CardLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};
const noopLog: CardLogger = {
  info: (obj, msg) => console.log("[card]", msg ?? "", obj),
  error: (obj, msg) => console.error("[card]", msg ?? "", obj),
};

const PROMPT = [
  "The bright green circular dot on the right side of the first image is a",
  "POSITION MARKER — it is NOT a mask, NOT a window, NOT a shape to fill.",
  "It only marks WHERE to place the subject from the second reference image.",
  "",
  "FIRST, decide what the second image is:",
  "",
  "CASE A — the second image clearly shows a PERSON (a human face/body, photo",
  "or portrait, typically with a background behind them): Take that person,",
  "REMOVE their background completely, and paste them as a free-floating cutout",
  "at the location of the green dot. Keep the person's natural silhouette —",
  "head, hair, shoulders — DO NOT crop them into a circle. Size them so their",
  "head sits roughly where the green dot was, with shoulders/body extending",
  "naturally below.",
  "",
  "CASE B — the second image is NOT a person (a logo, avatar, icon, emblem,",
  "illustration, mascot, symbol, or abstract art — anything with no real human",
  "to cut out, or no meaningful background to remove): DO NOT remove any",
  "background and DO NOT invent or borrow a person from anywhere. Simply USE",
  "the second image as-is — preserve its own colors, shapes, and composition —",
  "and place it at the green-dot location, scaled to fit nicely in that spot.",
  "Blend only its outer edges into the card so it sits in the scene; keep the",
  "artwork itself intact and recognizable.",
  "",
  "In BOTH cases: the green color must be ENTIRELY REMOVED — no green ring, no",
  "green halo, no green pixels anywhere. Replace it with the card's",
  "dark/cyberdelic background tones so the subject looks composited into the",
  "scene. Match the cyberdelic magenta/cyan lighting around the rest of the card.",
  "DO NOT change any other element: keep the SLOP.COMPUTER wordmark, the guest",
  "list, the camera/claude/chat windows, the ticker bars, balances, and every",
  "label pixel-for-pixel identical. Only the green dot area changes — into the",
  "subject from the second image. No text overlays, no watermarks, no captions.",
].join(" ");

// Prompt for the "custom vibe" path. Instead of compositing a dropped PFP, the
// model INVENTS artwork for the green-dot spot from a free-text vibe the user
// typed (e.g. "poker night", "a bird-watching meetup"). Optionally the user
// also drops REFERENCE images (style examples, a mascot, a logo, a mood board)
// — those ride along as extra reference images after the template, and the
// prompt tells the model to take its style + subject cues from them instead
// of defaulting to the house cyberdelic look. Everything else about the card
// stays pixel-identical — same as the PFP path.
function buildVibePrompt(vibe: string, refCount: number): string {
  const styleBlock =
    refCount > 0
      ? [
          `The ${refCount === 1 ? "second image is" : `${refCount} images after the first one are`} REFERENCE`,
          "EXAMPLES supplied by the user. They define what the artwork should look",
          "like: take your visual STYLE (rendering technique, line weight, palette,",
          "texture, mood) and your SUBJECT cues (characters, mascots, logos, motifs)",
          "from them. Reinterpret them into one new piece of artwork for the",
          "green-dot spot — do not paste a reference in verbatim, but if a reference",
          "shows a specific logo, mascot, or character, keep it clearly recognizable.",
          "Do not include any real photograph or person from the references.",
          "Let the reference style win over the card's own style, then blend the",
          "edges into the card's dark background so it sits in the scene.",
        ]
      : [
          "Render the theme in the card's chunky cyberdelic Mac-OS-9 style — hot",
          "magenta, cyan, and lime accents on deep purple, isometric 3/4 lighting.",
        ];
  return [
    "The bright green circular dot on the right side of the FIRST image is a",
    "POSITION MARKER — it is NOT a mask, NOT a window, NOT a shape to fill.",
    "It only marks WHERE to place a piece of artwork that you will INVENT.",
    "",
    "INVENT original artwork illustrating the following theme, then place it at",
    "the green-dot location as a free-floating element composited into the card.",
    "Do not borrow or paste any real photograph or person — generate the art:",
    "",
    `THEME: ${vibe}`,
    "",
    ...styleBlock,
    "Size the artwork so it fills the green-dot area nicely, with details",
    "extending naturally around that spot, like a sticker dropped into the scene.",
    "",
    "The green color must be ENTIRELY REMOVED — no green ring, no green halo,",
    "no green pixels anywhere — replaced with your invented artwork blended into",
    "the card's dark/cyberdelic background tones and matching the magenta/cyan",
    "lighting of the rest of the card.",
    "DO NOT change any other element: keep the SLOP.COMPUTER wordmark, the guest",
    "list, the camera/claude/chat windows, the ticker bars, balances, and every",
    "label pixel-for-pixel identical. Only the green dot area changes — into the",
    "artwork you invented. No text overlays, no watermarks, no captions.",
  ].join(" ");
}

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  if (!config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not set on the relay");
  }
  cachedClient = new OpenAI({ apiKey: config.openAiApiKey });
  return cachedClient;
}

export type CardGenerateResult = {
  png: Buffer;
};

// Shared gpt-image-2 call. Both entry points (PFP drop and custom vibe) load
// the template, build their reference-image list + prompt, and hand off here
// so the timeout/retry/logging/decode policy lives in one place.
async function runCardEdit(
  images: Awaited<ReturnType<typeof toFile>>[],
  prompt: string,
  log: CardLogger,
  t0: number,
): Promise<CardGenerateResult> {
  const client = getClient();
  log.info(
    { model: MODEL, size: SIZE, refImages: images.length, timeoutMs: OPENAI_TIMEOUT_MS },
    "card gen: calling gpt-image-2",
  );
  const apiStart = Date.now();
  let result;
  try {
    result = await client.images.edit(
      {
        model: MODEL,
        image: images,
        prompt,
        size: SIZE,
        n: 1,
      },
      { timeout: OPENAI_TIMEOUT_MS, maxRetries: 1 },
    );
  } catch (err) {
    log.error({ err, apiMs: Date.now() - apiStart, totalMs: Date.now() - t0 }, "card gen: gpt-image-2 call failed");
    throw err;
  }
  const apiMs = Date.now() - apiStart;

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) {
    log.error({ apiMs, result: { hasData: !!result.data, len: result.data?.length ?? 0 } }, "card gen: no image data");
    throw new Error("no image data returned from gpt-image-2");
  }
  const png = Buffer.from(b64, "base64");
  log.info({ apiMs, totalMs: Date.now() - t0, pngBytes: png.length }, "card gen: done");
  return { png };
}

async function loadTemplateFile(log: CardLogger): Promise<Awaited<ReturnType<typeof toFile>>> {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    log.error({ TEMPLATE_PATH }, "card gen: template missing");
    throw new Error(`card template not found at ${TEMPLATE_PATH}`);
  }
  const templateBytes = await fs.promises.readFile(TEMPLATE_PATH);
  return toFile(templateBytes, "template.png", { type: "image/png" });
}

export async function generateCard(
  pfpBytes: Buffer,
  pfpMime: string,
  log: CardLogger = noopLog,
): Promise<CardGenerateResult> {
  const t0 = Date.now();
  log.info({ pfpBytes: pfpBytes.length, pfpMime }, "card gen: start (pfp)");

  const templateFile = await loadTemplateFile(log);
  const pfpExt = pfpMime.includes("png") ? "png" : pfpMime.includes("webp") ? "webp" : "jpg";
  const pfpType = pfpMime.includes("png") ? "image/png" : pfpMime.includes("webp") ? "image/webp" : "image/jpeg";
  const pfpFile = await toFile(pfpBytes, `pfp.${pfpExt}`, { type: pfpType });

  return runCardEdit([templateFile, pfpFile], PROMPT, log, t0);
}

/** A user-supplied reference image for the custom-vibe path. */
export type CardRefImage = { bytes: Buffer; mime: string };

// Hard cap on reference images per generation. gpt-image-2 edit accepts many
// more, but each one is more bytes to upload and more for the model to weigh;
// four is plenty for "here's the style, here's the mascot".
export const CARD_MAX_REF_IMAGES = 4;

function refToFile(ref: CardRefImage, i: number): Promise<Awaited<ReturnType<typeof toFile>>> {
  const ext = ref.mime.includes("png") ? "png" : ref.mime.includes("webp") ? "webp" : "jpg";
  const type = ref.mime.includes("png") ? "image/png" : ref.mime.includes("webp") ? "image/webp" : "image/jpeg";
  return toFile(ref.bytes, `ref${i + 1}.${ext}`, { type });
}

// Custom-vibe path: no PFP to composite. We pass the template plus any
// user-dropped reference images and let the model invent artwork for the
// green-dot spot from the free-text vibe, styled after the references.
export async function generateCardFromPrompt(
  vibe: string,
  refs: CardRefImage[] = [],
  log: CardLogger = noopLog,
): Promise<CardGenerateResult> {
  const t0 = Date.now();
  const used = refs.slice(0, CARD_MAX_REF_IMAGES);
  log.info(
    { vibeLen: vibe.length, refs: used.length, refBytes: used.reduce((n, r) => n + r.bytes.length, 0) },
    "card gen: start (vibe)",
  );

  const templateFile = await loadTemplateFile(log);
  const refFiles = await Promise.all(used.map(refToFile));
  return runCardEdit([templateFile, ...refFiles], buildVibePrompt(vibe, used.length), log, t0);
}
