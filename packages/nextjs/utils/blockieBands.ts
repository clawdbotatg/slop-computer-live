import { bloImage } from "blo";

/**
 * Three deterministic colors derived from a peer's identity, matching
 * the same palette their blockie identicon uses:
 *   band1 = main pattern color
 *   band2 = spot/accent color
 *   band3 = background color
 *
 * Same algorithm as slop-computer-two/utils/themeColors so all the slop
 * apps end up looking like the same person across surfaces.
 */
export type Bands = { band1: string; band2: string; band3: string };

const NEUTRAL_BANDS: Bands = {
  band1: "#7a7a7a",
  band2: "#5c5c5c",
  band3: "#404040",
};

const hsl = (a: ArrayLike<number>) => `hsl(${a[0]}, ${a[1]}%, ${a[2]}%)`;

/**
 * Hash an arbitrary string into a 0x-prefixed 40-char hex so we can
 * feed handle-auth users (no real address) into the same blockie palette
 * function. Determinism matters more than cryptographic strength.
 */
function hashToFakeAddress(seed: string): `0x${string}` {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const bytes: number[] = [];
  let v = h >>> 0;
  for (let i = 0; i < 20; i++) {
    v = (Math.imul(v, 1664525) + 1013904223) >>> 0;
    bytes.push((v >>> 24) & 0xff);
  }
  return ("0x" + bytes.map(b => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

export function bandsFromAddress(address: `0x${string}` | null | undefined): Bands {
  if (!address) return NEUTRAL_BANDS;
  try {
    const [, palette] = bloImage(address);
    return {
      band1: hsl(palette[1]), // main pattern
      band2: hsl(palette[2]), // spot
      band3: hsl(palette[0]), // background
    };
  } catch {
    return NEUTRAL_BANDS;
  }
}

export function bandsFromIdentity(opts: {
  address?: string | null;
  handle?: string | null;
  fallback?: string | null;
}): Bands {
  if (opts.address && /^0x[0-9a-fA-F]{40}$/.test(opts.address)) {
    return bandsFromAddress(opts.address as `0x${string}`);
  }
  const seed = opts.handle ?? opts.fallback ?? null;
  if (!seed) return NEUTRAL_BANDS;
  return bandsFromAddress(hashToFakeAddress(seed));
}
