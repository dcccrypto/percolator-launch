"use client";

import { FC, useEffect, useRef, useState } from "react";
import type { ContributorStats } from "@/lib/github";

interface Props {
  stats: ContributorStats | null;
}

/** Animated counter that counts from 0 to target value */
function AnimatedNumber({
  value,
  suffix,
  visible,
}: {
  value: number;
  suffix?: string;
  visible: boolean;
}) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!visible || value === 0) {
      setDisplay(0);
      return;
    }

    const duration = 800;
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // easeOut cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * value));
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    }

    requestAnimationFrame(animate);
  }, [value, visible]);

  if (value === 0 && !suffix) return <span>—</span>;

  const text = suffix
    ? `${display.toLocaleString()}${suffix}`
    : display.toLocaleString();

  return <span>{text}</span>;
}

const stats_config = [
  { key: "totalContributors" as const, label: "Contributors" },
  { key: "repoCount" as const, label: "Repos" },
  { key: "totalOpenIssues" as const, label: "Open Issues" },
  { key: "totalCommits" as const, label: "Total Commits" },
  {
    key: null,
    label: "Lines of Code",
    static: "50k+",
  },
  { key: "isActive" as const, label: "Build Status" },
];

export const ContributorStatsBar: FC<Props> = ({ stats }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="border-y border-white/[0.06] py-8 sm:py-8"
      style={{ background: "var(--bg-elevated, #1a1a28)" }}
    >
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-y-6 px-6 sm:grid-cols-3 xl:grid-cols-6">
        {stats_config.map((cfg, i) => {
          let valueNode: React.ReactNode;

          if (cfg.key === "isActive") {
            valueNode = stats ? (stats.isActive ? "Active" : "Quiet") : "—";
          } else if (cfg.static) {
            valueNode = cfg.static;
          } else if (cfg.key && stats) {
            const val = stats[cfg.key] as number;
            valueNode = <AnimatedNumber value={val} visible={visible} />;
          } else {
            valueNode = "—";
          }

          return (
            <div
              key={cfg.label}
              className={[
                "text-center",
                i < stats_config.length - 1
                  ? "border-r border-white/[0.06] xl:border-r"
                  : "",
                // Remove right border on last item of each responsive row
                i % 2 === 1 ? "border-r-0 sm:border-r" : "",
                i % 3 === 2 ? "sm:border-r-0 xl:border-r" : "",
                i === stats_config.length - 1 ? "!border-r-0" : "",
              ].join(" ")}
            >
              <div
                className="text-3xl font-bold text-[var(--text,#f0f0f5)] sm:text-4xl"
                style={{ fontFamily: "var(--font-display, 'Space Grotesk')" }}
              >
                {valueNode}
              </div>
              <div
                className="mt-1 text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted,rgba(255,255,255,0.30))]"
                style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')" }}
              >
                {cfg.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
