"use client";

import { useEffect, useState } from "react";
import type { FundingGlobalEntry, FundingGlobalResponse } from "@/app/api/funding/global/route";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import { v22HasNoIndexer } from "@/lib/v22/indexer";

/**
 * Funding Rates — shows top markets by funding rate from /api/funding/global.
 * Rates are per hour (continuous funding, ~9000 slots/hour on Solana).
 *
 * The panel renders nothing when it cannot answer honestly: the route is unavailable (503), or
 * some market has funding on but its rate is not decoded yet (`ratesUnavailable`) while no
 * listed market has a non-zero rate — "Funding: Off" would then be a claim about markets we
 * could not read.
 */
export function FundingRates() {
  const [markets, setMarkets] = useState<FundingGlobalEntry[]>([]);
  const [ratesUnavailable, setRatesUnavailable] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // v2.2 QA RT5-3: the list needs the market registry, which the v2.2 preview does not have (the route answers
      // 503 there). Do not ask; the panel hides exactly as it does on a failure.
      if (v22HasNoIndexer()) {
        if (!cancelled) { setFailed(true); setLoading(false); }
        return;
      }
      try {
        const res = await fetch("/api/funding/global?limit=8");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as FundingGlobalResponse;
        if (!cancelled) {
          setMarkets(data.markets ?? []);
          setRatesUnavailable(data.ratesUnavailable ?? 0);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    // Refresh every 60s — visibility-gated so hidden tabs don't keep polling
    const dispose = pollWhenVisible(load, 60_000);
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  // Active markets are those with non-zero funding rate
  const active = markets.filter((m) => m.rateBpsPerSlot !== 0);

  if (!loading && (failed || (active.length === 0 && (ratesUnavailable > 0 || markets.length === 0)))) {
    return null;
  }

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-center gap-2">
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
            Funding Rates
          </p>
          <span
            className="cursor-help text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
            title="Continuous funding: positive rate = longs pay shorts, negative = shorts pay longs. Shown as % per hour."
          >
            ⓘ
          </span>
        </div>
        <span className="text-[9px] text-[var(--text-secondary)]">% / hr</span>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center px-5 py-6">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)]/30 border-t-[var(--accent)]" />
        </div>
      ) : active.length === 0 ? (
        // M19: on these devnet markets the applied funding rate is
        // structurally clamped to 0 (max_abs_funding_e9_per_slot == 0), which
        // is exactly why every market always lands in this branch — say so
        // plainly instead of the old "rates appear once markets have open
        // positions" copy, which implied funding was live and just quiet.
        <div className="px-5 py-8 text-center">
          <p className="text-[11px] text-[var(--text-secondary)]">Funding: Off (disabled)</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)]">
            The protocol&rsquo;s max funding rate is set to 0 on these markets — the applied rate is always 0
          </p>
        </div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto">
        <ul className="divide-y divide-[rgba(255,255,255,0.04)]">
          {active.slice(0, 15).map((m) => {
            const isPositive = m.rateBpsPerSlot > 0;
            const rateStr =
              (isPositive ? "+" : "") +
              m.hourlyRatePercent.toFixed(4) + "%";
            const label = m.baseSymbol
              ? `${m.baseSymbol}-PERP`
              : `${m.slabAddress.slice(0, 6)}…`;
            return (
              <li
                key={m.slabAddress}
                className="flex items-center justify-between px-5 py-2.5 transition-colors hover:bg-[rgba(255,255,255,0.02)]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    {label}
                  </span>
                  <span
                    className={`text-[8px] font-semibold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded-sm ${
                      isPositive
                        ? "text-[var(--long)] bg-[var(--long)]/10"
                        : "text-[var(--short)] bg-[var(--short)]/10"
                    }`}
                  >
                    {isPositive ? "L→S" : "S→L"}
                  </span>
                </div>
                <span
                  className={`text-[11px] font-semibold tabular-nums ${
                    isPositive ? "text-[var(--long)]" : "text-[var(--short)]"
                  }`}
                  style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                >
                  {rateStr}
                </span>
              </li>
            );
          })}
        </ul>
        </div>
      )}
    </div>
  );
}
