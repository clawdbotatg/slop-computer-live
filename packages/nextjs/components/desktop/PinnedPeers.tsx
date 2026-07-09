"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import { useResolveWalletAddress } from "~~/components/ui/PasskeyWalletContext";
import { type Peer, peerLabel } from "~~/hooks/usePeerMesh";
import { usePeerPortfolios } from "~~/hooks/usePeerPortfolios";
import { formatUsd } from "~~/utils/usd";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Always-visible "who's here" panel pinned to the top-right of the
// viewport, sitting just under the menubar. Replaces the old
// (X guests ▾) dropdown that used to live in the menubar itself.
// Position is per-peer (fixed in viewport coords), not in the shared
// slot system — every viewer has their own top-right corner.
//
// Z-index sits between desktop icons (z=1) and the menubar
// dropdowns (9100), so a sign-out / power dropdown opening will
// naturally overlay the list. Windows can still cover it (windows
// can climb past 50), matching the trash can's behavior.

export type PinnedPeersProps = {
  peers: Peer[];
  myId: string | null;
  customNames: Record<string, string>;
  onSetCustomName: (name: string | null) => void;
  /** Stable ids (address or anonId, lowercased) whose owner has hidden
   *  their USD balance from the room. Absence = visible. */
  hiddenBalances: Record<string, boolean>;
  /** Toggle the local user's own balance visibility. Server-authoritative
   *  — broadcasts to every peer so the 👛 swap happens in lockstep. */
  onSetBalanceHidden: (hidden: boolean) => void;
  /** Relay-RTT (ms) per peer, from `usePeerMesh().peerPings`. Drives
   *  the small bar meter next to each name. Missing keys render as a
   *  gray "no signal" stack. */
  peerPings: Record<string, number>;
  /** Browser viewport per peer, from `usePeerMesh().peerViewports`.
   *  Rendered as a "1440×900" readout next to each guest when
   *  `showResolutions` is on; updates live as peers resize. */
  peerViewports: Record<string, { width: number; height: number }>;
  /** God-mode resolution readout gate — true for the host / god-mode
   *  viewer only, so regular guests don't get the extra clutter. */
  showResolutions: boolean;
  /** Room slug — scopes the relay portfolio fetch (Zerion proxy) that
   *  drives each guest's USD balance. */
  slug: string;
};

// 3-bar cell-signal style meter. Color + bar count step on relay RTT —
// thresholds chosen so a typical good connection lights up all three
// bars (most home/wired peers come back at <80ms) and a clearly bad
// connection (>500ms or no sample yet) reads as zero.
const PingMeter = ({ rtt }: { rtt: number | undefined }) => {
  let bars = 0;
  let color = "rgba(255,255,255,0.18)";
  let title = "no ping yet";
  if (typeof rtt === "number") {
    title = `${rtt} ms relay RTT`;
    if (rtt < 80) {
      bars = 3;
      color = "#7be88a";
    } else if (rtt < 200) {
      bars = 2;
      color = "#f5d76e";
    } else if (rtt < 500) {
      bars = 1;
      color = "#ff8a4d";
    } else {
      bars = 0;
      color = "#ff5c7a";
      title = `${rtt} ms — laggy`;
    }
  }
  const heights = [5, 8, 11];
  return (
    <span
      aria-label={title}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "flex-end",
        gap: 2,
        height: 11,
        flexShrink: 0,
        cursor: "help",
      }}
    >
      {heights.map((h, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: h,
            borderRadius: 1,
            background: i < bars ? color : "rgba(255,255,255,0.12)",
          }}
        />
      ))}
    </span>
  );
};

const MENUBAR_HEIGHT = 38;
const TOP_GAP = 10;
const MAX_NAME_LEN = 30;

// Lazy shared AudioContext for the join/leave chimes. Building it on
// first play (inside a user-gesture-adjacent event) keeps us out of
// autoplay-policy jail; reusing one ctx avoids the per-event GC churn
// of `new AudioContext()` per blip.
let chimeCtx: AudioContext | null = null;
const getChimeCtx = (): AudioContext | null => {
  if (typeof window === "undefined") return null;
  type Ctor = new () => AudioContext;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!C) return null;
  if (!chimeCtx) chimeCtx = new C();
  if (chimeCtx.state === "suspended") void chimeCtx.resume().catch(() => undefined);
  return chimeCtx;
};

// Short two-tone chirp. `up=true` rises (join), `up=false` falls
// (leave). Sine wave, gain envelope tuned so back-to-back chimes
// don't click.
const playChime = (up: boolean) => {
  const ctx = getChimeCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  const [f0, f1] = up ? [660, 990] : [550, 330];
  osc.frequency.setValueAtTime(f0, now);
  osc.frequency.exponentialRampToValueAtTime(f1, now + 0.09);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.16);
};

export const PinnedPeers = ({
  peers,
  myId,
  customNames,
  onSetCustomName,
  hiddenBalances,
  onSetBalanceHidden,
  peerPings,
  peerViewports,
  showResolutions,
  slug,
}: PinnedPeersProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const me = peers.find(p => p.id === myId) ?? null;
  // Same lookup key SlopAddress uses everywhere: address for
  // SIWE/passkey, anonId for anon. Whatever's currently in customNames
  // for that key is the name they're shown by.
  const myKey = (me?.address ?? me?.anonId)?.toLowerCase() ?? null;
  const myCurrentName = myKey ? (customNames[myKey] ?? "") : (me?.handle ?? "");
  // Anon users go through POST /auth/handle (peerNames keyed on anonId).
  // Address-having users go through the WS set_custom_name path
  // (peerNames keyed on address). Both end up writing to the same
  // customNames map on the client via the `peer_name` broadcast — so
  // the new name lights up across chat, transcript, peer list, etc.
  const isAnon = !!me && !me.address;
  const canEdit = !!me;

  // Each guest's total account value (USD), shown next to their name. We
  // resolve to the SAME spendable address SlopAddress displays (passkey →
  // personal wallet), then ask Zerion (via the relay proxy) for the whole
  // account's dollar value — not just native ETH. Anon peers have no address
  // → no balance. Keyed by lowercased resolved address.
  const resolveWalletAddress = useResolveWalletAddress();
  const peerBalanceAddr = useMemo(
    () => new Map(peers.map(p => [p.id, resolveWalletAddress(p.address) ?? null] as const)),
    [peers, resolveWalletAddress],
  );
  const portfolios = usePeerPortfolios(
    useMemo(() => [...peerBalanceAddr.values()], [peerBalanceAddr]),
    slug,
  );

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Blip on join, blop on leave. First render seeds the set silently —
  // otherwise rejoining a room with N guests would fire N chimes at
  // once. `myId` is excluded so your own appearance/disappearance
  // doesn't pop on your own machine.
  const prevIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const current = new Set(peers.filter(p => p.id !== myId).map(p => p.id));
    const prev = prevIdsRef.current;
    prevIdsRef.current = current;
    if (!prev) return;
    let joins = 0;
    let leaves = 0;
    for (const id of current) if (!prev.has(id)) joins++;
    for (const id of prev) if (!current.has(id)) leaves++;
    if (joins > 0) playChime(true);
    if (leaves > 0) playChime(false);
  }, [peers, myId]);

  const startEdit = () => {
    if (!canEdit) return;
    setDraft(myCurrentName);
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (isAnon) {
      if (!trimmed) return;
      void fetch(`${RELAY_BASE}/auth/handle`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: trimmed.slice(0, MAX_NAME_LEN) }),
      }).catch(() => {
        /* network blip — peerNames broadcast never lands, UI stays put */
      });
      return;
    }
    onSetCustomName(trimmed === "" ? null : trimmed.slice(0, MAX_NAME_LEN));
  };

  const cancel = () => setEditing(false);

  return (
    <div
      style={{
        position: "fixed",
        top: MENUBAR_HEIGHT + TOP_GAP,
        right: 14,
        zIndex: 50,
        minWidth: 260,
        maxWidth: 380,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: "linear-gradient(180deg, rgba(20,10,40,0.92) 0%, rgba(6,3,13,0.92) 100%)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,62,201,0.45)",
        borderRadius: 8,
        boxShadow: "0 8px 24px #000a, 0 0 16px rgba(255,62,201,0.18)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        fontSize: 12,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--slop-text-muted)",
          paddingBottom: 4,
          borderBottom: "1px solid rgba(255,62,201,0.18)",
        }}
      >
        {peers.length} guest{peers.length === 1 ? "" : "s"}
      </div>
      {peers.length === 0 ? (
        <div style={{ color: "var(--slop-text-muted)", fontStyle: "italic", padding: "4px 2px" }}>just you so far.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {peers.map(p => {
            const isMe = p.id === myId;
            const showEditor = isMe && editing;
            const balAddr = peerBalanceAddr.get(p.id);
            const usd = balAddr ? portfolios[balAddr.toLowerCase()] : undefined;
            // Balance-visibility is keyed by the guest's stable id (their
            // own address/anonId), NOT the resolved balance address — same
            // key the relay flips when this guest toggles their own flag.
            const stableKey = (p.address ?? p.anonId)?.toLowerCase() ?? null;
            const balanceHidden = stableKey ? !!hiddenBalances[stableKey] : false;
            return (
              <li
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 4,
                  background: isMe ? "rgba(255,62,201,0.14)" : "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.04)",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    flex: 1,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    fontWeight: p.role === "host" ? 600 : undefined,
                  }}
                >
                  {showEditor ? (
                    <input
                      ref={inputRef}
                      className="slop-textfield"
                      value={draft}
                      maxLength={MAX_NAME_LEN}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancel();
                        }
                      }}
                      onBlur={commit}
                      placeholder={peerLabel(p, customNames)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12,
                        padding: "2px 4px",
                      }}
                    />
                  ) : (
                    <>
                      <SlopAddress
                        address={p.address}
                        handle={p.handle}
                        anonId={p.anonId}
                        fallback={p.id}
                        customNames={customNames}
                      />
                      {isMe && canEdit ? (
                        <button
                          type="button"
                          onClick={startEdit}
                          aria-label="edit name"
                          title="edit your name"
                          style={{
                            background: "transparent",
                            border: 0,
                            cursor: "pointer",
                            padding: 0,
                            margin: "0 0 0 2px",
                            lineHeight: 1,
                            fontSize: 11,
                          }}
                        >
                          ✏️
                        </button>
                      ) : null}
                    </>
                  )}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  {balAddr ? (
                    balanceHidden ? (
                      // Hidden by its owner — everyone sees a 👛 instead of
                      // the dollar amount. Only the owner can click to reveal.
                      <span
                        role={isMe ? "button" : undefined}
                        tabIndex={isMe ? 0 : undefined}
                        onClick={isMe ? () => onSetBalanceHidden(false) : undefined}
                        onKeyDown={
                          isMe
                            ? e => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onSetBalanceHidden(false);
                                }
                              }
                            : undefined
                        }
                        title={isMe ? "your balance is hidden — click to show it" : "balance hidden"}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          fontSize: 11,
                          lineHeight: 1,
                          cursor: isMe ? "pointer" : "default",
                          userSelect: "none",
                        }}
                      >
                        👛
                      </span>
                    ) : (
                      <span
                        role={isMe ? "button" : undefined}
                        tabIndex={isMe ? 0 : undefined}
                        onClick={isMe ? () => onSetBalanceHidden(true) : undefined}
                        onKeyDown={
                          isMe
                            ? e => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onSetBalanceHidden(true);
                                }
                              }
                            : undefined
                        }
                        title={
                          isMe
                            ? "click to hide your balance from the room"
                            : usd != null
                              ? `${formatUsd(usd)} total account value (Zerion)`
                              : "loading balance…"
                        }
                        style={{
                          display: "inline-flex",
                          alignItems: "baseline",
                          color: usd && usd > 0 ? "#7be88a" : "var(--slop-text-muted)",
                          fontSize: 10,
                          fontFamily: "var(--slop-font-display)",
                          fontVariantNumeric: "tabular-nums",
                          letterSpacing: "0.04em",
                          cursor: isMe ? "pointer" : "default",
                          userSelect: isMe ? "none" : undefined,
                        }}
                      >
                        {usd != null ? formatUsd(usd) : "…"}
                      </span>
                    )
                  ) : null}
                  {showResolutions && peerViewports[p.id] ? (
                    // God-mode resolution readout — this guest's browser
                    // viewport, live-updated as they resize their window.
                    <span
                      title="browser viewport (innerWidth × innerHeight)"
                      style={{
                        color: "var(--slop-text-muted)",
                        fontSize: 10,
                        fontFamily: "var(--slop-font-display)",
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: "0.04em",
                        cursor: "help",
                      }}
                    >
                      {peerViewports[p.id]!.width}×{peerViewports[p.id]!.height}
                    </span>
                  ) : null}
                  <PingMeter rtt={peerPings[p.id]} />
                  <span
                    style={{
                      color: "var(--slop-text-muted)",
                      fontSize: 10,
                      fontFamily: "var(--slop-font-display)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    {p.role}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default PinnedPeers;
