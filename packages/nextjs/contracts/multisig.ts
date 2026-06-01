import MultisigJson from "./Multisig.json";
import MultisigFactoryJson from "./MultisigFactory.json";

export const MultisigAbi = MultisigJson as readonly unknown[];
export const MultisigFactoryAbi = MultisigFactoryJson as readonly unknown[];

// Same CREATE2 addresses on every chain we deploy to (Ethereum, Base,
// Gnosis, Arbitrum, Optimism, Polygon today).
// See packages/../slop-computer-wallet/INTEGRATION.md §1.
// (The integration doc has the wrong EIP-55 checksum for the factory — these
// strings are the viem-computed correct casings.)
export const FACTORY_ADDRESS = "0x21f03d2AdaeaAfe75E0c721bD1ebBc4C9Af9602e" as const;
export const MULTISIG_IMPL_ADDRESS = "0x346Db4e22dDF585c8f97496820c2106aE277df1e" as const;

export const SIGNER_TYPE = { EOA: 0, Passkey: 1 } as const;
export type SignerType = (typeof SIGNER_TYPE)[keyof typeof SIGNER_TYPE];

export type WalletSignature = {
  sigType: SignerType;
  signer: `0x${string}`;
  data: `0x${string}`;
};
