"use client";

import { useEffect } from "react";
import { WalletAppWindow } from "~~/components/desktop/WalletAppWindow";
import { TitleBar } from "~~/components/ui/TitleBar";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// The personal Wallet is single-player: a purely LOCAL overlay, NOT a shared
// mesh window. Only the user who opened it ever sees it — opening it never
// touches the relay, so it isn't broadcast to peers (contrast SharedAppWindow,
// whose open/close bit fans out to everyone). Same pattern as
// AudioShareDialog / VideoShareDialog: a fixed full-viewport backdrop driven
// by local useState in Desktop, closed by the × / backdrop click / Escape.
//
// The body just reuses WalletAppWindow (which already adapts per-viewer to the
// passkey multisig or connected EOA), hosted here in our own titled panel
// instead of the mesh window chrome.

export function WalletDialog({
  mesh,
  myAddress,
  myHandle,
  onClose,
}: {
  mesh: PeerMeshState;
  myAddress: string | null;
  myHandle?: string | null;
  onClose: () => void;
}) {
  // Escape closes — a focused modal wants it; the share dialogs predate this
  // but there's no reason to omit it here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={e => {
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
      <div
        className="slop-bevel-out"
        style={{
          background: "var(--slop-panel)",
          width: "min(480px, 100%)",
          height: "min(640px, 90vh)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <TitleBar title="WALLET" active onClose={onClose} showDots />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <WalletAppWindow mesh={mesh} myAddress={myAddress} myHandle={myHandle} />
        </div>
      </div>
    </div>
  );
}

export default WalletDialog;
