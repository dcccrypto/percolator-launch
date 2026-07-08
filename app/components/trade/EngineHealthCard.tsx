"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useLivePrice } from "@/hooks/useLivePrice";
import { computeMarketHealth, sanitizeOnChainValue } from "@/lib/health";
import { formatTokenAmount, formatSlotAge } from "@/lib/format";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: "text-[var(--long)]",
  caution: "text-[var(--warning)]",
  warning: "text-[var(--short)]",
  empty: "text-[var(--text-secondary)]",
};

/**
 * v17 markets carry no legacy engine block, so computeMarketHealth (which needs
 * cTot/insurance/OI off the engine) can't run. Derive an equivalent 0–100 health
 * score from what the v17 slab group exposes: insurance coverage (insurance/OI,
 * clamped 0..1) and OI balance (1 − |long−short|/(long+short)). Maps to the same
 * level → color buckets as the v12 path.
 *
 * M12: insurance is collateral (sim-USDC) atoms — already USD. OI is a
 * base-asset "Q" quantity (fixed-point, scale 1e6) denominated in whatever
 * asset the market trades (SOL, BONK, ...), NOT USD. The original coverage
 * ratio divided these two different units directly (ins_raw / oi_raw) — for
 * any market priced away from $1 this produced a wildly wrong number (e.g. a
 * $200 asset made coverage read ~200x too generous). Convert OI to USD via
 * the live price before comparing; insurance is used as-is (never ×price).
 */
function computeV17Health(
  insurance: bigint | null,
  totalOI: bigint | null,
  oiLong: bigint | null,
  oiShort: bigint | null,
  priceUsd: number | null,
): { level: string; label: string } {
  const insUsd = insurance != null ? Number(sanitizeOnChainValue(insurance)) / 1_000_000 : 0;
  const oiRawTotal = totalOI != null ? Number(sanitizeOnChainValue(totalOI)) : 0;
  const oiUsd = priceUsd != null ? (oiRawTotal / 1_000_000) * priceUsd : null;
  const long = oiLong != null ? Number(sanitizeOnChainValue(oiLong)) : 0;
  const short = oiShort != null ? Number(sanitizeOnChainValue(oiShort)) : 0;

  // No open interest, or no price yet to value it → treat as fully covered
  // (matches v12 computeMarketHealth's default-healthy-when-empty; an
  // unpriced market's exposure is unknown, not unhealthy).
  const coverage = oiUsd != null && oiUsd > 0 ? Math.min(1, Math.max(0, insUsd / oiUsd)) : 1;
  // Balance is a same-unit ratio (long vs short, both raw Q) — a uniform
  // price multiplier cancels out, so this doesn't need USD conversion.
  const oiSum = long + short;
  const oiBalance = oiSum > 0 ? 1 - Math.abs(long - short) / oiSum : 1;

  const score = Math.round((coverage * 0.5 + oiBalance * 0.5) * 100);
  if (score >= 66) return { level: "healthy", label: `Healthy · ${score}` };
  if (score >= 33) return { level: "caution", label: `Caution · ${score}` };
  return { level: "warning", label: `At Risk · ${score}` };
}

export const EngineHealthCard: FC = () => {
  const { engine, loading, hasData, insuranceBalance, totalOI, oiLong, oiShort } = useEngineState();
  const { accounts, config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const { showUsd } = useUsdToggle();
  const { priceUsd } = useLivePrice();

  if (loading) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        <p className="text-[10px] text-[var(--text-secondary)]">Loading...</p>
      </div>
    );
  }
  if (!hasData) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        <p className="text-[10px] text-[var(--text-secondary)]">No engine data for this market</p>
      </div>
    );
  }

  // Health: v12 uses the legacy engine block; v17 derives from insurance + OI.
  const health = engine
    ? computeMarketHealth(engine)
    : computeV17Health(insuranceBalance, totalOI, oiLong, oiShort, priceUsd);

  // v12 display helper (atoms bigint → USD/token string, "—" when null). Used
  // by the v12 metrics below, whose fields are all denominated in the same
  // collateral units.
  const fmtAtoms = (v: bigint | null): string => {
    if (v == null) return "—";
    const s = sanitizeOnChainValue(v);
    return showUsd && priceUsd != null
      ? formatNum((Number(s) / (10 ** decimals)) * priceUsd)
      : formatTokenAmount(s, decimals);
  };

  // M12: v17's insurance and OI are NOT the same unit. Insurance is collateral
  // (sim-USDC) atoms — already USD, so it must never be multiplied by the
  // market's base-asset price. OI is a base-asset "Q" quantity (fixed-point,
  // scale 1e6) — it genuinely needs ×price to become USD. Reusing one
  // price-multiplying formatter for both (the old `fmtAtoms` call below) is
  // exactly the bug this finding flagged.
  const fmtV17InsuranceUsd = (v: bigint | null): string => {
    if (v == null) return "—";
    const s = sanitizeOnChainValue(v);
    return showUsd ? formatNum(Number(s) / 1_000_000) : formatTokenAmount(s, decimals);
  };
  const fmtV17OiUsd = (v: bigint | null): string => {
    if (v == null) return "—";
    const s = sanitizeOnChainValue(v);
    return showUsd && priceUsd != null
      ? formatNum((Number(s) / 1_000_000) * priceUsd)
      : formatTokenAmount(s, decimals);
  };

  let metrics: Array<{ label: string; value: string }>;

  if (engine) {
    // ── v12 legacy path (unchanged) ─────────────────────────────────────────
    // Sanitize sentinel / corrupted on-chain values (u64::MAX or near-MAX garbage)
    // before converting to display values. Matches the guard in SystemCapitalCard.tsx.
    const cTot = sanitizeOnChainValue(engine.cTot ?? 0n);
    const pnlPosTot = sanitizeOnChainValue(engine.pnlPosTot ?? 0n);
    const netLpPos = sanitizeOnChainValue(engine.netLpPos ?? 0n);
    const lpSumAbs = sanitizeOnChainValue(engine.lpSumAbs ?? 0n);

    const haircutDenom = cTot + pnlPosTot;
    const haircutPct = haircutDenom > 0n
      ? (Number(pnlPosTot * 10000n / haircutDenom) / 100).toFixed(2) + "%"
      : "0%";

    const netLpPosDisplay = showUsd && priceUsd != null
      ? formatNum((Number(netLpPos < 0n ? -netLpPos : netLpPos) / (10 ** decimals)) * priceUsd)
      : formatTokenAmount(netLpPos < 0n ? -netLpPos : netLpPos, decimals);
    const lpSumAbsDisplay = showUsd && priceUsd != null
      ? formatNum((Number(lpSumAbs) / (10 ** decimals)) * priceUsd)
      : formatTokenAmount(lpSumAbs, decimals);
    const cTotDisplay = showUsd && priceUsd != null
      ? formatNum((Number(cTot) / (10 ** decimals)) * priceUsd)
      : formatTokenAmount(cTot, decimals);
    const pnlPosTotDisplay = showUsd && priceUsd != null
      ? formatNum((Number(pnlPosTot) / (10 ** decimals)) * priceUsd)
      : formatTokenAmount(pnlPosTot, decimals);

    metrics = [
      { label: "Crank Age", value: formatSlotAge(engine.currentSlot ?? 0n, engine.lastCrankSlot ?? 0n) },
      { label: "Current Slot", value: Number(engine.currentSlot ?? 0n).toLocaleString() },
      { label: "Liquidations", value: (engine.lifetimeLiquidations ?? 0n).toLocaleString() },
      { label: "Force Closes", value: (engine.lifetimeForceCloses ?? 0n).toLocaleString() },
      { label: "Net LP Pos", value: netLpPosDisplay },
      { label: "LP Sum |Pos|", value: lpSumAbsDisplay },
      { label: "Total Capital", value: cTotDisplay },
      { label: "Pos. PnL Tot", value: pnlPosTotDisplay },
      { label: "Haircut Ratio", value: haircutPct },
      { label: "Liq/GC Cursor", value: `${engine.liqCursor ?? "—"}/${engine.gcCursor ?? "—"}` },
      { label: "Crank Cursor", value: engine.crankCursor?.toString() ?? "—" },
      { label: "Sweep Start", value: engine.sweepStartIdx?.toString() ?? "—" },
    ];
  } else {
    // ── v17 path: insurance + OI are real; legacy engine counters show "—" ────
    metrics = [
      { label: "Insurance", value: fmtV17InsuranceUsd(insuranceBalance) },
      { label: "Open Interest", value: fmtV17OiUsd(totalOI) },
      { label: "OI Long", value: fmtV17OiUsd(oiLong) },
      { label: "OI Short", value: fmtV17OiUsd(oiShort) },
      { label: "Crank Age", value: "—" },
      { label: "Current Slot", value: "—" },
      { label: "Liquidations", value: "—" },
      { label: "Force Closes", value: "—" },
      { label: "Net LP Pos", value: "—" },
      { label: "LP Sum |Pos|", value: "—" },
      { label: "Total Capital", value: "—" },
      { label: "Pos. PnL Tot", value: "—" },
    ];
  }

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className={`text-[10px] font-medium uppercase tracking-[0.15em] ${HEALTH_COLORS[health.level]}${health.level === "warning" || health.level === "caution" ? " animate-pulse" : ""}`}>
          {health.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-px">
        {metrics.map((m) => (
          <div key={m.label} className="px-1.5 py-1 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0">
            <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">{m.label}</p>
            <p className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{m.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
