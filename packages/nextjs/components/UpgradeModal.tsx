"use client";

import { useEffect, useRef, useState } from "react";
import { Bevel, LoadingBar } from "~~/components/ui";
import { getRelayHealthSnapshot, subscribeRelayHealth } from "~~/lib/relayHealth";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

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
// confirmation rather than a sub-frame flash. Kept tight (300ms ≈ a
// blink) so we don't sit on top of a server that's already back.
const MIN_VISIBLE_MS = 300;
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
  // Side effect: a transient network blip that kills the WS will also
  // trigger a reload. Acceptable — those are rare on a stable network,
  // and the alternative (waiting hundreds of ms) leaves a visible gap
  // where the user watches their icons disappear unexplained.
  useEffect(() => {
    if (showing) return;
    let cancelled = false;

    const handle = (s: { connected: boolean; everConnected: boolean }) => {
      if (cancelled) return;
      if (s.connected) return;
      if (!s.everConnected) return;
      setShowing(true);
    };

    // Seed with the current snapshot in case the WS is already down at
    // mount (e.g. modal mounted late).
    const initial = getRelayHealthSnapshot();
    if (initial.everConnected && !initial.connected) {
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
      let ok = false;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`${RELAY_HTTP}/health`, {
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

    const reloadOnce = () => {
      if (reloading) return;
      reloading = true;
      setProgress(100);
      window.setTimeout(() => window.location.reload(), RELOAD_PAINT_MS);
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
        const res = await fetch(`${RELAY_HTTP}/health`, {
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
      if (reloading) return;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= MAX_WAIT_MS) {
        reloadOnce();
        return;
      }
      if (recovered && elapsed >= MIN_VISIBLE_MS) {
        reloadOnce();
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
