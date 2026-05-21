"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDisconnect } from "wagmi";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Each useSession() call has its own React state. When one component
// (e.g. JoinCard) signs in, the others (e.g. /page.tsx, MenuBar) don't
// notice until they re-fetch /auth/me. Broadcasting a custom event when
// the session changes lets every instance refresh in lockstep.
const SESSION_CHANGED = "slop:session-changed";

export function notifySessionChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_CHANGED));
  }
}

export type Session =
  | { authenticated: false; invited: boolean }
  | {
      authenticated: true;
      invited: boolean;
      role: "host" | "guest";
      address: string | null;
      handle: string | null;
      isAdmin: boolean;
      // True when the session was minted via /auth/godmode. Invisible
      // streaming/observer session — UI hides itself (no JoinCard, no
      // local cursor, no auto-publish) and the relay rejects any
      // attempt to write shared state.
      spectator?: boolean;
    };

export type UseSessionResult = {
  session: Session;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session>({ authenticated: false, invited: false });
  const [loading, setLoading] = useState(true);
  const { disconnectAsync } = useDisconnect();
  // Backoff state for transient /auth/me failures (relay down during a
  // deploy, brief Caddy 502s, network blip). We only flip to "logged out"
  // on a definitive 200 response — anything else is treated as transient
  // and the last-known-good session is preserved while we retry.
  const transientRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transientAttemptsRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${RELAY_BASE}/auth/me`, { credentials: "include" });
      // /auth/me is authoritative ONLY on a 200. A bad/missing cookie
      // still returns 200 with `authenticated: false`. So any non-200
      // (5xx from Caddy while slop-relay restarts, fetch reject, etc.)
      // means "couldn't reach the relay", not "logged out" — keep the
      // existing session and schedule a retry instead of forcing the
      // user back to the JoinCard.
      if (!res.ok) {
        scheduleTransientRetry();
        return;
      }
      const data = (await res.json()) as Session;
      // Clear backoff on a definitive answer.
      transientAttemptsRef.current = 0;
      if (transientRetryRef.current) {
        clearTimeout(transientRetryRef.current);
        transientRetryRef.current = null;
      }
      setSession(data);
    } catch {
      scheduleTransientRetry();
    } finally {
      setLoading(false);
    }

    function scheduleTransientRetry() {
      if (transientRetryRef.current) return; // already pending
      const attempt = transientAttemptsRef.current++;
      // 1s, 2s, 4s, 8s, capped at 10s. Plenty fast for a ~5s relay
      // restart; gentle enough that a long outage doesn't hammer Caddy.
      const delay = Math.min(1000 * 2 ** attempt, 10_000);
      transientRetryRef.current = setTimeout(() => {
        transientRetryRef.current = null;
        void refresh();
      }, delay);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch(`${RELAY_BASE}/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      /* ignore */
    }
    // Drop the wallet connection too so the next visit shows the Connect
    // button instead of auto-reconnecting via wagmi's persisted state.
    try {
      await disconnectAsync();
    } catch {
      /* no active connector */
    }
    // wagmi.disconnect() alone isn't enough — RainbowKit, WalletConnect, and
    // ReOwn each cache connector metadata under their own prefixes. If any of
    // those survive, the next page load silently re-establishes the connection
    // and JoinCard skips the Connect Wallet button. Sign-out should be a
    // total reset, so blow them all away.
    //
    // Passkey keys (slop:passkey:*) are also wiped here: JoinCard remembers
    // the last credential id + path so returning users skip the chooser modal
    // AND the browser picker. Sign-out should let them pick a different
    // passkey next time, so we trash that preference along with the wallet
    // state. The slop:* sweep runs in its OWN try/catch BEFORE the wagmi loop
    // so that even if the wagmi prefix scan blows up on some weird stored
    // value, the passkey memory is already gone.
    if (typeof window !== "undefined") {
      try {
        for (const k of Object.keys(window.localStorage)) {
          if (k.startsWith("slop:passkey:")) window.localStorage.removeItem(k);
        }
      } catch {
        /* private mode / quota */
      }
      try {
        const prefixes = ["wagmi", "rk-", "wc@", "@w3m", "@appkit", "WCM_VERSION"];
        Object.keys(window.localStorage)
          .filter(k => prefixes.some(p => k.startsWith(p)))
          .forEach(k => window.localStorage.removeItem(k));
      } catch {
        /* private mode / quota */
      }
      // The relay's /auth/logout only clears slop_session. Room-password
      // and slop_invite cookies survive across sign-outs by design (a
      // signed-out user shouldn't need to re-enter the room password to
      // see the JoinCard again). But "sign out then immediately sign in
      // with a different identity" should still feel clean, so we expire
      // every slop_* cookie from the client side as a belt-and-suspenders
      // pass. Anything the relay still needs (invites, room creds) will
      // get reissued on the next gate hit.
      try {
        const past = "expires=Thu, 01 Jan 1970 00:00:00 GMT";
        for (const part of document.cookie.split(";")) {
          const name = part.split("=")[0]?.trim();
          if (name && name.startsWith("slop_")) {
            document.cookie = `${name}=; ${past}; path=/`;
          }
        }
      } catch {
        /* document.cookie not writable */
      }
    }
    // Sign-out is authoritative — kill any in-flight transient retry so
    // a stale /auth/me response can't resurrect the session.
    if (transientRetryRef.current) {
      clearTimeout(transientRetryRef.current);
      transientRetryRef.current = null;
    }
    transientAttemptsRef.current = 0;
    setSession({ authenticated: false, invited: false });
    notifySessionChanged();
  }, [disconnectAsync]);

  // Wrap refresh to also broadcast so other useSession instances refetch.
  const refreshAndBroadcast = useCallback(async () => {
    await refresh();
    notifySessionChanged();
  }, [refresh]);

  useEffect(() => {
    refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onPageShow = () => refresh();
    const onChanged = () => refresh();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener(SESSION_CHANGED, onChanged);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener(SESSION_CHANGED, onChanged);
      if (transientRetryRef.current) {
        clearTimeout(transientRetryRef.current);
        transientRetryRef.current = null;
      }
    };
  }, [refresh]);

  return { session, loading, refresh: refreshAndBroadcast, signOut };
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function sessionLabel(session: Session): string {
  if (!session.authenticated) return "GUEST · sign in";
  if (session.handle) return `${session.isAdmin ? "ADMIN" : "GUEST"} · ${session.handle}`;
  if (session.address) return `${session.isAdmin ? "ADMIN" : "GUEST"} · ${shortAddress(session.address)}`;
  return session.isAdmin ? "ADMIN" : "GUEST";
}
