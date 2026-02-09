"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import {
  encodeInitLP,
  encodeInitVamm,
  encodeTradeCpi,
  encodeKeeperCrank,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas,
  buildIx,
  deriveLpPda,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  WELL_KNOWN,
  AccountKind,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";

const MATCHER_CTX_SIZE = 320;

export interface VammConfig {
  mode?: number;
  tradingFeeBps?: number;
  baseSpreadBps?: number;
  maxTotalBps?: number;
  impactKBps?: number;
  liquidityNotionalE6?: bigint | string;
  maxFillAbs?: bigint | string;
  maxInventoryAbs?: bigint | string;
}

const DEFAULT_VAMM: Required<VammConfig> = {
  mode: 0,
  tradingFeeBps: 50,
  baseSpreadBps: 50,
  maxTotalBps: 200,
  impactKBps: 0,
  liquidityNotionalE6: "10000000000000",
  maxFillAbs: "0",
  maxInventoryAbs: "0",
};

/**
 * Hook for vAMM LP operations: initialize LP, trade via CPI, and detect existing LPs.
 */
export function useVAMM(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig, accounts, programId: slabProgramId } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Detect if market has an active LP with a matcher program (vAMM) */
  const activeLp = useMemo(() => {
    if (!accounts) return null;
    const lp = accounts.find(
      (a) =>
        a.account.kind === AccountKind.LP &&
        !a.account.matcherProgram.equals(PublicKey.default),
    );
    return lp ?? null;
  }, [accounts]);

  const hasVamm = activeLp !== null;

  /**
   * Initialize a new LP position with a vAMM matcher.
   * Creates matcher context account, initializes vAMM, then calls InitLP on percolator.
   */
  const initializeLP = useCallback(
    async (
      matcherProgramId: PublicKey,
      feePayment: bigint,
      vammConfig?: VammConfig,
    ) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId)
          throw new Error("Wallet not connected or market not loaded");

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const [vaultPda] = deriveVaultAuthority(programId, slabPk);
        const vaultAta = await getAssociatedTokenAddress(
          mktConfig.collateralMint,
          vaultPda,
          true,
        );
        const userAta = await getAssociatedTokenAddress(
          mktConfig.collateralMint,
          wallet.publicKey,
        );

        const matcherCtxKp = Keypair.generate();
        const matcherCtxRent =
          await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

        // Find next LP index (count existing LPs)
        const lpCount = accounts.filter((a) => a.account.kind === AccountKind.LP).length;
        const lpIdx = lpCount;
        const [lpPda] = deriveLpPda(programId, slabPk, lpIdx);

        const cfg = { ...DEFAULT_VAMM, ...vammConfig };

        // 1. Create matcher context account (owned by matcher program)
        const createCtxIx = SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: matcherCtxKp.publicKey,
          lamports: matcherCtxRent,
          space: MATCHER_CTX_SIZE,
          programId: matcherProgramId,
        });

        // 2. Initialize vAMM matcher
        const initVammData = encodeInitVamm({
          mode: cfg.mode,
          tradingFeeBps: cfg.tradingFeeBps,
          baseSpreadBps: cfg.baseSpreadBps,
          maxTotalBps: cfg.maxTotalBps,
          impactKBps: cfg.impactKBps,
          liquidityNotionalE6: cfg.liquidityNotionalE6,
          maxFillAbs: cfg.maxFillAbs,
          maxInventoryAbs: cfg.maxInventoryAbs,
        });

        const initMatcherIx = new TransactionInstruction({
          programId: matcherProgramId,
          keys: [
            { pubkey: lpPda, isSigner: false, isWritable: false },
            { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(initVammData),
        });

        // 3. InitLP on percolator
        const initLpData = encodeInitLP({
          matcherProgram: matcherProgramId,
          matcherContext: matcherCtxKp.publicKey,
          feePayment: feePayment.toString(),
        });
        const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
          wallet.publicKey,
          slabPk,
          userAta,
          vaultAta,
          WELL_KNOWN.tokenProgram,
        ]);
        const initLpIx = buildIx({
          programId,
          keys: initLpKeys,
          data: initLpData,
        });

        const sig = await sendTx({
          connection,
          wallet,
          instructions: [createCtxIx, initMatcherIx, initLpIx],
          computeUnits: 300_000,
          signers: [matcherCtxKp],
        });

        return sig;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, accounts, slabAddress, slabProgramId],
  );

  /**
   * Execute a trade via CPI through the vAMM matcher.
   * Automatically prepends a permissionless crank.
   */
  const tradeCpi = useCallback(
    async (params: { lpIdx: number; userIdx: number; size: bigint }) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId)
          throw new Error("Wallet not connected or market not loaded");

        const lpAccount = accounts.find((a) => a.idx === params.lpIdx);
        if (!lpAccount) throw new Error(`LP at index ${params.lpIdx} not found`);

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const [lpPda] = deriveLpPda(programId, slabPk, params.lpIdx);

        // Determine oracle account
        const hasAdminOracle = !mktConfig.oracleAuthority.equals(PublicKey.default);
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes())
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join("");
        const isZeroFeed = feedHex === "0".repeat(64);
        const useAdminOracle = hasAdminOracle || isZeroFeed;
        const oracleAccount = useAdminOracle
          ? slabPk
          : derivePythPushOraclePDA(feedHex)[0];

        const instructions: TransactionInstruction[] = [];

        // Prepend permissionless crank
        const crankIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
            wallet.publicKey,
            slabPk,
            WELL_KNOWN.clock,
            oracleAccount,
          ]),
          data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
        });
        instructions.push(crankIx);

        // TradeCpi instruction
        const tradeIx = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
            wallet.publicKey,
            lpAccount.account.owner,
            slabPk,
            WELL_KNOWN.clock,
            oracleAccount,
            lpAccount.account.matcherProgram,
            lpAccount.account.matcherContext,
            lpPda,
          ]),
          data: encodeTradeCpi({
            lpIdx: params.lpIdx,
            userIdx: params.userIdx,
            size: params.size.toString(),
          }),
        });
        instructions.push(tradeIx);

        return await sendTx({
          connection,
          wallet,
          instructions,
          computeUnits: 600_000,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, accounts, slabAddress, slabProgramId],
  );

  return {
    /** Whether this market has an active vAMM LP */
    hasVamm,
    /** The active LP account (if any) */
    activeLp,
    /** Initialize a new LP with vAMM matcher */
    initializeLP,
    /** Trade via CPI through the vAMM */
    tradeCpi,
    loading,
    error,
  };
}
