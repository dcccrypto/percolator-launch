/**
 * Custom price formatter for the TradingView chart: the axis, the legend and every line label show the
 * decimals the symbol's `pricescale` carries (10^decimals, from lib/chart/precision.ts), never fewer.
 * TradingView's default formatter rounds by `minmov`/`pricescale` too, but is free to drop trailing
 * digits on narrow axes; for e6-grid memecoin marks those digits are the signal.
 */
import type { TvSymbolInfo } from "./types";

export interface TvValueFormatter {
  format(price: number, signPositive?: boolean): string;
}

export function decimalsFromPriceScale(pricescale: number): number {
  if (!Number.isFinite(pricescale) || pricescale <= 1) return 2;
  return Math.min(12, Math.max(0, Math.round(Math.log10(pricescale))));
}

export function priceFormatterFactory(symbolInfo: Pick<TvSymbolInfo, "pricescale">): TvValueFormatter {
  const decimals = decimalsFromPriceScale(symbolInfo.pricescale);
  return {
    format(price, signPositive) {
      if (!Number.isFinite(price)) return "";
      const text = Math.abs(price).toFixed(decimals);
      if (price < 0 && Number(text) !== 0) return `-${text}`;
      return signPositive && price > 0 ? `+${text}` : text;
    },
  };
}
