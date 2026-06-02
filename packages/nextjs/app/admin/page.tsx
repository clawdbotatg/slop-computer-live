"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { Address as AddressType } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { Bevel, Button, Cursor, DesktopBackground, MenuBar, TextField } from "~~/components/ui";
import { useLocalCursor } from "~~/hooks/useLocalCursor";
import { DEFAULT_SLUG } from "~~/lib/slug";
import { bandsFromIdentity } from "~~/utils/blockieBands";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const FRONTPAGE_ADDRESS = process.env.NEXT_PUBLIC_FRONTPAGE_ADDRESS ?? "";

// Services we surface in the admin "Services" panel. Each one optionally
// has a healthUrl (for live status + metadata). For URLs we can't probe
// from the browser (CORS or no /health route), we still render the row
// with a clickable link and an "n/a" status.
type ServiceDef = {
  id: string;
  label: string;
  url: string;
  healthUrl?: string;
  // Format the JSON the /health endpoint returns into a one-line meta.
  formatMeta?: (data: Record<string, unknown>) => string;
};

const SERVICES: ServiceDef[] = [
  {
    id: "relay",
    label: "Relay",
    url: "https://relay.slop.computer/health",
    healthUrl: "https://relay.slop.computer/health",
    formatMeta: d => {
      const peers = typeof d.peers === "number" ? d.peers : 0;
      return `${peers} peer${peers === 1 ? "" : "s"}`;
    },
  },
  {
    id: "browser-host",
    label: "Browser host",
    url: "https://browser.slop.computer/health",
    healthUrl: "https://browser.slop.computer/health",
    formatMeta: d => {
      const tabs = typeof d.tabs === "number" ? d.tabs : 0;
      const impersonating = typeof d.impersonating === "string" ? d.impersonating.slice(0, 6) + "…" : "—";
      return `${tabs} tab${tabs === 1 ? "" : "s"} · ${impersonating}`;
    },
  },
  {
    id: "media",
    label: "MediaMTX (HLS)",
    url: "https://media.slop.computer/hls/live/index.m3u8",
    // No /health endpoint and CORS is unset on MediaMTX, so we can't probe
    // status reliably from the browser. Link only.
  },
  {
    id: "frontpage",
    label: "Frontpage (audience)",
    url: "https://slop.computer/",
  },
  {
    id: "live",
    label: "Live desktop",
    url: "https://live.slop.computer/",
  },
];

const ETHERSCAN = (addr: string) => `https://etherscan.io/address/${addr}`;

type ServiceStatus = "checking" | "up" | "down" | "n/a";
type ServiceState = { status: ServiceStatus; meta?: string };

type AuthState =
  | { authenticated: false }
  | { authenticated: true; role: string; address: string | null; handle: string | null };

type Peer = {
  id: string;
  role: string;
  address: string | null;
  handle: string | null;
  connectedAt?: number;
  slug?: string;
  spectator?: boolean;
  mobileMode?: boolean;
};

// Both god-mode and mobile-mode peers join as role "guest" with
// `spectator` set; only mobile-mode also carries `mobileMode`. Surface
// the real flavor so the admin list doesn't collapse them all to "guest".
const peerMode = (p: Peer): string => {
  if (p.mobileMode) return "mobileMode";
  if (p.spectator) return "godMode";
  return p.role;
};

const formatConnectedAt = (ts?: number) => {
  if (!ts) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
};

// 12 random bytes → ~16 URL-safe chars. Strong enough for a shareable
// room password (collision-resistant, not predictable from prior keys).
const generatePassword = () => {
  if (typeof window === "undefined" || !window.crypto?.getRandomValues) return "";
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const AdminPage: NextPage = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [auth, setAuth] = useState<AuthState>({ authenticated: false });
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<string>("");
  // Per-room password creation state (Phase 5). Filled in by the host
  // when claiming a new slug; on submit we POST /v1/rooms which hashes
  // the password on the relay and stores it under
  // .slop-data/rooms/<slug>/auth.json.
  const [newRoomSlug, setNewRoomSlug] = useState("");
  const [newRoomPassword, setNewRoomPassword] = useState("");
  const [createRoomStatus, setCreateRoomStatus] = useState<string>("");
  // List of every claimed room on disk (slug + hot flag). The relay
  // serves slug + metadata only; passwords are stored only as scrypt
  // hashes, so we remember plaintext passwords locally on this admin's
  // browser (see `roomPasswords` below) to make the "copy link with
  // password" affordance work.
  type AdminRoom = {
    slug: string;
    createdAt: number | null;
    paidUntil: number | null;
    hot: boolean;
    sttOn: boolean;
  };
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  // Per-slug remembered plaintext password — populated when the admin
  // creates or rotates a room in this browser. Stored under
  // `slop-admin-room-passwords` localStorage so it persists across
  // reloads. Never sent to the server; lookup-only on this device.
  const ADMIN_PW_KEY = "slop-admin-room-passwords";
  const readAdminPasswords = (): Record<string, string> => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem(ADMIN_PW_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  };
  const writeAdminPasswords = (next: Record<string, string>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ADMIN_PW_KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode */
    }
  };
  const [roomPasswords, setRoomPasswords] = useState<Record<string, string>>({});
  const [copyStatus, setCopyStatus] = useState<string>("");
  // GOD_MODE_PASSWORD plaintext from the relay (host-only endpoint). Null
  // when the env var isn't set — the [god] affordance is hidden in that
  // case rather than producing a link that'll fail at /auth/godmode.
  const [godPassword, setGodPassword] = useState<string | null>(null);
  // Same shape as godPassword — null when MOBILE_MODE_PASSWORD isn't
  // set on the relay (collapses the [mobile] link affordance).
  const [mobilePassword, setMobilePassword] = useState<string | null>(null);
  const rememberRoomPassword = (slug: string, password: string) => {
    const next = { ...readAdminPasswords(), [slug]: password };
    writeAdminPasswords(next);
    setRoomPasswords(next);
  };
  const forgetRoomPassword = (slug: string) => {
    const next = { ...readAdminPasswords() };
    if (!(slug in next)) return;
    delete next[slug];
    writeAdminPasswords(next);
    setRoomPasswords(next);
  };

  useEffect(() => {
    if (!mounted) return;
    fetch(`${RELAY_BASE}/auth/me`, { credentials: "include" })
      .then(r => r.json())
      .then((data: AuthState) => setAuth(data))
      .catch(() => setAuth({ authenticated: false }));
  }, [mounted]);

  const createRoom = async () => {
    setCreateRoomStatus("");
    const slug = newRoomSlug.trim();
    const password = newRoomPassword.trim();
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
      setCreateRoomStatus("slug must match ^[a-z0-9-]{1,64}$");
      return;
    }
    if (!password) {
      setCreateRoomStatus("password required");
      return;
    }
    try {
      const res = await fetch(`${RELAY_BASE}/v1/rooms`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, password }),
      });
      if (res.ok) {
        setCreateRoomStatus(`created /${slug} ✓`);
        rememberRoomPassword(slug, password);
        setNewRoomSlug("");
        setNewRoomPassword(generatePassword());
        void fetchRooms();
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (j.error === "room-already-exists") {
        setCreateRoomStatus("a room with that slug already exists");
      } else {
        setCreateRoomStatus(j.error ?? `error ${res.status}`);
      }
    } catch (e) {
      setCreateRoomStatus((e as Error).message || "network error");
    }
  };

  const isHost = auth.authenticated && auth.role === "host";

  useEffect(() => {
    if (!isHost) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${RELAY_BASE}/admin/peers`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPeers(data.peers ?? []);
      } catch {
        /* relay offline — leave list empty */
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [isHost]);

  const fetchRooms = async () => {
    try {
      const res = await fetch(`${RELAY_BASE}/admin/rooms`, { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { rooms?: AdminRoom[] };
      if (Array.isArray(data.rooms)) setRooms(data.rooms);
    } catch {
      /* relay offline — leave list as-is */
    }
  };

  useEffect(() => {
    if (!mounted) return;
    setRoomPasswords(readAdminPasswords());
  }, [mounted]);

  // Seed a random password as soon as we mount so the URL preview is
  // populated from the start; the user can hit Regenerate to roll it.
  useEffect(() => {
    if (!mounted) return;
    if (newRoomPassword) return;
    setNewRoomPassword(generatePassword());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const newRoomUrl = useMemo(() => {
    if (!mounted) return "";
    const slug = newRoomSlug.trim() || "<slug>";
    const base = `${window.location.origin}/${slug}`;
    return newRoomPassword ? `${base}?invite=${encodeURIComponent(newRoomPassword)}` : base;
  }, [mounted, newRoomSlug, newRoomPassword]);

  useEffect(() => {
    if (!isHost) return;
    void fetchRooms();
    const t = setInterval(() => void fetchRooms(), 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost]);

  // Pull the GOD_MODE_PASSWORD from the relay once when the host signs in.
  // Plain GET — the relay returns null when unset, which collapses the
  // [god] link affordance below.
  useEffect(() => {
    if (!isHost) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${RELAY_BASE}/admin/god-password`, { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { password?: string | null };
        if (!cancelled) setGodPassword(data.password ?? null);
      } catch {
        /* relay offline — leave god link hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isHost]);

  // Same fetch shape for MOBILE_MODE_PASSWORD — drives the [mobile]
  // copy-link affordance below the [god] one.
  useEffect(() => {
    if (!isHost) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${RELAY_BASE}/admin/mobile-password`, { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { password?: string | null };
        if (!cancelled) setMobilePassword(data.password ?? null);
      } catch {
        /* relay offline — leave mobile link hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isHost]);

  const rotateRoomPassword = async (slug: string, newPassword: string) => {
    setCopyStatus("");
    if (!newPassword) {
      setCopyStatus("password required");
      return false;
    }
    try {
      const res = await fetch(`${RELAY_BASE}/v1/rooms/${encodeURIComponent(slug)}/password`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setCopyStatus(j.error ?? `error ${res.status}`);
        return false;
      }
      rememberRoomPassword(slug, newPassword);
      setCopyStatus(`rotated /${slug} ✓`);
      return true;
    } catch (e) {
      setCopyStatus((e as Error).message || "network error");
      return false;
    }
  };

  const copyRoomLink = async (slug: string) => {
    if (typeof window === "undefined") return;
    const password = roomPasswords[slug];
    const base = `${window.location.origin}/${slug}`;
    const url = password ? `${base}?invite=${encodeURIComponent(password)}` : base;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus(password ? `copied /${slug} link with password ✓` : `copied /${slug} link ✓`);
    } catch {
      setCopyStatus("clipboard blocked — copy manually");
    }
  };

  // Copy the spectator/streaming-box link: room password (so the gate
  // clears) + godMode password (so /auth/godmode mints a spectator
  // session on top). The relay's /auth/godmode requires a valid
  // per-room cookie first, which `invite=` provides on landing.
  const copyGodLink = async (slug: string) => {
    if (typeof window === "undefined") return;
    if (!godPassword) {
      setCopyStatus("god mode not configured on the relay (GOD_MODE_PASSWORD unset)");
      return;
    }
    const roomPw = roomPasswords[slug];
    if (!roomPw) {
      setCopyStatus(`no room password remembered for /${slug} — regenerate it first`);
      return;
    }
    const base = `${window.location.origin}/${slug}`;
    const url = `${base}?invite=${encodeURIComponent(roomPw)}&godMode=${encodeURIComponent(godPassword)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus(`copied /${slug} god-mode link ✓`);
    } catch {
      setCopyStatus("clipboard blocked — copy manually");
    }
  };

  // Mirror of copyGodLink for the portrait clip-recording stage. Same
  // two-step gate (`invite=` clears the room cookie, `mobileMode=`
  // mints the MobileStage session on top). See ops/PLAN-mobile-mode.md.
  const copyMobileLink = async (slug: string) => {
    if (typeof window === "undefined") return;
    if (!mobilePassword) {
      setCopyStatus("mobile mode not configured on the relay (MOBILE_MODE_PASSWORD unset)");
      return;
    }
    const roomPw = roomPasswords[slug];
    if (!roomPw) {
      setCopyStatus(`no room password remembered for /${slug} — regenerate it first`);
      return;
    }
    const base = `${window.location.origin}/${slug}`;
    const url = `${base}?invite=${encodeURIComponent(roomPw)}&mobileMode=${encodeURIComponent(mobilePassword)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus(`copied /${slug} mobile link ✓`);
    } catch {
      setCopyStatus("clipboard blocked — copy manually");
    }
  };

  // One-click password rotation. Generates a fresh URL-safe random
  // password, POSTs it to the relay, and remembers it locally so the
  // shareable copy-link affordance keeps working without the host
  // having to type anything.
  const regenerateRoomPassword = async (slug: string) => {
    const next = generatePassword();
    if (!next) return;
    await rotateRoomPassword(slug, next);
  };

  // Flip per-room STT on/off. Optimistically updates the local rooms
  // list so the toggle button reflects instantly; the next poll round-
  // trips for consistency.
  const toggleRoomStt = async (slug: string, on: boolean) => {
    setCopyStatus("");
    setRooms(prev => prev.map(r => (r.slug === slug ? { ...r, sttOn: on } : r)));
    try {
      const res = await fetch(`${RELAY_BASE}/admin/episode/stt?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setCopyStatus(`STT toggle failed: ${j.error ?? res.status}`);
        void fetchRooms();
        return;
      }
      setCopyStatus(`/${slug} STT ${on ? "on" : "off"} ✓`);
    } catch (e) {
      setCopyStatus((e as Error).message || "network error");
      void fetchRooms();
    }
  };

  // Wipes a room's transcript archive (the per-slug /admin/transcript
  // endpoint nukes both the rolling buffer and the persisted JSONL).
  // Two-click arming so a hand-twitch doesn't lose data.
  const [transcriptResetArmed, setTranscriptResetArmed] = useState<string | null>(null);
  const transcriptResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetRoomTranscript = async (slug: string) => {
    if (transcriptResetArmed !== slug) {
      setTranscriptResetArmed(slug);
      if (transcriptResetTimer.current) clearTimeout(transcriptResetTimer.current);
      transcriptResetTimer.current = setTimeout(() => setTranscriptResetArmed(null), 4000);
      return;
    }
    if (transcriptResetTimer.current) clearTimeout(transcriptResetTimer.current);
    setTranscriptResetArmed(null);
    setCopyStatus("");
    try {
      const res = await fetch(`${RELAY_BASE}/admin/transcript?slug=${encodeURIComponent(slug)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as { clearedCount?: number; error?: string } | null;
      if (!res.ok) {
        setCopyStatus(`reset failed: ${data?.error ?? res.statusText}`);
        return;
      }
      setCopyStatus(`/${slug} transcript reset (${data?.clearedCount ?? 0} segments) ✓`);
    } catch (e) {
      setCopyStatus((e as Error).message || "network error");
    }
  };

  // Two-stage room delete/clear: clicking "Delete" or "Clear" opens a
  // modal that requires the host to type the slug exactly before the
  // destructive request fires. The server re-validates the typed slug
  // to defend against an accidental click in a misconfigured client.
  // "Clear" hits a different endpoint that allows DEFAULT_SLUG (the
  // room respawns empty on next access).
  type PendingAction = "delete" | "clear";
  const [pendingAction, setPendingAction] = useState<PendingAction>("delete");
  const [deletePendingSlug, setDeletePendingSlug] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState<string>("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const openDeleteModal = (slug: string) => {
    setPendingAction("delete");
    setDeletePendingSlug(slug);
    setDeleteConfirmText("");
  };
  const openClearModal = (slug: string) => {
    setPendingAction("clear");
    setDeletePendingSlug(slug);
    setDeleteConfirmText("");
  };
  const closeDeleteModal = () => {
    if (deleteBusy) return;
    setDeletePendingSlug(null);
    setDeleteConfirmText("");
  };
  const deleteRoom = async (slug: string) => {
    setCopyStatus("");
    setDeleteBusy(true);
    try {
      const res = await fetch(`${RELAY_BASE}/admin/rooms/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: slug }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setCopyStatus(`delete failed: ${data?.error ?? res.statusText}`);
        return;
      }
      forgetRoomPassword(slug);
      setRooms(prev => prev.filter(r => r.slug !== slug));
      setDeletePendingSlug(null);
      setDeleteConfirmText("");
      setCopyStatus(`/${slug} deleted ✓`);
      void fetchRooms();
    } catch (e) {
      setCopyStatus((e as Error).message || "network error");
    } finally {
      setDeleteBusy(false);
    }
  };
  const clearRoom = async (slug: string) => {
    setCopyStatus("");
    setDeleteBusy(true);
    try {
      const res = await fetch(`${RELAY_BASE}/admin/rooms/${encodeURIComponent(slug)}/clear`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: slug }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setCopyStatus(`clear failed: ${data?.error ?? res.statusText}`);
        return;
      }
      setDeletePendingSlug(null);
      setDeleteConfirmText("");
      setCopyStatus(`/${slug} cleared ✓`);
      void fetchRooms();
    } catch (e) {
      setCopyStatus((e as Error).message || "network error");
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleSiwe = async () => {
    if (!address) return;
    setStatus("Requesting nonce...");
    try {
      const nonceRes = await fetch(`${RELAY_BASE}/auth/siwe/nonce`).then(r => r.json());
      const nonce: string = nonceRes.nonce;
      const domain = window.location.host;
      const uri = window.location.origin;
      const issuedAt = new Date().toISOString();
      const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        address,
        ``,
        `Sign in to slop-computer-live admin.`,
        ``,
        `URI: ${uri}`,
        `Version: 1`,
        `Chain ID: 1`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
      ].join("\n");
      setStatus("Awaiting signature...");
      const signature = await signMessageAsync({ message });
      setStatus("Verifying...");
      const verifyRes = await fetch(`${RELAY_BASE}/auth/siwe`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature, nonce }),
      });
      const data = await verifyRes.json();
      if (!verifyRes.ok) {
        setStatus(`Auth failed: ${data.error ?? verifyRes.statusText}`);
        return;
      }
      setAuth({ authenticated: true, role: data.role, address: data.address, handle: null });
      setStatus(data.isAdmin ? "Signed in as host." : "Signed in (not on the admin allowlist).");
    } catch (err) {
      setStatus(`Auth error: ${(err as Error).message}`);
    }
  };

  const kickPeer = async (id: string) => {
    try {
      const res = await fetch(`${RELAY_BASE}/admin/kick`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus(`kick failed: ${data.error ?? res.statusText}`);
        return;
      }
      setPeers(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      setStatus(`kick failed: ${(err as Error).message}`);
    }
  };

  type StreamSession = {
    rtmpUrl: string;
    streamKey: string;
    hlsUrl: string;
  };
  type Fanout = {
    id: "youtube" | "twitch" | "twitter" | "kick";
    name: string;
    configured: boolean;
    running: boolean;
    startedAt?: string;
  };
  const [stream, setStream] = useState<StreamSession | null>(null);
  const [fanouts, setFanouts] = useState<Fanout[]>([]);
  const [fanoutBusy, setFanoutBusy] = useState<string | null>(null);

  // ---- Services health -----------------------------------------------------
  // Poll each /health URL every 5s. Services without a healthUrl render as
  // "n/a" (link-only). A failed fetch (CORS, network, 5xx) → "down".
  const [serviceStates, setServiceStates] = useState<Record<string, ServiceState>>(() => {
    const init: Record<string, ServiceState> = {};
    for (const s of SERVICES) init[s.id] = { status: s.healthUrl ? "checking" : "n/a" };
    return init;
  });
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    const probe = async (svc: ServiceDef): Promise<ServiceState> => {
      if (!svc.healthUrl) return { status: "n/a" };
      try {
        const res = await fetch(svc.healthUrl, { cache: "no-store" });
        if (!res.ok) return { status: "down", meta: `HTTP ${res.status}` };
        const data = (await res.json()) as Record<string, unknown>;
        return { status: "up", meta: svc.formatMeta?.(data) };
      } catch (err) {
        return { status: "down", meta: (err as Error).message };
      }
    };
    const tick = async () => {
      const results = await Promise.all(SERVICES.map(async svc => [svc.id, await probe(svc)] as const));
      if (cancelled) return;
      setServiceStates(prev => {
        const next = { ...prev };
        for (const [id, state] of results) next[id] = state;
        return next;
      });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [mounted]);

  useEffect(() => {
    if (!isHost) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${RELAY_BASE}/admin/fanouts`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setFanouts(data.fanouts ?? []);
      } catch {
        /* relay offline — leave list empty */
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [isHost]);

  const toggleFanout = async (id: string, action: "start" | "stop") => {
    setFanoutBusy(id);
    try {
      const res = await fetch(`${RELAY_BASE}/admin/fanouts/${id}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`fanout ${action} failed: ${data.error ?? res.statusText}`);
      } else if (data.fanouts) {
        setFanouts(data.fanouts);
      }
    } catch (err) {
      setStatus(`fanout ${action} failed: ${(err as Error).message}`);
    } finally {
      setFanoutBusy(null);
    }
  };

  const handleGetRtmpInfo = async () => {
    setStatus("Fetching RTMP credentials...");
    try {
      const res = await fetch(`${RELAY_BASE}/admin/start`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`relay /admin/start failed: ${data.error ?? res.statusText}`);
        return;
      }
      setStream(data as StreamSession);
      setStatus(
        "Got RTMP credentials. Paste into OBS and start streaming. Then go to slop.computer/admin to flip the on-chain registry.",
      );
    } catch (err) {
      setStatus(`fetch failed: ${(err as Error).message}`);
    }
  };

  const heading = (
    <h1
      style={{
        fontFamily: "var(--slop-font-display)",
        fontSize: 22,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        margin: 0,
      }}
    >
      Admin
    </h1>
  );

  const landing = (
    <Bevel style={{ padding: 16, maxWidth: 520 }}>
      <h2
        style={{
          margin: 0,
          fontFamily: "var(--slop-font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Admin sign-in
      </h2>
      <p style={{ color: "var(--slop-text-muted)", marginTop: 8 }}>This wallet must be on the admin allowlist.</p>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
        {mounted && isConnected ? (
          <>
            <p style={{ margin: 0, color: "var(--slop-text-muted)" }}>
              Connected as <code>{address}</code>.
            </p>
            <Button variant="primary" onClick={handleSiwe}>
              Sign-In with Ethereum
            </Button>
          </>
        ) : (
          <RainbowKitCustomConnectButton />
        )}
      </div>
    </Bevel>
  );

  const adminPanel = (
    <>
      <Bevel style={{ padding: 16, maxWidth: 960 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 0 }}>
          <span>Authenticated as</span>
          {auth.authenticated && auth.address ? (
            <Address address={auth.address as AddressType} size="sm" />
          ) : (
            <code>—</code>
          )}
          <span>({auth.authenticated ? auth.role : ""})</span>
          {!isHost && <span style={{ color: "var(--slop-text-muted)" }}>— not on the admin allowlist.</span>}
        </div>
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 960 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Create a room</h2>
        <p style={{ color: "var(--slop-text-muted)", margin: "6px 0 12px", fontSize: 12 }}>
          Type a slug — the password is randomized for you and the shareable URL is previewed below. Hit{" "}
          <em>Regenerate</em> to roll a new one, then <em>Create</em> to claim it.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <TextField
            placeholder="slug (e.g. ep0)"
            value={newRoomSlug}
            onChange={e => setNewRoomSlug(e.target.value.toLowerCase())}
            style={{ minWidth: 180 }}
          />
          <Button onClick={() => setNewRoomPassword(generatePassword())}>Regenerate</Button>
          <Button variant="primary" onClick={createRoom}>
            Create
          </Button>
        </div>
        <p
          style={{
            marginTop: 10,
            fontSize: 12,
            color: "var(--slop-text-muted)",
            fontFamily: "monospace",
            wordBreak: "break-all",
            background: "rgba(8,4,18,0.35)",
            padding: "6px 8px",
            border: "1px solid var(--slop-bevel-dark)",
          }}
        >
          {newRoomUrl}
        </p>
        {createRoomStatus ? (
          <p
            style={{
              marginTop: 8,
              fontSize: 12,
              color: createRoomStatus.endsWith("✓") ? "var(--slop-lime, #b4ff3a)" : "var(--slop-magenta, #ff3ec9)",
            }}
          >
            {createRoomStatus}
          </p>
        ) : null}
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 1280 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Rooms</h2>
        <p style={{ color: "var(--slop-text-muted)", fontSize: 12, margin: "6px 0 12px" }}>
          Every claimed room on disk. The relay only stores scrypt hashes, so <em>Copy link</em> embeds the password
          only for rooms whose plaintext is remembered locally (created or regenerated in this browser). <em>[god]</em>{" "}
          next to the slug copies the same link with <code>godMode</code> appended for the streaming box.
        </p>
        {rooms.length === 0 ? (
          <p style={{ color: "var(--slop-text-muted)", fontSize: 12, margin: 0 }}>
            No claimed rooms yet. Create one above to get started.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rooms.map(r => (
              <div
                key={r.slug}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "6px 10px",
                  border: "1px solid var(--slop-bevel-shadow)",
                  background: "rgba(8,4,18,0.35)",
                }}
              >
                <span
                  aria-label={r.hot ? "hot" : "cold"}
                  title={r.hot ? "hot" : "cold"}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: r.hot ? "var(--slop-lime, #b4ff3a)" : "var(--slop-text-muted)",
                    boxShadow: r.hot ? "0 0 6px var(--slop-lime, #b4ff3a)" : "none",
                    flex: "0 0 auto",
                  }}
                />
                <a
                  href={`/${r.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: "var(--slop-font-display)", textTransform: "lowercase", minWidth: 0 }}
                >
                  /{r.slug}
                </a>
                <button
                  type="button"
                  onClick={() => void copyGodLink(r.slug)}
                  className="slop-link"
                  title={
                    !godPassword
                      ? "GOD_MODE_PASSWORD not set on the relay"
                      : !roomPasswords[r.slug]
                        ? "regenerate this room's password first so the link can embed it"
                        : "copy god-mode link (room password + GOD_MODE_PASSWORD inline)"
                  }
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    margin: 0,
                    fontFamily: "var(--slop-font-display)",
                    textTransform: "lowercase",
                    cursor: "pointer",
                    opacity: godPassword && roomPasswords[r.slug] ? 1 : 0.5,
                  }}
                >
                  [god]
                </button>
                <button
                  type="button"
                  onClick={() => void copyMobileLink(r.slug)}
                  className="slop-link"
                  title={
                    !mobilePassword
                      ? "MOBILE_MODE_PASSWORD not set on the relay"
                      : !roomPasswords[r.slug]
                        ? "regenerate this room's password first so the link can embed it"
                        : "copy mobile-stage link (portrait clip recording layout)"
                  }
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    margin: 0,
                    fontFamily: "var(--slop-font-display)",
                    textTransform: "lowercase",
                    cursor: "pointer",
                    opacity: mobilePassword && roomPasswords[r.slug] ? 1 : 0.5,
                  }}
                >
                  [mobile]
                </button>
                <a
                  href={`https://slop.computer/admin?liveSlugToSchedule=${encodeURIComponent(r.slug)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="slop-link"
                  title="open the frontpage scheduler with this slug preloaded"
                  style={{
                    fontFamily: "var(--slop-font-display)",
                    textTransform: "lowercase",
                  }}
                >
                  [schedule]
                </a>
                {r.slug === DEFAULT_SLUG ? (
                  <button
                    type="button"
                    onClick={() => openClearModal(r.slug)}
                    className="slop-link"
                    title="wipe this room's storage and respawn it empty"
                    style={{
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      margin: 0,
                      fontFamily: "var(--slop-font-display)",
                      textTransform: "lowercase",
                      cursor: "pointer",
                      color: "var(--slop-accent-warn, #c33)",
                    }}
                  >
                    [clear]
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openDeleteModal(r.slug)}
                    className="slop-link"
                    title="permanently delete this room (in-memory + on-disk)"
                    style={{
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      margin: 0,
                      fontFamily: "var(--slop-font-display)",
                      textTransform: "lowercase",
                      cursor: "pointer",
                      color: "var(--slop-accent-warn, #c33)",
                    }}
                  >
                    [delete]
                  </button>
                )}
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontFamily: "var(--slop-font-display)",
                    textTransform: "uppercase",
                    color: "var(--slop-text-muted)",
                    fontSize: 12,
                  }}
                >
                  STT:
                </span>
                <Button
                  onClick={() => void toggleRoomStt(r.slug, !r.sttOn)}
                  style={
                    r.sttOn
                      ? { background: "var(--slop-magenta, #ff3ec9)", color: "var(--slop-bg, #06030d)" }
                      : undefined
                  }
                  title={r.sttOn ? "transcripts ON" : "transcripts OFF"}
                >
                  {r.sttOn ? "On" : "Off"}
                </Button>
                <Button
                  onClick={() => void resetRoomTranscript(r.slug)}
                  style={
                    transcriptResetArmed === r.slug
                      ? { background: "var(--slop-accent-warn, #c33)", color: "#fff" }
                      : undefined
                  }
                  title="wipe this room's transcript archive"
                >
                  {transcriptResetArmed === r.slug ? "Confirm" : "Reset"}
                </Button>
                {r.slug === DEFAULT_SLUG ? null : (
                  <>
                    <span
                      style={{
                        fontFamily: "var(--slop-font-display)",
                        textTransform: "uppercase",
                        color: "var(--slop-text-muted)",
                        fontSize: 12,
                        marginLeft: 6,
                      }}
                    >
                      PASS:
                    </span>
                    <Button onClick={() => void regenerateRoomPassword(r.slug)}>Regen</Button>
                  </>
                )}
                <span
                  style={{
                    fontFamily: "var(--slop-font-display)",
                    textTransform: "uppercase",
                    color: "var(--slop-text-muted)",
                    fontSize: 12,
                    marginLeft: 6,
                  }}
                >
                  LINK:
                </span>
                <Button variant="primary" onClick={() => void copyRoomLink(r.slug)}>
                  Copy
                </Button>
              </div>
            ))}
          </div>
        )}
        {copyStatus ? (
          <p
            style={{
              marginTop: 12,
              fontSize: 12,
              color: copyStatus.endsWith("✓") ? "var(--slop-lime, #b4ff3a)" : "var(--slop-magenta, #ff3ec9)",
            }}
          >
            {copyStatus}
          </p>
        ) : null}
      </Bevel>

      {deletePendingSlug ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={closeDeleteModal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: 480, width: "92%" }}>
            <Bevel style={{ padding: 18 }}>
              <h2
                style={{
                  margin: 0,
                  fontFamily: "var(--slop-font-display)",
                  textTransform: "uppercase",
                  color: "var(--slop-magenta, #ff3ec9)",
                }}
              >
                {pendingAction === "clear" ? "Clear" : "Delete"} /{deletePendingSlug}?
              </h2>
              <p style={{ fontSize: 13, margin: "10px 0", color: "var(--slop-text-muted)" }}>
                {pendingAction === "clear" ? (
                  <>
                    This kicks every live peer, tells browser-host to drop its context, and removes{" "}
                    <code>.slop-data/rooms/{deletePendingSlug}</code> from disk. The room respawns empty on next visit.
                  </>
                ) : (
                  <>
                    This <strong>permanently</strong> kicks every live peer, tells browser-host to drop its context, and
                    removes <code>.slop-data/rooms/{deletePendingSlug}</code> from disk. There is no undo.
                  </>
                )}
              </p>
              <p style={{ fontSize: 12, margin: "8px 0 6px" }}>
                Type <code>{deletePendingSlug}</code> below to confirm:
              </p>
              <TextField
                placeholder={deletePendingSlug}
                value={deleteConfirmText}
                onChange={e => setDeleteConfirmText(e.target.value)}
                autoFocus
                style={{ width: "100%" }}
                disabled={deleteBusy}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <Button onClick={closeDeleteModal} disabled={deleteBusy}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    void (pendingAction === "clear" ? clearRoom(deletePendingSlug) : deleteRoom(deletePendingSlug))
                  }
                  disabled={deleteBusy || deleteConfirmText !== deletePendingSlug}
                  style={
                    deleteConfirmText === deletePendingSlug && !deleteBusy
                      ? { background: "var(--slop-accent-warn, #c33)", color: "#fff" }
                      : undefined
                  }
                >
                  {deleteBusy
                    ? pendingAction === "clear"
                      ? "Clearing…"
                      : "Deleting…"
                    : pendingAction === "clear"
                      ? "Clear room"
                      : "Delete forever"}
                </Button>
              </div>
            </Bevel>
          </div>
        </div>
      ) : null}

      <Bevel style={{ padding: 16, maxWidth: 960 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
          Restream destinations
        </h2>
        <p style={{ color: "var(--slop-text-muted)", margin: "6px 0 12px" }}>
          OBS pushes once to slop.computer. The relay re-publishes to each enabled destination with{" "}
          <code>ffmpeg -c copy</code>. Stream keys live in the relay env, never in the browser.
        </p>
        {fanouts.length === 0 ? (
          <p style={{ color: "var(--slop-text-muted)", fontSize: 12 }}>
            No destinations available — relay isn&apos;t responding.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {fanouts.map(f => (
              <div
                key={f.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 12px",
                  border: "1px solid var(--slop-bevel-dark)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <span
                    style={{
                      padding: "2px 8px",
                      fontSize: 10,
                      fontFamily: "var(--slop-font-display)",
                      letterSpacing: "0.05em",
                      color: f.running ? "#fff" : "var(--slop-text-muted)",
                      background: f.running ? "var(--slop-magenta, #ff3ec9)" : "transparent",
                      border: f.running ? "0" : "1px solid var(--slop-bevel-dark)",
                      minWidth: 60,
                      textAlign: "center",
                    }}
                  >
                    {f.running ? "LIVE" : f.configured ? "OFF" : "UNCONFIGURED"}
                  </span>
                  <span style={{ fontWeight: 600 }}>{f.name}</span>
                  {f.startedAt ? (
                    <span style={{ color: "var(--slop-text-muted)", fontSize: 11 }}>
                      since {new Date(f.startedAt).toLocaleTimeString()}
                    </span>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {f.configured ? (
                    f.running ? (
                      <Button onClick={() => toggleFanout(f.id, "stop")} disabled={fanoutBusy === f.id}>
                        Stop
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={() => toggleFanout(f.id, "start")}
                        disabled={fanoutBusy === f.id}
                      >
                        Start
                      </Button>
                    )
                  ) : (
                    <span style={{ color: "var(--slop-text-muted)", fontSize: 11 }}>set key in relay env</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 960 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Services</h2>
        <p style={{ color: "var(--slop-text-muted)", margin: "6px 0 12px", fontSize: 12 }}>
          live status · refreshes every 5s
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {SERVICES.map(svc => {
            const state = serviceStates[svc.id] ?? { status: "checking" as ServiceStatus };
            const dotColor =
              state.status === "up"
                ? "#22c55e"
                : state.status === "down"
                  ? "#ef4444"
                  : state.status === "checking"
                    ? "#eab308"
                    : "var(--slop-text-muted)";
            return (
              <a
                key={svc.id}
                href={svc.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "grid",
                  gridTemplateColumns: "16px 160px 1fr 16px",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  border: "1px solid var(--slop-bevel-dark)",
                  textDecoration: "none",
                  color: "inherit",
                  fontFamily: "var(--slop-font-body)",
                  fontSize: 13,
                }}
              >
                <span
                  aria-label={state.status}
                  title={state.status}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: dotColor,
                    boxShadow: state.status === "up" ? `0 0 6px ${dotColor}` : "none",
                  }}
                />
                <span style={{ fontWeight: 600 }}>{svc.label}</span>
                <span
                  style={{
                    color: "var(--slop-text-muted)",
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {state.meta ?? svc.url.replace(/^https?:\/\//, "")}
                </span>
                <span aria-hidden style={{ color: "var(--slop-text-muted)" }}>
                  ↗
                </span>
              </a>
            );
          })}
          {FRONTPAGE_ADDRESS ? (
            <a
              href={ETHERSCAN(FRONTPAGE_ADDRESS)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "grid",
                gridTemplateColumns: "16px 160px 1fr 16px",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                border: "1px solid var(--slop-bevel-dark)",
                textDecoration: "none",
                color: "inherit",
                fontFamily: "var(--slop-font-body)",
                fontSize: 13,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--slop-magenta, #ff3ec9)",
                  boxShadow: "0 0 6px var(--slop-magenta, #ff3ec9)",
                }}
              />
              <span style={{ fontWeight: 600 }}>Frontpage contract</span>
              <span style={{ color: "var(--slop-text-muted)", fontSize: 11, fontFamily: "monospace" }}>
                {FRONTPAGE_ADDRESS.slice(0, 10)}…{FRONTPAGE_ADDRESS.slice(-4)} · mainnet
              </span>
              <span aria-hidden style={{ color: "var(--slop-text-muted)" }}>
                ↗
              </span>
            </a>
          ) : null}
        </div>
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 960 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Broadcast</h2>
        <p style={{ color: "var(--slop-text-muted)", margin: "6px 0 12px" }}>
          1. Click <strong>Set up OBS</strong> to fetch RTMP credentials. 2. Paste the URL + key into OBS, set the
          Browser Source to <code>https://live.slop.computer/desktop</code>, and start streaming. 3. Go to{" "}
          <a href="https://slop.computer/admin" target="_blank" rel="noreferrer" className="slop-link">
            slop.computer/admin
          </a>{" "}
          to flip the on-chain registry — the homepage&apos;s LIVE banner + HLS player read from there.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <Button variant="primary" onClick={handleGetRtmpInfo} disabled={!isHost}>
            Set up OBS
          </Button>
        </div>

        {stream ? (
          <div
            style={{
              padding: 12,
              background: "var(--slop-bevel-dark)",
              fontFamily: "var(--slop-font-body)",
              fontSize: 13,
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 12,
              rowGap: 6,
              wordBreak: "break-all",
            }}
          >
            <span style={{ color: "var(--slop-text-muted)" }}>OBS Server URL:</span>
            <code>{stream.rtmpUrl}</code>
            <span style={{ color: "var(--slop-text-muted)" }}>OBS Stream Key:</span>
            <code style={{ color: "var(--slop-magenta, #ff3ec9)" }}>{stream.streamKey}</code>
            <span style={{ color: "var(--slop-text-muted)" }}>HLS playback:</span>
            <code>{stream.hlsUrl}</code>
            <span />
            <span style={{ color: "var(--slop-text-muted)", fontSize: 11 }}>
              Stream key contains the publish password — keep it secret. Rotate by restarting the relay with a new
              MEDIAMTX_PUBLISH_PASS.
            </span>
          </div>
        ) : null}
      </Bevel>

      {/*
        DORMANT — server-side broadcast panel pulled from the admin UI 2026-06-02.
        We do NOT broadcast from the server. The live stream is captured on a
        SECOND MACHINE running OBS (see the "Broadcast" / "Set up OBS" section
        above — that's the real pipeline). The headless broadcaster (Chromium +
        ffmpeg running next to mediamtx, controlled via /admin/broadcast/*) was
        built to test and left in place in case we revisit it one day, but it is
        not in use. Backend left wired-but-dormant: packages/relay/src/broadcast.ts,
        the /admin/broadcast/* endpoints, and deploy/slop-broadcast.*. The
        <BroadcastPanel/> React control that used to render here lives in git
        history (removed in this commit) — restore it if we ever turn this on.
      */}

      <Bevel style={{ padding: 16, maxWidth: 960 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
          Connected guests
        </h2>
        <p style={{ marginTop: 4, color: "var(--slop-text-muted)", fontSize: 12 }}>refreshes every 3s</p>
        {peers.length === 0 ? (
          <p style={{ color: "var(--slop-text-muted)", marginTop: 8 }}>No peers connected to the relay.</p>
        ) : (
          <table style={{ width: "100%", marginTop: 8, fontFamily: "var(--slop-font-body)", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--slop-text-muted)" }}>
                <th style={{ padding: "4px 8px" }}>Peer</th>
                <th style={{ padding: "4px 8px" }}>Room</th>
                <th style={{ padding: "4px 8px" }}>Identity</th>
                <th style={{ padding: "4px 8px" }}>Connected</th>
                <th style={{ padding: "4px 8px" }} />
              </tr>
            </thead>
            <tbody>
              {peers.map(p => (
                <tr key={p.id}>
                  <td style={{ padding: "4px 8px" }}>
                    <code>{p.id.slice(0, 8)}</code> · {peerMode(p)}
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    {p.slug ? <code>{p.slug}</code> : <span style={{ color: "var(--slop-text-muted)" }}>—</span>}
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    {p.address ? (
                      <Address address={p.address as AddressType} size="xs" />
                    ) : p.handle ? (
                      p.handle
                    ) : (
                      <span style={{ color: "var(--slop-text-muted)" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "4px 8px", color: "var(--slop-text-muted)" }}>
                    {formatConnectedAt(p.connectedAt)}
                  </td>
                  <td style={{ padding: "4px 8px" }}>
                    <Button onClick={() => kickPeer(p.id)}>kick</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Bevel>
    </>
  );

  const showAdminPanel = mounted && auth.authenticated && isHost;

  // globals.css hides the system cursor everywhere via `cursor: none`. The
  // desktop page renders a custom Cursor in its place; admin needs to do
  // the same or the page renders cursor-less. Bands match the connected
  // wallet so it visually ties to the host's identity in the menubar.
  const localCursor = useLocalCursor();
  const myBands = useMemo(
    () =>
      bandsFromIdentity({
        address: auth.authenticated ? auth.address : null,
        handle: null,
        fallback: "admin",
      }),
    [auth],
  );

  return (
    <>
      <DesktopBackground />
      <MenuBar isLive={false} />
      <main
        style={{
          position: "relative",
          paddingTop: 50,
          padding: "50px 24px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {heading}
        {showAdminPanel ? adminPanel : landing}
        {status ? (
          <Bevel style={{ padding: 12, maxWidth: 960, color: "var(--slop-text-muted)" }}>{status}</Bevel>
        ) : null}
      </main>
      {localCursor.pos ? (
        <Cursor x={localCursor.pos.x} y={localCursor.pos.y} kind={localCursor.kind} bands={myBands} />
      ) : null}
    </>
  );
};

export default AdminPage;
