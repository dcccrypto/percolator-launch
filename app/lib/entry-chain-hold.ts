/**
 * r10: a trade on this device is in flight (or just landed) on `slab`: the ticket / close hook is about to write the position's entry itself,
 * so no chain rebuild may start or save meanwhile. Time-boxed so a stuck wallet prompt cannot block a rebuild forever.
 * Each hold remembers its own length so a clock that steps backwards cannot leave it blocked for longer than that length.
 */
interface Hold { until: number; ms: number }
const holds = new Map<string, Hold>();
/** Live hold for `slab` at `now`: expired entries are dropped, and an expiry further out than its own length (clock stepped back) is pulled in. */
function live(slab: string, now: number): Hold | null {
  const h = holds.get(slab);
  if (!h) return null;
  if (h.until <= now) { holds.delete(slab); return null; }
  if (h.until > now + h.ms) h.until = now + h.ms;
  return h;
}
export function holdChainSync(slab: string, ms: number, now: number = Date.now()): void {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return;
  const prev = live(slab, now);
  if (!prev || now + ms > prev.until) holds.set(slab, { until: now + ms, ms });
}
/** Sets the hold to expire `ms` from now (shorter or longer): the end of a wait budget turns a long hold into a short post-landing one. */
export function setChainSyncHold(slab: string, ms: number, now: number = Date.now()): void {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return;
  if (ms <= 0) holds.delete(slab);
  else holds.set(slab, { until: now + ms, ms });
}
export function chainSyncHeld(slab: string, now: number = Date.now()): boolean {
  return live(slab, now) !== null;
}


export function __resetChainSyncHoldsForTests(): void {
  holds.clear();
}
