"use client";

import { FC } from "react";

/**
 * Why the chain-resume gate refused a launch or Retry. Rendered in BOTH wizard views (the form and the
 * launch-progress view that replaces it), so a refused Retry never looks dead.
 */
export const ChainResumeNotice: FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div data-testid="chain-resume-error" role="alert" className="mx-4 mt-4 border border-[var(--short)]/40 bg-[var(--short)]/[0.06] px-4 py-3 text-[11px] text-[var(--text)] sm:mx-6">
      {message}
    </div>
  ) : null;
