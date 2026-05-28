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

// When the WS drops, wait this long before triggering. A clean network
// blip will reconnect in milliseconds; a real relay restart stays down
// for at least a second. 800ms is short enough to feel responsive
// without false-positiving on transient network hiccups.
const WS_DROP_GRACE_MS = 800;

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
 * Two parallel detectors trip the modal:
 *   1. Mesh WS drop (primary): when the relay restarts, the WS
 *      closes within milliseconds. Desktop publishes mesh.connected
 *      into the relayHealth pub/sub; we subscribe and start a 1.2s
 *      grace timer on any true→false transition. If still down at
 *      the end of the grace, modal goes up.
 *   2. /health polling (fallback): covers surfaces that never
 *      open the mesh WS (front page, unauthed spectators). 1s
 *      cadence, 0.8s timeout, 2 consecutive fails trip the modal.
 *
 * In both cases we require at least one healthy observation first —
 * cold loads against a transient/offline relay shouldn't trigger.
 */
export function UpgradeModal() {
  const [showing, setShowing] = useState(false);
  const [progress, setProgress] = useState(0);
  const httpEverHealthyRef = useRef(false);
  const consecutiveFailsRef = useRef(0);

  // --- Detector 1: mesh WS drop -----------------------------------------
  useEffect(() => {
    if (showing) return;
    let cancelled = false;
    let dropTimer: ReturnType<typeof setTimeout> | null = null;

    const handle = (connected: boolean) => {
      if (cancelled) return;
      if (connected) {
        if (dropTimer) {
          clearTimeout(dropTimer);
          dropTimer = null;
        }
        return;
      }
      // WS just dropped. We only care if it had ever been up — a tab
      // that never connected (e.g. unauthed spectator) isn't a deploy
      // signal.
      const snap = getRelayHealthSnapshot();
      if (!snap.everConnected) return;
      if (dropTimer) return;
      dropTimer = setTimeout(() => {
        if (cancelled) return;
        setShowing(true);
      }, WS_DROP_GRACE_MS);
    };

    // Seed with the current snapshot in case the WS is already down at
    // mount (e.g. modal mounted late).
    const initial = getRelayHealthSnapshot();
    if (initial.everConnected && !initial.connected) {
      dropTimer = setTimeout(() => {
        if (cancelled) return;
        setShowing(true);
      }, WS_DROP_GRACE_MS);
    }

    const unsub = subscribeRelayHealth(handle);
    return () => {
      cancelled = true;
      unsub();
      if (dropTimer) clearTimeout(dropTimer);
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

  // --- Probe-driven progress + reload -----------------------------------
  // Replaces the previous fixed-duration timer. While we wait the
  // progress bar fills toward 95% over EXPECTED_RECOVERY_MS so it
  // looks like work is happening; the moment /health responds OK we
  // jump to 100% and reload. This makes the modal as short as the
  // actual deploy and avoids the "it took longer than it should"
  // feeling of the old 25s hardcoded timer.
  useEffect(() => {
    if (!showing) return;

    const startedAt = performance.now();
    let cancelled = false;
    let recovered = false;
    let reloading = false;

    const reloadOnce = () => {
      if (reloading) return;
      reloading = true;
      // 100% paint frame, then reload.
      setProgress(100);
      window.setTimeout(() => window.location.reload(), RELOAD_PAINT_MS);
    };

    const probe = async () => {
      if (cancelled || recovered) return;
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

    void probe();
    const probeTimer = setInterval(() => void probe(), RECOVERY_PROBE_MS);

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
      // Cap visible progress at 95% until /health actually comes back;
      // jumping to 100% prematurely would lie about readiness.
      const pct = Math.min(95, (elapsed / EXPECTED_RECOVERY_MS) * 100);
      setProgress(pct);
    }, 100);

    return () => {
      cancelled = true;
      clearInterval(probeTimer);
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
