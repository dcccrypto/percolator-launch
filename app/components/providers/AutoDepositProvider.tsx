/**
 * PERC-372: Auto-deposit provider
 *
 * Wraps market/trade pages. After auto-fund completes (wallet gets SOL + USDC),
 * automatically triggers initUser + deposit so the user can start trading
 * immediately. Shows a small toast notification on success.
 *
 * Only active on devnet. On mainnet, renders children without any side effects.
 */

"use client";

import { FC, ReactNode, useEffect, useState } from "react";
import { useAutoDeposit, type AutoDepositState } from "@/hooks/useAutoDeposit";

interface AutoDepositProviderProps {
  slabAddress: string;
  children: ReactNode;
}

/** Toast notification for auto-deposit events */
const AutoDepositToast: FC<{ state: AutoDepositState }> = ({ state }) => {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (state.depositing) {
      setVisible(true);
      setDismissed(false);
    }
  }, [state.depositing]);

  useEffect(() => {
    if (state.deposited && !dismissed) {
      setVisible(true);
      // Auto-dismiss after 6 seconds
      const timer = setTimeout(() => {
        setVisible(false);
        setDismissed(true);
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [state.deposited, dismissed]);

  useEffect(() => {
    if (state.error && !dismissed) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setDismissed(true);
      }, 8000);
      return () => clearTimeout(timer);
    }
  }, [state.error, dismissed]);

  if (!visible) return null;

  // Depositing in progress
  if (state.depositing) {
    return (
      <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-slide-up">
        <div className="rounded border border-[var(--accent)]/30 bg-[var(--panel-bg)] px-4 py-3 shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="animate-spin text-[var(--accent)]">⟳</span>
            <div>
              <p className="text-[12px] font-medium text-[var(--text)]">
                Setting up your account…
              </p>
              <p className="text-[10px] text-[var(--text-secondary)]">
                Approve the transaction in your wallet
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Success
  if (state.deposited && state.amountUsdc) {
    return (
      <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-slide-up">
        <div className="rounded border border-[var(--long)]/30 bg-[var(--panel-bg)] px-4 py-3 shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="text-[var(--long)]">✓</span>
            <div>
              <p className="text-[12px] font-medium text-[var(--text)]">
                Account created — ${state.amountUsdc.toLocaleString()} USDC deposited
              </p>
              <p className="text-[10px] text-[var(--text-secondary)]">
                You&apos;re ready to trade!
              </p>
            </div>
            <button
              type="button"
              aria-label="Dismiss deposit notification"
              onClick={() => { setVisible(false); setDismissed(true); }}
              className="ml-auto text-[var(--text-dim)] hover:text-[var(--text)] text-[12px]"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Error (non-rejection)
  if (state.error) {
    return (
      <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-slide-up">
        <div className="rounded border border-[var(--short)]/30 bg-[var(--panel-bg)] px-4 py-3 shadow-lg backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="text-[var(--short)]">!</span>
            <div>
              <p className="text-[12px] font-medium text-[var(--text)]">
                Auto-deposit failed
              </p>
              <p className="text-[10px] text-[var(--text-secondary)]">
                {state.error}. You can deposit manually below.
              </p>
            </div>
            <button
              type="button"
              aria-label="Dismiss error notification"
              onClick={() => { setVisible(false); setDismissed(true); }}
              className="ml-auto text-[var(--text-dim)] hover:text-[var(--text)] text-[12px]"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export const AutoDepositProvider: FC<AutoDepositProviderProps> = ({
  slabAddress,
  children,
}) => {
  const isDevnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet";
  const state = useAutoDeposit(slabAddress);

  if (!isDevnet) {
    return <>{children}</>;
  }

  return (
    <>
      {children}
      <AutoDepositToast state={state} />
    </>
  );
};
