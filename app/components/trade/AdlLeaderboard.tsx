"use client";

/**
 * ADL Leaderboard Component — PERC-8295
 *
 * Displays Auto-Deleverage position rankings for a given slab.
 * Fetches from GET /api/adl/rankings?slab=<address> (percolator-api).
 *
 * Shows:
 *  - ADL trigger status (active / inactive)
 *  - Insurance utilization BPS
 *  - PnL cap exceeded flag
 *  - Ranked table: rank, position idx, side*, unrealized PnL, capital, PnL%
 *    *side is not in the API response (account slot only) — shown as "–" until
 *    the SDK exposes it in parseAllAccounts
 *  - Near-trigger highlight (top 3 positions when ADL is needed)
 */

import { FC, useEffect, useState, useCallback } from "react";
import { InfoIcon } from "@/components/ui/Tooltip";

// ─── types ────────────────────────────────────────────────────────────────

interface RankedPosition {
  rank: number;
  idx: number;
  pnlAbs: string;        // raw lamports string
  capital: string;       // raw lamports string
  pnlPctMillionths: string; // (pnl / capital) * 1_000_000
}

interface AdlRankingsResponse {
  slabAddress: string;
  pnlPosTot: string;
  maxPnlCap: string;
  insuranceFundBalance: string;
  insuranceFundFeeRevenue: string;
  insuranceUtilizationBps: number;
  capExceeded: boolean;
  insuranceDepleted: boolean;
  utilizationTriggered: boolean;
  adlNeeded: boolean;
  excess: string;
  rankings: RankedPosition[];
}

// ─── helpers ──────────────────────────────────────────────────────────────

const DECIMALS = 6;
const DIVISOR = 10 ** DECIMALS;

function fmtUsd(raw: string | bigint): string {
  const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n)) return "—";
  const usd = n / DIVISOR;
  const abs = Math.abs(usd);
  const sign = usd < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${usd.toFixed(2)}`;
}

function fmtPct(millionths: string): string {
  const n = Number(millionths);
  if (!Number.isFinite(n)) return "—";
  return `${(n / 10_000).toFixed(2)}%`;
}

function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

// ─── component ────────────────────────────────────────────────────────────

interface Props {
  slabAddress: string;
}

export const AdlLeaderboard: FC<Props> = ({ slabAddress }) => {
  const [data, setData] = useState<AdlRankingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchRankings = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/adl/rankings?slab=${encodeURIComponent(slabAddress)}`
      );
      if (!res.ok) {
        if (res.status === 404) {
          setError("Market not found");
          return;
        }
        throw new Error(`${res.status}`);
      }
      const json: AdlRankingsResponse = await res.json();
      setData(json);
      setError(null);
      setLastUpdated(new Date());
    } catch {
      setError("Failed to load ADL data");
    } finally {
      setLoading(false);
    }
  }, [slabAddress]);

  useEffect(() => {
    fetchRankings();
    const id = setInterval(fetchRankings, 30_000); // refresh every 30s
    return () => clearInterval(id);
  }, [fetchRankings]);

  // ── loading ──
  if (loading) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--text-dim)]" />
          <span className="text-[10px] text-[var(--text-dim)]">Loading ADL rankings…</span>
        </div>
      </div>
    );
  }

  // ── error ──
  if (error || !data) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">ADL Rankings</span>
        </div>
        <p className="mt-1.5 text-[10px] text-[var(--short)]">{error ?? "No data"}</p>
      </div>
    );
  }

  const {
    adlNeeded,
    capExceeded,
    utilizationTriggered,
    insuranceDepleted,
    insuranceUtilizationBps,
    pnlPosTot,
    maxPnlCap,
    excess,
    rankings,
  } = data;

  // Status badge
  const statusDot = adlNeeded ? "bg-[var(--short)]" : "bg-[var(--long)]";
  const statusText = adlNeeded ? "text-[var(--short)]" : "text-[var(--long)]";
  const statusLabel = adlNeeded ? "ACTIVE" : "INACTIVE";

  // Util bar color
  const utilBps = insuranceUtilizationBps;
  const utilBarColor =
    utilBps >= 8000 ? "bg-[var(--short)]"
    : utilBps >= 5000 ? "bg-[var(--warning)]"
    : "bg-[var(--long)]";

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      {/* ── Header ── */}
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            ADL Rankings
          </span>
          <InfoIcon tooltip="Auto-Deleverage leaderboard. Top profitable positions are candidates for forced reduction when insurance is depleted or PnL cap is exceeded." />
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${adlNeeded ? "animate-pulse" : ""} ${statusDot}`} />
          <span className={`text-[9px] font-bold uppercase tracking-[0.1em] ${statusText}`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* ── Trigger flags ── */}
      <div className="mb-2.5 grid grid-cols-3 gap-1.5">
        <TriggerBadge label="Cap Exceeded" active={capExceeded} tip="Total positive PnL exceeds the configured max PnL cap for this market." />
        <TriggerBadge label="Ins. Util" active={utilizationTriggered} tip="Insurance fund utilization exceeds the ADL trigger threshold (≥80%)." />
        <TriggerBadge label="Ins. Depleted" active={insuranceDepleted} tip="Insurance fund has been fully consumed." />
      </div>

      {/* ── Insurance utilization bar ── */}
      <div className="mb-2.5 rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-2">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-dim)]">
              Insurance Utilization
            </span>
            <InfoIcon tooltip="How much of the insurance fund has been consumed. ADL triggers at ≥80%." />
          </div>
          <span className={`text-[10px] font-bold font-mono ${utilBps >= 8000 ? "text-[var(--short)]" : utilBps >= 5000 ? "text-[var(--warning)]" : "text-[var(--long)]"}`}>
            {bpsToPercent(utilBps)}
          </span>
        </div>
        <div className="h-1 w-full rounded-full bg-[var(--border)]/40 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${utilBarColor}`}
            style={{ width: `${Math.min(utilBps / 100, 100)}%` }}
          />
        </div>
      </div>

      {/* ── PnL cap stats (only show when cap is set) ── */}
      {maxPnlCap !== "0" && (
        <div className="mb-2.5 grid grid-cols-2 gap-1.5 text-[9px]">
          <StatRow label="Total Long PnL" value={fmtUsd(pnlPosTot)} />
          <StatRow label="Max PnL Cap" value={fmtUsd(maxPnlCap)} />
          {capExceeded && (
            <StatRow
              label="Excess"
              value={fmtUsd(excess)}
              valueClass="text-[var(--short)]"
            />
          )}
        </div>
      )}

      {/* ── Rankings table ── */}
      {adlNeeded ? (
        rankings.length === 0 ? (
          <p className="text-[10px] text-[var(--text-dim)]">
            ADL triggered but no profitable positions to rank.
          </p>
        ) : (
          <>
            <div className="mb-1.5 flex items-center gap-1">
              <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-dim)]">
                Position Rankings
              </span>
              <InfoIcon tooltip="Positions ranked by PnL%. Rank #1 is deleveraged first. Highlighted rows are near-trigger." />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[9px] font-mono">
                <thead>
                  <tr className="border-b border-[var(--border)]/40">
                    <th className="pb-1 text-left font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)] pr-2">#</th>
                    <th className="pb-1 text-left font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)] pr-2">Slot</th>
                    <th className="pb-1 text-right font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)] pr-2">PnL%</th>
                    <th className="pb-1 text-right font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)] pr-2">Unr. PnL</th>
                    <th className="pb-1 text-right font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)]">Capital</th>
                  </tr>
                </thead>
                <tbody>
                  {rankings.slice(0, 20).map((pos) => {
                    // Highlight top 3 positions — they will be deleveraged first
                    const isTopRisk = pos.rank <= 3;
                    return (
                      <tr
                        key={pos.idx}
                        className={[
                          "border-b border-[var(--border)]/20 transition-colors",
                          isTopRisk
                            ? "bg-[var(--short)]/5 hover:bg-[var(--short)]/10"
                            : "hover:bg-[var(--bg-elevated)]",
                        ].join(" ")}
                      >
                        <td className="py-0.5 pr-2">
                          <span className={`font-bold ${isTopRisk ? "text-[var(--short)]" : "text-[var(--text-secondary)]"}`}>
                            {pos.rank}
                          </span>
                          {isTopRisk && (
                            <span className="ml-0.5 text-[var(--short)] text-[8px]">⚠</span>
                          )}
                        </td>
                        <td className="py-0.5 pr-2 text-[var(--text-dim)]">{pos.idx}</td>
                        <td className="py-0.5 pr-2 text-right font-bold text-[var(--long)]">
                          {fmtPct(pos.pnlPctMillionths)}
                        </td>
                        <td className="py-0.5 pr-2 text-right text-[var(--long)]">
                          {fmtUsd(pos.pnlAbs)}
                        </td>
                        <td className="py-0.5 text-right text-[var(--text-secondary)]">
                          {fmtUsd(pos.capital)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rankings.length > 20 && (
                <p className="mt-1 text-[9px] text-[var(--text-dim)] text-right">
                  +{rankings.length - 20} more positions
                </p>
              )}
            </div>
          </>
        )
      ) : (
        <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] px-3 py-2">
          <p className="text-[10px] text-[var(--text-dim)]">
            ADL is not active. No positions are at risk of auto-deleveraging.
          </p>
        </div>
      )}

      {/* ── Last updated ── */}
      {lastUpdated && (
        <p className="mt-2 text-right text-[8px] text-[var(--text-dim)]">
          Updated {lastUpdated.toLocaleTimeString()}
        </p>
      )}
    </div>
  );
};

// ─── sub-components ───────────────────────────────────────────────────────

function TriggerBadge({
  label,
  active,
  tip,
}: {
  label: string;
  active: boolean;
  tip: string;
}) {
  return (
    <div
      className={[
        "flex items-center gap-1 rounded-none border px-1.5 py-1",
        active
          ? "border-[var(--short)]/40 bg-[var(--short)]/5"
          : "border-[var(--border)]/30 bg-[var(--bg-elevated)]",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-1.5 w-1.5 rounded-full flex-shrink-0",
          active ? "bg-[var(--short)] animate-pulse" : "bg-[var(--border)]",
        ].join(" ")}
      />
      <span
        className={[
          "text-[8px] font-semibold uppercase tracking-[0.06em] leading-tight",
          active ? "text-[var(--short)]" : "text-[var(--text-dim)]",
        ].join(" ")}
      >
        {label}
      </span>
      <InfoIcon tooltip={tip} />
    </div>
  );
}

function StatRow({
  label,
  value,
  valueClass = "text-[var(--text)]",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[8px] uppercase tracking-[0.08em] text-[var(--text-dim)]">{label}</span>
      <span className={`font-mono text-[10px] font-bold ${valueClass}`}>{value}</span>
    </div>
  );
}
