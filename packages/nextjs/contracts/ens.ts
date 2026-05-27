import { namehash } from "viem";

// ENS records only exist on Ethereum mainnet (chainId 1). The room
// multisig has the same CREATE2 address on every chain we deploy to, but
// for naming purposes only mainnet matters — the ENS app reads + writes
// here exclusively, switching the connected wallet to mainnet as needed.
export const ENS_CHAIN_ID = 1 as const;

// Mainnet ENS contracts. Verified on-chain 2026-05-27 against
// slopcomputer.eth (owner 0x34aA…fDF3, unwrapped).
//
//   - Registry: the canonical ENS registry.
//   - PublicResolver: the resolver slopcomputer.eth itself already uses
//     (supports the `addr` + `name` interfaces). We reuse it verbatim for
//     every room subnode so the addr() record resolves everywhere.
//   - ReverseRegistrar: `setName(string)` sets the *caller's* primary name.
//     The multisig executes via `target.call{}`, so msg.sender is the
//     multisig itself — exactly what we want for the reverse record.
export const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
export const ENS_PUBLIC_RESOLVER = "0xF29100983E058B709F3D539b0c765937B804AC15" as const;
export const ENS_REVERSE_REGISTRAR = "0x084b1c3C81545d370f3634392De611CaaBFf8148" as const;

// The parent name every room subdomain hangs off of: <slug>.slopcomputer.eth.
export const PARENT_NAME = "slopcomputer.eth" as const;
export const PARENT_NODE = namehash(PARENT_NAME);

/** The full ENS name for a room slug, e.g. "ep0.slopcomputer.eth". */
export function subdomainFor(slug: string): string {
  return `${slug}.${PARENT_NAME}`;
}

// Minimal ENS registry surface — just the calls the ENS app makes.
export const EnsRegistryAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "resolver",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    // Creates/overwrites a subnode in one call: sets its owner, resolver
    // and ttl atomically. Only the parent-node owner may call it.
    type: "function",
    name: "setSubnodeRecord",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "label", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "resolver", type: "address" },
      { name: "ttl", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

// Minimal public-resolver surface: read + set the forward addr() record.
export const EnsResolverAbi = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "setAddr",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "a", type: "address" },
    ],
    outputs: [],
  },
] as const;

// Minimal reverse-registrar surface: set the caller's primary name.
export const EnsReverseRegistrarAbi = [
  {
    type: "function",
    name: "setName",
    stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "string" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;
