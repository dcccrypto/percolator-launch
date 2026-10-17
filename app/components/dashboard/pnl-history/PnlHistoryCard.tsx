"use client";

import { useState } from "react";

/** Presentation contract only. A future verified history adapter supplies records. */
export type PnlHistoryDay =
  | { kind: "activity"; realizedPnlUsd: number }
  | { kind: "no-activity" };

type SummaryKey = "today" | "days7" | "days30" | "ytd" | "lifetime";
export type PnlHistoryViewModel =
  | { kind: "unavailable" }
  | {
      kind: "records";
      source: "verified" | "demo";
      summary: Readonly<Record<SummaryKey, number | null>>;
      /** ISO UTC day keys. Missing day = unknown, never inferred as no activity. */
      days: Readonly<Record<string, PnlHistoryDay>>;
    };

type HistoryRange = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
type HistoryRecords = Extract<PnlHistoryViewModel, { kind: "records" }>;

type PeriodResult = {
  total: number | null;
  knownDays: number;
  totalDays: number;
  hasActivity: boolean;
};

const SUMMARY: { key: SummaryKey; label: string }[] = [
  { key: "today", label: "Today PnL" },
  { key: "days7", label: "7D PnL" },
  { key: "days30", label: "30D PnL" },
  { key: "ytd", label: "YTD PnL" },
  { key: "lifetime", label: "Lifetime PnL" },
];
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const RANGES: readonly HistoryRange[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];

function usd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pnlColor(value: number): string {
  if (value > 0) return "text-[var(--long)]";
  if (value < 0) return "text-[var(--short)]";
  return "text-[var(--text-secondary)]";
}

/** Preserve today's UTC day unless an explicit preview month is supplied. */
function initialCursor(initialMonth?: string): Date {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(initialMonth ?? "");
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function addDays(date: Date, delta: number): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + delta);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monday(date: Date): Date {
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(date, -offset);
}

function formatUtc(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
}

/** Unknown or non-finite day values invalidate the total, rather than silently becoming zero. */
function aggregate(records: HistoryRecords | null, start: Date, end: Date): PeriodResult {
  let knownDays = 0;
  let totalDays = 0;
  let total = 0;
  let hasActivity = false;
  for (let day = start; day.getTime() <= end.getTime(); day = addDays(day, 1)) {
    totalDays++;
    const value = records?.days[isoDay(day)];
    if (!value || (value.kind === "activity" && !Number.isFinite(value.realizedPnlUsd))) continue;
    knownDays++;
    if (value.kind === "activity") {
      hasActivity = true;
      total += value.realizedPnlUsd;
    }
  }
  return {
    total: records && knownDays === totalDays && Number.isFinite(total) ? total : null,
    knownDays,
    totalDays,
    hasActivity,
  };
}

function periodValue(result: PeriodResult): string {
  if (result.total === null) return "—";
  if (!result.hasActivity) return "·";
  return usd(result.total);
}

function valueClass(result: PeriodResult): string {
  return result.total === null || !result.hasActivity
    ? "text-[var(--text-secondary)]"
    : pnlColor(result.total);
}

/**
 * Isolated calendar UI: no wallet hooks, fetch, RPC, mock-mode dependency,
 * price calculations, or writes to existing Portfolio state.
 * Demo records are ignored in production builds even if passed by a caller.
 */
export function PnlHistoryCard({
  data = { kind: "unavailable" },
  initialMonth,
}: {
  data?: PnlHistoryViewModel;
  /** YYYY-MM, for deterministic previews/tests; displayed dates are UTC. */
  initialMonth?: string;
}) {
  const [cursor, setCursor] = useState(() => initialCursor(initialMonth));
  const [range, setRange] = useState<HistoryRange>("MONTHLY");
  const records =
    data.kind === "records" &&
    (data.source === "verified" || process.env.NODE_ENV !== "production")
      ? data
      : null;
  const demo = records?.source === "demo";

  const year = cursor.getUTCFullYear();
  const monthIndex = cursor.getUTCMonth();
  const monthStart = utcDate(year, monthIndex, 1);
  const monthEnd = utcDate(year, monthIndex + 1, 0);
  const startOffset = (monthStart.getUTCDay() + 6) % 7;
  const cellCount = Math.ceil((startOffset + monthEnd.getUTCDate()) / 7) * 7;
  const monthLabel = formatUtc(monthStart, { month: "long", year: "numeric" });
  const weekStart = monday(cursor);
  const weekEnd = addDays(weekStart, 6);
  const dayLabel = formatUtc(cursor, { month: "long", day: "numeric", year: "numeric" });
  const weekLabel = `${formatUtc(weekStart, { month: "short", day: "numeric", year: "numeric" })} – ${formatUtc(weekEnd, { month: "short", day: "numeric", year: "numeric" })}`;
  const periodLabel = range === "DAILY" ? dayLabel : range === "WEEKLY" ? weekLabel : range === "YEARLY" ? String(year) : monthLabel;
  const period = range === "DAILY" ? "day" : range === "WEEKLY" ? "week" : range === "MONTHLY" ? "month" : "year";

  function movePeriod(delta: number) {
    setCursor((previous) => {
      const y = previous.getUTCFullYear();
      const m = previous.getUTCMonth();
      if (range === "DAILY") return addDays(previous, delta);
      if (range === "WEEKLY") return addDays(previous, 7 * delta);
      if (range === "MONTHLY") return utcDate(y, m + delta, 1);
      return utcDate(y + delta, m, 1);
    });
  }

  function dayCell(date: Date, inMonth: boolean) {
    const key = isoDay(date);
    const day = inMonth ? records?.days[key] : undefined;
    const value = day?.kind === "activity" && Number.isFinite(day.realizedPnlUsd)
      ? day.realizedPnlUsd
      : null;
    const background = value != null && value > 0
      ? "bg-[var(--long)]/10"
      : value != null && value < 0
        ? "bg-[var(--short)]/10"
        : "bg-[var(--panel-bg)]";
    return (
      <button
        key={key}
        type="button"
        data-testid={`pnl-day-${key}`}
        disabled={!inMonth}
        onClick={() => { setCursor(date); setRange("DAILY"); }}
        aria-label={`View ${formatUtc(date, { month: "long", day: "numeric", year: "numeric" })} PnL`}
        className={`min-w-0 p-2 text-left ${background} ${inMonth ? "hover:outline hover:outline-1 hover:outline-[var(--accent)]" : "opacity-35"}`}
      >
        <div className="text-[10px] text-[var(--text-secondary)]">{date.getUTCDate()}</div>
        <div className={`mt-2 truncate text-[10px] font-semibold tabular-nums ${value == null ? "text-[var(--text-secondary)]" : pnlColor(value)}`}>
          {!inMonth || !day ? "—" : day.kind === "no-activity" ? "·" : usd(value)}
        </div>
      </button>
    );
  }

  return (
    <section aria-label="PnL History" className="min-w-0 border border-[var(--border)] bg-[var(--panel-bg)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">PnL History</h2>
          <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
            {demo ? "DEMO DATA — not wallet performance" : "Historical realized PnL · UTC"}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap gap-1 text-[10px]" aria-label="History ranges">
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              aria-pressed={range === option}
              className={`rounded-sm border border-[var(--border)] px-2 py-1.5 ${range === option ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]"}`}
            >
              {option}
            </button>
          ))}
        </div>
      </header>

      {demo && (
        <p role="note" className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--warning)]">
          Preview only. Values are fabricated and must not be used for trading decisions.
        </p>
      )}
      {!records && (
        <p role="status" className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-secondary)]">
          History unavailable — no verified historical PnL source connected.
        </p>
      )}

      <div className="grid grid-cols-2 gap-px border-b border-[var(--border)] bg-[var(--border)] sm:grid-cols-5">
        {SUMMARY.map(({ key, label }) => {
          const value = records?.summary[key] ?? null;
          return (
            <div key={key} className={`min-w-0 bg-[var(--panel-bg)] p-3 ${key === "lifetime" ? "col-span-2 sm:col-span-1" : ""}`}>
              <div className="text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">{label}</div>
              <div className={`mt-1 truncate text-xs font-bold tabular-nums sm:text-sm ${value == null ? "text-[var(--text-secondary)]" : pnlColor(value)}`}>
                {usd(value)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" aria-label={`Previous ${period}`} onClick={() => movePeriod(-1)} className="border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)]">‹</button>
          <h3 className="min-w-0 text-xs font-semibold uppercase text-[var(--text)]">{periodLabel}</h3>
          <button type="button" aria-label={`Next ${period}`} onClick={() => movePeriod(1)} className="border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)]">›</button>
        </div>
        <span className="text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">{range[0] + range.slice(1).toLowerCase()} · UTC</span>
      </div>

      {range === "DAILY" && (() => {
        const result = aggregate(records, cursor, cursor);
        return (
          <div className="p-4" aria-label="Daily PnL detail">
            <p className="text-xs text-[var(--text-secondary)]">Realized PnL · {dayLabel}</p>
            <div className={`mt-2 text-xl font-bold tabular-nums ${valueClass(result)}`}>{periodValue(result)}</div>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              {result.total === null ? "Unavailable — no verified day record." : result.hasActivity ? "Confirmed activity" : "Confirmed no activity"}
            </p>
          </div>
        );
      })()}

      {range === "WEEKLY" && (() => {
        const result = aggregate(records, weekStart, weekEnd);
        return (
          <div aria-label="Weekly PnL detail">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <p className="text-xs text-[var(--text-secondary)]">Week total · {result.knownDays}/{result.totalDays} verified days</p>
              <div className={`mt-1 text-lg font-bold tabular-nums ${valueClass(result)}`}>{periodValue(result)}</div>
              {result.total === null && <p className="mt-1 text-xs text-[var(--text-secondary)]">Incomplete period — total unavailable.</p>}
            </div>
            <div className="grid grid-cols-1 gap-px bg-[var(--border)] sm:grid-cols-7">
              {Array.from({ length: 7 }, (_, index) => {
                const date = addDays(weekStart, index);
                const resultDay = aggregate(records, date, date);
                return (
                  <div key={isoDay(date)} data-testid={`pnl-week-day-${isoDay(date)}`} className="min-w-0 bg-[var(--panel-bg)] p-3">
                    <p className="text-[10px] text-[var(--text-secondary)]">{WEEKDAYS[index]} · {formatUtc(date, { month: "short", day: "numeric" })}</p>
                    <p className={`mt-2 text-xs font-semibold tabular-nums ${valueClass(resultDay)}`}>{periodValue(resultDay)}</p>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {range === "MONTHLY" && (
        <div>
          <p className="px-3 py-2 text-[10px] text-[var(--text-secondary)] sm:hidden">Swipe horizontally to view the calendar.</p>
          <div className="overflow-x-auto" aria-label="Monthly calendar scroll area">
            <div className="min-w-[560px] sm:min-w-0">
              <div className="grid grid-cols-7 border-b border-[var(--border)]">
                {WEEKDAYS.map((day) => (
                  <div key={day} className="min-w-0 py-2 text-center text-[9px] text-[var(--text-secondary)]">{day}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-px bg-[var(--border)]" aria-label={`${monthLabel} calendar`}>
                {Array.from({ length: cellCount }, (_, index) => {
                  const date = utcDate(year, monthIndex, 1 + index - startOffset);
                  return dayCell(date, date.getUTCMonth() === monthIndex && date.getUTCFullYear() === year);
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {range === "YEARLY" && (
        <div className="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-4" aria-label={`${year} yearly calendar`}>
          {Array.from({ length: 12 }, (_, index) => {
            const first = utcDate(year, index, 1);
            const last = utcDate(year, index + 1, 0);
            const result = aggregate(records, first, last);
            return (
              <button
                type="button"
                key={index}
                data-testid={`pnl-year-month-${year}-${String(index + 1).padStart(2, "0")}`}
                onClick={() => { setCursor(first); setRange("MONTHLY"); }}
                aria-label={`View ${formatUtc(first, { month: "long", year: "numeric" })} calendar`}
                className="min-w-0 bg-[var(--panel-bg)] p-3 text-left hover:outline hover:outline-1 hover:outline-[var(--accent)]"
              >
                <p className="text-[10px] uppercase text-[var(--text-secondary)]">{formatUtc(first, { month: "long" })}</p>
                <p className={`mt-2 text-sm font-semibold tabular-nums ${valueClass(result)}`}>{periodValue(result)}</p>
                <p className="mt-2 text-[10px] text-[var(--text-secondary)]">{result.knownDays}/{result.totalDays} verified days</p>
              </button>
            );
          })}
        </div>
      )}

      <footer className="px-3 py-2 text-[9px] text-[var(--text-secondary)]">
        Green: profit · Red: loss · Dot: confirmed no activity · —: unavailable
      </footer>
    </section>
  );
}
