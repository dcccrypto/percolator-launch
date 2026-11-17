/**
 * Shared deterministic workload for the priceStore bench + delivery-sequence test.
 * Drives ONLY the public API: N markets x M subscribers, a seeded mix of DB seeds, on-chain seeds/polls,
 * live WS ticks, 24h stats and invert-flag changes. Values repeat often so no-op updates are exercised.
 */
import { vi } from "vitest";

export const messageListeners = new Map<string, (data: unknown) => void>();

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WorkloadResult {
  calls: number;
  /** Full ordered delivery log: "market|listenerIdx|snapshot-json" per subscriber call (only when record=true). */
  log: string[];
}

type Store = typeof import("@/lib/priceStore/priceStore");

export function runWorkload(
  store: Store,
  opts: { seed: number; markets: number; subscribers: number; updates: number; prefix: string; record: boolean },
): WorkloadResult {
  const { seed, markets, subscribers, updates, prefix, record } = opts;
  const rnd = mulberry32(seed);
  const log: string[] = [];
  let calls = 0;
  let clock = 1_000_000;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const unsubs: Array<() => void> = [];
  const slabs: string[] = [];
  for (let m = 0; m < markets; m++) {
    const slab = `${prefix}-m${m}`;
    slabs.push(slab);
    for (let s = 0; s < subscribers; s++) {
      unsubs.push(
        store.subscribeSlab(slab, () => {
          calls++;
          if (record) {
            const snap = store.getSnapshot(slab);
            log.push(
              `${slab}|${s}|${JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? `${v}n` : v === undefined ? "__undef" : v))}`,
            );
          }
        }),
      );
    }
  }
  // A small price ladder so the same value recurs (no-op updates) as well as moves.
  const priceE6 = (): bigint => BigInt(1_000_000 + Math.floor(rnd() * 8) * 125_000);
  for (let i = 0; i < updates; i++) {
    clock += Math.floor(rnd() * 3_000);
    const slab = slabs[Math.floor(rnd() * slabs.length)];
    const op = rnd();
    if (op < 0.2) {
      store.seedFromDbIfEmpty(slab, Number(priceE6()) / 1e6, rnd() < 0.1 ? 1 : undefined);
    } else if (op < 0.45) {
      store.applyOnChainPoll(slab, priceE6());
    } else if (op < 0.55) {
      store.seedFromOnChain(slab, priceE6());
    } else if (op < 0.8) {
      const l = messageListeners.get(slab);
      l?.({ type: "price", slab, price: Number(priceE6()) / 1e6 });
      if (rnd() < 0.7) document.dispatchEvent(new Event("visibilitychange"));
    } else if (op < 0.92) {
      const v = rnd();
      store.setStats24h(slab, {
        change24h: v < 0.3 ? null : Math.floor(rnd() * 5),
        high24h: v < 0.1 ? null : 2 + Math.floor(rnd() * 3),
        low24h: Math.floor(rnd() * 2),
      });
    } else if (op < 0.97) {
      store.setInvertFlag(slab, rnd() < 0.5 ? undefined : 1);
    } else {
      store.setLotExp(slab, Math.floor(rnd() * 3));
    }
  }
  document.dispatchEvent(new Event("visibilitychange"));
  for (const u of unsubs) u();
  nowSpy.mockRestore();
  return { calls, log };
}
