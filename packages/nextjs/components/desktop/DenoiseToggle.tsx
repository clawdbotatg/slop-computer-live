"use client";

// Shared "Reduce background noise" toggle for the audio + video share
// dialogs. The actual pipeline (RNNoise WASM) lives in
// `~~/utils/noiseSuppression.ts`; this is just the checkbox UX. Default
// ON; flipping it off persists `slop-pref-denoise=0` in localStorage.
// Applies on the next acquire, so the user has to re-share for the
// change to take effect — UI hint says so.

export type DenoiseToggleProps = {
  denoise: boolean;
  setDenoise: (next: boolean) => void;
};

export const DenoiseToggle = ({ denoise, setDenoise }: DenoiseToggleProps) => {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 12,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <input
        type="checkbox"
        checked={denoise}
        onChange={e => setDenoise(e.target.checked)}
        style={{ cursor: "pointer" }}
      />
      <span style={{ fontSize: 12, color: "var(--slop-text)" }}>Reduce background noise</span>
    </label>
  );
};
