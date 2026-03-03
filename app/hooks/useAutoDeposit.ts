/**
 * PERC-372: Auto-deposit hook
 *
 * After auto-fund mints USDC to the user's wallet, this hook detects that the
 * user has no on-chain Percolator account for the current market and
 * auto-triggers initUser + deposit in a single transaction.
 *
 * Flow:
 *   1. Watches for auto-fund completion (USDC balance > 0 in wallet)
 *   2. Checks if user has a Percolator account on the current market
 *   3. If not, prompts wallet for a single initUser + deposit transaction
 *   4. Deposits up to 500 USDC (or wallet balance, whichever is less)
 *
 * Only fires on devnet, once per market per session.
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useInitUser } from "@/hooks/useInitUser";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useAutoFund } from "@/hooks/useAutoFund";

const AUTO_DEPOSIT_AMOUNT = 500_000_000n; // 500 USDC (6 decimals) — reasonable starter
const MIN_WALLET_BALANCE = 10_000_000n; // 10 USDC minimum to bother depositing

export interface AutoDepositState {
  /** Whether an auto-deposit is in progress */
  depositing: boolean;
  /** Whether auto-deposit completed successfully */
  deposited: boolean;
  /** Error message if auto-deposit failed */
  error: string | null;
  /** Transaction signature if successful */
  signature: string | null;
  /** Amount deposited in USDC (human-readable) */
  amountUsdc: number | null;
}

export function useAutoDeposit(slabAddress: string): AutoDepositState {
  const { publicKey, connected } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const userAccount = useUserAccount();
  const { initUser } = useInitUser(slabAddress);
  const { config: mktConfig } = useSlabState();
  const { result: fundResult } = useAutoFund();

  const [depositing, setDepositing] = useState(false);
  const [deposited, setDeposited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [amountUsdc, setAmountUsdc] = useState<number | null>(null);

  // Track which markets we've already attempted for this session
  const attemptedRef = useRef<Set<string>>(new Set());
  // Prevent concurrent attempts
  const inflightRef = useRef(false);

  const isDevnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet";

  const attemptAutoDeposit = useCallback(async () => {
    if (!publicKey || !mktConfig?.collateralMint || !isDevnet) return;
    if (inflightRef.current) return;

    const key = `${publicKey.toBase58()}:${slabAddress}`;
    if (attemptedRef.current.has(key)) return;

    // Check wallet USDC balance before marking as attempted
    try {
      const ata = getAssociatedTokenAddressSync(mktConfig.collateralMint, publicKey);
      const tokenInfo = await connection.getTokenAccountBalance(ata);
      const walletBalance = BigInt(tokenInfo.value.amount);

      if (walletBalance < MIN_WALLET_BALANCE) return; // Not enough to deposit — don't mark attempted yet

      // Calculate deposit amount: min(AUTO_DEPOSIT_AMOUNT, walletBalance - small buffer for fees)
      const buffer = 1_000_000n; // Keep 1 USDC buffer
      const maxDeposit = walletBalance > buffer ? walletBalance - buffer : 0n;
      const depositAmount = maxDeposit < AUTO_DEPOSIT_AMOUNT ? maxDeposit : AUTO_DEPOSIT_AMOUNT;

      if (depositAmount < MIN_WALLET_BALANCE) return; // Don't mark attempted yet

      // Eligibility confirmed — mark as attempted to prevent reruns
      attemptedRef.current.add(key);

      inflightRef.current = true;
      setDepositing(true);
      setError(null);

      const sig = await initUser(depositAmount);
      setSignature(sig ?? null);
      setAmountUsdc(Number(depositAmount) / 1_000_000);
      setDeposited(true);
    } catch (e) {
      // User rejected or tx failed — not a critical error
      const msg = e instanceof Error ? e.message : String(e);
      // Don't show error for user rejections
      if (msg.includes("User rejected") || msg.includes("cancelled")) {
        // Silently ignore — user can manually deposit later
      } else {
        setError(msg);
      }
    } finally {
      inflightRef.current = false;
      setDepositing(false);
    }
  }, [publicKey, mktConfig, slabAddress, connection, initUser, isDevnet]);

  useEffect(() => {
    if (!isDevnet || !connected || !publicKey) return;

    // Don't auto-deposit if user already has an account
    if (userAccount) return;

    // Trigger conditions:
    // 1. Auto-fund just completed (freshly funded wallet)
    // 2. User connected with existing wallet balance but no Percolator account

    // Wait a short delay to let auto-fund complete and balances settle
    const timer = setTimeout(() => {
      attemptAutoDeposit();
    }, fundResult?.funded ? 2000 : 3000);

    return () => clearTimeout(timer);
  }, [connected, publicKey, userAccount, fundResult, isDevnet, attemptAutoDeposit]);

  return { depositing, deposited, error, signature, amountUsdc };
}
