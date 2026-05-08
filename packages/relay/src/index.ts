import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { config } from "./config.js";
import {
  type Publication,
  type SlotKind,
  type SlotPosition,
  applySlotUpdate,
  clearPeerPublications,
  getSlots,
  listPublications,
  publish as publishStream,
  unpublish as unpublishStream,
} from "./desktop.js";
import {
  closeBrowser as closeSharedBrowser,
  listBrowsers,
  navigateBrowser as navigateSharedBrowser,
  openBrowser as openSharedBrowser,
} from "./browsers.js";
import { isKnownFanoutId, listFanouts, shutdownAllFanouts, startFanout, stopFanout } from "./fanout.js";
import { addPeer, broadcast, findPeersBySessionToken, kickById, listPeers, removePeer, send, sendTo } from "./peers.js";
import {
  SESSION_COOKIE,
  consumeNonce,
  createAgentSession,
  createSession,
  deleteSession,
  getSession,
  issueNonce,
} from "./sessions.js";
import { isAdminAddress, verifySiwe } from "./siwe.js";

const PRIMARY_HOST_ADDR = config.adminAddresses[0] ?? null;

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 16 * 1024,
});

// Image uploads on /v1/avatars come in as raw image/* bytes — register a
// passthrough parser so Fastify gives us the Buffer instead of trying to
// parse JSON. Per-route bodyLimit overrides the global 16KB cap.
app.addContentTypeParser(/^image\/(jpeg|png|webp)$/, { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

await app.register(cors, {
  origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
  credentials: true,
});
await app.register(cookie, { secret: config.sessionSecret });
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  service: "slop-relay",
  peers: listPeers().length,
}));

// --- Apps registry ----------------------------------------------------------
// JSON-driven desktop app catalog. Edit /var/lib/slop-relay/apps.json on the
// box and the next page load picks it up — no rebuild, no restart. Schema:
//   { "apps": [{ "id", "label", "icon", "url" }] }
//
// `icon` can be a relative path (served by Next.js, e.g. "/icons/foo.png")
// or an absolute URL. `url` is what the SharedBrowser will load when the
// icon is double-clicked.

import { readFileSync as _readFileSync, readdirSync as _readdirSync } from "node:fs";
import { mkdir as _mkdir, writeFile as _writeFile } from "node:fs/promises";
import { dirname as _dirname, resolve as _resolve } from "node:path";

const APPS_PATH = process.env.APPS_PATH ?? "/var/lib/slop-relay/apps.json";

type AppEntry = { id: string; label: string; icon: string; url: string };

const DEFAULT_APPS: AppEntry[] = [
  {
    id: "browser",
    label: "Browser",
    icon: "/icons/browser.png",
    url: "https://clawd-slop-landing-nextjs.vercel.app/",
  },
];

function readApps(): AppEntry[] {
  try {
    const raw = _readFileSync(APPS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { apps?: unknown };
    return Array.isArray(parsed.apps) ? (parsed.apps as AppEntry[]) : DEFAULT_APPS;
  } catch {
    return DEFAULT_APPS;
  }
}

async function writeApps(apps: AppEntry[]): Promise<void> {
  await _mkdir(_dirname(APPS_PATH), { recursive: true });
  await _writeFile(APPS_PATH, JSON.stringify({ apps }, null, 2));
}

app.get("/apps", async (_req, reply) => {
  // Re-read on every request so editing the file on the host is instant.
  reply.header("cache-control", "no-store");
  return { apps: readApps() };
});

// =============================================================================
// /v1/* — Agent API
// -----------------------------------------------------------------------------
// Authenticated session cookie OR `Authorization: Bearer <agent-token>`.
// Lets a participant's local LLM (Claude Code, local Llama, anything that
// can curl) read state and mutate the shared desktop the same way the
// real-time WS clients can. Agent tokens are minted via /v1/agent-token,
// scoped to the same identity as the requester's session, valid 7 days.
// =============================================================================

type V1Auth = { session: import("./sessions.js").Session; isHost: boolean };

function v1AuthFromReq(req: {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
}): V1Auth | null {
  // Bearer first, cookie fallback.
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const tok = authHeader.slice(7).trim();
    const s = getSession(tok);
    if (s) return { session: s, isHost: s.role === "host" && !!s.address && isAdminAddress(s.address) };
  }
  const cookieTok = req.cookies[SESSION_COOKIE];
  const s = getSession(cookieTok);
  if (!s) return null;
  return { session: s, isHost: s.role === "host" && !!s.address && isAdminAddress(s.address) };
}

const ICONS_DIR = process.env.ICONS_DIR ?? _resolve(process.cwd(), "../nextjs/public/icons");

// --- Auth: mint agent token + skill file ------------------------------------

app.get("/v1/agent-token", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const agent = createAgentSession(a.session);
  return {
    token: agent.token,
    expiresAt: agent.expiresAt,
    scope: a.isHost ? "host" : "peer",
    identity: { address: agent.address, handle: agent.handle, role: agent.role },
  };
});

// --- Read: full state snapshot ----------------------------------------------

app.get("/v1/state", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return {
    you: {
      address: a.session.address,
      handle: a.session.handle,
      role: a.session.role,
      isHost: a.isHost,
    },
    peers: listPeers(),
    publications: listPublications(),
    slots: getSlots(PRIMARY_HOST_ADDR),
    browsers: listBrowsers(PRIMARY_HOST_ADDR),
    apps: readApps(),
    avatars: listAvatarsSync(),
  };
});

// --- Read: list available icon PNGs -----------------------------------------

app.get("/v1/icons", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  try {
    const entries = _readdirSync(ICONS_DIR, { withFileTypes: true });
    const icons = entries
      .filter(e => e.isFile() && /\.(png|svg|jpg|jpeg|webp)$/i.test(e.name))
      .map(e => ({ name: e.name, url: `/icons/${e.name}` }));
    return { icons };
  } catch (err) {
    return reply.code(500).send({ error: "icons-dir-unreadable", path: ICONS_DIR });
  }
});

// --- Apps: host-only mutators -----------------------------------------------

type AppBody = { id?: unknown; label?: unknown; icon?: unknown; url?: unknown };

app.post<{ Body: AppBody }>("/v1/apps", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!a.isHost) return reply.code(403).send({ error: "host-only" });
  const body = (req.body ?? {}) as AppBody;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const label = typeof body.label === "string" ? body.label : "";
  const icon = typeof body.icon === "string" ? body.icon : "";
  const url = typeof body.url === "string" ? body.url : "";
  if (!id || !label || !icon || !url) {
    return reply.code(400).send({ error: "missing-fields", required: ["id", "label", "icon", "url"] });
  }
  if (!/^[a-z0-9-]{1,40}$/.test(id)) {
    return reply.code(400).send({ error: "bad-id", note: "lowercase letters, digits, dashes, 1-40 chars" });
  }
  const apps = readApps();
  const idx = apps.findIndex(a => a.id === id);
  const next: AppEntry = { id, label, icon, url };
  if (idx >= 0) apps[idx] = next;
  else apps.push(next);
  await writeApps(apps);
  return { ok: true, app: next, total: apps.length };
});

app.delete<{ Params: { id: string } }>("/v1/apps/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!a.isHost) return reply.code(403).send({ error: "host-only" });
  const apps = readApps();
  const next = apps.filter(a => a.id !== req.params.id);
  if (next.length === apps.length) return reply.code(404).send({ error: "no-such-app" });
  await writeApps(next);
  return { ok: true, removed: req.params.id, total: next.length };
});

// --- Slots: any authenticated peer can rearrange the shared layout ----------

type SlotBody = { id?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; z?: unknown };

app.post<{ Body: SlotBody }>("/v1/slots", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const body = (req.body ?? {}) as SlotBody;
  if (typeof body.id !== "string") return reply.code(400).send({ error: "missing-id" });
  const patch: Partial<SlotPosition> & { id: string } = { id: body.id };
  for (const key of ["x", "y", "width", "height", "z"] as const) {
    if (typeof body[key] === "number") (patch as Record<string, unknown>)[key] = body[key];
  }
  const merged = applySlotUpdate(PRIMARY_HOST_ADDR, patch);
  if (!merged) return reply.code(500).send({ error: "no-host-configured" });
  // Broadcast to live WS peers so they see the move in real time, same
  // as the existing slot_update WS handler.
  broadcast({ type: "slot", slot: merged });
  return { ok: true, slot: merged };
});

// --- Browsers: open / navigate / close --------------------------------------

type OpenBrowserBody = { id?: unknown; url?: unknown };

app.post<{ Body: OpenBrowserBody }>("/v1/browsers", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const body = (req.body ?? {}) as OpenBrowserBody;
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return reply.code(400).send({ error: "missing-url" });
  const id =
    typeof body.id === "string" && body.id.trim() ? body.id.trim() : `browser-${Math.random().toString(36).slice(2, 8)}`;
  const browser = openSharedBrowser(PRIMARY_HOST_ADDR, id, url, "agent");
  broadcast({ type: "browser", browser });
  return { ok: true, browser };
});

type NavBody = { url?: unknown };

app.post<{ Params: { id: string }; Body: NavBody }>("/v1/browsers/:id/navigate", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!url) return reply.code(400).send({ error: "missing-url" });
  const browser = navigateSharedBrowser(PRIMARY_HOST_ADDR, req.params.id, url);
  if (!browser) return reply.code(404).send({ error: "no-such-browser" });
  broadcast({ type: "browser", browser });
  return { ok: true, browser };
});

app.delete<{ Params: { id: string } }>("/v1/browsers/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const ok = closeSharedBrowser(PRIMARY_HOST_ADDR, req.params.id);
  if (!ok) return reply.code(404).send({ error: "no-such-browser" });
  broadcast({ type: "browser_closed", id: req.params.id });
  return { ok: true };
});

// --- Cursor + click: agent presence -----------------------------------------
// Lets an agent show up on the desktop the way a human does. Cursor moves
// emit `cursor` messages keyed by a stable agent peer id; clicks emit a
// `click` (which produces a colored ripple). Both include the session's
// address/handle inline so the frontend can label + color them with the
// user's blockie palette without needing a synthetic peer entry.

function agentPeerId(token: string): string {
  // Stable per-agent-token id — different LLMs the same human uses get
  // distinct cursors/ripples. 12 chars is enough to avoid collisions.
  return `agent-${token.slice(0, 12)}`;
}

type XYBody = { x?: unknown; y?: unknown };

app.post<{ Body: XYBody }>("/v1/cursor", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return reply.code(400).send({ error: "missing-coords" });
  broadcast({
    type: "cursor",
    from: agentPeerId(a.session.token),
    address: a.session.address,
    handle: a.session.handle,
    x,
    y,
  });
  return { ok: true };
});

app.post<{ Body: XYBody }>("/v1/click", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return reply.code(400).send({ error: "missing-coords" });
  broadcast({
    type: "click",
    from: agentPeerId(a.session.token),
    address: a.session.address,
    handle: a.session.handle,
    x,
    y,
  });
  return { ok: true };
});

// --- Skill file: a markdown the user can drop into a local AI ---------------

app.get<{ Querystring: { token?: string } }>("/v1/skill", async (req, reply) => {
  // The user-flow we optimize for: copy the skill URL, paste it into a
  // local agent, agent fetches it and is ready to go. So `?token=` here
  // doubles as both the embedded token in the markdown AND the auth for
  // this very request. Cookie/bearer still work too.
  let auth: V1Auth | null = null;
  const queryToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (queryToken) {
    const s = getSession(queryToken);
    if (s) {
      auth = { session: s, isHost: s.role === "host" && !!s.address && isAdminAddress(s.address) };
    }
  }
  if (!auth) auth = v1AuthFromReq(req);
  if (!auth) return reply.code(401).send({ error: "unauthenticated" });
  // Use the URL token verbatim if it was used for auth — that's what the
  // agent now holds. Otherwise mint a fresh one for curl-only callers.
  const token = queryToken && auth.session.token === queryToken ? queryToken : createAgentSession(auth.session).token;
  reply.header("content-type", "text/markdown; charset=utf-8");
  reply.header("cache-control", "no-store");
  return skillMarkdown(token, auth.isHost);
});

// =============================================================================
// Avatars
// -----------------------------------------------------------------------------
// Per-user avatar images. Stored on disk keyed by lowercased address (SIWE
// users) or slugified handle (password users). Re-upload overwrites — no
// way for one user to fill the disk. Caps at 600KB on the wire (the
// frontend downscales to ~300KB before uploading).
//
// On every successful upload we broadcast `{type:"avatar", ownerKey, url}`
// so all peers update their UI immediately. The hello message also
// includes the current set so a fresh tab gets everyone's avatars at once.
// =============================================================================

const AVATARS_DIR = process.env.AVATARS_DIR ?? "/var/lib/slop-relay/avatars";
const AVATAR_PUBLIC_BASE = process.env.AVATAR_PUBLIC_BASE ?? "https://relay.slop.computer/avatars";
const AVATAR_MAX_BYTES = 600 * 1024;
const AVATAR_EXTS = ["jpg", "jpeg", "png", "webp"] as const;

type AvatarOwnerKey = string;

function ownerKeyFromSession(s: { address: string | null; handle: string | null }): AvatarOwnerKey | null {
  if (s.address) return s.address.toLowerCase();
  if (s.handle) {
    const slug = s.handle.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32);
    return slug ? `h_${slug}` : null;
  }
  return null;
}

function avatarPublicUrl(filename: string, version: number): string {
  return `${AVATAR_PUBLIC_BASE}/${filename}?v=${version}`;
}

import { statSync as _statSync, readdirSync as _readdirSyncRaw, unlinkSync as _unlinkSync } from "node:fs";

function listAvatarsSync(): Record<AvatarOwnerKey, string> {
  const out: Record<string, string> = {};
  let files: string[];
  try {
    files = _readdirSyncRaw(AVATARS_DIR);
  } catch {
    return out;
  }
  for (const f of files) {
    const m = f.match(/^(.+)\.(jpg|jpeg|png|webp)$/i);
    if (!m) continue;
    const key = m[1]!;
    let mtime = 0;
    try {
      mtime = _statSync(`${AVATARS_DIR}/${f}`).mtimeMs | 0;
    } catch {
      /* ignore */
    }
    out[key] = avatarPublicUrl(f, mtime);
  }
  return out;
}

app.post(
  "/v1/avatars",
  { bodyLimit: AVATAR_MAX_BYTES },
  async (req, reply) => {
    const a = v1AuthFromReq(req);
    if (!a) return reply.code(401).send({ error: "unauthenticated" });
    const key = ownerKeyFromSession(a.session);
    if (!key) return reply.code(400).send({ error: "no-identity-on-session" });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "empty-body", note: "send raw image bytes with image/jpeg, image/png, or image/webp" });
    }
    if (body.length > AVATAR_MAX_BYTES) return reply.code(413).send({ error: "too-large" });

    const ct = String(req.headers["content-type"] ?? "");
    const ext: (typeof AVATAR_EXTS)[number] =
      ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";

    await _mkdir(AVATARS_DIR, { recursive: true });
    // Wipe any previous avatar for this key (different extension is OK).
    try {
      const existing = _readdirSyncRaw(AVATARS_DIR);
      for (const f of existing) {
        if (f.startsWith(`${key}.`)) _unlinkSync(`${AVATARS_DIR}/${f}`);
      }
    } catch {
      /* ignore */
    }

    const filename = `${key}.${ext}`;
    await _writeFile(`${AVATARS_DIR}/${filename}`, body);

    const url = avatarPublicUrl(filename, Date.now());
    broadcast({ type: "avatar", ownerKey: key, url });
    return { ok: true, url, key };
  },
);

app.get<{ Params: { filename: string } }>("/avatars/:filename", async (req, reply) => {
  const filename = req.params.filename;
  // Defense-in-depth: only serve files matching the strict shape we write.
  if (!/^[a-z0-9_.-]+\.(jpg|jpeg|png|webp)$/i.test(filename) || filename.includes("..")) {
    return reply.code(400).send({ error: "bad-name" });
  }
  let buf: Buffer;
  try {
    const fs = await import("node:fs/promises");
    buf = await fs.readFile(`${AVATARS_DIR}/${filename}`);
  } catch {
    return reply.code(404).send({ error: "not-found" });
  }
  const ext = filename.split(".").pop()!.toLowerCase();
  const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  reply.header("content-type", ct);
  reply.header("cache-control", "public, max-age=300");
  return reply.send(buf);
});

function skillMarkdown(token: string, isHost: boolean): string {
  const base = "https://relay.slop.computer";
  const auth = `Authorization: Bearer ${token}`;
  const scope = isHost ? "host" : "peer";
  const hostOnlyNote = isHost
    ? ""
    : "\n> ⚠ The endpoints below marked **host-only** require host scope. Yours is **peer** — those calls return 403. Ask the host to do them, or include them in plans you suggest.";
  return `# slop-computer-live agent

You are an agent participating in a live multi-user desktop session at
\`live.slop.computer\`. The relay exposes a small REST API you can use to
**read state** (peers, slots, browsers, apps), **mutate the desktop**
(open browsers, move windows, add/remove apps), and **show presence**
(cursors, clicks) — the same way the live web clients do.

## Auth

Every request needs:

\`\`\`
${auth}
\`\`\`

This token is yours, scoped \`${scope}\`, valid for 7 days. Don't paste it
into shared chats.${hostOnlyNote}

## Endpoints

### Read (any scope)

- \`GET ${base}/v1/state\` — full snapshot: \`{ you, peers, publications, slots, browsers, apps }\`.
- \`GET ${base}/v1/icons\` — \`{ icons: [{ name, url }] }\` available to use as app/icon paths.
- \`GET ${base}/v1/apps\` — current app catalog.

### Move / resize a window (any scope)

\`\`\`
POST ${base}/v1/slots
{ "id": "browser-abc123", "x": 200, "y": 80, "width": 800, "height": 610 }
\`\`\`

Slot ids look like \`browser-<hex>\`, \`icon-<appId>\`, or \`owner-<addr>-camera\`.

### Open / navigate / close a browser (any scope)

\`\`\`
POST ${base}/v1/browsers          { "url": "https://app.ens.domains" }
POST ${base}/v1/browsers/:id/navigate { "url": "https://uniswap.org" }
DELETE ${base}/v1/browsers/:id
\`\`\`

The headless Chrome impersonates \`vitalik.eth\` automatically — captured
\`eth_sendTransaction\` payloads land in every peer's tx panel.

### Cursor + click presence (any scope)

\`\`\`
POST ${base}/v1/cursor   { "x": 800, "y": 400 }
POST ${base}/v1/click    { "x": 800, "y": 400 }
\`\`\`

Cursor positions persist on every peer's screen labelled with your
identity; clicks render a colored ripple in your blockie's palette.
Use these to "be present" — point at things, react, draw attention.
Don't spam: < 30 cursor msgs/sec is plenty.

### Apps registry (host-only)

\`\`\`
POST ${base}/v1/apps      { "id": "ens", "label": "ENS", "icon": "/icons/ens.png", "url": "https://app.ens.domains" }
DELETE ${base}/v1/apps/:id
\`\`\`

Persists to \`apps.json\` on the relay. New page loads see the new icon.
\`icon\` can be a relative path served by Next.js (call \`GET /v1/icons\`
to list options) or any absolute https URL.

## Recipes

**See who's connected and what's open:**

\`\`\`bash
curl -s -H "${auth}" ${base}/v1/state | jq '{peers,browsers,apps,you}'
\`\`\`

**Open a dapp in the shared browser:**

\`\`\`bash
curl -s -X POST -H "${auth}" -H "content-type: application/json" \\
  ${base}/v1/browsers -d '{"url":"https://app.aave.com"}'
\`\`\`

**Tile two browser windows side-by-side:**

\`\`\`bash
# get the browser ids from /v1/state, then:
curl -s -X POST -H "${auth}" -H "content-type: application/json" \\
  ${base}/v1/slots -d '{"id":"browser-abc","x":40,"y":80,"width":600,"height":600}'
curl -s -X POST -H "${auth}" -H "content-type: application/json" \\
  ${base}/v1/slots -d '{"id":"browser-def","x":660,"y":80,"width":600,"height":600}'
\`\`\`

**Wave at the room (3 click ripples in a row):**

\`\`\`bash
for i in 700 800 900; do
  curl -s -X POST -H "${auth}" -H "content-type: application/json" \\
    ${base}/v1/click -d "{\\"x\\":\$i,\\"y\\":400}"
  sleep 0.2
done
\`\`\`

**Add an app (host-only):**

\`\`\`bash
# 1. see what icons are available
curl -s -H "${auth}" ${base}/v1/icons | jq '.icons[].name'
# 2. add the entry
curl -s -X POST -H "${auth}" -H "content-type: application/json" \\
  ${base}/v1/apps -d '{
    "id": "ens",
    "label": "ENS",
    "icon": "/icons/ens.png",
    "url": "https://app.ens.domains"
  }'
\`\`\`

## Conventions

- 200/2xx = success. 400 = bad input. 401 = bad/expired token.
  403 = host-only endpoint, you have peer scope. 404 = id doesn't exist.
  500 = relay misconfig.
- Mutations broadcast to live WS peers; everyone sees your change in
  real time. There is no undo — be intentional.
- Don't poll \`/v1/state\` faster than once a second. For real-time you'd
  use the WS at \`wss://relay.slop.computer/signal\`, but that's out of
  scope for this skill.
- Cursor coordinates are viewport pixels at the host's resolution
  (~1440×900 typical). Stay inside the screen.
`;
}

// --- SIWE auth --------------------------------------------------------------

app.get("/auth/siwe/nonce", async () => ({ nonce: issueNonce() }));

type SiweBody = { message?: unknown; signature?: unknown; nonce?: unknown };

app.post<{ Body: SiweBody }>("/auth/siwe", async (req, reply) => {
  const body = (req.body ?? {}) as SiweBody;
  const message = typeof body.message === "string" ? body.message : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!message || !/^0x[0-9a-fA-F]+$/.test(signature) || !nonce) {
    return reply.code(400).send({ error: "Missing message, signature, or nonce" });
  }
  if (!consumeNonce(nonce)) return reply.code(401).send({ error: "Bad or expired nonce" });
  const check = await verifySiwe({ message, signature: signature as `0x${string}`, expectedNonce: nonce });
  if (!check.ok) return reply.code(401).send({ error: check.error });
  const session = createSession({
    role: check.isAdmin ? "host" : "guest",
    address: check.address,
    handle: null,
  });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: session.role, address: session.address, isAdmin: check.isAdmin };
});

// --- Password auth (guest) --------------------------------------------------

type PasswordBody = { password?: unknown; handle?: unknown };

app.post<{ Body: PasswordBody }>("/auth/password", async (req, reply) => {
  const body = (req.body ?? {}) as PasswordBody;
  const password = typeof body.password === "string" ? body.password : "";
  const handle = typeof body.handle === "string" ? body.handle.trim().slice(0, 32) : "";
  if (!config.guestPassword) {
    return reply.code(503).send({ error: "Guest password not configured on relay" });
  }
  if (password !== config.guestPassword) {
    return reply.code(401).send({ error: "Bad password" });
  }
  if (!handle) return reply.code(400).send({ error: "Handle required" });
  const session = createSession({ role: "guest", address: null, handle });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: "guest", handle };
});

app.post("/auth/logout", async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) deleteSession(token);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

app.get("/auth/me", async req => {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return { authenticated: false };
  return {
    authenticated: true,
    role: session.role,
    address: session.address,
    handle: session.handle,
    isAdmin: session.role === "host" && !!session.address && isAdminAddress(session.address),
  };
});

// --- TURN credentials (HMAC, RFC 5766 ephemeral) ----------------------------
// Issues a short-lived {username, credential, urls} pair for the WebRTC ICE
// agent. Username is "<expiry-unix-seconds>:<random>", credential is
// base64(HMAC-SHA1(turnSecret, username)). The TURN server validates the same
// way using its `static-auth-secret`.
app.get("/turn/credentials", async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return reply.code(401).send({ error: "Unauthenticated" });
  if (!config.turnSecret || !config.turnHost) {
    return reply.code(503).send({ error: "TURN not configured" });
  }
  const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSeconds;
  const id = randomBytes(4).toString("hex");
  const username = `${expiry}:${id}`;
  const credential = createHmac("sha1", config.turnSecret).update(username).digest("base64");
  return {
    username,
    credential,
    ttl: config.turnTtlSeconds,
    urls: [
      `stun:${config.turnHost}:3478`,
      `turn:${config.turnHost}:3478?transport=udp`,
      `turn:${config.turnHost}:3478?transport=tcp`,
    ],
  };
});

app.get("/peers", async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return reply.code(401).send({ error: "Unauthenticated" });
  return { peers: listPeers() };
});

// --- Admin host-only --------------------------------------------------------

function requireHost(req: { cookies: Record<string, string | undefined> }):
  | { ok: true; address: string }
  | { ok: false; error: string } {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return { ok: false, error: "Unauthenticated" };
  if (session.role !== "host" || !session.address || !isAdminAddress(session.address)) {
    return { ok: false, error: "Not authorized as host" };
  }
  return { ok: true, address: session.address };
}

app.post("/admin/start", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  // OBS only takes two fields — Server URL and Stream Key. We collapse the
  // MediaMTX publish credentials into the stream key as a query string so
  // the secret is in ONE place, not split across visible fields. Final URL
  // OBS publishes to: rtmp://host:port/live?user=...&pass=...
  const u = config.mediamtxPublishUser;
  const p = config.mediamtxPublishPass;
  const streamKey = `live?user=${encodeURIComponent(u)}&pass=${encodeURIComponent(p)}`;
  return {
    ok: true,
    rtmpUrl: config.mediamtxRtmpIngress,
    streamKey,
    hlsUrl: config.hlsUrl,
  };
});

app.post("/admin/stop", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { ok: true };
});

app.get("/admin/peers", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { peers: listPeers() };
});

type KickBody = { id?: unknown };

// --- Fanout (server-side restream to YouTube/Twitch/X/Kick) -----------------
app.get("/admin/fanouts", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { fanouts: listFanouts() };
});

app.post<{ Params: { id: string } }>("/admin/fanouts/:id/start", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const id = req.params.id;
  if (!isKnownFanoutId(id)) return reply.code(400).send({ error: "Unknown destination" });
  const result = startFanout(id, line => app.log.info(line));
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return { ok: true, fanouts: listFanouts() };
});

app.post<{ Params: { id: string } }>("/admin/fanouts/:id/stop", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const id = req.params.id;
  if (!isKnownFanoutId(id)) return reply.code(400).send({ error: "Unknown destination" });
  const result = stopFanout(id);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return { ok: true, fanouts: listFanouts() };
});

// --- Browser-host tx ingress -----------------------------------------------
// The browser-host POSTs captured wallet calls here so all WS-connected peers
// see them in their tx panels. Authenticated by a shared bearer secret —
// keeps random clients from injecting fake tx_request messages.
type BrowserTxBody = { browserId?: unknown; payload?: unknown };
app.post<{ Body: BrowserTxBody }>("/internal/browser-tx", async (req, reply) => {
  const expected = process.env.BROWSER_HOST_INGRESS_SECRET;
  if (!expected) return reply.code(503).send({ error: "ingress not configured" });
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${expected}`) return reply.code(401).send({ error: "bad token" });
  const body = (req.body ?? {}) as BrowserTxBody;
  if (typeof body.browserId !== "string") return reply.code(400).send({ error: "missing browserId" });
  const payload = (body.payload ?? {}) as { method?: unknown; params?: unknown };
  const method = typeof payload.method === "string" ? payload.method : "";
  const params = Array.isArray(payload.params) ? payload.params : [];
  // Pull `to`, `value`, calldata out of the first eth_sendTransaction param,
  // best-effort — other write methods (personal_sign / signTypedData) just
  // get the raw payload back as calldata.
  let to: string | null = null;
  let value: string | null = null;
  let calldata = "";
  if (method === "eth_sendTransaction" && params[0] && typeof params[0] === "object") {
    const tx = params[0] as { to?: unknown; value?: unknown; data?: unknown };
    to = typeof tx.to === "string" ? tx.to : null;
    value = typeof tx.value === "string" ? tx.value : null;
    calldata = typeof tx.data === "string" ? tx.data : JSON.stringify(tx);
  } else {
    calldata = JSON.stringify({ method, params });
  }
  broadcast({
    type: "tx_request",
    from: "browser-host",
    browserId: body.browserId,
    calldata,
    to,
    value,
    chainId: null,
  });
  return { ok: true };
});

app.post<{ Body: KickBody }>("/admin/kick", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const body = (req.body ?? {}) as KickBody;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return reply.code(400).send({ error: "Missing id" });
  const ok = kickById(id);
  if (!ok) return reply.code(404).send({ error: "Peer not found" });
  return { ok: true };
});

// --- WS /signal -------------------------------------------------------------
// Client → server:
//   { type: "offer"|"answer"|"ice", to: <peerId>, payload }
//   { type: "cursor", x, y }                                  // broadcast
//   { type: "click", x, y }                                    // ripple broadcast (incl. sender)
//   { type: "publish", streamId, kind, label }                // I'm publishing this stream
//   { type: "unpublish", streamId }                            // I stopped publishing
//   { type: "slot_update", id, x, y, width, height, z }        // any auth'd peer; last write wins
//   { type: "browser_open", id, url }                          // any peer; spawns a shared browser
//   { type: "browser_navigate", id, url }                      // any peer; sets URL of an existing browser
//   { type: "browser_close", id }                              // any peer; closes a shared browser
//   { type: "tx_request", browserId, calldata, to, value, chainId }  // captured impersonator tx
//   { type: "ping" }
// Server → client:
//   { type: "hello", id, peers, publications, slots, browsers }
//   { type: "peer_join" | "peer_leave", peer }
//   { type: "signal", from, kind, payload }
//   { type: "cursor", from, x, y }
//   { type: "published", publication }
//   { type: "unpublished", peerId, streamId }
//   { type: "slot", slot }                                     // host moved a slot
//   { type: "browser", browser }                               // browser opened or navigated
//   { type: "browser_closed", id }
//   { type: "tx_request", from, browserId, calldata, to, value, chainId }
//   { type: "pong" }
//   { type: "error", error }

const isHostInfo = (info: { role: string; address: string | null }) =>
  info.role === "host" && !!info.address && isAdminAddress(info.address);

app.register(async function signalRoutes(fastify) {
  fastify.get("/signal", { websocket: true }, (socket, req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = getSession(token);
    if (!session) {
      send(socket, { type: "error", error: "unauthenticated" });
      socket.close(4401, "unauthenticated");
      return;
    }

    const peerId = randomBytes(8).toString("hex");
    const info = {
      id: peerId,
      role: session.role,
      address: session.address,
      handle: session.handle,
      connectedAt: Date.now(),
    };

    // Dedupe by session token. If this same session already has a peer
    // (stale reconnect, duplicate tab) kick the old ones first so we
    // never end up with two of the same user publishing the same kind
    // — which renders as two windows stacked at the same slot.
    for (const stale of findPeersBySessionToken(session.token)) {
      const ended = clearPeerPublications(stale.id);
      removePeer(stale.id);
      for (const p of ended) {
        broadcast({ type: "unpublished", peerId: stale.id, streamId: p.streamId });
      }
      broadcast({
        type: "peer_leave",
        peer: { id: stale.id, role: stale.role, address: stale.address, handle: stale.handle, connectedAt: stale.connectedAt },
      });
      try {
        stale.ws.close(4409, "session-replaced");
      } catch {
        /* ignore */
      }
    }

    addPeer({ ...info, ws: socket, sessionToken: session.token });
    send(socket, {
      type: "hello",
      id: peerId,
      peers: listPeers().filter(p => p.id !== peerId),
      publications: listPublications(),
      slots: getSlots(PRIMARY_HOST_ADDR),
      browsers: listBrowsers(PRIMARY_HOST_ADDR),
      avatars: listAvatarsSync(),
    });
    broadcast({ type: "peer_join", peer: info }, peerId);

    socket.on("message", (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: "error", error: "invalid_json" });
      }
      switch (msg?.type) {
        case "hello":
          return;
        case "ping":
          send(socket, { type: "pong" });
          return;
        case "offer":
        case "answer":
        case "ice": {
          if (typeof msg.to !== "string") {
            return send(socket, { type: "error", error: "missing_to" });
          }
          const ok = sendTo(msg.to, {
            type: "signal",
            kind: msg.type,
            from: peerId,
            payload: msg.payload,
          });
          if (!ok) send(socket, { type: "error", error: "peer_not_found", to: msg.to });
          return;
        }
        case "cursor": {
          if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
          broadcast({ type: "cursor", from: peerId, x: msg.x, y: msg.y }, peerId);
          return;
        }
        case "click": {
          if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
          // Include the sender — the click ripple should appear on the
          // clicker's own screen at the same time it appears for everyone
          // else, otherwise click+ripple feel desynced.
          broadcast({ type: "click", from: peerId, x: msg.x, y: msg.y });
          return;
        }
        case "publish": {
          if (
            typeof msg.streamId !== "string" ||
            (msg.kind !== "camera" && msg.kind !== "screen" && msg.kind !== "audio") ||
            typeof msg.label !== "string"
          ) {
            return send(socket, { type: "error", error: "bad_publish" });
          }
          const ownerKey = (info.address ?? info.handle ?? peerId).toLowerCase();
          const pub: Publication = {
            streamId: msg.streamId,
            peerId,
            ownerKey,
            kind: msg.kind as SlotKind,
            label: msg.label,
          };
          publishStream(pub);
          broadcast({ type: "published", publication: pub });
          return;
        }
        case "unpublish": {
          if (typeof msg.streamId !== "string") {
            return send(socket, { type: "error", error: "missing_streamId" });
          }
          const ok = unpublishStream(peerId, msg.streamId);
          if (ok) broadcast({ type: "unpublished", peerId, streamId: msg.streamId });
          return;
        }
        case "slot_update": {
          // Any authenticated peer may rearrange the shared layout — same
          // model as a collaborative whiteboard. Last write wins.
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          const patch: Partial<SlotPosition> & { id: string } = { id: msg.id };
          for (const key of ["x", "y", "width", "height", "z"] as const) {
            if (typeof msg[key] === "number") (patch as any)[key] = msg[key];
          }
          const merged = applySlotUpdate(PRIMARY_HOST_ADDR, patch);
          if (!merged) return;
          broadcast({ type: "slot", slot: merged });
          return;
        }
        case "browser_open": {
          if (typeof msg.id !== "string" || typeof msg.url !== "string") {
            return send(socket, { type: "error", error: "bad_browser_open" });
          }
          const browser = openSharedBrowser(PRIMARY_HOST_ADDR, msg.id, msg.url, peerId);
          broadcast({ type: "browser", browser });
          return;
        }
        case "browser_navigate": {
          if (typeof msg.id !== "string" || typeof msg.url !== "string") {
            return send(socket, { type: "error", error: "bad_browser_navigate" });
          }
          const browser = navigateSharedBrowser(PRIMARY_HOST_ADDR, msg.id, msg.url);
          if (!browser) return;
          broadcast({ type: "browser", browser });
          return;
        }
        case "browser_close": {
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          const ok = closeSharedBrowser(PRIMARY_HOST_ADDR, msg.id);
          if (ok) broadcast({ type: "browser_closed", id: msg.id });
          return;
        }
        case "tx_request": {
          // Forward the captured impersonator tx to every peer so they all see
          // the same calldata. We don't validate or store — this is just a
          // shared notification surface.
          if (typeof msg.browserId !== "string" || typeof msg.calldata !== "string") {
            return send(socket, { type: "error", error: "bad_tx_request" });
          }
          broadcast({
            type: "tx_request",
            from: peerId,
            browserId: msg.browserId,
            calldata: msg.calldata,
            to: typeof msg.to === "string" ? msg.to : null,
            value: typeof msg.value === "string" ? msg.value : null,
            chainId: typeof msg.chainId === "number" ? msg.chainId : null,
          });
          return;
        }
        default:
          send(socket, { type: "error", error: "unknown_type" });
      }
    });

    socket.on("close", () => {
      const ended = clearPeerPublications(peerId);
      removePeer(peerId);
      for (const p of ended) {
        broadcast({ type: "unpublished", peerId, streamId: p.streamId });
      }
      broadcast({ type: "peer_leave", peer: info });
    });
  });
});

// --- Boot -------------------------------------------------------------------

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(
      `slop-relay listening on http://${config.host}:${config.port} — admins=${config.adminAddresses.length} guestPwd=${config.guestPassword ? "set" : "unset"}`,
    );
  })
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });

// Clean up restream children on shutdown so destinations see a clean
// "stream ended" rather than a network drop.
const cleanShutdown = (signal: NodeJS.Signals) => {
  app.log.info(`received ${signal} — stopping fanouts`);
  shutdownAllFanouts();
  app.close().finally(() => process.exit(0));
};
process.on("SIGTERM", cleanShutdown);
process.on("SIGINT", cleanShutdown);
