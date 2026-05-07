import { randomBytes } from "node:crypto";
import { config } from "./config.js";

export type Role = "host" | "guest";

export type Session = {
  token: string;
  role: Role;
  address: string | null;
  handle: string | null;
  expiresAt: number;
};

const sessions = new Map<string, Session>();
const nonces = new Map<string, number>();

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

export function createSession(args: { role: Role; address: string | null; handle: string | null }): Session {
  pruneSessions();
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + config.sessionTTLSeconds * 1000;
  const session: Session = { token, expiresAt, ...args };
  sessions.set(token, session);
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
  return session;
}

export function getSession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function deleteSession(token: string): void {
  sessions.delete(token);
}

function pruneSessions() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expiresAt < now) sessions.delete(t);
}

export const SESSION_COOKIE = "slop_session";
