/**
 * Market lifecycle state for /markets (percolator ops plan v22-market-lifecycle-plan-2026-10-25, sections 3.8 and 4, option C).
 *
 * Five states, decided from the market account's own bytes (engine mode, stale window, open portfolios), not from the blocklist alone:
 *
 *   live     mode Live, price fresh (or the stale window is off).
 *   stale    mode Live and tag 39 would resolve it now (`staleResolveStatusV22`: stale window matured, cluster not behind the engine clock).
 *   settling mode Recovery, or Resolved with portfolios still open (`materialized_portfolio_count > 0`).
 *   settled  mode Resolved and no portfolio left. Claims may still be open: Earn, stake and insurance money lives in other accounts
 *            (the stake pool vault, the Earn vault), which market bytes cannot show.
 *   retired  a CloseSlab tombstone, or an explicit retirement (the blocklist). NEVER derived from market bytes alone: a Resolved market
 *            with no portfolio and an empty vault can still have a stake pool holding stakers' money (devnet 6mqz4o7j…, 4,000,000 atoms).
 *            Hidden from the default list; stakers reach their funds on the stake page, Earn holders on the Earn page, traders from Portfolio.
 *
 * Offsets: group header rows of the layout table keyed on wrapper VERSION (lib/v22/sdk/layout.ts); `resolved_slot` is the u64 right
 * after the `mode` byte (engine v16.rs `MarketGroupV16HeaderAccount`: `mode: u8, resolved_slot: V16PodU64`), the same offsets the
 * oracle keeper decodes (percolator-oracle-keeper src/cross-cluster/market-state.ts: VERSION 19 mode 674, resolved_slot 675). The
 * wrapper config sits at account offset 16: `permissionless_resolve_stale_slots` +136, `force_close_delay_slots` +144,
 * `last_good_oracle_slot` +152 (wrapper v16_program.rs `WrapperConfigV16`; same as lib/v22/sdk/slab.ts parseWrapperConfigV17).
 * The stale test is lib/v22/stale-resolve.ts `staleResolveStatusV22`, the one the Settle button uses.
 *
 * Pure: no RPC, no React. Unknown VERSION / magic / short bytes decode to null: nothing is claimed about them.
 */
import { ACCOUNT_KIND, LAYOUTS_BY_VERSION, WRAPPER_ACCOUNT_MAGIC, readWrapperHeader } from "./sdk/layout";
import { staleResolveStatusV22 } from "./stale-resolve";

export type MarketLifecycleState = "live" | "stale" | "settling" | "settled" | "retired";

export const LIFECYCLE_STATES: readonly MarketLifecycleState[] = ["live", "stale", "settling", "settled", "retired"];

/**
 * Bytes to read per market (`dataSlice` 0..N): the whole market-group header of the longest known layout, which is what
 * `staleResolveStatusV22` needs and covers the wrapper config and the `mode` / `resolved_slot` bytes. Derived from the layout table.
 */
export const LIFECYCLE_SLICE_LEN: number = Math.max(...[...LAYOUTS_BY_VERSION.values()].map((l) => Math.max(l.marketGroupOff + l.marketGroupLen, l.marketGroupOff + l.group.mode + 9)));

/** `permissionless_resolve_stale_slots` etc. live in the wrapper config, which starts at account offset 16. */
const CONFIG_OFF = 16;
const CFG_STALE_SLOTS = 136;
const CFG_FORCE_CLOSE_DELAY = 144;
const CFG_LAST_GOOD_ORACLE_SLOT = 152;

/** Engine `MarketMode` bytes. */
const MODE_LIVE = 0;
const MODE_RESOLVED = 1;

/** Seconds per slot used for time copy (400 ms), the same figure lib/v22/stale-resolve.ts uses. */
export const LIFECYCLE_SLOT_SECONDS = 0.4;

export interface MarketLifecycleFields {
  /** Account kind byte: 1 market, 8 CloseSlab tombstone. */
  kind: number;
  /** Engine mode byte (0 Live, 1 Resolved, 2 Recovery). Null on a tombstone. */
  mode: number | null;
  resolvedSlot: bigint;
  materializedPortfolios: bigint;
  staleSlots: bigint;
  forceCloseDelaySlots: bigint;
  lastGoodOracleSlot: bigint;
}

/**
 * The lifecycle fields of a market account (a prefix of at least {@link LIFECYCLE_SLICE_LEN} bytes is enough, so a `dataSlice`
 * read works). Null for anything that is not a wrapper market / tombstone of a known VERSION, or is too short.
 */
export function decodeMarketLifecycleFields(data: Uint8Array | null | undefined): MarketLifecycleFields | null {
  if (!data) return null;
  try {
    const { magic, version, kind } = readWrapperHeader(data, "decodeMarketLifecycleFields");
    if (magic !== WRAPPER_ACCOUNT_MAGIC) return null;
    if (kind === ACCOUNT_KIND.ClosedMarket) {
      return { kind, mode: null, resolvedSlot: 0n, materializedPortfolios: 0n, staleSlots: 0n, forceCloseDelaySlots: 0n, lastGoodOracleSlot: 0n };
    }
    if (kind !== ACCOUNT_KIND.Market) return null;
    const layout = LAYOUTS_BY_VERSION.get(version);
    if (!layout) return null;
    const g = layout.marketGroupOff;
    const need = g + layout.group.mode + 9;
    if (data.length < need || data.length < CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT + 8) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      kind,
      mode: data[g + layout.group.mode] as number,
      resolvedSlot: dv.getBigUint64(g + layout.group.mode + 1, true),
      materializedPortfolios: dv.getBigUint64(g + layout.group.materializedPortfolioCount, true),
      staleSlots: dv.getBigUint64(CONFIG_OFF + CFG_STALE_SLOTS, true),
      forceCloseDelaySlots: dv.getBigUint64(CONFIG_OFF + CFG_FORCE_CLOSE_DELAY, true),
      lastGoodOracleSlot: dv.getBigUint64(CONFIG_OFF + CFG_LAST_GOOD_ORACLE_SLOT, true),
    };
  } catch {
    return null;
  }
}

export interface MarketLifecycle {
  state: MarketLifecycleState;
  /** Live and matured: slots since the last good price (else 0). */
  staleAgeSlots: bigint;
  /** Stale: the slot of the last good price. */
  lastGoodOracleSlot: bigint;
  /** Resolved / Recovery: slot at which the owner-only window ends (`resolved_slot + force_close_delay_slots`), null when none. */
  ownerOnlyEndsAtSlot: bigint | null;
  /** The market's own flags the badge needs. */
  blocklisted: boolean;
}

/**
 * The state of one market from its bytes (a {@link LIFECYCLE_SLICE_LEN} prefix is enough). Unread / unknown layout falls back to the
 * blocklist alone: blocklisted = retired, anything else = live (nothing is claimed that was not read).
 */
export function deriveMarketLifecycle(args: { data: Uint8Array | null | undefined; clusterSlot: bigint | null; blocklisted: boolean }): MarketLifecycle {
  const { data, clusterSlot, blocklisted } = args;
  const base = { staleAgeSlots: 0n, lastGoodOracleSlot: 0n, ownerOnlyEndsAtSlot: null, blocklisted };
  if (blocklisted) return { ...base, state: "retired" };
  const fields = decodeMarketLifecycleFields(data);
  if (!fields) return { ...base, state: "live" };
  if (fields.mode === null) return { ...base, state: "retired" }; // CloseSlab tombstone
  if (fields.mode === MODE_LIVE) {
    const st = staleResolveStatusV22(data, clusterSlot);
    if (st !== null && st.canResolve) return { ...base, state: "stale", staleAgeSlots: st.ageSlots, lastGoodOracleSlot: st.lastGoodOracleSlot };
    return { ...base, state: "live" };
  }
  const ownerOnlyEndsAtSlot = fields.forceCloseDelaySlots === 0n ? null : fields.resolvedSlot + fields.forceCloseDelaySlots;
  // Resolved with portfolios still open, or Recovery (its crank reaches Resolved): settlement is under way.
  if (fields.mode !== MODE_RESOLVED || fields.materializedPortfolios > 0n) return { ...base, ownerOnlyEndsAtSlot, state: "settling" };
  return { ...base, ownerOnlyEndsAtSlot, state: "settled" };
}

/** Retired markets are not offered in discovery unless the viewer asks for them; every other state is. */
export function lifecycleListedByDefault(state: MarketLifecycleState): boolean {
  return state !== "retired";
}

/** The /markets state filter: "all" (the default, retired hidden), or one state. */
export type LifecycleFilter = "all" | MarketLifecycleState;

export function parseLifecycleFilter(raw: string | null | undefined): LifecycleFilter {
  return raw && (LIFECYCLE_STATES as readonly string[]).includes(raw) ? (raw as MarketLifecycleState) : "all";
}

export function matchesLifecycleFilter(state: MarketLifecycleState, filter: LifecycleFilter): boolean {
  return filter === "all" ? lifecycleListedByDefault(state) : state === filter;
}

/** "14:05" today, "Oct 24, 14:05" on another day (local time of the viewer). */
export function formatStoppedAt(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const n = new Date(nowMs);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === n.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** Wall-clock estimate of when the last good price landed, from its age in slots at `nowMs`. */
export function stoppedAtMs(ageSlots: bigint, nowMs: number): number {
  return nowMs - Math.round(Number(ageSlots) * LIFECYCLE_SLOT_SECONDS * 1000);
}

export const LIFECYCLE_LABELS: Record<MarketLifecycleState, string> = {
  live: "Live",
  stale: "Stale",
  settling: "Settling",
  settled: "Settled",
  retired: "Retired",
};

/** One honest line per state (badge tooltip / filter help). */
export const LIFECYCLE_HINTS: Record<MarketLifecycleState, string> = {
  live: "Trading normally.",
  stale: "The price has stopped. Anyone can settle this market.",
  settling: "This market has stopped trading and is being wound down. Open positions are being closed out and paid to their owners.",
  settled: "This market is settled and closed to trading. Open it to see what you can claim; stakers withdraw on the Stake page, Earn depositors on Earn.",
  retired: "This market has been retired. Hidden from the list by default; it stays reachable by its link, and your funds, if any, are still yours: traders from Portfolio, stakers on the Stake page, Earn depositors on Earn.",
};

/** The stale line shown with the Settle button (the time is an estimate from the age in slots). */
export function staleLine(stoppedAtLabel: string, hasFunds: boolean): string {
  return `Price stopped at about ${stoppedAtLabel}. Anyone can settle this market.${hasFunds ? " Settle it to get your funds back." : ""}`;
}
