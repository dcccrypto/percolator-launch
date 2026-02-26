"use client";

import { FC } from "react";
import Link from "next/link";
import { RepoGrid } from "@/components/RepoGrid";
import { ContributorStatsBar } from "@/components/ContributorStatsBar";
import { CommitHeatmap } from "@/components/CommitHeatmap";
import { HowToContribute } from "@/components/HowToContribute";
import type {
  RepoData,
  ContributorStats,
  CommitActivityMap,
  GoodFirstIssue,
  RepoCIStatus,
} from "@/lib/github";

interface Props {
  repos: RepoData[];
  isLive: boolean;
  contributorStats: ContributorStats | null;
  commitActivity: CommitActivityMap | null;
  goodFirstIssues: GoodFirstIssue[];
  ciStatuses: Record<string, RepoCIStatus>;
}

export const DevelopersClient: FC<Props> = ({
  repos,
  isLive,
  contributorStats,
  commitActivity,
  goodFirstIssues,
  ciStatuses,
}) => {
  return (
    <div className="relative min-h-screen">
      {/* Ambient glow */}
      <div
        className="pointer-events-none fixed left-0 top-0 h-[600px] w-[600px] -translate-x-1/3 -translate-y-1/4"
        style={{
          background:
            "radial-gradient(circle, rgba(124,58,237,0.10) 0%, transparent 70%)",
        }}
      />

      <div className="mx-auto max-w-7xl px-6 py-10 sm:py-16">
        {/* Hero */}
        <header className="mb-12 max-w-2xl">
          <span className="mb-4 inline-block rounded-full border border-white/[0.10] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Open Source · Solana
          </span>

          <h1
            className="mb-2 text-4xl font-bold tracking-tight text-[var(--text)] sm:text-6xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Built in public.
          </h1>
          <h1
            className="mb-6 text-4xl font-bold tracking-tight text-[var(--text)] sm:text-6xl"
            style={{
              fontFamily: "var(--font-display)",
              textShadow: "0 0 40px rgba(124,58,237,0.4)",
            }}
          >
            Every line on-chain.
          </h1>

          <p className="mb-8 max-w-xl text-lg leading-relaxed text-[var(--text-secondary)]">
            Percolator is an open-source protocol. Browse the repos, fork the
            code, or contribute — everything that powers permissionless perps is
            here.
          </p>

          <a
            href="https://github.com/dcccrypto"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-white/[0.15] bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-[var(--text)] transition-all duration-200 hover:bg-white/[0.08]"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
            github.com/dcccrypto
          </a>
        </header>

        {/* ★ Contributor Stats Bar */}
        {contributorStats && (
          <ContributorStatsBar stats={contributorStats} />
        )}

        {/* Repo Grid (with CI statuses for health badges) */}
        <RepoGrid repos={repos} isLive={isLive} ciStatuses={ciStatuses} />

        {/* ★ Commit Activity Heatmap */}
        {commitActivity && Object.keys(commitActivity).length > 0 && (
          <CommitHeatmap commitActivity={commitActivity} />
        )}

        {/* ★ How to Contribute (replaces old CTA strip) */}
        <HowToContribute
          contributorCount={contributorStats?.totalContributors ?? 0}
          goodFirstIssues={goodFirstIssues}
        />
      </div>
    </div>
  );
};
