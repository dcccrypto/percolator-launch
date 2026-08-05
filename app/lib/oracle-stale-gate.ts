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
