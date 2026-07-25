"use client";

import { useEffect, useState } from "react";
import DashboardPage from "@/app/dashboard/page";
import WalletPage from "@/app/wallet/page";
import MyMarketsPage from "@/app/my-markets/page";
import { PortfolioPositionsView } from "@/components/portfolio/PortfolioPositionsView";

/**
 * Portfolio hub. Consolidates the four account surfaces (Overview / Positions
 * / Wallet / My Markets) behind one tab bar. Each source page is a "use
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
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTabKey(value: string): value is TabKey {
  return TABS.some((t) => t.key === value);
}

export default function PortfolioHubPage() {
  const [tab, setTab] = useState<TabKey>("overview");

  useEffect(() => {
    document.title = "Portfolio | Percolator";
  }, []);

  // Deep-link the initial tab from the hash on mount. Done in an effect (not
  // during render) so SSR/hydration never touch `window`, and without
  // next/navigation's useSearchParams — which would force this page into a
  // Suspense boundary.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (isTabKey(hash)) setTab(hash);
  }, []);

  const selectTab = (key: TabKey) => {
    setTab(key);
    history.replaceState(null, "", "#" + key);
  };

  return (
    <div>
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-[1400px] items-stretch overflow-x-auto px-4 lg:px-6 scrollbar-none">
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <button
                key={t.key}
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
      {tab === "positions" && <PortfolioPositionsView />}
      {tab === "wallet" && <WalletPage />}
      {tab === "markets" && <MyMarketsPage />}
    </div>
  );
}
