"use client";

import { FC, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import gsap from "gsap";
import { type Network, getConfig, setNetwork } from "@/lib/config";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { NavDropdown, type NavItem } from "./NavDropdown";

const ConnectButton = dynamic(
  () => import("@/components/wallet/ConnectButton").then((m) => m.ConnectButton),
  { ssr: false }
);

/* ── Navigation groups ── */
const tradeLinks: NavItem[] = [
  { href: "/markets", label: "Markets" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/wallet", label: "Wallet" },
];

const buildLinks: NavItem[] = [
  { href: "/create", label: "Create a Market" },
  { href: "/developers", label: "Developers" },
  { href: "/guide", label: "Guide" },
  { href: "/devnet-mint", label: "Faucet" },
];

const communityLinks: NavItem[] = [
  { href: "/join", label: "Join Us" },
  { href: "/agents", label: "Agents" },
  { href: "/report-bug", label: "Report Bug" },
];

/* ── All links flat (for mobile) ── */
const mobileGroups = [
  { label: "Trade", items: tradeLinks },
  { label: "Build", items: buildLinks },
  { label: "Community", items: communityLinks },
];

export const Header: FC = () => {
  const [network, setNet] = useState<Network>("devnet");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const prefersReduced = usePrefersReducedMotion();
  const headerRef = useRef<HTMLElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => { setNet(getConfig().network); }, []);

  // Scroll detection
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Mobile menu animation
  useEffect(() => {
    const menu = mobileMenuRef.current;
    if (!menu) return;

    if (prefersReduced) {
      // Skip animation but still toggle visibility for reduced-motion users
      menu.style.display = mobileOpen ? "block" : "none";
      menu.style.height = mobileOpen ? "auto" : "0px";
      menu.style.opacity = mobileOpen ? "1" : "0";
      return;
    }

    if (mobileOpen) {
      menu.style.display = "block";
      gsap.fromTo(
        menu,
        { height: 0, opacity: 0 },
        { height: "auto", opacity: 1, duration: 0.3, ease: "power2.out" }
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

  // Close mobile on route change
  useEffect(() => {
    setMobileOpen(false);
    setMobileExpanded(null);
  }, [pathname]);

  const toggleMobileGroup = (label: string) => {
    setMobileExpanded(mobileExpanded === label ? null : label);
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
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="group flex items-center gap-2"
            aria-label="Percolator home"
          >
            <img
              src="/images/logo.png"
              alt="Percolator logo"
              className="h-4 w-auto"
            />
          </Link>

          {/* Desktop nav — dropdown groups */}
          <nav className="hidden items-center gap-0.5 md:flex" aria-label="Main navigation">
            <NavDropdown label="Trade" items={tradeLinks} />
            <NavDropdown label="Build" items={buildLinks} />
            <NavDropdown label="Community" items={communityLinks} />
          </nav>
        </div>

        {/* Right */}
        <div className="flex items-center gap-2.5">
          {/* DEVNET badge — non-interactive pill */}
          {network === "devnet" && (
            <span
              ref={badgeRef}
              title="You are on devnet — no real funds"
              className="inline-flex items-center gap-1 rounded-full border border-[#fbbf24]/35 bg-[#fbbf24]/[0.12] px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-[#fbbf24] cursor-default pointer-events-none select-none"
            >
              devnet
            </span>
          )}

          <div className="h-4 w-px bg-[var(--border)]" />
          <ConnectButton />

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.04] transition-colors md:hidden"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
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

      {/* Mobile nav — accordion groups */}
      <nav
        ref={mobileMenuRef}
        className="overflow-hidden border-t border-[var(--border)] bg-[var(--bg)] md:hidden"
        style={{ display: "none", height: 0 }}
        aria-label="Mobile navigation"
      >
        <div className="flex flex-col gap-0.5 p-3">
          {mobileGroups.map((group) => (
            <div key={group.label}>
              {/* Group header — accordion trigger */}
              <button
                onClick={() => toggleMobileGroup(group.label)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-[13px] font-bold uppercase tracking-wider text-[#9ca3af]"
                aria-expanded={mobileExpanded === group.label}
              >
                {group.label}
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  className={[
                    "transition-transform duration-150",
                    mobileExpanded === group.label ? "rotate-180" : "",
                  ].join(" ")}
                >
                  <path
                    d="M2.5 3.75L5 6.25L7.5 3.75"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {/* Group items */}
              {mobileExpanded === group.label && (
                <div className="ml-3 flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={[
                        "px-3 py-2 text-[13px] font-medium rounded-sm transition-all",
                        pathname === item.href
                          ? "text-[#22d3ee] bg-[rgba(34,211,238,0.08)]"
                          : "text-[#d1d5db] hover:text-white hover:bg-white/[0.06]",
                      ].join(" ")}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Social links */}
          <div className="mt-1 flex items-center gap-2 border-t border-[var(--border)] px-3 pt-3">
            <a
              href="https://github.com/dcccrypto/percolator-launch"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[var(--border-hover)] hover:text-white hover:bg-white/[0.04]"
              title="GitHub"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
            <a
              href="https://x.com/Percolator_ct"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[var(--border-hover)] hover:text-white hover:bg-white/[0.04]"
              title="X / Twitter"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              href="https://discord.gg/fJa4BDBxPN"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[#5865F2]/40 hover:text-[#5865F2] hover:bg-[#5865F2]/[0.06]"
              title="Discord"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </a>
          </div>
        </div>
      </nav>
    </header>
  );
};
