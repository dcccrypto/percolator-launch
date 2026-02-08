"use client";

import { FC, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { type Network, getConfig, setNetwork } from "@/lib/config";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

export const Header: FC = () => {
  const [network, setNet] = useState<Network>("mainnet");
  useEffect(() => { setNet(getConfig().network); }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-[#1e2433]/50 bg-[#0a0b0f]/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
        {/* Left: Logo + Nav */}
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 text-lg font-extrabold text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-sm font-black text-white">
              P
            </span>
            Percolator
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            <Link
              href="/launch"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-[#1e2433] hover:text-white"
            >
              Launch
            </Link>
            <Link
              href="/markets"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-[#1e2433] hover:text-white"
            >
              Markets
            </Link>
            <Link
              href="/portfolio"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-[#1e2433] hover:text-white"
            >
              Portfolio
            </Link>
            <Link
              href="/my-markets"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-[#1e2433] hover:text-white"
            >
              My Markets
            </Link>
            <Link
              href="/create"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-emerald-400/70 transition-colors hover:bg-[#1e2433] hover:text-emerald-300"
            >
              ✨ Create
            </Link>
            <Link
              href="/devnet-mint"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-yellow-400/70 transition-colors hover:bg-[#1e2433] hover:text-yellow-300"
            >
              🏭 Devnet Mint
            </Link>
          </nav>
        </div>

        {/* Right: Socials + Wallet */}
        <div className="flex items-center gap-3">
          {/* X Community */}
          <a
            href="https://x.com/i/communities/1980346190404415886"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-[#1e2433] hover:text-white"
            aria-label="X Community"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          {/* GitHub */}
          <a
            href="https://github.com/dcccrypto/percolator-launch"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-[#1e2433] hover:text-white"
            aria-label="GitHub"
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
          {/* Network toggle */}
          <button
            onClick={() => setNetwork(network === "mainnet" ? "devnet" : "mainnet")}
            className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors ${
              network === "devnet"
                ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
                : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
            }`}
          >
            {network === "devnet" ? "Devnet" : "Mainnet"}
          </button>
          <div className="mx-1 h-6 w-px bg-[#1e2433]" />
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
};
