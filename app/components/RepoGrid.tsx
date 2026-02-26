"use client";

import { FC, useState, useMemo } from "react";
import { RepoCard } from "./RepoCard";
import type { RepoData, RepoCIStatus } from "@/lib/github";

type Filter = "All" | "TypeScript" | "Rust";

interface Props {
  repos: RepoData[];
  /** Whether live GitHub data was available */
  isLive: boolean;
  /** CI status per repo (keyed by repo name) */
  ciStatuses?: Record<string, RepoCIStatus>;
}

const filters: Filter[] = ["All", "TypeScript", "Rust"];

export const RepoGrid: FC<Props> = ({ repos, isLive, ciStatuses }) => {
  const [active, setActive] = useState<Filter>("All");

  const filtered = useMemo(() => {
    if (active === "All") return repos;
    return repos.filter((r) => r.language === active);
  }, [repos, active]);

  // Sort by stars descending
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => b.stargazers_count - a.stargazers_count),
    [filtered]
  );

  return (
    <section>
      {/* Filter pills */}
      <div className="flex gap-2 pb-6 pt-8">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setActive(f)}
            className={[
              "rounded-full border px-4 py-1.5 font-mono text-[13px] transition-all duration-150",
              active === f
                ? "border-[rgb(124,58,237)] bg-[rgba(124,58,237,0.35)] text-white font-semibold shadow-[0_0_12px_rgba(124,58,237,0.25)] ring-1 ring-[rgba(124,58,237,0.50)]"
                : "border-white/[0.08] bg-white/[0.04] text-[var(--text-secondary)] hover:border-white/[0.16] hover:text-[var(--text)]",
            ].join(" ")}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Live data note */}
      {!isLive && (
        <p className="mb-4 text-[12px] text-[var(--text-muted)]">
          Live stats temporarily unavailable
        </p>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 gap-3 sm:gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {sorted.map((repo) => (
          <RepoCard key={repo.name} repo={repo} ciStatus={ciStatuses?.[repo.name]} />
        ))}
      </div>
    </section>
  );
};
