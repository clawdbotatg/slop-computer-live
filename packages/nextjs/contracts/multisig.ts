import MultisigJson from "./Multisig.json";
import MultisigFactoryJson from "./MultisigFactory.json";

export const MultisigAbi = MultisigJson as readonly unknown[];
export const MultisigFactoryAbi = MultisigFactoryJson as readonly unknown[];

// v3 — same CREATE2 addresses on every chain we deploy to. v2 added ERC-1271
// contract signers (a Multisig can be a signer on another Multisig); v3 makes
// isValidSignature also accept personal_sign-prefixed sigs, so a wallet EOA
// (e.g. MetaMask) can be a signer of a nested Multisig without raw-hash signing.
// See packages/../slop-computer-wallet/INTEGRATION.md §1.
// NOTE: v3 is currently live on Base only; the other chains still need redeploy.
export const FACTORY_ADDRESS = "0x695123afA4E2C4F948E977e1974Ac80372044F31" as const;
export const MULTISIG_IMPL_ADDRESS = "0x20d8866d59aA288966e515f3c6cA886555a2Ae11" as const;

export const SIGNER_TYPE = { EOA: 0, Passkey: 1, ERC1271: 2 } as const;
export type SignerType = (typeof SIGNER_TYPE)[keyof typeof SIGNER_TYPE];

export type WalletSignature = {
  sigType: SignerType;
  signer: `0x${string}`;
  data: `0x${string}`;
};
