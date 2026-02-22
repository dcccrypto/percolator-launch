"use client";

import { FC, useState, useEffect, useRef } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatTokenAmount } from "@/lib/format";
import { DepositWithdrawCard } from "./DepositWithdrawCard";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";

function lsKey(slabAddress: string) {
  return `percolator:deposited:${slabAddress}`;
}

export const DepositTrigger: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected, publicKey } = useWalletCompat();
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const isConnected = connected || mockMode;
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  const [expanded, setExpanded] = useState(false);
  const [hasDeposited, setHasDeposited] = useState(true); // default true to avoid flash

  const capital = userAccount?.account.capital ?? 0n;
  const prevCapitalRef = useRef(capital);

  // Read localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(lsKey(slabAddress));
    setHasDeposited(stored === "1" || (capital > 0n));
  }, [slabAddress, capital]);

  // Detect first deposit: capital goes from 0n to >0n
  useEffect(() => {
    if (prevCapitalRef.current === 0n && capital > 0n) {
      localStorage.setItem(lsKey(slabAddress), "1");
      setHasDeposited(true);
      setExpanded(false);
    }
    prevCapitalRef.current = capital;
  }, [capital, slabAddress]);

  // No wallet connected
  if (!isConnected) {
    return (
      <div data-deposit-trigger className="border border-[var(--border)]/50 bg-[var(--bg)]/80 px-3 py-1.5">
        <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-[0.1em]">
          Connect wallet to deposit
        </p>
      </div>
    );
  }

  // First-time state: shimmer button
  if (!hasDeposited && capital === 0n) {
    return (
      <div data-deposit-trigger>
        <button
          onClick={() => setExpanded(!expanded)}
          className="deposit-shimmer w-full border border-[var(--accent)]/60 bg-[var(--accent)]/[0.06] px-3 py-2.5 text-left transition-colors hover:bg-[var(--accent)]/[0.10]"
        >
          <span className="relative z-10 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--accent)]">
            Deposit Collateral to Trade
          </span>
        </button>
        {expanded && (
          <div className="mt-1">
            <DepositWithdrawCard slabAddress={slabAddress} />
          </div>
        )}
      </div>
    );
  }

  // Returning state: balance bar
  return (
    <div data-deposit-trigger>
      <div
        className="flex items-center justify-between border border-[var(--border)]/50 bg-[var(--bg)]/80 px-3 py-1.5 cursor-pointer transition-colors hover:border-[var(--border)]"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Account</span>
          <span className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatTokenAmount(capital)} {symbol}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--accent)] hover:text-[var(--accent)]">
            {expanded ? "Close" : "Deposit / Withdraw"}
          </span>
          <span className={`text-[9px] text-[var(--text-dim)] transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>
            ▾
          </span>
        </div>
      </div>
      {expanded && (
        <div className="mt-1">
          <DepositWithdrawCard slabAddress={slabAddress} />
        </div>
      )}
    </div>
  );
};
