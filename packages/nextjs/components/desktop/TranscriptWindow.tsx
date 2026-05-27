"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { type Bands, bandsFromIdentity } from "~~/utils/blockieBands";

// Toggle the room-wide captions overlay (the auto-rising line that
// SubtitleCaption paints over the desktop). Anyone in the room can
// flip — the endpoint enforces a room-scoped auth check. Optimistic
// state is upstream (episode SSE flips the prop within a tick of the
// POST landing), so we don't track local pending state here.
async function postCaptionsOn(relayHttpUrl: string, slug: string, on: boolean): Promise<void> {
  try {
    await fetch(withSlug(`${relayHttpUrl}/v1/episode/captions`, slug), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    });
  } catch {
    /* network blip — next click retries, episode SSE will re-sync truth */
  }
}

type TranscriptSegment = {
  id: string;
  ts: number;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  text: string;
  source: "live" | "spectator" | "agent";
  // Set ⇒ a relay-narrated in-room action (music/file/wallet/chess/pong).
  // The actor's name is baked into `text`, so action rows render as a
  // single accent-coloured line instead of the speech name+body layout.
  kind?: "speech" | "music" | "file" | "wallet" | "chess" | "pong";
  meta?: Record<string, string | number | boolean | null>;
};

// SharedAppWindow only mounts this component while the window is open,
// so polling is automatically scoped to "when the user is looking at it".
// Closed windows generate no traffic — pick the cadence based purely on
// how live it should feel when someone has it on screen.
const POLL_MS = 1500;

export type TranscriptWindowProps = {
  relayHttpUrl: string;
  customNames: Record<string, string>;
  mesh: PeerMeshState;
  /** Room-wide captions overlay flag. Drives the toggle button in the
   *  footer; anyone in the room can flip it. */
  captionsOn: boolean;
};

export const TranscriptWindow = ({ relayHttpUrl, customNames, mesh, captionsOn }: TranscriptWindowProps) => {
  const slug = useRoomSlug();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Same auto-stick-to-bottom pattern as ChatWindow: only yank to the
  // bottom on a new segment if the user was already near it; mid-scroll
  // users keep their place.
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [segments.length]);

  // Multiplayer scroll sync: when one peer scrolls back through the
  // transcript, the room follows. Composes with the stick-to-bottom
  // logic above — both onScroll branches run on every scroll event.
  const syncedOnScroll = useSyncedScroll(mesh, "transcript", listRef);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    syncedOnScroll();
  };

  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      try {
        const res = await fetch(withSlug(`${relayHttpUrl}/v1/transcript`, slug), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { segments: TranscriptSegment[] };
        if (!alive) return;
        setSegments(data.segments ?? []);
        setError(null);
        setLoaded(true);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      }
    };
    void fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [relayHttpUrl, slug]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      <div
        ref={listRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {!loaded ? (
          <EmptyNote>loading transcript…</EmptyNote>
        ) : segments.length === 0 ? (
          <EmptyNote>waiting for someone to speak…</EmptyNote>
        ) : (
          segments.map(s => <SegmentRow key={s.id} seg={s} customNames={customNames} />)
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderTop: "1px solid var(--slop-bevel-light, #4a4a4a)",
          fontFamily: "var(--slop-font-display)",
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--slop-text-muted)",
        }}
      >
        <span>captions</span>
        <button
          type="button"
          onClick={() => void postCaptionsOn(relayHttpUrl, slug, !captionsOn)}
          title={
            captionsOn
              ? "subtitle overlay is ON for everyone in the room — click to hide"
              : "subtitle overlay is OFF for everyone in the room — click to show"
          }
          style={{
            cursor: "pointer",
            padding: "2px 10px",
            border: "1px solid var(--slop-bevel-light, #4a4a4a)",
            fontFamily: "var(--slop-font-display)",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            background: captionsOn ? "var(--slop-magenta, #ff3ec9)" : "transparent",
            color: captionsOn ? "var(--slop-bg, #06030d)" : "var(--slop-text)",
          }}
        >
          {captionsOn ? "On" : "Off"}
        </button>
        <span style={{ flex: 1 }} />
        {error ? (
          <span style={{ color: "var(--slop-accent-warn, #f66)", textTransform: "none", letterSpacing: 0 }}>
            fetch error: {error}
          </span>
        ) : null}
      </div>
    </div>
  );
};

const EmptyNote = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      color: "var(--slop-text-muted)",
      fontSize: 12,
      fontStyle: "italic",
      padding: 12,
      textAlign: "center",
    }}
  >
    {children}
  </div>
);

const SegmentRow = ({ seg, customNames }: { seg: TranscriptSegment; customNames: Record<string, string> }) => {
  const bands = useMemo<Bands>(
    () =>
      bandsFromIdentity({
        address: seg.address,
        anonId: seg.anonId,
        handle: seg.handle,
        fallback: seg.id,
      }),
    [seg.address, seg.anonId, seg.handle, seg.id],
  );
  const sourceTag = seg.source === "agent" ? "AGENT" : seg.source === "spectator" ? "SPECTATOR" : null;

  // Action row: the actor's name is already inside `text`, so render one
  // compact italic line accent-coloured by the actor — no name chip, no
  // source tag. Visually reads as a "something happened" event vs speech.
  if (seg.kind && seg.kind !== "speech") {
    return (
      <div style={{ display: "flex", gap: 8, opacity: 0.9 }}>
        <div
          aria-hidden
          style={{
            width: 3,
            minWidth: 3,
            alignSelf: "stretch",
            background: bands.band1,
            boxShadow: `0 0 6px ${bands.band1}`,
            borderRadius: 1,
          }}
        />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            lineHeight: 1.4,
            fontStyle: "italic",
            color: "var(--slop-text-muted)",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          {seg.text}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        opacity: seg.source === "spectator" ? 0.85 : 1,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 3,
          minWidth: 3,
          alignSelf: "stretch",
          background: bands.band1,
          boxShadow: `0 0 6px ${bands.band1}`,
          borderRadius: 1,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: bands.band1,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          <SlopAddress
            address={seg.address}
            handle={seg.handle}
            anonId={seg.anonId}
            fallback={seg.id}
            customNames={customNames}
          />
          {sourceTag ? (
            <span
              style={{
                fontSize: 9,
                padding: "0 4px",
                color: "var(--slop-text-muted)",
                border: "1px solid var(--slop-bevel-light, #4a4a4a)",
                letterSpacing: "0.06em",
              }}
            >
              {sourceTag}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.4,
            color: "var(--slop-text)",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          {seg.text}
        </div>
      </div>
    </div>
  );
};

export default TranscriptWindow;
