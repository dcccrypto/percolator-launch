/**
 * How /my-markets presents a launch that stopped part-way (#3266).
 *
 * The chain already says a launch is unfinished: `marketauth` is still the creator's wallet until the
 * final step (StakeInitPool) rotates it to the stake-pool PDA (lib/market-completeness.ts). What the
 * row used to do was take its name from the indexer's placeholder row ("UNKNOWN") and offer a close
 * whose only guidance, once the launch was funded, was a dead end. Pure functions only: the row and
 * its panel compose them, so the wording and the removable/committed decision are testable without a
 * wallet.
 */
import { parseBackingBucketsV17 } from "@percolatorct/sdk";
import { readMarketGroupHeader } from "@/lib/v18-wire";

/** What the indexer writes for a market whose real symbol nothing on chain can supply. */
export const PLACEHOLDER_SYMBOL = "UNKNOWN";

/** True for the indexer's placeholder (any case, padding ignored): it is "no ticker", not a ticker. */
export function isPlaceholderTicker(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().toUpperCase() === PLACEHOLDER_SYMBOL;
}

export const LAUNCH_UNFINISHED_TITLE = "Launch unfinished";
export const UNNAMED_MARKET_TITLE = "Unnamed market";

/**
 * The name a creator's row carries.
 *
 *  - a real ticker, whatever the state, is the name;
 *  - an unfinished launch with no known ticker is "Launch unfinished" (never the collateral
 *    token's symbol, which `fallbackLabel` is, and never the placeholder);
 *  - a finished market whose row still carries the placeholder never got its registration, so it is
 *    "Unnamed market" (the attention strip offers the live-price connection);
 *  - otherwise the fallback label (identity still loading).
 */
export function launchRowTitle(i: {
  symbol: string | null;
  unfinished: boolean;
  /** Some source carried the placeholder ticker (so identity HAS loaded; it just knows nothing). */
  sawPlaceholder: boolean;
  fallbackLabel: string;
}): string {
  if (i.symbol) return i.symbol;
  if (i.unfinished) return LAUNCH_UNFINISHED_TITLE;
  if (i.sawPlaceholder) return UNNAMED_MARKET_TITLE;
  return i.fallbackLabel;
}

// ── Which state the launch stopped in ────────────────────────────────────────────────────────────

/** The market-group header facts that decide whether CloseSlab can ever succeed (read from the slab bytes). */
export interface LaunchFootprint {
  /** 0 = Live, 1 = Resolved. */
  mode: number;
  /** Total user capital (the LP deposit lands here). */
  cTot: bigint;
  /** Materialised portfolios (the LP portfolio is created in launch step 2). */
  portfolios: bigint;
  /**
   * Any LP-vault backing bucket holds funds (launch step 4 seeds both domains). The wrapper's CloseSlab
   * refuses while one does, even when c_tot and insurance read zero.
   */
  backingFunded: boolean;
}

export function readLaunchFootprint(slabData: Uint8Array): LaunchFootprint | null {
  try {
    const h = readMarketGroupHeader(slabData);
    // Unreadable buckets must never look empty: the whole footprint is then unknown.
    const b = parseBackingBucketsV17(slabData);
    const backingFunded = b.buckets.some(
      (x) =>
        x.status !== 0 ||
        x.freshUnlienedBackingNum > 0n ||
        x.validLienedBackingNum > 0n ||
        x.consumedLienedBackingNum > 0n ||
        x.impairedLienedBackingNum > 0n ||
        x.utilizationFeeEarnings > 0n,
    );
    return { mode: h.mode, cTot: h.cTot, portfolios: h.materializedPortfolioCount, backingFunded };
  } catch {
    return null;
  }
}

/**
 * - `removable`: nothing is deposited and no portfolio exists, so ResolveMarket + CloseSlab succeed
 *   (lib/close-market-plan.ts) and the rent comes back. Launch steps 0-1 (created, oracle handed off).
 * - `committed`: the market holds a portfolio and/or funds (c_tot, insurance or LP-vault backing). CloseSlab
 *   refuses (EngineLockActive), so from here the only way forward is to finish the launch. `funded` says whether money is in (LP deposit or
 *   insurance) as opposed to only the LP portfolio account existing (launch step 2).
 * - `unknown`: the slab or its insurance has not been read yet; the row claims nothing.
 */
export type LaunchStage = { kind: "removable" } | { kind: "committed"; funded: boolean } | { kind: "unknown" };

export function classifyLaunchStage(footprint: LaunchFootprint | null | undefined, insuranceAtoms: bigint | null): LaunchStage {
  if (!footprint || insuranceAtoms === null) return { kind: "unknown" };
  const funded = footprint.cTot > 0n || insuranceAtoms > 0n || footprint.backingFunded;
  // A resolved market (mode 1) no longer gates on capital the way a Live one does in planCloseMarket,
  // but CloseSlab still needs c_tot and insurance at zero.
  const livePortfolio = footprint.mode === 0 && footprint.portfolios > 0n;
  if (funded || livePortfolio) return { kind: "committed", funded };
  return { kind: "removable" };
}

export const UNFINISHED_COPY = {
  heading: "This launch didn't finish",
  removable:
    "No funds, portfolio or backing were found on it, so it can still be removed from here. Continue the launch, or reclaim its rent.",
  committedFunded:
    "It stopped after its funds went in, so it can't be removed from here. The only way forward from here is to finish it from Create Market. Nothing about your funds has changed, and they are not lost.",
  committedPortfolio:
    "It stopped after its liquidity account was set up. That account can't be removed from here, so the only way forward from here is to finish it from Create Market.",
  unknown: "Reading what this launch had completed. You can continue it from Create Market in the meantime.",
  continue: "Continue launch",
  reclaim: "Reclaim rent",
  /** The close checklist's insurance line for a launch that was funded before it stopped. */
  insuranceBlocked: "This launch stopped after its funds went in, so it can't be removed from here. Finish it from Create Market.",
} as const;

/** The paragraph that explains the stage. */
export function unfinishedStageCopy(stage: LaunchStage): string {
  if (stage.kind === "removable") return UNFINISHED_COPY.removable;
  if (stage.kind === "committed") return stage.funded ? UNFINISHED_COPY.committedFunded : UNFINISHED_COPY.committedPortfolio;
  return UNFINISHED_COPY.unknown;
}

// ── What this browser knows about the token ──────────────────────────────────────────────────────

/** Minimal Storage surface (window.localStorage in the app; a Map-backed fake in tests). */
export interface ReadStore {
  getItem(k: string): string | null;
}

export interface SavedLaunchIdentity {
  symbol: string | null;
  name: string | null;
}

/**
 * The token's real symbol and name, if the launching browser saved them. The in-flight record
 * (lib/inFlightMarket.ts) carries no token identity; the launch's saved registration payload and
 * request (lib/keeper-register-client.ts, both keyed by slab) do. Absent on another device or after
 * site data is cleared, and the placeholder never counts as a name.
 */
export function savedLaunchIdentity(slab: string, store: ReadStore | null): SavedLaunchIdentity | null {
  if (!store) return null;
  const parse = (key: string): Record<string, unknown> | null => {
    try {
      const raw = store.getItem(key);
      const v: unknown = raw ? JSON.parse(raw) : null;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const real = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 && !isPlaceholderTicker(v) ? v : null);
  const payload = parse(`perc.keeperPayload.${slab}`);
  const request = parse(`perc.keeperRequest.${slab}`);
  const symbol = real(payload?.symbol) ?? real(request?.symbol);
  const name = real(payload?.name);
  return symbol || name ? { symbol, name } : null;
}
