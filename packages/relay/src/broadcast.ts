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

const UNIT = "slop-broadcast.service";

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
