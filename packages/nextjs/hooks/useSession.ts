"use client";

import { useCallback, useEffect, useState } from "react";
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

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${RELAY_BASE}/auth/me`, { credentials: "include" });
      if (!res.ok) {
        setSession({ authenticated: false, invited: false });
        return;
      }
      const data = (await res.json()) as Session;
      setSession(data);
    } catch {
      setSession({ authenticated: false, invited: false });
    } finally {
      setLoading(false);
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
    // The passkey keys are also cleared here: JoinCard remembers the last
    // credential id + path so returning users skip the chooser modal AND
    // the browser picker. Sign-out should let them pick a different passkey
    // next time, so we trash that preference along with the wallet state.
    if (typeof window !== "undefined") {
      try {
        const prefixes = ["wagmi", "rk-", "wc@", "@w3m", "@appkit", "WCM_VERSION"];
        Object.keys(window.localStorage)
          .filter(k => prefixes.some(p => k.startsWith(p)))
          .forEach(k => window.localStorage.removeItem(k));
        window.localStorage.removeItem("slop:passkey:credId");
        window.localStorage.removeItem("slop:passkey:lastPath");
      } catch {
        /* private mode / quota */
      }
    }
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
