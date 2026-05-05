import type { Bands } from "~~/utils/blockieBands";

type BandFlagProps = {
  bands: Bands;
  width?: number;
  height?: number;
};

/**
 * Tiny three-stripe swatch matching the wrist-band colors painted on a
 * peer's cursor. Used inline with their <Address /> in the guest list.
 */
export const BandFlag = ({ bands, width = 14, height = 16 }: BandFlagProps) => (
  <span
    aria-hidden
    style={{
      display: "inline-block",
      width,
      height,
      flexShrink: 0,
      borderRadius: 2,
      overflow: "hidden",
      border: "1px solid rgba(0,0,0,0.6)",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.15)",
      background: `linear-gradient(${bands.band1} 0%, ${bands.band1} 33.33%, ${bands.band2} 33.33%, ${bands.band2} 66.66%, ${bands.band3} 66.66%, ${bands.band3} 100%)`,
    }}
  />
);

export default BandFlag;
