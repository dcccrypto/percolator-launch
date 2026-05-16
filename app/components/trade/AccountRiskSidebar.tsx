"use client";

import { FC, useEffect, useMemo, useRef, useState } from "react";
import { computeLiqPrice, computeMarkPnl, computePnlPercent } from "@percolatorct/sdk";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { getEntryPrice } from "@/lib/entry-price";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { LIQ_PRICE_UNLIQUIDATABLE, formatPnl, formatLiqPrice } from "@/lib/format";

const PRICE_BUFFER_SIZE = 60; // ~30 s of WS ticks at 0.5 s cadence; trims gracefully if cadence varies
const SPARK_W = 96;
const SPARK_H = 24;

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function formatTokenAmount(value: bigint, decimals: number, fractionDigits = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, fractionDigits);
  const wholeStr = whole.toLocaleString();
  const trimmedFrac = fracStr.replace(/0+$/, "");
  const out = trimmedFrac ? `${wholeStr}.${trimmedFrac}` : wholeStr;
  return negative ? `-${out}` : out;
}

function formatUsdE6(priceE6: bigint, fractionDigits = 4): string {
  if (priceE6 <= 0n) return "—";
  const negative = priceE6 < 0n;
  const a = negative ? -priceE6 : priceE6;
  const whole = a / 1_000_000n;
  const frac = a % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").slice(0, fractionDigits).replace(/0+$/, "");
  const wholeStr = whole.toLocaleString();
  return `${negative ? "-" : ""}$${fracStr ? `${wholeStr}.${fracStr}` : wholeStr}`;
}

/**
 * Tracks the last N live mark prices in a ring buffer so the sparkline
 * has something to draw. Falls back gracefully when livePriceE6 is null.
 */
function usePriceBuffer(livePriceE6: bigint | null, size = PRICE_BUFFER_SIZE): bigint[] {
  const [buffer, setBuffer] = useState<bigint[]>([]);
  const lastRef = useRef<bigint | null>(null);

  useEffect(() => {
    if (livePriceE6 == null || livePriceE6 <= 0n) return;
    // Coalesce duplicate consecutive prices to avoid flat plateaus dominating the line.
    if (lastRef.current !== null && lastRef.current === livePriceE6) return;
    lastRef.current = livePriceE6;
    setBuffer((b) => {
      const next = b.length < size ? [...b, livePriceE6] : [...b.slice(1), livePriceE6];
      return next;
    });
  }, [livePriceE6, size]);

  return buffer;
}

/**
 * Tiny SVG sparkline. No axes, no labels — just a stroke whose color
 * reflects net direction over the buffer.
 */
function Sparkline({ values, positive }: { values: bigint[]; positive: boolean }) {
  if (values.length < 2) {
    return (
      <svg
        width={SPARK_W}
        height={SPARK_H}
        aria-hidden
        className="opacity-30"
      >
        <line
          x1={0}
          y1={SPARK_H / 2}
          x2={SPARK_W}
          y2={SPARK_H / 2}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }
  const nums = values.map((v) => Number(v));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const stepX = SPARK_W / (values.length - 1);
  const points = nums
    .map((n, i) => {
      const x = i * stepX;
      const y = SPARK_H - ((n - min) / range) * SPARK_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const color = positive ? "var(--long)" : "var(--short)";
  return (
    <svg width={SPARK_W} height={SPARK_H} aria-hidden>
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  );
}

/**
 * Compact, persistent risk + account telemetry that sits next to the
 * trade form. Designed to be the thing a trader's eyes go to between
 * order edits without taking them off the chart.
 *
 * Renders nothing when there's no user account on this slab — the
 * empty state would be misleading (showing 0% liq distance with no
 * position implies a problem when really there's just no position).
 */
export const AccountRiskSidebar: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const userAccount = useUserAccount();
  const { config: mktConfig } = useSlabState();
  const { params, engine } = useEngineState();
  const { priceE6: livePriceE6 } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const collateralSymbol = tokenMeta?.symbol ?? "USDC";

  const priceBuffer = usePriceBuffer(livePriceE6);

  // Always-on fallback: the on-chain "last effective price" so we keep
  // showing data when the WS feed is briefly out.
  const onChainOracleE6 = mktConfig
    ? sanitizePriceE6(applyInvert(mktConfig.lastEffectivePriceE6, mktConfig.invert))
    : 0n;
  const oracleE6 = livePriceE6 ?? onChainOracleE6;
  const hasValidMark = oracleE6 > 0n;

  if (!userAccount) return null;
  const { idx, account } = userAccount;
  const hasPosition = account.positionSize !== 0n;
  const isLong = account.positionSize > 0n;

  // ── Math (uses the same SDK helpers as PositionPanel + TradeForm) ──
  const maintBps = params?.maintenanceMarginBps ?? 500n;

  // Prefer on-chain entryPrice (V12_1_EP) when present; fall back to
  // localStorage entry saved at trade time for old V12_1 markets.
  const resolvedEntry =
    account.entryPrice > 0n
      ? account.entryPrice
      : (slabAddress ? getEntryPrice(slabAddress, idx) : null) ?? 0n;

  const liqPriceE6 = useMemo(
    () => computeLiqPrice(resolvedEntry, account.capital, account.positionSize, maintBps),
    [resolvedEntry, account.capital, account.positionSize, maintBps],
  );

  const pnlTokens = useMemo(
    () =>
      hasPosition && resolvedEntry > 0n && hasValidMark
        ? computeMarkPnl(account.positionSize, resolvedEntry, oracleE6)
        : 0n,
    [account.positionSize, resolvedEntry, oracleE6, hasPosition, hasValidMark],
  );
  const pnlPct = useMemo(
    () => (hasPosition ? computePnlPercent(pnlTokens, account.capital) : 0),
    [pnlTokens, account.capital, hasPosition],
  );

  // Distance to liquidation as a percent of current price. Saturates to
  // 100% for the unliquidatable sentinel value.
  const liqDistPct = useMemo(() => {
    if (!hasPosition) return 100;
    if (liqPriceE6 >= LIQ_PRICE_UNLIQUIDATABLE) return 100;
    if (liqPriceE6 <= 0n || !hasValidMark) return 0;
    const dist =
      Math.abs(Number(oracleE6) - Number(liqPriceE6)) / Number(oracleE6);
    return Math.min(100, dist * 100);
  }, [hasPosition, liqPriceE6, oracleE6, hasValidMark]);

  // Margin used / available.
  // Used = position notional in collateral terms. Available = capital - used (floor 0).
  const notionalNative = useMemo(() => {
    if (!hasPosition || !hasValidMark) return 0n;
    return (abs(account.positionSize) * oracleE6) / 1_000_000n;
  }, [account.positionSize, oracleE6, hasPosition, hasValidMark]);
  const marginUsedPct = useMemo(() => {
    if (account.capital === 0n) return 0;
    // Notional / capital is "order leverage"; clamp to 0-100 for the bar.
    const ratio = Number(notionalNative) / Number(account.capital);
    return Math.max(0, Math.min(100, ratio * 10)); // 10x leverage fills the bar
  }, [notionalNative, account.capital]);

  // Leverage figures (match TradeForm conventions).
  const orderLeverage = useMemo(() => {
    if (account.capital === 0n) return 0;
    return Number(notionalNative) / Number(account.capital);
  }, [notionalNative, account.capital]);
  const equity = account.capital + pnlTokens;
  const riskLeverage = useMemo(() => {
    if (equity <= 0n) return 0;
    return Number(notionalNative) / Number(equity);
  }, [notionalNative, equity]);

  // Funding rate estimate — current bps-per-slot × position size,
  // annualised to "per day" as a rough trader-facing number. Engine
  // exposes the latest rate; positive rate = longs pay shorts.
  // ~432_000 slots per day at 200 ms each.
  const SLOTS_PER_DAY = 432_000n;
  const fundingRateBpsSlot = engine?.fundingRateBpsPerSlotLast ?? 0n;
  const fundingPerDayNative = useMemo(() => {
    if (!hasPosition || !hasValidMark || fundingRateBpsSlot === 0n) return 0n;
    // pay/receive depends on side. Positive funding rate → longs pay,
    // so a long position has a negative payment.
    const sign = isLong ? -1n : 1n;
    return (
      (sign *
        notionalNative *
        fundingRateBpsSlot *
        SLOTS_PER_DAY) /
      10_000n
    );
  }, [notionalNative, fundingRateBpsSlot, isLong, hasPosition, hasValidMark]);

  // Visual color zones for the liq-distance bar (kept symmetric: long
  // gets liquidated below, short gets liquidated above — the bar shows
  // distance regardless of direction).
  const liqColor =
    liqDistPct >= 50
      ? "var(--long)"
      : liqDistPct >= 20
        ? "#fbbf24"
        : "var(--short)";

  const pnlPositive = pnlTokens >= 0n;
  const pnlColor = !hasPosition
    ? "var(--text-secondary)"
    : pnlPositive
      ? "var(--long)"
      : "var(--short)";

  return (
    <div className="rounded-none border border-[var(--border)] bg-[var(--panel-bg)]/80 p-3 text-[12px] text-[var(--text)]">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          Account Risk
        </span>
        <span className="font-mono text-[10px] text-[var(--text-dim)]">
          #{idx}
        </span>
      </div>

      {/* ── Distance to Liquidation ─────────────────────────────── */}
      <div className="mb-3.5">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Liq distance
          </span>
          <span
            className="font-mono text-[12px] font-bold"
            style={{ color: liqColor, fontVariantNumeric: "tabular-nums" }}
          >
            {hasPosition ? `${liqDistPct.toFixed(1)}%` : "—"}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-sm bg-[var(--border)]/40">
          <div
            className="h-full rounded-sm transition-[width] duration-300 ease-out"
            style={{
              width: `${hasPosition ? liqDistPct : 0}%`,
              background: liqColor,
            }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-[var(--text-dim)]">
          <span>
            {hasPosition && liqPriceE6 > 0n && liqPriceE6 < LIQ_PRICE_UNLIQUIDATABLE
              ? `Liq @ ${formatLiqPrice(liqPriceE6)}`
              : hasPosition
                ? "Unliquidatable"
                : "No open position"}
          </span>
          <span>
            {hasValidMark ? `Mark ${formatUsdE6(oracleE6)}` : ""}
          </span>
        </div>
      </div>

      {/* ── Margin used ─────────────────────────────────────────── */}
      <div className="mb-3.5">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Margin used
          </span>
          <span
            className="font-mono text-[11px] text-[var(--text)]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {hasPosition
              ? `${formatTokenAmount(notionalNative, decimals)} / ${formatTokenAmount(account.capital, decimals)} ${collateralSymbol}`
              : `${formatTokenAmount(account.capital, decimals)} ${collateralSymbol} idle`}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-sm bg-[var(--border)]/40">
          <div
            className="h-full rounded-sm bg-[var(--accent)]/70 transition-[width] duration-300 ease-out"
            style={{ width: `${marginUsedPct}%` }}
          />
        </div>
      </div>

      {/* ── Leverage ──────────────────────────────────────────── */}
      <div className="mb-3.5 grid grid-cols-2 gap-2">
        <div className="rounded-sm border border-[var(--border)]/60 bg-[var(--bg)]/40 p-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Order lev
          </div>
          <div
            className="mt-0.5 font-mono text-[14px] font-bold text-[var(--text)]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {hasPosition ? `${orderLeverage.toFixed(2)}x` : "—"}
          </div>
        </div>
        <div className="rounded-sm border border-[var(--border)]/60 bg-[var(--bg)]/40 p-2">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
            Risk lev
          </div>
          <div
            className="mt-0.5 font-mono text-[14px] font-bold"
            style={{
              color: riskLeverage > orderLeverage * 1.5 ? "var(--short)" : "var(--text-secondary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {hasPosition ? `${riskLeverage.toFixed(2)}x` : "—"}
          </div>
        </div>
      </div>

      {/* ── P&L with sparkline ────────────────────────────────── */}
      <div className="mb-3.5 rounded-sm border border-[var(--border)]/60 bg-[var(--bg)]/40 p-2">
        <div className="flex items-start justify-between">
          <div>
            <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Unrealized
            </div>
            <div
              className="mt-0.5 font-mono text-[15px] font-bold"
              style={{ color: pnlColor, fontVariantNumeric: "tabular-nums" }}
            >
              {hasPosition ? formatPnl(pnlTokens, decimals) : "—"} {hasPosition ? collateralSymbol : ""}
            </div>
            <div
              className="font-mono text-[10.5px]"
              style={{ color: pnlColor, fontVariantNumeric: "tabular-nums" }}
            >
              {hasPosition ? `${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}% ROE` : ""}
            </div>
          </div>
          <div style={{ color: pnlColor }}>
            <Sparkline values={priceBuffer} positive={pnlPositive} />
          </div>
        </div>
      </div>

      {/* ── Funding impact ────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
          Funding /day
        </span>
        <span
          className="font-mono text-[11.5px]"
          style={{
            color:
              fundingPerDayNative >= 0n ? "var(--long)" : "var(--short)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {hasPosition && fundingRateBpsSlot !== 0n
            ? `${fundingPerDayNative >= 0n ? "+" : ""}${formatTokenAmount(fundingPerDayNative, decimals, 4)} ${collateralSymbol}`
            : "—"}
        </span>
      </div>
    </div>
  );
};
