"use client";

/**
 * useBatchTrade — v17 atomic multi-leg batch trade via matcher CPI.
 *
 * Encodes BatchTradeCpi (tag 67) which executes multiple legs atomically through
 * an external matcher. All legs settle in a single transaction; any per-leg
 * slippage guard can abort the whole batch.
 *
 * Account layout (7 accounts):
 *   [0] taker    — signer, writable (taker user portfolio owner)
 *   [1] slab     — writable (market group account)
 *   [2] takerPortfolio — writable (taker's portfolio account, must be owned by slab program)
 *   [3] makerPortfolio — writable (maker/LP portfolio account)
 *   [4] matcherProg    — (matcher program)
 *   [5] matcherCtx     — writable (matcher context account)
 *   [6] matcherDelegate — (derived PDA: derive_matcher_delegate)
 *
 * Wire format: tag(1) + legCount(u8) + per-leg: assetIndex(u16)+sizeQ(i128)+feeBps(u64)+limitPrice(u64)
 *
 * v17-specific: feeBps=0n applies the market's configured tradingFeeBps.
 * limitPrice=0n disables per-leg slippage checking for that leg.
 */

import { useCallback, useState } from "react";
import { PublicKey, AccountMeta } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeBatchTradeCpi,
  type BatchTradeCpiLeg,
  buildIx,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { assertKnownProgram } from "@/lib/programAllowlist";

export type { BatchTradeCpiLeg };

export interface BatchTradeParams {
  /** Slab (market group) address */
  slabAddress: string;
  /** Program ID that owns the slab */
  programId: PublicKey;
  /** Taker portfolio account address */
  takerPortfolio: string;
  /** Maker/LP portfolio account address */
  makerPortfolio: string;
  /** Matcher program ID */
  matcherProg: PublicKey;
  /** Matcher context account address */
  matcherCtx: string;
  /** Matcher delegate PDA address (derive_matcher_delegate) */
  matcherDelegate: string;
  /** Trade legs — assetIndex, sizeQ (signed), feeBps (0=use market fee), limitPrice (0=no limit) */
  legs: BatchTradeCpiLeg[];
}

export function useBatchTrade() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const batchTrade = useCallback(
    async (params: BatchTradeParams): Promise<string> => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !wallet.signTransaction) {
          throw new Error("Wallet not connected");
        }
        assertKnownProgram(params.programId);

        // v17: MATCHER_BATCH_MAX_LEGS = 16 (on-chain constant in v16_program.rs).
        // Previous guard used 14 which incorrectly rejected valid 15- and 16-leg batches.
        if (params.legs.length === 0 || params.legs.length > 16) {
          throw new Error(`Batch trade legs must be 1-16, got ${params.legs.length}`);
        }

        const slabPk = new PublicKey(params.slabAddress);
        const takerPortfolioPk = new PublicKey(params.takerPortfolio);
        const makerPortfolioPk = new PublicKey(params.makerPortfolio);
        const matcherCtxPk = new PublicKey(params.matcherCtx);
        const matcherDelegatePk = new PublicKey(params.matcherDelegate);

        // 7-account layout per v16_program.rs handle_batch_trade_cpi:
        // [0] taker (signer, writable)
        // [1] slab (writable)
        // [2] takerPortfolio (writable)
        // [3] makerPortfolio (writable)
        // [4] matcherProg
        // [5] matcherCtx (writable)
        // [6] matcherDelegate
        const keys: AccountMeta[] = [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: slabPk, isSigner: false, isWritable: true },
          { pubkey: takerPortfolioPk, isSigner: false, isWritable: true },
          { pubkey: makerPortfolioPk, isSigner: false, isWritable: true },
          { pubkey: params.matcherProg, isSigner: false, isWritable: false },
          { pubkey: matcherCtxPk, isSigner: false, isWritable: true },
          { pubkey: matcherDelegatePk, isSigner: false, isWritable: false },
        ];

        const data = encodeBatchTradeCpi({ legs: params.legs });
        const ix = buildIx({ programId: params.programId, keys, data });
        return await sendTx({ connection, wallet, instructions: [ix], computeUnits: 800_000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet],
  );

  return { batchTrade, loading, error };
}
