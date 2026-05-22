// Client-side neural noise suppression via RNNoise (WASM).
//
// Wraps a raw mic MediaStream through an AudioWorklet running the
// RNNoise model and returns a new MediaStream carrying the *cleaned*
// audio plus any video tracks from the input passed straight through.
//
// Why on the publisher: a single denoise pass costs ~1-3% of one CPU
// core; doing it once at the mic spares every receiver from listening
// to typing/dog-bark/HVAC noise. Capping CPU there is critical because
// we already have N video encoders in this full-mesh — the mic-side
// denoise is the cheapest place to put it.
//
// Why opt-out (default on): browser built-in noise suppression handles
// stationary noise well but bombs on transient sounds (keyboards, plates,
// kids in the background). RNNoise is *meaningfully* better there. The
// rare cost: users who sing / play music will want to turn it off so
// the speech-trained model doesn't garble their audio — that's the
// "Reduce background noise" checkbox in the share dialogs.
//
// Asset hosting: the WASM + worklet ship in
// `node_modules/@sapphi-red/web-noise-suppressor/dist/`. We copy them
// into `packages/nextjs/public/noise/` once per package bump (see the
// note in package.json) so they're served at /noise/* by Next.js's
// static handler. The library autoselects the SIMD build when the
// browser supports SIMD WASM (Chrome 91+/Firefox 89+), otherwise falls
// back to plain.
// NOTE: do NOT add a static `import` of @sapphi-red/web-noise-suppressor
// here. The package's `RnnoiseWorkletNode` is declared as
// `class RnnoiseWorkletNode extends AudioWorkletNode {…}` at module
// scope — the class body is evaluated at import time, and on the SSR
// server (Node) `AudioWorkletNode` is undefined, so the page's pre-
// render throws `ReferenceError: AudioWorkletNode is not defined` and
// every /<slug> route 500s. Social-card scrapers (Twitter, Discord)
// then refuse to render unfurls. Import dynamically inside
// `denoiseStream` instead — that path only executes after a user
// interaction in the browser.
const RNNOISE_WASM_URL = "/noise/rnnoise.wasm";
const RNNOISE_SIMD_WASM_URL = "/noise/rnnoise_simd.wasm";
const RNNOISE_WORKLET_URL = "/noise/rnnoise-worklet.js";

// Cache the WASM binary across acquisitions. A single ~150KB fetch +
// compile is enough to amortize across a session's worth of start/stop
// cycles. The worklet module is similarly cached by the AudioContext
// (addModule no-ops on repeat).
let cachedWasm: ArrayBuffer | null = null;
let cachedWasmPromise: Promise<ArrayBuffer> | null = null;

async function loadWasmOnce(
  loadRnnoise: (opts: { url: string; simdUrl: string }) => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
  if (cachedWasm) return cachedWasm;
  if (!cachedWasmPromise) {
    cachedWasmPromise = loadRnnoise({
      url: RNNOISE_WASM_URL,
      simdUrl: RNNOISE_SIMD_WASM_URL,
    }).then(buf => {
      cachedWasm = buf;
      return buf;
    });
  }
  return cachedWasmPromise;
}

export type DenoisedStream = {
  /** Stream to publish — synthetic audio track + original video tracks. */
  stream: MediaStream;
  /** Tears down the audio graph AND stops the upstream raw mic.
   *  Idempotent — safe to call multiple times. The outer LocalStreamHandle
   *  stop path also stops the synthetic tracks, but they don't propagate
   *  upstream so this dispose is what actually kills the mic light. */
  dispose: () => void;
};

/**
 * Returns a denoised MediaStream wrapping `raw`. Returns `null` if the
 * environment can't support the pipeline (no AudioWorklet, sample-rate
 * coercion failed, etc.) — the caller should fall back to the raw
 * stream silently in that case so a missing worklet doesn't break the
 * audio path entirely.
 */
export async function denoiseStream(raw: MediaStream): Promise<DenoisedStream | null> {
  const audioTracks = raw.getAudioTracks();
  if (audioTracks.length === 0) return null;
  if (typeof AudioContext === "undefined") return null;
  if (typeof AudioWorkletNode === "undefined") return null;

  try {
    // Dynamic import so the `class RnnoiseWorkletNode extends AudioWorkletNode`
    // declaration only executes in the browser — see the top-of-file
    // note explaining why a static import would crash SSR.
    const { RnnoiseWorkletNode, loadRnnoise } = await import("@sapphi-red/web-noise-suppressor");

    // RNNoise is pinned at 48 kHz mono; without an explicit sampleRate
    // the AudioContext picks the device's preferred rate (44.1 kHz on
    // many laptops) and the model outputs garbled audio.
    const ctx = new AudioContext({ sampleRate: 48000 });
    const wasmBinary = await loadWasmOnce(loadRnnoise);
    await ctx.audioWorklet.addModule(RNNOISE_WORKLET_URL);

    // Source from an audio-only view of the stream so the AudioContext
    // doesn't drag any video tracks through the graph.
    const audioOnly = new MediaStream(audioTracks);
    const source = ctx.createMediaStreamSource(audioOnly);
    const rnnoise = new RnnoiseWorkletNode(ctx, {
      wasmBinary,
      maxChannels: 1,
    });
    const dest = ctx.createMediaStreamDestination();
    source.connect(rnnoise);
    rnnoise.connect(dest);

    // Build the published stream: cleaned audio first, then pass video
    // tracks through unchanged. Video latency is therefore zero; audio
    // gains ~10ms (one 480-sample frame at 48kHz) — imperceptible.
    const out = new MediaStream();
    for (const t of dest.stream.getAudioTracks()) out.addTrack(t);
    for (const t of raw.getVideoTracks()) out.addTrack(t);

    let audioStopped = false;
    // Tears down ONLY the audio path: raw mic, synthetic dest track,
    // worklet node, audio context. Leaves video tracks untouched so a
    // mic-only revoke (user yanked mic permission while camera still
    // on) keeps the camera pub alive with just a silent audio side —
    // mirrors the non-denoise behaviour where revoking the mic doesn't
    // kill the camera. Idempotent.
    const stopAudio = () => {
      if (audioStopped) return;
      audioStopped = true;
      for (const t of audioOnly.getTracks()) {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      }
      for (const t of dest.stream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      }
      try {
        rnnoise.destroy();
      } catch {
        /* ignore */
      }
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    };

    let videoStopped = false;
    const dispose = () => {
      stopAudio();
      if (videoStopped) return;
      videoStopped = true;
      for (const t of raw.getVideoTracks()) {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      }
    };

    // Cascade hardware mic revoke (user yanked it in OS settings, USB
    // unplug) into an audio-only teardown so the AudioContext doesn't
    // linger forever. We do NOT call full dispose() here — keeping
    // video alive matches the pre-denoise behaviour.
    audioTracks[0].addEventListener("ended", stopAudio);

    return { stream: out, dispose };
  } catch (err) {
    console.warn("[noiseSuppression] init failed; falling back to raw stream", err);
    return null;
  }
}
