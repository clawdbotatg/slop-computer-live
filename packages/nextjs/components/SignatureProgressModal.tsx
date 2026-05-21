"use client";

import { LoadingBar } from "~~/components/ui";

// Modal that walks the user through the two-prompt passkey dance with a
// progress bar so the back-to-back browser sheets feel intentional
// instead of clunky. Each `stage` corresponds to one of the passkey
// utility's `onStage` calls.

export type ProgressMode = "existing" | "create";
export type ProgressStage = "first" | "second" | "verify";

const PROGRESS_PCT: Record<ProgressStage, number> = {
  first: 20,
  second: 60,
  verify: 90,
};

const COPY: Record<ProgressMode, { title: string; stages: Record<ProgressStage, string> }> = {
  existing: {
    title: "Collecting Two Passkey Signatures...",
    stages: {
      first: "Please pick a passkey and sign...",
      second: "Triangulating cryptography, second signature please...",
      verify: "Math is mathing...",
    },
  },
  create: {
    title: "Creating Passkey + Signing In...",
    stages: {
      first: "Forging a new passkey...",
      second: "Got it — now sign the server nonce...",
      verify: "Math is mathing...",
    },
  },
};

export type SignatureProgressModalProps = {
  open: boolean;
  mode: ProgressMode;
  stage: ProgressStage;
};

export const SignatureProgressModal = ({ open, mode, stage }: SignatureProgressModalProps) => {
  if (!open) return null;
  const copy = COPY[mode];
  const pct = PROGRESS_PCT[stage];
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 11000,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 460,
          maxWidth: "92vw",
          background: "#0a0612",
          border: "1px solid rgba(255,62,201,0.4)",
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontSize: 13,
            color: "var(--slop-text)",
          }}
        >
          {copy.title}
        </div>

        <LoadingBar cells={20} progress={pct} />

        <div
          style={{
            fontSize: 13,
            color: "var(--slop-text-muted)",
            minHeight: 18,
          }}
        >
          {copy.stages[stage]}
        </div>
      </div>
    </div>
  );
};

export default SignatureProgressModal;
