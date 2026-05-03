"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NextPage } from "next";
import { useAccount, useSignMessage } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { Bevel, Button, MenuBar, TextField } from "~~/components/ui";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

type AuthState =
  | { authenticated: false }
  | { authenticated: true; role: string; address: string | null; handle: string | null };

const AdminPage: NextPage = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [auth, setAuth] = useState<AuthState>({ authenticated: false });
  const [status, setStatus] = useState<string>("");
  const [invite, setInvite] = useState<string>("");
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    fetch(`${RELAY_BASE}/auth/me`, { credentials: "include" })
      .then(r => r.json())
      .then((data: AuthState) => setAuth(data))
      .catch(() => setAuth({ authenticated: false }));
  }, []);

  useEffect(() => {
    let cancelled = false;
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
    if (auth.authenticated) startCam();
    return () => {
      cancelled = true;
    };
  }, [auth.authenticated]);

  const isHost = auth.authenticated && auth.role === "host";
  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const u = new URL("/join", window.location.origin);
    if (invite) u.searchParams.set("invite", invite);
    return u.toString();
  }, [invite]);

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
      setStatus(data.isAdmin ? "Signed in as host." : "Signed in (not an admin address).");
    } catch (err) {
      setStatus(`Auth error: ${(err as Error).message}`);
    }
  };

  const handleGoLive = async () => {
    setStatus("Provisioning RTMP session on relay...");
    try {
      const res = await fetch(`${RELAY_BASE}/admin/start`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`relay /admin/start failed: ${data.error ?? res.statusText}`);
        return;
      }
      setStatus(`RTMP: ${data.rtmpUrl} key=${data.streamKey}. Calling goLive() onchain...`);
      const hlsUrl = process.env.NEXT_PUBLIC_HLS_URL ?? "";
      await writeContractAsync({
        functionName: "goLive",
        args: ["Live show", hlsUrl],
      });
      setStatus("goLive tx sent.");
    } catch (err) {
      setStatus(`goLive failed: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <MenuBar isLive={false} />
      <main style={{ paddingTop: 50, padding: "50px 24px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
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

        {!isConnected ? (
          <Bevel style={{ padding: 16, maxWidth: 520 }}>
            <p>Connect your wallet to sign in.</p>
            <div style={{ marginTop: 8 }}>
              <RainbowKitCustomConnectButton />
            </div>
          </Bevel>
        ) : !auth.authenticated ? (
          <Bevel style={{ padding: 16, maxWidth: 520 }}>
            <p style={{ marginTop: 0 }}>
              Connected as <code>{address}</code>. Sign in with Ethereum to authenticate as host.
            </p>
            <Button variant="primary" onClick={handleSiwe}>
              Sign-In with Ethereum
            </Button>
          </Bevel>
        ) : (
          <>
            <Bevel style={{ padding: 16, maxWidth: 720 }}>
              <p style={{ marginTop: 0 }}>
                Authenticated as <code>{auth.address}</code> ({auth.role})
                {!isHost && " — not an admin address per ADMIN_ADDRESSES on the relay."}
              </p>
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
              <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>Go live</h2>
              <p style={{ color: "var(--slop-text-muted)" }}>
                Provisions an RTMP session on the relay and calls{" "}
                <code>SlopComputerFrontpage.goLive(title, hlsUrl)</code> on mainnet.
              </p>
              <Button variant="primary" onClick={handleGoLive} disabled={!isHost}>
                Go live
              </Button>
            </Bevel>

            <Bevel style={{ padding: 16, maxWidth: 720 }}>
              <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
                Invite link
              </h2>
              <p style={{ color: "var(--slop-text-muted)" }}>
                Anyone with this link + the current GUEST_PASSWORD can join. Rotate the password between shows.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                <TextField
                  placeholder="invite token (any string)"
                  value={invite}
                  onChange={e => setInvite(e.target.value)}
                  style={{ minWidth: 200 }}
                />
              </div>
              <p style={{ marginTop: 12, fontFamily: "var(--slop-font-body)" }}>
                <code>{inviteUrl || "(set an invite token to generate)"}</code>
              </p>
            </Bevel>
          </>
        )}

        {status ? (
          <Bevel style={{ padding: 12, maxWidth: 720, color: "var(--slop-text-muted)" }}>{status}</Bevel>
        ) : null}
      </main>
    </>
  );
};

export default AdminPage;
