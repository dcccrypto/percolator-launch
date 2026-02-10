"use client";

import { FC, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import gsap from "gsap";
import { type Network, getConfig, setNetwork } from "@/lib/config";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

const navLinks = [
  { href: "/markets", label: "Markets" },
  { href: "/create", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/my-markets", label: "Admin" },
  { href: "/guide", label: "Guide" },
  { href: "/agents", label: "Agents" },
];

export const Header: FC = () => {
  const [network, setNet] = useState<Network>("devnet");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const prefersReduced = usePrefersReducedMotion();
  const headerRef = useRef<HTMLElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setNet(getConfig().network); }, []);

  // Scroll detection
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Mobile menu animation
  useEffect(() => {
    const menu = mobileMenuRef.current;
    if (!menu || prefersReduced) return;

    if (mobileOpen) {
      menu.style.display = "block";
      gsap.fromTo(
        menu,
        { height: 0, opacity: 0 },
        { height: "auto", opacity: 1, duration: 0.3, ease: "power2.out" }
      );
      const links = menu.querySelectorAll("a");
      gsap.fromTo(
        links,
        { opacity: 0, x: -12 },
        { opacity: 1, x: 0, duration: 0.25, stagger: 0.04, delay: 0.1, ease: "power2.out" }
      );
    } else {
      gsap.to(menu, {
        height: 0,
        opacity: 0,
        duration: 0.2,
        ease: "power2.in",
        onComplete: () => { menu.style.display = "none"; },
      });
    }
  }, [mobileOpen, prefersReduced]);

  // Network badge pulse
  const handleNetworkSwitch = () => {
    setNetwork(network === "mainnet" ? "devnet" : "mainnet");
    if (badgeRef.current && !prefersReduced) {
      gsap.fromTo(badgeRef.current, { scale: 1.15 }, { scale: 1, duration: 0.4, ease: "elastic.out(1, 0.5)" });
    }
  };

  return (
    <header
      ref={headerRef}
      className={[
        "sticky top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-[var(--border)] bg-[var(--bg)]"
          : "border-b border-transparent bg-transparent",
      ].join(" ")}
    >
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5">
        {/* Left */}
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="group flex items-center gap-2"
          >
            <img
              src="/images/logo.png"
              alt="Percolator"
              className="h-4 w-auto"
            />
          </Link>

          <nav className="hidden items-center gap-0.5 md:flex">
            {navLinks.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={[
                    "relative px-3 py-1.5 text-[13px] font-medium rounded-sm transition-all duration-200",
                    active
                      ? "text-[var(--accent)] bg-[var(--accent)]/10"
                      : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.04]",
                  ].join(" ")}
                >
                  {link.label}
                </Link>
              );
            })}
            {network === "devnet" && (
              <Link
                href="/devnet-mint"
                className="px-3 py-1.5 text-[13px] font-medium text-[var(--warning)]/60 transition-colors hover:text-[var(--warning)]"
              >
                Faucet
              </Link>
            )}
          </nav>
        </div>

        {/* Right */}
        <div className="flex items-center gap-2.5">
          <button
            ref={badgeRef}
            onClick={handleNetworkSwitch}
            className={[
              "rounded-sm px-2 py-1 text-[11px] font-semibold uppercase tracking-wider border transition-all duration-200",
              network === "devnet"
                ? "text-[var(--warning)]/80 border-[var(--warning)]/15 hover:border-[var(--warning)]/30 bg-[var(--warning)]/[0.04]"
                : "text-[var(--accent)]/80 border-[var(--accent)]/15 hover:border-[var(--accent)]/30 bg-[var(--accent)]/[0.04]",
            ].join(" ")}
          >
            {network}
          </button>

          <div className="h-4 w-px bg-[var(--border)]" />
          <WalletMultiButton />

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.04] transition-colors md:hidden"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
      <div
        ref={mobileMenuRef}
        className="overflow-hidden border-t border-[var(--border)] bg-[var(--bg)] md:hidden"
        style={{ display: "none", height: 0 }}
      >
        <nav className="flex flex-col gap-0.5 p-3">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className={[
                "px-3 py-2.5 text-[13px] font-medium rounded-sm transition-all",
                pathname === link.href
                  ? "text-[var(--accent)] bg-[var(--accent)]/10"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.04]",
              ].join(" ")}
            >
              {link.label}
            </Link>
          ))}
          {network === "devnet" && (
            <Link
              href="/devnet-mint"
              onClick={() => setMobileOpen(false)}
              className="px-3 py-2.5 text-[13px] font-medium text-[var(--warning)]/60 hover:text-[var(--warning)]"
            >
              Faucet
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
};
