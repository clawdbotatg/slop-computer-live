import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

/**
 * SlopComputerFrontpage is deployed and managed by the slop-computer-frontpage
 * repo. Its address is sourced from NEXT_PUBLIC_FRONTPAGE_ADDRESS at runtime so
 * builds don't bake a stale address. The minimal ABI here covers the bits the
 * live page needs: read isLive / currentEpisode and (host-only) call goLive /
 * goOffline.
 */
const FRONTPAGE_ADDRESS =
  (process.env.NEXT_PUBLIC_FRONTPAGE_ADDRESS as `0x${string}` | undefined) ??
  "0x0000000000000000000000000000000000000000";

const externalContracts = {
  1: {
    SlopComputerFrontpage: {
      address: FRONTPAGE_ADDRESS,
      abi: [
        {
          type: "function",
          name: "isLive",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "bool" }],
        },
        {
          type: "function",
          name: "currentTitle",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "string" }],
        },
        {
          type: "function",
          name: "currentHlsUrl",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "string" }],
        },
        {
          type: "function",
          name: "goLive",
          stateMutability: "nonpayable",
          inputs: [
            { name: "title", type: "string" },
            { name: "hlsUrl", type: "string" },
          ],
          outputs: [],
        },
        {
          type: "function",
          name: "goOffline",
          stateMutability: "nonpayable",
          inputs: [],
          outputs: [],
        },
      ],
    },
  },
} as const;

export default externalContracts satisfies GenericContractsDeclaration;
