"use client";

import { FC, useState, useEffect } from "react";
import { usePriceRouter } from "@/hooks/usePriceRouter";
import { usePythFeedSearch } from "@/hooks/usePythFeedSearch";
import { useDexPoolSearch, type DexPoolResult } from "@/hooks/useDexPoolSearch";
import { OracleBadge } from "./OracleBadge";
import { isValidBase58Pubkey, isValidHex64 } from "@/lib/createWizardUtils";

interface StepOracleSelectProps {
  mintAddress: string;
  mintValid: boolean;
  tokenSymbol: string | null;
  mode: "quick" | "manual";
  oracleType: "pyth" | "hyperp_ema" | "admin";
  onOracleTypeChange: (type: "pyth" | "hyperp_ema" | "admin") => void;
  oracleFeed: string;
  onOracleFeedChange: (feed: string) => void;
  onDexPoolDetected: (pool: DexPoolResult | null) => void;
  onPythDetected: (feed: { id: string; name: string } | null) => void;
  onContinue: () => void;
  onBack: () => void;
  canContinue: boolean;
}

/**
 * Step 2 — Oracle Type selection with auto-detection.
 * Quick mode: auto-detect and select. Manual mode: explicit Pyth search / DEX input.
 */
export const StepOracleSelect: FC<StepOracleSelectProps> = ({
  mintAddress,
  mintValid,
  tokenSymbol,
  mode,
  oracleType,
  onOracleTypeChange,
  oracleFeed,
  onOracleFeedChange,
  onDexPoolDetected,
  onPythDetected,
  onContinue,
  onBack,
  canContinue,
}) => {
  const autoRouterMint = mintValid ? mintAddress : null;
  const priceRouter = usePriceRouter(autoRouterMint);

  // Pyth search (manual mode)
  const pythQuery = mode === "manual" && oracleType === "pyth" && tokenSymbol ? tokenSymbol : "";
  const { feeds: pythFeeds, loading: pythLoading } = usePythFeedSearch(pythQuery);

  // DEX pools (manual mode)
  const dexSearchMint = mode === "manual" && oracleType === "hyperp_ema" && mintValid ? mintAddress : null;
  const { pools: dexPools, loading: dexPoolsLoading } = useDexPoolSearch(dexSearchMint);

  const [selectedPythFeedName, setSelectedPythFeedName] = useState<string | null>(null);
  const [selectedDexPool, setSelectedDexPool] = useState<DexPoolResult | null>(null);
  const [dexPoolInput, setDexPoolInput] = useState("");

  // Auto-detect oracle in quick mode
  useEffect(() => {
    if (mode !== "quick" || !priceRouter.bestSource) return;
    const best = priceRouter.bestSource;
    if (best.type === "pyth") {
      onOracleTypeChange("pyth");
      onOracleFeedChange(best.address);
      onPythDetected({ id: best.address, name: best.pairLabel || "Pyth Feed" });
      setSelectedPythFeedName(best.pairLabel || "Pyth Feed");
    } else if (best.type === "dex") {
      onOracleTypeChange("hyperp_ema");
      onOracleFeedChange(best.address);
      onDexPoolDetected({
        poolAddress: best.address,
        dexId: best.dexId || "unknown",
        pairLabel: best.pairLabel || "DEX Pool",
        liquidityUsd: best.liquidity,
        priceUsd: best.price,
      });
    }
  }, [mode, priceRouter.bestSource, onOracleTypeChange, onOracleFeedChange, onDexPoolDetected, onPythDetected]);

  // No oracle found → admin mode
  useEffect(() => {
    if (mode === "quick" && !priceRouter.loading && !priceRouter.bestSource && mintValid) {
      onOracleTypeChange("admin");
    }
  }, [mode, priceRouter.loading, priceRouter.bestSource, mintValid, onOracleTypeChange]);

  const oracleOptions = [
    {
      key: "pyth" as const,
      label: "PYTH NETWORK",
      desc: "Off-chain price feed",
      detail: "Best for: major tokens with Pyth price feeds",
      note: "● Recommended if Pyth feed found",
    },
    {
      key: "hyperp_ema" as const,
      label: "HYPERP EMA",
      desc: "On-chain DEX pool EMA",
      detail: "Best for: new/long-tail tokens",
      note: "● Auto-selected if DEX pool detected",
    },
  ] as const;

  // Determine badge type
  const badgeType = priceRouter.loading
    ? "loading"
    : priceRouter.bestSource?.type === "pyth"
      ? "pyth"
      : priceRouter.bestSource?.type === "dex"
        ? "dex"
        : oracleType === "admin"
          ? "admin"
          : mintValid
            ? "none"
            : "loading";

  return (
    <div className="space-y-5">
      <p className="text-[13px] text-[var(--text-secondary)]">
        How should this market price be determined?
      </p>

      {/* Oracle type cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {oracleOptions.map((opt) => {
          const selected = oracleType === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                onOracleTypeChange(opt.key);
                // Reset feed when switching
                onOracleFeedChange("");
                setSelectedPythFeedName(null);
                setSelectedDexPool(null);
                setDexPoolInput("");
              }}
              className={`p-4 text-left border transition-all ${
                selected
                  ? "border-[var(--accent)]/60 bg-[var(--accent)]/[0.06]"
                  : "border-[var(--border)] bg-transparent hover:border-[var(--accent)]/20"
              }`}
            >
              <p
                className={`text-[12px] font-semibold uppercase tracking-[0.05em] ${
                  selected ? "text-white" : "text-[var(--text)]"
                }`}
              >
                {opt.label}
              </p>
              <div className="mt-1 h-px bg-[var(--border)]" />
              <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                {opt.desc}
              </p>
              <p className="mt-1 text-[10px] text-[var(--text-dim)]">{opt.detail}</p>
              <p
                className={`mt-2 text-[9px] ${
                  selected ? "text-[var(--accent)]" : "text-[var(--text-dim)]"
                }`}
              >
                {opt.note}
              </p>
            </button>
          );
        })}
      </div>

      {/* Auto-detection badge */}
      <OracleBadge
        type={badgeType}
        label={
          priceRouter.bestSource?.pairLabel ||
          selectedPythFeedName ||
          selectedDexPool?.pairLabel ||
          undefined
        }
        feedId={
          priceRouter.bestSource?.address ||
          oracleFeed ||
          undefined
        }
      />

      {/* Manual mode: Pyth feed search */}
      {mode === "manual" && oracleType === "pyth" && (
        <div className="space-y-2">
          <label
            htmlFor="pyth-feed"
            className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]"
          >
            Pyth Feed ID
          </label>
          {pythFeeds.length > 0 && !oracleFeed && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {pythFeeds.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    onOracleFeedChange(f.id);
                    setSelectedPythFeedName(f.displayName);
                    onPythDetected({ id: f.id, name: f.displayName });
                  }}
                  className="flex w-full items-center justify-between border border-[var(--border)] px-3 py-2 text-left text-[12px] hover:border-[var(--accent)]/30 hover:bg-[var(--accent)]/[0.04] transition-colors"
                >
                  <span className="font-medium text-[var(--text)]">{f.displayName}</span>
                  <span className="font-mono text-[10px] text-[var(--text-dim)]">
                    {f.id.slice(0, 12)}...
                  </span>
                </button>
              ))}
            </div>
          )}
          {pythLoading && (
            <p className="text-[10px] text-[var(--text-dim)]">Searching Pyth feeds...</p>
          )}
          {selectedPythFeedName && oracleFeed && (
            <div className="flex items-center justify-between border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-2.5">
              <span className="text-[12px] font-medium text-[var(--accent)]">
                {selectedPythFeedName}
              </span>
              <button
                type="button"
                onClick={() => {
                  onOracleFeedChange("");
                  setSelectedPythFeedName(null);
                  onPythDetected(null);
                }}
                className="text-[10px] text-[var(--accent)] hover:underline"
              >
                Change
              </button>
            </div>
          )}
          <input
            id="pyth-feed"
            type="text"
            value={oracleFeed}
            onChange={(e) => {
              onOracleFeedChange(e.target.value.trim());
              setSelectedPythFeedName(null);
            }}
            placeholder="64 hex characters or search by symbol above"
            className={`w-full border px-3 py-2.5 text-[12px] font-mono transition-colors focus:outline-none ${
              oracleFeed && !isValidHex64(oracleFeed)
                ? "border-[var(--short)]/40 bg-[var(--short)]/[0.04]"
                : "border-[var(--border)] bg-[var(--bg)]"
            } text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40`}
          />
        </div>
      )}

      {/* Manual mode: DEX pool input */}
      {mode === "manual" && oracleType === "hyperp_ema" && (
        <div className="space-y-2">
          <label
            htmlFor="dex-pool"
            className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]"
          >
            DEX Pool Address
          </label>
          {dexPools.length > 0 && !dexPoolInput && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {dexPools.map((pool) => (
                <button
                  key={pool.poolAddress}
                  type="button"
                  onClick={() => {
                    onOracleFeedChange(pool.poolAddress);
                    setSelectedDexPool(pool);
                    setDexPoolInput(pool.poolAddress);
                    onDexPoolDetected(pool);
                  }}
                  className="flex w-full items-center justify-between border border-[var(--border)] px-3 py-2 text-left text-[12px] hover:border-[var(--accent)]/30 hover:bg-[var(--accent)]/[0.04] transition-colors"
                >
                  <div>
                    <span className="font-medium text-[var(--text)]">{pool.pairLabel}</span>
                    <span className="ml-2 text-[10px] text-[var(--text-dim)] capitalize">
                      {pool.dexId}
                    </span>
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)]">
                    ${pool.liquidityUsd.toLocaleString()} liq
                  </span>
                </button>
              ))}
            </div>
          )}
          {dexPoolsLoading && (
            <p className="text-[10px] text-[var(--text-dim)]">Searching DEX pools...</p>
          )}
          {selectedDexPool && dexPoolInput && (
            <div className="flex items-center justify-between border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-2.5">
              <span className="text-[12px] font-medium text-[var(--accent)]">
                {selectedDexPool.pairLabel}{" "}
                <span className="capitalize text-[10px]">{selectedDexPool.dexId}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  onOracleFeedChange("");
                  setSelectedDexPool(null);
                  setDexPoolInput("");
                  onDexPoolDetected(null);
                }}
                className="text-[10px] text-[var(--accent)] hover:underline"
              >
                Change
              </button>
            </div>
          )}
          <input
            id="dex-pool"
            type="text"
            value={dexPoolInput || oracleFeed}
            onChange={(e) => {
              const val = e.target.value.trim();
              setDexPoolInput(val);
              onOracleFeedChange(val);
              setSelectedDexPool(null);
            }}
            placeholder="Paste Raydium/Orca pool address..."
            className={`w-full border px-3 py-2.5 text-[12px] font-mono transition-colors focus:outline-none ${
              (dexPoolInput || oracleFeed) && !isValidBase58Pubkey(dexPoolInput || oracleFeed)
                ? "border-[var(--short)]/40 bg-[var(--short)]/[0.04]"
                : "border-[var(--border)] bg-[var(--bg)]"
            } text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40`}
          />
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="border border-[var(--border)] bg-transparent px-5 py-3 text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hud-btn-corners hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
        >
          ← BACK
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50"
        >
          CONTINUE →
        </button>
      </div>
    </div>
  );
};
