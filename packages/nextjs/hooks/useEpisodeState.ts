"use client";

import { useEffect, useState } from "react";
import { withSlug } from "~~/lib/slug";

// Subscribes to the relay's per-room episode flag stream (currently just
// `sttOn`, but built to grow). Opens an EventSource against
// /v1/episode/stream?slug=<slug>, emits the latest state on every flip.
// Falls back to a one-shot GET if SSE is unavailable.

export type EpisodeState = {
  sttOn: boolean;
  captionsOn: boolean;
};

// captionsOn defaults to TRUE — they're on by default, the toggle is
// for muting. sttOn stays false until the server confirms (matching
// the old default; god-mode reads it for STT enable, conservative).
const DEFAULT_STATE: EpisodeState = { sttOn: false, captionsOn: true };

export function useEpisodeState(relayHttpUrl: string, slug: string): EpisodeState {
  const [state, setState] = useState<EpisodeState>(DEFAULT_STATE);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    const apply = (partial: Partial<EpisodeState>) => {
      setState(prev => {
        const next = { ...prev };
        if (typeof partial.sttOn === "boolean") next.sttOn = partial.sttOn;
        if (typeof partial.captionsOn === "boolean") next.captionsOn = partial.captionsOn;
        return next;
      });
    };

    // Best-effort one-shot fetch so we have a value before SSE settles.
    fetch(withSlug(`${relayHttpUrl}/v1/episode`, slug), { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then((data: Partial<EpisodeState> | null) => {
        if (cancelled || !data) return;
        apply(data);
      })
      .catch(() => {
        /* SSE will retry */
      });

    try {
      es = new EventSource(withSlug(`${relayHttpUrl}/v1/episode/stream`, slug), { withCredentials: true });
      const parse = (raw: string) => {
        try {
          apply(JSON.parse(raw) as Partial<EpisodeState>);
        } catch {
          /* ignore malformed */
        }
      };
      es.addEventListener("init", e => parse((e as MessageEvent).data));
      es.addEventListener("episode", e => parse((e as MessageEvent).data));
    } catch {
      /* SSE construction can throw in older browsers; one-shot fetch covers us */
    }

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [relayHttpUrl, slug]);

  return state;
}
