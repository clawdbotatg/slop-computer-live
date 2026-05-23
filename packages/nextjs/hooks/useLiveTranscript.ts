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
};

// Web Speech can fire interim updates 5-10x per second on a fast
// speaker; ~10Hz is plenty for "feels real-time" without flooding the
// WS fanout. Finals always bypass the throttle so the locked text
// always reaches the wire.
const INTERIM_THROTTLE_MS = 100;

// "Recognizer hung" watchdog: if `enabled` is true but no result (interim
// or final) has fired in this long, declare the speaker dead. Web Speech
// usually emits at least an `onstart`+`onaudiostart` then nothing if the
// pipeline silently broke (rare, but happens after some Chrome updates).
// Set generously — we'd rather miss the fallback flip than over-react.
const HUNG_TIMEOUT_MS = 20_000;

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
      // Iterate from resultIndex — the browser may batch multiple
      // updates into a single event, and we'd otherwise re-emit earlier
      // results on repeats.
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const alt = r[0];
        const text = alt?.transcript ?? "";
        if (!text) continue;
        if (r.isFinal) {
          // Final: flush any pending interim of the same utterance
          // (we'd otherwise send "hello wo" interim then "hello world"
          // final out of order if a timer fires post-final).
          if (pendingTimerRef.current != null) {
            window.clearTimeout(pendingTimerRef.current);
            pendingTimerRef.current = null;
          }
          pendingInterimRef.current = null;
          sendLiveCaptionRef.current(text, true);
          setFinalCount(c => c + 1);
        } else {
          // Interim: throttle to ~10Hz. If we're within the cooldown,
          // hold the latest text and schedule a flush; if we're past
          // it, send immediately.
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
        }
      }
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

  return { supported, listening, lastError, finalCount };
}
