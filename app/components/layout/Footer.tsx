"use client";

import { FC, useState } from "react";

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
            <span className="text-[13px] font-bold uppercase tracking-[0.15em] text-[var(--text)]">
              percolator
            </span>
            <span className="text-[var(--text-dim)]">/</span>
            <span className="text-[11px] text-[var(--text-muted)]">perpetual futures engine</span>
          </div>

          {/* Center - links */}
          <div className="flex items-center gap-5 text-[11px] text-[var(--text-muted)]">
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
              className="transition-colors hover:text-[var(--text-secondary)]"
            >
              github
            </a>
            <span className="h-3 w-px bg-[var(--border)]" />
            <a
              href="https://x.com/Percolator_ct"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[var(--text-secondary)]"
            >
              x.com
            </a>
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
