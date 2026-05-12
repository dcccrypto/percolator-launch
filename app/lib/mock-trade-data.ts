/**
 * Mock trade page data for local design testing.
 * When a mock slab address is visited, SlabProvider and PriceChart
 * use this data instead of fetching from chain.
 */
import { PublicKey } from "@solana/web3.js";
import type { MarketConfig, EngineState, RiskParams, SlabHeader, Account } from "@percolatorct/sdk";
import { AccountKind } from "@percolatorct/sdk";
import type { PortfolioPosition } from "@/hooks/usePortfolio";

interface MockMarketData {
  symbol: string;
  priceUsd: number;
  mint: string;
  maxLeverage: number;
  /** When true, market runs in HYPERP mode (indexFeedId = zero → Hyperp EMA).
   *  When false, market runs in PYTH-pinned mode (real Pyth feed configured). */
  adminOracle: boolean;
  oi: bigint;
  capital: bigint;
  insurance: bigint;
  vault: bigint;
  numAccounts: number;
  tradingFeeBps: number;
  initialMarginBps: number;
  /** Token decimals on the base mint (used for OI USD conversion in MarketInfoBar). */
  decimals: number;
  /** Pre-resolved logo URL. CoinGecko CDN is the most reliable source for
   *  meme/long-tail tokens (solana-labs/token-list 404s for BONK et al). */
  logoUrl: string;
}

// Prices refreshed 2026-05-12 against CoinGecko spot. Trading fees set to
// 10 bps everywhere to match the verified code charging (was 25-50). Initial
// margin standardised at 1000 bps (10%) to match deck claim. OI/vault/account
// counts represent a "closed beta with moderate testing activity" state.
//
// adminOracle=true → HYPERP EMA mode (no Pyth feed, on-chain DEX pool oracle).
// BONK runs HYPERP because that's the deck's long-tail story.
const MOCK_MAP: Record<string, MockMarketData> = {
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU": { symbol: "SOL",  priceUsd: 96.63,      mint: "So11111111111111111111111111111111111111112",  maxLeverage: 10, adminOracle: false, oi: 320_000_000_000n, capital: 480_000_000_000n, insurance: 32_000_000_000n, vault: 750_000_000_000n, numAccounts: 38, tradingFeeBps: 10, initialMarginBps: 1000, decimals: 9, logoUrl: "https://assets.coingecko.com/coins/images/4128/standard/solana.png" },
  "9mRGKzEEQBus4bZ1YKg4tVEMx7fPYEBV5Pz9bGJjp7Cr": { symbol: "USDC", priceUsd: 1.00,       mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", maxLeverage: 5,  adminOracle: false, oi: 12_000_000_000n,  capital: 30_000_000_000n,  insurance: 3_000_000_000n,  vault: 45_000_000_000n,  numAccounts: 6,  tradingFeeBps: 10, initialMarginBps: 1000, decimals: 6, logoUrl: "https://assets.coingecko.com/coins/images/6319/standard/usdc.png" },
  "4nF7d2Z3oF8bTKwhat9k8xsR1TLAo9U7Bd2Rk3pYJne5": { symbol: "WIF",  priceUsd: 0.2275,     mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", maxLeverage: 10, adminOracle: true,  oi: 95_000_000_000n,  capital: 140_000_000_000n, insurance: 11_000_000_000n, vault: 220_000_000_000n, numAccounts: 27, tradingFeeBps: 10, initialMarginBps: 1000, decimals: 6, logoUrl: "https://assets.coingecko.com/coins/images/33566/standard/dogwifhat.jpg" },
  "B8mnfpCEt2z3SMz4giHGPNMB3DzBAJEYrPq9Uhnj4zXh": { symbol: "JUP",  priceUsd: 0.2469,     mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", maxLeverage: 10, adminOracle: false, oi: 38_000_000_000n,  capital: 65_000_000_000n,  insurance: 5_500_000_000n,  vault: 110_000_000_000n, numAccounts: 14, tradingFeeBps: 10, initialMarginBps: 1000, decimals: 6, logoUrl: "https://assets.coingecko.com/coins/images/34188/standard/jup.png" },
  "HN7cABqLq46Es1jh92hQnvWo6BuZPdSmTQ5P2NMeVRgr": { symbol: "BONK", priceUsd: 0.00000744, mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", maxLeverage: 10, adminOracle: true,  oi: 142_000_000_000n, capital: 195_000_000_000n, insurance: 14_500_000_000n, vault: 310_000_000_000n, numAccounts: 31, tradingFeeBps: 10, initialMarginBps: 1000, decimals: 5, logoUrl: "https://assets.coingecko.com/coins/images/28600/standard/bonk.jpg" },
  "FMJ1DFWV96VKb5z8hnRp5LJaP7RPAywUbioiRvLqZafV": { symbol: "RAY",  priceUsd: 0.8499,     mint: "RaydiumPoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", maxLeverage: 10, adminOracle: false, oi: 28_000_000_000n,  capital: 50_000_000_000n,  insurance: 4_200_000_000n,  vault: 78_000_000_000n,  numAccounts: 11, tradingFeeBps: 10, initialMarginBps: 1000, decimals: 6, logoUrl: "https://assets.coingecko.com/coins/images/13928/standard/PSigc4ie_400x400.jpg" },
  "3Kat5BEzHTZmJYBR1QnP4FCn2jJRYkSgnTMGV4cANQrM": { symbol: "ORCA", priceUsd: 1.63,       mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",  maxLeverage: 10, adminOracle: false, oi: 15_000_000_000n,  capital: 32_000_000_000n,  insurance: 2_800_000_000n,  vault: 48_000_000_000n,  numAccounts: 8,  tradingFeeBps: 10, initialMarginBps: 1000, decimals: 6, logoUrl: "https://assets.coingecko.com/coins/images/17547/standard/Orca_Logo.png" },
  "5F2nFaJfVoR91EVBTzkg9hEb8w2jhaQD65FKmjfwUzSN": { symbol: "mSOL", priceUsd: 105.32,     mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", maxLeverage: 10, adminOracle: false, oi: 85_000_000_000n,  capital: 130_000_000_000n, insurance: 10_500_000_000n, vault: 200_000_000_000n, numAccounts: 24, tradingFeeBps: 10, initialMarginBps: 1000, decimals: 9, logoUrl: "https://assets.coingecko.com/coins/images/17752/standard/mSOL.png" },
  "ArK3jGAHqPxTEHsMgrLwRbKMzH4DS7nVPEfkjxhpb9fn": { symbol: "WETH", priceUsd: 2315.67,    mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", maxLeverage: 10, adminOracle: false, oi: 215_000_000_000n, capital: 310_000_000_000n, insurance: 24_000_000_000n, vault: 480_000_000_000n, numAccounts: 35, tradingFeeBps: 10, initialMarginBps: 1000, decimals: 8, logoUrl: "https://assets.coingecko.com/coins/images/279/standard/ethereum.png" },
  "2qVfA7g3bKfc7WJBb6RvTa5rJFmB8itu4C88Rdg1xN8z": { symbol: "PYTH", priceUsd: 0.0572,     mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", maxLeverage: 10, adminOracle: false, oi: 8_500_000_000n,   capital: 18_000_000_000n,  insurance: 1_600_000_000n,  vault: 26_000_000_000n,  numAccounts: 5,  tradingFeeBps: 10, initialMarginBps: 1000, decimals: 6, logoUrl: "https://assets.coingecko.com/coins/images/31924/standard/pyth.png" },
};

export function isMockSlab(address: string): boolean {
  return address in MOCK_MAP;
}

export function getMockSymbol(address: string): string | null {
  // Check by slab address first
  if (address in MOCK_MAP) return MOCK_MAP[address].symbol;
  // Check by mint address
  for (const m of Object.values(MOCK_MAP)) {
    if (m.mint === address) return m.symbol;
  }
  return null;
}

export function getMockSlabState(address: string) {
  const m = MOCK_MAP[address];
  if (!m) return null;

  const priceE6 = BigInt(Math.round(m.priceUsd * 1_000_000));
  const mintPk = (() => { try { return new PublicKey(m.mint); } catch { return PublicKey.default; } })();

  const config: MarketConfig = {
    collateralMint: mintPk,
    vaultPubkey: PublicKey.default,
    indexFeedId: m.adminOracle ? PublicKey.default : new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
    maxStalenessSlots: 100n,
    confFilterBps: 50,
    vaultAuthorityBump: 255,
    invert: 0,
    unitScale: 0,
    fundingHorizonSlots: 216000n,
    fundingKBps: 100n,
    fundingInvScaleNotionalE6: 1000000n,
    fundingMaxPremiumBps: 500n,
    fundingMaxBpsPerSlot: 1n,
    threshFloor: 100n,
    threshRiskBps: 500n,
    threshUpdateIntervalSlots: 100n,
    threshStepBps: 10n,
    threshAlphaBps: 50n,
    threshMin: 10n,
    threshMax: 1000n,
    threshMinStep: 1n,
    oracleAuthority: PublicKey.default,
    authorityPriceE6: priceE6,
    authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    oraclePriceCapE2bps: 500n,
    lastEffectivePriceE6: priceE6,
    oiCapMultiplierBps: 0n,
    maxPnlCap: 0n,
    marketCreatedSlot: 0n,
    oiRampSlots: 0n,
  } as MarketConfig;

  const engine: EngineState = {
    vault: m.vault,
    insuranceFund: { balance: m.insurance, feeRevenue: 0n, isolatedBalance: 0n, isolationBps: 0 },
    currentSlot: 300_000_000n,
    fundingIndexQpbE6: 0n,
    lastFundingSlot: 299_999_990n,
    fundingRateBpsPerSlotLast: 0n,
    fundingRateE9: 0n,
    marketMode: 0,
    lastCrankSlot: 299_999_995n,
    maxCrankStalenessSlots: 100n,
    totalOpenInterest: m.oi,
    longOi: m.oi / 2n,
    shortOi: m.oi / 2n,
    cTot: m.capital,
    pnlPosTot: 0n,
    pnlMaturedPosTot: 0n,
    liqCursor: 0,
    gcCursor: 0,
    lastSweepStartSlot: 0n,
    lastSweepCompleteSlot: 0n,
    crankCursor: 0,
    sweepStartIdx: 0,
    lifetimeLiquidations: 3n,
    lifetimeForceCloses: 1n,
    netLpPos: 0n,
    lpSumAbs: 0n,
    lpMaxAbs: 0n,
    lpMaxAbsSweep: 0n,
    emergencyOiMode: false,
    emergencyStartSlot: 0n,
    lastBreakerSlot: 0n,
    markPriceE6: priceE6,
    oraclePriceE6: priceE6,
    numUsedAccounts: m.numAccounts,
    nextAccountId: BigInt(m.numAccounts + 1),
    fLongNum: 0n,
    fShortNum: 0n,
    negPnlAccountCount: 0n,
    fundPxLast: 0n,
    resolvedKLongTerminalDelta: 0n,
    resolvedKShortTerminalDelta: 0n,
    resolvedLivePrice: 0n,
  } as EngineState;

  const params: RiskParams = {
    warmupPeriodSlots: 10n,
    maintenanceMarginBps: BigInt(Math.floor(m.initialMarginBps / 2)),
    initialMarginBps: BigInt(m.initialMarginBps),
    tradingFeeBps: BigInt(m.tradingFeeBps),
    maxAccounts: 256n,
    newAccountFee: 0n,
    riskReductionThreshold: 0n,
    maintenanceFeePerSlot: 0n,
    maxCrankStalenessSlots: 100n,
    liquidationFeeBps: 50n,
    liquidationFeeCap: 1_000_000n,
    liquidationBufferBps: 100n,
    minLiquidationAbs: 1000n,
  } as RiskParams;

  const header = {
    magic: new Uint8Array([0x54, 0x41, 0x4c, 0x4f, 0x43, 0x52, 0x45, 0x50]),
    version: 1,
    maxAccounts: 256,
  } as unknown as SlabHeader;

  // Generate mock accounts with open positions
  const mockAccount = (
    idx: number, kind: AccountKind, posSize: bigint, entryE6: bigint,
    capital: bigint, pnl: bigint,
  ): { idx: number; account: Account } => ({
    idx,
    account: {
      kind,
      accountId: BigInt(idx + 1),
      capital,
      pnl,
      reservedPnl: 0n,
      warmupStartedAtSlot: 0n,
      warmupSlopePerStep: 0n,
      positionSize: posSize,
      entryPrice: entryE6,
      fundingIndex: 0n,
      matcherProgram: PublicKey.default,
      matcherContext: PublicKey.default,
      owner: new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
      feeCredits: 0n,
      lastFeeSlot: 0n,
      feesEarnedTotal: 0n,
      exactReserveCohorts: null,
      exactCohortCount: null,
      overflowOlder: null,
      overflowOlderPresent: null,
      overflowNewest: null,
      overflowNewestPresent: null,
      fSnap: 0n,
      adlABasis: 0n,
      adlKSnap: 0n,
      adlEpochSnap: 0n,
      schedPresent: null,
      schedRemainingQ: null,
      schedAnchorQ: null,
      schedStartSlot: null,
      schedHorizon: null,
      schedReleaseQ: null,
      pendingPresent: null,
      pendingRemainingQ: null,
      pendingHorizon: null,
      pendingCreatedSlot: null,
    } as Account,
  });

  const entryOffsets = [0.97, 1.03, 0.95, 1.05, 0.99, 1.01];
  const accounts = [
    // LP account (idx 0)
    mockAccount(0, AccountKind.LP, 0n, 0n, m.capital / 2n, 0n),
    // Open positions
    ...Array.from({ length: Math.min(m.numAccounts, 6) }, (_, i) => {
      const isLong = i % 3 !== 0;
      const entryE6 = BigInt(Math.round(m.priceUsd * (entryOffsets[i % entryOffsets.length]) * 1_000_000));
      const size = BigInt(Math.round((1000 + i * 500) * 1_000_000)) * (isLong ? 1n : -1n);
      const priceDiff = priceE6 - entryE6;
      const pnlVal = isLong ? (size * priceDiff / 1_000_000n) : (-size * priceDiff / 1_000_000n);
      const cap = BigInt(Math.round((500 + i * 200) * 1_000_000));
      return mockAccount(i + 1, AccountKind.User, size, entryE6, cap, pnlVal);
    }),
  ];

  return { header, config, engine, params, accounts };
}

/* ── Helpers re-exported for mock components ── */

export const MOCK_SLAB_ADDRESSES = Object.keys(MOCK_MAP);

export function getMockMarketData(address: string): MockMarketData | null {
  return MOCK_MAP[address] ?? null;
}

/**
 * Supabase-shaped market metadata for mock slabs. Returned by useMarketInfo
 * when running in mock mode so MarketLogo, MarketInfoBar (OI conversion,
 * 24h volume), and other UI bits render correctly without DB access.
 *
 * Returns a partial of `markets_with_stats` shape; only fields the UI reads
 * are populated. Cast to MarketWithStats at the call site.
 */
export function getMockMarketInfo(address: string) {
  const m = MOCK_MAP[address];
  if (!m) return null;
  // Pseudo-random but seeded volume so screenshots stay stable per slab
  let seed = 0;
  for (let i = 0; i < address.length; i++) seed = ((seed << 5) - seed + address.charCodeAt(i)) | 0;
  const seedScale = ((seed & 0x7fffffff) % 1000) / 1000; // 0–1
  const volumeUsd24h = Math.round(40_000 + seedScale * 220_000); // $40K–$260K plausible long-tail closed-beta volume

  return {
    slab_address: address,
    symbol: m.symbol,
    logo_url: m.logoUrl,
    decimals: m.decimals,
    mainnet_ca: m.mint,
    volume_24h: volumeUsd24h,
    total_open_interest: Number(m.oi),
    num_accounts: m.numAccounts,
    is_active: true,
    paused: false,
  };
}

/* ── Mock user account for trade page ── */

export function getMockUserAccount(address: string) {
  const m = MOCK_MAP[address];
  if (!m) return null;
  const priceE6 = BigInt(Math.round(m.priceUsd * 1_000_000));
  // User with capital deposited, an open LONG position
  const entryE6 = BigInt(Math.round(m.priceUsd * 0.97 * 1_000_000));
  const capital = 50_000_000n; // 50 tokens
  const posSize = 150_000_000n; // 150 tokens long (3x leverage)
  const pnl = (posSize * (priceE6 - entryE6)) / 1_000_000n;
  return {
    idx: 2,
    account: {
      kind: AccountKind.User,
      accountId: 2n,
      capital,
      pnl,
      reservedPnl: 0n,
      warmupStartedAtSlot: 0n,
      warmupSlopePerStep: 0n,
      positionSize: posSize,
      entryPrice: entryE6,
      fundingIndex: 0n,
      matcherProgram: PublicKey.default,
      matcherContext: PublicKey.default,
      owner: new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
      feeCredits: 0n,
      lastFeeSlot: 0n,
      feesEarnedTotal: 0n,
      exactReserveCohorts: null,
      exactCohortCount: null,
      overflowOlder: null,
      overflowOlderPresent: null,
      overflowNewest: null,
      overflowNewestPresent: null,
      fSnap: 0n,
      adlABasis: 0n,
      adlKSnap: 0n,
      adlEpochSnap: 0n,
      schedPresent: null,
      schedRemainingQ: null,
      schedAnchorQ: null,
      schedStartSlot: null,
      schedHorizon: null,
      schedReleaseQ: null,
      pendingPresent: null,
      pendingRemainingQ: null,
      pendingHorizon: null,
      pendingCreatedSlot: null,
    } as Account,
  };
}

/** Mock user account with NO open position (for showing the trade form) */
export function getMockUserAccountIdle(address: string) {
  const m = MOCK_MAP[address];
  if (!m) return null;
  const capital = 50_000_000n;
  return {
    idx: 2,
    account: {
      kind: AccountKind.User,
      accountId: 2n,
      capital,
      pnl: 0n,
      reservedPnl: 0n,
      warmupStartedAtSlot: 0n,
      warmupSlopePerStep: 0n,
      positionSize: 0n,
      entryPrice: 0n,
      fundingIndex: 0n,
      matcherProgram: PublicKey.default,
      matcherContext: PublicKey.default,
      owner: new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
      feeCredits: 0n,
      lastFeeSlot: 0n,
      feesEarnedTotal: 0n,
      exactReserveCohorts: null,
      exactCohortCount: null,
      overflowOlder: null,
      overflowOlderPresent: null,
      overflowNewest: null,
      overflowNewestPresent: null,
      fSnap: 0n,
      adlABasis: 0n,
      adlKSnap: 0n,
      adlEpochSnap: 0n,
      schedPresent: null,
      schedRemainingQ: null,
      schedAnchorQ: null,
      schedStartSlot: null,
      schedHorizon: null,
      schedReleaseQ: null,
      pendingPresent: null,
      pendingRemainingQ: null,
      pendingHorizon: null,
      pendingCreatedSlot: null,
    } as Account,
  };
}

/* ── Mock trade history ── */

export function getMockTrades(address: string) {
  const m = MOCK_MAP[address];
  if (!m) return [];
  const now = Date.now();
  const trades = [];
  // Seeded PRNG
  let seed = 0;
  for (let i = 0; i < address.length; i++) seed = ((seed << 5) - seed + address.charCodeAt(i)) | 0;
  function rand() { seed = (seed * 16807 + 0) % 2147483647; return (seed & 0x7fffffff) / 0x7fffffff; }

  for (let i = 0; i < 20; i++) {
    const side = rand() > 0.5 ? "long" : "short";
    const size = Math.round((500 + rand() * 5000) * 1_000_000);
    const priceOffset = (rand() - 0.5) * m.priceUsd * 0.02;
    const price = Math.round((m.priceUsd + priceOffset) * 1_000_000);
    const time = new Date(now - i * 180_000 - Math.round(rand() * 60_000));
    trades.push({
      id: `mock-${i}`,
      side,
      size,
      price,
      fee: Math.round(size * 0.001), // 10 bps to match market config
      trader: "7xKXtg" + i.toString().padStart(2, "0"),
      tx_signature: "mock" + "x".repeat(80) + i,
      created_at: time.toISOString(),
    });
  }
  return trades;
}

/* ── Mock portfolio positions ── */

export function getMockPortfolioPositions(): PortfolioPosition[] {
  const positions: PortfolioPosition[] = [];
  const slabs = Object.entries(MOCK_MAP);
  // Pick a subset that have open positions
  const withPositions = slabs.filter((_, i) => i < 4);
  for (const [slabAddr, m] of withPositions) {
    const priceE6 = BigInt(Math.round(m.priceUsd * 1_000_000));
    const isLong: boolean = positions.length % 2 === 0;
    const entryOffset: number = isLong ? 0.97 : 1.03;
    const entryE6: bigint = BigInt(Math.round(m.priceUsd * entryOffset * 1_000_000));
    const posSize: bigint = BigInt(Math.round((1000 + positions.length * 500) * 1_000_000)) * (isLong ? 1n : -1n);
    const priceDiff: bigint = priceE6 - entryE6;
    const pnl: bigint = isLong ? (posSize * priceDiff / 1_000_000n) : (-posSize * priceDiff / 1_000_000n);
    const capital: bigint = BigInt(Math.round((500 + positions.length * 200) * 1_000_000));
    const mintPk = (() => { try { return new PublicKey(m.mint); } catch { return PublicKey.default; } })();

    // Compute enriched fields that PortfolioPosition requires
    const absPosSize = posSize < 0n ? -posSize : posSize;
    const notional = Number(absPosSize) / 1e6 * Number(priceE6) / 1e6;
    const capitalNum = Number(capital) / 1e6;
    const leverage = capitalNum > 0 ? notional / capitalNum : 0;
    const pnlNum = Number(pnl) / 1e6;
    const pnlPercent = capitalNum > 0 ? (pnlNum / capitalNum) * 100 : 0;
    const maintenanceBps = BigInt(m.initialMarginBps / 2);
    // Mock liquidation: assume liq at 80% loss for longs, 120% gain for shorts
    const liqFactor = isLong ? 0.2 : 1.8;
    const liquidationPriceE6 = BigInt(Math.round(m.priceUsd * liqFactor * 1_000_000));
    const liqDist = isLong
      ? (Number(priceE6 - liquidationPriceE6) / Number(priceE6)) * 100
      : (Number(liquidationPriceE6 - priceE6) / Number(priceE6)) * 100;
    const liquidationDistancePct = Math.max(0, Math.min(100, liqDist));

    positions.push({
      slabAddress: slabAddr,
      symbol: m.symbol,
      idx: 2,
      effectiveEntryPrice: entryE6,
      oraclePriceE6: priceE6,
      liquidationPriceE6,
      liquidationDistancePct,
      unrealizedPnl: pnl,
      pnlPercent,
      leverage,
      maintenanceMarginBps: maintenanceBps,
      account: {
        kind: AccountKind.User,
        accountId: BigInt(positions.length + 1),
        capital,
        pnl,
        reservedPnl: 0n,
        warmupStartedAtSlot: 0n,
        warmupSlopePerStep: 0n,
        positionSize: posSize,
        entryPrice: entryE6,
        fundingIndex: 0n,
        matcherProgram: PublicKey.default,
        matcherContext: PublicKey.default,
        owner: new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
        feeCredits: 0n,
        lastFeeSlot: 0n,
        feesEarnedTotal: 0n,
        exactReserveCohorts: null,
        exactCohortCount: null,
        overflowOlder: null,
        overflowOlderPresent: null,
        overflowNewest: null,
        overflowNewestPresent: null,
        fSnap: 0n,
        adlABasis: 0n,
        adlKSnap: 0n,
        adlEpochSnap: 0n,
        schedPresent: null,
        schedRemainingQ: null,
        schedAnchorQ: null,
        schedStartSlot: null,
        schedHorizon: null,
        schedReleaseQ: null,
        pendingPresent: null,
        pendingRemainingQ: null,
        pendingHorizon: null,
        pendingCreatedSlot: null,
      } as Account,
      market: {
        slabAddress: new PublicKey(slabAddr),
        programId: PublicKey.default,
        header: { magic: new Uint8Array(8), version: 1, maxAccounts: 256, admin: PublicKey.default, paused: false } as any,
        config: {
          collateralMint: mintPk,
          lastEffectivePriceE6: priceE6,
        } as any,
        engine: {
          vault: m.vault,
          insuranceFund: { balance: m.insurance, feeRevenue: 0n },
          totalOpenInterest: m.oi,
          numUsedAccounts: m.numAccounts,
        } as any,
        params: {
          initialMarginBps: BigInt(m.initialMarginBps),
          maintenanceMarginBps: maintenanceBps,
          tradingFeeBps: BigInt(m.tradingFeeBps),
        } as any,
      },
    });
  }
  return positions;
}

/* ── Mock my-markets data ── */

export function getMockMyMarkets() {
  const slabs = Object.entries(MOCK_MAP).slice(0, 3);
  return slabs.map(([slabAddr, m], i) => {
    const mintPk = (() => { try { return new PublicKey(m.mint); } catch { return PublicKey.default; } })();
    const priceE6 = BigInt(Math.round(m.priceUsd * 1_000_000));
    return {
      slabAddress: new PublicKey(slabAddr),
      programId: PublicKey.default,
      label: `${m.symbol}/USD`,
      role: (i === 0 ? "admin" : i === 1 ? "lp" : "trader") as "admin" | "lp" | "trader",
      header: {
        magic: new Uint8Array(8),
        version: 1,
        maxAccounts: 256,
        admin: new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
        paused: false,
      } as any,
      config: {
        collateralMint: mintPk,
        lastEffectivePriceE6: priceE6,
        authorityPriceE6: priceE6,
        oracleAuthority: new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"),
      } as any,
      engine: {
        vault: m.vault,
        insuranceFund: { balance: m.insurance, feeRevenue: 0n },
        totalOpenInterest: m.oi,
        currentSlot: 300_000_000n,
        lastCrankSlot: 299_999_995n,
        maxCrankStalenessSlots: 100n,
        numUsedAccounts: m.numAccounts,
      } as any,
      params: {
        initialMarginBps: BigInt(m.initialMarginBps),
        maintenanceMarginBps: BigInt(m.initialMarginBps / 2),
        tradingFeeBps: BigInt(m.tradingFeeBps),
        riskReductionThreshold: 0n,
      } as any,
    };
  });
}

/** Generate synthetic 24h price history for mock markets */
export function getMockPriceHistory(address: string): { price_e6: number; timestamp: number }[] {
  const m = MOCK_MAP[address];
  if (!m) return [];

  const now = Math.floor(Date.now() / 1000);
  const points: { price_e6: number; timestamp: number }[] = [];
  const numPoints = 200;
  const interval = Math.floor((24 * 60 * 60) / numPoints); // ~7min per point

  // Seeded PRNG from address for consistent results
  let seed = 0;
  for (let i = 0; i < address.length; i++) seed = ((seed << 5) - seed + address.charCodeAt(i)) | 0;
  function rand() { seed = (seed * 16807 + 0) % 2147483647; return (seed & 0x7fffffff) / 0x7fffffff; }

  const basePrice = m.priceUsd;
  const volatility = basePrice * 0.03; // 3% daily volatility
  let price = basePrice * (1 - 0.015 + rand() * 0.03); // Start slightly off

  for (let i = 0; i < numPoints; i++) {
    const t = now - (numPoints - i) * interval;
    // Random walk with mean reversion toward basePrice
    const drift = (basePrice - price) * 0.02;
    const noise = (rand() - 0.5) * volatility * 0.15;
    price = Math.max(price * 0.5, price + drift + noise);
    points.push({ price_e6: Math.round(price * 1_000_000), timestamp: t });
  }

  // Ensure last point is close to the target price
  points[points.length - 1].price_e6 = Math.round(basePrice * 1_000_000);

  return points;
}
