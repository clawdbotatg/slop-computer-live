"use client";

import { useEffect, useRef, useState } from "react";
import { Bevel, Button } from "~~/components/ui";
import { LEGACY_STORAGE_KEY, readStoredRoomPassword, slugStorageKey } from "~~/utils/roomPassword";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

export type PasswordGateProps = {
  /** Room slug this gate is authenticating for. Each room has its own
   *  password, stored as a scrypt hash in `.slop-data/rooms/<slug>/auth.json`. */
  slug: string;
  /** Optional invite pre-fill, typically passed from a `?invite=` query
   *  on the URL. */
  defaultPassword?: string;
  /** Called after the relay accepts the password and sets the cookie. */
  onAccepted: () => void;
};

// Lightweight gate shown before any login UI. The relay holds a scrypt-
// hashed password per room (see room-auth.ts). We POST the user's
// password to /v1/rooms/:slug/auth; a match sets a long-lived,
// HMAC-signed cookie scoped to that slug.
//
// Backwards compat: the main room also honors the pre-Phase-5 global
// slop_invite cookie. If the room hasn't been claimed with a per-room
// password yet (exists=false), this gate falls back to POSTing the
// legacy /auth/invite endpoint so existing deployments keep working.
//
// We cache the last accepted password in localStorage per-slug and
// silently replay it on mount. Cookies can be cleared, expire, or be
// missing on a fresh browser — having the password handy means a
// returning user never sees this gate as long as their saved value
// still matches.
export const PasswordGate = ({ slug, defaultPassword = "", onAccepted }: PasswordGateProps) => {
  const [password, setPassword] = useState(defaultPassword);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // `exists` controls which endpoint we POST to. Defaults to true; flipped
  // to false during the initial status fetch if the room isn't claimed.
  const [exists, setExists] = useState(true);
  // Hide the form during the initial silent retry so the user doesn't
  // see it flash before the cookie comes back.
  const [silentRetrying, setSilentRetrying] = useState(() => {
    if (typeof window === "undefined") return false;
    return !defaultPassword.trim() && !!readStoredRoomPassword(slug);
  });

  const submit = async (value: string, opts: { silent?: boolean; legacy?: boolean } = {}) => {
    if (busy) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setError("password required");
      return;
    }
    setBusy(true);
    setError("");
    const endpoint = opts.legacy
      ? `${RELAY_HTTP}/auth/invite`
      : `${RELAY_HTTP}/v1/rooms/${encodeURIComponent(slug)}/auth`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: trimmed }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        // 404 on the per-room endpoint = unclaimed room; fall back to
        // the legacy gate before giving up.
        if (!opts.legacy && res.status === 404) {
          setExists(false);
          await submit(trimmed, { ...opts, legacy: true });
          return;
        }
        // A stored password that the server rejects is dead weight —
        // drop it so we don't auto-fail on every future mount.
        if (j.error === "bad-password") {
          try {
            window.localStorage.removeItem(slugStorageKey(slug));
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          } catch {
            /* ignore */
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
        window.localStorage.setItem(slugStorageKey(slug), trimmed);
      } catch {
        /* falling back to cookie-only is fine */
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

  // Status check on mount: do we already have a valid cookie? Does the
  // room exist? Then auto-submit any stored password we have.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (autoFiredRef.current) return;
    autoFiredRef.current = true;

    void (async () => {
      try {
        const res = await fetch(`${RELAY_HTTP}/v1/rooms/${encodeURIComponent(slug)}/auth`, {
          credentials: "include",
        });
        if (res.ok) {
          const j = (await res.json()) as { exists?: boolean; authed?: boolean };
          if (j.authed) {
            onAccepted();
            return;
          }
          if (j.exists === false) setExists(false);
        }
      } catch {
        /* network blip — fall through to the manual gate */
      }

      const fromUrl = defaultPassword.trim();
      if (fromUrl) {
        void submit(fromUrl);
        return;
      }
      const stored = readStoredRoomPassword(slug);
      if (stored) {
        void submit(stored, { silent: true });
      } else {
        setSilentRetrying(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

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
        {exists ? `Room ${slug}` : "Invite required"}
      </h2>
      <p style={{ color: "var(--slop-text-muted)", fontSize: 12, marginTop: 0, marginBottom: 14 }}>
        {exists ? "Enter the password for this room." : "Enter the password from your invite link."}
      </p>
      <input
        type="text"
        autoFocus
        value={password}
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") void submit(password, exists ? {} : { legacy: true });
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
        <Button variant="primary" onClick={() => void submit(password, exists ? {} : { legacy: true })} disabled={busy}>
          {busy ? "Checking…" : "Continue"}
        </Button>
      </div>
    </Bevel>
  );
};

export default PasswordGate;
