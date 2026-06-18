// Synthesized poker-table sound effects via the Web Audio API. There are NO
// audio assets — every sound (chip clatter, felt tap, card flick, deal riffle,
// muck swish, win chime) is generated on the fly, so there is nothing to
// download or commit. The PokerWindow diffs the public game state and calls
// these so the whole table is audible: chips when anyone pushes money in, a
// tap when someone checks, card flicks as the board comes out, a chime on a win.
//
// Browsers won't let an AudioContext make sound until a user gesture, so the
// first local interaction with the table unlocks it (see unlockPokerAudio).

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

// Build (once) and resume the context. Returns the graph, or null if Web Audio
// is unavailable. Honours the mute flag separately so callers can no-op early.
function audio(): { c: AudioContext; m: GainNode } | null {
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
  if (ctx.state === "suspended") void ctx.resume();
  return { c: ctx, m: master };
}

// Call from a real user gesture (a pointerdown on the table) to unlock audio.
export function unlockPokerAudio(): void {
  audio();
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

// Bet / call / raise / blinds — clay chips clacking onto a stack.
//
// Lesson from three bad takes: ANYTHING that holds a pitch here sings, and a
// few of them at slightly different pitches *warble* — that warble is the
// "alien" sound. High-Q filter rings do it; oscillator tones do it. So this
// has NEITHER. Clay is a hard, damped material: it makes sharp, dry clacks
// with a short low-mid body and no ring whatsoever. Built entirely from very
// short filtered-noise transients — nothing in here can sustain a pitch long
// enough to warble. The low-mid body (~300-600 Hz) is what separates a chip
// "clack" from the card riffle's high-frequency hiss (so it can't be the deal).
export function sfxChips(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;

  // A soft low thump as the stack meets the felt — lowpassed noise (NOT a tone),
  // so it adds weight without a pitched "boom".
  burst(a.c, a.m, t, 0.05, { type: "lowpass", freq: 220, q: 0.7, gain: 0.16 });

  // The clacks. Each chip = a brief bright contact click over a short, dull
  // low-mid clay body. Both are low-Q (a click, not a tone). Bunched tight and
  // slightly irregular = a stack settling; energy eases off toward the tail.
  const n = 6 + Math.floor(Math.random() * 4); // 6-9 chips
  let dt = 0;
  for (let i = 0; i < n; i++) {
    const settle = 1 - (i / n) * 0.6; // earliest clacks loudest
    // Contact click — brief, bright, broadband (low Q ⇒ a tick, never a pitch).
    burst(a.c, a.m, t + dt, 0.01, {
      type: "bandpass",
      freq: 2200 + Math.random() * 1200,
      q: 0.9,
      gain: (0.16 + Math.random() * 0.08) * settle,
    });
    // Clay body — short, dull, low-mid "clack". This is what says CHIP not card.
    burst(a.c, a.m, t + dt, 0.028, {
      type: "bandpass",
      freq: 320 + Math.random() * 260,
      q: 2.0,
      gain: (0.3 + Math.random() * 0.12) * settle,
    });
    dt += 0.016 + Math.random() * 0.022; // tight, irregular clatter
  }
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

// A card (or a whole flop) flicked onto the felt.
export function sfxCardFlip(count = 1): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  const cards = Math.max(1, Math.min(5, count));
  for (let i = 0; i < cards; i++) {
    burst(a.c, a.m, t + i * 0.11, 0.07, { type: "highpass", freq: 1200, gain: 0.22, sweepTo: 5000 });
  }
}

// Start of a hand — a quick riffle/deal.
export function sfxDeal(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  for (let i = 0; i < 11; i++) {
    burst(a.c, a.m, t + i * 0.027, 0.02, { type: "highpass", freq: 2000, gain: 0.11 });
  }
}

// Fold — cards mucked, a soft downward swish.
export function sfxFold(): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.c.currentTime;
  burst(a.c, a.m, t, 0.16, { type: "bandpass", freq: 1600, q: 0.7, gain: 0.16, sweepTo: 480 });
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
