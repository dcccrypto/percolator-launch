/**
 * rpc-metrics.ts
 *
 * Per-instance counters for the /api/rpc proxy, so the effect of any RPC-reduction work can be
 * verified against the provider's bill. For every JSON-RPC method the proxy counts:
 *
 *   in        requests received from browsers
 *   hit       answered from the short-TTL response cache (no upstream call)
 *   coalesced answered by joining an identical in-flight upstream call (no extra upstream call)
 *   miss      neither cached nor joined: had to go to the upstream path
 *   upstream  HTTP calls actually sent to the RPC provider, by upstream method (this is what the
 *             provider bills; with getAccountInfo coalescing, many `miss` reads become one
 *             `getMultipleAccounts` upstream call)
 *
 * It also keeps a bounded top-N of the accounts most read through getAccountInfo /
 * getMultipleAccounts, which is what shows up as "duplicate readers of the same account".
 *
 * The counters are per serverless instance (a Vercel function instance), so they are exposed
 * two ways: a one-line JSON summary logged at most once per minute per instance (greppable in
 * `vercel logs`, tag `[rpc-metrics]`), and an admin-secret GET for the live snapshot.
 * No request bodies, wallet addresses of users, or secrets are recorded beyond the account
 * pubkeys of reads (all public on-chain addresses).
 */

import { isValidPubkey } from "@/lib/rpc-coalesce";

export interface MethodCounts {
  in: number;
  hit: number;
  coalesced: number;
  miss: number;
  upstream: number;
}

const LOG_INTERVAL_MS = 60_000;
const MAX_TRACKED_KEYS = 200;
const TOP_N = 15;

const startedAt = Date.now();
const methods = new Map<string, MethodCounts>();
const accountReads = new Map<string, number>();
let lastLogAt = Date.now();
let lastLogged = new Map<string, MethodCounts>();

function bucket(method: string): MethodCounts {
  let b = methods.get(method);
  if (!b) {
    b = { in: 0, hit: 0, coalesced: 0, miss: 0, upstream: 0 };
    methods.set(method, b);
  }
  return b;
}

/** Cache-miss/dedup outcome of one incoming request. */
export type RpcOutcome = "hit" | "coalesced" | "miss";

export function recordRpcRequest(method: string, outcome: RpcOutcome): void {
  const b = bucket(method);
  b.in += 1;
  b[outcome] += 1;
  maybeLog();
}

/** One HTTP call actually sent to the provider (does not count as a browser request). */
export function recordUpstreamCall(upstreamMethod: string): void {
  bucket(upstreamMethod).upstream += 1;
  maybeLog();
}

/** Track which accounts are read most (public pubkeys only). */
export function recordAccountRead(method: string, params: unknown): void {
  if (!Array.isArray(params)) return;
  const first = params[0];
  const keys: string[] =
    method === "getAccountInfo" && typeof first === "string"
      ? [first]
      : method === "getMultipleAccounts" && Array.isArray(first)
        ? first.filter((k): k is string => typeof k === "string")
        : [];
  for (const k of keys) {
    if (!isValidPubkey(k)) continue; // bounds key length/content: only real addresses are retained
    if (!accountReads.has(k) && accountReads.size >= MAX_TRACKED_KEYS) continue;
    accountReads.set(k, (accountReads.get(k) ?? 0) + 1);
  }
}

export interface RpcMetricsSnapshot {
  sinceMs: number;
  methods: Record<string, MethodCounts>;
  totals: MethodCounts;
  topAccounts: Array<{ account: string; reads: number }>;
}

export function getRpcMetricsSnapshot(): RpcMetricsSnapshot {
  const out: Record<string, MethodCounts> = {};
  const totals: MethodCounts = { in: 0, hit: 0, coalesced: 0, miss: 0, upstream: 0 };
  for (const [m, c] of methods) {
    out[m] = { ...c };
    totals.in += c.in;
    totals.hit += c.hit;
    totals.coalesced += c.coalesced;
    totals.miss += c.miss;
    totals.upstream += c.upstream;
  }
  const topAccounts = [...accountReads.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([account, reads]) => ({ account, reads }));
  return { sinceMs: Date.now() - startedAt, methods: out, totals, topAccounts };
}

function maybeLog(): void {
  const now = Date.now();
  if (now - lastLogAt < LOG_INTERVAL_MS) return;
  const windowSecs = Math.round((now - lastLogAt) / 1000);
  lastLogAt = now;
  // Per-window deltas, so a log line reads as "calls in the last minute on this instance".
  const delta: Record<string, MethodCounts> = {};
  for (const [m, c] of methods) {
    const p = lastLogged.get(m) ?? { in: 0, hit: 0, coalesced: 0, miss: 0, upstream: 0 };
    delta[m] = {
      in: c.in - p.in,
      hit: c.hit - p.hit,
      coalesced: c.coalesced - p.coalesced,
      miss: c.miss - p.miss,
      upstream: c.upstream - p.upstream,
    };
  }
  lastLogged = new Map([...methods].map(([m, c]) => [m, { ...c }]));
  console.log(`[rpc-metrics] ${JSON.stringify({ windowSecs, methods: delta })}`);
}

/** Test hook. */
export function resetRpcMetricsForTest(): void {
  methods.clear();
  accountReads.clear();
  lastLogged = new Map();
  lastLogAt = Date.now();
}
