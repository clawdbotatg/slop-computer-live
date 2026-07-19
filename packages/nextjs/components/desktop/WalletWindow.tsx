"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address, AddressInput } from "@scaffold-ui/components";
import {
  type Address as AddressType,
  type Hex,
  decodeEventLog,
  encodeAbiParameters,
  formatEther,
  parseAbiParameters,
} from "viem";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "viem/chains";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSignMessage,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { ClearSignPanel } from "~~/components/desktop/wallet/ClearSignPanel";
import { TokenAvatar } from "~~/components/desktop/wallet/TokenAvatar";
import { WalletAssetsPanel } from "~~/components/desktop/wallet/WalletAssetsPanel";
import { WalletChatPanel } from "~~/components/desktop/wallet/WalletChatPanel";
import { WalletHeader } from "~~/components/desktop/wallet/WalletHeader";
import type { Portfolio } from "~~/components/desktop/wallet/types";
import { Button, LoadingBar, SlopAddress, TextField } from "~~/components/ui";
import { FACTORY_ADDRESS, MultisigAbi, MultisigFactoryAbi, type WalletSignature } from "~~/contracts/multisig";
import type { Peer, PeerMeshState, WalletRecord, WalletTx } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";
import { useSyncedUIState } from "~~/hooks/useSyncedUIState";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { robinhood } from "~~/scaffold.config";
import { saltFromLabel, sortSignatures } from "~~/utils/multisig";
import { getStoredPasskeyIdentity, signMultisigExecWithPasskey } from "~~/utils/passkey";

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

// The chains the multisig factory is deployed on (same address each).
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

  // Reset + refetch when the multisig address changes (new episode /
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
  // — they never show up in mesh.walletTxs (those are multisig-initiated)
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
      {/* Assets tab — read-only portfolio + activity for the multisig. */}
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
      {/* Transactions tab body — dedicated to the multisig queue (txs
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

  // Host detection — the host's wallet is what signs createMultisig, so
  // the predicted address depends on their address (not whoever's
  // viewing). Non-hosts see a disabled Deploy button.
  const hostPeer = useMemo(
    () => (mesh.peers as Peer[]).find(p => p.role === "host" && !!p.address) ?? null,
    [mesh.peers],
  );
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
    for (const c of draftOrDefault.customSigners) {
      const lower = c.address.toLowerCase();
      if (!out.has(lower)) out.set(lower, { address: lower, label: c.label, isMe: false, source: "custom" });
    }
    return Array.from(out.values()).sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      const rank = (s: Candidate["source"]) => (s === "me" ? 0 : s === "peer" ? 1 : 2);
      return rank(a.source) - rank(b.source);
    });
  }, [mesh.peers, mesh.myId, myAddress, myHandle, draftOrDefault.customSigners, mesh.customNames]);

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

  // After deploy, signers/threshold/salt/label are locked into the
  // wallet record. Before deploy, they come from the shared draft and
  // the deployer is the *host's* address — so all peers compute the
  // same predicted CREATE2 address regardless of who's viewing.
  const effectiveDeployer = existing
    ? (existing.deployer as AddressType)
    : ((hostPeer?.address as AddressType | undefined) ?? null);
  const effectiveLabel = existing ? existing.label : draftOrDefault.label;
  const effectiveSalt = useMemo(() => {
    if (existing) return existing.salt as Hex;
    return saltFromLabel(`${effectiveDeployer ?? "0x0"}:${effectiveLabel}`);
  }, [existing, effectiveDeployer, effectiveLabel]);
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
        signerType: s.passkey ? "passkey" : "eoa",
      };
      if (s.passkey) {
        base.qx = s.passkey.qx as `0x${string}`;
        base.qy = s.passkey.qy as `0x${string}`;
        base.credentialIdHash = s.passkey.credentialIdHash as `0x${string}`;
      }
      return base;
    });
  }, [existing, selectedSigners]);
  const effectiveThreshold = existing ? existing.threshold : draftOrDefault.threshold;

  // Predicted multisig address. Deterministic + identical on every chain the
  // factory is deployed to, so we pin the read to one known-deployed chain.
  // Must be a chain where the CURRENT factory version actually has code — v2+
  // factories are Base-only (v1 was everywhere incl. mainnet), so reading on
  // mainnet would hit a codeless address and hang at "computing".
  const { data: predicted } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: MultisigFactoryAbi,
    functionName: "getMultisigAddress",
    args: effectiveDeployer ? [effectiveDeployer, effectiveSalt] : undefined,
    chainId: base.id,
    query: { enabled: !!effectiveDeployer },
  });
  const predictedAddress = (existing?.address ?? predicted ?? null) as AddressType | null;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      {existing ? (
        <DeployedSummary
          wallet={existing}
          customNames={mesh.customNames}
          myAddress={myAddress}
          onArchive={() => mesh.walletNewEpisode()}
        />
      ) : (
        <>
          <div>
            <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", letterSpacing: "0.08em" }}>
              Deploy session wallet
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--slop-text-muted)" }}>
              Spin up a multisig for this episode. The address is identical on every chain — deploy it on any of the
              networks below now, then come back and add more later.
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
                      <SlopAddress address={s.address} customNames={mesh.customNames} />
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

          <Field label="Predicted address">
            <div style={{ fontSize: 12 }}>
              {predictedAddress ? (
                <Address address={predictedAddress} size="sm" />
              ) : !effectiveDeployer ? (
                <span style={{ color: "var(--slop-text-muted)" }}>
                  waiting for host (deploys go through their wallet so the address is the same for everyone)
                </span>
              ) : (
                <span style={{ color: "var(--slop-text-muted)" }}>computing…</span>
              )}
            </div>
          </Field>
        </>
      )}

      <Section title="Networks">
        <p style={{ fontSize: 11, color: "var(--slop-text-muted)", margin: "0 0 8px" }}>
          Deploy the multisig on the chains you need. The address is the same everywhere — funding the address before
          deploying works too; you just can&apos;t execute txs on a chain until <code>createMultisig</code> runs there.
          {!isHost ? " Only the host can deploy — their wallet pays gas and signs createMultisig." : null}
        </p>
        <ChainGrid
          mesh={mesh}
          existing={existing}
          predicted={predictedAddress}
          deployer={effectiveDeployer}
          salt={effectiveSalt}
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
          const isMe = myLower && s.address.toLowerCase() === myLower;
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
              <SlopAddress address={s.address} customNames={customNames} />
              {isMe ? <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>(you)</span> : null}
              {s.signerType === "passkey" ? (
                <span
                  style={{ color: "var(--slop-text-muted)", fontSize: 10 }}
                  title="passkey signer address — do not send funds here"
                >
                  · passkey ({short(s.address)})
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
// ChainGrid — one row per supported chain. Each row figures out its
// own deployed-or-not status via either the wallet record or eth_getCode,
// and renders either an explorer link or a [ deploy ] button.
// ============================================================================

type ChainGridProps = {
  mesh: PeerMeshState;
  existing: WalletRecord | null;
  predicted: AddressType | null;
  deployer: AddressType | null;
  salt: Hex;
  signers: ResolvedSigner[];
  threshold: number;
  label: string;
  /** Local user can submit a deploy tx. False for non-hosts — the
   *  button still renders but is disabled with a "host only" tooltip. */
  canDeploy: boolean;
};

const ChainGrid = ({
  mesh,
  existing,
  predicted,
  deployer,
  salt,
  signers,
  threshold,
  label,
  canDeploy,
}: ChainGridProps) => {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {SUPPORTED_CHAINS.map(c => (
        <ChainRow
          key={c.id}
          chainId={c.id}
          chainLabel={c.label}
          explorer={c.explorer}
          mesh={mesh}
          existing={existing}
          predicted={predicted}
          deployer={deployer}
          salt={salt}
          signers={signers}
          threshold={threshold}
          label={label}
          canDeploy={canDeploy}
        />
      ))}
    </ul>
  );
};

type ChainRowProps = {
  chainId: number;
  chainLabel: string;
  explorer: string;
  mesh: PeerMeshState;
  existing: WalletRecord | null;
  predicted: AddressType | null;
  deployer: AddressType | null;
  salt: Hex;
  signers: ResolvedSigner[];
  threshold: number;
  label: string;
  canDeploy: boolean;
};

const ChainRow = ({
  chainId,
  chainLabel,
  explorer,
  mesh,
  existing,
  predicted,
  deployer,
  salt,
  signers,
  threshold,
  label,
  canDeploy,
}: ChainRowProps) => {
  const connectedChainId = useChainId() ?? mainnet.id;
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { writeContractAsync, isPending: writePending } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const {
    isLoading: receiptLoading,
    data: receipt,
    isError: receiptIsError,
    error: receiptErr,
  } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId,
    // App-wide pollingInterval is 30s (set in scaffold.config) which is
    // fine for ambient state but makes "waiting for deploy receipt"
    // feel broken. Override to 2s for this specific wait — once we have
    // a hash, the user just wants to see it land.
    pollingInterval: 2000,
  });
  const [err, setErr] = useState<string | null>(null);

  // Self-predict on this chain as a backup. The parent computes the
  // predicted address via mainnet RPC (factory at same address on every
  // chain so the answer's identical) — but if mainnet RPC is slow or
  // down at the moment we need it, having a second source pinned to
  // *this* chain's RPC means we still know where the multisig will land.
  const { data: selfPredicted } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: MultisigFactoryAbi,
    functionName: "getMultisigAddress",
    args: deployer ? [deployer, salt] : undefined,
    chainId,
    query: { enabled: !!deployer },
  });
  const localPredicted = (predicted ?? (selfPredicted as AddressType | undefined) ?? null) as AddressType | null;

  // Code probe: does contract bytecode already exist at the predicted
  // address on this chain? If so, someone already deployed it — even if
  // we don't have a record locally. Used to gate the deploy button and
  // to surface the [Register] affordance when the receipt path missed.
  const publicClient = usePublicClient({ chainId });
  const [hasCode, setHasCode] = useState<boolean | null>(null);
  const probeKey = localPredicted ? `${chainId}:${localPredicted.toLowerCase()}` : null;
  useEffect(() => {
    if (!publicClient || !localPredicted) {
      setHasCode(null);
      return;
    }
    let cancelled = false;
    publicClient
      .getBytecode({ address: localPredicted })
      .then(code => {
        if (cancelled) return;
        setHasCode(!!code && code !== "0x");
      })
      .catch(() => {
        if (!cancelled) setHasCode(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey]);

  // Detect which non-passkey signers are nested Multisigs → they must be
  // registered as ERC-1271 `contractSigners`, not EOAs, or the multisig can
  // never verify their nested signatures.
  //
  // We probe `signerCount()` rather than just checking for on-chain code:
  // an EIP-7702-delegated EOA (e.g. a MetaMask smart account) HAS code but is
  // still an EOA that signs with ECDSA — `getBytecode` would misclassify it as
  // a contract signer (and break EOA signing). A slop Multisig answers
  // signerCount(); a 7702 EOA / random contract reverts. Only relevant
  // pre-deploy (an `existing` wallet trusts its persisted signer types).
  const [contractSignerAddrs, setContractSignerAddrs] = useState<Set<string>>(new Set());
  const candidateContractAddrs = useMemo(
    () => signers.filter(s => s.signerType !== "passkey").map(s => s.address.toLowerCase()),
    [signers],
  );
  const contractProbeKey = `${chainId}:${candidateContractAddrs.join(",")}`;
  useEffect(() => {
    if (existing || !publicClient || candidateContractAddrs.length === 0) {
      setContractSignerAddrs(new Set());
      return;
    }
    let cancelled = false;
    Promise.all(
      candidateContractAddrs.map(async addr => {
        try {
          // A slop Multisig responds to signerCount(); EOAs (incl. 7702) revert.
          await publicClient.readContract({
            address: addr as AddressType,
            abi: MultisigAbi,
            functionName: "signerCount",
          });
          return addr;
        } catch {
          return null;
        }
      }),
    ).then(results => {
      if (cancelled) return;
      setContractSignerAddrs(new Set(results.filter((a): a is string => a !== null)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractProbeKey, existing]);

  // Effective signer type for one signer, upgrading detected contracts to
  // erc1271. Used by both the createMultisig partition and the WalletRecord.
  const effectiveSignerType = useCallback(
    (s: ResolvedSigner): ResolvedSigner["signerType"] =>
      s.signerType !== "passkey" && contractSignerAddrs.has(s.address.toLowerCase()) ? "erc1271" : s.signerType,
    [contractSignerAddrs],
  );

  // Did we already record a deployment for this chain?
  const localDep = existing?.deployments[chainId] ?? null;
  const alreadyDeployedOnChain = !!localDep || hasCode === true;

  // When a deploy lands, tell the relay so every peer sees the new chain
  // entry. Also retro-fill the WalletRecord on the very first deploy
  // (no existing wallet → we need to call walletDeploy with the full
  // record; subsequent deploys use walletAddDeployment).
  useEffect(() => {
    if (!receipt) return;
    if (receipt.status !== "success") {
      setErr("deploy tx reverted");
      setTxHash(null);
      return;
    }
    if (existing) {
      mesh.walletAddDeployment(chainId, receipt.transactionHash);
    } else {
      // First-ever deploy — build the full WalletRecord. We try to
      // pull the multisig address from the MultisigCreated event log
      // (canonical), but the address is also CREATE2-deterministic
      // from (deployer, salt), so we fall back to the predicted value
      // if log decoding fails. This makes the deploy path resilient
      // to flaky RPC responses that drop or mangle event logs — the
      // tx confirmed, the contract is live; we shouldn't lose the
      // wallet record over a parse error.
      try {
        let multisigAddr: AddressType | null = null;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({
              abi: MultisigFactoryAbi,
              data: log.data,
              topics: log.topics,
              strict: false,
            });
            if (decoded.eventName === "MultisigCreated") {
              multisigAddr = (decoded.args as { multisig: AddressType }).multisig;
              break;
            }
          } catch (logErr) {
            console.warn("[wallet] failed to decode factory log; will try next", logErr);
          }
        }
        if (!multisigAddr) {
          const fallback = localPredicted;
          if (fallback) {
            console.warn(
              "[wallet] MultisigCreated event not found in receipt; falling back to CREATE2-predicted address",
              { chainId, txHash: receipt.transactionHash, predicted: fallback },
            );
            multisigAddr = fallback;
          } else {
            setErr("Deploy confirmed but couldn't determine multisig address (no event log, no prediction)");
            setTxHash(null);
            return;
          }
        }
        if (!deployer) {
          setErr("missing deployer");
          setTxHash(null);
          return;
        }
        const record: WalletRecord = {
          id: Math.random().toString(36).slice(2),
          address: multisigAddr.toLowerCase(),
          deployer: deployer.toLowerCase(),
          salt,
          signers: signers.map(s => ({
            address: s.address.toLowerCase(),
            label: s.label,
            signerType: effectiveSignerType(s),
            ...(s.qx ? { qx: s.qx } : {}),
            ...(s.qy ? { qy: s.qy } : {}),
            ...(s.credentialIdHash ? { credentialIdHash: s.credentialIdHash } : {}),
          })),
          threshold,
          deployments: {
            [chainId]: { txHash: receipt.transactionHash, deployedAt: Date.now() },
          },
          createdAt: Date.now(),
          label,
        };
        mesh.walletDeploy(record);
      } catch (e) {
        console.warn("[wallet] post-receipt walletDeploy failed", e);
        setErr(String(e).slice(0, 200));
      }
    }
    setTxHash(null);
    // We deliberately key only on the receipt landing — every other
    // input is captured at the time the deploy fired.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt]);

  const onDeploy = useCallback(async () => {
    setErr(null);
    if (!canDeploy) {
      // The button is disabled when !canDeploy, but belt-and-braces:
      // also short-circuit the handler in case the button is reached
      // via a programmatic click (e.g. dev tools).
      setErr("only the host can deploy");
      return;
    }
    if (!deployer) {
      setErr("connect wallet first");
      return;
    }
    if (signers.length === 0) {
      setErr("pick at least one signer");
      return;
    }
    // Partition the resolved signer set into the contract's two
    // parallel arrays. A passkey signer is one we have full pubkey data for
    // (qx + qy + credentialIdHash); everything else (EOA, 7702 smart account,
    // Safe, nested Multisig) is an "account" signer — v4 validates those
    // polymorphically (ECDSA-or-ERC1271), so they all go in one array and the
    // contract never needs to know which kind at registration.
    const accounts: AddressType[] = [];
    const passkeyQxs: `0x${string}`[] = [];
    const passkeyQys: `0x${string}`[] = [];
    const credentialIdHashes: `0x${string}`[] = [];
    for (const s of signers) {
      if (s.signerType === "passkey" && s.qx && s.qy && s.credentialIdHash) {
        passkeyQxs.push(s.qx);
        passkeyQys.push(s.qy);
        credentialIdHashes.push(s.credentialIdHash);
      } else {
        accounts.push(s.address);
      }
    }
    try {
      if (connectedChainId !== chainId) {
        await switchChainAsync({ chainId });
      }
      const hash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: MultisigFactoryAbi,
        functionName: "createMultisig",
        chainId,
        // args: accounts, passkeyQxs, passkeyQys, credentialIdHashes, threshold, salt
        args: [accounts, passkeyQxs, passkeyQys, credentialIdHashes, BigInt(threshold), salt],
      });
      setTxHash(hash);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  }, [canDeploy, deployer, signers, connectedChainId, chainId, switchChainAsync, writeContractAsync, threshold, salt]);

  const busy = writePending || receiptLoading || switching;

  // Recovery path: bytecode exists at the predicted address on this
  // chain but we have no record. Either a previous deploy receipt
  // never closed the loop (RPC flake) or someone deployed off-app.
  // Host clicks [ Register ] to construct the WalletRecord from the
  // current form + the predicted address. Same as the normal post-
  // receipt path, just without the receipt.
  const onRegister = useCallback(() => {
    setErr(null);
    if (!canDeploy) return;
    if (!localPredicted || !deployer) {
      setErr("missing predicted address or deployer");
      return;
    }
    if (existing) {
      mesh.walletAddDeployment(chainId, null);
      return;
    }
    const record: WalletRecord = {
      id: Math.random().toString(36).slice(2),
      address: localPredicted.toLowerCase(),
      deployer: deployer.toLowerCase(),
      salt,
      signers: signers.map(s => ({
        address: s.address.toLowerCase(),
        label: s.label,
        signerType: effectiveSignerType(s),
        ...(s.qx ? { qx: s.qx } : {}),
        ...(s.qy ? { qy: s.qy } : {}),
        ...(s.credentialIdHash ? { credentialIdHash: s.credentialIdHash } : {}),
      })),
      threshold,
      deployments: { [chainId]: { txHash: null, deployedAt: Date.now() } },
      createdAt: Date.now(),
      label,
    };
    mesh.walletDeploy(record);
  }, [
    canDeploy,
    localPredicted,
    deployer,
    existing,
    chainId,
    salt,
    signers,
    threshold,
    label,
    mesh,
    effectiveSignerType,
  ]);

  const statusNode = (() => {
    if (alreadyDeployedOnChain) {
      // Already deployed (either we have a record, or eth_getCode found
      // bytecode at the address from some prior deploy).
      const link = localDep?.txHash
        ? `${explorer}/tx/${localDep.txHash}`
        : localPredicted
          ? `${explorer}/address/${localPredicted}`
          : null;
      const txt = localDep ? "already deployed" : "already deployed (on-chain)";
      const orphaned = hasCode === true && !localDep;
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#7be88a", fontSize: 11 }}>✓ {txt}</span>
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 10,
                color: "var(--slop-magenta, #ff3ec9)",
                textDecoration: "underline",
              }}
            >
              view
            </a>
          ) : null}
          {orphaned && canDeploy ? (
            <Button
              onClick={onRegister}
              title="The contract is on-chain but we don't have a wallet record yet — click to register it from this chain."
            >
              Register
            </Button>
          ) : null}
        </div>
      );
    }
    return (
      <Button
        variant="primary"
        onClick={onDeploy}
        disabled={busy || !deployer || signers.length === 0 || !canDeploy}
        title={
          !canDeploy
            ? "Only the host can deploy. The host's wallet pays gas and signs createMultisig — that's what makes the address the same for everyone."
            : !deployer
              ? "Waiting for the host to connect their wallet."
              : signers.length === 0
                ? "Pick at least one signer."
                : undefined
        }
      >
        {switching
          ? "Switching…"
          : writePending
            ? "Confirm…"
            : receiptLoading
              ? "Waiting…"
              : !canDeploy
                ? "Deploy (host only)"
                : "Deploy"}
      </Button>
    );
  })();

  return (
    <li
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        background: alreadyDeployedOnChain ? "rgba(123,232,138,0.04)" : "rgba(255,255,255,0.025)",
        border: `1px solid ${alreadyDeployedOnChain ? "rgba(123,232,138,0.25)" : "rgba(255,62,201,0.18)"}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.06em",
              fontSize: 13,
              color: "var(--slop-text)",
            }}
          >
            {chainLabel}
          </div>
          <div style={{ fontSize: 10, color: "var(--slop-text-muted)", marginTop: 2 }}>chain {chainId}</div>
        </div>
        {statusNode}
      </div>
      {txHash ? (
        <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
          tx{" "}
          <a
            href={`${explorer}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            style={{
              color: "var(--slop-magenta, #ff3ec9)",
              textDecoration: "underline",
              fontFamily: "monospace",
              wordBreak: "break-all",
            }}
          >
            {txHash.slice(0, 10)}…{txHash.slice(-6)}
          </a>{" "}
          {receipt ? "confirmed" : receiptIsError ? "failed" : "waiting…"}
        </div>
      ) : null}
      {receiptIsError ? (
        <div style={{ fontSize: 10, color: "#ff7676" }}>{receiptErr?.message?.slice(0, 160) ?? "wait failed"}</div>
      ) : null}
      {err ? (
        <div
          style={{ fontSize: 10, color: "#ff7676", padding: 4, background: "rgba(255,118,118,0.08)", borderRadius: 3 }}
        >
          {err}
        </div>
      ) : null}
      {writePending || receiptLoading ? (
        <LoadingBar
          caption={writePending ? "confirm in wallet…" : receiptLoading ? "waiting for inclusion…" : "finalizing…"}
        />
      ) : null}
    </li>
  );
};

// ============================================================================
// Activity tx queue — per-chain pending + recent multisig txs. The
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

// "out" = leaving the multisig (magenta loss-side), "in" = arriving
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
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const { writeContractAsync, isPending: writing } = useWriteContract();
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
  // useSignMessage.isPending only covers the EOA path; we track this
  // ourselves so the Sign button stays disabled during the OS sheet
  // and doesn't double-prompt on a stray click.
  const [passkeySigning, setPasskeySigning] = useState(false);
  // True while a gas-sponsored facilitator broadcast is in flight (the passkey
  // personal-wallet path). The EOA path tracks this via wagmi's `writing`;
  // sponsored exec has no writeContract, so we track it ourselves.
  const [sponsoring, setSponsoring] = useState(false);

  // Identify the local user against the wallet's registered signers.
  // For EOA signers we need the wagmi-connected address; for passkey
  // signers we use the relay session's `myAddress` (the passkey-derived
  // identity). Trying both lets one browser participate as either kind.
  const lowerCandidates = [connectedAddress?.toLowerCase(), myAddress?.toLowerCase()].filter((a): a is string => !!a);
  const mySignerEntry = wallet.signers.find(s => lowerCandidates.includes(s.address.toLowerCase())) ?? null;
  const myLowerAddress = mySignerEntry?.address.toLowerCase() ?? "";
  const isMySigner = !!mySignerEntry;
  const isPasskeySigner = mySignerEntry?.signerType === "passkey";
  const hasMySig = !!myLowerAddress && tx.signatures.some(s => s.signer.toLowerCase() === myLowerAddress);
  const enoughSigs = tx.signatures.length >= wallet.threshold;

  // Nested-multisig (ERC-1271) wiring.
  // - This wallet's registered contract signers (e.g. another slop wallet).
  const contractSignerEntries = wallet.signers.filter(s => s.signerType === "erc1271");
  const unsignedContractSigners = contractSignerEntries.filter(
    cs => !tx.signatures.some(sig => sig.signer.toLowerCase() === cs.address.toLowerCase()),
  );
  // - This tx is an ATTESTATION request: it lives in the contract signer's
  //   room and, once threshold is met, its blob routes back to the outer tx.
  //   Signable here, never executed here.
  const isAttestation = !!tx.attestationFor;
  // v3: a contract signer can attest via EITHER its passkey OR its EOA signer.
  // The EOA uses normal personal_sign (prefixed); the v3 contract's
  // isValidSignature accepts that for nested signers, so no raw signing needed.

  // Once an attestation reaches this wallet's threshold, assemble the
  // ERC-1271 blob from the collected signatures and route it back to the
  // outer wallet's tx. Guarded so we send exactly once per tx.
  const nestedResultSentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isAttestation || !tx.attestationFor) return;
    if (tx.signatures.length < wallet.threshold) return;
    if (nestedResultSentRef.current.has(tx.id)) return;
    try {
      const sorted = sortSignatures(
        tx.signatures.map<WalletSignature>(s => ({
          sigType: s.sigType,
          signer: s.signer as `0x${string}`,
          data: s.data as `0x${string}`,
        })),
      );
      const blob = encodeAbiParameters(parseAbiParameters("(uint8 sigType, address signer, bytes data)[]"), [sorted]);
      nestedResultSentRef.current.add(tx.id);
      mesh.walletSendNestedResult({
        outerSlug: tx.attestationFor.outerSlug,
        outerTxId: tx.attestationFor.outerTxId,
        signerWallet: wallet.address,
        blob,
      });
    } catch (e) {
      console.error("[wallet] nested result assembly failed", e);
    }
  }, [isAttestation, tx.attestationFor, tx.signatures, tx.id, wallet.threshold, wallet.address, mesh]);

  const onRequestNested = useCallback(
    (signerWallet: string) => {
      mesh.walletRequestNestedSig({
        signerWallet,
        outerWallet: wallet.address,
        outerLabel: wallet.label,
        outerTxId: tx.id,
        chainId: tx.chainId,
        execHash: tx.execHash,
        deadline: tx.deadline,
        target: tx.target,
        value: tx.value,
        data: tx.data,
        ...(tx.calls && tx.calls.length > 0 ? { calls: tx.calls } : {}),
      });
    },
    [
      mesh,
      wallet.address,
      wallet.label,
      tx.id,
      tx.chainId,
      tx.execHash,
      tx.deadline,
      tx.target,
      tx.value,
      tx.data,
      tx.calls,
    ],
  );

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
      console.warn("[wallet] onSign abort: not a signer on this multisig");
      setErr("you're not a signer on this multisig");
      return;
    }
    if (mySignerEntry.signerType === "passkey") {
      // Passkey path: locate the credential locally (we stashed it after
      // /auth/passkey), prompt the authenticator, ABI-encode the result.
      const identity = getStoredPasskeyIdentity(mySignerEntry.address);
      const qx = (mySignerEntry.qx ?? identity?.qx) as `0x${string}` | undefined;
      const qy = (mySignerEntry.qy ?? identity?.qy) as `0x${string}` | undefined;
      const credentialIdBase64Url = identity?.credentialIdBase64Url;
      if (!qx || !qy || !credentialIdBase64Url) {
        setErr("missing passkey credentials — sign in with your passkey first");
        return;
      }
      setPasskeySigning(true);
      try {
        console.log("[wallet] onSign passkey: prompting authenticator…");
        const data = await signMultisigExecWithPasskey({
          credentialIdBase64Url,
          execHash: tx.execHash as `0x${string}`,
          qx,
          qy,
        });
        console.log("[wallet] onSign passkey: got signature", { len: data?.length });
        txSign(tx.id, { signer: mySignerEntry.address.toLowerCase(), sigType: 1, data });
      } catch (e) {
        console.error("[wallet] onSign passkey error", e);
        setErr(String(e).slice(0, 200));
      } finally {
        setPasskeySigning(false);
      }
      return;
    }
    // EOA path — needs the wagmi wallet. Works for both normal txs and
    // attestations: signMessage produces a personal_sign-prefixed signature,
    // which the v3 contract's isValidSignature accepts for nested signers
    // (no raw / eth_sign — MetaMask-safe).
    if (!connectedAddress) {
      console.warn("[wallet] onSign abort: no connected EOA");
      setErr("connect your wallet to sign");
      return;
    }
    try {
      console.log("[wallet] onSign EOA: calling signMessageAsync…");
      const sig = await signMessageAsync({ message: { raw: tx.execHash as Hex } });
      console.log("[wallet] onSign EOA: got signature", { len: sig?.length });
      txSign(tx.id, { signer: connectedAddress.toLowerCase(), sigType: 0, data: sig });
    } catch (e) {
      console.error("[wallet] onSign EOA error", e);
      setErr(String(e).slice(0, 200));
    }
  }, [mySignerEntry, connectedAddress, signMessageAsync, mesh, tx.id, tx.execHash, isAttestation]);

  // A tx with `calls` is a batched proposal — exec goes through
  // execBatchTransaction instead of execTransaction. The top-level
  // target/value/data are sentinels and ignored here.
  const isBatchTx = !!tx.calls && tx.calls.length > 0;

  const onExecute = useCallback(async () => {
    const t0 = performance.now();
    console.log("[wallet] onExecute clicked", {
      txId: tx.id,
      status: tx.status,
      chainId: tx.chainId,
      isBatchTx,
      callsCount: tx.calls?.length ?? 0,
      sigs: tx.signatures.length,
      threshold: wallet.threshold,
      connectedAddress,
      multisig: wallet.address,
      deadline: tx.deadline,
      hasPublicClient: !!txPublicClient,
    });
    setErr(null);
    // Gas-sponsored path (passkey personal wallet): no connected EOA. The relay
    // facilitator broadcasts execTransaction + pays gas using the tx's
    // already-collected signatures (threshold 1, the passkey sig was gathered
    // when this tx was signed in the queue). The receipt watcher below picks up
    // the resulting hash exactly as it does for the EOA path.
    if (sponsoredExecute) {
      if (isBatchTx) {
        console.warn("[wallet] onExecute: batch tx not sponsored", { txId: tx.id, calls: tx.calls?.length });
        setErr("Batch transactions aren't gas-sponsored yet — coming soon.");
        return;
      }
      setSponsoring(true);
      try {
        txStatus(tx.id, "executing");
        const hash = await sponsoredExecute(tx);
        console.log("[wallet] onExecute sponsored: facilitator broadcast", { txId: tx.id, hash });
        setExecHash(hash);
        txStatus(tx.id, "executing", hash);
      } catch (e) {
        console.error("[wallet] onExecute sponsored FAILED", { txId: tx.id, err: e });
        txStatus(tx.id, "pending");
        setErr((e instanceof Error ? e.message : String(e)).slice(0, 200));
      } finally {
        setSponsoring(false);
      }
      return;
    }
    if (!connectedAddress) {
      console.warn("[wallet] onExecute abort: no connected wallet");
      setErr("connect your wallet to execute");
      return;
    }
    try {
      const sorted = sortSignatures(
        tx.signatures.map<WalletSignature>(s => ({
          sigType: s.sigType,
          signer: s.signer as `0x${string}`,
          data: s.data as `0x${string}`,
        })),
      );
      console.log("[wallet] onExecute sorted signatures", {
        sorted: sorted.map(s => ({ signer: s.signer, sigType: s.sigType, dataLen: s.data.length })),
      });
      txStatus(tx.id, "executing");
      // Estimate gas with a 50% buffer. eth_estimateGas returns the minimum
      // viable amount, but the 63/64 forwarding rule plus heavy inner calls
      // (LI.FI swaps, multi-hop bridges) starve the inner frame if we don't
      // overshoot the outer limit. A 1.5x multiplier matches what wallets
      // like Safe use for the same reason. 800k floor in case estimate
      // is wildly off — txs that need more than 800k still get the 1.5x.
      const functionName = isBatchTx ? "execBatchTransaction" : "execTransaction";
      const args = isBatchTx
        ? ([
            (tx.calls ?? []).map(c => ({
              target: c.target as AddressType,
              value: BigInt(c.value),
              data: c.data as Hex,
            })),
            BigInt(tx.deadline),
            sorted,
          ] as const)
        : ([tx.target as AddressType, BigInt(tx.value), tx.data as Hex, BigInt(tx.deadline), sorted] as const);
      console.log("[wallet] onExecute prepared args", {
        functionName,
        argShapeLen: args.length,
        batchCalls: isBatchTx ? tx.calls : undefined,
        singleTarget: !isBatchTx ? tx.target : undefined,
        singleValue: !isBatchTx ? tx.value : undefined,
      });
      let gasLimit: bigint | undefined;
      if (txPublicClient && connectedAddress) {
        const tEst = performance.now();
        try {
          console.log("[wallet] onExecute estimateContractGas: START");
          const estimate = await txPublicClient.estimateContractGas({
            address: wallet.address as AddressType,
            abi: MultisigAbi,
            functionName,
            // viem's overload inference can't keep up with the union of
            // args shapes here, so we widen at the call site — the
            // runtime branches above guarantee the right shape.
            args: args as never,
            account: connectedAddress as AddressType,
          });
          // Batch txs do more work — give them a fatter floor. Single
          // txs keep the 800k floor that was tuned for swaps.
          const minFloor = isBatchTx ? 1_500_000n : 800_000n;
          const buffered = (estimate * 3n) / 2n;
          gasLimit = buffered < minFloor ? minFloor : buffered;
          console.log("[wallet] onExecute estimateContractGas: OK", {
            ms: Math.round(performance.now() - tEst),
            estimate: estimate.toString(),
            buffered: buffered.toString(),
            gasLimit: gasLimit.toString(),
          });
        } catch (estErr) {
          // If estimate fails (sometimes happens with revert-prone calldata),
          // fall back to a high fixed limit so the signer can still try.
          gasLimit = isBatchTx ? 3_000_000n : 1_500_000n;
          console.warn("[wallet] onExecute estimateContractGas FAILED — using fallback gas", {
            ms: Math.round(performance.now() - tEst),
            gasLimit: gasLimit.toString(),
            err: estErr,
          });
        }
      } else {
        console.warn("[wallet] onExecute: no public client for gas estimate — wallet will pick a default", {
          chainId: tx.chainId,
        });
      }
      // Make sure the wallet is actually ON the tx's chain before writing.
      // wagmi's writeContract throws "current chain (id: X) does not match
      // the target chain" if they differ — it does NOT auto-switch. The
      // slop UI's network selectors are app-level and don't move the wallet,
      // so a signer whose MetaMask sits on another chain (e.g. Gnosis) would
      // otherwise hit that error even with "Base" selected everywhere.
      if (connectedChainId !== tx.chainId) {
        console.log("[wallet] onExecute switching wallet chain", {
          from: connectedChainId,
          to: tx.chainId,
        });
        await switchChainAsync({ chainId: tx.chainId });
      }
      console.log("[wallet] onExecute writeContractAsync: START (expect wallet popup now)", {
        gasLimit: gasLimit?.toString(),
        chainId: tx.chainId,
      });
      const tWrite = performance.now();
      const hash = await writeContractAsync({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName,
        chainId: tx.chainId,
        args: args as never,
        gas: gasLimit,
      });
      console.log("[wallet] onExecute writeContractAsync: OK", {
        ms: Math.round(performance.now() - tWrite),
        totalMs: Math.round(performance.now() - t0),
        hash,
      });
      setExecHash(hash);
      // Broadcast the hash NOW so every peer's TxProgressBar can show
      // it (with explorer link) and every peer's poller can race to
      // resolve the receipt. Previously the hash was only broadcast
      // on receipt — meaning if the submitter's tab stalled, nobody
      // else had the hash to recover from.
      txStatus(tx.id, "executing", hash);
    } catch (e) {
      console.error("[wallet] onExecute FAILED", {
        totalMs: Math.round(performance.now() - t0),
        err: e,
        shortMessage: (e as { shortMessage?: string })?.shortMessage,
        message: (e as { message?: string })?.message,
      });
      txStatus(tx.id, "pending");
      setErr(String(e).slice(0, 200));
    }
  }, [
    connectedAddress,
    tx.signatures,
    tx.status,
    tx.target,
    tx.value,
    tx.data,
    tx.deadline,
    tx.calls,
    tx.id,
    tx.chainId,
    wallet.address,
    wallet.threshold,
    writeContractAsync,
    connectedChainId,
    switchChainAsync,
    mesh,
    txPublicClient,
    isBatchTx,
    sponsoredExecute,
  ]);

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
  const deadlineDate = (() => {
    try {
      return new Date(Number(BigInt(tx.deadline)) * 1000);
    } catch {
      return null;
    }
  })();
  const expired = deadlineDate ? deadlineDate.getTime() < Date.now() : false;

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

      {isAttestation && tx.attestationFor ? (
        <div
          style={{
            fontSize: 10,
            color: "var(--slop-cyan, #3fcfff)",
            padding: 6,
            background: "rgba(63,207,255,0.07)",
            borderRadius: 3,
          }}
        >
          Co-signing for wallet {tx.attestationFor.outerWalletAddress.slice(0, 6)}…
          {tx.attestationFor.outerWalletAddress.slice(-4)} · {tx.signatures.length}/{wallet.threshold} signed
          {enoughSigs ? " · returned ✓" : ""}
        </div>
      ) : null}
      {tx.status === "pending" ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button
            variant={enoughSigs ? undefined : "primary"}
            onClick={onSign}
            disabled={signing || passkeySigning || !isMySigner || hasMySig || expired}
            title={
              !isMySigner
                ? "You aren't a registered signer on this multisig."
                : hasMySig
                  ? "You've already signed."
                  : expired
                    ? "Past deadline."
                    : isPasskeySigner
                      ? "Sign this transaction with your passkey."
                      : "Sign this transaction."
            }
          >
            {hasMySig ? "Signed" : signing || passkeySigning ? "Signing…" : isAttestation ? "Co-sign" : "Sign"}
          </Button>
          {/* Attestation txs are never executed in this room — the blob
           *  routes back to the outer wallet. So no Execute / nested-request
           *  controls here; just the Sign button above. */}
          {!isAttestation ? (
            <>
              <Button
                variant={enoughSigs ? "primary" : undefined}
                onClick={onExecute}
                disabled={writing || sponsoring || execWaiting || !enoughSigs || expired}
              >
                {execWaiting ? "Waiting…" : writing || sponsoring ? "Submitting…" : "Execute"}
              </Button>
              {unsignedContractSigners.map(cs => (
                <Button
                  key={cs.address}
                  onClick={() => onRequestNested(cs.address)}
                  disabled={expired}
                  title={`Ask wallet ${cs.address} (a contract signer) to co-sign in its own session.`}
                >
                  Request from {cs.label || `${cs.address.slice(0, 6)}…${cs.address.slice(-4)}`}
                </Button>
              ))}
            </>
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
