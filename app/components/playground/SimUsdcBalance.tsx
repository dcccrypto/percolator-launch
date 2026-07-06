"use client";

/**
 * SimUsdcBalance
 *
 * Fetches and displays the user's Sim-USDC balance from chain.
 * Used in the playground faucet page and trade flows as the primary
 * collateral balance indicator.
 *
 * Sim-USDC mint: DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC (6 decimals)
 * Falls back to NEXT_PUBLIC_TEST_USDC_MINT env var.
 */

import { FC, useEffect, useState, useCallback } from "react";
import { PublicKey, Connection } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConfig } from "@/lib/config";

const SIM_USDC_MINT =
  process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim() ||
  "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

const USDC_DECIMALS = 6;

function formatUsdc(raw: bigint): string {
  const whole = raw / BigInt(10 ** USDC_DECIMALS);
  const frac = raw % BigInt(10 ** USDC_DECIMALS);
  // Show up to 2 decimal places
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${fracStr}`;
}

interface SimUsdcBalanceProps {
  /** Wallet public key — pass null when not connected */
  publicKey: PublicKey | null;
  /** Optional: called with the raw (6dp) balance so the parent can react */
  onBalance?: (rawAmount: bigint) => void;
  /** Trigger a fresh fetch (increment to re-poll) */
  refreshTick?: number;
  className?: string;
}

export const SimUsdcBalance: FC<SimUsdcBalanceProps> = ({
  publicKey,
  onBalance,
  refreshTick = 0,
  className = "",
}) => {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const cfg = getConfig();
      const conn = new Connection(
        typeof window !== "undefined" ? `${window.location.origin}/api/rpc` : cfg.rpcUrl,
        "confirmed",
      );
      const mint = new PublicKey(SIM_USDC_MINT);
      const ata = await getAssociatedTokenAddress(mint, publicKey);
      try {
        const acct = await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID);
        const raw = BigInt(acct.amount.toString());
        setBalance(raw);
        onBalance?.(raw);
      } catch {
        // ATA doesn't exist yet — balance is 0
        setBalance(BigInt(0));
        onBalance?.(BigInt(0));
      }
    } catch (err) {
      setError("Could not fetch balance");
      console.warn("[SimUsdcBalance] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [publicKey, onBalance]);

  useEffect(() => {
    void fetchBalance();
  }, [fetchBalance, refreshTick]);

  if (!publicKey) return null;

  return (
    <div className={`flex items-baseline gap-1.5 ${className}`}>
      <span className="text-[13px] text-[var(--text-muted)]">Sim-USDC</span>
      {loading ? (
        <span className="h-4 w-16 animate-pulse rounded bg-[var(--border)]" />
      ) : error ? (
        <span className="text-[13px] text-[var(--error)]">{error}</span>
      ) : (
        <span className="font-mono text-[15px] font-semibold text-[var(--text)]">
          {balance !== null ? formatUsdc(balance) : "—"}
        </span>
      )}
    </div>
  );
};
