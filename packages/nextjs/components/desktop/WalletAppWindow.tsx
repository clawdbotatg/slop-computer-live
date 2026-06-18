"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityTxQueue } from "./WalletWindow";
import { WalletAssetsPanel } from "./wallet/WalletAssetsPanel";
import { type ChatSigner, WalletChatPanel } from "./wallet/WalletChatPanel";
import { type WalletTxMode } from "./wallet/WalletTxCard";
import { type Portfolio } from "./wallet/types";
import { base } from "viem/chains";
import { useAccount, useChainId } from "wagmi";
import { PersonalWalletCard } from "~~/components/PersonalWalletCard";
import type { PeerMeshState, WalletRecord } from "~~/hooks/usePeerMesh";
import { usePersonalWallet } from "~~/hooks/usePersonalWallet";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { PERSONAL_WALLET_DEPLOYER, personalWalletSalt } from "~~/utils/personalWallet";

// The personal ("single-player") Wallet desktop app. It adapts to the account:
//
//   - passkey session → their personal smart-wallet (a slop Multisig, 1-of-2 at
//     threshold 1). Gets the full Bank-like experience: Holdings (Zerion) +
//     Chat (propose) + Transactions (a per-address tx queue they sign with the
//     passkey). Looks almost identical to the Bank, just a different signer set.
//   - connected EOA (MetaMask) → Holdings + Chat only. A chat- or asset-proposed
//     tx is "bubbled up" — executed directly via the connected wallet (pops
//     MetaMask). No Transactions tab, no queue.
//   - neither → prompt to sign in with a passkey or connect a wallet.
//
// The collaborative shared multisig builder lives in the separate "Bank" app.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const ACCENT = "var(--slop-magenta, #ff3ec9)";

type Tab = "holdings" | "chat" | "transactions";

export function WalletAppWindow({
  mesh,
  myAddress,
}: {
  mesh: PeerMeshState;
  myAddress: string | null;
  // Accepted for symmetry with the Bank's WalletWindow; the personal wallet
  // labels its lone passkey signer locally, so it isn't used here.
  myHandle?: string | null;
}) {
  const pw = usePersonalWallet();
  const { address: eoaAddress, isConnected } = useAccount();
  const connectedChainId = useChainId();

  // Account-type detection. The passkey path is our slop multisig (deterministic
  // from the passkey); a connected wallet is treated as a plain EOA.
  const isPasskeyMultisig = pw.isPasskey && !!pw.personalAddress && !!pw.passkeyIdentity && !pw.deployerUnset;
  const mode: WalletTxMode = isPasskeyMultisig ? "multisig" : "eoa";
  const activeAddress = isPasskeyMultisig ? pw.personalAddress : isConnected && eoaAddress ? eoaAddress : null;

  // Synthesize a WalletRecord the reused Bank panels render against.
  const record = useMemo<WalletRecord | null>(() => {
    if (isPasskeyMultisig && pw.personalAddress && pw.passkeyAddress && pw.passkeyIdentity) {
      return {
        id: `personal:${pw.personalAddress}`,
        address: pw.personalAddress.toLowerCase(),
        deployer: PERSONAL_WALLET_DEPLOYER,
        salt: personalWalletSalt(pw.passkeyAddress),
        // Threshold 1 + you hold the passkey ⇒ one passkey signature executes.
        // The 1-of-2 recovery co-signer is cosmetic for signing, so we omit it.
        signers: [
          {
            address: pw.passkeyAddress.toLowerCase(),
            label: "you (passkey)",
            signerType: "passkey",
            qx: pw.passkeyIdentity.qx,
            qy: pw.passkeyIdentity.qy,
            credentialIdHash: pw.passkeyIdentity.credentialIdHash,
          },
        ],
        threshold: 1,
        // Personal wallet is Base-only. Seed a deployment entry once deployed so
        // the propose/sign affordances unlock; pre-deploy stays read-only.
        deployments: pw.deployed
          ? ({ [base.id]: { txHash: null, deployedAt: 0 } } as Record<
              number,
              { txHash: string | null; deployedAt: number }
            >)
          : {},
        createdAt: 0,
        label: "Personal wallet",
      };
    }
    if (isConnected && eoaAddress) {
      return {
        id: `eoa:${eoaAddress.toLowerCase()}`,
        address: eoaAddress.toLowerCase(),
        deployer: "",
        salt: "0x",
        signers: [{ address: eoaAddress.toLowerCase(), label: "you", signerType: "eoa" }],
        threshold: 1,
        deployments: {},
        createdAt: 0,
        label: "Your wallet",
      };
    }
    return null;
  }, [
    isPasskeyMultisig,
    isConnected,
    eoaAddress,
    pw.personalAddress,
    pw.passkeyAddress,
    pw.passkeyIdentity,
    pw.deployed,
  ]);

  // Signer set handed to the intent engine for the personal multisig (the relay
  // holds no record for it). EOA has just itself.
  const chatSigners = useMemo<ChatSigner[]>(
    () =>
      record
        ? record.signers.map(s => ({
            address: s.address,
            kind: s.signerType === "passkey" ? "passkey" : "account",
            label: s.label,
          }))
        : [],
    [record],
  );

  // The operating chain for chat/proposals. Personal multisig → Base (so chat
  // works even before deploy); EOA → the connected chain.
  const chainIdOverride = isPasskeyMultisig ? base.id : connectedChainId;

  // --- Portfolio fetch (Zerion via the relay proxy) ------------------------
  const slug = useRoomSlug();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [pfLoading, setPfLoading] = useState(false);
  const [pfError, setPfError] = useState<string | null>(null);

  const refreshPortfolio = useCallback(async () => {
    if (!activeAddress) return;
    setPfLoading(true);
    setPfError(null);
    try {
      const res = await fetch(withSlug(`${RELAY_HTTP}/v1/wallet/portfolio?address=${activeAddress}`, slug), {
        credentials: "include",
      });
      if (res.ok) setPortfolio((await res.json()) as Portfolio);
      else setPfError(`portfolio: relay ${res.status}`);
    } catch (err) {
      setPfError(`network error: ${String(err).slice(0, 120)}`);
    } finally {
      setPfLoading(false);
    }
  }, [activeAddress, slug]);

  useEffect(() => {
    setPortfolio(null);
    if (activeAddress) void refreshPortfolio();
  }, [activeAddress, refreshPortfolio]);

  // Refresh after one of this wallet's queued txs executes (Zerion indexer lag
  // means a couple delayed passes catch the new balances). Multisig only.
  const personalTxs = isPasskeyMultisig && activeAddress ? mesh.walletTxsFor(activeAddress) : null;
  const executedCount = useMemo(
    () => (personalTxs ? personalTxs.filter(t => t.status === "executed").length : 0),
    [personalTxs],
  );
  useEffect(() => {
    if (!isPasskeyMultisig || executedCount === 0) return;
    const a = setTimeout(() => void refreshPortfolio(), 5_000);
    const b = setTimeout(() => void refreshPortfolio(), 15_000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [executedCount, isPasskeyMultisig, refreshPortfolio]);

  // --- Tabs ----------------------------------------------------------------
  const tabs: Tab[] = isPasskeyMultisig ? ["holdings", "chat", "transactions"] : ["holdings", "chat"];
  const [tab, setTab] = useState<Tab>("holdings");
  useEffect(() => {
    // Drop to a valid tab if the account type changes (e.g. passkey → EOA).
    if (!tabs.includes(tab)) setTab("holdings");
  }, [tabs, tab]);

  const [showReceive, setShowReceive] = useState(false);

  // --- Render --------------------------------------------------------------

  // Signed out: prompt. PersonalWalletCard renders passkey sign-in/create
  // buttons; an EOA user connects via the menubar wallet button.
  if (!record || !activeAddress) {
    return (
      <div style={{ padding: 16, display: "grid", placeItems: "center", height: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <PersonalWalletCard />
          <div style={{ fontSize: 11, color: "var(--slop-text-muted, #999)", textAlign: "center" }}>
            …or connect a wallet from the menubar to use it here.
          </div>
        </div>
      </div>
    );
  }

  const pendingCount = personalTxs ? personalTxs.filter(t => t.status === "pending").length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Account strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid rgba(255,62,201,0.18)",
          background: "rgba(0,0,0,0.25)",
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slop-text, #eee)" }}>
            {isPasskeyMultisig ? "Personal wallet" : "Your wallet"}
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--slop-accent, #7cf)" }}>
              {isPasskeyMultisig ? `passkey · ${pw.deployed ? "deployed" : "counterfactual"}` : "connected EOA"}
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--slop-text-muted, #999)",
              wordBreak: "break-all",
              fontFamily: "monospace",
            }}
          >
            {activeAddress}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {isPasskeyMultisig ? (
            <button
              type="button"
              onClick={() => setShowReceive(s => !s)}
              style={pillStyle(showReceive)}
              title="Show your receive address / deploy"
            >
              {showReceive ? "Hide" : "Receive"}
            </button>
          ) : null}
          <button type="button" onClick={() => void refreshPortfolio()} style={pillStyle(false)} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {/* Total balance */}
      <div style={{ padding: "8px 12px", flexShrink: 0 }}>
        <div
          style={{
            fontSize: 10,
            color: "var(--slop-text-muted, #999)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          Total
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--slop-text, #eee)" }}>
          {portfolio
            ? `$${Number(portfolio.totalBalanceUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
            : "…"}
        </div>
      </div>

      {/* Receive / deploy card (passkey only, collapsible) */}
      {isPasskeyMultisig && showReceive ? (
        <div style={{ padding: "0 12px 8px", display: "grid", placeItems: "center", flexShrink: 0 }}>
          <PersonalWalletCard />
        </div>
      ) : null}

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "0 8px",
          borderBottom: "1px solid rgba(255,62,201,0.18)",
          flexShrink: 0,
        }}
      >
        {tabs.map(t => {
          const active = t === tab;
          const badge = t === "transactions" && pendingCount > 0 ? ` (${pendingCount})` : "";
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                padding: "8px 12px",
                fontSize: 10,
                fontFamily: "var(--slop-font-display, monospace)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontWeight: 700,
                background: "transparent",
                color: active ? ACCENT : "var(--slop-text-muted, #999)",
                border: "none",
                borderBottom: active ? `2px solid ${ACCENT}` : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {t}
              {badge}
            </button>
          );
        })}
      </div>

      {/* Tab body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ display: tab === "holdings" ? "block" : "none" }}>
          <WalletAssetsPanel
            wallet={record}
            mesh={mesh}
            portfolio={portfolio}
            loading={pfLoading}
            error={pfError}
            mode={mode}
            walletAddress={isPasskeyMultisig ? activeAddress : undefined}
            chainIdOverride={isPasskeyMultisig ? undefined : connectedChainId}
          />
        </div>
        <div
          style={{
            flex: tab === "chat" ? 1 : undefined,
            display: tab === "chat" ? "flex" : "none",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <WalletChatPanel
            mesh={mesh}
            wallet={record}
            mode={mode}
            walletAddress={isPasskeyMultisig ? activeAddress : undefined}
            chainIdOverride={chainIdOverride}
            signers={chatSigners}
            threshold={record.threshold}
          />
        </div>
        {isPasskeyMultisig ? (
          <div style={{ display: tab === "transactions" ? "block" : "none" }}>
            <ActivityTxQueue
              mesh={mesh}
              wallet={record}
              myAddress={pw.passkeyAddress ?? myAddress}
              walletAddress={activeAddress}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    fontSize: 11,
    fontFamily: "var(--slop-font-display, monospace)",
    letterSpacing: "0.06em",
    background: active ? "rgba(255,62,201,0.2)" : "transparent",
    color: active ? ACCENT : "var(--slop-text-muted, #999)",
    border: "1px solid rgba(255,62,201,0.3)",
    borderRadius: 4,
    cursor: "pointer",
  };
}
