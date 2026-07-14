"use client";

import { FC, useCallback, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import type { CreatorMarketDetail } from "./types";
import { unitScaleToDecimals, deriveMarketLiquidityAtoms, lpCollateralMateriallyDiverges } from "./types";
import { useAdminActions } from "@/hooks/useAdminActions";
import { useCloseMarket } from "@/hooks/useCloseMarket";
import { useToast } from "@/hooks/useToast";
import { explorerAccountUrl } from "@/lib/config";
import { computeMarketHealthFromStats } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { MarketLogo } from "@/components/market/MarketLogo";
import { LogoUpload } from "@/components/create/LogoUpload";
import { Tooltip } from "@/components/ui/Tooltip";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { formatUsdFromNumber, formatStatValue, formatSlotAge } from "@/lib/format";
import { detectOracleMode, sanitizePriceE6, applyInvert, priceE6ToUsd } from "@/lib/oraclePrice";

/** Same accrue-cliff threshold as useCreatedMarkets/CrankHealthCard — the
 *  asset's accrue slot (advances only via crank/trade) vs the current
 *  on-chain slot. Distinct signal from HealthBadge's liquidity ratio. */
const V17_STALE_THRESHOLD_SLOTS = 500;

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

/** Live-ticking price cell — mirrors markets/page.tsx's LiveRowPrice so a
 *  price tick re-renders only this cell, not the whole row/list. */
const LiveRowPrice: FC<{ slab: string; fallback: number | null }> = ({ slab, fallback }) => {
  const subscribe = useCallback((cb: () => void) => subscribeSlab(slab, cb), [slab]);
  const getSnap = useCallback(() => getSnapshot(slab).priceUsd, [slab]);
  const live = useSyncExternalStore(subscribe, getSnap, () => null);
  return <>{formatUsdFromNumber(live ?? fallback)}</>;
};

/* ── small local dialogs (only consumer is this row's drawer) ── */
const ConfirmDialog: FC<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  errorText?: string | null;
}> = ({ open, title, description, confirmLabel, onConfirm, onCancel, danger, errorText }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="mx-4 max-w-md rounded-none border border-[var(--border)]/50 bg-[var(--bg)] p-8">
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--text)]">{title}</h3>
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{description}</p>
        {errorText && <p className="mt-2 text-[11px] text-[var(--short)]">{errorText}</p>}
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

interface CreatorMarketRowProps {
  market: CreatedMarket;
  /** null while the per-market /api/markets/[slab] detail fetch is in flight
   *  (fetched once, batched, at the page level — see app/my-markets/page.tsx —
   *  NOT re-fetched again when the drawer opens). */
  detail: CreatorMarketDetail | null;
  /** Current on-chain slot from useCreatedMarkets' v17 enrichment fetch. */
  chainCurrentSlot: bigint | null;
  expanded: boolean;
  onToggleExpand: () => void;
}

export const CreatorMarketRow: FC<CreatorMarketRowProps> = ({ market, detail, chainCurrentSlot, expanded, onToggleExpand }) => {
  const { toast } = useToast();
  const actions = useAdminActions();
  const closeMarket = useCloseMarket();

  const slab = market.slabAddress.toBase58();
  const isV17 = !!market.configV17;
  const v17Stats = market.v17Stats;

  const decimals = unitScaleToDecimals(market.configV17?.unitScale ?? market.config?.unitScale);

  // v12 legacy path — the `engine` block only ever populates on v12 slabs
  // (kept so mock-mode / any lingering v12 market still renders sane values).
  const v12Oi = market.engine?.totalOpenInterest ?? null;
  const v12Insurance = market.engine?.insuranceFund?.balance ?? null;
  const v12LastCrank = market.engine?.lastCrankSlot ?? null;
  const v12CurrentSlot = market.engine?.currentSlot ?? null;

  // H11: v17 OI/insurance come straight from useCreatedMarkets' enrichment
  // (parseMarketGroupV17OI) — kept verbatim, not re-derived from the API.
  const oiAtoms = isV17 ? (v17Stats ? v17Stats.oi.totalLongOiQ + v17Stats.oi.totalShortOiQ : null) : v12Oi;
  const insuranceAtoms = isV17 ? (v17Stats?.oi.insuranceBalance ?? null) : v12Insurance;

  // "Liquidity backing this market" — the market's LP-side capital, NEVER
  // labeled as a spendable personal balance (audit finding: the LP portfolio
  // is owned by the creator's wallet, but it backs trades, it isn't theirs to
  // spend). See types.ts's deriveMarketLiquidityAtoms doc comment.
  const liquidityAtoms = deriveMarketLiquidityAtoms(market, detail);
  const storedLpCollateralAtoms = detail?.lp_collateral != null ? BigInt(Math.round(detail.lp_collateral)) : null;
  // Only surface the stored (creation-time) figure when it MATERIALLY
  // diverges from the live number — otherwise it's redundant noise.
  const lpCollateralDiverges = lpCollateralMateriallyDiverges(liquidityAtoms, storedLpCollateralAtoms);

  // Health — same computeMarketHealthFromStats /markets uses, fed with the
  // real numbers above (not fabricated) so health semantics match the public
  // markets list exactly.
  const health = computeMarketHealthFromStats({
    total_open_interest: oiAtoms != null ? Number(oiAtoms) : (detail?.total_open_interest ?? null),
    insurance_balance: insuranceAtoms != null ? Number(insuranceAtoms) : (detail?.insurance_balance ?? null),
    c_tot: null,
    vault_balance: liquidityAtoms != null ? Number(liquidityAtoms) : null,
    total_accounts: detail?.total_accounts ?? null,
  });

  // Secondary crank-freshness dot — the accrue-cliff signal (asset slot_last
  // vs current slot), DISTINCT from `health` above (which is a liquidity
  // ratio). A market can be liquidity-healthy and still crank-stale.
  const v17StalenessSlots =
    isV17 && v17Stats?.assetSlotLast != null && chainCurrentSlot != null
      ? Math.max(0, Number(chainCurrentSlot - v17Stats.assetSlotLast))
      : null;
  const crankFresh = isV17
    ? (v17StalenessSlots != null ? v17StalenessSlots < V17_STALE_THRESHOLD_SLOTS : null)
    : (v12LastCrank != null && v12CurrentSlot != null
        ? Number(v12CurrentSlot - v12LastCrank) < Number(market.engine?.maxCrankStalenessSlots ?? 100n)
        : null);

  const oracleMode = detectOracleMode({
    oracleAuthority: market.config?.oracleAuthority ?? PublicKey.default,
    indexFeedId: market.config?.indexFeedId ?? PublicKey.default,
    oracleModeByte: market.configV17?.oracleMode,
  });
  const oracleModeLabel = { keeper: "Keeper (auto)", hyperp: "DEX-cranked", "pyth-pinned": "Pyth-pinned", admin: "Manual" }[oracleMode];

  const oraclePriceE6 = isV17
    ? applyInvert(sanitizePriceE6(market.configV17?.markEwmaE6 ?? 0n), market.configV17?.invert)
    : (market.config?.authorityPriceE6 ?? 0n);
  const fallbackPriceUsd = priceE6ToUsd(oraclePriceE6);

  // OI is a QUANTITY of this market's own underlying asset (e.g. "5.2 SOL"),
  // not a collateral-scale dollar figure — mirrors app/markets/page.tsx's own
  // "25.0M BONK next to 24.38 SOL reads as garbage, USD is the sane default"
  // rationale. Best-effort live price snapshot (no subscription — OI itself
  // only refreshes every 30s via useCreatedMarkets' enrichment interval, so
  // tying this specific figure to a per-tick re-render isn't worth it);
  // falls back to the oracle price above when the feed hasn't ticked yet.
  const priceUsdForOi = getSnapshot(slab).priceUsd ?? fallbackPriceUsd;
  const oiUsd = oiAtoms != null && priceUsdForOi != null && priceUsdForOi > 0
    ? (Number(oiAtoms) / 10 ** decimals) * priceUsdForOi
    : null;

  const symbol = detail?.symbol ?? market.label;
  const name = detail?.name ?? undefined;

  const [showBurnConfirm, setShowBurnConfirm] = useState(false);
  const [burnConfirmText, setBurnConfirmText] = useState("");
  const [showTopUpInput, setShowTopUpInput] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  async function handleAction(name: string, fn: () => Promise<string>) {
    try {
      const sig = await fn();
      toast(`${name} successful! Tx: ${sig.slice(0, 16)}...`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : `${name} failed`, "error");
    }
  }

  const handleShare = useCallback(() => {
    const url = `${window.location.origin}/trade/${slab}`;
    navigator.clipboard.writeText(url).then(
      () => toast("Link copied", "success"),
      () => toast("Couldn't copy link", "error"),
    );
  }, [slab, toast]);

  const handleBurnAdmin = useCallback(async () => {
    try {
      await actions.renounceAdmin(market);
      // Audit finding: after a successful burn, this market's admin no longer
      // matches this wallet — it legitimately vanishes from Your Markets on
      // the next scan. Say so explicitly, in ONE toast, so that read isn't
      // mistaken for a bug (a generic "successful!" toast alone wouldn't
      // explain the disappearance).
      toast("Admin key burned — this market is now permissionless and will no longer appear in Your Markets", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Burn admin key failed", "error");
    }
  }, [actions, market, toast]);

  const handleClose = useCallback(async () => {
    setShowCloseConfirm(false);
    const result = await closeMarket.closeSlab(slab);
    if (result) {
      const sol = (result.reclaimedLamports / 1_000_000_000).toFixed(4);
      toast(`Market closed — reclaimed ${sol} SOL`, "success");
    }
    // On failure, closeMarket.error is rendered inline (verbatim) below.
  }, [closeMarket, slab, toast]);

  return (
    <div id={`market-${slab}`} className="border border-[var(--border)]/50 bg-[var(--panel-bg)] scroll-mt-24">
      {/* Collapsed row */}
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-elevated)]"
        aria-expanded={expanded}
      >
        <MarketLogo logoUrl={detail?.logo_url} mainnetCa={detail?.mainnet_ca} symbol={symbol} size="sm" decorative />
        <div className="min-w-[92px]">
          <p className="text-[13px] font-semibold text-[var(--text)]">{symbol}</p>
          <p className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{shortAddr(slab)}</p>
        </div>
        <div className="min-w-[70px]">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">price</p>
          <p className="text-[12px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            <LiveRowPrice slab={slab} fallback={fallbackPriceUsd} />
          </p>
        </div>
        <div className="min-w-[80px]">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">OI</p>
          <p className="text-[12px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {oiUsd != null ? formatStatValue(oiUsd, "currency") : "—"}
          </p>
        </div>
        <Tooltip text="Liquidity backing this market — the LP counterparty's capital, not a personal balance.">
          <div className="min-w-[90px]">
            <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">liquidity</p>
            <p className="text-[12px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
              {formatStatValue(liquidityAtoms, "currency", decimals)}
            </p>
            {lpCollateralDiverges && storedLpCollateralAtoms != null && (
              <p className="text-[9px] text-[var(--text-dim)]">
                seeded {formatStatValue(storedLpCollateralAtoms, "currency", decimals)}
              </p>
            )}
          </div>
        </Tooltip>
        <div className="min-w-[80px]">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">insurance</p>
          <p className="text-[12px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatStatValue(insuranceAtoms, "currency", decimals)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <HealthBadge level={health.level} />
          <Tooltip text={crankFresh == null ? "Crank freshness unknown" : crankFresh ? "Crank fresh — accrue is up to date" : "Crank stale — no accrue in a while (accrue cliff)"}>
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                crankFresh == null ? "bg-[var(--text-dim)]" : crankFresh ? "bg-[var(--long)]" : "bg-[var(--warning)] animate-pulse"
              }`}
            />
          </Tooltip>
        </div>
        <span className="hidden text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)] sm:inline">{oracleModeLabel}</span>
        <svg
          className={`ml-auto h-4 w-4 shrink-0 text-[var(--text-dim)] transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Inline expand-in-place drawer — no popover/drawer library in components/ui/. */}
      {expanded && (
        <div className="border-t border-[var(--border)]/30 px-4 py-4">
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">last crank</p>
              <p className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {isV17
                  ? (v17Stats?.assetSlotLast != null && chainCurrentSlot != null ? formatSlotAge(chainCurrentSlot, v17Stats.assetSlotLast) + " ago" : "—")
                  : (v12CurrentSlot != null && v12LastCrank != null ? formatSlotAge(v12CurrentSlot, v12LastCrank) + " ago" : "—")}
              </p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">oracle mode</p>
              <p className="text-[11px] text-[var(--text)]">{oracleModeLabel}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">name</p>
              <p className="text-[11px] text-[var(--text)]">{name ?? "—"}</p>
            </div>
            <div>
              <a href={explorerAccountUrl(slab)} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[var(--accent)] hover:brightness-125">
                view on explorer ↗
              </a>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)]/30 pt-3">
            <button onClick={() => setShowTopUpInput(true)} disabled={actions.loading === "topUpInsurance"} className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors disabled:opacity-40">
              top up insurance
            </button>
            <button onClick={handleShare} className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors">
              share
            </button>
            <Link href={`/trade/${slab}`} className="text-[10px] uppercase tracking-[0.1em] text-[var(--long)] hover:brightness-125 transition-all">
              trade →
            </Link>
            <span className="mx-1 h-3 w-px bg-[var(--border)]" />
            {/* Destructive actions — every on-chain precondition gate below is
                preserved from the flow this replaces (see PR description). */}
            <button
              onClick={() => setShowBurnConfirm(true)}
              disabled={actions.loading === "renounceAdmin"}
              className="text-[10px] uppercase tracking-[0.1em] text-[var(--short)]/70 hover:text-[var(--short)] transition-colors disabled:opacity-40"
            >
              burn admin key
            </button>
            <button
              onClick={() => setShowCloseConfirm(true)}
              disabled={closeMarket.loading}
              className="text-[10px] uppercase tracking-[0.1em] text-[var(--short)]/70 hover:text-[var(--short)] transition-colors disabled:opacity-40"
            >
              {closeMarket.loading ? "closing…" : "close market"}
            </button>
          </div>
          {closeMarket.error && (
            <p className="mt-2 text-[10px] text-[var(--short)]">{closeMarket.error}</p>
          )}

          <LogoUpload slabAddress={slab} mainnetCa={detail?.mainnet_ca} symbol={symbol} />
        </div>
      )}

      {/* Dialogs */}
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
          const amount = BigInt(Math.round(parsed * Math.pow(10, decimals)));
          handleAction("Top Up Insurance", () => actions.topUpInsurance(market, amount));
        }}
        onCancel={() => setShowTopUpInput(false)}
      />

      {/* Burn admin key — requires typing BURN to confirm. Ported VERBATIM
          from the flow this replaces; the gate text and disabled-until-exact-
          match behavior are unchanged. */}
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
                  handleBurnAdmin();
                }}
                className="border border-[var(--short)]/30 px-4 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--short)] transition-colors hover:bg-[var(--short)]/10 disabled:opacity-40"
              >
                burn it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close market (CloseSlab) — irreversible + rent-reclaiming. */}
      <ConfirmDialog
        open={showCloseConfirm}
        title="close market"
        description="This permanently closes the market and reclaims its rent. Requires an empty vault, empty insurance fund, and no open user accounts — closeSlab will tell you exactly which precondition failed if it can't proceed."
        confirmLabel="close & reclaim rent"
        danger
        onConfirm={handleClose}
        onCancel={() => setShowCloseConfirm(false)}
        errorText={closeMarket.error}
      />
    </div>
  );
};
