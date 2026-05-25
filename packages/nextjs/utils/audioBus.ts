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
  /** 0..4 (up to +12dB boost — auto-level needs the headroom to lift
   *  a quiet mic up to a loud one). */
  gain: number;
  muted: boolean;
};

export type AudioBusSnapshot = {
  masterGain: number;
  bands: EqBand[];
  sources: AudioBusSource[];
  /** When true, the bus is continuously adjusting source gains to
   *  match a target RMS — meters across all sources land at the same
   *  height. Manual gain adjustments from the popup turn this off. */
  autoEnabled: boolean;
};

// 6 peaking bands across the audible range. Same layout as Winamp /
// most consumer software EQs — gives "warmth/body/presence/air"
// without the cost of a full 10-band.
const BAND_FREQS = [60, 170, 350, 1000, 3500, 10000];

// BiquadFilter Q for peaking. ~1.0 is "musical" — wide enough that
// adjacent bands overlap so the slider response feels smooth.
const PEAKING_Q = 1.0;

const STORAGE_KEY = "slop-audio-bus-eq-v1";

// Auto-level tuning. These constants live in code on purpose — the
// popup checkbox just enables/disables; users don't get knobs for the
// target or the rates. Re-tune here if levels feel wrong in practice.
//
// Target post-gain RMS we drive every active source toward. 0.3 is
// "comfortable speech" — high enough to be clearly audible, low enough
// that a louder source can headroom past it without clipping.
const AUTO_TARGET_RMS = 0.3;
// Hard cap on per-source gain. 2× (+6dB) is the most we're willing to
// amplify ANY source. The temptation is to allow 4× so quiet mics get
// pulled all the way to target — but every dB of boost also boosts
// noise, and 4× turned background room hum into a constant whoosh.
// 2× keeps SNR sane; quiet speakers stay a touch quiet but aren't
// drowned in their own room noise.
const AUTO_GAIN_MAX = 2.0;
// Input RMS below this counts as "silence" — we hold the gain in
// place rather than continuing to lerp toward an absurd target. 0.075
// is above typical room ambience but still catches quieter
// speech — at 0.1 even fairly normal talking was being treated as
// silence and the auto wasn't engaging often enough.
const AUTO_NOISE_FLOOR = 0.075;
// Peak decay per tick (10Hz). 0.97 = -1.3 dB/tick = ~2.3s to half.
// Fast enough that going from a loud source to a quiet one re-
// converges in a few seconds, slow enough that a sentence with
// internal pauses keeps a stable peak. Silence-gate (above) means
// pure silence never decays the peak at all.
const AUTO_PEAK_DECAY = 0.97;
// Asymmetric ramp toward the auto-derived target. Down = ducking a
// hot signal; we want that fast so a loud burst doesn't blow past
// 0dBFS. Up = restoring a quiet signal; slower so a pause between
// sentences doesn't audibly crank the gain. Numbers are lerp
// factors per 100ms tick (10Hz). Effective settle times (to 90%):
//
//   DOWN ≈ 0.30 → ~0.6s
//   UP   ≈ 0.05 → ~4.5s
//
// Tweak in pairs — the asymmetry is the point. Re-tune if the tick
// rate changes; these are baked at 10Hz.
const AUTO_GAIN_LERP_DOWN = 0.3;
const AUTO_GAIN_LERP_UP = 0.05;
// Minimum change in desiredGain to bother emitting a snapshot. The
// auto loop fires 15× a second; without this throttle the popup is
// re-rendering for sub-percent gain wiggles. 0.02 ≈ 2 percentage
// points on the slider.
const AUTO_SNAPSHOT_EPSILON = 0.02;

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
  /** Rolling peak of post-gain RMS — input signal RMS / current gain
   *  so a gain change doesn't change the peak estimate of what's
   *  actually arriving from the source. Drives auto-level. */
  peakRms: number;
  /** Last snapshot-emitted desiredGain. Auto-loop diffs against this
   *  to decide whether the change is worth a snapshot push. */
  lastEmittedGain: number;
};

class AudioBusImpl {
  private ctx: AudioContext | null = null;
  /** Sum node: every source GainNode -> sumNode -> EQ chain -> master -> destination. */
  private sumNode: GainNode | null = null;
  private masterNode: GainNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private bands: EqBand[] = BAND_FREQS.map(freq => ({ freq, gain: 0 }));
  private masterGain = 1;
  /** When true the bus continuously adjusts each source's gain to
   *  match AUTO_TARGET_RMS. The popup checkbox toggles it; any manual
   *  set-source-gain (user dragging a slider) also flips it off. */
  private autoEnabled = true;
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
    this.loadPersistedAuto();
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
    this.sources.set(id, {
      id,
      label,
      gainNode,
      analyser,
      meterBuf,
      el,
      muted: false,
      desiredGain: 1,
      peakRms: 0,
      lastEmittedGain: 1,
    });
    this.emit();
    return true;
  }

  /** Build a meter tap. fftSize 256 + smoothing 0.7 gives reasonable
   *  RMS reads for the meter bars AND usable byte-frequency data for
   *  any consumer that wants a spectrum (the music player's visualizer
   *  reads getAnalyser("music") because its own createMediaElementSource
   *  would fight ours). */
  private makeMeter(ctx: AudioContext): { analyser: AnalyserNode; meterBuf: Uint8Array } {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    const meterBuf = new Uint8Array(analyser.fftSize);
    return { analyser, meterBuf };
  }

  /** Expose a source's AnalyserNode so consumers (music player's
   *  visualizer) can read frequency/time data. Returns null when the
   *  source isn't registered (bus not active, or different id). The
   *  node belongs to the bus — don't reconnect/disconnect it. */
  getAnalyser(id: string): AnalyserNode | null {
    return this.sources.get(id)?.analyser ?? null;
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
    this.sources.set(id, {
      id,
      label,
      gainNode,
      analyser,
      meterBuf,
      el: null,
      muted: false,
      desiredGain: 1,
      peakRms: 0,
      lastEmittedGain: 1,
    });
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

  /** User-origin gain change from the popup slider. Flips auto OFF so
   *  the manual value doesn't get clobbered on the next auto tick. */
  setSourceGain(id: string, gain: number): void {
    this.setAutoEnabled(false);
    this._setSourceGainInternal(id, gain);
    this.emit();
  }

  /** Internal: apply gain without disengaging auto. Called by the
   *  auto-level tick + the public setter above. */
  private _setSourceGainInternal(id: string, gain: number): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    const clamped = Math.max(0, Math.min(4, gain));
    entry.desiredGain = clamped;
    if (!entry.muted) entry.gainNode.gain.value = clamped;
  }

  setAutoEnabled(enabled: boolean): void {
    if (this.autoEnabled === enabled) return;
    this.autoEnabled = enabled;
    this.persistAuto();
    this.emit();
  }

  isAutoEnabled(): boolean {
    return this.autoEnabled;
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
   *  ~0.7). The popup uses these to render meter bars.
   *
   *  Side effect: also runs auto-level when enabled. We piggyback on
   *  the same analyser read so we only walk the source list + analyse
   *  the time-domain buffer ONCE per tick. */
  readLevels(): Record<string, number> {
    const out: Record<string, number> = {};
    let anyGainShifted = false;
    for (const entry of this.sources.values()) {
      entry.analyser.getByteTimeDomainData(entry.meterBuf);
      let sum = 0;
      const buf = entry.meterBuf;
      for (let i = 0; i < buf.length; i++) {
        const v = ((buf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const postGainRms = Math.sqrt(sum / buf.length);
      out[entry.id] = postGainRms;
      if (this.autoEnabled && !entry.muted) {
        if (this.tickAuto(entry, postGainRms)) anyGainShifted = true;
      }
    }
    // Snapshot only when auto-driven gains have drifted enough to
    // matter — otherwise we'd be re-emitting 15×/sec for sub-percent
    // wiggles. The popup still gets live meter bars every tick via
    // the levels message that wraps this call.
    if (anyGainShifted) this.emit();
    return out;
  }

  /** Run one auto-level step on a single source. Returns true when
   *  the desiredGain crossed AUTO_SNAPSHOT_EPSILON since the last
   *  emit — caller uses that as the snapshot-throttle signal. */
  private tickAuto(entry: SourceEntry, postGainRms: number): boolean {
    // Recover input RMS by dividing out current gain. Without this
    // the feedback loop is unstable: bumping gain raises the measured
    // RMS which leaves the gain pinned at its current value.
    const currentGain = Math.max(0.001, entry.gainNode.gain.value);
    const inputRms = postGainRms / currentGain;

    // HARD silence gate. When the source is below the noise floor we
    // do NOTHING — no peak update, no gain change. Previously the
    // gain kept slowly lerping toward `target/peak` during silence,
    // which over a few seconds cranks every quiet mic up to the cap
    // and turns room hum into a constant whoosh. Silence = freeze.
    if (inputRms < AUTO_NOISE_FLOOR) return false;

    // Audible — update the peak. Jump up instantly on a louder
    // sample; decay slowly toward the current sample when below peak.
    if (inputRms > entry.peakRms) {
      entry.peakRms = inputRms;
    } else {
      entry.peakRms *= AUTO_PEAK_DECAY;
    }
    if (entry.peakRms < AUTO_NOISE_FLOOR) return false;

    // 2× hard cap. We *could* boost a really quiet mic 4× to hit
    // target, but every dB of boost is also a dB of background noise
    // — capping at 2× keeps SNR sane. Quiet speakers stay slightly
    // quiet; that's the right trade-off.
    const targetGain = Math.max(0, Math.min(AUTO_GAIN_MAX, AUTO_TARGET_RMS / entry.peakRms));

    // Asymmetric ramp: fast down (ducks hot signals), slow up
    // (doesn't audibly hunt during pauses). See the const comments
    // for the time-constants.
    const lerp = targetGain < entry.desiredGain ? AUTO_GAIN_LERP_DOWN : AUTO_GAIN_LERP_UP;
    const newGain = entry.desiredGain + (targetGain - entry.desiredGain) * lerp;
    this._setSourceGainInternal(entry.id, newGain);
    if (Math.abs(newGain - entry.lastEmittedGain) > AUTO_SNAPSHOT_EPSILON) {
      entry.lastEmittedGain = newGain;
      return true;
    }
    return false;
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
      autoEnabled: this.autoEnabled,
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

  private persistAuto(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("slop-audio-bus-auto-v1", this.autoEnabled ? "1" : "0");
    } catch {
      /* quota / private mode */
    }
  }

  private loadPersistedAuto(): void {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("slop-audio-bus-auto-v1");
      if (raw === "0") this.autoEnabled = false;
      // raw === "1" or null both keep default true.
    } catch {
      /* ignore */
    }
  }

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
  | { type: "set-auto-enabled"; enabled: boolean }
  | { type: "reset-eq" };

export type BusOutboundMessage =
  | { type: "snapshot"; snapshot: AudioBusSnapshot }
  | { type: "levels"; levels: Record<string, number> };
