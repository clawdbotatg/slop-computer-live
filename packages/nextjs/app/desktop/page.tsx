"use client";

import { useState } from "react";
import type { NextPage } from "next";
import { MenuBar, Window } from "~~/components/ui";

type WinDef = {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  body: React.ReactNode;
};

const PlaceholderCam = ({ label }: { label: string }) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      background: "repeating-linear-gradient(45deg, #1f1f1f, #1f1f1f 6px, #161616 6px, #161616 12px)",
      color: "var(--slop-text-muted)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "var(--slop-font-display)",
      letterSpacing: "0.04em",
      textTransform: "uppercase",
    }}
  >
    {label}
  </div>
);

const INITIAL: WinDef[] = [
  {
    id: "host",
    title: "Host — webcam",
    x: 60,
    y: 60,
    width: 360,
    height: 240,
    zIndex: 1,
    body: <PlaceholderCam label="host cam preview" />,
  },
  {
    id: "guest-1",
    title: "Guest 1",
    x: 460,
    y: 90,
    width: 300,
    height: 200,
    zIndex: 2,
    body: <PlaceholderCam label="guest 1" />,
  },
  {
    id: "guest-2",
    title: "Guest 2",
    x: 200,
    y: 340,
    width: 300,
    height: 200,
    zIndex: 3,
    body: <PlaceholderCam label="guest 2" />,
  },
];

const Desktop: NextPage = () => {
  const [windows, setWindows] = useState(INITIAL);
  const [topZ, setTopZ] = useState(INITIAL.length);

  const focus = (id: string) => {
    setTopZ(z => z + 1);
    setWindows(ws => ws.map(w => (w.id === id ? { ...w, zIndex: topZ + 1 } : w)));
  };

  const close = (id: string) => setWindows(ws => ws.filter(w => w.id !== id));

  return (
    <>
      <MenuBar isLive={false} />
      <div
        style={{
          position: "fixed",
          inset: 0,
          paddingTop: 22,
          background: "radial-gradient(ellipse at 30% 40%, #2a0030 0%, #1a0a3a 40%, #0a0520 100%)",
          overflow: "hidden",
        }}
      >
        {windows.map(w => (
          <Window
            key={w.id}
            title={w.title}
            x={w.x}
            y={w.y}
            width={w.width}
            height={w.height}
            zIndex={w.zIndex}
            onFocus={() => focus(w.id)}
            onClose={() => close(w.id)}
            bodyStyle={{ padding: 0 }}
          >
            {w.body}
          </Window>
        ))}
      </div>
    </>
  );
};

export default Desktop;
