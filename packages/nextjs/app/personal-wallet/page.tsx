"use client";

import { PersonalWalletCard } from "~~/components/PersonalWalletCard";

// Phase-0 test surface for the passkey personal wallet (docs/PASSKEY-WALLET.md).
// Standalone page so we can prove derive → show → receive without touching the
// desktop UI. Sign in with a passkey on the main app first (shared origin →
// shared session cookie + passkey localStorage), then open this page.

export default function PersonalWalletTestPage() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div>
        <h1 style={{ fontFamily: "var(--slop-font, monospace)", fontSize: 16, marginBottom: 12, textAlign: "center" }}>
          Personal wallet (Phase 0)
        </h1>
        <PersonalWalletCard />
      </div>
    </div>
  );
}
