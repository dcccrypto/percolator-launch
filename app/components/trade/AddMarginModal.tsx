"use client";

import { FC, useState } from "react";
import { explorerTxUrl } from "@/lib/config";
import { recordCloseTx } from "@/lib/last-close-tx";
import type { PublicKey } from "@solana/web3.js";
import { useDeposit } from "@/hooks/useDeposit";
import { useWalletAtaBalance } from "@/hooks/useWalletAtaBalance";
import { useSlabState } from "@/components/providers/SlabProvider";
import { Modal } from "@/components/ui/Modal";
import { checkDepositAmount, depositAmountMessage } from "@/lib/deposit-guard";
import { formatTokenAmount } from "@/lib/format";
import { parseHumanAmount } from "@/lib/parseAmount";
import { useDecimalInput } from "@/hooks/useDecimalInput";

// ─── 5.9: Add Margin modal ────────────────────────────────────────────────────

interface AddMarginModalProps {
  slabAddress: string;
  userIdx: number;
  symbol: string;
  decimals: number;
  /** The account to deposit into: the one the row shows. Without it the hook resolves the wallet's default account. */
  portfolioPk?: PublicKey;
  onClose: () => void;
  onSuccess?: () => void;
}

export const AddMarginModal: FC<AddMarginModalProps> = ({ slabAddress, userIdx, symbol, decimals, portfolioPk, onClose, onSuccess}) => {
  const [amount, setAmount] = useState("");
  const amountField = useDecimalInput(amount, setAmount);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const { deposit, loading, error } = useDeposit(slabAddress);
  const { config: marginMktConfig } = useSlabState();
  const { balance: walletBalance } = useWalletAtaBalance(marginMktConfig?.collateralMint, lastSig);

  let parsedAmount: bigint = 0n;
  let parseError: string | null = null;
  if (amount) {
    try {
      parsedAmount = parseHumanAmount(amount, decimals);
    } catch {
      parseError = `Too many decimal places (max ${decimals})`;
    }
  }

  // An amount above the wallet's collateral balance is rejected inline (same
  // treatment as Withdraw) instead of being left for the chain to revert.
  const amountStatus = parseError ? "empty" : checkDepositAmount(parsedAmount, walletBalance);
  const amountError = depositAmountMessage(amountStatus, walletBalance, decimals, symbol);
  const canSubmit = !loading && amount.length > 0 && !parseError && parsedAmount > 0n && amountStatus === "ok";

  async function handleDeposit() {
    if (!canSubmit) return;
    try {
      const sig = await deposit({ userIdx, amount: parsedAmount, accountExists: true, portfolioPk });
      setLastSig(sig ?? null);
      recordCloseTx(slabAddress, sig, Date.now(), false, "Margin added.");
      setAmount("");

    // Add margin mutates the slab account. Refresh immediately so capital,
    // liquidation risk, and position health do not stay stale until polling.
    onSuccess?.();
    } catch {
      // error shown via hook
    }
  }

  return (
    // The shared Modal (GH#2286): focus trap + restore, Escape, portal above the header and tab bar.
    // Not dismissible while the deposit is in flight, or its result line went with the dialog.
    <Modal
      onClose={onClose}
      dismissible={!loading}
      labelledBy="add-margin-title"
      scrimClassName="backdrop-blur-sm"
      panelClassName="w-full max-w-sm rounded-none border border-[var(--border)]/60 bg-[var(--bg)] p-4 shadow-2xl"
    >
        <div className="mb-3 flex items-center justify-between">
          <span id="add-margin-title" className="text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--text)]">Add Margin</span>
          <button
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
            className="text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
          >
            ×
          </button>
        </div>

        <p className="mb-3 text-[10px] text-[var(--text-secondary)] leading-relaxed">
          Deposit additional collateral to increase your margin and reduce liquidation risk.
        </p>

        <div className="mb-2 flex flex-col gap-1">
          <label htmlFor="add-margin-amount" className="text-[9px] uppercase tracking-[0.12em] text-[var(--text)]">
            Amount ({symbol})
          </label>
          <input
            id="add-margin-amount"
            type="text"
            {...amountField}
            placeholder={`0.00 ${symbol}`}
            style={{ fontFamily: "var(--font-mono)" }}
            className="w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
          />
          {parseError && (
            <p className="text-[10px] text-[var(--short)]">{parseError}</p>
          )}
          {!parseError && amountError && (
            <p role="alert" data-testid="add-margin-amount-error" className={`text-[10px] ${amountStatus === "exceeds" ? "text-[var(--short)]" : "text-[var(--text-secondary)]"}`}>
              {amountError}
            </p>
          )}
          {walletBalance !== null && walletBalance > 0n && (
            <button
              type="button"
              onClick={() => setAmount(formatTokenAmount(walletBalance, decimals))}
              className="self-start text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] hover:underline"
            >
              Max: {formatTokenAmount(walletBalance, decimals, 3)} {symbol}
            </button>
          )}
        </div>

        <button
          onClick={handleDeposit}
          disabled={!canSubmit}
          className="w-full rounded-none bg-[var(--accent)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-white transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Depositing…" : "Deposit Margin"}
        </button>

        {error && (
          <p className="mt-2 text-[10px] text-[var(--short)]">{error}</p>
        )}
        {lastSig && (
          <p className="mt-2 text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
            Margin added.{" "}
            <a href={explorerTxUrl(lastSig)} target="_blank" rel="noopener noreferrer" title={lastSig} className="underline">
              View transaction {lastSig.slice(0, 4)}…{lastSig.slice(-4)} <span aria-hidden="true">↗</span>
            </a>
          </p>
        )}
    </Modal>
  );
};
