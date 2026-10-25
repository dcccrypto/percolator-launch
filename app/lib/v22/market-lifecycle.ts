/**
 * Market lifecycle state for /markets (percolator ops plan v22-market-lifecycle-plan-2026-10-25, section 4, option C).
 *
 * Five states, decided from the market account's own bytes (engine mode, stale window, open portfolios, vault), not from the
 * blocklist alone:
 *
 *   live     mode Live, price fresh (or the stale window is off).
 *   stale    mode Live and `cluster slot - last_good_oracle_slot >= permissionless_resolve_stale_slots` (wrapper tag 39 can settle it).
 *   settling mode Resolved (or Recovery) and portfolios are still open (`materialized_portfolio_count > 0`).
 *   settled  mode Resolved, no portfolio left, but the vault still holds more than dust (Earn, stake or insurance claims).
 *   retired  blocklisted, a CloseSlab tombstone, or Resolved with no portfolio and only dust in the vault. Hidden from discovery by
 *            default; never hidden from the wallets that hold funds there (they reach it by the slab URL and from Portfolio).
 *
 * Offsets: group header rows of the layout table keyed on wrapper VERSION (lib/v22/sdk/layout.ts); `resolved_slot` is the u64 right
 * after the `mode` byte (engine v16.rs `MarketGroupV16HeaderAccount`: `mode: u8, resolved_slot: V16PodU64`), the same offsets the
 * oracle keeper decodes (percolator-oracle-keeper src/cross-cluster/market-state.ts: VERSION 19 mode 674, resolved_slot 675). The
 * wrapper config sits at account offset 16: `permissionless_resolve_stale_slots` +136, `force_close_delay_slots` +144,
 * `last_good_oracle_slot` +152 (wrapper v16_program.rs `WrapperConfigV16`; same as lib/v22/sdk/slab.ts parseWrapperConfigV17).
 *
 * Pure: no RPC, no React. Unknown VERSION / magic / short bytes decode to null: nothing is claimed about them.
 */
import { ACCOUNT_KIND, LAYOUTS_BY_VERSION, WRAPPER_ACCOUNT_MAGIC, readWrapperHeader } from "./sdk/layout";

export type MarketLifecycleState = "live" | "stale" | "settling" | "settled" | "retired";

export const LIFECYCLE_STATES: readonly MarketLifecycleState[] = ["live", "stale", "settling", "settled", "retired"];

/** Bytes to read per market (`dataSlice` 0..N): covers the wrapper config and the end of the group header of every known VERSION. */
export const LIFECYCLE_SLICE_LEN = 1280;

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

/**
 * A resolved market whose vault holds at most this many atoms is "retired": the Earn vault's 1,000-share dead floor
 * (`LP_VAULT_MINIMUM_LIQUIDITY`) keeps about 1,000 atoms in a v2.2 vault forever (FC-B5, about 0.001 USDC at genesis), so a
 * vault of exactly zero would never happen. 50,000 atoms is 0.05 of a 6-decimal token: well above the floor, below anything a
 * person would call a claim.
 */
export const RETIRED_VAULT_DUST_ATOMS = 50_000n;

export interface MarketLifecycleFields {
  /** Account kind byte: 1 market, 8 CloseSlab tombstone. */
  kind: number;
  /** Engine mode byte (0 Live, 1 Resolved, 2 Recovery). Null on a tombstone. */
  mode: number | null;
  resolvedSlot: bigint;
  materializedPortfolios: bigint;
  vault: bigint;
  staleSlots: bigint;
  forceCloseDelaySlots: bigint;
  lastGoodOracleSlot: bigint;
}

function u128(v: DataView, off: number): bigint {
  return v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);
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
      return { kind, mode: null, resolvedSlot: 0n, materializedPortfolios: 0n, vault: 0n, staleSlots: 0n, forceCloseDelaySlots: 0n, lastGoodOracleSlot: 0n };
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
      vault: u128(dv, g + layout.group.vault),
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
 * The state of one market. `fields` null (unread / unknown layout) falls back to the blocklist alone: blocklisted = retired,
 * anything else = live (nothing is claimed that was not read).
 */
export function deriveMarketLifecycle(args: { fields: MarketLifecycleFields | null; clusterSlot: bigint | null; blocklisted: boolean }): MarketLifecycle {
  const { fields, clusterSlot, blocklisted } = args;
  const base = { staleAgeSlots: 0n, lastGoodOracleSlot: 0n, ownerOnlyEndsAtSlot: null, blocklisted };
  if (blocklisted) return { ...base, state: "retired" };
  if (!fields) return { ...base, state: "live" };
  if (fields.mode === null) return { ...base, state: "retired" }; // CloseSlab tombstone
  if (fields.mode === MODE_LIVE) {
    if (clusterSlot !== null && fields.staleSlots !== 0n) {
      const age = clusterSlot > fields.lastGoodOracleSlot ? clusterSlot - fields.lastGoodOracleSlot : 0n;
      if (age >= fields.staleSlots) return { ...base, state: "stale", staleAgeSlots: age, lastGoodOracleSlot: fields.lastGoodOracleSlot };
    }
    return { ...base, state: "live" };
  }
  const ownerOnlyEndsAtSlot = fields.forceCloseDelaySlots === 0n ? null : fields.resolvedSlot + fields.forceCloseDelaySlots;
  if (fields.mode === MODE_RESOLVED && fields.materializedPortfolios === 0n) {
    return { ...base, ownerOnlyEndsAtSlot, state: fields.vault <= RETIRED_VAULT_DUST_ATOMS ? "retired" : "settled" };
  }
  // Resolved with portfolios still open, or Recovery (its crank reaches Resolved): settlement is under way.
  return { ...base, ownerOnlyEndsAtSlot, state: "settling" };
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
  settling: "This market has been settled. Open positions are being closed out and paid to their owners.",
  settled: "This market is settled and closed to trading. Open it to claim what is yours.",
  retired: "Nothing is left to settle here. Hidden from the list by default; your funds, if any, stay reachable from Portfolio.",
};

/** The stale line shown with the Settle button. */
export function staleLine(stoppedAtLabel: string, hasFunds: boolean): string {
  return `Price stopped at ${stoppedAtLabel}. Anyone can settle this market.${hasFunds ? " Settle it to get your funds back." : ""}`;
}
