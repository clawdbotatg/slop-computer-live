"use client";

import { useCallback, useState } from "react";
import { usePersonalWallet } from "./usePersonalWallet";
import type { Address, Hex } from "viem";
import { base } from "viem/chains";
import { usePublicClient } from "wagmi";
import { MultisigAbi } from "~~/contracts/multisig";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
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
//
// The relay only fronts gas for a caller correctly authed in the room: every
// call carries ?slug=<room> so the relay's room-auth gate engages (it checks
// the room password cookie). `useRoomSlug()` supplies the slug, so all callers
// (poker/chess buy-in, the Wallet app's Execute) get the gate for free.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

export type PersonalSendPhase = "deploying" | "signing" | "broadcasting" | null;

/** A generic personal-wallet call: an arbitrary `target`/`value`/`data` exec. */
export type PersonalExec = { target: Address; value: bigint; data?: Hex };

export function usePersonalWalletSend() {
  const pw = usePersonalWallet();
  const publicClient = usePublicClient({ chainId: base.id });
  const slug = useRoomSlug();
  const [phase, setPhase] = useState<PersonalSendPhase>(null);

  /** Execute an arbitrary contract call from the personal wallet on Base:
   *  deploy-if-needed → compute the exec hash → passkey signs → relay
   *  facilitator broadcasts execTransaction and pays the gas. Resolves to the
   *  broadcast tx hash; throws (with a user-readable message) on failure. */
  const execute = useCallback(
    async ({ target, value, data = "0x" }: PersonalExec): Promise<`0x${string}`> => {
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
          // ?slug engages the relay's room-auth gate (same as exec); slug also
          // rides in the body, where the relay reads it to pick the co-signer.
          const dRes = await fetch(withSlug(`${RELAY_HTTP}/personal-wallet/deploy`, slug), {
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
          target,
          value,
          data,
        });
        setPhase("signing");
        const sigData = await signMultisigExecWithPasskey({
          credentialIdBase64Url: identity.credentialIdBase64Url,
          execHash,
          qx: pw.passkeyIdentity.qx as Hex,
          qy: pw.passkeyIdentity.qy as Hex,
        });

        // 3. Facilitator broadcasts execTransaction + pays gas. The ?slug lets
        //    the relay's room-auth gate verify we belong to this room.
        setPhase("broadcasting");
        const res = await fetch(withSlug(`${RELAY_HTTP}/personal-wallet/exec`, slug), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            multisig: pw.personalAddress,
            target,
            value: value.toString(),
            data,
            deadline: deadline.toString(),
            signatures: [{ sigType: 1, signer: pw.passkeyAddress, data: sigData }],
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
        if (!res.ok || !j.txHash) {
          if (j.error === "wallet-not-deployed") throw new Error("Wallet not deployed yet — try again in a moment.");
          if (j.error === "value-exceeds-cap") throw new Error("Amount exceeds the per-tx limit for passkey wallets.");
          if (j.error === "rate-limited") throw new Error("Too many transactions — wait a moment and retry.");
          if (j.error === "room-required") throw new Error("Join the room first — sponsored gas needs room access.");
          if (j.error === "wallet-mismatch") throw new Error("This wallet isn't yours to spend from.");
          throw new Error(j.error ?? `exec failed: ${res.status}`);
        }
        return j.txHash as `0x${string}`;
      } finally {
        setPhase(null);
      }
    },
    [pw, publicClient, slug],
  );

  /** Send `valueWei` ETH from the personal wallet to `to` on Base. Thin wrapper
   *  over `execute` (a plain value transfer is an exec with empty calldata). */
  const send = useCallback(
    ({ to, valueWei }: { to: Address; valueWei: bigint }): Promise<`0x${string}`> =>
      execute({ target: to, value: valueWei, data: "0x" }),
    [execute],
  );

  return { send, execute, phase, isPasskey: pw.isPasskey };
}
