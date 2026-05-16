"use client";

import { useEffect, useState } from "react";

// Subscribes to the relay's per-episode flag stream (currently just
// `sttOn`, but built to grow). Opens an EventSource against
// /v1/episode/stream, emits the latest state on every flip. Falls back to
// a one-shot GET if SSE is unavailable.

export type EpisodeState = {
  sttOn: boolean;
};

const DEFAULT_STATE: EpisodeState = { sttOn: false };

export function useEpisodeState(relayHttpUrl: string): EpisodeState {
  const [state, setState] = useState<EpisodeState>(DEFAULT_STATE);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    // Best-effort one-shot fetch so we have a value before SSE settles.
    fetch(`${relayHttpUrl}/v1/episode`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then((data: EpisodeState | null) => {
        if (cancelled || !data) return;
        if (typeof data.sttOn === "boolean") setState({ sttOn: data.sttOn });
      })
      .catch(() => {
        /* SSE will retry */
      });

    try {
      es = new EventSource(`${relayHttpUrl}/v1/episode/stream`, { withCredentials: true });
      const apply = (raw: string) => {
        try {
          const data = JSON.parse(raw) as Partial<EpisodeState>;
          if (typeof data.sttOn === "boolean") setState({ sttOn: data.sttOn });
        } catch {
          /* ignore malformed */
        }
      };
      es.addEventListener("init", e => apply((e as MessageEvent).data));
      es.addEventListener("episode", e => apply((e as MessageEvent).data));
    } catch {
      /* SSE construction can throw in older browsers; one-shot fetch covers us */
    }

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [relayHttpUrl]);

  return state;
}
