"use client";

import { useState, useCallback } from "react";
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
import { MarketBookCard } from "@/components/trade/MarketBookCard";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { FundingRateCard } from "@/components/trade/FundingRateCard";
import { SimLeaderboard } from "./components/SimLeaderboard";
import { ScenarioPanel } from "./components/ScenarioPanel";
import { EventFeed } from "./components/EventFeed";

const SimOnboarding = dynamic(
  () => import("./components/SimOnboarding").then((m) => ({ default: m.SimOnboarding })),
  { ssr: false }
);

import simMarkets from "@/config/sim-markets.json";

interface MarketConfig { slab: string; name: string }
const MARKETS = simMarkets.markets as Record<string, MarketConfig>;
const MARKET_KEYS = Object.keys(MARKETS);

/* ── Tab component ─────────────────────────────────────── */
function TabBar({ tabs, active, onChange }: { tabs: string[]; active: number; onChange: (i: number) => void }) {
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

/* ── Market selector pills ─────────────────────────────── */
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
        const m = MARKETS[k];
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

/* ── Inner page (inside SlabProvider) ──────────────────── */
function SimInner({ slabAddress, marketKey }: { slabAddress: string; marketKey: string }) {
  const { accounts } = useSlabState();
  const { connected } = useWallet();
  const [leftTab, setLeftTab] = useState(0);
  const [bottomTab, setBottomTab] = useState(0);

  const hasCapital = accounts.some((a) => a.account.capital > 0n || a.account.positionSize !== 0n);
  const hasTraded = accounts.some((a) => a.account.positionSize !== 0n);

  if (!slabAddress) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="border border-[var(--border)] bg-[var(--bg-elevated)] p-8 text-center max-w-sm">
          <div className="mb-3 text-3xl">🚧</div>
          <p className="text-sm font-semibold text-[var(--text)]">Market Not Deployed</p>
          <p className="mt-1 text-xs text-[var(--text-dim)]">This sim market isn&apos;t on devnet yet.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Onboarding (only shows when needed) */}
      <SimOnboarding hasBalance={hasCapital} hasTraded={hasTraded} onDismiss={() => {}} />

      {/* ═══════════ MOBILE ═══════════ */}
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
        <TabBar tabs={["Engine", "Scenarios", "Book"]} active={bottomTab} onChange={setBottomTab} />
        <div className="min-h-[200px]">
          {bottomTab === 0 && (
            <div className="space-y-2">
              <ErrorBoundary label="Health"><EngineHealthCard /></ErrorBoundary>
              <ErrorBoundary label="Funding"><FundingRateCard slabAddress={slabAddress} /></ErrorBoundary>
            </div>
          )}
          {bottomTab === 1 && (
            <div className="space-y-2">
              <ErrorBoundary label="Scenarios"><ScenarioPanel /></ErrorBoundary>
              <ErrorBoundary label="Events"><EventFeed /></ErrorBoundary>
            </div>
          )}
          {bottomTab === 2 && (
            <ErrorBoundary label="Book"><MarketBookCard /></ErrorBoundary>
          )}
        </div>
        <ErrorBoundary label="Leaderboard">
          <SimLeaderboard marketKey={marketKey} />
        </ErrorBoundary>
      </div>

      {/* ═══════════ DESKTOP (3-col) ═══════════ */}
      <div className="hidden lg:block">
        <div className="grid grid-cols-[280px_1fr_280px] gap-px bg-[var(--border)]/20 min-h-[calc(100vh-120px)]">

          {/* ── LEFT COL: Trade + Position ── */}
          <div className="bg-[var(--bg)] flex flex-col">
            <div className="sticky top-0 z-10 flex flex-col gap-0">
              <ErrorBoundary label="Trade">
                <TradeForm slabAddress={slabAddress} />
              </ErrorBoundary>
            </div>

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
                <ErrorBoundary label="Accounts">
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

          {/* ── CENTER COL: Chart + Data ── */}
          <div className="bg-[var(--bg)] flex flex-col">
            <ErrorBoundary label="Chart">
              <div className="border-b border-[var(--border)]/30">
                <TradingChart slabAddress={slabAddress} />
              </div>
            </ErrorBoundary>

            <TabBar
              tabs={["Engine", "Funding", "Book"]}
              active={bottomTab}
              onChange={setBottomTab}
            />
            <div className="flex-1 overflow-auto p-2">
              {bottomTab === 0 && (
                <ErrorBoundary label="Health">
                  <EngineHealthCard />
                </ErrorBoundary>
              )}
              {bottomTab === 1 && (
                <ErrorBoundary label="Funding">
                  <FundingRateCard slabAddress={slabAddress} />
                </ErrorBoundary>
              )}
              {bottomTab === 2 && (
                <ErrorBoundary label="Book">
                  <MarketBookCard />
                </ErrorBoundary>
              )}
            </div>
          </div>

          {/* ── RIGHT COL: Scenarios + Events ── */}
          <div className="bg-[var(--bg)] flex flex-col overflow-auto">
            <ErrorBoundary label="Scenarios">
              <ScenarioPanel />
            </ErrorBoundary>
            <ErrorBoundary label="Events">
              <EventFeed />
            </ErrorBoundary>
          </div>
        </div>

        {/* ── BOTTOM: Leaderboard ── */}
        <div className="border-t border-[var(--border)]/30 px-4 py-4">
          <ErrorBoundary label="Leaderboard">
            <SimLeaderboard marketKey={marketKey} />
          </ErrorBoundary>
        </div>
      </div>
    </>
  );
}

/* ── Page wrapper ────────────────────────────────────────── */
export default function SimulatePage() {
  const [market, setMarket] = useState("SOL/USD");
  const current = MARKETS[market] ?? MARKETS["SOL/USD"];
  const slab = current?.slab ?? "";

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* ── Top bar ── */}
      <header className="border-b border-[var(--border)]/40 bg-[var(--bg)]/95 backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 py-2.5">
          {/* Left: Title + Markets */}
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
                Simulator
              </h1>
              <span className="text-[9px] uppercase tracking-[0.2em] text-[var(--text-dim)]">
                Risk Engine
              </span>
            </div>
            <MarketPills selected={market} onChange={setMarket} />
          </div>

          {/* Right: Status */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1 border border-[var(--border)]/40">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              <span className="text-[9px] font-medium uppercase tracking-widest text-[var(--text-dim)]">
                Devnet
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      {slab ? (
        <SlabProvider slabAddress={slab}>
          <UsdToggleProvider>
            <SimInner slabAddress={slab} marketKey={market} />
          </UsdToggleProvider>
        </SlabProvider>
      ) : (
        <SimInner slabAddress="" marketKey={market} />
      )}
    </div>
  );
}
