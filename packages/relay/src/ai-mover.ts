// Per-room server-side autonomous chess move loop for AI players.
//
// Wired into the chess broadcast cycle: every time a room's chess
// state changes (create/move/resign/abort), `room.aiMover.tick(version)`
// is called. If it's now an AI's turn for that room, the engine asks
// that AI's model for a move (one retry on illegal/parse failure with
// a stricter prompt; second failure auto-resigns the AI so the human
// isn't stuck waiting on a broken provider).

import { Chess } from "chess.js";
import type { ChessState } from "./chess.js";
import { getAIPlayer, isAIKey } from "./ai-players.js";

export class AIMover {
  private inFlight = false;
  private lastVersionHandled = -1;

  constructor(private readonly chess: ChessState) {}

  /** Called from the broadcastChessState wrapper after every state
   *  change. Cheap when it's not an AI's turn — we only kick off the
   *  model call if the side-to-move's ownerKey is one of ours. */
  async tick(version: number, notifyAfterMove: () => void): Promise<void> {
    // Coalesce: if we already started a move for this version, skip.
    // The new state from our own move will bump the version again,
    // which re-runs us — that's how AI-vs-AI keeps stepping forward.
    if (this.inFlight) return;
    if (version <= this.lastVersionHandled) return;
    this.lastVersionHandled = version;

    const game = this.chess.getCurrentGame();
    if (!game || game.status !== "active") return;

    const fen = game.fen;
    let turn: "w" | "b";
    try {
      const ch = new Chess();
      ch.load(fen);
      turn = ch.turn();
    } catch {
      return;
    }
    const sideKey = turn === "w" ? game.whiteKey : game.blackKey;
    if (!isAIKey(sideKey)) return;

    const ai = getAIPlayer(sideKey);
    if (!ai) {
      // Game references an AI we no longer ship (or whose key was
      // rotated out). Best we can do is resign for them so a human
      // isn't stuck — alternative is leave the game frozen forever.
      console.warn(`[ai-mover] no config for ${sideKey}, resigning`);
      this.chess.resign(sideKey);
      notifyAfterMove();
      return;
    }

    this.inFlight = true;
    try {
      await this.playOneTurn(ai, sideKey, notifyAfterMove);
    } catch (err) {
      console.error("[ai-mover] unexpected failure:", err);
    } finally {
      this.inFlight = false;
    }
  }

  private async playOneTurn(
    ai: ReturnType<typeof getAIPlayer> & object,
    sideKey: string,
    notifyAfterMove: () => void,
  ): Promise<void> {
    const game = this.chess.getCurrentGame();
    if (!game || game.status !== "active") return;

    const legalMoves = computeLegalUCIs(game.fen);

    // First attempt: open prompt.
    let move = await askForMove(ai, game.fen, game.moves, legalMoves, false);
    if (move && this.tryApply(sideKey, move, game.fen, notifyAfterMove)) return;

    // Second attempt: stricter prompt that lists the legal options.
    console.warn(`[ai-mover] ${ai.id}: retrying with strict prompt`);
    move = await askForMove(ai, game.fen, game.moves, legalMoves, true);
    if (move && this.tryApply(sideKey, move, game.fen, notifyAfterMove)) return;

    // Two strikes — auto-resign so the human isn't stuck.
    console.warn(`[ai-mover] ${ai.id}: 2 bad responses, resigning`);
    this.chess.resign(sideKey);
    notifyAfterMove();
  }

  private tryApply(sideKey: string, raw: string, fen: string, notifyAfterMove: () => void): boolean {
    const parsed = extractMove(raw, fen);
    if (!parsed) {
      // Log the truncated raw response so we can diagnose models that
      // chronically fail. 240 chars fits one log line + a normal prompt
      // window without flooding the journal.
      console.warn(`[ai-mover] couldn't extract a legal move from ${sideKey}; raw=${JSON.stringify(raw.slice(0, 240))}`);
      return false;
    }
    const result = this.chess.applyMove(sideKey, parsed);
    if (!result.ok) {
      console.warn(`[ai-mover] illegal move from ${sideKey}: ${raw.slice(0, 80)} → ${JSON.stringify(parsed)} (${result.error})`);
      return false;
    }
    notifyAfterMove();
    return true;
  }
}

// ---- Prompt + parsing (stateless helpers, shared across rooms) -----------

function buildSystemPrompt(ai: ReturnType<typeof getAIPlayer> & object, color: "white" | "black"): string {
  const base = [
    `You are playing chess as ${color}. Reply with ONE chess move and nothing else.`,
    `Format: either UCI (e2e4, g8f6, e7e8q for promotion) OR SAN (e4, Nf6, O-O, exd5, e8=Q).`,
    ``,
    `RULES:`,
    `  - Output ONLY the move. No words around it.`,
    `  - NO <think>, <reasoning>, or any other tags.`,
    `  - NO analysis, NO commentary, NO "I'll play", NO explanation.`,
    `  - Do not echo the position. Do not list candidates.`,
    `  - Just the move. One token. Done.`,
    ``,
    // Few-shot framing: the next two turns are examples from UNRELATED
    // games (both with ${color} to move) so the model locks onto the exact
    // "position in → one bare UCI move out" shape. Chess-LLM research shows
    // this few-shot priming is the single biggest lever for cutting illegal
    // / unparseable replies. The real position arrives in the final turn —
    // always authoritative via its FEN; the examples are not this game.
    `The next 2 turns are FORMAT EXAMPLES from other games. Your actual game is the LAST position — play from its FEN.`,
  ].join("\n");
  return ai.systemPromptExtra ? `${base}\n\n${ai.systemPromptExtra}` : base;
}

// Two opening example turns per side, used as few-shot priming. Each is a
// real, legal position with the model's color to move and a sound reply
// in UCI — teaching the reply format without nudging toward any line in
// the actual game. (extractMove still validates the real move against the
// live FEN, so a confused model is caught + retried regardless.)
type ShotEx = { fen: string; history: string[]; answer: string };
const FEW_SHOT: Record<"white" | "black", ShotEx[]> = {
  white: [
    { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", history: [], answer: "e2e4" },
    {
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2",
      history: ["e4", "e5"],
      answer: "g1f3",
    },
  ],
  black: [
    { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", history: ["e4"], answer: "c7c5" },
    {
      fen: "rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3 0 2",
      history: ["d4", "Nf6", "c4"],
      answer: "g7g6",
    },
  ],
};

/** Few-shot message pairs (user position → assistant move) for the side
 *  to move. Inserted between the system prompt and the real position. */
function buildFewShot(color: "white" | "black"): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const ex of FEW_SHOT[color]) {
    out.push({ role: "user", content: buildUserPrompt(ex.fen, ex.history, [], false) });
    out.push({ role: "assistant", content: ex.answer });
  }
  return out;
}

function buildUserPrompt(fen: string, history: string[], legal: string[], strict: boolean): string {
  const lines = [
    `Position (FEN):`,
    fen,
    ``,
    `Move history (SAN, oldest first):`,
    history.length > 0 ? history.join(" ") : "(no moves yet)",
    ``,
    `It is your turn. Reply with ONE move in UCI format.`,
  ];
  if (strict) {
    lines.push("");
    lines.push("Your previous response was rejected as illegal or unparseable.");
    lines.push("Pick ONE move from this exact list of legal moves:");
    lines.push(legal.join(" "));
    lines.push("Reply with just the chosen move, in UCI, nothing else.");
  }
  return lines.join("\n");
}

async function askForMove(
  ai: ReturnType<typeof getAIPlayer> & object,
  fen: string,
  history: string[],
  legal: string[],
  strict: boolean,
): Promise<string | null> {
  const ch = new Chess();
  try {
    ch.load(fen);
  } catch {
    return null;
  }
  const color: "white" | "black" = ch.turn() === "w" ? "white" : "black";

  const url = `${ai.baseURL.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: ai.model,
    messages: [
      { role: "system" as const, content: buildSystemPrompt(ai, color) },
      // Few-shot format priming (2 example turns, same side to move).
      ...buildFewShot(color),
      { role: "user" as const, content: buildUserPrompt(fen, history, legal, strict) },
    ],
    // Reasoning models (Kimi K2, MiniMax M2.7) emit hundreds of tokens
    // of internal reasoning before producing the answer. 256 was way
    // too tight — Kimi was hitting the cap mid-reasoning so content
    // came back empty. 2048 leaves plenty of room and the cost is
    // negligible (we only pay for what's used, capped at this).
    max_tokens: ai.maxTokens ?? 2048,
    temperature: strict ? 0 : 0.4,
  };

  let res: Response;
  try {
    // 30s timeout — most providers respond in 1–10s. Anything beyond
    // is effectively a hung connection; better to fall through to
    // the retry logic than block the game indefinitely.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      // Most providers want `Authorization: Bearer …`; Bankr's OpenClaw
      // wants `X-API-Key: …`. Pick based on the registry config.
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (ai.authStyle === "x-api-key") {
        headers["x-api-key"] = ai.apiKey;
      } else {
        headers.authorization = `Bearer ${ai.apiKey}`;
      }
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    console.warn(`[ai-mover] ${ai.id}: fetch failed`, (err as Error).message);
    return null;
  }
  if (!res.ok) {
    console.warn(`[ai-mover] ${ai.id}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return null;
  }
  const data = (await res.json().catch(() => null)) as
    | {
        choices?: {
          message?: { content?: string; reasoning_content?: string };
          finish_reason?: string;
        }[];
      }
    | null;
  const choice = data?.choices?.[0];
  const content = choice?.message?.content?.trim() ?? "";
  const reasoning = choice?.message?.reasoning_content?.trim() ?? "";
  const finishReason = choice?.finish_reason ?? "?";

  // Reasoning models (Kimi K2.6, sometimes MiniMax M2.7) split output:
  // `content` holds the final answer, `reasoning_content` holds the
  // chain of thought. If the model hit max_tokens mid-reasoning,
  // `content` comes back empty — fall back to reasoning_content, since
  // extractMove can fish a UCI / SAN token out of the reasoning text
  // (the model usually states the chosen move there in passing).
  if (!content && !reasoning) {
    console.warn(`[ai-mover] ${ai.id}: empty response (finish_reason=${finishReason})`);
    return null;
  }
  if (!content) {
    console.warn(`[ai-mover] ${ai.id}: content empty (finish=${finishReason}), falling back to reasoning_content`);
    return reasoning;
  }
  return content;
}

// ---- UCI helpers -----------------------------------------------------

function computeLegalUCIs(fen: string): string[] {
  try {
    const ch = new Chess();
    ch.load(fen);
    return ch.moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ""}`);
  } catch {
    return [];
  }
}

// Extract a legal chess move from arbitrary model output. Tries UCI
// first (the format we ASK for), then falls back to SAN by scanning
// for chess-move-looking tokens and asking chess.js to validate each.
//
// Why both: reasoning models like MiniMax M2.7 wrap their answer in
// `<think>` blocks and often emit the final move in SAN ("Nc6") rather
// than UCI ("b8c6"). Accepting SAN drops the strict-retry rate by ~80%
// in informal testing, which roughly halves API spend per move.
const UCI_RE = /([a-h][1-8])([a-h][1-8])([qrbn])?/gi;
const SAN_RE = /\b(?:O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?[+#]?|[a-h]x?[a-h][1-8](?:=?[QRBN])?[+#]?|[a-h][1-8](?:=?[QRBN])?[+#]?)\b/g;

function extractMove(text: string, fen: string): { from: string; to: string; promotion?: string } | null {
  for (const m of text.matchAll(UCI_RE)) {
    const candidate = {
      from: m[1]!.toLowerCase(),
      to: m[2]!.toLowerCase(),
      promotion: m[3]?.toLowerCase(),
    };
    if (validateMove(fen, candidate)) return candidate;
  }
  for (const sanMatch of text.matchAll(SAN_RE)) {
    const san = sanMatch[0];
    const resolved = sanToCoords(fen, san);
    if (resolved) return resolved;
  }
  return null;
}

function validateMove(fen: string, candidate: { from: string; to: string; promotion?: string }): boolean {
  try {
    const ch = new Chess();
    ch.load(fen);
    const m = ch.move(candidate);
    return !!m;
  } catch {
    return false;
  }
}

function sanToCoords(fen: string, san: string): { from: string; to: string; promotion?: string } | null {
  try {
    const ch = new Chess();
    ch.load(fen);
    const move = ch.move(san);
    if (!move) return null;
    return { from: move.from, to: move.to, promotion: move.promotion };
  } catch {
    return null;
  }
}
