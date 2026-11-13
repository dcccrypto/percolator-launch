/**
 * r10: a trade on this device is in flight (or just landed) on `slab`: the ticket / close hook is about to write the position's entry itself,
 * so no chain rebuild may start or save meanwhile. Time-boxed so a stuck wallet prompt cannot block a rebuild forever.
 */
const holds = new Map<string, number>();
export function holdChainSync(slab: string, ms: number, now: number = Date.now()): void {
  holds.set(slab, Math.max(holds.get(slab) ?? 0, now + ms));
}
export function chainSyncHeld(slab: string, now: number = Date.now()): boolean {
  return (holds.get(slab) ?? 0) > now;
}


export function __resetChainSyncHoldsForTests(): void {
  holds.clear();
}
