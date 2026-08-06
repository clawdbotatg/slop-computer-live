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
    let levelsTimer: ReturnType<typeof setInterval> | null = null;
    if (channel) {
      // Stream post-gain RMS for every source ~10Hz. The auto-level
      // tick lives inside readLevels (one analyser read + scalar math
      // per source) — at 10Hz the whole loop is ~5k ops + 1
      // postMessage, well under any plausible video-codec contention.
      // Higher rates (15-20Hz) looked smoother on the meter but
      // weren't worth the additional main-thread work on a constrained
      // spectator/streaming box. Re-tuning here: the auto lerp
      // constants in audioBus.ts are baked at 10Hz; bump both in
      // lockstep if changing.
      levelsTimer = setInterval(() => {
        const levels = bus.readLevels();
        const msg: BusOutboundMessage = { type: "levels", levels };
        try {
          channel.postMessage(msg);
        } catch {
          /* channel closed */
        }
      }, 100);
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
          case "set-auto-enabled":
            bus.setAutoEnabled(msg.enabled);
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
      if (levelsTimer !== null) clearInterval(levelsTimer);
      try {
        channel?.close();
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);
}

// Register a raw MediaStream with the bus while `enabled` is true.
// Use this for WebRTC peer streams — `createMediaElementSource` on an
// `srcObject`-bound element produces silence in Chromium for stream
// inputs (a long-standing quirk), so we tap the MediaStream directly
// instead. The accompanying media element must be muted while enabled
// so the bus + the element don't both try to drive the speakers.
export function useAudioBusStream(stream: MediaStream | null, id: string, label: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (!stream) return;
    const bus = audioBus();
    let registered = false;
    const register = () => {
      if (stream.getAudioTracks().length === 0) return;
      // registerStream snapshots the stream's audio track at node
      // construction, so a track that lands after a register needs a
      // full rebuild — unregister first, sources.has(id) would no-op.
      if (registered) bus.unregister(id);
      registered = bus.registerStream(stream, id, label);
    };
    register();
    // WebRTC delivers a pub's tracks as separate ontrack events mutating
    // the SAME MediaStream object — video often first, and the mesh
    // deliberately skips the state update for a known stream identity,
    // so no re-render re-runs this effect. Without this listener a voice
    // whose audio track arrives after mount never enters the broadcast
    // mix at all (the 2026-08-05 preshow reload-roulette bug: god mode
    // heard music but not the host, until a lucky reload reordered
    // track arrival vs render).
    const onAddTrack = (ev: MediaStreamTrackEvent) => {
      if (ev.track.kind !== "audio") return;
      register();
    };
    stream.addEventListener("addtrack", onAddTrack);
    return () => {
      stream.removeEventListener("addtrack", onAddTrack);
      if (registered) bus.unregister(id);
    };
  }, [stream, id, enabled]);

  // Keep the label fresh if it changes without re-registering.
  useEffect(() => {
    if (!enabled) return;
    audioBus().setSourceLabel(id, label);
  }, [id, label, enabled]);
}

// Register an HTMLMediaElement (with an HTTP `src=`, not `srcObject`)
// with the bus while `enabled` is true. `id` should be stable per
// source ("music" for the music player, `preview-${fileId}` for
// previews). For MediaStream-bound elements use `useAudioBusStream`
// instead — see the comment there.
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
