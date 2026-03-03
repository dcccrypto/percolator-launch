/**
 * PERC-376: Drift-style in-UI devnet faucet modal
 *
 * Shows a stepped modal when a new devnet user connects:
 *   1. Airdrop SOL (2 SOL via Solana devnet faucet)
 *   2. Airdrop USDC (10,000 test USDC via /api/faucet)
 *   3. Auto-deposit (handled by AutoDepositProvider after dismiss)
 *
 * Target: wallet connect → trading in <60 seconds.
 * Modeled after Drift Protocol's devnet deposit modal UX.
 */

"use client";

import { FC, useCallback, useEffect, useRef } from "react";
import { useDevnetFaucet } from "@/hooks/useDevnetFaucet";

/* ── Step indicator ──────────────────────────────────── */
const StepBadge: FC<{
  number: number;
  label: string;
  status: "pending" | "active" | "done" | "error";
}> = ({ number, label, status }) => {
  const colors = {
    pending: "border-[var(--border)] text-[var(--text-dim)]",
    active: "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/[0.08]",
    done: "border-[var(--long)]/40 text-[var(--long)] bg-[var(--long)]/[0.06]",
    error: "border-[var(--short)]/40 text-[var(--short)] bg-[var(--short)]/[0.06]",
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-bold ${colors[status]}`}
      >
        {status === "done" ? "✓" : number}
      </div>
      <span
        className={`text-[11px] font-medium uppercase tracking-[0.1em] ${
          status === "active"
            ? "text-[var(--accent)]"
            : status === "done"
              ? "text-[var(--long)]"
              : status === "error"
                ? "text-[var(--short)]"
                : "text-[var(--text-dim)]"
        }`}
      >
        {label}
      </span>
    </div>
  );
};

/* ── Balance display ─────────────────────────────────── */
const BalanceRow: FC<{
  label: string;
  value: string;
  sufficient: boolean;
}> = ({ label, value, sufficient }) => (
  <div className="flex items-center justify-between">
    <span className="text-[10px] text-[var(--text-secondary)]">{label}</span>
    <span
      className={`text-[11px] font-mono ${sufficient ? "text-[var(--long)]" : "text-[var(--text)]"}`}
    >
      {value}
    </span>
  </div>
);

/* ── Spinner ─────────────────────────────────────────── */
const Spinner: FC = () => (
  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
);

/* ── Main Modal ──────────────────────────────────────── */
export const DevnetFaucetModal: FC = () => {
  const faucet = useDevnetFaucet();
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!faucet.shouldShow) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") faucet.dismiss();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [faucet.shouldShow, faucet.dismiss]);

  // Close on outside click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        faucet.dismiss();
      }
    },
    [faucet],
  );

  if (!faucet.shouldShow) return null;

  const solSufficient = faucet.solBalance !== null && faucet.solBalance >= 0.05;
  const usdcSufficient =
    faucet.usdcBalance !== null && faucet.usdcBalance >= 1;

  const solStepStatus = faucet.solDone || solSufficient
    ? "done"
    : faucet.step === "sol" && faucet.loading
      ? "active"
      : faucet.error && faucet.step === "sol"
        ? "error"
        : "pending";

  const usdcStepStatus = faucet.usdcDone || usdcSufficient
    ? "done"
    : faucet.step === "usdc" && faucet.loading
      ? "active"
      : faucet.error && faucet.step === "usdc"
        ? "error"
        : "pending";

  const allDone =
    (faucet.solDone || solSufficient) && (faucet.usdcDone || usdcSufficient);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className="mx-4 w-full max-w-md rounded-none border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Fund your devnet account"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)]/50 px-5 py-3">
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // devnet
            </div>
            <h2
              className="text-[15px] font-medium text-[var(--text)]"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              Fund Your Account
            </h2>
          </div>
          <button
            onClick={faucet.dismiss}
            className="text-[var(--text-dim)] transition-colors hover:text-[var(--text)] text-lg leading-none"
            aria-label="Close faucet modal"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-4">
          {/* Description */}
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            Get free devnet tokens to start trading. This takes about 15
            seconds.
          </p>

          {/* Balances */}
          <div className="space-y-1.5 rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated,var(--bg))]/50 p-3">
            <BalanceRow
              label="SOL"
              value={
                faucet.solBalance !== null
                  ? `${faucet.solBalance.toFixed(4)} SOL`
                  : "—"
              }
              sufficient={solSufficient}
            />
            <BalanceRow
              label="USDC"
              value={
                faucet.usdcBalance !== null
                  ? `${faucet.usdcBalance.toLocaleString()} USDC`
                  : "—"
              }
              sufficient={usdcSufficient}
            />
          </div>

          {/* Steps */}
          <div className="space-y-3">
            {/* Step 1: SOL */}
            <div className="flex items-center justify-between">
              <StepBadge number={1} label="Get SOL" status={solStepStatus} />
              {!faucet.solDone && !solSufficient && (
                <button
                  onClick={faucet.airdropSol}
                  disabled={faucet.loading}
                  className="rounded-none border border-[var(--accent)]/40 px-3 py-1 text-[10px] font-medium text-[var(--accent)] transition-all hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.08] disabled:opacity-40"
                >
                  {faucet.step === "sol" && faucet.loading ? (
                    <span className="flex items-center gap-1.5">
                      <Spinner /> Airdropping…
                    </span>
                  ) : (
                    "Airdrop 2 SOL"
                  )}
                </button>
              )}
              {(faucet.solDone || solSufficient) && (
                <span className="text-[10px] text-[var(--long)]">✓ Ready</span>
              )}
            </div>

            {/* Connector line */}
            <div className="ml-3 h-3 w-px bg-[var(--border)]/30" />

            {/* Step 2: USDC */}
            <div className="flex items-center justify-between">
              <StepBadge
                number={2}
                label="Get USDC"
                status={usdcStepStatus}
              />
              {!faucet.usdcDone && !usdcSufficient && (
                <button
                  onClick={faucet.airdropUsdc}
                  disabled={faucet.loading || faucet.rateLimited}
                  className="rounded-none border border-[var(--accent)]/40 px-3 py-1 text-[10px] font-medium text-[var(--accent)] transition-all hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.08] disabled:opacity-40"
                >
                  {faucet.step === "usdc" && faucet.loading ? (
                    <span className="flex items-center gap-1.5">
                      <Spinner /> Minting…
                    </span>
                  ) : faucet.rateLimited ? (
                    "Rate limited"
                  ) : (
                    "Airdrop 10,000 USDC"
                  )}
                </button>
              )}
              {(faucet.usdcDone || usdcSufficient) && (
                <span className="text-[10px] text-[var(--long)]">✓ Ready</span>
              )}
            </div>

            {/* Connector line */}
            <div className="ml-3 h-3 w-px bg-[var(--border)]/30" />

            {/* Step 3: Deposit (info only — AutoDepositProvider handles this) */}
            <div className="flex items-center justify-between">
              <StepBadge
                number={3}
                label="Deposit & Trade"
                status={allDone ? "active" : "pending"}
              />
              {allDone && (
                <span className="text-[10px] text-[var(--text-secondary)]">
                  Auto after dismiss
                </span>
              )}
            </div>
          </div>

          {/* Error */}
          {faucet.error && (
            <div className="rounded-none border border-[var(--short)]/20 bg-[var(--short)]/[0.04] px-3 py-2">
              <p className="text-[10px] text-[var(--short)]">{faucet.error}</p>
              {faucet.step === "sol" && (
                <a
                  href="https://faucet.solana.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-[10px] text-[var(--accent)] underline hover:text-white"
                >
                  Try Solana Web Faucet →
                </a>
              )}
            </div>
          )}

          {/* Rate limit info */}
          {faucet.rateLimited && faucet.nextClaimAt && (
            <div className="rounded-none border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] px-3 py-2">
              <p className="text-[10px] text-[var(--warning)]">
                Next claim available:{" "}
                {new Date(faucet.nextClaimAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--border)]/50 px-5 py-3">
          <div className="flex gap-2">
            {/* One-click fund all */}
            {!allDone && (
              <button
                onClick={faucet.fundAll}
                disabled={faucet.loading}
                className="flex-1 rounded-none bg-[var(--accent)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
              >
                {faucet.loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner />
                    {faucet.step === "sol"
                      ? "Airdropping SOL…"
                      : faucet.step === "usdc"
                        ? "Minting USDC…"
                        : "Processing…"}
                  </span>
                ) : (
                  "Fund My Account"
                )}
              </button>
            )}

            {/* Done / Dismiss */}
            {allDone ? (
              <button
                onClick={faucet.dismiss}
                className="flex-1 rounded-none bg-[var(--long)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all hover:brightness-110 active:scale-[0.99]"
              >
                Start Trading →
              </button>
            ) : (
              <button
                onClick={faucet.dismiss}
                className="rounded-none border border-[var(--border)] px-4 py-2.5 text-[10px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
              >
                Skip
              </button>
            )}
          </div>

          <p className="mt-2 text-center text-[9px] text-[var(--text-dim)]">
            Devnet tokens have no real value · 1 claim per wallet per 24h
          </p>
        </div>
      </div>
    </div>
  );
};
