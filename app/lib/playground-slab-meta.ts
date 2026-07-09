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
  /**
   * The market's v17 LP-portfolio account (the AMM counterparty — the
   * standalone portfolio with an enabled PortfolioMatcherConfigV16). Its
   * `capital` field is the market's real "Market LP" backing in Sim-USDC
   * atoms. Discovered once via getProgramAccounts (see lib/lp-portfolio.ts)
   * and hardcoded here so the bulk /api/markets list can read it with a
   * single cheap getMultipleAccountsInfo call instead of a per-market scan.
   * Re-discover and update if a market's LP portfolio is ever re-seeded.
   */
  lp_portfolio_address: string;
}> = {
  // SOL/USDC — raydium-clmm — 2026-07-09 (15x SOL im=666, 10x rest, no Earn vault; BONK dropped)
  "Fs13SX1b33wRh3DBbh1NmkuHSz5Z89oRb2ew7aNn1jMH": {
    symbol: "SOL-PERP",
    name: "SOL/USDC Perpetual",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    dex_pool_address: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    lp_portfolio_address: "EBk4pt57Bsbt49RjoWxrdCNrqEj6j5ntbpaxptk8AkeC",
  },
  // JUP/USDC — meteora-dlmm — 2026-07-09 (10x, no Earn vault)
  "J9unPVyDykcoQyxGxF1MfSE6mGyaaCfZhGEAk5eQokXG": {
    symbol: "JUP-PERP",
    name: "JUP/USDC Perpetual",
    mainnet_ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    dex_pool_address: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
    lp_portfolio_address: "9gousBr1gwBWJojs85SM61AAQUE3Vzm2wRCwgFbNGbRF",
  },
  // TRUMP/USDC — meteora-dlmm — new 2026-07-09 (20x SOL, 10x rest, no Earn vault)
  "8WNAuxLDvo3S5Yf9Z5sm2me69N4d1RLvxoS1tCnPpo83": {
    symbol: "TRUMP-PERP",
    name: "TRUMP/USDC Perpetual",
    mainnet_ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    dex_pool_address: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
    lp_portfolio_address: "CUMamrYZtN6SfdNURnxTPskULiTpC7jAh6iiJHhuofXk",
  },
  // PENGU/USDC — meteora-dlmm — new 2026-07-09 (20x SOL, 10x rest, no Earn vault)
  "DeWGMtVo8VHjUJ5qsPXSZsQS9rFJhnB3gE4tPGWrEcCB": {
    symbol: "PENGU-PERP",
    name: "PENGU/USDC Perpetual",
    mainnet_ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    dex_pool_address: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
    lp_portfolio_address: "GfqD9Avqs4Z8KVZUhNGStxBFuhzh31Q4PdEMpx96vYY1",
  },
};
