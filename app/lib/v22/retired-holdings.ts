/**
 * Funds a settled (or blocklisted) market still holds for the connected wallet: the pure half of hooks/useRetiredHoldings.ts.
 *
 * The first version scanned v17 portfolios (magic + owner @116) and kept only blocklisted markets, so a v2.2 market that RESOLVED
 * (settled, price stopped, wound down) never showed up for the people with money in it. It is now driven by the market's engine mode:
 * a portfolio counts when its market is Resolved (mode 1) or blocklisted, and it still holds value. Hiding a market from discovery
 * never hides a holder's own funds from them (percolator ops plan section 4).
 *
 * Layout: portfolios are decoded by the account's wrapper VERSION (lib/v22/layout.ts, lib/limits/decode.ts), the owner is the mutable
 * owner at account offset 116 and the market group at 16, both unchanged between v2.1 and v2.2 (lib/limits/constants.ts PF_OWNER).
 */
import { PublicKey } from "@solana/web3.js";
import { decodeResolvedMarket, decodeResolvedPortfolio, type ResolvedMarketView } from "@/lib/limits/decode";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { parsePortfolio } from "./layout";

export const PORTFOLIO_MARKET_OFF = 16;
export const PORTFOLIO_OWNER_OFF = 116;

/** Bytes of a market to read for its mode: the end of the group header of the longest known layout (592 + 806). */
export const MARKET_MODE_SLICE_LEN = 1400;

export interface RetiredHolding {
  /** The market's slab address. */
  slabAddress: string;
  /** Deposited collateral still in the portfolio (native units). */
  capital: bigint;
  /** Net open position size in base q units (0n = flat). */
  positionSizeQ: bigint;
  /** Why it is listed: the market is Resolved (settled), or it is on the retirement blocklist. */
  reason: "settled" | "blocklisted";
  /** The market is Resolved: positions can be settled from its page. */
  settled: boolean;
  /** Slot of the owner-only window end (`resolved_slot + force_close_delay_slots`), null when not settled or no window. */
  ownerOnlyEndsAtSlot: bigint | null;
}

/** The market group a portfolio belongs to (bytes 16..48). */
export function portfolioMarket(data: Uint8Array): string | null {
  if (data.length < PORTFOLIO_MARKET_OFF + 32) return null;
  return new PublicKey(data.subarray(PORTFOLIO_MARKET_OFF, PORTFOLIO_MARKET_OFF + 32)).toBase58();
}

/** The mutable owner of a portfolio (bytes 116..148). */
export function portfolioOwner(data: Uint8Array): string | null {
  if (data.length < PORTFOLIO_OWNER_OFF + 32) return null;
  return new PublicKey(data.subarray(PORTFOLIO_OWNER_OFF, PORTFOLIO_OWNER_OFF + 32)).toBase58();
}

/**
 * One portfolio against its market. Null when it is not a holding to show: the wallet's market-LP portfolio (that is the market's
 * liquidity, owned by the Earn flow), a market that is neither Resolved nor blocklisted, an unreadable portfolio, or nothing left in it.
 * `market` null = the market could not be read: only the blocklist can list it then.
 */
export function classifyRetiredHolding(args: { portfolio: Uint8Array; slabAddress: string; market: ResolvedMarketView | null; blocked: boolean }): RetiredHolding | null {
  const { portfolio, slabAddress, market, blocked } = args;
  const settled = market !== null && market.mode === 1;
  if (!settled && !blocked) return null;
  if (isLpPortfolio(portfolio)) return null;
  let capital: bigint;
  let positionSizeQ: bigint;
  try {
    const pf = parsePortfolio(new Uint8Array(portfolio));
    const leg = pf.legs.find((l) => l.active);
    capital = pf.capital;
    positionSizeQ = leg ? BigInt(leg.basisPosQ) : 0n;
  } catch {
    return null; // unparseable portfolio: skip rather than crash the section
  }
  // A winner's payout can still be owed through an open receipt or a pnl balance even when capital reads 0.
  const rp = decodeResolvedPortfolio(portfolio);
  const owed = rp !== null && (rp.pnl !== 0n || (rp.receiptPresent && !rp.receiptFinalized));
  if (capital <= 0n && positionSizeQ === 0n && !owed) return null;
  return {
    slabAddress,
    capital,
    positionSizeQ,
    reason: settled ? "settled" : "blocklisted",
    settled,
    ownerOnlyEndsAtSlot: settled && market !== null && market.forceCloseDelaySlots !== 0n ? market.resolvedSlot + market.forceCloseDelaySlots : null,
  };
}

/** Decode a market read through a {@link MARKET_MODE_SLICE_LEN} `dataSlice` (null for anything that is not a known-VERSION market). */
export function readMarketForHoldings(data: Uint8Array | null | undefined): ResolvedMarketView | null {
  if (!data) return null;
  try {
    return decodeResolvedMarket(data);
  } catch {
    return null;
  }
}
