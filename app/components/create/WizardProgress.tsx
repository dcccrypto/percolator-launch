"use client";

import { FC } from "react";

const DEFAULT_LABELS = ["Token", "Oracle", "Parameters", "Review"] as const;

interface WizardProgressProps {
  currentStep: 1 | 2 | 3 | 4;
  completedSteps: Set<number>;
  onStepClick?: (step: 1 | 2 | 3 | 4) => void;
  /** Override step labels (e.g. Quick Launch swaps "Oracle" → "Slab Tier") */
  stepLabels?: readonly [string, string, string, string];
  /**
   * GH#1615: Display step number override for the mobile "Step N of M" counter.
   * In Quick Launch, physical step 2 should display as "2", step 4 as "3".
   */
  displayStep?: number;
  /** Display total override for mobile counter (e.g. 3 in Quick Launch mode). */
  displayTotal?: number;
  /** Display label for the current step (used in mobile counter). */
  displayStepLabel?: string;
}

/**
 * Horizontal step progress indicator with connectors.
 * Desktop: full horizontal strip with labels.
 * Mobile: compact "Step N of 4" counter.
 */
export const WizardProgress: FC<WizardProgressProps> = ({
  currentStep,
  completedSteps,
  onStepClick,
  stepLabels = DEFAULT_LABELS,
  displayStep,
  displayTotal,
  displayStepLabel,
}) => {
  const mobileStepNum = displayStep ?? currentStep;
  const mobileStepTotal = displayTotal ?? stepLabels.length;
  const mobileStepLabel = displayStepLabel ?? stepLabels[currentStep - 1];
  return (
    <>
      {/* Desktop progress */}
      <div className="hidden sm:flex items-center justify-between">
        {stepLabels.map((label, idx) => {
          const stepNum = (idx + 1) as 1 | 2 | 3 | 4;
          const isCompleted = completedSteps.has(stepNum);
          const isActive = currentStep === stepNum;
          const isUpcoming = !isCompleted && !isActive;

          return (
            <div key={stepNum} className="flex items-center flex-1 last:flex-none">
              {/* Step indicator */}
              <button
                type="button"
                onClick={() => {
                  // Only allow clicking completed steps (go back)
                  if (isCompleted && onStepClick) onStepClick(stepNum);
                }}
                disabled={!isCompleted}
                className={`flex items-center gap-2 group ${
                  isCompleted ? "cursor-pointer" : "cursor-default"
                }`}
                aria-label={`Step ${stepNum} of 4: ${label}. ${
                  isCompleted ? "Completed" : isActive ? "Current" : "Upcoming"
                }`}
              >
                {/* Circle */}
                <div
                  className={`flex h-7 w-7 items-center justify-center text-[10px] font-bold transition-all ${
                    isCompleted
                      ? "border border-[var(--accent)]/50 bg-[var(--accent)]/[0.15] text-[var(--accent)]"
                      : isActive
                        ? "border-2 border-[var(--accent)] bg-[var(--accent)]/[0.1] text-[var(--accent)] ring-2 ring-[var(--accent)]/20"
                        : "border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  }`}
                >
                  {isCompleted ? "✓" : stepNum}
                </div>
                {/* Label */}
                <span
                  className={`text-[11px] font-medium ${
                    isCompleted
                      ? "text-[var(--accent)] group-hover:text-[var(--accent)]"
                      : isActive
                        ? "text-[var(--text)]"
                        : "text-[var(--text-secondary)]"
                  }`}
                >
                  {label}
                </span>
              </button>

              {/* Connector line (not after last step) */}
              {idx < stepLabels.length - 1 && (
                <div className="flex-1 mx-3 h-px">
                  <div
                    className={`h-full transition-colors ${
                      completedSteps.has(stepNum)
                        ? "bg-[var(--accent)]/40"
                        : "bg-[var(--border)]"
                    }`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Mobile progress */}
      {/* GH#1615: use display overrides so Quick Launch shows "Step 2 of 3 — Slab Tier" not "Step 2 of 4 — Oracle ✓" */}
      <div className="flex sm:hidden items-center justify-between">
        <span className="text-[12px] font-medium text-[var(--text)]">
          Step {mobileStepNum} of {mobileStepTotal} — {mobileStepLabel}
        </span>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`h-2 w-2 rounded-full transition-colors ${
                completedSteps.has(s)
                  ? "bg-[var(--accent)]"
                  : s === currentStep
                    ? "bg-[var(--accent)]/60"
                    : "bg-[var(--border)]"
              }`}
            />
          ))}
        </div>
      </div>
    </>
  );
};
