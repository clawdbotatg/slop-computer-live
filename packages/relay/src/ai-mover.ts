// Server-side autonomous chess move loop for AI players.
//
// Wired into the chess broadcast cycle: every time the game state
// changes (create/move/resign/abort), `maybeMoveAI(version)` is
// called. If it's now an AI's turn, the engine asks that AI's model
// for a move (one retry on illegal/parse failure with a stricter
// prompt; second failure auto-resigns the AI so the human isn't
// stuck waiting on a broken provider).

import { Chess } from "chess.js";
import { applyMove as chessApply, resign as chessResign, getCurrentGame } from "./chess.js";
import { getAIPlayer, isAIKey } from "./ai-players.js";

let inFlight = false;
let lastVersionHandled = -1;

/** Called from `bumpChessVersion()` on every state change. Cheap when
 *  it's not an AI's turn — we only kick off the model call if the
 *  side-to-move's ownerKey is one of ours. */
export async function maybeMoveAI(
  version: number,
  notifyAfterMove: () => void,
): Promise<void> {
  // Coalesce: if we already started a move for this version, skip.
  // The new state from our own move will bump the version again, which
  // re-runs us — that's how AI-vs-AI keeps stepping forward.
  if (inFlight) return;
  if (version <= lastVersionHandled) return;
  lastVersionHandled = version;

  const game = getCurrentGame();
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
    chessResign(sideKey);
    notifyAfterMove();
    return;
  }

  inFlight = true;
  try {
    await playOneTurn(ai, sideKey, notifyAfterMove);
  } catch (err) {
    console.error("[ai-mover] unexpected failure:", err);
  } finally {
    inFlight = false;
  }
}

async function playOneTurn(
  ai: ReturnType<typeof getAIPlayer> & object,
  sideKey: string,
  notifyAfterMove: () => void,
): Promise<void> {
  const game = getCurrentGame();
  if (!game || game.status !== "active") return;

  // Compute legal moves once — we use them for the strict-retry prompt
  // AND to validate parsed responses before sending them to chess.js.
  const legalMoves = computeLegalUCIs(game.fen);

  // First attempt: open prompt.
  let move = await askForMove(ai, game.fen, game.moves, legalMoves, false);
  if (move && tryApply(sideKey, move, notifyAfterMove)) return;

  // Second attempt: stricter prompt that lists the legal options.
  console.warn(`[ai-mover] ${ai.id}: retrying with strict prompt`);
  move = await askForMove(ai, game.fen, game.moves, legalMoves, true);
  if (move && tryApply(sideKey, move, notifyAfterMove)) return;

  // Two strikes — auto-resign so the human isn't stuck.
  console.warn(`[ai-mover] ${ai.id}: 2 bad responses, resigning`);
  chessResign(sideKey);
  notifyAfterMove();
}

function tryApply(sideKey: string, uci: string, notifyAfterMove: () => void): boolean {
  const parsed = parseUCI(uci);
  if (!parsed) return false;
  const result = chessApply(sideKey, parsed);
  if (!result.ok) {
    console.warn(`[ai-mover] illegal move from ${sideKey}: ${uci} (${result.error})`);
    return false;
  }
  notifyAfterMove();
  return true;
}

// ---- Prompt + parsing ------------------------------------------------

function buildSystemPrompt(ai: ReturnType<typeof getAIPlayer> & object, color: "white" | "black"): string {
  const base = [
    `You are playing a serious chess game as ${color}.`,
    `Reply with EXACTLY ONE move in UCI format and nothing else.`,
    `UCI = "<from-square><to-square>" with optional promotion piece, e.g.:`,
    `  e2e4`,
    `  g8f6`,
    `  e7e8q   (pawn promotion to queen)`,
    `Do not include analysis, narration, or punctuation. JUST the move.`,
  ].join("\n");
  return ai.systemPromptExtra ? `${base}\n\n${ai.systemPromptExtra}` : base;
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
      { role: "user" as const, content: buildUserPrompt(fen, history, legal, strict) },
    ],
    max_tokens: ai.maxTokens ?? 256,
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
    | { choices?: { message?: { content?: string } }[] }
    | null;
  const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
  return text || null;
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

const UCI_RE = /([a-h][1-8])([a-h][1-8])([qrbn])?/i;
function parseUCI(text: string): { from: string; to: string; promotion?: string } | null {
  // Tolerate models that wrap the move in quotes / backticks / a sentence.
  const m = text.match(UCI_RE);
  if (!m) return null;
  return {
    from: m[1]!.toLowerCase(),
    to: m[2]!.toLowerCase(),
    promotion: m[3]?.toLowerCase(),
  };
}
