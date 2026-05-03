"use client";

import { shortAddress } from "~~/hooks/useSession";
import type { Peer } from "~~/hooks/useSignalSocket";

type Props = {
  myId: string | null;
  peers: Peer[];
  connected: boolean;
};

const labelOf = (p: Peer) => p.handle ?? (p.address ? shortAddress(p.address) : p.id.slice(0, 6));

export const WhosHere = ({ myId, peers, connected }: Props) => {
  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
      <p style={{ margin: 0, color: "var(--slop-text-muted)" }}>
        relay: {connected ? <span style={{ color: "#7be88a" }}>connected</span> : <span>offline</span>}
      </p>
      {peers.length === 0 ? (
        <p style={{ margin: 0, color: "var(--slop-text-muted)" }}>just you so far.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {peers.map(p => {
            const isMe = p.id === myId;
            return (
              <li
                key={p.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "2px 4px",
                  background: isMe ? "rgba(255,62,201,0.08)" : undefined,
                }}
              >
                <span style={{ fontWeight: p.role === "host" ? 600 : undefined }}>
                  {p.role === "host" ? "★ " : ""}
                  {labelOf(p)}
                  {isMe ? " (you)" : ""}
                </span>
                <span style={{ color: "var(--slop-text-muted)" }}>{p.role}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
