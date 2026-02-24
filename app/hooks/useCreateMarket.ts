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
  getAssociatedTokenAddress,
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

import { SLAB_TIERS, slabDataSize, deriveLpPda } from "@percolator/sdk";
const DEFAULT_SLAB_SIZE = SLAB_TIERS.large.dataSize;
const ALL_ZEROS_FEED = "0".repeat(64);
const MATCHER_CTX_SIZE = 320; // Minimum context size for percolator matcher

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
  "Creating slab account...",
  "Initializing market & vault...",
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
        // Step 0: Create slab account (idempotent — skips if account already exists)
        if (startStep <= 0) {
          setState((s) => ({ ...s, step: 0, stepLabel: STEP_LABELS[0] }));

          // Check if slab account already exists (previous attempt may have landed)
          const existingAccount = await connection.getAccountInfo(slabKp.publicKey);
          if (existingAccount) {
            // Account already created — skip to next step
            setState((s) => ({
              ...s,
              txSigs: [...s.txSigs, "skipped-already-exists"],
              slabAddress: slabKp.publicKey.toBase58(),
            }));
          } else {
            const effectiveSlabSize = params.slabDataSize ?? DEFAULT_SLAB_SIZE;
            const slabRent = await connection.getMinimumBalanceForRentExemption(effectiveSlabSize);
            const createAccountIx = SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: slabKp.publicKey,
              lamports: slabRent,
              space: effectiveSlabSize,
              programId,
            });

            const sig = await sendTx({
              connection,
              wallet,
              instructions: [createAccountIx],
              computeUnits: 50_000,
              signers: [slabKp],
              maxRetries: 0, // Don't retry createAccount — idempotency check handles it
            });

            setState((s) => ({
              ...s,
              txSigs: [...s.txSigs, sig],
              slabAddress: slabKp.publicKey.toBase58(),
            }));
          }
        }

        // Step 1: Create vault ATA + InitMarket (merged — 1 tx instead of 2)
        if (startStep <= 1) {
          setState((s) => ({ ...s, step: 1, stepLabel: STEP_LABELS[1] }));

          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
          const createAtaIx = createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            vaultAta,
            vaultPda,
            params.mint,
          );

          const initialMarginBps = BigInt(params.initialMarginBps);
          const initMarketData = encodeInitMarket({
            admin: wallet.publicKey,
            collateralMint: params.mint,
            indexFeedId: params.oracleFeed,
            maxStalenessSecs: "86400",           // 24h — generous for admin oracle mode
            confFilterBps: 0,
            invert: params.invert ? 1 : 0,
            unitScale: 0,
            initialMarkPriceE6: params.initialPriceE6.toString(),
            warmupPeriodSlots: "100",              // Match MidTermDev — warmup before trading
            maintenanceMarginBps: (initialMarginBps / 2n).toString(),
            initialMarginBps: initialMarginBps.toString(),
            tradingFeeBps: BigInt(params.tradingFeeBps).toString(),
            maxAccounts: (params.maxAccounts ?? 256).toString(),
            newAccountFee: "1000000",
            riskReductionThreshold: "0",
            maintenanceFeePerSlot: "0",
            maxCrankStalenessSlots: "400",         // Match MidTermDev — more forgiving
            liquidationFeeBps: "100",
            liquidationFeeCap: "100000000000",     // Cap liquidation fees (was 0 = uncapped)
            liquidationBufferBps: "50",
            minLiquidationAbs: "1000000",          // Prevent dust liquidations
          });

          const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
            wallet.publicKey,
            slabPk,
            params.mint,
            vaultAta,
            WELL_KNOWN.tokenProgram,
            WELL_KNOWN.clock,
            WELL_KNOWN.rent,
            vaultPda,              // dummyAta slot — MidTermDev passes vaultPda here
            WELL_KNOWN.systemProgram,
          ]);

          const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });
          const sig = await sendTx({
            connection,
            wallet,
            instructions: [createAtaIx, initMarketIx],
            computeUnits: 200_000,
          });

          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        } else {
          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
        }

        // Step 2: Oracle setup + UpdateConfig + pre-LP crank
        // MidTermDev does this BEFORE InitLP — market must be cranked first
        if (startStep <= 2) {
          setState((s) => ({ ...s, step: 2, stepLabel: STEP_LABELS[2] }));

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

        // Step 3: InitLP with matcher program (atomic: create ctx + init vAMM + init LP)
        if (startStep <= 3) {
          setState((s) => ({ ...s, step: 3, stepLabel: STEP_LABELS[3] }));

          const userAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);
          const matcherProgramId = new PublicKey(getConfig().matcherProgramId);

          // Check if LP is already initialized for this slab — skip step 3 if so
          const lpIdx = 0;
          const [lpPdaCheck] = deriveLpPda(programId, slabPk, lpIdx);
          const existingLp = await connection.getAccountInfo(lpPdaCheck);
          if (existingLp && existingLp.data.length > 0) {
            // LP already initialized — skip to avoid orphaned matcher context
            setState((s) => ({ ...s, step: 4, stepLabel: STEP_LABELS[4] }));
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

          // 2. Initialize vAMM matcher (Tag 2, 66 bytes)
          // Use custom vAMM params if provided, otherwise defaults
          const vp = params.vammParams;
          const vammData = new Uint8Array(66);
          const vammDv = new DataView(vammData.buffer);
          let off = 0;
          vammData[off] = 2; off += 1;             // Tag 2 = InitVamm
          vammData[off] = 0; off += 1;             // mode 0 = passive
          vammDv.setUint32(off, params.tradingFeeBps, true); off += 4;   // tradingFeeBps
          vammDv.setUint32(off, vp?.spreadBps ?? 50, true); off += 4;   // baseSpreadBps
          vammDv.setUint32(off, vp?.maxTotalBps ?? 200, true); off += 4;  // maxTotalBps
          vammDv.setUint32(off, vp?.impactKBps ?? 0, true); off += 4;    // impactKBps
          vammDv.setBigUint64(off, BigInt(vp?.liquidityE6 ?? "10000000000000"), true); off += 8;
          vammDv.setBigUint64(off, 0n, true); off += 8;
          vammDv.setBigUint64(off, 1_000_000_000_000n, true); off += 8;
          vammDv.setBigUint64(off, 0n, true); off += 8;
          vammDv.setBigUint64(off, 0n, true); off += 8;
          vammDv.setBigUint64(off, 0n, true); off += 8;

          const initMatcherIx = new TransactionInstruction({
            programId: matcherProgramId,
            keys: [
              { pubkey: lpPda, isSigner: false, isWritable: false },
              { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
            ],
            data: Buffer.from(vammData),
          });

          // 3. Initialize LP
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
            ? [createCtxIx, initMatcherIx, initLpIx]
            : [initMatcherIx, initLpIx];
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

        // Step 4: DepositCollateral + TopUpInsurance + Final Crank (merged)
        if (startStep <= 4) {
          setState((s) => ({ ...s, step: 4, stepLabel: STEP_LABELS[4] }));

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

        // Step 5: Create Insurance LP Mint (permissionless insurance deposits)
        if (startStep <= 5) {
          setState((s) => ({ ...s, step: 5, stepLabel: STEP_LABELS[5] }));

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
          step: 6,
          stepLabel: "Market created!",
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
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
