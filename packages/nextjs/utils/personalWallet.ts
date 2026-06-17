import { passkeyAddressFromCoords, saltFromLabel } from "./multisig";
import type { Address, Hex, PublicClient } from "viem";
import { FACTORY_ADDRESS, MultisigFactoryAbi } from "~~/contracts/multisig";

// Personal-wallet ("single-player wallet") derivation.
//
// A passkey user's spendable address is NOT the raw passkey address
// (`keccak256(qx‖qy)[-20:]`, P-256 — unspendable, funds sent there burn). It's
// a slop Multisig deployed counterfactually: a 1-of-2 of [passkey, mainMultisig]
// at threshold 1. See docs/PASSKEY-WALLET.md.
//
// The address is `MultisigFactory.getMultisigAddress(deployer, salt)`. The
// factory bakes the *deployer* (msg.sender of createMultisig) into the CREATE2
// address, so a SINGLE FIXED deployer must broadcast every personal wallet's
// deploy or the predicted address won't match what gets deployed. That deployer
// is the facilitator/deployer key — see PERSONAL_WALLET_DEPLOYER below.
//
// `salt` commits to the passkey so the same passkey always lands on the same
// wallet, with no server state. The signer SET (passkey + mainMultisig) is set
// at init time and does NOT affect the address (getMultisigAddress depends only
// on deployer+salt), so the recovery signer can be chosen/changed without moving
// the address.

// Salt namespace. Bump the version suffix to migrate everyone to fresh wallets.
export const PERSONAL_WALLET_SALT_PREFIX = "slop-personal-v1:";

// The fixed address that will broadcast createMultisig for every personal
// wallet. MUST be an address whose key we control (the facilitator/deployer hot
// wallet) — it's baked into every derived address, so it can never change
// without stranding funds already sent to old addresses.
//
// TODO(open-decision-1): set this to the real deployer address before any real
// funds are sent to a derived address. Until then `predictPersonalWalletAddress`
// throws on the zero address to prevent deriving against a placeholder.
export const PERSONAL_WALLET_DEPLOYER = (process.env.NEXT_PUBLIC_PERSONAL_WALLET_DEPLOYER ??
  "0x0000000000000000000000000000000000000000") as Address;

/** Deterministic CREATE2 salt for a passkey's personal wallet. Commits to the
 *  passkey's raw (lowercased) address so the same passkey → same wallet. */
export function personalWalletSalt(passkeyAddress: Address): Hex {
  return saltFromLabel(PERSONAL_WALLET_SALT_PREFIX + passkeyAddress.toLowerCase());
}

/** The createMultisig args for a passkey's 1-of-2 personal wallet:
 *  signers = [passkey (P-256), mainMultisig (account/ERC-1271)], threshold 1.
 *  Not needed to DERIVE the address (that's deployer+salt only) — used at
 *  deploy/init time in Phase 2. */
export function personalWalletCreateArgs(args: {
  passkey: { qx: Hex; qy: Hex; credentialIdHash: Hex };
  mainMultisig: Address;
}): {
  accounts: Address[];
  passkeyQxs: Hex[];
  passkeyQys: Hex[];
  credentialIdHashes: Hex[];
  threshold: bigint;
  salt: Hex;
} {
  const passkeyAddress = passkeyAddressFromCoords(args.passkey.qx, args.passkey.qy);
  return {
    accounts: [args.mainMultisig],
    passkeyQxs: [args.passkey.qx],
    passkeyQys: [args.passkey.qy],
    credentialIdHashes: [args.passkey.credentialIdHash],
    threshold: 1n,
    salt: personalWalletSalt(passkeyAddress),
  };
}

/** Read the counterfactual personal-wallet address from the factory. Works
 *  before deploy (funding-before-deploy). Pin `client` to a chain where the
 *  factory has code (e.g. Base). Throws if the deployer is unset (zero addr) so
 *  we never derive — and let someone fund — a placeholder address. */
export async function predictPersonalWalletAddress(args: {
  client: PublicClient;
  passkeyAddress: Address;
  deployer?: Address;
}): Promise<Address> {
  const deployer = args.deployer ?? PERSONAL_WALLET_DEPLOYER;
  if (/^0x0+$/i.test(deployer)) {
    throw new Error("PERSONAL_WALLET_DEPLOYER is unset — refusing to derive against the zero address");
  }
  const salt = personalWalletSalt(args.passkeyAddress);
  return (await args.client.readContract({
    address: FACTORY_ADDRESS,
    abi: MultisigFactoryAbi,
    functionName: "getMultisigAddress",
    args: [deployer, salt],
  })) as Address;
}
