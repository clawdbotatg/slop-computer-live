// Warmup script — generate cookies.json that the prod browser-host will
// inject into every new room BrowserContext. The goal: Google sees a
// "returning visitor" with real NID/SOCS/CONSENT cookies instead of a
// fresh fingerprint on every search, which makes the captcha gate fire
// far less often.
//
// Run it locally:
//
//   cd packages/browser-host
//   yarn warmup
//
// A real Chromium window opens. Use it like a normal human:
//   - Open google.com, accept any consent banner.
//   - Run a few searches; click through to a result or two.
//   - Optionally browse a couple of other sites you might want pre-cookied.
//   - DO NOT log into your real Google account — these cookies will ship
//     to prod and get used by every room. Bot-detection cookies are fine
//     to share; auth cookies are not.
//
// When you're done, hit Ctrl+C in the terminal (NOT the X on the window —
// closing the window without the SIGINT path means we never dump). The
// script writes cookies.json into the browser-host package root.
//
// Then scp cookies.json to prod once:
//   scp packages/browser-host/cookies.json slopcomputer:/home/ubuntu/slop-computer-live/packages/browser-host/
//   ssh slopcomputer 'sudo systemctl restart slop-browser-host'
//
// The file persists across `./ops/deploy.sh` runs (deploy only touches
// dist/ and source). Re-warm whenever Google starts challenging again —
// cookies expire on a rolling basis.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteerVanilla from "puppeteer";

const puppeteerExtraMod = (await import("puppeteer-extra")) as unknown as {
  default: { use: (p: unknown) => void } & typeof puppeteerVanilla;
};
const StealthPluginMod = (await import("puppeteer-extra-plugin-stealth")) as unknown as {
  default: () => unknown;
};
const puppeteer = puppeteerExtraMod.default;
puppeteer.use(StealthPluginMod.default());

const OUT_PATH = resolve(process.cwd(), process.env.COOKIES_PATH ?? "cookies.json");
const START_URL = process.env.WARMUP_START_URL ?? "https://www.google.com/";

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ["--disable-blink-features=AutomationControlled", "--lang=en-US,en"],
  ignoreDefaultArgs: ["--enable-automation"],
});

const [page] = await browser.pages();
await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);

console.log("");
console.log("──────────────────────────────────────────────────────────");
console.log(" slop browser warmup — pre-cooking cookies for Google etc.");
console.log("──────────────────────────────────────────────────────────");
console.log(` Output:    ${OUT_PATH}`);
console.log(` Start URL: ${START_URL}`);
console.log("");
console.log(" Browse as a human (search, click results, accept consent).");
console.log(" DO NOT log into your real Google account.");
console.log(" Press Ctrl+C in this terminal when done — the script will");
console.log(" dump cookies and exit cleanly.");
console.log("");

let dumping = false;
const dumpAndExit = async (signal: string) => {
  if (dumping) return;
  dumping = true;
  console.log(`\n→ ${signal} — dumping cookies…`);
  try {
    const ctx = browser.defaultBrowserContext();
    const cookies = await ctx.cookies();
    await writeFile(OUT_PATH, JSON.stringify(cookies, null, 2));
    console.log(`✓ Wrote ${cookies.length} cookies → ${OUT_PATH}`);
  } catch (err) {
    console.error("✗ dump failed:", (err as Error).message);
  } finally {
    await browser.close().catch(() => undefined);
    process.exit(0);
  }
};

process.on("SIGINT", () => void dumpAndExit("SIGINT"));
process.on("SIGTERM", () => void dumpAndExit("SIGTERM"));
// If the user closes the window manually, the browser disconnects and we
// can no longer read cookies. Exit non-zero so they know nothing was saved.
browser.on("disconnected", () => {
  if (dumping) return;
  console.error("\n✗ Browser window closed before Ctrl+C — no cookies dumped. Re-run and use Ctrl+C this time.");
  process.exit(1);
});
