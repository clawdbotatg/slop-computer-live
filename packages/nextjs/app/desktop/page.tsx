"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { LocalStreamHandle, MyCameraControls, StreamView } from "~~/components/desktop/MyCamera";
import { WhosHere } from "~~/components/desktop/WhosHere";
import { Bevel, Button, MenuBar, Window } from "~~/components/ui";
import { sessionLabel, shortAddress, useSession } from "~~/hooks/useSession";
import { useSignalSocket } from "~~/hooks/useSignalSocket";

type WinDef = {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  bodyStyle?: React.CSSProperties;
  body: React.ReactNode;
};

const Desktop: NextPage = () => {
  const { session, loading } = useSession();

  const selfHint = useMemo(() => {
    if (!session.authenticated) return null;
    return { role: session.role, address: session.address, handle: session.handle };
  }, [session]);

  const presence = useSignalSocket(session.authenticated, selfHint);

  const [streams, setStreams] = useState<LocalStreamHandle[]>([]);
  const [topZ, setTopZ] = useState(10);

  const addStream = useCallback((h: LocalStreamHandle) => {
    setStreams(prev => (prev.some(s => s.id === h.id) ? prev : [...prev, h]));
  }, []);

  const stopStream = useCallback((id: string) => {
    setStreams(prev => {
      const target = prev.find(s => s.id === id);
      target?.stream.getTracks().forEach(t => t.stop());
      return prev.filter(s => s.id !== id);
    });
  }, []);

  const myLabel = session.authenticated
    ? (session.handle ?? (session.address ? shortAddress(session.address) : "you"))
    : "guest";

  const baseWindows: WinDef[] = useMemo(() => {
    const list: WinDef[] = [];
    if (session.authenticated) {
      list.push({
        id: "my-camera",
        title: `MY CAMERA — ${myLabel}`,
        x: 40,
        y: 40,
        width: 360,
        height: 220,
        zIndex: 1,
        body: <MyCameraControls onStream={addStream} onStop={stopStream} />,
      });
      list.push({
        id: "whos-here",
        title: "WHO'S HERE",
        x: 420,
        y: 40,
        width: 280,
        height: 240,
        zIndex: 2,
        body: <WhosHere myId={presence.myId} peers={presence.peers} connected={presence.connected} />,
      });
    }
    streams.forEach((s, i) => {
      list.push({
        id: `stream-${s.id}`,
        title: `${s.kind === "screen" ? "SCREEN SHARE" : "MY CAMERA"} — ${myLabel}`,
        x: 80 + i * 30,
        y: 280 + i * 30,
        width: 360,
        height: 260,
        zIndex: 3 + i,
        bodyStyle: { padding: 0 },
        body: <StreamView stream={s.stream} muted onStop={() => stopStream(s.id)} />,
      });
    });
    return list;
  }, [
    session.authenticated,
    myLabel,
    presence.myId,
    presence.peers,
    presence.connected,
    streams,
    addStream,
    stopStream,
  ]);

  const [zMap, setZMap] = useState<Record<string, number>>({});
  const focus = (id: string) => {
    setTopZ(z => z + 1);
    setZMap(m => ({ ...m, [id]: topZ + 1 }));
  };
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const close = (id: string) => {
    if (id.startsWith("stream-")) {
      const streamId = id.slice("stream-".length);
      stopStream(streamId);
    }
    setClosed(c => ({ ...c, [id]: true }));
  };

  const windows = baseWindows
    .filter(w => !closed[w.id])
    .map(w => (zMap[w.id] !== undefined ? { ...w, zIndex: zMap[w.id] } : w));

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
        {!loading && !session.authenticated ? (
          <div
            style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <Bevel style={{ padding: 20, maxWidth: 420 }}>
              <h2 style={{ margin: 0, fontFamily: "var(--slop-font-display)", textTransform: "uppercase" }}>
                You&apos;re not signed in
              </h2>
              <p style={{ color: "var(--slop-text-muted)" }}>
                Sign in with Ethereum or with the show&apos;s guest password to publish your camera and see who else is
                on the desktop.
              </p>
              <p style={{ color: "var(--slop-text-muted)", fontSize: 12 }}>Status: {sessionLabel(session)}</p>
              <Link href="/join" style={{ textDecoration: "none" }}>
                <Button variant="primary">Go to /join</Button>
              </Link>
            </Bevel>
          </div>
        ) : null}

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
            bodyStyle={w.bodyStyle ?? { padding: 0 }}
          >
            {w.body}
          </Window>
        ))}
      </div>
    </>
  );
};

export default Desktop;
