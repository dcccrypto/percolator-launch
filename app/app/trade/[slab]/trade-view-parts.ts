// The trade UI that only renders once the market has loaded (the server HTML and the first client
// frame are the loading skeleton). page.tsx imports this module on mount, in parallel with the
// slab fetch, so it stays out of the route's first-load JS.
export { OrderTicket } from "@/components/trade/OrderTicket";
export { PositionsDock } from "@/components/trade/PositionsDock";
export { MarketInfoBar } from "@/components/trade/MarketInfoBar";
export { MarketLimitsStrip } from "@/components/limits/MarketLimitsStrip";
export { MarketHeaderStatus, TradeMarketHealthBanner } from "@/components/market/MarketHealthBadges";
export { MobileTradeBand } from "@/components/trade/MobileTradeBand";
export { MultiAssetNotice } from "@/components/trade/MultiAssetNotice";

/** Renders nothing. page.tsx mounts it through next/dynamic (ssr) so the server HTML preloads this chunk. */
export function TradeViewPartsPreload(): null {
  return null;
}
