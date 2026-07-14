/**
 * Pure detection logic for CreatorAttentionStrip's two data-driven
 * conditions — kept in their own module (no component/hook imports) so they
 * are unit-testable without mounting the whole strip (which pulls in
 * useCreateMarket, RecoverSolBanner's useStuckSlabs/useCloseMarket/
 * useReclaimSlabRent, etc.).
 */

import { PublicKey } from "@solana/web3.js";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import { detectOracleMode } from "@/lib/oraclePrice";

/** Same accrue-cliff threshold as CreatorMarketRow/useCreatedMarkets — engine
 *  crank staleness (asset slot_last vs current slot). */
export const ENGINE_STALE_THRESHOLD_SLOTS = 500;

/**
 * A keeper-fed (AUTH_MARK) market's price feed is "dead" when either:
 *  - it has NEVER received a price (markEwmaE6 === 0n) — the classic signature
 *    of a keeper registration that failed silently at launch time (this is the
 *    audit's highest-value new wiring: give the creator a way back to retry
 *    it, where today there is none once past the launch wizard), OR
 *  - the wrapper's own price-push timestamp (markEwmaLastSlot) is stale well
 *    beyond a normal keeper cycle (~30s per PLAYGROUND.md; this threshold is
 *    generous — ~10 minutes at 0.4s/slot — specifically to avoid false
 *    positives from a transient keeper hiccup).
 *
 * This is a DISTINCT signal from engine crank staleness (assetSlotLast) —
 * that's the on-chain accrue cliff (advances via crank/trade); this is the
 * wrapper's own oracle-push liveness (advances via the keeper's PushAuthMark).
 * A market can be crank-fresh (someone traded recently) with a long-dead
 * price feed, or vice versa.
 */
export const KEEPER_PRICE_STALE_THRESHOLD_SLOTS = 1500;

export function isKeeperFeedDead(market: CreatedMarket, currentSlot: bigint | null): boolean {
  const cfg = market.configV17;
  if (!cfg) return false;
  const mode = detectOracleMode({
    oracleAuthority: market.config?.oracleAuthority ?? PublicKey.default,
    indexFeedId: market.config?.indexFeedId ?? PublicKey.default,
    oracleModeByte: cfg.oracleMode,
  });
  if (mode !== "keeper") return false;
  if (cfg.markEwmaE6 === 0n) return true;
  if (currentSlot == null) return false;
  const staleness = currentSlot - cfg.markEwmaLastSlot;
  return staleness > BigInt(KEEPER_PRICE_STALE_THRESHOLD_SLOTS);
}

export function isEngineCrankStale(market: CreatedMarket, currentSlot: bigint | null): boolean {
  const assetSlotLast = market.v17Stats?.assetSlotLast;
  if (assetSlotLast == null || currentSlot == null) return false;
  return Number(currentSlot - assetSlotLast) >= ENGINE_STALE_THRESHOLD_SLOTS;
}
