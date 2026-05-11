"use client";

import { Bevel, Button } from "~~/components/ui";

// Second-layer gate: shown to authenticated users who haven't produced
// any user gesture yet this page-load. Forces a click so Chrome's
// autoplay policy will let the music player + any other audio start.
//
// Sits on top of the desktop with the same blur treatment as the
// PasswordGate, so it visually reads as "one more thing to confirm."
// Unlike PasswordGate it asks for nothing — just a tap.

export function EntryGate({ onEnter }: { onEnter: () => void }) {
  return (
    <Bevel style={{ padding: 24, width: "min(360px, 92vw)", textAlign: "center" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-mark.png"
        alt="slop"
        width={84}
        height={84}
        style={{ display: "block", margin: "0 auto 16px", imageRendering: "pixelated" }}
      />
      <h2
        style={{
          margin: 0,
          marginBottom: 8,
          fontFamily: "var(--slop-font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontSize: 18,
        }}
      >
        Welcome back
      </h2>
      <p style={{ color: "var(--slop-text-muted)", fontSize: 12, marginTop: 0, marginBottom: 16 }}>
        Click to enter the slop computer.
        <br />
        Your browser needs a tap before it will play audio.
      </p>
      <Button variant="primary" onClick={onEnter}>
        Enter
      </Button>
    </Bevel>
  );
}

export default EntryGate;
