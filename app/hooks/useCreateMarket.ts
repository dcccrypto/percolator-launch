"use client";

import { useCallback, useState } from "react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { config } from "@/lib/config";

const SLAB_SIZE = 992_560;
const ALL_ZEROS_FEED = "0".repeat(64);

export interface CreateMarketParams {
  mint: PublicKey;
  initialPriceE6: bigint;
  lpCollateral: bigint;
  insuranceAmount: bigint;
  oracleFeed: string;
  invert: boolean;
  tradingFeeBps: number;
  initialMarginBps: number;
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
  "Creating vault token account...",
  "Initializing market...",
  "Initializing LP...",
  "Depositing collateral & insurance...",
  "Setting up oracle & cranking...",
];

export function useCreateMarket() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [state, setState] = useState<CreateMarketState>({
    step: 0,
    stepLabel: "",
    txSigs: [],
    slabAddress: null,
    error: null,
    loading: false,
  });

  const create = useCallback(
    async (params: CreateMarketParams, retryFromStep?: number) => {
      if (!wallet.publicKey || !wallet.sendTransaction) {
        setState((s) => ({ ...s, error: "Wallet not connected" }));
        return;
      }

      const programId = new PublicKey(config.programId);
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

      // For retry, we need to reuse the slab keypair. We store it in a ref-like closure.
      // On fresh start, generate a new keypair.
      let slabKp: Keypair;
      let slabPk: PublicKey;
      let vaultAta: PublicKey;

      if (startStep === 0) {
        slabKp = Keypair.generate();
        slabPk = slabKp.publicKey;
      } else {
        // On retry, slab address must already be set
        if (!state.slabAddress) {
          setState((s) => ({
            ...s,
            loading: false,
            error: "Cannot retry: slab address unknown. Please start over.",
          }));
          return;
        }
        slabPk = new PublicKey(state.slabAddress);
        // We can't recover the keypair for step 0 retry, but steps > 0 don't need it as a signer
        slabKp = null as unknown as Keypair; // Not needed for steps > 0
      }

      const [vaultPda] = deriveVaultAuthority(programId, slabPk);

      try {
        // Step 0: Create slab account
        if (startStep <= 0) {
          setState((s) => ({ ...s, step: 0, stepLabel: STEP_LABELS[0] }));

          const slabRent = await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
          const createAccountIx = SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: slabKp.publicKey,
            lamports: slabRent,
            space: SLAB_SIZE,
            programId,
          });

          const sig = await sendTx({
            connection,
            wallet,
            instructions: [createAccountIx],
            computeUnits: 50_000,
            signers: [slabKp],
          });

          setState((s) => ({
            ...s,
            txSigs: [...s.txSigs, sig],
            slabAddress: slabKp.publicKey.toBase58(),
          }));
        }

        // Step 1: Create vault ATA
        if (startStep <= 1) {
          setState((s) => ({ ...s, step: 1, stepLabel: STEP_LABELS[1] }));

          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
          const createAtaIx = createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            vaultAta,
            vaultPda,
            params.mint,
          );

          const sig = await sendTx({
            connection,
            wallet,
            instructions: [createAtaIx],
            computeUnits: 100_000,
          });

          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        } else {
          vaultAta = await getAssociatedTokenAddress(params.mint, vaultPda, true);
        }

        // Step 2: InitMarket
        if (startStep <= 2) {
          setState((s) => ({ ...s, step: 2, stepLabel: STEP_LABELS[2] }));

          const initialMarginBps = BigInt(params.initialMarginBps);
          const initMarketData = encodeInitMarket({
            admin: wallet.publicKey,
            collateralMint: params.mint,
            indexFeedId: params.oracleFeed,
            maxStalenessSecs: "50",
            confFilterBps: 0,
            invert: params.invert ? 1 : 0,
            unitScale: 0,
            initialMarkPriceE6: params.initialPriceE6.toString(),
            warmupPeriodSlots: "0",
            maintenanceMarginBps: (initialMarginBps / 2n).toString(),
            initialMarginBps: initialMarginBps.toString(),
            tradingFeeBps: BigInt(params.tradingFeeBps).toString(),
            maxAccounts: "4096",
            newAccountFee: "1000000",
            riskReductionThreshold: "0",
            maintenanceFeePerSlot: "0",
            maxCrankStalenessSlots: "100",
            liquidationFeeBps: "100",
            liquidationFeeCap: "0",
            liquidationBufferBps: "50",
            minLiquidationAbs: "0",
          });

          const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
            wallet.publicKey,
            slabPk,
            params.mint,
            vaultAta,
            WELL_KNOWN.tokenProgram,
            WELL_KNOWN.clock,
            WELL_KNOWN.rent,
            vaultAta,
            WELL_KNOWN.systemProgram,
          ]);

          const ix = buildIx({ programId, keys: initMarketKeys, data: initMarketData });
          const sig = await sendTx({
            connection,
            wallet,
            instructions: [ix],
          });

          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        }

        // Step 3: InitLP (passive, matcher=SystemProgram)
        if (startStep <= 3) {
          setState((s) => ({ ...s, step: 3, stepLabel: STEP_LABELS[3] }));

          const userAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);

          const initLpData = encodeInitLP({
            matcherProgram: SystemProgram.programId,
            matcherContext: SystemProgram.programId,
            feePayment: "0",
          });

          const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
            wallet.publicKey,
            slabPk,
            userAta,
            vaultAta,
            WELL_KNOWN.tokenProgram,
          ]);

          const ix = buildIx({ programId, keys: initLpKeys, data: initLpData });
          const sig = await sendTx({
            connection,
            wallet,
            instructions: [ix],
            computeUnits: 100_000,
          });

          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        }

        // Step 4: DepositCollateral + TopUpInsurance (combined tx)
        if (startStep <= 4) {
          setState((s) => ({ ...s, step: 4, stepLabel: STEP_LABELS[4] }));

          const userAta = await getAssociatedTokenAddress(params.mint, wallet.publicKey);

          const depositData = encodeDepositCollateral({
            userIdx: 0,
            amount: params.lpCollateral.toString(),
          });
          const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
            wallet.publicKey,
            slabPk,
            userAta,
            vaultAta,
            WELL_KNOWN.tokenProgram,
            WELL_KNOWN.clock,
          ]);
          const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });

          const topupData = encodeTopUpInsurance({ amount: params.insuranceAmount.toString() });
          const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
            wallet.publicKey,
            slabPk,
            userAta,
            vaultAta,
            WELL_KNOWN.tokenProgram,
          ]);
          const topupIx = buildIx({ programId, keys: topupKeys, data: topupData });

          const sig = await sendTx({
            connection,
            wallet,
            instructions: [depositIx, topupIx],
            computeUnits: 200_000,
          });

          setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
        }

        // Step 5: Oracle setup + crank
        if (startStep <= 5) {
          setState((s) => ({ ...s, step: 5, stepLabel: STEP_LABELS[5] }));

          if (isAdminOracle) {
            const setAuthData = encodeSetOracleAuthority({ newAuthority: wallet.publicKey });
            const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
              wallet.publicKey,
              slabPk,
            ]);
            const setAuthIx = buildIx({ programId, keys: setAuthKeys, data: setAuthData });

            const now = Math.floor(Date.now() / 1000);
            const pushData = encodePushOraclePrice({
              priceE6: params.initialPriceE6.toString(),
              timestamp: now.toString(),
            });
            const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
              wallet.publicKey,
              slabPk,
            ]);
            const pushIx = buildIx({ programId, keys: pushKeys, data: pushData });

            const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
            const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
              wallet.publicKey,
              slabPk,
              WELL_KNOWN.clock,
              slabPk, // admin oracle: oracle = slab
            ]);
            const crankIx = buildIx({ programId, keys: crankKeys, data: crankData });

            const sig = await sendTx({
              connection,
              wallet,
              instructions: [setAuthIx, pushIx, crankIx],
              computeUnits: 500_000,
            });

            setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
          } else {
            const [pythPDA] = derivePythPushOraclePDA(params.oracleFeed);

            const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
            const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
              wallet.publicKey,
              slabPk,
              WELL_KNOWN.clock,
              pythPDA,
            ]);
            const crankIx = buildIx({ programId, keys: crankKeys, data: crankData });

            const sig = await sendTx({
              connection,
              wallet,
              instructions: [crankIx],
              computeUnits: 500_000,
            });

            setState((s) => ({ ...s, txSigs: [...s.txSigs, sig] }));
          }
        }

        // Done!
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
