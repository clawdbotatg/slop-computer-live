import MultisigJson from "./Multisig.json";
import MultisigFactoryJson from "./MultisigFactory.json";

export const MultisigAbi = MultisigJson as readonly unknown[];
export const MultisigFactoryAbi = MultisigFactoryJson as readonly unknown[];

// v2 — same CREATE2 addresses on every chain we deploy to. v2 adds ERC-1271
// contract signers (a Multisig can be a signer on another Multisig).
// See packages/../slop-computer-wallet/INTEGRATION.md §1.
// NOTE: v2 is currently live on Base only; the other chains (Ethereum, Gnosis,
// Arbitrum, Optimism, Polygon) still run v1 until they're redeployed.
export const FACTORY_ADDRESS = "0x6D344c2258Aa954F315950488367B7B66e01170f" as const;
export const MULTISIG_IMPL_ADDRESS = "0xEaAffe5e58200868AeB5021B0a865f1A856f9E43" as const;

export const SIGNER_TYPE = { EOA: 0, Passkey: 1, ERC1271: 2 } as const;
export type SignerType = (typeof SIGNER_TYPE)[keyof typeof SIGNER_TYPE];

export type WalletSignature = {
  sigType: SignerType;
  signer: `0x${string}`;
  data: `0x${string}`;
};
