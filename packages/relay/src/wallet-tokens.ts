// Canonical token addresses by chain id, ported from the AI wallet's
// data/token-addresses.json. Inlined as a TS module (not a JSON import)
// so it compiles straight into dist/ — the relay deploy rsyncs only the
// compiled output, and tsc does not copy stray .json assets.
//
// The intent engine's getTokenAddress tool checks this registry first,
// then falls back to a LI.FI token-list lookup. Keep entries here to
// well-known tokens the model should never have to guess.

export type TokenEntry = { address: string; decimals: number; name: string };

export const TOKEN_ADDRESSES: Record<string, Record<string, TokenEntry>> = {
  // Ethereum mainnet
  "1": {
    ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18, name: "Ether" },
    WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, name: "Wrapped Ether" },
    USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, name: "USD Coin" },
    USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, name: "Tether USD" },
    DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, name: "Dai Stablecoin" },
    WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, name: "Wrapped Bitcoin" },
    LINK: { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, name: "Chainlink" },
    UNI: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, name: "Uniswap" },
    AAVE: { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18, name: "Aave" },
    MKR: { address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", decimals: 18, name: "Maker" },
    SNX: { address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F", decimals: 18, name: "Synthetix" },
    CRV: { address: "0xD533a949740bb3306d119CC777fa900bA034cd52", decimals: 18, name: "Curve DAO" },
    LDO: { address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18, name: "Lido DAO" },
    RPL: { address: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f", decimals: 18, name: "Rocket Pool" },
    GNO: { address: "0x6810e776880C02933D47DB1b9fc05908e5386b96", decimals: 18, name: "Gnosis" },
    ENS: { address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72", decimals: 18, name: "Ethereum Name Service" },
    stETH: { address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", decimals: 18, name: "Lido Staked ETH" },
    wstETH: { address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", decimals: 18, name: "Wrapped stETH" },
    cbETH: { address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", decimals: 18, name: "Coinbase Wrapped Staked ETH" },
    rETH: { address: "0xae78736Cd615f374D3085123A210448E74Fc6393", decimals: 18, name: "Rocket Pool ETH" },
    MATIC: { address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", decimals: 18, name: "Polygon" },
    OP: { address: "0x4200000000000000000000000000000000000042", decimals: 18, name: "Optimism (bridged)" },
  },
  // Base
  "8453": {
    ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18, name: "Ether" },
    WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, name: "Wrapped Ether" },
    USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, name: "USD Coin" },
    USDbC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, name: "USD Base Coin" },
    DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, name: "Dai Stablecoin" },
    WBTC: { address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", decimals: 8, name: "Wrapped Bitcoin" },
    cbETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, name: "Coinbase Wrapped Staked ETH" },
    GNO: { address: "0x7f4E7fB2F5a5A4d3de7a43CCf13aA5a5Bb8B1e01", decimals: 18, name: "Gnosis" },
  },
  // Arbitrum
  "42161": {
    ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18, name: "Ether" },
    WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, name: "Wrapped Ether" },
    USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, name: "USD Coin" },
    "USDC.e": { address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", decimals: 6, name: "Bridged USDC" },
    USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, name: "Tether USD" },
    DAI: { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, name: "Dai Stablecoin" },
    WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, name: "Wrapped Bitcoin" },
    ARB: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, name: "Arbitrum" },
    GMX: { address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, name: "GMX" },
  },
  // Optimism
  "10": {
    ETH: { address: "0x0000000000000000000000000000000000000000", decimals: 18, name: "Ether" },
    WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, name: "Wrapped Ether" },
    USDC: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, name: "USD Coin" },
    "USDC.e": { address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", decimals: 6, name: "Bridged USDC" },
    USDT: { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, name: "Tether USD" },
    DAI: { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, name: "Dai Stablecoin" },
    OP: { address: "0x4200000000000000000000000000000000000042", decimals: 18, name: "Optimism" },
    WBTC: { address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8, name: "Wrapped Bitcoin" },
    SNX: { address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", decimals: 18, name: "Synthetix" },
  },
  // Polygon
  "137": {
    MATIC: { address: "0x0000000000000000000000000000000000000000", decimals: 18, name: "Matic" },
    WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, name: "Wrapped Matic" },
    WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, name: "Wrapped Ether" },
    USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, name: "USD Coin" },
    "USDC.e": { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6, name: "Bridged USDC" },
    USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, name: "Tether USD" },
    DAI: { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, name: "Dai Stablecoin" },
    WBTC: { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8, name: "Wrapped Bitcoin" },
  },
  // Gnosis
  "100": {
    xDAI: { address: "0x0000000000000000000000000000000000000000", decimals: 18, name: "xDai" },
    WXDAI: { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", decimals: 18, name: "Wrapped xDai" },
    WETH: { address: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", decimals: 18, name: "Wrapped Ether" },
    USDC: { address: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", decimals: 6, name: "USD Coin" },
    USDT: { address: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6", decimals: 6, name: "Tether USD" },
    GNO: { address: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", decimals: 18, name: "Gnosis" },
    WBTC: { address: "0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252", decimals: 8, name: "Wrapped Bitcoin" },
  },
};

/** Look up a token entry by symbol on a chain. Case-insensitive. */
export function lookupToken(chainId: number | string, symbol: string): TokenEntry | null {
  const chain = TOKEN_ADDRESSES[String(chainId)];
  if (!chain) return null;
  const upper = symbol.toUpperCase();
  if (chain[upper]) return chain[upper];
  const match = Object.entries(chain).find(([k]) => k.toUpperCase() === upper);
  return match ? match[1] : null;
}
