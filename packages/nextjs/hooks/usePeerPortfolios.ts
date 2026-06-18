"use client";

import { useEffect, useMemo, useState } from "react";
import { withSlug } from "~~/lib/slug";

// Per-guest USD portfolio totals, sourced from Zerion via the relay's
// /v1/wallet/portfolio proxy (which holds the Zerion key — the browser
// never sees it). This is the *whole account's* dollar value across every
// chain + token Zerion indexes, so the guest list can show "$1,234"
// instead of a bare ETH number. (The same proxy + totalBalanceUsd field
// backs the wallet window and the menubar balance chip.)
//
// One fetch per unique address (deduped + lowercased + validated). Pass
// the SPENDABLE addresses (already passkey→personal-wallet resolved). The
// relay endpoint is session-gated, so we send credentials; `slug` scopes
// the request to the caller's room. Returns a map keyed by lowercased
// address → total USD (number).
//
// Quota note: the Zerion quota is shared across all peers, so we poll
// gently (60s) and only re-fetch when the address set actually changes or
// the tab regains focus.
const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const POLL_MS = 60_000;

export function usePeerPortfolios(addresses: (string | null | undefined)[], slug: string): Record<string, number> {
  const uniq = useMemo(
    () =>
      [...new Set(addresses.filter((a): a is string => !!a).map(a => a.toLowerCase()))].filter(a =>
        /^0x[0-9a-f]{40}$/.test(a),
      ),
    [addresses],
  );
  // Stable dependency for the effect: the set of addresses, not the array
  // identity (which changes every render).
  const key = uniq.join(",");

  const [totals, setTotals] = useState<Record<string, number>>({});

  useEffect(() => {
    if (uniq.length === 0) return;
    let cancelled = false;
    const fetchAll = async () => {
      const results = await Promise.all(
        uniq.map(async a => {
          try {
            const res = await fetch(withSlug(`${RELAY_BASE}/v1/wallet/portfolio?address=${a}`, slug), {
              cache: "no-store",
              credentials: "include",
            });
            if (!res.ok) return [a, undefined] as const;
            const p = (await res.json()) as { totalBalanceUsd?: string };
            const n = p.totalBalanceUsd != null ? Number(p.totalBalanceUsd) : NaN;
            return [a, Number.isFinite(n) ? n : undefined] as const;
          } catch {
            return [a, undefined] as const;
          }
        }),
      );
      if (cancelled) return;
      setTotals(prev => {
        const next = { ...prev };
        for (const [a, v] of results) if (v !== undefined) next[a] = v;
        return next;
      });
    };
    void fetchAll();
    const onVis = () => {
      if (document.visibilityState === "visible") void fetchAll();
    };
    document.addEventListener("visibilitychange", onVis);
    const iv = setInterval(() => void fetchAll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
    // `key` stands in for `uniq` (stable across identical address sets).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, slug]);

  return totals;
}
