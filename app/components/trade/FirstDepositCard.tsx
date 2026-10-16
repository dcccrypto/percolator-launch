"use client";
/**
 * SOL-2 (v2.2 QA 2026-10-11): a new user deposits WITHOUT trading. The order ticket's "+ Deposit" for a
 * wallet with no account on this market opens this card: ONE approval creates the trading account and
 * deposits (hooks/useFirstTrade.ts `createAndDeposit`: [CreateAccount, InitPortfolio, Deposit] at the
 * predicted id, the first trade's legs minus the trade). After it lands the ticket's normal Deposit /
 * Withdraw toggles take over. Flag-gated by the caller (v2.2 only).
 */
import { errorText } from "@/lib/error-text";
import { FC, useState } from "react";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { parseHumanAmount } from "@/lib/parseAmount";
import { formatTokenAmount } from "@/lib/format";
import { humanizeError } from "@/lib/errorMessages";
import { explorerTxUrl } from "@/lib/config";

export const FIRST_DEPOSIT_COPY = {
  line: "Deposit to set up your trading account on this market (one approval). You can trade, add margin or withdraw afterwards.",
  empty: "Enter an amount to deposit.",
  over: (bal: string, sym: string) => `That's more than your wallet holds (${bal} ${sym}).`,
  done: "Deposited. Your trading account on this market is ready.",
} as const;

interface Props {
  slabAddress: string;
  walletBalance: bigint;
  decimals: number;
  symbol: string;
}

function sanitize(v: string): string {
  const c = v.replace(/[^0-9.]/g, "");
  const i = c.indexOf(".");
  return i === -1 ? c : c.slice(0, i + 1) + c.slice(i + 1).replace(/\./g, "");
}

export const FirstDepositCard: FC<Props> = ({ slabAddress, walletBalance, decimals, symbol }) => {
  const { createAndDeposit, loading } = useFirstTrade(slabAddress);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    let atoms = 0n;
    try {
      atoms = parseHumanAmount(amount, decimals);
    } catch {
      atoms = 0n;
    }
    if (atoms <= 0n) return setError(FIRST_DEPOSIT_COPY.empty);
    if (atoms > walletBalance) return setError(FIRST_DEPOSIT_COPY.over(formatTokenAmount(walletBalance, decimals, 2), symbol));
    try {
      const r = await createAndDeposit(atoms);
      setSig(r.signature);
      setAmount("");
    } catch (e) {
      const msg = errorText(e);
      if (!/user rejected|cancelled|denied/i.test(msg)) setError(humanizeError(msg));
      return;
    }
  };

  return (
    <div data-testid="first-deposit-card" className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <p className="mb-2 text-[10px] text-[var(--text-secondary)]">{FIRST_DEPOSIT_COPY.line}</p>
      <div className="mb-2 flex items-center gap-1.5 border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5">
        <input
          data-testid="first-deposit-amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setError(null);
            setAmount(sanitize(e.target.value));
          }}
          disabled={loading}
          placeholder="0.00"
          aria-label={`Deposit amount in ${symbol}`}
          className="w-full bg-transparent text-right text-[12px] text-[var(--text)] outline-none"
          style={{ fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          onClick={() => setAmount(formatTokenAmount(walletBalance, decimals).replace(/,/g, ""))}
          disabled={loading}
          className="min-h-[32px] text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] hover:underline disabled:opacity-50"
        >
          Max
        </button>
        <span className="text-[10px] text-[var(--text-secondary)]">{symbol}</span>
      </div>
      <button
        data-testid="first-deposit-submit"
        onClick={() => void submit()}
        disabled={loading}
        className="min-h-[32px] w-full rounded-none bg-[var(--accent)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-white hover:bg-[var(--accent-muted)] disabled:opacity-50"
      >
        {loading ? "Depositing…" : "Deposit"}
      </button>
      {error && <p role="alert" data-testid="first-deposit-error" className="mt-2 text-[10px] text-[var(--short)]">{error}</p>}
      {sig && (
        <p data-testid="first-deposit-done" className="mt-2 text-[10px] text-[var(--text-secondary)]">
          {FIRST_DEPOSIT_COPY.done}{" "}
          <a href={explorerTxUrl(sig)} target="_blank" rel="noreferrer" className="underline">Tx: {sig.slice(0, 12)}…</a>
        </p>
      )}
    </div>
  );
};
