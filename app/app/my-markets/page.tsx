"use client";

import { FC, useState, useEffect, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useMyMarkets, type MyMarket } from "@/hooks/useMyMarkets";
import { useAdminActions } from "@/hooks/useAdminActions";
import { useToast } from "@/hooks/useToast";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowButton } from "@/components/ui/GlowButton";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { getConfig, explorerAccountUrl } from "@/lib/config";
import { deriveInsuranceLpMint } from "@percolator/core";

/* helpers */
function fmt(v: bigint, decimals = 6): string {
  const n = Number(v) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtPrice(v: bigint): string {
  const n = Number(v) / 1e6;
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function timeAgo(slot: bigint, currentSlot: bigint): string {
  const diff = Number(currentSlot - slot);
  if (diff < 0) return "just now";
  const secs = Math.floor(diff * 0.4);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/* confirm dialog */
const ConfirmDialog: FC<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}> = ({ open, title, description, confirmLabel, onConfirm, onCancel, danger }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="mx-4 max-w-md rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-8">
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="mt-2 text-sm text-[#71717a]">{description}</p>
        <div className="mt-6 flex gap-3">
          <GlowButton variant="ghost" size="sm" onClick={onCancel}>cancel</GlowButton>
          <GlowButton
            variant={danger ? "secondary" : "primary"}
            size="sm"
            onClick={onConfirm}
            className={danger ? "!border-[#FF4466]/30 !text-[#FF4466] hover:!bg-[#FF4466]/10" : ""}
          >
            {confirmLabel}
          </GlowButton>
        </div>
      </div>
    </div>
  );
};

/* input dialog */
const InputDialog: FC<{
  open: boolean;
  title: string;
  description: string;
  placeholder: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}> = ({ open, title, description, placeholder, confirmLabel, onConfirm, onCancel }) => {
  const [value, setValue] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="mx-4 max-w-md w-full rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-8">
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="mt-2 text-sm text-[#71717a]">{description}</p>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="mt-4 w-full rounded-[4px] border border-[#1a1a1f] bg-[#09090b] px-4 py-2.5 text-sm text-white placeholder-[#3f3f46] outline-none focus:border-[#3f3f46]"
        />
        <div className="mt-4 flex gap-3">
          <GlowButton variant="ghost" size="sm" onClick={onCancel}>cancel</GlowButton>
          <GlowButton
            variant="primary"
            size="sm"
            disabled={!value.trim()}
            onClick={() => { onConfirm(value.trim()); setValue(""); }}
          >
            {confirmLabel}
          </GlowButton>
        </div>
      </div>
    </div>
  );
};

/* market card */
const MarketCard: FC<{
  market: MyMarket;
  insuranceMintExists: boolean;
  insuranceMintChecking: boolean;
}> = ({ market, insuranceMintExists, insuranceMintChecking }) => {
  const { toast } = useToast();
  const actions = useAdminActions();
  const wallet = useWallet();
  const cfg = getConfig();

  const slab = market.slabAddress.toBase58();
  const oi = market.engine?.totalOpenInterest ?? 0n;
  const vault = market.engine?.vault ?? 0n;
  const insurance = market.engine?.insuranceFund?.balance ?? 0n;
  const lastCrank = market.engine?.lastCrankSlot ?? 0n;
  const currentSlot = market.engine?.currentSlot ?? 0n;
  const staleness = Number(currentSlot - lastCrank);
  const healthy = staleness < Number(market.engine?.maxCrankStalenessSlots ?? 100n);
  const oraclePrice = market.config?.authorityPriceE6 ?? 0n;
  const oracleAuthority = market.config?.oracleAuthority?.toBase58?.() ?? PublicKey.default.toBase58();
  const hasOracleAuthority = oracleAuthority !== PublicKey.default.toBase58();
  const isOracleAuthority = wallet.publicKey?.toBase58() === oracleAuthority;
  const crankIsAuthority = cfg.crankWallet ? oracleAuthority === cfg.crankWallet : false;
  const riskThreshold = market.params?.riskReductionThreshold ?? 0n;
  const riskGateActive = riskThreshold > 0n && vault <= riskThreshold;

  const [showBurnConfirm, setShowBurnConfirm] = useState(false);
  const [burnConfirmText, setBurnConfirmText] = useState("");
  const [showOracleInput, setShowOracleInput] = useState(false);
  const [showPriceInput, setShowPriceInput] = useState(false);
  const [showTopUpInput, setShowTopUpInput] = useState(false);

  async function handleAction(name: string, fn: () => Promise<string>) {
    try {
      const sig = await fn();
      toast(`${name} successful! Tx: ${sig.slice(0, 16)}...`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : `${name} failed`, "error");
    }
  }

  return (
    <>
      <div className="rounded-[4px] border border-[#1a1a1f] bg-[#111113]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1a1a1f] p-5">
          <div>
            <p className="font-semibold text-white">{market.label}</p>
            <a
              href={explorerAccountUrl(slab)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#71717a] hover:text-[#00FFB2] transition-colors"
            >
              {shortAddr(slab)} &rarr;
            </a>
          </div>
          <div className="flex items-center gap-2">
            {market.header?.paused && (
              <span className="rounded-full bg-[#FFB800]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#FFB800]">
                PAUSED
              </span>
            )}
            <span className={`text-xs font-bold ${healthy ? "text-[#00FFB2]" : "text-[#FF4466]"}`}>
              {healthy ? "healthy" : "stale"}
            </span>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
          {[
            { label: "oracle price", value: oraclePrice > 0n ? fmtPrice(oraclePrice) : "N/A" },
            { label: "open interest", value: fmt(oi) },
            { label: "vault balance", value: fmt(vault) },
            { label: "insurance", value: fmt(insurance) },
            { label: "last crank", value: timeAgo(lastCrank, currentSlot) },
            { label: "staleness", value: `${staleness} slots` },
            { label: "oracle authority", value: hasOracleAuthority ? shortAddr(oracleAuthority) : "none" },
            { label: "active accounts", value: market.engine?.numUsedAccounts?.toString() ?? "0" },
          ].map((s) => (
            <div key={s.label} className="border-t border-[#1a1a1f] p-4">
              <p className="text-[10px] uppercase tracking-wider text-[#3f3f46]">{s.label}</p>
              <p className="mt-1 text-sm text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-[#1a1a1f] p-5">
          <span className={`mr-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
            market.role === "admin"
              ? "bg-[#7B61FF]/10 text-[#7B61FF]"
              : market.role === "lp"
                ? "bg-[#00FFB2]/10 text-[#00FFB2]"
                : "bg-[#FFB800]/10 text-[#FFB800]"
          }`}>
            {market.role}
          </span>
          {market.role === "admin" && (
            <>
              <button onClick={() => setShowOracleInput(true)} disabled={actions.loading === "setOracleAuthority"} className="text-xs text-[#71717a] hover:text-[#fafafa] transition-colors disabled:opacity-40">
                set oracle authority
              </button>
              {isOracleAuthority ? (
                <button onClick={() => setShowPriceInput(true)} disabled={actions.loading === "pushPrice"} className="text-xs text-[#71717a] hover:text-[#fafafa] transition-colors disabled:opacity-40" title="On devnet, you push prices manually. On mainnet, prices come from live oracle feeds automatically.">
                  push price
                </button>
              ) : crankIsAuthority ? (
                <span className="text-xs text-[var(--text-dim)]" title={`Oracle: crank (${shortAddr(oracleAuthority)})`}>auto-price (crank)</span>
              ) : hasOracleAuthority ? (
                <span className="text-xs text-[var(--text-dim)]" title={`Oracle: ${oracleAuthority}`}>delegated</span>
              ) : null}
              {isOracleAuthority && cfg.crankWallet && (
                <button
                  onClick={() => handleAction("Delegate to Crank", () => actions.setOracleAuthority(market, cfg.crankWallet!))}
                  disabled={actions.loading === "setOracleAuthority"}
                  className="text-xs text-[var(--text-dim)] hover:text-[#fafafa] transition-colors disabled:opacity-40"
                >
                  delegate to crank
                </button>
              )}
              <button onClick={() => setShowTopUpInput(true)} disabled={actions.loading === "topUpInsurance"} className="text-xs text-[#71717a] hover:text-[#fafafa] transition-colors disabled:opacity-40">
                top up insurance
              </button>
              {riskGateActive && (
                <button
                  onClick={() => handleAction("Reset Risk Gate", () => actions.resetRiskGate(market))}
                  disabled={actions.loading === "resetRiskGate"}
                  className="text-xs text-[#FFB800] hover:text-[#FFD700] transition-colors disabled:opacity-40 animate-pulse"
                >
                  {actions.loading === "resetRiskGate" ? "resetting..." : "reset risk gate"}
                </button>
              )}
              {/* P-HIGH-7: Show loading state during insurance mint check */}
              {insuranceMintChecking ? (
                <span className="text-xs text-[#71717a]">checking insurance mint...</span>
              ) : !insuranceMintExists ? (
                <button
                  onClick={() => handleAction("Create Insurance Mint", () => actions.createInsuranceMint(market))}
                  disabled={actions.loading === "createInsuranceMint"}
                  className="text-xs text-[#71717a] hover:text-[#fafafa] transition-colors disabled:opacity-40"
                >
                  {actions.loading === "createInsuranceMint" ? "creating..." : "create insurance mint"}
                </button>
              ) : null}
              {!market.header?.paused ? (
                <button
                  onClick={() => handleAction("Pause Market", () => actions.pauseMarket(market))}
                  disabled={actions.loading === "pauseMarket"}
                  className="text-xs text-[#FFB800] hover:text-[#FFD700] transition-colors disabled:opacity-40"
                >
                  {actions.loading === "pauseMarket" ? "pausing..." : "pause market"}
                </button>
              ) : (
                <button
                  onClick={() => handleAction("Unpause Market", () => actions.unpauseMarket(market))}
                  disabled={actions.loading === "unpauseMarket"}
                  className="text-xs text-[#00FFB2] hover:text-[#00FFD5] transition-colors disabled:opacity-40"
                >
                  {actions.loading === "unpauseMarket" ? "unpausing..." : "unpause market"}
                </button>
              )}
              <button
                onClick={() => setShowBurnConfirm(true)}
                disabled={actions.loading === "renounceAdmin"}
                className="text-xs text-[#FF4466]/70 hover:text-[#FF4466] transition-colors disabled:opacity-40"
              >
                burn admin key
              </button>
            </>
          )}
          <Link href={`/trade/${slab}`} className="text-xs text-[#00FFB2] hover:opacity-80 transition-opacity">
            trade &rarr;
          </Link>
        </div>
      </div>

      {/* Dialogs */}
      <InputDialog
        open={showOracleInput}
        title="set oracle authority"
        description="enter the public key that will be authorized to push oracle price updates."
        placeholder={cfg.crankWallet || "pubkey..."}
        confirmLabel="set authority"
        onConfirm={(v) => { setShowOracleInput(false); handleAction("Set Oracle Authority", () => actions.setOracleAuthority(market, v)); }}
        onCancel={() => setShowOracleInput(false)}
      />
      <InputDialog
        open={showPriceInput}
        title="push oracle price"
        description="enter the price in USD (e.g. 1.50)."
        placeholder="1.00"
        confirmLabel="push price"
        onConfirm={(v) => { setShowPriceInput(false); const parsed = parseFloat(v); if (isNaN(parsed) || parsed <= 0) return; const priceE6 = Math.round(parsed * 1e6).toString(); handleAction("Push Price", () => actions.pushPrice(market, priceE6)); }}
        onCancel={() => setShowPriceInput(false)}
      />
      <InputDialog
        open={showTopUpInput}
        title="top up insurance fund"
        description="enter the amount of collateral tokens to add."
        placeholder="100"
        confirmLabel="top up"
        onConfirm={(v) => { setShowTopUpInput(false); const parsed = parseFloat(v); if (isNaN(parsed) || parsed <= 0) return; const amount = BigInt(Math.round(parsed * 1e6)); handleAction("Top Up Insurance", () => actions.topUpInsurance(market, amount)); }}
        onCancel={() => setShowTopUpInput(false)}
      />
      {/* Burn admin key - requires typing BURN to confirm */}
      {showBurnConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="mx-4 max-w-md w-full rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-8">
            <h3 className="text-lg font-bold text-white">burn admin key</h3>
            <p className="mt-2 text-sm text-[#71717a]">
              This is permanent and irreversible. You will never be able to update config, set oracle, or perform any admin actions on this market again.
            </p>
            <p className="mt-4 text-sm font-semibold text-[#FF4466]">
              Type "BURN" to confirm:
            </p>
            <input
              value={burnConfirmText}
              onChange={(e) => setBurnConfirmText(e.target.value)}
              placeholder="BURN"
              className="mt-2 w-full rounded-[4px] border border-[#1a1a1f] bg-[#09090b] px-4 py-2.5 text-sm text-white placeholder-[#3f3f46] outline-none focus:border-[#3f3f46]"
            />
            <div className="mt-4 flex gap-3">
              <GlowButton variant="ghost" size="sm" onClick={() => { setShowBurnConfirm(false); setBurnConfirmText(""); }}>cancel</GlowButton>
              <GlowButton
                variant="secondary"
                size="sm"
                disabled={burnConfirmText !== "BURN"}
                onClick={() => { 
                  setShowBurnConfirm(false); 
                  setBurnConfirmText("");
                  handleAction("Burn Admin Key", () => actions.renounceAdmin(market)); 
                }}
                className="!border-[#FF4466]/30 !text-[#FF4466] hover:!bg-[#FF4466]/10 disabled:opacity-40"
              >
                burn it
              </GlowButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

/* loading skeleton */
const LoadingSkeleton: FC = () => (
  <div className="min-h-[calc(100vh-48px)] relative">
    <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
    <main className="relative mx-auto max-w-4xl px-4 py-10">
      <ShimmerSkeleton className="mb-2 h-3 w-16" />
      <ShimmerSkeleton className="mb-2 h-7 w-48" />
      <ShimmerSkeleton className="mb-8 h-4 w-64" />
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[1, 2, 3].map((i) => <ShimmerSkeleton key={i} className="h-20" />)}
      </div>
      {[1, 2].map((i) => <ShimmerSkeleton key={i} className="mb-4 h-64" />)}
    </main>
  </div>
);

/* main page */
const MyMarketsPage: FC = () => {
  const { myMarkets, loading, error, connected } = useMyMarkets();
  const { connection } = useConnection();
  const [insuranceMintMap, setInsuranceMintMap] = useState<Record<string, boolean>>({});
  // P-HIGH-7: Add loading state for insurance mint checks
  const [insuranceMintChecking, setInsuranceMintChecking] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pageRef.current.style.opacity = "1";
      return;
    }
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }, []);

  // P-MED-13: Manual refresh function
  const handleRefresh = async () => {
    setRefreshing(true);
    setInsuranceMintChecking(true);
    // Re-check insurance mints
    if (myMarkets.length > 0) {
      const pdas = myMarkets.map((m) => ({
        key: m.slabAddress.toBase58(),
        pda: deriveInsuranceLpMint(m.programId, m.slabAddress)[0],
      }));
      const results = await Promise.allSettled(
        pdas.map((p) => connection.getAccountInfo(p.pda))
      );
      const map: Record<string, boolean> = {};
      for (let i = 0; i < pdas.length; i++) {
        const result = results[i];
        map[pdas[i].key] = result.status === "fulfilled" && result.value !== null && result.value.data.length > 0;
      }
      setInsuranceMintMap(map);
      setInsuranceMintChecking(false);
    }
    setTimeout(() => setRefreshing(false), 500);
  };

  useEffect(() => {
    if (!myMarkets.length) {
      setInsuranceMintChecking(false);
      return;
    }
    let cancelled = false;
    setInsuranceMintChecking(true);
    async function check() {
      const pdas = myMarkets.map((m) => ({
        key: m.slabAddress.toBase58(),
        pda: deriveInsuranceLpMint(m.programId, m.slabAddress)[0],
      }));
      const results = await Promise.allSettled(
        pdas.map((p) => connection.getAccountInfo(p.pda))
      );
      const map: Record<string, boolean> = {};
      for (let i = 0; i < pdas.length; i++) {
        const result = results[i];
        map[pdas[i].key] = result.status === "fulfilled" && result.value !== null && result.value.data.length > 0;
      }
      if (!cancelled) {
        setInsuranceMintMap(map);
        setInsuranceMintChecking(false);
      }
    }
    check();
    return () => { cancelled = true; };
  }, [myMarkets, connection]);

  if (!connected) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <main className="relative mx-auto max-w-4xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // admin
          </div>
          <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-white/50">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage what you&apos;ve built.</p>
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
            <p className="text-[13px] text-[var(--text-secondary)]">connect your wallet to see your markets</p>
          </div>
        </main>
      </div>
    );
  }

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <main className="relative mx-auto max-w-4xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // admin
          </div>
          <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-white/50">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage what you&apos;ve built.</p>
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
            <p className="text-[13px] text-[var(--short)]">{error}</p>
          </div>
        </main>
      </div>
    );
  }

  if (myMarkets.length === 0) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <main className="relative mx-auto max-w-4xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // admin
          </div>
          <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-white/50">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage what you&apos;ve built.</p>
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
            <p className="mb-4 text-[13px] text-[var(--text-secondary)]">
              no markets created or traded on with this wallet.
              <br />
              create a market or open a position to see it here.
            </p>
            <div className="flex justify-center gap-3">
              <Link href="/create">
                <GlowButton>launch a market</GlowButton>
              </Link>
              <Link href="/markets">
                <GlowButton variant="ghost">browse markets</GlowButton>
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const totalMarkets = myMarkets.length;
  const totalVault = myMarkets.reduce((acc, m) => acc + m.engine.vault, 0n);
  const totalInsurance = myMarkets.reduce((acc, m) => acc + m.engine.insuranceFund.balance, 0n);

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
    <main ref={pageRef} className="relative mx-auto max-w-4xl px-4 py-10 gsap-fade">
      <ScrollReveal>
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // admin
            </div>
            <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              <span className="font-normal text-white/50">Your </span>Markets
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">manage what you&apos;ve built.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text)] disabled:opacity-40"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <Link href="/create">
              <GlowButton size="sm">+ new market</GlowButton>
            </Link>
          </div>
        </div>
      </ScrollReveal>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: "total markets", value: totalMarkets.toString() },
          { label: "total TVL", value: fmt(totalVault) },
          { label: "total insurance", value: fmt(totalInsurance) },
        ].map((s) => (
          <div key={s.label} className="rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-4">
            <p className="text-xs text-[#71717a]">{s.label}</p>
            <p className="mt-1 text-xl font-bold text-white">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6">
        {myMarkets.map((m) => (
          <MarketCard
            key={m.slabAddress.toBase58()}
            market={m}
            insuranceMintExists={insuranceMintMap[m.slabAddress.toBase58()] ?? false}
            insuranceMintChecking={insuranceMintChecking}
          />
        ))}
      </div>
    </main>
    </div>
  );
};

export default MyMarketsPage;
