"use client";

import { useEffect } from "react";

export default function TradeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[TradeError]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-12">
      <div className="mx-auto max-w-md text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-none border border-[var(--short)]/30 bg-[var(--short)]/10">
            <svg className="h-7 w-7 text-[var(--short)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
        </div>
        <h2 className="mb-2 text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
          trade page crashed
        </h2>
        <p className="mb-1 text-sm text-[var(--text-secondary)]">
          {error.message || "Something went wrong loading the trade view."}
        </p>
        {error.digest && (
          <p className="mb-4 font-mono text-xs text-[var(--text-dim)]">
            digest: {error.digest}
          </p>
        )}
        <div className="flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-none border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15]"
          >
            retry
          </button>
          <a
            href="/markets"
            className="rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-surface)]"
          >
            back to markets
          </a>
        </div>
      </div>
    </div>
  );
}
