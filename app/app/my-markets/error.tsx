"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function MyMarketsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[MyMarketsError]", error);
  }, [error]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-24 text-center">
      <div className="mx-auto max-w-md rounded-none border border-[var(--border)] bg-[var(--panel-bg)] p-8">
        <h2 className="text-lg font-bold text-[var(--text)]">failed to load markets</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{error.message || "Something went wrong."}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-none border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15]"
          >
            retry
          </button>
          <Link
            href="/markets"
            className="rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-surface)]"
          >
            browse all markets
          </Link>
        </div>
      </div>
    </main>
  );
}
