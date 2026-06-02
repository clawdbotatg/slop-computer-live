// ⚠️ DORMANT FEATURE — NOT IN USE (as of 2026-06-02).
// We do NOT broadcast the live stream from the server. The real stream is
// captured on a SECOND MACHINE running OBS. This headless server-side
// broadcaster (Xvfb + Chromium + ffmpeg → RTMP) was built to test the idea
// and left wired up in case we revisit it one day — but `slop-broadcast.service`
// is not running in production, the admin UI panel that drove it has been
// removed (see packages/nextjs/app/admin/page.tsx), and these endpoints sit
// idle. If you (or a future agent) are reasoning about how the stream goes
// live: it's OBS on a second box, NOT this. Don't assume this is active.
//
// ---
//
// Server-side broadcaster control. The relay shells out to systemctl to
// start/stop the `slop-broadcast.service` unit which runs Xvfb + Chromium
// + ffmpeg → RTMP loopback. See deploy/slop-broadcast.{sh,service}.
//
// The relay process runs as `ubuntu`; passwordless sudo for the three
// allowed verbs is configured in /etc/sudoers.d/slop-broadcast (see
// deploy/README.md). `systemctl is-active`, `is-enabled`, and `show`
// don't need sudo (read-only state).
//
// All endpoints are host-only (gated by requireHost at the call site).

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const UNIT = "slop-broadcast.service";
// Path to the env file the systemd unit reads. Lives next to the
// committed example in deploy/. We own this file (relay runs as ubuntu,
// deploy dir was created by the same user during `git clone`).
const ENV_FILE = "/home/ubuntu/slop-computer-live/deploy/slop-broadcast.env";

export type BroadcastStatus = {
  /** "active" | "activating" | "inactive" | "failed" | "unknown" */
  active: string;
  /** "enabled" | "disabled" | "static" | "unknown" */
  enabled: string;
  /** Seconds since the unit entered its current active state. Null if unknown. */
  activeForSeconds: number | null;
  /** Most recent journal lines, newest last. Empty array on error. */
  recentLog: string[];
};

type Action = "start" | "stop" | "restart";

/** Run a command, capture stdout/stderr, resolve with both. */
function run(
  cmd: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: stderr + "[timeout]" });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Read-only: "active" / "inactive" / "failed" / "activating" / "unknown". */
async function getActive(): Promise<string> {
  // `is-active` exits 0 for active, 3 for inactive, etc — we want the
  // string in stdout regardless, so don't gate on exit code.
  const { stdout } = await run("systemctl", ["is-active", UNIT]);
  return stdout.trim() || "unknown";
}

async function getEnabled(): Promise<string> {
  const { stdout } = await run("systemctl", ["is-enabled", UNIT]);
  return stdout.trim() || "unknown";
}

async function getActiveForSeconds(): Promise<number | null> {
  // Parse ActiveEnterTimestamp (microseconds since epoch) from
  // `systemctl show`. Falls back to null on parse failure.
  const { stdout } = await run("systemctl", [
    "show",
    UNIT,
    "--property=ActiveEnterTimestampMonotonic",
  ]);
  const match = stdout.match(/ActiveEnterTimestampMonotonic=(\d+)/);
  if (!match) return null;
  const enterUs = Number(match[1]);
  if (!enterUs) return null;
  // ActiveEnterTimestampMonotonic is microseconds-since-boot.
  // process.hrtime.bigint() is nanoseconds-since-boot. Convert both
  // to seconds and subtract.
  const nowSec = Number(process.hrtime.bigint() / 1_000_000_000n);
  const enterSec = enterUs / 1_000_000;
  const delta = nowSec - enterSec;
  return Number.isFinite(delta) && delta >= 0 ? Math.floor(delta) : null;
}

async function getRecentLog(lines = 20): Promise<string[]> {
  // `journalctl --user-unit` would work without sudo for user-owned
  // units, but slop-broadcast is a system unit. We rely on the `adm`
  // group membership of `ubuntu` to read /var/log/journal/ directly.
  const { stdout, code } = await run("journalctl", [
    "-u",
    UNIT,
    "-n",
    String(lines),
    "--no-pager",
    "--output=short-iso",
  ], 3000);
  if (code !== 0) return [];
  return stdout.split("\n").filter((l) => l.trim().length > 0);
}

/** Lightweight active check — a single `systemctl is-active`, no journal
 *  read. Used by the on-air poller which runs every few seconds; the full
 *  getBroadcastStatus() (4 subprocesses) is reserved for the admin panel. */
export async function isBroadcastActive(): Promise<boolean> {
  return (await getActive()) === "active";
}

export async function getBroadcastStatus(): Promise<BroadcastStatus> {
  const [active, enabled, activeForSeconds, recentLog] = await Promise.all([
    getActive(),
    getEnabled(),
    getActiveForSeconds(),
    getRecentLog(20),
  ]);
  return { active, enabled, activeForSeconds, recentLog };
}

/** Shell out to `sudo -n systemctl <verb> slop-broadcast.service`. */
export async function broadcastAction(
  action: Action,
): Promise<{ ok: boolean; error?: string }> {
  const { code, stderr } = await run(
    "sudo",
    ["-n", "systemctl", action, UNIT],
    10000,
  );
  if (code === 0) return { ok: true };
  return {
    ok: false,
    error: stderr.trim() || `systemctl ${action} exited ${code}`,
  };
}

/** Read the current SLOP_URL from the env file. Null if missing. */
export async function getBroadcastUrl(): Promise<string | null> {
  let body: string;
  try {
    body = await readFile(ENV_FILE, "utf8");
  } catch {
    return null;
  }
  // Match `SLOP_URL=<value>` on its own line. Values may contain `=`
  // (query strings) but never a literal newline — we strip CRLF below.
  const match = body.match(/^SLOP_URL=(.*)$/m);
  if (!match || match[1] === undefined) return null;
  return match[1].trim();
}

/**
 * Rewrite SLOP_URL in the env file and restart the broadcaster so the
 * change takes effect. Rejects non-http(s) URLs and anything with a
 * newline (which would let an attacker inject other env vars).
 */
export async function setBroadcastUrl(
  url: string,
): Promise<{ ok: boolean; error?: string; url?: string }> {
  // Strict validation. The env file is parsed line-by-line by systemd,
  // so a newline in the value would leak into the next variable.
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    return { ok: false, error: "url must be a non-empty string under 2048 chars" };
  }
  if (/[\r\n\0]/.test(url)) {
    return { ok: false, error: "url contains an illegal control character" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "url is not a valid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "url must be http(s)" };
  }

  let body: string;
  try {
    body = await readFile(ENV_FILE, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read env file: ${(err as Error).message}` };
  }
  // Replace the existing SLOP_URL line; if no such line, append one.
  let next: string;
  if (/^SLOP_URL=.*$/m.test(body)) {
    next = body.replace(/^SLOP_URL=.*$/m, `SLOP_URL=${url}`);
  } else {
    next = body.replace(/\n*$/, "") + `\nSLOP_URL=${url}\n`;
  }
  try {
    await writeFile(ENV_FILE, next, { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `cannot write env file: ${(err as Error).message}` };
  }

  const restart = await broadcastAction("restart");
  if (!restart.ok) {
    return { ok: false, error: `env updated but restart failed: ${restart.error}` };
  }
  return { ok: true, url };
}
