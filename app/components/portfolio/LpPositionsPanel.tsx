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

// Which product a position belongs to is where it LIVES, which the hook already
// records as `kind`: "earn" = an Earn (LP vault) deposit in the wrapper's LP Vault
// Registry, "stake" = a stake-pool position (managed on /stake). Not poolMode: a
// stake pool can be poolMode 1 (trading LP) and still lives on /stake.
// Centralised so the split, totals, colour and link target can't drift apart.
type PositionKind = LpPosition["kind"];
function kindOf(pos: LpPosition): PositionKind {
  return pos.kind;
}

/** Per-kind presentation. Earn (Vault) reads cyan; Stake reads violet accent. */
const KIND = {
  earn: { title: "Vault", subtitle: "Earn deposits", accent: "var(--cyan)" },
  stake: { title: "Stake", subtitle: "Stake pools", accent: "var(--accent)" },
} as const;

// ═══════════════════════════════════════════════════════════════
// Components
// ═══════════════════════════════════════════════════════════════

/**
 * Pool avatar that ALWAYS renders something: a gradient+initials chip sits
 * underneath, and the real logo (when the pool has one) layers on top and simply
 * reveals the chip again if it 404s. So every row shows a logo, tinted to its
 * section — no blank gaps for pools without a configured image.
 */
function PoolAvatar({ logoUrl, symbol, accent }: { logoUrl: string | null; symbol: string; accent: string }) {
  const initials = (symbol || "?").slice(0, 2).toUpperCase();
  return (
    <div className="relative h-7 w-7 flex-shrink-0">
      <div
        className="absolute inset-0 flex items-center justify-center rounded-full text-[9px] font-bold"
        style={{
          background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 18%, transparent), color-mix(in srgb, ${accent} 5%, transparent))`,
          color: accent,
        }}
      >
        {initials}
      </div>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={symbol}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-7 w-7 rounded-full object-cover"
          style={{ boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 28%, transparent)` }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : null}
    </div>
  );
}

function LpPositionCard({ position: pos, kind }: { position: LpPosition; kind: PositionKind }) {
  const displaySymbol = getDisplaySymbol(pos).replace(/-PERP$/i, "");
  const accent = KIND[kind].accent;
  const cooldownLabel = pos.cooldownElapsed ? null : slotsToTime(pos.cooldownSlots);
  const secondary =
    pos.apr > 0
      ? `${formatPct(pos.apr)} APR`
      : kind === "earn"
        ? "Earn vault"
        : pos.poolMode === 0
          ? "Insurance pool"
          : "Stake pool";

  return (
    <Link
      href={kind === "earn" ? (pos.slabAddress ? `/earn/${pos.slabAddress}` : "/earn") : "/stake"}
      className="group block rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] transition-all duration-200 hover:bg-[var(--bg-elevated)] hover:translate-y-[-1px]"
      style={{ borderLeft: `2px solid ${accent}` }}
    >
      <div className="p-4">
        {/* Header row */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <PoolAvatar logoUrl={pos.logoUrl} symbol={displaySymbol} accent={accent} />
            <div className="min-w-0">
              <p
                className="text-sm font-semibold text-[var(--text)] truncate"
                style={{ fontFamily: "var(--font-jetbrains-mono)" }}
              >
                {displaySymbol}
              </p>
              <p className="text-[10px] text-[var(--text-secondary)] truncate">{secondary}</p>
            </div>
          </div>

          {/* Value */}
          <div className="text-right flex-shrink-0">
            <p
              className="text-sm font-bold"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums", color: accent }}
            >
              {formatUsd(pos.redeemable)}
            </p>
            <p className="text-[10px] text-[var(--text-secondary)]">redeemable</p>
          </div>
        </div>

        {/* Details grid (stake pools only; an Earn deposit's details are on /earn) */}
        {kind === "stake" && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Shares</p>
            <p
              className="text-[12px] text-[var(--text-secondary)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {pos.lpBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
            </p>
          </div>

          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Pool Share</p>
            <p
              className="text-[12px] text-[var(--text-secondary)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatPct(pos.userSharePct)}
            </p>
          </div>

          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Pool TVL</p>
            <p
              className="text-[12px] text-[var(--text-secondary)]"
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {formatUsd(pos.tvl)}
            </p>
          </div>

          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Withdraw</p>
            {pos.cooldownElapsed ? (
              <p className="text-[12px] font-semibold text-[var(--long)]">✓ Ready</p>
            ) : (
              <p className="text-[12px] text-[var(--warning)]">Cooldown {cooldownLabel}</p>
            )}
          </div>
        </div>
        )}
      </div>
    </Link>
  );
}

/** One titled section (Vault or Stake) with its own redeemable total. */
function PositionGroup({ kind, positions }: { kind: PositionKind; positions: LpPosition[] }) {
  const { title, subtitle, accent } = KIND[kind];
  const total = positions.reduce((s, p) => s + p.redeemable, 0);
  return (
    <section>
      <div className="mb-2 flex items-end justify-between border-b border-[var(--border)] pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: accent }} />
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text)]">{title}</h3>
          <span className="rounded-full bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-[var(--text-secondary)]">
            {positions.length}
          </span>
          <span className="truncate text-[10px] text-[var(--text-secondary)]">· {subtitle}</span>
        </div>
        <div className="text-right flex-shrink-0">
          <p
            className="text-[13px] font-bold tabular-nums"
            style={{ fontFamily: "var(--font-jetbrains-mono)", color: accent }}
          >
            {formatUsd(total)}
          </p>
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">total redeemable</p>
        </div>
      </div>
      <div className="space-y-2">
        {positions.map((pos) => (
          <LpPositionCard key={pos.poolAddress} position={pos} kind={kind} />
        ))}
      </div>
    </section>
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
  // Split into the two distinct products so each reads as its own section with
  // its own total, rather than one mixed list (Earn vaults and insurance stakes
  // behave differently and the user tracks them separately).
  const vaultPositions = positions.filter((p) => kindOf(p) === "earn");
  const stakePositions = positions.filter((p) => kindOf(p) === "stake");

  return (
    <div>
      {/* Section heading */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--cyan)]/70">
          // Earn and stake positions
        </h2>
        {positions.length > 0 && !loading && (
          <span
            className="text-[11px] font-semibold text-[var(--text-secondary)]"
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
                  <ShimmerSkeleton className="h-7 w-7 rounded-full" />
                  <ShimmerSkeleton className="h-4 w-24" />
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
          <span className="text-2xl leading-none">⚠️</span>
          <div>
            <p className="text-[12px] font-semibold text-[var(--text-secondary)]">Couldn&apos;t load your Earn and stake positions</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Please try refreshing</p>
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
            <p className="text-[12px] font-medium text-[var(--text)]">No Earn or stake positions</p>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
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
        <div className="space-y-6">
          {vaultPositions.length > 0 && <PositionGroup kind="earn" positions={vaultPositions} />}
          {stakePositions.length > 0 && <PositionGroup kind="stake" positions={stakePositions} />}
        </div>
      )}
    </div>
  );
}
