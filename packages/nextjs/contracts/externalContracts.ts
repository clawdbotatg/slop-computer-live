import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

/**
 * SlopComputerFrontpage is deployed on mainnet (chain id 1) at:
 *   0x94D987a8057b7795522589E36383C87356217820
 * Owner: 0x11ce532845ce0eacda41f72fdc1c88c335981442 (clawd.atg.eth)
 *
 * The live page reads isLive / liveTitle / liveHlsUrl for audience display,
 * and the host can call goLive / goOffline.
 */
const FRONTPAGE_ADDRESS =
  (process.env.NEXT_PUBLIC_FRONTPAGE_ADDRESS as `0x${string}` | undefined) ??
  "0x94D987a8057b7795522589E36383C87356217820";

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
          name: "liveTitle",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "string" }],
        },
        {
          type: "function",
          name: "liveHlsUrl",
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
        {
          type: "function",
          name: "owner",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ],
    },
  },
} as const;

export default externalContracts satisfies GenericContractsDeclaration;
