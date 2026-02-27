"use client";

import { FC } from "react";
import type { GoodFirstIssue } from "@/lib/github";

interface Props {
  contributorCount: number;
  goodFirstIssues: GoodFirstIssue[];
}

const STEPS = [
  {
    number: "01",
    title: "Fork & clone",
    description:
      "Fork dcccrypto/percolator-launch (or whichever repo). Clone locally. For Rust repos: rustup override set stable.",
    link: {
      label: "percolator-launch →",
      url: "https://github.com/dcccrypto/percolator-launch/fork",
    },
  },
  {
    number: "02",
    title: "Run it locally",
    description:
      "TypeScript: pnpm install && pnpm dev → localhost:3000. Rust/Anchor: anchor build && anchor test.",
    link: null,
  },
  {
    number: "03",
    title: "Pick an issue",
    description:
      'Browse "good first issue" labels or ask in #dev on Discord. Comment on the issue before starting work.',
    link: {
      label: "good first issues →",
      url: "https://github.com/dcccrypto/percolator-launch/labels/good%20first%20issue",
    },
  },
  {
    number: "04",
    title: "Open a PR",
    description:
      'PR title format: [scope]: brief description. Link the issue in PR body. CI runs automatically. Review within 48h.',
    link: null,
  },
];

export const HowToContribute: FC<Props> = ({
  contributorCount,
  goodFirstIssues,
}) => {
  return (
    <section className="mt-16">
      {/* Section header */}
      <div className="mb-10">
        <h2
          className="mb-2 text-3xl font-bold tracking-tight text-[#f0f0f5] sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          How to contribute
        </h2>
        <p className="text-base text-white/55">
          Join {contributorCount > 0 ? contributorCount : "our"} contributor
          {contributorCount !== 1 ? "s" : ""} building permissionless perps
        </p>
      </div>

      {/* Step cards — 2×2 grid */}
      <div className="mb-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {STEPS.map((step) => (
          <article
            key={step.number}
            className="group rounded-xl border border-white/[0.06] bg-[rgba(17,17,24,0.85)] p-7 transition-all duration-200 hover:border-[rgba(124,58,237,0.25)] hover:shadow-[0_0_20px_rgba(124,58,237,0.06)]"
          >
            <div
              className="mb-4 text-5xl font-bold text-[rgba(124,58,237,0.20)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {step.number}
            </div>
            <h3
              className="mb-2 text-lg font-semibold text-[#f0f0f5]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {step.title}
            </h3>
            <p
              className="mb-3 text-sm leading-relaxed text-white/55"
              style={{ fontFamily: "var(--font-body)" }}
            >
              {step.description}
            </p>
            {step.link && (
              <a
                href={step.link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#a78bfa] underline-offset-2 hover:underline"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {step.link.label}
              </a>
            )}
          </article>
        ))}
      </div>

      {/* Good First Issues — hidden when empty to avoid stale null state */}
      {goodFirstIssues.length > 0 && (
        <div className="mb-10">
          <h3
            className="mb-4 text-xs font-medium uppercase tracking-[0.15em] text-white/30"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Good first issues
          </h3>

          <div className="flex flex-wrap gap-3">
            {goodFirstIssues.map((issue) => (
              <a
                key={issue.html_url}
                href={issue.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 rounded-md border border-[rgba(124,58,237,0.20)] bg-[rgba(124,58,237,0.08)] px-3.5 py-2 transition-all duration-200 hover:border-[rgba(124,58,237,0.40)] hover:bg-[rgba(124,58,237,0.12)]"
              >
                <span
                  className="text-[11px] text-white/30"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {issue.repo}
                </span>
                <span className="text-white/30">·</span>
                <span className="text-[13px] text-[#f0f0f5]">
                  {issue.title}
                </span>
                <span className="text-white/30 transition-transform duration-200 group-hover:translate-x-0.5">
                  →
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Bottom CTA */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <a
          href="https://discord.gg/fJa4BDBxPN"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-[rgba(88,101,242,0.30)] bg-[rgba(88,101,242,0.12)] px-5 py-2.5 text-sm font-medium text-[#7984f5] transition-all duration-200 hover:bg-[rgba(88,101,242,0.20)]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          Discord server
        </a>
        <a
          href="https://github.com/dcccrypto/percolator-launch/discussions"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.15] bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-[var(--text)] transition-all duration-200 hover:bg-white/[0.08]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
          </svg>
          GitHub Discussions
        </a>
      </div>
    </section>
  );
};
