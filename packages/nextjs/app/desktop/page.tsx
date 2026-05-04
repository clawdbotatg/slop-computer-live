"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { LocalStreamHandle, MyCameraControls } from "~~/components/desktop/MyCamera";
import { WhosHere } from "~~/components/desktop/WhosHere";
import { Bevel, Button, MenuBar, Window } from "~~/components/ui";
import Cursor from "~~/components/ui/Cursor";
import { type WindowState, usePeerMesh } from "~~/hooks/usePeerMesh";
import { sessionLabel, shortAddress, useSession } from "~~/hooks/useSession";

export const dynamic = "force-dynamic";

const SHARED_DEFAULT_W = 360;
const SHARED_DEFAULT_H = 260;
const SHARED_OFFSET_BASE_X = 80;
const SHARED_OFFSET_BASE_Y = 280;
const SHARED_OFFSET_STEP = 30;

const Desktop: NextPage = () => {
  const { session, loading } = useSession();

  const selfHint = useMemo(() => {
    if (!session.authenticated) return null;
    return { role: session.role, address: session.address, handle: session.handle };
  }, [session]);

  const mesh = usePeerMesh(session.authenticated, selfHint);
  const isHost = session.authenticated && session.isAdmin;

  const [streams, setStreams] = useState<LocalStreamHandle[]>([]);

  const addStream = useCallback(
    (h: LocalStreamHandle) => {
      setStreams(prev => (prev.some(s => s.id === h.id) ? prev : [...prev, h]));
      mesh.addLocalStream(h.stream);
    },
    [mesh],
  );

  const stopStream = useCallback(
    (id: string) => {
      setStreams(prev => {
        const target = prev.find(s => s.id === id);
        if (target) {
          mesh.removeLocalStream(target.stream);
          target.stream.getTracks().forEach(t => t.stop());
        }
        return prev.filter(s => s.id !== id);
      });
    },
    [mesh],
  );

  const myLabel = session.authenticated
    ? (session.handle ?? (session.address ? shortAddress(session.address) : "you"))
    : "guest";

  const peerLabel = useCallback(
    (peerId: string): string => {
      const peer = mesh.peers.find(p => p.id === peerId);
      if (!peer) return peerId.slice(0, 6);
      if (peer.handle) return peer.handle;
      if (peer.address) return shortAddress(peer.address);
      return peerId.slice(0, 6);
    },
    [mesh.peers],
  );

  // ---- Host: declare shared windows for every visible stream --------------
  // Window IDs are stable across host reloads:
  //   host-camera, host-screen        — host's own streams
  //   peer-<peerId>-camera            — guest streams (peerId is ephemeral; GC'd on leave)
  // Only the host (admin) has authority to create/move/close shared windows.
  useEffect(() => {
    if (!isHost || !mesh.myId) return;

    const ensure = (id: string, base: Partial<WindowState>) => {
      const existing = mesh.windows[id];
      if (existing) {
        // Window exists from a previous session — re-bind ownerPeerId to the
        // current session so streamForWindow() can find the live MediaStream.
        if (base.ownerPeerId && existing.ownerPeerId !== base.ownerPeerId) {
          mesh.updateWindow({ id, ownerPeerId: base.ownerPeerId, ownerLabel: base.ownerLabel ?? null });
        }
        return;
      }
      const offset = Object.keys(mesh.windows).length;
      mesh.updateWindow({
        id,
        kind: "camera",
        title: id,
        x: SHARED_OFFSET_BASE_X + offset * SHARED_OFFSET_STEP,
        y: SHARED_OFFSET_BASE_Y + offset * SHARED_OFFSET_STEP,
        width: SHARED_DEFAULT_W,
        height: SHARED_DEFAULT_H,
        z: 5 + offset,
        open: true,
        ownerPeerId: null,
        ownerLabel: null,
        ...base,
      });
    };

    for (const s of streams) {
      const isCam = s.kind === "cam";
      ensure(isCam ? "host-camera" : "host-screen", {
        kind: isCam ? "camera" : "screen",
        ownerPeerId: mesh.myId,
        ownerLabel: myLabel,
        title: `${isCam ? "CAMERA" : "SCREEN"} — ${myLabel}`,
      });
    }

    mesh.remoteStreams.forEach((_stream, peerId) => {
      ensure(`peer-${peerId}-camera`, {
        kind: "remote",
        ownerPeerId: peerId,
        ownerLabel: peerLabel(peerId),
        title: `CAMERA — ${peerLabel(peerId)}`,
      });
    });
  }, [isHost, mesh, mesh.myId, mesh.remoteStreams, mesh.windows, streams, myLabel, peerLabel]);

  // Host: GC only guest-owned windows whose owner has disconnected.
  // Host's own windows (host-camera, host-screen) are persistent — they survive
  // reload and stay even when host hasn't re-published the stream yet.
  useEffect(() => {
    if (!isHost) return;
    const peerIds = new Set(mesh.peers.map(p => p.id));
    for (const w of Object.values(mesh.windows)) {
      if (!w.id.startsWith("peer-")) continue;
      if (w.ownerPeerId && !peerIds.has(w.ownerPeerId)) mesh.removeWindow(w.id);
    }
  }, [isHost, mesh, mesh.peers, mesh.windows]);

  // Find the live MediaStream for a given window (own or remote).
  const streamForWindow = useCallback(
    (w: WindowState): MediaStream | null => {
      if (w.id === "host-camera") return streams.find(s => s.kind === "cam")?.stream ?? null;
      if (w.id === "host-screen") return streams.find(s => s.kind === "screen")?.stream ?? null;
      if (!w.ownerPeerId) return null;
      return mesh.remoteStreams.get(w.ownerPeerId) ?? null;
    },
    [mesh.remoteStreams, streams],
  );

  // ---- Window manipulation handlers (host only writes; guests no-op) ------
  const focusWindow = useCallback(
    (w: WindowState) => {
      if (!isHost) return;
      const maxZ = Math.max(0, ...Object.values(mesh.windows).map(x => x.z));
      if (w.z >= maxZ) return;
      mesh.updateWindow({ id: w.id, z: maxZ + 1 });
    },
    [isHost, mesh],
  );

  const closeWindow = useCallback(
    (w: WindowState) => {
      if (!isHost) return;
      // Closing a host stream window also stops the underlying stream.
      if (w.id === "host-camera") {
        streams.filter(s => s.kind === "cam").forEach(s => stopStream(s.id));
      } else if (w.id === "host-screen") {
        streams.filter(s => s.kind === "screen").forEach(s => stopStream(s.id));
      }
      mesh.removeWindow(w.id);
    },
    [isHost, mesh, stopStream, streams],
  );

  const moveWindow = useCallback(
    (w: WindowState, x: number, y: number) => {
      if (!isHost) return;
      mesh.updateWindow({ id: w.id, x, y });
    },
    [isHost, mesh],
  );

  const resizeWindow = useCallback(
    (w: WindowState, x: number, y: number, width: number, height: number) => {
      if (!isHost) return;
      mesh.updateWindow({ id: w.id, x, y, width, height });
    },
    [isHost, mesh],
  );

  // Render the shared window list.
  const sharedWindows = useMemo(
    () =>
      Object.values(mesh.windows)
        .filter(w => w.open)
        .sort((a, b) => a.z - b.z),
    [mesh.windows],
  );

  // Local-only utility windows (camera controls + who's here) are pinned.
  const remoteCursors = useMemo(() => {
    const result: Array<{ peerId: string; x: number; y: number; label: string }> = [];
    Object.entries(mesh.cursors).forEach(([peerId, pos]) => {
      if (peerId !== mesh.myId) {
        result.push({ peerId, ...pos, label: peerLabel(peerId) });
      }
    });
    return result;
  }, [mesh.cursors, mesh.myId, peerLabel]);

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

        {/* Shared windows — same on every connected peer's screen. */}
        {sharedWindows.map(w => {
          const stream = streamForWindow(w);
          return (
            <Window
              key={w.id}
              title={w.title}
              x={w.x}
              y={w.y}
              width={w.width}
              height={w.height}
              zIndex={w.z}
              onFocus={() => focusWindow(w)}
              onClose={() => closeWindow(w)}
              onMove={({ x, y }) => moveWindow(w, x, y)}
              onResize={({ x, y, width, height }) => resizeWindow(w, x, y, width, height)}
              bodyStyle={{ padding: 0, overflow: "hidden" }}
            >
              {stream ? (
                <video
                  autoPlay
                  playsInline
                  muted={w.ownerPeerId === mesh.myId}
                  ref={el => {
                    if (el && el.srcObject !== stream) el.srcObject = stream;
                  }}
                  style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000", display: "block" }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    background: "#000",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--slop-text-muted)",
                    fontSize: 12,
                  }}
                >
                  waiting for stream…
                </div>
              )}
            </Window>
          );
        })}

        {/* Local-only utilities — fixed-position panels, not synced across peers. */}
        {session.authenticated ? (
          <>
            <Window
              title={`MY CAMERA — ${myLabel}`}
              x={40}
              y={40}
              width={360}
              height={220}
              zIndex={1}
              bodyStyle={{ padding: 0 }}
            >
              <MyCameraControls onStream={addStream} onStop={stopStream} />
            </Window>
            <Window title="WHO'S HERE" x={420} y={40} width={280} height={240} zIndex={2} bodyStyle={{ padding: 0 }}>
              <WhosHere myId={mesh.myId} peers={mesh.peers} connected={mesh.connected} />
            </Window>
          </>
        ) : null}

        {/* Remote peer cursors */}
        {remoteCursors.map(({ peerId, x, y, label }) => (
          <Cursor key={peerId} x={x} y={y} label={label} />
        ))}
      </div>
    </>
  );
};

export default Desktop;
