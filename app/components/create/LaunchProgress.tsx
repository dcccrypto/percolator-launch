"use client";

import { FC } from "react";
import { RecoveryExportButton } from "./RecoveryExportButton";
import { loadAllInFlightMarkets } from "@/lib/inFlightMarket";

interface LaunchProgressProps {
  state: {
    step: number;
    loading: boolean;
    error: string | null;
    slabAddress: string | null;
    txSigs: string[];
    stepLabel: string;
    /**
     * Batch-launch phase (2026-07-12) — set only by the fresh quick-launch
     * fast path (see useCreateMarket.ts's attemptFreshBatchedLaunch).
     * Resume/retry/demo flows never set this away from "idle"/undefined, so
     * this component falls back to the original per-step (0-5) view for
     * those — the phase view is purely additive.
     */
    phase?: "idle" | "preparing" | "awaiting-signature" | "landing" | "done";
    landingIndex?: number;
    /** Named market-creation steps, one per batched tx, in order. */
    landingLabels?: string[];
    landingTotal?: number;
  };
  onReset: () => void;
  onRetry?: () => void;
}

const STEP_LABELS = [
  "Create slab & initialize market",
  "Oracle setup & crank",
  "Initialize LP",
  "Deposit, insurance & finalize",
  "Create Earn vault",
  "Initialize stake pool",
] as const;

/**
 * Step-by-step signing progress overlay.
 * Replaces the review panel after submit.
 */
export const LaunchProgress: FC<LaunchProgressProps> = ({ state, onReset, onRetry }) => {
  // W10 fix (2026-07-08): the recovery panel used to gate on `state.step >= 1 &&
  // state.slabAddress` — component-local state that never advances past 0 (and never
  // gets slabAddress set) when Step 0's confirmation THROWS client-side (e.g. a
  // websocket/RPC timeout) even though the transaction actually landed on-chain.
  // saveInFlightMarket() (useCreateMarket.ts) persists the in-flight entry to
  // localStorage BEFORE Step 0 is even sent, independent of this component's state —
  // read that directly instead so the panel (and its "download recovery JSON" button)
  // is available for exactly that "timed out but landed" case, not just once `state`
  // catches up.
  const hasInFlightRecovery = loadAllInFlightMarkets().length > 0;
  // Batch-launch phase view: only rendered when the fresh quick-launch fast
  // path is active (phase set to something other than "idle"/undefined).
  // Resume/retry/demo flows fall straight through to the original per-step
  // list below, unchanged.
  const isBatchPhaseActive = !!state.phase && state.phase !== "idle";
  return (
    <div
      className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Market launch progress"
    >
      <h2 className="mb-5 text-[14px] font-bold uppercase tracking-[0.1em] text-[var(--text)]">
        Launching Market
      </h2>
      <div className="h-px bg-[var(--border)] mb-5" />

      {isBatchPhaseActive && !state.error && (
        <div className="space-y-4" aria-live="polite">
          {/* Preparing / awaiting-signature: single spinner + label */}
          {(state.phase === "preparing" || state.phase === "awaiting-signature") && (
            <div className="flex items-center gap-3">
              <span className="h-5 w-5 flex-shrink-0 animate-spin border-2 border-[var(--border)] border-t-[var(--accent)]" />
              <div>
                <p className="text-[12px] font-medium text-[var(--text)]">{state.stepLabel}</p>
                {state.phase === "awaiting-signature" && (
                  <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">
                    One approval signs the whole market launch.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Landing: named market-creation steps (NOT transaction indices —
              a launching user cares about what's being built, not our tx
              packing). Each step shows done / in-progress / pending, with the
              explorer link on the ones that have landed. */}
          {state.phase === "landing" && (
            <div>
              {(() => {
                const labels = state.landingLabels ?? [];
                const done = state.landingIndex ?? 0;
                const total = state.landingTotal ?? labels.length;
                return (
                  <>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-[var(--text)]">
                        {labels[Math.min(done, labels.length - 1)] ?? "Finishing up"}
                      </span>
                      <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--warning)] animate-pulse">
                        CONFIRMING...
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden bg-[var(--bg-surface)]">
                      <div
                        className="h-full bg-[var(--accent)] transition-all duration-300"
                        style={{ width: `${total ? Math.min(100, (done / total) * 100) : 0}%` }}
                      />
                    </div>
                    <ul className="mt-3 space-y-1">
                      {labels.map((label, i) => {
                        const isDone = i < done;
                        const isActive = i === done;
                        const sig = state.txSigs[i];
                        return (
                          <li key={label} className="flex items-center gap-2">
                            <span
                              className={[
                                "flex h-4 w-4 flex-shrink-0 items-center justify-center border text-[9px]",
                                isDone
                                  ? "border-[var(--long)]/30 bg-[var(--long)]/[0.08] text-[var(--long)]"
                                  : isActive
                                    ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.08] text-[var(--accent)]"
                                    : "border-[var(--border)] text-[var(--text-dim)]",
                              ].join(" ")}
                            >
                              {isDone ? "✓" : isActive ? "•" : ""}
                            </span>
                            <span
                              className={[
                                "text-[10px]",
                                isDone
                                  ? "text-[var(--text-secondary)]"
                                  : isActive
                                    ? "font-medium text-[var(--text)]"
                                    : "text-[var(--text-dim)]",
                              ].join(" ")}
                            >
                              {label}
                            </span>
                            {isDone && sig && (
                              <a
                                href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-auto font-mono text-[9px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
                              >
                                {sig.slice(0, 6)}…
                              </a>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {isBatchPhaseActive && (
        <div className="h-px bg-[var(--border)] my-5" />
      )}

      {/* Step list — original per-step (0-5) view, used by resume/retry/demo
          flows and hidden while the batch-launch phase view is active. */}
      {!isBatchPhaseActive && (
      <div className="space-y-3" aria-live="polite">
        {STEP_LABELS.map((label, i) => {
          let status: "pending" | "active" | "done" | "error" = "pending";
          if (state.step > i || state.step >= 6) status = "done";
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
                  <span className="flex h-6 w-6 items-center justify-center border border-[var(--border)] bg-[var(--bg-surface)] text-[10px] text-[var(--text-secondary)]">
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
                        ? "font-medium text-[var(--text)]"
                        : status === "error"
                          ? "text-[var(--short)]"
                          : "text-[var(--text-secondary)]"
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
                      className="font-mono text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
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
      )}

      {/* Progress text */}
      {!isBatchPhaseActive && state.loading && !state.error && (
        <p className="mt-5 text-[12px] text-[var(--text-secondary)]">
          Step {state.step + 1} of 6 — Sign the transaction in your wallet
        </p>
      )}

      {/* Error state */}
      {state.error && (
        <div className="mt-5 border border-[var(--short)]/20 bg-[var(--short)]/[0.04] p-4">
          <p className="text-[11px] text-[var(--short)]">{state.error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="border border-[var(--short)]/30 bg-[var(--short)]/[0.08] px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--short)] hover:bg-[var(--short)]/[0.15] transition-colors min-h-[44px]"
              >
                Retry Step {state.step + 1}
              </button>
            )}
            <button
              type="button"
              onClick={onReset}
              className="border border-[var(--border)] bg-transparent px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text)] min-h-[44px]"
            >
              Start Over
            </button>
          </div>
        </div>
      )}

      {/* Recovery export — shown whenever a persisted in-flight entry exists (W10 fix:
           was gated on component-local `state`, which could lag or never catch up to
           what's actually on-chain — see hasInFlightRecovery above), so the user can
           download a recovery JSON if anything goes wrong. Survives tab close. */}
      {hasInFlightRecovery && (
        <div className="mt-5 border border-[var(--border)] bg-[var(--bg-surface)] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-secondary)] mb-1">
            Recovery
          </p>
          <p className="text-[11px] text-[var(--text-secondary)] mb-3">
            The slab is on chain. If anything stalls, you can recover via the
            in-UI banner on the next /create visit, or download this JSON to
            run the close-market script offline.
          </p>
          <RecoveryExportButton />
        </div>
      )}
    </div>
  );
};
