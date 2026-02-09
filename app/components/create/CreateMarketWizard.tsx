"use client";

import { FC, useState, useMemo, useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import Link from "next/link";
import { useCreateMarket, type CreateMarketParams } from "@/hooks/useCreateMarket";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { usePythFeedSearch } from "@/hooks/usePythFeedSearch";
import { useDexPoolSearch, type DexPoolResult } from "@/hooks/useDexPoolSearch";
import { usePriceRouter, type PriceSource } from "@/hooks/usePriceRouter";
import { useQuickLaunch } from "@/hooks/useQuickLaunch";
import { parseHumanAmount, formatHumanAmount } from "@/lib/parseAmount";
import { SLAB_TIERS, type SlabTierKey } from "@percolator/core";

function isValidBase58Pubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function isValidHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

interface StepProps {
  open: boolean;
  onToggle: () => void;
  title: string;
  stepNum: number;
  valid: boolean;
  children: React.ReactNode;
}

const StepSection: FC<StepProps> = ({ open, onToggle, title, stepNum, valid, children }) => (
  <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl shadow-sm">
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between px-5 py-4 text-left"
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
            valid ? "bg-[#00FFB2]/[0.1] text-[#00FFB2]" : "bg-white/[0.05] text-[#8B95B0]"
          }`}
        >
          {valid ? "\u2713" : stepNum}
        </span>
        <span className="text-sm font-semibold text-[#F0F4FF]">{title}</span>
      </div>
      <svg
        className={`h-4 w-4 text-[#8B95B0] transition-transform ${open ? "rotate-180" : ""}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    {open && <div className="border-t border-white/[0.06] px-5 py-4">{children}</div>}
  </div>
);

const FieldHint: FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="mt-1 text-xs text-[#5a6382]">{children}</p>
);

/** Quick Launch sub-component */
const QuickLaunchPanel: FC<{
  onFallbackToManual: (mint: string, pool: DexPoolResult | null) => void;
}> = ({ onFallbackToManual }) => {
  const { publicKey } = useWallet();
  const { state, create, reset } = useCreateMarket();
  const [quickMint, setQuickMint] = useState("");
  const [quickSlabTier, setQuickSlabTier] = useState<SlabTierKey>("small");
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Overridable params — initialized from auto-config when it loads
  const [tradingFeeBps, setTradingFeeBps] = useState<number | null>(null);
  const [initialMarginBps, setInitialMarginBps] = useState<number | null>(null);
  const [lpCollateral, setLpCollateral] = useState<string | null>(null);
  const [insuranceAmount, setInsuranceAmount] = useState("100");
  const [manualPrice, setManualPrice] = useState("1.000000");
  const quickLaunch = useQuickLaunch(quickMint.length >= 32 ? quickMint : null);

  // Sync defaults from auto-config
  useEffect(() => {
    if (quickLaunch.config) {
      if (tradingFeeBps === null) setTradingFeeBps(quickLaunch.config.tradingFeeBps);
      if (initialMarginBps === null) setInitialMarginBps(quickLaunch.config.initialMarginBps);
      if (lpCollateral === null) setLpCollateral(quickLaunch.config.lpCollateral);
    }
  }, [quickLaunch.config]);

  // vAMM state
  const [enableVamm, setEnableVamm] = useState(false);
  const [vammSpreadBps, setVammSpreadBps] = useState(10);
  const [vammImpactKBps, setVammImpactKBps] = useState(100);
  const [vammMaxTotalBps, setVammMaxTotalBps] = useState(200);
  const [vammLiquidityE6, setVammLiquidityE6] = useState("10000000");

  const effectiveTradingFee = tradingFeeBps ?? quickLaunch.config?.tradingFeeBps ?? 30;
  const effectiveMargin = initialMarginBps ?? quickLaunch.config?.initialMarginBps ?? 1000;
  const effectiveLpCollateral = lpCollateral ?? quickLaunch.config?.lpCollateral ?? "1000000";
  const effectiveMaxLeverage = Math.floor(10000 / effectiveMargin);

  const handleQuickCreate = () => {
    if (!quickLaunch.config || !publicKey) return;

    const c = quickLaunch.config;
    const pool = quickLaunch.poolInfo;
    const tier = SLAB_TIERS[quickSlabTier];

    let oracleFeed: string;
    let priceE6: number;

    if (pool) {
      // DEX pool found — use pool address as oracle feed
      const poolPk = new PublicKey(pool.poolAddress);
      oracleFeed = Array.from(poolPk.toBytes())
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      priceE6 = Math.round(pool.priceUsd * 1_000_000);
    } else {
      // No pool (devnet / new token) — admin oracle mode (all zeros)
      oracleFeed = "0".repeat(64);
      const parsed = parseFloat(manualPrice);
      priceE6 = isNaN(parsed) ? 1_000_000 : Math.round(parsed * 1_000_000);
    }

    const params: CreateMarketParams = {
      mint: new PublicKey(c.mint),
      initialPriceE6: BigInt(priceE6 > 0 ? priceE6 : 1_000_000),
      lpCollateral: parseHumanAmount(effectiveLpCollateral, c.decimals),
      insuranceAmount: parseHumanAmount(insuranceAmount, c.decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: effectiveTradingFee,
      initialMarginBps: effectiveMargin,
      maxAccounts: tier.maxAccounts,
      slabDataSize: tier.dataSize,
      symbol: c.symbol ?? "UNKNOWN",
      name: c.name ?? "Unknown Token",
      decimals: c.decimals ?? 6,
      ...(enableVamm && {
        vammParams: {
          spreadBps: vammSpreadBps,
          impactKBps: vammImpactKBps,
          maxTotalBps: vammMaxTotalBps,
          liquidityE6: vammLiquidityE6,
        },
      }),
    };
    create(params);
  };

  // Show creation progress
  if (state.loading || state.step > 0 || state.error) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-[#F0F4FF]">Quick Launch — Creating Market</h2>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => {
              let status: "pending" | "active" | "done" | "error" = "pending";
              if (state.step > i || state.step === 5) status = "done";
              else if (state.step === i && state.loading) status = "active";
              else if (state.step === i && state.error) status = "error";
              const labels = ["Create slab account", "Initialize market & vault", "Oracle setup & crank", "Initialize LP", "Deposit, insurance & finalize"];
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                    {status === "done" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-900/40 text-xs text-[#00FFB2]">&#10003;</span>}
                    {status === "active" && <span className="flex h-6 w-6 items-center justify-center"><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.06] border-t-[#F0F4FF]" /></span>}
                    {status === "error" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-900/40 text-xs text-red-400">!</span>}
                    {status === "pending" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.05] text-xs text-[#5a6382]">{i + 1}</span>}
                  </div>
                  <span className={`text-sm ${status === "done" ? "text-[#00FFB2]" : status === "active" ? "font-medium text-[#F0F4FF]" : status === "error" ? "text-red-400" : "text-[#5a6382]"}`}>{labels[i]}</span>
                </div>
              );
            })}
          </div>
          {state.error && (
            <div className="mt-4 rounded-lg bg-red-900/20 p-3">
              <p className="text-sm text-red-400">{state.error}</p>
              <div className="mt-3 flex gap-2">
                <button onClick={reset} className="rounded-lg bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-[#F0F4FF] hover:bg-white/[0.03]">Start over</button>
              </div>
            </div>
          )}
          {state.step === 5 && state.slabAddress && (
            <div className="mt-6 rounded-xl bg-[#00d4aa]/5 p-6 text-center ring-1 ring-[#00d4aa]/20">
              <div className="mb-2 text-3xl">🎉</div>
              <h3 className="mb-1 text-lg font-bold text-white">Market is live!</h3>
              <p className="mb-1 text-sm text-[#b0b7c8]">Your perpetual futures market has been deployed.</p>
              <p className="mb-4 font-mono text-[11px] text-[#4a5068] break-all">{state.slabAddress}</p>
              <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                <Link href={`/trade/${state.slabAddress}`} className="rounded-lg bg-[#00d4aa] px-6 py-2.5 text-sm font-bold text-[#080a0f] transition-all hover:bg-[#00e8bb]">
                  Start Trading →
                </Link>
                <button onClick={reset} className="rounded-lg bg-white/[0.05] px-6 py-2.5 text-sm font-medium text-[#F0F4FF] hover:bg-white/[0.03]">Create another</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6 shadow-sm space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[#F0F4FF] mb-1">⚡ Quick Launch</h3>
        <p className="text-xs text-[#5a6382]">Paste a token mint → we auto-detect the DEX pool and set optimal risk params. One click to deploy.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-[#F0F4FF]">Token Mint Address</label>
        <input
          type="text"
          value={quickMint}
          onChange={(e) => setQuickMint(e.target.value.trim())}
          placeholder="Paste any Solana token mint..."
          className="mt-1 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 font-mono text-xs text-[#F0F4FF] placeholder:text-[#5a6382] focus:border-[#00FFB2]/40 focus:outline-none"
        />
      </div>

      {/* Slab Tier Selector */}
      <div>
        <label className="block text-sm font-medium text-[#F0F4FF] mb-2">Market Size</label>
        <div className="grid grid-cols-4 gap-2">
          {(Object.entries(SLAB_TIERS) as [SlabTierKey, typeof SLAB_TIERS[SlabTierKey]][]).map(([key, tier]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQuickSlabTier(key)}
              className={`rounded-lg border p-2 text-center transition-colors ${
                quickSlabTier === key
                  ? "border-[#00FFB2]/40 bg-[#00FFB2]/[0.08] shadow-[0_0_20px_rgba(0,255,178,0.1)]"
                  : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.1]"
              }`}
            >
              <p className={`text-xs font-semibold ${quickSlabTier === key ? "text-[#00FFB2]" : "text-[#F0F4FF]"}`}>{tier.label}</p>
              <p className="text-[10px] text-[#5a6382]">{tier.maxAccounts} slots</p>
            </button>
          ))}
        </div>
      </div>

      {quickLaunch.loading && (
        <div className="flex items-center gap-2 text-[#8B95B0]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.06] border-t-[#F0F4FF]" />
          <span className="text-xs">Auto-detecting token &amp; DEX pool...</span>
        </div>
      )}

      {quickLaunch.error && (
        <p className="text-xs text-red-400">{quickLaunch.error}</p>
      )}

      {!quickLaunch.config && !quickLaunch.loading && !quickLaunch.error && quickMint.length >= 32 && (
        <p className="text-xs text-amber-400">Could not load token info. Check the mint address and try again.</p>
      )}

      {quickLaunch.config && !quickLaunch.loading && (
        <>
          {/* Detected info */}
          <div className="rounded-lg bg-[#00FFB2]/[0.08] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-[#F0F4FF]">{quickLaunch.config.symbol}</span>
                <span className="ml-2 text-xs text-[#8B95B0]">{quickLaunch.config.name}</span>
              </div>
              {quickLaunch.poolInfo && (
                <span className="text-xs text-[#00FFB2]">
                  {quickLaunch.poolInfo.pairLabel} · ${quickLaunch.poolInfo.liquidityUsd.toLocaleString()} liq
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] text-[#5a6382]">Fee</p>
                <p className="text-xs font-medium text-[#F0F4FF]">{effectiveTradingFee} bps</p>
              </div>
              <div>
                <p className="text-[10px] text-[#5a6382]">Margin</p>
                <p className="text-xs font-medium text-[#F0F4FF]">{effectiveMargin} bps</p>
              </div>
              <div>
                <p className="text-[10px] text-[#5a6382]">Leverage</p>
                <p className="text-xs font-medium text-[#F0F4FF]">{effectiveMaxLeverage}x</p>
              </div>
            </div>
          </div>

          {/* Advanced Settings */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-[#8B95B0] hover:text-[#a1a1aa] transition-colors"
          >
            <span className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}>▶</span>
            Advanced Settings
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Trading Fee (bps)</label>
                  <input
                    type="number"
                    value={effectiveTradingFee}
                    onChange={(e) => setTradingFeeBps(Math.max(1, Math.min(1000, Number(e.target.value))))}
                    className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                  />
                  <p className="mt-0.5 text-[9px] text-[#5a6382]">{(effectiveTradingFee / 100).toFixed(2)}% per trade</p>
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Initial Margin (bps)</label>
                  <input
                    type="number"
                    value={effectiveMargin}
                    onChange={(e) => setInitialMarginBps(Math.max(100, Math.min(10000, Number(e.target.value))))}
                    className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                  />
                  <p className="mt-0.5 text-[9px] text-[#5a6382]">Max {effectiveMaxLeverage}x leverage</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">LP Collateral</label>
                  <input
                    type="text"
                    value={effectiveLpCollateral}
                    onChange={(e) => setLpCollateral(e.target.value.replace(/[^0-9]/g, ""))}
                    className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                  />
                  <p className="mt-0.5 text-[9px] text-[#5a6382]">Base units deposited as LP</p>
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Insurance Fund</label>
                  <input
                    type="text"
                    value={insuranceAmount}
                    onChange={(e) => setInsuranceAmount(e.target.value.replace(/[^0-9]/g, ""))}
                    className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                  />
                  <p className="mt-0.5 text-[9px] text-[#5a6382]">Base units for insurance</p>
                </div>
              </div>

              {/* vAMM Toggle */}
              <div className="border-t border-white/[0.06] pt-3">
                <label className="flex items-center gap-2 text-sm text-[#F0F4FF]">
                  <input
                    type="checkbox"
                    checked={enableVamm}
                    onChange={(e) => setEnableVamm(e.target.checked)}
                    className="rounded border-white/[0.06]"
                  />
                  Enable vAMM LP
                </label>
                <p className="mt-0.5 text-[9px] text-[#5a6382]">Virtual AMM with spread/impact pricing. Provides tighter quotes than passive LP for liquid markets.</p>
              </div>

              {enableVamm && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Base Spread (bps)</label>
                    <input
                      type="number"
                      value={vammSpreadBps}
                      onChange={(e) => setVammSpreadBps(Math.max(1, Math.min(500, Number(e.target.value))))}
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                    />
                    <p className="mt-0.5 text-[9px] text-[#5a6382]">{(vammSpreadBps / 100).toFixed(2)}% minimum spread</p>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Impact K (bps)</label>
                    <input
                      type="number"
                      value={vammImpactKBps}
                      onChange={(e) => setVammImpactKBps(Math.max(1, Math.min(1000, Number(e.target.value))))}
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                    />
                    <p className="mt-0.5 text-[9px] text-[#5a6382]">Price impact coefficient</p>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Max Total (bps)</label>
                    <input
                      type="number"
                      value={vammMaxTotalBps}
                      onChange={(e) => setVammMaxTotalBps(Math.max(10, Math.min(1000, Number(e.target.value))))}
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                    />
                    <p className="mt-0.5 text-[9px] text-[#5a6382]">Cap on spread + impact + fee</p>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Liquidity (notional)</label>
                    <input
                      type="text"
                      value={vammLiquidityE6}
                      onChange={(e) => setVammLiquidityE6(e.target.value.replace(/[^0-9]/g, ""))}
                      className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                    />
                    <p className="mt-0.5 text-[9px] text-[#5a6382]">Virtual liquidity depth (e6)</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!quickLaunch.poolInfo && (
            <div className="space-y-3">
              <div className="rounded-lg bg-amber-900/20 p-3">
                <p className="text-xs text-amber-400">No DEX pool found — using admin oracle mode. Set an initial price below.</p>
              </div>
              <div>
                <label className="block text-[10px] font-medium text-[#8B95B0] mb-1">Initial Price (USD)</label>
                <input
                  type="text"
                  value={manualPrice}
                  onChange={(e) => setManualPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="1.000000"
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-sm text-[#F0F4FF] focus:border-[#00FFB2]/40 focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* Estimated cost */}
          <div className="rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/[0.06]">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#5a6382]">Estimated SOL cost</span>
              <span className="data-cell text-sm font-bold text-[#F0F4FF]">
                ~{quickSlabTier === "small" ? "0.5" : quickSlabTier === "medium" ? "1.8" : quickSlabTier === "large" ? "7.0" : "7.0"} SOL
              </span>
            </div>
            <p className="mt-1 text-[9px] text-[#5a6382]">Slab rent + transaction fees. Rent is recoverable if market is closed.</p>
          </div>

          <button
            onClick={handleQuickCreate}
            disabled={!publicKey || !quickLaunch.config}
            className="w-full rounded-xl bg-gradient-to-r from-[#00FFB2] to-[#00d4aa] py-3 text-sm font-bold text-[#06080d] transition-all hover:shadow-[0_0_40px_rgba(0,255,178,0.25)] disabled:cursor-not-allowed disabled:bg-white/[0.03] disabled:bg-none disabled:text-[#5a6382]"
          >
            {!publicKey ? "Connect wallet to launch" : "🚀 Launch Market"}
          </button>
        </>
      )}
    </div>
  );
};

export const CreateMarketWizard: FC = () => {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { state, create, reset } = useCreateMarket();

  const [wizardMode, setWizardMode] = useState<"quick" | "manual">("quick");
  const [mint, setMint] = useState("");
  const [oracleMode, setOracleMode] = useState<"auto" | "pyth" | "dex">("auto");
  const [feedId, setFeedId] = useState("");
  const [selectedFeedName, setSelectedFeedName] = useState<string | null>(null);
  const [selectedDexPool, setSelectedDexPool] = useState<DexPoolResult | null>(null);
  const [dexPoolAddress, setDexPoolAddress] = useState("");
  const [invert, setInvert] = useState(false);

  const [slabTier, setSlabTier] = useState<SlabTierKey>("small");
  const [tradingFeeBps, setTradingFeeBps] = useState(30);
  const [initialMarginBps, setInitialMarginBps] = useState(1000);

  const [lpCollateral, setLpCollateral] = useState("");
  const [insuranceAmount, setInsuranceAmount] = useState("");
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const [openStep, setOpenStep] = useState(1);

  // vAMM state (manual wizard)
  const [enableVammManual, setEnableVammManual] = useState(false);
  const [vammSpreadBpsManual, setVammSpreadBpsManual] = useState(10);
  const [vammImpactKBpsManual, setVammImpactKBpsManual] = useState(100);
  const [vammMaxTotalBpsManual, setVammMaxTotalBpsManual] = useState(200);
  const [vammLiquidityE6Manual, setVammLiquidityE6Manual] = useState("10000000");

  const mintValid = isValidBase58Pubkey(mint);
  const mintPk = useMemo(() => (mintValid ? new PublicKey(mint) : null), [mint, mintValid]);
  const tokenMeta = useTokenMeta(mintPk);
  const decimals = tokenMeta?.decimals ?? 6;
  const symbol = tokenMeta?.symbol ?? "Token";

  const pythQuery = oracleMode === "pyth" && tokenMeta?.symbol ? tokenMeta.symbol : "";
  const { feeds: pythFeeds, loading: pythLoading } = usePythFeedSearch(pythQuery);

  const dexSearchMint = oracleMode === "dex" && mintValid ? mint : null;
  const { pools: dexPools, loading: dexPoolsLoading } = useDexPoolSearch(dexSearchMint);

  // Smart Price Router — auto mode
  const autoRouterMint = oracleMode === "auto" && mintValid ? mint : null;
  const priceRouter = usePriceRouter(autoRouterMint);

  // Auto-apply best source when resolved
  useEffect(() => {
    if (oracleMode !== "auto" || !priceRouter.bestSource) return;
    const best = priceRouter.bestSource;
    if (best.type === "pyth") {
      setFeedId(best.address);
      setSelectedFeedName(best.pairLabel || "Pyth Feed");
    } else if (best.type === "dex") {
      setDexPoolAddress(best.address);
      setSelectedDexPool({
        poolAddress: best.address,
        dexId: best.dexId || "unknown",
        pairLabel: best.pairLabel || "DEX Pool",
        liquidityUsd: best.liquidity,
        priceUsd: best.price,
      });
    }
  }, [oracleMode, priceRouter.bestSource]);

  const dexPoolValid = (oracleMode === "dex" || oracleMode === "auto") && isValidBase58Pubkey(dexPoolAddress);
  const autoResolved = oracleMode === "auto" && priceRouter.bestSource !== null;
  const autoOracleValid = oracleMode === "auto"
    ? autoResolved && (priceRouter.bestSource!.type === "pyth" ? isValidHex64(feedId) : isValidBase58Pubkey(dexPoolAddress))
    : true;
  const feedValid = oracleMode === "dex" || oracleMode === "auto" || isValidHex64(feedId);
  const dexValid = (oracleMode !== "dex" && oracleMode !== "auto") || dexPoolValid || (oracleMode === "auto" && priceRouter.bestSource?.type === "pyth");
  const step1Valid = mintValid && (oracleMode === "auto" ? autoOracleValid : feedValid && dexValid);

  const maintenanceMarginBps = Math.floor(initialMarginBps / 2);
  const maxLeverage = Math.floor(10000 / initialMarginBps);
  const step2Valid = tradingFeeBps >= 1 && tradingFeeBps <= 100 && initialMarginBps >= 100 && initialMarginBps <= 5000;

  const lpValid = lpCollateral !== "" && !isNaN(Number(lpCollateral)) && Number(lpCollateral) > 0;
  const insValid = insuranceAmount !== "" && !isNaN(Number(insuranceAmount)) && Number(insuranceAmount) > 0;
  const step3Valid = lpValid && insValid;

  const allValid = step1Valid && step2Valid && step3Valid;

  const lpNative = useMemo(() => {
    try { return lpValid ? parseHumanAmount(lpCollateral, decimals) : 0n; } catch { return 0n; }
  }, [lpCollateral, decimals, lpValid]);
  const insNative = useMemo(() => {
    try { return insValid ? parseHumanAmount(insuranceAmount, decimals) : 0n; } catch { return 0n; }
  }, [insuranceAmount, decimals, insValid]);
  const combinedNative = lpNative + insNative;

  const balanceWarning = tokenBalance !== null && combinedNative > 0n && combinedNative > (tokenBalance * 80n) / 100n;

  useEffect(() => {
    if (!publicKey || !mintValid) {
      setTokenBalance(null);
      return;
    }
    let cancelled = false;
    setBalanceLoading(true);

    (async () => {
      try {
        const pk = new PublicKey(mint);
        const ata = await getAssociatedTokenAddress(pk, publicKey);
        const account = await getAccount(connection, ata);
        if (!cancelled) setTokenBalance(account.amount);
      } catch {
        if (!cancelled) setTokenBalance(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [connection, publicKey, mint, mintValid]);

  const getOracleFeedAndPrice = (): { oracleFeed: string; priceE6: bigint } => {
    if (oracleMode === "auto" && priceRouter.bestSource) {
      if (priceRouter.bestSource.type === "pyth") {
        return { oracleFeed: feedId, priceE6: 0n };
      }
      // dex or jupiter — use pool address
      const pk = new PublicKey(dexPoolAddress);
      const hex = Array.from(pk.toBytes())
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return { oracleFeed: hex, priceE6: 0n };
    }
    if (oracleMode === "dex") {
      const pk = new PublicKey(dexPoolAddress);
      const hex = Array.from(pk.toBytes())
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return { oracleFeed: hex, priceE6: 0n };
    }
    return { oracleFeed: feedId, priceE6: 0n };
  };

  const handleCreate = () => {
    if (!allValid) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    const selectedTier = SLAB_TIERS[slabTier];
    const params: CreateMarketParams = {
      mint: new PublicKey(mint),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(lpCollateral, decimals),
      insuranceAmount: parseHumanAmount(insuranceAmount, decimals),
      oracleFeed,
      invert,
      tradingFeeBps,
      initialMarginBps,
      maxAccounts: selectedTier.maxAccounts,
      slabDataSize: selectedTier.dataSize,
      symbol: symbol || "UNKNOWN",
      name: tokenMeta?.name || "Unknown Token",
      decimals: decimals,
      ...(enableVammManual && {
        vammParams: {
          spreadBps: vammSpreadBpsManual,
          impactKBps: vammImpactKBpsManual,
          maxTotalBps: vammMaxTotalBpsManual,
          liquidityE6: vammLiquidityE6Manual,
        },
      }),
    };
    create(params);
  };

  const handleRetry = () => {
    if (!allValid || !state.slabAddress) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    const selectedTier = SLAB_TIERS[slabTier];
    const params: CreateMarketParams = {
      mint: new PublicKey(mint),
      initialPriceE6: priceE6,
      lpCollateral: parseHumanAmount(lpCollateral, decimals),
      insuranceAmount: parseHumanAmount(insuranceAmount, decimals),
      oracleFeed,
      invert,
      tradingFeeBps,
      initialMarginBps,
      maxAccounts: selectedTier.maxAccounts,
      slabDataSize: selectedTier.dataSize,
      ...(enableVammManual && {
        vammParams: {
          spreadBps: vammSpreadBpsManual,
          impactKBps: vammImpactKBpsManual,
          maxTotalBps: vammMaxTotalBpsManual,
          liquidityE6: vammLiquidityE6Manual,
        },
      }),
    };
    create(params, state.step);
  };

  const handleFallbackToManual = (fallbackMint: string, pool: DexPoolResult | null) => {
    setWizardMode("manual");
    setMint(fallbackMint);
    if (pool) {
      setDexPoolAddress(pool.poolAddress);
      setSelectedDexPool(pool);
    }
    setOracleMode("dex");
    setOpenStep(1);
  };

  if (state.loading || state.step > 0 || state.error) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-[#F0F4FF]">Creating Market</h2>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => {
              let status: "pending" | "active" | "done" | "error" = "pending";
              if (state.step > i || state.step === 5) status = "done";
              else if (state.step === i && state.loading) status = "active";
              else if (state.step === i && state.error) status = "error";
              const labels = ["Create slab account", "Initialize market & vault", "Oracle setup & crank", "Initialize LP", "Deposit, insurance & finalize"];
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                    {status === "done" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-900/40 text-xs text-[#00FFB2]">&#10003;</span>}
                    {status === "active" && <span className="flex h-6 w-6 items-center justify-center"><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.06] border-t-[#F0F4FF]" /></span>}
                    {status === "error" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-900/40 text-xs text-red-400">!</span>}
                    {status === "pending" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.05] text-xs text-[#5a6382]">{i + 1}</span>}
                  </div>
                  <span className={`text-sm ${status === "done" ? "text-[#00FFB2]" : status === "active" ? "font-medium text-[#F0F4FF]" : status === "error" ? "text-red-400" : "text-[#5a6382]"}`}>{labels[i]}</span>
                </div>
              );
            })}
          </div>
          {state.error && (
            <div className="mt-4 rounded-lg bg-red-900/20 p-3">
              <p className="text-sm text-red-400">{state.error}</p>
              <div className="mt-3 flex gap-2">
                <button onClick={handleRetry} className="rounded-lg bg-[#FF4466] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#FF4466]/80">Retry from step {state.step + 1}</button>
                <button onClick={reset} className="rounded-lg bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-[#F0F4FF] hover:bg-white/[0.03]">Start over</button>
              </div>
            </div>
          )}
          {state.step === 5 && state.slabAddress && (
            <div className="mt-6 rounded-xl bg-[#00d4aa]/5 p-6 text-center ring-1 ring-[#00d4aa]/20">
              <div className="mb-2 text-3xl">🎉</div>
              <h3 className="mb-1 text-lg font-bold text-white">Market is live!</h3>
              <p className="mb-1 text-sm text-[#b0b7c8]">Your perpetual futures market has been deployed.</p>
              <p className="mb-4 font-mono text-[11px] text-[#4a5068] break-all">{state.slabAddress}</p>
              <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                <Link href={`/trade/${state.slabAddress}`} className="rounded-lg bg-[#00d4aa] px-6 py-2.5 text-sm font-bold text-[#080a0f] transition-all hover:bg-[#00e8bb]">
                  Start Trading →
                </Link>
                <button onClick={reset} className="rounded-lg bg-white/[0.05] px-6 py-2.5 text-sm font-medium text-[#F0F4FF] hover:bg-white/[0.03]">Create another</button>
              </div>
            </div>
          )}
          {state.txSigs.length > 0 && (
            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <p className="text-xs font-medium text-[#8B95B0] uppercase">Transaction signatures</p>
              <div className="mt-1 space-y-1">
                {state.txSigs.map((sig, i) => <p key={i} className="font-mono text-xs text-[#8B95B0] truncate">{sig}</p>)}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Mode Switcher */}
      <div className="flex rounded-xl border border-white/[0.06] bg-white/[0.03] p-1">
        <button
          type="button"
          onClick={() => setWizardMode("quick")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
            wizardMode === "quick"
              ? "bg-[#00FFB2] text-[#06080d] font-bold"
              : "text-[#8B95B0] hover:text-[#F0F4FF]"
          }`}
        >
          ⚡ Quick Launch
        </button>
        <button
          type="button"
          onClick={() => setWizardMode("manual")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
            wizardMode === "manual"
              ? "bg-[#00FFB2] text-[#06080d] font-bold"
              : "text-[#8B95B0] hover:text-[#F0F4FF]"
          }`}
        >
          🔧 Manual Setup
        </button>
      </div>

      {wizardMode === "quick" && (
        <QuickLaunchPanel onFallbackToManual={handleFallbackToManual} />
      )}

      {wizardMode === "manual" && <>
      <StepSection open={openStep === 1} onToggle={() => setOpenStep(openStep === 1 ? 0 : 1)} title="Token & Oracle" stepNum={1} valid={step1Valid}>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[#F0F4FF]">Collateral Mint Address</label>
            <FieldHint>The SPL token used as collateral. Traders deposit this token and profits/losses are settled in it.</FieldHint>
            <input type="text" value={mint} onChange={(e) => setMint(e.target.value.trim())} placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs text-[#F0F4FF] placeholder:text-[#5a6382] ${mint && !mintValid ? "border-red-500/50 bg-red-900/20" : "border-white/[0.06] bg-white/[0.03]"} focus:border-[#00FFB2]/40 focus:outline-none`} />
            {mint && !mintValid && <p className="mt-1 text-xs text-red-400">Invalid base58 public key</p>}
            {tokenMeta && mintValid && (
              <div className="mt-2 flex items-center gap-3 rounded-lg bg-[#00FFB2]/[0.08] p-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#00FFB2]/[0.15] text-xs font-bold text-[#00FFB2]">{tokenMeta.symbol.slice(0, 2)}</div>
                <div>
                  <p className="text-sm font-medium text-[#F0F4FF]">{tokenMeta.name} ({tokenMeta.symbol})</p>
                  <p className="text-xs text-[#8B95B0]">{tokenMeta.decimals} decimals</p>
                </div>
              </div>
            )}
            {balanceLoading && mintValid && <p className="mt-1 text-xs text-[#5a6382]">Loading balance...</p>}
            {tokenBalance !== null && tokenMeta && (
              <p className="mt-1 text-xs text-[#8B95B0]">Your balance: <span className="font-medium text-[#F0F4FF]">{formatHumanAmount(tokenBalance, tokenMeta.decimals)} {tokenMeta.symbol}</span></p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-[#F0F4FF]">Oracle Mode</label>
            <FieldHint><strong>DEX Pool</strong> — uses an on-chain DEX pool as oracle. Works with any token that has a pool. <strong>Pyth</strong> — uses Pyth Network&apos;s decentralized price feeds for major assets.</FieldHint>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => { setOracleMode("auto"); setFeedId(""); setSelectedFeedName(null); setDexPoolAddress(""); setSelectedDexPool(null); }} className={`rounded-lg px-4 py-2 text-sm font-medium ${oracleMode === "auto" ? "bg-[#00FFB2] text-[#06080d] font-bold" : "bg-white/[0.05] text-[#8B95B0] hover:bg-white/[0.03]"}`}>🔍 Auto</button>
              <button type="button" onClick={() => { setOracleMode("dex"); setFeedId(""); setSelectedFeedName(null); }} className={`rounded-lg px-4 py-2 text-sm font-medium ${oracleMode === "dex" ? "bg-[#00FFB2] text-[#06080d] font-bold" : "bg-white/[0.05] text-[#8B95B0] hover:bg-white/[0.03]"}`}>DEX Pool</button>
              <button type="button" onClick={() => { setOracleMode("pyth"); setDexPoolAddress(""); setSelectedDexPool(null); }} className={`rounded-lg px-4 py-2 text-sm font-medium ${oracleMode === "pyth" ? "bg-[#00FFB2] text-[#06080d] font-bold" : "bg-white/[0.05] text-[#8B95B0] hover:bg-white/[0.03]"}`}>Pyth Oracle</button>
            </div>
          </div>
          {oracleMode === "auto" && (
            <div className="space-y-2">
              {priceRouter.loading && (
                <div className="flex items-center gap-2 text-[#8B95B0]">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/[0.06] border-t-[#F0F4FF]" />
                  <span className="text-xs">Finding best oracle source...</span>
                </div>
              )}
              {priceRouter.error && (
                <p className="text-xs text-red-400">Failed to resolve: {priceRouter.error}</p>
              )}
              {!priceRouter.loading && priceRouter.bestSource && (
                <div className="space-y-2">
                  <div className="rounded-lg bg-[#00FFB2]/[0.08] p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-medium uppercase tracking-wider text-[#00FFB2]">Recommended</span>
                        <p className="text-sm font-medium text-[#F0F4FF] mt-0.5">{priceRouter.bestSource.pairLabel}</p>
                      </div>
                      <div className="text-right">
                        <span className="rounded-full bg-[#00FFB2]/20 px-2 py-0.5 text-[10px] font-bold text-[#00FFB2] uppercase">{priceRouter.bestSource.type}</span>
                        {priceRouter.bestSource.price > 0 && (
                          <p className="text-xs text-[#8B95B0] mt-0.5">${priceRouter.bestSource.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>
                        )}
                      </div>
                    </div>
                    {priceRouter.bestSource.liquidity > 0 && priceRouter.bestSource.liquidity !== Infinity && (
                      <p className="text-[10px] text-[#5a6382] mt-1">${priceRouter.bestSource.liquidity.toLocaleString()} liquidity</p>
                    )}
                    <p className="text-[10px] text-[#5a6382]">Confidence: {priceRouter.bestSource.confidence}/100</p>
                  </div>

                  {priceRouter.allSources.length > 1 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-medium text-[#5a6382] uppercase tracking-wider">All sources found ({priceRouter.allSources.length})</p>
                      {priceRouter.allSources.slice(1).map((src, i) => (
                        <div key={i} className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#8B95B0]">{src.type}</span>
                            <span className="text-[#F0F4FF]">{src.pairLabel}</span>
                          </div>
                          <div className="text-right text-[#5a6382]">
                            {src.liquidity > 0 && src.liquidity !== Infinity && <span>${src.liquidity.toLocaleString()} liq</span>}
                            {src.price > 0 && <span className="ml-2">${src.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!priceRouter.loading && !priceRouter.error && !priceRouter.bestSource && mintValid && (
                <p className="text-xs text-amber-400">No oracle sources found. Try DEX Pool or Pyth mode manually.</p>
              )}
            </div>
          )}
          {oracleMode === "pyth" && (
            <div>
              <label className="block text-sm font-medium text-[#F0F4FF]">Pyth Feed ID (hex, 64 chars)</label>
              {pythFeeds.length > 0 && !feedId && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-[#8B95B0]">Select a feed:</p>
                  {pythFeeds.map((f) => (
                    <button key={f.id} type="button" onClick={() => { setFeedId(f.id); setSelectedFeedName(f.displayName); }} className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-left text-sm hover:border-[#00FFB2]/30 hover:bg-[#00FFB2]/[0.08]">
                      <span className="font-medium text-[#F0F4FF]">{f.displayName}</span>
                      <span className="font-mono text-xs text-[#5a6382]">{f.id.slice(0, 12)}...</span>
                    </button>
                  ))}
                </div>
              )}
              {pythLoading && <p className="mt-1 text-xs text-[#5a6382]">Searching Pyth feeds...</p>}
              {!pythLoading && pythFeeds.length === 0 && tokenMeta?.symbol && <p className="mt-1 text-xs text-[#5a6382]">No Pyth feeds found for &ldquo;{tokenMeta.symbol}&rdquo;. Enter a feed ID manually below.</p>}
              {feedId && selectedFeedName && (
                <div className="mt-2 flex items-center justify-between rounded-lg bg-[#00FFB2]/[0.08] p-2">
                  <span className="text-sm font-medium text-[#00FFB2]">{selectedFeedName}</span>
                  <button type="button" onClick={() => { setFeedId(""); setSelectedFeedName(null); }} className="text-xs text-[#00FFB2] hover:underline">Change</button>
                </div>
              )}
              <input type="text" value={feedId} onChange={(e) => { setFeedId(e.target.value.trim()); setSelectedFeedName(null); }} placeholder="e.g. ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs text-[#F0F4FF] placeholder:text-[#5a6382] ${feedId && !feedValid ? "border-red-500/50 bg-red-900/20" : "border-white/[0.06] bg-white/[0.03]"} focus:border-[#00FFB2]/40 focus:outline-none`} />
              {feedId && !feedValid && <p className="mt-1 text-xs text-red-400">Must be exactly 64 hex characters</p>}
              <a href="https://pyth.network/developers/price-feed-ids" target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-[#00FFB2] hover:underline">Browse all Pyth feed IDs</a>
            </div>
          )}
          {oracleMode === "dex" && (
            <div>
              <label className="block text-sm font-medium text-[#F0F4FF]">DEX Pool Address</label>
              <FieldHint>Uses an on-chain DEX pool as the price oracle. Works with any token that has a trading pool on PumpSwap, Raydium, or Meteora. Fully permissionless — no external oracle operator needed.</FieldHint>
              {dexPools.length > 0 && !dexPoolAddress && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-[#8B95B0]">Discovered pools (by liquidity):</p>
                  {dexPools.map((pool) => (
                    <button key={pool.poolAddress} type="button" onClick={() => { setDexPoolAddress(pool.poolAddress); setSelectedDexPool(pool); }} className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-left text-sm hover:border-[#00FFB2]/30 hover:bg-[#00FFB2]/[0.08]">
                      <div>
                        <span className="font-medium text-[#F0F4FF]">{pool.pairLabel}</span>
                        <span className="ml-2 text-xs text-[#5a6382] capitalize">{pool.dexId}</span>
                      </div>
                      <div className="text-right"><span className="text-xs text-[#8B95B0]">${pool.liquidityUsd.toLocaleString()} liq</span></div>
                    </button>
                  ))}
                </div>
              )}
              {dexPoolsLoading && <p className="mt-1 text-xs text-[#5a6382]">Searching DEX pools...</p>}
              {!dexPoolsLoading && dexPools.length === 0 && mintValid && <p className="mt-1 text-xs text-[#5a6382]">No supported DEX pools found. Enter a pool address manually.</p>}
              {dexPoolAddress && selectedDexPool && (
                <div className="mt-2 flex items-center justify-between rounded-lg bg-[#00FFB2]/[0.08] p-2">
                  <div>
                    <span className="text-sm font-medium text-[#00FFB2]">{selectedDexPool.pairLabel}</span>
                    <span className="ml-2 text-xs text-[#00FFB2] capitalize">{selectedDexPool.dexId}</span>
                  </div>
                  <button type="button" onClick={() => { setDexPoolAddress(""); setSelectedDexPool(null); }} className="text-xs text-[#00FFB2] hover:underline">Change</button>
                </div>
              )}
              <input type="text" value={dexPoolAddress} onChange={(e) => { setDexPoolAddress(e.target.value.trim()); setSelectedDexPool(null); }} placeholder="Pool address (base58)" className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs text-[#F0F4FF] placeholder:text-[#5a6382] ${dexPoolAddress && !dexPoolValid ? "border-red-500/50 bg-red-900/20" : "border-white/[0.06] bg-white/[0.03]"} focus:border-[#00FFB2]/40 focus:outline-none`} />
              {dexPoolAddress && !dexPoolValid && <p className="mt-1 text-xs text-red-400">Invalid base58 public key</p>}
            </div>
          )}
          <div>
            <label className="flex items-center gap-2 text-sm text-[#F0F4FF]">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="rounded border-white/[0.06]" />
              Invert price feed
            </label>
            <FieldHint>Enable if the collateral IS the asset being priced (e.g. SOL-denominated SOL/USD market).</FieldHint>
          </div>
        </div>
      </StepSection>

      <StepSection open={openStep === 2} onToggle={() => setOpenStep(openStep === 2 ? 0 : 2)} title="Risk Parameters" stepNum={2} valid={step2Valid}>
        <div className="space-y-4">
          {/* Slab Tier Selector */}
          <div>
            <label className="block text-sm font-medium text-[#F0F4FF] mb-2">Market Capacity (Slab Size)</label>
            <FieldHint>How many trader slots this market supports. Larger = more traders but higher rent cost.</FieldHint>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(Object.entries(SLAB_TIERS) as [SlabTierKey, typeof SLAB_TIERS[SlabTierKey]][]).map(([key, tier]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSlabTier(key)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    slabTier === key
                      ? "border-[#00FFB2]/40 bg-[#00FFB2]/[0.08] shadow-[0_0_20px_rgba(0,255,178,0.1)]"
                      : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.1]"
                  }`}
                >
                  <p className={`text-sm font-semibold ${slabTier === key ? "text-[#00FFB2]" : "text-[#F0F4FF]"}`}>
                    {tier.label}
                  </p>
                  <p className="text-xs text-[#8B95B0]">{tier.description}</p>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#F0F4FF]">Trading Fee: {tradingFeeBps} bps ({(tradingFeeBps / 100).toFixed(2)}%)</label>
            <FieldHint>Fee charged on every trade. 30 bps (0.30%) is standard for most perp exchanges.</FieldHint>
            <input type="range" min={1} max={100} value={tradingFeeBps} onChange={(e) => setTradingFeeBps(Number(e.target.value))} className="mt-1 w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#F0F4FF]">Initial Margin: {initialMarginBps} bps ({(initialMarginBps / 100).toFixed(1)}%)</label>
            <FieldHint>Minimum collateral to open a position as % of notional. {initialMarginBps} bps = {(initialMarginBps / 100).toFixed(0)}% = {maxLeverage}x max leverage.</FieldHint>
            <input type="range" min={100} max={5000} step={100} value={initialMarginBps} onChange={(e) => setInitialMarginBps(Number(e.target.value))} className="mt-1 w-full" />
          </div>
          <div className="grid grid-cols-2 gap-4 rounded-lg bg-white/[0.03] p-3">
            <div>
              <p className="text-xs text-[#8B95B0]">Maintenance Margin</p>
              <p className="text-sm font-medium text-[#F0F4FF]">{(maintenanceMarginBps / 100).toFixed(1)}%</p>
              <p className="text-xs text-[#5a6382]">Positions below this are liquidated</p>
            </div>
            <div>
              <p className="text-xs text-[#8B95B0]">Max Leverage</p>
              <p className="text-sm font-medium text-[#F0F4FF]">{maxLeverage}x</p>
            </div>
          </div>
        </div>
      </StepSection>

      <StepSection open={openStep === 3} onToggle={() => setOpenStep(openStep === 3 ? 0 : 3)} title="Liquidity Setup" stepNum={3} valid={step3Valid}>
        <div className="space-y-4">
          {tokenBalance !== null && tokenMeta && (
            <div className="rounded-lg bg-white/[0.03] p-3">
              <p className="text-xs text-[#8B95B0]">Your balance</p>
              <p className="text-sm font-medium text-[#F0F4FF]">{formatHumanAmount(tokenBalance, tokenMeta.decimals)} {tokenMeta.symbol}</p>
            </div>
          )}
          {balanceLoading && <p className="text-xs text-[#5a6382]">Loading balance...</p>}
          <div>
            <label className="block text-sm font-medium text-[#F0F4FF]">LP Collateral{tokenMeta ? ` (${tokenMeta.symbol})` : ""}</label>
            <FieldHint>Initial liquidity backing the other side of every trade. More collateral = market handles larger positions.</FieldHint>
            <input type="text" value={lpCollateral} onChange={(e) => setLpCollateral(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 1000.00" className="mt-1 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-[#F0F4FF] placeholder:text-[#5a6382] focus:border-[#00FFB2]/40 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#F0F4FF]">Insurance Fund{tokenMeta ? ` (${tokenMeta.symbol})` : ""}</label>
            <FieldHint>Safety buffer absorbing losses from liquidations. More insurance = healthier market.</FieldHint>
            <input type="text" value={insuranceAmount} onChange={(e) => setInsuranceAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 500.00" className="mt-1 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-[#F0F4FF] placeholder:text-[#5a6382] focus:border-[#00FFB2]/40 focus:outline-none" />
          </div>
          {balanceWarning && (
            <div className="rounded-lg bg-amber-900/20 p-3">
              <p className="text-sm text-amber-400">Combined amount exceeds 80% of your token balance.</p>
            </div>
          )}
        </div>
      </StepSection>

      <StepSection open={openStep === 4} onToggle={() => setOpenStep(openStep === 4 ? 0 : 4)} title="Review & Create" stepNum={4} valid={false}>
        <div className="space-y-4">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-white/[0.06]">
              <tr><td className="py-2 text-[#8B95B0]">Mint</td><td className="py-2 text-right text-[#F0F4FF]">{tokenMeta ? <span>{tokenMeta.name} ({tokenMeta.symbol})</span> : mintValid ? <span className="font-mono text-xs">{mint.slice(0, 12)}...</span> : "—"}</td></tr>
              <tr><td className="py-2 text-[#8B95B0]">Oracle</td><td className="py-2 text-right text-[#F0F4FF]">{oracleMode === "auto" && priceRouter.bestSource ? `Auto — ${priceRouter.bestSource.pairLabel} (${priceRouter.bestSource.type})` : oracleMode === "dex" ? selectedDexPool ? `DEX — ${selectedDexPool.pairLabel} (${selectedDexPool.dexId})` : `DEX — ${dexPoolAddress.slice(0, 12)}...` : selectedFeedName ? `Pyth — ${selectedFeedName}` : `Pyth — ${feedId.slice(0, 12)}...`}</td></tr>
              <tr><td className="py-2 text-[#8B95B0]">Inverted</td><td className="py-2 text-right text-[#F0F4FF]">{invert ? "Yes" : "No"}</td></tr>
              <tr><td className="py-2 text-[#8B95B0]">Trading Fee</td><td className="py-2 text-right text-[#F0F4FF]">{tradingFeeBps} bps ({(tradingFeeBps / 100).toFixed(2)}%)</td></tr>
              <tr><td className="py-2 text-[#8B95B0]">Initial Margin</td><td className="py-2 text-right text-[#F0F4FF]">{initialMarginBps} bps ({maxLeverage}x max)</td></tr>
              <tr><td className="py-2 text-[#8B95B0]">LP Collateral</td><td className="py-2 text-right text-[#F0F4FF]">{lpCollateral ? `${lpCollateral} ${symbol}` : "—"}</td></tr>
              <tr><td className="py-2 text-[#8B95B0]">Insurance Fund</td><td className="py-2 text-right text-[#F0F4FF]">{insuranceAmount ? `${insuranceAmount} ${symbol}` : "—"}</td></tr>
            </tbody>
          </table>
          <div className="rounded-lg bg-white/[0.03] p-3">
            <p className="text-xs text-[#8B95B0]">Estimated SOL cost</p>
            <p className="text-sm font-medium text-[#F0F4FF]">
              ~{slabTier === "small" ? "0.5" : slabTier === "medium" ? "1.8" : "7.0"} SOL (market rent + tx fees)
            </p>
            <p className="mt-0.5 text-[9px] text-[#5a6382]">Rent is recoverable if market is closed.</p>
          </div>
          {!publicKey && <p className="text-sm text-amber-400">Connect your wallet to create a market.</p>}
          <button onClick={handleCreate} disabled={!allValid || !publicKey} className="w-full rounded-xl bg-gradient-to-r from-[#00FFB2] to-[#00d4aa] py-3 text-sm font-bold text-[#06080d] transition-all hover:shadow-[0_0_40px_rgba(0,255,178,0.25)] disabled:cursor-not-allowed disabled:bg-white/[0.03] disabled:bg-none disabled:text-[#5a6382]">Create Market</button>
        </div>
      </StepSection>
      </>}
    </div>
  );
};
