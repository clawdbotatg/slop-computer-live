"use client";

// TEMPORARY verification page for LoadingBar cells="fill" — never committed.
import { useState } from "react";
import { LoadingBar } from "~~/components/ui";

export default function BarProbe() {
  const [wide, setWide] = useState(true);
  return (
    <div style={{ padding: 20, background: "#0a0618", minHeight: "100vh" }}>
      <button id="toggle" onClick={() => setWide(w => !w)}>
        toggle
      </button>
      <div id="box" style={{ width: wide ? 400 : 200, border: "1px solid #555", padding: 4 }}>
        <LoadingBar cells="fill" progress={50} />
      </div>
      <div id="fixed" style={{ marginTop: 12 }}>
        <LoadingBar cells={10} progress={50} />
      </div>
    </div>
  );
}
