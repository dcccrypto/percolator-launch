"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useHashTab } from "@/hooks/useHashTab";
import DashboardPage from "@/app/dashboard/page";
import { prefetchOnIdle } from "@/lib/prefetch-on-idle";

// Only the default tab (Overview) is in this page's first-load bundle. The other tabs are split
// out (the Wallet tab alone imports the whole Privy SDK) and warmed at idle, so switching to
// one is still instant; a deep link (/portfolio#wallet) loads its tab straight away.
const loadPositions = () => import("@/components/portfolio/PortfolioPositionsView");
const loadRetired = () => import("@/components/portfolio/RetiredHoldings");
const loadWallet = () => import("@/app/wallet/page");
const loadMyMarkets = () => import("@/app/my-markets/page");
const loadReferrals = () => import("@/components/portfolio/ReferralsTab");
const tabLoading = () => <div className="min-h-[60vh]" aria-busy="true" />;
const PortfolioPositionsView = dynamic(() => loadPositions().then((m) => m.PortfolioPositionsView), { ssr: false, loading: tabLoading });
const RetiredHoldings = dynamic(() => loadRetired().then((m) => m.RetiredHoldings), { ssr: false });
// D2 gate: positions reduced without the trader's order (v2.2 only; renders nothing with the flag off).
const ReduceEventsPanel = dynamic(() => import("@/components/portfolio/ReduceEventsPanel").then((m) => m.ReduceEventsPanel), { ssr: false });
const WalletPage = dynamic(loadWallet, { ssr: false, loading: tabLoading });
const MyMarketsPage = dynamic(loadMyMarkets, { ssr: false, loading: tabLoading });
const ReferralsTab = dynamic(loadReferrals, { ssr: false, loading: tabLoading });

/**
 * Portfolio hub. Consolidates the account surfaces (Overview / Positions
 * / Wallet / My Markets / Referrals) behind one tab bar. Each source page is a "use
 * client" default-export that takes no props, so it renders directly as tab
 * content. Only the ACTIVE tab is mounted — inactive tabs' data hooks never
 * run — and each source page brings its own container, so the tab bar sits
 * above them with no extra max-width/padding wrapper (avoids double nesting).
 */
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "positions", label: "Positions" },
  { key: "wallet", label: "Wallet" },
  { key: "markets", label: "My Markets" },
  { key: "referrals", label: "Referrals" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTabKey(value: string): value is TabKey {
  return TABS.some((t) => t.key === value);
}

export default function PortfolioHubPage() {
  const [tab, selectTab] = useHashTab(isTabKey, "overview");

  useEffect(() => {
    document.title = "Portfolio | Percolator";
  }, []);

  // The tab bar scrolls sideways on phones with its scrollbar hidden; keep the active tab in view (a deep
  // link to /portfolio#referrals would otherwise land on a tab the user cannot see).
  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-portfolio-tab="${tab}"]`)?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [tab]);

  useEffect(() => prefetchOnIdle([loadPositions, loadRetired, loadWallet, loadMyMarkets, loadReferrals]), []);

  return (
    <div>
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-[1400px] items-stretch overflow-x-auto px-4 lg:px-6 scrollbar-none">
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <button
                key={t.key}
                data-portfolio-tab={t.key}
                type="button"
                onClick={() => selectTab(t.key)}
                aria-current={on ? "page" : undefined}
                className={[
                  "shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.12em] transition-colors duration-150",
                  on
                    ? "border-[var(--accent)] text-[var(--accent-text)]"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "overview" && <DashboardPage />}
      {tab === "positions" && (
        <>
          <PortfolioPositionsView />
          {/* Funds in RETIRED (blocklisted) markets — the filtered portfolio
              universe above cannot show them by design; this section is the
              audit fix that keeps them visible to their owners. */}
          <RetiredHoldings />
          <ReduceEventsPanel />
        </>
      )}
      {tab === "wallet" && <WalletPage />}
      {tab === "markets" && <MyMarketsPage />}
      {tab === "referrals" && <ReferralsTab />}
    </div>
  );
}
