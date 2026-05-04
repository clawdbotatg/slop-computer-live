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
//   { type: "publish", streamId, kind, label }                // I'm publishing this stream
//   { type: "unpublish", streamId }                            // I stopped publishing
//   { type: "slot_update", id, x, y, width, height, z }        // host-only: persist position
//   { type: "ping" }
// Server → client:
//   { type: "hello", id, peers, publications, slots }
//   { type: "peer_join" | "peer_leave", peer }
//   { type: "signal", from, kind, payload }
//   { type: "cursor", from, x, y }
//   { type: "published", publication }
//   { type: "unpublished", peerId, streamId }
//   { type: "slot", slot }                                     // host moved a slot
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
        case "publish": {
          if (
            typeof msg.streamId !== "string" ||
            (msg.kind !== "camera" && msg.kind !== "screen") ||
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
          if (!isHostInfo(info)) {
            return send(socket, { type: "error", error: "not_host" });
          }
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
