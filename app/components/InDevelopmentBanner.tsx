import type { ReactNode } from "react";

/**
 * Honest "In Development" note for features whose plumbing works but whose yield
 * isn't live on the deployed program (Earn LP vault + Stake — verified on-chain to
 * pay no yield as deployed; see VAULT-STAKE-FINDINGS.md).
 *
 * `variant="inline"` is the compact, terminal-style caveat (a hairline left
 * accent + a mono "Note" tag) used inside the Earn/Stake surfaces so the honesty
 * note reads as part of the trade app rather than a loud marketing banner. The
 * default `"banner"` variant is the original boxed callout.
 */
export function InDevelopmentBanner({
  children,
  variant = "banner",
}: {
  children: ReactNode;
  variant?: "banner" | "inline";
}) {
  if (variant === "inline") {
    return (
      <div className="flex items-start gap-2.5 border-l-2 border-[var(--warning)]/50 bg-[var(--warning)]/[0.035] py-2 pl-3 pr-3">
        <span
          className="mt-[1px] shrink-0 text-[9px] font-medium uppercase tracking-[0.18em] text-[var(--warning)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Note
        </span>
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{children}</p>
      </div>
    );
  }

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
