import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  hashTypedData,
  keccak256,
  pad,
  parseAbi,
  stringToBytes,
  toHex,
  zeroAddress,
} from "viem";

// Every multisig on slop.computer is a Gnosis Safe (ops/PLAN-safe.md).
// Pure plumbing — addresses (no RPC), setup, tx hash, signature bytes.
// Imports only viem so the relay and ops/probes/safe-fork.mjs can load
// this exact file. Ported from clawdbotatg/instant-wallet web/lib/safe/core.ts.

// ---------------------------------------------------------------- contracts
// All present on Base, Ethereum, Optimism, Arbitrum, Polygon, Gnosis and
// Robinhood 4663, plus the P-256 precompile at 0x100 (checked 2026-10-07).

export const SAFE_FACTORY: Address = "0x14F2982D601c9458F93bd70B218933A6f8165e7b"; // SafeProxyFactory 1.5.0
export const SAFE_L2: Address = "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e"; // SafeL2 1.5.0
export const FALLBACK_HANDLER: Address = "0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4"; // CompatibilityFallbackHandler 1.5.0
/** MultiSendCallOnly 1.4.1 — the only delegatecall target we ever sign (the wedgie decodes this one). */
export const MULTISEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
export const PASSKEY_FACTORY: Address = "0x1d31F259eE307358a26dFb23EB365939E8641195"; // safe-modules passkey 0.2.1
export const PASSKEY_SINGLETON: Address = "0x4E27b51350e6c2083EE19011120F50DAfEc5CA50";
export const DAIMO_VERIFIER: Address = "0xc2b78104907F722DABAc4C69f826a522B2754De4";
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * P-256 precompile first, Daimo's verifier as fallback. Part of every passkey
 * owner's address — never change it, or every passkey becomes a new owner.
 */
export const VERIFIERS = (0x100n << 160n) | BigInt(DAIMO_VERIFIER);

/** SafeProxy creation code (SafeProxyFactory 1.5.0 proxyCreationCode()). */
const SAFE_PROXY_CODE: Hex =
  "0x608060405234801561001057600080fd5b506040516101b63803806101b68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101946022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050607b806101196000396000f3fe608060405260005463a619486e60003560e01c14156024578060601b606c5260206060f35b3660008037600080366000845af43d6000803e806040573d6000fd5b3d6000f3fea2646970667358221220e61834ebd2d8cd909d362bf67c47ef58fd665df38e6dd036ce65611101d072e964736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";
/** SafeWebAuthnSignerProxy creation code (from the passkey factory). */
const SIGNER_PROXY_CODE: Hex =
  "0x610100346100ad57601f6101b538819003918201601f19168301916001600160401b038311848410176100b2578084926080946040528339810103126100ad578051906001600160a01b03821682036100ad5760208101516040820151606090920151926001600160b01b03841684036100ad5760805260a05260c05260e05260405160ec90816100c98239608051816082015260a05181604d015260c051816027015260e0518160010152f35b600080fd5b634e487b7160e01b600052604160045260246000fdfe7f000000000000000000000000000000000000000000000000000000000000000060b63601527f000000000000000000000000000000000000000000000000000000000000000060a03601527f000000000000000000000000000000000000000000000000000000000000000036608001523660006080376000806056360160807f00000000000000000000000000000000000000000000000000000000000000005af43d600060803e60b1573d6080fd5b3d6080f3fea26469706673582212201660515548d15702d720bbc046b457ca85e941a4559ab9f9518488e4c82e5ee964736f6c634300081a0033";

export const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function addOwnerWithThreshold(address owner, uint256 threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 threshold)",
]);
const factoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
]);
export const signerFactoryAbi = parseAbi([
  "function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address)",
  "function getSigner(uint256 x, uint256 y, uint176 verifiers) view returns (address)",
]);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);
export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])",
]);

export type Call = { to: Address; value: bigint; data: Hex };
export type Op = 0 | 1;
/** The SafeTx fields we vary. Gas/refund fields are always zero — nobody gets refunded from the Safe. */
export type SafeTx = { to: Address; value: bigint; data: Hex; operation: Op; nonce: bigint };

// ---------------------------------------------------------------- owners

/** A passkey's (or wedgie's) Safe owner: its SafeWebAuthnSignerProxy, by CREATE2 — no RPC. */
export function passkeyOwner(x: Hex | bigint, y: Hex | bigint): Address {
  const init = concat([
    SIGNER_PROXY_CODE,
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [PASSKEY_SINGLETON, BigInt(x), BigInt(y), VERIFIERS],
    ),
  ]);
  return getContractAddress({
    opcode: "CREATE2",
    from: PASSKEY_FACTORY,
    salt: pad("0x00", { size: 32 }),
    bytecode: init,
  });
}

/** Deploys a passkey owner. Idempotent only via Multicall3 allowFailure — the factory reverts on a repeat. */
export function deployPasskeyOwnerCall(x: Hex | bigint, y: Hex | bigint): Call {
  return {
    to: PASSKEY_FACTORY,
    value: 0n,
    data: encodeFunctionData({
      abi: signerFactoryAbi,
      functionName: "createSigner",
      args: [BigInt(x), BigInt(y), VERIFIERS],
    }),
  };
}

// ---------------------------------------------------------------- the Safe itself

/** Safe wants owners unique; we also keep them sorted so the same set always gives the same address. */
export function normalizeOwners(owners: Address[]): Address[] {
  const set = [...new Set(owners.map(o => getAddress(o)))];
  return set.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

/** The first setup — fixed into the address. Plain owners + threshold, no modules. */
export function initializer(owners: Address[], threshold: number): Hex {
  const o = normalizeOwners(owners);
  if (threshold < 1 || threshold > o.length)
    throw new Error(`threshold ${threshold} out of range for ${o.length} owners`);
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [o, BigInt(threshold), zeroAddress, "0x", FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress],
  });
}

export function saltNonceFromLabel(label: string): bigint {
  return BigInt(keccak256(stringToBytes(label)));
}

/** Same address on every chain, as long as it's created with the same first setup (ops/PLAN-safe.md trap 4). */
export function safeAddress(init: Hex, saltNonce: bigint): Address {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(init), saltNonce]));
  const bytecode = concat([SAFE_PROXY_CODE, pad(SAFE_L2 as Hex, { size: 32 }) as Hex]);
  return getContractAddress({ opcode: "CREATE2", from: SAFE_FACTORY, salt, bytecode });
}

export function deploySafeCall(init: Hex, saltNonce: bigint): Call {
  return {
    to: SAFE_FACTORY,
    value: 0n,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: "createProxyWithNonce",
      args: [SAFE_L2, init, saltNonce],
    }),
  };
}

/**
 * One transaction that creates every passkey owner (allowFailure: some may
 * already exist) and then the Safe. Send it to MULTICALL3 from any account.
 */
export function deployBundle(passkeys: { x: Hex | bigint; y: Hex | bigint }[], init: Hex, saltNonce: bigint): Call {
  const calls = [
    ...passkeys.map(p => ({ c: deployPasskeyOwnerCall(p.x, p.y), allowFailure: true })),
    { c: deploySafeCall(init, saltNonce), allowFailure: false },
  ];
  return {
    to: MULTICALL3,
    value: 0n,
    data: encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [calls.map(({ c, allowFailure }) => ({ target: c.to, allowFailure, callData: c.data }))],
    }),
  };
}

// ---------------------------------------------------------------- transactions

function multiSendData(calls: Call[]): Hex {
  const packed = concat(
    calls.map(c =>
      encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [0, c.to, c.value, BigInt((c.data.length - 2) / 2), c.data],
      ),
    ),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

/** One call goes out as a plain CALL; several as a MultiSendCallOnly delegatecall. */
export function toSafeTx(calls: Call[], nonce: bigint): SafeTx {
  if (calls.length === 0) throw new Error("empty transaction");
  if (calls.length === 1) return { ...calls[0]!, operation: 0, nonce };
  return { to: MULTISEND_CALL_ONLY, value: 0n, data: multiSendData(calls), operation: 1, nonce };
}

/**
 * Trap 2 in ops/PLAN-safe.md: a delegatecall runs foreign code as the Safe and
 * can take it over. The only one we ever sign or execute is MultiSendCallOnly.
 */
export function isSafeOperation(t: Pick<SafeTx, "to" | "operation">): boolean {
  return t.operation === 0 || (t.operation === 1 && getAddress(t.to) === MULTISEND_CALL_ONLY);
}

/** A 0-value call to itself at `nonce`: executing it burns the nonce, killing whatever else was signed there. */
export const cancelTx = (safe: Address, nonce: bigint): SafeTx => ({
  to: safe,
  value: 0n,
  data: "0x",
  operation: 0,
  nonce,
});

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** EIP-712 typed data for a SafeTx — what an EOA signs with signTypedData (wallets clear-sign it). */
export function safeTxTypedData(chainId: number, safe: Address, t: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: {
      to: t.to,
      value: t.value,
      data: t.data,
      operation: t.operation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: t.nonce,
    },
  };
}

export function safeTxHash(chainId: number, safe: Address, t: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, t));
}

export function execData(t: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [t.to, t.value, t.data, t.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
  });
}

// ---------------------------------------------------------------- owner changes (self-calls)

const SENTINEL: Address = "0x0000000000000000000000000000000000000001";

export const addOwnerCall = (safe: Address, owner: Address, threshold: number): Call => ({
  to: safe,
  value: 0n,
  data: encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [owner, BigInt(threshold)] }),
});

/**
 * Safe keeps owners as a linked list, so removing needs the owner before it.
 * `owners` must be getOwners() read *now*; if owners change before this
 * executes, it reverts (trap 3).
 */
export function removeOwnerCall(safe: Address, owners: Address[], owner: Address, threshold: number): Call {
  const i = owners.findIndex(o => getAddress(o) === getAddress(owner));
  if (i < 0) throw new Error(`${owner} is not an owner`);
  const prev = i === 0 ? SENTINEL : owners[i - 1]!;
  return {
    to: safe,
    value: 0n,
    data: encodeFunctionData({ abi: safeAbi, functionName: "removeOwner", args: [prev, owner, BigInt(threshold)] }),
  };
}

export const changeThresholdCall = (safe: Address, threshold: number): Call => ({
  to: safe,
  value: 0n,
  data: encodeFunctionData({ abi: safeAbi, functionName: "changeThreshold", args: [BigInt(threshold)] }),
});

// ---------------------------------------------------------------- signatures

export type Sig = { signer: Address; data: Hex; kind: "ecdsa" | "contract" };

/** An EOA's signTypedData signature over the SafeTx is already what Safe wants (v = 27/28). */
export const ecdsaSig = (signer: Address, sig: Hex): Sig => ({ signer: getAddress(signer), data: sig, kind: "ecdsa" });

/**
 * A passkey assertion in the shape Safe's passkey signer checks. It rebuilds
 * clientDataJSON as `{"type":"webauthn.get","challenge":"<b64url(hash)>",`
 * + clientDataFields + `}`, so we send everything after the challenge.
 * Malleable (high-s) signatures are accepted; no normalization needed.
 */
export function passkeySig(args: {
  owner: Address;
  hash: Hex;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  r: bigint;
  s: bigint;
}): Sig {
  const json = new TextDecoder().decode(args.clientDataJSON);
  const prefix = `{"type":"webauthn.get","challenge":"${base64url(args.hash)}",`;
  if (!json.startsWith(prefix) || !json.endsWith("}")) {
    throw new Error("This browser's passkey response has an unexpected format (clientDataJSON order).");
  }
  const data = encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [toHex(args.authenticatorData), json.slice(prefix.length, -1), args.r, args.s],
  );
  return { signer: getAddress(args.owner), data, kind: "contract" };
}

/** Safe signature bytes: owners ascending; contract sigs as (r = owner, s = offset, v = 0) heads + payload tails. */
export function encodeSignatures(sigs: Sig[]): Hex {
  const sorted = [...sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  const headLen = sorted.length * 65;
  const head: Hex[] = [];
  const tail: Hex[] = [];
  let tailLen = 0;
  for (const s of sorted) {
    if (s.kind === "ecdsa") {
      head.push(s.data);
      continue;
    }
    head.push(concat([pad(s.signer as Hex, { size: 32 }) as Hex, toHex(headLen + tailLen, { size: 32 }), "0x00"]));
    const len = (s.data.length - 2) / 2;
    tail.push(concat([toHex(len, { size: 32 }), s.data]));
    tailLen += 32 + len;
  }
  return concat([...head, ...tail]);
}

function base64url(hex: Hex): string {
  const bytes = hex
    .slice(2)
    .match(/../g)!
    .map(b => parseInt(b, 16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
