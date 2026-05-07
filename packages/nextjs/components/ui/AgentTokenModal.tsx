"use client";

import { useEffect, useState } from "react";
import { Bevel } from "./Bevel";
import { Button } from "./Button";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

type AgentTokenResponse = {
  token: string;
  expiresAt: number;
  scope: "host" | "peer";
  identity: { address: string | null; handle: string | null; role: string };
};

// Modal shown from the power-menu "Agent token…" item. Fetches a long-lived
// Bearer token from the relay (scoped to the user's own session) and lets
// them copy it or download the markdown "skill" file that wires it into a
// local LLM (Claude Code, local Llama, anything with tool-use). The token
// itself doesn't grant access beyond what the user can already do — host
// scope ⇒ host endpoints, peer scope ⇒ peer endpoints.
export const AgentTokenModal = ({ onClose }: { onClose: () => void }) => {
  const [data, setData] = useState<AgentTokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${RELAY_HTTP}/v1/agent-token`, { credentials: "include", cache: "no-store" })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as AgentTokenResponse;
      })
      .then(d => {
        if (!cancelled) setData(d);
      })
      .catch(e => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can still drag-select */
    }
  };

  const skillUrl = data ? `${RELAY_HTTP}/v1/skill?token=${encodeURIComponent(data.token)}` : "";
  const expires = data ? new Date(data.expiresAt).toLocaleString() : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={e => {
        // Close on backdrop click, not on inner click.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <Bevel style={{ padding: 18, maxWidth: 560, width: "100%" }}>
        <h2
          style={{
            margin: 0,
            marginBottom: 8,
            fontFamily: "var(--slop-font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontSize: 18,
          }}
        >
          Agent token
        </h2>
        <p style={{ color: "var(--slop-text-muted)", marginTop: 0, fontSize: 13 }}>
          Hand this to a local LLM (Claude Code, local Llama, etc.) to let it participate in this session via the
          relay&apos;s <code>/v1/*</code> API. Scoped to your identity, valid 7 days.
        </p>

        {error ? (
          <div style={{ color: "var(--slop-text)", fontSize: 13, padding: 8 }}>
            <strong>Failed to mint token:</strong> {error}
          </div>
        ) : !data ? (
          <div style={{ color: "var(--slop-text-muted)", fontSize: 13, padding: 8 }}>requesting…</div>
        ) : (
          <>
            <div
              style={{
                background: "#06030d",
                border: "1px solid var(--slop-bevel-dark)",
                padding: "8px 10px",
                fontFamily: "monospace",
                fontSize: 11,
                wordBreak: "break-all",
                userSelect: "all",
                marginBottom: 8,
              }}
            >
              {data.token}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
              <Button onClick={copy}>{copied ? "Copied" : "Copy token"}</Button>
              <Button as="a" href={skillUrl} variant="primary">
                Download skill file
              </Button>
              <span style={{ color: "var(--slop-text-muted)", fontSize: 11 }}>
                scope: <code>{data.scope}</code> · expires {expires}
              </span>
            </div>

            <details style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
              <summary style={{ cursor: "pointer" }}>quick test</summary>
              <pre
                style={{
                  marginTop: 8,
                  padding: 8,
                  background: "#06030d",
                  border: "1px solid var(--slop-bevel-dark)",
                  fontFamily: "monospace",
                  fontSize: 11,
                  overflowX: "auto",
                }}
              >
                {`curl -s -H "Authorization: Bearer ${data.token.slice(0, 12)}…" \\
  ${RELAY_HTTP}/v1/state | jq '{peers,browsers,apps}'`}
              </pre>
            </details>
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <Button onClick={onClose}>Close</Button>
        </div>
      </Bevel>
    </div>
  );
};

export default AgentTokenModal;
