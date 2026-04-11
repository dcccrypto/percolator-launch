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
 * Oracle price constraints.
 * Maximum oracle price that can be pushed to the on-chain oracle authority.
 */
declare const MAX_ORACLE_PRICE = 1000000000000n;
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
    readonly SetInsuranceWithdrawPolicy: 22;
    /** @deprecated Use SetInsuranceWithdrawPolicy */ readonly UpdateRiskParams: 22;
    readonly WithdrawInsuranceLimited: 23;
    /** @deprecated Use WithdrawInsuranceLimited */ readonly RenounceAdmin: 23;
    readonly QueryLpFees: 24;
    readonly ReclaimEmptyAccount: 25;
    readonly SettleAccount: 26;
    readonly DepositFeeCredits: 27;
    readonly ConvertReleasedPnl: 28;
    readonly ResolvePermissionless: 29;
    /** @deprecated Use ResolvePermissionless */ readonly AcceptAdmin: 29;
    readonly ForceCloseResolved: 30;
    readonly SetPythOracle: 32;
    readonly UpdateMarkPrice: 33;
    readonly UpdateHyperpMark: 34;
    readonly TradeCpiV2: 35;
    readonly UnresolveMarket: 36;
    readonly CreateLpVault: 37;
    readonly LpVaultDeposit: 38;
    readonly LpVaultWithdraw: 39;
    readonly LpVaultCrankFees: 40;
    /** PERC-306: Fund per-market isolated insurance balance */
    readonly FundMarketInsurance: 41;
    /** PERC-306: Set insurance isolation BPS for a market */
    readonly SetInsuranceIsolation: 42;
    /** PERC-314: Challenge settlement price during dispute window */
    readonly ChallengeSettlement: 43;
    /** PERC-314: Resolve dispute (admin adjudication) */
    readonly ResolveDispute: 44;
    /** PERC-315: Deposit LP vault tokens as perp collateral */
    readonly DepositLpCollateral: 45;
    /** PERC-315: Withdraw LP collateral (position must be closed) */
    readonly WithdrawLpCollateral: 46;
    /** PERC-309: Queue a large LP withdrawal (user; creates withdraw_queue PDA). */
    readonly QueueWithdrawal: 47;
    /** PERC-309: Claim one epoch tranche from a queued LP withdrawal (user). */
    readonly ClaimQueuedWithdrawal: 48;
    /** PERC-309: Cancel a queued withdrawal, refund remaining LP tokens (user). */
    readonly CancelQueuedWithdrawal: 49;
    /** PERC-305: Auto-deleverage — surgically close profitable positions when PnL cap is exceeded (permissionless). */
    readonly ExecuteAdl: 50;
    /** Close a stale slab of an invalid/old layout and recover rent SOL (admin only). */
    readonly CloseStaleSlabs: 51;
    /** Reclaim rent from an uninitialised slab whose market creation failed mid-flow. Slab must sign. */
    readonly ReclaimSlabRent: 52;
    /** Permissionless on-chain audit crank: verifies conservation invariants and pauses market on violation. */
    readonly AuditCrank: 53;
    /** Cross-Market Portfolio Margining: SetOffsetPair */
    readonly SetOffsetPair: 54;
    /** Cross-Market Portfolio Margining: AttestCrossMargin */
    readonly AttestCrossMargin: 55;
    /** PERC-622: Advance oracle phase (permissionless crank) */
    readonly AdvanceOraclePhase: 56;
    /** PERC-623: Top up a market's keeper fund (permissionless) */
    readonly TopUpKeeperFund: 57;
    /** PERC-629: Slash a market creator's deposit (permissionless) */
    readonly SlashCreationDeposit: 58;
    /** PERC-628: Initialize the global shared vault (admin) */
    readonly InitSharedVault: 59;
    /** PERC-628: Allocate virtual liquidity to a market (admin) */
    readonly AllocateMarket: 60;
    /** PERC-628: Queue a withdrawal for the current epoch */
    readonly QueueWithdrawalSV: 61;
    /** PERC-628: Claim a queued withdrawal after epoch elapses */
    readonly ClaimEpochWithdrawal: 62;
    /** PERC-628: Advance the shared vault epoch (permissionless crank) */
    readonly AdvanceEpoch: 63;
    /** PERC-608: Mint a Position NFT for a user's open position. */
    readonly MintPositionNft: 64;
    /** PERC-608: Transfer position ownership via the NFT (keeper-gated). */
    readonly TransferPositionOwnership: 65;
    /** PERC-608: Burn the Position NFT when a position is closed. */
    readonly BurnPositionNft: 66;
    /** PERC-608: Keeper sets pending_settlement flag before a funding transfer. */
    readonly SetPendingSettlement: 67;
    /** PERC-608: Keeper clears pending_settlement flag after KeeperCrank. */
    readonly ClearPendingSettlement: 68;
    /** PERC-608: Internal CPI call from percolator-nft TransferHook to update on-chain owner. */
    readonly TransferOwnershipCpi: 69;
    /** PERC-8111: Set per-wallet position cap (admin only, cap_e6=0 disables). */
    readonly SetWalletCap: 70;
    /** PERC-8110: Set OI imbalance hard-block threshold (admin only). */
    readonly SetOiImbalanceHardBlock: 71;
    /** PERC-8270: Rescue orphan vault — recover tokens from a closed market's vault (admin). */
    readonly RescueOrphanVault: 72;
    /** PERC-8270: Close orphan slab — reclaim rent from a slab whose market closed unexpectedly (admin). */
    readonly CloseOrphanSlab: 73;
    /** PERC-SetDexPool: Pin admin-approved DEX pool address for a HYPERP market (admin). */
    readonly SetDexPool: 74;
    /** CPI to the matcher program to initialize a matcher context account for an LP slot. Admin-only. */
    readonly InitMatcherCtx: 75;
    /** PauseMarket (tag 76): admin emergency pause. Blocks Trade/Deposit/Withdraw/InitUser. */
    readonly PauseMarket: 76;
    /** UnpauseMarket (tag 77): admin unpause. Re-enables all operations. */
    readonly UnpauseMarket: 77;
    /** CloseKeeperFund (tag 78): close keeper fund PDA and recover lamports to admin. */
    readonly CloseKeeperFund: 78;
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
    maxMaintenanceFeePerSlot?: bigint | string;
    maxInsuranceFloor?: bigint | string;
    minOraclePriceCap?: bigint | string;
    warmupPeriodSlots: bigint | string;
    maintenanceMarginBps: bigint | string;
    initialMarginBps: bigint | string;
    tradingFeeBps: bigint | string;
    maxAccounts: bigint | string;
    newAccountFee: bigint | string;
    insuranceFloor?: bigint | string;
    maintenanceFeePerSlot: bigint | string;
    maxCrankStalenessSlots: bigint | string;
    liquidationFeeBps: bigint | string;
    liquidationFeeCap: bigint | string;
    liquidationBufferBps?: bigint | string;
    minLiquidationAbs: bigint | string;
    minInitialDeposit: bigint | string;
    minNonzeroMmReq: bigint | string;
    minNonzeroImReq: bigint | string;
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
/**
 * Encode PushOraclePrice instruction data with validation.
 *
 * Validates oracle price constraints:
 * - Price cannot be zero (division by zero in on-chain engine)
 * - Price cannot exceed MAX_ORACLE_PRICE (prevents overflow in price math)
 *
 * @param args - PushOraclePrice arguments
 * @returns Encoded instruction data (17 bytes)
 * @throws Error if price is 0 or exceeds MAX_ORACLE_PRICE
 */
declare function encodePushOraclePrice(args: PushOraclePriceArgs): Uint8Array;
/**
 * SetOraclePriceCap instruction data (9 bytes)
 * Set oracle price circuit breaker cap (admin only).
 *
 * max_change_e2bps: maximum oracle price movement per slot in 0.01 bps units.
 *   1_000_000 = 100% max move per slot.
 *
 * ⚠️ PERC-8191 (PR#150): cap=0 is NO LONGER accepted for admin-oracle markets.
 *   - Hyperp markets: rejected if cap < DEFAULT_HYPERP_PRICE_CAP_E2BPS (1000).
 *   - Admin-oracle markets: rejected if cap == 0 (circuit breaker bypass prevention).
 *   - Pyth-pinned markets: immune (oracle_authority zeroed), any value accepted.
 *
 * Use a non-zero cap for all admin-oracle and Hyperp markets.
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
 * On-chain confirmation code for RenounceAdmin (must match program constant).
 * ASCII "RENOUNCE" as u64 LE = 0x52454E4F554E4345.
 */
declare const RENOUNCE_ADMIN_CONFIRMATION = 5928230587143701317n;
/**
 * On-chain confirmation code for UnresolveMarket (must match program constant).
 */
declare const UNRESOLVE_CONFIRMATION = 16045690984503054900n;
/**
 * RenounceAdmin instruction data (9 bytes)
 * Irreversibly set admin to all zeros. After this, all admin-only instructions fail.
 *
 * Requires the confirmation code 0x52454E4F554E4345 ("RENOUNCE" as u64 LE)
 * to prevent accidental invocation.
 */
declare function encodeRenounceAdmin(): Uint8Array;
/**
 * LpVaultWithdraw (Tag 39, PERC-627 / GH#1926 / PERC-8287) — burn LP vault tokens and
 * withdraw proportional collateral.
 *
 * **BREAKING (PR#170):** accounts[9] = creatorLockPda is now REQUIRED.
 * Always include `deriveCreatorLockPda(programId, slab)` at position 9.
 * Non-creator withdrawers pass the derived PDA; if no lock exists on-chain
 * the check is a no-op. Omitting this account causes `ExpectLenFailed` on-chain.
 *
 * Instruction data: tag(1) + lp_amount(8) = 9 bytes
 *
 * Accounts (use ACCOUNTS_LP_VAULT_WITHDRAW):
 *  [0] withdrawer        signer
 *  [1] slab              writable
 *  [2] withdrawerAta     writable
 *  [3] vault             writable
 *  [4] tokenProgram
 *  [5] lpVaultMint       writable
 *  [6] withdrawerLpAta   writable
 *  [7] vaultAuthority
 *  [8] lpVaultState      writable
 *  [9] creatorLockPda    writable  ← derive with deriveCreatorLockPda(programId, slab)
 *
 * @param lpAmount - Amount of LP vault tokens to burn.
 *
 * @example
 * ```ts
 * import { encodeLpVaultWithdraw, ACCOUNTS_LP_VAULT_WITHDRAW, buildAccountMetas } from "@percolator/sdk";
 * import { deriveCreatorLockPda, deriveVaultAuthority } from "@percolator/sdk";
 *
 * const [creatorLockPda] = deriveCreatorLockPda(PROGRAM_ID, slabKey);
 * const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, slabKey);
 *
 * const data = encodeLpVaultWithdraw({ lpAmount: 1_000_000_000n });
 * const keys = buildAccountMetas(ACCOUNTS_LP_VAULT_WITHDRAW, {
 *   withdrawer, slab: slabKey, withdrawerAta, vault, tokenProgram: TOKEN_PROGRAM_ID,
 *   lpVaultMint, withdrawerLpAta, vaultAuthority, lpVaultState, creatorLockPda,
 * });
 * ```
 */
interface LpVaultWithdrawArgs {
    /** Amount of LP vault tokens to burn. */
    lpAmount: bigint | string;
}
declare function encodeLpVaultWithdraw(args: LpVaultWithdrawArgs): Uint8Array;
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
 * Fund per-market isolated insurance balance.
 * Accounts: [admin(signer,writable), slab(writable), admin_ata(writable), vault(writable), token_program]
 */
declare function encodeFundMarketInsurance(args: {
    amount: bigint;
}): Uint8Array;
/**
 * Set insurance isolation BPS for a market.
 * Accounts: [admin(signer), slab(writable)]
 */
declare function encodeSetInsuranceIsolation(args: {
    bps: number;
}): Uint8Array;
/**
 * QueueWithdrawal (Tag 47, PERC-309) — queue a large LP withdrawal.
 *
 * Creates a withdraw_queue PDA. The LP tokens are claimed in epoch tranches
 * via ClaimQueuedWithdrawal. Call CancelQueuedWithdrawal to abort.
 *
 * Accounts: [user(signer,writable), slab(writable), lpVaultState, withdrawQueue(writable), systemProgram]
 *
 * @param lpAmount - Amount of LP tokens to queue for withdrawal.
 *
 * @example
 * ```ts
 * const data = encodeQueueWithdrawal({ lpAmount: 1_000_000_000n });
 * ```
 */
declare function encodeQueueWithdrawal(args: {
    lpAmount: bigint | string;
}): Uint8Array;
/**
 * ClaimQueuedWithdrawal (Tag 48, PERC-309) — claim one epoch tranche from a queued withdrawal.
 *
 * Burns LP tokens and releases one tranche of SOL to the user.
 * Call once per epoch until epochs_remaining == 0.
 *
 * Accounts: [user(signer,writable), slab(writable), withdrawQueue(writable),
 *            lpVaultMint(writable), userLpAta(writable), vault(writable),
 *            userAta(writable), vaultAuthority, tokenProgram, lpVaultState(writable)]
 */
declare function encodeClaimQueuedWithdrawal(): Uint8Array;
/**
 * CancelQueuedWithdrawal (Tag 49, PERC-309) — cancel a queued withdrawal, refund remaining LP.
 *
 * Closes the withdraw_queue PDA and returns its rent lamports to the user.
 * The queued LP amount that was not yet claimed is NOT refunded — it is burned.
 * Use only to abandon a partial withdrawal.
 *
 * Accounts: [user(signer,writable), slab, withdrawQueue(writable)]
 */
declare function encodeCancelQueuedWithdrawal(): Uint8Array;
/**
 * ExecuteAdl (Tag 50, PERC-305) — auto-deleverage the most profitable position.
 *
 * Permissionless. Surgically closes or reduces `targetIdx` position when
 * `pnl_pos_tot > max_pnl_cap` on the market. The caller receives no reward —
 * the incentive is unblocking the market for normal trading.
 *
 * Requires `UpdateRiskParams.max_pnl_cap > 0` on the market.
 *
 * Accounts: [caller(signer), slab(writable), clock, oracle, ...backupOracles?]
 *
 * @param targetIdx - Account index of the position to deleverage.
 *
 * @example
 * ```ts
 * const data = encodeExecuteAdl({ targetIdx: 5 });
 * ```
 */
interface ExecuteAdlArgs {
    targetIdx: number;
}
declare function encodeExecuteAdl(args: ExecuteAdlArgs): Uint8Array;
/**
 * CloseStaleSlabs (Tag 51) — close a slab of an invalid/old layout and recover rent SOL.
 *
 * Admin only. Skips slab_guard; validates header magic + admin authority instead.
 * Use for slabs created by old program layouts (e.g. pre-PERC-120 devnet deploys)
 * whose size does not match any current valid tier.
 *
 * Accounts: [dest(signer,writable), slab(writable)]
 */
declare function encodeCloseStaleSlabs(): Uint8Array;
/**
 * ReclaimSlabRent (Tag 52) — reclaim rent from an uninitialised slab.
 *
 * For use when market creation failed mid-flow (slab funded but InitMarket not called).
 * The slab account must sign (proves the caller holds the slab keypair).
 * Cannot close an initialised slab (magic == PERCOLAT) — use CloseSlab (tag 13).
 *
 * Accounts: [dest(signer,writable), slab(signer,writable)]
 */
declare function encodeReclaimSlabRent(): Uint8Array;
/**
 * AuditCrank (Tag 53) — verify conservation invariants on-chain (permissionless).
 *
 * Walks all accounts and verifies: capital sum, pnl_pos_tot, total_oi, LP consistency,
 * and solvency. Sets FLAG_PAUSED on violation (with a 150-slot cooldown guard to
 * prevent DoS from transient failures).
 *
 * Accounts: [slab(writable)]
 *
 * @example
 * ```ts
 * const data = encodeAuditCrank();
 * ```
 */
declare function encodeAuditCrank(): Uint8Array;
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
 * AdvanceOraclePhase (Tag 56) — permissionless oracle phase advancement.
 *
 * Checks if a market should transition from Phase 0→1→2 based on
 * time elapsed and cumulative volume. Anyone can call this.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [writable] Slab
 */
declare function encodeAdvanceOraclePhase(): Uint8Array;
/** Oracle phase constants matching on-chain values */
declare const ORACLE_PHASE_NASCENT = 0;
declare const ORACLE_PHASE_GROWING = 1;
declare const ORACLE_PHASE_MATURE = 2;
/** Phase transition thresholds (must match program constants) */
declare const PHASE1_MIN_SLOTS = 648000n;
declare const PHASE1_VOLUME_MIN_SLOTS = 36000n;
declare const PHASE2_VOLUME_THRESHOLD = 100000000000n;
declare const PHASE2_MATURITY_SLOTS = 3024000n;
/**
 * Check if an oracle phase transition is due (TypeScript mirror of on-chain logic).
 *
 * @returns [newPhase, shouldTransition]
 */
declare function checkPhaseTransition(currentSlot: bigint, marketCreatedSlot: bigint, oraclePhase: number, cumulativeVolumeE6: bigint, phase2DeltaSlots: number, hasMatureOracle: boolean): [number, boolean];
/**
 * TopUpKeeperFund (Tag 57) — permissionless keeper fund top-up.
 *
 * Instruction data: tag(1) + amount(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer, writable] Funder
 *   1. [writable]         Slab
 *   2. [writable]         Keeper fund PDA
 *   3. []                 System program
 */
interface TopUpKeeperFundArgs {
    amount: bigint | string;
}
declare function encodeTopUpKeeperFund(args: TopUpKeeperFundArgs): Uint8Array;
/**
 * SlashCreationDeposit (Tag 58) — permissionless: slash a market creator's deposit
 * after the spam grace period has elapsed (PERC-629).
 *
 * **WARNING**: Tag 58 is reserved in tags.rs but has NO instruction decoder or
 * handler in the on-chain program. Sending this instruction will fail with
 * `InvalidInstructionData`. Do not use until the on-chain handler is deployed.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           Caller (anyone)
 *   1. []                 Slab
 *   2. [writable]         Creator history PDA
 *   3. [writable]         Insurance vault
 *   4. [writable]         Treasury
 *   5. []                 System program
 *
 * @deprecated Not yet implemented on-chain — will fail with InvalidInstructionData.
 */
declare function encodeSlashCreationDeposit(): Uint8Array;
/**
 * InitSharedVault (Tag 59) — admin: create the global shared vault PDA (PERC-628).
 *
 * Instruction data: tag(1) + epochDurationSlots(8) + maxMarketExposureBps(2) = 11 bytes
 *
 * Accounts:
 *   0. [signer]           Admin
 *   1. [writable]         Shared vault PDA
 *   2. []                 System program
 */
interface InitSharedVaultArgs {
    epochDurationSlots: bigint | string;
    maxMarketExposureBps: number;
}
declare function encodeInitSharedVault(args: InitSharedVaultArgs): Uint8Array;
/**
 * AllocateMarket (Tag 60) — admin: allocate virtual liquidity from the shared vault
 * to a market (PERC-628).
 *
 * Instruction data: tag(1) + amount(16) = 17 bytes
 *
 * Accounts:
 *   0. [signer]           Admin
 *   1. []                 Slab
 *   2. [writable]         Shared vault PDA
 *   3. [writable]         Market alloc PDA
 *   4. []                 System program
 */
interface AllocateMarketArgs {
    amount: bigint | string;
}
declare function encodeAllocateMarket(args: AllocateMarketArgs): Uint8Array;
/**
 * QueueWithdrawalSV (Tag 61) — user: queue a withdrawal request for the current
 * epoch (PERC-628). Tokens are locked until the epoch elapses.
 *
 * Instruction data: tag(1) + lpAmount(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer]           User
 *   1. [writable]         Shared vault PDA
 *   2. [writable]         Withdraw request PDA
 *   3. []                 System program
 */
interface QueueWithdrawalSVArgs {
    lpAmount: bigint | string;
}
declare function encodeQueueWithdrawalSV(args: QueueWithdrawalSVArgs): Uint8Array;
/**
 * ClaimEpochWithdrawal (Tag 62) — user: claim a queued withdrawal after the epoch
 * has elapsed (PERC-628). Receives pro-rata collateral from the vault.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           User
 *   1. [writable]         Shared vault PDA
 *   2. [writable]         Withdraw request PDA
 *   3. []                 Slab
 *   4. [writable]         Vault
 *   5. [writable]         User ATA
 *   6. []                 Vault authority
 *   7. []                 Token program
 */
declare function encodeClaimEpochWithdrawal(): Uint8Array;
/**
 * AdvanceEpoch (Tag 63) — permissionless crank: move the shared vault to the next
 * epoch once `epoch_duration_slots` have elapsed (PERC-628).
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           Caller (anyone)
 *   1. [writable]         Shared vault PDA
 */
declare function encodeAdvanceEpoch(): Uint8Array;
/**
 * SetOiImbalanceHardBlock (Tag 71, PERC-8110) — set OI imbalance hard-block threshold (admin only).
 *
 * When `|long_oi − short_oi| / total_oi * 10_000 >= threshold_bps`, any new trade that would
 * *increase* the imbalance is rejected with `OiImbalanceHardBlock` (error code 59).
 *
 * - `threshold_bps = 0`: hard block disabled.
 * - `threshold_bps = 8_000`: block trades that push skew above 80%.
 * - `threshold_bps = 10_000`: never allow >100% skew (always blocks one side when oi > 0).
 *
 * Instruction data layout: tag(1) + threshold_bps(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. [writable] slab
 *
 * @example
 * ```ts
 * const ix = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK, { admin, slab }),
 *   data: Buffer.from(encodeSetOiImbalanceHardBlock({ thresholdBps: 8_000 })),
 * });
 * ```
 */
declare function encodeSetOiImbalanceHardBlock(args: {
    thresholdBps: number;
}): Uint8Array;
/**
 * MintPositionNft (Tag 64, PERC-608) — mint a Token-2022 NFT representing a position.
 *
 * Creates a PositionNft PDA + Token-2022 mint with metadata, then mints 1 NFT to the
 * position owner's ATA. The NFT represents ownership of `user_idx` in the slab.
 *
 * The program creates the ATA internally via CPI when the 11th account (Associated Token
 * Program) is provided. This is required because the NFT mint PDA doesn't exist until the
 * program creates it, so the ATA can't be created in a preceding instruction.
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts (11):
 *   0.  [signer, writable] payer
 *   1.  [writable]         slab
 *   2.  [writable]         position_nft PDA  (created — seeds: ["position_nft", slab, user_idx_u16_le])
 *   3.  [writable]         nft_mint PDA      (created — seeds: ["position_nft_mint", slab, user_idx_u16_le])
 *   4.  [writable]         owner_ata         (Token-2022 ATA for nft_mint — created by program if absent)
 *   5.  [signer]           owner             (must match engine account owner)
 *   6.  []                 vault_authority PDA (seeds: ["vault", slab])
 *   7.  []                 token_2022_program (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
 *   8.  []                 system_program
 *   9.  []                 rent sysvar
 *   10. []                 associated_token_program (ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL)
 */
interface MintPositionNftArgs {
    userIdx: number;
}
declare function encodeMintPositionNft(args: MintPositionNftArgs): Uint8Array;
/**
 * TransferPositionOwnership (Tag 65, PERC-608) — transfer an open position to a new owner.
 *
 * Transfers the Token-2022 NFT from current owner to new owner and updates the on-chain
 * engine account's owner field. Requires `pending_settlement == 0`.
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer, writable] current_owner
 *   1. [writable]         slab
 *   2. [writable]         position_nft PDA
 *   3. [writable]         nft_mint PDA
 *   4. [writable]         current_owner_ata  (source Token-2022 ATA)
 *   5. [writable]         new_owner_ata      (destination Token-2022 ATA)
 *   6. []                 new_owner
 *   7. []                 token_2022_program
 */
interface TransferPositionOwnershipArgs {
    userIdx: number;
}
declare function encodeTransferPositionOwnership(args: TransferPositionOwnershipArgs): Uint8Array;
/**
 * BurnPositionNft (Tag 66, PERC-608) — burn the Position NFT when a position is closed.
 *
 * Burns the NFT, closes the PositionNft PDA and the mint PDA, returning rent to the owner.
 * Can only be called after the position is fully closed (size == 0).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer, writable] owner
 *   1. [writable]         slab
 *   2. [writable]         position_nft PDA  (closed — rent to owner)
 *   3. [writable]         nft_mint PDA      (closed via Token-2022 close_account)
 *   4. [writable]         owner_ata         (Token-2022 ATA, balance burned)
 *   5. []                 vault_authority PDA
 *   6. []                 token_2022_program
 */
interface BurnPositionNftArgs {
    userIdx: number;
}
declare function encodeBurnPositionNft(args: BurnPositionNftArgs): Uint8Array;
/**
 * SetPendingSettlement (Tag 67, PERC-608) — keeper sets the pending_settlement flag.
 *
 * Called by the keeper/admin before performing a funding settlement transfer.
 * Blocks NFT transfers until ClearPendingSettlement is called.
 * Admin-only (protected by GH#1475 keeper allowlist guard).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   keeper / admin
 *   1. []         slab  (read — for PDA verification + admin check)
 *   2. [writable] position_nft PDA
 */
interface SetPendingSettlementArgs {
    userIdx: number;
}
declare function encodeSetPendingSettlement(args: SetPendingSettlementArgs): Uint8Array;
/**
 * ClearPendingSettlement (Tag 68, PERC-608) — keeper clears the pending_settlement flag.
 *
 * Called by the keeper/admin after KeeperCrank has run and funding is settled.
 * Admin-only (protected by GH#1475 keeper allowlist guard).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   keeper / admin
 *   1. []         slab  (read — for PDA verification + admin check)
 *   2. [writable] position_nft PDA
 */
interface ClearPendingSettlementArgs {
    userIdx: number;
}
declare function encodeClearPendingSettlement(args: ClearPendingSettlementArgs): Uint8Array;
/**
 * TransferOwnershipCpi (Tag 69, PERC-608) — internal CPI target for percolator-nft TransferHook.
 *
 * Called by the Token-2022 TransferHook on the percolator-nft program during an NFT transfer.
 * Updates the engine account's owner field to the new_owner public key.
 * NOT intended for direct external use — always called via Token-2022 CPI.
 *
 * Instruction data layout: tag(1) + user_idx(2) + new_owner(32) = 35 bytes
 *
 * Accounts:
 *   0. [signer]   nft TransferHook program (CPI caller)
 *   1. [writable] slab
 *   (remaining accounts per Token-2022 ExtraAccountMeta spec)
 */
interface TransferOwnershipCpiArgs {
    userIdx: number;
    newOwner: PublicKey | string;
}
declare function encodeTransferOwnershipCpi(args: TransferOwnershipCpiArgs): Uint8Array;
/**
 * SetWalletCap (Tag 70, PERC-8111) — set the per-wallet position cap (admin only).
 *
 * Limits the maximum absolute position size any single wallet may hold on this market.
 * Enforced on every trade (TradeNoCpi + TradeCpi) after execute_trade.
 *
 * - `capE6 = 0`: disable per-wallet cap (no limit, default).
 * - `capE6 > 0`: max |position_size| in e6 units ($1 = 1_000_000).
 *   Phase 1 launch value: 1_000_000_000n ($1,000).
 *
 * When a trade would breach the cap, the on-chain error `WalletPositionCapExceeded`
 * (error code 58) is returned.
 *
 * Instruction data layout: tag(1) + cap_e6(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. [writable] slab
 *
 * @example
 * ```ts
 * // Set $1K per-wallet cap
 * const ix = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_WALLET_CAP, [admin, slab]),
 *   data: Buffer.from(encodeSetWalletCap({ capE6: 1_000_000_000n })),
 * });
 *
 * // Disable cap
 * const disableIx = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_WALLET_CAP, [admin, slab]),
 *   data: Buffer.from(encodeSetWalletCap({ capE6: 0n })),
 * });
 * ```
 */
interface SetWalletCapArgs {
    /** Max position size in e6 units. 0 = disabled. $1 = 1_000_000n, $1K = 1_000_000_000n. */
    capE6: bigint | string;
}
declare function encodeSetWalletCap(args: SetWalletCapArgs): Uint8Array;
/**
 * InitMatcherCtx (Tag 75) — admin initializes the matcher context account for an LP slot.
 *
 * The matcher program (DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX) requires its context
 * account to be initialized before TradeCpi can work. Only the percolator program can sign
 * as the LP PDA via invoke_signed, so this instruction acts as the trusted initializer.
 *
 * Instruction data layout: tag(1) + lp_idx(2) + kind(1) + trading_fee_bps(4) +
 *   base_spread_bps(4) + max_total_bps(4) + impact_k_bps(4) +
 *   liquidity_notional_e6(16) + max_fill_abs(16) + max_inventory_abs(16) +
 *   fee_to_insurance_bps(2) + skew_spread_mult_bps(2) = 72 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. []         slab (program-owned; used to verify admin + LP slot)
 *   2. [writable] matcherCtx (must match LP's stored matcher_context)
 *   3. []         matcherProg (executable; must match LP's stored matcher_program)
 *   4. []         lpPda (PDA ["lp", slab, lp_idx]; required by CPI as signer)
 */
interface InitMatcherCtxArgs {
    /** LP account index in the engine (0-based). */
    lpIdx: number;
    /** Matcher kind: 0=Passive, 1=vAMM. */
    kind: number;
    /** Base trading fee in bps (e.g. 30 = 0.30%). */
    tradingFeeBps: number;
    /** Base spread in bps. */
    baseSpreadBps: number;
    /** Max total spread in bps. */
    maxTotalBps: number;
    /** vAMM impact constant in bps (0 for passive matchers). */
    impactKBps: number;
    /** Liquidity notional in e6 units (0 for passive matchers). */
    liquidityNotionalE6: bigint | string;
    /** Max single fill size in absolute units (u128::MAX = no limit). */
    maxFillAbs: bigint | string;
    /** Max inventory size in absolute units (u128::MAX = no limit). */
    maxInventoryAbs: bigint | string;
    /** Fraction of fees routed to insurance fund in bps. */
    feeToInsuranceBps: number;
    /** Skew spread multiplier in bps (0 = disabled). */
    skewSpreadMultBps: number;
}
declare function encodeInitMatcherCtx(args: InitMatcherCtxArgs): Uint8Array;
/** SetInsuranceWithdrawPolicy (tag 22): authority + min_withdraw_base + max_withdraw_bps + cooldown_slots */
interface SetInsuranceWithdrawPolicyArgs {
    authority: PublicKey | string;
    minWithdrawBase: bigint | string;
    maxWithdrawBps: number;
    cooldownSlots: bigint | string;
}
declare function encodeSetInsuranceWithdrawPolicy(args: SetInsuranceWithdrawPolicyArgs): Uint8Array;
/** WithdrawInsuranceLimited (tag 23): amount */
declare function encodeWithdrawInsuranceLimited(args: {
    amount: bigint | string;
}): Uint8Array;
/** ResolvePermissionless (tag 29): no args */
declare function encodeResolvePermissionless(): Uint8Array;
/** ForceCloseResolved (tag 30): user_idx */
declare function encodeForceCloseResolved(args: {
    userIdx: number;
}): Uint8Array;
/** CreateLpVault (tag 37): fee_share_bps + util_curve_enabled */
declare function encodeCreateLpVault(args: {
    feeShareBps: bigint | string;
    utilCurveEnabled?: boolean;
}): Uint8Array;
/** LpVaultDeposit (tag 38): amount */
declare function encodeLpVaultDeposit(args: {
    amount: bigint | string;
}): Uint8Array;
/** LpVaultCrankFees (tag 40): no args */
declare function encodeLpVaultCrankFees(): Uint8Array;
/** ChallengeSettlement (tag 43): proposed_price_e6 */
declare function encodeChallengeSettlement(args: {
    proposedPriceE6: bigint | string;
}): Uint8Array;
/** ResolveDispute (tag 44): accept (0 = reject, 1 = accept) */
declare function encodeResolveDispute(args: {
    accept: number;
}): Uint8Array;
/** DepositLpCollateral (tag 45): user_idx + lp_amount */
declare function encodeDepositLpCollateral(args: {
    userIdx: number;
    lpAmount: bigint | string;
}): Uint8Array;
/** WithdrawLpCollateral (tag 46): user_idx + lp_amount */
declare function encodeWithdrawLpCollateral(args: {
    userIdx: number;
    lpAmount: bigint | string;
}): Uint8Array;
/** SetOffsetPair (tag 54): offset_bps */
declare function encodeSetOffsetPair(args: {
    offsetBps: number;
}): Uint8Array;
/** AttestCrossMargin (tag 55): user_idx_a + user_idx_b */
declare function encodeAttestCrossMargin(args: {
    userIdxA: number;
    userIdxB: number;
}): Uint8Array;
/** RescueOrphanVault (tag 72): no args */
declare function encodeRescueOrphanVault(): Uint8Array;
/** CloseOrphanSlab (tag 73): no args */
declare function encodeCloseOrphanSlab(): Uint8Array;
/** SetDexPool (tag 74): pool pubkey */
declare function encodeSetDexPool(args: {
    pool: PublicKey | string;
}): Uint8Array;
/** CloseKeeperFund (tag 78): no args. Accounts: [admin(signer,writable), slab, keeper_fund_pda(writable)] */
declare function encodeCloseKeeperFund(): Uint8Array;
/** CreateInsuranceMint: creates the insurance LP mint PDA (tag 37, same as CreateLpVault) */
declare function encodeCreateInsuranceMint(): Uint8Array;
/** DepositInsuranceLP: deposit collateral, receive LP tokens (tag 38, same as LpVaultDeposit) */
declare function encodeDepositInsuranceLP(args: {
    amount: bigint | string;
}): Uint8Array;
/** WithdrawInsuranceLP: burn LP tokens, withdraw collateral (tag 39, same as LpVaultWithdraw) */
declare function encodeWithdrawInsuranceLP(args: {
    lpAmount: bigint | string;
}): Uint8Array;

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
 * TradeCpi: 8 accounts (deployed program expects clock sysvar at index 3)
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
 * SetOraclePriceCap: 2 accounts
 * Set oracle price circuit breaker cap (admin only)
 */
declare const ACCOUNTS_SET_ORACLE_PRICE_CAP: readonly AccountSpec[];
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
 *
 * Accepts either:
 *   - `PublicKey[]`  — ordered array, one entry per spec account (legacy form)
 *   - `Record<string, PublicKey>` — named map keyed by account `name` (preferred form)
 *
 * Named-map form resolves accounts by spec name so callers don't have to
 * remember the positional order, and errors clearly on missing names.
 */
declare function buildAccountMetas(spec: readonly AccountSpec[], keys: PublicKey[] | Record<string, PublicKey>): AccountMeta[];
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
/**
 * LpVaultWithdraw: 10 accounts (tag 39, PERC-627 / GH#1926 / PERC-8287)
 *
 * Burn LP vault tokens and withdraw proportional collateral from the LP vault.
 *
 * accounts[9] = creatorLockPda is REQUIRED since percolator-prog PR#170.
 * Non-creator withdrawers must pass the derived PDA key; if no lock exists
 * on-chain the enforcement is a no-op. Omitting it was the bypass vector
 * fixed in GH#1926. Use `deriveCreatorLockPda(programId, slab)` to compute.
 *
 * Accounts:
 *  [0] withdrawer        signer, read-only
 *  [1] slab              writable
 *  [2] withdrawerAta     writable (collateral destination)
 *  [3] vault             writable (collateral source)
 *  [4] tokenProgram      read-only
 *  [5] lpVaultMint       writable (LP tokens burned from here)
 *  [6] withdrawerLpAta   writable (LP tokens source)
 *  [7] vaultAuthority    read-only (PDA that signs token transfers)
 *  [8] lpVaultState      writable
 *  [9] creatorLockPda    writable (REQUIRED — derived from ["creator_lock", slab])
 */
declare const ACCOUNTS_LP_VAULT_WITHDRAW: readonly AccountSpec[];
/**
 * FundMarketInsurance: 5 accounts (PERC-306)
 * Fund per-market isolated insurance balance.
 */
declare const ACCOUNTS_FUND_MARKET_INSURANCE: readonly AccountSpec[];
/**
 * SetInsuranceIsolation: 2 accounts (PERC-306)
 * Set max % of global fund this market can access.
 */
declare const ACCOUNTS_SET_INSURANCE_ISOLATION: readonly AccountSpec[];
/**
 * QueueWithdrawal: 5 accounts (PERC-309)
 * User queues a large LP withdrawal. Creates withdraw_queue PDA.
 */
declare const ACCOUNTS_QUEUE_WITHDRAWAL: readonly AccountSpec[];
/**
 * ClaimQueuedWithdrawal: 10 accounts (PERC-309)
 * Burns LP tokens and releases one epoch tranche of SOL.
 */
declare const ACCOUNTS_CLAIM_QUEUED_WITHDRAWAL: readonly AccountSpec[];
/**
 * CancelQueuedWithdrawal: 3 accounts (PERC-309)
 * Cancels queue, closes withdraw_queue PDA, returns rent to user.
 */
declare const ACCOUNTS_CANCEL_QUEUED_WITHDRAWAL: readonly AccountSpec[];
/**
 * ExecuteAdl: 4+ accounts (PERC-305, tag 50)
 * Permissionless — surgically close/reduce the most profitable position
 * when pnl_pos_tot > max_pnl_cap. For non-Hyperp markets with backup oracles,
 * pass additional oracle accounts at accounts[4..].
 */
declare const ACCOUNTS_EXECUTE_ADL: readonly AccountSpec[];
/**
 * CloseStaleSlabs: 2 accounts (tag 51)
 * Admin closes a slab of an invalid/old layout and recovers rent SOL.
 */
declare const ACCOUNTS_CLOSE_STALE_SLABS: readonly AccountSpec[];
/**
 * ReclaimSlabRent: 2 accounts (tag 52)
 * Reclaim rent from an uninitialised slab. Both dest and slab must sign.
 */
declare const ACCOUNTS_RECLAIM_SLAB_RENT: readonly AccountSpec[];
/**
 * AuditCrank: 1 account (tag 53)
 * Permissionless. Verifies conservation invariants; pauses market on violation.
 */
declare const ACCOUNTS_AUDIT_CRANK: readonly AccountSpec[];
/**
 * AdvanceOraclePhase: 1 account
 * Permissionless — no signer required beyond fee payer.
 */
declare const ACCOUNTS_ADVANCE_ORACLE_PHASE: readonly AccountSpec[];
/**
 * TopUpKeeperFund: 3 accounts
 * Permissionless — anyone can fund. System program required for SOL transfer.
 */
declare const ACCOUNTS_TOPUP_KEEPER_FUND: readonly AccountSpec[];
/**
 * SetOiImbalanceHardBlock: 2 accounts
 * Sets the OI imbalance hard-block threshold (admin only)
 */
declare const ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK: readonly AccountSpec[];
/**
 * MintPositionNft: 10 accounts
 * Creates a Token-2022 position NFT for an open position.
 */
declare const ACCOUNTS_MINT_POSITION_NFT: readonly AccountSpec[];
/**
 * TransferPositionOwnership: 8 accounts
 * Transfer position NFT and update on-chain owner. Requires pending_settlement == 0.
 */
declare const ACCOUNTS_TRANSFER_POSITION_OWNERSHIP: readonly AccountSpec[];
/**
 * BurnPositionNft: 7 accounts
 * Burns NFT and closes PositionNft + mint PDAs after position is closed.
 */
declare const ACCOUNTS_BURN_POSITION_NFT: readonly AccountSpec[];
/**
 * SetPendingSettlement: 3 accounts
 * Keeper/admin sets pending_settlement flag before funding transfer.
 * Protected by admin allowlist (GH#1475).
 */
declare const ACCOUNTS_SET_PENDING_SETTLEMENT: readonly AccountSpec[];
/**
 * ClearPendingSettlement: 3 accounts
 * Keeper/admin clears pending_settlement flag after KeeperCrank.
 * Protected by admin allowlist (GH#1475).
 */
declare const ACCOUNTS_CLEAR_PENDING_SETTLEMENT: readonly AccountSpec[];
/**
 * SetWalletCap: 2 accounts
 * Sets the per-wallet position cap (admin only). capE6=0 disables.
 */
declare const ACCOUNTS_SET_WALLET_CAP: readonly AccountSpec[];
/**
 * SetDexPool: 3 accounts
 * Admin pins the approved DEX pool address for a HYPERP market.
 * After this call, UpdateHyperpMark rejects any pool that does not match.
 */
declare const ACCOUNTS_SET_DEX_POOL: readonly AccountSpec[];
/**
 * InitMatcherCtx: 5 accounts
 * Admin CPI-initializes the matcher context account for an LP slot.
 * The LP PDA signs via invoke_signed in the program — it must be included in
 * the transaction's account list even though it carries 0 lamports.
 */
declare const ACCOUNTS_INIT_MATCHER_CTX: readonly AccountSpec[];
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
 *
 * Hex capture is bounded (1–8 digits) so pathological logs cannot feed unbounded
 * strings into `parseInt` or produce precision-loss codes above u32.
 */
declare function parseErrorFromLogs(logs: string[]): {
    code: number;
    name: string;
    hint?: string;
} | null;

/**
 * Full slab layout descriptor. Returned by detectSlabLayout().
 * All engine field offsets are relative to engineOff.
 */
interface SlabLayout {
    version: 0 | 1 | 2;
    headerLen: number;
    configOffset: number;
    configLen: number;
    reservedOff: number;
    engineOff: number;
    accountSize: number;
    maxAccounts: number;
    bitmapWords: number;
    accountsOff: number;
    engineInsuranceOff: number;
    engineParamsOff: number;
    paramsSize: number;
    engineCurrentSlotOff: number;
    engineFundingIndexOff: number;
    engineLastFundingSlotOff: number;
    engineFundingRateBpsOff: number;
    engineMarkPriceOff: number;
    engineLastCrankSlotOff: number;
    engineMaxCrankStalenessOff: number;
    engineTotalOiOff: number;
    engineLongOiOff: number;
    engineShortOiOff: number;
    engineCTotOff: number;
    enginePnlPosTotOff: number;
    engineLiqCursorOff: number;
    engineGcCursorOff: number;
    engineLastSweepStartOff: number;
    engineLastSweepCompleteOff: number;
    engineCrankCursorOff: number;
    engineSweepStartIdxOff: number;
    engineLifetimeLiquidationsOff: number;
    engineLifetimeForceClosesOff: number;
    engineNetLpPosOff: number;
    engineLpSumAbsOff: number;
    engineLpMaxAbsOff: number;
    engineLpMaxAbsSweepOff: number;
    engineEmergencyOiModeOff: number;
    engineEmergencyStartSlotOff: number;
    engineLastBreakerSlotOff: number;
    engineBitmapOff: number;
    postBitmap: number;
    acctOwnerOff: number;
    hasInsuranceIsolation: boolean;
    engineInsuranceIsolatedOff: number;
    engineInsuranceIsolationBpsOff: number;
}
declare const ENGINE_OFF = 600;
declare const ENGINE_MARK_PRICE_OFF = 400;
/**
 * V2 slab tier sizes (small and large) for discovery.
 * V2 uses ENGINE_OFF=600, BITMAP_OFF=432, ACCOUNT_SIZE=248, postBitmap=18.
 * Sizes overlap with V1D (postBitmap=2) — disambiguation requires reading the version field.
 */
declare const SLAB_TIERS_V2: {
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65088;
        readonly label: "Small";
        readonly description: "256 slots (V2 BPF intermediate)";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025568;
        readonly label: "Large";
        readonly description: "4,096 slots (V2 BPF intermediate)";
    };
};
/**
 * V1M slab tier sizes — mainnet-deployed V1 program (ESa89R5).
 * ENGINE_OFF=640, BITMAP_OFF=726, ACCOUNT_SIZE=248, postBitmap=18.
 * Expanded RiskParams (336 bytes) and trade_twap runtime fields.
 * Confirmed by on-chain probing of slab 8NY7rvQ (SOL/USDC Perpetual, 257512 bytes).
 */
declare const SLAB_TIERS_V1M: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * V1M2 slab tier sizes — mainnet program rebuilt from main@4861c56 with 312-byte accounts.
 * ENGINE_OFF=616, BITMAP_OFF=1008 (empirically verified from CCTegYZ...).
 * Engine struct is layout-identical to V_ADL; differs only in engineOff (616 vs 624).
 * Sizes are unique from V_ADL after the bitmap correction: medium=323312 vs V_ADL=323320.
 */
declare const SLAB_TIERS_V1M2: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * V_ADL slab tier sizes — PERC-8270/8271 ADL-upgraded program.
 * ENGINE_OFF=624, BITMAP_OFF=1008, ACCOUNT_SIZE=312, postBitmap=18.
 * New account layout adds ADL tracking fields (+64 bytes/account including alignment padding).
 * BPF SLAB_LEN verified by cargo build-sbf in PERC-8271: large (4096) = 1288320 bytes.
 */
declare const SLAB_TIERS_V_ADL: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * V_SETDEXPOOL slab tier sizes — PERC-SetDexPool security fix.
 * ENGINE_OFF=632, BITMAP_OFF=1008, ACCOUNT_SIZE=312, CONFIG_LEN=528.
 * e.g. large (4096 accts) = 1288336 bytes.
 */
declare const SLAB_TIERS_V_SETDEXPOOL: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * V12_1 slab tier sizes — percolator-core v12.1 merge.
 * ENGINE_OFF=648, BITMAP_OFF=1016, ACCOUNT_SIZE=320.
 * Verified by cargo build-sbf compile-time assertions.
 */
declare const SLAB_TIERS_V12_1: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * Detect the slab layout version from the raw account data length.
 * Returns the full SlabLayout descriptor, or null if the size is unrecognised.
 * Checks V12_1, V_SETDEXPOOL, V1M2, V_ADL, V1M, V0, V1D, V1D-legacy, V1, and V1-legacy sizes.
 *
 * When `data` is provided and the size matches V1D, the version field at offset 8 is read
 * to disambiguate V2 slabs (which produce identical sizes to V1D with postBitmap=2).
 * V2 slabs have version===2 at offset 8 (u32 LE).
 *
 * @param dataLen - The slab account data length in bytes
 * @param data    - Optional raw slab data for version-field disambiguation
 */
declare function detectSlabLayout(dataLen: number, data?: Uint8Array): SlabLayout | null;
/**
 * Legacy detectLayout for backward compat.
 * Returns { bitmapWords, accountsOff, maxAccounts } or null.
 *
 * GH#1238: previously recomputed accountsOff with hardcoded postBitmap=18, which gave a value
 * 16 bytes too large for V1D slabs (which use postBitmap=2). Now delegates directly to the
 * SlabLayout descriptor so each variant uses its own correct accountsOff.
 */
declare function detectLayout(dataLen: number): {
    bitmapWords: number;
    accountsOff: number;
    maxAccounts: number;
} | null;
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
    /** @deprecated Removed in V12_1 — always 0 */ fundingPremiumWeightBps: bigint;
    /** @deprecated Removed in V12_1 — always 0 */ fundingSettlementIntervalSlots: bigint;
    /** @deprecated Removed in V12_1 — always 0 */ fundingPremiumDampeningE6: bigint;
    /** @deprecated Removed in V12_1 — always 0 */ fundingPremiumMaxBpsPerSlot: bigint;
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
    oiCapMultiplierBps: bigint;
    maxPnlCap: bigint;
    adaptiveFundingEnabled: boolean;
    adaptiveScaleBps: number;
    adaptiveMaxFundingBps: bigint;
    marketCreatedSlot: bigint;
    oiRampSlots: bigint;
    resolvedSlot: bigint;
    insuranceIsolationBps: number;
    /** PERC-622: Oracle phase (0=Nascent, 1=Growing, 2=Mature) */
    oraclePhase: number;
    /** PERC-622: Cumulative trade volume in e6 format */
    cumulativeVolumeE6: bigint;
    /** PERC-622: Slots elapsed from market creation to Phase 2 entry (u24) */
    phase2DeltaSlots: number;
    /**
     * PERC-SetDexPool: Admin-pinned DEX pool pubkey for HYPERP markets.
     * Null when reading old slabs (pre-SetDexPool configLen < 528) or when
     * SetDexPool has never been called (all-zero pubkey).
     * Non-null means the program will reject any UpdateHyperpMark that passes
     * a different pool account.
     */
    dexPool: PublicKey | null;
}
interface InsuranceFund {
    balance: bigint;
    feeRevenue: bigint;
    isolatedBalance: bigint;
    isolationBps: number;
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
    /** Minimum initial deposit to open an account (V12_1+ only) */
    minInitialDeposit: bigint;
    /** Minimum nonzero maintenance margin requirement (V12_1+ only) */
    minNonzeroMmReq: bigint;
    /** Minimum nonzero initial margin requirement (V12_1+ only) */
    minNonzeroImReq: bigint;
    /** Insurance fund floor (V12_1+ only) */
    insuranceFloor: bigint;
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
    longOi: bigint;
    shortOi: bigint;
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
    emergencyOiMode: boolean;
    emergencyStartSlot: bigint;
    lastBreakerSlot: bigint;
    numUsedAccounts: number;
    nextAccountId: bigint;
    markPriceE6: bigint;
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
declare function fetchSlab(connection: Connection, slabPubkey: PublicKey): Promise<Uint8Array>;
declare const RAMP_START_BPS = 1000n;
declare const DEFAULT_OI_RAMP_SLOTS = 432000n;
declare function computeEffectiveOiCapBps(config: MarketConfig, currentSlot: bigint): bigint;
declare function readNonce(data: Uint8Array): bigint;
declare function readLastThrUpdateSlot(data: Uint8Array): bigint;
/**
 * Parse slab header (first 72 bytes — layout-independent).
 */
declare function parseHeader(data: Uint8Array): SlabHeader;
/**
 * Parse market config. Layout-version aware.
 * For V0 slabs, fields beyond the basic config are read if present in the data,
 * otherwise defaults are returned.
 *
 * @param data - Slab data (may be a partial slice for discovery; pass layoutHint in that case)
 * @param layoutHint - Pre-detected layout to use; if omitted, detected from data.length.
 */
declare function parseConfig(data: Uint8Array, layoutHint?: SlabLayout | null): MarketConfig;
/**
 * Parse RiskParams from engine data. Layout-version aware.
 * For V0 slabs, extended params (risk_threshold, maintenance_fee, etc.) are
 * not present on-chain, so defaults (0) are returned.
 *
 * @param data - Slab data (may be a partial slice; pass layoutHint in that case)
 * @param layoutHint - Pre-detected layout to use; if omitted, detected from data.length.
 */
declare function parseParams(data: Uint8Array, layoutHint?: SlabLayout | null): RiskParams;
/**
 * Parse RiskEngine state (excluding accounts array). Layout-version aware.
 */
declare function parseEngine(data: Uint8Array): EngineState;
/**
 * Read bitmap to get list of used account indices.
 */
/**
 * Return all account indices whose bitmap bit is set (i.e. slot is in use).
 * Uses the layout-aware bitmap offset so V1_LEGACY slabs (bitmap at rel+672) are handled correctly.
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
/**
 * Derive keeper fund PDA.
 * Seeds: ["keeper_fund", slab_key]
 */
declare function deriveKeeperFund(programId: PublicKey, slab: PublicKey): [PublicKey, number];
/** PumpSwap AMM program ID. */
declare const PUMPSWAP_PROGRAM_ID: PublicKey;
/** Raydium CLMM (Concentrated Liquidity) program ID. */
declare const RAYDIUM_CLMM_PROGRAM_ID: PublicKey;
/** Meteora DLMM (Dynamic Liquidity Market Maker) program ID. */
declare const METEORA_DLMM_PROGRAM_ID: PublicKey;
/** Pyth Push Oracle program on mainnet. */
declare const PYTH_PUSH_ORACLE_PROGRAM_ID: PublicKey;
/**
 * Seed used to derive the creator lock PDA.
 * Matches `creator_lock::CREATOR_LOCK_SEED` in percolator-prog.
 */
declare const CREATOR_LOCK_SEED = "creator_lock";
/**
 * Derive the creator lock PDA for a given slab.
 * Seeds: ["creator_lock", slab_key]
 *
 * This PDA is required as accounts[9] in every LpVaultWithdraw instruction
 * since percolator-prog PR#170 (GH#1926 / PERC-8287).
 * Non-creator withdrawers must pass this key; if no lock exists on-chain the
 * enforcement is a no-op. The SDK must ALWAYS include it — passing it is mandatory.
 *
 * @param programId - The percolator program ID.
 * @param slab      - The slab (market) public key.
 * @returns [pda, bump]
 *
 * @example
 * ```ts
 * const [creatorLockPda] = deriveCreatorLockPda(PROGRAM_ID, slabKey);
 * ```
 */
declare function deriveCreatorLockPda(programId: PublicKey, slab: PublicKey): [PublicKey, number];
declare function derivePythPushOraclePDA(feedIdHex: string): [PublicKey, number];

/**
 * Get the associated token address for an owner and mint.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 */
declare function getAta(owner: PublicKey, mint: PublicKey, allowOwnerOffCurve?: boolean, tokenProgramId?: PublicKey): Promise<PublicKey>;
/**
 * Synchronous version of getAta.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 */
declare function getAtaSync(owner: PublicKey, mint: PublicKey, allowOwnerOffCurve?: boolean, tokenProgramId?: PublicKey): PublicKey;
/**
 * Fetch token account info.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 * Throws if account doesn't exist.
 */
declare function fetchTokenAccount(connection: Connection, address: PublicKey, tokenProgramId?: PublicKey): Promise<Account$1>;

/**
 * Read an environment variable safely. Returns `undefined` in browser
 * environments where `process` is not defined, avoiding a
 * `ReferenceError` crash at import time.
 */
declare function safeEnv(key: string): string | undefined;
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
        readonly percolator: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";
        readonly matcher: "DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX";
    };
};
type Network = "devnet" | "mainnet";
/**
 * Get the Percolator program ID for the current network
 *
 * Priority:
 * 1. PROGRAM_ID env var (explicit override)
 * 2. Network-specific default (NETWORK env var)
 * 3. Devnet default (safest fallback — bug bounty PERC-697)
 */
declare function getProgramId(network?: Network): PublicKey;
/**
 * Get the Matcher program ID for the current network
 */
declare function getMatcherProgramId(network?: Network): PublicKey;
/**
 * Get the current network from environment.
 *
 * SECURITY (PERC-697): Removed silent mainnet default.
 * Previously defaulted to "mainnet" when NETWORK was unset, which could cause
 * crank/keeper scripts run without env vars to silently target mainnet program IDs.
 *
 * Now defaults to "devnet" — the safer fallback for a devnet-first protocol.
 * Production deployments always set NETWORK explicitly via Railway/env.
 * For mainnet operations use networkValidation.ts (ensureNetworkConfigValid) which
 * enforces FORCE_MAINNET=1.
 */
declare function getCurrentNetwork(): Network;

/**
 * Static market registry — bundled list of known Percolator slab addresses.
 *
 * This is the tier-3 fallback for `discoverMarkets()`: when both
 * `getProgramAccounts` (tier 1) and the REST API (tier 2) are unavailable,
 * the SDK falls back to this bundled list to bootstrap market discovery.
 *
 * The addresses are fetched on-chain via `getMarketsByAddress`
 * (`getMultipleAccounts`), so all data is still verified on-chain.  The static
 * list only provides the *address directory* — no cached market data is used.
 *
 * ## Maintenance
 *
 * Update this list when new markets are deployed or old ones are retired.
 * Run `scripts/update-static-markets.ts` to regenerate from a permissive RPC
 * or the REST API.
 *
 * @module
 */

/**
 * A single entry in the static market registry.
 *
 * Only the slab address (base58) is required.  Optional metadata fields
 * (`symbol`, `name`) are provided for debugging/logging purposes only —
 * they are **not** used for on-chain data and may become stale.
 */
interface StaticMarketEntry {
    /** Base58-encoded slab account address. */
    slabAddress: string;
    /** Optional human-readable symbol (e.g. "SOL-PERP"). */
    symbol?: string;
    /** Optional descriptive name. */
    name?: string;
}
/**
 * Get the bundled static market list for a given network.
 *
 * Returns the built-in list merged with any entries added via
 * {@link registerStaticMarkets}.  Duplicates (by `slabAddress`) are removed
 * automatically — user-registered entries take precedence.
 *
 * @param network - Target network (`"mainnet"` or `"devnet"`)
 * @returns Array of static market entries (may be empty if no markets are known)
 *
 * @example
 * ```ts
 * import { getStaticMarkets } from "@percolator/sdk";
 *
 * const markets = getStaticMarkets("mainnet");
 * console.log(`${markets.length} known mainnet slab addresses`);
 * ```
 */
declare function getStaticMarkets(network: Network): StaticMarketEntry[];
/**
 * Register additional static market entries at runtime.
 *
 * Use this to inject known slab addresses before calling `discoverMarkets()`
 * so that tier-3 fallback has addresses to work with — especially useful
 * right after mainnet launch when the bundled list may be empty.
 *
 * Entries are deduplicated by `slabAddress` — calling this multiple times
 * with the same address is safe.
 *
 * @param network - Target network
 * @param entries - One or more static market entries to register
 *
 * @example
 * ```ts
 * import { registerStaticMarkets } from "@percolator/sdk";
 *
 * registerStaticMarkets("mainnet", [
 *   { slabAddress: "ABC123...", symbol: "SOL-PERP" },
 *   { slabAddress: "DEF456...", symbol: "ETH-PERP" },
 * ]);
 * ```
 */
declare function registerStaticMarkets(network: Network, entries: StaticMarketEntry[]): void;
/**
 * Clear all user-registered static market entries for a network.
 *
 * Useful in tests or when resetting state.
 *
 * @param network - Target network to clear (omit to clear all networks)
 */
declare function clearStaticMarkets(network?: Network): void;

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
 * Slab tier definitions — V1 layout (all tiers upgraded as of 2026-03-13).
 * IMPORTANT: dataSize must match the compiled program's SLAB_LEN for that MAX_ACCOUNTS.
 * The on-chain program has a hardcoded SLAB_LEN — slab account data.len() must equal it exactly.
 *
 * Layout: HEADER(104) + CONFIG(536) + RiskEngine(variable by tier)
 *   ENGINE_OFF = 640  (HEADER=104 + CONFIG=536, padded to 8-byte align on SBF)
 *   RiskEngine = fixed(656) + bitmap(BW*8) + post_bitmap(18) + next_free(N*2) + pad + accounts(N*248)
 *
 * Values are empirically verified against on-chain initialized accounts (GH #1109):
 *   small  = 65,352  (256-acct program, verified on-chain post-V1 upgrade)
 *   medium = 257,448 (1024-acct program g9msRSV3, verified on-chain)
 *   large  = 1,025,832 (4096-acct program FxfD37s1, pre-PERC-118, matches slabDataSizeV1(4096) formula)
 *
 * NOTE: small program (FwfBKZXb) redeployed with --features small,devnet (2026-03-13).
 *       Large program FxfD37s1 is pre-PERC-118 — SLAB_LEN=1,025,832, matching formula.
 *       See GH #1109, GH #1112.
 *
 * History: Small was V0 (62_808) until 2026-03-13 program upgrade. V0 values preserved
 *          in SLAB_TIERS_V0 for discovery of legacy on-chain accounts.
 */
/**
 * Default slab tiers for the current mainnet program (v12.1).
 * These are used by useCreateMarket to allocate slab accounts of the correct size.
 */
declare const SLAB_TIERS: {
    readonly micro: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
    readonly small: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
    readonly medium: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
    readonly large: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
};
/** @deprecated V0 slab sizes — kept for backward compatibility with old on-chain slabs */
declare const SLAB_TIERS_V0: {
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 62808;
        readonly label: "Small";
        readonly description: "256 slots · ~0.44 SOL";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 248760;
        readonly label: "Medium";
        readonly description: "1,024 slots · ~1.73 SOL";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 992568;
        readonly label: "Large";
        readonly description: "4,096 slots · ~6.90 SOL";
    };
};
/**
 * V1D slab sizes — actually-deployed devnet V1 program (ENGINE_OFF=424, BITMAP_OFF=624).
 * PR #1200 added V1D layout detection in slab.ts but discovery.ts ALL_TIERS was missing
 * these sizes, causing V1D slabs to fall through to the memcmp fallback with wrong dataSize
 * hints → detectSlabLayout returning null → parse failure (GH#1205).
 *
 * Sizes computed via computeSlabSize(ENGINE_OFF=424, BITMAP_OFF=624, ACCOUNT_SIZE=248, N, postBitmap=2):
 *   The V1D deployed program uses postBitmap=2 (free_head u16 only — no num_used/pad/next_account_id).
 *   This is 16 bytes smaller per tier than the SDK default (postBitmap=18). GH#1234.
 *   micro  =  17,064  (64 slots)
 *   small  =  65,088  (256 slots)
 *   medium = 257,184  (1,024 slots)
 *   large  = 1,025,568 (4,096 slots)
 */
declare const SLAB_TIERS_V1D: {
    readonly micro: {
        readonly maxAccounts: 64;
        readonly dataSize: 17064;
        readonly label: "Micro";
        readonly description: "64 slots (V1D devnet)";
    };
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65088;
        readonly label: "Small";
        readonly description: "256 slots (V1D devnet)";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 257184;
        readonly label: "Medium";
        readonly description: "1,024 slots (V1D devnet)";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025568;
        readonly label: "Large";
        readonly description: "4,096 slots (V1D devnet)";
    };
};
/**
 * V1D legacy slab sizes — on-chain V1D slabs created before GH#1234 when the SDK assumed
 * postBitmap=18. These are 16 bytes larger per tier than SLAB_TIERS_V1D.
 * PR #1236 fixed postBitmap for new slabs (→2) but caused slab 6ZytbpV4 (65104 bytes,
 * top active market ~$15k 24h vol) to be unrecognized → "Failed to load market". GH#1237.
 *
 * Sizes computed via computeSlabSize(ENGINE_OFF=424, BITMAP_OFF=624, ACCOUNT_SIZE=248, N, postBitmap=18):
 *   micro  =  17,080  (64 slots)
 *   small  =  65,104  (256 slots)  ← slab 6ZytbpV4 TEST/USD
 *   medium = 257,200  (1,024 slots)
 *   large  = 1,025,584 (4,096 slots)
 */
declare const SLAB_TIERS_V1D_LEGACY: {
    readonly micro: {
        readonly maxAccounts: 64;
        readonly dataSize: 17080;
        readonly label: "Micro";
        readonly description: "64 slots (V1D legacy, postBitmap=18)";
    };
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65104;
        readonly label: "Small";
        readonly description: "256 slots (V1D legacy, postBitmap=18)";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 257200;
        readonly label: "Medium";
        readonly description: "1,024 slots (V1D legacy, postBitmap=18)";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025584;
        readonly label: "Large";
        readonly description: "4,096 slots (V1D legacy, postBitmap=18)";
    };
};
/** @deprecated Alias — use SLAB_TIERS (already V1) */
declare const SLAB_TIERS_V1: {
    readonly micro: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
    readonly small: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
    readonly medium: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
    readonly large: {
        maxAccounts: number;
        dataSize: number;
        label: string;
        description: string;
    };
};
/**
 * V_ADL slab tier sizes — PERC-8270/8271 ADL-upgraded program.
 * ENGINE_OFF=624, BITMAP_OFF=1006, ACCOUNT_SIZE=312, postBitmap=18.
 * New account layout adds ADL tracking fields (+64 bytes/account).
 * BPF SLAB_LEN verified by cargo build-sbf in PERC-8271: large (4096) = 1288304 bytes.
 */
declare const SLAB_TIERS_V_ADL_DISCOVERY: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
type SlabTierKey = keyof typeof SLAB_TIERS;
/** Calculate slab data size for arbitrary account count.
 *
 * Layout (SBF, u128 align = 8):
 *   HEADER(104) + CONFIG(536) → ENGINE_OFF = 640
 *   RiskEngine fixed scalars: 656 bytes (PERC-299: +24 emergency OI, +32 long/short OI)
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
 * Calculate slab data size for V1 layout (ENGINE_OFF=640).
 *
 * NOTE: This formula is accurate for small (256) and medium (1024) tiers but
 * underestimates large (4096) by 16 bytes — likely due to a padding/alignment
 * difference at high account counts or a post-PERC-118 struct addition in the
 * deployed binary. Always prefer the hardcoded SLAB_TIERS values (empirically
 * verified on-chain) over this formula for production use.
 */
declare function slabDataSizeV1(maxAccounts: number): number;
/**
 * Validate that a slab data size matches one of the known tier sizes.
 * Use this to catch tier↔program mismatches early (PERC-277).
 *
 * @param dataSize - The expected slab data size (from SLAB_TIERS[tier].dataSize)
 * @param programSlabLen - The program's compiled SLAB_LEN (from on-chain error logs or program introspection)
 * @returns true if sizes match, false if there's a mismatch
 */
declare function validateSlabTierMatch(dataSize: number, programSlabLen: number): boolean;
/** Options for `discoverMarkets`. */
interface DiscoverMarketsOptions {
    /**
     * Run tier queries sequentially with per-tier retry on HTTP 429 instead of
     * firing all in parallel.  Reduces RPC rate-limit pressure at the cost of
     * slightly slower discovery (~14 round-trips instead of 1 concurrent batch).
     * Default: false (preserves original parallel behaviour).
     *
     * PERC-1650: keeper uses this flag to avoid 429 storms on its fallback RPC
     * (Helius starter tier).  Pass `sequential: true` from CrankService.discover().
     */
    sequential?: boolean;
    /**
     * Delay in ms between sequential tier queries (only used when sequential=true).
     * Default: 200 ms.
     */
    interTierDelayMs?: number;
    /**
     * Per-tier retry backoff delays on 429 (ms).  Jitter of up to +25% is applied.
     * Only used when sequential=true.  Default: [1_000, 3_000, 9_000, 27_000].
     */
    rateLimitBackoffMs?: number[];
    /**
     * In parallel mode (the default), cap how many tier RPC requests are in-flight
     * at once to avoid accidental RPC storms from client code.
     *
     * Default: 6
     */
    maxParallelTiers?: number;
    /**
     * Hard cap on how many tier dataSize queries are attempted.
     * Default: all known tiers.
     */
    maxTierQueries?: number;
    /**
     * Base URL of the Percolator REST API (e.g. `"https://percolatorlaunch.com/api"`).
     *
     * When set, `discoverMarkets` will fall back to the REST API's `GET /markets`
     * endpoint if `getProgramAccounts` fails or returns 0 results (common on public
     * mainnet RPCs that reject `getProgramAccounts`).
     *
     * The API returns slab addresses which are then fetched on-chain via
     * `getMarketsByAddress` (uses `getMultipleAccounts`, works on all RPCs).
     *
     * GH#59 / PERC-8424: Unblocks mainnet users without a Helius API key.
     *
     * @example
     * ```ts
     * const markets = await discoverMarkets(connection, programId, {
     *   apiBaseUrl: "https://percolatorlaunch.com/api",
     * });
     * ```
     */
    apiBaseUrl?: string;
    /**
     * Timeout in ms for the API fallback HTTP request.
     * Only used when `apiBaseUrl` is set.
     * Default: 10_000 (10 seconds).
     */
    apiTimeoutMs?: number;
    /**
     * Network hint for tier-3 static bundle fallback (`"mainnet"` or `"devnet"`).
     *
     * When both `getProgramAccounts` (tier 1) and the REST API (tier 2) fail,
     * `discoverMarkets` will fall back to a bundled static list of known slab
     * addresses for the specified network.  The addresses are fetched on-chain
     * via `getMarketsByAddress` (`getMultipleAccounts` — works on all RPCs).
     *
     * If not set, tier-3 fallback is disabled.
     *
     * The static list can be extended at runtime via `registerStaticMarkets()`.
     *
     * @see {@link registerStaticMarkets} to add addresses at runtime
     * @see {@link getStaticMarkets} to inspect the current static list
     *
     * @example
     * ```ts
     * const markets = await discoverMarkets(connection, programId, {
     *   apiBaseUrl: "https://percolatorlaunch.com/api",
     *   network: "mainnet",  // enables tier-3 static fallback
     * });
     * ```
     */
    network?: Network;
}
/**
 * Discover all Percolator markets owned by the given program.
 * Uses getProgramAccounts with dataSize filter + dataSlice to download only ~1400 bytes per slab.
 *
 * @param options.sequential - Run tier queries sequentially with 429 retry (PERC-1650).
 */
declare function discoverMarkets(connection: Connection, programId: PublicKey, options?: DiscoverMarketsOptions): Promise<DiscoveredMarket[]>;
/**
 * Options for `getMarketsByAddress`.
 */
interface GetMarketsByAddressOptions {
    /**
     * Maximum number of addresses per `getMultipleAccounts` RPC call.
     * Solana limits a single call to 100 accounts; callers may lower this
     * to reduce per-request payload size or avoid 429s.
     *
     * Default: 100 (Solana maximum).
     */
    batchSize?: number;
    /**
     * Delay in ms between batches when the address list exceeds `batchSize`.
     * Helps avoid rate-limiting on public RPCs.
     *
     * Default: 0 (no delay).
     */
    interBatchDelayMs?: number;
}
/**
 * Fetch and parse Percolator markets by their known slab addresses.
 *
 * Unlike `discoverMarkets()` — which uses `getProgramAccounts` and is blocked
 * on public mainnet RPCs — this function uses `getMultipleAccounts`, which works
 * on any RPC endpoint (including `api.mainnet-beta.solana.com`).
 *
 * Callers must already know the market slab addresses (e.g. from an indexer,
 * a hardcoded registry, or a previous `discoverMarkets` call on a permissive RPC).
 *
 * @param connection - Solana RPC connection
 * @param programId - The Percolator program that owns these slabs
 * @param addresses - Array of slab account public keys to fetch
 * @param options   - Optional batching/delay configuration
 * @returns Parsed markets for all valid slab accounts; invalid/missing accounts are silently skipped.
 *
 * @example
 * ```ts
 * import { getMarketsByAddress, getProgramId } from "@percolator/sdk";
 * import { Connection, PublicKey } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const slabs = [
 *   new PublicKey("So11111111111111111111111111111111111111112"),
 *   // ... more known slab addresses
 * ];
 *
 * const markets = await getMarketsByAddress(connection, programId, slabs);
 * console.log(`Found ${markets.length} markets`);
 * ```
 */
declare function getMarketsByAddress(connection: Connection, programId: PublicKey, addresses: PublicKey[], options?: GetMarketsByAddressOptions): Promise<DiscoveredMarket[]>;
/**
 * Shape of a single market entry returned by the Percolator REST API
 * (`GET /markets`).  Only the fields needed for discovery are typed here;
 * the full API response may contain additional statistics fields.
 */
interface ApiMarketEntry {
    slab_address: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    status?: string;
    [key: string]: unknown;
}
/** Options for {@link discoverMarketsViaApi}. */
interface DiscoverMarketsViaApiOptions {
    /**
     * Timeout in ms for the HTTP request to the REST API.
     * Default: 10_000 (10 seconds).
     */
    timeoutMs?: number;
    /**
     * Options forwarded to {@link getMarketsByAddress} for the on-chain fetch
     * step (batch size, inter-batch delay).
     */
    onChainOptions?: GetMarketsByAddressOptions;
}
/**
 * Discover Percolator markets by first querying the REST API for slab addresses,
 * then fetching full on-chain data via `getMarketsByAddress` (which uses
 * `getMultipleAccounts` — works on all RPCs including public mainnet nodes).
 *
 * This is the recommended discovery path for mainnet users who do not have a
 * Helius API key, since `getProgramAccounts` is rejected by public RPCs.
 *
 * The REST API acts as an address directory only — all market data is verified
 * on-chain via `getMarketsByAddress`, so the caller gets the same
 * `DiscoveredMarket[]` result as `discoverMarkets()`.
 *
 * @param connection - Solana RPC connection (any endpoint, including public)
 * @param programId - The Percolator program that owns the slabs
 * @param apiBaseUrl - Base URL of the Percolator REST API
 *                     (e.g. `"https://percolatorlaunch.com/api"`)
 * @param options - Optional timeout and on-chain fetch configuration
 * @returns Parsed markets for all valid slab accounts discovered via the API
 *
 * @example
 * ```ts
 * import { discoverMarketsViaApi, getProgramId } from "@percolator/sdk";
 * import { Connection } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const markets = await discoverMarketsViaApi(
 *   connection,
 *   programId,
 *   "https://percolatorlaunch.com/api",
 * );
 * console.log(`Discovered ${markets.length} markets via API fallback`);
 * ```
 */
declare function discoverMarketsViaApi(connection: Connection, programId: PublicKey, apiBaseUrl: string, options?: DiscoverMarketsViaApiOptions): Promise<DiscoveredMarket[]>;
/** Options for {@link discoverMarketsViaStaticBundle}. */
interface DiscoverMarketsViaStaticBundleOptions {
    /**
     * Options forwarded to {@link getMarketsByAddress} for the on-chain fetch
     * step (batch size, inter-batch delay).
     */
    onChainOptions?: GetMarketsByAddressOptions;
}
/**
 * Discover Percolator markets from a static list of known slab addresses.
 *
 * This is the tier-3 (last-resort) fallback for `discoverMarkets()`.  It uses
 * a bundled list of known slab addresses and fetches their full account data
 * on-chain via `getMarketsByAddress` (`getMultipleAccounts` — works on all RPCs).
 *
 * The static list acts as an address directory only — all market data is verified
 * on-chain, so stale entries are silently skipped (the account won't have valid
 * magic bytes or will have been closed).
 *
 * @param connection - Solana RPC connection (any endpoint)
 * @param programId - The Percolator program that owns the slabs
 * @param entries   - Static market entries (typically from {@link getStaticMarkets})
 * @param options   - Optional on-chain fetch configuration
 * @returns Parsed markets for all valid slab accounts; stale/missing entries are skipped.
 *
 * @example
 * ```ts
 * import {
 *   discoverMarketsViaStaticBundle,
 *   getStaticMarkets,
 *   getProgramId,
 * } from "@percolator/sdk";
 * import { Connection } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const entries = getStaticMarkets("mainnet");
 *
 * const markets = await discoverMarketsViaStaticBundle(
 *   connection,
 *   programId,
 *   entries,
 * );
 * console.log(`Recovered ${markets.length} markets from static bundle`);
 * ```
 */
declare function discoverMarketsViaStaticBundle(connection: Connection, programId: PublicKey, entries: StaticMarketEntry[], options?: DiscoverMarketsViaStaticBundleOptions): Promise<DiscoveredMarket[]>;

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
 * Oracle account parsing utilities.
 *
 * Chainlink aggregator layout on Solana (from Toly's percolator-cli):
 *   offset 138: decimals (u8)
 *   offset 216: latest answer (i64 LE)
 *
 * Minimum account size: 224 bytes (offset 216 + 8 bytes for i64).
 *
 * These utilities validate oracle data BEFORE parsing to prevent silent
 * propagation of stale or malformed Chainlink data as price.
 */
/** Minimum buffer size to read Chainlink price data */
declare const CHAINLINK_MIN_SIZE = 224;
/** Maximum reasonable decimals for a price feed */
declare const MAX_DECIMALS = 18;
/** Offset of decimals field in Chainlink aggregator account */
declare const CHAINLINK_DECIMALS_OFFSET = 138;
/** Offset of latest answer in Chainlink aggregator account */
declare const CHAINLINK_ANSWER_OFFSET = 216;
interface OraclePrice {
    price: bigint;
    decimals: number;
}
/**
 * Parse price data from a Chainlink aggregator account buffer.
 *
 * Validates:
 * - Buffer is large enough to contain the required fields (≥ 224 bytes)
 * - Decimals are in a reasonable range (0-18)
 * - Price is positive (non-zero)
 *
 * @param data - Raw account data from Chainlink aggregator
 * @returns Parsed oracle price with decimals
 * @throws if the buffer is invalid or contains unreasonable data
 */
declare function parseChainlinkPrice(data: Uint8Array): OraclePrice;
/**
 * Validate that a buffer looks like a valid Chainlink aggregator account.
 * Returns true if the buffer passes all validation checks, false otherwise.
 * Use this for non-throwing validation.
 */
declare function isValidChainlinkOracle(data: Uint8Array): boolean;

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
 * Deployed devnet:  6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k
 * Deployed mainnet: DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F
 */

/** Known stake program addresses per network. Mainnet is empty until deployed. */
declare const STAKE_PROGRAM_IDS: {
    readonly devnet: "6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k";
    readonly mainnet: "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F";
};
/**
 * Resolve the stake program ID for the given network.
 *
 * Priority:
 *  1. STAKE_PROGRAM_ID env var (explicit override — DevOps sets this for mainnet until constant is filled)
 *  2. Network-specific constant from STAKE_PROGRAM_IDS
 *
 * Throws a clear error on mainnet when no address is available so callers
 * surface the gap instead of silently hitting the devnet program.
 */
declare function getStakeProgramId(network?: 'devnet' | 'mainnet'): PublicKey;
/**
 * Default export — resolves for the current runtime network.
 * Use getStakeProgramId() with an explicit network argument where possible.
 *
 * @deprecated Direct use of STAKE_PROGRAM_ID is being phased out in favour of
 *   getStakeProgramId() so mainnet callers get a clear error rather than silently
 *   resolving to the devnet address.
 */
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
    /** PERC-272: Accrue trading fees to LP vault */
    readonly AccrueFees: 12;
    /** PERC-272: Init pool in trading LP mode */
    readonly InitTradingPool: 13;
    /** PERC-313: Set HWM config (enable + floor bps) */
    readonly AdminSetHwmConfig: 14;
    /** PERC-303: Enable/configure senior-junior LP tranches */
    readonly AdminSetTrancheConfig: 15;
    /** PERC-303: Deposit into junior (first-loss) tranche */
    readonly DepositJunior: 16;
};
/** Derive the stake pool PDA for a given slab (market). */
declare function deriveStakePool(slab: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive the vault authority PDA (signs CPI, owns LP mint + vault). */
declare function deriveStakeVaultAuth(pool: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Derive the per-user deposit PDA (tracks cooldown, deposit time). */
declare function deriveDepositPda(pool: PublicKey, user: PublicKey, programId?: PublicKey): [PublicKey, number];
/** Tag 0: InitPool — create stake pool for a slab. */
declare function encodeStakeInitPool(cooldownSlots: bigint | number, depositCap: bigint | number): Uint8Array;
/** Tag 1: Deposit — deposit collateral, receive LP tokens. */
declare function encodeStakeDeposit(amount: bigint | number): Uint8Array;
/** Tag 2: Withdraw — burn LP tokens, receive collateral (subject to cooldown). */
declare function encodeStakeWithdraw(lpAmount: bigint | number): Uint8Array;
/** Tag 3: FlushToInsurance — move collateral from stake vault to wrapper insurance. */
declare function encodeStakeFlushToInsurance(amount: bigint | number): Uint8Array;
/** Tag 4: UpdateConfig — update cooldown and/or deposit cap. */
declare function encodeStakeUpdateConfig(newCooldownSlots?: bigint | number, newDepositCap?: bigint | number): Uint8Array;
/** Tag 5: TransferAdmin — transfer wrapper admin to pool PDA. */
declare function encodeStakeTransferAdmin(): Uint8Array;
/** Tag 6: AdminSetOracleAuthority — forward to wrapper via CPI. */
declare function encodeStakeAdminSetOracleAuthority(newAuthority: PublicKey): Uint8Array;
/** Tag 7: AdminSetRiskThreshold — forward to wrapper via CPI. */
declare function encodeStakeAdminSetRiskThreshold(newThreshold: bigint | number): Uint8Array;
/** Tag 8: AdminSetMaintenanceFee — forward to wrapper via CPI. */
declare function encodeStakeAdminSetMaintenanceFee(newFee: bigint | number): Uint8Array;
/** Tag 9: AdminResolveMarket — forward to wrapper via CPI. */
declare function encodeStakeAdminResolveMarket(): Uint8Array;
/** Tag 10: AdminWithdrawInsurance — withdraw insurance after market resolution. */
declare function encodeStakeAdminWithdrawInsurance(amount: bigint | number): Uint8Array;
/** Tag 12: AccrueFees — permissionless: accrue trading fees to LP vault. */
declare function encodeStakeAccrueFees(): Uint8Array;
/** Tag 13: InitTradingPool — create pool in trading LP mode (pool_mode = 1). */
declare function encodeStakeInitTradingPool(cooldownSlots: bigint | number, depositCap: bigint | number): Uint8Array;
/** Tag 14 (PERC-313): AdminSetHwmConfig — enable HWM protection and set floor BPS. */
declare function encodeStakeAdminSetHwmConfig(enabled: boolean, hwmFloorBps: number): Uint8Array;
/** Tag 15 (PERC-303): AdminSetTrancheConfig — enable senior/junior LP tranches. */
declare function encodeStakeAdminSetTrancheConfig(juniorFeeMultBps: number): Uint8Array;
/** Tag 16 (PERC-303): DepositJunior — deposit into first-loss junior tranche. */
declare function encodeStakeDepositJunior(amount: bigint | number): Uint8Array;
/** Tag 11: AdminSetInsurancePolicy — set withdrawal policy on wrapper. */
declare function encodeStakeAdminSetInsurancePolicy(authority: PublicKey, minWithdrawBase: bigint | number, maxWithdrawBps: number, cooldownSlots: bigint | number): Uint8Array;
/**
 * Decoded StakePool state (352 bytes on-chain).
 * Includes PERC-272 (fee yield), PERC-313 (HWM), and PERC-303 (tranches).
 */
interface StakePoolState {
    isInitialized: boolean;
    bump: number;
    vaultAuthorityBump: number;
    adminTransferred: boolean;
    slab: PublicKey;
    admin: PublicKey;
    collateralMint: PublicKey;
    lpMint: PublicKey;
    vault: PublicKey;
    totalDeposited: bigint;
    totalLpSupply: bigint;
    cooldownSlots: bigint;
    depositCap: bigint;
    totalFlushed: bigint;
    totalReturned: bigint;
    totalWithdrawn: bigint;
    percolatorProgram: PublicKey;
    totalFeesEarned: bigint;
    lastFeeAccrualSlot: bigint;
    lastVaultSnapshot: bigint;
    poolMode: number;
    hwmEnabled: boolean;
    epochHighWaterTvl: bigint;
    hwmFloorBps: number;
    trancheEnabled: boolean;
    juniorBalance: bigint;
    juniorTotalLp: bigint;
    juniorFeeMultBps: number;
}
/** Size of StakePool on-chain (bytes). */
declare const STAKE_POOL_SIZE = 352;
/**
 * Decode a StakePool account from raw data buffer. * Uses DataView for all u64/u16 reads — browser-safe.
 */
declare function decodeStakePool(data: Uint8Array): StakePoolState;
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

/**
 * @module adl
 * Percolator ADL (Auto-Deleveraging) client utilities.
 *
 * PERC-8278 / PERC-8312 / PERC-305: ADL is triggered when `pnl_pos_tot > max_pnl_cap`
 * on a market (PnL cap exceeded) AND the insurance fund is fully depleted (balance == 0).
 * The most profitable positions on the dominant side are deleveraged first.
 *
 * **Note on caller permissions:** `ExecuteAdl` (tag 50) requires the caller to be the
 * market admin/keeper key (`header.admin`). It is NOT permissionless despite the
 * instruction being structurally available to any signer.
 *
 * API surface:
 *  - fetchAdlRankedPositions() — fetch slab + rank all open positions by PnL%
 *  - rankAdlPositions()        — pure (no-RPC) variant for already-fetched slab bytes
 *  - isAdlTriggered()          — check if slab's pnl_pos_tot exceeds max_pnl_cap
 *  - buildAdlInstruction()     — build a single ExecuteAdl TransactionInstruction
 *  - buildAdlTransaction()     — fetch + rank + pick top target + return instruction
 *  - parseAdlEvent()           — decode AdlEvent from transaction log lines
 *  - fetchAdlRankings()        — call /api/adl/rankings HTTP endpoint
 *  - AdlRankedPosition         — position record with adl_rank and computed pnlPct
 *  - AdlRankingResult          — full ranking with trigger status
 *  - AdlEvent                  — decoded on-chain AdlEvent log entry (tag 0xAD1E_0001)
 *  - AdlApiRanking             — single ranked position from /api/adl/rankings
 *  - AdlApiResult              — full result from /api/adl/rankings
 *  - AdlSide                   — "long" | "short"
 */

/** Position side derived from positionSize sign. */
type AdlSide = "long" | "short";
/**
 * A ranked open position for ADL purposes.
 * Positions are ranked descending by `pnlPct` — rank 0 is the most profitable
 * and will be deleveraged first.
 */
interface AdlRankedPosition {
    /** Account index in the slab (used as `targetIdx` in ExecuteAdl). */
    idx: number;
    /** Owner public key. */
    owner: PublicKey;
    /** Raw position size (i128 — negative = short, positive = long). */
    positionSize: bigint;
    /** Realised + mark-to-market PnL in lamports (i128 from slab). */
    pnl: bigint;
    /** Capital at entry in lamports (u128). */
    capital: bigint;
    /**
     * PnL as a fraction of capital, expressed as basis points (scaled × 10_000).
     * pnlPct = pnl * 10_000 / capital.
     * Higher = more profitable = deleveraged first.
     */
    pnlPct: bigint;
    /** Long or short. */
    side: AdlSide;
    /**
     * ADL rank among positions on the same side (0 = highest PnL%, deleveraged first).
     * `-1` if position size is zero (inactive).
     */
    adlRank: number;
}
/**
 * Result of `fetchAdlRankedPositions`.
 */
interface AdlRankingResult {
    /** All open (non-zero) user positions, sorted descending by PnLPct, ranked. */
    ranked: AdlRankedPosition[];
    /**
     * Longs ranked separately (adlRank within this subset).
     * Rank 0 = most profitable long = first to be deleveraged on a net-long market.
     */
    longs: AdlRankedPosition[];
    /**
     * Shorts ranked separately (adlRank within this subset).
     * Rank 0 = most profitable short (most negative pnlPct magnitude — i.e., highest
     * unrealised gain for the short-side holder).
     */
    shorts: AdlRankedPosition[];
    /** Whether ADL is currently triggered (pnlPosTot > maxPnlCap). */
    isTriggered: boolean;
    /** pnl_pos_tot from engine state. */
    pnlPosTot: bigint;
    /** max_pnl_cap from market config. */
    maxPnlCap: bigint;
}
/**
 * Check whether ADL is currently triggered on a slab.
 *
 * ADL triggers when pnl_pos_tot > max_pnl_cap (max_pnl_cap must be > 0).
 *
 * @param slabData - Raw slab account bytes.
 * @returns true if ADL is triggered.
 *
 * @example
 * ```ts
 * const data = await fetchSlab(connection, slabKey);
 * if (isAdlTriggered(data)) {
 *   const ranking = await fetchAdlRankedPositions(connection, slabKey);
 * }
 * ```
 */
declare function isAdlTriggered(slabData: Uint8Array): boolean;
/**
 * Fetch a slab and rank all open user positions by PnL% for ADL targeting.
 *
 * Positions are ranked separately per side:
 * - Longs: rank 0 = highest positive PnL% (most profitable long)
 * - Shorts: rank 0 = highest negative PnL% by abs value (most profitable short)
 *
 * Rank ordering matches the on-chain ADL engine in percolator-prog (PERC-8273):
 * the position at rank 0 of the dominant side is deleveraged first.
 *
 * @param connection - Solana connection.
 * @param slab       - Slab (market) public key.
 * @returns AdlRankingResult with ranked longs, ranked shorts, and trigger status.
 *
 * @example
 * ```ts
 * const { ranked, longs, isTriggered } = await fetchAdlRankedPositions(connection, slabKey);
 * if (isTriggered && longs.length > 0) {
 *   const target = longs[0]; // highest PnL long
 *   const ix = buildAdlInstruction(caller, slabKey, oracleKey, programId, target.idx);
 * }
 * ```
 */
declare function fetchAdlRankedPositions(connection: Connection, slab: PublicKey): Promise<AdlRankingResult>;
/**
 * Pure (no-RPC) variant — rank positions from already-fetched slab bytes.
 * Useful when you already have the slab data (e.g., from a subscription).
 */
declare function rankAdlPositions(slabData: Uint8Array): AdlRankingResult;
/**
 * Build a single `ExecuteAdl` TransactionInstruction (tag 50, PERC-305).
 *
 * Does NOT fetch the slab or check trigger status — use `fetchAdlRankedPositions`
 * first to determine the correct `targetIdx`.
 *
 * **Caller requirement:** The on-chain handler requires the caller to be the market
 * admin/keeper authority (`header.admin`). Passing any other signer will result in
 * `EngineUnauthorized`.
 *
 * @param caller     - Signer — must be the market keeper/admin authority.
 * @param slab       - Slab (market) public key.
 * @param oracle     - Primary oracle public key for this market.
 * @param programId  - Percolator program ID.
 * @param targetIdx  - Account index to deleverage (from `AdlRankedPosition.idx`).
 * @param backupOracles - Optional additional oracle accounts (non-Hyperp markets).
 *
 * @example
 * ```ts
 * import { fetchAdlRankedPositions, buildAdlInstruction } from "@percolator/sdk";
 *
 * const { longs, isTriggered } = await fetchAdlRankedPositions(connection, slabKey);
 * if (isTriggered && longs.length > 0) {
 *   const ix = buildAdlInstruction(
 *     caller.publicKey, slabKey, oracleKey, PROGRAM_ID, longs[0].idx
 *   );
 *   await sendAndConfirmTransaction(connection, new Transaction().add(ix), [caller]);
 * }
 * ```
 */
declare function buildAdlInstruction(caller: PublicKey, slab: PublicKey, oracle: PublicKey, programId: PublicKey, targetIdx: number, backupOracles?: PublicKey[]): TransactionInstruction;
/**
 * Convenience builder: fetch slab, rank positions, pick the highest-ranked
 * target on the given side, and return a ready-to-send `TransactionInstruction`.
 *
 * Returns `null` when ADL is not triggered or no eligible positions exist.
 *
 * @param connection    - Solana connection.
 * @param caller        - Signer — must be the market keeper/admin authority.
 * @param slab          - Slab (market) public key.
 * @param oracle        - Primary oracle public key.
 * @param programId     - Percolator program ID.
 * @param preferSide    - Optional: target "long" or "short" side only.
 *                        If omitted, picks the overall top-ranked position.
 * @param backupOracles - Optional extra oracle accounts.
 *
 * @example
 * ```ts
 * const ix = await buildAdlTransaction(
 *   connection, caller.publicKey, slabKey, oracleKey, PROGRAM_ID
 * );
 * if (ix) {
 *   await sendAndConfirmTransaction(connection, new Transaction().add(ix), [caller]);
 * }
 * ```
 */
declare function buildAdlTransaction(connection: Connection, caller: PublicKey, slab: PublicKey, oracle: PublicKey, programId: PublicKey, preferSide?: AdlSide, backupOracles?: PublicKey[]): Promise<TransactionInstruction | null>;
/**
 * Decoded on-chain AdlEvent emitted by the `ExecuteAdl` instruction handler.
 *
 * The on-chain handler emits via `sol_log_64(0xAD1E_0001, target_idx, price, closed_lo, closed_hi)`.
 * `sol_log_64` prints 5 decimal u64 values separated by spaces on a single "Program log:" line.
 *
 * Fields:
 * - `tag`       — always `0xAD1E_0001` (2970353665n)
 * - `targetIdx` — slab account index that was deleveraged
 * - `price`     — oracle price used (in market price units, e.g. e6)
 * - `closedAbs` — absolute size of the position closed (i128, reassembled from lo+hi u64 parts)
 *
 * @example
 * ```ts
 * const logs = tx.meta?.logMessages ?? [];
 * const event = parseAdlEvent(logs);
 * if (event) {
 *   console.log("ADL closed position", event.targetIdx, "size", event.closedAbs);
 * }
 * ```
 */
interface AdlEvent {
    /** Tag discriminator — always 0xAD1E_0001n (2970353665). */
    tag: bigint;
    /** Slab account index that was deleveraged. */
    targetIdx: number;
    /** Oracle price used for the deleverage (market-native units, e.g. lamports/e6). */
    price: bigint;
    /**
     * Absolute position size closed (reassembled from lo+hi u64).
     * This is the i128 absolute value — always non-negative.
     */
    closedAbs: bigint;
}
/**
 * Parse the AdlEvent from a transaction's log messages.
 *
 * Searches for a "Program log: <a> <b> <c> <d> <e>" line where the first
 * decimal value equals `0xAD1E_0001` (2970353665). Returns `null` if not found.
 *
 * @param logs - Array of log message strings (from `tx.meta.logMessages`).
 * @returns Decoded `AdlEvent` or `null` if the log is not present.
 *
 * @example
 * ```ts
 * const event = parseAdlEvent(tx.meta?.logMessages ?? []);
 * if (event) {
 *   console.log(`ADL: idx=${event.targetIdx} price=${event.price} closed=${event.closedAbs}`);
 * }
 * ```
 */
declare function parseAdlEvent(logs: string[]): AdlEvent | null;
/**
 * A single ranked position as returned by the /api/adl/rankings endpoint.
 */
interface AdlApiRanking {
    /** 1-based rank (1 = highest PnL%, first to be deleveraged). */
    rank: number;
    /** Slab account index. Pass as `targetIdx` to `buildAdlInstruction`. */
    idx: number;
    /** Absolute PnL (lamports) as a decimal string. */
    pnlAbs: string;
    /** Capital at entry (lamports) as a decimal string. */
    capital: string;
    /** PnL as millionths of capital (pnl * 1_000_000 / capital). */
    pnlPctMillionths: string;
}
/**
 * Full result from the /api/adl/rankings endpoint.
 */
interface AdlApiResult {
    slabAddress: string;
    /** pnl_pos_tot from slab engine state (decimal string). */
    pnlPosTot: string;
    /** max_pnl_cap from market config (decimal string, "0" if unconfigured). */
    maxPnlCap: string;
    /** Insurance fund balance (decimal string). */
    insuranceFundBalance: string;
    /** Insurance fund lifetime fee revenue (decimal string). */
    insuranceFundFeeRevenue: string;
    /** Insurance utilization in basis points (0–10000). */
    insuranceUtilizationBps: number;
    /** true if pnlPosTot > maxPnlCap. */
    capExceeded: boolean;
    /** true if insurance fund is fully depleted (balance == 0). */
    insuranceDepleted: boolean;
    /** true if utilization BPS exceeds the configured ADL threshold. */
    utilizationTriggered: boolean;
    /** true if ADL is needed (capExceeded or utilizationTriggered). */
    adlNeeded: boolean;
    /** Excess PnL above cap (decimal string). */
    excess: string;
    /** Ranked positions (empty if adlNeeded=false). */
    rankings: AdlApiRanking[];
}
/**
 * Fetch ADL rankings from the Percolator API.
 *
 * Calls `GET <apiBase>/api/adl/rankings?slab=<address>` and returns the
 * parsed result. Use this from the frontend or keeper to determine ADL
 * trigger status and pick the target index.
 *
 * @param apiBase  - Base URL of the Percolator API (e.g. `https://api.percolator.io`).
 * @param slab     - Slab (market) public key or base58 address string.
 * @param fetchFn  - Optional custom fetch implementation (defaults to global `fetch`).
 * @returns Parsed `AdlApiResult`.
 * @throws On HTTP error or JSON parse failure.
 *
 * @example
 * ```ts
 * const result = await fetchAdlRankings("https://api.percolator.io", slabKey);
 * if (result.adlNeeded && result.rankings.length > 0) {
 *   const target = result.rankings[0]; // rank 1 = highest PnL%
 *   const ix = buildAdlInstruction(caller, slabKey, oracleKey, PROGRAM_ID, target.idx);
 * }
 * ```
 */
declare function fetchAdlRankings(apiBase: string, slab: PublicKey | string, fetchFn?: typeof fetch): Promise<AdlApiResult>;

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
 * Dynamic fee tier configuration.
 */
interface FeeTierConfig {
    /** Base trading fee (Tier 1) in bps */
    baseBps: bigint;
    /** Tier 2 fee in bps (0 = disabled) */
    tier2Bps: bigint;
    /** Tier 3 fee in bps (0 = disabled) */
    tier3Bps: bigint;
    /** Notional threshold to enter Tier 2 (0 = tiered fees disabled) */
    tier2Threshold: bigint;
    /** Notional threshold to enter Tier 3 */
    tier3Threshold: bigint;
}
/**
 * Compute the effective fee rate in bps using the tiered fee schedule.
 *
 * Mirrors on-chain `compute_dynamic_fee_bps` logic:
 * - notional < tier2Threshold → baseBps (Tier 1)
 * - notional < tier3Threshold → tier2Bps (Tier 2)
 * - notional >= tier3Threshold → tier3Bps (Tier 3)
 *
 * If tier2Threshold == 0, tiered fees are disabled (flat baseBps).
 */
declare function computeDynamicFeeBps(notional: bigint, config: FeeTierConfig): bigint;
/**
 * Compute the dynamic trading fee for a given notional and tier config.
 *
 * Uses ceiling division to match on-chain behavior (prevents fee evasion
 * via micro-trades).
 */
declare function computeDynamicTradingFee(notional: bigint, config: FeeTierConfig): bigint;
/**
 * Fee split configuration.
 */
interface FeeSplitConfig {
    /** LP vault share in bps (0–10_000) */
    lpBps: bigint;
    /** Protocol treasury share in bps */
    protocolBps: bigint;
    /** Market creator share in bps */
    creatorBps: bigint;
}
/**
 * Compute fee split for a total fee amount.
 *
 * Returns [lpShare, protocolShare, creatorShare].
 * If all split params are 0, 100% goes to LP (legacy behavior).
 * Creator gets the rounding remainder to ensure total is preserved.
 */
declare function computeFeeSplit(totalFee: bigint, config: FeeSplitConfig): [bigint, bigint, bigint];
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
 *
 * @throws Error if initialMarginBps is zero (infinite leverage is undefined)
 */
declare function computeMaxLeverage(initialMarginBps: bigint): number;

/**
 * Warmup leverage cap utilities.
 *
 * During the market warmup period, capital is released linearly over
 * `warmupPeriodSlots` slots, which constrains the effective leverage
 * and maximum position size available to traders.
 */
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
/** Options for {@link resolvePrice}. */
interface ResolvePriceOptions {
    timeoutMs?: number;
}
declare const PYTH_SOLANA_FEEDS: Record<string, {
    symbol: string;
    mint: string;
}>;
declare function resolvePrice(mint: string, signal?: AbortSignal, options?: ResolvePriceOptions): Promise<PriceRouterResult>;

export { ACCOUNTS_ADVANCE_ORACLE_PHASE, ACCOUNTS_AUDIT_CRANK, ACCOUNTS_BURN_POSITION_NFT, ACCOUNTS_CANCEL_QUEUED_WITHDRAWAL, ACCOUNTS_CLAIM_QUEUED_WITHDRAWAL, ACCOUNTS_CLEAR_PENDING_SETTLEMENT, ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_CLOSE_SLAB, ACCOUNTS_CLOSE_STALE_SLABS, ACCOUNTS_CREATE_INSURANCE_MINT, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_DEPOSIT_INSURANCE_LP, ACCOUNTS_EXECUTE_ADL, ACCOUNTS_FUND_MARKET_INSURANCE, ACCOUNTS_INIT_LP, ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_MATCHER_CTX, ACCOUNTS_INIT_USER, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_LIQUIDATE_AT_ORACLE, ACCOUNTS_LP_VAULT_WITHDRAW, ACCOUNTS_MINT_POSITION_NFT, ACCOUNTS_PAUSE_MARKET, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_QUEUE_WITHDRAWAL, ACCOUNTS_RECLAIM_SLAB_RENT, ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_SET_DEX_POOL, ACCOUNTS_SET_INSURANCE_ISOLATION, ACCOUNTS_SET_MAINTENANCE_FEE, ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK, ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_SET_ORACLE_PRICE_CAP, ACCOUNTS_SET_PENDING_SETTLEMENT, ACCOUNTS_SET_RISK_THRESHOLD, ACCOUNTS_SET_WALLET_CAP, ACCOUNTS_TOPUP_INSURANCE, ACCOUNTS_TOPUP_KEEPER_FUND, ACCOUNTS_TRADE_CPI, ACCOUNTS_TRADE_NOCPI, ACCOUNTS_TRANSFER_POSITION_OWNERSHIP, ACCOUNTS_UNPAUSE_MARKET, ACCOUNTS_UPDATE_ADMIN, ACCOUNTS_UPDATE_CONFIG, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_WITHDRAW_INSURANCE, ACCOUNTS_WITHDRAW_INSURANCE_LP, type Account, AccountKind, type AccountSpec, type AdlApiRanking, type AdlApiResult, type AdlEvent, type AdlRankedPosition, type AdlRankingResult, type AdlSide, type AdminForceCloseArgs, type AllocateMarketArgs, type ApiMarketEntry, type BuildIxParams, type BurnPositionNftArgs, CHAINLINK_ANSWER_OFFSET, CHAINLINK_DECIMALS_OFFSET, CHAINLINK_MIN_SIZE, CREATOR_LOCK_SEED, CTX_VAMM_OFFSET, type ClearPendingSettlementArgs, type CloseAccountArgs, DEFAULT_OI_RAMP_SLOTS, type DepositCollateralArgs, type DexPoolInfo, type DexType, type DiscoverMarketsOptions, type DiscoverMarketsViaApiOptions, type DiscoverMarketsViaStaticBundleOptions, type DiscoveredMarket, ENGINE_MARK_PRICE_OFF, ENGINE_OFF, type EngineState, type ExecuteAdlArgs, type FeeSplitConfig, type FeeTierConfig, type GetMarketsByAddressOptions, IX_TAG, type InitLPArgs, type InitMarketArgs, type InitMatcherCtxArgs, type InitSharedVaultArgs, type InitUserArgs, type InsuranceFund, type KeeperCrankArgs, type LiquidateAtOracleArgs, type LpVaultWithdrawArgs, MARK_PRICE_EMA_ALPHA_E6, MARK_PRICE_EMA_WINDOW_SLOTS, MAX_DECIMALS, MAX_ORACLE_PRICE, METEORA_DLMM_PROGRAM_ID, type MarketConfig, type MintPositionNftArgs, type Network, ORACLE_PHASE_GROWING, ORACLE_PHASE_MATURE, ORACLE_PHASE_NASCENT, type OraclePrice, PERCOLATOR_ERRORS, PHASE1_MIN_SLOTS, PHASE1_VOLUME_MIN_SLOTS, PHASE2_MATURITY_SLOTS, PHASE2_VOLUME_THRESHOLD, PROGRAM_IDS, PUMPSWAP_PROGRAM_ID, PYTH_PUSH_ORACLE_PROGRAM_ID, PYTH_RECEIVER_PROGRAM_ID, PYTH_SOLANA_FEEDS, type PriceRouterResult, type PriceSource, type PriceSourceType, type PushOraclePriceArgs, type QueueWithdrawalSVArgs, RAMP_START_BPS, RAYDIUM_CLMM_PROGRAM_ID, RENOUNCE_ADMIN_CONFIRMATION, type ResolvePriceOptions, type RiskParams, SLAB_TIERS, SLAB_TIERS_V0, SLAB_TIERS_V1, SLAB_TIERS_V12_1, SLAB_TIERS_V1D, SLAB_TIERS_V1D_LEGACY, SLAB_TIERS_V1M, SLAB_TIERS_V1M2, SLAB_TIERS_V2, SLAB_TIERS_V_ADL, SLAB_TIERS_V_ADL_DISCOVERY, SLAB_TIERS_V_SETDEXPOOL, STAKE_IX, STAKE_POOL_SIZE, STAKE_PROGRAM_ID, STAKE_PROGRAM_IDS, type SetInsuranceWithdrawPolicyArgs, type SetMaintenanceFeeArgs, type SetOracleAuthorityArgs, type SetOraclePriceCapArgs, type SetPendingSettlementArgs, type SetPythOracleArgs, type SetRiskThresholdArgs, type SetWalletCapArgs, type SimulateOrSendParams, type SlabHeader, type SlabLayout, type SlabTierKey, type StakeAccounts, type StakePoolState, type StaticMarketEntry, TOKEN_2022_PROGRAM_ID, type TopUpInsuranceArgs, type TopUpKeeperFundArgs, type TradeCpiArgs, type TradeCpiV2Args, type TradeNoCpiArgs, type TransferOwnershipCpiArgs, type TransferPositionOwnershipArgs, type TxResult, UNRESOLVE_CONFIRMATION, type UpdateAdminArgs, type UpdateConfigArgs, type UpdateRiskParamsArgs, VAMM_MAGIC, ValidationError, type VammMatcherParams, WELL_KNOWN, type WithdrawCollateralArgs, buildAccountMetas, buildAdlInstruction, buildAdlTransaction, buildIx, checkPhaseTransition, clearStaticMarkets, computeDexSpotPriceE6, computeDynamicFeeBps, computeDynamicTradingFee, computeEffectiveOiCapBps, computeEmaMarkPrice, computeEstimatedEntryPrice, computeFeeSplit, computeFundingRateAnnualized, computeLiqPrice, computeMarkPnl, computeMaxLeverage, computePnlPercent, computePreTradeLiqPrice, computeRequiredMargin, computeTradingFee, computeVammQuote, computeWarmupLeverageCap, computeWarmupMaxPositionSize, computeWarmupUnlockedCapital, concatBytes, decodeError, decodeStakePool, depositAccounts, deriveCreatorLockPda, deriveDepositPda, deriveInsuranceLpMint, deriveKeeperFund, deriveLpPda, derivePythPriceUpdateAccount, derivePythPushOraclePDA, deriveStakePool, deriveStakeVaultAuth, deriveVaultAuthority, detectDexType, detectLayout, detectSlabLayout, detectTokenProgram, discoverMarkets, discoverMarketsViaApi, discoverMarketsViaStaticBundle, encBool, encI128, encI64, encPubkey, encU128, encU16, encU32, encU64, encU8, encodeAdminForceClose, encodeAdvanceEpoch, encodeAdvanceOraclePhase, encodeAllocateMarket, encodeAttestCrossMargin, encodeAuditCrank, encodeBurnPositionNft, encodeCancelQueuedWithdrawal, encodeChallengeSettlement, encodeClaimEpochWithdrawal, encodeClaimQueuedWithdrawal, encodeClearPendingSettlement, encodeCloseAccount, encodeCloseKeeperFund, encodeCloseOrphanSlab, encodeCloseSlab, encodeCloseStaleSlabs, encodeCreateInsuranceMint, encodeCreateLpVault, encodeDepositCollateral, encodeDepositInsuranceLP, encodeDepositLpCollateral, encodeExecuteAdl, encodeForceCloseResolved, encodeFundMarketInsurance, encodeInitLP, encodeInitMarket, encodeInitMatcherCtx, encodeInitSharedVault, encodeInitUser, encodeKeeperCrank, encodeLiquidateAtOracle, encodeLpVaultCrankFees, encodeLpVaultDeposit, encodeLpVaultWithdraw, encodeMintPositionNft, encodePauseMarket, encodePushOraclePrice, encodeQueueWithdrawal, encodeQueueWithdrawalSV, encodeReclaimSlabRent, encodeRenounceAdmin, encodeRescueOrphanVault, encodeResolveDispute, encodeResolveMarket, encodeResolvePermissionless, encodeSetDexPool, encodeSetInsuranceIsolation, encodeSetInsuranceWithdrawPolicy, encodeSetMaintenanceFee, encodeSetOffsetPair, encodeSetOiImbalanceHardBlock, encodeSetOracleAuthority, encodeSetOraclePriceCap, encodeSetPendingSettlement, encodeSetPythOracle, encodeSetRiskThreshold, encodeSetWalletCap, encodeSlashCreationDeposit, encodeStakeAccrueFees, encodeStakeAdminResolveMarket, encodeStakeAdminSetHwmConfig, encodeStakeAdminSetInsurancePolicy, encodeStakeAdminSetMaintenanceFee, encodeStakeAdminSetOracleAuthority, encodeStakeAdminSetRiskThreshold, encodeStakeAdminSetTrancheConfig, encodeStakeAdminWithdrawInsurance, encodeStakeDeposit, encodeStakeDepositJunior, encodeStakeFlushToInsurance, encodeStakeInitPool, encodeStakeInitTradingPool, encodeStakeTransferAdmin, encodeStakeUpdateConfig, encodeStakeWithdraw, encodeTopUpInsurance, encodeTopUpKeeperFund, encodeTradeCpi, encodeTradeCpiV2, encodeTradeNoCpi, encodeTransferOwnershipCpi, encodeTransferPositionOwnership, encodeUnpauseMarket, encodeUpdateAdmin, encodeUpdateConfig, encodeUpdateHyperpMark, encodeUpdateMarkPrice, encodeUpdateRiskParams, encodeWithdrawCollateral, encodeWithdrawInsurance, encodeWithdrawInsuranceLP, encodeWithdrawInsuranceLimited, encodeWithdrawLpCollateral, fetchAdlRankedPositions, fetchAdlRankings, fetchSlab, fetchTokenAccount, flushToInsuranceAccounts, formatResult, getAta, getAtaSync, getCurrentNetwork, getErrorHint, getErrorName, getMarketsByAddress, getMatcherProgramId, getProgramId, getStakeProgramId, getStaticMarkets, initPoolAccounts, isAccountUsed, isAdlTriggered, isStandardToken, isToken2022, isValidChainlinkOracle, maxAccountIndex, parseAccount, parseAdlEvent, parseAllAccounts, parseChainlinkPrice, parseConfig, parseDexPool, parseEngine, parseErrorFromLogs, parseHeader, parseParams, parseUsedIndices, rankAdlPositions, readLastThrUpdateSlot, readNonce, registerStaticMarkets, resolvePrice, safeEnv, simulateOrSend, slabDataSize, slabDataSizeV1, validateAmount, validateBps, validateI128, validateI64, validateIndex, validatePublicKey, validateSlabTierMatch, validateU128, validateU16, validateU64, withdrawAccounts };
