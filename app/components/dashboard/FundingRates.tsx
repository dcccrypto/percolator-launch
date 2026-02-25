"use client";

import { useMemo, useState, useEffect } from "react";
import { getMockFundingRates, type FundingRate } from "@/lib/mock-dashboard-data";

function formatCountdown(targetMs: number): string {
  const diff = Math.max(0, targetMs - Date.now());
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return `${hours}h ${mins}m ${secs}s`;
}

export function FundingRates() {
  const rates = useMemo(() => getMockFundingRates(), []);
  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    if (rates.length === 0) return;
    const update = () => setCountdown(formatCountdown(rates[0].nextSettlement));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [rates]);

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center gap-2">
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            Funding Rates
          </p>
          <span
            className="cursor-help text-[10px] text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
            title="Positive = longs pay shorts. Negative = shorts pay longs."
          >
            ⓘ
          </span>
        </div>
        <span
          className="text-[10px] text-[var(--text-muted)]"
          style={{ fontFamily: "var(--font-jetbrains-mono)" }}
        >
          Next: {countdown}
        </span>
      </div>

      {/* Table */}
      <table className="w-full">
        <thead>
          <tr className="border-b border-[var(--border)] text-[8px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
            <th className="px-4 py-2 text-left">Market</th>
            <th className="px-3 py-2 text-right">Rate</th>
            <th className="px-3 py-2 text-right">Est. Payment</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((rate) => {
            const isPositive = rate.rate > 0;
            const annualized = rate.rate * 3 * 365; // 3 funding periods per day × 365
            return (
              <tr
                key={rate.market}
                className="border-b border-[rgba(255,255,255,0.04)] text-[11px] transition-colors hover:bg-[rgba(255,255,255,0.02)]"
              >
                <td className="px-4 py-2.5">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)]">
                    {rate.symbol}-PERP
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span
                    className={`font-bold ${isPositive ? "text-[var(--warning)]" : "text-[var(--long)]"}`}
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    title={`Annualized: ${annualized.toFixed(1)}%`}
                  >
                    {isPositive ? "+" : ""}{rate.rate.toFixed(3)}%
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span
                    className={`text-[10px] ${rate.estimatedPayment >= 0 ? "text-[var(--short)]/70" : "text-[var(--long)]/70"}`}
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {rate.estimatedPayment >= 0 ? "-" : "+"}${Math.abs(rate.estimatedPayment).toFixed(2)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
