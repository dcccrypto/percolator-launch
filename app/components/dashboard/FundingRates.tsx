"use client";

/**
 * Funding Rates — placeholder until funding mechanism is implemented.
 * Previously showed hardcoded mock data. Now shows empty state.
 */
export function FundingRates() {
  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center gap-2">
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            Funding Rates
          </p>
          <span
            className="cursor-help text-[10px] text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
            title="Funding rates will be displayed here once the funding mechanism is live."
          >
            ⓘ
          </span>
        </div>
      </div>
      <div className="px-5 py-8 text-center">
        <p className="text-[11px] text-[var(--text-muted)]">Funding rates coming soon</p>
        <p className="mt-1 text-[9px] text-[var(--text-dim)]">No funding mechanism active yet</p>
      </div>
    </div>
  );
}
