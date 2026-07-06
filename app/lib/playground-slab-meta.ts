/**
 * Playground devnet slab → token metadata.
 *
 * Used in:
 *  - app/api/markets/route.ts     (discoveredToApiRow → bulk list)
 *  - app/api/markets/[slab]/route.ts  (on-chain fallback for individual slab)
 *
 * BRAND-NEW consistent markets (2026-07-01): all marketauth=FbTbD, each with
 * nft_registry + stake pool + matcher + LP — every one proven trade+NFT+stake.
 */
export const PLAYGROUND_SLAB_META: Record<string, {
  symbol: string;
  name: string;
  mainnet_ca: string;
  dex_pool_address: string;
}> = {
  // SOL/USDC — raydium-clmm — new 2026-07-01
  "CsPuA8jjvHhg6UZSjH4s61E5v339ZjBGinQzbm1Nh1Xc": {
    symbol: "SOL-PERP",
    name: "SOL/USDC Perpetual",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    dex_pool_address: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
  },
  // BONK/USDC — raydium-clmm — new 2026-07-01
  "4s7HrCoHekfMKB2F45z4bEq3K1WuS9ihS73gffNhtj1i": {
    symbol: "BONK-PERP",
    name: "BONK/USDC Perpetual",
    mainnet_ca: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    dex_pool_address: "3UwfrdLTpAjxTRni1boc5HUWe6hzc4HgE5yLdvEp2Noc",
  },
  // JUP/USDC — meteora-dlmm — new 2026-07-01
  "qBhFaHzj3qi7xh6piTidKyyiuWacBepF1sK6EGM4xoR": {
    symbol: "JUP-PERP",
    name: "JUP/USDC Perpetual",
    mainnet_ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    dex_pool_address: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
  },
  // TRUMP/USDC — meteora-dlmm — new 2026-07-01
  "Az9jziKXA8mQjQtGBLaNH9uYGhF6dyqMuzm5R8UYWy6v": {
    symbol: "TRUMP-PERP",
    name: "TRUMP/USDC Perpetual",
    mainnet_ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    dex_pool_address: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
  },
  // PENGU/USDC — meteora-dlmm — new 2026-07-01
  "B3JTEUcBgFFuHozpEP8rZLgDTbYPt29ytijPoHy8x4He": {
    symbol: "PENGU-PERP",
    name: "PENGU/USDC Perpetual",
    mainnet_ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    dex_pool_address: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
  },
};
