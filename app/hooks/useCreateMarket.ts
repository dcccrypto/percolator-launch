"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
  MINT_SIZE,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import {
  encodeInitMarket,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodePermissionlessCrank,
  encodeInitMatcherCtx,
  encodeSetMatcherConfig,
  encodeInitUser,
  encodeSetNftProgramId,
  encodeStakeInitPool,
  encodeUpdateFeeSplit,
  encodeStakeBindInsuranceAuthority,
  bindInsuranceAuthorityAccounts,
  ACCOUNTS_UPDATE_FEE_SPLIT,
  validateFeeSplit,
  MAX_BACKING_BUCKET_EXPIRY_SLOT,
  detectDexType,
  parseDexPool,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  ACCOUNTS_SET_MATCHER_CONFIG,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  deriveMatcherDelegate,
  deriveNftRegistry,
  deriveLpVaultRegistry,
  deriveLpBackingLedger,
  deriveInsuranceLpMint,
  deriveStakePool,
  deriveStakeVaultAuth,
  initPoolAccounts,
  parseHeader,
  isV17Account,
  V17_PORTFOLIO_ACCOUNT_LEN,
  MATCHER_CONTEXT_LEN,
  // W2/W3 fix (2026-07-08): parsePortfolioV17 reads the LP portfolio's on-chain
  // `capital` so Step 3 can detect an already-landed deposit/top-up before
  // resending it — see the Step 3 block below.
  parsePortfolioV17,
  parseMarketGroupV17OI,
  parseAssetOracleProfileV17,
  parseLpVaultRegistry,
} from "@percolatorct/sdk";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { toE6 } from "@/lib/format";
import { buildKeeperRegisterMemoIx, keeperMemoParams } from "@/lib/keeper-register-memo";
import { preflightRegistration, resolveMarketMetadata } from "@/lib/market-metadata";
import { buildM1Instructions } from "@/lib/create-market-m1";
import { WIZARD_STEP_COPY } from "@/lib/wizard-copy";
import { KEEPER_REGISTER_COPY, loadProofPayload, loadProofTx, markRegistered, postKeeperRegistration, runKeeperRegistration, saveProofPayload, saveProofTx, saveRegisterRequest, type KeeperRegisterPhase } from "@/lib/keeper-register-client";
import { deriveLaunchMarketParams, deriveMarketParams, MIN_LEVERAGE_X, backingSeedPerDomain, leverageFromMarginBps } from "@/lib/market-params";
// GH#2592: the step-4 predicate and /api/devnet-pre-fund's funding target must be
// the SAME number. They were two hand-copies, and the route's was understated by
// both backing seeds, so it answered "sufficient" to the very request that said
// the wallet was short.
import { fullMarketRequirement, classifyPreFundRefusal } from "@/lib/prefund-requirement";
import { defaultCrankObservations, readPortfolioIdentity, readAssetMarketId, readAssetControlSeqs, assetProfileOff } from "@/lib/v18-wire";
// v17: SetOracleAuthority (tag 17), PushOraclePrice (tag 16), SetOraclePriceCap (tag 16),
// and UpdateConfig (tag 14) do not exist in v17. All oracle + risk params are embedded
// in InitMarket (extended tail). The sdk-compat stubs throw at runtime if called.
// We guard all callsites with isAdminOracle && !isV17Slab before using these.
import {
  sendTx,
  prewarmTxLanding,
  buildBatchTx,
  signAllCompat,
  broadcastSignedTx,
  getFreshBlockhash,
  getPriorityFee,
  isBlockhashExpiredError,
  isConfirmationTimeoutError,
  checkSignatureLanded,
  TxCancelledError,
  isTxCancelledError,
  presimulateOrThrow,
  confirmSignatureByPolling,
} from "@/lib/tx";
import { getConfig, getNetwork } from "@/lib/config";
import { resolveMarketOracleMode } from "@/lib/resolveMarketOracleMode";
import { normalizeDexType } from "@/lib/dex-type";
import { parseMarketCreationError, extractCustomCode } from "@/lib/parseMarketError";
import {
  buildEarnVaultSeedInstructions,
  EARN_VAULT_SEED_COMPUTE_UNITS,
  EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE,
  LP_VAULT_BACKING_BUCKET_NOT_EMPTY_CODE,
  STAKE_POOL_COOLDOWN_SLOTS,
} from "@/lib/earn-vault-seed";
import {
  freshLaunchAuthorityEpoch,
  isOracleDelegationApplied,
  sequentialStepKind,
  type CreateStepKind,
} from "@/lib/create-market-v18";
import { buildInitMatcherCtxArgs } from "@/lib/matcher-params";
import { buildP3BindIxs, canonicalVaultLpMatcher, p3BindProgress, validateP3Wizard } from "@/lib/limits/p3-wizard";
import { COPY as LIMITS_COPY } from "@/lib/limits/copy";
import { buildDepositJuniorTrancheIx, deriveVaultLpState } from "@/lib/limits/p3-ix";
import { decodeVaultLpState } from "@/lib/limits/decode";
import { VAULT_LP_MATCHER_CTX_LEN } from "@/lib/limits/constants";

const P3_WIZARD_ISSUE_COPY = LIMITS_COPY.p3Wizard.issue;

/** CU for M4p: createAccount + InitVaultLp (portfolio materialise + state PDA create) + junior deposit. */
const P3_BIND_COMPUTE_UNITS = 600_000;
import { buildConfigureBackingFeeCapIx, matcherTag5Enabled } from "@/lib/limits/matcher-configure";
import {
  inspectV17MatcherContext,
  isEmptyV17PortfolioMatcherConfig,
  readV17PortfolioMatcherConfig,
} from "@/lib/v17-matcher-state";
import {
  saveInFlightMarket,
  updateInFlightStep,
  clearInFlightMarket,
  loadLastInFlightMarket,
} from "@/lib/inFlightMarket";
import {
  type MarketRegistrationPayload,
} from "@/lib/market-registration-auth";
// Market sizing + InitMarket args live in lib/create-market-args.ts (plain module, so the
// P3 BPF sim bridge can build the market from the same code). Re-exported for existing callers.
export {
  V17_MAX_PORTFOLIO_ASSETS,
  DEFAULT_SLAB_SIZE,
  P3_MARKET_ASSET_SLOTS,
  marketAssetSlotsFor,
  buildV17InitMarketArgs,
  wizardSlabBytes,
  slabSizeFor,
} from "@/lib/create-market-args";
import {
  marketAssetSlotsFor,
  buildV17InitMarketArgs,
  slabSizeFor,
} from "@/lib/create-market-args";
const ALL_ZEROS_FEED = "0".repeat(64);

/**
 * Order the stake-tail instructions so the fee-split → stake-pool sequence is
 * always correct, in BOTH the batched (M4) and sequential (Step 5) create paths:
 *
 *   [...preInitPool] → [UpdateFeeSplit?] → StakeInitPool → BindInsuranceAuthority
 *
 * WHY the order is load-bearing:
 *  - UpdateFeeSplit (wrapper tag 86) is gated on cfg.marketauth. StakeInitPool
 *    irreversibly rotates cfg.marketauth to the pool PDA, so tag 86 MUST precede
 *    it (afterwards it is reachable only via the stake CPI proxy, stake tag 25).
 *  - BindInsuranceAuthority (stake tag 19) needs the pool PDA to already exist,
 *    so it MUST follow StakeInitPool. The creator still signs it as asset-0's
 *    insurance_authority (InitPool rotates marketauth, not insurance_authority).
 *
 * `updateFeeSplitIx` is null for a default split (no tx needed — defaults are
 * written at InitMarket). Exported so the sequence invariant can be unit-tested
 * without driving the whole wallet/RPC create flow.
 */
export function orderStakeTailInstructions<T>(
  preInitPool: T[],
  updateFeeSplitIx: T | null,
  initPoolIx: T,
  bindInsuranceIx: T,
): T[] {
  return [
    ...preInitPool,
    ...(updateFeeSplitIx ? [updateFeeSplitIx] : []),
    initPoolIx,
    bindInsuranceIx,
  ];
}

// BACKING-BUCKET SEEDING: both domains of asset 0 (long=2*assetIndex,
// short=2*assetIndex+1) are funded by DepositToLpVault in the Earn-vault step
// (CreateLpVault + 2 deposits, lib/earn-vault-seed.ts), NOT by a direct
// TopUpBackingBucket — a direct top-up makes CreateLpVault fail Custom(63).
// The AMOUNT is backingSeedPerDomain() (lib/market-params.ts).

/**
 * PERC-465: Fetch the current USD price for a token from Jupiter price API.
 * Used to push a real initial oracle price immediately after market creation.
 * Returns null on any failure — caller falls back to params.initialPriceE6.
 */
async function fetchJupiterPriceE6(ca: string): Promise<bigint | null> {
  // 1. Try Jupiter Lite API
  try {
    const resp = await fetch(
      `https://lite.jup.ag/v6/price?ids=${ca}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (resp.ok) {
      const json = await resp.json() as { data?: Record<string, { price?: number }> };
      const price = json.data?.[ca]?.price;
      if (price && isFinite(price) && price > 0) {
        return toE6(price);
      }
    }
  } catch { /* fall through */ }

  // 2. Fallback: DexScreener (covers Pump.fun + PumpSwap tokens Jupiter misses)
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (resp.ok) {
      const json = await resp.json() as { pairs?: Array<{ priceUsd?: string }> };
      const priceStr = json.pairs?.[0]?.priceUsd;
      const price = priceStr ? parseFloat(priceStr) : 0;
      if (price > 0 && isFinite(price)) {
        return toE6(price);
      }
    }
  } catch { /* fall through */ }

  return null;
}

/** Minimum vault seed required by percolator-prog before InitMarket (500_000_000 raw tokens). */
export const MIN_INIT_MARKET_SEED = 500_000_000n;

/**
 * BUG FIX (devnet flow-test 2026-07-01, flowtest/debug-maxassets-bisect.ts): the deployed
 * wrapper program rejects InitMarket with a raw ProgramError::InvalidAccountData ("invalid
 * account data for instruction" — no Custom error code, so parseMarketCreationError can't give
 * the user a useful message) whenever initial_margin_bps/maintenance_margin_bps are too low.
 * Bisected on-chain: 1000/500 bps (10x leverage) and 1100/550 both fail; 1200/600 (~8.33x) and
 * MARKET_PARAMS' proven values consistently succeed. This means EVERY market ever created
 * through this wizard at the previous default leverage range would have silently failed Step 0
 * with a cryptic error. 1500 bps (~6.67x max leverage) is enforced as a floor here — comfortably
 * above the proven-good 1200 boundary (the exact edge between 1100 and 1200 wasn't bisected
 * further) — regardless of what leverage the caller requests, so no create-market attempt can
 * hit this failure mode. If product wants to offer >6.67x leverage again, this needs a fresh
 * on-chain bisection first.
 */
/**
 * SUPERSEDED 2026-07-27. Kept only so nothing silently imports a stale floor.
 *
 * The 1500-bps (6.67x) floor above came from a bisection that concluded "10x
 * fails on-chain". That was a misdiagnosis: 10x fails only when paired with the
 * OLD hardcoded price-move budget (1 bps/slot x 500 slots = 500), which exceeds
 * what 500-bps maintenance margin can absorb. Re-bisected against the deployed
 * program with a compatible budget (4 x 100 = 400), **10x is accepted**. The
 * fresh bisection the comment above asks for is the MAX_PRICE_MOVE_BY_MARGIN
 * table in lib/market-params.ts.
 *
 * Leaving the floor in place was not neutral: `derived` sized the price-move
 * budget for the leverage the creator PICKED while InitMarket wrote the floored
 * margin, so a creator who chose 10x got a 6.67x market. Margin and budget now
 * both come from deriveMarketParams(), which makes them coherent by
 * construction.
 */
export const MIN_SAFE_INITIAL_MARGIN_BPS = 1500n;

/**
 * The on-chain initial_margin_bps this request will ACTUALLY be created with.
 *
 * Every leverage display (success screen, StepReview, markets DB `max_leverage`)
 * must go through this rather than the raw bps the user typed. Originally that
 * was BUG 16 (2026-07-06): create() floored the margin at 1500 but the displays
 * read the unfloored value, so a market advertised as 10x was initialized at
 * ~6.67x.
 *
 * The floor is gone (see MIN_SAFE_INITIAL_MARGIN_BPS above), but the reason for
 * this mirror is not: deriveMarketParams clamps leverage to [MIN_LEVERAGE_X,
 * MAX_LEVERAGE_X] and rounds margin UP, so the requested bps and the on-chain
 * bps can still differ. A pure function of the request — no retry/session
 * state — so it is safe to call before submission.
 */
export function flooredInitialMarginBps(requestedBps: number): number {
  const lev = requestedBps > 0 ? 10_000 / requestedBps : MIN_LEVERAGE_X;
  return deriveMarketParams(lev, 0n, 1_000_000n).initialMarginBps;
}

export interface VammParams {
  spreadBps: number;
  impactKBps: number;
  maxTotalBps: number;
  liquidityE6: string;
}

export interface CreateMarketParams {
  mint: PublicKey;
  initialPriceE6: bigint;
  lpCollateral: bigint;
  insuranceAmount: bigint;
  oracleFeed: string;
  invert: boolean;
  tradingFeeBps: number;
  /**
   * Fee-collection split (bps of the trade fee T). When provided AND different
   * from the on-chain defaults, an UpdateFeeSplit (wrapper tag 86) instruction is
   * sent BEFORE StakeInitPool (which irreversibly rotates marketauth to the pool
   * PDA, after which tag 86 is only reachable via the stake CPI proxy). Omit to
   * keep the on-chain defaults (creator 1600 / LP 4800 / insurance 1600), which
   * are written at InitMarket and need no tx. Must satisfy validateFeeSplit
   * (sum == 8000, creator ≤ 3600, LP ≥ 3200, insurance ≥ 1200) or the wrapper
   * rejects it with Custom(52)/Custom(51).
   */
  feeSplit?: {
    creatorShareBps: number;
    lpShareBps: number;
    insuranceShareBps: number;
  };
  /**
   * P3 (vault-owned LP): bind the market's Earn vault to a vault-owned LP with the creator's
   * junior (first-loss) tranche, right after CreateLpVault and BEFORE StakeInitPool rotates
   * marketauth (InitVaultLp path A needs the creator as marketauth). See lib/limits/p3-wizard.ts.
   */
  p3?: {
    juniorFloorBps: number;
    /** The creator's first-loss capital. Under P3 there is NO creator-owned LP at all (M2 / M3a
     *  and sequential steps 2-3's LP parts are skipped): tag 94 auto-pins the vault LP's
     *  canonical matcher and caps (07a1d0eb), so the vault LP is the market's only LP. */
    juniorAtoms: bigint;
  };
  /**
   * Largest one-sided position the LP takes on, bps of the LP seed (lpCollateral). Written once
   * into the matcher's max_inventory_abs (one trade <= a quarter of it). Omitted = 1x; clamped
   * to [0.25x, 2x] (lib/matcher-params.ts). Legacy creator-LP path only: under P3 tag 94 pins
   * the vault LP's caps and the wrapper holds it to 1x its junior equity.
   */
  lpExposureBps?: number;
  initialMarginBps: number;
  /** Number of trader slots (256, 1024, 4096). Defaults to 4096 if omitted.
   *  IMPORTANT: Must match the compiled MAX_ACCOUNTS of the target program binary.
   *  The default devnet program is compiled for 4096 accounts. */
  maxAccounts?: number;
  /** Slab data size in bytes. Calculated from maxAccounts if omitted. */
  slabDataSize?: number;
  /** Token symbol for dashboard */
  symbol?: string;
  /** Token name for dashboard */
  name?: string;
  /** Token decimals */
  decimals?: number;
  /** vAMM configuration — if provided, uses custom params instead of defaults */
  vammParams?: VammParams;
  /** Mainnet token CA — used by oracle keeper to fetch real-time prices (PERC-465) */
  mainnetCA?: string;
  /** PERC-470: Oracle mode — determines how price is fed to the market */
  oracleMode?: "pyth" | "hyperp" | "admin" | "keeper";
  /** PERC-470: DEX pool address for hyperp mode (PumpSwap/Raydium/Meteora) */
  dexPoolAddress?: string;
  /** PERC-470: Base vault address for hyperp mode (PumpSwap) */
  dexBaseVault?: string;
  /** PERC-470: Quote vault address for hyperp mode (PumpSwap) */
  dexQuoteVault?: string;
  /**
   * Keeper oracle: DEX pool type (raydium-clmm / meteora-dlmm / pumpswap).
   * Used by the keeper registration call after market creation.
   */
  dexType?: string;
}

export interface CreateMarketState {
  /**
   * Why the one-approval batched launch fell back to the six-prompt sequential
   * path, or null when it did not. Recorded so a user who signs six times can
   * say WHY without having had devtools open. See #2586.
   */
  /**
   * REQUIRED, not optional. Optional meant the compiler guarded only the
   * producer: deleting the `setState` that stores the reason, or the clear that
   * stops a stale one surfacing on a retry, type-checked in silence. Required
   * forces the initial state and reset() to name it, so every state
   * construction has to decide.
   */
  batchFallbackReason: string | null;
  step: number;
  stepLabel: string;
  txSigs: string[];
  slabAddress: string | null;
  error: string | null;
  loading: boolean;
  /** Devnet mint address (different from mainnet CA) */
  devnetMint: string | null;
  /**
   * GH#1761 (legacy): previously set to true when the old "Insurance LP Mint" step
   * failed after exhausting retries. That instruction was removed (see the Step 4/5
   * comment block in create() below — CreateLpVault/StakeInitPool replaced it and are
   * NOT treated as non-fatal; they use the same hard-error/retry path as every other
   * step). Kept for backwards-compatible UI wiring; never set to true by create().
   */
  insuranceMintFailed: boolean;
  /**
   * GH#2514: set when the sequential path's backing-bucket seeding failed.
   *
   * That step is deliberately non-fatal (see the Step 3 comment in create()) so
   * a transient RPC error cannot strand an otherwise-live market. But it was
   * ALSO silent: the launch went on to report an unqualified "Market created!"
   * while both backing domains were left unseeded.
   *
   * That was defensible when the seed was dust. It is not now the seed is
   * `backingSeedPerDomain(lp)` per domain — 100% of LP collateral each at the
   * current policy, so a silent failure leaves the creator's market short two
   * allocations totalling twice their LP.
   *
   * Non-fatal is kept; silent is not. The launch still succeeds, and the
   * success screen says what did not happen so the creator can retry or
   * backfill rather than believing the market is fully seeded.
   */
  backingSeedFailed: boolean;
  /** Keeper oracle mode: true when oracle_authority was delegated to keeper */
  keeperDelegated: boolean;
  /** Keeper registration result message */
  keeperMessage: string | null;
  /** True while a manual "Retry registration" call (see retryKeeperRegistration) is in flight. */
  keeperRegistering: boolean;
  /** UX WP-7: the market-creation tx signature (the keeper-registration proof). */
  keeperProofTx?: string | null;
  /** UX WP-7: the background registration loop's phase. */
  keeperPhase?: KeeperRegisterPhase | null;
  /**
   * E2E B21: this market's price comes from a keeper-read DEX pool, so it is NOT launched
   * until keeper-register succeeds (`keeperDelegated`). LaunchSuccess shows "launched" only
   * when this is false or the registration landed; otherwise it shows the failed
   * price-feed step with Retry. See `launchPriceFeedStatus`.
   */
  priceFeedRequired: boolean;
  /**
   * Batch-launch UI phase (fresh-launch fast path only — see
   * `attemptFreshBatchedLaunch` below). Sequential/resume flows never set this
   * away from "idle", so `LaunchProgress` falls back to its original
   * per-step (0-5) rendering for those — this is purely additive UI state,
   * `step`/`lastStep` remain the single source of truth the resume machinery
   * (RecoverSolBanner, useStuckSlabs, updateInFlightStep) reads.
   */
  phase: "idle" | "preparing" | "awaiting-signature" | "landing" | "done";
  /** "landing" phase only: 1-based index of the transaction currently confirming. */
  landingIndex: number;
  /** Human-readable market-creation step names, one per batched tx, in order. */
  landingLabels?: string[];
  /** "landing" phase only: total transactions in this batch (4-5 depending on oracle mode). */
  landingTotal: number;
}

/**
 * slab -> the registration payload built at launch time.
 *
 * The retry path has no CreateMarketParams, so without this a retry re-registers
 * with only symbol + pool and the row keeps the indexer's column defaults —
 * 10x/10bps regardless of what the creator actually chose. Stashing the payload
 * lets a retry replay the SAME registration rather than a partial one.
 *
 * Module-level and per-slab: it survives a failed launch on the same page,
 * which is when Retry is used. A full page reload loses it and the retry falls
 * back to the partial shape.
 */
const launchRegistrationPayloads = new Map<string, MarketRegistrationPayload>();

/** Keep the payload the creation-tx memo binds (in memory and on this device, memo v2). */
function rememberRegistrationPayload(slab: string, payload: MarketRegistrationPayload): void {
  launchRegistrationPayloads.set(slab, payload);
  saveProofPayload(slab, payload);
}
function recallRegistrationPayload(slab: string): MarketRegistrationPayload | null {
  return launchRegistrationPayloads.get(slab) ?? loadProofPayload(slab);
}

/** Minimal shape retryKeeperRegistration needs to re-run keeper-register for an
 *  already-live slab — a subset of CreateMarketParams, since the market is already
 *  on-chain and everything else about it is fixed. */
export interface KeeperRegisterRetryParams {
  slabAddress: string;
  mainnetCA?: string | null;
  dexPoolAddress: string;
  dexType?: string | null;
  symbol?: string | null;
  /** Full markets-row payload from buildMarketRegistrationPayload().
   *  keeper-register writes the row, so without this the row falls back to
   *  column defaults (max_leverage 10, trading_fee_bps 10) and loses
   *  oracle_authority / initial_price_e6 / lp_collateral entirely. Optional so
   *  the retry path, which has no CreateMarketParams, still compiles — it
   *  re-registers an already-listed market and only needs the pool binding. */
  payload?: MarketRegistrationPayload | null;
}

export { launchPriceFeedStatus, type LaunchPriceFeedStatus } from "@/lib/launch-outcome";

interface KeeperRegisterOutcome {
  registered: boolean;
  message: string;
}

// ============================================================================
// Fresh-launch batching (2026-07-12)
// ============================================================================
//
// GOAL: collapse the ~12 wallet approvals + 2 signMessage prompts a genuinely
// FRESH quick-launch requires (see the sequential Steps 0-5 below) into ONE
// signAllTransactions batch approval + the same 2 signMessage prompts,
// bursted immediately before it. This function is ONLY attempted when
// `create()` is called with `retryFromStep === undefined` — i.e. a real
// "LAUNCH MARKET" click, never a resume/retry (those always pass an explicit
// step number and keep using the battle-tested sequential per-step code
// below unchanged, including every idempotency check it relies on to resume
// a partially-created market safely).
//
// Maps the 12-tx sequential flow to 6-7 independent transactions:
//   M1  = createAccount(slab)+createATA+InitMarket+SetNftProgramId
//   cosignTx (keeper mode only) = the server-built keeper co-sign tx, wallet-
//         signed inside the same batch, otherwise untouched
//   M2  = createAccount(portfolio)+InitUser+createAccount(ctx)+
//         SetMatcherConfig+InitMatcherCtx
//   M3a = DepositCollateral + 2x TopUpBackingBucket (deadlock-prevention seed)
//   M3b = TopUpInsurance + PermissionlessCrank (best-effort/non-fatal, same
//         as the sequential path's own tail — its failure must never roll
//         back the deposit, per the H9/W3 fix, so it's ALWAYS its own tx)
//   M4a = CreateLpVault alone — the "Creating Earn vault..." step. SPLIT OUT
//         (2026-09-25) from what used to be a single M4 bundling this with the
//         entire stake-pool tail below: that bundle was the largest/most
//         fragile tx in the pipeline (up to 6 ixs, 3 signers, ~18 accounts)
//         and is what tester reports of "Step 5 Create Earn vault — Internal
//         error" were hitting. Mirrors the sequential/resume path, which has
//         always kept these as two separate sends.
//   M4b = createAccount(stakeLpMint)+createAccount(stakeVault)+
//         [UpdateFeeSplit]+StakeInitPool+BindInsuranceAuthority — broadcast
//         only after M4a has landed AND keeper-register has returned, since
//         StakeInitPool irreversibly rotates on-chain marketauth away from
//         the creator wallet and both CreateLpVault and keeper-register's H1
//         check require marketauth === deployer.
//
// `updateInFlightStep` is called with the SAME lastStep values the resume
// machinery already expects after each landing (M1→2, M2→3, M3(a+b)→4,
// M4a→5, M4b→6 — see inFlightMarket.ts's lastStep doc and
// RecoverSolBanner.tsx), so a mid-pipeline failure falls back cleanly onto
// the existing RecoverSolBanner/handleRetry resume flow (which always passes
// an explicit step and therefore uses the sequential code, reading the same
// idempotency state this batch path left behind).
//
// FALLBACK CONTRACT: any failure BEFORE the first transaction broadcasts
// (capability gap, network hiccup, preflight failure, or the user declining
// the single batch-approval popup) returns "fallback" and nothing on-chain
// or in localStorage has changed — `create()` falls through to the
// sequential path in the SAME call, so the user always reaches a working
// flow (worst case: today's N-popup experience, never a dead end). Once ANY
// tx has broadcast, a failure is "fatal": state.error is set and the user
// must use the existing resume/retry UI — this code NEVER re-broadcasts a
// stale pre-signed transaction.

/** Rent-exemption lamports for a handful of FIXED account sizes used by every
 *  market launch. These are Solana protocol constants for a given byte size
 *  (they don't change mid-session) — cached module-level so the preflight
 *  step of a batched launch (and any retry within the same page load) never
 *  re-pays the RPC round-trip for a number it already knows. */
const rentExemptionCache = new Map<number, number>();
async function getCachedRentExemption(connection: Connection, sizeBytes: number): Promise<number> {
  const cached = rentExemptionCache.get(sizeBytes);
  if (cached !== undefined) return cached;
  const rent = await connection.getMinimumBalanceForRentExemption(sizeBytes);
  rentExemptionCache.set(sizeBytes, rent);
  return rent;
}

/** Wallet shape `attemptFreshBatchedLaunch` needs — a narrowed, publicKey-
 *  guaranteed subset of `WalletApi` (the caller has already checked
 *  wallet.publicKey/signTransaction before generating the slab keypair). */
interface FreshBatchWallet {
  publicKey: PublicKey;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

interface FreshBatchContext {
  connection: Connection;
  wallet: FreshBatchWallet;
  programId: PublicKey;
  /** The freshly-generated slab keypair (create() already generated this
   *  before calling in — see the `retryFromStep === undefined` branch). */
  slabKp: Keypair;
  params: CreateMarketParams;
  isDevnetEnv: boolean;
  isKeeperOracle: boolean;
  isAdminOracle: boolean;
  isHyperpOracle: boolean;
  oracleMode: "pyth" | "hyperp" | "admin" | "keeper";
  setState: (updater: (s: CreateMarketState) => CreateMarketState) => void;
  /**
   * GH#2623: set by `create()` from a fresh `AbortController` and aborted by
   * `cancelInFlightLaunch()` (called on CreateMarketWizard unmount). Checked
   * before `broadcastTailTx` re-signs the tail (`recoverTailFrom`) so leaving
   * `/create` stops the wallet-popup loop instead of it continuing on a page
   * the user is no longer looking at.
   */
  abortSignal?: AbortSignal;
}

/**
 * A one-line, user-safe explanation of why the batched launch fell back.
 *
 * Three things the raw `err.message` got wrong:
 *
 *  - A REJECTED approval is not an unavailable fast path. Declining the single
 *    batch prompt throws before broadcast, so it lands here — and saying
 *    "one-approval launch unavailable" tells the user the opposite of what
 *    happened. It was available; they declined it.
 *  - `err.message` is `""` for `new Error()` and for several wallet-adapter
 *    errors. An empty string satisfies `reason: string` and then renders as
 *    nothing, which is exactly the silence this whole change exists to remove.
 *  - Server messages are written for operators. "Is PLAYGROUND_KEEPER_KEYPAIR
 *    set in server env?" is a question for whoever runs the deployment, not
 *    for someone launching a market.
 *
 * Never throws: `String(err)` can raise on a null-prototype object, a Proxy,
 * or a throwing `Symbol.toPrimitive`, and this runs outside any try.
 */
/**
 * The wallet is short of the test token for THIS launch and /api/devnet-pre-fund
 * refused it for its claim window (see classifyPreFundRefusal). The sequential
 * path's deposit step asks the same route and gets the same answer, so falling
 * back would create the market, lock its rent, and then stop. This must end the
 * launch before anything is sent.
 */
async function collateralBalanceOf(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, await getAssociatedTokenAddress(mint, owner))).amount;
  } catch {
    return 0n; // no token account yet
  }
}

export class PreFundRateLimitedError extends Error {
  constructor(public readonly nextClaimAt: string | null) {
    super("Devnet pre-fund failed: Already pre-funded recently");
    this.name = "PreFundRateLimitedError";
  }
}

export function preFundRateLimitedMessage(nextClaimAt: string | null): string {
  const at = nextClaimAt ? new Date(nextClaimAt) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? ` More arrive after ${at.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}.`
    : "";
  return `This wallet is out of test tokens for a market this size, so it can't be funded yet. Nothing was sent.${when} Start over with a smaller liquidity amount to launch now.`;
}

export function describeBatchFallback(err: unknown): string {
  let raw = "";
  try {
    raw = err instanceof Error ? (err.message || err.name) : String(err);
  } catch {
    raw = "";
  }
  if (/user rejected|transaction cancelled|WalletSignTransactionError/i.test(raw)) {
    return "you declined the single-approval signature";
  }
  // Drop the operator-facing tail; the full text still goes to the console.
  const cleaned = raw.replace(/\s*Is [A-Z_]+ set in server env\?\s*/g, " ").trim();
  return cleaned || "the wallet or network did not complete the batch";
}

type FreshBatchOutcome =
  | { status: "success" }
  /**
   * Nothing was broadcast, so the sequential path runs instead.
   *
   * `reason` is NOT decoration. This branch used to discard the error
   * entirely, so the only visible symptom was the user signing SIX wallet
   * prompts instead of one, with nothing anywhere saying why — unreproducible
   * from a bug report, and invisible to anyone without devtools open. Every
   * caller must record it. See #2586.
   */
  | { status: "fallback"; reason: string }
  | { status: "fatal" };

// ---- Blockhash-expiry recovery for the batched launch's tail -------------
//
// M1/M2/M3a/M3b/M4 are all built against the SAME shared blockhash (fetched
// once, below) and signed in the ONE wallet approval, but broadcast+confirmed
// SEQUENTIALLY afterwards — a keeper-register network round-trip is even
// awaited between M3b and M4 (see the `keeperRegisterPromise` await below).
// That means the tail (especially M4 = StakeInitPool) can reach
// `broadcastSignedTx` well after the shared blockhash's ~60-90s validity
// window, hard-failing with "Blockhash not found" even though M1 (the slab)
// already landed. `TailTxDescriptor` retains exactly what's needed to REBUILD
// a not-yet-landed tx against a fresh blockhash — instructions/computeUnits
// for `buildBatchTx`, plus the keypairs that must `partialSign` it AFTER the
// wallet re-signs (Privy strips unknown sigs added before its own signing
// flow — see the ordering note further down). cosignTx is deliberately NOT a
// descriptor: it's server-built against its own blockhash and broadcast early
// (2nd, low-risk) — an expiry there just surfaces as today's error.
interface TailTxDescriptor {
  label: string;
  instructions: TransactionInstruction[];
  computeUnits: number;
  signers: Keypair[];
}

/** Cap total blockhash-refresh recoveries per launch attempt so a pathological
 *  RPC (or a wallet that keeps stalling the re-approval popup) can't loop
 *  forever — after this many, a persistent expiry rethrows and surfaces as
 *  the existing fatal/resumable error path. */
const MAX_BLOCKHASH_RECOVERIES = 2;

/**
 * A batch whose wallet approval took this long is treated as a "slow signer".
 *
 * Every tx in the batch is signed up front against ONE blockhash, which is only
 * valid for ~60-90s. A wallet that can only approve one transaction at a time
 * (no signAllTransactions, or Privy's per-tx fallback signer) asks the user N
 * times before anything is broadcast; at a human pace that outlives the
 * blockhash, the first send is rejected as expired, and `recoverTailFrom` used
 * to ask the user to approve the whole remainder AGAIN, which expires the same
 * way: 7 + 6 + 6 prompts and a failed launch (measured live, see
 * __tests__/live/create-market-live.test.tsx). Past this threshold a re-sign
 * of the same shape cannot win the race, so the batch stops asking.
 */
export const SLOW_BATCH_SIGN_MS = 30_000;

/** What `broadcastTailTx` does when a tail tx's blockhash has expired. */
export type ExpiredBlockhashAction = "resign-batch" | "sequential-fallback" | "give-up";

/**
 * Pure policy for an expired blockhash in the batched tail.
 *  - signing was quick: one more batch approval is cheap and will land, re-sign it.
 *  - signing was slow and NOTHING has landed (tail step 0 = M1): switch to the
 *    sequential path, which signs each step against a fresh blockhash right
 *    before sending it, so signing speed cannot expire anything.
 *  - signing was slow and part of the launch already landed: do not re-prompt;
 *    surface the resumable error (Retry resumes sequentially from the right step).
 */
export function expiredBlockhashAction(args: {
  tailIdx: number;
  lastSignMs: number;
  recoveriesUsed: number;
}): ExpiredBlockhashAction {
  if (args.recoveriesUsed >= MAX_BLOCKHASH_RECOVERIES) return "give-up";
  if (args.lastSignMs < SLOW_BATCH_SIGN_MS) return "resign-batch";
  return args.tailIdx === 0 ? "sequential-fallback" : "give-up";
}

/** Reason recorded when the batch is skipped for a wallet that cannot sign a batch in one approval. */
export const NO_BATCH_SIGNING_REASON =
  "this wallet signs one transaction at a time, so the steps are approved one by one as they land";

/**
 * Refuse, BEFORE the first signature, a registration the route's validators would refuse for
 * ever (the memo binds the payload digest, so an unregistrable payload cannot be repaired once
 * the launch has landed). Runs the same checkName / checkSymbol / validateRegistrationPayload
 * the route runs (lib/market-metadata.ts).
 */
export function assertRegistrable(symbol: string | null | undefined, payload: MarketRegistrationPayload | null): void {
  const problem = preflightRegistration({ symbol, label: null, payload });
  if (problem) {
    throw new Error(`This launch cannot be registered (${problem}). Nothing was sent; no signature was requested.`);
  }
}

/**
 * Single source of truth for the market-registration payload.
 *
 * The batched fast path and the sequential fallback both POST this object to
 * /api/markets AND sign a canonical encoding of it (buildMarketRegistrationMessage,
 * #2387). The signed bytes and the POSTed bytes MUST be byte-identical or the
 * server's signature check 401s — so the payload must be built in exactly ONE
 * place. Previously each path hand-wrote its own literal (they had already
 * drifted cosmetically on the oracle_authority fallback); this factory removes
 * any chance of a future field being added to one and forgotten on the other.
 */
function buildMarketRegistrationPayload(args: {
  slabAddress: string;
  params: CreateMarketParams;
  deployer: string;
  oracleMode: "pyth" | "hyperp" | "admin" | "keeper";
  isAdminOracle: boolean;
  isDevnetEnv: boolean;
}): MarketRegistrationPayload {
  const { slabAddress, params, deployer, oracleMode, isAdminOracle, isDevnetEnv } = args;
  return {
    slab_address: slabAddress,
    mint_address: params.mint.toBase58(),
    symbol: params.symbol ?? "UNKNOWN",
    name: params.name ?? "Unknown Token",
    decimals: params.decimals ?? 6,
    deployer,
    oracle_mode: oracleMode,
    dex_pool_address: params.dexPoolAddress ?? null,
    // Admin-oracle markets on devnet are cranked by the shared crank wallet;
    // otherwise the deployer is its own oracle authority. (deployer === the
    // connected wallet, so this matches the former walletPk.toBase58() literal.)
    //
    // A "keeper" market counts here. On devnet it is created in AUTH_MARK/admin
    // mode and its oracle authority is DELEGATED to the keeper — that is what
    // the mode means. Testing `isAdminOracle` alone (oracleMode === "admin")
    // excluded exactly those markets, so the row recorded oracle_authority=null
    // for the ones the keeper actually drives. Fauci's row shows the symptom.
    oracle_authority: (isAdminOracle || oracleMode === "keeper")
      ? (isDevnetEnv && getConfig().crankWallet ? getConfig().crankWallet : deployer)
      : null,
    initial_price_e6: params.initialPriceE6.toString(),
    // BUG 16: advertise the FLOORED margin actually enforced on-chain, not the
    // raw requested bps — see flooredInitialMarginBps.
    max_leverage: params.initialMarginBps > 0
      ? leverageFromMarginBps(flooredInitialMarginBps(params.initialMarginBps))
      : 1,
    trading_fee_bps: Number(params.tradingFeeBps),
    lp_collateral: params.lpCollateral.toString(),
    mainnet_ca: params.mainnetCA ?? null,
  };
}

async function attemptFreshBatchedLaunch(ctx: FreshBatchContext): Promise<FreshBatchOutcome> {
  const { connection, wallet, programId, slabKp, params, isDevnetEnv, isKeeperOracle, isAdminOracle, isHyperpOracle, oracleMode, setState, abortSignal } = ctx;
  const walletPk = wallet.publicKey;
  const slabPk = slabKp.publicKey;
  // A wallet with no signAllTransactions would be asked to approve every batch tx one at a
  // time BEFORE anything is sent, all against one blockhash (see SLOW_BATCH_SIGN_MS). The
  // sequential path asks for the same number of approvals but sends each one as soon as it
  // is signed, so a slow approver can never expire a blockhash. Decided before any popup or
  // network call, so nothing is wasted.
  if (!wallet.signAllTransactions) {
    console.warn(`[useCreateMarket] BATCHED launch skipped: wallet exposes no signAllTransactions`);
    return { status: "fallback", reason: NO_BATCH_SIGNING_REASON };
  }
  let broadcastStarted = false;
  // Where a failure after broadcast leaves the launch, for Retry and for the
  // error message. The batch used to leave `state.step` at 0, so Retry resumed
  // from step 0 and re-sent the keeper hand-off that had already landed — the
  // wrapper refuses that with Unauthorized (Custom 8), which is the "not
  // authorized" users saw on retry. `resumeStep` is the sequential step to run
  // next; `failingKind`/`failingLabel` name the tx in flight.
  let resumeStep = 0;
  let failingKind: CreateStepKind = "create-market";
  let failingLabel = "Creating the market";
  // Every risk parameter for this market, derived from the creator's leverage
  // and LP seed. Nothing below hand-picks a price-move rate or an LP cap.
  const derived = deriveLaunchMarketParams(params);
  // Collateral seeded into EACH backing domain. Must be real, not dust — the
  // SHORT domain is unfundable after CreateLpVault. See lib/market-params.ts.
  const backingSeed = backingSeedPerDomain(params.lpCollateral);

  try {
    setState((s) => ({ ...s, loading: true, phase: "preparing", stepLabel: "Preparing market launch..." }));

    const [vaultPda] = deriveVaultAuthority(programId, slabPk);
    const vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
    const userAta = await getAssociatedTokenAddress(params.mint, walletPk);
    const [nftRegistryPda] = deriveNftRegistry(programId, slabPk);
    const matcherProgramId = new PublicKey(getConfig().matcherProgramId);
    const [lpVaultRegistry] = deriveLpVaultRegistry(programId, slabPk);
    const [lpVaultMint] = deriveInsuranceLpMint(programId, slabPk);
    const stakeProgramId = new PublicKey(
      (getConfig() as { vaultProgramId?: string }).vaultProgramId ??
        DEVNET_PROGRAM_IDS.stake,
    );
    const [stakePoolPda] = deriveStakePool(slabPk, stakeProgramId);
    const [stakeVaultAuth] = deriveStakeVaultAuth(stakePoolPda, stakeProgramId);

    const lpPortfolioKp = Keypair.generate();
    const matcherCtxKp = Keypair.generate();
    // P3: the vault-owned LP portfolio (owner := the LP-vault registry PDA at InitVaultLp).
    const vaultLpPortfolioKp = params.p3 ? Keypair.generate() : null;
    // P3 auto-pin (07a1d0eb): the vault LP's matcher ctx, pre-created for tag 94 to initialise.
    const vaultLpCtxKp = params.p3 ? Keypair.generate() : null;
    const stakeLpMintKp = Keypair.generate();
    const stakeVaultKp = Keypair.generate();

    const [matcherDelegatePk] = deriveMatcherDelegate(
      programId, slabPk, lpPortfolioKp.publicKey, walletPk, matcherProgramId, matcherCtxKp.publicKey,
    );

    // ---- Fire everything BEFORE any popup (orchestration step 1) ---------
    const preFundPromise = isDevnetEnv
      ? fetch("/api/devnet-pre-fund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // GH#2592: send the amounts this launch will actually spend. Without
          // them the route funds for a fixed reference launch, which is both
          // wrong for other LP sizes and understated for that one.
          body: JSON.stringify({
            mintAddress: params.mint.toBase58(),
            walletAddress: walletPk.toBase58(),
            lpCollateral: params.lpCollateral.toString(),
            insuranceAmount: params.insuranceAmount.toString(),
          }),
        })
      : Promise.resolve(null);

    const cosignPromise = isKeeperOracle
      ? fetch("/api/playground/keeper-cosign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deployer: walletPk.toBase58(),
            slabAddress: slabPk.toBase58(),
            initialPriceE6: params.initialPriceE6.toString(),
            assetIndex: 0,
            // The slab doesn't exist yet — this request is made before M1 is even
            // signed. Without `fresh` the route read the (missing) slab, returned
            // 404 "market account not found", and every launch fell back to six
            // approvals. With it the route uses asset 0's fixed post-M1 values.
            fresh: true,
          }),
        })
      : Promise.resolve(null);

    prewarmTxLanding(connection);

    const rentPromise = Promise.all([
      getCachedRentExemption(connection, slabSizeFor(params)),
      getCachedRentExemption(connection, V17_PORTFOLIO_ACCOUNT_LEN),
      getCachedRentExemption(connection, MATCHER_CONTEXT_LEN),
      getCachedRentExemption(connection, MINT_SIZE),
      getCachedRentExemption(connection, ACCOUNT_SIZE),
    ]);
    const balancePromise = connection.getBalance(walletPk);

    // 1. Devnet pre-fund MUST complete before we build/broadcast anything —
    //    it funds the wallet's collateral ATA for the LP deposit + insurance.
    if (isDevnetEnv) {
      const preFundResp = await preFundPromise;
      if (preFundResp && !preFundResp.ok) {
        const err = await preFundResp.json().catch(() => ({ error: "Unknown error" }));
        const { error: pfError, nextClaimAt } = err as { error?: string; nextClaimAt?: string | null };
        // The 429 body carries `nextClaimAt` — the retry time. Dropping it
        // left the user with "Already pre-funded recently" and no idea when
        // "recently" stops, which is the single fact they need.
        const when = nextClaimAt ? ` Try again after ${nextClaimAt}.` : "";
        // A refusal only matters if the wallet is actually short for THIS launch.
        const refusal = classifyPreFundRefusal({
          status: preFundResp.status,
          body: err as { error?: unknown; nextClaimAt?: unknown },
          balance: await collateralBalanceOf(connection, params.mint, walletPk),
          lpCollateral: params.lpCollateral,
          insuranceAmount: params.insuranceAmount,
        });
        if (refusal.kind === "blocked") throw new PreFundRateLimitedError(refusal.nextClaimAt);
        if (refusal.kind === "error") {
          throw new Error(`Devnet pre-fund failed: ${pfError ?? preFundResp.status}.${when}`);
        }
        console.info("[useCreateMarket] pre-fund refused, but the wallet already covers this launch — continuing");
      }
    }

    // 3. Keeper co-sign (keeper oracle mode only) — fatal, matching the
    //    sequential path's own hard throw for this call.
    let cosignTx: Transaction | null = null;
    if (isKeeperOracle) {
      const cosignResp = await cosignPromise;
      if (!cosignResp || !cosignResp.ok) {
        const errData = cosignResp ? await cosignResp.json().catch(() => ({ error: "co-sign failed" })) : { error: "network error" };
        throw new Error(
          `Keeper co-sign failed (${cosignResp?.status ?? "network error"}): ${(errData as { error?: string }).error ?? "unknown"}. ` +
          `Is PLAYGROUND_KEEPER_KEYPAIR set in server env?`,
        );
      }
      const { partialTxBase64 } = (await cosignResp.json()) as { partialTxBase64: string };
      cosignTx = Transaction.from(Buffer.from(partialTxBase64, "base64"));
    }

    // Asset 0's authority_epoch as the funding txs below will find it. The
    // co-sign tx's UpdateAssetAuthority (Oracle → keeper) advances it 0 → 1
    // before M3a lands; the literal 0 this used to be made every keeper
    // launch's M3a revert EngineStale (Custom 19). See freshLaunchAuthorityEpoch.
    const assetZeroAuthorityEpoch = freshLaunchAuthorityEpoch(cosignTx !== null);

    // 4. UX WP-7: NO signMessage prompt any more. The keeper-registration proof is a memo the
    //    creator signs inside M1 (the InitMarket tx) — lib/keeper-register-memo.ts. The exact
    //    parameters the registration will POST are bound here.
    const keeperRequestBase =
      isKeeperOracle && params.dexPoolAddress
        ? {
            slabAddress: slabPk.toBase58(),
            mainnetCA: params.mainnetCA ?? null,
            dexPoolAddress: params.dexPoolAddress,
            dexType: normalizeDexType(params.dexType) ?? null,
            symbol: params.symbol ?? null,
          }
        : null;
    // Memo v2 binds the full markets-row payload too (its digest), so build it now; the
    // registration loop later sends this exact object.
    const keeperPayload = keeperRequestBase
      ? buildMarketRegistrationPayload({ slabAddress: slabPk.toBase58(), params, deployer: walletPk.toBase58(), oracleMode, isAdminOracle, isDevnetEnv })
      : null;
    if (keeperRequestBase) assertRegistrable(keeperRequestBase.symbol, keeperPayload);
    const keeperMemoIx = keeperRequestBase
      ? await buildKeeperRegisterMemoIx(walletPk, await keeperMemoParams({ ...keeperRequestBase, payload: keeperPayload }))
      : null;

    const [slabRent, portfolioRent, matcherCtxRent, mintRent, tokenAcctRent] = await rentPromise;
    const solBalance = await balancePromise;
    const effectiveSlabSize = slabSizeFor(params);
    const totalRent = slabRent + portfolioRent + matcherCtxRent + mintRent + tokenAcctRent;
    const minSolRequired = totalRent + 20_000_000; // rent + ~0.02 SOL for 5-6 tx fees/priority fees
    if (solBalance < minSolRequired) {
      if (isDevnetEnv) {
        setState((s) => ({ ...s, stepLabel: "Airdropping SOL for slab rent..." }));
        const airdropSig = await connection.requestAirdrop(
          walletPk,
          Math.max(2_000_000_000, minSolRequired - solBalance + 500_000_000),
        );
        await confirmSignatureByPolling(connection, airdropSig);
      } else {
        throw new Error(
          `Insufficient SOL. You need ~${(minSolRequired / 1e9).toFixed(3)} SOL but your wallet has ` +
          `${(solBalance / 1e9).toFixed(3)} SOL.`,
        );
      }
    }

    // ---- Build all txs against ONE fresh blockhash -----------------------
    const [blockhash, priorityFee] = await Promise.all([
      getFreshBlockhash(connection, true),
      getPriorityFee(connection),
    ]);

    // Margin comes from the SAME derivation as the price-move budget below, so
    // the two can never disagree (see lib/market-params.ts).
    // WRITE-ONCE PARAMETERS.
    //
    // Everything below is fixed for the life of the market — InitMarket runs
    // once and there is no instruction to change these afterwards. That is
    // exactly how the 6.67x leverage cap and the missing LP caps survived for
    // months: a value typed here is invisible and permanent. Anything not
    // derived from the creator's choice is listed with why it is safe to pin.
    //
    //  hMin/hMax, minNonzeroMmReq/ImReq  dust + health bounds; below these a
    //                                    position is not worth gas to maintain.
    //  liquidationFee 50 bps, cap $10k   standard; minLiquidationAbs 0 lets any
    //                                    size be liquidated rather than
    //                                    stranding dust positions.
    //  maxAbsFundingE9PerSlot: "0"       funding is deliberately OFF. Trades
    //                                    settle at the pushed AuthMark, which
    //                                    IS the reference price, so there is no
    //                                    perp-vs-spot basis for funding to
    //                                    correct. A non-zero cap here would let
    //                                    a rate accrue against nothing.
    //  maintenanceFeePerSlot: "0"        no rent on open positions.
    //  chunk/lifetime limits             settlement batching; sized so a
    //                                    bankrupt close fits in one tx.
    //
    // Verified 2026-07-28: with these EXACT args, every leverage the wizard
    // offers (2..10x) simulates ACCEPTED against the deployed program, so no
    // creator choice can produce a config InitMarket rejects.
    const v17InitArgs = buildV17InitMarketArgs(params, derived);

    // M1: createAccount(slab) + createATA + InitMarket + SetNftProgramId [+ the keeper memo]
    // (lib/create-market-m1.ts; 987 B with the memo on the heaviest config, limit 1232).
    const m1Instructions = buildM1Instructions({
      programId, wallet: walletPk, slab: slabPk, mint: params.mint, vaultAta, vaultPda, nftRegistry: nftRegistryPda,
      slabRent, slabSize: effectiveSlabSize, initArgs: v17InitArgs, memo: keeperMemoIx,
    });
    const m1Descriptor: TailTxDescriptor = {
      label: WIZARD_STEP_COPY.createMarket,
      instructions: m1Instructions,
      computeUnits: 400_000,
      signers: [slabKp],
    };

    // M2: createAccount(portfolio)+InitUser + createAccount(ctx)+SetMatcherConfig+InitMatcherCtx
    const createPortfolioIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: lpPortfolioKp.publicKey,
      lamports: portfolioRent, space: V17_PORTFOLIO_ACCOUNT_LEN, programId,
    });
    const initPortfolioIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, {
        owner: walletPk, market: slabPk, portfolio: lpPortfolioKp.publicKey,
      }),
      data: encodeInitUser({}),
    });
    const createCtxIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherCtxRent, space: MATCHER_CONTEXT_LEN, programId: matcherProgramId,
    });
    const setMatcherConfigIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, {
        lpOwner: walletPk, market: slabPk, lpPortfolio: lpPortfolioKp.publicKey,
        matcherProg: matcherProgramId, matcherCtx: matcherCtxKp.publicKey, matcherDelegate: matcherDelegatePk,
      }),
      // v18 fresh-market bootstrap: the LP is the FIRST portfolio created on this
      // brand-new market, so its program-assigned portfolioId is 1 and its
      // matcher-sequence is 0 (InitUser just ran in this same tx, no prior ops).
      // assetGenerationFrontier = header.next_market_id = max_market_slots + 1
      // (V17_MAX_PORTFOLIO_ASSETS + 1); tradeFeeCapBps 10000 = no practical LP cap;
      // expirySlot = born-immortal non-lapsing grant.
      data: encodeSetMatcherConfig({
        portfolioId: 1n,
        expectedSequence: 0n,
        assetGenerationFrontier: BigInt(marketAssetSlotsFor(params)) + 1n,
        enabled: 1,
        tradeFeeCapBps: 10_000,
        expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT,
      }),
    });
    const initMatcherCtxIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
        lpOwner: walletPk, market: slabPk, lpPortfolio: lpPortfolioKp.publicKey,
        matcherCtx: matcherCtxKp.publicKey, matcherProg: matcherProgramId, matcherDelegate: matcherDelegatePk,
      }),
      // Matcher config for NEW markets: kind 1 (vAMM) + skew + FINITE non-zero
      // caps, all from lib/matcher-params.ts (never 0: max_fill 0 = no fills,
      // max_inventory 0 = unlimited LP). Existing markets are never reconfigured.
      data: encodeInitMatcherCtx(buildInitMatcherCtxArgs(Number(params.tradingFeeBps), derived.matcher)),
    });
    // P2 carry-over: matcher tag 5 (owner-proof Configure) sets the LP's backing-fee
    // consent cap, which tag 4 never could (lib/limits/matcher-configure.ts). Only once
    // the matcher is upgraded (NEXT_PUBLIC_MATCHER_TAG5=1) and a cap is configured.
    const backingFeeCapBps = Number(process.env.NEXT_PUBLIC_MATCHER_BACKING_FEE_CAP_BPS ?? "0") || 0;
    const configureCapIxs =
      matcherTag5Enabled() && backingFeeCapBps > 0
        ? [
            buildConfigureBackingFeeCapIx({
              wrapperProgramId: programId,
              matcherProgramId,
              market: slabPk,
              lpPortfolio: lpPortfolioKp.publicKey,
              lpOwner: walletPk,
              matcherCtx: matcherCtxKp.publicKey,
              capBps: backingFeeCapBps,
            }),
          ]
        : [];
    const m2Descriptor: TailTxDescriptor = {
      label: WIZARD_STEP_COPY.liquidity,
      instructions: [createPortfolioIx, initPortfolioIx, createCtxIx, setMatcherConfigIx, initMatcherCtxIx, ...configureCapIxs],
      computeUnits: 800_000,
      signers: [lpPortfolioKp, matcherCtxKp],
    };

    // M3a: DepositCollateral only (the backing seed moved to M4a — see below)
    const depositIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
        owner: walletPk, market: slabPk, portfolio: lpPortfolioKp.publicKey,
        sourceToken: userAta, vaultToken: vaultAta, tokenProgram: WELL_KNOWN.tokenProgram,
      }),
      // v18 fresh-market: LP portfolioId 1; matcher-sequence is now 1 because
      // SetMatcherConfig (M2, above) advanced it 0->1 (Deposit/Withdraw/SetMatcher
      // all bump the per-portfolio matcher-sequence).
      data: encodeDepositCollateral({
        portfolioId: 1n,
        expectedSequence: 1n,
        amount: params.lpCollateral.toString(),
      }),
    });
    // NO direct TopUpBackingBucket here (bug C-1): a direct top-up at any expiry other
    // than the LP-vault sentinel makes the M4a CreateLpVault fail Custom(63)
    // LpVaultBackingBucketNotEmpty. Both domains are funded in M4a via
    // DepositToLpVault instead — see lib/earn-vault-seed.ts.
    const m3aDescriptor: TailTxDescriptor = {
      label: WIZARD_STEP_COPY.funding,
      instructions: [depositIx],
      computeUnits: 450_000,
      signers: [],
    };

    // M3b: TopUpInsurance + PermissionlessCrank — best-effort/non-fatal tail,
    // broadcast as its OWN transaction (never merged with M3a) so its failure
    // can never roll back the deposit above — preserves the H9/W3 fix.
    const topupIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, {
        signer: walletPk, market: slabPk, sourceToken: userAta, vaultToken: vaultAta, tokenProgram: WELL_KNOWN.tokenProgram,
      }),
      // v18 fresh-market: asset-0 market_id = 1; authority_epoch as above; intentId
      // is the NEXT value on the shared insurance/backing one-shot lane — backing
      // consumed 1 and 2 above, so insurance takes 3.
      data: encodeTopUpInsurance({
        marketId: 1n,
        intentId: 3n,
        authorityEpoch: assetZeroAuthorityEpoch,
        amount: params.insuranceAmount.toString(),
      }),
    });
    const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
      owner: walletPk, market: slabPk, portfolio: lpPortfolioKp.publicKey,
    });
    // ONLY a pyth market carries a Pyth push-oracle account on the crank.
    //
    // This used to be `!isAdminOracle && !isHyperpOracle`, which is TRUE for a
    // keeper market — and a keeper market's `oracleFeed` is the mainnet DEX POOL
    // address, not a Pyth hex feed id. So every keeper launch derived a
    // push-oracle PDA from a pool address and appended that garbage account to
    // its crank. Keeper markets are AUTH_MARK/admin-mode on chain with the
    // authority delegated to the crank wallet; they have no Pyth account at all.
    if (oracleMode === "pyth") {
      crankKeys.push({ pubkey: derivePythPushOraclePDA(params.oracleFeed)[0], isSigner: false, isWritable: false });
    }
    const crankIx = buildIx({
      programId, keys: crankKeys,
      // v18: PermissionlessCrank payload is { nowSlot, observations }.
      data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }),
    });
    const m3bDescriptor: TailTxDescriptor = {
      label: WIZARD_STEP_COPY.insurance,
      // P3: no creator-owned LP portfolio exists to crank; the insurance top-up stands alone.
      instructions: params.p3 ? [topupIx] : [topupIx, crankIx],
      computeUnits: 450_000,
      signers: [],
    };

    // M4a/M4b instructions — CreateLpVault (M4a) + createAccount(mint)+
    // createAccount(vault)+StakeInitPool tail (M4b). Split into two separate
    // transactions below (see the M4-split fix note above this function).
    // CreateLpVault(domain 0) + DepositToLpVault into domain 0 AND 1, atomically. Both
    // buckets are still Empty here (M3a no longer touches them), which is exactly what
    // CreateLpVault requires; the deposits then stamp LP_VAULT_BACKING_EXPIRY_SLOT.
    const earnVaultIxs = buildEarnVaultSeedInstructions({
      programId, wallet: walletPk, market: slabPk, registry: lpVaultRegistry, lpMint: lpVaultMint,
      userAta, vaultAta, seedPerDomain: backingSeed, includeCreate: true,
    });
    const createLpMintIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: stakeLpMintKp.publicKey,
      lamports: mintRent, space: MINT_SIZE, programId: WELL_KNOWN.tokenProgram,
    });
    const createStakeVaultIx = SystemProgram.createAccount({
      fromPubkey: walletPk, newAccountPubkey: stakeVaultKp.publicKey,
      lamports: tokenAcctRent, space: ACCOUNT_SIZE, programId: WELL_KNOWN.tokenProgram,
    });
    const initPoolIx = buildIx({
      programId: stakeProgramId,
      keys: initPoolAccounts({
        admin: walletPk, slab: slabPk, pool: stakePoolPda, lpMint: stakeLpMintKp.publicKey,
        vault: stakeVaultKp.publicKey, vaultAuth: stakeVaultAuth, collateralMint: params.mint, percolatorProgram: programId,
      }),
      data: encodeStakeInitPool(STAKE_POOL_COOLDOWN_SLOTS, 0n), // C-1: relaunch floor, 150 slots
    });
    // UpdateFeeSplit (wrapper tag 86) — creator-chosen split, MARKETAUTH-GATED, so it
    // MUST land BEFORE initPoolIx (StakeInitPool irreversibly rotates cfg.marketauth to
    // the pool PDA; after that this tag is only reachable via the stake CPI proxy).
    // Only emitted for a non-default split (defaults are written at InitMarket). Guarded
    // by the SAME rule the wrapper enforces so a bad split can never reach chain here.
    const feeSplitArgs = params.feeSplit;
    const updateFeeSplitIx = feeSplitArgs
      ? (() => {
          // v18 fresh-market: UpdateFeeSplit (tag 86) is CAS-bound to asset-0's
          // authority_epoch lane — 0 after InitMarket, 1 once the keeper hand-off
          // has landed (see assetZeroAuthorityEpoch). This runs BEFORE
          // StakeInitPool rotates marketauth, so the creator is still the gating
          // authority.
          const feeSplitV18 = { ...feeSplitArgs, authorityEpoch: assetZeroAuthorityEpoch };
          const reason = validateFeeSplit(feeSplitV18);
          if (reason) throw new Error(`Invalid fee split: ${reason}`);
          return buildIx({
            programId,
            keys: buildAccountMetas(ACCOUNTS_UPDATE_FEE_SPLIT, { admin: walletPk, market: slabPk }),
            data: encodeUpdateFeeSplit(feeSplitV18),
          });
        })()
      : null;
    // BindInsuranceAuthority (stake tag 19) — binds the vault_auth PDA as asset-0's
    // insurance_authority + insurance_operator (two CPIs to wrapper UpdateAssetAuthority).
    // REQUIRED, or the staker/insurance fee leg has no exit. Runs AFTER initPoolIx (the
    // pool PDA must exist), signed by the creator, who is still asset-0's insurance
    // authority (InitPool rotates marketauth, not insurance_authority).
    const bindInsuranceIx = buildIx({
      programId: stakeProgramId,
      keys: bindInsuranceAuthorityAccounts({
        admin: walletPk,
        poolPda: stakePoolPda,
        vaultAuth: stakeVaultAuth,
        slab: slabPk,
        percolatorProgram: programId,
      }),
      data: encodeStakeBindInsuranceAuthority(),
    });
    // BUG FIX (2026-09-25, tester-reported "Step 5 Create Earn vault — Internal
    // error"): M4 used to bundle CreateLpVault + createAccount(mint) +
    // createAccount(vault) + [UpdateFeeSplit] + StakeInitPool + BindInsuranceAuthority
    // into ONE transaction — up to 6 instructions, 3 signers (wallet + 2 fresh
    // keypairs) and ~18 unique accounts, by far the largest/most fragile tx in the
    // whole pipeline. The sequential per-step path (Step 4 / Step 5 below in the
    // resume/retry flow) has always kept these as TWO separate sends — CreateLpVault
    // alone, then the mint/vault/InitPool/Bind bundle — and that split is what makes
    // Step 4 there small and reliable. Mirror that split here: M4a is CreateLpVault
    // alone (matches STEP_LABELS[4] = "Creating Earn vault...", the exact step
    // testers reported failing); M4b is everything that must follow it. This also
    // gives each piece its own retryable landing step (lastStep 4→5→6) instead of
    // one opaque "5/6 bundled" failure that always blamed the Earn-vault label even
    // when the actual broadcast/size issue was in the (unrelated) stake-pool tail.
    const m4aDescriptor: TailTxDescriptor = {
      label: WIZARD_STEP_COPY.earnVault,
      instructions: earnVaultIxs,
      computeUnits: EARN_VAULT_SEED_COMPUTE_UNITS,
      signers: [],
    };
    // M4p (P3): createAccount(vault LP portfolio) + InitVaultLp (94, path A) + DepositJuniorTranche
    // (96). Between M4a (the vault must exist) and M4b (StakeInitPool rotates marketauth, and
    // path A needs the creator as marketauth).
    const m4pDescriptor: TailTxDescriptor | null =
      params.p3 && vaultLpPortfolioKp
        ? {
            label: WIZARD_STEP_COPY.creatorStake,
            instructions: buildP3BindIxs({
              market: {
                programId,
                market: slabPk,
                registry: lpVaultRegistry,
                vaultLpState: deriveVaultLpState(programId, slabPk),
                lpPortfolio: vaultLpPortfolioKp.publicKey,
                ledger: deriveLpBackingLedger(programId, slabPk, 0)[0],
                siblingLedger: deriveLpBackingLedger(programId, slabPk, 1)[0],
              },
              creator: walletPk,
              vaultLpPortfolio: vaultLpPortfolioKp.publicKey,
              portfolioLen: V17_PORTFOLIO_ACCOUNT_LEN,
              portfolioRentLamports: portfolioRent,
              matcherProgram: canonicalVaultLpMatcher(matcherProgramId.toBase58()),
              matcherCtx: vaultLpCtxKp!.publicKey,
              matcherCtxRentLamports: matcherCtxRent,
              juniorFloorBps: params.p3.juniorFloorBps,
              juniorAtoms: params.p3.juniorAtoms,
              creatorAta: userAta,
              vaultToken: vaultAta,
            }),
            computeUnits: P3_BIND_COMPUTE_UNITS,
            signers: [vaultLpPortfolioKp, vaultLpCtxKp!],
          }
        : null;
    const m4bDescriptor: TailTxDescriptor = {
      label: WIZARD_STEP_COPY.stakePool,
      // Order is load-bearing (see orderStakeTailInstructions): UpdateFeeSplit (if any)
      // BEFORE InitPool, Bind AFTER InitPool.
      instructions: orderStakeTailInstructions(
        [createLpMintIx, createStakeVaultIx],
        updateFeeSplitIx,
        initPoolIx,
        bindInsuranceIx,
      ),
      computeUnits: 900_000,
      signers: [stakeLpMintKp, stakeVaultKp],
    };

    // The 6 dependent, rebuild-capable txs — SAME order as before, with M4 now
    // split into M4a/M4b (see the fix note above). Building them here against the
    // one shared `blockhash` is byte-for-byte equivalent to the old inline
    // `buildBatchTx` calls; the descriptors are what let `recoverTailFrom` (below)
    // rebuild only the not-yet-landed ones against a fresh blockhash if the tail's
    // serial confirm-then-broadcast pipeline outruns this blockhash's validity.
    // P3: the creator-LP deposit (M3a) is replaced by the junior tranche (M4p).
    const includeM3a = !params.p3;
    // P3 auto-pin: no creator-owned LP / matcher (M2) — the vault LP is the market's only LP.
    const includeM2 = !params.p3;
    const tailDescriptors: TailTxDescriptor[] = [
      m1Descriptor,
      ...(includeM2 ? [m2Descriptor] : []),
      ...(includeM3a ? [m3aDescriptor] : []),
      m3bDescriptor,
      m4aDescriptor,
      ...(m4pDescriptor ? [m4pDescriptor] : []),
      m4bDescriptor,
    ];
    // Tail indices by descriptor (M4p is optional, so M4b's index moves).
    const tailIdx = (d: TailTxDescriptor): number => {
      const i = tailDescriptors.indexOf(d);
      if (i < 0) throw new Error(`tail descriptor "${d.label}" is not in the tail`);
      return i;
    };
    const buildTailTx = (d: TailTxDescriptor, hash: string): Transaction =>
      buildBatchTx({ instructions: d.instructions, computeUnits: d.computeUnits, priorityFeeMicroLamports: priorityFee, blockhash: hash, feePayer: walletPk });
    const builtTail = tailDescriptors.map((d) => buildTailTx(d, blockhash));
    const tailTx = (d: TailTxDescriptor): Transaction => {
      const tx = builtTail[tailIdx(d)];
      if (!tx) throw new Error(`tail tx "${d.label}" was not built`);
      return tx;
    };
    const [m1, m3b, m4a, m4b] = [m1Descriptor, m3bDescriptor, m4aDescriptor, m4bDescriptor].map(tailTx);
    const m2 = includeM2 ? tailTx(m2Descriptor) : null;
    const m3a = includeM3a ? tailTx(m3aDescriptor) : null;
    const m4p = m4pDescriptor ? tailTx(m4pDescriptor) : null;

    // cosignTx is deserialized exactly as the server built it — its own
    // blockhash, no heap-frame/CU ixs added — never run through buildBatchTx.
    // It is NOT a TailTxDescriptor and is never rebuilt on expiry (see the
    // TailTxDescriptor comment above).
    const orderedTxs: Transaction[] = [m1, ...(cosignTx ? [cosignTx] : []), ...(m2 ? [m2] : []), ...(m3a ? [m3a] : []), m3b, m4a, ...(m4p ? [m4p] : []), m4b];
    // Human-readable label per batched tx, in the SAME order — the progress UI
    // shows what is being CREATED ("Creating the market", "Funding liquidity"),
    // never internal transaction indices. A launching user cares about market
    // milestones, not our tx-packing scheme.
    const orderedLabels: string[] = [
      m1Descriptor.label,
      ...(cosignTx ? ["Connecting the price feed"] : []),
      ...(includeM2 ? [m2Descriptor.label] : []),
      ...(includeM3a ? [m3aDescriptor.label] : []),
      m3bDescriptor.label,
      m4aDescriptor.label,
      ...(m4pDescriptor ? [m4pDescriptor.label] : []),
      m4bDescriptor.label,
    ];

    // M1 is the only batch tx that does not depend on an earlier one landing,
    // so it is the only one that can be simulated now. Doing it before the
    // prompt means a bad InitMarket is explained by us (and falls back to the
    // sequential path, nothing broadcast) rather than shown to the user as the
    // wallet's own "this transaction may fail". The later txs reference the slab
    // M1 creates; wallets that simulate a batch may still flag those, and the
    // only way to avoid that is the sequential path.
    await presimulateOrThrow(connection, m1);

    // ---- ONE wallet approval for the whole batch --------------------------
    setState((s) => ({ ...s, phase: "awaiting-signature", stepLabel: "Approve the transaction batch in your wallet..." }));
    let lastSignMs = 0;
    const signStartedAt = Date.now();
    const signedTxs = await signAllCompat(wallet, orderedTxs);
    lastSignMs = Date.now() - signStartedAt;

    // ---- Partial-sign keypairs AFTER the wallet signs (Privy embedded
    //      wallets can strip unknown signatures added before their own
    //      signing flow runs — mirrors lib/tx.ts's sendTx ordering) --------
    let idx = 0;
    const signedM1 = signedTxs[idx++];
    const signedCosign = cosignTx ? signedTxs[idx++] : null;
    const signedM2 = m2 ? signedTxs[idx++] : null;
    const signedM3a = m3a ? signedTxs[idx++] : null;
    const signedM3b = signedTxs[idx++];
    const signedM4a = signedTxs[idx++];
    const signedM4p = m4p ? signedTxs[idx++] : null;
    const signedM4b = signedTxs[idx++];
    if (!signedM1 || (m2 && !signedM2) || (m3a && !signedM3a) || !signedM3b || !signedM4a || !signedM4b || (m4p && !signedM4p)) {
      throw new Error("Wallet did not return a signature for every transaction in the batch.");
    }
    signedM1.partialSign(slabKp);
    if (signedM2) signedM2.partialSign(lpPortfolioKp, matcherCtxKp);
    if (signedM4p && vaultLpPortfolioKp && vaultLpCtxKp) signedM4p.partialSign(vaultLpPortfolioKp, vaultLpCtxKp);
    signedM4b.partialSign(stakeLpMintKp, stakeVaultKp);

    // ---- Mutable tail state for blockhash-expiry recovery -----------------
    // `signedTail[i]` is the CURRENTLY-SIGNED transaction for `tailDescriptors[i]`
    // — starts as the one-approval batch's own signatures; `recoverTailFrom`
    // below (defined after `landed`/`landingTotal`/`orderedLabels` exist, just
    // before the pipelined broadcast starts) overwrites entries in place if a
    // not-yet-landed one has to be rebuilt against a fresh blockhash.
    const signedTail: Transaction[] = [signedM1, ...(signedM2 ? [signedM2] : []), ...(signedM3a ? [signedM3a] : []), signedM3b, signedM4a, ...(signedM4p ? [signedM4p] : []), signedM4b];
    let blockhashRecoveries = 0;

    // ---- Persist recovery state BEFORE the first broadcast ---------------
    saveInFlightMarket({
      slabAddress: slabPk.toBase58(),
      slabSecretKey: Array.from(slabKp.secretKey),
      adminAddress: walletPk.toBase58(),
      collateralAta: vaultAta.toBase58(),
      collateralMint: params.mint.toBase58(),
      programId: programId.toBase58(),
      network: isDevnetEnv ? "devnet" : "mainnet",
      createdAt: Date.now(),
      lastStep: 0,
    });

    // ---- Pipelined broadcast ----------------------------------------------
    broadcastStarted = true;
    const landingTotal = orderedTxs.length;
    let landed = 0;
    const advanceLanding = (sig?: string) => {
      landed += 1;
      setState((s) => ({
        ...s,
        txSigs: sig ? [...s.txSigs, sig] : s.txSigs,
        phase: "landing",
        landingIndex: landed,
        landingTotal,
        landingLabels: orderedLabels,
        // Label the step now IN PROGRESS (the one after what just landed);
        // once everything has landed, show the finishing state.
        stepLabel: orderedLabels[landed] ?? "Finishing up",
      }));
    };
    setState((s) => ({
      ...s,
      phase: "landing",
      landingIndex: 0,
      landingTotal,
      landingLabels: orderedLabels,
      stepLabel: orderedLabels[0],
    }));

    /**
     * Rebuild + re-sign `tailDescriptors[startIdx..]` (the not-yet-landed
     * remainder of the tail) against a fresh blockhash, in ONE additional
     * wallet approval, and write the results back into `signedTail`.
     * Preserves the exact partial-sign ordering the happy path uses (wallet
     * signs first, then keypairs — see the partial-sign comment above).
     */
    const recoverTailFrom = async (startIdx: number): Promise<void> => {
      // GH#2623: the direct gate against the "keeps popping up after
      // navigating away" complaint — this is the ONLY place in the batched
      // fast path that prompts a fresh wallet signature outside the user's
      // own initiating click. Checked before anything else so an aborted
      // caller never sees another popup, and before blockhashRecoveries is
      // incremented so an aborted attempt doesn't spend the recovery budget.
      if (abortSignal?.aborted) {
        throw new TxCancelledError("Market creation cancelled — you navigated away before this step finished.");
      }
      blockhashRecoveries += 1;
      setState((s) => ({
        ...s,
        phase: "awaiting-signature",
        stepLabel: "Blockhash expired — refreshing and re-approving the remaining steps...",
      }));
      const freshBlockhash = await getFreshBlockhash(connection, true);
      const rebuiltDescriptors = tailDescriptors.slice(startIdx);
      const rebuiltTxs = rebuiltDescriptors.map((d) => buildTailTx(d, freshBlockhash));
      const resignStartedAt = Date.now();
      const resigned = await signAllCompat(wallet, rebuiltTxs);
      lastSignMs = Date.now() - resignStartedAt;
      for (let j = 0; j < rebuiltDescriptors.length; j++) {
        const descriptor = rebuiltDescriptors[j];
        const tx = resigned[j];
        if (!descriptor || !tx) {
          throw new Error("Wallet did not return a signature for every transaction in the blockhash-recovery batch.");
        }
        if (descriptor.signers.length > 0) tx.partialSign(...descriptor.signers);
        signedTail[startIdx + j] = tx;
      }
      setState((s) => ({
        ...s,
        phase: "landing",
        landingTotal,
        landingLabels: orderedLabels,
        stepLabel: orderedLabels[landed] ?? "Finishing up",
      }));
    };

    /**
     * Broadcast `signedTail[idx]` (one of M1/M2/M3a/M3b/M4), recovering ONCE
     * per expiry (capped at `MAX_BLOCKHASH_RECOVERIES` total) if it fails
     * with a blockhash-expiry error — never re-broadcasts a stale signed tx;
     * `recoverTailFrom` always produces a fresh one first. Any other error
     * (or expiry past the cap) rethrows unchanged, so the existing
     * fatal/non-fatal handling around each call site is untouched.
     */
    const broadcastTailTx = async (idx: number): Promise<string> => {
      for (;;) {
        try {
          const tx = signedTail[idx];
          if (!tx) throw new Error(`Missing signed transaction for tail step ${idx}.`);
          return await broadcastSignedTx(connection, tx);
        } catch (err) {
          const action = expiredBlockhashAction({ tailIdx: idx, lastSignMs, recoveriesUsed: blockhashRecoveries });
          const canRecover = action === "resign-batch";
          // Slow signer, nothing landed: stop asking and let the sequential path run in this
          // same create() call. Safe because the signed tx was never accepted (a send
          // rejected as expired, or a timeout with the signature definitively absent).
          const abandonToSequential = (): never => {
            broadcastStarted = false;
            throw new Error(
              `approving every step up front took ${Math.round(lastSignMs / 1000)}s, longer than the transactions stay valid; approving step by step instead`,
              { cause: err },
            );
          };

          // Case A — the SEND was rejected as expired (no signature exists, the
          // tx never landed): safe to rebuild against a fresh blockhash.
          if (isBlockhashExpiredError(err) && action === "sequential-fallback") abandonToSequential();
          if (isBlockhashExpiredError(err) && canRecover) {
            console.warn(
              `[useCreateMarket] batch: blockhash expired at tail step ${idx} — recovering (attempt ${blockhashRecoveries + 1}/${MAX_BLOCKHASH_RECOVERIES})`,
            );
            await recoverTailFrom(idx);
            continue; // retry the SAME step with the freshly rebuilt+signed tx
          }

          // Case B — the tx was SUBMITTED but confirmation timed out at the edge
          // of the blockhash window; it may still have landed. Status-check the
          // signature FIRST (mirrors sendTx's R2-S7 landing check) — only rebuild
          // if it is DEFINITIVELY absent. On "landed" treat as success; on any
          // indeterminate result (RPC error, on-chain failure, processed-not-
          // confirmed) propagate rather than risk re-running a landed createAccount.
          if (isConfirmationTimeoutError(err)) {
            // The landing-check is free (one RPC read) and ALWAYS safe, so it
            // runs regardless of the recovery budget — a tx that already landed
            // must be reported as success even after the rebuild cap is spent,
            // otherwise a fully-successful launch gets reported as a failure.
            // Only the REBUILD leg is gated on `canRecover`.
            const sig = (err as { signature?: string }).signature;
            const landed = sig ? await checkSignatureLanded(connection, sig) : "unknown";
            if (landed === "landed" && sig) {
              console.warn(
                `[useCreateMarket] batch: tail step ${idx} confirmation timed out but the tx DID land — continuing`,
              );
              return sig; // it's on-chain; treat exactly like a normal success
            }
            if (landed === "not-found" && action === "sequential-fallback") abandonToSequential();
            if (landed === "not-found" && canRecover) {
              console.warn(
                `[useCreateMarket] batch: tail step ${idx} timed out and did not land — recovering (attempt ${blockhashRecoveries + 1}/${MAX_BLOCKHASH_RECOVERIES})`,
              );
              await recoverTailFrom(idx);
              continue;
            }
            // "unknown" (indeterminate — never rebuild), or "not-found" with the
            // recovery budget exhausted → fall through and propagate (resumable).
          }
          throw err;
        }
      }
    };

    const m1Sig = await broadcastTailTx(tailIdx(m1Descriptor));
    if (keeperRequestBase) saveProofTx(slabPk.toBase58(), m1Sig);
    setState((s) => ({ ...s, slabAddress: slabPk.toBase58(), keeperProofTx: keeperRequestBase ? m1Sig : null }));
    advanceLanding(m1Sig);
    // With a keeper hand-off still to land, a resume must run step 1 (which
    // skips the hand-off itself once it is on-chain); without one, step 1 has
    // nothing left to do (M1 carried SetNftProgramId).
    resumeStep = signedCosign ? 1 : 2;
    updateInFlightStep(slabPk.toBase58(), resumeStep);

    // ZOMBIE-MARKET FIX (2026-07-27): this POST is what makes a market VISIBLE
    // in the app. It used to fire here, immediately after M1, in parallel with
    // the funding steps — so a launch that died at M3a (which is exactly what
    // happened to ANSEM: slab + LP portfolio created, deposit never landed,
    // steps 4-5 never ran) still published a listed, unfunded, untradeable
    // market. Because "create the market" is always step 1 and always succeeds,
    // EVERY failed launch left one behind.
    //
    // Now it is deferred: `registerMarketInDb()` is called only after M3a
    // (DepositCollateral + backing seed) has landed, so a market becomes
    // visible only once it actually holds collateral. A launch that dies before
    // then leaves an on-chain slab nobody sees, instead of a broken listing.
    //
    // keeper-register is NOT deferred — it must still run before M4, because
    // StakeInitPool rotates marketauth and keeper-register's H1 check requires
    // marketauth to still equal the deployer.
    // POST /api/markets is gone: keeper-register now writes the markets row
    // itself, so a launch makes ONE registration call.
    //
    // It had to go, not just move. It 409s when a row already exists
    // ("metadata is immutable via this endpoint") and this call site swallowed
    // that as non-fatal, while the indexer inserts a row for any slab it
    // discovers within ~60s. The slab exists before this ran, so the indexer
    // usually won: measured 2026-07-30, all 5 rows on the live DB were
    // metadata_source='auto' and this endpoint had never once created one.
    // Registration now happens under the marketauth proof, which can safely
    // overwrite an 'auto' row. See lib/market-registration.ts.
    if (signedCosign) {
      failingKind = "oracle-delegation";
      failingLabel = "Connecting the price feed";
      const cosignSig = await broadcastSignedTx(connection, signedCosign);
      advanceLanding(cosignSig);
      resumeStep = 2;
      updateInFlightStep(slabPk.toBase58(), 2);
    }

    if (includeM2) {
      failingKind = "lp-init";
      failingLabel = m2Descriptor.label;
      const m2Sig = await broadcastTailTx(tailIdx(m2Descriptor));
      advanceLanding(m2Sig);
    }
    resumeStep = 3;
    updateInFlightStep(slabPk.toBase58(), 3);

    if (includeM3a) {
      failingKind = "funding";
      failingLabel = m3aDescriptor.label;
      const m3aSig = await broadcastTailTx(tailIdx(m3aDescriptor));
      advanceLanding(m3aSig);
    }

    // The market now holds collateral and both backing domains are seeded, so
    // it is safe to publish. Fired without awaiting — a slow DB write must not
    // delay M3b/M4, and it is awaited once at the end of the tail.

    // REGISTRATION — deliberately pinned to this window, between M3a and M4.
    //
    // It used to be created before M2, which was safe while it only wrote the
    // keeper's blob. It now writes the `markets` row, and that row is what
    // LISTS the market. Firing it earlier would republish the zombie bug this
    // ordering exists to prevent: registration used to fire right after M1, so
    // any launch that died later still published a listed, unfunded,
    // untradeable market (that is what happened to the ANSEM market).
    //
    // It also cannot move any LATER: M4's StakeInitPool rotates marketauth away
    // from the deployer, and keeper-register's H1 check requires marketauth to
    // still equal the deployer. After M3a and before M4 is the only window that
    // satisfies both constraints.
    // #2464: this used to be STARTED here and awaited after the insurance check,
    // so the registration request was already in flight — and could already have
    // completed — while that check was still deciding whether the launch had
    // failed. A launch that threw on an unseeded insurance fund could therefore
    // leave the market listed and keeper-registered anyway.
    //
    // It is now a THUNK, invoked below only once insurance has verified. The
    // window it must run in is unchanged and still satisfied: after M3a (so a
    // market is only listed once it holds collateral) and before M4 (whose
    // StakeInitPool rotates marketauth away from the deployer, which
    // keeper-register's H1 check requires).
    //
    // The cost is latency: the round-trip no longer overlaps M3b's broadcast, so
    // the tail sits a little longer against the shared blockhash. That is the
    // right trade — the blockhash-expiry path already REBUILDS a not-yet-landed
    // tail tx (see TailTxDescriptor), whereas an incorrectly published market has
    // no equivalent undo.
    // UX WP-7: registration no longer has to run before StakeInitPool (the proof is the creation
    // tx, not the live marketauth), so the batch never waits for it: the hook starts a background
    // loop once the launch lands. The markets-row payload is built now and kept for that loop.
    if (keeperRequestBase && keeperPayload) rememberRegistrationPayload(slabPk.toBase58(), keeperPayload);

    // M3b carries the insurance seed, which is NOT optional: it is the layer
    // that absorbs losses before the LP does. This used to swallow every
    // failure, so a market could come up with insurance = 0 and nothing said so.
    //
    // Assert the OUTCOME rather than the transaction result. M3b bundles
    // TopUpInsurance with a best-effort PermissionlessCrank, so a crank revert
    // rolls the deposit back even though the deposit itself was fine — and a
    // skipped build (see the idempotency check in the sequential path) produces
    // no error at all. Reading the engine's own insuranceBalance afterwards
    // catches all three: never built, reverted, and partially applied.
    let m3bError: unknown = null;
    failingKind = "insurance";
    failingLabel = m3bDescriptor.label;
    try {
      const m3bSig = await broadcastTailTx(tailIdx(m3bDescriptor));
      advanceLanding(m3bSig);
    } catch (err) {
      m3bError = err;
      advanceLanding(undefined);
    }

    if (params.insuranceAmount > 0n) {
      let insuranceOnChain = 0n;
      try {
        const slabInfo = await connection.getAccountInfo(slabPk);
        if (slabInfo?.data) {
          insuranceOnChain = parseMarketGroupV17OI(new Uint8Array(slabInfo.data)).insuranceBalance;
        }
      } catch {
        // Fall through — an unverifiable seed is treated as a failed one.
      }
      if (insuranceOnChain < params.insuranceAmount) {
        throw new Error(
          `Insurance fund was not seeded (on-chain ${insuranceOnChain} < requested ${params.insuranceAmount}). ` +
            "The market exists and is funded — retry this step to seed it." +
            (m3bError ? ` Cause: ${m3bError instanceof Error ? m3bError.message : String(m3bError)}` : ""),
        );
      }
    } else if (m3bError) {
      // No insurance requested — the crank alone stays best-effort.
      console.warn("[useCreateMarket] batch: post-LP crank failed (non-fatal):", m3bError);
    }
    resumeStep = 4;
    updateInFlightStep(slabPk.toBase58(), 4);

    // #2464: started HERE, not above — everything that can fail the launch has
    // now run, so no externally visible registration happens for a launch that is
    // about to be reported as failed.

    // M4a: CreateLpVault alone (see the M4-split fix note above the descriptor
    // definitions) — this is the "Creating Earn vault..." step (STEP_LABELS[4]).
    // Landing it as its OWN transaction, separately from the stake-pool tail,
    // means a failure here is reported (and resumable) as exactly what it is,
    // and never drags in the much larger/riskier M4b bundle.
    failingKind = "earn-vault";
    failingLabel = m4aDescriptor.label;
    const m4aSig = await broadcastTailTx(tailIdx(m4aDescriptor));
    advanceLanding(m4aSig);
    resumeStep = 5;
    updateInFlightStep(slabPk.toBase58(), 5);

    // M4p (P3): bind the vault-owned LP + the creator's junior tranche. Resume stays at step 5,
    // whose sequential path re-checks the binding on-chain (ensureP3Bound) before the stake tail.
    if (m4pDescriptor) {
      failingKind = "vault-lp";
      failingLabel = m4pDescriptor.label;
      const m4pSig = await broadcastTailTx(tailIdx(m4pDescriptor));
      advanceLanding(m4pSig);
    }

    // M4b: mint/vault creation + [UpdateFeeSplit] + StakeInitPool + BindInsuranceAuthority.
    // MUST run after M4a (CreateLpVault is marketauth-gated; StakeInitPool here
    // irreversibly rotates marketauth to the pool PDA) and after keeper-register
    // above (same marketauth-rotation constraint that used to gate the old
    // single M4).
    failingKind = "stake-pool";
    failingLabel = m4bDescriptor.label;
    const m4bSig = await broadcastTailTx(tailIdx(m4bDescriptor));
    advanceLanding(m4bSig);
    resumeStep = 6;
    updateInFlightStep(slabPk.toBase58(), 6);


    // #2608/#2610: this used to fire a background POST /api/devnet-airdrop here,
    // duplicating the claim the "GET SIM-USDC & TRADE" button on the success
    // screen already makes on click (LaunchSuccess.tsx's handleMintAndTrade) —
    // every failure mode of that duplicate call (500, 429, network error) put an
    // unreportable error banner or a permanently-stuck spinner on the most
    // important screen in the product. Removed: the button beside it does the
    // identical job, and the creator clicks it to reach the trade page anyway,
    // so nothing is lost. Still set devnetMint synchronously so that button renders.
    if (isDevnetEnv) {
      setState((s) => ({ ...s, devnetMint: params.mint.toBase58() }));
    }

    clearInFlightMarket(slabPk.toBase58());
    setState((s) => ({
      ...s,
      loading: false,
      step: 6,
      phase: "done",
      stepLabel: "Market created!",
      keeperDelegated: false,
      keeperMessage: keeperRequestBase ? KEEPER_REGISTER_COPY.connecting : s.keeperMessage,
      priceFeedRequired: !!(isKeeperOracle && params.dexPoolAddress),
      slabAddress: slabPk.toBase58(),
    }));

    return { status: "success" };
  } catch (err) {
    if (!broadcastStarted && err instanceof PreFundRateLimitedError) {
      // Not a fallback case: the sequential path cannot fund this launch either.
      // Nothing was broadcast, so also drop the batch phase UI.
      setState((s) => ({
        ...s, loading: false, error: preFundRateLimitedMessage(err.nextClaimAt),
        step: 0, stepLabel: "", phase: "idle", landingIndex: 0, landingTotal: 0,
      }));
      return { status: "fatal" };
    }
    if (!broadcastStarted) {
      // Nothing landed — safe to fall back to the sequential path in the
      // SAME create() call. See the FALLBACK CONTRACT note above.
      //
      // Carry the reason out. The fallback is silent BY DESIGN for the user's
      // funds (nothing broadcast, the launch still completes) but it was also
      // silent for diagnosis, which is a different thing and not a feature:
      // the batch has several unrelated ways to throw before broadcast — a
      // 429 from /api/devnet-pre-fund's 1h faucet gate, a keeper co-sign
      // failure, an airdrop that did not confirm — and they are
      // indistinguishable from the outside.
      const reason = describeBatchFallback(err);
      console.warn(
        `[useCreateMarket] BATCHED launch fell back to the 6-step sequential path: ${reason}`,
      );
      return { status: "fallback", reason };
    }
    // GH#2623: distinct from a real failure — the launch was abandoned (the
    // wizard unmounted), not rejected or errored. parseMarketCreationError's
    // "User rejected"/"Transaction cancelled" branch reads as a wallet
    // decline and tells the user to click Retry; that is the wrong message
    // for a page they already left. "fatal" is still the right STATUS (never
    // fall back to the sequential path here — something is already
    // broadcast; resuming goes through RecoverSolBanner like any other
    // abandoned launch), just with an accurate reason.
    const msg = isTxCancelledError(err)
      ? "Market creation cancelled — navigated away before it finished."
      : parseMarketCreationError(err, { step: failingKind, stepLabel: failingLabel });
    // `step` drives Retry (CreateMarketWizard.handleRetry passes it straight to
    // create()), so it must name the step to resume from, not 0.
    setState((s) => ({ ...s, loading: false, error: msg, step: resumeStep, stepLabel: STEP_LABELS[resumeStep] ?? s.stepLabel }));
    return { status: "fatal" };
  }
}

// UX WP-7 (§3.15): plain step labels (lib/wizard-copy.ts).
const STEP_LABELS = [
  WIZARD_STEP_COPY.createMarket,
  WIZARD_STEP_COPY.priceSource,
  WIZARD_STEP_COPY.liquidity,
  WIZARD_STEP_COPY.funding,
  WIZARD_STEP_COPY.earnVault,
  WIZARD_STEP_COPY.stakePool,
];

export function useCreateMarket() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [state, setState] = useState<CreateMarketState>({
    step: 0,
    stepLabel: "",
    txSigs: [],
    slabAddress: null,
    error: null,
    loading: false,
    devnetMint: null,
    insuranceMintFailed: false,
    backingSeedFailed: false,
    keeperDelegated: false,
    keeperMessage: null,
    keeperRegistering: false,
    priceFeedRequired: false,
    phase: "idle",
    landingIndex: 0,
    landingTotal: 0,
    batchFallbackReason: null,
  });

  // PERC-8329 / GH#1964: Slab keypair is normally kept in-memory ONLY (this ref), not
  // localStorage — persisting a secret key there is unsafe in general (any same-origin
  // script, including browser extensions, can read it).
  //
  // BUG 7 fix (2026-07-06): that policy is INTENTIONALLY superseded for the in-flight
  // recovery flow — saveInFlightMarket() (called from Step 0 below) DOES persist
  // slabSecretKey to localStorage specifically so the ReclaimSlabRent / resume-creation
  // path still works after a tab close (see lib/inFlightMarket.ts's header for the
  // accepted trade-off). Nothing previously read that persisted secret back into this
  // ref on mount, so a page refresh mid-flow always hit "Cannot retry: slab keypair
  // lost" even though the secret was sitting in localStorage the whole time. The effect
  // below hydrates it; restoreSlabKeypair lets RecoverSolBanner's onResume hand the
  // keypair back in explicitly (belt-and-suspenders for the same-session resume path).
  const slabKpRef = useRef<Keypair | null>(null);

  /**
   * GH#2623: a fresh controller per `create()` call — never re-abort a
   * previous, already-finished launch's controller, and never leave a NEW
   * launch permanently aborted because an earlier one was cancelled. See
   * `cancelInFlightLaunch` (below) and CreateMarketWizard's unmount cleanup,
   * the only current caller: leaving `/create` mid-launch must stop the
   * wallet-popup retry loop (see `sendTx`'s and `recoverTailFrom`'s abort
   * checks in lib/tx.ts / above) instead of it continuing on a page the user
   * is no longer looking at.
   */
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelInFlightLaunch = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (slabKpRef.current) return; // already have a keypair this session — don't clobber it
    if (!wallet.publicKey) return; // wait for wallet connection so we can verify ownership
    const inFlight = loadLastInFlightMarket();
    if (!inFlight) return;
    // Wallet-match gate mirrors useStuckSlabs' security check — never attach another
    // wallet's persisted slab secret to this session.
    if (inFlight.adminAddress !== wallet.publicKey.toBase58()) return;
    if (!inFlight.slabSecretKey || inFlight.slabSecretKey.length !== 64) return;
    try {
      const kp = Keypair.fromSecretKey(Uint8Array.from(inFlight.slabSecretKey));
      slabKpRef.current = kp;
      setState((s) => (s.slabAddress ? s : { ...s, slabAddress: inFlight.slabAddress }));
    } catch (err) {
      console.warn("[useCreateMarket] Failed to hydrate slab keypair from in-flight state:", err);
    }
  }, [wallet.publicKey]);

  /**
   * BUG 7 fix: explicit hydration entry point for the "Resume Creation" / "Retry
   * Initialization" flow. RecoverSolBanner's onResume callback only forwards
   * (slabAddress, fromStep), so the caller (CreateMarketWizard) independently calls
   * useStuckSlabs() to get the already-reconstructed Keypair and hands it here — belt-
   * and-suspenders alongside the mount effect above (which could race a fresh wallet
   * connection on the same render).
   */
  const restoreSlabKeypair = useCallback((keypair: Keypair, slabAddress: string) => {
    slabKpRef.current = keypair;
    setState((s) => ({ ...s, slabAddress }));
  }, []);

  // UX WP-7: the background keeper-registration loop (no signature; the proof is the creation tx).
  const keeperLoopRef = useRef<AbortController | null>(null);
  useEffect(() => () => keeperLoopRef.current?.abort(), []);
  const startKeeperLoop = useCallback((params: CreateMarketParams, slab: string) => {
    if (!params.dexPoolAddress) return;
    const proofTx = loadProofTx(slab);
    if (!proofTx) {
      setState((s) => ({ ...s, keeperPhase: "failed", keeperMessage: KEEPER_REGISTER_COPY.noProof }));
      return;
    }
    keeperLoopRef.current?.abort();
    const ac = new AbortController();
    keeperLoopRef.current = ac;
    const request = {
      slabAddress: slab,
      mainnetCA: params.mainnetCA ?? null,
      dexPoolAddress: params.dexPoolAddress,
      dexType: normalizeDexType(params.dexType) ?? null,
      symbol: params.symbol ?? null,
      payload: recallRegistrationPayload(slab),
      proofTx,
    };
    // Saved so a later visit can resume a registration this page did not finish
    // (lib/keeper-register-client.ts resumePendingRegistrations).
    saveRegisterRequest({ slabAddress: slab, mainnetCA: request.mainnetCA, dexPoolAddress: request.dexPoolAddress, dexType: request.dexType, symbol: request.symbol });
    setState((s) => ({ ...s, keeperPhase: "connecting", keeperMessage: KEEPER_REGISTER_COPY.connecting }));
    void runKeeperRegistration({
      attempt: () => postKeeperRegistration(request),
      signal: ac.signal,
      onStatus: ({ phase, message }) => {
        if (phase === "ready") markRegistered(slab);
        setState((s) => ({ ...s, keeperPhase: phase, keeperMessage: message, keeperDelegated: phase === "ready" || s.keeperDelegated }));
      },
    });
  }, []);

  const create = useCallback(
    async (params: CreateMarketParams, retryFromStep?: number) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState((s) => ({ ...s, error: "Wallet not connected" }));
        return;
      }
      // GH#2623: a fresh controller for THIS call. Threaded into every
      // wallet-signing primitive below (attemptFreshBatchedLaunch's
      // recoverTailFrom, and every sequential sendTx call) so
      // cancelInFlightLaunch() — called on CreateMarketWizard unmount — stops
      // any FUTURE signing prompt without touching a step already broadcast.
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const abortSignal = abortController.signal;

      // Idempotent: the wizard already resolved these; any other caller gets the same rule, so the
      // memo-bound symbol and the payload's symbol/name always agree and pass the route.
      params = {
        ...params,
        ...resolveMarketMetadata({ symbol: params.symbol, name: params.name, mint: params.mainnetCA ?? params.mint.toBase58() }),
      };
      // Refuse before any wallet prompt or RPC write if the registration could never be accepted.
      try {
        assertRegistrable(params.symbol, buildMarketRegistrationPayload({
          slabAddress: PublicKey.default.toBase58(), params, deployer: wallet.publicKey.toBase58(),
          oracleMode: params.oracleMode ?? "admin", isAdminOracle: params.oracleMode === "admin", isDevnetEnv: false,
        }));
      } catch (e) {
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
        return;
      }

      // Every risk parameter for this market, derived from the creator's
      // leverage and LP seed (see lib/market-params.ts). Shared by the
      // sequential path's InitMarket + InitMatcherCtx sites below, exactly as
      // the merged path derives its own copy.
      const derived = deriveLaunchMarketParams(params);
      const backingSeed = backingSeedPerDomain(params.lpCollateral);

      // P3: refuse a junior requirement the program (or the cushion floor) would refuse BEFORE
      // anything is broadcast — a throw later would leave a half-built market (M4p sits after
      // M4a) and the batched path would fall back to the sequential one first.
      if (params.p3) {
        const issue = validateP3Wizard({
          juniorFloorBps: params.p3.juniorFloorBps,
          juniorAtoms: params.p3.juniorAtoms,
          seedNavAtoms: 2n * backingSeedPerDomain(params.lpCollateral),
        });
        if (issue) {
          setState((s) => ({ ...s, error: P3_WIZARD_ISSUE_COPY[issue] }));
          return;
        }
        if (params.p3.juniorAtoms > params.lpCollateral) {
          setState((s) => ({ ...s, error: P3_WIZARD_ISSUE_COPY["junior-above-liquidity"] }));
          return;
        }
      }

      // Select program based on slab tier — each MAX_ACCOUNTS variant is a separate deployment
      const cfg = getConfig();
      // PERC-277: Default to 4096 (large) — the main devnet program binary is compiled for
      // MAX_ACCOUNTS=4096. Using a smaller tier against a 4096-account program causes
      // InvalidSlabLen (error 0x4) because the program's hardcoded SLAB_LEN won't match.
      type SlabTier = "small" | "medium" | "large";
      const tierMap: Record<number, SlabTier> = { 256: "small", 1024: "medium", 4096: "large" };
      const tierKey: SlabTier = tierMap[params.maxAccounts ?? 4096] ?? "large";
      const selectedProgramId = cfg.programsBySlabTier?.[tierKey] ?? cfg.programId;
      const programId = new PublicKey(selectedProgramId);
      // PERC-470: Oracle mode detection
      // - "pyth": index_feed_id = pyth hex, uses KeeperCrank with Pyth PDA
      // - "hyperp": index_feed_id = zeros, uses UpdateHyperpMark (reads DEX pool directly)
      // - "admin": index_feed_id = zeros, uses PushOraclePrice + KeeperCrank
      // PERC-devnet: detect the runtime network instead of inferring it from
      // params.mainnetCA. mainnetCA identifies mirrored-token metadata and is
      // populated for mainnet market creation as well.
      const network = getNetwork();
      const isDevnetEnv = network === "devnet";

      const resolvedOracleMode =
        params.oracleMode ??
        (params.oracleFeed === ALL_ZEROS_FEED ? "admin" : "pyth");

      // Hyperp reads live DEX pool accounts on-chain. Mainnet pool accounts are
      // unavailable for devnet mirrors, so only that exact combination falls
      // back to Admin. Mainnet Hyperp must remain Hyperp.
      const oracleMode = resolveMarketOracleMode({
        requestedMode: resolvedOracleMode,
        network,
        hasMainnetCA: !!params.mainnetCA,
      });

      const isAdminOracle = oracleMode === "admin";
      const isHyperpOracle = oracleMode === "hyperp";
      const isKeeperOracle = oracleMode === "keeper";
      // UX WP-7: the keeper-registration memo for a sequential InitMarket (same binding as the
      // batch: lib/keeper-register-memo.ts). Empty when the market is not keeper-priced.
      // Memo v2 also binds the markets-row payload, built here and remembered for the loop.
      const seqKeeperMemo = async (creator: PublicKey, slab: PublicKey): Promise<TransactionInstruction[]> => {
        if (!isKeeperOracle || !params.dexPoolAddress) return [];
        const payload = buildMarketRegistrationPayload({ slabAddress: slab.toBase58(), params, deployer: creator.toBase58(), oracleMode, isAdminOracle, isDevnetEnv });
        assertRegistrable(params.symbol, payload);
        rememberRegistrationPayload(slab.toBase58(), payload);
        return [
          await buildKeeperRegisterMemoIx(
            creator,
            await keeperMemoParams({
              slabAddress: slab.toBase58(),
              mainnetCA: params.mainnetCA ?? null,
              dexPoolAddress: params.dexPoolAddress,
              dexType: normalizeDexType(params.dexType) ?? null,
              symbol: params.symbol ?? null,
              payload,
            }),
          ),
        ];
      };

      // PERC-470: Resolve DEX pool vault addresses for hyperp mode
      // If vaults weren't provided, fetch the pool account on-chain
      if (isHyperpOracle && params.dexPoolAddress && !params.dexBaseVault) {
        try {
          const poolPk = new PublicKey(params.dexPoolAddress);
          const poolAccount = await connection.getAccountInfo(poolPk);
          if (poolAccount?.data) {
            const dexType = detectDexType(poolAccount.owner);
            if (dexType) {
              const poolInfo = parseDexPool(dexType, poolPk, poolAccount.data);
              if (poolInfo.baseVault) params.dexBaseVault = poolInfo.baseVault.toBase58();
              if (poolInfo.quoteVault) params.dexQuoteVault = poolInfo.quoteVault.toBase58();
            }
          }
        } catch (e) {
          console.warn("PERC-470: Failed to resolve DEX pool vaults:", e);
        }
      }

      const startStep = retryFromStep ?? 0;
      if (retryFromStep !== undefined) {
        // Diagnosis breadcrumb (see signAllCompat's counterpart): resume and
        // retry flows use the sequential per-step path BY DESIGN — if a user
        // reports many signature prompts and this line is in their console,
        // they were resuming a stuck launch, not missing the batch path.
        console.info(`[useCreateMarket] resume/retry from step ${retryFromStep} — sequential flow by design`);
      }

      setState((s) => ({
        ...s,
        loading: true,
        error: null,
        step: startStep,
        stepLabel: STEP_LABELS[startStep],
        // Cleared on EVERY attempt, including retries. This is a spread, so a
        // reason left by an earlier fallback would otherwise survive into a
        // retry that never attempted the batch at all — and be rendered under
        // it, explaining a decision this attempt never made.
        batchFallbackReason: null,
        ...(startStep === 0 ? { txSigs: [], slabAddress: null } : {}),
      }));

      // PERC-8329: Slab keypair lives in memory only — no localStorage persistence.
      // Retries within the same session reuse slabKpRef.current. Page refresh requires restart.
      let slabKp: Keypair;
      let slabPk: PublicKey;
      let vaultAta: PublicKey;

      if (startStep === 0) {
        // W5 fix (2026-07-08): RecoverSolBanner's "RETRY INITIALIZATION" button calls
        // onResume(stuckSlabAddress, 0) after CreateMarketWizard already handed us the
        // STUCK slab's reconstructed keypair via restoreSlabKeypair() (populating
        // slabKpRef.current). Unconditionally generating a fresh keypair here — as this
        // branch used to do — ignored that and created a brand-new slab account,
        // orphaning the original stuck one (and its already-paid rent) instead of
        // retrying InitMarket on it. Only reuse the ref when retryFromStep is EXPLICITLY
        // 0 (a real retry/resume click) — not merely when it's undefined (a genuine
        // brand-new "Launch Market" click), where slabKpRef.current could still be
        // hydrated from a stale in-flight entry the user hasn't discarded yet (see the
        // mount effect above).
        if (retryFromStep === 0 && slabKpRef.current) {
          slabKp = slabKpRef.current;
          slabPk = slabKp.publicKey;
        } else {
          slabKp = Keypair.generate();
          slabKpRef.current = slabKp;
          slabPk = slabKp.publicKey;
        }
        // PERC-8329: Do NOT persist secret key to localStorage — keep in memory only.
        // If the user refreshes before completing all steps, they must start over.
      } else if (slabKpRef.current) {
        // Retry with persisted keypair — full functionality
        slabKp = slabKpRef.current;
        slabPk = slabKp.publicKey;
      } else if (state.slabAddress) {
        // Keypair lost (page refresh) but we have the address — limited retry (steps > 0 only)
        slabPk = new PublicKey(state.slabAddress);
        slabKp = null as unknown as Keypair;
      } else {
        setState((s) => ({
          ...s,
          loading: false,
          error: "Cannot retry: slab keypair lost. Please start over.",
        }));
        return;
      }

      let [vaultPda] = deriveVaultAuthority(programId, slabPk);

      // v17: PushOraclePrice (tag 16) and SetOracleAuthority (tag 17) do not exist.
      // For devnet bring-up, the v17 program is always assumed — detect lazily per-step
      // if needed. Setting isLegacyOracle = false skips all removed oracle instructions.
      // TODO: When v12 legacy support is needed, detect from on-chain magic bytes (like Step 1 does).
      const isLegacyOracle = false;

      // Fresh-launch batching fast path (2026-07-12): only a genuine "LAUNCH
      // MARKET" click (retryFromStep === undefined, which is exactly the
      // branch above that generated a brand-new slabKp) attempts this —
      // every resume/retry call passes an explicit step number and always
      // uses the sequential per-step code below unchanged. See
      // `attemptFreshBatchedLaunch`'s header comment for the full contract.
      if (retryFromStep === undefined && wallet.publicKey) {
        console.info("[useCreateMarket] fresh launch — attempting BATCHED flow (one approval)");
        const batchWalletPk = wallet.publicKey;
        const outcome = await attemptFreshBatchedLaunch({
          connection,
          wallet: {
            publicKey: batchWalletPk,
            signTransaction: wallet.signTransaction,
            signAllTransactions: wallet.signAllTransactions,
            signMessage: wallet.signMessage,
          },
          programId,
          slabKp,
          params,
          isDevnetEnv,
          isKeeperOracle,
          isAdminOracle,
          isHyperpOracle,
          oracleMode,
          setState,
          abortSignal,
        });
        if (outcome.status === "success") {
          slabKpRef.current = null;
          if (isKeeperOracle && params.dexPoolAddress) startKeeperLoop(params, slabKp.publicKey.toBase58());
          return;
        }
        if (outcome.status === "fatal") {
          // state.error already set inside attemptFreshBatchedLaunch — do
          // NOT fall through to the sequential path (something already
          // broadcast, or the wallet cannot fund this launch on any path;
          // resuming happens via the existing RecoverSolBanner /
          // handleRetry flow, which passes an explicit step and therefore
          // uses the sequential code below on its own next call).
          return;
        }
        // status === "fallback" — nothing broadcast; safe to run the
        // sequential path below in this SAME call. Reset the phase/landing
        // UI state so LaunchProgress falls back to its per-step rendering.
        // Keep the reason in state, not only in the console — the people who
        // hit this are launching a market, not watching devtools.
        //
        // This is React state and dies with the tab. It does NOT reach the
        // downloaded recovery JSON, which is built from the localStorage
        // in-flight record (RecoveryExportButton -> loadLastInFlightMarket)
        // and never sees CreateMarketState. The fallback happens before
        // anything is on chain, so there is no in-flight record to attach to
        // yet. Noted rather than implied.
        //
        // NOT surfaced as `error`: nothing failed from the user's point of
        // view. The launch continues, just with six prompts instead of one.
        setState((s) => ({
          ...s,
          phase: "idle",
          landingIndex: 0,
          landingTotal: 0,
          error: null,
          batchFallbackReason: outcome.reason,
        }));
      }

      // The sequential step currently running, for the failure message: the
      // same program error means different things at different steps.
      let runningStep = startStep;
      try {
        // Step 0: Create slab + vault ATA + InitMarket (ATOMIC — all-or-nothing)
        // Merged into a single transaction to prevent SOL lock if InitMarket fails.
        // If any instruction fails, the entire tx rolls back — no stuck lamports.
        if (startStep <= 0) {
          runningStep = 0;
          setState((s) => ({ ...s, step: 0, stepLabel: STEP_LABELS[0] }));

          // Fund the deposit BEFORE the market exists. The deposit step used to be the
          // first place this path asked for test tokens, so a wallet inside the faucet's
          // claim window created the market, locked its rent, and only then was refused.
          // Only while the market account is not on chain: a resume of step 0 with a
          // stuck slab, or a market that already landed, has rent to recover or finish
          // and must not be stopped here. (Not keyed on this being a fresh call: Continue
          // after a refusal re-enters with step 0 and nothing on chain, and must be
          // refused again rather than create the market.)
          const marketOnChain0 = isDevnetEnv
            ? (await connection.getAccountInfo(slabPk, "confirmed").catch(() => null)) !== null
            : true;
          if (isDevnetEnv && !marketOnChain0) {
            const balance0 = await collateralBalanceOf(connection, params.mint, wallet.publicKey);
            if (balance0 < fullMarketRequirement(params.lpCollateral, params.insuranceAmount)) {
              let refusal0: ReturnType<typeof classifyPreFundRefusal> = { kind: "proceed" };
              try {
                const fundResp0 = await fetch("/api/devnet-pre-fund", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mintAddress: params.mint.toBase58(),
                    walletAddress: wallet.publicKey.toBase58(),
                    lpCollateral: params.lpCollateral.toString(),
                    insuranceAmount: params.insuranceAmount.toString(),
                  }),
                });
                if (!fundResp0.ok) {
                  refusal0 = classifyPreFundRefusal({
                    status: fundResp0.status,
                    body: await fundResp0.json().catch(() => null),
                    balance: balance0,
                    lpCollateral: params.lpCollateral,
                    insuranceAmount: params.insuranceAmount,
                  });
                }
              } catch {
                // Network error: left to the deposit step's own check and message.
              }
              if (refusal0.kind === "blocked") throw new PreFundRateLimitedError(refusal0.nextClaimAt);
            }
          }

          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);

          // Persist recovery state BEFORE sending TX0. Survives tab close so
          // the user can recover via the in-UI ReclaimSlabRent path even if
          // the browser dies.
          // 2026-05-12: PERC-8329 superseded for this flow — slab secret IS
          // persisted so the uninitialised-slab reclaim works. See
          // lib/inFlightMarket.ts header for trade-off rationale.
          saveInFlightMarket({
            slabAddress: slabPk.toBase58(),
            slabSecretKey: Array.from(slabKp.secretKey),
            adminAddress: wallet.publicKey.toBase58(),
            collateralAta: vaultAta.toBase58(),
            collateralMint: params.mint.toBase58(),
            programId: programId.toBase58(),
            network: isDevnetEnv ? "devnet" : "mainnet",
            createdAt: Date.now(),
            lastStep: 0,
          });

          // Check if slab account already exists (previous attempt may have landed)
          // PERC-1094 fix: also regenerate if the existing slab has the wrong size (stale
          // orphan from old SDK — e.g. 65352-byte account created before ENGINE_OFF fix).
          // Without this check, retries always call InitMarket on the wrong-sized slab and
          // fail with InvalidSlabLen (error 0x4) even after the SDK size was corrected.
          const expectedSlabSize = slabSizeFor(params);
          let existingAccount = await connection.getAccountInfo(slabKp.publicKey);
          if (existingAccount && existingAccount.data.length !== expectedSlabSize) {
            console.warn(
              `[useCreateMarket] PERC-1094: stale slab ${slabKp.publicKey.toBase58()} ` +
              `(${existingAccount.data.length}B, expected ${expectedSlabSize}B). ` +
              `Abandoning orphan and generating fresh keypair.`,
            );
            // PERC-8329: No localStorage cleanup needed — key was never stored there.
            slabKp = Keypair.generate();
            slabKpRef.current = slabKp;
            slabPk = slabKp.publicKey;
            // Recompute PDA and ATA for new slab keypair
            [vaultPda] = deriveVaultAuthority(programId, slabPk);
            vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
            existingAccount = null; // treat as fresh creation
          }
          if (existingAccount) {
            // Slab already created — check if market is initialized via v17 or v12 magic.
            // isV17Account handles the v17 magic; v12 parseHeader handles the PERCOLAT magic.
            let isInitialized: boolean;
            try {
              const existingData = new Uint8Array(existingAccount.data);
              if (isV17Account(existingData)) {
                isInitialized = true;
              } else {
                parseHeader(existingAccount.data);
                isInitialized = true;
              }
            } catch {
              isInitialized = false;
            }

            if (isInitialized) {
              // Market already initialized — skip to step 1
              setState((s) => ({
                ...s,
                txSigs: [...s.txSigs, "skipped-already-initialized"],
                slabAddress: slabKp.publicKey.toBase58(),
              }));
            } else {
              // Slab exists but NOT initialized — this is the stuck state we want to prevent.
              // Since we have the keypair, we can't close it (program-owned), but we can
              // try InitMarket on it. Create vault ATA (idempotent) + InitMarket.
              const createAtaIx = createAssociatedTokenAccountInstruction(
                wallet.publicKey, vaultAta, vaultPda, params.mint,
              );

              // W11 fix (2026-07-08): this used to require + transfer MIN_INIT_MARKET_SEED
              // (500 tokens) into the vault before InitMarket, auto-funding via
              // /api/devnet-pre-fund if short. launch-test-market.ts (the proven 8/8
              // on-chain reference) creates the vault ATA and calls InitMarket directly —
              // no seed transfer — and it succeeds with a zero vault balance; the engine
              // never accounts for or requires this deposit. Removing it drops an
              // unnecessary token requirement (and a devnet-pre-fund round-trip) from the
              // very first step of every market creation / recovery attempt.
              // Margin and the price-move budget share one derivation — see
              // lib/market-params.ts.
              const v17InitArgs = buildV17InitMarketArgs(params, derived);
              const initMarketData = encodeInitMarket(v17InitArgs);

              // v18 InitMarket takes exactly 3 accounts [admin, slab, mint] — see the
              // M1 fix note above (~line 987) and ACCOUNTS_INIT_MARKET in the v18 SDK.
              // The old 9-account array (vault ATA, token program, clock, rent, vault
              // PDA, system program) tripped the "Account count mismatch: expected 3,
              // got 9" guard on this resume-Step-0/retry path.
              const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, {
                admin: wallet.publicKey,
                slab: slabPk,
                mint: params.mint,
              });
              const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

              const sig = await sendTx({
                simulateBeforeSign: true,
                connection, wallet,
                abortSignal,
                // UX WP-7: the keeper-registration memo rides in the InitMarket tx.
                instructions: [createAtaIx, initMarketIx, ...(await seqKeeperMemo(wallet.publicKey, slabPk))],
                computeUnits: 250_000,
              });
              if (isKeeperOracle && params.dexPoolAddress) saveProofTx(slabPk.toBase58(), sig);
              setState((s) => ({
                ...s,
                txSigs: [...s.txSigs, sig],
                slabAddress: slabKp.publicKey.toBase58(),
                keeperProofTx: isKeeperOracle && params.dexPoolAddress ? sig : s.keeperProofTx,
              }));
            }
          } else {
            // Fresh creation — atomic: createAccount + createATA + InitMarket.
            //
            // W11 fix (2026-07-08): this block used to pre-flight-check + auto-fund (via
            // /api/devnet-pre-fund) MIN_INIT_MARKET_SEED (500 tokens) and bundle a Transfer
            // into the vault ATA before InitMarket. launch-test-market.ts (the proven 8/8
            // on-chain reference) never seeds the vault before InitMarket and it succeeds —
            // the engine doesn't require or account for a pre-existing vault balance. This
            // was pure unnecessary friction (an extra token requirement + a devnet-pre-fund
            // round-trip) on the very first step of every market creation attempt; removed.

            const effectiveSlabSize = slabSizeFor(params);
            const slabRent = await connection.getMinimumBalanceForRentExemption(effectiveSlabSize);

            // PERC-509: Pre-check SOL balance before attempting createAccount.
            // Without this, the tx fails with an opaque "insufficient lamports" error.
            // We need slabRent + ~0.01 SOL for ATA creation + tx fees.
            const solBalance = await connection.getBalance(wallet.publicKey);
            const minSolRequired = slabRent + 10_000_000; // rent + ~0.01 SOL for fees
            if (solBalance < minSolRequired) {
              const solNeeded = (minSolRequired / 1e9).toFixed(3);
              const solHave = (solBalance / 1e9).toFixed(3);
              if (isDevnetEnv) {
                // Auto-airdrop SOL on devnet
                setState((s) => ({ ...s, stepLabel: "Airdropping SOL for slab rent..." }));
                try {
                  const airdropSig = await connection.requestAirdrop(
                    wallet.publicKey,
                    Math.max(2_000_000_000, minSolRequired - solBalance + 500_000_000),
                  );
                  await confirmSignatureByPolling(connection, airdropSig, abortSignal);
                  setState((s) => ({ ...s, stepLabel: STEP_LABELS[0] }));
                } catch (airdropErr) {
                  throw new Error(
                    `Insufficient SOL (have ${solHave}, need ~${solNeeded}). ` +
                    `Devnet airdrop failed — try again in a few seconds or use the faucet at faucet.solana.com.`
                  );
                }
              } else {
                throw new Error(
                  `Insufficient SOL for slab rent. You need ~${solNeeded} SOL but your wallet has ${solHave} SOL. ` +
                  `The slab account requires ${(slabRent / 1e9).toFixed(3)} SOL in rent-exemption fees.`
                );
              }
            }

            const createAccountIx = SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: slabKp.publicKey,
              lamports: slabRent,
              space: effectiveSlabSize,
              programId,
            });

            const createAtaIx = createAssociatedTokenAccountInstruction(
              wallet.publicKey, vaultAta, vaultPda, params.mint,
            );

            // Margin and the price-move budget share one derivation — see
            // lib/market-params.ts.
            const v17InitArgs = buildV17InitMarketArgs(params, derived);
            const initMarketData = encodeInitMarket(v17InitArgs);

            // v18 InitMarket takes exactly 3 accounts [admin, slab, mint] — see the
            // M1 fix note above (~line 987). The old 9-account array (vault ATA,
            // token program, clock, rent, vault PDA, system program) tripped the
            // "Account count mismatch: expected 3, got 9" guard on this fresh-
            // creation-via-sequential-flow path.
            const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, {
              admin: wallet.publicKey,
              slab: slabPk,
              mint: params.mint,
            });
            const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

            const sig = await sendTx({
              simulateBeforeSign: true,
              connection,
              wallet,
              abortSignal,
              // UX WP-7: the keeper-registration memo rides in the InitMarket tx.
              instructions: [createAccountIx, createAtaIx, initMarketIx, ...(await seqKeeperMemo(wallet.publicKey, slabPk))],
              computeUnits: 300_000,
              signers: [slabKp],
              maxRetries: 0, // Don't auto-retry createAccount — use manual retry instead
            });
            if (isKeeperOracle && params.dexPoolAddress) saveProofTx(slabPk.toBase58(), sig);

            setState((s) => ({
              ...s,
              txSigs: [...s.txSigs, sig],
              slabAddress: slabKp.publicKey.toBase58(),
              keeperProofTx: isKeeperOracle && params.dexPoolAddress ? sig : s.keeperProofTx,
            }));
            updateInFlightStep(slabPk.toBase58(), 1);
          }
        } else {
          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
        }

        // Step 1: Oracle setup + pre-LP crank
        // v17: SetOracleAuthority (tag 17), PushOraclePrice (tag 16), SetOraclePriceCap (tag 16),
        // and UpdateConfig (tag 14) do not exist. All oracle + risk params are embedded in InitMarket.
        // For v17, Step 1 only runs the pre-LP crank (no oracle setup needed).
        //
        // v12: full oracle setup + UpdateConfig + crank is still required.
        //
        // We detect v17 by reading the newly created slab account and checking V17_MAGIC.
        if (startStep <= 1) {
          runningStep = 1;
          setState((s) => ({ ...s, step: 1, stepLabel: STEP_LABELS[1] }));

          const instructions: TransactionInstruction[] = [];

          // Detect if this is a v17 slab (v17 magic at bytes 0-7).
          //
          // This must FAIL CLOSED. It used to default to false and swallow the error, so any
          // hiccup reading a slab we had just created routed a v17 market down the legacy v12
          // branch below — which calls sdk-compat stubs that THROW by design (the instructions
          // were removed on-chain in beta.29). The user then saw an opaque
          // "[sdk-compat] ... removed in beta.29" instead of the real problem.
          //
          // The slab was created moments ago in this same flow, so a null read is an ordinary
          // propagation race, not an exceptional case. Retry, and if v17-ness still cannot be
          // established, say so plainly rather than guessing "v12".
          let isV17Slab: boolean | null = null;
          let lastDetectErr: unknown = null;
          for (let attempt = 0; attempt < 5 && isV17Slab === null; attempt++) {
            try {
              const newSlabInfo = await connection.getAccountInfo(slabPk, "confirmed");
              if (newSlabInfo?.data) {
                isV17Slab = isV17Account(new Uint8Array(newSlabInfo.data));
                break;
              }
            } catch (e) {
              lastDetectErr = e;
            }
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          }
          if (isV17Slab === null) {
            throw new Error(
              `Could not read the market account ${slabPk.toBase58()} just after creating it, ` +
                `so its program version could not be determined. Nothing further was sent. ` +
                `Retry the oracle setup step.` +
                (lastDetectErr ? ` (last read error: ${String(lastDetectErr)})` : ""),
            );
          }

          if (!isV17Slab && isAdminOracle) {
            // v12 admin oracle setup (removed in v17):
            // SetOracleAuthority → PushOraclePrice → SetOraclePriceCap → UpdateConfig
            // These are only included for legacy v12 programs — v17 embeds this in InitMarket.
            const { encodeSetOracleAuthority, encodePushOraclePrice, ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE } = await import("@/lib/sdk-compat");

            const setAuthToUserData = encodeSetOracleAuthority({ newAuthority: wallet.publicKey });
            const setAuthToUserKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
              wallet.publicKey, slabPk,
            ]);
            instructions.push(buildIx({ programId, keys: setAuthToUserKeys, data: setAuthToUserData }));

            const jupiterCA = params.mainnetCA ?? params.mint.toBase58();
            const freshPriceE6 = await fetchJupiterPriceE6(jupiterCA);
            const resolvedPriceE6 = freshPriceE6 ?? params.initialPriceE6;

            const now = Math.floor(Date.now() / 1000);
            const pushData = encodePushOraclePrice({
              priceE6: resolvedPriceE6.toString(),
              timestamp: now.toString(),
            });
            const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
              wallet.publicKey, slabPk,
            ]);
            instructions.push(buildIx({ programId, keys: pushKeys, data: pushData }));

            // NOTE: SetOraclePriceCap (tag 16) and UpdateConfig (tag 14) were removed in v17.
            // They are not called here — oracle parameters are embedded in InitMarket for v17
            // and this block is only reached for !isV17Slab (legacy v12). In the v17 SDK
            // both functions throw `removedInstruction()` so they cannot be safely imported.
            // v12 circuit-breaker and funding params are omitted in this fallback path.
          }
          // v17 note: isAdminOracle for v17 slabs → oracle params already in InitMarket;
          // no SetOracleAuthority / PushOraclePrice / SetOraclePriceCap / UpdateConfig needed.

          // Keeper oracle mode (v17): ConfigureAuthMark + UpdateAssetAuthority(Oracle → keeper).
          // The backend co-signs UpdateAssetAuthority (as the new oracle_authority = keeper).
          // After this tx: oracle_mode=3 (AUTH_MARK), oracle_authority=keeperPubkey.
          // Resume/retry idempotency: the hand-off can only ever land once. After it
          // lands the deployer is no longer the oracle authority, so re-sending it
          // is refused with Unauthorized (Custom 8) — that is exactly the "not
          // authorized" a Retry after a batched-launch failure produced, because
          // Retry re-ran this step. Read the market first and skip if it is done.
          let oracleDelegationDone = false;
          if (isKeeperOracle && isV17Slab) {
            const profileInfo = await connection.getAccountInfo(slabPk, "confirmed");
            if (profileInfo?.data) {
              const profile = parseAssetOracleProfileV17(new Uint8Array(profileInfo.data), assetProfileOff(0));
              oracleDelegationDone = isOracleDelegationApplied(profile, wallet.publicKey);
              if (oracleDelegationDone) {
                console.log(
                  `[useCreateMarket] Step 1: oracle already delegated to ${profile.oracleAuthority.toBase58()} — skipping the keeper hand-off.`,
                );
              }
            }
          }

          if (isKeeperOracle && isV17Slab && !oracleDelegationDone) {
            setState((s) => ({ ...s, stepLabel: "Delegating oracle authority to keeper..." }));
            const cosignResp = await fetch("/api/playground/keeper-cosign", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                deployer: wallet.publicKey.toBase58(),
                slabAddress: slabPk.toBase58(),
                initialPriceE6: params.initialPriceE6.toString(),
                assetIndex: 0,
              }),
            });
            if (!cosignResp.ok) {
              const errData = await cosignResp.json().catch(() => ({ error: "co-sign failed" }));
              throw new Error(
                `Keeper co-sign failed (${cosignResp.status}): ${(errData as { error?: string }).error ?? cosignResp.statusText}. ` +
                `Is PLAYGROUND_KEEPER_KEYPAIR set in server env?`,
              );
            }
            const { partialTxBase64 } = await cosignResp.json() as { partialTxBase64: string };

            // Deserialize the partially-signed tx (keeper has signed UpdateAssetAuthority)
            const partialTxBytes = Buffer.from(partialTxBase64, "base64");
            const partialTx = Transaction.from(partialTxBytes);

            // Simulate BEFORE the wallet prompt. A tx that will revert otherwise
            // reaches Phantom/Solflare first, and the user sees the wallet's own
            // generic "this transaction may fail" warning instead of our reason.
            await presimulateOrThrow(connection, partialTx);

            // Wallet signs (adds creator sig for ConfigureAuthMark + UpdateAssetAuthority)
            if (!wallet.signTransaction) throw new Error("Wallet does not support signTransaction");
            const signedTx = await wallet.signTransaction(partialTx);

            // Send the fully-signed tx
            // Confirm by polling signature status, like every other step. This was the
            // one launch tx still on `connection.confirmTransaction(sig)`, which waits on
            // a websocket notification and reported a 30 s timeout for a hand-off that
            // had landed in 4 s (three launches in a row on 2026-10-06), failing the step.
            const keeperDelegateSig = await broadcastSignedTx(connection, signedTx, { abortSignal });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, keeperDelegateSig] }));
          }

          // Pre-LP crank — v17 PermissionlessCrank requires a portfolio at accounts[2].
          // For v17 slabs, we skip the pre-LP crank (oracle is managed by UpdateAssetLifecycle
          // server-side; no oracle account required here). For v12 legacy slabs, use the old path.
          if (isV17Slab) {
            // v17: No pre-LP crank needed — oracle state is in UpdateAssetLifecycle (tag 66),
            // not in the slab bitmap. The crank will run server-side (keeper) after market creation.
            // Skip: encodeUpdateHyperpMark() throws removedInstruction() in v17 SDK.

            // BUG FIX (devnet flow-test 2026-07-01): the wizard never created the per-market
            // nft_registry PDA. MintPositionNft (useMintPositionNft.ts) and NftBurn both only
            // READ the registry — nothing in the frontend ever initialized it — so the first
            // "Mint NFT" attempt on ANY wizard-created market failed on-chain with Custom(26)
            // "nft_registry not owned by the percolator program" (see flowtest/07-nft-mint
            // .result.json's flag_for_flow_14 finding, reproduced+fixed in flowtest/14-create
            // -market.ts). SetNftProgramId (tag 73) is marketauth-gated and creates the
            // registry; marketauth == the creator wallet (accounts[0] passed to InitMarket
            // above), so the creator can always call this themselves right after market
            // creation — no separate admin bootstrap needed. Accounts/encoding verified against
            // percolator-prog src/v16_program.rs:13106-13112 (handle_set_nft_program_id) and
            // proven working on-chain via flowtest/_setup-nft-registry.ts on the 5 seeded
            // markets, and now also via flowtest/14-create-market.ts on a wizard-created one.
            // This was previously the ONLY instruction in this step for a v17+admin-oracle
            // market, so Step 1 sent a functionally-empty (compute-budget-only) transaction —
            // this fix also makes that transaction do useful work instead of nothing.
            // W1 fix (2026-07-08): a cross-session RESUME used to always re-run this step
            // regardless of whether SetNftProgramId already landed in a prior attempt —
            // the registry PDA is init-once, so a re-send reverts on-chain with
            // AlreadyInitialized and strands the resume. Check for the registry first
            // (same idempotency pattern Steps 2/4/5 already use) and skip if it's there.
            const [nftRegistryPda] = deriveNftRegistry(programId, slabPk);
            const existingNftRegistry = await connection.getAccountInfo(nftRegistryPda);
            if (!existingNftRegistry) {
              instructions.push(
                buildIx({
                  programId,
                  keys: [
                    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                    { pubkey: slabPk, isSigner: false, isWritable: false },
                    { pubkey: nftRegistryPda, isSigner: false, isWritable: true },
                    { pubkey: WELL_KNOWN.systemProgram, isSigner: false, isWritable: false },
                  ],
                  data: encodeSetNftProgramId({ nftProgramId: PERCOLATOR_NFT_PROGRAM_ID }),
                }),
              );
            } else {
              console.log("[useCreateMarket] Step 1: nft_registry already exists — skipping SetNftProgramId.");
            }
          } else if (!isV17Slab && isHyperpOracle && params.dexPoolAddress) {
            // v12 hyperp oracle — encodeUpdateHyperpMark is removed; log a warning and skip.
            // v12 hyperp markets on the v17 binary are not supported.
            console.warn("[useCreateMarket] v12 hyperp oracle mode not supported on v17 binary; skipping pre-LP crank");
          } else if (!isV17Slab) {
            // v12 legacy: KeeperCrank for Pyth and admin modes
            const crankData = encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) });
            const oracleAccount = isAdminOracle ? slabPk : derivePythPushOraclePDA(params.oracleFeed)[0];
            const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
              wallet.publicKey, slabPk, slabPk,
            ]);
            // Append oracle tail for Pyth mode
            if (!isAdminOracle) {
              crankKeys.push({ pubkey: oracleAccount, isSigner: false, isWritable: false });
            }
            instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));
          }

          // NOTE: Do NOT delegate oracle authority here — SetOracleAuthority clears
          // authority_price_e6 to 0, which would break the final crank in Step 4.
          // Delegation happens at the very end of Step 4 instead.

          // W1 fix: on a resume where every Step 1 instruction was already skipped as
          // idempotent (e.g. nft_registry already exists, v17 needs nothing else here),
          // don't send a pointless zero-instruction transaction.
          if (instructions.length > 0) {
            const sig = await sendTx({
              simulateBeforeSign: true,
              connection, wallet, instructions, computeUnits: 500_000,
              abortSignal,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
          }
          updateInFlightStep(slabPk.toBase58(), 2);
        }

        // Step 2: v17 LP init sequence:
        //   TX A — create portfolio account + InitPortfolio (tag 1)
        //   TX B — createAccount(matcherCtx, MATCHER_CONTEXT_LEN, matcherProgramId) (account only)
        //   TX C — SetMatcherConfig (tag 68) on the LP portfolio
        //   TX D — InitMatcherCtx (tag 83) on the WRAPPER (CPI-relays into the matcher program)
        // v12: encodeInitLP (tag 2) was used here but is REMOVED in v17 (throws removedInstruction).
        //
        // BUG FIX (devnet flow-test 2026-07-01, flowtest/debug-matcherinit-split.ts): TX B used
        // to call the matcher program DIRECTLY with encodeMatcherInitPassive ([delegate(ro),
        // ctx(w)]). That always failed on-chain with a raw ProgramError::MissingRequiredSignature
        // at ~577 CU — confirmed (via an unsigned-simulate diagnostic) that the deployed matcher
        // binary requires the matcher_delegate PDA to be isSigner:true in that call, which is
        // impossible to satisfy with a plain client-side keypair (PDAs have no private key).
        // The SDK's InitMatcherCtx (tag 83) doc comment confirms this is by design: "The wrapper
        // calls derive_matcher_delegate and invoke_signed so the delegate PDA acts as a signer in
        // the matcher CPI — this is what satisfies the matcher's lp_pda.is_signer check on the
        // deployed binary. No client-side signer of the delegate is needed." Every wizard-created
        // market's LP would have been stuck with an unusable (never-initialized) matcher context
        // until this fix — TradeCpi against that LP would fail (matcher config present but
        // matcher_ctx account uninitialized). PREREQUISITE ordering (per InitMatcherCtx's own doc
        // comment) also changed: SetMatcherConfig (TX C) must land BEFORE InitMatcherCtx (TX D),
        // since the wrapper cross-checks the LP portfolio's stored matcher config before CPI-ing.
        // P3 auto-pin: no creator-owned LP / matcher — step 2 does not run (the vault LP bound in
        // step 5 is the market's only LP).
        if (startStep <= 2 && !params.p3) {
          runningStep = 2;
          setState((s) => ({ ...s, step: 2, stepLabel: STEP_LABELS[2] }));

          const matcherProgramId = new PublicKey(getConfig().matcherProgramId);

          // ── v17 LP init ──────────────────────────────────────────────────────
          // Check if a v17 slab — LP init path differs between v17 and v12.
          const slabInfoForStep2 = await connection.getAccountInfo(slabPk);
          const isV17SlabStep2 = slabInfoForStep2?.data
            ? isV17Account(new Uint8Array(slabInfoForStep2.data))
            : false;

          if (isV17SlabStep2) {
            // W1 fix (2026-07-08): idempotency guard — a cross-session RESUME (or a
            // same-session retry after a client-side confirmation timeout that actually
            // landed on-chain) used to unconditionally re-run TX A-D, generating a BRAND
            // NEW lpPortfolio/matcherCtx pair every time and leaving the earlier one
            // orphaned. Scan for an already-created LP portfolio first — same
            // magic+market+owner filter Step 3 below uses to FIND this portfolio — and
            // skip the whole TX A-D sequence if one already exists (mirrors the
            // existence-check pattern Steps 4/5 already use for their own accounts).
            const V17_MAGIC_BYTES_STEP2 = Buffer.from([
              0x00,
              0x36,
              0x31,
              0x56,
              0x43,
              0x52,
              0x45,
              0x50,
            ]);

            const walletPublicKeyStep2 = wallet.publicKey;

            if (!walletPublicKeyStep2) {
              throw new Error(
                "Wallet disconnected while recovering Step 2.",
              );
            }

            const buildInitMatcherCtxInstruction = (
              lpPortfolioPk: PublicKey,
              matcherCtxPk: PublicKey,
              delegatePk: PublicKey,
            ): TransactionInstruction =>
              buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
                  lpOwner: walletPublicKeyStep2,
                  market: slabPk,
                  lpPortfolio: lpPortfolioPk,
                  matcherCtx: matcherCtxPk,
                  matcherProg: matcherProgramId,
                  matcherDelegate: delegatePk,
                }),
                data: encodeInitMatcherCtx(
                  buildInitMatcherCtxArgs(Number(params.tradingFeeBps), derived.matcher),
                ),
              });

            const sendMatcherContextInitialization = async (
              lpPortfolioPk: PublicKey,
              matcherCtxPk: PublicKey,
              delegatePk: PublicKey,
            ): Promise<void> => {
              const initMatcherCtxIx = buildInitMatcherCtxInstruction(
                lpPortfolioPk,
                matcherCtxPk,
                delegatePk,
              );

              const signature = await sendTx({
                simulateBeforeSign: true,
                connection,
                wallet,
                abortSignal,
                instructions: [initMatcherCtxIx],
                computeUnits: 200_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, signature],
              }));
            };

            const inspectConfiguredMatcherState = async (
              lpPortfolioPk: PublicKey,
              portfolioData: Uint8Array,
            ) => {
              const matcherConfig =
                readV17PortfolioMatcherConfig(portfolioData);

              if (!matcherConfig.enabled) {
                throw new Error(
                  "Existing LP portfolio has incomplete matcher initialization: " +
                    "matcher configuration is disabled; cannot safely advance " +
                    "past Step 2.",
                );
              }

              if (!matcherConfig.matcherProgram.equals(matcherProgramId)) {
                throw new Error(
                  "Cannot safely resume Step 2: the existing LP portfolio " +
                    "references an unexpected matcher program.",
                );
              }

              if (matcherConfig.matcherContext.equals(PublicKey.default)) {
                throw new Error(
                  "Existing LP portfolio has incomplete matcher initialization: " +
                    "matcher context is not configured; cannot safely advance " +
                    "past Step 2.",
                );
              }

              const [expectedDelegatePk] = deriveMatcherDelegate(
                programId,
                slabPk,
                lpPortfolioPk,
                walletPublicKeyStep2,
                matcherProgramId,
                matcherConfig.matcherContext,
              );

              if (!matcherConfig.matcherDelegate.equals(expectedDelegatePk)) {
                throw new Error(
                  "Cannot safely resume Step 2: the stored matcher delegate " +
                    "does not match the expected PDA.",
                );
              }

              const matcherContextInfo = await connection.getAccountInfo(
                matcherConfig.matcherContext,
              );

              if (!matcherContextInfo) {
                throw new Error(
                  "Existing LP portfolio has incomplete matcher initialization: " +
                    "the configured matcher-context account does not exist; " +
                    "cannot safely advance past Step 2.",
                );
              }

              if (!matcherContextInfo.owner.equals(matcherProgramId)) {
                throw new Error(
                  "Cannot safely resume Step 2: the matcher-context account " +
                    "is owned by an unexpected program.",
                );
              }

              const contextState = inspectV17MatcherContext(
                new Uint8Array(matcherContextInfo.data),
                expectedDelegatePk,
              );

              if (contextState === "invalid") {
                throw new Error(
                  "Cannot safely resume Step 2: the matcher-context account " +
                    "has an invalid layout or is bound to another delegate.",
                );
              }

              return {
                matcherConfig,
                expectedDelegatePk,
                contextState,
              };
            };

            const verifyMatcherReadiness = async (
              lpPortfolioPk: PublicKey,
            ): Promise<void> => {
              const freshPortfolioInfo =
                await connection.getAccountInfo(lpPortfolioPk);

              if (!freshPortfolioInfo) {
                throw new Error(
                  "Matcher recovery could not be verified: the LP portfolio " +
                    "account was not found after recovery.",
                );
              }

              if (!freshPortfolioInfo.owner.equals(programId)) {
                throw new Error(
                  "Matcher recovery could not be verified: the LP portfolio " +
                    "is owned by an unexpected program.",
                );
              }

              if (
                freshPortfolioInfo.data.length !==
                V17_PORTFOLIO_ACCOUNT_LEN
              ) {
                throw new Error(
                  "Matcher recovery could not be verified: the LP portfolio " +
                    `has an unexpected length (${freshPortfolioInfo.data.length}).`,
                );
              }

              const verifiedState = await inspectConfiguredMatcherState(
                lpPortfolioPk,
                new Uint8Array(freshPortfolioInfo.data),
              );

              if (verifiedState.contextState !== "initialized") {
                throw new Error(
                  "Matcher recovery transaction completed, but authoritative " +
                    "on-chain state still reports an uninitialized matcher context.",
                );
              }
            };

            const createAndInitializeMatcher = async (
              lpPortfolioPk: PublicKey,
            ): Promise<void> => {
              // TX B: create the matcher-program-owned context account.
              const matcherCtxKp = Keypair.generate();
              const matcherCtxPk = matcherCtxKp.publicKey;

              const matcherCtxRent =
                await connection.getMinimumBalanceForRentExemption(
                  MATCHER_CONTEXT_LEN,
                );

              const createCtxIx = SystemProgram.createAccount({
                fromPubkey: walletPublicKeyStep2,
                newAccountPubkey: matcherCtxPk,
                lamports: matcherCtxRent,
                space: MATCHER_CONTEXT_LEN,
                programId: matcherProgramId,
              });

              const [delegatePk] = deriveMatcherDelegate(
                programId,
                slabPk,
                lpPortfolioPk,
                walletPublicKeyStep2,
                matcherProgramId,
                matcherCtxPk,
              );

              const contextSignature = await sendTx({
                simulateBeforeSign: true,
                connection,
                wallet,
                abortSignal,
                instructions: [createCtxIx],
                signers: [matcherCtxKp],
                computeUnits: 150_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, contextSignature],
              }));

              // TX C: commit the context and delegate to the LP portfolio.
              // v18: live-read the LP portfolio identity (recovery path — the
              // matcher-sequence reflects any prior InitUser/Deposit). assetGenFrontier
              // = max_market_slots + 1 (V17_MAX_PORTFOLIO_ASSETS + 1).
              const smInfo = await connection.getAccountInfo(lpPortfolioPk);
              if (!smInfo?.data) throw new Error("LP portfolio not found for SetMatcherConfig");
              const smId = readPortfolioIdentity(new Uint8Array(smInfo.data));
              const setMatcherConfigIx = buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, {
                  lpOwner: walletPublicKeyStep2,
                  market: slabPk,
                  lpPortfolio: lpPortfolioPk,
                  matcherProg: matcherProgramId,
                  matcherCtx: matcherCtxPk,
                  matcherDelegate: delegatePk,
                }),
                data: encodeSetMatcherConfig({
                  portfolioId: smId.portfolioId,
                  expectedSequence: smId.matcherSequence,
                  assetGenerationFrontier: BigInt(marketAssetSlotsFor(params)) + 1n,
                  enabled: 1,
                  tradeFeeCapBps: 10_000,
                  expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT,
                }),
              });

              const configSignature = await sendTx({
                simulateBeforeSign: true,
                connection,
                wallet,
                abortSignal,
                instructions: [setMatcherConfigIx],
                computeUnits: 200_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, configSignature],
              }));

              // TX D: initialize the committed matcher context through the wrapper.
              await sendMatcherContextInitialization(
                lpPortfolioPk,
                matcherCtxPk,
                delegatePk,
              );
            };

            const existingLpPortfolios =
              await connection.getProgramAccounts(programId, {
                filters: [
                  { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
                  {
                    memcmp: {
                      offset: 0,
                      bytes: V17_MAGIC_BYTES_STEP2.toString("base64"),
                      encoding: "base64",
                    },
                  },
                  {
                    memcmp: {
                      offset: 16,
                      bytes: slabPk.toBase58(),
                    },
                  },
                  {
                    memcmp: {
                      offset: 80,
                      bytes: walletPublicKeyStep2.toBase58(),
                    },
                  },
                ],
              });

            if (existingLpPortfolios.length === 0) {
              // TX A: create and initialize the LP portfolio.
              const lpPortfolioKp = Keypair.generate();
              const lpPortfolioPk = lpPortfolioKp.publicKey;

              const portfolioRent =
                await connection.getMinimumBalanceForRentExemption(
                  V17_PORTFOLIO_ACCOUNT_LEN,
                );

              const createPortfolioIx = SystemProgram.createAccount({
                fromPubkey: walletPublicKeyStep2,
                newAccountPubkey: lpPortfolioPk,
                lamports: portfolioRent,
                space: V17_PORTFOLIO_ACCOUNT_LEN,
                programId,
              });

              const initPortfolioIx = buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_INIT_USER, {
                  owner: walletPublicKeyStep2,
                  market: slabPk,
                  portfolio: lpPortfolioPk,
                }),
                data: encodeInitUser({}),
              });

              const portfolioSignature = await sendTx({
                simulateBeforeSign: true,
                connection,
                wallet,
                abortSignal,
                instructions: [createPortfolioIx, initPortfolioIx],
                signers: [lpPortfolioKp],
                computeUnits: 200_000,
              });

              setState((state) => ({
                ...state,
                txSigs: [...state.txSigs, portfolioSignature],
              }));

              await createAndInitializeMatcher(lpPortfolioPk);
              await verifyMatcherReadiness(lpPortfolioPk);
            } else {
              if (existingLpPortfolios.length !== 1) {
                throw new Error(
                  `Cannot safely resume Step 2: expected exactly one LP portfolio, ` +
                    `found ${existingLpPortfolios.length}.`,
                );
              }

              const existingLpPortfolio = existingLpPortfolios[0];

              if (!existingLpPortfolio) {
                throw new Error(
                  "Cannot safely resume Step 2: the LP portfolio lookup " +
                    "returned an empty result.",
                );
              }

              const lpPortfolioPk = existingLpPortfolio.pubkey;
              const lpPortfolioAccount = existingLpPortfolio.account;

              if (!lpPortfolioAccount.owner.equals(programId)) {
                throw new Error(
                  "Cannot safely resume Step 2: the existing LP portfolio " +
                    "is not owned by the configured wrapper program.",
                );
              }

              const matcherConfig = readV17PortfolioMatcherConfig(
                new Uint8Array(lpPortfolioAccount.data),
              );

              if (!matcherConfig.enabled) {
                if (!isEmptyV17PortfolioMatcherConfig(matcherConfig)) {
                  throw new Error(
                    "Existing LP portfolio has incomplete matcher initialization: " +
                      "the disabled matcher configuration contains committed " +
                      "fields; cannot safely advance past Step 2.",
                  );
                }

                // TX A already landed. Resume only TX B, TX C, and TX D.
                await createAndInitializeMatcher(lpPortfolioPk);
                await verifyMatcherReadiness(lpPortfolioPk);

                console.log(
                  "[useCreateMarket] Step 2 recovered missing matcher " +
                    "context/config/initialization (TX B-D).",
                );
              } else {
                const configuredState =
                  await inspectConfiguredMatcherState(
                    lpPortfolioPk,
                    new Uint8Array(lpPortfolioAccount.data),
                  );

                if (configuredState.contextState === "uninitialized") {
                  // TX A-C already landed. Resume only TX D using the committed context.
                  await sendMatcherContextInitialization(
                    lpPortfolioPk,
                    configuredState.matcherConfig.matcherContext,
                    configuredState.expectedDelegatePk,
                  );

                  await verifyMatcherReadiness(lpPortfolioPk);

                  console.log(
                    "[useCreateMarket] Step 2 recovered the missing matcher " +
                      "context initialization (TX D only).",
                  );
                } else {
                  console.log(
                    "[useCreateMarket] Step 2 matcher state verified on-chain - " +
                      "skipping duplicate TX A-D.",
                  );
                }
              }
            }

            updateInFlightStep(slabPk.toBase58(), 3);
          } else {
            // v12 legacy: encodeInitLP (tag 2) is removed in v17 — skip for v17 slabs.
            // For v12 slabs on the old binary, this path would be used but is no longer supported.
            console.warn("[useCreateMarket] v12 InitLP is removed in v17. Skipping LP init for non-v17 slab.");
            updateInFlightStep(slabPk.toBase58(), 3);
          }
        }

        // Step 3: DepositCollateral + TopUpInsurance + Final Crank (merged)
        if (startStep <= 3) {
          runningStep = 3;
          setState((s) => ({ ...s, step: 3, stepLabel: STEP_LABELS[3] }));

          const userAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);

          // Pre-flight: verify user has enough tokens for LP deposit + insurance top-up.
          // Fixes #757/#758 — pre-fund only checked seed amount (500), but TX4 also
          // needs lpCollateral + insuranceAmount (default 1,000 + 100 = 1,100 more).
          // Covers the two backing-bucket deposits (long+short domains) as well
          // as the LP deposit and insurance. Shared with the pre-fund route via
          // fullMarketRequirement so the two cannot disagree again (GH#2592).
          // P3: the junior tranche (== lpCollateral) replaces the creator-LP deposit, so the
          // requirement is unchanged (validated at create() entry: juniorAtoms <= lpCollateral).
          const tx4Required = fullMarketRequirement(params.lpCollateral, params.insuranceAmount);
          let tx4Balance = 0n;
          try {
            const tx4Acct = await getAccount(connection, userAta);
            tx4Balance = tx4Acct.amount;
          } catch {
            // ATA doesn't exist — balance stays 0
          }
          if (tx4Balance < tx4Required) {
            if (isDevnetEnv) {
              setState((s) => ({ ...s, stepLabel: "Funding devnet wallet for deposit..." }));
              const fundResp4 = await fetch("/api/devnet-pre-fund", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mintAddress: params.mint.toBase58(),
                  walletAddress: wallet.publicKey.toBase58(),
                  // GH#2592: the requirement the route checks must be the one
                  // tx4Required is about, or it answers "sufficient" to the
                  // very request that says the wallet is short.
                  lpCollateral: params.lpCollateral.toString(),
                  insuranceAmount: params.insuranceAmount.toString(),
                }),
              });
              if (!fundResp4.ok) {
                const err4 = await fundResp4.json().catch(() => ({ error: "Unknown error" }));
                throw new Error(`Devnet pre-fund failed at deposit step: ${err4.error ?? fundResp4.status}`);
              }
              setState((s) => ({ ...s, stepLabel: STEP_LABELS[3] }));
            } else {
              const decimals = params.decimals ?? 6;
              const needed = Number(tx4Required) / 10 ** decimals;
              const have = Number(tx4Balance) / 10 ** decimals;
              throw new Error(
                `Insufficient token balance for deposit. ` +
                `You need ${needed.toLocaleString()} tokens for LP collateral and insurance ` +
                `but your wallet holds ${have.toLocaleString()}. ` +
                `Please add tokens to your wallet before continuing.`
              );
            }
          }

          // v17 Deposit: [owner, market, portfolio, sourceToken, vaultToken, tokenProgram] — no clock.
          // Must find or create the LP portfolio first.
          // Note: vaultPda is declared in outer scope; use the derived value here for vaultTokenAta.
          const vaultTokenAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
          // Find the LP portfolio created in Step 2 (v17 only).
          // For v12, fall back to the vault ATA as the portfolio placeholder (v12 layout had no portfolio).
          const slabInfoForDeposit = await connection.getAccountInfo(slabPk);
          const isV17SlabDeposit = slabInfoForDeposit?.data
            ? isV17Account(new Uint8Array(slabInfoForDeposit.data))
            : false;

          let depositPortfolioPk: PublicKey;
          if (isV17SlabDeposit && !params.p3) {
            // Scan for LP portfolio (owner = wallet, market = slabPk) — created in Step 2
            // V17 magic bytes at offset 0: PERCV16\0
            const V17_MAGIC_BYTES = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
            const portfolioAccounts = await connection.getProgramAccounts(programId, {
              filters: [
                { memcmp: { offset: 0, bytes: V17_MAGIC_BYTES.toString("base64"), encoding: "base64" } },
                { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                { memcmp: { offset: 80, bytes: wallet.publicKey.toBase58() } },
              ],
            });
            if (portfolioAccounts.length === 0) {
              throw new Error("LP portfolio not found — Step 2 (LP init) may not have completed. Please retry from step 2.");
            }
            depositPortfolioPk = portfolioAccounts[0].pubkey;
          } else {
            // v12 fallback — old deposit layout used vault ATA at [2], not a portfolio
            depositPortfolioPk = vaultAta; // kept for legacy compatibility
          }

          // v18: live-read the LP portfolio's identity CAS fields (recovery path —
          // the market may be partially set up, so fresh literals can't be assumed).
          // v12 fallback has no v18 portfolio (0n placeholders; abandoned).
          let depLpId = { portfolioId: 0n, matcherSequence: 0n };
          if (isV17SlabDeposit && !params.p3) {
            const lpInfo = await connection.getAccountInfo(depositPortfolioPk);
            if (!lpInfo?.data) throw new Error("LP portfolio not found for deposit");
            const pid = readPortfolioIdentity(new Uint8Array(lpInfo.data));
            depLpId = { portfolioId: pid.portfolioId, matcherSequence: pid.matcherSequence };
          }
          const depositData = encodeDepositCollateral({
            portfolioId: depLpId.portfolioId,
            expectedSequence: depLpId.matcherSequence,
            amount: params.lpCollateral.toString(),
          });
          const depositKeys = isV17SlabDeposit
            ? buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
                owner: wallet.publicKey, market: slabPk, portfolio: depositPortfolioPk,
                sourceToken: userAta, vaultToken: vaultTokenAta, tokenProgram: WELL_KNOWN.tokenProgram,
              })
            : // NOT verified against the current v18 ACCOUNTS_DEPOSIT_COLLATERAL spec
              // ([owner,market,portfolio,sourceToken,vaultToken,tokenProgram]) — this is
              // the pre-v16/v17 legacy 6-account array (userAta/vaultAta/tokenProgram/clock,
              // no portfolio account), guarded behind `!isV17SlabDeposit` and unreachable for
              // every currently-deployed market (all are v17-magic). Left as-is: fixing it
              // is out of scope for the v18 mismatch sweep and untestable against any live
              // v12 slab. Flagged in the PR report.
              buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
                wallet.publicKey, slabPk, userAta, vaultAta,
                WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
              ]);

          // v18: TopUpInsurance binds asset-0 market_id + authority_epoch (CAS,
          // current) + a strictly-increasing one-shot intentId on the shared lane.
          // Live-read the identity/epoch off the market; the lane watermark is not
          // exposed, so use the current slot as a monotonic one-shot nonce.
          const insSlabData = isV17SlabDeposit && slabInfoForDeposit?.data
            ? new Uint8Array(slabInfoForDeposit.data) : null;
          const topupData = encodeTopUpInsurance({
            marketId: insSlabData ? readAssetMarketId(insSlabData, 0) : 0n,
            intentId: BigInt(await connection.getSlot("confirmed")),
            authorityEpoch: insSlabData ? readAssetControlSeqs(insSlabData, 0).authorityEpoch : 0n,
            amount: params.insuranceAmount.toString(),
          });
          // v18 ACCOUNTS_TOPUP_INSURANCE is [signer,market,sourceToken,vaultToken,
          // tokenProgram] — 5 entries, no clock (the stale "6 entries / clock in
          // v12.19" note above no longer matches the deployed v18 SDK). Object
          // form for clarity — see ACCOUNTS_TOPUP_INSURANCE in the v18 SDK.
          const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, {
            signer: wallet.publicKey, market: slabPk, sourceToken: userAta,
            vaultToken: isV17SlabDeposit ? vaultTokenAta : vaultAta, tokenProgram: WELL_KNOWN.tokenProgram,
          });
          const topupIx = buildIx({ programId, keys: topupKeys, data: topupData });

          // W2 fix (2026-07-08): read what's already on-chain BEFORE (re)sending the
          // deposit — a prior attempt (retry from this step, or a cross-session resume)
          // may have already landed it even though the overall create() call
          // subsequently failed/threw. Without this, every retry re-deposits
          // lpCollateral ON TOP OF whatever's already there.
          let alreadyDepositedCapital = 0n;
          if (isV17SlabDeposit && !params.p3) {
            try {
              const portInfo = await connection.getAccountInfo(depositPortfolioPk);
              if (portInfo?.data) {
                alreadyDepositedCapital = parsePortfolioV17(new Uint8Array(portInfo.data)).capital;
              }
            } catch {
              // Treat as not-yet-deposited — fall through to deposit.
            }
          }

          // H9/W3 fix (2026-07-08): DepositCollateral used to be bundled atomically with
          // TopUpInsurance + the final crank in ONE transaction. If either of those
          // reverted, Solana rolled back the ENTIRE transaction — including the
          // (otherwise valid) deposit — stranding the user with nothing landed despite
          // having a perfectly good deposit ready to go. Send it ALONE so a topup/crank
          // failure can never roll back a deposit that would have succeeded on its own.
          // This stays on the FATAL path (unlike topup/crank below): a failed deposit
          // legitimately blocks the rest of market creation, same as before this fix.
          // P3: no creator-LP deposit — the junior tranche (step 5, ensureP3Bound) replaces it.
          if (!params.p3 && alreadyDepositedCapital < params.lpCollateral) {
            const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });
            const depositSig = await sendTx({
              simulateBeforeSign: true,
              connection, wallet,
              abortSignal,
              instructions: [depositIx],
              computeUnits: 200_000,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, depositSig] }));
          } else {
            console.log("[useCreateMarket] Step 3 deposit already landed (portfolio capital >= target) — skipping.");
          }

          // Backing-bucket seeding is NO LONGER done here (bug C-1). A direct
          // TopUpBackingBucket at any expiry other than the LP-vault sentinel makes
          // Step 4's CreateLpVault fail Custom(63) LpVaultBackingBucketNotEmpty
          // (v16_program.rs @ 6377376a handle_create_lp_vault). Step 4 now creates the
          // vault and funds BOTH domains with DepositToLpVault, which stamps
          // LP_VAULT_BACKING_EXPIRY_SLOT (never lapses -> no freshness deadlock).
          // See lib/earn-vault-seed.ts.

          // TopUpInsurance + final crank — NOT part of the proven on-chain sequence
          // (launch-test-market.ts, the 8/8 ground truth, creates a tradeable market
          // without ever calling TopUpInsurance) and, per the H9/W3 fix above, no longer
          // bundled with the load-bearing deposit. Treat as best-effort: log and continue
          // rather than throwing, so a topup/crank revert can never strand an
          // otherwise-successful deposit or block Steps 4/5.
          // Recorded by the catch below; the outcome check after it decides.
          let topupCrankError: unknown = null;
          try {
            // W2 idempotency for the top-up: the vault ATA is dedicated to this market
            // (each market gets its own vaultAuth PDA + ATA) and — since the W11 fix
            // removed the old vault-seed transfer from Step 0 — its balance is now
            // exactly lpCollateral-deposited + insurance-topped-up. Back out the
            // insurance component from (vault balance − LP capital) instead of a direct
            // balance read (the v17 SDK exposes no typed insurance-fund accessor) and
            // skip if it's already at/above target.
            // How much insurance is ALREADY in the market.
            //
            // This used to infer it as `vaultBalance - lpCapital`, which is
            // wrong: the vault also holds the BACKING-BUCKET seeds
            // (TopUpBackingBucket, one per domain — see backingSeedPerDomain).
            // For a 1000-token LP seed that is 100 x 2 = 200 sitting in the
            // vault, so the check computed 200 "already topped up", compared it
            // against a 100 insurance seed, concluded insurance had landed, and
            // skipped the deposit. The market came up with insurance = 0 and no
            // failed transaction anywhere, because TopUpInsurance was never
            // built — verified on-chain: tag 9 appears in none of the launch
            // transactions.
            //
            // Read the real balance from the market group header instead. It is
            // the value the engine itself uses, so it cannot be confused with
            // anything else the vault happens to hold.
            let alreadyToppedUp = 0n;
            if (isV17SlabDeposit) {
              try {
                const slabInfo = await connection.getAccountInfo(slabPk);
                if (slabInfo?.data) {
                  alreadyToppedUp = parseMarketGroupV17OI(new Uint8Array(slabInfo.data)).insuranceBalance;
                }
              } catch {
                // Unreadable — treat as not-yet-topped-up and send the deposit.
                // Re-depositing is caught by the engine; skipping it is not.
              }
            }

            // Post-LP crank — engine needs to recognize LP capital
            // Must push fresh price first (user is still oracle authority at this point)
            const finalInstructions: TransactionInstruction[] = [];
            if (alreadyToppedUp < params.insuranceAmount) {
              finalInstructions.push(topupIx);
            } else {
              console.log("[useCreateMarket] Step 3 insurance top-up already landed — skipping.");
            }

            if (isAdminOracle && isLegacyOracle) {
              // PERC-465: Push fresh price again in the final crank bundle (v12 legacy path only).
              // v17: PushOraclePrice (tag 16) does not exist — oracle state is updated by the keeper.
              // Fetch from Jupiter first; fall back to the resolvedPriceE6 from step 1.
              const jupiterCA2 = params.mainnetCA ?? params.mint.toBase58();
              const freshPrice2 = await fetchJupiterPriceE6(jupiterCA2);
              const finalPriceE6 = freshPrice2 ?? params.initialPriceE6;

              const now2 = Math.floor(Date.now() / 1000);
              // NOTE: encodePushOraclePrice and ACCOUNTS_PUSH_ORACLE_PRICE are not imported
              // in the v17 SDK. This block is unreachable when isLegacyOracle = false.
              // To restore v12 support, re-import from @/lib/sdk-compat and set isLegacyOracle = true.
              void jupiterCA2; void freshPrice2; void finalPriceE6; void now2;
            }

            // v17: UpdateHyperpMark (encodeUpdateHyperpMark) is REMOVED — throws removedInstruction().
            // Hyperp oracle in v17 uses ConfigureHybridOracle (tag 34) managed server-side by keeper.
            // Final crank uses PermissionlessCrank for all oracle modes.
            // v17 PermissionlessCrank: [owner(s,w), market(w), portfolio(w)] + optional oracle tail.
            // P3: there is no creator-owned LP portfolio to crank; the top-up stands alone.
            if (!params.p3) {
              const crankData = encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) });
              const crankPortfolioPk = isV17SlabDeposit ? depositPortfolioPk : slabPk;
              const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
                owner: wallet.publicKey, market: slabPk, portfolio: crankPortfolioPk,
              });
              // ONLY a pyth market carries a Pyth oracle tail. Same bug as the
              // batched path: `!isAdminOracle && !isHyperpOracle` is TRUE for a
              // keeper market, whose oracleFeed is the mainnet DEX POOL address
              // rather than a Pyth feed id — so this derived a push-oracle PDA
              // from a pool address and appended that account to the crank.
              if (oracleMode === "pyth") {
                crankKeys.push({ pubkey: derivePythPushOraclePDA(params.oracleFeed)[0], isSigner: false, isWritable: false });
              }
              finalInstructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));
            }

            // PERC-465: Oracle authority delegation (v12 legacy path only).
            // v17: SetOracleAuthority (tag 17) does not exist. Oracle authority in v17 is
            // managed via UpdateAssetAuthority (tag 65) by the market admin AFTER market creation.
            // The keeper bot picks up new v17 markets automatically via the config oracle mode.
            // PERC-470: Hyperp mode needs no delegation (oracle_authority stays zeros, permissionless).
            if (isDevnetEnv && isAdminOracle && isLegacyOracle) {
              // v12-only: SetOracleAuthority → crank wallet
              // NOTE: encodeSetOracleAuthority and ACCOUNTS_SET_ORACLE_AUTHORITY are not imported
              // in the v17 SDK. This block is unreachable when isLegacyOracle = false.
              void getConfig;
            }

            if (finalInstructions.length > 0) {
              const sig = await sendTx({
                simulateBeforeSign: true,
                connection, wallet,
                abortSignal,
                instructions: finalInstructions,
                computeUnits: 450_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
            }
          } catch (topupCrankErr) {
            // Recorded, not swallowed — the outcome check below decides.
            topupCrankError = topupCrankErr;
            console.warn(
              "[useCreateMarket] Step 3 insurance top-up/crank threw:",
              topupCrankErr,
            );
          }

          // The insurance seed is NOT optional: it is the layer that absorbs
          // losses before the LP does, and it is written once at creation.
          // Assert the OUTCOME rather than the transaction result — the seed can
          // be missing with no error at all (the idempotency check above can
          // skip building it) or be rolled back by the best-effort crank bundled
          // into the same transaction. Reading the engine's own insuranceBalance
          // catches never-built, reverted and partial alike.
          if (params.insuranceAmount > 0n) {
            let insuranceOnChain = 0n;
            try {
              const slabInfoFinal = await connection.getAccountInfo(slabPk);
              if (slabInfoFinal?.data) {
                insuranceOnChain = parseMarketGroupV17OI(
                  new Uint8Array(slabInfoFinal.data),
                ).insuranceBalance;
              }
            } catch {
              // Unverifiable — treat as unseeded rather than assume success.
            }
            if (insuranceOnChain < params.insuranceAmount) {
              throw new Error(
                `Insurance fund was not seeded (on-chain ${insuranceOnChain} < requested ${params.insuranceAmount}). ` +
                  "The market exists and its liquidity is deposited — retry this step to seed it." +
                  (topupCrankError
                    ? ` Cause: ${topupCrankError instanceof Error ? topupCrankError.message : String(topupCrankError)}`
                    : ""),
              );
            }
          }

          // W9 fix (2026-07-08): this call was missing entirely, so lastStep never
          // advanced past 3 after this step — see RecoverSolBanner / useStuckSlabs (W1),
          // which now resumes from stuckSlab.lastStep. Recording lastStep=4 here lets a
          // resume correctly skip Steps 0-3 (all idempotency-guarded above, but skipping
          // the RPC round-trips entirely is strictly better) and start at Step 4 (Earn
          // vault).
          updateInFlightStep(slabPk.toBase58(), 4);
        }

        // GH#1761: Register market in Supabase BEFORE Steps 4/5 (Earn vault + stake
        // pool, added below). Steps 0-3 already create a live, tradeable market — moving
        // registration here ensures symbol, mainnet_ca, and oracle_authority are stored
        // even if Step 4 or Step 5 fails. (Originally written for the now-removed
        // "Insurance LP Mint" step 5, which had the same non-fatal-tail-step shape;
        // Steps 4/5 below inherit the same "register first, then attempt" ordering.)
        //
        // PERC-8332: Attach nonce + ed25519 signature so the POST handler can verify
        // deployer ownership without Supabase. Flow:
        //   1. GET /api/markets/challenge?deployer=<pubkey> → { nonce }
        // 2. Sign the canonical market-registration payload with wallet.signMessage (ed25519)
        //   3. POST with { nonce, signature: base64 }
        // The markets-row write used to live here as a second POST /api/markets
        // guarded by its own nonce+signature challenge. Both are gone:
        // keeper-register writes the row under the marketauth proof, so a launch
        // makes ONE registration call and the weaker wallet-possession challenge
        // is redundant. See lib/market-registration.ts for why the endpoint had
        // to be removed rather than merely moved — its blanket 409 meant the
        // indexer won this race every time.

        // Step 4: Create the Earn LP vault (CreateLpVault, tag 74) — the same
        // mechanism the 5 curated/seeded markets use (see
        // percolator-v17-devnet-test/playground/newmarkets.ts step [6b], whose
        // account list + args this mirrors exactly). This MUST run BEFORE
        // Step 5 (Stake InitPool) below: Stake InitPool rotates on-chain
        // marketauth from this wallet to the stake-pool PDA
        // (stake-governs-market — the accepted design for parity with the
        // seeded markets), and CreateLpVault is marketauth-gated. Once
        // marketauth moves to a PDA (no private key to sign with), it can
        // never be called again — newmarkets.ts's "ROOT-CAUSE FIX #2" note
        // documents this exact failure mode being reproduced on-chain when
        // the ordering was reversed. Every earlier marketauth-gated call in
        // this flow (ConfigureAuthMark, UpdateAssetAuthority,
        // SetNftProgramId, SetMatcherConfig, InitMatcherCtx) already relies
        // on the same "marketauth == creator wallet until Stake InitPool"
        // invariant — Step 4/5 just extend it by two more steps.
        //
        // No initial DepositToLpVault here, by design: the LP Vault Registry
        // PDA existing on-chain is sufficient for the Earn page to treat the
        // vault as live — see `lpVaultState.registryExists` in
        // app/earn/[slab]/page.tsx, which drives "Pool Status: Active" purely
        // off account existence, not balance. Forcing the creator to seed a
        // deposit here would add an extra funding requirement with no
        // functional benefit; anyone (including the creator, later) can be
        // the vault's first depositor from the Earn page.
        if (startStep <= 4) {
          runningStep = 4;
          setState((s) => ({ ...s, step: 4, stepLabel: STEP_LABELS[4] }));

          const [lpVaultRegistry] = deriveLpVaultRegistry(programId, slabPk);
          const [lpVaultMint] = deriveInsuranceLpMint(programId, slabPk);

          // Idempotent on retry. One ATOMIC tx does CreateLpVault + LP-share ATA +
          // DepositToLpVault(domain 0) + DepositToLpVault(domain 1) (lib/earn-vault-seed.ts),
          // so "registry exists" normally means everything landed. The one exception is a
          // registry created WITHOUT deposits (markets from before this fix whose direct
          // top-up never landed): total shares == 0 -> send only ATA + deposits.
          const existingRegistry = await connection.getAccountInfo(lpVaultRegistry);
          let vaultNeedsSeed = !existingRegistry;
          if (existingRegistry) {
            try {
              vaultNeedsSeed =
                parseLpVaultRegistry(new Uint8Array(existingRegistry.data)).totalLpSharesOutstanding === 0n;
            } catch {
              vaultNeedsSeed = false; // unreadable registry: do not guess, continue
            }
          }
          if (vaultNeedsSeed) {
            const seedUserAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
            const seedVaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
            const earnVaultIxs = buildEarnVaultSeedInstructions({
              programId,
              wallet: wallet.publicKey,
              market: slabPk,
              registry: lpVaultRegistry,
              lpMint: lpVaultMint,
              userAta: seedUserAta,
              vaultAta: seedVaultAta,
              seedPerDomain: backingSeed,
              includeCreate: !existingRegistry,
            });
            try {
              const sigLpVault = await sendTx({
                simulateBeforeSign: true,
                connection,
                wallet,
                abortSignal,
                instructions: earnVaultIxs,
                computeUnits: EARN_VAULT_SEED_COMPUTE_UNITS,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sigLpVault] }));
            } catch (earnErr) {
              // Old-flow market (MAX-1 buckets present): CreateLpVault can NEVER succeed.
              // Say so once, clearly, instead of letting Retry loop on it.
              if (extractCustomCode(earnErr instanceof Error ? earnErr.message : String(earnErr)) === LP_VAULT_BACKING_BUCKET_NOT_EMPTY_CODE) {
                throw new Error(EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE);
              }
              throw earnErr;
            }
          }
          updateInFlightStep(slabPk.toBase58(), 5);
        }

        // Keeper registration — non-fatal; market is live regardless. MUST run here,
        // BEFORE Step 5 (Stake InitPool) below — not after it as originally written.
        //
        // ROOT CAUSE (confirmed by live end-to-end reproduction): Step 5 rotates
        // on-chain marketauth from this wallet to the stake-pool PDA. keeper-register's
        // H1 auth requires `deployer` (this wallet) to match the slab's LIVE on-chain
        // admin/marketauth. Calling it after Step 5 meant that check compared the
        // creator wallet against the stake-pool PDA — always a mismatch — so every
        // keeper-oracle market failed registration with 403 "Deployer does not match
        // slab admin", permanently (marketauth never rotates back). Registering here,
        // while marketauth is still this wallet (Step 4 already ran; Step 5 hasn't
        // yet), fixes it structurally instead of teaching the route about the stake
        // PDA as a second valid authority.
        //
        // Registers { marketAddress, poolAddress, dexType } with the keeper service so
        // PushAuthMark price-push starts within the next keeper cycle (~30s).
        //
        // BUG FIX (2026-07-09): this used to inline its own sign+POST logic here,
        // duplicated by nothing (there was no retry path). It's now
        // registerMarketWithKeeper() (module scope above) — a single implementation
        // shared with retryKeeperRegistration(), which LaunchSuccess's "Retry
        // registration" button calls when this first attempt fails (see that
        // function's BUG FIX comment for what changed and why: signMessage
        // unavailability and sign failures are now surfaced explicitly instead of
        // silently posting a request with no `signature` field).
        // UX WP-7: registration is a background loop started when the launch completes (no
        // signature; the proof is the InitMarket tx), so nothing waits for it here.
        const keeperDelegated = false;
        const keeperMessage: string | null = isKeeperOracle && params.dexPoolAddress ? KEEPER_REGISTER_COPY.connecting : null;
        // The payload the InitMarket memo bound (seqKeeperMemo) is already remembered; a resumed
        // launch whose InitMarket ran on another page load rebuilds the identical object.
        if (isKeeperOracle && params.dexPoolAddress && !recallRegistrationPayload(slabPk.toBase58())) {
          rememberRegistrationPayload(
            slabPk.toBase58(),
            buildMarketRegistrationPayload({ slabAddress: slabPk.toBase58(), params, deployer: wallet.publicKey.toBase58(), oracleMode, isAdminOracle, isDevnetEnv }),
          );
        }

        // Step 5 (FINAL on-chain step): percolator-stake InitPool. Creates the
        // per-market stake pool and — critically — ROTATES on-chain
        // marketauth from this wallet to the stake-pool PDA
        // (stake-governs-market design; mirrors newmarkets.ts step [7]).
        // This is why Step 4 (Earn vault) above must always complete first,
        // and why this must be the LAST on-chain mutation the wizard
        // performs — nothing after this point may depend on marketauth
        // still being the creator wallet.
        if (startStep <= 5) {
          runningStep = 5;
          setState((s) => ({ ...s, step: 5, stepLabel: STEP_LABELS[5] }));

          // Stake pools live under this deployment's vault program
          // (getConfig().vaultProgramId) — NOT the SDK's default stake
          // program id. Same lookup + fallback pattern as
          // hooks/useStakeDeposit.ts and hooks/useStakePool.ts.
          const stakeProgramId = new PublicKey(
            (getConfig() as { vaultProgramId?: string }).vaultProgramId ??
              DEVNET_PROGRAM_IDS.stake,
          );
          const [stakePoolPda] = deriveStakePool(slabPk, stakeProgramId);

          // Idempotent on retry — if a prior attempt already landed InitPool,
          // don't try again (a fresh lpMint/vault keypair pair would be
          // orphaned, and InitPool would revert against an already-live pool).
          const existingPool = await connection.getAccountInfo(stakePoolPda);

          // P3: bind the vault-owned LP + fund the junior tranche BEFORE StakeInitPool rotates
          // marketauth (InitVaultLp path A needs the creator as marketauth). Idempotent: reads
          // the vault-LP state first, so a resume after the batched M4p (or a partial run)
          // sends only what is missing.
          if (params.p3) {
            const vaultLpStatePk = deriveVaultLpState(programId, slabPk);
            const stInfo = await connection.getAccountInfo(vaultLpStatePk);
            const st = stInfo && stInfo.owner.equals(programId) ? decodeVaultLpState(new Uint8Array(stInfo.data)) : null;
            const progress = p3BindProgress({ exists: !!stInfo, juniorDepositedAtoms: st ? st.juniorDepositedAtoms : null });
            if (progress !== "done") {
              if (progress === "bind" && existingPool) {
                throw new Error(LIMITS_COPY.p3Wizard.marketauthRotated);
              }
              const creatorAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
              const vaultTokenAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
              const vaultLpKp = progress === "bind" ? Keypair.generate() : null;
              const vaultLpCtxKp = progress === "bind" ? Keypair.generate() : null;
              const lpPortfolioPk = vaultLpKp ? vaultLpKp.publicKey : st ? new PublicKey(st.lpPortfolio) : null;
              if (!lpPortfolioPk) throw new Error(LIMITS_COPY.earnPlanBlocked["vault-lp-unreadable"]);
              const p3Market = {
                programId,
                market: slabPk,
                registry: deriveLpVaultRegistry(programId, slabPk)[0],
                vaultLpState: vaultLpStatePk,
                lpPortfolio: lpPortfolioPk,
                ledger: deriveLpBackingLedger(programId, slabPk, 0)[0],
                siblingLedger: deriveLpBackingLedger(programId, slabPk, 1)[0],
              };
              const p3Ixs = vaultLpKp
                ? buildP3BindIxs({
                    market: p3Market,
                    creator: wallet.publicKey,
                    vaultLpPortfolio: vaultLpKp.publicKey,
                    portfolioLen: V17_PORTFOLIO_ACCOUNT_LEN,
                    portfolioRentLamports: await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN),
                    matcherProgram: canonicalVaultLpMatcher(getConfig().matcherProgramId),
                    matcherCtx: vaultLpCtxKp!.publicKey,
                    matcherCtxRentLamports: await connection.getMinimumBalanceForRentExemption(VAULT_LP_MATCHER_CTX_LEN),
                    juniorFloorBps: params.p3.juniorFloorBps,
                    juniorAtoms: params.p3.juniorAtoms,
                    creatorAta,
                    vaultToken: vaultTokenAta,
                  })
                : [buildDepositJuniorTrancheIx(p3Market, wallet.publicKey, creatorAta, vaultTokenAta, params.p3.juniorAtoms)];
              setState((s) => ({ ...s, stepLabel: "Binding the vault-owned LP..." }));
              const p3Sig = await sendTx({
                simulateBeforeSign: true,
                connection,
                wallet,
                abortSignal,
                instructions: p3Ixs,
                signers: vaultLpKp && vaultLpCtxKp ? [vaultLpKp, vaultLpCtxKp] : [],
                computeUnits: P3_BIND_COMPUTE_UNITS,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, p3Sig], stepLabel: STEP_LABELS[5] }));
            }
          }
          if (!existingPool) {
            const [stakeVaultAuth] = deriveStakeVaultAuth(stakePoolPda, stakeProgramId);
            const stakeLpMintKp = Keypair.generate();
            const stakeVaultKp = Keypair.generate();

            const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
            const vaultRent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

            const createLpMintIx = SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: stakeLpMintKp.publicKey,
              lamports: mintRent,
              space: MINT_SIZE,
              programId: WELL_KNOWN.tokenProgram,
            });
            const createVaultIx = SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: stakeVaultKp.publicKey,
              lamports: vaultRent,
              space: ACCOUNT_SIZE,
              programId: WELL_KNOWN.tokenProgram,
            });
            const initPoolIx = buildIx({
              programId: stakeProgramId,
              keys: initPoolAccounts({
                admin: wallet.publicKey,
                slab: slabPk,
                pool: stakePoolPda,
                lpMint: stakeLpMintKp.publicKey,
                vault: stakeVaultKp.publicKey,
                vaultAuth: stakeVaultAuth,
                collateralMint: params.mint,
                percolatorProgram: programId,
              }),
              // cooldown = the relaunch floor (C-1, 150 slots), depositCap=0 (uncapped)
              data: encodeStakeInitPool(STAKE_POOL_COOLDOWN_SLOTS, 0n),
            });

            // UpdateFeeSplit (wrapper tag 86) — MARKETAUTH-GATED, so it MUST land
            // BEFORE initPoolIx (which rotates cfg.marketauth to the pool PDA). Only
            // for a non-default split; validated with the wrapper's own rule.
            const feeSplitArgs = params.feeSplit;
            // v18: UpdateFeeSplit (tag 86) is CAS-bound to asset-0's authority_epoch
            // lane — live-read the current value off the market (this still runs
            // before StakeInitPool rotates marketauth, so the creator gates it).
            const fsSlabInfo = feeSplitArgs ? await connection.getAccountInfo(slabPk) : null;
            const fsAuthorityEpoch = fsSlabInfo?.data
              ? readAssetControlSeqs(new Uint8Array(fsSlabInfo.data), 0).authorityEpoch
              : 0n;
            const updateFeeSplitIx = feeSplitArgs
              ? (() => {
                  const feeSplitV18 = { ...feeSplitArgs, authorityEpoch: fsAuthorityEpoch };
                  const reason = validateFeeSplit(feeSplitV18);
                  if (reason) throw new Error(`Invalid fee split: ${reason}`);
                  return buildIx({
                    programId,
                    keys: buildAccountMetas(ACCOUNTS_UPDATE_FEE_SPLIT, {
                      admin: wallet.publicKey,
                      market: slabPk,
                    }),
                    data: encodeUpdateFeeSplit(feeSplitV18),
                  });
                })()
              : null;
            // BindInsuranceAuthority (stake tag 19) — REQUIRED (staker/insurance leg
            // exit). Runs AFTER initPoolIx; creator still signs as asset-0 insurance
            // authority (InitPool rotates marketauth, not insurance_authority).
            const bindInsuranceIx = buildIx({
              programId: stakeProgramId,
              keys: bindInsuranceAuthorityAccounts({
                admin: wallet.publicKey,
                poolPda: stakePoolPda,
                vaultAuth: stakeVaultAuth,
                slab: slabPk,
                percolatorProgram: programId,
              }),
              data: encodeStakeBindInsuranceAuthority(),
            });

            const sigStake = await sendTx({
              simulateBeforeSign: true,
              connection,
              wallet,
              abortSignal,
              // Order is load-bearing (see orderStakeTailInstructions): fee split BEFORE
              // InitPool, Bind AFTER InitPool.
              instructions: orderStakeTailInstructions(
                [createLpMintIx, createVaultIx],
                updateFeeSplitIx,
                initPoolIx,
                bindInsuranceIx,
              ),
              signers: [stakeLpMintKp, stakeVaultKp],
              computeUnits: 900_000,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, sigStake] }));
          }
          updateInFlightStep(slabPk.toBase58(), 6);
        }

        // PERC-465: Post-creation hooks — register with oracle keeper + mint devnet token
        const slabAddr = slabPk.toBase58();
        const mintAddr = params.mint.toBase58();
        const isDevnet = getNetwork() === "devnet";

        if (isDevnet && slabAddr) {
          // PERC-465: mainnet_ca is already written to the markets table via /api/markets POST above.
          // The oracle keeper auto-discovers new markets from Supabase every 30s.

          // #2608/#2610: this used to await POST /api/devnet-airdrop here,
          // duplicating the claim the "GET SIM-USDC & TRADE" button on the
          // success screen already makes on click (LaunchSuccess.tsx's
          // handleMintAndTrade) — every failure mode of that duplicate call put
          // an unreportable error banner or a permanently-stuck spinner on the
          // most important screen in the product. Removed: the button beside it
          // does the identical job, and the creator clicks it to reach the trade
          // page anyway, so nothing is lost. Still set devnetMint so that
          // button renders (it's the Sim-USDC collateral mint, not a devnet
          // mirror of `mintAddr` — see LaunchSuccess.tsx's doc comment).
          setState((s) => ({ ...s, devnetMint: mintAddr }));
        }

        // Done! Clear in-memory keypair ref + in-flight recovery state.
        slabKpRef.current = null;
        clearInFlightMarket(slabPk.toBase58());
        setState((s) => ({
          ...s,
          loading: false,
          step: 6,
          stepLabel: "Market created!",
          keeperDelegated,
          keeperMessage,
          priceFeedRequired: !!(isKeeperOracle && params.dexPoolAddress),
          // GH#1266: Defensively re-set slabAddress from slabPk at completion to guard
          // against any state-update race where a prior step's address is stale.
          slabAddress: slabPk.toBase58(),
        }));
        if (isKeeperOracle && params.dexPoolAddress) startKeeperLoop(params, slabPk.toBase58());
      } catch (e) {
        if (e instanceof PreFundRateLimitedError) {
          setState((s) => ({ ...s, loading: false, error: preFundRateLimitedMessage(e.nextClaimAt) }));
          return;
        }
        const msg = parseMarketCreationError(e, {
          step: sequentialStepKind(runningStep),
          stepLabel: `Step ${runningStep + 1} (${STEP_LABELS[runningStep]?.replace(/\.\.\.$/, "") ?? "market creation"})`,
        });
        setState((s) => ({ ...s, loading: false, error: msg }));
      }
    },
    [connection, wallet, state.slabAddress]
  );

  const reset = useCallback(() => {
    slabKpRef.current = null;
    // PERC-8329: Clear any stale key that may have been stored by old code (defensive cleanup).
    try {
      localStorage.removeItem("percolator-pending-slab-keypair");
    } catch (err) {
      // Storage error - log for debugging but don't block flow
      console.debug('[useCreateMarket] Failed to clear pending keypair from storage:', 
        err instanceof Error ? err.message : String(err)
      );
    }
    setState({
      step: 0,
      stepLabel: "",
      txSigs: [],
      slabAddress: null,
      error: null,
      loading: false,
      batchFallbackReason: null,
      devnetMint: null,
      insuranceMintFailed: false,
      backingSeedFailed: false,
      keeperDelegated: false,
      keeperMessage: null,
      keeperRegistering: false,
      priceFeedRequired: false,
      phase: "idle",
      landingIndex: 0,
      landingTotal: 0,
    });
  }, []);

  /**
   * UX WP-7 "Try now" (LaunchSuccess): one immediate registration attempt with the stored
   * creation-tx proof (no signature), then the background loop continues if it is still running.
   */
  const retryKeeperRegistration = useCallback(
    async (params: KeeperRegisterRetryParams) => {
      const proofTx = loadProofTx(params.slabAddress);
      if (!proofTx) {
        const outcome = { registered: false, message: KEEPER_REGISTER_COPY.noProof };
        setState((s) => ({ ...s, keeperMessage: outcome.message, keeperPhase: "failed" }));
        return outcome;
      }
      setState((s) => ({ ...s, keeperRegistering: true }));
      const r = await postKeeperRegistration({
        ...params,
        dexType: normalizeDexType(params.dexType ?? undefined) ?? null,
        payload: params.payload ?? recallRegistrationPayload(params.slabAddress),
        proofTx,
      });
      setState((s) => ({
        ...s,
        keeperRegistering: false,
        keeperDelegated: r.registered || s.keeperDelegated,
        keeperMessage: r.registered ? KEEPER_REGISTER_COPY.ready : s.keeperMessage,
        keeperPhase: r.registered ? "ready" : s.keeperPhase,
      }));
      if (r.registered) {
        markRegistered(params.slabAddress);
        keeperLoopRef.current?.abort();
      }
      return { registered: r.registered, message: r.message };
    },
    [],
  );

  return { state, create, reset, restoreSlabKeypair, retryKeeperRegistration, cancelInFlightLaunch };
}
