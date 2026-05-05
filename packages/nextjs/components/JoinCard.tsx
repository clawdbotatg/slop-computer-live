"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { Bevel, Button, TextField } from "~~/components/ui";
import { useSession } from "~~/hooks/useSession";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

type Tab = "siwe" | "password";

/**
 * Inline SIWE + password auth card. After successful auth, calls
 * useSession.refresh() so the parent component can re-render in the
 * authenticated state without a navigation.
 */
export function JoinCard({ invite }: { invite?: string }) {
  const { refresh } = useSession();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [tab, setTab] = useState<Tab>("siwe");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string>("");

  const handleSiwe = async () => {
    if (!address) return;
    setStatus("Requesting nonce...");
    try {
      const nonceRes = await fetch(`${RELAY_BASE}/auth/siwe/nonce`).then(r => r.json());
      const nonce: string = nonceRes.nonce;
      const domain = window.location.host;
      const uri = window.location.origin;
      const issuedAt = new Date().toISOString();
      const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        address,
        ``,
        `Sign in to slop-computer-live as a guest.`,
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let verifyRes: Response;
      try {
        verifyRes = await fetch(`${RELAY_BASE}/auth/siwe`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, signature, nonce }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setStatus("Auth failed: relay timed out after 15s");
          return;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const data = await verifyRes.json();
      if (!verifyRes.ok) {
        setStatus(`Auth failed: ${data.error ?? verifyRes.statusText}`);
        return;
      }
      await refresh();
    } catch (err) {
      setStatus(`Auth error: ${(err as Error).message}`);
    }
  };

  const handlePassword = async () => {
    if (!handle.trim()) {
      setStatus("Pick a handle.");
      return;
    }
    setStatus("Verifying password...");
    try {
      const res = await fetch(`${RELAY_BASE}/auth/password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, handle }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Auth failed: ${data.error ?? res.statusText}`);
        return;
      }
      await refresh();
    } catch (err) {
      setStatus(`Auth error: ${(err as Error).message}`);
    }
  };

  return (
    <Bevel style={{ padding: 24, width: "min(480px, 92vw)" }}>
      <h1 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
        Join the session
      </h1>
      {invite ? (
        <p style={{ color: "var(--slop-text-muted)" }}>
          Invite: <code>{invite}</code>
        </p>
      ) : (
        <p style={{ color: "var(--slop-text-muted)" }}>
          Sign in with Ethereum, or use the session&apos;s guest password if you want to stay anonymous.
        </p>
      )}

      <div style={{ display: "flex", gap: 4, marginTop: 8, marginBottom: 16 }}>
        <Button onClick={() => setTab("siwe")} style={{ background: tab === "siwe" ? "var(--slop-panel)" : undefined }}>
          Sign-In with Ethereum
        </Button>
        <Button
          onClick={() => setTab("password")}
          style={{ background: tab === "password" ? "var(--slop-panel)" : undefined }}
        >
          Password
        </Button>
      </div>

      {tab === "siwe" ? (
        <div>
          {!isConnected ? (
            <RainbowKitCustomConnectButton />
          ) : (
            <Button variant="primary" onClick={handleSiwe}>
              Sign in as {address?.slice(0, 6)}…{address?.slice(-4)}
            </Button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label>
            Handle
            <br />
            <TextField value={handle} onChange={e => setHandle(e.target.value)} maxLength={32} placeholder="slop-fan" />
          </label>
          <label>
            Password
            <br />
            <TextField type="password" value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          <div>
            <Button variant="primary" onClick={handlePassword}>
              Join as guest
            </Button>
          </div>
        </div>
      )}

      {status ? <p style={{ marginTop: 12, color: "var(--slop-text-muted)" }}>{status}</p> : null}
    </Bevel>
  );
}
