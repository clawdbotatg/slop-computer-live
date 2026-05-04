import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

/**
 * Fanout manager: spawns ffmpeg children that re-publish the slop.computer
 * stream to external destinations (YouTube Live, Twitch, X/Twitter Live, Kick).
 *
 * Pattern adapted from clawd-conclave: OBS pushes ONCE to our MediaMTX, the
 * relay fans out to socials with `-c copy` (no transcode). Stream keys live
 * in relay env, never leave the EC2 box.
 *
 * Process model: one long-lived ffmpeg per destination. Crashes are
 * forgiving — the registry entry is removed and the admin clicks Start to
 * respawn. SIGTERM on relay shutdown so YouTube sees a clean disconnect.
 *
 * X/Twitter caveat: studio.x.com generates RTMP keys per-broadcast.
 * Regenerate in studio.x.com → Producer if it stops working.
 */

type FanoutId = "youtube" | "twitch" | "twitter" | "kick";

const registry = new Map<FanoutId, ChildProcess>();
const startedAts = new Map<FanoutId, string>();

export type FanoutDestination = {
  id: FanoutId;
  name: string;
  configured: boolean;
  running: boolean;
  startedAt?: string;
};

function destinationUrl(id: FanoutId): string | null {
  if (id === "youtube") {
    const key = process.env.YOUTUBE_STREAM_KEY;
    if (!key) return null;
    const base = process.env.YOUTUBE_RTMP_URL || "rtmp://a.rtmp.youtube.com/live2";
    return `${base}/${key}`;
  }
  if (id === "twitch") {
    const key = process.env.TWITCH_STREAM_KEY;
    if (!key) return null;
    const base = process.env.TWITCH_RTMP_URL || "rtmp://live.twitch.tv/app";
    return `${base}/${key}`;
  }
  if (id === "twitter") {
    const key = process.env.TWITTER_STREAM_KEY;
    if (!key) return null;
    const base = process.env.TWITTER_RTMP_URL || "rtmps://va.pscp.tv:443/x";
    return `${base}/${key}`;
  }
  if (id === "kick") {
    const key = process.env.KICK_STREAM_KEY;
    if (!key) return null;
    const raw = process.env.KICK_RTMP_URL ?? "";
    const base = raw.replace(/\/$/, "");
    if (!base) return null;
    return `${base}/${key}`;
  }
  return null;
}

export function listFanouts(): FanoutDestination[] {
  return (["youtube", "twitch", "twitter", "kick"] as const).map(id => ({
    id,
    name:
      id === "youtube"
        ? "YouTube Live"
        : id === "twitch"
          ? "Twitch"
          : id === "twitter"
            ? "X / Twitter Live"
            : "Kick",
    configured: destinationUrl(id) !== null,
    running: registry.has(id),
    startedAt: startedAts.get(id),
  }));
}

export function startFanout(id: FanoutId, log: (line: string) => void): { ok: true } | { ok: false; error: string } {
  if (registry.has(id)) return { ok: false, error: "Already running" };
  const url = destinationUrl(id);
  if (!url) return { ok: false, error: `${id} is not configured (missing stream key in relay env)` };

  // Pull from our local MediaMTX. Read on path "live" doesn't require
  // publish auth (only the "live" user can publish; "any" user reads).
  const source = "rtmp://127.0.0.1:1935/live";
  const proc = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "warning", "-i", source, "-c", "copy", "-f", "flv", url],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  proc.stdout?.on("data", d => log(`[fanout ${id}] ${d.toString().trim()}`));
  proc.stderr?.on("data", d => log(`[fanout ${id}] ${d.toString().trim()}`));
  proc.on("exit", code => {
    log(`[fanout ${id}] exited with code ${code}`);
    registry.delete(id);
    startedAts.delete(id);
  });

  registry.set(id, proc);
  startedAts.set(id, new Date().toISOString());
  return { ok: true };
}

export function stopFanout(id: FanoutId): { ok: true } | { ok: false; error: string } {
  const proc = registry.get(id);
  if (!proc) return { ok: false, error: "Not running" };
  proc.kill("SIGTERM");
  registry.delete(id);
  startedAts.delete(id);
  return { ok: true };
}

export function isKnownFanoutId(id: string): id is FanoutId {
  return id === "youtube" || id === "twitch" || id === "twitter" || id === "kick";
}

export function shutdownAllFanouts(): void {
  for (const [, proc] of registry) {
    proc.kill("SIGTERM");
  }
  registry.clear();
  startedAts.clear();
}
