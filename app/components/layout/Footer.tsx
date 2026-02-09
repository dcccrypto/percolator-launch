"use client";

import { FC } from "react";
import Link from "next/link";

const CA = "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";

export const Footer: FC = () => {
  return (
    <footer className="relative border-t border-white/[0.04] bg-[#06080d]">
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#00FFB2]/10 to-transparent" />

      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="flex flex-col items-center justify-between gap-8 sm:flex-row">
          {/* Left */}
          <div className="flex items-center gap-4">
            <Link href="/" className="group flex items-center gap-2 text-sm font-bold text-white transition-all">
              <div className="relative flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-[#00FFB2] to-[#00d4aa] transition-all group-hover:shadow-[0_0_15px_rgba(0,255,178,0.3)]">
                <span className="text-[9px] font-black text-[#06080d]">P</span>
              </div>
              Percolator
            </Link>
            <span className="text-[11px] text-[#3D4563]">Permissionless perps on Solana</span>
          </div>

          {/* Center links */}
          <div className="flex items-center gap-6 text-[12px]">
            {[
              { href: "/create", label: "Launch", ext: false },
              { href: "/markets", label: "Markets", ext: false },
              { href: "https://x.com/i/communities/1980346190404415886", label: "X Community", ext: true },
              { href: "https://github.com/dcccrypto/percolator-launch", label: "GitHub", ext: true },
              { href: `https://solscan.io/token/${CA}`, label: "Solscan", ext: true },
            ].map((link) =>
              link.ext ? (
                <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="text-[#3D4563] transition-all duration-200 hover:text-[#00FFB2]">
                  {link.label}
                </a>
              ) : (
                <Link key={link.label} href={link.href} className="text-[#3D4563] transition-all duration-200 hover:text-[#00FFB2]">
                  {link.label}
                </Link>
              )
            )}
          </div>

          {/* Right: CA */}
          <div className="font-[var(--font-jetbrains-mono)] text-[10px] text-[#1a2040] select-all">{CA}</div>
        </div>
      </div>
    </footer>
  );
};
