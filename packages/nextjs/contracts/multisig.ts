import MultisigJson from "./Multisig.json";
import MultisigFactoryJson from "./MultisigFactory.json";

export const MultisigAbi = MultisigJson as readonly unknown[];
export const MultisigFactoryAbi = MultisigFactoryJson as readonly unknown[];

// v4 — same CREATE2 addresses on every chain we deploy to. v4 unifies EOA and
// contract signers into one "Account" kind validated by ECDSA-or-ERC1271, so an
// EOA / 7702 smart account (MetaMask) / Safe / nested Multisig can all be signers
// with no on-chain kind to guess. Passkey stays its own kind.
// See packages/../slop-computer-wallet/INTEGRATION.md §1.
// NOTE: v4 is currently live on Base only; the other chains still need redeploy.
export const FACTORY_ADDRESS = "0xfcdEe21865b60C2700C23Cd946316CEdA0F215B5" as const;
export const MULTISIG_IMPL_ADDRESS = "0x5Be7f750Cc271DBf0C6027a45bFe78b99504CE3A" as const;

// On-chain Signature.sigType: 0 = Account (EOA / 7702 / Safe / Multisig / any ERC-1271), 1 = Passkey.
export const SIGNER_TYPE = { Account: 0, Passkey: 1 } as const;
export type SignerType = (typeof SIGNER_TYPE)[keyof typeof SIGNER_TYPE];

export type WalletSignature = {
  sigType: SignerType;
  signer: `0x${string}`;
  data: `0x${string}`;
};
