/**
 * PERC-372: Auto-deposit hook
 *
 * After auto-fund mints USDC to the user's wallet, this hook detects that the
 * user has no on-chain Percolator account for the current market and
 * auto-triggers account setup + deposit as ONE wallet approval.
 *
 * Flow:
 *   1. Watches for auto-fund completion (USDC balance > 0 in wallet)
 *   2. Checks if user has a Percolator account on the current market
 *   3. If not, prompts wallet for account creation — useInitUser folds
 *      Deposit into the SAME transaction when possible (falling back to a
 *      second, automatic transaction if the combined one doesn't land; see
 *      useInitUser.ts's v17 branch), so this is still a single logical setup
 *      step from the user's point of view, not "create, then go deposit
 *      separately."
 *   4. Deposits up to 500 USDC (or wallet balance, whichever is less)
 *
 * Only fires on devnet, once per market per session. Dedup uses sessionStorage
 * (not useRef) so it survives component unmount/remount on navigation — GH #1113.
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";

const SS_DEPOSIT_KEY = "auto-deposit-attempted";

function getAutoDepositAttempted(): Set<string> {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(SS_DEPOSIT_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function markAutoDepositAttempted(key: string): void {
  try {
    const s = getAutoDepositAttempted();
    s.add(key);
    sessionStorage.setItem(SS_DEPOSIT_KEY, JSON.stringify([...s]));
  } catch {
    // sessionStorage unavailable (SSR guard) — silently skip
  }
}
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useInitUser } from "@/hooks/useInitUser";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useAutoFundResult } from "@/components/providers/AutoFundProvider";
import { useFaucetComplete } from "@/hooks/useDevnetFaucet";
// PERC-808: useFaucetComplete returns true within 30s of faucet modal completion

// Exported: OrderTicket's one-click "Initialize Account" CTA and
// DepositWithdrawCard's "Create Trading Account" button reuse this same
// starter-deposit cap so every first-time-setup entry point converges on
// the same "reasonable starter" amount instead of each guessing its own.
export const AUTO_DEPOSIT_AMOUNT = 500_000_000n; // 500 USDC (6 decimals) — reasonable starter
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
  const { result: fundResult } = useAutoFundResult();
  const faucetComplete = useFaucetComplete();

  const [depositing, setDepositing] = useState(false);
  const [deposited, setDeposited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [amountUsdc, setAmountUsdc] = useState<number | null>(null);

  // Prevent concurrent attempts (in-memory ref is fine — concurrency is within one page load)
  const inflightRef = useRef(false);

  const isDevnet =
    (process.env.NEXT_PUBLIC_DEFAULT_NETWORK ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK) === "devnet";

  const attemptAutoDeposit = useCallback(async () => {
    if (!publicKey || !mktConfig?.collateralMint || !isDevnet) return;
    if (inflightRef.current) return;

    const key = `${publicKey.toBase58()}:${slabAddress}`;
    if (getAutoDepositAttempted().has(key)) return;

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

      // Eligibility confirmed — mark as attempted to prevent reruns (persists across navigation)
      markAutoDepositAttempted(key);

      inflightRef.current = true;
      setDepositing(true);
      setError(null);

      const result = await initUser(depositAmount);
      setSignature(result?.sig ?? null);
      // PERC-onboarding-1: on v17, useInitUser now folds Deposit into the same
      // (or a chained follow-up) transaction as InitPortfolio — see that
      // hook's v17 branch. Read `depositedAmount` off the RESOLVED result,
      // not hook state — a state read here would see a stale pre-call
      // snapshot (React state updates from inside initUser aren't visible
      // synchronously in this closure). `depositedAmount` reports what
      // actually landed on-chain (0n if the deposit leg didn't happen for
      // any reason), so don't just assume the requested `depositAmount`
      // landed. On v12 the value is already accurate (InitUser folds
      // `feePayment` in as the deposit unconditionally).
      const actualDeposited = result?.depositedAmount ?? 0n;
      setAmountUsdc(actualDeposited > 0n ? Number(actualDeposited) / 1_000_000 : null);
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

    // GH#1107: only auto-deposit when auto-fund JUST completed or faucet modal
    // was completed and dismissed (PERC-808).
    // Without this guard any wallet navigation to a trade page with no Percolator
    // account would immediately pop the Privy "Confirm transaction" modal.
    if (!fundResult?.funded && !faucetComplete) return;

    // Wait a short delay to let auto-fund balances settle on-chain
    const timer = setTimeout(() => {
      attemptAutoDeposit();
    }, 2000);

    return () => clearTimeout(timer);
  }, [connected, publicKey, userAccount, fundResult, faucetComplete, isDevnet, attemptAutoDeposit]);

  return { depositing, deposited, error, signature, amountUsdc };
}
