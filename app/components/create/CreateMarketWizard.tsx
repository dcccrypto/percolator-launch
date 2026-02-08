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
  <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] shadow-sm">
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between px-5 py-4 text-left"
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
            valid ? "bg-green-900/40 text-green-400" : "bg-[#1a1a2e] text-[#71717a]"
          }`}
        >
          {valid ? "\u2713" : stepNum}
        </span>
        <span className="text-sm font-semibold text-[#e4e4e7]">{title}</span>
      </div>
      <svg
        className={`h-4 w-4 text-[#71717a] transition-transform ${open ? "rotate-180" : ""}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    {open && <div className="border-t border-[#1e1e2e] px-5 py-4">{children}</div>}
  </div>
);

const FieldHint: FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="mt-1 text-xs text-[#52525b]">{children}</p>
);

/** Quick Launch sub-component */
const QuickLaunchPanel: FC<{
  onFallbackToManual: (mint: string, pool: DexPoolResult | null) => void;
}> = ({ onFallbackToManual }) => {
  const { publicKey } = useWallet();
  const { state, create, reset } = useCreateMarket();
  const [quickMint, setQuickMint] = useState("");
  const [quickSlabTier, setQuickSlabTier] = useState<SlabTierKey>("small");
  const quickLaunch = useQuickLaunch(quickMint.length >= 32 ? quickMint : null);

  const handleQuickCreate = () => {
    if (!quickLaunch.config || !quickLaunch.poolInfo || !publicKey) return;

    const c = quickLaunch.config;
    const pool = quickLaunch.poolInfo;
    const tier = SLAB_TIERS[quickSlabTier];

    // Derive oracle feed from pool address
    const poolPk = new PublicKey(pool.poolAddress);
    const oracleFeed = Array.from(poolPk.toBytes())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const priceE6 = Math.round(pool.priceUsd * 1_000_000);

    const params: CreateMarketParams = {
      mint: new PublicKey(c.mint),
      initialPriceE6: BigInt(priceE6 > 0 ? priceE6 : 1_000_000),
      lpCollateral: parseHumanAmount(c.lpCollateral, c.decimals),
      insuranceAmount: parseHumanAmount("500000", c.decimals),
      oracleFeed,
      invert: false,
      tradingFeeBps: 30,
      initialMarginBps: 1000,
      maxAccounts: tier.maxAccounts,
      slabDataSize: tier.dataSize,
    };
    create(params);
  };

  // Show creation progress
  if (state.loading || state.step > 0 || state.error) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-[#e4e4e7]">Quick Launch — Creating Market</h2>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4, 5].map((i) => {
              let status: "pending" | "active" | "done" | "error" = "pending";
              if (state.step > i || state.step === 6) status = "done";
              else if (state.step === i && state.loading) status = "active";
              else if (state.step === i && state.error) status = "error";
              const labels = ["Create slab account", "Create vault token account", "Initialize market", "Initialize LP", "Deposit collateral & insurance", "Oracle setup & crank"];
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                    {status === "done" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-900/40 text-xs text-green-400">&#10003;</span>}
                    {status === "active" && <span className="flex h-6 w-6 items-center justify-center"><span className="h-4 w-4 animate-spin rounded-full border-2 border-[#1e1e2e] border-t-[#e4e4e7]" /></span>}
                    {status === "error" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-900/40 text-xs text-red-400">!</span>}
                    {status === "pending" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#1a1a2e] text-xs text-[#52525b]">{i + 1}</span>}
                  </div>
                  <span className={`text-sm ${status === "done" ? "text-green-400" : status === "active" ? "font-medium text-[#e4e4e7]" : status === "error" ? "text-red-400" : "text-[#52525b]"}`}>{labels[i]}</span>
                </div>
              );
            })}
          </div>
          {state.error && (
            <div className="mt-4 rounded-lg bg-red-900/20 p-3">
              <p className="text-sm text-red-400">{state.error}</p>
              <div className="mt-3 flex gap-2">
                <button onClick={reset} className="rounded-lg bg-[#1a1a2e] px-3 py-1.5 text-xs font-medium text-[#e4e4e7] hover:bg-[#1e1e2e]">Start over</button>
              </div>
            </div>
          )}
          {state.step === 6 && state.slabAddress && (
            <div className="mt-4 rounded-lg bg-green-900/20 p-4">
              <p className="text-sm font-medium text-green-300">Market created successfully!</p>
              <p className="mt-1 font-mono text-xs text-green-400">Slab: {state.slabAddress}</p>
              <div className="mt-3 flex gap-2">
                <Link href={`/trade?market=${state.slabAddress}`} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Trade this market</Link>
                <button onClick={reset} className="rounded-lg bg-[#1a1a2e] px-4 py-2 text-sm font-medium text-[#e4e4e7] hover:bg-[#1e1e2e]">Create another</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 shadow-sm space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[#e4e4e7] mb-1">⚡ Quick Launch</h3>
        <p className="text-xs text-[#52525b]">Paste a token mint → we auto-detect the DEX pool and set optimal risk params. One click to deploy.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-[#e4e4e7]">Token Mint Address</label>
        <input
          type="text"
          value={quickMint}
          onChange={(e) => setQuickMint(e.target.value.trim())}
          placeholder="Paste any Solana token mint..."
          className="mt-1 w-full rounded-lg border border-[#1e1e2e] bg-[#1a1a28] px-3 py-2 font-mono text-xs text-[#e4e4e7] placeholder-[#52525b] focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* Slab Tier Selector */}
      <div>
        <label className="block text-sm font-medium text-[#e4e4e7] mb-2">Market Size</label>
        <div className="grid grid-cols-4 gap-2">
          {(Object.entries(SLAB_TIERS) as [SlabTierKey, typeof SLAB_TIERS[SlabTierKey]][]).map(([key, tier]) => (
            <button
              key={key}
              type="button"
              onClick={() => setQuickSlabTier(key)}
              className={`rounded-lg border p-2 text-center transition-colors ${
                quickSlabTier === key
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-[#1e1e2e] bg-[#1a1a28] hover:border-[#2e2e3e]"
              }`}
            >
              <p className={`text-xs font-semibold ${quickSlabTier === key ? "text-blue-400" : "text-[#e4e4e7]"}`}>{tier.label}</p>
              <p className="text-[10px] text-[#52525b]">{tier.maxAccounts} slots</p>
            </button>
          ))}
        </div>
      </div>

      {quickLaunch.loading && (
        <div className="flex items-center gap-2 text-[#71717a]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#1e1e2e] border-t-[#e4e4e7]" />
          <span className="text-xs">Auto-detecting token &amp; DEX pool...</span>
        </div>
      )}

      {quickLaunch.error && (
        <p className="text-xs text-red-400">{quickLaunch.error}</p>
      )}

      {quickLaunch.config && !quickLaunch.loading && (
        <>
          {/* Detected info */}
          <div className="rounded-lg bg-blue-900/20 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-[#e4e4e7]">{quickLaunch.config.symbol}</span>
                <span className="ml-2 text-xs text-[#71717a]">{quickLaunch.config.name}</span>
              </div>
              {quickLaunch.poolInfo && (
                <span className="text-xs text-green-400">
                  {quickLaunch.poolInfo.pairLabel} · ${quickLaunch.poolInfo.liquidityUsd.toLocaleString()} liq
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] text-[#52525b]">Fee</p>
                <p className="text-xs font-medium text-[#e4e4e7]">30 bps</p>
              </div>
              <div>
                <p className="text-[10px] text-[#52525b]">Margin</p>
                <p className="text-xs font-medium text-[#e4e4e7]">1000 bps</p>
              </div>
              <div>
                <p className="text-[10px] text-[#52525b]">Leverage</p>
                <p className="text-xs font-medium text-[#e4e4e7]">10x</p>
              </div>
            </div>
          </div>

          {!quickLaunch.poolInfo && (
            <div className="rounded-lg bg-amber-900/20 p-3">
              <p className="text-xs text-amber-400">No DEX pool found. You can still launch with manual oracle or <button type="button" onClick={() => onFallbackToManual(quickMint, null)} className="underline hover:text-amber-300">switch to manual mode</button>.</p>
            </div>
          )}

          {publicKey ? (
            <button
              onClick={handleQuickCreate}
              disabled={!quickLaunch.poolInfo}
              className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-[#1e1e2e] disabled:text-[#52525b]"
            >
              🚀 Launch Market
            </button>
          ) : (
            <p className="text-sm text-amber-400 text-center">Connect your wallet to launch</p>
          )}
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
  const [oracleMode, setOracleMode] = useState<"pyth" | "dex">("dex");
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

  const mintValid = isValidBase58Pubkey(mint);
  const mintPk = useMemo(() => (mintValid ? new PublicKey(mint) : null), [mint, mintValid]);
  const tokenMeta = useTokenMeta(mintPk);
  const decimals = tokenMeta?.decimals ?? 6;
  const symbol = tokenMeta?.symbol ?? "Token";

  const pythQuery = oracleMode === "pyth" && tokenMeta?.symbol ? tokenMeta.symbol : "";
  const { feeds: pythFeeds, loading: pythLoading } = usePythFeedSearch(pythQuery);

  const dexSearchMint = oracleMode === "dex" && mintValid ? mint : null;
  const { pools: dexPools, loading: dexPoolsLoading } = useDexPoolSearch(dexSearchMint);

  const dexPoolValid = oracleMode === "dex" && isValidBase58Pubkey(dexPoolAddress);
  const feedValid = oracleMode === "dex" || isValidHex64(feedId);
  const dexValid = oracleMode !== "dex" || dexPoolValid;
  const step1Valid = mintValid && feedValid && dexValid;

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
        <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-[#e4e4e7]">Creating Market</h2>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4, 5].map((i) => {
              let status: "pending" | "active" | "done" | "error" = "pending";
              if (state.step > i || state.step === 6) status = "done";
              else if (state.step === i && state.loading) status = "active";
              else if (state.step === i && state.error) status = "error";
              const labels = ["Create slab account", "Create vault token account", "Initialize market", "Initialize LP", "Deposit collateral & insurance", "Oracle setup & crank"];
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                    {status === "done" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-900/40 text-xs text-green-400">&#10003;</span>}
                    {status === "active" && <span className="flex h-6 w-6 items-center justify-center"><span className="h-4 w-4 animate-spin rounded-full border-2 border-[#1e1e2e] border-t-[#e4e4e7]" /></span>}
                    {status === "error" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-900/40 text-xs text-red-400">!</span>}
                    {status === "pending" && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#1a1a2e] text-xs text-[#52525b]">{i + 1}</span>}
                  </div>
                  <span className={`text-sm ${status === "done" ? "text-green-400" : status === "active" ? "font-medium text-[#e4e4e7]" : status === "error" ? "text-red-400" : "text-[#52525b]"}`}>{labels[i]}</span>
                </div>
              );
            })}
          </div>
          {state.error && (
            <div className="mt-4 rounded-lg bg-red-900/20 p-3">
              <p className="text-sm text-red-400">{state.error}</p>
              <div className="mt-3 flex gap-2">
                <button onClick={handleRetry} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700">Retry from step {state.step + 1}</button>
                <button onClick={reset} className="rounded-lg bg-[#1a1a2e] px-3 py-1.5 text-xs font-medium text-[#e4e4e7] hover:bg-[#1e1e2e]">Start over</button>
              </div>
            </div>
          )}
          {state.step === 6 && state.slabAddress && (
            <div className="mt-4 rounded-lg bg-green-900/20 p-4">
              <p className="text-sm font-medium text-green-300">Market created successfully!</p>
              <p className="mt-1 font-mono text-xs text-green-400">Slab: {state.slabAddress}</p>
              <div className="mt-3 flex gap-2">
                <Link href={`/trade?market=${state.slabAddress}`} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">Trade this market</Link>
                <button onClick={reset} className="rounded-lg bg-[#1a1a2e] px-4 py-2 text-sm font-medium text-[#e4e4e7] hover:bg-[#1e1e2e]">Create another</button>
              </div>
            </div>
          )}
          {state.txSigs.length > 0 && (
            <div className="mt-4 border-t border-[#1e1e2e] pt-3">
              <p className="text-xs font-medium text-[#71717a] uppercase">Transaction signatures</p>
              <div className="mt-1 space-y-1">
                {state.txSigs.map((sig, i) => <p key={i} className="font-mono text-xs text-[#71717a] truncate">{sig}</p>)}
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
      <div className="flex rounded-xl border border-[#1e1e2e] bg-[#12121a] p-1">
        <button
          type="button"
          onClick={() => setWizardMode("quick")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
            wizardMode === "quick"
              ? "bg-blue-600 text-white"
              : "text-[#71717a] hover:text-[#e4e4e7]"
          }`}
        >
          ⚡ Quick Launch
        </button>
        <button
          type="button"
          onClick={() => setWizardMode("manual")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
            wizardMode === "manual"
              ? "bg-blue-600 text-white"
              : "text-[#71717a] hover:text-[#e4e4e7]"
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
            <label className="block text-sm font-medium text-[#e4e4e7]">Collateral Mint Address</label>
            <FieldHint>The SPL token used as collateral. Traders deposit this token and profits/losses are settled in it.</FieldHint>
            <input type="text" value={mint} onChange={(e) => setMint(e.target.value.trim())} placeholder="e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs text-[#e4e4e7] placeholder-[#52525b] ${mint && !mintValid ? "border-red-500/50 bg-red-900/20" : "border-[#1e1e2e] bg-[#1a1a28]"} focus:border-blue-500 focus:outline-none`} />
            {mint && !mintValid && <p className="mt-1 text-xs text-red-400">Invalid base58 public key</p>}
            {tokenMeta && mintValid && (
              <div className="mt-2 flex items-center gap-3 rounded-lg bg-blue-900/20 p-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-900/40 text-xs font-bold text-blue-400">{tokenMeta.symbol.slice(0, 2)}</div>
                <div>
                  <p className="text-sm font-medium text-[#e4e4e7]">{tokenMeta.name} ({tokenMeta.symbol})</p>
                  <p className="text-xs text-[#71717a]">{tokenMeta.decimals} decimals</p>
                </div>
              </div>
            )}
            {balanceLoading && mintValid && <p className="mt-1 text-xs text-[#52525b]">Loading balance...</p>}
            {tokenBalance !== null && tokenMeta && (
              <p className="mt-1 text-xs text-[#71717a]">Your balance: <span className="font-medium text-[#e4e4e7]">{formatHumanAmount(tokenBalance, tokenMeta.decimals)} {tokenMeta.symbol}</span></p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-[#e4e4e7]">Oracle Mode</label>
            <FieldHint><strong>DEX Pool</strong> — uses an on-chain DEX pool as oracle. Works with any token that has a pool. <strong>Pyth</strong> — uses Pyth Network&apos;s decentralized price feeds for major assets.</FieldHint>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => { setOracleMode("dex"); setFeedId(""); setSelectedFeedName(null); }} className={`rounded-lg px-4 py-2 text-sm font-medium ${oracleMode === "dex" ? "bg-blue-600 text-white" : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"}`}>DEX Pool</button>
              <button type="button" onClick={() => { setOracleMode("pyth"); setDexPoolAddress(""); setSelectedDexPool(null); }} className={`rounded-lg px-4 py-2 text-sm font-medium ${oracleMode === "pyth" ? "bg-blue-600 text-white" : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"}`}>Pyth Oracle</button>
            </div>
          </div>
          {oracleMode === "pyth" && (
            <div>
              <label className="block text-sm font-medium text-[#e4e4e7]">Pyth Feed ID (hex, 64 chars)</label>
              {pythFeeds.length > 0 && !feedId && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-[#71717a]">Select a feed:</p>
                  {pythFeeds.map((f) => (
                    <button key={f.id} type="button" onClick={() => { setFeedId(f.id); setSelectedFeedName(f.displayName); }} className="flex w-full items-center justify-between rounded-lg border border-[#1e1e2e] px-3 py-2 text-left text-sm hover:border-blue-500/50 hover:bg-blue-900/20">
                      <span className="font-medium text-[#e4e4e7]">{f.displayName}</span>
                      <span className="font-mono text-xs text-[#52525b]">{f.id.slice(0, 12)}...</span>
                    </button>
                  ))}
                </div>
              )}
              {pythLoading && <p className="mt-1 text-xs text-[#52525b]">Searching Pyth feeds...</p>}
              {!pythLoading && pythFeeds.length === 0 && tokenMeta?.symbol && <p className="mt-1 text-xs text-[#52525b]">No Pyth feeds found for &ldquo;{tokenMeta.symbol}&rdquo;. Enter a feed ID manually below.</p>}
              {feedId && selectedFeedName && (
                <div className="mt-2 flex items-center justify-between rounded-lg bg-blue-900/20 p-2">
                  <span className="text-sm font-medium text-blue-300">{selectedFeedName}</span>
                  <button type="button" onClick={() => { setFeedId(""); setSelectedFeedName(null); }} className="text-xs text-blue-400 hover:underline">Change</button>
                </div>
              )}
              <input type="text" value={feedId} onChange={(e) => { setFeedId(e.target.value.trim()); setSelectedFeedName(null); }} placeholder="e.g. ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs text-[#e4e4e7] placeholder-[#52525b] ${feedId && !feedValid ? "border-red-500/50 bg-red-900/20" : "border-[#1e1e2e] bg-[#1a1a28]"} focus:border-blue-500 focus:outline-none`} />
              {feedId && !feedValid && <p className="mt-1 text-xs text-red-400">Must be exactly 64 hex characters</p>}
              <a href="https://pyth.network/developers/price-feed-ids" target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-blue-400 hover:underline">Browse all Pyth feed IDs</a>
            </div>
          )}
          {oracleMode === "dex" && (
            <div>
              <label className="block text-sm font-medium text-[#e4e4e7]">DEX Pool Address</label>
              <FieldHint>Uses an on-chain DEX pool as the price oracle. Works with any token that has a trading pool on PumpSwap, Raydium, or Meteora. Fully permissionless — no external oracle operator needed.</FieldHint>
              {dexPools.length > 0 && !dexPoolAddress && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-[#71717a]">Discovered pools (by liquidity):</p>
                  {dexPools.map((pool) => (
                    <button key={pool.poolAddress} type="button" onClick={() => { setDexPoolAddress(pool.poolAddress); setSelectedDexPool(pool); }} className="flex w-full items-center justify-between rounded-lg border border-[#1e1e2e] px-3 py-2 text-left text-sm hover:border-blue-500/50 hover:bg-blue-900/20">
                      <div>
                        <span className="font-medium text-[#e4e4e7]">{pool.pairLabel}</span>
                        <span className="ml-2 text-xs text-[#52525b] capitalize">{pool.dexId}</span>
                      </div>
                      <div className="text-right"><span className="text-xs text-[#71717a]">${pool.liquidityUsd.toLocaleString()} liq</span></div>
                    </button>
                  ))}
                </div>
              )}
              {dexPoolsLoading && <p className="mt-1 text-xs text-[#52525b]">Searching DEX pools...</p>}
              {!dexPoolsLoading && dexPools.length === 0 && mintValid && <p className="mt-1 text-xs text-[#52525b]">No supported DEX pools found. Enter a pool address manually.</p>}
              {dexPoolAddress && selectedDexPool && (
                <div className="mt-2 flex items-center justify-between rounded-lg bg-blue-900/20 p-2">
                  <div>
                    <span className="text-sm font-medium text-blue-300">{selectedDexPool.pairLabel}</span>
                    <span className="ml-2 text-xs text-blue-400 capitalize">{selectedDexPool.dexId}</span>
                  </div>
                  <button type="button" onClick={() => { setDexPoolAddress(""); setSelectedDexPool(null); }} className="text-xs text-blue-400 hover:underline">Change</button>
                </div>
              )}
              <input type="text" value={dexPoolAddress} onChange={(e) => { setDexPoolAddress(e.target.value.trim()); setSelectedDexPool(null); }} placeholder="Pool address (base58)" className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs text-[#e4e4e7] placeholder-[#52525b] ${dexPoolAddress && !dexPoolValid ? "border-red-500/50 bg-red-900/20" : "border-[#1e1e2e] bg-[#1a1a28]"} focus:border-blue-500 focus:outline-none`} />
              {dexPoolAddress && !dexPoolValid && <p className="mt-1 text-xs text-red-400">Invalid base58 public key</p>}
            </div>
          )}
          <div>
            <label className="flex items-center gap-2 text-sm text-[#e4e4e7]">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="rounded border-[#1e1e2e]" />
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
            <label className="block text-sm font-medium text-[#e4e4e7] mb-2">Market Capacity (Slab Size)</label>
            <FieldHint>How many trader slots this market supports. Larger = more traders but higher rent cost.</FieldHint>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(Object.entries(SLAB_TIERS) as [SlabTierKey, typeof SLAB_TIERS[SlabTierKey]][]).map(([key, tier]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSlabTier(key)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    slabTier === key
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-[#1e1e2e] bg-[#1a1a28] hover:border-[#2e2e3e]"
                  }`}
                >
                  <p className={`text-sm font-semibold ${slabTier === key ? "text-blue-400" : "text-[#e4e4e7]"}`}>
                    {tier.label}
                  </p>
                  <p className="text-xs text-[#71717a]">{tier.description}</p>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#e4e4e7]">Trading Fee: {tradingFeeBps} bps ({(tradingFeeBps / 100).toFixed(2)}%)</label>
            <FieldHint>Fee charged on every trade. 30 bps (0.30%) is standard for most perp exchanges.</FieldHint>
            <input type="range" min={1} max={100} value={tradingFeeBps} onChange={(e) => setTradingFeeBps(Number(e.target.value))} className="mt-1 w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#e4e4e7]">Initial Margin: {initialMarginBps} bps ({(initialMarginBps / 100).toFixed(1)}%)</label>
            <FieldHint>Minimum collateral to open a position as % of notional. {initialMarginBps} bps = {(initialMarginBps / 100).toFixed(0)}% = {maxLeverage}x max leverage.</FieldHint>
            <input type="range" min={100} max={5000} step={100} value={initialMarginBps} onChange={(e) => setInitialMarginBps(Number(e.target.value))} className="mt-1 w-full" />
          </div>
          <div className="grid grid-cols-2 gap-4 rounded-lg bg-[#1a1a28] p-3">
            <div>
              <p className="text-xs text-[#71717a]">Maintenance Margin</p>
              <p className="text-sm font-medium text-[#e4e4e7]">{(maintenanceMarginBps / 100).toFixed(1)}%</p>
              <p className="text-xs text-[#52525b]">Positions below this are liquidated</p>
            </div>
            <div>
              <p className="text-xs text-[#71717a]">Max Leverage</p>
              <p className="text-sm font-medium text-[#e4e4e7]">{maxLeverage}x</p>
            </div>
          </div>
        </div>
      </StepSection>

      <StepSection open={openStep === 3} onToggle={() => setOpenStep(openStep === 3 ? 0 : 3)} title="Liquidity Setup" stepNum={3} valid={step3Valid}>
        <div className="space-y-4">
          {tokenBalance !== null && tokenMeta && (
            <div className="rounded-lg bg-[#1a1a28] p-3">
              <p className="text-xs text-[#71717a]">Your balance</p>
              <p className="text-sm font-medium text-[#e4e4e7]">{formatHumanAmount(tokenBalance, tokenMeta.decimals)} {tokenMeta.symbol}</p>
            </div>
          )}
          {balanceLoading && <p className="text-xs text-[#52525b]">Loading balance...</p>}
          <div>
            <label className="block text-sm font-medium text-[#e4e4e7]">LP Collateral{tokenMeta ? ` (${tokenMeta.symbol})` : ""}</label>
            <FieldHint>Initial liquidity backing the other side of every trade. More collateral = market handles larger positions.</FieldHint>
            <input type="text" value={lpCollateral} onChange={(e) => setLpCollateral(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 1000.00" className="mt-1 w-full rounded-lg border border-[#1e1e2e] bg-[#1a1a28] px-3 py-2 text-sm text-[#e4e4e7] placeholder-[#52525b] focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#e4e4e7]">Insurance Fund{tokenMeta ? ` (${tokenMeta.symbol})` : ""}</label>
            <FieldHint>Safety buffer absorbing losses from liquidations. More insurance = healthier market.</FieldHint>
            <input type="text" value={insuranceAmount} onChange={(e) => setInsuranceAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 500.00" className="mt-1 w-full rounded-lg border border-[#1e1e2e] bg-[#1a1a28] px-3 py-2 text-sm text-[#e4e4e7] placeholder-[#52525b] focus:border-blue-500 focus:outline-none" />
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
            <tbody className="divide-y divide-[#1e1e2e]">
              <tr><td className="py-2 text-[#71717a]">Mint</td><td className="py-2 text-right text-[#e4e4e7]">{tokenMeta ? <span>{tokenMeta.name} ({tokenMeta.symbol})</span> : mintValid ? <span className="font-mono text-xs">{mint.slice(0, 12)}...</span> : "—"}</td></tr>
              <tr><td className="py-2 text-[#71717a]">Oracle</td><td className="py-2 text-right text-[#e4e4e7]">{oracleMode === "dex" ? selectedDexPool ? `DEX — ${selectedDexPool.pairLabel} (${selectedDexPool.dexId})` : `DEX — ${dexPoolAddress.slice(0, 12)}...` : selectedFeedName ? `Pyth — ${selectedFeedName}` : `Pyth — ${feedId.slice(0, 12)}...`}</td></tr>
              <tr><td className="py-2 text-[#71717a]">Inverted</td><td className="py-2 text-right text-[#e4e4e7]">{invert ? "Yes" : "No"}</td></tr>
              <tr><td className="py-2 text-[#71717a]">Trading Fee</td><td className="py-2 text-right text-[#e4e4e7]">{tradingFeeBps} bps ({(tradingFeeBps / 100).toFixed(2)}%)</td></tr>
              <tr><td className="py-2 text-[#71717a]">Initial Margin</td><td className="py-2 text-right text-[#e4e4e7]">{initialMarginBps} bps ({maxLeverage}x max)</td></tr>
              <tr><td className="py-2 text-[#71717a]">LP Collateral</td><td className="py-2 text-right text-[#e4e4e7]">{lpCollateral ? `${lpCollateral} ${symbol}` : "—"}</td></tr>
              <tr><td className="py-2 text-[#71717a]">Insurance Fund</td><td className="py-2 text-right text-[#e4e4e7]">{insuranceAmount ? `${insuranceAmount} ${symbol}` : "—"}</td></tr>
            </tbody>
          </table>
          <div className="rounded-lg bg-[#1a1a28] p-3">
            <p className="text-xs text-[#71717a]">Estimated SOL cost</p>
            <p className="text-sm font-medium text-[#e4e4e7]">~6.9 SOL (slab rent + tx fees)</p>
          </div>
          {!publicKey && <p className="text-sm text-amber-400">Connect your wallet to create a market.</p>}
          <button onClick={handleCreate} disabled={!allValid || !publicKey} className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-[#1e1e2e] disabled:text-[#52525b]">Create Market</button>
        </div>
      </StepSection>
      </>}
    </div>
  );
};
