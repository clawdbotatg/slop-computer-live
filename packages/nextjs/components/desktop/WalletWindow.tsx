"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, AddressInput } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex, decodeEventLog, formatEther, parseEther } from "viem";
import { base, mainnet } from "viem/chains";
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
import { Button, LoadingBar, TextField } from "~~/components/ui";
import { FACTORY_ADDRESS, MultisigAbi, MultisigFactoryAbi, type WalletSignature } from "~~/contracts/multisig";
import type { Peer, PeerMeshState, WalletRecord, WalletTx } from "~~/hooks/usePeerMesh";
import { computeExecHash, defaultDeadline, saltFromLabel, sortSignatures } from "~~/utils/multisig";

export type WalletWindowProps = {
  mesh: PeerMeshState;
  myAddress: string | null;
  myHandle: string | null;
};

// Used everywhere — short addr render fallback when ENS isn't available.
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const WalletWindow = ({ mesh, myAddress, myHandle }: WalletWindowProps) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        overflow: "auto",
      }}
    >
      {mesh.wallet ? (
        <WalletDashboard mesh={mesh} wallet={mesh.wallet} myAddress={myAddress} myHandle={myHandle} />
      ) : (
        <WalletDeploy mesh={mesh} myAddress={myAddress} myHandle={myHandle} />
      )}
    </div>
  );
};

// ============================================================================
// Deploy flow
// ============================================================================

type DeployProps = {
  mesh: PeerMeshState;
  myAddress: string | null;
  myHandle: string | null;
};

const WalletDeploy = ({ mesh, myAddress, myHandle }: DeployProps) => {
  const { address: connectedAddress } = useAccount();
  const chainId = useChainId() ?? mainnet.id;
  const { switchChain, isPending: switching } = useSwitchChain();
  const chainLabel = chainId === base.id ? "Base" : chainId === mainnet.id ? "Ethereum mainnet" : `chain ${chainId}`;
  const onBase = chainId === base.id;
  const { writeContractAsync, isPending: writePending } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  // Pin the wait to the chain the deploy fired on — otherwise wagmi can
  // poll a different chain (mainnet) while the tx is mining on Base and
  // never resolve. Capture the chainId at submit time alongside the hash.
  const [txChainId, setTxChainId] = useState<number | null>(null);
  const {
    isLoading: receiptLoading,
    isError: receiptError,
    error: receiptErrorObj,
    data: receipt,
  } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId: txChainId ?? undefined,
  });

  const [label, setLabel] = useState<string>(() => `Episode ${new Date().toISOString().slice(0, 10)}`);

  // Manually-added signers (typed into AddressInput). Keyed lowercased,
  // separate from peer-derived so removing one doesn't conflict with the
  // mesh refilling the list.
  const [customSigners, setCustomSigners] = useState<{ address: string; label: string }[]>([]);

  // Candidate signers: peers with an ETH address + the current viewer +
  // any addresses the host typed in. Dedupe by lowercased address so a
  // typed-in address that matches a peer collapses to one row (and
  // keeps the peer's label / "you" marker).
  type Candidate = { address: string; label: string; isMe: boolean; source: "peer" | "me" | "custom" };
  const candidateSigners = useMemo<Candidate[]>(() => {
    const out = new Map<string, Candidate>();
    for (const p of mesh.peers as Peer[]) {
      if (!p.address) continue;
      const lower = p.address.toLowerCase();
      out.set(lower, {
        address: lower,
        label: p.handle ?? short(p.address),
        isMe: p.id === mesh.myId,
        source: "peer",
      });
    }
    if (myAddress) {
      const lower = myAddress.toLowerCase();
      const existing = out.get(lower);
      if (!existing) out.set(lower, { address: lower, label: myHandle ?? short(myAddress), isMe: true, source: "me" });
      else out.set(lower, { ...existing, isMe: true });
    }
    for (const c of customSigners) {
      const lower = c.address.toLowerCase();
      if (!out.has(lower)) {
        out.set(lower, { address: lower, label: c.label, isMe: false, source: "custom" });
      }
    }
    return Array.from(out.values()).sort((a, b) => {
      // Me first, then peers, then custom.
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      const rank = (s: Candidate["source"]) => (s === "me" ? 0 : s === "peer" ? 1 : 2);
      return rank(a.source) - rank(b.source);
    });
  }, [mesh.peers, mesh.myId, myAddress, myHandle, customSigners]);

  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // Default everyone to selected on first render / signer-list change.
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
    // Default threshold to majority — ceil(n/2) — clamped to current count.
    if (selectedSigners.length === 0) return;
    setThreshold(t => {
      const next = Math.min(Math.max(1, Math.ceil(selectedSigners.length / 2)), selectedSigners.length);
      return t > selectedSigners.length ? next : t;
    });
  }, [selectedSigners.length]);

  const salt = useMemo(() => saltFromLabel(`${connectedAddress ?? "0x0"}:${label}`), [connectedAddress, label]);

  // Predicted multisig address, recomputed when deployer/salt change.
  // Pin the read to mainnet so it works regardless of which chain the
  // user's wallet is currently selected on — the factory address is the
  // same on every chain, and reading it on mainnet just predicts where
  // the multisig *would* land for a (deployer, salt) pair.
  const {
    data: predicted,
    error: predictError,
    isLoading: predictLoading,
  } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: MultisigFactoryAbi,
    functionName: "getMultisigAddress",
    args: connectedAddress ? [connectedAddress, salt] : undefined,
    chainId: mainnet.id,
    query: { enabled: !!connectedAddress },
  });

  const [error, setError] = useState<string | null>(null);

  // Once the deploy tx confirms, build the WalletRecord from the
  // MultisigCreated event log and tell the relay.
  useEffect(() => {
    if (!receipt || !connectedAddress) return;
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
        setError("Couldn't find MultisigCreated log in receipt");
        return;
      }
      const record: WalletRecord = {
        id: Math.random().toString(36).slice(2),
        address: multisigAddr.toLowerCase(),
        chainId,
        deployer: connectedAddress.toLowerCase(),
        salt,
        signers: selectedSigners.map(s => ({ address: s.address, label: s.label, signerType: "eoa" })),
        threshold,
        txHash: receipt.transactionHash,
        createdAt: Date.now(),
        label,
      };
      mesh.walletDeploy(record);
      setTxHash(null);
    } catch (err) {
      setError(String(err).slice(0, 200));
    }
    // We intentionally only react to the receipt landing — selectedSigners /
    // threshold / label are read from the closure at deploy time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt]);

  const onDeploy = useCallback(async () => {
    setError(null);
    if (!connectedAddress) {
      setError("connect your wallet first");
      return;
    }
    if (selectedSigners.length === 0) {
      setError("pick at least one signer");
      return;
    }
    if (threshold < 1 || threshold > selectedSigners.length) {
      setError("threshold out of range");
      return;
    }
    try {
      const hash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: MultisigFactoryAbi,
        functionName: "createMultisig",
        chainId,
        args: [
          selectedSigners.map(s => s.address as AddressType),
          [], // passkeyQxs
          [], // passkeyQys
          [], // credentialIdHashes
          BigInt(threshold),
          salt,
        ],
      });
      setTxHash(hash);
      setTxChainId(chainId);
    } catch (err) {
      setError(String(err).slice(0, 200));
    }
  }, [connectedAddress, selectedSigners, threshold, salt, chainId, writeContractAsync]);

  const deploying = writePending || receiptLoading;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", letterSpacing: "0.08em" }}>
          Deploy session wallet
        </h2>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--slop-text-muted)" }}>
          Spin up a multisig for this episode. The signers below all have to approve transactions before they execute.
        </p>
      </div>

      <Field label="Episode label">
        <TextField
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Episode 12"
          disabled={deploying}
        />
      </Field>

      <Field label={`Signers (${selectedSigners.length})`}>
        {candidateSigners.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--slop-text-muted)", fontStyle: "italic", marginBottom: 6 }}>
            no guests with wallet addresses yet — type one below or wait for a peer to sign in
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
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
                  disabled={deploying}
                  onChange={e => setSelected(prev => ({ ...prev, [s.address]: e.target.checked }))}
                />
                <span style={{ flex: 1, fontSize: 12 }}>
                  <Address address={s.address as AddressType} size="xs" onlyEnsOrAddress />
                  {s.isMe ? <span style={{ marginLeft: 6, color: "var(--slop-text-muted)" }}>(you)</span> : null}
                  {s.source === "custom" ? (
                    <span style={{ marginLeft: 6, color: "var(--slop-text-muted)" }}>· added</span>
                  ) : null}
                </span>
                {s.source === "custom" ? (
                  <button
                    type="button"
                    aria-label="remove"
                    title="remove this signer"
                    disabled={deploying}
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
                      cursor: deploying ? "not-allowed" : "pointer",
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
          disabled={deploying}
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
          disabled={deploying || selectedSigners.length === 0}
          onChange={e => setThreshold(parseInt(e.target.value, 10))}
          style={{ width: "100%" }}
        />
      </Field>

      <Field label="Predicted address">
        <div style={{ fontSize: 12 }}>
          {predicted ? (
            <Address address={predicted as AddressType} size="sm" />
          ) : !connectedAddress ? (
            <span style={{ color: "var(--slop-text-muted)" }}>connect wallet</span>
          ) : predictError ? (
            <span style={{ color: "#ff7676" }}>error: {predictError.message.slice(0, 200)}</span>
          ) : predictLoading ? (
            <span style={{ color: "var(--slop-text-muted)" }}>reading factory on mainnet…</span>
          ) : (
            <span style={{ color: "var(--slop-text-muted)" }}>computing…</span>
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            color: "var(--slop-text-muted)",
            marginTop: 6,
          }}
        >
          <span>chain {chainId} · deployer</span>
          {connectedAddress ? (
            <Address address={connectedAddress as AddressType} size="xs" onlyEnsOrAddress />
          ) : (
            <span>—</span>
          )}
        </div>
      </Field>

      {error ? (
        <div
          style={{ fontSize: 11, color: "#ff7676", padding: 8, background: "rgba(255,118,118,0.08)", borderRadius: 4 }}
        >
          {error}
        </div>
      ) : null}

      {txHash ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--slop-text-muted)",
            padding: 8,
            background: "rgba(255,62,201,0.06)",
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div>
            tx submitted on chain {txChainId} —{" "}
            {receipt ? "confirmed, finalizing…" : receiptError ? "wait errored" : "waiting for inclusion…"}
          </div>
          <a
            href={`${txChainId === 8453 ? "https://basescan.org" : "https://etherscan.io"}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            style={{
              color: "var(--slop-magenta, #ff3ec9)",
              textDecoration: "underline",
              wordBreak: "break-all",
              fontFamily: "monospace",
              fontSize: 10,
            }}
          >
            {txHash}
          </a>
          {receiptError ? (
            <div style={{ color: "#ff7676" }}>{receiptErrorObj?.message?.slice(0, 240) ?? "wait failed"}</div>
          ) : null}
        </div>
      ) : null}

      {!onBase && connectedAddress ? (
        <div
          style={{
            fontSize: 11,
            color: "#ffce6a",
            padding: 8,
            background: "rgba(255,206,106,0.08)",
            border: "1px solid rgba(255,206,106,0.3)",
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div>
            Your wallet is on <strong>{chainLabel}</strong>. Deploying here costs real ETH (≈$1). Base costs pennies and
            the contracts are at the same address.
          </div>
          <div>
            <button
              type="button"
              disabled={switching}
              onClick={() => switchChain({ chainId: base.id })}
              style={{
                padding: "4px 10px",
                fontSize: 11,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                background: "var(--slop-magenta, #ff3ec9)",
                color: "#06030d",
                border: "none",
                borderRadius: 4,
                cursor: switching ? "wait" : "pointer",
                fontWeight: 700,
              }}
            >
              {switching ? "Switching…" : "Switch to Base"}
            </button>
          </div>
        </div>
      ) : null}

      {deploying ? (
        <LoadingBar
          caption={writePending ? "confirm in wallet…" : receiptLoading ? "waiting for inclusion…" : "finalizing…"}
        />
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <Button
          variant="primary"
          onClick={onDeploy}
          disabled={deploying || !connectedAddress || selectedSigners.length === 0}
        >
          {writePending ? "Confirm in wallet…" : receiptLoading ? "Waiting for inclusion…" : `Deploy on ${chainLabel}`}
        </Button>
        {txHash ? (
          <Button
            onClick={() => {
              setTxHash(null);
              setTxChainId(null);
              setError(null);
            }}
            disabled={writePending}
          >
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
};

// ============================================================================
// Dashboard (wallet deployed)
// ============================================================================

type DashboardProps = {
  mesh: PeerMeshState;
  wallet: WalletRecord;
  myAddress: string | null;
  myHandle: string | null;
};

const WalletDashboard = ({ mesh, wallet, myAddress }: DashboardProps) => {
  const pendingTxs = mesh.walletTxs.filter(t => t.status === "pending");
  const otherTxs = mesh.walletTxs.filter(t => t.status !== "pending").slice(0, 10);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14 }}>
      <WalletHeader wallet={wallet} onArchive={() => mesh.walletNewEpisode()} />
      <WalletBalances address={wallet.address} />
      <WalletSendForm wallet={wallet} mesh={mesh} />

      <Section title={`Pending (${pendingTxs.length})`}>
        {pendingTxs.length === 0 ? (
          <Empty>No transactions to sign. Have the browser submit something — it lands here.</Empty>
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
        Threshold {wallet.threshold} of {wallet.signers.length} · chain {wallet.chainId}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Balances panel — hits the local /api/portfolio proxy.
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
// Send form — propose a manual outgoing tx for signers to approve.
// Reads the multisig's current on-chain nonce, computes the execHash, and
// hands the result to the relay via walletProposeTx. The tx then shows up
// in "Pending" below where signers can sign + execute through TxCard.
// ----------------------------------------------------------------------------

const WalletSendForm = ({ wallet, mesh }: { wallet: WalletRecord; mesh: PeerMeshState }) => {
  const publicClient = usePublicClient({ chainId: wallet.chainId });
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
  if (amount.trim()) {
    try {
      amountWei = parseEther(amount.trim() as `${number}`);
    } catch {
      amountErr = "invalid amount";
    }
  } else {
    amountWei = 0n;
  }

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
        chainId: wallet.chainId,
        multisig: wallet.address as AddressType,
        nonce,
        deadline,
        target,
        value: amountWei,
        data: calldata,
      });
      mesh.walletProposeTx({
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
  }, [publicClient, targetOk, amountErr, amountWei, dataOk, data, recipient, wallet, mesh]);

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        Send
      </Button>
    );
  }

  return (
    <Section title="Send">
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
          <TextField
            inputMode="decimal"
            value={amount}
            placeholder="0.01"
            disabled={busy}
            onChange={e => setAmount(e.target.value)}
          />
          {amountErr ? <div style={{ fontSize: 10, color: "#ff7676", marginTop: 4 }}>{amountErr}</div> : null}
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
// Tx card + per-tx sign/execute flow
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
  const { isLoading: execWaiting, data: execReceipt } = useWaitForTransactionReceipt({ hash: execHash ?? undefined });
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
    if (connectedAddress.toLowerCase() !== myLowerAddress) {
      // This is informational — the connected wallet's address must match one
      // of the registered signers, otherwise the multisig will reject the sig.
    }
    try {
      const sig = await signMessageAsync({ message: { raw: tx.execHash as Hex } });
      mesh.walletSignTx(tx.id, { signer: connectedAddress.toLowerCase(), sigType: 0, data: sig });
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  }, [connectedAddress, myLowerAddress, signMessageAsync, mesh, tx.id, tx.execHash]);

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
          href={`https://etherscan.io/tx/${tx.txHash}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 10, color: "var(--slop-magenta, #ff3ec9)", textDecoration: "underline" }}
        >
          view on etherscan
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

// Inline form for adding a signer that's not on the guest list.
// AddressInput resolves ENS → 0x and shows the ENS avatar inside the field,
// so the host gets the same "feels right" preview as the rest of the app.
// Caller is responsible for dedupe against existing peers/custom signers.
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
  // AddressInput hands back the *resolved* 0x address once ENS resolves,
  // so by the time we see a 42-char 0x… string in `value` we're good to add.
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
