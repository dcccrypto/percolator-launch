"use client";

import { FC } from "react";

interface WizardProgressProps {
  currentStep: 1 | 2 | 3 | 4;
  completedSteps: Set<number>;
  onStepClick?: (step: 1 | 2 | 3 | 4) => void;
}

const STEP_LABELS = ["Token", "Oracle", "Parameters", "Review"] as const;

/**
 * Horizontal step progress indicator with connectors.
 * Desktop: full horizontal strip with labels.
 * Mobile: compact "Step N of 4" counter.
 */
export const WizardProgress: FC<WizardProgressProps> = ({
  currentStep,
  completedSteps,
  onStepClick,
}) => {
  return (
    <>
      {/* Desktop progress */}
      <div className="hidden sm:flex items-center justify-between">
        {STEP_LABELS.map((label, idx) => {
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
                        : "border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-dim)]"
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
                        ? "text-white"
                        : "text-[var(--text-dim)]"
                  }`}
                >
                  {label}
                </span>
              </button>

              {/* Connector line (not after last step) */}
              {idx < STEP_LABELS.length - 1 && (
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
      <div className="flex sm:hidden items-center justify-between">
        <span className="text-[12px] font-medium text-white">
          Step {currentStep} of 4 — {STEP_LABELS[currentStep - 1]}
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
