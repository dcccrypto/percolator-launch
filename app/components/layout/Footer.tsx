"use client";

import { FC, useState } from "react";
import Link from "next/link";

const CA = "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";

export const Footer: FC = () => {
  const [copied, setCopied] = useState(false);

  const copyCA = () => {
    navigator.clipboard.writeText(CA);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <footer className="relative border-t border-[var(--border)]">
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Main footer row */}
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          {/* Left - brand */}
          <div className="flex items-center gap-3">
            <img
              src="/images/logo.png"
              alt="Percolator"
              className="h-4 w-auto"
            />
            <span className="text-[var(--text-dim)]">/</span>
            <span className="text-[11px] text-[var(--text-muted)]">perpetual futures engine</span>
          </div>

          {/* Center - links */}
          <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-5 text-[11px] text-[var(--text-muted)]">
            <button
              onClick={copyCA}
              className="group flex items-center gap-1.5 transition-colors hover:text-[var(--text-secondary)]"
            >
              <span className="font-mono text-[10px]">
                {CA.slice(0, 6)}...{CA.slice(-4)}
              </span>
              <span className="text-[9px] uppercase tracking-wider opacity-60 group-hover:opacity-100">
                {copied ? "copied" : "copy"}
              </span>
            </button>
            <span className="h-3 w-px bg-[var(--border)]" />
            <a
              href="https://github.com/dcccrypto/percolator-launch"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[var(--border-hover)] hover:text-white hover:bg-white/[0.04]"
              title="GitHub"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
            <a
              href="https://x.com/Percolator_ct"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[var(--border-hover)] hover:text-white hover:bg-white/[0.04]"
              title="X / Twitter"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="https://discord.gg/fJa4BDBxPN"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[#5865F2]/40 hover:text-[#5865F2] hover:bg-[#5865F2]/[0.06]"
              title="Discord"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </a>
            <span className="h-3 w-px bg-[var(--border)]" />
            <Link
              href="/report-bug"
              className="flex items-center gap-1 transition-colors hover:text-[var(--accent)]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              report&nbsp;bug
            </Link>
          </div>

          {/* Right - powered by */}
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-dim)]">
            <span>powered by</span>
            <span className="font-semibold text-[var(--text-muted)]">solana</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
