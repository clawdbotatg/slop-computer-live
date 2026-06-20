// Poker-table sound effects via the Web Audio API. Two kinds of source:
//   • FOLEY (chips, card flicks, deal, fold) = real CC0 recordings from Kenney's
//     "Casino Audio" pack, served as mono MP3 from /public/sounds/poker. These
//     used to be synthesized and read as "alien" — a recording of clay chips is
//     just clay chips, so we play the real thing.
//   • TONAL cues (felt tap on check, slider tick, win chime) = still synthesized;
//     those are simple and sound right generated on the fly.
// Both play through one master gain, so mute/volume cover everything. PokerWindow
// diffs the public game state and calls these so the whole table is audible.
//
// Browsers won't let an AudioContext make sound until a user gesture, so the
// first local interaction with the table unlocks it AND warms the sample cache
// (see unlockPokerAudio), so the first bet isn't silent.

const MUTE_KEY = "slop-poker-muted-v1";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;

export function isPokerMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return muted;
  }
}

export function setPokerMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* private mode — keep the in-memory flag */
  }
}

// Build the context+graph ONCE without resuming it. A freshly-built context is
// "suspended" until a user gesture, but that's fine for everything except actual
// playback: decodeAudioData works on a suspended context, so this is all we need
// to warm the sample cache on load. Returns null if Web Audio is unavailable.
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
      muted = isPokerMuted();
    } catch {
      ctx = null;
      master = null;
      return null;
    }
  }
  return { c: ctx, m: master };
}

// Same, but also resume — call this on/after a user gesture and when actually
// making sound. Resuming a suspended context needs a gesture; before one it's a
// harmless no-op.
function audio(): { c: AudioContext; m: GainNode } | null {
  const a = ensureAudio();
  if (a && a.c.state === "suspended") void a.c.resume();
  return a;
}

// Warm the sample cache: fetch + decode every foley clip ahead of time so the
// first bet/flip/deal isn't silent. Safe to call on load (e.g. when the poker
// window mounts) WITHOUT a user gesture — decoding doesn't need a running
// context. Idempotent; loadSample dedupes so repeat calls are free.
export function warmPokerAudio(): void {
  const a = ensureAudio();
  if (!a) return;
  for (const u of ALL_SAMPLES) loadSample(a.c, u);
}

// Call from a real user gesture (a pointerdown on the table) to unlock audio for
// playback. Also warms the cache, in case warmPokerAudio() hasn't run yet.
export function unlockPokerAudio(): void {
  const a = audio();
  if (!a) return;
  for (const u of ALL_SAMPLES) loadSample(a.c, u);
}

// ─── Recorded samples (CC0, Kenney "Casino Audio") ───────────────────
// Foley cues are real recordings. Files live under /public/sounds/poker as mono
// MP3 (universal browser support — .ogg won't decode on Safari/iOS). Each is
// decoded once into an AudioBuffer and played through the master gain, so the
// mute flag and volume still apply. Several variants per cue → natural variation
// (a different chip clack every bet) the old synth faked with randomness.
const SOUNDS_BASE = "/sounds/poker";
const CHIP_BET = [1, 2, 3, 4, 5, 6].map(n => `${SOUNDS_BASE}/chips-stack-${n}.mp3`);
const CARD_SLIDE = [1, 2, 3, 4, 5, 6].map(n => `${SOUNDS_BASE}/card-slide-${n}.mp3`);
const CARD_SHOVE = [1, 2, 3, 4].map(n => `${SOUNDS_BASE}/card-shove-${n}.mp3`);
const DEAL = `${SOUNDS_BASE}/deal.mp3`;
const ALL_SAMPLES = [...CHIP_BET, ...CARD_SLIDE, ...CARD_SHOVE, DEAL];

const buffers = new Map<string, AudioBuffer>();
const loadingSamples = new Set<string>();

function loadSample(c: AudioContext, url: string): void {
  if (buffers.has(url) || loadingSamples.has(url)) return;
  loadingSamples.add(url);
  fetch(url)
    .then(r => r.arrayBuffer())
    .then(b => c.decodeAudioData(b))
    .then(buf => void buffers.set(url, buf))
    .catch(() => {
      /* missing/undecodable sample — that cue just stays silent rather than throwing */
    })
    .finally(() => loadingSamples.delete(url));
}

// Play a decoded sample through the master gain. If it isn't decoded yet (only
// possible before unlock warms the cache), kick off a load so the next trigger
// has it, and skip this one. `when` offsets the start (for staggering a flop).
function playSample(url: string, gain = 1, when = 0): void {
  const a = audio();
  if (!a) return;
  const buf = buffers.get(url);
  if (!buf) {
    loadSample(a.c, url);
    return;
  }
  const src = a.c.createBufferSource();
  src.buffer = buf;
  const g = a.c.createGain();
  g.gain.value = gain;
  src.connect(g).connect(a.m);
  src.start(a.c.currentTime + when);
}

function playRandomSample(pool: string[], gain = 1): void {
  playSample(pool[Math.floor(Math.random() * pool.length)], gain);
}

function noise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.4), c.sampleRate);
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
};

// A short shaped burst of filtered noise — the workhorse for clicks/flicks.
function burst(c: AudioContext, m: GainNode, t0: number, dur: number, o: BurstOpts): void {
  const { type = "bandpass", freq = 1000, q = 1, gain = 0.3, sweepTo = null } = o;
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
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(m);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// A pitched tone with a soft pluck envelope — for the win chime.
function tone(
  c: AudioContext,
  m: GainNode,
  t0: number,
  freq: number,
  dur: number,
  gain: number,
  type: OscillatorType,
): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(m);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// ─── Public effects ──────────────────────────────────────────────────

// Check — knuckles rapped on the felt: a woody thump + a faint click.
export function sfxCheck(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  const osc = a.c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(190, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.07);
  const g = a.c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(g).connect(a.m);
  osc.start(t);
  osc.stop(t + 0.14);
  burst(a.c, a.m, t, 0.03, { type: "highpass", freq: 1600, gain: 0.14 });
}

// Bet / call / raise / blinds — real clay chips set onto a stack (Kenney CC0,
// one of six recorded variants picked at random so no two bets sound identical).
export function sfxChips(): void {
  if (muted) return;
  playRandomSample(CHIP_BET, 0.9);
}

// A single dry detent click — the bet slider snapping one big-blind notch. Tiny
// and crisp so dragging it feels like a clicky dial rather than a smooth glide.
export function sfxTick(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  burst(a.c, a.m, t, 0.012, { type: "highpass", freq: 2600, gain: 0.07 });
}

// A card (or a whole flop) flicked onto the felt — a real card slide per card,
// each a random variant, staggered so a flop reads as three distinct cards.
export function sfxCardFlip(count = 1): void {
  if (muted) return;
  const cards = Math.max(1, Math.min(5, count));
  for (let i = 0; i < cards; i++) {
    const url = CARD_SLIDE[Math.floor(Math.random() * CARD_SLIDE.length)];
    playSample(url, 0.8, i * 0.12);
  }
}

// The cards being dealt out around the table — a quick flurry of real card
// slides (cards pitched to each seat), staggered so you hear several land.
// Distinct from the shuffle riffle that precedes it: that's the deck being
// mixed, this is the deck being dealt.
export function sfxDeal(): void {
  if (muted) return;
  for (let i = 0; i < 5; i++) {
    const url = CARD_SLIDE[Math.floor(Math.random() * CARD_SLIDE.length)];
    playSample(url, 0.8, i * 0.09);
  }
}

// Between hands — a real card shuffle: the full deck-riffle recording (the same
// CC0 clip we ship as deal.mp3, which is literally a deck being riffled). Played
// at full length and volume so the between-hands curtain has an unmistakable,
// audible shuffle — NOT the old synthesized version, which was too quiet to
// hear. Pair with sfxDeal() on the curtain lift.
export function sfxShuffle(): void {
  if (muted) return;
  playSample(DEAL, 0.95);
}

// Fold — cards mucked, a real card shove across the felt (random variant).
export function sfxFold(): void {
  if (muted) return;
  playRandomSample(CARD_SHOVE, 0.8);
}

// Win — a bright two-note chime over a cascade of chips being pushed across.
export function sfxWin(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  tone(a.c, a.m, t, 660, 0.18, 0.24, "triangle");
  tone(a.c, a.m, t + 0.12, 988, 0.5, 0.2, "triangle");
  for (let i = 0; i < 11; i++) {
    const dt = i * 0.025 + Math.random() * 0.02;
    burst(a.c, a.m, t + dt, 0.04, { type: "bandpass", freq: 2400 + Math.random() * 2600, q: 6, gain: 0.11 });
  }
}
