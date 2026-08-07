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
  /** 0..AUTO_GAIN_MAX (auto-level needs the headroom to lift a quiet
   *  mic up to a loud one). */
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
// Hard cap on per-source gain, tied to the silence gate below:
// AUTO_TARGET_RMS / AUTO_NOISE_FLOOR (0.3 / 0.015 = 20×, +26dB). The
// invariant is "any source loud enough to engage the auto at all can
// be lifted all the way to target." History: at 2× and again at 4×
// there was a dead zone — a voice quiet enough to need more boost
// than the cap stayed quiet forever (2026-08-01 show: WebRTC voices
// arrived at ~0.03 RMS, needed ~10×, got nothing because the old
// 0.05 floor also gated them out — see AUTO_NOISE_FLOOR). Runaway
// noise amplification is bounded by the silence gate: gain only
// moves while input is above the floor, and RNNoise upstream keeps
// mic ambience well under it. Exported for the /eq popup's slider
// range so manual + auto share one scale.
export const AUTO_GAIN_MAX = 20;
// Floor on auto-derived gain. -60dB — practically inaudible, but
// nonzero so postRms / gain stays well-defined when a source's
// userTargetScale is set to 0 (e.g. music volume slider all the way
// down). Without this floor, gain → 0 makes the input-estimate
// recovery divide-by-near-zero, the silence gate latches, and
// the source can't recover when the user raises volume back up.
const AUTO_GAIN_MIN = 0.001;
// Input RMS below this counts as "silence" — we hold the gain in
// place rather than continuing to lerp toward an absurd target.
// 0.015: quiet speech arriving over WebRTC really does measure
// ~0.03 RMS (2026-08-01 show — the old 0.05 floor sat ABOVE the
// hosts' voices, so the auto classified them as silence all night
// and broadcast them raw, ~13dB under the music). Published mics
// run through RNNoise, so their between-words ambience lands near
// zero; 0.015 keeps margin over that while catching voices ~2×
// quieter than that show's.
const AUTO_NOISE_FLOOR = 0.015;
// Peak decay per tick (10Hz). 0.95 = ~13s settle to half.
// During audible-but-below-peak the peak slowly relaxes so the auto
// can track a source that's getting quieter over time. Silence-gate
// above means pure silence never decays the peak at all.
const AUTO_PEAK_DECAY = 0.95;
// Asymmetric ramp toward the auto-derived target. Down = ducking a
// hot signal — needs to be fast so a music drop or screen-share
// burst doesn't blow past the mix. Up = boosting a quiet source —
// still slower than down so a pause between words doesn't audibly
// hunt, but fast enough that a new quiet source settles to balance
// within a couple of seconds (was ~4.5s, now ~1.5s).
//
//   DOWN ≈ 0.5 → ~0.4s to 90%
//   UP   ≈ 0.15 → ~1.5s to 90%
//
// Tweak in pairs — the asymmetry is the point. Re-tune if the tick
// rate changes; these are baked at 10Hz.
const AUTO_GAIN_LERP_DOWN = 0.5;
const AUTO_GAIN_LERP_UP = 0.15;
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
  /** The MediaStream this source's node was built from — null for
   *  element sources. `createMediaStreamSource` snapshots the stream's
   *  audio track at construction, so a source whose stream object has
   *  since been replaced is a DEAD node feeding silence into the mix.
   *  Recorded so the reconciler can spot that and rebuild. */
  stream: MediaStream | null;
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
  /** 0..1 — the source's "I want to be this loud in the mix"
   *  preference. The music player drives this with its volume
   *  slider so user volume reductions stick instead of getting
   *  cranked back up by the auto-leveler. Auto's effective target
   *  for this source is `AUTO_TARGET_RMS * userTargetScale`. */
  userTargetScale: number;
};

/** Source id the music player registers under (MusicPlayerWindow). The
 *  green room "solo music" mode keys off this. */
const MUSIC_SOURCE_ID = "music";

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
  /** While true, every source EXCEPT "music" is forced to silent gain so
   *  the broadcast mix carries ONLY the music bed. The god-mode green room
   *  / standby curtain turns this on: the operator + guest chat backstage,
   *  but the livestream only hears SlopAmp. Kept separate from per-source
   *  mute so it never clobbers the operator's manual EQ mutes. */
  private soloMusic = false;
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
      stream: null,
      muted: false,
      desiredGain: 1,
      peakRms: 0,
      lastEmittedGain: 1,
      userTargetScale: 1,
    });
    // A peer joining mid-green-room must come up silenced on the mix.
    this.applySoloGain(this.sources.get(id)!);
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
      stream,
      muted: false,
      desiredGain: 1,
      peakRms: 0,
      lastEmittedGain: 1,
      userTargetScale: 1,
    });
    // A peer joining mid-green-room must come up silenced on the mix.
    this.applySoloGain(this.sources.get(id)!);
    this.emit();
    return true;
  }

  /** True only when `id` is on the bus AND its node was built from
   *  exactly this MediaStream object. Anything else — absent, or backed
   *  by a stream object that has since been replaced — is a source that
   *  is not actually carrying this stream's audio, and the caller should
   *  unregister + re-register to rebuild the node.
   *
   *  Deliberately identity (===), not `.id`: replaceTrack hands out a
   *  brand-new MediaStream and the old node keeps pointing at the old,
   *  now-stopped track. */
  isStreamRegistered(id: string, stream: MediaStream): boolean {
    const entry = this.sources.get(id);
    return !!entry && entry.stream === stream;
  }

  /** Ids currently on the bus. For reconcilers that need to prune. */
  sourceIds(): string[] {
    return Array.from(this.sources.keys());
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
    const clamped = Math.max(0, Math.min(AUTO_GAIN_MAX, gain));
    entry.desiredGain = clamped;
    this.applySoloGain(entry);
  }

  /** Apply the current mute + solo-music state to one source's live gain.
   *  Solo wins: a non-music source is silent while soloMusic is on, even
   *  if the operator left it unmuted. */
  private applySoloGain(entry: SourceEntry): void {
    const silenced = entry.muted || (this.soloMusic && entry.id !== MUSIC_SOURCE_ID);
    entry.gainNode.gain.value = silenced ? 0 : entry.desiredGain;
  }

  /** Green room / standby: solo the music bed so the broadcast mix carries
   *  only SlopAmp — peer voices (operator + guest chatting backstage) are
   *  silenced on the god-mode mix WITHOUT muting them in the popup or
   *  affecting the peer-to-peer audio the participants hear directly. */
  setSoloMusic(enabled: boolean): void {
    if (this.soloMusic === enabled) return;
    this.soloMusic = enabled;
    for (const entry of this.sources.values()) this.applySoloGain(entry);
    this.emit();
  }

  /** Set the source's "I want to be this loud in the mix" preference
   *  (0..1). Auto-level treats `AUTO_TARGET_RMS * scale` as the
   *  effective target for this source. The music player calls this
   *  with its volume slider so user volume reductions stick instead
   *  of getting cranked back up by the auto. Not driven by the popup
   *  — separate concept from the bus's per-source manual gain slider. */
  setSourceTargetScale(id: string, scale: number): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    const clamped = Math.max(0, Math.min(1, scale));
    if (entry.userTargetScale === clamped) return;
    entry.userTargetScale = clamped;
    // No emit() — this isn't a popup-visible field. Auto-loop will
    // converge on the new target within a few ticks.
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
    this.applySoloGain(entry);
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
      // Skip auto-level for solo-silenced sources — otherwise the loop
      // would keep nudging their gain back up off zero.
      const soloSilenced = this.soloMusic && entry.id !== MUSIC_SOURCE_ID;
      if (this.autoEnabled && !entry.muted && !soloSilenced) {
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

    // Effective target = global target × source's user preference.
    // The music player drives userTargetScale with its volume slider
    // so turning music down actually keeps music down (instead of
    // the auto cranking gain to compensate for the lower input).
    // Cap on max gain prevents noise amplification on quiet mics.
    //
    // FLOOR at AUTO_GAIN_MIN, NOT 0. If gain reached exactly 0 the
    // post-gain analyser RMS would also be 0, the input estimate
    // (postRms / gain) would collapse, the silence gate would latch,
    // and we'd never recover when the user raised volume back up.
    // -60dB is "effectively muted" to the ear but keeps the bus
    // measuring the source so it can re-engage.
    const effectiveTarget = AUTO_TARGET_RMS * entry.userTargetScale;
    const rawTarget = effectiveTarget / entry.peakRms;
    const targetGain = Math.max(AUTO_GAIN_MIN, Math.min(AUTO_GAIN_MAX, rawTarget));

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

/** One row of the /eq popup's video-health section: a video publication
 *  with the publisher's own encode report (`out`, via the relay's
 *  `peer_video_stats` fanout) and what the spectator tab is actually
 *  receiving (`in`). Shapes mirror VideoStatSample / InboundVideoStats
 *  in usePeerMesh — duplicated structurally so the popup protocol
 *  doesn't import the mesh. */
export type VideoHealthRow = {
  key: string; // publication streamId
  label: string; // publisher display name
  kind: "camera" | "screen";
  out: {
    codec: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    kbps: number | null;
    qual: "none" | "cpu" | "bandwidth" | "other" | null;
    relayed: boolean | null;
    rttMs: number | null;
    at: number;
  } | null;
  in: {
    width: number | null;
    height: number | null;
    fps: number | null;
    kbps: number | null;
    at: number;
  } | null;
  /** Publisher's relay WS round-trip (the guest-list ping figure). */
  wsRttMs: number | null;
};

/** How well the god-mode tab itself is painting. Every row in
 *  VideoHealthRow describes a feed ARRIVING; this describes whether the
 *  machine OBS is capturing can actually draw what arrived.
 *
 *  Worth its own readout because the two failure modes look identical on
 *  the broadcast and have opposite fixes. On 2026-08-07 both guests'
 *  cameras dropped to ~2 fps at t=3652 while the locally-rendered news
 *  ticker — pure DOM, no network — dropped from 30 fps to 21 at the same
 *  instant. Feeds starving independently cannot do that in lockstep; a
 *  stalled compositor can. Without this row that took an hour of
 *  frame-by-frame forensics on the recording to establish. */
export type CompositeHealth = {
  /** requestAnimationFrame callbacks per second over the last window. */
  fps: number;
  /** Longest gap between consecutive frames in the window, ms. */
  worstFrameMs: number;
  /** Frames that took >100ms — visible hitches, not jitter. */
  hitches: number;
  /** rAF is throttled to ~0 when the tab is hidden or fully occluded, so
   *  a window covering the captured Chrome window reads as a dead
   *  composite rather than a mystery. */
  hidden: boolean;
  at: number;
};

export type BusOutboundMessage =
  | { type: "snapshot"; snapshot: AudioBusSnapshot }
  | { type: "levels"; levels: Record<string, number> }
  | { type: "video-stats"; rows: VideoHealthRow[] }
  | { type: "composite-health"; health: CompositeHealth };
