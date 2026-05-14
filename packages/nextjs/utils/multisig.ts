import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { WalletSignature } from "~~/contracts/multisig";

// Salt used by the factory's CREATE2 deploy. We derive it deterministically
// from a per-episode label so the host can show the predicted address before
// they actually broadcast the deploy. Two different labels → two different
// multisigs from the same deployer.
export function saltFromLabel(label: string): Hex {
  return keccak256(stringToBytes(label));
}

// Off-chain exec hash. Must match `Multisig.getExecHash` exactly:
//   keccak256(abi.encode(chainId, multisig, nonce, deadline, target, value, keccak256(data)))
export function computeExecHash(args: {
  chainId: number;
  multisig: Address;
  nonce: bigint;
  deadline: bigint;
  target: Address;
  value: bigint;
  data: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, address, uint256, uint256, address, uint256, bytes32"), [
      BigInt(args.chainId),
      args.multisig,
      args.nonce,
      args.deadline,
      args.target,
      args.value,
      keccak256(args.data),
    ]),
  );
}

// Multisig.execTransaction rejects out-of-order arrays as `SignersUnsorted`,
// which also catches duplicates. Sort ascending by signer address.
export function sortSignatures(sigs: WalletSignature[]): WalletSignature[] {
  return [...sigs].sort((a, b) => (a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1));
}

// EOA signature wrapper. The contract applies the `\x19Ethereum Signed
// Message:\n32` prefix internally, so `personal_sign` over the raw
// execHash bytes is what we want — viem's `{ raw: execHash }` does that.
export function wrapEoaSignature(signer: Address, sig: Hex): WalletSignature {
  return { sigType: 0, signer: signer as `0x${string}`, data: sig as `0x${string}` };
}

// Convenience: format a hex value as a 0x-prefixed lowercased string for
// stable comparison / map keys.
export function normalizeHex(value: Hex | string): Hex {
  const s = (value.startsWith("0x") ? value : `0x${value}`).toLowerCase();
  return s as Hex;
}

// Small helper for the deploy form: pad an array of bytes32 values with
// zeros up to `count`. The contract takes parallel passkey arrays where
// `credentialIdHash` may be 0x00 to skip — we don't use passkey signers
// in v1 but the args still have to be passed.
export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

// Default deadline for any tx the wallet UI proposes: 7 days from now.
export const DEFAULT_TX_DEADLINE_SECONDS = 7 * 24 * 60 * 60;
export function defaultDeadline(nowSeconds = Math.floor(Date.now() / 1000)): bigint {
  return BigInt(nowSeconds + DEFAULT_TX_DEADLINE_SECONDS);
}

// Just here to remind us — the relay's broadcast carries deadlines as
// strings to avoid bigint JSON issues. Round-trip helpers:
export const bigintToString = (v: bigint): string => v.toString();
export const stringToBigint = (s: string): bigint => BigInt(s);

// For the address derivation of a passkey signer if/when we wire it.
// Same formula as `Multisig.getPasskeyAddress(qx, qy)`: keccak256(qx||qy)[12:].
export function passkeyAddressFromCoords(qx: Hex, qy: Hex): Address {
  return (`0x` + keccak256((qx + qy.slice(2)) as Hex).slice(-40)) as Address;
}

// Re-export from viem so callers have a single import surface.
export { toHex };
