import { PublicKey, AccountMeta, Connection, TransactionInstruction, Keypair, Commitment } from '@solana/web3.js';
import { Account as Account$1 } from '@solana/spl-token';

/**
 * Encode u8 (1 byte)
 */
declare function encU8(val: number): Uint8Array;
/**
 * Encode u16 little-endian (2 bytes)
 */
declare function encU16(val: number): Uint8Array;
/**
 * Encode u32 little-endian (4 bytes)
 */
declare function encU32(val: number): Uint8Array;
/**
 * Encode u64 little-endian (8 bytes)
 * Input: bigint or string (decimal)
 */
declare function encU64(val: bigint | string): Uint8Array;
/**
 * Encode i64 little-endian (8 bytes), two's complement
 * Input: bigint or string (decimal, may be negative)
 */
declare function encI64(val: bigint | string): Uint8Array;
/**
 * Encode u128 little-endian (16 bytes)
 * Input: bigint or string (decimal)
 */
declare function encU128(val: bigint | string): Uint8Array;
/**
 * Encode i128 little-endian (16 bytes), two's complement
 * Input: bigint or string (decimal, may be negative)
 */
declare function encI128(val: bigint | string): Uint8Array;
/**
 * Encode a PublicKey (32 bytes)
 * Input: PublicKey or base58 string
 */
declare function encPubkey(val: PublicKey | string): Uint8Array;
/**
 * Encode a boolean as u8 (0 = false, 1 = true)
 */
declare function encBool(val: boolean): Uint8Array;
/**
 * Concatenate multiple Uint8Arrays (replaces Buffer.concat)
 */
declare function concatBytes(...arrays: Uint8Array[]): Uint8Array;

/**
 * Instruction tags - exact match to Rust ix::Instruction::decode
 */
declare const IX_TAG: {
    readonly InitMarket: 0;
    readonly InitUser: 1;
    readonly InitLP: 2;
    readonly DepositCollateral: 3;
    readonly WithdrawCollateral: 4;
    readonly KeeperCrank: 5;
    readonly TradeNoCpi: 6;
    readonly LiquidateAtOracle: 7;
    readonly CloseAccount: 8;
    readonly TopUpInsurance: 9;
    readonly TradeCpi: 10;
    readonly SetRiskThreshold: 11;
    readonly UpdateAdmin: 12;
    readonly CloseSlab: 13;
    readonly UpdateConfig: 14;
    readonly SetMaintenanceFee: 15;
    readonly SetOracleAuthority: 16;
    readonly PushOraclePrice: 17;
    readonly SetOraclePriceCap: 18;
    readonly ResolveMarket: 19;
    readonly WithdrawInsurance: 20;
    readonly AdminForceClose: 21;
    readonly UpdateRiskParams: 22;
    readonly RenounceAdmin: 23;
    readonly CreateInsuranceMint: 24;
    readonly DepositInsuranceLP: 25;
    readonly WithdrawInsuranceLP: 26;
    readonly PauseMarket: 27;
    readonly UnpauseMarket: 28;
    readonly AcceptAdmin: 29;
    readonly SetInsuranceWithdrawPolicy: 30;
    readonly WithdrawInsuranceLimited: 31;
    readonly SetPythOracle: 32;
    readonly UpdateMarkPrice: 33;
    readonly UpdateHyperpMark: 34;
    readonly TradeCpiV2: 35;
};
/**
 * InitMarket instruction data (256 bytes total)
 * Layout: tag(1) + admin(32) + mint(32) + indexFeedId(32) +
 *         maxStaleSecs(8) + confFilter(2) + invert(1) + unitScale(4) +
 *         RiskParams(144)
 *
 * Note: indexFeedId is the Pyth Pull feed ID (32 bytes hex), NOT an oracle pubkey.
 * The program validates PriceUpdateV2 accounts against this feed ID at runtime.
 */
interface InitMarketArgs {
    admin: PublicKey | string;
    collateralMint: PublicKey | string;
    indexFeedId: string;
    maxStalenessSecs: bigint | string;
    confFilterBps: number;
    invert: number;
    unitScale: number;
    initialMarkPriceE6: bigint | string;
    warmupPeriodSlots: bigint | string;
    maintenanceMarginBps: bigint | string;
    initialMarginBps: bigint | string;
    tradingFeeBps: bigint | string;
    maxAccounts: bigint | string;
    newAccountFee: bigint | string;
    riskReductionThreshold: bigint | string;
    maintenanceFeePerSlot: bigint | string;
    maxCrankStalenessSlots: bigint | string;
    liquidationFeeBps: bigint | string;
    liquidationFeeCap: bigint | string;
    liquidationBufferBps: bigint | string;
    minLiquidationAbs: bigint | string;
}
declare function encodeInitMarket(args: InitMarketArgs): Uint8Array;
/**
 * InitUser instruction data (9 bytes)
 */
interface InitUserArgs {
    feePayment: bigint | string;
}
declare function encodeInitUser(args: InitUserArgs): Uint8Array;
/**
 * InitLP instruction data (73 bytes)
 */
interface InitLPArgs {
    matcherProgram: PublicKey | string;
    matcherContext: PublicKey | string;
    feePayment: bigint | string;
}
declare function encodeInitLP(args: InitLPArgs): Uint8Array;
/**
 * DepositCollateral instruction data (11 bytes)
 */
interface DepositCollateralArgs {
    userIdx: number;
    amount: bigint | string;
}
declare function encodeDepositCollateral(args: DepositCollateralArgs): Uint8Array;
/**
 * WithdrawCollateral instruction data (11 bytes)
 */
interface WithdrawCollateralArgs {
    userIdx: number;
    amount: bigint | string;
}
declare function encodeWithdrawCollateral(args: WithdrawCollateralArgs): Uint8Array;
/**
 * KeeperCrank instruction data (4 bytes)
 * Funding rate is computed on-chain from LP inventory.
 */
interface KeeperCrankArgs {
    callerIdx: number;
    allowPanic: boolean;
}
declare function encodeKeeperCrank(args: KeeperCrankArgs): Uint8Array;
/**
 * TradeNoCpi instruction data (21 bytes)
 */
interface TradeNoCpiArgs {
    lpIdx: number;
    userIdx: number;
    size: bigint | string;
}
declare function encodeTradeNoCpi(args: TradeNoCpiArgs): Uint8Array;
/**
 * LiquidateAtOracle instruction data (3 bytes)
 */
interface LiquidateAtOracleArgs {
    targetIdx: number;
}
declare function encodeLiquidateAtOracle(args: LiquidateAtOracleArgs): Uint8Array;
/**
 * CloseAccount instruction data (3 bytes)
 */
interface CloseAccountArgs {
    userIdx: number;
}
declare function encodeCloseAccount(args: CloseAccountArgs): Uint8Array;
/**
 * TopUpInsurance instruction data (9 bytes)
 */
interface TopUpInsuranceArgs {
    amount: bigint | string;
}
declare function encodeTopUpInsurance(args: TopUpInsuranceArgs): Uint8Array;
/**
 * TradeCpi instruction data (21 bytes)
 */
interface TradeCpiArgs {
    lpIdx: number;
    userIdx: number;
    size: bigint | string;
}
declare function encodeTradeCpi(args: TradeCpiArgs): Uint8Array;
/**
 * TradeCpiV2 instruction data (22 bytes) — PERC-154 optimized trade CPI.
 *
 * Same as TradeCpi but includes a caller-provided PDA bump byte.
 * Uses create_program_address instead of find_program_address,
 * saving ~1500 CU per trade. The bump should be obtained once via
 * deriveLpPda() and cached for the lifetime of the market.
 */
interface TradeCpiV2Args {
    lpIdx: number;
    userIdx: number;
    size: bigint | string;
    bump: number;
}
declare function encodeTradeCpiV2(args: TradeCpiV2Args): Uint8Array;
/**
 * SetRiskThreshold instruction data (17 bytes)
 */
interface SetRiskThresholdArgs {
    newThreshold: bigint | string;
}
declare function encodeSetRiskThreshold(args: SetRiskThresholdArgs): Uint8Array;
/**
 * UpdateAdmin instruction data (33 bytes)
 */
interface UpdateAdminArgs {
    newAdmin: PublicKey | string;
}
declare function encodeUpdateAdmin(args: UpdateAdminArgs): Uint8Array;
/**
 * CloseSlab instruction data (1 byte)
 */
declare function encodeCloseSlab(): Uint8Array;
/**
 * UpdateConfig instruction data
 * Updates funding and threshold parameters at runtime (admin only)
 */
interface UpdateConfigArgs {
    fundingHorizonSlots: bigint | string;
    fundingKBps: bigint | string;
    fundingInvScaleNotionalE6: bigint | string;
    fundingMaxPremiumBps: bigint | string;
    fundingMaxBpsPerSlot: bigint | string;
    threshFloor: bigint | string;
    threshRiskBps: bigint | string;
    threshUpdateIntervalSlots: bigint | string;
    threshStepBps: bigint | string;
    threshAlphaBps: bigint | string;
    threshMin: bigint | string;
    threshMax: bigint | string;
    threshMinStep: bigint | string;
}
declare function encodeUpdateConfig(args: UpdateConfigArgs): Uint8Array;
/**
 * SetMaintenanceFee instruction data (17 bytes)
 */
interface SetMaintenanceFeeArgs {
    newFee: bigint | string;
}
declare function encodeSetMaintenanceFee(args: SetMaintenanceFeeArgs): Uint8Array;
/**
 * SetOracleAuthority instruction data (33 bytes)
 * Sets the oracle price authority. Pass zero pubkey to disable and require Pyth/Chainlink.
 */
interface SetOracleAuthorityArgs {
    newAuthority: PublicKey | string;
}
declare function encodeSetOracleAuthority(args: SetOracleAuthorityArgs): Uint8Array;
/**
 * PushOraclePrice instruction data (17 bytes)
 * Push a new oracle price (oracle authority only).
 * The price should be in e6 format and already include any inversion/scaling.
 */
interface PushOraclePriceArgs {
    priceE6: bigint | string;
    timestamp: bigint | string;
}
declare function encodePushOraclePrice(args: PushOraclePriceArgs): Uint8Array;
/**
 * SetOraclePriceCap instruction data (9 bytes)
 * Set oracle price circuit breaker cap (admin only).
 * max_change_e2bps in 0.01 bps units (1_000_000 = 100%). 0 = disabled.
 */
interface SetOraclePriceCapArgs {
    maxChangeE2bps: bigint | string;
}
declare function encodeSetOraclePriceCap(args: SetOraclePriceCapArgs): Uint8Array;
/**
 * ResolveMarket instruction data (1 byte)
 * Resolves a binary/premarket - sets RESOLVED flag, positions force-closed via crank.
 * Requires admin oracle price (authority_price_e6) to be set first.
 */
declare function encodeResolveMarket(): Uint8Array;
/**
 * WithdrawInsurance instruction data (1 byte)
 * Withdraw insurance fund to admin (requires RESOLVED and all positions closed).
 */
declare function encodeWithdrawInsurance(): Uint8Array;
/**
 * AdminForceClose instruction data (3 bytes)
 * Force-close any position at oracle price (admin only, skips margin checks).
 */
interface AdminForceCloseArgs {
    targetIdx: number;
}
declare function encodeAdminForceClose(args: AdminForceCloseArgs): Uint8Array;
/**
 * UpdateRiskParams instruction data (17 or 25 bytes)
 * Update initial and maintenance margin BPS (admin only).
 *
 * R2-S13: The Rust program uses `data.len() >= 25` to detect the optional
 * tradingFeeBps field, so variable-length encoding is safe. When tradingFeeBps
 * is omitted, the data is 17 bytes (tag + 2×u64). When included, 25 bytes.
 */
interface UpdateRiskParamsArgs {
    initialMarginBps: bigint | string;
    maintenanceMarginBps: bigint | string;
    tradingFeeBps?: bigint | string;
}
declare function encodeUpdateRiskParams(args: UpdateRiskParamsArgs): Uint8Array;
/**
 * RenounceAdmin instruction data (1 byte)
 * Irreversibly set admin to all zeros. After this, all admin-only instructions fail.
 */
declare function encodeRenounceAdmin(): Uint8Array;
/**
 * CreateInsuranceMint instruction data (1 byte)
 * Creates the SPL mint PDA for insurance LP tokens. Admin only, once per market.
 */
declare function encodeCreateInsuranceMint(): Uint8Array;
/**
 * DepositInsuranceLP instruction data (9 bytes)
 * Deposit collateral into insurance fund, receive LP tokens proportional to share.
 */
interface DepositInsuranceLPArgs {
    amount: bigint | string;
}
declare function encodeDepositInsuranceLP(args: DepositInsuranceLPArgs): Uint8Array;
/**
 * WithdrawInsuranceLP instruction data (9 bytes)
 * Burn LP tokens and withdraw proportional share of insurance fund.
 */
interface WithdrawInsuranceLPArgs {
    lpAmount: bigint | string;
}
declare function encodeWithdrawInsuranceLP(args: WithdrawInsuranceLPArgs): Uint8Array;
/**
 * PauseMarket instruction data (1 byte)
 * Pauses the market — disables trading, deposits, and withdrawals.
 */
declare function encodePauseMarket(): Uint8Array;
/**
 * UnpauseMarket instruction data (1 byte)
 * Unpauses the market — re-enables trading, deposits, and withdrawals.
 */
declare function encodeUnpauseMarket(): Uint8Array;
/**
 * SetPythOracle (Tag 32) — switch a market to Pyth-pinned mode.
 *
 * After this instruction:
 * - oracle_authority is cleared → PushOraclePrice is disabled
 * - index_feed_id is set to feed_id → validated on every price read
 * - max_staleness_secs and conf_filter_bps are updated
 * - All price reads go directly to read_pyth_price_e6() with on-chain
 *   staleness + confidence + feed-ID validation (no silent fallback)
 *
 * Instruction data: tag(1) + feed_id(32) + max_staleness_secs(8) + conf_filter_bps(2) = 43 bytes
 *
 * Accounts:
 *   0. [signer, writable] Admin
 *   1. [writable]         Slab
 */
interface SetPythOracleArgs {
    /** 32-byte Pyth feed ID. All zeros is invalid (reserved for Hyperp mode). */
    feedId: Uint8Array;
    /** Maximum age of Pyth price in seconds before OracleStale is returned. Must be > 0. */
    maxStalenessSecs: bigint;
    /** Max confidence/price ratio in bps (0 = no confidence check). */
    confFilterBps: number;
}
declare function encodeSetPythOracle(args: SetPythOracleArgs): Uint8Array;
/**
 * Derive the expected Pyth PriceUpdateV2 account address for a given feed ID.
 * Uses PDA seeds: [shard_id(2), feed_id(32)] under the Pyth Receiver program.
 *
 * @param feedId  32-byte Pyth feed ID
 * @param shardId Shard index (default 0 for mainnet/devnet)
 */
declare const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
declare function derivePythPriceUpdateAccount(feedId: Uint8Array, shardId?: number): Promise<string>;
/**
 * UpdateMarkPrice (Tag 33) — permissionless EMA mark price crank.
 *
 * Reads the current oracle price on-chain, applies 8-hour EMA smoothing
 * with circuit breaker, and writes result to authority_price_e6.
 *
 * Instruction data: 1 byte (tag only — all params read from on-chain state)
 *
 * Accounts:
 *   0. [writable] Slab
 *   1. []         Oracle account (Pyth PriceUpdateV2 / Chainlink / DEX AMM)
 *   2. []         Clock sysvar (SysvarC1ock11111111111111111111111111111111)
 *   3..N []       Remaining accounts (PumpSwap vaults, etc. if needed)
 */
declare function encodeUpdateMarkPrice(): Uint8Array;
/**
 * Mark price EMA parameters (must match program/src/percolator.rs constants).
 */
declare const MARK_PRICE_EMA_WINDOW_SLOTS = 72000n;
declare const MARK_PRICE_EMA_ALPHA_E6: bigint;
/**
 * Compute the next EMA mark price step (TypeScript mirror of the on-chain function).
 */
declare function computeEmaMarkPrice(markPrevE6: bigint, oracleE6: bigint, dtSlots: bigint, alphaE6?: bigint, capE2bps?: bigint): bigint;
/**
 * UpdateHyperpMark (Tag 34) — permissionless Hyperp EMA oracle crank.
 *
 * Reads the spot price from a PumpSwap, Raydium CLMM, or Meteora DLMM pool,
 * applies 8-hour EMA smoothing with circuit breaker, and writes the new mark
 * to authority_price_e6 on the slab.
 *
 * This is the core mechanism for permissionless token markets — no Pyth or
 * Chainlink feed is needed. The DEX AMM IS the oracle.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [writable] Slab
 *   1. []         DEX pool account (PumpSwap / Raydium CLMM / Meteora DLMM)
 *   2. []         Clock sysvar (SysvarC1ock11111111111111111111111111111111)
 *   3..N []       Remaining accounts (e.g. PumpSwap vault0 + vault1)
 */
declare function encodeUpdateHyperpMark(): Uint8Array;
/**
 * Parsed vAMM matcher parameters (from on-chain matcher context account)
 */
interface VammMatcherParams {
    mode: number;
    tradingFeeBps: number;
    baseSpreadBps: number;
    maxTotalBps: number;
    impactKBps: number;
    liquidityNotionalE6: bigint;
}
/** Magic bytes identifying a vAMM matcher context: "PERCMATC" as u64 LE */
declare const VAMM_MAGIC = 5784119745439683651n;
/** Offset into matcher context where vAMM params start */
declare const CTX_VAMM_OFFSET = 64;
/**
 * Compute execution price for a given LP quote.
 * For buys (isLong=true): price above oracle.
 * For sells (isLong=false): price below oracle.
 */
declare function computeVammQuote(params: VammMatcherParams, oraclePriceE6: bigint, tradeSize: bigint, isLong: boolean): bigint;

/**
 * Account spec for building instruction account metas.
 * Each instruction has a fixed ordering that matches the Rust processor.
 */
interface AccountSpec {
    name: string;
    signer: boolean;
    writable: boolean;
}
/**
 * InitMarket: 9 accounts (Pyth Pull - feed_id is in instruction data, not as accounts)
 */
declare const ACCOUNTS_INIT_MARKET: readonly AccountSpec[];
/**
 * InitUser: 5 accounts (clock/oracle removed in commit 410f947)
 */
declare const ACCOUNTS_INIT_USER: readonly AccountSpec[];
/**
 * InitLP: 5 accounts (clock/oracle removed in commit 410f947)
 */
declare const ACCOUNTS_INIT_LP: readonly AccountSpec[];
/**
 * DepositCollateral: 6 accounts
 */
declare const ACCOUNTS_DEPOSIT_COLLATERAL: readonly AccountSpec[];
/**
 * WithdrawCollateral: 8 accounts
 */
declare const ACCOUNTS_WITHDRAW_COLLATERAL: readonly AccountSpec[];
/**
 * KeeperCrank: 4 accounts
 */
declare const ACCOUNTS_KEEPER_CRANK: readonly AccountSpec[];
/**
 * TradeNoCpi: 4 accounts (PERC-199: clock sysvar removed — uses Clock::get() syscall)
 */
declare const ACCOUNTS_TRADE_NOCPI: readonly AccountSpec[];
/**
 * LiquidateAtOracle: 4 accounts
 * Note: account[0] is unused but must be present
 */
declare const ACCOUNTS_LIQUIDATE_AT_ORACLE: readonly AccountSpec[];
/**
 * CloseAccount: 8 accounts
 */
declare const ACCOUNTS_CLOSE_ACCOUNT: readonly AccountSpec[];
/**
 * TopUpInsurance: 5 accounts
 */
declare const ACCOUNTS_TOPUP_INSURANCE: readonly AccountSpec[];
/**
 * TradeCpi: 7 accounts (PERC-199: clock sysvar removed — uses Clock::get() syscall)
 */
declare const ACCOUNTS_TRADE_CPI: readonly AccountSpec[];
/**
 * SetRiskThreshold: 2 accounts
 */
declare const ACCOUNTS_SET_RISK_THRESHOLD: readonly AccountSpec[];
/**
 * UpdateAdmin: 2 accounts
 */
declare const ACCOUNTS_UPDATE_ADMIN: readonly AccountSpec[];
/**
 * CloseSlab: 2 accounts
 */
declare const ACCOUNTS_CLOSE_SLAB: readonly AccountSpec[];
/**
 * UpdateConfig: 2 accounts
 */
declare const ACCOUNTS_UPDATE_CONFIG: readonly AccountSpec[];
/**
 * SetMaintenanceFee: 2 accounts
 */
declare const ACCOUNTS_SET_MAINTENANCE_FEE: readonly AccountSpec[];
/**
 * SetOracleAuthority: 2 accounts
 * Sets the oracle price authority (admin only)
 */
declare const ACCOUNTS_SET_ORACLE_AUTHORITY: readonly AccountSpec[];
/**
 * PushOraclePrice: 2 accounts
 * Push oracle price (oracle authority only)
 */
declare const ACCOUNTS_PUSH_ORACLE_PRICE: readonly AccountSpec[];
/**
 * ResolveMarket: 2 accounts
 * Resolves a binary/premarket (admin only)
 */
declare const ACCOUNTS_RESOLVE_MARKET: readonly AccountSpec[];
/**
 * WithdrawInsurance: 6 accounts
 * Withdraw insurance fund after market resolution (admin only)
 */
declare const ACCOUNTS_WITHDRAW_INSURANCE: readonly AccountSpec[];
/**
 * PauseMarket: 2 accounts
 */
declare const ACCOUNTS_PAUSE_MARKET: readonly AccountSpec[];
/**
 * UnpauseMarket: 2 accounts
 */
declare const ACCOUNTS_UNPAUSE_MARKET: readonly AccountSpec[];
/**
 * Build AccountMeta array from spec and provided pubkeys.
 * Keys must be provided in the same order as the spec.
 */
declare function buildAccountMetas(spec: readonly AccountSpec[], keys: PublicKey[]): AccountMeta[];
/**
 * CreateInsuranceMint: 9 accounts
 * Creates SPL mint PDA for insurance LP tokens. Admin only, once per market.
 */
declare const ACCOUNTS_CREATE_INSURANCE_MINT: readonly AccountSpec[];
/**
 * DepositInsuranceLP: 8 accounts
 * Deposit collateral into insurance fund, receive LP tokens.
 */
declare const ACCOUNTS_DEPOSIT_INSURANCE_LP: readonly AccountSpec[];
/**
 * WithdrawInsuranceLP: 8 accounts
 * Burn LP tokens and withdraw proportional share of insurance fund.
 */
declare const ACCOUNTS_WITHDRAW_INSURANCE_LP: readonly AccountSpec[];
declare const WELL_KNOWN: {
    readonly tokenProgram: PublicKey;
    readonly clock: PublicKey;
    readonly rent: PublicKey;
    readonly systemProgram: PublicKey;
};

/**
 * Percolator program error definitions.
 * Each error includes a name and actionable guidance.
 */
interface ErrorInfo {
    name: string;
    hint: string;
}
declare const PERCOLATOR_ERRORS: Record<number, ErrorInfo>;
/**
 * Decode a custom program error code to its info.
 */
declare function decodeError(code: number): ErrorInfo | undefined;
/**
 * Get error name from code.
 */
declare function getErrorName(code: number): string;
/**
 * Get actionable hint for error code.
 */
declare function getErrorHint(code: number): string | undefined;
/**
 * Parse error from transaction logs.
 * Looks for "Program ... failed: custom program error: 0x..."
 */
declare function parseErrorFromLogs(logs: string[]): {
    code: number;
    name: string;
    hint?: string;
} | null;

/**
 * Slab header (72 bytes)
 */
interface SlabHeader {
    magic: bigint;
    version: number;
    bump: number;
    flags: number;
    resolved: boolean;
    paused: boolean;
    admin: PublicKey;
    nonce: bigint;
    lastThrUpdateSlot: bigint;
}
/**
 * Market config (starts at offset 72)
 * Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
 *         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)
 */
interface MarketConfig {
    collateralMint: PublicKey;
    vaultPubkey: PublicKey;
    indexFeedId: PublicKey;
    maxStalenessSlots: bigint;
    confFilterBps: number;
    vaultAuthorityBump: number;
    invert: number;
    unitScale: number;
    fundingHorizonSlots: bigint;
    fundingKBps: bigint;
    fundingInvScaleNotionalE6: bigint;
    fundingMaxPremiumBps: bigint;
    fundingMaxBpsPerSlot: bigint;
    threshFloor: bigint;
    threshRiskBps: bigint;
    threshUpdateIntervalSlots: bigint;
    threshStepBps: bigint;
    threshAlphaBps: bigint;
    threshMin: bigint;
    threshMax: bigint;
    threshMinStep: bigint;
    oracleAuthority: PublicKey;
    authorityPriceE6: bigint;
    authorityTimestamp: bigint;
    oraclePriceCapE2bps: bigint;
    lastEffectivePriceE6: bigint;
}
/**
 * Fetch raw slab account data.
 */
declare function fetchSlab(connection: Connection, slabPubkey: PublicKey): Promise<Uint8Array>;
/**
 * Parse slab header (first 64 bytes).
 */
declare function parseHeader(data: Uint8Array): SlabHeader;
/**
 * Parse market config (starts at byte 72).
 * Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
 *         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)
 */
declare function parseConfig(data: Uint8Array): MarketConfig;
/**
 * Read nonce from slab header reserved field.
 */
declare function readNonce(data: Uint8Array): bigint;
/**
 * Read last threshold update slot from slab header reserved field.
 */
declare function readLastThrUpdateSlot(data: Uint8Array): bigint;
declare function detectLayout(dataLen: number): {
    bitmapWords: number;
    accountsOff: number;
    maxAccounts: number;
} | null;
interface InsuranceFund {
    balance: bigint;
    feeRevenue: bigint;
}
interface RiskParams {
    warmupPeriodSlots: bigint;
    maintenanceMarginBps: bigint;
    initialMarginBps: bigint;
    tradingFeeBps: bigint;
    maxAccounts: bigint;
    newAccountFee: bigint;
    riskReductionThreshold: bigint;
    maintenanceFeePerSlot: bigint;
    maxCrankStalenessSlots: bigint;
    liquidationFeeBps: bigint;
    liquidationFeeCap: bigint;
    liquidationBufferBps: bigint;
    minLiquidationAbs: bigint;
}
interface EngineState {
    vault: bigint;
    insuranceFund: InsuranceFund;
    currentSlot: bigint;
    fundingIndexQpbE6: bigint;
    lastFundingSlot: bigint;
    fundingRateBpsPerSlotLast: bigint;
    lastCrankSlot: bigint;
    maxCrankStalenessSlots: bigint;
    totalOpenInterest: bigint;
    cTot: bigint;
    pnlPosTot: bigint;
    liqCursor: number;
    gcCursor: number;
    lastSweepStartSlot: bigint;
    lastSweepCompleteSlot: bigint;
    crankCursor: number;
    sweepStartIdx: number;
    lifetimeLiquidations: bigint;
    lifetimeForceCloses: bigint;
    netLpPos: bigint;
    lpSumAbs: bigint;
    lpMaxAbs: bigint;
    lpMaxAbsSweep: bigint;
    numUsedAccounts: number;
    nextAccountId: bigint;
}
declare enum AccountKind {
    User = 0,
    LP = 1
}
interface Account {
    kind: AccountKind;
    accountId: bigint;
    capital: bigint;
    pnl: bigint;
    reservedPnl: bigint;
    warmupStartedAtSlot: bigint;
    warmupSlopePerStep: bigint;
    positionSize: bigint;
    entryPrice: bigint;
    fundingIndex: bigint;
    matcherProgram: PublicKey;
    matcherContext: PublicKey;
    owner: PublicKey;
    feeCredits: bigint;
    lastFeeSlot: bigint;
}
/**
 * Parse RiskParams from engine data.
 * Note: invert/unitScale are in MarketConfig, not RiskParams.
 */
declare function parseParams(data: Uint8Array): RiskParams;
/**
 * Parse RiskEngine state (excluding accounts array).
 */
declare function parseEngine(data: Uint8Array): EngineState;
/**
 * Read bitmap to get list of used account indices.
 */
declare function parseUsedIndices(data: Uint8Array): number[];
/**
 * Check if a specific account index is used.
 */
declare function isAccountUsed(data: Uint8Array, idx: number): boolean;
/**
 * Calculate the maximum valid account index for a given slab size.
 */
declare function maxAccountIndex(dataLen: number): number;
/**
 * Parse a single account by index.
 */
declare function parseAccount(data: Uint8Array, idx: number): Account;
/**
 * Parse all used accounts.
 * Filters out indices that would be beyond the slab's account storage capacity.
 */
declare function parseAllAccounts(data: Uint8Array): {
    idx: number;
    account: Account;
}[];

/**
 * Derive vault authority PDA.
 * Seeds: ["vault", slab_key]
 */
declare function deriveVaultAuthority(programId: PublicKey, slab: PublicKey): [PublicKey, number];
/**
 * Derive insurance LP mint PDA.
 * Seeds: ["ins_lp", slab_key]
 */
declare function deriveInsuranceLpMint(programId: PublicKey, slab: PublicKey): [PublicKey, number];
/**
 * Derive LP PDA for TradeCpi.
 * Seeds: ["lp", slab_key, lp_idx as u16 LE]
 */
declare function deriveLpPda(programId: PublicKey, slab: PublicKey, lpIdx: number): [PublicKey, number];
/** PumpSwap AMM program ID. */
declare const PUMPSWAP_PROGRAM_ID: PublicKey;
/** Raydium CLMM (Concentrated Liquidity) program ID. */
declare const RAYDIUM_CLMM_PROGRAM_ID: PublicKey;
/** Meteora DLMM (Dynamic Liquidity Market Maker) program ID. */
declare const METEORA_DLMM_PROGRAM_ID: PublicKey;
/** Pyth Push Oracle program on mainnet. */
declare const PYTH_PUSH_ORACLE_PROGRAM_ID: PublicKey;
/**
 * Derive the Pyth Push Oracle PDA for a given feed ID.
 * Seeds: [shard_id(u16 LE, always 0), feed_id(32 bytes)]
 * Program: pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT
 */
declare function derivePythPushOraclePDA(feedIdHex: string): [PublicKey, number];

/**
 * Get the associated token address for an owner and mint.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 */
declare function getAta(owner: PublicKey, mint: PublicKey, tokenProgramId?: PublicKey): Promise<PublicKey>;
/**
 * Synchronous version of getAta.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 */
declare function getAtaSync(owner: PublicKey, mint: PublicKey, tokenProgramId?: PublicKey): PublicKey;
/**
 * Fetch token account info.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 * Throws if account doesn't exist.
 */
declare function fetchTokenAccount(connection: Connection, address: PublicKey, tokenProgramId?: PublicKey): Promise<Account$1>;

/**
 * A discovered Percolator market from on-chain program accounts.
 */
interface DiscoveredMarket {
    slabAddress: PublicKey;
    /** The program that owns this slab account */
    programId: PublicKey;
    header: SlabHeader;
    config: MarketConfig;
    engine: EngineState;
    params: RiskParams;
}
/**
 * Slab tier definitions.
 * IMPORTANT: dataSize must match the compiled program's SLAB_LEN for that MAX_ACCOUNTS.
 * The on-chain program has a hardcoded SLAB_LEN — slab account data.len() must equal it exactly.
 *
 * Layout: HEADER(104) + CONFIG(352) + RiskEngine(variable by tier)
 *   ENGINE_OFF = align_up(104 + 352, 8) = 456  (SBF: u128 align = 8)
 *   RiskEngine = fixed(576) + bitmap(BW*8) + post_bitmap(18) + next_free(N*2) + pad + accounts(N*248)
 *
 * Verified against deployed devnet programs (PERC-131 e2e testing):
 *   Small  (256 slots):  program logs expected = 0xfe40 = 65088
 *   Medium (1024 slots): computed from identical struct layout
 *   Large  (4096 slots): computed from identical struct layout
 */
declare const SLAB_TIERS: {
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65088;
        readonly label: "Small";
        readonly description: "256 slots · ~0.45 SOL";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 257184;
        readonly label: "Medium";
        readonly description: "1,024 slots · ~1.79 SOL";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025568;
        readonly label: "Large";
        readonly description: "4,096 slots · ~7.14 SOL";
    };
};
type SlabTierKey = keyof typeof SLAB_TIERS;
/** Calculate slab data size for arbitrary account count.
 *
 * Layout (SBF, u128 align = 8):
 *   HEADER(104) + CONFIG(352) → ENGINE_OFF = 456
 *   RiskEngine fixed scalars: 576 bytes (vault through lp_max_abs_sweep)
 *   + bitmap: ceil(N/64)*8
 *   + num_used_accounts(u16) + pad(6) + next_account_id(u64) + free_head(u16) = 18
 *   + next_free: N*2
 *   + pad to 8-byte alignment for Account array
 *   + accounts: N*248
 *
 * Must match the on-chain program's SLAB_LEN exactly.
 */
declare function slabDataSize(maxAccounts: number): number;
/**
 * Discover all Percolator markets owned by the given program.
 * Uses getProgramAccounts with dataSize filter + dataSlice to download only ~1400 bytes per slab.
 */
declare function discoverMarkets(connection: Connection, programId: PublicKey): Promise<DiscoveredMarket[]>;

type DexType = "pumpswap" | "raydium-clmm" | "meteora-dlmm";
interface DexPoolInfo {
    dexType: DexType;
    poolAddress: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseVault?: PublicKey;
    quoteVault?: PublicKey;
}
/**
 * Detect DEX type from the program that owns the pool account.
 *
 * @param ownerProgramId - The program ID that owns the pool account
 * @returns The detected DEX type, or `null` if the owner is not a supported DEX program
 *
 * Supported DEX programs:
 * - PumpSwap (constant-product AMM)
 * - Raydium CLMM (concentrated liquidity)
 * - Meteora DLMM (discretized liquidity)
 */
declare function detectDexType(ownerProgramId: PublicKey): DexType | null;
/**
 * Parse a DEX pool account into a {@link DexPoolInfo} struct.
 *
 * @param dexType - The type of DEX (pumpswap, raydium-clmm, or meteora-dlmm)
 * @param poolAddress - The on-chain address of the pool account
 * @param data - Raw account data bytes
 * @returns Parsed pool info including mints and (for PumpSwap) vault addresses
 * @throws Error if data is too short for the given DEX type
 */
declare function parseDexPool(dexType: DexType, poolAddress: PublicKey, data: Uint8Array): DexPoolInfo;
/**
 * Compute the spot price from a DEX pool in e6 format (i.e., 1.0 = 1_000_000).
 *
 * **SECURITY NOTE:** DEX spot prices have no staleness or confidence checks and are
 * vulnerable to flash-loan manipulation within a single transaction. For high-value
 * markets, prefer Pyth or Chainlink oracles.
 *
 * @param dexType - The type of DEX
 * @param data - Raw pool account data
 * @param vaultData - For PumpSwap only: base and quote vault account data
 * @returns Price in e6 format (quote per base token)
 * @throws Error if data is too short or computation fails
 */
declare function computeDexSpotPriceE6(dexType: DexType, data: Uint8Array, vaultData?: {
    base: Uint8Array;
    quote: Uint8Array;
}): bigint;

/**
 * Token2022 (Token Extensions) program ID.
 */
declare const TOKEN_2022_PROGRAM_ID: PublicKey;
/**
 * Detect which token program owns a given mint account.
 * Returns the owner program ID (TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID).
 * Throws if the mint account doesn't exist.
 */
declare function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey>;
/**
 * Check if a given token program ID is Token2022.
 */
declare function isToken2022(tokenProgramId: PublicKey): boolean;
/**
 * Check if a given token program ID is the standard SPL Token program.
 */
declare function isStandardToken(tokenProgramId: PublicKey): boolean;

/**
 * @module stake
 * Percolator Insurance LP Staking program — instruction encoders, PDA derivation, and account specs.
 *
 * Program: percolator-stake (dcccrypto/percolator-stake)
 * Deployed devnet: 4mJ8Cas... (TODO: confirm full address from devops)
 */

/** Percolator Stake program ID (devnet). Update for mainnet. */
declare const STAKE_PROGRAM_ID: PublicKey;
declare const STAKE_IX: {
    readonly InitPool: 0;
    readonly Deposit: 1;
    readonly Withdraw: 2;
    readonly FlushToInsurance: 3;
    readonly UpdateConfig: 4;
    readonly TransferAdmin: 5;
    readonly AdminSetOracleAuthority: 6;
    readonly AdminSetRiskThreshold: 7;
    readonly AdminSetMaintenanceFee: 8;
    readonly AdminResolveMarket: 9;
    readonly AdminWithdrawInsurance: 10;
    readonly AdminSetInsurancePolicy: 11;
};
/** Derive the stake pool PDA for a given slab (market). */
declare function deriveStakePool(slab: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive the vault authority PDA (signs CPI, owns LP mint + vault). */
declare function deriveStakeVaultAuth(pool: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive the per-user deposit PDA (tracks cooldown, deposit time). */
declare function deriveDepositPda(pool: PublicKey, user: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Tag 0: InitPool — create stake pool for a slab. */
declare function encodeStakeInitPool(cooldownSlots: bigint | number, depositCap: bigint | number): Buffer;
/** Tag 1: Deposit — deposit collateral, receive LP tokens. */
declare function encodeStakeDeposit(amount: bigint | number): Buffer;
/** Tag 2: Withdraw — burn LP tokens, receive collateral (subject to cooldown). */
declare function encodeStakeWithdraw(lpAmount: bigint | number): Buffer;
/** Tag 3: FlushToInsurance — move collateral from stake vault to wrapper insurance. */
declare function encodeStakeFlushToInsurance(amount: bigint | number): Buffer;
/** Tag 4: UpdateConfig — update cooldown and/or deposit cap. */
declare function encodeStakeUpdateConfig(newCooldownSlots?: bigint | number, newDepositCap?: bigint | number): Buffer;
/** Tag 5: TransferAdmin — transfer wrapper admin to pool PDA. */
declare function encodeStakeTransferAdmin(): Buffer;
/** Tag 6: AdminSetOracleAuthority — forward to wrapper via CPI. */
declare function encodeStakeAdminSetOracleAuthority(newAuthority: PublicKey): Buffer;
/** Tag 7: AdminSetRiskThreshold — forward to wrapper via CPI. */
declare function encodeStakeAdminSetRiskThreshold(newThreshold: bigint | number): Buffer;
/** Tag 8: AdminSetMaintenanceFee — forward to wrapper via CPI. */
declare function encodeStakeAdminSetMaintenanceFee(newFee: bigint | number): Buffer;
/** Tag 9: AdminResolveMarket — forward to wrapper via CPI. */
declare function encodeStakeAdminResolveMarket(): Buffer;
/** Tag 10: AdminWithdrawInsurance — withdraw insurance after market resolution. */
declare function encodeStakeAdminWithdrawInsurance(amount: bigint | number): Buffer;
/** Tag 11: AdminSetInsurancePolicy — set withdrawal policy on wrapper. */
declare function encodeStakeAdminSetInsurancePolicy(authority: PublicKey, minWithdrawBase: bigint | number, maxWithdrawBps: number, cooldownSlots: bigint | number): Buffer;
interface StakeAccounts {
    /** InitPool accounts */
    initPool: {
        admin: PublicKey;
        slab: PublicKey;
        pool: PublicKey;
        lpMint: PublicKey;
        vault: PublicKey;
        vaultAuth: PublicKey;
        collateralMint: PublicKey;
        percolatorProgram: PublicKey;
    };
    /** Deposit accounts */
    deposit: {
        user: PublicKey;
        pool: PublicKey;
        userCollateralAta: PublicKey;
        vault: PublicKey;
        lpMint: PublicKey;
        userLpAta: PublicKey;
        vaultAuth: PublicKey;
        depositPda: PublicKey;
    };
    /** Withdraw accounts */
    withdraw: {
        user: PublicKey;
        pool: PublicKey;
        userLpAta: PublicKey;
        lpMint: PublicKey;
        vault: PublicKey;
        userCollateralAta: PublicKey;
        vaultAuth: PublicKey;
        depositPda: PublicKey;
    };
    /** FlushToInsurance accounts (CPI from stake → percolator) */
    flushToInsurance: {
        caller: PublicKey;
        pool: PublicKey;
        vault: PublicKey;
        vaultAuth: PublicKey;
        slab: PublicKey;
        wrapperVault: PublicKey;
        percolatorProgram: PublicKey;
    };
}
/**
 * Build account keys for InitPool instruction.
 * Returns array of {pubkey, isSigner, isWritable} in the order the program expects.
 */
declare function initPoolAccounts(a: StakeAccounts['initPool']): {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
}[];
/**
 * Build account keys for Deposit instruction.
 */
declare function depositAccounts(a: StakeAccounts['deposit']): {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
}[];
/**
 * Build account keys for Withdraw instruction.
 */
declare function withdrawAccounts(a: StakeAccounts['withdraw']): {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
}[];
/**
 * Build account keys for FlushToInsurance instruction.
 */
declare function flushToInsuranceAccounts(a: StakeAccounts['flushToInsurance']): {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
}[];

interface BuildIxParams {
    programId: PublicKey;
    keys: AccountMeta[];
    data: Uint8Array | Buffer;
}
/**
 * Build a transaction instruction.
 */
declare function buildIx(params: BuildIxParams): TransactionInstruction;
interface TxResult {
    signature: string;
    slot: number;
    err: string | null;
    hint?: string;
    logs: string[];
    unitsConsumed?: number;
}
interface SimulateOrSendParams {
    connection: Connection;
    ix: TransactionInstruction;
    signers: Keypair[];
    simulate: boolean;
    commitment?: Commitment;
    computeUnitLimit?: number;
}
/**
 * Simulate or send a transaction.
 * Returns consistent output for both modes.
 */
declare function simulateOrSend(params: SimulateOrSendParams): Promise<TxResult>;
/**
 * Format transaction result for output.
 */
declare function formatResult(result: TxResult, jsonMode: boolean): string;

/**
 * Coin-margined perpetual trade math utilities.
 *
 * On-chain PnL formula:
 *   mark_pnl = (oracle - entry) * abs_pos / oracle   (longs)
 *   mark_pnl = (entry - oracle) * abs_pos / oracle   (shorts)
 *
 * All prices are in e6 format (1 USD = 1_000_000).
 * All token amounts are in native units (e.g. lamports).
 */
/**
 * Compute mark-to-market PnL for an open position.
 */
declare function computeMarkPnl(positionSize: bigint, entryPrice: bigint, oraclePrice: bigint): bigint;
/**
 * Compute liquidation price given entry, capital, position and maintenance margin.
 * Uses pure BigInt arithmetic for precision (no Number() truncation).
 */
declare function computeLiqPrice(entryPrice: bigint, capital: bigint, positionSize: bigint, maintenanceMarginBps: bigint): bigint;
/**
 * Compute estimated liquidation price BEFORE opening a trade.
 * Accounts for trading fees reducing effective capital.
 */
declare function computePreTradeLiqPrice(oracleE6: bigint, margin: bigint, posSize: bigint, maintBps: bigint, feeBps: bigint, direction: "long" | "short"): bigint;
/**
 * Compute trading fee from notional value and fee rate in bps.
 */
declare function computeTradingFee(notional: bigint, tradingFeeBps: bigint): bigint;
/**
 * Compute PnL as a percentage of capital.
 *
 * Uses BigInt scaling to avoid precision loss from Number(bigint) conversion.
 * Number(bigint) silently truncates values above 2^53, which can produce
 * incorrect percentages for large positions (e.g., tokens with 9 decimals
 * where capital > ~9M tokens in native units exceeds MAX_SAFE_INTEGER).
 */
declare function computePnlPercent(pnlTokens: bigint, capital: bigint): number;
/**
 * Estimate entry price including fee impact (slippage approximation).
 */
declare function computeEstimatedEntryPrice(oracleE6: bigint, tradingFeeBps: bigint, direction: "long" | "short"): bigint;
/**
 * Convert per-slot funding rate (bps) to annualized percentage.
 */
declare function computeFundingRateAnnualized(fundingRateBpsPerSlot: bigint): number;
/**
 * Compute margin required for a given notional and initial margin bps.
 */
declare function computeRequiredMargin(notional: bigint, initialMarginBps: bigint): bigint;
/**
 * Compute maximum leverage from initial margin bps.
 */
declare function computeMaxLeverage(initialMarginBps: bigint): number;
/**
 * Compute unlocked capital during the warmup period.
 *
 * Capital is released linearly over `warmupPeriodSlots` slots starting from
 * `warmupStartedAtSlot`. Before warmup starts (startSlot === 0) or if the
 * warmup period is 0, all capital is considered unlocked.
 *
 * @param totalCapital    - Total deposited capital (native units).
 * @param currentSlot     - The current on-chain slot.
 * @param warmupStartSlot - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots - Total slots in the warmup period.
 * @returns The amount of capital currently unlocked.
 */
declare function computeWarmupUnlockedCapital(totalCapital: bigint, currentSlot: bigint, warmupStartSlot: bigint, warmupPeriodSlots: bigint): bigint;
/**
 * Compute the effective maximum leverage during the warmup period.
 *
 * During warmup, only unlocked capital can be used as margin. The effective
 * leverage relative to *total* capital is therefore capped at:
 *
 *   effectiveMaxLeverage = maxLeverage × (unlockedCapital / totalCapital)
 *
 * This returns a floored integer value (leverage is always a whole number
 * in the UI), with a minimum of 1x if any capital is unlocked.
 *
 * @param initialMarginBps   - Initial margin requirement in basis points.
 * @param totalCapital       - Total deposited capital (native units).
 * @param currentSlot        - The current on-chain slot.
 * @param warmupStartSlot    - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots  - Total slots in the warmup period.
 * @returns The effective maximum leverage (integer, ≥ 1).
 */
declare function computeWarmupLeverageCap(initialMarginBps: bigint, totalCapital: bigint, currentSlot: bigint, warmupStartSlot: bigint, warmupPeriodSlots: bigint): number;
/**
 * Compute the maximum position size allowed during warmup.
 *
 * This is the unlocked capital multiplied by the base max leverage.
 * Unlike `computeWarmupLeverageCap` (which gives effective leverage
 * relative to total capital), this gives the absolute notional cap.
 *
 * @param initialMarginBps   - Initial margin requirement in basis points.
 * @param totalCapital       - Total deposited capital (native units).
 * @param currentSlot        - The current on-chain slot.
 * @param warmupStartSlot    - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots  - Total slots in the warmup period.
 * @returns Maximum position size in native units.
 */
declare function computeWarmupMaxPositionSize(initialMarginBps: bigint, totalCapital: bigint, currentSlot: bigint, warmupStartSlot: bigint, warmupPeriodSlots: bigint): bigint;

/**
 * Input validation utilities for CLI commands.
 * Provides descriptive error messages for invalid input.
 */

declare class ValidationError extends Error {
    readonly field: string;
    constructor(field: string, message: string);
}
/**
 * Validate a public key string.
 */
declare function validatePublicKey(value: string, field: string): PublicKey;
/**
 * Validate a non-negative integer index (u16 range for accounts).
 */
declare function validateIndex(value: string, field: string): number;
/**
 * Validate a non-negative amount (u64 range).
 */
declare function validateAmount(value: string, field: string): bigint;
/**
 * Validate a u128 value.
 */
declare function validateU128(value: string, field: string): bigint;
/**
 * Validate an i64 value.
 */
declare function validateI64(value: string, field: string): bigint;
/**
 * Validate an i128 value (trade sizes).
 */
declare function validateI128(value: string, field: string): bigint;
/**
 * Validate a basis points value (0-10000).
 */
declare function validateBps(value: string, field: string): number;
/**
 * Validate a u64 value.
 */
declare function validateU64(value: string, field: string): bigint;
/**
 * Validate a u16 value.
 */
declare function validateU16(value: string, field: string): number;

/**
 * Smart Price Router — automatic oracle selection for any token.
 *
 * Given a token mint, discovers all available price sources (DexScreener, Pyth, Jupiter),
 * ranks them by liquidity/reliability, and returns the best oracle config.
 */
type PriceSourceType = "pyth" | "dex" | "jupiter";
interface PriceSource {
    type: PriceSourceType;
    /** Pool address (dex), Pyth feed ID (pyth), or mint (jupiter) */
    address: string;
    /** DEX id for dex sources */
    dexId?: string;
    /** Pair label e.g. "SOL / USDC" */
    pairLabel?: string;
    /** USD liquidity depth — higher is better */
    liquidity: number;
    /** Latest spot price in USD */
    price: number;
    /** Confidence score 0-100 (composite of liquidity, staleness, reliability) */
    confidence: number;
}
interface PriceRouterResult {
    mint: string;
    bestSource: PriceSource | null;
    allSources: PriceSource[];
    /** ISO timestamp of resolution */
    resolvedAt: string;
}
declare const PYTH_SOLANA_FEEDS: Record<string, {
    symbol: string;
    mint: string;
}>;
declare function resolvePrice(mint: string, signal?: AbortSignal): Promise<PriceRouterResult>;

/**
 * Centralized PROGRAM_ID configuration
 *
 * Default to environment variable, then fall back to network-specific defaults.
 * This prevents hard-coded program IDs scattered across the codebase.
 */
declare const PROGRAM_IDS: {
    readonly devnet: {
        readonly percolator: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD";
        readonly matcher: "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k";
    };
    readonly mainnet: {
        readonly percolator: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24";
        readonly matcher: "";
    };
};
type Network = "devnet" | "mainnet";
/**
 * Get the Percolator program ID for the current network
 *
 * Priority:
 * 1. PROGRAM_ID env var (explicit override)
 * 2. Network-specific default (NETWORK env var)
 * 3. Devnet default (safest fallback)
 */
declare function getProgramId(network?: Network): PublicKey;
/**
 * Get the Matcher program ID for the current network
 */
declare function getMatcherProgramId(network?: Network): PublicKey;
/**
 * Get the current network from environment
 * Defaults to devnet for safety
 */
declare function getCurrentNetwork(): Network;

export { ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_CLOSE_SLAB, ACCOUNTS_CREATE_INSURANCE_MINT, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_DEPOSIT_INSURANCE_LP, ACCOUNTS_INIT_LP, ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_USER, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_LIQUIDATE_AT_ORACLE, ACCOUNTS_PAUSE_MARKET, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_SET_MAINTENANCE_FEE, ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_SET_RISK_THRESHOLD, ACCOUNTS_TOPUP_INSURANCE, ACCOUNTS_TRADE_CPI, ACCOUNTS_TRADE_NOCPI, ACCOUNTS_UNPAUSE_MARKET, ACCOUNTS_UPDATE_ADMIN, ACCOUNTS_UPDATE_CONFIG, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_WITHDRAW_INSURANCE, ACCOUNTS_WITHDRAW_INSURANCE_LP, type Account, AccountKind, type AccountSpec, type AdminForceCloseArgs, type BuildIxParams, CTX_VAMM_OFFSET, type CloseAccountArgs, type DepositCollateralArgs, type DepositInsuranceLPArgs, type DexPoolInfo, type DexType, type DiscoveredMarket, type EngineState, IX_TAG, type InitLPArgs, type InitMarketArgs, type InitUserArgs, type InsuranceFund, type KeeperCrankArgs, type LiquidateAtOracleArgs, MARK_PRICE_EMA_ALPHA_E6, MARK_PRICE_EMA_WINDOW_SLOTS, METEORA_DLMM_PROGRAM_ID, type MarketConfig, type Network, PERCOLATOR_ERRORS, PROGRAM_IDS, PUMPSWAP_PROGRAM_ID, PYTH_PUSH_ORACLE_PROGRAM_ID, PYTH_RECEIVER_PROGRAM_ID, PYTH_SOLANA_FEEDS, type PriceRouterResult, type PriceSource, type PriceSourceType, type PushOraclePriceArgs, RAYDIUM_CLMM_PROGRAM_ID, type RiskParams, SLAB_TIERS, STAKE_IX, STAKE_PROGRAM_ID, type SetMaintenanceFeeArgs, type SetOracleAuthorityArgs, type SetOraclePriceCapArgs, type SetPythOracleArgs, type SetRiskThresholdArgs, type SimulateOrSendParams, type SlabHeader, type SlabTierKey, type StakeAccounts, TOKEN_2022_PROGRAM_ID, type TopUpInsuranceArgs, type TradeCpiArgs, type TradeCpiV2Args, type TradeNoCpiArgs, type TxResult, type UpdateAdminArgs, type UpdateConfigArgs, type UpdateRiskParamsArgs, VAMM_MAGIC, ValidationError, type VammMatcherParams, WELL_KNOWN, type WithdrawCollateralArgs, type WithdrawInsuranceLPArgs, buildAccountMetas, buildIx, computeDexSpotPriceE6, computeEmaMarkPrice, computeEstimatedEntryPrice, computeFundingRateAnnualized, computeLiqPrice, computeMarkPnl, computeMaxLeverage, computePnlPercent, computePreTradeLiqPrice, computeRequiredMargin, computeTradingFee, computeVammQuote, computeWarmupLeverageCap, computeWarmupMaxPositionSize, computeWarmupUnlockedCapital, concatBytes, decodeError, depositAccounts, deriveDepositPda, deriveInsuranceLpMint, deriveLpPda, derivePythPriceUpdateAccount, derivePythPushOraclePDA, deriveStakePool, deriveStakeVaultAuth, deriveVaultAuthority, detectDexType, detectLayout, detectTokenProgram, discoverMarkets, encBool, encI128, encI64, encPubkey, encU128, encU16, encU32, encU64, encU8, encodeAdminForceClose, encodeCloseAccount, encodeCloseSlab, encodeCreateInsuranceMint, encodeDepositCollateral, encodeDepositInsuranceLP, encodeInitLP, encodeInitMarket, encodeInitUser, encodeKeeperCrank, encodeLiquidateAtOracle, encodePauseMarket, encodePushOraclePrice, encodeRenounceAdmin, encodeResolveMarket, encodeSetMaintenanceFee, encodeSetOracleAuthority, encodeSetOraclePriceCap, encodeSetPythOracle, encodeSetRiskThreshold, encodeStakeAdminResolveMarket, encodeStakeAdminSetInsurancePolicy, encodeStakeAdminSetMaintenanceFee, encodeStakeAdminSetOracleAuthority, encodeStakeAdminSetRiskThreshold, encodeStakeAdminWithdrawInsurance, encodeStakeDeposit, encodeStakeFlushToInsurance, encodeStakeInitPool, encodeStakeTransferAdmin, encodeStakeUpdateConfig, encodeStakeWithdraw, encodeTopUpInsurance, encodeTradeCpi, encodeTradeCpiV2, encodeTradeNoCpi, encodeUnpauseMarket, encodeUpdateAdmin, encodeUpdateConfig, encodeUpdateHyperpMark, encodeUpdateMarkPrice, encodeUpdateRiskParams, encodeWithdrawCollateral, encodeWithdrawInsurance, encodeWithdrawInsuranceLP, fetchSlab, fetchTokenAccount, flushToInsuranceAccounts, formatResult, getAta, getAtaSync, getCurrentNetwork, getErrorHint, getErrorName, getMatcherProgramId, getProgramId, initPoolAccounts, isAccountUsed, isStandardToken, isToken2022, maxAccountIndex, parseAccount, parseAllAccounts, parseConfig, parseDexPool, parseEngine, parseErrorFromLogs, parseHeader, parseParams, parseUsedIndices, readLastThrUpdateSlot, readNonce, resolvePrice, simulateOrSend, slabDataSize, validateAmount, validateBps, validateI128, validateI64, validateIndex, validatePublicKey, validateU128, validateU16, validateU64, withdrawAccounts };
