"use client";

import { useEffect, useRef, useState } from "react";
import type { Peer, PeerMeshState, Publication } from "./usePeerMesh";
import { withSlug } from "~~/lib/slug";

// God-mode server-side STT pipeline.
//
// The "god-mode" client (the headed Chrome streaming box) is already a
// full-mesh WebRTC peer that receives every other peer's audio. Instead
// of every browser running its own Web Speech recognizer — which only
// works on Chrome/Safari — the god-mode peer transcribes everyone's
// audio centrally and POSTs each segment to /v1/transcript/relay tagged
// with the speaker's address.
//
// Why each Web Speech browser doesn't suffice: Firefox + older Safari
// silently no-op the API. Moving STT to the one machine we control
// (and that we know runs Chrome) gives universal coverage. The price
// is that god-mode being down means no transcription — but god-mode
// being down also means no broadcast, so the failure mode is shared.
//
// Per-track pipeline:
//   AudioContext.createMediaStreamSource(track)
//     → AnalyserNode (RMS polled @ ~20Hz for a cheap voice-activity gate)
//     → MediaRecorder (started on speech-open, stopped on speech-close)
//     → fetch POST /v1/transcript/relay?address=…&handle=…
//
// VAD intentionally simple — energy threshold with hysteresis. Mute
// "just works" because track.enabled=false emits silence frames, which
// stay below VAD_OPEN_RMS forever, so muted peers never trigger a
// recording. No need to broadcast mute state through the relay.

// Tuning: too-quiet open thresholds capture HVAC; too-loud close
// thresholds clip the tail of words. These came from ear-tweaking on a
// noisy home office with a USB condenser mic — adjust if it turns out
// to truncate the last syllable of utterances on production.
const VAD_OPEN_RMS = 0.025;
const VAD_CLOSE_RMS = 0.012;
const VAD_HANG_MS = 700;
const MIN_SEGMENT_MS = 350;
const MAX_SEGMENT_MS = 14_000;
const POLL_MS = 50;
// MediaRecorder timeslice — controlling how often `ondataavailable`
// fires. We don't actually need intermediate chunks (we send on stop),
// but a small slice makes the final `stop()` deterministic on Firefox
// where the codec writer otherwise buffers a long tail. Doesn't affect
// the resulting blob's size.
const RECORDER_TIMESLICE_MS = 250;

export type UseGodModeSttOptions = {
  /** Master gate. Pass true only when the local session is god-mode
   *  (session.spectator === true) AND the episode has STT turned on. */
  enabled: boolean;
  /** Mesh state — we read remoteStreams + publications + peers from it. */
  mesh: PeerMeshState;
  /** Relay base URL — should be the same origin the god-mode session
   *  cookie is scoped to. */
  relayHttpUrl: string;
  /** Room slug for /v1/transcript/relay routing. */
  slug: string;
  /** BCP-47 language hint passed through to the STT model. Optional. */
  lang?: string;
};

export type UseGodModeSttResult = {
  /** True whenever the pipeline has at least one MediaRecorder open
   *  for an audio track — i.e. someone in the room is talking and we're
   *  actively capturing them. Used by the menubar 🛰️ indicator. */
  listening: boolean;
  /** Cumulative count of segments successfully uploaded since the hook
   *  mounted. Useful for a debug panel; never reset. */
  uploaded: number;
  /** Last upload error, if any. */
  lastError: string | null;
};

type TranscriberHandle = {
  trackId: string;
  stop: () => void;
};

export function useGodModeStt(opts: UseGodModeSttOptions): UseGodModeSttResult {
  const { enabled, mesh, relayHttpUrl, slug, lang } = opts;

  const [listening, setListening] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  // Map<peerId, handle>. Keyed by PEER, not track — because a single
  // speaker frequently publishes multiple audio tracks at once: the
  // dedicated "audio" mic publication AND the audio sub-track bundled
  // inside the "camera" publication. Both carry the same physical mic
  // signal, so transcribing both produced two slightly-different
  // Whisper transcripts per utterance (since Whisper isn't bit-exact
  // run-to-run) — which is the duplication bug observed in prod.
  // One transcriber per peer guarantees one OpenAI call per
  // utterance, eliminating the source of those near-duplicates.
  const transcribersRef = useRef<Map<string, { trackId: string; handle: TranscriberHandle }>>(new Map());

  // Active-recording counter — bumped/decremented as MediaRecorders
  // open and close. `listening` is derived from this.
  const activeRecordingsRef = useRef(0);
  const bumpActive = (delta: number) => {
    activeRecordingsRef.current += delta;
    const now = activeRecordingsRef.current > 0;
    setListening(prev => (prev === now ? prev : now));
  };

  // Refs holding the latest mesh state — the per-track polling loops
  // close over these so they see updated publications without having
  // to tear down and rebuild on every mesh tick.
  const publicationsRef = useRef<Publication[]>(mesh.publications);
  publicationsRef.current = mesh.publications;
  const peersRef = useRef<Peer[]>(mesh.peers);
  peersRef.current = mesh.peers;
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const relayUrlRef = useRef(relayHttpUrl);
  relayUrlRef.current = relayHttpUrl;
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    if (!enabled) {
      // Tear down everything when god-mode disengages (rare — usually
      // either always-on or always-off for the lifetime of the page).
      for (const entry of transcribersRef.current.values()) entry.handle.stop();
      transcribersRef.current.clear();
      activeRecordingsRef.current = 0;
      setListening(false);
      return;
    }

    // Pick one canonical audio source per speaker. Iteration order:
    // publications first (so we can read `kind` + peerId attribution),
    // preferring the dedicated "audio" mic publication over the
    // camera's bundled audio sub-track. If a peer only publishes
    // camera (no separate mic share), we still get them — the camera
    // entry is kept as a fallback.
    const chosenByPeer = new Map<string, { peerId: string; streamId: string; track: MediaStreamTrack }>();
    for (const pub of mesh.publications) {
      if (pub.kind !== "audio" && pub.kind !== "camera") continue;
      const stream = mesh.remoteStreams.get(pub.streamId);
      if (!stream) continue;
      const audioTrack = stream.getAudioTracks().find(t => t.readyState === "live");
      if (!audioTrack) continue;
      const existing = chosenByPeer.get(pub.peerId);
      if (!existing) {
        chosenByPeer.set(pub.peerId, { peerId: pub.peerId, streamId: pub.streamId, track: audioTrack });
        continue;
      }
      // Upgrade camera→audio when a dedicated mic publication arrives
      // for the same peer (sharper signal, no video-pipeline routing).
      if (pub.kind === "audio") {
        const existingPub = mesh.publications.find(p => p.streamId === existing.streamId);
        if (existingPub?.kind === "camera") {
          chosenByPeer.set(pub.peerId, { peerId: pub.peerId, streamId: pub.streamId, track: audioTrack });
        }
      }
    }

    // Reconcile: start a transcriber for each chosen (peer, track)
    // that doesn't have one yet; tear down anything that no longer
    // matches the current peer→track map (peer left, swapped from
    // camera to audio publication, etc.).
    for (const { peerId, streamId, track } of chosenByPeer.values()) {
      const existing = transcribersRef.current.get(peerId);
      if (existing && existing.trackId === track.id) continue;
      if (existing) existing.handle.stop();
      const handle = startTranscriberForTrack({
        track,
        getSpeakerIdentity: () => lookupSpeaker(streamId, publicationsRef.current, peersRef.current),
        upload: (blob, identity) =>
          uploadSegment({
            blob,
            identity,
            relayUrl: relayUrlRef.current,
            slug: slugRef.current,
            lang: langRef.current,
            onSuccess: () => setUploaded(c => c + 1),
            onError: err => setLastError(err),
          }),
        onRecordingOpen: () => bumpActive(1),
        onRecordingClose: () => bumpActive(-1),
      });
      transcribersRef.current.set(peerId, { trackId: track.id, handle });
    }

    // Stop transcribers for peers that disappeared (left the room,
    // unpublished all audio, etc.).
    for (const [peerId, entry] of transcribersRef.current) {
      if (!chosenByPeer.has(peerId)) {
        entry.handle.stop();
        transcribersRef.current.delete(peerId);
      }
    }
  }, [enabled, mesh.remoteStreams, mesh.publications]);

  // Cleanup on unmount — stop every active transcriber so we don't
  // leak AudioContexts after the god-mode tab navigates away.
  useEffect(
    () => () => {
      for (const entry of transcribersRef.current.values()) entry.handle.stop();
      transcribersRef.current.clear();
      activeRecordingsRef.current = 0;
    },
    [],
  );

  return { listening, uploaded, lastError };
}

function lookupSpeaker(
  streamId: string,
  publications: Publication[],
  peers: Peer[],
): { address: string | null; handle: string | null } {
  const pub = publications.find(p => p.streamId === streamId);
  if (!pub) return { address: null, handle: null };
  const peer = peers.find(p => p.id === pub.peerId);
  if (!peer) {
    // Publication exists but the peer hasn't been reconciled yet (or
    // already left). Use ownerKey as a best-effort fallback — it's
    // either an ETH address or a handle, so we sniff the shape.
    const isAddr = /^0x[a-f0-9]{40}$/i.test(pub.ownerKey);
    return {
      address: isAddr ? pub.ownerKey.toLowerCase() : null,
      handle: isAddr ? null : pub.ownerKey,
    };
  }
  return { address: peer.address ?? null, handle: peer.handle ?? null };
}

type StartArgs = {
  track: MediaStreamTrack;
  getSpeakerIdentity: () => { address: string | null; handle: string | null };
  upload: (blob: Blob, identity: { address: string | null; handle: string | null }) => void;
  onRecordingOpen: () => void;
  onRecordingClose: () => void;
};

function startTranscriberForTrack(args: StartArgs): TranscriberHandle {
  const { track, getSpeakerIdentity, upload, onRecordingOpen, onRecordingClose } = args;

  // Isolated MediaStream containing just the audio track — feeds both
  // the analyser and the recorder without dragging along any video
  // sibling tracks the publication might carry.
  const audioOnly = new MediaStream([track]);

  // Audio graph for VAD. AudioContext can't auto-start without a user
  // gesture, but god-mode UA is a real interactive Chrome session that
  // clicked into the page to enter the god-mode URL, so the gesture
  // requirement is satisfied by the time this hook runs.
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sampleBuffer: Float32Array | null = null;
  try {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(audioOnly);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    sampleBuffer = new Float32Array(analyser.fftSize);
  } catch (err) {
    console.warn("[godStt] AudioContext setup failed", err);
  }

  let recorder: MediaRecorder | null = null;
  let recording = false;
  let segmentChunks: Blob[] = [];
  let segmentStartedAt = 0;
  let lastLoudAt = 0;
  let stopped = false;
  let lockedIdentity: { address: string | null; handle: string | null } | null = null;

  const closeRecording = () => {
    if (!recording || !recorder) return;
    recording = false;
    onRecordingClose();
    try {
      // requestData() forces a final ondataavailable before stop(),
      // which on some Chromium builds otherwise emits an empty trailing
      // dataavailable after stop() has resolved.
      recorder.requestData();
    } catch {
      /* not supported / not recording */
    }
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  };

  const pollIntervalId = setInterval(() => {
    if (stopped) return;
    if (!analyser || !sampleBuffer) return;
    analyser.getFloatTimeDomainData(sampleBuffer);
    let sumSq = 0;
    for (let i = 0; i < sampleBuffer.length; i++) {
      const v = sampleBuffer[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / sampleBuffer.length);
    const now = performance.now();

    if (!recording) {
      if (rms > VAD_OPEN_RMS) {
        // Speech open — start a fresh recorder for this segment.
        segmentChunks = [];
        segmentStartedAt = now;
        lastLoudAt = now;
        lockedIdentity = getSpeakerIdentity();
        try {
          const mime = pickMime();
          recorder = mime ? new MediaRecorder(audioOnly, { mimeType: mime }) : new MediaRecorder(audioOnly);
        } catch (err) {
          console.warn("[godStt] MediaRecorder construct failed", err);
          return;
        }
        recorder.ondataavailable = ev => {
          if (ev.data && ev.data.size > 0) segmentChunks.push(ev.data);
        };
        recorder.onstop = () => {
          const duration = performance.now() - segmentStartedAt;
          const chunks = segmentChunks;
          segmentChunks = [];
          recorder = null;
          if (duration < MIN_SEGMENT_MS) return;
          if (chunks.length === 0) return;
          const type = chunks[0].type || "audio/webm";
          const blob = new Blob(chunks, { type });
          if (blob.size < 1024) return; // <1KB ≈ no real audio captured

          // Identity resolution. The publish WS frame *should* arrive
          // before the WebRTC track does, but in practice there's a
          // race where audio starts flowing 100-300ms before the
          // publication entry is in the client's mesh state. If that
          // race hit at speech-open, `lockedIdentity` will be
          // {address: null, handle: null} (a non-null object with
          // null fields — note ?? wouldn't catch that). Re-lookup at
          // upload time, which is 1-15s later — the publication has
          // definitely arrived by then. If we STILL can't attribute,
          // drop the upload entirely: an anonymous transcript row
          // tagged with a 6-char hex from seg.id is worse UX than
          // missing the segment.
          let identity = lockedIdentity;
          if (!identity || (!identity.address && !identity.handle)) {
            identity = getSpeakerIdentity();
          }
          if (!identity.address && !identity.handle) {
            console.warn("[godStt] dropping segment — speaker unknown");
            return;
          }
          upload(blob, identity);
        };
        recording = true;
        onRecordingOpen();
        try {
          recorder.start(RECORDER_TIMESLICE_MS);
        } catch (err) {
          console.warn("[godStt] MediaRecorder.start failed", err);
          recording = false;
          onRecordingClose();
          recorder = null;
        }
      }
      return;
    }

    // Active recording — track speech-end + max-duration cut.
    if (rms > VAD_CLOSE_RMS) lastLoudAt = now;
    const quietFor = now - lastLoudAt;
    const elapsed = now - segmentStartedAt;
    if (quietFor > VAD_HANG_MS || elapsed > MAX_SEGMENT_MS) {
      closeRecording();
    }
  }, POLL_MS);

  // If the upstream track ends mid-recording (peer left, swapped
  // mic, etc.), flush whatever we have so the partial utterance still
  // gets a transcript line.
  const onTrackEnded = () => {
    if (recording) closeRecording();
  };
  track.addEventListener("ended", onTrackEnded);

  return {
    trackId: track.id,
    stop: () => {
      stopped = true;
      clearInterval(pollIntervalId);
      track.removeEventListener("ended", onTrackEnded);
      if (recording) closeRecording();
      try {
        audioContext?.close();
      } catch {
        /* already closed */
      }
      // We don't stop the upstream track — it's owned by usePeerMesh
      // and shared with the audio playback / visualiser elsewhere on
      // the page. Just detach from the audio graph.
    },
  };
}

function pickMime(): string | undefined {
  // Chrome ships webm/opus; recent Safari ships mp4/aac. OpenAI handles
  // both. Try webm first — it's our most-tested path — then fall back.
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

type UploadArgs = {
  blob: Blob;
  identity: { address: string | null; handle: string | null };
  relayUrl: string;
  slug: string;
  lang: string | undefined;
  onSuccess: () => void;
  onError: (err: string) => void;
};

async function uploadSegment(args: UploadArgs): Promise<void> {
  const { blob, identity, relayUrl, slug, lang, onSuccess, onError } = args;
  let url = withSlug(`${relayUrl}/v1/transcript/relay`, slug);
  const extra = new URLSearchParams();
  if (identity.address) extra.set("address", identity.address);
  if (identity.handle) extra.set("handle", identity.handle);
  if (lang) extra.set("lang", lang);
  if (extra.toString()) {
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}${extra.toString()}`;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": blob.type || "audio/webm" },
      body: blob,
    });
    if (!res.ok) {
      onError(`stt POST ${res.status}`);
      return;
    }
    onSuccess();
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
  }
}
