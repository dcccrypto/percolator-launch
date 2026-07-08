"use client";

import { FC, useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import gsap from "gsap";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { PublicKey } from "@solana/web3.js";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { useMyMarkets, type MyMarket } from "@/hooks/useMyMarkets";
import { useAdminActions } from "@/hooks/useAdminActions";
import { useToast } from "@/hooks/useToast";
import { getConfig, explorerAccountUrl } from "@/lib/config";
import { sanitizeAccountCount } from "@/lib/health";
import { formatUsdPriceE6 } from "@/lib/format";
import { sanitizePriceE6, applyInvert } from "@/lib/oraclePrice";
import { deriveInsuranceLpMint } from "@percolatorct/sdk";
import { isMockMode } from "@/lib/mock-mode";
import { getMockMyMarkets } from "@/lib/mock-trade-data";

/* helpers */
function fmt(v: bigint, decimals = 6): string {
  const n = Number(v) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
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
  /** Current on-chain slot (from useMyMarkets' v17 enrichment fetch) — null until it resolves. */
  chainCurrentSlot: bigint | null;
}> = ({ market, insuranceMintExists, insuranceMintChecking, chainCurrentSlot }) => {
  const { toast } = useToast();
  const actions = useAdminActions();
  const wallet = useWalletCompat();
  const cfg = getConfig();

  const slab = market.slabAddress.toBase58();
  // v17 markets expose a parsed wrapperConfigV17 and carry empty header/config/
  // engine/params ({}). Several v12 admin instructions (pause/unpause, burn admin,
  // create insurance mint, admin-oracle push) are removed/changed on-chain in v17
  // and their exact v17 replacements are unconfirmed, so we hide those controls
  // for v17 markets rather than surfacing buttons that always throw.
  const isV17 = !!market.configV17;
  const v17Stats = market.v17Stats;

  // v12 legacy path — the `engine` block only ever populates on v12 slabs.
  const v12Oi = market.engine?.totalOpenInterest ?? 0n;
  const v12Vault = market.engine?.vault ?? 0n;
  const v12Insurance = market.engine?.insuranceFund?.balance ?? 0n;
  const v12LastCrank = market.engine?.lastCrankSlot ?? 0n;
  const v12CurrentSlot = market.engine?.currentSlot ?? 0n;
  const v12Staleness = Number(v12CurrentSlot - v12LastCrank);
  const v12Healthy = v12Staleness < Number(market.engine?.maxCrankStalenessSlots ?? 100n);

  // H11: v17 path — real OI/insurance come from useMyMarkets' parseMarketGroupV17OI
  // enrichment; health is derived from the asset's accrue slot (slot_last, advances
  // only via crank/trade) vs the current on-chain slot, using the same ~500-slot
  // (~190s) accrue-cliff threshold as CrankHealthCard. `null` (not 0/false) while
  // the enrichment fetch is still in flight — the UI shows "—"/"checking…" instead
  // of a fabricated healthy/zero reading.
  const V17_STALE_THRESHOLD_SLOTS = 500;
  const oi = isV17 ? (v17Stats ? v17Stats.oi.totalLongOiQ + v17Stats.oi.totalShortOiQ : null) : v12Oi;
  const insurance = isV17 ? (v17Stats?.oi.insuranceBalance ?? null) : v12Insurance;
  // v17 has no market-group-level vault or active-account count exposed yet —
  // "not tracked" beats a fabricated 0 that reads as a real empty vault.
  const vault: bigint | null = isV17 ? null : v12Vault;
  const v17StalenessSlots =
    isV17 && v17Stats?.assetSlotLast != null && chainCurrentSlot != null
      ? Math.max(0, Number(chainCurrentSlot - v17Stats.assetSlotLast))
      : null;
  const staleness = isV17 ? v17StalenessSlots : v12Staleness;
  const healthy = isV17
    ? (v17StalenessSlots != null ? v17StalenessSlots < V17_STALE_THRESHOLD_SLOTS : null)
    : v12Healthy;
  // v17 markets carry an empty v12 config ({}) — config.authorityPriceE6 is always
  // absent, so every actively-priced v17 market showed "—". The live mark
  // (configV17.markEwmaE6, keeper-updated every crank) is the same field the trade
  // page reads as the oracle/index price; apply the same sanitize + invert as there.
  const oraclePrice = isV17
    ? applyInvert(sanitizePriceE6(market.configV17?.markEwmaE6 ?? 0n), market.configV17?.invert)
    : (market.config?.authorityPriceE6 ?? 0n);
  const oracleAuthority = market.config?.oracleAuthority?.toBase58?.() ?? PublicKey.default.toBase58();
  const hasOracleAuthority = oracleAuthority !== PublicKey.default.toBase58();
  const isOracleAuthority = wallet.publicKey?.toBase58() === oracleAuthority;
  const crankIsAuthority = cfg.crankWallet ? oracleAuthority === cfg.crankWallet : false;
  const riskThreshold = market.params?.riskReductionThreshold ?? 0n;
  const riskGateActive = riskThreshold > 0n && vault != null && vault <= riskThreshold;

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
            {/* v17 has no pause state and header is {} — only read header.paused for v12. */}
            {!isV17 && market.header?.paused && (
              <span className="border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">
                PAUSED
              </span>
            )}
            <span className={`text-[10px] font-bold uppercase tracking-[0.1em] ${healthy == null ? "text-[var(--text-dim)]" : healthy ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
              {healthy == null ? "○ checking…" : healthy ? "● healthy" : "● stale"}
            </span>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4">
          {[
            { label: "oracle price", value: oraclePrice > 0n ? formatUsdPriceE6(oraclePrice) : "—" },
            { label: "open interest", value: oi != null ? fmt(oi) : "—" },
            { label: "vault balance", value: vault != null ? fmt(vault) : "not tracked" },
            { label: "insurance", value: insurance != null ? fmt(insurance) : "—" },
            {
              label: "last crank",
              value: isV17
                ? (v17Stats?.assetSlotLast != null && chainCurrentSlot != null
                    ? timeAgo(v17Stats.assetSlotLast, chainCurrentSlot)
                    : "—")
                : timeAgo(v12LastCrank, v12CurrentSlot),
            },
            { label: "staleness", value: staleness != null ? `${staleness} slots` : "—" },
            { label: "oracle authority", value: hasOracleAuthority ? shortAddr(oracleAuthority) : "none" },
            {
              label: "active accounts",
              value: isV17 ? "not tracked" : sanitizeAccountCount(market.engine?.numUsedAccounts ?? 0).toString(),
            },
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
              {/* Admin-oracle controls (set authority / push price / delegate) use the
                  v12 admin-oracle instructions that were removed on-chain in v17.
                  Hide them for v17 markets — no confirmed replacement exists. */}
              {!isV17 && (
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
                </>
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
              {/* Insurance-LP mint creation moved to the stake program and the
                  create/pause/unpause/burn-admin instructions were removed or changed
                  on-chain in v17. Gate all of them to v12 markets; hiding the RPC-heavy
                  insurance-mint check for v17 also avoids wasted getAccountInfo calls. */}
              {!isV17 && (
                <>
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
              {isV17 && (
                <span className="text-[10px] text-[var(--text-dim)]" title="Pause/unpause, create insurance mint, admin-oracle push, and burn-admin are not available on v17 markets.">
                  some admin actions not available on v17
                </span>
              )}
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
        onConfirm={(v) => {
          setShowTopUpInput(false);
          const parsed = parseFloat(v);
          if (isNaN(parsed) || parsed <= 0) return;
          // C-08: derive token decimals from on-chain unitScale (1_000_000 → 6dp, etc.)
          // unitScale is stored in both v17 (configV17.unitScale) and v12 (config.unitScale).
          // Math.log10(1_000_000) = 6; Math.log10(1_000_000_000) = 9. Default 6 if unknown.
          const unitScaleRaw = Number(market.configV17?.unitScale ?? market.config?.unitScale ?? 1_000_000);
          const collateralDecimals = unitScaleRaw > 1 ? Math.round(Math.log10(unitScaleRaw)) : 6;
          const amount = BigInt(Math.round(parsed * Math.pow(10, collateralDecimals)));
          handleAction("Top Up Insurance", () => actions.topUpInsurance(market, amount));
        }}
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
  <div className="min-h-[calc(100dvh-48px)] relative">
    <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
    <main className="relative mx-auto max-w-4xl px-4 py-10">
      <div className="mb-2">
        <ShimmerSkeleton className="h-3 w-16" />
      </div>
      <div className="mb-2">
        <ShimmerSkeleton className="h-7 w-48" />
      </div>
      <div className="mb-8">
        <ShimmerSkeleton className="h-4 w-64" />
      </div>
      <div className="mb-8">
        <ShimmerSkeleton className="h-12 w-full" />
      </div>
      {[1, 2].map((i) => (
        <div key={i} className="mb-4 border border-[var(--border)] bg-[var(--panel-bg)] p-5 space-y-4 rounded-sm">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <ShimmerSkeleton className="h-8 w-8 rounded-full" />
              <div>
                <ShimmerSkeleton className="h-4 w-24 mb-1" />
                <ShimmerSkeleton className="h-3 w-32" />
              </div>
            </div>
            <ShimmerSkeleton className="h-5 w-20" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2">
            {[1, 2, 3, 4].map(j => (
              <div key={j} className="space-y-1">
                <ShimmerSkeleton className="h-2.5 w-16" />
                <ShimmerSkeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </main>
  </div>
);

/* main page */
const MyMarketsPage: FC = () => {
  const { myMarkets: realMyMarkets, loading: realLoading, error, connected: walletConnected, refetch: refetchMarkets, currentSlot: chainCurrentSlot } = useMyMarkets();
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
    // C-07: actually re-fetch market data (not just insurance mint map)
    await refetchMarkets?.();
    // v17 markets have no per-market insurance-LP mint (moved to the stake program)
    // and the create-insurance-mint control is hidden for them — skip the RPC.
    const v12Markets = myMarkets.filter((m) => !m.configV17);
    if (v12Markets.length > 0) {
      const pdas = v12Markets.map((m) => ({
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
    } else {
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
      // v17 markets carry no per-market insurance-LP mint (moved to the stake
      // program) and hide the create-insurance-mint control — skip their RPC.
      const pdas = myMarkets
        .filter((m) => !m.configV17)
        .map((m) => ({
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
      <div className="min-h-[calc(100dvh-48px)] relative">
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
      <div className="min-h-[calc(100dvh-48px)] relative">
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
      <div className="min-h-[calc(100dvh-48px)] relative">
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
  // H11: v17 markets carry an empty legacy `engine` block ({}) — optional-chain
  // so the summary reducer doesn't throw "Cannot mix BigInt and other types"
  // (was crashing the whole page whenever a v17 market was owned). Vault has
  // no market-group-level equivalent on v17 yet, so TVL only sums v12 markets
  // and is relabeled below rather than showing a fabricated $0. Insurance IS
  // available on v17 via useMyMarkets' parseMarketGroupV17OI enrichment and is
  // included for real instead of silently contributing 0.
  const v12MarketsList = myMarkets.filter((m) => !m.configV17);
  const hasVaultData = v12MarketsList.length > 0;
  const totalVault = v12MarketsList.reduce((acc, m) => acc + (m.engine?.vault ?? 0n), 0n);
  const totalInsurance = myMarkets.reduce((acc, m) => {
    if (m.configV17) return acc + (m.v17Stats?.oi.insuranceBalance ?? 0n);
    return acc + (m.engine?.insuranceFund?.balance ?? 0n);
  }, 0n);

  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
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
              { label: "TVL", value: hasVaultData ? "$" + fmt(totalVault) : "not tracked" },
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
              chainCurrentSlot={chainCurrentSlot}
            />
          ))}
        </div>
      </main>
    </div>
  );
};

export default MyMarketsPage;
