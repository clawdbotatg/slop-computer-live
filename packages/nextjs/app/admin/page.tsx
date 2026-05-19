"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { Address as AddressType } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { Bevel, Button, Cursor, DesktopBackground, MenuBar, TextField } from "~~/components/ui";
import { useEpisodeState } from "~~/hooks/useEpisodeState";
import { useLocalCursor } from "~~/hooks/useLocalCursor";
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
};

const formatConnectedAt = (ts?: number) => {
  if (!ts) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
};

const AdminPage: NextPage = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [auth, setAuth] = useState<AuthState>({ authenticated: false });
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<string>("");
  const [invite, setInvite] = useState<string>("");
  // Per-room password creation state (Phase 5). Filled in by the host
  // when claiming a new slug; on submit we POST /v1/rooms which hashes
  // the password on the relay and stores it under
  // .slop-data/rooms/<slug>/auth.json.
  const [newRoomSlug, setNewRoomSlug] = useState("");
  const [newRoomPassword, setNewRoomPassword] = useState("");
  const [createRoomStatus, setCreateRoomStatus] = useState<string>("");

  useEffect(() => {
    if (!mounted) return;
    fetch(`${RELAY_BASE}/auth/me`, { credentials: "include" })
      .then(r => r.json())
      .then((data: AuthState) => setAuth(data))
      .catch(() => setAuth({ authenticated: false }));
  }, [mounted]);

  // The single global invite password is stored on the relay (file-backed).
  // Pull the current value once we're a host so the admin can read it,
  // share it, or rotate it. Non-hosts get a 401 and we leave invite blank.
  useEffect(() => {
    if (!mounted) return;
    if (!auth.authenticated || auth.role !== "host") return;
    let cancelled = false;
    fetch(`${RELAY_BASE}/admin/invite-password`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: { password?: string }) => {
        if (!cancelled && typeof data.password === "string") setInvite(data.password);
      })
      .catch(() => {
        /* leave blank — UI shows a regenerate prompt */
      });
    return () => {
      cancelled = true;
    };
  }, [mounted, auth]);

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
        setNewRoomSlug("");
        setNewRoomPassword("");
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

  const regenerateInvite = async () => {
    try {
      const res = await fetch(`${RELAY_BASE}/admin/invite-password`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { password?: string };
      if (typeof data.password === "string") setInvite(data.password);
    } catch {
      /* relay offline */
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

  const inviteUrl = useMemo(() => {
    if (!mounted) return "";
    // Root path — the desktop page picks `?invite=` up off the URL and
    // pre-fills the password gate.
    const u = new URL("/", window.location.origin);
    if (invite) u.searchParams.set("invite", invite);
    return u.toString();
  }, [invite, mounted]);

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

  const [walletResetBusy, setWalletResetBusy] = useState(false);
  const resetSessionWallet = async () => {
    if (walletResetBusy) return;
    if (
      !confirm(
        "Wipe the current multisig + history + all pending txs? This can't be undone (but it doesn't touch the on-chain contract).",
      )
    ) {
      return;
    }
    setWalletResetBusy(true);
    try {
      const res = await fetch(`${RELAY_BASE}/admin/wallet/reset`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus(`wallet reset failed: ${(data as { error?: string }).error ?? res.statusText}`);
      } else {
        setStatus("Session wallet reset.");
      }
    } catch (err) {
      setStatus(`wallet reset failed: ${(err as Error).message}`);
    } finally {
      setWalletResetBusy(false);
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

  // Episode-wide STT toggle. The hook SSE-subscribes so the button reflects
  // any flips made from other admin tabs (or the API directly) immediately.
  const episode = useEpisodeState(RELAY_BASE);
  const [sttBusy, setSttBusy] = useState(false);
  const toggleEpisodeStt = async (on: boolean) => {
    setSttBusy(true);
    try {
      const res = await fetch(`${RELAY_BASE}/admin/episode/stt`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setStatus(`STT toggle failed: ${data?.error ?? res.statusText}`);
      }
    } catch (err) {
      setStatus(`STT toggle failed: ${(err as Error).message}`);
    } finally {
      setSttBusy(false);
    }
  };
  const [transcriptClearBusy, setTranscriptClearBusy] = useState(false);
  // Two-click confirm instead of window.confirm — Chrome silently blocks
  // repeated native dialogs from the same origin (returns false
  // instantly with no UI), which made the previous version unusable.
  const [transcriptClearArmed, setTranscriptClearArmed] = useState(false);
  const transcriptClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmTranscriptClear = () => {
    if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current);
    transcriptClearTimer.current = null;
    setTranscriptClearArmed(false);
  };
  const clearTranscript = async () => {
    if (!transcriptClearArmed) {
      setTranscriptClearArmed(true);
      if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current);
      transcriptClearTimer.current = setTimeout(() => setTranscriptClearArmed(false), 5000);
      return;
    }
    disarmTranscriptClear();
    setTranscriptClearBusy(true);
    try {
      const res = await fetch(`${RELAY_BASE}/admin/transcript`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as { clearedCount?: number; error?: string } | null;
      if (!res.ok) {
        setStatus(`Transcript clear failed: ${data?.error ?? res.statusText}`);
      } else {
        setStatus(`Cleared ${data?.clearedCount ?? 0} transcript segments.`);
      }
    } catch (err) {
      setStatus(`Transcript clear failed: ${(err as Error).message}`);
    } finally {
      setTranscriptClearBusy(false);
    }
  };

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
      <Bevel style={{ padding: 16, maxWidth: 720 }}>
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

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Invite link</h2>
        <p style={{ color: "var(--slop-text-muted)" }}>
          Anyone with this link can reach the sign-in screen and connect a wallet or passkey. Regenerate to invalidate
          all outstanding invite cookies.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          <TextField placeholder="(no password set)" value={invite} readOnly style={{ minWidth: 180 }} />
          <Button onClick={regenerateInvite}>Regenerate</Button>
          <Button
            onClick={() => {
              if (inviteUrl) void navigator.clipboard?.writeText(inviteUrl);
            }}
            disabled={!inviteUrl}
          >
            Copy link
          </Button>
        </div>
        <p style={{ marginTop: 12, fontFamily: "var(--slop-font-body)", wordBreak: "break-all" }}>
          <code>{inviteUrl}</code>
        </p>
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Create a room</h2>
        <p style={{ color: "var(--slop-text-muted)" }}>
          Claim a slug + set its password. Anyone you share the password with can enter that room at
          <code style={{ marginLeft: 4 }}>/&lt;slug&gt;</code>. Slug must match <code>^[a-z0-9-]{`{1,64}`}$</code> and
          should usually match the on-chain episode slug from slop.computer.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          <TextField
            placeholder="slug (e.g. ep0)"
            value={newRoomSlug}
            onChange={e => setNewRoomSlug(e.target.value.toLowerCase())}
            style={{ minWidth: 180 }}
          />
          <TextField
            placeholder="password"
            value={newRoomPassword}
            onChange={e => setNewRoomPassword(e.target.value)}
            style={{ minWidth: 180 }}
          />
          <Button onClick={createRoom}>Create</Button>
        </div>
        {createRoomStatus ? (
          <p
            style={{
              marginTop: 12,
              fontSize: 12,
              color: createRoomStatus.endsWith("✓") ? "var(--slop-lime, #b4ff3a)" : "var(--slop-magenta, #ff3ec9)",
            }}
          >
            {createRoomStatus}
          </p>
        ) : null}
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
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

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
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

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
          Live transcript
        </h2>
        <p style={{ color: "var(--slop-text-muted)", margin: "6px 0 12px" }}>
          When ON, every peer with a published mic runs Web Speech locally and posts final segments to the relay. They
          land in the per-episode transcript archive at finalize, then auto-clear so the next episode starts fresh.
          Default OFF so pre-show dinking around isn&apos;t captured.
        </p>
        <div
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
                textTransform: "uppercase",
                background: episode.sttOn ? "var(--slop-accent)" : "var(--slop-bevel-dark)",
                color: episode.sttOn ? "var(--slop-bg)" : "var(--slop-text-muted)",
              }}
            >
              {episode.sttOn ? "ON AIR" : "STANDBY"}
            </span>
            <a
              href={`${RELAY_BASE}/admin/transcript`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--slop-text-muted)", fontSize: 12 }}
            >
              view raw ↗
            </a>
            <Button
              onClick={clearTranscript}
              disabled={transcriptClearBusy}
              style={transcriptClearArmed ? { background: "var(--slop-accent-warn, #c33)", color: "#fff" } : undefined}
            >
              {transcriptClearBusy ? "Clearing…" : transcriptClearArmed ? "Click again to confirm" : "Clear"}
            </Button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {episode.sttOn ? (
              <Button onClick={() => toggleEpisodeStt(false)} disabled={sttBusy}>
                Stop STT
              </Button>
            ) : (
              <Button variant="primary" onClick={() => toggleEpisodeStt(true)} disabled={sttBusy}>
                Start STT
              </Button>
            )}
          </div>
        </div>
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
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

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
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
                <th style={{ padding: "4px 8px" }}>Identity</th>
                <th style={{ padding: "4px 8px" }}>Connected</th>
                <th style={{ padding: "4px 8px" }} />
              </tr>
            </thead>
            <tbody>
              {peers.map(p => (
                <tr key={p.id}>
                  <td style={{ padding: "4px 8px" }}>
                    <code>{p.id.slice(0, 8)}</code> · {p.role}
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

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
          Session wallet
        </h2>
        <p style={{ color: "var(--slop-text-muted)", margin: "6px 0 12px", fontSize: 13 }}>
          Per-episode multisig lives in <code>.slop-data/wallet.json</code> on the relay. Resetting clears the deployed
          address + history + every pending tx so the wallet window goes back to the deploy form. The on-chain contract
          itself is unaffected.
        </p>
        <Button onClick={resetSessionWallet} disabled={!isHost || walletResetBusy}>
          {walletResetBusy ? "Resetting…" : "Reset session wallet"}
        </Button>
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
          <Bevel style={{ padding: 12, maxWidth: 720, color: "var(--slop-text-muted)" }}>{status}</Bevel>
        ) : null}
      </main>
      {localCursor.pos ? (
        <Cursor x={localCursor.pos.x} y={localCursor.pos.y} kind={localCursor.kind} bands={myBands} />
      ) : null}
    </>
  );
};

export default AdminPage;
