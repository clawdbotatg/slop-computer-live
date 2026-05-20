"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { EntryGate } from "~~/components/EntryGate";
import { JoinCard } from "~~/components/JoinCard";
import { PasswordGate } from "~~/components/PasswordGate";
import { AIWalletWindow } from "~~/components/desktop/AIWalletWindow";
import { AudioDropZone, uploadAvatar } from "~~/components/desktop/AudioDropZone";
import { AudioShareDialog } from "~~/components/desktop/AudioShareDialog";
import { AudioVisualizer, audioMutedKey } from "~~/components/desktop/AudioVisualizer";
import { CardWindow } from "~~/components/desktop/CardWindow";
import { ChatWindow } from "~~/components/desktop/ChatWindow";
import { ChessWindow } from "~~/components/desktop/ChessWindow";
import { ClockWindow } from "~~/components/desktop/ClockWindow";
import { DesktopFile } from "~~/components/desktop/DesktopFile";
import { DesktopIcon } from "~~/components/desktop/DesktopIcon";
import { FilePreviewWindow } from "~~/components/desktop/FilePreviewWindow";
import { GasWindow } from "~~/components/desktop/GasWindow";
import { GlossaryWindow } from "~~/components/desktop/GlossaryWindow";
import { HeadlinesBar } from "~~/components/desktop/HeadlinesBar";
import { IncomingTxModal } from "~~/components/desktop/IncomingTxModal";
import { MusicPlayerWindow } from "~~/components/desktop/MusicPlayerWindow";
import { LocalStreamHandle, StreamKind } from "~~/components/desktop/MyCamera";
import { NewsWindow } from "~~/components/desktop/NewsWindow";
import { NotesWindow } from "~~/components/desktop/NotesWindow";
import { PinnedPeers } from "~~/components/desktop/PinnedPeers";
import { QrCodeWindow } from "~~/components/desktop/QrCodeWindow";
import { ResearchWindow } from "~~/components/desktop/ResearchWindow";
import { SharedAppWindow } from "~~/components/desktop/SharedAppWindow";
import { SharedBrowser } from "~~/components/desktop/SharedBrowser";
import { SlopBackdrop } from "~~/components/desktop/SlopBackdrop";
import { TickerBar } from "~~/components/desktop/TickerBar";
import { TimelineBar } from "~~/components/desktop/TimelineBar";
import { TodoWindow } from "~~/components/desktop/TodoWindow";
import { TranscriptWindow } from "~~/components/desktop/TranscriptWindow";
import { TrashCan } from "~~/components/desktop/TrashCan";
import { VideoShareDialog, type VideoShareSubmit } from "~~/components/desktop/VideoShareDialog";
import { VideoView, videoPausedKey } from "~~/components/desktop/VideoView";
import { WalletWindow } from "~~/components/desktop/WalletWindow";
import {
  BandFlag,
  Button,
  ClickRipple,
  DesktopBackground,
  LoadingBar,
  type Menu,
  MenuBar,
  Window,
} from "~~/components/ui";
import Cursor from "~~/components/ui/Cursor";
import { useEnsAvatarFromAddress } from "~~/hooks/useEnsAvatarFromAddress";
import { useEpisodeState } from "~~/hooks/useEpisodeState";
import { useLiveTranscript } from "~~/hooks/useLiveTranscript";
import { useLocalCursor } from "~~/hooks/useLocalCursor";
import { resolutionConstraints, useLocalMedia } from "~~/hooks/useLocalMedia";
import { type Publication, type SlotPosition, usePeerMesh } from "~~/hooks/usePeerMesh";
import { shortAddress, useSession } from "~~/hooks/useSession";
import { useUserGesture } from "~~/hooks/useUserGesture";
import { RoomSlugProvider } from "~~/lib/room-slug";
import { DEFAULT_SLUG } from "~~/lib/slug";
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
// `kind` selects which window type the icon spawns. Defaults to "browser"
// for backwards compatibility with apps.json files written before
// audio/video/screen/chat existed as first-class apps.
type AppEntry = {
  id: string;
  label: string;
  icon: string;
  url?: string;
  kind?:
    | "browser"
    | "chat"
    | "audio"
    | "video"
    | "screen"
    | "music"
    | "chess"
    | "qr"
    | "todo"
    | "notes"
    | "glossary"
    | "gas"
    | "clock"
    | "wallet"
    | "ai-wallet"
    | "research"
    | "news"
    | "transcript"
    | "card";
};

// App ids whose SharedBrowser window is pinned to a single dapp — URL
// bar is hidden, in-desktop "navigate to URL" intents skip it. Value
// is the chunky uppercase title shown on the window chrome.
const LOCKED_APP_TITLES: Record<string, string> = {
  "abi-ninja": "ABININJA",
  "nifty-ink": "NIFTYINK",
};

// Default cascade for icons whose slot hasn't been saved yet — 6 icons
// stack vertically down the left edge, then wrap to a new column 100px
// to the right.
const ICON_DEFAULT_X = 24;
const ICON_DEFAULT_Y0 = 60;
const ICON_ROW_PITCH = 110;
const ICON_COL_PITCH = 100;
const ICONS_PER_COL = 6;

function defaultIconPosition(i: number): { x: number; y: number } {
  const col = Math.floor(i / ICONS_PER_COL);
  const row = i % ICONS_PER_COL;
  return {
    x: ICON_DEFAULT_X + col * ICON_COL_PITCH,
    y: ICON_DEFAULT_Y0 + row * ICON_ROW_PITCH,
  };
}

// Slot id keyed by stable owner identity (wallet address or handle) so the
// layout survives a reload — peerIds are ephemeral and would otherwise reset
// the position every time the user reconnects.
function slotIdFor(pub: Publication): string {
  return `owner-${pub.ownerKey}-${pub.kind}`;
}

// Resume flags + per-kind UI state are scoped to the current room slug:
// a user who left /main publishing audio should NOT auto-publish into
// /ep0 the next time they visit. Old (pre-multi-room) localStorage
// entries with no slug suffix are intentionally orphaned — the failure
// mode is "user has to click share again," which is the right default
// after a room switch.
const RESUME_KEY_BASE = "slop-resume-publishing-v1";
const resumeKey = (slug: string) => `${RESUME_KEY_BASE}:${slug}`;

type ResumeState = Partial<Record<StreamKind, boolean>>;

const readResume = (slug: string): ResumeState => {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(resumeKey(slug)) ?? "{}") as ResumeState;
  } catch {
    return {};
  }
};

const writeResume = (slug: string, state: ResumeState) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(resumeKey(slug), JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
};

// Per-kind persisted UI state rides alongside the resume flags — keep
// each entry tied to its publication's lifecycle. When a publication
// is fully stopped (Stop, close button, peer-initiated close, reconcile
// cleanup), the corresponding flag is meaningless and must clear so a
// fresh share starts in the default state.
const perKindPersistedKey = (slug: string, kind: StreamKind): string | null => {
  if (kind === "camera") return videoPausedKey(slug);
  if (kind === "audio") return audioMutedKey(slug);
  return null;
};

const clearKindPersistedState = (slug: string, kind: StreamKind) => {
  const key = perKindPersistedKey(slug, kind);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* quota / private mode */
  }
};

function DesktopInner({ slug }: { slug: string }) {
  const { session, loading, refresh: refreshSession } = useSession();

  // Pick up an invite from `?invite=…` for the password gate, then strip
  // it from the URL so it doesn't linger or get linked-around. The gate
  // also accepts manual entry, so this is just a convenience.
  const [inviteFromUrl, setInviteFromUrl] = useState<string>("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    const fromUrl = u.searchParams.get("invite");
    if (fromUrl) {
      setInviteFromUrl(fromUrl);
      u.searchParams.delete("invite");
      window.history.replaceState({}, "", u.toString());
    }
  }, []);

  // Room-cookie state for this slug. Determines whether the
  // PasswordGate has to fire even when the user is already signed in
  // (e.g. an admin with a cached session who switches rooms — they
  // still need the new room's password). `null` = unknown (still
  // checking), `false` = need password, `true` = good. The debug
  // sandbox slug always reports true.
  const [roomAuthed, setRoomAuthed] = useState<boolean | null>(slug === DEFAULT_SLUG ? true : null);
  useEffect(() => {
    if (slug === DEFAULT_SLUG) {
      setRoomAuthed(true);
      return;
    }
    setRoomAuthed(null);
    let cancelled = false;
    fetch(
      `${process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080"}/v1/rooms/${encodeURIComponent(slug)}/auth`,
      {
        credentials: "include",
      },
    )
      .then(r => (r.ok ? r.json() : { authed: false }))
      .then((data: { authed?: boolean }) => {
        if (!cancelled) setRoomAuthed(data.authed === true);
      })
      .catch(() => {
        if (!cancelled) setRoomAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const selfHint = useMemo(() => {
    if (!session.authenticated) return null;
    return { role: session.role, address: session.address, handle: session.handle };
  }, [session]);

  // Hold off the WS until we know the room cookie is good — otherwise
  // an admin with a stale session would auto-connect and the server's
  // password-required gate would close the socket in a reconnect loop.
  const mesh = usePeerMesh(session.authenticated && roomAuthed === true, selfHint, slug);
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
      // All publication kinds are resumable across reloads. Audio +
      // camera auto-restart (mic/cam permissions are sticky in Chrome
      // so no prompt). Screen needs a click — getDisplayMedia requires
      // a fresh user gesture — so its window comes back as a
      // placeholder until the user re-acquires.
      const r = readResume(slug);
      writeResume(slug, { ...r, [h.kind]: true });
    },
    [mesh, myLabel],
  );

  const streamsRef = useRef<LocalStreamHandle[]>([]);
  streamsRef.current = streams;

  const stopStream = useCallback(
    (id: string) => {
      const target = streamsRef.current.find(s => s.id === id);
      if (!target) return;
      mesh.unpublish(id);
      target.stream.getTracks().forEach(t => t.stop());
      setStreams(prev => prev.filter(s => s.id !== id));
      const r = readResume(slug);
      delete r[target.kind];
      writeResume(slug, r);
      clearKindPersistedState(slug, target.kind);
    },
    [mesh],
  );

  const media = useLocalMedia(addStream, stopStream);

  // Live transcript gate. STT flows ONLY when the user is actively
  // presenting:
  //   - audio publication exists AND at least one audio track is
  //     unmuted (AudioVisualizer flips audio-track.enabled), OR
  //   - camera publication exists AND at least one video track is
  //     unpaused (VideoView flips video-track.enabled).
  //
  // We deliberately check VIDEO-track.enabled on the camera stream
  // (not its bundled audio track) so that "pause video" — the user's
  // explicit "I'm off" signal — kills STT even though the camera's mic
  // sub-track may still be live to peers. The rule: if you're not
  // visibly on the show, you don't get transcribed.
  //
  // Web Speech reads from the mic hardware directly (not the WebRTC
  // track), so muting peers in the UI doesn't stop the recognizer
  // unless we gate it here. track.enabled has no change event, so we
  // poll the self streams at 500ms. Cheap, and the start/stop latency
  // is imperceptible.
  const [sttEligible, setSttEligible] = useState(false);
  useEffect(() => {
    const compute = () => {
      let on = false;
      for (const s of streamsRef.current) {
        if (s.kind === "audio") {
          for (const t of s.stream.getAudioTracks()) {
            if (t.enabled && t.readyState === "live") {
              on = true;
              break;
            }
          }
        } else if (s.kind === "camera") {
          for (const t of s.stream.getVideoTracks()) {
            if (t.enabled && t.readyState === "live") {
              on = true;
              break;
            }
          }
        }
        if (on) break;
      }
      setSttEligible(prev => (prev === on ? prev : on));
    };
    compute();
    const id = setInterval(compute, 500);
    return () => clearInterval(id);
  }, []);
  const episode = useEpisodeState(RELAY_HTTP);
  useLiveTranscript({
    enabled: sttEligible,
    episodeSttOn: episode.sttOn,
    relayHttpUrl: RELAY_HTTP,
  });

  // Forward-declared so the share menu's "Stop screen" handler can clear it
  // synchronously, regardless of whether we're actively sharing or just have
  // a post-reload resume placeholder up.
  const [wantScreenResume, setWantScreenResume] = useState(false);

  // Audio + video share both use a pre-share dialog where the user picks
  // a device and watches a live preview before committing. The same dialog
  // is reused in "edit" mode (gear icon on the live window) — the parent
  // hot-swaps the underlying track via mesh.replaceTrack so the publication
  // never drops.
  const [audioDialog, setAudioDialog] = useState<"create" | "edit" | null>(null);
  const [videoDialog, setVideoDialog] = useState<"create" | "edit" | null>(null);

  // === Adding a new desktop app ===
  // 1. Add an entry to DEFAULT_APPS in packages/relay/src/index.ts (or
  //    the live apps.json on the box) with a new `kind`.
  // 2. In the icon double-click switch below, call mesh.openWindow(<id>).
  // 3. Render <SharedAppWindow mesh={mesh} id="<id>" title="…"
  //      defaultSlot={…}><YourComponent /></SharedAppWindow>
  //    in the windows section near the bottom of this file.
  // That's all — open/close visibility, position, and the close button
  // are all shared across the mesh automatically. Don't hand-roll local
  // open state or a per-user slot id; that's how chat used to look and
  // why music spent a day being invisible to other players.

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
        const fresh = await mesh.replaceTrack(localAudio.id, "audio", newTrack);
        if (fresh) {
          setStreams(prev => prev.map(s => (s.id === localAudio.id ? { ...s, stream: fresh } : s)));
        }
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
        const fresh = await mesh.replaceTrack(localVideo.id, "video", newTrack);
        if (fresh) {
          setStreams(prev => prev.map(s => (s.id === localVideo.id ? { ...s, stream: fresh } : s)));
        }
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
        const fresh = await mesh.replaceTrack(localVideo.id, "audio", newTrack);
        if (fresh) {
          setStreams(prev => prev.map(s => (s.id === localVideo.id ? { ...s, stream: fresh } : s)));
        }
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
    (url = "https://clawd-slop-landing-nextjs.vercel.app/", appId?: string) => {
      const id = `browser-${Math.random().toString(36).slice(2, 8)}`;
      meshOpenBrowser(id, url, appId);
    },
    [meshOpenBrowser],
  );

  // Click target for in-desktop links (e.g. NewsWindow rows). Reuses the
  // topmost existing browser if one is open so we don't pile up windows;
  // otherwise spawns a fresh one. Either way, raise it to the front.
  const meshNavigateBrowser = mesh.navigateBrowser;
  const meshSlotsRefForOpenUrl = useRef(mesh.slots);
  meshSlotsRefForOpenUrl.current = mesh.slots;
  const meshBrowsersRefForOpenUrl = useRef(mesh.browsers);
  meshBrowsersRefForOpenUrl.current = mesh.browsers;
  const meshUpdateSlotForOpenUrl = mesh.updateSlot;
  const openUrlInBrowser = useCallback(
    (url: string) => {
      const browsers = Object.values(meshBrowsersRefForOpenUrl.current);
      const slots = meshSlotsRefForOpenUrl.current;
      let target: { id: string; slotId: string } | null = null;
      let bestZ = -Infinity;
      for (const b of browsers) {
        // Skip windows pinned to a fixed dapp (e.g. abi-ninja) — they
        // shouldn't get hijacked by a "navigate to URL" intent fired
        // from another app like News.
        if (b.appId) continue;
        const slotId = `browser-${b.id}`;
        const z = slots[slotId]?.z ?? 0;
        if (z > bestZ) {
          bestZ = z;
          target = { id: b.id, slotId };
        }
      }
      if (target) {
        meshNavigateBrowser(target.id, url);
        const maxZ = Math.max(0, ...Object.values(slots).map(s => s.z), 5);
        meshUpdateSlotForOpenUrl({ id: target.slotId, z: maxZ + 1 });
        return;
      }
      const id = `browser-${Math.random().toString(36).slice(2, 8)}`;
      meshOpenBrowser(id, url);
    },
    [meshOpenBrowser, meshNavigateBrowser, meshUpdateSlotForOpenUrl],
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

  // Snap every desktop icon back to the default left-edge cascade. Iteration
  // order is the apps catalog order so the layout is stable across runs.
  const autoArrangeIcons = useCallback(() => {
    apps.forEach((app, i) => {
      const { x, y } = defaultIconPosition(i);
      mesh.updateSlot({ id: `icon-${app.id}`, x, y });
    });
  }, [apps, mesh]);

  // --- Arrange "for X" layouts -------------------------------------------
  // Each writes a batch of slot updates that broadcasts to every peer, so
  // when the host hits "Arrange for Screen Share" every viewer's desktop
  // restacks identically. Geometry uses the local viewport so the
  // proportions look right on each peer's screen even though the absolute
  // sizes differ.
  const meshPublications = mesh.publications;
  const meshSlotsRefForArrange = useRef(mesh.slots);
  meshSlotsRefForArrange.current = mesh.slots;
  const meshUpdateSlotForArrange = mesh.updateSlot;

  const arrangeForScreenShare = useCallback(() => {
    if (typeof window === "undefined") return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const TOP_INSET = 38; // menubar
    const PAD = 12;
    const RIGHT_STRIP = 280;

    const screens = meshPublications.filter(p => p.kind === "screen");
    const cameras = meshPublications.filter(p => p.kind === "camera");

    // Bump z above every existing slot so the rearranged set sits on top
    // of any browsers / app windows the user had floating around.
    let z = Math.max(0, ...Object.values(meshSlotsRefForArrange.current).map(s => s.z), 5) + 1;

    const stageWidth = Math.max(320, vw - RIGHT_STRIP - PAD * 3);
    const stageHeight = Math.max(240, vh - TOP_INSET - PAD * 2);
    screens.forEach((pub, i) => {
      // Multiple screen shares (rare) cascade slightly within the stage.
      meshUpdateSlotForArrange({
        id: slotIdFor(pub),
        x: PAD + i * 16,
        y: TOP_INSET + PAD + i * 16,
        width: stageWidth,
        height: stageHeight,
        z: z++,
      });
    });

    // Cameras stack equally down the right strip.
    if (cameras.length > 0) {
      const totalGap = (cameras.length - 1) * PAD;
      const camHeight = Math.max(120, Math.floor((vh - TOP_INSET - PAD * 2 - totalGap) / cameras.length));
      cameras.forEach((pub, i) => {
        meshUpdateSlotForArrange({
          id: slotIdFor(pub),
          x: vw - RIGHT_STRIP - PAD,
          y: TOP_INSET + PAD + i * (camHeight + PAD),
          width: RIGHT_STRIP,
          height: camHeight,
          z: z++,
        });
      });
    }
  }, [meshPublications, meshUpdateSlotForArrange]);

  const arrangeForVideo = useCallback(() => {
    if (typeof window === "undefined") return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const TOP_INSET = 38;
    const PAD = 12;

    const cameras = meshPublications.filter(p => p.kind === "camera");
    if (cameras.length === 0) return;

    // Hard cap at 5 — host says we'll never exceed that. Extra cameras
    // (defensive) get tiled at the end of the last row.
    const layouts: Array<{ cols: number; rows: number }> = [
      { cols: 1, rows: 1 }, // 1: full
      { cols: 2, rows: 1 }, // 2: side by side
      { cols: 2, rows: 2 }, // 3: 2 over 1 (handled below)
      { cols: 2, rows: 2 }, // 4: 2x2
      { cols: 3, rows: 2 }, // 5: 3 over 2
    ];
    const n = Math.min(cameras.length, layouts.length);
    const layout = layouts[n - 1]!;
    const gridW = vw - PAD * 2;
    const gridH = vh - TOP_INSET - PAD * 2;
    const cellW = Math.floor((gridW - (layout.cols - 1) * PAD) / layout.cols);
    const cellH = Math.floor((gridH - (layout.rows - 1) * PAD) / layout.rows);

    let z = Math.max(0, ...Object.values(meshSlotsRefForArrange.current).map(s => s.z), 5) + 1;

    cameras.forEach((pub, i) => {
      let row = Math.floor(i / layout.cols);
      let col = i % layout.cols;
      // Special case for 3: top row holds 2, bottom row holds 1 centered.
      // (The default 2x2 cell logic would leave a hole on the bottom-
      // right; this centers the third instead.)
      if (n === 3 && i === 2) {
        row = 1;
        col = 0;
      }
      const x = PAD + col * (cellW + PAD);
      const y = TOP_INSET + PAD + row * (cellH + PAD);
      // For the centered 3rd cell, span across both columns horizontally.
      const w = n === 3 && i === 2 ? cellW * 2 + PAD : cellW;
      meshUpdateSlotForArrange({
        id: slotIdFor(pub),
        x,
        y,
        width: w,
        height: cellH,
        z: z++,
      });
    });
  }, [meshPublications, meshUpdateSlotForArrange]);

  // Open music + clock side by side, start a 10-minute countdown so
  // everyone sees the same timer tick down. Wall-clock-anchored via
  // endAt so peers stay in lockstep without per-tick sync.
  const meshSetClockStateForArrange = mesh.setClockState;
  const meshOpenWindowForArrange = mesh.openWindow;
  const arrangeForCountdown = useCallback(() => {
    if (typeof window === "undefined") return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const TOP_INSET = 38;
    const PAD = 16;

    meshOpenWindowForArrange("music");
    meshOpenWindowForArrange("clock");

    // Music left, clock right. Sized so both fit on a normal viewport
    // without overlap; height bounded so they sit in the upper-middle
    // of the screen rather than spanning everything.
    const halfW = Math.max(360, Math.floor((vw - PAD * 3) / 2));
    const winH = Math.max(440, Math.min(640, vh - TOP_INSET - PAD * 2));
    const winY = TOP_INSET + PAD;
    let z = Math.max(0, ...Object.values(meshSlotsRefForArrange.current).map(s => s.z), 5) + 1;
    meshUpdateSlotForArrange({
      id: "app-music",
      x: PAD,
      y: winY,
      width: halfW,
      height: winH,
      z: z++,
    });
    meshUpdateSlotForArrange({
      id: "app-clock",
      x: PAD + halfW + PAD,
      y: winY,
      width: halfW,
      height: winH,
      z: z++,
    });

    // Flip the clock to countdown tab + start a 10-minute timer
    // anchored to Date.now() so every peer's UI computes the same
    // remaining.
    meshSetClockStateForArrange({
      tab: "countdown",
      countdown: {
        phase: "running",
        totalSecs: 600,
        endAt: Date.now() + 600 * 1000,
      },
    });
  }, [meshOpenWindowForArrange, meshUpdateSlotForArrange, meshSetClockStateForArrange]);

  const viewMenu = useMemo<Menu>(
    () => ({
      label: "View",
      items: [
        { label: "✓ Show Cursors", disabled: true },
        { label: "✓ Show Bands", disabled: true },
        { label: "  Show Grid", disabled: true },
        { divider: true, label: "" },
        { label: "Auto Arrange Icons", onClick: autoArrangeIcons },
        { label: "Arrange for Screen Share", onClick: arrangeForScreenShare },
        { label: "Arrange for Video", onClick: arrangeForVideo },
        { label: "Arrange for Countdown", onClick: arrangeForCountdown },
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
    [autoArrangeIcons, arrangeForScreenShare, arrangeForVideo, arrangeForCountdown],
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

  // Audio + camera auto-resume on reload — mic/cam permissions are
  // sticky in Chrome so this won't prompt. Publications that were
  // live before the reload silently re-attach. Screen share is
  // resumable too, but via the click-to-resume placeholder below
  // (getDisplayMedia requires a fresh user gesture, so we can't
  // restart silently).
  useEffect(() => {
    if (!session.authenticated || !mesh.connected) return;
    const r = readResume(slug);
    if (r.audio) {
      void media.startAudio().catch(() => {
        const cur = readResume(slug);
        delete cur.audio;
        writeResume(slug, cur);
      });
    }
    if (r.camera) {
      void media.startCamera().catch(() => {
        const cur = readResume(slug);
        delete cur.camera;
        writeResume(slug, cur);
      });
    }
    // Fire once when both auth + WS are up. media is the live ref and
    // startAudio/startCamera are idempotent (acquire() bails when
    // activeIds[kind] is set), so a reconnect re-fire is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.authenticated, mesh.connected]);

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
      const cur = readResume(slug);
      delete cur.screen;
      writeResume(slug, cur);
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
    setWantScreenResume(Boolean(readResume(slug).screen) && !hasOwnScreenPub);
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
        // Match on handle.id (stable publication streamId) — the
        // underlying MediaStream's .id changes after a hot-swap because
        // replaceTrack rebuilds it.
        const local = streams.find(s => s.id === pub.streamId);
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

  // Any authenticated peer can close any publication window. When the
  // pub is mine, we run the full local cleanup (stop hardware, clear
  // useLocalMedia activeIds, drop the auto-resume flag). When it's
  // someone else's, we just send the unpublish to the relay — it'll
  // broadcast `unpublished`, my reconcile effect below will clean up
  // for the actual publisher (so their camera light goes off etc.).
  const closeWindow = useCallback(
    (pub: Publication) => {
      if (pub.peerId !== mesh.myId) {
        mesh.unpublish(pub.streamId);
        return;
      }
      // Mine. Route through media.stop when this kind is tracked in
      // useLocalMedia so its activeIds get cleared — otherwise the
      // Share menu keeps saying "Stop audio" after the user closed
      // the window. Fall back to direct cleanup for publications that
      // exist outside media's tracking (ghost pubs after reload).
      const tracked =
        (pub.kind === "audio" && media.activeAudio) ||
        (pub.kind === "camera" && media.activeCamera) ||
        (pub.kind === "screen" && media.activeScreen);
      if (tracked) {
        media.stop(pub.kind);
      } else {
        const local = streams.find(s => s.id === pub.streamId);
        if (local) stopStream(local.id);
        else mesh.unpublish(pub.streamId);
        const r = readResume(slug);
        delete r[pub.kind];
        writeResume(slug, r);
        clearKindPersistedState(slug, pub.kind);
      }
      if (pub.kind === "screen") setWantScreenResume(false);
    },
    [mesh, streams, stopStream, media, setWantScreenResume],
  );

  // Reconcile: when one of MY local streams is no longer in the mesh's
  // publication list (because someone else closed my window), tear it
  // down locally too — stop the hardware, clear useLocalMedia state,
  // drop the resume flag.
  //
  // CRITICAL: only react to "was-present, now-absent" transitions, NOT
  // to "absent-this-render". `mesh.publish` is fire-and-forget — it
  // doesn't optimistically insert into mesh.publications, so for a
  // brief window after the user clicks "share audio" the local
  // streams[] has the new stream but mesh.publications hasn't caught
  // up yet. A naive "missing pub → cleanup" check would tear down the
  // stream the user just created; the share would silently nuke
  // itself. The prevPubIds ref tracks the previous render's set so we
  // only fire on real removals.
  const prevMyPubIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!mesh.connected || !mesh.bootstrapped || !mesh.myId) return;
    const myPubStreamIds = new Set(mesh.publications.filter(p => p.peerId === mesh.myId).map(p => p.streamId));
    for (const id of prevMyPubIdsRef.current) {
      if (myPubStreamIds.has(id)) continue;
      const s = streamsRef.current.find(x => x.id === id);
      if (!s) continue;
      const tracked =
        (s.kind === "audio" && media.activeAudio) ||
        (s.kind === "camera" && media.activeCamera) ||
        (s.kind === "screen" && media.activeScreen);
      if (tracked) media.stop(s.kind);
      else stopStream(s.id);
      const r = readResume(slug);
      delete r[s.kind];
      writeResume(slug, r);
      clearKindPersistedState(slug, s.kind);
    }
    prevMyPubIdsRef.current = myPubStreamIds;
  }, [mesh.publications, mesh.connected, mesh.bootstrapped, mesh.myId, media, stopStream]);

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
  // Browsers won't autoplay <audio src="…"> until the tab has registered
  // a user gesture this page-load. The sign-in click counts; a reload
  // with a still-valid cookie does not. If we have a session but no
  // gesture yet, surface the EntryGate so the user produces one — then
  // the global "slop:activated" event lets MusicPlayerWindow (and any
  // future autoplay-blocked component) retry their .play() call.
  const { gestured, trip: tripGesture } = useUserGesture();

  // Trash can — pinned to the bottom-right of THIS viewer's viewport
  // (not in the shared slot system; everyone's trash sits at a
  // different absolute coord because viewports differ in size). The
  // bbox is read from the ref at drop-time so resizes can't desync it.
  const trashRef = useRef<HTMLDivElement | null>(null);
  const isOverTrash = useCallback((iconX: number, iconY: number, iconW = 88, iconH = 110) => {
    const r = trashRef.current?.getBoundingClientRect();
    if (!r) return false;
    return iconX < r.right && iconX + iconW > r.left && iconY < r.bottom && iconY + iconH > r.top;
  }, []);
  // Force-remount counter per app icon — bumped when the user drops
  // an app icon onto the trash, so the icon snaps back to its
  // (unchanged) slot position. Apps can't be trashed; only the user's
  // intent to move is rejected.
  const [iconSnapBackKey, setIconSnapBackKey] = useState<Record<string, number>>({});

  // Open a singleton/preview window AND bump it to the absolute top
  // across all slots. Used by both the icon double-click handler and
  // the file-preview double-click — keeps "summon the window to the
  // front" behavior identical regardless of which kind of icon you
  // hit. Reading mesh.slots through a ref avoids a stale capture if
  // this is called twice in quick succession.
  const meshSlotsRefForFocus = useRef(mesh.slots);
  meshSlotsRefForFocus.current = mesh.slots;
  const meshOpenWindowForFocus = mesh.openWindow;
  const focusApp = useCallback(
    (id: string) => {
      meshOpenWindowForFocus(id);
      const slotId = `app-${id}`;
      const cur = meshSlotsRefForFocus.current[slotId];
      const maxZ = Math.max(0, ...Object.values(meshSlotsRefForFocus.current).map(s => s.z), 5);
      const patch: { id: string; z: number; width?: number; height?: number; y?: number } = {
        id: slotId,
        z: maxZ + 1,
      };
      // Un-minimize: if the slot is at the dock height, inflate to
      // sane defaults so the user actually sees a usable window. Each
      // SharedAppWindow has its own minWidth/minHeight that clamps
      // further.
      if (cur && cur.height <= 40) {
        patch.height = 400;
        patch.width = Math.max(cur.width, 360);
        patch.y = Math.max(60, cur.y - 360);
      }
      meshUpdateSlot(patch);
    },
    [meshOpenWindowForFocus, meshUpdateSlot],
  );

  // Publication-window counterpart of focusApp. Slot ids for media
  // publications are owner-keyed (slotIdFor()), so double-clicking the
  // video icon while already publishing can summon the existing camera
  // window to the front instead of being a no-op. Audio + screen icons
  // follow the same pattern.
  const focusPub = useCallback(
    (kind: StreamKind) => {
      if (!myOwnerKey) return;
      const slotId = `owner-${myOwnerKey}-${kind}`;
      const maxZ = Math.max(0, ...Object.values(meshSlotsRefForFocus.current).map(s => s.z));
      meshUpdateSlot({ id: slotId, z: maxZ + 1 });
    },
    [myOwnerKey, meshUpdateSlot],
  );

  // HARD RULE: any newly-visible window comes to the front, regardless
  // of which mechanism made it appear (Share Audio/Video/Screen, app
  // icon double-click, browser open, file preview, screen-resume
  // placeholder). Diff the union of visible slot ids each render
  // against the previous snapshot; bump every new entry's z to the top
  // in arrival order. This catches the cases the per-mechanism rules
  // miss — chiefly re-opening a window whose slot already exists from
  // a prior session (the slot's persisted z would otherwise win and
  // the new window would spawn underneath whatever the user has
  // raised on top of it).
  //
  // First post-bootstrap pass takes a baseline snapshot WITHOUT
  // bumping, so the user's z-ordering from the last session survives
  // the reload instead of being reshuffled into render order.
  const prevVisibleSlotIdsRef = useRef<Set<string>>(new Set());
  const visibilityBaselineRef = useRef(false);
  const meshUpdateSlotForVis = mesh.updateSlot;
  useEffect(() => {
    if (!mesh.bootstrapped) return;
    const visible = new Set<string>();
    for (const pub of mesh.publications) visible.add(slotIdFor(pub));
    for (const id of mesh.openWindowIds) visible.add(`app-${id}`);
    for (const browser of Object.values(mesh.browsers)) visible.add(`browser-${browser.id}`);
    if (wantScreenResume && screenResumeSlotId) visible.add(screenResumeSlotId);

    if (!visibilityBaselineRef.current) {
      prevVisibleSlotIdsRef.current = visible;
      visibilityBaselineRef.current = true;
      return;
    }

    const newlyVisible: string[] = [];
    for (const sid of visible) {
      if (!prevVisibleSlotIdsRef.current.has(sid)) newlyVisible.push(sid);
    }
    prevVisibleSlotIdsRef.current = visible;
    if (newlyVisible.length === 0) return;
    let top = Math.max(0, ...Object.values(meshSlotsRefForFocus.current).map(s => s.z));
    for (const sid of newlyVisible) {
      top += 1;
      meshUpdateSlotForVis({ id: sid, z: top });
    }
  }, [
    mesh.bootstrapped,
    mesh.publications,
    mesh.openWindowIds,
    mesh.browsers,
    wantScreenResume,
    screenResumeSlotId,
    meshUpdateSlotForVis,
  ]);

  // File previews — opened on double-click of a desktop file. SHARED
  // across the mesh exactly like every other singleton window: the
  // open-state lives in `mesh.openWindowIds` keyed `preview-<fileId>`,
  // geometry lives in `mesh.slots` keyed `app-preview-<fileId>`.
  // Opening one opens for everyone; closing closes for everyone; move
  // / resize / focus broadcast through the same slot system that the
  // chat, music, chess, browser, todo, notes, gas, clock windows all
  // use. NO local state — that was the bug.
  //
  // Auto-cleanup: when a file gets deleted, the open-state for its
  // preview window is stale. Reap any `preview-<id>` whose underlying
  // file is gone.
  const meshCloseWindow = mesh.closeWindow;
  const liveFileIds = useMemo(() => new Set(mesh.files.map(f => f.id)), [mesh.files]);
  useEffect(() => {
    for (const id of mesh.openWindowIds) {
      if (!id.startsWith("preview-")) continue;
      const fileId = id.slice("preview-".length);
      if (!liveFileIds.has(fileId)) meshCloseWindow(id);
    }
  }, [mesh.openWindowIds, liveFileIds, meshCloseWindow]);

  // Build the list of currently-open preview windows from the shared
  // mesh state so every peer renders the same set.
  const openPreviews = useMemo(() => {
    const out: { fileId: string; file: (typeof mesh.files)[number] }[] = [];
    for (const id of mesh.openWindowIds) {
      if (!id.startsWith("preview-")) continue;
      const fileId = id.slice("preview-".length);
      const file = mesh.files.find(f => f.id === fileId);
      if (file) out.push({ fileId, file });
    }
    return out;
  }, [mesh.openWindowIds, mesh.files]);

  // Drop-to-upload: files dragged from the OS onto the desktop background
  // POST to /v1/files and land at the drop coords. The relay broadcasts
  // `file_added` which arrives via the mesh and renders the new icon
  // for everyone; we additionally write the initial slot so the icon
  // appears at the exact spot the user dropped it.
  const [dropHover, setDropHover] = useState(false);
  const dragDepthRef = useRef(0);
  const meshUpdateSlotForFiles = mesh.updateSlot;
  // In-flight upload markers. Per-peer local state — only the uploader
  // sees these (other peers' UIs just see the file appear when the
  // relay broadcasts `file_added`). One entry per in-flight POST, with
  // the same (x, y) the icon will eventually land at so the loader
  // visually morphs into the file icon when the upload completes.
  // `progress` (0..100) is populated from XHR upload.onprogress when
  // the request is `lengthComputable`. While it's still undefined the
  // LoadingBar renders its indeterminate animation; once we get our
  // first progress event the bar switches to determinate mode.
  const [uploadsInFlight, setUploadsInFlight] = useState<
    Array<{ id: string; name: string; x: number; y: number; progress?: number }>
  >([]);

  const uploadFiles = useCallback(
    async (files: FileList, dropX: number, dropY: number) => {
      const maxZ = Math.max(0, ...Object.values(mesh.slots).map(s => s.z), 5);
      let cascade = 0;
      for (const file of Array.from(files)) {
        const localId = `upload-${Math.random().toString(36).slice(2, 10)}`;
        const slotX = dropX + cascade * 12;
        const slotY = dropY + cascade * 12;
        // Show the loader box BEFORE awaiting the network. For multiple
        // dropped files, each gets its own cascaded box so a 5-file
        // drop is 5 stacked boxes you can watch tick down together.
        setUploadsInFlight(prev => [...prev, { id: localId, name: file.name, x: slotX, y: slotY }]);
        cascade += 1;
        // Run the POST through XMLHttpRequest instead of fetch so we
        // can subscribe to `upload.onprogress`. fetch() only exposes a
        // body-reader for DOWNloads, not uploads; XHR is the only
        // way to drive a real determinate progress bar today.
        const result = await new Promise<{ ok: boolean; body?: string }>(resolve => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${RELAY_HTTP}/v1/files?name=${encodeURIComponent(file.name)}`);
          xhr.withCredentials = true;
          xhr.setRequestHeader("content-type", "application/octet-stream");
          xhr.setRequestHeader("x-mime", file.type || "application/octet-stream");
          xhr.upload.onprogress = ev => {
            if (!ev.lengthComputable) return;
            const pct = Math.min(100, Math.max(0, Math.round((ev.loaded / ev.total) * 100)));
            setUploadsInFlight(prev => prev.map(u => (u.id === localId ? { ...u, progress: pct } : u)));
          };
          // upload.onload doesn't fire reliably across browsers; pin
          // 100% on load via the main xhr.onload instead, then resolve.
          xhr.onload = () => {
            setUploadsInFlight(prev => prev.map(u => (u.id === localId ? { ...u, progress: 100 } : u)));
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, body: xhr.responseText });
          };
          xhr.onerror = () => resolve({ ok: false });
          xhr.onabort = () => resolve({ ok: false });
          xhr.send(file);
        });
        try {
          if (!result.ok) {
            console.warn("upload failed", file.name, result.body);
            continue;
          }
          const data = JSON.parse(result.body ?? "{}") as { item?: { id?: string } };
          const id = data.item?.id;
          if (id) {
            meshUpdateSlotForFiles({
              id: `file-${id}`,
              x: slotX,
              y: slotY,
              width: 88,
              height: 110,
              z: maxZ + 1 + cascade,
            });
          }
        } catch (err) {
          console.warn("upload parse failed", file.name, err);
        } finally {
          setUploadsInFlight(prev => prev.filter(u => u.id !== localId));
        }
      }
    },
    [mesh.slots, meshUpdateSlotForFiles],
  );

  return (
    <>
      <DesktopBackground />
      <IncomingTxModal incomingForwards={mesh.incomingForwards} dismissIncomingForward={mesh.dismissIncomingForward} />
      <MenuBar
        menus={[fileMenu, editMenu, viewMenu]}
        meshConnected={mesh.connected}
        walletAddress={mesh.wallet?.address ?? null}
        onWalletClick={session.authenticated ? () => focusApp("wallet") : undefined}
      />
      <div
        onDragEnter={e => {
          if (!session.authenticated) return;
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          dragDepthRef.current += 1;
          setDropHover(true);
        }}
        onDragOver={e => {
          if (!session.authenticated) return;
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropHover(false);
        }}
        onDrop={e => {
          if (!session.authenticated) return;
          if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          dragDepthRef.current = 0;
          setDropHover(false);
          // Drop coords in viewport pixels — same coord space slots live in.
          void uploadFiles(e.dataTransfer.files, e.clientX - 44, e.clientY - 55);
        }}
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
              const fallback = defaultIconPosition(i);
              const slot = mesh.slots[slotId] ?? {
                id: slotId,
                x: fallback.x,
                y: fallback.y,
                width: 88,
                height: 110,
                z: 1,
              };
              return (
                <DesktopIcon
                  // Bump the key whenever this icon needs to snap back
                  // (after a rejected trash drop). React remounts the
                  // Rnd which re-reads its position prop, undoing
                  // react-rnd's local-state drift from the cancelled
                  // drag.
                  key={`${slotId}-${iconSnapBackKey[slotId] ?? 0}`}
                  iconSrc={app.icon}
                  label={app.label}
                  x={slot.x}
                  y={slot.y}
                  zIndex={1}
                  onMove={({ x, y }) => {
                    // Drop onto trash → apps can't be deleted. Bump
                    // the snap-back counter to force a re-render with
                    // the unchanged slot position so the icon visually
                    // returns home.
                    if (isOverTrash(x, y)) {
                      setIconSnapBackKey(prev => ({ ...prev, [slotId]: (prev[slotId] ?? 0) + 1 }));
                      return;
                    }
                    mesh.updateSlot({ id: slotId, x, y });
                  }}
                  onDoubleClick={() => {
                    // focusApp lives at the component scope — it
                    // opens the window AND bumps its z above every
                    // slot, regardless of which kind of icon
                    // triggered it (singleton apps, file previews).
                    switch (app.kind) {
                      case "chat":
                        focusApp("chat");
                        return;
                      case "music":
                        focusApp("music");
                        return;
                      case "chess":
                        focusApp("chess");
                        return;
                      case "qr":
                        focusApp("qr");
                        return;
                      case "todo":
                        focusApp("todo");
                        return;
                      case "notes":
                        focusApp("notes");
                        return;
                      case "glossary":
                        focusApp("glossary");
                        return;
                      case "gas":
                        focusApp("gas");
                        return;
                      case "clock":
                        focusApp("clock");
                        return;
                      case "wallet":
                        focusApp("wallet");
                        return;
                      case "ai-wallet":
                        focusApp("ai-wallet");
                        return;
                      case "research":
                        focusApp("research");
                        return;
                      case "news":
                        focusApp("news");
                        return;
                      case "transcript":
                        focusApp("transcript");
                        return;
                      case "card":
                        focusApp("card");
                        return;
                      case "audio":
                        // Not publishing yet → open the share dialog.
                        // Already publishing → bring the existing window
                        // to the front, mirroring how the app icons
                        // behave when their window is already open.
                        if (media.activeAudio) focusPub("audio");
                        else setAudioDialog("create");
                        return;
                      case "video":
                        if (media.activeCamera) focusPub("camera");
                        else setVideoDialog("create");
                        return;
                      case "screen":
                        if (media.activeScreen || wantScreenResume) focusPub("screen");
                        else void media.startScreen();
                        return;
                      default:
                        if (app.url) spawnBrowser(app.url, app.id);
                    }
                  }}
                />
              );
            })
          : null}

        {/* Desktop files — server-stored, mesh-broadcast. Position lives
            in the slot system keyed `file-<id>`. Drop new files via the
            wrapper's `onDrop` below; downloading is a double-click on
            the icon. */}
        {session.authenticated && mesh.bootstrapped
          ? mesh.files.map((f, i) => {
              const slotId = `file-${f.id}`;
              // Default position spreads new files in a diagonal cascade
              // when no slot exists yet (e.g. fresh upload before our
              // slot_update broadcast lands).
              const slot = mesh.slots[slotId] ?? {
                id: slotId,
                x: 140 + (i % 8) * 95,
                y: 60 + Math.floor(i / 8) * 105,
                width: 88,
                height: 110,
                z: 1,
              };
              const myKey = session.authenticated ? (session.address ?? session.handle ?? "").toLowerCase() : "";
              const canDelete = !!myKey && (f.ownerKey === myKey || session.role === "host");
              return (
                <DesktopFile
                  key={slotId}
                  file={f}
                  x={slot.x}
                  y={slot.y}
                  canDelete={canDelete}
                  onMove={({ x, y }) => mesh.updateSlot({ id: slotId, x, y, width: 88, height: 110 })}
                  onDelete={() => mesh.deleteFile(f.id)}
                  onPreview={() => focusApp(`preview-${f.id}`)}
                  isOverTrash={isOverTrash}
                  onDragEnd={({ x, y }) => {
                    // Dropped on the trash → delete the file. The
                    // file_removed broadcast clears the icon for every
                    // peer; the orphan slot at the trash position is
                    // harmless (no icon points at it anymore).
                    if (isOverTrash(x, y)) mesh.deleteFile(f.id);
                  }}
                />
              );
            })
          : null}

        {/* In-flight upload markers — per-peer local state, only
            visible to the uploader. Render at the same (x, y) the
            eventual file icon will use so the loader visually swaps
            into the icon on completion. */}
        {uploadsInFlight.map(u => (
          <div
            key={u.id}
            aria-hidden
            style={{
              position: "absolute",
              left: u.x,
              top: u.y,
              // Wider than the 88px icon to give the loading bar room
              // to breathe. The eventual file icon still lands flush-
              // left at (u.x, u.y) after the upload finishes; the box
              // is a transient indicator, not a slot placeholder.
              width: 180,
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: "linear-gradient(180deg, rgba(20,10,40,0.92) 0%, rgba(6,3,13,0.92) 100%)",
              border: "1px solid rgba(255,62,201,0.45)",
              borderRadius: 6,
              boxShadow: "0 0 12px rgba(255,62,201,0.25), 0 4px 12px rgba(0,0,0,0.6)",
              zIndex: 2,
              pointerEvents: "none",
              userSelect: "none",
            }}
          >
            <LoadingBar
              cells={10}
              // Determinate once XHR upload.onprogress has fired at
              // least once; before that the bar runs the indeterminate
              // animation (LoadingBar's default when `progress` is
              // undefined). Caption is empty here — we render the %
              // on its own line below the bar so it reads more like
              // a small status panel than an inline progress meter.
              progress={u.progress}
              caption=""
              style={{ fontSize: 13, color: "var(--slop-lime, #bcff5b)" }}
            />
            <span
              style={{
                fontSize: 11,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.1em",
                color: typeof u.progress === "number" ? "var(--slop-amber, #ffae00)" : "var(--slop-text-muted)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {typeof u.progress === "number" ? `${u.progress}%` : "uploading…"}
            </span>
            <span
              style={{
                width: "100%",
                fontSize: 9,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--slop-text-muted)",
                textAlign: "center",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={u.name}
            >
              {u.name}
            </span>
          </div>
        ))}

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
              onClose={() => closeWindow(pub)}
              onMove={({ x, y }) => moveSlot(slotId, x, y)}
              onResize={({ x, y, width, height }) => resizeSlot(slotId, x, y, width, height)}
              bodyStyle={{ padding: 0, overflow: "hidden" }}
              containerInset={{ top: 38 }}
            >
              {stream ? (
                pub.kind === "audio" ? (
                  <AudioDropZone
                    // Owner-key match (not peer-id) so a user with the
                    // wallet open in multiple tabs / devices can drag a
                    // new PFP onto ANY of their audio windows — relay
                    // auth keys avatars on the session's owner, not the
                    // publishing peer.
                    isMine={!!myOwnerKey && pub.ownerKey === myOwnerKey}
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
                      persistMute={pub.peerId === mesh.myId}
                    />
                  </AudioDropZone>
                ) : pub.kind === "camera" ? (
                  <VideoView
                    stream={stream}
                    muted={pub.peerId === mesh.myId}
                    isMine={pub.peerId === mesh.myId}
                    onSettings={pub.peerId === mesh.myId ? () => setVideoDialog("edit") : undefined}
                    persistPause={pub.peerId === mesh.myId}
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
          // Apps that pin the window to a fixed dapp hide the URL bar
          // so users can't navigate away; the title swaps to the app's
          // label instead of echoing the current URL.
          const lockedAppTitle = browser.appId ? LOCKED_APP_TITLES[browser.appId] : undefined;
          const lockedToApp = lockedAppTitle !== undefined;
          const windowTitle = lockedAppTitle ?? `BROWSER — ${browser.url.replace(/^https?:\/\//, "").slice(0, 32)}`;
          return (
            <Window
              key={slotId}
              title={windowTitle}
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
                wallet={mesh.wallet}
                walletProposeTx={mesh.walletProposeTx}
                peers={mesh.peers}
                selfAddress={session.authenticated ? session.address : null}
                selfLabel={session.authenticated ? (session.handle ?? null) : null}
                selfPeerId={mesh.myId}
                forwardTxToPeer={mesh.forwardTxToPeer}
                hideUrlBar={lockedToApp}
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
              const cur = readResume(slug);
              delete cur.screen;
              writeResume(slug, cur);
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

        {/* Drop-to-upload overlay — appears while the user is dragging
            files from the OS over the desktop. Pointer-events:none so
            it doesn't intercept the drop itself (the wrapper above does). */}
        {dropHover ? (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,62,201,0.12)",
              border: "3px dashed var(--slop-magenta, #ff3ec9)",
              color: "#fff",
              fontFamily: "var(--slop-font-display)",
              fontSize: 22,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              pointerEvents: "none",
              zIndex: 9999,
              textShadow: "0 2px 4px rgba(0,0,0,0.6)",
            }}
          >
            drop to share
          </div>
        ) : null}

        {/* === Singleton app windows ============================ */}
        {/* Each <SharedAppWindow> renders if the shared mesh state
            says its id is open — visibility, position, and the close
            button are all synchronized across peers. Drop new apps in
            here following the same pattern. */}
        {session.authenticated ? (
          <>
            <SharedAppWindow
              mesh={mesh}
              id="chat"
              title="Chat"
              defaultSlot={{ x: 80, y: 80, width: 360, height: 420 }}
              minWidth={240}
              minHeight={220}
            >
              <ChatWindow
                messages={mesh.chatMessages}
                sendChat={mesh.sendChat}
                myAddress={session.address}
                myHandle={session.handle}
              />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="music"
              title="SLOPAMP"
              defaultSlot={{ x: 120, y: 120, width: 380, height: 440 }}
              minWidth={300}
              minHeight={300}
            >
              <MusicPlayerWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="chess"
              title="CHESS"
              defaultSlot={{ x: 160, y: 80, width: 480, height: 560 }}
              minWidth={340}
              minHeight={420}
            >
              <ChessWindow mesh={mesh} myOwnerKey={myOwnerKey} myLabel={myLabel} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="qr"
              title="QR"
              defaultSlot={{ x: 200, y: 100, width: 360, height: 480 }}
              minWidth={280}
              minHeight={360}
            >
              <QrCodeWindow />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="todo"
              title="TODO"
              defaultSlot={{ x: 240, y: 120, width: 360, height: 460 }}
              minWidth={260}
              minHeight={300}
            >
              <TodoWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="notes"
              title="NOTES"
              defaultSlot={{ x: 280, y: 140, width: 520, height: 420 }}
              minWidth={360}
              minHeight={300}
            >
              <NotesWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="glossary"
              title="GLOSSARY"
              defaultSlot={{ x: 300, y: 160, width: 420, height: 460 }}
              minWidth={300}
              minHeight={280}
            >
              <GlossaryWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="gas"
              title="GAS"
              defaultSlot={{ x: 320, y: 160, width: 460, height: 460 }}
              minWidth={360}
              minHeight={320}
            >
              <GasWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="clock"
              title="CLOCK"
              defaultSlot={{ x: 360, y: 180, width: 320, height: 380 }}
              minWidth={260}
              minHeight={320}
            >
              <ClockWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="wallet"
              title="WALLET"
              defaultSlot={{ x: 400, y: 100, width: 460, height: 580 }}
              minWidth={360}
              minHeight={420}
            >
              <WalletWindow mesh={mesh} myAddress={session.address} myHandle={session.handle} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="ai-wallet"
              title="AI WALLET"
              defaultSlot={{ x: 440, y: 140, width: 720, height: 620 }}
              minWidth={520}
              minHeight={420}
            >
              <AIWalletWindow mesh={mesh} myAddress={session.address} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="research"
              title="RESEARCH"
              defaultSlot={{ x: 420, y: 120, width: 560, height: 620 }}
              minWidth={420}
              minHeight={420}
            >
              <ResearchWindow />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="news"
              title="NEWS"
              defaultSlot={{ x: 360, y: 100, width: 620, height: 640 }}
              minWidth={420}
              minHeight={360}
            >
              <NewsWindow mesh={mesh} onOpenUrl={openUrlInBrowser} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="transcript"
              title="TRANSCRIPT"
              defaultSlot={{ x: 380, y: 120, width: 480, height: 520 }}
              minWidth={320}
              minHeight={280}
            >
              <TranscriptWindow relayHttpUrl={RELAY_HTTP} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="card"
              title="CARD"
              defaultSlot={{ x: 220, y: 120, width: 780, height: 500 }}
              minWidth={480}
              minHeight={320}
            >
              <CardWindow />
            </SharedAppWindow>
          </>
        ) : null}

        {/* Trash can — pinned bottom-right of THIS viewer's viewport
            (not in the shared slot system). Drag a file icon onto it
            to delete; drag an app icon onto it and it snaps back
            (apps can't be trashed). Gated on auth so the trash isn't
            visible on the sign-in screen. */}
        {session.authenticated ? <SlopBackdrop /> : null}
        {session.authenticated ? <TrashCan trashRef={trashRef} /> : null}
        {/* Timeline bar — top of the three-bar stack. Host's Twitter
            home feed (ranked by engagement on the relay). Scrolls
            fastest so the visual hierarchy reads "fastest at top,
            slowest at bottom". */}
        <TimelineBar mesh={mesh} onOpenUrl={openUrlInBrowser} />
        {/* Headlines bar — middle band, between timeline and ticker.
            Crypto + AI news headlines. */}
        <HeadlinesBar mesh={mesh} onOpenUrl={openUrlInBrowser} />
        {/* Ticker bar — pinned to the very bottom of the desktop on
            every peer. Reads the shared `tickerState` polled by the
            relay (crypto + AI stocks + private AI valuations +
            $CLAWD). Visible pre-auth too so the entry/join screens
            still feel "alive". */}
        <TickerBar mesh={mesh} onOpenUrl={openUrlInBrowser} />
        {/* Always-visible "who's here" panel pinned to the top-right
            (per-peer viewport position, not in the shared slot system,
            like the trash). Sign-out / power dropdowns from the menubar
            naturally overlay this via their z=9100. */}
        {session.authenticated ? <PinnedPeers peers={mesh.peers} myId={mesh.myId} /> : null}

        {/* File previews — shared across the mesh, exactly like every
            other singleton window. Each opens via mesh.openWindow
            (`preview-<fileId>`), geometry lives in the slot system
            keyed `app-preview-<fileId>`, focus / move / resize / close
            all broadcast like the rest of the desktop. Cascading the
            defaultSlot off the file count gives each new preview a
            slightly different home position on first open; after that
            the slot persists. */}
        {openPreviews.map(({ fileId, file }, i) => (
          <SharedAppWindow
            key={`preview-${fileId}`}
            mesh={mesh}
            id={`preview-${fileId}`}
            title={file.name}
            defaultSlot={{
              x: 180 + (i % 6) * 36,
              y: 90 + (i % 6) * 28,
              width: 640,
              height: 500,
              z: 500 + i,
            }}
            minWidth={320}
            minHeight={240}
          >
            <FilePreviewWindow file={file} />
          </SharedAppWindow>
        ))}
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
          {session.invited ? (
            <JoinCard />
          ) : (
            <PasswordGate slug={slug} defaultPassword={inviteFromUrl} onAccepted={() => void refreshSession()} />
          )}
        </div>
      ) : null}

      {/* Room-password gate. Fires after sign-in if the user doesn't
          have a valid cookie for THIS specific room. Catches the case
          where an already-signed-in user (e.g. admin with a cached
          session) navigates to a new room — they still need to prove
          they know its password. Skipped for the debug sandbox slug. */}
      {!loading && session.authenticated && roomAuthed === false ? (
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
          <PasswordGate slug={slug} defaultPassword={inviteFromUrl} onAccepted={() => setRoomAuthed(true)} />
        </div>
      ) : null}

      {/* Third-layer gate: authenticated, room cookie set, but no user
          gesture yet this page-load. Forces a tap so audio/AudioContext
          start. Sign-in flow trips the gesture incidentally (the click
          on Continue / Use Passkey), so this only appears on reload-
          with-valid-session. */}
      {!loading && session.authenticated && roomAuthed === true && !gestured ? (
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
          <EntryGate onEnter={tripGesture} />
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
}

export function Desktop({ slug }: { slug: string }) {
  return (
    <RoomSlugProvider slug={slug}>
      <DesktopInner slug={slug} />
    </RoomSlugProvider>
  );
}
