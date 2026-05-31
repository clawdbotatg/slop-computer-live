"use client";

import { useEffect, useRef, useState } from "react";
import { AudioVisualizer } from "~~/components/desktop/AudioVisualizer";
import { useAudioBusStream } from "~~/hooks/useAudioBus";
import { ACTIVATED_EVENT } from "~~/hooks/useUserGesture";
import { useRoomSlug } from "~~/lib/room-slug";
import type { Bands } from "~~/utils/blockieBands";

// Persisted alongside the resume flags so reload preserves the mic-mute
// state. **Scoped to the current room slug** — switching from /main to
// /ep0 shouldn't auto-restore a mute from a different room. Cleared by
// Desktop.tsx when the camera publication is fully stopped (not when
// it's merely re-acquired by auto-resume). The audio-only (cameraOff)
// state is NOT persisted: a reload re-acquires the camera and a fresh
// share should start showing video.
const CAMERA_MIC_MUTED_KEY_BASE = "slop-camera-mic-mute-v1";
export const cameraMicMutedKey = (slug: string) => `${CAMERA_MIC_MUTED_KEY_BASE}:${slug}`;

// Per-room "mirror my own view" preference. Purely a local viewing flip
// (transform: scaleX(-1)) — never propagated to peers, so the room still
// sees the publisher in real orientation. Persisted because it's a
// stable preference: people who like seeing themselves mirrored almost
// always like it across reloads.
const CAMERA_MIRRORED_KEY_BASE = "slop-camera-mirrored-v1";
const cameraMirroredKey = (slug: string) => `${CAMERA_MIRRORED_KEY_BASE}:${slug}`;

export type VideoViewProps = {
  stream: MediaStream;
  /** Mute local playback on self streams (echo prevention — a camera
   *  publication bundles the publisher's own mic). */
  muted?: boolean;
  /** When true, render the publisher controls (mic mute, audio-only
   *  toggle, settings). Only the publisher controls their own camera. */
  isMine?: boolean;
  /** Optional. When provided, render a gear (settings) button. Click
   *  handler should re-open the share dialog in edit mode so the user
   *  can hot-swap camera without dropping the publication. */
  onSettings?: () => void;
  /** Audio-only mode: video stopped, mic kept. Driven by the shared
   *  publication state (relay-broadcast), so it's the single source of
   *  truth for both the publisher and every viewer. When true we render
   *  the avatar over the (now-black) video and keep the audio flowing. */
  cameraOff?: boolean;
  /** Publisher-only. Flip audio-only mode on/off. The parent routes this
   *  through the mesh so every peer's `cameraOff` updates in lockstep. */
  onToggleCameraOff?: (off: boolean) => void;
  /** Identity palette for the audio-only avatar/visualizer backdrop. */
  bands?: Bands;
  /** Uploaded avatar URL for the audio-only backdrop (falls back to the
   *  publisher's ENS avatar resolved from `address`). */
  avatarUrl?: string | null;
  /** Publisher wallet address — ENS avatar source for the audio-only
   *  backdrop when no avatar has been uploaded. */
  address?: string | null;
  /** Publisher opted out of any avatar — suppress the backdrop image. */
  hidden?: boolean;
  /** When set, register the inner `<video>` element's stream with the
   *  shared AudioBus under this id. Camera publications carry the
   *  publisher's mic and screen shares can carry system audio — both
   *  need to ride the bus in god-mode so the EQ popup sees them. null
   *  on non-spectator sessions. */
  audioBusId?: string | null;
  /** Human-readable label for the /eq popup row. */
  audioBusLabel?: string;
  /** Show the publisher's "mirror my view" toggle. Cameras want this
   *  (people often prefer seeing themselves flipped, like a mirror);
   *  screen shares don't. The flip is purely local — peers always see
   *  the real orientation. */
  mirrorable?: boolean;
};

// Camera / screen-share renderer with publisher-only controls in the
// top-right:
//   - Mic mute — flips the audio track's enabled flag so the room hears
//     silence (not just a local-side mute). Persisted across reload.
//   - Audio-only — stops sending video but keeps the mic; the avatar
//     renders over the black video for everyone (relay-broadcast state).
// Neither unpublishes, so toggling back is instant (no permission
// re-prompt, no reconnect).
export const VideoView = ({
  stream,
  muted = false,
  isMine = false,
  onSettings,
  cameraOff = false,
  onToggleCameraOff,
  bands,
  avatarUrl = null,
  address = null,
  hidden = false,
  audioBusId = null,
  audioBusLabel = "video",
  mirrorable = false,
}: VideoViewProps) => {
  const slug = useRoomSlug();
  const storageKey = cameraMicMutedKey(slug);
  const mirroredKey = cameraMirroredKey(slug);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Lazy init from localStorage when this is my own publication, so the
  // initial track.enabled effect below sees the resumed micMuted=true
  // and silences the just-re-acquired mic before peers hear a sample.
  const [micMuted, setMicMuted] = useState<boolean>(() => {
    if (!isMine || typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!isMine || typeof window === "undefined") return;
    try {
      if (micMuted) window.localStorage.setItem(storageKey, "1");
      else window.localStorage.removeItem(storageKey);
    } catch {
      /* quota / private mode */
    }
  }, [micMuted, isMine, storageKey]);
  // Per-user "mute on my side" for remote streams. Doesn't touch the
  // upstream — only my local <video> element goes silent. Same model
  // as the music player + AudioVisualizer.
  const [selfMuted, setSelfMuted] = useState(false);
  // Publisher-only "mirror my view" — local CSS flip on the <video>
  // element. Never broadcast: peers continue to see the real
  // orientation. Persisted across reload, scoped to room slug, same
  // pattern as the mic-mute resume above.
  const [mirrored, setMirrored] = useState<boolean>(() => {
    if (!isMine || !mirrorable || typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(mirroredKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!isMine || !mirrorable || typeof window === "undefined") return;
    try {
      if (mirrored) window.localStorage.setItem(mirroredKey, "1");
      else window.localStorage.removeItem(mirroredKey);
    } catch {
      /* quota / private mode */
    }
  }, [mirrored, isMine, mirrorable, mirroredKey]);

  // My own mic: flip track.enabled so the *room* hears silence. Separate
  // from the audio-only toggle below — you can be muted with video on,
  // or talking with video off.
  useEffect(() => {
    if (!isMine) return;
    for (const t of stream.getAudioTracks()) t.enabled = !micMuted;
    // Notify Desktop's useLiveTranscript gate so local Web Speech STT
    // shuts off when the camera-sharer mutes their mic. Web Speech opens
    // its own internal mic capture and ignores track.enabled, so without
    // this signal the recognizer keeps broadcasting captions for someone
    // who muted themselves. Mirrors AudioVisualizer's dispatch — a camera
    // publication bundles the mic, so this tile owns the mute affordance.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("slop-audio-muted-change", { detail: { slug, muted: micMuted } }));
    }
  }, [stream, micMuted, isMine, slug]);

  // Audio-only: stop sending video frames but keep the mic. Disabling
  // (vs. unpublishing) means flipping back is instant and the audio
  // never drops. Only the publisher touches the local track — viewers
  // render the avatar purely from the broadcast `cameraOff` flag.
  useEffect(() => {
    if (!isMine) return;
    for (const t of stream.getVideoTracks()) t.enabled = !cameraOff;
  }, [stream, cameraOff, isMine]);

  // Spacebar mute toggle (dispatched by Desktop's global key handler).
  useEffect(() => {
    if (!isMine) return;
    const onToggle = () => setMicMuted(m => !m);
    window.addEventListener("slop-toggle-mic", onToggle);
    return () => window.removeEventListener("slop-toggle-mic", onToggle);
  }, [isMine]);

  // God-mode only — route this video's audio through the shared
  // AudioBus. Camera streams bundle mic audio; screen shares may
  // carry system audio. We tap the MediaStream directly because
  // createMediaElementSource gives silent output on srcObject-bound
  // elements in Chromium. The <video> below is force-muted while the
  // bus is active so we don't double-play. This stays wired even in
  // audio-only mode — the video element is still the audio sink.
  const busActive = !!audioBusId;
  useAudioBusStream(stream, audioBusId ?? "", audioBusLabel, busActive);

  // Reload-without-gesture can leave an unmuted <video> paused (Chrome's
  // autoplay policy occasionally bites WebRTC streams too). The page
  // EntryGate fires slop:activated on the first user click; retry play
  // in the same gesture so the remote camera/screen wakes up.
  useEffect(() => {
    const onActivated = () => {
      const v = videoRef.current;
      if (v && v.paused) v.play().catch(() => undefined);
    };
    window.addEventListener(ACTIVATED_EVENT, onActivated);
    return () => window.removeEventListener(ACTIVATED_EVENT, onActivated);
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#000" }}>
      <video
        ref={el => {
          videoRef.current = el;
          if (el && el.srcObject !== stream) el.srcObject = stream;
        }}
        autoPlay
        playsInline
        // Self-publication is always muted (echo prevention). For
        // remote, the per-user `selfMuted` toggle silences this peer's
        // local playback only — the upstream stream is unchanged.
        // When the AudioBus owns this stream we mute the element too
        // so the bus is the sole audible path (otherwise the audio
        // would play twice — direct from this element AND through
        // the bus's MediaStreamSource).
        muted={muted || (!isMine && selfMuted) || busActive}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          background: "#000",
          display: "block",
          transform: mirrored ? "scaleX(-1)" : undefined,
        }}
      />
      {/* Audio-only backdrop, shown whenever the publisher is in
          audio-only mode (needs the identity palette; screen shares
          never set cameraOff and don't pass bands, so this stays
          camera-only in practice). The <video> above keeps carrying the
          audio (and the AudioBus tap); this is a visuals-only layer —
          muted, isMine=false so it never touches tracks, and no bus id
          so it doesn't double-register. */}
      {cameraOff && bands ? (
        <div style={{ position: "absolute", inset: 0 }}>
          <AudioVisualizer
            stream={stream}
            bands={bands}
            muted
            isMine={false}
            controls={false}
            avatarUrl={avatarUrl}
            address={address}
            hidden={hidden}
          />
        </div>
      ) : null}
      {!isMine ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            gap: 6,
            zIndex: 5,
          }}
        >
          <button
            type="button"
            onClick={() => setSelfMuted(m => !m)}
            aria-label={selfMuted ? "unmute (local)" : "mute (local)"}
            title={selfMuted ? "unmute (only on your side)" : "mute (only on your side)"}
            style={overlayBtnStyle(selfMuted)}
          >
            {selfMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
          </button>
        </div>
      ) : null}
      {isMine ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            gap: 6,
            zIndex: 5,
          }}
        >
          <button
            type="button"
            onClick={() => setMicMuted(m => !m)}
            aria-label={micMuted ? "unmute microphone" : "mute microphone"}
            title={micMuted ? "unmute microphone (spacebar)" : "mute microphone (spacebar)"}
            style={overlayBtnStyle(micMuted)}
          >
            {micMuted ? <MicOffIcon /> : <MicIcon />}
          </button>
          {mirrorable ? (
            <button
              type="button"
              onClick={() => setMirrored(m => !m)}
              aria-label={mirrored ? "show real view" : "show mirror view"}
              title={
                mirrored
                  ? "mirror view ON — only you see this flip; everyone else sees the real view"
                  : "flip my view (mirror) — only you; others still see the real view"
              }
              style={overlayBtnStyle(mirrored)}
            >
              <FlipHorizontalIcon />
            </button>
          ) : null}
          {onToggleCameraOff ? (
            <button
              type="button"
              onClick={() => onToggleCameraOff(!cameraOff)}
              aria-label={cameraOff ? "turn camera on" : "switch to audio only"}
              title={cameraOff ? "turn camera back on" : "switch to audio only (show avatar)"}
              style={overlayBtnStyle(cameraOff)}
            >
              {cameraOff ? <VideoOffIcon /> : <VideoOnIcon />}
            </button>
          ) : null}
          {onSettings ? (
            <button
              type="button"
              onClick={onSettings}
              aria-label="video settings"
              title="video settings"
              style={overlayBtnStyle(false)}
            >
              <GearIcon />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const overlayBtnStyle = (active: boolean): React.CSSProperties => ({
  width: 32,
  height: 32,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: active ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
  border: `1px solid ${active ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
  color: "#fff",
  cursor: "pointer",
  backdropFilter: "blur(4px)",
});

// Mac OS 9-flavored monochrome icons. ~16px viewBox.
const VideoOnIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="2" y="4.5" width="8.5" height="7" rx="1" fill="currentColor" stroke="none" />
    <path d="M10.5 7 L 14 5 V 11 L 10.5 9 Z" fill="currentColor" stroke="none" />
  </svg>
);

const VideoOffIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="2" y="4.5" width="8.5" height="7" rx="1" fill="currentColor" stroke="none" />
    <path d="M10.5 7 L 14 5 V 11 L 10.5 9 Z" fill="currentColor" stroke="none" />
    <line x1="2" y1="2" x2="14" y2="14" stroke="#000" strokeWidth="2.6" />
    <line x1="2" y1="2" x2="14" y2="14" />
  </svg>
);

// Microphone — solid capsule + stand. Slash variant for the muted state.
const MicIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="6" y="2" width="4" height="7" rx="2" fill="currentColor" stroke="none" />
    <path d="M3.5 7.5 A 4.5 4.5 0 0 0 12.5 7.5" />
    <line x1="8" y1="12" x2="8" y2="14.5" />
    <line x1="5.5" y1="14.5" x2="10.5" y2="14.5" />
  </svg>
);

const MicOffIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="6" y="2" width="4" height="7" rx="2" fill="currentColor" stroke="none" />
    <path d="M3.5 7.5 A 4.5 4.5 0 0 0 12.5 7.5" />
    <line x1="8" y1="12" x2="8" y2="14.5" />
    <line x1="5.5" y1="14.5" x2="10.5" y2="14.5" />
    {/* slash */}
    <line x1="2" y1="2" x2="14" y2="14" stroke="#000" strokeWidth="2.6" />
    <line x1="2" y1="2" x2="14" y2="14" />
  </svg>
);

// Horizontal-flip / mirror toggle. Reload-style curved arrows split
// across a vertical mirror line so the glyph reads as "flip the
// picture left↔right" rather than "refresh".
const FlipHorizontalIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {/* dashed vertical mirror axis */}
    <line x1="8" y1="2" x2="8" y2="14" strokeDasharray="1.5 1.5" />
    {/* left half: curved arrow pointing inward toward the axis */}
    <path d="M2.5 5 Q 2.5 11 6.5 11" />
    <path d="M6.5 11 L 5.2 9.6 M6.5 11 L 5.2 12.3" />
    {/* right half: mirror image, arrow into axis from the right */}
    <path d="M13.5 5 Q 13.5 11 9.5 11" />
    <path d="M9.5 11 L 10.8 9.6 M9.5 11 L 10.8 12.3" />
  </svg>
);

const GearIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1="2" y1="8" x2="14" y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
    <circle cx="10" cy="4" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="5" cy="8" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="11" cy="12" r="1.7" fill="currentColor" stroke="none" />
  </svg>
);

// Per-user "mute on my side" speaker — same glyph the music player +
// AudioVisualizer use, kept inline so each window stays self-contained.
const SpeakerIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2.5 6 H 4.5 L 7.5 3 V 13 L 4.5 10 H 2.5 Z" fill="currentColor" stroke="none" />
    <path d="M9.5 6 Q 11 8 9.5 10" />
    <path d="M11 4.5 Q 13.5 8 11 11.5" />
  </svg>
);

const SpeakerOffIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2.5 6 H 4.5 L 7.5 3 V 13 L 4.5 10 H 2.5 Z" fill="currentColor" stroke="none" />
    <line x1="9.5" y1="5.5" x2="14" y2="10.5" />
    <line x1="14" y1="5.5" x2="9.5" y2="10.5" />
  </svg>
);

export default VideoView;
