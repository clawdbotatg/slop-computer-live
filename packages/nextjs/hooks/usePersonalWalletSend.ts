"use client";

import { useCallback, useState } from "react";
import { usePersonalWallet } from "./usePersonalWallet";
import type { Address, Hex } from "viem";
import { base } from "viem/chains";
import { usePublicClient } from "wagmi";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { getStoredPasskeyIdentity, signSafeTxWithPasskey } from "~~/utils/passkey";
import { type Call, type SafeTx, safeAbi, safeTxHash, toSafeTx } from "~~/utils/safe";

// Spend from a passkey "personal wallet" — a Safe on Base, owners [passkey
// signer, platform cosigner], threshold 1 (ops/PLAN-safe.md phase 5). A passkey
// user has no EOA and no ETH for gas, so:
//   1. read the Safe nonce (0 before it's deployed), build the SafeTx,
//   2. prompt the passkey to sign its safeTxHash,
//   3. hand it to the relay facilitator, which deploys the Safe if needed,
//      broadcasts execTransaction from its hot wallet and pays the gas.
// Returns the on-chain tx hash; the caller waits for the receipt as usual.
//
// Every call carries ?slug=<room> so the relay's room-auth gate engages.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

export type PersonalSendPhase = "deploying" | "signing" | "broadcasting" | null;

/** A generic personal-wallet call: an arbitrary `target`/`value`/`data` exec. */
export type PersonalExec = { target: Address; value: bigint; data?: Hex };

/** A SafeTx the user has ALREADY signed (e.g. a queued tx signed in the
 *  Transactions tab). No passkey re-prompt — the sigs go straight to the relay. */
export type PersonalExecSigned = {
  tx: SafeTx;
  signatures: { sigType: number; signer: Address; data: Hex }[];
};

/** Decode a relay exec error code into a user-readable message. */
function execErrorMessage(error: string | undefined, status: number): string {
  if (error === "value-exceeds-cap") return "Amount exceeds the per-tx limit for passkey wallets.";
  if (error === "rate-limited") return "Too many transactions — wait a moment and retry.";
  if (error === "room-required") return "Join the room first — sponsored gas needs room access.";
  if (error === "passkey-mismatch") return "This wallet isn't yours to spend from.";
  if (error === "no-passkey-signature") return "Sign the transaction with your passkey first.";
  return error ?? `exec failed: ${status}`;
}

export function usePersonalWalletSend() {
  const pw = usePersonalWallet();
  const publicClient = usePublicClient({ chainId: base.id });
  const slug = useRoomSlug();
  const [phase, setPhase] = useState<PersonalSendPhase>(null);

  const post = useCallback(
    async (path: string, body: unknown) => {
      const res = await fetch(withSlug(`${RELAY_HTTP}${path}`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { res, j: (await res.json().catch(() => ({}))) as { txHash?: string; address?: string; error?: string } };
    },
    [slug],
  );

  /** Deploy the Safe now (the exec route also deploys on first spend). Checks
   *  the relay agrees on the address — a different cosigner would mean funds
   *  sent to the derived address aren't spendable. No-op once deployed. */
  const ensureDeployed = useCallback(async () => {
    if (pw.deployed) return;
    if (!pw.passkeyIdentity || !pw.personalAddress) throw new Error("no passkey wallet");
    setPhase("deploying");
    const { res, j } = await post("/personal-wallet/deploy", { qx: pw.passkeyIdentity.qx, qy: pw.passkeyIdentity.qy });
    if (!res.ok) throw new Error(`deploy failed: ${j.error ?? res.status}`);
    if (j.address?.toLowerCase() !== pw.personalAddress.toLowerCase()) {
      throw new Error("relay derived a different wallet address — not deploying");
    }
    pw.refetchDeployed();
  }, [pw, post]);

  /** Hand a signed SafeTx to the relay facilitator. Returns the tx hash. */
  const postExec = useCallback(
    async ({ tx, signatures }: PersonalExecSigned): Promise<`0x${string}`> => {
      if (!pw.passkeyIdentity || !pw.personalAddress) throw new Error("no passkey wallet");
      setPhase("broadcasting");
      const { res, j } = await post("/personal-wallet/exec", {
        qx: pw.passkeyIdentity.qx,
        qy: pw.passkeyIdentity.qy,
        tx: {
          to: tx.to,
          value: tx.value.toString(),
          data: tx.data,
          operation: tx.operation,
          nonce: tx.nonce.toString(),
        },
        signatures: signatures.map(s => ({ sigType: s.sigType, signer: s.signer, data: s.data })),
      });
      if (!res.ok || !j.txHash) throw new Error(execErrorMessage(j.error, res.status));
      if (j.address && j.address.toLowerCase() !== pw.personalAddress.toLowerCase()) {
        throw new Error("relay derived a different wallet address");
      }
      pw.refetchDeployed();
      return j.txHash as `0x${string}`;
    },
    [pw, post],
  );

  /** Execute one or more calls from the personal Safe on Base (several go out as
   *  one MultiSend batch): nonce → passkey signs the safeTxHash → relay sends +
   *  pays gas. Resolves to the broadcast tx hash; throws a readable message. */
  const executeCalls = useCallback(
    async (calls: Call[]): Promise<`0x${string}`> => {
      const { personalAddress: wallet, ownerAddress: owner } = pw;
      if (!pw.isPasskey || !wallet || !owner || !pw.passkeyAddress) throw new Error("no passkey wallet");
      if (!publicClient) throw new Error("no Base RPC client");
      const identity = getStoredPasskeyIdentity(pw.passkeyAddress);
      if (!identity?.credentialIdBase64Url) throw new Error("missing passkey credential — sign in again");
      try {
        const nonce = pw.deployed
          ? ((await publicClient.readContract({
              address: wallet,
              abi: safeAbi,
              functionName: "nonce",
            })) as bigint)
          : 0n;
        const tx = toSafeTx(calls, nonce);
        setPhase("signing");
        const data = await signSafeTxWithPasskey({
          credentialIdBase64Url: identity.credentialIdBase64Url,
          safeTxHash: safeTxHash(base.id, wallet, tx),
          owner: owner as `0x${string}`,
        });
        return await postExec({ tx, signatures: [{ sigType: 1, signer: owner, data }] });
      } finally {
        setPhase(null);
      }
    },
    [pw, publicClient, postExec],
  );

  const execute = useCallback(
    ({ target, value, data = "0x" }: PersonalExec) => executeCalls([{ to: target, value, data }]),
    [executeCalls],
  );

  /** Broadcast a SafeTx the user ALREADY signed (queued + signed in the
   *  Transactions tab). No passkey re-prompt. Resolves to the tx hash. */
  const executeSigned = useCallback(
    async (signed: PersonalExecSigned): Promise<`0x${string}`> => {
      if (!pw.isPasskey || !pw.personalAddress) throw new Error("no passkey wallet");
      if (signed.signatures.length === 0) throw new Error("no signatures collected — sign the transaction first");
      try {
        return await postExec(signed);
      } finally {
        setPhase(null);
      }
    },
    [pw, postExec],
  );

  /** Send `valueWei` ETH from the personal wallet to `to` on Base. */
  const send = useCallback(
    ({ to, valueWei }: { to: Address; valueWei: bigint }): Promise<`0x${string}`> =>
      execute({ target: to, value: valueWei, data: "0x" }),
    [execute],
  );

  return { send, execute, executeCalls, executeSigned, ensureDeployed, phase, isPasskey: pw.isPasskey };
}
