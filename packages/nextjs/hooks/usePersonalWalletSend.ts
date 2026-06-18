"use client";

import { useCallback, useState } from "react";
import { usePersonalWallet } from "./usePersonalWallet";
import type { Address, Hex } from "viem";
import { base } from "viem/chains";
import { usePublicClient } from "wagmi";
import { MultisigAbi } from "~~/contracts/multisig";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";
import { getStoredPasskeyIdentity, signMultisigExecWithPasskey } from "~~/utils/passkey";

// Spend from a passkey "personal wallet" — the missing piece that makes the
// counterfactual personal multisig actually spendable (docs/PASSKEY-WALLET.md
// §6/§7). A passkey user has no EOA and no ETH for gas, so we:
//   1. ensure the multisig is deployed (it needs code to run execTransaction),
//   2. read its nonce + compute the exec hash, prompt the passkey to sign it,
//   3. hand the signed exec to the relay facilitator, which broadcasts
//      execTransaction from its hot wallet and pays the gas.
// Returns the on-chain tx hash; the caller waits for the receipt as usual.
// Base-only — personal wallets live on Base and the facilitator sponsors Base.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

export type PersonalSendPhase = "deploying" | "signing" | "broadcasting" | null;

export function usePersonalWalletSend() {
  const pw = usePersonalWallet();
  const publicClient = usePublicClient({ chainId: base.id });
  const [phase, setPhase] = useState<PersonalSendPhase>(null);

  /** Send `valueWei` ETH from the personal wallet to `to` on Base. Resolves to
   *  the broadcast tx hash; throws (with a user-readable message) on failure. */
  const send = useCallback(
    async ({ to, valueWei }: { to: Address; valueWei: bigint }): Promise<`0x${string}`> => {
      if (!pw.isPasskey || !pw.personalAddress || !pw.passkeyAddress || !pw.passkeyIdentity) {
        throw new Error("no passkey wallet");
      }
      if (!publicClient) throw new Error("no Base RPC client");
      const identity = getStoredPasskeyIdentity(pw.passkeyAddress);
      if (!identity?.credentialIdBase64Url) throw new Error("missing passkey credential — sign in again");

      try {
        // 1. execTransaction needs code at the wallet. Deploy on first spend.
        if (!pw.deployed) {
          setPhase("deploying");
          const slug =
            typeof window !== "undefined" ? (window.location.pathname.split("/").filter(Boolean)[0] ?? "") : "";
          const dRes = await fetch(`${RELAY_HTTP}/personal-wallet/deploy`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              qx: pw.passkeyIdentity.qx,
              qy: pw.passkeyIdentity.qy,
              credentialIdHash: pw.passkeyIdentity.credentialIdHash,
              slug,
            }),
          });
          const dj = (await dRes.json().catch(() => ({}))) as { error?: string };
          if (!dRes.ok) throw new Error(`deploy failed: ${dj.error ?? dRes.status}`);
          pw.refetchDeployed();
        }

        // 2. Read nonce, compute the exec hash, prompt the passkey to sign it.
        const nonce = (await publicClient.readContract({
          address: pw.personalAddress,
          abi: MultisigAbi,
          functionName: "nonce",
        })) as bigint;
        const deadline = defaultDeadline();
        const execHash = computeExecHash({
          chainId: base.id,
          multisig: pw.personalAddress,
          nonce,
          deadline,
          target: to,
          value: valueWei,
          data: "0x",
        });
        setPhase("signing");
        const sigData = await signMultisigExecWithPasskey({
          credentialIdBase64Url: identity.credentialIdBase64Url,
          execHash,
          qx: pw.passkeyIdentity.qx as Hex,
          qy: pw.passkeyIdentity.qy as Hex,
        });

        // 3. Facilitator broadcasts execTransaction + pays gas.
        setPhase("broadcasting");
        const res = await fetch(`${RELAY_HTTP}/personal-wallet/exec`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            multisig: pw.personalAddress,
            target: to,
            value: valueWei.toString(),
            data: "0x",
            deadline: deadline.toString(),
            signatures: [{ sigType: 1, signer: pw.passkeyAddress, data: sigData }],
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
        if (!res.ok || !j.txHash) {
          if (j.error === "wallet-not-deployed") throw new Error("Wallet not deployed yet — try again in a moment.");
          if (j.error === "value-exceeds-cap") throw new Error("Buy-in exceeds the per-tx limit for passkey wallets.");
          if (j.error === "rate-limited") throw new Error("Too many transactions — wait a moment and retry.");
          throw new Error(j.error ?? `exec failed: ${res.status}`);
        }
        return j.txHash as `0x${string}`;
      } finally {
        setPhase(null);
      }
    },
    [pw, publicClient],
  );

  return { send, phase, isPasskey: pw.isPasskey };
}
