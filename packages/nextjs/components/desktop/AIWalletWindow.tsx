"use client";

import { useEffect, useMemo, useRef } from "react";
import { type Address as AddressType, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { MultisigAbi } from "~~/contracts/multisig";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";

// Hosts the slop-computer-ai-wallet fork inside a slop window. The iframe
// loads in "embedded" mode (?embedded=1&multisig=...&chain=...&signer=...)
// so the AI wallet treats this session's multisig as the operating wallet.
// When the user clicks "Send to multisig" in the iframe, the iframe emits a
// `slop:propose_tx` postMessage; we catch it here, compute the on-chain
// nonce + execHash, and call mesh.walletProposeTx({source: "manual"}) so
// the tx lands in the wallet app's pending queue.
//
// The AI wallet URL is set via NEXT_PUBLIC_AI_WALLET_URL at build time.
// Defaults to the production deploy (wallet.slop.computer); override
// locally by setting NEXT_PUBLIC_AI_WALLET_URL=http://localhost:3001 in
// packages/nextjs/.env.local when iterating against a local fork.

const AI_WALLET_URL = process.env.NEXT_PUBLIC_AI_WALLET_URL || "https://wallet.slop.computer";

type SlopProposeTxMessage = {
  type: "slop:propose_tx";
  chainId: number;
  target: string;
  value: string;
  data: string;
  summary?: string;
};

function isProposeTxMessage(v: unknown): v is SlopProposeTxMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.type === "slop:propose_tx" &&
    typeof m.chainId === "number" &&
    typeof m.target === "string" &&
    typeof m.value === "string" &&
    typeof m.data === "string"
  );
}

type SlopCursorMessage = { type: "slop:cursor"; x: number; y: number };
type SlopCursorLeaveMessage = { type: "slop:cursor:leave" };

function isCursorMessage(v: unknown): v is SlopCursorMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return m.type === "slop:cursor" && typeof m.x === "number" && typeof m.y === "number";
}

function isCursorLeaveMessage(v: unknown): v is SlopCursorLeaveMessage {
  if (!v || typeof v !== "object") return false;
  return (v as Record<string, unknown>).type === "slop:cursor:leave";
}

export type AIWalletWindowProps = {
  mesh: PeerMeshState;
  myAddress: string | null;
};

export const AIWalletWindow = ({ mesh, myAddress }: AIWalletWindowProps) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const wallet = mesh.wallet;
  // The wallet now lives on potentially multiple chains; pick the most
  // recently-deployed one as the "primary" for the AI iframe and for any
  // tx the iframe posts back. The agent can still target a different
  // deployed chain — we accept any chainId in postMessage as long as
  // the wallet has been deployed there.
  const primaryChainId = useMemo<number | null>(() => {
    if (!wallet) return null;
    const ids = Object.keys(wallet.deployments)
      .map(k => Number(k))
      .filter(n => Number.isFinite(n))
      .sort((a, b) => wallet.deployments[b].deployedAt - wallet.deployments[a].deployedAt);
    return ids[0] ?? null;
  }, [wallet]);
  const publicClient = usePublicClient({ chainId: primaryChainId ?? undefined });

  const iframeSrc = useMemo(() => {
    if (!wallet || primaryChainId === null) return null;
    const params = new URLSearchParams({
      embedded: "1",
      multisig: wallet.address,
      chain: String(primaryChainId),
    });
    if (myAddress) params.set("signer", myAddress);
    return `${AI_WALLET_URL}/?${params.toString()}`;
  }, [wallet, myAddress, primaryChainId]);

  useEffect(() => {
    if (!wallet) return;
    const handler = async (e: MessageEvent) => {
      // Only accept messages from the iframe we created — protects against
      // any other window posting fake propose_tx events.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (!isProposeTxMessage(e.data)) return;

      const msg = e.data;
      // The wallet must be deployed on the chain the agent is targeting,
      // otherwise the signed tx would be replay-vulnerable across chains.
      if (!(msg.chainId in wallet.deployments)) {
        console.warn("[ai-wallet] tx chainId not deployed", msg.chainId, "have", Object.keys(wallet.deployments));
        return;
      }
      if (!publicClient) {
        console.warn("[ai-wallet] no public client for chain", msg.chainId);
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
        console.warn("[ai-wallet] failed to queue propose_tx", err);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [wallet, publicClient, mesh]);

  // Cursor bridge: the iframe posts {type:"slop:cursor", x, y} on every
  // mousemove (iframe-viewport coords). We translate to parent-viewport
  // coords using the iframe's bounding rect and dispatch a synthetic
  // mousemove on window so useLocalCursor's capture-phase listener picks
  // it up and the custom cursor keeps tracking over the iframe. The
  // iframe also hides the system cursor on its side so nothing leaks
  // through. See slop-computer-ai-wallet's EmbeddedCursorBridge.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (isCursorMessage(e.data)) {
        const rect = iframeRef.current.getBoundingClientRect();
        const clientX = rect.left + e.data.x;
        const clientY = rect.top + e.data.y;
        window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY, bubbles: false }));
      } else if (isCursorLeaveMessage(e.data)) {
        // Iframe lost the pointer (e.g. mouse exited the iframe's document
        // bounds). No-op — the parent's native mousemove will fire as soon
        // as the pointer re-enters the parent's chrome.
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!wallet) {
    return (
      <div
        style={{
          display: "flex",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          textAlign: "center",
          fontFamily: "var(--slop-font-display)",
          color: "var(--slop-text-muted)",
          fontSize: 12,
          letterSpacing: "0.08em",
        }}
      >
        Deploy a wallet first — open the Wallet app and hit Deploy. The AI wallet needs a multisig to target.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#06030d" }}>
      <iframe
        ref={iframeRef}
        src={iframeSrc ?? undefined}
        title="Slop Computer AI Wallet"
        // Sandbox: scripts + same-origin so wagmi/RainbowKit (if it loads
        // standalone-mode internals) can run; popups for WalletConnect;
        // forms for any in-iframe submissions; allow-modals for the AI
        // wallet's confirmation dialog. No allow-top-navigation.
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals"
        // No allow= permissions — we don't want camera/mic/etc. inheriting.
        style={{
          flex: 1,
          width: "100%",
          height: "100%",
          border: 0,
          background: "#06030d",
        }}
      />
    </div>
  );
};

export default AIWalletWindow;
