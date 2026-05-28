# slop-computer-live auth model

How identity, room access, and host privileges work. Read this before
touching `packages/relay/src/index.ts` around `v1AuthFromReq` /
`/signal` / any `/auth/*` endpoint, before adding a new `?slug=`
endpoint, or whenever you want to know "can a stranger reach X?"

The companion doc — what we've deferred and what's next — lives at
[`ops/PLAN-auth-hardening.md`](../ops/PLAN-auth-hardening.md).

---

## The threat-model invariant

One sentence, the bar every gate must meet:

> Anyone can sign in to comment on the front-page chat. Anyone with a
> room's password can enter that room's live mesh. **No one gets into
> a live room — or writes any room-scoped state — without that room's
> password.** Identity (SIWE / passkey / anon) is orthogonal to room
> access.

So:
- **Identity** = "who you are" (an Ethereum address, a passkey-derived
  address, or an `AnonXXXX` handle).
- **Room access** = "you proved you know room X's password."

A write to a room needs **both**. A spectator comment on chat needs
only the first. The room password is the load-bearing secret.

---

## The cookies

Three cookies, each carrying one of those two things:

| Cookie | Set by | Lifetime | Carries |
|---|---|---|---|
| `slop_session` | `/auth/siwe`, `/auth/passkey`, `/auth/anon`, `/auth/godmode`, `/auth/password` | 24h (configurable via `SESSION_TTL_SECONDS`) | Identity (session token → server-side `Session`) |
| `slop_room_<slug>` | `/v1/rooms/:slug/auth` | 365d | Proof of room password for `<slug>` (HMAC over `{slug, iat}`) |
| `slop_invite` | `/auth/invite` (legacy single-global-invite) | 365d | Plaintext invite token, compared verbatim to `getInvitePassword()` |

`slop_session` is server-side state (random 32-byte token, the row is
in `.slop-data/sessions.json`). `slop_room_<slug>` is HMAC-signed with
`SIWE_SESSION_SECRET` — so a relay restart doesn't invalidate it, but
forging it requires that secret. (See "Operational invariants" below
for what happens if the secret is unset.)

---

## The five sign-in endpoints

All issue a `slop_session` cookie. None of them issue room access.

| Endpoint | Friction | Invite gate? | Role assigned | Notes |
|---|---|---|---|---|
| `POST /auth/siwe` | Wallet + signature | **none** ("open sign-in") | `host` if address in `ADMIN_ADDRESSES`, else `guest` | Real Ethereum identity. Reverse-ENS resolved on login. |
| `POST /auth/passkey` | WebAuthn (browser-native) | **none** ("open sign-in") | `guest` always | Address derived from passkey pubkey: `keccak256(qx ‖ qy)[-20:]`. Same address shape as SIWE so multisig signing works. **⚠ See caveats below.** |
| `POST /auth/anon` | Click a button | `slop_invite` **OR** any valid `slop_room_*` cookie | `guest` always | `handle: "Anon1234"`, stable `anonId` for color flag. |
| `POST /auth/password` | Type the guest password + handle | (the password itself is the gate) | `guest` always | Legacy. Requires `GUEST_PASSWORD` set on the relay env. |
| `POST /auth/godmode` | Type the godmode password | any valid `slop_room_*` cookie | `guest` with `spectator: true` | For the streaming-capture box. Passive only — can't publish/chat/mutate. |

Three rate-limit buckets cover all password endpoints: 10 attempts per
IP per minute (`PASSWORD_RATE_LIMIT` in `index.ts`).

---

## The single room-access endpoint

| Endpoint | What it does |
|---|---|
| `POST /v1/rooms/:slug/auth` | Verify the room's password (scrypt, timing-safe compare) → set `slop_room_<slug>` HMAC cookie |
| `GET /v1/rooms/:slug/auth` | Status: does the room exist + does the caller already hold a valid cookie? |
| `POST /v1/rooms` | **Host-only.** Claim a new slug + set its password. |
| `POST /v1/rooms/:slug/password` | **Host-only.** Rotate the password. |

Room password is hashed with scrypt (`N=2^14, r=8, p=1`, ~50ms on
prod) and stored at `.slop-data/rooms/<slug>/auth.json`. Plaintext
never touches disk.

---

## The two gates that enforce room access

Every code path that touches room state passes through one of two
gates. **They must behave identically** — diverging behavior is the
exact bug the 2026-05-27 audit found and closed.

### WS gate — `index.ts:4928` (`/signal`)

```
1. session cookie present?              no → 4401 unauthenticated
2. slug === "debug"?                    yes → admit (sandbox)
3. room has no password (unclaimed)?    yes → 4404 room-not-found
4. session has valid slop_room_<slug>?  no  → 4403 room-auth-required
5. paid-room gate (Phase 7 stub)        ...
6. admit to live mesh
```

### REST gate — `index.ts:833` (`v1AuthFromReq`)

Two paths:
- **Bearer (agent token):** token is room-scoped at mint time
  (`roomSlug` baked in). Slug query must match that baked slug, AND
  the slug must be `debug` OR have a password set.
- **Cookie (browser):** any `?slug=` query triggers the same checks:
  unclaimed non-debug → 401, has-password but no room cookie → 401.

Both paths converge on the same condition: **you can only reach
`?slug=X` if `X` is debug, or X has a password and you hold X's
cookie.** Symmetric with the WS gate.

### `skipRoomGate: true` — the audience-chat carve-out

The one explicit bypass. As of writing, **one endpoint** uses it:
`POST /v1/chat` (the front-page spectator-comment firehose). It needs
to admit anyone with a session cookie (SIWE / passkey / anon) without
requiring the room password, because the entire product premise is
"audience comments on the live show from anywhere."

Adding `skipRoomGate: true` to any **write** endpoint is a re-opening
of the gate. Audit any new usage carefully — the grep below should
return one line forever:

```bash
grep -rn 'skipRoomGate: true' packages/relay/src/
```

---

## Defense-in-depth boundaries (do not relax these)

| Check | Where | Why |
|---|---|---|
| **Host requires `role === "host"` AND admin address** | `v1AuthFromReq`, `requireHost`, `/auth/me` | Triple-check. Don't promote a session to host based on `role` alone — `ADMIN_ADDRESSES` is the source of truth. |
| **Spectator (godmode) sessions can never write** | WS message handler, action endpoints | Spectator is the streaming box. New WS message types must explicitly opt out for spectators. |
| **Bearer tokens are room-scoped at mint time** | `createAgentSession`, bearer path in `v1AuthFromReq` | A token minted for room A must 401 on room B. Cross-room access via bearer is a hole. |
| **Cookie signing uses a real random secret** | startup guard in `config.ts` | The HMAC key for every `slop_room_*` cookie + `@fastify/cookie`. With the public dev fallback secret, anyone can forge a valid cookie for any room. Startup *refuses to boot* in production if the secret is unset. |
| **CORS is never `*` with `credentials: true`** | startup guard in `config.ts` | `@fastify/cors` reflects the caller's origin with `Allow-Credentials: true` when `origin: "*"`, letting any site make authenticated calls with a visitor's cookies. Startup refuses `*` in production. |

---

## Known caveats (intentional, but worth knowing)

### 1. Passkey audience chat has no friction gate

`/auth/passkey` is "open sign-in" same as `/auth/siwe`. But the
friction is very different — a passkey is browser-native, takes ~5
seconds, no wallet, no on-chain identity. Effectively any visitor can
WebAuthn-create a fresh passkey and post chat to any slug's firehose.

`/auth/anon` requires the `slop_invite` cookie OR a valid room
cookie; `/auth/passkey` does not. The asymmetry is deliberate as of
2026-05-27 (Austin's call). The fix is pre-written and ~3 lines — see
[`ops/PLAN-auth-hardening.md`](../ops/PLAN-auth-hardening.md) §"Open / deferred → 1."

### 2. The `debug` slug is always open

`DEFAULT_SLUG = "debug"` (see `room.ts:56`) has no password gate. Any
authenticated session can join it on WS or hit its REST surface.
Intentional: it's the always-on sandbox for ops + the AI for poking
at the relay. Do not co-locate sensitive state with the debug room.

### 3. Public reads stay cookieless on purpose

`GET /v1/transcript`, `GET /v1/chat`, `GET /v1/rooms/:slug/meta`,
`GET /v1/cards/...`, `GET /v1/episode/...` are reachable without any
cookie. This is what lets the front-page (slop.computer) unfurl and
spectate without the audience needing to authenticate first. The
threat model accepts spectator reads as public; writes still need both
gates.

### 4. SIWE sign-in is open by design

Anyone with an Ethereum wallet can SIWE in and get a guest session —
no global invite required. This is what enables third-party comments
on the front-page. The room password remains the real gate for joining
live; SIWE is only "who you are."

---

## Operational invariants (prod must set these)

The relay refuses to boot in `NODE_ENV=production` if any of these is
mis-set. The guards are in
[`packages/relay/src/config.ts`](../packages/relay/src/config.ts).

| Env var | Why it must be set in prod | Failure mode if missing |
|---|---|---|
| `SIWE_SESSION_SECRET` | HMAC key for room cookies + `@fastify/cookie` secret. Default `"dev-secret-change-me"` is public in this repo. | **Relay refuses to start.** |
| `CORS_ORIGINS` (must not contain `*`) | Wildcard + `credentials: true` is a cross-origin credential-theft vector. | **Relay refuses to start.** |
| `ALCHEMY_API_KEY` | SIWE signature verify, ENS reverse-lookup. | **Relay refuses to start** (`siwe.ts:6`). |
| `ADMIN_ADDRESSES` | Comma-list of host-eligible Ethereum addresses. | Unset → no host can sign in (the prod box would have no admin). |
| `GOD_MODE_PASSWORD` | Streaming-box passive session password. | Unset → `/auth/godmode` returns 503, streaming box can't auth. |

Optional: `GUEST_PASSWORD` (legacy `/auth/password` flow — 503 if
unset, which is the safe default), `TURN_SECRET` / `TURN_HOST`
(TURN issuer returns 503 if unset).

---

## Where to look in code

- `packages/relay/src/config.ts` — env wiring + startup guards
- `packages/relay/src/sessions.ts` — `Session` shape, `createSession`,
  `createAgentSession` (room-scoped agent tokens)
- `packages/relay/src/room-auth.ts` — scrypt hashing, HMAC room cookies
- `packages/relay/src/siwe.ts` — SIWE verify, `isAdminAddress`
- `packages/relay/src/passkey.ts` — WebAuthn verify + address derivation
- `packages/relay/src/invites.ts` — single-global `slop_invite` (legacy)
- `packages/relay/src/index.ts` — endpoints + the two gates
  (`v1AuthFromReq` at ~833, `/signal` WS gate at ~4928, `requireHost`
  at ~4413)
- Frontend sign-in UI: `packages/nextjs/components/JoinCard.tsx` +
  `packages/nextjs/utils/passkey.ts`

## Reporting an issue

If you find a way around any of the above, email
[austin@ethereum.org](mailto:austin@ethereum.org) before filing a
public issue. Bug bounty: a fond handshake and your name in the
credits.
