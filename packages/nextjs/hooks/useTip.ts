"use client";

import { useCallback } from "react";
import { parseEther } from "viem";
import type { Address as AddressType } from "viem";
import { useAccount, useChainId, useSendTransaction, useSwitchChain } from "wagmi";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// Chains a /tip can target — mirrors scaffold.config targetNetworks and the
// relay's TIP_CHAIN_LABELS. Names map to chainId; "eth"/"ether" are the
// token, NOT a chain (so "0.001 base eth" → chain=base).
const CHAIN_BY_NAME: Record<string, number> = {
  base: 8453,
  ethereum: 1,
  mainnet: 1,
  gnosis: 100,
  xdai: 100,
};
const CHAIN_LABELS: Record<number, string> = { 1: "Ethereum", 8453: "Base", 100: "Gnosis" };
const NOISE = new Set(["eth", "ether", "on", "the", "room", "to", "tip", "of"]);
const DEFAULT_CHAIN = 8453; // Base

// Cheap, free, instant parse of the clean case ("0.001 base eth"). Returns
// null for anything fuzzy so the caller falls back to the (rate-limited) AI
// parser. Bails on ambiguity (two numbers, two chains, unknown words).
export function parseTipFast(text: string): { amountEth: string; chainId: number } | null {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let amountEth: string | null = null;
  let chainId: number | null = null;
  for (const w of words) {
    if (/^[0-9]*\.?[0-9]+$/.test(w)) {
      if (amountEth) return null;
      amountEth = w;
    } else if (w in CHAIN_BY_NAME) {
      if (chainId) return null;
      chainId = CHAIN_BY_NAME[w] ?? null;
    } else if (!NOISE.has(w)) {
      return null;
    }
  }
  if (!amountEth || Number(amountEth) <= 0) return null;
  return { amountEth, chainId: chainId ?? DEFAULT_CHAIN };
}

// `/tip <text>` from chat: parse → switch chain → pop the wallet to send ETH
// to the room multisig → announce. `notify` surfaces progress as local chat
// notices. Wallet popup + signing is all wagmi; the relay never touches keys.
export function useTip(mesh: PeerMeshState): (arg: string, notify: (text: string) => void) => Promise<void> {
  const { address } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  return useCallback(
    async (arg: string, notify: (text: string) => void) => {
      const multisig = mesh.wallet?.address;
      if (!multisig) {
        notify("🏦 no room wallet deployed yet — nothing to tip.");
        return;
      }
      if (!address) {
        notify("🔌 connect your wallet first, then /tip.");
        return;
      }

      let parsed = parseTipFast(arg);
      if (!parsed) {
        notify("🤔 reading your tip…");
        const res = await mesh.tipParse(arg);
        if (!res.ok) {
          notify(res.error);
          return;
        }
        parsed = { amountEth: res.amountEth, chainId: res.chainId };
      }

      const { amountEth, chainId } = parsed;
      const label = CHAIN_LABELS[chainId] ?? `chain ${chainId}`;
      notify(`⏳ preparing tip of ${amountEth} ETH on ${label}…`);

      try {
        const value = parseEther(amountEth);
        if (currentChainId !== chainId) {
          await switchChainAsync({ chainId });
        }
        const hash = await sendTransactionAsync({
          to: multisig as AddressType,
          value,
          chainId,
        });
        notify(`✓ tipped ${amountEth} ETH on ${label} — ${hash.slice(0, 10)}…`);
        mesh.tipAnnounce(amountEth, chainId);
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        // The common case is the user rejecting the wallet prompt.
        notify(/reject|denied|cancel/i.test(m) ? "tip cancelled." : `tip failed: ${m.slice(0, 120)}`);
      }
    },
    [mesh, address, currentChainId, switchChainAsync, sendTransactionAsync],
  );
}
