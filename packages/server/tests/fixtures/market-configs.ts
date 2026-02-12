import { PublicKey } from "@solana/web3.js";
import type { DiscoveredMarket, MarketConfig } from "@percolator/core";

/**
 * Mock market configurations for testing
 */

export const MOCK_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const MOCK_SLAB_ADDRESS = new PublicKey("2222222222222222222222222222222222222222222");
export const MOCK_ORACLE_AUTHORITY = new PublicKey("3333333333333333333333333333333333333333333");
export const MOCK_COLLATERAL_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // SOL
export const MOCK_USER_WALLET = new PublicKey("4444444444444444444444444444444444444444444");

export const mockMarketConfig: MarketConfig = {
  oracleAuthority: MOCK_ORACLE_AUTHORITY,
  collateralMint: MOCK_COLLATERAL_MINT,
  indexFeedId: PublicKey.default,
  authorityPriceE6: 100_000_000n, // $100
  authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
};

export const mockMarketConfigStalePrice: MarketConfig = {
  oracleAuthority: MOCK_ORACLE_AUTHORITY,
  collateralMint: MOCK_COLLATERAL_MINT,
  indexFeedId: PublicKey.default,
  authorityPriceE6: 100_000_000n,
  authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 90), // 90s old (stale)
};

export const mockDiscoveredMarket: DiscoveredMarket = {
  programId: MOCK_PROGRAM_ID,
  slabAddress: MOCK_SLAB_ADDRESS,
  config: mockMarketConfig,
};

export const mockDiscoveredMarketAdminOracle: DiscoveredMarket = {
  ...mockDiscoveredMarket,
  config: {
    ...mockMarketConfig,
    oracleAuthority: MOCK_ORACLE_AUTHORITY, // Admin oracle (not default)
  },
};

export const mockDiscoveredMarketUserOracle: DiscoveredMarket = {
  ...mockDiscoveredMarket,
  config: {
    ...mockMarketConfig,
    oracleAuthority: PublicKey.default, // User-owned oracle
  },
};

export const mockMarkets = new Map<string, { market: DiscoveredMarket }>([
  [MOCK_SLAB_ADDRESS.toBase58(), { market: mockDiscoveredMarket }],
]);
