"use client";

import { useEffect, useState, useCallback } from "react";
import { PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/hooks/useSlab";
import {
  deriveKeeperFund,
  encodeTopUpKeeperFund,
  buildIx,
  buildAccountMetas,
  ACCOUNTS_TOPUP_KEEPER_FUND,
} from "@percolator/sdk";

const KEEPER_FUND_MAGIC = 0x4B454550_46554E44n;

export interface KeeperFundState {
  /** PDA address */
  address: PublicKey;
  /** Current balance in lamports */
  balance: bigint;
  /** Reward per crank in lamports */
  rewardPerCrank: bigint;
  /** Lifetime rewards paid */
  totalRewarded: bigint;
  /** Lifetime topped up */
  totalToppedUp: bigint;
  /** Whether market was auto-paused due to depletion */
  depletedPause: boolean;
  /** Estimated cranks remaining before fund depletes */
  estimatedCranksRemaining: number;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getBigUint64(offset, true);
}

function parseKeeperFundState(data: Uint8Array, address: PublicKey): KeeperFundState | null {
  if (data.length < 48) return null;
  const magic = readU64LE(data, 0);
  if (magic !== KEEPER_FUND_MAGIC) return null;

  const depletedPause = data[9] !== 0;
  const balance = readU64LE(data, 16);
  const rewardPerCrank = readU64LE(data, 24);
  const totalRewarded = readU64LE(data, 32);
  const totalToppedUp = readU64LE(data, 40);

  const estimatedCranksRemaining = rewardPerCrank > 0n
    ? Number(balance / rewardPerCrank)
    : balance > 0n ? Infinity : 0;

  return {
    address,
    balance,
    rewardPerCrank,
    totalRewarded,
    totalToppedUp,
    depletedPause,
    estimatedCranksRemaining,
  };
}

export function useKeeperFund(slabAddress?: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { programId, header } = useSlabState();

  const [fund, setFund] = useState<KeeperFundState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topUpPending, setTopUpPending] = useState(false);

  // Derive PDA address
  const pdaInfo = slabAddress && programId
    ? deriveKeeperFund(new PublicKey(programId), new PublicKey(slabAddress))
    : null;
  const fundAddress = pdaInfo?.[0] ?? null;

  // Check if connected wallet is the market admin (creator)
  const isAdmin = !!(
    wallet.publicKey &&
    header &&
    header.admin.equals(wallet.publicKey)
  );

  // Fetch keeper fund state
  const refresh = useCallback(async () => {
    if (!fundAddress) return;
    setLoading(true);
    try {
      const info = await connection.getAccountInfo(fundAddress);
      if (!info) {
        setFund(null);
        setError(null);
      } else {
        const state = parseKeeperFundState(new Uint8Array(info.data), fundAddress);
        setFund(state);
        setError(state ? null : "Invalid keeper fund data");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fundAddress, connection]);

  useEffect(() => { refresh(); }, [refresh]);

  // Top up keeper fund
  const topUp = useCallback(async (amountLamports: bigint) => {
    if (!wallet.publicKey || !wallet.signTransaction || !slabAddress || !programId || !fundAddress) {
      throw new Error("Wallet not connected or slab not loaded");
    }
    setTopUpPending(true);
    try {
      const progPubkey = new PublicKey(programId);
      const slab = new PublicKey(slabAddress);

      const data = encodeTopUpKeeperFund({ amount: amountLamports.toString() });
      const keys = buildAccountMetas(ACCOUNTS_TOPUP_KEEPER_FUND, [
        wallet.publicKey,
        slab,
        fundAddress,
      ]);
      const ix = buildIx({ programId: progPubkey, keys, data });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        ix,
      );
      tx.feePayer = wallet.publicKey;
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;

      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");

      // Refresh state after top-up
      await refresh();
      return sig;
    } finally {
      setTopUpPending(false);
    }
  }, [wallet, slabAddress, programId, fundAddress, connection, refresh]);

  return {
    fund,
    loading,
    error,
    isAdmin,
    topUp,
    topUpPending,
    refresh,
    fundAddress,
  };
}
