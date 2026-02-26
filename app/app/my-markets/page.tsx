"use client";

import { FC, useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import gsap from "gsap";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { PublicKey } from "@solana/web3.js";
import { useMyMarkets, type MyMarket } from "@/hooks/useMyMarkets";
import { useAdminActions } from "@/hooks/useAdminActions";
import { useToast } from "@/hooks/useToast";
import { getConfig, explorerAccountUrl } from "@/lib/config";
import { sanitizeAccountCount } from "@/lib/health";
import { deriveInsuranceLpMint } from "@percolator/sdk";
import { isMockMode } from "@/lib/mock-mode";
import { getMockMyMarkets } from "@/lib/mock-trade-data";

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
      <div className="mx-4 max-w-md rounded-none border border-[var(--border)]/50 bg-[var(--bg)] p-8">
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--text)]">{title}</h3>
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{description}</p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onCancel}
            className="border border-[var(--border)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)] transition-colors hover:border-[var(--border)] hover:text-[var(--text)]"
          >
            cancel
          </button>
          <button
            onClick={onConfirm}
            className={`border px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors ${
              danger
                ? "border-[var(--short)]/30 text-[var(--short)] hover:bg-[var(--short)]/10"
                : "border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10"
            }`}
          >
            {confirmLabel}
          </button>
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
      <div className="mx-4 max-w-md w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)] p-8">
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--text)]">{title}</h3>
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{description}</p>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="mt-4 w-full rounded-none border border-[var(--border)]/50 bg-transparent px-3 py-2 text-[11px] text-[var(--text)] placeholder-[var(--text-dim)] outline-none focus:border-[var(--accent)]/40"
          style={{ fontFamily: "var(--font-mono)" }}
        />
        <div className="mt-4 flex gap-3">
          <button
            onClick={onCancel}
            className="border border-[var(--border)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)] transition-colors hover:border-[var(--border)] hover:text-[var(--text)]"
          >
            cancel
          </button>
          <button
            disabled={!value.trim()}
            onClick={() => { onConfirm(value.trim()); setValue(""); }}
            className="border border-[var(--accent)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
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
  const wallet = useWalletCompat();
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

  const actionBtnClass = "text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors disabled:opacity-40";

  return (
    <>
      <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)]/30 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-[var(--text)]">{market.label}</span>
            <a
              href={explorerAccountUrl(slab)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] transition-colors"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {shortAddr(slab)} ↗
            </a>
          </div>
          <div className="flex items-center gap-2">
            {market.header?.paused && (
              <span className="border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">
                PAUSED
              </span>
            )}
            <span className={`text-[10px] font-bold uppercase tracking-[0.1em] ${healthy ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
              {healthy ? "● healthy" : "● stale"}
            </span>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4">
          {[
            { label: "oracle price", value: oraclePrice > 0n ? fmtPrice(oraclePrice) : "—" },
            { label: "open interest", value: fmt(oi) },
            { label: "vault balance", value: fmt(vault) },
            { label: "insurance", value: fmt(insurance) },
            { label: "last crank", value: timeAgo(lastCrank, currentSlot) },
            { label: "staleness", value: `${staleness} slots` },
            { label: "oracle authority", value: hasOracleAuthority ? shortAddr(oracleAuthority) : "none" },
            { label: "active accounts", value: sanitizeAccountCount(market.engine?.numUsedAccounts ?? 0).toString() },
          ].map((s, i) => (
            <div key={s.label} className="border-t border-[var(--border)]/30 px-4 py-3">
              <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{s.label}</p>
              <p className="mt-1 text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)]/30 px-4 py-3">
          <span className={`mr-1 border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] ${
            market.role === "admin"
              ? "border-[var(--accent)]/30 text-[var(--accent)]"
              : market.role === "lp"
                ? "border-[var(--long)]/30 text-[var(--long)]"
                : "border-[var(--warning)]/30 text-[var(--warning)]"
          }`}>
            {market.role}
          </span>
          {market.role === "admin" && (
            <>
              <button onClick={() => setShowOracleInput(true)} disabled={actions.loading === "setOracleAuthority"} className={actionBtnClass}>
                set oracle authority
              </button>
              {isOracleAuthority ? (
                <button onClick={() => setShowPriceInput(true)} disabled={actions.loading === "pushPrice"} className={actionBtnClass} title="On devnet, you push prices manually. On mainnet, prices come from live oracle feeds automatically.">
                  push price
                </button>
              ) : crankIsAuthority ? (
                <span className="text-[10px] text-[var(--text-dim)]" title={`Oracle: crank (${shortAddr(oracleAuthority)})`}>auto-price (crank)</span>
              ) : hasOracleAuthority ? (
                <span className="text-[10px] text-[var(--text-dim)]" title={`Oracle: ${oracleAuthority}`}>delegated</span>
              ) : null}
              {isOracleAuthority && cfg.crankWallet && (
                <button
                  onClick={() => handleAction("Delegate to Crank", () => actions.setOracleAuthority(market, cfg.crankWallet!))}
                  disabled={actions.loading === "setOracleAuthority"}
                  className={actionBtnClass}
                >
                  delegate to crank
                </button>
              )}
              <button onClick={() => setShowTopUpInput(true)} disabled={actions.loading === "topUpInsurance"} className={actionBtnClass}>
                top up insurance
              </button>
              {riskGateActive && (
                <button
                  onClick={() => handleAction("Reset Risk Gate", () => actions.resetRiskGate(market))}
                  disabled={actions.loading === "resetRiskGate"}
                  className="text-[10px] uppercase tracking-[0.1em] text-[var(--warning)] hover:text-[var(--warning)] transition-colors disabled:opacity-40 animate-pulse"
                >
                  {actions.loading === "resetRiskGate" ? "resetting..." : "reset risk gate"}
                </button>
              )}
              {insuranceMintChecking ? (
                <span className="text-[10px] text-[var(--text-dim)]">checking insurance mint...</span>
              ) : !insuranceMintExists ? (
                <button
                  onClick={() => handleAction("Create Insurance Mint", () => actions.createInsuranceMint(market))}
                  disabled={actions.loading === "createInsuranceMint"}
                  className={actionBtnClass}
                >
                  {actions.loading === "createInsuranceMint" ? "creating..." : "create insurance mint"}
                </button>
              ) : null}
              {!market.header?.paused ? (
                <button
                  onClick={() => handleAction("Pause Market", () => actions.pauseMarket(market))}
                  disabled={actions.loading === "pauseMarket"}
                  className="text-[10px] uppercase tracking-[0.1em] text-[var(--warning)] hover:brightness-125 transition-colors disabled:opacity-40"
                >
                  {actions.loading === "pauseMarket" ? "pausing..." : "pause market"}
                </button>
              ) : (
                <button
                  onClick={() => handleAction("Unpause Market", () => actions.unpauseMarket(market))}
                  disabled={actions.loading === "unpauseMarket"}
                  className="text-[10px] uppercase tracking-[0.1em] text-[var(--long)] hover:brightness-125 transition-colors disabled:opacity-40"
                >
                  {actions.loading === "unpauseMarket" ? "unpausing..." : "unpause market"}
                </button>
              )}
              <button
                onClick={() => setShowBurnConfirm(true)}
                disabled={actions.loading === "renounceAdmin"}
                className="text-[10px] uppercase tracking-[0.1em] text-[var(--short)]/70 hover:text-[var(--short)] transition-colors disabled:opacity-40"
              >
                burn admin key
              </button>
            </>
          )}
          <Link href={`/trade/${slab}`} className="text-[10px] uppercase tracking-[0.1em] text-[var(--long)] hover:brightness-125 transition-all">
            trade →
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
          <div className="mx-4 max-w-md w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)] p-8">
            <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--text)]">burn admin key</h3>
            <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
              This is permanent and irreversible. You will never be able to update config, set oracle, or perform any admin actions on this market again.
            </p>
            <p className="mt-4 text-[11px] font-semibold text-[var(--short)]">
              Type &quot;BURN&quot; to confirm:
            </p>
            <input
              value={burnConfirmText}
              onChange={(e) => setBurnConfirmText(e.target.value)}
              placeholder="BURN"
              className="mt-2 w-full rounded-none border border-[var(--border)]/50 bg-transparent px-3 py-2 text-[11px] text-[var(--text)] placeholder-[var(--text-dim)] outline-none focus:border-[var(--short)]/40"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => { setShowBurnConfirm(false); setBurnConfirmText(""); }}
                className="border border-[var(--border)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)] transition-colors hover:border-[var(--border)] hover:text-[var(--text)]"
              >
                cancel
              </button>
              <button
                disabled={burnConfirmText !== "BURN"}
                onClick={() => {
                  setShowBurnConfirm(false);
                  setBurnConfirmText("");
                  handleAction("Burn Admin Key", () => actions.renounceAdmin(market));
                }}
                className="border border-[var(--short)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--short)] transition-colors hover:bg-[var(--short)]/10 disabled:opacity-40"
              >
                burn it
              </button>
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
      <div className="mb-2 h-3 w-16 animate-pulse bg-[var(--border)]/20" />
      <div className="mb-2 h-7 w-48 animate-pulse bg-[var(--border)]/20" />
      <div className="mb-8 h-4 w-64 animate-pulse bg-[var(--border)]/20" />
      <div className="mb-8 h-12 w-full animate-pulse bg-[var(--border)]/20" />
      {[1, 2].map((i) => <div key={i} className="mb-4 h-64 animate-pulse bg-[var(--border)]/20" />)}
    </main>
  </div>
);

/* main page */
const MyMarketsPage: FC = () => {
  const { myMarkets: realMyMarkets, loading: realLoading, error, connected: walletConnected } = useMyMarkets();
  const mockMode = isMockMode();
  const connected = walletConnected || mockMode;
  const mockMarkets = useMemo(() => mockMode ? getMockMyMarkets() : [], [mockMode]);
  const myMarkets = (realMyMarkets.length === 0 && mockMode ? mockMarkets : realMyMarkets) as MyMarket[];
  const loading = mockMode ? false : realLoading;
  const { connection } = useConnectionCompat();
  const [filter, setFilter] = useState<"all" | "admin" | "lp" | "trader">("all");
  const [insuranceMintMap, setInsuranceMintMap] = useState<Record<string, boolean>>({});
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

  const handleRefresh = async () => {
    setRefreshing(true);
    setInsuranceMintChecking(true);
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

  const pageHeader = (
    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
      // admin
    </div>
  );

  if (!connected) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <main className="relative mx-auto max-w-4xl px-4 py-10">
          {pageHeader}
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage your markets and positions.</p>
          <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-10 text-center">
            <p className="text-[11px] text-[var(--text-secondary)]">connect your wallet to see your markets</p>
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
          {pageHeader}
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage your markets and positions.</p>
          <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-10 text-center">
            <p className="text-[11px] text-[var(--short)]">{error}</p>
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
          {pageHeader}
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">manage your markets and positions.</p>
          <div className="border border-[var(--border)]/50 bg-[var(--panel-bg)] p-10 text-center">
            <p className="mb-4 text-[11px] text-[var(--text-secondary)]">
              no markets created or traded on with this wallet.
              <br />
              create a market or open a position to see it here.
            </p>
            <div className="flex justify-center gap-3">
              <Link href="/create" className="border border-[var(--accent)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10">
                launch a market
              </Link>
              <Link href="/markets" className="border border-[var(--border)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)] transition-colors hover:border-[var(--border)] hover:text-[var(--text)]">
                browse markets
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
        {/* Page Title */}
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">// admin</div>
        <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
          <span className="font-normal text-[var(--text-muted)]">Your </span>Markets
        </h1>
        <p className="mt-2 mb-6 text-[13px] text-[var(--text-secondary)]">manage your markets and positions.</p>

        {/* Summary Stats Bar */}
        <div className="hud-corners mb-8 flex flex-col gap-4 border border-[var(--border)]/50 bg-[var(--panel-bg)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            {[
              { label: "Total Markets", value: totalMarkets.toString() },
              { label: "TVL", value: "$" + fmt(totalVault) },
              { label: "Insurance", value: "$" + fmt(totalInsurance) },
            ].map((s) => (
              <span key={s.label} className="flex items-center gap-1.5">
                <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{s.label}:</span>
                <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{s.value}</span>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="border border-[var(--border)]/30 px-3 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text)] disabled:opacity-40"
            >
              {refreshing ? "refreshing..." : "refresh"}
            </button>
            <Link href="/create" className="border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--accent)] transition-all hover:bg-[var(--accent)]/10">
              + new market
            </Link>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="mb-4 flex border-b border-[var(--border)]/50">
          {(["all", "admin", "lp", "trader"] as const).map((tab) => {
            const count = tab === "all" ? myMarkets.length : myMarkets.filter(m => m.role === tab).length;
            return (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors border-b-2 ${
                  filter === tab
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {tab === "lp" ? "LP" : tab} ({count})
              </button>
            );
          })}
        </div>

        {/* Market Cards */}
        <div className="grid gap-4">
          {myMarkets.filter(m => filter === "all" || m.role === filter).map((m) => (
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
