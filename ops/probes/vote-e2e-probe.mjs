// vote-e2e-probe.mjs — real end-to-end check of the Voting Booth's Interfold
// E3 path against a RUNNING relay, using the public committee on whatever
// chain the box is configured for (VOTING_E3_CHAIN). Written for the
// 2026-09-14 pre-show audit; it caught the approve→request nonce race the
// same day.
//
// Run ON the relay box (it reads the relay .env for the session secret and
// needs `ws` from the relay's node_modules):
//
//   cd /home/ubuntu/slop-computer-live/packages/relay
//   node ../../ops/probes/vote-e2e-probe.mjs
//
// What it does: forges a debug-room cookie → mints an anonymous session →
// opens the signal WS as a peer → vote_create → waits for the E3 to reach
// `open` → fetches the committee key → encrypts a one-hot ballot for option 3
// with the same wasm the browser worker uses → vote_cast → waits for the
// committee to decrypt → asserts tally[2] === 1 → vote_remove. Costs one E3
// fee (~258 USDS on mainnet) + a few mainnet txs from the facilitator key.
//
// Exit codes: 0 pass · 3 timeout · 4 no hello · 8 E3 disabled · 9 cast
// rejected · 10 wrong tally · 11 E3 failed (message + last log lines printed).
import WebSocket from "ws";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RELAY = "http://127.0.0.1:8081";
const SLUG = "debug";
const env = Object.fromEntries(readFileSync("/home/ubuntu/slop-computer-live/packages/relay/.env", "utf8").split("\n").filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const secret = env.SIWE_SESSION_SECRET;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const payload = Buffer.from(JSON.stringify({ slug: SLUG, iat: Date.now() }), "utf8").toString("base64url");
const roomCookie = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;

const r = await fetch(`${RELAY}/auth/anon`, { method: "POST", headers: { cookie: `slop_room_${SLUG}=${roomCookie}` } });
const body = await r.json();
const setc = r.headers.get("set-cookie") ?? "";
const m = /slop_session=([^;]+)/.exec(setc);
if (!r.ok || !m) { log("anon auth failed", r.status, body); process.exit(2); }
log("anon session:", body.handle);
const cookie = `slop_session=${m[1]}; slop_room_${SLUG}=${roomCookie}`;

const FHE = "/home/ubuntu/slop-computer-live/packages/nextjs/public/fhe-wasm";
const fhe = await import(pathToFileURL(`${FHE}/fhe_wasm.js`).href);
await fhe.default(readFileSync(`${FHE}/fhe_wasm_bg.wasm`));
const params = fhe.load_params_named("INSECURE_THRESHOLD_512");
log("fhe wasm loaded");

const QUESTION = `e2e probe ${new Date().toISOString().slice(0, 16)} — which slop app is best?`;
const OPTIONS = ["Bank", "Poker", "Voting Booth"];
const ws = new WebSocket(`ws://127.0.0.1:8081/signal?slug=${SLUG}`, { headers: { cookie, origin: "https://live.slop.computer" } });
let pollId = null, lastStage = null, cast = false, done = false, hello = false;
const deadline = setTimeout(() => { log("TIMEOUT waiting for reveal"); finish(3); }, 16 * 60 * 1000);
function finish(code) { if (done) return; done = true; clearTimeout(deadline); if (pollId) ws.send(JSON.stringify({ type: "vote_remove", pollId })); setTimeout(() => { ws.close(); process.exit(code); }, 1500); }
setTimeout(() => { if (!hello) { log("no hello within 8s — protocol mismatch?"); finish(4); } }, 8000);

ws.on("open", () => log("ws open"));
ws.on("error", e => { log("ws error", e.message); finish(5); });
ws.on("close", (c, r) => { if (!done) { log("ws closed", c, String(r)); finish(6); } });
ws.on("message", raw => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === "error") { log("relay error:", msg.error); if (!pollId) finish(7); return; }
  if (msg.type === "hello") {
    hello = true;
    log("hello — votingE3:", msg.votingE3, "chain:", msg.votingE3Chain, "polls in room:", (msg.voting ?? []).length);
    if (!msg.votingE3) { log("E3 disabled on this box"); return finish(8); }
    ws.send(JSON.stringify({ type: "vote_create", question: QUESTION, options: OPTIONS }));
    log("sent vote_create");
    return;
  }
  if (msg.type === "vote_pubkey" && msg.pollId === pollId && !cast) {
    const pk = Buffer.from(msg.pubKey, "base64");
    const ct = fhe.encrypt_vector(params, new Uint8Array(pk), Int32Array.from([0, 0, 1]));
    cast = true;
    ws.send(JSON.stringify({ type: "vote_cast", pollId, ct: Buffer.from(ct).toString("base64") }));
    log(`pubkey ${pk.length} B → ballot ${ct.length} B cast (option 3)`);
    return;
  }
  if (msg.type === "vote_cast_ack") { log("cast ack:", msg.result); if (msg.result !== "ok") finish(9); return; }
  if (msg.type === "voting") {
    const poll = (msg.polls ?? []).find(p => p.question === QUESTION);
    if (!poll) return;
    if (!pollId) { pollId = poll.id; log("poll id", pollId, "mode", poll.mode); }
    const st = `${poll.status}/${poll.e3?.stage}`;
    if (st !== lastStage) {
      lastStage = st;
      const last = poll.e3?.log?.slice(-1)[0];
      log(`stage ${st} — ${poll.e3?.message ?? ""}${last?.txHash ? ` tx=${last.txHash}` : ""}`);
      if (poll.e3?.stage === "open" && !cast) { ws.send(JSON.stringify({ type: "vote_pubkey", pollId })); log("requested pubkey; window", poll.e3.windowStart, "→", poll.e3.windowEnd); }
      if (poll.e3?.stage === "revealed") { log("TALLY", JSON.stringify(poll.tally), "outputTx", poll.e3.outputTx, "requestTx", poll.e3.requestTx, "ballotTxs", JSON.stringify(poll.e3.ballotTxs)); log("committee", JSON.stringify(poll.e3.committee)); finish(poll.tally?.[2] === 1 ? 0 : 10); }
      if (poll.e3?.stage === "failed") { log("FAILED:", poll.e3.error, JSON.stringify(poll.e3.log.slice(-4))); finish(11); }
    }
  }
});
