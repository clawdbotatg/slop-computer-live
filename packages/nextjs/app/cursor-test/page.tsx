"use client";

import { useEffect, useState } from "react";
import { Address } from "@scaffold-ui/components";
import { BandFlag, Cursor, MenuBar, Window } from "~~/components/ui";
import { useLocalCursor } from "~~/hooks/useLocalCursor";
import { bandsFromIdentity } from "~~/utils/blockieBands";

type Slot = { id: string; title: string; x: number; y: number; width: number; height: number; z: number };

const INITIAL: Slot[] = [
  { id: "a", title: "Test window A", x: 80, y: 80, width: 360, height: 240, z: 10 },
  { id: "b", title: "Test window B", x: 480, y: 140, width: 320, height: 220, z: 11 },
  { id: "c", title: "Test window C", x: 220, y: 360, width: 400, height: 200, z: 12 },
];

// Three fake remote cursors so we can preview the dimmed + <Address /> label
// + per-peer band colors without needing a live mesh peer. Slow-orbits.
const FAKE_REMOTES: Array<{ id: string; address: string; handle?: string; cx: number; cy: number; r: number }> = [
  { id: "atg", address: "0x34aA3F359A9D614239015126635CE7732c18fDF3", cx: 600, cy: 360, r: 140 },
  { id: "vitalik", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", cx: 800, cy: 240, r: 180 },
  { id: "anon", address: "", handle: "slop-fan", cx: 300, cy: 200, r: 100 },
];

// Local user has clawdbotatg's address so we can sanity check that "you" gets
// its own band palette too.
const LOCAL_ADDRESS = "0x11ce532845cE0EAcDA41F72FdC1c88c335981442";

export default function CursorTestPage() {
  const [slots, setSlots] = useState(INITIAL);
  const { pos, kind } = useLocalCursor();
  const [t, setT] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setT(v => v + 0.04), 33);
    return () => clearInterval(i);
  }, []);

  const update = (id: string, patch: Partial<Slot>) =>
    setSlots(s => s.map(w => (w.id === id ? { ...w, ...patch } : w)));

  const focus = (id: string) =>
    setSlots(s => {
      const maxZ = Math.max(...s.map(w => w.z));
      const w = s.find(w => w.id === id);
      if (!w || w.z === maxZ) return s;
      return s.map(w => (w.id === id ? { ...w, z: maxZ + 1 } : w));
    });

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
      <MenuBar />
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

      {slots.map(s => (
        <Window
          key={s.id}
          title={s.title}
          x={s.x}
          y={s.y}
          width={s.width}
          height={s.height}
          zIndex={s.z}
          onFocus={() => focus(s.id)}
          onMove={p => update(s.id, p)}
          onResize={r => update(s.id, r)}
          onClose={() => setSlots(prev => prev.filter(p => p.id !== s.id))}
          containerInset={{ top: 38 }}
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

      {FAKE_REMOTES.map((p, i) => {
        const phase = t + i * 1.7;
        const fx = p.cx + Math.cos(phase) * p.r;
        const fy = p.cy + Math.sin(phase) * p.r;
        const bands = bandsFromIdentity({ address: p.address || null, handle: p.handle ?? null, fallback: p.id });
        return (
          <Cursor
            key={p.id}
            x={fx}
            y={fy}
            dimmed
            bands={bands}
            label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {p.handle ? (
                  <span>{p.handle}</span>
                ) : (
                  <Address address={p.address as `0x${string}`} size="xs" onlyEnsOrAddress />
                )}
                <BandFlag bands={bands} />
              </span>
            }
          />
        );
      })}

      {pos ? <Cursor x={pos.x} y={pos.y} kind={kind} bands={bandsFromIdentity({ address: LOCAL_ADDRESS })} /> : null}
    </div>
  );
}
