"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { Address as AddressType } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { Bevel, Button, DesktopBackground, MenuBar, TextField } from "~~/components/ui";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

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

const randomToken = () => {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(16).slice(2, 14);
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
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!mounted) return;
    fetch(`${RELAY_BASE}/auth/me`, { credentials: "include" })
      .then(r => r.json())
      .then((data: AuthState) => setAuth(data))
      .catch(() => setAuth({ authenticated: false }));
  }, [mounted]);

  useEffect(() => {
    if (!mounted) setInvite(prev => prev || "");
    else setInvite(prev => prev || randomToken());
  }, [mounted]);

  const isHost = auth.authenticated && auth.role === "host";

  useEffect(() => {
    let cancelled = false;
    if (!isHost) return;
    async function startCam() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        setStatus(`Webcam unavailable: ${(err as Error).message}`);
      }
    }
    startCam();
    return () => {
      cancelled = true;
    };
  }, [isHost]);

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
    const u = new URL("/join", window.location.origin);
    if (invite) u.searchParams.set("invite", invite);
    return u.toString();
  }, [invite, mounted]);

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "SlopComputerFrontpage" });

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
  const [showTitle, setShowTitle] = useState("Slop Computer Live");
  const [fanouts, setFanouts] = useState<Fanout[]>([]);
  const [fanoutBusy, setFanoutBusy] = useState<string | null>(null);

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
      setStatus("Got RTMP credentials. Paste into OBS, start streaming, then click Go Live to flip the contract.");
    } catch (err) {
      setStatus(`fetch failed: ${(err as Error).message}`);
    }
  };

  const handleGoLive = async () => {
    if (!stream) {
      setStatus("Get RTMP info first.");
      return;
    }
    setStatus("Calling goLive() on mainnet...");
    try {
      await writeContractAsync({
        functionName: "goLive",
        args: [showTitle || "Slop Computer Live", stream.hlsUrl],
      });
      setStatus("goLive tx sent — frontpage will flip to LIVE within ~12s.");
    } catch (err) {
      setStatus(`goLive failed: ${(err as Error).message}`);
    }
  };

  const handleGoOffline = async () => {
    setStatus("Calling goOffline()...");
    try {
      await writeContractAsync({ functionName: "goOffline" });
      await fetch(`${RELAY_BASE}/admin/stop`, { method: "POST", credentials: "include" });
      setStream(null);
      setStatus("Offline.");
    } catch (err) {
      setStatus(`goOffline failed: ${(err as Error).message}`);
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
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
          Webcam preview
        </h2>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            width: 360,
            height: 240,
            background: "#000",
            marginTop: 8,
            border: "1px solid var(--slop-bevel-dark)",
          }}
        />
      </Bevel>

      <Bevel style={{ padding: 16, maxWidth: 720 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Broadcast</h2>
        <p style={{ color: "var(--slop-text-muted)", margin: "6px 0 12px" }}>
          1. Click <strong>Get OBS info</strong>. 2. Paste the URL + key into OBS, set the Browser Source to{" "}
          <code>https://live.slop.computer/desktop</code>, and start streaming. 3. Click <strong>Go live</strong> to
          flip the mainnet contract — <code>slop.computer</code> will show the LIVE banner with the HLS player.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <Button onClick={handleGetRtmpInfo} disabled={!isHost}>
            Get OBS info
          </Button>
          <TextField
            placeholder="Show title"
            value={showTitle}
            onChange={e => setShowTitle(e.target.value)}
            style={{ minWidth: 240 }}
          />
          <Button variant="primary" onClick={handleGoLive} disabled={!isHost || !stream}>
            Go live
          </Button>
          <Button onClick={handleGoOffline} disabled={!isHost}>
            Go offline
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
        <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Invite link</h2>
        <p style={{ color: "var(--slop-text-muted)" }}>
          Anyone with this link plus the current GUEST_PASSWORD can join. Rotate the password between shows.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <TextField
            placeholder="invite token"
            value={invite}
            onChange={e => setInvite(e.target.value)}
            style={{ minWidth: 220 }}
          />
          <Button onClick={() => setInvite(randomToken())}>Regenerate</Button>
        </div>
        <p style={{ marginTop: 12, fontFamily: "var(--slop-font-body)" }}>
          <code>{inviteUrl}</code>
        </p>
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
    </>
  );

  const showAdminPanel = mounted && auth.authenticated && isHost;

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
    </>
  );
};

export default AdminPage;
