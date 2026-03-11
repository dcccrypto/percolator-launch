"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
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
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeCreateInsuranceMint,
  deriveInsuranceLpMint,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  encodeKeeperCrank,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeSetOraclePriceCap,
  encodeUpdateConfig,
  encodeUpdateHyperpMark,
  detectDexType,
  parseDexPool,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_SET_ORACLE_PRICE_CAP,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_UPDATE_CONFIG,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
} from "@percolator/sdk";
import { sendTx } from "@/lib/tx";
import { getConfig, getNetwork } from "@/lib/config";
import { parseMarketCreationError } from "@/lib/parseMarketError";

import { SLAB_TIERS, slabDataSize, deriveLpPda } from "@percolator/sdk";
const DEFAULT_SLAB_SIZE = SLAB_TIERS.large.dataSize;
const ALL_ZEROS_FEED = "0".repeat(64);
const MATCHER_CTX_SIZE = 320; // Minimum context size for percolator matcher

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
  oracleMode?: "pyth" | "hyperp" | "admin";
  /** PERC-470: DEX pool address for hyperp mode (PumpSwap/Raydium/Meteora) */
  dexPoolAddress?: string;
  /** PERC-470: Base vault address for hyperp mode (PumpSwap) */
  dexBaseVault?: string;
  /** PERC-470: Quote vault address for hyperp mode (PumpSwap) */
  dexQuoteVault?: string;
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
  });

  // Persist slab keypair across retries so we can resume from any step
  const slabKpRef = useRef<Keypair | null>(null);

  // Load persisted keypair from localStorage on mount
  useEffect(() => {
    const persisted = localStorage.getItem("percolator-pending-slab-keypair");
    if (persisted) {
      try {
        const secretKey = Uint8Array.from(JSON.parse(persisted));
        slabKpRef.current = Keypair.fromSecretKey(secretKey);
      } catch {
        localStorage.removeItem("percolator-pending-slab-keypair");
      }
    }
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
      const oracleMode: "pyth" | "hyperp" | "admin" = (resolvedOracleMode === "hyperp" && isDevnetMirror) ? "admin" : resolvedOracleMode;
      const isAdminOracle = oracleMode === "admin";
      const isHyperpOracle = oracleMode === "hyperp";
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

      // Persist slab keypair in ref and localStorage so retries can reuse it even after page refresh
      let slabKp: Keypair;
      let slabPk: PublicKey;
      let vaultAta: PublicKey;

      if (startStep === 0) {
        slabKp = Keypair.generate();
        slabKpRef.current = slabKp;
        slabPk = slabKp.publicKey;
        // Persist to localStorage for retry after page refresh
        localStorage.setItem(
          "percolator-pending-slab-keypair",
          JSON.stringify(Array.from(slabKp.secretKey))
        );
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

      const [vaultPda] = deriveVaultAuthority(programId, slabPk);

      try {
        // Step 0: Create slab + vault ATA + InitMarket (ATOMIC — all-or-nothing)
        // Merged into a single transaction to prevent SOL lock if InitMarket fails.
        // If any instruction fails, the entire tx rolls back — no stuck lamports.
        if (startStep <= 0) {
          setState((s) => ({ ...s, step: 0, stepLabel: STEP_LABELS[0] }));

          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);

          // Check if slab account already exists (previous attempt may have landed)
          const existingAccount = await connection.getAccountInfo(slabKp.publicKey);
          if (existingAccount) {
            // Slab already created — check if market is initialized
            const headerMagic = existingAccount.data.length >= 8
              ? existingAccount.data.readBigUInt64LE(0)
              : 0n;
            const isInitialized = headerMagic === 0x504552434f4c4154n; // "PERCOLAT"

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

              const initialMarginBps = BigInt(params.initialMarginBps);
              const initMarketData = encodeInitMarket({
                admin: wallet.publicKey,
                collateralMint: params.mint,
                indexFeedId: params.oracleFeed,
                maxStalenessSecs: "86400",
                confFilterBps: 0,
                invert: params.invert ? 1 : 0,
                unitScale: 0,
                initialMarkPriceE6: params.initialPriceE6.toString(),
                warmupPeriodSlots: "100",
                maintenanceMarginBps: (initialMarginBps / 2n).toString(),
                initialMarginBps: initialMarginBps.toString(),
                tradingFeeBps: BigInt(params.tradingFeeBps).toString(),
                maxAccounts: (params.maxAccounts ?? 4096).toString(),
                newAccountFee: "1000000",
                riskReductionThreshold: "0",
                maintenanceFeePerSlot: "0",
                maxCrankStalenessSlots: "400",
                liquidationFeeBps: "100",
                liquidationFeeCap: "100000000000",
                liquidationBufferBps: "50",
                minLiquidationAbs: "1000000",
              });

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

            const initialMarginBps = BigInt(params.initialMarginBps);
            const initMarketData = encodeInitMarket({
              admin: wallet.publicKey,
              collateralMint: params.mint,
              indexFeedId: params.oracleFeed,
              maxStalenessSecs: "86400",
              confFilterBps: 0,
              invert: params.invert ? 1 : 0,
              unitScale: 0,
              initialMarkPriceE6: params.initialPriceE6.toString(),
              warmupPeriodSlots: "100",
              maintenanceMarginBps: (initialMarginBps / 2n).toString(),
              initialMarginBps: initialMarginBps.toString(),
              tradingFeeBps: BigInt(params.tradingFeeBps).toString(),
              maxAccounts: (params.maxAccounts ?? 4096).toString(),
              newAccountFee: "1000000",
              riskReductionThreshold: "0",
              maintenanceFeePerSlot: "0",
              maxCrankStalenessSlots: "400",
              liquidationFeeBps: "100",
              liquidationFeeCap: "100000000000",
              liquidationBufferBps: "50",
              minLiquidationAbs: "1000000",
            });

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
          }
        } else {
          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
        }

        // Step 1: Oracle setup + UpdateConfig + pre-LP crank
        // MidTermDev does this BEFORE InitLP — market must be cranked first
        if (startStep <= 1) {
          setState((s) => ({ ...s, step: 1, stepLabel: STEP_LABELS[1] }));

          const instructions: TransactionInstruction[] = [];

          if (isAdminOracle) {
            // After InitMarket, oracle_authority = PublicKey::default (all zeros)
            // IMPORTANT: SetOracleAuthority CLEARS authority_price_e6 to 0!
            // So we must: SetAuth(user) → Push → Cap → Config → Crank → THEN SetAuth(crank) last

            // 1. SetOracleAuthority → user becomes authority
            const setAuthToUserData = encodeSetOracleAuthority({ newAuthority: wallet.publicKey });
            const setAuthToUserKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
              wallet.publicKey, slabPk,
            ]);
            instructions.push(buildIx({ programId, keys: setAuthToUserKeys, data: setAuthToUserData }));

            // 2. PushOraclePrice (user is now authority)
            // PERC-465: Fetch fresh Jupiter price so we push the real market price,
            // not the pre-fetched (possibly stale or fallback $1) initialPriceE6.
            // Use mainnetCA if available (devnet mirror markets), else params.mint.
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

            // 3. SetOraclePriceCap — circuit breaker (10_000 = 1% max change per update)
            const priceCapData = encodeSetOraclePriceCap({ maxChangeE2bps: BigInt(10_000) });
            const priceCapKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_PRICE_CAP, [
              wallet.publicKey, slabPk,
            ]);
            instructions.push(buildIx({ programId, keys: priceCapKeys, data: priceCapData }));
          }

          // UpdateConfig — set funding rate parameters (MidTermDev Step 6)
          const updateConfigData = encodeUpdateConfig({
            fundingHorizonSlots: "3600",
            fundingKBps: "100",
            fundingInvScaleNotionalE6: "1000000000000",
            fundingMaxPremiumBps: "1000",
            fundingMaxBpsPerSlot: "10",
            threshFloor: "0",
            threshRiskBps: "500",
            threshUpdateIntervalSlots: "100",
            threshStepBps: "100",
            threshAlphaBps: "5000",
            threshMin: "0",
            threshMax: "1000000000000000000",
            threshMinStep: "0",
          });
          const updateConfigKeys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
            wallet.publicKey, slabPk,
          ]);
          instructions.push(buildIx({ programId, keys: updateConfigKeys, data: updateConfigData }));

          // Pre-LP crank — UpdateHyperpMark for hyperp mode, KeeperCrank otherwise
          if (isHyperpOracle && params.dexPoolAddress) {
            // PERC-470: UpdateHyperpMark reads DEX pool directly — no keeper needed
            const hyperpData = encodeUpdateHyperpMark();
            const hyperpKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
              { pubkey: slabPk, isSigner: false, isWritable: true },
              { pubkey: new PublicKey(params.dexPoolAddress), isSigner: false, isWritable: false },
              { pubkey: WELL_KNOWN.clock, isSigner: false, isWritable: false },
            ];
            // PumpSwap pools need vault0 + vault1 as remaining accounts
            if (params.dexBaseVault) {
              hyperpKeys.push({ pubkey: new PublicKey(params.dexBaseVault), isSigner: false, isWritable: false });
            }
            if (params.dexQuoteVault) {
              hyperpKeys.push({ pubkey: new PublicKey(params.dexQuoteVault), isSigner: false, isWritable: false });
            }
            instructions.push(new TransactionInstruction({ programId, keys: hyperpKeys, data: Buffer.from(hyperpData) }));
          } else {
            // KeeperCrank for Pyth and admin modes
            const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
            const oracleAccount = isAdminOracle ? slabPk : derivePythPushOraclePDA(params.oracleFeed)[0];
            const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
              wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount,
            ]);
            instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));
          }

          // NOTE: Do NOT delegate oracle authority here — SetOracleAuthority clears
          // authority_price_e6 to 0, which would break the final crank in Step 4.
          // Delegation happens at the very end of Step 4 instead.

          const sig = await sendTx({
            connection, wallet, instructions, computeUnits: 500_000,
          });
          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        }

        // Step 2: InitLP with matcher program (atomic: create ctx + init vAMM + init LP)
        if (startStep <= 2) {
          setState((s) => ({ ...s, step: 2, stepLabel: STEP_LABELS[2] }));

          const userAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
          const matcherProgramId = new PublicKey(getConfig().matcherProgramId);

          // Check if LP is already initialized for this slab — skip step 3 if so
          const lpIdx = 0;
          const [lpPdaCheck] = deriveLpPda(programId, slabPk, lpIdx);
          const existingLp = await connection.getAccountInfo(lpPdaCheck);
          if (existingLp && existingLp.data.length > 0) {
            // LP already initialized — skip to avoid orphaned matcher context
            setState((s) => ({ ...s, step: 3, stepLabel: STEP_LABELS[3] }));
          } else {

          const matcherCtxKp = Keypair.generate();
          const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

          const [lpPda] = deriveLpPda(programId, slabPk, lpIdx);

          // 1. Create matcher context account (skip if already exists)
          const existingCtx = await connection.getAccountInfo(matcherCtxKp.publicKey);
          const createCtxIx = existingCtx
            ? null
            : SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: matcherCtxKp.publicKey,
                lamports: matcherCtxRent,
                space: MATCHER_CTX_SIZE,
                programId: matcherProgramId,
              });

          // 2. Initialize LP
          // NOTE: The new reference AMM matcher (GTRgy...) does NOT have an
          // InitVamm (Tag 2) instruction. It only has Tag 0 (CPI matcher call).
          // The AMM reads LP config from context bytes 64..68 (spread_bps u16 +
          // max_fill_pct u16), using defaults (30 bps spread, 100% fill) when
          // zeroed. No separate initialization instruction is needed.
          const initLpData = encodeInitLP({
            matcherProgram: matcherProgramId,
            matcherContext: matcherCtxKp.publicKey,
            feePayment: "1000000",
          });
          const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
            wallet.publicKey, slabPk, userAta, vaultAta, WELL_KNOWN.tokenProgram,
          ]);
          const initLpIx = buildIx({ programId, keys: initLpKeys, data: initLpData });

          const lpInstructions = createCtxIx
            ? [createCtxIx, initLpIx]
            : [initLpIx];
          const lpSigners = createCtxIx ? [matcherCtxKp] : [];

          const sig = await sendTx({
            connection, wallet,
            instructions: lpInstructions,
            computeUnits: 300_000,
            signers: lpSigners,
          });
          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
          } // end else (LP not yet initialized)
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

          const depositData = encodeDepositCollateral({
            userIdx: 0,
            amount: params.lpCollateral.toString(),
          });
          const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
            wallet.publicKey, slabPk, userAta, vaultAta,
            WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
          ]);
          const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });

          const topupData = encodeTopUpInsurance({ amount: params.insuranceAmount.toString() });
          const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
            wallet.publicKey, slabPk, userAta, vaultAta, WELL_KNOWN.tokenProgram,
          ]);
          const topupIx = buildIx({ programId, keys: topupKeys, data: topupData });

          // Post-LP crank — engine needs to recognize LP capital
          // Must push fresh price first (user is still oracle authority at this point)
          const finalInstructions = [depositIx, topupIx];

          if (isAdminOracle) {
            // PERC-465: Push fresh price again in the final crank bundle.
            // Fetch from Jupiter first; fall back to the resolvedPriceE6 from step 1.
            const jupiterCA2 = params.mainnetCA ?? params.mint.toBase58();
            const freshPrice2 = await fetchJupiterPriceE6(jupiterCA2);
            const finalPriceE6 = freshPrice2 ?? params.initialPriceE6;

            const now2 = Math.floor(Date.now() / 1000);
            const pushData2 = encodePushOraclePrice({
              priceE6: finalPriceE6.toString(),
              timestamp: now2.toString(),
            });
            const pushKeys2 = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
              wallet.publicKey, slabPk,
            ]);
            finalInstructions.push(buildIx({ programId, keys: pushKeys2, data: pushData2 }));
          }

          // PERC-470: Final crank — UpdateHyperpMark for hyperp, KeeperCrank otherwise
          if (isHyperpOracle && params.dexPoolAddress) {
            const hyperpData = encodeUpdateHyperpMark();
            const hyperpKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
              { pubkey: slabPk, isSigner: false, isWritable: true },
              { pubkey: new PublicKey(params.dexPoolAddress), isSigner: false, isWritable: false },
              { pubkey: WELL_KNOWN.clock, isSigner: false, isWritable: false },
            ];
            if (params.dexBaseVault) {
              hyperpKeys.push({ pubkey: new PublicKey(params.dexBaseVault), isSigner: false, isWritable: false });
            }
            if (params.dexQuoteVault) {
              hyperpKeys.push({ pubkey: new PublicKey(params.dexQuoteVault), isSigner: false, isWritable: false });
            }
            finalInstructions.push(new TransactionInstruction({ programId, keys: hyperpKeys, data: Buffer.from(hyperpData) }));
          } else {
            const oracleAccount = isAdminOracle ? slabPk : derivePythPushOraclePDA(params.oracleFeed)[0];
            const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
            const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
              wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount,
            ]);
            finalInstructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));
          }

          // PERC-465: On devnet, delegate oracle authority to the crank keypair so the
          // oracle keeper can continuously push live prices for this new market.
          // SetOracleAuthority is added AFTER the final crank — it clears authority_price_e6
          // but that's fine here since the crank has already processed the current price.
          // PERC-470: Skip for hyperp mode — oracle_authority stays zeros (permissionless).
          if (isDevnetEnv && isAdminOracle) {
            const crankPubkey = getConfig().crankWallet;
            if (crankPubkey && crankPubkey.trim() !== "") {
              try {
                const crankPk = new PublicKey(crankPubkey);
                const setAuthToCrankData = encodeSetOracleAuthority({ newAuthority: crankPk });
                const setAuthToCrankKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
                  wallet.publicKey, slabPk,
                ]);
                finalInstructions.push(buildIx({ programId, keys: setAuthToCrankKeys, data: setAuthToCrankData }));
              } catch {
                // Non-fatal: invalid crankWallet config — market still works, keeper just can't push prices
                console.warn("PERC-465: Invalid crankWallet config — skipping oracle authority delegation");
              }
            }
          }

          const sig = await sendTx({
            connection, wallet,
            instructions: finalInstructions,
            computeUnits: 450_000,
          });
          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        }

        // Step 4: Create Insurance LP Mint (permissionless insurance deposits)
        if (startStep <= 4) {
          setState((s) => ({ ...s, step: 4, stepLabel: STEP_LABELS[4] }));

          const [insLpMint] = deriveInsuranceLpMint(programId, slabPk);
          const [vaultAuth] = deriveVaultAuthority(programId, slabPk);

          const createMintData = encodeCreateInsuranceMint();
          const createMintKeys = buildAccountMetas(ACCOUNTS_CREATE_INSURANCE_MINT, [
            wallet.publicKey,          // admin (signer)
            slabPk,                    // slab
            insLpMint,                 // ins_lp_mint (writable, PDA)
            vaultAuth,                 // vault_authority
            params.mint,               // collateral_mint
            SystemProgram.programId,   // system_program
            WELL_KNOWN.tokenProgram,   // token_program
            WELL_KNOWN.rent,           // rent
            wallet.publicKey,          // payer (signer, writable)
          ]);
          const createMintIx = buildIx({ programId, keys: createMintKeys, data: createMintData });

          const sig = await sendTx({
            connection, wallet,
            instructions: [createMintIx],
            computeUnits: 200_000,
          });
          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        }

        // Register market in Supabase so dashboard can see it
        try {
          await fetch("/api/markets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slab_address: slabPk.toBase58(),
              mint_address: params.mint.toBase58(),
              symbol: params.symbol ?? "UNKNOWN",
              name: params.name ?? "Unknown Token",
              decimals: params.decimals ?? 6,
              deployer: wallet.publicKey.toBase58(),
              oracle_mode: oracleMode,
              dex_pool_address: params.dexPoolAddress ?? null,
              oracle_authority: isAdminOracle
                ? (isDevnetEnv && getConfig().crankWallet ? getConfig().crankWallet : wallet.publicKey.toBase58())
                : null,
              initial_price_e6: params.initialPriceE6.toString(),
              max_leverage: params.initialMarginBps > 0 ? Math.floor(10000 / Number(params.initialMarginBps)) : 1,
              trading_fee_bps: Number(params.tradingFeeBps),
              lp_collateral: params.lpCollateral.toString(),
              mainnet_ca: params.mainnetCA ?? null,
            }),
          });
        } catch {
          // Non-fatal — market is on-chain even if DB write fails
          console.warn("Failed to register market in dashboard DB");
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

        // Done! Clear persisted keypair from localStorage
        localStorage.removeItem("percolator-pending-slab-keypair");
        setState((s) => ({
          ...s,
          loading: false,
          step: 5,
          stepLabel: "Market created!",
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
    localStorage.removeItem("percolator-pending-slab-keypair");
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
    });
  }, []);

  return { state, create, reset };
}
