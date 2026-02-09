"use client";

import { FC, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { type Network, getConfig } from "@/lib/config";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

const navLinks = [
  { href: "/markets", label: "Markets" },
  { href: "/create", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/my-markets", label: "Admin" },
];

export const Header: FC = () => {
  const [network, setNet] = useState<Network>("devnet");
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => { setNet(getConfig().network); }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-[#1a1a1f] bg-[#09090b]">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        {/* Left */}
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="text-base font-bold text-white"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            percolator
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navLinks.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={[
                    "px-3 py-1.5 text-sm transition-colors",
                    active ? "text-[#00FFB2]" : "text-[#71717a] hover:text-[#fafafa]",
                  ].join(" ")}
                >
                  {link.label}
                </Link>
              );
            })}
            {network === "devnet" && (
              <Link
                href="/devnet-mint"
                className="px-3 py-1.5 text-sm text-[#FFB800]/70 transition-colors hover:text-[#FFB800]"
              >
                Faucet
              </Link>
            )}
          </nav>
        </div>

        {/* Right */}
        <div className="flex items-center gap-3">
          {network === "devnet" && (
            <span className="rounded-[4px] px-2.5 py-1 text-xs font-bold border bg-transparent text-[#FFB800] border-[#FFB800]/20 select-none">
              devnet
            </span>
          )}

          <div className="h-5 w-px bg-[#1a1a1f]" />
          <WalletMultiButton />

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="flex h-9 w-9 items-center justify-center text-[#71717a] hover:text-[#fafafa] md:hidden"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {mobileOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile nav */}
      {mobileOpen && (
        <div className="border-t border-[#1a1a1f] bg-[#09090b] md:hidden">
          <nav className="flex flex-col gap-1 p-4">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={[
                  "px-4 py-3 text-sm transition-colors",
                  pathname === link.href ? "text-[#00FFB2]" : "text-[#71717a] hover:text-[#fafafa]",
                ].join(" ")}
              >
                {link.label}
              </Link>
            ))}
            {network === "devnet" && (
              <Link
                href="/devnet-mint"
                onClick={() => setMobileOpen(false)}
                className="px-4 py-3 text-sm text-[#FFB800]/70 transition-colors hover:text-[#FFB800]"
              >
                Faucet
              </Link>
            )}
          </nav>
        </div>
      )}
    </header>
  );
};
