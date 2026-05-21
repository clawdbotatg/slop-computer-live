"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, AddressInput } from "@scaffold-ui/components";
import { useFetchNativeCurrencyPrice } from "@scaffold-ui/hooks";
import { type Address as AddressType, type Hex, decodeEventLog, formatEther, parseEther } from "viem";
import { base, gnosis, mainnet } from "viem/chains";
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useReadContract,
  useSignMessage,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { Button, LoadingBar, TextField } from "~~/components/ui";
import { FACTORY_ADDRESS, MultisigAbi, MultisigFactoryAbi, type WalletSignature } from "~~/contracts/multisig";
import type { Peer, PeerMeshState, WalletRecord, WalletTx } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { computeExecHash, defaultDeadline, saltFromLabel, sortSignatures } from "~~/utils/multisig";

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

export const WalletWindow = ({ mesh, myAddress, myHandle }: WalletWindowProps) => {
  const wallet = mesh.wallet;
  const [tab, setTab] = useState<"deploy" | "activity">(wallet ? "activity" : "deploy");

  // Auto-switch to activity the first time a wallet shows up (initial
  // deploy). Don't yank the user back to deploy if they archive — they
  // explicitly hit "new episode" and want the deploy tab.
  useEffect(() => {
    if (wallet && tab === "deploy") {
      // Only auto-switch if there's already at least one deployment and
      // the user hasn't manually picked Deploy — heuristic: if the wallet
      // is freshly minted (within a few seconds), bounce to activity.
      const justDeployed = Date.now() - wallet.createdAt < 8_000;
      if (justDeployed) setTab("activity");
    }
    if (!wallet && tab === "activity") setTab("deploy");
  }, [wallet, tab]);

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
      <TabBar tab={tab} setTab={setTab} deployLabel={wallet ? "Deploy" : "Deploy"} activityDisabled={!wallet} />
      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "deploy" ? (
          <DeployTab mesh={mesh} myAddress={myAddress} myHandle={myHandle} />
        ) : wallet ? (
          <ActivityTab mesh={mesh} wallet={wallet} myAddress={myAddress} />
        ) : null}
      </div>
    </div>
  );
};

// ============================================================================
// Tab bar
// ============================================================================

const TabBar = ({
  tab,
  setTab,
  deployLabel,
  activityDisabled,
}: {
  tab: "deploy" | "activity";
  setTab: (t: "deploy" | "activity") => void;
  deployLabel: string;
  activityDisabled: boolean;
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
  });
  return (
    <div
      style={{
        display: "flex",
        borderBottom: "1px solid rgba(255,62,201,0.18)",
        background: "rgba(0,0,0,0.3)",
      }}
    >
      <button type="button" style={tabStyle(tab === "deploy", false)} onClick={() => setTab("deploy")}>
        {deployLabel}
      </button>
      <button
        type="button"
        style={tabStyle(tab === "activity", activityDisabled)}
        disabled={activityDisabled}
        title={activityDisabled ? "Deploy a wallet first to unlock activity." : undefined}
        onClick={() => !activityDisabled && setTab("activity")}
      >
        Activity
      </button>
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
  const { address: connectedAddress } = useAccount();
  const existing = mesh.wallet;

  // Form state — only used pre-first-deploy. After we have a wallet,
  // signers/threshold/label/salt are locked into `wallet` and the form
  // is replaced by a read-only summary.
  const [label, setLabel] = useState<string>(slug);
  const [customSigners, setCustomSigners] = useState<{ address: string; label: string }[]>([]);

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
    for (const c of customSigners) {
      const lower = c.address.toLowerCase();
      if (!out.has(lower)) out.set(lower, { address: lower, label: c.label, isMe: false, source: "custom" });
    }
    return Array.from(out.values()).sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      const rank = (s: Candidate["source"]) => (s === "me" ? 0 : s === "peer" ? 1 : 2);
      return rank(a.source) - rank(b.source);
    });
  }, [mesh.peers, mesh.myId, myAddress, myHandle, customSigners, mesh.customNames]);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setSelected(prev => {
      const next = { ...prev };
      for (const s of candidateSigners) if (next[s.address] === undefined) next[s.address] = true;
      return next;
    });
  }, [candidateSigners]);

  const selectedSigners = useMemo(
    () => candidateSigners.filter(s => selected[s.address]),
    [candidateSigners, selected],
  );

  const [threshold, setThreshold] = useState<number>(1);
  useEffect(() => {
    if (selectedSigners.length === 0) return;
    setThreshold(t => {
      const next = Math.min(Math.max(1, Math.ceil(selectedSigners.length / 2)), selectedSigners.length);
      return t > selectedSigners.length ? next : t;
    });
  }, [selectedSigners.length]);

  // After deploy, we lock signers/threshold/salt into the wallet record.
  // Before deploy, derive them live from the form.
  const effectiveDeployer = existing ? (existing.deployer as AddressType) : (connectedAddress ?? null);
  const effectiveSalt = useMemo(() => {
    if (existing) return existing.salt as Hex;
    return saltFromLabel(`${connectedAddress ?? "0x0"}:${label}`);
  }, [existing, connectedAddress, label]);
  const effectiveSigners = useMemo(
    () => (existing ? existing.signers : selectedSigners.map(s => ({ address: s.address, label: s.label }))),
    [existing, selectedSigners],
  );
  const effectiveThreshold = existing ? existing.threshold : threshold;
  const effectiveLabel = existing ? existing.label : label;

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
        <DeployedSummary wallet={existing} />
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
            <TextField value={label} onChange={e => setLabel(e.target.value)} placeholder={slug} />
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
                      checked={!!selected[s.address]}
                      onChange={e => setSelected(prev => ({ ...prev, [s.address]: e.target.checked }))}
                    />
                    <span
                      style={{
                        flex: 1,
                        fontSize: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 1,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--slop-font-display)",
                          letterSpacing: "0.04em",
                          color: "var(--slop-text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {s.label}
                        {s.isMe ? <span style={{ marginLeft: 6, color: "var(--slop-text-muted)" }}>(you)</span> : null}
                        {s.source === "custom" ? (
                          <span style={{ marginLeft: 6, color: "var(--slop-text-muted)" }}>· added</span>
                        ) : null}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
                        <Address address={s.address as AddressType} size="xs" onlyEnsOrAddress />
                      </span>
                    </span>
                    {s.source === "custom" ? (
                      <button
                        type="button"
                        aria-label="remove"
                        title="remove this signer"
                        onClick={() => {
                          setCustomSigners(prev => prev.filter(c => c.address.toLowerCase() !== s.address));
                          setSelected(prev => {
                            const next = { ...prev };
                            delete next[s.address];
                            return next;
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
                setCustomSigners(prev =>
                  prev.some(c => c.address.toLowerCase() === lower)
                    ? prev
                    : [...prev, { address: lower, label: short(lower) }],
                );
                setSelected(prev => ({ ...prev, [lower]: true }));
              }}
            />
          </Field>

          <Field label={`Threshold (${threshold} of ${selectedSigners.length || 0})`}>
            <input
              type="range"
              min={1}
              max={Math.max(1, selectedSigners.length)}
              value={threshold}
              disabled={selectedSigners.length === 0}
              onChange={e => setThreshold(parseInt(e.target.value, 10))}
              style={{ width: "100%" }}
            />
          </Field>

          <Field label="Predicted address">
            <div style={{ fontSize: 12 }}>
              {predictedAddress ? (
                <Address address={predictedAddress} size="sm" />
              ) : !connectedAddress ? (
                <span style={{ color: "var(--slop-text-muted)" }}>connect wallet</span>
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
        />
      </Section>
    </div>
  );
};

// ============================================================================
// DeployedSummary — read-only signer / threshold summary, shown above the
// chain grid once the wallet exists.
// ============================================================================

const DeployedSummary = ({ wallet }: { wallet: WalletRecord }) => {
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
};

const ChainGrid = ({ mesh, existing, predicted, deployer, salt, signers, threshold, label }: ChainGridProps) => {
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
  } = useWaitForTransactionReceipt({ hash: txHash ?? undefined, chainId });
  const [err, setErr] = useState<string | null>(null);

  // Code probe: does contract bytecode already exist at the predicted
  // address on this chain? If so, someone already deployed it — even if
  // we don't have a record locally. Used to gate the deploy button.
  const publicClient = usePublicClient({ chainId });
  const [hasCode, setHasCode] = useState<boolean | null>(null);
  const probeKey = predicted ? `${chainId}:${predicted.toLowerCase()}` : null;
  useEffect(() => {
    if (!publicClient || !predicted) {
      setHasCode(null);
      return;
    }
    let cancelled = false;
    publicClient
      .getBytecode({ address: predicted })
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
    // probeKey rolls up the inputs that change the answer; ignoring
    // publicClient identity churn (wagmi re-creates it on every render).
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
      // First-ever deploy — build the full WalletRecord from the
      // MultisigCreated event in the receipt, just like the legacy flow.
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
          } catch {
            /* not our event */
          }
        }
        if (!multisigAddr) {
          setErr("Couldn't find MultisigCreated log");
          setTxHash(null);
          return;
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
  }, [deployer, signers, connectedChainId, chainId, switchChainAsync, writeContractAsync, threshold, salt]);

  const busy = writePending || receiptLoading || switching;

  const statusNode = (() => {
    if (alreadyDeployedOnChain) {
      // Already deployed (either we have a record, or eth_getCode found
      // bytecode at the address from some prior deploy).
      const link = localDep?.txHash
        ? `${explorer}/tx/${localDep.txHash}`
        : predicted
          ? `${explorer}/address/${predicted}`
          : null;
      const txt = localDep ? "already deployed" : "already deployed (on-chain)";
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
        </div>
      );
    }
    return (
      <Button variant="primary" onClick={onDeploy} disabled={busy || !deployer || signers.length === 0}>
        {switching ? "Switching…" : writePending ? "Confirm…" : receiptLoading ? "Waiting…" : "Deploy"}
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
// Activity tab — chain picker + balances + send + tx queue, scoped per chain
// ============================================================================

type ActivityProps = {
  mesh: PeerMeshState;
  wallet: WalletRecord;
  myAddress: string | null;
};

const ActivityTab = ({ mesh, wallet, myAddress }: ActivityProps) => {
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
  // If the wallet gains a new deployment while we're looking and we
  // happen to be on a now-removed chain (rare; archive flow), snap to
  // the first available.
  useEffect(() => {
    if (deployedChainIds.length === 0) return;
    if (!deployedChainIds.includes(activeChain)) setActiveChain(deployedChainIds[0]);
  }, [deployedChainIds, activeChain]);

  const chainTxs = mesh.walletTxs.filter(t => t.chainId === activeChain);
  const pendingTxs = chainTxs.filter(t => t.status === "pending");
  const otherTxs = chainTxs.filter(t => t.status !== "pending").slice(0, 10);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14 }}>
      <WalletHeader wallet={wallet} onArchive={() => mesh.walletNewEpisode()} />
      <ChainPicker deployedChainIds={deployedChainIds} active={activeChain} onPick={setActiveChain} />
      <WalletBalances address={wallet.address} />
      <WalletSendForm wallet={wallet} mesh={mesh} chainId={activeChain} />

      <Section title={`Pending on ${chainMeta(activeChain).label} (${pendingTxs.length})`}>
        {pendingTxs.length === 0 ? (
          <Empty>No transactions to sign on this chain. Have the browser submit something — it lands here.</Empty>
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

const WalletHeader = ({ wallet, onArchive }: { wallet: WalletRecord; onArchive: () => void }) => {
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
        Threshold {wallet.threshold} of {wallet.signers.length} · deployed on {Object.keys(wallet.deployments).length}{" "}
        chain
        {Object.keys(wallet.deployments).length === 1 ? "" : "s"}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Balances — Zerion (chain-agnostic, shows everything).
// ----------------------------------------------------------------------------

type PortfolioResp = {
  ok: boolean;
  address: string;
  totalUsd: number;
  change1d: { absolute: number; percent: number } | null;
  byChain: Record<string, number>;
  positions: {
    blockchain: string;
    tokenName: string;
    tokenSymbol: string;
    balance: number;
    balanceUsd: number;
    thumbnail: string | null;
  }[];
};

const WalletBalances = ({ address }: { address: string }) => {
  const [data, setData] = useState<PortfolioResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/portfolio?address=${address}`, { cache: "no-store" })
      .then(async r => {
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setErr(j.error ?? `HTTP ${r.status}`);
          setData(null);
        } else {
          setErr(null);
          setData(j as PortfolioResp);
        }
      })
      .catch(e => {
        if (!cancelled) setErr(String(e).slice(0, 120));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return (
    <Section title="Balances">
      {loading ? (
        <Empty>loading…</Empty>
      ) : err ? (
        <Empty>
          {err === "no-zerion-key"
            ? "Set ZERION_API_KEY on the server to see balances."
            : `Couldn't load balances: ${err}`}
        </Empty>
      ) : !data ? (
        <Empty>no data</Empty>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "4px 0 8px" }}>
            <div style={{ fontSize: 22, fontFamily: "var(--slop-font-display)" }}>${data.totalUsd.toFixed(2)}</div>
            {data.change1d ? (
              <div style={{ fontSize: 11, color: data.change1d.percent >= 0 ? "#7be88a" : "#ff7676" }}>
                {data.change1d.percent >= 0 ? "▲" : "▼"} {Math.abs(data.change1d.percent).toFixed(2)}%
              </div>
            ) : null}
          </div>
          {data.positions.length === 0 ? (
            <Empty>nothing held yet — fund the wallet to see balances</Empty>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {data.positions.slice(0, 8).map((p, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "rgba(255,255,255,0.02)",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  {p.thumbnail ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={p.thumbnail} alt="" width={20} height={20} style={{ borderRadius: 10 }} />
                  ) : (
                    <div style={{ width: 20, height: 20, borderRadius: 10, background: "rgba(255,62,201,0.2)" }} />
                  )}
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.tokenSymbol}
                    <span style={{ color: "var(--slop-text-muted)", marginLeft: 6 }}>{p.balance.toFixed(4)}</span>
                  </span>
                  <span style={{ color: "var(--slop-text-muted)" }}>${p.balanceUsd.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
};

// ----------------------------------------------------------------------------
// Send form — propose a manual outgoing tx, scoped to the selected chain.
// ----------------------------------------------------------------------------

const WalletSendForm = ({ wallet, mesh, chainId }: { wallet: WalletRecord; mesh: PeerMeshState; chainId: number }) => {
  const publicClient = usePublicClient({ chainId });
  const { price: ethPrice } = useFetchNativeCurrencyPrice();
  const { data: balance } = useBalance({ address: wallet.address as AddressType, chainId });
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [data, setData] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const targetOk = /^0x[a-fA-F0-9]{40}$/.test(recipient.trim());
  const dataOk = !data.trim() || /^0x([a-fA-F0-9]{2})*$/.test(data.trim());
  let amountWei: bigint | null = null;
  let amountErr: string | null = null;
  let amountFloat: number | null = null;
  if (amount.trim()) {
    try {
      amountWei = parseEther(amount.trim() as `${number}`);
      amountFloat = parseFloat(amount.trim());
      if (!Number.isFinite(amountFloat)) amountFloat = null;
    } catch {
      amountErr = "invalid amount";
    }
  } else {
    amountWei = 0n;
  }
  const amountUsd = amountFloat !== null && ethPrice > 0 && !amountErr ? amountFloat * ethPrice : null;

  const onPropose = useCallback(async () => {
    setErr(null);
    if (!publicClient) {
      setErr("no RPC client for this chain");
      return;
    }
    if (!targetOk) {
      setErr("enter a valid recipient");
      return;
    }
    if (amountErr || amountWei === null) {
      setErr(amountErr ?? "invalid amount");
      return;
    }
    if (!dataOk) {
      setErr("calldata must be 0x-prefixed hex");
      return;
    }
    if (amountWei === 0n && (!data.trim() || data.trim() === "0x")) {
      setErr("send 0 ETH with no calldata? add an amount or some data");
      return;
    }
    setBusy(true);
    try {
      const nonce = (await publicClient.readContract({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName: "nonce",
      })) as bigint;
      const deadline = defaultDeadline();
      const target = recipient.trim() as AddressType;
      const calldata = (data.trim() || "0x") as Hex;
      const execHash = computeExecHash({
        chainId,
        multisig: wallet.address as AddressType,
        nonce,
        deadline,
        target,
        value: amountWei,
        data: calldata,
      });
      mesh.walletProposeTx({
        chainId,
        target,
        value: amountWei.toString(),
        data: calldata,
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        execHash,
        source: "manual",
        browserId: null,
      });
      setRecipient("");
      setAmount("");
      setData("");
      setShowAdvanced(false);
      setOpen(false);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  }, [publicClient, targetOk, amountErr, amountWei, dataOk, data, recipient, wallet, mesh, chainId]);

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        Send on {chainMeta(chainId).label}
      </Button>
    );
  }

  return (
    <Section title={`Send on ${chainMeta(chainId).label}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Field label="Recipient">
          <AddressInput
            value={recipient}
            placeholder="0x… or vitalik.eth"
            disabled={busy}
            onChange={next => setRecipient(next ?? "")}
          />
        </Field>
        <Field label="Amount (ETH)">
          <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
            <div style={{ flex: 1 }}>
              <TextField
                inputMode="decimal"
                value={amount}
                placeholder="0.01"
                disabled={busy}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
            <button
              type="button"
              disabled={busy || !balance || balance.value === 0n}
              onClick={() => {
                if (!balance) return;
                setAmount(formatEther(balance.value));
              }}
              title={balance ? `Max: ${formatEther(balance.value)} ETH` : "loading balance…"}
              style={{
                padding: "0 12px",
                fontSize: 10,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                background:
                  !balance || balance.value === 0n ? "rgba(255,255,255,0.06)" : "var(--slop-magenta, #ff3ec9)",
                color: !balance || balance.value === 0n ? "var(--slop-text-muted)" : "#06030d",
                border: "none",
                borderRadius: 4,
                cursor: !balance || balance.value === 0n ? "not-allowed" : "pointer",
                fontWeight: 700,
              }}
            >
              Max
            </button>
          </div>
          {amountErr ? (
            <div style={{ fontSize: 10, color: "#ff7676", marginTop: 4 }}>{amountErr}</div>
          ) : amountUsd !== null ? (
            <div style={{ fontSize: 11, color: "var(--slop-text-muted)", marginTop: 4 }}>
              ≈ $
              {amountUsd.toLocaleString(undefined, {
                minimumFractionDigits: amountUsd < 1 ? 4 : 2,
                maximumFractionDigits: amountUsd < 1 ? 4 : 2,
              })}{" "}
              USD
            </div>
          ) : null}
        </Field>
        {showAdvanced ? (
          <Field label="Calldata (hex, optional)">
            <TextField
              value={data}
              placeholder="0x"
              disabled={busy}
              onChange={e => setData(e.target.value)}
              style={{ fontFamily: "monospace", fontSize: 11 }}
            />
            {!dataOk ? (
              <div style={{ fontSize: 10, color: "#ff7676", marginTop: 4 }}>must be 0x-prefixed hex</div>
            ) : null}
          </Field>
        ) : (
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--slop-text-muted)",
              fontSize: 10,
              textDecoration: "underline",
              cursor: "pointer",
              alignSelf: "flex-start",
              padding: 0,
            }}
          >
            + add calldata
          </button>
        )}
        {err ? (
          <div
            style={{
              fontSize: 11,
              color: "#ff7676",
              padding: 6,
              background: "rgba(255,118,118,0.08)",
              borderRadius: 3,
            }}
          >
            {err}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="primary" onClick={onPropose} disabled={busy || !targetOk || !!amountErr || !dataOk}>
            {busy ? "Proposing…" : "Propose"}
          </Button>
          <Button
            onClick={() => {
              setOpen(false);
              setErr(null);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
        <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
          This queues the tx in Pending. {wallet.threshold} of {wallet.signers.length} signer
          {wallet.signers.length === 1 ? "" : "s"} must sign before it can execute.
        </div>
      </div>
    </Section>
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

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: 8, fontSize: 12, color: "var(--slop-text-muted)", fontStyle: "italic" }}>{children}</div>
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
