"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { usePersonalWallet } from "~~/hooks/usePersonalWallet";
import { notifySessionChanged } from "~~/hooks/useSession";
import { createPasskeyAndAuth, loginWithExistingPasskey } from "~~/utils/passkey";

// Phase-0 surface for docs/PASSKEY-WALLET.md: shows a passkey user their
// spendable personal-wallet address (receive here), its Base balance, and
// deploy status. The raw passkey address is shown only as a muted, explicitly
// non-receivable identity line — the contrast IS the point.

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return [copied, copy];
}

export function PersonalWalletCard() {
  const pw = usePersonalWallet();
  const [copied, copy] = useCopy();
  const [busy, setBusy] = useState<null | "existing" | "create">(null);
  const [authStatus, setAuthStatus] = useState("");

  const runAuth = async (mode: "existing" | "create") => {
    if (busy) return;
    setBusy(mode);
    setAuthStatus("");
    try {
      if (mode === "existing") await loginWithExistingPasskey();
      else await createPasskeyAndAuth();
      // Hook listens for SESSION_CHANGED → refetches /auth/me and re-derives.
      notifySessionChanged();
    } catch (err) {
      const msg = (err as Error).message || "";
      if (!/cancel|NotAllowed/i.test(msg))
        setAuthStatus(`Passkey ${mode === "create" ? "create" : "sign-in"} failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const box: React.CSSProperties = {
    maxWidth: 420,
    border: "1px solid var(--slop-border, #444)",
    borderRadius: 8,
    padding: 16,
    background: "var(--slop-panel, #1b1b1f)",
    color: "var(--slop-text, #eee)",
    fontFamily: "var(--slop-font, monospace)",
  };
  const muted: React.CSSProperties = { color: "var(--slop-text-muted, #999)", fontSize: 11 };

  const authBtn: React.CSSProperties = {
    width: "100%",
    fontFamily: "inherit",
    fontSize: 13,
    border: "1px solid var(--slop-border, #444)",
    borderRadius: 6,
    padding: "10px 12px",
    cursor: busy ? "default" : "pointer",
    color: "inherit",
  };

  if (!pw.isPasskey) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Personal wallet</div>
        <div style={{ ...muted, marginBottom: 14 }}>Sign in with a passkey to get your wallet.</div>
        <button
          onClick={() => runAuth("existing")}
          disabled={!!busy}
          style={{ ...authBtn, background: "var(--slop-accent, #2b6cff)", borderColor: "transparent", fontWeight: 600 }}
        >
          {busy === "existing" ? "Waiting for passkey…" : "Sign in with passkey"}
        </button>
        <button
          onClick={() => runAuth("create")}
          disabled={!!busy}
          style={{ ...authBtn, background: "transparent", marginTop: 8 }}
        >
          {busy === "create" ? "Creating…" : "Create a new passkey"}
        </button>
        {authStatus && <div style={{ ...muted, color: "var(--slop-warn, #e6a700)", marginTop: 10 }}>{authStatus}</div>}
      </div>
    );
  }

  if (pw.deployerUnset) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Personal wallet</div>
        <div style={{ ...muted, color: "var(--slop-warn, #e6a700)" }}>
          Deployer not configured — set NEXT_PUBLIC_PERSONAL_WALLET_DEPLOYER to derive an address.
        </div>
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>Your wallet</span>
        <span style={{ ...muted, color: "var(--slop-accent, #7cf)" }}>passkey · Base</span>
      </div>

      {pw.personalAddress ? (
        <>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <div style={{ background: "#fff", padding: 8, borderRadius: 6 }}>
              <QRCodeSVG value={pw.personalAddress} size={132} />
            </div>
          </div>

          <div style={muted}>Receive address (send funds here)</div>
          <button
            onClick={() => copy(pw.personalAddress as string)}
            title="Copy"
            style={{
              width: "100%",
              textAlign: "left",
              fontFamily: "inherit",
              fontSize: 12,
              wordBreak: "break-all",
              background: "var(--slop-panel-2, #26262c)",
              color: "inherit",
              border: "1px solid var(--slop-border, #444)",
              borderRadius: 6,
              padding: "8px 10px",
              marginTop: 4,
              cursor: "pointer",
            }}
          >
            {pw.personalAddress} {copied ? "✓ copied" : "⧉"}
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <div>
              <div style={muted}>Balance</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                {pw.balanceFormatted != null ? `${pw.balanceFormatted} ETH` : "…"}
              </div>
            </div>
            <button
              onClick={pw.refetchBalance}
              style={{
                fontFamily: "inherit",
                fontSize: 11,
                background: "transparent",
                color: "var(--slop-accent, #7cf)",
                border: "1px solid var(--slop-border, #444)",
                borderRadius: 6,
                padding: "4px 8px",
                cursor: "pointer",
              }}
            >
              ↻ refresh
            </button>
          </div>

          <div style={{ ...muted, marginTop: 10 }}>
            {pw.deployed ? "● deployed on Base" : "○ not deployed yet — receiving still works (deploys on first spend)"}
          </div>
        </>
      ) : (
        <div style={muted}>{pw.loading ? "Deriving address…" : "Could not derive address."}</div>
      )}

      <div style={{ ...muted, marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--slop-border, #444)" }}>
        identity (do <b>not</b> send funds — unspendable):
        <br />
        <span style={{ wordBreak: "break-all", opacity: 0.7 }}>{pw.passkeyAddress}</span>
      </div>
    </div>
  );
}
