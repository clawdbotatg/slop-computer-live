"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { Bevel, Button } from "~~/components/ui";
import { useSession } from "~~/hooks/useSession";
import { createPasskeyAndAuth, loginWithExistingPasskey } from "~~/utils/passkey";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Sign-in card. Logo + two paths:
//   1. Connect Wallet → connect via wagmi/RainbowKit → auto-trigger SIWE
//      so the user signs once. The slop_session cookie persists for
//      sessionTTLSeconds (24h), so reload doesn't re-prompt.
//   2. Use Passkey → WebAuthn flow ported from slopwallet. Uses an
//      existing passkey if one is registered for this rpId; otherwise
//      a small "Create new passkey" affordance below.
export function JoinCard() {
  const { refresh } = useSession();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<"siwe" | "passkey-existing" | "passkey-create" | null>(null);

  const runSiwe = async (addr: string) => {
    setStatus("Requesting nonce...");
    try {
      const nonceRes = await fetch(`${RELAY_BASE}/auth/siwe/nonce`).then(r => r.json());
      const nonce: string = nonceRes.nonce;
      const domain = window.location.host;
      const uri = window.location.origin;
      const issuedAt = new Date().toISOString();
      const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        addr,
        ``,
        `Sign in to slop-computer-live.`,
        ``,
        `URI: ${uri}`,
        `Version: 1`,
        `Chain ID: 1`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
      ].join("\n");
      setStatus("Awaiting signature...");
      const signature = await signMessageAsync({ message });
      setStatus("Verifying signature...");
      const verifyRes = await fetch(`${RELAY_BASE}/auth/siwe`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature, nonce }),
      });
      const data = await verifyRes.json();
      if (!verifyRes.ok) {
        setStatus(`Sign-in failed: ${data.error ?? verifyRes.statusText}`);
        return;
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "";
      // RainbowKit / wagmi user-rejection — be quiet.
      if (/User rejected|Rejected|cancelled/i.test(msg)) {
        setStatus("");
      } else {
        setStatus(`Sign-in error: ${msg}`);
      }
    } finally {
      setBusy(null);
    }
  };

  // Auto-fire SIWE the moment the wallet is connected, but only if the
  // user explicitly clicked "Connect Wallet" (we record that intent in
  // a ref so a wagmi auto-reconnect on page load doesn't ambush them).
  const wantsSiweRef = useRef(false);
  useEffect(() => {
    if (!isConnected || !address) return;
    if (!wantsSiweRef.current) return;
    wantsSiweRef.current = false;
    setBusy("siwe");
    void runSiwe(address);
    // intentional: only trigger when isConnected/address transitions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  const onConnectWalletClick = () => {
    wantsSiweRef.current = true;
    if (isConnected && address) {
      // Already connected — kick off SIWE directly.
      setBusy("siwe");
      void runSiwe(address);
    }
    // If not connected, the RainbowKit button below handles the modal;
    // the useEffect picks up the resulting connection.
  };

  const onPasskeyExisting = async () => {
    if (busy) return;
    setBusy("passkey-existing");
    setStatus("Pick a passkey…");
    try {
      await loginWithExistingPasskey();
      setStatus("");
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "";
      if (/cancel|NotAllowed/i.test(msg)) setStatus("");
      else setStatus(`Passkey sign-in failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const onPasskeyCreate = async () => {
    if (busy) return;
    setBusy("passkey-create");
    setStatus("Creating passkey…");
    try {
      await createPasskeyAndAuth();
      setStatus("");
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "";
      if (/cancel|NotAllowed/i.test(msg)) setStatus("");
      else setStatus(`Passkey create failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Bevel style={{ padding: 24, width: "min(360px, 92vw)", textAlign: "center" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-mark.png"
        alt="slop"
        width={84}
        height={84}
        style={{ display: "block", margin: "0 auto 16px", imageRendering: "pixelated" }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Connect Wallet — wagmi/RainbowKit handles the connect modal. */}
        {!isConnected ? (
          <div onClickCapture={onConnectWalletClick}>
            <RainbowKitCustomConnectButton />
          </div>
        ) : (
          <Button variant="primary" onClick={onConnectWalletClick} disabled={busy === "siwe"}>
            {busy === "siwe" ? "Signing in…" : `Sign in as ${address?.slice(0, 6)}…${address?.slice(-4)}`}
          </Button>
        )}

        <Button onClick={onPasskeyExisting} disabled={busy !== null}>
          {busy === "passkey-existing" ? "Waiting for passkey…" : "Use Passkey"}
        </Button>
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={onPasskeyCreate}
          disabled={busy !== null}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--slop-text-muted)",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            cursor: busy ? "default" : "pointer",
            padding: 0,
          }}
        >
          {busy === "passkey-create" ? "Creating…" : "+ create new passkey"}
        </button>
      </div>

      {status ? <p style={{ marginTop: 12, color: "var(--slop-text-muted)", fontSize: 12 }}>{status}</p> : null}
    </Bevel>
  );
}
