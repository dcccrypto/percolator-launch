/**
 * Layout resolution for the app: the ONE place that decides account geometry.
 *
 * Why: the wrapper hand-lays every account and the engine grows its structs between releases (v2.1 is
 * wrapper VERSION 18, v2.2 is VERSION 19: market group 758 -> 806 B, asset slot 2,325 -> 2,629 B,
 * portfolio 9,563 -> 10,603 B, leg 152 -> 217 B). A reader that picks its geometry from constants or from
 * the buffer LENGTH reads a v2.2 market with v2.1 offsets and shows plausible, wrong numbers. So geometry
 * is chosen from the account's VERSION through the SDK's table, and an unknown VERSION is refused with the
 * SDK's typed `UnknownLayoutError` (see {@link isUnsupportedLayout}); callers render the calm fallback.
 *
 * Flag off (`NEXT_PUBLIC_DEVNET_V22` unset): every function here returns what the v2.1 constants returned
 * and delegates to the installed SDK 8.0.0 decoders, so behaviour is unchanged (pinned by
 * `__tests__/lib/v22/layout.test.ts`, including a parity run against the old constants).
 */
import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  V17_PORTFOLIO_ACCOUNT_LEN,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  parsePortfolioV17,
  parseMarketGroupV17OI,
  type V17MarketGroupOI,
} from "@percolatorct/sdk";
import { isDevnetV22Enabled } from "./flag";
import {
  ACCOUNT_KIND,
  LAYOUT_V21,
  LAYOUT_V22,
  UnknownLayoutError,
  buildCreatePortfolioAccountIxV22,
  portfolioFilterForLayout,
  resolveLayout,
  resolveMarketGeometry,
  v22Slab,
  type LayoutTable,
  type MarketGeometry,
} from "./sdk";
import { V22_COPY } from "./copy";

export { UnknownLayoutError };

/** The layout every NEW account is created with: v2.2 when the flag is on, v2.1 otherwise. */
export function activeLayout(): LayoutTable {
  return isDevnetV22Enabled() ? LAYOUT_V22 : LAYOUT_V21;
}

/** Exact `PORTFOLIO_ACCOUNT_LEN` of the active layout (9,563 flag off; 10,603 flag on). */
export function portfolioAccountLen(): number {
  return isDevnetV22Enabled() ? LAYOUT_V22.portfolio.accountLen : V17_PORTFOLIO_ACCOUNT_LEN;
}

/**
 * `SystemProgram.createAccount` for ANY portfolio (trader, fund-and-trade, isolated, LP, vault LP) at exactly
 * {@link portfolioAccountLen}. v2.2 cannot realloc past 10,240 B, so a wrong length fails on chain.
 * Flag off this is byte-identical to the instruction the call sites built inline before.
 */
export function createPortfolioAccountIx(payer: PublicKey, portfolio: PublicKey, lamports: number, programId: PublicKey): TransactionInstruction {
  if (isDevnetV22Enabled()) return buildCreatePortfolioAccountIxV22(payer, portfolio, lamports, programId, LAYOUT_V22);
  return SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: portfolio, lamports, space: V17_PORTFOLIO_ACCOUNT_LEN, programId });
}

/** `getProgramAccounts` size + VERSION filters for portfolios of the active layout. */
export function portfolioScanFilters(): { dataSize: number; versionMemcmp?: { offset: number; bytes: string } } {
  if (isDevnetV22Enabled()) return portfolioFilterForLayout(LAYOUT_V22);
  return { dataSize: V17_PORTFOLIO_ACCOUNT_LEN };
}

/** Is `data` a whole portfolio account of the active layout? (kind byte + exact length) */
export function isPortfolioOfActiveLayout(data: Uint8Array): boolean {
  return data.length === portfolioAccountLen() && data[10] === ACCOUNT_KIND.Portfolio;
}

/** Geometry of a market account, resolved from its VERSION (flag on) or the v2.1 constants (flag off). */
export interface AppMarketGeometry {
  layout: LayoutTable;
  /** Absolute offset of the market-group header. */
  groupOff: number;
  /** Absolute offset of asset slot 0. */
  slotsBase: number;
  /** Absolute offset of asset `i`'s wrapper prefix (its oracle profile starts here). */
  slotOff(i: number): number;
  /** Absolute offset of asset `i`'s engine slot. */
  engineOff(i: number): number;
  /** Whole asset slots physically present (flag on only; flag off: floor((len - slotsBase) / stride)). */
  slotCount: number;
}

/**
 * Resolve a market account's geometry.
 * @throws `UnknownLayoutError` (flag on) when the VERSION / magic / kind is not a layout this build decodes.
 */
export function marketGeometry(data: Uint8Array, parser = "marketGeometry"): AppMarketGeometry {
  if (isDevnetV22Enabled()) {
    const g: MarketGeometry = resolveMarketGeometry(data, { parser, strictLength: false });
    return { layout: g.layout, groupOff: g.groupOff, slotsBase: g.slotsBase, slotOff: g.slotOff, engineOff: g.engineOff, slotCount: g.slotCount };
  }
  const slotsBase = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  return {
    layout: LAYOUT_V21,
    groupOff: V17_MARKET_GROUP_OFF,
    slotsBase,
    slotOff: (i) => slotsBase + i * V17_MARKET_ASSET_SLOT_LEN,
    engineOff: (i) => slotsBase + i * V17_MARKET_ASSET_SLOT_LEN + V17_ASSET_ORACLE_WRAPPER_LEN,
    slotCount: Math.max(0, Math.floor((data.length - slotsBase) / V17_MARKET_ASSET_SLOT_LEN)),
  };
}

/** Table for ANY wrapper account (market, portfolio, ...) by VERSION (flag on) or v2.1 (flag off). */
export function layoutOf(data: Uint8Array, parser: string, kind?: number): LayoutTable {
  if (!isDevnetV22Enabled()) return LAYOUT_V21;
  return resolveLayout(data, { parser, kind });
}

/** Total + per-asset open interest and insurance of a market, by the account's VERSION. */
export function parseMarketOI(data: Uint8Array): V17MarketGroupOI {
  return isDevnetV22Enabled() ? v22Slab.parseMarketGroupV17OI(data) : parseMarketGroupV17OI(data);
}

/** A portfolio decoded by the account's VERSION + engine discriminator. */
export function parsePortfolio(data: Uint8Array): ReturnType<typeof v22Slab.parsePortfolioV17> {
  return isDevnetV22Enabled() ? v22Slab.parsePortfolioV17(data) : parsePortfolioV17(data);
}

/** True for the SDK's typed refusal of an unknown VERSION / discriminator / length. */
export function isUnsupportedLayout(e: unknown): e is UnknownLayoutError {
  if (e instanceof UnknownLayoutError) return true;
  // Cross-realm / bundled duplicates: match on the class name the SDK sets.
  return e instanceof Error && e.name === "UnknownLayoutError";
}

/** Calm, one-line text for the fallback UI. Never shows the version numbers or byte offsets. */
export function unsupportedLayoutMessage(): { title: string; body: string } {
  return { title: V22_COPY.layout.title, body: V22_COPY.layout.body };
}

/** JSON body for API routes that meet an unsupported layout (HTTP 422, never a 500 with partial numbers). */
export function unsupportedLayoutBody(e: unknown): { error: "unsupported_layout"; message: string; version: number | null } {
  const version = isUnsupportedLayout(e) && typeof (e as UnknownLayoutError).version === "number" ? (e as UnknownLayoutError).version ?? null : null;
  return { error: "unsupported_layout", message: V22_COPY.layout.body, version };
}
