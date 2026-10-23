/**
 * rpc-coalesce.ts
 *
 * Merge concurrent `getAccountInfo` reads into one `getMultipleAccounts` upstream call.
 *
 * Why: the RPC provider bills one credit per call and one call may carry up to 100 accounts
 * for `getMultipleAccounts`, so N single-account reads that arrive together cost N credits as
 * `getAccountInfo` but 1 as `getMultipleAccounts`. The browser already sends its reads as JSON-RPC
 * batches and many tabs poll at the same moments, but the proxy used to forward every batch item
 * upstream as its own call.
 *
 * Semantics preserved:
 *   - Only reads with the SAME config object (encoding / commitment / dataSlice / minContextSlot)
 *     are merged, so every caller gets bytes in the format it asked for.
 *   - A group of one is sent unchanged as a plain `getAccountInfo` (no behaviour change at all).
 *   - The response is reshaped to the exact `getAccountInfo` result shape
 *     (`{ context, value }`), with the caller's own JSON-RPC id.
 *   - Duplicate keys inside a group are sent once and fanned out.
 *   - Upstream errors (RPC error object or transport failure) are delivered to every member.
 *   - Latency: every getAccountInfo waits the full `windowMs` (default 5 ms) for company, even a lone one. The browser's own
 *     batching window is 50 ms, so this is not user-visible.
 */

import { PublicKey } from "@solana/web3.js";

const MAX_KEYS_PER_CALL = 100;
const BASE58_KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * True only for a real 32-byte base58 address. Upstream rejects a whole getMultipleAccounts when any
 * key is invalid, so an invalid key must never join a merge group (it takes the single-call path and
 * fails alone).
 */
export function isValidPubkey(k: unknown): k is string {
  if (typeof k !== "string" || !BASE58_KEY_RE.test(k)) return false;
  try {
    return new PublicKey(k).toBytes().length === 32;
  } catch {
    return false;
  }
}

export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export type Sender = (body: { jsonrpc: "2.0"; id: number; method: string; params: unknown[] }) => Promise<JsonRpcResponse>;

interface Waiter {
  key: string;
  id: unknown;
  resolve: (r: JsonRpcResponse) => void;
}

interface Group {
  configJson: string;
  config: Record<string, unknown> | undefined;
  waiters: Waiter[];
  timer: ReturnType<typeof setTimeout>;
}

export interface CoalescerStats {
  /** getAccountInfo requests handed in. */
  reads: number;
  /** upstream calls actually made (getAccountInfo for singletons + getMultipleAccounts). */
  upstreamCalls: number;
}

export function createAccountInfoCoalescer(send: Sender, windowMs = 5) {
  const groups = new Map<string, Group>();
  const stats: CoalescerStats = { reads: 0, upstreamCalls: 0 };
  let seq = 0;

  async function flush(g: Group): Promise<void> {
    const uniqueKeys = [...new Set(g.waiters.map((w) => w.key))];
    const fail = (e: unknown) => {
      for (const w of g.waiters) {
        w.resolve({ jsonrpc: "2.0", id: w.id, error: e ?? { code: -32603, message: "Upstream RPC request failed" } });
      }
    };

    // Singleton: forward exactly what the caller asked for.
    if (uniqueKeys.length === 1) {
      stats.upstreamCalls += 1;
      try {
        const params: unknown[] = g.config ? [uniqueKeys[0], g.config] : [uniqueKeys[0]];
        const r = await send({ jsonrpc: "2.0", id: ++seq, method: "getAccountInfo", params });
        for (const w of g.waiters) w.resolve({ ...r, jsonrpc: "2.0", id: w.id });
      } catch {
        fail(undefined);
      }
      return;
    }

    const byKey = new Map<string, unknown>();
    let context: unknown;
    try {
      for (let i = 0; i < uniqueKeys.length; i += MAX_KEYS_PER_CALL) {
        const chunk = uniqueKeys.slice(i, i + MAX_KEYS_PER_CALL);
        stats.upstreamCalls += 1;
        const params: unknown[] = g.config ? [chunk, g.config] : [chunk];
        const r = await send({ jsonrpc: "2.0", id: ++seq, method: "getMultipleAccounts", params });
        if (r.error || !r.result || typeof r.result !== "object") return fail(r.error);
        const res = r.result as { context?: unknown; value?: unknown };
        if (!Array.isArray(res.value) || res.value.length !== chunk.length) return fail(undefined);
        context = context ?? res.context;
        chunk.forEach((k, j) => byKey.set(k, (res.value as unknown[])[j]));
      }
    } catch {
      return fail(undefined);
    }
    for (const w of g.waiters) {
      w.resolve({ jsonrpc: "2.0", id: w.id, result: { context, value: byKey.get(w.key) ?? null } });
    }
  }

  /**
   * @param pubkey  base58 account address (params[0] of getAccountInfo)
   * @param config  params[1] of getAccountInfo, if any
   * @param id      the caller's JSON-RPC id
   */
  function read(pubkey: string, config: Record<string, unknown> | undefined, id: unknown): Promise<JsonRpcResponse> {
    stats.reads += 1;
    const configJson = JSON.stringify(config ?? null);
    return new Promise<JsonRpcResponse>((resolve) => {
      let g = groups.get(configJson);
      if (!g) {
        const created: Group = {
          configJson,
          config,
          waiters: [],
          timer: setTimeout(() => {
            groups.delete(configJson);
            void flush(created);
          }, windowMs),
        };
        groups.set(configJson, created);
        g = created;
      }
      g.waiters.push({ key: pubkey, id, resolve });
    });
  }

  return { read, stats };
}

/** True when `params` is a plain `[pubkey]` / `[pubkey, configObject]` getAccountInfo call. */
export function parseAccountInfoParams(
  params: unknown,
): { pubkey: string; config: Record<string, unknown> | undefined } | null {
  if (!Array.isArray(params) || params.length < 1 || params.length > 2) return null;
  const [pubkey, config] = params;
  if (!isValidPubkey(pubkey)) return null;
  if (config === undefined) return { pubkey, config: undefined };
  if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
  return { pubkey, config: config as Record<string, unknown> };
}
