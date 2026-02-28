'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';

interface LpPositionDashboardProps {
  /** User's LP token balance (raw) */
  userLpBalance: bigint;
  /** Total LP supply */
  lpSupply: bigint;
  /** Total vault balance (raw) */
  vaultBalance: bigint;
  /** Decimals for collateral */
  decimals: number;
  /** Collateral symbol */
  collateralSymbol: string;
  /** Estimated APY % */
  estimatedApyPct: number;
  /** Redemption rate (e6) */
  redemptionRateE6: bigint;
  /** Loading */
  loading: boolean;
}

export function LpPositionDashboard({
  userLpBalance,
  lpSupply,
  vaultBalance,
  decimals,
  collateralSymbol,
  estimatedApyPct,
  redemptionRateE6,
  loading,
}: LpPositionDashboardProps) {
  const divisor = 10n ** BigInt(decimals);
  const hasPosition = userLpBalance > 0n;

  // Calculate user's share
  const userSharePct =
    lpSupply > 0n
      ? Number((userLpBalance * 10000n) / lpSupply) / 100
      : 0;

  const userRedeemableValue =
    lpSupply > 0n ? (userLpBalance * vaultBalance) / lpSupply : 0n;

  const userRedeemableFloat = Number(userRedeemableValue) / Number(divisor);

  // Share value (how much 1 LP token is worth)
  const shareValue =
    lpSupply > 0n
      ? Number(vaultBalance * 1_000_000n / lpSupply) / 1_000_000
      : 1;

  if (loading) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners animate-pulse">
        <div className="h-5 w-36 bg-[var(--border)] rounded mb-6" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i}>
              <div className="h-3 w-20 bg-[var(--border)] rounded mb-2" />
              <div className="h-6 w-24 bg-[var(--border)] rounded" />
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
            className="text-sm font-medium text-white"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Your LP Position
          </h3>
          {hasPosition && (
            <span className="text-[10px] px-2 py-0.5 rounded-sm bg-[var(--cyan)]/10 border border-[var(--cyan)]/20 text-[var(--cyan)]">
              Active
            </span>
          )}
        </div>

        {!hasPosition ? (
          <div className="text-center py-6">
            <div className="text-2xl mb-2">📊</div>
            <p className="text-[13px] text-[var(--text-secondary)]">
              No active LP position
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
                Position Value
              </div>
              <div className="flex items-baseline gap-2">
                <AnimatedNumber
                  value={userRedeemableFloat}
                  decimals={4}
                  className="text-2xl font-bold text-white"
                />
                <span className="text-sm text-[var(--text-secondary)]">
                  {collateralSymbol}
                </span>
              </div>
            </div>

            {/* Metrics grid */}
            <div className="grid grid-cols-2 gap-4">
              <MetricCell
                label="LP Tokens"
                value={formatRaw(userLpBalance, decimals)}
              />
              <MetricCell
                label="Pool Share"
                value={`${userSharePct.toFixed(2)}%`}
                highlight
              />
              <MetricCell
                label="Share Value"
                value={`${(Number(shareValue) / Number(divisor)).toFixed(4)} ${collateralSymbol}`}
              />
              <MetricCell
                label="Est. APY"
                value={`${estimatedApyPct.toFixed(1)}%`}
                highlight
                color="var(--cyan)"
              />
              <MetricCell
                label="Redemption Rate"
                value={`${(Number(redemptionRateE6) / 1_000_000).toFixed(4)}`}
              />
              <MetricCell
                label="Total Vault"
                value={`${formatRaw(vaultBalance, decimals)} ${collateralSymbol}`}
              />
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
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mb-0.5">
        {label}
      </div>
      <div
        className={`text-sm font-mono tabular-nums ${
          highlight ? 'font-semibold' : ''
        }`}
        style={{ color: color ?? (highlight ? 'var(--accent)' : 'white') }}
      >
        {value}
      </div>
    </div>
  );
}

function formatRaw(raw: bigint, decimals: number): string {
  if (raw <= 0n) return '0';
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
