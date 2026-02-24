"use client";

import { FC, useState, useMemo, useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import Link from "next/link";
import { useCreateMarket, type CreateMarketParams } from "@/hooks/useCreateMarket";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { usePythFeedSearch } from "@/hooks/usePythFeedSearch";
import { useDexPoolSearch, type DexPoolResult } from "@/hooks/useDexPoolSearch";
import { usePriceRouter, type PriceSource } from "@/hooks/usePriceRouter";
import { useQuickLaunch } from "@/hooks/useQuickLaunch";
import { parseHumanAmount, formatHumanAmount } from "@/lib/parseAmount";
import { SLAB_TIERS, type SlabTierKey } from "@percolator/sdk";
import { InfoBanner } from "@/components/ui/InfoBanner";
import { LogoUpload } from "@/components/create/LogoUpload";
import { ValidationSummary } from "@/components/create/ValidationSummary";
import { CostEstimate } from "@/components/create/CostEstimate";
import { MarketPreview } from "@/components/create/MarketPreview";
import { validateCreateForm } from "@/lib/createMarketValidation";

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

/* ─── Shared sub-components ─── */

interface StepProps {
  open: boolean;
  onToggle: () => void;
  title: string;
  stepNum: number;
  valid: boolean;
  children: React.ReactNode;
}

const StepSection: FC<StepProps> = ({ open, onToggle, title, stepNum, valid, children }) => (
  <div className="bg-[var(--panel-bg)]">
    <button
      type="button"
      onClick={onToggle}
      className="group flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[var(--bg-elevated)]"
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-6 w-6 items-center justify-center text-[10px] font-bold border ${
            valid
              ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.08] text-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-muted)]"
          }`}
        >
          {valid ? "\u2713" : stepNum}
        </span>
        <span className="text-[13px] font-semibold text-[var(--text)]">{title}</span>
      </div>
      <svg
        className={`h-3.5 w-3.5 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    {open && <div className="border-t border-[var(--border)] px-5 py-5">{children}</div>}
  </div>
);

const FieldHint: FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="mt-1 text-[10px] text-[var(--text-dim)]">{children}</p>
);

const inputClass = "mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[12px] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40 focus:outline-none transition-colors";
const inputClassMono = `${inputClass} font-mono`;
const inputClassError = "mt-1 w-full border border-[var(--short)]/40 bg-[var(--short)]/[0.04] px-3 py-2.5 text-[12px] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--short)]/60 focus:outline-none font-mono";

const btnPrimary = "w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] press disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50";
const btnSecondary = "border border-[var(--border)] bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hud-btn-corners hover:border-[var(--accent)]/30 hover:text-[var(--text)]";

/** Quick Launch sub-component */
const QuickLaunchPanel: FC<{
  onFallbackToManual: (mint: string, pool: DexPoolResult | null) => void;
  initialMint?: string;
}> = ({ onFallbackToManual, initialMint }) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { state, create, reset } = useCreateMarket();
  const [quickMint, setQuickMint] = useState(initialMint ?? "");
  const [quickSlabTier, setQuickSlabTier] = useState<SlabTierKey>("small");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tradingFeeBps, setTradingFeeBps] = useState<number | null>(null);
  const [initialMarginBps, setInitialMarginBps] = useState<number | null>(null);
  const [lpCollateral, setLpCollateral] = useState<string | null>(null);
  const [insuranceAmount, setInsuranceAmount] = useState("100");
  const [manualPrice, setManualPrice] = useState("1.000000");
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const quickLaunch = useQuickLaunch(quickMint.length >= 32 ? quickMint : null);

  // Check wallet token balance when mint is set
  const quickMintValid = quickMint.length >= 32 && isValidBase58Pubkey(quickMint);
  useEffect(() => {
    if (!publicKey || !quickMintValid) { setTokenBalance(null); return; }
    let cancelled = false;
    setBalanceLoading(true);
    (async () => {
      try {
        const pk = new PublicKey(quickMint);
        const ata = await getAssociatedTokenAddress(pk, publicKey);
        const account = await getAccount(connection, ata);
        if (!cancelled) setTokenBalance(account.amount);
      } catch { if (!cancelled) setTokenBalance(0n); }
      finally { if (!cancelled) setBalanceLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [connection, publicKey, quickMint, quickMintValid]);

  const hasTokens = tokenBalance !== null && tokenBalance > 0n;

  useEffect(() => {
    if (quickLaunch.config) {
      if (tradingFeeBps === null) setTradingFeeBps(quickLaunch.config.tradingFeeBps);
      if (initialMarginBps === null) setInitialMarginBps(quickLaunch.config.initialMarginBps);
      if (lpCollateral === null) setLpCollateral(quickLaunch.config.lpCollateral);
    }
  }, [quickLaunch.config]);

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
    // Guard: trading fee must be less than initial margin
    if (effectiveTradingFee >= effectiveMargin) return;
    const c = quickLaunch.config;
    const pool = quickLaunch.poolInfo;
    const tier = SLAB_TIERS[quickSlabTier];

    let oracleFeed: string;
    let priceE6: number;

    if (pool) {
      const poolPk = new PublicKey(pool.poolAddress);
      oracleFeed = Array.from(poolPk.toBytes()).map((b) => b.toString(16).padStart(2, "0")).join("");
      priceE6 = Math.round(pool.priceUsd * 1_000_000);
    } else {
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
        vammParams: { spreadBps: vammSpreadBps, impactKBps: vammImpactKBps, maxTotalBps: vammMaxTotalBps, liquidityE6: vammLiquidityE6 },
      }),
    };
    create(params);
  };

  const handleQuickRetry = () => {
    if (!quickLaunch.config || !publicKey || !state.slabAddress) return;
    if (effectiveTradingFee >= effectiveMargin) return;
    const c = quickLaunch.config;
    const pool = quickLaunch.poolInfo;
    const tier = SLAB_TIERS[quickSlabTier];

    let oracleFeed: string;
    let priceE6: number;

    if (pool) {
      const poolPk = new PublicKey(pool.poolAddress);
      oracleFeed = Array.from(poolPk.toBytes()).map((b) => b.toString(16).padStart(2, "0")).join("");
      priceE6 = Math.round(pool.priceUsd * 1_000_000);
    } else {
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
        vammParams: { spreadBps: vammSpreadBps, impactKBps: vammImpactKBps, maxTotalBps: vammMaxTotalBps, liquidityE6: vammLiquidityE6 },
      }),
    };
    create(params, state.step);
  };

  /* ── Creation progress ── */
  if (state.loading || state.step > 0 || state.error) {
    return <CreationProgress state={state} onReset={reset} onRetry={handleQuickRetry} />;
  }

  return (
    <div className="space-y-5 p-6">
      <div>
        <h3 className="text-[13px] font-semibold text-[var(--text)]">Quick Launch</h3>
        <p className="mt-1 text-[11px] text-[var(--text-dim)]">
          Paste a token mint → auto-detect DEX pool → one click deploy.
        </p>
      </div>

      {/* Token Mint */}
      <div>
        <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">
          Token Mint Address
        </label>
        <input
          type="text"
          value={quickMint}
          onChange={(e) => setQuickMint(e.target.value.trim())}
          placeholder="Paste any Solana token mint..."
          className={inputClassMono}
        />
      </div>

      {/* Slab Tier */}
      <div>
        <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-2">
          Market Size
        </label>
        <div className="grid grid-cols-3 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)]">
          {(Object.entries(SLAB_TIERS) as [SlabTierKey, typeof SLAB_TIERS[SlabTierKey]][]).map(([key, tier]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQuickSlabTier(key)}
              className={`bg-[var(--panel-bg)] p-3 text-center transition-colors ${
                quickSlabTier === key
                  ? "bg-[var(--accent)]/[0.08] text-[var(--accent)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
              }`}
            >
              <p className={`text-[12px] font-semibold ${quickSlabTier === key ? "text-[var(--accent)]" : ""}`}>
                {tier.label}
              </p>
              <p className="text-[9px] text-[var(--text-dim)]">{tier.maxAccounts} slots</p>
            </button>
          ))}
        </div>
      </div>

      {/* Loading state */}
      {quickLaunch.loading && (
        <div className="flex items-center gap-2 text-[var(--text-muted)]">
          <span className="h-3.5 w-3.5 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
          <span className="text-[11px]">Auto-detecting token & DEX pool...</span>
        </div>
      )}

      {quickLaunch.error && <p className="text-[11px] text-[var(--short)]">{quickLaunch.error}</p>}

      {!quickLaunch.config && !quickLaunch.loading && !quickLaunch.error && quickMint.length >= 32 && (
        <p className="text-[11px] text-[var(--warning)]">Could not load token info. Check the mint address.</p>
      )}

      {quickLaunch.config && !quickLaunch.loading && (
        <>
          {/* Detected info */}
          <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[13px] font-semibold text-[var(--text)]">{quickLaunch.config.symbol}</span>
                <span className="ml-2 text-[11px] text-[var(--text-muted)]">{quickLaunch.config.name}</span>
              </div>
              {quickLaunch.poolInfo && (
                <span className="text-[10px] text-[var(--accent)]">
                  {quickLaunch.poolInfo.pairLabel} · ${quickLaunch.poolInfo.liquidityUsd.toLocaleString()} liq
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)]">
              {[
                { label: "Fee", value: `${effectiveTradingFee} bps` },
                { label: "Margin", value: `${effectiveMargin} bps` },
                { label: "Leverage", value: `${effectiveMaxLeverage}x` },
              ].map((m) => (
                <div key={m.label} className="bg-[var(--panel-bg)] p-2.5 text-center">
                  <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">{m.label}</p>
                  <p className="mt-0.5 text-[12px] font-semibold text-[var(--text)]">{m.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Advanced Settings */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
          >
            <span className={`text-[8px] transition-transform ${showAdvanced ? "rotate-90" : ""}`}>▶</span>
            Advanced Settings
          </button>

          {showAdvanced && (
            <div className="space-y-3 border border-[var(--border)] bg-[var(--bg)] p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Trading Fee (bps)</label>
                  <input type="number" value={effectiveTradingFee} onChange={(e) => setTradingFeeBps(Math.max(1, Math.min(1000, Number(e.target.value))))} className={inputClass} />
                  <p className="mt-0.5 text-[9px] text-[var(--text-dim)]">{(effectiveTradingFee / 100).toFixed(2)}% per trade</p>
                </div>
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Initial Margin (bps)</label>
                  <input type="number" value={effectiveMargin} onChange={(e) => setInitialMarginBps(Math.max(100, Math.min(10000, Number(e.target.value))))} className={inputClass} />
                  <p className="mt-0.5 text-[9px] text-[var(--text-dim)]">Max {effectiveMaxLeverage}x leverage</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">LP Collateral</label>
                  <input type="text" value={effectiveLpCollateral} onChange={(e) => setLpCollateral(e.target.value.replace(/[^0-9]/g, ""))} className={inputClass} />
                </div>
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Insurance Fund</label>
                  <input type="text" value={insuranceAmount} onChange={(e) => setInsuranceAmount(e.target.value.replace(/[^0-9]/g, ""))} className={inputClass} />
                </div>
              </div>

              {/* vAMM Toggle */}
              <div className="border-t border-[var(--border)] pt-3">
                <label className="flex items-center gap-2 text-[12px] text-[var(--text)]">
                  <input type="checkbox" checked={enableVamm} onChange={(e) => setEnableVamm(e.target.checked)} className="border-[var(--border)] accent-[var(--accent)]" />
                  Enable vAMM LP
                </label>
                <p className="mt-0.5 text-[9px] text-[var(--text-dim)]">Virtual AMM with spread/impact pricing.</p>
              </div>

              {enableVamm && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Base Spread (bps)</label>
                    <input type="number" value={vammSpreadBps} onChange={(e) => setVammSpreadBps(Math.max(1, Math.min(500, Number(e.target.value))))} className={inputClass} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Impact K (bps)</label>
                    <input type="number" value={vammImpactKBps} onChange={(e) => setVammImpactKBps(Math.max(1, Math.min(1000, Number(e.target.value))))} className={inputClass} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Max Total (bps)</label>
                    <input type="number" value={vammMaxTotalBps} onChange={(e) => setVammMaxTotalBps(Math.max(10, Math.min(1000, Number(e.target.value))))} className={inputClass} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Liquidity (notional)</label>
                    <input type="text" value={vammLiquidityE6} onChange={(e) => setVammLiquidityE6(e.target.value.replace(/[^0-9]/g, ""))} className={inputClass} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* No pool warning */}
          {!quickLaunch.poolInfo && (
            <div className="space-y-3">
              <div className="border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-3">
                <p className="text-[11px] text-[var(--warning)]">No DEX pool found — using admin oracle mode. Set an initial price below.</p>
              </div>
              <div>
                <label className="block text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] mb-1">Initial Price (USD)</label>
                <input type="text" value={manualPrice} onChange={(e) => setManualPrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="1.000000" className={inputClass} />
              </div>
            </div>
          )}

          {/* Cost Estimate */}
          <CostEstimate
            slabTier={quickSlabTier}
            lpCollateral={effectiveLpCollateral}
            insuranceAmount={insuranceAmount}
            tokenSymbol={quickLaunch.config.symbol}
            tokenDecimals={quickLaunch.config.decimals}
            tokenPriceUsd={quickLaunch.poolInfo?.priceUsd}
          />

          {/* Token balance info */}
          {quickMintValid && !balanceLoading && tokenBalance !== null && quickLaunch.config && (
            <div className={`border p-3 ${hasTokens ? "border-[var(--border)] bg-[var(--bg)]" : "border-[var(--short)]/30 bg-[var(--short)]/[0.04]"}`}>
              <p className="text-[11px] text-[var(--text-muted)]">
                Your balance: <span className={`font-semibold ${hasTokens ? "text-[var(--text)]" : "text-[var(--short)]"}`}>{formatHumanAmount(tokenBalance, quickLaunch.config.decimals)} {quickLaunch.config.symbol}</span>
              </p>
              {!hasTokens && (
                <p className="mt-1 text-[11px] text-[var(--short)]">
                  You need tokens to create a market (LP collateral + insurance).{" "}
                  <Link href="/devnet-mint" className="underline hover:text-[var(--accent)]">Mint tokens on the faucet</Link>
                </p>
              )}
            </div>
          )}
          {balanceLoading && quickMintValid && (
            <p className="text-[10px] text-[var(--text-dim)]">Checking wallet balance...</p>
          )}

          {/* Fee exceeds margin warning */}
          {effectiveTradingFee >= effectiveMargin && (
            <div className="border border-[var(--short)]/20 bg-[var(--short)]/[0.04] p-3">
              <p className="text-[11px] text-[var(--short)]">Trading fee ({effectiveTradingFee} bps) must be less than initial margin ({effectiveMargin} bps). Lower the fee or increase the margin.</p>
            </div>
          )}

          {/* Launch button */}
          <button onClick={handleQuickCreate} disabled={!publicKey || !quickLaunch.config || !hasTokens || effectiveTradingFee >= effectiveMargin} className={btnPrimary}>
            {!publicKey ? "Connect Wallet to Launch" : !hasTokens ? "No Tokens — Mint First" : effectiveTradingFee >= effectiveMargin ? "Fee Must Be Less Than Margin" : "Launch Market"}
          </button>
        </>
      )}
    </div>
  );
};

/* ─── Creation Progress (shared between quick & manual) ─── */
const CreationProgress: FC<{
  state: { step: number; loading: boolean; error: string | null; slabAddress: string | null; txSigs: string[]; stepLabel: string };
  onReset: () => void;
  onRetry?: () => void;
}> = ({ state, onReset, onRetry }) => {
  const labels = ["Create slab account", "Initialize market & vault", "Oracle setup & crank", "Initialize LP", "Deposit, insurance & finalize", "Insurance LP mint"];

  return (
    <div className="p-6 space-y-4">
      <div className="border border-[var(--border)] bg-[var(--bg)] p-5">
        <h2 className="mb-4 text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--text)]">
          Creating Market
        </h2>
        <div className="space-y-2.5">
          {[0, 1, 2, 3, 4, 5].map((i) => {
            let status: "pending" | "active" | "done" | "error" = "pending";
            if (state.step > i || state.step >= 6) status = "done";
            else if (state.step === i && state.loading) status = "active";
            else if (state.step === i && state.error) status = "error";
            return (
              <div key={i} className="flex items-center gap-3">
                <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                  {status === "done" && (
                    <span className="flex h-5 w-5 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[9px] text-[var(--accent)]">&#10003;</span>
                  )}
                  {status === "active" && (
                    <span className="flex h-5 w-5 items-center justify-center">
                      <span className="h-3.5 w-3.5 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                    </span>
                  )}
                  {status === "error" && (
                    <span className="flex h-5 w-5 items-center justify-center border border-[var(--short)]/30 bg-[var(--short)]/[0.08] text-[9px] text-[var(--short)]">!</span>
                  )}
                  {status === "pending" && (
                    <span className="flex h-5 w-5 items-center justify-center border border-[var(--border)] bg-[var(--bg-surface)] text-[9px] text-[var(--text-dim)]">{i + 1}</span>
                  )}
                </div>
                <span className={`text-[12px] ${
                  status === "done" ? "text-[var(--accent)]"
                    : status === "active" ? "font-medium text-[var(--text)]"
                    : status === "error" ? "text-[var(--short)]"
                    : "text-[var(--text-dim)]"
                }`}>
                  {labels[i]}
                </span>
              </div>
            );
          })}
        </div>

        {state.error && (
          <div className="mt-4 border border-[var(--short)]/20 bg-[var(--short)]/[0.04] p-3">
            <p className="text-[11px] text-[var(--short)]">{state.error}</p>
            <div className="mt-3 flex gap-2">
              {onRetry && (
                <button onClick={onRetry} className="border border-[var(--short)]/30 bg-[var(--short)]/[0.08] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] hover:bg-[var(--short)]/[0.15]">
                  Retry from step {state.step + 1}
                </button>
              )}
              <button onClick={onReset} className={btnSecondary}>Start Over</button>
            </div>
          </div>
        )}

        {state.step >= 6 && state.slabAddress && (
          <div className="mt-6 border border-[var(--accent)]/20 bg-[var(--accent)]/[0.04] p-6 text-center">
            <h3 className="mb-1 text-[15px] font-bold text-white">Market is Live</h3>
            <p className="mb-1 text-[12px] text-[var(--text-secondary)]">Your perpetual futures market has been deployed.</p>
            <div className="mb-3 flex items-center justify-center gap-2">
              <code className="font-mono text-[10px] text-[var(--accent)]/80 bg-[var(--bg)] border border-[var(--border)] px-3 py-1.5 rounded-sm break-all">
                {state.slabAddress}
              </code>
            </div>
            <div className="mb-4 flex items-center justify-center gap-3">
              <a
                href={`https://explorer.solana.com/address/${state.slabAddress}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] underline transition-colors"
              >
                View on Explorer →
              </a>
            </div>
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
              <Link href={`/trade/${state.slabAddress}`} className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-6 py-2.5 text-[12px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hud-btn-corners hover:bg-[var(--accent)]/[0.15]">
                Start Trading →
              </Link>
              <button onClick={onReset} className={btnSecondary}>Create Another</button>
            </div>
            <LogoUpload slabAddress={state.slabAddress} />
          </div>
        )}

        {state.txSigs.length > 0 && (
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Transaction Signatures</p>
            <div className="mt-1 space-y-1">
              {state.txSigs.map((sig, i) => <p key={i} className="font-mono text-[10px] text-[var(--text-muted)] truncate">{sig}</p>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ─── Main Wizard ─── */
export const CreateMarketWizard: FC<{ initialMint?: string }> = ({ initialMint }) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
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
  const [visitedSteps, setVisitedSteps] = useState<Set<number>>(new Set([1]));
  const toggleStep = (step: number) => {
    if (openStep === step) { setOpenStep(0); } else { setOpenStep(step); setVisitedSteps((prev) => new Set(prev).add(step)); }
  };

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

  const autoRouterMint = oracleMode === "auto" && mintValid ? mint : null;
  const priceRouter = usePriceRouter(autoRouterMint);

  useEffect(() => {
    if (oracleMode !== "auto" || !priceRouter.bestSource) return;
    const best = priceRouter.bestSource;
    if (best.type === "pyth") { setFeedId(best.address); setSelectedFeedName(best.pairLabel || "Pyth Feed"); }
    else if (best.type === "dex") { setDexPoolAddress(best.address); setSelectedDexPool({ poolAddress: best.address, dexId: best.dexId || "unknown", pairLabel: best.pairLabel || "DEX Pool", liquidityUsd: best.liquidity, priceUsd: best.price }); }
  }, [oracleMode, priceRouter.bestSource]);

  const dexPoolValid = (oracleMode === "dex" || oracleMode === "auto") && isValidBase58Pubkey(dexPoolAddress);
  const autoResolved = oracleMode === "auto" && priceRouter.bestSource !== null;
  const autoOracleValid = oracleMode === "auto" ? autoResolved && (priceRouter.bestSource!.type === "pyth" ? isValidHex64(feedId) : isValidBase58Pubkey(dexPoolAddress)) : true;
  const feedValid = oracleMode === "dex" || oracleMode === "auto" || isValidHex64(feedId);
  const dexValid = (oracleMode !== "dex" && oracleMode !== "auto") || dexPoolValid || (oracleMode === "auto" && priceRouter.bestSource?.type === "pyth");
  const step1Valid = mintValid && (oracleMode === "auto" ? autoOracleValid : feedValid && dexValid);

  const maintenanceMarginBps = Math.floor(initialMarginBps / 2);
  const maxLeverage = Math.floor(10000 / initialMarginBps);
  const feeExceedsMargin = tradingFeeBps >= initialMarginBps;
  const step2Valid = tradingFeeBps >= 1 && tradingFeeBps <= 100 && initialMarginBps >= 100 && initialMarginBps <= 5000 && !feeExceedsMargin;

  const lpValid = lpCollateral !== "" && !isNaN(Number(lpCollateral)) && Number(lpCollateral) > 0;
  const insValid = insuranceAmount !== "" && !isNaN(Number(insuranceAmount)) && Number(insuranceAmount) > 0;
  const step3Valid = lpValid && insValid;
  const hasManualTokens = tokenBalance !== null && tokenBalance > 0n;
  const decimalsValid = decimals <= 12; // Block tokens with > 12 decimals (u64 overflow risk)
  const allValid = step1Valid && step2Valid && step3Valid && hasManualTokens && decimalsValid;

  const lpNative = useMemo(() => { try { return lpValid ? parseHumanAmount(lpCollateral, decimals) : 0n; } catch { return 0n; } }, [lpCollateral, decimals, lpValid]);
  const insNative = useMemo(() => { try { return insValid ? parseHumanAmount(insuranceAmount, decimals) : 0n; } catch { return 0n; } }, [insuranceAmount, decimals, insValid]);
  const combinedNative = lpNative + insNative;
  const balanceWarning = tokenBalance !== null && combinedNative > 0n && combinedNative > (tokenBalance * 80n) / 100n;

  useEffect(() => {
    if (!publicKey || !mintValid) { setTokenBalance(null); return; }
    let cancelled = false;
    setBalanceLoading(true);
    (async () => {
      try {
        const pk = new PublicKey(mint);
        const ata = await getAssociatedTokenAddress(pk, publicKey);
        const account = await getAccount(connection, ata);
        if (!cancelled) setTokenBalance(account.amount);
      } catch { if (!cancelled) setTokenBalance(null); }
      finally { if (!cancelled) setBalanceLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [connection, publicKey, mint, mintValid]);

  const getOracleFeedAndPrice = (): { oracleFeed: string; priceE6: bigint } => {
    // For admin/manual oracle modes, derive a real initial price from the detected pool
    // so the oracle isn't stuck at 0 (price cap at 10000bps from 0 = forever 0).
    const detectPrice = (): bigint => {
      if (selectedDexPool?.priceUsd) return BigInt(Math.round(selectedDexPool.priceUsd * 1_000_000));
      if (priceRouter.bestSource?.price) return BigInt(Math.round(priceRouter.bestSource.price * 1_000_000));
      return 1_000_000n; // fallback: $1
    };

    if (oracleMode === "auto" && priceRouter.bestSource) {
      if (priceRouter.bestSource.type === "pyth") return { oracleFeed: feedId, priceE6: 0n };
      const pk = new PublicKey(dexPoolAddress);
      const hex = Array.from(pk.toBytes()).map((b) => b.toString(16).padStart(2, "0")).join("");
      return { oracleFeed: hex, priceE6: 0n };
    }
    if (oracleMode === "dex") {
      const pk = new PublicKey(dexPoolAddress);
      const hex = Array.from(pk.toBytes()).map((b) => b.toString(16).padStart(2, "0")).join("");
      return { oracleFeed: hex, priceE6: 0n };
    }
    // Pyth or admin oracle — for admin oracle the price must be non-zero
    return { oracleFeed: feedId, priceE6: detectPrice() };
  };

  const handleCreate = () => {
    if (!allValid) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    const selectedTier = SLAB_TIERS[slabTier];
    create({
      mint: new PublicKey(mint), initialPriceE6: priceE6, lpCollateral: parseHumanAmount(lpCollateral, decimals),
      insuranceAmount: parseHumanAmount(insuranceAmount, decimals), oracleFeed, invert, tradingFeeBps, initialMarginBps,
      maxAccounts: selectedTier.maxAccounts, slabDataSize: selectedTier.dataSize, symbol: symbol || "UNKNOWN",
      name: tokenMeta?.name || "Unknown Token", decimals,
      ...(enableVammManual && { vammParams: { spreadBps: vammSpreadBpsManual, impactKBps: vammImpactKBpsManual, maxTotalBps: vammMaxTotalBpsManual, liquidityE6: vammLiquidityE6Manual } }),
    });
  };

  const handleRetry = () => {
    if (!allValid || !state.slabAddress) return;
    const { oracleFeed, priceE6 } = getOracleFeedAndPrice();
    const selectedTier = SLAB_TIERS[slabTier];
    create({
      mint: new PublicKey(mint), initialPriceE6: priceE6, lpCollateral: parseHumanAmount(lpCollateral, decimals),
      insuranceAmount: parseHumanAmount(insuranceAmount, decimals), oracleFeed, invert, tradingFeeBps, initialMarginBps,
      maxAccounts: selectedTier.maxAccounts, slabDataSize: selectedTier.dataSize,
      symbol: symbol || "UNKNOWN", name: tokenMeta?.name || "Unknown Token", decimals,
      ...(enableVammManual && { vammParams: { spreadBps: vammSpreadBpsManual, impactKBps: vammImpactKBpsManual, maxTotalBps: vammMaxTotalBpsManual, liquidityE6: vammLiquidityE6Manual } }),
    }, state.step);
  };

  const handleFallbackToManual = (fallbackMint: string, pool: DexPoolResult | null) => {
    setWizardMode("manual");
    setMint(fallbackMint);
    if (pool) { setDexPoolAddress(pool.poolAddress); setSelectedDexPool(pool); }
    setOracleMode("dex");
    setOpenStep(1);
  };

  /* Creation progress */
  if (state.loading || state.step > 0 || state.error) {
    return <CreationProgress state={state} onReset={reset} onRetry={handleRetry} />;
  }

  const oracleModeBtn = (mode: "auto" | "dex" | "pyth", label: string) => (
    <button
      type="button"
      onClick={() => { setOracleMode(mode); if (mode !== "pyth") { setFeedId(""); setSelectedFeedName(null); } if (mode !== "dex") { setDexPoolAddress(""); setSelectedDexPool(null); } }}
      className={`flex-1 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
        oracleMode === mode
          ? "bg-[var(--accent)]/[0.1] text-[var(--accent)] border-b-2 border-[var(--accent)]"
          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-0">
      {/* Mode Switcher */}
      <div className="grid grid-cols-2 border-b border-[var(--border)]">
        {(["quick", "manual"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setWizardMode(mode)}
            className={`py-3.5 text-[12px] font-semibold uppercase tracking-[0.15em] transition-colors ${
              wizardMode === mode
                ? "bg-[var(--accent)]/[0.06] text-[var(--accent)] border-b-2 border-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
            }`}
          >
            {mode === "quick" ? "Quick Launch" : "Manual Setup"}
          </button>
        ))}
      </div>

      {wizardMode === "quick" && <QuickLaunchPanel onFallbackToManual={handleFallbackToManual} initialMint={initialMint} />}

      {wizardMode === "manual" && (
        <div className="border border-[var(--border)] divide-y divide-[var(--border)]">
          {/* Step 1: Token & Oracle */}
          <StepSection open={openStep === 1} onToggle={() => toggleStep(1)} title="Token & Oracle" stepNum={1} valid={visitedSteps.has(1) && step1Valid}>
            <div className="space-y-4">
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Collateral Mint Address</label>
                <FieldHint>The SPL token used as collateral for this market.</FieldHint>
                <input type="text" value={mint} onChange={(e) => setMint(e.target.value.trim())} placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" className={mint && !mintValid ? inputClassError : inputClassMono} />
                {mint && !mintValid && <p className="mt-1 text-[10px] text-[var(--short)]">Invalid base58 public key</p>}
                {tokenMeta && mintValid && (
                  <div className={`mt-2 flex items-center gap-3 border p-3 ${tokenMeta.decimals > 12 ? "border-[var(--short)]/40 bg-[var(--short)]/[0.05]" : "border-[var(--accent)]/20 bg-[var(--accent)]/[0.03]"}`}>
                    <div className={`flex h-7 w-7 items-center justify-center border text-[10px] font-bold ${tokenMeta.decimals > 12 ? "border-[var(--short)]/30 text-[var(--short)]" : "border-[var(--accent)]/30 text-[var(--accent)]"}`}>{tokenMeta.symbol.slice(0, 2)}</div>
                    <div>
                      <p className="text-[12px] font-medium text-[var(--text)]">{tokenMeta.name} ({tokenMeta.symbol})</p>
                      <p className="text-[10px] text-[var(--text-muted)]">{tokenMeta.decimals} decimals</p>
                      {tokenMeta.decimals > 12 && (
                        <p className="text-[10px] text-[var(--short)] font-medium mt-0.5">⚠ Decimals &gt; 12 risk integer overflow in on-chain arithmetic. Market creation blocked.</p>
                      )}
                    </div>
                  </div>
                )}
                {balanceLoading && mintValid && <p className="mt-1 text-[10px] text-[var(--text-dim)]">Loading balance...</p>}
                {tokenBalance !== null && tokenMeta && (
                  <p className="mt-1 text-[10px] text-[var(--text-muted)]">Your balance: <span className={`font-medium ${hasManualTokens ? "text-[var(--text)]" : "text-[var(--short)]"}`}>{formatHumanAmount(tokenBalance, tokenMeta.decimals)} {tokenMeta.symbol}</span></p>
                )}
                {!balanceLoading && tokenBalance !== null && !hasManualTokens && mintValid && (
                  <p className="mt-1 text-[10px] text-[var(--short)]">
                    You need tokens to create a market.{" "}
                    <Link href="/devnet-mint" className="underline hover:text-[var(--accent)]">Mint on faucet</Link>
                  </p>
                )}
              </div>
              <InfoBanner>On devnet, select Admin Oracle to push prices manually. On mainnet, use Pyth or DexScreener for live feeds.</InfoBanner>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Oracle Mode</label>
                <FieldHint>How the market gets price data.</FieldHint>
                <div className="mt-2 flex border border-[var(--border)]">
                  {oracleModeBtn("auto", "Auto")}
                  {oracleModeBtn("dex", "DEX Pool")}
                  {oracleModeBtn("pyth", "Pyth")}
                </div>
              </div>

              {/* Auto oracle */}
              {oracleMode === "auto" && (
                <div className="space-y-2">
                  {priceRouter.loading && (
                    <div className="flex items-center gap-2 text-[var(--text-muted)]">
                      <span className="h-3.5 w-3.5 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                      <span className="text-[11px]">Finding best oracle source...</span>
                    </div>
                  )}
                  {priceRouter.error && <p className="text-[11px] text-[var(--short)]">Failed to resolve: {priceRouter.error}</p>}
                  {!priceRouter.loading && priceRouter.bestSource && (
                    <div className="space-y-2">
                      <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--accent)]">Recommended</span>
                            <p className="text-[12px] font-medium text-[var(--text)] mt-0.5">{priceRouter.bestSource.pairLabel}</p>
                          </div>
                          <div className="text-right">
                            <span className="border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] px-2 py-0.5 text-[9px] font-bold text-[var(--accent)] uppercase">{priceRouter.bestSource.type}</span>
                            {priceRouter.bestSource.price > 0 && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">${priceRouter.bestSource.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>}
                          </div>
                        </div>
                        {priceRouter.bestSource.liquidity > 0 && priceRouter.bestSource.liquidity !== Infinity && <p className="text-[9px] text-[var(--text-dim)] mt-1">${priceRouter.bestSource.liquidity.toLocaleString()} liquidity</p>}
                        <p className="text-[9px] text-[var(--text-dim)]">Confidence: {priceRouter.bestSource.confidence}/100</p>
                      </div>
                      {priceRouter.allSources.length > 1 && (
                        <div className="space-y-1">
                          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">All sources ({priceRouter.allSources.length})</p>
                          {priceRouter.allSources.slice(1).map((src, i) => (
                            <div key={i} className="flex items-center justify-between border border-[var(--border)] px-3 py-2 text-[11px]">
                              <div className="flex items-center gap-2">
                                <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[8px] font-bold uppercase text-[var(--text-muted)]">{src.type}</span>
                                <span className="text-[var(--text)]">{src.pairLabel}</span>
                              </div>
                              <div className="text-right text-[var(--text-dim)]">
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
                    <p className="text-[11px] text-[var(--warning)]">No oracle sources found. Try DEX Pool or Pyth mode manually.</p>
                  )}
                </div>
              )}

              {/* Pyth oracle */}
              {oracleMode === "pyth" && (
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Pyth Feed ID (hex, 64 chars)</label>
                  {pythFeeds.length > 0 && !feedId && (
                    <div className="mt-2 space-y-1">
                      <p className="text-[10px] text-[var(--text-muted)]">Select a feed:</p>
                      {pythFeeds.map((f) => (
                        <button key={f.id} type="button" onClick={() => { setFeedId(f.id); setSelectedFeedName(f.displayName); }} className="flex w-full items-center justify-between border border-[var(--border)] px-3 py-2 text-left text-[12px] hover:border-[var(--accent)]/30 hover:bg-[var(--accent)]/[0.04] transition-colors">
                          <span className="font-medium text-[var(--text)]">{f.displayName}</span>
                          <span className="font-mono text-[10px] text-[var(--text-dim)]">{f.id.slice(0, 12)}...</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {pythLoading && <p className="mt-1 text-[10px] text-[var(--text-dim)]">Searching Pyth feeds...</p>}
                  {!pythLoading && pythFeeds.length === 0 && tokenMeta?.symbol && <p className="mt-1 text-[10px] text-[var(--text-dim)]">No Pyth feeds found for &ldquo;{tokenMeta.symbol}&rdquo;.</p>}
                  {feedId && selectedFeedName && (
                    <div className="mt-2 flex items-center justify-between border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-2.5">
                      <span className="text-[12px] font-medium text-[var(--accent)]">{selectedFeedName}</span>
                      <button type="button" onClick={() => { setFeedId(""); setSelectedFeedName(null); }} className="text-[10px] text-[var(--accent)] hover:underline">Change</button>
                    </div>
                  )}
                  <input type="text" value={feedId} onChange={(e) => { setFeedId(e.target.value.trim()); setSelectedFeedName(null); }} placeholder="64 hex characters" className={feedId && !feedValid ? inputClassError : inputClassMono} />
                  {feedId && !feedValid && <p className="mt-1 text-[10px] text-[var(--short)]">Must be exactly 64 hex characters</p>}
                  <a href="https://pyth.network/developers/price-feed-ids" target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[10px] text-[var(--accent)] hover:underline">Browse all Pyth feed IDs →</a>
                </div>
              )}

              {/* DEX oracle */}
              {oracleMode === "dex" && (
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">DEX Pool Address</label>
                  <FieldHint>On-chain DEX pool as price oracle. PumpSwap, Raydium, or Meteora.</FieldHint>
                  {dexPools.length > 0 && !dexPoolAddress && (
                    <div className="mt-2 space-y-1">
                      <p className="text-[10px] text-[var(--text-muted)]">Discovered pools:</p>
                      {dexPools.map((pool) => (
                        <button key={pool.poolAddress} type="button" onClick={() => { setDexPoolAddress(pool.poolAddress); setSelectedDexPool(pool); }} className="flex w-full items-center justify-between border border-[var(--border)] px-3 py-2 text-left text-[12px] hover:border-[var(--accent)]/30 hover:bg-[var(--accent)]/[0.04] transition-colors">
                          <div>
                            <span className="font-medium text-[var(--text)]">{pool.pairLabel}</span>
                            <span className="ml-2 text-[10px] text-[var(--text-dim)] capitalize">{pool.dexId}</span>
                          </div>
                          <span className="text-[10px] text-[var(--text-muted)]">${pool.liquidityUsd.toLocaleString()} liq</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {dexPoolsLoading && <p className="mt-1 text-[10px] text-[var(--text-dim)]">Searching DEX pools...</p>}
                  {!dexPoolsLoading && dexPools.length === 0 && mintValid && <p className="mt-1 text-[10px] text-[var(--text-dim)]">No supported DEX pools found.</p>}
                  {dexPoolAddress && selectedDexPool && (
                    <div className="mt-2 flex items-center justify-between border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-2.5">
                      <div>
                        <span className="text-[12px] font-medium text-[var(--accent)]">{selectedDexPool.pairLabel}</span>
                        <span className="ml-2 text-[10px] text-[var(--accent)] capitalize">{selectedDexPool.dexId}</span>
                      </div>
                      <button type="button" onClick={() => { setDexPoolAddress(""); setSelectedDexPool(null); }} className="text-[10px] text-[var(--accent)] hover:underline">Change</button>
                    </div>
                  )}
                  <input type="text" value={dexPoolAddress} onChange={(e) => { setDexPoolAddress(e.target.value.trim()); setSelectedDexPool(null); }} placeholder="Pool address (base58)" className={dexPoolAddress && !dexPoolValid ? inputClassError : inputClassMono} />
                  {dexPoolAddress && !dexPoolValid && <p className="mt-1 text-[10px] text-[var(--short)]">Invalid base58 public key</p>}
                </div>
              )}

              <div>
                <label className="flex items-center gap-2 text-[12px] text-[var(--text)]">
                  <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="accent-[var(--accent)]" />
                  Invert price feed
                </label>
                <FieldHint>Enable if the collateral IS the asset being priced.</FieldHint>
              </div>
            </div>
          </StepSection>

          {/* Step 2: Risk Parameters */}
          <StepSection open={openStep === 2} onToggle={() => toggleStep(2)} title="Risk Parameters" stepNum={2} valid={visitedSteps.has(2) && step2Valid}>
            <div className="space-y-4">
              <InfoBanner>Small tier: ~0.44 SOL rent on devnet. On mainnet: ~$65 for small, ~$260 for medium.</InfoBanner>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-2">Market Capacity</label>
                <FieldHint>Trader slots. Larger = more traders but higher rent.</FieldHint>
                <div className="mt-2 grid grid-cols-3 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)]">
                  {(Object.entries(SLAB_TIERS) as [SlabTierKey, typeof SLAB_TIERS[SlabTierKey]][]).map(([key, tier]) => (
                    <button key={key} type="button" onClick={() => setSlabTier(key)} className={`bg-[var(--panel-bg)] p-3 text-left transition-colors ${slabTier === key ? "bg-[var(--accent)]/[0.08]" : "hover:bg-[var(--bg-elevated)]"}`}>
                      <p className={`text-[12px] font-semibold ${slabTier === key ? "text-[var(--accent)]" : "text-[var(--text)]"}`}>{tier.label}</p>
                      <p className="text-[10px] text-[var(--text-dim)]">{tier.description}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Trading Fee: {tradingFeeBps} bps ({(tradingFeeBps / 100).toFixed(2)}%)</label>
                <FieldHint>Fee charged on every trade. 30 bps is standard.</FieldHint>
                <input type="range" min={1} max={100} value={tradingFeeBps} onChange={(e) => setTradingFeeBps(Number(e.target.value))} className="mt-2 w-full" />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Initial Margin: {initialMarginBps} bps ({(initialMarginBps / 100).toFixed(0)}%)</label>
                <FieldHint>{initialMarginBps} bps = {maxLeverage}x max leverage.</FieldHint>
                <input type="range" min={100} max={5000} step={100} value={initialMarginBps} onChange={(e) => setInitialMarginBps(Number(e.target.value))} className="mt-2 w-full" />
              </div>
              {feeExceedsMargin && (
                <div className="border border-[var(--short)]/30 bg-[var(--short)]/5 p-3">
                  <p className="text-[11px] text-[var(--short)] font-medium">⚠ Trading fee ({tradingFeeBps} bps) must be less than initial margin ({initialMarginBps} bps)</p>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">When the fee exceeds the margin, a single trade would consume the entire margin. Lower the trading fee or increase the initial margin.</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)]">
                <div className="bg-[var(--panel-bg)] p-3">
                  <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Maintenance Margin</p>
                  <p className="mt-1 text-[13px] font-semibold text-[var(--text)]">{(maintenanceMarginBps / 100).toFixed(1)}%</p>
                </div>
                <div className="bg-[var(--panel-bg)] p-3">
                  <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Max Leverage</p>
                  <p className="mt-1 text-[13px] font-semibold text-[var(--text)]">{maxLeverage}x</p>
                </div>
              </div>
            </div>
          </StepSection>

          {/* Step 3: Liquidity */}
          <StepSection open={openStep === 3} onToggle={() => toggleStep(3)} title="Liquidity Setup" stepNum={3} valid={visitedSteps.has(3) && step3Valid}>
            <div className="space-y-4">
              {tokenBalance !== null && tokenMeta && (
                <div className="border border-[var(--border)] bg-[var(--bg)] p-3">
                  <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Your Balance</p>
                  <p className="mt-1 text-[13px] font-semibold text-[var(--text)]">{formatHumanAmount(tokenBalance, tokenMeta.decimals)} {tokenMeta.symbol}</p>
                </div>
              )}
              {balanceLoading && <p className="text-[10px] text-[var(--text-dim)]">Loading balance...</p>}
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">LP Collateral{tokenMeta ? ` (${tokenMeta.symbol})` : ""}</label>
                <FieldHint>Initial liquidity backing the other side of every trade.</FieldHint>
                <input type="text" value={lpCollateral} onChange={(e) => setLpCollateral(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 1000.00" className={inputClass} />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Insurance Fund{tokenMeta ? ` (${tokenMeta.symbol})` : ""}</label>
                <FieldHint>Safety buffer absorbing losses from liquidations.</FieldHint>
                <input type="text" value={insuranceAmount} onChange={(e) => setInsuranceAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 500.00" className={inputClass} />
              </div>
              {balanceWarning && (
                <div className="border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-3">
                  <p className="text-[11px] text-[var(--warning)]">Combined amount exceeds 80% of your token balance.</p>
                </div>
              )}
            </div>
          </StepSection>

          {/* Step 4: Review & Create */}
          <StepSection open={openStep === 4} onToggle={() => toggleStep(4)} title="Review & Create" stepNum={4} valid={false}>
            {(() => {
              const oracleLabel = oracleMode === "auto" && priceRouter.bestSource
                ? `Auto — ${priceRouter.bestSource.pairLabel} (${priceRouter.bestSource.type})`
                : oracleMode === "dex"
                  ? selectedDexPool ? `DEX — ${selectedDexPool.pairLabel} (${selectedDexPool.dexId})` : `DEX — ${dexPoolAddress.slice(0, 12)}...`
                  : selectedFeedName ? `Pyth — ${selectedFeedName}` : feedId ? `Pyth — ${feedId.slice(0, 12)}...` : "Not configured";
              const detectedPrice = selectedDexPool?.priceUsd ?? priceRouter.bestSource?.price ?? undefined;
              const validationErrors = validateCreateForm({
                mint,
                mintValid,
                tokenMeta: tokenMeta ?? null,
                oracleResolved: step1Valid,
                oracleMode,
                tradingFeeBps,
                initialMarginBps,
                lpCollateral,
                insuranceAmount,
                tokenBalance,
                walletConnected: !!publicKey,
                decimals,
              });
              return (
                <div className="space-y-5">
                  {/* Market Preview */}
                  <div>
                    <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
                      Market Preview
                    </p>
                    <MarketPreview
                      symbol={tokenMeta?.symbol ?? symbol}
                      name={tokenMeta?.name ?? "Unknown Token"}
                      tokenMint={mint || "—"}
                      oracleMode={oracleMode}
                      oracleLabel={oracleLabel}
                      tradingFeeBps={tradingFeeBps}
                      initialMarginBps={initialMarginBps}
                      maxLeverage={maxLeverage}
                      lpCollateral={lpCollateral}
                      insuranceAmount={insuranceAmount}
                      tierLabel={SLAB_TIERS[slabTier].label}
                      tierSlots={SLAB_TIERS[slabTier].maxAccounts}
                      tokenDecimals={decimals}
                      priceUsd={detectedPrice}
                      inverted={invert}
                      vammEnabled={enableVammManual}
                    />
                  </div>

                  {/* Cost Estimate */}
                  <CostEstimate
                    slabTier={slabTier}
                    lpCollateral={lpCollateral}
                    insuranceAmount={insuranceAmount}
                    tokenSymbol={tokenMeta?.symbol ?? symbol}
                    tokenDecimals={decimals}
                    tokenPriceUsd={detectedPrice}
                  />

                  {/* Validation Summary */}
                  <ValidationSummary errors={validationErrors} />

                  {/* Submit */}
                  <button onClick={handleCreate} disabled={!allValid || !publicKey} className={btnPrimary}>
                    {!publicKey ? "Connect Wallet" : !hasManualTokens && mintValid ? "No Tokens — Mint First" : validationErrors.filter(e => e.severity === "error").length > 0 ? `Fix ${validationErrors.filter(e => e.severity === "error").length} Error${validationErrors.filter(e => e.severity === "error").length > 1 ? "s" : ""} to Continue` : "Create Market"}
                  </button>
                </div>
              );
            })()}
          </StepSection>
        </div>
      )}
    </div>
  );
};
