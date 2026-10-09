"use client";

import { useEffect } from "react";
import { useHashTab } from "@/hooks/useHashTab";
import { EarnVaultView } from "@/components/earn/EarnVaultView";
import StakePage from "@/app/stake/page";
import MyMarketsPage from "@/app/my-markets/page";
import {
  EARN_TABS,
  DEFAULT_EARN_TAB,
  isEarnTabKey,
} from "@/components/earn/earnTabs";

/**
 * Earn hub. Consolidates the LP Vault, Stake and My Markets surfaces behind one
 * tab bar — the three ways to earn on the platform (provide liquidity, stake,
 * or collect creator fees on a market you launched).
 * Each source view is a "use client" default-export/named-export that takes no
 * props, so it renders directly as tab content. Only the ACTIVE tab is mounted
 * — inactive tabs' data hooks never run — and each source view brings its own
 * container (the stake page keeps its own min-h-screen wrapper), so the tab
 * bar sits above them with no extra max-width/padding wrapper.
 */
export default function EarnHubPage() {
  const [tab, selectTab] = useHashTab(isEarnTabKey, DEFAULT_EARN_TAB);

  useEffect(() => {
    document.title = "Earn | Percolator";
  }, []);

  return (
    <div>
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-[1400px] items-stretch overflow-x-auto px-4 lg:px-6 scrollbar-none">
          {EARN_TABS.map((t) => {
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

      {tab === "vault" && <EarnVaultView />}
      {tab === "stake" && <StakePage />}
      {tab === "markets" && <MyMarketsPage />}
    </div>
  );
}
