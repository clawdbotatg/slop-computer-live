"use client";

import { useEffect, useRef, useState } from "react";
import { Bevel, Button } from "~~/components/ui";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const STORAGE_KEY = "slop-invite-password";

export type PasswordGateProps = {
  /** Optional invite pre-fill, typically passed from a `?invite=` query. */
  defaultPassword?: string;
  /** Called after the relay accepts the password and sets the cookie. */
  onAccepted: () => void;
};

const readStoredPassword = (): string => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

// Lightweight gate shown before any login UI. POSTs to /auth/invite —
// matching password gets a long-lived `slop_invite` cookie. Until that
// cookie is present, /auth/me reports `invited:false` and the rest of
// the sign-in screen stays out of reach.
//
// We also cache the last accepted password in localStorage and silently
// replay it on mount. Cookies can be cleared, expire, or be missing on
// a fresh browser — having the password handy means a returning user
// never sees this gate as long as their saved value still matches.
export const PasswordGate = ({ defaultPassword = "", onAccepted }: PasswordGateProps) => {
  const [password, setPassword] = useState(defaultPassword);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Hide the form during the initial silent retry so the user doesn't
  // see it flash before the cookie comes back. Resolves to `false` once
  // we've decided there's nothing to auto-try (or the auto-try failed).
  const [silentRetrying, setSilentRetrying] = useState(() => {
    if (typeof window === "undefined") return false;
    return !defaultPassword.trim() && !!readStoredPassword();
  });

  const submit = async (value: string, opts: { silent?: boolean } = {}) => {
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
        // A stored password that the server rejects is dead weight —
        // drop it so we don't auto-fail on every future mount.
        if (j.error === "bad-password") {
          try {
            window.localStorage.removeItem(STORAGE_KEY);
          } catch {
            // ignore
          }
        }
        if (opts.silent) {
          setSilentRetrying(false);
          return;
        }
        setError(j.error === "bad-password" ? "wrong password" : (j.error ?? `error ${res.status}`));
        return;
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, trimmed);
      } catch {
        // ignore — falling back to cookie-only is fine
      }
      onAccepted();
    } catch (e) {
      if (opts.silent) {
        setSilentRetrying(false);
        return;
      }
      setError((e as Error).message || "network error");
    } finally {
      setBusy(false);
    }
  };

  // Auto-submit on mount whenever we have a password to try:
  //   1. `?invite=…` from the URL (user followed an invite link).
  //   2. A previously accepted password cached in localStorage.
  // Either way, clicking through this gate again is pointless friction.
  // Bad codes surface inline (or silently clear the cache) so the user
  // can edit and retry. Guarded by a ref against StrictMode double-mount.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (autoFiredRef.current) return;
    autoFiredRef.current = true;
    const fromUrl = defaultPassword.trim();
    if (fromUrl) {
      void submit(fromUrl);
      return;
    }
    const stored = readStoredPassword();
    if (stored) {
      void submit(stored, { silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (silentRetrying) return null;

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
