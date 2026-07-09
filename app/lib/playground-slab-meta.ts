/**
 * Playground devnet slab → token metadata.
 *
 * Used in:
 *  - app/api/markets/route.ts     (discoveredToApiRow → bulk list)
 *  - app/api/markets/[slab]/route.ts  (on-chain fallback for individual slab)
 *
 * BRAND-NEW consistent markets (2026-07-09 (20x SOL, 10x rest, no Earn vault)): all marketauth=FbTbD, each with
 * nft_registry + stake pool + matcher + LP — every one proven trade+NFT+stake.
 */
export const PLAYGROUND_SLAB_META: Record<string, {
  symbol: string;
  name: string;
  mainnet_ca: string;
  dex_pool_address: string;
}> = {
  // SOL/USDC — raydium-clmm — new 2026-07-09 (20x SOL, 10x rest, no Earn vault)
  "DxrZXhTC11gCVtv4b2nkbszScgZPqm9DFqit5X7FvsF7": {
    symbol: "SOL-PERP",
    name: "SOL/USDC Perpetual",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    dex_pool_address: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
  },
  // BONK/USDC — raydium-clmm — new 2026-07-09 (20x SOL, 10x rest, no Earn vault)
  "4txSGha4zABqt2NUbBtbkzv3vA4rfi9J6Yr95adA4fc5": {
    symbol: "BONK-PERP",
    name: "BONK/USDC Perpetual",
    mainnet_ca: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    dex_pool_address: "3UwfrdLTpAjxTRni1boc5HUWe6hzc4HgE5yLdvEp2Noc",
  },
  // JUP/USDC — meteora-dlmm — new 2026-07-09 (20x SOL, 10x rest, no Earn vault)
  "J9unPVyDykcoQyxGxF1MfSE6mGyaaCfZhGEAk5eQokXG": {
    symbol: "JUP-PERP",
    name: "JUP/USDC Perpetual",
    mainnet_ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    dex_pool_address: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
  },
  // TRUMP/USDC — meteora-dlmm — new 2026-07-09 (20x SOL, 10x rest, no Earn vault)
  "8WNAuxLDvo3S5Yf9Z5sm2me69N4d1RLvxoS1tCnPpo83": {
    symbol: "TRUMP-PERP",
    name: "TRUMP/USDC Perpetual",
    mainnet_ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    dex_pool_address: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
  },
  // PENGU/USDC — meteora-dlmm — new 2026-07-09 (20x SOL, 10x rest, no Earn vault)
  "DeWGMtVo8VHjUJ5qsPXSZsQS9rFJhnB3gE4tPGWrEcCB": {
    symbol: "PENGU-PERP",
    name: "PENGU/USDC Perpetual",
    mainnet_ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    dex_pool_address: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
  },
};
