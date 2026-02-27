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
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_UPDATE_CONFIG,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
} from "@percolator/sdk";
import { sendTx } from "@/lib/tx";
import { getConfig } from "@/lib/config";
import { parseMarketCreationError } from "@/lib/parseMarketError";

import { SLAB_TIERS, slabDataSize, deriveLpPda } from "@percolator/sdk";
const DEFAULT_SLAB_SIZE = SLAB_TIERS.large.dataSize;
const ALL_ZEROS_FEED = "0".repeat(64);
const MATCHER_CTX_SIZE = 320; // Minimum context size for percolator matcher

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
  /** Number of trader slots (64, 256, 1024, 4096). Defaults to 4096 if omitted. */
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
}

export interface CreateMarketState {
  step: number;
  stepLabel: string;
  txSigs: string[];
  slabAddress: string | null;
  error: string | null;
  loading: boolean;
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
      const tierMap: Record<number, string> = { 256: "small", 1024: "medium", 4096: "large" };
      const tierKey = tierMap[params.maxAccounts ?? 256] ?? "small";
      const programsByTier = (cfg as Record<string, unknown>).programsBySlabTier as Record<string, string> | undefined;
      const selectedProgramId = programsByTier?.[tierKey] ?? cfg.programId;
      const programId = new PublicKey(selectedProgramId);
      const isAdminOracle = params.oracleFeed === ALL_ZEROS_FEED;
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

              // Seed the vault — same fix as fresh creation path
              const userCollateralAtaRecovery = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
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
                maxAccounts: (params.maxAccounts ?? 256).toString(),
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
            // Fresh creation — atomic: createAccount + createATA + InitMarket
            const effectiveSlabSize = params.slabDataSize ?? DEFAULT_SLAB_SIZE;
            const slabRent = await connection.getMinimumBalanceForRentExemption(effectiveSlabSize);
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
              maxAccounts: (params.maxAccounts ?? 256).toString(),
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
            const now = Math.floor(Date.now() / 1000);
            const pushData = encodePushOraclePrice({
              priceE6: params.initialPriceE6.toString(),
              timestamp: now.toString(),
            });
            const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
              wallet.publicKey, slabPk,
            ]);
            instructions.push(buildIx({ programId, keys: pushKeys, data: pushData }));

            // 3. SetOraclePriceCap — circuit breaker (10_000 = 1% max change per update)
            const priceCapData = encodeSetOraclePriceCap({ maxChangeE2bps: BigInt(10_000) });
            const priceCapKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
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

          // Pre-LP KeeperCrank (must come BEFORE SetAuth to crank, since SetAuth clears price)
          const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
          const oracleAccount = isAdminOracle ? slabPk : derivePythPushOraclePDA(params.oracleFeed)[0];
          const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
            wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount,
          ]);
          instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));

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
            const now2 = Math.floor(Date.now() / 1000);
            const pushData2 = encodePushOraclePrice({
              priceE6: params.initialPriceE6.toString(),
              timestamp: now2.toString(),
            });
            const pushKeys2 = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
              wallet.publicKey, slabPk,
            ]);
            finalInstructions.push(buildIx({ programId, keys: pushKeys2, data: pushData2 }));
          }

          const oracleAccount = isAdminOracle ? slabPk : derivePythPushOraclePDA(params.oracleFeed)[0];
          const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
          const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
            wallet.publicKey, slabPk, WELL_KNOWN.clock, oracleAccount,
          ]);
          finalInstructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));

          // NOTE: For admin oracle markets, user STAYS as oracle authority.
          // This lets the admin push prices from the My Markets UI.
          // The crank service handles price push failures gracefully (non-fatal).
          // Admin can delegate to crank later via "Delegate to Crank" button.

          const sig = await sendTx({
            connection, wallet,
            instructions: finalInstructions,
            computeUnits: 400_000,
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
              oracle_authority: isAdminOracle ? wallet.publicKey.toBase58() : null,
              initial_price_e6: params.initialPriceE6.toString(),
              max_leverage: params.initialMarginBps > 0 ? Math.floor(10000 / Number(params.initialMarginBps)) : 1,
              trading_fee_bps: Number(params.tradingFeeBps),
              lp_collateral: params.lpCollateral.toString(),
            }),
          });
        } catch {
          // Non-fatal — market is on-chain even if DB write fails
          console.warn("Failed to register market in dashboard DB");
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
    });
  }, []);

  return { state, create, reset };
}
