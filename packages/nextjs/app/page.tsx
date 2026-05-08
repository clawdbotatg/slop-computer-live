"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import type { Address as AddressType } from "viem";
import { JoinCard } from "~~/components/JoinCard";
import { AudioDropZone, uploadAvatar } from "~~/components/desktop/AudioDropZone";
import { AudioShareDialog } from "~~/components/desktop/AudioShareDialog";
import { AudioVisualizer } from "~~/components/desktop/AudioVisualizer";
import { DesktopIcon } from "~~/components/desktop/DesktopIcon";
import { LocalStreamHandle, StreamKind } from "~~/components/desktop/MyCamera";
import { SharedBrowser } from "~~/components/desktop/SharedBrowser";
import { VideoShareDialog, type VideoShareSubmit } from "~~/components/desktop/VideoShareDialog";
import { VideoView } from "~~/components/desktop/VideoView";
import { BandFlag, Button, ClickRipple, DesktopBackground, type Menu, MenuBar, Window } from "~~/components/ui";
import Cursor from "~~/components/ui/Cursor";
import { useEnsAvatarFromAddress } from "~~/hooks/useEnsAvatarFromAddress";
import { useLocalCursor } from "~~/hooks/useLocalCursor";
import { resolutionConstraints, useLocalMedia } from "~~/hooks/useLocalMedia";
import { type Publication, type SlotPosition, usePeerMesh } from "~~/hooks/usePeerMesh";
import { shortAddress, useSession } from "~~/hooks/useSession";
import { bandsFromIdentity } from "~~/utils/blockieBands";

export const dynamic = "force-dynamic";

const DEFAULT_W = 360;
const DEFAULT_H = 260;
const DEFAULT_BASE_X = 80;
const DEFAULT_BASE_Y = 280;
const DEFAULT_STEP = 30;

// Apps catalog comes from the relay's /apps endpoint, which reads
// /var/lib/slop-relay/apps.json on every request. To add a new app, edit
// that JSON on the box — no rebuild needed.
const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
type AppEntry = { id: string; label: string; icon: string; url: string };

// Default cascade for icons whose slot hasn't been saved yet — single
// column down the left edge, 110px apart vertically.
const ICON_DEFAULT_X = 24;
const ICON_DEFAULT_Y0 = 60;
const ICON_ROW_PITCH = 110;

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

  // Track current streams in a ref so stopStream can read them without
  // triggering a callback rebuild on every streams change. The previous
  // version assigned `stoppedKind` inside a setStreams updater and read it
  // afterward — but React 18 doesn't run updaters synchronously, so the
  // resume-flag cleanup ran with stoppedKind still null. Net effect:
  // closing the audio/camera window stopped the stream but left the
  // localStorage resume flag set, so a reload picked the stream back up.
  const streamsRef = useRef<LocalStreamHandle[]>([]);
  streamsRef.current = streams;

  const stopStream = useCallback(
    (id: string) => {
      const target = streamsRef.current.find(s => s.id === id);
      if (!target) return;
      mesh.unpublish(id);
      target.stream.getTracks().forEach(t => t.stop());
      setStreams(prev => prev.filter(s => s.id !== id));
      const r = readResume();
      delete r[target.kind];
      writeResume(r);
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

  // Audio + video share both use a pre-share dialog where the user picks
  // a device and watches a live preview before committing. The same dialog
  // is reused in "edit" mode (gear icon on the live window) — the parent
  // hot-swaps the underlying track via mesh.replaceTrack so the publication
  // never drops.
  const [audioDialog, setAudioDialog] = useState<"create" | "edit" | null>(null);
  const [videoDialog, setVideoDialog] = useState<"create" | "edit" | null>(null);

  const shareMenu = useMemo(
    () => ({
      label: "Share",
      items: [
        {
          label: media.activeAudio ? "Stop audio" : "Audio…",
          onClick: () => (media.activeAudio ? media.stop("audio") : setAudioDialog("create")),
        },
        {
          label: media.activeCamera ? "Stop video" : "Video…",
          onClick: () => (media.activeCamera ? media.stop("camera") : setVideoDialog("create")),
        },
        {
          // Treat the placeholder as "active" so the menu always offers a way
          // to dismiss it; clicking stops both the live stream (if any) and
          // any lingering placeholder.
          label: media.activeScreen || wantScreenResume ? "Stop screen" : "Screen…",
          onClick: () =>
            media.activeScreen || wantScreenResume ? stopScreenAndPlaceholder() : void media.startScreen(),
        },
      ],
    }),
    [media, wantScreenResume, stopScreenAndPlaceholder],
  );

  // Hot-swap the audio track on the active publication. Driven by the
  // share dialog's edit mode — keeps the same publication / streamId so
  // peers don't see a drop, just a brief mic crossover.
  const swapAudioTrack = useCallback(
    async (micId: string) => {
      const localAudio = streamsRef.current.find(s => s.kind === "audio");
      if (!localAudio) return;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: micId ? { deviceId: { exact: micId } } : true,
          video: false,
        });
        const newTrack = newStream.getAudioTracks()[0];
        if (!newTrack) return;
        await mesh.replaceTrack(localAudio.id, "audio", newTrack);
      } catch (err) {
        console.warn("swapAudioTrack failed", err);
      }
    },
    [mesh],
  );

  const swapVideoTrack = useCallback(
    async (sel: VideoShareSubmit) => {
      const localVideo = streamsRef.current.find(s => s.kind === "camera");
      if (!localVideo) return;
      try {
        const constraints: MediaTrackConstraints = {
          ...resolutionConstraints(sel.resolution),
          ...(sel.cameraId ? { deviceId: { exact: sel.cameraId } } : {}),
        };
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: constraints,
          audio: false,
        });
        const newTrack = newStream.getVideoTracks()[0];
        if (!newTrack) return;
        await mesh.replaceTrack(localVideo.id, "video", newTrack);
      } catch (err) {
        console.warn("swapVideoTrack failed", err);
      }
    },
    [mesh],
  );

  // Swap the audio track on the *camera* publication's bundled audio.
  // Distinct from swapAudioTrack (which targets the standalone audio
  // pub) because edits in the video dialog should affect the camera
  // bundle, not necessarily the standalone audio.
  const swapCameraAudioTrack = useCallback(
    async (micId: string) => {
      const localVideo = streamsRef.current.find(s => s.kind === "camera");
      if (!localVideo) return;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: micId ? { deviceId: { exact: micId } } : true,
          video: false,
        });
        const newTrack = newStream.getAudioTracks()[0];
        if (!newTrack) return;
        await mesh.replaceTrack(localVideo.id, "audio", newTrack);
      } catch (err) {
        console.warn("swapCameraAudioTrack failed", err);
      }
    },
    [mesh],
  );

  const handleAudioSubmit = useCallback(
    (_micId: string) => {
      // localStorage is already updated by the dialog; useLocalMedia /
      // swap helpers read it (or the value from arg) directly.
      if (audioDialog === "edit") {
        void swapAudioTrack(_micId);
      } else {
        void media.startAudio();
      }
    },
    [audioDialog, media, swapAudioTrack],
  );

  const handleVideoSubmit = useCallback(
    (sel: VideoShareSubmit) => {
      if (videoDialog === "edit") {
        // Camera publication bundles audio, so swap both tracks on the
        // same stream — no separate audio publication is involved.
        void swapVideoTrack(sel);
        void swapCameraAudioTrack(sel.micId);
        // If a standalone audio publication is also live (Share → Audio
        // earlier in this session), keep it in sync with the dialog's
        // mic pick too.
        if (media.activeAudio) void swapAudioTrack(sel.micId);
      } else {
        // The camera bundle reads MEDIA_PREF_KEYS.micId at start time,
        // and the dialog has already written it to localStorage by the
        // time we get here, so the mic comes along for the ride.
        void media.startCamera();
      }
    },
    [videoDialog, media, swapVideoTrack, swapAudioTrack, swapCameraAudioTrack],
  );

  const meshOpenBrowser = mesh.openBrowser;
  const spawnBrowser = useCallback(
    (url = "https://clawd-slop-landing-nextjs.vercel.app/") => {
      const id = `browser-${Math.random().toString(36).slice(2, 8)}`;
      meshOpenBrowser(id, url);
    },
    [meshOpenBrowser],
  );

  // Fetch the apps catalog from the relay. Re-fetched on auth so anyone
  // who lands on the page (signed in or not) eventually sees the right
  // set; positions of each icon are still slot-synced like before.
  const [apps, setApps] = useState<AppEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`${RELAY_HTTP}/apps`, { cache: "no-store" })
      .then(r => r.json())
      .then((data: { apps?: AppEntry[] }) => {
        if (!cancelled && Array.isArray(data.apps)) setApps(data.apps);
      })
      .catch(() => {
        /* relay offline → no icons; not fatal */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  // Used as a fallback PFP when the user hasn't uploaded a custom one.
  // Resolved on every desktop render; wagmi caches the underlying ENS
  // queries so this is a no-network for everyone after the first lookup.
  const myEnsAvatar = useEnsAvatarFromAddress(session.authenticated ? session.address : null);
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
      // Route through media.stop when this kind is tracked in useLocalMedia
      // so its activeIds get cleared — otherwise the Share menu keeps
      // saying "Stop audio" after the user closed the window. Fall back
      // to direct cleanup for publications that exist outside media's
      // tracking (e.g. ghost pubs after a reload before resume).
      const tracked =
        (pub.kind === "audio" && media.activeAudio) ||
        (pub.kind === "camera" && media.activeCamera) ||
        (pub.kind === "screen" && media.activeScreen);
      if (tracked) {
        media.stop(pub.kind);
      } else {
        const local = streams.find(s => s.stream.id === pub.streamId);
        if (local) stopStream(local.id);
        else mesh.unpublish(pub.streamId);
        const r = readResume();
        delete r[pub.kind];
        writeResume(r);
      }
      if (pub.kind === "screen") setWantScreenResume(false);
    },
    [mesh, streams, stopStream, media, setWantScreenResume],
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
  // where you clicked. The browser's own `click` fires after a window
  // titlebar drag (mousedown + mouseup on the same element), so we track
  // the down position and skip the ripple when the pointer moved more than
  // a few pixels — that's a drag, not a click.
  const meshSendClick = mesh.sendClick;
  const meshConnected = mesh.connected;
  useEffect(() => {
    if (!meshConnected) return;
    const DRAG_THRESHOLD = 6;
    let downX = 0;
    let downY = 0;
    let armed = false;
    const onDown = (e: MouseEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      armed = true;
    };
    const onClick = (e: MouseEvent) => {
      if (!armed) return;
      armed = false;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_THRESHOLD) return;
      meshSendClick(e.clientX, e.clientY);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("click", onClick);
    };
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
      // HTTP agents have no peers-list entry; their cursor message
      // carries identity inline. Prefer the registered peer when
      // present (real WS clients), fall back to the inline values.
      result.push({
        peerId,
        x: pos.x,
        y: pos.y,
        handle: peer?.handle ?? pos.handle ?? null,
        address: peer?.address ?? pos.address ?? null,
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
        {/* Desktop icons. Catalog comes from the relay's /apps endpoint
            (JSON file on the box, no rebuild needed). Position lives in
            the shared slots system keyed by `icon-${app.id}` so dragging
            syncs across peers and survives reloads. Gated on
            `bootstrapped` to avoid the position-flash on first paint. */}
        {session.authenticated && mesh.bootstrapped
          ? apps.map((app, i) => {
              const slotId = `icon-${app.id}`;
              const slot = mesh.slots[slotId] ?? {
                id: slotId,
                x: ICON_DEFAULT_X,
                y: ICON_DEFAULT_Y0 + i * ICON_ROW_PITCH,
                width: 88,
                height: 110,
                z: 1,
              };
              return (
                <DesktopIcon
                  key={slotId}
                  iconSrc={app.icon}
                  label={app.label}
                  x={slot.x}
                  y={slot.y}
                  zIndex={1}
                  onMove={({ x, y }) => mesh.updateSlot({ id: slotId, x, y })}
                  onDoubleClick={() => spawnBrowser(app.url)}
                />
              );
            })
          : null}

        {/* Shared windows — one per active publication. Same on every peer. */}
        {windows.map(({ pub, slotId, slot }) => {
          const stream = streamFor(pub);
          const peer = mesh.peers.find(p => p.id === pub.peerId);
          const pubBands = bandsFromIdentity({
            address: peer?.address ?? null,
            handle: peer?.handle ?? null,
            fallback: pub.ownerKey || pub.peerId,
          });
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
                pub.kind === "audio" ? (
                  <AudioDropZone
                    isMine={pub.peerId === mesh.myId}
                    onFile={file => uploadAvatar(file).catch(err => console.warn("avatar upload failed", err))}
                  >
                    <AudioVisualizer
                      stream={stream}
                      bands={pubBands}
                      muted={pub.peerId === mesh.myId}
                      isMine={pub.peerId === mesh.myId}
                      avatarUrl={mesh.avatars[pub.ownerKey] ?? null}
                      address={peer?.address ?? null}
                      hidden={mesh.hiddenAvatars.has(pub.ownerKey)}
                      onSettings={pub.peerId === mesh.myId ? () => setAudioDialog("edit") : undefined}
                    />
                  </AudioDropZone>
                ) : pub.kind === "camera" ? (
                  <VideoView
                    stream={stream}
                    muted={pub.peerId === mesh.myId}
                    isMine={pub.peerId === mesh.myId}
                    onSettings={pub.peerId === mesh.myId ? () => setVideoDialog("edit") : undefined}
                  />
                ) : (
                  <VideoView stream={stream} muted={pub.peerId === mesh.myId} isMine={pub.peerId === mesh.myId} />
                )
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

      {/* Sign-in gate. While unauthenticated, a full-viewport blur layer
          covers the desktop AND the menubar so nothing behind it is
          interactable. The local cursor (zIndex 2^31) stays on top of
          the blur so the user sees themselves move. */}
      {!loading && !session.authenticated ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            background: "rgba(8,4,18,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <JoinCard />
        </div>
      ) : null}

      {audioDialog ? (
        <AudioShareDialog
          mode={audioDialog}
          avatarUrl={myOwnerKey ? (mesh.avatars[myOwnerKey] ?? null) : null}
          ensAvatarUrl={myEnsAvatar}
          hidden={myOwnerKey ? mesh.hiddenAvatars.has(myOwnerKey) : false}
          onClose={() => setAudioDialog(null)}
          onSubmit={handleAudioSubmit}
        />
      ) : null}

      {videoDialog ? (
        <VideoShareDialog mode={videoDialog} onClose={() => setVideoDialog(null)} onSubmit={handleVideoSubmit} />
      ) : null}

      {/* Click ripples — rendered at top level (not inside the desktop
          wrapper) so the rings aren't clipped over the menubar. Each
          ripple self-prunes from mesh.clicks ~1s after the click. */}
      {mesh.clicks.map(click => {
        const peer = mesh.peers.find(p => p.id === click.peerId);
        // Same fallback chain as cursors: registered peer > inline > peerId hash.
        const bands = bandsFromIdentity({
          address: peer?.address ?? click.address ?? null,
          handle: peer?.handle ?? click.handle ?? null,
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
