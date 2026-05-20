"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { withSlug } from "~~/lib/slug";

// Web Speech API → POST /v1/transcript. The hook intentionally does NOT
// own the "should we be listening?" decision — the caller passes `enabled`
// as the AND of (mic track unmuted) ∧ (track published to mesh) ∧ (user
// opted in to live transcript). This keeps gate logic in the component
// that already owns the audio track and avoids the hook silently listening
// because one of those gates was forgotten.
//
// Only FINAL results are posted. Interim results are noisy (the engine
// rewrites them mid-utterance) and would pollute the archive.
//
// Chrome auto-stops recognition after ~60s of audio or on silence, so the
// `onend` handler restarts whenever `enabled` is still true.

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
   *  and the user has opted in to live transcript. AND-ed with `episodeSttOn`
   *  inside the hook, so the host can disable transcription episode-wide
   *  without each peer toggling their mic. */
  enabled: boolean;
  /** Host-controlled per-episode flag, read from /v1/episode. When false,
   *  the hook stays dormant even if `enabled` is true — the show isn't on
   *  the record yet. */
  episodeSttOn: boolean;
  /** Relay base URL, e.g. `https://slop.computer`. Must match the same
   *  origin the user's session cookie is scoped to. */
  relayHttpUrl: string;
  /** Room slug, used to route transcript POSTs to the right room on the
   *  relay. Without this every per-room transcript would land in the
   *  default room's archive. */
  slug: string;
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
  /** Count of final segments posted in this hook's lifetime. Useful for
   *  the caller's debug UI ("3 segments posted"). */
  postedCount: number;
};

export function useLiveTranscript(opts: UseLiveTranscriptOptions): UseLiveTranscriptResult {
  const { enabled: rawEnabled, episodeSttOn, relayHttpUrl, slug, lang = "en-US", onError } = opts;
  // Hook is dormant unless BOTH the per-peer gate AND the episode-wide
  // STT flag are on. Either being false stops recognition.
  const enabled = rawEnabled && episodeSttOn;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [postedCount, setPostedCount] = useState(0);

  // Stable refs so the inner handlers see the latest values without
  // re-binding the entire recognizer on every render.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const relayUrlRef = useRef(relayHttpUrl);
  relayUrlRef.current = relayHttpUrl;
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const recRef = useRef<SpeechRecognition | null>(null);
  // Guards against double-start (Chrome throws "InvalidStateError" if you
  // call start() while a session is already active).
  const startingRef = useRef(false);

  const postSegment = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(withSlug(`${relayUrlRef.current}/v1/transcript`, slugRef.current), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      if (res.ok) {
        setPostedCount(c => c + 1);
      } else {
        const err = `transcript POST ${res.status}`;
        setLastError(err);
        onErrorRef.current?.(err);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setLastError(err);
      onErrorRef.current?.(err);
    }
  }, []);

  useEffect(() => {
    const Ctor = getSpeechRecognitionCtor();
    setSupported(Ctor !== null);
    if (!Ctor) return;

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.lang = lang;

    rec.onresult = ev => {
      // The browser may batch multiple finals into one event. Iterate from
      // resultIndex so we don't re-post earlier segments on repeat events.
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (!r.isFinal) continue;
        const alt = r[0];
        if (alt?.transcript) void postSegment(alt.transcript);
      }
    };

    rec.onerror = ev => {
      const err = ev.error || "unknown";
      setLastError(err);
      onErrorRef.current?.(err);
      // "no-speech" / "audio-capture" / "network" are transient — the
      // onend handler will restart if enabled. "not-allowed" / "aborted"
      // are terminal until the user retoggles enabled.
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
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    };
  }, [lang, postSegment]);

  // React to the enabled gate. We don't recreate the recognizer here —
  // we just start/stop the one created above.
  useEffect(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (enabled) {
      if (startingRef.current || listening) return;
      try {
        startingRef.current = true;
        rec.start();
        setListening(true);
        setLastError(null);
      } catch (e) {
        startingRef.current = false;
        const err = e instanceof Error ? e.message : String(e);
        setLastError(err);
        onErrorRef.current?.(err);
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
    }
  }, [enabled, listening]);

  return { supported, listening, lastError, postedCount };
}
