"use client";

import { FC } from "react";
import Link from "next/link";

const CA = "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";

export const Footer: FC = () => {
  return (
    <footer className="border-t border-[#1a1d2a] bg-[#080a0f]">
      <div className="mx-auto max-w-[1800px] px-4 py-8">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          {/* Left */}
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-sm font-bold text-white">
              <div className="relative flex h-5 w-5 items-center justify-center">
                <div className="absolute inset-0 rounded bg-[#00d4aa] opacity-20 blur-sm" />
                <span className="relative text-[10px] font-black text-[#00d4aa]">⬡</span>
              </div>
              Percolator
            </Link>
            <span className="text-[11px] text-[#2a2f40]">Permissionless perps on Solana</span>
          </div>

          {/* Center links */}
          <div className="flex items-center gap-4 text-[11px]">
            <Link href="/launch" className="text-[#4a5068] transition-colors hover:text-white">Launch</Link>
            <Link href="/markets" className="text-[#4a5068] transition-colors hover:text-white">Markets</Link>
            <a href="https://x.com/i/communities/1980346190404415886" target="_blank" rel="noopener noreferrer" className="text-[#4a5068] transition-colors hover:text-white">X Community</a>
            <a href="https://github.com/dcccrypto/percolator-launch" target="_blank" rel="noopener noreferrer" className="text-[#4a5068] transition-colors hover:text-white">GitHub</a>
            <a href={`https://solscan.io/token/${CA}`} target="_blank" rel="noopener noreferrer" className="text-[#4a5068] transition-colors hover:text-white">Solscan</a>
          </div>

          {/* Right: CA */}
          <div className="data-cell text-[10px] text-[#1a1d2a]">{CA}</div>
        </div>
      </div>
    </footer>
  );
};
