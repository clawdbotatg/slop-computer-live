import type { Address, Hex } from "viem";
import { personalSafe } from "~~/utils/safe";

// Personal-wallet ("single-player wallet") derivation.
//
// A passkey user's spendable address is NOT the raw passkey address
// (`keccak256(qx‖qy)[-20:]`, P-256 — unspendable, funds sent there burn). It's
// a Safe on Base, deployed counterfactually: owners [passkey signer contract,
// PERSONAL_SAFE_COSIGNER], threshold 1 (ops/PLAN-safe.md phase 5). The relay
// deploys it and pays gas for its sends (packages/relay/src/personal-wallet.ts).
//
// The address is pure math on (passkey pubkey, cosigner) — no RPC, no server
// state. The cosigner is baked into every address, so it can never change
// without moving every wallet; the relay serves its own copy at
// GET /personal-wallet/config and the deploy route echoes the address it got.

/** The fixed second owner. Must equal the relay's personalCosigner(). */
export const PERSONAL_SAFE_COSIGNER = (process.env.NEXT_PUBLIC_PERSONAL_WALLET_DEPLOYER ??
  "0x0000000000000000000000000000000000000000") as Address;

export const personalCosignerUnset = () => /^0x0*$/i.test(PERSONAL_SAFE_COSIGNER);

/** The passkey's personal Safe: its address and the passkey's owner (signer contract) address. */
export function personalWalletFor(qx: Hex, qy: Hex): { address: Address; owner: Address } | null {
  if (personalCosignerUnset()) return null;
  const p = personalSafe(qx, qy, PERSONAL_SAFE_COSIGNER);
  return { address: p.address, owner: p.owner };
}
