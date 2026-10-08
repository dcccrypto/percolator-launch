/**
 * Shared oracle-staleness trading gate.
 *
 * The trade surfaces disable trading when a market's oracle price has gone
 * stale. That gate used to be written inline at each call site as an ALLOWLIST
 * of oracle modes:
 *
 *     oracleLevel === "stale" && (mode === "admin" || mode === "hyperp" || mode === "keeper")
 *
 * An allowlist is the wrong default here: a mode that nobody remembers to add
 * silently trades on a stale price. That has already happened twice —
 * "keeper" was missing (fixed inline as H7, the comment is still in
 * OrderTicket), and "pyth-pinned" was missing after that (GH#2484), while the
 * copy of the same expression had spread to four components.
 *
 * So this inverts it: stale blocks EVERY recognised mode, and any exemption has
 * to be declared. `STALE_EXEMPT_MODES` is a `Record<OracleMode, boolean>` rather
 * than an array, so adding a member to the `OracleMode` union is a COMPILE
 * ERROR until it is classified here — a new mode cannot reach production
 * unclassified, which is the failure this keeps having.
 *
 * Callers keep their own handling of the "unavailable" level, because the two
 * surfaces differ deliberately: the order ticket treats unavailable separately
 * (it has its own message), while the position panels fold it in.
 */
import type { OracleMode } from "@/lib/oraclePrice";
import type { FreshnessLevel } from "@/hooks/useOracleFreshness";

/**
 * Modes exempt from the stale-oracle trading block.
 *
 * Every entry is `false` today: no mode has a justification for trading on a
 * stale price. Flipping one to `true` is a deliberate, reviewable act and needs
 * a comment saying why.
 */
export const STALE_EXEMPT_MODES: Record<OracleMode, boolean> = {
  "pyth-pinned": false,
  hyperp: false,
  admin: false,
  keeper: false,
};

/**
 * True when a stale oracle should block trading for this market.
 *
 * Deliberately does NOT consider the "unavailable" level — that is a different
 * condition with its own copy on each surface. Compose:
 *
 *     // order ticket: unavailable handled separately
 *     const oracleStale = !oracleUnavailable && isOracleStaleBlocking(level, mode, ready);
 *     // position panels: unavailable folded in
 *     const oracleStale = oracleUnavailable || isOracleStaleBlocking(level, mode, ready);
 *
 * @param level  Freshness level from useOracleFreshness.
 * @param mode   Detected oracle mode; null when not yet resolved.
 * @param ready  Whether a price has ever been seen (a never-priced market is
 *               "unavailable", not "stale").
 */
export function isOracleStaleBlocking(
  level: FreshnessLevel,
  mode: OracleMode | null,
  ready: boolean,
): boolean {
  if (!ready || level !== "stale" || mode === null) return false;
  return !STALE_EXEMPT_MODES[mode];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Reducing actions (close / partial close)
 *
 * The 60-second rule above exists to stop OPENING on a price the user can no
 * longer trust. It is not an on-chain rule. TradeCpi / BatchTradeCpi (wrapper
 * 7c906e45, src/v16_program.rs) take 7 fixed accounts with NO oracle account and
 * trade on the STORED price; they return OracleStale only when
 * `global_or_profile_resolve_matured_at_slot` is true (def. ~10498; checked at
 * ~15037 and ~16034): the last good oracle slot is older than
 * `permissionless_resolve_stale_slots`. A feed's own `max_staleness_secs` is
 * enforced only inside `read_external_price_e6[_profile]` (the hybrid
 * configure/crank path), never on the trade path, so it is not a close rule for
 * ANY mode.
 *
 * So a close on a price older than 60 s is accepted by the chain unless the
 * market has matured, or the engine is lagging (EngineStale, handled separately
 * by the engine-catching-up flag). Blocking it in the app only strands the user
 * in a position — worse than a refused transaction. `oracleCloseGate` therefore
 * blocks a close only when the chain would. Because the chain settles at the
 * STORED price, the close preview uses that price when the live one is behind.
 * ───────────────────────────────────────────────────────────────────────── */

const MODE_HYBRID = 1;
const MODE_EWMA_MARK = 2;
const MODE_AUTH_MARK = 3;

/** What the chain's own staleness rule says about this market, read from the slab the app already loads. */
export interface CloseChainFacts {
  /** The market is a v17/v18 slab, so the rule below is known. False → keep the 60 s block. */
  chainRuleKnown: boolean;
  /** `global_or_profile_resolve_matured_at_slot` would be true at the current cluster slot. */
  resolveMatured: boolean;
}

interface MaturityConfig {
  permissionlessResolveStaleSlots?: bigint;
  lastGoodOracleSlot?: bigint;
  oracleMode?: number;
}
interface MaturityProfile {
  oracleMode?: number;
  lastGoodOracleSlot?: bigint;
}

/**
 * Mirror of `global_or_profile_resolve_matured_at_slot` (+ `permissionless_stale_matured`).
 * The threshold is read from the market, never hardcoded. An unknown cluster
 * slot cannot show maturity — the chain then decides, and the user is not
 * blocked on a guess.
 */
export function isResolveMatured(
  cfg: MaturityConfig,
  profile: MaturityProfile | null | undefined,
  chainSlot: bigint | null,
): boolean {
  const threshold = cfg.permissionlessResolveStaleSlots ?? 0n;
  if (threshold === 0n || chainSlot === null) return false;
  const age = (last: bigint) => (chainSlot > last ? chainSlot - last : 0n);
  if (age(cfg.lastGoodOracleSlot ?? 0n) >= threshold) return true;
  const managed =
    profile != null &&
    (profile.oracleMode === MODE_HYBRID ||
      profile.oracleMode === MODE_EWMA_MARK ||
      profile.oracleMode === MODE_AUTH_MARK);
  const pLast = profile?.lastGoodOracleSlot ?? 0n;
  return managed && pLast !== 0n && age(pLast) >= threshold;
}

export function deriveCloseChainFacts(
  cfg: MaturityConfig | null | undefined,
  profile: MaturityProfile | null | undefined,
  chainSlot: bigint | null,
): CloseChainFacts {
  if (cfg == null || cfg.oracleMode === undefined) return { chainRuleKnown: false, resolveMatured: false };
  return { chainRuleKnown: true, resolveMatured: isResolveMatured(cfg, profile, chainSlot) };
}

export interface CloseOracleGate {
  /** Confirm must be disabled: the chain would refuse, or there is no price. */
  blocked: boolean;
  /** Allowed, but the price is older than the 60 s rule — say so and preview at the stored price. */
  behind: boolean;
}

/**
 * Gate for a reducing action. Opening trades keep `isOracleStaleBlocking`.
 * `facts` omitted (legacy markets, partial mocks) → the old 60 s block.
 */
export function oracleCloseGate(input: {
  level: FreshnessLevel;
  mode: OracleMode | null;
  ready: boolean;
  facts?: CloseChainFacts;
}): CloseOracleGate {
  const { level, mode, ready, facts } = input;
  if (level === "unavailable") return { blocked: true, behind: false };
  if (facts?.chainRuleKnown && facts.resolveMatured) return { blocked: true, behind: false };
  if (!isOracleStaleBlocking(level, mode, ready)) return { blocked: false, behind: false };
  // Older than 60 s from here on.
  if (!facts || !facts.chainRuleKnown) return { blocked: true, behind: false };
  return { blocked: false, behind: true };
}

/** Age of the last price push: from the timestamp when known (the hook's own seconds only move on level changes). */
export function oracleAgeSecs(lastUpdateMs: number | null | undefined, elapsedSecs: number | undefined, nowMs = Date.now()): number {
  if (typeof lastUpdateMs === "number") return Math.max(0, Math.floor((nowMs - lastUpdateMs) / 1000));
  return Math.max(0, elapsedSecs ?? 0);
}

/** One calm line for a close on a price that is behind. Seconds under a minute, minutes above. */
export function priceBehindLine(ageSecs: number): string {
  const age = ageSecs < 60 ? `${Math.max(1, Math.floor(ageSecs))} sec ago` : `${Math.floor(ageSecs / 60)} min ago`;
  return `This market's price was last updated ${age}. Your close settles at that price.`;
}
