"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AudioVisualizer } from "~~/components/desktop/AudioVisualizer";
import { MobileSubtitleBand } from "~~/components/mobile/MobileSubtitleBand";
import { FAKE_PRESETS, type FakePreset, fakePubsFor, isFakePreset } from "~~/components/mobile/fakePubs";
import { type Box, LAYOUT_VARIANTS, type LayoutVariant, layoutFor } from "~~/components/mobile/layouts";
import { MusicTicker, WalletPill } from "~~/components/mobile/secondaryOverlays";
import type { PeerMeshState, Publication } from "~~/hooks/usePeerMesh";
import { ACTIVATED_EVENT } from "~~/hooks/useUserGesture";
import { bandsFromIdentity } from "~~/utils/blockieBands";

// Strip heights (CSS pixels). Picked to read well on portrait phones
// without eating into the video area. See ops/PLAN-mobile-mode.md.
const TITLE_BAR_H = 48;
const SUBTITLE_H = 96;

// Portrait clip stage. Rendered in place of the desktop tree when the
// session has `mobileMode: true`. Pulls publications from the same mesh
// the desktop reads, but draws a hard-coded 5-layout arrangement with
// no draggable windows, icons, or menus. See ops/PLAN-mobile-mode.md.

export type MobileStageProps = {
  mesh: PeerMeshState;
};

export const MobileStage = ({ mesh }: MobileStageProps) => {
  // ?fakeLayout=<preset> URL preview. Operator-facing: lets us see what
  // each layout looks like without needing real publishers. Read once
  // on mount and scrub from the URL bar like ?mobileMode= itself.
  const [fakePreset, setFakePreset] = useState<FakePreset | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    const raw = u.searchParams.get("fakeLayout");
    if (raw && isFakePreset(raw)) {
      setFakePreset(raw);
      u.searchParams.delete("fakeLayout");
      window.history.replaceState({}, "", u.toString());
    }
  }, []);

  // [ / ] cycle through LAYOUT VARIANTS (default, +music, +wallet,
  // focus, people-only). Wired for ALL sessions (real publishers
  // included) — that's the whole point of variants.
  // , / . cycle FAKE PRESETS — only wired when ?fakeLayout= was used,
  // so a clip-capture session won't accidentally jump publisher sets.
  const [variantIndex, setVariantIndex] = useState(0);
  const variant: LayoutVariant = LAYOUT_VARIANTS[variantIndex];
  // Audio defaults to MUTED. When the operator has both a god-mode tab
  // (stream output) and a mobile-mode tab (clip capture) open on the
  // same machine, the same room audio plays from both windows and you
  // get a reverb. Mute the mobile path; OBS Browser Source can still
  // capture audio directly without going through system speakers.
  // Press `m` to toggle audible for previewing.
  const [audioMuted, setAudioMuted] = useState(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "[") {
        setVariantIndex(i => (i - 1 + LAYOUT_VARIANTS.length) % LAYOUT_VARIANTS.length);
      } else if (e.key === "]") {
        setVariantIndex(i => (i + 1) % LAYOUT_VARIANTS.length);
      } else if (e.key === "m" || e.key === "M") {
        setAudioMuted(m => !m);
      } else if (fakePreset !== null && (e.key === "," || e.key === ".")) {
        const dir = e.key === "." ? 1 : -1;
        setFakePreset(prev => {
          if (prev === null) return prev;
          const i = FAKE_PRESETS.indexOf(prev);
          return FAKE_PRESETS[(i + dir + FAKE_PRESETS.length) % FAKE_PRESETS.length];
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fakePreset]);

  // Prepend "[mobile]" to the document title so the operator can
  // tell the mobile-mode tab apart from the god-mode tab in the
  // browser's tab strip / window list. Restore the original on
  // unmount in case Desktop ever re-mounts a non-mobile MobileStage.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const original = document.title;
    document.title = `[mobile] ${original}`;
    return () => {
      document.title = original;
    };
  }, []);

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

  const realPubs = mesh.publications;
  const pubs = useMemo(() => (fakePreset ? fakePubsFor(fakePreset) : realPubs), [fakePreset, realPubs]);

  // Music ticker eats 32px out of the video area when its variant is
  // active. Wallet pill is overlay-only (doesn't claim layout space).
  const showMusicTicker = variant === "music";
  const showWalletPill = variant === "wallet";
  const MUSIC_TICKER_H = 32;
  const videoAreaH = Math.max(0, viewport.height - TITLE_BAR_H - SUBTITLE_H - (showMusicTicker ? MUSIC_TICKER_H : 0));
  const layout = useMemo(
    () => layoutFor(pubs, { width: viewport.width, height: videoAreaH }, variant),
    [pubs, viewport.width, videoAreaH, variant],
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
          layout.boxes.map((box, i) => (
            <MobileTile key={`${box.pub?.streamId ?? i}`} box={box} mesh={mesh} muted={audioMuted} />
          ))
        )}
      </div>

      {showMusicTicker ? <MusicTicker mesh={mesh} /> : null}

      <MobileSubtitleBand mesh={mesh} height={SUBTITLE_H} />

      {showWalletPill ? <WalletPill mesh={mesh} /> : null}

      <VariantHud variant={variant} layoutKind={layout.kind} fakePreset={fakePreset} />
      <AudioMuteHud muted={audioMuted} />
    </div>
  );
};

type MobileTileProps = {
  box: Box;
  mesh: PeerMeshState;
  muted: boolean;
};

const MobileTile = ({ box, mesh, muted }: MobileTileProps) => {
  const pub = box.pub;
  const isFake = pub?.streamId.startsWith("fake-") === true;
  // streamFor logic — spectators only ever see remote streams, so we
  // skip the local-stream branch entirely. Fake pubs intentionally
  // have no stream and render a placeholder block.
  const stream = pub && !isFake ? (mesh.remoteStreams.get(pub.streamId) ?? null) : null;
  const peer = pub ? mesh.peers.find(p => p.id === pub.peerId) : null;
  const label = useMemo(() => {
    if (!pub) return "";
    if (isFake) return pub.label ?? pub.streamId;
    const key = pub.ownerKey.toLowerCase();
    return (
      mesh.customNames[key] ??
      peer?.handle ??
      (peer?.address ? `${peer.address.slice(0, 6)}…${peer.address.slice(-4)}` : null) ??
      pub.label ??
      pub.ownerKey.slice(0, 8)
    );
  }, [pub, peer, mesh.customNames, isFake]);

  const bands = useMemo(
    () =>
      bandsFromIdentity({
        address: peer?.address ?? null,
        anonId: peer?.anonId ?? null,
        handle: peer?.handle ?? null,
        fallback: pub?.ownerKey ?? pub?.peerId ?? "fake",
      }),
    [peer, pub],
  );

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
      <TileContent box={box} stream={stream} mesh={mesh} bands={bands} isFake={isFake} muted={muted} />
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
            zIndex: 3,
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

type TileContentProps = {
  box: Box;
  stream: MediaStream | null;
  mesh: PeerMeshState;
  bands: ReturnType<typeof bandsFromIdentity>;
  isFake: boolean;
  muted: boolean;
};

const TileContent = ({ box, stream, mesh, bands, isFake, muted }: TileContentProps) => {
  const pub = box.pub;
  if (isFake && pub) return <FakeTile box={box} pub={pub} bands={bands} />;
  if (!stream || !pub) {
    return <Placeholder label="connecting…" bands={bands} />;
  }
  if (box.kind === "audio") {
    const peer = mesh.peers.find(p => p.id === pub.peerId);
    return (
      <AudioVisualizer
        stream={stream}
        bands={bands}
        muted={muted}
        avatarUrl={mesh.avatars[pub.ownerKey] ?? null}
        address={peer?.address ?? null}
        hidden={mesh.hiddenAvatars.has(pub.ownerKey)}
        controls={false}
      />
    );
  }
  return <MobileVideo stream={stream} fit={box.fit} muted={muted} />;
};

type FakeTileProps = {
  box: Box;
  pub: Publication;
  bands: ReturnType<typeof bandsFromIdentity>;
};

// Placeholder block for fake/preview pubs. Tries to look "production
// enough" that the operator can tell which tile is which (gradient
// keyed to identity bands + kind label) without bothering with a real
// stream. The kind label means "you're previewing what a screen-share
// would look like here, not a real screen-share."
const FakeTile = ({ box, pub, bands }: FakeTileProps) => {
  const kindLabel = box.kind === "video" ? "video" : box.kind === "audio" ? "audio" : "screen";
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: `linear-gradient(135deg, ${bands.band1} 0%, ${bands.band2} 50%, ${bands.band3} 100%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(6,8,24,0.85)",
        fontFamily: "var(--slop-font-display)",
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        fontSize: Math.min(box.width, box.height) > 200 ? 18 : 12,
      }}
    >
      {kindLabel} · {pub.label}
    </div>
  );
};

type PlaceholderProps = {
  label: string;
  bands: ReturnType<typeof bandsFromIdentity>;
};

const Placeholder = ({ label, bands }: PlaceholderProps) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      background: `radial-gradient(circle, ${bands.band2}33 0%, #000 70%)`,
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
    {label}
  </div>
);

// Minimal video element — no publisher controls, no audio bus, no mic
// mute. Object-fit varies per tile (cover for cameras, contain for
// screen shares). The `muted` prop is gated by MobileStage's `m`
// toggle — defaults to muted to prevent reverb when a god-mode tab is
// already piping the room's audio.
type MobileVideoProps = {
  stream: MediaStream;
  fit: "cover" | "contain";
  muted: boolean;
};

const MobileVideo = ({ stream, fit, muted }: MobileVideoProps) => {
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
      muted={muted}
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

// Variant HUD: tells the operator which variant is active and how to
// cycle. Auto-fades after a couple seconds of no changes — the recording
// shouldn't show a persistent overlay. Only the "default" variant
// suppresses the HUD entirely (clean by, well, default).
type VariantHudProps = {
  variant: LayoutVariant;
  layoutKind: string;
  fakePreset: FakePreset | null;
};

const VariantHud = ({ variant, layoutKind, fakePreset }: VariantHudProps) => {
  const [visible, setVisible] = useState(false);
  // Re-show on every variant or preset change, then fade after 2s.
  useEffect(() => {
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), 2000);
    return () => window.clearTimeout(id);
  }, [variant, fakePreset]);
  // If we're sitting on the default variant AND no fake preset, never
  // flash the HUD — pristine recording state.
  if (variant === "default" && fakePreset === null) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: TITLE_BAR_H + 6,
        right: 6,
        padding: "4px 8px",
        background: "rgba(6,8,24,0.85)",
        border: "1px solid rgba(255,62,201,0.55)",
        borderRadius: 4,
        fontFamily: "var(--slop-font-display)",
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--slop-magenta, #ff3ec9)",
        pointerEvents: "none",
        zIndex: 9000,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 2,
        opacity: visible ? 1 : 0,
        transition: "opacity 400ms ease",
      }}
    >
      <span>{variant} · [ ] cycle</span>
      <span style={{ color: "var(--slop-text-muted)", fontSize: 9 }}>
        {layoutKind}
        {fakePreset ? ` · preview:${fakePreset} · , .` : ""}
      </span>
    </div>
  );
};

// Audio mute indicator: flashes briefly on `m` toggle, fades out after
// 2s. Same fade pattern as the variant HUD — recording state stays
// clean unless the operator just changed something. Skips the very
// first render so we don't flash "muted" on every page load.
type AudioMuteHudProps = {
  muted: boolean;
};

const AudioMuteHud = ({ muted }: AudioMuteHudProps) => {
  const [visible, setVisible] = useState(false);
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), 2000);
    return () => window.clearTimeout(id);
  }, [muted]);
  return (
    <div
      style={{
        position: "fixed",
        bottom: SUBTITLE_H + 6,
        right: 6,
        padding: "3px 8px",
        background: "rgba(6,8,24,0.85)",
        border: "1px solid rgba(63,207,255,0.40)",
        borderRadius: 4,
        fontFamily: "var(--slop-font-display)",
        fontSize: 9,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: muted ? "var(--slop-text-muted)" : "var(--slop-cyan, #3fcfff)",
        pointerEvents: "none",
        zIndex: 9000,
        opacity: visible ? 1 : 0,
        transition: "opacity 400ms ease",
      }}
    >
      {muted ? "🔇 muted" : "🔊 audible"} · m
    </div>
  );
};

export default MobileStage;
