"use client";

import { useEffect } from "react";
import type { RefObject } from "react";
import { ACTIVATED_EVENT } from "./useUserGesture";
import { AUDIO_BUS_CHANNEL, type BusInboundMessage, type BusOutboundMessage, audioBus } from "~~/utils/audioBus";

// Drives the shared audio bus on the god-mode (spectator) tab. Mount
// this ONCE near the top of the component tree (Desktop owns it) when
// `isGodMode` is true. It activates the singleton + resumes the
// AudioContext on the first user gesture so subsequent registers can
// connect MediaElementSourceNodes without browser autoplay refusal.
//
// Also opens the BroadcastChannel the /eq popup talks over: snapshot
// pushes on every bus mutation, and a request-snapshot ping from a
// freshly-opened popup gets an immediate reply.
//
// Non-god-mode sessions skip activation entirely — every per-element
// hook below also gates on `enabled`, so audio elements stay on their
// normal direct-to-default-output path.
export function useAudioBusOwner(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const bus = audioBus();
    bus.activate();
    const onActivated = () => bus.resume();
    window.addEventListener(ACTIVATED_EVENT, onActivated);

    // BroadcastChannel isn't in older Safari, so feature-check.
    const BC = typeof BroadcastChannel === "undefined" ? null : BroadcastChannel;
    const channel = BC ? new BC(AUDIO_BUS_CHANNEL) : null;
    let unsub: (() => void) | null = null;
    if (channel) {
      // Push snapshots to the popup on every mutation. subscribe()
      // fires once immediately so the popup gets initial state if
      // we connect after it asked.
      unsub = bus.subscribe(snap => {
        const msg: BusOutboundMessage = { type: "snapshot", snapshot: snap };
        try {
          channel.postMessage(msg);
        } catch {
          /* channel closed */
        }
      });
      // Apply mutations from the popup.
      channel.onmessage = (ev: MessageEvent<BusInboundMessage>) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object") return;
        switch (msg.type) {
          case "request-snapshot": {
            const out: BusOutboundMessage = { type: "snapshot", snapshot: bus.snapshot() };
            try {
              channel.postMessage(out);
            } catch {
              /* channel closed */
            }
            break;
          }
          case "set-source-gain":
            bus.setSourceGain(msg.id, msg.gain);
            break;
          case "set-source-muted":
            bus.setSourceMuted(msg.id, msg.muted);
            break;
          case "set-band-gain":
            bus.setBandGain(msg.bandIndex, msg.db);
            break;
          case "set-master-gain":
            bus.setMasterGain(msg.gain);
            break;
          case "reset-eq":
            bus.resetEq();
            break;
        }
      };
    }

    return () => {
      window.removeEventListener(ACTIVATED_EVENT, onActivated);
      unsub?.();
      try {
        channel?.close();
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);
}

// Register an HTMLMediaElement with the bus while `enabled` is true.
// `id` should be stable per source (streamId for peers, "music" for
// the music player, `preview-${fileId}` for previews). `label` is the
// human-readable name shown in the /eq popup row.
//
// Takes a ref object (not a plain element) so the effect can read
// `.current` after React has committed the ref — passing the element
// itself from render would always see null on first mount.
//
// IMPORTANT: createMediaElementSource is one-way per element. Once
// connected, an element's audio is permanently routed through that
// AudioContext. We never unwrap — `unregister` just disconnects the
// per-source GainNode so the element falls silent in the bus mix.
export function useAudioBusElement<T extends HTMLMediaElement>(
  ref: RefObject<T | null>,
  id: string,
  label: string,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const bus = audioBus();
    const ok = bus.registerElement(el, id, label);
    if (!ok) return;
    return () => {
      bus.unregister(id);
    };
    // ref is stable across renders; we only re-register when the
    // identity inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, label, enabled]);

  // Keep the label fresh if it changes without re-mounting.
  useEffect(() => {
    if (!enabled) return;
    audioBus().setSourceLabel(id, label);
  }, [id, label, enabled]);
}
