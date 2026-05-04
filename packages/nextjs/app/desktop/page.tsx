"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { LocalStreamHandle, MyCameraControls } from "~~/components/desktop/MyCamera";
import { WhosHere } from "~~/components/desktop/WhosHere";
import { Bevel, Button, MenuBar, Window } from "~~/components/ui";
import Cursor from "~~/components/ui/Cursor";
import { type Publication, type SlotPosition, usePeerMesh } from "~~/hooks/usePeerMesh";
import { sessionLabel, shortAddress, useSession } from "~~/hooks/useSession";

export const dynamic = "force-dynamic";

const DEFAULT_W = 360;
const DEFAULT_H = 260;
const DEFAULT_BASE_X = 80;
const DEFAULT_BASE_Y = 280;
const DEFAULT_STEP = 30;

// Slot id is stable for host streams (so position persists across reloads).
// Guest stream slots are tied to the current streamId — positions don't
// persist across publish/unpublish, but they DO persist while the publisher
// stays connected (since the WS+publication outlives a stream id).
function slotIdFor(pub: Publication): string {
  if (pub.kind === "camera" || pub.kind === "screen") {
    // Host? We don't actually know which peer is the host here without extra
    // metadata; the relay enforces the host-ness server-side. We use a
    // per-peer slot id so the layout is stable per-publisher.
    return `peer-${pub.peerId}-${pub.kind}`;
  }
  return `peer-${pub.peerId}-${pub.streamId}`;
}

const Desktop: NextPage = () => {
  const { session, loading } = useSession();

  const selfHint = useMemo(() => {
    if (!session.authenticated) return null;
    return { role: session.role, address: session.address, handle: session.handle };
  }, [session]);

  const mesh = usePeerMesh(session.authenticated, selfHint);
  const isHost = session.authenticated && session.isAdmin;

  const [streams, setStreams] = useState<LocalStreamHandle[]>([]);

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

  const addStream = useCallback(
    (h: LocalStreamHandle) => {
      setStreams(prev => (prev.some(s => s.id === h.id) ? prev : [...prev, h]));
      mesh.publish(h.stream, h.kind === "screen" ? "screen" : "camera", myLabel);
    },
    [mesh, myLabel],
  );

  const stopStream = useCallback(
    (id: string) => {
      setStreams(prev => {
        const target = prev.find(s => s.id === id);
        if (target) {
          mesh.unpublish(id);
          target.stream.getTracks().forEach(t => t.stop());
        }
        return prev.filter(s => s.id !== id);
      });
    },
    [mesh],
  );

  // Default slot position for a new publication that doesn't have one yet.
  const defaultSlot = useCallback(
    (slotId: string, index: number): SlotPosition => ({
      id: slotId,
      x: DEFAULT_BASE_X + index * DEFAULT_STEP,
      y: DEFAULT_BASE_Y + index * DEFAULT_STEP,
      width: DEFAULT_W,
      height: DEFAULT_H,
      z: 5 + index,
    }),
    [],
  );

  // Build the rendered window list from publications + slots.
  // Order: by slot z (asc).
  const windows = useMemo(() => {
    return mesh.publications
      .map((pub, i) => {
        const slotId = slotIdFor(pub);
        const slot = mesh.slots[slotId] ?? defaultSlot(slotId, i);
        return { pub, slotId, slot };
      })
      .sort((a, b) => a.slot.z - b.slot.z);
  }, [mesh.publications, mesh.slots, defaultSlot]);

  // Resolve the live MediaStream for a publication.
  const streamFor = useCallback(
    (pub: Publication): MediaStream | null => {
      if (pub.peerId === mesh.myId) {
        const local = streams.find(s => s.stream.id === pub.streamId);
        return local?.stream ?? null;
      }
      return mesh.remoteStreams.get(pub.streamId) ?? null;
    },
    [mesh.myId, mesh.remoteStreams, streams],
  );

  // ---- Slot editing — host only ------------------------------------------
  const moveSlot = useCallback(
    (slotId: string, x: number, y: number) => {
      if (!isHost) return;
      mesh.updateSlot({ id: slotId, x, y });
    },
    [isHost, mesh],
  );

  const resizeSlot = useCallback(
    (slotId: string, x: number, y: number, width: number, height: number) => {
      if (!isHost) return;
      mesh.updateSlot({ id: slotId, x, y, width, height });
    },
    [isHost, mesh],
  );

  const focusSlot = useCallback(
    (slotId: string) => {
      if (!isHost) return;
      const maxZ = Math.max(0, ...Object.values(mesh.slots).map(s => s.z), 5);
      mesh.updateSlot({ id: slotId, z: maxZ + 1 });
    },
    [isHost, mesh],
  );

  // Closing a window means: stop publishing if it's mine. Otherwise no-op.
  const closeWindow = useCallback(
    (pub: Publication) => {
      if (pub.peerId === mesh.myId) {
        const local = streams.find(s => s.stream.id === pub.streamId);
        if (local) stopStream(local.id);
      }
    },
    [mesh.myId, streams, stopStream],
  );

  // Persist a default slot the first time we see a new publication on host.
  useEffect(() => {
    if (!isHost) return;
    let i = 0;
    for (const pub of mesh.publications) {
      const slotId = slotIdFor(pub);
      if (!mesh.slots[slotId]) {
        mesh.updateSlot(defaultSlot(slotId, i));
      }
      i++;
    }
  }, [isHost, mesh, mesh.publications, mesh.slots, defaultSlot]);

  // Title prefix per kind.
  const titleFor = (pub: Publication) => {
    const verb = pub.kind === "screen" ? "SCREEN" : "CAMERA";
    return `${verb} — ${pub.label || peerLabel(pub.peerId)}`;
  };

  const remoteCursors = useMemo(() => {
    const result: Array<{ peerId: string; x: number; y: number; label: string }> = [];
    Object.entries(mesh.cursors).forEach(([peerId, pos]) => {
      if (peerId !== mesh.myId) result.push({ peerId, ...pos, label: peerLabel(peerId) });
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

        {/* Shared windows — one per active publication. Same on every peer. */}
        {windows.map(({ pub, slotId, slot }) => {
          const stream = streamFor(pub);
          return (
            <Window
              key={`${pub.peerId}-${pub.streamId}`}
              title={titleFor(pub)}
              x={slot.x}
              y={slot.y}
              width={slot.width}
              height={slot.height}
              zIndex={slot.z}
              onFocus={() => focusSlot(slotId)}
              onClose={pub.peerId === mesh.myId ? () => closeWindow(pub) : undefined}
              onMove={({ x, y }) => moveSlot(slotId, x, y)}
              onResize={({ x, y, width, height }) => resizeSlot(slotId, x, y, width, height)}
              bodyStyle={{ padding: 0, overflow: "hidden" }}
            >
              {stream ? (
                <video
                  autoPlay
                  playsInline
                  muted={pub.peerId === mesh.myId}
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

        {/* Local-only utility panels — not synced. */}
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

        {remoteCursors.map(({ peerId, x, y, label }) => (
          <Cursor key={peerId} x={x} y={y} label={label} />
        ))}
      </div>
    </>
  );
};

export default Desktop;
