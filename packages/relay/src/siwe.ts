import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { config } from "./config.js";

const transport = config.alchemyApiKey
  ? http(`https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`)
  : http();

const publicClient = createPublicClient({ chain: mainnet, transport });

export type SiweCheck =
  | { ok: true; address: string; isAdmin: boolean }
  | { ok: false; error: string };

export function isAdminAddress(address: string): boolean {
  return config.adminAddresses.includes(address.toLowerCase());
}

export async function verifySiwe(args: {
  message: string;
  signature: `0x${string}`;
  expectedNonce: string;
}): Promise<SiweCheck> {
  const { message, signature, expectedNonce } = args;
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce || !parsed.domain) {
    return { ok: false, error: "Malformed SIWE message" };
  }
  if (parsed.nonce !== expectedNonce) {
    return { ok: false, error: "Nonce mismatch" };
  }
  let valid = false;
  try {
    valid = await verifySiweMessage(publicClient, {
      message,
      signature,
      nonce: parsed.nonce,
      domain: parsed.domain,
    });
  } catch (err) {
    return { ok: false, error: `Signature verify failed: ${(err as Error).message}` };
  }
  if (!valid) return { ok: false, error: "Invalid signature" };
  const address = parsed.address.toLowerCase();
  return { ok: true, address, isAdmin: isAdminAddress(address) };
}
