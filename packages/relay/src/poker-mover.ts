// Per-room server-side autonomous poker loop for sponsored AI players.
//
// The poker sibling of ai-mover.ts. A human "sponsors" an LLM into a
// tournament (pays its buy-in; see the poker_sponsor_ai handler in
// index.ts), which seats the bot under an `ai:<model>#<nonce>` key. From
// then on, whenever it's that seat's turn, this mover asks the model for an
// action, validates/clamps it against the engine's legal moves, and submits
// it via PokerState.act. Two attempts (open prompt, then a strict prompt that
// spells out the exact legal amounts); if both fail it falls back to the
// safe default (check if free, else fold) so the table never stalls. The
// relay's 60s turn-clock watchdog is the final backstop.
//
// Driven from the ~2/s poker ticker in index.ts: cheap when it isn't an AI's
// turn (we only call the model if the seat to act is AI-controlled), and the
// inFlight guard means at most one model request per room at a time.

import type { PokerGame, PokerState } from "./poker.js";
import { getAIPlayer, isAIKey } from "./ai-players.js";

// Per-decision HTTP ceiling. Fast models answer in 1–10s; strong reasoners
// legitimately think for tens of seconds. Two attempts = 2× this worst case,
// then the safe fallback fires — never infinite.
const DECISION_TIMEOUT_MS = 90_000;
// If a decision has been "in flight" longer than this, treat it as wedged and
// allow a fresh attempt. Must exceed the worst-case legit duration.
const INFLIGHT_MAX_MS = 220_000;

type AIConfig = NonNullable<ReturnType<typeof getAIPlayer>>;

/** Static, per-tournament context that the live table state doesn't carry but
 *  a competent player needs: the prize-pool split (for ICM / bubble play), the
 *  starting stack (the M-ratio denominator), and a stable id. Built in index.ts
 *  from the escrow (it owns the money); the mover and the /v1/poker REST view
 *  both consume it. Null when no poker escrow is open. */
export type PokerTableConfig = {
  tournamentId: string;
  startingStack: number;
  buyinWei: string;
  blindIntervalMs: number;
  payout: { entrants: number; bps: number[] };
};

/** The legal actions available to the seat to act, with exact chip amounts —
 *  computed from engine state (the engine has no public "legal moves" call,
 *  but act() is the authority that ultimately validates whatever we submit). */
type Options = {
  toCall: number;
  canCheck: boolean;
  callAmount: number;
  canRaise: boolean;
  /** Lowest legal total-this-street for a raise/bet (small-blind aligned). */
  minRaiseTo: number;
  /** All-in ceiling for this seat (its committed + stack). */
  maxTo: number;
};

export class PokerAIMover {
  private inFlight = false;
  private inFlightSince = 0;
  private lastHandledKey = "";

  constructor(private readonly poker: PokerState) {}

  /** A stable fingerprint of the current decision point. While it's unchanged
   *  we've already acted (or are acting) for this exact spot, so repeated
   *  ticks don't fire a second model call. Any legal action advances the
   *  actor (or the bet), changing the key. */
  private decisionKey(g: PokerGame): string {
    const seat = g.actor >= 0 ? g.seats[g.actor] : null;
    return `${g.handId}:${g.street}:${g.actor}:${g.currentBet}:${seat?.committed ?? 0}`;
  }

  /** Called from the poker ticker after every state change / on each tick.
   *  No-op unless a hand is running, it's an AI seat's turn, and we're not
   *  already thinking. `notifyAfterAction` re-broadcasts + runs the end-of-hand
   *  hooks (mirrors ai-mover's notifyAfterMove). */
  async tick(
    notifyAfterAction: () => void,
    opts?: { force?: boolean; config?: PokerTableConfig | null },
  ): Promise<void> {
    if (this.inFlight) {
      if (Date.now() - this.inFlightSince < INFLIGHT_MAX_MS) return;
      console.warn(`[poker-mover] previous decision wedged >${Math.round(INFLIGHT_MAX_MS / 1000)}s — forcing a fresh attempt`);
      this.inFlight = false;
    }

    const g = this.poker.getGame();
    if (g.status !== "running" || g.runningOut || g.actor < 0) return;
    const seat = g.seats[g.actor];
    if (!seat || seat.status !== "active" || !isAIKey(seat.key)) return;

    const key = this.decisionKey(g);
    if (!opts?.force && key === this.lastHandledKey) return;
    this.lastHandledKey = key;

    const ai = getAIPlayer(seat.key);
    if (!ai) {
      // Seat references a model we no longer ship (key was rotated out). Take
      // the safe default so the table isn't stuck waiting on a ghost.
      console.warn(`[poker-mover] no config for ${seat.key}, taking default action`);
      this.poker.act(seat.key, { action: this.safeDefault(g) });
      notifyAfterAction();
      return;
    }

    this.inFlight = true;
    this.inFlightSince = Date.now();
    try {
      await this.playOneTurn(ai, seat.key, notifyAfterAction, opts?.config ?? null);
    } catch (err) {
      console.error("[poker-mover] unexpected failure:", err);
      // Never leave the seat hanging on an unforeseen error.
      const cur = this.poker.getGame();
      if (cur.status === "running" && cur.actor >= 0 && cur.seats[cur.actor]?.key === seat.key) {
        this.poker.act(seat.key, { action: this.safeDefault(cur) });
        notifyAfterAction();
      }
    } finally {
      this.inFlight = false;
    }
  }

  private safeDefault(g: PokerGame): "check" | "fold" {
    const seat = g.actor >= 0 ? g.seats[g.actor] : null;
    const toCall = seat ? g.currentBet - seat.committed : 1;
    return toCall > 0 ? "fold" : "check";
  }

  private async playOneTurn(
    ai: AIConfig,
    seatKey: string,
    notifyAfterAction: () => void,
    config: PokerTableConfig | null,
  ): Promise<void> {
    const g = this.poker.getGame();
    if (g.status !== "running" || g.actor < 0 || g.seats[g.actor]?.key !== seatKey) return;
    const opts = computeOptions(g);

    // First attempt: open prompt.
    let raw = await this.askForAction(ai, g, opts, false, config);
    if (raw && this.tryApply(seatKey, raw, opts, notifyAfterAction)) return;

    // Second attempt: strict prompt listing the exact legal amounts.
    console.warn(`[poker-mover] ${ai.id}: retrying with strict prompt`);
    raw = await this.askForAction(ai, g, opts, true, config);
    if (raw && this.tryApply(seatKey, raw, opts, notifyAfterAction)) return;

    // Two strikes — take the safe default so the human isn't stuck.
    console.warn(`[poker-mover] ${ai.id}: 2 bad responses, taking default action`);
    const cur = this.poker.getGame();
    if (cur.status === "running" && cur.actor >= 0 && cur.seats[cur.actor]?.key === seatKey) {
      this.poker.act(seatKey, { action: this.safeDefault(cur) });
      notifyAfterAction();
    }
  }

  private tryApply(seatKey: string, raw: string, opts: Options, notifyAfterAction: () => void): boolean {
    const g = this.poker.getGame();
    if (g.actor < 0 || g.seats[g.actor]?.key !== seatKey) return true; // spot moved on; nothing to do
    const parsed = parseAction(raw, g, opts);
    if (!parsed) {
      console.warn(`[poker-mover] couldn't parse an action from ${seatKey}; raw=${JSON.stringify(raw.slice(0, 200))}`);
      return false;
    }
    const res = this.poker.act(seatKey, parsed);
    if (!res.ok) {
      console.warn(`[poker-mover] illegal action from ${seatKey}: ${raw.slice(0, 80)} → ${JSON.stringify(parsed)} (${res.error})`);
      return false;
    }
    notifyAfterAction();
    return true;
  }

  private async askForAction(
    ai: AIConfig,
    g: PokerGame,
    opts: Options,
    strict: boolean,
    config: PokerTableConfig | null,
  ): Promise<string | null> {
    const url = `${ai.baseURL.replace(/\/$/, "")}/chat/completions`;
    const seat = g.seats[g.actor]!;
    const body = {
      model: ai.model,
      messages: [
        { role: "system" as const, content: buildSystemPrompt(ai, seat.label) },
        { role: "user" as const, content: buildUserPrompt(g, opts, strict, config) },
      ],
      // Reasoning models pad with hundreds of internal tokens before the
      // answer; 2048 leaves room (we only pay for what's used).
      max_tokens: ai.maxTokens ?? 2048,
      temperature: strict ? 0 : 0.5,
      // Throttle deliberation for reasoning models that are configured for it
      // (poker doesn't need deep thinking; halves their latency). Standard
      // OpenAI field — providers/models that don't support it ignore it.
      ...(ai.reasoningEffort ? { reasoning_effort: ai.reasoningEffort } : {}),
    };

    let res: Response;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DECISION_TIMEOUT_MS);
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (ai.authStyle === "x-api-key") headers["x-api-key"] = ai.apiKey;
        else headers.authorization = `Bearer ${ai.apiKey}`;
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      console.warn(`[poker-mover] ${ai.id}: fetch failed`, (err as Error).message);
      return null;
    }
    if (!res.ok) {
      console.warn(`[poker-mover] ${ai.id}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    const data = (await res.json().catch(() => null)) as
      | { choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[] }
      | null;
    const choice = data?.choices?.[0];
    const content = choice?.message?.content?.trim() ?? "";
    const reasoning = choice?.message?.reasoning_content?.trim() ?? "";
    // If a reasoning model hit the cap mid-thought, `content` is empty — fall
    // back to the reasoning text, which usually states the chosen action.
    if (!content && !reasoning) {
      console.warn(`[poker-mover] ${ai.id}: empty response (finish_reason=${choice?.finish_reason ?? "?"})`);
      return null;
    }
    return content || reasoning;
  }
}

// ---- legal-move computation -----------------------------------------------

export function computeOptions(g: PokerGame): Options {
  const seat = g.seats[g.actor]!;
  const sb = g.smallBlind;
  const toCall = g.currentBet - seat.committed;
  const canCheck = toCall <= 0;
  const callAmount = toCall > 0 ? Math.min(toCall, seat.stack) : 0;
  const maxTo = seat.committed + seat.stack; // all-in ceiling
  // A raise is possible only with chips beyond the call (else a "call" is the
  // most you can do, possibly all-in).
  const canRaise = maxTo > g.currentBet && seat.stack > Math.max(0, toCall);
  // Smallest legal full raise, aligned UP to a whole small-blind increment
  // (the engine rejects non-aligned non-all-in targets). If that exceeds the
  // all-in ceiling, the only "raise" available is the all-in itself.
  let minRaiseTo = g.currentBet + g.minRaise;
  if (minRaiseTo % sb !== 0) minRaiseTo = Math.ceil(minRaiseTo / sb) * sb;
  if (minRaiseTo > maxTo) minRaiseTo = maxTo;
  return { toCall, canCheck, callAmount, canRaise, minRaiseTo, maxTo };
}

/** Clamp a model's desired total-this-street to a legal raise target: inside
 *  [minRaiseTo, maxTo], aligned to a small-blind multiple, and snapped to the
 *  all-in ceiling when it lands at/above it (all-in is exempt from alignment).*/
function clampRaiseTo(want: number, g: PokerGame, opts: Options): number {
  const sb = g.smallBlind;
  let to = Math.round(want);
  if (to >= opts.maxTo) return opts.maxTo; // all-in
  if (to < opts.minRaiseTo) to = opts.minRaiseTo;
  if (to % sb !== 0) to = Math.round(to / sb) * sb;
  if (to < opts.minRaiseTo) to = opts.minRaiseTo;
  if (to >= opts.maxTo) return opts.maxTo;
  return to;
}

// ---- prompt + parsing ------------------------------------------------------

function buildSystemPrompt(ai: AIConfig, name: string): string {
  const base = [
    `You are "${name}", a sharp No-Limit Texas Hold'em poker player. It is your turn to act.`,
    `Reply with ONE action and NOTHING else — no explanation, no analysis, no tags.`,
    ``,
    `Your reply must be exactly one of:`,
    `  FOLD`,
    `  CHECK`,
    `  CALL`,
    `  RAISE <amount>   (where <amount> is the TOTAL chips you want in for this street)`,
    `  ALLIN`,
    ``,
    `Only choose an action that is listed as legal below. Output just the action token. Done.`,
  ].join("\n");
  return ai.systemPromptExtra ? `${base}\n\n${ai.systemPromptExtra}` : base;
}

function positionLabel(g: PokerGame, idx: number): string {
  if (idx === g.button) return "button (dealer)";
  return `seat ${g.seats[idx]!.seatIdx}`;
}

function buildUserPrompt(g: PokerGame, opts: Options, strict: boolean, config: PokerTableConfig | null): string {
  const me = g.seats[g.actor]!;
  const board = g.board.length ? g.board.join(" ") : "(none yet)";
  const hole = me.hole ? me.hole.join(" ") : "(unknown)";
  const potTotal = g.pots.reduce((n, p) => n + p.amountChips, 0) + g.seats.reduce((n, s) => n + s.committed, 0);
  const others = g.seats
    .filter((_, i) => i !== g.actor)
    .map(s => `  ${s.label} [${positionLabel(g, g.seats.indexOf(s))}]: stack ${s.stack}, in-pot ${s.committed}, ${s.status}`)
    .join("\n");

  // Blind schedule — projects the structure ahead so the bot isn't blindsided
  // by a turbo. Blinds = base × 2^level; level advances every blindIntervalMs.
  const playersLeft = g.seats.filter(s => s.stack > 0).length;
  const scheduleLine =
    g.blindIntervalMs > 0
      ? `Blind schedule: level ${g.blindLevel}, blinds double every ${Math.round(g.blindIntervalMs / 6000) / 10}m — ` +
        `next level ${g.baseSmallBlind * 2 ** (g.blindLevel + 1)}/${g.baseBigBlind * 2 ** (g.blindLevel + 1)}.`
      : `Blind schedule: fixed (no escalation).`;
  // Tournament context — starting stack (M-ratio) + the payout split (ICM): a
  // top-3-paid table near the bubble is played very differently from
  // winner-take-all. Falls back to just the survivor count if config is absent.
  const tourneyLines = config
    ? [
        `Tournament: started ${config.startingStack} chips each; ${playersLeft} of ${config.payout.entrants} players left.`,
        `Payout: top ${config.payout.bps.length} of ${config.payout.entrants} paid ` +
          `(${config.payout.bps.map(b => `${b / 100}%`).join("/")}) — survival has value, weigh it near the bubble.`,
      ]
    : [`${playersLeft} players left.`];

  const menu: string[] = [];
  if (opts.toCall > 0) menu.push("FOLD");
  if (opts.canCheck) menu.push("CHECK");
  if (opts.toCall > 0) menu.push(`CALL  (costs ${opts.callAmount} chips${opts.callAmount >= me.stack ? ", all-in" : ""})`);
  if (opts.canRaise) {
    menu.push(`RAISE <amount>  (amount from ${opts.minRaiseTo} to ${opts.maxTo}, in multiples of ${g.smallBlind})`);
    menu.push(`ALLIN  (raise all-in to ${opts.maxTo})`);
  }

  const lines = [
    `Street: ${g.street}    Blinds: ${g.smallBlind}/${g.bigBlind}`,
    scheduleLine,
    ...tourneyLines,
    `Board: ${board}`,
    `Your hole cards: ${hole}`,
    `You are: ${me.label} [${positionLabel(g, g.actor)}], stack ${me.stack}, already in-pot this street ${me.committed}.`,
    `Pot (incl. this street's bets): ${potTotal}`,
    `To call: ${opts.toCall > 0 ? opts.callAmount : 0}`,
    ``,
    `Other players:`,
    others || "  (none)",
    ``,
    `Legal actions:`,
    ...menu.map(m => `  ${m}`),
    ``,
    `Reply with ONE action token.`,
  ];
  if (strict) {
    lines.push("");
    lines.push("Your previous reply was rejected as illegal or unparseable.");
    lines.push("Pick EXACTLY one option from the legal actions above and reply with just that token");
    lines.push(`(for RAISE, include a whole number between ${opts.minRaiseTo} and ${opts.maxTo}). Nothing else.`);
  }
  return lines.join("\n");
}

const ACTION_RE = /\b(ALL[\s_-]?IN|FOLD|CHECK|CALL|RAISE|BET)\b/i;
const NUM_RE = /-?\d[\d,]*/;

/** Turn arbitrary model output into a legal ActArgs, or null if no action can
 *  be recovered. We pick the LAST action keyword (reasoning models often
 *  restate the final choice at the end) and clamp any raise to a legal
 *  target. The engine's act() is still the authority — anything that slips
 *  through illegal is caught there and retried. */
export function parseAction(text: string, g: PokerGame, opts: Options): { action: "fold" | "check" | "call" | "bet" | "raise"; toChips?: number } | null {
  // Scan for the last action keyword so trailing conclusions win over any
  // candidates mentioned mid-reasoning.
  const matches = [...text.matchAll(new RegExp(ACTION_RE, "gi"))];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const word = last[1]!.toUpperCase().replace(/[\s_-]/g, "");
  const wager = g.currentBet > 0 ? ("raise" as const) : ("bet" as const);

  if (word === "FOLD") return { action: "fold" };
  if (word === "CHECK") return opts.canCheck ? { action: "check" } : null;
  if (word === "CALL") return opts.toCall > 0 ? { action: "call" } : opts.canCheck ? { action: "check" } : null;
  if (word === "ALLIN") return { action: wager, toChips: opts.maxTo };
  // RAISE / BET — read the amount that follows the keyword (fall back to the
  // minimum legal raise if the model named no number).
  if (!opts.canRaise) return null;
  const tail = text.slice((last.index ?? 0) + last[0].length);
  const numMatch = tail.match(NUM_RE) ?? text.match(NUM_RE);
  const want = numMatch ? Number.parseInt(numMatch[0].replace(/,/g, ""), 10) : opts.minRaiseTo;
  if (!Number.isFinite(want)) return { action: wager, toChips: opts.minRaiseTo };
  return { action: wager, toChips: clampRaiseTo(want, g, opts) };
}
