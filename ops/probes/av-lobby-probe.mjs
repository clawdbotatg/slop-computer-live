// Probe: first-visit A/V lobby end-to-end.
//
//  A (fresh browser, no localStorage flags):
//    1. sees the lobby ("Are you sharing your video…")
//    2. observer B sees "🚪 lobby" badge in the guest list
//    3. A picks "Just my audio", meter hears the fake mic, commits
//    4. lobby closes, slop-av-lobby-done-v1 is written, desktop icons show,
//       NO hint arrow this session, audio publication live (publish frame)
//    5. B's lobby badge disappears
//    6. A reloads -> no lobby, hint arrow IS visible (second-visit flow)
//  B (returning browser: has-been-here + lobby-done set): never sees lobby.

import { chromium } from "playwright-core";

const NEXT = "http://localhost:3210";
const RELAY = "http://localhost:8180";
const URL = NEXT + "/debug";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// Fake gUM: canvas video + oscillator audio (real fake-device flags are
// ignored on this Mac). Loud-ish oscillator so the MicCheck meter trips.
function fakeMedia() {
  const mkAudio = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    const dst = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dst);
    osc.start();
    void ctx.resume();
    return dst.stream;
  };
  navigator.mediaDevices.getUserMedia = async constraints => {
    const s = new MediaStream();
    if (constraints?.audio) for (const t of mkAudio().getAudioTracks()) s.addTrack(t);
    if (constraints?.video) {
      const c = Object.assign(document.createElement("canvas"), { width: 320, height: 240 });
      const g = c.getContext("2d");
      setInterval(() => {
        g.fillStyle = `hsl(${(Date.now() / 20) % 360},70%,50%)`;
        g.fillRect(0, 0, 320, 240);
      }, 66);
      for (const t of c.captureStream(30).getVideoTracks()) s.addTrack(t);
    }
    return s;
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { deviceId: "mic-a", kind: "audioinput", label: "Probe Mic A", groupId: "g", toJSON() {} },
    { deviceId: "cam-a", kind: "videoinput", label: "Probe Cam A", groupId: "g", toJSON() {} },
  ];
  window.__published = [];
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      const m = JSON.parse(data);
      if (m && m.type === "publish") window.__published.push({ streamId: m.streamId, kind: m.kind });
    } catch {}
    return origSend.call(this, data);
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

// Auto-discover the cached chromium build (the -NNNN suffix bumps on
// playwright updates; a pinned path rots).
import { readdirSync } from "node:fs";
const pwCache = process.env.HOME + "/Library/Caches/ms-playwright";
const chromiumDir = readdirSync(pwCache)
  .filter(d => /^chromium-\d+$/.test(d))
  .sort()
  .pop();
const EXEC = `${pwCache}/${chromiumDir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const browser = await chromium.launch({
  executablePath: EXEC,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

// --- B: returning observer ------------------------------------------------
const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const pageB = await ctxB.newPage();
await pageB.addInitScript(fakeMedia);
await pageB.addInitScript(() => {
  localStorage.setItem("slop-has-been-here-v1", "1");
  localStorage.setItem("slop-av-lobby-done-v1", "1");
});
await pageB.goto(URL);
await auth(pageB);
await pageB.goto(URL);
await pageB.waitForTimeout(4000);
check(!(await pageB.getByText("Are you sharing your video").count()), "B (returning): no lobby shown");

// --- A: brand-new visitor -------------------------------------------------
const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const pageA = await ctxA.newPage();
await pageA.addInitScript(fakeMedia);
await pageA.goto(URL);
await auth(pageA);
await pageA.goto(URL);
await pageA.waitForTimeout(4000);

check((await pageA.getByText("Are you sharing your video").count()) > 0, "A (fresh): lobby is shown");
check(
  (await pageA.locator('img[src="/hint.png"]').count()) === 0,
  "A: no hint arrow while lobby is up",
);

// B should see the lobby badge in the guest list
await pageB.waitForTimeout(1500);
check((await pageB.getByText("🚪 lobby").count()) > 0, "B: guest list shows 🚪 lobby badge for A");

// --- A: audio setup step --------------------------------------------------
await pageA.getByText("Just my audio", { exact: false }).click();
await pageA.waitForTimeout(2500);
check((await pageA.getByText("Set up your audio").count()) > 0, "A: audio setup step shown");
check((await pageA.getByText("we can hear you").count()) > 0, "A: mic meter heard the fake mic");

const shareBtn = pageA.getByRole("button", { name: /Share audio & enter/ });
check(await shareBtn.isEnabled(), "A: share button enabled once mic preview live");
await shareBtn.click();
await pageA.waitForTimeout(5000);

check(!(await pageA.getByText("Set up your audio").count()), "A: lobby closed after share");
check(
  (await pageA.evaluate(() => localStorage.getItem("slop-av-lobby-done-v1"))) === "1",
  "A: slop-av-lobby-done-v1 written",
);
check(
  (await pageA.evaluate(() => localStorage.getItem("slop-has-been-here-v1"))) === null,
  "A: slop-has-been-here-v1 still unset (hint reserved for visit 2)",
);
const published = await pageA.evaluate(() => window.__published);
check(published.some(p => p.kind === "audio"), `A: audio publication live (${JSON.stringify(published)})`);
check((await pageA.locator('img[src="/hint.png"]').count()) === 0, "A: no hint arrow right after lobby");
check((await pageA.getByText("Chat", { exact: true }).count()) > 0, "A: desktop icons visible (Chat)");

// B: badge gone
await pageB.waitForTimeout(1500);
check((await pageB.getByText("🚪 lobby").count()) === 0, "B: lobby badge cleared after A shared");

// --- A: second visit (reload) --------------------------------------------
await pageA.reload();
await pageA.waitForTimeout(6000);
check(!(await pageA.getByText("Are you sharing your video").count()), "A visit 2: no lobby");
check((await pageA.locator('img[src="/hint.png"]').count()) > 0, "A visit 2: hint arrow visible");

await browser.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
