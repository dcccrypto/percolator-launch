/**
 * LRU-bounded `Map.set`. `Map` preserves insertion order, so the first key is
 * the oldest — deleting it evicts the least-recently-written entry; deleting
 * `key` before re-inserting moves a refreshed entry to the newest position so
 * hot keys survive eviction.
 *
 * Used by in-process caches (e.g. the chart route's GeckoTerminal pool/candle
 * caches) whose keys are attacker-influenced: without a cap, a flood of
 * distinct keys grows the Map without bound (memory DoS), because TTL is
 * checked only on read and entries are never otherwise evicted.
 *
 * @param map        the cache Map to mutate
 * @param key        entry key
 * @param value      entry value
 * @param maxEntries hard cap; the Map never exceeds this size after the call
 *                   (must be >= 1)
 */
export function boundedSet<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  maxEntries: number,
): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
