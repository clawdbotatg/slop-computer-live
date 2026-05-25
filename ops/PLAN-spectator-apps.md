# Spectator-shippable apps

Research / design doc for letting anyone with a slop bearer token ship a
real multiplayer app to the desktop, without touching the slop-computer
repo or running the deploy script. Goal: someone in their own
Claude Code session reads a skill, writes ~80 lines of code, deploys
the app to Vercel/IPFS, and registers it via curl. App is live for
every peer in the room.

Status: **Research, not greenlit.** Captured 2026-05-25 from a design
chat. The L0 iframe path already exists today (`POST /v1/apps` with a
`url`), but it doesn't support real multiplayer — see "The actual
blocker" below.

---

## The actual blocker

It's NOT icons. It's NOT the deploy script. It's the iframe model.

The current shared-browser kind (any L0/L1 app with a `url`) renders
in ONE headless Chrome instance owned by `packages/browser-host`. All
peers in the room watch that one instance like a TV. Mouse/keyboard
input comes from one peer at a time. That model is right for "let's
all look at vitalik.eth's wallet together" — it's wrong for "two
peers play pong" or "everyone draws on a shared canvas".

The unlock is a **second iframe kind: per-peer**. Same URL, same
registration flow, but each peer renders the iframe locally in their
own browser tab. Independent input, independent React tree per peer.
Multiplayer coordination then happens through relay-mediated state
(see KV primitive below) instead of through one shared Chromium.

This single distinction is most of the design.

---

## Required primitives

### 1. Per-peer iframe kind

New `kind: "personal"` (or `"app"`, name TBD) on the apps catalog.
Frontend mounts a plain `<iframe src={app.url}>` per peer instead of
routing through `SharedBrowser` + `browser-host`.

The iframe loads a slop SDK script from `https://live.slop.computer/v1/sdk.js`
on boot, which sets up the postMessage channel with the parent slop
frame. The parent already has the WS open and acts as the bridge.

### 2. Slop SDK (`/v1/sdk.js`)

Minimum surface:

```js
slop.me                          // { ownerKey, handle, address, isHost }
slop.peers                       // [{ ownerKey, handle, ... }, ...]
slop.set(key, value)             // namespaced room-shared KV
slop.get(key)                    // synchronous read of last-known value
slop.subscribe(key, callback)    // notify on changes
slop.send(targetPeerId, msg)     // optional: direct peer message
slop.onPeerJoin(cb)              // optional: presence events
slop.onPeerLeave(cb)
```

All postMessage from the iframe to the parent slop frame; parent does
the actual WS work. SDK auto-namespaces every KV write to the app's
id (so two apps can both use `key="score"` without collision).

### 3. Generic namespaced KV on the relay

One new state class mirroring `qr-state.ts`:

```
POST  /v1/kv/:appId/:key       # write {value}; emits ws broadcast
GET   /v1/kv/:appId            # full snapshot of all keys for this app
DELETE /v1/kv/:appId/:key
```

WS broadcast: `{type: "kv", appId, key, value, by: ownerKey}`.

Per-room (lives on `Room.kv`). Persistent across reconnects within a
room; gone on relay restart (apps that need durability can persist to
the user's own backend; this KV is for live coordination).

This is what unblocks "pong-without-a-relay-deploy" — paddle Y and
ball state become KV entries that the SDK reads/writes for the app.

### 4. Icon-gen as a service

Wrap the existing `yarn icon:add` flow in a relay endpoint:

```
POST /v1/icon-gen { prompt, name? }
  → { url: "/icons/<name>.png", icon: "/icons/<name>.png" }
```

Implementation is the existing `packages/icon-gen/generate.mjs` logic
inlined into the relay (or shelled out). Rate-limit per peer
(suggest 5/hour). Persists to `packages/nextjs/public/icons/` like
today, but at runtime — no commit, no deploy. Survives relay restart
via the existing `public/icons/` mount.

Lowest-hanging fruit: this could ship independently of everything
else and immediately unblock "Claude Code making me an icon" today.

### 5. Peer-scope app registration with ownership

Currently `POST /v1/apps` is host-only. Open to peer scope with an
`ownedBy: ownerKey` stamp baked into `AppEntry`:

```ts
type AppEntry = {
  id: string;
  label: string;
  icon: string;
  url?: string;
  kind?: "browser" | "personal" | /* ... */;
  ownedBy?: string;    // ownerKey of the registering peer (peer-scope only)
};
```

Only the owner (or host) can `DELETE`. Built-in apps have no
`ownedBy` and can only be removed by host. Built-in `DEFAULT_APPS`
remain in the canonical icon grid; peer-registered apps render in a
separate "user apps" tray (or in the main grid with a small owner
blockie next to them, TBD).

---

## What a spectator app looks like end-to-end

```js
// pong.html (hosted on Vercel / GH Pages / IPFS — wherever)
<!doctype html>
<html><body>
<canvas id="game" width="800" height="500"></canvas>
<script src="https://live.slop.computer/v1/sdk.js"></script>
<script type="module">
  await slop.ready;

  // Claim a seat
  const mySide = slop.get("seats:left") ? "right" : "left";
  slop.set(`seats:${mySide}`, slop.me.ownerKey);

  // Render loop reads from KV
  slop.subscribe("paddle:right", v => render());
  slop.subscribe("paddle:left", v => render());
  slop.subscribe("ball", v => render());

  // Local paddle: keyboard → KV
  addEventListener("keydown", e => {
    if (e.key === "ArrowUp") slop.set(`paddle:${mySide}`, slop.get(`paddle:${mySide}`) - 20);
    if (e.key === "ArrowDown") slop.set(`paddle:${mySide}`, slop.get(`paddle:${mySide}`) + 20);
  });

  // Whoever joined first owns the ball physics (rough quorum)
  if (mySide === "left") setInterval(tickBall, 33);
</script>
</body></html>
```

Then the spectator's Claude Code:

```bash
# 1. Make an icon
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"A retro pong arcade","name":"pong-v2"}' \
  https://live.slop.computer/v1/icon-gen

# 2. Register the app
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"id":"pong-v2","label":"Pong v2","icon":"/icons/pong-v2.png",
       "url":"https://my-pong.vercel.app","kind":"personal"}' \
  https://live.slop.computer/v1/apps
```

Done. Icon shows up on every peer's desktop. Double-click opens the
iframe in each peer's own browser. They play.

---

## MVP scope

To prove the loop end-to-end, minimum surface:

1. `packages/relay/src/kv.ts` — namespaced KV state class with
   subscribe + size/key caps (mirrors `qr-state.ts`).
2. `packages/relay/src/index.ts` — REST endpoints `/v1/kv/*`,
   `/v1/icon-gen`, peer-scope `/v1/apps` with ownership.
3. `packages/relay/src/icon-gen.ts` — inline the existing
   `packages/icon-gen/` logic; reuse `style-ref.png`.
4. New `kind: "personal"` in the kind union (relay + frontend).
5. `packages/nextjs/components/desktop/PersonalAppWindow.tsx` —
   mounts a plain `<iframe>` and brokers postMessage to/from
   `usePeerMesh`.
6. `public/v1/sdk.js` — postMessage client. Served by Next.js
   static or Caddy.
7. `/v1/skill/build-app` — sub-skill documenting the whole flow:
   icon-gen, SDK surface, KV semantics, registration, examples.

Estimate: 2-3 focused days. Pong-on-this-stack would be the canonical
smoke test.

---

## Hard parts / open questions

### Abuse surface
- KV is a junk drawer the room can fill with garbage. Need per-peer
  rate limits, max value size (~64KB?), max keys per app (~256?),
  max apps per peer (~10?), auto-GC apps unopened for N days.
- Icon-gen costs OpenAI money. Cap per peer per hour. Maybe gate
  behind `verifyPaid()` once x402 lands.
- Random `/v1/apps` registrations spamming the desktop. The "user
  apps" tray separation matters here. Maybe the desktop only shows
  user apps the room has explicitly pinned.

### App lifecycle
- Do user-registered apps live **per-room** (registered in /ep0 only
  visible in /ep0) or **per-user** (follow the registering peer
  across rooms)? Per-room is simpler; per-user is more platform-y.
  Lean per-room for MVP — easier to reason about cleanup and
  blast radius.
- TTL: an app nobody opens for 7 days gets soft-deleted. Owner can
  pin to override.

### postMessage security
- Iframe origin is arbitrary. Need allowlisted or explicit handshake
  (parent sends a session token via postMessage on iframe load; iframe
  echoes it on every call). Don't trust the iframe's claims about
  `slop.me` — parent stamps identity.
- Maybe add a per-app CSP that restricts what URLs the iframe can
  reach. Probably not MVP.

### Schema discipline
- KV is untyped JSON. No way to enforce "paddle:left is a number".
  Apps that crash on bad KV writes are the app's problem. Could add
  a per-app schema later but not needed for first cut.

### What about the icon-gen prompt?
- Spectator-supplied prompts could be used to generate offensive
  imagery. Pre-filter via the existing icons.json styleHint plus a
  basic OpenAI moderation call. Host can delete any icon (already
  true via filesystem).

---

## Out of scope for this doc

- **Declarative slop-flavored JSX** as an alternative to iframes (host
  renders structured app descriptions, no iframe at all). Possibly
  better long-term — avoids the per-peer-iframe perf cost — but
  much more design work. Park.
- **IPFS-as-default-host**: nice eventually; ENS contenthash is
  already resolved via `/v1/ens/resolve`. MVP just accepts any URL.
- **Payment gating** on `/v1/icon-gen` and `/v1/apps`: defer to
  x402 when it lands.
- **App marketplace UI**: a place to browse user apps across rooms.
  Way later.

---

## Why this is worth doing

Right now, "ship a new app" = me (or someone with repo access) writing
TypeScript + React + relay code + running the deploy script. That's
the wrong shape for a platform — it makes slop-computer "a thing one
team builds for" instead of "a thing anyone can build for".

The pong build took 6 file edits in 5 different packages plus a
deploy. With the spectator-apps stack, the same pong becomes one
HTML file + one curl. The platform-iness compounds: every guest who
joins a show can leave an app behind. Every Claude Code session can
ship something. The desktop becomes a living artifact of who's been
in the room.

This is the Farcaster-Frames-shaped pivot for live video shows.
