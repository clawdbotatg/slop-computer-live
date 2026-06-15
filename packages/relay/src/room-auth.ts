import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room password gate. Each room's `auth.json` stores a scrypt-hashed
// password; the host sets it on room creation (POST /v1/rooms) and
// anyone with the password POSTs /v1/rooms/:slug/auth to get an
// HMAC-signed cookie scoped to that slug.
//
// Cookie format: `<payload>.<sig>` where payload is base64url(JSON({slug,issuedAt}))
// and sig is base64url(hmac-sha256(payload, sessionSecret)). The slug is
// in the payload so a cookie issued for ep0 cannot be replayed at ep1.

const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
// scrypt cost params — N=2^14 (16384) is the standard "interactive login"
// setting and runs in ~50ms on prod. Bump if hardware gets faster than
// attackers, but don't go below this.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function hashPassword(plaintext: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(plaintext: string, stored: string): boolean {
  const idx = stored.indexOf(":");
  if (idx < 0) return false;
  const saltHex = stored.slice(0, idx);
  const hashHex = stored.slice(idx + 1);
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  let computed: Buffer;
  try {
    computed = scryptSync(plaintext, salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  } catch {
    return false;
  }
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

// "password" — the classic shared-secret gate (default for every room).
// "wallet-signers" — access is whoever is a signer on the room's current
// multisig. A room is *upgraded* from "password" to "wallet-signers" by a
// host once a wallet exists; the password hash is kept (so the room stays
// "claimed" and the upgrade is reversible) but no longer gates entry.
export type RoomGateMode = "password" | "wallet-signers";

type RoomAuthState = {
  passwordHash: string | null;
  createdAt: number;
  gateMode: RoomGateMode;
};

export class RoomAuth {
  private state: RoomAuthState = { passwordHash: null, createdAt: 0, gateMode: "password" };
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RoomAuthState>;
      this.state = {
        passwordHash: typeof parsed.passwordHash === "string" ? parsed.passwordHash : null,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
        gateMode: parsed.gateMode === "wallet-signers" ? "wallet-signers" : "password",
      };
    } catch {
      /* fresh — no password yet */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.state));
    } catch {
      /* disk write failure — in-memory hash still valid until restart */
    }
  }

  /** True if a password has been set for this room. Rooms without a
   *  password are effectively "unclaimed" — POST /v1/rooms claims them. */
  hasPassword(): boolean {
    this.load();
    return this.state.passwordHash !== null;
  }

  setPassword(plaintext: string): void {
    if (!plaintext) throw new Error("empty password");
    this.load();
    this.state = {
      ...this.state,
      passwordHash: hashPassword(plaintext),
      createdAt: this.state.createdAt || Date.now(),
    };
    this.persist();
  }

  /** Which gate controls entry to this room. Defaults to "password". */
  gateMode(): RoomGateMode {
    this.load();
    return this.state.gateMode;
  }

  setGateMode(mode: RoomGateMode): void {
    this.load();
    if (this.state.gateMode === mode) return;
    this.state.gateMode = mode;
    this.persist();
  }

  verify(plaintext: string): boolean {
    this.load();
    if (!this.state.passwordHash) return false;
    return verifyPassword(plaintext, this.state.passwordHash);
  }

  createdAt(): number {
    this.load();
    return this.state.createdAt;
  }
}

// --- Cookie helpers --------------------------------------------------------

export const ROOM_COOKIE_PREFIX = "slop_room_";

export function roomCookieName(slug: string): string {
  return `${ROOM_COOKIE_PREFIX}${slug}`;
}

export function signRoomCookie(slug: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ slug, iat: Date.now() }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyRoomCookie(cookie: string | undefined, slug: string, secret: string): boolean {
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot < 0) return false;
  const payloadB64 = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as { slug?: unknown };
    return payload.slug === slug;
  } catch {
    return false;
  }
}

// True if the request carries at least one HMAC-valid `slop_room_<slug>`
// cookie. Used by the global sign-in endpoints (SIWE, passkey) to accept
// "the user already cleared at least one room's password gate" as proof
// of invitation, replacing the legacy single-password slop_invite check
// in the per-room flow. Per-room access is still gated separately by
// the room's own cookie at WS handshake time.
export function hasAnyValidRoomCookie(
  cookies: Record<string, string | undefined>,
  secret: string,
): boolean {
  for (const [name, value] of Object.entries(cookies)) {
    if (!name.startsWith(ROOM_COOKIE_PREFIX)) continue;
    const slug = name.slice(ROOM_COOKIE_PREFIX.length);
    if (verifyRoomCookie(value, slug, secret)) return true;
  }
  return false;
}
