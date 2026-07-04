import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room private voting (Voting Booth). Same no-DB pattern as todos:
// JSON snapshot on disk, in-memory cache, change subscribers fan out over
// the WS mesh.
//
// Privacy model (phase 1): ballots are threshold-BFV ciphertexts encrypted
// in the voter's browser under a committee public key generated in the
// poll creator's browser (see packages/nextjs/public/fhe-wasm/). The relay
// is untrusted-by-design here — it stores opaque ciphertext blobs, enforces
// one ballot per identity, and never sees a plaintext ballot or any key
// material. The tally is decrypted client-side by the committee and posted
// back via vote_reveal; the relay records it as claimed-by-creator.
//
// Ciphertexts at the SECURE_THRESHOLD_8192 preset are a few hundred KB, so
// the broadcast state carries only previews + sizes; full ciphertexts are
// fetched on demand (vote_ballots) by the attacker panel and the reveal
// ceremony.

const MAX_POLLS = 20;
const MAX_QUESTION_LEN = 280;
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 120;
const MAX_BALLOTS = 64;
const MAX_CT_B64_LEN = 2_000_000; // ~1.5 MB of ciphertext, generous
const MAX_PUBKEY_B64_LEN = 2_000_000;

export type VoteBallot = {
  /** Stable identity key the one-ballot rule is enforced on. */
  voterKey: string;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  ts: number;
  /** Ciphertext size in bytes (decoded). */
  size: number;
  /** Hex of the first 32 ciphertext bytes — the attacker panel's "what the
   *  server sees" ticker without shipping the full blob to every client. */
  preview: string;
  /** Full ciphertext, base64. Stripped from broadcast snapshots. */
  ct: string;
};

/** Live protocol telemetry for a Sepolia E3 poll — everything the nerdy
 *  frontend timeline renders. Small enough to ride every broadcast. */
export type E3Telemetry = {
  stage:
    | "requesting"
    | "sortition"
    | "dkg"
    | "open"
    | "tallying"
    | "publishing"
    | "decrypting"
    | "revealed"
    | "failed";
  /** Latest one-line narration. */
  message: string;
  /** Nerd feed: timestamped protocol events, newest last (capped). */
  log: { ts: number; text: string; txHash?: string }[];
  e3Id: string | null;
  requestTx: string | null;
  /** Ciphernode addresses serving this poll's committee. */
  committee: string[];
  keyBytes: number;
  /** Unix seconds — on-chain voting window. */
  windowStart: number | null;
  windowEnd: number | null;
  ballotTxs: { voterKey: string; txHash: string }[];
  outputTx: string | null;
  chain: string;
  interfold: string;
  program: string;
  error: string | null;
};

export function newE3Telemetry(chain: string, interfold: string, program: string): E3Telemetry {
  return {
    stage: "requesting",
    message: "preparing E3 request…",
    log: [],
    e3Id: null,
    requestTx: null,
    committee: [],
    keyBytes: 0,
    windowStart: null,
    windowEnd: null,
    ballotTxs: [],
    outputTx: null,
    chain,
    interfold,
    program,
    error: null,
  };
}

export type VotePoll = {
  id: string;
  ts: number;
  question: string;
  options: string[];
  status: "open" | "closed" | "revealed";
  /** "sepolia" = settled through a real Interfold E3 by the public
   *  testnet committee; absent/"room" = legacy in-browser committee. */
  mode?: "room" | "sepolia";
  e3?: E3Telemetry;
  creatorKey: string;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  committee: { size: number; threshold: number };
  /** Committee threshold-BFV public key, base64. */
  pubKey: string;
  ballots: VoteBallot[];
  /** Plaintext tally per option, posted by the reveal ceremony. */
  tally: number[] | null;
  revealedAt: number | null;
  /** On-chain anchor of the revealed result (vote-anchor.ts), when the
   *  relay has anchoring configured. `anchoring` is the in-flight flag. */
  anchoring?: boolean;
  anchor?: { chain: string; txHash: string; explorerUrl: string | null } | null;
};

/** Broadcast-safe poll view: ballots without their ciphertext payloads. */
export type VotePollPublic = Omit<VotePoll, "ballots" | "pubKey"> & {
  ballots: Omit<VoteBallot, "ct">[];
  pubKeyLen: number;
};

type Subscriber = (polls: VotePollPublic[]) => void;

function publicView(poll: VotePoll): VotePollPublic {
  const { ballots, pubKey, ...rest } = poll;
  return {
    ...rest,
    pubKeyLen: Math.floor((pubKey.length * 3) / 4),
    ballots: ballots.map(({ ct: _ct, ...b }) => b),
  };
}

function looksLikeBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

export class VotingBooth {
  private polls: VotePoll[] = [];
  private subscribers = new Set<Subscriber>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { polls?: unknown };
      if (Array.isArray(parsed.polls)) this.polls = (parsed.polls as VotePoll[]).slice(-MAX_POLLS);
    } catch {
      /* missing or unparseable — start empty */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify({ polls: this.polls }));
    } catch {
      /* disk write failure — in-memory state still served */
    }
  }

  private emit(): void {
    const snapshot = this.list();
    for (const fn of this.subscribers) {
      try {
        fn(snapshot);
      } catch {
        /* one bad subscriber shouldn't kill the rest */
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  list(): VotePollPublic[] {
    this.load();
    return this.polls.map(publicView);
  }

  private find(id: string): VotePoll | undefined {
    this.load();
    return this.polls.find(p => p.id === id);
  }

  /** Full ciphertexts for one poll — reveal ceremony + attacker panel. */
  ballotsFor(id: string): { pollId: string; pubKey: string; ballots: VoteBallot[] } | null {
    const poll = this.find(id);
    if (!poll) return null;
    return { pollId: poll.id, pubKey: poll.pubKey, ballots: [...poll.ballots] };
  }

  /** Just the committee public key — voters need it to encrypt a ballot
   *  and it's too big to ride the broadcast snapshots. */
  pubKeyFor(id: string): { pollId: string; pubKey: string } | null {
    const poll = this.find(id);
    if (!poll) return null;
    return { pollId: poll.id, pubKey: poll.pubKey };
  }

  create(input: {
    creatorKey: string;
    address: string | null;
    handle: string | null;
    anonId?: string | null;
    question: string;
    options: unknown;
    pubKey: string;
    committeeSize: number;
    threshold: number;
  }): VotePoll | null {
    this.load();
    const question = input.question.trim().slice(0, MAX_QUESTION_LEN);
    const options = Array.isArray(input.options)
      ? input.options
          .filter((o): o is string => typeof o === "string" && !!o.trim())
          .map(o => o.trim().slice(0, MAX_OPTION_LEN))
          .slice(0, MAX_OPTIONS)
      : [];
    if (!question || options.length < 2) return null;
    if (!input.pubKey || input.pubKey.length > MAX_PUBKEY_B64_LEN || !looksLikeBase64(input.pubKey)) return null;
    const size = Math.floor(input.committeeSize);
    const threshold = Math.floor(input.threshold);
    if (!(size >= 1 && size <= 16) || !(threshold >= 1 && threshold <= size)) return null;
    const poll: VotePoll = {
      id: randomBytes(8).toString("hex"),
      ts: Date.now(),
      question,
      options,
      status: "open",
      creatorKey: input.creatorKey,
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      anonId: input.anonId ?? null,
      committee: { size, threshold },
      pubKey: input.pubKey,
      ballots: [],
      tally: null,
      revealedAt: null,
    };
    this.polls.push(poll);
    if (this.polls.length > MAX_POLLS) this.polls = this.polls.slice(-MAX_POLLS);
    this.persist();
    this.emit();
    return poll;
  }

  cast(input: {
    pollId: string;
    voterKey: string;
    address: string | null;
    handle: string | null;
    anonId?: string | null;
    ct: string;
  }): "ok" | "not-found" | "closed" | "already-voted" | "full" | "bad-ballot" {
    const poll = this.find(input.pollId);
    if (!poll) return "not-found";
    if (poll.status !== "open") return "closed";
    if (poll.ballots.some(b => b.voterKey === input.voterKey)) return "already-voted";
    if (poll.ballots.length >= MAX_BALLOTS) return "full";
    if (!input.ct || input.ct.length > MAX_CT_B64_LEN || !looksLikeBase64(input.ct)) return "bad-ballot";
    const bytes = Buffer.from(input.ct, "base64");
    poll.ballots.push({
      voterKey: input.voterKey,
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      anonId: input.anonId ?? null,
      ts: Date.now(),
      size: bytes.length,
      preview: bytes.subarray(0, 32).toString("hex"),
      ct: input.ct,
    });
    this.persist();
    this.emit();
    return "ok";
  }

  close(pollId: string, byKey: string): boolean {
    const poll = this.find(pollId);
    if (!poll || poll.status !== "open" || poll.creatorKey !== byKey) return false;
    // Sepolia polls close by the on-chain input deadline, not by hand.
    if (poll.mode === "sepolia") return false;
    poll.status = "closed";
    this.persist();
    this.emit();
    return true;
  }

  reveal(pollId: string, byKey: string, tally: unknown): VotePoll | null {
    const poll = this.find(pollId);
    if (!poll || poll.status !== "closed" || poll.creatorKey !== byKey) return null;
    // Sepolia polls are revealed by the committee's decryption, never a client.
    if (poll.mode === "sepolia") return null;
    if (!Array.isArray(tally) || tally.length !== poll.options.length) return null;
    const counts = tally.map(n => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : -1));
    if (counts.some(n => n < 0)) return null;
    poll.tally = counts;
    poll.status = "revealed";
    poll.revealedAt = Date.now();
    this.persist();
    this.emit();
    return poll;
  }

  /** Merge an E3 telemetry patch + append log lines; broadcasts. Called
   *  by the vote-e3 coordinator on every protocol transition. */
  patchE3(pollId: string, patch: Partial<E3Telemetry>, logLine?: { text: string; txHash?: string }): void {
    const poll = this.find(pollId);
    if (!poll || !poll.e3) return;
    Object.assign(poll.e3, patch);
    if (logLine) {
      poll.e3.log.push({ ts: Date.now(), ...logLine });
      if (poll.e3.log.length > 60) poll.e3.log = poll.e3.log.slice(-60);
      poll.e3.message = logLine.text;
    }
    this.persist();
    this.emit();
  }

  /** Coordinator hands us the committee key → poll opens for voting. */
  openE3Poll(pollId: string, pubKeyB64: string): void {
    const poll = this.find(pollId);
    if (!poll) return;
    poll.pubKey = pubKeyB64;
    poll.status = "open";
    this.persist();
    this.emit();
  }

  /** Coordinator delivers the committee-decrypted tally. */
  revealE3Poll(pollId: string, tally: number[]): void {
    const poll = this.find(pollId);
    if (!poll) return;
    poll.tally = tally;
    poll.status = "revealed";
    poll.revealedAt = Date.now();
    this.persist();
    this.emit();
  }

  /** Sepolia-mode poll creation: starts in "requesting" state with no
   *  key yet (the committee will produce it). */
  createE3(input: {
    creatorKey: string;
    address: string | null;
    handle: string | null;
    anonId?: string | null;
    question: string;
    options: unknown;
    chain: string;
    interfold: string;
    program: string;
  }): VotePoll | null {
    this.load();
    const question = input.question.trim().slice(0, MAX_QUESTION_LEN);
    const options = Array.isArray(input.options)
      ? input.options
          .filter((o): o is string => typeof o === "string" && !!o.trim())
          .map(o => o.trim().slice(0, MAX_OPTION_LEN))
          .slice(0, MAX_OPTIONS)
      : [];
    if (!question || options.length < 2) return null;
    const poll: VotePoll = {
      id: randomBytes(8).toString("hex"),
      ts: Date.now(),
      question,
      options,
      status: "closed", // not yet open — flips to open when the committee key lands
      mode: "sepolia",
      e3: newE3Telemetry(input.chain, input.interfold, input.program),
      creatorKey: input.creatorKey,
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      anonId: input.anonId ?? null,
      committee: { size: 3, threshold: 2 },
      pubKey: "",
      ballots: [],
      tally: null,
      revealedAt: null,
    };
    this.polls.push(poll);
    if (this.polls.length > MAX_POLLS) this.polls = this.polls.slice(-MAX_POLLS);
    this.persist();
    this.emit();
    return poll;
  }

  /** Mark anchoring in-flight (broadcasts so the UI can show progress). */
  setAnchoring(pollId: string): void {
    const poll = this.find(pollId);
    if (!poll) return;
    poll.anchoring = true;
    this.emit();
  }

  /** Record the on-chain anchor result (or clear the flag on failure). */
  setAnchor(pollId: string, anchor: { chain: string; txHash: string; explorerUrl: string | null } | null): void {
    const poll = this.find(pollId);
    if (!poll) return;
    poll.anchoring = false;
    poll.anchor = anchor;
    this.persist();
    this.emit();
  }

  remove(pollId: string, byKey: string): boolean {
    this.load();
    const idx = this.polls.findIndex(p => p.id === pollId && p.creatorKey === byKey);
    if (idx < 0) return false;
    this.polls.splice(idx, 1);
    this.persist();
    this.emit();
    return true;
  }
}
