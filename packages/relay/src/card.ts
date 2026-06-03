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
  "It only marks WHERE to place the person from the second reference image.",
  "Take the person from the second image, REMOVE their background completely,",
  "and paste them as a free-floating cutout at the location of the green dot.",
  "Keep the person's natural silhouette — head, hair, shoulders — DO NOT crop",
  "them into a circle. The person should be sized so their head sits roughly",
  "where the green dot was, with shoulders/body extending naturally below.",
  "The green color must be ENTIRELY REMOVED — no green ring, no green halo,",
  "no green pixels anywhere. Replace it with the card's dark/cyberdelic",
  "background tones so the person looks composited into the scene.",
  "Match the cyberdelic magenta/cyan lighting around the rest of the card.",
  "DO NOT change any other element: keep the SLOP.COMPUTER wordmark, the guest",
  "list, the camera/claude/chat windows, the ticker bars, balances, and every",
  "label pixel-for-pixel identical. Only the green dot area changes — into the",
  "background-removed guest cutout. No text overlays, no watermarks, no captions.",
].join(" ");

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

export async function generateCard(
  pfpBytes: Buffer,
  pfpMime: string,
  log: CardLogger = noopLog,
): Promise<CardGenerateResult> {
  const t0 = Date.now();
  log.info({ pfpBytes: pfpBytes.length, pfpMime }, "card gen: start");

  if (!fs.existsSync(TEMPLATE_PATH)) {
    log.error({ TEMPLATE_PATH }, "card gen: template missing");
    throw new Error(`card template not found at ${TEMPLATE_PATH}`);
  }
  const templateBytes = await fs.promises.readFile(TEMPLATE_PATH);

  const templateFile = await toFile(templateBytes, "template.png", { type: "image/png" });
  const pfpExt = pfpMime.includes("png") ? "png" : pfpMime.includes("webp") ? "webp" : "jpg";
  const pfpType = pfpMime.includes("png") ? "image/png" : pfpMime.includes("webp") ? "image/webp" : "image/jpeg";
  const pfpFile = await toFile(pfpBytes, `pfp.${pfpExt}`, { type: pfpType });

  const client = getClient();
  log.info(
    { model: MODEL, size: SIZE, templateBytes: templateBytes.length, pfpExt, timeoutMs: OPENAI_TIMEOUT_MS },
    "card gen: calling gpt-image-2",
  );
  const apiStart = Date.now();
  let result;
  try {
    result = await client.images.edit(
      {
        model: MODEL,
        image: [templateFile, pfpFile],
        prompt: PROMPT,
        size: SIZE,
        n: 1,
      },
      { timeout: OPENAI_TIMEOUT_MS, maxRetries: 1 },
    );
  } catch (err) {
    log.error(
      { err, apiMs: Date.now() - apiStart, totalMs: Date.now() - t0 },
      "card gen: gpt-image-2 call failed",
    );
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
