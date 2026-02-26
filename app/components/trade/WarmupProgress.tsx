"use client";

import { FC, useState, useEffect } from "react";
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
  const seconds = Math.floor(slots * 0.4);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatUsdAmount(amountRaw: string | bigint, tokenDecimals: number): string {
  const num = typeof amountRaw === "string" ? BigInt(amountRaw) : amountRaw;
  const usd = Number(num) / 10 ** tokenDecimals;
  return usd.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const WarmupProgress: FC<{
  slabAddress: string;
  accountIdx: number;
  tokenDecimals?: number;
}> = ({ slabAddress, accountIdx, tokenDecimals = 6 }) => {
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
        setWarmupData(null);
      } finally {
        setLoading(false);
      }
    };

    fetchWarmup();
    const interval = setInterval(fetchWarmup, 5000);
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

  if (!warmupData && !loading) return null;

  if (loading && !warmupData) {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="h-1 flex-1 animate-pulse rounded-full bg-[var(--border)]/30" />
      </div>
    );
  }

  if (!warmupData) return null;

  const isComplete = progress >= 100 || countdown === 0;

  if (isComplete) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--long)]" />
        <span className="text-[10px] text-[var(--text-dim)]">Profits fully unlocked</span>
      </div>
    );
  }

  return (
    <>
      <div className="py-1">
        {/* Single row: label, progress bar, countdown */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowExplainer(true)}
            className="shrink-0 text-[10px] text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Unlocking profits
          </button>

          {/* Thin progress bar */}
          <div className="flex-1 h-1 overflow-hidden rounded-full bg-[var(--border)]/20">
            <div
              className="h-full rounded-full bg-[var(--accent)]/60 transition-all duration-1000 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>

          <span
            className="shrink-0 text-[10px] tabular-nums text-[var(--text-dim)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {progress.toFixed(0)}%
          </span>

          <span
            className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatCountdown(countdown)}
          </span>
        </div>

        {/* Amounts row — compact */}
        <div className="mt-1 flex items-center gap-3 pl-0">
          <span className="text-[9px] text-[var(--text-dim)]">
            <span className="text-[var(--text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>${formatUsdAmount(warmupData.unlockedAmount, tokenDecimals)}</span> available
          </span>
          <span className="text-[var(--border)]">·</span>
          <span className="text-[9px] text-[var(--text-dim)]">
            <span className="text-[var(--text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>${formatUsdAmount(warmupData.lockedAmount, tokenDecimals)}</span> locked
          </span>
          <button
            onClick={() => setShowExplainer(true)}
            className="ml-auto text-[9px] text-[var(--accent)]/60 hover:text-[var(--accent)] transition-colors"
          >
            Learn more
          </button>
        </div>

        {error && !mockMode && (
          <p className="mt-1 text-[9px] text-[var(--text-dim)]">{error}</p>
        )}
      </div>

      {showExplainer && (
        <WarmupExplainerModal onClose={() => setShowExplainer(false)} />
      )}
    </>
  );
};
