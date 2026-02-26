"use client";

import { FC } from "react";
import { RepoLanguageBadge } from "./RepoLanguageBadge";
import { RepoHealthBadges } from "./RepoHealthBadges";
import { timeAgo, REPO_DESCRIPTIONS, type RepoData, type RepoCIStatus } from "@/lib/github";

/** Client-side fallback — mirrors REPO_DESCRIPTIONS for resilience */
const FALLBACK_DESCRIPTIONS: Record<string, string> = REPO_DESCRIPTIONS;

interface Props {
  repo: RepoData;
  ciStatus?: RepoCIStatus;
}

export const RepoCard: FC<Props> = ({ repo, ciStatus }) => {
  return (
    <a
      href={repo.html_url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col rounded-xl border border-white/[0.12] bg-[rgba(17,17,24,0.85)] p-5 sm:p-6 backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-[rgba(124,58,237,0.40)] hover:shadow-[0_0_24px_rgba(124,58,237,0.12)]"
    >
      {/* Row 1: Language + Stars */}
      <div className="mb-4 flex items-center justify-between">
        <RepoLanguageBadge language={repo.language} />
        <span className="flex items-center gap-1 font-mono text-[12px] text-[var(--text-muted)]">
          <svg
            className="h-3.5 w-3.5"
            fill="currentColor"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
          </svg>
          {repo.stargazers_count ?? 0}
        </span>
      </div>

      {/* Repo name */}
      <h3
        className="mb-2 text-lg font-semibold text-[var(--text)]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {repo.name}
      </h3>

      {/* Description */}
      <p className="mb-4 line-clamp-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        {repo.description && repo.description.trim()
          ? repo.description
          : FALLBACK_DESCRIPTIONS[repo.name] || (
              <span className="text-[var(--text-muted)]">No description</span>
            )}
      </p>

      {/* Health badges */}
      <RepoHealthBadges
        license={repo.license}
        pushedAt={repo.pushed_at || repo.updated_at}
        ciStatus={ciStatus}
      />

      {/* Divider */}
      <div className="mb-4 border-t border-white/[0.06]" />

      {/* Meta row */}
      <div className="mt-auto flex items-center justify-between">
        <div className="flex items-center gap-3 font-mono text-[11px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 16 16">
              <path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75v-.878a2.25 2.25 0 111.5 0v.878a2.25 2.25 0 01-2.25 2.25h-1.5v2.128a2.251 2.251 0 11-1.5 0V8.5h-1.5A2.25 2.25 0 013.5 6.25v-.878a2.25 2.25 0 111.5 0zM5 3.25a.75.75 0 10-1.5 0 .75.75 0 001.5 0zm6.75.75a.75.75 0 100-1.5.75.75 0 000 1.5zM8 12.75a.75.75 0 10-1.5 0 .75.75 0 001.5 0z" />
            </svg>
            {repo.forks_count}
          </span>
          <span>·</span>
          <span className="flex items-center gap-1">
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
              <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
            </svg>
            {repo.open_issues_count}
          </span>
          {timeAgo(repo.updated_at) && (
            <>
              <span>·</span>
              <span>Updated {timeAgo(repo.updated_at)}</span>
            </>
          )}
        </div>
        <span className="text-[var(--text-muted)] transition-colors group-hover:text-[rgb(124,58,237)]">
          →
        </span>
      </div>
    </a>
  );
};
