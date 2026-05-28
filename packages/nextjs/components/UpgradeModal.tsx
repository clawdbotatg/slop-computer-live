"use client";

import { useEffect, useRef, useState } from "react";
import { Bevel, LoadingBar } from "~~/components/ui";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Poll cadence + per-request timeout. Keep both short so we react fast
// when the relay restarts (the deploy script kills it for ~2s, then it
// comes back, but the Next.js client bundle on this tab is now stale).
const POLL_INTERVAL_MS = 2000;
const FETCH_TIMEOUT_MS = 1500;

// We require N consecutive failed pings AFTER having been healthy at
// least once. That keeps a flaky-Wi-Fi blip from triggering a forced
// reload (one fail is normal; ~6s of dead air looks like a deploy).
const FAIL_TRIGGER_COUNT = 3;

// Duration of the cosmetic progress bar. The actual deploy window from
// the Next.js stop → HTTPS-back recovery is ~2-5s, but the new bundle
// won't be cleanly fetchable for a few more seconds while the relay +
// browser-host also bounce. 25s is comfortable headroom; users sit
// through it once, see "Downloading Upgrade…", then come back with
// the new client.
const UPGRADE_DURATION_MS = 25000;

/**
 * Detects a production deploy in progress and forces a hard reload so
 * the user lands on the new client bundle.
 *
 * Symptom this fixes: during `./ops/deploy.sh`, slop-relay (and the
 * Next.js server) get restarted. The existing client tab reconnects
 * to the new relay but is still running the old JS bundle — any
 * features shipped in the deploy are invisible until a manual reload.
 *
 * Detection: poll `${RELAY_HTTP}/health` every 2s. Once we've seen at
 * least one healthy response, treat 3 consecutive failures as "deploy
 * in flight". This avoids false-positives on first load (we wait for
 * proof of life first) and on single packet drops.
 *
 * Reaction: full-viewport blur + "Downloading Upgrade…" modal with the
 * shared LoadingBar, running for UPGRADE_DURATION_MS. At the end,
 * `window.location.reload()` — that fetches the new index.html, which
 * references the new hashed chunk URLs, so the next page is the new
 * version.
 */
export function UpgradeModal() {
  const [showing, setShowing] = useState(false);
  const [progress, setProgress] = useState(0);
  const wasHealthyRef = useRef(false);
  const consecutiveFailsRef = useRef(0);

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
        wasHealthyRef.current = true;
        consecutiveFailsRef.current = 0;
        return;
      }
      // Don't trigger before we've ever seen the relay healthy — that
      // covers cold loads against a transient/offline relay where a
      // forced reload would just spin.
      if (!wasHealthyRef.current) return;
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

  useEffect(() => {
    if (!showing) return;
    const startedAt = performance.now();
    const id = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const pct = Math.min(100, (elapsed / UPGRADE_DURATION_MS) * 100);
      setProgress(pct);
      if (elapsed >= UPGRADE_DURATION_MS) {
        clearInterval(id);
        window.location.reload();
      }
    }, 200);
    return () => clearInterval(id);
  }, [showing]);

  if (!showing) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Downloading upgrade"
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
          Downloading Upgrade…
        </h2>
        <p style={{ color: "var(--slop-text-muted)", fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          A new version of slop.computer is being deployed.
          <br />
          Hang tight — this page will reload automatically.
        </p>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <LoadingBar progress={progress} cells={20} />
        </div>
      </Bevel>
    </div>
  );
}

export default UpgradeModal;
