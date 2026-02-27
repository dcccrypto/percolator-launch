"use client";

import { FC } from "react";

interface LaunchProgressProps {
  state: {
    step: number;
    loading: boolean;
    error: string | null;
    slabAddress: string | null;
    txSigs: string[];
    stepLabel: string;
  };
  onReset: () => void;
  onRetry?: () => void;
}

const STEP_LABELS = [
  "Create slab & initialize market",
  "Oracle setup & crank",
  "Initialize LP",
  "Deposit, insurance & finalize",
  "Insurance LP mint",
] as const;

/**
 * Step-by-step signing progress overlay.
 * Replaces the review panel after submit.
 */
export const LaunchProgress: FC<LaunchProgressProps> = ({ state, onReset, onRetry }) => {
  return (
    <div
      className="border border-[var(--border)] bg-[var(--panel-bg)] p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Market launch progress"
    >
      <h2 className="mb-5 text-[14px] font-bold uppercase tracking-[0.1em] text-white">
        Launching Market
      </h2>
      <div className="h-px bg-[var(--border)] mb-5" />

      {/* Step list */}
      <div className="space-y-3" aria-live="polite">
        {STEP_LABELS.map((label, i) => {
          let status: "pending" | "active" | "done" | "error" = "pending";
          if (state.step > i || state.step >= 5) status = "done";
          else if (state.step === i && state.loading) status = "active";
          else if (state.step === i && state.error) status = "error";

          return (
            <div key={i} className="flex items-start gap-3">
              {/* Status icon */}
              <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center mt-0.5">
                {status === "done" && (
                  <span className="flex h-6 w-6 items-center justify-center border border-[var(--long)]/30 bg-[var(--long)]/[0.08] text-[10px] text-[var(--long)]">
                    ✓
                  </span>
                )}
                {status === "active" && (
                  <span className="flex h-6 w-6 items-center justify-center">
                    <span className="h-4 w-4 animate-spin border-2 border-[var(--border)] border-t-[var(--accent)]" />
                  </span>
                )}
                {status === "error" && (
                  <span className="flex h-6 w-6 items-center justify-center border border-[var(--short)]/30 bg-[var(--short)]/[0.08] text-[10px] text-[var(--short)]">
                    ✗
                  </span>
                )}
                {status === "pending" && (
                  <span className="flex h-6 w-6 items-center justify-center border border-[var(--border)] bg-[var(--bg-surface)] text-[10px] text-[var(--text-dim)]">
                    {i + 1}
                  </span>
                )}
              </div>

              {/* Label + tx sig */}
              <div className="flex-1 min-w-0">
                <span
                  className={`text-[12px] ${
                    status === "done"
                      ? "text-[var(--long)]"
                      : status === "active"
                        ? "font-medium text-white"
                        : status === "error"
                          ? "text-[var(--short)]"
                          : "text-[var(--text-dim)]"
                  }`}
                >
                  {label}
                </span>

                {/* Status badge */}
                {status === "active" && (
                  <span className="ml-2 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--warning)] animate-pulse">
                    SIGNING...
                  </span>
                )}
                {status === "done" && (
                  <span className="ml-2 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--long)]">
                    DONE
                  </span>
                )}
                {status === "error" && (
                  <span className="ml-2 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--short)]">
                    FAILED
                  </span>
                )}

                {/* Tx sig (done) */}
                {status === "done" && state.txSigs[i] && (
                  <p className="mt-0.5">
                    <a
                      href={`https://explorer.solana.com/tx/${state.txSigs[i]}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] transition-colors"
                    >
                      tx: {state.txSigs[i].slice(0, 8)}...
                    </a>
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Progress text */}
      {state.loading && !state.error && (
        <p className="mt-5 text-[12px] text-[var(--text-secondary)]">
          Step {state.step + 1} of 5 — Sign the transaction in your wallet
        </p>
      )}

      {/* Error state */}
      {state.error && (
        <div className="mt-5 border border-[var(--short)]/20 bg-[var(--short)]/[0.04] p-4">
          <p className="text-[11px] text-[var(--short)]">{state.error}</p>
          <div className="mt-3 flex gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="border border-[var(--short)]/30 bg-[var(--short)]/[0.08] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--short)] hover:bg-[var(--short)]/[0.15] transition-colors"
              >
                Retry Step {state.step + 1}
              </button>
            )}
            <button
              type="button"
              onClick={onReset}
              className="border border-[var(--border)] bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
            >
              Start Over
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
