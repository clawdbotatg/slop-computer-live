# Auth hardening — roadmap

Forward-looking notes for the auth surface on the relay
(`packages/relay/src/`). Captures decisions made and explicitly *deferred*
during the 2026-05-27 security review, so the next session doesn't
re-litigate them or accidentally ship the wrong thing.

## Threat model (the invariant we're protecting)

The hard rule, as stated by Austin:

> Anyone can SIWE to comment on the front-page slug. Anyone with a
> room password can get into live. SIWE is just for identity. **What I
> don't want is for someone to get into live without knowing the
> password.**

So: room-password = the gate. Identity (SIWE / passkey / anon) is
orthogonal. Public commenting on the front-page firehose is fine.
Joining a live room or writing any room-scoped state requires the
password. Everything below is measured against that.

## What's shipped (do not redo)

- **`config.ts` startup guards** (commit `84de2d5`, on `origin/main`).
  Relay refuses to start in `NODE_ENV=production` if
  `SIWE_SESSION_SECRET` is unset / equals the public dev fallback
  `"dev-secret-change-me"`, or if `CORS_ORIGINS` contains `"*"`. Closes
  the room-cookie forgery vector (the secret HMAC-signs every room
  cookie) and the `*`+credentials CORS credential-theft footgun. No
  effect on local dev.
- **REST/bearer gate fail-closed** (commit `398af74`, *local-only as of
  2026-05-27 — push pending Austin's OK*). `v1AuthFromReq` now matches
  the WS `/signal` gate exactly: a non-`debug` slug with no password is
  unclaimed → unreachable, not open. Pre-fix, REST was reachable for
  any passwordless room (todos / notes / files / agent-token mint —
  all 66 slug-scoped v1 endpoints) while the WS mesh refused it. The
  safety used to rely on "every room always has a password"; now it's
  enforced structurally.

Both fixes are inert against the current prod config (real 64-char
secret, 3 explicit origins, all live rooms have passwords). They're
guardrails for the next misconfig.

## Open / deferred

### 1. Passkey audience-chat is unconditionally open (deferred 2026-05-27)

`/auth/passkey` in `index.ts:4179` accepts any browser-created passkey
and mints a session cookie. No invite cookie, no room cookie required.
The intent in the code comment is "passkey is an Ethereum identity,
same as SIWE" — both are "open sign-in". But the **friction** is not
the same:

| Endpoint | Invite gate | Friction |
|---|---|---|
| `/auth/siwe` | none | wallet (~30s) |
| `/auth/passkey` | **none** | browser only (~5s) |
| `/auth/anon` | `slop_invite` OR any room cookie | (gated) |

So anon (gated) and passkey (ungated) end up at very different
defaults despite both being friction-light. A fresh visitor can
WebAuthn-create a passkey and post chat to any slug — the endpoint is
reachable from any origin in `CORS_ORIGINS` (slop.computer is in
there), so a UI button isn't even needed. Austin reviewed this on
2026-05-27 and chose to leave it for now.

**If/when we revisit, the small surgical fix:** add anon's gate to the
passkey handler. ~3 lines:

```ts
// in /auth/passkey, before consumeNonce / verifyPasskey:
if (
  !isInvited(req.cookies[INVITE_COOKIE]) &&
  !hasAnyValidRoomCookie(req.cookies, config.sessionSecret)
) {
  return reply.code(403).send({ error: "invite-required" });
}
```

Side-effects to think through before shipping:
- Passkey-as-room-signer flow: peers already inside a room (so they
  hold a room cookie) keep being able to register a passkey as a
  multisig signer. Outsiders can no longer create a passkey for the
  sole purpose of drive-by audience chat. This matches the intent.
- SIWE stays open per the threat model. Only the *zero-friction* path
  gets a gate.

### 2. Token-gate audience commenting (deferred — design-only)

Optional next layer on top of the passkey gate (or independently):
require the SIWE address to hold a specific token / balance before
issuing the chat-capable session cookie. Already-wired infrastructure:

- Alchemy + viem `publicClient` is instantiated in `siwe.ts:8-15`
  (currently used for signature verify + ENS reverse-lookup). Reuse:
  `readContract({ address, abi, functionName: 'balanceOf', args })` for
  ERC-20 / 721 / 1155, or `publicClient.getBalance({ address })` for
  native ETH.
- Zerion (`config.zerionApiKey`) is already configured for the AI
  wallet. Multi-chain portfolio in one REST call — cleaner than
  per-chain Alchemy if "owns X on any L2" is the rule.
- ENS reverse-lookup cache (~1h TTL) in `ens.ts` is the template for
  a `holdsToken(address)` cache — must cache to avoid hammering RPC
  on every visitor.

**Hook point:** `/auth/siwe` at `index.ts:4143-4149`, right after
`verifySiwe` succeeds and before `createSession`. Parallel to the ENS
reverse-lookup. Reject with 403 → no session cookie → no chat.

**Product decisions still owed before implementing:**

1. What counts as "owns"? Specific ERC-20 ≥ N / specific NFT contract
   (any tokenId) / specific tokenId only / multi-chain portfolio ≥ $X
   via Zerion?
2. Which chain? Mainnet (already wired) / Base / "any chain Zerion sees"?
3. Apply to passkey path too? Passkey-derived addresses have no
   on-chain history, so they'd fail any balance check naturally — which
   is probably the *desired* effect (the token-gate elegantly closes
   the passkey-open issue too).
4. Failure mode on RPC timeout? Fail-closed (deny — safer, occasionally
   frustrating) or fail-open (allow — better UX, weaker gate). Default
   recommendation: fail-closed with a short retry + 10-min positive cache.
5. Surface the badge? Trivial bonus — return holder status on
   `/auth/siwe` + `/auth/me`, `SlopAddress` can render a holder pill.

Estimated effort: ~30-50 LOC for the helper + cache + env wiring + the
hook.

### 3. Prod cleanup: passwordless leftover room

`ep3-elon-musk-test` exists on the prod box's
`/home/ubuntu/slop-computer-live/packages/relay/.slop-data/rooms/`
without an `auth.json`. Under the new gate (commit `398af74`) it's
unreachable on both REST and WS, so this is now a *cosmetic* cleanup —
not security-critical. Either:

```bash
ssh slopcomputer 'rm -rf /home/ubuntu/slop-computer-live/packages/relay/.slop-data/rooms/ep3-elon-musk-test'
```

…or claim a password for it via `POST /v1/rooms` if anything in there
is worth keeping. Verify nothing else references the slug first.

## Design boundaries (don't accidentally relax these)

These are the invariants the WS gate, REST gate, and host check rely
on. Any future auth change must preserve them:

- **Host requires both `role === "host"` *and* an address in
  `ADMIN_ADDRESSES`.** Triple-checked via `isAdminAddress`. Do not
  promote a session to host based on role alone — addresses are the
  source of truth.
- **Spectator (god-mode) sessions can never publish, chat, or mutate
  shared state.** Enforced in the WS message handler. New WS message
  types must explicitly opt out of spectator access.
- **Bearer (agent) tokens are room-scoped at mint time** (`roomSlug`
  baked into the session). Cross-room access via bearer = a hole.
  `v1AuthFromReq` rejects mismatched slugs.
- **`skipRoomGate: true` is for chat/transcript-style audience surfaces
  only.** Any write endpoint that adds `skipRoomGate: true` is a
  re-opening of the gate the WS/REST symmetry is designed to enforce.
  Audit any new usage carefully.
- **Public reads (chat / transcript / meta / cards / episode GETs)
  stay cookieless on purpose** — see `relay_room_access_model` memory
  + the comments at `/v1/rooms/:slug/meta`. Do not lock these down
  reflexively; spectators on the front-page rely on them.
