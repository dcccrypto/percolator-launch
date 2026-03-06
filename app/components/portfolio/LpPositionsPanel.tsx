"use client";

import Link from "next/link";
import { type LpPosition } from "@/hooks/useLpPositions";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(n: number): string {
  if (n < 0.01) return "< 0.01%";
  return `${n.toFixed(2)}%`;
}

/**
 * Detect if a "symbol" is actually a truncated address hash (e.g. "7MkErbg1").
 *
 * Real token symbols are ALL-CAPS letters only (e.g. "BTC", "SOL", "PERP").
 * Pool address slabs look like "7MkErbg1" — mixed case + digits, not a proper symbol.
 * Using a positive match (/^[A-Z]{1,10}$/) is more reliable than a digit-ratio
 * heuristic, which failed for "7MkErbg1" (2/8 = 25%, below the old 30% threshold).
 */
function isAddressHash(s: string): boolean {
  if (!s) return true;
  // A valid symbol is 1-10 uppercase letters only.
  // Anything that doesn't match is treated as an address hash.
  return !/^[A-Z]{1,10}$/.test(s);
}

/** Get a clean display symbol from position data. */
function getDisplaySymbol(pos: { symbol: string; name: string }): string {
  if (!isAddressHash(pos.symbol)) return pos.symbol;
  // Fallback: extract clean symbol from name if it ends in "-PERP" / " PERP"
  // e.g. name="Pool 7MkErbg1" → still a hash, skip; name="BTC-PERP" → strip suffix
  if (pos.name) {
    const nameSymbol = pos.name
      .replace(/[-\s]PERP$/i, "")   // strip -PERP / PERP suffix
      .replace(/^Pool\s+/i, "")     // strip "Pool " prefix
      .trim();
    if (!isAddressHash(nameSymbol)) return nameSymbol;
  }
  return pos.symbol;
}

function slotsToTime(slots: number): string {
  const seconds = Math.round(slots * 0.4);
  if (seconds < 60) return `~${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `~${mins} min`;
  return `~${Math.round(mins / 60)}h`;
}

// ═══════════════════════════════════════════════════════════════
// Components
// ═══════════════════════════════════════════════════════════════

interface LpPositionCardProps {
  position: LpPosition;
}

function LpPositionCard({ position: pos }: LpPositionCardProps) {
  const displaySymbol = getDisplaySymbol(pos);
  const cooldownLabel = pos.cooldownElapsed
    ? null
    : slotsToTime(pos.cooldownSlots);

  return (
    <Link
      href={`/stake`}
      className="block border border-[var(--border)] bg-[var(--panel-bg)] transition-all duration-200 hover:border-[var(--cyan)]/30 hover:bg-[var(--bg-elevated)]"
    >
      <div className="p-4">
        {/* Header row */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {/* Pool icon */}
            {pos.logoUrl ? (
              <img
                src={pos.logoUrl}
                alt={displaySymbol}
                className="h-6 w-6 rounded-full flex-shrink-0 object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div className="h-6 w-6 rounded-full flex-shrink-0 bg-[var(--accent)]/20 flex items-center justify-center text-[9px] font-bold text-[var(--accent)]">
                {displaySymbol.slice(0, 2)}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                {displaySymbol}-PERP
              </p>
              <p className="text-[10px] text-[var(--text-dim)] truncate">
                {pos.poolMode === 0 ? "Insurance LP" : "Trading LP"}
              </p>
            </div>
            <span className="rounded bg-[var(--cyan)]/10 px-2 py-0.5 text-[10px] font-bold text-[var(--cyan)] flex-shrink-0">
              LP
            </span>
          </div>

          {/* Value */}
          <div className="text-right flex-shrink-0">
            <p
              className="text-sm font-bold text-[var(--cyan)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatUsd(pos.redeemable)}
            </p>
            <p className="text-[10px] text-[var(--text-dim)]">
              redeemable
            </p>
          </div>
        </div>

        {/* Details grid */}
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">LP Balance</p>
            <p
              className="text-[12px] text-[var(--text-secondary)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {pos.lpBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
            </p>
          </div>

          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Pool Share</p>
            <p
              className="text-[12px] text-[var(--text-secondary)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatPct(pos.userSharePct)}
            </p>
          </div>

          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Pool TVL</p>
            <p
              className="text-[12px] text-[var(--text-secondary)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatUsd(pos.tvl)}
            </p>
          </div>

          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Withdraw</p>
            {pos.cooldownElapsed ? (
              <p className="text-[12px] font-semibold text-[var(--long)]">
                ✓ Ready
              </p>
            ) : (
              <p className="text-[12px] text-[var(--warning)]">
                Cooldown {cooldownLabel}
              </p>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main panel
// ═══════════════════════════════════════════════════════════════

interface LpPositionsPanelProps {
  loading: boolean;
  positions: LpPosition[];
  totalRedeemable: number;
  error: string | null;
  onRetry?: () => void;
}

export function LpPositionsPanel({
  loading,
  positions,
  totalRedeemable,
  error,
  onRetry,
}: LpPositionsPanelProps) {
  return (
    <div>
      {/* Section heading */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--cyan)]/70">
          Insurance LP Positions
        </h2>
        {positions.length > 0 && !loading && (
          <span
            className="text-[11px] font-semibold text-[var(--cyan)]"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {formatUsd(totalRedeemable)} total
          </span>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="border border-[var(--border)] bg-[var(--panel-bg)] p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <ShimmerSkeleton className="h-6 w-6 rounded-full" />
                  <ShimmerSkeleton className="h-4 w-24" />
                  <ShimmerSkeleton className="h-4 w-8 rounded" />
                </div>
                <ShimmerSkeleton className="h-5 w-20" />
              </div>
              <div className="grid grid-cols-4 gap-x-6 gap-y-1.5">
                {[1, 2, 3, 4].map((j) => (
                  <div key={j}>
                    <ShimmerSkeleton className="h-3 w-12 mb-1.5" />
                    <ShimmerSkeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-6 flex flex-col items-center gap-3 text-center">
          <span className="text-xl leading-none">⚠️</span>
          <div>
            <p className="text-[12px] font-semibold text-[var(--text-secondary)]">Unable to load LP positions</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-dim)]">Please try refreshing</p>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-xs text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
            >
              Retry
            </button>
          )}
        </div>
      ) : positions.length === 0 ? (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-[12px] font-medium text-[var(--text-secondary)]">No LP positions</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-dim)]">
              Deposit into insurance pools to earn yield while backing the fund.
            </p>
          </div>
          <Link
            href="/stake"
            className="flex-shrink-0 border border-[var(--cyan)]/40 px-4 py-2 text-[11px] font-semibold text-[var(--cyan)] transition-colors hover:border-[var(--cyan)]/80 hover:bg-[var(--cyan)]/5"
          >
            Stake Now →
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {positions.map((pos) => (
            <LpPositionCard key={pos.poolAddress} position={pos} />
          ))}
        </div>
      )}
    </div>
  );
}
