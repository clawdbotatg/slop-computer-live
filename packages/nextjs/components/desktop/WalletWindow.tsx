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
import { Button, LoadingBar, SlopAddress, TextField } from "~~/components/ui";
import { FACTORY_ADDRESS, MultisigAbi, MultisigFactoryAbi, type WalletSignature } from "~~/contracts/multisig";
import type { Peer, PeerMeshState, WalletRecord, WalletTx } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { computeExecHash, defaultDeadline, saltFromLabel, sortSignatures } from "~~/utils/multisig";

// Embedded AI wallet — was its own desktop app; now folded into this
// window as the Assets/Activity tabs. The iframe loads in "embedded"
// mode (?embedded=1&multisig=...&chain=...&signer=...&view=...) so the
// hosted app targets our multisig and renders the requested view.
// Override the URL for local dev with NEXT_PUBLIC_AI_WALLET_URL.
const AI_WALLET_URL = process.env.NEXT_PUBLIC_AI_WALLET_URL || "https://wallet.slop.computer";

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

type WalletTab = "deploy" | "assets" | "transactions";

export const WalletWindow = ({ mesh, myAddress, myHandle }: WalletWindowProps) => {
  const wallet = mesh.wallet;
  const [tab, setTab] = useState<WalletTab>(wallet ? "assets" : "deploy");

  // Auto-switch to Assets the first time a wallet shows up (initial
  // deploy). Don't yank the user back if they archive — they explicitly
  // hit "new episode" and want the deploy tab.
  useEffect(() => {
    if (wallet && tab === "deploy") {
      const justDeployed = Date.now() - wallet.createdAt < 8_000;
      if (justDeployed) setTab("assets");
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
      <div style={{ flex: 1, overflow: "auto", display: tab === "deploy" ? "block" : "none" }}>
        <DeployTab mesh={mesh} myAddress={myAddress} myHandle={myHandle} />
      </div>
      {/* Iframe — mounted once when wallet exists, visible only on the
       *  Assets tab. Stays alive when the user flips to Transactions so
       *  wallet state inside the iframe doesn't reset on every flip. */}
      {wallet ? (
        <div
          style={{
            flex: tab === "assets" ? 1 : undefined,
            display: tab === "assets" ? "flex" : "none",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <AIWalletIframe wallet={wallet} myAddress={myAddress} mesh={mesh} />
        </div>
      ) : null}
      {/* Transactions tab body — dedicated to the multisig queue (txs
       *  proposed from the AI wallet, SharedBrowser dapps, or future
       *  in-app send forms all land here for signing + execute). */}
      {wallet ? (
        <div
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

  type Candidate = { address: string; label: string; isMe: boolean; source: "peer" | "me" | "custom" };
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
      });
    }
    if (myAddress) {
      const lower = myAddress.toLowerCase();
      const custom = mesh.customNames[lower];
      const ex = out.get(lower);
      if (!ex)
        out.set(lower, { address: lower, label: custom ?? myHandle ?? short(myAddress), isMe: true, source: "me" });
      else out.set(lower, { ...ex, isMe: true });
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
  const effectiveSigners = useMemo(
    () => (existing ? existing.signers : selectedSigners.map(s => ({ address: s.address, label: s.label }))),
    [existing, selectedSigners],
  );
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

          <Field label="Episode label">
            <TextField
              value={draftOrDefault.label}
              onChange={e => updateDraft({ label: e.target.value })}
              placeholder={slug}
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
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!draftOrDefault.selected[s.address]}
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
                    {s.source === "custom" ? (
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
              disabled={false}
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
              disabled={selectedSigners.length === 0}
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
          signers={effectiveSigners.map(s => s.address as AddressType)}
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
  signers: AddressType[];
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
  signers: AddressType[];
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
          signers: signers.map(addr => ({ address: addr.toLowerCase(), label: short(addr), signerType: "eoa" })),
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
    try {
      if (connectedChainId !== chainId) {
        await switchChainAsync({ chainId });
      }
      const hash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: MultisigFactoryAbi,
        functionName: "createMultisig",
        chainId,
        args: [signers, [], [], [], BigInt(threshold), salt],
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
      signers: signers.map(addr => ({ address: addr.toLowerCase(), label: short(addr), signerType: "eoa" })),
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
// AI wallet iframe — assets / activity / send / swap UI lives in here.
// Mounted once when the wallet exists; we pass the desired view via the
// initial URL and via postMessage on tab change so the iframe doesn't
// remount when the user flips between Assets and Activity.
// ============================================================================

type AIWalletIframeProps = {
  wallet: WalletRecord;
  myAddress: string | null;
  mesh: PeerMeshState;
};

type SlopProposeTxMessage = {
  type: "slop:propose_tx";
  chainId: number;
  target: string;
  value: string;
  data: string;
  summary?: string;
};

const isProposeTxMessage = (v: unknown): v is SlopProposeTxMessage => {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.type === "slop:propose_tx" &&
    typeof m.chainId === "number" &&
    typeof m.target === "string" &&
    typeof m.value === "string" &&
    typeof m.data === "string"
  );
};

type SlopCursorMessage = { type: "slop:cursor"; x: number; y: number };
const isCursorMessage = (v: unknown): v is SlopCursorMessage => {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return m.type === "slop:cursor" && typeof m.x === "number" && typeof m.y === "number";
};

const AIWalletIframe = ({ wallet, myAddress, mesh }: AIWalletIframeProps) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Pick the most-recently-deployed chain as the "primary" — the iframe
  // initial URL uses this as its display chain; the agent can still
  // target a different deployed chain via postMessage.
  const primaryChainId = useMemo<number | null>(() => {
    const ids = Object.keys(wallet.deployments)
      .map(k => Number(k))
      .filter(n => Number.isFinite(n))
      .sort((a, b) => wallet.deployments[b].deployedAt - wallet.deployments[a].deployedAt);
    return ids[0] ?? null;
  }, [wallet.deployments]);
  const publicClient = usePublicClient({ chainId: primaryChainId ?? undefined });

  // Initial URL — only set once. The hosted AI wallet decides which
  // section to render based on its own internal navigation; we no
  // longer try to remote-control its view from the parent because the
  // Transactions tab is now our own panel (the multisig queue).
  const initialSrcRef = useRef<string | null>(null);
  const initialSrc = useMemo(() => {
    if (initialSrcRef.current) return initialSrcRef.current;
    if (primaryChainId === null) return null;
    const params = new URLSearchParams({
      embedded: "1",
      multisig: wallet.address,
      chain: String(primaryChainId),
    });
    if (myAddress) params.set("signer", myAddress);
    const url = `${AI_WALLET_URL}/?${params.toString()}`;
    initialSrcRef.current = url;
    return url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryChainId]);

  // Inbound postMessages from the iframe. Logs everything from the
  // iframe at log-level so it's easy to spot in DevTools whether the
  // hosted AI wallet is talking to us at all when Send is hit. Without
  // a propose_tx postMessage from the iframe, the multisig queue can't
  // populate — this is the single most common reason "tx didn't show
  // up": the hosted wallet just doesn't emit the message yet.
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;

      // Cursor bridge — translates iframe-local coords to parent-viewport
      // coords so useLocalCursor's capture-phase listener keeps the slop
      // cursor tracking over the iframe. High volume; don't log.
      if (isCursorMessage(e.data)) {
        const rect = iframeRef.current.getBoundingClientRect();
        const clientX = rect.left + e.data.x;
        const clientY = rect.top + e.data.y;
        window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY, bubbles: false }));
        return;
      }

      // Drop cursor:leave too — pure noise in the console.
      const dataType = e.data && typeof e.data === "object" ? (e.data as { type?: unknown }).type : undefined;
      if (dataType === "slop:cursor:leave") return;

      // Anything else gets a one-line log naming the type, so it's
      // easy to spot `slop:propose_tx` (the message we care about)
      // in DevTools. Stringify so the snapshot isn't mutated under us.
      const typeStr = typeof dataType === "string" ? dataType : "(no type)";
      try {
        console.log(`[wallet] iframe → ${typeStr}`, JSON.parse(JSON.stringify(e.data)));
      } catch {
        console.log(`[wallet] iframe → ${typeStr} (unserializable)`, e.data);
      }

      // If a propose_tx-shaped message arrives but doesn't validate,
      // say why instead of silently dropping. Most common cause: the
      // sender included `chainId: null` (no chain target).
      if (dataType === "slop:propose_tx" && !isProposeTxMessage(e.data)) {
        console.warn("[wallet] slop:propose_tx failed validation — required fields", {
          chainId: "number",
          target: "string (0x…)",
          value: "string (decimal wei)",
          data: "string (0x-prefixed hex)",
          received: e.data,
        });
        return;
      }
      if (!isProposeTxMessage(e.data)) return;
      const msg = e.data;
      if (!(msg.chainId in wallet.deployments)) {
        console.warn("[wallet] propose_tx rejected — chainId not deployed on this multisig", {
          received: msg.chainId,
          deployed: Object.keys(wallet.deployments),
        });
        return;
      }
      if (!publicClient) {
        console.warn("[wallet] propose_tx rejected — no public client for chain", msg.chainId);
        return;
      }
      try {
        const nonce = (await publicClient.readContract({
          address: wallet.address as AddressType,
          abi: MultisigAbi,
          functionName: "nonce",
        })) as bigint;
        const deadline = defaultDeadline();
        const target = msg.target as AddressType;
        const valueWei = BigInt(msg.value || "0");
        const data = (msg.data || "0x") as Hex;
        const execHash = computeExecHash({
          chainId: msg.chainId,
          multisig: wallet.address as AddressType,
          nonce,
          deadline,
          target,
          value: valueWei,
          data,
        });
        console.log("[wallet] queueing multisig tx from iframe", {
          chainId: msg.chainId,
          target,
          value: valueWei.toString(),
          nonce: nonce.toString(),
        });
        mesh.walletProposeTx({
          chainId: msg.chainId,
          target,
          value: valueWei.toString(),
          data,
          deadline: deadline.toString(),
          nonce: nonce.toString(),
          execHash,
          source: "manual",
          browserId: null,
        });
      } catch (err) {
        console.warn("[wallet] failed to queue propose_tx", err);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [wallet, publicClient, mesh]);

  if (!initialSrc) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <span style={{ color: "var(--slop-text-muted)", fontSize: 12 }}>preparing wallet view…</span>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={initialSrc}
      title="Slop wallet"
      // data-grab="false" short-circuits useLocalCursor's closest() walk so
      // the cursor doesn't inherit the parent WalletWindow's "grab" — the
      // iframe content is interactive UI, not a draggable surface.
      data-grab="false"
      // Sandbox: scripts + same-origin so wagmi/RainbowKit (if it loads
      // standalone-mode internals) can run; popups for WalletConnect;
      // forms for in-iframe submissions; allow-modals for the AI wallet's
      // confirmation dialog. No allow-top-navigation.
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals"
      style={{ flex: 1, width: "100%", border: 0, background: "#06030d", minHeight: 0 }}
    />
  );
};

// ============================================================================
// Activity tx queue — per-chain pending + recent multisig txs. Rendered
// below the iframe in the Activity tab.
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

  const myLowerAddress = (connectedAddress ?? myAddress ?? "").toLowerCase();
  const isMySigner = wallet.signers.some(s => s.address.toLowerCase() === myLowerAddress);
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
  }, [connectedAddress, signMessageAsync, mesh, tx.id, tx.execHash]);

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
      const hash = await writeContractAsync({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName: "execTransaction",
        chainId: tx.chainId,
        args: [tx.target as AddressType, BigInt(tx.value), tx.data as Hex, BigInt(tx.deadline), sorted],
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
  ]);

  const onRemove = useCallback(() => {
    mesh.walletRemoveTx(tx.id);
  }, [mesh, tx.id]);

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

      <div style={{ fontSize: 11 }}>
        <span style={{ color: "var(--slop-text-muted)" }}>
          {tx.signatures.length} of {wallet.threshold} signatures
        </span>
        {tx.signatures.length > 0 ? (
          <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
            {tx.signatures.map(s => (
              <span
                key={s.signer}
                style={{
                  fontSize: 10,
                  padding: "2px 6px",
                  background: "rgba(123,232,138,0.12)",
                  border: "1px solid rgba(123,232,138,0.3)",
                  borderRadius: 3,
                  color: "#7be88a",
                }}
                title={s.signer}
              >
                ✓ {short(s.signer)}
              </span>
            ))}
          </div>
        ) : null}
      </div>

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
            variant="primary"
            onClick={onSign}
            disabled={signing || !isMySigner || hasMySig || expired}
            title={
              !isMySigner
                ? "You aren't a registered signer on this multisig."
                : hasMySig
                  ? "You've already signed."
                  : expired
                    ? "Past deadline."
                    : "Sign this transaction."
            }
          >
            {hasMySig ? "Signed" : signing ? "Signing…" : "Sign"}
          </Button>
          <Button onClick={onExecute} disabled={writing || execWaiting || !enoughSigs || expired}>
            {execWaiting ? "Waiting…" : writing ? "Submitting…" : "Execute"}
          </Button>
          <Button onClick={onRemove} disabled={writing}>
            Dismiss
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
