"use client";

import { useEnsAvatar, useEnsName } from "wagmi";
import { mainnet } from "~~/scaffold.config";

// Two-step ENS resolve: address → primary name → avatar. Each step is
// individually cached by wagmi so multiple components asking about the
// same peer share one network round-trip. ipfs://, ar://, eip155: NFT
// lookups, etc. are all unwrapped by useEnsAvatar into a usable HTTPS
// URL — we just consume the result.
export function useEnsAvatarFromAddress(address: string | null | undefined): string | null {
  const { data: name } = useEnsName({
    address: (address ?? undefined) as `0x${string}` | undefined,
    chainId: mainnet.id,
    query: { enabled: !!address },
  });
  const { data: avatar } = useEnsAvatar({
    name: name ?? undefined,
    chainId: mainnet.id,
    query: { enabled: !!name },
  });
  return avatar ?? null;
}
