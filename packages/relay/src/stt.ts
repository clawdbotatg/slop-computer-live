// Server-side speech-to-text. Wraps OpenAI gpt-4o-mini-transcribe so the
// god-mode client (the headed Chrome streaming box) can send each peer's
// audio chunks here instead of running per-browser Web Speech API — which
// only works in Chrome/Safari and silently no-ops everywhere else.
//
// Per-speaker separation comes for free: the god-mode peer already holds
// one MediaStream per other peer (full-mesh WebRTC), labels each chunk
// with the speaker's address, and posts to /v1/transcript/relay. This
// module is the dumb pipe: bytes in, text out.

import OpenAI, { toFile } from "openai";
import { config } from "./config.js";

// gpt-4o-mini-transcribe is roughly 10× cheaper than whisper-1 with
// comparable accuracy on short conversational segments. Keep it
// configurable so a switch to gpt-4o-transcribe (higher quality) or
// whisper-1 (longer language list) is one env var away.
const MODEL = process.env.STT_MODEL ?? "gpt-4o-mini-transcribe";

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (cachedClient) return cachedClient;
  if (!config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not set on the relay");
  }
  cachedClient = new OpenAI({ apiKey: config.openAiApiKey });
  return cachedClient;
}

export function isSttConfigured(): boolean {
  return !!config.openAiApiKey;
}

export async function transcribeAudio(
  bytes: Buffer,
  mime: string,
  lang?: string,
): Promise<string> {
  // OpenAI accepts webm, mp3, m4a, mp4, mpeg, mpga, wav, flac. The
  // god-mode client sends `audio/webm;codecs=opus` from MediaRecorder
  // by default — pick the extension to match so the SDK's content
  // sniffer doesn't reject it.
  const ext = mime.includes("webm")
    ? "webm"
    : mime.includes("ogg")
      ? "ogg"
      : mime.includes("mp4") || mime.includes("m4a")
        ? "m4a"
        : mime.includes("wav")
          ? "wav"
          : "webm";
  const file = await toFile(bytes, `chunk.${ext}`, { type: mime || `audio/${ext}` });
  const result = await getClient().audio.transcriptions.create({
    model: MODEL,
    file,
    language: lang,
    // Plain text response is the smallest payload — we just want the
    // string, not the verbose timestamped JSON.
    response_format: "text",
  });
  // With response_format: "text", the SDK returns a bare string. Cast
  // to unknown first because the typed overload narrows the return to
  // a json-shaped object on this code path, even though the runtime
  // shape is plain text.
  const out = result as unknown;
  if (typeof out === "string") return out;
  if (out && typeof out === "object" && "text" in out && typeof (out as { text: unknown }).text === "string") {
    return (out as { text: string }).text;
  }
  return "";
}
