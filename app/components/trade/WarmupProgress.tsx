"use client";

import { FC, useState, useEffect } from "react";
import { InfoIcon } from "@/components/ui/Tooltip";
import { WarmupExplainerModal } from "./WarmupExplainerModal";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

interface WarmupData {
  warmupStartedAtSlot: number;
  warmupSlopePerStep: string; // U128 as string
  warmupPeriodSlots: number;
  currentSlot: number;
  totalLockedAmount: string; // Token amount as string
  unlockedAmount: string;
  lockedAmount: string;
}

// Mock data for development
const MOCK_WARMUP: WarmupData = {
  warmupStartedAtSlot: 280000000,
  warmupSlopePerStep: "78190", // ~$78.19 per slot
  warmupPeriodSlots: 1000,
  currentSlot: 280000750, // 75% through warmup
  totalLockedAmount: "312760000", // $312.76 total
  unlockedAmount: "234570000", // $234.57 unlocked (75%)
  lockedAmount: "78190000", // $78.19 locked (25%)
};

function formatCountdown(slots: number): string {
  // Solana slots ~400ms each → roughly 2.5 slots per second
  const seconds = Math.floor(slots * 0.4);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatUsdAmount(amountE6: string | bigint): string {
  const num = typeof amountE6 === "string" ? BigInt(amountE6) : amountE6;
  const usd = Number(num) / 1e6;
  return usd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const WarmupProgress: FC<{
  slabAddress: string;
  accountIdx: number;
}> = ({ slabAddress, accountIdx }) => {
  const mockMode = isMockMode() && isMockSlab(slabAddress);

  const [warmupData, setWarmupData] = useState<WarmupData | null>(
    mockMode ? MOCK_WARMUP : null
  );
  const [loading, setLoading] = useState(!mockMode);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [progress, setProgress] = useState(0);

  // Fetch warmup data
  useEffect(() => {
    if (mockMode) return;

    const fetchWarmup = async () => {
      try {
        setLoading(true);
        const res = await fetch(
          `/api/warmup/${slabAddress}/${accountIdx}`
        );
        if (!res.ok) {
          if (res.status === 404) {
            // No active warmup
            setWarmupData(null);
            setError(null);
            return;
          }
          throw new Error("Failed to fetch warmup data");
        }
        const data = await res.json();
        setWarmupData(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Fallback to mock data on error (for demo)
        setWarmupData(MOCK_WARMUP);
      } finally {
        setLoading(false);
      }
    };

    fetchWarmup();
    const interval = setInterval(fetchWarmup, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [slabAddress, accountIdx, mockMode]);

  // Update countdown and progress every second
  useEffect(() => {
    if (!warmupData) return;

    const updateProgress = () => {
      const elapsed = warmupData.currentSlot - warmupData.warmupStartedAtSlot;
      const remaining = warmupData.warmupPeriodSlots - elapsed;
      const progressPct = Math.min(
        100,
        Math.max(0, (elapsed / warmupData.warmupPeriodSlots) * 100)
      );

      setCountdown(Math.max(0, remaining));
      setProgress(progressPct);
    };

    updateProgress();
    const interval = setInterval(updateProgress, 1000);

    return () => clearInterval(interval);
  }, [warmupData]);

  // Don't render if no warmup active
  if (!warmupData && !loading) return null;

  if (loading && !warmupData) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Warmup Status
          </span>
          <div className="h-4 w-16 animate-pulse rounded bg-[var(--border)]" />
        </div>
      </div>
    );
  }

  if (!warmupData) return null;

  // Check if warmup is complete
  const isComplete = progress >= 100 || countdown === 0;

  if (isComplete) {
    return (
      <div className="rounded-none border border-[var(--long)]/50 bg-[var(--long)]/5 p-3">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-[var(--long)]" />
          <div className="flex-1">
            <div className="text-[11px] font-medium text-[var(--long)]">
              Fully Unlocked
            </div>
            <div className="text-[10px] text-[var(--text-dim)]">
              All profits are now withdrawable
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-none border border-[var(--warning)]/50 bg-[var(--bg)]/80 p-3">
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Profit Warming Up
            </span>
            <InfoIcon tooltip="Your profits are gradually unlocking. This protects against oracle manipulation attacks." />
            <button
              onClick={() => setShowExplainer(true)}
              className="ml-1 text-[9px] text-[var(--accent)] hover:underline"
            >
              Why?
            </button>
          </div>
        </div>

        {/* Amounts */}
        <div className="mb-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Unlocked
            </span>
            <span
              className="text-sm font-bold text-[var(--long)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              ${formatUsdAmount(warmupData.unlockedAmount)} ({progress.toFixed(0)}%)
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Locked
            </span>
            <span
              className="text-sm font-bold text-[var(--warning)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              ${formatUsdAmount(warmupData.lockedAmount)} ({(100 - progress).toFixed(0)}%)
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-3">
          <div className="h-2 w-full overflow-hidden rounded-none bg-[var(--border)]/30">
            <div
              className="h-full transition-all duration-1000 ease-linear"
              style={{
                width: `${progress}%`,
                background: `linear-gradient(90deg, var(--warning) 0%, var(--long) 100%)`,
              }}
            />
          </div>
        </div>

        {/* Countdown */}
        <div className="rounded-none border-l-2 border-l-[var(--warning)] bg-[var(--bg-elevated)] p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-[var(--text-secondary)]">
              Fully withdrawable in:
            </span>
            <span
              className="text-sm font-bold text-[var(--warning)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {formatCountdown(countdown)}
            </span>
          </div>
        </div>

        {/* Explainer hint */}
        <div className="mt-2 rounded-none border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/5 p-2">
          <p className="text-[9px] leading-relaxed text-[var(--text-dim)]">
            <strong className="text-[var(--text-secondary)]">Why?</strong>{" "}
            Protects against oracle attacks. Your profit gradually unlocks over ~8 minutes.
          </p>
        </div>

        {error && !mockMode && (
          <div className="mt-2 text-[9px] text-[var(--warning)]">
            {error} (using mock data)
          </div>
        )}
      </div>

      {/* Explainer Modal */}
      {showExplainer && (
        <WarmupExplainerModal onClose={() => setShowExplainer(false)} />
      )}
    </>
  );
};
