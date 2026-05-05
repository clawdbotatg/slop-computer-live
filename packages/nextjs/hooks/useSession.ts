"use client";

import { useCallback, useEffect, useState } from "react";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

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
  }, []);

  useEffect(() => {
    refresh();
    // Re-check on window focus + on bfcache restores so a sign-out in
    // another tab (or another app on the same shared cookie) is reflected
    // here without a manual reload.
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onPageShow = () => refresh();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [refresh]);

  return { session, loading, refresh, signOut };
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
