"use client";

import { FC, useEffect, useState, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import gsap from "gsap";
import { type Network, getConfig, setNetwork } from "@/lib/config";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { NavDropdown, type NavItem } from "./NavDropdown";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

const ConnectButton = dynamic(
  () => import("@/components/wallet/ConnectButton").then((m) => m.ConnectButton),
  { ssr: false }
);

/* ── Navigation groups ── */
/** Pages hidden on mainnet beta — devnet-only faucets and internal pages */
const MAINNET_HIDDEN_PATHS = new Set([
  "/devnet-mint",
  "/faucet",
  "/openclaw",
  "/pitch",
]);

function filterForNetwork(items: NavItem[], network: string): NavItem[] {
  if (network !== "mainnet") return items;
  return items.filter((item) => !MAINNET_HIDDEN_PATHS.has(item.href));
}

/**
 * Waitlist-host nav filter.  When the page is served from
 * percolator.trade, hide trading-product surfaces (Trade group entirely;
 * /create, /devnet-mint, /stake from Build) and keep only the
 * dev/community-facing routes.  Trading lives at mainnet.percolatorlaunch.com.
 */
const WAITLIST_HOST_BUILD_KEEP = new Set(["/developers", "/guide"]);
function filterForWaitlistHost(items: NavItem[], group: "trade" | "build" | "community", isWaitlistHost: boolean): NavItem[] {
  if (!isWaitlistHost) return items;
  if (group === "trade") return [];
  if (group === "build") return items.filter((item) => WAITLIST_HOST_BUILD_KEEP.has(item.href));
  return items; // community: keep everything
}

const tradeLinks: NavItem[] = [
  { href: "/markets", label: "Markets" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/earn", label: "Earn" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/wallet", label: "Wallet" },
];

const buildLinks: NavItem[] = [
  { href: "/create", label: "Create a Market" },
  { href: "/developers", label: "Developers" },
  { href: "/guide", label: "Guide" },
  { href: "/devnet-mint", label: "Faucet" },
  { href: "/stake", label: "Stake" },
];

const communityLinks: NavItem[] = [
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/join", label: "Join Us" },
  { href: "/agents", label: "Agents" },
  { href: "/report-bug", label: "Report Bug" },
];

/* ── All links flat (for mobile) ── */
const mobileGroupsAll = [
  { label: "Trade", items: tradeLinks },
  { label: "Build", items: buildLinks },
  { label: "Community", items: communityLinks },
];

export const Header: FC = () => {
  const [network, setNet] = useState<Network>("mainnet");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [isWaitlistHost, setIsWaitlistHost] = useState(false);
  const pathname = usePathname();
  const prefersReduced = usePrefersReducedMotion();
  const headerRef = useRef<HTMLElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => { setNet(getConfig().network); }, []);

  // Detect waitlist host on mount; SSR can't see hostname so we hide the
  // Trade group only after hydration. This avoids a flash of trading nav
  // briefly visible to crawlers but acceptable for the waitlist UX.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const host = window.location.host.split(":")[0].toLowerCase();
    setIsWaitlistHost(host === "percolator.trade" || host === "www.percolator.trade");
  }, []);

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
        "sticky top-0 z-50 isolate transition-all duration-300",
        scrolled
          ? "border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-md shadow-sm shadow-black/20"
          : "border-b border-transparent bg-transparent",
      ].join(" ")}
    >
      <div className="flex h-14 w-full items-center justify-between gap-3 pl-2 pr-2 sm:px-4 lg:px-6">
        {/* Left */}
        <div className="flex min-w-0 flex-1 items-center gap-4 md:gap-6">
          <Link
            href="/"
            className="group flex min-h-10 shrink-0 items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            aria-label="Percolator Trade home"
          >
            <Image
              src="/images/logo-icon.png"
              alt=""
              width={28}
              height={28}
              className="shrink-0"
              priority
            />
            <span
              className="hidden text-[16px] font-extrabold uppercase leading-none tracking-wide text-[var(--text)] sm:inline"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Percolator Trade
            </span>
          </Link>

          {/* Desktop nav — dropdown groups */}
          <nav className="hidden items-center gap-0.5 md:flex" aria-label="Main navigation">
            {!isWaitlistHost && (
              <NavDropdown label="Trade" items={filterForWaitlistHost(filterForNetwork(tradeLinks, network), "trade", isWaitlistHost)} />
            )}
            <NavDropdown label="Build" items={filterForWaitlistHost(filterForNetwork(buildLinks, network), "build", isWaitlistHost)} />
            <NavDropdown label="Community" items={filterForWaitlistHost(filterForNetwork(communityLinks, network), "community", isWaitlistHost)} />
          </nav>
        </div>

        {/* Right */}
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-2.5">
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

          <ThemeToggle />
          <div className="h-4 w-px bg-[var(--border)]" />
          <ConnectButton />

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="flex h-10 w-10 items-center justify-center rounded-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--accent)]/[0.04] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] md:hidden"
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
          {mobileGroupsAll.map((g) => {
            const groupKey = g.label.toLowerCase() as "trade" | "build" | "community";
            return { ...g, items: filterForWaitlistHost(filterForNetwork(g.items, network), groupKey, isWaitlistHost) };
          }).filter((g) => g.items.length > 0).map((group) => (
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
                          : "text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-elevated)]",
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
              className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[var(--border-hover)] hover:text-[var(--text)] hover:bg-[var(--bg-elevated)]"
              title="GitHub"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
            <a
              href="https://x.com/PercolatorTrade"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[var(--border-hover)] hover:text-[var(--text)] hover:bg-[var(--bg-elevated)]"
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
            <a
              href="https://t.me/+fFHf5lGRAbk4OGEx"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] text-[var(--text-muted)] transition-all hover:border-[#229ED9]/40 hover:text-[#229ED9] hover:bg-[#229ED9]/[0.06]"
              title="Telegram"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12s5.374 12 12 12 12-5.373 12-12S18.626 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.022c.242-.213-.054-.334-.373-.121l-6.869 4.326-2.96-.924c-.64-.203-.658-.643.135-.953l11.566-4.458c.538-.196 1.006.128.832.941z" />
              </svg>
            </a>
          </div>
        </div>
      </nav>
    </header>
  );
};
