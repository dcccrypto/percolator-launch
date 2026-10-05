/**
 * The ONE owner filter for market reads. Flag off: exactly `owner === getConfig().programId`
 * (the previous behavior). Flag on: the configured wrapper plus both worlds' wrappers, so v1 rows
 * (and the "v1 · close-only" label) survive the v2.1 cutover.
 */
import { getConfig } from "@/lib/config";
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
