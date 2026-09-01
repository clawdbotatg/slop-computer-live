// Probe 2: the VIDEO path through the lobby + screenshots of each step.
import { chromium } from "playwright-core";

const NEXT = "http://localhost:3210";
const RELAY = "http://localhost:8180";
const URL = NEXT + "/debug";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

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
      const c = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
      const g = c.getContext("2d");
      setInterval(() => {
        g.fillStyle = `hsl(${(Date.now() / 20) % 360},70%,50%)`;
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = "#fff";
        g.font = "40px sans-serif";
        g.fillText("probe cam", 200, 190);
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

const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(fakeMedia);
await page.goto(URL);
await page.evaluate(async relay => {
  await fetch(relay + "/auth/invite", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "probe-invite-pw" }),
  });
  await fetch(relay + "/auth/anon", { method: "POST", credentials: "include" });
}, RELAY);
await page.goto(URL);
await page.waitForTimeout(4000);

check((await page.getByText("Are you sharing your video").count()) > 0, "fresh: lobby choice shown");
await page.screenshot({ path: "lobby-choice.png" });

await page.getByText("My video", { exact: false }).first().click();
await page.waitForTimeout(3000);
check((await page.getByText("Set up your video").count()) > 0, "video setup step shown");
check((await page.getByText("this is what the room will see").count()) > 0, "camera preview live");
check((await page.getByText("we can hear you").count()) > 0, "mic meter heard the fake mic");
await page.screenshot({ path: "lobby-video-setup.png" });

// Back button returns to choice, then forward again.
await page.getByRole("button", { name: "← Back" }).click();
check((await page.getByText("Are you sharing your video").count()) > 0, "back returns to choice");
await page.getByText("My video", { exact: false }).first().click();
await page.waitForTimeout(2500);

const shareBtn = page.getByRole("button", { name: /Share video & enter/ });
await shareBtn.click();
await page.waitForTimeout(5000);
check(!(await page.getByText("Set up your video").count()), "lobby closed after video share");
const published = await page.evaluate(() => window.__published);
check(published.some(p => p.kind === "camera"), `camera publication live (${JSON.stringify(published)})`);
check(
  (await page.evaluate(() => localStorage.getItem("slop-av-lobby-done-v1"))) === "1",
  "lobby-done flag written",
);
await page.screenshot({ path: "lobby-after-video.png" });

// Skip path: fresh context, "just watching" — enters, no flag written.
const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page2 = await ctx2.newPage();
await page2.addInitScript(fakeMedia);
await page2.goto(URL);
await page2.evaluate(async relay => {
  await fetch(relay + "/auth/invite", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "probe-invite-pw" }),
  });
  await fetch(relay + "/auth/anon", { method: "POST", credentials: "include" });
}, RELAY);
await page2.goto(URL);
await page2.waitForTimeout(4000);
await page2.getByText("just here to watch", { exact: false }).click();
await page2.waitForTimeout(2000);
check(!(await page2.getByText("Are you sharing your video").count()), "skip: lobby closed");
check(
  (await page2.evaluate(() => localStorage.getItem("slop-av-lobby-done-v1"))) === null,
  "skip: flag NOT written (lobby returns next visit)",
);

await browser.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
