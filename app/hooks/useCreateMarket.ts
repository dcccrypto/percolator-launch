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
  createTransferInstruction,
  getAssociatedTokenAddress,
  getAccount,
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
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  deriveMatcherDelegate,
  deriveNftRegistry,
  parseHeader,
  isV17Account,
  v17MarketAccountLen,
  V17_PORTFOLIO_ACCOUNT_LEN,
  MATCHER_CONTEXT_LEN,
} from "@percolatorct/sdk";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
// v17: SetOracleAuthority (tag 17), PushOraclePrice (tag 16), SetOraclePriceCap (tag 16),
// and UpdateConfig (tag 14) do not exist in v17. All oracle + risk params are embedded
// in InitMarket (extended tail). The sdk-compat stubs throw at runtime if called.
// We guard all callsites with isAdminOracle && !isV17Slab before using these.
import { sendTx } from "@/lib/tx";
import { getConfig, getNetwork } from "@/lib/config";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import {
  saveInFlightMarket,
  updateInFlightStep,
  clearInFlightMarket,
} from "@/lib/inFlightMarket";
// v17: max assets per portfolio (= the market's asset-slot capacity); program cap = 14.
// The slab MUST be sized to exactly match this capacity or InitMarket reverts (dynamic-len validation).
const V17_MAX_PORTFOLIO_ASSETS = 14;
const DEFAULT_SLAB_SIZE = v17MarketAccountLen(V17_MAX_PORTFOLIO_ASSETS); // 26_364 bytes (cap-14)
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
const MIN_SAFE_INITIAL_MARGIN_BPS = 1500n;

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
   * GH#1761: Set to true when step 5 (Insurance LP Mint) fails after exhausting retries.
   * The market is still live and tradeable — this is non-fatal. The mint can be retried
   * independently later. Success screen shows a soft warning rather than hard error.
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
  "Creating insurance LP mint...",
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

  // PERC-8329 / GH#1964: Slab keypair is kept in-memory ONLY — never in localStorage.
  // Persisting a secret key in localStorage is unsafe: any same-origin script (including
  // browser extensions) can read it. If the user refreshes mid-flow, they must start over.
  // The in-memory ref is sufficient for the single-session retry path (step resume).
  const slabKpRef = useRef<Keypair | null>(null);

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
        slabKp = Keypair.generate();
        slabKpRef.current = slabKp;
        slabPk = slabKp.publicKey;
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

              // Pre-flight: verify user holds enough tokens for the vault seed transfer.
              // On devnet, auto-fund via /api/devnet-pre-fund if the user is short.
              const userCollateralAtaRecovery = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
              let recoveryBalance = 0n;
              try {
                const acct = await getAccount(connection, userCollateralAtaRecovery);
                recoveryBalance = acct.amount;
              } catch {
                // Account doesn't exist — balance stays 0
              }
              if (recoveryBalance < MIN_INIT_MARKET_SEED) {
                if (isDevnetEnv) {
                  setState((s) => ({ ...s, stepLabel: "Funding devnet wallet for vault seed..." }));
                  const fundResp = await fetch("/api/devnet-pre-fund", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      mintAddress: params.mint.toBase58(),
                      walletAddress: wallet.publicKey.toBase58(),
                    }),
                  });
                  if (!fundResp.ok) {
                    const err = await fundResp.json().catch(() => ({ error: "Unknown error" }));
                    throw new Error(`Devnet pre-fund failed: ${err.error ?? fundResp.status}`);
                  }
                  // Reset label — don't leave UI stuck at "Funding devnet wallet…"
                  setState((s) => ({ ...s, stepLabel: STEP_LABELS[0] }));
                } else {
                  const decimals = params.decimals ?? 6;
                  const needed = Number(MIN_INIT_MARKET_SEED) / 10 ** decimals;
                  const have = Number(recoveryBalance) / 10 ** decimals;
                  throw new Error(
                    `Insufficient token balance for vault seed. ` +
                    `You need at least ${needed.toLocaleString()} tokens but your wallet holds ${have.toLocaleString()}. ` +
                    `Please fund your wallet with the collateral mint before creating a market.`
                  );
                }
              }
              const seedTransferIxRecovery = createTransferInstruction(
                userCollateralAtaRecovery, vaultAta, wallet.publicKey, MIN_INIT_MARKET_SEED,
              );

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
                instructions: [createAtaIx, seedTransferIxRecovery, initMarketIx],
                computeUnits: 250_000,
              });
              setState((s) => ({
                ...s,
                txSigs: [...s.txSigs, sig],
                slabAddress: slabKp.publicKey.toBase58(),
              }));
            }
          } else {
            // Fresh creation — atomic: createAccount + createATA + seed transfer + InitMarket

            // Pre-flight: verify user holds enough tokens for the vault seed transfer.
            // Without this check the TX fails at the Transfer instruction with an opaque
            // "invalid account data" error when the user's ATA doesn't exist or is empty.
            // On devnet, auto-fund via /api/devnet-pre-fund; on mainnet, surface a clear error.
            const userCollateralAtaCheck = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
            let userTokenBalance = 0n;
            try {
              const acct = await getAccount(connection, userCollateralAtaCheck);
              userTokenBalance = acct.amount;
            } catch {
              // Account doesn't exist — balance stays 0
            }
            if (userTokenBalance < MIN_INIT_MARKET_SEED) {
              if (isDevnetEnv) {
                // Auto-fund: server mints seed tokens directly to user wallet
                setState((s) => ({ ...s, stepLabel: "Funding devnet wallet for vault seed..." }));
                const fundResp = await fetch("/api/devnet-pre-fund", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    mintAddress: params.mint.toBase58(),
                    walletAddress: wallet.publicKey.toBase58(),
                  }),
                });
                if (!fundResp.ok) {
                  const err = await fundResp.json().catch(() => ({ error: "Unknown error" }));
                  throw new Error(`Devnet pre-fund failed: ${err.error ?? fundResp.status}`);
                }
                // Re-check label for the actual creation step
                setState((s) => ({ ...s, stepLabel: STEP_LABELS[0] }));
              } else {
                const decimals = params.decimals ?? 6;
                const needed = Number(MIN_INIT_MARKET_SEED) / 10 ** decimals;
                const have = Number(userTokenBalance) / 10 ** decimals;
                throw new Error(
                  `Insufficient token balance for vault seed. ` +
                  `You need at least ${needed.toLocaleString()} tokens (${MIN_INIT_MARKET_SEED.toString()} raw) ` +
                  `but your wallet holds ${have.toLocaleString()}. ` +
                  `Please fund your wallet with the collateral mint before creating a market.`
                );
              }
            }

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

            // Seed the vault with MIN_INIT_MARKET_SEED tokens — program requires this before InitMarket
            const userCollateralAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
            const seedTransferIx = createTransferInstruction(
              userCollateralAta, vaultAta, wallet.publicKey, MIN_INIT_MARKET_SEED,
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
              instructions: [createAccountIx, createAtaIx, seedTransferIx, initMarketIx],
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
            const [nftRegistryPda] = deriveNftRegistry(programId, slabPk);
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

          const sig = await sendTx({
            connection, wallet, instructions, computeUnits: 500_000,
          });
          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
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
          const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });

          const topupData = encodeTopUpInsurance({ amount: params.insuranceAmount.toString() });
          // ACCOUNTS_TOPUP_INSURANCE has 6 entries — clock was added in v12.19.
          // Earlier code passed only 5 pubkeys, which silently broke TX3 on
          // the deployed binary. SDK 2.0.9 has the right shape; we just need
          // to supply the matching 6th pubkey here.
          const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
            wallet.publicKey, slabPk, userAta, isV17SlabDeposit ? vaultTokenAta : vaultAta, WELL_KNOWN.tokenProgram,
          ]);
          const topupIx = buildIx({ programId, keys: topupKeys, data: topupData });

          // Post-LP crank — engine needs to recognize LP capital
          // Must push fresh price first (user is still oracle authority at this point)
          const finalInstructions = [depositIx, topupIx];

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

          const sig = await sendTx({
            connection, wallet,
            instructions: finalInstructions,
            computeUnits: 450_000,
          });
          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        }

        // GH#1761: Register market in Supabase BEFORE step 5 (Insurance LP Mint).
        // Steps 1-4 create a live, tradeable market. Moving registration here ensures
        // symbol, mainnet_ca, and oracle_authority are stored even if step 5 fails.
        // Previously this ran after step 5, so a step-5 timeout left the market on-chain
        // with no DB record → dashboard showed random chars (CCPHprPU) instead of symbol.
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
                max_leverage: params.initialMarginBps > 0 ? Math.floor(10000 / Number(params.initialMarginBps)) : 1,
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

        // Insurance LP mint creation removed — moved to percolator-stake program.
        // Markets are fully operational without it (steps 0-3 are sufficient).

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

        // Keeper registration — non-fatal; market is live regardless.
        // Registers { marketAddress, poolAddress, dexType } with the keeper service so
        // PushAuthMark price-push starts within the next keeper cycle (~30s).
        let keeperDelegated = false;
        let keeperMessage: string | null = null;
        if (isKeeperOracle && params.dexPoolAddress) {
          try {
            const keeperRegResp = await fetch("/api/playground/keeper-register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                slabAddress: slabPk.toBase58(),
                mainnetCA: params.mainnetCA ?? null,
                dexPoolAddress: params.dexPoolAddress,
                dexType: params.dexType ?? "raydium-clmm",
                symbol: params.symbol ?? null,
              }),
            });
            const keeperRegData = await keeperRegResp.json() as {
              registered?: boolean;
              message?: string;
            };
            keeperDelegated = keeperRegData.registered ?? false;
            keeperMessage = keeperRegData.message ?? null;
            console.log("[useCreateMarket] Keeper registration:", keeperRegData);
          } catch (keeperErr) {
            console.warn("[useCreateMarket] Keeper registration failed (non-fatal):", keeperErr);
            keeperMessage = "Keeper registration failed — prices will start on next keeper discovery cycle";
          }
        }

        // Done! Clear in-memory keypair ref + in-flight recovery state.
        slabKpRef.current = null;
        clearInFlightMarket(slabPk.toBase58());
        setState((s) => ({
          ...s,
          loading: false,
          step: 5,
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

  return { state, create, reset };
}
