"use client";

import { Button } from "~~/components/ui";

// Step-two modal that opens after the user clicks [Sign in with Passkey]
// on the JoinCard. Lets them pick between an existing passkey (browser
// picker) or creating a fresh one. Auto-skipped on later visits once
// JoinCard has a remembered credential id in localStorage.

export type PasskeyChooserModalProps = {
  open: boolean;
  busy?: boolean;
  onSelectExisting: () => void;
  onSelectCreate: () => void;
  onClose: () => void;
};

export const PasskeyChooserModal = ({
  open,
  busy = false,
  onSelectExisting,
  onSelectCreate,
  onClose,
}: PasskeyChooserModalProps) => {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10500,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 360,
          maxWidth: "92vw",
          background: "#0a0612",
          border: "1px solid rgba(255,62,201,0.4)",
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontSize: 13,
            textAlign: "center",
          }}
        >
          Sign in with passkey
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button variant="primary" onClick={onSelectExisting} disabled={busy} style={{ width: "100%" }}>
            Use Existing Passkey
          </Button>
          <Button onClick={onSelectCreate} disabled={busy} style={{ width: "100%" }}>
            Create New Passkey
          </Button>
        </div>

        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--slop-text-muted)",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            cursor: busy ? "default" : "pointer",
            padding: 0,
            marginTop: 4,
          }}
        >
          cancel
        </button>
      </div>
    </div>
  );
};

export default PasskeyChooserModal;
