/**
 * Playground devnet slab → token metadata.
 *
 * Used in:
 *  - app/api/markets/route.ts     (discoveredToApiRow → bulk list)
 *  - app/api/markets/[slab]/route.ts  (on-chain fallback for individual slab)
 *
 * BRAND-NEW born-immortal markets (2026-07-10 full re-seed): all marketauth=FbTbD,
 * each with nft_registry + stake pool + matcher + LP — every one proven
 * trade+NFT+stake. Fixes the backing-bucket-freshness deadlock (engine line-776
 * trap): both backing-bucket domains (asset 0) are seeded to a non-lapsing
 * expiry (u64::MAX/2 = 9223372036854775807) via TopUpBackingBucket at creation,
 * verified Fresh@MAX on-chain for all 6 markets before this file was wired up.
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
  // SOL/USDC — raydium-clmm — 2026-07-10 born-immortal re-seed
  "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV": {
    symbol: "SOL-PERP",
    name: "SOL/USDC Perpetual",
    mainnet_ca: "So11111111111111111111111111111111111111112",
    dex_pool_address: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    lp_portfolio_address: "AwUkest7xDGmfBSpqJTNXj431F1MCihNpsdPN3gM52Rv",
  },
  // JUP/USDC — meteora-dlmm — 2026-07-10 born-immortal re-seed
  "B22quVNFuuEYwx4dQigwn41BMBuk9ZcTdMik4UH7PshY": {
    symbol: "JUP-PERP",
    name: "JUP/USDC Perpetual",
    mainnet_ca: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    dex_pool_address: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
    lp_portfolio_address: "6BE6Wc6Z1qBpLfMmeTuVZNLg8TcBepv1XHpnMcPSPWh3",
  },
  // TRUMP/USDC — meteora-dlmm — 2026-07-10 born-immortal re-seed
  "6Hqn4VoMHjvCb1XWQkpnJ1UE3xAverJezVdk3czvgQxh": {
    symbol: "TRUMP-PERP",
    name: "TRUMP/USDC Perpetual",
    mainnet_ca: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    dex_pool_address: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2",
    lp_portfolio_address: "8XXyvRJrrUgkSa2PKfBPhjLabYEEhjAUVSFaxJfS9kD6",
  },
  // PENGU/USDC — meteora-dlmm — 2026-07-10 born-immortal re-seed
  "Gbpuam5UYV4MpC1DmGeTVZWtT4UGDmahMW2vo4p1MBAf": {
    symbol: "PENGU-PERP",
    name: "PENGU/USDC Perpetual",
    mainnet_ca: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    dex_pool_address: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
    lp_portfolio_address: "AzMTFzZWoygPkxDSYdQm1Adq2e3AVqo2JfuZtsZ54pFp",
  },
  // BURNIE/USDC — pumpswap — 2026-07-10 born-immortal re-seed
  "GPpyVaHAEJ8u6W9UAyCPp6tuQB2Chm1Z6uLUKA9ePJBC": {
    symbol: "BURNIE-PERP",
    name: "BURNIE/USDC Perpetual",
    mainnet_ca: "CGEDT9QZDvvH5GmVkWJH2BXiMJqMJySC9ihWyr7Spump",
    dex_pool_address: "5tYFviFWQRKV9BJSTHGitbdqEYC1BGUgRUDnSADUXqJP",
    lp_portfolio_address: "D4uksp3XnqiTz4bbe3Lo9RRYmo19ePv7g253Q7YKf9WX",
  },
  // Percolator/USDC — pumpswap — 2026-07-10 born-immortal re-seed
  "FGaUkXepxCggbmpbgXDWUZ3V2CGSh6MeDCU6KLTLShbH": {
    symbol: "PERCOLATOR-PERP",
    name: "Percolator/USDC Perpetual",
    mainnet_ca: "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump",
    dex_pool_address: "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
    lp_portfolio_address: "F9qDosJk7EixJ79w8EADT3Rc5giVxF83tG3P3xPCNTvc",
  },
};
