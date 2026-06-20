"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import toast, { type Toast } from "react-hot-toast";
import type { Address as AddressType } from "viem";
import { type CommandAction, CommandPalette } from "~~/components/CommandPalette";
import { EntryGate } from "~~/components/EntryGate";
import { JoinCard } from "~~/components/JoinCard";
import { PasswordGate } from "~~/components/PasswordGate";
import { AudioDropZone, uploadAvatar } from "~~/components/desktop/AudioDropZone";
import { AudioShareDialog } from "~~/components/desktop/AudioShareDialog";
import { AudioVisualizer, audioMutedKey } from "~~/components/desktop/AudioVisualizer";
import { CardWindow } from "~~/components/desktop/CardWindow";
import { ChatWindow } from "~~/components/desktop/ChatWindow";
import { ChessWindow } from "~~/components/desktop/ChessWindow";
import { ChyronBar } from "~~/components/desktop/ChyronBar";
import { ClockWindow } from "~~/components/desktop/ClockWindow";
import { DesktopFile } from "~~/components/desktop/DesktopFile";
import { DesktopIcon } from "~~/components/desktop/DesktopIcon";
import { EnsWindow } from "~~/components/desktop/EnsWindow";
import { FilePreviewWindow } from "~~/components/desktop/FilePreviewWindow";
import { GasWindow } from "~~/components/desktop/GasWindow";
import { GlossaryWindow } from "~~/components/desktop/GlossaryWindow";
import { GreenRoomOverlay } from "~~/components/desktop/GreenRoomOverlay";
import { HeadlinesBar } from "~~/components/desktop/HeadlinesBar";
import { IncomingTxModal } from "~~/components/desktop/IncomingTxModal";
import { LeftclawWindow } from "~~/components/desktop/LeftclawWindow";
import { MusicPlayerWindow } from "~~/components/desktop/MusicPlayerWindow";
import { LocalStreamHandle, StreamKind } from "~~/components/desktop/MyCamera";
import { NewsWindow } from "~~/components/desktop/NewsWindow";
import { NotesWindow } from "~~/components/desktop/NotesWindow";
import { PinnedPeers } from "~~/components/desktop/PinnedPeers";
import { PokerWindow } from "~~/components/desktop/PokerWindow";
import { PongWindow } from "~~/components/desktop/PongWindow";
import { PrivateAppWindow } from "~~/components/desktop/PrivateAppWindow";
import { QrCodeWindow } from "~~/components/desktop/QrCodeWindow";
import { ResearchWindow } from "~~/components/desktop/ResearchWindow";
import { SaveLayoutDialog } from "~~/components/desktop/SaveLayoutDialog";
import { SharedAppWindow } from "~~/components/desktop/SharedAppWindow";
import { SharedBrowser } from "~~/components/desktop/SharedBrowser";
import { SlopBackdrop } from "~~/components/desktop/SlopBackdrop";
import { SubtitleCaption } from "~~/components/desktop/SubtitleCaption";
import { TickerBar } from "~~/components/desktop/TickerBar";
import { TileBadge } from "~~/components/desktop/TileBadge";
import { TimelineBar } from "~~/components/desktop/TimelineBar";
import { TodoWindow } from "~~/components/desktop/TodoWindow";
import { TranscriptWindow } from "~~/components/desktop/TranscriptWindow";
import { TrashCan } from "~~/components/desktop/TrashCan";
import { VideoShareDialog, type VideoShareSubmit } from "~~/components/desktop/VideoShareDialog";
import { VideoView, cameraMicMutedKey } from "~~/components/desktop/VideoView";
import { WalletAppWindow } from "~~/components/desktop/WalletAppWindow";
import { WalletWindow } from "~~/components/desktop/WalletWindow";
import { WormWindow } from "~~/components/desktop/WormWindow";
import { BOTTOM_BAR_Z, DOCKED_PILL_BOTTOM_INSET } from "~~/components/desktop/bottomBarLayout";
import {
  BandFlag,
  Bevel,
  Button,
  ClickRipple,
  DesktopBackground,
  LoadingBar,
  type Menu,
  MenuBar,
  Window,
} from "~~/components/ui";
import Cursor from "~~/components/ui/Cursor";
import { FlyingTipCard } from "~~/components/ui/FlyingTipCard";
import { PasskeyWalletProvider } from "~~/components/ui/PasskeyWalletContext";
import { useAudioBusOwner } from "~~/hooks/useAudioBus";
import { useAutoplayBlocked } from "~~/hooks/useAutoplayBlocked";
import { useEnsAvatarFromAddress } from "~~/hooks/useEnsAvatarFromAddress";
import { useEpisodeState } from "~~/hooks/useEpisodeState";
import { useGodModeStt } from "~~/hooks/useGodModeStt";
import { useLiveTranscript } from "~~/hooks/useLiveTranscript";
import { useLocalCursor } from "~~/hooks/useLocalCursor";
import type { UseLocalMedia } from "~~/hooks/useLocalMedia";
import { readDenoisePref, resolutionConstraints, useLocalMedia } from "~~/hooks/useLocalMedia";
import { useLocalWindows } from "~~/hooks/useLocalWindows";
import { type Publication, type SlotPosition, peerLabel as resolvePeerLabel, usePeerMesh } from "~~/hooks/usePeerMesh";
import { shortAddress, useSession } from "~~/hooks/useSession";
import { useUserGesture } from "~~/hooks/useUserGesture";
import { reportMeshBootstrapped, reportRelayWsConnected } from "~~/lib/relayHealth";
import { RoomSlugProvider } from "~~/lib/room-slug";
import { DEFAULT_SLUG, withSlug } from "~~/lib/slug";
import { audioBus } from "~~/utils/audioBus";
import { bandsFromIdentity } from "~~/utils/blockieBands";
import { prewarmDenoise } from "~~/utils/noiseSuppression";
import { getStoredPasskeyIdentity } from "~~/utils/passkey";

export const dynamic = "force-dynamic";

const DEFAULT_W = 360;
const DEFAULT_H = 260;
const DEFAULT_BASE_X = 80;
const DEFAULT_BASE_Y = 280;
const DEFAULT_STEP = 30;

// Sensible maximum size (px) per window kind, applied by every "Arrange …"
// action so auto-layout never balloons a window past a useful size. Most
// windows look best far smaller than the space a naive tiler would hand them
// — SlopAmp, the clock, QR, etc. The layouts still position windows to use
// the whole stage, but each one is clamped to its max and centered in the
// cell it was allotted.
//
// Screen shares are deliberately ABSENT: they're the one window that should
// be free to fill the stage (see arrangeForScreenShare + the "screen" case
// in maxSizeForSlot, which returns Infinity).
const WINDOW_MAX: Record<string, { w: number; h: number }> = {
  music: { w: 260, h: 360 },
  chat: { w: 360, h: 620 },
  clock: { w: 380, h: 320 },
  qr: { w: 320, h: 360 },
  card: { w: 520, h: 660 },
  wallet: { w: 440, h: 600 },
  chess: { w: 520, h: 560 },
  poker: { w: 760, h: 640 },
  pong: { w: 680, h: 520 },
  worm: { w: 520, h: 520 },
  gas: { w: 420, h: 520 },
  ens: { w: 460, h: 440 },
  glossary: { w: 520, h: 620 },
  notes: { w: 560, h: 640 },
  todo: { w: 460, h: 600 },
  news: { w: 560, h: 700 },
  research: { w: 600, h: 720 },
  transcript: { w: 520, h: 720 },
  camera: { w: 440, h: 340 },
  audio: { w: 340, h: 220 },
  browser: { w: 1100, h: 820 },
};

// Windows with no explicit entry above get a comfortably large default — big
// enough to be useful, never the whole stage.
const WINDOW_MAX_DEFAULT = { w: 640, h: 560 };

// Resolve a slot id back to the max-size bucket it belongs to. App windows
// carry their kind in the apps catalog (music/chess/… or "browser" for the
// locked dapps); publication slots encode their kind in the id; browser
// windows are always "browser". Screen shares return Infinity — the single
// window allowed to fill the stage.
function maxSizeForSlot(id: string, appKindById: Record<string, string | undefined>): { w: number; h: number } {
  let kind = "";
  if (id.startsWith("app-")) {
    const appId = id.slice("app-".length);
    kind = appKindById[appId] ?? appId;
  } else if (id.startsWith("browser-")) {
    kind = "browser";
  } else if (id.includes("-screen-")) {
    kind = "screen";
  } else if (id.endsWith("-camera")) {
    kind = "camera";
  } else if (id.endsWith("-audio")) {
    kind = "audio";
  }
  if (kind === "screen") return { w: Infinity, h: Infinity };
  return WINDOW_MAX[kind] ?? WINDOW_MAX_DEFAULT;
}

// Apps catalog comes from the relay's /apps?slug= endpoint on every
// request: built-in DEFAULT_APPS + the global hot-apps overlay + any apps
// scoped to this room. Add a global app by editing hot-apps.json (or POST
// /v1/apps scope:"global"); add a room-only app via POST /v1/apps.
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
    | "poker"
    | "pong"
    | "worm"
    | "qr"
    | "todo"
    | "notes"
    | "glossary"
    | "gas"
    | "clock"
    | "wallet"
    | "mywallet"
    | "research"
    | "leftclaw"
    | "news"
    | "transcript"
    | "card"
    | "ens";
  // "app" → shared-browser window renders as a clean titled app (label in
  // the title bar, URL/nav bar hidden). Omitted/"browser" = full chrome.
  chrome?: "app" | "browser";
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

// Explicit grid for View → Auto Arrange Icons AND for the default position
// of any icon whose slot hasn't been set yet. 5 columns × 4 rows, hand-
// curated so related apps cluster (share kinds, time, knowledge, dapps,
// utility). Apps not listed here fall back to a cascade after the last
// column so a newly-added app still gets a slot.
//
// Using this as the fallback (not just the explicit Auto Arrange action)
// means a freshly-created room renders icons in the curated layout from
// the first paint — no need for the user to click Auto Arrange.
const AUTO_ARRANGE_COLUMNS: ReadonlyArray<ReadonlyArray<string>> = [
  ["chat", "video", "audio", "screen"],
  ["clock", "card", "research", "transcript"],
  ["glossary", "notes", "todo", "qr"],
  ["nifty-ink", "abi-ninja", "gas", "news"],
  ["browser", "wallet", "ens", "music"],
  ["pong", "chess", "worm", "leftclaw"],
  ["poker"],
];

// Is this app placed explicitly in the curated grid above?
const isCuratedIcon = (id: string): boolean => AUTO_ARRANGE_COLUMNS.some(c => c.includes(id));

// `unlistedRank` is the 0-based position of this app among the apps NOT in
// the grid above (curated apps pass 0 — it's ignored for them). Unlisted
// apps take the next free slot, continuing column-major right after the
// last curated column and wrapping every ICONS_PER_COL rows — so a newly
// added app lands at the bottom of the last column, NOT dumped mid-screen.
function defaultIconPosition(appId: string, unlistedRank: number): { x: number; y: number } {
  for (let colIdx = 0; colIdx < AUTO_ARRANGE_COLUMNS.length; colIdx++) {
    const rowIdx = AUTO_ARRANGE_COLUMNS[colIdx].indexOf(appId);
    if (rowIdx !== -1) {
      return {
        x: ICON_DEFAULT_X + colIdx * ICON_COL_PITCH,
        y: ICON_DEFAULT_Y0 + rowIdx * ICON_ROW_PITCH,
      };
    }
  }
  const lastCol = AUTO_ARRANGE_COLUMNS.length - 1;
  const lastColLen = AUTO_ARRANGE_COLUMNS[lastCol]!.length;
  const flat = lastCol * ICONS_PER_COL + lastColLen + unlistedRank;
  const col = Math.floor(flat / ICONS_PER_COL);
  const row = flat % ICONS_PER_COL;
  return {
    x: ICON_DEFAULT_X + col * ICON_COL_PITCH,
    y: ICON_DEFAULT_Y0 + row * ICON_ROW_PITCH,
  };
}

// Slot id keyed by stable owner identity (wallet address or handle) so the
// layout survives a reload — peerIds are ephemeral and would otherwise reset
// the position every time the user reconnects.
//
// Screens additionally include the streamId so a user sharing multiple
// screens gets one window per share. The bare `owner-{key}-screen` slot id
// is still used by the resume-from-reload placeholder (see screenResumeSlotId).
function slotIdFor(pub: Publication): string {
  if (pub.kind === "screen") return `owner-${pub.ownerKey}-screen-${pub.streamId}`;
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

// --- Saved window layouts (GLOBAL per browser, NOT per-room) ------------
// A layout is a named snapshot of which app + browser windows are open,
// where they sit, and whether this user's camera/mic were live. Stored in
// localStorage and NEVER synced. Deliberately *not* slug-scoped — layouts
// are personal workflow setups ("Demo mode", "Coding") that the user wants
// available in every room, unlike the resume-publishing flags above which
// are correctly per-slug. Applying one still mutates the shared, relay-
// authoritative window state of the CURRENT room (see loadLayout's
// Replace semantics).
const LAYOUTS_KEY = "slop-layouts-v1";
// Legacy: a pre-cross-room build wrote under `slop-layouts-v1:<slug>`.
// migrateLegacyLayouts (called from readLayouts) merges those buckets into
// LAYOUTS_KEY the first time we read, then deletes the per-slug entries.
const LEGACY_LAYOUTS_KEY_PREFIX = `${LAYOUTS_KEY}:`;

type SlotGeom = { x: number; y: number; width: number; height: number; z: number };
type SavedLayout = {
  name: string;
  savedAt: number;
  /** Explicit ordering for the Load Layout submenu. Decoupled from
   *  savedAt so drag-reorder can rearrange without lying about when a
   *  layout was created. Backfilled from savedAt-ascending for any
   *  legacy layout that lacks the field (see migrateLayoutsAddOrderField). */
  order?: number;
  /** Singleton apps that were open, with their window geometry. */
  apps: { id: string; geom: SlotGeom }[];
  /** Browser windows. Ids are random per-open so geometry rides inline and
   *  a fresh id is minted on restore. */
  browsers: { url: string; appId?: string; geom: SlotGeom }[];
  /** Only this user's own camera/mic — screen-share is intentionally
   *  excluded (getDisplayMedia needs a fresh OS picker on every restore). */
  media: { kind: "camera" | "audio"; geom: SlotGeom }[];
};

// Run-once guard: we only need to scan localStorage for legacy keys on
// the first read of this session. Subsequent reads skip the scan.
let legacyLayoutsMigrated = false;
const migrateLegacyLayouts = () => {
  if (legacyLayoutsMigrated || typeof window === "undefined") return;
  legacyLayoutsMigrated = true;
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(LEGACY_LAYOUTS_KEY_PREFIX)) legacyKeys.push(k);
    }
    if (legacyKeys.length === 0) return;
    const merged = JSON.parse(window.localStorage.getItem(LAYOUTS_KEY) ?? "{}") as Record<string, SavedLayout>;
    for (const k of legacyKeys) {
      try {
        const perRoom = JSON.parse(window.localStorage.getItem(k) ?? "{}") as Record<string, SavedLayout>;
        // Newest-saved wins on name collision so a layout the user
        // updated in a later room replaces the older one.
        for (const [name, layout] of Object.entries(perRoom)) {
          const cur = merged[name];
          if (!cur || (layout.savedAt ?? 0) > (cur.savedAt ?? 0)) merged[name] = layout;
        }
      } catch {
        /* skip malformed legacy bucket */
      }
      window.localStorage.removeItem(k);
    }
    window.localStorage.setItem(LAYOUTS_KEY, JSON.stringify(merged));
  } catch {
    /* quota / private mode */
  }
};

// Backfill the `order` field on any layout that predates drag-reorder.
// Sorts existing entries by savedAt ascending (the order they appeared
// in the menu before this feature) and assigns 0..N-1. Run-once per
// session; subsequent reads see complete records and no-op.
let orderFieldMigrated = false;
const migrateLayoutsAddOrderField = () => {
  if (orderFieldMigrated || typeof window === "undefined") return;
  orderFieldMigrated = true;
  try {
    const raw = window.localStorage.getItem(LAYOUTS_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, SavedLayout>;
    if (!Object.values(map).some(l => l.order === undefined)) return;
    const sorted = Object.values(map).sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0));
    const next: Record<string, SavedLayout> = {};
    sorted.forEach((l, i) => {
      next[l.name] = { ...l, order: l.order ?? i };
    });
    window.localStorage.setItem(LAYOUTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota / malformed */
  }
};

const readLayouts = (): Record<string, SavedLayout> => {
  if (typeof window === "undefined") return {};
  migrateLegacyLayouts();
  migrateLayoutsAddOrderField();
  try {
    return JSON.parse(window.localStorage.getItem(LAYOUTS_KEY) ?? "{}") as Record<string, SavedLayout>;
  } catch {
    return {};
  }
};

const writeLayouts = (map: Record<string, SavedLayout>) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUTS_KEY, JSON.stringify(map));
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
  if (kind === "camera") return cameraMicMutedKey(slug);
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

// First-visit hint: until the user has either waited 10s or double-clicked
// audio/video/screen once, hide every desktop icon except chat + the three
// share actions and pin a big arrow next to them. Flag is global (not per-
// slug) because the goal is "user has been to slop.computer once" — a
// repeat visitor jumping between rooms shouldn't get the tutorial again.
const HAS_BEEN_HERE_KEY = "slop-has-been-here-v1";

// Per-browser (NOT per-room) flag: the user clicked the menubar 🎙️ to
// park local Web Speech STT — e.g. so another Chrome on this machine can
// use the speech service. See the localSttUserDisabled state in Desktop.
const LOCAL_STT_DISABLED_KEY = "slop-local-stt-disabled-v1";
const HINT_TIMEOUT_MS = 15_000;
const HINT_ALLOWED_KINDS: ReadonlySet<string> = new Set(["chat", "audio", "video", "screen"]);

function DesktopInner({ slug }: { slug: string }) {
  const { session, loading, refresh: refreshSession } = useSession();

  // Pick up an invite from `?invite=…` for the password gate, then strip
  // it from the URL so it doesn't linger or get linked-around. The gate
  // also accepts manual entry, so this is just a convenience.
  //
  // `?godMode=<password>` is the stream-capture box's escape hatch: same
  // room password as everyone else PLUS this second password swaps
  // SIWE / passkey / guest-password for a passive spectator session.
  // Both params are stripped from the URL so the leak surface is just
  // whatever the operator pasted into their address bar.
  const [inviteFromUrl, setInviteFromUrl] = useState<string>("");
  const [godModeFromUrl, setGodModeFromUrl] = useState<string>("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    const fromUrl = u.searchParams.get("invite");
    if (fromUrl) {
      setInviteFromUrl(fromUrl);
      u.searchParams.delete("invite");
    }
    const god = u.searchParams.get("godMode");
    if (god) {
      setGodModeFromUrl(god);
      u.searchParams.delete("godMode");
    }
    if (fromUrl || god) {
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
  // Which gate this room uses. "wallet-signers" rooms skip the password
  // prompt entirely and rely on the signal-socket signer check instead.
  const [roomGate, setRoomGate] = useState<"password" | "wallet-signers">("password");
  // godMode auth is two-step: the room password gate sets the room
  // cookie, THEN we trade the godMode password for a spectator session.
  // `godModeBusy` keeps the JoinCard from flashing between those steps.
  const [godModeBusy, setGodModeBusy] = useState(false);
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
      .then((data: { authed?: boolean; gate?: string }) => {
        if (cancelled) return;
        // Wallet-signer rooms have no password to enter — entry is gated
        // at the signal socket by multisig-signer membership. Clear the
        // password barrier here and let the JoinCard/SIWE flow proceed;
        // a non-signer is turned away by the WS close (-> mesh.connectError).
        if (data.gate === "wallet-signers") {
          setRoomGate("wallet-signers");
          setRoomAuthed(true);
          return;
        }
        setRoomAuthed(data.authed === true);
      })
      .catch(() => {
        if (!cancelled) setRoomAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Trade `?godMode=<password>` for a spectator session once the room
  // cookie is in place. Fires exactly once per page load and only if
  // the URL actually carried the param — normal users never hit this.
  // The PasswordGate runs first because the relay requires a valid
  // room cookie before it'll mint a god-mode session.
  const godModeFiredRef = useRef(false);
  useEffect(() => {
    if (godModeFiredRef.current) return;
    if (!godModeFromUrl) return;
    if (roomAuthed !== true) return;
    if (session.authenticated && session.spectator) return;
    godModeFiredRef.current = true;
    setGodModeBusy(true);
    void (async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080"}/auth/godmode`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: godModeFromUrl }),
        });
        if (!res.ok) {
          // Wrong password / not configured — fall through to the
          // normal JoinCard so the user can still get in manually.
          console.warn("[godMode] auth failed", res.status);
          return;
        }
        await refreshSession();
      } catch (err) {
        console.warn("[godMode] auth error", err);
      } finally {
        setGodModeBusy(false);
      }
    })();
  }, [godModeFromUrl, roomAuthed, session, refreshSession]);

  const selfHint = useMemo(() => {
    if (!session.authenticated) return null;
    return {
      role: session.role,
      address: session.address,
      handle: session.handle,
      // Carry anonId so the self-Peer's customNames lookup + flag color
      // work for anonymous sessions (no address to key off).
      anonId: session.anonId,
      // Threads the god-mode flag through to usePeerMesh so the self-
      // peer it constructs locally matches what the relay stamps for
      // everyone else — otherwise visiblePeers would still show the
      // streaming box in its own Who's Here list.
      ...(session.spectator ? { spectator: true as const } : {}),
    };
  }, [session]);

  // Hold off the WS until we know the room cookie is good — otherwise
  // an admin with a stale session would auto-connect and the server's
  // password-required gate would close the socket in a reconnect loop.
  const mesh = usePeerMesh(session.authenticated && roomAuthed === true, selfHint, slug);

  // Genuine passkey identity addresses to resolve to spendable wallet addresses
  // for display (guest list, transcript, signer rows, …). ONLY passkey users —
  // never an EOA, whose salt-derived "wallet" isn't their wallet. Sources:
  // connected passkey peers, the Bank's passkey signers, and the local user
  // (self isn't in mesh.peers, so add separately when signed in via passkey).
  const selfSessionAddress = session.authenticated ? (session.address ?? null) : null;
  const passkeyAddressesForResolve = useMemo(() => {
    const out = new Set<string>();
    for (const p of mesh.peers) if (p.passkey && p.address) out.add(p.address.toLowerCase());
    for (const s of mesh.wallet?.signers ?? []) if (s.signerType === "passkey") out.add(s.address.toLowerCase());
    const selfAddr = selfSessionAddress?.toLowerCase();
    if (selfAddr && getStoredPasskeyIdentity(selfAddr)) out.add(selfAddr);
    return [...out];
  }, [mesh.peers, mesh.wallet, selfSessionAddress]);
  // Publish the relay WS state into the module-level pub/sub so
  // UpgradeModal (mounted in the providers shell) can react to deploy-
  // induced WS drops in real time, without a context bridge.
  // We publish both `connected` (HTTP-listener-bound, used as the
  // deploy-started trigger) and `bootstrapped` (relay has loaded room
  // state and served us a snapshot, used as the deploy-finished
  // reload signal — /health lies about readiness for several seconds
  // after the relay process is up, but bootstrapped doesn't).
  useEffect(() => {
    reportRelayWsConnected(mesh.connected);
  }, [mesh.connected]);
  useEffect(() => {
    reportMeshBootstrapped(mesh.bootstrapped);
  }, [mesh.bootstrapped]);
  // Hoisted up here (originally lived further down with other gates)
  // because the camera/audio resume effect at ~L1555 needs `gestured`
  // in its dependency array. Calling the hook earlier than its
  // consumer is necessary; useUserGesture has no other dependencies.
  // Browsers won't autoplay <audio src="…"> until the tab has registered
  // a user gesture this page-load. The sign-in click counts; a reload
  // with a still-valid cookie does not. If we have a session but no
  // gesture yet, surface the EntryGate so the user produces one — then
  // the global "slop:activated" event lets MusicPlayerWindow (and any
  // future autoplay-blocked component) retry their .play() call.
  const { gestured, trip: tripGesture } = useUserGesture();
  // Whether the browser will actually refuse unmuted autoplay this load.
  // `false`/`null` (allowed / still probing) → skip the gate; only a hard
  // `true` surfaces it. See useAutoplayBlocked for the detection.
  const autoplayBlocked = useAutoplayBlocked();
  const [streams, setStreams] = useState<LocalStreamHandle[]>([]);

  const myLabel = session.authenticated
    ? ((session.address ? mesh.customNames[session.address.toLowerCase()] : undefined) ??
      session.handle ??
      (session.address ? shortAddress(session.address) : "you"))
    : "guest";

  const peerLabel = useCallback(
    (peerId: string): string => {
      const peer = mesh.peers.find(p => p.id === peerId);
      if (!peer) return peerId.slice(0, 6);
      return resolvePeerLabel(peer, mesh.customNames);
    },
    [mesh.peers, mesh.customNames],
  );

  // One-shot per session: if the user starts a screen-share without
  // checking "Share tab audio" in the browser picker, surface the tip
  // exactly once. Subsequent screen-shares stay quiet — they know now.
  const screenAudioHintShownRef = useRef(false);

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
      if (h.kind === "screen" && h.stream.getAudioTracks().length === 0 && !screenAudioHintShownRef.current) {
        screenAudioHintShownRef.current = true;
        toast.custom(
          (t: Toast) => (
            <div
              style={{
                background: "var(--slop-bg-panel, #1a0d2e)",
                border: "1px solid var(--slop-magenta, #ff3ec9)",
                color: "var(--slop-text, #fff)",
                padding: "10px 14px",
                fontFamily: "var(--slop-font-display)",
                fontSize: 12,
                letterSpacing: "0.04em",
                maxWidth: 360,
                boxShadow: "0 6px 18px rgba(0,0,0,0.55)",
                opacity: t.visible ? 1 : 0,
                transition: "opacity 200ms",
              }}
            >
              💡 tip: to share sound too, pick a <b>Chrome Tab</b> and check <b>&quot;Share tab audio&quot;</b> in the
              picker. window / screen audio doesn&apos;t work on mac.
            </div>
          ),
          { duration: 9000, position: "top-center" },
        );
      }
    },
    [mesh, myLabel, slug],
  );

  const streamsRef = useRef<LocalStreamHandle[]>([]);
  streamsRef.current = streams;

  const stopStream = useCallback(
    (id: string) => {
      const target = streamsRef.current.find(s => s.id === id);
      if (!target) return;
      mesh.unpublish(id);
      // dispose first — for denoise-wrapped streams it stops the upstream
      // mic that isn't reachable through `target.stream` (synthetic audio
      // track only). Idempotent and safe when undefined.
      target.dispose?.();
      target.stream.getTracks().forEach(t => t.stop());
      setStreams(prev => prev.filter(s => s.id !== id));
      // Multi-screen: only drop the kind's resume flag once the LAST stream
      // of that kind is gone. Closing one of two screens shouldn't tell the
      // next reload "we weren't screen-sharing".
      const stillHasKind = streamsRef.current.some(s => s.id !== id && s.kind === target.kind);
      if (!stillHasKind) {
        const r = readResume(slug);
        delete r[target.kind];
        writeResume(slug, r);
        clearKindPersistedState(slug, target.kind);
      }
    },
    [mesh, slug],
  );

  const media = useLocalMedia(addStream, stopStream);

  const episode = useEpisodeState(RELAY_HTTP, slug);
  // God-mode (streaming box): owns the audio bus, runs god-STT, and sets
  // the public stream-output bounds (the dashed god-viewport rectangle).
  const isGodMode = session.authenticated && session.spectator === true;
  // Wake the shared AudioBus on the spectator/streaming box. Every
  // audio element on the page that registers via useAudioBusElement
  // gates on its own god-mode flag too, but the bus itself needs to
  // be activated once so its AudioContext is built + resumed on the
  // first user gesture (otherwise registers race the context init).
  useAudioBusOwner(isGodMode);

  // Green room / standby. God-mode only: the streaming box drops a
  // full-screen preview curtain over the live desktop so the operator can
  // chat + set up backstage (from their normal room session) without the
  // world seeing the room. The flag is SHARED via the relay — pressing
  // spacebar on any god-mode view flips it for the headless broadcaster
  // (which feeds the stream) and every operator monitor at once. The relay
  // also folds it into the air sign every viewer sees (off-air / standby /
  // on-air). Defaults to OFF — god-mode loads straight into the real
  // desktop.
  const greenRoom = mesh.greenRoom;
  const meshSetGreenRoom = mesh.setGreenRoom;
  const toggleGreenRoom = useCallback(() => {
    meshSetGreenRoom(!greenRoom);
  }, [meshSetGreenRoom, greenRoom]);
  // Green room = solo the music on the god-mode broadcast mix. The
  // streaming box mixes every peer's audio for the stream; in standby we
  // silence all of it EXCEPT SlopAmp so the operator + guest can talk
  // backstage without the livestream hearing them. Only the god-mode box
  // owns the bus, so this is a no-op elsewhere. Peer-to-peer audio (what
  // the participants hear directly) is untouched.
  useEffect(() => {
    audioBus().setSoloMusic(isGodMode && greenRoom);
  }, [isGodMode, greenRoom]);
  // God-mode server-side STT. Only the streaming box runs this. It
  // walks every other peer's audio track in the mesh, VAD-gates,
  // captures Opus segments, and POSTs them to /v1/transcript/relay
  // tagged with the speaker's address. Stays running whenever STT is
  // on for the episode — it's the canonical archive source even when
  // we suppress its broadcast for speakers whose in-browser captions
  // are live. The 🛰️ menubar indicator derives from `listening`.
  //
  // Gated OFF in the green room: standby is the operator's backstage,
  // and the whole point of dropping the curtain is to talk freely
  // without it reaching the stream OR the transcript archive. We stop
  // capturing peer audio entirely (no MediaRecorder, no upload, no
  // OpenAI spend) the moment standby engages, and resume on exit. The
  // relay also drops any /v1/transcript/relay post while standby is on
  // as the authoritative backstop — see index.ts — so a stale client
  // can't leak a backstage utterance into the archive.
  const godStt = useGodModeStt({
    enabled: isGodMode && episode.sttOn && !greenRoom,
    mesh,
    relayHttpUrl: RELAY_HTTP,
    slug,
    // Hardcode English so gpt-4o-mini-transcribe doesn't auto-detect
    // per chunk and drift into Spanish/Danish/etc. on short utterances.
    lang: "en",
  });

  // Mirror the AudioVisualizer's selfMuted state up to here so the live
  // STT gate can flip off when the user mutes. AudioVisualizer dispatches
  // `slop-audio-muted-change` on every mute toggle (and on its initial
  // localStorage-resume effect), keyed by slug. The localStorage seed
  // covers the first render before any event fires.
  const [audioMuted, setAudioMuted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(audioMutedKey(slug)) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const handler = (ev: Event) => {
      const e = ev as CustomEvent<{ slug?: string; muted?: boolean }>;
      if (e.detail?.slug !== slug) return;
      setAudioMuted(!!e.detail.muted);
    };
    window.addEventListener("slop-audio-muted-change", handler as EventListener);
    return () => window.removeEventListener("slop-audio-muted-change", handler as EventListener);
  }, [slug]);

  // True when we're publishing a LIVE mic audio track — either a dedicated
  // "audio" share OR the audio bundled inside a "camera" publication.
  // `media.activeAudio` only counts the standalone audio share, so a
  // camera-sharer (the mic rides inside the camera stream) would otherwise
  // never trip the local-STT gate below and stay stuck on the slower
  // god-mode round-trip — even though god-mode reads that exact bundled
  // track. Mirror useGodModeStt's source selection (kind audio | camera)
  // so both caption lanes agree on "this speaker has voice on air".
  const publishingMicAudio = useMemo(
    () =>
      streams.some(
        s =>
          (s.kind === "audio" || s.kind === "camera") && s.stream.getAudioTracks().some(t => t.readyState === "live"),
      ),
    [streams],
  );

  // Per-browser user override for local STT (the menubar 🎙️ toggle).
  // Chrome's speech-recognition service is effectively exclusive per
  // machine — two Chrome instances can't both transcribe — so a user
  // running another Chrome that needs STT can park THIS browser's
  // recognizer here. Captions fall back to god-mode server STT (handled
  // inside useLiveTranscript via alive=false). Browser-wide, not
  // per-room: the contended resource is the browser, not the room.
  const [localSttUserDisabled, setLocalSttUserDisabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(LOCAL_STT_DISABLED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleLocalStt = useCallback(() => {
    setLocalSttUserDisabled(prev => {
      const next = !prev;
      try {
        if (next) window.localStorage.setItem(LOCAL_STT_DISABLED_KEY, "1");
        else window.localStorage.removeItem(LOCAL_STT_DISABLED_KEY);
      } catch {
        /* private mode — toggle still works for this session */
      }
      return next;
    });
  }, []);

  // In-browser Web Speech captions. Runs alongside god-mode STT — it's
  // ~3-5s faster and viewers see the speaker's words form in real time.
  // God-mode is suppressed (broadcast-side only, archive untouched) for
  // any speaker whose pipeline reports alive=true; if Web Speech is
  // unavailable (Firefox) or dies, the hook reports dead and god-mode
  // takes the captions slot. God-mode itself doesn't run this — its
  // captures would all be its own muted/empty mic.
  const liveStt = useLiveTranscript({
    enabled: !isGodMode && publishingMicAudio && !audioMuted && episode.captionsOn,
    episodeSttOn: episode.sttOn,
    userDisabled: localSttUserDisabled,
    meshConnected: mesh.connected,
    sendLiveCaption: mesh.sendLiveCaption,
    sendLiveCaptionState: mesh.sendLiveCaptionState,
  });

  // Forward-declared so the share menu's "Stop screen" handler can clear it
  // synchronously, regardless of whether we're actively sharing or just have
  // a post-reload resume placeholder up.
  const [wantScreenResume, setWantScreenResume] = useState(false);
  // True when localStorage says we WERE sharing camera but no live own
  // camera publication is up yet AND the device isn't already acquired —
  // i.e. the post-reload reconnect window. Drives the "reconnecting video"
  // placeholder. The `!activeCamera` half suppresses a flash on a fresh
  // in-session share (where the flag is written a beat before the pub
  // echoes back, but activeCamera is already true).
  const [wantCameraResume, setWantCameraResume] = useState(false);

  // Audio + video share both use a pre-share dialog where the user picks
  // a device and watches a live preview before committing. The same dialog
  // is reused in "edit" mode (gear icon on the live window) — the parent
  // hot-swaps the underlying track via mesh.replaceTrack so the publication
  // never drops.
  const [audioDialog, setAudioDialog] = useState<"create" | "edit" | null>(null);
  const [videoDialog, setVideoDialog] = useState<"create" | "edit" | null>(null);
  // Single-player ("private") windows: real draggable windows whose geometry +
  // open/close live in localStorage (per room slug), never the mesh — so only
  // this viewer sees them. They wear a grey titlebar as the cue. The personal
  // Wallet is the first such window (see PrivateAppWindow render below).
  const local = useLocalWindows(slug);

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

  // First-visit hint state. `hintActive` controls icon filtering + arrow
  // visibility; `hintDismissedAt` drives the fade-in animation timing.
  // Positions are NOT overridden locally — we just call autoArrangeIcons
  // once on first visit, which broadcasts cleanly cascading defaults
  // through the normal slot system so every peer sees the same layout.
  const [hintActive, setHintActive] = useState(false);
  const [hintDismissedAt, setHintDismissedAt] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!window.localStorage.getItem(HAS_BEEN_HERE_KEY)) setHintActive(true);
    } catch {
      /* private mode → leave hint off, no biggie */
    }
  }, []);

  const dismissHint = useCallback(() => {
    setHintActive(prev => {
      if (!prev) return prev;
      try {
        window.localStorage.setItem(HAS_BEEN_HERE_KEY, "1");
      } catch {
        /* quota / private mode */
      }
      setHintDismissedAt(Date.now());
      return false;
    });
  }, []);

  // Fetch the apps catalog from the relay, scoped to this room: the
  // global layers (DEFAULT_APPS + hot-apps) PLUS any apps added just to
  // this room. Without ?slug the relay returns the global set only.
  // Positions of each icon are still slot-synced like before.
  const [apps, setApps] = useState<AppEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`${RELAY_HTTP}/apps?slug=${encodeURIComponent(slug)}`, { cache: "no-store" })
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
  }, [slug]);

  // --- Saved layouts: state + save / load / delete -----------------------
  // Snapshots live in a single global localStorage bucket (cross-room by
  // design — see the LAYOUTS_KEY comment above). Mirror into React state
  // so the "Load Layout" submenu re-renders on save/delete. No slug
  // dependency: same data shows up in every room within this browser.
  const [savedLayouts, setSavedLayouts] = useState<Record<string, SavedLayout>>(() => readLayouts());
  const [saveLayoutOpen, setSaveLayoutOpen] = useState(false);

  // Read live mesh + media through refs so the callbacks stay stable (they
  // fire on a user click, not a hot path — no need to re-create per render).
  const meshRefForLayouts = useRef(mesh);
  meshRefForLayouts.current = mesh;
  const mediaRefForLayouts = useRef(media);
  mediaRefForLayouts.current = media;
  // ownerKey for this user's own publication slot ids (mirrors myOwnerKey
  // computed later in the component; recomputed here so the callbacks below
  // don't depend on its declaration order).
  const ownerKeyForLayouts = session.authenticated
    ? ((session.address ?? session.handle)?.toLowerCase() ?? null)
    : null;
  const ownerKeyRefForLayouts = useRef(ownerKeyForLayouts);
  ownerKeyRefForLayouts.current = ownerKeyForLayouts;

  // What the MOST RECENT loadLayout asked for, camera/mic-wise (null when
  // no load is being reconciled). startCamera/startAudio are async — the
  // stream doesn't publish, and md.active* doesn't flip true, until
  // getUserMedia + the denoise WASM pipeline finish (~1s). So a second Load
  // fired before the first's share comes up can't see the in-flight stream
  // to stop it, and that earlier share then publishes into a layout that
  // never saved it (the "audio sneaks into every layout" bug). The veto
  // effect below reads this intent against fresh media state and tears down
  // any share that surfaces but isn't wanted. pendingMediaStartsRef counts
  // load-initiated starts still in flight, so the veto only lives as long as
  // a race is actually possible — a later *manual* Share is never touched.
  const mediaIntentRef = useRef<{ camera: boolean; audio: boolean } | null>(null);
  const pendingMediaStartsRef = useRef(0);

  const geomFromSlot = useCallback((slotId: string): SlotGeom => {
    const s = meshRefForLayouts.current.slots[slotId];
    return s
      ? { x: s.x, y: s.y, width: s.width, height: s.height, z: s.z }
      : { x: 80, y: 280, width: 360, height: 260, z: 5 };
  }, []);

  const saveLayout = useCallback(
    (name: string) => {
      const m = meshRefForLayouts.current;
      const md = mediaRefForLayouts.current;
      const key = ownerKeyRefForLayouts.current;
      const apps = [...m.openWindowIds].map(id => ({ id, geom: geomFromSlot(`app-${id}`) }));
      const browsers = Object.values(m.browsers).map(b => ({
        url: b.url,
        appId: b.appId,
        geom: geomFromSlot(`browser-${b.id}`),
      }));
      const media: SavedLayout["media"] = [];
      if (key && md.activeCamera) media.push({ kind: "camera", geom: geomFromSlot(`owner-${key}-camera`) });
      if (key && md.activeAudio) media.push({ kind: "audio", geom: geomFromSlot(`owner-${key}-audio`) });
      setSavedLayouts(prev => {
        // Preserve the existing position on overwrite so save-over-save
        // doesn't yank a layout to the bottom of the menu. Otherwise
        // append: order = (max of existing) + 1.
        const existingOrder = prev[name]?.order;
        const maxOrder = Object.values(prev).reduce((m, l) => Math.max(m, l.order ?? -1), -1);
        const order = existingOrder ?? maxOrder + 1;
        const layout: SavedLayout = { name, savedAt: Date.now(), order, apps, browsers, media };
        const next = { ...prev, [name]: layout };
        writeLayouts(next);
        return next;
      });
      setSaveLayoutOpen(false);
    },
    [geomFromSlot],
  );

  // Replace semantics: make the desktop match the snapshot exactly. Closes
  // open windows that aren't in it, reopens + repositions the ones that
  // are, and re-acquires this user's camera/mic. NB: app/browser windows
  // are room-shared, so this rearranges every peer's view (by design — see
  // the type comment on SavedLayout). Camera/mic only touch this user.
  const loadLayout = useCallback((name: string) => {
    const layout = readLayouts()[name];
    if (!layout) return;
    const m = meshRefForLayouts.current;
    const md = mediaRefForLayouts.current;
    const key = ownerKeyRefForLayouts.current;

    // Close apps not in the snapshot.
    const wantApps = new Set(layout.apps.map(a => a.id));
    for (const id of [...m.openWindowIds]) if (!wantApps.has(id)) m.closeWindow(id);
    // Browser ids are random per-open and can't be matched to saved ones,
    // so for an exact Replace we close every browser and reopen the set.
    for (const b of Object.values(m.browsers)) m.closeBrowser(b.id);

    // Open + position apps.
    for (const a of layout.apps) {
      m.openWindow(a.id);
      m.updateSlot({ id: `app-${a.id}`, ...a.geom });
    }
    // Reopen browsers with fresh ids + saved geometry.
    for (const b of layout.browsers) {
      const id = `browser-${Math.random().toString(36).slice(2, 8)}`;
      m.openBrowser(id, b.url, b.appId);
      m.updateSlot({ id: `browser-${id}`, ...b.geom });
    }

    // Own camera/mic: stop what's not wanted, auto-start what is (sticky
    // Chrome perms mean these usually re-publish without a prompt). The
    // publish/stop lifecycle keeps the localStorage resume flags honest,
    // so a later reload matches too.
    //
    // Record this load's wanted set so the veto effect can cancel any share
    // that comes up late but isn't in it (see mediaIntentRef). The
    // synchronous stops below still handle the common, non-racy case
    // immediately; the effect is the safety net for in-flight starts that a
    // newer load superseded.
    const wantCamera = layout.media.some(x => x.kind === "camera");
    const wantAudio = layout.media.some(x => x.kind === "audio");
    mediaIntentRef.current = { camera: wantCamera, audio: wantAudio };
    if (md.activeCamera && !wantCamera) md.stop("camera");
    if (md.activeAudio && !wantAudio) md.stop("audio");
    if (wantCamera && !md.activeCamera) {
      pendingMediaStartsRef.current++;
      void md
        .startCamera()
        .catch(() => false)
        .finally(() => {
          pendingMediaStartsRef.current--;
        });
    }
    if (wantAudio && !md.activeAudio) {
      pendingMediaStartsRef.current++;
      void md
        .startAudio()
        .catch(() => false)
        .finally(() => {
          pendingMediaStartsRef.current--;
        });
    }
    // No start is in flight → the synchronous stops above already settled
    // everything, so drop the veto now (a lingering intent would shadow a
    // later manual Share). When a start IS pending, the effect clears the
    // intent once that start resolves and any unwanted share is torn down.
    if (pendingMediaStartsRef.current === 0) mediaIntentRef.current = null;
    if (key) for (const x of layout.media) m.updateSlot({ id: `owner-${key}-${x.kind}`, ...x.geom });
  }, []);

  // Veto a camera/mic share that surfaces but wasn't requested by the most
  // recent Load Layout (see mediaIntentRef). Runs on every media on/off
  // transition; `media` here is the current render's value, so stop()
  // reliably targets the live stream — doing this from loadLayout's async
  // start callback instead would close over a stale `activeIds` and no-op.
  // The intent is dropped once no load-initiated start is still in flight
  // and nothing unwanted remains live, so a later manual Share is untouched.
  useEffect(() => {
    const want = mediaIntentRef.current;
    if (!want) return;
    if (media.activeAudio && !want.audio) media.stop("audio");
    if (media.activeCamera && !want.camera) media.stop("camera");
    if (
      pendingMediaStartsRef.current === 0 &&
      !(media.activeAudio && !want.audio) &&
      !(media.activeCamera && !want.camera)
    ) {
      mediaIntentRef.current = null;
    }
  }, [media]);

  const deleteLayout = useCallback((name: string) => {
    setSavedLayouts(prev => {
      const next = { ...prev };
      delete next[name];
      writeLayouts(next);
      return next;
    });
  }, []);

  // Sorted by explicit `order` field (set on save, mutated by drag-
  // reorder). Falls back to savedAt for any legacy record that slipped
  // past the migration. Stable Ctrl+Shift+N bindings: ⌃⇧1 = top row,
  // ⌃⇧2 = second row, etc.
  const layoutNames = useMemo(
    () =>
      Object.keys(savedLayouts).sort((a, b) => {
        const ao = savedLayouts[a]?.order ?? savedLayouts[a]?.savedAt ?? 0;
        const bo = savedLayouts[b]?.order ?? savedLayouts[b]?.savedAt ?? 0;
        return ao - bo;
      }),
    [savedLayouts],
  );

  // Drag-and-drop reorder within the Load Layout submenu. Rebuilds the
  // ordered list with `dragged` moved adjacent to `target`, then
  // renumbers `order` from 0 so future inserts have a clean integer
  // sequence to extend.
  const reorderLayout = useCallback((dragged: string, target: string, position: "before" | "after") => {
    setSavedLayouts(prev => {
      if (!prev[dragged] || !prev[target] || dragged === target) return prev;
      const ordered = Object.values(prev).sort((a, b) => {
        const ao = a.order ?? a.savedAt ?? 0;
        const bo = b.order ?? b.savedAt ?? 0;
        return ao - bo;
      });
      const withoutDragged = ordered.filter(l => l.name !== dragged);
      const targetIdx = withoutDragged.findIndex(l => l.name === target);
      if (targetIdx < 0) return prev;
      const insertAt = position === "before" ? targetIdx : targetIdx + 1;
      const final = [...withoutDragged.slice(0, insertAt), prev[dragged], ...withoutDragged.slice(insertAt)];
      const next: Record<string, SavedLayout> = {};
      final.forEach((l, i) => {
        next[l.name] = { ...l, order: i };
      });
      writeLayouts(next);
      return next;
    });
  }, []);

  // Refs into the close/minimize-top-window callbacks defined far below
  // this point in the file. Both the File menu (Close Window) and the
  // View menu (Close/Minimize Window) need to invoke them, but the
  // actual callbacks depend on closeWindow (the publication closer)
  // which isn't defined yet at this line — directly referencing them
  // would TDZ. The ref pattern decouples reference from definition:
  // menu items call .current() on click, and a downstream useEffect
  // points .current at the live callback.
  const closeTopWindowRef = useRef<() => void>(() => {});
  const minimizeTopWindowRef = useRef<() => void>(() => {});
  // Hidden <input type="file"> driven by File ▸ Upload…. Declared here
  // so the menu can ref-click it without depending on uploadFiles's
  // (much later) declaration site; the onChange runs at user-interaction
  // time, by which point uploadFiles is in scope.
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const fileMenu = useMemo<Menu>(
    () => ({
      label: "File",
      items: [
        { label: "New Window", shortcut: "⌘N", disabled: true },
        { label: "Upload…", shortcut: "⌃⇧U", onClick: () => uploadInputRef.current?.click() },
        { divider: true, label: "" },
        { label: "Close Window", shortcut: "⌃⇧W", onClick: () => closeTopWindowRef.current() },
        { label: "Save Layout…", shortcut: "⌃⇧S", onClick: () => setSaveLayoutOpen(true) },
        {
          label: "Load Layout",
          disabled: layoutNames.length === 0,
          // The first 9 layouts get a Ctrl+Shift+1..9 binding so the
          // top-of-mind setups switch instantly without diving through the
          // menu. Wired in the global keydown effect further down. Each
          // row is also drag-reorderable — the closure captures `n` as
          // the drop target so reorderLayout knows which row was hovered.
          submenu: layoutNames.map((n, i) => ({
            label: n,
            shortcut: i < 9 ? `⌃⇧${i + 1}` : undefined,
            onClick: () => loadLayout(n),
            onDelete: () => deleteLayout(n),
            onReorder: (dragged, position) => reorderLayout(dragged, n, position),
          })),
        },
        { divider: true, label: "" },
        { label: "Reload", shortcut: "⌘R", onClick: () => window.location.reload() },
      ],
    }),
    [layoutNames, loadLayout, deleteLayout, reorderLayout],
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

  // Snap every desktop icon back to its curated default position by writing
  // the slot state explicitly — overrides any drags users have done. Uses
  // the same helper as the unset-slot fallback so the two layouts stay in
  // lockstep: clicking Auto Arrange always produces the layout a brand-new
  // room would have shown.
  const autoArrangeIcons = useCallback(() => {
    let unlistedRank = 0;
    apps.forEach(app => {
      const { x, y } = defaultIconPosition(app.id, isCuratedIcon(app.id) ? 0 : unlistedRank++);
      mesh.updateSlot({ id: `icon-${app.id}`, x, y });
    });
  }, [apps, mesh]);

  // First-visit auto-arrange: a brand-new user landing into a room with
  // stale / stacked slot positions (e.g. someone dragged everything into
  // a pile during testing) would otherwise see all icons piled at the
  // same spot once the hint dismisses. Snap the icon layout to its
  // default cascade exactly once, the moment we recognize a first
  // visitor — runs after apps + bootstrap so updateSlot actually lands.
  const arrangedOnFirstVisitRef = useRef(false);
  useEffect(() => {
    if (!hintActive) return;
    if (arrangedOnFirstVisitRef.current) return;
    if (apps.length === 0) return;
    if (!mesh.bootstrapped || !mesh.connected) return;
    arrangedOnFirstVisitRef.current = true;
    autoArrangeIcons();
  }, [hintActive, apps.length, mesh.bootstrapped, mesh.connected, autoArrangeIcons]);

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

  // "Arrange for X" layouts target the live-stream frame — the dashed
  // god-mode boundary every peer can see — instead of the acting peer's
  // own viewport. Without this, a host on a high-res display arranges
  // windows out past the streamed frame and viewers see them half-off or
  // gone entirely. On the god-mode machine itself this is a no-op (its
  // godViewport *is* its window size), so only the off-frame peers get
  // fixed. Read through a ref so the arrange callbacks don't re-create
  // every time the spectator resizes. Falls back to the same 1920×1080
  // OBS target the dashed guide draws when no spectator is live.
  const meshGodViewportRef = useRef(mesh.godViewport);
  meshGodViewportRef.current = mesh.godViewport;

  // Live window-set refs for Auto Arrange — read synchronously inside the
  // callback so it doesn't re-create every time a window opens or closes.
  const meshOpenWindowIdsRef = useRef(mesh.openWindowIds);
  meshOpenWindowIdsRef.current = mesh.openWindowIds;
  const meshBrowsersRefForArrange = useRef(mesh.browsers);
  meshBrowsersRefForArrange.current = mesh.browsers;
  // App-id → kind map for the max-size lookup (most ids equal their kind;
  // the locked dapps and the generic browser app resolve to "browser").
  const appsRefForArrange = useRef(apps);
  appsRefForArrange.current = apps;

  const arrangeForScreenShare = useCallback(() => {
    if (typeof window === "undefined") return;
    const { width: vw, height: vh } = meshGodViewportRef.current ?? { width: 1920, height: 1080 };
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

    // Cameras stack down the right strip, each clamped to a tidy webcam tile
    // — never stretched to fill the column. A single camera sits at the top
    // at its natural size rather than ballooning down the whole edge.
    if (cameras.length > 0) {
      const camMax = WINDOW_MAX.camera;
      const camW = Math.min(RIGHT_STRIP, camMax.w);
      // Keep the reference tile's aspect so the narrow strip doesn't produce
      // a tall, skinny camera.
      const camAspectH = Math.round(camW * (camMax.h / camMax.w));
      const totalGap = (cameras.length - 1) * PAD;
      const split = Math.floor((vh - TOP_INSET - PAD * 2 - totalGap) / cameras.length);
      const camHeight = Math.max(120, Math.min(split, camAspectH, camMax.h));
      const camX = vw - RIGHT_STRIP - PAD + Math.round((RIGHT_STRIP - camW) / 2);
      cameras.forEach((pub, i) => {
        meshUpdateSlotForArrange({
          id: slotIdFor(pub),
          x: camX,
          y: TOP_INSET + PAD + i * (camHeight + PAD),
          width: camW,
          height: camHeight,
          z: z++,
        });
      });
    }
  }, [meshPublications, meshUpdateSlotForArrange]);

  const arrangeForVideo = useCallback(() => {
    if (typeof window === "undefined") return;
    const { width: vw, height: vh } = meshGodViewportRef.current ?? { width: 1920, height: 1080 };
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
    // Fit each cell to the grid, then cap it to the camera tile max. Uncapped,
    // a 1- or 2-camera call ballooned each tile to span the full viewport —
    // way too big. Capped cells stay a tidy webcam-sized tile, and the whole
    // block is centered rather than anchored to the top-left corner.
    const fitW = Math.floor((gridW - (layout.cols - 1) * PAD) / layout.cols);
    const fitH = Math.floor((gridH - (layout.rows - 1) * PAD) / layout.rows);
    const cellW = Math.min(fitW, WINDOW_MAX.camera.w);
    const cellH = Math.min(fitH, WINDOW_MAX.camera.h);

    const blockW = layout.cols * cellW + (layout.cols - 1) * PAD;
    const blockH = layout.rows * cellH + (layout.rows - 1) * PAD;
    const originX = Math.max(PAD, Math.floor((vw - blockW) / 2));
    const originY = TOP_INSET + Math.max(PAD, Math.floor((vh - TOP_INSET - blockH) / 2));

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
      const x = originX + col * (cellW + PAD);
      const y = originY + row * (cellH + PAD);
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

  // "Starting soon" scene: music tall on the left, the guest card as the
  // big hero in the center, chat down the right edge, and the countdown
  // clock tucked into the lower-right. Then start a 10-minute countdown so
  // everyone sees the same timer tick down. Wall-clock-anchored via endAt
  // so peers stay in lockstep without per-tick sync.
  const meshSetClockStateForArrange = mesh.setClockState;
  const meshOpenWindowForArrange = mesh.openWindow;
  const arrangeForCountdown = useCallback(() => {
    if (typeof window === "undefined") return;
    const { width: vw, height: vh } = meshGodViewportRef.current ?? { width: 1920, height: 1080 };

    meshOpenWindowForArrange("music");
    meshOpenWindowForArrange("card");
    meshOpenWindowForArrange("chat");
    meshOpenWindowForArrange("clock");

    // Hand-tuned proportional layout, expressed as viewport fractions so
    // it holds its shape on any OBS canvas size. The slight overlaps
    // (clock over the card's + chat's corners) are intentional — see the
    // View ▸ Arrange for Countdown reference. Pushed in back-to-front
    // order: card under everything, clock on top.
    let z = Math.max(0, ...Object.values(meshSlotsRefForArrange.current).map(s => s.z), 5) + 1;
    const place = (id: string, fx: number, fy: number, fw: number, fh: number) =>
      meshUpdateSlotForArrange({
        id,
        x: Math.round(fx * vw),
        y: Math.round(fy * vh),
        width: Math.round(fw * vw),
        height: Math.round(fh * vh),
        z: z++,
      });

    place("app-card", 0.236, 0.123, 0.478, 0.61); // big hero, center
    place("app-music", 0.006, 0.368, 0.236, 0.5); // tall, left edge
    place("app-chat", 0.8, 0.14, 0.198, 0.45); // right edge
    place("app-clock", 0.637, 0.565, 0.336, 0.362); // lower-right, on top

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

  // "Auto Arrange" — tidy every open window into a fresh layout. Each
  // invocation advances through a ring of distinct strategies, so the
  // host can keep clicking it until a layout looks right. Re-snaps the
  // desktop icons every time too, just for fun. Operates on the god-mode
  // frame so the arrangement broadcasts identically to every peer.
  const autoArrangeCycleRef = useRef(0);
  const autoArrange = useCallback(() => {
    if (typeof window === "undefined") return;
    autoArrangeIcons();

    const { width: vw, height: vh } = meshGodViewportRef.current ?? { width: 1920, height: 1080 };
    const TOP_INSET = 38;
    const PAD = 14;

    // Every open window that has a live slot — apps + publications +
    // browsers — newest-focused first (highest z), so the window the host
    // last raised becomes the "master" in layouts that have one.
    const slots = meshSlotsRefForArrange.current;
    const ids: string[] = [];
    for (const id of meshOpenWindowIdsRef.current) ids.push(`app-${id}`);
    for (const pub of meshPublications) ids.push(slotIdFor(pub));
    for (const b of Object.values(meshBrowsersRefForArrange.current)) ids.push(`browser-${b.id}`);
    const open = ids.filter(id => slots[id]).sort((a, b) => (slots[b]!.z ?? 0) - (slots[a]!.z ?? 0));
    if (open.length === 0) return;

    const n = open.length;
    const areaX = PAD;
    const areaY = TOP_INSET + PAD;
    const areaW = vw - PAD * 2;
    const areaH = vh - TOP_INSET - PAD * 2;

    const appKindById: Record<string, string | undefined> = {};
    for (const a of appsRefForArrange.current) appKindById[a.id] = a.kind ?? "browser";

    let z = Math.max(0, ...Object.values(slots).map(s => s.z), 5) + 1;
    // Clamp each window to its sensible max, then center the (possibly
    // smaller) window inside the cell the strategy allotted it — so a layout
    // that hands a window the whole stage still renders it at a usable size
    // instead of full-screen. Screen shares have no max and fill their cell.
    const set = (id: string, x: number, y: number, w: number, h: number) => {
      const max = maxSizeForSlot(id, appKindById);
      const fw = Math.min(w, max.w);
      const fh = Math.min(h, max.h);
      meshUpdateSlotForArrange({
        id,
        x: Math.round(x + (w - fw) / 2),
        y: Math.round(y + (h - fh) / 2),
        width: Math.max(180, Math.round(fw)),
        height: Math.max(120, Math.round(fh)),
        z: z++,
      });
    };

    const strategies = ["grid", "cascade", "master", "columns", "spotlight"] as const;
    const strategy = strategies[autoArrangeCycleRef.current % strategies.length]!;
    autoArrangeCycleRef.current += 1;

    if (strategy === "grid") {
      // Near-square grid filling the whole stage.
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cellW = (areaW - (cols - 1) * PAD) / cols;
      const cellH = (areaH - (rows - 1) * PAD) / rows;
      open.forEach((id, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        set(id, areaX + c * (cellW + PAD), areaY + r * (cellH + PAD), cellW, cellH);
      });
    } else if (strategy === "cascade") {
      // Classic diagonal cascade — uniform mid-size tiles stepping down
      // and right, shifting a column over each time they'd run off-screen.
      const w = Math.min(560, areaW * 0.55);
      const h = Math.min(420, areaH * 0.62);
      const step = 36;
      const perRun = Math.max(1, Math.floor((areaH - h) / step) + 1);
      open.forEach((id, i) => {
        const k = i % perRun;
        const run = Math.floor(i / perRun);
        const x = Math.min(areaX + k * step + run * step * 2, areaX + areaW - w);
        set(id, x, areaY + k * step, w, h);
      });
    } else if (strategy === "master") {
      // Focused window large on the left; the rest stack down a right rail.
      if (n === 1) {
        set(open[0]!, areaX, areaY, areaW, areaH);
      } else {
        const railW = Math.min(360, areaW * 0.3);
        const masterW = areaW - railW - PAD;
        set(open[0]!, areaX, areaY, masterW, areaH);
        const rest = open.slice(1);
        const rh = (areaH - (rest.length - 1) * PAD) / rest.length;
        rest.forEach((id, i) => set(id, areaX + masterW + PAD, areaY + i * (rh + PAD), railW, rh));
      }
    } else if (strategy === "columns") {
      // Equal vertical columns (3 once it gets crowded), stacked within.
      const cols = n > 6 ? 3 : 2;
      const colW = (areaW - (cols - 1) * PAD) / cols;
      const perCol = Math.ceil(n / cols);
      open.forEach((id, i) => {
        const c = Math.floor(i / perCol);
        const r = i % perCol;
        const count = Math.min(perCol, n - c * perCol);
        const ch = (areaH - (count - 1) * PAD) / count;
        set(id, areaX + c * (colW + PAD), areaY + r * (ch + PAD), colW, ch);
      });
    } else {
      // Spotlight — one big centered hero with the rest as a filmstrip
      // along the bottom.
      if (n === 1) {
        const w = areaW * 0.6;
        const h = areaH * 0.7;
        set(open[0]!, areaX + (areaW - w) / 2, areaY + (areaH - h) / 2, w, h);
      } else {
        const stripH = Math.min(200, areaH * 0.26);
        const heroH = areaH - stripH - PAD;
        const heroW = areaW * 0.66;
        set(open[0]!, areaX + (areaW - heroW) / 2, areaY, heroW, heroH);
        const rest = open.slice(1);
        const sw = (areaW - (rest.length - 1) * PAD) / rest.length;
        rest.forEach((id, i) => set(id, areaX + i * (sw + PAD), areaY + heroH + PAD, sw, stripH));
      }
    }
  }, [autoArrangeIcons, meshPublications, meshUpdateSlotForArrange]);

  const viewMenu = useMemo<Menu>(
    () => ({
      label: "View",
      items: [
        { label: "Minimize Window", shortcut: "⌃⇧M", onClick: () => minimizeTopWindowRef.current() },
        { label: "Close Window", shortcut: "⌃⇧W", onClick: () => closeTopWindowRef.current() },
        { divider: true, label: "" },
        { label: "Auto Arrange", shortcut: "⌃⇧A", onClick: autoArrange },
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
    [autoArrange, autoArrangeIcons, arrangeForScreenShare, arrangeForVideo, arrangeForCountdown],
  );

  // ---- Slot clamp on viewport resize ------------------------------------
  // When the viewport shrinks (manual resize, View → 1920×1080, browser
  // zoom, etc.) any open windows that were positioned for a larger viewport
  // would otherwise be parked off-screen. Pull them back inside the visible
  // area, shrinking width/height first if they no longer fit.
  //
  // Also runs once on `mesh.bootstrapped` so a peer joining with a smaller
  // viewport than whoever sized the slot (typical: an Austin-Mac slot from
  // 1920+ being received by a 1494 Windows laptop) gets clamped at load
  // time. Without this the window would start out-of-bounds and react-rnd's
  // `bounds="parent"` would pin state.x/y to the bound on the first drag
  // step — the window then only moves a fraction of cursor travel and the
  // Y axis can even drift the wrong direction as slack accumulates.
  // DANGER: clamp() broadcasts through meshUpdateSlot, so a clamp against
  // a bogus viewport rewrites every peer's layout permanently (clamp only
  // ever shrinks; nothing grows windows back). A CDP screenshot (Claude /
  // OpenClaw automation uses Emulation.setDeviceMetricsOverride) fires a
  // synchronous `resize` at the override size and a second one at the
  // restored size moments later. Clamping the first event used to compute
  // height = vh - MENUBAR against a tiny transient vh — at ≤36px that IS
  // the cross-peer "minimized" flag (see Window.tsx dock threshold), so
  // one screenshot docked every window in the room. Three guards below:
  // debounce (transient blips coalesce into one no-op clamp against the
  // restored size), a viewport sanity floor (no human runs the desktop
  // this small; emulation artifacts get ignored outright), and a height
  // floor (whatever clamp emits can never cross the dock threshold).
  const meshUpdateSlot = mesh.updateSlot;
  const slotsRef = useRef(mesh.slots);
  slotsRef.current = mesh.slots;
  const meshBootstrapped = mesh.bootstrapped;
  useEffect(() => {
    const MENUBAR = 38;
    // Smallest viewport a real spectator plausibly has (half-screen
    // laptop window). Anything under this is an automation/emulation
    // artifact — skip the clamp and wait for a sane size.
    const MIN_VIEWPORT_W = 500;
    const MIN_VIEWPORT_H = 350;
    // Clamp may shrink a window but must stay well above the 36px dock
    // threshold — "minimize" is a deliberate user action and the clamp
    // must never be able to express it.
    const MIN_CLAMP_H = 100;
    const clamp = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw < MIN_VIEWPORT_W || vh < MIN_VIEWPORT_H) return;
      Object.values(slotsRef.current).forEach(slot => {
        let { x, y, width, height } = slot;
        if (width > vw) width = vw;
        if (height > vh - MENUBAR) height = Math.max(MIN_CLAMP_H, vh - MENUBAR);
        if (x + width > vw) x = vw - width;
        if (y + height > vh) y = vh - height;
        if (x < 0) x = 0;
        if (y < MENUBAR) y = MENUBAR;
        if (x !== slot.x || y !== slot.y || width !== slot.width || height !== slot.height) {
          meshUpdateSlot({ id: slot.id, x, y, width, height });
        }
      });
    };
    // Trailing debounce, viewport read at fire time: a screenshot's
    // shrink→restore pair settles before the timer fires, so the clamp
    // runs once against the *restored* size and changes nothing. A real
    // user resize just clamps 250ms after the drag stops.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduled = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(clamp, 250);
    };
    if (meshBootstrapped) clamp();
    window.addEventListener("resize", scheduled);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", scheduled);
    };
  }, [meshUpdateSlot, meshBootstrapped]);

  // Spectator (god-mode / OBS capture) broadcasts its own window inner
  // size to the room so every other client can render a dashed rectangle
  // showing exactly where the live frame ends. Debounced so dragging a
  // window edge doesn't spam ~60 WS messages a second. Non-spectators
  // skip entirely; the relay would drop their message anyway.
  const meshSetGodViewport = mesh.setGodViewport;
  const meshConnectedForGodViewport = mesh.connected;
  useEffect(() => {
    if (!isGodMode) return;
    if (!meshConnectedForGodViewport) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      meshSetGodViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    const scheduled = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(send, 80);
    };
    send();
    window.addEventListener("resize", scheduled);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", scheduled);
    };
  }, [isGodMode, meshConnectedForGodViewport, meshSetGodViewport]);

  // Spectator (god-mode / OBS capture) logs the ACTUAL rendered rect of every
  // media window (`[data-slot-id^="owner-"]`, tagged by <Window slotId>) plus
  // this browser's viewport. The relay persists these as the recorded-frame
  // geometry the clipper crops 9:16 clips from — far better than recovering it
  // with CV. getBoundingClientRect is already viewport-relative and the whole
  // browser is captured uniformly, so a rect maps to the frame as x/vw, y/vh
  // with no calibration constant (this is the fix for the slot-coords mismatch).
  // Spectator-only (relay drops it otherwise); a steady-frame signature check
  // suppresses no-op emits, and a light interval catches drags/arranges that
  // don't fire a resize event. A handful of getBoundingClientRect + a string
  // compare per tick — cheap.
  const meshSendGodGeometry = mesh.sendGodGeometry;
  useEffect(() => {
    if (!isGodMode) return;
    if (!meshConnectedForGodViewport) return;
    let lastSig = "";
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw <= 0 || vh <= 0) return;
      const windows: { id: string; x: number; y: number; w: number; h: number; z: number }[] = [];
      document.querySelectorAll<HTMLElement>('[data-slot-id^="owner-"]').forEach(el => {
        const id = el.getAttribute("data-slot-id");
        if (!id) return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const z = Number.parseInt(window.getComputedStyle(el).zIndex, 10);
        windows.push({
          id,
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          z: Number.isFinite(z) ? z : 0,
        });
      });
      const sig =
        `${vw}x${vh}|` +
        windows
          .map(w => `${w.id}:${w.x},${w.y},${w.w},${w.h},${w.z}`)
          .sort()
          .join("|");
      if (sig === lastSig) return; // steady frame — nothing moved
      lastSig = sig;
      meshSendGodGeometry({ vw, vh, windows });
    };
    const scheduled = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(measure, 200);
    };
    measure();
    const interval = setInterval(measure, 1000);
    window.addEventListener("resize", scheduled);
    return () => {
      if (debounce) clearTimeout(debounce);
      clearInterval(interval);
      window.removeEventListener("resize", scheduled);
    };
  }, [isGodMode, meshConnectedForGodViewport, meshSendGodGeometry]);

  // Prewarm the RNNoise pipeline BEFORE the gesture, while the entry
  // gate is still up. On a cold UpgradeModal reload the first camera
  // grab otherwise blocks the video publish on a chunk import + ~150KB
  // WASM fetch (denoiseStream is awaited before the track publishes).
  // Doing it here overlaps that cost with the user reading the gate, so
  // startCamera below finds it cached and the video window pops in fast.
  // Gated on a pending camera/audio resume + denoise actually being on.
  useEffect(() => {
    if (!session.authenticated) return;
    if (session.spectator) return;
    if (!readDenoisePref()) return;
    const r = readResume(slug);
    if (!r.camera && !r.audio) return;
    void prewarmDenoise();
  }, [session, slug]);

  // Catch-all warm: the first user gesture warms the pipeline so NO share
  // path ever blocks its publish on the cold chunk import + ~150KB WASM
  // fetch. acquire() awaits denoiseStream before publishing the track for
  // BOTH camera AND audio (line ~161 in useLocalMedia), so a cold first
  // share — video OR audio, via the Share dialogs OR a saved-layout apply
  // OR the keyboard — is otherwise slow. A gesture always precedes any
  // share (the desktop isn't interactive until the entry gate is clicked),
  // so this single chokepoint covers every path, present and future. The
  // resume-gated effect above stays because it fires PRE-gesture (during
  // the entry-gate dwell) to give the reload-resume a head start.
  // Idempotent + denoise-pref-gated; spectators never publish, so skip the
  // fetch for them.
  useEffect(() => {
    if (!gestured) return;
    if (!session.authenticated) return;
    if (session.spectator) return;
    if (!readDenoisePref()) return;
    void prewarmDenoise();
  }, [gestured, session]);

  // Release the camera/mic the instant this tab starts going away (the
  // UpgradeModal autoreload, a manual refresh, tab close). THE big win for
  // reload latency: browsers do NOT synchronously hand the device back
  // when the old document is torn down, so the freshly-loaded tab's
  // getUserMedia hits NotReadableError and falls into the multi-second
  // resume backoff before the video reappears. Stopping the tracks here
  // frees the device immediately, so the reloaded tab grabs it on the
  // FIRST try. We call track.stop() directly (not stopStream) — stop()
  // does NOT fire the "ended" event, so the resume flag in localStorage is
  // left intact for the reloaded tab to read. dispose() kills the upstream
  // mic behind a denoise-wrapped stream. pagehide covers reload + close +
  // bfcache; it's the reliable "page is leaving" hook.
  useEffect(() => {
    const release = () => {
      for (const s of streamsRef.current) {
        try {
          s.dispose?.();
        } catch {
          /* best-effort */
        }
        for (const t of s.stream.getTracks()) {
          try {
            t.stop();
          } catch {
            /* already stopped */
          }
        }
      }
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, []);

  // FAST PATH — fire ONE immediate resume attempt the moment the mesh
  // connects, BEFORE the entry-gate gesture. Camera/mic permissions are
  // sticky in Chrome, so re-acquiring an already-granted device does NOT
  // require a fresh user gesture — this is what made reloads feel instant
  // before the gesture gate landed (85f132b). Restored as a SEPARATE,
  // strictly-additive attempt so the proven gesture-gated ladder below is
  // left 100% intact:
  //   • single shot, NO backoff ladder
  //   • NEVER clears the resume flag (the ladder below owns give-up, so a
  //     pre-gesture failure can't lose the camera before the user clicks)
  //   • duplicate-publish-safe via useLocalMedia's inFlightRef guard — the
  //     ladder's first attempt no-ops if this one is still in flight
  //     (this is the bug that pulled the old Resume button, 63efeff)
  // If the device is still locked by the unloading tab, or a browser truly
  // demands a gesture for capture, this attempt simply fails silently and
  // the gesture-gated ladder handles it EXACTLY as today. Worst case =
  // today's behaviour; best case = video back before the user clicks Enter.
  useEffect(() => {
    if (!session.authenticated || !mesh.connected) return;
    if (session.spectator) return;
    const r = readResume(slug);
    if (r.camera) void mediaRefForLayouts.current.startCamera();
    if (r.audio) void mediaRefForLayouts.current.startAudio();
    // No gestured dep — this MUST run pre-gesture. start* are idempotent
    // (acquire no-ops when the kind is active or mid-acquire), so a
    // reconnect re-fire is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.authenticated, mesh.connected, slug]);

  // Audio + camera auto-resume on reload — mic/cam permissions are
  // sticky in Chrome so this won't prompt. Publications that were
  // live before the reload silently re-attach. Screen share is
  // resumable too, but via the click-to-resume placeholder below
  // (getDisplayMedia requires a fresh user gesture, so we can't
  // restart silently). This is the SAFETY-NET ladder; the fast-path
  // single attempt above usually beats it to the punch.
  useEffect(() => {
    if (!session.authenticated || !mesh.connected) return;
    // Wait for the entry-gate click before touching media. Acquiring
    // before the user gesture isn't strictly required by spec for
    // already-granted permissions, but Chrome's been observed to fail
    // the camera grab transiently when the previous tab (our auto-
    // reload precursor) hasn't fully released the device yet. Adding
    // gestured to the deps lets the user's natural click on the entry
    // gate buy that release window for free.
    if (!gestured) return;
    // Spectators (god-mode streaming sessions) never publish — the
    // relay would reject the publish frame anyway, but skip the
    // mic/cam acquisition entirely so the streaming box doesn't
    // flash a permission prompt.
    if (session.spectator) return;
    const r = readResume(slug);

    // Retry with backoff before giving up. Chrome can hold a lock on the
    // camera for a few seconds after the previous tab unloads (autoreload
    // from UpgradeModal), so getUserMedia rejects with a transient
    // NotReadableError. A single retry wasn't enough margin — the camera
    // window would silently vanish while the mic (which re-acquires
    // faster) survived. Spread retries across ~10s of device-release
    // window and only clear the resume flag once they're all exhausted,
    // so a genuinely revoked permission still stops looping eventually.
    //
    // start* now returns success/failure (acquire swallows the error for
    // display but reports the boolean), so this retry loop is actually
    // live — previously start* always resolved and the .catch never ran.
    // Calls route through the live media ref so a retry that fires after
    // the user manually started the device sees activeIds and no-ops.
    // Tight early poll so we grab the camera the instant the OS frees it
    // (after pagehide's track.stop the release still takes a beat). Wide
    // gaps used to waste up to ~2s of dead air sitting between retries
    // after the device was already free; this catches it fast, then backs
    // off to still span ~7s before giving up on a genuinely stuck device.
    const RESUME_RETRY_MS = [250, 400, 600, 900, 1300, 1800, 2500];
    let cancelled = false;
    const timers = new Set<number>();

    const tryWithRetry = (kind: "audio" | "camera", start: (m: UseLocalMedia) => Promise<boolean>) => {
      let attempt = 0;
      const go = () => {
        if (cancelled) return;
        void start(mediaRefForLayouts.current).then(ok => {
          if (ok || cancelled) return;
          if (attempt >= RESUME_RETRY_MS.length) {
            // All retries exhausted — drop the resume flag so we stop
            // trying (a genuinely revoked permission shouldn't loop) and
            // the "reconnecting" placeholder hides itself rather than
            // hanging forever. With the pagehide device-release this path
            // is rarely hit; the first attempt normally just succeeds.
            const cur = readResume(slug);
            delete cur[kind];
            writeResume(slug, cur);
            return;
          }
          const delay = RESUME_RETRY_MS[attempt++]!;
          const t = window.setTimeout(() => {
            timers.delete(t);
            go();
          }, delay);
          timers.add(t);
        });
      };
      go();
    };

    if (r.audio) tryWithRetry("audio", m => m.startAudio());
    if (r.camera) tryWithRetry("camera", m => m.startCamera());
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
    // Fire when auth + WS + gesture are all up. media is read via the live
    // ref and startAudio/startCamera are idempotent (acquire() bails when
    // activeIds[kind] is set), so a reconnect re-fire is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.authenticated, mesh.connected, gestured]);

  // ---- Manual screen share resumption ------------------------------------
  // Route through media.startScreen (the same path the Share menu uses) so
  // activeIds in useLocalMedia gets populated. Calling getDisplayMedia
  // directly bypassed that, leaving media.activeScreen=false even while
  // the share was live — the menu then offered a second "Screen" instead
  // of "Stop screen".
  const startScreenShare = useCallback(async () => {
    // getDisplayMedia rejecting (user cancelled the picker) now surfaces
    // as a false return rather than a throw — drop the resume flag so the
    // next reload doesn't re-offer a placeholder for a share they bailed on.
    const ok = await media.startScreen();
    if (!ok) {
      const cur = readResume(slug);
      delete cur.screen;
      writeResume(slug, cur);
    }
  }, [media, slug]);

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
  }, [hasOwnScreenPub, slug]);

  const screenResumeSlotId = myOwnerKey ? `owner-${myOwnerKey}-screen` : null;
  const screenResumeSlot =
    screenResumeSlotId && mesh.slots[screenResumeSlotId]
      ? mesh.slots[screenResumeSlotId]
      : { id: screenResumeSlotId ?? "screen-resume", x: 80, y: 280, width: DEFAULT_W, height: DEFAULT_H, z: 4 };

  // Camera reconnect placeholder (post-reload). Unlike screen, camera
  // re-acquires automatically — this just gives the user a visible window
  // ("reconnecting video…" + progress bar) so the video tile doesn't blink
  // out and reappear silently, and a manual Resume button if the auto
  // retries gave up.
  const hasOwnCameraPub = mesh.publications.some(p => p.peerId === mesh.myId && p.kind === "camera");
  useEffect(() => {
    setWantCameraResume(Boolean(readResume(slug).camera) && !hasOwnCameraPub && !media.activeCamera);
  }, [hasOwnCameraPub, media.activeCamera, slug]);

  const cameraResumeSlotId = myOwnerKey ? `owner-${myOwnerKey}-camera` : null;
  const cameraResumeSlot =
    cameraResumeSlotId && mesh.slots[cameraResumeSlotId]
      ? mesh.slots[cameraResumeSlotId]
      : { id: cameraResumeSlotId ?? "camera-resume", x: 80, y: 80, width: DEFAULT_W, height: DEFAULT_H, z: 4 };

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
      //
      // Screens use stopById so that closing one screen window only stops
      // that specific share — the user's other concurrent screens stay live.
      const tracked =
        (pub.kind === "audio" && media.activeAudio) ||
        (pub.kind === "camera" && media.activeCamera) ||
        (pub.kind === "screen" && media.hasScreen(pub.streamId));
      if (tracked) {
        if (pub.kind === "screen") media.stopById(pub.streamId);
        else media.stop(pub.kind);
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
    [mesh, streams, stopStream, media, setWantScreenResume, slug],
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
  // Tracks whether the PREVIOUS render was fully bootstrapped. We only run
  // the teardown diff while bootstrapped stays continuously true — never
  // across a reconnect boundary (see below); this is what lets a share
  // survive a deploy's relay restart.
  const wasBootstrappedRef = useRef(false);
  useEffect(() => {
    if (!mesh.connected || !mesh.bootstrapped || !mesh.myId) {
      // Connection lost (or never up). Remember we're un-bootstrapped so the
      // next bootstrap re-seeds instead of diffing across the gap.
      wasBootstrappedRef.current = false;
      return;
    }
    const myPubStreamIds = new Set(mesh.publications.filter(p => p.peerId === mesh.myId).map(p => p.streamId));

    // FIRST render after a (re)connect. The relay's fresh `hello` snapshot
    // does NOT include our own publications: the relay doesn't persist them
    // across a restart, and our re-announce (usePeerMesh ws.onopen) hasn't
    // round-tripped back as a `published` yet. Diffing the pre-disconnect
    // set against this momentarily-empty snapshot looks exactly like
    // "someone closed my window" — so the teardown below would stop our own
    // camera/mic AND wipe the resume flag, milliseconds before the
    // UpgradeModal reloads the page. The reload then finds no resume flag and
    // the share never comes back. This was THE reason video/audio didn't
    // survive a deploy. Re-seed from the snapshot and skip teardown on this
    // cycle; a genuine window-close arrives as an `unpublished` while we stay
    // bootstrapped, which the normal path below still handles.
    if (!wasBootstrappedRef.current) {
      wasBootstrappedRef.current = true;
      prevMyPubIdsRef.current = myPubStreamIds;
      return;
    }

    for (const id of prevMyPubIdsRef.current) {
      if (myPubStreamIds.has(id)) continue;
      const s = streamsRef.current.find(x => x.id === id);
      if (!s) continue;
      const tracked =
        (s.kind === "audio" && media.activeAudio) ||
        (s.kind === "camera" && media.activeCamera) ||
        (s.kind === "screen" && media.hasScreen(s.id));
      if (tracked) {
        if (s.kind === "screen") media.stopById(s.id);
        else media.stop(s.kind);
      } else stopStream(s.id);
      const r = readResume(slug);
      delete r[s.kind];
      writeResume(slug, r);
      clearKindPersistedState(slug, s.kind);
    }
    prevMyPubIdsRef.current = myPubStreamIds;
  }, [mesh.publications, mesh.connected, mesh.bootstrapped, mesh.myId, media, stopStream, slug]);

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
      anonId: string | null;
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
        anonId: peer?.anonId ?? pos.anonId ?? null,
      });
    });
    return result;
  }, [mesh.cursors, mesh.myId, mesh.peers]);

  const myBands = useMemo(
    () =>
      bandsFromIdentity({
        address: session.authenticated ? session.address : null,
        anonId: session.authenticated ? session.anonId : null,
        handle: session.authenticated ? session.handle : null,
        fallback: mesh.myId,
      }),
    [session, mesh.myId],
  );

  const localCursor = useLocalCursor();

  // Hint auto-dismiss after the configured timeout. Only starts ticking
  // once the user is past every gate (auth + room password + gesture)
  // AND the desktop has bootstrapped — i.e. once the hint is actually
  // visible. Mounting the timer at component-mount would burn most of
  // the 15s while the user is still clicking through Connect Wallet /
  // EntryGate.
  const hintVisible = hintActive && session.authenticated && mesh.bootstrapped && gestured;
  useEffect(() => {
    if (!hintVisible) return;
    const t = window.setTimeout(dismissHint, HINT_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [hintVisible, dismissHint]);

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
      // further. The y is computed against THIS viewer's viewport — the
      // docked slot y was set on whoever's screen minimized it and is
      // meaningless (often off-screen) for a viewer of a different
      // screen height.
      if (cur && cur.height <= 40) {
        const h = 400;
        patch.height = h;
        patch.width = Math.max(cur.width, 360);
        patch.y = Math.max(60, window.innerHeight - h - 80);
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

  // Single source of truth for "what happens when you activate an app" —
  // shared between the icon double-click handler and the command palette
  // (Ctrl+Shift+Space). Any new app kind only needs to be wired here.
  const activateApp = useCallback(
    (app: AppEntry) => {
      switch (app.kind) {
        case "chat":
        case "music":
        case "chess":
        case "poker":
        case "pong":
        case "worm":
        case "qr":
        case "todo":
        case "notes":
        case "glossary":
        case "gas":
        case "clock":
        case "wallet":
        case "ens":
        case "research":
        case "leftclaw":
        case "news":
        case "transcript":
        case "card":
          focusApp(app.id);
          return;
        case "mywallet":
          // Single-player: open the local (private) window, not a shared mesh
          // window. Geometry + open-state persist to localStorage only.
          dismissHint();
          local.openWindow("mywallet");
          return;
        case "audio":
          dismissHint();
          if (media.activeAudio) focusPub("audio");
          else setAudioDialog("create");
          return;
        case "video":
          dismissHint();
          if (media.activeCamera) focusPub("camera");
          else setVideoDialog("create");
          return;
        case "screen":
          dismissHint();
          // Resume placeholder wins when present (no live screen yet) so a
          // returning user can recover their prior share.
          if (wantScreenResume && !media.activeScreen) {
            focusPub("screen");
            return;
          }
          // Focus-then-new: if there's already at least one screen share
          // going and the most recent one isn't currently frontmost, the
          // first double-click pulls it forward (matching the normal
          // "double-click an app to surface it" behavior). Only once it's
          // already on top does the next double-click open a second picker.
          if (media.activeScreen && media.lastScreenId) {
            const lastPub = mesh.publications.find(
              p => p.peerId === mesh.myId && p.kind === "screen" && p.streamId === media.lastScreenId,
            );
            if (lastPub) {
              const slotId = slotIdFor(lastPub);
              const slot = mesh.slots[slotId];
              const maxZ = Math.max(0, ...Object.values(mesh.slots).map(s => s.z));
              if (slot && slot.z < maxZ) {
                focusSlot(slotId);
                return;
              }
            }
          }
          void media.startScreen();
          return;
        default:
          if (app.url) spawnBrowser(app.url, app.id);
      }
    },
    [
      focusApp,
      focusPub,
      focusSlot,
      dismissHint,
      media,
      mesh.publications,
      mesh.myId,
      mesh.slots,
      wantScreenResume,
      setAudioDialog,
      setVideoDialog,
      spawnBrowser,
    ],
  );

  // Flatten apps + every actionable menu item into the launcher's action
  // list. Disabled / divider menu items are filtered so they can't be
  // selected. App actions are listed first so a one-word query like
  // "music" lands on the app before any menu item that mentions it.
  const paletteActions = useMemo<CommandAction[]>(() => {
    const appActions: CommandAction[] = apps.map(app => ({
      id: `app:${app.id}`,
      label: app.label,
      group: "App",
      icon: app.icon,
      keywords: app.id,
      run: () => activateApp(app),
    }));
    const menuActions: CommandAction[] = [];
    for (const menu of [fileMenu, editMenu, viewMenu]) {
      for (const item of menu.items) {
        if (item.divider || item.disabled || !item.onClick) continue;
        menuActions.push({
          id: `menu:${menu.label}:${item.label}`,
          label: item.label,
          group: menu.label,
          run: item.onClick,
        });
      }
    }
    return [...appActions, ...menuActions];
  }, [apps, activateApp, fileMenu, editMenu, viewMenu]);

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
    if (wantCameraResume && cameraResumeSlotId) visible.add(cameraResumeSlotId);

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
    wantCameraResume,
    cameraResumeSlotId,
    meshUpdateSlotForVis,
  ]);

  // When a tx gets proposed from a SharedBrowser dapp, surface the
  // wallet window so the user lands directly on the signing UI instead
  // of having to hunt for it behind the browser. We key off the relay's
  // wallet_tx_attention ping — bumped on every propose attempt,
  // including the deduped second-click case where walletTxs itself
  // doesn't change — so a confused user who clicks swap twice still
  // gets the wallet pulled in front. WalletWindow's own effects handle
  // the tab switch and initial-mount default.
  const walletAttention = mesh.walletAttention;
  const lastWalletAttentionRef = useRef(walletAttention?.at ?? 0);
  useEffect(() => {
    const at = walletAttention?.at ?? 0;
    if (at > lastWalletAttentionRef.current && walletAttention?.source === "browser") {
      focusApp("wallet");
    }
    lastWalletAttentionRef.current = at;
  }, [walletAttention, focusApp]);

  // Top-right menubar balance. When the multisig is actually deployed
  // on-chain (≥1 entry in wallet.deployments), pull its total USD value
  // from the relay's Zerion proxy so the chip can show it just left of
  // the address. WalletWindow keeps the authoritative, polling copy;
  // this is a lightweight standalone fetch so the number shows even
  // with the wallet window closed. Fetch on mount + whenever the tab
  // regains visibility — cheap on the Zerion quota, mirrors WalletWindow.
  // A plain (counterfactual, undeployed) wallet has nothing to show, so
  // we skip the fetch and clear the number entirely.
  const menubarWalletAddr = mesh.wallet?.address ?? null;
  const menubarWalletDeployed = !!mesh.wallet && Object.keys(mesh.wallet.deployments).length > 0;
  const [menubarWalletBalanceUsd, setMenubarWalletBalanceUsd] = useState<string | null>(null);
  useEffect(() => {
    if (!menubarWalletAddr || !menubarWalletDeployed) {
      setMenubarWalletBalanceUsd(null);
      return;
    }
    let cancelled = false;
    const fetchBalance = async () => {
      try {
        const res = await fetch(withSlug(`${RELAY_HTTP}/v1/wallet/portfolio?address=${menubarWalletAddr}`, slug), {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const p = (await res.json()) as { totalBalanceUsd?: string };
        if (!cancelled) setMenubarWalletBalanceUsd(p.totalBalanceUsd ?? null);
      } catch {
        /* network blip — keep the last known number */
      }
    };
    void fetchBalance();
    const onVis = () => {
      if (document.visibilityState === "visible") void fetchBalance();
    };
    document.addEventListener("visibilitychange", onVis);
    // When a tip card lands on the vault, re-pull immediately (catches
    // already-indexed / fast chains) then at 5s and 15s to cover Zerion's
    // indexer lag, so the chip ticks up to the new total.
    const tipTimers = new Set<ReturnType<typeof setTimeout>>();
    const onTipLanded = () => {
      for (const delayMs of [0, 5_000, 15_000]) {
        const handle = setTimeout(() => {
          tipTimers.delete(handle);
          void fetchBalance();
        }, delayMs);
        tipTimers.add(handle);
      }
    };
    window.addEventListener("slop-tip-landed", onTipLanded);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("slop-tip-landed", onTipLanded);
      for (const t of tipTimers) clearTimeout(t);
    };
  }, [menubarWalletAddr, menubarWalletDeployed, slug]);

  // Find the slot id of the currently-topmost visible window — what
  // a "close top window" / "minimize top window" action should target.
  // Iterating mesh.publications + openWindowIds + browsers covers every
  // window type that has a titlebar; icons, files, and bars are fixed
  // chrome and not part of the close/minimize surface. Returns null
  // when nothing is open.
  const topVisibleSlotId = useCallback((): string | null => {
    const visibleSlotIds: string[] = [];
    for (const pub of mesh.publications) visibleSlotIds.push(slotIdFor(pub));
    for (const id of mesh.openWindowIds) visibleSlotIds.push(`app-${id}`);
    for (const browser of Object.values(mesh.browsers)) visibleSlotIds.push(`browser-${browser.id}`);
    if (visibleSlotIds.length === 0) return null;

    let topId: string | null = null;
    let topZ = -Infinity;
    for (const sid of visibleSlotIds) {
      const z = mesh.slots[sid]?.z ?? 0;
      if (z > topZ) {
        topZ = z;
        topId = sid;
      }
    }
    return topId;
  }, [mesh.publications, mesh.openWindowIds, mesh.browsers, mesh.slots]);

  // Close whatever window is currently on top, routing by slot-id
  // prefix to the matching close action. Driven by both the keyboard
  // shortcut and the View → Close Window menu item.
  const closeTopWindow = useCallback(() => {
    const topId = topVisibleSlotId();
    if (!topId) return;
    if (topId.startsWith("app-")) {
      mesh.closeWindow(topId.slice("app-".length));
      return;
    }
    if (topId.startsWith("browser-")) {
      mesh.closeBrowser(topId.slice("browser-".length));
      return;
    }
    if (topId.startsWith("owner-")) {
      const pub = mesh.publications.find(p => slotIdFor(p) === topId);
      if (pub) closeWindow(pub);
    }
  }, [topVisibleSlotId, mesh.closeWindow, mesh.closeBrowser, mesh.publications, closeWindow]);

  // Collapse the top window to the docked titlebar pill by setting its
  // slot to width 200, height 36. Each peer's local <Window> already
  // treats height<=36 as "docked" and recomputes y against its own
  // viewport (see dockedY in Window.tsx), so the dock state flows
  // through the existing slot broadcast — no separate "minimized"
  // flag. The local savedRect path inside Window.tsx doesn't get to
  // capture pre-minimize geometry (we're outside the component), so
  // restoring takes the same fallback path that runs after a reload
  // — known + acceptable.
  const minimizeTopWindow = useCallback(() => {
    const topId = topVisibleSlotId();
    if (!topId) return;
    const slot = mesh.slots[topId];
    if (!slot) return;
    mesh.updateSlot({ id: topId, x: slot.x, y: slot.y, width: 200, height: 36 });
  }, [topVisibleSlotId, mesh.slots, mesh.updateSlot]);

  // Publish the live callbacks into the refs the View menu reads. The
  // refs are declared near the top of the component (alongside the
  // viewMenu definition); see the comment there for why we route
  // through refs instead of referencing the callbacks directly.
  useEffect(() => {
    closeTopWindowRef.current = closeTopWindow;
    minimizeTopWindowRef.current = minimizeTopWindow;
  }, [closeTopWindow, minimizeTopWindow]);

  // Global window keyboard shortcuts. Ctrl+Shift+* only — deliberately NOT
  // Cmd+Shift+*, which collides with browser/OS bindings on Mac (⌘⇧W closes
  // the whole window and can't be prevented, ⌘⇧A is Chrome's tab search).
  // W and Q alias as close; M minimizes; A auto-arranges. Skipped while
  // focus is in an input so the user can still type Shift-letters in a
  // textarea.
  useEffect(() => {
    const isEditable = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      // Ctrl+Shift+1..9 → load saved layout N (newest-first, same order as
      // File ▸ Load Layout ▸). Match via e.code so a layout that turns
      // Shift+1 into "!" (US) or "+" (DE) still triggers — e.key would be
      // the shifted glyph, e.code stays Digit1.
      const digit = e.code.match(/^Digit([1-9])$/);
      if (digit) {
        if (isEditable(e.target)) return;
        const name = layoutNames[Number(digit[1]) - 1];
        if (!name) return;
        e.preventDefault();
        loadLayout(name);
        return;
      }
      const key = e.key.toLowerCase();
      const isClose = key === "w" || key === "q";
      const isMinimize = key === "m";
      const isArrange = key === "a";
      const isSave = key === "s";
      const isUpload = key === "u";
      if (!isClose && !isMinimize && !isArrange && !isSave && !isUpload) return;
      if (isEditable(e.target)) return;
      e.preventDefault();
      if (isMinimize) minimizeTopWindow();
      else if (isArrange) autoArrange();
      else if (isSave) setSaveLayoutOpen(true);
      else if (isUpload) uploadInputRef.current?.click();
      else closeTopWindow();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeTopWindow, minimizeTopWindow, autoArrange, loadLayout, layoutNames]);

  // Spacebar = mute / unmute my own mic. A quick "mute me" that doesn't
  // require hunting for the button on the camera/audio window. We only
  // hijack the key while the user is actually sharing a mic (camera or
  // audio publication) and focus isn't somewhere that needs the space —
  // text fields, buttons, links — so we don't break typing or
  // button-activation. The VideoView / AudioVisualizer that owns the mic
  // listens for `slop-toggle-mic` and flips its own state.
  const sharingMic = media.activeCamera || media.activeAudio;
  useEffect(() => {
    if (!sharingMic) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        if (t.isContentEditable) return;
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
        if (t.getAttribute("role") === "button") return;
      }
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("slop-toggle-mic"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sharingMic]);

  // Spacebar in god-mode = toggle the green room (standby ⇄ live). The
  // streaming box never publishes a mic, so the mute binding above is
  // inert here and this is the only thing that owns Space. Skipped while
  // a text field / button has focus so the operator can still type.
  useEffect(() => {
    if (!isGodMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement) {
        if (t.isContentEditable) return;
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
        if (t.getAttribute("role") === "button") return;
      }
      e.preventDefault();
      toggleGreenRoom();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isGodMode, toggleGreenRoom]);

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
          xhr.open(
            "POST",
            `${RELAY_HTTP}/v1/files?name=${encodeURIComponent(file.name)}&slug=${encodeURIComponent(slug)}`,
          );
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
    [mesh.slots, meshUpdateSlotForFiles, slug],
  );

  return (
    <PasskeyWalletProvider passkeyAddresses={passkeyAddressesForResolve}>
      <DesktopBackground />
      <IncomingTxModal incomingForwards={mesh.incomingForwards} dismissIncomingForward={mesh.dismissIncomingForward} />
      <MenuBar
        menus={[fileMenu, editMenu, viewMenu]}
        meshConnected={mesh.connected}
        airState={mesh.airState}
        godActive={isGodMode}
        godListening={isGodMode && godStt.listening}
        localSttSupported={!isGodMode && liveStt.supported}
        localSttListening={liveStt.listening}
        localSttError={liveStt.lastError}
        localSttResultTick={liveStt.resultTick}
        localSttDisabled={localSttUserDisabled}
        onLocalSttToggle={toggleLocalStt}
        walletAddress={mesh.wallet?.address ?? null}
        walletBalanceUsd={menubarWalletBalanceUsd}
        onWalletClick={session.authenticated ? () => focusApp("wallet") : undefined}
        // God-mode only: pop the audio mixer + EQ in a separate OS
        // window. Kept off-tab on purpose so the controls themselves
        // don't get captured into the broadcast.
        onEqClick={
          isGodMode
            ? () => {
                const target = `/eq?slug=${encodeURIComponent(slug)}`;
                // Skinny + tall — sits cleanly on the side of a
                // monitor without blocking the broadcast view. 760
                // tall fits 6 EQ bands + master + a few sources +
                // the stream monitor at the bottom without
                // scrolling; source list scrolls if it grows past
                // that.
                const features = "popup=yes,width=150,height=760,menubar=no,toolbar=no,location=no,status=no";
                // `noopener` would null out the opener — we need the
                // reference for the popup to find the right
                // BroadcastChannel name. Channels are scoped by the
                // shared constant in audioBus.ts, so opener-less is
                // fine in practice, but keeping the reference is
                // cheap and lets us focus() it on re-click.
                window.open(target, "slop-eq", features);
              }
            : null
        }
        slug={slug}
      />
      {session.authenticated ? <CommandPalette actions={paletteActions} /> : null}
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
        {/* Livestream frame guide — dashed rectangle showing the inner
            size of the god-mode (OBS capture) window, broadcast by that
            spectator on resize so every peer sees the same bounds. Falls
            back to the 1920×1080 OBS target when no spectator is online.
            Inflated 3px on every side so the dashed lines sit just
            outside the spectator's own viewport — otherwise the top +
            left edges of the line would be visible on their screen and
            get streamed. Behind everything, never clickable. */}
        <div
          aria-hidden
          style={{
            position: "fixed",
            top: -3,
            left: -3,
            width: (mesh.godViewport?.width ?? 1920) + 6,
            height: (mesh.godViewport?.height ?? 1080) + 6,
            border: "2px dashed var(--slop-magenta, #ff3ec9)",
            boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.35) inset",
            boxSizing: "border-box",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
        {/* Desktop icons. Catalog comes from the relay's /apps endpoint
            (JSON file on the box, no rebuild needed). Position lives in
            the shared slots system keyed by `icon-${app.id}` so dragging
            syncs across peers and survives reloads. Gated on
            `bootstrapped` to avoid the position-flash on first paint. */}
        {session.authenticated && mesh.bootstrapped
          ? apps.map((app, i) => {
              // First-visit hint: only chat + the three share kinds are
              // visible. Everything else returns null so the layout is a
              // clean column of 4 with the arrow image pointing at them.
              const hidden = hintActive && !HINT_ALLOWED_KINDS.has(app.kind ?? "");
              if (hidden) return null;
              const slotId = `icon-${app.id}`;
              // Match autoArrangeIcons' unlisted-rank counting so a new
              // (non-grid) app's fallback slot is identical whether it
              // arrives via first paint or Auto Arrange.
              const unlistedRank = isCuratedIcon(app.id)
                ? 0
                : apps.slice(0, i).filter(a => !isCuratedIcon(a.id)).length;
              const fallback = defaultIconPosition(app.id, unlistedRank);
              const slot = mesh.slots[slotId] ?? {
                id: slotId,
                x: fallback.x,
                y: fallback.y,
                width: 88,
                height: 110,
                z: 1,
              };
              // After dismiss, the non-priority icons fade in with a
              // small per-icon stagger so it feels like the desktop is
              // unlocking, not popping. The priority 4 are already on-
              // screen and shouldn't re-animate, so they skip the class.
              const fadingIn = hintDismissedAt !== null && !HINT_ALLOWED_KINDS.has(app.kind ?? "");
              const fadeStyle = fadingIn
                ? {
                    animation: `slop-icon-fade-in 700ms ease-out both`,
                    animationDelay: `${Math.min(i * 80, 800)}ms`,
                  }
                : undefined;
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
                  style={fadeStyle}
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
                  onDoubleClick={() => activateApp(app)}
                />
              );
            })
          : null}

        {/* First-visit hint arrow. Pinned just to the right of the
            left-column icon stack and nudged horizontally so the eye
            catches it. Pointer-events:none so it doesn't shadow the
            icons it's pointing at. */}
        {session.authenticated && mesh.bootstrapped && hintActive ? (
          <img
            src="/hint.png"
            alt="double click Video, Audio, or Screen to share"
            draggable={false}
            className="slop-hint-arrow"
            style={{
              position: "absolute",
              left: 120,
              top: 100,
              width: 480,
              height: "auto",
              pointerEvents: "none",
              zIndex: 3,
              filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.55))",
            }}
          />
        ) : null}

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
              // Uploader can delete their own files; host can delete any;
              // godMode (spectator) ops can delete any. Mirrors the relay
              // check at /v1/files/:id DELETE — if we got this wrong the
              // relay 403s and DesktopFile snaps back, but it's worth
              // gating client-side so a doomed request never fires.
              const canDelete =
                !!myKey && (f.ownerKey === myKey || session.role === "host" || session.spectator === true);
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
                  onDragEnd={({ x, y, startX, startY }) => {
                    // Dropped on the trash → delete IF allowed. The
                    // file_removed broadcast clears the icon for every
                    // peer; the orphan slot is harmless. If the dragger
                    // isn't allowed (not owner, host, or godMode), snap
                    // the icon back to where the drag started rather
                    // than firing a DELETE the relay will just 403.
                    if (!isOverTrash(x, y)) return;
                    if (canDelete) {
                      mesh.deleteFile(f.id);
                    } else {
                      mesh.updateSlot({ id: slotId, x: startX, y: startY, width: 88, height: 110 });
                    }
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
            anonId: peer?.anonId ?? null,
            handle: peer?.handle ?? null,
            fallback: pub.ownerKey || pub.peerId,
          });
          // Tile badge label uses the same precedence as the guest list:
          // custom name > ENS handle > short address > short peer-id.
          // Fall back to the publication's ownerKey (which carries the
          // pre-disconnect identity) when the peer record itself is gone
          // — keeps the tile labelled correctly when a publisher drops
          // off and the publication lingers a beat before tearing down.
          const badgeLabel = peer
            ? resolvePeerLabel(peer, mesh.customNames)
            : (mesh.customNames[pub.ownerKey.toLowerCase()] ?? pub.label ?? pub.ownerKey.slice(0, 8));
          return (
            <Window
              key={`${pub.peerId}-${pub.streamId}`}
              title={titleFor(pub)}
              slotId={slotId}
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
              dockBottomInset={DOCKED_PILL_BOTTOM_INSET}
              dockUnderZ={BOTTOM_BAR_Z}
            >
              <div style={{ position: "relative", width: "100%", height: "100%" }}>
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
                        // God-mode only: route this peer's audio
                        // through the bus so the EQ popup can mix it.
                        // Self-published audio is locally muted to
                        // prevent feedback so we skip it.
                        audioBusId={isGodMode && pub.peerId !== mesh.myId ? `peer-${pub.streamId}` : null}
                        audioBusLabel={badgeLabel}
                      />
                    </AudioDropZone>
                  ) : pub.kind === "camera" ? (
                    <VideoView
                      stream={stream}
                      muted={pub.peerId === mesh.myId}
                      isMine={pub.peerId === mesh.myId}
                      onSettings={pub.peerId === mesh.myId ? () => setVideoDialog("edit") : undefined}
                      // Audio-only toggle. State is the relay-broadcast
                      // `cameraOff` flag so every viewer (and the
                      // spectator box) renders the avatar in lockstep;
                      // only the owner gets the toggle handler.
                      cameraOff={pub.cameraOff ?? false}
                      onToggleCameraOff={
                        pub.peerId === mesh.myId ? off => mesh.setCameraOff(pub.streamId, off) : undefined
                      }
                      // Avatar backdrop shown when in audio-only mode —
                      // resolved the same way the audio-share window does.
                      bands={pubBands}
                      avatarUrl={mesh.avatars[pub.ownerKey] ?? null}
                      address={peer?.address ?? null}
                      hidden={mesh.hiddenAvatars.has(pub.ownerKey)}
                      // Audio-only backdrop drop target — owner-key match
                      // (not peer-id) so a user with the wallet open in
                      // multiple tabs/devices can drag a new PFP onto any
                      // of their camera windows. Mirrors the audio window.
                      onAvatarFile={
                        !!myOwnerKey && pub.ownerKey === myOwnerKey
                          ? file => uploadAvatar(file).catch(err => console.warn("avatar upload failed", err))
                          : undefined
                      }
                      // God-mode only: camera publications bundle the
                      // publisher's mic on the same stream, so the
                      // video element is where that audio plays —
                      // route it through the EQ bus too.
                      audioBusId={isGodMode && pub.peerId !== mesh.myId ? `peer-${pub.streamId}` : null}
                      audioBusLabel={`${badgeLabel} · cam`}
                      // Camera kind: offer the publisher a local mirror
                      // toggle. Screen-share VideoView below skips this.
                      mirrorable
                    />
                  ) : (
                    <VideoView
                      stream={stream}
                      muted={pub.peerId === mesh.myId}
                      isMine={pub.peerId === mesh.myId}
                      // Screen shares can carry system audio (browser
                      // tab capture with audio=true). Same wiring.
                      audioBusId={isGodMode && pub.peerId !== mesh.myId ? `peer-${pub.streamId}` : null}
                      audioBusLabel={`${badgeLabel} · screen`}
                    />
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
                <TileBadge bands={pubBands} label={badgeLabel} />
                {/* Confirm screen-share audio is actually flowing. Only
                    shows when the publisher checked "Share tab audio" in
                    the browser picker; absence is itself a useful signal
                    ("oh, I forgot to tick the box"). */}
                {pub.kind === "screen" && stream && stream.getAudioTracks().length > 0 ? (
                  <div
                    title="sharing tab audio"
                    style={{
                      position: "absolute",
                      bottom: 8,
                      right: 8,
                      padding: "3px 8px",
                      background: "var(--slop-magenta, #ff3ec9)",
                      color: "#fff",
                      fontFamily: "var(--slop-font-display)",
                      fontSize: 10,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      pointerEvents: "none",
                      zIndex: 4,
                    }}
                  >
                    🔊 audio
                  </div>
                ) : null}
              </div>
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
          // label instead of echoing the current URL. This is driven by
          // the app catalog entry's `chrome: "app"` flag (so any app —
          // including third-party ones added via POST /v1/apps — can opt
          // in), with the legacy hardcoded LOCKED_APP_TITLES map kept as
          // a fallback for built-ins that predate the flag.
          const lockApp = browser.appId ? apps.find(a => a.id === browser.appId) : undefined;
          const lockedAppTitle =
            lockApp?.chrome === "app"
              ? lockApp.label.toUpperCase()
              : browser.appId
                ? LOCKED_APP_TITLES[browser.appId]
                : undefined;
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
              dockBottomInset={DOCKED_PILL_BOTTOM_INSET}
              dockUnderZ={BOTTOM_BAR_Z}
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
                customNames={mesh.customNames}
                walletTxs={mesh.walletTxs}
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
            dockBottomInset={DOCKED_PILL_BOTTOM_INSET}
            dockUnderZ={BOTTOM_BAR_Z}
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

        {/* Camera reconnect placeholder — sits in the camera slot after a
            reload so the video tile doesn't vanish while the device is
            re-acquired. The timed LoadingBar creeps toward ~95% over ~9s
            and holds; the whole window unmounts the moment the real
            own-camera pub arrives (activeCamera flips true). The Resume
            button is the manual fallback if auto-retries gave up. */}
        {wantCameraResume && cameraResumeSlotId ? (
          <Window
            title={`VIDEO — ${myLabel} (reconnecting…)`}
            x={cameraResumeSlot.x}
            y={cameraResumeSlot.y}
            width={cameraResumeSlot.width}
            height={cameraResumeSlot.height}
            zIndex={cameraResumeSlot.z}
            onClose={() => {
              const cur = readResume(slug);
              delete cur.camera;
              writeResume(slug, cur);
              setWantCameraResume(false);
            }}
            onMove={({ x, y }) => moveSlot(cameraResumeSlotId, x, y)}
            onResize={({ x, y, width, height }) => resizeSlot(cameraResumeSlotId, x, y, width, height)}
            bodyStyle={{ padding: 0, overflow: "hidden" }}
            containerInset={{ top: 38 }}
            dockBottomInset={DOCKED_PILL_BOTTOM_INSET}
            dockUnderZ={BOTTOM_BAR_Z}
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
                gap: 14,
                color: "var(--slop-text)",
                fontSize: 12,
                textAlign: "center",
                padding: 16,
              }}
            >
              <span style={{ color: "var(--slop-text-muted)" }}>reconnecting video…</span>
              <LoadingBar
                cells={12}
                estimateMs={4000}
                caption=""
                style={{ fontSize: 13, color: "var(--slop-cyan, #5bf0ff)" }}
              />
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
                customNames={mesh.customNames}
                mesh={mesh}
              />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="music"
              title="SLOPAMP"
              defaultSlot={{ x: 120, y: 120, width: 380, height: 440 }}
              minWidth={300}
              minHeight={300}
              // Keep the player mounted while minimized so its <audio>
              // element stays in the DOM and music keeps playing.
              keepMountedWhenDocked
              // Closing SLOPAMP stops playback (shared across the mesh), so
              // music doesn't keep going from a detached <audio> element
              // after the window unmounts. Minimize (above) still keeps it
              // playing — only the explicit close stops it.
              onClose={() => {
                const ms = mesh.musicState;
                if (ms?.playing) {
                  mesh.setMusicState({ ...ms, playing: false, position: 0, at: Date.now() });
                }
                mesh.closeWindow("music");
              }}
            >
              <MusicPlayerWindow mesh={mesh} audioBusEnabled={isGodMode} />
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
              id="poker"
              title="POKER"
              defaultSlot={{ x: 140, y: 70, width: 720, height: 600 }}
              minWidth={520}
              minHeight={460}
            >
              <PokerWindow mesh={mesh} myOwnerKey={myOwnerKey} myLabel={myLabel} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="pong"
              title="PONG"
              defaultSlot={{ x: 180, y: 100, width: 560, height: 420 }}
              minWidth={420}
              minHeight={320}
            >
              <PongWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="worm"
              title="WORM"
              defaultSlot={{ x: 200, y: 110, width: 600, height: 500 }}
              minWidth={420}
              minHeight={380}
            >
              <WormWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="qr"
              title="QR"
              defaultSlot={{ x: 200, y: 100, width: 360, height: 480 }}
              minWidth={280}
              minHeight={360}
            >
              <QrCodeWindow mesh={mesh} />
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
              title="BANK"
              defaultSlot={{ x: 400, y: 100, width: 640, height: 680 }}
              minWidth={420}
              minHeight={460}
            >
              <WalletWindow
                mesh={mesh}
                myAddress={session.address}
                myHandle={session.handle}
                onBalanceUsd={setMenubarWalletBalanceUsd}
              />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="ens"
              title="ENS"
              defaultSlot={{ x: 420, y: 120, width: 460, height: 560 }}
              minWidth={360}
              minHeight={420}
            >
              <EnsWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="research"
              title="RESEARCH"
              defaultSlot={{ x: 420, y: 120, width: 560, height: 620 }}
              minWidth={420}
              minHeight={420}
            >
              <ResearchWindow mesh={mesh} />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="leftclaw"
              title="HIRE"
              defaultSlot={{ x: 440, y: 130, width: 540, height: 640 }}
              minWidth={420}
              minHeight={460}
            >
              <LeftclawWindow mesh={mesh} />
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
              <TranscriptWindow
                relayHttpUrl={RELAY_HTTP}
                customNames={mesh.customNames}
                mesh={mesh}
                captionsOn={episode.captionsOn}
              />
            </SharedAppWindow>
            <SharedAppWindow
              mesh={mesh}
              id="card"
              title="CARD"
              defaultSlot={{ x: 220, y: 120, width: 780, height: 500 }}
              minWidth={480}
              minHeight={320}
            >
              <CardWindow mesh={mesh} />
            </SharedAppWindow>
          </>
        ) : null}

        {/* Trash can — pinned bottom-right of THIS viewer's viewport
            (not in the shared slot system). Drag a file icon onto it
            to delete; drag an app icon onto it and it snaps back
            (apps can't be trashed). Gated on auth so the trash isn't
            visible on the sign-in screen. Both surfaces lift by the
            chyron bar's height when the host has set a chyron, so
            they stay clear of the new bar. */}
        {session.authenticated ? <SlopBackdrop chyronVisible={!!mesh.chyronState?.text} /> : null}
        {session.authenticated ? <TrashCan trashRef={trashRef} chyronVisible={!!mesh.chyronState?.text} /> : null}
        {/* Live STT caption — broadcast-style subtitle of the most
            recent transcript segment. Sits above the ChyronBar when
            a chyron is set, otherwise above the TimelineBar. Driven
            entirely by the god-mode tab's STT pipeline; auto-fades
            after a few seconds of silence. Hidden when any peer has
            toggled captions off from the transcript app. */}
        {episode.captionsOn ? <SubtitleCaption mesh={mesh} /> : null}
        {/* Chyron — broadcast-TV term for the static lower-third
            banner. Host-written one-liner that sits on top of the
            timeline bar; collapses to zero height when empty so the
            rest of the bar stack stays put. Host-only edit; everyone
            else just reads it. Distinct from HeadlinesBar (scrolling
            crypto/AI news marquee). */}
        <ChyronBar mesh={mesh} />
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
        {session.authenticated ? (
          <PinnedPeers
            peers={mesh.peers}
            myId={mesh.myId}
            customNames={mesh.customNames}
            onSetCustomName={mesh.setCustomName}
            peerPings={mesh.peerPings}
            slug={slug}
          />
        ) : null}

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
            <FilePreviewWindow file={file} mesh={mesh} audioBusEnabled={isGodMode} />
          </SharedAppWindow>
        ))}
      </div>

      {/* Sign-in gate. While unauthenticated, a full-viewport blur layer
          covers the desktop AND the menubar so nothing behind it is
          interactable. The local cursor (zIndex 2^31) stays on top of
          the blur so the user sees themselves move.
          Suppressed entirely while godMode auth is mid-flight — the
          spectator session is about to land, no point flashing the
          JoinCard at the streaming box for a split second. */}
      {!loading && !session.authenticated && !godModeBusy ? (
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
          {session.invited || roomAuthed === true ? (
            <JoinCard />
          ) : (
            <PasswordGate
              slug={slug}
              defaultPassword={inviteFromUrl}
              onAccepted={() => {
                setRoomAuthed(true);
                void refreshSession();
              }}
            />
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

      {/* Wallet-signer gate refusal. A "wallet-signers" room turned this
          signed-in wallet away at the signal socket (4407 not-a-signer):
          the connected address isn't a signer on the room's multisig.
          Terminal — there's no password to try; an existing signer has to
          add this address to the wallet. */}
      {!loading && session.authenticated && roomGate === "wallet-signers" && mesh.connectError === "not-a-signer" ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            background: "rgba(8,4,18,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Bevel style={{ padding: 22, maxWidth: 380, width: "100%", textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-mark.png"
              alt="slop"
              width={64}
              height={64}
              style={{ display: "block", margin: "0 auto 14px", imageRendering: "pixelated" }}
            />
            <h2
              style={{
                margin: 0,
                marginBottom: 10,
                fontFamily: "var(--slop-font-display)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontSize: 18,
              }}
            >
              Members only
            </h2>
            <p style={{ color: "var(--slop-text-muted)", fontSize: 12, marginTop: 0, marginBottom: 6 }}>
              Room <strong>{slug}</strong> is gated to its wallet signers.
            </p>
            <p style={{ color: "var(--slop-text-muted)", fontSize: 12, marginTop: 0, marginBottom: 14 }}>
              {session.address ? (
                <>
                  <code style={{ fontSize: 11 }}>
                    {session.address.slice(0, 6)}…{session.address.slice(-4)}
                  </code>{" "}
                  isn&apos;t a signer on this room&apos;s multisig. Ask an existing signer to add you, then reload.
                </>
              ) : (
                <>Connect the wallet that&apos;s a signer on this room&apos;s multisig.</>
              )}
            </p>
          </Bevel>
        </div>
      ) : null}

      {/* Third-layer gate: authenticated, room cookie set, no user
          gesture yet this page-load, AND the browser is actually blocking
          unmuted autoplay. Forces a tap so audio/AudioContext start.
          Sign-in flow trips the gesture incidentally (the click on
          Continue / Use Passkey), so this only appears on reload-with-
          valid-session — and now only when the browser truly needs a
          gesture (e.g. a low-engagement first load), not when Chrome's
          autoplay policy already says "allowed" (reload-into-active-music). */}
      {!loading && session.authenticated && roomAuthed === true && !gestured && autoplayBlocked === true ? (
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

      <PrivateAppWindow
        local={local}
        id="mywallet"
        title="WALLET"
        defaultSlot={{ x: 140, y: 90, width: 480, height: 640 }}
        minWidth={360}
        minHeight={420}
        sharedMaxZ={() => Math.max(0, ...Object.values(mesh.slots).map(s => s.z))}
      >
        <WalletAppWindow
          mesh={mesh}
          myAddress={selfSessionAddress}
          myHandle={session.authenticated ? (session.handle ?? null) : null}
        />
      </PrivateAppWindow>

      {saveLayoutOpen ? (
        <SaveLayoutDialog
          defaultName={`Layout ${Object.keys(savedLayouts).length + 1}`}
          existingNames={Object.keys(savedLayouts)}
          onClose={() => setSaveLayoutOpen(false)}
          onSave={saveLayout}
        />
      ) : null}

      {/* File ▸ Upload… picker. Same flow as drag-and-drop — files
          land on the desktop near viewport center, the relay broadcasts
          `file_added`, every peer sees the new icon appear. value=""
          on each change so re-picking the same file fires onChange. */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={e => {
          const input = e.currentTarget;
          const files = input.files;
          if (!files || files.length === 0) return;
          // Find the "next logical icon spot" — column-major scan of the
          // existing icon grid. Snap every desktop-grid slot (app icons
          // AND file icons) to its nearest cell so manual drags still
          // count as occupied; place the upload at the first empty cell.
          // First fill any gaps in the curated app columns, then expand
          // into col 6+ where the cascade already lives.
          const occupied = new Set<string>();
          for (const [id, slot] of Object.entries(mesh.slots)) {
            if (!id.startsWith("icon-") && !id.startsWith("file-")) continue;
            const col = Math.round((slot.x - ICON_DEFAULT_X) / ICON_COL_PITCH);
            const row = Math.round((slot.y - ICON_DEFAULT_Y0) / ICON_ROW_PITCH);
            if (col >= 0 && row >= 0) occupied.add(`${col},${row}`);
          }
          // Fallback if every cell in a generous 30×ICONS_PER_COL area is
          // taken: cascade off the right edge — uploadFiles still works,
          // the icon just lands somewhere past the visible cluster.
          let x = ICON_DEFAULT_X + 30 * ICON_COL_PITCH;
          let y = ICON_DEFAULT_Y0;
          outer: for (let col = 0; col < 30; col++) {
            for (let row = 0; row < ICONS_PER_COL; row++) {
              if (!occupied.has(`${col},${row}`)) {
                x = ICON_DEFAULT_X + col * ICON_COL_PITCH;
                y = ICON_DEFAULT_Y0 + row * ICON_ROW_PITCH;
                break outer;
              }
            }
          }
          // Kick off the upload BEFORE clearing the input: uploadFiles
          // runs Array.from(files) synchronously at its top, snapshotting
          // the FileList into a real Array. Resetting input.value = ""
          // empties the live FileList in place, so doing it first wiped
          // the upload before it could read any file. Clear after to
          // still allow re-picking the same file next time.
          void uploadFiles(files, x, y);
          input.value = "";
        }}
      />

      {/* Click ripples — rendered at top level (not inside the desktop
          wrapper) so the rings aren't clipped over the menubar. Each
          ripple self-prunes from mesh.clicks ~1s after the click. */}
      {mesh.clicks.map(click => {
        const peer = mesh.peers.find(p => p.id === click.peerId);
        // Same fallback chain as cursors: registered peer > inline > peerId hash.
        const bands = bandsFromIdentity({
          address: peer?.address ?? click.address ?? null,
          anonId: peer?.anonId ?? null,
          handle: peer?.handle ?? click.handle ?? null,
          fallback: click.peerId,
        });
        return <ClickRipple key={click.id} x={click.x} y={click.y} bands={bands} />;
      })}

      {/* Tip cards (0.001+ ETH) fly from the chat window to the multisig in
          the menu bar and fade as they land. Self-prune from mesh.tips. */}
      {mesh.tips.map(tip => (
        <FlyingTipCard key={tip.id} tip={tip} customNames={mesh.customNames} />
      ))}

      {/* Cursors render OUTSIDE the desktop wrapper so they aren't clipped
          by its overflow:hidden when over the menubar. Position: fixed +
          zIndex 2^31 keeps them on top of every other layer. Suppressed
          entirely on god-mode views while in the green room — peer cursors
          would otherwise float over the standby card on the stream. */}
      {!(isGodMode && greenRoom) &&
        remoteCursors.map(({ peerId, x, y, handle, address, anonId }) => {
          // anonId already resolved in remoteCursors: peer record wins,
          // falls back to the cursor broadcast's inline value for HTTP
          // agents that aren't in our roster.
          const bands = bandsFromIdentity({ address, anonId, handle, fallback: peerId });
          const lookupKey = (address ?? anonId)?.toLowerCase();
          const customName = lookupKey ? mesh.customNames[lookupKey] : undefined;
          return (
            <Cursor
              key={peerId}
              x={x}
              y={y}
              dimmed
              bands={bands}
              label={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {customName ? (
                    <span>{customName}</span>
                  ) : handle ? (
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

      {/* God-mode (spectator) still renders its own local slop cursor so
          the operator can navigate — but usePeerMesh suppresses the
          mousemove broadcast for spectator sessions, so other peers
          (and the OBS-captured frame the world sees) don't get the
          god-mode cursor overlaid on top of the live participants.
          Hidden on god-mode views while in the green room so the standby
          card stays clean on the stream — the curtain renders above
          everything else. Normal participants keep their cursor; they're
          in the real room, not behind the curtain. */}
      {localCursor.pos && !(isGodMode && greenRoom) ? (
        <Cursor
          x={localCursor.pos.x}
          y={localCursor.pos.y}
          kind={localCursor.kind}
          bands={myBands}
          label={
            session.authenticated ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {session.address && mesh.customNames[session.address.toLowerCase()] ? (
                  <span>{mesh.customNames[session.address.toLowerCase()]}</span>
                ) : session.handle ? (
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

      {/* Green room / standby curtain — god-mode only. Mounted whenever
          this is the streaming box so the fade plays both ways; `visible`
          gates the opacity. Sits above every other layer. */}
      {isGodMode ? (
        <GreenRoomOverlay
          visible={greenRoom}
          slug={slug}
          cardVersion={mesh.cardState?.version ?? null}
          countdown={mesh.clockState.countdown}
          mesh={mesh}
        />
      ) : null}
    </PasskeyWalletProvider>
  );
}

export function Desktop({ slug }: { slug: string }) {
  return (
    <RoomSlugProvider slug={slug}>
      <DesktopInner slug={slug} />
    </RoomSlugProvider>
  );
}
