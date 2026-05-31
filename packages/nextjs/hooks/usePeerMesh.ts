"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withSlug } from "~~/lib/slug";

const RELAY_WS_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://slop.computer/signal";
const RELAY_HTTP_URL = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Fallback when our relay's TURN server isn't reachable yet — STUN-only.
// This works for same-NAT testing but fails on symmetric NATs.
const FALLBACK_ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

type TurnCreds = {
  username: string;
  credential: string;
  ttl: number;
  urls: string[];
};

let cachedTurn: { config: RTCConfiguration; expiresAt: number } | null = null;

async function fetchIceConfig(): Promise<RTCConfiguration> {
  // Reuse if still valid (refresh 60s before expiry).
  if (cachedTurn && cachedTurn.expiresAt > Date.now() + 60_000) {
    return cachedTurn.config;
  }
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/turn/credentials`, { credentials: "include" });
    if (!res.ok) return FALLBACK_ICE;
    const data = (await res.json()) as TurnCreds;
    const config: RTCConfiguration = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: data.urls,
          username: data.username,
          credential: data.credential,
        },
      ],
    };
    cachedTurn = { config, expiresAt: Date.now() + data.ttl * 1000 };
    return config;
  } catch {
    return FALLBACK_ICE;
  }
}

// 10s gives the guest-list ping meter a usefully-live cadence without
// flooding the relay (a 20-peer room is ~38 fanout msgs/s — trivial).
const PING_INTERVAL_MS = 10_000;
const CURSOR_THROTTLE_MS = 50; // 20Hz — was 30Hz; imperceptible at slop tile sizes
const CURSOR_MIN_DELTA_PX = 4; // skip the broadcast for sub-jitter movement
const RECONNECT_DELAY_MS = 2000;

// Stream watchdog — catches the "waiting for stream…" hang where a
// publication is live on the relay but no MediaStream has arrived via
// WebRTC (reload, spotty network, ICE giving up). Without this, the tile
// stays dark forever because nothing tries to re-establish the pc.
const STREAM_WATCHDOG_INTERVAL_MS = 2000;
const STREAM_WAIT_TIMEOUT_MS = 6000; // grace before we declare a pub stuck
const STREAM_RECONNECT_BACKOFF_MS = 10_000; // min interval between retries per peer

// Per-kind outgoing-encoder caps applied via RTCRtpSender.setParameters
// after every addTrack. Full mesh means one encoder per peer-connection,
// so capping bitrate/framerate/resolution here is the single biggest
// CPU lever on the publisher side.
//
// Original numbers were tuned for "tile-sized" playback only (600 kbps
// camera). That looks fine in a 240px tile but falls apart when a
// god-mode session re-encodes the captured desktop at 3 Mbps for the
// RTMP broadcast — two lossy h264 passes back-to-back produce visible
// compression artifacts in the final stream. Bumped to give the
// broadcast pass room to breathe; modern laptops + typical home upload
// (10+ Mbps) handle these comfortably.
const CAMERA_MAX_BITRATE = 1_500_000; // 1.5 Mbps — clean 480p, decent 720p
const CAMERA_MAX_FRAMERATE = 30;
const SCREEN_MAX_BITRATE = 2_500_000; // 2.5 Mbps — sharp text in screen shares
const SCREEN_MAX_FRAMERATE = 15;

function applySenderCaps(pc: RTCPeerConnection, stream: MediaStream, kind: SlotKind): void {
  // Audio is cheap to encode and voice quality matters — leave it alone.
  if (kind === "audio") return;
  const streamTracks = new Set(stream.getTracks());
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;
    if (!streamTracks.has(sender.track)) continue;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    if (kind === "camera") {
      params.encodings[0] = {
        ...params.encodings[0],
        maxBitrate: CAMERA_MAX_BITRATE,
        maxFramerate: CAMERA_MAX_FRAMERATE,
      };
    } else if (kind === "screen") {
      params.encodings[0] = {
        ...params.encodings[0],
        maxBitrate: SCREEN_MAX_BITRATE,
        maxFramerate: SCREEN_MAX_FRAMERATE,
      };
    }
    sender.setParameters(params).catch(err => console.warn("[mesh] setParameters failed", err));
  }
}

// macOS / VideoToolbox has no hardware VP8 decoder, so a high-res
// screenshare delivered as VP8 ends up software-decoded by libvpx on
// the receiver and chokes its CPU (visible as choppy playback even
// though the publisher is encoding fine). VP9 and H.264 are both
// hardware-accelerated on Apple Silicon, so we bias every video
// transceiver's codec list toward VP9 → H.264 → everything else,
// dropping VP8 to the back. setCodecPreferences only affects the
// *next* negotiation, so this must run before createOffer /
// createAnswer; on the answerer side it must also run after
// setRemoteDescription so the transceivers created from the remote
// offer get prefs applied.
function preferEfficientVideoCodecs(pc: RTCPeerConnection): void {
  if (typeof RTCRtpSender.getCapabilities !== "function") return;
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps?.codecs?.length) return;
  const isPreferred = (mimeType: string) => /\/(VP9|H264)$/i.test(mimeType);
  const preferred = caps.codecs.filter(c => isPreferred(c.mimeType));
  if (preferred.length === 0) return;
  const others = caps.codecs.filter(c => !isPreferred(c.mimeType));
  const ordered = [...preferred, ...others];
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.receiver.track?.kind !== "video") continue;
    if (typeof transceiver.setCodecPreferences !== "function") continue;
    try {
      transceiver.setCodecPreferences(ordered);
    } catch (err) {
      console.warn("[mesh] setCodecPreferences failed", err);
    }
  }
}

export type Peer = {
  id: string;
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
  /** Stable per-session anon id (no wallet/passkey). Used as the
   *  customNames lookup key + flag-color seed so renaming an anon
   *  doesn't shuffle their colors. Null for SIWE/passkey peers. */
  anonId: string | null;
  connectedAt?: number;
  // Set by the relay for god-mode streaming sessions. Kept in the
  // peers array so RTC signaling works (the streamer needs audio/
  // video offers), but every display layer filters spectators out
  // before rendering.
  spectator?: boolean;
  /** P-256 pubkey + credential-id hash. Populated for passkey peers
   *  (signed in via /auth/passkey). The deploy form auto-routes peers
   *  with this field into the `passkeyQxs/Qys/credentialIdHashes`
   *  arrays of `createMultisig` instead of the EOA array. */
  passkey?: { qx: string; qy: string; credentialIdHash: string };
};

export type SlotKind = "camera" | "screen" | "audio";

export type Publication = {
  streamId: string;
  peerId: string; // ephemeral
  ownerKey: string; // stable across reconnects (wallet address or handle)
  kind: SlotKind;
  label: string;
  /** Camera publications only. True === publisher switched to audio-only
   *  (video stopped, mic still live) and peers should render the avatar
   *  instead of the black video. Broadcast via `set_camera_off`. */
  cameraOff?: boolean;
};

export type SlotPosition = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
};

type CursorData = {
  x: number;
  y: number;
  /** Optional inline identity — present when the source is an HTTP agent
   *  that isn't a registered WS peer. Used to render label + blockie
   *  colors without a peers-list lookup. */
  address?: string | null;
  handle?: string | null;
  anonId?: string | null;
};

export type ClickEvent = {
  /** Monotonic id used as React key + for cleanup. Local-only. */
  id: number;
  peerId: string;
  x: number;
  y: number;
  /** Same inline-identity shape as CursorData. */
  address?: string | null;
  handle?: string | null;
  anonId?: string | null;
  receivedAt: number;
};

export type Browser = {
  id: string;
  url: string;
  openedBy: string;
  openedAt: number;
  // Set when the window was launched from a specific app entry. Frontend
  // uses this to lock chrome to that app — e.g. abi-ninja hides the URL
  // bar so the window stays pinned to abi.ninja.
  appId?: string;
};

export type TxRequest = {
  from: string;
  browserId: string;
  calldata: string;
  to: string | null;
  value: string | null;
  chainId: number | null;
  receivedAt: number;
};

/** A captured eth_sendTransaction (or other write method) that another peer
 *  forwarded to us because they're impersonating our wallet address. The
 *  receiver-side modal renders these and asks the user to sign+broadcast
 *  through their actually-connected wagmi wallet. */
export type ForwardedTx = {
  /** Server-issued id (relay tags the message). Used as the React key
   *  and the dismiss handle. */
  id: string;
  /** Peer id of the sender — useful for dedupe, debugging. */
  fromPeerId: string;
  /** Sender's address + handle, if known. Display-only. */
  fromAddress: string | null;
  fromHandle: string | null;
  /** Originating browser-host window (so the receiver knows which dapp
   *  generated this tx). */
  browserId: string;
  /** RPC method — currently only "eth_sendTransaction" is actionable;
   *  other methods are surfaced but disabled. */
  method: string;
  params: unknown[];
  /** Chain the captured tx belongs to. Sender derives this from the
   *  browser-host's configured chain (or an explicit `chainId` in tx
   *  params). Receiver compares to wagmi's current chain and offers a
   *  switch when they differ. `null` = sender didn't know. */
  chainId: number | null;
  receivedAt: number;
};

/** Session-wallet (multisig) records — mirrors
 *  `packages/relay/src/wallet.ts`. */
export type WalletSigner = {
  address: string;
  label: string;
  signerType: "eoa" | "passkey";
  /** P-256 pubkey + credential-id hash. Populated for passkey signers
   *  so the multisig contract can verify their WebAuthn assertions,
   *  and so the local user can identify *their* passkey credential
   *  (via credentialIdHash) when signing later. Undefined for EOA. */
  qx?: string;
  qy?: string;
  credentialIdHash?: string;
};
export type WalletDeployment = {
  txHash: string | null;
  deployedAt: number;
};
// Collaborative pre-deploy form state — mirrors relay's WalletDraft.
// Cleared once a wallet is deployed.
export type WalletDraft = {
  selected: Record<string, boolean>;
  threshold: number;
  label: string;
  customSigners: { address: string; label: string }[];
};
export type WalletRecord = {
  id: string;
  address: string;
  deployer: string;
  salt: string;
  signers: WalletSigner[];
  threshold: number;
  deployments: Record<number, WalletDeployment>;
  createdAt: number;
  label: string;
};
export type WalletTxSignature = {
  signer: string;
  sigType: 0 | 1;
  data: string;
  receivedAt: number;
};
export type WalletTxStatus = "pending" | "executing" | "executed" | "failed" | "expired" | "cancelled";
// One sub-call inside a batched tx (Multisig.execBatchTransaction).
// Mirrors the relay shape — see packages/relay/src/wallet.ts.
export type WalletTxCall = {
  target: string;
  value: string;
  data: string;
};
export type WalletTx = {
  id: string;
  multisigAddress: string;
  chainId: number;
  from: string | null;
  fromLabel: string | null;
  source: "browser" | "manual";
  browserId: string | null;
  target: string;
  value: string;
  data: string;
  deadline: string;
  nonce: string;
  execHash: string;
  /** Proposer's claim — agent-supplied via REST, or AI fallback when no
   *  human/agent claim was provided. May be a lie. */
  summary: string | null;
  /** Independent AI second opinion. Always re-derived from raw calldata
   *  with no knowledge of `summary`. Same JSON-card shape as `summary`. */
  aiAnalysis: string | null;
  signatures: WalletTxSignature[];
  status: WalletTxStatus;
  txHash: string | null;
  createdAt: number;
  updatedAt: number;
  // When present + non-empty, this tx is a batched
  // Multisig.execBatchTransaction call. The top-level target/value/data
  // are sentinels (self-address, "0", "0x") and ignored at exec time.
  calls?: WalletTxCall[];
};

export type ChatMessage = {
  id: string;
  ts: number;
  address: string | null;
  handle: string | null;
  /** Stable anon id of the sender, if they signed in as anon. Lets
   *  SlopAddress pull the current display name from customNames and
   *  keep flag colors stable across renames. */
  anonId?: string | null;
  text: string;
  source: "live" | "spectator" | "agent";
};

/** Shared todo list item — server-authoritative, mirrors
 *  `packages/relay/src/todos.ts`. */
export type TodoItem = {
  id: string;
  ts: number;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  text: string;
  done: boolean;
};

/** Shared note — server-authoritative, mirrors
 *  `packages/relay/src/notes.ts`. */
export type Note = {
  id: string;
  createdTs: number;
  updatedTs: number;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  text: string;
};

/** Glossary entry — AI-generated TLDR for a term that came up.
 *  Server-authoritative, mirrors `packages/relay/src/glossary.ts`. */
export type GlossaryTerm = {
  id: string;
  term: string;
  tldr: string;
  status: "pending" | "ready" | "error";
  createdTs: number;
  updatedTs: number;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
};

/** Jamendo / Custom playlist track. Mirrors
 *  `packages/relay/src/jamendo.ts`'s JamendoTrack. */
export type JamendoTrack = {
  title: string;
  artist: string;
  src: string;
  duration: number;
  jamendoId: string;
  license: string;
  source: string;
};

/** Ethereum gas snapshot — polled on the relay every ~12s, broadcast on
 *  change. Mirrors `packages/relay/src/gas.ts`. */
export type GasState = {
  baseFeeGwei: number;
  slowGwei: number;
  mediumGwei: number;
  fastGwei: number;
  ethUsd: number;
  updatedAt: number;
};

/** Slop ticker — crypto + AI stocks + private AI lab valuations,
 *  polled on the relay every 60s. Mirrors `packages/relay/src/ticker.ts`. */
export type TickerItem = {
  symbol: string;
  label: string;
  price: number;
  changePct: number;
  kind: "crypto" | "stock" | "private" | "meme";
  url?: string;
};
export type TickerState = {
  items: TickerItem[];
  updatedAt: number;
};

/** Headlines feed — crypto + AI news, polled on the relay every 5 min.
 *  Mirrors `packages/relay/src/headlines.ts`. */
export type Headline = {
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  kind: "crypto" | "ai";
};
export type HeadlinesState = {
  items: Headline[];
  updatedAt: number;
};

/** Twitter timeline feed — host's home timeline ranked by engagement.
 *  Mirrors `packages/relay/src/timeline.ts`. */
export type TimelineItem = {
  id: string;
  text: string;
  authorUsername: string;
  authorName: string;
  authorVerified: boolean;
  authorFollowers: number;
  likes: number;
  retweets: number;
  replies: number;
  createdAt: number;
  url: string;
};
export type TimelineState = {
  items: TimelineItem[];
  updatedAt: number;
};

/** On-screen chyron — broadcast-TV term for the one-line static banner
 *  the host writes by hand during a live show. Distinct from the
 *  scrolling crypto/AI HeadlinesBar. Empty `text` collapses the bar to
 *  zero height. Mirrors `packages/relay/src/chyron.ts`. */
export type ChyronState = {
  text: string;
  updatedAt: number;
};

/** A finalized STT segment. Mirrors `packages/relay/src/transcript.ts`.
 *  Broadcast on the room WS as `{type:"transcript_seg", seg}` whenever a
 *  new line is appended (god-mode Whisper or peer Web Speech). */
export type TranscriptSegment = {
  id: string;
  ts: number;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  text: string;
  source: "live" | "spectator" | "agent";
  /** Absent ⇒ a spoken line. Set ⇒ a relay-narrated in-room action
   *  (music/file/wallet/chess/pong/worm) — archive + poll only, never a caption. */
  kind?: "speech" | "music" | "file" | "wallet" | "chess" | "pong" | "worm";
  /** Structured action metadata; only set on action rows. */
  meta?: Record<string, string | number | boolean | null>;
};

/** In-browser STT result — interim or final — broadcast on the room WS
 *  as `{type:"live_caption", text, isFinal, address, handle, anonId,
 *  speakerKey, ts}`. Faster than `transcript_seg` (Web Speech finalizes
 *  ~1s after speech end vs Whisper's ~3-5s) and the server suppresses
 *  the `transcript_seg` lane for any speaker whose live captions are
 *  flowing — so a viewer never sees both for the same utterance. */
export type LiveCaption = {
  text: string;
  isFinal: boolean;
  address: string | null;
  handle: string | null;
  anonId: string | null;
  speakerKey: string | null;
  ts: number;
};

/** News-digest item — unified shape for crypto headlines, AI headlines,
 *  and tweets, used by the News app. Mirrors
 *  `packages/relay/src/news-digest.ts`. */
export type NewsDigestItem = {
  kind: "crypto-headline" | "ai-headline" | "tweet" | "polymarket";
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  authorUsername?: string;
  authorFollowers?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  pmVolume24h?: number;
  pmTopOutcomeLabel?: string;
  pmTopOutcomeProb?: number;
  pmTags?: string[];
  featured?: boolean;
  featuredReason?: string;
};
export type NewsDigestState = {
  feed: NewsDigestItem[];
  featured: NewsDigestItem[];
  updatedAt: number;
  aiRanAt: number;
};

/** Shared clock app state — mirrors `packages/relay/src/clock.ts`.
 *  Wall-clock-anchored: `endAt` and `startedAt` are `Date.now()`
 *  epoch values, so every peer computes the same remaining/elapsed
 *  from their own local clock without us pushing per-tick updates. */
export type ClockTab = "time" | "timer" | "countdown";
export type ClockStopwatchState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number; pausedElapsedMs: number }
  | { phase: "paused"; pausedElapsedMs: number };
export type ClockCountdownState =
  | { phase: "idle" }
  | { phase: "running"; totalSecs: number; endAt: number }
  | { phase: "paused"; totalSecs: number; remainingSecs: number }
  | { phase: "done"; totalSecs: number };
export type ClockState = {
  tab: ClockTab;
  selectedZone: string;
  stopwatch: ClockStopwatchState;
  countdown: ClockCountdownState;
};

const DEFAULT_CLOCK_STATE: ClockState = {
  tab: "time",
  selectedZone: "local",
  stopwatch: { phase: "idle" },
  countdown: { phase: "idle" },
};

/** Shared "title card" state for the room. `version` is the relay's
 *  card.png mtime — it doubles as a cache-buster in the URL so a
 *  regenerate forces every peer's <img> to re-fetch. */
export type CardState = {
  version: number;
};

/** A card generation in flight on the relay. Broadcast on POST /v1/card
 *  start and cleared (broadcast `card_job: null`) on completion or
 *  failure. Anyone in the room sees this and shows the shared progress
 *  bar — closing the window doesn't cancel it. */
export type CardJob = {
  startedAt: number;
  startedBy: string | null;
};

/** Shared title overlay state for the card. Coordinates are fractions
 *  of the displayed image rect (matches the bake math at download
 *  time), `sizeFrac` is font-size as a fraction of image width.
 *  `null` = the room has never edited the title yet; the client falls
 *  back to defaults derived from the slug. */
export type CardTitle = {
  text: string;
  x: number;
  y: number;
  sizeFrac: number;
};

/** A user-uploaded file on the shared desktop. Mirrors
 *  `packages/relay/src/files.ts` FileEntry. */
export type FileEntry = {
  id: string;
  name: string;
  size: number;
  mime: string;
  ownerKey: string;
  uploaderLabel: string;
  ts: number;
  storedAs: string;
};

export type MusicState = {
  src: string | null;
  index: number;
  playing: boolean;
  /** seconds into the track at the moment captured by `at` */
  position: number;
  /** Date.now() of the snapshot. Live position = position + (now - at)/1000 when playing. */
  at: number;
  /** 0..1 master volume — shared across the mesh so all listeners are at the same loudness. */
  volume: number;
};

// --- Guest research ---------------------------------------------------------
// Multiplayer dossier prep. The phase machine lives on the relay
// (research-state.ts); we only render whatever the latest broadcast
// said. Form-edit typing stays local in ResearchWindow — only the
// submit + reset transitions broadcast.

export type ResearchSocials = {
  twitter?: string;
  github?: string;
  linkedin?: string;
  website?: string;
  other?: string;
};

export type ResearchTweet = { text: string; url?: string; date?: string };
export type ResearchSource = { title: string; url: string; snippet?: string };

export type ResearchResult = {
  query: { name: string; socials: ResearchSocials; notes?: string };
  vanilla: string;
  researched: string;
  questions: string[];
  tweets: ResearchTweet[];
  sources: ResearchSource[];
  errors: { vanilla?: string; researched?: string };
};

export type ResearchJob = {
  kind: "lookup" | "research";
  startedAt: number;
  startedBy: string | null;
};

export type ResearchPhase = "idle" | "lookup-pending" | "form" | "research-pending" | "done";

export type ResearchState = {
  phase: ResearchPhase;
  lookupQuery: string;
  name: string;
  socials: ResearchSocials;
  notes: string;
  result: ResearchResult | null;
  job: ResearchJob | null;
  error: string | null;
};

const DEFAULT_RESEARCH_STATE: ResearchState = {
  phase: "idle",
  lookupQuery: "",
  name: "",
  socials: {},
  notes: "",
  result: null,
  job: null,
  error: null,
};

// --- Leftclaw "Hire" app ----------------------------------------------------
// Multiplayer job-posting to Leftclaw Services. The phase machine lives on
// the relay (leftclaw-state.ts); we render whatever the latest broadcast
// said. Form edits stay local in LeftclawWindow — only start/done/error/
// reset transitions broadcast. The signing + on-chain tx run in the
// driver's browser; these intents just keep spectators in sync.
export type LeftclawPhase = "idle" | "posting" | "done" | "error";
export type LeftclawServiceId = 4 | 6 | 7;
export type LeftclawPayment = "cv" | "usdc";

export type LeftclawJob = {
  startedAt: number;
  startedBy: string | null;
};

export type LeftclawJobRecord = {
  jobId: number;
  jobUrl: string;
  serviceTypeId: LeftclawServiceId | null;
  paymentMethod: LeftclawPayment | null;
  txHash: string | null;
  postedAt: number;
  postedBy: string | null;
};

export type LeftclawState = {
  phase: LeftclawPhase;
  serviceTypeId: LeftclawServiceId | null;
  description: string;
  context: string;
  paymentMethod: LeftclawPayment | null;
  step: string | null;
  job: LeftclawJob | null;
  jobId: number | null;
  jobUrl: string | null;
  txHash: string | null;
  error: string | null;
  /** Newest-first list of jobs posted in this room (survives reset/reload). */
  history: LeftclawJobRecord[];
};

const DEFAULT_LEFTCLAW_STATE: LeftclawState = {
  phase: "idle",
  serviceTypeId: null,
  description: "",
  context: "",
  paymentMethod: null,
  step: null,
  job: null,
  jobId: null,
  jobUrl: null,
  txHash: null,
  error: null,
  history: [],
};

// --- Transcript TLDR --------------------------------------------------------
// Shared "catch me up" summary for the Transcript app. Anyone hits the TLDR
// button; the relay summarizes the recent transcript and broadcasts the same
// result + the in-flight pending flag to every peer. See tldr-state.ts on the
// relay. In-memory on both ends — a relay restart resets it to idle.
export type TldrStatus = "idle" | "pending" | "ready" | "error";

export type TldrRequester = {
  address: string | null;
  handle: string | null;
  anonId: string | null;
};

export type TldrState = {
  status: TldrStatus;
  summary: string;
  generatedAt: number | null;
  requestedBy: TldrRequester | null;
  segmentCount: number;
};

const DEFAULT_TLDR_STATE: TldrState = {
  status: "idle",
  summary: "",
  generatedAt: null,
  requestedBy: null,
  segmentCount: 0,
};

// --- QR code window ---------------------------------------------------------
// Shared text + center logo for the room's QR generator. logoDataUrl
// is a data:image/png base64 URL (caller downscales to 256×256 before
// sending). null clears the logo.
export type QrState = {
  text: string;
  logoDataUrl: string | null;
};

const DEFAULT_QR_STATE: QrState = { text: "", logoDataUrl: null };

// --- Pong --------------------------------------------------------------
// Two-seat multiplayer pong. Mirrors `packages/relay/src/pong.ts` —
// server is authoritative for ball + score, clients send only paddle Y.
export type PongSide = "left" | "right";
export type PongSeat = { ownerKey: string; handle: string };
export type PongStatus = "waiting" | "serving" | "playing" | "ended";
export type PongState = {
  seats: { left: PongSeat | null; right: PongSeat | null };
  paddles: { left: number; right: number };
  ball: { x: number; y: number; vx: number; vy: number };
  score: { left: number; right: number };
  status: PongStatus;
  serveAt: number;
  lastScorer: PongSide | null;
  winner: PongSide | null;
  field: { w: number; h: number; paddleH: number; paddleW: number; paddleInset: number; ballR: number };
};

const DEFAULT_PONG_STATE: PongState = {
  seats: { left: null, right: null },
  paddles: { left: 250, right: 250 },
  ball: { x: 400, y: 250, vx: 0, vy: 0 },
  score: { left: 0, right: 0 },
  status: "waiting",
  serveAt: 0,
  lastScorer: null,
  winner: null,
  field: { w: 800, h: 500, paddleH: 90, paddleW: 12, paddleInset: 24, ballR: 8 },
};

// --- Worm --------------------------------------------------------------
// Up-to-4-player multiplayer snake. Mirrors `packages/relay/src/worm.ts` —
// the relay owns the whole grid simulation (movement, food, collisions);
// clients only send their own desired direction.
export type WormDir = "up" | "down" | "left" | "right";
export type WormColor = "cyan" | "magenta" | "lime" | "purple";
export type WormCell = { x: number; y: number };
export type WormStatus = "waiting" | "playing" | "ended";
export type WormPlayer = {
  slot: number;
  ownerKey: string;
  handle: string;
  color: WormColor;
  body: WormCell[];
  dir: WormDir;
  alive: boolean;
  respawnAt: number;
  len: number;
};
export type WormState = {
  players: (WormPlayer | null)[];
  food: WormCell[];
  status: WormStatus;
  winner: number | null;
  tick: number;
  field: { cols: number; rows: number; cell: number; moveMs: number; winLen: number; startLen: number };
};

const DEFAULT_WORM_STATE: WormState = {
  players: [null, null, null, null],
  food: [],
  status: "waiting",
  winner: null,
  tick: 0,
  field: { cols: 40, rows: 30, cell: 16, moveMs: 125, winLen: 16, startLen: 3 },
};

// --- File-preview shared state ---------------------------------------------
// Per-file preview UI state shared across the room, indexed by fileId.
// Carries two independent kinds (a file is only ever one):
//   • audio/video — `position` + `playing`; live pos = position +
//     (now - at)/1000 while playing.
//   • text — `scrollFrac` (0..1 scroll position); `position`/`playing`
//     unused (sent as 0/false).
export type PreviewMediaSnapshot = {
  position: number;
  playing: boolean;
  at: number;
  scrollFrac?: number;
};

// --- Scroll-sync shared state ---------------------------------------------
// Per-surface scroll position keyed by an arbitrary surface id
// (transcript, chat, notes-editor, research, wallet:chat, etc.). One
// generic channel so every scrollable dialog in the desktop can
// follow-the-leader without each subsystem needing its own message
// type. See `useSyncedScroll` for the consumer side.
export type ScrollSnapshot = {
  /** scrollTop / (scrollHeight - clientHeight), clamped 0..1 */
  frac: number;
  /** Date.now() when the scroller emitted; used for tie-break / debug */
  at: number;
};

// --- UI-state shared selections -------------------------------------------
// Per-key discrete UI state: which tab is active, which item is selected,
// which chain is picked, etc. Sibling to ScrollSync but for sparse
// last-writer-wins values (no detach grace — when a peer flips a tab
// every peer should flip immediately, that's the whole point). Value is
// arbitrary JSON; the consumer hook re-types via generics.
export type UIStateSnapshot = {
  value: unknown;
  at: number;
};

// --- AI wallet chat ---------------------------------------------------------
// Per-room conversational wallet. The whole room shares one conversation;
// any peer can send a message, the relay runs the agentic intent engine,
// and the answer (incl. transaction cards) broadcasts to everyone.
// Mirrors packages/relay/src/wallet-chat.ts.
export type WalletChatTransaction = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description?: string;
  simulation?: { verified: boolean; changes: { direction: string; symbol: string; amount: string }[] };
};
export type WalletChatStep = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description: string;
  label: string;
};
export type WalletChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  /** Display label of the peer who sent a user message; null for the AI. */
  sender: string | null;
  /** Assistant-only: a built transaction the UI renders as a card. */
  transaction?: WalletChatTransaction | null;
  /** Assistant-only: a multi-step transaction (ENS register, approve+swap). */
  multistep?: { steps: WalletChatStep[]; delay: number; priceEth?: string; priceWei?: string } | null;
  /** Assistant-only: set when the intent call itself errored. */
  error?: string | null;
};
export type WalletChat = {
  messages: WalletChatMessage[];
  /** True while an intent turn is in flight — drives the room-wide spinner. */
  processing: boolean;
};

const DEFAULT_WALLET_CHAT: WalletChat = { messages: [], processing: false };

// Server-authoritative chess state. Mirrors `packages/relay/src/chess.ts`.
export type ChessGameStatus =
  | "active"
  | "white_won"
  | "black_won"
  | "draw_stalemate"
  | "draw_threefold"
  | "draw_insufficient"
  | "draw_other"
  | "white_resigned"
  | "black_resigned";

export type ChessGame = {
  whiteKey: string;
  blackKey: string;
  whiteLabel: string;
  blackLabel: string;
  fen: string;
  moves: string[];
  status: ChessGameStatus;
  startedAt: number;
  endedAt?: number;
  /** Date.now() when the current side started thinking. Drives the
   *  live "this turn" counter under each player's name. */
  turnStartedAt: number;
  /** Wall-clock ms each completed move took, parallel to `moves`. */
  moveTimings: number[];
};

export type ChessResult = {
  whiteKey: string;
  blackKey: string;
  whiteLabel: string;
  blackLabel: string;
  status: Exclude<ChessGameStatus, "active">;
  startedAt: number;
  endedAt: number;
  moveCount: number;
};

/** Generic money escrow for games. Mirrors the relay's EscrowSession
 *  (packages/relay/src/escrow.ts). One session per room, backed by the
 *  room multisig. The relay owns every transition — clients render this
 *  snapshot and drive UI off it. Chess/pong/poker all use this shape;
 *  game-specific framing comes from `game`, account `role`, and `meta`. */
export type EscrowStatus = "open" | "locked" | "settling" | "settled" | "cancelled";

/** Chess seat, used by the chess UI to read the right account. */
export type WagerSide = "white" | "black";

export type EscrowDeposit = {
  txHash: string;
  amountWei: string;
  confirmedAt: number;
};

export type EscrowAccount = {
  key: string;
  label: string;
  /** Game-defined: "white"/"black" for chess, seat index for poker. */
  role: string;
  requiredWei: string;
  depositedWei: string;
  balanceWei: string;
  deposit: EscrowDeposit | null;
};

export type EscrowPayout = { to: string; amountWei: string };

export type EscrowSession = {
  id: string;
  game: string;
  chainId: number;
  multisig: string;
  status: EscrowStatus;
  accounts: EscrowAccount[];
  payouts: EscrowPayout[] | null;
  payoutTxId: string | null;
  payoutTxHash: string | null;
  settledAt: number | null;
  meta: Record<string, unknown>;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

/** Server-side AI player available as a chess opponent. The lobby
 *  shows these alongside the live human peers in the player picker.
 *  The relay is responsible for actually playing their moves. */
export type AIPlayer = {
  id: string;
  label: string;
  ownerKey: string; // "ai:<id>"
  model: string;
};

const CHAT_HISTORY_CAP = 200;

type SelfHint = {
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
  /** Stable anon id for non-wallet sessions — threaded into the
   *  self-Peer so customNames lookups + flag colors work for anon
   *  users. Null for SIWE/passkey sessions. */
  anonId?: string | null;
  // Marks god-mode (streaming) sessions so the client-side self-Peer
  // carries the same flag the relay stamps on it server-side. Without
  // it, `visiblePeers` would filter every other peer's view of this
  // user but leave the user's own self-entry in their own guest list.
  spectator?: boolean;
};

export type PeerMeshState = {
  myId: string | null;
  peers: Peer[];
  connected: boolean;
  // True once the first `hello` payload has been processed — i.e. we know
  // the authoritative slots, browsers, and publications. Use this to gate
  // any UI that would otherwise flash from a fallback to the persisted
  // value (icon positions, browser windows, etc.).
  bootstrapped: boolean;
  // Streams keyed by stream.id (NOT peerId). Multiple streams per peer work.
  remoteStreams: Map<string, MediaStream>;
  // Currently-active publications across all peers (own + others).
  publications: Publication[];
  // Persistent layout positions (host-authoritative).
  slots: Record<string, SlotPosition>;
  cursors: Record<string, CursorData>;
  /** Recent click ripples — auto-prune after the animation completes. */
  clicks: ClickEvent[];
  sendClick: (x: number, y: number) => void;
  // Shared browser windows.
  browsers: Record<string, Browser>;
  // Per-user avatar URLs keyed by ownerKey (lowercased address or
  // slugified handle). Same key Publication.ownerKey uses.
  avatars: Record<string, string>;
  // Owners that have explicitly opted out of any avatar (no upload,
  // no ENS fallback). Render layer treats these as "show nothing".
  hiddenAvatars: Set<string>;
  // Recent tx_request broadcasts (newest first, capped client-side).
  txRequests: TxRequest[];
  // Chat history (oldest first), bootstrapped from the WS hello payload
  // and appended to as `chat` events stream in.
  chatMessages: ChatMessage[];
  sendChat: (text: string) => void;
  publish: (stream: MediaStream, kind: SlotKind, label: string) => void;
  unpublish: (streamId: string) => void;
  /** Flip a camera publication to audio-only (video off, mic kept) or
   *  back. Server is source of truth — the relay rebroadcasts the
   *  publication with `cameraOff` set, which the `published` handler
   *  applies, so every peer (and the snapshot) stays in sync. */
  setCameraOff: (streamId: string, off: boolean) => void;
  /** Hot-swap a single track on an already-published stream. Calls
   *  RTCRtpSender.replaceTrack on every peer connection so the remote
   *  side never loses the publication — the streamId (the map key)
   *  stays stable. Returns the FRESH local MediaStream so the caller
   *  can re-render consumers (analysers / <video> elements) bound to
   *  the old stream — MediaStream mutations don't fire add/removetrack
   *  for developer-initiated calls, so we hand back a new object. */
  replaceTrack: (streamId: string, kind: "audio" | "video", newTrack: MediaStreamTrack) => Promise<MediaStream | null>;
  updateSlot: (patch: Partial<SlotPosition> & { id: string }) => void;
  openBrowser: (id: string, url: string, appId?: string) => void;
  navigateBrowser: (id: string, url: string) => void;
  closeBrowser: (id: string) => void;
  /** Singleton apps whose visibility is shared across the mesh — opened
   *  by anyone, visible to everyone, closed by anyone. */
  openWindowIds: Set<string>;
  openWindow: (id: string) => void;
  closeWindow: (id: string) => void;
  /** Shared music-player state. Last writer wins. Position drift is
   *  computed locally from `at` (Date.now() at capture). */
  musicState: MusicState | null;
  setMusicState: (state: MusicState) => void;
  /** Server-authoritative chess game (singleton) + recent results. */
  chessGame: ChessGame | null;
  chessHistory: ChessResult[];
  /** Server-side AI players available as opponents. Empty if no
   *  provider keys are configured on the relay. */
  aiPlayers: AIPlayer[];
  chessCreate: (args: { whiteKey: string; blackKey: string; whiteLabel: string; blackLabel: string }) => void;
  chessMove: (from: string, to: string, promotion?: string) => void;
  chessResign: () => void;
  chessCloseGame: () => void;
  /** The current money-game escrow session (chess wager, etc.). */
  escrow: EscrowSession | null;
  /** Latest deposit-verification result from the relay (per reported tx),
   *  so the Send-buy-in UI can show "confirming…/retry" feedback. */
  escrowFundResult: { ok: boolean; txHash: string; reason?: string } | null;
  /** Chess-specific: open a chess wager between the two players already
   *  chosen in the lobby. Proposer needn't be a player; each side funds
   *  its own seat. */
  chessWagerPropose: (args: {
    whiteKey: string;
    whiteLabel: string;
    blackKey: string;
    blackLabel: string;
    buyinWei: string;
    chainId: number;
  }) => void;
  /** Chess-specific: start the game once both buy-ins are escrowed. */
  chessWagerStart: () => void;
  /** Generic escrow actions (any game). */
  escrowFund: (txHash: string) => void;
  escrowCancel: () => void;
  escrowClear: () => void;
  /** Shared todo list. Full-state replace from server on every change. */
  todos: TodoItem[];
  todoAdd: (text: string) => void;
  todoToggle: (id: string) => void;
  todoUpdate: (id: string, text: string) => void;
  todoDelete: (id: string) => void;
  todoClearDone: () => void;
  /** Apply a new ordering to the todo list. Unknown ids are ignored;
   *  ids missing from `ids` are appended at the end. */
  todoReorder: (ids: string[]) => void;
  /** Shared notes. Full-state replace from server on every change. */
  notes: Note[];
  noteCreate: (text: string) => void;
  noteUpdate: (id: string, text: string) => void;
  noteDelete: (id: string) => void;
  /** Shared glossary. Each term has an AI-generated TLDR that arrives
   *  asynchronously (`status: pending → ready`). Full-state replace. */
  glossary: GlossaryTerm[];
  glossaryAdd: (term: string) => void;
  glossaryRegenerate: (id: string) => void;
  glossaryDelete: (id: string) => void;
  /** Latest gas snapshot from the relay's poll loop. `null` until the
   *  first successful Alchemy + Chainlink read lands. */
  gasState: GasState | null;
  /** Latest ticker snapshot (crypto + AI stocks + private valuations).
   *  `null` until the relay's first poll completes. */
  tickerState: TickerState | null;
  /** Latest headlines snapshot (crypto + AI). `null` until first poll. */
  headlinesState: HeadlinesState | null;
  /** Latest Twitter timeline snapshot. `null` until first poll. */
  timelineState: TimelineState | null;
  /** Host-written on-screen chyron. Empty `text` = no banner shown.
   *  `null` until the first ws snapshot arrives. */
  chyronState: ChyronState | null;
  /** Host-only: write the on-screen chyron. Empty / whitespace clears it. */
  setChyron: (text: string) => void;
  /** Inner viewport size of the active god-mode (OBS capture) window,
   *  broadcast by that spectator on resize. Every client draws a dashed
   *  rectangle at these dimensions so participants can see the framing
   *  the broadcast actually captures. `null` when no spectator is
   *  connected; consumers fall back to the 1920×1080 OBS target. */
  godViewport: { width: number; height: number } | null;
  /** Spectator-only: broadcast this client's `window.innerWidth/Height`
   *  (or `null` to clear). No-op for non-spectators — the relay drops
   *  the message either way. */
  setGodViewport: (v: { width: number; height: number } | null) => void;
  /** Most recent STT segment, pushed by the room's WS broadcast when
   *  Whisper appends a new line. `null` until the first segment arrives
   *  in this session. Used by the on-screen subtitle caption. We don't
   *  retain the full transcript here — that's what /v1/transcript +
   *  TranscriptWindow are for.
   *
   *  Note: the server suppresses this broadcast for any speaker whose
   *  in-browser STT is live, so the segment here is only ever for
   *  speakers who don't have local captions running. */
  latestTranscriptSeg: TranscriptSegment | null;
  /** Most recent in-browser STT frame from ANY speaker (interim or
   *  final). Web Speech finalizes ~3-5s before Whisper does, so this
   *  is the path that paints the live overlay for speakers who run it.
   *  Carries the speaker's identity inline (no mesh.peers lookup). */
  liveCaption: LiveCaption | null;
  /** Push an in-browser STT result over the room WS. Throttling +
   *  interim-vs-final decisions live in the caller (useLiveTranscript). */
  sendLiveCaption: (text: string, isFinal: boolean) => void;
  /** Tell the room whether this peer's in-browser STT is currently
   *  alive. The server uses this to decide whether to fan out
   *  god-mode `transcript_seg` events for this speaker. */
  sendLiveCaptionState: (alive: boolean) => void;
  /** Curated news digest (interleaved crypto/AI/tweets + AI featured
   *  picks). `null` until the first rebuild lands. */
  newsDigestState: NewsDigestState | null;
  /** Files dropped onto the shared desktop. Mirrors the relay's
   *  /var/lib/slop-relay/files store, broadcast on every add/remove. */
  files: FileEntry[];
  /** Remove a file by id (server enforces uploader-or-host). */
  deleteFile: (id: string) => void;
  /** Shared clock app state — tab pick, zone, stopwatch + countdown
   *  all synchronized across every peer. */
  clockState: ClockState;
  /** Partial-update setter. Pass only the fields you want to change;
   *  the server preserves the rest. */
  setClockState: (patch: Partial<ClockState>) => void;
  /** Shared title-card state for the CARD app. `null` means the room
   *  is on the slop.computer template; a `{version}` snapshot means
   *  someone dropped a PFP and the relay produced a result the room
   *  should show. */
  cardState: CardState | null;
  /** In-flight card generation for the room. Non-null while the relay
   *  is running gpt-image-2; every peer shows the shared loading bar
   *  regardless of who dropped the PFP. */
  cardJob: CardJob | null;
  /** Shared title overlay (text + fractional position + size) sitting
   *  on top of the card. `null` until anyone in the room edits it; the
   *  CardWindow falls back to slug-based defaults until then. */
  cardTitle: CardTitle | null;
  /** Broadcast a new title state to the room. Optimistically updates
   *  local state; server persists last-write-wins. Safe to call on
   *  every pointer-move during a drag (matches the `cursor` cadence). */
  setCardTitle: (title: CardTitle) => void;
  /** Clear the current card and bring the template back for the
   *  whole room. */
  resetCard: () => void;
  /** Shared guest-research dossier state — phase + form fields +
   *  in-flight job + result. Every broadcast replaces this wholesale
   *  (last-writer-wins). See research-state.ts on the relay. */
  researchState: ResearchState;
  /** Kick off a "who is this?" lookup. Broadcasts lookup-pending +
   *  loading bar to every peer; result populates the form fields when
   *  it lands. */
  researchLookup: (query: string) => void;
  /** Kick off the deep dossier with the host's edited form values.
   *  Broadcasts research-pending + loading bar; result lands on
   *  every peer in `researchState.result` when complete. */
  researchStart: (args: { name: string; socials: ResearchSocials; notes?: string }) => void;
  /** Reset the shared research state back to the empty lookup screen.
   *  Refused server-side while a job is in flight (avoids orphaning a
   *  running AI call). */
  researchReset: () => void;
  /** Shared Leftclaw "Hire" job-posting state — service type + form +
   *  posting phase/step + result. Broadcast wholesale (last-writer-wins).
   *  See leftclaw-state.ts on the relay. */
  leftclawState: LeftclawState;
  /** Take the post lock + broadcast `posting`. Returns the relay response
   *  so the driver can detect a 409 (someone else is mid-post). The actual
   *  signing/tx happen in the caller's browser afterwards. */
  leftclawStart: (args: {
    serviceTypeId: LeftclawServiceId;
    description: string;
    context?: string;
    paymentMethod: LeftclawPayment;
  }) => Promise<Response>;
  /** Push a human-readable progress label spectators see while posting. */
  leftclawUpdate: (step: string) => void;
  /** Mark the post done — broadcasts the job link + narrates the transcript. */
  leftclawDone: (args: { jobId: number; jobUrl?: string; txHash?: string }) => void;
  /** Mark the post failed with a message. */
  leftclawError: (message: string) => void;
  /** Reset the Hire app back to an editable empty form for the room. */
  leftclawReset: () => void;
  /** Wipe the room's posted-jobs history list. */
  leftclawClearHistory: () => void;
  /** Shared "catch me up" TLDR for the Transcript app. Status + summary
   *  are broadcast to every peer, so one click recaps the whole room.
   *  See tldr-state.ts on the relay. */
  tldrState: TldrState;
  /** Ask the relay to summarize the recent transcript. No-op if a TLDR
   *  job is already in flight (relay drops the duplicate). */
  requestTldr: () => void;
  /** Server-authoritative pong snapshot. Ball + scores update at 30Hz
   *  when both seats are filled; paddle positions reflect the last
   *  `pong_paddle` from each side. */
  pongState: PongState;
  /** Side this peer is sitting in, or null when not seated. Updated
   *  optimistically on claim/release plus reconciled from `pong_seat`
   *  replies + the seats map in pongState. */
  myPongSeat: PongSide | null;
  /** Auto-assign the first empty seat (or no-op if both are full /
   *  caller already sits). The server replies with `pong_seat`. */
  pongClaim: () => void;
  /** Vacate my seat. */
  pongRelease: () => void;
  /** Send paddle Y to the server. Clamped server-side; ignored if not
   *  seated. Call at ~20-30Hz from the input loop. */
  pongPaddle: (y: number) => void;
  /** Reset scores + restart the match. Server refuses if caller is not
   *  seated. The "Play Again" button at end-of-match hits this. */
  pongReset: () => void;
  /** Server-authoritative worm (multiplayer snake) snapshot. The relay
   *  advances every worm one grid cell per move tick and broadcasts the
   *  whole board; clients render it (with light interpolation between
   *  ticks) and never simulate locally. */
  wormState: WormState;
  /** Seat slot (0..3) this peer occupies, or null when not seated.
   *  Reconciled from `worm_slot` replies + the players map in wormState. */
  myWormSlot: number | null;
  /** Take the first open seat (or no-op if full / already seated). The
   *  server replies with `worm_slot`. */
  wormClaim: () => void;
  /** Vacate my seat. */
  wormRelease: () => void;
  /** Queue my next direction. Sent immediately on each turn; the relay
   *  applies it on its next move tick and rejects 180° reversals. */
  wormSetDir: (dir: WormDir) => void;
  /** Reset the round (respawn everyone). Seated players only — the
   *  "Play Again" button after a round ends hits this. */
  wormReset: () => void;
  /** Shared QR-window state (text + center logo). Every peer's QR
   *  renders this. Last-writer-wins. */
  qrState: QrState;
  /** Partial-patch setter — pass `{ text }`, `{ logoDataUrl }`, or
   *  `{ clearLogo: true }`. Server fans the update back to everyone.
   *  Resolves with `ok: false` on a 4xx / network error so the caller
   *  can surface upload failures (a previous version swallowed 413s
   *  for oversized logos, making drag-to-upload look silently broken). */
  setQrPatch: (patch: {
    text?: string;
    logoDataUrl?: string;
    clearLogo?: boolean;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Per-fileId audio/video playhead snapshots for file previews.
   *  Keyed by FileEntry.id. Absent keys mean nobody's started
   *  playback on that file yet — preview window treats that as
   *  paused-at-zero. */
  previewMedia: Record<string, PreviewMediaSnapshot>;
  /** Broadcast a play/pause/seek for a specific file. The server's
   *  per-room map is keyed by fileId so multiple previews are
   *  independent. */
  setPreviewMedia: (fileId: string, state: PreviewMediaSnapshot) => void;
  /** Per-surface shared scroll positions. Keyed by an arbitrary
   *  surface id (e.g. "transcript", "wallet:chat", "notes-editor:abc").
   *  Absent keys mean nobody has scrolled that surface yet. */
  scrollSync: Record<string, ScrollSnapshot>;
  /** Broadcast a scroll position for a surface. Throttle at the call
   *  site (scroll fires a lot); the hook `useSyncedScroll` handles
   *  this automatically. */
  setScrollSync: (key: string, state: ScrollSnapshot) => void;
  /** Per-key discrete shared selections (active tab, selected item id,
   *  picked chain, …). Sibling to scrollSync but for sparse
   *  last-writer-wins values. Use the `useSyncedUIState(key, fallback)`
   *  hook to read+write; this map is the raw backing store. */
  uiState: Record<string, unknown>;
  /** Broadcast a discrete UI state value. `value` must be
   *  JSON-serializable; the relay caps it at 4KB serialized. */
  setUIState: (key: string, value: unknown) => void;
  /** Shared AI-wallet conversation — messages + in-flight flag.
   *  Replaces the old per-iframe wallet chat. */
  walletChat: WalletChat;
  /** Send a message to the room's wallet AI. `address` is the multisig
   *  operating wallet; `chainId` its primary deployed chain. The relay
   *  appends the turn, runs the intent engine, and broadcasts the
   *  result — no optimistic local update. */
  walletChatSend: (message: string, address: string, chainId: number) => void;
  /** Clear the wallet conversation for the whole room. Refused
   *  server-side while a turn is processing. */
  walletChatReset: () => void;
  /** Catalog of music genres exposed by the Jamendo integration.
   *  Populated from /v1/state on hello; the music player renders one
   *  tab per genre. */
  musicGenres: { id: string; label: string }[];
  /** Currently-selected genre. null = Jamendo mode off; the player
   *  falls back to the static /music playlist (Kevin MacLeod set). */
  musicGenre: string | null;
  /** Switch the shared current genre. Triggers the relay's lazy
   *  download/refresh — first time on a cold genre can take ~30s. */
  setMusicGenre: (genre: string | null) => void;
  /** User-curated "Custom" playlist — same shape as any other genre's
   *  tracks, mesh-broadcast on add/remove/reorder. Each peer's [+] /
   *  [−] buttons check this list to know which state to show. */
  musicCustom: JamendoTrack[];
  addToMusicCustom: (track: JamendoTrack) => void;
  removeFromMusicCustom: (jamendoId: string) => void;
  reorderMusicCustom: (orderedIds: string[]) => void;
  broadcastTxRequest: (req: Omit<TxRequest, "from" | "receivedAt">) => void;
  /** Captured txs sent to *us* directly because someone is impersonating
   *  our wallet address. Newest first; receiver dismisses each as they
   *  send or reject. */
  incomingForwards: ForwardedTx[];
  /** Send a captured tx to a specific peer (the wallet we're impersonating).
   *  Fire-and-forget — the relay routes it via sendTo, and the receiver's
   *  mesh hook surfaces it through `incomingForwards`. */
  forwardTxToPeer: (
    peerId: string,
    payload: {
      browserId: string;
      method: string;
      params: unknown[];
      chainId: number | null;
      /** Stable per-capture id from the host. Every watcher of a shared
       *  tab forwards the same captured tx; passing the host's id lets the
       *  receiver dedup the copies into one modal instead of N. */
      requestId?: string;
    },
  ) => void;
  /** Remove an entry from `incomingForwards` once it's been handled
   *  (sent, rejected, or otherwise resolved). Local-only. */
  dismissIncomingForward: (id: string) => void;
  /** Currently-deployed session multisig. `null` until someone hits
   *  "Deploy wallet" in the wallet window. */
  wallet: WalletRecord | null;
  /** Collaborative pre-deploy form state. Anyone in the room may
   *  edit; only the host can submit. `null` when nobody has touched
   *  the form yet or after a successful deploy clears it. */
  walletDraft: WalletDraft | null;
  /** Replace the entire draft (or clear it with null). Each peer
   *  sends a full snapshot rather than per-field diffs — keeps merge
   *  semantics trivial. */
  walletDraftUpdate: (draft: WalletDraft | null) => void;
  /** Archive of past-episode multisigs (newest first). */
  walletHistory: WalletRecord[];
  /** Pending tx queue for `wallet` plus a tail of executed/failed txs. */
  walletTxs: WalletTx[];
  /** Most recent `wallet_tx_propose` ping from the relay — bumps on
   *  every propose attempt including dedup hits, so UI can surface
   *  the wallet window even when walletTxs didn't change. */
  walletAttention: { at: number; source: WalletTx["source"] } | null;
  /** Tell the relay a multisig has just been deployed (first chain). */
  walletDeploy: (rec: WalletRecord) => void;
  /** Record an additional chain the current wallet has been deployed
   *  to. Same address, just a new entry under `deployments[chainId]`. */
  walletAddDeployment: (chainId: number, txHash: string | null) => void;
  /** Archive `wallet` and reset the UI to the deploy state. */
  walletNewEpisode: () => void;
  /** Propose a transaction. The relay generates the id, applies the AI
   *  summary lazily, and broadcasts back as `wallet_txs`. */
  walletProposeTx: (req: {
    chainId: number;
    target: string;
    value: string;
    data: string;
    deadline: string;
    nonce: string;
    execHash: string;
    source: WalletTx["source"];
    browserId?: string | null;
    /** When set + non-empty, becomes a batched execBatchTransaction. */
    calls?: WalletTxCall[];
  }) => void;
  walletSignTx: (id: string, sig: { signer: string; sigType: 0 | 1; data: string }) => void;
  walletSetTxStatus: (id: string, status: WalletTxStatus, txHash?: string | null) => void;
  walletRemoveTx: (id: string) => void;
  walletResummarize: (id: string) => void;
  /** User-chosen display names keyed by lowercased address. Wins over
   *  ENS handle when rendering peer labels — see `peerLabel`. */
  customNames: Record<string, string>;
  /** Relay round-trip-time (ms) per peer, keyed by peerId. Each peer
   *  measures its own RTT to the relay and broadcasts via `ping_report`;
   *  this map carries the latest sample per peer for the guest-list
   *  ping meter. Absent keys = no measurement yet. */
  peerPings: Record<string, number>;
  /** Set or clear the current user's display name. Pass `null` (or an
   *  empty string) to clear. */
  setCustomName: (name: string | null) => void;
};

/** Resolve a peer's display label using the agreed precedence:
 *  customName (set by the user) → ENS handle → short address →
 *  short peer-id. Pass `mesh.customNames` so the rule lives in one
 *  place — every renderer (guest list, tile badge, cursor label,
 *  chat author) goes through here. */
export function peerLabel(
  peer: Pick<Peer, "id" | "address" | "handle" | "anonId">,
  customNames: Record<string, string>,
): string {
  // Use the peer's stable id (address for SIWE/passkey, anonId for
  // anon) to look up their chosen display name. Keeps the rule lined
  // up with what SlopAddress shows in the rest of the UI.
  const lookupKey = (peer.address ?? peer.anonId)?.toLowerCase();
  if (lookupKey && customNames[lookupKey]) return customNames[lookupKey];
  if (peer.handle) return peer.handle;
  if (peer.address) return `${peer.address.slice(0, 6)}…${peer.address.slice(-4)}`;
  return peer.id.slice(0, 6);
}

export function usePeerMesh(enabled: boolean, self: SelfHint | null, slug: string): PeerMeshState {
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [publications, setPublications] = useState<Publication[]>([]);
  const [slots, setSlots] = useState<Record<string, SlotPosition>>({});
  const [cursors, setCursors] = useState<Record<string, CursorData>>({});
  const [clicks, setClicks] = useState<ClickEvent[]>([]);
  const clickIdRef = useRef(0);
  const [browsers, setBrowsers] = useState<Record<string, Browser>>({});
  const [txRequests, setTxRequests] = useState<TxRequest[]>([]);
  const [incomingForwards, setIncomingForwards] = useState<ForwardedTx[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [hiddenAvatars, setHiddenAvatars] = useState<Set<string>>(new Set());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [gasState, setGasState] = useState<GasState | null>(null);
  const [tickerState, setTickerState] = useState<TickerState | null>(null);
  const [headlinesState, setHeadlinesState] = useState<HeadlinesState | null>(null);
  const [timelineState, setTimelineState] = useState<TimelineState | null>(null);
  const [chyronState, setChyronState] = useState<ChyronState | null>(null);
  const [godViewport, setGodViewportState] = useState<{ width: number; height: number } | null>(null);
  const [latestTranscriptSeg, setLatestTranscriptSeg] = useState<TranscriptSegment | null>(null);
  const [liveCaption, setLiveCaption] = useState<LiveCaption | null>(null);
  const [newsDigestState, setNewsDigestState] = useState<NewsDigestState | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [musicGenres, setMusicGenresState] = useState<{ id: string; label: string }[]>([]);
  const [musicGenre, setMusicGenreLocal] = useState<string | null>(null);
  const [musicCustom, setMusicCustomLocal] = useState<JamendoTrack[]>([]);
  const [clockState, setClockStateLocal] = useState<ClockState>(DEFAULT_CLOCK_STATE);
  const [cardState, setCardState] = useState<CardState | null>(null);
  const [cardJob, setCardJob] = useState<CardJob | null>(null);
  const [cardTitle, setCardTitleLocal] = useState<CardTitle | null>(null);
  const [researchState, setResearchStateLocal] = useState<ResearchState>(DEFAULT_RESEARCH_STATE);
  const [leftclawState, setLeftclawStateLocal] = useState<LeftclawState>(DEFAULT_LEFTCLAW_STATE);
  const [tldrState, setTldrStateLocal] = useState<TldrState>(DEFAULT_TLDR_STATE);
  const [qrState, setQrStateLocal] = useState<QrState>(DEFAULT_QR_STATE);
  const [pongState, setPongStateLocal] = useState<PongState>(DEFAULT_PONG_STATE);
  const [myPongSeat, setMyPongSeat] = useState<PongSide | null>(null);
  const [wormState, setWormStateLocal] = useState<WormState>(DEFAULT_WORM_STATE);
  const [myWormSlot, setMyWormSlot] = useState<number | null>(null);
  const [previewMedia, setPreviewMediaLocal] = useState<Record<string, PreviewMediaSnapshot>>({});
  const [scrollSync, setScrollSyncLocal] = useState<Record<string, ScrollSnapshot>>({});
  const [uiState, setUIStateLocal] = useState<Record<string, unknown>>({});
  const [walletChat, setWalletChatLocal] = useState<WalletChat>(DEFAULT_WALLET_CHAT);
  const [openWindowIds, setOpenWindowIds] = useState<Set<string>>(new Set());
  const [musicState, setMusicStateLocal] = useState<MusicState | null>(null);
  const [chessGame, setChessGame] = useState<ChessGame | null>(null);
  const [chessHistory, setChessHistory] = useState<ChessResult[]>([]);
  const [escrow, setEscrow] = useState<EscrowSession | null>(null);
  const [escrowFundResult, setEscrowFundResult] = useState<{ ok: boolean; txHash: string; reason?: string } | null>(
    null,
  );
  const [aiPlayers, setAiPlayers] = useState<AIPlayer[]>([]);
  const [wallet, setWallet] = useState<WalletRecord | null>(null);
  const [walletHistory, setWalletHistory] = useState<WalletRecord[]>([]);
  const [walletTxs, setWalletTxs] = useState<WalletTx[]>([]);
  const [walletDraft, setWalletDraft] = useState<WalletDraft | null>(null);
  // Server pings this every time `wallet_tx_propose` is processed —
  // including double-click dedup hits that don't add a new tx. UI
  // surfaces (Desktop, WalletWindow) watch the timestamp to refocus
  // the wallet window even when walletTxs didn't change.
  const [walletAttention, setWalletAttention] = useState<{ at: number; source: WalletTx["source"] } | null>(null);
  // User-chosen display names keyed by lowercased address. Wins over
  // ENS handle and address-shorthand in the label-fallback chain (see
  // `peerLabel` below). Server-authoritative — `set_custom_name` round-
  // trips through the relay so other peers see the change.
  const [customNames, setCustomNames] = useState<Record<string, string>>({});
  // Relay round-trip time per peer (ms), keyed by peerId. Drives the
  // guest-list ping meter. Populated by the `peer_ping` broadcast and
  // by our own pong measurements (for the local user's row).
  const [peerPings, setPeerPings] = useState<Record<string, number>>({});

  // Mirror of `slots` for synchronous reads inside callbacks (so
  // updateSlot's "new windows come to the front" rule can compute the
  // current max z without re-creating the callback on every slot
  // change). Kept in sync via the effect below.
  const slotsRef = useRef<Record<string, SlotPosition>>({});
  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  // Mirrors for the stream watchdog (below). A single long-lived
  // setInterval reads these synchronously so we don't tear down and
  // rebuild the interval (resetting its accumulated "missing since"
  // timestamps) every time a publication or remote stream changes.
  const publicationsRef = useRef<Publication[]>(publications);
  publicationsRef.current = publications;
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(remoteStreams);
  remoteStreamsRef.current = remoteStreams;
  const peersRef = useRef<Peer[]>(peers);
  peersRef.current = peers;

  const wsRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Local streams we are publishing, mapped streamId -> { stream, kind }.
  // Kind travels with the stream so `createPeerConnection` (which attaches
  // existing local media to newly-formed PCs) can apply the right sender
  // caps without having to sniff track labels.
  const localStreamsRef = useRef<Map<string, { stream: MediaStream; kind: SlotKind }>>(new Map());
  const selfRef = useRef<SelfHint | null>(self);
  selfRef.current = self;
  // ICE config (STUN+TURN) — refreshed once per session/credential expiry.
  const iceConfigRef = useRef<RTCConfiguration>(FALLBACK_ICE);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    // Surface drops for tx-flow messages — these are the ones whose silent
    // loss looks like "first attempt vanished, second worked". Other types
    // (cursor spam, frequent slot updates) would be too noisy to log.
    const type = (msg as { type?: unknown }).type;
    if (type === "wallet_tx_propose" || type === "tx_forward" || type === "tx_request" || type === "wallet_tx_sign") {
      console.warn("[SLOP-TX-DEBUG] relay-send dropped — ws not OPEN", {
        type,
        readyState: ws ? ws.readyState : "null",
      });
    }
  }, []);

  const closePeerConnection = useCallback((peerId: string) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.onnegotiationneeded = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    peerConnectionsRef.current.delete(peerId);
    setCursors(prev => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const initiateOffer = useCallback(
    async (peerId: string) => {
      const pc = peerConnectionsRef.current.get(peerId);
      if (!pc) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "offer", to: peerId, payload: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[mesh] initiateOffer failed", err);
      }
    },
    [send],
  );

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection(iceConfigRef.current);

      // Attach existing local streams so newly-formed pcs get our outgoing media.
      for (const { stream, kind } of localStreamsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* track already added */
          }
        }
        applySenderCaps(pc, stream, kind);
      }
      preferEfficientVideoCodecs(pc);

      pc.ontrack = event => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStreams(prev => {
          if (prev.get(stream.id) === stream) return prev;
          const next = new Map(prev);
          next.set(stream.id, stream);
          return next;
        });
        // Track end → drop from map
        event.track.addEventListener("ended", () => {
          if (stream.getTracks().every(t => t.readyState === "ended")) {
            setRemoteStreams(prev => {
              if (!prev.has(stream.id)) return prev;
              const next = new Map(prev);
              next.delete(stream.id);
              return next;
            });
          }
        });
      };

      pc.onicecandidate = event => {
        if (event.candidate) {
          send({ type: "ice", to: peerId, payload: event.candidate.toJSON() });
        }
      };

      pc.onconnectionstatechange = () => {
        // "disconnected" is transient per the WebRTC spec — ICE often
        // re-converges within ~30s without intervention. Closing here was
        // preemptive and made spotty-network blips permanent. We only
        // tear down on terminal states; the stream watchdog below kicks
        // a rebuild if the pc never recovers.
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          closePeerConnection(peerId);
        }
      };

      pc.onnegotiationneeded = () => {
        if (pc.signalingState === "stable") void initiateOffer(peerId);
      };

      peerConnectionsRef.current.set(peerId, pc);
      return pc;
    },
    [send, closePeerConnection, initiateOffer],
  );

  const handleOffer = useCallback(
    async (from: string, payload: RTCSessionDescriptionInit) => {
      let pc = peerConnectionsRef.current.get(from);
      // If the other side is recovering from a broken pc, the offer they
      // send us may land on our own dead pc — setRemoteDescription would
      // throw on closed, and renegotiating over a failed/disconnected pc
      // tends not to recover. Rebuild so the recovery offer takes effect.
      if (
        pc &&
        (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected")
      ) {
        closePeerConnection(from);
        pc = undefined;
      }
      if (!pc) pc = createPeerConnection(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        // setRemoteDescription may have spun up new transceivers (one per
        // m-line in the offer) — apply codec prefs before answering so
        // VP8 is dropped to the back of the list for the inbound video.
        preferEfficientVideoCodecs(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "answer", to: from, payload: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[mesh] handleOffer failed", err);
      }
    },
    [createPeerConnection, closePeerConnection, send],
  );

  const handleAnswer = useCallback(async (from: string, payload: RTCSessionDescriptionInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } catch (err) {
      console.warn("[mesh] handleAnswer failed", err);
    }
  }, []);

  const handleIce = useCallback(async (from: string, payload: RTCIceCandidateInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload));
    } catch {
      /* stale candidate */
    }
  }, []);

  // ---- public API: publish / unpublish / updateSlot ----------------------

  const publish = useCallback(
    (stream: MediaStream, kind: SlotKind, label: string) => {
      if (localStreamsRef.current.has(stream.id)) return;
      localStreamsRef.current.set(stream.id, { stream, kind });
      // Add tracks to all existing PCs; onnegotiationneeded handles the rest.
      for (const pc of peerConnectionsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* duplicate */
          }
        }
        applySenderCaps(pc, stream, kind);
        preferEfficientVideoCodecs(pc);
      }
      send({ type: "publish", streamId: stream.id, kind, label });
    },
    [send],
  );

  const replaceTrack = useCallback(
    async (streamId: string, kind: "audio" | "video", newTrack: MediaStreamTrack): Promise<MediaStream | null> => {
      const entry = localStreamsRef.current.get(streamId);
      if (!entry) return null;
      const { stream, kind: pubKind } = entry;
      // Swap the sender on every PC. Sender lookup is by track.kind on
      // the *current* track — works because we only have one of each
      // kind per pub (audio pubs are audio-only, video pubs are video-only).
      for (const pc of peerConnectionsRef.current.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === kind);
        if (!sender) continue;
        try {
          await sender.replaceTrack(newTrack);
        } catch (err) {
          console.warn("[mesh] replaceTrack failed", err);
        }
      }
      // Construct a brand-new MediaStream so React-side consumers re-bind:
      // MediaStreamAudioSourceNode and HTMLMediaElement.srcObject latch onto
      // a track at hookup time, and add/removetrack do NOT fire for
      // dev-initiated mutations — handing back a new object is the only
      // reliable signal.
      const oldTracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      const keepTracks = kind === "audio" ? stream.getVideoTracks() : stream.getAudioTracks();
      const fresh = new MediaStream([...keepTracks, newTrack]);
      for (const t of oldTracks) t.stop();
      // Map key is the ORIGINAL publication streamId, not fresh.id — peers
      // and the unpublish path both look up by the published id.
      localStreamsRef.current.set(streamId, { stream: fresh, kind: pubKind });
      // Re-apply sender caps — replaceTrack swaps the underlying track on
      // the existing sender, and although setParameters values persist
      // through that, the safest path is to re-pin them so a freshly-
      // attached hardware encoder picks up the right bitrate/framerate.
      for (const pc of peerConnectionsRef.current.values()) {
        applySenderCaps(pc, fresh, pubKind);
      }
      return fresh;
    },
    [],
  );

  const unpublish = useCallback(
    (streamId: string) => {
      // Local tracks + peer-connection senders only need teardown when
      // WE own the stream. For a force-close on someone else's pub we
      // fall through to just the WS message — the relay will broadcast
      // `unpublished`, the publisher's reconcile effect will stop their
      // hardware, every peer (including us) drops the pub from state.
      const entry = localStreamsRef.current.get(streamId);
      if (entry) {
        const { stream } = entry;
        localStreamsRef.current.delete(streamId);
        const tracks = new Set(stream.getTracks());
        for (const pc of peerConnectionsRef.current.values()) {
          for (const sender of pc.getSenders()) {
            if (sender.track && tracks.has(sender.track)) {
              try {
                pc.removeTrack(sender);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
      // Optimistic local removal so the window unmounts immediately on
      // the X click. Without this, the publication stays in
      // `publications` until the relay echoes "unpublished" back over
      // the WS — ~RTT of latency where the window looks unresponsive
      // and users hammer the X two or three times before they see it
      // close. App windows already do this in closeWindow above;
      // bringing publications up to parity. The filter is idempotent
      // so the eventual relay broadcast is a harmless no-op.
      setPublications(prev => prev.filter(p => p.streamId !== streamId));
      send({ type: "unpublish", streamId });
    },
    [send],
  );

  const openBrowser = useCallback(
    (id: string, url: string, appId?: string) => {
      // Optimistic local insert so the window pops in instantly.
      setBrowsers(prev => ({
        ...prev,
        [id]: { id, url, openedBy: myIdRef.current ?? "", openedAt: Date.now(), ...(appId ? { appId } : {}) },
      }));
      send({ type: "browser_open", id, url, ...(appId ? { appId } : {}) });
    },
    [send],
  );

  const navigateBrowser = useCallback(
    (id: string, url: string) => {
      setBrowsers(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], url } } : prev));
      send({ type: "browser_navigate", id, url });
    },
    [send],
  );

  const closeBrowser = useCallback(
    (id: string) => {
      setBrowsers(prev => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      send({ type: "browser_close", id });
    },
    [send],
  );

  // Optimistic local toggle so the window pops in/out instantly; server
  // rebroadcast confirms (and carries the change to other peers).
  const openWindow = useCallback(
    (id: string) => {
      setOpenWindowIds(prev => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      send({ type: "window_open", id });
    },
    [send],
  );
  const closeWindow = useCallback(
    (id: string) => {
      setOpenWindowIds(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      send({ type: "window_close", id });
    },
    [send],
  );

  const setMusicState = useCallback(
    (state: MusicState) => {
      // Optimistic local apply so the local UI doesn't wait a round-trip
      // for its own click — the server echo will (harmlessly) re-apply.
      setMusicStateLocal(state);
      send({ type: "music_state", ...state });
    },
    [send],
  );

  // ---- Chess action helpers --------------------------------------
  // No optimistic state update here — the relay owns the truth, and
  // a rejected move (illegal, not-your-turn) should NOT briefly show
  // a fake board state. We wait for the server's chess_state echo.
  const chessCreate = useCallback(
    (args: { whiteKey: string; blackKey: string; whiteLabel: string; blackLabel: string }) => {
      send({ type: "chess_create_game", ...args });
    },
    [send],
  );
  const chessMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      send({ type: "chess_move", from, to, promotion });
    },
    [send],
  );
  const chessResign = useCallback(() => {
    send({ type: "chess_resign" });
  }, [send]);
  const chessCloseGame = useCallback(() => {
    send({ type: "chess_close_game" });
  }, [send]);

  // Money games. The relay owns every transition; these just post intent.
  // Chess-specific openers:
  const chessWagerPropose = useCallback(
    (args: {
      whiteKey: string;
      whiteLabel: string;
      blackKey: string;
      blackLabel: string;
      buyinWei: string;
      chainId: number;
    }) => {
      send({ type: "wager_propose", ...args });
    },
    [send],
  );
  const chessWagerStart = useCallback(() => {
    send({ type: "wager_start" });
  }, [send]);
  // Generic escrow actions (any game):
  const escrowFund = useCallback(
    (txHash: string) => {
      setEscrowFundResult(null);
      send({ type: "escrow_fund", txHash });
    },
    [send],
  );
  const escrowCancel = useCallback(() => {
    send({ type: "escrow_cancel" });
  }, [send]);
  const escrowClear = useCallback(() => {
    send({ type: "escrow_clear" });
  }, [send]);

  // Reconcile myPongSeat against the authoritative seats map. Catches
  // reconnects where the WS replies `pong_state` before we ever asked
  // for our own seat, and the "I refreshed, seat already empty" case.
  useEffect(() => {
    const myKey = (self?.address ?? self?.handle ?? "").toLowerCase();
    if (!myKey) {
      if (myPongSeat !== null) setMyPongSeat(null);
      return;
    }
    let detected: PongSide | null = null;
    if (pongState.seats.left?.ownerKey === myKey) detected = "left";
    else if (pongState.seats.right?.ownerKey === myKey) detected = "right";
    if (detected !== myPongSeat) setMyPongSeat(detected);
  }, [pongState.seats, self?.address, self?.handle, myPongSeat]);

  const pongClaim = useCallback(() => {
    send({ type: "pong_claim" });
  }, [send]);
  const pongRelease = useCallback(() => {
    // Optimistic: clear local seat immediately. The server's `pong_seat`
    // reply confirms; the next `pong_state` snapshot reconciles.
    setMyPongSeat(null);
    send({ type: "pong_release" });
  }, [send]);
  const pongPaddle = useCallback(
    (y: number) => {
      send({ type: "pong_paddle", y });
    },
    [send],
  );
  const pongReset = useCallback(() => {
    send({ type: "pong_reset" });
  }, [send]);

  // Reconcile myWormSlot against the authoritative players map — mirrors
  // the pong-seat reconcile (reconnects, refresh-with-seat-gone, etc.).
  useEffect(() => {
    const myKey = (self?.address ?? self?.handle ?? "").toLowerCase();
    if (!myKey) {
      if (myWormSlot !== null) setMyWormSlot(null);
      return;
    }
    let detected: number | null = null;
    for (const p of wormState.players) {
      if (p && p.ownerKey === myKey) {
        detected = p.slot;
        break;
      }
    }
    if (detected !== myWormSlot) setMyWormSlot(detected);
  }, [wormState.players, self?.address, self?.handle, myWormSlot]);

  const wormClaim = useCallback(() => {
    send({ type: "worm_claim" });
  }, [send]);
  const wormRelease = useCallback(() => {
    // Optimistic: clear local slot immediately; `worm_slot` confirms.
    setMyWormSlot(null);
    send({ type: "worm_release" });
  }, [send]);
  const wormSetDir = useCallback(
    (dir: WormDir) => {
      send({ type: "worm_dir", dir });
    },
    [send],
  );
  const wormReset = useCallback(() => {
    send({ type: "worm_reset" });
  }, [send]);

  const sendClick = useCallback(
    (x: number, y: number) => {
      send({ type: "click", x, y });
    },
    [send],
  );

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      send({ type: "chat_send", text: trimmed.slice(0, 500) });
    },
    [send],
  );

  const sendLiveCaption = useCallback(
    (text: string, isFinal: boolean) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      send({ type: "live_caption", text: trimmed.slice(0, 1000), isFinal });
    },
    [send],
  );

  const sendLiveCaptionState = useCallback(
    (alive: boolean) => {
      send({ type: "live_caption_state", alive });
    },
    [send],
  );

  const todoAdd = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      send({ type: "todo_add", text: trimmed.slice(0, 500) });
    },
    [send],
  );
  const todoToggle = useCallback(
    (id: string) => {
      send({ type: "todo_toggle", id });
    },
    [send],
  );
  const todoUpdate = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      send({ type: "todo_update", id, text: trimmed.slice(0, 500) });
    },
    [send],
  );
  const todoDelete = useCallback(
    (id: string) => {
      send({ type: "todo_delete", id });
    },
    [send],
  );
  const todoClearDone = useCallback(() => {
    send({ type: "todo_clear_done" });
  }, [send]);
  const todoReorder = useCallback(
    (ids: string[]) => {
      send({ type: "todo_reorder", ids });
    },
    [send],
  );

  const noteCreate = useCallback(
    (text: string) => {
      send({ type: "note_create", text: text.slice(0, 10_000) });
    },
    [send],
  );
  const noteUpdate = useCallback(
    (id: string, text: string) => {
      send({ type: "note_update", id, text: text.slice(0, 10_000) });
    },
    [send],
  );
  const noteDelete = useCallback(
    (id: string) => {
      send({ type: "note_delete", id });
    },
    [send],
  );

  const glossaryAdd = useCallback(
    (term: string) => {
      const trimmed = term.trim().slice(0, 120);
      if (!trimmed) return;
      send({ type: "glossary_add", term: trimmed });
    },
    [send],
  );
  const glossaryRegenerate = useCallback(
    (id: string) => {
      send({ type: "glossary_regenerate", id });
    },
    [send],
  );
  const glossaryDelete = useCallback(
    (id: string) => {
      send({ type: "glossary_delete", id });
    },
    [send],
  );

  // Files mutate via HTTP (binary upload + DELETE) rather than WS, so
  // the deleteFile callback fires an HTTP request. The relay broadcasts
  // `file_removed` to the mesh after a successful delete, which our WS
  // handler above picks up — no optimistic insert needed.
  const deleteFile = useCallback(
    (id: string) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/files/${encodeURIComponent(id)}`, slug), {
        method: "DELETE",
        credentials: "include",
      }).catch(err => console.warn("deleteFile failed", err));
    },
    [slug],
  );

  // Switch the shared genre. The relay broadcasts `music_genre`
  // back to every peer (including us) so we don't optimistically
  // setState here — the WS echo is authoritative.
  const setMusicGenre = useCallback(
    (genre: string | null) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/music/genre`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ genre }),
      }).catch(err => console.warn("setMusicGenre failed", err));
    },
    [slug],
  );

  // Custom playlist mutations — all three flow through HTTP POSTs /
  // DELETE on the relay, which validates + broadcasts `music_custom`
  // back to the mesh. No optimistic local update.
  const addToMusicCustom = useCallback(
    (track: JamendoTrack) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/music/custom/add`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ track }),
      }).catch(err => console.warn("addToMusicCustom failed", err));
    },
    [slug],
  );
  const removeFromMusicCustom = useCallback(
    (jamendoId: string) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/music/custom/${encodeURIComponent(jamendoId)}`, slug), {
        method: "DELETE",
        credentials: "include",
      }).catch(err => console.warn("removeFromMusicCustom failed", err));
    },
    [slug],
  );
  const reorderMusicCustom = useCallback(
    (orderedIds: string[]) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/music/custom/reorder`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: orderedIds }),
      }).catch(err => console.warn("reorderMusicCustom failed", err));
    },
    [slug],
  );

  // Host-only: write the on-screen chyron. Empty / whitespace clears
  // it (the banner collapses to zero height on every peer). No optimistic
  // local update — the relay echoes `chyron` on the WS so every peer
  // including the host flips at once. Server returns 403 for non-hosts;
  // the UI only exposes the edit affordance to the host so the POST
  // should be the only failure surface in practice.
  const setChyron = useCallback(
    (text: string) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/chyron`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(err => console.warn("setChyron failed", err));
    },
    [slug],
  );

  // Spectator (god-mode) broadcast of inner window size. Relay drops
  // it for non-spectators, so this is safe to call from anywhere — the
  // Desktop only hooks it up inside the spectator-gated effect. Use the
  // local state optimistically so the spectator's own dashed line tracks
  // their resize without a round-trip.
  const setGodViewport = useCallback(
    (v: { width: number; height: number } | null) => {
      setGodViewportState(v);
      send({ type: "god_viewport", viewport: v });
    },
    [send],
  );

  // Clear the shared title card — anyone in the room may reset, which
  // hides the generated PNG and brings the template back. Relay
  // broadcasts `card_state: null` so every peer flips at once.
  const resetCard = useCallback(() => {
    fetch(withSlug(`${RELAY_HTTP_URL}/v1/card`, slug), {
      method: "DELETE",
      credentials: "include",
    }).catch(err => console.warn("resetCard failed", err));
  }, [slug]);

  // Research mutators — all three POST to the relay, which broadcasts
  // `research_state` back to every peer (including us). No optimistic
  // local update; the WS echo is authoritative so we don't have to
  // hand-roll the phase transitions on the client.
  const researchLookup = useCallback(
    (query: string) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/guest-lookup`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }).catch(err => console.warn("researchLookup failed", err));
    },
    [slug],
  );
  const researchStart = useCallback(
    (args: { name: string; socials: ResearchSocials; notes?: string }) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/guest-research`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }).catch(err => console.warn("researchStart failed", err));
    },
    [slug],
  );
  const researchReset = useCallback(() => {
    fetch(withSlug(`${RELAY_HTTP_URL}/v1/research`, slug), {
      method: "DELETE",
      credentials: "include",
    }).catch(err => console.warn("researchReset failed", err));
  }, [slug]);

  // Leftclaw "Hire" mutators. start() returns the relay Response so the
  // driver can bail on a 409 before touching the wallet; the rest are
  // fire-and-forget — the `leftclaw_state` broadcast is authoritative.
  const leftclawStart = useCallback(
    (args: {
      serviceTypeId: LeftclawServiceId;
      description: string;
      context?: string;
      paymentMethod: LeftclawPayment;
    }) =>
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/leftclaw/start`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    [slug],
  );
  const leftclawUpdate = useCallback(
    (step: string) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/leftclaw/update`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step }),
      }).catch(err => console.warn("leftclawUpdate failed", err));
    },
    [slug],
  );
  const leftclawDone = useCallback(
    (args: { jobId: number; jobUrl?: string; txHash?: string }) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/leftclaw/done`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }).catch(err => console.warn("leftclawDone failed", err));
    },
    [slug],
  );
  const leftclawError = useCallback(
    (message: string) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/leftclaw/error`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: message }),
      }).catch(err => console.warn("leftclawError failed", err));
    },
    [slug],
  );
  const leftclawReset = useCallback(() => {
    fetch(withSlug(`${RELAY_HTTP_URL}/v1/leftclaw`, slug), {
      method: "DELETE",
      credentials: "include",
    }).catch(err => console.warn("leftclawReset failed", err));
  }, [slug]);
  const leftclawClearHistory = useCallback(() => {
    fetch(withSlug(`${RELAY_HTTP_URL}/v1/leftclaw/history`, slug), {
      method: "DELETE",
      credentials: "include",
    }).catch(err => console.warn("leftclawClearHistory failed", err));
  }, [slug]);

  // "Catch me up" — ask the relay to summarize the recent transcript. The
  // relay broadcasts `tldr_state` (pending, then ready) back to every peer,
  // so one click recaps the whole room. No-op if a job is already in flight
  // (relay drops the duplicate).
  const requestTldr = useCallback(() => {
    send({ type: "tldr_request" });
  }, [send]);

  // QR text + logo broadcast. Low frequency (host types occasionally,
  // logo replaced rarely) — REST POST is fine; the relay broadcasts
  // `qr_state` back to every peer including us. Returns a result so
  // the caller can show an upload error in the UI — a previous
  // version swallowed failures with a console.warn, which made a
  // 413 (logo > body limit) look like the drag had simply done
  // nothing.
  const setQrPatch = useCallback(
    async (patch: {
      text?: string;
      logoDataUrl?: string;
      clearLogo?: boolean;
    }): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const res = await fetch(withSlug(`${RELAY_HTTP_URL}/v1/qr`, slug), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          if (res.status === 413) return { ok: false, error: "logo too large to share" };
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return { ok: false, error: body.error ?? `relay error ${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `network error: ${String(err).slice(0, 200)}` };
      }
    },
    [slug],
  );

  // File-preview media playhead. High frequency during a scrub, so
  // route through WS (like music_state) rather than REST. Optimistic
  // local update so the dragger sees no lag; the WS echo is harmless
  // when it matches.
  const setPreviewMedia = useCallback(
    (fileId: string, state: PreviewMediaSnapshot) => {
      setPreviewMediaLocal(prev => ({ ...prev, [fileId]: state }));
      send({ type: "preview_media", fileId, ...state });
    },
    [send],
  );

  // Per-surface scroll position broadcast. Optimistic local update so
  // the scroller sees no lag; the WS echo is harmless when it matches.
  // The relay clamps `frac` to 0..1 server-side as a defensive net.
  const setScrollSync = useCallback(
    (key: string, state: ScrollSnapshot) => {
      setScrollSyncLocal(prev => ({ ...prev, [key]: state }));
      send({ type: "scroll_sync", key, frac: state.frac, at: state.at });
    },
    [send],
  );

  // Per-key discrete UI selection broadcast. Optimistic local update so
  // the clicker sees no lag; the WS echo overwrites with the
  // server-canonical value, harmless when it matches.
  const setUIState = useCallback(
    (key: string, value: unknown) => {
      setUIStateLocal(prev => ({ ...prev, [key]: value }));
      send({ type: "ui_state", key, value, at: Date.now() });
    },
    [send],
  );

  // Wallet AI chat. POST to the relay, which appends the turn, runs the
  // intent engine, and broadcasts `wallet_chat` back to every peer —
  // no optimistic local update; the WS echo is authoritative.
  const walletChatSend = useCallback(
    (message: string, address: string, chainId: number) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/wallet-chat`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, address, chainId }),
      }).catch(err => console.warn("walletChatSend failed", err));
    },
    [slug],
  );
  const walletChatReset = useCallback(() => {
    fetch(withSlug(`${RELAY_HTTP_URL}/v1/wallet-chat`, slug), {
      method: "DELETE",
      credentials: "include",
    }).catch(err => console.warn("walletChatReset failed", err));
  }, [slug]);

  // Broadcast a new title overlay state. Updates local optimistically
  // so the dragging peer sees no lag; server fans the change out to
  // everyone else (excluding sender) and persists last-write-wins.
  const setCardTitle = useCallback(
    (title: CardTitle) => {
      setCardTitleLocal(title);
      send({ type: "card_title", title });
    },
    [send],
  );

  // Update the shared clock state. Partial patch — fields you omit
  // are preserved server-side. Relay broadcasts `clock_state` to
  // every peer (including us) so the WS echo is authoritative.
  const setClockState = useCallback(
    (patch: Partial<ClockState>) => {
      fetch(withSlug(`${RELAY_HTTP_URL}/v1/clock`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(err => console.warn("setClockState failed", err));
    },
    [slug],
  );

  const broadcastTxRequest = useCallback(
    (req: Omit<TxRequest, "from" | "receivedAt">) => {
      send({
        type: "tx_request",
        browserId: req.browserId,
        calldata: req.calldata,
        to: req.to,
        value: req.value,
        chainId: req.chainId,
      });
    },
    [send],
  );

  const forwardTxToPeer = useCallback(
    (
      peerId: string,
      payload: {
        browserId: string;
        method: string;
        params: unknown[];
        chainId: number | null;
        requestId?: string;
      },
    ) => {
      send({
        type: "tx_forward",
        to: peerId,
        // The relay uses this as the forward's id (falling back to a fresh
        // per-message id only when absent). Sending the host's stable
        // requestId is what lets the receiver collapse the duplicate
        // forwards from every watcher of the shared tab into one modal.
        ...(payload.requestId ? { id: payload.requestId } : {}),
        browserId: payload.browserId,
        method: payload.method,
        params: payload.params,
        chainId: payload.chainId,
      });
    },
    [send],
  );

  const dismissIncomingForward = useCallback((id: string) => {
    setIncomingForwards(prev => prev.filter(f => f.id !== id));
  }, []);

  const walletDeploy = useCallback(
    (rec: WalletRecord) => {
      send({ type: "wallet_deploy", wallet: rec });
    },
    [send],
  );
  const walletAddDeployment = useCallback(
    (chainId: number, txHash: string | null) => {
      send({ type: "wallet_add_deployment", chainId, txHash });
    },
    [send],
  );
  const walletDraftUpdate = useCallback(
    (draft: WalletDraft | null) => {
      send({ type: "wallet_draft_update", draft });
    },
    [send],
  );
  const walletNewEpisode = useCallback(() => {
    send({ type: "wallet_new_episode" });
  }, [send]);
  const walletProposeTx = useCallback(
    (req: {
      chainId: number;
      target: string;
      value: string;
      data: string;
      deadline: string;
      nonce: string;
      execHash: string;
      source: WalletTx["source"];
      browserId?: string | null;
      calls?: WalletTxCall[];
    }) => {
      send({
        type: "wallet_tx_propose",
        chainId: req.chainId,
        target: req.target,
        value: req.value,
        data: req.data,
        deadline: req.deadline,
        nonce: req.nonce,
        execHash: req.execHash,
        source: req.source,
        browserId: req.browserId ?? null,
        ...(req.calls && req.calls.length > 0 ? { calls: req.calls } : {}),
      });
    },
    [send],
  );
  const walletSignTx = useCallback(
    (id: string, sig: { signer: string; sigType: 0 | 1; data: string }) => {
      send({ type: "wallet_tx_sign", id, signer: sig.signer, sigType: sig.sigType, data: sig.data });
    },
    [send],
  );
  const walletSetTxStatus = useCallback(
    (id: string, status: WalletTxStatus, txHash?: string | null) => {
      send({ type: "wallet_tx_status", id, status, txHash: txHash ?? null });
    },
    [send],
  );
  const walletRemoveTx = useCallback(
    (id: string) => {
      send({ type: "wallet_tx_remove", id });
    },
    [send],
  );
  const walletResummarize = useCallback(
    (id: string) => {
      send({ type: "wallet_tx_resummarize", id });
    },
    [send],
  );

  const setCustomName = useCallback(
    (name: string | null) => {
      // Pass an empty string or null to clear. Server is the source of
      // truth — we don't optimistically update local state; the relay
      // will broadcast `peer_name` back and the listener above applies it.
      send({ type: "set_custom_name", name });
    },
    [send],
  );

  const setCameraOff = useCallback(
    (streamId: string, off: boolean) => {
      // Server is source of truth — the relay rebroadcasts the updated
      // publication via `published`, which the handler above applies. No
      // optimistic local write, same model as setCustomName.
      send({ type: "set_camera_off", streamId, off });
    },
    [send],
  );

  const updateSlot = useCallback(
    (patch: Partial<SlotPosition> & { id: string }) => {
      // HARD RULE: every brand-new window comes to the front. If no slot
      // exists yet for this id, override whatever z the caller passed
      // with one above every existing slot. One rule, one place — no
      // defaultSlot site has to know the current max, no app-vs-pub
      // mismatch can spawn a window underneath another.
      const cur = slotsRef.current[patch.id];
      const finalPatch: Partial<SlotPosition> & { id: string } = cur
        ? patch
        : { ...patch, z: Math.max(0, ...Object.values(slotsRef.current).map(s => s.z)) + 1 };
      // Optimistic local update so a controlled <Rnd> doesn't snap back
      // while waiting for the server echo. Relay broadcast then confirms.
      setSlots(prev => {
        const existing = prev[finalPatch.id];
        const merged: SlotPosition = {
          id: finalPatch.id,
          x: finalPatch.x ?? existing?.x ?? 80,
          y: finalPatch.y ?? existing?.y ?? 280,
          width: finalPatch.width ?? existing?.width ?? 360,
          height: finalPatch.height ?? existing?.height ?? 260,
          z: finalPatch.z ?? existing?.z ?? 5,
        };
        return { ...prev, [finalPatch.id]: merged };
      });
      send({ type: "slot_update", ...finalPatch });
    },
    [send],
  );

  // ---- WS lifecycle ------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Wall-clock send time of the most recent ping; pong reply subtracts
    // this to derive RTT. We only care about the latest sample — a fresh
    // ping replaces any in-flight measurement.
    let lastPingSentAt: number | null = null;

    const teardownConnections = () => {
      peerConnectionsRef.current.forEach(pc => {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      });
      peerConnectionsRef.current = new Map();
      setRemoteStreams(new Map());
    };

    const connect = async () => {
      if (cancelled) return;
      iceConfigRef.current = await fetchIceConfig();
      if (cancelled) return;
      // Append the room slug so the relay routes this peer into the
      // right Room (defaults to `main` server-side if missing, so old
      // clients during a rolling deploy still land somewhere usable).
      const wsUrl = `${RELAY_WS_URL}${RELAY_WS_URL.includes("?") ? "&" : "?"}slug=${encodeURIComponent(slug)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        ws.send(JSON.stringify({ type: "hello" }));
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          lastPingSentAt = performance.now();
          ws.send(JSON.stringify({ type: "ping" }));
        }, PING_INTERVAL_MS);
        // Send the first ping immediately so the meter doesn't sit empty
        // for the full interval after connect.
        lastPingSentAt = performance.now();
        ws.send(JSON.stringify({ type: "ping" }));
        // Re-announce any locally-published streams (e.g. after reconnect).
        for (const [streamId, { kind }] of localStreamsRef.current) {
          const hint = selfRef.current;
          ws.send(
            JSON.stringify({
              type: "publish",
              streamId,
              kind,
              label: hint?.handle ?? hint?.address ?? "anon",
            }),
          );
        }
      };

      ws.onmessage = ev => {
        if (cancelled) return;
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }

        if (msg.type === "hello" && typeof msg.id === "string" && Array.isArray(msg.peers)) {
          const meId = msg.id;
          const others = msg.peers as Peer[];
          myIdRef.current = meId;
          setMyId(meId);
          const hint = selfRef.current;
          const me: Peer = {
            id: meId,
            role: hint?.role ?? "guest",
            address: hint?.address ?? null,
            handle: hint?.handle ?? null,
            anonId: hint?.anonId ?? null,
            ...(hint?.spectator ? { spectator: true as const } : {}),
          };
          setPeers([...others, me]);

          if (Array.isArray(msg.publications)) setPublications(msg.publications as Publication[]);
          if (Array.isArray(msg.slots)) {
            const next: Record<string, SlotPosition> = {};
            for (const s of msg.slots as SlotPosition[]) next[s.id] = s;
            setSlots(next);
          }
          if (Array.isArray(msg.browsers)) {
            const next: Record<string, Browser> = {};
            for (const b of msg.browsers as Browser[]) next[b.id] = b;
            setBrowsers(next);
          }
          if (msg.avatars && typeof msg.avatars === "object" && !Array.isArray(msg.avatars)) {
            setAvatars({ ...(msg.avatars as Record<string, string>) });
          }
          if (Array.isArray(msg.hiddenAvatars)) {
            setHiddenAvatars(new Set(msg.hiddenAvatars as string[]));
          }
          if (Array.isArray(msg.chatHistory)) {
            setChatMessages((msg.chatHistory as ChatMessage[]).slice(-CHAT_HISTORY_CAP));
          }
          if (Array.isArray(msg.openWindows)) {
            setOpenWindowIds(new Set((msg.openWindows as unknown[]).filter((s): s is string => typeof s === "string")));
          }
          if (msg.musicState && typeof msg.musicState === "object") {
            setMusicStateLocal(msg.musicState as MusicState);
          }
          if (msg.chessGame === null || (msg.chessGame && typeof msg.chessGame === "object")) {
            setChessGame((msg.chessGame ?? null) as ChessGame | null);
          }
          if (Array.isArray(msg.chessHistory)) {
            setChessHistory(msg.chessHistory as ChessResult[]);
          }
          if (msg.escrow === null || (msg.escrow && typeof msg.escrow === "object")) {
            setEscrow((msg.escrow ?? null) as EscrowSession | null);
          }
          if (Array.isArray(msg.aiPlayers)) {
            setAiPlayers(msg.aiPlayers as AIPlayer[]);
          }
          if (Array.isArray(msg.todos)) {
            setTodos(msg.todos as TodoItem[]);
          }
          if (Array.isArray(msg.notes)) {
            setNotes(msg.notes as Note[]);
          }
          if (Array.isArray(msg.glossary)) {
            setGlossary(msg.glossary as GlossaryTerm[]);
          }
          if (msg.gasState && typeof msg.gasState === "object") {
            setGasState(msg.gasState as GasState);
          }
          if (msg.tickerState && typeof msg.tickerState === "object") {
            setTickerState(msg.tickerState as TickerState);
          }
          if (msg.headlinesState && typeof msg.headlinesState === "object") {
            setHeadlinesState(msg.headlinesState as HeadlinesState);
          }
          if (msg.timelineState && typeof msg.timelineState === "object") {
            setTimelineState(msg.timelineState as TimelineState);
          }
          if (msg.chyronState && typeof msg.chyronState === "object") {
            setChyronState(msg.chyronState as ChyronState);
          }
          if (msg.godViewport === null || (msg.godViewport && typeof msg.godViewport === "object")) {
            const gv = msg.godViewport as { width?: unknown; height?: unknown } | null;
            if (gv === null) {
              setGodViewportState(null);
            } else if (typeof gv.width === "number" && typeof gv.height === "number") {
              setGodViewportState({ width: gv.width, height: gv.height });
            }
          }
          if (msg.newsDigestState && typeof msg.newsDigestState === "object") {
            setNewsDigestState(msg.newsDigestState as NewsDigestState);
          }
          if (Array.isArray(msg.files)) {
            setFiles(msg.files as FileEntry[]);
          }
          if (Array.isArray(msg.musicGenres)) {
            setMusicGenresState(msg.musicGenres as { id: string; label: string }[]);
          }
          if (typeof msg.musicGenre === "string" || msg.musicGenre === null) {
            setMusicGenreLocal(msg.musicGenre as string | null);
          }
          if (Array.isArray(msg.musicCustom)) {
            setMusicCustomLocal(msg.musicCustom as JamendoTrack[]);
          }
          if (msg.clockState && typeof msg.clockState === "object") {
            setClockStateLocal(msg.clockState as ClockState);
          }
          if (msg.wallet === null || (msg.wallet && typeof msg.wallet === "object")) {
            setWallet((msg.wallet ?? null) as WalletRecord | null);
          }
          if (msg.walletDraft === null || (msg.walletDraft && typeof msg.walletDraft === "object")) {
            setWalletDraft((msg.walletDraft ?? null) as WalletDraft | null);
          }
          if (Array.isArray(msg.walletTxs)) {
            setWalletTxs(msg.walletTxs as WalletTx[]);
          }
          if (msg.customNames && typeof msg.customNames === "object" && !Array.isArray(msg.customNames)) {
            const next: Record<string, string> = {};
            for (const [addr, name] of Object.entries(msg.customNames as Record<string, unknown>)) {
              if (typeof name === "string") next[addr.toLowerCase()] = name;
            }
            setCustomNames(next);
          }
          if (msg.cardState === null || (msg.cardState && typeof msg.cardState === "object")) {
            setCardState((msg.cardState ?? null) as CardState | null);
          }
          if (msg.cardJob === null || (msg.cardJob && typeof msg.cardJob === "object")) {
            setCardJob((msg.cardJob ?? null) as CardJob | null);
          }
          if (msg.cardTitle === null || (msg.cardTitle && typeof msg.cardTitle === "object")) {
            setCardTitleLocal((msg.cardTitle ?? null) as CardTitle | null);
          }
          if (msg.researchState && typeof msg.researchState === "object") {
            setResearchStateLocal(msg.researchState as ResearchState);
          }
          if (msg.leftclawState && typeof msg.leftclawState === "object") {
            setLeftclawStateLocal(msg.leftclawState as LeftclawState);
          }
          if (msg.tldrState && typeof msg.tldrState === "object") {
            setTldrStateLocal(msg.tldrState as TldrState);
          }
          if (msg.qrState && typeof msg.qrState === "object") {
            setQrStateLocal(msg.qrState as QrState);
          }
          if (msg.pongState && typeof msg.pongState === "object") {
            setPongStateLocal(msg.pongState as PongState);
          }
          if (msg.wormState && typeof msg.wormState === "object") {
            setWormStateLocal(msg.wormState as WormState);
          }
          if (msg.walletChat && typeof msg.walletChat === "object") {
            setWalletChatLocal(msg.walletChat as WalletChat);
          }
          if (Array.isArray(msg.previewMedia)) {
            const map: Record<string, PreviewMediaSnapshot> = {};
            for (const entry of msg.previewMedia as Array<{ fileId: unknown; state: unknown }>) {
              if (typeof entry.fileId === "string" && entry.state && typeof entry.state === "object") {
                map[entry.fileId] = entry.state as PreviewMediaSnapshot;
              }
            }
            setPreviewMediaLocal(map);
          }
          if (Array.isArray(msg.scrollSync)) {
            const map: Record<string, ScrollSnapshot> = {};
            for (const entry of msg.scrollSync as Array<{ key: unknown; state: unknown }>) {
              if (typeof entry.key === "string" && entry.state && typeof entry.state === "object") {
                map[entry.key] = entry.state as ScrollSnapshot;
              }
            }
            setScrollSyncLocal(map);
          }
          if (Array.isArray(msg.uiState)) {
            const map: Record<string, unknown> = {};
            for (const entry of msg.uiState as Array<{ key: unknown; state: unknown }>) {
              if (
                typeof entry.key === "string" &&
                entry.state &&
                typeof entry.state === "object" &&
                "value" in entry.state
              ) {
                map[entry.key] = (entry.state as UIStateSnapshot).value;
              }
            }
            setUIStateLocal(map);
          }
          // Flip last so consumers can `if (bootstrapped) render` without
          // worrying about whether slots/browsers have been applied yet.
          setBootstrapped(true);

          teardownConnections();
          for (const peer of others) {
            if (peer.id < meId) {
              createPeerConnection(peer.id);
              void initiateOffer(peer.id);
            }
          }
          return;
        }

        if (msg.type === "peer_join" && msg.peer) {
          const peer = msg.peer as Peer;
          setPeers(prev => (prev.some(p => p.id === peer.id) ? prev : [...prev, peer]));
          const meIdNow = myIdRef.current;
          if (meIdNow && peer.id < meIdNow) {
            createPeerConnection(peer.id);
            void initiateOffer(peer.id);
          }
          return;
        }

        if (msg.type === "peer_leave" && msg.peer) {
          const peer = msg.peer as Peer;
          setPeers(prev => prev.filter(p => p.id !== peer.id));
          setPeerPings(prev => {
            if (!(peer.id in prev)) return prev;
            const next = { ...prev };
            delete next[peer.id];
            return next;
          });
          closePeerConnection(peer.id);
          return;
        }

        if (msg.type === "pong") {
          // RTT to the relay for the local user. Captured from the last
          // ping we sent; we also fan this out to every other peer so
          // they can render our row's meter.
          if (lastPingSentAt == null) return;
          const rtt = Math.round(performance.now() - lastPingSentAt);
          lastPingSentAt = null;
          const meId = myIdRef.current;
          if (meId) {
            setPeerPings(prev => (prev[meId] === rtt ? prev : { ...prev, [meId]: rtt }));
          }
          // Spectators don't show up in the visible peer list, so don't
          // pollute the room with their relay-RTT.
          if (!selfRef.current?.spectator) {
            send({ type: "ping_report", rtt });
          }
          return;
        }

        if (msg.type === "peer_ping" && typeof msg.from === "string" && typeof msg.rtt === "number") {
          const from = msg.from;
          const rtt = Math.round(msg.rtt);
          setPeerPings(prev => (prev[from] === rtt ? prev : { ...prev, [from]: rtt }));
          return;
        }

        if (msg.type === "peer_name") {
          // Global custom-name update — fired in every room the relay
          // serves, not just the room the setter is in. The local user
          // gets one of these too, which is what tells the UI their
          // edit landed.
          const address = typeof msg.address === "string" ? msg.address.toLowerCase() : null;
          if (!address) return;
          const name = typeof msg.name === "string" ? msg.name : null;
          setCustomNames(prev => {
            if (name == null) {
              if (!(address in prev)) return prev;
              const rest = { ...prev };
              delete rest[address];
              return rest;
            }
            if (prev[address] === name) return prev;
            return { ...prev, [address]: name };
          });
          return;
        }

        if (msg.type === "signal") {
          const kind = msg.kind as string;
          const from = msg.from as string;
          const payload = msg.payload as RTCSessionDescriptionInit | RTCIceCandidateInit;
          if (kind === "offer") void handleOffer(from, payload as RTCSessionDescriptionInit);
          else if (kind === "answer") void handleAnswer(from, payload as RTCSessionDescriptionInit);
          else if (kind === "ice") void handleIce(from, payload as RTCIceCandidateInit);
          return;
        }

        if (msg.type === "cursor") {
          const from = msg.from as string;
          const x = msg.x as number;
          const y = msg.y as number;
          if (typeof from !== "string" || typeof x !== "number" || typeof y !== "number") return;
          const address = typeof msg.address === "string" ? (msg.address as string) : null;
          const handle = typeof msg.handle === "string" ? (msg.handle as string) : null;
          const anonId = typeof msg.anonId === "string" ? (msg.anonId as string) : null;
          setCursors(prev => ({ ...prev, [from]: { x, y, address, handle, anonId } }));
          return;
        }

        if (msg.type === "click") {
          const from = msg.from as string;
          const x = msg.x as number;
          const y = msg.y as number;
          if (typeof from !== "string" || typeof x !== "number" || typeof y !== "number") return;
          const address = typeof msg.address === "string" ? (msg.address as string) : null;
          const handle = typeof msg.handle === "string" ? (msg.handle as string) : null;
          const anonId = typeof msg.anonId === "string" ? (msg.anonId as string) : null;
          clickIdRef.current += 1;
          const evt: ClickEvent = {
            id: clickIdRef.current,
            peerId: from,
            x,
            y,
            address,
            handle,
            anonId,
            receivedAt: Date.now(),
          };
          // Cap to 30 in flight so a click-spammer doesn't blow up the
          // render tree. The animation finishes in ~900ms and self-prunes.
          setClicks(prev => (prev.length >= 30 ? [...prev.slice(-29), evt] : [...prev, evt]));
          setTimeout(() => {
            setClicks(prev => prev.filter(c => c.id !== evt.id));
          }, 1000);
          return;
        }

        if (msg.type === "published" && msg.publication) {
          const pub = msg.publication as Publication;
          setPublications(prev => {
            const next = prev.filter(p => !(p.peerId === pub.peerId && p.streamId === pub.streamId));
            next.push(pub);
            return next;
          });
          return;
        }

        if (msg.type === "unpublished" && typeof msg.peerId === "string" && typeof msg.streamId === "string") {
          const pid = msg.peerId as string;
          const sid = msg.streamId as string;
          setPublications(prev => prev.filter(p => !(p.peerId === pid && p.streamId === sid)));
          setRemoteStreams(prev => {
            if (!prev.has(sid)) return prev;
            const next = new Map(prev);
            next.delete(sid);
            return next;
          });
          return;
        }

        if (msg.type === "slot" && msg.slot) {
          const s = msg.slot as SlotPosition;
          setSlots(prev => ({ ...prev, [s.id]: s }));
          return;
        }

        if (msg.type === "browser" && msg.browser) {
          const b = msg.browser as Browser;
          setBrowsers(prev => ({ ...prev, [b.id]: b }));
          return;
        }

        if (msg.type === "browser_closed" && typeof msg.id === "string") {
          const id = msg.id as string;
          setBrowsers(prev => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
          return;
        }

        if (msg.type === "window_opened" && typeof msg.id === "string") {
          const id = msg.id as string;
          setOpenWindowIds(prev => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
          });
          return;
        }

        if (msg.type === "window_closed" && typeof msg.id === "string") {
          const id = msg.id as string;
          setOpenWindowIds(prev => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          return;
        }

        if (msg.type === "music_state" && msg.state && typeof msg.state === "object") {
          setMusicStateLocal(msg.state as MusicState);
          return;
        }

        if (msg.type === "research_state" && msg.state && typeof msg.state === "object") {
          setResearchStateLocal(msg.state as ResearchState);
          return;
        }

        if (msg.type === "leftclaw_state" && msg.state && typeof msg.state === "object") {
          setLeftclawStateLocal(msg.state as LeftclawState);
          return;
        }

        if (msg.type === "tldr_state" && msg.state && typeof msg.state === "object") {
          setTldrStateLocal(msg.state as TldrState);
          return;
        }

        if (msg.type === "qr_state" && msg.state && typeof msg.state === "object") {
          setQrStateLocal(msg.state as QrState);
          return;
        }

        if (msg.type === "pong_state" && msg.state && typeof msg.state === "object") {
          setPongStateLocal(msg.state as PongState);
          return;
        }
        if (msg.type === "pong_seat") {
          const side = msg.side === "left" || msg.side === "right" ? (msg.side as PongSide) : null;
          setMyPongSeat(side);
          return;
        }

        if (msg.type === "worm_state" && msg.state && typeof msg.state === "object") {
          setWormStateLocal(msg.state as WormState);
          return;
        }
        if (msg.type === "worm_slot") {
          setMyWormSlot(typeof msg.slot === "number" ? msg.slot : null);
          return;
        }

        if (msg.type === "wallet_chat" && msg.state && typeof msg.state === "object") {
          setWalletChatLocal(msg.state as WalletChat);
          return;
        }

        if (
          msg.type === "preview_media" &&
          typeof msg.fileId === "string" &&
          msg.state &&
          typeof msg.state === "object"
        ) {
          const fileId = msg.fileId as string;
          const state = msg.state as PreviewMediaSnapshot;
          setPreviewMediaLocal(prev => ({ ...prev, [fileId]: state }));
          return;
        }

        if (
          msg.type === "ui_state" &&
          typeof msg.key === "string" &&
          msg.state &&
          typeof msg.state === "object" &&
          "value" in msg.state
        ) {
          const key = msg.key as string;
          const value = (msg.state as UIStateSnapshot).value;
          setUIStateLocal(prev => ({ ...prev, [key]: value }));
          return;
        }

        if (msg.type === "scroll_sync" && typeof msg.key === "string" && msg.state && typeof msg.state === "object") {
          const key = msg.key as string;
          const state = msg.state as ScrollSnapshot;
          setScrollSyncLocal(prev => ({ ...prev, [key]: state }));
          return;
        }

        if (msg.type === "chess_state") {
          // game may be null (lobby reopened) or an object
          setChessGame((msg.game ?? null) as ChessGame | null);
          return;
        }

        if (msg.type === "chess_history" && Array.isArray(msg.history)) {
          setChessHistory(msg.history as ChessResult[]);
          return;
        }

        if (msg.type === "escrow_state") {
          setEscrow((msg.escrow ?? null) as EscrowSession | null);
          return;
        }

        if (msg.type === "escrow_fund_result") {
          setEscrowFundResult({
            ok: !!msg.ok,
            txHash: typeof msg.txHash === "string" ? msg.txHash : "",
            reason: typeof msg.reason === "string" ? msg.reason : undefined,
          });
          return;
        }

        if (msg.type === "avatar" && typeof msg.ownerKey === "string" && typeof msg.url === "string") {
          const k = msg.ownerKey as string;
          const u = msg.url as string;
          setAvatars(prev => ({ ...prev, [k]: u }));
          // Uploading implicitly clears the hidden marker.
          setHiddenAvatars(prev => {
            if (!prev.has(k)) return prev;
            const next = new Set(prev);
            next.delete(k);
            return next;
          });
          return;
        }

        if (msg.type === "avatar_removed" && typeof msg.ownerKey === "string") {
          const k = msg.ownerKey as string;
          setAvatars(prev => {
            if (!(k in prev)) return prev;
            const next = { ...prev };
            delete next[k];
            return next;
          });
          // Clean slate also clears the hidden marker.
          setHiddenAvatars(prev => {
            if (!prev.has(k)) return prev;
            const next = new Set(prev);
            next.delete(k);
            return next;
          });
          return;
        }

        if (msg.type === "avatar_hidden" && typeof msg.ownerKey === "string") {
          const k = msg.ownerKey as string;
          setAvatars(prev => {
            if (!(k in prev)) return prev;
            const next = { ...prev };
            delete next[k];
            return next;
          });
          setHiddenAvatars(prev => {
            if (prev.has(k)) return prev;
            const next = new Set(prev);
            next.add(k);
            return next;
          });
          return;
        }

        if (msg.type === "chat" && msg.msg && typeof (msg.msg as ChatMessage).id === "string") {
          const cm = msg.msg as ChatMessage;
          setChatMessages(prev => {
            // Dedupe on id — a fast double-broadcast would otherwise
            // double-render in the window.
            if (prev.some(m => m.id === cm.id)) return prev;
            const next = [...prev, cm];
            return next.length > CHAT_HISTORY_CAP ? next.slice(-CHAT_HISTORY_CAP) : next;
          });
          return;
        }

        if (msg.type === "todos" && Array.isArray(msg.items)) {
          setTodos(msg.items as TodoItem[]);
          return;
        }

        if (msg.type === "notes" && Array.isArray(msg.items)) {
          setNotes(msg.items as Note[]);
          return;
        }

        if (msg.type === "glossary" && Array.isArray(msg.items)) {
          setGlossary(msg.items as GlossaryTerm[]);
          return;
        }

        if (msg.type === "gas" && msg.state && typeof msg.state === "object") {
          setGasState(msg.state as GasState);
          return;
        }

        if (msg.type === "ticker" && msg.state && typeof msg.state === "object") {
          setTickerState(msg.state as TickerState);
          return;
        }

        if (msg.type === "headlines" && msg.state && typeof msg.state === "object") {
          setHeadlinesState(msg.state as HeadlinesState);
          return;
        }

        if (msg.type === "timeline" && msg.state && typeof msg.state === "object") {
          setTimelineState(msg.state as TimelineState);
          return;
        }

        if (msg.type === "chyron" && msg.state && typeof msg.state === "object") {
          setChyronState(msg.state as ChyronState);
          return;
        }

        if (msg.type === "god_viewport") {
          const gv = msg.viewport as { width?: unknown; height?: unknown } | null | undefined;
          if (gv === null) {
            setGodViewportState(null);
            return;
          }
          if (gv && typeof gv.width === "number" && typeof gv.height === "number") {
            setGodViewportState({ width: gv.width, height: gv.height });
          }
          return;
        }

        if (msg.type === "transcript_seg" && msg.seg && typeof msg.seg === "object") {
          // Only the latest segment — the subtitle UI cross-fades on
          // each update and doesn't need history. The full transcript
          // archive lives on /v1/transcript for the dedicated window.
          setLatestTranscriptSeg(msg.seg as TranscriptSegment);
          return;
        }

        if (msg.type === "live_caption" && typeof msg.text === "string") {
          // Interim or final result from a speaker's in-browser STT.
          // Server-echoes back to the sender too, so the speaker sees
          // their own captions over the same path everyone else does.
          setLiveCaption({
            text: msg.text,
            isFinal: msg.isFinal === true,
            address: typeof msg.address === "string" ? msg.address : null,
            handle: typeof msg.handle === "string" ? msg.handle : null,
            anonId: typeof msg.anonId === "string" ? msg.anonId : null,
            speakerKey: typeof msg.speakerKey === "string" ? msg.speakerKey : null,
            ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
          });
          return;
        }

        if (msg.type === "news_digest" && msg.state && typeof msg.state === "object") {
          setNewsDigestState(msg.state as NewsDigestState);
          return;
        }

        if (msg.type === "file_added" && msg.item && typeof (msg.item as FileEntry).id === "string") {
          const f = msg.item as FileEntry;
          setFiles(prev => (prev.some(x => x.id === f.id) ? prev : [...prev, f]));
          return;
        }
        if (msg.type === "file_removed" && typeof msg.id === "string") {
          const id = msg.id as string;
          setFiles(prev => prev.filter(f => f.id !== id));
          return;
        }
        if (msg.type === "files" && Array.isArray(msg.items)) {
          setFiles(msg.items as FileEntry[]);
          return;
        }

        if (msg.type === "music_genre" && (typeof msg.genre === "string" || msg.genre === null)) {
          setMusicGenreLocal(msg.genre as string | null);
          return;
        }

        if (msg.type === "music_custom" && Array.isArray(msg.tracks)) {
          setMusicCustomLocal(msg.tracks as JamendoTrack[]);
          return;
        }

        if (msg.type === "clock_state" && msg.state && typeof msg.state === "object") {
          setClockStateLocal(msg.state as ClockState);
          return;
        }

        if (msg.type === "card_state") {
          // `state` is either { version } or null — null means the host
          // hit reset and the room is back on the template.
          if (msg.state === null || (msg.state && typeof msg.state === "object")) {
            setCardState((msg.state ?? null) as CardState | null);
          }
          return;
        }

        if (msg.type === "card_job") {
          // `job` is either { startedAt, startedBy } or null — non-null
          // turns the shared progress bar on for everyone in the room;
          // null clears it when generation completes or fails.
          if (msg.job === null || (msg.job && typeof msg.job === "object")) {
            setCardJob((msg.job ?? null) as CardJob | null);
          }
          return;
        }

        if (msg.type === "card_title") {
          // Another peer dragged / resized / renamed the title overlay.
          // Server excludes us when we're the sender, so this is always
          // a foreign update — overwrite local without checking who
          // sent it. Race resolution is last-write-wins.
          if (msg.title && typeof msg.title === "object") {
            setCardTitleLocal(msg.title as CardTitle);
          }
          return;
        }

        if (msg.type === "wallet") {
          setWallet((msg.current ?? null) as WalletRecord | null);
          if (Array.isArray(msg.history)) {
            setWalletHistory(msg.history as WalletRecord[]);
          }
          if (msg.draft === null || (msg.draft && typeof msg.draft === "object")) {
            setWalletDraft((msg.draft ?? null) as WalletDraft | null);
          }
          return;
        }

        if (msg.type === "wallet_txs" && Array.isArray(msg.txs)) {
          setWalletTxs(msg.txs as WalletTx[]);
          return;
        }

        if (msg.type === "wallet_tx_attention") {
          const source = msg.source === "browser" ? "browser" : "manual";
          const at = typeof msg.at === "number" ? msg.at : Date.now();
          setWalletAttention({ at, source });
          return;
        }

        if (msg.type === "tx_request" && typeof msg.browserId === "string" && typeof msg.calldata === "string") {
          const req: TxRequest = {
            from: typeof msg.from === "string" ? msg.from : "",
            browserId: msg.browserId,
            calldata: msg.calldata,
            to: typeof msg.to === "string" ? msg.to : null,
            value: typeof msg.value === "string" ? msg.value : null,
            chainId: typeof msg.chainId === "number" ? msg.chainId : null,
            receivedAt: Date.now(),
          };
          // Cap history at 50 to stop unbounded growth on long sessions.
          setTxRequests(prev => [req, ...prev].slice(0, 50));
          return;
        }

        // Directed: another peer captured a tx targeting our wallet address.
        // Stash it for the IncomingTxModal to render. We don't validate the
        // payload here — the modal decides whether to act on it.
        if (msg.type === "tx_forward" && typeof msg.id === "string" && typeof msg.browserId === "string") {
          const next: ForwardedTx = {
            id: msg.id,
            fromPeerId: typeof msg.from === "string" ? msg.from : "",
            fromAddress: typeof msg.fromAddress === "string" ? msg.fromAddress : null,
            fromHandle: typeof msg.fromHandle === "string" ? msg.fromHandle : null,
            browserId: msg.browserId,
            method: typeof msg.method === "string" ? msg.method : "",
            params: Array.isArray(msg.params) ? msg.params : [],
            chainId: typeof msg.chainId === "number" ? msg.chainId : null,
            receivedAt: Date.now(),
          };
          // Dedupe by id in case the relay double-delivers on reconnect.
          setIncomingForwards(prev => (prev.some(f => f.id === next.id) ? prev : [next, ...prev].slice(0, 20)));
          return;
        }
      };

      ws.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        setConnected(false);
        setBootstrapped(false);
        setMyId(null);
        myIdRef.current = null;
        teardownConnections();
        setPeers([]);
        setPublications([]);
        // Drop every remote cursor on WS drop. Without this, any peer who
        // left the room while we were disconnected becomes a permanent
        // ghost: their last cursor position stays in `mesh.cursors`, the
        // post-reconnect `hello` rebuilds `mesh.peers` without them, the
        // `mesh.peers.find(...)` lookup in Desktop.tsx misses, identity
        // falls through to null, and the renderer falls back to the raw
        // 6-hex peerId label. Surviving peers re-broadcast on mousemove
        // (~60Hz) so the visible roster recovers within a frame.
        setCursors({});
        setPeerPings({});
        lastPingSentAt = null;
        if (cancelled) return;
        reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
      teardownConnections();
    };
  }, [enabled, slug, createPeerConnection, closePeerConnection, handleOffer, handleAnswer, handleIce, initiateOffer]);

  // ---- Stream watchdog ---------------------------------------------------
  // Brings video/audio back when a peer connection silently dies after a
  // reload or spotty network. Symptoms: the relay still lists the
  // publication (other peers see "X is sharing camera"), but no
  // MediaStream ever arrives over WebRTC, leaving the tile stuck on
  // "waiting for stream…". The watchdog scans publications every
  // ${STREAM_WATCHDOG_INTERVAL_MS}ms; for any remote pub that's been
  // missing its stream for >${STREAM_WAIT_TIMEOUT_MS}ms, we rebuild the pc
  // to that publisher and re-issue an offer ourselves, with
  // ${STREAM_RECONNECT_BACKOFF_MS}ms backoff per peer so we don't spam.
  useEffect(() => {
    if (!enabled) return;
    const missingSince = new Map<string, number>();
    const lastAttempt = new Map<string, number>();
    const tick = () => {
      const meId = myIdRef.current;
      if (!meId) return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      const liveStreamIds = new Set<string>();
      for (const pub of publicationsRef.current) {
        if (pub.peerId === meId) continue;
        liveStreamIds.add(pub.streamId);
        if (remoteStreamsRef.current.has(pub.streamId)) {
          missingSince.delete(pub.streamId);
          continue;
        }
        // Publisher already gone — the relay will reap the pub shortly.
        if (!peersRef.current.some(p => p.id === pub.peerId)) {
          missingSince.delete(pub.streamId);
          continue;
        }
        let firstSeen = missingSince.get(pub.streamId);
        if (firstSeen == null) {
          firstSeen = now;
          missingSince.set(pub.streamId, firstSeen);
        }
        if (now - firstSeen < STREAM_WAIT_TIMEOUT_MS) continue;
        const lastTry = lastAttempt.get(pub.peerId) ?? 0;
        if (now - lastTry < STREAM_RECONNECT_BACKOFF_MS) continue;
        lastAttempt.set(pub.peerId, now);
        console.warn(
          "[mesh] stream watchdog: pub",
          pub.streamId,
          "from",
          pub.peerId,
          `missing for ${Math.round(now - firstSeen)}ms — rebuilding pc`,
        );
        closePeerConnection(pub.peerId);
        createPeerConnection(pub.peerId);
        void initiateOffer(pub.peerId);
      }
      // GC entries for pubs that no longer exist (publisher unpublished
      // or left); otherwise the map grows unbounded over a long session.
      for (const sid of missingSince.keys()) {
        if (!liveStreamIds.has(sid)) missingSince.delete(sid);
      }
    };
    const handle = setInterval(tick, STREAM_WATCHDOG_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [enabled, closePeerConnection, createPeerConnection, initiateOffer]);

  // Cursor broadcast at ~30 Hz. Spectator (god-mode) sessions skip the
  // broadcast entirely — they still render their own local slop cursor
  // so the operator can navigate, but other peers (and the OBS-captured
  // frame god-mode streams to the world) shouldn't see god-mode's
  // pointer overlaid on the live participants.
  const isSpectator = self?.spectator === true;
  useEffect(() => {
    if (!connected) return;
    if (isSpectator) return;
    let lastSent = 0;
    let lastX = -9999;
    let lastY = -9999;
    const handler = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastSent < CURSOR_THROTTLE_MS) return;
      if (Math.abs(e.clientX - lastX) < CURSOR_MIN_DELTA_PX && Math.abs(e.clientY - lastY) < CURSOR_MIN_DELTA_PX) {
        return;
      }
      lastSent = now;
      lastX = e.clientX;
      lastY = e.clientY;
      send({ type: "cursor", x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, [connected, isSpectator, send]);

  // Spectators (god-mode streaming sessions) stay in the internal
  // peers state so RTC signaling still wires them up — without that
  // the streaming box wouldn't receive any video/audio offers — but
  // every consumer of `peers` is a UI surface (WhosHere, PinnedPeers,
  // wallet/chess pickers, cursor lookups). Filtering once here keeps
  // the spectator off every display in one shot instead of bolting
  // `if (!p.spectator)` onto each callsite.
  const visiblePeers = useMemo(() => peers.filter(p => !p.spectator), [peers]);

  return {
    myId,
    peers: visiblePeers,
    connected,
    bootstrapped,
    remoteStreams,
    publications,
    slots,
    cursors,
    clicks,
    sendClick,
    browsers,
    avatars,
    hiddenAvatars,
    txRequests,
    chatMessages,
    sendChat,
    publish,
    unpublish,
    replaceTrack,
    updateSlot,
    openBrowser,
    navigateBrowser,
    closeBrowser,
    openWindowIds,
    openWindow,
    closeWindow,
    musicState,
    setMusicState,
    chessGame,
    chessHistory,
    aiPlayers,
    chessCreate,
    chessMove,
    chessResign,
    chessCloseGame,
    escrow,
    escrowFundResult,
    chessWagerPropose,
    chessWagerStart,
    escrowFund,
    escrowCancel,
    escrowClear,
    todos,
    todoAdd,
    todoToggle,
    todoUpdate,
    todoDelete,
    todoClearDone,
    todoReorder,
    notes,
    noteCreate,
    noteUpdate,
    noteDelete,
    glossary,
    glossaryAdd,
    glossaryRegenerate,
    glossaryDelete,
    gasState,
    tickerState,
    headlinesState,
    timelineState,
    chyronState,
    setChyron,
    godViewport,
    setGodViewport,
    latestTranscriptSeg,
    liveCaption,
    sendLiveCaption,
    sendLiveCaptionState,
    newsDigestState,
    files,
    deleteFile,
    musicGenres,
    musicGenre,
    setMusicGenre,
    musicCustom,
    addToMusicCustom,
    removeFromMusicCustom,
    reorderMusicCustom,
    clockState,
    setClockState,
    cardState,
    cardJob,
    cardTitle,
    setCardTitle,
    resetCard,
    researchState,
    researchLookup,
    researchStart,
    researchReset,
    leftclawState,
    leftclawStart,
    leftclawUpdate,
    leftclawDone,
    leftclawError,
    leftclawReset,
    leftclawClearHistory,
    tldrState,
    requestTldr,
    qrState,
    setQrPatch,
    pongState,
    myPongSeat,
    pongClaim,
    pongRelease,
    pongPaddle,
    pongReset,
    wormState,
    myWormSlot,
    wormClaim,
    wormRelease,
    wormSetDir,
    wormReset,
    previewMedia,
    setPreviewMedia,
    scrollSync,
    setScrollSync,
    uiState,
    setUIState,
    walletChat,
    walletChatSend,
    walletChatReset,
    broadcastTxRequest,
    incomingForwards,
    forwardTxToPeer,
    dismissIncomingForward,
    wallet,
    walletHistory,
    walletTxs,
    walletAttention,
    walletDraft,
    walletDraftUpdate,
    walletDeploy,
    walletAddDeployment,
    walletNewEpisode,
    walletProposeTx,
    walletSignTx,
    walletSetTxStatus,
    walletRemoveTx,
    walletResummarize,
    customNames,
    setCustomName,
    setCameraOff,
    peerPings,
  };
}
