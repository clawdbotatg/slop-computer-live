"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AudioVisualizer } from "~~/components/desktop/AudioVisualizer";
import { MobileBrowserTile } from "~~/components/mobile/MobileBrowserTile";
import { MobileSubtitleBand } from "~~/components/mobile/MobileSubtitleBand";
import { FAKE_PRESETS, type FakePreset, fakePubsFor, isFakePreset } from "~~/components/mobile/fakePubs";
import { type Box, LAYOUT_VARIANTS, type LayoutVariant, layoutFor } from "~~/components/mobile/layouts";
import { MusicTicker, WalletPill } from "~~/components/mobile/secondaryOverlays";
import { DesktopBackground } from "~~/components/ui/DesktopBackground";
import type { PeerMeshState, Publication } from "~~/hooks/usePeerMesh";
import { ACTIVATED_EVENT } from "~~/hooks/useUserGesture";
import { bandsFromIdentity } from "~~/utils/blockieBands";

// Strip heights (CSS pixels). Picked to read well on portrait phones
// without eating into the video area. See ops/PLAN-mobile-mode.md.
// Brand identity: gradient title bar on top + DesktopBackground filling
// the rest + ASCII SLOP.COMPUTER watermark bottom-right (matches the
// desktop). Captions float in the seam between tiles.
const TITLE_BAR_H = 48;

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

  // Wrap shared browsers as synthetic "screen" publications so the
  // existing layout dispatcher places them like screen shares. The
  // `mobile-browser-` streamId prefix is the marker that MobileTile
  // uses to dispatch to MobileBrowserTile instead of the video
  // element. Other shared apps (glossary, notes, etc.) come in a
  // follow-up — the wrapping pattern is the same shape.
  const realPubs = mesh.publications;
  const browserPubs: Publication[] = useMemo(
    () =>
      Object.values(mesh.browsers).map(b => ({
        streamId: `mobile-browser-${b.id}`,
        peerId: `mobile-browser-${b.id}`,
        ownerKey: b.openedBy,
        kind: "screen" as const,
        label: b.url,
      })),
    [mesh.browsers],
  );
  const pubs = useMemo(
    () => (fakePreset ? fakePubsFor(fakePreset) : [...realPubs, ...browserPubs]),
    [fakePreset, realPubs, browserPubs],
  );

  // Music ticker eats 32px out of the video area when its variant is
  // active. Wallet pill is overlay-only (doesn't claim layout space).
  const showMusicTicker = variant === "music";
  const showWalletPill = variant === "wallet";
  const MUSIC_TICKER_H = 32;
  const videoAreaH = Math.max(0, viewport.height - TITLE_BAR_H - (showMusicTicker ? MUSIC_TICKER_H : 0));
  const layout = useMemo(
    () => layoutFor(pubs, { width: viewport.width, height: videoAreaH }, variant),
    [pubs, viewport.width, videoAreaH, variant],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // DesktopBackground paints --slop-base as its first layer, so
        // no need to set background here — would just hide the dotted
        // dither + starfield.
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Same starfield/dither backdrop as the desktop. Sits behind
          every tile so any negative space (idle state, screen-share
          letterboxing, small audio tile gaps) shows the slop look
          instead of a flat black. */}
      <DesktopBackground />

      {/* Title strip — magenta→purple gradient + logo mark, mirrors
          the desktop's brand chip (.slop-menubar__brand in globals.css)
          so the mobile clip reads as the same product. */}
      <div
        style={{
          height: TITLE_BAR_H,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          background: "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-purple) 100%)",
          borderBottom: "1px solid rgba(0,0,0,0.6)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(0,0,0,0.35), 0 2px 10px rgba(255,62,201,0.45)",
          fontFamily: "var(--slop-font-display)",
          fontSize: 22,
          letterSpacing: "0.18em",
          color: "#fff",
          textShadow: "0 1px 1px rgba(0,0,0,0.55)",
          position: "relative",
          zIndex: 5,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-mark.png"
          alt=""
          width={28}
          height={28}
          aria-hidden
          style={{ filter: "drop-shadow(0 1px 0 rgba(0,0,0,0.5))", flexShrink: 0 }}
        />
        <span>SLOP.COMPUTER</span>
      </div>

      {/* Video area — transparent so DesktopBackground shows through
          any negative space (idle state, screen-share letterboxing). */}
      <div
        style={{
          position: "relative",
          width: viewport.width,
          height: videoAreaH,
          flexShrink: 0,
        }}
      >
        {/* Icon backdrop always renders behind the tiles — tiles paint
            over wherever they cover, and the icons stay visible in any
            slack space (idle, single-tile cap, screen-share letterbox).
            Mirrors how the desktop's icons sit under floating windows. */}
        <IdleMiniIcons />
        {layout.boxes.map((box, i) => (
          <MobileTile key={`${box.pub?.streamId ?? i}`} box={box} mesh={mesh} muted={audioMuted} />
        ))}
      </div>

      {/* Caption chip floats over the video area at the layout's seam
          Y so words don't cover a face. The +TITLE_BAR_H lifts the
          seam coordinate (which is relative to the video area) into
          viewport space, matching how the band positions absolutely
          inside this root `position: fixed` container. */}
      <MobileSubtitleBand mesh={mesh} top={TITLE_BAR_H + layout.captionY} />

      {showMusicTicker ? <MusicTicker mesh={mesh} /> : null}

      {showWalletPill ? <WalletPill mesh={mesh} /> : null}

      <VariantHud variant={variant} layoutKind={layout.kind} fakePreset={fakePreset} />
      <AudioMuteHud muted={audioMuted} />
      <MobileChyron mesh={mesh} />
      <Watermark chyronVisible={!!mesh.chyronState?.text} />
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
  const isBrowser = pub?.streamId.startsWith("mobile-browser-") === true;
  // streamFor logic — spectators only ever see remote streams, so we
  // skip the local-stream branch entirely. Fake pubs intentionally
  // have no stream and render a placeholder block. Browser pubs are
  // synthetic — they render via MobileBrowserTile, no MediaStream.
  const stream = pub && !isFake && !isBrowser ? (mesh.remoteStreams.get(pub.streamId) ?? null) : null;
  const peer = pub ? mesh.peers.find(p => p.id === pub.peerId) : null;
  const label = useMemo(() => {
    if (!pub) return "";
    if (isFake) return pub.label ?? pub.streamId;
    if (isBrowser) {
      // pub.label is the URL for synthetic browser pubs.
      try {
        return new URL(pub.label ?? "").host;
      } catch {
        return "browser";
      }
    }
    const key = pub.ownerKey.toLowerCase();
    return (
      mesh.customNames[key] ??
      peer?.handle ??
      (peer?.address ? `${peer.address.slice(0, 6)}…${peer.address.slice(-4)}` : null) ??
      pub.label ??
      pub.ownerKey.slice(0, 8)
    );
  }, [pub, peer, mesh.customNames, isFake, isBrowser]);

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
      <TileContent
        box={box}
        stream={stream}
        mesh={mesh}
        bands={bands}
        isFake={isFake}
        isBrowser={isBrowser}
        muted={muted}
      />
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
  isBrowser: boolean;
  muted: boolean;
};

const TileContent = ({ box, stream, mesh, bands, isFake, isBrowser, muted }: TileContentProps) => {
  const pub = box.pub;
  if (isFake && pub) return <FakeTile box={box} pub={pub} bands={bands} />;
  // Shared browsers come in as synthetic "screen" pubs with the URL
  // in `label` and the browser id in `streamId` (prefix stripped).
  // No MediaStream — branch BEFORE the !stream early return.
  if (isBrowser && pub) {
    const url = pub.label ?? "";
    const id = pub.streamId.slice("mobile-browser-".length);
    return <MobileBrowserTile id={id} url={url} showBadge={false} />;
  }
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
        bottom: 10,
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

// Same chunky SLOP.COMPUTER ASCII watermark the desktop floats above
// the trash can — pulled into the mobile bottom-right corner so the
// frame reads as the same product. Pure decoration; pointer-events
// off so it never intercepts. Scaled smaller than the desktop default
// (~1.18vw) since portrait viewports are narrower.
const SLOP_ASCII = `███████╗██╗      ██████╗ ██████╗  ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗   ██╗████████╗███████╗██████╗
██╔════╝██║     ██╔═══██╗██╔══██╗██╔════╝██╔═══██╗████╗ ████║██╔══██╗██║   ██║╚══██╔══╝██╔════╝██╔══██╗
███████╗██║     ██║   ██║██████╔╝██║     ██║   ██║██╔████╔██║██████╔╝██║   ██║   ██║   █████╗  ██████╔╝
╚════██║██║     ██║   ██║██╔═══╝ ██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██║   ██║   ██║   ██╔══╝  ██╔══██╗
███████║███████╗╚██████╔╝██║██╗  ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ╚██████╔╝   ██║   ███████╗██║  ██║
╚══════╝╚══════╝ ╚═════╝ ╚═╝╚═╝   ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝      ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝`;

// Mobile-tuned chyron — same data source as desktop ChyronBar but
// 2-line capable since portrait viewports are narrow. Renders nothing
// when the host hasn't set a message. Full-width strip at the bottom
// of the viewport so it reads even on a tiny phone clip.
const MOBILE_CHYRON_H = 56;

type MobileChyronProps = {
  mesh: PeerMeshState;
};

const MobileChyron = ({ mesh }: MobileChyronProps) => {
  const text = mesh.chyronState?.text ?? "";
  if (!text) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        height: MOBILE_CHYRON_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "6px 14px",
        background: "linear-gradient(180deg, rgba(20,10,40,0.92) 0%, rgba(6,3,13,0.95) 100%)",
        borderTop: "1px solid rgba(255,62,201,0.55)",
        boxShadow: "0 -4px 12px rgba(255,62,201,0.25)",
        pointerEvents: "none",
        zIndex: 70,
      }}
    >
      <span
        style={{
          color: "#fff",
          fontFamily: "var(--slop-font-display)",
          fontSize: 18,
          letterSpacing: "0.05em",
          textAlign: "center",
          textShadow: "0 1px 2px rgba(0,0,0,0.85), 0 0 8px rgba(255,62,201,0.45)",
          // Two-line wrap with ellipsis. line-clamp keeps a long
          // chyron from pushing the bar height around mid-clip.
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textOverflow: "ellipsis",
          lineHeight: 1.2,
          maxWidth: "100%",
        }}
      >
        {text}
      </span>
    </div>
  );
};

type WatermarkProps = {
  chyronVisible: boolean;
};

const Watermark = ({ chyronVisible }: WatermarkProps) => (
  <pre
    aria-hidden
    style={{
      position: "fixed",
      right: 8,
      // Lift above the chyron bar when one is set so the ASCII art
      // doesn't get covered by the host's message.
      bottom: chyronVisible ? MOBILE_CHYRON_H + 8 : 8,
      transition: "bottom 200ms ease-out",
      display: "inline-block",
      width: "auto",
      margin: 0,
      padding: 0,
      pointerEvents: "none",
      userSelect: "none",
      zIndex: 0, // behind tiles + HUDs, on top of DesktopBackground
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      // Hugs the portrait viewport: ~99 cols × 0.6em = ~60vw at this size.
      fontSize: "max(3px, 0.95vw)",
      lineHeight: 1,
      letterSpacing: 0,
      whiteSpace: "pre",
      textAlign: "left",
      color: "var(--slop-magenta, #ff3ec9)",
      opacity: 0.2,
      textShadow: "0 0 6px rgba(255,62,201,0.25)",
      overflow: "hidden",
    }}
  >
    {SLOP_ASCII}
  </pre>
);

// Mini desktop-icon grid for the idle state. Mirrors the desktop's
// AUTO_ARRANGE_COLUMNS layout — same apps, same column order — so the
// mobile clip's empty stage looks like a tiny snapshot of the slop
// desktop. Anchored to the TOP-LEFT of the video area to match where
// the desktop puts its icons; a viewer should be able to glance
// between desktop and mobile clip and see the same grid in the same
// corner instead of a left/right flip.
//
// Icon paths mirror DEFAULT_APPS in packages/relay/src/index.ts. If you
// add an app there, add it here too — there's no shared frontend
// constant yet and the mobile stage is read-only spectator so we
// don't need to fetch the actual app list dynamically for this preview.
const IDLE_ICON_COLUMNS: ReadonlyArray<ReadonlyArray<{ id: string; src: string }>> = [
  [
    { id: "chat", src: "/icons/chat.png" },
    { id: "video", src: "/icons/video.png" },
    { id: "audio", src: "/icons/mic.png" },
    { id: "screen", src: "/icons/screen-sharing.png" },
  ],
  [
    { id: "clock", src: "/icons/clock.png" },
    { id: "card", src: "/icons/card.png" },
    { id: "research", src: "/icons/research.png" },
    { id: "transcript", src: "/icons/transcript.png" },
  ],
  [
    { id: "glossary", src: "/icons/glossary.png" },
    { id: "notes", src: "/icons/notes.png" },
    { id: "todo", src: "/icons/todo.png" },
    { id: "qr", src: "/icons/qr.png" },
  ],
  [
    { id: "nifty-ink", src: "/icons/paint.png" },
    { id: "abi-ninja", src: "/icons/ninja.png" },
    { id: "gas", src: "/icons/gas.png" },
    { id: "news", src: "/icons/news.png" },
  ],
  [
    { id: "browser", src: "/icons/browser.png" },
    { id: "wallet", src: "/icons/wallet.png" },
    { id: "ens", src: "/icons/ens.png" },
    { id: "music", src: "/icons/music.png" },
  ],
  [
    { id: "pong", src: "/icons/pong.png" },
    { id: "chess", src: "/icons/chess.png" },
    { id: "worm", src: "/icons/worm.png" },
  ],
];

const MOBILE_ICON_SIZE = 40;
const MOBILE_ICON_COL_PITCH = 56;
const MOBILE_ICON_ROW_PITCH = 60;

const IdleMiniIcons = () => (
  <div
    style={{
      position: "absolute",
      top: 16,
      left: 12,
      display: "flex",
      flexDirection: "row",
      alignItems: "flex-start",
      gap: MOBILE_ICON_COL_PITCH - MOBILE_ICON_SIZE,
    }}
  >
    {IDLE_ICON_COLUMNS.map((col, colIdx) => (
      <div
        key={colIdx}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: MOBILE_ICON_ROW_PITCH - MOBILE_ICON_SIZE - 12,
        }}
      >
        {col.map(icon => (
          <div
            key={icon.id}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              opacity: 0.88,
              width: MOBILE_ICON_SIZE + 8,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={icon.src}
              alt=""
              width={MOBILE_ICON_SIZE}
              height={MOBILE_ICON_SIZE}
              style={{
                imageRendering: "pixelated",
                filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.65))",
              }}
            />
            <span
              style={{
                fontFamily: "var(--slop-font-display)",
                fontSize: 8,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--slop-text-muted)",
                textShadow: "0 1px 2px rgba(0,0,0,0.85)",
                whiteSpace: "nowrap",
              }}
            >
              {icon.id}
            </span>
          </div>
        ))}
      </div>
    ))}
  </div>
);

export default MobileStage;
