"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { UsdToggleProvider } from "@/components/providers/UsdToggleProvider";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { TradeForm } from "@/components/trade/TradeForm";
import { PositionPanel } from "@/components/trade/PositionPanel";
import { AccountsCard } from "@/components/trade/AccountsCard";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { TradingChart } from "@/components/trade/TradingChart";
import { TradeHistory } from "@/components/trade/TradeHistory";
import { MarketStatsCard } from "@/components/trade/MarketStatsCard";
import { MarketBookCard } from "@/components/trade/MarketBookCard";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { FundingRateCard } from "@/components/trade/FundingRateCard";
import { LiquidationAnalytics } from "@/components/trade/LiquidationAnalytics";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { SystemCapitalCard } from "@/components/trade/SystemCapitalCard";
import { InsuranceLPPanel } from "@/components/trade/InsuranceLPPanel";
import { SimulatorHeader } from "./components/SimulatorHeader";
import { SimulatorHero } from "./components/SimulatorHero";
import { SimLeaderboard } from "./components/SimLeaderboard";
import { ScenarioPanel } from "./components/ScenarioPanel";
import { SimExplainer } from "./components/SimExplainer";
import { EventFeed } from "./components/EventFeed";
import { RiskConceptCards } from "./components/RiskConceptCards";
import { GuidedWalkthrough, TourHelpButton } from "./components/GuidedWalkthrough";

// Lazy-load SimOnboarding (uses wallet hooks)
const SimOnboarding = dynamic(
  () =>
    import("./components/SimOnboarding").then((m) => ({
      default: m.SimOnboarding,
    })),
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
      <div className="flex border-b border-[var(--border)]/50 bg-transparent">
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

/* ── Collapsible ─────────────────────────────────────────── */
function Collapsible({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <span>{title}</span>
        <span
          className={`text-[9px] text-[var(--text-dim)] transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>
      <div className={open ? "block" : "hidden"}>{children}</div>
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
  const { connected } = useWallet();

  const hasCapital = accounts.some(
    (a) => a.account.capital > 0n || a.account.positionSize !== 0n
  );
  const hasTraded = accounts.some((a) => a.account.positionSize !== 0n);
  const defaultLeftTab = hasCapital ? 0 : 2;

  // Show hero when wallet not connected and no capital
  const showHero = !connected && !hasCapital;

  // Empty slab (placeholder address)
  const isEmpty = !slabAddress || slabAddress === "";

  if (isEmpty) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4">
        <div className="border border-[var(--border)] bg-[var(--bg-elevated)] p-6 text-center max-w-md">
          <div className="mb-3 text-3xl">🚧</div>
          <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">
            Sim Market Not Yet Deployed
          </h2>
          <p className="text-[11px] text-[var(--text-secondary)]">
            The simulated {marketKey} market hasn&apos;t been deployed to devnet
            yet. Check back soon!
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Hero — only before user engages */}
      {showHero && <SimulatorHero />}

      {/* Onboarding wizard */}
      <SimOnboarding
        hasBalance={hasCapital}
        hasTraded={hasTraded}
        onDismiss={() => {}}
      />

      {/* Guided walkthrough overlay */}
      <GuidedWalkthrough autoStart={!hasCapital && connected} />

      {/* ════════════════════════════════════════════════════════
          MOBILE LAYOUT  (< lg) — Single column trading terminal
          ════════════════════════════════════════════════════════ */}
      <div className="flex flex-col gap-1.5 px-2 pt-2 pb-4 lg:hidden min-w-0 w-full">
        {/* Chart — the star of the show */}
        <ErrorBoundary label="TradingChart">
          <div className="w-full overflow-hidden" data-tour="price-chart">
            <TradingChart slabAddress={slabAddress} />
          </div>
        </ErrorBoundary>

        {/* Trade form */}
        <ErrorBoundary label="TradeForm">
          <div data-tour="trade-form">
            <TradeForm slabAddress={slabAddress} />
          </div>
        </ErrorBoundary>

        {/* Position — collapsible */}
        <ErrorBoundary label="PositionPanel">
          <Collapsible title="Position" defaultOpen={true}>
            <PositionPanel slabAddress={slabAddress} />
          </Collapsible>
        </ErrorBoundary>

        {/* Deposit / Withdraw — collapsible */}
        <ErrorBoundary label="DepositWithdrawCard">
          <Collapsible
            title="Deposit / Withdraw"
            defaultOpen={!hasCapital}
          >
            <div data-tour="deposit-card">
              <DepositWithdrawCard slabAddress={slabAddress} />
            </div>
          </Collapsible>
        </ErrorBoundary>

        {/* Tabs: Stats | Trades | Risk | Scenarios | Book */}
        <Tabs
          tabs={["Stats", "Trades", "Risk", "Scenarios", "Book"]}
        >
          <ErrorBoundary label="MarketStatsCard">
            <MarketStatsCard />
          </ErrorBoundary>
          <ErrorBoundary label="TradeHistory">
            <TradeHistory slabAddress={slabAddress} />
          </ErrorBoundary>
          <ErrorBoundary label="RiskDashboard">
            <div className="space-y-2 pt-2" data-tour="risk-dashboard">
              <EngineHealthCard />
              <FundingRateCard slabAddress={slabAddress} />
              <div className="grid grid-cols-2 gap-1.5">
                <CrankHealthCard />
                <SystemCapitalCard />
              </div>
              <LiquidationAnalytics />
              <InsuranceLPPanel />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="Scenarios">
            <div className="space-y-2 pt-2" data-tour="scenario-panel">
              <ScenarioPanel />
              <SimExplainer />
              <RiskConceptCards />
              <EventFeed />
            </div>
          </ErrorBoundary>
          <ErrorBoundary label="MarketBookCard">
            <MarketBookCard />
          </ErrorBoundary>
        </Tabs>

        {/* Account details — collapsible */}
        <ErrorBoundary label="AccountsCard">
          <Collapsible title="Positions & Liqs" defaultOpen={false}>
            <AccountsCard />
          </Collapsible>
        </ErrorBoundary>

        {/* Leaderboard */}
        <ErrorBoundary label="SimLeaderboard">
          <SimLeaderboard marketKey={marketKey} />
        </ErrorBoundary>
      </div>

      {/* ════════════════════════════════════════════════════════
          DESKTOP LAYOUT  (≥ lg)
          3-col: Left trade panel | Center chart+data | Right scenarios
          ════════════════════════════════════════════════════════ */}
      <div className="hidden lg:block">
        <div className="grid grid-cols-[300px_1fr_300px] gap-1.5 px-3 pb-3 pt-1.5">
          {/* ── Left: Trade panel ── */}
          <div className="min-w-0 space-y-1.5">
            {/* Trade form — sticky */}
            <div className="sticky top-0 z-20" data-tour="trade-form">
              <ErrorBoundary label="TradeForm">
                <TradeForm slabAddress={slabAddress} />
              </ErrorBoundary>
            </div>

            {/* Position / Account / Deposit tabs */}
            <Tabs
              tabs={["Position", "Account", "Deposit"]}
              defaultTab={defaultLeftTab}
            >
              <ErrorBoundary label="PositionPanel">
                <PositionPanel slabAddress={slabAddress} />
              </ErrorBoundary>
              <ErrorBoundary label="AccountsCard">
                <AccountsCard />
              </ErrorBoundary>
              <ErrorBoundary label="DepositWithdrawCard">
                <div data-tour="deposit-card">
                  <DepositWithdrawCard slabAddress={slabAddress} />
                </div>
              </ErrorBoundary>
            </Tabs>
          </div>

          {/* ── Center: Chart + Market data ── */}
          <div className="min-w-0 space-y-1.5">
            {/* The chart — main visual */}
            <ErrorBoundary label="TradingChart">
              <div data-tour="price-chart">
                <TradingChart slabAddress={slabAddress} />
              </div>
            </ErrorBoundary>

            {/* Market data tabs */}
            <Tabs tabs={["Stats", "Trades", "Risk", "Book"]}>
              <ErrorBoundary label="MarketStatsCard">
                <MarketStatsCard />
              </ErrorBoundary>
              <ErrorBoundary label="TradeHistory">
                <TradeHistory slabAddress={slabAddress} />
              </ErrorBoundary>
              <ErrorBoundary label="RiskDashboard">
                <div
                  className="space-y-1.5 pt-1"
                  data-tour="risk-dashboard"
                >
                  <div className="grid grid-cols-2 gap-1.5">
                    <EngineHealthCard />
                    <FundingRateCard slabAddress={slabAddress} />
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <CrankHealthCard />
                    <SystemCapitalCard />
                    <InsuranceLPPanel />
                  </div>
                  <LiquidationAnalytics />
                </div>
              </ErrorBoundary>
              <ErrorBoundary label="MarketBookCard">
                <MarketBookCard />
              </ErrorBoundary>
            </Tabs>
          </div>

          {/* ── Right: Scenarios + Insights ── */}
          <div className="min-w-0 space-y-1.5">
            <ErrorBoundary label="ScenarioPanel">
              <div data-tour="scenario-panel">
                <ScenarioPanel />
              </div>
            </ErrorBoundary>
            <ErrorBoundary label="SimExplainer">
              <SimExplainer />
            </ErrorBoundary>
            <ErrorBoundary label="RiskConceptCards">
              <RiskConceptCards />
            </ErrorBoundary>
            <ErrorBoundary label="EventFeed">
              <EventFeed />
            </ErrorBoundary>
          </div>
        </div>

        {/* Bottom: Leaderboard — full width */}
        <div className="px-3 pb-6">
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
            <SimulatorInner
              marketKey={selectedMarket}
              slabAddress={slabAddress}
            />
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
