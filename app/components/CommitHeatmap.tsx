"use client";

import { FC, useCallback, useEffect, useMemo, useState } from "react";
import type { CommitActivityMap, WeekActivity } from "@/lib/github";
import { REPOS } from "@/lib/github";

/** Return the number of heatmap weeks that fit the current viewport */
function useResponsiveWeeks(): number {
  const calc = useCallback(() => {
    if (typeof window === "undefined") return 53;
    const w = window.innerWidth;
    // 13px cell + 3px gap = 16px per week, plus 30px day-label column + 48px container padding
    const available = w - 30 - 48;
    const fit = Math.floor(available / 16);
    return Math.max(8, Math.min(fit, 53));
  }, []);

  const [weeks, setWeeks] = useState(53); // SSR-safe default

  useEffect(() => {
    setWeeks(calc());
    const onResize = () => setWeeks(calc());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [calc]);

  return weeks;
}

interface Props {
  commitActivity: CommitActivityMap | null;
}

/** Short display names for repo pills */
const REPO_SHORT: Record<string, string> = {
  "percolator-launch": "launch",
  percolator: "percolator",
  "percolator-prog": "prog",
  "percolator-matcher": "matcher",
  "percolator-stake": "stake",
  "percolator-sdk": "sdk",
  "percolator-ops": "ops",
  "percolator-mobile": "mobile",
};

const LEVEL_COLORS = [
  "rgba(255,255,255,0.05)", // 0 commits
  "rgba(124,58,237,0.25)", // 1–2
  "rgba(124,58,237,0.45)", // 3–5
  "rgba(124,58,237,0.70)", // 6–10
  "#a78bfa", // 11+
];

function commitLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 10) return 3;
  return 4;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

export const CommitHeatmap: FC<Props> = ({ commitActivity }) => {
  const [selectedRepo, setSelectedRepo] = useState<string>("all");

  /** Aggregate commit data based on selected repo filter */
  const weekData: WeekActivity[] = useMemo(() => {
    if (!commitActivity) return [];

    if (selectedRepo === "all") {
      // Sum across all repos
      const weekMap = new Map<number, WeekActivity>();
      Object.values(commitActivity).forEach((weeks) => {
        weeks.forEach((w) => {
          const existing = weekMap.get(w.week);
          if (existing) {
            existing.total += w.total;
            w.days.forEach((d, i) => {
              existing.days[i] += d;
            });
          } else {
            weekMap.set(w.week, {
              week: w.week,
              total: w.total,
              days: [...w.days],
            });
          }
        });
      });
      return Array.from(weekMap.values()).sort((a, b) => a.week - b.week);
    }

    return commitActivity[selectedRepo] || [];
  }, [commitActivity, selectedRepo]);

  /** Determine how many weeks to show (responsive to viewport) */
  const visibleCount = useResponsiveWeeks();
  const weeks = weekData.slice(-visibleCount);

  /** Month labels aligned to weeks */
  const monthLabels = useMemo(() => {
    const labels: { label: string; col: number }[] = [];
    let lastMonth = -1;
    weeks.forEach((w, i) => {
      const date = new Date(w.week * 1000);
      const month = date.getMonth();
      if (month !== lastMonth) {
        labels.push({ label: MONTHS[month], col: i });
        lastMonth = month;
      }
    });
    return labels;
  }, [weeks]);

  if (!commitActivity) {
    // Loading skeleton
    return (
      <div className="mx-auto my-12 max-w-7xl px-6">
        <div
          className="rounded-xl border border-white/[0.06] p-5 sm:p-8"
          style={{ background: "var(--bg-panel, rgba(17,17,24,0.85))" }}
        >
          <div className="mb-4 h-6 w-64 animate-pulse rounded bg-white/[0.06]" />
          <div className="grid grid-flow-col auto-cols-[13px] gap-[3px] max-sm:max-w-full max-sm:overflow-hidden">
            {Array.from({ length: 53 }).map((_, col) => (
              <div key={col} className="flex flex-col gap-[3px]">
                {Array.from({ length: 7 }).map((_, row) => (
                  <div
                    key={row}
                    className="h-[13px] w-[13px] animate-pulse rounded-[3px]"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      animationDelay: `${(col * 7 + row) * 5}ms`,
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto my-12 max-w-7xl px-6">
      <div
        className="rounded-xl border border-white/[0.06] p-5 sm:p-8"
        style={{ background: "var(--bg-panel, rgba(17,17,24,0.85))" }}
      >
        {/* Header */}
        <div className="mb-1">
          <h2
            className="text-xl font-semibold text-[var(--text,#f0f0f5)]"
            style={{ fontFamily: "var(--font-display, 'Space Grotesk')" }}
          >
            Commit Activity
          </h2>
          <p
            className="mt-1 text-xs text-[var(--text-muted,rgba(255,255,255,0.30))]"
            style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')" }}
          >
            All commits across public repos · last{" "}
            {visibleCount >= 52 ? "52 weeks" : `${visibleCount} weeks`}
          </p>
        </div>

        {/* Repo selector pills */}
        <div className="mt-4 mb-5 flex flex-wrap gap-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:scrollbar-none max-sm:-mx-5 max-sm:px-5">
          <button
            onClick={() => setSelectedRepo("all")}
            className={[
              "shrink-0 rounded-full border px-3 py-1 text-[12px] whitespace-nowrap transition-all duration-150",
              selectedRepo === "all"
                ? "border-[rgb(124,58,237)] bg-[rgba(124,58,237,0.35)] text-[var(--text)] font-semibold shadow-[0_0_12px_rgba(124,58,237,0.25)]"
                : "border-white/[0.08] bg-white/[0.04] text-[var(--text-secondary)] hover:border-white/[0.16]",
            ].join(" ")}
            style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')" }}
          >
            All Repos
          </button>
          {REPOS.map((repo) => (
            <button
              key={repo}
              onClick={() => setSelectedRepo(repo)}
              className={[
                "shrink-0 rounded-full border px-3 py-1 text-[12px] whitespace-nowrap transition-all duration-150",
                selectedRepo === repo
                  ? "border-[rgb(124,58,237)] bg-[rgba(124,58,237,0.35)] text-[var(--text)] font-semibold shadow-[0_0_12px_rgba(124,58,237,0.25)]"
                  : "border-white/[0.08] bg-white/[0.04] text-[var(--text-secondary)] hover:border-white/[0.16]",
              ].join(" ")}
              style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')" }}
            >
              {REPO_SHORT[repo] || repo}
            </button>
          ))}
        </div>

        {/* Heatmap grid */}
        <div className="overflow-x-auto">
          <div className="inline-block">
            {/* Month labels row */}
            <div className="flex mb-1 ml-[30px]">
              {monthLabels.map(({ label, col }, i) => {
                const nextCol =
                  i < monthLabels.length - 1
                    ? monthLabels[i + 1].col
                    : weeks.length;
                const width = (nextCol - col) * 16; // 13px cell + 3px gap
                return (
                  <div
                    key={`${label}-${col}`}
                    className="text-[10px] text-[var(--text-muted,rgba(255,255,255,0.30))]"
                    style={{
                      fontFamily: "var(--font-mono, 'JetBrains Mono')",
                      width: `${width}px`,
                      minWidth: `${width}px`,
                    }}
                  >
                    {label}
                  </div>
                );
              })}
            </div>

            {/* Grid: day labels + cells */}
            <div className="flex gap-0">
              {/* Day labels column */}
              <div className="flex flex-col gap-[3px] mr-[6px] w-[24px]">
                {DAY_LABELS.map((label, i) => (
                  <div
                    key={i}
                    className="h-[13px] flex items-center text-[10px] text-[var(--text-muted,rgba(255,255,255,0.30))]"
                    style={{
                      fontFamily: "var(--font-mono, 'JetBrains Mono')",
                    }}
                  >
                    {label}
                  </div>
                ))}
              </div>

              {/* Week columns */}
              <div className="flex gap-[3px]">
                {weeks.map((week, colIdx) => (
                  <div key={week.week} className="flex flex-col gap-[3px]">
                    {week.days.map((count, dayIdx) => {
                      const date = new Date(
                        (week.week + dayIdx * 86400) * 1000
                      );
                      const dateStr = date.toLocaleDateString("en-US", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      });
                      const level = commitLevel(count);
                      return (
                        <div
                          key={dayIdx}
                          className="h-[13px] w-[13px] rounded-[3px] transition-colors"
                          style={{ background: LEVEL_COLORS[level] }}
                          title={`${count} commit${count !== 1 ? "s" : ""} — ${dateStr}`}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Legend */}
            <div className="mt-3 flex items-center justify-end gap-1">
              <span
                className="mr-1 text-[10px] text-[var(--text-muted,rgba(255,255,255,0.30))]"
                style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')" }}
              >
                Less
              </span>
              {LEVEL_COLORS.map((color, i) => (
                <div
                  key={i}
                  className="h-[13px] w-[13px] rounded-[3px]"
                  style={{ background: color }}
                />
              ))}
              <span
                className="ml-1 text-[10px] text-[var(--text-muted,rgba(255,255,255,0.30))]"
                style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')" }}
              >
                More
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
