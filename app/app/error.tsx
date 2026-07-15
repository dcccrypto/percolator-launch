"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
    Sentry.captureException(error, {
      tags: { errorBoundary: "app-error" },
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-none border border-[var(--short)]/30 bg-[var(--short)]/10">
            <svg className="h-8 w-8 text-[var(--short)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
        </div>
        <h2 className="mb-2 text-2xl font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
          something went wrong
        </h2>
        <p className="mb-1 text-sm text-[var(--text-secondary)]">
          {error.message || "An unexpected error occurred."}
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
            try again
          </button>
          <a
            href="/"
            className="rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-surface)]"
          >
            go home
          </a>
        </div>
      </div>
    </div>
  );
}
