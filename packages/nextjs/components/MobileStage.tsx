"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AudioPillRow } from "~~/components/mobile/AudioPillRow";
import { MobileSubtitleBand } from "~~/components/mobile/MobileSubtitleBand";
import { type Box, layoutFor } from "~~/components/mobile/layouts";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";
import { ACTIVATED_EVENT } from "~~/hooks/useUserGesture";

// Strip heights (CSS pixels). Picked to read well on portrait phones
// without eating into the video area. See ops/PLAN-mobile-mode.md.
const TITLE_BAR_H = 48;
const AUDIO_ROW_H = 40;
const SUBTITLE_H = 96;

// Portrait clip stage. Rendered in place of the desktop tree when the
// session has `mobileMode: true`. Pulls publications from the same mesh
// the desktop reads, but draws a hard-coded 5-layout arrangement with
// no draggable windows, icons, or menus. See ops/PLAN-mobile-mode.md.

export type MobileStageProps = {
  mesh: PeerMeshState;
};

export const MobileStage = ({ mesh }: MobileStageProps) => {
  // Track the viewport so layoutFor() can compute pixel boxes. We
  // recompute on every resize tick — phones rotate, OBS resizes its
  // capture window, etc. Storing in state (not a ref) so React re-renders.
  const [viewport, setViewport] = useState<{ width: number; height: number }>(() => {
    if (typeof window === "undefined") return { width: 0, height: 0 };
    return { width: window.innerWidth, height: window.innerHeight };
  });
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const audioOnlyPubs = useMemo(
    () => mesh.publications.filter(p => p.kind === "audio" || (p.kind === "camera" && p.cameraOff)),
    [mesh.publications],
  );
  const showAudioRow = audioOnlyPubs.length > 0;

  // Video area dimensions: viewport minus the title strip on top and
  // (subtitle band + optional audio row) on the bottom.
  const videoAreaH = Math.max(0, viewport.height - TITLE_BAR_H - SUBTITLE_H - (showAudioRow ? AUDIO_ROW_H : 0));
  const layout = useMemo(
    () => layoutFor(mesh.publications, { width: viewport.width, height: videoAreaH }),
    [mesh.publications, viewport.width, videoAreaH],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Title strip */}
      <div
        style={{
          height: TITLE_BAR_H,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(6,8,24,0.85)",
          borderBottom: "1px solid rgba(63,207,255,0.30)",
          fontFamily: "var(--slop-font-display)",
          fontSize: 22,
          letterSpacing: "0.18em",
          color: "var(--slop-text)",
          textShadow: "0 0 6px rgba(63,207,255,0.55)",
        }}
      >
        SLOP.COMPUTER
      </div>

      {/* Video area */}
      <div
        style={{
          position: "relative",
          width: viewport.width,
          height: videoAreaH,
          flexShrink: 0,
          background: "#000",
        }}
      >
        {layout.kind === "idle" ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--slop-text-muted)",
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontSize: 14,
            }}
          >
            waiting for stream…
          </div>
        ) : (
          layout.boxes.map((box, i) => <MobileTile key={`${box.pub?.streamId ?? i}`} box={box} mesh={mesh} />)
        )}
      </div>

      {showAudioRow ? <AudioPillRow mesh={mesh} publishers={audioOnlyPubs} height={AUDIO_ROW_H} /> : null}

      <MobileSubtitleBand mesh={mesh} height={SUBTITLE_H} />
    </div>
  );
};

type MobileTileProps = {
  box: Box;
  mesh: PeerMeshState;
};

const MobileTile = ({ box, mesh }: MobileTileProps) => {
  const pub = box.pub;
  // streamFor logic — spectators only ever see remote streams, so we
  // skip the local-stream branch entirely.
  const stream = pub ? (mesh.remoteStreams.get(pub.streamId) ?? null) : null;
  const peer = pub ? mesh.peers.find(p => p.id === pub.peerId) : null;
  const label = useMemo(() => {
    if (!pub) return "";
    const key = pub.ownerKey.toLowerCase();
    return (
      mesh.customNames[key] ??
      peer?.handle ??
      (peer?.address ? `${peer.address.slice(0, 6)}…${peer.address.slice(-4)}` : null) ??
      pub.label ??
      pub.ownerKey.slice(0, 8)
    );
  }, [pub, peer, mesh.customNames]);

  return (
    <div
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        background: "#000",
        overflow: "hidden",
      }}
    >
      {stream ? (
        <MobileVideo stream={stream} fit={box.fit} />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--slop-text-muted)",
            fontSize: 12,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          connecting…
        </div>
      )}
      {/* Speaker label, bottom-left, small. Useful for clip attribution
          when the same tile crops the publisher's face. */}
      {pub ? (
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            padding: "3px 8px",
            background: "rgba(6,8,24,0.78)",
            border: "1px solid rgba(63,207,255,0.40)",
            borderRadius: 4,
            fontFamily: "var(--slop-font-display)",
            fontSize: 10,
            letterSpacing: "0.10em",
            textTransform: "uppercase",
            color: "var(--slop-text)",
            pointerEvents: "none",
            maxWidth: "70%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

// Minimal video element — no publisher controls, no audio bus, no mic
// mute. The mobile spectator hears the room (audio routes through the
// element by default). Object-fit varies per tile (cover for cameras,
// contain for screen shares).
type MobileVideoProps = {
  stream: MediaStream;
  fit: "cover" | "contain";
};

const MobileVideo = ({ stream, fit }: MobileVideoProps) => {
  const ref = useRef<HTMLVideoElement>(null);
  // Same autoplay-retry-on-first-gesture pattern the desktop VideoView
  // uses — Chromium occasionally leaves a fresh srcObject paused on
  // reload before the user clicks anywhere.
  useEffect(() => {
    const onActivated = () => {
      const v = ref.current;
      if (v && v.paused) v.play().catch(() => undefined);
    };
    window.addEventListener(ACTIVATED_EVENT, onActivated);
    return () => window.removeEventListener(ACTIVATED_EVENT, onActivated);
  }, []);

  return (
    <video
      ref={el => {
        ref.current = el;
        if (el && el.srcObject !== stream) el.srcObject = stream;
      }}
      autoPlay
      playsInline
      style={{
        width: "100%",
        height: "100%",
        objectFit: fit,
        background: "#000",
        display: "block",
      }}
    />
  );
};

export default MobileStage;
