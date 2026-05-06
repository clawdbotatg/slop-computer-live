"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import type { Address as AddressType } from "viem";
import { JoinCard } from "~~/components/JoinCard";
import { LocalStreamHandle, StreamKind } from "~~/components/desktop/MyCamera";
import { BandFlag, Button, DesktopBackground, type Menu, MenuBar, Window } from "~~/components/ui";
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
          label: "1920 × 1080",
          onClick: () => {
            // Resize the browser window so the viewport is exactly 1920×1080
            // — useful for OBS / window capture. resizeTo takes outer dims, so
            // add the current chrome offset (frame + scrollbars + devtools).
            const dx = window.outerWidth - window.innerWidth;
            const dy = window.outerHeight - window.innerHeight;
            window.resizeTo(1920 + dx, 1080 + dy);
          },
        },
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
