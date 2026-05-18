import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

// Single global invite password — gates the sign-in screen.
// File-backed so the value survives restarts; admin can regenerate via
// the admin endpoint. Plaintext on disk is fine: this is the same
// secret we hand out in the invite link, not a high-value credential.
//
// Cookie carries the password value verbatim; isInvited() compares
// the cookie to the current password. Regeneration therefore
// invalidates every outstanding invite cookie atomically.

// Default to a cwd-relative path so `yarn dev` works without writing
// to /var/lib (not user-writable on macOS / dev boxes). Production
// systemd unit overrides via INVITE_PASSWORD_FILE env var.
const INVITE_PASSWORD_FILE = process.env.INVITE_PASSWORD_FILE ?? "./.slop-data/invite_password.txt";

let cached: string | null = null;

function readFromDisk(): string | null {
  try {
    const raw = readFileSync(INVITE_PASSWORD_FILE, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeToDisk(value: string): void {
  mkdirSync(dirname(INVITE_PASSWORD_FILE), { recursive: true });
  writeFileSync(INVITE_PASSWORD_FILE, value, { encoding: "utf8" });
}

function freshPassword(): string {
  // 12 url-safe characters (9 random bytes → 12 base64url chars). Bumped
  // from 8 — invites are usually clicked through a URL, not typed, so the
  // extra width is free and the entropy is comfortable for a shared gate.
  return randomBytes(9).toString("base64url");
}

/**
 * Read the current invite password — initializing on first call by
 * (a) honoring the legacy GUEST_PASSWORD env var if set, otherwise
 * (b) generating a random value and persisting it to disk.
 */
export function getInvitePassword(): string {
  if (cached) return cached;
  const onDisk = readFromDisk();
  if (onDisk) {
    cached = onDisk;
    return onDisk;
  }
  // First boot: prefer the env-set GUEST_PASSWORD if provided so an
  // operator can deterministically pin the value before any UI exists.
  const seed = config.guestPassword || freshPassword();
  writeToDisk(seed);
  cached = seed;
  return seed;
}

/** Force a new password; returns the new value. */
export function regenerateInvitePassword(): string {
  const next = freshPassword();
  writeToDisk(next);
  cached = next;
  return next;
}

export const INVITE_COOKIE = "slop_invite";

export function isInvited(cookieValue: string | undefined | null): boolean {
  if (!cookieValue) return false;
  return cookieValue === getInvitePassword();
}
