import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export type Role = "host" | "guest";

export type Session = {
  token: string;
  role: Role;
  address: string | null;
  handle: string | null;
  expiresAt: number;
  // True for "god mode" streaming sessions: receives broadcasts but
  // is invisible to other peers (no guest list entry, no cursor) and
  // is rejected if it tries to publish, chat, or write any shared
  // state. Role stays "guest" so admin-only checks still gate it.
  spectator?: boolean;
};

// Persist sessions to disk so a relay restart (every deploy) doesn't
// boot every logged-in user. The browser still holds the session
// cookie; persisting the server-side row behind it means the cookie
// keeps working without a fresh SIWE / passkey signature.
//
// File contents: { sessions: Session[] }. Expired entries are pruned
// on load. Same on-disk trust model as apps.json / todos.json —
// anyone with filesystem access can impersonate anyone, which is fine
// for our threat model (root on the box owns everything anyway).
const SESSIONS_FILE = process.env.SESSIONS_FILE ?? "./.slop-data/sessions.json";

const sessions = new Map<string, Session>();
const nonces = new Map<string, number>();

let loaded = false;
function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    if (Array.isArray(parsed.sessions)) {
      const now = Date.now();
      for (const s of parsed.sessions as Session[]) {
        if (
          s &&
          typeof s.token === "string" &&
          typeof s.expiresAt === "number" &&
          s.expiresAt > now &&
          (s.role === "host" || s.role === "guest")
        ) {
          sessions.set(s.token, s);
        }
      }
    }
  } catch {
    /* no file yet → fresh map */
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(dirname(SESSIONS_FILE), { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: Array.from(sessions.values()) }), "utf8");
  } catch (err) {
    console.warn("[sessions] persist failed", err);
  }
}

loadFromDisk();

const NONCE_TTL_MS = 10 * 60 * 1000;

export function issueNonce(): string {
  const nonce = randomBytes(16).toString("hex");
  nonces.set(nonce, Date.now() + NONCE_TTL_MS);
  pruneNonces();
  return nonce;
}

export function consumeNonce(nonce: string): boolean {
  const exp = nonces.get(nonce);
  if (!exp) return false;
  nonces.delete(nonce);
  return exp > Date.now();
}

function pruneNonces() {
  const now = Date.now();
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
}

export function createSession(args: {
  role: Role;
  address: string | null;
  handle: string | null;
  spectator?: boolean;
}): Session {
  pruneSessions();
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + config.sessionTTLSeconds * 1000;
  const session: Session = { token, expiresAt, ...args };
  sessions.set(token, session);
  persistToDisk();
  return session;
}

const AGENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Mint a long-lived "agent" token tied to the same identity as `base`.
 * Used by the BYO-AI flow: a participant signs in normally, asks the relay
 * for an agent token, then hands it to a local LLM along with a skill file.
 * Agent tokens are accepted via Authorization: Bearer on /v1/* routes.
 */
export function createAgentSession(base: Pick<Session, "role" | "address" | "handle">): Session {
  pruneSessions();
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + AGENT_TOKEN_TTL_MS;
  const session: Session = {
    token,
    expiresAt,
    role: base.role,
    address: base.address,
    handle: base.handle,
  };
  sessions.set(token, session);
  persistToDisk();
  return session;
}

export function getSession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    persistToDisk();
    return null;
  }
  return s;
}

export function deleteSession(token: string): void {
  if (sessions.delete(token)) persistToDisk();
}

function pruneSessions() {
  const now = Date.now();
  let dirty = false;
  for (const [t, s] of sessions) {
    if (s.expiresAt < now) {
      sessions.delete(t);
      dirty = true;
    }
  }
  if (dirty) persistToDisk();
}

export const SESSION_COOKIE = "slop_session";
