// Trace WebRTC negotiation to find what produces
//   "The order of m-lines in subsequent offer doesn't match ..."
//
// Instruments createOffer / createAnswer / setLocalDescription /
// setRemoteDescription on both peers: signalingState before+after, the
// m-line order of every SDP, and which side initiated. Two peers BOTH
// publish audio so negotiation runs in both directions.

import { chromium } from "playwright-core";
import { createHmac } from "node:crypto";

const NEXT = "http://localhost:3210";
const RELAY = "http://localhost:8180";
const SLUG = "debug";
const EXEC =
  process.env.HOME +
  "/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function roomCookie(slug, secret = "dev-secret-change-me") {
  const payload = Buffer.from(JSON.stringify({ slug, iat: Date.now() }), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function instrument() {
  const mk = () => {
    const c = new AudioContext();
    const o = c.createOscillator();
    const d = c.createMediaStreamDestination();
    o.connect(d);
    o.start();
    return d.stream;
  };
  navigator.mediaDevices.getUserMedia = async cs => {
    const s = new MediaStream();
    if (cs?.audio) for (const t of mk().getAudioTracks()) s.addTrack(t);
    if (cs?.video) {
      const cv = Object.assign(document.createElement("canvas"), { width: 320, height: 240 });
      const g = cv.getContext("2d");
      setInterval(() => {
        g.fillStyle = `hsl(${(Date.now() / 20) % 360},70%,50%)`;
        g.fillRect(0, 0, 320, 240);
      }, 66);
      for (const t of cv.captureStream(30).getVideoTracks()) s.addTrack(t);
    }
    return s;
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { deviceId: "mic-a", kind: "audioinput", label: "Probe Mic A", groupId: "g", toJSON() {} },
  ];
  localStorage.setItem("slop-has-been-here-v1", "1");

  // ---- negotiation trace ----
  const mlines = sdp =>
    (sdp || "")
      .split("\n")
      .filter(l => l.startsWith("m="))
      .map(l => l.trim().split(" ")[0].slice(2))
      .join(",");
  const mids = sdp =>
    (sdp || "")
      .split("\n")
      .filter(l => l.startsWith("a=mid:"))
      .map(l => l.trim().slice(6))
      .join(",");

  window.__trace = [];
  let pcSeq = 0;
  const tag = new WeakMap();
  const idOf = pc => {
    if (!tag.has(pc)) tag.set(pc, ++pcSeq);
    return tag.get(pc);
  };
  const push = row => window.__trace.push({ t: Date.now(), ...row });

  const OrigPC = window.RTCPeerConnection;
  const wrap = (name, fn, extract) =>
    async function (...args) {
      const before = this.signalingState;
      const pcId = idOf(this);
      try {
        const out = await fn.apply(this, args);
        push({
          op: name,
          pc: pcId,
          before,
          after: this.signalingState,
          ok: true,
          ...extract(args, out, this),
        });
        return out;
      } catch (err) {
        push({
          op: name,
          pc: pcId,
          before,
          after: this.signalingState,
          ok: false,
          err: String(err).slice(0, 120),
          ...extract(args, null, this),
        });
        throw err;
      }
    };

  const P = OrigPC.prototype;
  P.createOffer = wrap("createOffer", P.createOffer, (a, out) => ({ m: mlines(out?.sdp), mid: mids(out?.sdp) }));
  P.createAnswer = wrap("createAnswer", P.createAnswer, (a, out) => ({ m: mlines(out?.sdp), mid: mids(out?.sdp) }));
  P.setLocalDescription = wrap("setLocal", P.setLocalDescription, (a, out, pc) => ({
    type: a[0]?.type ?? "(implicit)",
    m: mlines(a[0]?.sdp ?? pc.localDescription?.sdp),
    mid: mids(a[0]?.sdp ?? pc.localDescription?.sdp),
  }));
  P.setRemoteDescription = wrap("setRemote", P.setRemoteDescription, a => ({
    type: a[0]?.type,
    m: mlines(a[0]?.sdp),
    mid: mids(a[0]?.sdp),
  }));

  const origAddTrack = P.addTrack;
  P.addTrack = function (track, ...streams) {
    push({ op: "addTrack", pc: idOf(this), kind: track.kind, msid: streams[0]?.id ?? null, before: this.signalingState });
    return origAddTrack.call(this, track, ...streams);
  };
  const origAddTx = P.addTransceiver;
  if (origAddTx) {
    P.addTransceiver = function (...a) {
      push({ op: "addTransceiver", pc: idOf(this), before: this.signalingState });
      return origAddTx.apply(this, a);
    };
  }
  // Who fires negotiationneeded, and when — the app assigns the property
  // handler, so wrap the assignment to see each firing in the trace.
  Object.defineProperty(P, "onnegotiationneeded", {
    configurable: true,
    set(fn) {
      this.__nnHandler = fn;
      if (this.__nnWrapped) return;
      this.__nnWrapped = true;
      this.addEventListener("negotiationneeded", () => {
        push({ op: "NEGOTIATIONNEEDED", pc: idOf(this), before: this.signalingState });
        this.__nnHandler?.();
      });
    },
    get() {
      return this.__nnHandler ?? null;
    },
  });

  const origClose = P.close;
  P.close = function () {
    push({ op: "close", pc: idOf(this), before: this.signalingState });
    return origClose.call(this);
  };
}

async function auth(page) {
  await page.evaluate(async relay => {
    await fetch(relay + "/auth/invite", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "probe-invite-pw" }),
    });
    await fetch(relay + "/auth/anon", { method: "POST", credentials: "include" });
  }, RELAY);
}

async function openPeer(browser, name) {
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"] });
  await ctx.addCookies([{ name: `slop_room_${SLUG}`, value: roomCookie(SLUG), domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  page.on("console", m => {
    const t = m.text();
    if (/\[mesh\]/.test(t)) console.log(`  [${name}] ${t.slice(0, 150)}`);
  });
  await page.addInitScript(instrument);
  await page.goto(`${NEXT}/${SLUG}`, { waitUntil: "domcontentloaded" });
  await auth(page);
  await page.goto(`${NEXT}/${SLUG}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.mouse.click(640, 620);
  return page;
}

async function shareVideo(page) {
  await page.getByText(/^video$/i).first().dblclick();
  await page.waitForTimeout(1500);
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll("button")].filter(e => e.offsetParent !== null).map(e => e.textContent?.trim()));
  console.log(`  (video dialog buttons: ${JSON.stringify(btns)})`);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].filter(e => e.offsetParent !== null);
    const go = b.find(e => /^share (video|camera)$/i.test(e.textContent?.trim() ?? ""));
    if (go) go.click();
  });
}

async function shareAudio(page) {
  await page.getByText(/^audio$/i).first().dblclick();
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].filter(e => e.offsetParent !== null);
    const go = b.find(e => /^share audio$/i.test(e.textContent?.trim() ?? ""));
    if (go) go.click();
  });
}

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  console.log("== A joins + shares ==");
  const A = await openPeer(browser, "A");
  await A.waitForTimeout(3000);
  await shareAudio(A);
  await A.waitForTimeout(2500);
  await shareVideo(A);          // 2nd publication -> 2+ m-lines
  await A.waitForTimeout(3500);

  console.log("== B joins + shares (both publishing -> two-way negotiation) ==");
  const B = await openPeer(browser, "B");
  await B.waitForTimeout(3000);
  await shareAudio(B);
  await A.bringToFront();
  await A.waitForTimeout(500);
  await B.waitForTimeout(5000);

  console.log("== C (god-mode spectator) joins late ==");
  const C = await openPeer(browser, "C");
  await A.bringToFront();
  await A.waitForTimeout(500);
  await C.waitForTimeout(8000);

  let doubleOffers = 0;
  let mlineErrors = 0;
  let redundantRounds = 0;
  for (const [name, page] of [["A", A], ["B", B], ["C", C]]) {
    const tr = await page.evaluate(() => window.__trace);
    // Two createOffer on one pc with no intervening setLocal = the race.
    const byPc = new Map();
    for (const r of tr) {
      if (!byPc.has(r.pc)) byPc.set(r.pc, []);
      byPc.get(r.pc).push(r);
    }
    for (const [pcId, rows] of byPc) {
      let pendingOffers = 0;
      for (const r of rows) {
        if (r.op === "createOffer") {
          pendingOffers++;
          if (pendingOffers > 1) {
            doubleOffers++;
            console.log(`  !! ${name} pc${pcId}: ${pendingOffers} concurrent createOffer`);
          }
        }
        if (r.op === "setLocal" && r.type === "offer") pendingOffers = 0;
        if (r.ok === false && /m-lines/.test(r.err ?? "")) {
          mlineErrors++;
          console.log(`  !! ${name} pc${pcId}: m-line error on ${r.op}`);
        }
        if (r.op === "NEGOTIATIONNEEDED") redundantRounds++;
      }
    }
  }
  console.log(`\nVERDICT concurrentOffers=${doubleOffers} mlineErrors=${mlineErrors} negotiationneeded=${redundantRounds}`);
} finally {
  await browser.close();
}
