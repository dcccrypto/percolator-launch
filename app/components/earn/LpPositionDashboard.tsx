'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { bigintRatio } from "@/lib/formatters";
import { V21_COPY } from "@/lib/v21/copy";
import type { EntryVsExit } from "@/lib/v21/entry-exit";
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import type { LpEarned } from '@/lib/lp-earned';


interface LpPositionDashboardProps {
  /** User's LP token balance (raw) */
  userLpBalance: bigint;
  /** Total LP supply */
  lpSupply: bigint;
  /** Total vault balance (raw) */
  vaultBalance: bigint;
  /** Decimals for collateral */
  decimals: number;
  /** Decimals for the LP token mint — NOT necessarily the same as collateral decimals */
  lpDecimals: number;
  /** Collateral symbol */
  collateralSymbol: string;
  /** Redemption rate (e6) */
  redemptionRateE6: bigint;
  /** Loading */
  loading: boolean;
  /**
   * UX WP-4 (§3.6 item 4): a pending withdrawal counts as an active position — never "No active
   * LP position" while shares sit in the redemption ticket. The label is "12.50 USDC".
   */
  pendingWithdrawalLabel?: string | null;
  /**
   * Devnet v2.1 (security review R3-L1): the position's entry price vs what withdrawing pays now
   * (lib/v21/entry-exit.ts). Undefined on today's programs: nothing is rendered.
   */
  entryVsExit?: EntryVsExit | null;
  /**
   * Exact earnings from the indexer's cost basis (percolator-indexer#207), or
   * why they are unavailable. Omitted -> the row is not rendered.
   */
  earned?: LpEarned;
}

/**
 * Earned is decoration: with no indexed basis (or an empty vault) the row is simply not shown.
 * While the basis catches up, or for shares that arrived by transfer, it reads a calm "—"
 * with the reason on hover only.
 */
const EARNED_UNAVAILABLE_HINT: Partial<Record<Extract<LpEarned, { kind: 'unavailable' }>['reason'], string>> = {
  'out-of-sync': 'Updating',
  'basis-unknown': 'Not available for shares received by transfer',
};

export function LpPositionDashboard({
  userLpBalance,
  lpSupply,
  vaultBalance,
  decimals,
  lpDecimals,
  collateralSymbol,
  redemptionRateE6,
  loading,
  pendingWithdrawalLabel = null,
  earned,
  entryVsExit = null,
}: LpPositionDashboardProps) {
  const divisor = 10n ** BigInt(decimals);
  const hasPosition = userLpBalance > 0n;
  const pending = !!pendingWithdrawalLabel;

  // Calculate user's share
  const userSharePct =
    lpSupply > 0n
      ? Number((userLpBalance * 10000n) / lpSupply) / 100
      : 0;

  const userRedeemableValue =
    lpSupply > 0n ? (userLpBalance * vaultBalance) / lpSupply : 0n;

  // #2324: both sides can be large while the quotient is small, so scale inside
  // bigint arithmetic rather than converting each side to a float first.
  const userRedeemableFloat = bigintRatio(userRedeemableValue, divisor) ?? 0;

  if (loading) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
        <ShimmerSkeleton className="h-5 w-36 mb-6" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2">
              <ShimmerSkeleton className="h-3 w-20" />
              <ShimmerSkeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden hud-corners">
      <div className="h-px bg-gradient-to-r from-transparent via-[var(--cyan)]/30 to-transparent" />

      <div className="p-5">
        <div className="flex items-center justify-between mb-5">
          <h3
            className="text-sm font-medium text-[var(--text)]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Your Earn position
          </h3>
          {(hasPosition || pending) && (
            <span className="text-[10px] px-2 py-0.5 rounded-sm bg-[var(--cyan)]/10 border border-[var(--cyan)]/20 text-[var(--cyan)]">
              Active
            </span>
          )}
        </div>

        {!hasPosition && pending ? (
          <div data-testid="earn-position-pending" className="py-6 text-center">
            <p className="text-[13px] text-[var(--text)]">Withdrawal in progress: {pendingWithdrawalLabel}</p>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">It arrives in your wallet when the payout is approved.</p>
          </div>
        ) : !hasPosition ? (
          <div className="text-center py-6">
            <div className="text-2xl mb-2">📊</div>
            <p className="text-[13px] text-[var(--text-secondary)]">
              No Earn position yet
            </p>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">
              Deposit to start earning fees
            </p>
          </div>
        ) : (
          <>
            {/* Main value */}
            <div className="mb-5 p-4 bg-[var(--bg)] border border-[var(--border)] rounded-sm">
              <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-1">
                Value
              </div>
              <div className="flex items-baseline gap-2">
                <AnimatedNumber
                  value={userRedeemableFloat}
                  decimals={4}
                  className="text-2xl font-bold text-[var(--text)]"
                />
                <span className="text-sm text-[var(--text-secondary)]">
                  {collateralSymbol}
                </span>
              </div>
            </div>

            {earned && (earned.kind === 'exact' || EARNED_UNAVAILABLE_HINT[earned.reason]) && (
              <div className="mb-5 flex items-baseline justify-between" data-testid="lp-earned">
                <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                  Earned
                </div>
                {earned.kind === 'exact' ? (
                  <div
                    className={`text-sm font-medium ${earned.earnedAtoms < 0n ? 'text-[var(--short)]' : 'text-[var(--long)]'}`}
                    title={`Position value minus what you paid (${formatShares(earned.costBasisAtoms, decimals)} ${collateralSymbol}), plus realized from past redemptions (${formatSigned(earned.realizedAtoms, decimals)}). Fees compound into the share price; they are paid out on redemption.`}
                  >
                    {formatSigned(earned.earnedAtoms, decimals)} {collateralSymbol}
                  </div>
                ) : (
                  <div className="text-[12px] text-[var(--text-muted)]" title={EARNED_UNAVAILABLE_HINT[earned.reason]}>
                    —
                  </div>
                )}
              </div>
            )}

            {entryVsExit && (
              <div className="mb-5" data-testid="lp-entry-vs-exit" data-below={entryVsExit.below ? "1" : "0"}>
                <div className="flex items-baseline justify-between">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]">
                    {V21_COPY.earn.entryVsExitTitle}
                  </div>
                  <div className="text-[12px] font-mono tabular-nums text-[var(--text)]">
                    {entryVsExit.entryPerShare !== null ? entryVsExit.entryPerShare.toFixed(4) : '—'} → {entryVsExit.exitPerShare !== null ? entryVsExit.exitPerShare.toFixed(4) : '—'}
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                  {entryVsExit.below
                    ? V21_COPY.earn.entryVsExitBelow
                    : V21_COPY.earn.entryVsExit(
                        (entryVsExit.entryPerShare ?? 0).toFixed(4),
                        (entryVsExit.exitPerShare ?? 0).toFixed(4),
                        collateralSymbol,
                      )}
                </p>
              </div>
            )}

            {/* Metrics grid (UX WP-5 §4.4: shares at 2 dp, never raw atoms; one share value) */}
            <div className="grid grid-cols-2 gap-4">
              <MetricCell label="Shares" value={formatShares(userLpBalance, lpDecimals)} />
              <MetricCell label="Of the vault" value={`${userSharePct.toFixed(2)}%`} highlight />
              <MetricCell
                label="Share value"
                value={`${(Number(redemptionRateE6) / 1_000_000).toFixed(4)} ${collateralSymbol}`}
              />
              <MetricCell label="Vault total" value={`${formatShares(vaultBalance, decimals)} ${collateralSymbol}`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  highlight = false,
  color,
  tooltip,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
  tooltip?: string;
}) {
  return (
    <div>
      <div
        className={`text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mb-0.5 ${
          tooltip ? 'cursor-help underline decoration-dotted decoration-[var(--text-muted)]' : ''
        }`}
        title={tooltip}
      >
        {label}
      </div>
      <div
        className={`text-sm font-mono tabular-nums ${
          highlight ? 'font-semibold' : ''
        }`}
        style={{ color: color ?? (highlight ? 'var(--accent)' : 'var(--text)') }}
      >
        {value}
      </div>
    </div>
  );
}

/** 2 dp, floored, grouped. */
function formatShares(raw: bigint, decimals: number): string {
  const cents = (raw * 100n) / 10n ** BigInt(decimals);
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Signed amount with an explicit + / − sign (earned can be negative after a loss). */
function formatSigned(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  return raw < 0n ? `−${formatShares(-raw, decimals)}` : `+${formatShares(raw, decimals)}`;
}
