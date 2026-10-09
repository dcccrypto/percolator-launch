"use client";

import { FC, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import type { CreatorMarketDetail } from "./types";
import { Q_SCALE } from "@/lib/q-usd";
import { unitScaleToDecimals, deriveMarketLiquidityAtoms, lpCollateralMateriallyDiverges } from "./types";
import { useAdminActions } from "@/hooks/useAdminActions";
import { useCloseMarket } from "@/hooks/useCloseMarket";
import { CLOSE_MARKET_COPY, closeMarketChecklist, firstUnmet, type CloseCheck } from "@/lib/close-market-checklist";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { CreatorClaimPanel } from "@/components/market/CreatorClaimPanel";
import { useToast } from "@/hooks/useToast";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/config";
import { ZERO_PUBKEY } from "@/lib/update-asset-authority-keys";
import { computeMarketHealthFromStats } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { MarketLogo } from "@/components/market/MarketLogo";
import { resolveIdentity, sawPlaceholderTicker, type ResolvedIdentity } from "@/lib/bulk-identity";
import { isMarketauthComplete } from "@/lib/market-completeness";
import { classifyLaunchStage, launchRowTitle, savedLaunchIdentity, LAUNCH_UNFINISHED_TITLE } from "@/lib/unfinished-launch";
import { UnfinishedLaunchPanel } from "./UnfinishedLaunchPanel";
import { classifyClaimable } from "@/lib/creator-fee-summary";
import { useClaimCreatorFees } from "@/hooks/useClaimCreatorFees";
import { LogoUpload } from "@/components/create/LogoUpload";
import { Tooltip } from "@/components/ui/Tooltip";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { formatUsdFromNumber, formatStatValue, formatSlotAge } from "@/lib/format";
import { detectOracleMode, sanitizePriceE6, applyInvert, priceE6ToUsd } from "@/lib/oraclePrice";
import { CreatorTranchePanel } from "@/components/limits/CreatorLimits";

/** Same accrue-cliff threshold as useCreatedMarkets/CrankHealthCard — the
 *  asset's accrue slot (advances only via crank/trade) vs the current
 *  on-chain slot. Distinct signal from HealthBadge's liquidity ratio. */
const V17_STALE_THRESHOLD_SLOTS = 500;

/** localStorage, or null where it is blocked or absent (private mode, SSR). */
function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

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

/** UX WP-9 (§3.11): "Fees claimed ✓ · No open accounts ✓ · Insurance empty ✓" + the first unmet line. */
export const CloseMarketChecklistView: FC<{ checks: readonly CloseCheck[] }> = ({ checks }) => {
  const blocker = firstUnmet(checks);
  return (
    <div data-testid="close-market-checklist" className="mt-1 text-[10px] text-[var(--text-secondary)]">
      <p>
        {checks.map((c, i) => (
          <span key={c.key} data-testid={`close-check-${c.key}`} data-state={c.state}>
            {i > 0 ? " · " : ""}
            {c.label} {CLOSE_MARKET_COPY.mark(c.state)}
          </span>
        ))}
      </p>
      {blocker && (
        <p data-testid="close-market-blocker" className="mt-0.5 text-[var(--text)]">
          {blocker.unmetLine}
        </p>
      )}
    </div>
  );
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
  /** Ticker/name/logo resolved on a much faster clock than `detail` — the
   *  session identity cache synchronously, then one bulk directory call. Null
   *  when neither knows this market yet. See hooks/useMarketIdentities.ts. */
  identity: ResolvedIdentity | null;
  /** Current on-chain slot from useCreatedMarkets' v17 enrichment fetch. */
  chainCurrentSlot: bigint | null;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Re-read balances after a successful claim, so the badge does not linger
   *  showing an amount the creator has already banked. */
  onClaimed?: () => void;
}

/**
 * Reports asset 0's insurance_authority from the drawer's SlabProvider. TopUpInsurance is gated on
 * it, and the create flow's BindInsuranceAuthority rebinds it to the stake pool's vault_auth PDA, so
 * on a completed market no wallet can top up from here.
 */
export const InsuranceAuthorityReader: FC<{ onRead: (b58: string | null) => void }> = ({ onRead }) => {
  const { assetProfile } = useSlabState();
  const b58 = assetProfile?.insuranceAuthority?.toBase58() ?? null;
  useEffect(() => onRead(b58), [b58, onRead]);
  return null;
};

export const CreatorMarketRow: FC<CreatorMarketRowProps> = ({ market, detail, identity, chainCurrentSlot, expanded, onToggleExpand, onClaimed }) => {
  const { toast } = useToast();
  const actions = useAdminActions();
  const closeMarket = useCloseMarket();

  const slab = market.slabAddress.toBase58();
  const isV17 = !!market.configV17;
  const v17Stats = market.v17Stats;

  // Creator-fee claim (tag 90). The connected wallet can claim only when it IS
  // this market's fee authority (asset 0's asset_admin).
  //
  // This is now the CLAIM AFFORDANCE, not a hint to go looking for one. It used
  // to be a non-interactive badge saying "expand this market to claim", which
  // meant a creator with eight markets opened eight drawers (#2573).
  //
  // The balance goes through the shared classifier: an ABSENT counter is
  // `unknown`, never 0. Reading it as 0 told every creator they had earned
  // nothing, because the API did not return the field at all (#2571).
  const wallet = useWalletCompat();
  const claimState = classifyClaimable(detail?.creator_fee_claimable_atoms);
  const isClaimAuthority =
    !!wallet.publicKey && !!detail?.creator_fee_authority &&
    detail.creator_fee_authority === wallet.publicKey.toBase58();
  const hasClaimableFees = isClaimAuthority && claimState.kind === "claimable";

  // Authority gating for the destructive actions. The two "admin" keys diverge
  // once a market completes creation:
  //  • "Burn admin key" renounces asset 0's `asset_admin` — the creator's key
  //    (== creator_fee_authority). The creator holds it, so this CAN be done.
  //  • "Close market" (CloseSlab) needs `marketauth`, which StakeInitPool rotates
  //    to the keyless stake-pool PDA at creation — no wallet holds it, so a
  //    completed market can never be closed (it's autonomous by design).
  // Gate each button on the authority it actually needs, instead of letting the
  // user click into a doomed transaction.
  const walletB58AdminGate = wallet.publicKey?.toBase58() ?? null;
  const isAssetAdmin =
    !!walletB58AdminGate && !!detail?.creator_fee_authority &&
    detail.creator_fee_authority === walletB58AdminGate;
  // The burn writes the zero key into asset_admin (useAdminActions.renounceAdmin), which the detail
  // route serves as creator_fee_authority. Burned is then a fact about the market, not a wallet
  // mismatch, so the drawer must not ask the creator to "connect the creator wallet".
  // `burnedHere` covers the time until the detail refetch shows the zero key: without it the
  // button stayed "burn admin key" after a burn and offered the same burn again.
  const [burnedHere, setBurnedHere] = useState(false);
  const adminBurned = burnedHere || detail?.creator_fee_authority === ZERO_PUBKEY.toBase58();
  const marketAuthB58 = market.configV17?.marketauth?.toBase58() ?? null;
  const isMarketAuth = !!walletB58AdminGate && !!marketAuthB58 && marketAuthB58 === walletB58AdminGate;
  const rowClaim = useClaimCreatorFees();
  const claimThisMarket = useCallback(
    (e: { preventDefault: () => void; stopPropagation: () => void }) => {
      e.preventDefault();
      // The badge sits inside the row's expand control; without this a claim
      // click would also toggle the drawer.
      e.stopPropagation();
      void rowClaim.claim([slab]).then((results) => {
        // A pending claim (#2742) may already have landed: re-read the balance for it too.
        if (results.some((r) => r.signature || r.pendingSignature)) onClaimed?.();
      });
    },
    [rowClaim, slab, onClaimed],
  );

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

  // Secondary crank-freshness dot — the accrue-cliff signal (asset slot_last
  // vs current slot), DISTINCT from `health` (which is a liquidity
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
    // v17 OI is engine Q (1e6), not the collateral mint's decimals
    ? (Number(oiAtoms) / (isV17 ? Q_SCALE : 10 ** decimals)) * priceUsdForOi
    : null;

  // Health — same computeMarketHealthFromStats /markets uses, fed with the
  // real numbers above (not fabricated) so health semantics match the public
  // markets list exactly.
  const health = computeMarketHealthFromStats({
    total_open_interest: oiAtoms != null ? Number(oiAtoms) : (detail?.total_open_interest ?? null),
    total_open_interest_usd: oiUsd,
    insurance_balance: insuranceAtoms != null ? Number(insuranceAtoms) : (detail?.insurance_balance ?? null),
    c_tot: null,
    vault_balance: liquidityAtoms != null ? Number(liquidityAtoms) : null,
    total_accounts: detail?.total_accounts ?? null,
  });

  // Field-level merge, detail first. Merging per SOURCE instead would let the
  // slow per-market detail blank a ticker the fast path already resolved: the
  // API's on-chain fallback returns `symbol: null` and carries no `logo_url`
  // key at all for any market absent from PLAYGROUND_SLAB_META and the
  // registration blob, so the row painted its real ticker and then DEGRADED to
  // `market.label` a second later. Per field, identity only ever sharpens.
  //
  // The indexer's "UNKNOWN" placeholder is no ticker (resolveIdentity drops it), and what the
  // launching browser saved about the token (symbol/name) is the last, lowest-precedence source
  // (#3266).
  const savedIdentity = useMemo(() => savedLaunchIdentity(slab, safeLocalStorage()), [slab]);
  const resolved = resolveIdentity(detail, identity, savedIdentity);
  // An unfinished launch is a chain fact: marketauth is still the creator's wallet until the final
  // step rotates it to the stake-pool PDA (lib/market-completeness.ts).
  const unfinished = isV17 && !!market.configV17?.marketauth && !isMarketauthComplete(market.configV17.marketauth, market.slabAddress);
  const launchStage = unfinished ? classifyLaunchStage(v17Stats?.launch, insuranceAtoms ?? null) : null;
  // A committed launch can only be finished: no close button, no dead-end checklist.
  const removalImpossible = launchStage?.kind === "committed";
  const symbol = launchRowTitle({
    symbol: resolved.symbol,
    unfinished,
    sawPlaceholder: sawPlaceholderTicker(detail, identity),
    fallbackLabel: market.label,
  });
  const closeChecks = closeMarketChecklist({
    claimableFeeAtoms: claimState.kind === "claimable" ? claimState.atoms : claimState.kind === "none" ? 0n : null,
    // The wallet's own accounts are closed inside the close itself; others are not decodable here.
    otherOpenAccounts: null,
    insuranceAtoms: insuranceAtoms ?? null,
    unfinished,
  });
  const closeBlocker = firstUnmet(closeChecks);
  const name = resolved.name ?? undefined;

  const [showBurnConfirm, setShowBurnConfirm] = useState(false);
  const [burnConfirmText, setBurnConfirmText] = useState("");
  const [showTopUpInput, setShowTopUpInput] = useState(false);
  // Unknown (null) until the drawer's SlabProvider reads it: the action stays disabled until the
  // authority is known, because TopUpInsurance is callable only by that authority.
  const [insuranceAuthority, setInsuranceAuthority] = useState<string | null>(null);
  const insuranceAuthorityKnown = insuranceAuthority !== null;
  const canTopUpInsurance = insuranceAuthorityKnown && insuranceAuthority === (wallet.publicKey?.toBase58() ?? "");
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
      setBurnedHere(true);
      // The market stays in Your Markets: useCreatedMarkets lists every market whose LP
      // portfolio this wallet owns (owner @116), and burning asset_admin doesn't change that.
      toast("Admin key burned. The market stays in Your Markets because your wallet still owns its liquidity position.", "success");
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
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-elevated)] sm:flex-nowrap"
        aria-expanded={expanded}
      >
        <MarketLogo logoUrl={resolved.logo_url ?? undefined} mainnetCa={resolved.mainnet_ca} symbol={symbol} size="sm" decorative />
        <div className="min-w-[92px]">
          <p className="text-[13px] font-semibold text-[var(--text)]">{symbol}</p>
          {unfinished && symbol !== LAUNCH_UNFINISHED_TITLE && (
            <p data-testid="unfinished-pill" className="text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--warning)]">launch unfinished</p>
          )}
          <p className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{shortAddr(slab)}</p>
          {hasClaimableFees && claimState.kind === "claimable" && (
            // Not inside the row's expand <button>: nesting a button in a button
            // is invalid, and a click here must claim rather than toggle.
            <span
              role="button"
              tabIndex={0}
              aria-label={`Claim creator fees on ${symbol}`}
              onClick={claimThisMarket}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") claimThisMarket(e); }}
              className="mt-1 inline-flex cursor-pointer items-center gap-1 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
            >
              {/* decimals, NOT a hardcoded 1e6 — this read 1_000_000 regardless
                  of the market's own collateral scale, so a 9-decimal collateral
                  displayed 1000x its real claimable. */}
              ◈ {rowClaim.busy
                ? "claiming…"
                : `${formatStatValue(claimState.atoms, "currency", decimals)} claim`}
            </span>
          )}
          {rowClaim.outcomes[0]?.error && (
            <span className="mt-1 block text-[9px] text-[var(--short)]">{rowClaim.outcomes[0].error}</span>
          )}
          {rowClaim.outcomes[0]?.pendingSignature && <ClaimPendingNote signature={rowClaim.outcomes[0].pendingSignature} />}
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
        <Tooltip text="Liquidity backing this market: the market's own capital, not a personal balance.">
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
          <Tooltip text={crankFresh == null ? "Update status unknown" : crankFresh ? "Up to date" : "Catching up: no update in a while"}>
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
              <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">last update</p>
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

          {/* Creator fee claim (tag 90). Mounted lazily — only when this row's
              drawer is open, and only one drawer is open at a time — so the
              per-slab SlabProvider fetch/subscribe is paid on demand, not for
              every market. CreatorClaimPanel self-hides unless the connected
              wallet is asset 0's asset_admin (the claim authority), and shows a
              disabled "nothing to claim" state at 0. This is the one-click claim
              home so creators never need the hidden /analytics/[slab] URL. */}
          <div className="mb-4 border-t border-[var(--border)]/30 pt-4">
            <SlabProvider slabAddress={slab}>
              {/* Limits (P1 caps / P3 tranche; flag-gated, null when off) */}
              <CreatorTranchePanel slab={slab} decimals={decimals} collateralSymbol="USDC" />
              <CreatorClaimPanel slabAddress={slab} />
              <InsuranceAuthorityReader onRead={setInsuranceAuthority} />
            </SlabProvider>
          </div>

          {launchStage && (
            <UnfinishedLaunchPanel
              stage={launchStage}
              continueHref={`/create?resume=${slab}`}
              onReclaim={() => setShowCloseConfirm(true)}
              reclaiming={closeMarket.loading}
              reclaimBlockedReason={!isMarketAuth ? "Connect the wallet that launched this market to reclaim its rent." : closeBlocker?.unmetLine ?? null}
              error={closeMarket.error}
            />
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)]/30 pt-3">
            <button
              onClick={() => setShowTopUpInput(true)}
              disabled={actions.loading === "topUpInsurance" || !canTopUpInsurance}
              title={canTopUpInsurance ? undefined : insuranceAuthorityKnown ? "This market's insurance is managed by its stake pool. Add to it from Stake." : "Checking who can top up this market's insurance…"}
              className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors disabled:opacity-40">
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
              disabled={actions.loading === "renounceAdmin" || !isAssetAdmin || adminBurned}
              title={
                adminBurned
                  ? "The admin key is already burned."
                  : isAssetAdmin
                    ? undefined
                    : "Only the market admin (asset_admin) can burn the admin key — connect the creator wallet."
              }
              className="text-[10px] uppercase tracking-[0.1em] text-[var(--short)]/70 hover:text-[var(--short)] transition-colors disabled:opacity-40"
            >
              {adminBurned ? "admin key burned" : "burn admin key"}
            </button>
            {/* An unfinished launch that already holds a portfolio or funds can never be closed
                (CloseSlab refuses it), so it gets no close button; the panel above says why and
                offers Continue (#3266). */}
            {!removalImpossible && (
              <button
                data-testid="close-market-button"
                onClick={() => setShowCloseConfirm(true)}
                disabled={closeMarket.loading || closeBlocker !== null || !isMarketAuth}
                title={isMarketAuth ? undefined : "This market is autonomous — admin was renounced to the stake-pool program at creation, so it can't be closed."}
                className="text-[10px] uppercase tracking-[0.1em] text-[var(--short)]/70 hover:text-[var(--short)] transition-colors disabled:opacity-40"
              >
                {closeMarket.loading ? "closing…" : unfinished ? "reclaim rent" : "close market"}
              </button>
            )}
          </div>
          {/* UX WP-9 (§3.11): the preconditions BEFORE the button, never "closeSlab will tell you".
              Only for a wallet that can close it: without marketauth (every finished market) the note
              below says it can't be closed, and a checklist would list steps that lead nowhere (#43). */}
          {!removalImpossible && isMarketAuth && <CloseMarketChecklistView checks={closeChecks} />}
          {!isMarketAuth && (
            <p className="mt-2 text-[10px] text-[var(--text-secondary)]">
              This market is autonomous — admin control was permanently renounced to the stake-pool
              program at creation, so it can’t be closed.{isAssetAdmin && !adminBurned && " You can still burn your remaining admin key."}
            </p>
          )}
          {closeMarket.error && (
            <p className="mt-2 text-[10px] text-[var(--short)]">{closeMarket.error}</p>
          )}

          <LogoUpload slabAddress={slab} mainnetCa={resolved.mainnet_ca} symbol={symbol} />
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
        <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto overscroll-contain bg-black/60 py-4">
          <div className="mx-4 my-auto max-w-md w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)] p-8">
            <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--text)]">burn admin key</h3>
            <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
              This is permanent and irreversible. You will never be able to update config, set oracle, or perform any admin actions on this market again.
            </p>
            {/* Tag 90 (WithdrawCreatorFee) is gated on asset 0's asset_admin only: once burned, no
                creator fee on this market can ever be claimed again, and any unclaimed pot is
                re-booked to the protocol at close (wrapper bd4fe5f8). */}
            <p data-testid="burn-forfeits-fees" className="mt-2 text-[11px] text-[var(--text-secondary)]">
              You also give up this market&apos;s creator fees for good: fees can only be claimed with this key.
            </p>
            {hasClaimableFees && (
              <p data-testid="burn-claim-first" className="mt-2 text-[11px] font-semibold text-[var(--warning)]">
                You have unclaimed fees on this market. Claim them before burning, or they are lost.
              </p>
            )}
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
        title={unfinished ? CLOSE_MARKET_COPY.unfinishedTitle : CLOSE_MARKET_COPY.title(symbol)}
        description={unfinished ? (launchStage?.kind === "removable" ? CLOSE_MARKET_COPY.unfinishedBodyConfirmedEmpty : CLOSE_MARKET_COPY.unfinishedBody) : CLOSE_MARKET_COPY.body(symbol, null)}
        confirmLabel={unfinished ? CLOSE_MARKET_COPY.unfinishedConfirm : CLOSE_MARKET_COPY.confirm}
        danger
        onConfirm={handleClose}
        onCancel={() => setShowCloseConfirm(false)}
        errorText={closeMarket.error}
      />
    </div>
  );
};

/**
 * #2742: a row claim that was sent but did not confirm before the poll deadline. It may still
 * land, so it is neither "claimed" nor an error, and the signature stays in front of the creator.
 * A span with role="link", not an <a>: it renders inside the row's expand <button> (no
 * interactive nesting), and a click must open the explorer without toggling the drawer.
 */
export function ClaimPendingNote({ signature }: { signature: string }) {
  const open = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(explorerTxUrl(signature), "_blank", "noopener,noreferrer");
  };
  return (
    <span data-testid="creator-row-claim-pending" className="mt-1 block text-[9px] text-[var(--text-secondary)]">
      Claim sent, not confirmed yet.{" "}
      <span
        role="link"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") open(e); }}
        className="cursor-pointer text-[var(--accent)] hover:brightness-125"
      >
        check on explorer ↗
      </span>
    </span>
  );
}
