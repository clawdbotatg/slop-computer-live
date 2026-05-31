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

// gpt-4o-transcribe is OpenAI's highest-accuracy transcription model.
// We previously ran gpt-4o-mini-transcribe (cheaper) but it was the
// worst of the family at honoring the `language` hint — short
// utterances auto-detected per-chunk and drifted into Spanish/Danish/
// etc. The full model is more accurate AND steers far harder when we
// pair `language` with an English priming `prompt` (see below). Keep
// it configurable so a switch back to mini (cost) or to whisper-1
// (hard language lock, lower raw accuracy) is one env var away.
const MODEL = process.env.STT_MODEL ?? "gpt-4o-transcribe";

// In-language priming sentences. The prompt's own language is the strong
// signal — a sentence written in English makes the model far less likely
// to transcribe an utterance as Spanish/Danish/etc. Keyed by the 2-letter
// primary subtag of the BCP-47 `lang` hint ("en-US" -> "en").
const LANG_PRIMING_PROMPT: Record<string, string> = {
  en: "The following is a transcript of an English-language conversation.",
};

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
  // `language` is only a soft hint to the gpt-4o transcribe models — on
  // short/near-silent chunks they still auto-detect and drift into other
  // languages. The `prompt` field steers much harder, so when the caller
  // pins a language we also feed an in-language priming sentence. This is
  // the combination that actually keeps an all-English show all-English.
  const prompt = lang ? LANG_PRIMING_PROMPT[lang.slice(0, 2).toLowerCase()] : undefined;
  const result = await getClient().audio.transcriptions.create({
    model: MODEL,
    file,
    language: lang,
    ...(prompt ? { prompt } : {}),
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
