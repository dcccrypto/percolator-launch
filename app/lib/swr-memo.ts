/**
 * Per-key, per-instance stale-while-revalidate memo for server routes whose on-chain read is the same for every
 * caller (SERVER-ONLY; process-local, non-authoritative — never use it for anything a signer acts on).
 *
 * - age < freshMs: the stored value is returned.
 * - freshMs <= age < freshMs + staleMs: the stored value is returned at once and ONE background load refreshes it.
 * - otherwise (or nothing stored): the caller waits for a load; concurrent callers for a key share that one load.
 * - `shouldStore(value)` false (e.g. an error / 404 response): returned to that caller, never stored.
 * - A failed load is not stored (the caller sees the rejection; a failed background refresh keeps the old value
 *   until it ages out). At most `max` keys are kept: the oldest-stored entry is evicted first.
 * - `ttlCapMs()` lets an env kill-switch lower the fresh window (a cap below `freshMs` also drops the stale window, so
 *   it bounds total staleness); 0 turns the memo off (every call loads).
 * - `onBackground(p)` receives each background refresh (routes pass Next `after`, so a serverless instance is not
 *   frozen mid-refresh).
 */
export interface SwrMemo<K, V> {
  get(key: K, load: () => Promise<V>): Promise<V>;
  clear(): void;
}

export function createSwrMemo<K, V>(opts: {
  freshMs: number;
  staleMs: number;
  max: number;
  shouldStore: (value: V) => boolean;
  ttlCapMs?: () => number;
  onBackground?: (p: Promise<unknown>) => void;
  now?: () => number;
}): SwrMemo<K, V> {
  const now = opts.now ?? Date.now;
  const stored = new Map<K, { at: number; value: V }>();
  const inflight = new Map<K, { startedAt: number; promise: Promise<V> }>();
  let generation = 0;

  function load(key: K, loader: () => Promise<V>): Promise<V> {
    const startedAt = now();
    // Shared only while younger than the fresh window: a hung load costs at most one extra load per window.
    const running = inflight.get(key);
    if (running && startedAt - running.startedAt < opts.freshMs) return running.promise;
    const gen = generation;
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        const cur = stored.get(key);
        if (gen === generation && opts.shouldStore(value) && (!cur || cur.at <= startedAt)) {
          stored.delete(key); // re-insert so Map order is store order (oldest first for eviction)
          stored.set(key, { at: startedAt, value });
          while (stored.size > opts.max) stored.delete(stored.keys().next().value as K);
        }
        return value;
      })
      .finally(() => {
        if (inflight.get(key)?.promise === promise) inflight.delete(key);
      });
    inflight.set(key, { startedAt, promise });
    return promise;
  }

  return {
    get(key, loader) {
      const cap = opts.ttlCapMs ? opts.ttlCapMs() : opts.freshMs;
      const fresh = Math.min(opts.freshMs, cap);
      if (!(fresh > 0)) return Promise.resolve().then(loader);
      const stale = cap < opts.freshMs ? 0 : opts.staleMs;
      const hit = stored.get(key);
      const age = hit ? now() - hit.at : Infinity;
      if (hit && age < fresh) return Promise.resolve(hit.value);
      if (hit && age < fresh + stale) {
        const bg = load(key, loader).catch(() => undefined);
        try {
          opts.onBackground?.(bg);
        } catch {
          /* e.g. Next `after` outside a request scope */
        }
        return Promise.resolve(hit.value);
      }
      return load(key, loader);
    },
    clear() {
      stored.clear();
      inflight.clear();
      generation++;
    },
  };
}

/** MARKET_ROWS_MEMO_MS (the market-row memo kill-switch, 0 in tests) as a cap for route memos; unset = no cap. */
export function marketMemoCapMs(): number {
  const raw = process.env.MARKET_ROWS_MEMO_MS;
  if (raw === undefined || raw.trim() === "") return Number.POSITIVE_INFINITY;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : Number.POSITIVE_INFINITY;
}
