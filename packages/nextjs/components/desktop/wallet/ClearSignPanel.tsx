"use client";

// ClearSignPanel — the ERC-7730 "clear signing" layer for the multisig card.
//
// Takes what a signer is about to approve (target / value / data, or a batch)
// and renders the *deterministic* human-readable intent decoded from an
// ERC-7730 descriptor — the facts, distinct from the proposer's claim and the
// AI's opinion that sit above it. When no descriptor resolves, it degrades to
// an ERC-8213-style byte-level digest instead of pretending it understood the
// call.
//
// All decoding happens server-side at /api/clear-sign; this component just
// POSTs the tx and paints the result in the Mac OS 9 vernacular.
import { useEffect, useRef, useState } from "react";

const ACCENT = "var(--slop-green, #7be88a)";
const MUTED = "var(--slop-text-muted)";

type Warning = { code: string; message: string };
type Field = {
  label: string;
  value: string;
  fieldType?: string;
  format?: string;
  warning?: Warning;
  rawAddress?: string;
  tokenAddress?: string;
  fields?: Field[]; // present on a field *group*
};
type DisplayModel = {
  intent?: string | Record<string, string>;
  interpolatedIntent?: string;
  fields?: Field[];
  metadata?: { owner?: string; contractName?: string; info?: { url?: string } };
  rawCalldataFallback?: { selector: string; args: string[] };
  warnings?: Warning[];
};
type Resp =
  | { ok: true; batch: false; model: DisplayModel; digest: string | null }
  | {
      ok: true;
      batch: true;
      model: { callDisplays: DisplayModel[]; interpolatedIntent?: string };
      digests: (string | null)[];
    }
  | { ok: false; error: string; digest?: string | null };

type Props = {
  chainId: number;
  target: string;
  value: string;
  data: string;
  calls?: { target: string; value: string; data: string }[];
  isBatch?: boolean;
};

const short = (h?: string | null) => (h && h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-6)}` : (h ?? ""));

export const ClearSignPanel = ({ chainId, target, value, data, calls, isBatch }: Props) => {
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [resp, setResp] = useState<Resp | null>(null);
  // Stable identity for this exact payload so we fetch once, not on every render.
  const key = isBatch
    ? `b:${chainId}:${(calls ?? []).map(c => `${c.target}.${c.data}`).join("|")}`
    : `s:${chainId}:${target}:${data}`;
  const lastKey = useRef<string>("");
  // A plain value transfer (no calldata) has nothing to decode — the amount and
  // recipient are already the whole story, shown on the card above. Treat it as
  // cleanly clear-signed rather than routing it through the can't-decode path.
  const nativeTransfer = !isBatch && (!data || data === "0x" || data.length < 10);

  useEffect(() => {
    if (nativeTransfer) return;
    if (lastKey.current === key) return;
    lastKey.current = key;
    let alive = true;
    setState("loading");
    setResp(null);
    const bodyObj = isBatch ? { chainId, calls } : { chainId, to: target, data, value };
    fetch("/api/clear-sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyObj),
    })
      .then(r => r.json())
      .then((j: Resp) => {
        if (!alive) return;
        setResp(j);
        setState("done");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [key, chainId, target, data, value, isBatch, calls, nativeTransfer]);

  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 5,
        background: "rgba(123,232,138,0.05)",
        border: "1px solid rgba(123,232,138,0.28)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontSize: 10,
            color: ACCENT,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          ✓ clear signing
        </span>
        <span style={{ fontSize: 9, color: MUTED, border: `1px solid ${MUTED}`, borderRadius: 3, padding: "0 4px" }}>
          ERC-7730
        </span>
      </div>

      {nativeTransfer ? (
        <span style={{ fontSize: 12 }}>
          Native transfer — no contract call to decode.{" "}
          <span style={{ color: MUTED }}>The amount and recipient above are the whole transaction.</span>
        </span>
      ) : state === "loading" ? (
        <span style={{ fontSize: 11, color: MUTED, fontStyle: "italic" }}>decoding calldata…</span>
      ) : state === "error" || !resp ? (
        <Fallback digest={digestFromData(data)} note="couldn’t reach the decoder" />
      ) : resp.ok && resp.batch ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {resp.model.callDisplays.map((m, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: MUTED }}>call {i + 1}</span>
              <ModelView model={m} digest={resp.digests?.[i] ?? null} />
            </div>
          ))}
        </div>
      ) : resp.ok ? (
        <ModelView model={resp.model} digest={resp.digest} />
      ) : (
        <Fallback digest={resp.digest ?? digestFromData(data)} note={resp.error} />
      )}
    </div>
  );
};

// Decode outcome for one call.
const ModelView = ({ model, digest }: { model: DisplayModel; digest: string | null }) => {
  const hasIntent = model.intent || model.interpolatedIntent;
  const flatFields = flatten(model.fields ?? []);
  if (!hasIntent && (model.rawCalldataFallback || flatFields.length === 0)) {
    return (
      <Fallback
        digest={digest}
        selector={model.rawCalldataFallback?.selector}
        note="no descriptor in the registry for this contract"
      />
    );
  }

  const intentText =
    typeof model.intent === "string"
      ? model.intent
      : model.intent
        ? Object.values(model.intent).join(" · ")
        : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {model.interpolatedIntent ? (
        <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{model.interpolatedIntent}</span>
      ) : intentText ? (
        <span style={{ fontSize: 13, fontWeight: 600 }}>{intentText}</span>
      ) : null}

      {model.metadata?.contractName ? (
        <span style={{ fontSize: 10, color: MUTED }}>on {model.metadata.contractName}</span>
      ) : null}

      {/* Show the labeled fields even when interpolatedIntent already summarizes
          them — a signer verifying value should see amount + recipient plainly. */}
      {flatFields.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {flatFields.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ color: MUTED, minWidth: 78 }}>{f.label}</span>
              <span style={{ fontWeight: 500, wordBreak: "break-all" }}>
                {f.value}
                {f.warning ? (
                  <span title={f.warning.message} style={{ color: "#ffcc66", marginLeft: 6, fontSize: 10 }}>
                    ⚠ {f.warning.code === "UNKNOWN_TOKEN" ? "unverified token" : f.warning.code.toLowerCase()}
                  </span>
                ) : null}
              </span>
              {f.rawAddress && f.rawAddress.toLowerCase() !== f.value.toLowerCase() ? (
                <span style={{ color: MUTED, fontSize: 9, fontFamily: "monospace" }}>{short(f.rawAddress)}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const Fallback = ({ digest, selector, note }: { digest: string | null; selector?: string; note?: string }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
    <span style={{ fontSize: 12, color: "#ffcc66" }}>⚠ Can’t clear-sign this call</span>
    {note ? <span style={{ fontSize: 10, color: MUTED }}>{note}</span> : null}
    {selector ? <span style={{ fontSize: 10, color: MUTED, fontFamily: "monospace" }}>selector {selector}</span> : null}
    {digest ? (
      <span
        style={{ fontSize: 10, color: MUTED, fontFamily: "monospace" }}
        title="ERC-8213 byte-level fingerprint — verify this matches on your other device."
      >
        digest {short(digest)}
      </span>
    ) : null}
  </div>
);

// Flatten field groups (ERC-7730 arrays / bundles) into a single ordered list
// for the compact card view.
function flatten(fields: Field[]): Field[] {
  const out: Field[] = [];
  for (const f of fields) {
    if (Array.isArray(f.fields)) out.push(...flatten(f.fields));
    else out.push(f);
  }
  return out;
}

// Client-side digest so the error fallback still shows something useful even if
// the server never answered. keccak isn't bundled here, so just show the raw
// selector-ish prefix — the server digest is preferred when present.
function digestFromData(data?: string): string | null {
  return data && data.length >= 10 ? `${data.slice(0, 10)}…(selector)` : null;
}
