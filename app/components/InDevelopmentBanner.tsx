import type { ReactNode } from "react";

/**
 * Honest "In Development" banner for features whose plumbing works but whose yield
 * isn't live on the deployed program (Earn LP vault + Stake — verified on-chain to
 * pay no yield as deployed; see VAULT-STAKE-FINDINGS.md).
 */
export function InDevelopmentBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-sm border border-amber-500/30 bg-amber-500/[0.06] p-4">
      <span
        className="shrink-0 rounded-sm bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-400"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        In Development
      </span>
      <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{children}</p>
    </div>
  );
}
