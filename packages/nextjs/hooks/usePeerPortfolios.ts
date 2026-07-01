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
// Quota note: the Zerion quota is shared across all peers AND people just
// leave the live screen open, so a tight poll here is brutal — every idle
// tab was re-fetching every peer once a minute, and each fetch fans out to
// one /v1/wallet/portfolio per peer × 3 Zerion calls apiece. So we barely
// poll: fetch on mount and whenever the tab regains focus (landing on the
// screen is the moment you care), then only a lazy 5min safety-net tick to
// catch passive drift. Users can hit refresh in the wallet window for an
// on-demand pull.
const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const POLL_MS = 300_000;

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
