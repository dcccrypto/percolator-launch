"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio, liveMarginCushion, type LiquidationSeverity } from "@/hooks/usePortfolio";
import { LIQ_FORGET_HIDE_CUSHION } from "@/lib/liquidation-risk";
import { useLiveSlabPrices } from "@/hooks/useLiveSlabPrices";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { useOtherModalOpen } from "@/hooks/useOtherModalOpen";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";
import {
  collectLiquidationRisks,
  LiquidationRiskItem,
  riskKey,
  RiskCloseFlow,
  type LiquidationRisk,
} from "@/components/portfolio/LiquidationRiskItem";

/** Positions shown before "+N more"; the rest are one click away on /portfolio. */
const MAX_SHOWN = 3;
/** A hidden warning is forgotten only once the position's margin cushion is back above
 *  this, so a price hovering at the warning line doesn't re-alert on every crossing. */
const FORGET_HIDE_ABOVE_CUSHION = LIQ_FORGET_HIDE_CUSHION;

type Tier = Exclude<LiquidationSeverity, "safe">;
const rank: Record<Tier, number> = { warning: 1, danger: 2 };

/**
 * Which risks to show: a position hidden at one tier stays hidden while it stays at that
 * tier, and comes back when it gets worse (warning -> danger).
 */
export function visibleRisks(risks: LiquidationRisk[], dismissed: Record<string, Tier>): LiquidationRisk[] {
  return risks.filter((r) => {
    const d = dismissed[riskKey(r.pos)];
    return d === undefined || rank[r.severity] > rank[d];
  });
}

/**
 * Site-wide liquidation warning: a card pinned to a corner of every page (except /portfolio,
 * which shows the same rows inline) listing each open position that has used half or more
 * of its margin cushion at the live mark (lib/liquidation-risk.ts), with Go to market and
 * Close. It shares the app-wide deduped
 * portfolio scan with PositionsBar, so it adds no RPC load.
 *
 * Hide lasts for the session in memory: the alert lives in the root layout and is not
 * remounted by client navigation.
 */
export function LiquidationAlert() {
  const pathname = usePathname();
  const { connected: walletConnected } = useWalletCompat();
  const usingMockData = isMockMode() && !walletConnected;
  const portfolio = usePortfolio(walletConnected);
  const positions = useMemo(
    () => (usingMockData ? getMockPortfolioPositions() : portfolio.positions),
    [usingMockData, portfolio.positions],
  );
  const open = useMemo(() => positions.filter((p) => (p.account?.positionSize ?? 0n) !== 0n), [positions]);
  const livePrices = useLiveSlabPrices(open.map((p) => p.slabAddress));
  const mints = useMemo(() => open.map((p) => p.collateralMint), [open]);
  const tokenMeta = useMultiTokenMeta(mints);
  const risks = collectLiquidationRisks(
    open,
    livePrices,
    (p) => tokenMeta.get(p.collateralMint.toBase58())?.decimals ?? 6,
  );

  const [dismissed, setDismissed] = useState<Record<string, Tier>>({});
  const [closing, setClosing] = useState<LiquidationRisk | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  // The card would sit over the lower part of another dialog (including its own close modal); step aside.
  const otherModalOpen = useOtherModalOpen(cardRef);

  // Forget a Hide once its position is clearly out of range again (see FORGET_HIDE_ABOVE_CUSHION).
  const recoveredKeys = open
    .filter((p) => (liveMarginCushion(p, livePrices.get(p.slabAddress)) ?? 0) > FORGET_HIDE_ABOVE_CUSHION)
    .map(riskKey)
    .join(",");
  useEffect(() => {
    if (!recoveredKeys) return;
    const recovered = new Set(recoveredKeys.split(","));
    setDismissed((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([k]) => !recovered.has(k)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [recoveredKeys]);

  // Owned here, outside the list, so a tick that moves the position out of range can't
  // unmount it mid-close.
  const closeFlow = closing && (
    <RiskCloseFlow
      risk={closing}
      onDone={(closed) => {
        setClosing(null);
        if (closed) portfolio.refresh();
      }}
    />
  );

  const hiddenHere = pathname === "/portfolio" || (pathname?.startsWith("/portfolio/") ?? false);
  const shown = visibleRisks(risks, dismissed);
  const showCard = (walletConnected || usingMockData) && !hiddenHere && shown.length > 0 && !otherModalOpen;

  const danger = shown.some((r) => r.severity === "danger");
  const onTrade = pathname?.startsWith("/trade/") ?? false;
  const count = shown.length === 1 ? "1 position" : `${shown.length} positions`;

  // The close flow keeps the same place in the tree whether or not the card renders: a
  // remount would reset useClosePosition's in-flight guard mid-close.
  return (
    <>
      {showCard && (
        <aside
          ref={cardRef}
          aria-label="Positions near liquidation"
          className={`fixed z-[85] left-3 right-3 bottom-[calc(124px+env(safe-area-inset-bottom))] md:left-auto md:right-5 md:bottom-20 md:w-[360px] ${
            onTrade ? "lg:right-auto lg:left-5" : ""
          }`}
        >
          {/* Announces the count and tier when they change, not every price tick. */}
          <span className="sr-only" role={danger ? "alert" : "status"}>
            {count} {danger ? "at liquidation risk" : "approaching liquidation"}
          </span>
          <div className="border border-[var(--border)] bg-[var(--bg)]/95 p-2 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur">
            <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
              <div className="flex items-baseline gap-2">
                <span
                  className="inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full"
                  style={{ background: danger ? "var(--short)" : "var(--warning)" }}
                  aria-hidden
                />
                <span className="text-[12px] font-medium text-[var(--text)]">
                  {danger ? "Liquidation risk" : "Approaching liquidation"}
                </span>
              </div>
              <span className="text-[10px] text-[var(--text-secondary)]">
                {count}
              </span>
            </div>
            <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
              {shown.slice(0, MAX_SHOWN).map((risk, i) => (
                // Phones show only the closest one; the card must not cover the page.
                <div key={riskKey(risk.pos)} className={i > 0 ? "hidden md:block" : undefined}>
                  <LiquidationRiskItem
                    risk={risk}
                    onClose={() => setClosing(risk)}
                    onDismiss={() =>
                      setDismissed((prev) => ({ ...prev, [riskKey(risk.pos)]: risk.severity }))
                    }
                  />
                </div>
              ))}
            </div>
            {shown.length > 1 && (
              <Link
                href="/portfolio"
                className={`mt-2 px-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)] ${
                  shown.length > MAX_SHOWN ? "block" : "block md:hidden"
                }`}
              >
                <span className="md:hidden">+{shown.length - 1} more on Portfolio</span>
                <span className="hidden md:inline">+{shown.length - MAX_SHOWN} more on Portfolio</span>
              </Link>
            )}
          </div>
        </aside>
      )}
      {closeFlow}
    </>
  );
}
