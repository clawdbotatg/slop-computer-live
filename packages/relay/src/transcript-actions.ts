// Formatters for the in-room action lines the relay narrates into the
// transcript (see Transcript.appendAction). Kept in one place because the
// capture points are split across index.ts (music/chess/wallet, where the
// actor comes from the live WS session `info`) and room.ts (file/pong,
// where the actor comes from a stored ownerKey). The actor's name is baked
// into the rendered `text` so the JSONL archive reads on its own.

import type { MusicSnapshot } from "./music-state.js";

/** Identity bits an action row carries so the UI can colour it by actor. */
export type ActionActor = { address: string | null; handle: string | null; anonId?: string | null };

/** 0xabcd…1234 — never the full 42 chars in a one-liner. */
export function shortHex(addr: string | null | undefined): string | null {
  if (!addr) return null;
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Best display name for an actor: handle, else short address, else "someone". */
export function actorName(a: { handle?: string | null; address?: string | null }): string {
  const h = a.handle?.trim();
  if (h) return h;
  return shortHex(a.address ?? null) ?? "someone";
}

const CHAIN_LABELS: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  11155111: "Sepolia",
  84532: "Base Sepolia",
};

export function chainLabel(chainId: number): string {
  return CHAIN_LABELS[chainId] ?? `chain ${chainId}`;
}

/** wei (decimal string) → human ETH amount, up to 4 decimals, trimmed.
 *  Sub-0.0001 ETH but non-zero renders as "<0.0001" so dust isn't shown
 *  as a misleading "0". Exact wei is preserved in the row's `meta`. */
export function formatEth(weiStr: string): string {
  let wei: bigint;
  try {
    wei = BigInt(weiStr);
  } catch {
    return "0";
  }
  if (wei === 0n) return "0";
  const WEI_PER_ETH = 1_000_000_000_000_000_000n;
  const whole = wei / WEI_PER_ETH;
  const frac = wei % WEI_PER_ETH;
  if (frac === 0n) return whole.toString();
  const fracStr = ((frac * 10000n) / WEI_PER_ETH).toString().padStart(4, "0").replace(/0+$/, "");
  if (!fracStr) return whole === 0n ? "<0.0001" : whole.toString();
  return `${whole}.${fracStr}`;
}

/** "1.2 MB" / "734 KB" / "512 B". */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Split a stored ownerKey (lowercased address ?? handle ?? peerId) back
 *  into the {address, anonId} the transcript colours by. */
export function ownerKeyActor(ownerKey: string, label: string): ActionActor {
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(ownerKey);
  return {
    address: isAddr ? ownerKey.toLowerCase() : null,
    handle: label || null,
    anonId: isAddr ? null : ownerKey,
  };
}

/** Best-effort track name for a music snapshot. Genres/playlists don't
 *  carry a title, so fall back to the 1-based index; a real filename in
 *  the URL gets quoted. */
export function musicTrackLabel(s: Pick<MusicSnapshot, "src" | "index">): string {
  if (s.src) {
    try {
      const u = new URL(s.src);
      const base = decodeURIComponent(u.pathname.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
      if (base && base.length <= 60) return `“${base}”`;
    } catch {
      /* not a URL — fall through */
    }
  }
  return `track #${s.index + 1}`;
}
