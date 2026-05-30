"use client";

import { useEffect, useRef, useState } from "react";

// Per-browser Web Speech API → live caption broadcast over the room WS.
// Replaces the HTTP-POST transcript path with a faster, low-latency
// channel: interim results land within ~200ms of speech, so viewers see
// the speaker's words rip across the screen as they're said — much
// faster than the god-mode Whisper pipeline (~3-5s after speech end).
//
// God-mode STT still runs the room's canonical archive (manifest
// transcript). The server suppresses god-mode's `transcript_seg`
// broadcast for any speaker whose `live_caption_state {alive}` is
// currently true, so viewers never see both lanes paint the same
// utterance — but the archive is untouched.
//
// Failure model: if Web Speech isn't available (Firefox) or the
// recognizer dies fatally (permission denied, "aborted", repeated
// errors), the hook emits `live_caption_state {alive:false}` and the
// server falls back to broadcasting god-mode's segments. Sticky until
// the speaker rejoins (or the hook successfully restarts).

type RecognitionAlternative = { transcript: string; confidence: number };
type RecognitionResult = {
  isFinal: boolean;
  0: RecognitionAlternative;
  length: number;
};
type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<RecognitionResult> & { [i: number]: RecognitionResult };
};
type RecognitionErrorEvent = { error: string; message?: string };
type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: RecognitionEvent) => void) | null;
  onerror: ((ev: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type UseLiveTranscriptOptions = {
  /** Master gate — set true ONLY when the peer's mic is unmuted, published,
   *  and the user hasn't opted out of captions. AND-ed with `episodeSttOn`
   *  inside the hook, so the host can disable the captions pipeline
   *  episode-wide without each peer toggling their mic. */
  enabled: boolean;
  /** Host-controlled per-episode flag, read from /v1/episode. When false,
   *  the hook stays dormant even if `enabled` is true. */
  episodeSttOn: boolean;
  /** Mesh WS connection state. We re-emit our latest alive flag every
   *  time the socket reopens — the server clears its per-speaker
   *  arbitration map on disconnect (sticky-until-rejoin), so without
   *  the re-emit a reconnected speaker silently falls back to god-mode
   *  captions for the rest of the session. */
  meshConnected: boolean;
  /** Push a `live_caption` frame on the room WS. Pre-bound (no slug
   *  needed) — the hook just hands off the text + isFinal flag. */
  sendLiveCaption: (text: string, isFinal: boolean) => void;
  /** Tell the server whether this peer's Web Speech pipeline is alive.
   *  Drives god-mode caption fallback. */
  sendLiveCaptionState: (alive: boolean) => void;
  /** BCP-47 language tag. Defaults to "en-US". */
  lang?: string;
  /** Fired on a transient (auto-restarted) or terminal recognition error. */
  onError?: (err: string) => void;
};

export type UseLiveTranscriptResult = {
  /** False on Firefox / older Safari where Web Speech isn't available. */
  supported: boolean;
  /** True while a SpeechRecognition session is currently running. */
  listening: boolean;
  /** Last error string ("no-speech", "not-allowed", etc.), or null. */
  lastError: string | null;
  /** Count of final segments emitted in this hook's lifetime. */
  finalCount: number;
  /** Monotonically-incrementing counter — bumps once per onresult event
   *  (interim or final). Lets the UI flash a "result just fired" pulse
   *  so the speaker can visually confirm Web Speech is producing output
   *  word-by-word rather than only finalizing on pause. */
  resultTick: number;
};

// Throttle is a guard, not a target. Chrome's own onresult cadence is
// the actual gate — typically 100-300ms between updates while a speaker
// is mid-word. Setting this floor to 33ms (~30Hz) means we never delay
// a Chrome-emitted interim, but a runaway recognizer (some Android
// builds) won't flood the WS either. Each interim is ~50-150 bytes;
// even at 30Hz that's <5KB/s per speaker — trivial.
const INTERIM_THROTTLE_MS = 33;

// "Recognizer hung" watchdog: if `enabled` is true but no result (interim
// or final) has fired in this long, declare the speaker dead. Web Speech
// usually emits at least an `onstart`+`onaudiostart` then nothing if the
// pipeline silently broke (rare, but happens after some Chrome updates).
// Set generously — we'd rather miss the fallback flip than over-react.
const HUNG_TIMEOUT_MS = 20_000;

// A single utterance arrives from Web Speech as a stream of partial
// results that revise + re-segment as you talk — say "yo yo yo" then
// "check check" and the recognizer may hand back just "check" for a beat
// before re-merging. Emitting each fragment as its own caption frame made
// the on-screen line flutter (drop to the latest fragment, then snap back
// to the whole phrase). Instead we keep a per-line buffer: finalized words
// accumulate, the live interim tail is appended, and we emit ONE additive
// string. The line is locked as a FINAL (and reset for the next one) only
// after the speaker goes quiet — i.e. on a real pause.
//
// The quiet-gap STAIRCASES DOWN as the line grows: a short line waits
// for a generous pause (natural sentence break), but a long line snaps
// on the first half-beat. This avoids the LINE_MAX_CHARS tail truncation
// where the viewer sees a leading "…" and loses the head of the
// sentence — we'd rather lock early and start a fresh line than let
// the head fall off the end. Past WORD_FORCE_BREAK words the timer alone
// isn't enough: a true nonstop talker emits interim events faster than
// the gap, so the timer is re-armed before it can fire and the line
// never breaks. At that point we force a hard break (see onresult).
function lineQuietMsForWords(wordCount: number): number {
  if (wordCount >= 6) return 50;
  if (wordCount >= 5) return 100;
  if (wordCount >= 4) return 150;
  if (wordCount >= 3) return 200;
  if (wordCount >= 2) return 300;
  if (wordCount >= 1) return 400;
  return 500;
}
// Hard break: a line this long with NO pause at all gets locked
// immediately and a fresh line started, regardless of whether the
// speaker ever goes quiet. Backstop for the nonstop-monologue case the
// quiet-gap timer can't catch.
const WORD_FORCE_BREAK = 7;
// Soft cap so a long unbroken monologue doesn't grow the line forever; we
// keep the most recent chars (the visible tail of a one-line subtitle).
const LINE_MAX_CHARS = 220;

export function useLiveTranscript(opts: UseLiveTranscriptOptions): UseLiveTranscriptResult {
  const {
    enabled: rawEnabled,
    episodeSttOn,
    meshConnected,
    sendLiveCaption,
    sendLiveCaptionState,
    lang = "en-US",
    onError,
  } = opts;
  // Hook is dormant unless BOTH the per-peer gate AND the episode-wide
  // STT flag are on. Either being false stops recognition.
  const enabled = rawEnabled && episodeSttOn;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [finalCount, setFinalCount] = useState(0);
  const [resultTick, setResultTick] = useState(0);

  // Stable refs so the inner handlers see the latest values without
  // re-binding the entire recognizer on every render.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const sendLiveCaptionRef = useRef(sendLiveCaption);
  sendLiveCaptionRef.current = sendLiveCaption;
  const sendStateRef = useRef(sendLiveCaptionState);
  sendStateRef.current = sendLiveCaptionState;

  const recRef = useRef<SpeechRecognition | null>(null);
  // Guards against double-start (Chrome throws "InvalidStateError" if you
  // call start() while a session is already active).
  const startingRef = useRef(false);
  // Track the alive flag the server thinks we're in, so we don't spam
  // identical state frames on every minor event. NOTE: this is the
  // server's *believed* state — reset to null on reconnect since the
  // server clears its arbitration map when our peer disconnects, and
  // the next live event must re-prime it.
  const aliveSentRef = useRef<boolean | null>(null);
  // Independently track the alive flag we *want* the server to know,
  // so the reconnect effect can re-emit it without recomputing from
  // recognizer state. Initialized lazily when we first decide.
  const aliveDesiredRef = useRef<boolean | null>(null);

  // Interim throttle: hold the latest pending interim until either
  // INTERIM_THROTTLE_MS elapses or a final lands (which we flush
  // immediately). Plain timestamp throttle — no setTimeout chase — so
  // we never delay the final write.
  const lastInterimSentAtRef = useRef(0);
  const pendingInterimRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const lastResultAtRef = useRef(0);
  // Per-line accumulation (see LINE_QUIET_MS above). `lineRef` holds the
  // finalized words of the current line; `lastDisplayRef` holds the latest
  // line+interim string actually shown, so the quiet-gap finalizer locks
  // exactly what the viewer last saw (interim tail included).
  const lineRef = useRef("");
  const lastDisplayRef = useRef("");
  const quietTimerRef = useRef<number | null>(null);
  // Set true between a forced hard break (rec.stop) and the recognizer's
  // restart (onend). Chrome keeps the pre-stop interim in its buffer and
  // re-emits it as a trailing final/interim; we ignore everything until
  // the bounce completes so those locked words don't reappear.
  const suppressUntilRestartRef = useRef(false);

  const setAlive = (alive: boolean) => {
    aliveDesiredRef.current = alive;
    if (aliveSentRef.current === alive) return;
    aliveSentRef.current = alive;
    sendStateRef.current(alive);
  };

  const flushPendingInterim = () => {
    const pending = pendingInterimRef.current;
    pendingInterimRef.current = null;
    if (pendingTimerRef.current != null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (pending && pending.trim()) {
      lastInterimSentAtRef.current = Date.now();
      sendLiveCaptionRef.current(pending, false);
    }
  };

  // Throttled interim send: ship immediately once past the cooldown,
  // otherwise hold the latest text for flushPendingInterim to drain. Keeps
  // a chatty recognizer from flooding the WS without ever delaying beyond
  // INTERIM_THROTTLE_MS.
  const queueInterim = (text: string) => {
    const now = Date.now();
    const since = now - lastInterimSentAtRef.current;
    if (since >= INTERIM_THROTTLE_MS) {
      lastInterimSentAtRef.current = now;
      sendLiveCaptionRef.current(text, false);
      pendingInterimRef.current = null;
    } else {
      pendingInterimRef.current = text;
      if (pendingTimerRef.current == null) {
        pendingTimerRef.current = window.setTimeout(flushPendingInterim, INTERIM_THROTTLE_MS - since);
      }
    }
  };

  // Lock `finalText` as a FINAL caption and reset the per-line buffer for
  // the next line. Shared by the quiet-gap timer (natural pause) and the
  // forced hard break (WORD_FORCE_BREAK). Clearing the throttled interim
  // keeps a stale partial from immediately overwriting the final.
  const lockLine = (finalText: string) => {
    lineRef.current = "";
    lastDisplayRef.current = "";
    if (!finalText) return;
    if (pendingTimerRef.current != null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    pendingInterimRef.current = null;
    sendLiveCaptionRef.current(finalText, true);
    setFinalCount(c => c + 1);
  };

  // Drop the current line buffer + pending quiet-gap finalize WITHOUT
  // emitting. Used on teardown and on mute (enabled→false): a half-spoken
  // line must not lock in after the user has muted.
  const resetLine = () => {
    if (quietTimerRef.current != null) {
      window.clearTimeout(quietTimerRef.current);
      quietTimerRef.current = null;
    }
    suppressUntilRestartRef.current = false;
    lineRef.current = "";
    lastDisplayRef.current = "";
  };

  useEffect(() => {
    const Ctor = getSpeechRecognitionCtor();
    setSupported(Ctor !== null);
    if (!Ctor) {
      // Firefox / unsupported — tell the server immediately so god-mode
      // takes the captions slot for this speaker. Wrapped in a deferred
      // microtask via setTimeout(0) so we don't fire during initial
      // render before the WS is open; the send helper noops if so but
      // the hook's intent is clearer.
      const id = window.setTimeout(() => setAlive(false), 0);
      return () => window.clearTimeout(id);
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = lang;

    rec.onresult = ev => {
      lastResultAtRef.current = Date.now();
      // Bump the visible-pulse counter so the menubar 🎙️ flashes on
      // every recognition event. Cheap React update — single integer.
      setResultTick(c => c + 1);

      // We forced a hard break and are waiting for the recognizer to
      // bounce — ignore the trailing pre-stop results so the words we
      // just locked don't re-render. Cleared in onend at the restart.
      if (suppressUntilRestartRef.current) return;

      // Split this event's results (from resultIndex — earlier ones are
      // already locked) into newly-finalized words and the still-forming
      // interim tail. A result flips isFinal exactly once and resultIndex
      // advances past it afterward, so each final is counted once.
      let newlyFinal = "";
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = (r[0]?.transcript ?? "").trim();
        if (!t) continue;
        if (r.isFinal) newlyFinal = newlyFinal ? `${newlyFinal} ${t}` : t;
        else interim = interim ? `${interim} ${t}` : t;
      }

      // Commit finalized words to the line, then render line + interim —
      // ADDITIVE, so the caption never flickers back to just the latest
      // fragment ("yo yo yo" stays put while "check check" is appended).
      if (newlyFinal) {
        lineRef.current = lineRef.current ? `${lineRef.current} ${newlyFinal}` : newlyFinal;
        if (lineRef.current.length > LINE_MAX_CHARS) {
          // Keep the tail; strip the leading partial word the slice cut.
          lineRef.current = lineRef.current.slice(-LINE_MAX_CHARS).replace(/^\S*\s/, "");
        }
      }
      const display = (
        lineRef.current && interim ? `${lineRef.current} ${interim}` : lineRef.current || interim
      ).trim();
      if (!display) return;
      lastDisplayRef.current = display;
      queueInterim(display);

      // (Re)arm the quiet-gap finalizer. While results keep flowing the
      // line stays interim (dim, no dwell); once the speaker pauses we
      // lock exactly what's on screen as a FINAL (full opacity + HOLD_MS
      // dwell, then fade) and start a fresh line. The gap scales down
      // with line length so long monologues snap on shorter pauses.
      if (quietTimerRef.current != null) {
        window.clearTimeout(quietTimerRef.current);
        quietTimerRef.current = null;
      }
      const wordCount = display ? display.split(/\s+/).length : 0;

      // Hard break: a nonstop talker never gives the quiet timer a gap to
      // fire in (each interim event re-arms it), so once the line hits
      // WORD_FORCE_BREAK words we lock it NOW and bounce the recognizer.
      // The bounce is the only way to clear Chrome's interim buffer —
      // without it the same words would re-stream and re-trigger forever.
      if (wordCount >= WORD_FORCE_BREAK) {
        lockLine(display);
        suppressUntilRestartRef.current = true;
        try {
          rec.stop(); // onend auto-restarts a fresh, empty utterance
        } catch {
          suppressUntilRestartRef.current = false;
        }
        return;
      }

      const quietMs = lineQuietMsForWords(wordCount);
      quietTimerRef.current = window.setTimeout(() => {
        quietTimerRef.current = null;
        lockLine(lastDisplayRef.current.trim());
      }, quietMs);
    };

    rec.onerror = ev => {
      const err = ev.error || "unknown";
      setLastError(err);
      onErrorRef.current?.(err);
      // Terminal errors: declare dead so god-mode fills the gap.
      // Transient ones (no-speech, network blips) ride out — `onend`
      // restarts and lastResultAtRef will refresh once results return.
      if (err === "not-allowed" || err === "service-not-allowed") {
        setAlive(false);
      }
    };

    rec.onend = () => {
      setListening(false);
      startingRef.current = false;
      // Bounce complete (whether from a forced hard break or Chrome's own
      // ~60s cut) — the interim buffer is gone, so stop suppressing.
      suppressUntilRestartRef.current = false;
      if (enabledRef.current) {
        // Chrome cuts the session at ~60s of audio or on silence; restart
        // immediately so the speaker doesn't have to retoggle anything.
        try {
          startingRef.current = true;
          rec.start();
          setListening(true);
        } catch {
          startingRef.current = false;
        }
      }
    };

    recRef.current = rec;
    return () => {
      recRef.current = null;
      if (pendingTimerRef.current != null) {
        window.clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      pendingInterimRef.current = null;
      resetLine();
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    };
    // setAlive is intentionally not a dep — it's a stable inline closure
    // that reads from refs; including it would cause the recognizer to
    // tear down on every state ref tick.
  }, [lang]);

  // React to the enabled gate. We don't recreate the recognizer here —
  // we just start/stop the one created above.
  useEffect(() => {
    const rec = recRef.current;
    if (!rec) {
      // No recognizer at all (Firefox) — already declared dead in the
      // setup effect above. Nothing to do here.
      return;
    }
    if (enabled) {
      if (startingRef.current || listening) return;
      try {
        startingRef.current = true;
        rec.start();
        setListening(true);
        setLastError(null);
        // Optimistically declare alive — the server flips to "godmode"
        // only on explicit dead signal, so this is the bit that keeps
        // god-mode broadcasts suppressed while we're running.
        setAlive(true);
        lastResultAtRef.current = Date.now();
      } catch (e) {
        startingRef.current = false;
        const err = e instanceof Error ? e.message : String(e);
        setLastError(err);
        onErrorRef.current?.(err);
        setAlive(false);
      }
    } else {
      // abort() drops in-flight results; stop() would flush them. We
      // pick abort because the most common reason `enabled` flips to
      // false is "user just muted themselves" — and the whole point of
      // muting is for peers (and the archive) not to hear what they're
      // saying right now. A half-uttered sentence finalized AFTER the
      // mute click would defeat that.
      try {
        rec.abort();
      } catch {
        /* not running */
      }
      // Mute mid-sentence: drop the half-spoken line so it can't lock in
      // as a final after the user muted (matches the abort-not-stop choice).
      resetLine();
      // Mute is NOT "dead" — the speaker can unmute at any moment and
      // the local STT pipeline is still healthy. Keep alive=true so
      // the server keeps suppressing god-mode for them; the mute path
      // means neither lane will broadcast for this speaker until they
      // unmute (god-mode VAD also goes silent on `enabled=false`
      // tracks since track.enabled=false emits silence).
    }
  }, [enabled, listening]);

  // Watchdog for the silent-failure case: recognizer started but no
  // result event has fired in HUNG_TIMEOUT_MS while we expected speech.
  // This is the "Chrome update broke the recognizer mid-session"
  // safety net — without it the speaker would just silently stop
  // appearing in captions for the rest of the session.
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      const since = Date.now() - lastResultAtRef.current;
      if (since > HUNG_TIMEOUT_MS && aliveSentRef.current === true) {
        // Don't flip back to alive automatically — sticky-until-rejoin.
        setAlive(false);
      }
    }, 5_000);
    return () => window.clearInterval(id);
  }, [enabled]);

  // WS reconnect handling. Two scenarios this covers:
  //   1. Initial open race: the gate effect may call setAlive(true)
  //      before the mesh WS is OPEN; usePeerMesh's send() drops sends
  //      while not-OPEN. Without this re-emit the server never learns
  //      the speaker has local STT and keeps broadcasting god-mode.
  //   2. Mid-session reconnect: the server clears its arbitration map
  //      on peer disconnect (sticky-until-rejoin), so the rejoined
  //      peer must re-prime the flag.
  // Either way: every false→true edge of meshConnected, force-send
  // whatever state aliveDesiredRef holds.
  useEffect(() => {
    if (!meshConnected) {
      // Server forgets us on disconnect; flip the *sent* shadow so the
      // next reconnect re-emits even if the desired state hasn't changed.
      aliveSentRef.current = null;
      return;
    }
    const desired = aliveDesiredRef.current;
    if (desired == null) return;
    aliveSentRef.current = desired;
    sendStateRef.current(desired);
  }, [meshConnected]);

  return { supported, listening, lastError, finalCount, resultTick };
}
