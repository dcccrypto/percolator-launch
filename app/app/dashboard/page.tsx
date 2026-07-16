"use client";



import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { isMockMode } from "@/lib/mock-mode";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

const ConnectButton = dynamic(
  () => import("@/components/wallet/ConnectButton").then((m) => m.ConnectButton),
  { ssr: false }
);

// Lazy load heavy components
const DashboardHeader = dynamic(
  () => import("@/components/dashboard/DashboardHeader").then((m) => m.DashboardHeader),
  {
    ssr: false,
    loading: () => (
      <div className="h-14 bg-[var(--panel-bg)] border border-[var(--border)] px-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShimmerSkeleton className="h-8 w-8 rounded-full" />
          <ShimmerSkeleton className="h-4 w-32" />
        </div>
        <ShimmerSkeleton className="h-5 w-24" />
      </div>
    )
  }
);

const PnlChart = dynamic(
  () => import("@/components/dashboard/PnlChart").then((m) => m.PnlChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[380px] bg-[var(--panel-bg)] border border-[var(--border)] p-4 flex flex-col justify-between">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <ShimmerSkeleton className="h-4 w-24" />
            <ShimmerSkeleton className="h-6 w-32" />
          </div>
          <div className="flex gap-1.5">
            {[1, 2, 3, 4].map(i => <ShimmerSkeleton key={i} className="h-6 w-10" />)}
          </div>
        </div>
        <div className="flex-1 mt-6 flex items-end gap-1.5 pb-4">
          {[...Array(12)].map((_, i) => (
            <ShimmerSkeleton key={i} className="flex-1" style={{ height: `${20 + Math.sin(i) * 15 + Math.cos(i) * 15}%` }} />
          ))}
        </div>
        <div className="flex justify-between border-t border-[var(--border)]/30 pt-3">
          {[...Array(6)].map((_, i) => <ShimmerSkeleton key={i} className="h-3 w-10" />)}
        </div>
      </div>
    )
  }
);

const PositionSummary = dynamic(
  () => import("@/components/dashboard/PositionSummary").then((m) => m.PositionSummary),
  {
    ssr: false,
    loading: () => (
      <div className="h-[380px] bg-[var(--panel-bg)] border border-[var(--border)] p-4 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <ShimmerSkeleton className="h-4 w-32" />
          <ShimmerSkeleton className="h-4 w-16" />
        </div>
        <div className="flex-1 space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="p-3 border border-[var(--border)]/50 rounded-sm space-y-2">
              <div className="flex justify-between">
                <ShimmerSkeleton className="h-4 w-20" />
                <ShimmerSkeleton className="h-4 w-12" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3].map(j => (
                  <div key={j} className="space-y-1">
                    <ShimmerSkeleton className="h-2.5 w-10" />
                    <ShimmerSkeleton className="h-3.5 w-14" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }
);

const StatsBar = dynamic(
  () => import("@/components/dashboard/StatsBar").then((m) => m.StatsBar),
  {
    ssr: false,
    loading: () => (
      <div className="grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] lg:grid-cols-4">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="bg-[var(--panel-bg)] p-4 space-y-2">
            <ShimmerSkeleton className="h-2.5 w-24" />
            <ShimmerSkeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    )
  }
);

// PERC-808: Live protocol-wide Volume + OI strip
const ProtocolStatsBar = dynamic(
  () => import("@/components/dashboard/ProtocolStatsBar").then((m) => m.ProtocolStatsBar),
  {
    ssr: false,
    loading: () => (
      <div className="h-12 bg-[var(--panel-bg)] border border-[var(--border)] px-4 flex items-center justify-between gap-4 overflow-hidden">
        <div className="flex items-center gap-2 shrink-0">
          <ShimmerSkeleton className="h-2 w-2 rounded-full" />
          <ShimmerSkeleton className="h-3.5 w-24" />
        </div>
        <div className="flex gap-8 overflow-hidden">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex gap-2 items-center shrink-0">
              <ShimmerSkeleton className="h-3 w-16" />
              <ShimmerSkeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
    )
  }
);

const TradeHistory = dynamic(
  () => import("@/components/dashboard/TradeHistory").then((m) => m.TradeHistory),
  {
    ssr: false,
    loading: () => (
      <div className="h-[400px] bg-[var(--panel-bg)] border border-[var(--border)] p-4 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <ShimmerSkeleton className="h-4 w-28" />
          <div className="flex gap-2">
            <ShimmerSkeleton className="h-6 w-16" />
            <ShimmerSkeleton className="h-6 w-16" />
          </div>
        </div>
        <div className="flex-1 space-y-2">
          <div className="flex gap-4 border-b border-[var(--border)]/30 pb-2 mb-2">
            {[1, 2, 3, 4, 5].map(i => <ShimmerSkeleton key={i} className="h-3 flex-1" />)}
          </div>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="flex gap-4 items-center py-1">
              {[1, 2, 3, 4, 5].map(j => <ShimmerSkeleton key={j} className="h-3.5 flex-1" />)}
            </div>
          ))}
        </div>
      </div>
    )
  }
);

const Watchlist = dynamic(
  () => import("@/components/dashboard/Watchlist").then((m) => m.Watchlist),
  {
    ssr: false,
    loading: () => (
      <div className="h-[200px] bg-[var(--panel-bg)] border border-[var(--border)] p-4 flex flex-col">
        <ShimmerSkeleton className="h-4 w-24 mb-4" />
        <div className="flex-1 space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <ShimmerSkeleton className="h-6 w-6 rounded-full" />
                <div className="space-y-1">
                  <ShimmerSkeleton className="h-3.5 w-16" />
                  <ShimmerSkeleton className="h-2.5 w-24" />
                </div>
              </div>
              <ShimmerSkeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      </div>
    )
  }
);

const FundingRates = dynamic(
  () => import("@/components/dashboard/FundingRates").then((m) => m.FundingRates),
  {
    ssr: false,
    loading: () => (
      <div className="h-[200px] bg-[var(--panel-bg)] border border-[var(--border)] p-4 flex flex-col">
        <ShimmerSkeleton className="h-4 w-28 mb-4" />
        <div className="flex-1 space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <ShimmerSkeleton className="h-5 w-12" />
                <ShimmerSkeleton className="h-3 w-16" />
              </div>
              <ShimmerSkeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </div>
    )
  }
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
      <div className="min-h-[calc(100dvh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <div className="relative mx-auto max-w-5xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // dashboard
          </div>
          <h1
            className="text-2xl font-medium tracking-[-0.01em] text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            <span className="font-normal text-[var(--text-secondary)]">Trader </span>Dashboard
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">
            Your personal command centre for trading on Percolator
          </p>

          {/* Ghost preview of the dashboard layout behind the connect gate.
              Crisp at reduced opacity, NOT blurred: blur-sm + near-white
              panels on the light theme's white bg dissolved into shapeless
              smudges that read as a rendering glitch rather than a preview. */}
          <div className="relative">
            <div className="pointer-events-none select-none opacity-40">
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
                <div className="mb-3 text-4xl">🔒</div>
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
    <div className="min-h-[calc(100dvh-48px)] relative">
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
              className="text-2xl font-medium tracking-[-0.01em] text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              <span className="font-normal text-[var(--text-secondary)]">Trader </span>Dashboard
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
              <div className="lg:col-span-3" style={{ minHeight: 380, maxHeight: 500 }}>
                <PnlChart />
              </div>
              <div className="lg:col-span-2" style={{ minHeight: 380, maxHeight: 500 }}>
                <PositionSummary />
              </div>
            </div>
          </ScrollReveal>

          {/* Row 2: Protocol stats (live Volume + OI) — PERC-808 */}
          <ScrollReveal delay={0.1}>
            <div className="mb-2">
              <ProtocolStatsBar />
            </div>
          </ScrollReveal>

          {/* Row 3: Personal Stats Bar */}
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
                    : "text-[var(--text-secondary)]",
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
              <ProtocolStatsBar />
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
