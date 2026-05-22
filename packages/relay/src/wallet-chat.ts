// Per-room AI-wallet conversation — shared across the mesh. Replaces
// the old per-iframe localStorage chat: now the whole room sees one
// conversation, anyone can send a message, and the AI's answers (incl.
// transaction cards) land on every peer at once.
//
// Flow, mirroring the Research async-job pattern:
//   1. a peer POSTs /v1/wallet-chat  → appendUser(): user msg added,
//      `processing` flips true, broadcast.
//   2. relay runs runWalletIntent()  → appendAssistant(): assistant msg
//      added with any transaction / multistep payload, `processing`
//      flips false, broadcast.
// "Send to multisig" on a transaction card is a separate client action
// that flows into the existing multiplayer multisig queue.
//
// Persisted to wallet-chat.json so a relay restart (every deploy) keeps
// the conversation. A restart kills any in-flight intent call, so on
// load we force `processing` back to false — otherwise the UI would be
// stuck behind a spinner nothing will ever clear.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import type { IntentResult, IntentStep, IntentTransaction } from "./wallet-intent.js";

export type WalletChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  /** Display label of the peer who sent a user message; null for the AI. */
  sender: string | null;
  /** Assistant-only: a single built transaction the UI renders as a card. */
  transaction?: IntentTransaction | null;
  /** Assistant-only: a multi-step transaction (ENS register, approve+swap). */
  multistep?: { steps: IntentStep[]; delay: number; priceEth?: string; priceWei?: string } | null;
  /** Assistant-only: set when the intent call itself errored. */
  error?: string | null;
};

export type WalletChatSnapshot = {
  messages: WalletChatMessage[];
  /** True while an intent call is in flight — drives the room-wide spinner. */
  processing: boolean;
};

// Keep the persisted history bounded. The intent engine only ever reads
// the last few turns anyway (see recentForIntent below).
const MAX_MESSAGES = 60;
// How many prior turns to feed the model as conversation context.
const INTENT_HISTORY_TURNS = 12;

const DEFAULT_SNAPSHOT: WalletChatSnapshot = { messages: [], processing: false };

type Listener = (snapshot: WalletChatSnapshot) => void;

function newId(): string {
  return randomBytes(8).toString("hex");
}

export class WalletChatState {
  private snapshot: WalletChatSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners: Listener[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WalletChatSnapshot>;
      this.snapshot = {
        messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_MESSAGES) : [],
        // A persisted `processing: true` is always stale — the call it
        // belonged to died with the previous relay process.
        processing: false,
      };
    } catch {
      /* missing or unparseable — keep the fresh default */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.snapshot));
    } catch {
      /* disk write failed — state stays in memory, broadcast still fires */
    }
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.snapshot);
      } catch {
        /* ignore */
      }
    }
  }

  current(): { state: WalletChatSnapshot } {
    this.load();
    return { state: this.snapshot };
  }

  /** True if an intent call is already running — routes use this to
   *  refuse overlapping sends (one conversation, one turn at a time). */
  isProcessing(): boolean {
    this.load();
    return this.snapshot.processing;
  }

  /** Append a user message and flip into the processing state. */
  appendUser(content: string, sender: string | null): WalletChatMessage {
    this.load();
    const msg: WalletChatMessage = { id: newId(), role: "user", content, ts: Date.now(), sender };
    this.snapshot = {
      messages: [...this.snapshot.messages, msg].slice(-MAX_MESSAGES),
      processing: true,
    };
    this.persist();
    this.notify();
    return msg;
  }

  /** Append the AI's answer from an intent result and clear processing. */
  appendAssistant(result: IntentResult): WalletChatMessage {
    this.load();
    const msg: WalletChatMessage = {
      id: newId(),
      role: "assistant",
      content: result.message,
      ts: Date.now(),
      sender: null,
      transaction: result.type === "transaction" ? result.transaction : null,
      multistep:
        result.type === "multistep_transaction"
          ? { steps: result.steps, delay: result.delay, priceEth: result.priceEth, priceWei: result.priceWei }
          : null,
      error: result.type === "chat" ? (result.error ?? null) : null,
    };
    this.snapshot = {
      messages: [...this.snapshot.messages, msg].slice(-MAX_MESSAGES),
      processing: false,
    };
    this.persist();
    this.notify();
    return msg;
  }

  /** Clear processing without adding a message — used if a send is
   *  rejected after it already flipped the flag. */
  clearProcessing(): void {
    this.load();
    if (!this.snapshot.processing) return;
    this.snapshot = { ...this.snapshot, processing: false };
    this.persist();
    this.notify();
  }

  /** Wipe the conversation back to empty (new episode / explicit reset). */
  reset(): WalletChatSnapshot {
    this.loaded = true;
    this.snapshot = { ...DEFAULT_SNAPSHOT };
    this.persist();
    this.notify();
    return this.snapshot;
  }

  /** The last N turns as plain {role, content} pairs for the intent
   *  engine's `recentMessages` — excludes the just-appended user msg,
   *  which the caller passes separately as the current message. */
  recentForIntent(excludeId: string): { role: string; content: string }[] {
    this.load();
    return this.snapshot.messages
      .filter(m => m.id !== excludeId)
      .slice(-INTENT_HISTORY_TURNS)
      .map(m => ({ role: m.role, content: m.content }));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}
