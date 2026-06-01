// Chat slash commands. Both the WS `chat_send` handler and the HTTP
// `POST /v1/chat` endpoint funnel a leading-`/` message through
// `handleChatCommand` *after* the rate limiter has already charged a token
// — so a command costs the same as a chat line and can't be spammed.
//
// Two output shapes (see ChatMessage.kind):
//   - "emote"  — an attributed action (`/me`, `/slap`, `/roll`, `/flip`).
//                Keeps the sender's identity; the UI renders it italic.
//   - "system" — an unattributed info reply (`/who`, `/music`, `/url`,
//                `/link`, `/address`, `/help`). address/handle null; the UI
//                renders it as a centered notice.
//
// `/help` and `/block` are *also* handled client-side (ChatWindow) so a live
// desktop user gets an instant local response without a round-trip — but we
// answer `/help` here too so HTTP spectators (whose composer doesn't
// intercept) still get the list. `/block` is purely per-viewer and never
// reaches the relay. Unknown `/foo` returns false and is sent as normal chat.

import type { ChatMessage } from "./chat.js";
import { CUSTOM_GENRE, readPlaylist } from "./jamendo.js";
import type { Room } from "./room.js";

// Where a room lives publicly. slop.computer/<slug> is the audience-facing
// page (it redirects into the live desktop as needed).
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? "https://slop.computer").replace(/\/+$/, "");

export type ChatCommandCtx = {
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  // Carried onto emote lines so a spectator's `/me` still shows SPECTATOR, etc.
  source: ChatMessage["source"];
  // Lets `/tldr` reuse the relay's existing summarize-transcript path without
  // this module reaching into the AI plumbing. Caller wires it in index.ts.
  requestTldr?: () => void;
};

const HELP_TEXT = [
  "slop chat commands —",
  "/me <action> · /slap <name> · /roll [NdM] · /flip",
  "/who · /music · /url · /link · /address (/ca)",
  "/tldr · /block <name> · /unblock <name> · /help",
].join("\n");

// Parse an "NdM" dice spec. Bare "d20"/"20" → one 20-sided die; "" → d20.
// Clamped to keep a troll from asking for 9999d9999 worth of output.
function parseDice(rest: string): { n: number; sides: number; label: string } {
  const m = rest.trim().match(/^(\d*)\s*d?\s*(\d*)$/i);
  let n = 1;
  let sides = 20;
  if (m) {
    if (m[2]) {
      n = m[1] ? parseInt(m[1], 10) : 1;
      sides = parseInt(m[2], 10);
    } else if (m[1]) {
      // "/roll 6" → a single d6.
      sides = parseInt(m[1], 10);
    }
  }
  n = Math.max(1, Math.min(20, n || 1));
  sides = Math.max(2, Math.min(1000, sides || 20));
  return { n, sides, label: `${n}d${sides}` };
}

function describeMusic(room: Room): string {
  const { state } = room.music.current();
  if (!state || !state.src) return "🎵 nothing playing right now.";
  const genre = room.jamendo.getCurrentGenre();
  const playlist =
    genre === CUSTOM_GENRE ? room.jamendo.getCustomPlaylist() : genre ? readPlaylist(genre) : null;
  const track = playlist?.tracks[state.index];
  const suffix = state.playing ? "" : " (paused)";
  if (track) return `🎵 now playing: ${track.title} — ${track.artist}${suffix}`;
  return `🎵 music is ${state.playing ? "playing" : "paused"}.`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function describeWho(room: Room): string {
  const peers = room.listPeers();
  const present = peers.filter(p => !p.spectator);
  const watching = peers.length - present.length;
  const names = present.map(p => p.handle || (p.address ? shortAddr(p.address) : "anon")).slice(0, 25);
  const more = present.length > names.length ? `, +${present.length - names.length} more` : "";
  const watchSuffix = watching > 0 ? ` (+${watching} watching)` : "";
  if (present.length === 0) return `👥 nobody's in the room${watchSuffix}.`;
  return `👥 ${present.length} here: ${names.join(", ")}${more}${watchSuffix}`;
}

// Returns true if `raw` was a recognized command (so the caller should NOT
// also append it as a normal chat line). Returns false for non-commands and
// unknown `/foo` (which fall through to normal chat).
export function handleChatCommand(room: Room, raw: string, ctx: ChatCommandCtx): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return false;
  const space = trimmed.indexOf(" ");
  const cmd = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

  const emote = (text: string) =>
    room.chat.append({
      address: ctx.address,
      handle: ctx.handle,
      anonId: ctx.anonId ?? null,
      text,
      source: ctx.source,
      kind: "emote",
    });
  const system = (text: string) =>
    room.chat.append({ address: null, handle: null, anonId: null, text, source: ctx.source, kind: "system" });

  switch (cmd) {
    case "me":
      // Empty `/me` is a no-op but still "handled" — don't echo a bare slash.
      if (rest) emote(rest);
      return true;
    case "slap":
      emote(`slaps ${rest || "the air"} around a bit with a large trout 🐟`);
      return true;
    case "roll": {
      const { n, sides, label } = parseDice(rest);
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
      const total = rolls.reduce((a, b) => a + b, 0);
      const detail = n > 1 ? ` (${rolls.join(" + ")})` : "";
      emote(`🎲 rolls ${label} → ${total}${detail}`);
      return true;
    }
    case "flip":
      emote(`🪙 flips a coin → ${Math.random() < 0.5 ? "heads" : "tails"}`);
      return true;
    case "address":
    case "ca": {
      const addr = room.wallet.getCurrent()?.address;
      system(addr ? `🏦 room multisig: ${addr}` : "🏦 no room wallet yet.");
      return true;
    }
    case "url": {
      const browsers = room.browsers.list();
      const url = browsers.length ? browsers[browsers.length - 1]?.url : null;
      system(url ? `🌐 ${url}` : "🌐 no shared browser open.");
      return true;
    }
    case "link":
      system(`🔗 ${PUBLIC_BASE}/${room.id}`);
      return true;
    case "music":
      system(describeMusic(room));
      return true;
    case "who":
      system(describeWho(room));
      return true;
    case "tldr":
      ctx.requestTldr?.();
      return true;
    case "help":
      system(HELP_TEXT);
      return true;
    default:
      // Not one of ours — let it post as a normal message.
      return false;
  }
}
