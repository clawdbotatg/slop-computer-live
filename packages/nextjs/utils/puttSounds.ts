// Putt-Putt (mini golf) sound effects via the Web Audio API. Unlike the poker
// table — whose chips/cards are real foley recordings — every putt cue is
// SYNTHESIZED on the fly: a putter knock, a cup rattle-and-drop, a water
// sploosh, a sand thud, and a brick clunk are all short, percussive, and read
// right generated from noise bursts + a couple of pitched blips. Keeping them
// synthetic means no audio assets to ship and every shot sounds a touch
// different (the bursts carry their own random pitch jitter).
//
// PuttWindow diffs the relay's public snapshot stream (positions + status +
// strokes, no velocity, no collision events) and calls these — exactly the
// poker pattern — so the whole course is audible to every client, not just the
// player taking the shot. See PuttWindow's sound effect useEffect for which
// snapshot transition fires which cue.
//
// Browsers gate an AudioContext behind a user gesture, so the first local
// interaction (tapping the course / the mute toggle) unlocks playback via
// unlockPuttAudio. There are no samples to warm — synthesis needs only the
// (resumed) context — so unlock is all the warm-up there is.

const MUTE_KEY = "slop-putt-muted-v1";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;

export function isPuttMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return muted;
  }
}

export function setPuttMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* private mode — keep the in-memory flag */
  }
}

// Build the context+graph ONCE without resuming it (a fresh context is
// "suspended" until a user gesture). Returns null if Web Audio is unavailable.
function ensureAudio(): { c: AudioContext; m: GainNode } | null {
  if (typeof window === "undefined") return null;
  if (!ctx || !master) {
    const AC =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      muted = isPuttMuted();
    } catch {
      ctx = null;
      master = null;
      return null;
    }
  }
  return { c: ctx, m: master };
}

// Ensure the context AND resume it — call on/after a user gesture and whenever
// actually making sound. Resuming a suspended context needs a gesture; before
// one it's a harmless no-op.
function audio(): { c: AudioContext; m: GainNode } | null {
  const a = ensureAudio();
  if (a && a.c.state === "suspended") void a.c.resume();
  return a;
}

// Unlock audio for playback from a real user gesture (a pointerdown on the
// course or the mute toggle). All cues are synthesized, so there's nothing to
// preload — resuming the context is the whole job.
export function unlockPuttAudio(): void {
  void audio();
}

function noise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    // 1s of noise — long enough that the extended bursts (the big water
    // splooosh's ~0.6s tail) play out fully without the source running dry.
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

type BurstOpts = {
  type?: BiquadFilterType;
  freq?: number;
  q?: number;
  gain?: number;
  sweepTo?: number | null;
  attack?: number;
};

// A short shaped burst of filtered noise — the workhorse for impacts, splashes
// and grit. A frequency sweep (sweepTo) gives water its falling "sploosh" and a
// knock its quick decay; `attack` softens the onset (sand) or leaves it sharp
// (brick).
function burst(c: AudioContext, m: GainNode, t0: number, dur: number, o: BurstOpts): void {
  const { type = "bandpass", freq = 1000, q = 1, gain = 0.3, sweepTo = null, attack = 0.004 } = o;
  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(m);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// A pitched tone with a soft pluck envelope — the woody knock under a putter
// hit / brick clunk and the hollow plonk of the cup. An optional pitch sweep
// (sweepTo) makes a tom-like "pock".
function tone(
  c: AudioContext,
  m: GainNode,
  t0: number,
  freq: number,
  dur: number,
  gain: number,
  type: OscillatorType,
  sweepTo: number | null = null,
): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(m);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// ─── Public effects ──────────────────────────────────────────────────

// Putter face meeting the ball — a crisp, dry "tok": a short woody pock (a
// quick downward-swept triangle) under a tight click of high noise. Power
// scales the loudness a little so a big drive reads harder than a tap putt.
export function sfxPutterHit(power = 1): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  const g = 0.4 + 0.35 * Math.min(1, Math.max(0, power));
  tone(a.c, a.m, t, 230, 0.07, g, "triangle", 95);
  burst(a.c, a.m, t, 0.025, { type: "highpass", freq: 2400, gain: 0.16 * g });
}

// Ball dropping in the cup — the classic mini-golf reward: a quick rim rattle
// (two or three bright descending clicks) settling into a hollow plonk down the
// pipe, with a faint up-chime so sinking it feels good.
export function sfxCupDrop(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  // Rim rattle — a few quick bandpass clicks, each a touch lower/quieter.
  for (let i = 0; i < 3; i++) {
    const dt = i * 0.045;
    burst(a.c, a.m, t + dt, 0.04, { type: "bandpass", freq: 2000 - i * 380, q: 5, gain: 0.16 - i * 0.03 });
  }
  // Hollow plonk down the cup.
  tone(a.c, a.m, t + 0.16, 150, 0.22, 0.34, "sine", 70);
  // Faint reward chime over the top.
  tone(a.c, a.m, t + 0.18, 880, 0.16, 0.1, "triangle");
  tone(a.c, a.m, t + 0.26, 1320, 0.22, 0.08, "triangle");
}

// Ball into the water — a big "SPLOOOSH". Layered so it reads as real water
// being displaced, not a thin tick: a deep sub-thump as the ball punches the
// surface, a long full-bodied wash of filtered noise sweeping from open down to
// a dark watery low (the displaced water + spray), a brighter foam/droplet
// layer over the plunge, a high wash of settling ripples, and a gurgle of
// bubbles rising at random pitches through the tail.
export function sfxWaterSplash(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const { c, m } = a;
  const t = c.currentTime;
  // Heavy plunge: a deep sub thump for the heft of the ball hitting the water.
  tone(c, m, t, 155, 0.2, 0.28, "sine", 52);
  // The main body of the splooosh — a big, long sweep from open down to a
  // watery low. This is the bulk of the sound; the long tail sells the size.
  burst(c, m, t, 0.62, { type: "lowpass", freq: 2600, q: 0.8, gain: 0.46, sweepTo: 260, attack: 0.008 });
  // Foam / droplets sprayed up on impact — a brighter bandpass layer on top.
  burst(c, m, t + 0.01, 0.46, { type: "bandpass", freq: 1500, q: 0.9, gain: 0.24, sweepTo: 480, attack: 0.006 });
  // The spray settling back — a soft high wash sweeping up and fading out.
  burst(c, m, t + 0.18, 0.42, { type: "highpass", freq: 1700, gain: 0.1, sweepTo: 900 });
  // Gurgle: a handful of bubbles rising (pitch sweeps upward) through the wake.
  for (let i = 0; i < 5; i++) {
    const dt = 0.12 + i * 0.07 + Math.random() * 0.04;
    const f0 = 220 + Math.random() * 220;
    tone(c, m, t + dt, f0, 0.1, 0.07, "sine", f0 + 180 + Math.random() * 160);
  }
}

// Ball burying in a bunker — a dull, soft "fff/thud", no pitch: sand absorbs
// everything, so just a low, gently-attacked lowpass puff. Quiet by design.
export function sfxSandThud(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  burst(a.c, a.m, t, 0.18, { type: "lowpass", freq: 480, q: 0.6, gain: 0.22, sweepTo: 180, attack: 0.02 });
  burst(a.c, a.m, t + 0.01, 0.1, { type: "bandpass", freq: 1600, q: 0.8, gain: 0.05, attack: 0.012 });
}

// Ball clunking off a brick wall / border / windmill — a hard, woody "clack":
// a tight high-Q noise click plus a low knock under it. `intensity` (0..1,
// from the impact speed) scales the loudness so a glancing kiss is a tick and a
// hard carom is a crack.
export function sfxBrickClunk(intensity = 1): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  const k = Math.min(1, Math.max(0.25, intensity));
  burst(a.c, a.m, t, 0.05, { type: "bandpass", freq: 1100 + Math.random() * 300, q: 6, gain: 0.26 * k });
  tone(a.c, a.m, t, 150, 0.06, 0.22 * k, "triangle", 90);
}
