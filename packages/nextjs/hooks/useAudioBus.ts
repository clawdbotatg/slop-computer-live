"use client";

import { useEffect, useRef } from "react";
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

/** One source the broadcast mix is SUPPOSED to contain. */
export type BusStreamEntry = { id: string; label: string; stream: MediaStream };

// How often the reconciler re-checks. Fast enough that nobody notices a
// gap, cheap enough to be invisible next to the 10Hz levels loop.
const RECONCILE_INTERVAL_MS = 1000;

// The safety net under `useAudioBusStream`.
//
// Per-component registration is fast but fragile: it only ever fires if
// the component MOUNTS, and mounting requires the relay's `pub.streamId`
// and the WebRTC MSID to be the same string (Desktop's `streamFor` joins
// them by exact match). Every link in that chain is one-shot — miss one
// and a human is silently absent from the broadcast until somebody
// notices and reloads. That has now happened twice (2026-08-05,
// 2026-08-07). See docs/BROADCAST-AUDIO-ROUTING.md.
//
// So instead of patching links one at a time, this declares the desired
// state and converges on it: anything in `wanted` that isn't correctly
// on the bus gets registered, anything on the bus under `ownedPrefix`
// that isn't wanted gets dropped. Failure modes we haven't thought of
// yet cost ~1s of audio instead of half a show.
//
// Owned by a always-mounted component (Desktop), NOT by the per-peer
// leaf components — the whole point is to not care about the view tree.
export function useAudioBusReconciler(wanted: BusStreamEntry[], ownedPrefix: string, enabled: boolean): void {
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  // Registration is keyed on the stream OBJECT, not just the id — a
  // replaceTrack swap hands out a new object under the same id and the
  // old source node keeps feeding silence, so the object identity has to
  // be part of what makes this effect re-run promptly.
  const key = wanted.map(w => `${w.id}@${w.stream.id}`).join("|");

  useEffect(() => {
    if (!enabled) return;
    const bus = audioBus();
    const tick = () => {
      const entries = wantedRef.current;
      const wantedIds = new Set<string>();
      for (const { id, label, stream } of entries) {
        if (!id) continue;
        // Claim the id even when we can't register yet, so the prune
        // below doesn't rip out a pub whose audio track is still in
        // flight (WebRTC delivers video and audio as separate ontrack
        // events on the same stream).
        wantedIds.add(id);
        if (stream.getAudioTracks().length === 0) continue;
        if (bus.isStreamRegistered(id, stream)) continue;
        // Either absent, or present but built from a stale stream.
        // unregister first: registerStream no-ops on a known id.
        bus.unregister(id);
        // A false return (bus not active yet, createMediaStreamSource
        // threw) just means we try again next tick — the retry is the
        // entire point. Registering is idempotent once it succeeds, so
        // this does not churn the auto-leveler's per-source state.
        bus.registerStream(stream, id, label);
      }
      for (const id of bus.sourceIds()) {
        // Only prune what we own. "music" / "preview-*" belong to their
        // own components and must survive.
        if (!id.startsWith(ownedPrefix)) continue;
        if (wantedIds.has(id)) continue;
        bus.unregister(id);
      }
    };
    tick();
    const timer = setInterval(tick, RECONCILE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [key, ownedPrefix, enabled]);
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
