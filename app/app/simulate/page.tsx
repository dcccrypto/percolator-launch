"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { UsdToggleProvider } from "@/components/providers/UsdToggleProvider";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { TradeForm } from "@/components/trade/TradeForm";
import { PositionPanel } from "@/components/trade/PositionPanel";
import { AccountsCard } from "@/components/trade/AccountsCard";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { SimulatorHeader } from "./components/SimulatorHeader";
import { SimRiskDashboard } from "./components/SimRiskDashboard";
import { SimLeaderboard } from "./components/SimLeaderboard";
import { ScenarioPanel } from "./components/ScenarioPanel";
import { SimExplainer } from "./components/SimExplainer";

// Lazy-load SimOnboarding (uses wallet hooks)
const SimOnboarding = dynamic(
  () => import("./components/SimOnboarding").then((m) => ({ default: m.SimOnboarding })),
  { ssr: false }
);

import simMarkets from "@/config/sim-markets.json";

/* ── Type helpers ────────────────────────────────────────── */
type MarketKey = keyof typeof simMarkets.markets;

interface MarketConfig {
  slab: string;
  name: string;
}

const MARKETS = simMarkets.markets as Record<string, MarketConfig>;

/* ── Tabs ────────────────────────────────────────────────── */
function Tabs({
  tabs,
  children,
  defaultTab = 0,
}: {
  tabs: string[];
  children: React.ReactNode[];
  defaultTab?: number;
}) {
  const [active, setActive] = useState(defaultTab);
  return (
    <div>
      <div className="flex border-b border-[var(--border)]/50">
        {tabs.map((label, i) => (
          <button
            key={label}
            onClick={() => setActive(i)}
            className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors border-b-2 ${
              active === i
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div>{children[active]}</div>
    </div>
  );
}

/* ── Inner page — inside SlabProvider context ────────────── */
function SimulatorInner({
  marketKey,
  slabAddress,
}: {
  marketKey: string;
  slabAddress: string;
}) {
  const { accounts, loading } = useSlabState();

  // Determine if user has traded (has any accounts with capital or position)
  const hasCapital = accounts.some(
    (a) => a.account.capital > 0n || a.account.positionSize !== 0n
  );
  const hasTraded = accounts.some((a) => a.account.positionSize !== 0n);

  // Empty slab (placeholder address) — show a friendly "not deployed" state
  const isEmpty = !slabAddress || slabAddress === "";

  if (isEmpty) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4">
        <div className="border border-[var(--border)] bg-[var(--bg-elevated)] p-6 text-center max-w-md">
          <div className="mb-3 text-3xl">🚧</div>
          <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">Sim Market Not Yet Deployed</h2>
          <p className="text-[11px] text-[var(--text-secondary)]">
            The simulated {marketKey} market hasn&apos;t been deployed to devnet yet.
            Check back soon — we&apos;re deploying them now!
          </p>
          <div className="mt-4 text-[10px] text-[var(--text-dim)]">
            Address: <span className="font-mono text-[var(--text-secondary)]">(pending)</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Onboarding wizard */}
      <SimOnboarding
        hasBalance={hasCapital}
        hasTraded={hasTraded}
        onDismiss={() => {}}
      />

      {/* ════════════════════════════════════════════════════════
          MOBILE LAYOUT  (< lg) — Single column
          ════════════════════════════════════════════════════════ */}
      <div className="flex flex-col gap-2 px-3 py-3 lg:hidden">
        {/* Trade form */}
        <ErrorBoundary label="TradeForm">
          <TradeForm slabAddress={slabAddress} />
        </ErrorBoundary>

        {/* Position */}
        <ErrorBoundary label="PositionPanel">
          <PositionPanel slabAddress={slabAddress} />
        </ErrorBoundary>

        {/* Tabs: Risk | Scenarios | Explainer | Account */}
        <Tabs tabs={["Risk", "Scenarios", "Insights", "Account"]}>
          <ErrorBoundary label="SimRiskDashboard">
            <div className="pt-2">
              <SimRiskDashboard slabAddress={slabAddress} />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="ScenarioPanel">
            <div className="pt-2">
              <ScenarioPanel />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="SimExplainer">
            <div className="pt-2">
              <SimExplainer />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="AccountsCard">
            <div className="pt-2">
              <AccountsCard />
              <div className="mt-2">
                <DepositWithdrawCard slabAddress={slabAddress} />
              </div>
            </div>
          </ErrorBoundary>
        </Tabs>

        {/* Leaderboard */}
        <ErrorBoundary label="SimLeaderboard">
          <SimLeaderboard marketKey={marketKey} />
        </ErrorBoundary>
      </div>

      {/* ════════════════════════════════════════════════════════
          DESKTOP LAYOUT  (≥ lg)
          Left: trade panel | Center: risk dashboard | Right col: scenarios + explainer
          Bottom: leaderboard
          ════════════════════════════════════════════════════════ */}
      <div className="hidden lg:block">
        {/* Three-column main area */}
        <div className="grid grid-cols-[340px_1fr_320px] gap-2 px-4 py-3">
          {/* ── Left: Trade panel ── */}
          <div className="space-y-2">
            {/* Trade form — sticky */}
            <div className="sticky top-0 z-20">
              <ErrorBoundary label="TradeForm">
                <TradeForm slabAddress={slabAddress} />
              </ErrorBoundary>
            </div>

            {/* Position + account tabs */}
            <Tabs tabs={["Position", "Account", "Deposit"]} defaultTab={hasCapital ? 0 : 2}>
              <ErrorBoundary label="PositionPanel">
                <PositionPanel slabAddress={slabAddress} />
              </ErrorBoundary>
              <ErrorBoundary label="AccountsCard">
                <AccountsCard />
              </ErrorBoundary>
              <ErrorBoundary label="DepositWithdrawCard">
                <DepositWithdrawCard slabAddress={slabAddress} />
              </ErrorBoundary>
            </Tabs>
          </div>

          {/* ── Center: Risk dashboard ── */}
          <div className="min-w-0">
            <ErrorBoundary label="SimRiskDashboard">
              <SimRiskDashboard slabAddress={slabAddress} />
            </ErrorBoundary>
          </div>

          {/* ── Right: Scenarios + Explainer ── */}
          <div className="space-y-2">
            <ErrorBoundary label="ScenarioPanel">
              <ScenarioPanel />
            </ErrorBoundary>
            <ErrorBoundary label="SimExplainer">
              <SimExplainer />
            </ErrorBoundary>
          </div>
        </div>

        {/* Bottom: Leaderboard */}
        <div className="px-4 pb-6">
          <ErrorBoundary label="SimLeaderboard">
            <SimLeaderboard marketKey={marketKey} />
          </ErrorBoundary>
        </div>
      </div>
    </>
  );
}

/* ── Market selector state ───────────────────────────────── */
function SimulatorWithMarket() {
  const [selectedMarket, setSelectedMarket] = useState<string>("SOL/USD");
  const [activeScenario, setActiveScenario] = useState<string | null>(null);

  const marketList = Object.entries(MARKETS).map(([key, cfg]) => ({
    key,
    name: cfg.name,
    slab: cfg.slab,
  }));

  const currentMarket = MARKETS[selectedMarket] ?? MARKETS["SOL/USD"];
  const slabAddress = currentMarket?.slab ?? "";

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SimulatorHeader
        markets={marketList.map((m) => ({ key: m.key, name: m.name }))}
        selectedMarket={selectedMarket}
        onMarketChange={setSelectedMarket}
        activeScenario={activeScenario}
      />

      {slabAddress ? (
        <SlabProvider slabAddress={slabAddress}>
          <UsdToggleProvider>
            <SimulatorInner marketKey={selectedMarket} slabAddress={slabAddress} />
          </UsdToggleProvider>
        </SlabProvider>
      ) : (
        <SimulatorInner marketKey={selectedMarket} slabAddress="" />
      )}
    </div>
  );
}

/* ── Page export ─────────────────────────────────────────── */
export default function SimulatePage() {
  return <SimulatorWithMarket />;
}
