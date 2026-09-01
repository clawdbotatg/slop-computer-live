"use client";

import { useEffect, useRef, useState } from "react";
import { Bevel, LoadingBar } from "~~/components/ui";
import { getRelayHealthSnapshot, subscribeRelayHealth } from "~~/lib/relayHealth";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// NOTE: the relay health path is `/v1/health`, not `/health`. RELAY_HTTP is
// https://live.slop.computer, where Caddy proxies `/v1/*` to the relay but
// leaves `/health` to Next.js — which matches the `[slug]` room page for
// slug="health". Polling bare `/health` therefore SSR'd a whole room page
// once a second and always looked "up" as long as Next.js was up, which is
// exactly the failure this detector exists to catch. Don't shorten it back.
//
// /health polling fallback — covers surfaces without a mesh WS (front
// page, unauthed spectators). The primary signal is the mesh WS state
// via the relayHealth pub/sub, which trips within milliseconds of the
// relay restart; this poll is here so non-mesh tabs still get the
// modal.
const POLL_INTERVAL_MS = 1000;
const FETCH_TIMEOUT_MS = 800;
// 2 consecutive fails at 1s cadence catches a ~1-2s relay restart —
// far tighter than the previous 3-fail/2s setup, which missed real
// systemctl restarts entirely.
const FAIL_TRIGGER_COUNT = 2;

// Probe /health aggressively once the modal is up. The endpoint is
// cheap (returns 3 fields) and we want to catch the recovery moment
// within ~200ms of it actually happening. 500ms timeout because a
// slow probe past that horizon means the server isn't really back.
const RECOVERY_PROBE_MS = 200;
const RECOVERY_TIMEOUT_MS = 500;
// Minimum modal visibility so the user gets a brief "💾 Updating..."
// confirmation rather than a sub-frame flash. Kept very tight (200ms ≈
// an eye blink) so we don't sit on top of a server that's already back.
const MIN_VISIBLE_MS = 200;
// How long we expect the new server to take to be reachable. Drives
// the progress bar fill rate; the bar caps at 95% until the probe
// actually succeeds, so we never claim "done" before we are.
const EXPECTED_RECOVERY_MS = 3000;
// Final paint delay so the LoadingBar's 100% frame commits before
// the page unloads. ~100ms is ~6 browser frames, plenty.
const RELOAD_PAINT_MS = 100;
// Safety net: if /health never comes back (deploy hung, server died),
// reload anyway after this long.
const MAX_WAIT_MS = 45000;
// How long to wait on the /api/client-rev check before falling back to a
// reload. Short — the server is already back by recovery time; a slow/failed
// probe just means "reload" (the safe default), never "skip".
const REV_FETCH_TIMEOUT_MS = 1200;

/**
 * Detects a production deploy in progress and forces a hard reload so
 * the user lands on the new client bundle.
 *
 * Symptom this fixes: during `./ops/deploy.sh`, slop-relay restarts.
 * The client tab's WS reconnects to the new relay but is still
 * running the previous JS bundle — newly-shipped features stay
 * invisible until a manual reload.
 *
 * Trigger (modal goes up):
 *   - Mesh WS drop: relay restart kills the WS within milliseconds.
 *     Desktop publishes mesh.connected; we show the modal the same
 *     frame mesh.connected flips false, so the blur layer covers the
 *     desktop *before* the user sees icons drop.
 *   - /health polling: fallback for surfaces without a mesh WS
 *     (front page, unauthed spectators).
 *
 * Recovery (modal closes, page reloads):
 *   - Mesh users: wait for mesh.bootstrapped to flip back true. That
 *     means the relay has finished loading room state and served us
 *     a complete snapshot. (/health is too early — it returns OK
 *     several seconds before room state is ready, which would dump
 *     the user back through the password gate and end with missing
 *     icons.)
 *   - Non-mesh users: fall back to /health, with no bootstrap signal
 *     to wait on.
 */
export function UpgradeModal() {
  const [showing, setShowing] = useState(false);
  const [progress, setProgress] = useState(0);
  const httpEverHealthyRef = useRef(false);
  const consecutiveFailsRef = useRef(0);

  // --- Detector 1: mesh WS drop -----------------------------------------
  // Modal shows the instant the WS goes down (no grace period) so the
  // blur layer covers the desktop *before* the user sees icons drop.
  //
  // Arming condition: require `everBootstrapped`, NOT just
  // `everConnected`. Bootstrapped only flips true after the relay has
  // served a complete room snapshot — that's our proof the tab had a
  // fully-working session worth protecting. Using `connected` alone
  // false-positived hard on god-mode loads, where the WS can briefly
  // open→close→reopen during auth handshake before settling: each
  // flap looked like a deploy and tripped the modal, the auto-reload
  // started the dance over, and the tab loop-reloaded 6+ times before
  // a successful bootstrap finally calmed it down.
  useEffect(() => {
    if (showing) return;
    let cancelled = false;

    const handle = (s: { connected: boolean; everBootstrapped: boolean }) => {
      if (cancelled) return;
      if (s.connected) return;
      if (!s.everBootstrapped) return;
      setShowing(true);
    };

    // Seed with the current snapshot in case the WS is already down at
    // mount (e.g. modal mounted late).
    const initial = getRelayHealthSnapshot();
    if (initial.everBootstrapped && !initial.connected) {
      setShowing(true);
      return;
    }

    const unsub = subscribeRelayHealth(handle);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [showing]);

  // --- Detector 2: /health polling (fallback) ---------------------------
  useEffect(() => {
    if (showing) return;
    let cancelled = false;

    const ping = async () => {
      if (cancelled) return;
      // Mesh-using surfaces have an authoritative signal (Detector 1).
      // Skip /health probing entirely for them — a slow probe past our
      // 800ms timeout would otherwise trigger the modal even though
      // the WS is fine. This is what was false-positiving god-mode.
      const snap = getRelayHealthSnapshot();
      if (snap.connected || snap.everConnected) {
        consecutiveFailsRef.current = 0;
        return;
      }
      let ok = false;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`${RELAY_HTTP}/v1/health`, {
          signal: ctl.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (cancelled) return;

      if (ok) {
        httpEverHealthyRef.current = true;
        consecutiveFailsRef.current = 0;
        return;
      }
      if (!httpEverHealthyRef.current) return;
      consecutiveFailsRef.current += 1;
      if (consecutiveFailsRef.current >= FAIL_TRIGGER_COUNT) {
        setShowing(true);
      }
    };

    void ping();
    const id = setInterval(() => void ping(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showing]);

  // --- Recovery detection + progress bar + forced reload ----------------
  // For mesh users (room pages), the gold-standard readiness signal is
  // mesh.bootstrapped going back true after the WS reconnect — that
  // means the relay finished loading room state and successfully
  // served us a snapshot. /health is *not* good enough: it returns OK
  // as soon as the HTTP listener is bound, several seconds before
  // room state, passwords, and slots are loaded. Reloading on /health
  // alone forced users back through the password gate and ended with
  // missing icons until a second manual reload.
  //
  // For non-mesh surfaces (front page, never-bootstrapped tabs), we
  // fall back to /health probing — they don't have a real readiness
  // signal but also aren't disrupted as severely by an early reload.
  useEffect(() => {
    if (!showing) return;

    const startedAt = performance.now();
    const snapAtShow = getRelayHealthSnapshot();
    // Wait for bootstrapped-again only when the tab had ever
    // bootstrapped before the modal showed — i.e., a mesh user mid-
    // session. Cold tabs / non-mesh surfaces use the /health fallback.
    const useBootstrappedSignal = snapAtShow.everBootstrapped;

    let cancelled = false;
    // Seed `recovered` from the live snapshot in case bootstrap fired
    // between the modal showing and the subscribe call below.
    let recovered = useBootstrappedSignal && snapAtShow.bootstrapped;
    let reloading = false;
    // Set the instant we commit to an outcome (reload OR skip), so the
    // 100ms tick can't fire the async decision twice.
    let decided = false;

    const reloadOnce = () => {
      if (reloading) return;
      reloading = true;
      decided = true;
      setProgress(100);
      window.setTimeout(() => window.location.reload(), RELOAD_PAINT_MS);
    };

    // Recovery reached — decide whether to hard-reload or just dismiss.
    // Reload iff the CLIENT bundle actually changed; for a relay-only
    // deploy (bundle byte-identical) we keep the page alive so live
    // camera/mic shares aren't torn down — the WS already reconnected and
    // re-announced them. CONSERVATIVE BY DESIGN: we skip the reload only
    // when we can prove the bundle is unchanged (both revs present, real,
    // and equal). Any uncertainty — fetch failed, either side missing or
    // "dev"/"unknown" — falls through to reload. A needed reload is never
    // skipped; the worst case is an unnecessary one.
    const decideAndFinish = async () => {
      if (decided || reloading) return;
      decided = true;
      const baked = process.env.NEXT_PUBLIC_CLIENT_REV;
      let serverRev: string | null = null;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REV_FETCH_TIMEOUT_MS);
        const res = await fetch("/api/client-rev", { signal: ctl.signal, cache: "no-store" });
        clearTimeout(timer);
        if (res.ok) serverRev = ((await res.json()) as { rev?: string }).rev ?? null;
      } catch {
        /* server still bouncing / network blip — fall through to reload */
      }
      if (cancelled) return;
      const clientUnchanged =
        !!baked &&
        !!serverRev &&
        baked !== "dev" &&
        serverRev !== "dev" &&
        serverRev !== "unknown" &&
        baked === serverRev;
      if (clientUnchanged) {
        // Relay-only deploy: dismiss the modal, keep the page (and its
        // live media) running. The reconnected WS re-published our streams.
        setProgress(100);
        setShowing(false);
      } else {
        // Force a fresh reloadOnce(): `decided` is already true, so reset
        // the guard it shares before delegating.
        reloading = true;
        setProgress(100);
        window.setTimeout(() => window.location.reload(), RELOAD_PAINT_MS);
      }
    };

    // Subscribe to relayHealth: for mesh users, wait for bootstrapped
    // to flip back true. (Bootstrapped only goes true after the relay
    // has served a complete snapshot, so this is end-to-end readiness.)
    const unsub = subscribeRelayHealth(s => {
      if (cancelled) return;
      if (useBootstrappedSignal && s.bootstrapped) recovered = true;
    });

    // /health probe — only used as the recovery signal when we don't
    // have a mesh bootstrap to wait on. (Always-on probing would
    // race the bootstrapped signal and reload too early.)
    const probe = async () => {
      if (cancelled || recovered) return;
      if (useBootstrappedSignal) return;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), RECOVERY_TIMEOUT_MS);
        const res = await fetch(`${RELAY_HTTP}/v1/health`, {
          signal: ctl.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        if (res.ok) recovered = true;
      } catch {
        /* still down — keep trying */
      }
    };

    let probeTimer: ReturnType<typeof setInterval> | null = null;
    if (!useBootstrappedSignal) {
      void probe();
      probeTimer = setInterval(() => void probe(), RECOVERY_PROBE_MS);
    }

    const tickTimer = setInterval(() => {
      if (reloading || decided) return;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= MAX_WAIT_MS) {
        // Recovery never confirmed — reload unconditionally (can't reach
        // the rev check, so default to the safe behavior).
        reloadOnce();
        return;
      }
      if (recovered && elapsed >= MIN_VISIBLE_MS) {
        void decideAndFinish();
        return;
      }
      // Cap visible progress at 95% until the recovery signal fires;
      // jumping to 100% prematurely would lie about readiness.
      const pct = Math.min(95, (elapsed / EXPECTED_RECOVERY_MS) * 100);
      setProgress(pct);
    }, 100);

    return () => {
      cancelled = true;
      unsub();
      if (probeTimer) clearInterval(probeTimer);
      clearInterval(tickTimer);
    };
  }, [showing]);

  if (!showing) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Updating"
      style={{
        position: "fixed",
        inset: 0,
        // Above the sign-in gates (z 10000) and below the cursor (zIndex 2^31).
        zIndex: 2147483646,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        background: "rgba(8,4,18,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Bevel style={{ padding: 24, width: "min(420px, 92vw)", textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-mark.png"
          alt="slop"
          width={84}
          height={84}
          style={{ display: "block", margin: "0 auto 16px", imageRendering: "pixelated" }}
        />
        <h2
          style={{
            margin: 0,
            marginBottom: 8,
            fontFamily: "var(--slop-font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontSize: 18,
            color: "var(--slop-text)",
          }}
        >
          💾 Updating...
        </h2>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <LoadingBar progress={progress} cells={20} />
        </div>
      </Bevel>
    </div>
  );
}

export default UpgradeModal;
