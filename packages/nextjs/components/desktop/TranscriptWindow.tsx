"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { type Bands, bandsFromIdentity } from "~~/utils/blockieBands";

type TranscriptSegment = {
  id: string;
  ts: number;
  address: string | null;
  handle: string | null;
  anonId?: string | null;
  text: string;
  source: "live" | "spectator" | "agent";
};

// SharedAppWindow only mounts this component while the window is open,
// so polling is automatically scoped to "when the user is looking at it".
// Closed windows generate no traffic — pick the cadence based purely on
// how live it should feel when someone has it on screen.
const POLL_MS = 1500;

export type TranscriptWindowProps = {
  relayHttpUrl: string;
  customNames: Record<string, string>;
};

export const TranscriptWindow = ({ relayHttpUrl, customNames }: TranscriptWindowProps) => {
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

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
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
      {error ? (
        <div
          style={{
            padding: "4px 8px",
            fontSize: 10,
            color: "var(--slop-accent-warn, #f66)",
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.04em",
            borderTop: "1px solid var(--slop-bevel-light, #4a4a4a)",
          }}
        >
          fetch error: {error}
        </div>
      ) : null}
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
