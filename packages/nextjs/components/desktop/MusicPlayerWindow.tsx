"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadingBar } from "~~/components/ui";
import { useAudioBusElement } from "~~/hooks/useAudioBus";
import type { MusicState, PeerMeshState } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";
import { ACTIVATED_EVENT } from "~~/hooks/useUserGesture";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { audioBus } from "~~/utils/audioBus";

// Music player window body — designed to live inside a <SharedAppWindow>.
// Aesthetic: classic Winamp 2.x main-window — big amber LCD time digits,
// lime track marquee, kbps/kHz/STEREO info, lime→amber→magenta spectrum,
// tight pixel transport buttons, horizontal volume + balance, playlist
// as a separate beveled panel below.
//
// Multiplayer: the *playback* state (which track, playing/paused, where
// in the track) lives in mesh.musicState so every peer hears the same
// thing. Per-user state stays local: volume, balance, the visualiser
// graph (we don't pipe audio through the mesh — each peer plays the
// same MP3 from their own browser).

type Track = {
  title: string;
  artist: string;
  src: string;
  // Jamendo-only fields (absent for legacy /music tracks). The
  // [+]/[−] buttons + drag-reorder gate on `jamendoId` so legacy
  // tracks just have no custom-list affordance.
  jamendoId?: string;
  duration?: number;
  license?: string;
  source?: string;
};

// Music files + playlist now live on the relay (not the Next.js public
// dir), so we prepend RELAY_HTTP for fetches and audio loads. The `src`
// field inside the playlist stays as a root-relative path (`/music/foo.mp3`)
// so the relay can serve it and the mesh state can store it without
// host coupling.
const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const audioUrl = (src: string): string => (src.startsWith("/") ? `${RELAY_HTTP}${src}` : src);
const VOLUME_KEY = "slop-music-volume-v1";
const MUTE_KEY = "slop-music-mute-v1";
/** Tolerance, in seconds, between local audio.currentTime and the
 *  position predicted from the shared state before we force a seek.
 *  Keep this loose — re-seeking too aggressively makes the audio judder
 *  every time the network burps. */
const SYNC_TOLERANCE_SEC = 1.5;

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

/** Where in the track should we be RIGHT NOW given the shared snapshot?
 *  Defensive clamp: if a snapshot says playing but `at` is hours stale
 *  (relay restart, paused tab that never sent an update, future
 *  persistence work that misbehaves), don't try to seek to "position
 *  3 hours" — that just locks every peer at end-of-file. Cap the
 *  forward extrapolation at 10 minutes; older than that, treat as if
 *  playback is paused at the snapshot position. */
const MAX_FORWARD_EXTRAPOLATION_SEC = 600;
const livePosition = (state: MusicState | null): number => {
  if (!state) return 0;
  if (!state.playing) return state.position;
  const elapsed = Math.max(0, (Date.now() - state.at) / 1000);
  if (elapsed > MAX_FORWARD_EXTRAPOLATION_SEC) return state.position;
  return state.position + elapsed;
};

export const MusicPlayerWindow = ({
  mesh,
  audioBusEnabled = false,
}: {
  mesh: PeerMeshState;
  /** God-mode only: route the player's `<audio>` through the shared
   *  AudioBus so the EQ popup can mix it with peer voices. */
  audioBusEnabled?: boolean;
}) => {
  const slug = useRoomSlug();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playlistRef = useRef<HTMLDivElement>(null);
  // Multiplayer scroll sync for the playlist — peers follow whoever
  // scrolls through tracks.
  const onPlaylistScroll = useSyncedScroll(mesh, "music-playlist", playlistRef);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [duration, setDuration] = useState(0);
  const [balance, setBalance] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Volume is shared via mesh.musicState.volume. We keep a local "draft"
  // value for smooth slider feedback during a drag, AND broadcast that
  // draft to peers throttled at ~80ms — that's enough to let a slow drag
  // fade everyone in/out together without spamming the relay. The final
  // release still fires an immediate broadcast as the flush. localStorage
  // seeds the initial value when the shared state is null (relay just
  // restarted, no one playing).
  const [volumeDraft, setVolumeDraft] = useState(0.7);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const volumeBroadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-user local mute. Doesn't touch the shared volume or playback —
  // just silences this peer's <audio> element so they can step away
  // without making everyone else stop. Persisted across reloads.
  const [selfMuted, setSelfMuted] = useState(false);
  // Smooth display tick — re-render every 100ms while playing so the LCD
  // and seek thumb advance without us having to spam the network.
  const [displayPosition, setDisplayPosition] = useState(0);
  // MP3 drop-zone state: drag-hover overlay, current upload status, last
  // error text. Multiple files dropped at once are uploaded sequentially
  // (one POST per file) so the per-room quota check on the relay sees
  // each file's bytes before the next request rides in.
  const [dropHover, setDropHover] = useState(false);
  const dropDepthRef = useRef(0);
  const [uploadStatus, setUploadStatus] = useState<{
    name: string;
    pct: number;
    index: number;
    total: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // God-mode only: route the music player's playback through the
  // shared AudioBus so the broadcaster's EQ popup can mix it.
  useAudioBusElement(audioRef, "music", "music player", audioBusEnabled);

  // Derived: current track + play state come straight from the mesh.
  const ms = mesh.musicState;
  const playing = !!ms?.playing;
  const index = ms?.index ?? 0;

  // Seed the volume draft from localStorage so a fresh peer who joins
  // when the mesh has no music state has a sensible slider position.
  // Same idea for the per-user mute flag.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VOLUME_KEY);
      if (raw) {
        const parsed = parseFloat(raw);
        // Floor at 0.1: a stale near-silent value would otherwise put the
        // god-mode auto-leveler into crush-mode (see setSourceTargetScale
        // below) the moment music starts, killing playback after ~1s.
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) setVolumeDraft(Math.max(0.1, parsed));
      }
      if (window.localStorage.getItem(MUTE_KEY) === "1") setSelfMuted(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Push the per-user mute into the live audio element + persist.
  // audio.muted is independent of audio.volume — toggling this on
  // silences playback without changing the shared loudness.
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = selfMuted;
    try {
      if (selfMuted) window.localStorage.setItem(MUTE_KEY, "1");
      else window.localStorage.removeItem(MUTE_KEY);
    } catch {
      /* ignore */
    }
  }, [selfMuted]);

  // Pull the playlist whenever the shared genre changes. The legacy
  // Kevin MacLeod set is HIDDEN by default — no genre = empty
  // playlist with a "pick a genre" prompt. The legacy /music
  // playlist endpoint still exists on the relay as a revert escape
  // hatch, but isn't shown by this component.
  const activeGenre = mesh.musicGenre;

  // Fetch a fresh playlist whenever the genre changes. ALWAYS clears
  // `tracks` first so the previous genre's rows never leak across the
  // transition — even a cached refresh takes a moment to resolve and
  // the user was seeing stale rows in that gap. Empty `tracks` +
  // `loading…` error state = the LoadingBar empty-state renders, so
  // every genre click flashes the loader before the new list paints.
  //
  // mesh.musicCustom is INTENTIONALLY not a dep here — including it
  // would re-run this effect on every add/remove and flash the list
  // even when the user isn't switching tabs. Custom-sync lives in a
  // separate effect below.
  useEffect(() => {
    let cancelled = false;
    setTracks([]);
    if (!activeGenre) {
      setError("pick a genre");
      return;
    }
    if (activeGenre === "custom") {
      // Initial population on switch-to-Custom. Subsequent broadcasts
      // are handled by the sync-effect below.
      setTracks(mesh.musicCustom as Track[]);
      setError(null);
      return;
    }
    setError(`loading ${activeGenre}…`);
    fetch(withSlug(`${RELAY_HTTP}/v1/music/genre/${encodeURIComponent(activeGenre)}/playlist`, slug), {
      cache: "no-store",
      credentials: "include",
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { tracks?: unknown }) => {
        if (cancelled) return;
        if (!Array.isArray(data.tracks)) throw new Error("no tracks");
        const valid = (data.tracks as Track[]).filter(t => typeof t?.src === "string" && typeof t?.title === "string");
        setTracks(valid);
        setError(valid.length === 0 ? "playlist is empty" : null);
      })
      .catch(err => {
        if (!cancelled) setError(`couldn't load playlist: ${(err as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGenre]);

  // Keep the Custom tab synced with mesh broadcasts (add/remove/
  // reorder) WITHOUT clearing the list on every change. Only runs
  // while the user is actually viewing Custom — other tabs get their
  // tracks from the fetch effect above.
  useEffect(() => {
    if (activeGenre !== "custom") return;
    setTracks(mesh.musicCustom as Track[]);
    setError(null);
  }, [activeGenre, mesh.musicCustom]);

  const current = tracks[index] ?? null;

  // What's ACTUALLY playing right now, derived from the shared
  // music state's `src` (not the playlist position). This decouples
  // "what's audible" from "what's in the visible playlist" so a
  // genre switch mid-song doesn't yank playback to a different
  // track. If the playing src happens to be in the new playlist, we
  // use that track's metadata for the marquee; if not, we synthesize
  // a minimal record from the URL so the LCD has something to show.
  const playingTrack = useMemo<Track | null>(() => {
    const src = ms?.src;
    if (!src) return null;
    const found = tracks.find(t => t.src === src);
    if (found) return found;
    const filename =
      src
        .split("/")
        .pop()
        ?.replace(/\.mp3$/i, "") ?? "track";
    return { title: filename, artist: "—", src };
  }, [ms?.src, tracks]);

  // Upload an MP3 (or several) into the room's custom playlist. POSTs
  // raw bytes to /v1/music/upload, which sniffs the magic bytes,
  // enforces the per-room quota, persists to UPLOAD_MUSIC_DIR/<slug>/,
  // and inserts a synthetic "upload:<hash>" track into the custom
  // playlist. The mesh broadcast of `music_custom` re-paints the
  // playlist for every peer; we also flip the active genre to "custom"
  // so the dropper actually sees their track land.
  const uploadMp3s = useCallback(
    async (files: File[]) => {
      const mp3s = files.filter(f => /\.mp3$/i.test(f.name) || f.type === "audio/mpeg" || f.type === "audio/mp3");
      if (mp3s.length === 0) {
        setUploadError("only .mp3 files are supported");
        return;
      }
      setUploadError(null);
      // Switch to Custom so the new track is visible immediately. The
      // genre flip is per-mesh — every peer follows. Skip if we're
      // already on Custom.
      if (activeGenre !== "custom") mesh.setMusicGenre("custom");
      for (let i = 0; i < mp3s.length; i += 1) {
        const file = mp3s[i]!;
        setUploadStatus({ name: file.name, pct: 0, index: i + 1, total: mp3s.length });
        try {
          const bytes = await file.arrayBuffer();
          // XHR (not fetch) so we get upload progress events. The relay
          // accepts audio/mpeg as a raw buffer via the existing
          // addContentTypeParser registrations.
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = withSlug(`${RELAY_HTTP}/v1/music/upload?name=${encodeURIComponent(file.name)}`, slug);
            xhr.open("POST", url);
            xhr.withCredentials = true;
            xhr.setRequestHeader("content-type", file.type || "audio/mpeg");
            xhr.upload.addEventListener("progress", ev => {
              if (!ev.lengthComputable) return;
              setUploadStatus(s => (s ? { ...s, pct: ev.loaded / ev.total } : s));
            });
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
                return;
              }
              try {
                const err = JSON.parse(xhr.responseText) as { error?: string };
                reject(new Error(err.error ?? `HTTP ${xhr.status}`));
              } catch {
                reject(new Error(`HTTP ${xhr.status}`));
              }
            };
            xhr.onerror = () => reject(new Error("network error"));
            xhr.send(bytes);
          });
        } catch (err) {
          setUploadError(`${file.name}: ${(err as Error).message}`);
          setUploadStatus(null);
          return;
        }
      }
      setUploadStatus(null);
    },
    [activeGenre, mesh, slug],
  );

  // Custom-playlist helpers used by the [+]/[−] buttons on each row,
  // and by drag-to-reorder logic when viewing the Custom tab.
  const isCustomTab = activeGenre === "custom";
  const customIds = useMemo(() => new Set(mesh.musicCustom.map(t => t.jamendoId).filter(Boolean)), [mesh.musicCustom]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [localCustomOrder, setLocalCustomOrder] = useState<string[] | null>(null);

  // When dragging on the Custom tab, render from `localCustomOrder`
  // for instant visual feedback. Once the drop fires + the relay
  // broadcasts back, `tracks` (sourced from mesh.musicCustom) catches
  // up and we drop the local override.
  const displayedTracks = useMemo<Track[]>(() => {
    if (!isCustomTab || !localCustomOrder) return tracks;
    const byId = new Map(tracks.map(t => [t.jamendoId, t]));
    const out: Track[] = [];
    const used = new Set<string>();
    for (const id of localCustomOrder) {
      const t = byId.get(id);
      if (t && !used.has(id)) {
        out.push(t);
        used.add(id);
      }
    }
    for (const t of tracks) {
      if (!t.jamendoId || !used.has(t.jamendoId)) out.push(t);
    }
    return out;
  }, [isCustomTab, localCustomOrder, tracks]);

  // ---- Web Audio graph -------------------------------------------------
  // analyser for the spectrum, plus a stereo panner for the BAL slider.
  // Built lazily *inside the user gesture* (any transport click) — Chrome
  // keeps a context created outside a gesture in the "suspended" state,
  // which silently swallows all audio routed through it.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const pannerRef = useRef<StereoPannerNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Idempotency sentinel for setupGraph — true once we've either
  // built our own graph OR borrowed the bus's analyser. Separate from
  // audioCtxRef because in god-mode we don't own a context.
  const graphReadyRef = useRef(false);
  // Live mirror of audioBusEnabled for the RAF loop's self-heal below —
  // that effect binds once (empty deps) so it can't read the prop
  // directly without it going stale when god mode flips on after mount.
  const audioBusEnabledRef = useRef(audioBusEnabled);
  audioBusEnabledRef.current = audioBusEnabled;

  const setupGraph = useCallback(() => {
    const a = audioRef.current;
    if (!a || graphReadyRef.current) return;
    // God-mode path: the AudioBus already owns this <audio> element
    // (it called createMediaElementSource on mount). A second call
    // here would throw InvalidStateError — that's exactly what was
    // killing the spectrum visualizer on the broadcast box. Instead,
    // borrow the bus's per-source AnalyserNode and skip our own
    // graph entirely. Balance/panning is dropped in this mode (the
    // bus doesn't currently expose per-source panning).
    if (audioBusEnabled) {
      const busAnalyser = audioBus().getAnalyser("music");
      if (busAnalyser) {
        analyserRef.current = busAnalyser;
        graphReadyRef.current = true;
      }
      // If the bus hasn't registered the source yet (the spectator-
      // session trade can land after this one-shot fires), no-op here —
      // the RAF spectrum loop re-grabs getAnalyser("music") every frame
      // until it's available, so a box that came up into already-playing
      // audio lights up as soon as the bus catches up, with no second
      // setupGraph() trigger needed.
      return;
    }
    type Ctor = new () => AudioContext;
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!C) return;
    try {
      const ctx = new C();
      const src = ctx.createMediaElementSource(a);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      const panner = ctx.createStereoPanner();
      src.connect(panner);
      panner.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      pannerRef.current = panner;
      graphReadyRef.current = true;
    } catch (err) {
      console.warn("music graph init failed", err);
    }
  }, [audioBusEnabled]);

  // The slider's displayed value: while the user is mid-drag, that's
  // their in-flight draft; otherwise it's whatever the mesh says
  // everyone is currently listening at, falling back to the draft when
  // no music state exists yet.
  const sharedVolume = ms?.volume;
  const shownVolume = volumeDragging ? volumeDraft : (sharedVolume ?? volumeDraft);

  // Push the shown volume into the live audio element + persist locally
  // (so a returning peer, joining when no music state is set, lands at
  // the volume they last used).
  //
  // God-mode wrinkle: when the AudioBus owns this <audio> element we
  // CANNOT apply audio.volume — the bus's auto-leveler would see the
  // quieter input and crank source gain right back up to compensate,
  // making the volume slider effectively a no-op. Instead, keep
  // audio.volume pinned at 1 and tell the bus our target preference
  // (audioBus.setSourceTargetScale) so the auto aims for a lower
  // post-gain RMS when the user wants lower. End result: turning
  // music down actually turns music down in the mix.
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = audioBusEnabled ? 1 : shownVolume;
    }
    if (audioBusEnabled) {
      // Floor the target scale at 0.1 so the auto-leveler never aims for
      // near-silence. A low shownVolume (e.g. a stale 0.08 from
      // localStorage) would otherwise set the target RMS so low that the
      // gain lerps to ~zero within ~1s and the music dies on the
      // god-mode box despite Slopamp still reading "playing".
      audioBus().setSourceTargetScale("music", Math.max(0.1, shownVolume));
    }
    try {
      window.localStorage.setItem(VOLUME_KEY, String(shownVolume));
    } catch {
      /* ignore */
    }
  }, [shownVolume, audioBusEnabled]);

  // When the mesh-shared volume changes (someone else dragged + released
  // their slider), keep our local draft in sync so the slider thumb
  // doesn't snap back to the old draft on the next mouseup.
  useEffect(() => {
    if (sharedVolume == null) return;
    if (volumeDragging) return;
    setVolumeDraft(sharedVolume);
  }, [sharedVolume, volumeDragging]);

  // Push balance into the panner if the graph is up.
  useEffect(() => {
    const p = pannerRef.current;
    if (p) p.pan.value = Math.max(-1, Math.min(1, balance));
  }, [balance]);

  // ---- The single source of truth: mesh.musicState ---------------------
  // Whenever the shared snapshot changes (or the audio element is replaced),
  // bring our local <audio> in line:
  //   - load the right track
  //   - jump to the predicted position if we've drifted too far
  //   - play / pause to match the shared `playing` flag
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !playingTrack) return;

    // Source mismatch → load the correct track. Setting `src` cancels any
    // in-flight load so this is safe to call repeatedly with the same value.
    // We load `playingTrack.src` (derived from ms.src), NOT `current.src`,
    // so a genre switch doesn't yank playback to the new playlist's
    // track at the same index.
    if (!a.src.endsWith(playingTrack.src)) {
      a.src = audioUrl(playingTrack.src);
      a.load();
    }

    const target = livePosition(ms);
    if (Math.abs(a.currentTime - target) > SYNC_TOLERANCE_SEC && Number.isFinite(target)) {
      try {
        a.currentTime = target;
      } catch {
        /* readyState too low — the loadeddata listener below will retry */
      }
    }

    if (playing && a.paused) {
      audioCtxRef.current?.resume().catch(() => undefined);
      a.play().catch(err => {
        // First time round we may be outside a user gesture (e.g. another
        // peer pressed play before we ever interacted). Surface a hint
        // and stay paused locally; the next click on play will work
        // because Chrome counts that as a gesture.
        setError(`tap play to join — ${(err as Error).message}`);
      });
    } else if (!playing && !a.paused) {
      a.pause();
    }
    // Re-run whenever the snapshot changes meaningfully OR the current
    // track src flips. We DON'T depend on `livePosition` itself — we
    // re-sync on snapshot edges and trust the audio element to drift
    // smoothly between them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms?.src, ms?.index, ms?.playing, ms?.position, ms?.at, playingTrack?.src]);

  // Lifecycle event listeners — drive *local* state (duration, error)
  // and broadcast on track-end so all peers advance together.
  //
  // We pull the live values for `mesh`, `tracks`, `index`, `current`,
  // and `shownVolume` through refs so this effect re-binds the audio
  // listeners ONLY when the audio element itself changes (i.e. never
  // after mount). Without the refs, `mesh` is a fresh object every
  // render of the parent — re-binding all five listeners every paint
  // wastes work and opens a tiny window where an `ended` event could
  // be missed during the unbind/rebind.
  const lastEndedRef = useRef<{ src: string; at: number } | null>(null);
  const meshRef = useRef(mesh);
  meshRef.current = mesh;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const indexRef = useRef(index);
  indexRef.current = index;
  const currentRef = useRef(current);
  currentRef.current = current;
  const shownVolumeRef = useRef(shownVolume);
  shownVolumeRef.current = shownVolume;
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMeta = () => setDuration(a.duration || 0);
    const onLoaded = () => {
      // After a fresh load, snap to the shared target position once
      // metadata is available (in case the earlier setCurrentTime in
      // the sync effect was rejected for readyState reasons).
      const target = livePosition(meshRef.current.musicState);
      if (Math.abs(a.currentTime - target) > SYNC_TOLERANCE_SEC && Number.isFinite(target)) {
        try {
          a.currentTime = target;
        } catch {
          /* still not seekable, give up — playback will start from 0 */
        }
      }
    };
    const onEnded = () => {
      // Multiple peers fire `ended` at roughly the same wall-clock time,
      // and they all compute the same next-index payload — so a flurry
      // of identical music_state messages lands at the relay and fans
      // back out. Last-write-wins is harmless when the writes match.
      // Dedupe per-track-per-second locally so we don't double-broadcast
      // if the audio element fires ended twice (some browsers do).
      const trks = tracksRef.current;
      const cur = currentRef.current;
      const idx = indexRef.current;
      if (trks.length === 0) return;
      const stamp = lastEndedRef.current;
      if (cur && stamp && stamp.src === cur.src && Date.now() - stamp.at < 1000) return;
      if (cur) lastEndedRef.current = { src: cur.src, at: Date.now() };
      const nextIndex = (idx + 1) % trks.length;
      meshRef.current.setMusicState({
        src: trks[nextIndex]?.src ?? null,
        index: nextIndex,
        playing: true,
        position: 0,
        at: Date.now(),
        volume: meshRef.current.musicState?.volume ?? shownVolumeRef.current,
      });
    };
    const onErr = () => {
      const m = a.error?.message || "unknown error";
      setError(`playback error on "${currentRef.current?.title ?? "?"}": ${m}`);
    };
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("loadeddata", onLoaded);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onErr);
    return () => {
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("loadeddata", onLoaded);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onErr);
    };
  }, []);

  // Smooth UI tick — every 100ms while playing, recompute the displayed
  // position. Doesn't touch the network; just re-renders the LCD/seek.
  useEffect(() => {
    if (!playing) {
      setDisplayPosition(ms?.position ?? 0);
      return;
    }
    const tick = () => setDisplayPosition(livePosition(mesh.musicState));
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [playing, ms?.position, ms?.at, ms?.src, mesh]);

  // ---- Transport actions: every click broadcasts a new snapshot ------
  // None of these touch the audio element directly. The mesh-sync effect
  // above is the single place that decides what the audio plays.
  const broadcast = useCallback(
    (patch: Partial<MusicState>) => {
      setupGraph();
      audioCtxRef.current?.resume().catch(() => undefined);
      setError(null);
      const cur = mesh.musicState;
      const now = Date.now();
      // The shared snapshot encodes "at moment T, position was P".
      // Whenever we re-broadcast, `at` jumps to `now`, so `position`
      // MUST also jump forward by however long it's been playing —
      // otherwise volume-only updates (which keep cur.position) make
      // peers compute "play head is at the OLD position" and the audio
      // visibly rewinds. Compute the live head once and let callers
      // override only when they really mean to (seek, stop, track-jump).
      const livePos = livePosition(cur);
      const fallback: MusicState = {
        src: current?.src ?? null,
        index,
        playing: false,
        position: livePos,
        at: now,
        volume: shownVolume,
      };
      mesh.setMusicState({
        ...fallback,
        ...cur,
        ...patch,
        // patch.position wins (caller is intentionally seeking); else
        // use the live head, never the stale cur.position.
        position: patch.position ?? livePos,
        at: patch.at ?? now,
      });
    },
    [mesh, current, index, setupGraph, shownVolume],
  );

  // For pause/resume/seek/stop we broadcast the CURRENTLY-PLAYING
  // track's src (from ms), not whatever's at the selected playlist
  // index — those can diverge after a genre switch. Falls back to
  // the selected track's src if nothing is playing yet.
  const activeSrc = ms?.src ?? current?.src ?? null;

  const togglePlay = useCallback(() => {
    if (!activeSrc) return;
    const a = audioRef.current;
    const at = livePosition(mesh.musicState);
    broadcast({
      src: activeSrc,
      index,
      playing: !playing,
      // Capture a fresh position from the local audio element if we have
      // one, otherwise from the shared snapshot. Either is "now".
      position: a && Number.isFinite(a.currentTime) ? a.currentTime : at,
    });
  }, [broadcast, activeSrc, index, playing, mesh]);

  const stop = useCallback(() => {
    if (!activeSrc) return;
    broadcast({ src: activeSrc, index, playing: false, position: 0 });
  }, [broadcast, activeSrc, index]);

  const next = useCallback(() => {
    if (tracks.length === 0) return;
    const i = (index + 1) % tracks.length;
    broadcast({ src: tracks[i]?.src ?? null, index: i, playing, position: 0 });
  }, [broadcast, tracks, index, playing]);

  const prev = useCallback(() => {
    if (tracks.length === 0) return;
    // > 3s into the track? rewind. Else jump to previous. (Winamp default.)
    const a = audioRef.current;
    if (a && a.currentTime > 3 && activeSrc) {
      broadcast({ src: activeSrc, index, playing, position: 0 });
      return;
    }
    const i = (index - 1 + tracks.length) % tracks.length;
    broadcast({ src: tracks[i]?.src ?? null, index: i, playing, position: 0 });
  }, [broadcast, tracks, index, playing, current]);

  const playIndex = useCallback(
    (i: number) => {
      if (tracks.length === 0) return;
      broadcast({ src: tracks[i]?.src ?? null, index: i, playing: true, position: 0 });
    },
    [broadcast, tracks],
  );

  // ---- RAF spectrum loop. Renders to canvas in-place; no React re-renders.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      // God-mode self-heal: the AudioBus registers the "music" source
      // asynchronously (after the spectator-session trade flips god mode
      // on), which can land AFTER the one-shot setupGraph() call. Re-grab
      // the bus analyser here until it's available so a box that came up
      // into already-playing audio — no transport press to re-trigger
      // setupGraph — still gets a live spectrum. Borrowing the node never
      // creates/resumes a context, so this needs no user gesture.
      if (!analyserRef.current && audioBusEnabledRef.current) {
        analyserRef.current = audioBus().getAnalyser("music");
      }
      const analyser = analyserRef.current;
      const canvas = canvasRef.current;
      if (analyser && canvas) {
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
          canvas.width = cssW * dpr;
          canvas.height = cssH * dpr;
        }
        const ctx2d = canvas.getContext("2d");
        if (ctx2d) {
          const W = canvas.width;
          const H = canvas.height;
          ctx2d.clearRect(0, 0, W, H);
          const bins = analyser.frequencyBinCount;
          const data = new Uint8Array(bins);
          analyser.getByteFrequencyData(data);
          const start = 1; // skip DC bin
          const used = Math.min(bins - start, 19); // Winamp main viz is ~19 bars
          const totalGap = (used + 1) * dpr;
          const barW = (W - totalGap) / used;
          for (let i = 0; i < used; i++) {
            const v = (data[i + start] ?? 0) / 255;
            const segments = Math.max(1, Math.floor(v * 14));
            const segH = H / 14;
            const x = dpr + i * (barW + dpr);
            for (let s = 0; s < segments; s++) {
              const t = s / 14;
              const color = t < 0.45 ? "#bcff5b" : t < 0.75 ? "#ffae00" : "#ff3ec9";
              ctx2d.fillStyle = color;
              const y = H - (s + 1) * segH + dpr * 0.5;
              ctx2d.fillRect(x, y, barW, Math.max(1, segH - dpr));
            }
          }
        }
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // Cleanup AudioContext on unmount.
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  // The page-level EntryGate fires `slop:activated` exactly once when
  // the user first interacts. That's our cue to retry whatever the
  // autoplay policy refused — resume the AudioContext and call
  // audio.play() if mesh state says we should be playing. Without
  // this, a reload-into-active-music leaves the local <audio> stuck
  // paused even though the rest of the mesh is mid-track.
  useEffect(() => {
    const onActivated = () => {
      const a = audioRef.current;
      if (!a) return;
      setupGraph();
      audioCtxRef.current?.resume().catch(() => undefined);
      if (mesh.musicState?.playing && a.paused) {
        a.play().catch(err => setError(`play failed: ${(err as Error).message}`));
      }
    };
    window.addEventListener(ACTIVATED_EVENT, onActivated);
    return () => window.removeEventListener(ACTIVATED_EVENT, onActivated);
  }, [mesh, setupGraph]);

  // OS audio device swap recovery. When the user plugs in headphones (or
  // switches default output via the menubar / Bluetooth / etc.) Chrome
  // doesn't automatically reroute audio that's already in flight — the
  // <audio> element keeps "playing" but the samples go to the previous
  // device, and the AudioContext destination stays pinned to the old
  // sink. Symptom: audio dies after the switch and you have to manually
  // stop + start to bring it back on the new device.
  //
  // Recovery: on `devicechange`, if the shared state says we SHOULD be
  // playing, briefly pause + play the audio element. A fresh play()
  // call routes to the current default device. Also resume the
  // AudioContext (sometimes it gets suspended on device swaps).
  //
  // We don't tear down the AudioContext / MediaElementSource because
  // Chrome forbids creating a second MediaElementSource on the same
  // <audio> element. Pause+play is enough for the user-audible audio;
  // the visualizer keeps working because its analyser is still in the
  // graph.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    const onDeviceChange = () => {
      const a = audioRef.current;
      if (!a) return;
      audioCtxRef.current?.resume().catch(() => undefined);
      if (!mesh.musicState?.playing) return;
      // Pause + replay nudges Chrome to re-resolve the audio sink. The
      // currentTime is preserved across pause/play so there's no visible
      // skip — peers stay in sync within the existing tolerance.
      try {
        a.pause();
      } catch {
        /* ignore */
      }
      a.play().catch(err => {
        setError(`device-change retry: ${(err as Error).message}`);
      });
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [mesh]);

  const lcdTrackText = useMemo(() => {
    if (error) return error;
    // Show what's actually playing (from ms.src), not what's at the
    // selected playlist index. Across a genre switch these can diverge.
    if (playingTrack) {
      return `${playingTrack.artist} - ${playingTrack.title}  (${fmtTime(duration)})`;
    }
    if (current) {
      return `${index + 1}. ${current.artist} - ${current.title}  (${fmtTime(duration)})`;
    }
    return tracks.length === 0 ? "loading playlist…" : "no track";
  }, [playingTrack, current, error, tracks.length, index, duration]);

  const shownPosition = seeking ? seekValue : displayPosition;
  const seekMax = duration > 0 ? duration : 1;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "linear-gradient(180deg, #14091e 0%, #06030d 100%)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-display)",
        userSelect: "none",
      }}
    >
      {/* Audio is served by the relay at RELAY_HTTP/music/*. crossOrigin
          is required for `ctx.createMediaElementSource(audio)` to read
          samples for the spectrum analyser — without it the visualizer
          stays flat. The relay sets `Access-Control-Allow-Origin` for
          configured origins via @fastify/cors. */}
      <audio ref={audioRef} preload="metadata" crossOrigin="anonymous" />

      {/* Per-user local mute — overlaid in the top-right of the player
          window, same idea as AudioVisualizer / camera's "your side"
          mute button. Doesn't broadcast; only silences this peer's
          <audio> element. Shared playback / volume continue normally. */}
      <button
        type="button"
        onClick={() => setSelfMuted(m => !m)}
        aria-label={selfMuted ? "unmute (local)" : "mute (local)"}
        title={selfMuted ? "unmute (only affects you)" : "mute (only affects you)"}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          zIndex: 10,
          width: 26,
          height: 26,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          background: selfMuted ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
          border: `1px solid ${selfMuted ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
          color: "#fff",
          backdropFilter: "blur(4px)",
        }}
      >
        {selfMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
      </button>

      {/* === Top LCD panel ============================================== */}
      <div
        style={{
          margin: 6,
          // extra right padding reserves space for the absolute-positioned
          // mute button so it doesn't sit on top of the "STEREO" text
          padding: "6px 36px 4px 8px",
          background: "#000",
          borderTop: "1px solid #000",
          borderLeft: "1px solid #000",
          borderRight: "1px solid rgba(255,255,255,0.18)",
          borderBottom: "1px solid rgba(255,255,255,0.18)",
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 8,
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 78 }}>
          <div
            style={{
              fontFamily: "var(--slop-font-display)",
              fontSize: 28,
              lineHeight: 1,
              color: playing ? "var(--slop-amber, #ffae00)" : "rgba(255,174,0,0.35)",
              letterSpacing: "0.04em",
              fontVariantNumeric: "tabular-nums",
              textShadow: playing
                ? "0 0 6px rgba(255,174,0,0.55), 0 0 14px rgba(255,174,0,0.25)"
                : "0 0 4px rgba(255,174,0,0.2)",
            }}
          >
            {fmtTime(shownPosition)}
          </div>
          <div
            style={{
              fontSize: 9,
              color: "rgba(188,255,91,0.8)",
              letterSpacing: "0.08em",
            }}
          >
            -{fmtTime(Math.max(0, duration - shownPosition))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 6,
              alignItems: "stretch",
            }}
          >
            <canvas ref={canvasRef} style={{ width: "100%", height: 28, display: "block" }} aria-hidden />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                justifyContent: "space-between",
                fontSize: 9,
                color: "rgba(188,255,91,0.75)",
                letterSpacing: "0.06em",
                lineHeight: 1.1,
              }}
            >
              <div>256 kbps</div>
              <div>44 khz</div>
              <div style={{ color: playing ? "var(--slop-lime, #bcff5b)" : "rgba(188,255,91,0.3)" }}>STEREO</div>
            </div>
          </div>
          <Marquee text={lcdTrackText} color={error ? "var(--slop-red, #ff5577)" : "var(--slop-lime, #bcff5b)"} />
        </div>
      </div>

      {/* === Seek bar ================================================== */}
      <div style={{ padding: "0 8px" }}>
        <input
          type="range"
          min={0}
          max={seekMax}
          step={0.1}
          value={shownPosition}
          onChange={e => setSeekValue(parseFloat(e.target.value))}
          onMouseDown={() => {
            setSeekValue(displayPosition);
            setSeeking(true);
          }}
          onMouseUp={e => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            setSeeking(false);
            if (!activeSrc || !Number.isFinite(v)) return;
            // Broadcast the seek against the currently-playing track,
            // not whatever the playlist cursor is on (those can
            // diverge after a genre switch).
            broadcast({ src: activeSrc, index, playing, position: v });
          }}
          disabled={!activeSrc || duration === 0}
          aria-label="seek"
          className="slop-music-range slop-music-range--seek"
          style={{ width: "100%" }}
        />
      </div>

      {/* === Transport + sliders row =================================== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          alignItems: "center",
          gap: 10,
          padding: "4px 8px 6px",
        }}
      >
        <div style={{ display: "flex", gap: 2 }}>
          <TBtn label="prev" onClick={prev} disabled={tracks.length === 0} icon="prev" />
          <TBtn label="play" onClick={togglePlay} disabled={!current} icon={playing ? "pause" : "play"} accent />
          <TBtn label="stop" onClick={stop} disabled={!current} icon="stop" />
          <TBtn label="next" onClick={next} disabled={tracks.length === 0} icon="next" />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto 1fr",
            alignItems: "center",
            columnGap: 4,
            fontSize: 9,
            color: "rgba(188,255,91,0.65)",
            letterSpacing: "0.08em",
          }}
        >
          <span>VOL</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={shownVolume}
            // Smooth feedback while dragging — change the local audio
            // immediately so the dragger hears their own change. Also
            // broadcast the in-flight value to peers, throttled to a
            // pending-timeout so a slow drag can fade everyone together
            // without spamming the relay every onChange tick.
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!Number.isFinite(v)) return;
              setVolumeDraft(v);
              if (volumeBroadcastTimerRef.current == null) {
                volumeBroadcastTimerRef.current = setTimeout(() => {
                  volumeBroadcastTimerRef.current = null;
                  broadcast({ volume: v });
                }, 80);
              }
            }}
            onMouseDown={() => setVolumeDragging(true)}
            onMouseUp={e => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              setVolumeDragging(false);
              // Flush any pending throttled broadcast and send the final
              // committed value immediately on release.
              if (volumeBroadcastTimerRef.current != null) {
                clearTimeout(volumeBroadcastTimerRef.current);
                volumeBroadcastTimerRef.current = null;
              }
              if (Number.isFinite(v)) broadcast({ volume: v });
            }}
            // Touch support (mobile/tablet) — same handshake. Pull the
            // value from the input itself, not the captured volumeDraft
            // closure, so a fast drag whose final setVolumeDraft hasn't
            // been committed yet still broadcasts the correct value.
            onTouchStart={() => setVolumeDragging(true)}
            onTouchEnd={e => {
              setVolumeDragging(false);
              const v = parseFloat((e.target as HTMLInputElement).value);
              if (volumeBroadcastTimerRef.current != null) {
                clearTimeout(volumeBroadcastTimerRef.current);
                volumeBroadcastTimerRef.current = null;
              }
              if (Number.isFinite(v)) broadcast({ volume: v });
            }}
            aria-label="volume"
            className="slop-music-range"
            style={{ width: "100%" }}
          />
          <span style={{ marginLeft: 4 }}>BAL</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={balance}
            onChange={e => setBalance(parseFloat(e.target.value))}
            onDoubleClick={() => setBalance(0)}
            aria-label="balance"
            className="slop-music-range"
            style={{ width: "100%" }}
            title="double-click to center"
          />
        </div>
      </div>

      {/* === Playlist (separate beveled panel) ========================= */}
      {/* Drag-and-drop MP3s anywhere on this panel → uploads to the
          room's Custom playlist. stopPropagation so the desktop's
          own file-drop handler (which routes to /v1/files for icon
          drops) doesn't also fire. */}
      <div
        onDragEnter={e => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          dropDepthRef.current += 1;
          setDropHover(true);
        }}
        onDragOver={e => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={e => {
          e.stopPropagation();
          dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
          if (dropDepthRef.current === 0) setDropHover(false);
        }}
        onDrop={e => {
          if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          dropDepthRef.current = 0;
          setDropHover(false);
          void uploadMp3s(Array.from(e.dataTransfer.files));
        }}
        style={{
          flex: 1,
          minHeight: 0,
          margin: "0 6px 6px",
          background: "#000",
          borderTop: "1px solid #000",
          borderLeft: "1px solid #000",
          borderRight: "1px solid rgba(255,255,255,0.18)",
          borderBottom: "1px solid rgba(255,255,255,0.18)",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        {/* Genre selector row — Jamendo-backed trending playlists.
            Shared across the mesh: clicking a genre flips every peer's
            playlist. The first click on a cold genre triggers the
            relay to download ~20 tracks, which can take ~30s; the LCD
            status text reflects the load state. */}
        {mesh.musicGenres.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 2,
              padding: "4px 4px 0",
              background: "linear-gradient(180deg, rgba(124,77,255,0.18) 0%, rgba(0,0,0,0.4) 100%)",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            {mesh.musicGenres.map(g => {
              const active = mesh.musicGenre === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => mesh.setMusicGenre(active ? null : g.id)}
                  style={{
                    padding: "3px 8px",
                    fontSize: 9,
                    fontFamily: "var(--slop-font-display)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    background: active
                      ? "linear-gradient(180deg, rgba(255,62,201,0.45) 0%, rgba(124,77,255,0.35) 100%)"
                      : "transparent",
                    color: active ? "var(--slop-amber, #ffae00)" : "rgba(188,255,91,0.7)",
                    border: `1px solid ${active ? "rgba(255,174,0,0.6)" : "rgba(255,255,255,0.1)"}`,
                    borderRadius: 2,
                    cursor: "pointer",
                  }}
                  title={active ? "click to deselect" : `play trending ${g.label.toLowerCase()}`}
                >
                  {g.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <div
          style={{
            padding: "3px 8px",
            fontSize: 9,
            color: "rgba(188,255,91,0.6)",
            letterSpacing: "0.1em",
            background: "linear-gradient(180deg, rgba(124,77,255,0.35) 0%, rgba(0,0,0,0.6) 100%)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {mesh.musicGenre
            ? `${mesh.musicGenre.toUpperCase()} — TRENDING THIS WEEK — ${tracks.length} ITEM${tracks.length === 1 ? "" : "S"}`
            : `PLAYLIST EDITOR — ${tracks.length} ITEM${tracks.length === 1 ? "" : "S"}`}
        </div>
        <div ref={playlistRef} onScroll={onPlaylistScroll} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {tracks.length === 0 ? (
            // Three empty-states:
            //   1. Active genre + no tracks yet → indeterminate
            //      LoadingBar (matches the browser's URL-bar loader).
            //   2. No active genre → "pick a genre" prompt.
            //   3. Active genre but the fetch errored → the error text.
            // The `error` state holds "loading <genre>…" while the
            // fetch is in flight, so we use it to discriminate states
            // (1) and (3): if it starts with "loading", show the
            // animated bar. Custom never shows a loader — it's just
            // empty until the user adds something.
            <div
              style={{
                padding: 16,
                fontSize: 10,
                color: "var(--slop-text-muted)",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
              }}
            >
              {isCustomTab ? (
                <span>custom is empty — click [+] on any track to add it.</span>
              ) : activeGenre && error?.startsWith("loading") ? (
                <>
                  <LoadingBar
                    cells={14}
                    caption={`FETCHING ${activeGenre.toUpperCase()}`}
                    style={{ fontSize: 11, color: "var(--slop-lime, #bcff5b)" }}
                  />
                  <span style={{ fontSize: 9, color: "var(--slop-text-muted)" }}>
                    pulling trending tracks from jamendo (~30s)
                  </span>
                </>
              ) : (
                <span>{error ?? "loading…"}</span>
              )}
            </div>
          ) : (
            displayedTracks.map((t, i) => {
              // Highlight by src match (what's actually playing),
              // not by the stored ms.index value — across a genre
              // switch those can point at unrelated tracks.
              const active = playingTrack?.src === t.src;
              const inCustom = t.jamendoId ? customIds.has(t.jamendoId) : false;
              const isDraggingRow = isCustomTab && draggingId === t.jamendoId;
              return (
                <div
                  key={t.src}
                  draggable={isCustomTab && !!t.jamendoId}
                  onDragStart={e => {
                    if (!isCustomTab || !t.jamendoId) return;
                    setDraggingId(t.jamendoId);
                    setLocalCustomOrder(tracks.map(x => x.jamendoId).filter((id): id is string => !!id));
                    e.dataTransfer.effectAllowed = "move";
                    try {
                      e.dataTransfer.setData("text/plain", t.jamendoId);
                    } catch {
                      /* Firefox edge case — value unused anyway */
                    }
                  }}
                  onDragOver={e => {
                    if (!isCustomTab || !draggingId || !t.jamendoId || draggingId === t.jamendoId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setLocalCustomOrder(prev => {
                      const cur = prev ?? tracks.map(x => x.jamendoId).filter((id): id is string => !!id);
                      const fromIdx = cur.indexOf(draggingId);
                      const toIdx = cur.indexOf(t.jamendoId!);
                      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return cur;
                      const next = cur.slice();
                      next.splice(fromIdx, 1);
                      next.splice(toIdx, 0, draggingId);
                      return next;
                    });
                  }}
                  onDragEnd={() => {
                    if (!isCustomTab) return;
                    if (localCustomOrder) {
                      const serverIds = mesh.musicCustom.map(x => x.jamendoId);
                      const sameOrder =
                        localCustomOrder.length === serverIds.length &&
                        localCustomOrder.every((id, idx) => id === serverIds[idx]);
                      if (!sameOrder) mesh.reorderMusicCustom(localCustomOrder);
                    }
                    setDraggingId(null);
                    setLocalCustomOrder(null);
                  }}
                  onDoubleClick={() => playIndex(i)}
                  onClick={() => playIndex(i)}
                  title={`click to play • ${t.src}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: `${isCustomTab ? "14px " : ""}26px 1fr auto 22px`,
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 8px",
                    fontSize: 10,
                    background: active
                      ? "linear-gradient(180deg, rgba(255,62,201,0.35) 0%, rgba(124,77,255,0.25) 100%)"
                      : i % 2 === 0
                        ? "transparent"
                        : "rgba(255,255,255,0.02)",
                    color: active ? "var(--slop-lime, #bcff5b)" : "rgba(188,255,91,0.75)",
                    letterSpacing: "0.04em",
                    opacity: isDraggingRow ? 0.4 : 1,
                    cursor: isCustomTab ? "grab" : "default",
                  }}
                >
                  {isCustomTab ? (
                    <span
                      aria-hidden
                      title="drag to reorder"
                      style={{
                        color: "rgba(255,174,0,0.4)",
                        userSelect: "none",
                        fontSize: 11,
                        lineHeight: 1,
                      }}
                    >
                      ⋮⋮
                    </span>
                  ) : null}
                  <span
                    style={{
                      color: active ? "var(--slop-amber, #ffae00)" : "rgba(255,174,0,0.55)",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}.
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textTransform: "uppercase",
                    }}
                  >
                    {t.artist} - {t.title}
                  </span>
                  <span
                    style={{
                      color: active && playing ? "var(--slop-amber, #ffae00)" : "rgba(255,174,0,0.4)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {active ? fmtTime(duration) : "--:--"}
                  </span>
                  {/* Custom-list mutator. On the Custom tab → [−]
                      removes the track. On any other tab → [+] adds
                      (disabled if already in custom). Stop click +
                      mousedown propagation so the row's "click to
                      play" handler doesn't fire when the user is
                      just managing the list. */}
                  {t.jamendoId ? (
                    isCustomTab ? (
                      <button
                        type="button"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => {
                          e.stopPropagation();
                          if (t.jamendoId) mesh.removeFromMusicCustom(t.jamendoId);
                        }}
                        title="remove from custom"
                        style={customBtnStyle("remove")}
                      >
                        −
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={inCustom}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => {
                          e.stopPropagation();
                          if (inCustom || !t.jamendoId) return;
                          // Narrow Track → JamendoTrack with safe defaults
                          // for any optional fields. We only get here for
                          // tracks that originated from a Jamendo genre, so
                          // the metadata is real; the fallbacks are just
                          // type-system appeasement.
                          mesh.addToMusicCustom({
                            title: t.title,
                            artist: t.artist,
                            src: t.src,
                            duration: t.duration ?? 0,
                            jamendoId: t.jamendoId,
                            license: t.license ?? "",
                            source: t.source ?? "",
                          });
                        }}
                        title={inCustom ? "already in custom" : "add to custom"}
                        style={customBtnStyle(inCustom ? "added" : "add")}
                      >
                        {inCustom ? "✓" : "+"}
                      </button>
                    )
                  ) : (
                    <span aria-hidden style={{ width: 22 }} />
                  )}
                </div>
              );
            })
          )}
        </div>
        {/* Drop hint — overlays the whole playlist panel while a file is
            being dragged. Bright lime border + caption keeps it on-brand
            with the Winamp/CRT look. pointer-events:none so the drag
            events keep bubbling to the panel itself. */}
        {dropHover ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              background: "rgba(124,77,255,0.18)",
              border: "2px dashed var(--slop-lime, #bcff5b)",
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--slop-lime, #bcff5b)",
              fontSize: 11,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              zIndex: 5,
            }}
          >
            drop mp3s to add to custom playlist
          </div>
        ) : null}
        {/* In-flight upload progress — sits above the playlist rows so
            the user sees their file climbing 0→100%, then the new
            track pops into Custom via the mesh broadcast. */}
        {uploadStatus ? (
          <div
            style={{
              position: "absolute",
              left: 8,
              right: 8,
              bottom: 8,
              padding: "6px 8px",
              background: "rgba(0,0,0,0.85)",
              border: "1px solid rgba(188,255,91,0.4)",
              borderRadius: 2,
              fontSize: 9,
              color: "var(--slop-lime, #bcff5b)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              zIndex: 4,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              UPLOADING {uploadStatus.index}/{uploadStatus.total} — {uploadStatus.name}
            </span>
            <LoadingBar
              cells={20}
              progress={uploadStatus.pct * 100}
              style={{ fontSize: 9, color: "var(--slop-lime, #bcff5b)" }}
            />
          </div>
        ) : null}
        {uploadError && !uploadStatus ? (
          <div
            onClick={() => setUploadError(null)}
            style={{
              position: "absolute",
              left: 8,
              right: 8,
              bottom: 8,
              padding: "6px 8px",
              background: "rgba(0,0,0,0.85)",
              border: "1px solid var(--slop-magenta, #ff3ec9)",
              borderRadius: 2,
              fontSize: 9,
              color: "var(--slop-magenta, #ff3ec9)",
              letterSpacing: "0.08em",
              cursor: "pointer",
              zIndex: 4,
            }}
            title="click to dismiss"
          >
            UPLOAD FAILED — {uploadError}
          </div>
        ) : null}
      </div>
    </div>
  );
};

function customBtnStyle(kind: "add" | "added" | "remove"): React.CSSProperties {
  const base: React.CSSProperties = {
    width: 18,
    height: 18,
    padding: 0,
    fontSize: 12,
    lineHeight: "16px",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 3,
    cursor: kind === "added" ? "default" : "pointer",
    fontFamily: "var(--slop-font-display)",
    background: "transparent",
  };
  if (kind === "add") {
    return { ...base, color: "var(--slop-lime, #bcff5b)", borderColor: "rgba(188,255,91,0.4)" };
  }
  if (kind === "added") {
    return { ...base, color: "var(--slop-text-muted)", borderColor: "rgba(255,255,255,0.1)" };
  }
  // remove
  return { ...base, color: "var(--slop-magenta, #ff3ec9)", borderColor: "rgba(255,62,201,0.45)" };
}

// --- Transport button -------------------------------------------------
type Icon = "prev" | "play" | "pause" | "stop" | "next";

const TBtn = ({
  label,
  onClick,
  disabled,
  accent,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  icon: Icon;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    style={{
      width: accent ? 28 : 22,
      height: 18,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: accent
        ? "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim) 100%)"
        : "linear-gradient(180deg, #2a2050 0%, #0a0820 100%)",
      borderTop: "1px solid rgba(255,255,255,0.22)",
      borderLeft: "1px solid rgba(255,255,255,0.22)",
      borderRight: "1px solid #000",
      borderBottom: "1px solid #000",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.45 : 1,
      padding: 0,
    }}
  >
    <Glyph icon={icon} accent={!!accent} />
  </button>
);

const Glyph = ({ icon, accent }: { icon: Icon; accent: boolean }) => {
  const fg = accent ? "#fff" : "var(--slop-lime, #bcff5b)";
  switch (icon) {
    case "play":
      return (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 0,
            height: 0,
            borderLeft: `7px solid ${fg}`,
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            marginLeft: 2,
          }}
        />
      );
    case "pause":
      return (
        <span aria-hidden style={{ display: "inline-flex", gap: 2 }}>
          <span style={{ width: 3, height: 10, background: fg }} />
          <span style={{ width: 3, height: 10, background: fg }} />
        </span>
      );
    case "stop":
      return <span aria-hidden style={{ width: 9, height: 9, background: fg, display: "inline-block" }} />;
    case "prev":
      return (
        <span aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          <span style={{ width: 2, height: 10, background: fg }} />
          <span
            style={{
              width: 0,
              height: 0,
              borderRight: `6px solid ${fg}`,
              borderTop: "5px solid transparent",
              borderBottom: "5px solid transparent",
            }}
          />
        </span>
      );
    case "next":
      return (
        <span aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          <span
            style={{
              width: 0,
              height: 0,
              borderLeft: `6px solid ${fg}`,
              borderTop: "5px solid transparent",
              borderBottom: "5px solid transparent",
            }}
          />
          <span style={{ width: 2, height: 10, background: fg }} />
        </span>
      );
  }
};

// --- Marquee ----------------------------------------------------------
const Marquee = ({ text, color }: { text: string; color: string }) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const measure = () => setOverflow(inner.scrollWidth > wrap.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div
      ref={wrapRef}
      style={{
        overflow: "hidden",
        whiteSpace: "nowrap",
        fontSize: 11,
        color,
        letterSpacing: "0.06em",
        textShadow: `0 0 6px ${color}`,
        textTransform: "uppercase",
      }}
    >
      <div
        ref={innerRef}
        style={{
          display: "inline-block",
          paddingRight: overflow ? 40 : 0,
          animation: overflow ? "slop-music-marquee 14s linear infinite" : "none",
        }}
      >
        {overflow ? `${text}    •    ${text}` : text}
      </div>
    </div>
  );
};

// Tiny speaker glyphs for the per-user mute button. ~14px viewBox so
// they read at 14px target size against either dark or magenta.
const SpeakerIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2 5 H 4 L 7 2.5 V 11.5 L 4 9 H 2 Z" fill="currentColor" stroke="none" />
    <path d="M9 5 Q 10.5 7 9 9" />
    <path d="M10.5 3.5 Q 13 7 10.5 10.5" />
  </svg>
);

const SpeakerOffIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2 5 H 4 L 7 2.5 V 11.5 L 4 9 H 2 Z" fill="currentColor" stroke="none" />
    <line x1="9" y1="4.5" x2="13" y2="9.5" />
    <line x1="13" y1="4.5" x2="9" y2="9.5" />
  </svg>
);

export default MusicPlayerWindow;
