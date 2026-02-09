"use client";

import { FC, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import gsap from "gsap";
import { type Network, getConfig, setNetwork } from "@/lib/config";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

const navLinks = [
  { href: "/create", label: "Launch" },
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/my-markets", label: "Admin" },
];

export const Header: FC = () => {
  const [network, setNet] = useState<Network>("devnet");
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const headerRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setNet(getConfig().network); }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Entrance animation
  useEffect(() => {
    if (!headerRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(headerRef.current, { y: -20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" });
  }, []);

  return (
    <header
      ref={headerRef}
      className={[
        "sticky top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-white/[0.06] bg-[#06080d]/80 backdrop-blur-xl shadow-[0_4px_30px_rgba(0,0,0,0.3)]"
          : "border-b border-transparent bg-transparent",
      ].join(" ")}
    >
      {/* Animated gradient line at bottom */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#00FFB2]/20 to-transparent" />

      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
        {/* Left: Logo + Nav */}
        <div className="flex items-center gap-8">
          <Link href="/" className="group flex items-center gap-2.5 text-lg font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
            <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#00FFB2] to-[#00d4aa] text-sm font-black text-[#06080d] transition-all duration-300 group-hover:shadow-[0_0_20px_rgba(0,255,178,0.3)]">
              P
            </span>
            <span className="hidden sm:inline">Percolator</span>
          </Link>

          <nav className="relative hidden items-center gap-1 md:flex">
            {navLinks.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={[
                    "relative rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200",
                    active
                      ? "text-[#00FFB2] bg-[#00FFB2]/[0.08]"
                      : "text-[#8B95B0] hover:text-[#F0F4FF] hover:bg-white/[0.04]",
                  ].join(" ")}
                >
                  {link.label}
                </Link>
              );
            })}
            {network === "devnet" && (
              <Link
                href="/devnet-mint"
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-[#FFB800]/70 transition-all duration-200 hover:bg-[#FFB800]/[0.08] hover:text-[#FFB800]"
              >
                🏭 Faucet
              </Link>
            )}
          </nav>
        </div>

        {/* Right */}
        <div className="flex items-center gap-3">
          {/* Socials */}
          <a
            href="https://x.com/i/communities/1980346190404415886"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#8B95B0] transition-all duration-200 hover:bg-white/[0.04] hover:text-[#F0F4FF]"
            aria-label="X Community"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <a
            href="https://github.com/dcccrypto/percolator-launch"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#8B95B0] transition-all duration-200 hover:bg-white/[0.04] hover:text-[#F0F4FF]"
            aria-label="GitHub"
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>

          {/* Network */}
          <button
            onClick={() => setNetwork(network === "mainnet" ? "devnet" : "mainnet")}
            className={[
              "rounded-lg px-2.5 py-1 text-xs font-bold transition-all duration-200 border",
              network === "devnet"
                ? "bg-[#FFB800]/[0.08] text-[#FFB800] border-[#FFB800]/20 hover:bg-[#FFB800]/[0.12]"
                : "bg-[#00FFB2]/[0.08] text-[#00FFB2] border-[#00FFB2]/20 hover:bg-[#00FFB2]/[0.12]",
            ].join(" ")}
          >
            {network === "devnet" ? "Devnet" : "Mainnet"}
          </button>

          <div className="mx-1 h-6 w-px bg-white/[0.06]" />
          <WalletMultiButton />

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[#8B95B0] hover:bg-white/[0.04] md:hidden"
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
        <div className="border-t border-white/[0.06] bg-[#06080d]/95 backdrop-blur-xl md:hidden">
          <nav className="flex flex-col gap-1 p-4">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={[
                  "rounded-lg px-4 py-3 text-sm font-medium transition-all",
                  pathname === link.href ? "text-[#00FFB2] bg-[#00FFB2]/[0.08]" : "text-[#8B95B0] hover:text-white",
                ].join(" ")}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
};
