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
import { ScenarioPanel } from "./components/ScenarioPanel";
import { EventFeed } from "./components/EventFeed";
import { RiskConceptCards } from "./components/RiskConceptCards";
import { SimulatorHeader } from "./components/SimulatorHeader";
import { SimulatorHero } from "./components/SimulatorHero";
import { SimExplainer } from "./components/SimExplainer";
import { GuidedWalkthrough } from "./components/GuidedWalkthrough";

const SimOnboarding = dynamic(
  () => import("./components/SimOnboarding").then((m) => ({ default: m.SimOnboarding })),
  { ssr: false }
);

import simMarkets from "@/config/sim-markets.json";

interface MarketConfig { slab: string; name: string }
const MARKETS = simMarkets.markets as Record<string, MarketConfig>;
const MARKET_KEYS = Object.keys(MARKETS);

/* ─── Tabs ───────────────────────────────────────────────── */
function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: string[];
  active: number;
  onChange: (i: number) => void;
}) {
  return (
    <div className="flex border-b border-[var(--border)]/40">
      {tabs.map((t, i) => (
        <button
          key={t}
          onClick={() => onChange(i)}
          className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-widest transition-colors border-b-2 ${
            active === i
              ? "border-[var(--accent)] text-[var(--accent)]"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

/* ─── Market selector ────────────────────────────────────── */
function MarketPills({
  selected,
  onChange,
}: {
  selected: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {MARKET_KEYS.map((k) => {
        const active = k === selected;
        return (
          <button
            key={k}
            onClick={() => onChange(k)}
            className={`px-3 py-1.5 text-[11px] font-semibold tracking-wide transition-all ${
              active
                ? "bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/30"
                : "text-[var(--text-muted)] border border-transparent hover:text-[var(--text-secondary)] hover:border-[var(--border)]/40"
            }`}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Inner page (inside SlabProvider) ───────────────────── */
function SimInner({
  slabAddress,
  marketKey,
  onScenarioChange,
}: {
  slabAddress: string;
  marketKey: string;
  onScenarioChange?: (scenario: string | null) => void;
}) {
  const { accounts } = useSlabState();
  const { connected } = useWallet();
  const [leftTab, setLeftTab] = useState(0);
  const [centerTab, setCenterTab] = useState(0);
  const [mobileTab, setMobileTab] = useState(0);

  const hasCapital = accounts.some(
    (a) => a.account.capital > 0n || a.account.positionSize !== 0n
  );
  const hasTraded = accounts.some((a) => a.account.positionSize !== 0n);

  if (!slabAddress) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="border border-[var(--border)] bg-[var(--bg-elevated)] p-8 text-center max-w-sm">
          <div className="mb-3 text-3xl">🚧</div>
          <p className="text-sm font-semibold text-[var(--text)]">
            Market Not Deployed
          </p>
          <p className="mt-1 text-xs text-[var(--text-dim)]">
            This sim market isn&apos;t on devnet yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <SimOnboarding
        hasBalance={hasCapital}
        hasTraded={hasTraded}
        onDismiss={() => {}}
      />

      {/* Bug fix: GuidedWalkthrough inside SlabProvider so hasCapital is available */}
      {connected && (
        <GuidedWalkthrough autoStart={!hasCapital} />
      )}

      {/* Bug fix: SimExplainer provides live engine-state contextual education */}
      <SimExplainer />

      {/* ══════════════════════════════════════════════════════
          MOBILE  (< lg)
          ══════════════════════════════════════════════════════ */}
      <div className="flex flex-col gap-2 p-2 lg:hidden">
        <ErrorBoundary label="Chart">
          <TradingChart slabAddress={slabAddress} />
        </ErrorBoundary>

        <ErrorBoundary label="Trade">
          <TradeForm slabAddress={slabAddress} />
        </ErrorBoundary>

        {hasCapital && (
          <ErrorBoundary label="Position">
            <PositionPanel slabAddress={slabAddress} />
          </ErrorBoundary>
        )}

        <ErrorBoundary label="Deposit">
          <DepositWithdrawCard slabAddress={slabAddress} />
        </ErrorBoundary>

        <TabBar
          tabs={["Stats", "Trades", "Risk", "Scenarios"]}
          active={mobileTab}
          onChange={setMobileTab}
        />
        <div className="min-h-[200px]">
          {mobileTab === 0 && (
            <ErrorBoundary label="Stats">
              <MarketStatsCard />
            </ErrorBoundary>
          )}
          {mobileTab === 1 && (
            <ErrorBoundary label="Trades">
              <TradeHistory slabAddress={slabAddress} />
            </ErrorBoundary>
          )}
          {/* Bug fix: mobile Risk tab was missing CrankHealthCard, SystemCapitalCard,
              InsuranceLPPanel, LiquidationAnalytics — incomplete vs desktop panel */}
          {mobileTab === 2 && (
            <div className="space-y-2">
              <ErrorBoundary label="Health">
                <EngineHealthCard />
              </ErrorBoundary>
              <ErrorBoundary label="Funding">
                <FundingRateCard slabAddress={slabAddress} />
              </ErrorBoundary>
              <ErrorBoundary label="CrankHealth">
                <CrankHealthCard />
              </ErrorBoundary>
              <ErrorBoundary label="SystemCapital">
                <SystemCapitalCard />
              </ErrorBoundary>
              <ErrorBoundary label="InsuranceLP">
                <InsuranceLPPanel />
              </ErrorBoundary>
              <ErrorBoundary label="LiqAnalytics">
                <LiquidationAnalytics />
              </ErrorBoundary>
            </div>
          )}
          {mobileTab === 3 && (
            <div className="space-y-2">
              <ErrorBoundary label="Scenarios">
                <ScenarioPanel onScenarioChange={onScenarioChange} />
              </ErrorBoundary>
              <ErrorBoundary label="Events">
                <EventFeed />
              </ErrorBoundary>
            </div>
          )}
        </div>

      </div>

      {/* ══════════════════════════════════════════════════════
          DESKTOP  (≥ lg) — 3-column trading terminal
          ══════════════════════════════════════════════════════ */}
      <div className="hidden lg:block">
        <div className="grid grid-cols-[280px_1fr_300px] gap-px bg-[var(--border)]/20 min-h-[calc(100vh-56px)]">

          {/* ── LEFT: Trade + Position ── */}
          <div className="bg-[var(--bg)] flex flex-col">
            <ErrorBoundary label="Trade">
              <TradeForm slabAddress={slabAddress} />
            </ErrorBoundary>

            <TabBar
              tabs={["Position", "Account", "Deposit"]}
              active={leftTab}
              onChange={setLeftTab}
            />
            <div className="flex-1 overflow-auto">
              {leftTab === 0 && (
                <ErrorBoundary label="Position">
                  <PositionPanel slabAddress={slabAddress} />
                </ErrorBoundary>
              )}
              {leftTab === 1 && (
                <ErrorBoundary label="Account">
                  <AccountsCard />
                </ErrorBoundary>
              )}
              {leftTab === 2 && (
                <ErrorBoundary label="Deposit">
                  <DepositWithdrawCard slabAddress={slabAddress} />
                </ErrorBoundary>
              )}
            </div>
          </div>

          {/* ── CENTER: Chart + Data ── */}
          <div className="bg-[var(--bg)] flex flex-col">
            <ErrorBoundary label="Chart">
              <TradingChart slabAddress={slabAddress} />
            </ErrorBoundary>

            <TabBar
              tabs={["Stats", "Trades", "Risk", "Book"]}
              active={centerTab}
              onChange={setCenterTab}
            />
            <div className="flex-1 overflow-auto">
              {centerTab === 0 && (
                <ErrorBoundary label="Stats">
                  <div className="p-2">
                    <MarketStatsCard />
                  </div>
                </ErrorBoundary>
              )}
              {centerTab === 1 && (
                <ErrorBoundary label="Trades">
                  <TradeHistory slabAddress={slabAddress} />
                </ErrorBoundary>
              )}
              {centerTab === 2 && (
                <ErrorBoundary label="Risk">
                  <div className="space-y-2 p-2">
                    <div className="grid grid-cols-2 gap-2">
                      <EngineHealthCard />
                      <FundingRateCard slabAddress={slabAddress} />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <CrankHealthCard />
                      <SystemCapitalCard />
                      <InsuranceLPPanel />
                    </div>
                    <LiquidationAnalytics />
                  </div>
                </ErrorBoundary>
              )}
              {centerTab === 3 && (
                <ErrorBoundary label="Book">
                  <MarketBookCard />
                </ErrorBoundary>
              )}
            </div>
          </div>

          {/* ── RIGHT: Scenarios + Events + Concepts ── */}
          <div className="bg-[var(--bg)] flex flex-col overflow-auto">
            <ErrorBoundary label="Scenarios">
              <ScenarioPanel onScenarioChange={onScenarioChange} />
            </ErrorBoundary>
            <ErrorBoundary label="Events">
              <EventFeed />
            </ErrorBoundary>
            <ErrorBoundary label="Concepts">
              <RiskConceptCards />
            </ErrorBoundary>
          </div>
        </div>

      </div>
    </>
  );
}

/* ─── Page export ────────────────────────────────────────── */
export default function SimulatePage() {
  const [market, setMarket] = useState("SOL/USD");
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const { connected } = useWallet();
  const current = MARKETS[market] ?? MARKETS["SOL/USD"];
  const slab = current?.slab ?? "";

  // Build market list for header
  const marketList = MARKET_KEYS.map((k) => ({ key: k, name: MARKETS[k].name }));

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Bug fix: use SimulatorHeader component (previously inline JSX with no testids or market props) */}
      <SimulatorHeader
        markets={marketList}
        selectedMarket={market}
        onMarketChange={setMarket}
        activeScenario={activeScenario}
      />

      {/* Bug fix: SimulatorHero shown only when wallet not connected */}
      {!connected && <SimulatorHero />}

      {slab ? (
        <SlabProvider slabAddress={slab}>
          <UsdToggleProvider>
            <SimInner
              slabAddress={slab}
              marketKey={market}
              onScenarioChange={setActiveScenario}
            />
          </UsdToggleProvider>
        </SlabProvider>
      ) : (
        <SimInner slabAddress="" marketKey={market} onScenarioChange={setActiveScenario} />
      )}
    </div>
  );
}
