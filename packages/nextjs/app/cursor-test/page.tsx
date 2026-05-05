"use client";

import { useState } from "react";
import { Cursor, Window } from "~~/components/ui";
import { useLocalCursor } from "~~/hooks/useLocalCursor";

type Slot = { id: string; title: string; x: number; y: number; width: number; height: number };

const INITIAL: Slot[] = [
  { id: "a", title: "Test window A", x: 80, y: 80, width: 360, height: 240 },
  { id: "b", title: "Test window B", x: 480, y: 140, width: 320, height: 220 },
  { id: "c", title: "Test window C", x: 220, y: 360, width: 400, height: 200 },
];

export default function CursorTestPage() {
  const [slots, setSlots] = useState(INITIAL);
  const { pos, kind } = useLocalCursor();

  const update = (id: string, patch: Partial<Slot>) =>
    setSlots(s => s.map(w => (w.id === id ? { ...w, ...patch } : w)));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--slop-base)",
        overflow: "hidden",
        cursor: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          color: "var(--slop-text)",
          fontFamily: "monospace",
          fontSize: 12,
          background: "rgba(0,0,0,0.6)",
          padding: "8px 12px",
          border: "1px dashed #00ffe1",
          maxWidth: 480,
        }}
      >
        <div style={{ color: "#00ffe1", marginBottom: 4 }}>cursor hitbox tester</div>
        <div>• hover empty space → pointer</div>
        <div>• hover titlebar → grab</div>
        <div>• mousedown on titlebar / corner → grabbing</div>
        <div>• hover input below → text</div>
        <div style={{ marginTop: 8 }}>arrows nudge active hotspot · shift = ±5 · Enter logs values</div>
        <input
          placeholder="text-cursor area"
          style={{
            marginTop: 8,
            padding: "4px 8px",
            fontFamily: "monospace",
            background: "var(--slop-panel)",
            color: "var(--slop-text)",
            border: "1px solid var(--slop-bevel-light)",
            width: "100%",
          }}
        />
      </div>

      {slots.map((s, i) => (
        <Window
          key={s.id}
          title={s.title}
          x={s.x}
          y={s.y}
          width={s.width}
          height={s.height}
          zIndex={10 + i}
          onMove={p => update(s.id, p)}
          onResize={r => update(s.id, r)}
          onClose={() => setSlots(prev => prev.filter(p => p.id !== s.id))}
          onMinimize={() => {}}
          onZoom={() => {}}
        >
          <div style={{ padding: 12, fontFamily: "monospace", fontSize: 12 }}>
            <div>id: {s.id}</div>
            <div>
              {Math.round(s.x)},{Math.round(s.y)} · {Math.round(s.width)}×{Math.round(s.height)}
            </div>
            <div style={{ marginTop: 8, opacity: 0.7 }}>drag the titlebar · resize from the corner</div>
          </div>
        </Window>
      ))}

      {pos ? <Cursor x={pos.x} y={pos.y} kind={kind} /> : null}
    </div>
  );
}
