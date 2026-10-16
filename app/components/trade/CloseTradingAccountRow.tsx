"use client";

import { FC, useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useCloseTradingAccount } from "@/hooks/useCloseTradingAccount";
import {
  CLOSE_ACCOUNT_COPY,
  isPortfolioClosable,
  lamportsToSolText,
  reopenRentSolText,
  type ParsedPortfolio,
} from "@/lib/close-trading-account";

interface Props {
  slabAddress: string;
  /** The exact trading account the card is showing (its own pubkey, never a rediscovered one). */
  portfolioPk: PublicKey;
  /** That account as last scanned; the hook re-reads and re-checks it before anything is signed. */
  portfolio: ParsedPortfolio;
  /** Called after the account is closed, with the lamports that came back. */
  onClosed?: (lamports: number) => void;
}

/**
 * #3426: offered only for the connected wallet's own EMPTY, non-LP, non-wrapped trading account.
 * One calm line + "Close account"; a confirm step says what happens. The SOL figure is the account's
 * own lamports (read once), never a constant, so the line stays hidden until it is known.
 */
export const CloseTradingAccountRow: FC<Props> = ({ slabAddress, portfolioPk, portfolio, onClosed }) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { closeAccount, loading, error } = useCloseTradingAccount(slabAddress);
  const [lamports, setLamports] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);

  const verdict = publicKey ? isPortfolioClosable(portfolio, publicKey) : null;
  const closable = verdict?.closable === true;
  const pkStr = portfolioPk.toBase58();

  useEffect(() => {
    if (!closable) return;
    let cancelled = false;
    connection
      .getAccountInfo(portfolioPk, "confirmed")
      .then((info) => {
        if (!cancelled && info) setLamports(info.lamports);
      })
      .catch(() => {
        /* no figure, no line: the action stays hidden rather than showing a guess */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closable, pkStr, connection]);

  if (!closable || lamports === null) return null;
  const sol = lamportsToSolText(lamports);

  async function confirm() {
    try {
      const r = await closeAccount(portfolioPk);
      setConfirming(false);
      onClosed?.(r.lamports);
    } catch {
      // the hook holds the calm error line
    }
  }

  return (
    <div data-testid="close-account" className="mt-3 border-t border-[var(--border)]/30 pt-3">
      {!confirming ? (
        <>
          <p data-testid="close-account-line" className="text-[10px] text-[var(--text-secondary)]">
            {CLOSE_ACCOUNT_COPY.line(sol)}
          </p>
          <button
            type="button"
            data-testid="close-account-open"
            onClick={() => setConfirming(true)}
            className="mt-2 w-full rounded-none border border-[var(--border)]/50 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text)] hover:bg-[var(--bg-surface)]"
          >
            {CLOSE_ACCOUNT_COPY.button}
          </button>
        </>
      ) : (
        <>
          <p data-testid="close-account-confirm-text" className="text-[10px] text-[var(--text-secondary)]">
            {CLOSE_ACCOUNT_COPY.confirm(sol, reopenRentSolText())}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="close-account-confirm"
              disabled={loading}
              onClick={confirm}
              className="flex-1 rounded-none bg-[var(--warning)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--bg)] disabled:opacity-50"
            >
              {loading ? CLOSE_ACCOUNT_COPY.working : CLOSE_ACCOUNT_COPY.confirmButton}
            </button>
            <button
              type="button"
              data-testid="close-account-cancel"
              disabled={loading}
              onClick={() => setConfirming(false)}
              className="rounded-none border border-[var(--border)]/50 px-3 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--text-secondary)] disabled:opacity-50"
            >
              {CLOSE_ACCOUNT_COPY.cancel}
            </button>
          </div>
        </>
      )}
      {error && (
        <p data-testid="close-account-error" role="alert" className="mt-2 text-[10px] text-[var(--short)]">
          {error}
        </p>
      )}
    </div>
  );
};
