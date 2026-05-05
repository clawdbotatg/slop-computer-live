"use client";

import { useCallback, useEffect, useState } from "react";

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
  | { authenticated: false }
  | {
      authenticated: true;
      role: "host" | "guest";
      address: string | null;
      handle: string | null;
      isAdmin: boolean;
    };

export type UseSessionResult = {
  session: Session;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${RELAY_BASE}/auth/me`, { credentials: "include" });
      if (!res.ok) {
        setSession({ authenticated: false });
        return;
      }
      const data = (await res.json()) as Session;
      setSession(data);
    } catch {
      setSession({ authenticated: false });
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
    setSession({ authenticated: false });
    notifySessionChanged();
  }, []);

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
