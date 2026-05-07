"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import type { Address as AddressType } from "viem";
import { JoinCard } from "~~/components/JoinCard";
import { DesktopIcon } from "~~/components/desktop/DesktopIcon";
import { LocalStreamHandle, StreamKind } from "~~/components/desktop/MyCamera";
import { SharedBrowser } from "~~/components/desktop/SharedBrowser";
import { BandFlag, Button, ClickRipple, DesktopBackground, type Menu, MenuBar, Window } from "~~/components/ui";
import Cursor from "~~/components/ui/Cursor";
import { useLocalCursor } from "~~/hooks/useLocalCursor";
import { useLocalMedia } from "~~/hooks/useLocalMedia";
import { type Publication, type SlotPosition, usePeerMesh } from "~~/hooks/usePeerMesh";
import { shortAddress, useSession } from "~~/hooks/useSession";
import { bandsFromIdentity } from "~~/utils/blockieBands";

export const dynamic = "force-dynamic";

const DEFAULT_W = 360;
const DEFAULT_H = 260;
const DEFAULT_BASE_X = 80;
const DEFAULT_BASE_Y = 280;
const DEFAULT_STEP = 30;

// Slot id keyed by stable owner identity (wallet address or handle) so the
// layout survives a reload — peerIds are ephemeral and would otherwise reset
// the position every time the user reconnects.
function slotIdFor(pub: Publication): string {
  return `owner-${pub.ownerKey}-${pub.kind}`;
}

const RESUME_KEY = "slop-resume-publishing-v1";

type ResumeState = Partial<Record<StreamKind, boolean>>;

const readResume = (): ResumeState => {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(RESUME_KEY) ?? "{}") as ResumeState;
  } catch {
    return {};
  }
};

const writeResume = (state: ResumeState) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
};

const Desktop: NextPage = () => {
  const { session, loading } = useSession();

  const selfHint = useMemo(() => {
    if (!session.authenticated) return null;
    return { role: session.role, address: session.address, handle: session.handle };
  }, [session]);

  const mesh = usePeerMesh(session.authenticated, selfHint);
  const [streams, setStreams] = useState<LocalStreamHandle[]>([]);

  const myLabel = session.authenticated
    ? (session.handle ?? (session.address ? shortAddress(session.address) : "you"))
    : "guest";

  const peerLabel = useCallback(
    (peerId: string): string => {
      const peer = mesh.peers.find(p => p.id === peerId);
      if (!peer) return peerId.slice(0, 6);
      if (peer.handle) return peer.handle;
      if (peer.address) return shortAddress(peer.address);
      return peerId.slice(0, 6);
    },
    [mesh.peers],
  );

  const addStream = useCallback(
    (h: LocalStreamHandle) => {
      setStreams(prev => (prev.some(s => s.id === h.id) ? prev : [...prev, h]));
      mesh.publish(h.stream, h.kind, myLabel);
      const r = readResume();
      writeResume({ ...r, [h.kind]: true });
    },
    [mesh, myLabel],
  );

  const stopStream = useCallback(
    (id: string) => {
      let stoppedKind: StreamKind | null = null;
      setStreams(prev => {
        const target = prev.find(s => s.id === id);
        if (target) {
          stoppedKind = target.kind;
          mesh.unpublish(id);
          target.stream.getTracks().forEach(t => t.stop());
        }
        return prev.filter(s => s.id !== id);
      });
      if (stoppedKind) {
        const r = readResume();
        delete r[stoppedKind];
        writeResume(r);
      }
    },
    [mesh],
  );

  const media = useLocalMedia(addStream, stopStream);
  // Forward-declared so the share menu's "Stop screen" handler can clear it
  // synchronously, regardless of whether we're actively sharing or just have
  // a post-reload resume placeholder up.
  const [wantScreenResume, setWantScreenResume] = useState(false);

  const stopScreenAndPlaceholder = useCallback(() => {
    if (media.activeScreen) media.stop("screen");
    const cur = readResume();
    delete cur.screen;
    writeResume(cur);
    setWantScreenResume(false);
  }, [media]);

  const shareMenu = useMemo(
    () => ({
      label: "Share",
      items: [
        {
          label: media.activeAudio ? "Stop audio" : "Audio",
          onClick: () => (media.activeAudio ? media.stop("audio") : void media.startAudio()),
        },
        {
          label: media.activeCamera ? "Stop video" : "Video",
          onClick: () => (media.activeCamera ? media.stop("camera") : void media.startCamera()),
        },
        {
          // Treat the placeholder as "active" so the menu always offers a way
          // to dismiss it; clicking stops both the live stream (if any) and
          // any lingering placeholder.
          label: media.activeScreen || wantScreenResume ? "Stop screen" : "Screen",
          onClick: () =>
            media.activeScreen || wantScreenResume ? stopScreenAndPlaceholder() : void media.startScreen(),
        },
      ],
    }),
    [media, wantScreenResume, stopScreenAndPlaceholder],
  );

  const meshOpenBrowser = mesh.openBrowser;
  const spawnBrowser = useCallback(
    (url = "https://app.zerion.io") => {
      const id = `browser-${Math.random().toString(36).slice(2, 8)}`;
      meshOpenBrowser(id, url);
    },
    [meshOpenBrowser],
  );

  const fileMenu = useMemo<Menu>(
    () => ({
      label: "File",
      items: [
        { label: "New Window", shortcut: "⌘N", disabled: true },
        { label: "Open…", shortcut: "⌘O", disabled: true },
        { divider: true, label: "" },
        { label: "Close Window", shortcut: "⌘W", disabled: true },
        { label: "Save Layout", shortcut: "⌘S", disabled: true },
        { divider: true, label: "" },
        { label: "Reload", shortcut: "⌘R", onClick: () => window.location.reload() },
      ],
    }),
    [],
  );

  const editMenu = useMemo<Menu>(
    () => ({
      label: "Edit",
      items: [
        { label: "Undo", shortcut: "⌘Z", disabled: true },
        { label: "Redo", shortcut: "⇧⌘Z", disabled: true },
        { divider: true, label: "" },
        { label: "Cut", shortcut: "⌘X", disabled: true },
        { label: "Copy", shortcut: "⌘C", disabled: true },
        { label: "Paste", shortcut: "⌘V", disabled: true },
        { divider: true, label: "" },
        { label: "Select All", shortcut: "⌘A", disabled: true },
      ],
    }),
    [],
  );

  const viewMenu = useMemo<Menu>(
    () => ({
      label: "View",
      items: [
        { label: "✓ Show Cursors", disabled: true },
        { label: "✓ Show Bands", disabled: true },
        { label: "  Show Grid", disabled: true },
        { divider: true, label: "" },
        { label: "Tile Windows", disabled: true },
        { label: "Cascade Windows", disabled: true },
        { divider: true, label: "" },
        {
          label: "Full Screen",
          shortcut: "⌃⌘F",
          onClick: () => {
            if (document.fullscreenElement) document.exitFullscreen?.();
            else document.documentElement.requestFullscreen?.();
          },
        },
      ],
    }),
    [],
  );

  // ---- Slot clamp on viewport resize ------------------------------------
  // When the viewport shrinks (manual resize, View → 1920×1080, browser
  // zoom, etc.) any open windows that were positioned for a larger viewport
  // would otherwise be parked off-screen. Pull them back inside the visible
  // area, shrinking width/height first if they no longer fit.
  const meshUpdateSlot = mesh.updateSlot;
  const slotsRef = useRef(mesh.slots);
  slotsRef.current = mesh.slots;
  useEffect(() => {
    const MENUBAR = 38;
    const onResize = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      Object.values(slotsRef.current).forEach(slot => {
        let { x, y, width, height } = slot;
        if (width > vw) width = vw;
        if (height > vh - MENUBAR) height = vh - MENUBAR;
        if (x + width > vw) x = vw - width;
        if (y + height > vh) y = vh - height;
        if (x < 0) x = 0;
        if (y < MENUBAR) y = MENUBAR;
        if (x !== slot.x || y !== slot.y || width !== slot.width || height !== slot.height) {
          meshUpdateSlot({ id: slot.id, x, y, width, height });
        }
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [meshUpdateSlot]);

  // ---- Auto-resume publishing on reload ----------------------------------
  // Camera + mic permissions are sticky in Chrome once granted, so the next
  // mount can call getUserMedia silently. Screen share requires a user
  // gesture so we render a placeholder "RESUME SCREEN SHARE" window instead.
  //
  // Both resumes route through useLocalMedia.startX so activeIds gets
  // populated — calling getUserMedia directly leaves media.activeCamera
  // false and the Share menu reads "Video" instead of "Stop video".
  const sessionAuth = session.authenticated;
  useEffect(() => {
    if (!sessionAuth) return;
    if (!mesh.connected) return;
    const r = readResume();
    if (r.camera) {
      media.startCamera().catch(() => {
        const cur = readResume();
        delete cur.camera;
        writeResume(cur);
      });
    }
    if (r.audio) {
      media.startAudio().catch(() => {
        const cur = readResume();
        delete cur.audio;
        writeResume(cur);
      });
    }
    // run once when the WS is up; media deps would re-fire
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionAuth, mesh.connected]);

  // ---- Manual screen share resumption ------------------------------------
  // Route through media.startScreen (the same path the Share menu uses) so
  // activeIds in useLocalMedia gets populated. Calling getDisplayMedia
  // directly bypassed that, leaving media.activeScreen=false even while
  // the share was live — the menu then offered a second "Screen" instead
  // of "Stop screen".
  const startScreenShare = useCallback(async () => {
    try {
      await media.startScreen();
    } catch {
      const cur = readResume();
      delete cur.screen;
      writeResume(cur);
    }
  }, [media]);

  // True when localStorage says we WERE screen-sharing, but we don't have
  // an active own screen publication yet (post-reload state).
  const myOwnerKey = session.authenticated ? ((session.address ?? session.handle)?.toLowerCase() ?? null) : null;
  const hasOwnScreenPub = mesh.publications.some(p => p.peerId === mesh.myId && p.kind === "screen");
  useEffect(() => {
    setWantScreenResume(Boolean(readResume().screen) && !hasOwnScreenPub);
  }, [hasOwnScreenPub]);

  const screenResumeSlotId = myOwnerKey ? `owner-${myOwnerKey}-screen` : null;
  const screenResumeSlot =
    screenResumeSlotId && mesh.slots[screenResumeSlotId]
      ? mesh.slots[screenResumeSlotId]
      : { id: screenResumeSlotId ?? "screen-resume", x: 80, y: 280, width: DEFAULT_W, height: DEFAULT_H, z: 4 };

  // Default slot position for a new publication that doesn't have one yet.
  // New windows land on top of any existing windows. baseZ is taken at the
  // call site so the first new window sits above the current maximum.
  const defaultSlot = useCallback(
    (slotId: string, index: number, baseZ: number): SlotPosition => ({
      id: slotId,
      x: DEFAULT_BASE_X + index * DEFAULT_STEP,
      y: DEFAULT_BASE_Y + index * DEFAULT_STEP,
      width: DEFAULT_W,
      height: DEFAULT_H,
      z: baseZ + index + 1,
    }),
    [],
  );

  // Build the rendered window list from publications + slots.
  // Order: by slot z (asc).
  const windows = useMemo(() => {
    const baseZ = Math.max(4, ...Object.values(mesh.slots).map(s => s.z));
    return mesh.publications
      .map((pub, i) => {
        const slotId = slotIdFor(pub);
        const slot = mesh.slots[slotId] ?? defaultSlot(slotId, i, baseZ);
        return { pub, slotId, slot };
      })
      .sort((a, b) => a.slot.z - b.slot.z);
  }, [mesh.publications, mesh.slots, defaultSlot]);

  // Resolve the live MediaStream for a publication.
  const streamFor = useCallback(
    (pub: Publication): MediaStream | null => {
      if (pub.peerId === mesh.myId) {
        const local = streams.find(s => s.stream.id === pub.streamId);
        return local?.stream ?? null;
      }
      return mesh.remoteStreams.get(pub.streamId) ?? null;
    },
    [mesh.myId, mesh.remoteStreams, streams],
  );

  // ---- Slot editing — any authenticated peer (collaborative) -------------
  const moveSlot = useCallback(
    (slotId: string, x: number, y: number) => {
      mesh.updateSlot({ id: slotId, x, y });
    },
    [mesh],
  );

  const resizeSlot = useCallback(
    (slotId: string, x: number, y: number, width: number, height: number) => {
      mesh.updateSlot({ id: slotId, x, y, width, height });
    },
    [mesh],
  );

  const focusSlot = useCallback(
    (slotId: string) => {
      const maxZ = Math.max(0, ...Object.values(mesh.slots).map(s => s.z), 5);
      mesh.updateSlot({ id: slotId, z: maxZ + 1 });
    },
    [mesh],
  );

  // Closing a window means: stop publishing if it's mine. Otherwise no-op.
  // Synchronously clear the auto-resume flag here so reloads don't re-acquire
  // a stream the user explicitly closed.
  const closeWindow = useCallback(
    (pub: Publication) => {
      if (pub.peerId !== mesh.myId) return;
      const r = readResume();
      delete r[pub.kind];
      writeResume(r);
      const local = streams.find(s => s.stream.id === pub.streamId);
      if (local) stopStream(local.id);
      else mesh.unpublish(pub.streamId);
    },
    [mesh, streams, stopStream],
  );

  // Persist a default slot the first time we see a new publication.
  // Any peer can do this — the relay broadcasts the slot back to everyone.
  // baseZ is captured once at the start so multiple new publications get
  // sequential z values above all existing windows.
  useEffect(() => {
    const baseZ = Math.max(4, ...Object.values(mesh.slots).map(s => s.z));
    let i = 0;
    for (const pub of mesh.publications) {
      const slotId = slotIdFor(pub);
      if (!mesh.slots[slotId]) {
        mesh.updateSlot(defaultSlot(slotId, i, baseZ));
      }
      i++;
    }
  }, [mesh, mesh.publications, mesh.slots, defaultSlot]);

  // Same idea for shared browser windows. Default size is sized so that the
  // stage area (window minus titlebar + URL bar + impersonator strip ≈ 110px)
  // approximates the server viewport's 1280:800 ratio — minimal letterbox
  // bars on first open.
  useEffect(() => {
    const baseZ = Math.max(4, ...Object.values(mesh.slots).map(s => s.z));
    let i = 0;
    for (const browser of Object.values(mesh.browsers)) {
      const slotId = `browser-${browser.id}`;
      if (!mesh.slots[slotId]) {
        mesh.updateSlot({
          id: slotId,
          x: 120 + i * 24,
          y: 120 + i * 24,
          width: 800,
          height: 610,
          z: baseZ + i + 1,
        });
      }
      i++;
    }
  }, [mesh, mesh.browsers, mesh.slots]);

  // Listen for postMessage tx_request events from any iframe inside the page
  // and rebroadcast via the relay so all peers see the captured calldata.
  // The dapp side has to opt in to this protocol — most don't yet, but it
  // gives Impersonator-aware iframes a way to surface tx attempts to the
  // whole show.
  const meshBroadcastTx = mesh.broadcastTxRequest;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; browserId?: unknown; calldata?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type !== "slop:tx_request") return;
      if (typeof data.browserId !== "string" || typeof data.calldata !== "string") return;
      const d = data as {
        browserId: string;
        calldata: string;
        to?: unknown;
        value?: unknown;
        chainId?: unknown;
      };
      meshBroadcastTx({
        browserId: d.browserId,
        calldata: d.calldata,
        to: typeof d.to === "string" ? d.to : null,
        value: typeof d.value === "string" ? d.value : null,
        chainId: typeof d.chainId === "number" ? d.chainId : null,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [meshBroadcastTx]);

  // Broadcast every click so all peers see a colored ripple at the spot
  // where you clicked. Uses 'click' (down+up on same target) rather than
  // 'mousedown' so a drag-to-resize on a Window doesn't fire ripples.
  const meshSendClick = mesh.sendClick;
  const meshConnected = mesh.connected;
  useEffect(() => {
    if (!meshConnected) return;
    const onClick = (e: MouseEvent) => {
      meshSendClick(e.clientX, e.clientY);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [meshConnected, meshSendClick]);

  // Title prefix per kind.
  const titleFor = (pub: Publication) => {
    const verb = pub.kind === "screen" ? "SCREEN" : pub.kind === "audio" ? "AUDIO" : "CAMERA";
    return `${verb} — ${pub.label || peerLabel(pub.peerId)}`;
  };

  const remoteCursors = useMemo(() => {
    const result: Array<{
      peerId: string;
      x: number;
      y: number;
      handle: string | null;
      address: string | null;
    }> = [];
    Object.entries(mesh.cursors).forEach(([peerId, pos]) => {
      if (peerId === mesh.myId) return;
      const peer = mesh.peers.find(p => p.id === peerId);
      result.push({
        peerId,
        x: pos.x,
        y: pos.y,
        handle: peer?.handle ?? null,
        address: peer?.address ?? null,
      });
    });
    return result;
  }, [mesh.cursors, mesh.myId, mesh.peers]);

  const myBands = useMemo(
    () =>
      bandsFromIdentity({
        address: session.authenticated ? session.address : null,
        handle: session.authenticated ? session.handle : null,
        fallback: mesh.myId,
      }),
    [session, mesh.myId],
  );

  const localCursor = useLocalCursor();

  return (
    <>
      <DesktopBackground />
      <MenuBar
        menus={session.authenticated ? [fileMenu, editMenu, viewMenu, shareMenu] : [fileMenu, editMenu, viewMenu]}
        peers={mesh.peers}
        myId={mesh.myId}
        meshConnected={mesh.connected}
      />
      <div
        style={{
          position: "fixed",
          inset: 0,
          paddingTop: 26,
          overflow: "hidden",
          // Hide the system cursor — we render a custom one that follows
          // the mouse and switches to grab/grabbing/text on hover.
          cursor: "none",
        }}
      >
        {!loading && !session.authenticated ? (
          <div
            style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <JoinCard />
          </div>
        ) : null}

        {/* Desktop icons. Position is stored in the shared slots system so
            every peer sees them in the same place (and a relay restart
            doesn't reset the layout). Gated on `bootstrapped` so we don't
            render at the fallback position before the first hello arrives —
            otherwise the icon flashes from default to its persisted spot
            on every reload. */}
        {session.authenticated && mesh.bootstrapped
          ? (() => {
              const slot = mesh.slots["icon-browser"] ?? {
                id: "icon-browser",
                x: 24,
                y: 60,
                width: 88,
                height: 110,
                z: 1,
              };
              return (
                <DesktopIcon
                  key="icon-browser"
                  iconSrc="/icons/browser.png"
                  label="Browser"
                  x={slot.x}
                  y={slot.y}
                  zIndex={1}
                  onMove={({ x, y }) => mesh.updateSlot({ id: "icon-browser", x, y })}
                  onDoubleClick={() => spawnBrowser()}
                />
              );
            })()
          : null}

        {/* Shared windows — one per active publication. Same on every peer. */}
        {windows.map(({ pub, slotId, slot }) => {
          const stream = streamFor(pub);
          return (
            <Window
              key={`${pub.peerId}-${pub.streamId}`}
              title={titleFor(pub)}
              x={slot.x}
              y={slot.y}
              width={slot.width}
              height={slot.height}
              zIndex={slot.z}
              onFocus={() => focusSlot(slotId)}
              onClose={pub.peerId === mesh.myId ? () => closeWindow(pub) : undefined}
              onMove={({ x, y }) => moveSlot(slotId, x, y)}
              onResize={({ x, y, width, height }) => resizeSlot(slotId, x, y, width, height)}
              bodyStyle={{ padding: 0, overflow: "hidden" }}
              containerInset={{ top: 38 }}
            >
              {stream ? (
                <video
                  autoPlay
                  playsInline
                  muted={pub.peerId === mesh.myId}
                  ref={el => {
                    if (el && el.srcObject !== stream) el.srcObject = stream;
                  }}
                  style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000", display: "block" }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    background: "#000",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--slop-text-muted)",
                    fontSize: 12,
                  }}
                >
                  waiting for stream…
                </div>
              )}
            </Window>
          );
        })}

        {/* Shared browser windows — URL synced across all peers. */}
        {Object.values(mesh.browsers).map(browser => {
          const slotId = `browser-${browser.id}`;
          const slot = mesh.slots[slotId] ?? {
            id: slotId,
            x: 120,
            y: 120,
            width: 720,
            height: 540,
            z: 6,
          };
          const txForThis = mesh.txRequests.filter(t => t.browserId === browser.id);
          return (
            <Window
              key={slotId}
              title={`BROWSER — ${browser.url.replace(/^https?:\/\//, "").slice(0, 32)}`}
              x={slot.x}
              y={slot.y}
              width={slot.width}
              height={slot.height}
              zIndex={slot.z}
              minWidth={320}
              minHeight={240}
              onFocus={() => focusSlot(slotId)}
              onClose={() => mesh.closeBrowser(browser.id)}
              onMove={({ x, y }) => moveSlot(slotId, x, y)}
              onResize={({ x, y, width, height }) => resizeSlot(slotId, x, y, width, height)}
              bodyStyle={{ padding: 0, overflow: "hidden" }}
              containerInset={{ top: 38 }}
            >
              <SharedBrowser
                browser={browser}
                txRequests={txForThis}
                onNavigate={url => mesh.navigateBrowser(browser.id, url)}
                canControl={session.authenticated}
              />
            </Window>
          );
        })}

        {/* Screen-share resume placeholder — appears only on the publisher's
            own screen, after a reload, until they click to re-acquire. */}
        {wantScreenResume && screenResumeSlotId ? (
          <Window
            title={`SCREEN — ${myLabel} (paused)`}
            x={screenResumeSlot.x}
            y={screenResumeSlot.y}
            width={screenResumeSlot.width}
            height={screenResumeSlot.height}
            zIndex={screenResumeSlot.z}
            onClose={() => {
              const cur = readResume();
              delete cur.screen;
              writeResume(cur);
              setWantScreenResume(false);
            }}
            onMove={({ x, y }) => moveSlot(screenResumeSlotId, x, y)}
            onResize={({ x, y, width, height }) => resizeSlot(screenResumeSlotId, x, y, width, height)}
            bodyStyle={{ padding: 0, overflow: "hidden" }}
            containerInset={{ top: 38 }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                background: "#000",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                color: "var(--slop-text)",
                fontSize: 12,
                textAlign: "center",
                padding: 16,
              }}
            >
              <span style={{ color: "var(--slop-text-muted)" }}>
                screen share paused on reload — browsers require a click to resume
              </span>
              <Button variant="primary" onClick={startScreenShare}>
                Resume screen share
              </Button>
            </div>
          </Window>
        ) : null}
      </div>

      {/* Click ripples — rendered at top level (not inside the desktop
          wrapper) so the rings aren't clipped over the menubar. Each
          ripple self-prunes from mesh.clicks ~1s after the click. */}
      {mesh.clicks.map(click => {
        const peer = mesh.peers.find(p => p.id === click.peerId);
        const bands = bandsFromIdentity({
          address: peer?.address ?? null,
          handle: peer?.handle ?? null,
          fallback: click.peerId,
        });
        return <ClickRipple key={click.id} x={click.x} y={click.y} bands={bands} />;
      })}

      {/* Cursors render OUTSIDE the desktop wrapper so they aren't clipped
          by its overflow:hidden when over the menubar. Position: fixed +
          zIndex 2^31 keeps them on top of every other layer. */}
      {remoteCursors.map(({ peerId, x, y, handle, address }) => {
        const bands = bandsFromIdentity({ address, handle, fallback: peerId });
        return (
          <Cursor
            key={peerId}
            x={x}
            y={y}
            dimmed
            bands={bands}
            label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {handle ? (
                  <span>{handle}</span>
                ) : address ? (
                  <Address address={address as AddressType} size="xs" onlyEnsOrAddress />
                ) : (
                  <span>{peerId.slice(0, 6)}</span>
                )}
                <BandFlag bands={bands} />
              </span>
            }
          />
        );
      })}

      {localCursor.pos ? (
        <Cursor
          x={localCursor.pos.x}
          y={localCursor.pos.y}
          kind={localCursor.kind}
          bands={myBands}
          label={
            session.authenticated ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {session.handle ? (
                  <span>{session.handle}</span>
                ) : session.address ? (
                  <Address address={session.address as AddressType} size="xs" onlyEnsOrAddress />
                ) : null}
                <BandFlag bands={myBands} />
              </span>
            ) : null
          }
        />
      ) : null}
    </>
  );
};

export default Desktop;
