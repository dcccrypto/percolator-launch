"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
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
  type InitMarketV17Args,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodePermissionlessCrank,
  encodeInitMatcherCtx,
  encodeSetMatcherConfig,
  encodeInitUser,
  encodeSetNftProgramId,
  encodeCreateLpVaultV17,
  encodeStakeInitPool,
  CrankAction,
  detectDexType,
  parseDexPool,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  ACCOUNTS_SET_MATCHER_CONFIG,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_CREATE_LP_VAULT,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  deriveMatcherDelegate,
  deriveNftRegistry,
  deriveLpVaultRegistry,
  deriveInsuranceLpMint,
  deriveStakePool,
  deriveStakeVaultAuth,
  initPoolAccounts,
  parseHeader,
  isV17Account,
  v17MarketAccountLen,
  V17_PORTFOLIO_ACCOUNT_LEN,
  MATCHER_CONTEXT_LEN,
  // W2/W3 fix (2026-07-08): parsePortfolioV17 reads the LP portfolio's on-chain
  // `capital` so Step 3 can detect an already-landed deposit/top-up before
  // resending it — see the Step 3 block below.
  parsePortfolioV17,
} from "@percolatorct/sdk";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
// v17: SetOracleAuthority (tag 17), PushOraclePrice (tag 16), SetOraclePriceCap (tag 16),
// and UpdateConfig (tag 14) do not exist in v17. All oracle + risk params are embedded
// in InitMarket (extended tail). The sdk-compat stubs throw at runtime if called.
// We guard all callsites with isAdminOracle && !isV17Slab before using these.
import { sendTx } from "@/lib/tx";
import { getConfig, getNetwork } from "@/lib/config";
import { normalizeDexType } from "@/lib/dex-type";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import {
  saveInFlightMarket,
  updateInFlightStep,
  clearInFlightMarket,
  loadLastInFlightMarket,
} from "@/lib/inFlightMarket";
// v17: max assets per portfolio (= the market's asset-slot capacity); program cap = 14.
// The slab MUST be sized to exactly match this capacity or InitMarket reverts (dynamic-len validation).
export const V17_MAX_PORTFOLIO_ASSETS = 14;
// BUG 1 fix (2026-07-06): exported so callers (CreateMarketWizard, CostEstimate) size the
// slab + rent estimate against the actual v17 requirement instead of the stale v12.19
// tier.dataSize concept (96784/376432/1495024 bytes), which never equals this value for any
// tier and made every InitMarket revert with InvalidSlabLen while over-charging ~0.67 SOL rent.
export const DEFAULT_SLAB_SIZE = v17MarketAccountLen(V17_MAX_PORTFOLIO_ASSETS); // 26_364 bytes (cap-14)
const ALL_ZEROS_FEED = "0".repeat(64);

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
        return BigInt(Math.round(price * 1_000_000));
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
        return BigInt(Math.round(price * 1_000_000));
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
export const MIN_SAFE_INITIAL_MARGIN_BPS = 1500n;

/**
 * BUG 16 fix (2026-07-06): create() floors the on-chain initial_margin_bps at
 * MIN_SAFE_INITIAL_MARGIN_BPS, but every leverage display (success screen, StepReview,
 * markets DB `max_leverage`) previously computed leverage from the raw, UNfloored bps the
 * user requested — so a market "created" at 1000 bps (advertised 10x) was actually
 * initialized on-chain at 1500 bps (~6.67x). This is a pure, deterministic mirror of the
 * floor applied inside create() (same constant, same comparison) — safe to call anywhere
 * BEFORE submission too, since the floor never depends on retry/session state.
 */
export function flooredInitialMarginBps(requestedBps: number): number {
  return Math.max(requestedBps, Number(MIN_SAFE_INITIAL_MARGIN_BPS));
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
  step: number;
  stepLabel: string;
  txSigs: string[];
  slabAddress: string | null;
  error: string | null;
  loading: boolean;
  /** Devnet mint address (different from mainnet CA) */
  devnetMint: string | null;
  /** Number of tokens airdropped to creator */
  devnetAirdropAmount: number | null;
  /** Token symbol for devnet airdrop */
  devnetAirdropSymbol: string | null;
  /** Error from devnet mint attempt */
  devnetMintError: string | null;
  /**
   * GH#1761 (legacy): previously set to true when the old "Insurance LP Mint" step
   * failed after exhausting retries. That instruction was removed (see the Step 4/5
   * comment block in create() below — CreateLpVault/StakeInitPool replaced it and are
   * NOT treated as non-fatal; they use the same hard-error/retry path as every other
   * step). Kept for backwards-compatible UI wiring; never set to true by create().
   */
  insuranceMintFailed: boolean;
  /** Keeper oracle mode: true when oracle_authority was delegated to keeper */
  keeperDelegated: boolean;
  /** Keeper registration result message */
  keeperMessage: string | null;
}

const STEP_LABELS = [
  "Creating slab & initializing market...",
  "Oracle setup & pre-LP crank...",
  "Initializing LP...",
  "Depositing collateral, insurance & final crank...",
  "Creating Earn vault...",
  "Initializing stake pool (finalizing market)...",
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
    devnetAirdropAmount: null,
    devnetAirdropSymbol: null,
    devnetMintError: null,
    insuranceMintFailed: false,
    keeperDelegated: false,
    keeperMessage: null,
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

  const create = useCallback(
    async (params: CreateMarketParams, retryFromStep?: number) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState((s) => ({ ...s, error: "Wallet not connected" }));
        return;
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
      // PERC-470 devnet guard: Hyperp mode reads live DEX pool accounts on-chain.
      // On devnet, mirror tokens have no PumpSwap pool — mainnet pool addresses are invalid.
      // Force admin oracle mode for all devnet mirror markets (params.mainnetCA is set).
      const isDevnetMirror = !!params.mainnetCA;
      const resolvedOracleMode = params.oracleMode ?? (params.oracleFeed === ALL_ZEROS_FEED ? "admin" : "pyth");
      // "keeper" mode: AUTH_MARK oracle with oracle_authority delegated to our keeper service.
      // On devnet mirrors, hyperp falls back to admin; keeper stays keeper (it's designed for devnet).
      const oracleMode: "pyth" | "hyperp" | "admin" | "keeper" = (resolvedOracleMode === "hyperp" && isDevnetMirror) ? "admin" : resolvedOracleMode as "pyth" | "hyperp" | "admin" | "keeper";
      const isAdminOracle = oracleMode === "admin";
      const isHyperpOracle = oracleMode === "hyperp";
      const isKeeperOracle = oracleMode === "keeper";
      // PERC-devnet: isDevnetEnv must be runtime-detected, not build-time.
      // Users toggle devnet via localStorage — NEXT_PUBLIC_DEFAULT_NETWORK is always "mainnet" on Vercel prod.
      // Use getNetwork() which reads localStorage("percolator-network") first, then env var, then defaults
      // to "mainnet" (fail-closed). DO NOT use params.mainnetCA as a devnet proxy — it signals
      // "this is a devnet mirror market" not "the user is connected to devnet" (issue #835).
      const isDevnetEnv = getNetwork() === "devnet";

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

      setState((s) => ({
        ...s,
        loading: true,
        error: null,
        step: startStep,
        stepLabel: STEP_LABELS[startStep],
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

      try {
        // Step 0: Create slab + vault ATA + InitMarket (ATOMIC — all-or-nothing)
        // Merged into a single transaction to prevent SOL lock if InitMarket fails.
        // If any instruction fails, the entire tx rolls back — no stuck lamports.
        if (startStep <= 0) {
          setState((s) => ({ ...s, step: 0, stepLabel: STEP_LABELS[0] }));

          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);

          // Persist recovery state BEFORE sending TX0. Survives tab close so
          // the user can recover via the in-UI ReclaimSlabRent path or the
          // close-market-reclaim-all.ts script even if the browser dies.
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
          const expectedSlabSize = params.slabDataSize ?? DEFAULT_SLAB_SIZE;
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
              const requestedMarginBps = BigInt(params.initialMarginBps);
              const initialMarginBps = requestedMarginBps < MIN_SAFE_INITIAL_MARGIN_BPS
                ? MIN_SAFE_INITIAL_MARGIN_BPS
                : requestedMarginBps;
              const v17InitArgs: InitMarketV17Args = {
                maxPortfolioAssets: V17_MAX_PORTFOLIO_ASSETS,
                hMin: "1000",
                hMax: "100000",
                initialPrice: params.initialPriceE6.toString(),
                minNonzeroMmReq: "1000000",
                minNonzeroImReq: "2000000",
                maintenanceMarginBps: (initialMarginBps / 2n).toString(),
                initialMarginBps: initialMarginBps.toString(),
                maxTradingFeeBps: BigInt(params.tradingFeeBps).toString(),
                tradeFeeBaseBps: BigInt(params.tradingFeeBps).toString(),
                liquidationFeeBps: "50",
                liquidationFeeCap: "10000000000",
                minLiquidationAbs: "0",
                maxPriceMoveBpsPerSlot: "1",
                maxAccrualDtSlots: "500",
                maxAbsFundingE9PerSlot: "0",
                minFundingLifetimeSlots: "500",
                maxAccountBSettlementChunks: "10",
                maxBankruptCloseChunks: "10",
                maxBankruptCloseLifetimeSlots: "500",
                publicBChunkAtoms: "1000000000000",
                maintenanceFeePerSlot: "0",
              };
              const initMarketData = encodeInitMarket(v17InitArgs);

              const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
                wallet.publicKey, slabPk, params.mint, vaultAta,
                WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent,
                vaultPda, WELL_KNOWN.systemProgram,
              ]);
              const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

              const sig = await sendTx({
                connection, wallet,
                instructions: [createAtaIx, initMarketIx],
                computeUnits: 250_000,
              });
              setState((s) => ({
                ...s,
                txSigs: [...s.txSigs, sig],
                slabAddress: slabKp.publicKey.toBase58(),
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

            const effectiveSlabSize = params.slabDataSize ?? DEFAULT_SLAB_SIZE;
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
                  const airdropConfirm = await connection.confirmTransaction(airdropSig, "confirmed");
                  if (airdropConfirm.value.err) {
                    throw new Error(`Airdrop transaction failed on-chain: ${JSON.stringify(airdropConfirm.value.err)}`);
                  }
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

            const requestedMarginBps = BigInt(params.initialMarginBps);
            const initialMarginBps = requestedMarginBps < MIN_SAFE_INITIAL_MARGIN_BPS
              ? MIN_SAFE_INITIAL_MARGIN_BPS
              : requestedMarginBps;
            const v17InitArgs: InitMarketV17Args = {
              maxPortfolioAssets: 14,
              hMin: "1000",
              hMax: "100000",
              initialPrice: params.initialPriceE6.toString(),
              minNonzeroMmReq: "1000000",
              minNonzeroImReq: "2000000",
              maintenanceMarginBps: (initialMarginBps / 2n).toString(),
              initialMarginBps: initialMarginBps.toString(),
              maxTradingFeeBps: BigInt(params.tradingFeeBps).toString(),
              tradeFeeBaseBps: BigInt(params.tradingFeeBps).toString(),
              liquidationFeeBps: "50",
              liquidationFeeCap: "10000000000",
              minLiquidationAbs: "0",
              maxPriceMoveBpsPerSlot: "1",
              maxAccrualDtSlots: "500",
              maxAbsFundingE9PerSlot: "0",
              minFundingLifetimeSlots: "500",
              maxAccountBSettlementChunks: "10",
              maxBankruptCloseChunks: "10",
              maxBankruptCloseLifetimeSlots: "500",
              publicBChunkAtoms: "1000000000000",
              maintenanceFeePerSlot: "0",
            };
            const initMarketData = encodeInitMarket(v17InitArgs);

            const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
              wallet.publicKey, slabPk, params.mint, vaultAta,
              WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent,
              vaultPda, WELL_KNOWN.systemProgram,
            ]);
            const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

            const sig = await sendTx({
              connection,
              wallet,
              instructions: [createAccountIx, createAtaIx, initMarketIx],
              computeUnits: 300_000,
              signers: [slabKp],
              maxRetries: 0, // Don't auto-retry createAccount — use manual retry instead
            });

            setState((s) => ({
              ...s,
              txSigs: [...s.txSigs, sig],
              slabAddress: slabKp.publicKey.toBase58(),
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
          setState((s) => ({ ...s, step: 1, stepLabel: STEP_LABELS[1] }));

          const instructions: TransactionInstruction[] = [];

          // Detect if this is a v17 slab (v17 magic at bytes 0-7).
          let isV17Slab = false;
          try {
            const newSlabInfo = await connection.getAccountInfo(slabPk);
            if (newSlabInfo?.data) {
              isV17Slab = isV17Account(new Uint8Array(newSlabInfo.data));
            }
          } catch { /* fall through — conservative: assume v12 */ }

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
          if (isKeeperOracle && isV17Slab) {
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

            // Wallet signs (adds creator sig for ConfigureAuthMark + UpdateAssetAuthority)
            if (!wallet.signTransaction) throw new Error("Wallet does not support signTransaction");
            const signedTx = await wallet.signTransaction(partialTx);

            // Send the fully-signed tx
            const keeperDelegateSig = await connection.sendRawTransaction(signedTx.serialize(), {
              skipPreflight: false,
            });
            const keeperDelegateConfirm = await connection.confirmTransaction(keeperDelegateSig, "confirmed");
            if (keeperDelegateConfirm.value.err) {
              throw new Error(
                `Keeper delegate tx failed on-chain: ${JSON.stringify(keeperDelegateConfirm.value.err)}`,
              );
            }
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
            const crankData = encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 });
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
              connection, wallet, instructions, computeUnits: 500_000,
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
        if (startStep <= 2) {
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
            const V17_MAGIC_BYTES_STEP2 = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
            const existingLpPortfolios = await connection.getProgramAccounts(programId, {
              filters: [
                { memcmp: { offset: 0, bytes: V17_MAGIC_BYTES_STEP2.toString("base64"), encoding: "base64" } },
                { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                { memcmp: { offset: 80, bytes: wallet.publicKey.toBase58() } },
              ],
            });

            if (existingLpPortfolios.length === 0) {
              // TX A: Create LP portfolio account + InitPortfolio (tag 1).
              // Size + fund rent for the FULL portfolio length (9347): InitPortfolio reallocs up to it
              // and adds no lamports, so an undersized account fails with InsufficientFundsForRent.
              const lpPortfolioKp = Keypair.generate();
              const lpPortfolioPk = lpPortfolioKp.publicKey;
              const portfolioRent = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);

              const createPortfolioIx = SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: lpPortfolioPk,
                lamports: portfolioRent,
                space: V17_PORTFOLIO_ACCOUNT_LEN,
                programId,
              });
              const initPortfolioIx = buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
                  wallet.publicKey,
                  slabPk,
                  lpPortfolioPk,
                ]),
                data: encodeInitUser({}),
              });

              const sigPortfolio = await sendTx({
                connection, wallet,
                instructions: [createPortfolioIx, initPortfolioIx],
                signers: [lpPortfolioKp],
                computeUnits: 200_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sigPortfolio] }));

              // TX B: Create matcher context account ONLY (empty, matcher-program-owned).
              // No longer calls the matcher program directly here — see fix note above.
              const matcherCtxKp = Keypair.generate();
              const matcherCtxPk = matcherCtxKp.publicKey;
              const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CONTEXT_LEN);

              const createCtxIx = SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: matcherCtxPk,
                lamports: matcherCtxRent,
                space: MATCHER_CONTEXT_LEN,
                programId: matcherProgramId,
              });

              // Derive matcher delegate PDA: seeds = ["matcher", market, lpPortfolio, lpOwner, matcherProg, ctx]
              const [delegatePk] = deriveMatcherDelegate(
                programId, slabPk, lpPortfolioPk, wallet.publicKey, matcherProgramId, matcherCtxPk,
              );

              const sigCtx = await sendTx({
                connection, wallet,
                instructions: [createCtxIx],
                signers: [matcherCtxKp],
                computeUnits: 150_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sigCtx] }));

              // TX C: SetMatcherConfig (tag 68) on the LP portfolio — MUST land before TX D.
              // Accounts: [lpOwner(s), market(ro), lpPortfolio(w), matcherProg(ro), matcherCtx(ro), delegate(ro)]
              const setMatcherConfigIx = buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, [
                  wallet.publicKey,
                  slabPk,
                  lpPortfolioPk,
                  matcherProgramId,
                  matcherCtxPk,
                  delegatePk,
                ]),
                data: encodeSetMatcherConfig({ enabled: 1 }),
              });

              const sigMatcherCfg = await sendTx({
                connection, wallet,
                instructions: [setMatcherConfigIx],
                computeUnits: 200_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sigMatcherCfg] }));

              // TX D: InitMatcherCtx (tag 83) on the WRAPPER — CPIs into the matcher program,
              // invoke_signed-ing the delegate PDA so the matcher's process_init sees
              // lp_pda.is_signer == true. This is the real fix (see note above).
              // Accounts: [lpOwner(s), market(ro), lpPortfolio(ro), matcherCtx(w), matcherProg(ro), matcherDelegate(ro)]
              const I128_MAX = 170141183460469231731687303715884105727n;
              const initMatcherCtxIx = buildIx({
                programId,
                keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, [
                  wallet.publicKey,
                  slabPk,
                  lpPortfolioPk,
                  matcherCtxPk,
                  matcherProgramId,
                  delegatePk,
                ]),
                data: encodeInitMatcherCtx({
                  kind: 0, // Passive
                  tradingFeeBps: Number(params.tradingFeeBps),
                  baseSpreadBps: 50,
                  maxTotalBps: 200,
                  impactKBps: 0,
                  liquidityNotionalE6: 0n,
                  maxFillAbs: I128_MAX,
                  maxInventoryAbs: I128_MAX,
                  feeToInsuranceBps: 0,
                  skewSpreadMultBps: 0,
                }),
              });

              const sigInitMatcherCtx = await sendTx({
                connection, wallet,
                instructions: [initMatcherCtxIx],
                computeUnits: 200_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sigInitMatcherCtx] }));
            } else {
              console.log("[useCreateMarket] Step 2 already completed (LP portfolio exists) — skipping TX A-D.");
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
          setState((s) => ({ ...s, step: 3, stepLabel: STEP_LABELS[3] }));

          const userAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);

          // Pre-flight: verify user has enough tokens for LP deposit + insurance top-up.
          // Fixes #757/#758 — pre-fund only checked seed amount (500), but TX4 also
          // needs lpCollateral + insuranceAmount (default 1,000 + 100 = 1,100 more).
          const tx4Required = params.lpCollateral + params.insuranceAmount;
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
          if (isV17SlabDeposit) {
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

          const depositData = encodeDepositCollateral({
            amount: params.lpCollateral.toString(),
          });
          const depositKeys = isV17SlabDeposit
            ? buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
                wallet.publicKey, slabPk, depositPortfolioPk, userAta, vaultTokenAta,
                WELL_KNOWN.tokenProgram,
              ])
            : buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
                wallet.publicKey, slabPk, userAta, vaultAta,
                WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
              ]);

          const topupData = encodeTopUpInsurance({ amount: params.insuranceAmount.toString() });
          // ACCOUNTS_TOPUP_INSURANCE has 6 entries — clock was added in v12.19.
          // Earlier code passed only 5 pubkeys, which silently broke TX3 on
          // the deployed binary. SDK 2.0.9 has the right shape; we just need
          // to supply the matching 6th pubkey here.
          const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
            wallet.publicKey, slabPk, userAta, isV17SlabDeposit ? vaultTokenAta : vaultAta, WELL_KNOWN.tokenProgram,
          ]);
          const topupIx = buildIx({ programId, keys: topupKeys, data: topupData });

          // W2 fix (2026-07-08): read what's already on-chain BEFORE (re)sending the
          // deposit — a prior attempt (retry from this step, or a cross-session resume)
          // may have already landed it even though the overall create() call
          // subsequently failed/threw. Without this, every retry re-deposits
          // lpCollateral ON TOP OF whatever's already there.
          let alreadyDepositedCapital = 0n;
          if (isV17SlabDeposit) {
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
          if (alreadyDepositedCapital < params.lpCollateral) {
            const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });
            const depositSig = await sendTx({
              connection, wallet,
              instructions: [depositIx],
              computeUnits: 200_000,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, depositSig] }));
          } else {
            console.log("[useCreateMarket] Step 3 deposit already landed (portfolio capital >= target) — skipping.");
          }

          // TopUpInsurance + final crank — NOT part of the proven on-chain sequence
          // (launch-test-market.ts, the 8/8 ground truth, creates a tradeable market
          // without ever calling TopUpInsurance) and, per the H9/W3 fix above, no longer
          // bundled with the load-bearing deposit. Treat as best-effort: log and continue
          // rather than throwing, so a topup/crank revert can never strand an
          // otherwise-successful deposit or block Steps 4/5.
          try {
            // W2 idempotency for the top-up: the vault ATA is dedicated to this market
            // (each market gets its own vaultAuth PDA + ATA) and — since the W11 fix
            // removed the old vault-seed transfer from Step 0 — its balance is now
            // exactly lpCollateral-deposited + insurance-topped-up. Back out the
            // insurance component from (vault balance − LP capital) instead of a direct
            // balance read (the v17 SDK exposes no typed insurance-fund accessor) and
            // skip if it's already at/above target.
            let alreadyToppedUp = 0n;
            if (isV17SlabDeposit) {
              try {
                const [vaultAcct, freshPortInfo] = await Promise.all([
                  getAccount(connection, vaultTokenAta),
                  connection.getAccountInfo(depositPortfolioPk),
                ]);
                const freshCapital = freshPortInfo?.data
                  ? parsePortfolioV17(new Uint8Array(freshPortInfo.data)).capital
                  : alreadyDepositedCapital;
                alreadyToppedUp = vaultAcct.amount - freshCapital;
              } catch {
                // Treat as not-yet-topped-up — fall through to topup.
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
            {
              const crankData = encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 });
              const crankPortfolioPk = isV17SlabDeposit ? depositPortfolioPk : slabPk;
              const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
                wallet.publicKey, slabPk, crankPortfolioPk,
              ]);
              // For Pyth mode, append oracle feed account as tail
              if (!isAdminOracle && !isHyperpOracle) {
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
                connection, wallet,
                instructions: finalInstructions,
                computeUnits: 450_000,
              });
              setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
            }
          } catch (topupCrankErr) {
            console.warn(
              "[useCreateMarket] Step 3 insurance top-up/crank failed (non-fatal — deposit already landed):",
              topupCrankErr,
            );
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
        //   2. Sign nonce bytes with wallet.signMessage (ed25519)
        //   3. POST with { nonce, signature: base64 }
        if (startStep <= 4) {
          try {
            const deployerStr = wallet.publicKey.toBase58();

            // Step 1: fetch nonce challenge
            let nonce: string | null = null;
            let signature: string | null = null;
            if (wallet.signMessage) {
              try {
                const challengeResp = await fetch(
                  `/api/markets/challenge?deployer=${encodeURIComponent(deployerStr)}`,
                );
                if (challengeResp.ok) {
                  const { nonce: n } = await challengeResp.json() as { nonce: string };
                  nonce = n;
                  // Step 2: sign the nonce bytes
                  const nonceBytes = new TextEncoder().encode(nonce);
                  const sigBytes = await wallet.signMessage(nonceBytes);
                  signature = Buffer.from(sigBytes).toString("base64");
                }
              } catch (sigErr) {
                console.warn("[useCreateMarket] Nonce challenge/sign failed (non-fatal):", sigErr);
                // Fall through — POST will 400 if nonce/signature missing, but market is on-chain.
              }
            }

            await fetch("/api/markets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                slab_address: slabPk.toBase58(),
                mint_address: params.mint.toBase58(),
                symbol: params.symbol ?? "UNKNOWN",
                name: params.name ?? "Unknown Token",
                decimals: params.decimals ?? 6,
                deployer: deployerStr,
                oracle_mode: oracleMode,
                dex_pool_address: params.dexPoolAddress ?? null,
                oracle_authority: isAdminOracle
                  ? (isDevnetEnv && getConfig().crankWallet ? getConfig().crankWallet : deployerStr)
                  : null,
                initial_price_e6: params.initialPriceE6.toString(),
                // BUG 16 fix: advertise the FLOORED margin (what's actually enforced
                // on-chain), not the raw requested bps — see flooredInitialMarginBps doc.
                max_leverage: params.initialMarginBps > 0
                  ? Math.floor(10000 / flooredInitialMarginBps(params.initialMarginBps))
                  : 1,
                trading_fee_bps: Number(params.tradingFeeBps),
                lp_collateral: params.lpCollateral.toString(),
                mainnet_ca: params.mainnetCA ?? null,
                // PERC-8332: nonce + signature for deployer proof
                ...(nonce && signature ? { nonce, signature } : {}),
              }),
            });
          } catch {
            // Non-fatal — market is on-chain even if DB write fails
            console.warn("GH#1761: Failed to register market in dashboard DB");
          }
        }

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
          setState((s) => ({ ...s, step: 4, stepLabel: STEP_LABELS[4] }));

          const [lpVaultRegistry] = deriveLpVaultRegistry(programId, slabPk);
          const [lpVaultMint] = deriveInsuranceLpMint(programId, slabPk);

          // Idempotent on retry — a prior attempt may have already landed this ix
          // even though the overall create() call subsequently failed/threw.
          const existingRegistry = await connection.getAccountInfo(lpVaultRegistry);
          if (!existingRegistry) {
            const createLpVaultIx = buildIx({
              programId,
              keys: buildAccountMetas(ACCOUNTS_CREATE_LP_VAULT, {
                admin: wallet.publicKey,
                market: slabPk,
                registry: lpVaultRegistry,
                lpMint: lpVaultMint,
                systemProgram: WELL_KNOWN.systemProgram,
                tokenProgram: WELL_KNOWN.tokenProgram,
              }),
              data: encodeCreateLpVaultV17({
                feeShareBps: 1000, // 10% fee share — matches the 5 seeded markets
                oiReservationThresholdBps: 8000,
                redemptionCooldownSlots: 5n, // fast cooldown for devnet — matches seeded markets
                domain: 0,
              }),
            });

            const sigLpVault = await sendTx({
              connection,
              wallet,
              instructions: [createLpVaultIx],
              computeUnits: 250_000,
            });
            setState((s) => ({ ...s, txSigs: [...s.txSigs, sigLpVault] }));
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
        let keeperDelegated = false;
        let keeperMessage: string | null = null;
        if (isKeeperOracle && params.dexPoolAddress) {
          try {
            // H1v2 auth: keeper-register verifies slab ownership via a STATELESS
            // deployer-signed proof — sign `keeper-register:<slabAddress>:<unix-minute>`
            // and the route independently reconstructs + verifies it against a small
            // window around its own clock. No server-stored nonce.
            //
            // This replaced a nonce+challenge flow (GET /api/markets/challenge, sign,
            // claim) backed by a process-local Map (lib/playground-nonce-store.ts) —
            // on Vercel that Map is per-lambda-instance, so the GET that issued a nonce
            // and this POST that claimed it could land on different instances with no
            // shared memory. That contributed to the same real launch failing with
            // "Missing required fields: deployer, nonce, signature" / random "invalid
            // nonce" errors, layered on top of the ordering bug above. The stateless
            // message needs no shared state between requests, so it works regardless
            // of which instance handles it. Non-fatal either way: on failure the
            // market is still live on-chain.
            const keeperDeployer = wallet.publicKey.toBase58();
            let keeperSignature: string | null = null;
            if (wallet.signMessage) {
              try {
                const unixMinute = Math.floor(Date.now() / 60_000);
                const proofMsg = new TextEncoder().encode(
                  `keeper-register:${slabPk.toBase58()}:${unixMinute}`,
                );
                const sig = await wallet.signMessage(proofMsg);
                keeperSignature = Buffer.from(sig).toString("base64");
              } catch (sigErr) {
                console.warn("[useCreateMarket] keeper-register sign failed (non-fatal):", sigErr);
              }
            }
            const keeperRegResp = await fetch("/api/playground/keeper-register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                slabAddress: slabPk.toBase58(),
                mainnetCA: params.mainnetCA ?? null,
                dexPoolAddress: params.dexPoolAddress,
                // params.dexType carries DexScreener's raw dexId ("meteora",
                // "raydium") — normalize to the keeper vocabulary or the route
                // 400s and the market is orphaned (no price, no name).
                dexType: normalizeDexType(params.dexType) ?? params.dexType ?? "raydium-clmm",
                symbol: params.symbol ?? null,
                // H1v2 deployer proof (stateless, see above)
                deployer: keeperDeployer,
                ...(keeperSignature ? { signature: keeperSignature } : {}),
              }),
            });
            const keeperRegData = await keeperRegResp.json() as {
              registered?: boolean;
              message?: string;
              error?: string;
            };
            keeperDelegated = keeperRegData.registered ?? false;
            // Error responses put their reason in `error`, not `message` —
            // previously a 400/502 left keeperMessage null and the wizard
            // showed nothing, so users had no idea their market wasn't priced.
            keeperMessage =
              keeperRegData.message ??
              (keeperRegData.error
                ? `Keeper registration failed: ${keeperRegData.error} — the market is live on-chain but won't be priced or listed until it's registered.`
                : null);
            console.log("[useCreateMarket] Keeper registration:", keeperRegData);
          } catch (keeperErr) {
            console.warn("[useCreateMarket] Keeper registration failed (non-fatal):", keeperErr);
            keeperMessage = "Keeper registration failed — the market is live on-chain but won't be priced or listed until it's registered.";
          }
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
          setState((s) => ({ ...s, step: 5, stepLabel: STEP_LABELS[5] }));

          // Stake pools live under this deployment's vault program
          // (getConfig().vaultProgramId) — NOT the SDK's default stake
          // program id. Same lookup + fallback pattern as
          // hooks/useStakeDeposit.ts and hooks/useStakePool.ts.
          const stakeProgramId = new PublicKey(
            (getConfig() as { vaultProgramId?: string }).vaultProgramId ??
              "51CeUNpbXovK2BRADPyssuf3Q1xWGabEK9pYkp5mqVhQ",
          );
          const [stakePoolPda] = deriveStakePool(slabPk, stakeProgramId);

          // Idempotent on retry — if a prior attempt already landed InitPool,
          // don't try again (a fresh lpMint/vault keypair pair would be
          // orphaned, and InitPool would revert against an already-live pool).
          const existingPool = await connection.getAccountInfo(stakePoolPda);
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
              // cooldown=5 slots, depositCap=0 (uncapped) — matches the 5 seeded markets
              data: encodeStakeInitPool(5n, 0n),
            });

            const sigStake = await sendTx({
              connection,
              wallet,
              instructions: [createLpMintIx, createVaultIx, initPoolIx],
              signers: [stakeLpMintKp, stakeVaultKp],
              computeUnits: 300_000,
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

          // Mint devnet token + airdrop $500 to creator.
          // Use the devnet-airdrop endpoint (not devnet-mint-token) because the
          // mirror mint was already created by StepTokenSelect → devnet-mirror-mint.
          // devnet-mint-token expected a mainnet CA but received the devnet mirror
          // address, causing DexScreener lookup to fail → no tokens → untradeable market.
          setState((s) => ({ ...s, stepLabel: "Airdropping devnet tokens..." }));
          try {
            const airdropResp = await fetch("/api/devnet-airdrop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mintAddress: mintAddr,
                walletAddress: wallet.publicKey.toBase58(),
              }),
            });
            const airdropData = await airdropResp.json();
            if (airdropResp.ok || airdropResp.status === 429) {
              // 429 = already claimed, which is fine — user has tokens
              setState((s) => ({
                ...s,
                devnetMint: mintAddr,
                devnetAirdropAmount: airdropData.amount ?? null,
                devnetAirdropSymbol: airdropData.symbol ?? null,
              }));
            } else {
              console.warn("Devnet airdrop failed:", airdropData.error ?? airdropResp.status);
              // Non-fatal — market is live, user can use faucet button on trade page
              setState((s) => ({
                ...s,
                devnetMint: mintAddr, // Still set devnetMint so "Mint & Trade" works
                devnetMintError: airdropData.error ?? `HTTP ${airdropResp.status}`,
              }));
            }
          } catch (mintErr) {
            console.warn("Devnet airdrop error:", mintErr);
            setState((s) => ({
              ...s,
              devnetMint: mintAddr, // Still set so "Mint & Trade" button appears
              devnetMintError: mintErr instanceof Error ? mintErr.message : "Airdrop request failed",
            }));
          }
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
          // GH#1266: Defensively re-set slabAddress from slabPk at completion to guard
          // against any state-update race where a prior step's address is stale.
          slabAddress: slabPk.toBase58(),
        }));
      } catch (e) {
        const msg = parseMarketCreationError(e);
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
      devnetMint: null,
      devnetAirdropAmount: null,
      devnetAirdropSymbol: null,
      devnetMintError: null,
      insuranceMintFailed: false,
      keeperDelegated: false,
      keeperMessage: null,
    });
  }, []);

  return { state, create, reset, restoreSlabKeypair };
}
