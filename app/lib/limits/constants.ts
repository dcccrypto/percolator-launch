/**
 * Single source of every on-chain number the limits UI reads: byte offsets,
 * instruction tags and error ordinals for P1 (wrapper safety release), P2
 * (matcher v2) and P3 (vault-owned LP). Nothing else in the app writes one of
 * these inline — import from here.
 *
 * Provenance (read from BRANCH SOURCE, never the SDK types; see
 * ~/percolator-ops/ledger/frontend-limits-plan-2026-09-30.md §1):
 *   - engine/wrapper layout: `examples/dump_layout.rs` on
 *     `deploy/v18.2-wrapper@6377376a` + engine `35ddd692` (P1 asserts no layout change);
 *   - P1: `percolator-prog feat/p1-safety-release@e74809b1` `src/v16_program.rs`
 *     (`ASSET_RISK_LIMITS_OFF` :376, `AssetRiskLimitsV17` :2370, `risk_limits_v17` :9212,
 *     errors :1125-1142, tag 93 :385);
 *   - P2: `percolator-match feat/p2-matcher-v2@4a0f696` `src/vamm.rs` `MatcherCtx` :89,
 *     `src/v2.rs` V2Block :257 / errors :32-39;
 *   - P3: `percolator-prog feat/p3-vault-owned-lp@c7437518` (`ASSET_VAULT_LP_OFF` :381,
 *     `VaultLpStateV18` :5470, `AssetVaultLpV18` :5573, errors :1148-1166).
 *
 * P3 numbers are read from `feat/p3-vault-owned-lp@0be66041`, which is REBASED
 * onto P1 (tags 94..102, errors 72..85 appended after P1's 71; ordinals computed
 * by parsing the enum). P3 is still in review, so they stay keyed BY NAME.
 *
 * Round 4: every P1/P3 number here is re-verified at the FINAL combined head
 * `feat/p3-vault-owned-lp@07a1d0eb` (auto-pin at tag 94; P1 `3acb34ae`, engine `35ddd692`) through the REAL
 * crate — `app/scripts/limits-parity/p3-final` (errors by name, offset_of!, the program's
 * own readers) and the layout / parity emitters, all byte-identical to the fixtures.
 */
import { WRAPPER_ERR } from "../wrapper-errors";


// ── Shared layout ────────────────────────────────────────────────────────────
export const HEADER_LEN = 16;
/** Account header: magic u64 @0, version u16 @8, kind u8 @10 (wrapper `write_header`). */
export const HEADER_KIND_OFF = 10;
/** Wrapper header (v16_program.rs :46/:72): magic "PERCV16\0" (u64 LE @0), version u16 @8 = 18. */
export const WRAPPER_MAGIC = 0x5045_5243_5631_3600n;
export const WRAPPER_VERSION_V18 = 18;
export const KIND_MARKET_ACCOUNT = 1;
export const KIND_PORTFOLIO = 2;
export const MARKET_GROUP_OFF = 592;
export const MARKET_GROUP_LEN = 758;
/** `Market { wrapper: [u8; 1024], engine: EngineAssetSlotV16Account (1301) }`. */
export const MARKET_ASSET_SLOT_LEN = 2325;
export const ASSET_WRAPPER_LEN = 1024;
/** Asset-slot base (wrapper bytes) for asset `i`. */
export const assetWrapperOff = (i: number): number =>
  MARKET_GROUP_OFF + MARKET_GROUP_LEN + i * MARKET_ASSET_SLOT_LEN;
/** Engine asset-slot base for asset `i`. */
export const assetEngineOff = (i: number): number => assetWrapperOff(i) + ASSET_WRAPPER_LEN;

/** MarketGroupV16HeaderAccount (relative to MARKET_GROUP_OFF). */
export const H_CONFIG = 32;
export const H_CURRENT_SLOT = 613;
export const H_MODE = 626;
/** V16ConfigAccount (relative to the config start = MARKET_GROUP_OFF + H_CONFIG), packed. */
export const CFG_MAINTENANCE_MARGIN_BPS = 54;
export const CFG_INITIAL_MARGIN_BPS = 62;
export const CFG_MAX_TRADING_FEE_BPS = 70; // u64
export const CFG_MAX_ABS_FUNDING_E9_PER_SLOT = 126;
/** WrapperConfigV16 (relative to HEADER_LEN). */
export const WCFG_TRADE_FEE_BASE_BPS = 128;
/** LP fee leg claim (rustc offset_of!, deployed 6377376a; identical on the P3 tree). */
export const WCFG_LP_FEE_ACCRUED_ATOMS = 496; // u128
export const WCFG_LP_FEE_WITHDRAWN_ATOMS = 512; // u128

/** MarketGroupV16HeaderAccount money/epoch fields (relative to MARKET_GROUP_OFF; rustc offset_of!). */
export const H_VAULT = 285; // u128
export const H_INSURANCE = 301; // u128
export const H_SOURCE_INSURANCE_CREDIT_RESERVED_TOTAL = 445; // u128
export const H_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL = 461; // u128
export const H_RISK_EPOCH = 549; // u64
export const H_ASSET_SET_EPOCH = 557; // u64
export const H_ORACLE_EPOCH = 589; // u64
export const H_FUNDING_EPOCH = 597; // u64

/** AssetStateV16Account (relative to the engine slot base). */
export const A_MARKET_ID = 0;
/** `raw_oracle_target_price` (u64): the price the engine is catching up TO (engine v16.rs AssetStateV16Account, packed). */
export const A_RAW_ORACLE_TARGET_PRICE = 17;
export const A_EFFECTIVE_PRICE = 25;
/** ADL side factors (u128; dump_layout AssetStateV16Account a_long @49, a_short @65). */
export const A_A_LONG = 49;
export const A_A_SHORT = 65;
/** engine lib.rs:16 `ADL_ONE` (1e15). While either side's A != ADL_ONE the asset is reduce-only. */
export const ADL_ONE = 1_000_000_000_000_000n;
/** Wrapper tag 44 RebalanceReduce (deployed 6377376a decode arm :6776, handler :17853). */
export const TAG_REBALANCE_REDUCE = 44;
export const REBALANCE_REDUCE_DATA_LEN = 35;
export const A_OI_EFF_LONG_Q = 289;
export const A_OI_EFF_SHORT_Q = 305;
/** Side reset epochs (u64; AssetStateV16Account epoch_long @497, epoch_short @505 — just before mode_long). */
export const A_EPOCH_LONG = 497;
export const A_EPOCH_SHORT = 505;
export const A_MODE_LONG = 513;
export const A_MODE_SHORT = 514;

/** Portfolio (absolute = HEADER_LEN + PortfolioAccountV16Account offset). */
export const PF_OWNER = HEADER_LEN + 100;
export const PF_CAPITAL = HEADER_LEN + 132;
export const PF_PNL = HEADER_LEN + 148;
export const PF_FEE_CREDITS = HEADER_LEN + 292;
export const PF_ACTIVE_BITMAP = HEADER_LEN + 332; // [u64; 1]
export const PF_LEGS = HEADER_LEN + 340;
export const PF_HEALTH_CERT = HEADER_LEN + 9044; // HealthCertV16Account (121 B)
export const PF_STALE_STATE = HEADER_LEN + 9165; // u8
export const PF_B_STALE_STATE = HEADER_LEN + 9166; // u8
/** HealthCertV16Account (packed; rustc offset_of!). */
export const CERT_EQUITY = 0; // i128
export const CERT_ORACLE_EPOCH = 80;
export const CERT_FUNDING_EPOCH = 88;
export const CERT_RISK_EPOCH = 96;
export const CERT_ASSET_SET_EPOCH = 104;
export const CERT_ACTIVE_BITMAP = 112; // [u64; 1]
export const CERT_VALID = 120; // u8 bool
export const PF_LEG_LEN = 152;
export const PF_MAX_LEGS = 16;
/** PortfolioLegV16Account (packed). */
export const LEG_ACTIVE = 0;
export const LEG_ASSET_INDEX = 1;
export const LEG_MARKET_ID = 5;
export const LEG_SIDE = 13; // 0 Long, 1 Short (engine encode_side)
export const LEG_BASIS_POS_Q = 14;
/** u128 ADL index snapshot (SDK parsePortfolioV17 `aBasis`, leg +30). */
export const LEG_A_BASIS = 30;
/** u64 side-epoch snapshot (SDK parsePortfolioV17 `epochSnap`, leg +86). */
export const LEG_EPOCH_SNAP = 86;

/** Engine constants (percolator/src/lib.rs). */
export const POS_SCALE = 1_000_000n;
export const MAX_OI_SIDE_Q = 100_000_000_000_000n;
export const BPS = 10_000n;
/** ~400 ms slots. Display only (per-hour funding). */
export const SLOTS_PER_HOUR = 9_000n;

// ── P1: AssetRiskLimitsV17 (64 B) at wrapper-slot offset 608 ─────────────────
export const ASSET_RISK_LIMITS_OFF = 608;
export const ASSET_RISK_LIMITS_LEN = 64;
export const RL_SIDE_OI_CAP_Q = 0; //        u128
export const RL_LP_FLOOR_ATOMS = 16; //      u128
export const RL_LP_EXPOSURE_K_BPS = 32; //   u32
export const RL_EXEC_BAND_BPS = 36; //       u16
export const RL_MATCHER_EXT_MODE = 38; //    u8
export const RL_RESERVED0 = 39; //           u8, must be 0
/** P1 e74809b1: P2 fee channel protocol max (0 = channel OFF). Only effective with ext mode 1. */
export const RL_MAX_REQUESTED_FEE_BPS = 40; // u16
export const RL_RESERVED = 42; //            [u8; 22], must be 0
export const RL_RESERVED_LEN = 22;
export const MAX_REQUESTED_FEE_BPS = 1023;
export const DEFAULT_EXEC_BAND_BPS = 500;
export const MAX_EXEC_BAND_BPS = 10_000;
export const MAX_LP_EXPOSURE_K_BPS = 10_000_000;
export const MATCHER_EXT_MODE_V1 = 1;
export const TAG_SET_ASSET_RISK_LIMITS = 93;

/** P1 wrapper errors (append-only after AssetGenerationMismatch = 65). */
export const P1_ERR = {
  ExecPriceOutsideOracleBand: WRAPPER_ERR.ExecPriceOutsideOracleBand,
  SameOwnerTrade: WRAPPER_ERR.SameOwnerTrade,
  LpExposureCapExceeded: WRAPPER_ERR.LpExposureCapExceeded,
  LpFloorHalt: WRAPPER_ERR.LpFloorHalt,
  ProtocolSideOiCapExceeded: WRAPPER_ERR.ProtocolSideOiCapExceeded,
  CloseSlabFeesOutstanding: WRAPPER_ERR.CloseSlabFeesOutstanding,
} as const;

// ── P2: matcher context (vAMM ctx starts at 64 = MATCHER_RETURN_LEN) ────────
export const CTX_VAMM_OFFSET = 64;
export const MC_KIND = CTX_VAMM_OFFSET + 12; //                u8: 0 passive, 1 vAMM, 2 adaptive
export const MC_TRADING_FEE_BPS = CTX_VAMM_OFFSET + 48; //     u32
export const MC_BASE_SPREAD_BPS = CTX_VAMM_OFFSET + 52; //     u32
export const MC_MAX_TOTAL_BPS = CTX_VAMM_OFFSET + 56; //       u32
export const MC_IMPACT_K_BPS = CTX_VAMM_OFFSET + 60; //        u32
export const MC_LIQUIDITY_NOTIONAL_E6 = CTX_VAMM_OFFSET + 64; // u128
export const MC_MAX_FILL_ABS = CTX_VAMM_OFFSET + 80; //        u128
export const MC_INVENTORY_BASE = CTX_VAMM_OFFSET + 96; //      i128 (LP position; taker buy => decreases)
export const MC_MAX_INVENTORY_ABS = CTX_VAMM_OFFSET + 128; //  u128
export const MC_FEE_TO_INSURANCE_BPS = CTX_VAMM_OFFSET + 152; // u16 (vamm.rs layout)
export const MC_SKEW_SPREAD_MULT_BPS = CTX_VAMM_OFFSET + 154; // u16
/** V2 block: MatcherCtx._reserved (ctx offset 178), 78 bytes. */
export const MC_V2_BLOCK = CTX_VAMM_OFFSET + 178;
export const V2_BLOCK_LEN = 78;
export const V2_BLOCK_VERSION = 1;
export const V2 = {
  version: 0,
  flags: 1,
  feeLoBps: 2,
  feeHiBps: 4,
  feeColdBps: 6,
  volAMilli: 8,
  volBDen: 10,
  volAlphaBps: 12,
  volWarmupLeft: 14,
  volMoveCap10bps: 15,
  volRefSlots: 16,
  thinRebateMultBps: 18,
  skewCapBps: 20,
  rebateCapBps: 22,
  maxMarkAgeSlots: 24,
  observedStaleSlots: 26,
  boundAssetPlus1: 28,
  skewRefInventory: 30,
  volVarE4: 38,
  volLastPriceE6: 46,
  volLastSlot: 54,
} as const;
export const MATCHER_KIND = { passive: 0, vamm: 1, adaptive: 2 } as const;
/** Matcher program errors (percolator-match src/v2.rs). */
export const P2_ERR = {
  ERR_STALE_MARK: 8002,
  ERR_MARK_SLOT_IN_FUTURE: 8003,
  ERR_ASSET_MISMATCH: 8004,
  ERR_OWNER_PROOF_MISMATCH: 8005,
} as const;

// ── P3 (PROVISIONAL numbers, see header) ─────────────────────────────────────
export const ASSET_VAULT_LP_OFF = 896;
export const ASSET_VAULT_LP_LEN = 128;
export const AV_VAULT_LP_PORTFOLIO = 0; // [u8;32]
export const AV_LP_NET_Q = 32; //          i128
export const AV_LEV_CAP_Q = 48; //         u128
export const AV_LP_NET_SLOT = 64; //       u64
export const AV_SKEW_SLOPE_E9 = 72; //     u64
export const AV_SKEW_MAX_E9 = 80; //       u64
export const AV_LEV_MAX_IMR_BPS = 88; //   u16
export const AV_FLAGS = 90; //             u8, bit0 bound
export const AV_RESERVED0 = 91; //         u8, must be 0
export const AV_VAULT_LP_MAX_LEV_BPS = 92; // u32 (P3-H2; 0 = default 1x)
export const AV_APPROVED_MATCHER_PROGRAM = 96; // [u8;32] (P3-H2)
export const ASSET_VAULT_LP_FLAG_BOUND = 1;
export const VAULT_LP_DEFAULT_MAX_LEV_BPS = 10_000;
export const VAULT_LP_MAX_LEV_BPS = 50_000;

export const VAULT_LP_STATE_SEED = "vault_lp";
/** LpVaultRegistryV16 PDA `["lp_vault", market]` (wrapper LP_VAULT_REGISTRY_SEED); kind 5; 16 + 160 B. */
export const LP_VAULT_REGISTRY_SEED = "lp_vault";
export const KIND_LP_VAULT_REGISTRY = 5;
export const LP_VAULT_REGISTRY_ACCOUNT_LEN = HEADER_LEN + 160;
/** `total_lp_shares_outstanding` u128 at struct 64..80 => absolute 80. The share count EVERY
 *  Earn price/gate uses on-chain (tags 75/77), NOT the LP mint supply. */
export const REG_TOTAL_LP_SHARES_OUTSTANDING = HEADER_LEN + 64;
export const KIND_VAULT_LP_STATE = 9;
export const VAULT_LP_STATE_VERSION = 1;
/** VaultLpStateV18 is at HEADER_LEN; these are absolute account offsets. */
export const VS = {
  marketGroup: HEADER_LEN + 0,
  registry: HEADER_LEN + 32,
  lpPortfolio: HEADER_LEN + 64,
  juniorOwner: HEADER_LEN + 96,
  seniorClaimAtoms: HEADER_LEN + 128,
  juniorDepositedAtoms: HEADER_LEN + 144,
  juniorWithdrawnAtoms: HEADER_LEN + 160,
  seniorFeeCreditedAtoms: HEADER_LEN + 176,
  recalledAtoms: HEADER_LEN + 192,
  assetIndex: HEADER_LEN + 208,
  juniorFloorBps: HEADER_LEN + 210,
  seniorFeeShareBps: HEADER_LEN + 212,
  version: HEADER_LEN + 214,
  /** d119eebd senior draw: cumulative senior backing moved into the vault LP (junior cover excluded). */
  seniorDrawnAtoms: HEADER_LEN + 224,
  /** d119eebd senior draw: senior loss still outstanding (C was cut by it; restored first on recovery). */
  seniorDrawOutstandingAtoms: HEADER_LEN + 240,
} as const;
export const VAULT_LP_STATE_ACCOUNT_LEN = HEADER_LEN + 256;
export const VAULT_LP_MIN_JUNIOR_FLOOR_BPS = 1_000;

/** P3 tags (FINAL head 07a1d0eb; re-verified against the real `ix::Instruction::decode`,
 *  fixture `rust-p3-final.json`). Sent by `lib/limits/p3-ix.ts`. */
export const P3_TAG = {
  InitVaultLp: 94,
  VaultLpSetMatcher: 95,
  DepositJuniorTranche: 96,
  WithdrawJuniorTranche: 97,
  VaultLpRecall: 98,
  SetVaultLpRisk: 99,
  VaultLpConvertPnl: 100,
  VaultLpSettleResolved: 101,
  VaultLpReleaseSurplus: 102,
} as const;

/** P3 wrapper errors: ordinals parsed from the enum at 8d651c45 (appended after P1's 71). Map BY NAME. */
export const P3_ERR = {
  VaultLpAlreadyBound: WRAPPER_ERR.VaultLpAlreadyBound,
  VaultLpNotBound: WRAPPER_ERR.VaultLpNotBound,
  VaultLpSeniorImpaired: WRAPPER_ERR.VaultLpSeniorImpaired,
  VaultLpJuniorWithdrawRefused: WRAPPER_ERR.VaultLpJuniorWithdrawRefused,
  VaultLpRecallRefused: WRAPPER_ERR.VaultLpRecallRefused,
  VaultLpExclusiveCounterparty: WRAPPER_ERR.VaultLpExclusiveCounterparty,
  VaultLpLeverageStepDown: WRAPPER_ERR.VaultLpLeverageStepDown,
  VaultLpBoundCannotClose: WRAPPER_ERR.VaultLpBoundCannotClose,
  VaultLpExposureCapExceeded: WRAPPER_ERR.VaultLpExposureCapExceeded,
  VaultLpMatcherNotApproved: WRAPPER_ERR.VaultLpMatcherNotApproved,
  VaultLpUseSettleResolved: WRAPPER_ERR.VaultLpUseSettleResolved,
  VaultLpReleaseRefused: WRAPPER_ERR.VaultLpReleaseRefused,
  VaultLpHarvestPending: WRAPPER_ERR.VaultLpHarvestPending,
  VaultLpValuationStale: WRAPPER_ERR.VaultLpValuationStale,
  /** F14-Q2 (58e379f1): tag 94 refuses a market whose configured asset slots != 1. */
  VaultLpMultiAssetMarket: WRAPPER_ERR.VaultLpMultiAssetMarket,
  /** d119eebd: 75/77 found an undrawn deficit on the vault LP (the draw must run first: crank, retry). */
  VaultLpSeniorDrawRequired: WRAPPER_ERR.VaultLpSeniorDrawRequired,
  /** d119eebd (B24): the redemption's pot can't fund the payout; recall (98) first, or redeem fewer shares. */
  VaultLpRedeemNeedsRecall: WRAPPER_ERR.VaultLpRedeemNeedsRecall,
  /** 4b1a5d30: a senior draw is outstanding; LP risk-increasing fills, 97, 102 and 98 are paused. */
  VaultLpPausedForSeniorDraw: WRAPPER_ERR.VaultLpPausedForSeniorDraw,
  /** 592286b4 (relaunch): tag 94 refuses a bind once the asset has open interest (bind at creation). */
  VaultLpBindRequiresFlatAsset: WRAPPER_ERR.VaultLpBindRequiresFlatAsset,
} as const;

// ── P3 end-to-end (round 4; FINAL feat/p3-vault-owned-lp@07a1d0eb + engine 35ddd692) ────────
/** `LpVaultRegistryV16._reserved[0]` (struct 144) = 1 when a vault LP is bound => absolute 160.
 *  Every bound-vault Earn handler then REQUIRES the vault-LP tail accounts (fail closed). */
export const REG_VAULT_LP_BOUND_FLAG = HEADER_LEN + 144;
/** Tail indices on a BOUND vault (handler `load_bound_vault_lp_tail(.., idx, need_lp)`):
 *  75 DepositToLpVault [11] vault_lp_state(w) + [12] lp; 77 ExecuteRedemption [13] + [14];
 *  78 LpVaultCrankFees [6] vault_lp_state(w) only; 76 RequestRedeem has none. */
export const BOUND_TAIL_INDEX = { 75: 11, 77: 13, 78: 6 } as const;
export const TAG_CLOSE_PORTFOLIO = 8;
export const TAG_CLOSE_RESOLVED = 30;
export const TAG_CLAIM_RESOLVED_PAYOUT_TOPUP = 46;
export const TAG_DEPOSIT_TO_LP_VAULT = 75;
export const TAG_REQUEST_REDEEM_LP_SHARES = 76;
export const TAG_EXECUTE_REDEMPTION = 77;
export const TAG_LP_VAULT_CRANK_FEES = 78;
/** NftRegistry PDA `["nft_registry", market_group]`: the unsigned-caller proof at account [7]
 *  of tags 30/46 that a portfolio is NOT NFT-escrowed (GH#496). */
export const NFT_REGISTRY_SEED = "nft_registry";
/** Engine header (`MarketGroupV16HeaderAccount`, relative to MARKET_GROUP_OFF like every H_*),
 *  rustc offset_of! on engine 35ddd692 (fixture rust-p3-final.json). */
export const H_C_TOT = 317; // u128: total trader capital; Resolved Earn redemption needs 0
export const H_MATERIALIZED_PORTFOLIO_COUNT = 517; // u64: Resolved Earn redemption needs 0
export const H_RESOLVED_SLOT = 627; // u64
export const MARKET_MODE_LIVE = 0;
export const MARKET_MODE_RESOLVED = 1;
/** WrapperConfigV16.force_close_delay_slots (relative to HEADER_LEN like WCFG_*): until
 *  resolved_slot + delay, tags 30 / 101-close are owner-only; after it, permissionless. */
export const WCFG_FORCE_CLOSE_DELAY_SLOTS = 144;
/** Portfolio fields for the resolved-exit planner (absolute; engine `PortfolioAccountV16Account`). */
export const PF_RESERVED_PNL = HEADER_LEN + 164; // u128
export const PF_CANCEL_DEPOSIT_ESCROW = HEADER_LEN + 308; // u128
export const PF_REBALANCE_LOCK = HEADER_LEN + 9167; // u8
export const PF_LIQUIDATION_LOCK = HEADER_LEN + 9168; // u8
export const PF_RESOLVED_PAYOUT_RECEIPT = HEADER_LEN + 9353; // ResolvedPayoutReceiptV16Account
export const RECEIPT_PRESENT = 64; // u8 bool
export const RECEIPT_FINALIZED = 65; // u8 bool
/** LpVaultRegistryV16.domain u16 (struct 132) => absolute 148. */
export const REG_DOMAIN = HEADER_LEN + 132;
export const VAULT_LP_MAX_JUNIOR_FLOOR_BPS = 10_000;

// ── P3 auto-pin (FINAL feat/p3-vault-owned-lp@07a1d0eb) ───────────────────────────────────────
/** `constants::CANONICAL_VAULT_LP_MATCHER_PROGRAM` (devnet build): tag 94 accepts ONLY this at
 *  [8] (else VaultLpMatcherNotApproved 81) and pins it; there is no mainnet arm yet (fails closed). */
export const CANONICAL_VAULT_LP_MATCHER_PROGRAM_DEVNET = "EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX";
/** The matcher ctx tag 94 initialises: pre-created by the client, owner = the matcher program,
 *  zeroed; the wizard's existing size (the wrapper's own floor is 64 B). */
export const VAULT_LP_MATCHER_CTX_LEN = 320;
export const MATCHER_DELEGATE_SEED = "matcher";
/** `vault_lp_v18::PIN_*` (07a1d0eb): the protocol's vAMM pin, shown to the creator (read-only). */
export const PIN = { kind: 1, tradingFeeBps: 10, baseSpreadBps: 10, maxTotalBps: 100, impactKBps: 50, maxFillUsd: 5_000n, maxInventoryUsd: 25_000n, liquidityUsd: 250_000n } as const;

// ── P3 F-14 (next FINAL; WIP 31efd250): terminal residual + physical idle backing ─────────────
/** Engine header (relative to MARKET_GROUP_OFF), engine 35ddd692, rustc offset_of!. */
export const H_BACKING_PROVIDER_EARNINGS_TOTAL = 397; // u128
export const H_SOURCE_FRESH_BACKING_TOTAL_NUM = 429; // u128 (x BOUND_SCALE)
/** EngineAssetSlotV16Account: backing buckets (domain even = long, odd = short). */
export const SLOT_BACKING_LONG = 963;
export const SLOT_BACKING_SHORT = 1060;
export const BUCKET_FRESH_UNLIENED_BACKING_NUM = 8; // u128 (x BOUND_SCALE)
export const BOUND_SCALE = 1_000_000_000_000n;
