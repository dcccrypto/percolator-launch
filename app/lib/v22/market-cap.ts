/**
 * The market's own `max_portfolio_assets` (u16 at the start of the engine config, 624 on v2.1 and v2.2): how many assets one
 * account can hold on this market, and the single thing that makes a market "multi-asset". Read from the account bytes, never
 * from a list of market addresses. Kept free of SDK imports so it is safe to pull into the error-copy paths.
 */
import { isUnsupportedLayout, layoutOf } from "@/lib/v22/layout";

/** Null when the bytes are not a market of a known layout, or are too short (then nothing is claimed). */
export function readMaxPortfolioAssets(data: Uint8Array | null | undefined): number | null {
  if (!data) return null;
  try {
    const L = layoutOf(data, "readMaxPortfolioAssets");
    const off = L.marketGroupOff + L.group.config;
    if (data.length < off + 2) return null;
    const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(off, true);
    return n > 0 ? n : null;
  } catch (e) {
    if (isUnsupportedLayout(e)) return null;
    throw e;
  }
}

/** A market that lets an account hold more than one asset. The app ticket trades its asset 0 only (Q-7d); the other assets are SDK-only. */
export function isMultiAssetMarket(data: Uint8Array | null | undefined): boolean {
  const n = readMaxPortfolioAssets(data);
  return n !== null && n > 1;
}
