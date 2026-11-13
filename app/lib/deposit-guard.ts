/**
 * Deposit-amount guard: an amount above the wallet's collateral balance must
 * be caught in the UI (inline error + disabled submit) AND in the hook (a
 * programmatic call must not build a tx above the balance).
 *
 * Why this exists. The wrapper's Deposit ix rejects `amount > source token
 * balance` on-chain (`require_token_balance`, no clamp) and the stake / LP
 * vault transfers are plain SPL transfers, so an over-balance deposit can
 * never move MORE than the wallet holds. The reported "went through as if I
 * had that much" was a SILENT CLAMP in the order-ticket "Start Trading"
 * starter deposit (OrderTicket clamped to the balance, then `useInitUser`
 * clamped again) while the input kept showing the oversized number. Withdraw
 * already tells the user ("Withdrawal amount exceeds ..."); deposit now does
 * the same instead of quietly depositing less than what was typed.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { formatTokenAmount } from "@/lib/format";
import { readU64LE } from "@/lib/u64le";

export type DepositAmountStatus =
  /** amount <= 0 / unparsed: nothing to validate yet. */
  | "empty"
  /** Wallet balance not known yet (loading / read failed): do not allow submit. */
  | "balance-unknown"
  /** amount > wallet balance. */
  | "exceeds"
  | "ok";

export function checkDepositAmount(
  amount: bigint,
  walletBalance: bigint | null,
): DepositAmountStatus {
  if (amount <= 0n) return "empty";
  if (walletBalance === null) return "balance-unknown";
  return amount > walletBalance ? "exceeds" : "ok";
}

/** Inline message for a status (null when nothing to show). */
export function depositAmountMessage(
  status: DepositAmountStatus,
  walletBalance: bigint | null,
  decimals: number,
  symbol = "",
): string | null {
  if (status === "exceeds" && walletBalance !== null) {
    const have = formatTokenAmount(walletBalance, decimals, 3);
    return `Exceeds your wallet balance (${have}${symbol ? ` ${symbol}` : ""} available)`;
  }
  if (status === "balance-unknown") return "Checking wallet balance…";
  return null;
}

/**
 * Why a typed amount can't be used, in plain words (null = fine, or nothing typed). The number box lets "1e3", "1,5" or
 * "-2" through; those parse to zero, so the Deposit button stayed off without saying why.
 */
export function depositInputMessage(input: string, decimals: number): string | null {
  const t = input.trim();
  if (!t) return null;
  if (!/^\d*\.?\d*$/.test(t) || t === ".") {
    return "Enter a plain number, like 100 or 12.5. Letters, commas, minus signs and 1e3-style numbers don't work.";
  }
  const frac = t.split(".")[1] ?? "";
  if (frac.length > decimals) return `Use at most ${decimals} decimal places.`;
  if (!/[1-9]/.test(t)) return "Enter an amount above 0.";
  return null;
}

export class DepositExceedsBalanceError extends Error {
  constructor(
    readonly requested: bigint,
    readonly available: bigint,
  ) {
    super(
      `Deposit amount exceeds your wallet balance (requested ${requested.toString()}, available ${available.toString()} base units). Reduce the amount to what your wallet holds.`,
    );
    this.name = "DepositExceedsBalanceError";
  }
}

/**
 * Hook-level guard. Throws when the balance is KNOWN and smaller than the
 * amount. `balance === null` (the read itself failed) does not throw: the
 * chain validates the real balance and rejects — we never block a deposit on
 * an RPC hiccup.
 */
export function assertDepositWithinBalance(amount: bigint, balance: bigint | null): void {
  if (balance !== null && amount > balance) {
    throw new DepositExceedsBalanceError(amount, balance);
  }
}

/**
 * Read a token account's balance in base units. `0n` when the account does not
 * exist (the wallet genuinely holds none), `null` when the READ failed
 * (unknown, NOT zero). Works for SPL and Token-2022 (amount is u64 LE @ 64).
 */
export async function readTokenBalance(
  connection: Pick<Connection, "getAccountInfo">,
  ata: PublicKey,
): Promise<bigint | null> {
  try {
    const info = await connection.getAccountInfo(ata);
    if (info === null) return 0n;
    if (!info.data || info.data.length < 72) return null;
    return readU64LE(info.data, 64);
  } catch {
    return null;
  }
}
