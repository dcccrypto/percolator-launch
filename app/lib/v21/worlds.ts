/**
 * The ONE owner filter for market reads. Flag off: exactly `owner === getConfig().programId`
 * (the previous behavior). Flag on: the configured wrapper plus both worlds' wrappers, so v1 rows
 * (and the "v1 · close-only" label) survive the v2.1 cutover.
 */
import { getConfig } from "@/lib/config";
import { isMoveFlowEnabled } from "./move/flag";
import { dualWorldWrapperIds, worldOfWrapper, type MarketWorld } from "./world-ids";

export type { MarketWorld };

export function acceptedWrapperIds(): string[] {
  const set = new Set<string>();
  const cur = getConfig().programId;
  if (cur) set.add(cur);
  dualWorldWrapperIds().forEach((id) => set.add(id));
  return [...set];
}

/** True when `owner` (base58 of a slab's owner program) is a wrapper this app reads. */
export function isAcceptedWrapper(owner: string | null | undefined): boolean {
  return !!owner && acceptedWrapperIds().includes(owner);
}

/** The world tag for a market row: derived from its slab owner; null when flag off or foreign. */
export function marketWorld(owner: string | null | undefined): MarketWorld | null {
  return worldOfWrapper(owner);
}

/**
 * The ONE "which world is this market row/slab in" decision (label AND blocking use it).
 * Order: the row's own program id (slab owner), else the API's `world` tag (Supabase-only rows
 * have no on-chain data), else null. NEVER the global config program id: after the cutover that
 * would mislabel every v1 row, and before it every row.
 * Null (unknown, foreign, or flag off) means: no label and no blocking. Failing open is
 * deliberate: an unlabeled v1 row only loses a notice, whereas guessing would block real v2.1
 * trading. Close-only is advisory in the app anyway; closes and withdrawals are never gated.
 */
export function marketRowWorld(src: { programId?: string | null; world?: string | null }): MarketWorld | null {
  if (!isMoveFlowEnabled()) return null;
  if (src.programId) return worldOfWrapper(src.programId);
  return src.world === "v1" || src.world === "v21" ? src.world : null;
}

export function isV1Market(src: { programId?: string | null; world?: string | null }): boolean {
  return marketRowWorld(src) === "v1";
}
