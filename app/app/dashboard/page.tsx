"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { isMockMode } from "@/lib/mock-mode";
import { ScrollReveal } from "@/components/ui/ScrollReveal";

const ConnectButton = dynamic(
  () => import("@/components/wallet/ConnectButton").then((m) => m.ConnectButton),
  { ssr: false }
);

// Lazy load heavy components
const DashboardHeader = dynamic(
  () => import("@/components/dashboard/DashboardHeader").then((m) => m.DashboardHeader),
  { ssr: false, loading: () => <div className="h-14 animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" /> }
);

const PnlChart = dynamic(
  () => import("@/components/dashboard/PnlChart").then((m) => m.PnlChart),
  { ssr: false, loading: () => <div className="h-[380px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" /> }
);

const PositionSummary = dynamic(
  () => import("@/components/dashboard/PositionSummary").then((m) => m.PositionSummary),
  { ssr: false, loading: () => <div className="h-[380px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" /> }
);

const StatsBar = dynamic(
  () => import("@/components/dashboard/StatsBar").then((m) => m.StatsBar),
  { ssr: false, loading: () => <div className="h-20 animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" /> }
);

const TradeHistory = dynamic(
  () => import("@/components/dashboard/TradeHistory").then((m) => m.TradeHistory),
  { ssr: false, loading: () => <div className="h-[400px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" /> }
);

const Watchlist = dynamic(
  () => import("@/components/dashboard/Watchlist").then((m) => m.Watchlist),
  { ssr: false, loading: () => <div className="h-[200px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" /> }
);

const FundingRates = dynamic(
  () => import("@/components/dashboard/FundingRates").then((m) => m.FundingRates),
  { ssr: false, loading: () => <div className="h-[200px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" /> }
);

// Mobile tab type
type MobileTab = "overview" | "positions" | "history" | "watchlist";

export default function DashboardPage() {
  useEffect(() => { document.title = "Dashboard — Percolator"; }, []);

  const { connected: walletConnected } = useWalletCompat();
  const mockMode = isMockMode();
  const connected = walletConnected || mockMode;
  const [mobileTab, setMobileTab] = useState<MobileTab>("overview");

  // Not connected state
  if (!connected) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <div className="relative mx-auto max-w-5xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // dashboard
          </div>
          <h1
            className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            <span className="font-normal text-white/50">Trader </span>Dashboard
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">
            Your personal command centre for trading on Percolator
          </p>

          {/* Blurred preview */}
          <div className="relative">
            <div className="pointer-events-none select-none blur-sm opacity-40">
              <div className="grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] lg:grid-cols-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="bg-[var(--panel-bg)] p-5 h-20" />
                ))}
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-5">
                <div className="lg:col-span-3 h-[300px] bg-[var(--panel-bg)] border border-[var(--border)]" />
                <div className="lg:col-span-2 h-[300px] bg-[var(--panel-bg)] border border-[var(--border)]" />
              </div>
            </div>

            {/* Overlay CTA */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="border border-[var(--border)] bg-[var(--bg)]/95 p-8 text-center backdrop-blur-md">
                <div className="mb-3 text-3xl">🔒</div>
                <p className="mb-4 text-[13px] text-[var(--text-secondary)]">
                  Connect your wallet to view your dashboard
                </p>
                <ConnectButton />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-[1440px] px-4 py-6 lg:px-6">
        {/* Page header */}
        <ScrollReveal>
          <div className="mb-6">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // dashboard
            </div>
            <h1
              className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              <span className="font-normal text-white/50">Trader </span>Dashboard
            </h1>
          </div>
        </ScrollReveal>

        {/* Dashboard Header Bar */}
        <ScrollReveal delay={0.05}>
          <div className="mb-4">
            <DashboardHeader />
          </div>
        </ScrollReveal>

        {/* === DESKTOP LAYOUT === */}
        <div className="hidden md:block">
          {/* Row 1: PnL Chart + Position Summary */}
          <ScrollReveal delay={0.1}>
            <div className="mb-4 grid gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3" style={{ minHeight: 380 }}>
                <PnlChart />
              </div>
              <div className="lg:col-span-2" style={{ minHeight: 380 }}>
                <PositionSummary />
              </div>
            </div>
          </ScrollReveal>

          {/* Row 2: Stats Bar */}
          <ScrollReveal delay={0.15}>
            <div className="mb-4">
              <StatsBar />
            </div>
          </ScrollReveal>

          {/* Row 3: Trade History + Watchlist/Funding */}
          <ScrollReveal delay={0.2}>
            <div className="grid gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <TradeHistory />
              </div>
              <div className="lg:col-span-2 space-y-4">
                <Watchlist />
                <FundingRates />
              </div>
            </div>
          </ScrollReveal>
        </div>

        {/* === MOBILE LAYOUT === */}
        <div className="md:hidden">
          {/* Mobile tab bar */}
          <div className="mb-4 grid grid-cols-4 gap-0.5 rounded-sm border border-[var(--border)] bg-[var(--bg)] p-0.5">
            {(
              [
                { key: "overview", icon: "📊", label: "Overview" },
                { key: "positions", icon: "📋", label: "Positions" },
                { key: "history", icon: "🕐", label: "History" },
                { key: "watchlist", icon: "👁", label: "Watchlist" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setMobileTab(tab.key)}
                className={[
                  "rounded-sm px-2 py-2 text-center text-[10px] font-bold transition-all",
                  mobileTab === tab.key
                    ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                    : "text-[var(--text-muted)]",
                ].join(" ")}
              >
                <span className="block text-sm">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Mobile tab content */}
          {mobileTab === "overview" && (
            <div className="space-y-4">
              <StatsBar />
              <div style={{ minHeight: 300 }}>
                <PnlChart />
              </div>
            </div>
          )}
          {mobileTab === "positions" && (
            <div style={{ minHeight: 300 }}>
              <PositionSummary />
            </div>
          )}
          {mobileTab === "history" && <TradeHistory />}
          {mobileTab === "watchlist" && (
            <div className="space-y-4">
              <Watchlist />
              <FundingRates />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
