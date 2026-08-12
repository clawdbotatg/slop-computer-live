# The stream looks bad — start here

Symptom-keyed runbook. If Austin says *"my video looks like shit on the
stream"*, read this file **before** touching any code, and before asking
him to run anything.

Companion docs: [`VIDEO-QUALITY.md`](VIDEO-QUALITY.md) (encoder tiering,
the `degradationPreference` trap, ffmpeg forensics on a recording),
[`BROADCAST-AUDIO-ROUTING.md`](BROADCAST-AUDIO-ROUTING.md) (a voice
missing entirely), [`AUDIO-LEVELING.md`](AUDIO-LEVELING.md) (levels).

---

## The bar

These are the expectations. Anything short of this is a bug, not a
tuning opportunity.

1. He goes live and it looks great. **No fiddling, no settings, no
   pre-flight.**
2. **The hardware is never the excuse.** A dedicated 24 GB interface
   machine, a second machine doing nothing but OBS, a Sony a6400 through
   a Cam Link 4K. If the picture is bad, our software is wrong.
3. **Screen sharing must work.** "Don't screen share" is a workaround,
   not a fix.
4. **He never debugs during a show.** Reading `/eq` numbers aloud mid
   broadcast is itself the failure.
5. **When it breaks: read this file and fix it.** Do not re-derive the
   chain, do not re-run experiments already recorded here, do not make
   him re-explain his own rig.
6. **Answers are short.** He has said so repeatedly. Lead with the fix.
7. **It stays fixed.** See "Regression traps" at the bottom.

---

## 60-second triage

Do these in order. Most of a six-hour night in 2026-08-10 would have been
four minutes if this list had existed.

1. **Tap the ⓘ on the bad feed's window** (next to mute, on every video
   window, on every machine). It gives a verdict and names whose fault it
   is. If the complaint came from a guest, have *them* tap it — they can
   read their own feed now.
2. **`/eq` on the god-mode machine → the `CONNECTION` line.** One line,
   green/amber/red, names the worst feed.
3. **Both machines actually on `192.168.10.x`?** `ifconfig en0` on each.
   A `192.168.68.x` address on either means a rogue DHCP server is back
   on the wire and the media is detouring through the Deco — see cause 7.
   This painted as a quiet `? 4ms` path badge on 08-12, not an error.
4. **`composite` line ≥ 24 fps and not `TAB HIDDEN`?** If it dipped, the
   broadcast machine stalled and *every* feed below will look starved
   whether it is or not.
5. **Is a screen share running?** It is the most expensive thing in the
   room. Stopping it is the single biggest recovery lever.
6. **Permission check, if anything says `TURN`:** ping a LAN peer as a
   normal user, then under `sudo` (see cause 4). Different results = a
   macOS permission, not the network.

---

## The chain (this is the whole map)

Every arrow is a place quality can be lost. Most bad-looking shows are
lost in the **first three**, not on the network.

```
Sony a6400
   └─ HDMI, fixed frame rate set in the CAMERA menu (24p/30p/60p)
        └─ Cam Link 4K (USB 3.0 — a USB 2 port or hub drops frames)
             └─ OBS "Rig2" profile, canvas resolution  ← 1920x1080 (was 1280x720)
                  └─ OBS Virtual Camera  (outputs the CANVAS size)
                       └─ Chrome getUserMedia, app camera-res pref  ← default 1280x720 (was 854x480)
                            └─ macOS Local Network permission  ← denies the LAN entirely, silently
                            └─ WebRTC encoder, per-peer caps (usePeerMesh.ts)
                                 └─ FULL MESH: one encode per recipient
                                      └─ building uplink (shared with OBS's RTMP push)
                                           └─ clawd-gut (god mode) renders composite
                                                └─ OBS on clawd-gut → 1920x1080 → viewers
```

**Two consequences that keep getting missed:**

- **The local preview proves nothing.** What Austin sees on his own
  screen is the raw DSLR feed and will *always* look stunning. The only
  number that matters is the `in` line on `/eq` at the god-mode machine.
- **clawd-gut can only show what the interface machine sends it.** If
  the mesh delivers 480p, the composite upscales it into a 1080p canvas
  — 5× the pixel area invented from nothing. That is the "mush". No
  change on clawd-gut can fix it.

---

## First: read `/eq` on the god-mode machine

Ask for a paste of the whole video section. It answers everything.

| Line | Healthy | What it means if not |
|---|---|---|
| `CONNECTION` | 🟢 `GOOD` | the verdict, and the **only** line you must read. Grades the worst camera on picture *and* path, and names it when more than one camera is up. |
| `composite` | ~30 fps, worst < 50ms, no `TAB HIDDEN` | god-mode machine is stalling — **not** a feed problem. Chrome throttles a hidden/occluded tab to ~0. |
| per-feed `in` resolution | 1280×720 or better | this is literally what the broadcast has to work with |
| per-feed `in` fps | ~30 | below 30 with no badge → **source** framerate (camera menu), not network |
| `CPU` badge | absent | encoder starved — usually the screen share, one encode per peer |
| `NET` badge | absent | bandwidth/loss limited — uplink, the mesh tax, **or our own cap** (see cause 6) |
| `LAN` badge | **present, green** | media never left the local wire and costs zero uplink |
| `WAN` badge | absent | direct, but hairpinning out through the ISP and back — still spends uplink on what may be a three-foot hop |
| `TURN` badge | absent | relayed through the server. Almost always a **permission**, see cause 4 |
| `relay Xms` | 40–120ms is NORMAL | this is the **signalling** ping to the relay in AWS. **It is not the media path.** See the trap below. |
| `stream` row | 1920×1080, 30fps, `drop` not climbing | `drop` climbing = clawd-gut's uplink to prod is congested |

> ### The `relay Xms` trap
>
> The per-row `ms` is `wsRttMs`, the WebSocket round-trip to the relay box
> in AWS. It stays 40–120ms **even when the media is a 1ms hop across the
> room**, because it measures signalling, not media.
>
> On 2026-08-10 this cost an hour: after the real fix landed, the `TURN`
> badge cleared and this number stayed at 46ms, which got read as "still
> not on the LAN". That sent the session into Chrome mDNS flags and a
> Thunderbolt cable, chasing a connection that was **already direct**.
>
> **The media RTT is in the `CONNECTION` line** (and on each ⓘ panel). It
> read 1ms the moment it was rendered. The column is now labelled `relay`
> so it cannot do this again.

**The single most diagnostic comparison:** put Austin's row next to a
remote guest's row. On 2026-08-10 they were at *identical bitrate* —
`731k` vs `737k` — and the guest turned it into `854×480 @ 30fps` while
Austin got `318×180 @ 13fps`. Same bits, 7× the pixels. That instantly
ruled out bandwidth and pointed at the source chain.

---

## The ⓘ button (every video window, every machine)

Next to the mute button on each video window. Tap it for that feed's
numbers; tap the panel to close. It exists because before it, **the only
machine that could see why a feed looked bad was the god-mode box** — so
diagnosing a guest meant the host stopping mid-show to read stats aloud,
which the expectations above specifically forbid.

```
🟢 GOOD              H264
sent       1280×720 @ 30fps
received   1280×720 @ 30fps
bitrate    2.4 Mbps
path       LAN · 1ms
```

**`sent` vs `received` is the money read.** `sent` is what the publisher
reports encoding; `received` is what this machine actually decoded. They
match on a healthy path and diverge when the network is dropping between
the two — that gap *is* the loss, visible without any other tool.

The panel also translates the encoder's excuse into whose problem it is:
`cpu` → "publisher's machine can't encode fast enough, usually a screen
share"; `bandwidth` → "their connection, not yours".

Costs nothing: it reads state the mesh already keeps (every publisher
samples its own encoders and the relay fans the report out to the whole
room), not a fresh `getStats()`.

---

## Known-good numbers (2026-08-10, after everything below)

Compare against these before theorising. This is a healthy show with the
host publishing camera + screen and one remote guest.

```
CONNECTION   🟢 GOOD
composite    30 fps · worst 34ms
host cam     1280×720  30fps  ~2.2-2.4 Mbps   LAN · 1ms    no badges
guest cam    1280×720  30fps  ~1.1-1.3 Mbps   (remote)     no badges
host screen  1920×1060  5-7fps  ~50k          (static content compresses to nothing)
stream       1920×1080  30fps  ~7.6 Mbps  drop not climbing
```

For contrast, the same rig at its worst earlier the same day:
`318×180 @ 7fps @ 67k`, `TURN`, everything relaying through Virginia.

---

## Ruled out — do not re-investigate without new evidence

Each of these cost real time. They are settled.

| Theory | Verdict | Evidence |
|---|---|---|
| Prod box (AWS) is overloaded | **No** | load 0.27, all services active, during a bad show |
| clawd-gut / OBS can't keep up | **No** | `composite` 30–60 fps, worst 35ms; OBS `outputSkippedFrames` **0**, render 30.0 fps, CPU 0.4% |
| The recording/publish path re-encodes | **No** | container is native 1920×1080 30.00fps 7 Mbps; published VOD is byte-identical to the recording |
| Composite is upscaled from a smaller canvas | **No** | FFT of horizontal scanlines shows energy smooth to Nyquist — natively 1920 wide |
| Low light is capping camera framerate | **No** (for this rig) | true of cheap UVC webcams, **false** for a DSLR — HDMI output rate is fixed by a camera menu setting. 23 fps was 23.976 = 24p. |
| RAM / the 24 GB machine | **No** | never the constraint; `NET`, not `CPU` |
| Client isolation on the Bell GPON router | **No** | no such setting exists on it; IP Filter disabled with zero rules; firewall default policy Accept; all four LAN ports in Route Mode; both machines listed as connected devices |
| heart and gut on different subnets | **No** on 08-10 — then **YES** on 08-12 (cause 7) | the 30-second check (`ifconfig en0` on both) is worth re-running before ruling this out; it flipped once already |
| macOS application firewall / `pf` | **No** | firewall disabled and stealth off on both; `pfctl -si` Status: Disabled, only stock `com.apple` anchors |
| Ethernet itself is broken | **No** | `tcpdump` showed echo request AND reply on the wire while `ping` reported 100% loss. It was a permission (cause 4). Ethernet measures **1.3ms** heart↔gut. |
| Chrome mDNS obfuscation | **No** | flag was flipped to Disabled on both machines; changed nothing. The 46ms being chased was the relay ping, not the media path. |

---

## Confirmed causes, in the order they bit

### 1. `degradationPreference: "maintain-resolution"` (fixed, `7688abf`)

`d5d59ad` set it on every broadcast leg. It leaves a squeezed encoder
exactly one lever — framerate — and Chrome will walk a camera to 2 fps
rather than drop a single pixel. Measured on the 08-07 recording: guest
camera **6.5 fps**, screen share **0.6 fps**, against a 08-04 baseline of
a steady 27–30. Cameras are now `balanced`; only the screen broadcast
leg stays pinned. **Full detail in [`VIDEO-QUALITY.md`](VIDEO-QUALITY.md).**

### 2. The resolution chain was throwing away most of the picture (fixed 2026-08-10)

Two independent downscales *before the network*:

- **OBS canvas was `1280×720`.** The Virtual Camera can only ever output
  the canvas size, so 1080p was unreachable no matter what the app asked
  for. Now `1920×1080` (see "OBS control" below).
- **The app's camera-res default was `854×480`.** Even a perfectly
  healthy feed shipped 480p into a 1080p broadcast.

### 3. Screen share costs N× and starves everything (partially fixed)

Full mesh means every recipient gets their own private full-quality
encode. Measured live on 2026-08-10 with 3 people in the room:

```
sharing screen:      cam  318×180  7fps    67k    NET
                     screen 1256×1058 9fps  66k
stopped sharing:     cam  318×180  13fps  737k    (11× recovery)
```

Stopping the screen share was the single largest recovery of the night.
Guest tiles are cosmetic — only the god-mode leg feeds the broadcast —
so guest tiers should be far cheaper than they are.

### 4. macOS Local Network permission — the `TURN` badge, and the single biggest quality cliff

`/eq` showed a **`TURN`** badge on the host's feed: two machines sitting
next to each other were relaying video through a TURN server in AWS and
back — `960x540 @ 19fps / 226k` out, **4 fps** in, 46 ms RTT to a box
three feet away. That relay is a hard ceiling no encoder tuning can lift.

**The cause is a macOS privacy toggle, not the network.** macOS attributes
TCC permissions to the **responsible process** — the app that *launched*
the app. `slop-setup.sh` runs inside **iTerm** and starts Chrome with
`open -ga`, so **Chrome inherits iTerm's grants**. Chrome's own Local
Network toggle being ON is irrelevant; if iTerm is denied, that whole
Chrome instance is denied.

Denied Local Network means Chrome can reach the gateway and the entire
internet, but **not one other device on the LAN**. Every ICE host and
srflx pair fails, and relay is all that is left. Silent — no error, no
log, nothing in `chrome://webrtc-internals` that names the cause.

**iTerm therefore needs every permission the Chrome it spawns will use:**
Local Network, **Camera**, **Microphone**, and Screen Recording (that
last one was already required — `slop-obs-patch.py` uses
`CGWindowListCopyWindowInfo`, which is why the launcher uses iTerm and
not Terminal.app in the first place).

**Diagnosis in one move: ping a LAN peer as a normal user, then under
`sudo`.** Root bypasses TCC. Different results = TCC, full stop.

The giveaway that cost hours here: `tcpdump` showed the ICMP echo
request AND the reply both on the wire, while `ping` in the same shell
reported 100% loss. Packets arrive; the *process* is not allowed to see
them.

```
20:44:55.923042 IP 192.168.10.134 > 192.168.10.133: ICMP echo request
20:44:55.923395 IP 192.168.10.133 > 192.168.10.134: ICMP echo reply
--- 100.0% packet loss          <- same host, same moment, unprivileged
```

After granting iTerm Local Network, the same ping returned **0% loss at
1.3 ms**, on plain ethernet, with no other change.

**Ruled out along the way — do not re-investigate:** client isolation on
the Bell GPON gateway (no such setting exists on it; IP Filter disabled
with zero rules; firewall default policy Accept; all four LAN ports in
Route Mode), different subnets (both machines are on `192.168.10.0/24`),
macOS application firewall (disabled on both), and `pf` (Status:
Disabled, only the stock `com.apple` anchors). A Thunderbolt cable
between the two minis was tried and **failed identically**, which is
what finally proved it could not be the network: a point-to-point cable
has nothing in between to drop a packet.

**After any permission change, Chrome must be fully quit (⌘Q) and
relaunched** — a running process keeps the grants it started with.

### 5. OBS's RTMP push competes with the mesh on the same uplink

The OBS box was pushing **8.1 Mbps** out of the same building. Dropping
it to 3500 produced an immediate **4× jump** in every WebRTC feed
(218k → 911k for a guest, 290k → 1207k for Austin). Both machines share
one pipe.

### 6. Caps sized for a constraint that had gone away (fixed `c4bff10`)

Every cap in `usePeerMesh.ts` was set earlier the same day, **while the
uplink was collapsing** and the broadcast leg, the guest tiles and OBS's
RTMP push were all fighting for it. Once cause 4 was fixed the broadcast
leg became a 1ms LAN hop costing **zero uplink**, and those numbers were
suddenly rationing against a constraint that no longer existed.

Two symptoms, both of which read as network problems and were not:

- `NET` at `960×540` while sitting at `2334k`. Chrome had the bitrate and
  was bumping into **our own 2.5 Mbps ceiling** on a gigabit hop. A cap
  is not a target — raised to **4 Mbps**.
- *"Why does my video suck on clawd's computer?"* Non-spectator peers get
  the **tile tier**, which had been cut to `350k` at half resolution to
  stop the screen share starving the host's camera. Correct at the time;
  wrong the moment the uplink freed up, because people **do** enlarge a
  window to look at whoever is talking. Raised to `900k` / scale `1.5`.

**Screen tiles were deliberately left cheap** (`400k`, 5fps, scale 3).
The screen share was the actual starver — measured at ~2.1 Mbps per guest
during the collapse — and nothing about it got cheaper.

**Current values** (`usePeerMesh.ts`) — the broadcast tier is the leg the
god-mode spectator receives and OBS captures; every other peer is a tile:

| | broadcast | tile |
|---|---|---|
| camera bitrate | 4 Mbps | 900 kbps |
| camera scale | 1× | 1.5× down |
| camera framerate | 30 | 30 |
| screen bitrate | 2.5 Mbps | 400 kbps |
| screen framerate | 15 | 5 |
| screen scale | 1× | 3× down |
| degradation | `balanced` (camera) / `maintain-resolution` (screen only) | `balanced` |

Tier is assigned by `peer.spectator` — **only** the god-mode spectator
gets `broadcast`. If nobody is flagged spectator, everyone lands on the
tile tier and the broadcast silently gets thumbnail quality.

### 7. Two DHCP servers on one wire — the Deco bridge (fixed 2026-08-12, Deco → AP mode)

The 08-12 show ran with the host's cam at `480×270 @ 14fps @ 411k`, `NET`
badge, `CONNECTION 🔴 POOR … ? 4ms`, while the other two cams were a
pristine 720p30 and the composite painted 49 fps. It pattern-matched
cause 3 (screen share starvation) — but the depth was new: the
**broadcast leg to gut itself** was collapsed, which a wired LAN hop
cannot do.

What actually happened:

- The TP-Link Deco (router mode) had its network **bridged onto the
  wired switch**, so one L2 segment carried two DHCP servers: Bell
  (`192.168.10.1`) and Deco (`192.168.68.1`). Every lease renewal on
  every device was a race between two landlords.
- heart lost a renewal race and re-homed to `192.168.68.53` — same
  wire, different subnet. **No cable moved.** It had probably "worked
  for months" only because Bell kept winning.
- The only same-subnet ICE pair left was heart `68.53` ↔ gut's **wifi**
  `68.55` — so the "wired" video rode the Deco wifi on its last hop.
  That leg measured **22–205ms (avg 142ms)** against the wire's ~1ms,
  and folded the moment the screen share loaded it.
- The cross-checks that nailed it, in order: `traceroute` heart→gut
  showed a hop through `192.168.68.1`; gut's **link-local IPv6 answered
  on heart's `en0`** (link-local cannot cross a router → same wire,
  proving no cable moved); `ipconfig getpacket en0` named the Deco as
  the DHCP server.

`/eq`'s tell was quiet: a `?` path badge (no clean host↔host pair to
classify) and `4ms` where the wire reads ~1ms. That check is now triage
step 3.

**Fix: the Deco was switched to Access Point mode** — no NAT, no DHCP,
just wifi bridged onto the Bell network. One subnet, one DHCP server;
heart↔gut measured **0.6ms** immediately after. Static IPs were
prepared as armor but became unnecessary once the second DHCP server
was gone. If a `192.168.68.x` address ever reappears on either machine,
something has put the Deco back in router mode.

**Bell's IPv6 is measurably broken — this is why the Deco existed
(measured 2026-08-12, same evening).** Moving devices behind the Deco
had "fixed" an older intermittent "1-in-10 page loads hang and die"
problem — the Deco was simply not passing Bell's IPv6 through. Within
the hour of AP mode going live, the phone showed X with every image a
grey box (text loads, images don't). Measured on heart with v6
temporarily enabled: **small v6 fetches 25ms, ping6 clean even at
1480-byte packets — but bulk v6 transfers collapse to 6–19 KB/s** (three
1MB downloads, none finished in 10s) while the identical v4 download
runs 84 MB/s. Small-survives/bulk-dies is exactly grey images and
dying page loads. It is not an MTU blackhole (big pings pass);
sustained v6 flows are just destroyed inside/behind the Bell hub.

**The Bell gateway will not let you disable IPv6 — do not try again**
(attempted 2026-08-12, logged in, via the real admin UI): the WAN
connection is carrier-provisioned (TR-069) and silently reverts
`IP mode: IPv4` back to `IPv4&IPv6` on save; the `LAN_IPv6` page's
Save/Apply button is `disabled` in the page markup. Subscriber-level
login has no IPv6 control anywhere.

The remaining fix is the **Deco back in Router mode, plugged in
correctly**: only the Deco's WAN port touches Bell's LAN, and the
Macs' switch uplinks into a Deco LAN port. One landlord (the Deco),
one subnet, Bell's broken v6 hidden behind its NAT — and the stream
fix survives because the two Macs talk switch-locally either way.
This is deliberately NOT cause 7 again: cause 7 was two routers
bridged onto one wire, not the Deco routing per se. (As of the
2026-08-12 session this flip was agreed but **not yet executed** —
phones still see broken v6 until it happens.) heart's
Ethernet keeps **IPv6 deliberately Off** regardless (verified 08-12;
75/75 v4 requests through Bell clean, 677/516 Mbps down/up). Test
harness for re-measuring: `test-bell-ipv6.sh` pattern — enable v6,
compare a small fetch against a 1MB fetch, restore v6 off via trap.

---

## Open — the things that will bite next

- **Full mesh is the ceiling.** Upload scales with guest count. At 3
  people plus a screen share it collapses. At 5 it is unusable no matter
  how the caps are tuned. **The real fix is an SFU** (LiveKit or
  mediasoup): send one copy, the server fans out. Everything else is
  buying time.
- **~~RTT between two machines in the same room was 48–191 ms.~~**
  **Answered 2026-08-10: macOS Local Network permission, inherited from
  iTerm — see confirmed cause 4.** Fixed; plain ethernet now measures
  1.3 ms heart↔gut. No cable or switch needed.
- **The god-mode composite stall at 08-07 `t=3652`** — both cameras *and*
  the locally-rendered news ticker dipped together, which rules out the
  network. Instrumented by the `composite` line; never root-caused.
- **The audio chop** was never independently confirmed. Suspected same
  cause as the composite stall.

---

## The network (heart ↔ gut)

```
heart  clawds-Mac-mini    M4, 24 GB   en0 192.168.10.134  (IPv6 Off — deliberate)
gut    clawdguts-Mac-mini             en0 192.168.10.133   wifi 192.168.10.68
                          Bell GPON gateway  192.168.10.1  (the ONLY router + DHCP)
                          TP-Link Deco       — ACCESS POINT mode since 2026-08-12:
                                               bridges wifi onto the same subnet,
                                               no NAT, no DHCP (see cause 7)
```

Since 2026-08-12 the whole house is **one subnet** (`192.168.10.0/24`).
gut is still dual-homed (wire + wifi), but both interfaces land on the
same network now; Chrome prefers the ethernet adapter when both pair.
Service order on both machines puts Ethernet first, which is correct;
don't "fix" it.

**Ethernet is the working path: heart↔gut measures ~1.3ms.** Nothing else
is needed. Do not turn wifi off to "force" it — that was tried and broke
other things on the box.

### Thunderbolt Bridge — built, verified, then removed

Both are Mac minis with `bridge0` (members `en2/en3/en4`) already
configured. A Thunderbolt cable between them brings up a **40 Gb/s
point-to-point link** that no router, switch or DHCP touches. It was
built during the session and **failed exactly like ethernet did**, which
is what finally proved the fault could not be the network — a direct
cable has nothing in between to drop a packet.

The cable was pulled once ethernet was working. If you ever want it back:

```
# heart
sudo networksetup -setmanual "Thunderbolt Bridge" 10.99.0.1 255.255.255.0 ""
# gut
sudo networksetup -setmanual "Thunderbolt Bridge" 10.99.0.2 255.255.255.0 ""
```

Those static IPs are **still configured** on both machines, so the link is
plug-and-play. Three gotchas, all hit live:

1. **The BACK ports only.** On an M4 Mac mini the front USB-C ports are
   USB 3, not Thunderbolt. A charge-only cable in the right port fails
   the same as a good cable in the wrong one.
2. **A plain USB cable does nothing.** Thunderbolt Bridge needs an actual
   Thunderbolt/USB4 link. Verify with
   `system_profiler SPThunderboltDataType` — you want `Status: Device
   connected` and the other machine's model name.
3. **Don't leave it on link-local.** Both ends self-assign `169.254.x.x`,
   and `169.254/16` is routed on *three* interfaces on each machine, so
   replies leave by the wrong one. Static IPs on a subnet that exists
   nowhere else remove the ambiguity.

It is genuinely faster and never shares the NIC with OBS's RTMP push, but
at these bitrates ethernet is not the constraint. Reach for it only if
ethernet is unavailable.

---

## OBS control (this machine, profile `Rig2`)

obs-websocket v5 on `127.0.0.1:4455`. The password lives in OBS's own
config — **read it from there, never copy it anywhere**:

```
~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json
```

If `server_enabled` is `false`, Austin must turn it on by hand:
**Tools → WebSocket Server Settings → Enable**.

Useful requests: `GetVideoSettings`, `SetVideoSettings`,
`GetStats` (`outputSkippedFrames`, `activeFps`, `cpuUsage`),
`GetVirtualCamStatus`, `GetSceneItemList`, `SetSceneItemTransform`.

**Two traps:**

1. **`SetVideoSettings` fails while any output is active** — code 500,
   "Video settings cannot be changed while an output is active." Stop
   the Virtual Camera first, resize, then start it again. The Virtual
   Camera also negotiates its size with Chrome at start, so it must be
   restarted for a resolution change to reach the browser at all.
2. **Changing the canvas does not move scene items**, and rescaling them
   is not uniform. Transforms are in canvas pixels, so a 720p→1080p
   resize leaves everything bunched in the top-left. The correct per-item
   math, which cost one round of "the scenes look all fucked up":

   - `positionX/Y` — **always** scale (×1.5 for 720p→1080p).
   - `boundsType != OBS_BOUNDS_NONE` — OBS sizes the item from the bounds
     box and treats `scale` as derived. Scale **`boundsWidth/Height`
     only** and leave `scaleX/Y` alone. Scaling both applies the factor
     twice — on the Rig2 collection 9 of 11 items are bounded, so
     "uniformly scale everything" visibly wrecks nearly the whole layout.
   - `boundsType == OBS_BOUNDS_NONE` — scale `scaleX/Y`.
   - `crop*` — **never** scale. Crop is in source pixels, not canvas
     pixels.

   Rebuild from a pristine backup rather than scaling in place, so the
   operation is idempotent if it has to be re-run.

3. **The checked-in template has drifted from the live collection.**
   `Rig2.json.template` records `bounds_type: 0` for items that are
   bounded live — scenes have been edited by hand since the last
   install. Treat the live collection as the source of truth and
   regenerate the template from it (re-substituting `__HOME__`) rather
   than hand-patching, the next time the layout is known-good.

### The rig is generated from a template — patch both

`~/clawd/slop-computer-background/install.sh` regenerates the profile
and scene collection from:

```
rig/obs/profiles/Rig2/basic.ini        ← canvas resolution
rig/obs/scenes/Rig2.json.template      ← every scene item transform
```

A live OBS change is **reverted by a re-install** unless the template is
updated too, and updating only one of the two leaves 720p coordinates on
a 1080p canvas. `SLOP.app` runs `slop-setup.sh`, which does *not* touch
these — only `install.sh` does.

---

## Regression traps

Things that look like improvements and are not:

- **`maintain-resolution` on a camera.** Reads as "protect quality",
  actually means "drop to 2 fps before giving up one pixel". See
  `degradationFor()` in `usePeerMesh.ts` and the comment above it.
- **60 fps anywhere.** The broadcast composites at 30. Every frame above
  that is paid for and binned.
- **Raising resolution without checking the mesh cost.** 1080p is free
  solo and expensive with guests, because it is encoded once per person.
- **Trusting a local preview, a screenshot, or a `uiprobe` render.**
  Measure the `in` line on `/eq`, or the recording with ffmpeg.
- **Reading `relay Xms` as the media path.** It is signalling to AWS and
  is *supposed* to be 40–120ms. The media RTT is in `CONNECTION` and the
  ⓘ panels.
- **Tuning caps during a bad show and never revisiting them.** Every
  number in `usePeerMesh.ts` was correct for the conditions it was set
  in. Two of them were actively harmful an hour later (cause 6). When the
  bottleneck moves, re-read the caps.
- **Assuming a permission is granted because the app's toggle is on.**
  macOS attributes TCC to the *launching* process. Anything Chrome does
  when started from `slop-setup.sh` is judged as **iTerm**.
- **Debugging the network before ruling out TCC.** Two independent
  physical links failed identically here. Ping as user vs under `sudo`
  first; it takes 30 seconds.
- **Cutting guest tiles to protect the broadcast.** Tiles are what every
  other human in the room sees of you, and people enlarge windows. Cheap
  is right only while the uplink is actually scarce.
