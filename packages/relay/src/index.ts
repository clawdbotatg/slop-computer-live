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
import { addPeer, broadcast, kickById, listPeers, removePeer, send, sendTo } from "./peers.js";
import { SESSION_COOKIE, consumeNonce, createSession, deleteSession, getSession, issueNonce } from "./sessions.js";
import { isAdminAddress, verifySiwe } from "./siwe.js";

const PRIMARY_HOST_ADDR = config.adminAddresses[0] ?? null;

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 16 * 1024,
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

import { readFileSync as _readFileSync } from "node:fs";

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

app.get("/apps", async (_req, reply) => {
  // Re-read on every request so editing the file on the host is instant.
  // Cheap (~ms) at the rates this gets hit.
  try {
    const raw = _readFileSync(APPS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { apps?: unknown };
    const apps = Array.isArray(parsed.apps) ? (parsed.apps as AppEntry[]) : DEFAULT_APPS;
    reply.header("cache-control", "no-store");
    return { apps };
  } catch {
    // Missing or malformed file → fall back to the built-in default. Keeps
    // dev environments and fresh installs working without setup.
    reply.header("cache-control", "no-store");
    return { apps: DEFAULT_APPS };
  }
});

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

    addPeer({ ...info, ws: socket, sessionToken: session.token });
    send(socket, {
      type: "hello",
      id: peerId,
      peers: listPeers().filter(p => p.id !== peerId),
      publications: listPublications(),
      slots: getSlots(PRIMARY_HOST_ADDR),
      browsers: listBrowsers(PRIMARY_HOST_ADDR),
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
