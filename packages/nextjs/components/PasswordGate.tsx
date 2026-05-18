"use client";

import { useEffect, useRef, useState } from "react";
import { Bevel, Button } from "~~/components/ui";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

export type PasswordGateProps = {
  /** Optional invite pre-fill, typically passed from a `?invite=` query. */
  defaultPassword?: string;
  /** Called after the relay accepts the password and sets the cookie. */
  onAccepted: () => void;
};

// Lightweight gate shown before any login UI. POSTs to /auth/invite —
// matching password gets a long-lived `slop_invite` cookie. Until that
// cookie is present, /auth/me reports `invited:false` and the rest of
// the sign-in screen stays out of reach.
export const PasswordGate = ({ defaultPassword = "", onAccepted }: PasswordGateProps) => {
  const [password, setPassword] = useState(defaultPassword);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    if (busy) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setError("password required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${RELAY_HTTP}/auth/invite`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: trimmed }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error === "bad-password" ? "wrong password" : (j.error ?? `error ${res.status}`));
        return;
      }
      onAccepted();
    } catch (e) {
      setError((e as Error).message || "network error");
    } finally {
      setBusy(false);
    }
  };

  // Auto-submit when the gate mounts with a pre-filled password (i.e.
  // the user arrived via `?invite=...`). They've already "clicked"
  // by following the invite link — making them click again here is
  // pointless friction. Bad codes still surface the error inline so
  // they can edit and retry. Guarded by a ref so React StrictMode's
  // double-mount doesn't fire two requests.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (autoFiredRef.current) return;
    if (!defaultPassword.trim()) return;
    autoFiredRef.current = true;
    void submit(defaultPassword);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Bevel style={{ padding: 22, maxWidth: 360, width: "100%", textAlign: "center" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-mark.png"
        alt="slop"
        width={64}
        height={64}
        style={{ display: "block", margin: "0 auto 14px", imageRendering: "pixelated" }}
      />
      <h2
        style={{
          margin: 0,
          marginBottom: 10,
          fontFamily: "var(--slop-font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontSize: 18,
        }}
      >
        Invite required
      </h2>
      <p style={{ color: "var(--slop-text-muted)", fontSize: 12, marginTop: 0, marginBottom: 14 }}>
        Enter the password from your invite link.
      </p>
      <input
        type="text"
        autoFocus
        value={password}
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") void submit(password);
        }}
        placeholder="password"
        spellCheck={false}
        autoComplete="off"
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 14,
          fontFamily: "var(--slop-font-body)",
          background: "#06030d",
          border: "1px solid var(--slop-bevel-light)",
          color: "var(--slop-text)",
          textAlign: "center",
          letterSpacing: "0.06em",
        }}
      />
      {error ? (
        <p style={{ color: "var(--slop-magenta, #ff3ec9)", fontSize: 11, marginTop: 8, marginBottom: 0 }}>{error}</p>
      ) : null}
      <div style={{ marginTop: 14 }}>
        <Button variant="primary" onClick={() => void submit(password)} disabled={busy}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </div>
    </Bevel>
  );
};

export default PasswordGate;
