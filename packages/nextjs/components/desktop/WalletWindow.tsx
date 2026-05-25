"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address, AddressInput } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex, decodeEventLog, formatEther } from "viem";
import { base, gnosis, mainnet } from "viem/chains";
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
import { WalletAssetsPanel } from "~~/components/desktop/wallet/WalletAssetsPanel";
import { WalletChatPanel } from "~~/components/desktop/wallet/WalletChatPanel";
import { Button, LoadingBar, SlopAddress, TextField } from "~~/components/ui";
import { FACTORY_ADDRESS, MultisigAbi, MultisigFactoryAbi, type WalletSignature } from "~~/contracts/multisig";
import type { Peer, PeerMeshState, WalletRecord, WalletTx } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";
import { useRoomSlug } from "~~/lib/room-slug";
import { saltFromLabel, sortSignatures } from "~~/utils/multisig";
import { getStoredPasskeyIdentity, signMultisigExecWithPasskey } from "~~/utils/passkey";

// One resolved deploy-time signer slot. Carries everything needed to
// build both the `createMultisig` args (EOA address vs passkey qx/qy/
// credentialIdHash) and the WalletRecord.signers entry for the relay.
// Passkey fields are populated by looking up peer.passkey (for remote
// passkey peers) or local storage (for the local passkey user).
type ResolvedSigner = {
  address: AddressType;
  label: string;
  signerType: "eoa" | "passkey";
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
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The three chains the multisig factory is deployed on (same address
// each). Order matters for the UI — cheap chains first since they're
// the recommended default. Adding a new chain here lights up a new row
// in the deploy grid and a new option in the activity picker — provided
// it's also in `scaffold.config.ts` `targetNetworks`.
const SUPPORTED_CHAINS = [
  { id: base.id, label: "Base", explorer: "https://basescan.org" },
  { id: gnosis.id, label: "Gnosis", explorer: "https://gnosisscan.io" },
  { id: mainnet.id, label: "Ethereum", explorer: "https://etherscan.io" },
] as const;

const chainMeta = (chainId: number) =>
  SUPPORTED_CHAINS.find(c => c.id === chainId) ?? {
    id: chainId,
    label: `chain ${chainId}`,
    explorer: "https://etherscan.io",
  };

type WalletTab = "deploy" | "chat" | "assets" | "transactions";

export const WalletWindow = ({ mesh, myAddress, myHandle }: WalletWindowProps) => {
  const wallet = mesh.wallet;
  // If the window is opening fresh because a tx just landed in the
  // queue (browser dapp, AI wallet, etc.), land directly on the
  // transactions tab so the signing UI is right there. Otherwise chat
  // is the headline.
  const [tab, setTab] = useState<WalletTab>(() => {
    if (!wallet) return "deploy";
    if (mesh.walletTxs.some(t => t.status === "pending")) return "transactions";
    return "chat";
  });

  // Auto-switch to Chat the first time a wallet shows up (initial
  // deploy) — the conversation is the headline. Don't yank the user
  // back if they archive — they explicitly hit "new episode".
  useEffect(() => {
    if (wallet && tab === "deploy") {
      const justDeployed = Date.now() - wallet.createdAt < 8_000;
      if (justDeployed) setTab("chat");
    }
    if (!wallet && tab !== "deploy") setTab("deploy");
  }, [wallet, tab]);

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
  }, [pendingCount, wallet, tab]);

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
          <WalletAssetsPanel wallet={wallet} />
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

  // Predicted multisig address. Same on every chain since the factory
  // address is identical — pin the read to mainnet RPC.
  const { data: predicted } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: MultisigFactoryAbi,
    functionName: "getMultisigAddress",
    args: effectiveDeployer ? [effectiveDeployer, effectiveSalt] : undefined,
    chainId: mainnet.id,
    query: { enabled: !!effectiveDeployer },
  });
  const predictedAddress = (existing?.address ?? predicted ?? null) as AddressType | null;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      {existing ? (
        <DeployedSummary wallet={existing} onArchive={() => mesh.walletNewEpisode()} />
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

const DeployedSummary = ({ wallet, onArchive }: { wallet: WalletRecord; onArchive: () => void }) => {
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
            signerType: s.signerType,
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
    // parallel arrays. A passkey signer is one we have full pubkey
    // data for (qx + qy + credentialIdHash); fall back to EOA otherwise.
    // The contract registers each kind into its own table, so getting
    // this wrong reverts later with `SignerTypeMismatch` at sign time.
    const eoaSigners: AddressType[] = [];
    const passkeyQxs: `0x${string}`[] = [];
    const passkeyQys: `0x${string}`[] = [];
    const credentialIdHashes: `0x${string}`[] = [];
    for (const s of signers) {
      if (s.signerType === "passkey" && s.qx && s.qy && s.credentialIdHash) {
        passkeyQxs.push(s.qx);
        passkeyQys.push(s.qy);
        credentialIdHashes.push(s.credentialIdHash);
      } else {
        eoaSigners.push(s.address);
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
        args: [eoaSigners, passkeyQxs, passkeyQys, credentialIdHashes, BigInt(threshold), salt],
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
        signerType: s.signerType,
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
  }, [canDeploy, localPredicted, deployer, existing, chainId, salt, signers, threshold, label, mesh]);

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
};

const ActivityTxQueue = ({ mesh, wallet, myAddress }: ActivityProps) => {
  // Default to the most recently deployed chain.
  const deployedChainIds = useMemo(
    () =>
      Object.keys(wallet.deployments)
        .map(k => Number(k))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => wallet.deployments[b].deployedAt - wallet.deployments[a].deployedAt),
    [wallet.deployments],
  );
  const [activeChain, setActiveChain] = useState<number>(deployedChainIds[0] ?? mainnet.id);
  useEffect(() => {
    if (deployedChainIds.length === 0) return;
    if (!deployedChainIds.includes(activeChain)) setActiveChain(deployedChainIds[0]);
  }, [deployedChainIds, activeChain]);

  // Distinct from chainTxs below — used by the "txs exist on other
  // chains" hint so the user knows to switch the chain picker if their
  // tx landed on a chain that isn't currently selected.
  const allTxs = mesh.walletTxs;
  const chainTxs = allTxs.filter(t => t.chainId === activeChain);
  const pendingTxs = chainTxs.filter(t => t.status === "pending");
  const otherTxs = chainTxs.filter(t => t.status !== "pending").slice(0, 20);
  const txsOnOtherChains = allTxs.filter(t => t.chainId !== activeChain);

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
            No transactions to sign on {chainMeta(activeChain).label}.
            <br />
            <span style={{ fontSize: 11 }}>
              When the AI wallet sends a transaction (Send / Swap / etc.), it lands here for signers to approve and
              execute. Captured txs from in-room dapps (SharedBrowser) land here too. If you sent something and
              don&apos;t see it, check the browser console for <code>[wallet] iframe → parent message</code> entries to
              see whether the iframe posted the propose_tx message.
            </span>
            {txsOnOtherChains.length > 0 ? (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--slop-cyan, #3fcfff)" }}>
                {txsOnOtherChains.length} transaction{txsOnOtherChains.length === 1 ? "" : "s"} on{" "}
                {Array.from(new Set(txsOnOtherChains.map(t => chainMeta(t.chainId).label))).join(", ")} — switch the
                chain picker above to view.
              </div>
            ) : null}
          </div>
        ) : (
          pendingTxs.map(tx => <TxCard key={tx.id} tx={tx} wallet={wallet} mesh={mesh} myAddress={myAddress} />)
        )}
      </Section>

      {otherTxs.length > 0 ? (
        <Section title="Recent">
          {otherTxs.map(tx => (
            <TxCard key={tx.id} tx={tx} wallet={wallet} mesh={mesh} myAddress={myAddress} compact />
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
      <div
        style={{
          height: 10,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,62,201,0.25)",
          borderRadius: 5,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: complete
              ? "linear-gradient(90deg, #7be88a 0%, #3fcfff 100%)"
              : "linear-gradient(90deg, var(--slop-magenta, #ff3ec9) 0%, var(--slop-cyan, #3fcfff) 100%)",
            boxShadow: complete ? "0 0 10px rgba(123,232,138,0.55)" : "0 0 10px rgba(255,62,201,0.5)",
            transition: "width 220ms ease-out",
          }}
        />
      </div>
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
// Tx card — sign + execute. Chain comes from the tx itself, not the wallet.
// ----------------------------------------------------------------------------

type TxCardProps = {
  tx: WalletTx;
  wallet: WalletRecord;
  mesh: PeerMeshState;
  myAddress: string | null;
  compact?: boolean;
};

const TxCard = ({ tx, wallet, mesh, myAddress, compact }: TxCardProps) => {
  const { address: connectedAddress } = useAccount();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const { writeContractAsync, isPending: writing } = useWriteContract();
  const txPublicClient = usePublicClient({ chainId: tx.chainId });
  const [execHash, setExecHash] = useState<`0x${string}` | null>(null);
  const { isLoading: execWaiting, data: execReceipt } = useWaitForTransactionReceipt({
    hash: execHash ?? undefined,
    chainId: tx.chainId,
    // Same reason as the deploy receipt: app-wide pollingInterval is 30s
    // for ambient state, but once we have a hash the user just wants to
    // see it confirm. 2s feels live.
    pollingInterval: 2000,
  });
  const [err, setErr] = useState<string | null>(null);
  // True while the WebAuthn passkey prompt is open. wagmi's
  // useSignMessage.isPending only covers the EOA path; we track this
  // ourselves so the Sign button stays disabled during the OS sheet
  // and doesn't double-prompt on a stray click.
  const [passkeySigning, setPasskeySigning] = useState(false);

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

  useEffect(() => {
    if (execReceipt) {
      mesh.walletSetTxStatus(
        tx.id,
        execReceipt.status === "success" ? "executed" : "failed",
        execReceipt.transactionHash,
      );
      setExecHash(null);
    }
  }, [execReceipt, mesh, tx.id]);

  const onSign = useCallback(async () => {
    setErr(null);
    if (!mySignerEntry) {
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
        const data = await signMultisigExecWithPasskey({
          credentialIdBase64Url,
          execHash: tx.execHash as `0x${string}`,
          qx,
          qy,
        });
        mesh.walletSignTx(tx.id, { signer: mySignerEntry.address.toLowerCase(), sigType: 1, data });
      } catch (e) {
        setErr(String(e).slice(0, 200));
      } finally {
        setPasskeySigning(false);
      }
      return;
    }
    // EOA path — needs the wagmi wallet.
    if (!connectedAddress) {
      setErr("connect your wallet to sign");
      return;
    }
    try {
      const sig = await signMessageAsync({ message: { raw: tx.execHash as Hex } });
      mesh.walletSignTx(tx.id, { signer: connectedAddress.toLowerCase(), sigType: 0, data: sig });
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  }, [mySignerEntry, connectedAddress, signMessageAsync, mesh, tx.id, tx.execHash]);

  const onExecute = useCallback(async () => {
    setErr(null);
    if (!connectedAddress) {
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
      mesh.walletSetTxStatus(tx.id, "executing");
      // Estimate gas with a 50% buffer. eth_estimateGas returns the minimum
      // viable amount, but the 63/64 forwarding rule plus heavy inner calls
      // (LI.FI swaps, multi-hop bridges) starve the inner frame if we don't
      // overshoot the outer limit. A 1.5x multiplier matches what wallets
      // like Safe use for the same reason. 800k floor in case estimate
      // is wildly off — txs that need more than 800k still get the 1.5x.
      const args = [tx.target as AddressType, BigInt(tx.value), tx.data as Hex, BigInt(tx.deadline), sorted] as const;
      let gasLimit: bigint | undefined;
      if (txPublicClient && connectedAddress) {
        try {
          const estimate = await txPublicClient.estimateContractGas({
            address: wallet.address as AddressType,
            abi: MultisigAbi,
            functionName: "execTransaction",
            args,
            account: connectedAddress as AddressType,
          });
          const buffered = (estimate * 3n) / 2n;
          gasLimit = buffered < 800_000n ? 800_000n : buffered;
        } catch {
          // If estimate fails (sometimes happens with revert-prone calldata),
          // fall back to a high fixed limit so the signer can still try.
          gasLimit = 1_500_000n;
        }
      }
      const hash = await writeContractAsync({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName: "execTransaction",
        chainId: tx.chainId,
        args,
        gas: gasLimit,
      });
      setExecHash(hash);
    } catch (e) {
      mesh.walletSetTxStatus(tx.id, "pending");
      setErr(String(e).slice(0, 200));
    }
  }, [
    connectedAddress,
    tx.signatures,
    tx.target,
    tx.value,
    tx.data,
    tx.deadline,
    tx.id,
    tx.chainId,
    wallet.address,
    writeContractAsync,
    mesh,
    txPublicClient,
  ]);

  const onResummarize = useCallback(() => {
    mesh.walletResummarize(tx.id);
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
      }}
    >
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

      <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ color: "var(--slop-text-muted)" }}>to</span>
        <Address address={tx.target as AddressType} size="xs" onlyEnsOrAddress />
        <span style={{ color: "var(--slop-text-muted)" }}>·</span>
        <span>{valueEth} ETH</span>
      </div>

      {tx.summary ? (
        <div
          style={{ fontSize: 12, lineHeight: 1.5, padding: 8, background: "rgba(255,62,201,0.06)", borderRadius: 4 }}
        >
          {tx.summary}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--slop-text-muted)", fontStyle: "italic" }}>
          summarizing…
          <button
            type="button"
            onClick={onResummarize}
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
        </div>
      )}

      {!compact ? (
        <details style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
          <summary style={{ cursor: "pointer", userSelect: "none" }}>raw calldata</summary>
          <div style={{ wordBreak: "break-all", fontFamily: "monospace", marginTop: 4 }}>{tx.data}</div>
        </details>
      ) : null}

      <SignerCollectionBar
        wallet={wallet}
        tx={tx}
        peers={mesh.peers as Peer[]}
        customNames={mesh.customNames}
        myAddress={myLowerAddress || null}
        compact={compact}
      />

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
            {hasMySig ? "Signed" : signing || passkeySigning ? "Signing…" : "Sign"}
          </Button>
          <Button
            variant={enoughSigs ? "primary" : undefined}
            onClick={onExecute}
            disabled={writing || execWaiting || !enoughSigs || expired}
          >
            {execWaiting ? "Waiting…" : writing ? "Submitting…" : "Execute"}
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
