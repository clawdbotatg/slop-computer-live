"use client";

import { useEffect, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage } from "wagmi";
import { PasskeyChooserModal } from "~~/components/PasskeyChooserModal";
import { type ProgressMode, type ProgressStage, SignatureProgressModal } from "~~/components/SignatureProgressModal";
import { Bevel, Button } from "~~/components/ui";
import { useSession } from "~~/hooks/useSession";
import { createPasskeyAndAuth, loginWithExistingPasskey } from "~~/utils/passkey";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// localStorage key that remembers which passkey the user prefers. Once
// they've signed in with a passkey once, we skip the chooser modal AND
// the browser's picker on subsequent visits by passing the stored
// credential id via `allowCredentials`. signOut() in useSession nukes
// all `slop:passkey:*` keys so the next session can pick a different
// passkey.
const CREDENTIAL_ID_KEY = "slop:passkey:credId";

const readStoredCredentialId = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(CREDENTIAL_ID_KEY);
  } catch {
    return null;
  }
};

const clearStoredCredential = () => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CREDENTIAL_ID_KEY);
  } catch {
    /* private mode / quota */
  }
};

const writeStoredCredential = (id: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CREDENTIAL_ID_KEY, id);
  } catch {
    /* private mode / quota */
  }
};

// Sign-in card. Two same-size buttons:
//   1. Connect Wallet (primary) → RainbowKit connect modal, then SIWE.
//      The slop_session cookie persists for sessionTTLSeconds (24h), so
//      reload doesn't re-prompt.
//   2. Sign in with Passkey (secondary) → opens a second modal for
//      picking existing vs create. Subsequent visits remember the chosen
//      credential id and skip both the chooser modal AND the browser's
//      picker.
export function JoinCard() {
  const { refresh } = useSession();
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<"siwe" | "passkey" | "anon" | null>(null);

  // Passkey modal state. `chooserOpen` shows the existing-vs-create
  // picker; `progressOpen` shows the LoadingBar walkthrough during the
  // two browser sheets.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressMode, setProgressMode] = useState<ProgressMode>("existing");
  const [progressStage, setProgressStage] = useState<ProgressStage>("first");

  const runSiwe = async (addr: string) => {
    setStatus("Requesting nonce...");
    try {
      const nonceRes = await fetch(`${RELAY_BASE}/auth/siwe/nonce`).then(r => r.json());
      const nonce: string = nonceRes.nonce;
      const domain = window.location.host;
      const uri = window.location.origin;
      const issuedAt = new Date().toISOString();
      const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        addr,
        ``,
        `Sign in to slop-computer-live.`,
        ``,
        `URI: ${uri}`,
        `Version: 1`,
        `Chain ID: 1`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
      ].join("\n");
      setStatus("Awaiting signature...");
      const signature = await signMessageAsync({ message });
      setStatus("Verifying signature...");
      const verifyRes = await fetch(`${RELAY_BASE}/auth/siwe`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature, nonce }),
      });
      const data = await verifyRes.json();
      if (!verifyRes.ok) {
        setStatus(`Sign-in failed: ${data.error ?? verifyRes.statusText}`);
        return;
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "";
      // RainbowKit / wagmi user-rejection — be quiet.
      if (/User rejected|Rejected|cancelled/i.test(msg)) {
        setStatus("");
      } else {
        setStatus(`Sign-in error: ${msg}`);
      }
    } finally {
      setBusy(null);
    }
  };

  // Auto-fire SIWE the moment the wallet is connected, but only if the
  // user explicitly clicked "Connect Wallet" (we record that intent in
  // a ref so a wagmi auto-reconnect on page load doesn't ambush them).
  const wantsSiweRef = useRef(false);
  useEffect(() => {
    if (!isConnected || !address) return;
    if (!wantsSiweRef.current) return;
    wantsSiweRef.current = false;
    setBusy("siwe");
    void runSiwe(address);
    // intentional: only trigger when isConnected/address transitions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  const onConnectWalletClick = () => {
    if (busy) return;
    wantsSiweRef.current = true;
    if (isConnected && address) {
      // Already connected — kick off SIWE directly.
      setBusy("siwe");
      void runSiwe(address);
      return;
    }
    // Not connected yet — open the RainbowKit modal; the useEffect picks
    // up the resulting connection and runs SIWE.
    openConnectModal?.();
  };

  // Drive the existing-passkey flow with progress modal. When called
  // with `preferredCredentialId`, the browser sheet pre-targets that
  // passkey (no picker). If that fails, retry without preference.
  const runExistingFlow = async (preferredCredentialId?: string) => {
    setProgressMode("existing");
    setProgressStage("first");
    setProgressOpen(true);
    try {
      const result = await loginWithExistingPasskey({
        preferredCredentialId,
        onStage: stage => setProgressStage(stage),
      });
      writeStoredCredential(result.credentialIdBase64Url);
      setProgressOpen(false);
      setStatus("");
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "";
      setProgressOpen(false);
      if (msg === "preferred-credential-failed" && preferredCredentialId) {
        // Stored passkey didn't work — drop the preference and reopen
        // the chooser so the user can pick again.
        clearStoredCredential();
        setChooserOpen(true);
        setStatus("");
        return;
      }
      if (/cancel|NotAllowed/i.test(msg)) setStatus("");
      else setStatus(`Passkey sign-in failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const runCreateFlow = async () => {
    setProgressMode("create");
    setProgressStage("first");
    setProgressOpen(true);
    try {
      const result = await createPasskeyAndAuth({
        onStage: stage => setProgressStage(stage),
      });
      writeStoredCredential(result.credentialIdBase64Url);
      setProgressOpen(false);
      setStatus("");
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || "";
      setProgressOpen(false);
      if (/cancel|NotAllowed/i.test(msg)) setStatus("");
      else setStatus(`Passkey create failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const onPasskeyClick = () => {
    if (busy) return;
    const storedId = readStoredCredentialId();
    if (storedId) {
      // Returning user — skip the chooser and the browser picker, go
      // straight to signing with their remembered passkey.
      setBusy("passkey");
      void runExistingFlow(storedId);
      return;
    }
    // First-time visitor — open the chooser modal.
    setChooserOpen(true);
  };

  const onAnonClick = async () => {
    if (busy) return;
    setBusy("anon");
    setStatus("");
    try {
      const res = await fetch(`${RELAY_BASE}/auth/anon`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Anon sign-in failed: ${data.error ?? res.statusText}`);
        return;
      }
      await refresh();
    } catch (err) {
      setStatus(`Anon sign-in error: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onChooserPickExisting = () => {
    // Belt-and-suspenders: when the user explicitly picks "Use Existing
    // Passkey" from the chooser, drop any stored credential id first so
    // the flow ALWAYS hits the discoverable-credential picker (no
    // allowCredentials). Defends against a stale localStorage entry
    // surviving sign-out for any reason.
    clearStoredCredential();
    setChooserOpen(false);
    setBusy("passkey");
    void runExistingFlow();
  };

  const onChooserPickCreate = () => {
    clearStoredCredential();
    setChooserOpen(false);
    setBusy("passkey");
    void runCreateFlow();
  };

  return (
    <>
      <Bevel style={{ padding: 24, width: "min(360px, 92vw)", textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-mark.png"
          alt="slop"
          width={84}
          height={84}
          style={{ display: "block", margin: "0 auto 16px", imageRendering: "pixelated" }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button variant="primary" onClick={onConnectWalletClick} disabled={busy !== null} style={{ width: "100%" }}>
            {busy === "siwe"
              ? "Signing in…"
              : isConnected && address
                ? `Sign in as ${address.slice(0, 6)}…${address.slice(-4)}`
                : "Connect Wallet"}
          </Button>

          <Button onClick={onPasskeyClick} disabled={busy !== null} style={{ width: "100%" }}>
            {busy === "passkey" ? "Waiting for passkey…" : "Sign in with Passkey"}
          </Button>

          <Button onClick={onAnonClick} disabled={busy !== null} style={{ width: "100%" }}>
            {busy === "anon" ? "Signing in…" : "Sign in as Anon"}
          </Button>
        </div>

        {status ? <p style={{ marginTop: 12, color: "var(--slop-text-muted)", fontSize: 12 }}>{status}</p> : null}

        {/* Force the pointer-hand cursor SVG into the browser cache the
            moment the JoinCard mounts. Once the user signs in, Cursor.tsx
            renders the same asset — having it pre-warmed means no blank
            frame while it fetches. 1px is enough to trigger the GET. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/cursors/six_finger_pointer_exact_band_masks_no_bleed.svg"
          alt=""
          width={1}
          height={1}
          aria-hidden="true"
          style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
        />
      </Bevel>

      <PasskeyChooserModal
        open={chooserOpen}
        busy={busy === "passkey"}
        onSelectExisting={onChooserPickExisting}
        onSelectCreate={onChooserPickCreate}
        onClose={() => setChooserOpen(false)}
      />

      <SignatureProgressModal open={progressOpen} mode={progressMode} stage={progressStage} />
    </>
  );
}
