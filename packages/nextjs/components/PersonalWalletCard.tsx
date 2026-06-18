"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { usePersonalWallet } from "~~/hooks/usePersonalWallet";
import { notifySessionChanged } from "~~/hooks/useSession";
import { createPasskeyAndAuth, loginWithExistingPasskey } from "~~/utils/passkey";

// Phase-0 surface for docs/PASSKEY-WALLET.md: shows a passkey user their
// spendable personal-wallet address (receive here), its Base balance, and
// deploy status. The raw (unspendable) passkey identity address is intentionally
// not surfaced here — only the spendable personal-wallet address is shown.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

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
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState("");
  const [funding, setFunding] = useState(false);
  const [fundMsg, setFundMsg] = useState("");

  // Apple Pay → ETH on Base, straight into this wallet. The relay mints a
  // single-use Coinbase Onramp session (CDP key is server-only) and returns the
  // one-time onramp URL; we open it to launch the Apple Pay sheet. Works for a
  // counterfactual address (receiving needs no deploy). See docs/PASSKEY-WALLET.md §13.
  const fundWithApplePay = async () => {
    if (!pw.personalAddress || funding) return;
    setFunding(true);
    setFundMsg("");
    try {
      const res = await fetch(`${RELAY_HTTP}/onramp/session`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: pw.personalAddress }),
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) {
        setFundMsg(
          j.error === "onramp-not-configured"
            ? "Apple Pay funding isn't set up yet."
            : `Couldn't start: ${j.error ?? res.status}`,
        );
        return;
      }
      window.open(j.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setFundMsg(`Couldn't start: ${(err as Error).message}`);
    } finally {
      setFunding(false);
    }
  };

  const deployWallet = async () => {
    if (!pw.passkeyIdentity || deploying) return;
    setDeploying(true);
    setDeployMsg("");
    try {
      const slug = typeof window !== "undefined" ? (window.location.pathname.split("/").filter(Boolean)[0] ?? "") : "";
      const res = await fetch(`${RELAY_HTTP}/personal-wallet/deploy`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          qx: pw.passkeyIdentity.qx,
          qy: pw.passkeyIdentity.qy,
          credentialIdHash: pw.passkeyIdentity.credentialIdHash,
          slug,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; alreadyDeployed?: boolean };
      if (!res.ok) {
        setDeployMsg(`Deploy failed: ${j.error ?? res.status}`);
        return;
      }
      setDeployMsg(j.alreadyDeployed ? "Already deployed ✓" : "Deployed ✓");
      pw.refetchDeployed();
      pw.refetchBalance();
    } catch (err) {
      setDeployMsg(`Deploy failed: ${(err as Error).message}`);
    } finally {
      setDeploying(false);
    }
  };

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

          {/* Apple Pay on-ramp — fund this wallet with ETH on Base, no external
              wallet or seed phrase. US-only guest checkout, $5 min. */}
          <button
            onClick={fundWithApplePay}
            disabled={funding}
            style={{
              width: "100%",
              marginTop: 12,
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
              background: funding ? "var(--slop-panel-2, #26262c)" : "#000",
              color: funding ? "var(--slop-text-muted, #999)" : "#fff",
              border: "1px solid var(--slop-border, #444)",
              borderRadius: 6,
              padding: "10px 12px",
              cursor: funding ? "default" : "pointer",
            }}
          >
            {funding ? "Starting…" : " Add funds with Apple Pay"}
          </button>
          <div style={{ ...muted, marginTop: 4 }}>Apple Pay → ETH on Base · US only · $5 min</div>
          {fundMsg && <div style={{ ...muted, marginTop: 4, color: "var(--slop-warn, #e6a700)" }}>{fundMsg}</div>}

          {pw.deployed ? (
            <div style={{ ...muted, marginTop: 10 }}>● deployed on Base</div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div style={muted}>○ not deployed — receiving works now; deploy to make it spendable.</div>
              <button
                onClick={deployWallet}
                disabled={deploying}
                style={{
                  width: "100%",
                  marginTop: 8,
                  fontFamily: "inherit",
                  fontSize: 13,
                  fontWeight: 600,
                  background: deploying ? "var(--slop-panel-2, #26262c)" : "var(--slop-accent, #2b6cff)",
                  color: deploying ? "var(--slop-text-muted, #999)" : "#fff",
                  border: "1px solid var(--slop-border, #444)",
                  borderColor: "transparent",
                  borderRadius: 6,
                  padding: "10px 12px",
                  cursor: deploying ? "default" : "pointer",
                }}
              >
                {deploying ? "Deploying…" : "Deploy wallet"}
              </button>
              {deployMsg && (
                <div
                  style={{
                    ...muted,
                    marginTop: 6,
                    color: deployMsg.includes("failed") ? "var(--slop-warn, #e6a700)" : "var(--slop-accent, #7cf)",
                  }}
                >
                  {deployMsg}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={muted}>{pw.loading ? "Deriving address…" : "Could not derive address."}</div>
      )}
    </div>
  );
}
