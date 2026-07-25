"use client";

import { useEffect, useState } from "react";
import { EarnVaultView } from "@/components/earn/EarnVaultView";
import StakePage from "@/app/stake/page";

/**
 * Earn hub. Consolidates the LP Vault and Stake surfaces behind one tab bar.
 * Each source view is a "use client" default-export/named-export that takes no
 * props, so it renders directly as tab content. Only the ACTIVE tab is mounted
 * — inactive tabs' data hooks never run — and each source view brings its own
 * container (the stake page keeps its own min-h-screen wrapper), so the tab
 * bar sits above them with no extra max-width/padding wrapper.
 */
const TABS = [
  { key: "vault", label: "LP Vault" },
  { key: "stake", label: "Stake" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTabKey(value: string): value is TabKey {
  return TABS.some((t) => t.key === value);
}

export default function EarnHubPage() {
  const [tab, setTab] = useState<TabKey>("vault");

  useEffect(() => {
    document.title = "Earn | Percolator";
  }, []);

  // Deep-link the initial tab from the hash on mount (client-only, no
  // next/navigation Suspense requirement). Default is the first tab.
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

      {tab === "vault" && <EarnVaultView />}
      {tab === "stake" && <StakePage />}
    </div>
  );
}
