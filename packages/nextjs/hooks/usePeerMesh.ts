"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Mesh WebRTC: every peer connects to every other peer.
// Cheap and correct up to ~3-4 peers; past that, swap for an SFU.
//
// Signaling protocol matches packages/signaling/server.js.
// Inner payload `kind` is ours: "offer" | "answer" | "ice".

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export type RemoteStream = { peerId: string; stream: MediaStream };

type Opts = { url: string; myId: string; enabled?: boolean };

type SignalPayload =
  | { kind: "offer"; sdp: RTCSessionDescriptionInit }
  | { kind: "answer"; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export function usePeerMesh({ url, myId, enabled = true }: Opts) {
  const [remotes, setRemotes] = useState<RemoteStream[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pcsRef = useRef(new Map<string, RTCPeerConnection>());
  const localStreamsRef = useRef<Set<MediaStream>>(new Set());

  const sendSignal = useCallback((to: string, payload: SignalPayload) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", to, payload }));
    }
  }, []);

  // initiator=true → we drive renegotiation. Avoids glare on simultaneous offers.
  const getOrCreatePC = useCallback(
    (peerId: string, initiator: boolean) => {
      const existing = pcsRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcsRef.current.set(peerId, pc);

      for (const stream of localStreamsRef.current) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }

      pc.onicecandidate = e => {
        if (e.candidate) sendSignal(peerId, { kind: "ice", candidate: e.candidate.toJSON() });
      };

      pc.ontrack = e => {
        const [stream] = e.streams;
        if (!stream) return;
        setRemotes(prev => (prev.some(r => r.stream.id === stream.id) ? prev : [...prev, { peerId, stream }]));
        stream.onremovetrack = () => {
          if (stream.getTracks().length === 0) {
            setRemotes(prev => prev.filter(r => r.stream.id !== stream.id));
          }
        };
      };

      pc.onnegotiationneeded = async () => {
        if (!initiator) return;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (pc.localDescription) sendSignal(peerId, { kind: "offer", sdp: pc.localDescription.toJSON() });
        } catch (err) {
          console.error("[mesh] negotiation failed", err);
        }
      };

      return pc;
    },
    [sendSignal],
  );

  const closePC = useCallback((peerId: string) => {
    const pc = pcsRef.current.get(peerId);
    if (!pc) return;
    pc.close();
    pcsRef.current.delete(peerId);
    setRemotes(prev => prev.filter(r => r.peerId !== peerId));
  }, []);

  const addLocalStream = useCallback((stream: MediaStream) => {
    if (localStreamsRef.current.has(stream)) return;
    localStreamsRef.current.add(stream);
    for (const pc of pcsRef.current.values()) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
  }, []);

  const removeLocalStream = useCallback((stream: MediaStream) => {
    if (!localStreamsRef.current.delete(stream)) return;
    const tracks = new Set(stream.getTracks());
    for (const pc of pcsRef.current.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && tracks.has(sender.track)) pc.removeTrack(sender);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled || !myId) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", id: myId }));
        setConnected(true);
      };

      ws.onmessage = async ev => {
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }

        if (msg.type === "peers" && Array.isArray(msg.peers)) {
          for (const peerId of msg.peers as string[]) {
            const pc = getOrCreatePC(peerId, true);
            try {
              const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
              await pc.setLocalDescription(offer);
              if (pc.localDescription) sendSignal(peerId, { kind: "offer", sdp: pc.localDescription.toJSON() });
            } catch (err) {
              console.error("[mesh] initial offer failed", err);
            }
          }
          return;
        }

        if (msg.type === "peer_leave" && typeof msg.id === "string") {
          closePC(msg.id);
          return;
        }

        if (msg.type === "signal" && typeof msg.from === "string") {
          const from = msg.from;
          const payload = msg.payload as SignalPayload;
          const pc = getOrCreatePC(from, false);
          try {
            if (payload.kind === "offer") {
              await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              if (pc.localDescription) sendSignal(from, { kind: "answer", sdp: pc.localDescription.toJSON() });
            } else if (payload.kind === "answer") {
              await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            } else if (payload.kind === "ice") {
              await pc.addIceCandidate(payload.candidate);
            }
          } catch (err) {
            console.error("[mesh] signal handling failed", err);
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      for (const pc of pcsRef.current.values()) pc.close();
      pcsRef.current.clear();
      setRemotes([]);
      setConnected(false);
    };
  }, [url, myId, enabled, getOrCreatePC, closePC, sendSignal]);

  return { remotes, connected, addLocalStream, removeLocalStream };
}
