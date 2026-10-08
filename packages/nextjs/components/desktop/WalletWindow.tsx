"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address, AddressInput } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex, formatEther } from "viem";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "viem/chains";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignTypedData,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseWedgieId } from "~~/components/desktop/WedgieAppWindow";
import { ClearSignPanel } from "~~/components/desktop/wallet/ClearSignPanel";
import { TokenAvatar } from "~~/components/desktop/wallet/TokenAvatar";
import { WalletAssetsPanel } from "~~/components/desktop/wallet/WalletAssetsPanel";
import { WalletChatPanel } from "~~/components/desktop/wallet/WalletChatPanel";
import { WalletHeader } from "~~/components/desktop/wallet/WalletHeader";
import type { Portfolio } from "~~/components/desktop/wallet/types";
import { Button, LoadingBar, SlopAddress, TextField } from "~~/components/ui";
import type { Peer, PeerMeshState, WalletRecord, WalletTx } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";
import { useSyncedUIState } from "~~/hooks/useSyncedUIState";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { robinhood } from "~~/scaffold.config";
import { getStoredPasskeyIdentity, signSafeTxWithPasskey } from "~~/utils/passkey";
import { SAFE_CHAIN_IDS, type SafeTx, cancelTx, passkeyOwner, safeTxHash, safeTxTypedData } from "~~/utils/safe";
import { wedgieSupported, withWedgie } from "~~/utils/wedgie";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// One resolved deploy-time signer slot. Carries everything needed to
// build both the `createMultisig` args (EOA address vs passkey qx/qy/
// credentialIdHash) and the WalletRecord.signers entry for the relay.
// Passkey fields are populated by looking up peer.passkey (for remote
// passkey peers) or local storage (for the local passkey user).
type ResolvedSigner = {
  address: AddressType;
  label: string;
  signerType: "eoa" | "passkey" | "erc1271";
  qx?: `0x${string}`;
  qy?: `0x${string}`;
  credentialIdHash?: `0x${string}`;
  device?: "wedgie";
};

// A wedgie can never be enough on its own (prototype firmware): with one,
// at least 2 signatures, and the other owners must reach that alone.
// Mirrors the relay's wedgieRuleError.
const wedgieRuleMsg = (owners: { device?: string }[], threshold: number): string | null => {
  const w = owners.filter(o => o.device === "wedgie").length;
  if (w === 0) return null;
  if (threshold < 2) return "With a wedgie, at least 2 signatures must be needed.";
  if (owners.length - w < threshold) return "The non-wedgie owners must be able to reach the threshold on their own.";
  return null;
};

// The AI wallet (assets + chat) used to be an <iframe> of
// wallet.slop.computer. It's now native: the conversational engine runs
// on the relay (wallet-chat / wallet-intent) and the chat is shared
// across the whole room via mesh.walletChat. The Chat tab is the
// conversation; the Assets tab is the read-only portfolio/activity view.

export type WalletWindowProps = {
  mesh: PeerMeshState;
  myAddress: string | null;
  myHandle: string | null;
  /** Push the latest total USD balance up to the desktop so the
   *  menubar chip stays in sync with this window's portfolio — fires
   *  on every successful refresh (manual, tx-driven, focus). Only ever
   *  reports non-null totals so a mid-refetch null doesn't blank the
   *  menubar. */
  onBalanceUsd?: (usd: string) => void;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The chains the app knows (labels + explorers). Which ones a Safe lives on
// is SAFE_CHAIN_IDS (utils/safe.ts).
// Order matters for the UI — cheap chains first since they're
// the recommended default. Adding a new chain here lights up a new row
// in the deploy grid and a new option in the activity picker — provided
// it's also in `scaffold.config.ts` `targetNetworks`.
const SUPPORTED_CHAINS = [
  { id: base.id, label: "Base", explorer: "https://basescan.org" },
  { id: gnosis.id, label: "Gnosis", explorer: "https://gnosisscan.io" },
  { id: arbitrum.id, label: "Arbitrum", explorer: "https://arbiscan.io" },
  { id: optimism.id, label: "Optimism", explorer: "https://optimistic.etherscan.io" },
  { id: polygon.id, label: "Polygon", explorer: "https://polygonscan.com" },
  { id: robinhood.id, label: "Robinhood", explorer: "https://robinhoodchain.blockscout.com" },
  { id: mainnet.id, label: "Ethereum", explorer: "https://etherscan.io" },
] as const;

const chainMeta = (chainId: number) =>
  SUPPORTED_CHAINS.find(c => c.id === chainId) ?? {
    id: chainId,
    label: `chain ${chainId}`,
    explorer: "https://etherscan.io",
  };

type WalletTab = "deploy" | "chat" | "assets" | "transactions";

// Per-browser memory of the last wallet tab this user viewed. The window
// fully unmounts when closed (SharedAppWindow renders null), so reopening
// re-derives the fallback unless we remember where they were. Local, not
// multiplayer — the shared ui_state still wins once anyone explicitly picks.
const WALLET_TAB_KEY = "slop:wallet:tab";
const readSavedTab = (): WalletTab | null => {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(WALLET_TAB_KEY);
    return v === "chat" || v === "assets" || v === "transactions" ? v : null;
  } catch {
    return null;
  }
};

export const WalletWindow = ({ mesh, myAddress, myHandle, onBalanceUsd }: WalletWindowProps) => {
  const wallet = mesh.wallet;
  // Restore the tab this browser last viewed (read once on mount). Used only
  // to seed the fallback below — never overrides an explicit shared pick.
  const [savedTab] = useState<WalletTab | null>(readSavedTab);
  // Which tab is showing is multiplayer: pick a tab and every peer's
  // wallet follows (last-writer-wins via the relay's ui_state channel).
  // `fallback` is what everyone sees until anyone picks — deploy if there's
  // no wallet yet; else the tab this browser last had open (so closing and
  // reopening returns you to your spot — e.g. Chat); else transactions when
  // a tx is waiting in the queue so the signing UI is right there; else chat.
  const tabFallback: WalletTab = !wallet
    ? "deploy"
    : savedTab
      ? savedTab
      : mesh.walletTxs.some(t => t.status === "pending")
        ? "transactions"
        : "chat";
  const [tab, setTab] = useSyncedUIState<WalletTab>(mesh, "wallet:tab", tabFallback);

  // Remember the tab across window close/reopen (per browser). Skip "deploy" —
  // that's a no-wallet state, not a place the user chose to be.
  useEffect(() => {
    if (tab !== "deploy" && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(WALLET_TAB_KEY, tab);
      } catch {
        /* private mode / quota — non-fatal */
      }
    }
  }, [tab]);

  // Auto-switch to Chat the first time a wallet shows up (initial
  // deploy) — the conversation is the headline. Don't yank the user
  // back if they archive — they explicitly hit "new episode".
  useEffect(() => {
    if (wallet && tab === "deploy") {
      const justDeployed = Date.now() - wallet.createdAt < 8_000;
      if (justDeployed) setTab("chat");
    }
    if (!wallet && tab !== "deploy") setTab("deploy");
  }, [wallet, tab, setTab]);

  // Auto-jump to the Transactions tab whenever a new pending signature
  // appears — this is the spot where the user *acts*, so don't make
  // them go hunting for it after a tx is captured from the AI wallet
  // iframe or a SharedBrowser dapp. We track the count, not identity,
  // so dismissing one and a new one arriving still triggers.
  const pendingCount = useMemo(() => mesh.walletTxs.filter(t => t.status === "pending").length, [mesh.walletTxs]);
  const lastPendingCountRef = useRef(pendingCount);
  // Multiplayer scroll sync for each tab. Per-tab keys so flipping
  // tabs doesn't fight a different surface's scroll position.
  const deployRef = useRef<HTMLDivElement>(null);
  const assetsRef = useRef<HTMLDivElement>(null);
  const txsRef = useRef<HTMLDivElement>(null);
  const onDeployScroll = useSyncedScroll(mesh, "wallet:deploy", deployRef);
  const onAssetsScroll = useSyncedScroll(mesh, "wallet:assets", assetsRef);
  const onTxsScroll = useSyncedScroll(mesh, "wallet:transactions", txsRef);
  useEffect(() => {
    if (pendingCount > lastPendingCountRef.current && wallet && tab !== "deploy") {
      setTab("transactions");
    }
    lastPendingCountRef.current = pendingCount;
  }, [pendingCount, wallet, tab, setTab]);

  // Server pings `walletAttention` on every propose, including the
  // deduped second-click case where pendingCount didn't change. Mirror
  // the tab-jump for that path so a re-click still surfaces the
  // transactions tab.
  const walletAttention = mesh.walletAttention;
  const lastAttentionRef = useRef(walletAttention?.at ?? 0);
  useEffect(() => {
    const at = walletAttention?.at ?? 0;
    if (at > lastAttentionRef.current && wallet && tab !== "deploy") {
      setTab("transactions");
    }
    lastAttentionRef.current = at;
  }, [walletAttention, wallet, tab, setTab]);

  // Portfolio state is hoisted up here from WalletAssetsPanel so the
  // sticky header above the tabs can show the balance + drive a
  // refresh, and the same fetch result powers the Assets tab list and
  // the send-all batch builder. One fetch shared across three readers.
  const slug = useRoomSlug();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  const refreshPortfolio = useCallback(async () => {
    if (!wallet) return;
    setPortfolioLoading(true);
    setPortfolioError(null);
    try {
      const res = await fetch(withSlug(`${RELAY_HTTP}/v1/wallet/portfolio?address=${wallet.address}`, slug), {
        credentials: "include",
      });
      if (res.ok) setPortfolio((await res.json()) as Portfolio);
      else setPortfolioError(`portfolio: relay ${res.status}`);
    } catch (err) {
      setPortfolioError(`network error: ${String(err).slice(0, 160)}`);
    } finally {
      setPortfolioLoading(false);
    }
  }, [wallet, slug]);

  // Keep the menubar balance chip in lockstep with this window's
  // portfolio: every time we land a fresh total, push it up. Guard on
  // non-null so the transient null during an address-change refetch
  // (below) doesn't blank the menubar — Desktop clears it on its own
  // when the wallet undeploys.
  useEffect(() => {
    if (portfolio) onBalanceUsd?.(portfolio.totalBalanceUsd);
  }, [portfolio, onBalanceUsd]);

  // Reset + refetch when the Safe address changes (new episode /
  // first deploy). Clearing the prior result avoids the header briefly
  // showing the old wallet's balance during the new fetch.
  const walletAddress = wallet?.address ?? null;
  useEffect(() => {
    if (!walletAddress) {
      setPortfolio(null);
      setPortfolioError(null);
      return;
    }
    setPortfolio(null);
    void refreshPortfolio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // Auto-refresh balances when any tx transitions to "executed". The
  // first walletTxs pass after wallet load just seeds the baseline —
  // we only refresh on genuinely new executions, not historical ones
  // that were already in the list at mount time.
  //
  // Timing: portfolio data comes from Zerion, which crawls chain
  // state with a ~5-15s lag. An immediate refresh after `executed`
  // almost always returns pre-tx balances and looks like nothing
  // happened. We schedule TWO passes — 5s (catches Base/Mainnet
  // fast cases) and 15s (catches slower indexer paths) — so the
  // user sees the new state without manually pulling refresh.
  const executedTxIdsRef = useRef<Set<string> | null>(null);
  const pendingRefreshTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Schedule one or more delayed portfolio refreshes (used to wait out
  // Zerion's indexer lag after balances change). Timers are tracked so
  // a wallet swap / unmount can cancel any still in flight.
  const schedulePortfolioRefresh = useCallback(
    (delaysMs: number[]) => {
      for (const delayMs of delaysMs) {
        const handle = setTimeout(() => {
          pendingRefreshTimersRef.current.delete(handle);
          void refreshPortfolio();
        }, delayMs);
        pendingRefreshTimersRef.current.add(handle);
      }
    },
    [refreshPortfolio],
  );
  useEffect(() => {
    executedTxIdsRef.current = null;
    // Drop any timers from the previous wallet — they'd refresh
    // against the new wallet's address with stale baseline state.
    for (const t of pendingRefreshTimersRef.current) clearTimeout(t);
    pendingRefreshTimersRef.current.clear();
  }, [walletAddress]);
  useEffect(() => {
    if (!walletAddress) return;
    const current = new Set<string>();
    for (const t of mesh.walletTxs) {
      if (t.status === "executed") current.add(t.id);
    }
    if (executedTxIdsRef.current === null) {
      executedTxIdsRef.current = current;
      return;
    }
    let hasNew = false;
    for (const id of current) {
      if (!executedTxIdsRef.current.has(id)) {
        hasNew = true;
        break;
      }
    }
    executedTxIdsRef.current = current;
    // A tx just executed — pull a few times to ride out Zerion's indexer
    // lag. This (plus the tip-landed cascade below) is now the PRIMARY way
    // balances stay fresh, since we no longer poll tightly in the
    // background — so cover immediate + short + long indexer delays.
    if (hasNew) schedulePortfolioRefresh([0, 5_000, 15_000, 30_000]);
  }, [mesh.walletTxs, walletAddress, schedulePortfolioRefresh]);

  // A spectator tip just flew into the vault. Tips are incoming transfers
  // — they never show up in mesh.walletTxs (those are Safe-initiated)
  // — so the executed-tx refresh above won't catch them. Pull immediately
  // when the card lands (catches already-indexed / fast chains), then at
  // 5s and 15s to cover Zerion's indexer lag.
  useEffect(() => {
    if (!walletAddress) return;
    const onTipLanded = () => schedulePortfolioRefresh([0, 5_000, 15_000, 30_000]);
    window.addEventListener("slop-tip-landed", onTipLanded);
    return () => window.removeEventListener("slop-tip-landed", onTipLanded);
  }, [walletAddress, schedulePortfolioRefresh]);
  // Cancel any in-flight refresh timers when the window unmounts so
  // we don't fire setState into a torn-down component.
  useEffect(() => {
    const timers = pendingRefreshTimersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Lazy background refresh while the wallet window is open, mostly a
  // safety net for slow idle drift. We deliberately DON'T poll tightly:
  // Zerion quota is precious and each refresh fans out to 3 Zerion calls.
  // Balances get pulled on mount, on tx execution (see the cascades above),
  // and whenever the user hits the refresh button — so 5min here just
  // catches passive drift (price moves, incoming transfers we didn't see).
  // Skipped when the tab is hidden so backgrounded clients cost nothing.
  useEffect(() => {
    if (!walletAddress) return;
    const handle = setInterval(() => {
      if (document.visibilityState === "visible") void refreshPortfolio();
    }, 300_000);
    return () => clearInterval(handle);
  }, [walletAddress, refreshPortfolio]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        overflow: "hidden",
      }}
    >
      {wallet ? (
        <WalletHeader
          wallet={wallet}
          mesh={mesh}
          portfolio={portfolio}
          loading={portfolioLoading}
          onRefresh={() => void refreshPortfolio()}
        />
      ) : null}
      <TabBar tab={tab} setTab={setTab} walletReady={!!wallet} pendingCount={pendingCount} />
      {/* Deploy tab body. */}
      <div
        ref={deployRef}
        onScroll={onDeployScroll}
        style={{ flex: 1, overflow: "auto", display: tab === "deploy" ? "block" : "none" }}
      >
        <DeployTab mesh={mesh} myAddress={myAddress} myHandle={myHandle} />
      </div>
      {/* Chat tab — the multiplayer AI-wallet conversation. Always
       *  mounted when a wallet exists so the message list keeps its
       *  scroll position across tab flips; hidden when not active. */}
      {wallet ? (
        <div
          style={{
            flex: tab === "chat" ? 1 : undefined,
            display: tab === "chat" ? "flex" : "none",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <WalletChatPanel mesh={mesh} wallet={wallet} />
        </div>
      ) : null}
      {/* Assets tab — read-only portfolio + activity for the Safe. */}
      {wallet ? (
        <div
          ref={assetsRef}
          onScroll={onAssetsScroll}
          style={{
            flex: tab === "assets" ? 1 : undefined,
            display: tab === "assets" ? "block" : "none",
            overflow: "auto",
          }}
        >
          <WalletAssetsPanel
            wallet={wallet}
            mesh={mesh}
            portfolio={portfolio}
            loading={portfolioLoading}
            error={portfolioError}
          />
        </div>
      ) : null}
      {/* Transactions tab body — dedicated to the Safe queue (txs
       *  proposed from the wallet chat, SharedBrowser dapps, or future
       *  in-app send forms all land here for signing + execute). */}
      {wallet ? (
        <div
          ref={txsRef}
          onScroll={onTxsScroll}
          style={{
            flex: tab === "transactions" ? 1 : undefined,
            display: tab === "transactions" ? "block" : "none",
            overflow: "auto",
          }}
        >
          <ActivityTxQueue mesh={mesh} wallet={wallet} myAddress={myAddress} />
        </div>
      ) : null}
    </div>
  );
};

// ============================================================================
// Tab bar
// ============================================================================

const TabBar = ({
  tab,
  setTab,
  walletReady,
  pendingCount,
}: {
  tab: WalletTab;
  setTab: (t: WalletTab) => void;
  walletReady: boolean;
  pendingCount: number;
}) => {
  const tabStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "10px 12px",
    background: active ? "rgba(255,62,201,0.12)" : "transparent",
    border: 0,
    borderBottom: active ? "2px solid var(--slop-magenta, #ff3ec9)" : "2px solid transparent",
    color: disabled ? "var(--slop-text-muted)" : active ? "var(--slop-text)" : "var(--slop-text-muted)",
    fontFamily: "var(--slop-font-display)",
    fontSize: 11,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  });
  const tabs: { id: WalletTab; label: string }[] = [
    { id: "deploy", label: "Deploy" },
    { id: "chat", label: "Chat" },
    { id: "assets", label: "Assets" },
    { id: "transactions", label: "Transactions" },
  ];
  return (
    <div
      style={{
        display: "flex",
        borderBottom: "1px solid rgba(255,62,201,0.18)",
        background: "rgba(0,0,0,0.3)",
      }}
    >
      {tabs.map(t => {
        const disabled = t.id !== "deploy" && !walletReady;
        const showBadge = t.id === "transactions" && pendingCount > 0;
        return (
          <button
            key={t.id}
            type="button"
            style={tabStyle(tab === t.id, disabled)}
            disabled={disabled}
            title={disabled ? "Deploy a wallet first to unlock this tab." : undefined}
            onClick={() => !disabled && setTab(t.id)}
          >
            <span>{t.label}</span>
            {showBadge ? (
              <span
                aria-label={`${pendingCount} pending`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 18,
                  height: 16,
                  padding: "0 5px",
                  borderRadius: 8,
                  background: "var(--slop-magenta, #ff3ec9)",
                  color: "#06030d",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0,
                }}
              >
                {pendingCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
};

// ============================================================================
// Deploy tab — signer form (initial) + chain grid (always)
// ============================================================================

type DeployProps = {
  mesh: PeerMeshState;
  myAddress: string | null;
  myHandle: string | null;
};

const DeployTab = ({ mesh, myAddress, myHandle }: DeployProps) => {
  const slug = useRoomSlug();
  const existing = mesh.wallet;

  // Only the host creates the Safe (the relay pays; this just keeps one
  // person in charge of the owner list). Non-hosts see a disabled button.
  const isHost = useMemo(
    () => (mesh.peers as Peer[]).some(p => p.id === mesh.myId && p.role === "host"),
    [mesh.peers, mesh.myId],
  );

  // Collaborative draft: shared across all peers via the relay. Local
  // edits push a full snapshot through mesh.walletDraftUpdate; inbound
  // updates land in mesh.walletDraft. We don't keep a local mirror —
  // the relay roundtrip is sub-100ms so typing feels immediate.
  const draft = mesh.walletDraft;
  const draftOrDefault = useMemo(
    () =>
      draft ?? { selected: {}, threshold: 1, label: slug, customSigners: [] as { address: string; label: string }[] },
    [draft, slug],
  );

  const updateDraft = useCallback(
    (patch: Partial<typeof draftOrDefault>) => {
      mesh.walletDraftUpdate({ ...draftOrDefault, ...patch });
    },
    [draftOrDefault, mesh],
  );

  type Candidate = {
    address: string;
    label: string;
    isMe: boolean;
    source: "peer" | "me" | "custom";
    /** Present for passkey signers — the local user's own (from
     *  storage) or a remote passkey peer's (from peer.passkey). */
    passkey?: { qx: string; qy: string; credentialIdHash: string };
    /** A wedgie someone plugged in (Wedgie app); address = its signer contract. */
    wedgie?: { x: string; y: string };
  };
  const candidateSigners = useMemo<Candidate[]>(() => {
    const out = new Map<string, Candidate>();
    for (const p of mesh.peers as Peer[]) {
      if (!p.address) continue;
      const lower = p.address.toLowerCase();
      const custom = mesh.customNames[lower];
      out.set(lower, {
        address: lower,
        label: custom ?? p.handle ?? short(p.address),
        isMe: p.id === mesh.myId,
        source: "peer",
        ...(p.passkey ? { passkey: p.passkey } : {}),
      });
    }
    if (myAddress) {
      const lower = myAddress.toLowerCase();
      const custom = mesh.customNames[lower];
      // Fall back to localStorage for the local user — peer.passkey is
      // only populated for OTHER passkey peers when the relay
      // re-broadcasts them; the local user's own pubkey lives in
      // `slop:passkey:identity:<addr>` after a successful /auth/passkey.
      const localPasskey = getStoredPasskeyIdentity(lower);
      const ex = out.get(lower);
      const merged: Candidate = ex
        ? { ...ex, isMe: true, ...(ex.passkey ? {} : localPasskey ? { passkey: localPasskey } : {}) }
        : {
            address: lower,
            label: custom ?? myHandle ?? short(myAddress),
            isMe: true,
            source: "me",
            ...(localPasskey ? { passkey: localPasskey } : {}),
          };
      out.set(lower, merged);
    }
    // Wedgies people have connected in their Wedgie app.
    for (const [peerId, w] of Object.entries(mesh.peerWedgies)) {
      const lower = passkeyOwner(w.x as `0x${string}`, w.y as `0x${string}`).toLowerCase();
      const p = (mesh.peers as Peer[]).find(x => x.id === peerId);
      const who =
        peerId === mesh.myId
          ? "your"
          : `${(p?.address && mesh.customNames[p.address.toLowerCase()]) ?? p?.handle ?? (p?.address ? short(p.address) : "a")}'s`;
      out.set(lower, { address: lower, label: `${who} wedgie`, isMe: false, source: "peer", wedgie: w });
    }
    for (const c of draftOrDefault.customSigners) {
      const lower = c.address.toLowerCase();
      if (!out.has(lower)) out.set(lower, { address: lower, label: c.label, isMe: false, source: "custom" });
    }
    return Array.from(out.values()).sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      const rank = (s: Candidate["source"]) => (s === "me" ? 0 : s === "peer" ? 1 : 2);
      return rank(a.source) - rank(b.source);
    });
  }, [mesh.peers, mesh.myId, mesh.peerWedgies, myAddress, myHandle, draftOrDefault.customSigners, mesh.customNames]);

  // First-touch seed: when no draft exists yet AND we have at least one
  // candidate, publish a sensible default (everyone selected, majority
  // threshold). Only one peer needs to do this — first-write wins; the
  // others' subsequent renders will see the draft and skip the seed.
  useEffect(() => {
    if (existing) return;
    if (draft) return;
    if (candidateSigners.length === 0) return;
    const selected: Record<string, boolean> = {};
    for (const c of candidateSigners) selected[c.address] = true;
    mesh.walletDraftUpdate({
      selected,
      threshold: Math.max(1, Math.ceil(candidateSigners.length / 2)),
      label: slug,
      customSigners: [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, candidateSigners.length, existing]);

  const selectedSigners = useMemo(
    () => candidateSigners.filter(s => draftOrDefault.selected[s.address]),
    [candidateSigners, draftOrDefault.selected],
  );

  const effectiveLabel = existing ? existing.label : draftOrDefault.label;
  // Rich signer set used by both the `createMultisig` call (partition
  // into EOA vs passkey arrays) and the WalletRecord we hand the relay
  // post-deploy. For an already-deployed wallet we trust the persisted
  // record verbatim; pre-deploy we resolve from the candidate list +
  // peer/local-storage passkey lookup.
  const effectiveSigners = useMemo<ResolvedSigner[]>(() => {
    if (existing) {
      return existing.signers.map(s => ({
        address: s.address as AddressType,
        label: s.label,
        signerType: s.signerType,
        ...(s.qx ? { qx: s.qx as `0x${string}` } : {}),
        ...(s.qy ? { qy: s.qy as `0x${string}` } : {}),
        ...(s.credentialIdHash ? { credentialIdHash: s.credentialIdHash as `0x${string}` } : {}),
      }));
    }
    return selectedSigners.map(s => {
      const base: ResolvedSigner = {
        address: s.address as AddressType,
        label: s.label,
        signerType: s.passkey || s.wedgie ? "passkey" : "eoa",
      };
      if (s.wedgie) {
        base.qx = s.wedgie.x as `0x${string}`;
        base.qy = s.wedgie.y as `0x${string}`;
        base.device = "wedgie";
      }
      if (s.passkey) {
        base.qx = s.passkey.qx as `0x${string}`;
        base.qy = s.passkey.qy as `0x${string}`;
        base.credentialIdHash = s.passkey.credentialIdHash as `0x${string}`;
      }
      return base;
    });
  }, [existing, selectedSigners]);
  const effectiveThreshold = existing ? existing.threshold : draftOrDefault.threshold;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      {existing ? (
        <>
          <DeployedSummary
            wallet={existing}
            customNames={mesh.customNames}
            myAddress={myAddress}
            onArchive={() => mesh.walletNewEpisode()}
          />
          <SafeOwners wallet={existing} candidates={candidateSigners} customNames={mesh.customNames} />
        </>
      ) : (
        <>
          <div>
            <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", letterSpacing: "0.08em" }}>
              Create the Bank Safe
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--slop-text-muted)" }}>
              Create a Safe for this episode. Pick its owners and how many must sign. It goes on every chain at once,
              same address everywhere.
            </p>
          </div>

          {!isHost ? (
            <div
              style={{
                fontSize: 11,
                color: "var(--slop-text-muted)",
                padding: "6px 10px",
                background: "rgba(255,62,201,0.06)",
                border: "1px dashed rgba(255,62,201,0.25)",
                borderRadius: 4,
                lineHeight: 1.5,
              }}
            >
              Only the host can change the label, signers, and threshold — you&apos;re seeing what they&apos;re
              building.
            </div>
          ) : null}

          <Field label="Episode label">
            <TextField
              value={draftOrDefault.label}
              onChange={e => updateDraft({ label: e.target.value })}
              placeholder={slug}
              disabled={!isHost}
              title={!isHost ? "Only the host can change this." : undefined}
            />
          </Field>

          <Field label={`Signers (${selectedSigners.length})`}>
            {candidateSigners.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--slop-text-muted)", fontStyle: "italic", marginBottom: 6 }}>
                no guests with wallet addresses yet — type one below or wait for a peer to sign in
              </div>
            ) : (
              <ul
                style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}
              >
                {candidateSigners.map(s => (
                  <li
                    key={s.address}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,62,201,0.18)",
                      borderRadius: 4,
                      opacity: isHost ? 1 : 0.85,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!draftOrDefault.selected[s.address]}
                      disabled={!isHost}
                      title={!isHost ? "Only the host can change signers." : undefined}
                      onChange={e =>
                        updateDraft({
                          selected: { ...draftOrDefault.selected, [s.address]: e.target.checked },
                        })
                      }
                    />
                    <span
                      style={{
                        flex: 1,
                        fontSize: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                      }}
                    >
                      {s.wedgie ? (
                        <WedgieTag label={s.label} />
                      ) : (
                        <SlopAddress address={s.address} customNames={mesh.customNames} />
                      )}
                      {s.isMe ? <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>(you)</span> : null}
                      {s.passkey ? (
                        <span
                          style={{ color: "var(--slop-text-muted)", fontSize: 10 }}
                          title="passkey signer address — do not send funds here"
                        >
                          · passkey ({short(s.address)})
                        </span>
                      ) : null}
                      {s.source === "custom" ? (
                        <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>· added</span>
                      ) : null}
                    </span>
                    {s.source === "custom" && isHost ? (
                      <button
                        type="button"
                        aria-label="remove"
                        title="remove this signer"
                        onClick={() => {
                          const nextSelected = { ...draftOrDefault.selected };
                          delete nextSelected[s.address];
                          updateDraft({
                            customSigners: draftOrDefault.customSigners.filter(
                              c => c.address.toLowerCase() !== s.address,
                            ),
                            selected: nextSelected,
                          });
                        }}
                        style={{
                          background: "transparent",
                          border: 0,
                          color: "var(--slop-text-muted)",
                          fontSize: 14,
                          cursor: "pointer",
                          padding: "0 4px",
                        }}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <AddSignerRow
              disabled={!isHost}
              existing={new Set(candidateSigners.map(s => s.address))}
              onAdd={addr => {
                const lower = addr.toLowerCase();
                const exists = draftOrDefault.customSigners.some(c => c.address.toLowerCase() === lower);
                updateDraft({
                  customSigners: exists
                    ? draftOrDefault.customSigners
                    : [...draftOrDefault.customSigners, { address: lower, label: short(lower) }],
                  selected: { ...draftOrDefault.selected, [lower]: true },
                });
              }}
            />
          </Field>

          <Field label={`Threshold (${draftOrDefault.threshold} of ${selectedSigners.length || 0})`}>
            <input
              type="range"
              min={1}
              max={Math.max(1, selectedSigners.length)}
              value={draftOrDefault.threshold}
              disabled={!isHost || selectedSigners.length === 0}
              title={!isHost ? "Only the host can change the threshold." : undefined}
              onChange={e => updateDraft({ threshold: parseInt(e.target.value, 10) })}
              style={{ width: "100%" }}
            />
          </Field>
        </>
      )}

      <Section title="Networks">
        <p style={{ fontSize: 11, color: "var(--slop-text-muted)", margin: "0 0 8px" }}>
          A Safe, on all 6 chains at once, same address everywhere. slop.computer pays the gas.
          {!isHost ? " Only the host can create it." : null}
        </p>
        <SafeChains
          existing={existing}
          signers={effectiveSigners}
          threshold={effectiveThreshold}
          label={effectiveLabel}
          canDeploy={isHost}
        />
      </Section>
    </div>
  );
};

// ============================================================================
// SafeOwners — add (room member or wedgie) / remove owners, change threshold.
// The relay queues one Safe tx per chain; they're signed + executed like any
// other tx in the Transactions tab.
// ============================================================================

const SafeOwners = ({
  wallet,
  candidates,
  customNames,
}: {
  wallet: WalletRecord;
  candidates: {
    address: string;
    label: string;
    passkey?: { qx: string; qy: string };
    wedgie?: { x: string; y: string };
  }[];
  customNames: Record<string, string>;
}) => {
  const slug = useRoomSlug();
  const [threshold, setThreshold] = useState(wallet.threshold);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pasteId, setPasteId] = useState("");
  useEffect(() => setThreshold(wallet.threshold), [wallet.threshold]);

  const ownerIds = new Set(wallet.signers.flatMap(s => [s.address.toLowerCase(), s.passkeyAddr?.toLowerCase() ?? ""]));
  const addable = candidates.filter(c => !ownerIds.has(c.address.toLowerCase()));

  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(withSlug(`${RELAY_HTTP}/v1/safe/owners`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        results?: { chainId: number; txId?: string; error?: string }[];
      };
      if (!r.ok) return setMsg(j.error ?? `relay ${r.status}`);
      const failed = (j.results ?? []).filter(x => x.error);
      setMsg(
        `Queued on ${(j.results ?? []).length - failed.length} chains — sign it in Transactions.` +
          (failed.length ? ` Failed: ${failed.map(f => `${chainMeta(f.chainId).label} (${f.error})`).join(", ")}` : ""),
      );
    } catch (e) {
      setMsg(String(e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  const addWedgie = async () => {
    try {
      const k = await withWedgie(w => w.key());
      await call({ action: "add", owner: { qx: k.x, qy: k.y, device: "wedgie", label: "wedgie" }, threshold });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title="Owners">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        {wallet.signers.map(s => (
          <div key={s.address} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {s.device === "wedgie" ? (
              <WedgieTag label={s.label} />
            ) : (
              <SlopAddress address={s.passkeyAddr ?? s.address} customNames={customNames} />
            )}
            <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>
              {s.device === "wedgie" ? "wedgie" : s.signerType}
            </span>
            <button
              type="button"
              disabled={busy || wallet.signers.length <= 1}
              onClick={() =>
                void call({
                  action: "remove",
                  owner: { address: s.address },
                  threshold: Math.min(threshold, wallet.signers.length - 1),
                })
              }
              title="Propose removing this owner"
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: 0,
                color: "var(--slop-text-muted)",
                cursor: "pointer",
              }}
            >
              remove
            </button>
          </div>
        ))}
        <Field label={`Signatures needed: ${threshold} of ${wallet.signers.length}`}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="range"
              min={1}
              max={Math.max(1, wallet.signers.length + 1)}
              value={threshold}
              onChange={e => setThreshold(parseInt(e.target.value, 10))}
              style={{ flex: 1 }}
            />
            <Button
              disabled={busy || threshold === wallet.threshold || threshold > wallet.signers.length}
              onClick={() => void call({ action: "threshold", threshold })}
            >
              Change
            </Button>
          </div>
        </Field>
        {addable.map(c => (
          <div key={c.address} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {c.wedgie ? <WedgieTag label={c.label} /> : <SlopAddress address={c.address} customNames={customNames} />}
            <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>
              {c.wedgie ? "wedgie" : c.passkey ? "passkey" : "wallet"}
            </span>
            <Button
              disabled={busy}
              onClick={() =>
                void call({
                  action: "add",
                  owner: c.wedgie
                    ? { qx: c.wedgie.x, qy: c.wedgie.y, label: c.label, device: "wedgie" }
                    : c.passkey
                      ? { qx: c.passkey.qx, qy: c.passkey.qy, label: c.label }
                      : { address: c.address, label: c.label },
                  threshold,
                })
              }
            >
              Add
            </Button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={pasteId}
            onChange={e => setPasteId(e.target.value)}
            placeholder="paste a wedgie ID (from its Wedgie app)"
            style={{
              flex: 1,
              fontSize: 11,
              padding: "4px 6px",
              background: "rgba(255,255,255,0.04)",
              color: "inherit",
              border: "1px solid rgba(255,62,201,0.25)",
              borderRadius: 3,
            }}
          />
          <Button
            disabled={busy || !parseWedgieId(pasteId)}
            onClick={() => {
              const k = parseWedgieId(pasteId);
              if (k)
                void call({ action: "add", owner: { qx: k.x, qy: k.y, device: "wedgie", label: "wedgie" }, threshold });
            }}
          >
            Add
          </Button>
        </div>
        {wedgieSupported() ? (
          <Button disabled={busy} onClick={() => void addWedgie()} title="Plug in the wedgie (Safe signer app) first.">
            Add wedgie
          </Button>
        ) : null}
        <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
          A wedgie can never be the only signature needed: with one, at least 2 are needed and the other owners must
          reach that number on their own.
        </div>
        {msg ? <div style={{ fontSize: 11 }}>{msg}</div> : null}
      </div>
    </Section>
  );
};

// ============================================================================
// SafeChains — create the room Safe (relay pays, every SAFE_CHAIN_IDS chain) and show
// per-chain progress. ops/PLAN-safe.md.
// ============================================================================

type ChainState = { state: "deploying" | "ok" | "failed"; txHash?: string | null; error?: string };

const SafeChains = ({
  existing,
  signers,
  threshold,
  label,
  canDeploy,
}: {
  existing: WalletRecord | null;
  signers: ResolvedSigner[];
  threshold: number;
  label: string;
  canDeploy: boolean;
}) => {
  const slug = useRoomSlug();
  const [status, setStatus] = useState<Record<number, ChainState>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chains = SUPPORTED_CHAINS.filter(c => (SAFE_CHAIN_IDS as readonly number[]).includes(c.id));
  const missing = existing ? chains.filter(c => !existing.deployments[c.id]).length : 0;

  // Poll while any chain is still missing; the relay deploys in the background.
  useEffect(() => {
    if (!existing || missing === 0) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(withSlug(`${RELAY_HTTP}/v1/safe/status`, slug), { credentials: "include" });
        if (r.ok && !stop) setStatus(((await r.json()) as { chains: Record<number, ChainState> }).chains ?? {});
      } catch {
        /* next tick */
      }
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [existing, missing, slug]);

  const post = async (body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(withSlug(`${RELAY_HTTP}/v1/safe/deploy`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `relay ${r.status}`);
    } catch (e) {
      setErr(String(e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  if (!existing) {
    const owners = signers.map(s =>
      s.qx && s.qy
        ? { qx: s.qx, qy: s.qy, label: s.label, ...(s.device ? { device: s.device } : {}) }
        : { address: s.address, label: s.label },
    );
    const ruleErr = wedgieRuleMsg(signers, threshold);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Button
          disabled={!canDeploy || busy || signers.length === 0 || !!ruleErr}
          onClick={() => void post({ owners, threshold, label })}
          title={!canDeploy ? "Only the host can create the Safe." : undefined}
        >
          {busy ? "Creating…" : `Create Safe (${threshold} of ${signers.length})`}
        </Button>
        {ruleErr ? <div style={{ fontSize: 11, color: "#ffb86b" }}>{ruleErr}</div> : null}
        {err ? <div style={{ fontSize: 11, color: "#ff6b6b" }}>{err}</div> : null}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {chains.map(c => {
        const dep = existing.deployments[c.id];
        const st = status[c.id];
        return (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ width: 80 }}>{c.label}</span>
            {dep ? (
              dep.txHash ? (
                <a href={`${c.explorer}/tx/${dep.txHash}`} target="_blank" rel="noreferrer">
                  ✓ live
                </a>
              ) : (
                <span>✓ live</span>
              )
            ) : st?.state === "failed" ? (
              <span style={{ color: "#ff6b6b" }} title={st.error}>
                failed — {st.error?.slice(0, 60)}
              </span>
            ) : (
              <span style={{ color: "var(--slop-text-muted)" }}>
                {st?.state === "deploying" ? "deploying…" : "not yet"}
              </span>
            )}
          </div>
        );
      })}
      {missing > 0 && chains.some(c => !existing.deployments[c.id] && status[c.id]?.state !== "deploying") ? (
        <Button disabled={busy} onClick={() => void post({})}>
          {busy ? "Retrying…" : "Retry missing chains"}
        </Button>
      ) : null}
      {err ? <div style={{ fontSize: 11, color: "#ff6b6b" }}>{err}</div> : null}
    </div>
  );
};

// ============================================================================
// DeployedSummary — read-only signer / threshold summary, shown above the
// chain grid once the wallet exists.
// ============================================================================

const DeployedSummary = ({
  wallet,
  customNames,
  myAddress,
  onArchive,
}: {
  wallet: WalletRecord;
  customNames: Record<string, string>;
  myAddress: string | null;
  onArchive: () => void;
}) => {
  const myLower = myAddress?.toLowerCase() ?? null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 12,
        background: "linear-gradient(180deg, rgba(255,62,201,0.06) 0%, rgba(255,62,201,0.02) 100%)",
        border: "1px solid rgba(255,62,201,0.3)",
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          {wallet.label}
        </div>
        <button
          type="button"
          onClick={onArchive}
          title="Archive this wallet and reset to the deploy form for a fresh episode."
          style={{
            background: "transparent",
            border: "1px solid rgba(255,62,201,0.4)",
            color: "var(--slop-text-muted)",
            borderRadius: 3,
            padding: "3px 8px",
            fontSize: 10,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          New episode
        </button>
      </div>
      <Address address={wallet.address as AddressType} size="sm" />
      <div style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>
        Threshold {wallet.threshold} of {wallet.signers.length}
        {" · deployed on "}
        {Object.keys(wallet.deployments)
          .map(k => chainMeta(Number(k)).label)
          .join(", ")}
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: "2px 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {wallet.signers.map(s => {
          const who = s.passkeyAddr ?? s.address;
          const isMe = myLower && who.toLowerCase() === myLower;
          return (
            <li
              key={s.address}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                borderRadius: 4,
                background: isMe ? "rgba(255,62,201,0.12)" : "rgba(255,255,255,0.025)",
                border: `1px solid ${isMe ? "rgba(255,62,201,0.28)" : "rgba(255,255,255,0.06)"}`,
                fontSize: 11,
                minWidth: 0,
              }}
            >
              {/* SlopAddress shows the spendable wallet address for a passkey
                  signer; the raw passkey address (the ACTUAL signer) is shown
                  subtly in parens — don't send funds there. */}
              <SlopAddress address={who} customNames={customNames} />
              {isMe ? <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>(you)</span> : null}
              {s.signerType === "passkey" ? (
                <span
                  style={{ color: "var(--slop-text-muted)", fontSize: 10 }}
                  title="the passkey's signer contract — the Safe owner. Do not send funds here."
                >
                  · {s.device === "wedgie" ? "wedgie" : "passkey"} ({short(s.address)})
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

// ============================================================================
// Activity tx queue — per-chain pending + recent Safe txs. The
// Transactions tab; txs proposed from the wallet chat land here.
// ============================================================================

type ActivityProps = {
  mesh: PeerMeshState;
  wallet: WalletRecord;
  myAddress: string | null;
  /** PERSONAL wallet (the desktop "Wallet" app): when set, this queue reads
   *  and mutates the per-address tx store for that multisig instead of the
   *  Bank's room singleton. Undefined → the Bank (behavior unchanged). */
  walletAddress?: string;
  /** PASSKEY personal wallet only: route a queued tx's Execute through the
   *  gas-sponsored relay facilitator instead of an EOA broadcast. A passkey
   *  user has no connected EOA, so the EOA path dead-ends — this hands the
   *  tx's already-collected signatures to the facilitator, which pays gas.
   *  Undefined → the Bank's EOA execute (behavior unchanged). */
  sponsoredExecute?: (tx: WalletTx) => Promise<`0x${string}`>;
};

export const ActivityTxQueue = ({ mesh, wallet, myAddress, walletAddress, sponsoredExecute }: ActivityProps) => {
  // Default to the most recently deployed chain.
  const deployedChainIds = useMemo(
    () =>
      Object.keys(wallet.deployments)
        .map(k => Number(k))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => wallet.deployments[b].deployedAt - wallet.deployments[a].deployedAt),
    [wallet.deployments],
  );
  // The selected chain is multiplayer too: switch the network and every
  // peer's queue follows. Fallback is the most-recently-deployed chain
  // (the same derived value on every peer) until anyone picks.
  // A personal wallet scopes the chain-picker key by address so it doesn't
  // collide with the Bank's picker (or another personal wallet's).
  const [activeChain, setActiveChain] = useSyncedUIState<number>(
    mesh,
    walletAddress ? `wallet:activeChain:${walletAddress.toLowerCase()}` : "wallet:activeChain",
    deployedChainIds[0] ?? mainnet.id,
  );
  useEffect(() => {
    if (deployedChainIds.length === 0) return;
    if (!deployedChainIds.includes(activeChain)) setActiveChain(deployedChainIds[0]);
  }, [deployedChainIds, activeChain, setActiveChain]);

  // Distinct from chainTxs below — used by the "txs exist on other
  // chains" hint so the user knows to switch the chain picker if their
  // tx landed on a chain that isn't currently selected. A personal wallet
  // reads its own per-address queue; the Bank reads the room singleton.
  const allTxs = walletAddress ? mesh.walletTxsFor(walletAddress) : mesh.walletTxs;
  const chainTxs = allTxs.filter(t => t.chainId === activeChain);
  const pendingTxs = chainTxs.filter(t => t.status === "pending");
  const otherTxs = chainTxs.filter(t => t.status !== "pending").slice(0, 20);
  const txsOnOtherChains = allTxs.filter(t => t.chainId !== activeChain);

  // Auto-switch the picker to wherever a new pending tx actually landed.
  // A poker/dapp/AI-wallet propose can target Base while the queue is
  // showing Ethereum; the queue filters by chain, so without this the new
  // tx hides behind the picker. Mirrors the window-level jump to the
  // Transactions tab — surface what needs a signature, on the right
  // network. Synced via setActiveChain, so every peer's picker follows.
  // We track the pending count (not identity), so dismiss-then-arrive on
  // a different chain still triggers. Only switch to a chain the multisig
  // is actually deployed on (else the reset effect above bounces it back).
  const pendingTotal = allTxs.filter(t => t.status === "pending").length;
  const lastPendingTotalRef = useRef(pendingTotal);
  useEffect(() => {
    if (pendingTotal > lastPendingTotalRef.current) {
      const newest = allTxs
        .filter(t => t.status === "pending")
        .reduce<WalletTx | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
      if (newest && newest.chainId !== activeChain && deployedChainIds.includes(newest.chainId)) {
        setActiveChain(newest.chainId);
      }
    }
    lastPendingTotalRef.current = pendingTotal;
  }, [pendingTotal, allTxs, activeChain, deployedChainIds, setActiveChain]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 10,
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Chain
        </span>
        <ChainPicker deployedChainIds={deployedChainIds} active={activeChain} onPick={setActiveChain} />
      </div>

      <Section title={`Pending on ${chainMeta(activeChain).label} (${pendingTxs.length})`}>
        {pendingTxs.length === 0 ? (
          <div
            style={{
              padding: 12,
              fontSize: 12,
              color: "var(--slop-text-muted)",
              background: "rgba(255,255,255,0.02)",
              border: "1px dashed rgba(255,62,201,0.18)",
              borderRadius: 6,
              lineHeight: 1.5,
            }}
          >
            {txsOnOtherChains.length > 0 ? (
              <div style={{ fontSize: 11, color: "var(--slop-cyan, #3fcfff)" }}>
                {txsOnOtherChains.length} transaction{txsOnOtherChains.length === 1 ? "" : "s"} on{" "}
                {Array.from(new Set(txsOnOtherChains.map(t => chainMeta(t.chainId).label))).join(", ")} — switch the
                chain picker above to view.
              </div>
            ) : (
              <>No pending transactions.</>
            )}
          </div>
        ) : (
          pendingTxs.map(tx => (
            <TxCard
              key={tx.id}
              tx={tx}
              wallet={wallet}
              mesh={mesh}
              myAddress={myAddress}
              walletAddress={walletAddress}
              sponsoredExecute={sponsoredExecute}
            />
          ))
        )}
      </Section>

      {otherTxs.length > 0 ? (
        <Section title="Recent">
          {otherTxs.map(tx => (
            <TxCard
              key={tx.id}
              tx={tx}
              wallet={wallet}
              mesh={mesh}
              myAddress={myAddress}
              walletAddress={walletAddress}
              sponsoredExecute={sponsoredExecute}
              compact
            />
          ))}
        </Section>
      ) : null}
    </div>
  );
};

const ChainPicker = ({
  deployedChainIds,
  active,
  onPick,
}: {
  deployedChainIds: number[];
  active: number;
  onPick: (id: number) => void;
}) => {
  if (deployedChainIds.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {deployedChainIds.map(id => {
        const meta = chainMeta(id);
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            style={{
              padding: "4px 10px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              background: isActive ? "var(--slop-magenta, #ff3ec9)" : "rgba(255,255,255,0.04)",
              color: isActive ? "#06030d" : "var(--slop-text)",
              border: `1px solid ${isActive ? "var(--slop-magenta, #ff3ec9)" : "rgba(255,62,201,0.25)"}`,
              borderRadius: 4,
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            {meta.label}
          </button>
        );
      })}
    </div>
  );
};

// ----------------------------------------------------------------------------
// SignerCollectionBar — under every tx card. Shows a progress bar of
// signatures collected (out of threshold) and a guest-list-style row
// per signer with an emoji for their state:
//   ✅ signed   👋 here (in the room, no sig yet)   💤 away (not present)
// Compact mode (recent/executed txs) renders just the bar.
// ----------------------------------------------------------------------------

const SignerCollectionBar = ({
  wallet,
  tx,
  peers,
  customNames,
  myAddress,
  compact,
}: {
  wallet: WalletRecord;
  tx: WalletTx;
  peers: Peer[];
  customNames: Record<string, string>;
  myAddress: string | null;
  compact?: boolean;
}) => {
  const signedSet = useMemo(() => new Set(tx.signatures.map(s => s.signer.toLowerCase())), [tx.signatures]);
  const onlineAddrs = useMemo(() => {
    const s = new Set<string>();
    for (const p of peers) if (p.address) s.add(p.address.toLowerCase());
    return s;
  }, [peers]);

  const signedCount = tx.signatures.length;
  const threshold = wallet.threshold;
  const pct = Math.min(100, (signedCount / Math.max(1, threshold)) * 100);
  const complete = signedCount >= threshold;
  const myLower = (myAddress ?? "").toLowerCase();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Signatures
        </span>
        <span
          style={{
            fontSize: 11,
            color: complete ? "#7be88a" : "var(--slop-text)",
            fontWeight: 700,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
          }}
        >
          {signedCount} / {threshold}
        </span>
      </div>
      <LoadingBar
        cells="fill"
        progress={pct}
        style={{ fontSize: 13, ...(complete ? ({ "--slop-magenta": "#7be88a" } as React.CSSProperties) : {}) }}
      />
      {!compact ? (
        <ul
          style={{
            listStyle: "none",
            margin: "2px 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {wallet.signers.map(signer => {
            const lower = signer.address.toLowerCase();
            const signed = signedSet.has(lower);
            const here = onlineAddrs.has(lower);
            const isMe = !!myLower && lower === myLower;
            const emoji = signed ? "✅" : here ? "👋" : "💤";
            const status = signed ? "signed" : here ? "in the room, hasn't signed" : "not present";
            return (
              <li
                key={signer.address}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 8px",
                  borderRadius: 4,
                  background: signed
                    ? "rgba(123,232,138,0.08)"
                    : isMe
                      ? "rgba(255,62,201,0.12)"
                      : "rgba(255,255,255,0.025)",
                  border: `1px solid ${signed ? "rgba(123,232,138,0.28)" : isMe ? "rgba(255,62,201,0.28)" : "rgba(255,255,255,0.06)"}`,
                  opacity: !signed && !here ? 0.7 : 1,
                  fontSize: 11,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                  }}
                >
                  <SlopAddress address={signer.address} customNames={customNames} />
                  {isMe ? <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>(you)</span> : null}
                </span>
                <span
                  title={status}
                  aria-label={status}
                  style={{ fontSize: 14, lineHeight: 1, flexShrink: 0, cursor: "help" }}
                >
                  {emoji}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};

// ----------------------------------------------------------------------------
// TxProgressBar — under SignerCollectionBar once a tx has been submitted
// on-chain (i.e. tx.txHash is set OR the local execHash is set). Shows:
//   - 3-stage progress: submitted → confirming → confirmed
//   - hash + copy + explorer link as soon as we have it
//   - elapsed seconds since submit (so a long wait doesn't look frozen)
//   - any wagmi/RPC error from the receipt poll
//   - a "Check now" button that does a direct getTransactionReceipt
// Renders nothing for "pending" (no hash yet) and for finalized states
// (executed/failed/expired/cancelled — TxCard already handles those).
// ----------------------------------------------------------------------------

const TxProgressBar = ({
  tx,
  watchedHash,
  isWaiting,
  isError,
  errorText,
  onCheckNow,
  checking,
  manualErr,
}: {
  tx: WalletTx;
  watchedHash: `0x${string}` | undefined;
  isWaiting: boolean;
  isError: boolean;
  errorText: string | null;
  onCheckNow: () => void;
  checking: boolean;
  manualErr: string | null;
}) => {
  const explorer = chainMeta(tx.chainId).explorer;
  // Tick once a second so the elapsed counter advances visibly even
  // when no other state changes. Cheap — only mounts while a tx is
  // executing.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tx.status !== "executing") return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [tx.status]);
  // `updatedAt` was bumped by the relay when status flipped to
  // "executing" — close enough to "submitted at" for a counter.
  const elapsedSec = Math.max(0, Math.floor((Date.now() - tx.updatedAt) / 1000));
  // tick is purely for the visual refresh — silence the unused warning.
  void tick;

  // Three stages:
  //   0 = no hash yet (writeContract not back) — should be rare since
  //       writeContract returns quickly, but cover it for completeness
  //   1 = have hash, waiting for receipt
  //   2 = confirmed (executed or failed) — but in that case TxCard's
  //       parent branch hides this bar, so we won't render here
  const stage = !watchedHash ? 0 : tx.status === "executing" ? 1 : 2;
  const pct = stage === 0 ? 15 : stage === 1 ? 60 : 100;
  const stageLabel = stage === 0 ? "submitting…" : stage === 1 ? "confirming on chain…" : "confirmed";

  const [copied, setCopied] = useState(false);
  const onCopyHash = useCallback(() => {
    if (!watchedHash) return;
    void navigator.clipboard.writeText(watchedHash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [watchedHash]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Transaction
        </span>
        <span
          style={{
            fontSize: 11,
            color: stage === 2 ? "#7be88a" : "var(--slop-text)",
            fontWeight: 700,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
          }}
        >
          {stageLabel} · {elapsedSec}s
        </span>
      </div>
      <LoadingBar
        cells="fill"
        progress={pct}
        style={{ fontSize: 13, ...(stage === 2 ? ({ "--slop-magenta": "#7be88a" } as React.CSSProperties) : {}) }}
      />
      {watchedHash ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            fontSize: 11,
            fontFamily: "monospace",
            color: "var(--slop-text-muted)",
          }}
        >
          <span>hash</span>
          <a
            href={`${explorer}/tx/${watchedHash}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--slop-cyan, #3fcfff)", textDecoration: "underline" }}
            title={watchedHash}
          >
            {watchedHash.slice(0, 10)}…{watchedHash.slice(-6)}
          </a>
          <button
            type="button"
            onClick={onCopyHash}
            title="Copy hash"
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "var(--slop-text-muted)",
              borderRadius: 3,
              cursor: "pointer",
              fontSize: 10,
              padding: "1px 6px",
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
          {isWaiting || stage === 1 ? (
            <button
              type="button"
              onClick={onCheckNow}
              disabled={checking}
              title="Hit the RPC directly and ask if the receipt is ready yet."
              style={{
                background: "transparent",
                border: "1px solid rgba(63,207,255,0.35)",
                color: "var(--slop-cyan, #3fcfff)",
                borderRadius: 3,
                cursor: checking ? "wait" : "pointer",
                fontSize: 10,
                padding: "1px 6px",
                opacity: checking ? 0.6 : 1,
              }}
            >
              {checking ? "checking…" : "check now"}
            </button>
          ) : null}
        </div>
      ) : null}
      {isError && errorText ? (
        <div
          style={{
            fontSize: 10,
            color: "#ffb96b",
            padding: 4,
            background: "rgba(255,185,107,0.08)",
            borderRadius: 3,
          }}
          title="The receipt poll hit an error. The transaction may still confirm — try 'check now' or watch the explorer."
        >
          receipt poll error: {errorText.slice(0, 160)}
        </div>
      ) : null}
      {manualErr ? (
        <div
          style={{
            fontSize: 10,
            color: "var(--slop-text-muted)",
            padding: 4,
            background: "rgba(255,255,255,0.025)",
            borderRadius: 3,
          }}
        >
          {manualErr}
        </div>
      ) : null}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Tx card — sign + execute. Chain comes from the tx itself, not the wallet.
// ----------------------------------------------------------------------------

// Structured AI summary card. The relay's wallet-ai prompt asks Claude
// for this exact shape; the client parses + renders it with token chips
// + <Address> cards. If parsing fails (old summary, or model returned
// prose), the raw string falls back to a single-line text render.
//
// `chain` + `thumbnail` are populated by the relay's post-processing
// step (wallet-ai.ts) — it overwrites the model's guess from a Zerion
// lookup keyed on `address`, which is also what fixes CLAWD→UNI-style
// symbol hallucinations.
type TxSummaryAsset = {
  symbol: string;
  amount: string;
  address?: string | null;
  chain?: string | null;
  thumbnail?: string | null;
};
type TxSummaryCard = {
  headline: string;
  kind?: "swap" | "send" | "approve" | "mint" | "deploy" | "call";
  inputs: TxSummaryAsset[];
  outputs: TxSummaryAsset[];
  to?: string | null;
  contract?: { address: string; label: string } | null;
};

// LLMs hallucinate EIP-55 checksum case (e.g. "0x34Aa3F…" instead of
// "0x34aA3F…"). viem's getAddress() rejects the bad-case form and the
// Address component shows "Invalid address". Lowercase any 40-hex
// address in the card so viem can rebuild the correct checksum at
// display time. The relay also normalizes new summaries — this layer
// is for summaries that were cached before the relay fix landed.
const lowerCaseHexAddrs = (s: string): string => s.replace(/0x[a-fA-F0-9]{40}/g, m => m.toLowerCase());

const parseSummaryCard = (raw: string | null): TxSummaryCard | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const o = JSON.parse(lowerCaseHexAddrs(trimmed));
    if (!o || typeof o !== "object") return null;
    if (typeof o.headline !== "string") return null;
    if (!Array.isArray(o.inputs) || !Array.isArray(o.outputs)) return null;
    return o as TxSummaryCard;
  } catch {
    return null;
  }
};

// "out" = leaving the Safe (magenta loss-side), "in" = arriving
// (lime gain-side). Uses the shared TokenAvatar so the chip carries the
// same icon + chain badge that the Assets tab shows for that token.
const AssetPill = ({ asset, direction }: { asset: TxSummaryAsset; direction: "in" | "out" }) => {
  const isOut = direction === "out";
  const border = isOut ? "rgba(255,62,201,0.4)" : "rgba(123,232,138,0.5)";
  const bg = isOut ? "rgba(255,62,201,0.10)" : "rgba(123,232,138,0.10)";
  const sym = asset.symbol || "Token";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px 4px 6px",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 999,
        fontSize: 12,
        lineHeight: 1.2,
      }}
    >
      <TokenAvatar symbol={sym} thumbnail={asset.thumbnail ?? null} chain={asset.chain ?? null} size={22} />
      <span style={{ fontFamily: "var(--slop-font-display)", fontWeight: 600 }}>{asset.amount}</span>
      <span style={{ color: "var(--slop-text-muted)" }}>{sym}</span>
    </span>
  );
};

// One labeled rendering of a tx summary blob. Used twice per tx card to
// surface both the proposer's claim and the independent AI second
// opinion side-by-side, so a signer can spot when the two disagree. The
// `accent` colors the header so the two blocks stay visually distinct
// (proposer = magenta, AI verifier = cyan).
const LabeledSummaryBlock = ({
  label,
  raw,
  accent,
  pendingHint,
  onRetry,
}: {
  label: string;
  raw: string | null;
  accent: string;
  pendingHint: string;
  onRetry?: () => void;
}) => {
  const card = raw ? parseSummaryCard(raw) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {label ? (
        <div
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: accent,
            fontFamily: "var(--slop-font-display)",
          }}
        >
          {label}
        </div>
      ) : null}
      {raw ? (
        card ? (
          <TxSummaryCardView card={card} />
        ) : (
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              padding: 8,
              background: "rgba(255,62,201,0.06)",
              borderRadius: 4,
            }}
          >
            {raw}
          </div>
        )
      ) : (
        <div style={{ fontSize: 11, color: "var(--slop-text-muted)", fontStyle: "italic" }}>
          {pendingHint}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--slop-magenta, #ff3ec9)",
                cursor: "pointer",
                marginLeft: 6,
                fontSize: 10,
                textDecoration: "underline",
              }}
            >
              retry
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
};

const TxSummaryCardView = ({ card }: { card: TxSummaryCard }) => {
  const hasFlow = card.inputs.length > 0 || card.outputs.length > 0;
  return (
    <div
      style={{
        padding: 10,
        background: "rgba(255,62,201,0.06)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          fontFamily: "var(--slop-font-display)",
          color: "var(--slop-text, #f5f0ff)",
        }}
      >
        {card.headline}
      </div>
      {hasFlow ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {card.inputs.map((a, i) => (
            <AssetPill key={`in-${i}`} asset={a} direction="out" />
          ))}
          {card.inputs.length > 0 && card.outputs.length > 0 ? (
            <span style={{ color: "var(--slop-magenta, #ff3ec9)", fontSize: 16, lineHeight: 1 }}>→</span>
          ) : null}
          {card.outputs.map((a, i) => (
            <AssetPill key={`out-${i}`} asset={a} direction="in" />
          ))}
        </div>
      ) : null}
      {card.to ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span style={{ color: "var(--slop-text-muted)" }}>to</span>
          <Address address={card.to as AddressType} size="xs" onlyEnsOrAddress />
        </div>
      ) : null}
      {card.contract ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, flexWrap: "wrap" }}>
          <span style={{ color: "var(--slop-text-muted)" }}>via</span>
          <Address address={card.contract.address as AddressType} size="xs" onlyEnsOrAddress />
          {card.contract.label ? (
            <span style={{ color: "var(--slop-text-muted)" }}>· {card.contract.label}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

type TxCardProps = {
  tx: WalletTx;
  wallet: WalletRecord;
  mesh: PeerMeshState;
  myAddress: string | null;
  compact?: boolean;
  /** PERSONAL wallet: routes this card's queue mutations to the per-address
   *  store. Undefined → the Bank's room singleton (behavior unchanged). */
  walletAddress?: string;
  /** PASSKEY personal wallet only: when set, Execute routes through the
   *  gas-sponsored facilitator (no connected EOA required) instead of the EOA
   *  writeContract broadcast. Undefined → the Bank's EOA path (unchanged). */
  sponsoredExecute?: (tx: WalletTx) => Promise<`0x${string}`>;
};

const TxCard = ({ tx, wallet, mesh, myAddress, compact, walletAddress, sponsoredExecute }: TxCardProps) => {
  const { address: connectedAddress } = useAccount();
  // Per-address-aware queue mutations: a personal wallet threads its
  // `walletAddress` so signatures/status/removal land in its own store; the
  // Bank passes undefined and these behave exactly as the bare mesh calls.
  const { walletSetTxStatus: meshSetTxStatus, walletSignTx: meshSignTx } = mesh;
  const { walletRemoveTx: meshRemoveTx, walletResummarize: meshResummarize } = mesh;
  const txStatus = (id: string, status: WalletTx["status"], txHash?: string | null) =>
    meshSetTxStatus(id, status, txHash, walletAddress);
  const txSign = (id: string, sig: { signer: string; sigType: 0 | 1; data: string }) =>
    meshSignTx(id, sig, walletAddress);
  const txRemove = (id: string) => meshRemoveTx(id, walletAddress);
  const txResummarize = (id: string) => meshResummarize(id, walletAddress);
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  // Safe tx (ops/PLAN-safe.md): EOAs sign EIP-712, passkeys + wedgies sign the
  // safeTxHash, the relay executes. No deadline — cancel burns the nonce.
  // A tx without `operation` is a leftover from the abandoned slop multisig:
  // shown, never signable.
  const isSafe = tx.operation !== undefined;
  const slug = useRoomSlug();
  const safeTx: SafeTx | null = isSafe
    ? {
        to: tx.target as AddressType,
        value: BigInt(tx.value),
        data: tx.data as Hex,
        operation: tx.operation!,
        nonce: BigInt(tx.nonce),
      }
    : null;
  // The connected wallet's ACTIVE network (what MetaMask is pointed at) —
  // independent of the slop UI's chain selectors. Execute is an on-chain tx
  // that must run on tx.chainId, so we switch the wallet there first.
  const connectedChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const txPublicClient = usePublicClient({ chainId: tx.chainId });
  const [execHash, setExecHash] = useState<`0x${string}` | null>(null);
  // Watch whichever hash we have — the locally-submitted one (this tab
  // sent it) OR the one broadcast on the relay by another peer's exec.
  // Every peer pollers in parallel; first to see a receipt updates relay
  // state. Idempotent because `walletSetTxStatus` just overwrites.
  //
  // Only chase the relay hash while the tx is actually "executing". The
  // relay now clears txHash when a tx is reset to "pending", but a tx that
  // was reset under the OLD code is still persisted as pending-with-a-stale-
  // hash; gating here un-sticks those too (otherwise the watcher pins
  // execWaiting=true and re-disables Execute). The local execHash is always
  // watched — it covers the gap between submitting and the relay echoing
  // back "executing".
  const watchedHash = execHash ?? (tx.status === "executing" ? (tx.txHash as `0x${string}` | null) : null) ?? undefined;
  const {
    isLoading: execWaiting,
    data: execReceipt,
    isError: execIsError,
    error: execError,
    refetch: refetchReceipt,
  } = useWaitForTransactionReceipt({
    hash: watchedHash,
    chainId: tx.chainId,
    // Same reason as the deploy receipt: app-wide pollingInterval is 30s
    // for ambient state, but once we have a hash the user just wants to
    // see it confirm. 2s feels live.
    pollingInterval: 2000,
  });
  // Backgrounded tabs get setTimeout throttled to ~1Hz by the browser,
  // which silently stalls wagmi's 2s polling. When the tab comes back
  // to foreground, kick a manual refetch so we don't sit on a stale
  // "loading" forever just because the user tabbed away.
  useEffect(() => {
    if (!watchedHash) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") refetchReceipt();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [watchedHash, refetchReceipt]);
  // Manual receipt check — direct viem call instead of wagmi's hook.
  // Used by the "Check now" button in TxProgressBar when the user
  // suspects wagmi's poller is wedged. Catches errors loudly.
  const [manualErr, setManualErr] = useState<string | null>(null);
  const [manualChecking, setManualChecking] = useState(false);
  const onManualCheck = useCallback(async () => {
    if (!watchedHash || !txPublicClient) return;
    setManualErr(null);
    setManualChecking(true);
    try {
      const r = await txPublicClient.getTransactionReceipt({ hash: watchedHash });
      // viem throws if not found; if we got here we have one.
      txStatus(tx.id, r.status === "success" ? "executed" : "failed", r.transactionHash);
      setExecHash(null);
    } catch (e) {
      const msg = String((e as { shortMessage?: string; message?: string }).shortMessage ?? e);
      // "could not be found" / "TransactionReceiptNotFoundError" → still pending, not an error.
      if (/not.*found|TransactionReceiptNotFoundError/i.test(msg)) {
        setManualErr("tx still pending on chain — not yet mined");
      } else {
        setManualErr(msg.slice(0, 200));
      }
      // Also nudge wagmi to retry.
      refetchReceipt();
    } finally {
      setManualChecking(false);
    }
  }, [watchedHash, txPublicClient, mesh, tx.id, refetchReceipt]);
  const [err, setErr] = useState<string | null>(null);
  // True while the WebAuthn passkey prompt is open. wagmi's
  // useSignTypedData.isPending only covers the EOA path; we track this
  // ourselves so the Sign button stays disabled during the OS sheet
  // and doesn't double-prompt on a stray click.
  const [passkeySigning, setPasskeySigning] = useState(false);
  // True while the relay is executing (it pays gas): the Bank's
  // /v1/safe/exec, or a personal wallet's sponsoredExecute.
  const [sponsoring, setSponsoring] = useState(false);

  // Identify the local user against the wallet's registered signers.
  // For EOA signers we need the wagmi-connected address; for passkey
  // signers we use the relay session's `myAddress` (the passkey-derived
  // identity). Trying both lets one browser participate as either kind.
  const lowerCandidates = [connectedAddress?.toLowerCase(), myAddress?.toLowerCase()].filter((a): a is string => !!a);
  // A Safe passkey owner is its signer contract; match the peer by passkeyAddr.
  const mySignerEntry =
    wallet.signers.find(
      s =>
        lowerCandidates.includes(s.address.toLowerCase()) ||
        (!!s.passkeyAddr && lowerCandidates.includes(s.passkeyAddr.toLowerCase())),
    ) ?? null;
  const myLowerAddress = mySignerEntry?.address.toLowerCase() ?? "";
  const isMySigner = !!mySignerEntry;
  const isPasskeySigner = mySignerEntry?.signerType === "passkey";
  const hasMySig = !!myLowerAddress && tx.signatures.some(s => s.signer.toLowerCase() === myLowerAddress);
  const enoughSigs = tx.signatures.length >= wallet.threshold;

  useEffect(() => {
    if (execReceipt) {
      txStatus(tx.id, execReceipt.status === "success" ? "executed" : "failed", execReceipt.transactionHash);
      setExecHash(null);
    }
  }, [execReceipt, mesh, tx.id]);

  // Whenever the tx flips back to "pending" — whoever pressed Try again, on
  // whatever tab — stop watching the abandoned attempt. Keyed on tx.status so
  // it only fires on the transition INTO pending, never wiping the fresh hash
  // we set while heading into "executing".
  useEffect(() => {
    if (tx.status === "pending") setExecHash(null);
  }, [tx.status]);

  // The "executing" status is set on relay state when someone clicks
  // Execute, but the receipt watcher is local to that signer's tab.
  // If they close the tab, lose RPC, or hit an unmined tx, the relay
  // state hangs at "executing" forever. After STUCK_MS we show
  // Try-again / Remove buttons so any signer can break the deadlock.
  const STUCK_MS = 15_000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tx.status !== "executing") return;
    const elapsed = Date.now() - tx.updatedAt;
    if (elapsed >= STUCK_MS) {
      setNow(Date.now());
      return;
    }
    const t = setTimeout(() => setNow(Date.now()), STUCK_MS - elapsed);
    return () => clearTimeout(t);
  }, [tx.status, tx.updatedAt]);
  const isStuckExecuting = tx.status === "executing" && now - tx.updatedAt >= STUCK_MS;

  const onResetToPending = useCallback(() => {
    // Drop the abandoned hash locally too. The relay clears its copy on the
    // pending transition, but this tab's `execHash` also feeds `watchedHash`
    // — leave it set and the receipt watcher keeps `execWaiting` true, which
    // re-disables the Execute button we just tried to free up.
    setExecHash(null);
    txStatus(tx.id, "pending");
  }, [mesh, tx.id]);
  const onRemoveTx = useCallback(() => {
    txRemove(tx.id);
  }, [mesh, tx.id]);

  const onSign = useCallback(async () => {
    console.log("[wallet] onSign clicked", {
      txId: tx.id,
      execHash: tx.execHash,
      mySignerEntry,
      isPasskey: mySignerEntry?.signerType === "passkey",
      connectedAddress,
    });
    setErr(null);
    if (!mySignerEntry) {
      setErr("you're not an owner of this Safe");
      return;
    }
    if (safeTx) {
      try {
        if (mySignerEntry.signerType === "passkey") {
          const identity = getStoredPasskeyIdentity(mySignerEntry.passkeyAddr ?? mySignerEntry.address);
          if (!identity?.credentialIdBase64Url) {
            setErr("missing passkey credentials — sign in with your passkey first");
            return;
          }
          setPasskeySigning(true);
          const data = await signSafeTxWithPasskey({
            credentialIdBase64Url: identity.credentialIdBase64Url,
            safeTxHash: tx.execHash as Hex,
            owner: mySignerEntry.address as `0x${string}`,
          });
          txSign(tx.id, { signer: mySignerEntry.address.toLowerCase(), sigType: 1, data });
        } else {
          if (!connectedAddress) {
            setErr("connect your wallet to sign");
            return;
          }
          // Wallets refuse EIP-712 whose domain chainId isn't the active chain.
          if (connectedChainId !== tx.chainId) await switchChainAsync({ chainId: tx.chainId });
          const sig = await signTypedDataAsync(safeTxTypedData(tx.chainId, wallet.address as AddressType, safeTx));
          txSign(tx.id, { signer: connectedAddress.toLowerCase(), sigType: 0, data: sig });
        }
      } catch (e) {
        setErr(String(e).slice(0, 200));
      } finally {
        setPasskeySigning(false);
      }
      return;
    }
    setErr("this is a leftover from the old multisig — remove it");
  }, [
    mySignerEntry,
    connectedAddress,
    signTypedDataAsync,
    connectedChainId,
    switchChainAsync,
    safeTx,
    wallet.address,
    tx.chainId,
    mesh,
    tx.id,
    tx.execHash,
  ]);

  // A tx with `calls` is a MultiSend batch; `calls` lists what's inside.
  const isBatchTx = !!tx.calls && tx.calls.length > 0;

  const onExecute = useCallback(async () => {
    setErr(null);
    if (!isSafe) return setErr("this is a leftover from the old multisig — remove it");
    setSponsoring(true);
    // A personal Safe brings its own sponsoredExecute; the Bank asks the relay.
    // Either way the relay broadcasts and pays gas; the Safe checks signatures.
    if (sponsoredExecute) {
      try {
        txStatus(tx.id, "executing");
        const hash = await sponsoredExecute(tx);
        setExecHash(hash);
        txStatus(tx.id, "executing", hash);
      } catch (e) {
        txStatus(tx.id, "pending");
        setErr((e instanceof Error ? e.message : String(e)).slice(0, 200));
      } finally {
        setSponsoring(false);
      }
      return;
    }
    try {
      const r = await fetch(withSlug(`${RELAY_HTTP}/v1/safe/exec`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txId: tx.id }),
      });
      if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `relay ${r.status}`);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setSponsoring(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx, isSafe, sponsoredExecute, slug]);
  // Wedgie owners sign from whichever computer the device is plugged into,
  // not tied to a room identity: the device's key picks the owner.
  const unsignedWedgies =
    isSafe && wedgieSupported()
      ? wallet.signers.filter(s => s.device === "wedgie" && !tx.signatures.some(g => g.signer === s.address))
      : [];
  const [wedgieSigning, setWedgieSigning] = useState(false);
  const onSignWedgie = useCallback(async () => {
    if (!safeTx) return;
    setErr(null);
    setWedgieSigning(true);
    try {
      await withWedgie(async w => {
        const k = await w.key();
        const owner = passkeyOwner(k.x, k.y).toLowerCase();
        if (!wallet.signers.some(s => s.address === owner)) throw new Error("This wedgie isn't an owner of this Safe.");
        const data = await w.sign(tx.chainId, wallet.address as AddressType, safeTx, tx.execHash as Hex);
        txSign(tx.id, { signer: owner, sigType: 1, data });
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWedgieSigning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeTx, wallet.signers, wallet.address, tx.chainId, tx.execHash, tx.id]);
  // Safe has no deadline: kill a signed-but-unwanted tx by proposing a
  // no-op at the same nonce. Whichever executes first wins (trap 1).
  const onCancelSafe = useCallback(() => {
    if (!safeTx) return;
    const c = cancelTx(wallet.address as AddressType, safeTx.nonce);
    mesh.walletProposeTx({
      chainId: tx.chainId,
      target: c.to,
      value: "0",
      data: c.data,
      deadline: "0",
      nonce: c.nonce.toString(),
      execHash: safeTxHash(tx.chainId, wallet.address as AddressType, c),
      operation: 0,
      source: "manual",
      ...(walletAddress ? { address: walletAddress } : {}),
    });
  }, [safeTx, wallet.address, mesh, tx.chainId, walletAddress]);

  const onResummarize = useCallback(() => {
    txResummarize(tx.id);
  }, [mesh, tx.id]);

  const valueEth = (() => {
    try {
      return formatEther(BigInt(tx.value));
    } catch {
      return tx.value;
    }
  })();
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 6,
        background: tx.status === "executed" ? "rgba(123,232,138,0.04)" : "rgba(255,255,255,0.025)",
        border: `1px solid ${tx.status === "executed" ? "rgba(123,232,138,0.25)" : "rgba(255,62,201,0.25)"}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 6,
        // Relative so the bottom-right [×] remove button can pin to
        // the card without disturbing the rest of the layout.
        position: "relative",
      }}
    >
      {/* Pinned bottom-right escape hatch — any signer can drop a
       *  pending tx without waiting for the stuck-executing timeout
       *  to surface the Try-again / Remove pair. Also shown on every
       *  card in the Recent section (compact mode) so finished txs
       *  can be cleared from the list. */}
      {tx.status === "pending" || compact ? (
        <button
          type="button"
          onClick={onRemoveTx}
          title={tx.status === "pending" ? "Drop this transaction from the queue." : "Clear from recent."}
          aria-label={tx.status === "pending" ? "Remove transaction" : "Clear from recent"}
          style={{
            position: "absolute",
            right: 6,
            bottom: 6,
            width: 22,
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "1px solid rgba(255,118,118,0.35)",
            color: "#ff9a9a",
            borderRadius: 3,
            cursor: "pointer",
            fontSize: 13,
            lineHeight: 1,
            opacity: 0.6,
            transition: "opacity 120ms",
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={e => (e.currentTarget.style.opacity = "0.6")}
        >
          ×
        </button>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          {tx.source === "browser" ? "from browser" : "manual"} · {tx.status}
        </span>
        <span style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
          {new Date(tx.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      {isBatchTx ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ color: "var(--slop-text-muted)" }}>batch</span>
            <span style={{ fontWeight: 600 }}>{(tx.calls ?? []).length} calls</span>
            <span style={{ color: "var(--slop-text-muted)" }}>·</span>
            <span>execBatchTransaction</span>
          </div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {(tx.calls ?? []).slice(0, compact ? 3 : 20).map((c, i) => {
              let v = "0";
              try {
                v = formatEther(BigInt(c.value));
              } catch {
                v = c.value;
              }
              return (
                <li
                  key={`${c.target}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    padding: "4px 6px",
                    background: "rgba(255,255,255,0.025)",
                    border: "1px solid rgba(255,62,201,0.14)",
                    borderRadius: 3,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>{i + 1}.</span>
                  <Address address={c.target as AddressType} size="xs" onlyEnsOrAddress />
                  <span style={{ color: "var(--slop-text-muted)" }}>·</span>
                  <span>{v} ETH</span>
                  {c.data && c.data !== "0x" ? (
                    <span style={{ color: "var(--slop-text-muted)", fontSize: 10, fontFamily: "monospace" }}>
                      data {c.data.slice(0, 10)}…
                    </span>
                  ) : null}
                </li>
              );
            })}
            {compact && (tx.calls ?? []).length > 3 ? (
              <li style={{ fontSize: 10, color: "var(--slop-text-muted)", paddingLeft: 6 }}>
                +{(tx.calls ?? []).length - 3} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ color: "var(--slop-text-muted)" }}>to</span>
          <Address address={tx.target as AddressType} size="xs" onlyEnsOrAddress />
          <span style={{ color: "var(--slop-text-muted)" }}>·</span>
          <span>{valueEth} ETH</span>
        </div>
      )}

      {tx.aiAnalysis ? (
        <LabeledSummaryBlock
          label=""
          raw={tx.aiAnalysis}
          accent="var(--slop-cyan, #3fcfff)"
          pendingHint="analyzing…"
          onRetry={onResummarize}
        />
      ) : (
        <LabeledSummaryBlock
          label="Proposed as"
          raw={tx.summary}
          accent="var(--slop-magenta, #ff3ec9)"
          pendingHint="summarizing…"
          onRetry={onResummarize}
        />
      )}

      {/* ERC-7730 clear signing: the deterministic "what you're approving"
       *  decoded from a registry descriptor, sitting between the AI opinion
       *  above and the raw calldata below. Full cards only (skips the compact
       *  recent-list to avoid a fetch per row). */}
      {!compact ? (
        <ClearSignPanel
          chainId={tx.chainId}
          target={tx.target}
          value={tx.value}
          data={tx.data}
          isBatch={isBatchTx}
          calls={isBatchTx ? tx.calls : undefined}
        />
      ) : null}

      {!compact && !isBatchTx ? (
        <details style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
          <summary style={{ cursor: "pointer", userSelect: "none" }}>raw calldata</summary>
          <div style={{ wordBreak: "break-all", fontFamily: "monospace", marginTop: 4 }}>{tx.data}</div>
        </details>
      ) : null}

      {tx.status === "executed" ? null : (
        <SignerCollectionBar
          wallet={wallet}
          tx={tx}
          peers={mesh.peers as Peer[]}
          customNames={mesh.customNames}
          myAddress={myLowerAddress || null}
          compact={compact}
        />
      )}

      {tx.status === "executing" || (tx.status === "pending" && execHash) ? (
        <TxProgressBar
          tx={tx}
          watchedHash={watchedHash}
          isWaiting={execWaiting}
          isError={execIsError}
          errorText={
            execError
              ? String((execError as { shortMessage?: string; message?: string }).shortMessage ?? execError)
              : null
          }
          onCheckNow={onManualCheck}
          checking={manualChecking}
          manualErr={manualErr}
        />
      ) : null}

      {err ? (
        <div
          style={{ fontSize: 10, color: "#ff7676", padding: 6, background: "rgba(255,118,118,0.08)", borderRadius: 3 }}
        >
          {err}
        </div>
      ) : null}

      {tx.status === "pending" ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button
            variant={enoughSigs ? undefined : "primary"}
            onClick={onSign}
            disabled={signing || passkeySigning || !isMySigner || hasMySig || !isSafe}
            title={
              !isSafe
                ? "A leftover from the old multisig — remove it."
                : !isMySigner
                  ? "You aren't an owner of this Safe."
                  : hasMySig
                    ? "You've already signed."
                    : isPasskeySigner
                      ? "Sign this transaction with your passkey."
                      : "Sign this transaction."
            }
          >
            {hasMySig ? "Signed" : signing || passkeySigning ? "Signing…" : "Sign"}
          </Button>
          <Button
            variant={enoughSigs ? "primary" : undefined}
            onClick={onExecute}
            disabled={sponsoring || execWaiting || !enoughSigs || !isSafe}
          >
            {execWaiting ? "Waiting…" : sponsoring ? "Submitting…" : "Execute"}
          </Button>
          {unsignedWedgies.length > 0 ? (
            <Button onClick={() => void onSignWedgie()} disabled={wedgieSigning} title="Press A on the wedgie to sign.">
              {wedgieSigning ? "Press A on the wedgie…" : "Sign with wedgie"}
            </Button>
          ) : null}
          {isSafe && !(tx.target.toLowerCase() === wallet.address.toLowerCase() && tx.data === "0x") ? (
            <Button
              onClick={onCancelSafe}
              title={`Propose a no-op at nonce ${tx.nonce}. Executing it kills this transaction for good.`}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ) : isStuckExecuting ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--slop-text-muted)", fontStyle: "italic" }}>
            stuck waiting for receipt
          </span>
          <Button onClick={onResetToPending} title="Reset to pending so signers can press Execute again.">
            Try again
          </Button>
          <Button onClick={onRemoveTx} title="Drop this transaction from the queue.">
            Remove
          </Button>
        </div>
      ) : tx.txHash ? (
        <a
          href={`${chainMeta(tx.chainId).explorer}/tx/${tx.txHash}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 10, color: "var(--slop-magenta, #ff3ec9)", textDecoration: "underline" }}
        >
          view on explorer
        </a>
      ) : null}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Tiny shared layout helpers
// ----------------------------------------------------------------------------

// A wedgie owner's avatar is the Wedgie app icon.
const WedgieTag = ({ label }: { label: string }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/icons/wedgie.png" alt="" width={18} height={18} style={{ imageRendering: "auto" }} />
    {label}
  </span>
);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <label
      style={{
        fontSize: 10,
        color: "var(--slop-text-muted)",
        fontFamily: "var(--slop-font-display)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </label>
    {children}
  </div>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div
      style={{
        fontSize: 10,
        color: "var(--slop-text-muted)",
        fontFamily: "var(--slop-font-display)",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        paddingBottom: 4,
        borderBottom: "1px dashed rgba(255,62,201,0.18)",
      }}
    >
      {title}
    </div>
    <div style={{ display: "flex", flexDirection: "column" }}>{children}</div>
  </div>
);

const AddSignerRow = ({
  disabled,
  existing,
  onAdd,
}: {
  disabled: boolean;
  existing: Set<string>;
  onAdd: (address: string) => void;
}) => {
  const [value, setValue] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const trimmed = value.trim();
  const resolved = /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
  const isDup = resolved && existing.has(resolved.toLowerCase());

  const add = () => {
    if (!resolved) {
      setHint("paste an address or type an ENS name (waiting for resolution…)");
      return;
    }
    if (isDup) {
      setHint("already in the signer list");
      return;
    }
    onAdd(resolved);
    setValue("");
    setHint(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
        <div style={{ flex: 1 }}>
          <AddressInput
            value={value}
            placeholder="0x… or vitalik.eth"
            disabled={disabled}
            onChange={next => {
              setValue(next ?? "");
              setHint(null);
            }}
          />
        </div>
        <button
          type="button"
          onClick={add}
          disabled={disabled || !resolved || !!isDup}
          style={{
            padding: "0 12px",
            fontSize: 11,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            background: !resolved || isDup ? "rgba(255,255,255,0.06)" : "var(--slop-magenta, #ff3ec9)",
            color: !resolved || isDup ? "var(--slop-text-muted)" : "#06030d",
            border: "none",
            borderRadius: 4,
            cursor: !resolved || isDup ? "not-allowed" : "pointer",
            fontWeight: 700,
          }}
        >
          Add
        </button>
      </div>
      {hint ? <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>{hint}</div> : null}
    </div>
  );
};

export default WalletWindow;
