// Reproduce the MSID-drift bug and verify the fix.
//
// Scenario (the real one from docs/BROADCAST-AUDIO-ROUTING.md):
//   1. publisher joins, shares audio           -> note published streamId
//   2. publisher hot-swaps the mic (gear dialog -> replaceTrack)
//   3. a NEW peer (god mode) joins             -> publisher builds a fresh pc
//   4. assert the fresh pc's addTrack MSID still === published streamId
//   5. assert god mode's audio bus holds a source for that streamId
//
// Step 4 is the bug: pre-fix, createPeerConnection passed the post-swap
// MediaStream (new .id) to addTrack, so the new leg advertised an id no
// publication matched, god mode's window rendered blank, and the voice
// never reached the broadcast mix.

import { chromium } from "playwright-core";
import { createHmac } from "node:crypto";

// The relay refuses /auth/godmode without a valid room cookie. /debug is
// passwordless in the UI but the cookie is still required, so forge one
// (dev secret — see packages/relay/src/config.ts).
function roomCookie(slug, secret = "dev-secret-change-me") {
  const payload = Buffer.from(JSON.stringify({ slug, iat: Date.now() }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

const NEXT = "http://localhost:3210";
const RELAY = "http://localhost:8180";
const SLUG = "debug";
const GOD_PW = "probe-god-pw";
const EXEC =
  process.env.HOME +
  "/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const log = (...a) => console.log(...a);

// --- page-side instrumentation -----------------------------------------
// Fake gUM (real device flags are ignored on this Mac — see the
// headless-webrtc-probe recipe) + record every addTrack MSID + every
// `publish` frame the app sends over the relay WS.
function instrument() {
  const mk = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const dst = ctx.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();
    return dst.stream;
  };
  navigator.mediaDevices.getUserMedia = async constraints => {
    const s = new MediaStream();
    if (constraints?.audio) for (const t of mk().getAudioTracks()) s.addTrack(t);
    if (constraints?.video) {
      const c = Object.assign(document.createElement("canvas"), { width: 320, height: 240 });
      const g = c.getContext("2d");
      setInterval(() => {
        g.fillStyle = `hsl(${Date.now() / 20 % 360},70%,50%)`;
        g.fillRect(0, 0, 320, 240);
      }, 66);
      for (const t of c.captureStream(30).getVideoTracks()) s.addTrack(t);
    }
    return s;
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { deviceId: "mic-a", kind: "audioinput", label: "Probe Mic A", groupId: "g", toJSON() {} },
    { deviceId: "mic-b", kind: "audioinput", label: "Probe Mic B", groupId: "g", toJSON() {} },
  ];

  window.__msids = []; // every addTrack(track, stream) -> stream.id
  const origAdd = RTCPeerConnection.prototype.addTrack;
  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    window.__msids.push({ kind: track.kind, msid: streams[0]?.id ?? null, at: Date.now() });
    return origAdd.call(this, track, ...streams);
  };

  window.__published = []; // every `publish` frame we send
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      const m = JSON.parse(data);
      if (m && m.type === "publish") window.__published.push({ streamId: m.streamId, kind: m.kind });
    } catch {}
    return origSend.call(this, data);
  };

  localStorage.setItem("slop-has-been-here-v1", "1");
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

// `godUrl`, when given, is navigated to AFTER auth — the app strips
// ?godMode= from the URL as soon as it reads it, so a reload would
// silently drop the spectator handshake and we'd test a normal guest.
async function openRoom(ctx, url, godUrl) {
  const page = await ctx.newPage();
  page.on("console", m => {
    const t = m.text();
    if (/\[mesh\]|godMode|error/i.test(t)) log("    console:", t.slice(0, 160));
  });
  await page.addInitScript(instrument);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await auth(page);
  await page.goto(godUrl ?? url, { waitUntil: "domcontentloaded" });
  // First user gesture: unblocks the AudioContext (ACTIVATED_EVENT).
  await page.waitForTimeout(1500);
  await page.mouse.click(640, 620);
  return page;
}

// Dump every visible button so a single run tells us what to click next.
async function dumpButtons(page, where) {
  const bs = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter(e => e.offsetParent !== null && e.getBoundingClientRect().width > 0)
      .map(e => (e.textContent?.trim() || e.title || e.getAttribute("aria-label") || "?").slice(0, 34)),
  );
  log(`  [${where}] buttons: ${JSON.stringify(bs)}`);
}

async function clickButton(page, re, what) {
  const ok = await page.evaluate(pattern => {
    const rx = new RegExp(pattern.source, pattern.flags);
    const b = [...document.querySelectorAll("button")].filter(
      e => e.offsetParent !== null && e.getBoundingClientRect().width > 0,
    );
    const hit = b.find(e =>
      rx.test((e.textContent?.trim() || "") ) || rx.test(e.title || "") || rx.test(e.getAttribute("aria-label") || ""),
    );
    if (!hit) return false;
    hit.click();
    return true;
  }, { source: re.source, flags: re.flags });
  log(`  (click ${what}: ${ok ? "ok" : "NOT FOUND"})`);
  return ok;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

try {
  // ---- 1. publisher joins + shares audio --------------------------------
  const pubCtx = await browser.newContext({ permissions: ["microphone", "camera"] });
  const pub = await openRoom(pubCtx, `${NEXT}/${SLUG}`);
  await pub.waitForTimeout(3500);

  // Open the AUDIO desktop icon (dblclick its label) -> share dialog.
  // Label is uppercased by CSS — the DOM text is lowercase.
  await pub.getByText(/^audio$/i).first().dblclick();
  await pub.waitForTimeout(1500);
  await dumpButtons(pub, "audio share dialog");
  await clickButton(pub, /^share audio$/i, "share-confirm");
  await pub.waitForTimeout(3500);

  const published = await pub.evaluate(() => window.__published);
  const audioPub = published.find(p => p.kind === "audio") ?? published[0];
  check("publisher published an audio stream", !!audioPub, audioPub ? `streamId=${audioPub.streamId}` : "none");
  if (!audioPub) throw new Error("no publication — cannot continue");
  const publishedId = audioPub.streamId;

  // ---- 2. hot-swap the mic (the trigger) --------------------------------
  await pub.evaluate(() => (window.__msids = []));
  await dumpButtons(pub, "live audio window");
  // gear on the live audio window -> dialog opens in "edit" mode
  await clickButton(pub, /^audio settings$/i, "gear");
  await pub.waitForTimeout(1200);
  await dumpButtons(pub, "edit dialog");
  // submit — handleAudioSubmit calls swapAudioTrack even with micId ""
  await clickButton(pub, /^(save|apply|update|switch|share|go live|done|ok)$/i, "swap-confirm");
  await pub.waitForTimeout(3000);

  const localDrift = await pub.evaluate(() => {
    // Did the swap actually produce a new MediaStream object locally?
    const vids = [...document.querySelectorAll("video,audio")].map(e => e.srcObject?.id).filter(Boolean);
    return vids;
  });
  log(`  (local stream ids after swap: ${JSON.stringify(localDrift)})`);

  // ---- 3. a NEW peer joins (god mode) -----------------------------------
  await pub.evaluate(() => (window.__msids = []));
  const godCtx = await browser.newContext({ permissions: ["microphone", "camera"] });
  await godCtx.addCookies([
    { name: `slop_room_${SLUG}`, value: roomCookie(SLUG), domain: "localhost", path: "/" },
  ]);
  const god = await openRoom(godCtx, `${NEXT}/${SLUG}`, `${NEXT}/${SLUG}?godMode=${GOD_PW}`);
  await pub.bringToFront();
  await pub.waitForTimeout(1000);
  await god.waitForTimeout(6000);

  // ---- 4. THE ASSERTION: fresh pc advertises the published id ----------
  const msids = await pub.evaluate(() => window.__msids);
  const audioMsids = msids.filter(m => m.kind === "audio").map(m => m.msid);
  const uniq = [...new Set(audioMsids)];
  log(`  (addTrack MSIDs on the new leg: ${JSON.stringify(uniq)})`);
  check(
    "new peer connection advertises the PUBLISHED streamId",
    uniq.length > 0 && uniq.every(m => m === publishedId),
    `published=${publishedId} advertised=${JSON.stringify(uniq)}`,
  );

  // ---- 5. god mode's bus actually holds the voice -----------------------
  const snap = await god.evaluate(async () => {
    return await new Promise(resolve => {
      const ch = new BroadcastChannel("slop-audio-bus-v1");
      const seen = [];
      let snapshot = null;
      ch.onmessage = ev => {
        seen.push(ev.data?.type);
        if (ev.data?.type === "snapshot") snapshot = ev.data.snapshot;
      };
      ch.postMessage({ type: "request-snapshot" });
      setTimeout(() => {
        try { ch.close(); } catch {}
        resolve({ snapshot, seen: [...new Set(seen)] });
      }, 3000);
    });
  });
  log(`  (bus channel traffic seen: ${JSON.stringify(snap.seen)})`);

  const diag = await god.evaluate(() => ({
    god: !!document.body.textContent?.match(/god ?mode|spectator/i),
    mixerBtn: !![...document.querySelectorAll("button")].find(b => /audio mixer/i.test(b.getAttribute("aria-label")||b.title||"")),
    windows: document.querySelectorAll(".slop-window").length,
    mediaEls: [...document.querySelectorAll("audio,video")].map(e => e.srcObject?.id ?? null),
    audioTracks: [...document.querySelectorAll("audio,video")].map(e => e.srcObject?.getAudioTracks?.().length ?? 0),
  }));
  log(`  (god diag: ${JSON.stringify(diag)})`);
  const sources = snap?.snapshot?.sources ?? [];
  log(`  (bus sources: ${JSON.stringify(sources.map(s => s.id))})`);
  check(
    "god mode's broadcast mix contains the peer's voice",
    sources.some(s => s.id === `peer-${publishedId}`),
    `looking for peer-${publishedId}`,
  );

  // ---- 6. reconciler heals a link-5 failure ----------------------------
  // Simulate the "registerStream returned false and nothing ever retried"
  // hypothesis: make createMediaStreamSource throw for the first few
  // seconds, so the per-component registration on mount FAILS. Without
  // the reconciler that voice is off the mix until someone reloads.
  const god2Ctx = await browser.newContext({ permissions: ["microphone", "camera"] });
  await god2Ctx.addCookies([{ name: `slop_room_${SLUG}`, value: roomCookie(SLUG), domain: "localhost", path: "/" }]);
  const g2 = await god2Ctx.newPage();
  await g2.addInitScript(() => {
    const orig = AudioContext.prototype.createMediaStreamSource;
    const until = Date.now() + 6000;
    AudioContext.prototype.createMediaStreamSource = function (...a) {
      if (Date.now() < until) throw new DOMException("probe-forced-failure", "InvalidStateError");
      return orig.apply(this, a);
    };
  });
  await g2.addInitScript(instrument);
  await g2.goto(`${NEXT}/${SLUG}`, { waitUntil: "domcontentloaded" });
  await auth(g2);
  await g2.goto(`${NEXT}/${SLUG}?godMode=${GOD_PW}`, { waitUntil: "domcontentloaded" });
  await g2.waitForTimeout(1500);
  await g2.mouse.click(640, 620);
  await pub.bringToFront();
  await pub.waitForTimeout(500);
  await g2.waitForTimeout(14000); // past the forced-failure window + ticks

  const snap2 = await g2.evaluate(async () => {
    return await new Promise(resolve => {
      const ch = new BroadcastChannel("slop-audio-bus-v1");
      ch.onmessage = ev => {
        if (ev.data?.type === "snapshot") { try { ch.close(); } catch {} resolve(ev.data.snapshot); }
      };
      ch.postMessage({ type: "request-snapshot" });
      setTimeout(() => { try { ch.close(); } catch {} resolve(null); }, 4000);
    });
  });
  const s2 = snap2?.sources ?? [];
  log(`  (bus sources after forced registration failure: ${JSON.stringify(s2.map(x => x.id))})`);
  check(
    "reconciler recovers a voice whose first registration failed",
    s2.some(x => x.id === `peer-${publishedId}`),
    `looking for peer-${publishedId}`,
  );

  await pub.screenshot({ path: new URL("./pub.png", import.meta.url).pathname });
  await god.screenshot({ path: new URL("./god.png", import.meta.url).pathname });
} finally {
  await browser.close();
}

log("\n" + "=".repeat(60));
const failed = results.filter(r => !r.pass);
log(failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL ${results.length} PASSED`);
process.exit(failed.length ? 1 : 0);
