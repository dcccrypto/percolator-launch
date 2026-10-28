"use client";

import { FC } from "react";
import { Modal } from "@/components/ui/Modal";

interface InsuranceExplainerModalProps {
  onClose: () => void;
}

/** On the shared Modal (role=dialog, focus trap and restore, Escape, scroll lock), like the Funding explainer. */
export const InsuranceExplainerModal: FC<InsuranceExplainerModalProps> = ({
  onClose,
}) => {
  return (
    <Modal
      onClose={onClose}
      labelledBy="insurance-explainer-title"
      scrimClassName="backdrop-blur-sm"
      panelClassName="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-none border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
    >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--border)]/50 bg-[var(--bg)] px-4 py-3">
          <h2
            id="insurance-explainer-title"
            className="text-2xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            What is the Insurance Fund?
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-none text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="space-y-6 p-6">
          {/* What it is */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              What is it?
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              The <strong>Insurance Fund</strong> is a safety net that protects
              the market&apos;s liquidity from bankruptcy during extreme market
              events.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              It's a pool of capital that absorbs losses when traders get
              liquidated but their positions can't be closed profitably.
            </p>
          </section>

          {/* How it works */}
          <section className="rounded-none border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/5 p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              How it works
            </h3>
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <div>
                  <div className="text-sm font-medium text-[var(--text)]">
                    Accumulates from trading fees
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    A share of every trade fee is set aside for the insurance side (paid into the stake pool where the market has one)
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <div>
                  <div className="text-sm font-medium text-[var(--text)]">
                    Covers losses a liquidation leaves behind
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    When a trader is liquidated, insurance covers any shortfall
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <div>
                  <div className="text-sm font-medium text-[var(--text)]">
                    Funded by trading fees and the market&apos;s insurance authority
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    Only that authority can add to it directly. On a staked
                    market the authority is the stake pool
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Why it matters */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Why it matters
            </h3>
            <div className="space-y-3">
              <div className="rounded-none border border-[var(--long)]/30 bg-[var(--long)]/5 p-3">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--long)]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--long)]">
                    Strong Insurance = Safer Markets
                  </span>
                </div>
                <p className="text-sm text-[var(--text-secondary)]">
                  High insurance coverage means the market&apos;s liquidity is protected even in
                  extreme volatility. Traders can trade with confidence knowing
                  the system won't collapse.
                </p>
              </div>
              <div className="rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 p-3">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--short)]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--short)]">
                    Low Insurance = Higher Risk
                  </span>
                </div>
                <p className="text-sm text-[var(--text-secondary)]">
                  Low insurance coverage means the system is vulnerable to
                  cascading liquidations. If multiple large positions get
                  liquidated, the market&apos;s liquidity could take losses.
                </p>
              </div>
            </div>
          </section>

          {/* Scenario */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Example Scenario
            </h3>
            <div className="space-y-2 text-sm text-[var(--text-secondary)]">
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">1.</span>
                <span>
                  Trader opens 10x leveraged LONG position: $10,000 notional
                  with $1,000 collateral
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">2.</span>
                <span>
                  Market crashes -15%. Trader's position is now worth $8,500
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">3.</span>
                <span>
                  Trader gets liquidated. Liquidation tries to close position
                  at $8,500
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">4.</span>
                <span>
                  The position has lost $1,500. The trader&apos;s $1,000 collateral
                  covers $1,000 of it, leaving a $500 shortfall
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">5.</span>
                <span className="text-[var(--long)]">
                  <strong>Insurance fund covers the $500 shortfall</strong> →
                  the market is made whole
                </span>
              </div>
            </div>
          </section>

          {/* Transparency */}
          <section className="rounded-none border-l-2 border-l-[var(--warning)] bg-[var(--warning)]/5 p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Transparency
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Most DEXs <strong>hide</strong> their insurance fund data. You
              have no idea if the platform is adequately capitalized.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              Percolator shows you the <strong>exact balance</strong>,{" "}
              <strong>accumulation rate</strong>, and{" "}
              <strong>coverage ratio</strong>. Full transparency.
            </p>
          </section>

          {/* Who funds it */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Who funds it
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              A share of every trading fee is set aside for the insurance
              side. On a market with a stake pool that share is paid into the
              pool, and the pool&apos;s admin can move staked funds into
              insurance, so staked funds can be used to cover losses. Apart
              from that, only the market&apos;s insurance authority can add
              collateral to the insurance balance.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              There is no public deposit into the insurance fund. Depositing
              into a market&apos;s <strong>Earn</strong> vault is a different
              thing: it provides counterparty backing, mints vault shares and
              is exposed to trader profit and loss. It does not add to the
              insurance balance.
            </p>
          </section>

          {/* Coverage Ratio */}
          <section className="rounded-none bg-[var(--bg-elevated)] p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Understanding Coverage Ratio
            </h3>
            <div className="space-y-2 text-xs text-[var(--text-secondary)]">
              <div className="flex items-start gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--long)] mt-0.5" />
                <span>
                  <strong>&gt;5x coverage:</strong> Healthy — insurance can
                  cover multiple large liquidations
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mt-0.5" />
                <span>
                  <strong>2-5x coverage:</strong> Moderate — acceptable but
                  should be monitored
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--short)] mt-0.5" />
                <span>
                  <strong>&lt;2x coverage:</strong> Low — a large liquidation
                  could exceed the insurance balance
                </span>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--border)]/50 bg-[var(--bg-elevated)] px-6 py-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-none border border-[var(--border)]/50 px-4 py-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg)]"
          >
            Close
          </button>
        </div>
    </Modal>
  );
};
