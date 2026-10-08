"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "~~/components/ui";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { SAFE_CHAIN_IDS, passkeyOwner } from "~~/utils/safe";
import { wedgieSupported, withWedgie } from "~~/utils/wedgie";

// Wedgie app (single player): talk to the wedgie on YOUR USB port, read its
// key, and share that key with the room so the Bank deploy list can offer it
// as a Safe owner. The key is public (like a passkey's); signing still needs
// a press of A on the device. ops/PLAN-safe.md.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const KEY_STORE = "slop:wedgie:key";
const CHAIN_LABEL: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  100: "Gnosis",
  4663: "Robinhood",
};

type Key = { x: string; y: string };

const readKey = (): Key | null => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_STORE) ?? "null");
    return v && typeof v.x === "string" && typeof v.y === "string" ? v : null;
  } catch {
    return null;
  }
};

/** The wedgie ID people paste into the Bank: x‖y, one hex string. */
export const wedgieId = (k: Key) => `${k.x}${k.y.slice(2)}`;
export const parseWedgieId = (s: string): Key | null => {
  const m = /^0x([0-9a-fA-F]{64})([0-9a-fA-F]{64})$/.exec(s.trim());
  return m ? { x: `0x${m[1]}`.toLowerCase(), y: `0x${m[2]}`.toLowerCase() } : null;
};

export const WedgieAppWindow = ({ mesh }: { mesh: PeerMeshState }) => {
  const slug = useRoomSlug();
  const [key, setKey] = useState<Key | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [chains, setChains] = useState<Record<number, boolean | null> | null>(null);
  const [copied, setCopied] = useState(false);
  const { reportWedgie } = mesh;

  // A wedgie this browser connected before stays yours: re-share on open.
  useEffect(() => {
    const k = readKey();
    if (k) {
      setKey(k);
      reportWedgie(k);
    }
  }, [reportWedgie]);

  const refreshChains = useCallback(async (k: Key) => {
    try {
      const r = await fetch(`${RELAY_HTTP}/v1/safe/signer-status?x=${k.x}&y=${k.y}`);
      if (r.ok) setChains(((await r.json()) as { chains: Record<number, boolean | null> }).chains);
    } catch {
      /* status is a nicety */
    }
  }, []);
  useEffect(() => {
    if (key) void refreshChains(key);
  }, [key, refreshChains]);

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const k = await withWedgie(w => w.key());
      const lower = { x: k.x.toLowerCase(), y: k.y.toLowerCase() };
      try {
        localStorage.setItem(KEY_STORE, JSON.stringify(lower));
      } catch {
        /* private mode */
      }
      setKey(lower);
      reportWedgie(lower);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = () => {
    try {
      localStorage.removeItem(KEY_STORE);
    } catch {
      /* ignore */
    }
    setKey(null);
    setChains(null);
    reportWedgie(null);
  };

  const createSigners = async () => {
    if (!key) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(withSlug(`${RELAY_HTTP}/v1/safe/signer`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qx: key.x, qy: key.y }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; results?: { ok: boolean; error?: string }[] };
      if (!r.ok) setMsg(j.error ?? `relay ${r.status}`);
      else if (j.results?.some(x => !x.ok)) setMsg("Some chains failed — try again.");
      await refreshChains(key);
    } catch (e) {
      setMsg(String(e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  const owner = key ? passkeyOwner(key.x as `0x${string}`, key.y as `0x${string}`) : null;
  const missing = chains ? SAFE_CHAIN_IDS.filter(c => chains[c] === false).length : 0;

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/wedgie.png" alt="" width={48} height={48} />
        <div style={{ color: "var(--slop-text-muted)", lineHeight: 1.5 }}>
          Plug in your wedgie (Safe signer app). Only this browser talks to it. Its key is shared with the room so the
          Bank can add it as an owner.
        </div>
      </div>

      {!wedgieSupported() ? (
        <div style={{ color: "#ff6b6b" }}>
          This browser can&apos;t talk to a wedgie. Use Chrome or Edge on a computer.
        </div>
      ) : null}

      {key && owner ? (
        <>
          <Field label="Wedgie owner address (what the Safe lists)">
            <code style={{ wordBreak: "break-all" }}>{owner}</code>
          </Field>
          <Field label="Wedgie ID (send this to add it to a Bank from outside the room)">
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <code style={{ wordBreak: "break-all", flex: 1, fontSize: 10 }}>{wedgieId(key)}</code>
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(wedgieId(key)).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Field>
          <div style={{ color: "#7be88a" }}>✓ Shared with the room — the host can add it in Bank → Deploy.</div>
          <Field label="Signer contract (needed on a chain before it can sign there)">
            {chains ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {SAFE_CHAIN_IDS.map(c => (
                  <div key={c} style={{ display: "flex", gap: 8 }}>
                    <span style={{ width: 80 }}>{CHAIN_LABEL[c]}</span>
                    <span style={{ color: chains[c] ? "#7be88a" : "var(--slop-text-muted)" }}>
                      {chains[c] ? "✓ ready" : chains[c] === false ? "not yet" : "?"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <span style={{ color: "var(--slop-text-muted)" }}>checking…</span>
            )}
            {missing > 0 ? (
              <div style={{ marginTop: 6 }}>
                <Button disabled={busy} onClick={() => void createSigners()}>
                  {busy ? "Creating…" : "Create it (slop.computer pays)"}
                </Button>
                <div style={{ color: "var(--slop-text-muted)", fontSize: 10, marginTop: 4 }}>
                  Not required: it&apos;s created automatically when the wedgie is added to a Bank.
                </div>
              </div>
            ) : null}
          </Field>
          <div style={{ display: "flex", gap: 6 }}>
            <Button disabled={busy} onClick={() => void connect()}>
              Re-read wedgie
            </Button>
            <Button onClick={forget}>Forget &amp; stop sharing</Button>
          </div>
        </>
      ) : (
        <Button disabled={busy || !wedgieSupported()} onClick={() => void connect()}>
          {busy ? "Talking to the wedgie…" : "Connect wedgie"}
        </Button>
      )}
      <div style={{ color: "var(--slop-text-muted)", fontSize: 10, lineHeight: 1.5 }}>
        Signing: open a Bank transaction and press &quot;Sign with wedgie&quot;, then A on the device. A wedgie is never
        enough on its own — Safes that include one always need another signature too.
      </div>
      {msg ? <div style={{ color: "#ff6b6b" }}>{msg}</div> : null}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <div
      style={{
        fontSize: 10,
        color: "var(--slop-text-muted)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </div>
    {children}
  </div>
);
