"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  type Address,
  type Hex,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  labelhash,
  namehash,
  zeroAddress,
} from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { Button, LoadingBar, SlopAddress } from "~~/components/ui";
import {
  ENS_CHAIN_ID,
  ENS_PUBLIC_RESOLVER,
  ENS_REGISTRY,
  ENS_REVERSE_REGISTRAR,
  EnsRegistryAbi,
  EnsResolverAbi,
  EnsReverseRegistrarAbi,
  PARENT_NAME,
  PARENT_NODE,
  subdomainFor,
} from "~~/contracts/ens";
import { MultisigAbi } from "~~/contracts/multisig";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";

// ENS app. Wires <slug>.slopcomputer.eth ←→ the room's multisig without
// leaving live.slop.computer. Two phases, mirroring how the records
// actually have to be set on-chain:
//
//   1. FORWARD — <slug>.slopcomputer.eth → multisig. Only the owner of
//      slopcomputer.eth can do this, so it runs as two txs the connected
//      owner wallet signs directly: create the subnode (Registry
//      .setSubnodeRecord, owner = you, resolver = the public resolver),
//      then point it (Resolver.setAddr → multisig). Both on mainnet.
//
//   2. REVERSE — multisig → <slug>.slopcomputer.eth. Only the multisig can
//      set its own primary name (ReverseRegistrar.setName uses msg.sender),
//      so this is *proposed* into the wallet's tx queue via walletProposeTx
//      and the signers sign + execute it from the WALLET app's
//      Transactions tab. Requires the multisig deployed on mainnet.
//
// Everything is read live from mainnet, idempotent (already-correct
// records are skipped + shown with a ✓), and scoped to the current room.

export type EnsWindowProps = {
  mesh: PeerMeshState;
};

type EnsStatus = {
  parentOwner: Address | null;
  subnodeOwner: Address | null;
  subnodeResolver: Address | null;
  forwardAddr: Address | null;
  reverseName: string | null;
  multisigOnMainnet: boolean;
};

function shortErr(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  if (/user rejected|denied|rejected the request/i.test(s)) return "Transaction rejected.";
  return s.split("\n")[0].slice(0, 200);
}

const card: CSSProperties = {
  border: "1px solid var(--slop-border, #2a1d4a)",
  borderRadius: 6,
  padding: 12,
  background: "rgba(255,255,255,0.03)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const stepLabel: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--slop-cyan)",
  fontFamily: "var(--slop-font-display)",
};
const muted: CSSProperties = { color: "var(--slop-text-muted)", fontSize: 11, lineHeight: 1.5 };
const codeName: CSSProperties = {
  color: "var(--slop-lime)",
  fontFamily: "var(--slop-font-mono)",
  wordBreak: "break-all",
};
const doneBadge: CSSProperties = {
  color: "var(--slop-lime)",
  fontSize: 11,
  fontFamily: "var(--slop-font-display)",
  letterSpacing: "0.08em",
};

export const EnsWindow = ({ mesh }: EnsWindowProps) => {
  const slug = useRoomSlug();
  const wallet = mesh.wallet;
  const multisig = wallet?.address ? (getAddress(wallet.address) as Address) : null;
  const subdomain = subdomainFor(slug);
  const node = useMemo(() => namehash(subdomain), [subdomain]);
  const label = useMemo(() => labelhash(slug), [slug]);

  const mainnet = usePublicClient({ chainId: ENS_CHAIN_ID });
  const { address: connectedAddress, isConnected, chainId: connectedChainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [status, setStatus] = useState<EnsStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [busy, setBusy] = useState<null | "forward" | "reverse">(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposed, setProposed] = useState(false);

  const refresh = useCallback(async () => {
    if (!mainnet) return;
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const [parentOwner, subnodeOwner, subnodeResolver] = await Promise.all([
        mainnet.readContract({
          address: ENS_REGISTRY,
          abi: EnsRegistryAbi,
          functionName: "owner",
          args: [PARENT_NODE],
        }),
        mainnet.readContract({ address: ENS_REGISTRY, abi: EnsRegistryAbi, functionName: "owner", args: [node] }),
        mainnet.readContract({ address: ENS_REGISTRY, abi: EnsRegistryAbi, functionName: "resolver", args: [node] }),
      ]);
      // The forward addr is only meaningful once the subnode points at a
      // resolver — read it from whatever resolver is registered.
      let forwardAddr: Address | null = null;
      const resolverAddr = subnodeResolver as Address;
      if (resolverAddr && resolverAddr !== zeroAddress) {
        forwardAddr = (await mainnet.readContract({
          address: resolverAddr,
          abi: EnsResolverAbi,
          functionName: "addr",
          args: [node],
        })) as Address;
      }
      // Reverse name + whether the multisig actually has code on mainnet
      // (required before it can execute setName).
      let reverseName: string | null = null;
      let multisigOnMainnet = false;
      if (multisig) {
        const [name, code] = await Promise.all([
          mainnet.getEnsName({ address: multisig }),
          mainnet.getCode({ address: multisig }),
        ]);
        reverseName = name ?? null;
        multisigOnMainnet = !!code && code !== "0x";
      }
      setStatus({
        parentOwner: parentOwner as Address,
        subnodeOwner: subnodeOwner as Address,
        subnodeResolver: resolverAddr,
        forwardAddr: forwardAddr && forwardAddr !== zeroAddress ? forwardAddr : null,
        reverseName,
        multisigOnMainnet,
      });
    } catch (err) {
      setStatusError(shortErr(err));
    } finally {
      setLoadingStatus(false);
    }
  }, [mainnet, node, multisig]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const forwardDone = !!(status?.forwardAddr && multisig && isAddressEqual(status.forwardAddr, multisig));
  const reverseDone = !!(status?.reverseName && status.reverseName.toLowerCase() === subdomain.toLowerCase());
  const isOwner = !!(
    connectedAddress &&
    status?.parentOwner &&
    isAddressEqual(connectedAddress as Address, status.parentOwner)
  );

  const setForward = useCallback(async () => {
    setError(null);
    if (!multisig) {
      setError("This room has no multisig yet — deploy one in the WALLET app first.");
      return;
    }
    if (!mainnet) {
      setError("No mainnet RPC client.");
      return;
    }
    if (!isConnected || !connectedAddress) {
      openConnectModal?.();
      return;
    }
    if (!status?.parentOwner || !isAddressEqual(connectedAddress as Address, status.parentOwner)) {
      setError(`Connect the ${PARENT_NAME} owner wallet to set this record.`);
      return;
    }
    setBusy("forward");
    try {
      if (connectedChainId !== ENS_CHAIN_ID) {
        setStep("Switching to Ethereum mainnet…");
        await switchChainAsync({ chainId: ENS_CHAIN_ID });
      }
      const owner = connectedAddress as Address;
      // (1) Create / re-own the subnode if it isn't already owned by us and
      // pointed at the public resolver. setSubnodeRecord does both atomically
      // and can only be called by the parent (slopcomputer.eth) owner.
      const subnodeReady =
        status.subnodeOwner &&
        isAddressEqual(status.subnodeOwner, owner) &&
        status.subnodeResolver &&
        isAddressEqual(status.subnodeResolver, ENS_PUBLIC_RESOLVER);
      if (!subnodeReady) {
        setStep(`Creating ${subdomain}…`);
        const hash = await writeContractAsync({
          chainId: ENS_CHAIN_ID,
          address: ENS_REGISTRY,
          abi: EnsRegistryAbi,
          functionName: "setSubnodeRecord",
          args: [PARENT_NODE, label, owner, ENS_PUBLIC_RESOLVER, 0n],
        });
        setStep("Waiting for confirmation…");
        await mainnet.waitForTransactionReceipt({ hash });
      }
      // (2) Point the subnode's addr() record at the multisig.
      setStep(`Pointing ${subdomain} → multisig…`);
      const hash2 = await writeContractAsync({
        chainId: ENS_CHAIN_ID,
        address: ENS_PUBLIC_RESOLVER,
        abi: EnsResolverAbi,
        functionName: "setAddr",
        args: [node, multisig],
      });
      setStep("Waiting for confirmation…");
      await mainnet.waitForTransactionReceipt({ hash: hash2 });
      setStep(null);
      await refresh();
    } catch (err) {
      setError(shortErr(err));
    } finally {
      setBusy(null);
      setStep(null);
    }
  }, [
    multisig,
    mainnet,
    isConnected,
    connectedAddress,
    connectedChainId,
    status,
    subdomain,
    node,
    label,
    switchChainAsync,
    writeContractAsync,
    openConnectModal,
    refresh,
  ]);

  const proposeReverse = useCallback(async () => {
    setError(null);
    setProposed(false);
    if (!multisig) {
      setError("This room has no multisig yet — deploy one in the WALLET app first.");
      return;
    }
    if (!mainnet) {
      setError("No mainnet RPC client.");
      return;
    }
    if (!status?.multisigOnMainnet) {
      setError(
        "The multisig isn't deployed on Ethereum mainnet yet — deploy it on mainnet in the WALLET app, then propose.",
      );
      return;
    }
    setBusy("reverse");
    try {
      setStep("Reading multisig nonce…");
      const nonce = (await mainnet.readContract({
        address: multisig,
        abi: MultisigAbi,
        functionName: "nonce",
      })) as bigint;
      const deadline = defaultDeadline();
      const target = ENS_REVERSE_REGISTRAR as Address;
      const value = 0n;
      const data: Hex = encodeFunctionData({
        abi: EnsReverseRegistrarAbi,
        functionName: "setName",
        args: [subdomain],
      });
      const execHash = computeExecHash({ chainId: ENS_CHAIN_ID, multisig, nonce, deadline, target, value, data });
      mesh.walletProposeTx({
        chainId: ENS_CHAIN_ID,
        target,
        value: "0",
        data,
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        execHash,
        source: "manual",
        browserId: null,
      });
      setProposed(true);
    } catch (err) {
      setError(shortErr(err));
    } finally {
      setBusy(null);
      setStep(null);
    }
  }, [multisig, mainnet, status, subdomain, mesh]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        overflowY: "auto",
        padding: 12,
        gap: 12,
        fontSize: 12,
      }}
    >
      {/* Header — the target name + multisig */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 11, ...stepLabel, color: "var(--slop-magenta)" }}>ENS · this room</div>
        <div style={{ ...codeName, fontSize: 18 }}>{subdomain}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, ...muted }}>
          <span>→</span>
          {multisig ? (
            <SlopAddress address={multisig} customNames={mesh.customNames} />
          ) : (
            <span style={{ color: "var(--slop-amber)" }}>no room multisig yet</span>
          )}
        </div>
      </div>

      {!multisig ? (
        <div style={{ ...card, borderColor: "var(--slop-amber)" }}>
          <div style={muted}>
            This room doesn&apos;t have a multisig wallet yet. Open the <b>WALLET</b> app and deploy one, then come back
            here to claim <span style={codeName}>{subdomain}</span> for it.
          </div>
        </div>
      ) : null}

      {/* Status / parent ownership note */}
      <div style={{ ...muted, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {loadingStatus ? (
          <span>reading mainnet…</span>
        ) : statusError ? (
          <span style={{ color: "var(--slop-red)" }}>{statusError}</span>
        ) : status ? (
          <>
            <span>
              {PARENT_NAME} owner:&nbsp;
              {status.parentOwner ? <SlopAddress address={status.parentOwner} customNames={mesh.customNames} /> : "—"}
            </span>
          </>
        ) : null}
        <Button onClick={() => void refresh()} style={{ marginLeft: "auto", fontSize: 10, padding: "2px 8px" }}>
          ↻ refresh
        </Button>
      </div>

      {/* STEP 1 — forward record */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={stepLabel}>1 · forward record</span>
          {forwardDone ? <span style={doneBadge}>✓ set</span> : null}
        </div>
        <div style={muted}>
          Points <span style={codeName}>{subdomain}</span> at the multisig. You sign this directly as the {PARENT_NAME}{" "}
          owner (two mainnet txs: create the subdomain, then set its address).
        </div>
        {status?.forwardAddr ? (
          <div style={muted}>
            currently →{" "}
            <span style={{ color: forwardDone ? "var(--slop-lime)" : "var(--slop-amber)" }}>{status.forwardAddr}</span>
          </div>
        ) : (
          <div style={muted}>currently → not set</div>
        )}

        {!forwardDone && multisig ? (
          busy === "forward" ? (
            <LoadingBar caption={step ?? "working…"} />
          ) : !isConnected ? (
            <Button variant="primary" onClick={() => openConnectModal?.()}>
              Connect owner wallet
            </Button>
          ) : !isOwner ? (
            <div style={{ ...muted, color: "var(--slop-amber)" }}>
              Connected wallet isn&apos;t the {PARENT_NAME} owner. Switch to the owner account to set this record.
            </div>
          ) : (
            <Button variant="primary" onClick={() => void setForward()} disabled={busy !== null}>
              Set forward record
            </Button>
          )
        ) : null}
      </div>

      {/* STEP 2 — reverse record */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={stepLabel}>2 · reverse record</span>
          {reverseDone ? <span style={doneBadge}>✓ set</span> : null}
        </div>
        <div style={muted}>
          Sets the multisig&apos;s primary name to <span style={codeName}>{subdomain}</span>. Only the multisig can do
          this, so it&apos;s proposed into the wallet&apos;s tx queue — signers sign + execute it from the <b>WALLET</b>{" "}
          app&apos;s Transactions tab.
        </div>
        <div style={muted}>
          currently →{" "}
          <span style={{ color: reverseDone ? "var(--slop-lime)" : "var(--slop-amber)" }}>
            {status?.reverseName ?? "not set"}
          </span>
        </div>

        {!reverseDone && multisig ? (
          busy === "reverse" ? (
            <LoadingBar caption={step ?? "working…"} />
          ) : proposed ? (
            <div style={{ ...muted, color: "var(--slop-lime)" }}>
              ✓ Proposed. Open the <b>WALLET</b> app → Transactions to sign + execute it.
            </div>
          ) : !status?.multisigOnMainnet ? (
            <div style={{ ...muted, color: "var(--slop-amber)" }}>
              The multisig isn&apos;t deployed on Ethereum mainnet yet. Deploy it on mainnet in the WALLET app, then
              propose here.
            </div>
          ) : (
            <Button variant="primary" onClick={() => void proposeReverse()} disabled={busy !== null}>
              Propose to wallet
            </Button>
          )
        ) : null}
      </div>

      {error ? <div style={{ color: "var(--slop-red)", fontSize: 11 }}>{error}</div> : null}
    </div>
  );
};
