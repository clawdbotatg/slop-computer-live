// Shared Web Audio mixer + master EQ used by the god-mode (spectator)
// streaming session to equalize the outgoing tab audio.
//
// Every audio source in the tab (peer voices, music player, file
// previews) registers its HTMLMediaElement here when god mode is on.
// We wrap each element in a MediaElementAudioSourceNode so its
// playback is rerouted through this AudioContext, then sum everything
// through a 6-band peaking EQ + master gain into ctx.destination —
// which is what Chromium's tab capture / OS audio sink picks up for
// ffmpeg to push to the RTMP endpoint.
//
// IMPORTANT — createMediaElementSource is one-way: once an element is
// connected to a source node, its audio is forever routed through that
// AudioContext (per the spec). So we only register elements in god-
// mode sessions, and never try to detach. Non-spectator viewers keep
// their current direct-to-default-output behavior unchanged.
//
// The /eq popup window talks to this module via BroadcastChannel; see
// the channel constant + message shapes at the bottom of the file.

export type EqBand = {
  /** Hz center frequency. Fixed at construction. */
  freq: number;
  /** dB, -12..+12. Mutable; setBandGain writes here + the BiquadFilterNode. */
  gain: number;
};

export type AudioBusSource = {
  id: string;
  label: string;
  /** 0..1.5 (allow ~+3.5dB boost above unity). UI clamps to 0..1.5. */
  gain: number;
  muted: boolean;
};

export type AudioBusSnapshot = {
  masterGain: number;
  bands: EqBand[];
  sources: AudioBusSource[];
};

// 6 peaking bands across the audible range. Same layout as Winamp /
// most consumer software EQs — gives "warmth/body/presence/air"
// without the cost of a full 10-band.
const BAND_FREQS = [60, 170, 350, 1000, 3500, 10000];

// BiquadFilter Q for peaking. ~1.0 is "musical" — wide enough that
// adjacent bands overlap so the slider response feels smooth.
const PEAKING_Q = 1.0;

const STORAGE_KEY = "slop-audio-bus-eq-v1";

type SourceEntry = {
  id: string;
  label: string;
  gainNode: GainNode;
  /** Tap on the post-gain signal so meters reflect what actually
   *  contributes to the mix — moving the source's gain slider
   *  immediately shows up in the meter. */
  analyser: AnalyserNode;
  /** Reused time-domain buffer to avoid per-tick allocation. */
  meterBuf: Uint8Array;
  /** Truly null when registerStream was used (no element exists). */
  el: HTMLMediaElement | null;
  muted: boolean;
  /** Cached user-set gain so unmute can restore it instead of snapping to 1. */
  desiredGain: number;
};

class AudioBusImpl {
  private ctx: AudioContext | null = null;
  /** Sum node: every source GainNode -> sumNode -> EQ chain -> master -> destination. */
  private sumNode: GainNode | null = null;
  private masterNode: GainNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private bands: EqBand[] = BAND_FREQS.map(freq => ({ freq, gain: 0 }));
  private masterGain = 1;
  private sources = new Map<string, SourceEntry>();
  /** Anti-duplicate guard: once an element has been wrapped in a
   *  MediaElementSourceNode it must never be wrapped again (browser
   *  throws InvalidStateError). Tracks elements across re-registers. */
  private wrappedElements = new WeakSet<HTMLMediaElement>();
  private listeners = new Set<(snap: AudioBusSnapshot) => void>();
  /** True when we're alive on the page. Setting false in unmount paths
   *  stops snapshot broadcasts. */
  private active = false;

  // --- lifecycle ---

  activate(): void {
    if (this.active) return;
    this.active = true;
    if (typeof window === "undefined") return;
    if (!this.ctx) this.ensureContext();
    // Reload persisted EQ state — masters love their tuning sticking
    // across browser-host bounces.
    this.loadPersisted();
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    type AudioContextCtor = new () => AudioContext;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.ctx = ctx;
    // Build the master chain: sum -> filter[0] -> ... -> filter[N-1] -> master -> destination
    this.sumNode = ctx.createGain();
    this.sumNode.gain.value = 1;
    this.filters = this.bands.map(b => {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = b.freq;
      f.Q.value = PEAKING_Q;
      f.gain.value = b.gain;
      return f;
    });
    this.masterNode = ctx.createGain();
    this.masterNode.gain.value = this.masterGain;
    // Wire it up.
    let prev: AudioNode = this.sumNode;
    for (const f of this.filters) {
      prev.connect(f);
      prev = f;
    }
    prev.connect(this.masterNode);
    this.masterNode.connect(ctx.destination);
    return ctx;
  }

  /** Resume the AudioContext on a user gesture — browsers refuse to
   *  start audio without one. Wired to slop:activated in
   *  AudioBusProvider so a single click anywhere kicks playback. */
  resume(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }

  // --- source registration ---

  /** Route an HTMLMediaElement through the bus. Idempotent: a second
   *  call with the same element silently no-ops (browser would throw).
   *  Returns true if the element is now (or was already) on the bus. */
  registerElement(el: HTMLMediaElement, id: string, label: string): boolean {
    if (!this.active) return false;
    const ctx = this.ensureContext();
    if (!ctx || !this.sumNode) return false;
    const existing = this.sources.get(id);
    if (existing && existing.el === el) {
      // Same element re-registering with the same id — relabel + re-attach.
      existing.label = label;
      this.emit();
      return true;
    }
    if (this.wrappedElements.has(el)) {
      // Different id but element already wrapped elsewhere in this
      // session. Without a back-reference we can't re-bind cleanly;
      // refuse rather than throw an InvalidStateError.
      return false;
    }
    let src: MediaElementAudioSourceNode;
    try {
      src = ctx.createMediaElementSource(el);
    } catch {
      return false;
    }
    this.wrappedElements.add(el);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    const { analyser, meterBuf } = this.makeMeter(ctx);
    src.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(this.sumNode);
    this.sources.set(id, { id, label, gainNode, analyser, meterBuf, el, muted: false, desiredGain: 1 });
    this.emit();
    return true;
  }

  /** Build a meter tap. Small FFT (256) — we only need RMS, not
   *  spectrum, so the cheapest analyser that still gives reliable
   *  time-domain data is plenty. */
  private makeMeter(ctx: AudioContext): { analyser: AnalyserNode; meterBuf: Uint8Array } {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;
    const meterBuf = new Uint8Array(analyser.fftSize);
    return { analyser, meterBuf };
  }

  /** Route a raw MediaStream through the bus. Used when no audio
   *  element exists (rare — most peer voices play via <audio>). */
  registerStream(stream: MediaStream, id: string, label: string): boolean {
    if (!this.active) return false;
    const ctx = this.ensureContext();
    if (!ctx || !this.sumNode) return false;
    if (this.sources.has(id)) return true;
    let src: MediaStreamAudioSourceNode;
    try {
      src = ctx.createMediaStreamSource(stream);
    } catch {
      return false;
    }
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    const { analyser, meterBuf } = this.makeMeter(ctx);
    src.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(this.sumNode);
    this.sources.set(id, { id, label, gainNode, analyser, meterBuf, el: null, muted: false, desiredGain: 1 });
    this.emit();
    return true;
  }

  unregister(id: string): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    try {
      entry.gainNode.disconnect();
    } catch {
      /* already gone */
    }
    try {
      entry.analyser.disconnect();
    } catch {
      /* already gone */
    }
    this.sources.delete(id);
    this.emit();
  }

  setSourceLabel(id: string, label: string): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    if (entry.label === label) return;
    entry.label = label;
    this.emit();
  }

  // --- mutations from the /eq popup ---

  setSourceGain(id: string, gain: number): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    const clamped = Math.max(0, Math.min(1.5, gain));
    entry.desiredGain = clamped;
    if (!entry.muted) entry.gainNode.gain.value = clamped;
    this.emit();
  }

  setSourceMuted(id: string, muted: boolean): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    entry.muted = muted;
    entry.gainNode.gain.value = muted ? 0 : entry.desiredGain;
    this.emit();
  }

  setBandGain(bandIndex: number, db: number): void {
    if (bandIndex < 0 || bandIndex >= this.bands.length) return;
    const clamped = Math.max(-12, Math.min(12, db));
    const band = this.bands[bandIndex];
    if (!band) return;
    band.gain = clamped;
    const f = this.filters[bandIndex];
    if (f) f.gain.value = clamped;
    this.persist();
    this.emit();
  }

  setMasterGain(gain: number): void {
    const clamped = Math.max(0, Math.min(1.5, gain));
    this.masterGain = clamped;
    if (this.masterNode) this.masterNode.gain.value = clamped;
    this.persist();
    this.emit();
  }

  resetEq(): void {
    for (let i = 0; i < this.bands.length; i++) this.setBandGain(i, 0);
    this.setMasterGain(1);
  }

  // --- snapshots ---

  /** Read post-gain RMS for every active source. Returns a plain
   *  record so it serializes cleanly across BroadcastChannel. Values
   *  are 0..1 (perceptual headroom — speech peaks ~0.3, hot music
   *  ~0.7). The popup uses these to render meter bars. */
  readLevels(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.sources.values()) {
      entry.analyser.getByteTimeDomainData(entry.meterBuf);
      let sum = 0;
      const buf = entry.meterBuf;
      for (let i = 0; i < buf.length; i++) {
        const v = ((buf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      out[entry.id] = Math.sqrt(sum / buf.length);
    }
    return out;
  }

  snapshot(): AudioBusSnapshot {
    return {
      masterGain: this.masterGain,
      bands: this.bands.map(b => ({ freq: b.freq, gain: b.gain })),
      sources: Array.from(this.sources.values()).map(s => ({
        id: s.id,
        label: s.label,
        gain: s.desiredGain,
        muted: s.muted,
      })),
    };
  }

  subscribe(fn: (snap: AudioBusSnapshot) => void): () => void {
    this.listeners.add(fn);
    // Fire immediately so subscribers get current state on attach.
    try {
      fn(this.snapshot());
    } catch {
      /* listener bug — don't crash the bus */
    }
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    if (!this.active) return;
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* listener bug — keep going */
      }
    }
  }

  // --- persistence (EQ only, not per-source gain — sources come and go) ---

  private persist(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          masterGain: this.masterGain,
          bands: this.bands.map(b => b.gain),
        }),
      );
    } catch {
      /* quota / private mode */
    }
  }

  private loadPersisted(): void {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { masterGain?: number; bands?: number[] };
      if (typeof parsed.masterGain === "number" && Number.isFinite(parsed.masterGain)) {
        this.setMasterGain(parsed.masterGain);
      }
      if (Array.isArray(parsed.bands)) {
        for (let i = 0; i < parsed.bands.length && i < this.bands.length; i++) {
          const v = parsed.bands[i];
          if (typeof v === "number" && Number.isFinite(v)) this.setBandGain(i, v);
        }
      }
    } catch {
      /* corrupt — ignore */
    }
  }
}

// Singleton per page. Sharing across tabs happens via BroadcastChannel,
// not a shared instance — each tab has its own AudioContext + graph
// because Web Audio is window-scoped.
let _bus: AudioBusImpl | null = null;
export function audioBus(): AudioBusImpl {
  if (!_bus) _bus = new AudioBusImpl();
  return _bus;
}

// --- BroadcastChannel protocol ---
//
// The /eq popup speaks to the opener tab over this channel. Either side
// may post. The opener owns the bus state; the popup is a view + mutator.

export const AUDIO_BUS_CHANNEL = "slop-audio-bus-v1";

export type BusInboundMessage =
  | { type: "request-snapshot" }
  | { type: "set-source-gain"; id: string; gain: number }
  | { type: "set-source-muted"; id: string; muted: boolean }
  | { type: "set-band-gain"; bandIndex: number; db: number }
  | { type: "set-master-gain"; gain: number }
  | { type: "reset-eq" };

export type BusOutboundMessage =
  | { type: "snapshot"; snapshot: AudioBusSnapshot }
  | { type: "levels"; levels: Record<string, number> };
