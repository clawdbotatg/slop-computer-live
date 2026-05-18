// Generate a podcast-guest title card by compositing the guest's PFP into
// the green-screen circle on the slop.computer template via gpt-image-2.
//
// The template lives in the frontend at packages/nextjs/public/card-template.png
// (committed). We pass it + the uploaded PFP as the two reference images
// to images.edit and prompt the model to drop the face into the green
// circle while leaving the rest of the template untouched.
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

const PROMPT = [
  "Replace ONLY the bright green circular area on the right side of this title card",
  "with the person from the second reference image. The face should completely",
  "cover the green circle, cropped to a clean circle that fits the bordered area.",
  "Match the cyberdelic magenta/cyan lighting around the rest of the card.",
  "DO NOT change any other element: keep the SLOP.COMPUTER wordmark, the guest list,",
  "the camera/claude/chat windows, the ticker bars, balances, and every label",
  "pixel-for-pixel identical. Only the green circle changes — into the guest's face.",
  "No text overlays, no watermarks, no captions added.",
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

export async function generateCard(pfpBytes: Buffer, pfpMime: string): Promise<CardGenerateResult> {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`card template not found at ${TEMPLATE_PATH}`);
  }
  const templateBytes = await fs.promises.readFile(TEMPLATE_PATH);

  const templateFile = await toFile(templateBytes, "template.png", { type: "image/png" });
  const pfpExt = pfpMime.includes("png") ? "png" : pfpMime.includes("webp") ? "webp" : "jpg";
  const pfpType = pfpMime.includes("png") ? "image/png" : pfpMime.includes("webp") ? "image/webp" : "image/jpeg";
  const pfpFile = await toFile(pfpBytes, `pfp.${pfpExt}`, { type: pfpType });

  const client = getClient();
  const result = await client.images.edit({
    model: MODEL,
    image: [templateFile, pfpFile],
    prompt: PROMPT,
    size: SIZE,
    n: 1,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image data returned from gpt-image-2");
  return { png: Buffer.from(b64, "base64") };
}
