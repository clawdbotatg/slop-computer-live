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
  reverseNodeFor,
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
//
// The two reverse reads are different things and both are shown: the RAW
// record (name() on the multisig's reverse node — what setName wrote) and
// whether the name RESOLVES (viem getEnsName, which also requires the
// forward addr() to match). "✓ set" is the raw record. A set-but-not-
// resolving record means step 1 is what's missing — never re-propose it.

export type EnsWindowProps = {
  mesh: PeerMeshState;
};

type EnsStatus = {
  parentOwner: Address | null;
  subnodeOwner: Address | null;
  subnodeResolver: Address | null;
  forwardAddr: Address | null;
  /** Raw reverse record: name() on the multisig's reverse node (null = none). */
  reverseRecord: string | null;
  /** What apps see: getEnsName, which also checks the forward record. */
  reverseResolved: string | null;
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
const errorBox: CSSProperties = {
  color: "var(--slop-red)",
  fontSize: 11,
  lineHeight: 1.5,
  border: "1px solid var(--slop-red)",
  borderRadius: 4,
  padding: "6px 8px",
  background: "rgba(255,0,60,0.08)",
  wordBreak: "break-word",
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
  // Which card the error belongs to — it renders INSIDE that card, where the
  // eye already is, not as a footnote under both (the 09-22 forward run
  // stopped after tx 1 of 2 and nobody saw why).
  const [errorPhase, setErrorPhase] = useState<"forward" | "reverse">("forward");
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
      // Reverse: the RAW record on the multisig's reverse node (what setName
      // wrote), the resolved name (what apps see — null until the forward
      // addr matches too), and whether the multisig has code on mainnet
      // (required before it can execute setName).
      let reverseRecord: string | null = null;
      let reverseResolved: string | null = null;
      let multisigOnMainnet = false;
      if (multisig) {
        const reverseNode = reverseNodeFor(multisig);
        const [reverseResolver, resolved, code] = await Promise.all([
          mainnet.readContract({
            address: ENS_REGISTRY,
            abi: EnsRegistryAbi,
            functionName: "resolver",
            args: [reverseNode],
          }),
          // The universal resolver reverts on some malformed records; a
          // failed resolve must not blank the whole status panel.
          mainnet.getEnsName({ address: multisig }).catch(() => null),
          mainnet.getCode({ address: multisig }),
        ]);
        if (reverseResolver && reverseResolver !== zeroAddress) {
          reverseRecord = (await mainnet
            .readContract({
              address: reverseResolver as Address,
              abi: EnsResolverAbi,
              functionName: "name",
              args: [reverseNode],
            })
            .catch(() => "")) as string;
          if (!reverseRecord) reverseRecord = null;
        }
        reverseResolved = resolved ?? null;
        multisigOnMainnet = !!code && code !== "0x";
      }
      setStatus({
        parentOwner: parentOwner as Address,
        subnodeOwner: subnodeOwner as Address,
        subnodeResolver: resolverAddr,
        forwardAddr: forwardAddr && forwardAddr !== zeroAddress ? forwardAddr : null,
        reverseRecord,
        reverseResolved,
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
  // Step 1 half-done: the subdomain exists (created by a previous run) but
  // its addr() isn't the multisig yet — one tx (setAddr) is left.
  const subnodeExists = !!(status?.subnodeOwner && status.subnodeOwner !== zeroAddress);
  const forwardPartial = subnodeExists && !forwardDone;
  const reverseDone = !!(status?.reverseRecord && status.reverseRecord.toLowerCase() === subdomain.toLowerCase());
  const reverseResolves = !!(
    status?.reverseResolved && status.reverseResolved.toLowerCase() === subdomain.toLowerCase()
  );
  const isOwner = !!(
    connectedAddress &&
    status?.parentOwner &&
    isAddressEqual(connectedAddress as Address, status.parentOwner)
  );

  const setForward = useCallback(async () => {
    setError(null);
    setErrorPhase("forward");
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
      // Tx 1 may have landed before tx 2 failed — show the half-done state
      // so the next click is visibly "one tx left", not a mystery.
      void refresh();
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
    setErrorPhase("reverse");
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
        {forwardPartial && multisig ? (
          <div style={{ ...muted, color: "var(--slop-amber)" }}>
            ⚠️ The subdomain exists but its address isn&apos;t the multisig yet — a previous run stopped after tx 1 of
            2. One tx left (set address).
          </div>
        ) : null}
        {error && errorPhase === "forward" ? <div style={errorBox}>{error}</div> : null}

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
              {forwardPartial ? "Set address (1 tx)" : "Set forward record"}
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
          record →{" "}
          <span style={{ color: reverseDone ? "var(--slop-lime)" : "var(--slop-amber)" }}>
            {status?.reverseRecord ?? "not set"}
          </span>
        </div>
        {status ? (
          <div style={muted}>
            resolves →{" "}
            <span style={{ color: reverseResolves ? "var(--slop-lime)" : "var(--slop-amber)" }}>
              {reverseResolves ? "yes" : "no"}
            </span>
          </div>
        ) : null}
        {reverseDone && !reverseResolves ? (
          <div style={{ ...muted, color: "var(--slop-amber)" }}>
            ⚠️ The reverse record is set — nothing to redo here. It won&apos;t resolve until step 1 points{" "}
            <span style={codeName}>{subdomain}</span> at the multisig: reverse lookups check the forward record too.
          </div>
        ) : null}
        {error && errorPhase === "reverse" ? <div style={errorBox}>{error}</div> : null}

        {!reverseDone && multisig ? (
          busy === "reverse" ? (
            <LoadingBar caption={step ?? "working…"} />
          ) : proposed ? (
            <div style={{ ...muted, color: "var(--slop-lime)" }}>
              ✓ Proposed. Open the <b>WALLET</b> app → Transactions to sign + execute it.
            </div>
          ) : !status?.multisigOnMainnet ? (
            <div style={{ ...muted, color: "var(--slop-amber)" }}>
              ⚠️ The multisig isn&apos;t deployed on Ethereum mainnet yet — the reverse record runs as a tx executed{" "}
              <i>by</i> the multisig, so the contract has to exist on mainnet first. Open the <b>WALLET</b> app, deploy
              the multisig on <b>Ethereum mainnet</b>, then come back here to propose this record.
            </div>
          ) : (
            <Button variant="primary" onClick={() => void proposeReverse()} disabled={busy !== null}>
              Propose to wallet
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
};
