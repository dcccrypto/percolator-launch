"use client";

import { FC, useState, useEffect } from "react";
import { WarmupExplainerModal } from "./WarmupExplainerModal";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

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

  // Fetch warmup data. Stops polling once the value can no longer change:
  // a 404 (no warmup exists for this position, ever) or the warmup period
  // has fully elapsed (100% unlocked, terminal state) — previously polled
  // /api/warmup every 5s indefinitely in BOTH cases. Also pauses while the
  // tab is hidden via pollWhenVisible.
  useEffect(() => {
    if (mockMode) return;

    let disposePoll: (() => void) | null = null;

    const fetchWarmup = async () => {
      try {
        setLoading(true);
        const res = await fetch(
          `/api/warmup/${slabAddress}/${accountIdx}`
        );
        if (!res.ok) {
          if (res.status === 404) {
            // No warmup exists for this position — that can't change on
            // its own, so stop polling instead of hitting the endpoint
            // every 5s forever.
            setWarmupData(null);
            setError(null);
            disposePoll?.();
            return;
          }
          throw new Error("Failed to fetch warmup data");
        }
        const data: WarmupData = await res.json();
        setWarmupData(data);
        setError(null);
        // Once the warmup period has fully elapsed, the unlocked amount is
        // a terminal value — stop polling it.
        const elapsed = data.currentSlot - data.warmupStartedAtSlot;
        if (elapsed >= data.warmupPeriodSlots) {
          disposePoll?.();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setWarmupData(null);
      } finally {
        setLoading(false);
      }
    };

    fetchWarmup();
    disposePoll = pollWhenVisible(fetchWarmup, 5000);
    return () => disposePoll?.();
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
          <div
            className="flex-1 h-1 overflow-hidden rounded-full bg-[var(--border)]/20"
            role="progressbar"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`Profit unlock ${progress.toFixed(0)}% complete`}
          >
            <div
              className="h-full rounded-full bg-[var(--accent)]/60 transition-[width] duration-1000 ease-linear"
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
