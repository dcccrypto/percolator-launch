/**
 * N2: a market with lots (lot_exp > 0) may be traded in the app only when EVERY surface that touches its prices or sizes
 * is lot-aware. The wizard refuses to create lot markets (LOT_MARKETS_ENABLED), but the program accepts one from any
 * other tool, so the app must also refuse to trade one it cannot show correctly.
 *
 * `LOT_SURFACES` is the registry: a surface is `covered: true` ONLY when its conversion goes through lib/v22/lot.ts AND a
 * test fails when that conversion is dropped (`test` is that file, `evidence` a string that must appear in it, both
 * checked by __tests__/lib/v22/lot-coverage.test.ts). The guard is the AND of the registry: an unregistered or uncovered
 * surface keeps trading of lot markets refused. Surfaces whose correctness depends on another repo (keeper mark scaling,
 * indexer rows) stay `covered: false` until someone attests them against a live lot market.
 */
import { isDevnetV22Enabled } from "./flag";
import { V22_COPY } from "./copy";

export interface LotSurface {
  covered: boolean;
  /** Test file (relative to app/) that fails when the conversion is dropped. Required when covered. */
  test?: string;
  /** A string that must appear in `test`. */
  evidence?: string;
  note?: string;
}

const T_TRADE = "__tests__/lib/v22/lot-surfaces-trade.test.tsx";
const T_VIEWS = "__tests__/lib/v22/lot-surfaces-views.test.ts";
const T_N1 = "__tests__/lib/v22/lot-n1.test.ts";
const T_SURF = "__tests__/lib/v22/lot-surfaces-remaining.test.tsx";

export const LOT_SURFACES: Readonly<Record<string, LotSurface>> = Object.freeze({
  "price-store": { covered: true, test: T_N1, evidence: "per-token feeds of a slab with an unknown exponent are NOT ingested" },
  "order-ticket": { covered: true, test: T_TRADE, evidence: "OrderTicket" },
  "close-flow": { covered: true, test: T_TRADE, evidence: "ClosePositionForm" },
  "positions-dock": { covered: true, test: T_TRADE, evidence: "PositionsDock" },
  "market-info-bar": { covered: true, test: T_TRADE, evidence: "MarketInfoBar" },
  "portfolio-rows": { covered: true, test: T_VIEWS, evidence: "PortfolioPositionsView" },
  "other-market-positions": { covered: true, test: T_VIEWS, evidence: "OtherMarketPositions" },
  "positions-bar": { covered: true, test: T_N1, evidence: "the exponent learned from a market read applies to every later subscriber" },
  "liquidation-alert": { covered: true, test: T_N1, evidence: "withheld from readers until known" },
  "at-risk-banner": { covered: true, test: T_N1, evidence: "withheld from readers until known" },
  "pnl-share-card": { covered: true, test: T_VIEWS, evidence: "surface: PnL share card" },
  "chart-pnl-badge": { covered: true, test: T_SURF, evidence: "ChartPnlBadge" },
  "funding-rate-card": { covered: true, test: T_SURF, evidence: "FundingRateCard" },
  "market-stats-card": { covered: true, test: T_SURF, evidence: "MarketStatsCard" },
  "market-browser": { covered: true, test: T_SURF, evidence: "LotOpenInterest" },
  "markets-page-price": { covered: true, test: T_SURF, evidence: "resolveDiscoveredPriceE6" },
  "tv-chart": { covered: true, test: T_VIEWS, evidence: "candlesApiProvider" },
  "legacy-chart": { covered: true, test: T_VIEWS, evidence: "TradingChart" },
  "trade-history": { covered: true, test: T_VIEWS, evidence: "TradeHistory" },
  "api-markets": { covered: true, test: T_VIEWS, evidence: "lotMarketNumbers" },
  "trade-stats-panel": { covered: false, note: "volume units of the indexer rows (per lot or per token) are not verified" },
  "keeper-mark-scaling": { covered: false, note: "the keeper must push mark = round(P * 10^lot_exp ...); other repo, verify on a live lot market" },
  "indexer-candles-trades": { covered: false, note: "indexer storage of per-lot marks and sizes; other repo, verify on a live lot market" },
});

/** The surfaces that still keep lot markets refused. */
export function uncoveredLotSurfaces(reg: Readonly<Record<string, LotSurface>> = LOT_SURFACES): string[] {
  return Object.entries(reg).filter(([, v]) => !v.covered).map(([k]) => k);
}

/** True when every registered surface is lot-aware (and there is at least one). */
export function allLotSurfacesCovered(reg: Readonly<Record<string, LotSurface>> = LOT_SURFACES): boolean {
  return Object.keys(reg).length > 0 && uncoveredLotSurfaces(reg).length === 0;
}

/** Pure: is trading refused for a market with this exponent (null = unknown)? */
export function lotTradingRefusal(lotExp: number | null, flagOn: boolean = isDevnetV22Enabled(), reg: Readonly<Record<string, LotSurface>> = LOT_SURFACES): string | null {
  if (!flagOn) return null;
  if (lotExp === null) return V22_COPY.lot.unitsUnknown; // exponent not known yet: nothing may be derived from a price
  if (lotExp > 0 && !allLotSurfacesCovered(reg)) return V22_COPY.lot.tradingUnavailable;
  return null;
}
